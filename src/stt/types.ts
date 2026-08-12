export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  /** 話者番号(diarization有効時。不明なら undefined) */
  speaker?: number;
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
