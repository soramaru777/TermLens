import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// public/ はビルドレスな素の JS。tsconfig.test.json の allowJs で解決している
// （`tests/card-status.test.ts` が public/card-status.js を読むのと同じ）。
import {
  BOUNDARY_FRAGMENT_CHAR_LIMIT,
  JITTER_CHAR_LIMIT,
  JITTER_WINDOW_MS,
  MINOR_ISLAND_MAX_RATIO,
  MINOR_ISLAND_MAX_WORDS,
  MINOR_ISLAND_RELATIVE_MAX_RATIO,
  MINOR_ISLAND_RELATIVE_CAP_RATIO,
  MIN_TOTAL_WORDS_FOR_ISLANDS,
  LONG_MINOR_NEUTRALIZE_MAX_RATIO,
  LONG_MINOR_MAX_RUNS,
  LONG_MINOR_MAX_WORDS,
  LONG_MINOR_MIN_MERGE_SEGMENTS,
  LONG_MINOR_TRANSITION_BIAS,
  BACKCHANNEL_WORDS,
  groupUtterances,
  mergeSameSpeaker,
  planDisplayCorrection,
  planLongMinorRuns,
  planMinorIslandMerges,
  planUnknownReattribution,
  planUnresolvedMinors,
  smoothMinorSpeakerIslands,
  smoothSpeakerBoundaries,
  smoothSpeakerJitter,
  BOUNDARY_PUNCTUATION,
  BOUNDARY_EXTENDED_CHAR_LIMIT,
  BOUNDARY_CHAIN_MAX_CHARS,
  continuity,
} from "../public/utterances.js";
import { collectSpeakerStats, MINOR_SPEAKER_RATIO } from "../public/speaker-stats.js";
// 文字数の数え方は diagnostics.js が唯一の定義箇所（#52）。ここで数え直すと、
// 診断が読む数と、この不変条件が守る数が別物になる
import { countTextChars } from "../public/diagnostics.js";

/**
 * 表示・エクスポート用の発話グループ（`public/utterances.js`、#36）。
 *
 * 固定したいのは2つ。
 * 1. **移設前の挙動** — 同一話者の結合、再接続の境界、`speaker` 不明の扱い。
 *    app.js から切り出しただけの部分で、ここが動くと画面の段落が丸ごと変わる
 * 2. **jitter 補正の判定** — 「何も削除しない」「本物の相槌を吸収しない」
 *    「再接続を越えない」。閾値の当たり外れではなく**構造**として満たしていること
 *
 * **fixture に会話内容を入れない**（[[termlens-testing]] の規約）。このテストの文字列は
 * 長さと話者だけが意味を持つ合成データで、実会議の断片は使わない。
 */

interface Line {
  text?: string;
  speaker?: number | null;
  t?: number;
  seq?: number;
  /** そのセグメントの word 数（`ServerMessage.transcript.wordCount`）。#48 の判定に使う */
  w?: number;
  type?: string;
  /** ③（#50）が立てる印。復元経路の fixture でだけ使う */
  unresolved?: boolean;
}

/** 発話行。既定で `t` は連番、`seq` は明示したときだけ載せる。 */
function line(text: string, speaker: number | null, opts: { t?: number; seq?: number } = {}): Line {
  return { text, speaker, t: opts.t ?? 0, ...(opts.seq === undefined ? {} : { seq: opts.seq }) };
}

const reconnect = (t = 0): Line => ({ type: "reconnect", t });

/** グループを「話者 + 連結したテキスト」に畳んで比較しやすくする。 */
function summary(groups: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return groups.map((g) =>
    g.type === "reconnect"
      ? { type: "reconnect" }
      : { speaker: g.speaker, text: (g.texts as string[]).join("") },
  );
}

// 補正の対象になる長さ / ならない長さ。閾値を直接使い、値を変えてもテストの意図が
// ずれないようにする（リテラルで書くと JITTER_CHAR_LIMIT を動かした瞬間に無意味になる）
const SHORT = "あ".repeat(JITTER_CHAR_LIMIT);
const LONG = "あ".repeat(JITTER_CHAR_LIMIT + 1);

// ---- 匿名化 fixture（話者・長さ・final 由来の組み合わせ） ----

interface JitterCase {
  id: string;
  /** JSON に undefined は書けないため null で表す。行を組むときに null のまま渡す。 */
  speakers: Array<number | null>;
  /** 閾値との相対で書く。実長を書くと JITTER_CHAR_LIMIT を動かした瞬間に意図がずれる。 */
  lengths: Array<"short" | "long">;
  seqs: number[];
  expect: Array<{ speaker: number | null; count: number }>;
}

const cases: JitterCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/speaker-jitter.json", import.meta.url), "utf8"),
);

/**
 * fixture に載っているべきケースの id。
 *
 * **集合一致で検証する**（`tests/split-by-speaker.test.ts` と同じ理由）。
 * `for (const c of cases)` だけだと、fixture からケースを消してもテストが静かに減る。
 *
 * ケースの意図はここに日本語で書く。**fixture 側に自由記述の欄を作らない**
 * （匿名化検査を当てられない穴になり、実会議の語を書けてしまうため）。
 *
 * 再接続の境界と、`seq` を持たない行の時間窓は fixture の形（speaker / 長さ / seq）では
 * 表せないので、この下のテストで個別に固定している。
 */
const EXPECTED_CASES: Record<string, string> = {
  "island-same-final": "同じ final が話者ラベルの揺れで割れた本体。1段落へ戻す",
  "island-cascade": "短い島が連続しても畳める。補正済みの結果を次の判定に使う",
  "alternating-cascade":
    "A→B→A→B が全部短い。補正前の speaker を根拠にすると2つ目まで巻き込む（カスケードの識別）",
  "backchannel-other-final": "別 final として届いた相槌。長さは同じでも seq が違うので残る",
  "boundary-seq-at-head": "先頭2行だけ同じ final。片側一致で吸収すると final の境界を越える",
  "boundary-seq-at-tail": "末尾2行だけ同じ final。上と逆側の片側一致",
  "long-middle": "同じ final 由来でも閾値を超える長さなら話者交代とみなす",
  "different-neighbors": "前後の話者が違えば島ではない",
  "short-at-both-edges": "端の行は前後で挟めないので対象外",
  "unknown-neighbors": "前後が不明なら、確定している話者を不明で上書きしない",
  "unknown-middle": "前後が同じ確定話者なら、不明な短い行は取り込む",
};

/** fixture のケースに書いてよいキー。ここに無いキーがあれば実会議由来の混入を疑う。 */
const ALLOWED_CASE_KEYS = ["id", "speakers", "lengths", "seqs", "expect"];
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
    assert.equal(c.speakers.length, c.lengths.length, `${c.id}: speakers と lengths の数が違う`);
    assert.equal(c.speakers.length, c.seqs.length, `${c.id}: speakers と seqs の数が違う`);
    for (const s of c.speakers) {
      assert.ok(s === null || Number.isInteger(s), `${c.id}: speaker が整数でも null でもない`);
    }
    // 長さは short / long の2値だけ。実際の文字列を書かせない
    for (const l of c.lengths) {
      assert.ok(l === "short" || l === "long", `${c.id}: lengths が short / long 以外`);
    }
    for (const q of c.seqs) assert.ok(Number.isInteger(q), `${c.id}: seq が整数でない`);
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

/** fixture のケースから発話行を組む。テキストは長さだけが意味を持つ合成データ。 */
function linesOf(c: JitterCase): Line[] {
  return c.speakers.map((s, i) => ({
    text: c.lengths[i] === "short" ? SHORT : LONG,
    speaker: s,
    // seq が全行に載っているので時間窓の判定には落ちない。t は保存経路の形を保つためだけ
    t: i,
    seq: c.seqs[i],
  }));
}

for (const c of cases) {
  test(`groupUtterances: ${c.id} — ${EXPECTED_CASES[c.id]}`, () => {
    const groups = groupUtterances(linesOf(c)) as Array<Record<string, unknown>>;
    assert.deepEqual(
      groups.map((g) => ({ speaker: g.speaker ?? null, count: (g.texts as string[]).length })),
      c.expect,
    );
  });

  test(`groupUtterances: 行もテキストも落とさない — ${c.id}`, () => {
    const lines = linesOf(c);
    const groups = groupUtterances(lines) as Array<Record<string, unknown>>;
    assert.equal(
      groups.flatMap((g) => g.texts as string[]).join(""),
      lines.map((l) => l.text).join(""),
    );
  });
}

// ---- 移設前からの挙動（app.js の groupUtterances をそのまま持ってきた部分） ----

test("連続する同一話者は1段落にまとまる", () => {
  const lines = [line("いちぎょうめ", 0, { seq: 1 }), line("にぎょうめ", 0, { seq: 2 })];
  assert.deepEqual(summary(groupUtterances(lines)), [{ speaker: 0, text: "いちぎょうめにぎょうめ" }]);
});

test("話者が変われば段落が分かれる", () => {
  const lines = [line("はなしてA", 0, { seq: 1 }), line("はなしてB", 1, { seq: 2 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: "はなしてA" },
    { speaker: 1, text: "はなしてB" },
  ]);
});

/**
 * 再接続の後は Deepgram の話者番号が振り直しになる。同じ番号でも別人の可能性があるため、
 * **境界を越えて結合しない**。
 */
test("再接続の境界を越えて結合しない", () => {
  const lines = [line("まえ", 0, { seq: 1 }), reconnect(), line("あと", 0, { seq: 1 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: "まえ" },
    { type: "reconnect" },
    { speaker: 0, text: "あと" },
  ]);
});

test("speaker 不明（null）の行はそれ同士だけがまとまる", () => {
  const lines = [line("ふめい1", null, { seq: 1 }), line("ふめい2", null, { seq: 2 }), line("ゼロ", 0, { seq: 3 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: null, text: "ふめい1ふめい2" },
    { speaker: 0, text: "ゼロ" },
  ]);
});

test("speaker 0 は falsy でも話者として扱う", () => {
  const lines = [line("ゼロ", 0, { seq: 1 }), line("ふめい", null, { seq: 2 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: "ゼロ" },
    { speaker: null, text: "ふめい" },
  ]);
});

test("空配列は空のグループ列", () => {
  assert.deepEqual(groupUtterances([]), []);
});

// ---- jitter 補正のうち fixture で表せないもの（#36） ----
//
// 話者・長さ・`seq` の組み合わせは上の fixture に集約してある。ここに置くのは、
// 再接続の区切り印と `seq` を持たない行（復元経路）のように、fixture の形では
// 表せないケースだけ。

/**
 * 再接続を挟むと話者番号の意味が変わる。**番号が同じでも別人**なので、
 * 境界の向こう側を「前後が同じ話者」の根拠に使ってはいけない。
 */
test("再接続を越えて jitter 補正しない", () => {
  // 「あと」は⓪（#55）の断片の長さに当たり、同じ final の SHORT（話者1）へ寄ってしまう。
  // ここで固定したいのは①が再接続を越えないことなので、⓪に掛からない長さにしておく。
  // さらに #57 で SHORT（4 文字）は「6 文字以上の anchor と文字種が連続していれば寄る」
  // 拡張断片になったので、境目をひらがな → 漢字（連続性「弱」）にして⓪の対象から外す
  const lines = [line("まえ", 0, { seq: 7 }), reconnect(), line(SHORT, 1, { seq: 1 }), line("後のはなしを", 0, { seq: 1 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: "まえ" },
    { type: "reconnect" },
    { speaker: 1, text: SHORT },
    { speaker: 0, text: "後のはなしを" },
  ]);
});

// ---- seq を持たない行（#36 以前に保存されたセッションの復元） ----

test("seq が全行で無ければ受信時刻の窓で判定する", () => {
  const lines = [
    line("まえはん", 0, { t: 1000 }),
    line(SHORT, 1, { t: 1000 + JITTER_WINDOW_MS }),
    line("うしろはん", 0, { t: 1000 + JITTER_WINDOW_MS * 2 }),
  ];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: `まえはん${SHORT}うしろはん` },
  ]);
});

test("seq が無く、窓を超えて離れていれば吸収しない", () => {
  const lines = [
    line("まえはん", 0, { t: 0 }),
    line("はい", 1, { t: JITTER_WINDOW_MS + 1 }),
    line("つづき", 0, { t: (JITTER_WINDOW_MS + 1) * 2 }),
  ];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: "まえはん" },
    { speaker: 1, text: "はい" },
    { speaker: 0, text: "つづき" },
  ]);
});

/**
 * **seq が3つとも揃っているのに食い違うときは時間窓へ落とさない。**
 * 落とすと、厳密な判定（同じ final 由来か）を緩い判定で上書きすることになり、
 * 同時刻に届いた別 final の相槌が吸収される。
 */
test("seq が揃っていて食い違うなら、時刻が近くても吸収しない", () => {
  const lines = [line("まえはん", 0, { t: 0, seq: 1 }), line("はい", 1, { t: 0, seq: 2 }), line("つづき", 0, { t: 0, seq: 3 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: "まえはん" },
    { speaker: 1, text: "はい" },
    { speaker: 0, text: "つづき" },
  ]);
});

test("seq が一部の行にしか無ければ窓へフォールバックする", () => {
  // 復元したセッションの続きを録り直した場合に起こりうる混在
  const lines = [line("まえはん", 0, { t: 0 }), line(SHORT, 1, { t: 10, seq: 7 }), line("うしろはん", 0, { t: 20, seq: 7 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: `まえはん${SHORT}うしろはん` },
  ]);
});

// ---- 「何も削除しない」ことと raw を汚さないこと ----

/**
 * **AC の本体その2。** 補正は `speaker` ラベルだけを直す。行もテキストも減らないので、
 * 閾値を派手に外しても発言が消えることはない。
 */
test("補正の前後でテキストが1文字も欠けない", () => {
  const lines = [
    line("あ", 0, { seq: 7 }),
    line(SHORT, 1, { seq: 7 }),
    line("い", 0, { seq: 7 }),
    line("はい", 2, { seq: 8 }),
    reconnect(),
    line(SHORT, 1, { seq: 1 }),
    line("う", 0, { seq: 1 }),
  ];
  const expected = lines.filter((l) => l.type !== "reconnect").map((l) => l.text).join("");
  const got = groupUtterances(lines)
    .filter((g: Record<string, unknown>) => g.type !== "reconnect")
    .map((g: Record<string, unknown>) => (g.texts as string[]).join(""))
    .join("");
  assert.equal(got, expected);
  // 行数も減らない（同じ段落へ入るだけ）
  const rows = groupUtterances(lines)
    .filter((g: Record<string, unknown>) => g.type !== "reconnect")
    .reduce((n: number, g: Record<string, unknown>) => n + (g.texts as string[]).length, 0);
  assert.equal(rows, lines.filter((l) => l.type !== "reconnect").length);
});

/**
 * **raw の `finalLines` は変更しない。** localStorage に保存されるのも用語抽出が見るのも
 * 補正前の生データで、閾値を後から変えたときに保存済みのセッションが古い補正結果に
 * 固定されない。
 */
test("入力の配列も要素も書き換えない", () => {
  const lines = [line("まえはん", 0, { seq: 7 }), line(SHORT, 1, { seq: 7 }), line("うしろはん", 0, { seq: 7 })];
  const snapshot = structuredClone(lines);
  groupUtterances(lines);
  assert.deepEqual(lines, snapshot);
});

test("smoothSpeakerJitter は speaker だけを直したコピーを返す", () => {
  const lines = [line("まえはん", 0, { seq: 7 }), line(SHORT, 1, { seq: 7 }), line("うしろはん", 0, { seq: 7 })];
  const out = smoothSpeakerJitter(lines) as Line[];
  assert.deepEqual(out.map((l) => l.speaker), [0, 0, 0]);
  // speaker 以外は入力のまま
  assert.deepEqual(
    out.map(({ text, t, seq }) => ({ text, t, seq })),
    lines.map(({ text, t, seq }) => ({ text, t, seq })),
  );
  assert.notEqual(out[1], lines[1], "入力の要素をそのまま返している（破壊的変更の危険）");
});

test("mergeSameSpeaker は補正せず、渡された speaker のままでまとめる", () => {
  // 2段の役割が混ざっていないことの確認。ここで補正まで行うと、
  // 補正を無効にしたい呼び出し側（将来の比較用）が作れなくなる
  const lines = [line("まえはん", 0, { seq: 7 }), line(SHORT, 1, { seq: 7 }), line("うしろはん", 0, { seq: 7 })];
  assert.deepEqual(summary(mergeSameSpeaker(lines)), [
    { speaker: 0, text: "まえはん" },
    { speaker: 1, text: SHORT },
    { speaker: 0, text: "うしろはん" },
  ]);
});

// ---- 想定話者数つきの minor speaker island 補正（#48） ----
//
// 固定したいのは3つ。
// 1. **ゲート** — 想定話者数を申告していない／検出が想定以下／総量が少なすぎる、では
//    1件も補正しない。「効いていない」と「効いた結果0件」を `disabledBy` で区別する
// 2. **run の切り出し** — 同一 minor の連続は1つの島として吸収し、別の minor が隣接したら
//    切る（`X → Y` という遷移そのものが観測された話者交代なので、またいで消してはいけない）
// 3. **①jitter → ②island の順序** — 順序を入れ替えると吸収できる島が減る。
//    順序は `groupUtterances()` の中に閉じてあり、呼び出し側の規律にしていない
//
// fixture はここでも**匿名化した合成データ**。文字列は長さにしか意味が無く、
// 話者番号と word 数だけが判定に効く。

/** 想定話者数の選択値。文字列リテラルを各テストに散らさない（丸めは実装側で行われる） */
const EXPECTED_2 = "2";

type IslandSpec = Array<[speaker: number | null, words: number] | "reconnect">;

/**
 * word 数つきの発話行を組む。
 *
 * **`seq` を行ごとに変え、テキストを `JITTER_CHAR_LIMIT` 超の長さにする**ので、ここで
 * 組んだ行は #36 の jitter 補正に一切掛からない。②の判定だけを観測できる状態にしている
 * （掛かってしまうと、どちらの段が効いたのか区別できないテストになる）。
 */
function islandLines(spec: IslandSpec): Line[] {
  return spec.map((e, i) =>
    e === "reconnect" ? reconnect(i) : { text: LONG, speaker: e[0], t: i, seq: i + 1, w: e[1] },
  );
}

/** 計画を立てる。**統計は必ず raw の行から取る**（本番の `groupUtterances()` と同じ） */
function planOf(lines: Line[], expectedSpeakers: string = EXPECTED_2) {
  return planMinorIslandMerges(lines, {
    expectedSpeakers,
    stats: collectSpeakerStats(lines),
  });
}

/** グループの話者列。段落がどう割れたかだけを見る */
function speakersOf(groups: Array<Record<string, unknown>>): Array<number | null> {
  return groups.map((g) => (g.type === "reconnect" ? null : ((g.speaker ?? null) as number | null)));
}

/**
 * 実機で観測された形（2人の会話なのに4 speaker 検出）。
 * `0: 646 / 1: 11 / 2: 160 / 3: 4` word。**この Issue の出発点になった1サンプル**。
 */
const OBSERVED: IslandSpec = [
  [0, 646],
  [1, 11],
  [2, 160],
  [3, 4],
];

test("想定2人・検出3で、主要 speaker に挟まれた minor の島を主要側へ寄せる", () => {
  // 0 → 2(minor) → 0 の島。テキストも行数も変わらず、speaker ラベルだけが 0 になる
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 5],
    [0, 50],
    [1, 60],
  ]);
  const plan = planOf(lines);
  assert.equal(plan.disabledBy, null);
  assert.deepEqual(plan.merges, [{ from: 2, to: 0, segments: 1, words: 5, indexes: [3] }]);
  // 段落は 0 / 1 / 0 / 1 の4つ。島は真ん中の 0 に取り込まれる
  assert.deepEqual(speakersOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [0, 1, 0, 1]);
});

test("検出4でも主要 speaker は上位2名（実機で観測された割合）", () => {
  // **降順の順位で選ぶ**ので、speaker 番号の順（0,1）ではなく 0 と 2 が主要になる
  const plan = planOf(islandLines(OBSERVED));
  assert.deepEqual(plan.majors, [0, 2]);
  assert.deepEqual(plan.minors, [1, 3]);
});

test("前後の主要 speaker が違えば補正しない（2 → 3 → 0 のような並び）", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 60],
    [2, 5],
    [1, 80],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.skipped.mismatch, 1, "見送りの理由が読めないと閾値を決められない");
  assert.deepEqual(speakersOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [0, 1, 0, 2, 1]);
});

test("minor の割合が閾値を超えていれば島とみなさない", () => {
  // 閾値のすぐ上に置く。リテラルで書くと MINOR_ISLAND_MAX_RATIO を動かした瞬間に意図がずれる
  const majors = 1000;
  const over = Math.ceil((majors * MINOR_ISLAND_MAX_RATIO) / (1 - MINOR_ISLAND_MAX_RATIO)) + 1;
  const lines = islandLines([
    [0, majors * 0.6],
    [1, majors * 0.2],
    [0, majors * 0.2],
    [2, over],
    [0, 1],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.minors, [], "閾値を超える speaker は minor ではない");
  assert.deepEqual(plan.merges, []);
  // **相対判定(#59)でも minor にならない値であること。** この fixture は絶対閾値の境界を見るのが
  // 主題なので、相対判定の範囲に入っていると「絶対で落ちた」のか「相対で拾われた」のか読めなくなる
  const [j] = plan.minorJudgements;
  assert.equal(j.speaker, 2);
  assert.ok(
    j.relativeRatio != null && j.relativeRatio > MINOR_ISLAND_RELATIVE_MAX_RATIO,
    `fixture が相対判定の範囲に入っている（相対比 ${j.relativeRatio}）`,
  );
  assert.equal(j.kind, "none");
});

test("想定話者数が自動なら1件も補正しない（disabledBy: auto）", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 5],
    [0, 50],
    [1, 60],
  ]);
  const plan = planOf(lines, "auto");
  assert.equal(plan.disabledBy, "auto");
  assert.deepEqual(plan.merges, []);
  // 既定（引数なし）も同じ。#36 までの呼び出し側は挙動が変わらない
  assert.deepEqual(speakersOf(groupUtterances(lines)), [0, 1, 0, 2, 0, 1]);
});

test("検出数が想定以下なら補正しない（disabledBy: detectedNotOver）", () => {
  // 検出3・想定3。speaker を減らす理由が無い
  const plan = planOf(
    islandLines([
      [0, 150],
      [1, 100],
      [0, 50],
      [2, 5],
      [0, 50],
    ]),
    "3",
  );
  assert.equal(plan.disabledBy, "detectedNotOver");
  assert.deepEqual(plan.merges, []);
});

test("隣が話者不明なら見送る（不明を跨いで探さない）", () => {
  // **不明そのものへ寄せないだけでなく、跨いで向こう側を「隣」とも見ない。**
  // 跨ぐと `A → X → ? → X → A` で run の反対側の同じ minor が隣として見つかり、
  // 「前後の主要 speaker が不一致」という事実と違う理由で計上される。
  // `speaker-stats.js` が「不明をまたいで遷移を数えない」としているのと同じ理屈
  const lines = islandLines([
    [null, 10],
    [2, 5],
    [null, 10],
    [0, 150],
    [1, 100],
    [0, 60],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.skipped.unknown, 1, "隣が話者不明なので見送る");
  assert.equal(plan.skipped.edge, 0, "端ではなく不明として数える");
  // 島の speaker は 2 のまま
  assert.deepEqual(speakersOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [
    null,
    2,
    null,
    0,
    1,
    0,
  ]);
});

test("再接続の境界を越えて補正しない（disabledBy ではなく skipped.boundary）", () => {
  // 再接続後は話者番号が振り直しで、同じ番号でも別人でありうる
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 60],
    "reconnect",
    [2, 5],
    [0, 50],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.skipped.boundary, 1);
});

test("raw の入力配列も要素も書き換えない", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 5],
    [0, 50],
    [1, 60],
  ]);
  const snapshot = structuredClone(lines);
  groupUtterances(lines, { expectedSpeakers: EXPECTED_2 });
  planOf(lines);
  const out = smoothMinorSpeakerIslands(lines, {
    expectedSpeakers: EXPECTED_2,
    stats: collectSpeakerStats(lines),
  }) as Line[];
  assert.deepEqual(lines, snapshot, "localStorage に保存される raw が補正で汚れてはいけない");
  assert.notEqual(out[3], lines[3], "入力の要素をそのまま返している（破壊的変更の危険）");
});

test("island 補正でもテキストと行数は1つも変わらない", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 5],
    [0, 50],
    [1, 60],
  ]);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
    Record<string, unknown>
  >;
  assert.equal(
    groups.flatMap((g) => g.texts as string[]).join(""),
    lines.map((l) => l.text).join(""),
  );
  assert.equal(
    groups.reduce((n: number, g) => n + (g.texts as string[]).length, 0),
    lines.length,
  );
});

test("既存の jitter fixture は想定話者数を渡しても結果が変わらない（#36 の退行検出）", () => {
  // fixture の行は `w` を持たず総量も小さいので、②のゲート（総量）で必ず無効になる。
  // **#48 が #36 の判定へ滲み出していないこと**の担保
  for (const c of cases) {
    const lines = linesOf(c);
    assert.deepEqual(
      groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }),
      groupUtterances(lines),
      `${c.id}: 想定話者数の有無で結果が変わった`,
    );
    // ゲートのどれで止まるかはケースによる（検出数が想定以下 / 総量不足）。
    // 固定したいのは「必ずゲートで止まる」ことなので、理由は null でないことだけ見る
    assert.notEqual(planOf(lines).disabledBy, null, `${c.id}: ②が有効になっている`);
  }
});

/**
 * **閾値ちょうどは通す。** `<` と `<=` を取り違えると、境界の1件だけが静かに落ちる／
 * 通る。実データで閾値を動かすとき、まず疑うのが境界の向きなので固定しておく。
 */
test("総 word 数が閾値ちょうどなら補正する（未満で無効）", () => {
  const island = 3;
  const build = (total: number) => {
    const rest = total - island - 2; // 島を主要 speaker で挟むぶん（前後1 word ずつ）
    return islandLines([
      [0, Math.ceil(rest / 2)],
      [1, Math.floor(rest / 2)],
      [0, 1],
      [2, island],
      [0, 1],
    ]);
  };
  const just = build(MIN_TOTAL_WORDS_FOR_ISLANDS);
  assert.equal(collectSpeakerStats(just).totalWords, MIN_TOTAL_WORDS_FOR_ISLANDS);
  assert.equal(planOf(just).disabledBy, null, "ちょうどで無効になっている");
  assert.equal(planOf(just).merges.length, 1);

  const below = build(MIN_TOTAL_WORDS_FOR_ISLANDS - 1);
  assert.equal(planOf(below).disabledBy, "tooFewWords", "1つ下で有効になっている");
});

test("run が上限ちょうどなら補正する（1つ超えたら見送る）", () => {
  // 島が minor（3%未満）でいられるだけの総量を確保する。**閾値の向きだけを見るテスト**
  const build = (island: number) =>
    islandLines([
      [0, 600],
      [1, 400],
      [0, 600],
      [2, island],
      [0, 600],
    ]);
  const just = planOf(build(MINOR_ISLAND_MAX_WORDS));
  assert.equal(just.merges.length, 1, "ちょうど上限で見送られている");
  assert.equal(just.skipped.tooLong, 0);

  const over = planOf(build(MINOR_ISLAND_MAX_WORDS + 1));
  assert.deepEqual(over.merges, [], "1つ超えたのに補正している");
  assert.equal(over.skipped.tooLong, 1);
});

/**
 * **統合先にも割合の下限が要る。** 上位 N を順位だけで取ると、「このコードが minor と
 * 判定するはずの割合しか持たない speaker」が統合先になれてしまう。1人が支配的で
 * 残りが全員小さい分布（diarization が崩れたとき現実に起きる）で踏む。
 */
test("主要 speaker が minor と同じ割合しか持たないなら統合先にしない", () => {
  const lines = islandLines([
    [0, 900], // 94.6%
    [1, 25], // 2.6% — 上位2位だが MINOR_ISLAND_MAX_RATIO 未満
    [0, 900],
    [2, 24], // 2.5%
    [1, 1],
    [3, 2], // 0.2%
    [1, 1],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.majors, [0], "割合が閾値未満の speaker を主要にしている");
  assert.ok(plan.minors.includes(3), "minor の判定は変わらない");
  assert.deepEqual(plan.merges, [], "minor へ寄せてはいけない（誤りを別の誤りに置き換えるだけ）");
});

/**
 * **分母が文字数へ落ちるセッションでは補正しない。** 閾値は word 数で決めた値で、
 * 文字数に当てると意味が変わり、しかも逆方向にずれる（`MINOR_ISLAND_MAX_WORDS` は
 * 厳しくなって取りこぼし、`MIN_TOTAL_WORDS_FOR_ISLANDS` は**緩くなって危険側**）。
 */
test("比率の基準が文字数なら補正しない", () => {
  // `w` を1件も持たない行だけ = #46 以前に保存されたセッションの復元経路
  const lines = [
    { text: "x".repeat(120), speaker: 0, t: 1, seq: 1 },
    { text: "x".repeat(3), speaker: 2, t: 2, seq: 2 },
    { text: "x".repeat(120), speaker: 0, t: 3, seq: 3 },
    { text: "x".repeat(60), speaker: 1, t: 4, seq: 4 },
  ];
  const stats = collectSpeakerStats(lines);
  assert.equal(stats.ratioBasis, "chars", "fixture が word 基準になっている");
  assert.equal(stats.detected, 3, "検出が想定を超えていないと別の理由で無効になる");
  const plan = planMinorIslandMerges(lines, { expectedSpeakers: EXPECTED_2, stats });
  assert.equal(plan.disabledBy, "charsBasis");
  assert.deepEqual(plan.merges, []);
});

/**
 * **統計そのものが壊れていたら黙って素通りさせない。** `detected` や `speakers` が
 * 無い形を渡されると、ゲートを抜けた先の `[...s.speakers]` で TypeError になる。
 */
test("壊れた統計を渡されたら補正しない", () => {
  const lines = islandLines(OBSERVED);
  for (const stats of [{}, { detected: 3 }, { detected: "3", speakers: [] }]) {
    const plan = planMinorIslandMerges(lines, { expectedSpeakers: EXPECTED_2, stats: stats as never });
    assert.equal(plan.disabledBy, "noStats", JSON.stringify(stats));
  }
});

test("同じ from → to の島が複数あれば件数と word 数を合算する", () => {
  // 診断に出す「3 seg / 11 word」はこの合算から出る。**内訳が読めないと閾値を決められない**
  const lines = islandLines([
    [0, 150],
    [2, 3],
    [0, 40],
    [2, 4],
    [0, 40],
    [1, 100],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, [{ from: 2, to: 0, segments: 2, words: 7, indexes: [1, 3] }]);
});

/**
 * **1行ずつ判定すると一度も発火しない。** `A → X → X → A` では、1つ目の X の次は X、
 * 2つ目の X の前は X なので、どちらも「前後が同じ主要 speaker」に当たらない。
 * 実データはこの形で出るので、run（同一 minor の連続）として切り出す必要がある。
 */
test("同一 minor が連続していても1つの島として吸収する", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 3],
    [2, 4],
    [0, 50],
    [1, 60],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, [{ from: 2, to: 0, segments: 2, words: 7, indexes: [3, 4] }]);
  assert.deepEqual(speakersOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [0, 1, 0, 1]);
});

/**
 * **`X → Y` という遷移そのものが観測された話者交代。** またいで両方を A へ寄せると、
 * 観測した事実を消すことになる。少数派どうしの取り違えは「どちらが誰か」の問題であって、
 * 「島かどうか」の問題ではない。
 */
test("別の minor が隣接していれば run を切り、どちらも補正しない", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 3],
    [3, 4],
    [0, 50],
    [1, 60],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.minors, [2, 3]);
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.skipped.mismatch, 2, "2つの run がそれぞれ前後不一致で落ちる");
  assert.deepEqual(speakersOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [
    0, 1, 0, 2, 3, 0, 1,
  ]);
});

test("run の合計 word 数が上限を超えたら吸収せず skipped.tooLong に数える", () => {
  // 長い誤割り当て区間は「本物の発話が別 speaker に付いた」可能性があるので吸収しない
  const lines = islandLines([
    [0, 600],
    [1, 400],
    [0, 100],
    [2, MINOR_ISLAND_MAX_WORDS + 1],
    [0, 100],
    [1, 100],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.minors, [2], "割合の条件は満たしている（落ちた理由は長さだけ）");
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.skipped.tooLong, 1);
});

test("総 word 数が閾値未満なら補正しない（disabledBy: tooFewWords）", () => {
  // 序盤は主要 speaker の順位が信用できない。**最初の数発話で順位が決まってしまう**
  const lines = islandLines([
    [0, 60],
    [1, 50],
    [0, 20],
    [2, 2],
    [0, 20],
    [1, 30],
  ]);
  const total = lines.reduce((n: number, l) => n + (l.w ?? 0), 0);
  assert.ok(total < MIN_TOTAL_WORDS_FOR_ISLANDS, "fixture の総量が閾値を超えている");
  assert.equal(planOf(lines).disabledBy, "tooFewWords");
});

test("「4人以上」では補正しない（disabledBy: atLeast）", () => {
  // **`count === 4` のハードコードにしない。** 「4人ちょうど」の選択肢を将来足したときに
  // 黙って壊れるので、「以上」かどうかを選択肢の定義から引く
  const plan = planOf(islandLines(OBSERVED), "4plus");
  assert.equal(plan.disabledBy, "atLeast");
  assert.deepEqual(plan.merges, []);
});

test("主要 speaker の tie-break は speaker 番号の昇順で決定的", () => {
  // 同数が上位 N の境界にまたがると順位が不定になり、同じ入力から違う補正結果が出る
  const spec: IslandSpec = [
    [0, 300],
    [1, 100],
    [2, 100],
    [3, 4],
    [0, 100],
  ];
  const plan = planOf(islandLines(spec));
  assert.deepEqual(plan.majors, [0, 1], "同数なら speaker 番号の小さい方が上位");
  // 行の並びを変えても順位は変わらない（走査順に依存していない）
  const reordered = planOf(islandLines([spec[2], spec[1], spec[0], spec[3], spec[4]]));
  assert.deepEqual(reordered.majors, plan.majors);
});

/**
 * **①jitter → ②island の順序を入れ替えたら落ちるテスト。**
 *
 * `A → X → [jitter B] → X → A` では、①を通す前は `X` の run が B で分断されており、
 * どちらの run も「前後が同じ主要 speaker」に当たらない。①が B を X へ直すと
 * `A → X X X → A` が見えるようになり、②が1つの島として吸収できる。
 *
 * 順序は `groupUtterances()` の中に閉じてある（呼び出し側の規律にしていない）。
 */
test("jitter 補正を先に通すことで初めて見える島がある（①→②の順序）", () => {
  const S = 99; // 同じ final 由来を表す seq。3行が揃って初めて jitter と判定される
  const lines: Line[] = [
    { text: LONG, speaker: 0, t: 0, seq: 1, w: 150 },
    { text: LONG, speaker: 1, t: 1, seq: 2, w: 100 },
    { text: LONG, speaker: 0, t: 2, seq: 3, w: 60 },
    { text: LONG, speaker: 2, t: 3, seq: S, w: 3 },
    { text: SHORT, speaker: 1, t: 4, seq: S, w: 1 }, // ← jitter。前後が speaker 2
    { text: LONG, speaker: 2, t: 5, seq: S, w: 3 },
    { text: LONG, speaker: 0, t: 6, seq: 4, w: 60 },
    { text: LONG, speaker: 1, t: 7, seq: 5, w: 60 },
  ];
  // ②だけを raw に当てても1件も補正できない（run が jitter 行で分断されている）
  const rawPlan = planOf(lines);
  assert.deepEqual(rawPlan.merges, []);
  assert.equal(rawPlan.skipped.mismatch, 2);
  // ①を通した後なら1つの島として見える。**統計は raw から取る**ので majors は動かない
  const jittered = smoothSpeakerJitter(lines) as Line[];
  const afterJitter = planMinorIslandMerges(jittered, {
    expectedSpeakers: EXPECTED_2,
    stats: collectSpeakerStats(lines),
  });
  assert.deepEqual(afterJitter.merges, [
    { from: 2, to: 0, segments: 3, words: 7, indexes: [3, 4, 5] },
  ]);
  // groupUtterances() が①→②の順で通すので、島は 0 の段落に取り込まれる
  assert.deepEqual(speakersOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [0, 1, 0, 1]);
});

test("見送りの内訳が理由ごとに数えられる", () => {
  // **内訳が無いと人が閾値を決められない。** 「run が長い」が多ければ
  // MINOR_ISLAND_MAX_WORDS が狭すぎる、と実データから読める
  const lines = islandLines([
    [2, 3], // 端（前に確定 speaker が無い）
    [0, 600],
    [1, 400],
    [0, 100],
    [2, 3], // 前後不一致（0 → 2 → 1）
    [1, 100],
    [0, 100],
    [2, MINOR_ISLAND_MAX_WORDS + 1], // 長すぎる
    [0, 100],
    "reconnect",
    [2, 3], // 再接続境界
    [0, 100],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.skipped, { mismatch: 1, tooLong: 1, edge: 1, boundary: 1, unknown: 0 });
});

test("A → X → ? → X → A は不一致ではなく「隣が話者不明」として見送る", () => {
  // 跨いで探すと、run の反対側にいる**同じ minor X** が隣として見つかり、
  // 前後が 2 と 2 で一致してしまう／または不一致として計上される。どちらにせよ
  // 「前後の主要 speaker が不一致」は事実ではない。内訳は閾値を決める材料なので、
  // 事実と違うラベルが混ざると `MINOR_ISLAND_MAX_WORDS` を判断できなくなる
  const lines = islandLines([
    [0, 300],
    [1, 200], // 検出3人にする（想定2人を超えないとゲートで無効になる）
    [0, 300],
    [2, 3],
    [null, 4],
    [2, 3],
    [0, 300],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.majors, [0, 1]);
  assert.deepEqual(plan.minors, [2]);
  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.skipped, { mismatch: 0, tooLong: 0, edge: 0, boundary: 0, unknown: 2 });
});

// ---- minor 候補の判定を「絶対 OR 相対（絶対上限つき）」にする（#59） ----
//
// 固定したいのは4つ。
// 1. **絶対判定は据え置き** — `ratio < MINOR_ISLAND_MAX_RATIO` は従来どおり minor。#48 の fixture は
//    1本も結果が変わらない
// 2. **相対判定** — 「統合先になれる主要 speaker の最小割合」に対する比が
//    `MINOR_ISLAND_RELATIVE_MAX_RATIO` 以下、かつ絶対割合が `MINOR_ISLAND_RELATIVE_CAP_RATIO` 未満なら minor。
//    実機 2 サンプル目（`56.6% / 40.0% / 3.4%`、想定 2 人）を拾うための経路
// 3. **1 speaker 1 種別** — 両方に当たれば `absolute` に 1 回だけ数える。内訳は閾値を決める材料なので二重に数えない
// 4. **minor 判定後は現行の②③をそのまま流れる** — island 条件・中立化のルールは変えない
//
// fixture は合成データ。word 数の比だけが判定に効く。

/** 実機 2 サンプル目と同じ比（566 / 400 / 34）。minor 側は run 長の上限に掛からないよう 2 つの島に割る */
const RELATIVE_SPEC: IslandSpec = [
  [0, 300],
  [1, 400],
  [0, 100],
  [2, 17],
  [0, 100],
  [2, 17],
  [0, 66],
];

/** 判定明細から speaker → 種別の対応だけを取る */
function kindsOf(plan: ReturnType<typeof planOf>): Record<number, string> {
  return Object.fromEntries(plan.minorJudgements.map((j) => [j.speaker, j.kind]));
}

test("固定 3% を超える extra speaker でも、主要 speaker との差が十分大きければ相対判定で minor になる", () => {
  const lines = islandLines(RELATIVE_SPEC);
  const stats = collectSpeakerStats(lines);
  const extra = stats.speakers.find((x) => x.speaker === 2)!;
  assert.ok(extra.ratio >= MINOR_ISLAND_MAX_RATIO, "fixture が絶対閾値の内側にある（相対判定を観測できない）");

  const plan = planOf(lines);
  assert.deepEqual(plan.majors, [0, 1]);
  assert.deepEqual(plan.minors, [2]);
  assert.deepEqual(plan.others, []);
  assert.deepEqual(plan.minorKinds, { absolute: 0, relative: 1, none: 0 });
  const [j] = plan.minorJudgements;
  assert.equal(j.kind, "relative");
  assert.equal(plan.smallestMajorRatio, stats.speakers.find((x) => x.speaker === 1)!.ratio);
  assert.ok(j.relativeRatio != null && j.relativeRatio <= MINOR_ISLAND_RELATIVE_MAX_RATIO);
  // 島は現行②の条件でそのまま寄る（`0 → 2 → 0` が 2 つ）
  assert.deepEqual(plan.merges, [{ from: 2, to: 0, segments: 2, words: 34, indexes: [3, 5] }]);
  assert.deepEqual(speakersOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [0, 1, 0]);
});

test("絶対閾値未満の speaker は従来どおり absolute として minor になる", () => {
  // 700 / 280 / 20 = 2%
  const lines = islandLines([
    [0, 400],
    [1, 280],
    [0, 290],
    [2, 20],
    [0, 10],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.minors, [2]);
  assert.deepEqual(plan.minorKinds, { absolute: 1, relative: 0, none: 0 });
  assert.deepEqual(plan.merges, [{ from: 2, to: 0, segments: 1, words: 20, indexes: [3] }]);
});

test("相対比も絶対上限も超える speaker（60% / 30% / 10%）は minor にしない", () => {
  const lines = islandLines([
    [0, 300],
    [1, 300],
    [0, 300],
    [2, 100],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.minors, []);
  assert.deepEqual(plan.others, [2]);
  assert.deepEqual(plan.minorKinds, { absolute: 0, relative: 0, none: 1 });
  assert.deepEqual(plan.merges, []);
  const [j] = plan.minorJudgements;
  assert.ok(j.relativeRatio! > MINOR_ISLAND_RELATIVE_MAX_RATIO);
  assert.ok(j.ratio >= MINOR_ISLAND_RELATIVE_CAP_RATIO);
});

test("主要 speaker に近い extra speaker（50% / 30% / 20%）は minor にしない", () => {
  const lines = islandLines([
    [0, 250],
    [1, 300],
    [0, 250],
    [2, 200],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.majors, [0, 1], "順位は word 数の降順（0 が 500、1 が 300）");
  assert.deepEqual(plan.minors, []);
  assert.deepEqual(plan.others, [2]);
  assert.equal(kindsOf(plan)[2], "none");
});

/**
 * **絶対上限が単独で効くこと。** 想定 2 人の実分布では「最小の主要 speaker」が 50% を超えることは
 * 無いので、現行値（相対 0.10 / 上限 5%）では上限が効く分布は作れない — 上限は相対閾値を
 * 広げたときの歯止めであり、その歯止めそのものを固定するために統計を直接与える
 * （`planMinorIslandMerges()` は `stats` の整合性を検証しない）。
 */
test("相対比が閾値以下でも絶対割合が上限以上なら minor にしない（上限が単独で効く）", () => {
  const cap = MINOR_ISLAND_RELATIVE_CAP_RATIO;
  const rel = MINOR_ISLAND_RELATIVE_MAX_RATIO;
  // 上限ちょうどの extra と、相対比が閾値の内側（0.083）に収まる主要 speaker。
  // **相対の境界は別のテストで見る**ので、ここは境界から離して「上限だけで落ちる」ことを固定する
  const stats = {
    detected: 3,
    ratioBasis: "words",
    totalWords: MIN_TOTAL_WORDS_FOR_ISLANDS,
    speakers: [
      { speaker: 0, words: 1000, ratio: 0.9 },
      { speaker: 1, words: 800, ratio: (cap / rel) * 1.2 },
      { speaker: 2, words: 50, ratio: cap },
    ],
  };
  const lines = islandLines([
    [0, 100],
    [1, 100],
    [2, 5],
    [1, 100],
  ]);
  const plan = planMinorIslandMerges(lines, { expectedSpeakers: EXPECTED_2, stats: stats as never });
  assert.equal(plan.disabledBy, null);
  const [j] = plan.minorJudgements;
  assert.equal(j.speaker, 2);
  assert.ok(j.relativeRatio! < rel, "fixture の相対比が閾値の内側にない");
  assert.equal(j.kind, "none", "上限以上を相対判定で minor にしている");
  assert.deepEqual(plan.minors, []);
});

test("絶対割合が上限未満でも相対比が閾値を超えれば minor にしない（相対が単独で効く）", () => {
  // 800 / 150 / 40 → extra は 4.0%（上限未満、絶対閾値以上）、最小の主要 15.2% に対して 0.27
  const lines = islandLines([
    [0, 400],
    [1, 150],
    [0, 400],
    [2, 40],
  ]);
  const plan = planOf(lines);
  const [j] = plan.minorJudgements;
  assert.ok(j.ratio >= MINOR_ISLAND_MAX_RATIO && j.ratio < MINOR_ISLAND_RELATIVE_CAP_RATIO, "fixture が上限の内側にない");
  assert.ok(j.relativeRatio! > MINOR_ISLAND_RELATIVE_MAX_RATIO);
  assert.equal(j.kind, "none");
  assert.deepEqual(plan.minors, []);
});

test("相対比がちょうど閾値なら minor になる（以下）", () => {
  // 500 / 500 / 50 → 50 / 500 = 0.1 ちょうど。extra は 4.76% で上限未満・絶対閾値以上
  const lines = islandLines([
    [0, 500],
    [1, 500],
    [2, 50],
  ]);
  const plan = planOf(lines);
  const [j] = plan.minorJudgements;
  assert.equal(j.relativeRatio, MINOR_ISLAND_RELATIVE_MAX_RATIO, "fixture が閾値ちょうどになっていない");
  assert.ok(j.ratio >= MINOR_ISLAND_MAX_RATIO && j.ratio < MINOR_ISLAND_RELATIVE_CAP_RATIO);
  assert.equal(j.kind, "relative");
});

test("主要 speaker 側も小さい分布（90% / 4% / 3.4%）では相対判定で minor にしない", () => {
  const lines = islandLines([
    [0, 450],
    [1, 40],
    [0, 450],
    [2, 34],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.majors, [0, 1], "4% は絶対閾値以上なので主要");
  const [j] = plan.minorJudgements;
  assert.ok(j.relativeRatio! > MINOR_ISLAND_RELATIVE_MAX_RATIO, "3.4 / 4 は 0.85");
  assert.equal(j.kind, "none");
  assert.deepEqual(plan.others, [2]);
});

/**
 * **主要 speaker が 1 人も残らなければ相対判定の基準が無い。** 実分布では最上位が 3% 未満になることは
 * 無いので統計を直接与える（`stats` の整合性は検証されない）。基準が無い以上、絶対判定だけで決める。
 */
test("主要 speaker が空なら相対判定を行わない（基準は null）", () => {
  const stats = {
    detected: 3,
    ratioBasis: "words",
    totalWords: MIN_TOTAL_WORDS_FOR_ISLANDS,
    speakers: [
      { speaker: 0, words: 2, ratio: 0.02 },
      { speaker: 1, words: 2, ratio: 0.02 },
      { speaker: 2, words: 4, ratio: 0.025 },
    ],
  };
  const lines = islandLines([
    [0, 100],
    [1, 100],
    [2, 5],
  ]);
  const plan = planMinorIslandMerges(lines, { expectedSpeakers: EXPECTED_2, stats: stats as never });
  assert.equal(plan.disabledBy, null);
  assert.deepEqual(plan.majors, []);
  assert.equal(plan.smallestMajorRatio, null);
  for (const j of plan.minorJudgements) {
    assert.equal(j.relativeRatio, null);
    assert.ok(j.kind === "absolute" || j.kind === "none");
  }
  assert.deepEqual(kindsOf(plan), { 0: "absolute", 1: "absolute", 2: "absolute" });
  assert.deepEqual(plan.merges, [], "統合先が無いので何も寄らない");
});

test("想定話者数が自動なら判定明細も空（disabledBy: auto）", () => {
  const plan = planOf(islandLines(RELATIVE_SPEC), "auto");
  assert.equal(plan.disabledBy, "auto");
  assert.deepEqual(plan.minorJudgements, []);
  assert.deepEqual(plan.minorKinds, { absolute: 0, relative: 0, none: 0 });
  assert.equal(plan.smallestMajorRatio, null);
});

test("検出が想定以下なら判定明細も空（disabledBy: detectedNotOver）", () => {
  const plan = planOf(
    islandLines([
      [0, 300],
      [1, 200],
    ]),
  );
  assert.equal(plan.disabledBy, "detectedNotOver");
  assert.deepEqual(plan.minorJudgements, []);
  assert.deepEqual(plan.minorKinds, { absolute: 0, relative: 0, none: 0 });
});

test("絶対と相対の両方に当たる speaker は absolute に 1 回だけ数える", () => {
  // 600 / 380 / 20 → 2%（絶対閾値未満）かつ 20 / 380 = 0.053（相対閾値以下）
  const lines = islandLines([
    [0, 600],
    [1, 380],
    [2, 20],
  ]);
  const plan = planOf(lines);
  const [j] = plan.minorJudgements;
  assert.ok(j.ratio < MINOR_ISLAND_MAX_RATIO && j.relativeRatio! <= MINOR_ISLAND_RELATIVE_MAX_RATIO);
  assert.equal(j.kind, "absolute");
  assert.deepEqual(plan.minorKinds, { absolute: 1, relative: 0, none: 0 });
});

test("主要 speaker が同数でも判定は決定的で、行の並びを変えても同じ明細になる", () => {
  // 480 / 480 / 40 → extra 4%、相対比 0.083
  const spec: IslandSpec = [
    [1, 240],
    [0, 480],
    [2, 20],
    [1, 240],
    [2, 20],
  ];
  const plan = planOf(islandLines(spec));
  assert.deepEqual(plan.majors, [0, 1], "同数なら speaker 番号の小さい方が上位");
  assert.equal(kindsOf(plan)[2], "relative");
  const reordered = planOf(islandLines([...spec].reverse()));
  assert.deepEqual(reordered.majors, plan.majors);
  assert.deepEqual(reordered.minorJudgements, plan.minorJudgements);
  assert.deepEqual(reordered.smallestMajorRatio, plan.smallestMajorRatio);
});

test("0 word の speaker と話者不明の行があっても例外にならず、0 word は absolute", () => {
  const lines = islandLines([
    [0, 300],
    [1, 200],
    [null, 3],
    [3, 0],
    [0, 10],
  ]);
  const plan = planOf(lines);
  assert.equal(plan.disabledBy, null);
  assert.equal(kindsOf(plan)[3], "absolute");
  assert.ok(plan.minorJudgements.every((j) => Number.isFinite(j.ratio)));
});

test("判定は入力の行と統計を変更しない", () => {
  const lines = islandLines(RELATIVE_SPEC);
  const stats = collectSpeakerStats(lines);
  const linesBefore = structuredClone(lines);
  const statsBefore = structuredClone(stats);
  planMinorIslandMerges(lines, { expectedSpeakers: EXPECTED_2, stats });
  assert.deepEqual(lines, linesBefore);
  assert.deepEqual(stats, statsBefore);
});

test("同じ入力なら同じ計画になる（純関数）", () => {
  const lines = islandLines(RELATIVE_SPEC);
  assert.deepEqual(planOf(lines), planOf(lines));
});

/**
 * 相対判定の絶対上限は診断の警告線（`MINOR_SPEAKER_RATIO`）と同じ値に置いてある —
 * 「診断が疑わない割合の speaker を機械が相対判定で寄せることはない」という関係。
 * 定数は役割が違うので別に持つが、片方だけ動かすのは意図的な判断であるべきなのでここで固定する。
 */
test("相対判定の絶対上限は診断の警告線と同じ値", () => {
  assert.equal(MINOR_ISLAND_RELATIVE_CAP_RATIO, MINOR_SPEAKER_RATIO);
  assert.ok(MINOR_ISLAND_MAX_RATIO < MINOR_ISLAND_RELATIVE_CAP_RATIO, "絶対閾値より上限が小さいと相対判定が成立しない");
});

test("種別のキー列は順序も含めて固定（無効な計画でも全キーを持つ）", () => {
  // ⓪の `kinds` と同じく直書きで固定する。定数と突き合わせると種別を足しても順序を変えても通ってしまう
  assert.deepEqual(Object.keys(planMinorIslandMerges([]).minorKinds), ["absolute", "relative", "none"]);
});

test("相対判定で minor になった speaker も、前後の主要 speaker が違えば③で中立化される", () => {
  // 550 / 416 / 34 → extra 3.4% は相対判定。`0 → 2 → 1` が 2 か所
  const lines = islandLines([
    [1, 300],
    [0, 300],
    [2, 17],
    [1, 100],
    [0, 250],
    [2, 17],
    [1, 16],
  ]);
  const plan = planOf(lines);
  assert.equal(kindsOf(plan)[2], "relative");
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.skipped.mismatch, 2);
  const neutral = planUnresolvedMinors(plan);
  assert.equal(neutral.disabledBy, null);
  assert.deepEqual(neutral.neutralized, [{ speaker: 2, segments: 2, words: 34, indexes: [2, 5] }]);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(speakersOf(groups), [1, 0, 2, 1, 0, 2, 1]);
  assert.deepEqual(unresolvedOf(groups), [false, false, true, false, false, true, false]);
});

// ---- 統合先を決められなかった minor speaker の中立化（#50） ----
//
// #48 は `A → X → A`（前後が同じ主要 speaker）だけを安全に統合し、`B → X → A`
// （前後の主要 speaker が違う ＝ `skipped.mismatch`）は見送った。見送ったぶんは
// **表示上「話者C」として残る** ので、2人だと申告した会話に第三者が現れる。
//
// 固定したいのは4つ。
// 1. **対象は `mismatch` だけ** — `tooLong` / `boundary` / `edge` / `unknown` は残す
//    （前者は「本物の発話かもしれない」、後者3つは「そもそも隣を見られなかった」）
// 2. **`speaker` を潰さない** — `unresolved` の印を立てるだけ。潰すと `mergeSameSpeaker()` の
//    `null === null` で隣接した異なる minor が1段落に溶け、観測された話者交代が消える
// 3. **中立化した行は前とも後とも結合しない** — `{ type: "reconnect" }` と同じ独立グループ
// 4. **②のゲートがそのまま③のゲート** — ②が無効なら③も無効（独自のゲートを足さない）
//
// fixture はここでも合成データ。文字列は長さにしか意味が無い。

/**
 * `0 → 2 → 1`。②は「前後の主要 speaker が違う」として見送り、③がその 2 を中立化する。
 * **この Issue が扱う形そのもの。**
 */
const MISMATCH_SPEC: IslandSpec = [
  [0, 150],
  [1, 100],
  [0, 50],
  [2, 5],
  [1, 60],
];

/** ③の計画。②の計画を入力に取る（本番の `groupUtterances()` と同じ経路） */
function neutralPlanOf(lines: Line[], expectedSpeakers: string = EXPECTED_2) {
  return planUnresolvedMinors(planOf(lines, expectedSpeakers));
}

/** グループが中立化されているかの列。段落の割れ方と一緒に見るために speaker と分けて取る */
function unresolvedOf(groups: Array<Record<string, unknown>>): boolean[] {
  return groups.map((g) => g.unresolved === true);
}

test("前後の主要 speaker が違う minor を中立化する（0 → 2 → 1）", () => {
  const lines = islandLines(MISMATCH_SPEC);
  const plan = planOf(lines);
  // ②は見送る。**その run の行が③の入力になる**
  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.skippedRuns, [{ reason: "mismatch", speaker: 2, words: 5, indexes: [3] }]);

  const neutral = neutralPlanOf(lines);
  assert.equal(neutral.disabledBy, null);
  assert.deepEqual(neutral.neutralized, [{ speaker: 2, segments: 1, words: 5, indexes: [3] }]);
  assert.deepEqual(neutral.skippedRuns, [], "mismatch 以外の run は無い fixture");

  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
    Record<string, unknown>
  >;
  // **speaker は 2 のまま。** 表示側が中立ラベルに差し替えるだけで、raw の番号は残す
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 2, 1]);
  assert.deepEqual(unresolvedOf(groups), [false, false, false, true, false]);
});

test("#48 が統合できる島（0 → 2 → 0）は中立化しない", () => {
  // 統合先が決まるなら中立化する理由が無い。**②と③の担当が重ならないこと**の担保
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 5],
    [0, 50],
    [1, 60],
  ]);
  assert.equal(planOf(lines).merges.length, 1);
  assert.deepEqual(neutralPlanOf(lines).neutralized, []);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 1]);
  assert.deepEqual(unresolvedOf(groups), [false, false, false, false]);
});

/**
 * **異なる minor が隣接しても1段落にしない。** `A → X → Y → B` の `X → Y` は
 * 観測された話者交代そのもので、②が run を切ってまで守った不変条件。
 * `speaker` を `null` へ潰すと `mergeSameSpeaker()` の `null === null` でここが溶ける。
 */
test("隣接した別々の minor を中立化しても1段落にならない", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 3],
    [3, 4],
    [0, 50],
    [1, 60],
  ]);
  const neutral = neutralPlanOf(lines);
  // speaker ごとにまとめる（診断が `speaker 2 → 話者不明` を出せる形）
  assert.deepEqual(neutral.neutralized, [
    { speaker: 2, segments: 1, words: 3, indexes: [3] },
    { speaker: 3, segments: 1, words: 4, indexes: [4] },
  ]);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
    Record<string, unknown>
  >;
  assert.equal(groups.length, 7, "中立化した2行が1段落に溶けている");
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 2, 3, 0, 1]);
  assert.deepEqual(unresolvedOf(groups), [false, false, false, true, true, false, false]);
});

/**
 * **同じ run の連続行は1段落にまとめる。** run は「同一 minor の連続」を別 speaker・
 * 話者不明・再接続で切って作ってあるので、隣接する中立行の speaker が同じなら
 * **同じ run ＝ 1つの発話のかたまり**。ここで割ると、#36 が正面から潰した
 * 「1発話が細切れに表示される」をこの段が作り直すことになる。
 *
 * 上の「別々の minor」テストと対になっていて、**`speaker` を残しているからこの2つを
 * 区別できる**（`null` に潰すとどちらも同じ判定になる）。
 */
test("同じ run の連続する中立行は1段落にまとまる", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 3],
    [2, 3],
    [1, 60],
  ]);
  // run は1本（行は2つ）。②の見送りも1件
  assert.deepEqual(neutralPlanOf(lines).neutralized, [
    { speaker: 2, segments: 2, words: 6, indexes: [3, 4] },
  ]);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
    Record<string, unknown>
  >;
  assert.equal(groups.length, 5, "同じ run が別々の段落へ割れている");
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 2, 1]);
  assert.deepEqual(unresolvedOf(groups), [false, false, false, true, false]);
});

/**
 * **長い run は `mismatch` でも中立化しない。**
 *
 * ②の判定順は `mismatch → tooLong` なので、`B → X(長い) → A` は `mismatch` が先に立ち
 * `tooLong` に到達しない。③で長さを当て直さないと「長い run は隠さない」という
 * #48 から続く安全弁が**この段だけ効かず**、上限なしで隠すことになる。
 */
test("前後不一致でも run が長ければ③は中立化しない（tooLong に付け替えて③b が引き取る）", () => {
  const lines = islandLines([
    [0, 600],
    [1, 400],
    [0, 100],
    [2, MINOR_ISLAND_MAX_WORDS + 1],
    [1, 100],
  ]);
  // ②の内訳では `mismatch`（`tooLong` に到達していない）
  assert.deepEqual(planOf(lines).skipped, {
    mismatch: 1,
    tooLong: 0,
    edge: 0,
    boundary: 0,
    unknown: 0,
  });

  const neutral = neutralPlanOf(lines);
  assert.deepEqual(neutral.neutralized, [], "上限を超えた run を隠している");
  // 落とした run は `tooLong` に付け替えて返す。診断の「中立化の対象外」が
  // ②の「表示補正の見送り」と違う数字になるのは、この差ぶん
  assert.deepEqual(neutral.skippedRuns, [
    { reason: "tooLong", speaker: 2, words: MINOR_ISLAND_MAX_WORDS + 1, indexes: [3] },
  ]);
  // `tooLong` に付け替えた run は③b（#61）が引き取る。この fixture は絶対 minor・run 1 本・
  // `LONG_MINOR_MAX_WORDS` 以下なので③b の側で中立化されるが、**③の印ではない**
  // （③b の判定は下の #61 の節で固定する。ここで見るのは③が隠していないことだけ）
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(correction.unresolvedPlan.neutralized, [], "③が長い run を隠している");
  assert.deepEqual(
    correction.longMinorPlan.neutralized.map((n: { indexes: number[] }) => n.indexes),
    [[3]],
    "③b が tooLong の run を引き取っていない",
  );
});

/**
 * **復元データ由来の印は信じない。** `finalLines` は `localStorage` から**検証なしで**
 * 復元される（`app.js` の `finalLines.push(...session.finalLines)`）ので、`unresolved` にも
 * 任意の値が入りうる。素通りさせると、想定話者数が既定の `auto`（＝この段が無効）でも
 * 画面には中立チップが出て、診断は「無効（想定話者数が自動）」と言う —
 * **画面と診断が違う事実を語る**。
 */
test("復元された finalLines の unresolved は表示へ抜けない", () => {
  const lines = islandLines(MISMATCH_SPEC).map((l, i) =>
    i === 1 ? { ...l, unresolved: true } : l,
  ) as Line[];
  const groups = groupUtterances(lines, { expectedSpeakers: "auto" }) as Array<
    Record<string, unknown>
  >;
  assert.equal(
    unresolvedOf(groups).some(Boolean),
    false,
    "復元データの印がそのまま表示に効いている",
  );
});

/**
 * **前とも後とも結合しない。** speaker が同じでも独立させる（`{ type: "reconnect" }` と同じ扱い）。
 * ここを `mergeSameSpeaker()` に直接当てるのは、パイプラインを通すと
 * 「minor は主要と番号が違うので、そもそも結合条件に当たらない」という**別の理由**で
 * 通ってしまい、ガードそのものを固定できないため。
 */
test("中立化した行は前後が同じ話者でも独立したグループになる", () => {
  const groups = mergeSameSpeaker([
    { text: "まえ", speaker: 0, t: 0 },
    { text: "なか", speaker: 0, t: 1, unresolved: true },
    { text: "うしろ", speaker: 0, t: 2 },
  ]) as Array<Record<string, unknown>>;
  assert.deepEqual(summary(groups), [
    { speaker: 0, text: "まえ" },
    { speaker: 0, text: "なか" },
    { speaker: 0, text: "うしろ" },
  ]);
  assert.deepEqual(unresolvedOf(groups), [false, true, false]);
});

test("raw の finalLines は中立化でも書き換わらない（speaker も unresolved も付かない）", () => {
  const lines = islandLines(MISMATCH_SPEC);
  const snapshot = structuredClone(lines);
  groupUtterances(lines, { expectedSpeakers: EXPECTED_2 });
  planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(lines, snapshot, "localStorage に保存される raw が印で汚れてはいけない");
  for (const l of lines) {
    assert.equal("unresolved" in l, false, "raw に表示用の印が漏れている");
  }
});

test("中立化でもテキストと行数は1つも変わらない", () => {
  const lines = islandLines(MISMATCH_SPEC);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
    Record<string, unknown>
  >;
  assert.equal(
    groups.flatMap((g) => g.texts as string[]).join(""),
    lines.map((l) => l.text).join(""),
  );
  assert.equal(
    groups.reduce((n: number, g) => n + (g.texts as string[]).length, 0),
    lines.length,
  );
});

/**
 * **件数と run 一覧が食い違わないこと。** ③は `skippedRuns` から中立化する行を決めるので、
 * ②の内訳（人が閾値を決めるための数字）とずれると、診断の2つの節が別の事実を語り出す。
 */
test("skipped の件数と skippedRuns の理由別件数が一致する", () => {
  const lines = islandLines([
    [2, 3], // 端
    [0, 600],
    [1, 400],
    [0, 100],
    [2, 3], // 前後不一致
    [1, 100],
    [0, 100],
    [2, MINOR_ISLAND_MAX_WORDS + 1], // 長すぎる
    [0, 100],
    "reconnect",
    [2, 3], // 再接続境界
    [0, 100],
    [null, 5],
    [2, 3], // 隣が話者不明
    [null, 5],
    [0, 100],
  ]);
  const plan = planOf(lines);
  for (const reason of ["mismatch", "tooLong", "edge", "boundary", "unknown"] as const) {
    assert.equal(
      plan.skippedRuns.filter((r: { reason: string }) => r.reason === reason).length,
      plan.skipped[reason],
      `${reason}: 件数と run 一覧が食い違っている`,
    );
  }
  // 内訳そのものも固定しておく（run の切り出しが変われば両方が同時に動く）
  assert.deepEqual(plan.skipped, { mismatch: 1, tooLong: 1, edge: 1, boundary: 1, unknown: 1 });
});

/**
 * **中立化するのは `mismatch` だけ。** `tooLong` は「誤割り当てされた本物の発話」でありうるし、
 * 残り3つは「そもそも隣を見られなかった」。どちらも「統合先を決められなかった」とは意味が違う。
 */
test("tooLong / boundary / edge / unknown の run は③では中立化しない（③b の候補になるのは tooLong だけ）", () => {
  const lines = islandLines([
    [2, 3], // 端
    [0, 600],
    [1, 400],
    [0, 100],
    [2, MINOR_ISLAND_MAX_WORDS + 1], // 長すぎる
    [0, 100],
    "reconnect",
    [2, 3], // 再接続境界
    [0, 100],
    [null, 5],
    [2, 3], // 隣が話者不明
    [null, 5],
    [0, 100],
  ]);
  const plan = planOf(lines);
  assert.equal(plan.skipped.mismatch, 0, "fixture に mismatch が混ざっている");
  const neutral = neutralPlanOf(lines);
  assert.deepEqual(neutral.neutralized, []);
  // 対象外にした run は**そのまま返す**。理由別の件数を診断が出せないと、
  // `edge` / `unknown` を将来対象に加えるかどうかの材料が無くなる
  assert.deepEqual(
    neutral.skippedRuns.map((r: { reason: string }) => r.reason).sort(),
    ["boundary", "edge", "tooLong", "unknown"],
  );
  // ③b（#61）は `tooLong` だけを引き取る。`boundary` / `edge` / `unknown` は③b の候補にもならない
  // （「そもそも隣を見られなかった」run は、どの段でも隠さない）
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(correction.unresolvedPlan.neutralized, [], "対象外の run まで③が中立化している");
  assert.equal(correction.longMinorPlan.runs, 1, "tooLong 以外の run が③b の候補になっている");
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
    Record<string, unknown>
  >;
  // 中立化されるのは③b が引き取った `tooLong` の 1 行（添字 4）だけ
  assert.deepEqual(speakersOf(groups), [2, 0, 1, 0, 2, 0, null, 2, 0, null, 2, null, 0]);
  assert.deepEqual(
    unresolvedOf(groups),
    [false, false, false, false, true, false, false, false, false, false, false, false, false],
    "tooLong 以外の run まで中立化している",
  );
});

test("想定話者数が自動なら中立化しない（②のゲートをそのまま引き継ぐ）", () => {
  const lines = islandLines(MISMATCH_SPEC);
  const neutral = neutralPlanOf(lines, "auto");
  assert.equal(neutral.disabledBy, "auto", "「効いていない」と「効いた結果0件」が区別できない");
  assert.deepEqual(neutral.neutralized, []);
  // 既定（引数なし）も同じ。#36 までの呼び出し側は挙動が変わらない
  const groups = groupUtterances(lines) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 2, 1]);
  assert.equal(unresolvedOf(groups).some(Boolean), false);
});

test("検出が想定以下なら中立化しない（disabledBy: detectedNotOver）", () => {
  const lines = islandLines(MISMATCH_SPEC);
  const neutral = neutralPlanOf(lines, "3");
  assert.equal(neutral.disabledBy, "detectedNotOver");
  assert.deepEqual(neutral.neutralized, []);
});

/**
 * **`displayDetected` は「表示上の通常話者数」**（#50 で意味が変わった）。中立化した
 * speaker は画面にも Markdown にも「話者C」として出ないので、数え続けると
 * 「話者Cは表示されないのに表示上の話者数は3」という読めない値になる。
 */
test("表示上の通常話者数は中立化した speaker を数えない", () => {
  const lines = islandLines(MISMATCH_SPEC);
  assert.equal(collectSpeakerStats(lines).detected, 3, "raw の検出数は 3 のまま");
  const { displayDetected, unresolvedPlan } = planDisplayCorrection(lines, {
    expectedSpeakers: EXPECTED_2,
  });
  assert.equal(displayDetected, 2);
  // 計画も同じ1回の計算から返る（診断が別経路で立て直すと表示とずれる）
  assert.deepEqual(unresolvedPlan.neutralized, [
    { speaker: 2, segments: 1, words: 5, indexes: [3] },
  ]);
});

test("#36 の fixture は中立化の印が1つも付かない（②が無効なら③も無効）", () => {
  // fixture の行は `w` を持たず総量も小さいので②のゲートで必ず止まる。
  // **#50 が #36 / #48 の判定へ滲み出していないこと**の担保
  for (const c of cases) {
    const lines = linesOf(c);
    const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<
      Record<string, unknown>
    >;
    assert.equal(unresolvedOf(groups).some(Boolean), false, `${c.id}: 中立化されている`);
    assert.notEqual(neutralPlanOf(lines).disabledBy, null, `${c.id}: ③が有効になっている`);
  }
});

// ---- 表示補正を通しても文字数が変わらない（#52） ----
//
// #36 / #48 / #50 はいずれも `speaker` ラベルだけを直す設計なので、**空白を除いた
// 文字数は④まで保存されるはず**。テキスト完全性の表で③→④ に差が出たらそれは回帰であり、
// この不変条件がその判定の根拠そのものになる。
//
// **「テキストが変わらない」は既に固定してあるが、文字数の観点は別**。診断が読むのは
// `countTextChars()` を通した数で、そこに空白の扱い（`visibleChars`）が入る。表の④が
// 何を数えているのかを、表示側のパイプライン込みでここに固定しておく。

/** ④（`groupUtterances()` の出力）を診断と同じやり方で数える。 */
function displayedChars(lines: Line[], expectedSpeakers?: string) {
  const groups = groupUtterances(lines, { expectedSpeakers }) as Array<Record<string, unknown>>;
  return countTextChars(groups.flatMap((g) => (g.texts as string[] | undefined) ?? []));
}

/** ③（raw の `finalLines`）を診断と同じやり方で数える。再接続の印はテキストを持たない。 */
function receivedChars(lines: Line[]) {
  return countTextChars(lines.filter((l) => l.type !== "reconnect").map((l) => l.text));
}

test("#36 の jitter 補正を通しても③と④の文字数が一致する", () => {
  for (const c of cases) {
    const lines = linesOf(c);
    assert.deepEqual(
      displayedChars(lines),
      receivedChars(lines),
      `${c.id}: 表示補正で文字数が変わっている`,
    );
  }
});

test("#48 の island 補正を通しても③と④の文字数が一致する", () => {
  const lines = islandLines([
    [0, 150],
    [1, 100],
    [0, 50],
    [2, 5],
    [0, 50],
    [1, 60],
  ]);
  assert.deepEqual(displayedChars(lines, EXPECTED_2), receivedChars(lines));
});

test("#50 の中立化を通しても③と④の文字数が一致する", () => {
  const lines = islandLines(MISMATCH_SPEC);
  assert.deepEqual(displayedChars(lines, EXPECTED_2), receivedChars(lines));
});

/**
 * **空白は表示側で落ちない。** サーバー側の切り出し（`.trim()`）とフォールバック
 * （`join("")`）が空白を落とすのは①→②だけで、③→④ では素の文字数も保存される。
 * ここが崩れると「素の文字数の差は正常」という診断の注記が④まで広がってしまう。
 */
test("語間の空白も表示側では落ちない（素の文字数まで保存される）", () => {
  const lines = [
    { text: "これは AWS Lambda です。", speaker: 0, t: 0, seq: 1, w: 4 },
    { text: "はい、 なるほど。", speaker: 1, t: 1, seq: 2, w: 2 },
  ] as Line[];
  const received = receivedChars(lines);
  assert.deepEqual(displayedChars(lines, EXPECTED_2), received);
  assert.ok(received.visible < received.chars, "この fixture には空白が含まれている");
});

test("再接続を挟んでも③と④の文字数が一致する", () => {
  // 再接続の印はテキストを持たないので、③④のどちらの数にも入らない
  const lines = [
    line("あい", 0, { seq: 1 }),
    reconnect(),
    line("うえ", 0, { seq: 1 }),
  ];
  assert.deepEqual(displayedChars(lines), receivedChars(lines));
  assert.equal(receivedChars(lines).visible, 4);
});

// ---- ⓪ 同じ final の中で語の途中に入った speaker 境界の平滑化（#55） ----
//
// 固定したいのは3つ。
// 1. **同じ final の短い断片だけを隣へ寄せ、別 final は絶対に跨がない** — 別 final で届いた
//    本物の相槌は `seq` が違うので構造的に吸収されない（#36 と同じ規律）
// 2. **同じ final でも、句読点で閉じた断片・相槌語彙・両隣が異なる長い行は寄せない**
// 3. **同じ final 由来の行は区切りなしで連結される** — speaker を揃えるだけでは
//    「テキ ストを確認します」のように語の途中にスペースが残る（#55 の受け入れ条件）
//
// fixture はここでも匿名化した合成データ。文字列は長さと文字種にしか意味が無い。

/** 断片の長さ（上限ちょうど）。閾値を直接使い、値を変えてもテストの意図がずれないようにする */
const FRAG = "あ".repeat(BOUNDARY_FRAGMENT_CHAR_LIMIT);
/**
 * 断片ではない長さ（上限 + 1 = 4 文字）。`LONG` と別に持つのは、①の閾値と独立に動かせるようにするため。
 * #57 以降、この長さは (b) の本体であると同時に (a) の拡張断片でもある — `BODY` だけの fixture は
 * 6 文字以上の anchor を持たないので (a) が動かず、#55 と同じ (b) の経路を通る
 */
const BODY = "い".repeat(BOUNDARY_FRAGMENT_CHAR_LIMIT + 1);
/** (a) の anchor になる長さ（拡張上限 + 1 = 6 文字）。ひらがななので、ひらがな始まりの行とは連続性「中」 */
const ANCHOR6 = "い".repeat(BOUNDARY_EXTENDED_CHAR_LIMIT + 1);

/** グループを「話者 + 連結 run」に畳む。run の割れ方（連結子の出し分け）まで見る */
function runsOf(groups: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return groups.map((g) =>
    g.type === "reconnect" ? { type: "reconnect" } : { speaker: g.speaker, runs: g.runs },
  );
}

/** ⓪の計画。本番と同じく `planDisplayCorrection()` の1回の計算から取る */
function boundaryPlanOf(lines: Line[]) {
  return planDisplayCorrection(lines, {}).boundaryPlan;
}

/** 「1 件も見送っていない」内訳。空入力の計画から取るので、理由を足してもここは古くならない */
const NO_SKIPS = smoothSpeakerBoundaries([]).plan.skipped;
function assertNothingSkipped(plan: { skipped: Record<string, number> }) {
  assert.deepEqual(plan.skipped, NO_SKIPS);
}

test("同じ final の短い断片は隣の長い行の話者へ寄り、区切りなしで連結される", () => {
  const lines = [line(FRAG, 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 1, runs: [FRAG + BODY] }]);
  const plan = boundaryPlanOf(lines);
  assert.deepEqual(plan.applied, [{ index: 0, from: 0, to: 1, chars: FRAG.length, kind: "basic" }]);
});

test("断片が final の末尾にあれば前の行へ寄る", () => {
  const lines = [line(BODY, 1, { seq: 5 }), line(FRAG, 0, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 1, runs: [BODY + FRAG] }]);
});

test("別 final で届いた短い発話は寄せない（differentFinal）", () => {
  const lines = [line(BODY, 0, { seq: 1 }), line(FRAG, 1, { seq: 2 }), line(BODY, 0, { seq: 3 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [
    { speaker: 0, runs: [BODY] },
    { speaker: 1, runs: [FRAG] },
    { speaker: 0, runs: [BODY] },
  ]);
  assert.equal(boundaryPlanOf(lines).skipped.differentFinal, 1);
});

/**
 * **構造の証拠を内容のゲートより先に見る。** 別 final の「はい」を `backchannel` に数えると、
 * 語彙リストを調整するための件数が、構造上どのみち寄らないケースで水増しされる。
 */
test("別 final の相槌語彙は backchannel ではなく differentFinal に数える", () => {
  const lines = [line(BODY, 0, { seq: 1 }), line("はい", 1, { seq: 2 }), line(BODY, 0, { seq: 3 })];
  const { skipped } = boundaryPlanOf(lines);
  assert.equal(skipped.differentFinal, 1);
  assert.equal(skipped.backchannel, 0);
});

test("句読点で閉じた断片は同じ final でも寄せない（punctuated）", () => {
  const lines = [line("あ。", 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [
    { speaker: 0, runs: ["あ。"] },
    { speaker: 1, runs: [BODY] },
  ]);
  assert.equal(boundaryPlanOf(lines).skipped.punctuated, 1);
});

test("相槌語彙は同じ final でも寄せない（backchannel）", () => {
  // 隣は `ANCHOR6`。4〜5 文字の語彙は (a) の候補になったときだけ数えるので、(b) しか動かない
  // `BODY` を隣に置くと「寄らない」は同じでも `backchannel` には数えられない
  for (const word of BACKCHANNEL_WORDS) {
    const lines = [line(word, 0, { seq: 5 }), line(ANCHOR6, 1, { seq: 5 })];
    assert.equal(groupUtterances(lines).length, 2, `${word} が寄せられた`);
    assert.equal(boundaryPlanOf(lines).skipped.backchannel, 1, `${word} が backchannel に数えられていない`);
  }
});

/** 閾値より長い語をリストに載せても長さのゲートで先に落ちるので、効いているように読めるだけになる */
test("相槌語彙は拡張断片の長さまでの語だけ（それより長い語は効かない）", () => {
  for (const word of BACKCHANNEL_WORDS) {
    assert.ok(word.length <= BOUNDARY_EXTENDED_CHAR_LIMIT, `${word} は閾値より長い`);
  }
});

test("句読点付きの相槌語彙は、句読点を剥がして backchannel に数える（#57）", () => {
  const lines = [line("はい。", 0, { seq: 5 }), line(ANCHOR6, 1, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 2);
  const { skipped } = boundaryPlanOf(lines);
  assert.equal(skipped.backchannel, 1);
  assert.equal(skipped.punctuated, 0);
});

test("両隣が異なる話者の長い行なら寄せない（ambiguous）", () => {
  const lines = [line(BODY, 0, { seq: 5 }), line(FRAG, 2, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 3);
  assert.equal(boundaryPlanOf(lines).skipped.ambiguous, 1);
});

test("両隣が同じ話者の長い行なら寄せる（①jitter と同じ結果）", () => {
  const lines = [line(BODY, 0, { seq: 5 }), line(FRAG, 2, { seq: 5 }), line(BODY, 0, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 0, runs: [BODY + FRAG + BODY] }]);
  // ⓪が先に効く（①ではなく⓪の計画に載る）
  assert.equal(boundaryPlanOf(lines).applied.length, 1);
});

test("再接続の印を越えて寄せない（boundary）", () => {
  const lines = [line(FRAG, 0, { seq: 5 }), reconnect(), line(BODY, 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [
    { speaker: 0, runs: [FRAG] },
    { type: "reconnect" },
    { speaker: 1, runs: [BODY] },
  ]);
  assert.equal(boundaryPlanOf(lines).skipped.boundary, 1);
});

test("隣の話者が不明なら寄せない（unknown）", () => {
  const lines = [line(FRAG, 0, { seq: 5 }), line(BODY, null, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 2);
  assert.equal(boundaryPlanOf(lines).skipped.unknown, 1);
});

test("seq の無い旧セッションでは何もしない（noSeq。時間窓へ落とさない）", () => {
  const lines = [
    { text: FRAG, speaker: 0, t: 0 },
    { text: BODY, speaker: 1, t: 0 },
  ] as Line[];
  assert.equal(groupUtterances(lines).length, 2);
  assert.equal(boundaryPlanOf(lines).skipped.noSeq, 1);
});

/**
 * 断片が連なる形（#57 のパターン 3）。#55 は 1 行の窓で隣の 1 つだけを寄せ、残りを `shortNeighbor` に
 * 数えていたが、#57 では **run をまとめて寄せる**。4 文字の `BODY` が本体（(b) の anchor）になる形。
 */
test("断片が2つ続けば run としてまとめて隣の本体へ寄る（kind: chain）", () => {
  const lines = [line("あ", 0, { seq: 5 }), line("い", 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 1, runs: ["あい" + BODY] }]);
  const plan = boundaryPlanOf(lines);
  assert.deepEqual(plan.applied, [
    { index: 0, from: 0, to: 1, chars: 1, kind: "chain" },
    { index: 1, from: 0, to: 1, chars: 1, kind: "chain" },
  ]);
  assertNothingSkipped(plan);
});

/**
 * **同じ final の同じ話者の長い行に既に接している断片は、その話者の本体の一部。**
 * 反対側に別話者の長い行があっても B へ引き剥がさない（対象外なので見送りにも数えない）。
 */
test("同じ final の同じ話者の長い行に接していれば、反対側の別話者へ寄せない", () => {
  const lines = [line(BODY, 0, { seq: 5 }), line(FRAG, 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [
    { speaker: 0, runs: [BODY + FRAG] },
    { speaker: 1, runs: [BODY] },
  ]);
  const plan = boundaryPlanOf(lines);
  assert.equal(plan.applied.length, 0);
  assertNothingSkipped(plan);
  // 断片が 2 つ続く形でも、両方とも同じ話者の本体に接している（raw が A と言っている連続を
  // 割る根拠は無い）。#55 は 1 行の窓で `い` だけを B へ寄せていたが、#57 の run 判定では
  // 本体に接している側から順に「本体の一部」として外すので何もしない
  const chain = [line(BODY, 0, { seq: 5 }), line("あ", 0, { seq: 5 }), line("い", 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(chain)), [
    { speaker: 0, runs: [BODY + "あい"] },
    { speaker: 1, runs: [BODY] },
  ]);
  const chainPlan = boundaryPlanOf(chain);
  assert.equal(chainPlan.applied.length, 0);
  assertNothingSkipped(chainPlan);
});

test("断片自身の話者が不明なら寄せない（unknown。from の無い適用を作らない）", () => {
  const lines = [line(FRAG, null, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 2);
  const plan = boundaryPlanOf(lines);
  assert.equal(plan.applied.length, 0);
  assert.equal(plan.skipped.unknown, 1);
});

test("空文字の行は断片ではない（寄せず、見送りにも数えない）", () => {
  const lines = [line("", 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  const plan = boundaryPlanOf(lines);
  assert.equal(plan.applied.length, 0);
  assertNothingSkipped(plan);
});

test("BOUNDARY_PUNCTUATION のどの文字で閉じていても寄せない", () => {
  for (const p of BOUNDARY_PUNCTUATION) {
    const lines = [line(`あ${p}`, 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
    assert.equal(groupUtterances(lines).length, 2, `${p} で閉じた断片が寄せられた`);
    assert.equal(boundaryPlanOf(lines).skipped.punctuated, 1, `${p} が punctuated に数えられていない`);
  }
});

test("両隣とも同じ話者の短い行は境界に無いので判定の対象外（見送りにも数えない）", () => {
  const lines = [line(BODY, 0, { seq: 5 }), line(FRAG, 0, { seq: 5 }), line(BODY, 0, { seq: 5 })];
  const plan = boundaryPlanOf(lines);
  assert.equal(plan.applied.length, 0);
  assertNothingSkipped(plan);
});

test("別 final の同一話者は従来どおり別 run（スペース連結のまま）", () => {
  const lines = [line(BODY, 0, { seq: 1 }), line(BODY, 0, { seq: 2 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 0, runs: [BODY, BODY] }]);
});

test("seq の無い行どうしは undefined === undefined で繋がない", () => {
  const lines = [
    { text: BODY, speaker: 0, t: 0 },
    { text: BODY, speaker: 0, t: 0 },
  ] as Line[];
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 0, runs: [BODY, BODY] }]);
});

test("text が欠けた復元行があっても run に undefined が混ざらない", () => {
  // 復元データは検証を通っていないので `text` が欠けた形が来うる
  const groups = mergeSameSpeaker([
    { text: "a", speaker: 0, t: 0, seq: 1 },
    { text: undefined, speaker: 0, t: 0, seq: 1 },
    { text: "c", speaker: 0, t: 0, seq: 1 },
  ] as unknown as Line[]) as Array<Record<string, unknown>>;
  assert.deepEqual(groups[0].runs, ["ac"]);
  assert.equal((groups[0].texts as unknown[]).length, 3, "texts は行数のまま");
});

test("グループは texts（行ごと）と runs（同じ final 由来だけ区切りなし）を持つ（中立化グループも同じ）", () => {
  const groups = mergeSameSpeaker([
    { text: "a", speaker: 0, t: 0, seq: 1 },
    { text: "b", speaker: 0, t: 0, seq: 1 },
    { text: "c", speaker: 2, t: 0, seq: 2, unresolved: true },
    { text: "d", speaker: 2, t: 0, seq: 3, unresolved: true },
  ] as Line[]) as Array<Record<string, unknown>>;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].texts, ["a", "b"]);
  assert.deepEqual(groups[0].runs, ["ab"]);
  assert.deepEqual(groups[1].texts, ["c", "d"]);
  assert.deepEqual(groups[1].runs, ["c", "d"]);
  assert.equal(groups[1].unresolved, true);
});

/**
 * ⓪→①→②の順序。⓪が先に寄せた断片は②の島として現れない（同じ行を2つの段で二重に
 * 数えない）。想定2人・検出3で、minor の断片が主要 speaker と同じ final にある形。
 */
test("⓪が先に寄せた断片は②の対象にならない（⓪→①→②の順序）", () => {
  const lines: Line[] = [
    { text: LONG, speaker: 0, t: 0, seq: 1, w: 300 },
    { text: LONG, speaker: 1, t: 1, seq: 2, w: 100 },
    { text: FRAG, speaker: 2, t: 1, seq: 2, w: 2 },
    { text: LONG, speaker: 0, t: 2, seq: 3, w: 100 },
  ];
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  const { boundaryPlan, displayDetected } = correction;
  const plan = correction.plan as { disabledBy: string | null; merges: unknown[] };
  assert.equal(boundaryPlan.applied.length, 1, "⓪が寄せていない");
  assert.equal(plan.disabledBy, null, "②のゲートは通っている（検出3 > 想定2、総 word 数も十分）");
  assert.equal(plan.merges.length, 0, "⓪が寄せた行を②が島として数えている");
  assert.equal(displayDetected, 2);
  assert.deepEqual(runsOf(groupUtterances(lines, { expectedSpeakers: EXPECTED_2 })), [
    { speaker: 0, runs: [LONG] },
    { speaker: 1, runs: [LONG + FRAG] },
    { speaker: 0, runs: [LONG] },
  ]);
});

test("smoothSpeakerBoundaries は入力の配列も要素も書き換えない", () => {
  const lines = [line(FRAG, 0, { seq: 5 }), line(BODY, 1, { seq: 5 })];
  const snapshot = JSON.stringify(lines);
  const { lines: out } = smoothSpeakerBoundaries(lines);
  assert.equal(JSON.stringify(lines), snapshot);
  assert.notEqual(out, lines);
  assert.equal(out[0].speaker, 1);
  assert.equal(lines[0].speaker, 0);
});

test("⓪の skipped は 0 件でも全キーを持つ（順序も固定。診断の表示名の表と突き合わせる）", () => {
  const { plan } = smoothSpeakerBoundaries([]);
  assert.deepEqual(Object.keys(plan.skipped), [
    "ambiguous",
    "unresolvedChain",
    "chainTooLong",
    "weakContinuity",
    "punctuated",
    "backchannel",
    "differentFinal",
    "boundary",
    "unknown",
    "noSeq",
  ]);
  assert.deepEqual(Object.values(plan.skipped), Object.keys(plan.skipped).map(() => 0));
  assert.deepEqual(plan.applied, []);
});

test("⓪を通してもテキストと行数は1つも変わらず、③と④の文字数が一致する", () => {
  const fixtures: Line[][] = [
    [line(FRAG, 0, { seq: 5 }), line(BODY, 1, { seq: 5 })],
    [line(BODY, 0, { seq: 5 }), line(FRAG, 2, { seq: 5 }), line(BODY, 1, { seq: 5 })],
    [line("あ", 0, { seq: 5 }), line("い", 0, { seq: 5 }), line(BODY, 1, { seq: 5 })],
    [line(FRAG, 0, { seq: 5 }), reconnect(), line(BODY, 1, { seq: 5 })],
    [line("あ。", 0, { seq: 5 }), line("はい", 1, { seq: 5 }), line(BODY, 1, { seq: 5 })],
  ];
  for (const lines of fixtures) {
    assert.deepEqual(displayedChars(lines), receivedChars(lines));
    const rows = groupUtterances(lines)
      .filter((g: Record<string, unknown>) => g.type !== "reconnect")
      .reduce((n: number, g: Record<string, unknown>) => n + (g.texts as string[]).length, 0);
    assert.equal(rows, lines.filter((l) => l.type !== "reconnect").length);
  }
});

test("既存の jitter fixture は⓪を足しても結果が変わらない（#36 の退行検出）", () => {
  // `SHORT`(= JITTER_CHAR_LIMIT 文字)は⓪の通常断片より長いので (b) に掛からず、
  // `LONG`(= JITTER_CHAR_LIMIT + 1 文字)は拡張上限以下なので (a) の anchor にならない。
  // つまり #36 の fixture には⓪の 2 段のどちらも掛からない（#57 で前提が 2 つになった）
  assert.ok(SHORT.length > BOUNDARY_FRAGMENT_CHAR_LIMIT, "⓪の通常断片の閾値が①の閾値以上になっている");
  assert.ok(LONG.length <= BOUNDARY_EXTENDED_CHAR_LIMIT, "①の LONG が⓪の anchor の長さになっている");
  for (const c of cases) {
    const plan = boundaryPlanOf(linesOf(c));
    assert.equal(plan.applied.length, 0, `${c.id}: ⓪が #36 の fixture に掛かった`);
  }
});

// ---- ⓪ の拡張（#57）: 句読点付きの断片・4〜5 文字の断片・断片の chain ----
//
// 判定は 2 段。(a) `ANCHOR6`（拡張上限 + 1 文字）を anchor とする chain 判定、(b) 4 文字以上を本体・
// 3 文字以下を断片とする #55 互換の run 判定。固定したいのは 4 つ。
// 1. **(a) の 3 パターンが寄る** — 句読点付き / 4〜5 文字 / chain。それぞれ `kind` が付く
// 2. **証拠が無ければ寄らない** — 語彙・文字種の連続性・直前の句読点・総量・寄せ先の一意性
// 3. **(a) が決まらなければ (b) に落ち、#55 の形（短い断片 + 4〜5 文字の本体）は従来どおり寄る**
// 4. **見送りは 1 行 1 理由**で、落ちた行だけを数える
//
// fixture はここでも匿名化した合成データ。文字列は長さと文字種にしか意味が無い。

/** 拡張断片の上限ちょうど（ひらがな）。`ANCHOR6` と隣り合うと連続性「中」 */
const EXT = "あ".repeat(BOUNDARY_EXTENDED_CHAR_LIMIT);
/** 6 文字 = anchor の長さで、句読点で閉じている行 */
const CLOSED6 = "い".repeat(BOUNDARY_EXTENDED_CHAR_LIMIT) + "。";

// #57 の代表的な形。個別のテストと末尾の文字数完全性・不変性のテストで同じ配列を使う
// （書き写すと、fixture を調整したときに片方だけ変わる）
const PUNCT_TAIL = () => [line("専門スキ", 0, { seq: 5 }), line("ルです。", 1, { seq: 5 }), line(ANCHOR6, 0, { seq: 5 })];
const EXT_TAIL = () => [line("始", 0, { seq: 5 }), line("めていた", 1, { seq: 5 }), line(ANCHOR6, 0, { seq: 5 })];
const ALT_CHAIN = () => [
  line(ANCHOR6, 0, { seq: 5 }),
  line("テ", 1, { seq: 5 }),
  line("キ", 0, { seq: 5 }),
  line("ス", 1, { seq: 5 }),
  line("ト", 0, { seq: 5 }),
];
const NO_ANCHOR_CHAIN = () => [line("これを", 0, { seq: 5 }), line("自動", 1, { seq: 5 }), line("化し", 0, { seq: 5 }), line("ます", 1, { seq: 5 })];
const CLOSED_PREV = () => [line(CLOSED6, 0, { seq: 5 }), line("です。", 1, { seq: 5 })];
const CROSSED_CHAIN = () => [line(ANCHOR6, 0, { seq: 5 }), line("い", 1, { seq: 5 }), line("あ", 0, { seq: 5 }), line(ANCHOR6, 1, { seq: 5 })];

test("句読点で閉じた断片でも、直前の語と文字種が連続していれば前の語の続きとして寄る（kind: punctuated）", () => {
  const lines = PUNCT_TAIL();
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 0, runs: ["専門スキルです。" + ANCHOR6] }]);
  const plan = boundaryPlanOf(lines);
  // 4 文字で拡張断片でもあるが、句読点を緩めた規則のほうがリスクが高いので `punctuated` を優先する
  assert.deepEqual(plan.applied, [{ index: 1, from: 1, to: 0, chars: 4, kind: "punctuated" }]);
  assertNothingSkipped(plan);
});

test("4〜5 文字の断片は、長い anchor と文字種の連続性（漢字 → ひらがな）があれば寄る（kind: extended）", () => {
  const lines = EXT_TAIL();
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 0, runs: ["始めていた" + ANCHOR6] }]);
  const plan = boundaryPlanOf(lines);
  assert.deepEqual(plan.applied, [{ index: 1, from: 1, to: 0, chars: 4, kind: "extended" }]);
  assertNothingSkipped(plan);
});

test("交互に割れた断片の chain は anchor の speaker へまとめて寄る（kind: chain）", () => {
  const lines = ALT_CHAIN();
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 0, runs: [ANCHOR6 + "テキスト"] }]);
  const plan = boundaryPlanOf(lines);
  // 既に anchor と同じ speaker の行（キ・ト）は動かさず、`applied` にも載せない
  assert.deepEqual(plan.applied, [
    { index: 1, from: 1, to: 0, chars: 1, kind: "chain" },
    { index: 3, from: 1, to: 0, chars: 1, kind: "chain" },
  ]);
  assertNothingSkipped(plan);
});

test("短い断片 + 4〜5 文字の本体（#55 の形）は anchor が無くても (b) で従来どおり寄る", () => {
  const lines = [line("今日は", 0, { seq: 5 }), line("晴れですね", 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [{ speaker: 1, runs: ["今日は晴れですね"] }]);
  assert.deepEqual(boundaryPlanOf(lines).applied, [{ index: 0, from: 0, to: 1, chars: 3, kind: "basic" }]);
});

test("句読点で閉じた相槌が 4〜5 文字の本体に挟まれていても、語彙で弾く（backchannel。punctuated ではない）", () => {
  const lines = [line("進めます。", 0, { seq: 5 }), line("はい。", 1, { seq: 5 }), line("次です。", 0, { seq: 5 })];
  // ⓪単体の出力で見る。①（#36 の jitter）は語彙を見ずに「同じ final で同じ話者に挟まれた 4 文字以下」を
  // 寄せるので、`groupUtterances()` の段落数はここで固定したいものではない
  assert.deepEqual(smoothSpeakerBoundaries(lines).lines.map((l) => l.speaker), [0, 1, 0]);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.equal(skipped.backchannel, 1);
  assert.equal(skipped.punctuated, 0);
});

test("両方とも anchor の長さなら判定の対象外（寄せず、見送りにも数えない）", () => {
  const lines = [line("そうですね。", 0, { seq: 5 }), line("次に行きます。", 1, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 2);
  const plan = boundaryPlanOf(lines);
  assert.equal(plan.applied.length, 0);
  assertNothingSkipped(plan);
});

test("両側の anchor が別 speaker なら寄せない（ambiguous）", () => {
  const lines = [line(ANCHOR6, 0, { seq: 5 }), line(FRAG, 1, { seq: 5 }), line(ANCHOR6, 2, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 3);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.equal(skipped.ambiguous, 1);
});

test("anchor の無い断片だけの final は寄せ先を決められない（unresolvedChain。境界に立つ全行を数える）", () => {
  const lines = NO_ANCHOR_CHAIN();
  // ⓪単体の出力で見る（①は挟まれた `自動` を寄せる）
  assert.deepEqual(smoothSpeakerBoundaries(lines).lines.map((l) => l.speaker), [0, 1, 0, 1]);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.equal(skipped.unresolvedChain, 4);
});

test("句読点で閉じていて直前との連続性が弱ければ寄せない（punctuated。ひらがな → 漢字）", () => {
  const lines = [line(ANCHOR6, 0, { seq: 5 }), line("了解。", 1, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 2);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  // (a) で数えた行を (b) で数え直さない（1 行 1 理由）
  assert.equal(skipped.punctuated, 1);
  assert.equal(skipped.unresolvedChain, 0);
});

test("直前の行が句読点で閉じていれば、句読点付きの断片は前の語の続きではない（punctuated）", () => {
  const lines = CLOSED_PREV();
  assert.equal(groupUtterances(lines).length, 2);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.equal(skipped.punctuated, 1);
});

test("4〜5 文字の断片は文字種の連続性が弱ければ寄せない（weakContinuity。ひらがな → 漢字）", () => {
  const lines = [line(ANCHOR6, 0, { seq: 5 }), line("漢字です", 1, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 2);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.equal(skipped.weakContinuity, 1);
});

test("寄せる行の総文字数が上限を超える chain は寄せない（chainTooLong）", () => {
  const piece = "あ".repeat(BOUNDARY_FRAGMENT_CHAR_LIMIT);
  const n = Math.floor(BOUNDARY_CHAIN_MAX_CHARS / piece.length) + 1; // 上限をちょうど超える本数
  const lines = [line(ANCHOR6, 0, { seq: 5 }), ...Array.from({ length: n }, () => line(piece, 1, { seq: 5 }))];
  assert.equal(groupUtterances(lines).length, 2);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.equal(skipped.chainTooLong, n);
});

test("chain の 1 行が語彙に当たれば chain 全体を寄せない。数えるのは落ちた行だけ", () => {
  const lines = [line(ANCHOR6, 0, { seq: 5 }), line("あ", 1, { seq: 5 }), line("はい", 1, { seq: 5 }), line("い", 1, { seq: 5 })];
  assert.equal(groupUtterances(lines).length, 2);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.deepEqual(skipped, { ...NO_SKIPS, backchannel: 1 }, "落ちていない行まで数えている");
});

test("両側の anchor が別 speaker でも、chain が既に割れていれば対象外（見送りにも数えない）", () => {
  const lines = [line(ANCHOR6, 0, { seq: 5 }), line("あ", 0, { seq: 5 }), line("い", 1, { seq: 5 }), line(ANCHOR6, 1, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(lines)), [
    { speaker: 0, runs: [ANCHOR6 + "あ"] },
    { speaker: 1, runs: ["い" + ANCHOR6] },
  ]);
  const plan = boundaryPlanOf(lines);
  assert.equal(plan.applied.length, 0);
  assertNothingSkipped(plan);
});

test("両側の anchor が別 speaker で chain が交差していれば ambiguous（境界に立つ全行を数える）", () => {
  const lines = CROSSED_CHAIN();
  // ⓪単体の出力で見る（①は挟まれた `い` を寄せる）
  assert.deepEqual(smoothSpeakerBoundaries(lines).lines.map((l) => l.speaker), [0, 1, 0, 1]);
  const { applied, skipped } = boundaryPlanOf(lines);
  assert.equal(applied.length, 0);
  assert.equal(skipped.ambiguous, 2);
});

/**
 * (a) と (b) が食い違う形。(a) は「6 文字以上の本体が同じ final にある」という #55 より強い証拠を
 * 要求しているので、成立すれば (a) を優先する。(a) が内容ゲートで落ちれば (b) の #55 互換に落ちる。
 */
test("(a) が成立すれば (b) より優先し、(a) が内容ゲートで落ちれば (b) に落ちる", () => {
  // (a) 成立: `EXT`（ひらがな）は `ANCHOR6`（ひらがな）と連続性「中」なので anchor の speaker へ。
  // (b) なら `今日は` が `EXT` の speaker 1 へ寄っていた形
  const win = [line(ANCHOR6, 0, { seq: 5 }), line(EXT, 1, { seq: 5 }), line("今日は", 0, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(win)), [{ speaker: 0, runs: [ANCHOR6 + EXT + "今日は"] }]);
  const winPlan = boundaryPlanOf(win);
  assert.deepEqual(winPlan.applied, [{ index: 1, from: 1, to: 0, chars: EXT.length, kind: "extended" }]);
  assertNothingSkipped(winPlan);
  // (a) 落ちる: `晴れですね` は前後どちらとも連続性「弱」。(b) が #55 と同じく `今日は` を 1 へ寄せる
  const fall = [line(ANCHOR6, 0, { seq: 5 }), line("晴れですね", 1, { seq: 5 }), line("今日は", 0, { seq: 5 })];
  assert.deepEqual(runsOf(groupUtterances(fall)), [
    { speaker: 0, runs: [ANCHOR6] },
    { speaker: 1, runs: ["晴れですね今日は"] },
  ]);
  const fallPlan = boundaryPlanOf(fall);
  assert.deepEqual(fallPlan.applied, [{ index: 2, from: 0, to: 1, chars: 3, kind: "basic" }]);
  assert.equal(fallPlan.skipped.weakContinuity, 1);
});

test("文字種の連続性の表（#57）", () => {
  assert.equal(continuity("スキ", "ルです"), "strong", "カタカナ → カタカナ");
  assert.equal(continuity("テー", "ブル"), "strong", "長音もカタカナ");
  assert.equal(continuity("専", "門"), "strong", "漢字 → 漢字");
  assert.equal(continuity("佐々", "木"), "strong", "々 は漢字");
  assert.equal(continuity("AP", "I"), "strong", "英数 → 英数");
  assert.equal(continuity("ＡＰ", "Ｉ"), "strong", "全角の英数");
  assert.equal(continuity("始", "めていた"), "medium", "漢字 → ひらがな");
  assert.equal(continuity("な", "ので"), "medium", "ひらがな → ひらがな");
  assert.equal(continuity("です", "了解"), "weak", "ひらがな → 漢字");
  assert.equal(continuity("スキ", "です"), "weak", "カタカナ → ひらがな");
  assert.equal(continuity("です。", "次"), "none", "前が句読点で閉じている");
  assert.equal(continuity("です", "。"), "none", "後が句読点");
  assert.equal(continuity("あ ", "い"), "none", "空白");
  assert.equal(continuity("", "あ"), "none", "空");
  assert.equal(continuity("あ", ""), "none", "空");
});

test("⓪の kinds は 0 件でも全キーを持つ（順序も固定。診断の表示名の表と突き合わせる）", () => {
  const { plan } = smoothSpeakerBoundaries([]);
  assert.deepEqual(Object.keys(plan.kinds), ["basic", "extended", "punctuated", "chain"]);
  assert.deepEqual(Object.values(plan.kinds), [0, 0, 0, 0]);
  // 件数は `applied` から派生する値と一致する
  const { kinds, applied } = boundaryPlanOf(ALT_CHAIN());
  assert.deepEqual(kinds, { basic: 0, extended: 0, punctuated: 0, chain: applied.length });
});

test("#57 の fixture でもテキストと行数は 1 つも変わらず、③と④の文字数が一致する", () => {
  const fixtures: Line[][] = [PUNCT_TAIL(), EXT_TAIL(), ALT_CHAIN(), NO_ANCHOR_CHAIN(), CLOSED_PREV(), CROSSED_CHAIN()];
  for (const lines of fixtures) {
    assert.deepEqual(displayedChars(lines), receivedChars(lines));
    const rows = groupUtterances(lines).reduce(
      (n: number, g: Record<string, unknown>) => n + (g.texts as string[]).length,
      0,
    );
    assert.equal(rows, lines.length);
    const snapshot = JSON.stringify(lines);
    smoothSpeakerBoundaries(lines);
    assert.equal(JSON.stringify(lines), snapshot, "入力を書き換えている");
  }
});

// ---- 長い minor run の再帰属と中立化（③b、#61） ----
//
// ②③が `tooLong` で見送った run だけを入力に取る段。固定したいのは 4 つ。
// 1. **再帰属は E1（同じ minor の safe merge が 1 つの major にだけ寄っている）が必須** —
//    根拠の無い実データでは眠ったままになり、誤帰属の入口が「合成 fixture でしか通らない」状態を保つ
// 2. **中立化は絶対判定・比率・run の本数・run の長さのすべてで測り、E2〜E4 は止めない** —
//    `B → X → A` の X が両隣と同じ final にあるのは「境目に挟まった断片」の形そのもの
// 3. **維持の理由は 1 run に 1 つ**。優先順位は
//    `conflictingEvidence → notAbsolute → ratioTooHigh → manyRuns → runTooLong`
// 4. **ゲートは②と同一で、run は切り直さない** — `boundary` / `unknown` / `edge` は候補にならない
//
// fixture はここでも合成データ。文字列は文字種にしか意味が無い（E4 の連続性を意図的に切るために
// カタカナを使う）。実会話・固有名詞は入れない。

type LongSpec = Array<
  [speaker: number | null, words: number, over?: { seq?: number; text?: string }] | "reconnect"
>;

/**
 * ひらがな 8 文字。⓪の anchor 長さ（`BOUNDARY_EXTENDED_CHAR_LIMIT`）を超えるので、同じ final を
 * 共有させる行に使っても⓪の chain 判定に掛からない。
 */
const HIRA8 = "あ".repeat(8);
/**
 * カタカナ 8 文字。ひらがなの隣との文字種の連続性が「弱」になる（`continuity()` の表）ので、
 * E4 を意図的に切りたい run に使う。既定の `LONG`（ひらがな）どうしは「中」で E4 が両側に付く。
 */
const KATA8 = "ア".repeat(8);

/**
 * `islandLines()` を通してから、要素ごとに `seq` / `text` を上書きする。E2（同じ final）と
 * E4（文字種）を 1 行単位で作るため。上書きしない行は `islandLines()` のまま（`seq` が行ごとに
 * 違い、⓪①には掛からない）。行の組み立てを写さないのは、`islandLines()` の細工を変えたときに
 * こちらが追随しなくなるのを避けるため。③a（#63）の境目の `seq` にも `seqLines` の別名で使う。
 */
function longLines(spec: LongSpec): Line[] {
  const base = islandLines(spec.map((e) => (e === "reconnect" ? e : [e[0], e[1]])));
  return base.map((l, i) => {
    const e = spec[i];
    return e === "reconnect" ? l : { ...l, ...(e[2] ?? {}) };
  });
}

/** ③b の計画。本番と同じ経路（`planDisplayCorrection()` の 1 回の計算）から取る */
function longPlanOf(lines: Line[], expectedSpeakers: string = EXPECTED_2) {
  return planDisplayCorrection(lines, { expectedSpeakers }).longMinorPlan;
}

/** 根拠を `kind→major` の列に畳む（向きまで含めて比較するため） */
const evidenceOf = (evidence: Array<{ kind: string; major: number }>) =>
  evidence.map((e) => `${e.kind}→${e.major}`);

/**
 * 再帰属の形。`2 → 0` が②で 2 seg safe merge されていて（E1）、長い run が直前の 0 と同じ final に
 * ある（E2）。遷移も `0 ↔ 2` が 5/6 で 0 に偏る（E3）。run の文字種をカタカナにして、後ろの 1 との
 * 文字種の連続性（E4）が反対根拠にならないようにしてある。
 * `0: 1250 / 1: 100 / 2: 37`（2 は 2.7% で絶対 minor）。
 */
const ATTRIBUTE_SPEC: LongSpec = [
  [0, 1000],
  [2, 3],
  [0, 100],
  [2, 4],
  [0, 100],
  [0, 50, { seq: 100, text: HIRA8 }],
  [2, 30, { seq: 100, text: KATA8 }],
  [1, 100],
];

/** 実機で観測された形（`79.4 / 18.0 / 2.6`、`B → X(長) → A` が 1 本、safe merge 0 件） */
const OBSERVED_LONG_SPEC: LongSpec = [
  [0, 600],
  [1, 180],
  [2, 26],
  [0, 194],
];

test("E1 が一意で E2 も同じ major を指す長い run を主要 speaker へ再帰属する", () => {
  const lines = longLines(ATTRIBUTE_SPEC);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, [{ from: 2, to: 0, segments: 2, words: 7, indexes: [1, 3] }]);
  assert.deepEqual(planUnresolvedMinors(plan).skippedRuns, [
    { reason: "tooLong", speaker: 2, words: 30, indexes: [6] },
  ]);

  const long = longPlanOf(lines);
  assert.equal(long.disabledBy, null);
  assert.equal(long.runs, 1);
  assert.deepEqual(long.attributed, [
    {
      from: 2,
      to: 0,
      segments: 1,
      words: 30,
      indexes: [6],
      evidence: [
        { kind: "merge", major: 0 },
        { kind: "seq", major: 0 },
        { kind: "transition", major: 0 },
      ],
    },
  ]);
  assert.deepEqual(long.neutralized, []);
  assert.deepEqual(long.kept, []);
  assert.deepEqual(long.evidenceCounts, { merge: 1, seq: 1, continuity: 0, transition: 1 });
  assert.deepEqual(
    long.speakers.map((s: { speaker: number; decision: string; to: number | null }) => [s.speaker, s.decision, s.to]),
    [[2, "attributed", 0]],
  );
  // ④で 0 の段落へ結合し、表示上の通常話者数は 2
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1]);
  assert.equal(unresolvedOf(groups).some(Boolean), false);
  assert.equal(planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 }).displayDetected, 2);
});

test("E1 が無い長い run は再帰属せず、絶対 minor・run 1 本・上限以下なら中立化する（観測サンプルの形）", () => {
  const lines = longLines(OBSERVED_LONG_SPEC);
  assert.deepEqual(planOf(lines).merges, [], "fixture に safe merge がある（E1 を観測できない）");
  const long = longPlanOf(lines);
  assert.deepEqual(long.attributed, []);
  assert.deepEqual(long.neutralized, [{ speaker: 2, segments: 1, words: 26, indexes: [2] }]);
  assert.deepEqual(long.kept, []);
  // 両隣との文字種の連続性（E4）は付いているが、中立化を止めない（設計の調整点 1）
  assert.deepEqual(evidenceOf(long.speakers[0].evidence), ["continuity→1", "continuity→0"]);
  assert.equal(long.speakers[0].decision, "neutralized");
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 2, 0]);
  assert.deepEqual(unresolvedOf(groups), [false, false, true, false]);
  assert.equal(planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 }).displayDetected, 2);
});

test("相対判定の minor は長い run を中立化しない（notAbsolute。Issue の「現状維持」の形）", () => {
  // 2 は 4.5%（最小の主要 46% に対して 0.098 → 相対 minor）。長い run が 2 本で 0/1 の双方に隣接
  const lines = longLines([
    [0, 300],
    [2, 22],
    [1, 460],
    [2, 23],
    [0, 195],
  ]);
  assert.deepEqual(kindsOf(planOf(lines)), { 2: "relative" }, "fixture が相対判定になっていない");
  const long = longPlanOf(lines);
  assert.equal(long.runs, 2);
  assert.deepEqual(long.kept, [
    { reason: "notAbsolute", speaker: 2, words: 22, indexes: [1] },
    { reason: "notAbsolute", speaker: 2, words: 23, indexes: [3] },
  ]);
  assert.deepEqual(long.keptCounts, {
    conflictingEvidence: 0,
    notAbsolute: 2,
    ratioTooHigh: 0,
    manyRuns: 0,
    runTooLong: 0,
  });
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 2, 1, 2, 0], "speaker 2 が表示から消えている");
  assert.equal(unresolvedOf(groups).some(Boolean), false);
  assert.equal(planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 }).displayDetected, 3);
});

test("絶対 minor でも長い run が複数あれば中立化しない（manyRuns）", () => {
  // 2 は 2.5%（絶対）だが長い run が 2 本
  const lines = longLines([
    [0, 1000],
    [2, MINOR_ISLAND_MAX_WORDS + 1],
    [1, 400],
    [2, MINOR_ISLAND_MAX_WORDS + 1],
    [0, 258],
  ]);
  assert.deepEqual(kindsOf(planOf(lines)), { 2: "absolute" });
  const long = longPlanOf(lines);
  assert.equal(long.speakers[0].longRuns, 2);
  assert.ok(long.speakers[0].longRuns > LONG_MINOR_MAX_RUNS);
  assert.deepEqual(long.neutralized, []);
  assert.deepEqual(
    long.kept.map((k: { reason: string }) => k.reason),
    ["manyRuns", "manyRuns"],
  );
  assert.equal(long.speakers[0].decision, "kept");
  assert.deepEqual(long.speakers[0].reasons, ["manyRuns"]);
});

test("絶対 minor でも run が LONG_MINOR_MAX_WORDS を超えれば中立化しない（runTooLong）", () => {
  const build = (words: number) =>
    longLines([
      [0, 2000],
      [1, 500],
      [2, words],
      [0, 430],
    ]);
  // 上限ちょうどは中立化する（境界は「以下」）
  const just = longPlanOf(build(LONG_MINOR_MAX_WORDS));
  assert.equal(just.neutralized.length, 1, "上限ちょうどで維持になっている");
  assert.deepEqual(just.kept, []);
  // 1 つ超えたら維持
  const over = longPlanOf(build(LONG_MINOR_MAX_WORDS + 1));
  assert.deepEqual(over.neutralized, []);
  assert.deepEqual(over.kept, [
    { reason: "runTooLong", speaker: 2, words: LONG_MINOR_MAX_WORDS + 1, indexes: [2] },
  ]);
});

test("safe merge の帰属先が複数の major に割れていれば再帰属も中立化もしない（conflictingEvidence）", () => {
  // `2 → 0` と `2 → 1` が両方 safe merge されていて、長い run が 1 本（2 は 2.7% で絶対）
  const lines = longLines([
    [0, 600],
    [2, 3],
    [0, 100],
    [1, 200],
    [2, 4],
    [1, 100],
    [0, 50],
    [2, 25],
    [1, 100],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(
    plan.merges.map((m: { from: number; to: number }) => `${m.from}→${m.to}`),
    ["2→0", "2→1"],
    "fixture の safe merge が割れていない",
  );
  const long = longPlanOf(lines);
  assert.deepEqual(long.attributed, []);
  assert.deepEqual(long.neutralized, [], "根拠が割れているのに隠している");
  assert.deepEqual(long.kept, [{ reason: "conflictingEvidence", speaker: 2, words: 25, indexes: [7] }]);
  // 割れた E1 は根拠として載せない（載せると「safe merge→0」だけが見えて一意に読める）
  assert.equal(long.speakers[0].evidence.some((e: { kind: string }) => e.kind === "merge"), false);
});

test("E1 が一意でも反対の major を指す根拠があれば再帰属せず、条件を満たせば中立化する", () => {
  // E1 は `2 → 0`（2 seg）だが、長い run は直後の 1 と同じ final（E2 が 1 を指す）
  const lines = longLines([
    [0, 1000],
    [2, 3],
    [0, 100],
    [2, 4],
    [0, 100],
    [0, 50],
    [2, 30, { seq: 100, text: KATA8 }],
    [1, 100, { seq: 100, text: HIRA8 }],
  ]);
  assert.equal(planOf(lines).merges.length, 1);
  const long = longPlanOf(lines);
  assert.deepEqual(evidenceOf(long.speakers[0].evidence), ["merge→0", "seq→1", "transition→0"]);
  assert.deepEqual(long.attributed, [], "反対根拠があるのに再帰属している");
  assert.deepEqual(long.neutralized, [{ speaker: 2, segments: 1, words: 30, indexes: [6] }]);
  assert.deepEqual(long.kept, []);
});

test("E1 が一意でも E2〜E4 が 1 つも無ければ再帰属せず、条件を満たせば中立化する", () => {
  // E1 は `2 → 0`（2 seg）。長い run は `1 → 2 → 1`（②の時点で tooLong）で、`seq` は別、
  // 文字種はカタカナで連続性なし、遷移は `0 ↔ 2` が 4/6 で偏り（0.75）に届かない
  const lines = longLines([
    [0, 1000],
    [2, 3],
    [0, 100],
    [2, 4],
    [0, 100],
    [1, 200],
    [2, 30, { text: KATA8 }],
    [1, 100],
  ]);
  const plan = planOf(lines);
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.skipped.tooLong, 1, "②で tooLong になっていない");
  const long = longPlanOf(lines);
  assert.deepEqual(evidenceOf(long.speakers[0].evidence), ["merge→0"]);
  assert.deepEqual(long.attributed, [], "E1 だけで再帰属している");
  assert.deepEqual(long.neutralized, [{ speaker: 2, segments: 1, words: 30, indexes: [6] }]);
});

test("E1 と E3 だけでは再帰属しない（E3 は safe merge 済みの島と同じ出どころで、E1 と独立でない）", () => {
  // `2 → 0` の島が 3 本（E1。遷移も `0 ↔ 2` に 6 本積まれる）。長い run は `1 → 2 → 1` で、`seq` は別、
  // 文字種はカタカナで連続性なし。遷移は 0 に 6/8 = 0.75 で偏り（`LONG_MINOR_TRANSITION_BIAS`）に届く —
  // これで再帰属してしまうと、run そのものの根拠がゼロなのに「複数の独立した根拠」に見える
  const lines = longLines([
    [0, 1000],
    [2, 3],
    [0, 100],
    [2, 4],
    [0, 100],
    [2, 5],
    [0, 100],
    [1, 200],
    [2, 30, { text: KATA8 }],
    [1, 100],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.merges, [{ from: 2, to: 0, segments: 3, words: 12, indexes: [1, 3, 5] }]);
  assert.equal(plan.skipped.tooLong, 1, "②で tooLong になっていない");
  const long = longPlanOf(lines);
  assert.deepEqual(evidenceOf(long.speakers[0].evidence), ["merge→0", "transition→0"]);
  assert.deepEqual(long.attributed, [], "E1 + E3 だけで再帰属している");
  assert.deepEqual(long.neutralized, [{ speaker: 2, segments: 1, words: 30, indexes: [8] }]);
});

test("seq の無い行（旧セッションの復元）では E2 が付かない", () => {
  // 再帰属の形から `seq` だけ落とす。E1 は残るが、境目の根拠が無いので再帰属せず中立化に落ちる
  const lines = longLines(
    ATTRIBUTE_SPEC.map((e) =>
      e === "reconnect" || e[2]?.seq == null ? e : [e[0], e[1], { ...e[2], seq: undefined }],
    ) as LongSpec,
  );
  assert.equal(planOf(lines).merges.length, 1);
  const long = longPlanOf(lines);
  assert.equal(long.speakers[0].evidence.some((e: { kind: string }) => e.kind === "seq"), false);
  assert.deepEqual(long.attributed, []);
  assert.deepEqual(long.neutralized, [{ speaker: 2, segments: 1, words: 30, indexes: [6] }]);
});

test("隣が主要 speaker でない run には E2 / E4 が付かない（対象外 speaker に挟まれた形）", () => {
  // 3 は 13% で主要でも minor でもない（`others`）。長い run の両隣が 3 で、同じ final・同じ文字種でも
  // 根拠にはならない（統合先は必ず主要 speaker）。②は `mismatch`、③が `tooLong` に付け替える
  const lines = longLines([
    [0, 1000],
    [1, 300],
    [3, 100, { seq: 100, text: HIRA8 }],
    [2, 30, { seq: 100, text: HIRA8 }],
    [3, 100, { seq: 100, text: HIRA8 }],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.others, [3]);
  assert.equal(plan.skipped.mismatch, 1);
  const long = longPlanOf(lines);
  assert.equal(long.runs, 1);
  assert.deepEqual(long.speakers[0].evidence, []);
  // 根拠が無くても中立化の条件（絶対 minor・run 1 本・上限以下）は満たす
  assert.deepEqual(long.neutralized, [{ speaker: 2, segments: 1, words: 30, indexes: [3] }]);
});

test("同じ speaker の run が再帰属と維持に割れたら speaker のまとめは mixed（manyRuns は候補の本数で数える）", () => {
  // 再帰属の形に、根拠の無い長い run（`1 → 2 → 1`）をもう 1 本足す。遷移は 0 に 5/8 で偏らない
  const lines = longLines([
    [0, 2000],
    [2, 3],
    [0, 100],
    [2, 4],
    [0, 100],
    [0, 50, { seq: 100, text: HIRA8 }],
    [2, 30, { seq: 100, text: KATA8 }],
    [1, 100],
    [2, 25, { text: KATA8 }],
    [1, 100],
  ]);
  const long = longPlanOf(lines);
  assert.equal(long.runs, 2);
  assert.deepEqual(long.attributed.map((a: { indexes: number[] }) => a.indexes), [[6]]);
  assert.deepEqual(long.kept, [{ reason: "manyRuns", speaker: 2, words: 25, indexes: [8] }]);
  assert.deepEqual(long.neutralized, []);
  assert.equal(long.speakers[0].decision, "mixed");
  assert.equal(long.speakers[0].to, 0);
  assert.deepEqual(long.speakers[0].reasons, ["manyRuns"]);
});

/**
 * **現行値では `ratioTooHigh` は単独で効かない**（`absolute` ⇒ `ratio < 3%` ＝ `LONG_MINOR_NEUTRALIZE_MAX_RATIO`）。
 * 後から比率を締めたときの歯止めとして、判定明細だけ差し替えて判定順を固定する
 * （#59 の「上限のみで落ちる」と同じく、実分布では作れない形を直接与える）。
 */
test("比率が LONG_MINOR_NEUTRALIZE_MAX_RATIO 以上なら中立化しない（ratioTooHigh。notAbsolute より後）", () => {
  const lines = longLines(OBSERVED_LONG_SPEC);
  const plan = planOf(lines);
  const forced = {
    ...plan,
    minorJudgements: plan.minorJudgements.map((j: { speaker: number }) =>
      j.speaker === 2 ? { ...j, kind: "absolute", ratio: LONG_MINOR_NEUTRALIZE_MAX_RATIO } : j,
    ),
  };
  const long = planLongMinorRuns({
    plan: forced,
    unresolvedPlan: planUnresolvedMinors(forced),
    lines,
    stats: collectSpeakerStats(lines),
  });
  assert.deepEqual(long.neutralized, []);
  assert.deepEqual(long.kept.map((k: { reason: string }) => k.reason), ["ratioTooHigh"]);
});

test("想定話者数が自動なら③b も無効（②のゲートをそのまま引き継ぐ。独自ゲートは無い）", () => {
  const long = longPlanOf(longLines(ATTRIBUTE_SPEC), "auto");
  assert.equal(long.disabledBy, "auto");
  assert.equal(long.runs, 0);
  assert.deepEqual(long.attributed, []);
  assert.deepEqual(long.neutralized, []);
  assert.deepEqual(long.kept, []);
  assert.deepEqual(long.speakers, []);
  // 無効でも全キーを持つ（診断が `undefined` の分岐を持たないため）
  assert.deepEqual(Object.keys(long.keptCounts), [
    "conflictingEvidence",
    "notAbsolute",
    "ratioTooHigh",
    "manyRuns",
    "runTooLong",
  ]);
  assert.deepEqual(Object.keys(long.evidenceCounts), ["merge", "seq", "continuity", "transition"]);
  assert.deepEqual(long.thresholds, {
    neutralizeMaxRatio: LONG_MINOR_NEUTRALIZE_MAX_RATIO,
    maxRuns: LONG_MINOR_MAX_RUNS,
    maxWords: LONG_MINOR_MAX_WORDS,
    minMergeSegments: LONG_MINOR_MIN_MERGE_SEGMENTS,
    transitionBias: LONG_MINOR_TRANSITION_BIAS,
  });
  // 計画そのものが無ければ `noPlan`（「有効・0 件」と区別する。③と同じ）
  assert.equal(planLongMinorRuns({}).disabledBy, "noPlan");
  assert.deepEqual(planLongMinorRuns({}), { ...long, disabledBy: "noPlan" });
  // 再帰属の形でも「自動」なら何も起きない
  const groups = groupUtterances(longLines(ATTRIBUTE_SPEC), { expectedSpeakers: "auto" }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 2, 0, 2, 0, 2, 1]);
  assert.equal(unresolvedOf(groups).some(Boolean), false);
});

test("#59 で minor でない speaker（others）の長い run は候補にならない", () => {
  // 2 は 6%（絶対も相対も外）。②は run を作らないので③b にも来ない
  const lines = longLines([
    [0, 500],
    [1, 300],
    [2, 60],
    [0, 140],
  ]);
  const plan = planOf(lines);
  assert.deepEqual(plan.others, [2]);
  assert.deepEqual(plan.minors, []);
  const long = longPlanOf(lines);
  assert.equal(long.disabledBy, null);
  assert.equal(long.runs, 0);
  assert.deepEqual(long.speakers, []);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 2, 0]);
  assert.equal(unresolvedOf(groups).some(Boolean), false);
});

test("再接続境界・話者不明・端に接する長い run は③b の候補にならない", () => {
  const specs: Array<[string, LongSpec]> = [
    ["boundary", [[0, 600], [1, 180], [2, 26], "reconnect", [0, 194]]],
    ["unknown", [[0, 600], [1, 180], [2, 26], [null, 5], [0, 189]]],
    ["edge", [[2, 26], [0, 600], [1, 374]]],
  ];
  for (const [reason, spec] of specs) {
    const lines = longLines(spec);
    const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
    assert.deepEqual(
      correction.unresolvedPlan.skippedRuns.map((r: { reason: string }) => r.reason),
      [reason],
      `${reason}: ②の見送り理由が想定と違う`,
    );
    assert.equal(correction.longMinorPlan.runs, 0, `${reason}: ③b の候補になっている`);
    assert.deepEqual(correction.longMinorPlan.neutralized, []);
    const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
    assert.equal(unresolvedOf(groups).some(Boolean), false, `${reason}: 隠している`);
    assert.equal(correction.displayDetected, 3);
  }
});

test("③b でも raw は書き換わらず、テキストと行数は変わらず、同じ入力なら同じ計画になる", () => {
  for (const spec of [ATTRIBUTE_SPEC, OBSERVED_LONG_SPEC]) {
    const lines = longLines(spec);
    const snapshot = structuredClone(lines);
    groupUtterances(lines, { expectedSpeakers: EXPECTED_2 });
    planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
    assert.deepEqual(lines, snapshot, "raw を書き換えている");
    for (const l of lines) assert.equal("unresolved" in l, false, "raw に表示用の印が漏れている");
    // ③と④の文字数・行数が一致する（#52 の不変条件。再帰属も中立化もラベルしか変えない）
    assert.deepEqual(displayedChars(lines, EXPECTED_2), receivedChars(lines));
    const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
    assert.equal(
      groups.reduce((n: number, g) => n + (g.texts as string[]).length, 0),
      lines.length,
    );
    assert.deepEqual(longPlanOf(lines), longPlanOf(lines), "同じ入力で計画が変わる");
  }
});

test("③b の閾値は②③より緩くならない", () => {
  // 長い run を隠す線は、短い島を黙って寄せる線（#50）より緩くしない
  assert.ok(LONG_MINOR_NEUTRALIZE_MAX_RATIO <= MINOR_ISLAND_MAX_RATIO);
  // 長い run の下限は③の `MINOR_ISLAND_MAX_WORDS` で決まる。上限がそれ以下だと何も通らない
  assert.ok(LONG_MINOR_MAX_WORDS > MINOR_ISLAND_MAX_WORDS);
  assert.ok(LONG_MINOR_MAX_RUNS >= 1);
  assert.ok(LONG_MINOR_MIN_MERGE_SEGMENTS >= 1);
  assert.ok(LONG_MINOR_TRANSITION_BIAS > 0.5 && LONG_MINOR_TRANSITION_BIAS <= 1, "過半数未満を「偏り」と呼ばない");
});

test("③b の候補は skippedRuns の tooLong と 1 対 1 で、結論の合計が候補数と一致する", () => {
  // ③のテストと同じ「全理由入り」の fixture（tooLong は `0 → 2 → 0`、2 は 2.1% で絶対）
  const lines = longLines([
    [2, 3],
    [0, 600],
    [1, 400],
    [0, 100],
    [2, MINOR_ISLAND_MAX_WORDS + 1],
    [0, 100],
    "reconnect",
    [2, 3],
    [0, 100],
    [null, 5],
    [2, 3],
    [null, 5],
    [0, 100],
  ]);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  const tooLong = correction.unresolvedPlan.skippedRuns.filter((r: { reason: string }) => r.reason === "tooLong");
  assert.equal(tooLong.length, 1);
  const long = correction.longMinorPlan;
  assert.equal(long.runs, tooLong.length);
  // どこにも数えない run を作らない
  assert.equal(long.attributed.length + long.neutralized.length + long.kept.length, long.runs);
});

// ---- 話者不明にした minor 発話の同一 final による再帰属（③a、#63） ----
//
// ③が印を立てた run だけを入力に取る段。固定したいのは 4 つ。
// 1. **根拠は同一 final（`seq`）だけで、片側だけ同じ final のときにその major へ戻す** —
//    両側が同じ / どちらとも別 / `seq` 無し / run 内で割れる / 同じ final の隣が major でない、はすべて維持
// 2. **③の判定と印は変えない**（③の `neutralized` はそのまま。再帰属した行の印が消えるのは適用側の不変条件）
// 3. **③b とは互いに素で、③a の再帰属を③b の E1 に数えない**（根拠の連鎖を作らない）
// 4. **ゲートは②と同一**で、raw / text / 行数は不変
//
// fixture はここでも合成データ。`longLines()` は「行ごとの `seq` / `text` の上書きが要る fixture」全般に
// 使える（③b 専用ではない）ので、この節では `seqLines` の名で使う。境目の final は `seq` の一致だけで
// 決まり、文字列は⓪①に掛からない長さ（8 文字）であることにしか意味が無い。

const seqLines = longLines;

/** ③a の計画。本番と同じ経路（`planDisplayCorrection()` の 1 回の計算）から取る */
function unknownPlanOf(lines: Line[], expectedSpeakers: string = EXPECTED_2) {
  return planDisplayCorrection(lines, { expectedSpeakers }).unknownPlan;
}

/** ③a の維持理由の内訳。0 埋めに差分だけ重ねる（全キーを毎回書かない） */
const keptCountsOf = (over: Record<string, number> = {}) => ({
  noSeq: 0,
  mixedFinal: 0,
  sameFinalBoth: 0,
  differentFinal: 0,
  anchorNotMajor: 0,
  ...over,
});

/**
 * `A(seq 100) → X(seq 100) → B(seq 101)`。X は直前の A と同じ final、直後の B は別 final。
 * `0: 200 / 1: 160 / 2: 5`（2 は 1.4% で絶対 minor）。②は `mismatch`、③が中立化し、③a が A へ戻す。
 * **この Issue が扱う形そのもの。**
 */
const SAME_FINAL_PREV_SPEC: LongSpec = [
  [0, 150],
  [1, 100],
  [0, 50, { seq: 100, text: HIRA8 }],
  [2, 5, { seq: 100, text: HIRA8 }],
  [1, 60, { seq: 101, text: HIRA8 }],
];

/** `A(seq 100) → X(seq 101) → B(seq 101)`。上の鏡像で、X は直後の B と同じ final */
const SAME_FINAL_NEXT_SPEC: LongSpec = [
  [0, 150],
  [1, 100],
  [0, 50, { seq: 100, text: HIRA8 }],
  [2, 5, { seq: 101, text: HIRA8 }],
  [1, 60, { seq: 101, text: HIRA8 }],
];

/** 両側が同じ final。A と B の境目に挟まった断片の形で、どちらへ戻すかを決められない(`sameFinalBoth`) */
const SAME_FINAL_BOTH_SPEC: LongSpec = [
  [0, 150],
  [1, 100],
  [0, 50, { seq: 100, text: HIRA8 }],
  [2, 5, { seq: 100, text: HIRA8 }],
  [1, 60, { seq: 100, text: HIRA8 }],
];

/**
 * ③a の候補（短い `mismatch` run 2 本）と③b の候補（長い `mismatch` run 1 本）が同じ minor に共存する形。
 * 短い run はどちらも直前の 0 と同じ final（③a が 0 へ戻す）。長い run は直後の 0 と同じ final（E2→0）で、
 * **③a の再帰属 2 本を E1 に数えると `safe merge 2 seg → 0` が立って再帰属してしまう**形にしてある。
 * 文字種はカタカナで E4 を切り、遷移は 0 / 1 に 3:3 で偏らない。`0: 1200 / 1: 300 / 2: 39`（2 は 2.5% で絶対）。
 */
const COEXIST_SPEC: LongSpec = [
  [0, 1000],
  [1, 100],
  [0, 50, { seq: 100, text: HIRA8 }],
  [2, 5, { seq: 100, text: HIRA8 }],
  [1, 100, { seq: 101, text: HIRA8 }],
  [0, 50, { seq: 102, text: HIRA8 }],
  [2, 4, { seq: 102, text: HIRA8 }],
  [1, 100, { seq: 103, text: HIRA8 }],
  [2, 30, { seq: 104, text: KATA8 }],
  [0, 100, { seq: 104, text: HIRA8 }],
];

test("A(10) X(10) B(11): 話者不明にした X を同じ final の A へ戻す", () => {
  const lines = seqLines(SAME_FINAL_PREV_SPEC);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  // ③の判定は変えない。印を立てた run がそのまま③a の候補になる（run 単位の一覧も同じ行）
  assert.deepEqual(planOf(lines).skippedRuns, [{ reason: "mismatch", speaker: 2, words: 5, indexes: [3] }]);
  assert.deepEqual(correction.unresolvedPlan.neutralized, [{ speaker: 2, segments: 1, words: 5, indexes: [3] }]);
  assert.deepEqual(correction.unresolvedPlan.neutralizedRuns, [{ speaker: 2, words: 5, indexes: [3] }]);
  const unknown = correction.unknownPlan;
  assert.equal(unknown.disabledBy, null);
  assert.equal(unknown.candidates, 1);
  assert.deepEqual(unknown.attributed, [
    { from: 2, to: 0, segments: 1, words: 5, indexes: [3], evidence: [{ kind: "seq", major: 0 }] },
  ]);
  assert.deepEqual(unknown.keptUnknown, []);
  assert.deepEqual(unknown.keptCounts, keptCountsOf());
  // ④で X の text は A の段落に入り（同じ final なので run も区切りなしで連結）、印は無く、表示上の通常話者数は 2
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 1]);
  assert.deepEqual(groups[2].texts, [HIRA8, HIRA8]);
  assert.deepEqual(groups[2].runs, [HIRA8 + HIRA8]);
  assert.equal(unresolvedOf(groups).some(Boolean), false);
  assert.equal(correction.displayDetected, 2);
});

test("A(10) X(11) B(11): 向きは対称で、同じ final の B へ戻す", () => {
  const lines = seqLines(SAME_FINAL_NEXT_SPEC);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  const unknown = correction.unknownPlan;
  assert.deepEqual(unknown.attributed, [
    { from: 2, to: 1, segments: 1, words: 5, indexes: [3], evidence: [{ kind: "seq", major: 1 }] },
  ]);
  assert.deepEqual(unknown.keptUnknown, []);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 1]);
  assert.deepEqual(groups[3].texts, [HIRA8, HIRA8]);
  assert.equal(unresolvedOf(groups).some(Boolean), false);
  assert.equal(correction.displayDetected, 2);
});

test("A(10) X(10) B(10): 両側が同じ final なら戻さず話者不明のまま（sameFinalBoth）", () => {
  const lines = seqLines(SAME_FINAL_BOTH_SPEC);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  const unknown = correction.unknownPlan;
  assert.equal(unknown.candidates, 1);
  assert.deepEqual(unknown.attributed, []);
  assert.deepEqual(unknown.keptUnknown, [{ reason: "sameFinalBoth", speaker: 2, segments: 1, words: 5, indexes: [3] }]);
  assert.deepEqual(unknown.keptCounts, keptCountsOf({ sameFinalBoth: 1 }));
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 2, 1]);
  assert.deepEqual(unresolvedOf(groups), [false, false, false, true, false]);
  assert.equal(correction.displayDetected, 2);
});

test("A(10) X(11) B(12): どちらとも別 final なら戻さない（differentFinal。③のテストと同じ形）", () => {
  const lines = islandLines(MISMATCH_SPEC);
  const unknown = unknownPlanOf(lines);
  assert.deepEqual(unknown.attributed, []);
  assert.deepEqual(unknown.keptUnknown, [{ reason: "differentFinal", speaker: 2, segments: 1, words: 5, indexes: [3] }]);
  assert.deepEqual(unknown.keptCounts, keptCountsOf({ differentFinal: 1 }));
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(unresolvedOf(groups), [false, false, false, true, false]);
});

test("X に seq が無ければ戻さない（noSeq。旧セッションの復元は今までどおり）", () => {
  // 隣の A に `seq` があっても、X 自身に無ければ同じ final を確かめられない。時間窓へは落とさない
  const lines = seqLines([
    [0, 150],
    [1, 100],
    [0, 50, { seq: 100, text: HIRA8 }],
    [2, 5, { seq: undefined, text: HIRA8 }],
    [1, 60, { seq: 101, text: HIRA8 }],
  ]);
  const unknown = unknownPlanOf(lines);
  assert.deepEqual(unknown.attributed, []);
  assert.deepEqual(unknown.keptUnknown, [{ reason: "noSeq", speaker: 2, segments: 1, words: 5, indexes: [3] }]);
  assert.deepEqual(unknown.keptCounts, keptCountsOf({ noSeq: 1 }));
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(unresolvedOf(groups), [false, false, false, true, false]);
});

test("run の中で final が割れていれば戻さない（mixedFinal）", () => {
  // X の 2 行は同じ run（②が切らない）だが `seq` が 100 / 101 に割れる。A(100) B(102)
  const lines = seqLines([
    [0, 150],
    [1, 100],
    [0, 50, { seq: 100, text: HIRA8 }],
    [2, 3, { seq: 100, text: HIRA8 }],
    [2, 3, { seq: 101, text: HIRA8 }],
    [1, 60, { seq: 102, text: HIRA8 }],
  ]);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(correction.unresolvedPlan.neutralizedRuns, [{ speaker: 2, words: 6, indexes: [3, 4] }]);
  const unknown = correction.unknownPlan;
  assert.equal(unknown.candidates, 1);
  assert.deepEqual(unknown.attributed, []);
  assert.deepEqual(unknown.keptUnknown, [{ reason: "mixedFinal", speaker: 2, segments: 2, words: 6, indexes: [3, 4] }]);
  assert.deepEqual(unknown.keptCounts, keptCountsOf({ mixedFinal: 1 }));
  // 同じ raw speaker の中立行は 1 段落にまとまる（#50 の規則のまま）
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 2, 1]);
  assert.deepEqual(unresolvedOf(groups), [false, false, false, true, false]);
  assert.equal((groups[3].texts as string[]).length, 2);
});

test("Y(minor,10) X(10) A(11): 同じ final の隣が major でなければ戻さない（anchorNotMajor）", () => {
  // X → Y の遷移は観測された話者交代なので跨がない。Y から見ても同じ final の隣は X（minor）
  const lines = seqLines([
    [0, 150],
    [1, 100],
    [3, 4, { seq: 100, text: HIRA8 }],
    [2, 5, { seq: 100, text: HIRA8 }],
    [0, 60, { seq: 101, text: HIRA8 }],
  ]);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(planOf(lines).majors, [0, 1]);
  assert.deepEqual(planOf(lines).minors, [2, 3]);
  const unknown = correction.unknownPlan;
  assert.equal(unknown.candidates, 2);
  assert.deepEqual(unknown.attributed, []);
  assert.deepEqual(unknown.keptUnknown, [
    { reason: "anchorNotMajor", speaker: 3, segments: 1, words: 4, indexes: [2] },
    { reason: "anchorNotMajor", speaker: 2, segments: 1, words: 5, indexes: [3] },
  ]);
  assert.deepEqual(unknown.keptCounts, keptCountsOf({ anchorNotMajor: 2 }));
  // 隣接した異なる minor の中立行は溶けない（#50 の不変条件）
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 3, 2, 0]);
  assert.deepEqual(unresolvedOf(groups), [false, false, true, true, false]);
  assert.equal(correction.displayDetected, 2);
});

test("Y(minor,9) X(10) A(10): 反対側が minor でも別 final なら A へ戻す", () => {
  // 反対側の隣が major かどうかは見ない。X→Y の境目は跨がない（Y は別 final なので影響しない）
  const lines = seqLines([
    [0, 150],
    [1, 100],
    [3, 4, { seq: 99, text: HIRA8 }],
    [2, 5, { seq: 100, text: HIRA8 }],
    [0, 60, { seq: 100, text: HIRA8 }],
  ]);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  const unknown = correction.unknownPlan;
  assert.equal(unknown.candidates, 2);
  assert.deepEqual(unknown.attributed, [
    { from: 2, to: 0, segments: 1, words: 5, indexes: [3], evidence: [{ kind: "seq", major: 0 }] },
  ]);
  // Y は X とも別 final なので維持
  assert.deepEqual(unknown.keptUnknown, [{ reason: "differentFinal", speaker: 3, segments: 1, words: 4, indexes: [2] }]);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 3, 0]);
  assert.deepEqual(unresolvedOf(groups), [false, false, true, false]);
  assert.deepEqual(groups[3].texts, [HIRA8, HIRA8]);
  assert.equal(correction.displayDetected, 2);
});

test("短い mismatch run は③a、長い run は③b が扱い、③a の再帰属は③b の E1 に数えない", () => {
  const lines = seqLines(COEXIST_SPEC);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(planOf(lines).merges, [], "fixture に②の safe merge がある（E1 を観測できない）");
  assert.deepEqual(kindsOf(planOf(lines)), { 2: "absolute" });
  // ③: 短い 2 本に印、長い 1 本は `tooLong` へ付け替え
  assert.deepEqual(correction.unresolvedPlan.neutralizedRuns, [
    { speaker: 2, words: 5, indexes: [3] },
    { speaker: 2, words: 4, indexes: [6] },
  ]);
  assert.deepEqual(correction.unresolvedPlan.skippedRuns, [{ reason: "tooLong", speaker: 2, words: 30, indexes: [8] }]);
  // ③a: 短い 2 本を 0 へ（走査順のまま）
  const unknown = correction.unknownPlan;
  assert.equal(unknown.candidates, 2);
  // 候補は再帰属と維持に漏れなく分かれる(診断の「候補」の run 数は計画の `candidates` から出す)
  assert.equal(unknown.candidates, unknown.attributed.length + unknown.keptUnknown.length);
  assert.deepEqual(
    unknown.attributed.map((a: { to: number; indexes: number[] }) => [a.to, a.indexes]),
    [
      [0, [3]],
      [0, [6]],
    ],
  );
  assert.deepEqual(unknown.keptUnknown, []);
  // ③b: 長い 1 本は E1 が無いので再帰属せず（③a の 2 本を数えれば `safe merge 2 seg → 0` + E2→0 で再帰属してしまう）、
  // 絶対 minor・run 1 本・上限以下で中立化
  const long = correction.longMinorPlan;
  assert.equal(long.runs, 1);
  assert.deepEqual(long.attributed, [], "③a の再帰属が③b の E1 に数えられている");
  assert.deepEqual(evidenceOf(long.speakers[0].evidence), ["seq→0"]);
  assert.deepEqual(long.neutralized, [{ speaker: 2, segments: 1, words: 30, indexes: [8] }]);
  // ④: 短い 2 本は 0 の段落へ、長い 1 本だけ話者不明
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 1, 0, 1, 2, 0]);
  assert.deepEqual(unresolvedOf(groups), [false, false, false, false, false, false, true, false]);
  assert.equal(correction.displayDetected, 2);
});

test("想定話者数が自動・検出が想定以下なら③a も無効（②のゲートをそのまま引き継ぐ。独自ゲートは無い）", () => {
  const lines = seqLines(SAME_FINAL_PREV_SPEC);
  const empty = {
    candidates: 0,
    attributed: [],
    keptUnknown: [],
    keptCounts: keptCountsOf(),
    disabledBy: "auto",
  };
  assert.deepEqual(unknownPlanOf(lines, "auto"), empty);
  // 検出 3 で想定 3 なら減らす理由が無い
  assert.deepEqual(unknownPlanOf(lines, "3"), { ...empty, disabledBy: "detectedNotOver" });
  // 無効でも全キーをこの順で持つ（診断の表示名の表と突き合わせる）
  assert.deepEqual(Object.keys(unknownPlanOf(lines, "auto").keptCounts), [
    "noSeq",
    "mixedFinal",
    "sameFinalBoth",
    "differentFinal",
    "anchorNotMajor",
  ]);
  // 計画そのものが無ければ `noPlan`（「有効・0 件」と区別する。③③b と同じ）
  assert.deepEqual(planUnknownReattribution({}), { ...empty, disabledBy: "noPlan" });
  // 戻す形でも「自動」なら何も起きない
  const groups = groupUtterances(lines, { expectedSpeakers: "auto" }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 2, 1]);
  assert.equal(unresolvedOf(groups).some(Boolean), false);
});

test("⓪が寄せる 3 文字以下の断片は③の候補にならず、③a の候補も 0（⓪との重複なし）", () => {
  // 同じ final の 1 文字の断片は⓪が A へ寄せるので、②の走査には X が現れない
  const lines = seqLines([
    [0, 150],
    [1, 100],
    [0, 50, { seq: 100, text: ANCHOR6 }],
    [2, 1, { seq: 100, text: "あ" }],
    [1, 60, { seq: 101, text: HIRA8 }],
  ]);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.equal(correction.boundaryPlan.applied.length, 1, "⓪が寄せていない");
  // ②の計画は⓪①通過後の行に対するもの（raw に直接当てると X の run が見える）
  assert.deepEqual((correction.plan as { skippedRuns: unknown[] }).skippedRuns, []);
  assert.deepEqual(correction.unresolvedPlan.neutralizedRuns, []);
  // 「有効・0 run」（無効ではない）
  assert.equal(correction.unknownPlan.disabledBy, null);
  assert.equal(correction.unknownPlan.candidates, 0);
  assert.deepEqual(correction.unknownPlan.attributed, []);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.deepEqual(speakersOf(groups), [0, 1, 0, 1]);
  assert.equal(correction.displayDetected, 2);
});

test("③a でも raw は書き換わらず、テキストと行数は変わらず、同じ入力なら同じ計画になる", () => {
  for (const spec of [SAME_FINAL_PREV_SPEC, SAME_FINAL_NEXT_SPEC, COEXIST_SPEC]) {
    const lines = seqLines(spec);
    const snapshot = structuredClone(lines);
    groupUtterances(lines, { expectedSpeakers: EXPECTED_2 });
    planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
    assert.deepEqual(lines, snapshot, "raw を書き換えている");
    for (const l of lines) assert.equal("unresolved" in l, false, "raw に表示用の印が漏れている");
    // ③と④の文字数・行数が一致する（#52 の不変条件。再帰属はラベルしか変えない）
    assert.deepEqual(displayedChars(lines, EXPECTED_2), receivedChars(lines));
    const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
    assert.equal(
      groups.reduce((n: number, g) => n + (g.texts as string[]).length, 0),
      lines.length,
    );
    assert.deepEqual(unknownPlanOf(lines), unknownPlanOf(lines), "同じ入力で計画が変わる");
  }
});

test("③で印が立った行が③a で再帰属されると印が消え、通常の段落に入る（applyMerges の不変条件）", () => {
  // 印が残っていれば `mergeSameSpeaker()` は通常の発話と絶対に結合しない（#50）ので、
  // X が B の段落に入ること自体が「印が落ちた」ことの観測になる
  const lines = seqLines(SAME_FINAL_NEXT_SPEC);
  const correction = planDisplayCorrection(lines, { expectedSpeakers: EXPECTED_2 });
  assert.deepEqual(correction.unresolvedPlan.neutralized[0].indexes, [3], "③が印を立てていない");
  assert.deepEqual(correction.unknownPlan.attributed[0].indexes, [3]);
  const groups = groupUtterances(lines, { expectedSpeakers: EXPECTED_2 }) as Array<Record<string, unknown>>;
  assert.equal(groups.length, 4, "X が独立した段落として残っている");
  for (const g of groups) assert.equal("unresolved" in g, false, "印が表示に残っている");
});
