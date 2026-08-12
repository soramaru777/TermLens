import type { SttAdapter, TranscriptEvent } from "./types.js";
import { MOCK_SCRIPT } from "./mock-script.js";

/**
 * スクリプトを再生するモックSTT。マイクもAPIキーも不要で
 * transcript → 抽出 → カード表示のパイプライン全体を検証できる。
 * 1行につき interim を数回発行してから final を発行し、スクリプト末尾でループする。
 */
export class MockSttAdapter implements SttAdapter {
  private transcriptCb: ((e: TranscriptEvent) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  async start(_opts: { keywords: string[] }): Promise<void> {
    this.stopped = false;
    this.playLine(0);
  }

  private playLine(index: number): void {
    if (this.stopped) return;
    const line = MOCK_SCRIPT[index % MOCK_SCRIPT.length];
    const steps = 3; // interim 回数
    let step = 0;

    const tick = () => {
      if (this.stopped) return;
      step += 1;
      if (step <= steps) {
        const len = Math.ceil((line.length * step) / (steps + 1));
        this.transcriptCb?.({ text: line.slice(0, len), isFinal: false });
        this.timer = setTimeout(tick, 600);
      } else {
        this.transcriptCb?.({ text: line, isFinal: true });
        this.timer = setTimeout(() => this.playLine(index + 1), 1500);
      }
    };
    this.timer = setTimeout(tick, 600);
  }

  sendAudio(_chunk: Buffer): void {
    // モックでは音声は捨てる
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.closeCb?.();
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.transcriptCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
}
