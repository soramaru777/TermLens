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

/**
 * コメントを落とした `app.js`。**呼び出しの箇所を数えるテストはこちらを見る** —
 * 「`getSettings()` は保持しない」のような説明文そのものが検出に引っかかるため。
 */
const CODE = APP.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

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

// ---- 収音モードと診断（#26） ----

test("getUserMedia の constraints は capture-mode.js から取る", () => {
  assert.match(
    APP,
    /getUserMedia\(\{\s*audio: audioConstraints\(/,
    "getUserMedia がモードの constraints を使っていない",
  );
  // **constraints をここにベタ書きすると、既定モードを固定している
  // tests/capture-mode.test.ts が空振りになる**（テストが見ていない値で実際のマイクが開く）
  assert.doesNotMatch(APP, /echoCancellation:/, "app.js に constraints がベタ書きされている");
  assert.doesNotMatch(APP, /noiseSuppression:/, "app.js に constraints がベタ書きされている");
  assert.doesNotMatch(APP, /autoGainControl:/, "app.js に constraints がベタ書きされている");
});

/**
 * **メッセージの種類は名前で分岐する。**
 *
 * 型（`instanceof ArrayBuffer`）で判別すると「それ以外は全部統計」になり、worklet が
 * 3種類目を送った瞬間に、それが例外ではなく統計として畳み込まれる（`num()` が未知の値を
 * 0 に潰すので静かに壊れる）。名前で分け、扱わない種類は `default` で捨てること。
 */
test("worklet からのメッセージは種類で分岐する", () => {
  const handler = CODE.slice(
    CODE.indexOf("workletNode.port.onmessage"),
    CODE.indexOf("const source = audioContext.createMediaStreamSource"),
  );
  assert.ok(handler.length > 0, "port.onmessage のハンドラが見つからない");
  assert.match(handler, /switch \(e\.data\?\.type\)/, "種類で分岐していない");
  assert.match(handler, /case "audio":/);
  assert.match(handler, /case "stats":/);
  assert.match(handler, /default:/, "扱わない種類を捨てる既定の枝が無い");
  // ws.send は audio の枝の中だけ。stats や未知の種類が音声ストリームへ混ざらない
  const audioArm = handler.slice(handler.indexOf('case "audio":'), handler.indexOf('case "stats":'));
  assert.match(audioArm, /ws\.send\(e\.data\.buf\)/, "音声の枝で送っていない");
  assert.equal(
    (handler.match(/ws\.send/g) ?? []).length,
    1,
    "ws.send が音声の枝以外にもある",
  );
  assert.match(handler, /mergeAudioStats\(diag\.stats, e\.data\.stats\)/, "統計を累積していない");
});

test("getSettings() は採用リストを通してから保持する", () => {
  // 生の getSettings() を変数に持つと、そこから表示・保存する経路をいつでも作れてしまう。
  // deviceId を握った変数をそもそも作らない
  assert.match(
    APP,
    /trackSettings = pickTrackSettings\(/,
    "getSettings() をホワイトリストに通していない",
  );
  // **`getSettings` の呼び出しは1箇所、しかも `pickTrackSettings(` の実引数位置だけ。**
  // 生の戻り値を別の変数へ束縛すると、そこから console や保存へ渡す経路をいつでも
  // 作れてしまう。その形では「deviceId」という文字列が現れないので、
  // 下の名前の不在チェックだけでは素通りする
  const calls = CODE.match(/getSettings(\?\.)?\(\)/g) ?? [];
  assert.equal(calls.length, 1, `getSettings の呼び出しが ${calls.length} 箇所ある`);
  assert.match(CODE, /pickTrackSettings\([^;]*getSettings(\?\.)?\(\)/, "採用リストを通していない");
  assert.doesNotMatch(APP, /deviceId/, "app.js が deviceId に触れている");
});

test("収音モードはホーム画面に常時出る", () => {
  // 設定画面を開かないと分からない状態にすると、前回スピーカー収音で使った設定のまま
  // 対面会議を始めてしまう
  assert.match(HTML, /id="capture-mode-row"/, "ホーム画面に収音モードの行がない");
  assert.match(HTML, /id="capture-mode-current"/);
  assert.match(APP, /captureModeCurrent\.textContent = captureModeLabel\(/);
});

test("収音モードの選択肢は CAPTURE_MODES から組み立てる", () => {
  // HTML に <option> を書き写すと、モードの定義が2箇所になる。
  // **見るのは収音モードの select の中だけ。** ファイル全体で禁じると、
  // 将来無関係な select を足したときに落ちる
  const select = HTML.slice(HTML.indexOf('id="capture-mode"'));
  const body = select.slice(0, select.indexOf("</select>"));
  assert.ok(body.length > 0, "収音モードの select が見つからない");
  assert.doesNotMatch(body, /<option/, "index.html に収音モードの選択肢がベタ書きされている");
  assert.match(APP, /Object\.entries\(CAPTURE_MODES\)/);
});

test("保存された収音モードは normalizeCaptureMode() を通す", () => {
  // localStorage は信頼境界の外。素の値を getUserMedia へ渡すと constraints が
  // undefined のままマイクが開く
  assert.match(APP, /normalizeCaptureMode\(localStorage\.getItem\("termlens\.captureMode"\)\)/);
});

/**
 * **診断は前回セッションの値を持ち越さない。**
 *
 * 持ち越すと、モードを変えて撮り直した比較実験に前回モードの数値が混ざる —
 * AC「実機で設定差を比較できる」の目的そのものが壊れる。しかも壊れても例外は出ず、
 * 数字が少しおかしいだけなので気づけない。
 *
 * 状態を1本にまとめてあるので、ここで見るのも1つで済む（項目を足しても増えない）。
 */
test("開始のたびに診断の状態を初期化する", () => {
  const reset = CODE.slice(
    CODE.indexOf("function resetSessionState"),
    CODE.indexOf("function resetSessionState") + 1200,
  );
  assert.ok(reset.length > 0, "resetSessionState が見つからない");
  assert.match(reset, /diag = null/, "診断の状態が持ち越される");
});

test("診断のダウンロードはマイクを開いた区間でだけ押せる", () => {
  // mock モードや復元セッションでは設定も統計も無い。空のファイルを保存できると
  // 「診断が取れた」と誤解する
  assert.match(CODE, /dlDiagnosticsBtn\.disabled = !hasDiagnostics\(\)/);
});

/**
 * **診断の状態は一度に作る。**
 *
 * 途中で代入していくと、許可拒否や `addModule` 失敗で catch へ抜けたときに
 * 「一部だけ埋まった診断」が残り、「マイクを開いた区間でだけ真」という
 * `hasDiagnostics()` の意味が壊れる。
 */
test("診断の状態は代入1箇所で組み立てる", () => {
  const assigns = CODE.match(/\bdiag = /g) ?? [];
  // 初期化(null)・リセット(null)・組み立ての3箇所だけ
  assert.equal(assigns.length, 3, `diag への代入が ${assigns.length} 箇所ある`);
  assert.match(CODE, /diag = \{\s*mode,/, "まとめて作っていない");
});

test("診断のエクスポートは純関数に委譲する", () => {
  assert.match(HTML, /id="dl-diagnostics"/, "診断のエクスポートボタンがない");
  assert.match(APP, /buildDiagnosticsMarkdown\(\{/, "app.js が診断の Markdown を自前で組んでいる");
});
