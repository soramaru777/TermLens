import assert from "node:assert/strict";
import test from "node:test";
import { stripInlineCitations } from "../src/extract/enrich.js";

/**
 * 除去対象。カードは textContent で描画するため、Markdown 記法や裸の URL が
 * 残ると記法そのものが文字列として見えてしまう。
 */
const removed: Array<[name: string, input: string, expected: string]> = [
  [
    "括弧でくくられた引用1件",
    "Kubernetesはコンテナを自動で配置・復旧させる基盤です。 ([example.com](https://example.com/k8s))",
    "Kubernetesはコンテナを自動で配置・復旧させる基盤です。",
  ],
  [
    "括弧でくくられた引用が複数（カンマ区切り）",
    "RAGは検索と生成を組み合わせる手法です。([a.example](https://a.example), [b.example](https://b.example/x?y=1))",
    "RAGは検索と生成を組み合わせる手法です。",
  ],
  [
    "括弧つき引用が連続",
    "Grafanaはダッシュボードです。 ([x](https://x.example))([y](https://y.example))",
    "Grafanaはダッシュボードです。",
  ],
  [
    "素の Markdown リンクはラベルだけ残る",
    "詳細は [公式ドキュメント](https://example.com/docs) を参照してください。",
    "詳細は 公式ドキュメント を参照してください。",
  ],
  [
    "本文に直接書かれた裸の URL",
    "参考 https://example.com/a?b=1 を見てください。",
    "参考 を見てください。",
  ],
  ["前後の空白は落とす", "  前後に空白がある解説です。  ", "前後に空白がある解説です。"],
];

for (const [name, input, expected] of removed) {
  test(`stripInlineCitations: 除去する — ${name}`, () => {
    assert.equal(stripInlineCitations(input), expected);
  });
}

/** 非対象。ふつうの日本語の記号を壊さないこと。 */
const untouched: Array<[name: string, input: string]> = [
  ["半角括弧の読み仮名", "OAuth(オーオース)は認可の仕組みです。"],
  ["角括弧つきの添字表現", "配列[0]は先頭要素を指します。"],
  ["全角括弧の注記", "（参考）NDAは秘密保持契約のことです。"],
  ["URL に見えない文字列", "設定は config.ts に置きます。"],
  ["リンクを含まない普通の解説", "PKCEは認可コード横取り攻撃を防ぐ拡張仕様です。"],
];

for (const [name, input] of untouched) {
  test(`stripInlineCitations: 触らない — ${name}`, () => {
    assert.equal(stripInlineCitations(input), input);
  });
}

test("stripInlineCitations: 全角括弧の中の Markdown リンクはラベルだけ残る", () => {
  // 全角括弧は「括弧でくくられた引用群」には該当しないが、2段目の素のリンク除去は効く。
  // 現実装の挙動をそのまま仕様として固定する。
  assert.equal(
    stripInlineCitations("全角括弧の（[a](https://a.example)）は対象外です。"),
    "全角括弧の（a）は対象外です。",
  );
});

test("stripInlineCitations: null/undefined は空文字になる", () => {
  assert.equal(stripInlineCitations(undefined as unknown as string), "");
  assert.equal(stripInlineCitations(null as unknown as string), "");
  assert.equal(stripInlineCitations(""), "");
});
