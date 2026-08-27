// 収音の診断情報(#26)。実機で収音モードを比較するための材料を、
// **会話本文にも音声にも触れずに**集める。
//
// **依存ゼロ・副作用ゼロで置く。** `public/app.js` はモジュール評価の時点で
// `document.getElementById` を呼ぶので Node のテストから import できない
// (`lowpass.js` / `card-status.js` / `capture-mode.js` と同じ理由)。
// 加えてこのファイルは **AudioWorklet(`audio-processor.js`)からも static import される**
// ので、worklet スコープに無い API(`document` / `window` など)に触れてはいけない。

// ---- 入力統計の閾値 ----
//
// **暫定値。人が実機の計測を見て決める。**
// クリッピングは自動ゲインが効いていれば滅多に起きないはずで、0.99 は
// ---- 入力レベルの分布 ----
//
// **閾値ではなく分布を出す。** 「無音率 38%」という1つの数字は、その裏にある
// SILENCE_THRESHOLD が妥当なときにしか読めない。閾値が高すぎれば無音率は 100% と
// 出るだけで、**実際のノイズ底がどこかは分からない** — 閾値を決めるために要る分布を、
// その閾値自身が壊してしまう。
//
// 代わりに worklet が窓ごとの RMS を dBFS のビンに積む。閾値は**表示するときに**
// 当てるので、同じエクスポートを別の閾値で読み直せるし、「この端末の底は -45dBFS」と
// いう端末ごとの事実がそのまま数字になる(定数1本では代表できない量だった)。

/** ヒストグラムの下端(dBFS)。これ未満はすべて最下位ビンに入る */
export const DBFS_FLOOR = -80;
/** ビンの幅(dB)。16本で -80〜0dBFS を覆う */
export const DBFS_BIN_DB = 5;
export const DBFS_BINS = Math.ceil(-DBFS_FLOOR / DBFS_BIN_DB);

/**
 * 無音判定の窓の長さ(秒)。**時間で定義する。**
 *
 * render quantum(128サンプル ≒ 2.7ms)を単位にすると、分母が「`process()` が呼ばれた
 * 回数」になってブラウザの実装粒度に依存し、しかも語間や破裂音の直前の谷まで無音に
 * 数える。100ms なら「黙っていた割合」に近い量になり、分母も時間に揃う。
 */
export const SILENCE_WINDOW_SEC = 0.1;

/** 無音とみなす既定の水準(dBFS)。**表示時に当てる読み値**で、集計には効かない */
export const SILENCE_DBFS = -40;

/**
 * クリップとみなすサンプル振幅(暫定値)。
 *
 * **こちらは分布にしない。** 無音の水準は環境ノイズ次第で端末ごとに変わるが、
 * クリップは「フルスケールに張り付いたか」であって端末に依らない。しかも 0dBFS 直下の
 * 話なので、5dB 幅のビンでは解像度が足りず分布にする利点がない
 * (-5〜0dBFS が1本のビンに潰れる)。率が 0% のときに閾値が妥当かは `peak` で読める。
 */
export const CLIP_THRESHOLD = 0.99;

/** 振幅(0〜1)を dBFS へ。0 以下は下端に倒す */
export function toDbfs(amplitude) {
  if (!(amplitude > 0)) return DBFS_FLOOR;
  return Math.max(DBFS_FLOOR, 20 * Math.log10(amplitude));
}

/** dBFS をビン番号へ(0 = 最も静か)。範囲外は端に丸める */
export function dbfsBin(dbfs) {
  const i = Math.floor((dbfs - DBFS_FLOOR) / DBFS_BIN_DB);
  return Math.min(DBFS_BINS - 1, Math.max(0, i));
}

/** ビン番号 → その区間の上端(dBFS)。閾値を当てるときの境界に使う */
export function binUpperDbfs(bin) {
  return DBFS_FLOOR + (bin + 1) * DBFS_BIN_DB;
}

// ---- MediaStreamTrack.getSettings() の採用リスト ----
//
// **除外リストではなく採用リスト(ホワイトリスト)で書く。** `getSettings()` は
// `deviceId` / `groupId` を含み、これは端末ごとに安定した識別子。会話本文でも音声でも
// ないが、エクスポートすると**端末を特定できる値が外に出る**。AC「診断情報に会話本文・
// 音声を含めない」はプライバシーの要件なので、ブラウザが将来 `getSettings()` に新しい
// キーを足しても、こちらが明示的にここへ足さない限り診断には出ない形にしておく。
const TRACK_KEYS = [
  "sampleRate",
  "channelCount",
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
  "latency",
  "sampleSize",
];

/**
 * `getSettings()` の戻りから診断に出してよいキーだけを抜き出す。
 *
 * 値が `undefined` のキーは落とす(ブラウザが報告しなかったのと同じ扱い)。
 */
export function pickTrackSettings(settings) {
  const out = {};
  if (!settings || typeof settings !== "object") return out;
  for (const key of TRACK_KEYS) {
    const value = settings[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---- 入力統計 ----
//
// AudioWorklet が**ローパス前の生入力**から集計し、約1秒ごとに送ってくる区間分の値を、
// ここでセッション全体へ畳み込む。生入力で取るのは「マイクが実際にどう入っているか」を
// 見たいからで、こちらで加工した後の波形ではその目的を果たせない。

/**
 * 空の累積値。**worklet の区間カウンタもこれを使う**(#26)。
 *
 * 形の定義を1箇所にしないと、項目を足したとき片方を直し漏らす。漏らした項目は
 * `num()` が 0 に潰すので、**例外にならず「常に 0」として静かに出続ける**。
 */
export function emptyAudioStats() {
  return {
    samples: 0,
    sumSq: 0,
    peak: 0,
    /** 窓ごとの RMS の分布(dBFS ビン)。無音率はここから**表示時に**求める */
    windows: new Array(DBFS_BINS).fill(0),
    /** `CLIP_THRESHOLD` 以上のサンプル数 */
    clipped: 0,
  };
}

/** 有限な非負数だけ通す。壊れた値で累積を NaN に落とさないため */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** ビン配列を要素ごとに足す。長さが違うものは無視する(壊れた入力で長さを崩さない) */
function addBins(base, extra) {
  if (!Array.isArray(extra) || extra.length !== base.length) return base.slice();
  return base.map((v, i) => v + num(extra[i]));
}

/**
 * 区間の統計を累積へ畳み込む(引数は変更しない)。
 *
 * `peak` だけ加算ではなく最大値。「一番大きく入った瞬間」を見るための値なので、
 * 足し合わせると意味を失う。
 */
export function mergeAudioStats(prev, chunk) {
  const base = prev ?? emptyAudioStats();
  if (!chunk || typeof chunk !== "object") return { ...base, windows: base.windows.slice() };
  return {
    samples: base.samples + num(chunk.samples),
    sumSq: base.sumSq + num(chunk.sumSq),
    peak: Math.max(base.peak, num(chunk.peak)),
    clipped: base.clipped + num(chunk.clipped),
    windows: addBins(base.windows, chunk.windows),
  };
}

/** ビン配列のうち、上端が `dbfs` 以下のビンの合計 ÷ 全体。分母 0 なら 0 */
function ratioAtOrBelow(bins, dbfs) {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let hit = 0;
  for (let i = 0; i < bins.length; i++) {
    if (binUpperDbfs(i) <= dbfs) hit += bins[i];
  }
  return hit / total;
}

/**
 * 累積値を人が読む指標に落とす。1サンプルも入っていなければ `null`。
 *
 * `null` を返すのは「まだ測れていない」と「全部ゼロだった」を区別するため
 * (マイクを開いていない mock モードでは前者になる)。
 *
 * **無音率とクリップ率は分布に閾値を当てて求める。** 閾値は既定の読み値であって
 * 集計には効かないので、同じデータを別の水準で読み直せる。
 */
export function summarizeAudioStats(stats, { silenceDbfs = SILENCE_DBFS } = {}) {
  if (!stats || stats.samples <= 0) return null;
  return {
    avgRms: Math.sqrt(stats.sumSq / stats.samples),
    peak: stats.peak,
    silentRatio: ratioAtOrBelow(stats.windows, silenceDbfs),
    clipRatio: stats.clipped / stats.samples,
    windows: stats.windows,
  };
}

/** 分布のうち値が入っているビンを「-45〜-40dBFS: 12%」の形の行にする */
export function histogramRows(bins) {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const rows = [];
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] <= 0) continue;
    const lo = binUpperDbfs(i) - DBFS_BIN_DB;
    const label = i === 0 ? `${binUpperDbfs(i)}dBFS 以下` : `${lo}〜${binUpperDbfs(i)}dBFS`;
    rows.push([label, `${((bins[i] / total) * 100).toFixed(1)}%`]);
  }
  return rows;
}

// ---- 表示用の行 ----
//
// **ラベルの定義箇所を1つにする。** 画面の診断パネルと Markdown エクスポートが
// 同じ配列から描くので、片方だけ項目が増える/文言がずれることが起きない。

const pct = (r) => `${(r * 100).toFixed(2)}%`;

/** 実際に適用された設定の行。`settings` は生の `getSettings()` を渡してよい */
export function trackSettingRows(settings, contextSampleRate) {
  const picked = pickTrackSettings(settings);
  const rows = [];
  // **ここでも TRACK_KEYS を回す。** `pickTrackSettings()` は TRACK_KEYS 順に挿入するので
  // 並びは `Object.keys(picked)` でも同じ。理由は順序ではなく**多層防御**で、
  // 採用リストが素通しに戻っても、ここが TRACK_KEYS しか出さない砦として残る
  // (片方だけ壊しても漏れないことは変異テストで確認済み)
  for (const key of TRACK_KEYS) {
    if (key in picked) rows.push([key, String(picked[key])]);
  }
  if (contextSampleRate != null) {
    rows.push(["AudioContext sampleRate", String(contextSampleRate)]);
  }
  return rows;
}

/** 入力統計の行。まだ1サンプルも入っていなければ空配列 */
export function audioStatRows(stats) {
  const s = summarizeAudioStats(stats);
  if (!s) return [];
  return [
    ["平均 RMS", `${s.avgRms.toFixed(4)} (${toDbfs(s.avgRms).toFixed(1)}dBFS)`],
    ["最大サンプル振幅", `${s.peak.toFixed(4)} (${toDbfs(s.peak).toFixed(1)}dBFS)`],
    // 閾値は**読み値**。下の分布に当てているだけなので、水準を書いておけば
    // 同じエクスポートを別の水準で読み直せる
    // 「以下」ではなく「未満」。ビンの上端で切るので、水準ちょうどのビンは含まない
    [`無音率 (${SILENCE_DBFS}dBFS 未満の窓)`, pct(s.silentRatio)],
    [`クリップ率 (振幅 ${CLIP_THRESHOLD} 以上のサンプル)`, pct(s.clipRatio)],
  ];
}

// ---- Markdown エクスポート ----

function table(rows) {
  return ["| 項目 | 値 |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), ""];
}

/**
 * 収音診断の Markdown を組み立てる(#26)。
 *
 * **文字起こし・用語カードとは別のファイルにする。** 実機比較の結果を共有するときに
 * 会話本文を含むファイルを渡さずに済むので、「診断情報に会話本文・音声を含めない」を
 * ファイルの単位でも守れる。
 *
 * `trackSettings` は生の `getSettings()` を渡してよい。整形の側で
 * `pickTrackSettings()` を必ず通すので、**呼び出し側がホワイトリストを忘れても
 * `deviceId` は出ない**。
 *
 * @param modeLabel 収音モードの表示名(`captureModeLabel()`)
 * @param startedAt 開始日時の表示文字列
 * @param elapsed 継続時間の表示文字列
 * @param trackSettings `MediaStreamTrack.getSettings()` の戻り
 * @param contextSampleRate `AudioContext.sampleRate`
 * @param stats `mergeAudioStats()` の累積値
 */
export function buildDiagnosticsMarkdown({
  modeLabel,
  startedAt,
  elapsed,
  trackSettings,
  contextSampleRate,
  stats,
}) {
  const settingRows = trackSettingRows(trackSettings, contextSampleRate);
  const statRows = audioStatRows(stats);
  const summary = summarizeAudioStats(stats);
  const windowRows = summary ? histogramRows(summary.windows) : [];

  const out = [
    `# 収音診断 ${startedAt}`,
    "",
    `- 収音モード: ${modeLabel}`,
    `- 開始: ${startedAt}`,
    `- 継続時間: ${elapsed}`,
    "",
    "## 実際に適用された設定",
    "",
    ...(settingRows.length ? table(settingRows) : ["(取得できませんでした)", ""]),
    "## 入力の統計",
    "",
    ...(statRows.length ? table(statRows) : ["(音声を取得していないため測定していません)", ""]),
    // **分布そのものを出す。** 上の率は分布に既定の水準を当てただけなので、
    // ここを見れば別の水準で読み直せる。「この端末のノイズ底は -45dBFS」のような
    // 端末ごとの事実は、率ではなく分布にしか現れない
    ...(windowRows.length
      ? [`## 入力レベルの分布 (${(SILENCE_WINDOW_SEC * 1000).toFixed(0)}ms 窓ごとの RMS)`, "", ...table(windowRows)]
      : []),
    "> 会話本文と音声は含みません。",
    "",
  ];
  return out.join("\n");
}
