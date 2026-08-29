import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// public/ はビルドレスな素の JS。tsconfig.test.json の allowJs で解決している
// （`tests/card-status.test.ts` が public/card-status.js を読むのと同じ）。
import {
  JITTER_CHAR_LIMIT,
  JITTER_WINDOW_MS,
  groupUtterances,
  mergeSameSpeaker,
  smoothSpeakerJitter,
} from "../public/utterances.js";

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
