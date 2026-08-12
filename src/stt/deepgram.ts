import WebSocket from "ws";
import type { SttAdapter, TranscriptEvent } from "./types.js";
import { config } from "../config.js";

const KEEPALIVE_INTERVAL_MS = 5000;

/** セグメント内の単語の多数決で話者番号を決める */
function dominantSpeaker(words?: Array<{ speaker?: number }>): number | undefined {
  if (!words?.length) return undefined;
  const counts = new Map<number, number>();
  for (const w of words) {
    if (typeof w.speaker === "number") {
      counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Deepgram streaming STT アダプタ。
 * wss://api.deepgram.com/v1/listen に 16kHz mono PCM16 を流し、
 * interim/final transcript を受け取る。用語集は keywords ブーストとして渡す。
 */
export class DeepgramSttAdapter implements SttAdapter {
  private ws: WebSocket | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private transcriptCb: ((e: TranscriptEvent) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private stopping = false;

  async start(opts: { keywords: string[] }): Promise<void> {
    const params = new URLSearchParams({
      model: config.deepgramModel,
      language: "ja",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      diarize: "true",
    });
    // nova-3 系は keyterm(日本語対応・最大約100語)、nova-2 以前は keywords でブースト
    const useKeyterm = config.deepgramModel.startsWith("nova-3");
    for (const kw of opts.keywords) {
      const term = kw.trim();
      if (!term) continue;
      if (useKeyterm) params.append("keyterm", term);
      else params.append("keywords", `${term}:2`);
    }
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${config.deepgramApiKey}` },
      });
      this.ws = ws;

      ws.on("open", () => {
        this.keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, KEEPALIVE_INTERVAL_MS);
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "Results") {
            const alt = msg.channel?.alternatives?.[0];
            const text: string = alt?.transcript ?? "";
            if (text.length > 0) {
              this.transcriptCb?.({
                text,
                isFinal: msg.is_final === true,
                speaker: dominantSpeaker(alt?.words),
              });
            }
          }
        } catch {
          // JSON以外のフレームは無視
        }
      });

      ws.on("error", (err) => {
        if (this.ws === ws && !this.stopping) this.errorCb?.(err as Error);
        reject(err as Error);
      });

      ws.on("close", () => {
        if (this.keepAlive) clearInterval(this.keepAlive);
        if (!this.stopping) this.closeCb?.();
      });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      // 残りの final を受け取るために CloseStream を送ってから閉じる
      ws.send(JSON.stringify({ type: "CloseStream" }));
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 3000);
        ws.on("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } else {
      ws.terminate();
    }
    this.ws = null;
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
