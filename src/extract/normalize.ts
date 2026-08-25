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
