import type { TermCard, TermLink } from "../protocol.js";
import { createExtractor } from "./extractor.js";
import { enrichTerm } from "./enrich.js";

const MIN_CHARS = 120;
const MAX_WAIT_MS = 10_000;
const CHECK_INTERVAL_MS = 5_000;
const SHOWN_TERMS_LIMIT = 50;
const MAX_CONSECUTIVE_FAILURES = 3;

function normalizeTerm(term: string): string {
  return term.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
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
    if (this.stopped) return;
    this.buffer += (this.buffer ? " " : "") + text;
    this.maybeRun();
  }

  /** 停止時に残りバッファを処理する */
  async flush(): Promise<void> {
    await this.run();
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private maybeRun(): void {
    if (this.running || this.stopped || this.buffer.length === 0) return;
    const waited = Date.now() - this.lastRunAt;
    if (this.buffer.length >= MIN_CHARS || waited >= MAX_WAIT_MS) {
      void this.run();
    }
  }

  private async run(): Promise<void> {
    if (this.running || this.buffer.length === 0) return;
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
      // バッファを戻して次回に回す
      this.buffer = chunk + (this.buffer ? " " + this.buffer : "");
      this.consecutiveFailures += 1;
      console.error("[scheduler] extraction failed:", err);
      if (
        this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        this.consecutiveFailures % MAX_CONSECUTIVE_FAILURES === 0
      ) {
        this.callbacks.onError(
          `用語抽出が${this.consecutiveFailures}回連続で失敗しました: ${(err as Error).message}`,
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
