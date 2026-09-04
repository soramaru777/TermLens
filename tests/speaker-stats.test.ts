import assert from "node:assert/strict";
import test from "node:test";
// public/ はビルドレスな素の JS。tsconfig.test.json の allowJs で解決している
// （tsconfig.json 側は src/ だけを見るので本番ビルドには影響しない）。
import {
  DEFAULT_EXPECTED_SPEAKERS,
  DOMINANT_SPEAKER_RATIO,
  EXPECTED_SPEAKER_OPTIONS,
  MINOR_SPEAKER_RATIO,
  collectSpeakerStats,
  expectedSpeakerCount,
  expectedSpeakerLabel,
  normalizeExpectedSpeakers,
  speakerWarnings,
} from "../public/speaker-stats.js";
import { smoothSpeakerJitter } from "../public/utterances.js";

/**
 * 話者分離の診断統計（#46）。この Issue は **speaker を補正しない** — 想定話者数と
 * 実検出話者数の差を測れる状態を作るのが目的なので、ここで固定するのは
 * 「集計が raw と等価か」と「診断に会話本文が混ざらないか」の2点。
 *
 * **fixture は匿名化した synthetic な speaker 列だけ**にする（#18 の方針）。
 * 実会話・実際の用語・固有名詞は使わない。テキストは長さにしか意味が無いので、
 * 文字数を制御できるダミー文字列を使う。
 */

/** 発話行1件。`w` はそのセグメントの word 数（`ServerMessage.wordCount`）。 */
function line(speaker: number | null | undefined, words: number, chars = words, t = 0) {
  return { text: "x".repeat(chars), speaker, t, seq: 1, w: words };
}

/** 再接続の区切り印。発話ではない。 */
const RECONNECT = { type: "reconnect", t: 0 };

// ---- 検出話者数 ----

test("同一話者のランが繰り返されても、検出話者数は種類数", () => {
  // [0,0,1,1,0] は splitBySpeaker() が作りうるラン列そのもの。
  // ラン数（5）ではなく speaker の種類数（2）を数える
  const stats = collectSpeakerStats([0, 0, 1, 1, 0].map((sp) => line(sp, 2)));
  assert.equal(stats.detected, 2);
  assert.deepEqual(
    stats.speakers.map((s) => s.speaker),
    [0, 1],
    "speaker 昇順で並ぶ",
  );
  assert.equal(stats.totalSegments, 5);
});

/**
 * **speaker が付かなかったセグメントを検出数に混ぜない。**
 *
 * 混ぜると「diarize が話者を1人も特定できなかった区間」が1人ぶんの話者として
 * 数えられ、想定話者数との差がその区間の有無で動く。ただし件数は落とさない
 * （落とすと合計が合わず、統計を読む側が欠損に気づけない）。
 */
test("speaker が null / undefined のセグメントは検出数に含めず unknownSegments に数える", () => {
  const stats = collectSpeakerStats([
    line(0, 2),
    line(null, 2),
    line(undefined, 2),
    line(1, 2),
  ]);
  assert.equal(stats.detected, 2);
  assert.equal(stats.unknownSegments, 2);
  assert.equal(stats.totalSegments, 4, "件数からは落とさない");
});

// ---- word 数と割合 ----

test("speaker ごとの word 数・文字数・割合が合う", () => {
  const stats = collectSpeakerStats([
    line(0, 6, 12),
    line(1, 2, 4),
    line(0, 2, 4),
  ]);
  assert.equal(stats.ratioBasis, "words");
  assert.equal(stats.totalWords, 10);
  assert.equal(stats.totalChars, 20);
  const [sp0, sp1] = stats.speakers;
  assert.deepEqual(
    { words: sp0.words, chars: sp0.chars, segments: sp0.segments, ratio: sp0.ratio },
    { words: 8, chars: 16, segments: 2, ratio: 0.8 },
  );
  assert.deepEqual(
    { words: sp1.words, chars: sp1.chars, segments: sp1.segments, ratio: sp1.ratio },
    { words: 2, chars: 4, segments: 1, ratio: 0.2 },
  );
});

test("初出・最終は受信時刻の最小と最大", () => {
  const stats = collectSpeakerStats([
    line(0, 1, 1, 1000),
    line(1, 1, 1, 2000),
    line(0, 1, 1, 5000),
  ]);
  assert.deepEqual(
    stats.speakers.map((s) => [s.firstT, s.lastT]),
    [
      [1000, 5000],
      [2000, 2000],
    ],
  );
});

/**
 * **`w` が1件も無ければ分母を文字数へ落とす。** 旧サーバー・#46 以前に保存された
 * セッションの復元経路がこれ。落ちること自体より、**どちらで計算したかを返す**ことが
 * 要点で、分母が黙って入れ替わると数値どうしを比較できなくなる。
 */
test("w を持たない行だけなら ratioBasis が chars に落ちる", () => {
  const stats = collectSpeakerStats([
    { text: "xxxxxxxx", speaker: 0, t: 0 },
    { text: "xx", speaker: 1, t: 0 },
  ]);
  assert.equal(stats.ratioBasis, "chars");
  assert.equal(stats.totalWords, 0);
  assert.equal(stats.totalChars, 10);
  assert.deepEqual(
    stats.speakers.map((s) => s.ratio),
    [0.8, 0.2],
    "割合は文字数で出す",
  );
});

test("1件でも w があれば word 基準（分母の定義が行ごとに揺れない）", () => {
  const stats = collectSpeakerStats([line(0, 4), { text: "xx", speaker: 1, t: 0 }]);
  assert.equal(stats.ratioBasis, "words");
  assert.equal(stats.totalWords, 4);
  assert.equal(stats.speakers[1].words, 0, "w を欠く行はその行を 0 word として扱う");
});

test("発話が1件も無くても壊れない", () => {
  const empty = collectSpeakerStats([]);
  assert.equal(empty.detected, 0);
  assert.equal(empty.totalSegments, 0);
  assert.deepEqual(empty.speakers, []);
  assert.deepEqual(empty.transitions, []);
  assert.deepEqual(collectSpeakerStats([RECONNECT]).speakers, []);
});

// ---- 話者遷移 ----

test("遷移は隣接するランの (from,to) を数える", () => {
  const stats = collectSpeakerStats([0, 1, 0, 1, 2].map((sp) => line(sp, 1)));
  assert.deepEqual(stats.transitions, [
    // 回数降順 → from,to 昇順。同数のときの並びを決めておかないと
    // 同じデータから作った Markdown が実行ごとに違う順序で出る
    { from: 0, to: 1, count: 2 },
    { from: 1, to: 0, count: 1 },
    { from: 1, to: 2, count: 1 },
  ]);
});

/**
 * **`0→0`（同一話者の継続）は遷移ではない。**
 *
 * 数えると「話者が何回入れ替わったか」ではなく「final が何件届いたか」に近い量になり、
 * 分離の細切れ具合を測る指標として使えなくなる。raw の word 列では同一話者が続く限り
 * 1つのランなので、ラン列から数えている限りこれは構造的に起きない。
 */
test("同一 speaker が続いても遷移に数えない", () => {
  const stats = collectSpeakerStats([0, 0, 0].map((sp) => line(sp, 1)));
  assert.deepEqual(stats.transitions, []);
});

/**
 * **再接続をまたぐ遷移は数えない。** 再接続後は話者番号が振り直しで、同じ番号でも
 * 別人でありうる（`public/utterances.js` が結合を切っているのと同じ理由）。
 * またいで数えると、実際には起きていない話者交代が積み上がる。
 */
test("再接続の区切り印をまたぐ遷移は数えない", () => {
  const stats = collectSpeakerStats([line(0, 1), RECONNECT, line(1, 1)]);
  assert.deepEqual(stats.transitions, [], "境界を越えて 0→1 を数えている");
  assert.equal(stats.detected, 2, "話者の集計自体は続ける");
  assert.equal(stats.totalSegments, 2, "区切り印は発話として数えない");
});

test("話者不明のセグメントをまたぐ遷移も数えない", () => {
  // 誰が話したか分からない区間をまたいで 0→1 を数えると、観測していない交代を作る
  const stats = collectSpeakerStats([line(0, 1), line(null, 1), line(1, 1)]);
  assert.deepEqual(stats.transitions, []);
});

// ---- 表示補正との分離 ----

/**
 * **この1本が #46 の AC「表示補正と診断用 raw 統計が分離されている」の実体。**
 *
 * `smoothSpeakerJitter()` はコピーを返す契約なので、同じ配列を渡した前後で
 * `collectSpeakerStats()` の結果は1ビットも変わらないはず。補正が引数を破壊すると
 * 例外は出ず、**補正の効き具合を測るための統計が補正後の値になる**という形で静かに壊れる。
 */
test("smoothSpeakerJitter() を通しても raw 統計は変わらない", () => {
  // jitter 補正が実際に効く形（前後が同じ話者、真ん中だけ短くて違う、seq が揃っている）
  const lines = [
    { text: "xxxxxxxx", speaker: 0, t: 100, seq: 7, w: 4 },
    { text: "xx", speaker: 1, t: 100, seq: 7, w: 1 },
    { text: "xxxxxxxx", speaker: 0, t: 100, seq: 7, w: 4 },
  ];
  const before = collectSpeakerStats(lines);
  const smoothed = smoothSpeakerJitter(lines);
  // 前提: 補正が実際に効いていること（効かない入力だと、この比較は何も守らない）
  assert.equal(smoothed[1].speaker, 0, "jitter 補正が効いていない入力になっている");
  const after = collectSpeakerStats(lines);
  assert.deepEqual(after, before, "補正が引数の finalLines を書き換えている");
  assert.equal(after.detected, 2, "raw では 2 speaker のまま");
  // 補正後のコピーから集計すると 1 speaker になる ＝ 集計元を取り違えると数字が変わる
  assert.equal(collectSpeakerStats(smoothed).detected, 1);
});

test("collectSpeakerStats は引数の配列も要素も変更しない", () => {
  const lines = [line(0, 2), RECONNECT, line(1, 3)];
  const snapshot = JSON.parse(JSON.stringify(lines));
  collectSpeakerStats(lines);
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), snapshot);
});

// ---- 想定話者数 ----

test("想定話者数の既定は自動で、人数を持たない", () => {
  assert.equal(DEFAULT_EXPECTED_SPEAKERS, "auto");
  assert.equal(expectedSpeakerLabel(DEFAULT_EXPECTED_SPEAKERS), "自動");
  assert.equal(expectedSpeakerCount(DEFAULT_EXPECTED_SPEAKERS), null, "auto は人数を申告しない");
  assert.equal(expectedSpeakerCount("2"), 2);
  assert.equal(expectedSpeakerCount("4plus"), 4);
  assert.equal(expectedSpeakerLabel("4plus"), "4人以上");
});

/**
 * 値は `localStorage`（信頼境界の外）から来る。**素のオブジェクト添字で引くと
 * `"constructor"` / `"toString"` が `Object.prototype` 経由で truthy になり**、
 * `count` が `undefined` のまま比較へ流れる（`capture-mode.js` が
 * `Object.hasOwn` で塞いでいるのと同じ穴）。
 */
test("normalizeExpectedSpeakers は不正値も prototype の名前も既定へ丸める", () => {
  for (const bad of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "5",
    "",
    "auto ",
    null,
    undefined,
    2,
    {},
  ]) {
    assert.equal(
      normalizeExpectedSpeakers(bad as never),
      DEFAULT_EXPECTED_SPEAKERS,
      `${String(bad)} が既定に丸まっていない`,
    );
  }
  for (const opt of EXPECTED_SPEAKER_OPTIONS) {
    assert.equal(normalizeExpectedSpeakers(opt.value), opt.value, "既知の値は通す");
  }
  // 丸めた先でも必ず label / count が引ける（undefined が下流へ流れない）
  assert.equal(typeof expectedSpeakerLabel("constructor"), "string");
  assert.equal(expectedSpeakerCount("constructor"), null);
});

// ---- 警告 ----

test("想定が自動なら、検出数がいくつでも差の警告は出さない", () => {
  const stats = collectSpeakerStats([0, 1, 2].map((sp) => line(sp, 10)));
  const warnings = speakerWarnings(stats, "auto");
  assert.deepEqual(warnings, [], "人数を申告していないのに差を警告している");
});

test("想定2人に対し3 speaker を検出したら警告する", () => {
  const stats = collectSpeakerStats([0, 1, 2].map((sp) => line(sp, 10)));
  const warnings = speakerWarnings(stats, "2");
  assert.ok(
    warnings.some((w) => w.includes("想定2人に対し 3 speaker を検出")),
    `差の警告が出ていない: ${JSON.stringify(warnings)}`,
  );
  // **断定しない文言にする**（この Issue では補正を一切行わないため）
  for (const w of warnings) assert.match(w, /^⚠ /);
});

test("4人以上は「以上」なので、検出が4以上なら差の警告を出さない", () => {
  const four = collectSpeakerStats([0, 1, 2, 3].map((sp) => line(sp, 10)));
  assert.deepEqual(speakerWarnings(four, "4plus"), []);
  const five = collectSpeakerStats([0, 1, 2, 3, 4].map((sp) => line(sp, 10)));
  assert.deepEqual(speakerWarnings(five, "4plus"), [], "多い側は差とみなさない");
  // 足りない側は警告する
  const three = collectSpeakerStats([0, 1, 2].map((sp) => line(sp, 10)));
  assert.ok(speakerWarnings(three, "4plus").some((w) => w.includes("想定4人以上に対し 3 speaker")));
});

test("極端に少ない speaker は偽 speaker の候補として挙げる", () => {
  // speaker 2 は 2/200 = 1.0%（MINOR_SPEAKER_RATIO 未満）
  const stats = collectSpeakerStats([line(0, 120), line(1, 78), line(2, 2)]);
  const warnings = speakerWarnings(stats, "3");
  assert.ok(
    warnings.some((w) => w.includes("speaker 2 が全 word の 1.0%") && w.includes("偽 speaker の可能性")),
    `少数派の警告が出ていない: ${JSON.stringify(warnings)}`,
  );
  assert.ok(MINOR_SPEAKER_RATIO > 0 && MINOR_SPEAKER_RATIO < 1);
});

test("1人が占有していたら潰れている可能性として挙げる（想定に関係なく出す）", () => {
  // speaker 0 は 190/200 = 95.0%（DOMINANT_SPEAKER_RATIO 以上）
  const stats = collectSpeakerStats([line(0, 190), line(1, 10)]);
  const warned = speakerWarnings(stats, "2");
  assert.ok(
    warned.some((w) => w.includes("speaker 0 が全 word の 95.0% を占有") && w.includes("2人が1人へ潰れている可能性")),
    `占有の警告が出ていない: ${JSON.stringify(warned)}`,
  );
  // 想定を申告していなくても占有そのものは出す（人数だけ断定しない）
  const auto = speakerWarnings(stats, "auto");
  assert.ok(auto.some((w) => w.includes("複数人が1人へ潰れている可能性")));
  assert.ok(DOMINANT_SPEAKER_RATIO > 0.5 && DOMINANT_SPEAKER_RATIO <= 1);
});

test("想定どおりで偏りも無ければ警告は出ない", () => {
  const stats = collectSpeakerStats([line(0, 50), line(1, 50)]);
  assert.deepEqual(speakerWarnings(stats, "2"), []);
});

test("発話が無ければ警告も出さない", () => {
  assert.deepEqual(speakerWarnings(collectSpeakerStats([]), "2"), []);
  assert.deepEqual(speakerWarnings(null as never, "2"), []);
});

test("文字数基準のときは警告の単位も文字になる", () => {
  // 単位を word のままにすると、word 数を送っていないセッションの診断が嘘になる。
  // 文全体を `ratioBasisView().ofTotal()` が組み立てるのは日本語の語間のため
  // （単位だけ差し替えると「全 文字 の 95.0%」という不自然な空白が入る）
  const stats = collectSpeakerStats([
    { text: "x".repeat(190), speaker: 0, t: 0 },
    { text: "x".repeat(10), speaker: 1, t: 0 },
  ]);
  const warnings = speakerWarnings(stats, "auto");
  assert.ok(warnings.some((w) => w.includes("全文字数の 95.0%")), JSON.stringify(warnings));
  assert.ok(!warnings.some((w) => w.includes("word")), JSON.stringify(warnings));
});

// ---- レビュー指摘に対する回帰（#46 のレビュー）----

test("整数でない speaker は話者不明に倒す", () => {
  // `finalLines` は localStorage から**検証なしで**復元される（信頼境界の外）。
  // 丸めずに通すと (1) String(speaker) が診断 Markdown に任意の文字列を通す唯一の経路になり
  // (2) 遷移キー `${prev}>${speaker}` が `>` を含む文字列で分解破綻し
  // (3) speaker の昇順ソートが NaN で壊れる。ここが唯一の防波堤
  const stats = collectSpeakerStats([
    { text: "xx", speaker: "0>1" as never, t: 0, w: 2 },
    { text: "xx", speaker: {} as never, t: 0, w: 2 },
    { text: "xx", speaker: true as never, t: 0, w: 2 },
    { text: "xx", speaker: "0" as never, t: 0, w: 2 },
    { text: "xx", speaker: 1.5 as never, t: 0, w: 2 },
  ]);
  assert.equal(stats.detected, 0, JSON.stringify(stats.speakers));
  assert.equal(stats.unknownSegments, 5);
  assert.deepEqual(stats.transitions, []);
});

test("話者不明ぶんは分母に入るので、その量も返す", () => {
  // 未帰属ぶんは分母に入るが どの speaker にも帰属しないので Σratio < 1 になる。
  // 量が読めないと、閾値（MINOR/DOMINANT）を実データから決められない
  const stats = collectSpeakerStats([line(0, 60), line(null, 40)]);
  assert.equal(stats.totalWords, 100);
  assert.equal(stats.unknownWords, 40);
  assert.equal(stats.unknownChars, 40);
  assert.equal(stats.speakers[0].ratio, 0.6);
  const sum = stats.speakers.reduce((a, s) => a + s.ratio, 0);
  assert.ok(sum < 1, `未帰属ぶんが分子に混ざっている: ${sum}`);
});

test("分母が 0 なら割合の警告を出さない", () => {
  // 全 speaker の ratio が 0 になるので、出すと「0.0%（偽 speaker の可能性）」が
  // speaker の数だけ並ぶ。観測事実ではなくデータ欠損の artifact
  const stats = collectSpeakerStats([line(0, 0, 0), line(1, 0, 0)]);
  assert.equal(stats.ratioBasis, "words");
  assert.equal(stats.totalWords, 0);
  const warnings = speakerWarnings(stats, "auto");
  assert.deepEqual(warnings, [], JSON.stringify(warnings));
  // 想定と検出の差は分母と無関係なので、こちらは出す
  assert.equal(speakerWarnings(stats, "3").length, 1);
});

test("再接続の回数を数える（遷移が下限であることの手掛かり）", () => {
  const stats = collectSpeakerStats([
    line(0, 1),
    { type: "reconnect", t: 0 },
    line(1, 1),
    { type: "reconnect", t: 0 },
    line(0, 1),
  ]);
  assert.equal(stats.reconnects, 2);
  // 鎖が切れているので遷移は 0。回数を出さないと、別セッションと比べたときに
  // 「遷移が少ない」のか「切れていた」のかが読めない
  assert.deepEqual(stats.transitions, []);
  assert.equal(stats.totalSegments, 3, "区切り印はセグメントに数えない");
});
