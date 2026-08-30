// クライアント⇔サーバー WebSocket プロトコル。
// バイナリフレーム = 音声 (16kHz mono PCM16 LE)、テキストフレーム = JSON。

export interface TermLink {
  title: string;
  url: string;
}

/**
 * 用語カードの判定状態(#24)。`confidence: "high" | "low"` を置き換えたもので、
 * `low` が `probable` に 1:1 で対応する。
 *
 * **同じ事実を2フィールドで持たないために「追加」ではなく「置き換え」にしてある。**
 * `confidence` と併存させると、LLM が `high` かつ `unresolved` のような矛盾した組を
 * 返したときの正解が決まらない。
 *
 * - `confirmed`  — 補正なし、または確信のある補正
 * - `probable`   — 補正したが確信がない(旧 `confidence: "low"`。UI は「もしかして?」)
 * - `unresolved` — 音声認識の表記から正しい用語を特定できなかった。
 *   **UI は推定した term を見せず、聞き取られた表記そのものを見出しにする**
 *
 * `unresolved` から上へは戻さない。`card_update` は `term` でカードを突き合わせる仕様で
 * 改名の経路が無く(#23)、解説だけ差し替えると表示が食い違うため。
 */
export type TermStatus = "confirmed" | "probable" | "unresolved";

export interface TermCard {
  term: string;
  reading: string;
  description: string;
  status: TermStatus;
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
  // finalSeq: final 1件ごとの連番(#36)。1つの Deepgram Results を話者で分割した
  // イベントには**同じ番号**が付く。クライアントはこれを「本来1発話だったもの」の印として
  // 使い、話者ラベルの短時間の揺れ(speaker jitter)で細切れになった行を再結合する
  // (public/utterances.js)。interim には付かない。
  //
  // **optional は後方互換のため。** 旧サーバーから届く transcript には無く、
  // #36 以前に localStorage へ保存された行にも無い。クライアントはその場合、
  // 受信時刻の窓によるフォールバック判定へ落ちる。
  //
  // **配る番号は 1 から**(0 はサーバー側カウンタの初期値で、クライアントには届かない)。
  // 再接続でサーバー側セッションが張り直されると 1 から振り直しになるが、クライアントは
  // 再接続の境界で必ずグループを切るので衝突しない。
  | { type: "transcript"; text: string; isFinal: boolean; speaker: number | null; finalSeq?: number }
  | { type: "cards"; cards: TermCard[] }
  // status は optional にしない。送り側(scheduler)では検証の結果として必ず決まるので、
  // 省略できる形にすると受け側が「変化なし」と「未指定」を区別できなくなる(#24)。
  | { type: "card_update"; term: string; status: TermStatus; description: string; links: TermLink[] }
  | { type: "status"; state: "stt_connecting" | "stt_open" | "stt_closed" | "extracting" }
  | {
      type: "error";
      code: "auth_failed" | "stt_error" | "llm_error" | "bad_request";
      message: string;
      /** 恒久エラーで抽出を打ち切ったときだけ true。クライアントはこれが真の時だけ消えないバナーを出す(#10) */
      permanent?: boolean;
    };
