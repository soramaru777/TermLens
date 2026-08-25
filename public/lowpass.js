// ダウンサンプリング前に掛けるアンチエイリアス FIR の設計と、そのパラメータ。
//
// このファイルは AudioWorklet(audio-processor.js)から static import される。
// 同時に Node のテスト(tests/lowpass.test.ts)からも import して振幅応答を検証するため、
// **副作用を持たせないこと**。registerProcessor / AudioWorkletProcessor など
// worklet スコープ固有の API に触れる処理をここに置くと、テスト側で読み込めなくなる。
//
// 設計パラメータもここに置く。本番(audio-processor.js)とテストが別々に定義していると、
// 片方を変えてももう片方が緑のまま通ってしまい、テストが守るべき当のパラメータを守れない。

/** Deepgram へ送る目標サンプルレート。app.js の AudioWorkletNode 生成と共有する */
export const TARGET_SAMPLE_RATE = 16000;

// タップ数と遮断周波数。63タップでの実測(tests/lowpass.test.ts と同じ DFT)は
//   fs=48000 : 通過域 1k–6kHz の最悪 -0.726dB @ 6000Hz / 阻止域 9k–24kHz の最悪 -64.613dB @ 9000Hz
//   fs=44100 : 通過域 1k–6kHz の最悪 -0.557dB @ 6000Hz / 阻止域 9k–22.05kHz の最悪 -75.315dB @ 9845Hz
// 48kHz 入力の最悪点は帯域端の 9kHz で、-65dB にはわずかに届かない。
// (31タップだと 9kHz で -21dB しか取れず、95タップに増やしても実用上の差は小さい)
export const FIR_TAPS = 63;
/** 目標ナイキスト(8kHz)の 87.5% = 7kHz を遮断周波数にする */
export const CUTOFF_MARGIN = 0.875;

/** sinc + Blackman 窓でローパス FIR の係数を作る(端末ごとに入力レートが違うため実行時に設計する) */
export function designLowpass(numTaps, cutoffHz, sampleRate) {
  const fc = cutoffHz / sampleRate;
  const mid = (numTaps - 1) / 2;
  const h = new Float32Array(numTaps);
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));
    h[i] = sinc * window;
    sum += h[i];
  }
  for (let i = 0; i < numTaps; i++) h[i] /= sum; // 直流ゲインを1に正規化(音量を変えない)
  return h;
}
