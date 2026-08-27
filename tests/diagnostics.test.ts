import assert from "node:assert/strict";
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
} from "../public/diagnostics.js";

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
  elapsed: "12:34",
  trackSettings: RAW_SETTINGS,
  contextSampleRate: 48000,
  stats: { samples: 200, sumSq: 8, clipped: 2, peak: 0.62, windows: [0, 0, 4, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0] },
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
