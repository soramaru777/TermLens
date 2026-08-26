import assert from "node:assert/strict";
import test from "node:test";
import { ContextWindow, MAX_CONTEXT_CHARS } from "../src/extract/context.js";

/** 長さを指定して作る目印つきの文字列。先頭の1文字でどのチャンクか分かるようにする。 */
function chunk(mark: string, length: number): string {
  return mark + "あ".repeat(length - 1);
}

test("上限内なら押した順に \" \" で連結する", () => {
  const w = new ContextWindow(100);
  w.push("あいうえお");
  w.push("かきくけこ");
  assert.equal(w.text(), "あいうえお かきくけこ");
});

test("上限を超えたら古いチャンクから丸ごと捨てる", () => {
  // 設計コメントの例: 800 → +500(1,301字) → +600 で A を捨てて 1,101 字
  const w = new ContextWindow(1_500);
  w.push(chunk("A", 800));
  assert.equal(w.text().length, 800);
  w.push(chunk("B", 500));
  assert.equal(w.text().length, 1_301, "区切りの \" \" も長さに数える");
  w.push(chunk("C", 600));
  assert.equal(w.text().length, 1_101);
  assert.ok(!w.text().includes("A"), "最古の A が丸ごと消えている");
  assert.ok(w.text().startsWith("B"), "B は途中で切られず残る");
});

test("必要なだけ古い方から捨てる（1件では足りない場合）", () => {
  const w = new ContextWindow(10);
  w.push("あああ");
  w.push("いいい");
  w.push("う".repeat(9));
  assert.equal(w.text(), "う".repeat(9), "A も B も落ちる");
});

test("1チャンク単独で上限を超えるときだけ頭を削る", () => {
  const w = new ContextWindow(1_500);
  const long = chunk("D", 2_000);
  w.push(long);
  assert.equal(w.text().length, 1_500);
  assert.equal(w.text(), long.slice(-1_500), "末尾＝直近を残す");
});

test("古いチャンクを捨てても超えるなら、残った1件の頭を削る", () => {
  const w = new ContextWindow(10);
  w.push("あああ");
  w.push("い".repeat(12));
  assert.equal(w.text(), "い".repeat(10), "残った1件だけを末尾10字に詰める");
});

test("空文字は無視する（区切りだけが増えない）", () => {
  const w = new ContextWindow(100);
  w.push("");
  assert.equal(w.text(), "");
  w.push("あいう");
  w.push("");
  assert.equal(w.text(), "あいう");
});

test("clear() で空になる", () => {
  const w = new ContextWindow(100);
  w.push("あいう");
  w.clear();
  assert.equal(w.text(), "");
  w.push("かきく");
  assert.equal(w.text(), "かきく", "clear 後も使い続けられる");
});

test("既定の上限は MAX_CONTEXT_CHARS", () => {
  const w = new ContextWindow();
  w.push("あ".repeat(MAX_CONTEXT_CHARS + 500));
  assert.equal(w.text().length, MAX_CONTEXT_CHARS);
});

test("上限ちょうどは保持し、区切り1文字ぶんで超えたら捨てる", () => {
  // 予算計算が区切りの \" \" を数えているかは、この2ケースの差でしか出ない。
  // 数えない実装だと下の b が両方残ってしまう。
  const a = new ContextWindow(10);
  a.push("あ".repeat(5));
  a.push("い".repeat(4));
  assert.equal(a.text(), "あああああ いいいい", "区切り込みでちょうど10字なら残す");

  const b = new ContextWindow(10);
  b.push("あ".repeat(5));
  b.push("い".repeat(5));
  assert.equal(b.text(), "いいいいい", "本文10字＋区切り1字で超える → 古い方を捨てる");
});
