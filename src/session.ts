import type { WebSocket, RawData } from "ws";
import type { SttAdapter, TranscriptEvent } from "./stt/types.js";
import { MockSttAdapter } from "./stt/mock.js";
import { DeepgramSttAdapter } from "./stt/deepgram.js";
import { ExtractionScheduler } from "./extract/scheduler.js";
import { UtteranceBuilder } from "./stt/utterance.js";
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
  private builder: UtteranceBuilder | null = null;
  private closed = false;
  /**
   * 最後に配った `finalSeq`(#36)。**配る番号は 1 から**で、0 は「まだ1件も配っていない」
   * ことを表す初期値でしかない(クライアントに 0 は届かない)。1つの Deepgram Results を
   * 話者で分割したイベントには同じ番号を配り、クライアントの jitter 補正がそれを
   * 手掛かりに再結合する。
   *
   * このフィールドは WS 1本の生存期間を通じて持ち、**同じ接続で stop → start しても
   * 0 に戻さない**(戻すと停止前後の final に同じ番号が付き、別発話が結合されうる)。
   * 再接続で WS ごと張り直された場合は 1 から振り直しになるが、クライアントは
   * 再接続の境界で必ずグループを切るので衝突しない。
   */
  private lastFinalSeq = 0;

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
    const scheduler = new ExtractionScheduler(
      glossary,
      {
        onCards: (cards) => this.send({ type: "cards", cards }),
        // status は #24 で追加。検証の結果(confirmed / unresolved)をそのまま通す
        onCardUpdate: (term, status, description, links) =>
          this.send({ type: "card_update", term, status, description, links }),
        onExtracting: () => this.send({ type: "status", state: "extracting" }),
        // permanent: 恒久エラーで抽出を打ち切ったときだけ scheduler から真が渡ってくる(#10)
        onError: (message, permanent) => this.send({ type: "error", code: "llm_error", message, permanent }),
      },
      shownTerms,
    );
    this.scheduler = scheduler;

    // 表示と抽出で扱う単位を分ける。表示は STT が確定した瞬間に出し（遅延ゼロ）、
    // 抽出だけが発話の完成を待つ。両方を発話単位にすると確定テキストの表示が数秒遅れる。
    //
    // コールバックが `this.scheduler` ではなく**ローカルの scheduler を掴む**のが重要。
    // stopSession() はフィールドを null にしてから flush() するので、`this.scheduler?.`
    // だと最後の発話が握り潰されて抽出に届かない。停止後の受け入れ可否は
    // scheduler 側の stopped/disabled フラグが judge する。
    const builder = new UtteranceBuilder((u) => scheduler.addUtterance(u.text));
    this.builder = builder;

    const stt = createSttAdapter();
    this.stt = stt;
    stt.onTranscript((e) => {
      this.send({
        type: "transcript",
        text: e.text,
        isFinal: e.isFinal,
        speaker: e.speaker ?? null,
        // 分割された final に同じ番号を配るのがここの仕事(#36)。採番を
        // buildFinalEvents() 側に持たせるとグローバルカウンタになり、純関数として
        // テストできなくなる
        finalSeq: e.isFinal ? this.assignFinalSeq(e) : undefined,
      });
      if (e.isFinal) builder.addFinal(e);
    });
    stt.onUtteranceEnd(() => builder.utteranceEnd());
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

  /**
   * この final に配る `finalSeq` を決めて返す(進めた後の現在値)。
   *
   * **カウンタを進めるのは Results の先頭(`segIndex === 0`)だけ。** 話者で分割された
   * 2件目以降は先頭と同じ番号を受け取る。`segIndex` を持たないアダプタ(将来の実装)は
   * undefined で来るので、その場合は1件ごとに進める＝分割なしと同じ扱いになる。
   */
  private assignFinalSeq(e: TranscriptEvent): number {
    if (e.segIndex === undefined || e.segIndex === 0) this.lastFinalSeq++;
    return this.lastFinalSeq;
  }

  private async stopSession(): Promise<void> {
    const stt = this.stt;
    const scheduler = this.scheduler;
    const builder = this.builder;
    this.stt = null;
    this.scheduler = null;
    this.builder = null;
    if (stt) await stt.stop().catch(() => {});
    // builder → scheduler の順。逆にすると、未確定の発話がスケジューラに届く前に
    // バッファが処理されて最後の発話を取りこぼす
    builder?.flush();
    // flush 済みなので、以降に遅れて届く final でタイマーを張り直させない
    builder?.stop();
    if (scheduler) await scheduler.flush().catch(() => {});
  }

  private async teardown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stt = this.stt;
    this.stt = null;
    // 異常終了なので発話は捨てる（stopSession と違い flush しない）。
    // タイマーだけ確実に止める
    this.builder?.stop();
    this.builder = null;
    this.scheduler?.stop();
    this.scheduler = null;
    if (stt) await stt.stop().catch(() => {});
  }
}
