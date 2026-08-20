// AudioWorkletProcessor: 実サンプルレート(44.1k/48k等) → 16kHz mono PCM16 LE に変換。
// 約250ms(4000サンプル@16kHz)溜まるごとに ArrayBuffer を postMessage(transfer)する。
//
// 間引く前に必ずローパスを掛ける。掛けないと、目標レートの半分(16kHzなら8kHz)を超える
// 音がそのままの大きさで音声帯域に折り返す。日本語の子音(サ行・シャ行・ツ・ハ行・破裂音)は
// 8〜16kHz に強いエネルギーを持つため、それが母音や有声音にノイズとして重なり、
// 音声認識が最も頼る手がかりを壊してしまう。

const CHUNK_SAMPLES = 4000;
// タップ数と遮断周波数。63タップで阻止域は約 -65dB 以下、通過域は 6kHz でも -0.7dB に収まる。
// (31タップだと 9kHz で -21dB しか取れず、95タップに増やしても実用上の差は小さい)
const FIR_TAPS = 63;
const CUTOFF_MARGIN = 0.875; // 目標ナイキスト(8kHz)の 87.5% = 7kHz を遮断周波数にする

/** sinc + Blackman 窓でローパス FIR の係数を作る(端末ごとに入力レートが違うため実行時に設計する) */
function designLowpass(numTaps, cutoffHz, sampleRate) {
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

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputRate = options.processorOptions.inputSampleRate;
    this.targetRate = options.processorOptions.targetSampleRate;
    this.ratio = this.inputRate / this.targetRate;

    const cutoff = (this.targetRate / 2) * CUTOFF_MARGIN;
    this.fir = designLowpass(FIR_TAPS, cutoff, this.inputRate);
    // 直前ブロックの末尾。ブロック境界で FIR が途切れると周期的なノイズになるため持ち越す
    this.firTail = new Float32Array(FIR_TAPS - 1);

    this.readPos = 0; // 入力ストリーム上の小数読み取り位置(残余)
    this.residual = new Float32Array(0);
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
  }

  /** ローパスを掛けた入力を返す。長さは入力と同じ(遅延は FIR の群遅延ぶんだけ一定) */
  filter(block) {
    const taps = this.fir;
    const tail = this.firTail;
    const tailLen = tail.length;
    const out = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) {
      let acc = 0;
      for (let k = 0; k < taps.length; k++) {
        const j = i - k;
        // j が負の位置は直前ブロックの末尾から読む
        acc += taps[k] * (j >= 0 ? block[j] : tail[tailLen + j]);
      }
      out[i] = acc;
    }
    // 末尾を次ブロックへ持ち越す
    if (block.length >= tailLen) {
      tail.set(block.subarray(block.length - tailLen));
    } else {
      tail.copyWithin(0, block.length);
      tail.set(block, tailLen - block.length);
    }
    return out;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    const filtered = this.filter(channel);

    // 前回の残りと連結(残余もローパス済みの値)
    const input = new Float32Array(this.residual.length + filtered.length);
    input.set(this.residual, 0);
    input.set(filtered, this.residual.length);

    let pos = this.readPos;
    while (pos + 1 < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const sample = input[i] * (1 - frac) + input[i + 1] * frac; // 線形補間
      const clamped = Math.max(-1, Math.min(1, sample));
      this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.outLen === CHUNK_SAMPLES) {
        const buf = this.out.buffer.slice(0);
        this.port.postMessage(buf, [buf]);
        this.out = new Int16Array(CHUNK_SAMPLES);
        this.outLen = 0;
      }
      pos += this.ratio;
    }

    // 未消費サンプルを残余として保持
    const consumed = Math.floor(pos);
    this.residual = input.slice(consumed);
    this.readPos = pos - consumed;
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
