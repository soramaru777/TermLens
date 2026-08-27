import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCandidates } from "../src/extract/extractor.js";
import {
  MAX_CANDIDATES,
  type Candidate,
  type ExtractedCard,
} from "../src/extract/schema.js";
import { card as baseCard, candidate } from "./helpers/cards.js";

/**
 * 候補配列のサーバー側整形（#23）。
 *
 * 検証段（`enrich.ts`）は **`candidates[0].term === term`・最大 `MAX_CANDIDATES` 件**を
 * 前提にしている。プロンプト規則10でも指示しているが、構造化出力は件数の指示を守らない。
 * 目的は**検証段へ渡す入力を小さく保つこと**で、`max_completion_tokens` の超過を防ぐことでは
 * ない（整形はパース成功後に走るので、超過時はそこまで到達しない）。
 * **LLM の従順さに依存せず**ここで固定する。
 */

/** 検証対象は candidates だけなので、他フィールドは共有ヘルパの既定値で素通しする。 */
function card(term: string, candidates: Candidate[]): ExtractedCard {
  return baseCard(term, { candidates });
}

test("上限を超えた候補を切り詰める", () => {
  const out = normalizeCandidates([
    card("Kubernetes", [
      candidate("Kubernetes"),
      candidate("Cubernetes"),
      candidate("Kubernete"),
      candidate("クーベルタン"),
      candidate("Kubeflow"),
    ]),
  ]);
  assert.equal(out[0]!.candidates.length, MAX_CANDIDATES);
  assert.deepEqual(
    out[0]!.candidates.map((c) => c.term),
    ["Kubernetes", "Cubernetes", "Kubernete"],
    "先頭から順に残す",
  );
});

test("term が先頭でなければ先頭へ移し、残りの順序は保つ", () => {
  const out = normalizeCandidates([
    card("Qdrant", [candidate("クアドラント"), candidate("Qdrant"), candidate("Quadrant")]),
  ]);
  assert.deepEqual(
    out[0]!.candidates.map((c) => c.term),
    ["Qdrant", "クアドラント", "Quadrant"],
  );
  assert.equal(
    out[0]!.candidates[0]!.rationale,
    "音韻が近い",
    "移動した候補の rationale は捨てない",
  );
});

test("term が候補に無ければ先頭に足す。切り詰めはその後に効く", () => {
  const out = normalizeCandidates([
    card("Grafana", [candidate("グラハム"), candidate("Graphana"), candidate("Grafanna")]),
  ]);
  assert.deepEqual(
    out[0]!.candidates.map((c) => c.term),
    ["Grafana", "グラハム", "Graphana"],
    "先に切ると term 自身が枠から溢れる",
  );
  assert.equal(out[0]!.candidates[0]!.reading, "テストヨミ", "補った候補の読みはカードから採る");
});

test("候補が空なら term 1件だけを補う", () => {
  const out = normalizeCandidates([card("Jira", [])]);
  assert.equal(out[0]!.candidates.length, 1);
  assert.equal(out[0]!.candidates[0]!.term, "Jira");
  assert.ok(out[0]!.candidates[0]!.rationale.length > 0, "rationale は空にしない");
});

test("先頭の表記は card.term に揃える（表記ゆれで不変条件を条件付きにしない）", () => {
  const out = normalizeCandidates([
    card("Kubernetes", [candidate("kubernetes "), candidate("Kubeflow")]),
  ]);
  assert.equal(out[0]!.candidates[0]!.term, "Kubernetes");
  assert.equal(
    out[0]!.candidates.length,
    2,
    "正規化キーが一致する候補は「term が無い」扱いにせず、移動させる",
  );
});

test("正規化キーが同じ候補は畳む（上限の枠を同じ語で使い潰さない）", () => {
  const out = normalizeCandidates([
    card("OAuth", [candidate("OAuth"), candidate("oauth"), candidate("ＯＡｕｔｈ"), candidate("PKCE")]),
  ]);
  assert.deepEqual(
    out[0]!.candidates.map((c) => c.term),
    ["OAuth", "PKCE"],
  );
});

test("空・空白だけの候補を落とす", () => {
  const out = normalizeCandidates([card("NDA", [candidate(""), candidate("   "), candidate("NBA")])]);
  assert.deepEqual(
    out[0]!.candidates.map((c) => c.term),
    ["NDA", "NBA"],
  );
});

test("candidates 以外のフィールドは変えない", () => {
  const original = {
    ...card("RAG", [candidate("RAG")]),
    confidence: "low" as const,
    correctedFrom: "ラグ",
    surfaceForms: ["ラグ"],
  };
  const out = normalizeCandidates([original]);
  const { candidates: _dropped, ...restIn } = original;
  const { candidates: _kept, ...restOut } = out[0]!;
  assert.deepEqual(restOut, restIn);
});

test("入力を破壊しない（新しい配列・新しいオブジェクトを返す）", () => {
  const input = [card("Pinecone", [candidate("ピネコーン"), candidate("Pinecone")])];
  const out = normalizeCandidates(input);
  assert.notEqual(out[0], input[0]);
  assert.deepEqual(
    input[0]!.candidates.map((c) => c.term),
    ["ピネコーン", "Pinecone"],
    "元のカードはそのまま",
  );
  assert.deepEqual(normalizeCandidates([]), []);
});
