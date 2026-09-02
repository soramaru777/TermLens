import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { MOCK_SCRIPT } from "../src/stt/mock-script.js";
import { UtteranceBuilder, type Utterance } from "../src/stt/utterance.js";
import {
  chunkMockWords,
  MOCK_WORDS_PER_FINAL,
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
  // **`expectCorrection` は `TermCaseSchema` で `.default({})` の optional。**
  // 生の JSON を読むここだけが「必ず在る」前提だったので、誤認識を扱わないケースを
  // 1件足した時点で `Object.keys(undefined)` で落ちていた。スキーマの契約に合わせる
  interface TermCase {
    expectCorrection?: Record<string, string>;
  }
  const termCases: TermCase[] = JSON.parse(
    readFileSync(new URL("./fixtures/term-cases.json", import.meta.url), "utf8"),
  );
  const scriptWords = new Set(MOCK_SCRIPT.flatMap((l) => l.words.map((w) => w.word)));
  const expected = new Set(
    termCases
      .flatMap((c) => Object.keys(c.expectCorrection ?? {}))
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

/**
 * final を UtteranceBuilder に通して発話に組み直す。
 * mock は1行を複数 final に割って出すので、これを通して初めて行と比べられる。
 */
function buildUtterances(evs: TranscriptEvent[]): Utterance[] {
  const out: Utterance[] = [];
  const builder = new UtteranceBuilder((u) => out.push(u));
  for (const e of evs) if (e.isFinal) builder.addFinal(e);
  builder.flush();
  return out;
}

const utterances = buildUtterances(events);

/**
 * AC「複数の final segment を1つの自然な発話として統合できる」の担保。
 *
 * **この2つはセットで意味を持つ**。(1) 1行が複数 final に割れていること（割れていなければ
 * UtteranceBuilder は素通しになり、統合を何も検証しないテストになる）、
 * (2) 組み直すと元の行に1文字も違わず戻ること（連結規則が変わると落ちる）。
 */
test("MockSttAdapter: 1 行が複数の final に割れている", () => {
  assert.ok(
    finals.length > MOCK_SCRIPT.length,
    `final が ${finals.length} 件。行数 ${MOCK_SCRIPT.length} より多くなければ分割されていない`,
  );
  // 最後の final にだけ speechFinal が立つ
  const speechFinals = finals.filter((e) => e.speechFinal);
  assert.equal(
    speechFinals.length,
    MOCK_SCRIPT.length,
    "speechFinal が立つのは行ごとに1件だけであること",
  );
});

test("MockSttAdapter: final を組み直すとスクリプトの各行に戻る", () => {
  assert.ok(
    utterances.length >= MOCK_SCRIPT.length,
    `発話が ${utterances.length} 件しかない（${MOCK_SCRIPT.length} 行ぶん必要）`,
  );
  for (const [i, line] of MOCK_SCRIPT.entries()) {
    assert.equal(utterances[i].text, line.text, `${i} 行目の発話が一致しない`);
    assert.equal(utterances[i].speaker, line.speaker, `${i} 行目の speaker が一致しない`);
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
  // 行間には無音ぶんのギャップが入る（0 に戻らないことを長さでも押さえる）。
  // 1 行が複数 final に割れるので、行の境界は speechFinal で見つける
  const lastIdxOfFirstLine = finals.findIndex((e) => e.speechFinal);
  const lastOfFirstLine = finals[lastIdxOfFirstLine].words!.at(-1)!;
  const firstOfSecondLine = finals[lastIdxOfFirstLine + 1].words![0];
  assert.ok(
    Math.abs(firstOfSecondLine.start - (lastOfFirstLine.end + MOCK_LINE_GAP_SEC)) < 0.001,
    `行間ギャップが ${MOCK_LINE_GAP_SEC} 秒でない`,
  );
});

test("MockSttAdapter: 1 行につき interim 3 回のあと final が続き、interim は単調に伸びる", () => {
  const interims = events.slice(0, MOCK_INTERIM_STEPS);
  assert.deepEqual(
    interims.map((e) => e.isFinal),
    Array(MOCK_INTERIM_STEPS).fill(false),
    "先頭は interim が MOCK_INTERIM_STEPS 回続く",
  );
  for (let i = 1; i < interims.length; i += 1) {
    assert.ok(
      interims[i].words!.length > interims[i - 1].words!.length,
      `${i} 段目で words が増えていない`,
    );
  }
  // interim の直後から final が始まり、1 行ぶんが speechFinal で閉じる
  const after = events.slice(MOCK_INTERIM_STEPS);
  const endIdx = after.findIndex((e) => e.speechFinal);
  assert.ok(endIdx >= 0, "speechFinal で閉じる final があること");
  const lineFinals = after.slice(0, endIdx + 1);
  assert.ok(lineFinals.every((e) => e.isFinal), "行の final の並びに interim が混ざらない");
  assert.equal(
    lineFinals.map((e) => e.text).join(""),
    MOCK_SCRIPT[0].text,
    "行の final を連結すると行全体になる",
  );
});

test("MockSttAdapter: final の words に誤認識語の低 confidence が乗っている", () => {
  const low = finals.flatMap((e) => e.words!).filter((w) => w.confidence < LOW_CONFIDENCE_THRESHOLD);
  assert.ok(low.length > 0, "低 confidence の word が1つも無い");
  for (const w of low) {
    assert.ok(MOCK_MISHEARD_WORDS.has(w.word), `${w.word} は誤認識語ではない`);
  }
});

// --- chunkMockWords -----------------------------------------------------

/** ダミーの word を n 個作る。中身は chunkMockWords が見ないので最小限。 */
function dummyWords(n: number): TranscriptWord[] {
  return Array.from({ length: n }, (_, i) => ({
    word: `w${i}`,
    punctuatedWord: `w${i}`,
    start: i,
    end: i + 1,
    confidence: 0.9,
    speaker: 0,
  }));
}

test("chunkMockWords: 端数は最後のチャンクに入る", () => {
  assert.deepEqual(
    chunkMockWords(dummyWords(5), 2).map((c) => c.length),
    [2, 2, 1],
  );
});

test("chunkMockWords: 語数が size 以下なら1チャンク", () => {
  assert.equal(chunkMockWords(dummyWords(3), 4).length, 1);
  assert.equal(chunkMockWords(dummyWords(4), 4).length, 1);
});

test("chunkMockWords: 空配列なら空配列", () => {
  assert.deepEqual(chunkMockWords([], MOCK_WORDS_PER_FINAL), []);
});

test("chunkMockWords: size が 1 未満でも進む（無限ループにならない）", () => {
  // 定数なので到達しないが、0 を渡すと i += 0 で止まらなくなる形だった
  assert.equal(chunkMockWords(dummyWords(3), 0).length, 3);
  assert.equal(chunkMockWords(dummyWords(3), -1).length, 3);
});

test("chunkMockWords: word を落とさず順序も変えない", () => {
  const words = dummyWords(7);
  assert.deepEqual(chunkMockWords(words, 3).flat(), words);
});
