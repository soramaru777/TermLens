import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTerm } from "../src/extract/normalize.js";

/**
 * 同じキーに畳まれてほしい表記のグループ。
 * デデュープ（既出用語の再表示防止）が表記ゆれで破れないことを固定する。
 */
const sameKeyGroups: Array<{ name: string; forms: string[] }> = [
  {
    name: "ラテン文字の大文字小文字・全角・空白",
    forms: ["Kubernetes", "kubernetes", "KUBERNETES", "Ｋｕｂｅｒｎｅｔｅｓ", "  Kubernetes  ", "Kube rnetes"],
  },
  {
    name: "略語の全角・空白",
    forms: ["RAG", "rag", "ＲＡＧ", "R A G", "R\tA\nG"],
  },
  {
    name: "半角カタカナ（濁点付き）と全角スペース",
    forms: ["クバネテス", "ｸﾊﾞﾈﾃｽ", "ク バ ネ テ ス", "　クバネテス　"],
  },
  {
    name: "半角カタカナの拗音・促音",
    forms: ["ポッド", "ﾎﾟｯﾄﾞ", "ポ ッ ド"],
  },
  {
    name: "記号を含む製品名",
    forms: ["CI/CD", "ci/cd", "ＣＩ／ＣＤ", "CI / CD"],
  },
];

for (const group of sameKeyGroups) {
  test(`normalizeTerm: 同一キーに畳まれる — ${group.name}`, () => {
    const keys = group.forms.map(normalizeTerm);
    for (const key of keys) {
      assert.equal(key, keys[0], `${group.forms[keys.indexOf(key)]} が ${group.forms[0]} と一致しない`);
    }
  });
}

/** 別語どうしが衝突しないこと。正規化が過剰にならないことの確認。 */
const distinctPairs: Array<[string, string]> = [
  ["Pod", "Pods"],
  ["OAuth", "OAuth2"],
  ["Kubernetes", "Kubernete"],
  ["Pinecone", "Qdrant"],
  ["クバネテス", "クバネテスト"],
  ["RAG", "RAGE"],
];

for (const [a, b] of distinctPairs) {
  test(`normalizeTerm: 衝突しない — ${a} / ${b}`, () => {
    assert.notEqual(normalizeTerm(a), normalizeTerm(b));
  });
}

test("normalizeTerm: 空白のみは空文字になる", () => {
  assert.equal(normalizeTerm("  \t　\n "), "");
});

test("normalizeTerm: 冪等（2回かけても変わらない）", () => {
  for (const form of sameKeyGroups.flatMap((g) => g.forms)) {
    assert.equal(normalizeTerm(normalizeTerm(form)), normalizeTerm(form));
  }
});
