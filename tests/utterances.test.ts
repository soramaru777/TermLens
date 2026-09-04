import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// public/ はビルドレスな素の JS。tsconfig.test.json の allowJs で解決している
// （`tests/card-status.test.ts` が public/card-status.js を読むのと同じ）。
import {
  JITTER_CHAR_LIMIT,
  JITTER_WINDOW_MS,
  MINOR_ISLAND_MAX_RATIO,
  MINOR_ISLAND_MAX_WORDS,
  MIN_TOTAL_WORDS_FOR_ISLANDS,
  groupUtterances,
  mergeSameSpeaker,
  planMinorIslandMerges,
  smoothMinorSpeakerIslands,
  smoothSpeakerJitter,
} from "../public/utterances.js";
import { collectSpeakerStats } from "../public/speaker-stats.js";

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
  const lines = [line("まえ", 0, { seq: 7 }), reconnect(), line(SHORT, 1, { seq: 1 }), line("あと", 0, { seq: 1 })];
  assert.deepEqual(summary(groupUtterances(lines)), [
    { speaker: 0, text: "まえ" },
    { type: "reconnect" },
    { speaker: 1, text: SHORT },
    { speaker: 0, text: "あと" },
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
