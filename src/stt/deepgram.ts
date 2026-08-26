import WebSocket from "ws";
import type { SttAdapter, TranscriptEvent, TranscriptWord } from "./types.js";
import { buildFinalEvents } from "./split.js";
import { config } from "../config.js";

const KEEPALIVE_INTERVAL_MS = 5000;

/**
 * Deepgram の `channel.alternatives[0].words[]` の要素。
 * JSON がスネークケースなので、ここだけ Deepgram の表記に合わせる
 * （キャメルケースへの変換は `toTranscriptWords()` で行う）。
 * `punctuated_word` は smart_format 依存、`speaker` は diarize 依存で、
 * どちらも無効時は来ないため optional。
 */
export interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
}

/**
 * Deepgram の `channel.alternatives[0]` のうち、ここで使うぶんだけ。
 * テストから組み立てられるよう最小限の形にしてある。
 */
export interface DeepgramAlternative {
  transcript?: string;
  words?: DeepgramWord[];
}

/**
 * 1つの Results メッセージから発行すべき `TranscriptEvent` を組み立てる。
 * `SttAdapter.onTranscript` は1メッセージにつき何回でも呼べるので、
 * 話者が変われば複数返す。型もプロトコルも変わらない。
 *
 * **interim は分割しない。** `public/app.js` の interim 表示ハンドラは受け取った text で
 * 上書きするので、2件送ると前半の話者ぶんが後半に消される。interim の `speaker` は
 * クライアントで読まれていないため `undefined` でよい。
 *
 * `text` が空なら何も返さない（従来の `if (text.length > 0)` と同じ扱い）。
 *
 * export しているのは tests/transcript-events.test.ts から検証するため。
 */
export function buildTranscriptEvents(
  alt: DeepgramAlternative | undefined,
  isFinal: boolean,
): TranscriptEvent[] {
  const text = alt?.transcript ?? "";
  if (text.length === 0) return [];
  const words = toTranscriptWords(alt?.words);
  if (!isFinal) {
    return [{ text, isFinal: false, speaker: undefined, words }];
  }
  return buildFinalEvents(text, words);
}

/**
 * Deepgram の words を `TranscriptWord[]` に変換する。
 * `punctuated_word` → `punctuatedWord` のキャメルケース化以外は素通し。
 * `punctuated_word` / `speaker` は無効時に来ないので undefined のまま通す。
 *
 * **空配列ではなく undefined を返す。** 「words が来なかった」と「word が0個だった」を
 * 型の上で区別する必要はなく、undefined に寄せたほうが後続の `if (!e.words)` が素直に書ける。
 *
 * export しているのは tests/transcript-words.test.ts から検証するため。
 */
export function toTranscriptWords(words?: DeepgramWord[]): TranscriptWord[] | undefined {
  if (!words?.length) return undefined;
  return words.map((w) => ({
    word: w.word,
    punctuatedWord: w.punctuated_word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
    speaker: w.speaker,
  }));
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
      // 既定値は 10ms で、わずかな間でも確定してしまい文の途中で切れる。
      // 300ms にすると自然な文単位でまとまり、smart_format の句読点も付きやすくなる。
      // 長くしすぎると 1 セグメントに複数話者が入る。word の speaker で分割するので
      // 多数派に潰されることはなくなったが、代わりに話者番号の揺れが細切れとして出る。
      // 上げるほどその機会が増える点は変わらない。
      endpointing: "300",
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
            const events = buildTranscriptEvents(
              msg.channel?.alternatives?.[0],
              msg.is_final === true,
            );
            // 1セグメント内で話者が変われば複数件になる。コールバックはその回数ぶん呼ぶ
            for (const e of events) this.transcriptCb?.(e);
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
