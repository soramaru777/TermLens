import assert from "node:assert/strict";
import test from "node:test";
import { TermCaseSchema, type TermCase } from "../src/eval/cases.js";
import { aggregate, scoreCase, type EvaluatedCard } from "../src/eval/metrics.js";
import type { TermStatus } from "../src/protocol.js";

/**
 * 指標の集計そのものを LLM 抜きで検証する。
 * ここが狂うと案B の数字が信用できなくなるので、決定的テストの側で押さえておく。
 */
function makeCase(overrides: Partial<TermCase> & { id: string; transcript: string }): TermCase {
  return TermCaseSchema.parse(overrides);
}

function card(
  term: string,
  correctedFrom: string | null = null,
  status: TermStatus = "confirmed",
  surfaceForms: string[] = [],
): EvaluatedCard {
  return { term, correctedFrom, status, surfaceForms };
}

const base = makeCase({
  id: "sample",
  transcript: "クバネテスのポッドが再起動しています。",
  expectTerms: ["Kubernetes", "Pod"],
  expectCorrection: { クバネテス: "Kubernetes" },
  forbidTerms: ["クーベルタン"],
  allowLowConfidence: ["ポッド"],
});

test("Recall: 期待用語が全部出れば 1、半分なら 0.5", () => {
  assert.equal(aggregate([scoreCase(base, [card("Kubernetes"), card("Pod")])]).recall, 1);
  assert.equal(aggregate([scoreCase(base, [card("Kubernetes")])]).recall, 0.5);
  assert.equal(aggregate([scoreCase(base, [])]).recall, 0);
});

test("Recall: 突き合わせは normalizeTerm を通す（全角・大文字小文字・空白を吸収）", () => {
  const score = scoreCase(base, [card("ＫＵＢＥＲＮＥＴＥＳ"), card("p o d")]);
  assert.equal(score.recallHit, 2);
  assert.deepEqual(score.missing, []);
});

test("正しい補正率: correctedFrom と term の両方が一致して初めて加点", () => {
  assert.equal(aggregate([scoreCase(base, [card("Kubernetes", "クバネテス")])]).correction, 1);
  // term は正しいが correctedFrom が無い → 補正としては数えない
  assert.equal(aggregate([scoreCase(base, [card("Kubernetes")])]).correction, 0);
});

test("誤補正率: 禁止語が出たケース", () => {
  const score = scoreCase(base, [card("クーベルタン", "クバネテス")]);
  assert.equal(score.miscorrected, true);
  assert.equal(aggregate([score]).miscorrection, 1);
});

test("誤補正率: 誤表記から別の用語に着地したケース", () => {
  const score = scoreCase(base, [card("Kubeflow", "クバネテス")]);
  assert.equal(score.miscorrected, true);
  assert.ok(score.miscorrections[0]?.includes("Kubeflow"));
});

test("誤補正率: ケース数ぶんの平均になる", () => {
  const clean = scoreCase(base, [card("Kubernetes", "クバネテス"), card("Pod")]);
  const dirty = scoreCase(base, [card("クーベルタン")]);
  assert.equal(aggregate([clean, clean, clean, dirty]).miscorrection, 0.25);
  assert.equal(aggregate([clean, clean]).miscorrection, 0);
});

test("probable 率: カードは出たが status が probable のもの ÷ expectTerms 総数", () => {
  const score = scoreCase(base, [card("Kubernetes", "クバネテス", "probable"), card("Pod")]);
  assert.equal(aggregate([score]).probable, 0.5);
  assert.equal(aggregate([score]).unresolved, 0, "probable は unresolved 列に混ぜない");
  assert.equal(aggregate([score]).recall, 1, "probable でも Recall には数える");
});

test("unresolved 率: probable とは別の列に数える（#24）", () => {
  // **2列に分けたことがこのテストの本題。** 合算していると「補正はしたが自信がない」と
  // 「そもそも特定できない」が混ざり、過剰 unresolved（何でも諦める退行）に気づけない。
  const score = scoreCase(base, [
    card("Kubernetes", "クバネテス", "unresolved"),
    card("Pod", null, "probable"),
  ]);
  const metrics = aggregate([score]);
  assert.equal(metrics.unresolved, 0.5);
  assert.equal(metrics.probable, 0.5);
  assert.equal(metrics.recall, 1, "unresolved でもカードは出ているので Recall には数える");
});

test("confirmed はどちらの列にも数えない", () => {
  const metrics = aggregate([scoreCase(base, [card("Kubernetes", "クバネテス"), card("Pod")])]);
  assert.equal(metrics.probable, 0);
  assert.equal(metrics.unresolved, 0);
});

test("Precision: expectTerms ∪ allowLowConfidence に含まれるカードの割合", () => {
  const score = scoreCase(base, [card("Kubernetes"), card("ポッド"), card("再起動")]);
  assert.equal(aggregate([score]).precision, 2 / 3);
  assert.deepEqual(score.extra, ["再起動"]);
});

test("Precision: 同じ用語のカードが2枚出ても1件として数える（Recall 側と同じ dedupe）", () => {
  // dedupe しないと分子・分母が両方 +1 され、重複そのものが精度に一切出なくなる。
  const dup = scoreCase(base, [card("Kubernetes"), card("ＫＵＢＥＲＮＥＴＥＳ"), card("再起動")]);
  assert.equal(dup.precisionTotal, 2, "正規化キーで畳んだ枚数を分母にする");
  assert.equal(dup.precisionHit, 1);
  assert.equal(aggregate([dup]).precision, 0.5);
  assert.deepEqual(dup.extra, ["再起動"]);

  // 想定外カードの重複も1件（レポートに同じ語が並ばない）
  const dupExtra = scoreCase(base, [card("Kubernetes"), card("再起動"), card("再 起 動")]);
  assert.deepEqual(dupExtra.extra, ["再起動"]);
  assert.equal(dupExtra.precisionTotal, 2);
});

test("期待が空のケース: Recall/補正は減点せず、Precision と禁止語だけを見る", () => {
  const noExpect = makeCase({
    id: "plain",
    transcript: "来週の水曜日に打ち合わせを行います。",
    forbidTerms: ["打ち合わせ"],
  });
  const empty = aggregate([scoreCase(noExpect, [])]);
  assert.equal(empty.recall, 1);
  assert.equal(empty.correction, 1);
  assert.equal(empty.probable, 0);
  assert.equal(empty.unresolved, 0);
  assert.equal(empty.miscorrection, 0);

  const noisy = aggregate([scoreCase(noExpect, [card("打ち合わせ")])]);
  assert.equal(noisy.miscorrection, 1);
  assert.equal(noisy.precision, 0);
});

test("集計は分子分母の合算（ケース平均の平均にしない）", () => {
  const many = makeCase({ id: "many", transcript: "x", expectTerms: ["A", "B", "C", "D"] });
  const one = makeCase({ id: "one", transcript: "x", expectTerms: ["Z"] });
  const metrics = aggregate([
    scoreCase(many, [card("A"), card("B"), card("C"), card("D")]),
    scoreCase(one, []),
  ]);
  assert.equal(metrics.recall, 4 / 5);
});

/**
 * 「特定できない」が正解のケース(#24)。
 *
 * `expectTerms` は「出てほしい用語」の集合なので、特定できないのが正解のケースは
 * 分母にも分子にも入らず、**追加した fixture が unresolved 率をまったく動かせなかった**
 * （レビュー指摘）。聞き取られた表記を別の分母として持つ。
 */
test("expectUnresolved: 狙いどおり unresolved になれば当たり", () => {
  const c = makeCase({
    id: "u1",
    transcript: "グラファトスを入れましょう。",
    expectUnresolved: ["グラファトス"],
  });
  const hit = scoreCase(c, [card("Grafana", "グラファトス", "unresolved")]);
  assert.equal(hit.unresolvedHit, 1);
  assert.equal(hit.unresolvedTotal, 1);
  assert.deepEqual(hit.unresolvedMiss, []);
});

test("expectUnresolved: surfaceForms 経由でも突き合わせる", () => {
  const c = makeCase({
    id: "u2",
    transcript: "グラファトスを入れましょう。",
    expectUnresolved: ["グラファトス"],
  });
  // 補正を試みなかった（correctedFrom が null）ケース
  const s = scoreCase(c, [card("グラファトス", null, "unresolved", ["グラファトス"])]);
  assert.equal(s.unresolvedHit, 1);
});

test("expectUnresolved: 断定してしまったら外れ。内訳に何に断定したかを残す", () => {
  const c = makeCase({
    id: "u3",
    transcript: "グラファトスを入れましょう。",
    expectUnresolved: ["グラファトス"],
  });
  const miss = scoreCase(c, [card("Grafana", "グラファトス", "confirmed")]);
  assert.equal(miss.unresolvedHit, 0);
  assert.equal(miss.unresolvedMiss.length, 1);
  assert.ok(miss.unresolvedMiss[0]!.includes("Grafana"), "何に断定したかが分かること");
});

/**
 * unresolved のカードは誤補正に数えない(#24)。
 *
 * 降格したカードは term を画面に出さない（見出しは聞き取られた表記）ので、利用者から
 * 見て「その用語に補正した」とは言えない。ここを見ないと Stage 2 が正しく棄却しても
 * 誤補正として数え続け、**この機能の効果が指標に一切現れない**。
 */
test("unresolved のカードは forbidTerms に当たっても誤補正にしない", () => {
  const c = makeCase({
    id: "m1",
    transcript: "クドラントを使います。",
    forbidTerms: ["Qdrant"],
  });
  const dropped = scoreCase(c, [card("Qdrant", "クドラント", "unresolved")]);
  assert.equal(dropped.miscorrected, false, "画面に Qdrant は出ていない");

  const shown = scoreCase(c, [card("Qdrant", "クドラント", "confirmed")]);
  assert.equal(shown.miscorrected, true, "断定して表示したなら誤補正のまま");
});

test("unresolved のカードは expectCorrection の取り違えにも数えない", () => {
  const c = makeCase({
    id: "m2",
    transcript: "クドラントを使います。",
    expectCorrection: { クドラント: "Qdrant" },
  });
  const dropped = scoreCase(c, [card("Quadrant", "クドラント", "unresolved")]);
  assert.equal(dropped.correctionHit, 0, "正しい補正でもない");
  assert.equal(dropped.miscorrected, false, "だが誤補正でもない（表示していないため）");
});

// --- 再評価の指標（#40） --------------------------------------------------

/**
 * **unresolved 率だけを下げることを成功条件にしない。**
 *
 * 誤って何でも確定すれば unresolved 率は下がるので、昇格の数と**そのうち間違って
 * いた数**を必ず対にして数える。再評価由来の誤補正を全体の `miscorrection` に
 * 混ぜないのは、抽出段の誤補正に埋もれて見えなくなるため。
 */
const rematchCase = makeCase({
  id: "rematch",
  transcript: "えーびの話をしています。",
  expectRematch: [{ from: "えーび", to: "AB" }],
});

test("再評価: 期待どおりの改名は正しい補正に数える", () => {
  const score = scoreCase(rematchCase, [card("AB", "えーび")], 0, {
    attempts: 1,
    renames: [{ from: "えーび", to: "AB" }],
  });
  assert.equal(score.rematchPromoted, 1);
  assert.equal(score.rematchCorrect, 1);
  assert.equal(score.rematchMiscorrected, 0);
  const metrics = aggregate([score]);
  assert.equal(metrics.rematchPromotion, 1);
  assert.equal(metrics.rematchMiscorrection, 0);
});

test("再評価: 期待と違う用語に着地したら誤補正に数える", () => {
  const score = scoreCase(rematchCase, [card("ABC", "えーび")], 0, {
    attempts: 1,
    renames: [{ from: "えーび", to: "ABC" }],
  });
  assert.equal(score.rematchCorrect, 0);
  assert.equal(score.rematchMiscorrected, 1);
  assert.equal(aggregate([score]).rematchMiscorrection, 1);
});

/**
 * **`from` と `to` の両方を見る。** `to` だけを見ると、別の未解決語がたまたま期待した
 * 用語に着地した場合まで加点され、誤補正率が過小に出る（`expectCorrection` の採点が
 * correctedFrom と term の両方を見るのと同じ理由）。
 */
test("再評価: 別の表記から期待どおりの用語に着地しても正解にしない", () => {
  const score = scoreCase(rematchCase, [card("AB", "しーでぃ")], 0, {
    attempts: 1,
    renames: [{ from: "しーでぃ", to: "AB" }],
  });
  assert.equal(score.rematchCorrect, 0, "from が違えば別の話");
  assert.equal(score.rematchMiscorrected, 1);
});

test("再評価: 突き合わせは normalizeTerm を通す", () => {
  const score = scoreCase(rematchCase, [card("AB")], 0, {
    attempts: 1,
    renames: [{ from: "えーび", to: "ａｂ" }],
  });
  assert.equal(score.rematchCorrect, 1, "全角・大文字小文字の違いで取りこぼさない");
});

test("再評価: 試みたが昇格しなかった場合", () => {
  const score = scoreCase(rematchCase, [card("エービ", "えーび", "unresolved")], 0, {
    attempts: 2,
    renames: [],
  });
  assert.equal(score.rematchAttempts, 2);
  assert.equal(score.rematchPromoted, 0);
  const metrics = aggregate([score]);
  assert.equal(metrics.rematchPromotion, 0, "昇格していないので 0");
  assert.equal(metrics.rematchMiscorrection, 0, "昇格が無ければ誤補正も無い");
});

/**
 * **再評価が一度も走らなかったランを「昇格率 100%」にしない。**
 *
 * `ratio()` の「分母 0 は減点しない＝1」をそのまま使うと、機能が発火していない
 * ことが満点として表示される。閾値を決めるための計測でこれをやると判断を誤る。
 */
test("再評価: 一度も走らなければ両方 0", () => {
  const metrics = aggregate([scoreCase(base, [card("Kubernetes"), card("Pod")])]);
  assert.equal(metrics.rematchPromotion, 0, "発火していないランを満点にしない");
  assert.equal(metrics.rematchMiscorrection, 0);
});

test("再評価: 集計は分子分母の合算（ケース平均の平均にしない）", () => {
  const good = scoreCase(rematchCase, [card("AB")], 0, {
    attempts: 1,
    renames: [{ from: "えーび", to: "AB" }],
  });
  const bad = scoreCase(rematchCase, [card("ABC")], 1, {
    attempts: 3,
    renames: [{ from: "えーび", to: "ABC" }],
  });
  const metrics = aggregate([good, bad]);
  assert.equal(metrics.rematchPromotion, 2 / 4);
  assert.equal(metrics.rematchMiscorrection, 1 / 2);
});
