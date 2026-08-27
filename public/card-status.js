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
