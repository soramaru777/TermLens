/**
 * 用語の正規化。**依存ゼロで保つこと。**
 *
 * scheduler.ts に置いていたが、あちらは extractor / enrich 経由でモジュール読み込み時に
 * `new OpenAI()` を評価するため、純粋な文字列関数を使いたいだけのテストや評価ハーネスまで
 * API キーを要求してしまっていた。ここに切り出して import の副作用を断つ。
 */

/** デデュープ用の正規化キー。NFKC で全角/半角を揃え、小文字化し、空白を落とす。 */
export function normalizeTerm(term: string): string {
  return term.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 語の区切り。NFKC で全角記号は半角へ寄るので、残るのは日本語の区切り記号だけ。 */
const WORD_SEPARATOR = /[\s・、。,.:;!?/\\|_()[\]{}「」『』〈〉《》"'`\-—–]+/;

/**
 * スクリプトが変わる位置に区切りを差し込む(`Zoom株式会社` → `Zoom 株式会社`)。
 *
 * ラテン文字と日本語の間には区切り記号が入らないことが多く、そのままでは複合語が
 * 1語に潰れる。camelCase も同じ理由で割る。
 *
 * **カタカナ↔漢字は割らない。** 「ベクトル検索」のような語まで分解すると、
 * 語としての完全一致が細切れの断片に当たるようになり、境界を見る意味が無くなる。
 */
function withScriptBreaks(text: string): string {
  return text
    .replace(/([A-Za-z0-9])([\u3040-\u30ff\u4e00-\u9fff])/g, "$1 $2")
    .replace(/([\u3040-\u30ff\u4e00-\u9fff])([A-Za-z0-9])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * 表記を語に割り、元の表記(NFKC 後)と正規化キーの対で返す。
 *
 * **`normalizeTerm()` と対で使う「キー化」の語彙。** あちらは空白を落とすので、
 * 文字列全体をキーにすると**語の境界が消える** — 用語集の突き合わせで実際に踏んだ穴で、
 * `Kengo Yamada` が1本の `kengoyamada` に潰れて候補 `Go` が当たっていた(#25)。
 * 境界を意識した突き合わせが要るところは、全体のキーではなくこちらを使うこと。
 */
export function splitWords(text: string): Array<{ raw: string; key: string }> {
  return withScriptBreaks(text.normalize("NFKC"))
    .split(WORD_SEPARATOR)
    .map((raw) => ({ raw, key: normalizeTerm(raw) }))
    .filter((w) => w.key.length > 0);
}
