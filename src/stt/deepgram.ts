import WebSocket from "ws";
import type { SttAdapter, TranscriptEvent } from "./types.js";
import { config } from "../config.js";

const KEEPALIVE_INTERVAL_MS = 5000;

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
      model: "nova-2",
      language: "ja",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
    });
    for (const kw of opts.keywords) {
      const term = kw.trim();
      if (term) params.append("keywords", `${term}:2`);
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
            const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
            if (text.length > 0) {
              this.transcriptCb?.({ text, isFinal: msg.is_final === true });
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
