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
 * `unresolved` から上へは戻さない。**ただし #40 の再評価だけは例外**で、後続の会話で
 * 確定した用語を手がかりに web 検証をやり直し、裏付けが取れたときに限って昇格する。
 * その経路では `card_update` に `rename` が載り、term も同時に差し替わる
 * (「解説だけ差し替えると表示が食い違う」という #24 の理由がそこで消える)。
 * **`rename` を伴わない `card_update` では従来どおり昇格させない。**
 */
export type TermStatus = "confirmed" | "probable" | "unresolved";

export interface TermCard {
  /**
   * カードの不変の識別子(#38)。サーバーがセッション内の通番(`c1`, `c2`, …)で採番する。
   *
   * **`term` は識別子ではない。** `card_update` の突き合わせ・クライアントの主キー・
   * DOM 参照はすべてこちらを使い、`term` は「意味上の同一性」(デデュープ)だけに使う。
   *
   * 採番は WS 1本ごとに 1 から振り直しになる。クライアントは受信 ID を自分のローカル ID へ
   * 写像して持つので、再接続で同じ用語が別 ID で再送されても写像を貼り替えるだけで済む。
   */
  cardId: string;
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

/**
 * 再評価でカードを改名するときの新しい表示内容(#40)。
 *
 * **`cardId` は入っていない。** カードの識別子は不変(#38)で、改名しても動かない —
 * ここに入れると「改名で ID が変わる」経路を型が許してしまう。
 */
export interface CardRename {
  term: string;
  reading: string;
  correctedFrom: string | null;
  /**
   * 改名後のカードが持つ表記(ハイライト用)。
   *
   * **unresolved のときに聞き取られていた表記をそのまま引き継ぐ。** 文字起こし本文は
   * 崩れた表記のまま残る(#40 は raw transcript を書き換えない)ので、ここを新しい表記に
   * 置き換えると**過去の行からカードへ辿れなくなる**。
   */
  surfaceForms: string[];
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
  //
  // **更新対象は `cardId` で指定する**(#38)。以前は `term` を主キーにしていたが、
  // 同じ term のカードが2枚あると区別できず、term を後編集する余地も無かった。
  | {
      type: "card_update";
      cardId: string;
      status: TermStatus;
      description: string;
      links: TermLink[];
      /**
       * 再評価による改名(#40)。**この入れ子が在るときだけ**クライアントは
       * `unresolved` からの昇格を許す(`public/card-status.js` の `mergeCardUpdate()`)。
       *
       * **boolean フラグ + 平置きの `term` にしていない。** それだと「フラグは立って
       * いるが term が無い」という矛盾した組を型として書けてしまう。入れ子にすれば
       * 「昇格の許可」と「新しい表示内容」が1つの存在で結ばれ、片方だけ届く形が作れない。
       *
       * **既存の3経路(裏付けあり / 棄却 / 例外フォールバック)は付けない。**
       * 付けないかぎり挙動は #24 のままで、この Issue 以前と1ビットも変わらない。
       */
      rename?: CardRename;
    }
  | { type: "status"; state: "stt_connecting" | "stt_open" | "stt_closed" | "extracting" }
  | {
      type: "error";
      code: "auth_failed" | "stt_error" | "llm_error" | "bad_request";
      message: string;
      /** 恒久エラーで抽出を打ち切ったときだけ true。クライアントはこれが真の時だけ消えないバナーを出す(#10) */
      permanent?: boolean;
    };
