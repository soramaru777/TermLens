import assert from "node:assert/strict";
import test from "node:test";
import { SplitIntegrity } from "../src/stt/integrity.js";
import { visibleChars } from "../src/stt/split.js";
import type { SplitDiag } from "../src/stt/types.js";
// **クライアント側の実装を直接読み込んで突き合わせる。** 「空白を除いた文字数」は
// サーバー（TS）とクライアント（JS）に1つずつあり、片方だけ直すと段階別の文字数が
// 意味を失う（同じ表の中で別の定義の数字が並ぶ）。言語境界をまたぐので実装は2つに
// なるが、一致はここで固定できる
import { visibleChars as clientVisibleChars, countTextChars } from "../public/diagnostics.js";

/**
 * STT テキスト完全性の累計（#52）。
 *
 * ここで固定するのは3つ。
 *
 * 1. **空白を除いた文字数の定義がサーバーとクライアントで同じ**であること
 * 2. 累計が素直に加算されること（特に「捨てた件数」が負にならないこと）
 */

/** 会話内容を持たない `SplitDiag`。省略したキーは「正常な素通し」の値になる。 */
function diag(over: Partial<SplitDiag> = {}): SplitDiag {
  return {
    rawChars: 10,
    rawVisible: 10,
    splitChars: 10,
    splitVisible: 10,
    segments: 1,
    events: 1,
    fallback: false,
    headDropped: false,
    ...over,
  };
}

// ---- 空白を除いた文字数 ----

/**
 * **判定に使うのは空白を除いた文字数**で、素の `length` ではない。
 *
 * `sliceFromTranscript()` の `.trim()` とフォールバックの `join("")` は、正常に動いていても
 * 素の文字数を減らす。素の数で段階を比べると、その正常な差と本物の欠落が混ざって読めない。
 */
test("空白を除いた文字数はサーバーとクライアントで同じ定義", () => {
  // 半角空白・全角空白・タブ・改行・連続空白。全角空白（U+3000）は日本語の transcript で
  // 実際に出うるので、`/\s/` が拾うことをここで確かめておく
  const samples = [
    "",
    "abc",
    "a b c",
    "あ　い",
    "\tあ\nい ",
    "  ",
    "AWS Lambda",
    "です。 はい、",
  ];
  for (const s of samples) {
    assert.equal(
      visibleChars(s),
      clientVisibleChars(s),
      `サーバーとクライアントで一致しない: ${JSON.stringify(s)}`,
    );
  }
  assert.equal(visibleChars("あ　い"), 2, "全角空白も空白として落とす");
  assert.equal(visibleChars("  "), 0);
});

test("countTextChars は文字列でない要素を数えない（復元データを丸める）", () => {
  // `finalLines` は localStorage から検証なしで復元される。数値や undefined が混ざっても
  // 例外にせず 0 として扱う（消費側で丸める規律）
  assert.deepEqual(countTextChars(["あ い", "うえ"]), { chars: 5, visible: 4 });
  assert.deepEqual(countTextChars([undefined, 42, null, "あ"]), { chars: 1, visible: 1 });
  assert.deepEqual(countTextChars([]), { chars: 0, visible: 0 });
  assert.deepEqual(countTextChars(undefined), { chars: 0, visible: 0 });
});

// ---- 累計 ----

test("初期状態は全ゼロ（キーの集合が、外へ出せる上限そのもの）", () => {
  assert.deepEqual(new SplitIntegrity().snapshot(), {
    finals: 0,
    splitFinals: 0,
    rawChars: 0,
    rawVisible: 0,
    splitChars: 0,
    splitVisible: 0,
    fallbacks: 0,
    droppedEvents: 0,
    headDrops: 0,
  });
});

test("final ごとに文字数と件数が加算される", () => {
  const i = new SplitIntegrity();
  i.add(diag({ rawChars: 12, rawVisible: 10, splitChars: 11, splitVisible: 10 }));
  i.add(diag({ rawChars: 8, rawVisible: 7, splitChars: 8, splitVisible: 7 }));
  const s = i.snapshot();
  assert.equal(s.finals, 2);
  assert.equal(s.rawChars, 20);
  assert.equal(s.rawVisible, 17);
  assert.equal(s.splitChars, 19);
  assert.equal(s.splitVisible, 17, "空白除く文字数は保存される＝欠落なし");
});

test("分割が起きた final だけを splitFinals に数える", () => {
  const i = new SplitIntegrity();
  i.add(diag({ segments: 1, events: 1 }));
  i.add(diag({ segments: 0, events: 1 })); // words を持たない素通し
  i.add(diag({ segments: 3, events: 3 }));
  const s = i.snapshot();
  assert.equal(s.finals, 3);
  assert.equal(s.splitFinals, 1);
});

test("捨てたセグメント数は負にならない（words なしの素通しで -1 を積まない）", () => {
  // `segments: 0` / `events: 1` は「words が来なかった final」。素直に引くと -1 になり、
  // 本当に捨てたぶんを打ち消して droppedEvents が実際より小さく出る
  const i = new SplitIntegrity();
  i.add(diag({ segments: 0, events: 1 }));
  i.add(diag({ segments: 3, events: 2, headDropped: true }));
  const s = i.snapshot();
  assert.equal(s.droppedEvents, 1);
  assert.equal(s.headDrops, 1);
});

test("フォールバックと頭落ちは別々に数える", () => {
  // フォールバックは「語間の空白が落ちる」だけで数文字の欠落にはならない。
  // 頭落ちは「発話の頭が丸ごと消える」。原因も対策も別なので同じ数字にしない
  const i = new SplitIntegrity();
  i.add(diag({ segments: 2, events: 2, fallback: true }));
  i.add(diag({ segments: 2, events: 1, headDropped: true }));
  const s = i.snapshot();
  assert.equal(s.fallbacks, 1);
  assert.equal(s.headDrops, 1);
  assert.equal(s.droppedEvents, 1);
});

test("snapshot は呼ぶたびに新しい値を返す（内部状態への参照を渡さない）", () => {
  const i = new SplitIntegrity();
  i.add(diag());
  const first = i.snapshot();
  i.add(diag());
  assert.equal(first.finals, 1, "取得済みの snapshot が後から書き換わっている");
  assert.equal(i.snapshot().finals, 2);
});


