import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LINKS, mergeDuplicateCards } from "../public/card-status.js";

/**
 * 改名で同じ用語になった2枚のカードの統合ルール（#40）。
 *
 * **Issue 本文が「実装前に決め、テストで固定する」と名指ししていた箇所。**
 * `card_update` で unresolved カードが改名された結果、既に同じ term のカードが
 * 画面に居る、という衝突は普通に起きる（unresolved の推定 term は `shownTerms` に
 * 載らないので、後から明瞭に発話された正しい用語が別カードとして出る）。
 *
 * 決めたのは3つ。
 * - **残す `cardId` は登場順が早いほう** … 呼び出し側が `keep` に渡す。#38 の目的は
 *   ID の永続性で、既に画面に居て人が固定しているかもしれないカードを消さない
 * - **`surfaceForms` は 残す側 → 消す側 の順で連結** … 登場順を保ち、両方の表記から
 *   カードへ辿れるようにする
 * - **`links` は残す側優先で `MAX_LINKS` まで補う** … 空配列で上書きして情報を失わない
 *
 * `app.js` の DOM 操作から切り離した純関数なので、ルールそのものはここで固定できる
 * （配線は `app-wiring.test.ts`）。
 */

const link = (n: number) => ({ title: `リンク${n}`, url: `https://example.test/${n}` });

/** 先に登場した unresolved カードが、再評価で確定用語へ改名されたもの。 */
function keepCard(overrides = {}) {
  return {
    cardId: "k1",
    term: "AB",
    reading: "エービー",
    status: "confirmed",
    description: "再評価で確定した解説。",
    correctedFrom: "えーび",
    surfaceForms: ["えーび"],
    links: [link(1)],
    ...overrides,
  };
}

/** 後から明瞭な発話で生えていた同じ用語のカード。 */
function dropCard(overrides = {}) {
  return {
    cardId: "k2",
    term: "AB",
    reading: "エービー",
    status: "confirmed",
    description: "後から出たカードの解説。",
    correctedFrom: null,
    surfaceForms: ["エービー"],
    links: [link(2)],
    ...overrides,
  };
}

test("残す側の cardId がそのまま残る", () => {
  const merged = mergeDuplicateCards(keepCard(), dropCard());
  assert.equal(merged.cardId, "k1", "統合で識別子が動くと以降の更新が迷子になる（#38）");
});

test("表示内容は残す側が勝つ", () => {
  const merged = mergeDuplicateCards(keepCard(), dropCard());
  assert.equal(merged.description, "再評価で確定した解説。");
  assert.equal(merged.correctedFrom, "えーび", "「音声ではこう聞こえた」を失わない");
});

test("surfaceForms は 残す側 → 消す側 の順で連結する", () => {
  const merged = mergeDuplicateCards(keepCard(), dropCard());
  assert.deepEqual(merged.surfaceForms, ["えーび", "エービー"], "登場順を保つ");
});

/**
 * **両方の表記からカードへ辿れるようにするための連結。**
 *
 * 消える側の表記を落とすと、その表記でハイライトされていた過去の行がどのカードも
 * 指さなくなる（`highlightOwner` は表記をキーに持つ）。
 */
test("消える側にしか無い表記も残す", () => {
  const merged = mergeDuplicateCards(
    keepCard({ surfaceForms: [] }),
    dropCard({ surfaceForms: ["エービー", "ＡＢ"] }),
  );
  assert.deepEqual(merged.surfaceForms, ["エービー", "ＡＢ"]);
});

test("重複した表記は落とす（大文字小文字・前後の空白は同じ表記とみなす）", () => {
  const merged = mergeDuplicateCards(
    keepCard({ surfaceForms: ["AB", "えーび"] }),
    dropCard({ surfaceForms: [" ab ", "エービー"] }),
  );
  assert.deepEqual(merged.surfaceForms, ["AB", "えーび", "エービー"]);
});

test("links は残す側を優先し、足りない分を消す側から補う", () => {
  const merged = mergeDuplicateCards(
    keepCard({ links: [link(1)] }),
    dropCard({ links: [link(2), link(3)] }),
  );
  assert.deepEqual(merged.links, [link(1), link(2), link(3)]);
});

test("links は MAX_LINKS で切る", () => {
  const merged = mergeDuplicateCards(
    keepCard({ links: [link(1), link(2)] }),
    dropCard({ links: [link(3), link(4), link(5)] }),
  );
  assert.equal(merged.links.length, MAX_LINKS);
  assert.deepEqual(merged.links, [link(1), link(2), link(3)], "残す側から詰める");
});

/**
 * **空配列で上書きして情報を失わない。**
 *
 * 再評価が棄却されたカードや、検証に回らなかったカードは `links: []` を持つ。
 * 素直に上書きすると、統合するたびに片方のリンクが消える。
 */
test("残す側のリンクが空でも消す側から補う", () => {
  const merged = mergeDuplicateCards(keepCard({ links: [] }), dropCard({ links: [link(2)] }));
  assert.deepEqual(merged.links, [link(2)]);
});

test("同じ URL のリンクは1件にまとめる", () => {
  const merged = mergeDuplicateCards(keepCard({ links: [link(1)] }), dropCard({ links: [link(1)] }));
  assert.deepEqual(merged.links, [link(1)]);
});

test("links / surfaceForms が未定義の復元データでも落ちない", () => {
  const merged = mergeDuplicateCards(
    { cardId: "k1", term: "AB" },
    { cardId: "k2", term: "AB" },
  );
  assert.deepEqual(merged.surfaceForms, []);
  assert.deepEqual(merged.links, []);
});

/**
 * 残す側に無いフィールドだけが消す側から埋まる。
 *
 * #24 以前に localStorage へ保存されたカードには `status` が無い、といった欠けが
 * ありうる。両方にあるものは必ず残す側が勝つ（勝ち負けが状況で入れ替わると、
 * 統合の結果が「どちらが先に登場したか」以外の要因で変わってしまう）。
 */
test("残す側に無いフィールドは消す側から埋める", () => {
  const merged = mergeDuplicateCards(
    { cardId: "k1", term: "AB", description: "残す側" },
    { cardId: "k2", term: "AB", description: "消す側", rarity: "rare" },
  );
  assert.equal(merged.description, "残す側");
  assert.equal(merged.rarity, "rare", "残す側に無い情報は捨てない");
});

test("引数のカードを書き換えない", () => {
  const keep = keepCard();
  const drop = dropCard();
  mergeDuplicateCards(keep, drop);
  assert.deepEqual(keep.surfaceForms, ["えーび"]);
  assert.deepEqual(drop.links, [link(2)]);
});
