import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIP_THRESHOLD,
  emptyAudioStats,
  mergeAudioStats,
  SILENCE_DBFS,
  summarizeAudioStats,
} from "../public/diagnostics.js";
import { TARGET_SAMPLE_RATE } from "../public/lowpass.js";

/**
 * `public/audio-processor.js` の入力統計（#26）を**実際に走らせて**確かめる。
 *
 * worklet は `AudioWorkletProcessor` / `registerProcessor` を前提にモジュール評価が
 * 走るので、Node から読むにはその2つを先に用意する必要がある。用意さえすれば
 * `process()` は素の JS なので、決定的に叩ける。
 *
 * **一番重要なのは「統計をローパス前の生入力から取る」ことの検証。** ソースを目で見て
 * 順番を確かめても、後から誰かが `this.filter(channel)` の後ろへ動かせば静かに壊れる。
 * ここでは **8kHz を超える信号**（ローパスが -60dB 以上落とす帯域）を入れて、
 * 報告される RMS が**落ちていない**ことで判定する。フィルタ後から取っていれば
 * RMS はほぼ 0 になり、このテストは落ちる。
 *
 * あわせて **音声（ArrayBuffer）の経路が無傷であること**も見る。#26 は統計を足すだけで
 * FIR・ダウンサンプルには触っていない。
 */

const INPUT_RATE = 48000;
const BLOCK = 128; // render quantum

type Envelope = { type?: string; buf?: ArrayBuffer; stats?: Record<string, number> };
type Instance = { posted: Envelope[]; process: (inputs: Float32Array[][]) => boolean };

/**
 * worklet スコープの最小スタブ。**振り分けはしない。**
 *
 * スタブ側で種類ごとに積むと、テストが「スタブの定義を言い直すだけ」になって
 * 実装を壊しても落ちなくなる。届いた封筒をそのまま積み、分類はテスト側で行う。
 */
class StubWorkletProcessor {
  posted: Envelope[] = [];
  port = {
    postMessage: (data: unknown) => {
      this.posted.push(data as Envelope);
    },
  };
}

let Registered: (new (opts: unknown) => Instance) | null = null;

/**
 * `audio-processor.js` を1度だけ読み込み、以後はそのコンストラクタを使い回す。
 * ESM のモジュールキャッシュがあるので、import を毎回やり直すことはできない。
 */
async function makeProcessor(): Promise<{ process: (block: Float32Array) => void; posted: Envelope[] }> {
  if (!Registered) {
    const g = globalThis as Record<string, unknown>;
    g.AudioWorkletProcessor = StubWorkletProcessor;
    g.registerProcessor = (_name: string, ctor: unknown) => {
      Registered = ctor as new (opts: unknown) => Instance;
    };
    await import("../public/audio-processor.js");
    assert.ok(Registered, "registerProcessor が呼ばれていない");
  }
  const instance = new Registered!({
    processorOptions: { inputSampleRate: INPUT_RATE, targetSampleRate: TARGET_SAMPLE_RATE },
  });
  return { process: (block) => void instance.process([[block]]), posted: instance.posted };
}

/** 一定振幅の正弦波を1ブロックぶん作る */
/** 封筒から音声だけを取り出す。**分類はここ1箇所** — スタブ側でやると恒真テストになる */
const audioOf = (posted: Envelope[]) =>
  posted.filter((m) => m.type === "audio").map((m) => m.buf!);
/** 封筒から統計だけを取り出す */
const statsOf = (posted: Envelope[]) =>
  posted.filter((m) => m.type === "stats").map((m) => m.stats!);
/** 統計をセッション全体へ畳み込む（本番の app.js と同じ経路） */
const mergeAll = (posted: Envelope[]) =>
  statsOf(posted).reduce((acc, s) => mergeAudioStats(acc, s), emptyAudioStats());

function tone(freqHz: number, amplitude: number, offsetSamples: number): Float32Array {
  const out = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * (offsetSamples + i)) / INPUT_RATE);
  }
  return out;
}

/** 統計メッセージが1件出るまで（= 1秒ぶん）流す */
function feed(
  process: (block: Float32Array) => void,
  make: (offset: number) => Float32Array,
  seconds = 1,
): void {
  const blocks = Math.ceil((INPUT_RATE * seconds) / BLOCK);
  for (let b = 0; b < blocks; b++) process(make(b * BLOCK));
}

test("統計はローパス前の生入力から取る（8kHz超でも RMS が落ちない）", async () => {
  const { process, posted } = await makeProcessor();
  // 12kHz はローパスの阻止域（tests/lowpass.test.ts の実測で -64dB 以下）。
  // フィルタ後から統計を取っていれば、報告される RMS はほぼ 0 になる
  feed(process, (off) => tone(12000, 0.5, off));
  assert.ok(statsOf(posted).length >= 1, "統計が1件も送られていない");
  const merged = mergeAll(posted);
  const summary = summarizeAudioStats(merged)!;
  // 振幅 0.5 の正弦波の RMS は 0.5/√2 ≈ 0.354
  assert.ok(
    Math.abs(summary.avgRms - 0.5 / Math.SQRT2) < 0.02,
    `生入力の RMS になっていない: ${summary.avgRms}`,
  );
});

test("音声（ArrayBuffer）は従来どおり 4000 サンプルずつ送られる", async () => {
  const { process, posted } = await makeProcessor();
  feed(process, (off) => tone(440, 0.3, off), 1);
  // 16kHz で 1 秒 = 16000 サンプル → 4000 サンプルのチャンクが 4 件
  const audio = audioOf(posted);
  assert.equal(audio.length, 4);
  for (const buf of audio) assert.equal(buf.byteLength, 4000 * 2);
});

/**
 * **メッセージは種類を名乗る。**
 *
 * 型（`instanceof ArrayBuffer`）で判別すると「それ以外は全部統計」になり、3種類目を
 * 足した瞬間に例外ではなく統計として畳み込まれる。名前で分ければ、受け側は扱わない
 * 種類を捨てられる。
 */
test("メッセージは種類を名乗る（音声も統計も封筒に入る）", async () => {
  const { process, posted } = await makeProcessor();
  feed(process, (off) => tone(440, 0.3, off), 1);

  assert.ok(posted.length > 0, "何も送られていない");
  for (const m of posted) {
    assert.ok(m.type === "audio" || m.type === "stats", `種類の無いメッセージ: ${JSON.stringify(m)}`);
  }
  assert.ok(audioOf(posted).length > 0, "音声が送られていない");
  assert.ok(statsOf(posted).length > 0, "統計が送られていない");
  // 音声は transfer で渡す ArrayBuffer のまま（封筒に入れてもコピーしない）
  for (const buf of audioOf(posted)) assert.ok(buf instanceof ArrayBuffer);
});

/**
 * **レベルの指標を1本も落とさない。**
 *
 * `peak`（サンプルの最大振幅）を消しても `clipRatio` も `silentRatio` も `avgRms` も
 * 変わらないので、他のテストは全部通る。診断の「最大サンプル振幅」だけが全セッションで
 * 0 に固定され、**クリップ率が 0% のときに閾値が高すぎるのか妥当なのかを判定できなく
 * なる**（AC5 の判定材料が静かに消える）。
 */
test("ピークが実際の振幅を反映する", async () => {
  const { process, posted } = await makeProcessor();
  feed(process, (off) => tone(440, 0.5, off), 1);
  const stats = mergeAll(posted);
  const summary = summarizeAudioStats(stats)!;

  assert.ok(summary.peak > 0.49 && summary.peak <= 0.5, `peak=${summary.peak}`);
  // 正弦波の RMS は振幅 / √2 ≒ 0.354。ピークはそれより明確に大きい
  assert.ok(summary.avgRms > 0.3 && summary.avgRms < 0.4, `avgRms=${summary.avgRms}`);
  assert.ok(summary.peak > summary.avgRms, "ピークは RMS より大きい（同じ値を入れていない）");
});

/**
 * **分布は時間窓ごとに積む。** render quantum を単位にすると分母が
 * 「`process()` が呼ばれた回数」になり、ブラウザの実装粒度に依存する。
 */
test("窓の分布は時間で刻まれる（呼び出し回数ではない）", async () => {
  const { process, posted } = await makeProcessor();
  feed(process, (off) => tone(440, 0.3, off), 1);
  const stats = mergeAll(posted);
  const windows = stats.windows.reduce((a, b) => a + b, 0);

  // 1秒 ÷ 100ms = 10 窓。render quantum 単位なら 375 になる
  assert.ok(windows >= 9 && windows <= 11, `窓の数が時間に対応していない: ${windows}`);
});

test("無音は無音率に、飽和はクリッピング率に出る", async () => {
  const { process, posted } = await makeProcessor();
  // 完全な無音を1秒
  feed(process, () => new Float32Array(BLOCK), 1);
  const silent = mergeAll(posted);
  assert.equal(summarizeAudioStats(silent)!.silentRatio, 1);
  assert.equal(summarizeAudioStats(silent)!.clipRatio, 0);

  const clip = await makeProcessor();
  // 閾値相当の直流。`Float32Array` に入る値で確実に閾値以上になるよう `Math.fround` を通す。
  //
  // **`>=` と `>` の違いはここでは踏めない。** float32 に丸めた 0.99 は
  // 0.9900000095…（double の閾値より大きい側）になるので、どちらの比較でも通る。
  // サンプルが閾値と厳密に等しくなるのは float32 で表現できる閾値のときだけなので、
  // この境界は実データでは起こらない（等価変異として扱う）
  feed(clip.process, () => new Float32Array(BLOCK).fill(Math.fround(CLIP_THRESHOLD)), 1);
  const loud = mergeAll(clip.posted);
  assert.equal(summarizeAudioStats(loud)!.clipRatio, 1, "閾値ちょうどはクリッピングに数える");
  assert.equal(summarizeAudioStats(loud)!.silentRatio, 0);
  assert.ok(SILENCE_DBFS < 0, "無音の水準はフルスケール未満");
});

test("統計はおよそ1秒ごとに送られ、区間ごとに 0 に戻る", async () => {
  const { process, posted } = await makeProcessor();
  feed(process, (off) => tone(440, 0.3, off), 3);
  const chunks = statsOf(posted);
  assert.ok(chunks.length >= 3, `1秒ごとに送られていない: ${chunks.length}`);
  for (const s of chunks) {
    // 累積を送っていると 2 件目以降が 1 秒ぶんを大きく超える（累積は app.js 側で取る）
    assert.ok(s.samples >= INPUT_RATE && s.samples < INPUT_RATE + BLOCK, `samples=${s.samples}`);
  }
});
