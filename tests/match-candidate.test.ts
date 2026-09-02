import assert from "node:assert/strict";
import test from "node:test";
import { matchCandidate, stripReadingNote } from "../src/extract/normalize.js";

/**
 * 検証段の候補一致(#42)。
 *
 * 直したのは**プロンプトとパーサの契約のズレ**。候補一覧を `AB(読み: エービー)` の形で
 * 描画しておきながら、受け側は `term` と一致する前提で比べていたので、
 * 「候補として与えられた表記をそのまま入れた」だけの応答が候補外に落ちていた。
 *
 * 通したい表記だけを通し、**別用語は従来どおり落とす**ことがこのテストの主眼。
 * 「候補外を採らない」(#23)は緩めていない。
 */

// 実会話の用語は使わない。匿名化した合成データで固定する。
const AB = { term: "AB", reading: "エービー" };
const ABC = { term: "ABC", reading: "エービーシー" };
const DOMAIN = { term: "ドメイン知識", reading: "ドメインチシキ" };
const CANDIDATES = [AB, ABC, DOMAIN];

test("読み注記付きの同一用語は候補と一致する", () => {
  assert.equal(matchCandidate("AB(読み: エービー)", CANDIDATES), AB);
});

test("全角括弧・全角コロンの読み注記も一致する", () => {
  // NFKC が半角へ寄せるので、パターンを増やさずに当たる
  assert.equal(matchCandidate("AB（読み：エービー）", CANDIDATES), AB);
});

test("前後の空白差では落ちない", () => {
  assert.equal(matchCandidate("  AB (読み: エービー)  ", CANDIDATES), AB);
});

test("「よみ」「ヨミ」表記の注記も剥がせる", () => {
  assert.equal(matchCandidate("AB(よみ: エービー)", CANDIDATES), AB);
  assert.equal(matchCandidate("AB(ヨミ: エービー)", CANDIDATES), AB);
});

test("一致したら候補側の canonical な term を持つオブジェクトが返る", () => {
  const matched = matchCandidate("ａｂ（読み：エービー）", CANDIDATES);
  // モデルが返した装飾付き・全角の表記ではなく、候補配列の要素そのもの。
  // ここを取り違えると表示・デデュープ・評価指標へ表記差が漏れる。
  assert.equal(matched, AB);
  assert.equal(matched?.term, "AB");
});

test("装飾の無い完全一致・正規化一致は従来どおり当たる", () => {
  assert.equal(matchCandidate("AB", CANDIDATES), AB);
  assert.equal(matchCandidate("ａｂ", CANDIDATES), AB);
});

test("前方一致する別の候補は取り違えない", () => {
  assert.equal(matchCandidate("ABC", CANDIDATES), ABC);
  assert.equal(matchCandidate("ABC(読み: エービーシー)", CANDIDATES), ABC);
});

test("意味の違う別用語は一致しない", () => {
  // 候補制約(#23)の核心。ここが通ると検証段を立てた意味が無くなる
  assert.equal(matchCandidate("業務知識", CANDIDATES), null);
  assert.equal(matchCandidate("業務知識(読み: ギョウムチシキ)", CANDIDATES), null);
});

test("候補に無い用語は読み注記を剥がしても一致しない", () => {
  assert.equal(matchCandidate("XYZ(読み: エックスワイゼット)", CANDIDATES), null);
});

test("読み注記だけの応答は候補に当てない", () => {
  // 剥がすと用語名が残らない。空文字が候補へ当たると事故になる
  assert.equal(matchCandidate("(読み: エービー)", CANDIDATES), null);
});

test("正式名称に括弧を含む候補を壊さない", () => {
  // 一般の括弧は削らない。候補側を無加工にしてあるので、この候補は完全一致で当たる
  const withParen = { term: "AB(旧称)", reading: "エービーキュウショウ" };
  const candidates = [withParen, AB];
  assert.equal(matchCandidate("AB(旧称)", candidates), withParen);
  // 括弧を無条件に削っていたら AB へ化ける
  assert.notEqual(matchCandidate("AB(旧称)", candidates), AB);
});

test("語中の括弧は読み注記でも剥がさない", () => {
  // 末尾限定にしてある。中間の括弧まで対象にすると削る範囲が読めなくなる
  assert.equal(stripReadingNote("ab(読み:えー)b"), "ab(読み:えー)b");
});

test("stripReadingNote は注記が無ければ入力をそのまま返す", () => {
  assert.equal(stripReadingNote("ab"), "ab");
  assert.equal(stripReadingNote("ab(旧称)"), "ab(旧称)");
});
