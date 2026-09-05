// 収音の診断情報(#26)。実機で収音モードを比較するための材料を、
// **会話本文にも音声にも触れずに**集める。
//
// **依存ゼロ・副作用ゼロで置く。** `public/app.js` はモジュール評価の時点で
// `document.getElementById` を呼ぶので Node のテストから import できない
// (`lowpass.js` / `card-status.js` / `capture-mode.js` と同じ理由)。
// 加えてこのファイルは **AudioWorklet(`audio-processor.js`)からも static import される**
// ので、worklet スコープに無い API(`document` / `window` など)に触れてはいけない。
// 下で import している `speaker-stats.js` にも同じ制約が伝播する(あちらも依存ゼロ・
// 副作用ゼロなので、worklet に連れて行っても評価時に何も起きない)。

// 話者統計の集計と閾値は speaker-stats.js が唯一の定義箇所(#46)。
// ここで割合を計算し直すと、画面と Markdown で別の基準の数字が出る。
import {
  UNRESOLVED_SPEAKER_LABEL,
  expectedSpeakerLabel,
  pct1,
  ratioBasisView,
  speakerWarnings,
} from "./speaker-stats.js";

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

// ---- 話者分離の診断(#46) ----
//
// **入力統計とはライフタイムが違う。** 入力統計はマイクを開いた区間(`hasDiagnostics()`)
// に紐づくが、話者統計は `finalLines` に紐づくので、マイクを開いていない復元セッションでも
// 出せる。1つのフラグにまとめると、復元セッションで空の入力統計が出るか話者統計が
// 出ないかのどちらかになる。

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * 会議開始からの経過時間。1時間を超えたら h:mm:ss にする。
 *
 * **定義箇所はここだけ**(`app.js` は import して使う)。話者の初出・最終は
 * 診断側で整形する必要がある一方、文字起こしの Markdown は app.js が整形するので、
 * 両方に書くと同じ「経過時間」が2つの実装で出ることになる。
 */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** 絶対時刻ではなく**セッション開始からの相対時間**。実施時刻は診断に出さない */
function elapsedFrom(t, startedAtMs) {
  if (typeof t !== "number" || !Number.isFinite(t) || typeof startedAtMs !== "number") return "-";
  // **開始より前の時刻は "-"。** 復元セッションで `sessionStartedAt` が無いと `savedAt`
  // (＝セッションの**終わり**)が起点になり、差が全て負になる。`fmtElapsed()` は負を 0 に
  // 丸めるので、そのまま出すと初出・最終の列が全行 `00:00` に揃い、表として誤読を招く
  if (t < startedAtMs) return "-";
  return fmtElapsed(t - startedAtMs);
}

/** 認識モデル・diarizer の1行表記。取れていなければ null(呼び出し側が文言を決める) */
function sttInfoValues(sttInfo) {
  const model = sttInfo?.model;
  const diarizer = sttInfo?.diarizer;
  const detail = [
    model?.version ? `version=${model.version}` : null,
    model?.arch ? `arch=${model.arch}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  // **`name` が無くても `detail` だけで1行にする。** `version` / `arch` は取れているのに
  // `name` が無いというだけで「(取得できませんでした)」に倒すと、持っている情報を捨てる
  const modelText = model?.name ? (detail ? `${model.name} (${detail})` : model.name) : detail || null;
  const diarizerText = diarizer
    ? [
        diarizer.arch ? `arch=${diarizer.arch}` : null,
        diarizer.modelUuid ? `model_uuid=${diarizer.modelUuid}` : null,
      ]
        .filter(Boolean)
        .join(" / ")
    : null;
  return { modelText, diarizerText: diarizerText || null };
}

// ---- 表示補正(minor island)の診断(#48) ----
//
// **補正が0件でも沈黙させない。** 「補正が効いていない(ゲートで無効)」と「効いた結果0件」は
// 別の事実で、前者は設定の問題、後者はデータの問題。区別が付かないと、実データを見た人が
// 閾値を動かすべきかどうか判断できない。

/** ゲートで無効になった理由の表示名。`planMinorIslandMerges()` の `disabledBy` に対応する */
const ISLAND_DISABLED_LABELS = {
  auto: "想定話者数が自動",
  atLeast: "想定話者数が「以上」指定",
  noStats: "話者統計を取得できない",
  detectedNotOver: "検出話者数が想定以下",
  // 閾値は word 数で決めた値なので、分母が文字数のセッションでは意味が変わる(#48)
  charsBasis: "比率の基準が文字数",
  tooFewWords: "総 word 数が閾値未満",
};

/**
 * 見送り理由の内訳を `<表示名> <件数> / …` の 1 セルにする。②③⓪の 3 つの内訳が同じ形で
 * 出るのは、ここ 1 か所で整形しているから(区切りや欠損時の扱いを変えるときに 3 か所を直さない)。
 * @param labels 順序付きの `[key, label]` の列
 * @param countOf キー → 件数
 */
function skipBreakdown(labels, countOf) {
  return labels.map(([key, label]) => `${label} ${countOf(key)}`).join(" / ");
}

/**
 * 見送った理由の表示名。**順序も含めてここが定義箇所。**
 * 内訳を出さないと「`run が長い` が多い ⇒ `MINOR_ISLAND_MAX_WORDS` が狭すぎる」のような
 * 読み方ができず、人が実データから閾値を決められない。
 */
const ISLAND_SKIP_LABELS = [
  ["mismatch", "前後の主要speaker不一致"],
  ["tooLong", "run が長い"],
  ["edge", "端"],
  ["boundary", "再接続境界"],
  ["unknown", "隣が話者不明"],
];

/**
 * 表示補正の見出し行。**画面パネルと Markdown が同じ配列から描く**(既存の規則)。
 * 出るのは speaker 番号・件数・word 数だけで、会話本文は1文字も入らない。
 */
function minorIslandRows(islandPlan, ratioBasis) {
  // 計画そのものを渡されていない(古い呼び出し)なら何も出さない。
  // 「補正0件」と紛れないよう、行ごと出さないことで区別する
  if (!islandPlan) return [];
  if (islandPlan.disabledBy) {
    const why = Object.hasOwn(ISLAND_DISABLED_LABELS, islandPlan.disabledBy)
      ? ISLAND_DISABLED_LABELS[islandPlan.disabledBy]
      : islandPlan.disabledBy;
    return [["表示補正", `無効（${why}）`]];
  }
  const view = ratioBasisView(ratioBasis);
  const segments = islandPlan.merges.reduce((n, m) => n + m.segments, 0);
  const words = islandPlan.merges.reduce((n, m) => n + m.words, 0);
  const skipped = islandPlan.skipped ?? {};
  return [
    ["表示補正", `${segments} seg / ${words} ${view.unit}`],
    // **主要 / minor の顔ぶれも出す。** 0件だったときに「候補が1人もいなかった」のか
    // 「候補はいたが条件で落ちた」のかは、この2行が無いと区別できない
    // (`MINOR_ISLAND_MAX_RATIO` を動かすべきかどうかがそこで決まる)
    ["主要 speaker", islandPlan.majors.length ? islandPlan.majors.join(", ") : "(なし)"],
    ["minor speaker", islandPlan.minors.length ? islandPlan.minors.join(", ") : "(なし)"],
    // 主要でも minor でもない speaker。どちらのリストにも出ないと診断上は存在が消える
    ...(islandPlan.others?.length ? [["対象外 speaker", islandPlan.others.join(", ")]] : []),
    [
      "表示補正の見送り",
      skipBreakdown(ISLAND_SKIP_LABELS, (key) => skipped[key] ?? 0),
    ],
  ];
}

// ---- 表示補正(speaker boundary)の診断(#55) ----
//
// ⓪は想定話者数のゲートを持たないので「無効」の行は無い。**計画を渡されていなければ
// 行ごと出さない**(「補正0件」と紛れないため。②と同じ規律)。
// 単位は常に文字数 — 行に `w` があっても断片の一部を word 数では表せない。

/**
 * 見送った理由の表示名。**順序も含めて `[key, label]` の列**(②の `ISLAND_SKIP_LABELS` と同じ形)。
 * キーの定義箇所は `utterances.js` の `BOUNDARY_SKIP_REASONS` で、この表がそれと一致することは
 * `tests/diagnostics.test.ts` が `smoothSpeakerBoundaries([]).plan.skipped` のキー列と突き合わせて
 * 固定する(理由を足して表示名を付け忘れると、その件数が診断から黙って消えるため)。
 *
 * `曖昧` が多ければ両隣が長い形(`A長 | X短 | B長`)が多く追加ゲート(文字種の連続性)の検討材料、
 * `隣も断片` が多ければ断片の連鎖が多く 2 パス目の検討材料、`相槌語彙` が多ければ語彙リストが
 * 効いている、のように**実データから閾値と語彙を決めるための材料**なので、内訳を必ず出す。
 * 長い行は断片候補にならないだけで内訳には入らない(`boundaryFragmentTarget()` のコメント参照)。
 */
export const BOUNDARY_SKIP_LABELS = Object.freeze([
  ["ambiguous", "曖昧"],
  ["shortNeighbor", "隣も断片"],
  ["punctuated", "句読点で閉じている"],
  ["backchannel", "相槌語彙"],
  ["differentFinal", "隣が別 final"],
  ["boundary", "再接続境界"],
  ["unknown", "話者不明"],
  ["noSeq", "seq なし"],
]);

/**
 * 境界平滑化の見出し行。**画面パネルと Markdown が同じ配列から描く**(既存の規則)。
 * 出るのは件数・文字数・理由名だけで、会話本文も speaker 番号の明細も出さない
 * (speaker ごとの明細は②と違って閾値決めの材料にならない)。
 * 計画は `planDisplayCorrection()` の同じ計算からしか来ず永続化もされないので、
 * `applied` / `skipped` の欠損は想定しない(②の `?? {}` は保存データ由来の経緯があるが、⓪は新規)。
 */
function boundaryRows(boundaryPlan) {
  if (!boundaryPlan) return [];
  const chars = boundaryPlan.applied.reduce((n, a) => n + a.chars, 0);
  return [
    ["表示補正（speaker boundary）", `${boundaryPlan.applied.length} seg / ${chars} 文字`],
    ["境界補正の見送り", skipBreakdown(BOUNDARY_SKIP_LABELS, (key) => boundaryPlan.skipped[key])],
  ];
}

// ---- 中立化(#50)の診断 ----
//
// **見出しを「表示中立化」にするのは、既存の「話者不明のセグメント」(#46)と紛れないため。**
// あちらは raw の時点で Deepgram が speaker を返さなかった行の量で、こちらは
// 「speaker 番号は付いたが、統合先を決められないので通常の話者として表示しない」と
// 判断した行の量。表示上はどちらも「話者不明」と出るが、**原因も対策も別**
// (前者は diarization そのものの問題、後者は #48 の統合条件の問題)。同じ見出しで並べると、
// 実データを見た人がどちらの数字を見ているのか分からなくなる。

/**
 * 中立化の対象外にした理由の表示名。**`ISLAND_SKIP_LABELS` から `mismatch` を除いて作る。**
 * 語を書き写すと、②の理由を1つ足したときに③の内訳にだけ現れない理由ができる。
 * `mismatch` を除くのは、それが③の**対象**そのものだから(対象外の欄に出しても意味が無い)。
 */
const NEUTRALIZE_SKIP_LABELS = ISLAND_SKIP_LABELS.filter(([key]) => key !== "mismatch");

/**
 * 中立化の見出し行。**画面パネルと Markdown が同じ配列から描く**(既存の規則)。
 * 出るのは speaker 番号・件数・word 数・理由名だけで、会話本文は1文字も入らない。
 */
function unresolvedRows(unresolvedPlan, ratioBasis) {
  // 計画そのものを渡されていない(古い呼び出し)なら何も出さない
  if (!unresolvedPlan) return [];
  // ②が無効なら③も無効。**「効いていない」と「効いた結果0件」を区別する**
  // (`minorIslandRows()` と同じ規律。理由の表示名も同じ表から引く)
  if (unresolvedPlan.disabledBy) {
    const why = Object.hasOwn(ISLAND_DISABLED_LABELS, unresolvedPlan.disabledBy)
      ? ISLAND_DISABLED_LABELS[unresolvedPlan.disabledBy]
      : unresolvedPlan.disabledBy;
    return [["表示中立化", `無効（${why}）`]];
  }
  const view = ratioBasisView(ratioBasis);
  const neutralized = unresolvedPlan.neutralized ?? [];
  const segments = neutralized.reduce((n, x) => n + x.segments, 0);
  const words = neutralized.reduce((n, x) => n + x.words, 0);
  const skippedRuns = unresolvedPlan.skippedRuns ?? [];
  return [
    ["表示中立化", `${segments} seg / ${words} ${view.unit}`],
    // speaker ごとの明細。どの speaker が何回中立化されたかは、
    // 「本当に偽 speaker だったのか」を実データで確かめるための材料になる
    ...neutralized.map((x) => [
      `表示中立化 ${x.speaker} → ${UNRESOLVED_SPEAKER_LABEL}`,
      `${x.segments} seg / ${x.words} ${view.unit}`,
    ]),
    // **対象外の理由別件数を必ず出す。** `edge` / `unknown` を将来この段の対象に
    // 加えるかどうかを実データで判断するための材料(件数が0のまま増えないなら加える意味が無い)。
    //
    // **②の「表示補正の見送り」と同じ数字にはならない。** ③は `mismatch` のうち
    // 長すぎる run を `tooLong` へ落とし直すので、その差ぶんだけ `tooLong` が増える
    // (②の判定順では `mismatch` が先に立ち、`tooLong` に到達しないため)
    [
      "中立化の対象外",
      skipBreakdown(NEUTRALIZE_SKIP_LABELS, (key) => skippedRuns.filter((r) => r.reason === key).length),
    ],
  ];
}

/**
 * 話者統計の見出し行。**画面の診断パネルと Markdown が同じ配列から描く**
 * (収音側の `trackSettingRows()` / `audioStatRows()` と同じ規則)。
 *
 * 会話本文は1文字も入らない。出るのは speaker 番号・件数・割合・時刻の集計値・
 * diarizer の metadata だけ。
 */
export function speakerSummaryRows({ speakerStats, expectedSpeakers, sttInfo, displayDetected }) {
  if (!speakerStats || speakerStats.totalSegments <= 0) return [];
  const { modelText, diarizerText } = sttInfoValues(sttInfo);
  const rows = [
    ["想定話者数", expectedSpeakerLabel(expectedSpeakers)],
    ["検出話者数", String(speakerStats.detected)],
    // **raw の検出数と別ラベルで併記する**(#48)。#46 の「診断は raw から」の原則は
    // 崩さない — 主は raw の統計で、こちらは表示補正を通した後の従の値。
    //
    // **「通常」を付けたのは値の意味が変わったため**(#50)。中立化した speaker は
    // 画面にもエクスポートにも「話者C」としては出ないので数に入らない。旧ラベルのまま
    // 意味だけ変えると、実機の記録を読み比べたときに同じ名前の別の数字が並ぶ
    ...(typeof displayDetected === "number"
      ? [["表示上の通常話者数", String(displayDetected)]]
      : []),
    // **どちらの分母で割合を出したかを必ず書く。** 旧サーバー/旧セッションでは
    // word 数が無く文字数へ落ちるので、書いておかないと数値どうしを比較できない
    ["比率の基準", ratioBasisView(speakerStats.ratioBasis).basisLabel],
  ];
  if (speakerStats.unknownSegments > 0) {
    // **量まで出す。** 話者不明ぶんは割合の分母には入るがどの speaker にも帰属しないので、
    // 件数だけ出しても `Σ ratio` が 1 に足りない理由と「どれだけ足りないか」が読めない。
    // 閾値はこの分母に対して当たるため、未帰属の量が分からないと実データから決められない
    const view = ratioBasisView(speakerStats.ratioBasis);
    const unknown = view.value({ words: speakerStats.unknownWords, chars: speakerStats.unknownChars });
    const denom = view.value({ words: speakerStats.totalWords, chars: speakerStats.totalChars });
    const share = denom > 0 ? ` (${pct1(unknown / denom)})` : "";
    rows.push([
      "話者不明のセグメント",
      `${speakerStats.unknownSegments} seg / ${unknown} ${view.unit}${share}`,
    ]);
  }
  if (speakerStats.reconnects > 0) {
    // **遷移回数が下限であることの手掛かり。** 再接続と話者不明の区間で遷移の鎖が切れるので、
    // 別セッションと遷移数を比べるときに「何回切れていたか」が読めないと比較にならない
    rows.push(["再接続", `${speakerStats.reconnects} 回`]);
  }
  rows.push(["Deepgram diarizer", diarizerText ?? "(取得できませんでした)"]);
  rows.push(["認識モデル", modelText ?? "(取得できませんでした)"]);
  return rows;
}

/**
 * 診断パネル(画面)に出す話者統計の行。見出し + speaker ごとの1行 + 警告。
 * Markdown の表と同じ数字を、テーブル1本で読める形に畳んだもの。
 */
export function speakerDiagRows({
  speakerStats,
  expectedSpeakers,
  sttInfo,
  boundaryPlan,
  islandPlan,
  unresolvedPlan,
  displayDetected,
}) {
  if (!speakerStats || speakerStats.totalSegments <= 0) return [];
  const view = ratioBasisView(speakerStats.ratioBasis);
  const rows = speakerSummaryRows({ speakerStats, expectedSpeakers, sttInfo, displayDetected });
  for (const s of speakerStats.speakers) {
    rows.push([
      `speaker ${s.speaker}`,
      `${pct1(s.ratio)} (${view.value(s)} ${view.unit} / ${s.segments} seg)`,
    ]);
  }
  // ⓪(#55)はパイプラインの順に②の前。**②の有無で⓪を判定しない**(⓪にはゲートが無い)
  rows.push(...boundaryRows(boundaryPlan));
  rows.push(...minorIslandRows(islandPlan, speakerStats.ratioBasis));
  // Markdown は from/to を表で出すが、画面パネルには表が無いので1行ずつ出す
  // (speaker ごとの行と同じ扱い。**同じ計画から描く**ので数字が割れることはない)
  const merges = islandPlan && !islandPlan.disabledBy ? islandPlan.merges : [];
  for (const m of merges) {
    rows.push([`表示補正 ${m.from} → ${m.to}`, `${m.segments} seg / ${m.words} ${view.unit}`]);
  }
  // 中立化(#50)は②の明細の後。**同じ計画から描く**ので Markdown と数字が割れることはない
  rows.push(...unresolvedRows(unresolvedPlan, speakerStats.ratioBasis));
  for (const w of speakerWarnings(speakerStats, expectedSpeakers)) rows.push(["警告", w]);
  return rows;
}

// ---- Markdown エクスポート ----

function table(rows) {
  return ["| 項目 | 値 |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), ""];
}

/** 見出し行(`[label, value]`)を Markdown の箇条書きにする。画面パネルと同じ配列から描く規則の Markdown 側 */
function bullets(rows) {
  return rows.map(([k, v]) => `- ${k}: ${v}`);
}

/**
 * 「話者分離の診断」セクション(#46)。**発話が1件も無ければセクションごと出さない。**
 *
 * 出るのは speaker 番号・件数・割合・遷移数・**セッション開始からの相対時間**・
 * diarizer の metadata だけで、会話本文も音声も、絶対時刻(＝会議の実施時刻)も入らない。
 */
function speakerSection({
  speakerStats,
  expectedSpeakers,
  sttInfo,
  startedAtMs,
  boundaryPlan,
  islandPlan,
  unresolvedPlan,
  displayDetected,
}) {
  if (!speakerStats || speakerStats.totalSegments <= 0) return [];
  const warnings = speakerWarnings(speakerStats, expectedSpeakers);
  const bRows = boundaryRows(boundaryPlan);
  const islandRows = minorIslandRows(islandPlan, speakerStats.ratioBasis);
  const neutralRows = unresolvedRows(unresolvedPlan, speakerStats.ratioBasis);
  const view = ratioBasisView(speakerStats.ratioBasis);
  const rows = speakerStats.speakers.map((s) => [
    String(s.speaker),
    view.wordsCell(s),
    pct1(s.ratio),
    String(s.chars),
    String(s.segments),
    elapsedFrom(s.firstT, startedAtMs),
    elapsedFrom(s.lastT, startedAtMs),
  ]);
  return [
    "## 話者分離の診断",
    "",
    ...bullets(speakerSummaryRows({ speakerStats, expectedSpeakers, sttInfo, displayDetected })),
    "",
    ...(warnings.length ? [...warnings, ""] : []),
    "| speaker | words | 割合 | 文字数 | segments | 初出 | 最終 |",
    "|---|---:|---:|---:|---:|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    ...(speakerStats.transitions.length
      ? [
          "### 話者遷移",
          "",
          "| from | to | 回数 |",
          "|---|---|---:|",
          ...speakerStats.transitions.map((t) => `| ${t.from} | ${t.to} | ${t.count} |`),
          "",
          // **下限であることを書く。** 再接続と話者不明の区間では遷移の鎖を切っている
          // (観測していない話者交代を作らないため)。切れた回数が読めないと、
          // 別セッションの遷移数と突き合わせたときに差の理由が分からない
          ...(speakerStats.reconnects > 0 || speakerStats.unknownSegments > 0
            ? ["> 再接続と話者不明の区間では鎖が切れるため、遷移回数は下限です。", ""]
            : []),
        ]
      : []),
    // **表示補正の節は「行データ」を画面パネルと共有する**(見出し行は同じ配列から描き、
    // from/to の明細だけ Markdown では表にする — speaker の表と同じ形)。
    // 計画を渡されていなければ節ごと出さない(「補正0件」と紛れないため)。
    // **②の行だけで判定してよい**: ②③の計画は `planDisplayCorrection()` の1回の計算から
    // 来るので、「②は無いが③はある」という組み合わせは作れない
    // ⓪(#55)は②の手前。**②の節の有無で⓪の節を判定しない** — ⓪は想定話者数のゲートが
    // 無いので、②が無効(想定話者数が自動)でも⓪は出る。画面パネルと同じ行データから描く
    ...(bRows.length ? ["### 表示補正（speaker boundary）", "", ...bullets(bRows), ""] : []),
    ...(islandRows.length
      ? [
          "### 表示補正（minor island）",
          "",
          ...bullets(islandRows),
          "",
          ...(islandPlan.disabledBy || islandPlan.merges.length === 0
            ? []
            : [
                // 分母は必ず word 数(chars 基準は補正そのものが無効になる #48)
                "| from | to | segments | words |",
                "|---|---|---:|---:|",
                ...islandPlan.merges.map((m) => `| ${m.from} | ${m.to} | ${m.segments} | ${m.words} |`),
                "",
              ]),
          // 中立化(#50)は②の明細の後。**画面パネルと同じ行データ**から描く
          ...bullets(neutralRows),
          ...(neutralRows.length ? [""] : []),
        ]
      : []),
  ];
}

// ---- STT テキスト完全性(#52) ----
//
// 「発話の冒頭が数文字欠けて見える」が**本当に文字の欠落なのか、話者分割の位置の問題なのか**
// を実データで切り分けるための節。段階ごとの文字数を1つの表に並べ、**どの段で減ったか**を
// 判定文にして出す。
//
// 出るのは件数・文字数・差分だけで、会話本文は1文字も入らない。
// **本文を復元しうる hash も入れない**(短い発話は総当たりで復元されうる)。

/**
 * 空白を除いた文字数。**判定に使うのはこちらで、素の `length` ではない**(#52)。
 *
 * サーバー側の話者分割は切り出しに `.trim()` を掛けるので、**正常に動いていても素の
 * 文字数は減る**。素の数で段階を比べると「正常な空白の消失」と「本物の欠落」が混ざって
 * 読めなくなる。
 *
 * **判定式(`/\s/g`)は `src/stt/split.ts` の `visibleChars()` と同じもの。** 言語境界を
 * またぐので実装は2つになるが、`tests/integrity.test.ts` が全角空白・タブ・改行まで含めて
 * 両者の一致を突き合わせている(片方だけ直すと段階別の文字数が意味を失う)。
 */
export function visibleChars(s) {
  return typeof s === "string" ? s.replace(/\s/g, "").length : 0;
}

/**
 * 文字列の配列を1段階ぶんの `{ chars, visible }` に畳む(#52)。
 *
 * `finalLines` は `localStorage` から**検証なしで**復元されるので、文字列でない `text` も
 * 混じりうる。`visibleChars()` 側で 0 に丸め、ここでは長さだけ同じ判定を通す
 * (`definedSpeaker()` / `normalizeCaptureMode()` と同じ、消費側で丸める規律)。
 */
export function countTextChars(texts) {
  let chars = 0;
  let visible = 0;
  for (const t of texts ?? []) {
    if (typeof t !== "string") continue;
    chars += t.length;
    visible += visibleChars(t);
  }
  return { chars, visible };
}

/** 段階の見出し。**この配列が表の行順そのもの**で、差分は1つ上の段との比較。 */
const INTEGRITY_STAGE_LABELS = [
  "① Deepgram final",
  "② 話者分割後",
  "③ クライアント受信",
  "④ 表示（段落結合後）",
];

/**
 * 段ごとの差(空白除く)に対する読み。**「どこを直せばよいか」まで書く**のが要点で、
 * 表だけ出すと読み手が毎回「これは欠落か分割か」を考え直すことになる。
 */
const INTEGRITY_STEP_VERDICTS = [
  {
    lost: "①→② で {n} 文字減少 → 話者分割で欠落している（src/stt/split.ts の切り出し／空セグメントの破棄）",
    gained: "①→② で {n} 文字増加 → 分割後のほうが多い。二重計上を疑う（同じ Results を2回積んでいないか）",
  },
  {
    lost: "②→③ で {n} 文字減少 → サーバーが送った final をクライアントが取りこぼしている",
    gained: "②→③ で {n} 文字増加 → クライアント側に前のセッションの行が残っている",
  },
  {
    lost: "③→④ で {n} 文字減少 → 表示側で欠落している（#36 / #48 / #50 の補正と段落結合。どれもラベルしか変えない設計なので、減っていれば回帰）",
    gained: "③→④ で {n} 文字増加 → 表示側が行を複製している",
  },
];

/**
 * ①→② にフォールバックが絡んだときの読み(#52)。**減少・増加の別より優先する。**
 *
 * フォールバックは `sliceFromTranscript()` が失敗したとき、すなわち `transcript` と
 * `words[]` が**食い違う文字列だった**ときにだけ起きる。連結で組み直した ② は ① と
 * 別の文字列なので、空白を除いた文字数すら増減しうる。ここを普通の減少・増加として
 * 読ませると、存在しないバグ(二重計上や切り出しの欠落)へ読み手を送ることになる。
 */
const INTEGRITY_FALLBACK_VERDICT =
  "①→② で {n} 文字{dir} → 切り出しに {f} 回失敗して連結で組み直しているため、②は①と別の文字列。この差は欠落とは限らない";

/**
 * 「STTテキスト完全性」の段階表と判定を組み立てる(#52)。
 *
 * **サーバーから `text_integrity` を1件も受けていなければ空を返す**(呼び出し側が節ごと
 * 落とす)。「0件」と「未取得」を混同させないため — mock モードと旧サーバーでは
 * この節がそもそも成立しない(#48 の `islandPlan` と同じ扱い)。
 *
 * @param integrity `ServerMessage.text_integrity` の中身(累計)
 * @param received ③ クライアントが積んだ `finalLines` の文字数(`countTextChars()`)
 * @param displayed ④ `groupUtterances()` の出力の文字数(`countTextChars()`)
 */
export function textIntegrityStageRows({ integrity, received, displayed }) {
  if (!integrity) return [];
  const stages = [
    { chars: integrity.rawChars, visible: integrity.rawVisible },
    { chars: integrity.splitChars, visible: integrity.splitVisible },
    received ?? { chars: 0, visible: 0 },
    displayed ?? { chars: 0, visible: 0 },
  ];
  return stages.map((s, i) => ({
    label: INTEGRITY_STAGE_LABELS[i],
    chars: s.chars,
    visible: s.visible,
    // 先頭に前段は無い。0 と「比較対象なし」を取り違えないよう null を返す
    diff: i === 0 ? null : s.visible - stages[i - 1].visible,
  }));
}

/**
 * 段階表から読める判定の文(#52)。**表と同じ配列から作る**ので、表と判定が食い違わない。
 *
 * 全段一致なら「欠落なし」と言い切る — 分割は文字数を保存するので、保存されていれば
 * 症状は分割位置（word 単位で助詞1語だけ話者が変わる）による見えであって欠落ではない。
 */
export function textIntegrityVerdict(rows, integrity) {
  if (rows.length === 0) return null;
  const fallbacks = integrity?.fallbacks ?? 0;
  const steps = rows.slice(1).flatMap((r, i) => {
    if (r.diff === 0) return [];
    const n = String(Math.abs(r.diff));
    if (i === 0 && fallbacks > 0) {
      return [
        INTEGRITY_FALLBACK_VERDICT.replace("{n}", n)
          .replace("{dir}", r.diff < 0 ? "減少" : "増加")
          .replace("{f}", String(fallbacks)),
      ];
    }
    const v = INTEGRITY_STEP_VERDICTS[i];
    return [(r.diff < 0 ? v.lost : v.gained).replace("{n}", n)];
  });
  if (steps.length === 0) {
    return "空白除く文字数がすべての段で一致 → 欠落なし。冒頭欠落の見えは分割位置による";
  }
  return steps.join(" / ");
}

/**
 * 節の本文行(画面パネルと Markdown が同じ配列から描く)。
 *
 * **値は plain text で組む。** 画面側は `el("td", null, value)` に素の文字列として
 * 入るので、判定文に `**` やバッククォートを混ぜるとパネルに記号がそのまま出る。
 */
export function textIntegrityRows({ integrity, received, displayed }) {
  const rows = textIntegrityStageRows({ integrity, received, displayed });
  if (rows.length === 0) return [];
  return [
    ...rows.map((r) => [
      r.label,
      `${r.chars} 文字 / 空白除く ${r.visible}${r.diff === null ? "" : `（前段との差 ${r.diff}）`}`,
    ]),
    ["final 数", `${integrity.finals}（うち分割が起きた: ${integrity.splitFinals}）`],
    ["切り出し失敗（連結へフォールバック）", String(integrity.fallbacks)],
    ["空で捨てたセグメント", `${integrity.droppedEvents}（うち先頭: ${integrity.headDrops}）`],
    ["判定", textIntegrityVerdict(rows, integrity)],
  ];
}

/**
 * 「STTテキスト完全性」セクション(#52)。**`text_integrity` を受けていなければ節ごと出さない。**
 */
function textIntegritySection({ integrity, received, displayed }) {
  const rows = textIntegrityStageRows({ integrity, received, displayed });
  if (rows.length === 0) return [];
  return [
    "## STTテキスト完全性",
    "",
    "| 段階 | 文字数 | 空白除く | 前段との差(空白除く) |",
    "|---|---:|---:|---:|",
    ...rows.map(
      (r) => `| ${r.label} | ${r.chars} | ${r.visible} | ${r.diff === null ? "—" : r.diff} |`,
    ),
    "",
    `- final 数: ${integrity.finals}（うち分割が起きた: ${integrity.splitFinals}）`,
    `- 切り出し失敗（連結へフォールバック）: ${integrity.fallbacks}`,
    `- 空で捨てたセグメント: ${integrity.droppedEvents}（うち先頭: ${integrity.headDrops}）`,
    `- 判定: ${textIntegrityVerdict(rows, integrity)}`,
    "",
    // **判定基準を節の中に書く。** 表だけ残すと、別の日に読んだ人が
    // 「素の文字数が減っているから欠落だ」と読み違える
    "> 切り出しに成功しているかぎり、空白除く文字数は分割で保存されます（`trim` が落とすのは空白だけ）。",
    "> **保存されていれば分割、減っていれば欠落**です。素の文字数の差は正常でも生じます。",
    // フォールバックは transcript と words が食い違うときにだけ起きるので、
    // 連結で組み直した ② は ① と別の文字列になる。ここを書かないと、
    // 「切り出し失敗 N 件」と「①→② の差」が別々の事実として読まれる
    "> ただし切り出し失敗が 0 でないときの ①→② の差は別扱いです。連結で組み直した ② は ① と別の文字列なので、空白除く文字数も増減しえます。",
    "> ③④ は最後の再接続より後ろの行だけを数えています（①② はサーバー側のセッション単位の累計なので、境界を揃えないと比較になりません）。",
    "",
  ];
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
 * **セクションごとに出す条件が違う。** 収音側(設定・入力統計)はマイクを開いた区間の値で、
 * 話者統計は `finalLines` に紐づく。1つの条件でまとめると、復元セッションで
 * 空の入力統計が出るか話者統計が出ないかのどちらかになる(#46)。
 *
 * @param modeLabel 収音モードの表示名(`captureModeLabel()`)。マイクを開いていなければ null
 * @param startedAt 開始日時の表示文字列
 * @param startedAtMs 開始時刻(epoch ms)。話者の初出・最終を**相対時間**にするために使う
 * @param elapsed 継続時間の表示文字列
 * @param trackSettings `MediaStreamTrack.getSettings()` の戻り
 * @param contextSampleRate `AudioContext.sampleRate`
 * @param stats `mergeAudioStats()` の累積値
 * @param speakerStats `collectSpeakerStats()` の戻り(#46)
 * @param expectedSpeakers 想定話者数の選択値(#46)
 * @param sttInfo `ServerMessage.stt_info` の中身(#46)
 * @param boundaryPlan `planDisplayCorrection()` の `boundaryPlan`(#55)。渡さなければ節ごと出ない
 * @param islandPlan `planMinorIslandMerges()` の戻り(#48)。渡さなければ節ごと出ない
 * @param unresolvedPlan `planUnresolvedMinors()` の戻り(#50)。渡さなければ中立化の行が出ない
 * @param displayDetected 表示上の**通常**話者数(`planDisplayCorrection()`、#48 / #50)
 * @param textIntegrity `ServerMessage.text_integrity` の中身(#52)。渡さなければ節ごと出ない
 * @param receivedChars ③ `finalLines` の文字数(`countTextChars()` の戻り、#52)
 * @param displayedChars ④ `groupUtterances()` の出力の文字数(`countTextChars()` の戻り、#52)
 */
export function buildDiagnosticsMarkdown({
  modeLabel,
  startedAt,
  startedAtMs,
  elapsed,
  trackSettings,
  contextSampleRate,
  stats,
  speakerStats,
  expectedSpeakers,
  sttInfo,
  boundaryPlan,
  islandPlan,
  unresolvedPlan,
  displayDetected,
  textIntegrity,
  receivedChars,
  displayedChars,
}) {
  const settingRows = trackSettingRows(trackSettings, contextSampleRate);
  const statRows = audioStatRows(stats);
  const summary = summarizeAudioStats(stats);
  const windowRows = summary ? histogramRows(summary.windows) : [];

  const out = [
    `# 収音診断 ${startedAt}`,
    "",
    // 収音モードはマイクを開いた区間でしか分からない。復元セッションで既定モードを
    // 書くと、実際には別のモードで録ったかもしれない値が事実として残る
    ...(modeLabel ? [`- 収音モード: ${modeLabel}`] : []),
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
    ...speakerSection({
      speakerStats,
      expectedSpeakers,
      sttInfo,
      startedAtMs,
      boundaryPlan,
      islandPlan,
      unresolvedPlan,
      displayDetected,
    }),
    ...textIntegritySection({
      integrity: textIntegrity,
      received: receivedChars,
      displayed: displayedChars,
    }),
    "> 会話本文と音声は含みません。",
    "",
  ];
  return out.join("\n");
}
