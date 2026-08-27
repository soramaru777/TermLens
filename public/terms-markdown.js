// 用語カードの Markdown エクスポート。
//
// **app.js から切り出してあるのは、Node のテストから読めるようにするため**
// （`card-status.js` / `lowpass.js` と同じ理由）。app.js はモジュール評価の時点で
// `document.getElementById` を呼ぶのでテストから import できない。
//
// AC「Markdown エクスポートにも状態が残る」は決定的に検証できる性質なので、
// 描画から切り離して固定しておく（DOM 側と違いブラウザが要らない）。

import { cardHeading, cardStatus, UNRESOLVED_LABEL } from "./card-status.js";

// Markdown の記号が含まれても記法として解釈されないようにする。
export const escMd = (s) => String(s ?? "").replace(/([\\`*_[\]<>#])/g, "\\$1");
// 括弧や空白を含む URL は `<...>` で囲まないとリンクが途中で切れる。
export const mdUrl = (u) => (/[()\s]/.test(u) ? `<${u}>` : u);

// http/https 以外のスキームを弾く(サーバー側 src/extract/enrich.ts の isHttpUrl と同じ検証)。
// 復元経路では links が localStorage 由来になり信頼境界が一段緩いため、描画と同じ検証を
// エクスポートでも通す(M5)。
export function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 用語カードを Markdown に整形する。
 *
 * 見出しと状態の導出は**画面と同じ `cardStatus()` / `cardHeading()` を通す**(#24)。
 * ここで `card.status` を直接読むと、復元した旧カード（status を持たない）のときだけ
 * エクスポートの見出しが画面と食い違う。
 *
 * @param cards 表示順のカード配列
 * @param heading 見出しに入れる日時文字列
 */
export function buildTermsMarkdown(cards, heading) {
  const out = [
    `# 用語カード ${heading}`,
    "",
    `- 件数: ${cards.length}`,
    "",
    "> TermLens が会話から自動抽出した用語です。解説は生成AIによるもので、誤りを含む場合があります。",
    "> 登場順に並んでいます。",
    "",
    "---",
    "",
  ];
  for (const card of cards) {
    const status = cardStatus(card);
    const title = cardHeading(card);
    // unresolved は読みを出さない（特定できなかった用語の読みなので）。画面と揃える
    const reading = status !== "unresolved" && card.reading ? `（${escMd(card.reading)}）` : "";
    const note =
      status === "probable" ? " ※要確認" : status === "unresolved" ? ` ※${UNRESOLVED_LABEL}` : "";
    out.push(`## ${escMd(title)}${reading}${note}`, "");
    // 見出しが既に元の表記（unresolved の場合）なら重複して出さない
    if (card.correctedFrom && card.correctedFrom !== title) {
      out.push(`> 音声認識では「${escMd(card.correctedFrom)}」と聞き取られた語です。`, "");
    }
    if (card.description) out.push(escMd(card.description), "");
    const validLinks = (card.links ?? []).filter((link) => isHttpUrl(link.url));
    if (validLinks.length) {
      out.push("**関連リンク**", "");
      for (const link of validLinks) out.push(`- [${escMd(link.title)}](${mdUrl(link.url)})`);
      out.push("");
    }
  }
  return out.join("\n");
}
