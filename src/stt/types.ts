/** 単語単位の認識結果。話者分割・誤認識補正の材料として使う。 */
export interface TranscriptWord {
  /** 認識された素の表記 */
  word: string;
  /** smart_format による句読点つき表記。無効時は来ないので optional */
  punctuatedWord?: string;
  /** 発話開始・終了（秒。ストリーム先頭からの相対） */
  start: number;
  end: number;
  /** 0.0〜1.0。低いほど誤認識の疑いが強い */
  confidence: number;
  /** diarization 有効時の話者番号 */
  speaker?: number;
}

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  /** 話者番号(diarization有効時。不明なら undefined) */
  speaker?: number;
  /**
   * 単語単位の情報。アダプタが提供しない場合は undefined。
   *
   * **optional は意図的**。必須にすると `SttAdapter` を実装している既存コードが
   * 即座に型エラーになる。words を出せないアダプタを将来足せる余地も残す。
   *
   * サーバー内部で使うためのもので、`ServerMessage.transcript` には載せない
   * （WS ペイロードが見積もりで約13倍になり、クライアントの localStorage 復元が劣化するため。
   * 詳細は docs/wiki/termlens-stt-pipeline.md）。
   */
  words?: TranscriptWord[];
}

export interface SttAdapter {
  start(opts: { keywords: string[] }): Promise<void>;
  /** 16kHz mono PCM16 LE の音声チャンク */
  sendAudio(chunk: Buffer): void;
  stop(): Promise<void>;
  onTranscript(cb: (e: TranscriptEvent) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}
