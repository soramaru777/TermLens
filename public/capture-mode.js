// 収音モードの定義と、モードから `getUserMedia` の audio constraints への変換(#26)。
//
// **依存ゼロ・副作用ゼロで置く。** `public/app.js` はモジュール評価の時点で
// `document.getElementById` を呼ぶので Node のテストから import できない
// (`lowpass.js` / `card-status.js` / `terms-markdown.js` を切り出したのと同じ理由)。
// 収音モードは **全セッションの文字起こし精度に直結する** ので、既定モードの
// constraints が変わっていないことを決定的テストで固定できる場所に置いておく。
//
// **`app.js` に constraints をベタ書きしないこと。** ここが唯一の定義箇所で、
// 両方に書くと片方だけ変わっても `tests/capture-mode.test.ts` は緑のまま通る。

/**
 * 収音モード。`constraints` はそのまま `getUserMedia({ audio: ... })` に渡る。
 *
 * **`meeting` は既定であり、現状(#26 以前)の constraints と1バイトも違わない。**
 * ここを動かすと、モードを一度も触っていない利用者の文字起こしまで変わる。
 */
export const CAPTURE_MODES = {
  meeting: {
    label: "対面会議",
    hint: "会議室で複数人の声を拾います。離れた席の声を残すため、エコーキャンセルとノイズ抑制を切ります。",
    // 対面の会議で、離れた席の声まで拾うための設定。
    // エコーキャンセルとノイズ抑制はブラウザ側で「近くの1人の声」を残す方向に働き、
    // 会議室の遠い話者を環境音として削ってしまう。文字起こしでは欠落の原因になるため切る。
    // 自動ゲインは距離差による音量差を均すので残す。
    constraints: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
      channelCount: 1,
    },
  },
  speaker: {
    label: "スピーカー収音",
    hint: "PC やスピーカーから出る音を拾います。回り込みを抑えるため、エコーキャンセルとノイズ抑制を入れます。",
    // 端末のマイクが自分のスピーカーの音を拾うと同じ音が二重に入り、認識が崩れる。
    // エコーキャンセルはまさにそれを消すためのもので、対面会議で切っている理由
    // (離れた席の声を環境音として削る)はスピーカーを至近距離で拾う場合には当たらない。
    //
    // **未検証(#26)。** ブラウザのエコーキャンセルは「自端末のスピーカー出力を参照して
    // 打ち消す」実装なので、**別の端末**のスピーカーを拾う場合は参照信号が無く効かない
    // 可能性がある。実機で効かないようなら false に倒す。
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  },
};

/** 既定は対面会議。#26 以前の唯一の挙動なので、ここを変えると既存利用者の設定が黙って変わる */
export const DEFAULT_CAPTURE_MODE = "meeting";

/**
 * 既知のモード名に丸める。`localStorage` が古い・壊れている場合は既定に倒す。
 *
 * **`Object.hasOwn` で見るのが要点。** 素の `CAPTURE_MODES[mode]` だと
 * `"constructor"` や `"toString"` が Object.prototype 経由で truthy になり、
 * `constraints` が `undefined` のまま `getUserMedia` へ渡る。
 * モード名は `localStorage`(信頼境界の外)から来るので、ここで無害化しておく。
 */
export function normalizeCaptureMode(mode) {
  return typeof mode === "string" && Object.hasOwn(CAPTURE_MODES, mode)
    ? mode
    : DEFAULT_CAPTURE_MODE;
}

/**
 * モードに対応する `getUserMedia` の audio constraints を返す。
 *
 * **毎回新しいオブジェクトを返す。** 呼び出し側(や `getUserMedia` の実装)が
 * 受け取った object を書き換えても、モード定義そのものは汚れない。
 */
export function audioConstraints(mode) {
  return { ...CAPTURE_MODES[normalizeCaptureMode(mode)].constraints };
}

/** 画面に出すモード名。ホーム画面・設定画面・診断で同じ文言を使う */
export function captureModeLabel(mode) {
  return CAPTURE_MODES[normalizeCaptureMode(mode)].label;
}

/** モードの説明文。設定画面で選択中のモードの下に出す */
export function captureModeHint(mode) {
  return CAPTURE_MODES[normalizeCaptureMode(mode)].hint;
}
