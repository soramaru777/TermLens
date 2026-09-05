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

/**
 * 分割の観点は `events` だけを見る。`diag`（#52 のテキスト完全性）は下の専用ブロックで見る。
 *
 * **ヘルパで包むのは「戻り値の形が変わった」を全テストに散らさないため**であって、
 * `diag` を見ない口実ではない — 見ない観点をここに閉じ込め、見る観点を1箇所に集める。
 */
const eventsOf = (text: string, words?: TranscriptWord[]) => buildFinalEvents(text, words).events;

/** 計測だけを取り出す。 */
const diagOf = (text: string, words?: TranscriptWord[]) => buildFinalEvents(text, words).diag;

test("buildFinalEvents: text が空なら何も返さない", () => {
  assert.deepEqual(eventsOf("", wordsFrom([0, 1])), []);
  assert.deepEqual(eventsOf(""), []);
});

test("buildFinalEvents: words が無ければ text を素通しし speaker は undefined", () => {
  const events = eventsOf("words なし");
  assert.deepEqual(events, [
    { text: "words なし", isFinal: true, speaker: undefined, words: undefined, segIndex: 0 },
  ]);
});

test("buildFinalEvents: words が空配列でも words は undefined に畳まない", () => {
  const events = eventsOf("空配列", []);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].words, []);
});

test("buildFinalEvents: 単一話者なら分割せず words も全体を載せる", () => {
  const words = wordsFrom([0, 0, 0]);
  const events = eventsOf("そのままの文字列", words);
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
  const events = eventsOf(transcript, words);
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
  const events = eventsOf(
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
  const events = eventsOf(
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
  const events = eventsOf(
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
    eventsOf("あいうえ", words).map((e) => e.text),
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
  const events = eventsOf("そのまま", wordsFrom([0, 0]));
  assert.deepEqual(
    events.map((e) => e.segIndex),
    [0],
  );
});

test("buildFinalEvents: 分割した final には 0 起点の連番が付く", () => {
  const events = eventsOf(
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
  const events = eventsOf(
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

// ---- テキスト完全性の計測（#52） ----
//
// 「発話の冒頭が数文字欠けて見える」が本当に欠落なのかを実データで切り分けるための計測。
// **判定に使うのは空白を除いた文字数**（`rawVisible` / `splitVisible`）で、素の `length` では
// ない — 切り出しは `.trim()` を掛けるので **正常に動いていても素の文字数は減る**。
// 素の数で比べると正常な差と欠落が混ざって読めない。
//
// **ただし保存されるのは切り出しに成功したときだけ。** フォールバックは transcript と
// words が食い違ったときにだけ起きるので、組み直したテキストは別の文字列であり、
// 空白を除いた文字数も増減する（下の2本がその両方向を固定する）。

test("SplitDiag: 素通し（分割なし）は transcript の文字数がそのまま出る", () => {
  // **実測値と突き合わせる。** 実装は素通しの枝で `splitChars: rawChars` と同じ値を
  // 代入するので、`rawChars === splitChars` を見るだけでは何を壊しても通ってしまう。
  // 固定すべきは「素通しの枝に入り、transcript の文字数がそのまま出ること」
  const text = "そのままの 文字列";
  const diag = diagOf(text, wordsFrom([0, 0, 0]));
  assert.equal(diag.segments, 1);
  assert.equal(diag.events, 1);
  assert.equal(diag.splitChars, text.length, "素通しは空白も落ちない");
  assert.equal(diag.splitVisible, text.replace(/\s/g, "").length);
  assert.equal(diag.fallback, false);
  assert.equal(diag.headDropped, false);
});

test("SplitDiag: words が無い素通しは segments 0 / events 1（捨てた件数を負にしないための形）", () => {
  // `SplitIntegrity` 側の `Math.max(0, segments - events)` を外すと、ここが -1 として積まれる
  const diag = diagOf("words なし");
  assert.equal(diag.segments, 0);
  assert.equal(diag.events, 1);
  assert.equal(diag.rawVisible, diag.splitVisible);
});

test("SplitDiag: 切り出し成功なら空白除く文字数が保存される（素の文字数は trim ぶん減ってよい）", () => {
  const transcript = "これは AWS Lambda です。 はい、なるほど。";
  const diag = diagOf(
    transcript,
    wordsOf([
      ["これは", 0],
      ["AWS", 0],
      ["Lambda", 0],
      ["です。", 0],
      ["はい、", 1],
      ["なるほど。", 1],
    ]),
  );
  assert.equal(diag.fallback, false, "切り出しに成功しているはず");
  assert.equal(diag.rawVisible, diag.splitVisible, "空白除く文字数は保存される");
  // **素の文字数は減る。** セグメント境界の空白が `.trim()` で落ちるため。
  // この差を「欠落」と読ませないことが、空白を除いて測る理由そのもの
  assert.ok(diag.splitChars < diag.rawChars, "素の文字数は境界の空白ぶん減る");
});

test("SplitDiag: フォールバックでは空白除く文字数が保存されない（減る側）", () => {
  // **フォールバックは transcript と words が食い違ったときにだけ起きる。** 組み直した
  // テキストは words 側の文字列なので、transcript とは別物。「空白除く文字数は必ず
  // 保存される」と読むと、ここを話者分割の欠落と誤診する（診断は fallbacks > 0 のとき
  // ①→②の差を別扱いにする。public/diagnostics.js の INTEGRITY_FALLBACK_VERDICT）
  const diag = diagOf(
    "まったく別の文字列",
    wordsOf([
      ["あ い", 0],
      ["う え", 1],
    ]),
  );
  assert.equal(diag.fallback, true);
  assert.equal(diag.segments, 2);
  assert.equal(diag.events, 2);
  assert.equal(diag.splitVisible, 4, "あ/い/う/え の4文字");
  assert.equal(diag.rawVisible, 9, "transcript 側は9文字");
  assert.ok(diag.splitVisible < diag.rawVisible, "切り出しも破棄も起きていないのに減る");
  assert.equal(diag.headDropped, false);
});

test("SplitDiag: フォールバックでは空白除く文字数が保存されない（増える側）", () => {
  // 逆向きも起きる。**増加を「二重計上」と読ませないため**に固定しておく
  const diag = diagOf(
    "10時",
    wordsOf([
      ["10", 0],
      ["時です", 1],
    ]),
  );
  assert.equal(diag.fallback, true);
  assert.equal(diag.rawVisible, 3);
  assert.equal(diag.splitVisible, 5, "words 側のほうが多い");
});

test("SplitDiag: 先頭セグメントが空なら headDropped が立ち、捨てた件数も出る", () => {
  // **「発話の頭が丸ごと消える」を構造的に説明できる唯一の経路**（#52 の調査）。
  // 件数（segments - events）だけだと、落ちたのが先頭かどうかが読めない
  const diag = diagOf(
    "別の文字列",
    wordsOf([
      ["", 0],
      ["い", 1],
      ["う", 0],
    ]),
  );
  assert.equal(diag.headDropped, true);
  assert.equal(diag.segments, 3);
  assert.equal(diag.events, 2);
  assert.equal(diag.splitVisible, 2, "残った2文字ぶんだけが出る");
  // ここが raw より減っている＝本物の欠落。判定はこの差で行う
  assert.ok(diag.splitVisible < diag.rawVisible);
});

test("SplitDiag: 末尾だけが空なら headDropped は立たない（捨てた件数だけ増える）", () => {
  const diag = diagOf(
    "別の文字列",
    wordsOf([
      ["あ", 0],
      ["", 1],
    ]),
  );
  assert.equal(diag.headDropped, false);
  assert.equal(diag.segments, 2);
  assert.equal(diag.events, 1);
});

test("SplitDiag: text が空なら segments も 0（捨てた件数を汚さない）", () => {
  // 呼び出し側（deepgram.ts）は空 transcript で diag を配らないが、純関数の戻りの形は
  // 常に `{ events, diag }` であること。片方だけ undefined になる形を作らない。
  //
  // **`segments` を words の分割数で埋めない。** `SplitIntegrity` は `segments - events`
  // を「空で捨てたセグメント」として積むので、1件も発行していない final で件数だけが
  // 増える（不変条件を呼び出し側にだけ置かない）
  assert.deepEqual(diagOf("", wordsFrom([0, 1])), {
    rawChars: 0,
    rawVisible: 0,
    splitChars: 0,
    splitVisible: 0,
    segments: 0,
    events: 0,
    fallback: false,
    headDropped: false,
  });
});
