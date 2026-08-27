import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * `public/app.js` が `card-status.js` のガードを**実際に使っている**ことを固定する（#24）。
 *
 * **なぜソース文字列を見る不格好なテストが要るのか。**
 * `mergeCardUpdate()` / `shouldApplyResend()` の中身はテストで押さえてあるが、
 * それだけでは「app.js がそれを呼んでいる」ことは1本も守られていない。
 * 実際、#24 のレビューで**2度指摘された不具合そのものを app.js に書き戻しても
 * 全テストが緑のまま**になることを変異テストで確認した（M8 / M9 / M10）。
 *
 * app.js はモジュール評価の時点で `document.getElementById` を呼ぶので Node から
 * import できず、DOM を伴う分岐を実行して確かめる手段がない（jsdom を入れるのは
 * ビルドレスの方針に対して重い）。呼び出しの存在だけでも固定しておけば、
 * 「純関数は正しいのに配線が抜けている」という #22 で踏んだのと同じ事故を防げる。
 *
 * 壊れやすいテストではあるが、**壊れたときに直すべきなのは呼び出し側**なので
 * 誤検知にはならない。
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("card_update の畳み込みは mergeCardUpdate() を通す", () => {
  // 素の Object.assign に戻すと「unresolved の見出しの下に断定的な解説」が復活する
  assert.match(
    APP,
    /Object\.assign\(\s*stored,\s*mergeCardUpdate\(/,
    "updateCard が mergeCardUpdate() の戻りを畳み込んでいない",
  );
});

test("本文は必ず畳み込み後のカードから描く", () => {
  // 引数の description を直接描くと、据え置いたはずの解説が DOM だけ更新される。
  // 該当行は addCard と updateCard の2箇所にあるので、**悪い形の不在**で判定する
  // （良い形の存在を見ると、片方が残っているだけで通ってしまう）。
  assert.doesNotMatch(
    APP,
    /\.desc"\)\.textContent = description;/,
    "引数の description を直接描いている箇所がある",
  );
  assert.equal(
    APP.split('.desc").textContent = card.description;').length - 1,
    2,
    "addCard / updateCard の2箇所とも畳み込み後のカードから描く",
  );
});

test("速報カードの再送は shouldApplyResend() で判断する", () => {
  assert.match(APP, /if \(shouldApplyResend\(existing\)\)/, "addCard の再送分岐が素の条件");
  // 旧条件が残っていると、unresolved は links が常に空なので必ず分岐に入る
  assert.doesNotMatch(
    APP,
    /if \(existing\.links\.length === 0\)/,
    "links だけを見る旧条件が残っている",
  );
});

test("状態と見出しの導出は card-status.js から import する", () => {
  // 直接 card.status を読む箇所を作ると、localStorage から復元した古いカード
  // （status を持たない）でその経路だけ表示が変わる
  assert.match(APP, /from "\.\/card-status\.js"/);
  for (const fn of ["cardStatus", "cardHeading", "mergeCardUpdate", "shouldApplyResend"]) {
    assert.ok(APP.includes(fn), `${fn} を import していない`);
  }
});

test("Markdown エクスポートは純関数に委譲する", () => {
  assert.match(
    APP,
    /buildTermsMarkdownPure\(\[\.\.\.cardData\.values\(\)\]/,
    "app.js が Markdown を自前で組み立てている（テストの効かない場所に戻っている）",
  );
});
