import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGlossaryIndex,
  MAX_GLOSSARY_HINTS,
  relatedGlossary,
} from "../src/extract/glossary.js";
import { candidate } from "./helpers/cards.js";

/**
 * `relatedGlossary()`（#25、AC2）。
 *
 * **このテストが守っているのはプライバシーの線引きそのもの。** 用語集は「参加者名・社名・
 * 専門用語」を含む設計（`ROLE_PROMPT` 規則4）で、検証は **web 検索という外部サービスへの
 * 送信**を伴う。全件渡すと会議参加者の氏名が検索クエリの材料になるので、候補と語として
 * 一致した語だけに絞る。文字起こし本文をログにすら出さない方針（#23）と一貫させる。
 *
 * **期待値には「絞られる側の実データ形」を必ず入れること。** 最初の実装では合成データが
 * 日本語の氏名だけで、10本あっても**ローマ字の氏名に当たる穴を1本も検出できなかった**
 * （`Go` → `Kengo Yamada`）。実在の人物・企業は使わない。
 */

/** 用語集の1行ぶんを索引にする。索引は会議ごとに1度だけ作る前提の型。 */
function pick(glossary: string[], terms: string[], limit?: number): string[] {
  return relatedGlossary(
    buildGlossaryIndex(glossary),
    terms.map((t) => candidate(t)),
    limit,
  );
}

/** 参加者名・社名を模した合成データ。**1件も出てはいけない側**の期待値。 */
const PRIVATE_ENTRIES = ["山田太郎", "佐藤花子", "株式会社テスト工業", "テスト商事"];

test("候補と関係のない語（参加者名・社名）は1件も返さない", () => {
  assert.deepEqual(
    pick(PRIVATE_ENTRIES, ["Qdrant", "Kubernetes"]),
    [],
    "用語集を素通しにすると氏名が web 検索へ乗る",
  );
});

/**
 * **短い候補がローマ字の氏名を引き当てない。**
 *
 * 文字列全体の部分一致だと `normalizeTerm()` が空白を落とすぶんエントリが1本に潰れ、
 * **語の境界が消える**。`Go` が `kengoyamada` に、`AI` が `aikotanaka` に当たっていた。
 * 読みを突き合わせから外しても `term` 側で同じことが起きるので、直すべきは入力ではなく
 * **突き合わせの機構**だった。
 */
test("短い候補はローマ字の氏名に当たらない（語として一致するものだけ）", () => {
  const names = ["Kengo Yamada", "Shingo Sato", "Aiko Tanaka", "Ken Sasaki", "Yui Kobayashi"];
  for (const term of ["Go", "AI", "UI", "SAS"]) {
    assert.deepEqual(pick(names, [term]), [], `「${term}」が氏名の一部に当たっている`);
  }
  // 語頭一致を許すと通ってしまう長さの氏名も落ちること（文字数の閾値では塞げない）
  assert.deepEqual(pick(["Kenshin Yamada"], ["Kens"]), [], "4文字でも語の一部には当たらない");
});

test("候補の term でも社名の一部には当たらない（読みを外しただけでは塞がらない）", () => {
  assert.deepEqual(pick(["株式会社テスト工業", "テスト商事"], ["テスト"]), []);
});

/**
 * **返すのは当たった語だけ。** エントリ全体を返すと、`Qdrant` で当たった1行に書かれた
 * 氏名まで一緒に外へ出る。用語集は利用者が自由記述で書く欄なので `製品名 担当者` の形は
 * 現実的で、語数の多寡で安全側を判断することはできない。
 */
test("当たった語だけを返す（同じ行の他の語を巻き込まない）", () => {
  assert.deepEqual(pick(["Qdrant 担当 山田太郎"], ["Qdrant"]), ["Qdrant"]);
  assert.deepEqual(pick(["Qdrant 山田"], ["Qdrant"]), ["Qdrant"], "2語でも巻き込まない");
  assert.deepEqual(pick(["Qdrant Cloud"], ["Qdrant"]), ["Qdrant"], "修飾語も落ちる（安全側）");
});

test("区切り記号の無い複合語も語として割る", () => {
  // スクリプトの変わり目で割らないと `Zoom株式会社` が1語に潰れ、完全一致では拾えない
  assert.deepEqual(pick(["Zoom株式会社"], ["Zoom"]), ["Zoom"]);
  assert.deepEqual(pick(["QdrantCloud"], ["Qdrant"]), ["Qdrant"], "camelCase も割る");
  assert.deepEqual(pick(["IT本部"], ["IT"]), ["IT"]);
});

test("突き合わせは正規化キーで行う（全角・大文字小文字を吸収）", () => {
  // 返るのは NFKC を通した後の表記（索引が持っているのは分割後の語）
  assert.deepEqual(pick(["ＱＤＲＡＮＴ クラウド"], ["qdrant"]), ["QDRANT"]);
  // 全角の括弧・空白・ハイフンも区切りとして働く
  assert.deepEqual(pick(["Qdrant（ベクトルDB）担当　山田太郎"], ["Qdrant"]), ["Qdrant"]);
});

test("候補が用語集の語を含む場合も拾う", () => {
  // 「Argo CD」→「Argo」。候補側も語に割るので、どちらが長くても語として一致する
  assert.deepEqual(pick(["Argo"], ["Argo CD"]), ["Argo"]);
});

test("候補の読みは突き合わせに使わない（社名・氏名を引き寄せるため）", () => {
  const index = buildGlossaryIndex(["株式会社テスト工業", "テスト商事"]);
  const withReading = [{ term: "Kubernetes", reading: "テスト", rationale: "音韻が近い" }];
  assert.deepEqual(relatedGlossary(index, withReading), [], "読みで社名を巻き込まない");
});

test("空文字・空白だけの語は落とす", () => {
  assert.deepEqual(pick(["", "   "], ["Qdrant"]), []);
  assert.deepEqual(pick(["山田太郎"], [""]), [], "候補側が空でも同じ");
});

test("件数は MAX_GLOSSARY_HINTS で切る", () => {
  const many = Array.from({ length: MAX_GLOSSARY_HINTS + 3 }, (_, i) => `Qdrant${i}`);
  const picked = pick(many, many);
  assert.equal(picked.length, MAX_GLOSSARY_HINTS);
  assert.deepEqual(picked, many.slice(0, MAX_GLOSSARY_HINTS), "用語集の順序のまま前から採る");
  assert.equal(pick(many, many, 2).length, 2, "limit は上書きできる");
});

test("正規化キーが同じ語は畳む", () => {
  assert.deepEqual(pick(["Qdrant", "qdrant", "ＱＤＲＡＮＴ"], ["Qdrant"]), ["Qdrant"]);
});

test("用語集も候補も空なら空", () => {
  assert.deepEqual(pick([], ["Qdrant"]), []);
  assert.deepEqual(pick(["Qdrant Cloud"], []), []);
});
