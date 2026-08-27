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
import type { TermCard, TermLink, TermStatus } from "../protocol.js";
import { ContextWindow } from "./context.js";
import { createExtractor, UNRESOLVED_DESCRIPTION } from "./extractor.js";
import { isVerified, verifyAndEnrich } from "./enrich.js";
import { normalizeTerm } from "./normalize.js";
import type { ExtractedCard } from "./schema.js";

const MIN_CHARS = 120;
const MAX_WAIT_MS = 10_000;
const CHECK_INTERVAL_MS = 5_000;
const SHOWN_TERMS_LIMIT = 50;
const MAX_CONSECUTIVE_FAILURES = 3;
// 未処理バッファの上限。会議は流れ続けるので、古い未処理チャンクを保持する価値は低い。
const MAX_BUFFER_CHARS = 2_000;

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
 * **`unresolved` も検証に回す(#24)。** 裏付けが取れても `confirmed` へは昇格しない
 * (改名の経路が無い)が、Stage 2 は「候補のどれも実在しない/文脈に合わない」を
 * 独立した情報源で確かめる唯一の場なので、外すと unresolved が一度も検証されないまま残る。
 *
 * **補正のないカードは Stage 2 を通さない。** そもそも速報は従来どおり即時表示で、
 * Stage 2 は非同期の `card_update` なので、表示までの時間はどちらにせよ変わらない。
 *
 * 純関数として export してあるのは、評価ハーネス(`src/eval/run.ts`)が
 * `EVAL_WITH_VERIFY=1` のときに**本番と同じ選定**で回すため。コピーすると drift する。
 */
export function selectVerifyTargets<
  T extends {
    term: string;
    rarity: "common" | "uncommon" | "rare";
    status: TermStatus;
    correctedFrom: string | null;
  },
>(cards: T[]): Set<string> {
  // レア度上位の約半数。同レア度なら誤認識疑い(confirmed でないもの)を先に詰める。
  // **この並べ替えは対象を広げるためではなく、狭く保つためにある。** 非 confirmed は
  // 下のループでどのみち全部入るので、上位半数の枠を先に食わせておくと和集合の増分が
  // 小さくなる(枠が空くと補正なし・confirmed のカードが余分に入る)。
  const rarityRank = { rare: 2, uncommon: 1, common: 0 };
  const ranked = [...cards].sort(
    (a, b) =>
      rarityRank[b.rarity] - rarityRank[a.rarity] ||
      (a.status !== "confirmed" ? -1 : 0) - (b.status !== "confirmed" ? -1 : 0),
  );
  const targets = new Set(ranked.slice(0, Math.ceil(cards.length / 2)).map((c) => c.term));
  // 誤補正が疑わしいカードはレア度に関係なく必ず検証する。
  // `!== "confirmed"` と書くのは probable と unresolved の両方を拾うため(#24)。
  // 値を列挙すると、将来 status が増えたときに黙って対象から漏れる。
  for (const card of cards) {
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
function toClientCard(card: ExtractedCard, willEnrich: boolean): TermCard {
  return {
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
  private timer: NodeJS.Timeout;
  private extract: ReturnType<typeof createExtractor>;

  constructor(
    glossary: string[],
    private callbacks: {
      onCards: (cards: TermCard[]) => void;
      /**
       * 清書(検証)の結果をクライアントへ届ける。`status` は #24 で追加した。
       * 裏付けが取れれば `confirmed`、棄却なら `unresolved` に**降格**する。
       */
      onCardUpdate: (
        term: string,
        status: TermStatus,
        description: string,
        links: TermLink[],
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
        // 速報: LLMの知識ベースのドラフト解説で即表示
        this.callbacks.onCards(fresh.map((c) => toClientCard(c, enrichTargets.has(c.term))));
        // 清書: 選ばれた用語だけweb検索で候補を検証し、要約+関連リンクで更新
        for (const card of fresh) {
          if (enrichTargets.has(card.term)) void this.enrichCard(card, chunk);
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

  private async enrichCard(card: ExtractedCard, context: string): Promise<void> {
    try {
      const result = await verifyAndEnrich({
        candidates: card.candidates,
        correctedFrom: card.correctedFrom,
        context,
      });
      const verified = isVerified(card.term, result.chosen);
      if (!verified) {
        // 棄却。出すのは term と reason だけで、**文字起こし本文は出さない**
        // (既存の `console.error("[scheduler] extraction failed:", err)` と同じ扱い)。
        console.warn(`[scheduler] verification rejected "${card.term}": ${result.reason}`);
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
        card.term,
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
      } else {
        console.error(`[scheduler] enrich failed for "${card.term}":`, err);
      }
      // **失敗しても更新は必ず届ける。** 速報を `willEnrich: true` で送った以上、
      // 黙るとクライアントの「確認中」が会議の終わりまで回り続け、localStorage にも
      // その状態で保存されるので復元しても消えない(#23 で棄却時に踏んだのと同じ穴)。
      // 検証できなかっただけなので**速報の status と解説はそのまま**、リンクだけ空で送る。
      this.callbacks.onCardUpdate(card.term, card.status, card.description, []);
    }
  }
}
