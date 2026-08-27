import { splitWords } from "./normalize.js";
import type { Candidate } from "./schema.js";

/**
 * 用語集から**候補と関係のある語だけ**を抜き出す(#25、AC2)。**依存ゼロで保つこと。**
 *
 * **参加者の氏名を web 検索へ送らないためのモジュール。** 用語集は「参加者名・社名・
 * 専門用語」を含む設計(`ROLE_PROMPT` 規則4)で、web 検索は**外部サービスへの送信**に
 * あたる。Issue 本文も「glossary由来の関連語(**必要最小限**)」としており、全件は渡さない。
 * 文字起こし本文をログにすら出さない方針(#23)と一貫させる。
 *
 * **これは1経路の多層防御であって、氏名が外部へ出ない保証ではない。** 会議で読み上げられた
 * 氏名は `context`(文字起こし抜粋)経由で同じリクエストに載る。用語集そのものは STT の
 * keyterm(`session.ts`)と抽出プロンプト(`extractor.ts`)にも全件が渡っている。ここが
 * 閉じているのは「検証段へ用語集が丸ごと流れ込む」経路だけ。
 */

/**
 * 検証の入力に混ぜる用語集の語数の上限(#25、AC2)。
 *
 * 判断材料としては数語あれば足りる。増やすほど外へ出る語が増える一方なので、
 * 迷ったら小さく取る。
 */
export const MAX_GLOSSARY_HINTS = 5;

/**
 * 用語集を語に割った索引。**会議ごとに1度だけ作る。**
 *
 * 用語集はセッションの間ずっと変わらないのに、カードごとに割り直すと
 * `normalize()` と正規表現 split が用語集の件数ぶん毎回走る(100語で1カードあたり
 * `normalize()` が400回超)。このファイルの `VERIFY_FORMAT` や `LinkCandidate.rank` と
 * 同じ扱いに揃える。
 *
 * **`ExtractionScheduler` のフィールドとして持つこと。** モジュールレベルのキャッシュに
 * すると、会議が終わっても各セッションの用語集(＝参加者の氏名・社名)を掴んだままになる。
 */
export type GlossaryIndex = ReadonlyArray<ReadonlyArray<{ raw: string; key: string }>>;

export function buildGlossaryIndex(glossary: string[]): GlossaryIndex {
  return glossary.map((entry) => splitWords(entry));
}

/**
 * 候補と**語として一致した用語集の語**を返す。最大 `limit` 件。
 *
 * **一致するのは語単位の完全一致だけ。** 文字列全体の部分一致にすると
 * `normalizeTerm()` が空白を落とすぶんエントリが1本に潰れて語の境界が消え、
 * 短い候補がローマ字の氏名を端から引き当てる(`Go` → `Kengo Yamada`)。
 * 区切り記号の無い複合語は `splitWords()` がスクリプトの変わり目で割るので、
 * `Zoom株式会社` も `Zoom` で当たる — **文字数の閾値は要らない**。
 *
 * **返すのは当たった語だけで、エントリ全体ではない。** 「Qdrant 山田」のような1エントリを
 * まるごと返すと、`Qdrant` で当たって氏名ごと外へ出る。修飾語(`Qdrant Cloud` の `Cloud`)も
 * 一緒に落ちるが、ヒントの役目は「この語がこの会議で実際に使われている」と伝えることなので
 * それで足りる。**取りこぼしは判断材料が1つ減るだけ、氏名が外へ出るのは取り返しがつかない。**
 *
 * **候補の `reading` は見ない。** 入力を1つ増やせばそのぶん当たる面積が増える。
 */
export function relatedGlossary(
  index: GlossaryIndex,
  candidates: Candidate[],
  limit = MAX_GLOSSARY_HINTS,
): string[] {
  const keys = new Set(candidates.flatMap((c) => splitWords(c.term).map((w) => w.key)));
  if (keys.size === 0) return [];

  const picked: string[] = [];
  const seen = new Set<string>();
  for (const words of index) {
    for (const word of words) {
      if (picked.length >= limit) return picked;
      if (!keys.has(word.key) || seen.has(word.key)) continue;
      seen.add(word.key);
      picked.push(word.raw);
    }
  }
  return picked;
}
