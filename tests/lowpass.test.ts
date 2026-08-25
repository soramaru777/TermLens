import assert from "node:assert/strict";
import test from "node:test";
// public/ はビルドレスな素の JS。tsconfig.test.json の allowJs で解決している
// （tsconfig.json 側は src/ だけを見るので本番ビルドには影響しない）。
import {
  CUTOFF_MARGIN,
  FIR_TAPS,
  TARGET_SAMPLE_RATE,
  designLowpass,
} from "../public/lowpass.js";

// 設計パラメータは本番と**同じ定義元**から取る。ここで値をコピーすると、
// lowpass.js 側を変えてもこのテストが緑のまま通り、drift を検出できなくなる。
const CUTOFF_HZ = (TARGET_SAMPLE_RATE / 2) * CUTOFF_MARGIN; // 7000 Hz

// 通過域・阻止域の判定閾値。
//
// 阻止域の閾値は「-65dB を狙った設計」ではなく **実測値から決めている**。
// 63タップ・7kHz 遮断での実測（このテストと同じ DFT）は次のとおり:
//   fs=48000 : 通過域 1k–6kHz の最悪 -0.726 dB @ 6000 Hz / 阻止域 9k–24kHz の最悪 -64.613 dB @ 9000 Hz
//   fs=44100 : 通過域 1k–6kHz の最悪 -0.557 dB @ 6000 Hz / 阻止域 9k–22.05kHz の最悪 -75.315 dB @ 9845 Hz
// 48kHz 側は -65dB にわずかに届かない（帯域端の 9kHz が最悪点）ため、閾値は -64.0 dB に置く。
// 44.1kHz は入力ナイキストが低いぶん阻止域が 9.8kHz 付近まで押し下がり、10dB 以上余裕がある。
const PASSBAND_MIN_DB = -1.0;
const STOPBAND_MAX_DB = -64.0;

const PASSBAND = { from: 1000, to: 6000 };
const STOPBAND_FROM = 9000;
const STEP_HZ = 5;

/** 係数から振幅応答 |H(f)| = |Σ h[n]·e^(-j2πf·n/fs)| を dB で求める */
function magnitudeDb(h: Float32Array, freqHz: number, sampleRate: number): number {
  let re = 0;
  let im = 0;
  for (let n = 0; n < h.length; n++) {
    const w = (-2 * Math.PI * freqHz * n) / sampleRate;
    re += h[n]! * Math.cos(w);
    im += h[n]! * Math.sin(w);
  }
  return 20 * Math.log10(Math.hypot(re, im));
}

function design(sampleRate: number): Float32Array {
  return designLowpass(FIR_TAPS, CUTOFF_HZ, sampleRate) as Float32Array;
}

for (const sampleRate of [48000, 44100]) {
  test(`designLowpass(${sampleRate}Hz): 通過域 ${PASSBAND.from}–${PASSBAND.to}Hz が ${PASSBAND_MIN_DB}dB 以上`, () => {
    const h = design(sampleRate);
    let worst = Infinity;
    let worstAt = 0;
    for (let f = PASSBAND.from; f <= PASSBAND.to; f += STEP_HZ) {
      const db = magnitudeDb(h, f, sampleRate);
      if (db < worst) {
        worst = db;
        worstAt = f;
      }
    }
    assert.ok(
      worst >= PASSBAND_MIN_DB,
      `通過域の最悪値 ${worst.toFixed(3)}dB @ ${worstAt}Hz が ${PASSBAND_MIN_DB}dB を下回った`,
    );
  });

  test(`designLowpass(${sampleRate}Hz): 阻止域 ${STOPBAND_FROM}Hz–ナイキストが ${STOPBAND_MAX_DB}dB 以下`, () => {
    const h = design(sampleRate);
    const nyquist = sampleRate / 2;
    let worst = -Infinity;
    let worstAt = 0;
    let points = 0;
    for (let f = STOPBAND_FROM; f <= nyquist; f += STEP_HZ) {
      points += 1;
      const db = magnitudeDb(h, f, sampleRate);
      if (db > worst) {
        worst = db;
        worstAt = f;
      }
    }
    // ナイキストが STOPBAND_FROM を下回るレートを足すとループが空振りし、
    // worst = -Infinity のまま無条件 pass する。走査点数の下限で気づけるようにする。
    assert.ok(
      points >= 100,
      `阻止域の走査点が ${points} 点しかない（${sampleRate}Hz のナイキストが ${STOPBAND_FROM}Hz に近すぎる）`,
    );
    assert.ok(
      worst <= STOPBAND_MAX_DB,
      `阻止域の最悪値 ${worst.toFixed(3)}dB @ ${worstAt}Hz が ${STOPBAND_MAX_DB}dB を上回った`,
    );
  });

  test(`designLowpass(${sampleRate}Hz): 直流ゲインが 1（音量を変えない）`, () => {
    const h = design(sampleRate);
    let sum = 0;
    for (const v of h) sum += v;
    // Float32 に丸めた係数を double で足し込むため、厳密な 1 にはならない
    assert.ok(Math.abs(sum - 1) < 1e-6, `Σh[n] = ${sum}`);
    assert.ok(Math.abs(magnitudeDb(h, 0, sampleRate)) < 1e-5);
  });

  test(`designLowpass(${sampleRate}Hz): 係数が対称（線形位相）`, () => {
    const h = design(sampleRate);
    assert.equal(h.length, FIR_TAPS);
    for (let i = 0; i < h.length; i++) {
      // 係数は Float32Array に格納されるため、窓関数の引数が対称でない
      // （cos(2πi/(N-1)) と cos(2π(N-1-i)/(N-1))）ことによる倍精度側の
      // 最終ビット差は丸めで吸収され、厳密に一致する。
      assert.equal(h[i], h[h.length - 1 - i], `h[${i}] と h[${h.length - 1 - i}] が非対称`);
    }
  });

  test(`designLowpass(${sampleRate}Hz): 遮断周波数 ${CUTOFF_HZ}Hz が約 -6dB`, () => {
    // sinc 設計の遮断周波数は振幅が半分（-6dB）になる点。設計意図どおりであることの確認。
    const db = magnitudeDb(design(sampleRate), CUTOFF_HZ, sampleRate);
    assert.ok(Math.abs(db - -6.02) < 0.5, `${CUTOFF_HZ}Hz の応答が ${db.toFixed(2)}dB`);
  });

  test(`designLowpass(${sampleRate}Hz): 目標ナイキスト ${TARGET_SAMPLE_RATE / 2}Hz より上が確実に減衰する`, () => {
    // 折り返しの原因になるのは目標ナイキスト（8kHz）超の成分。
    // 8kHz 直上はまだ遷移域だが、単調に落ちていることを確認する。
    const h = design(sampleRate);
    const at8k = magnitudeDb(h, 8000, sampleRate);
    const at9k = magnitudeDb(h, 9000, sampleRate);
    assert.ok(at8k < -20, `8kHz が ${at8k.toFixed(2)}dB`);
    assert.ok(at9k < at8k, `9kHz(${at9k.toFixed(2)}dB) が 8kHz(${at8k.toFixed(2)}dB) より減衰していない`);
  });
}
