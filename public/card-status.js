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
 * `term` はデデュープのキーとして**そのまま残る**（識別は #38 で `cardId` に移ったので、
 * 見出しが変わってもカードの identity は動かない）。
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
  // **`rename` を伴う更新だけが unresolved から戻せる（#40）。** 後続の会話で確定した
  // 用語を手がかりに web 検証をやり直し、裏付けが取れたときだけサーバーが付けてくる。
  // #24 のガードは素の `card_update` に対してそのまま残す — 「解説だけ差し替えると
  // 見出しと本文が食い違う」という理由は、term が同時に来ないかぎり消えない。
  if (cardStatus(stored) === "unresolved" && !update.rename) return { ...stored };
  // 改名の中身（term / reading / correctedFrom / surfaceForms）は入れ子ごと展開する。
  // 平置きのフラグ + term にすると「フラグは立つが term が無い」組が作れてしまう
  const renamed = update.rename ? { ...update.rename } : {};
  return {
    ...stored,
    ...renamed,
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

/**
 * カードに載せるリンクの上限。サーバー側 `src/extract/enrich.ts` の `MAX_LINKS` と同値。
 *
 * 統合で2枚ぶんのリンクを連結すると上限を超えうるので、クライアント側にも同じ数が要る。
 */
export const MAX_LINKS = 3;

/**
 * 改名で同じ用語になった2枚のカードを1枚に統合する（#40）。
 *
 * **安易に Map の上書きで片方を消さない。** 消える側にしか無い surfaceForms と links が
 * 黙って失われると、**過去の行からカードへ辿れなくなる**（ハイライトは表記から引く）。
 *
 * 決めるのは3つだけ。
 * - `cardId` … 残す側のもの。呼び出し側が「登場順が早いほう」を `keep` に渡す（#38 の
 *   目的は ID の永続性で、人が固定しているかもしれないカードを消さないため）
 * - `surfaceForms` … 残す側 → 消す側の順で連結して重複除去。登場順を保つ
 * - `links` … 残す側を優先し、足りない分を消す側から補って `MAX_LINKS` で切る。
 *   空配列で上書きして情報を失わないため
 *
 * **`term` / `reading` / `status` / `description` / `correctedFrom` はここでは決めない。**
 * 「再評価の結果を正とする」のは呼び出し側の判断で、`keep` に反映させてから渡すこと
 * （残す cardId と、内容の出どころは別物 — 先に登場したカードの ID を残しつつ、
 * 中身は web 検証を通ったほうを採る組み合わせがありうる）。
 *
 * 純関数として `card-status.js` に置いてあるのは、統合ルールを **DOM 抜きで固定できる**
 * ため（`mergeCardUpdate()` と同じ理由）。
 *
 * @returns 統合後のカード（引数はどちらも変更しない）
 */
export function mergeDuplicateCards(keep, drop) {
  const surfaceForms = [];
  const seenForm = new Set();
  for (const form of [...(keep.surfaceForms ?? []), ...(drop.surfaceForms ?? [])]) {
    // 突き合わせは小文字化した表記。ハイライトのキー（highlightOwner）と同じ土俵に
    // 揃えておかないと、大文字違いの同じ表記が2つ残って正規表現が無駄に太る
    const key = String(form ?? "").trim().toLowerCase();
    if (!key || seenForm.has(key)) continue;
    seenForm.add(key);
    surfaceForms.push(form);
  }

  const links = [];
  const seenUrl = new Set();
  for (const link of [...(keep.links ?? []), ...(drop.links ?? [])]) {
    if (links.length >= MAX_LINKS) break;
    if (!link?.url || seenUrl.has(link.url)) continue;
    seenUrl.add(link.url);
    links.push(link);
  }

  // `drop` を土台に `keep` で上書きする。残す側に無いフィールド（復元した古いカードには
  // 欠けていることがある）だけが消える側から埋まり、両方にあるものは必ず残す側が勝つ
  return { ...drop, ...keep, surfaceForms, links };
}
