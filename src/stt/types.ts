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
  /**
   * 1つの Results を話者で分割したときの通し番号（0 起点）。
   *
   * **分割の事実だけを載せ、採番はしない。** `buildFinalEvents()` は純関数なので
   * グローバルカウンタを持たせるとテストの決定性が壊れる。`src/session.ts` が
   * `segIndex === 0`（または undefined）を「新しい Results の先頭」と読んでカウンタを進め、
   * その値を `ServerMessage.finalSeq` としてクライアントへ送る。
   * クライアントはそれを使って話者ラベルの揺れを再結合する（#36）。
   *
   * 分割されなかった final も `segIndex: 0` を通るので、必ず1つ採番される。
   * interim には付かない（分割しないため）。
   *
   * **分割数は載せない。** 採番に要るのは「先頭かどうか」だけで、件数を持たせても
   * 読み手がいない。`words` / `speechFinal` と同じくサーバー内部用で、
   * `ServerMessage.transcript` には `segIndex` 自体を載せない（載せるのは採番結果の
   * `finalSeq` だけ）。
   */
  segIndex?: number;
  /**
   * Deepgram の `speech_final`。無音検出（`endpointing`）による発話終端。
   *
   * interim では立たない。1つの Results を話者で複数に分割した場合、
   * **立つのは最後のセグメントだけ**（発話終端は「その Results の終わり」であって
   * 「各セグメントの終わり」ではないため）。
   *
   * `words` と同じくサーバー内部で使うもので、`ServerMessage.transcript` には載せない。
   */
  speechFinal?: boolean;
}

/**
 * STT 側のモデル情報(#46)。話者分離の診断で「どの diarizer がどのモデルで動いていたか」を
 * 記録するために使う。
 *
 * **アダプタが取れた項目だけを持つ optional の集合**にしてある。Deepgram は
 * `diarize_info` を diarizer が動いたときだけ返し、metadata 自体が来ないメッセージもある。
 * 必須にすると「取れなかった」を表すためのダミー値が要る。
 *
 * **セッションを一意に指す値(`request_id` など)はここに入れない。** 診断ファイルは
 * 実機比較の結果として共有されうるため、`src/protocol.ts` の `stt_info` と同じく
 * 採用リストの発想で必要なものだけを通す。
 */
export interface SttInfo {
  model?: { name?: string; version?: string; arch?: string };
  /** diarizer が動いたときだけ入る */
  diarizer?: { arch?: string; modelUuid?: string };
}

export interface SttAdapter {
  start(opts: { keywords: string[] }): Promise<void>;
  /** 16kHz mono PCM16 LE の音声チャンク */
  sendAudio(chunk: Buffer): void;
  stop(): Promise<void>;
  onTranscript(cb: (e: TranscriptEvent) => void): void;
  /**
   * 発話終端の補助シグナル（Deepgram の `UtteranceEnd`）。
   *
   * **テキストを持たない**ため `onTranscript` とは別経路にしてある。
   * `TranscriptEvent` で表そうとすると `text: ""` を流すことになり、
   * 「空の transcript は送らない」という既存の不変条件と衝突する。
   *
   * 相当する仕組みを持たないアダプタは空実装でよい（mock がそうしている）。
   */
  onUtteranceEnd(cb: () => void): void;
  /**
   * STT のモデル情報が分かった/変わったときに呼ばれる(#46)。
   *
   * **毎メッセージではなく変化時だけ**呼ぶ契約。Deepgram は Results ごとに同じ
   * metadata を返すので、素通しするとクライアントへ同じ内容を数百回送ることになる。
   *
   * 相当する情報を持たないアダプタは空実装でよい(mock がそうしている)。
   */
  onSttInfo(cb: (info: SttInfo) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}
