import assert from "node:assert/strict";
import test from "node:test";
import { selectVerifyTargets } from "../src/extract/scheduler.js";
import { buildTermsMarkdown } from "../public/terms-markdown.js";
import { card } from "./helpers/cards.js";

/**
 * #44 が **変えないと約束したもの** を固定する。
 *
 * 「変えていない」は、放置すると将来だれかが黙って壊す。触ってはいけない不変条件ほど
 * テストで押さえる価値がある（#23 の候補制約・#24 の unresolved ガードと同じ扱い）。
 */

// --- T18: Stage 2 の選定は importance で変わらない ---------------------------

/** `selectVerifyTargets()` が見るフィールドだけを持つ最小のカード */
const target = (term: string, rarity: "common" | "uncommon" | "rare", extra = {}) => ({
  term,
  rarity,
  status: "confirmed" as const,
  correctedFrom: null,
  ...extra,
});

test("Stage 2 の検証対象は importance を変えても同じ", () => {
  // **importance を Stage 2 に流用しない**（#44 の AC）。`selectVerifyTargets()` の
  // 引数型は構造的部分型なので、importance を足しても選定は1行も動かないはず。
  // ここが落ちるときは、誰かが選定へ importance を持ち込んでいる
  const base = [
    target("AB", "rare"),
    target("ABC", "uncommon"),
    target("ドメイン知識", "common"),
    target("業務知識", "common"),
  ];
  const expected = [...selectVerifyTargets(base)].sort();

  // 全部 low にしても、全部 high にしても、混ぜても同じ集合になること
  for (const importance of ["high", "medium", "low"]) {
    const withImportance = base.map((c) => ({ ...c, importance }));
    assert.deepEqual([...selectVerifyTargets(withImportance)].sort(), expected, importance);
  }
  const mixed = base.map((c, i) => ({ ...c, importance: ["high", "low", "medium", "low"][i] }));
  assert.deepEqual([...selectVerifyTargets(mixed)].sort(), expected, "混在");
});

test("importance=low でも誤補正疑いなら従来どおり検証対象に入る", () => {
  // Issue 本文の「importance=low でも、誤認識補正等の理由で必要なら従来どおり検証される」
  const cards = [
    target("AB", "common", { importance: "low", status: "probable" }),
    target("ドメイン知識", "common", { importance: "high" }),
  ];
  assert.ok(selectVerifyTargets(cards).has("AB"), "probable はレア度に関係なく必ず入る");
});

// --- T19: Markdown からは low カードが落ちない -------------------------------

test("Markdown エクスポートは importance=low のカードも出す", () => {
  // AC「Markdown エクスポートには全カードが残る」。折りたたみは**表示**の話であって、
  // 保存した成果物から情報を落とす話ではない
  const md = buildTermsMarkdown(
    [
      { term: "AB", reading: "エービー", description: "重要な語。", status: "confirmed", importance: "high", surfaceForms: [], links: [] },
      { term: "ドメイン知識", reading: "ドメインチシキ", description: "平易な語。", status: "confirmed", importance: "low", surfaceForms: [], links: [] },
    ],
    "2026-01-01 00:00",
  );
  assert.match(md, /## AB/);
  assert.match(md, /## ドメイン知識/, "low カードが欠落しない");
  assert.match(md, /平易な語。/, "解説も落とさない");
  assert.match(md, /- 件数: 2/, "件数も全カードで数える");
});

test("Markdown は importance を露出しない（内部/UI 用メタデータのまま）", () => {
  // Issue: 「importance 自体を Markdown に露出するかは必須としない」。
  // 出さない選択をしたことを固定しておく（出し始めるなら意図的な変更として来るはず）
  const md = buildTermsMarkdown(
    [{ term: "AB", reading: "", description: "解説。", status: "confirmed", importance: "low", surfaceForms: [], links: [] }],
    "2026-01-01 00:00",
  );
  assert.doesNotMatch(md, /importance/i);
  assert.doesNotMatch(md, /その他の用語/);
});

// --- T20: 旧保存データの復元 -------------------------------------------------

test("importance を持たない保存データも Markdown を組める", () => {
  // 復元経路は `cardImportance()` 1本で既定が決まる。エクスポート側に分岐は足していない
  const md = buildTermsMarkdown(
    [{ term: "AB", reading: "エービー", description: "旧データ。", status: "confirmed", surfaceForms: [], links: [] }],
    "2026-01-01 00:00",
  );
  assert.match(md, /## AB/);
  assert.match(md, /旧データ。/);
});

// --- 抽出カードのファクトリが型を満たすことの確認 ---------------------------

test("抽出カードの既定 importance は medium（テストの土台を固定する）", () => {
  assert.equal(card("AB").importance, "medium");
});
