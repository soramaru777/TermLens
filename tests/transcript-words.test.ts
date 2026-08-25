import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dominantSpeaker, toTranscriptWords, type DeepgramWord } from "../src/stt/deepgram.js";

interface WordsCase {
  id: string;
  words: DeepgramWord[];
  /** JSON に undefined は書けないため null で表す。比較時に undefined へ写す。 */
  expect: number | null;
}

const cases: WordsCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/deepgram-words.json", import.meta.url), "utf8"),
);

/** fixture の word に書いてよいキー。ここに無いキーがあれば実会議由来の混入を疑う。 */
const ALLOWED_WORD_KEYS = ["word", "punctuated_word", "start", "end", "confidence", "speaker"];

test("fixture は会話内容を含まない（word はダミー文字列・未知のキーが無い）", () => {
  for (const c of cases) {
    for (const w of c.words) {
      const rec = w as unknown as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(rec).filter((k) => !ALLOWED_WORD_KEYS.includes(k)),
        [],
        `${c.id}: 許可していないキーがある`,
      );
      assert.match(w.word, /^w\d+$/, `${c.id}: ${w.word} がダミー形式でない`);
      if (w.punctuated_word !== undefined) {
        // 句読点が1つ付くだけのダミー。実会議の語（例: 「クバネテスの」）を書けないようにする
        assert.match(
          w.punctuated_word,
          /^w\d+[.,?!]?$/,
          `${c.id}: ${w.punctuated_word} がダミー形式でない`,
        );
      }
    }
  }
});

for (const c of cases) {
  test(`toTranscriptWords: 全フィールドを写す — ${c.id}`, () => {
    const got = toTranscriptWords(c.words);
    assert.ok(got, "undefined ではないこと");
    assert.equal(got.length, c.words.length);
    for (const [i, w] of c.words.entries()) {
      assert.deepEqual(got[i], {
        word: w.word,
        // スネークケース → キャメルケース。無いときは undefined のまま通す
        punctuatedWord: w.punctuated_word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
        speaker: w.speaker,
      });
    }
  });
}

test("toTranscriptWords: punctuated_word が無ければ punctuatedWord は undefined", () => {
  const got = toTranscriptWords([{ word: "w1", start: 0, end: 0.5, confidence: 0.9 }]);
  assert.equal(got?.[0].punctuatedWord, undefined);
});

test("toTranscriptWords: speaker が無ければ undefined のまま（0 に潰さない）", () => {
  const got = toTranscriptWords([{ word: "w1", start: 0, end: 0.5, confidence: 0.9 }]);
  assert.equal(got?.[0].speaker, undefined);
});

test("toTranscriptWords: speaker 0 は保持する（falsy で落とさない）", () => {
  const got = toTranscriptWords([{ word: "w1", start: 0, end: 0.5, confidence: 0.9, speaker: 0 }]);
  assert.equal(got?.[0].speaker, 0);
});

test("toTranscriptWords: 空配列なら undefined", () => {
  assert.equal(toTranscriptWords([]), undefined);
});

test("toTranscriptWords: undefined なら undefined", () => {
  assert.equal(toTranscriptWords(undefined), undefined);
});

test("toTranscriptWords: 入力を書き換えない", () => {
  const input: DeepgramWord[] = [
    { word: "w1", punctuated_word: "w1,", start: 0, end: 0.5, confidence: 0.9, speaker: 1 },
  ];
  const snapshot = structuredClone(input);
  toTranscriptWords(input);
  assert.deepEqual(input, snapshot);
});

/**
 * AC「既存のinterim/final表示を壊さない」の担保。
 * words を保持するようになっても、話者番号の決め方（多数決）は一切変わっていないこと。
 * 全フィールドを持つ words と、speaker だけを抜き出した words で結果が一致することを見る。
 */
for (const c of cases) {
  test(`dominantSpeaker: words を保持しても結果が変わらない — ${c.id}`, () => {
    const speakerOnly = c.words.map((w) => ({ speaker: w.speaker }));
    assert.equal(dominantSpeaker(c.words), c.expect ?? undefined);
    assert.equal(dominantSpeaker(speakerOnly), c.expect ?? undefined);
  });
}
