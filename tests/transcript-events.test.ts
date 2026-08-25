import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptEvents, type DeepgramAlternative } from "../src/stt/deepgram.js";

/**
 * Deepgram の alternatives[0] 相当のダミー。表記は w0, w1, ... で会話内容を持たない。
 * `speakers` の null は「diarize が speaker を付けなかった語」を表す。
 */
function altFrom(transcript: string, speakers?: Array<number | null>): DeepgramAlternative {
  return {
    transcript,
    words: speakers?.map((s, i) => ({
      word: `w${i}`,
      punctuated_word: `w${i}`,
      start: i * 0.5,
      end: (i + 1) * 0.5,
      confidence: 0.9,
      speaker: s ?? undefined,
    })),
  };
}

test("buildTranscriptEvents: text が空なら何も返さない", () => {
  assert.deepEqual(buildTranscriptEvents(altFrom("", [0, 1]), true), []);
  assert.deepEqual(buildTranscriptEvents(altFrom(""), false), []);
  assert.deepEqual(buildTranscriptEvents(undefined, true), []);
  assert.deepEqual(buildTranscriptEvents({}, true), []);
});

/**
 * AC「単一話者ケースで既存挙動を退行させない」の担保。
 * words から組み直さず、Deepgram の transcript が1文字も変わらずに出ること。
 */
test("buildTranscriptEvents: 単一話者の final は transcript を素通しする", () => {
  const text = "これは、Deepgram が組み立てた文字列です。";
  const events = buildTranscriptEvents(altFrom(text, [0, 0, 0]), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, text);
  assert.equal(events[0].speaker, 0);
  assert.equal(events[0].isFinal, true);
  assert.equal(events[0].words?.length, 3);
});

test("buildTranscriptEvents: words が無い final も transcript を素通しする", () => {
  const events = buildTranscriptEvents(altFrom("words なし"), true);
  assert.deepEqual(events, [
    { text: "words なし", isFinal: true, speaker: undefined, words: undefined },
  ]);
});

test("buildTranscriptEvents: 全語 speaker 不明でも1件のまま（speaker は undefined）", () => {
  const events = buildTranscriptEvents(altFrom("不明だけ", [null, null]), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].speaker, undefined);
});

test("buildTranscriptEvents: 話者が変わる final は件数ぶんに分かれる", () => {
  const events = buildTranscriptEvents(altFrom("w0w1w2", [0, 0, 1]), true);
  assert.deepEqual(
    events.map((e) => ({ text: e.text, speaker: e.speaker, isFinal: e.isFinal })),
    [
      { text: "w0w1", speaker: 0, isFinal: true },
      { text: "w2", speaker: 1, isFinal: true },
    ],
  );
  // 各イベントには自分のセグメントの words だけが載る
  assert.deepEqual(
    events.map((e) => e.words?.map((w) => w.word)),
    [["w0", "w1"], ["w2"]],
  );
});

/**
 * interim を分割すると、上書きで表示する `public/app.js` の interim 表示ハンドラで
 * 前半の話者ぶんが消える。speaker は interim では読まれていないため undefined でよい。
 */
test("buildTranscriptEvents: interim は分割せず speaker は undefined", () => {
  const text = "途中まで";
  const events = buildTranscriptEvents(altFrom(text, [0, 0, 1, 1]), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, text);
  assert.equal(events[0].isFinal, false);
  assert.equal(events[0].speaker, undefined);
  // words は従来どおり載せる（サーバー内部で使う）
  assert.equal(events[0].words?.length, 4);
});
