import assert from "node:assert/strict";
import test from "node:test";
import { buildTermsMarkdown } from "../public/terms-markdown.js";

/**
 * Markdown エクスポートに状態が残ること（#24 の AC）。
 *
 * 画面の描画は DOM が要るので決定的テストにしにくいが、**エクスポートは純関数なので
 * ここで固定できる**。切り出す前は「状態の注記を落としても全テストが通る」状態で、
 * AC を検証するテストが1本も無かった（レビューの変異テストで判明）。
 */

interface Card {
  term: string;
  reading?: string;
  description?: string;
  status?: string;
  confidence?: string;
  correctedFrom?: string | null;
  surfaceForms?: string[];
  links?: Array<{ title: string; url: string }>;
}

function md(cards: Card[]): string {
  return buildTermsMarkdown(cards, "2026-08-27 10:00");
}

test("confirmed は注記を付けない", () => {
  const out = md([{ term: "Kubernetes", reading: "クバネティス", description: "コンテナ基盤。" }]);
  assert.ok(out.includes("## Kubernetes（クバネティス）"));
  assert.ok(!out.includes("※"), "確定した用語に注記は要らない");
});

test("probable には ※要確認 を付ける", () => {
  const out = md([{ term: "Qdrant", reading: "クドラント", status: "probable" }]);
  assert.ok(out.includes("## Qdrant（クドラント） ※要確認"));
});

test("unresolved は見出しを元の表記にし、状態を注記する", () => {
  const out = md([
    {
      term: "Grafana",
      reading: "グラファナ",
      status: "unresolved",
      surfaceForms: ["グラファトス"],
      correctedFrom: "グラファトス",
      description: "音声認識の表記から正しい用語を特定できませんでした。",
    },
  ]);
  assert.ok(out.includes("## グラファトス ※用語を特定できませんでした"), out);
  // **推定した用語名は出さない。** 特定できていない語を書き出すと、エクスポートを
  // 後から読んだ人には「Grafana の話だった」と誤って伝わる
  assert.ok(!out.includes("Grafana"), "推定した term は本文に出さない");
  assert.ok(!out.includes("グラファナ"), "特定できなかった用語の読みも出さない");
});

test("unresolved で見出しと元の表記が同じなら重複させない", () => {
  const out = md([
    { term: "Ansible", status: "unresolved", surfaceForms: ["アンシブル"], correctedFrom: "アンシブル" },
  ]);
  assert.equal(
    out.split("アンシブル").length - 1,
    1,
    "見出しに出した表記を「音声認識では〜」でもう一度書かない",
  );
});

test("status を持たない古いカードは confidence から導出する", () => {
  // #24 以前に localStorage へ保存されたカード。復元経路だけ注記が変わらないこと
  const out = md([
    { term: "Qdrant", confidence: "low" },
    { term: "Kubernetes", confidence: "high" },
  ]);
  assert.ok(out.includes("## Qdrant ※要確認"), "low → probable");
  assert.ok(out.includes("## Kubernetes\n"), "high → confirmed（注記なし）");
});

test("スキーム不正なリンクはエクスポートにも出さない", () => {
  const out = md([
    {
      term: "Kubernetes",
      links: [
        { title: "公式", url: "https://kubernetes.io/" },
        { title: "悪意", url: "javascript:alert(1)" },
      ],
    },
  ]);
  assert.ok(out.includes("https://kubernetes.io/"));
  assert.ok(!out.includes("javascript:"), "復元経路の links は信頼境界の外にある");
});

test("Markdown の記号を含む用語をエスケープする", () => {
  const out = md([{ term: "C*_[x]", description: "記号を含む解説 #1" }]);
  assert.ok(out.includes("C\\*\\_\\[x\\]"), out);
  assert.ok(out.includes("\\#1"));
});
