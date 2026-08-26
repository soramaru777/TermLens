import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  MAX_UTTERANCE_CHARS,
  UTTERANCE_TIMEOUT_MS,
  UtteranceBuilder,
  type Utterance,
} from "../src/stt/utterance.js";
import type { TranscriptEvent } from "../src/stt/types.js";

/** final イベントのダミー。UtteranceBuilder が見るのは text / speaker / speechFinal だけ。 */
function fin(text: string, speaker?: number, speechFinal = false): TranscriptEvent {
  return { text, isFinal: true, speaker, speechFinal };
}

/** 組み立てた発話を配列に集めるヘルパー。 */
function collect(): { out: Utterance[]; builder: UtteranceBuilder } {
  const out: Utterance[] = [];
  return { out, builder: new UtteranceBuilder((u) => out.push(u)) };
}

// --- 確定契機1: speechFinal --------------------------------------------

test("speechFinal が立った final で発話が閉じる", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("今日は", 0));
  assert.deepEqual(out, [], "まだ閉じていない");
  builder.addFinal(fin("AWSの話です", 0, true));
  assert.deepEqual(out, [{ text: "今日はAWSの話です", speaker: 0 }]);
});

test("連結に区切り文字を入れない", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("これは", 0));
  builder.addFinal(fin("テストです。", 0, true));
  assert.equal(out[0].text, "これはテストです。");
});

test("閉じたあと次の発話を組み立て直せる", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("1つめ", 0, true));
  builder.addFinal(fin("2つめ", 1, true));
  assert.deepEqual(out, [
    { text: "1つめ", speaker: 0 },
    { text: "2つめ", speaker: 1 },
  ]);
});

// --- 確定契機2: UtteranceEnd -------------------------------------------

test("utteranceEnd() で発話が閉じる", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("うーん", 0));
  builder.utteranceEnd();
  assert.deepEqual(out, [{ text: "うーん", speaker: 0 }]);
});

test("バッファが空なら utteranceEnd() は何も発行しない", () => {
  const { out, builder } = collect();
  builder.utteranceEnd();
  builder.utteranceEnd();
  assert.deepEqual(out, [], "空の発話を送らない");
});

test("speechFinal で閉じた直後の utteranceEnd() は二重発行しない", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("はい", 0, true));
  builder.utteranceEnd();
  assert.equal(out.length, 1, "同じ発話が2回出ない");
});

// --- 確定契機3: タイムアウト -------------------------------------------

/**
 * AC「タイムアウト時にも発話が永久に未確定にならない」の担保。
 * speech_final は背景ノイズで来ないことが公式に明記されており、
 * UtteranceEnd も届かない状況は起こりうる。
 */
test("どのシグナルも来なければ UTTERANCE_TIMEOUT_MS で閉じる", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { out, builder } = collect();
    builder.addFinal(fin("えーと", 0));
    mock.timers.tick(UTTERANCE_TIMEOUT_MS - 1);
    assert.deepEqual(out, [], "期限前には閉じない");
    mock.timers.tick(1);
    assert.deepEqual(out, [{ text: "えーと", speaker: 0 }]);
  } finally {
    mock.timers.reset();
  }
});

test("final が続いている間はタイムアウトが延びる", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { out, builder } = collect();
    builder.addFinal(fin("あ", 0));
    mock.timers.tick(UTTERANCE_TIMEOUT_MS - 1);
    builder.addFinal(fin("い", 0));
    mock.timers.tick(UTTERANCE_TIMEOUT_MS - 1);
    assert.deepEqual(out, [], "最後の final から測り直す");
    mock.timers.tick(1);
    assert.deepEqual(out, [{ text: "あい", speaker: 0 }]);
  } finally {
    mock.timers.reset();
  }
});

test("文字数閾値 / utteranceEnd で閉じたあともタイマーは残らない", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { out, builder } = collect();
    // utteranceEnd 経路
    builder.addFinal(fin("あ", 0));
    builder.utteranceEnd();
    // 文字数閾値の経路
    builder.addFinal(fin("い".repeat(MAX_UTTERANCE_CHARS), 0));
    mock.timers.tick(UTTERANCE_TIMEOUT_MS * 2);
    assert.equal(out.length, 2, "残ったタイマーが空の発話を発行したりしない");
  } finally {
    mock.timers.reset();
  }
});

test("speechFinal で閉じたあとタイマーは残らない", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { out, builder } = collect();
    builder.addFinal(fin("はい", 0, true));
    mock.timers.tick(UTTERANCE_TIMEOUT_MS * 2);
    assert.equal(out.length, 1, "タイマーが発火して空の発話を出したりしない");
  } finally {
    mock.timers.reset();
  }
});

// --- 確定契機4: 文字数上限 ---------------------------------------------

test("MAX_UTTERANCE_CHARS を超えたら終端シグナルを待たずに閉じる", () => {
  const { out, builder } = collect();
  const chunk = "あ".repeat(100);
  for (let i = 0; i < MAX_UTTERANCE_CHARS / 100; i += 1) builder.addFinal(fin(chunk, 0));
  assert.equal(out.length, 1, "上限で閉じる");
  assert.equal(out[0].text.length, MAX_UTTERANCE_CHARS);
});

// --- 話者交代 -----------------------------------------------------------

/** AC「speaker 交代をまたいで結合しない」の担保。 */
test("話者が変わったら足す前に閉じる", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("えーと", 0));
  builder.addFinal(fin("はい", 1, true));
  assert.deepEqual(out, [
    { text: "えーと", speaker: 0 },
    { text: "はい", speaker: 1 },
  ]);
});

test("1語の相槌でも独立した発話として残る", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("そうですね、それで", 0));
  builder.addFinal(fin("はい", 1));
  builder.addFinal(fin("続けます", 0, true));
  assert.deepEqual(
    out.map((u) => u.text),
    ["そうですね、それで", "はい", "続けます"],
  );
});

/**
 * `split.ts` の `splitBySpeaker()` と同じ規則。同じ「話者不明」に対して隣接する2層が
 * 逆の規則を持つと、diarize が一時的に speaker を返さない final が1件挟まるだけで
 * 同一話者の発話が3つに割れる。
 */
test("speaker が undefined のイベントは境界を作らず吸収される", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("これは", 0));
  builder.addFinal(fin("不明でも", undefined));
  builder.addFinal(fin("同じ発話", 0, true));
  assert.deepEqual(out, [{ text: "これは不明でも同じ発話", speaker: 0 }], "1発話のまま");
});

test("先頭が undefined でも、最初に現れた定義済み speaker を採用する", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("不明から", undefined));
  builder.addFinal(fin("始まる", 0, true));
  assert.deepEqual(out, [{ text: "不明から始まる", speaker: 0 }]);
});

test("全イベントが undefined なら発話の speaker も undefined", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("ぜんぶ", undefined));
  builder.addFinal(fin("不明", undefined));
  builder.flush();
  assert.deepEqual(out, [{ text: "ぜんぶ不明", speaker: undefined }]);
});

test("undefined を挟んでも定義済み話者の交代では分かれる", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("話者0", 0));
  builder.addFinal(fin("不明", undefined));
  builder.addFinal(fin("話者1", 1, true));
  assert.deepEqual(out, [
    { text: "話者0不明", speaker: 0 },
    { text: "話者1", speaker: 1 },
  ], "undefined は直前側に吸収され、境界は定義済み話者の変化で決まる");
});

test("speaker 0 は falsy でも話者として扱う（undefined と混ざらない）", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("ゼロ", 0));
  builder.addFinal(fin("つづき", 0, true));
  assert.deepEqual(out, [{ text: "ゼロつづき", speaker: 0 }], "同一話者なので1発話");
});

// --- flush / stop -------------------------------------------------------

test("flush() で残りを最後の発話として出す", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("途中まで", 0));
  builder.flush();
  assert.deepEqual(out, [{ text: "途中まで", speaker: 0 }]);
});

test("flush() はバッファが空なら何も出さない", () => {
  const { out, builder } = collect();
  builder.flush();
  assert.deepEqual(out, []);
});

test("stop() 後は何も受け付けず、溜まっていたぶんも捨てる", () => {
  const { out, builder } = collect();
  builder.addFinal(fin("捨てられる", 0));
  builder.stop();
  builder.addFinal(fin("無視される", 0, true));
  builder.utteranceEnd();
  assert.deepEqual(out, [], "異常終了では発話を出さない");
});

test("stop() はタイマーを止める", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { out, builder } = collect();
    builder.addFinal(fin("あ", 0));
    builder.stop();
    mock.timers.tick(UTTERANCE_TIMEOUT_MS * 2);
    assert.deepEqual(out, [], "停止後にタイマーが発火しない");
  } finally {
    mock.timers.reset();
  }
});
