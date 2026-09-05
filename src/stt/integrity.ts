import type { SplitDiag } from "./types.js";

/**
 * STT テキスト完全性のセッション累計（#52）。
 *
 * **依存ゼロで保つこと**（import は `./split.js` の型のみ）。`session.ts` に置くと
 * `config.ts` を連れ込むテストになり、`STT_PROVIDER=deepgram` でキー未設定の環境では
 * import した時点で throw する（`split.ts` / `utterance.ts` を切り出したのと同じ理由）。
 *
 * **持つのは件数と文字数だけ。** 会話本文も、本文を復元しうる hash も持たない
 * （短い発話は総当たりで復元されうる。Issue は「必要なら hash」としているが、まず
 * 入れずに済ませる）。ここに載らない値は診断ファイルにも出ようがない、という形にしてある。
 */

/** `SplitIntegrity.snapshot()` の戻り。**このキーの集合がそのまま外へ出せる上限**。 */
export interface IntegritySnapshot {
  /** final の総数（transcript が空の Results は数えない。下の `add()` のコメント参照） */
  finals: number;
  /** 分割が起きた final の数（`segments >= 2`） */
  splitFinals: number;
  /** ① Deepgram final の文字数の累計 */
  rawChars: number;
  rawVisible: number;
  /** ② 話者分割後に発行したイベントの文字数の累計 */
  splitChars: number;
  splitVisible: number;
  /**
   * `sliceFromTranscript()` が失敗し連結へ落ちた回数。
   *
   * **0 かどうかが ①→② の差の読み方を変える。** フォールバックは `transcript` と
   * `words[]` が食い違うときにだけ起きるので、再構成した ② は ① と**別の文字列**になり、
   * 空白を除いた文字数すら増減しうる（`split.ts` の `visibleChars` のコメント）。
   */
  fallbacks: number;
  /** 空で捨てられたセグメント数の累計 */
  droppedEvents: number;
  /** そのうち**先頭**セグメントだったもの（＝発話の頭が丸ごと消えた回数） */
  headDrops: number;
}

export class SplitIntegrity {
  private finals = 0;
  private splitFinals = 0;
  private rawChars = 0;
  private rawVisible = 0;
  private splitChars = 0;
  private splitVisible = 0;
  private fallbacks = 0;
  private droppedEvents = 0;
  private headDrops = 0;

  /**
   * 1つの final の計測を足す。
   *
   * **transcript が空の Results は渡ってこない**（`buildTranscriptEvents()` が
   * `diag` ごと返さない）。渡すと `finals` が無音の Results を数える器になり、
   * 「final あたり何文字だったか」を読むための分母として使えなくなる。
   */
  add(d: SplitDiag): void {
    this.finals++;
    if (d.segments >= 2) this.splitFinals++;
    this.rawChars += d.rawChars;
    this.rawVisible += d.rawVisible;
    this.splitChars += d.splitChars;
    this.splitVisible += d.splitVisible;
    if (d.fallback) this.fallbacks++;
    // **`Math.max(0, ...)` が要る。** 素通しの経路では words が無いと `segments === 0` で
    // `events === 1` になり、素直に引くと -1 が積まれる（分割していないのに「-1件捨てた」）
    this.droppedEvents += Math.max(0, d.segments - d.events);
    if (d.headDropped) this.headDrops++;
  }

  /** 現在の累計。**呼ぶたびに新しいオブジェクトを返す**（内部状態への参照を渡さない）。 */
  snapshot(): IntegritySnapshot {
    return {
      finals: this.finals,
      splitFinals: this.splitFinals,
      rawChars: this.rawChars,
      rawVisible: this.rawVisible,
      splitChars: this.splitChars,
      splitVisible: this.splitVisible,
      fallbacks: this.fallbacks,
      droppedEvents: this.droppedEvents,
      headDrops: this.headDrops,
    };
  }
}
