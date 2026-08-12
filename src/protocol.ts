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
  | { type: "start"; glossary: string[] }
  | { type: "stop" };

export type ServerMessage =
  | { type: "ready" }
  | { type: "transcript"; text: string; isFinal: boolean; speaker: number | null }
  | { type: "cards"; cards: TermCard[] }
  | { type: "card_update"; term: string; description: string; links: TermLink[] }
  | { type: "status"; state: "stt_connecting" | "stt_open" | "stt_closed" | "extracting" }
  | { type: "error"; code: "auth_failed" | "stt_error" | "llm_error" | "bad_request"; message: string };
