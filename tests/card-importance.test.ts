import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPORTANCE_DEFAULT,
  cardImportance,
  mergeCardUpdate,
  mergeDuplicateCards,
} from "../public/card-status.js";
import { TermCardSchema } from "../src/extract/schema.js";
import { card } from "./helpers/cards.js";

/**
 * 表示優先度（#44）の純関数を固定する。
 *
 * **用語はすべて匿名化した合成語**（`AB` / `ABC` / `ドメイン知識`）。実会話・実際の
 * 面談内容・固有名詞は使わない（Issue の要件、`src/eval/cases.ts` と同じ方針）。
 */

// --- T12: schema ------------------------------------------------------------

test("schema は high / medium / low だけを受理する", () => {
  for (const importance of ["high", "medium", "low"] as const) {
    assert.equal(TermCardSchema.parse(card("AB", { importance })).importance, importance);
  }
  // 3値以外は落とす。ここが緩いと「壊れた importance が classList へ渡る」経路ができる
  assert.throws(() => TermCardSchema.parse({ ...card("AB"), importance: "urgent" }));
  assert.throws(() => TermCardSchema.parse({ ...card("AB"), importance: "" }));
  const { importance: _drop, ...noImportance } = card("AB");
  assert.throws(() => TermCardSchema.parse(noImportance), "importance は必須にする");
});

// --- T13: cardImportance() --------------------------------------------------

test("cardImportance: 3値はそのまま返す", () => {
  assert.equal(cardImportance({ importance: "high" }), "high");
  assert.equal(cardImportance({ importance: "medium" }), "medium");
  assert.equal(cardImportance({ importance: "low" }), "low");
});

test("cardImportance: 旧保存データ・壊れた値は既定へ丸める", () => {
  // **既定は「隠さない」側。** low に倒すと、importance を持たない既存セッションを
  // 復元した瞬間に全カードが「その他の用語」へ消える
  assert.equal(IMPORTANCE_DEFAULT, "medium");
  assert.equal(cardImportance({}), "medium", "#44 以前の保存データ");
  assert.equal(cardImportance({ importance: undefined }), "medium");
  assert.equal(cardImportance({ importance: " low " }), "medium", "空白入りは丸める");
  assert.equal(cardImportance({ importance: "urgent" }), "medium");
  assert.equal(cardImportance({ importance: 1 }), "medium");
  assert.equal(cardImportance(undefined), "medium", "カードごと欠けても例外にしない");
});

// --- T14: 統合は高いほうを残す ----------------------------------------------

const box = (importance: string, extra: Record<string, unknown> = {}) => ({
  cardId: "k1",
  term: "AB",
  surfaceForms: [],
  links: [],
  importance,
  ...extra,
});

test("統合は高いほうの importance を残す（残す側が低くても）", () => {
  // **これが #44 の統合規則そのもの。** `{ ...drop, ...keep }` だと keep が無条件に
  // 勝つので、この向きだけが落ちる
  assert.equal(mergeDuplicateCards(box("low"), box("high")).importance, "high");
  assert.equal(mergeDuplicateCards(box("medium"), box("high")).importance, "high");
  assert.equal(mergeDuplicateCards(box("low"), box("medium")).importance, "medium");
});

test("統合は高いほうの importance を残す（残す側が高い向きも）", () => {
  assert.equal(mergeDuplicateCards(box("high"), box("low")).importance, "high");
  assert.equal(mergeDuplicateCards(box("medium"), box("low")).importance, "medium");
  assert.equal(mergeDuplicateCards(box("high"), box("high")).importance, "high");
});

test("統合は importance を持たないカードも既定として扱う", () => {
  // 復元した古いカード（importance なし）と統合しても、medium 相当として比べる。
  // `undefined` が rank 表に無くて NaN 比較になると、向きによって結果が変わる
  const legacy = { cardId: "k2", term: "AB", surfaceForms: [], links: [] };
  assert.equal(mergeDuplicateCards(box("low"), legacy).importance, "medium");
  assert.equal(mergeDuplicateCards(legacy, box("low")).importance, "medium");
  assert.equal(mergeDuplicateCards(legacy, box("high")).importance, "high");
});

test("統合の既存規則（cardId / surfaceForms / links）は importance で変わらない", () => {
  const keep = {
    cardId: "k1",
    term: "AB",
    importance: "low",
    surfaceForms: ["エービー"],
    links: [{ title: "1", url: "https://example.com/1" }],
  };
  const drop = {
    cardId: "k2",
    term: "AB",
    importance: "high",
    surfaceForms: ["エービー", "えーびー"],
    links: [{ title: "2", url: "https://example.com/2" }],
  };
  const merged = mergeDuplicateCards(keep, drop);
  assert.equal(merged.cardId, "k1", "残す cardId は keep のまま");
  assert.deepEqual(merged.surfaceForms, ["エービー", "えーびー"], "keep → drop の順で連結");
  assert.deepEqual(
    merged.links.map((l: { url: string }) => l.url),
    ["https://example.com/1", "https://example.com/2"],
    "links は keep 優先で drop から補う",
  );
  assert.equal(merged.importance, "high", "importance だけは高いほうを採る");
});

// --- T15: rename で importance を失わない -----------------------------------

test("rename を伴う card_update でも importance は据え置く", () => {
  // **`CardRename` に importance が無いこと自体が実装。** ここが落ちるときは、
  // 誰かが CardRename へ importance を足している
  const stored = {
    cardId: "k1",
    term: "ABC",
    importance: "high",
    status: "unresolved",
    surfaceForms: ["えーびーしー"],
  };
  const updated = mergeCardUpdate(stored, {
    status: "confirmed",
    description: "解説",
    links: [],
    rename: { term: "AB", reading: "エービー", correctedFrom: "えーびーしー", surfaceForms: ["えーびーしー"] },
  });
  assert.equal(updated.term, "AB", "改名は反映される");
  assert.equal(updated.status, "confirmed");
  assert.equal(updated.importance, "high", "改名しても表示優先度は動かさない");
});

test("素の card_update でも importance は据え置く", () => {
  const stored = { cardId: "k1", term: "AB", importance: "low", status: "confirmed" };
  const updated = mergeCardUpdate(stored, { status: "confirmed", description: "清書", links: [] });
  assert.equal(updated.description, "清書");
  assert.equal(updated.importance, "low");
});

// --- T16 / T17: rarity・status と独立 ---------------------------------------

test("rarity と importance は独立して保持される", () => {
  // 「平易だが会話の主題」も「珍しいが脇役」も型として素直に書ける
  const common = TermCardSchema.parse(card("ドメイン知識", { rarity: "common", importance: "high" }));
  assert.equal(common.rarity, "common");
  assert.equal(common.importance, "high");

  const rare = TermCardSchema.parse(card("ABC", { rarity: "rare", importance: "low" }));
  assert.equal(rare.rarity, "rare");
  assert.equal(rare.importance, "low");
});

test("status=unresolved でも importance=high を保持できる", () => {
  // 「本当に重要そうだが、まだ用語を特定できていない」を埋もれさせないため
  const parsed = TermCardSchema.parse(
    card("AB", { status: "unresolved", importance: "high", description: "" }),
  );
  assert.equal(parsed.status, "unresolved");
  assert.equal(parsed.importance, "high");
  assert.equal(cardImportance(parsed), "high");
});
