import WebSocket from "ws";
import type { SttAdapter, SttInfo, TranscriptEvent, TranscriptWord } from "./types.js";
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
 * `speechFinal` は**返す配列の最後の1件にだけ**立てる。全件に立てると、
 * 話者で分割した各セグメントごとに `UtteranceBuilder` が発話を閉じてしまい、
 * 「分割してから同一話者を結合する」という組み合わせが噛み合わない。
 * 発話終端は「その Results の終わり」であって「各セグメントの終わり」ではない。
 *
 * export しているのは tests/transcript-events.test.ts から検証するため。
 */
export function buildTranscriptEvents(
  alt: DeepgramAlternative | undefined,
  isFinal: boolean,
  speechFinal = false,
): TranscriptEvent[] {
  const text = alt?.transcript ?? "";
  if (text.length === 0) return [];
  const words = toTranscriptWords(alt?.words);
  if (!isFinal) {
    return [{ text, isFinal: false, speaker: undefined, words }];
  }
  const events = buildFinalEvents(text, words);
  if (speechFinal && events.length > 0) {
    events[events.length - 1].speechFinal = true;
  }
  return events;
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
 * Deepgram streaming の Results に載る `metadata`。ここで使うぶんだけ。
 *
 * 実際の形は
 * `{ request_id, model_info: { name, version, arch }, model_uuid, diarize_info?: { model_uuid, arch } }`。
 * `diarize_info` は **diarizer が動いたときだけ** present。
 *
 * **`request_id` は型に持たせない。** 持たせると「載せない」がコメントだけの約束になる。
 * 型に無ければ、`toSttInfo()` を書き換えないかぎり外へ出しようがない
 * (`public/diagnostics.js` の `TRACK_KEYS` と同じ、採用リストの発想)。
 */
export interface DeepgramMetadata {
  model_info?: { name?: string; version?: string; arch?: string };
  diarize_info?: { model_uuid?: string; arch?: string };
}

/**
 * Results の metadata から `SttInfo` を作る。スネークケース → キャメルケースの変換は
 * ここに閉じる(`toTranscriptWords()` と同じ方針)。
 *
 * **取れなかったキーは落とす。** 「取れていない」ことは、キーの不在で表す
 * (ダミー値や空文字を入れると、受け手が「取れたが空だった」と区別できない)。
 * 何も取れなければ `undefined` を返し、アダプタはコールバックを呼ばない。
 *
 * **判定は `!= null`。** `undefined` だけを弾くと、Deepgram が `name: null` を返したときに
 * `{ name: null }` という「取れていない値を持つオブジェクト」が1階層できてしまい、
 * 「取れたものだけを持つ」という上の約束が崩れる(表示側は truthy 判定で落とすので
 * 画面には出ないが、その差は型からは読めない)。
 *
 * export しているのは tests/stt-info.test.ts から検証するため。
 */
export function toSttInfo(metadata: DeepgramMetadata | undefined): SttInfo | undefined {
  const info: SttInfo = {};
  const mi = metadata?.model_info;
  const model = {
    ...(mi?.name != null ? { name: mi.name } : {}),
    ...(mi?.version != null ? { version: mi.version } : {}),
    ...(mi?.arch != null ? { arch: mi.arch } : {}),
  };
  if (Object.keys(model).length > 0) info.model = model;
  const di = metadata?.diarize_info;
  const diarizer = {
    ...(di?.arch != null ? { arch: di.arch } : {}),
    ...(di?.model_uuid != null ? { modelUuid: di.model_uuid } : {}),
  };
  if (Object.keys(diarizer).length > 0) info.diarizer = diarizer;
  return info.model || info.diarizer ? info : undefined;
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
  private utteranceEndCb: (() => void) | null = null;
  private sttInfoCb: ((info: SttInfo) => void) | null = null;
  /**
   * 直近に通知した `SttInfo` の JSON。**変化の検出だけに使う。**
   * Deepgram は Results ごとに同じ metadata を返すので、素通しすると
   * 同じ内容の `stt_info` を数百回クライアントへ送ることになる。
   */
  private lastSttInfoJson: string | null = null;
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
      // **`diarize_model` へは切り替えない(#46)。** streaming の `diarize_model=latest` は
      // 現状 v1 に解決され、deprecated な `diarize=true` も v1 に行くので今日は挙動が
      // 変わらない。かつ `diarize` と `diarize_model` の同時指定は Deepgram に 400 で
      // 拒否されるため、切り替えるなら**入れ替え**が必要で、それは別 PR にする
      // (この Issue は「どの diarizer が動いていたか」を観測できるようにするだけ)。
      diarize: "true",
      // 既定値は 10ms で、わずかな間でも確定してしまい文の途中で切れる。
      // 300ms にすると自然な文単位でまとまり、smart_format の句読点も付きやすくなる。
      // 長くしすぎると 1 セグメントに複数話者が入る。word の speaker で分割するので
      // 多数派に潰されることはなくなったが、代わりに話者番号の揺れが細切れとして出る。
      // 上げるほどその機会が増える点は変わらない。
      endpointing: "300",
      // speech_final は無音（VAD）で判定するため、背景ノイズが続くと立たないことが
      // 公式に明記されている。UtteranceEnd は word の時間ギャップで判定し音声を見ないので、
      // 騒がしい会議室ではこちらが発話終端の頼りになる。1000ms は公式の最小推奨値。
      // interim_results=true が前提だが上で有効にしてある。
      utterance_end_ms: "1000",
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
            // モデル情報は Results ごとに同じ値で載ってくる。**変わったときだけ**通知する
            const info = toSttInfo(msg.metadata as DeepgramMetadata | undefined);
            if (info) {
              const json = JSON.stringify(info);
              if (json !== this.lastSttInfoJson) {
                this.lastSttInfoJson = json;
                this.sttInfoCb?.(info);
              }
            }
            const events = buildTranscriptEvents(
              msg.channel?.alternatives?.[0],
              msg.is_final === true,
              msg.speech_final === true,
            );
            // 1セグメント内で話者が変われば複数件になる。コールバックはその回数ぶん呼ぶ
            for (const e of events) this.transcriptCb?.(e);
            // transcript が空の Results に speech_final が立つことがある。イベントは
            // 発行できないが（空 transcript は送らない）、終端シグナルまで捨てると
            // 確定契機が1つ黙って消えるので、境界としてだけ伝える
            if (msg.speech_final === true && events.length === 0) this.utteranceEndCb?.();
          } else if (msg.type === "UtteranceEnd") {
            // テキストを持たない境界シグナル。`last_word_end` は今は使わない。
            // Deepgram は UtteranceEnd が対応する final より先に届きうるとしており、
            // その場合は発話が一足早く閉じて直後の final が短い発話になる。
            // 実機で頻度を測るまでは last_word_end による並べ替えは入れない
            this.utteranceEndCb?.();
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
  onUtteranceEnd(cb: () => void): void {
    this.utteranceEndCb = cb;
  }
  onSttInfo(cb: (info: SttInfo) => void): void {
    this.sttInfoCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
}
