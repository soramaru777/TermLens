import assert from "node:assert/strict";
import test from "node:test";
import { TermCaseSchema, type TermCase } from "../src/eval/cases.js";
import { aggregate, scoreCase, type EvaluatedCard } from "../src/eval/metrics.js";

/**
 * 指標の集計そのものを LLM 抜きで検証する。
 * ここが狂うと案B の数字が信用できなくなるので、決定的テストの側で押さえておく。
 */
function makeCase(overrides: Partial<TermCase> & { id: string; transcript: string }): TermCase {
  return TermCaseSchema.parse(overrides);
}

function card(term: string, correctedFrom: string | null = null, confidence: "high" | "low" = "high"): EvaluatedCard {
  return { term, correctedFrom, confidence };
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

test("unresolved 率: カードは出たが confidence が low のもの ÷ expectTerms 総数", () => {
  const score = scoreCase(base, [card("Kubernetes", "クバネテス", "low"), card("Pod")]);
  assert.equal(aggregate([score]).unresolved, 0.5);
  assert.equal(aggregate([score]).recall, 1, "low でも Recall には数える");
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
