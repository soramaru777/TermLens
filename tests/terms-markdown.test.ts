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
  /** #38 で TermCard に入った識別子。**エクスポートには出さない** */
  cardId?: string;
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

/**
 * **cardId はエクスポートに出さない（#38 / R6）。**
 *
 * `cardId` は画面のカードを指すための内部の識別子で、持ち出した Markdown を読む人には
 * 何の意味も無い。しかも値はセッションごとの通番なので、載せると別の会議の Markdown と
 * 見た目が衝突する。**出しても例外は出ない**ので、固定しておかないと気づけない。
 */
test("cardId は Markdown に現れない", () => {
  const out = md([
    { cardId: "k1", term: "Kubernetes", reading: "クバネティス", description: "コンテナ基盤。" },
    {
      cardId: "k2",
      term: "Qdrant",
      status: "unresolved",
      surfaceForms: ["クドラント"],
      description: "特定できませんでした。",
      links: [{ title: "公式", url: "https://example.com/" }],
    },
  ]);
  assert.ok(!out.includes("k1"), "cardId がエクスポートに漏れている");
  assert.ok(!out.includes("k2"), "cardId がエクスポートに漏れている");
  assert.ok(!/cardId/i.test(out), "cardId のラベルが出ている");
});

/**
 * 再評価で改名したカードは、**改名後の内容**で書き出される（#40 の AC）。
 *
 * `mergeCardUpdate()` が畳み込んだカードがそのまま `cardData` に載り、エクスポートは
 * その配列を読む。ここが古い内容のままだと、画面には直ったカードが出ているのに
 * **持ち出した Markdown だけ「特定できませんでした」のまま**になる
 * （画面とエクスポートが食い違う #24 の失敗の再来）。
 */
test("再評価で改名したカードは改名後の内容で出る", () => {
  const out = md([
    {
      cardId: "k1",
      term: "AB",
      reading: "エービー",
      status: "confirmed",
      // 昇格前に聞き取られていた表記はそのまま残る
      correctedFrom: "えーび",
      surfaceForms: ["えーび"],
      description: "検証で裏付けの取れた解説。",
      links: [{ title: "公式", url: "https://ab.test/" }],
    },
  ]);
  assert.ok(out.includes("## AB（エービー）"), out);
  assert.ok(!out.includes("※"), "昇格したカードに注記は付かない");
  assert.ok(
    out.includes("音声認識では「えーび」と聞き取られた語です。"),
    "元の表記も残す（どのカードが直ったのか読み手が辿れる）",
  );
  assert.ok(out.includes("検証で裏付けの取れた解説。"), "解説も差し替わっている");
  assert.ok(out.includes("[公式](https://ab.test/)"), "リンクも出る");
});

/**
 * 昇格しなかったカードは据え置かれたまま出る。
 *
 * 裏付けが取れなければ `card_update` そのものが飛ばないので、カードは
 * unresolved のまま。エクスポートも「特定できませんでした」のままであるべき
 * （unresolved 率だけを下げないという方針が、ここでも一貫している）。
 */
test("裏付けが取れなかったカードは unresolved の表記のまま出る", () => {
  const out = md([
    {
      cardId: "k1",
      term: "エービ",
      reading: "エービ",
      status: "unresolved",
      correctedFrom: "えーび",
      surfaceForms: ["えーび"],
      description: "音声認識の表記から正しい用語を特定できませんでした。",
    },
  ]);
  assert.ok(out.includes("## えーび ※用語を特定できませんでした"), out);
  assert.ok(!out.includes("エービ）"), "特定できなかった推定の読みは出さない");
});
