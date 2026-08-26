import type { TranscriptEvent } from "./types.js";

/**
 * 複数の final を1つの発話にまとめる。**依存ゼロで保つこと**（import は `./types.js` の型のみ）。
 *
 * Deepgram の `is_final` は認識区間の確定であって、人の意味的な発話完了とは一致しない。
 * そのまま用語抽出へ渡すと文の途中で切れ、文脈不足のまま LLM に渡ることになる。
 *
 * `deepgram.ts` に置くと、使いたいだけの `mock.ts` とそのテストが `ws` と `config.ts` を
 * 連れ込む（`config.ts` はモジュール評価時に throw しうる）。`split.ts` と同じ理由で分けてある。
 */

/** 発話終端シグナルが来ないときに、最後の final から待つ時間。 */
export const UTTERANCE_TIMEOUT_MS = 3_000;

/**
 * 終端シグナルを待たずに閉じる文字数の閾値。
 * `speech_final` も `UtteranceEnd` も来ないまま延々と話し続けられた場合の保険。
 *
 * **上限ではない**。追加後に判定するので、1件の final がこれを超えていれば
 * その長さのまま1発話になる。
 */
export const MAX_UTTERANCE_CHARS = 500;

export interface Utterance {
  text: string;
  /** 発話全体の話者。話者が変わると発話を分けるので、1発話に1話者しか入らない */
  speaker?: number;
}

/**
 * final の列から発話を組み立てる。
 *
 * **確定（`onUtterance` を呼ぶ）契機は4つ**。優先順位ではなく、どれか1つでも成立したら閉じる。
 *
 * 1. `speechFinal` が立った final を足した直後（Deepgram の無音検出）
 * 2. `utteranceEnd()`（Deepgram の word ギャップ検出）。バッファが空なら何もしない
 * 3. 最後に足してから `UTTERANCE_TIMEOUT_MS` 経過（**どのシグナルも来ない場合の保険**）
 * 4. バッファが `MAX_UTTERANCE_CHARS` に達した
 *
 * 加えて、**定義済みの話者が変わったら足す前に確定**する（相槌や話者交代をまたいで結合しない）。
 *
 * `speaker` が `undefined` のイベントは**境界を作らず現在の発話に吸収**し、
 * 発話の speaker は「その中で最初に現れた定義済み speaker」とする。
 * これは `split.ts` の `splitBySpeaker()` とまったく同じ規則。
 * 同じ「話者不明」に対して隣接する2層が逆の規則を持つと、diarize が一時的に speaker を
 * 返さない final が1件挟まるだけで同一話者の発話が3つに割れる。
 *
 * テキストは**区切り文字なしで連結**する。ここが担うのは「1つの発話を組み立てる」ことなので、
 * 間に何も挟まないのが正しい。別々の発話をつなぐ `ExtractionScheduler` 側が `" "` 区切りなのとは
 * 役割が違う。副作用として、語の途中で final が割れると `AWS` と `Lambda` が `AWSLambda` に
 * なりうるが、final は無音 300ms で切れるので語の途中で割れるのは稀。
 */
export class UtteranceBuilder {
  private parts: string[] = [];
  private speaker: number | undefined;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private onUtterance: (u: Utterance) => void) {}

  /** `isFinal` のイベントだけを渡す。interim は渡さないこと */
  addFinal(e: TranscriptEvent): void {
    if (this.stopped) return;
    // 定義済みの話者が変わったら、今のイベントを足す前に現バッファを閉じる。
    // undefined は境界を作らない（split.ts の splitBySpeaker と同じ規則）
    if (
      typeof e.speaker === "number" &&
      this.speaker !== undefined &&
      e.speaker !== this.speaker
    ) {
      this.emit();
    }
    // 先頭が undefined 続きだった発話は、最初に現れた定義済み speaker を後から採用する
    if (this.speaker === undefined && typeof e.speaker === "number") this.speaker = e.speaker;
    this.parts.push(e.text);

    if (e.speechFinal || this.currentLength() >= MAX_UTTERANCE_CHARS) {
      this.emit();
      return;
    }
    this.restartTimer();
  }

  /** Deepgram の `UtteranceEnd`。バッファが空なら何も発行しない */
  utteranceEnd(): void {
    if (this.stopped) return;
    this.emit();
  }

  /** セッション終了時。溜まっているぶんを最後の発話として出す */
  flush(): void {
    if (this.stopped) return;
    this.emit();
  }

  private currentLength(): number {
    let n = 0;
    for (const p of this.parts) n += p.length;
    return n;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.reset();
  }

  private restartTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.emit(), UTTERANCE_TIMEOUT_MS);
    // 発話待ちのタイマーだけでプロセスを生かし続けない
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(): void {
    this.clearTimer();
    if (this.parts.length === 0) return;
    const text = this.parts.join("");
    const speaker = this.speaker;
    this.reset();
    this.onUtterance({ text, speaker });
  }

  private reset(): void {
    this.parts = [];
    this.speaker = undefined;
  }
}
