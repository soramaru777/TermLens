import {
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import type { TermCard, TermLink } from "../protocol.js";
import { createExtractor } from "./extractor.js";
import { enrichTerm } from "./enrich.js";

const MIN_CHARS = 120;
const MAX_WAIT_MS = 10_000;
const CHECK_INTERVAL_MS = 5_000;
const SHOWN_TERMS_LIMIT = 50;
const MAX_CONSECUTIVE_FAILURES = 3;
// 未処理バッファの上限。会議は流れ続けるので、古い未処理チャンクを保持する価値は低い。
const MAX_BUFFER_CHARS = 2_000;

function normalizeTerm(term: string): string {
  return term.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** SDK 自身が再試行するステータス。分類を SDK の方針と一致させる。 */
const SDK_RETRYABLE_STATUSES = new Set([408, 409, 429]);

/**
 * 残高不足・課金上限による 429 か。
 *
 * OpenAI はレート超過と残高切れをどちらも 429 で返すが、前者は待てば回復し、
 * 後者は入金するまで永久に失敗する。ステータスだけで判定すると残高切れを
 * 再試行し続け、バッファが肥大する(#3 と同じ壊れ方)。区別は code に頼る。
 */
function isQuotaExhausted(err: APIError): boolean {
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
function isPermanent(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const status = err.status;
  // APIConnectionError などは status が undefined。判別できないものは再試行に倒す。
  if (typeof status !== "number") return false;
  if (status === 429) return isQuotaExhausted(err);
  return status >= 400 && status < 500 && !SDK_RETRYABLE_STATUSES.has(status);
}

/** 開発者向けの生メッセージを利用者向けの文言に変換する */
function toUserMessage(err: unknown): string {
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
 * final transcript を蓄積し、「120文字以上」または「前回呼び出しから20秒経過かつ非空」で
 * LLM抽出を発火する。呼び出しは直列化し、既出用語はサーバー側でもデデュープする。
 */
export class ExtractionScheduler {
  private buffer = "";
  private lastRunAt = Date.now();
  private running = false;
  private stopped = false;
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
      onCardUpdate: (term: string, description: string, links: TermLink[]) => void;
      onExtracting: () => void;
      onError: (message: string) => void;
    },
  ) {
    this.extract = createExtractor(glossary);
    this.timer = setInterval(() => this.maybeRun(), CHECK_INTERVAL_MS);
  }

  addFinal(text: string): void {
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
        shownTerms: this.shownTerms.slice(-SHOWN_TERMS_LIMIT),
      });
      this.consecutiveFailures = 0;

      const fresh = cards.filter((c) => {
        const key = normalizeTerm(c.term);
        if (this.shownSet.has(key)) return false;
        this.shownSet.add(key);
        this.shownTerms.push(c.term);
        return true;
      });
      if (fresh.length > 0) {
        // 清書(web検索)はレア度上位の約半数のみ。同レア度なら誤認識疑い(low)を優先
        const rarityRank = { rare: 2, uncommon: 1, common: 0 };
        const ranked = [...fresh].sort(
          (a, b) =>
            rarityRank[b.rarity] - rarityRank[a.rarity] ||
            (a.confidence === "low" ? -1 : 0) - (b.confidence === "low" ? -1 : 0),
        );
        const enrichTargets = new Set(
          ranked.slice(0, Math.ceil(fresh.length / 2)).map((c) => c.term),
        );
        // 速報: LLMの知識ベースのドラフト解説で即表示
        this.callbacks.onCards(
          fresh.map((c) => ({ ...c, links: [], willEnrich: enrichTargets.has(c.term) })),
        );
        // 清書: 選ばれた用語だけweb検索で最新情報を取得し、要約+関連リンクで更新
        for (const term of enrichTargets) {
          void this.enrichCard(term, chunk);
        }
      }
    } catch (err) {
      console.error("[scheduler] extraction failed:", err);

      if (isPermanent(err)) {
        // 再試行しても成功しないため、バッファに戻さず抽出を打ち切る。
        // 戻すと会議が続く限りバッファが肥大し、復旧時に巨大なリクエストになる。
        this.disableExtraction();
        this.callbacks.onError(`用語抽出を停止しました。${toUserMessage(err)}`);
        return;
      }

      // 一時的なエラーはバッファに戻して次回に回す
      this.appendToBuffer(chunk, true);
      this.consecutiveFailures += 1;
      if (
        this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        this.consecutiveFailures % MAX_CONSECUTIVE_FAILURES === 0
      ) {
        this.callbacks.onError(
          `用語抽出が${this.consecutiveFailures}回連続で失敗しました。${toUserMessage(err)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async enrichCard(term: string, context: string): Promise<void> {
    try {
      const result = await enrichTerm(term, context);
      // 停止後でも flush 済みカードの更新は届けてよい(送信可否は session 側が判定する)
      this.callbacks.onCardUpdate(term, result.description, result.links);
    } catch (err) {
      // 清書失敗時はドラフト解説のまま(リンクなし)。致命的ではないのでログのみ
      console.error(`[scheduler] enrich failed for "${term}":`, err);
    }
  }
}
