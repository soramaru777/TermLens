import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { MOCK_SCRIPT } from "../src/stt/mock-script.js";
import {
  MOCK_CHARS_PER_SECOND,
  MOCK_CONFIDENCE,
  MOCK_INTERIM_STEPS,
  MOCK_LINE_CYCLE_MS,
  MOCK_LINE_GAP_SEC,
  MOCK_MISHEARD_CONFIDENCE,
  MOCK_MISHEARD_WORDS,
  MockSttAdapter,
  buildMockWords,
  mockSurface,
  sliceMockWords,
} from "../src/stt/mock.js";
import type { TranscriptEvent, TranscriptWord } from "../src/stt/types.js";

/** 「誤認識を模した語」と「通常の語」を分ける閾値。テストの判定に使う。 */
const LOW_CONFIDENCE_THRESHOLD = 0.8;

test("閾値は誤認識語と通常語の間にある", () => {
  assert.ok(MOCK_MISHEARD_CONFIDENCE < LOW_CONFIDENCE_THRESHOLD);
  assert.ok(MOCK_CONFIDENCE >= LOW_CONFIDENCE_THRESHOLD);
});

// --- MOCK_SCRIPT の不変条件 ---------------------------------------------

for (const [i, line] of MOCK_SCRIPT.entries()) {
  test(`MOCK_SCRIPT[${i}]: punctuated ?? word を連結すると text と一致する`, () => {
    assert.equal(line.words.map((w) => w.punctuated ?? w.word).join(""), line.text);
  });
}

test("MOCK_SCRIPT: 空文字の word が無い（start === end になるため）", () => {
  for (const [i, line] of MOCK_SCRIPT.entries()) {
    for (const w of line.words) {
      assert.ok(w.word.length > 0, `MOCK_SCRIPT[${i}] に空文字の word がある`);
    }
  }
});

test("MOCK_SCRIPT: 句読点は独立 word にせず punctuated に付ける", () => {
  for (const [i, line] of MOCK_SCRIPT.entries()) {
    for (const w of line.words) {
      // 素の表記に句読点が混ざっていたら、実 Deepgram の word とセマンティクスがズレる
      assert.doesNotMatch(w.word, /[、。]/, `MOCK_SCRIPT[${i}]: ${w.word} が句読点を含んでいる`);
      if (w.punctuated === undefined) continue;
      assert.ok(
        w.punctuated.startsWith(w.word),
        `MOCK_SCRIPT[${i}]: ${w.punctuated} が ${w.word} で始まっていない`,
      );
      assert.notEqual(
        w.punctuated,
        w.word,
        `MOCK_SCRIPT[${i}]: ${w.word} の punctuated が word と同じ（省略すべき）`,
      );
      assert.match(
        w.punctuated.slice(w.word.length),
        /^[、。]$/,
        `MOCK_SCRIPT[${i}]: ${w.punctuated} の付加部分が句読点でない`,
      );
    }
  }
});

/**
 * `MOCK_MISHEARD_WORDS` が `term-cases.json` から drift しないよう、両方向で固定する。
 * 「全要素がスクリプトに現れる」だけだと、term-cases に誤認識ケースを足して
 * MOCK_SCRIPT にも語を足したのに MOCK_MISHEARD_WORDS への追加を忘れた場合を検出できない。
 */
test("MOCK_MISHEARD_WORDS は term-cases.json の expectCorrection ∩ MOCK_SCRIPT と一致する", () => {
  interface TermCase {
    expectCorrection: Record<string, string>;
  }
  const termCases: TermCase[] = JSON.parse(
    readFileSync(new URL("./fixtures/term-cases.json", import.meta.url), "utf8"),
  );
  const scriptWords = new Set(MOCK_SCRIPT.flatMap((l) => l.words.map((w) => w.word)));
  const expected = new Set(
    termCases
      .flatMap((c) => Object.keys(c.expectCorrection))
      .filter((w) => scriptWords.has(w)),
  );
  assert.ok(expected.size > 0, "term-cases.json と MOCK_SCRIPT に共通の誤認識語が無い");
  assert.deepEqual([...MOCK_MISHEARD_WORDS].sort(), [...expected].sort());
});

// --- buildMockWords -----------------------------------------------------

/** words 列に共通して成り立つべき性質。final でも interim でも同じ。 */
function assertWordsConsistent(words: TranscriptWord[], text: string, speaker: number): void {
  assert.ok(words.length > 0, "words が空でない");
  assert.equal(words.map(mockSurface).join(""), text, "連結すると text と一致する");
  let prevEnd = words[0].start;
  for (const w of words) {
    assert.ok(w.start < w.end, `${w.word}: start(${w.start}) < end(${w.end})`);
    assert.equal(w.start, prevEnd, `${w.word}: 前の word の end から続いている`);
    assert.equal(w.speaker, speaker, `${w.word}: speaker が行の値と一致`);
    assert.ok(w.punctuatedWord !== undefined, `${w.word}: punctuatedWord が入っている`);
    assert.ok(
      w.punctuatedWord.startsWith(w.word),
      `${w.word}: punctuatedWord(${w.punctuatedWord}) が word で始まっている`,
    );
    prevEnd = w.end;
  }
}

for (const [i, line] of MOCK_SCRIPT.entries()) {
  test(`buildMockWords: MOCK_SCRIPT[${i}] の words が整合している`, () => {
    assertWordsConsistent(buildMockWords(line), line.text, line.speaker);
  });

  test(`buildMockWords: MOCK_SCRIPT[${i}] の confidence が誤認識語だけ低い`, () => {
    for (const w of buildMockWords(line)) {
      if (MOCK_MISHEARD_WORDS.has(w.word)) {
        assert.ok(w.confidence < LOW_CONFIDENCE_THRESHOLD, `${w.word} は低 confidence のはず`);
      } else {
        assert.ok(w.confidence >= LOW_CONFIDENCE_THRESHOLD, `${w.word} は通常 confidence のはず`);
      }
    }
  });
}

test("buildMockWords: 行全体の長さが 文字数 / 発話速度 と一致する", () => {
  for (const line of MOCK_SCRIPT) {
    const words = buildMockWords(line);
    const last = words[words.length - 1];
    assert.ok(
      Math.abs(last.end - line.text.length / MOCK_CHARS_PER_SECOND) < 0.01,
      `${line.text.slice(0, 8)}…: end=${last.end}`,
    );
  }
});

test("buildMockWords: baseSec を足すと行全体が平行移動する", () => {
  const base = 12.5;
  for (const line of MOCK_SCRIPT) {
    const zero = buildMockWords(line);
    const shifted = buildMockWords(line, base);
    assert.equal(shifted.length, zero.length);
    for (const [i, w] of shifted.entries()) {
      assert.ok(Math.abs(w.start - (zero[i].start + base)) < 0.001, `${w.word}: start`);
      assert.ok(Math.abs(w.end - (zero[i].end + base)) < 0.001, `${w.word}: end`);
    }
    // 行頭の word はきっかり baseSec から始まる（丸めで前後しない）
    assert.equal(shifted[0].start, base);
  }
});

/**
 * ⑦ の回帰テスト。1段目の interim は行の 1/4 の文字数で切るので、
 * 先頭 word が長い行を足すと空になりうる。空 interim は送ってはいけない。
 */
test("buildMockWords: 全行の1段目 interim が空にならない", () => {
  for (const [i, line] of MOCK_SCRIPT.entries()) {
    const len = Math.ceil(line.text.length / (MOCK_INTERIM_STEPS + 1));
    const partial = sliceMockWords(buildMockWords(line), len);
    assert.ok(
      partial.length > 0,
      `MOCK_SCRIPT[${i}]: 先頭 word が ${len} 文字を超えていて1段目 interim が空になる`,
    );
  }
});

// --- sliceMockWords（interim の切り出し）---------------------------------

test("sliceMockWords: 境界に跨る word は含めない", () => {
  const line = { text: "あいうえお", speaker: 0, words: [{ word: "あい" }, { word: "うえお" }] };
  const words = buildMockWords(line);
  // 「うえお」は 2〜5 文字目。4 文字までなら含めない
  assert.deepEqual(sliceMockWords(words, 4).map((w) => w.word), ["あい"]);
  assert.deepEqual(sliceMockWords(words, 5).map((w) => w.word), ["あい", "うえお"]);
});

test("sliceMockWords: 句読点つきの長さで数える", () => {
  const line = { text: "あい、うえお", speaker: 0, words: [{ word: "あい", punctuated: "あい、" }, { word: "うえお" }] };
  const words = buildMockWords(line);
  // 「あい、」は3文字。2 文字では切り出せない
  assert.deepEqual(sliceMockWords(words, 2), []);
  assert.deepEqual(sliceMockWords(words, 3).map(mockSurface), ["あい、"]);
});

test("sliceMockWords: 0 文字なら空", () => {
  const words = buildMockWords(MOCK_SCRIPT[0]);
  assert.deepEqual(sliceMockWords(words, 0), []);
});

test("sliceMockWords: 全文字ぶんなら元の words と同じ", () => {
  for (const line of MOCK_SCRIPT) {
    const words = buildMockWords(line);
    assert.deepEqual(sliceMockWords(words, line.text.length), words);
  }
});

// --- MockSttAdapter が実際に発行するイベント -----------------------------

/**
 * mock を偽タイマーでスクリプト一周ぶん再生し、発行された transcript を全部集める。
 * 実行時間を待たずに interim / final の実物を検証できる。
 *
 * 所要時間は `MOCK_SCRIPT.length` から算出する。固定値にすると
 * スクリプトを増やしたとき末尾の行が黙って未検証になる。
 */
function collectEvents(): TranscriptEvent[] {
  const durationMs = MOCK_SCRIPT.length * MOCK_LINE_CYCLE_MS;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const events: TranscriptEvent[] = [];
    const stt = new MockSttAdapter();
    stt.onTranscript((e) => events.push(e));
    void stt.start({ keywords: [] });
    // 入れ子の setTimeout（次の interim / 次の行）を辿るため、細かく刻んで進める
    for (let t = 0; t < durationMs; t += 100) mock.timers.tick(100);
    return events;
  } finally {
    mock.timers.reset();
  }
}

// 3 つのテストが同じ再生を必要とするので 1 回に集約する
const events = collectEvents();
const finals = events.filter((e) => e.isFinal);

test("MockSttAdapter: スクリプトを一周する", () => {
  assert.ok(
    finals.length >= MOCK_SCRIPT.length,
    `final が ${finals.length} 件しかない（${MOCK_SCRIPT.length} 行ぶん必要）`,
  );
  for (const [i, line] of MOCK_SCRIPT.entries()) {
    assert.equal(finals[i].text, line.text, `${i} 行目の final が一致しない`);
    assert.equal(finals[i].speaker, line.speaker, `${i} 行目の speaker が一致しない`);
  }
});

test("MockSttAdapter: interim / final のどちらも words と text が整合している", () => {
  assert.ok(events.length > 0, "イベントが発行されていること");
  for (const e of events) {
    assert.ok(e.words, "words が付いていること");
    assert.ok(e.words.length > 0, `空の transcript を送らないこと: ${JSON.stringify(e.text)}`);
    assert.equal(typeof e.speaker, "number");
    // 境界に跨る word を落とす都合で text も word 境界で切っている
    assertWordsConsistent(e.words, e.text, e.speaker as number);
  }
});

test("MockSttAdapter: start がスクリプト一周を通して単調増加する", () => {
  // 実 Deepgram の start はストリーム先頭からの絶対時刻。行ごとに 0 へ戻ってはいけない
  let prevEnd = 0;
  for (const [i, e] of finals.entries()) {
    for (const w of e.words!) {
      assert.ok(w.start >= prevEnd, `${i} 行目 ${w.word}: start=${w.start} が prevEnd=${prevEnd} より前`);
      prevEnd = w.end;
    }
  }
  // 行間には無音ぶんのギャップが入る（0 に戻らないことを長さでも押さえる）
  const firstOfSecondLine = finals[1].words![0];
  const lastOfFirstLine = finals[0].words!.at(-1)!;
  assert.ok(
    Math.abs(firstOfSecondLine.start - (lastOfFirstLine.end + MOCK_LINE_GAP_SEC)) < 0.001,
    `行間ギャップが ${MOCK_LINE_GAP_SEC} 秒でない`,
  );
});

test("MockSttAdapter: 1 行につき interim 3 回 → final 1 回で、長さが単調に伸びる", () => {
  const firstLine = events.slice(0, MOCK_INTERIM_STEPS + 1);
  assert.deepEqual(
    firstLine.map((e) => e.isFinal),
    [...Array(MOCK_INTERIM_STEPS).fill(false), true],
  );
  for (let i = 1; i < firstLine.length; i += 1) {
    assert.ok(
      firstLine[i].words!.length > firstLine[i - 1].words!.length,
      `${i} 段目で words が増えていない`,
    );
  }
  assert.equal(firstLine[MOCK_INTERIM_STEPS].text, MOCK_SCRIPT[0].text, "final は行全体");
});

test("MockSttAdapter: final の words に誤認識語の低 confidence が乗っている", () => {
  const low = finals.flatMap((e) => e.words!).filter((w) => w.confidence < LOW_CONFIDENCE_THRESHOLD);
  assert.ok(low.length > 0, "低 confidence の word が1つも無い");
  for (const w of low) {
    assert.ok(MOCK_MISHEARD_WORDS.has(w.word), `${w.word} は誤認識語ではない`);
  }
});
