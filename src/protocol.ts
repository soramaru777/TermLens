// クライアント⇔サーバー WebSocket プロトコル。
// バイナリフレーム = 音声 (16kHz mono PCM16 LE)、テキストフレーム = JSON。

export interface TermLink {
  title: string;
  url: string;
}

export interface TermCard {
  term: string;
  reading: string;
  description: string;
  confidence: "high" | "low";
  correctedFrom: string | null;
  /** 文字起こし中に実際に登場した表記(ハイライト用) */
  surfaceForms: string[];
  rarity: "common" | "uncommon" | "rare";
  /** true ならこのカードは後から card_update で web検索結果に更新される */
  willEnrich: boolean;
  /** web検索による清書前は空。card_update で更新される */
  links: TermLink[];
}

export type ClientMessage =
  // shownTerms: 再接続時にクライアントが既に持っているカードの term 一覧。
  // サーバーの ExtractionScheduler は WS 1本ごとに新規生成されデデュープ状態が空から
  // 始まるため、渡さないと再接続後に同じ用語のカードが再送されてしまう(#8)。
  // 省略時は空扱い(後方互換)。
  | { type: "start"; glossary: string[]; shownTerms?: string[] }
  | { type: "stop" };

export type ServerMessage =
  | { type: "ready" }
  | { type: "transcript"; text: string; isFinal: boolean; speaker: number | null }
  | { type: "cards"; cards: TermCard[] }
  | { type: "card_update"; term: string; description: string; links: TermLink[] }
  | { type: "status"; state: "stt_connecting" | "stt_open" | "stt_closed" | "extracting" }
  | {
      type: "error";
      code: "auth_failed" | "stt_error" | "llm_error" | "bad_request";
      message: string;
      /** 恒久エラーで抽出を打ち切ったときだけ true。クライアントはこれが真の時だけ消えないバナーを出す(#10) */
      permanent?: boolean;
    };
