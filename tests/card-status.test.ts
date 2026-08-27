import assert from "node:assert/strict";
import test from "node:test";
// public/ はビルドレスな素の JS。tsconfig.test.json の allowJs で解決している
// （`tests/lowpass.test.ts` が public/lowpass.js を読むのと同じ）。
import {
  cardHeading,
  cardStatus,
  mergeCardUpdate,
  shouldApplyResend,
  UNRESOLVED_LABEL,
} from "../public/card-status.js";

/**
 * クライアント側の状態導出（#24）。
 *
 * 固定したいのは2つ。
 * 1. **後方互換** — #24 以前に localStorage へ保存されたカードは `status` を持たない。
 *    保存の有効期限（`SESSION_MAX_AGE_MS`）の内側にある既存セッションを壊さないため、
 *    旧 `confidence` から導出する。この導出が落ちると、復元したカードの
 *    「もしかして?」が黙って消える（= 不確実な用語が確定したように見える）
 * 2. **見出しの降ろし方** — `unresolved` は推定した term ではなく、音声認識が
 *    聞き取った表記を見出しにする。`term` は DOM キーとして残す（改名しない）
 *
 * app.js から切り出してあるのは、app.js がモジュール評価の時点で `document` を触るため
 * （`public/lowpass.js` を切り出したのと同じ理由）。描画と Markdown の両方がこの
 * 2関数だけを見る＝ `card.status` を直接読む箇所を作らない、が設計の要点。
 */

// --- cardStatus: 後方互換 -------------------------------------------------

test("status があればそのまま返す", () => {
  assert.equal(cardStatus({ status: "confirmed" }), "confirmed");
  assert.equal(cardStatus({ status: "probable" }), "probable");
  assert.equal(cardStatus({ status: "unresolved" }), "unresolved");
});

test("status が無い旧カードは confidence から導出する（low → probable）", () => {
  assert.equal(cardStatus({ confidence: "low" }), "probable");
  assert.equal(cardStatus({ confidence: "high" }), "confirmed");
});

test("status も confidence も無いカードは confirmed に倒す", () => {
  // 復元データの形が壊れていても描画は続ける。バッジを出さない側に倒すのは、
  // 根拠なく「もしかして?」を出すほうが誤解を招くため
  assert.equal(cardStatus({}), "confirmed");
  assert.equal(cardStatus({ confidence: undefined }), "confirmed");
});

test("status は confidence より優先する（両方あるデータでも状態が巻き戻らない）", () => {
  // 保存済みカードに古い confidence が残ったまま status が付くことはありうる。
  // confidence を先に見ると、降格したカードが復元時に元へ戻ってしまう
  assert.equal(cardStatus({ status: "unresolved", confidence: "high" }), "unresolved");
  assert.equal(cardStatus({ status: "confirmed", confidence: "low" }), "confirmed");
});

// --- cardHeading: 見出しの降ろし方 ---------------------------------------

test("confirmed / probable の見出しは term のまま", () => {
  const card = { term: "Kubernetes", surfaceForms: ["クバネテス"], correctedFrom: "クバネテス" };
  assert.equal(cardHeading({ ...card, status: "confirmed" }), "Kubernetes");
  assert.equal(cardHeading({ ...card, status: "probable" }), "Kubernetes");
  assert.equal(cardHeading({ ...card, confidence: "low" }), "Kubernetes", "旧カードも同じ");
});

test("unresolved の見出しは surfaceForms[0] → correctedFrom → term の順で選ぶ", () => {
  assert.equal(
    cardHeading({
      term: "クーベルタン",
      status: "unresolved",
      surfaceForms: ["クバネテス"],
      correctedFrom: "クバネテース",
    }),
    "クバネテス",
    "文字起こしに実在した表記を最優先する（filterSurfaceForms 済みなので必ず本文にある）",
  );
  assert.equal(
    cardHeading({ term: "クーベルタン", status: "unresolved", surfaceForms: [], correctedFrom: "クバネテス" }),
    "クバネテス",
  );
  assert.equal(
    cardHeading({ term: "クーベルタン", status: "unresolved", surfaceForms: [], correctedFrom: null }),
    "クーベルタン",
    "どちらも無ければ term に落ちる（見出しが空になるほうが害が大きい）",
  );
  assert.equal(
    cardHeading({ term: "クーベルタン", status: "unresolved" }),
    "クーベルタン",
    "surfaceForms が undefined の復元データでも落ちない",
  );
});

test("注記の文言は1か所にまとめてある（画面と Markdown で揃える）", () => {
  assert.ok(UNRESOLVED_LABEL.includes("特定できません"));
});

/**
 * 3値以外は confirmed に丸める。
 *
 * 戻り値はそのまま `classList.add()` に渡るので、復元した localStorage が壊れて
 * 空白入りの文字列だと DOMException になり、**復元の catch がセッションを丸ごと消す**。
 * `status: "active"` のような既存クラス名だとレイアウトが崩れる。信頼境界の外から
 * 来る値をここで無害化しておく（導出が1箇所に閉じている利点はここでも効く）。
 */
test("3値以外の status は confirmed に丸める", () => {
  assert.equal(cardStatus({ status: "a b" }), "confirmed", "classList.add が投げる形");
  assert.equal(cardStatus({ status: "active" }), "confirmed", "既存クラス名との衝突");
  assert.equal(cardStatus({ status: 42 }), "confirmed");
  assert.equal(cardStatus({ status: {} }), "confirmed");
});

test("丸めても正しい3値はそのまま通す", () => {
  for (const s of ["confirmed", "probable", "unresolved"]) {
    assert.equal(cardStatus({ status: s }), s);
  }
});

test("status が空文字なら confidence から導出する（未設定と同じ扱い）", () => {
  assert.equal(cardStatus({ status: "", confidence: "low" }), "probable");
});

/**
 * `card_update` の畳み込み（#24 のレビュー指摘）。
 *
 * 「unresolved から戻さない」を status だけに適用すると、**見出しは
 * 「特定できませんでした」のまま本文が確定した別用語の解説に変わる**という、
 * この Issue が防ごうとした形そのものになる。
 */
test("unresolved のカードは status も解説もリンクも据え置く", () => {
  const stored = {
    term: "Grafana",
    status: "unresolved",
    description: "音声認識の表記から正しい用語を特定できませんでした。",
    links: [],
  };
  const merged = mergeCardUpdate(stored, {
    status: "confirmed",
    description: "メトリクスを可視化するダッシュボードです。",
    links: [{ title: "公式", url: "https://grafana.com/" }],
  });
  assert.equal(merged.status, "unresolved", "昇格させない");
  assert.equal(merged.description, stored.description, "本文も据え置く");
  assert.deepEqual(merged.links, [], "リンクも据え置く（Markdown には出てしまうため）");
});

test("probable → unresolved の降格は通す", () => {
  const merged = mergeCardUpdate(
    { term: "Qdrant", status: "probable", description: "ベクトルDBです。", links: [] },
    { status: "unresolved", description: "音声認識の表記から〜", links: [] },
  );
  assert.equal(merged.status, "unresolved");
  assert.equal(merged.description, "音声認識の表記から〜");
});

test("probable → confirmed の昇格も通す", () => {
  const merged = mergeCardUpdate(
    { term: "Qdrant", status: "probable", description: "旧", links: [] },
    { status: "confirmed", description: "新", links: [{ title: "公式", url: "https://x.test/" }] },
  );
  assert.equal(merged.status, "confirmed");
  assert.equal(merged.description, "新");
  assert.equal(merged.links.length, 1);
});

test("status が無いメッセージで状態を巻き戻さない", () => {
  // 旧サーバー。undefined を書き込むと cardStatus() が confirmed に倒れる
  const merged = mergeCardUpdate(
    { term: "Qdrant", status: "probable", description: "旧", links: [] },
    { description: "新", links: [] },
  );
  assert.equal(merged.status, "probable", "解説だけ更新して状態は保つ");
  assert.equal(merged.description, "新");
});

test("引数のカードを書き換えない", () => {
  const stored = { term: "Qdrant", status: "probable", description: "旧", links: [] };
  mergeCardUpdate(stored, { status: "confirmed", description: "新", links: [] });
  assert.equal(stored.status, "probable");
  assert.equal(stored.description, "旧");
});

/**
 * 再送された速報カードを畳み込むか（#24 のレビュー指摘）。
 *
 * **降格したカードへ更新が届く経路は2つある** — `card_update`（Stage 2）と
 * `cards` の再送（再接続で Stage 1 が再抽出）。`mergeCardUpdate()` で前者を塞いだが、
 * 後者に同じ穴が残っていた。status だけ守って description を通すと
 * 「特定できませんでした」の見出しの下に断定的な解説が出る。
 */
test("unresolved のカードは再送を畳み込まない", () => {
  assert.equal(
    shouldApplyResend({ status: "unresolved", description: "定型文", links: [] }),
    false,
    "links が空でも据え置く（unresolved は常に links が空なので、links だけ見ると必ず通る）",
  );
});

test("清書済みのカードは再送を畳み込まない", () => {
  assert.equal(
    shouldApplyResend({
      status: "confirmed",
      links: [{ title: "公式", url: "https://x.test/" }],
    }),
    false,
    "ドラフトで清書を上書きしない（#8 からの判断）",
  );
});

test("未清書の confirmed / probable は再送で更新する", () => {
  assert.equal(shouldApplyResend({ status: "confirmed", links: [] }), true);
  assert.equal(shouldApplyResend({ status: "probable", links: [] }), true);
});

test("status を持たない古いカードも confidence から判断する", () => {
  assert.equal(shouldApplyResend({ confidence: "low", links: [] }), true, "probable 相当");
});

test("links が未定義でも落ちない", () => {
  // localStorage から復元した壊れたカード
  assert.equal(shouldApplyResend({ status: "confirmed" }), true);
});
