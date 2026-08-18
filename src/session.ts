import type { WebSocket, RawData } from "ws";
import type { SttAdapter } from "./stt/types.js";
import { MockSttAdapter } from "./stt/mock.js";
import { DeepgramSttAdapter } from "./stt/deepgram.js";
import { ExtractionScheduler } from "./extract/scheduler.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { config } from "./config.js";

/**
 * クライアントから届いた値を文字列配列に正規化する。
 * 配列でなければ空配列、要素は文字列だけを残す(長さの上限は呼び出し先で掛ける)。
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function createSttAdapter(): SttAdapter {
  return config.sttProvider === "deepgram"
    ? new DeepgramSttAdapter()
    : new MockSttAdapter();
}

/**
 * クライアントWS 1本 = Session 1個。
 * STTアダプタ・抽出スケジューラ・クライアントWSを配線する。
 */
export class Session {
  private stt: SttAdapter | null = null;
  private scheduler: ExtractionScheduler | null = null;
  private closed = false;

  constructor(private ws: WebSocket) {
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => void this.teardown());
    ws.on("error", () => void this.teardown());
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.stt?.sendAudio(data as Buffer);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.send({ type: "error", code: "bad_request", message: "invalid JSON" });
      return;
    }
    if (msg.type === "start") {
      // WS 越しの入力なので実行時の型は保証されない。配列であることだけでなく
      // 要素が文字列であることまで見る。文字列以外が混ざると normalizeTerm の
      // term.normalize() で例外になり、プロセスごと落ちて他のセッションも巻き込む
      void this.start(toStringArray(msg.glossary), toStringArray(msg.shownTerms)).catch((err) => {
        // 1 セッションの失敗でサーバー全体を落とさない
        console.error("[session] start failed:", err);
        this.send({ type: "error", code: "bad_request", message: "セッションを開始できませんでした。" });
      });
    } else if (msg.type === "stop") {
      void this.stopSession().catch((err) => {
        console.error("[session] stop failed:", err);
      });
    }
  }

  private async start(glossary: string[], shownTerms: string[] = []): Promise<void> {
    if (this.stt) {
      this.send({ type: "error", code: "bad_request", message: "already started" });
      return;
    }
    this.scheduler = new ExtractionScheduler(
      glossary,
      {
        onCards: (cards) => this.send({ type: "cards", cards }),
        onCardUpdate: (term, description, links) =>
          this.send({ type: "card_update", term, description, links }),
        onExtracting: () => this.send({ type: "status", state: "extracting" }),
        // permanent: 恒久エラーで抽出を打ち切ったときだけ scheduler から真が渡ってくる(#10)
        onError: (message, permanent) => this.send({ type: "error", code: "llm_error", message, permanent }),
      },
      shownTerms,
    );

    const stt = createSttAdapter();
    this.stt = stt;
    stt.onTranscript((e) => {
      this.send({ type: "transcript", text: e.text, isFinal: e.isFinal, speaker: e.speaker ?? null });
      if (e.isFinal) this.scheduler?.addFinal(e.text);
    });
    stt.onError((err) => {
      console.error("[session] STT error:", err);
      this.send({ type: "error", code: "stt_error", message: err.message });
    });
    stt.onClose(() => this.send({ type: "status", state: "stt_closed" }));

    this.send({ type: "status", state: "stt_connecting" });
    try {
      await stt.start({ keywords: glossary });
      this.send({ type: "status", state: "stt_open" });
      this.send({ type: "ready" });
    } catch (err) {
      console.error("[session] STT start failed:", err);
      this.stt = null;
      this.send({ type: "error", code: "stt_error", message: (err as Error).message });
    }
  }

  private async stopSession(): Promise<void> {
    const stt = this.stt;
    const scheduler = this.scheduler;
    this.stt = null;
    this.scheduler = null;
    if (stt) await stt.stop().catch(() => {});
    if (scheduler) await scheduler.flush().catch(() => {});
  }

  private async teardown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stt = this.stt;
    this.stt = null;
    this.scheduler?.stop();
    this.scheduler = null;
    if (stt) await stt.stop().catch(() => {});
  }
}
