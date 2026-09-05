import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLIP_THRESHOLD,
  SILENCE_DBFS,
  DBFS_BINS,
  dbfsBin,
  toDbfs,
  histogramRows,
  audioStatRows,
  buildDiagnosticsMarkdown,
  emptyAudioStats,
  mergeAudioStats,
  pickTrackSettings,
  summarizeAudioStats,
  trackSettingRows,
  fmtElapsed,
  speakerDiagRows,
  textIntegrityRows,
  textIntegrityStageRows,
  textIntegrityVerdict,
  BOUNDARY_SKIP_LABELS,
} from "../public/diagnostics.js";
import { collectSpeakerStats } from "../public/speaker-stats.js";
// 表示補正の計画は utterances.js が唯一の定義箇所（#48）。**診断もそこを通る**ので、
// 「表示に効かせた補正」と「診断に出す件数」が別実装になりようがない
import { planDisplayCorrection, planMinorIslandMerges, smoothSpeakerBoundaries } from "../public/utterances.js";

/**
 * 収音診断（#26）。固定するのは2つ。
 *
 * 1. **何が診断に出るか** — `getSettings()` は `deviceId` / `groupId` を含み、これは
 *    端末ごとに安定した識別子。会話本文でも音声でもないが、エクスポートすると端末を
 *    特定できる値が外に出る。除外リストではなく**採用リスト**であることを確かめる
 *    （ブラウザが将来キーを足しても勝手に混ざらない、という性質はここでしか守れない）
 * 2. 統計の集計と、Markdown が会話本文を含まないこと
 */

// 実際の Chrome / Safari が返しうる形。端末識別子つき
const RAW_SETTINGS = {
  deviceId: "b7f1c9a2e4d6...",
  groupId: "0e3a55b1c9...",
  sampleRate: 48000,
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

test("採用リストなので、知らないキーも端末識別子も通らない", () => {
  // **除外リストだとここが落ちない。** ブラウザが将来 getSettings() に新しいキーを
  // 足したとき、明示的に足していないものは診断に出ないことを固定する
  const picked = pickTrackSettings({
    ...RAW_SETTINGS,
    someFutureIdentifier: "abc",
    displaySurface: "monitor",
    facingMode: "user",
  }) as Record<string, unknown>;
  // キーの集合を固定すれば deviceId / groupId の不在も同時に守れる
  assert.deepEqual(Object.keys(picked).sort(), [
    "autoGainControl",
    "channelCount",
    "echoCancellation",
    "noiseSuppression",
    "sampleRate",
  ]);
  assert.equal(picked.sampleRate, 48000, "値も素通しではなく元の値が入る");
  assert.equal(picked.echoCancellation, false);
});

test("getSettings() が無い/空でも落ちない", () => {
  assert.deepEqual(pickTrackSettings(undefined), {});
  assert.deepEqual(pickTrackSettings(null), {});
  assert.deepEqual(pickTrackSettings({}), {});
  // 報告されなかったキー（undefined）は「無い」と同じ扱いにする
  assert.deepEqual(pickTrackSettings({ sampleRate: undefined, channelCount: 2 }), {
    channelCount: 2,
  });
});

test("閾値は 0〜1 の範囲にある（暫定値でも意味のある範囲であること）", () => {
  assert.ok(CLIP_THRESHOLD > 0 && CLIP_THRESHOLD <= 1);
  // 無音の水準は分布に当てる読み値。クリップはサンプル振幅の閾値で、別の軸の量
  assert.ok(SILENCE_DBFS < 0, "無音の水準はフルスケール未満");
  assert.ok(CLIP_THRESHOLD > 0 && CLIP_THRESHOLD <= 1);
});

// ---- 統計の集計 ----

test("mergeAudioStats は加算し、peak だけ最大値を取る", () => {
  let stats = emptyAudioStats();
  stats = mergeAudioStats(stats, {
    samples: 100,
    sumSq: 4,
    clipped: 2,
    peak: 0.42,
    windows: [0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0],
  });
  stats = mergeAudioStats(stats, {
    samples: 100,
    sumSq: 12,
    clipped: 0,
    peak: 0.9,
    windows: [0, 0, 3, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0],
  });
  assert.deepEqual(stats, {
    samples: 200,
    sumSq: 16,
    clipped: 2,
    // ピークは「一番大きく入った瞬間」。足し合わせると意味を失う
    peak: 0.9,
    // 分布はビンごとに足す
    windows: [0, 0, 4, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0],
  });
});

test("mergeAudioStats は引数を変更しない", () => {
  const before = emptyAudioStats();
  const snapshot = { ...before };
  mergeAudioStats(before, { samples: 10, sumSq: 1, clipped: 0, peak: 0.1, windows: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(before, snapshot);
});

test("壊れた統計で累積を NaN に落とさない", () => {
  // 値は postMessage を渡ってくる。1件でも NaN が入ると以降の全表示が NaN になる
  const good = mergeAudioStats(emptyAudioStats(), {
    samples: 100,
    sumSq: 4,
    clipped: 1,
    peak: 0.2,
    windows: [0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  const broken = [
    null,
    undefined,
    "x",
    { samples: NaN, sumSq: Infinity, peak: -1 },
    // **長さの違うビン配列も来うる**（古いクライアントや壊れたメッセージ）。
    // そのまま足すと分布の長さが崩れ、以降のビン番号がずれる
    { samples: 10, windows: [1, 2, 3] },
    { samples: 10, windows: "not-an-array" },
  ];
  for (const bad of broken) {
    const out = mergeAudioStats(good, bad as never);
    for (const [key, value] of Object.entries(out)) {
      if (Array.isArray(value)) {
        assert.equal(value.length, DBFS_BINS, `${key} の長さが崩れた: ${String(bad)}`);
        for (const v of value) assert.ok(Number.isFinite(v), `${key} に有限でない値`);
        continue;
      }
      assert.ok(Number.isFinite(value), `${key} が有限でない: ${String(bad)}`);
    }
    assert.equal(out.samples >= good.samples, true);
  }
});

test("summarizeAudioStats は RMS と比率を出す", () => {
  // ビン2の上端は -65dBFS、ビン9の上端は -30dBFS。既定の水準(-40dBFS)未満は前者だけ
  const s = summarizeAudioStats({
    samples: 200,
    sumSq: 8, // 平均パワー 0.04 → RMS 0.2
    clipped: 2,
    peak: 0.62,
    windows: [0, 0, 4, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0],
  })!;
  assert.ok(Math.abs(s.avgRms - 0.2) < 1e-9);
  assert.equal(s.peak, 0.62);
  assert.ok(Math.abs(s.silentRatio - 0.4) < 1e-9, `silentRatio=${s.silentRatio}`);
  assert.ok(Math.abs(s.clipRatio - 0.01) < 1e-9);
});

/**
 * **無音の水準は集計ではなく表示のときに当てる。**
 *
 * 同じ分布を別の水準で読み直せることが、この Issue の「実機で閾値を決める」を
 * 実行可能にしている。集計時に閾値を当てて畳んでしまうと、閾値を決めるために要る
 * 分布を閾値自身が壊す。
 */
test("無音の水準は後から変えられる（分布は畳まない）", () => {
  const stats = { samples: 100, sumSq: 1, clipped: 0, peak: 0.5, windows: [0, 0, 4, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0] };
  // ビン2の上端 -65dBFS、ビン9の上端 -30dBFS
  assert.equal(summarizeAudioStats(stats, { silenceDbfs: -60 })!.silentRatio, 0.4);
  assert.equal(summarizeAudioStats(stats, { silenceDbfs: -20 })!.silentRatio, 1);
  assert.equal(summarizeAudioStats(stats, { silenceDbfs: -80 })!.silentRatio, 0);
});

test("dBFS のビン分けは境界で取り違えない", () => {
  assert.equal(toDbfs(1), 0, "フルスケールが 0dBFS");
  assert.ok(Math.abs(toDbfs(0.1) + 20) < 1e-9, "0.1 が -20dBFS");
  assert.ok(Math.abs(toDbfs(0.01) + 40) < 1e-9, "0.01 が -40dBFS");
  assert.equal(toDbfs(0), -80, "無音は下端に倒す（-Infinity にしない）");
  // 範囲外は端に丸める。ビン番号が配列の外へ出ると分布が静かに壊れる
  assert.equal(dbfsBin(-200), 0);
  assert.equal(dbfsBin(100), DBFS_BINS - 1);
});

test("histogramRows は値の入ったビンだけを割合で出す", () => {
  const rows = histogramRows([0, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]);
  assert.equal(rows.length, 2, "空のビンは出さない");
  assert.ok(rows.some(([, v]) => v === "25.0%"));
  assert.ok(rows.some(([, v]) => v === "75.0%"));
  assert.deepEqual(histogramRows(new Array(DBFS_BINS).fill(0)), [], "全部ゼロなら空");
});

test("1サンプルも入っていなければ null（「測れていない」と「全部ゼロ」を区別する）", () => {
  assert.equal(summarizeAudioStats(emptyAudioStats()), null);
  assert.equal(summarizeAudioStats(null), null);
  assert.deepEqual(audioStatRows(emptyAudioStats()), []);
});

// ---- 表示用の行 ----

/**
 * 行の整形も採用リストを通る。**画面と Markdown の両方がここを通る**ので、
 * 全6行を固定しておけば端末識別子が混ざらないことも同時に守れる。
 */
test("設定の行は採用リストの順に並び、AudioContext sampleRate が末尾に付く", () => {
  const rows = trackSettingRows(RAW_SETTINGS, 48000);
  assert.deepEqual(rows, [
    ["sampleRate", "48000"],
    ["channelCount", "1"],
    ["echoCancellation", "false"],
    ["noiseSuppression", "false"],
    ["autoGainControl", "true"],
    ["AudioContext sampleRate", "48000"],
  ]);
});

// ---- Markdown ----

const MD_ARGS = {
  modeLabel: "対面会議",
  startedAt: "2026-08-27 23:30",
  // 話者の初出・最終を相対時間にするための基準（#46）。絶対時刻は診断に出さない
  startedAtMs: 0,
  elapsed: "12:34",
  trackSettings: RAW_SETTINGS,
  contextSampleRate: 48000,
  stats: { samples: 200, sumSq: 8, clipped: 2, peak: 0.62, windows: [0, 0, 4, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0] },
  // #46 のセクションは既定では出さない（発話が1件も無い＝収音だけの診断）
  speakerStats: collectSpeakerStats([]),
  expectedSpeakers: "auto",
  sttInfo: null,
  // #55 の境界平滑化。既定では**計画を渡していない**状態（節ごと出ない）を表す
  boundaryPlan: null,
  // #48 の表示補正。既定では**計画を渡していない**状態（節ごと出ない）を表す
  islandPlan: null,
  // #50 の中立化。同じく既定では計画を渡していない状態
  unresolvedPlan: null,
  displayDetected: null,
  // #52 のテキスト完全性。既定では**サーバーから累計を受けていない**状態（節ごと出ない）
  textIntegrity: null,
  receivedChars: null,
  displayedChars: null,
};

test("Markdown にモード・設定・統計が載る", () => {
  const md = buildDiagnosticsMarkdown(MD_ARGS);
  assert.match(md, /^# 収音診断 2026-08-27 23:30$/m);
  assert.match(md, /- 収音モード: 対面会議/);
  assert.match(md, /- 継続時間: 12:34/);
  assert.match(md, /\| echoCancellation \| false \|/);
  assert.match(md, /\| autoGainControl \| true \|/);
  assert.match(md, /\| AudioContext sampleRate \| 48000 \|/);
  assert.match(md, /\| 平均 RMS \| 0\.2000 \(-14\.0dBFS\) \|/);
  // **どの水準で数えた率かを書く。** 閾値は分布に当てた読み値なので、
  // 水準が分かれば同じエクスポートを別の水準で読み直せる
  assert.match(md, /\| 無音率 \(-40dBFS 未満の窓\) \| 40\.00% \|/);
  assert.match(md, /\| クリップ率 \(振幅 0\.99 以上のサンプル\) \| 1\.00% \|/);
  // **クリップ率が 0% のとき、閾値が高すぎるのか妥当なのかはピークが無いと判定できない**
  assert.match(md, /\| 最大サンプル振幅 \| 0\.6200 \(-4\.2dBFS\) \|/);
  // **分布そのものを出す。** 率だけでは「この端末のノイズ底」が読めない
  assert.match(md, /## 入力レベルの分布 \(100ms 窓ごとの RMS\)/);
  assert.match(md, /\| -70〜-65dBFS \| 40\.0% \|/);
  assert.match(md, /\| -35〜-30dBFS \| 60\.0% \|/);
});

test("Markdown は生の getSettings() を渡されても deviceId を出さない", () => {
  // 呼び出し側が採用リストを通し忘れても外へ出ないよう、整形の側でも必ず通す。
  // ここが「診断に会話本文・音声を含めない」というAC（プライバシー要件）の最後の砦
  const md = buildDiagnosticsMarkdown(MD_ARGS);
  assert.equal(md.includes("deviceId"), false);
  assert.equal(md.includes("groupId"), false);
  assert.equal(md.includes(RAW_SETTINGS.deviceId), false);
  assert.equal(md.includes(RAW_SETTINGS.groupId), false);
});

test("Markdown は会話本文を含まないと明記する", () => {
  const md = buildDiagnosticsMarkdown(MD_ARGS);
  assert.match(md, /会話本文と音声は含みません。/);
});

test("測定できていなくても Markdown は組み立てられる", () => {
  const md = buildDiagnosticsMarkdown({
    ...MD_ARGS,
    trackSettings: undefined,
    contextSampleRate: null,
    stats: emptyAudioStats(),
  });
  assert.match(md, /## 実際に適用された設定/);
  assert.match(md, /## 入力の統計/);
  // 空の表を出すより「取れていない」と書く方が読める（0 と未取得を取り違えない）
  assert.doesNotMatch(md, /\|---\|---\|/);
});

// ---- 話者分離の診断（#46） ----
//
// **セクションごとにライフタイムが違う。** 収音の設定・入力統計はマイクを開いた区間の
// 値だが、話者統計は `finalLines` に紐づくので、マイクを開いていない復元セッションでも
// 出る。1つの条件でまとめると、復元セッションで空の入力統計が出るか話者統計が出ないかの
// どちらかになる。

/** 発話行1件。テキストは長さにしか意味が無いのでダミー文字列（#18 の匿名化方針）。 */
function line(speaker: number | null, words: number, chars = words, t = 0) {
  return { text: "x".repeat(chars), speaker, t, seq: 1, w: words };
}

const SPEAKER_MD_ARGS = {
  ...MD_ARGS,
  startedAtMs: 1_000_000,
  speakerStats: collectSpeakerStats([
    line(0, 120, 240, 1_012_000),
    line(1, 76, 152, 1_030_000),
    line(0, 2, 4, 1_100_000),
    line(2, 2, 4, 1_200_000),
  ]),
  expectedSpeakers: "2",
  sttInfo: {
    model: { name: "nova-3", version: "2025-01-01.0", arch: "nova-3" },
    diarizer: { arch: "v1", modelUuid: "e1c2f6d0-0000-0000-0000-000000000000" },
  },
};

test("話者統計が無ければセクションごと出さない", () => {
  // 収音だけの診断（mock モードや発話ゼロのセッション）で空の表を出すと、
  // 「話者が1人も検出されなかった」と読めてしまう
  const md = buildDiagnosticsMarkdown(MD_ARGS);
  assert.doesNotMatch(md, /## 話者分離の診断/);
  // 収音側のセクションは従来どおり出る（片方が消えないこと）
  assert.match(md, /## 入力の統計/);
});

test("想定2人・検出3 が警告つきで Markdown に出る", () => {
  const md = buildDiagnosticsMarkdown(SPEAKER_MD_ARGS);
  assert.match(md, /## 話者分離の診断/);
  assert.match(md, /- 想定話者数: 2人/);
  assert.match(md, /- 検出話者数: 3/);
  assert.match(md, /⚠ 想定2人に対し 3 speaker を検出/);
  // 1.0% の speaker 2 は偽 speaker の候補として挙がる
  assert.match(md, /⚠ speaker 2 が全 word の 1\.0%（偽 speaker の可能性）/);
  // speaker ごとの表。**数字だけで、テキストは1文字も出さない**
  assert.match(md, /\| speaker \| words \| 割合 \| 文字数 \| segments \| 初出 \| 最終 \|/);
  assert.match(md, /\| 0 \| 122 \| 61\.0% \| 244 \| 2 \| 00:12 \| 01:40 \|/);
  // 遷移は from !== to だけ、回数降順
  assert.match(md, /### 話者遷移/);
  assert.match(md, /\| 0 \| 1 \| 1 \|/);
  assert.match(md, /\| 1 \| 0 \| 1 \|/);
});

/**
 * **初出・最終は開始からの相対時間。** 絶対時刻を出すと、診断ファイルから
 * 会議の実施時刻が読めてしまう（会話本文でも音声でもないが、共有される前提の
 * ファイルに要らない情報）。
 */
test("Markdown に絶対時刻を出さない", () => {
  const md = buildDiagnosticsMarkdown(SPEAKER_MD_ARGS);
  assert.equal(md.includes("1012000"), false, "受信時刻の生値が出ている");
  assert.equal(md.includes("1200000"), false);
  assert.match(md, /\| 00:12 \|/, "相対時間になっていない");
});

/**
 * **診断に会話本文を混ぜない**（#46 のプライバシー要件）。
 * 出るのは speaker 番号・件数・割合・遷移数・時刻の集計値・diarizer の metadata だけ。
 */
test("診断 Markdown に会話本文が混入しない", () => {
  const SECRET = "この文字列は会話本文のつもりです";
  const md = buildDiagnosticsMarkdown({
    ...SPEAKER_MD_ARGS,
    speakerStats: collectSpeakerStats([
      { text: SECRET, speaker: 0, t: 1_010_000, seq: 1, w: 9 },
      { text: `${SECRET}2`, speaker: 1, t: 1_020_000, seq: 2, w: 9 },
    ]),
  });
  assert.equal(md.includes(SECRET), false, "本文が診断に出ている");
  assert.match(md, /- 検出話者数: 2/, "統計そのものは出ている");
});

test("stt_info が来なくても壊れず、diarizer は「取得できませんでした」になる", () => {
  // mock アダプタは onSttInfo を呼ばない。復元セッションにも情報は無い
  const md = buildDiagnosticsMarkdown({ ...SPEAKER_MD_ARGS, sttInfo: null });
  assert.match(md, /- Deepgram diarizer: \(取得できませんでした\)/);
  assert.match(md, /- 認識モデル: \(取得できませんでした\)/);
  // 情報があれば arch と model_uuid が出る
  const withInfo = buildDiagnosticsMarkdown(SPEAKER_MD_ARGS);
  assert.match(withInfo, /- Deepgram diarizer: arch=v1 \/ model_uuid=e1c2f6d0-/);
  assert.match(withInfo, /- 認識モデル: nova-3 \(version=2025-01-01\.0, arch=nova-3\)/);
});

/**
 * **どちらの分母で割合を出したかを必ず書く。** 旧サーバー・#46 以前に保存された
 * セッションでは word 数が無く文字数へ落ちる。書いておかないと、別々のセッションから
 * 取った診断の数値どうしを比較できない。
 */
test("word 数が無いセッションは比率の基準が文字数になり、その旨が Markdown に出る", () => {
  const md = buildDiagnosticsMarkdown({
    ...SPEAKER_MD_ARGS,
    speakerStats: collectSpeakerStats([
      { text: "x".repeat(80), speaker: 0, t: 1_010_000 },
      { text: "x".repeat(20), speaker: 1, t: 1_020_000 },
    ]),
  });
  assert.match(md, /- 比率の基準: 文字数/);
  assert.match(md, /\| 0 \| - \| 80\.0% \| 80 \| 1 \|/, "word 数を 0 と書くと「0語だった」と読める");
  // word 基準のときは word 数を出す
  assert.match(buildDiagnosticsMarkdown(SPEAKER_MD_ARGS), /- 比率の基準: word 数/);
});

test("収音を測っていなくても話者統計は出せる（復元セッション）", () => {
  const md = buildDiagnosticsMarkdown({
    ...SPEAKER_MD_ARGS,
    // マイクを開いていないので収音側は何も無い。モードも分からないので出さない
    modeLabel: null,
    trackSettings: undefined,
    contextSampleRate: null,
    stats: emptyAudioStats(),
  });
  assert.doesNotMatch(md, /- 収音モード:/, "録っていないモードを事実として書いている");
  assert.match(md, /## 話者分離の診断/);
  assert.match(md, /- 検出話者数: 3/);
});

test("話者統計を足しても「会話本文と音声は含みません」は1行のまま", () => {
  const md = buildDiagnosticsMarkdown(SPEAKER_MD_ARGS);
  assert.equal(md.split("> 会話本文と音声は含みません。").length - 1, 1);
  // 末尾に置く（セクションを足したときに途中へ紛れ込ませない）
  assert.match(md.trimEnd(), /> 会話本文と音声は含みません。$/);
});

test("fmtElapsed は1時間を超えたら h:mm:ss にする", () => {
  // 話者の初出・最終と文字起こしの時刻表記が同じ実装から出ることの担保（app.js が import する）
  assert.equal(fmtElapsed(0), "00:00");
  assert.equal(fmtElapsed(12_000), "00:12");
  assert.equal(fmtElapsed(3_600_000 + 61_000), "1:01:01");
  assert.equal(fmtElapsed(-5_000), "00:00", "負の経過時間は 0 に倒す");
});

// ---- レビュー指摘に対する回帰（#46 のレビュー）----

/**
 * **話者不明ぶんは「量」まで出す。** 未帰属の word は割合の分母には入るが、
 * どの speaker にも帰属しない。件数だけ出しても Σratio が 1 に足りない理由も、
 * 足りない量も読めない。閾値（MINOR/DOMINANT）はこの分母に対して当たるので、
 * 未帰属の量が分からないと実データから閾値を決められない。
 */
test("話者不明のセグメントは件数と量の両方を出す", () => {
  const md = buildDiagnosticsMarkdown({
    ...SPEAKER_MD_ARGS,
    speakerStats: collectSpeakerStats([line(0, 60, 60, 1_010_000), line(null, 40, 40, 1_020_000)]),
  });
  assert.match(md, /- 話者不明のセグメント: 1 seg \/ 40 word \(40\.0%\)/);
});

/** 遷移が下限であることを書く。切れた回数が読めないと別セッションと比較できない */
test("再接続があれば回数と「遷移は下限」の注記を出す", () => {
  const md = buildDiagnosticsMarkdown({
    ...SPEAKER_MD_ARGS,
    speakerStats: collectSpeakerStats([
      line(0, 10, 10, 1_010_000),
      line(1, 10, 10, 1_020_000),
      { type: "reconnect", t: 1_030_000 },
      line(0, 10, 10, 1_040_000),
    ]),
  });
  assert.match(md, /- 再接続: 1 回/);
  assert.match(md, /遷移回数は下限です/);
});

/**
 * 復元セッションで `sessionStartedAt` が無いと `savedAt`（＝セッションの**終わり**）が
 * 起点になり、差が全て負になる。`fmtElapsed()` は負を 0 に丸めるので、そのまま出すと
 * 初出・最終が全行 `00:00` に揃い、表として誤読を招く。
 */
test("開始より前の時刻は - にする", () => {
  const md = buildDiagnosticsMarkdown({
    ...SPEAKER_MD_ARGS,
    startedAtMs: 9_000_000,
    speakerStats: collectSpeakerStats([line(0, 10, 10, 1_010_000)]),
  });
  assert.match(md, /\| 0 \| 10 \| 100\.0% \| 10 \| 1 \| - \| - \|/);
});

/**
 * **割合の桁数と単位は `speaker-stats.js` が唯一の定義箇所。** ここに独自の実装を置くと、
 * 警告文（speaker-stats 側）と表（diagnostics 側）で桁が食い違っても全テストが緑のまま、
 * 同じ診断ファイルの中に `95.0%` と `95.00%` が混ざる。
 */
test("割合の整形は speaker-stats.js から取る", async () => {
  const src = await readFile(new URL("../public/diagnostics.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /const pct1 = /, "diagnostics.js が独自の pct1 を持っている");
  assert.match(src, /pct1,/, "speaker-stats.js から import していない");
  assert.match(src, /ratioBasisView,/, "ratioBasis の表示定義を import していない");
  // ratioBasis の分岐をこちらに書き直すと、基準を1つ足したときに直し漏れる
  assert.doesNotMatch(src, /ratioBasis === "words"/, "diagnostics.js で基準を分岐している");
});

// ---- 表示補正（minor island、#48） ----
//
// **raw の統計が主で、補正後は別ラベルで併記する**（#46 の「診断は raw から」を崩さない）。
// 補正が0件でも沈黙させない — 「ゲートで無効」と「効いた結果0件」は別の事実で、
// 前者は設定の問題、後者はデータの問題。区別が付かないと閾値を決める材料にならない。

/** 想定2人・検出3。`0 → 2(minor) → 0` の島が1つある合成セッション */
const ISLAND_LINES = [
  line(0, 120, 240, 1_010_000),
  line(1, 76, 152, 1_020_000),
  line(0, 20, 40, 1_030_000),
  line(2, 3, 6, 1_040_000),
  line(0, 20, 40, 1_050_000),
  line(1, 20, 40, 1_060_000),
];

/** 島が1つも吸収されず、見送りの理由だけが積まれる合成セッション */
const SKIPPED_LINES = [
  line(2, 3, 6, 1_000_000), // 端（前に確定 speaker が無い）
  line(0, 120, 240, 1_010_000),
  line(1, 76, 152, 1_020_000),
  line(0, 20, 40, 1_030_000),
  line(2, 3, 6, 1_040_000), // 前後不一致（0 → 2 → 1）
  line(1, 20, 40, 1_050_000),
];

/**
 * 診断の2箇所（画面パネル / Markdown）と同じ形で計画を立てる。
 *
 * **②③の計画と表示上の通常話者数は、`planDisplayCorrection()` の1回の計算から取る。**
 * `planMinorIslandMerges()` を raw の行へ直接当てると、表示に効くのは①jitter 通過後の
 * 計画なので**両方向にずれる**（#48 のレビューで潰した形）。`app.js` も同じ形で、
 * `tests/app-wiring.test.ts` がそれを固定している — ここで別の組み方をすると、
 * テストヘルパーだけが潰したはずの形を再現することになる。
 */
function islandArgs(lines: ReturnType<typeof line>[], expectedSpeakers = "2") {
  const correction = planDisplayCorrection(lines, { expectedSpeakers });
  return {
    ...SPEAKER_MD_ARGS,
    speakerStats: collectSpeakerStats(lines),
    expectedSpeakers,
    // ⓪の計画（#55）も同じ1回の計算から。`app.js` の配線と同じ形
    boundaryPlan: correction.boundaryPlan,
    islandPlan: correction.plan,
    unresolvedPlan: correction.unresolvedPlan,
    displayDetected: correction.displayDetected,
  };
}

test("表示補正の件数・word 数・from/to が Markdown に出る", () => {
  const md = buildDiagnosticsMarkdown(islandArgs(ISLAND_LINES));
  // raw の検出数は主のまま。補正後は別ラベルで併記する（#46 の原則を崩さない）
  assert.match(md, /- 検出話者数: 3/);
  assert.match(md, /- 表示上の通常話者数: 2/);
  assert.match(md, /### 表示補正（minor island）/);
  assert.match(md, /- 表示補正: 1 seg \/ 3 word/);
  assert.match(md, /- 主要 speaker: 0, 1/);
  // **候補の顔ぶれも出す。** 0件だったときに「候補がいなかった」のか「条件で落ちた」のかは、
  // この2行が無いと区別できない（MINOR_ISLAND_MAX_RATIO を動かすべきかがそこで決まる）
  assert.match(md, /- minor speaker: 2/);
  assert.match(md, /\| from \| to \| segments \| words \|/);
  assert.match(md, /\| 2 \| 0 \| 1 \| 3 \|/);
});

/**
 * **見送りの内訳を必ず出す。** 「run が長い」が多ければ `MINOR_ISLAND_MAX_WORDS` が
 * 狭すぎる、と実データから読める。これが無いと人が閾値を決められない。
 */
test("見送りの内訳を理由ごとに Markdown へ出す", () => {
  const md = buildDiagnosticsMarkdown(islandArgs(SKIPPED_LINES));
  assert.match(md, /- 表示補正: 0 seg \/ 0 word/);
  assert.match(md, /- 表示補正の見送り: 前後の主要speaker不一致 1 \/ run が長い 0 \/ 端 1 \/ 再接続境界 0/);
  // 補正0件なら from/to の表そのものを出さない（空の表は「補正が無かった」と読めない）
  assert.doesNotMatch(md, /\| from \| to \| segments \| words \|/);
});

/**
 * **「効いていない」と「効いた結果0件」は別の事実。** ゲートで無効なら、
 * 見送りの内訳ではなく「なぜ無効か」を1行出す。
 */
test("ゲートで無効なら理由を1行出す", () => {
  const md = buildDiagnosticsMarkdown(islandArgs(ISLAND_LINES, "auto"));
  assert.match(md, /- 表示補正: 無効（想定話者数が自動）/);
  assert.doesNotMatch(md, /- 表示補正の見送り:/, "無効のときに 0 件の内訳を並べない");
});

test("計画を渡さなければ表示補正の節ごと出さない", () => {
  // 「補正0件」と紛れないよう、行ごと出さないことで区別する（復元経路などで計画が無い場合）
  const md = buildDiagnosticsMarkdown({ ...SPEAKER_MD_ARGS });
  assert.doesNotMatch(md, /### 表示補正（minor island）/);
  assert.doesNotMatch(md, /- 表示上の通常話者数:/);
  assert.match(md, /## 話者分離の診断/, "話者統計そのものは従来どおり出る");
});

/**
 * **表示補正の節を足しても会話本文は1文字も出ない。** 出るのは speaker 番号・件数・
 * word 数だけ（`buildDiagnosticsMarkdown()` の他のセクションと同じ規律）。
 */
test("表示補正の節に会話本文が混入しない", () => {
  const marker = "このもじれつはほんぶんのしるし";
  const lines = ISLAND_LINES.map((l) => ({ ...l, text: marker }));
  const md = buildDiagnosticsMarkdown(islandArgs(lines));
  assert.equal(md.includes(marker), false);
  assert.match(md, /### 表示補正（minor island）/, "節そのものは出ている");
});

/**
 * **画面の診断パネルと Markdown は同じ行データから描く**（#46 からの規則）。
 * 片方だけに項目が増えると、実機で画面を見た人とファイルを読んだ人で違う数字を見る。
 */
test("画面パネルにも表示補正の行が出る", () => {
  const args = islandArgs(ISLAND_LINES);
  const rows = speakerDiagRows(args) as Array<[string, string]>;
  const labels = rows.map(([k]) => k);
  assert.ok(labels.includes("表示上の通常話者数"));
  assert.ok(labels.includes("表示補正"));
  assert.ok(labels.includes("表示補正の見送り"));
  // from/to の明細は Markdown では表、画面では1行ずつ（speaker ごとの行と同じ形）
  assert.deepEqual(
    rows.find(([k]) => k === "表示補正 2 → 0"),
    ["表示補正 2 → 0", "1 seg / 3 word"],
  );
});

// ---- 中立化（#50） ----
//
// **見出しを「表示中立化」にするのは、既存の「話者不明のセグメント」（#46）と紛れないため。**
// あちらは raw の時点で speaker が付かなかった行の量、こちらは「番号は付いたが統合先を
// 決められないので通常の話者として表示しない」と判断した行の量。表示上はどちらも
// 「話者不明」と出るが原因も対策も別で、同じ見出しに並ぶとどちらの数字か読めなくなる。

/** 想定2人・検出3で、`0 → 2 → 1`（前後の主要 speaker が違う）が1つある合成セッション */
const NEUTRALIZE_LINES = [
  line(0, 120, 240, 1_010_000),
  line(1, 76, 152, 1_020_000),
  line(0, 20, 40, 1_030_000),
  line(2, 3, 6, 1_040_000),
  line(1, 20, 40, 1_050_000),
];

test("中立化の件数と speaker ごとの内訳が Markdown に出る", () => {
  const md = buildDiagnosticsMarkdown(islandArgs(NEUTRALIZE_LINES));
  // raw の検出数は主のまま。**「通常」話者数は中立化したぶんを数えない**（#50）
  assert.match(md, /- 検出話者数: 3/);
  assert.match(md, /- 表示上の通常話者数: 2/);
  // ②は見送り、③が中立化する。両方の数字が同じ節に並ぶ
  assert.match(md, /- 表示補正: 0 seg \/ 0 word/);
  assert.match(md, /- 表示中立化: 1 seg \/ 3 word/);
  assert.match(md, /- 表示中立化 2 → 話者不明: 1 seg \/ 3 word/);
});

/**
 * **対象外の理由別件数を必ず出す。** `edge` / `unknown` を将来この段の対象に加えるかどうかの、
 * 唯一の判断材料になる（件数が 0 のまま増えないなら加える意味が無い）。
 * `mismatch` は③の**対象**そのものなので、対象外の欄には出さない。
 */
test("中立化の対象外を理由ごとに Markdown へ出す", () => {
  // 端（前に確定 speaker が無い）が1件、前後不一致が1件
  const md = buildDiagnosticsMarkdown(islandArgs(SKIPPED_LINES));
  assert.match(md, /- 表示中立化: 1 seg \/ 3 word/);
  assert.match(md, /- 中立化の対象外: run が長い 0 \/ 端 1 \/ 再接続境界 0 \/ 隣が話者不明 0/);
  assert.doesNotMatch(md, /- 中立化の対象外:.*不一致/, "③の対象を対象外として数えている");
});

test("島が吸収できたセッションでは中立化が0件", () => {
  // 「効いた結果0件」。**沈黙させない** — 行が出ないと「効いていない」と区別が付かない
  const md = buildDiagnosticsMarkdown(islandArgs(ISLAND_LINES));
  assert.match(md, /- 表示補正: 1 seg \/ 3 word/);
  assert.match(md, /- 表示中立化: 0 seg \/ 0 word/);
});

test("②がゲートで無効なら③も無効と1行出す", () => {
  const md = buildDiagnosticsMarkdown(islandArgs(NEUTRALIZE_LINES, "auto"));
  assert.match(md, /- 表示補正: 無効（想定話者数が自動）/);
  assert.match(md, /- 表示中立化: 無効（想定話者数が自動）/);
  assert.doesNotMatch(md, /- 中立化の対象外:/, "無効のときに 0 件の内訳を並べない");
});

test("計画を渡さなければ中立化の行も出さない", () => {
  const md = buildDiagnosticsMarkdown({ ...SPEAKER_MD_ARGS });
  assert.doesNotMatch(md, /- 表示中立化:/);
  assert.doesNotMatch(md, /- 中立化の対象外:/);
});

test("中立化の行に会話本文が混入しない", () => {
  const marker = "このもじれつはほんぶんのしるし";
  const lines = NEUTRALIZE_LINES.map((l) => ({ ...l, text: marker }));
  const md = buildDiagnosticsMarkdown(islandArgs(lines));
  assert.equal(md.includes(marker), false);
  assert.match(md, /- 表示中立化: /, "行そのものは出ている");
});

/** **画面パネルと Markdown は同じ行データから描く**（#46 からの規則） */
test("画面パネルにも中立化の行が出る", () => {
  const rows = speakerDiagRows(islandArgs(NEUTRALIZE_LINES)) as Array<[string, string]>;
  const labels = rows.map(([k]) => k);
  assert.ok(labels.includes("表示中立化"));
  assert.ok(labels.includes("中立化の対象外"));
  assert.deepEqual(
    rows.find(([k]) => k === "表示中立化 2 → 話者不明"),
    ["表示中立化 2 → 話者不明", "1 seg / 3 word"],
  );
});

// ---- STT テキスト完全性（#52） ----
//
// 「発話の冒頭が数文字欠けて見える」が本当に欠落なのか、話者分割の位置の問題なのかを
// 実データで切り分けるための節。**判定文まで出す**のが要点で、表だけ出すと読み手が毎回
// 「これは欠落か分割か」を考え直すことになる。

/** サーバーから届く累計（`ServerMessage.text_integrity`）。会話本文は持たない。 */
const INTEGRITY = (over: Record<string, unknown> = {}) => ({
  finals: 87,
  splitFinals: 12,
  rawChars: 1234,
  rawVisible: 1180,
  splitChars: 1210,
  splitVisible: 1180,
  fallbacks: 0,
  droppedEvents: 0,
  headDrops: 0,
  ...over,
});

/** クライアント側で数えた③④。既定は「全段一致」。 */
const CLIENT_CHARS = { chars: 1210, visible: 1180 };

const integrityArgs = (over: Record<string, unknown> = {}) => ({
  ...MD_ARGS,
  textIntegrity: INTEGRITY(),
  receivedChars: CLIENT_CHARS,
  displayedChars: CLIENT_CHARS,
  ...over,
});

test("text_integrity を受けていなければ節ごと出さない", () => {
  // **「0文字」と「未取得」を混同させない**（#48 の islandPlan と同じ扱い）。
  // mock モードと旧サーバーではこの節がそもそも成立しない
  const md = buildDiagnosticsMarkdown(MD_ARGS);
  assert.doesNotMatch(md, /## STTテキスト完全性/);
  // 他のセクションは従来どおり出る
  assert.match(md, /## 入力の統計/);
});

test("段階別の文字数が1つの表になり、前段との差が出る", () => {
  const md = buildDiagnosticsMarkdown(integrityArgs());
  assert.match(md, /## STTテキスト完全性/);
  assert.match(md, /\| ① Deepgram final \| 1234 \| 1180 \| — \|/);
  assert.match(md, /\| ② 話者分割後 \| 1210 \| 1180 \| 0 \|/);
  assert.match(md, /\| ③ クライアント受信 \| 1210 \| 1180 \| 0 \|/);
  assert.match(md, /\| ④ 表示（段落結合後） \| 1210 \| 1180 \| 0 \|/);
  assert.match(md, /- final 数: 87（うち分割が起きた: 12）/);
  assert.match(md, /- 切り出し失敗（連結へフォールバック）: 0/);
  assert.match(md, /- 空で捨てたセグメント: 0（うち先頭: 0）/);
});

/**
 * **判定文を出すこと**が要点。表を見た人が毎回「これは欠落か分割か」を考え直さずに済む。
 *
 * 全段一致なら文字は1つも失われておらず、症状は分割位置（word 単位で助詞1語だけ話者が
 * 変わる）による見えだと確定する。
 */
test("全段一致なら「欠落なし・分割位置による」と言い切る", () => {
  const md = buildDiagnosticsMarkdown(integrityArgs());
  assert.match(md, /- 判定: 空白除く文字数がすべての段で一致 → 欠落なし。冒頭欠落の見えは分割位置による/);
});

/**
 * **判定文は plain text で組む。** 画面パネルは `el("td", null, value)` に素の文字列として
 * 入れるので、`**` やバッククォートを混ぜるとアスタリスクがそのままセルに出る
 * （Markdown 側の強調は節の注記が担っていて、判定文には要らない）。
 */
test("判定文に Markdown の記号を混ぜない（画面パネルにそのまま出るため）", () => {
  const rows = textIntegrityStageRows({
    integrity: INTEGRITY({ splitVisible: 1176 }),
    received: { chars: 1206, visible: 1176 },
    displayed: { chars: 1206, visible: 1176 },
  });
  for (const integrity of [INTEGRITY(), INTEGRITY({ fallbacks: 2 })]) {
    const verdict = textIntegrityVerdict(rows, integrity) as string;
    assert.doesNotMatch(verdict, /\*\*|`/, verdict);
  }
});

test("①→② で減っていれば話者分割を指す判定になる", () => {
  const md = buildDiagnosticsMarkdown(
    integrityArgs({
      textIntegrity: INTEGRITY({ splitVisible: 1176, droppedEvents: 3, headDrops: 1 }),
      receivedChars: { chars: 1206, visible: 1176 },
      displayedChars: { chars: 1206, visible: 1176 },
    }),
  );
  assert.match(md, /①→② で 4 文字減少 → 話者分割で欠落している/);
  assert.match(md, /- 空で捨てたセグメント: 3（うち先頭: 1）/);
  assert.doesNotMatch(md, /欠落なし/);
});

test("③→④ で減っていれば表示側を指す判定になる", () => {
  // #36 / #48 / #50 はラベルしか変えない設計なので、ここが減っていれば回帰
  const md = buildDiagnosticsMarkdown(
    integrityArgs({ displayedChars: { chars: 1205, visible: 1175 } }),
  );
  assert.match(md, /③→④ で 5 文字減少 → 表示側で欠落している/);
});

test("②→③ の差は前のセッションの行が残っている疑いとして読ませる", () => {
  const md = buildDiagnosticsMarkdown(
    integrityArgs({
      receivedChars: { chars: 1250, visible: 1220 },
      displayedChars: { chars: 1250, visible: 1220 },
    }),
  );
  assert.match(md, /②→③ で 40 文字増加/);
  assert.match(md, /③④ は最後の再接続より後ろの行だけを数えています/);
});

/**
 * **フォールバックが絡む①→②の差は、減少・増加のどちらとしても読ませない。**
 *
 * フォールバックは `transcript` と `words\[\]` が食い違ったときにだけ起きるので、
 * 連結で組み直した②は①と**別の文字列**であり、空白を除いた文字数も増減する。
 * ここを普通の差として読ませると、切り出しも破棄も起きていないのに
 * 「話者分割で欠落している」と断定し、存在しないバグを追わせることになる。
 */
test("切り出し失敗があるときの①→②の差はフォールバック由来として読ませる", () => {
  const md = buildDiagnosticsMarkdown(
    integrityArgs({
      textIntegrity: INTEGRITY({ splitVisible: 1176, fallbacks: 2 }),
      receivedChars: { chars: 1206, visible: 1176 },
      displayedChars: { chars: 1206, visible: 1176 },
    }),
  );
  assert.match(md, /①→② で 4 文字減少 → 切り出しに 2 回失敗して連結で組み直している/);
  assert.doesNotMatch(md, /話者分割で欠落している/);
  assert.match(md, /切り出し失敗が 0 でないときの ①→② の差は別扱いです/);
});

test("フォールバックで①→②が増えても「二重計上」とは言わない", () => {
  const md = buildDiagnosticsMarkdown(
    integrityArgs({
      textIntegrity: INTEGRITY({ splitVisible: 1190, fallbacks: 1 }),
      receivedChars: { chars: 1220, visible: 1190 },
      displayedChars: { chars: 1220, visible: 1190 },
    }),
  );
  assert.match(md, /①→② で 10 文字増加 → 切り出しに 1 回失敗して/);
  assert.doesNotMatch(md, /二重計上/);
});

/**
 * **判定基準を節の中に書く。** 表だけ残すと、別の日に読んだ人が「素の文字数が減っている
 * から欠落だ」と読み違える — 切り出しの `trim` は正常動作でも素の文字数を減らす。
 */
test("「保存されていれば分割、減っていれば欠落」を節に書く", () => {
  const md = buildDiagnosticsMarkdown(integrityArgs());
  assert.match(md, /\*\*保存されていれば分割、減っていれば欠落\*\*/);
});

/**
 * **節は名前を挙げたキーしか読まない。** サーバーが `text_integrity` にフィールドを足しても、
 * ここへ書き足さない限り診断には出ない（`TRACK_KEYS` と同じ採用リストの発想）。
 * 会話本文が新しい経路で流れ込む余地を、値ではなく構造で塞ぐ。
 */
test("テキスト完全性の節は知らないキーを出さない", () => {
  const marker = "このもじれつはほんぶんのしるし";
  const md = buildDiagnosticsMarkdown(
    integrityArgs({
      textIntegrity: INTEGRITY({ sampleText: marker, lastUtterance: marker }),
      receivedChars: { chars: 1210, visible: 1180, sampleText: marker },
      displayedChars: { chars: 1210, visible: 1180, sampleText: marker },
    }),
  );
  assert.equal(md.includes(marker), false);
  assert.match(md, /## STTテキスト完全性/, "節そのものは出ている");
});

test("テキスト完全性を足しても「会話本文と音声は含みません」は1行のまま", () => {
  const md = buildDiagnosticsMarkdown(integrityArgs());
  assert.equal(md.split("> 会話本文と音声は含みません。").length - 1, 1);
});

/** **画面パネルと Markdown は同じ行データから描く**（#46 からの規則） */
test("画面パネルにもテキスト完全性の行が出る", () => {
  const rows = textIntegrityRows({
    integrity: INTEGRITY(),
    received: CLIENT_CHARS,
    displayed: CLIENT_CHARS,
  }) as Array<[string, string]>;
  const labels = rows.map(([k]) => k);
  assert.deepEqual(labels.slice(0, 4), [
    "① Deepgram final",
    "② 話者分割後",
    "③ クライアント受信",
    "④ 表示（段落結合後）",
  ]);
  assert.ok(labels.includes("判定"), "画面パネルにも判定文を出す");
});

test("画面パネルも text_integrity が無ければ行を出さない", () => {
  assert.deepEqual(
    textIntegrityRows({ integrity: null, received: CLIENT_CHARS, displayed: CLIENT_CHARS }),
    [],
  );
});

// ---- 表示補正（speaker boundary、#55） ----
//
// ⓪は想定話者数のゲートを持たないので「無効」の行は無い。**②の節の有無で⓪の節を判定しない** —
// ②が無効（想定話者数が自動）でも⓪の節は出る。計画を渡さなければ節ごと出さない（②と同じ規律）。

/**
 * 同じ final（`line()` は全行 seq:1）の中に、主要 speaker 0 の長い行に挟まれた 2 文字の断片
 * （speaker 1）が 1 つある合成セッション。断片を自分と同じ話者の長い行の隣に置くと
 * 「その話者の本体の一部」として対象外になり寄らない（`utterances.test.ts` で固定）。
 */
const BOUNDARY_LINES = [
  line(0, 120, 240, 1_010_000),
  line(1, 1, 2, 1_010_000), // 断片: 両隣の 0 へ寄る
  line(0, 76, 152, 1_020_000),
  line(1, 20, 40, 1_030_000),
];

test("境界補正の件数・文字数・見送り内訳が Markdown に出る", () => {
  const md = buildDiagnosticsMarkdown(islandArgs(BOUNDARY_LINES));
  assert.match(md, /### 表示補正（speaker boundary）/);
  assert.match(md, /- 表示補正（speaker boundary）: 1 seg \/ 2 文字/);
  assert.match(
    md,
    /- 境界補正の見送り: 曖昧 0 \/ 隣も断片 0 \/ 句読点で閉じている 0 \/ 相槌語彙 0 \/ 隣が別 final 0 \/ 再接続境界 0 \/ 話者不明 0 \/ seq なし 0/,
  );
  // パイプラインの順に、②の節より手前
  assert.ok(md.indexOf("### 表示補正（speaker boundary）") < md.indexOf("### 表示補正（minor island）"));
});

test("②が無効（想定話者数が自動）でも⓪の節は出る", () => {
  const md = buildDiagnosticsMarkdown(islandArgs(BOUNDARY_LINES, "auto"));
  assert.match(md, /- 表示補正: 無効（想定話者数が自動）/);
  assert.match(md, /- 表示補正（speaker boundary）: 1 seg \/ 2 文字/);
});

test("計画を渡さなければ境界補正の節ごと出さない", () => {
  const md = buildDiagnosticsMarkdown({ ...SPEAKER_MD_ARGS });
  assert.doesNotMatch(md, /表示補正（speaker boundary）/);
});

test("境界補正の節に会話本文が混入しない", () => {
  const marker = "このもじれつはほんぶんのしるし";
  const fragment = "xy";
  const lines = BOUNDARY_LINES.map((l) => ({ ...l, text: l.text.length <= 3 ? fragment : marker }));
  const md = buildDiagnosticsMarkdown(islandArgs(lines));
  assert.equal(md.includes(marker), false);
  assert.equal(md.includes(fragment), false, "寄せた断片の本文が出ている");
  assert.match(md, /### 表示補正（speaker boundary）/, "節そのものは出ている");
});

/**
 * 理由を足して表示名を付け忘れると、その件数が診断から黙って消える。
 * キーの定義箇所は `utterances.js`（計画の `skipped` の挿入順）で、表示名の表がそれと
 * **順序まで**一致することで固定する。
 */
test("境界補正の見送り理由は全キーに表示名があり、順序も計画と一致する", () => {
  assert.deepEqual(
    BOUNDARY_SKIP_LABELS.map(([key]) => key),
    Object.keys(smoothSpeakerBoundaries([]).plan.skipped),
  );
  for (const [, label] of BOUNDARY_SKIP_LABELS) assert.ok(label.length > 0);
});

test("画面パネルにも境界補正の行が出る（Markdown と同じ行データ）", () => {
  const rows = speakerDiagRows(islandArgs(BOUNDARY_LINES)) as Array<[string, string]>;
  assert.deepEqual(
    rows.find(([k]) => k === "表示補正（speaker boundary）"),
    ["表示補正（speaker boundary）", "1 seg / 2 文字"],
  );
  const labels = rows.map(([k]) => k);
  assert.ok(labels.includes("境界補正の見送り"));
  // パイプラインの順に、②の行より手前
  assert.ok(labels.indexOf("表示補正（speaker boundary）") < labels.indexOf("表示補正"));
});
