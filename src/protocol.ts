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

/**
 * 用語カードの表示優先度(#44)。**この会話を理解するために、ユーザーが今見る価値**を表す。
 *
 * **`rarity` とは別軸で、独立に判定する。** `rarity` は用語そのものの一般性・希少性で、
 * Stage 2 の検証対象選定(`selectVerifyTargets`)に使われている既存の軸。兼用すると
 * 「web 検証の優先度」と「UI の表示優先度」が混ざり、片方を動かすともう片方が
 * 黙って変わる。`rarity=common, importance=high`(平易だが会話の主題)も
 * `rarity=rare, importance=low`(珍しいが脇役)も許す。
 *
 * - `high`   — 主題・意思決定の理解に重要。専門技術/製品/規格/役割名、繰り返し参照される中心概念
 * - `medium` — 理解に役立つが主題の中核ではない
 * - `low`    — 日常語・一般的なビジネス語に近く、説明を読んでも新しい情報がほとんど増えない
 *
 * `low` は**削除せず**「その他の用語」へ折りたたむ(`public/app.js`)。情報を失わずに
 * UI のノイズだけを減らすのが狙いなので、Markdown エクスポートと保存には全カードが残る。
 *
 * **`status` とも別軸。** `status` は「正しく用語を特定できたか」で、`importance` は
 * 特定できたかに関係なく「この会話で見る価値が高いか」。`status=unresolved` かつ
 * `importance=high`(本当に重要そうだが、まだ特定できていない)を埋もれさせないため。
 */
export type TermImportance = "high" | "medium" | "low";

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
  /**
   * 表示優先度(#44)。`low` は「その他の用語」へ折りたたまれる。
   *
   * **`card_update` には載せない。** importance の再評価は #44 の非スコープで、
   * 載せると「解説の更新で表示優先度が変わる」経路を型が許してしまう。
   */
  importance: TermImportance;
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
 *
 * **`importance` も入れない(#44)。** `mergeCardUpdate()` は `{ ...stored, ...renamed }`
 * なので、ここに無いかぎり改名しても元の importance が必ず生き残る。
 * **入れないこと自体が「rename で importance を失わない」の実装**であって、
 * 別途ガードを書いて守るものではない。
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
  | {
      type: "transcript";
      text: string;
      isFinal: boolean;
      speaker: number | null;
      finalSeq?: number;
      /**
       * このイベントの word 数(#46)。**整数1つだけ**載せる。
       *
       * `words` 配列そのものは載せない(WS ペイロードが約13倍になり、
       * `localStorage` の復元が静かに劣化するという #19 の判断は崩さない。
       * 理由は `src/stt/types.ts` の `TranscriptEvent.words` のコメント)。
       * クライアントはこれを話者ごとの word 数の集計にだけ使うので、
       * 必要なのは件数であって語そのものではない。
       *
       * interim には付かない(分割せず、話者統計の対象でもないため)。
       * **旧サーバー互換のため optional** — 無い場合クライアントは割合の分母を
       * 文字数へフォールバックし、どちらで計算したかを診断に明記する。
       */
      wordCount?: number;
    }
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
  /**
   * STT 側のモデル情報(#46)。話者分離の診断で「どの diarizer が動いていたか」を
   * 記録するために送る。値が変わったときだけ届く(毎 Results 送っても中身は同じ)。
   *
   * **`request_id` は載せない。** 会話本文でも音声でもないが、**そのセッションを
   * 一意に指す値**であり、診断ファイルは実機比較の結果として共有されうる。
   * `public/diagnostics.js` の `TRACK_KEYS`(採用リスト)と同じ思想で、
   * 診断に要るものだけを明示的に通す — Deepgram が metadata にキーを増やしても、
   * ここへ書き足さない限り外へ出ない。
   */
  | {
      type: "stt_info";
      model?: { name?: string; version?: string; arch?: string };
      /** diarizer が動いたときだけ入る。取れなければキーごと落とす */
      diarizer?: { arch?: string; modelUuid?: string };
    }
  /**
   * STT テキスト完全性のセッション累計(#52)。**final 1件ごとに届く**(累計なので
   * クライアントは上書きするだけでよい)。
   *
   * **スロットルを入れていない。** 数値10個ほどのペイロードで、載せないと判断した
   * `words` 配列(#19 で約13倍)とは桁が違う。間引くと「いつの時点の累計か」を持つ状態が
   * 増えるだけで、読める事実は増えない。
   *
   * **会話本文は1文字も入らない。** 出るのは件数・文字数・差分・timing だけで、
   * **本文を復元しうる hash も入れない**(短い発話は総当たりで復元されうる)。
   * `IntegritySnapshot` にフィールドが増えても、この型と `session.ts` の両方へ
   * 書き足さない限り外へ出ない(`stt_info` と同じ2層の採用リスト)。
   *
   * 判定に使うのは**空白を除いた文字数**(`rawVisible` / `splitVisible`)。話者分割は
   * 切り出しに `.trim()` を掛け、フォールバックは `join("")` で語間の空白を落とすので、
   * **正常に動いていても素の文字数は減る**(`src/stt/split.ts` の `visibleChars()`)。
   */
  | {
      type: "text_integrity";
      /** final の総数(transcript が空の Results は数えない) */
      finals: number;
      /** そのうち話者で分割された数 */
      splitFinals: number;
      /** ① Deepgram final の文字数の累計 */
      rawChars: number;
      rawVisible: number;
      /** ② 話者分割後に発行したイベントの文字数の累計 */
      splitChars: number;
      splitVisible: number;
      /** 切り出しに失敗して連結へフォールバックした回数 */
      fallbacks: number;
      /** 空で捨てられたセグメント数 */
      droppedEvents: number;
      /** そのうち先頭セグメントだったもの(＝発話の頭が丸ごと消えた回数) */
      headDrops: number;
    }
  | {
      type: "error";
      code: "auth_failed" | "stt_error" | "llm_error" | "bad_request";
      message: string;
      /** 恒久エラーで抽出を打ち切ったときだけ true。クライアントはこれが真の時だけ消えないバナーを出す(#10) */
      permanent?: boolean;
    };
