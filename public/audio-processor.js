// AudioWorkletProcessor: 実サンプルレート(44.1k/48k等) → 16kHz mono PCM16 LE に変換。
// 約250ms(4000サンプル@16kHz)溜まるごとに ArrayBuffer を postMessage(transfer)する。

const CHUNK_SAMPLES = 4000;

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputRate = options.processorOptions.inputSampleRate;
    this.targetRate = options.processorOptions.targetSampleRate;
    this.ratio = this.inputRate / this.targetRate;
    this.readPos = 0; // 入力ストリーム上の小数読み取り位置(残余)
    this.residual = new Float32Array(0);
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    // 前回の残りと連結
    const input = new Float32Array(this.residual.length + channel.length);
    input.set(this.residual, 0);
    input.set(channel, this.residual.length);

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
