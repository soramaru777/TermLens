// 用語カードの「状態」と「見出し」の導出(#24)。
//
// **app.js から切り出してあるのは、Node のテストから読めるようにするため**
// （`public/lowpass.js` を切り出したのと同じ理由）。app.js はモジュール評価の時点で
// `document.getElementById` を呼ぶので、テストからは import できない。ここに置けば
// 描画を伴わない純関数として決定的テストで固定できる。
//
// **この2つが唯一の定義箇所。** 描画（addCard / updateCard）と Markdown エクスポートの
// 両方がここだけを見る。片方が `card.status` を直接読むと、localStorage から復元した
// 古いカード（status を持たない）でその経路だけ表示が変わる。

/** `status: "unresolved"` のカードに付く見出しの注記。Markdown とバッジで文言を揃える */
export const UNRESOLVED_LABEL = "用語を特定できませんでした";

/**
 * カードの状態を返す。
 *
 * **#24 以前に localStorage へ保存されたカードは `status` を持たない。** 保存の有効期限
 * （`SESSION_MAX_AGE_MS`）の内側にある既存セッションを壊さないよう、その場合だけ
 * 旧 `confidence` から導出する（`low` → `probable`、それ以外 → `confirmed`）。
 *
 * 導出をここに閉じておくのが要点で、呼び出し側に `card.status ?? ...` を書き散らすと
 * 必ず片方が漏れる。
 */
const STATUSES = ["confirmed", "probable", "unresolved"];

export function cardStatus(card) {
  // **必ず3値のどれかに丸める。** 戻り値はそのまま `classList.add()` に渡るので、
  // 復元した localStorage が壊れて空白入りの文字列だと DOMException になり、
  // 復元の catch がセッションを丸ごと消してしまう。信頼境界の外から来る値を
  // ここで無害化しておく（導出が1箇所に閉じている利点はここでも効く）。
  if (STATUSES.includes(card.status)) return card.status;
  if (card.status) return "confirmed";
  return card.confidence === "low" ? "probable" : "confirmed";
}

/**
 * カードの見出しに出す文字列を返す。
 *
 * `unresolved` のときだけ **推定した term ではなく、音声認識が実際に聞き取った表記**を
 * 見出しにする。特定できていない用語名を見せる意味がないため。
 * `term` は DOM の `dataset.term` とデデュープのキーとして**そのまま残る**
 * （`card_update` は term で突き合わせるので、改名すると更新が届かなくなる）。
 *
 * 優先順は surfaceForms[0] → correctedFrom → term。surfaceForms は
 * `filterSurfaceForms()` が「文字起こしに実在する表記」だけに絞った後のものなので、
 * 会議で実際に聞こえた表記に最も近い。空配列で来ることがあるので後ろ2つが要る。
 */
export function cardHeading(card) {
  if (cardStatus(card) !== "unresolved") return card.term;
  return (card.surfaceForms ?? [])[0] ?? card.correctedFrom ?? card.term;
}

/**
 * `card_update` を表示中のカードへ畳み込む（#24）。
 *
 * **`unresolved` からは戻さない。** 再接続でカードが再抽出されると同じ用語が再び
 * Stage 2 に回りうるので、昇格を許すと「特定できませんでした」が通常カードに戻り、
 * 見出しが surface form から term へ切り替わる。
 *
 * **状態を据え置くなら解説とリンクも据え置く。** 本文だけ更新すると「特定できませんでした」
 * の見出しの下に**確定した別用語の断定的な解説**が出て、この Issue が防ごうとした形
 * そのものになる（リンクは画面には出ないが Markdown エクスポートには出る）。
 * **サーバーが unresolved を検証に回さなくなっても、この経路は現行サーバーでも来る。**
 * 再接続で `shownTerms` が `SHOWN_TERMS_LIMIT`(50) に切り詰められ、同じ用語が再抽出されると
 * サーバーから見たその用語は `probable` なので Stage 2 に回り、`card_update{confirmed}` が
 * 届く。クライアントにはまだ降格済みのカードが残っている。多層防御ではなく本線のガード。
 *
 * 純関数として切り出してあるのは、この不変条件が **DOM を触らずに固定できる**ため。
 *
 * @returns 更新後のカード（引数は変更しない）
 */
export function mergeCardUpdate(stored, update) {
  if (cardStatus(stored) === "unresolved") return { ...stored };
  return {
    ...stored,
    description: update.description,
    links: update.links,
    // status が無いメッセージ（旧サーバー）で状態を巻き戻さない。undefined を書き込むと
    // cardStatus() が confirmed に倒れ、probable のカードが黙って格上げされてしまう。
    ...(update.status ? { status: update.status } : {}),
  };
}

/**
 * 再送された速報カード（`cards`）を表示中のカードへ畳み込むか判断する（#24）。
 *
 * 再接続直後はサーバー側のデデュープ状態が空から始まるため、既出用語が再びカードとして
 * 届きうる（#8 で冪等化した経路）。
 *
 * **据え置く条件は2つ。**
 * - 清書済み（`links` がある）: ドラフトで上書きしない（#8 からの既存の判断）
 * - `unresolved`: 検証で降格した判断を、再抽出の速報で上書きしない（#24）
 *
 * `status` だけ守って `description` を通すと「特定できませんでした」の見出しの下に
 * **断定的な解説**が出る。`mergeCardUpdate()` に入れたのと同じガードで、
 * **降格したカードへ更新が届く経路が2つある以上、両方に要る**。
 */
export function shouldApplyResend(existing) {
  if (existing.links?.length) return false;
  return cardStatus(existing) !== "unresolved";
}
