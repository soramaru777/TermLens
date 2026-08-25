import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dominantSpeaker } from "../src/stt/deepgram.js";

interface DiarizeCase {
  id: string;
  words: Array<{ speaker?: number }>;
  /** JSON に undefined は書けないため null で表す。比較時に undefined へ写す。 */
  expect: number | null;
}

const cases: DiarizeCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/diarize-words.json", import.meta.url), "utf8"),
);

test("fixture は会話内容を含まない（speaker フィールドのみ）", () => {
  for (const c of cases) {
    for (const w of c.words) {
      assert.deepEqual(Object.keys(w).filter((k) => k !== "speaker"), []);
    }
  }
});

for (const c of cases) {
  test(`dominantSpeaker: ${c.id}`, () => {
    assert.equal(dominantSpeaker(c.words), c.expect ?? undefined);
  });
}

test("dominantSpeaker: words 自体が undefined なら undefined", () => {
  assert.equal(dominantSpeaker(undefined), undefined);
});
