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

/**
 * 読み注記だけを剥がした比較用のキーを返す(#42)。**入力は `normalizeTerm()` 済みの文字列**。
 *
 * 剥がすのは末尾の `(読み: …)` に限る。**一般の括弧は削らない** — 正式名称に括弧を含む
 * 用語(`AB(旧称)` のような表記)まで壊れ、別用語へ当たる経路ができてしまう。
 *
 * **`normalizeTerm()` を先に通す前提にしてあるのは、パターンを1本で済ませるため。**
 * NFKC が全角括弧・全角コロンを半角へ寄せ、空白も落ちるので、
 * `AB（読み：エービー）` も `AB (読み: エービー)` も `ab(読み:エービー)` の一形に潰れる。
 * 生の文字列に当てようとすると、括弧の種類とコロンの全半角と空白の有無の組み合わせを
 * 数え上げることになり、**数え漏らした表記だけが静かに候補外へ落ちる**。
 */
export function stripReadingNote(key: string): string {
  return key.replace(/\((?:読み|よみ|ヨミ):?[^()]*\)$/, "");
}

/**
 * 検証段が返した `chosen` を候補へ突き合わせる(#42)。一致した候補をそのまま返す。
 *
 * **候補制約(#23)を緩める関数ではない。** 候補集合の外から新しい用語を採る経路は
 * 増やしていない。同じ用語に装飾が付いただけの表記を候補へ寄せるだけで、
 * 別用語は従来どおり `null`(= `out-of-candidates`)に倒れる。
 *
 * 判定は3段:
 *   1. 完全一致
 *   2. `normalizeTerm()` 一致(#42 以前の判定そのもの)
 *   3. **`chosen` 側だけ**読み注記を剥がしての `normalizeTerm()` 一致
 *
 * **候補側は `normalizeTerm()` しか通さない。** 3段目で候補側も剥がすと、正式名称に
 * 括弧を含む候補が別用語へ当たりうる。候補側を無加工にしておけば、そういう候補は
 * 1段目か2段目で当たるか、当たらないなら別用語として棄却されるかの二択になり、
 * **「正式名称の括弧を壊す」経路が構造上生まれない**。
 *
 * 3段目が要るのは、候補一覧を `AB(読み: エービー)` の形でプロンプトへ描画していたため
 * (`buildVerifyInput()`)。モデルは「候補として与えられた表記」を忠実に返しているのに、
 * 受け側だけが `term` と一致する前提で比べていた。描画は #42 で分離したが、
 * それだけではモデルの出力を保証できないので、こちらは多層防御として残す。
 */
export function matchCandidate<T extends { term: string }>(
  chosen: string,
  candidates: readonly T[],
): T | null {
  const exact = candidates.find((c) => c.term === chosen);
  if (exact) return exact;

  const key = normalizeTerm(chosen);
  const normalized = candidates.find((c) => normalizeTerm(c.term) === key);
  if (normalized) return normalized;

  const stripped = stripReadingNote(key);
  // 剥がせなかった(= 読み注記が無い)なら2段目と同じ判定になるので、そこで打ち切る。
  // 空になるのは `chosen` が注記だけだったとき。用語名が無いので候補には当てない。
  if (stripped === key || stripped === "") return null;
  return candidates.find((c) => normalizeTerm(c.term) === stripped) ?? null;
}
