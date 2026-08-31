import {
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
// パッケージのルートからは再エクスポートされていないのでサブパスから取る
import { LengthFinishReasonError } from "openai/error";
import type { CardRename, TermCard, TermLink, TermStatus } from "../protocol.js";
import { config } from "../config.js";
import { ContextWindow } from "./context.js";
import { createExtractor, UNRESOLVED_DESCRIPTION } from "./extractor.js";
import { isVerified, verifyAndEnrich } from "./enrich.js";
// 見出しは `enrich.js` 経由で取らない。あちらは読み込みだけで `new OpenAI()` を
// 評価するので、輸入経路が2本あると片方が API キーを要求する(`normalize.js` と同じ扱い)
import { REJECTION_LABEL } from "./rejection.js";
import { buildGlossaryIndex, type GlossaryIndex, relatedGlossary } from "./glossary.js";
import { normalizeTerm } from "./normalize.js";
import {
  hintForms,
  isRelated,
  isRename,
  isResolved,
  mergeCandidates,
  pickCandidate,
  REMATCH_RATIONALE,
} from "./rematch.js";
import type { Candidate, ExtractedCard } from "./schema.js";

const MIN_CHARS = 120;
const MAX_WAIT_MS = 10_000;
const CHECK_INTERVAL_MS = 5_000;
const SHOWN_TERMS_LIMIT = 50;
const MAX_CONSECUTIVE_FAILURES = 3;
// 未処理バッファの上限。会議は流れ続けるので、古い未処理チャンクを保持する価値は低い。
const MAX_BUFFER_CHARS = 2_000;

// --- unresolved カードの再評価(#40) -----------------------------------------
//
// **コスト制御は5段。** どれか1つでも外すと「会話が進むたびに全 unresolved を
// web 検索つきで投げ直す」形に戻る。値はすべて暫定で、決め方は `config.ts` の
// 該当ノブのコメントに一本化してある(`REMATCH_MIN_SIMILARITY=0` で分布を測ってから
// 人が決める)。
//
// 1. ローカル判定(`isRelated()`)         … LLM を呼ぶ前に絞る
// 2. `MAX_REMATCH_ATTEMPTS`               … 同じカードを無制限に再評価しない
// 3. `REMATCH_COOLDOWN_MS`                … 短時間の連打を防ぐ
// 4. `MAX_REMATCH_PER_RUN`                … 確定カードが大量に出た回でも爆発しない
// 5. `MAX_PENDING_UNRESOLVED`             … メモリと候補走査の上限

/**
 * 再評価のために保持する unresolved カードの上限。超えたら**古いほうから捨てる**
 * (`ContextWindow` と同じ割り切り。会議は流れ続けるので、古い未解決を抱え続ける
 * 価値は低い)。
 */
const MAX_PENDING_UNRESOLVED = 20;

/**
 * 1回の `run()` で発火させる再評価の上限。
 *
 * 1チャンクで確定カードが5枚出て、保持中の unresolved がその全部に関連しうる、という
 * 回に上限が無いと **web 検索つきの呼び出しが一気に十数本飛ぶ**。
 *
 * **溢れた分は「次の回に同じ手がかりで拾える」わけではない。** 手がかりになるのは
 * `fresh`(= `shownSet` でデデュープ済み)のカードなので、ある用語が手がかりとして現れる
 * のは**その run 1回きり**。次の run には別の手がかりしか来ないため、ここで溢れたペアは
 * その組み合わせでは二度と評価されない。上限を上げれば取りこぼしは減るが課金が増える
 * ——どちらに寄せるかは人が計測してから決める(`docs/wiki/termlens-open-issues.md`)。
 */
const MAX_REMATCH_PER_RUN = 2;

/**
 * 再評価待ちの unresolved カード(#40)。**セッション内・件数上限つきなので永続化しない。**
 *
 * 会話全文をカードごとに複製して持たない。`context` は unresolved が出た**そのチャンク
 * だけ**で、再評価時は「保存した抜粋 + 直近の文脈」を渡す(#25 のプライバシー原則)。
 */
interface PendingUnresolved {
  cardId: string;
  /** 抽出段が推定した term。デデュープキー(`shownSet`)と対応する */
  term: string;
  surfaceForms: string[];
  correctedFrom: string | null;
  /**
   * 抽出段が挙げた候補。**#40 以前は `enrichCard()` に渡した後で捨てていた。**
   * 再評価はこれを土台に候補を組み直すので、ここで掴んでおかないと材料が無くなる。
   */
  candidates: Candidate[];
  /** unresolved が出たチャンク。会話全文ではない */
  context: string;
  attempts: number;
  /** 最後に再評価を**試みた**時刻。cooldown の起点。0 は「まだ一度も試していない」 */
  lastAttemptAt: number;
}

// 表記の集め方は `rematch.ts` の `hintForms()` 1本に寄せてある。手がかり側と
// 未解決側で式を分けていた頃は、片方だけ変えても評価ハーネスが緑のままだった。

/** SDK 自身が再試行するステータス。分類を SDK の方針と一致させる。 */
const SDK_RETRYABLE_STATUSES = new Set([408, 409, 429]);

/**
 * 残高不足・課金上限による 429 か。
 *
 * OpenAI はレート超過と残高切れをどちらも 429 で返すが、前者は待てば回復し、
 * 後者は入金するまで永久に失敗する。ステータスだけで判定すると残高切れを
 * 再試行し続け、バッファが肥大する(#3 と同じ壊れ方)。区別は code に頼る。
 */
export function isQuotaExhausted(err: APIError): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === "insufficient_quota" || code === "billing_hard_limit_reached") return true;
  return /insufficient[_ ]quota|no credits remaining|billing/i.test(err.message ?? "");
}

/**
 * 再試行しても成功しないエラーか。
 *
 * 4xx のうち SDK が再試行しないものを恒久エラーとみなす。個別のエラークラスを列挙すると
 * 400/401/403 のように取りこぼしが出るため、ステータスの範囲で判定する。
 * 例: 400(不正リクエスト)、401/403(認証・権限)、404(モデルIDが無効)、422(スキーマ不正)。
 * 5xx・408/409・接続エラーは一時的なものとして再試行に回す。
 * 429 は原則一時扱いだが、残高切れだけは恒久として扱う。
 */
export function isPermanent(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const status = err.status;
  // APIConnectionError などは status が undefined。判別できないものは再試行に倒す。
  if (typeof status !== "number") return false;
  if (status === 429) return isQuotaExhausted(err);
  return status >= 400 && status < 500 && !SDK_RETRYABLE_STATUSES.has(status);
}

/**
 * **そのチャンクを再送しても必ず同じ結果になるエラーか**(#23)。
 *
 * `max_completion_tokens` に達すると SDK は `parsed` を null にするのではなく
 * `LengthFinishReasonError` を投げる(`openai/lib/parser.js`)。これは `APIError` ではなく
 * `OpenAIError` 直下なので `isPermanent()` は false を返し、素通しにすると一時エラー扱いで
 * **同じ長さのチャンクをバッファ先頭に戻して再送し続ける**(確実に同じ所で切れる)。
 *
 * 抽出そのものは次のチャンクで復帰しうるので `disableExtraction()` までは行わず、
 * **このチャンクだけ捨てる**。
 */
export function isUnretryableChunk(err: unknown): boolean {
  return err instanceof LengthFinishReasonError;
}

/** 開発者向けの生メッセージを利用者向けの文言に変換する */
export function toUserMessage(err: unknown): string {
  if (err instanceof AuthenticationError) {
    return "APIキーが無効です。サーバーの設定を確認してください。";
  }
  if (err instanceof PermissionDeniedError) {
    return "APIキーにこの操作の権限がありません。";
  }
  if (err instanceof NotFoundError) {
    return "用語抽出のモデルが見つかりません。サーバーの設定を確認してください。";
  }
  if (err instanceof RateLimitError && isQuotaExhausted(err)) {
    return "OpenAIのクレジット残高が不足しています。コンソールで購入してください。";
  }
  if (err instanceof BadRequestError) {
    return "用語抽出のリクエストが受け付けられませんでした。";
  }
  if (err instanceof APIError) {
    return `用語抽出APIでエラーが発生しました (${err.status ?? "不明"})。`;
  }
  // 想定外の例外(構造化出力のスキーマ検証失敗など)も汎用文言に倒す。
  // 生のメッセージをそのまま返すとブラウザまで届いてしまう。
  // 原因の特定は呼び出し元が console.error に出す完全なエラーで行う。
  return "用語抽出でエラーが発生しました。";
}

/**
 * 検証つき清書(Stage 2)に回すカードを選ぶ(#23)。
 *
 * 従来の「レア度上位の約半数」に **「補正あり または status が confirmed でない」** を
 * 足した和集合。誤補正が疑わしいのはこの2つで、レア度ランキングが選ぶ集合とは大きく
 * 重なるため、web 検索の呼び出し増は小さい。
 *
 * **`unresolved` はここでは検証に回さない(#24)。** そのチャンクの中だけでは材料が
 * 増えていないので、同じ入力で検証を回しても結果は変わらず web 検索の課金だけが増える。
 * 昇格を防ぎつつ解説だけ更新すると「特定できませんでした」の見出しの下に確定した別用語の
 * 断定的な解説が出る — #24 が防ごうとしていた形そのものになる。
 *
 * **#40 の再評価はこの関数を通らない。** あちらは「後続の会話で新しい材料が出た」ことを
 * トリガにする別経路(`maybeRematch()`)で、材料が増えたときだけ `verifyAndEnrich()` を
 * 呼ぶ。ここを緩めて unresolved を毎チャンク回す形にすると、**「材料が増えたときだけ」
 * という前提ごと消える**ので、この関数は #24 のまま触らない。
 * 評価ハーネス(`src/eval/run.ts`)と共用の純関数でもあるので、なおさら分ける。
 *
 * **補正のないカードは Stage 2 を通さない。** そもそも速報は従来どおり即時表示で、
 * Stage 2 は非同期の `card_update` なので、表示までの時間はどちらにせよ変わらない。
 *
 * 純関数として export してあるのは、評価ハーネス(`src/eval/run.ts`)が
 * `EVAL_WITH_VERIFY=1` のときに**本番と同じ選定**で回すため。コピーすると drift する。
 *
 * **戻り値は term の集合のままにしてある**(#38 で cardId を入れた後も変えない)。ここは
 * 「どのカードを検証に回すか」の**選定**であって識別ではなく、評価ハーネスと共用の純関数
 * だから。cardId を持ち込むと評価側にサーバーの採番を持たせることになり、本番と drift する。
 */
export function selectVerifyTargets<
  T extends {
    term: string;
    rarity: "common" | "uncommon" | "rare";
    status: TermStatus;
    correctedFrom: string | null;
  },
>(cards: T[]): Set<string> {
  // **`unresolved` は最初に除く。** 検証結果を使える余地が無いので、レア度ランキング
  // 経由でも入れない(除かないと上位半数の枠まで食う)。
  const targetable = cards.filter((c) => c.status !== "unresolved");
  // レア度上位の約半数。同レア度なら誤認識疑い(probable)を先に詰める。
  // **この並べ替えは対象を広げるためではなく、狭く保つためにある。** probable は
  // 下のループでどのみち全部入るので、上位半数の枠を先に食わせておくと和集合の増分が
  // 小さくなる(枠が空くと補正なし・confirmed のカードが余分に入る)。
  const rarityRank = { rare: 2, uncommon: 1, common: 0 };
  const ranked = [...targetable].sort(
    (a, b) =>
      rarityRank[b.rarity] - rarityRank[a.rarity] ||
      (a.status !== "confirmed" ? -1 : 0) - (b.status !== "confirmed" ? -1 : 0),
  );
  // **分母は `targetable` の枚数。** 元のカード数のままにすると、`unresolved` が多い回ほど
  // 枠が余り、検証する意味のない confirmed カードまで web 検索に回る(枠が
  // `targetable.length` を超えると全部入る)。「並べ替えは対象を狭く保つためにある」という
  // 上の方針と逆向きになる。`probable` は下のループが無条件に足すので枠が縮んでも漏れない。
  const targets = new Set(ranked.slice(0, Math.ceil(targetable.length / 2)).map((c) => c.term));
  // 誤補正が疑わしいカードはレア度に関係なく必ず検証する。
  // `!== "confirmed"` と書くのは、将来 status が増えたときに黙って対象から漏れないため
  // (`targetable` の時点で unresolved は除いてあるので、いまは probable と同義)。
  for (const card of targetable) {
    if (card.correctedFrom !== null || card.status !== "confirmed") targets.add(card.term);
  }
  return targets;
}

/**
 * 抽出結果をクライアント向けカードに落とす。
 *
 * **フィールドを1つずつ書き写す（スプレッドを使わない）。** `candidates` は検証段への
 * 内部入力であってクライアントは使わないので、混ぜて送ると WS ペイロードと
 * localStorage が候補ぶん太る(#19 で words を送らなかったのと同じ理由)。
 * `{ ...card }` だと除外はコンパイラに守られず、`ExtractedCard` に内部用フィールドが
 * 増えるたび黙って漏れる。明示的に書けば、増えたフィールドは何もしなければ漏れず、
 * `TermCard` 側が増えたときは**型エラーで気づける**。
 */
function toClientCard(card: ExtractedCard, willEnrich: boolean, cardId: string): TermCard {
  return {
    // 採番は呼び出し元(`run()`)が持つ。ここで採ると `enrichCard()` へ同じ ID を
    // 引き回せず、`card_update` が当たらないカードができる
    cardId,
    term: card.term,
    reading: card.reading,
    description: card.description,
    status: card.status,
    correctedFrom: card.correctedFrom,
    surfaceForms: card.surfaceForms,
    rarity: card.rarity,
    willEnrich,
    links: [],
  };
}

/**
 * 発話を蓄積し、「120文字以上」または「前回呼び出しから10秒経過かつ非空」で
 * LLM抽出を発火する。呼び出しは直列化し、既出用語はサーバー側でもデデュープする。
 *
 * 抽出済みのチャンクは `ContextWindow` に直近1,500字ぶんだけ残し、次回の
 * `contextTranscript` として渡す(#22)。語義の判断材料であって、カード化の対象ではない。
 */
export class ExtractionScheduler {
  private buffer = "";
  /** 抽出に成功したチャンクの直近ぶん。次回の LLM 呼び出しに文脈として渡す */
  private context = new ContextWindow();
  private lastRunAt = Date.now();
  private running = false;
  private stopped = false;
  /** 清書(検証)を打ち切ったか。残高切れ・恒久エラーで立てる。抽出は別に判定する */
  private verifyDisabled = false;
  /** 恒久エラーで抽出を打ち切った状態。文字起こしは継続するのでセッションは止めない。 */
  private disabled = false;
  private consecutiveFailures = 0;
  private shownTerms: string[] = [];
  private shownSet = new Set<string>();
  /**
   * カード ID の採番カウンタ(#38)。`c1`, `c2`, … を1セッション(= WS 1本)の間だけ配る。
   *
   * **再接続で 0 から振り直しになる**が、クライアントは受信 ID を自分のローカル ID へ
   * 写像して持つので衝突しない(`public/app.js` の `incomingCardId`)。サーバー側で
   * 永続的に一意な ID を作る必要はここには無い。
   */
  private nextCardId = 0;
  /**
   * 再評価待ちの unresolved カード(#40)。**登場順(古い順)で保つ。**
   *
   * 上限を超えたら先頭(＝最も古いもの)から捨てる。配列にしてあるのは順序が意味を持つ
   * ためで、件数は `MAX_PENDING_UNRESOLVED` で頭打ちなので線形走査で足りる。
   */
  private pendingUnresolved: PendingUnresolved[] = [];
  private timer: NodeJS.Timeout;
  private extract: ReturnType<typeof createExtractor>;
  /**
   * 用語集を語に割った索引(#25)。**セッションの間ずっと変わらないので1度だけ作る。**
   *
   * 生の配列は `createExtractor()` に渡したら要らない。索引が語の表記を持つので、
   * 検証段へ渡す関連語はここから引ける。会議が終われば scheduler ごと落ちる。
   */
  private readonly glossaryIndex: GlossaryIndex;

  constructor(
    glossary: string[],
    private callbacks: {
      onCards: (cards: TermCard[]) => void;
      /**
       * 清書(検証)の結果をクライアントへ届ける。`status` は #24 で追加した。
       * 裏付けが取れれば `confirmed`、棄却なら `unresolved` に**降格**する。
       *
       * 第1引数は #38 から **cardId**(term ではない)。速報で送ったカードと同じ ID を
       * 渡すこと。`onCardUpdate` を呼ぶ経路は4つ(裏付けあり / 棄却 / 例外時の
       * フォールバック / #40 の再評価)あり、**どれか1つでも別の値を渡すと更新が迷子になる**。
       *
       * `rename` は #40 の再評価だけが渡す。**既存の3経路は渡さない** — 渡さないかぎり
       * クライアント側の #24 のガード(unresolved から戻さない)がそのまま効く。
       */
      onCardUpdate: (
        cardId: string,
        status: TermStatus,
        description: string,
        links: TermLink[],
        rename?: CardRename,
      ) => void;
      onExtracting: () => void;
      /** permanent: 恒久エラーで抽出を打ち切ったときだけ true(#10)。一時エラーは省略/false。 */
      onError: (message: string, permanent?: boolean) => void;
    },
    // 再接続時にクライアントから渡される既出用語(#8)。新しい Session/Scheduler は
    // デデュープ状態が空から始まるため、渡された分を shownSet/shownTerms の初期値にする。
    // 既存の normalizeTerm を通すことで、通常の抽出結果と同じキー正規化に揃える。
    shownTerms: string[] = [],
  ) {
    this.extract = createExtractor(glossary);
    this.glossaryIndex = buildGlossaryIndex(glossary);
    for (const term of shownTerms.slice(-SHOWN_TERMS_LIMIT)) {
      const key = normalizeTerm(term);
      if (this.shownSet.has(key)) continue;
      this.shownSet.add(key);
      this.shownTerms.push(term);
    }
    this.timer = setInterval(() => this.maybeRun(), CHECK_INTERVAL_MS);
  }

  /**
   * 発話1つぶんのテキストを受け取る。
   *
   * **呼び出し側は「完成した発話」の単位で渡すこと**（`UtteranceBuilder` が組み立てる）。
   *
   * `run()` はバッファ全部を持っていくので、**チャンクの切れ目は常に「最後に append した
   * テキストの末尾」**になる（120 文字は切断位置ではなく発火の閾値）。
   * ここが STT の `is_final` をそのまま受けていた頃は、その末尾が認識区間の区切り＝
   * 発話の途中でありえた。渡す単位を発話にすると末尾が必ず発話の終わりになる。
   * `maybeRun()` の発火条件そのものは変えていない。
   *
   * 例外は `MAX_BUFFER_CHARS` の切り捨て（`slice`）で、ここだけは発話の途中で切る。
   */
  addUtterance(text: string): void {
    if (this.stopped || this.disabled) return;
    this.appendToBuffer(text);
    this.maybeRun();
  }

  /** 停止時に残りバッファを処理する */
  async flush(): Promise<void> {
    if (!this.disabled) await this.run();
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /**
   * バッファに追記し、上限を超えたら古い方から捨てる。
   * 先頭が文の途中で切れることがあるが、抽出は文脈から用語を拾うだけなので許容する。
   */
  private appendToBuffer(text: string, prepend = false): void {
    const joined = prepend
      ? text + (this.buffer ? " " + this.buffer : "")
      : this.buffer + (this.buffer ? " " : "") + text;
    this.buffer =
      joined.length > MAX_BUFFER_CHARS ? joined.slice(-MAX_BUFFER_CHARS) : joined;
  }

  /** 恒久エラー時に抽出だけを打ち切る。溜まった未処理分は破棄する。 */
  private disableExtraction(): void {
    this.disabled = true;
    this.buffer = "";
    // 抽出が止まった後に古い文脈を抱え続ける意味がない(バッファを捨てるのと同じ理由)
    this.context.clear();
    clearInterval(this.timer);
  }

  /** 次のカード ID を採る(#38)。`c1` から始まる連番。 */
  private newCardId(): string {
    this.nextCardId += 1;
    return `c${this.nextCardId}`;
  }

  private maybeRun(): void {
    if (this.running || this.stopped || this.disabled || this.buffer.length === 0) return;
    const waited = Date.now() - this.lastRunAt;
    if (this.buffer.length >= MIN_CHARS || waited >= MAX_WAIT_MS) {
      void this.run();
    }
  }

  private async run(): Promise<void> {
    if (this.running || this.disabled || this.buffer.length === 0) return;
    this.running = true;
    const chunk = this.buffer;
    this.buffer = "";
    this.lastRunAt = Date.now();
    this.callbacks.onExtracting();

    try {
      const cards = await this.extract({
        newTranscript: chunk,
        // chunk 自身は含まない。「直前まで」の会話だけを語義の参考にさせる
        contextTranscript: this.context.text(),
        shownTerms: this.shownTerms.slice(-SHOWN_TERMS_LIMIT),
      });
      this.consecutiveFailures = 0;
      // **成功後にだけ積む。** 一時エラーでは chunk をバッファ先頭に戻すので、
      // 先に積むと戻ったチャンクが次回 contextTranscript と newTranscript の両方に現れる。
      this.context.push(chunk);

      const fresh = cards.filter((c) => {
        const key = normalizeTerm(c.term);
        if (this.shownSet.has(key)) return false;
        this.shownSet.add(key);
        // **`unresolved` の推定 term はプロンプトの「表示済み用語リスト」に載せない**(#24)。
        // 載せると規則2「表示済みの用語は出力しない」が効いてしまい、後で誰かが同じ用語を
        // **明瞭に発話しても正しいカードが出なくなる**。特定できなかった推定でデデュープの
        // 枠を永久に占有させない。`shownSet` には積むので、同じチャンク内での重複は防げる。
        if (c.status !== "unresolved") this.shownTerms.push(c.term);
        return true;
      });
      if (fresh.length > 0) {
        // **`verifyDisabled` を選定と同じ場所で見る。** `willEnrich` は「後から
        // `card_update` が来る」の予告なので、検証を打ち切った後も true で送ると
        // 誰も更新を送らないまま「確認中」の表示が会議の終わりまで残る。
        const enrichTargets = this.verifyDisabled
          ? new Set<string>()
          : selectVerifyTargets(fresh);
        // **ID は速報を組み立てる前に配り切る**(#38)。`toClientCard()` の中で採ると
        // 下の `enrichCard()` へ同じ ID を渡せず、`card_update` が当たらなくなる。
        const withIds = fresh.map((c) => ({ card: c, cardId: this.newCardId() }));
        // 速報: LLMの知識ベースのドラフト解説で即表示
        this.callbacks.onCards(
          withIds.map(({ card, cardId }) =>
            toClientCard(card, enrichTargets.has(card.term), cardId),
          ),
        );
        // 清書: 選ばれた用語だけweb検索で候補を検証し、要約+関連リンクで更新
        for (const { card, cardId } of withIds) {
          if (enrichTargets.has(card.term)) void this.enrichCard(card, chunk, cardId);
        }

        // 再評価(#40): 新しく確定したカードを手がかりに、**過去の** unresolved を見直す。
        //
        // **積むより先にトリガを引く。** 順序を逆にすると、unresolved が出るたびに
        // 同じチャンクの確定カードで必ず1本 web 検索つきの呼び出しが増える。抽出段は
        // 両方を同時に見たうえで片方を unresolved にしているので、その回に限れば
        // 手がかりとしての価値は低い。
        //
        // **ただしこれは取りこぼしでもある。** 手がかりは `fresh` なので同じ用語が
        // 手がかりになるのはその run 1回きり。同じチャンクに未解決とその手がかりが
        // 揃ったペアは、**以後どの回でも評価されない**。抽出段が見ているとはいえ
        // web 検証はしていないので「新しい材料が無い」と言い切れるわけではない。
        // 発火率とコストのどちらに寄せるかは人が計測してから決める。
        this.maybeRematch(
          withIds.filter(({ card }) => card.status !== "unresolved").map(({ card }) => card),
        );
        for (const { card, cardId } of withIds) {
          if (card.status === "unresolved") this.rememberUnresolved(card, cardId, chunk);
        }
      }
    } catch (err) {
      console.error("[scheduler] extraction failed:", err);

      if (isPermanent(err)) {
        // 再試行しても成功しないため、バッファに戻さず抽出を打ち切る。
        // 戻すと会議が続く限りバッファが肥大し、復旧時に巨大なリクエストになる。
        this.disableExtraction();
        // permanent: true。恒久エラーによる打ち切りだけがバナー表示の対象(#10)
        this.callbacks.onError(`用語抽出を停止しました。${toUserMessage(err)}`, true);
        return;
      }

      if (isUnretryableChunk(err)) {
        // 戻すと同じ長さで再送してまた切れる。連続失敗にも数えない(次のチャンクは通りうる)
        console.warn(
          `[scheduler] chunk dropped (${chunk.length} chars): 出力が上限に達したため再試行しない`,
        );
        return;
      }

      // 一時的なエラーはバッファに戻して次回に回す
      this.appendToBuffer(chunk, true);
      this.consecutiveFailures += 1;
      if (
        this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        this.consecutiveFailures % MAX_CONSECUTIVE_FAILURES === 0
      ) {
        // permanent は付けない(省略=false)。復旧の可能性がある一時エラーなので、
        // クライアント側は消えないバナーではなくステータス表示だけにする(#10)
        this.callbacks.onError(
          `用語抽出が${this.consecutiveFailures}回連続で失敗しました。${toUserMessage(err)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * `cardId` は速報で送ったカードの ID(#38)。**下の3つの `onCardUpdate` すべてに
   * 同じ値を渡すこと。** ログ(`console.warn` / `console.error`)は人が読むものなので
   * 従来どおり term を出す。
   */
  private async enrichCard(
    card: ExtractedCard,
    context: string,
    cardId: string,
  ): Promise<void> {
    try {
      const result = await verifyAndEnrich({
        candidates: card.candidates,
        correctedFrom: card.correctedFrom,
        context,
        // **絞り込んでから渡す**(#25)。用語集は参加者名・社名を含み、web 検索は
        // 外部サービスへの送信にあたる。`verifyAndEnrich()` の口が絞り込み済みの
        // `glossaryHints` しか受けないので、ここを素通しにはできない
        glossaryHints: relatedGlossary(this.glossaryIndex, card.candidates),
      });
      const verified = isVerified(card.term, result.chosen);
      if (!verified) {
        // 棄却。出すのは term と**棄却の理由の内訳**(#25)だけで、**文字起こし本文は
        // 出さない**(既存の `console.error("[scheduler] extraction failed:", err)` と
        // 同じ扱い)。内訳を出すのは、棄却が「実在しなかった」のか「実在するが会議の話では
        // なかった」のかが本番ログでも読めるようにするため(評価ハーネスの `VerifyTally` と対)。
        //
        // **`reason` も `evidence` もモデルが書く自由文で、どちらも文脈を引き写しうる。**
        // `reason` を出しているのは #23 からの既存の扱いで、棄却の追跡にはこれが要る。
        // `evidence` を足さないのは、同じ危険を負う自由文をもう1本増やす価値が
        // 内訳(定型)を出せる今は無いから。区別は「安全か否か」ではなく本数の問題。
        // **ここは棄却だけの分岐ではない。** `isVerified()` は候補#2 が選ばれた
        // 「差し替え」でも false を返す。そのとき `rejection` は null なので、
        // 一律に棄却として扱うと **`(理由なし)` という自己矛盾した行**が本番ログに載る。
        const why =
          result.chosen === null
            ? REJECTION_LABEL[result.rejection ?? "unspecified"]
            : `別候補「${result.chosen}」が選ばれた`;
        console.warn(`[scheduler] verification not verified "${card.term}" (${why}): ` + result.reason);
      }
      // **棄却でも更新は必ず届ける。** 速報は `willEnrich: true` で送ってあり、クライアントは
      // `card_update` が来るまで「確認中」の表示を消さない(`public/app.js`)。ここで黙ると
      // **誤補正が最も疑わしいカードにだけ**回り続けるスピナーが残る。
      //
      // #24 で `status` を載せ、**棄却は表示にも反映されるようになった**。
      // - 裏付けあり → `confirmed`。速報が probable だった場合はここで格上げになる
      // - 棄却 → `unresolved` へ**降格**。候補#2 が選ばれた場合も同じ扱いで、
      //   改名の経路が無い以上「この見出しは当てにならない」と伝えるほうが正確
      //
      // **降格時は解説も定型文に差し替える。** 速報の解説は「誤補正した用語」の説明なので、
      // 「特定できませんでした」と言いながら別用語の断定的な定義を読ませることになる。
      // しかも見出しは surface form に替わっているので、何の説明なのかも分からない。
      // 抽出段(`normalizeStatus`)が同じことをサーバー側で担保している以上、降格経路だけ
      // 素通しにすると方針が非対称になり、AC「架空/別用語の説明を生成しない」が破れる。
      // 停止後でも flush 済みカードの更新は届けてよい(送信可否は session 側が判定する)
      this.callbacks.onCardUpdate(
        cardId,
        verified ? "confirmed" : "unresolved",
        verified ? result.description : UNRESOLVED_DESCRIPTION,
        verified ? result.links : [],
      );
    } catch (err) {
      // **ただし恒久エラー(残高切れを含む)は別。** 抽出側は `disableExtraction()` で1回止まるのに
      // 検証側が素通しだと、選ばれたカードごとに web 検索つきの呼び出しを投げ続け、
      // 誰にも通知されないまま課金だけが進む(#23 で対象集合を広げたぶん影響が大きい)。
      if (isPermanent(err)) {
        this.verifyDisabled = true;
        console.error(`[scheduler] verification disabled after "${card.term}":`, err);
        // **黙って止めない。** 抽出は `disableExtraction()` が `onError` で知らせるのに
        // 検証だけ無言だと、利用者からは「未検証のカードが出続けている」ことが
        // 区別できない(`willEnrich` が false になるので確認中の表示すら出ない)。
        // 1枚目で踏めば以降のカードは全部未検証になるので、影響はセッション全体に及ぶ。
        // 抽出は生きているので `permanent` は立てない — カードは出続ける。
        this.callbacks.onError(`用語の検証を停止しました。${toUserMessage(err)}`);
      } else {
        console.error(`[scheduler] enrich failed for "${card.term}":`, err);
      }
      // **失敗しても更新は必ず届ける。** 速報を `willEnrich: true` で送った以上、
      // 黙るとクライアントの「確認中」が会議の終わりまで回り続け、localStorage にも
      // その状態で保存されるので復元しても消えない(#23 で棄却時に踏んだのと同じ穴)。
      // 検証できなかっただけなので**速報の status と解説はそのまま**、リンクだけ空で送る。
      this.callbacks.onCardUpdate(cardId, card.status, card.description, []);
    }
  }

  // --- unresolved カードの再評価(#40) ---------------------------------------

  /**
   * unresolved カードを再評価待ちとして覚える。
   *
   * **`candidates` を掴むのがこのメソッドの主目的。** 抽出結果の候補は
   * `toClientCard()` が意図的に落としており(クライアントは使わない)、`enrichCard()` に
   * 渡した後は誰も持っていなかった。再評価は候補を土台に組み直すので、ここで
   * 保持経路を1本足す。
   */
  private rememberUnresolved(card: ExtractedCard, cardId: string, context: string): void {
    this.pendingUnresolved.push({
      cardId,
      term: card.term,
      surfaceForms: card.surfaceForms,
      correctedFrom: card.correctedFrom,
      candidates: card.candidates,
      context,
      attempts: 0,
      lastAttemptAt: 0,
    });
    // 古いほうから捨てる。上限を件数で持つのは、走査コストとメモリの両方を同時に
    // 頭打ちにできるから(`ContextWindow` が文字数で切っているのと同じ発想)
    while (this.pendingUnresolved.length > MAX_PENDING_UNRESOLVED) this.pendingUnresolved.shift();
  }

  /**
   * 新しく確定したカードを手がかりに、再評価する unresolved を選んで発火する(#40)。
   *
   * **ここでは LLM を呼ばない。** 絞り込みはすべてローカル判定(`isRelated()`)で、
   * 関連しそうなものだけが `rematchCard()` 経由で web 検証に回る。
   *
   * **`verifyDisabled` が立っていたら何もしない。** 残高切れ・恒久エラーで検証を
   * 打ち切った後に再評価だけ生きていると、誰にも通知されないまま課金が進む
   * (`enrichCard()` の catch が `verifyDisabled` を立てるのと対)。
   */
  private maybeRematch(hints: ExtractedCard[]): void {
    if (this.verifyDisabled || hints.length === 0 || this.pendingUnresolved.length === 0) return;
    const now = Date.now();
    let started = 0;
    // **配列のコピーを走査する。** 昇格すると `rematchCard()` が
    // `pendingUnresolved` から要素を削るので、元の配列を回すと添字がずれる。
    for (const pending of [...this.pendingUnresolved]) {
      if (started >= MAX_REMATCH_PER_RUN) break;
      // 安い順に見る。試行回数と cooldown は配列の走査だけで判断できるが、
      // 関連判定は語に割って距離を取るので、先に落とせるものは落とす
      if (pending.attempts >= config.maxRematchAttempts) continue;
      if (now - pending.lastAttemptAt < config.rematchCooldownMs) continue;
      const related = hints.filter((h) =>
        isRelated(hintForms(pending), hintForms(h), config.rematchMinSimilarity),
      );
      if (related.length === 0) continue;
      // **試行は「投げた時点」で数える。** 結果を待って数えると、検証が遅い間に
      // 次のチャンクが来て同じカードを何本も投げられる(上限が上限として効かない)。
      pending.attempts += 1;
      pending.lastAttemptAt = now;
      started += 1;
      void this.rematchCard(pending, related);
    }
  }

  /**
   * 1枚の unresolved カードを既存の Stage 2 で再検証し、裏付けが取れたら改名する(#40)。
   *
   * **検証ロジックは複製しない。** `verifyAndEnrich()` をそのまま呼ぶので、#25 の
   * プライバシー原則(会話全文を渡さない・用語集は絞り込み済みしか渡せない)が
   * 型のまま継承される。
   */
  private async rematchCard(pending: PendingUnresolved, hints: ExtractedCard[]): Promise<void> {
    // 候補の合成。足すのは**速報段階で `confirmed` / `probable` になったカードの term**で、
    // 検証段がゼロから作る用語ではない。#23 の「候補外の用語を勝手に確定しない」は
    // `parseVerifyOutput()` と `isResolved()` の二重で残る。
    //
    // **「Stage 2 を通ったカード」ではない点に注意。** `selectVerifyTargets()` が選ぶのは
    // 一部で、`enrichCard()` は投げっぱなし(`void`)なので結果を待っていない。つまり後で
    // 棄却されて降格するはずの `probable` が手がかりになることはありうる。それでも
    // 通しているのは、手がかりは**候補を1つ足すだけ**で、採否は最後に web 検証が決める
    // から(候補が増えても、裏付けが取れなければ `isResolved()` で落ちる)。
    const candidates = mergeCandidates(
      pending.candidates,
      hints.map((h) => ({ term: h.term, reading: h.reading, rationale: REMATCH_RATIONALE })),
    );
    // 改名後も「音声ではこう聞こえた」を残す。unresolved の見出しがこの表記だったので、
    // 利用者から見ると「あのカードが直った」と分かる手がかりになる
    const correctedFrom = pending.correctedFrom ?? pending.surfaceForms[0] ?? null;
    try {
      const result = await verifyAndEnrich({
        candidates,
        correctedFrom,
        // 保存した抜粋 + 直近の文脈。**会話全文は渡さない**(#25 の原則を維持)。
        // 抜粋だけだと unresolved になった当時の材料しか無く、再評価の意味が消える
        context: `${pending.context}\n${this.context.text()}`,
        // 型が絞り込み済みしか受けないので、ここを素通しにはできない(#25)
        glossaryHints: relatedGlossary(this.glossaryIndex, candidates),
      });
      // **昇格の判定に `isVerified()` は使わない。** あちらは「表示中の term が
      // 裏付けられたか」で、候補#2 が選ばれたら false を返すのが #24 の降格判断そのもの。
      // 緩めるのは再評価経路だけにする(`rematch.ts` の `isResolved()` のコメント)
      if (!isResolved(result.chosen, candidates)) {
        // 裏付け不足。unresolved のまま据え置き、`card_update` も送らない
        // (速報は `willEnrich: false` で届いているので「確認中」は残っていない)。
        // ログに出すのは term と棄却理由の内訳だけで、**文字起こし本文は出さない**
        const why = REJECTION_LABEL[result.rejection ?? "unspecified"];
        console.warn(`[scheduler] rematch not resolved "${pending.term}" (${why})`);
        return;
      }
      const chosen = pickCandidate(result.chosen, candidates);
      // `isResolved()` が true なら必ず引けるが、引けなければ改名しない。
      // 候補外の表記で改名する経路を型の外に作らない
      if (!chosen) return;
      // **改名を伴わない昇格は許さない**(#40 / #24)。合成候補の先頭は
      // `normalizeCandidates()` の不変条件により抽出段の推定 term 自身なので、検証段が
      // それを選び直すだけで `isResolved()` は true になる。素通しにすると「音が似た
      // 確定カードが1枚出た」ことをトリガに、**改名もせず `unresolved` → `confirmed` へ
      // 格上げ**でき、#24 が「unresolved は Stage 2 に回さない」で塞いだ形が復活する。
      // クライアントの `mergeCardUpdate()` が `rename` の存在でしか昇格を許さないのと
      // 同じ線引きを、サーバー側にも引く(片側だけだと逆側の経路から入られる)。
      if (!isRename(chosen.term, pending.term)) {
        console.warn(`[scheduler] rematch kept the original term "${pending.term}" — not promoting`);
        return;
      }

      // 昇格に成功したら待ち行列から外す。**同じカードを2度昇格させない**
      this.pendingUnresolved = this.pendingUnresolved.filter((p) => p !== pending);
      // 特定できた以上、デデュープの枠を空けておく理由が消える(#24 は「特定できなかった
      // 推定で枠を永久に占有させない」ために `shownTerms` から外していた)。ここで載せて
      // おかないと、後続のチャンクで**同じ用語のカードがもう1枚出る**
      const key = normalizeTerm(chosen.term);
      if (!this.shownSet.has(key)) {
        this.shownSet.add(key);
        this.shownTerms.push(chosen.term);
      }
      // **状態は `confirmed` 固定。** Issue は「confirmed / probable」と書いているが、
      // 検証段の戻り値に「確信の度合い」は無く、`chosen !== null` は既に
      // 「実在する かつ 文脈に合う」の両方を通っている(`normalizeVerification()` が
      // どちらか false なら null に倒す)。ここで `probable` を選ぶ材料が無い以上、
      // 勘で書き分けると status の意味が経路ごとにずれる。**両方を通ったものだけが
      // ここへ来る**という条件のほうを不変にしておく。
      this.callbacks.onCardUpdate(pending.cardId, "confirmed", result.description, result.links, {
        term: chosen.term,
        reading: chosen.reading,
        correctedFrom,
        // **古い表記をそのまま渡す。** 文字起こし本文は崩れた表記のまま残るので、
        // ここを新しい表記に替えると過去の行からカードへ辿れなくなる
        surfaceForms: pending.surfaceForms,
      });
    } catch (err) {
      // 恒久エラーは検証全体を止める(`enrichCard()` と同じ扱い)。再評価だけ素通しだと、
      // 会話が進むたびに web 検索つきの呼び出しを投げ続けて課金だけが進む
      if (isPermanent(err)) {
        this.verifyDisabled = true;
        console.error(`[scheduler] verification disabled after rematch "${pending.term}":`, err);
        this.callbacks.onError(`用語の検証を停止しました。${toUserMessage(err)}`);
      } else {
        console.error(`[scheduler] rematch failed for "${pending.term}":`, err);
      }
      // **`enrichCard()` と違い、失敗しても `card_update` は送らない。** あちらは
      // `willEnrich: true` で「後から更新が来る」と予告済みなので黙ると確認中の表示が
      // 残るが、再評価の対象は予告していない既存カード。送ると据え置きのはずのカードに
      // 意味のない更新が1本増えるだけになる。
      // `attempts` は投げた時点で数えてあるので、失敗し続けても上限で止まる
    }
  }
}
