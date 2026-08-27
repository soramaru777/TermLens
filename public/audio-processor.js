// AudioWorkletProcessor: 実サンプルレート(44.1k/48k等) → 16kHz mono PCM16 LE に変換。
// 約250ms(4000サンプル@16kHz)溜まるごとに PCM を postMessage(transfer)する。
// メッセージは `{ type, ... }` の封筒に入れる(受け側が種類で分岐できるように)。
//
// 間引く前に必ずローパスを掛ける。掛けないと、目標レートの半分(16kHzなら8kHz)を超える
// 音がそのままの大きさで音声帯域に折り返す。日本語の子音(サ行・シャ行・ツ・ハ行・破裂音)は
// 8〜16kHz に強いエネルギーを持つため、それが母音や有声音にノイズとして重なり、
// 音声認識が最も頼る手がかりを壊してしまう。

// 設計パラメータと designLowpass は、Node のテストからも同じ値を検証できるよう
// lowpass.js に集約している(ここで別定義すると drift してもテストが気づけない)。
import { CUTOFF_MARGIN, FIR_TAPS, designLowpass } from "./lowpass.js";
// 入力統計の閾値は diagnostics.js が唯一の定義箇所(#26)。ここで別の数値を持つと、
// 実機の計測を見て閾値を決めたときに片方だけ残る。
import {
  CLIP_THRESHOLD,
  dbfsBin,
  emptyAudioStats,
  SILENCE_WINDOW_SEC,
  toDbfs,
} from "./diagnostics.js";

const CHUNK_SAMPLES = 4000;

// 入力統計を postMessage する間隔(秒)。1秒ぶん溜まるごとに区間の集計を送り、
// 累積は app.js 側(mergeAudioStats)で取る。
const STATS_INTERVAL_SEC = 1;

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

    // 入力統計(#26)。区間ぶんを溜めて、STATS_INTERVAL_SEC ごとに送って 0 に戻す
    this.statsIntervalSamples = Math.max(1, Math.round(this.inputRate * STATS_INTERVAL_SEC));
    // **無音判定の窓は時間で決める。** render quantum を単位にすると分母が
    // 「process() が呼ばれた回数」になり、ブラウザの実装粒度に依存する
    this.windowSamples = Math.max(1, Math.round(this.inputRate * SILENCE_WINDOW_SEC));
    this.windowSumSq = 0;
    this.windowLen = 0;
    // **形は `emptyAudioStats()` を正典にする。** ここに同じリテラルを書くと、
    // 項目を足したときに直し漏らしても例外にならず「常に 0」で出続ける
    this.stats = emptyAudioStats();
  }

  /**
   * **ローパス前の生入力**から統計を取る(#26)。
   *
   * 生で取るのは「マイクが実際にどう入っているか」を見たいからで、こちらで加工した
   * 後の波形では収音モードの比較に使えない。**波形には一切触れない** — 加算と比較
   * だけなので、音声スレッドの負荷はほぼ増えず、FIR とダウンサンプルの経路
   * (直前のコミットで折り返し歪みを潰した精度の要)は無変更のままにできる。
   *
   * **閾値ではなく分布を積む。** 窓ごとの RMS を dBFS のビンに入れておけば、
   * 無音の水準は表示するときに当てられる(理由は diagnostics.js 冒頭)。
   */
  collectStats(block) {
    const s = this.stats;
    let sumSq = 0;
    let clipped = 0;
    let peak = 0;
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      sumSq += x * x;
      const ax = Math.abs(x);
      if (ax >= CLIP_THRESHOLD) clipped++;
      if (ax > peak) peak = ax;
    }
    s.samples += block.length;
    s.sumSq += sumSq;
    s.clipped += clipped;
    if (peak > s.peak) s.peak = peak;

    // 時間窓ぶん溜まるたびに RMS を1つビンへ積む。render quantum とは無関係
    this.windowSumSq += sumSq;
    this.windowLen += block.length;
    while (this.windowLen >= this.windowSamples) {
      const rms = Math.sqrt(this.windowSumSq / this.windowLen);
      s.windows[dbfsBin(toDbfs(rms))] += 1;
      this.windowSumSq = 0;
      this.windowLen = 0;
    }

    if (s.samples >= this.statsIntervalSamples) {
      // **音声(ArrayBuffer)と同じポートで送る。** 受け手は e.data の型で判別する。
      // 判別しないと統計オブジェクトがそのまま音声ストリームへ混ざる
      // **種類を名乗る。** 型で判別すると「ArrayBuffer 以外は全部統計」になり、
      // 3種類目を足したときに例外にならず統計へ混ざる(num() が未知の値を 0 に潰すので
      // 静かに壊れる)。名前で分ければ、扱わない種類は受け側で捨てられる
      this.port.postMessage({ type: "stats", stats: s });
      this.stats = emptyAudioStats();
    }
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

    // 統計は**ローパスを掛ける前**に取る(#26)。以降の経路は #26 で変更していない
    this.collectStats(channel);

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
        // transfer list はそのまま。封筒に入れてもコピーは発生しない
        this.port.postMessage({ type: "audio", buf }, [buf]);
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
