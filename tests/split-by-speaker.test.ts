import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFinalEvents, splitBySpeaker } from "../src/stt/split.js";
import type { TranscriptWord } from "../src/stt/types.js";

interface SegmentCase {
  id: string;
  /** JSON に undefined は書けないため null で表す。word を組むときに undefined へ写す。 */
  speakers: Array<number | null>;
  expect: Array<{ speaker: number | null; count: number }>;
}

const cases: SegmentCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/speaker-segments.json", import.meta.url), "utf8"),
);

/**
 * fixture に載っているべきケースの id。
 *
 * **集合一致で検証する。** `for (const c of cases)` だけだと、fixture からケースを
 * 消してもテストが静かに減るだけで通ってしまう（`tests/mock-words.test.ts` の
 * `MOCK_MISHEARD_WORDS` と同じ片方向 drift）。
 *
 * ケースの意図はここに日本語で書く。**fixture 側に自由記述の欄を作らない**
 * （匿名化検査を当てられない穴になり、実会議の語を書けてしまうため）。
 */
const EXPECTED_CASES: Record<string, string> = {
  "single-speaker": "話者が変わらない。分割しない",
  "backchannel-at-end": "末尾の短い相槌。多数決なら話者0に吸収されて消えていたもの",
  "unknown-in-middle": "speaker 不明の語は境界を作らず直前のセグメントに吸収される",
  "unknown-before-boundary": "境界の直前の不明語も直前側に付く（次の話者に持ち越さない）",
  "unknown-at-head": "先頭の不明語は、そのセグメントで最初に現れた話者に含める",
  "unknown-at-head-then-boundary": "先頭不明語の後追い昇格と、境界検出が同時に起きる",
  "all-unknown": "全語で speaker 不明。1セグメントで speaker は undefined",
  empty: "word が無ければセグメントも無い",
  alternating: "話者番号が1語ごとに揺れると4分割される。閾値を入れていないため露出する挙動",
};

/** fixture のケースに書いてよいキー。ここに無いキーがあれば実会議由来の混入を疑う。 */
const ALLOWED_CASE_KEYS = ["id", "speakers", "expect"];
/** `expect` の要素に書いてよいキー。入れ子も緩めない。 */
const ALLOWED_EXPECT_KEYS = ["speaker", "count"];

test("fixture は会話内容を含まない（数値と id だけの合成データ）", () => {
  for (const c of cases) {
    const rec = c as unknown as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(rec).filter((k) => !ALLOWED_CASE_KEYS.includes(k)),
      [],
      `${c.id}: 許可していないキーがある`,
    );
    // id は自由記述にせずケバブケース ASCII に縛る
    assert.match(c.id, /^[a-z0-9-]+$/, `${c.id}: id がケバブケース ASCII でない`);
    for (const s of c.speakers) {
      assert.ok(s === null || Number.isInteger(s), `${c.id}: speaker が整数でも null でもない`);
    }
    for (const e of c.expect) {
      const erec = e as unknown as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(erec).filter((k) => !ALLOWED_EXPECT_KEYS.includes(k)),
        [],
        `${c.id}: expect に許可していないキーがある`,
      );
      assert.ok(e.speaker === null || Number.isInteger(e.speaker), `${c.id}: expect.speaker`);
      assert.ok(Number.isInteger(e.count), `${c.id}: expect.count`);
    }
  }
});

test("fixture のケース集合が期待どおり（ケースの消し忘れ・足し忘れを検出）", () => {
  assert.deepEqual(cases.map((c) => c.id).sort(), Object.keys(EXPECTED_CASES).sort());
});

/** speaker 列からダミーの word 列を作る。表記は w0, w1, ... で会話内容を持たない。 */
function wordsFrom(speakers: Array<number | null>): TranscriptWord[] {
  return speakers.map((s, i) => ({
    word: `w${i}`,
    punctuatedWord: `w${i}`,
    start: i * 0.5,
    end: (i + 1) * 0.5,
    confidence: 0.9,
    speaker: s ?? undefined,
  }));
}

for (const c of cases) {
  test(`splitBySpeaker: ${c.id} — ${EXPECTED_CASES[c.id]}`, () => {
    const words = wordsFrom(c.speakers);
    const got = splitBySpeaker(words);
    assert.deepEqual(
      got.map((s) => ({ speaker: s.speaker ?? null, count: s.words.length })),
      c.expect,
    );
  });

  test(`splitBySpeaker: word を落とさず順序も変えない — ${c.id}`, () => {
    const words = wordsFrom(c.speakers);
    const flat = splitBySpeaker(words).flatMap((s) => s.words);
    assert.deepEqual(flat, words);
  });
}

test("splitBySpeaker: 入力を書き換えない", () => {
  const words = wordsFrom([0, null, 1]);
  const snapshot = structuredClone(words);
  splitBySpeaker(words);
  assert.deepEqual(words, snapshot);
});

test("splitBySpeaker: speaker 0 は falsy でも話者として扱う", () => {
  const got = splitBySpeaker(wordsFrom([0, 0]));
  assert.equal(got.length, 1);
  assert.equal(got[0].speaker, 0);
});

/**
 * AC「短い相槌が別話者として保持できる」の担保。
 * 1語だけの相槌でも独立したセグメントとして残ること（最小語数の閾値を入れていないこと）。
 */
test("splitBySpeaker: 1語の相槌でも独立したセグメントとして残る", () => {
  const got = splitBySpeaker(wordsFrom([0, 0, 0, 0, 0, 1]));
  assert.deepEqual(
    got.map((s) => ({ speaker: s.speaker, count: s.words.length })),
    [
      { speaker: 0, count: 5 },
      { speaker: 1, count: 1 },
    ],
  );
});

/** 表記と話者を直に指定して word 列を作る。text の切り出しを見るテスト用。 */
function wordsOf(pairs: Array<[surface: string, speaker: number | undefined]>): TranscriptWord[] {
  return pairs.map(([surface, speaker], i) => ({
    word: surface,
    punctuatedWord: surface,
    start: i * 0.5,
    end: (i + 1) * 0.5,
    confidence: 0.9,
    speaker,
  }));
}

test("buildFinalEvents: text が空なら何も返さない", () => {
  assert.deepEqual(buildFinalEvents("", wordsFrom([0, 1])), []);
  assert.deepEqual(buildFinalEvents(""), []);
});

test("buildFinalEvents: words が無ければ text を素通しし speaker は undefined", () => {
  const events = buildFinalEvents("words なし");
  assert.deepEqual(events, [
    { text: "words なし", isFinal: true, speaker: undefined, words: undefined, segIndex: 0 },
  ]);
});

test("buildFinalEvents: words が空配列でも words は undefined に畳まない", () => {
  const events = buildFinalEvents("空配列", []);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].words, []);
});

test("buildFinalEvents: 単一話者なら分割せず words も全体を載せる", () => {
  const words = wordsFrom([0, 0, 0]);
  const events = buildFinalEvents("そのままの文字列", words);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "そのままの文字列");
  assert.equal(events[0].speaker, 0);
  assert.deepEqual(events[0].words, words);
});

/**
 * 分割時の text は **transcript から切り出す**。連結で作り直すと、日本語 transcript でも
 * ラテン文字列の語間に入る空白（`AWS Lambda`）が落ちて別の語になる。
 */
test("buildFinalEvents: 分割時も transcript の語間の空白を保つ", () => {
  const transcript = "これは AWS Lambda です。はい、なるほど。";
  const words = wordsOf([
    ["これは", 0],
    ["AWS", 0],
    ["Lambda", 0],
    ["です。", 0],
    ["はい、", 1],
    ["なるほど。", 1],
  ]);
  const events = buildFinalEvents(transcript, words);
  assert.deepEqual(
    events.map((e) => e.text),
    ["これは AWS Lambda です。", "はい、なるほど。"],
  );
  // 各イベントには自分のセグメントの words だけが載る（全体を載せていないこと）
  assert.deepEqual(
    events.map((e) => e.words?.map((w) => w.word)),
    [
      ["これは", "AWS", "Lambda", "です。"],
      ["はい、", "なるほど。"],
    ],
  );
  assert.deepEqual(
    events.map((e) => e.speaker),
    [0, 1],
  );
});

test("buildFinalEvents: 分割された text は transcript の部分文字列になっている", () => {
  const transcript = "1 2 3 4";
  const events = buildFinalEvents(
    transcript,
    wordsOf([
      ["1", 0],
      ["2", 0],
      ["3", 1],
      ["4", 1],
    ]),
  );
  for (const e of events) {
    assert.ok(transcript.includes(e.text), `${e.text} が transcript に含まれない`);
  }
  assert.deepEqual(
    events.map((e) => e.text),
    ["1 2", "3 4"],
  );
});

/** 切り出せない（transcript と words が食い違う）ときは連結にフォールバックする。 */
test("buildFinalEvents: transcript と words が食い違えば連結で再構成する", () => {
  const events = buildFinalEvents(
    "まったく別の文字列",
    wordsOf([
      ["あ", 0],
      ["い", 1],
    ]),
  );
  assert.deepEqual(
    events.map((e) => e.text),
    ["あ", "い"],
  );
});

test("buildFinalEvents: 再構成しても空の text は送らない", () => {
  const events = buildFinalEvents(
    "別の文字列",
    wordsOf([
      ["", 0],
      ["い", 1],
    ]),
  );
  assert.deepEqual(
    events.map((e) => e.text),
    ["い"],
  );
});

test("buildFinalEvents: punctuatedWord が無ければ word を使って切り出す", () => {
  const words: TranscriptWord[] = [
    { word: "あい", start: 0, end: 0.5, confidence: 0.9, speaker: 0 },
    { word: "うえ", start: 0.5, end: 1, confidence: 0.9, speaker: 1 },
  ];
  assert.deepEqual(
    buildFinalEvents("あいうえ", words).map((e) => e.text),
    ["あい", "うえ"],
  );
});

// ---- segIndex（#36） ----
//
// クライアントの jitter 補正は「同じ final 由来か」を `finalSeq` で判定する。その採番は
// `session.ts` が `segIndex === 0` を見て行うので、**ここで印が正しく付かないと
// 別々の final が1発話として結合されうる**（テキストは消えないが話者が混ざる）。

test("buildFinalEvents: 分割しない final にも segIndex 0 が付く", () => {
  // ここが欠けると session.ts の採番規則（segIndex === 0 で進める）が
  // 「undefined でも進める」側の枝でしか通らなくなり、分割時との整合が崩れる
  const events = buildFinalEvents("そのまま", wordsFrom([0, 0]));
  assert.deepEqual(
    events.map((e) => e.segIndex),
    [0],
  );
});

test("buildFinalEvents: 分割した final には 0 起点の連番が付く", () => {
  const events = buildFinalEvents(
    "あいうえお",
    wordsOf([
      ["あ", 0],
      ["い", 1],
      ["う", 0],
      ["え", 1],
      ["お", 0],
    ]),
  );
  assert.deepEqual(
    events.map((e) => e.segIndex),
    [0, 1, 2, 3, 4],
  );
});

/**
 * **空の text を捨てた「後」に採番する。**
 *
 * 捨てる前に振ると、先頭のセグメントが落ちたときに `segIndex === 0` のイベントが
 * 1件も出ず、`session.ts` のカウンタが進まない。直前の final と同じ `finalSeq` になり、
 * 別々の final がクライアント側で1発話として結合されうる（#36）。
 */
test("buildFinalEvents: 空の text を捨てても segIndex は 0 から連番になる", () => {
  const events = buildFinalEvents(
    "別の文字列",
    wordsOf([
      ["", 0],
      ["い", 1],
      ["う", 0],
    ]),
  );
  assert.deepEqual(
    events.map((e) => ({ text: e.text, segIndex: e.segIndex })),
    [
      { text: "い", segIndex: 0 },
      { text: "う", segIndex: 1 },
    ],
  );
});
