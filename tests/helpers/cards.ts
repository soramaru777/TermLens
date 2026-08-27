import type { Candidate, ExtractedCard } from "../../src/extract/schema.js";

/**
 * 抽出カードまわりのテスト用ファクトリ。
 *
 * **1箇所にまとめてあるのは体裁の問題ではない。** 以前は同じ形の `card()` が4ファイルに
 * 散っていて、`ExtractionResultSchema` にフィールドを1つ足すたび全部を機械的に直す必要が
 * あった（#23 で `candidates` を足したときに実際に踏んだ）。`utterance()` に至っては
 * `MIN_CHARS`(120) を `"あ".repeat(130)` という形で暗黙に持っているので、閾値が変わると
 * **コピーの片方だけが閾値を割り、抽出が一度も発火しないまま緑になる**。
 */

/**
 * 既定値は「検証対象以外は素通しの確認用」。見たいフィールドだけ `overrides` で上書きする。
 *
 * **カードと候補で `reading` を別の値にしてある。** 揃えると「補った候補の読みをカード側から
 * 採っているか」を確かめるテスト（`candidates.test.ts`）が、どちらから採っても通ってしまう。
 */
export function card(term: string, overrides: Partial<ExtractedCard> = {}): ExtractedCard {
  return {
    term,
    reading: "テストヨミ",
    description: "テスト用のカード。",
    status: "confirmed",
    rarity: "rare",
    correctedFrom: null,
    surfaceForms: [],
    candidates: [candidate(term)],
    ...overrides,
  };
}

export function candidate(term: string, rationale = "音韻が近い"): Candidate {
  return { term, reading: "テスト", rationale };
}

/** `MIN_CHARS`(120) を必ず超える発話。先頭の目印でどのチャンクか見分ける。 */
export function utterance(mark: string): string {
  return `${mark}:${"あ".repeat(130)}`;
}

/**
 * `run()` の中の await を巡回させる。`setImmediate` はマイクロタスクを全部流してから走る。
 * 清書（`enrichCard`）は `void` の投げっぱなしなので、そこまで見るなら複数巡が要る。
 */
export async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
