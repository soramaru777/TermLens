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

/**
 * `CODE` から関数1本の本文を切り出す。`app.js` にネストした関数定義は無いので、
 * 次のトップレベル `function` までを本文とみなす。
 *
 * **範囲を絞るのが要点。** ファイル全体を対象にすると、たとえば「`updateCard` が
 * term を見ていない」ことを確かめたいのに、無関係な `addCard` 側の記述で通ってしまう。
 */
function fnBody(name: string): string {
  const start = CODE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const end = CODE.indexOf("\nfunction ", start + 1);
  return CODE.slice(start, end < 0 ? undefined : end);
}

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

// ---- 発話グループ（#36） ----

/**
 * **画面と Markdown エクスポートは同じ `groupUtterances()` を通る。**
 *
 * 片方が自前で `finalLines` をまとめ直すと、jitter 補正の効いた画面と効かない
 * エクスポートに割れる（AC「画面表示と Markdown export で同じ補正結果になる」が
 * 静かに落ちる。純関数のテストは全部緑のまま）。
 */
test("表示とエクスポートは同じ groupUtterances() を通す", () => {
  assert.match(APP, /from "\.\/utterances\.js"/, "utterances.js を import していない");
  // 呼び出しは描画（renderTranscript）とエクスポート（buildTranscriptMarkdown）の2箇所だけ
  const calls = CODE.match(/groupUtterances\(/g) ?? [];
  assert.equal(calls.length, 2, `groupUtterances の呼び出しが ${calls.length} 箇所ある`);
  const render = CODE.slice(CODE.indexOf("function renderTranscript"), CODE.indexOf("function el("));
  assert.match(render, /groupUtterances\(finalLines\)/, "描画がグループ化を通していない");
  const md = CODE.slice(
    CODE.indexOf("function buildTranscriptMarkdown"),
    CODE.indexOf("function buildTranscriptMarkdown") + 1500,
  );
  assert.match(md, /groupUtterances\(finalLines\)/, "エクスポートがグループ化を通していない");
  // app.js 側に定義が残っていると、import した純関数が使われないまま古い挙動で動く
  assert.doesNotMatch(CODE, /function groupUtterances\(/, "app.js に定義が残っている");
});

/**
 * **`finalSeq` を積まないと jitter 補正が時間窓へ落ちる。**
 *
 * 落ちても例外は出ず、補正の精度が静かに下がるだけなので気づけない
 * （`seq` が無い＝復元した旧セッションと同じ扱いになる）。
 */
test("受信した final には finalSeq を seq として積む", () => {
  assert.match(
    CODE,
    /finalLines\.push\(\{ text: msg\.text, speaker: msg\.speaker, t: Date\.now\(\), seq: msg\.finalSeq \}\)/,
    "final の行に seq を積んでいない",
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

// ---- カードの識別子（#38） ----
//
// **`term` を主キーにしていた頃の形へ戻っても、例外は1つも出ない。**
// `card_update` がどのカードにも当たらなくなり「確認中」が回り続ける、再接続後に
// カードが二重化する、といった形で**静かに**壊れる。app.js は Node から import
// できないので（このファイル冒頭の理由）、配線の形をソース文字列で固定する。

test("カードは識別・意味上の同一性・受信 ID の写像を別々の Map で持つ", () => {
  // 3本のどれかへ寄せると #38 の分離そのものが消える。
  // `cardData` を term キーへ戻す ＝ 同じ term のカードを2枚持てない状態に逆戻り
  for (const decl of [
    "const cardData = new Map()",
    "const termToCardId = new Map()",
    "const incomingCardId = new Map()",
  ]) {
    assert.ok(CODE.includes(decl), `${decl} が無い`);
  }
});

test("カードのデデュープは term ベースのまま（#8 を壊さない）", () => {
  const add = fnBody("addCard");
  // 生の term 文字列で引く。正規化を挟むとデデュープの当たり方が変わる
  assert.match(add, /termToCardId\.get\(card\.term\)/, "再送判定が term ベースでない");
  assert.match(add, /termToCardId\.set\(card\.term, localId\)/, "term → ローカル ID を登録していない");
  // 冪等化（#8）: 既知の term では DOM を新規に作らない
  assert.match(add, /if \(shouldApplyResend\(existing\)\)/);
  const resend = add.slice(0, add.indexOf("const localId = adoptLocalCardId"));
  assert.doesNotMatch(resend, /el\("div", "card"\)/, "再送で DOM を新規に作っている");
});

/**
 * **R1**: 再接続でサーバーの採番は `c1` から振り直される。同じ用語が別の cardId で
 * 再送されたとき、写像を貼り替えないと後続の `card_update` が既存カードに当たらない。
 *
 * 貼り替えを `shouldApplyResend()` の分岐**の中**に入れるのがいちばんありがちな壊し方
 * （清書済みカードは畳み込まないので、そこだけ写像が古いまま残る）。**分岐より前**に
 * あることまで見る。
 */
test("再送された速報でも受信 cardId の写像を貼り替える", () => {
  const add = fnBody("addCard");
  const beforeBranch = add.slice(0, add.indexOf("if (shouldApplyResend("));
  assert.ok(beforeBranch.length > 0, "addCard の再送分岐が見つからない");
  assert.match(
    beforeBranch,
    /registerIncoming\(card\.cardId, existingId\)/,
    "再送時の写像の貼り替えが無い／畳み込みの分岐の中に入っている",
  );
  // 再送分岐は既存のローカル ID を返す。`return;` に戻すと、再送で増えた surfaceForms の
  // 持ち主が undefined になり、その表記だけタップしても飛ばないハイライトになる
  assert.match(beforeBranch + add.slice(add.indexOf("if (shouldApplyResend(")), /return existingId;/,
    "再送分岐が既存のローカル ID を返していない");
});

/**
 * **写像は新規・再送の両方で貼る。** 片方でも漏らすと `card_update` が
 * `incomingCardId.get()` で undefined を引き、**例外も出さずに更新を捨てる**。
 * 新規側が漏れると、検証に回った全カードが「確認中」のまま固まる（画面は無傷なので気づけない）。
 *
 * 呼び出しを `registerIncoming()` に括ってあるのは、この「2回そろっているか」を
 * 数えられるようにするため。`incomingCardId.set()` を直に書くと、片方だけ消えても
 * 通ってしまうテストしか書けない。
 */
test("受信 cardId の写像は新規・再送の両方で貼る", () => {
  const add = fnBody("addCard");
  const calls = add.match(/registerIncoming\(/g) ?? [];
  assert.equal(calls.length, 2, `registerIncoming の呼び出しが ${calls.length} 箇所（新規と再送で2箇所）`);
  assert.match(add, /registerIncoming\(card\.cardId, localId\)/, "新規カードの写像を貼っていない");
  assert.match(
    fnBody("registerIncoming"),
    /incomingCardId\.set\(serverCardId, localId\)/,
    "registerIncoming が写像を貼っていない",
  );
});

/**
 * **R2**: `shownTerms` にローカル ID を送ると、サーバーの `normalizeTerm()` を通って
 * `shownSet` に `k1` などが積まれ、**デデュープが丸ごと無効化される**（再接続後に
 * 既出カードが全部再表示される ＝ #8 の回帰）。cardData のキーを ID にした以上、
 * ここを直し忘れるのが最も起きやすい壊し方。
 */
test("再接続時の shownTerms は cardId ではなく term を送る", () => {
  assert.match(
    CODE,
    /shownTerms: \[\.\.\.cardData\.values\(\)\]\.map\(\(c\) => c\.term\)/,
    "shownTerms が term の配列になっていない",
  );
  assert.doesNotMatch(
    CODE,
    /shownTerms: \[\.\.\.cardData\.keys\(\)\]/,
    "shownTerms にローカル ID を送っている",
  );
});

/**
 * `card_update` は受信 ID を**写像してから**引く。ここで term を見ると、
 * 同じ term のカードが2枚あるときに取り違える（#38 が分離した意味が消える）。
 */
test("card_update は cardId から引き当てる（term では引かない）", () => {
  assert.match(
    CODE,
    /function updateCard\(\{ cardId, status, description, links \}\)/,
    "updateCard がまだ term を受け取っている",
  );
  const update = fnBody("updateCard");
  assert.match(update, /incomingCardId\.get\(cardId\)/, "受信 ID を写像していない");
  assert.doesNotMatch(update, /termToCardId/, "更新経路が term を見ている");
  assert.doesNotMatch(update, /\.term\b/, "更新経路が term を見ている");
});

test("カード DOM の参照は cardId ベースで、検索は findCardEl に集約する", () => {
  assert.doesNotMatch(CODE, /dataset\.term/, "dataset.term が残っている");
  assert.match(CODE, /function findCardEl\(cardId\)/, "検索ヘルパが無い");
  assert.match(CODE, /div\.dataset\.cardId = localId/, "カード要素に cardId を書いていない");
  // 直接検索を書き散らすと、識別子を変えるたびに置換漏れが出る（漏れても例外は出ない）
  const finds = CODE.match(/\[\.\.\.cardsEl\.children\]\.find\(/g) ?? [];
  assert.equal(finds.length, 1, `カード DOM の直接検索が ${finds.length} 箇所ある`);
  // **渡す値まで見る。** 集約しただけでは `findCardEl(card.term)` を防げない。
  // term はローカル ID ではないので必ず undefined を返し、再送で cardData だけが更新されて
  // DOM が古いまま残る ＝ **画面と Markdown エクスポートが食い違う**（例外は出ない）
  for (const arg of CODE.match(/findCardEl\(([^)]*)\)/g) ?? []) {
    assert.match(
      arg,
      /findCardEl\((cardId|localId|existingId)\)/,
      `findCardEl にローカル ID 以外を渡している: ${arg}`,
    );
  }
  // 追従/固定・ハイライトの持ち主も識別子で持つ
  assert.doesNotMatch(CODE, /\bactiveTerm\b/, "active カードを term で持っている");
  assert.doesNotMatch(CODE, /\bpinnedToTerm\b/, "固定中のカードを term で持っている");
  assert.match(CODE, /if \(owner\) span\.dataset\.cardId = owner/, "ハイライトの持ち主が cardId でない");
});

/**
 * ハイライトの持ち主は **`addCard()` が決めたローカル ID**。
 * `card.cardId`（サーバーの採番）を渡すと、再送で写像だけ貼り替えた場合に
 * 実在しないカードを指し、タップしても飛ばなくなる。
 */
test("ハイライトの持ち主は addCard の戻り値を使う", () => {
  for (const call of [
    "addHighlightTerm(card.term, id)",
    "addHighlightTerm(card.correctedFrom, id)",
    "addHighlightTerm(form, id)",
  ]) {
    // 受信経路（cards）と復元経路の2箇所
    assert.equal(
      CODE.split(call).length - 1,
      2,
      `${call} が2箇所そろっていない（受信と復元で片方だけ直っている）`,
    );
  }
  assert.match(fnBody("addCard"), /return localId;/, "addCard がローカル ID を返していない");
});

/**
 * 保存/復元で cardId が維持される（AC）。スナップショットの `cardId` は保存時点の
 * ローカル ID なので、`k\d+` はそのまま採用する。**採番カウンタを追い越させないと、
 * 復元後に新しく出たカードが復元済みカードと同じ ID を取る**（更新が別のカードに当たる）。
 * cardId を持たない #38 以前の保存データは新しく採る。
 */
test("復元は保存データの cardId を維持し、旧データには採番する", () => {
  assert.match(CODE, /const LOCAL_CARD_ID_RE = \/\^k\\d\+\$\//, "ローカル ID の判定が無い");
  const adopt = fnBody("adoptLocalCardId");
  assert.match(adopt, /LOCAL_CARD_ID_RE\.test\(incoming\)/);
  assert.match(adopt, /return incoming;/, "一致した cardId をそのまま採用していない");
  assert.match(
    adopt,
    /nextLocalCardId = Math\.max\(nextLocalCardId, Number\(incoming\.slice\(1\)\)\)/,
    "採番カウンタを追い越させていない（復元後に ID が衝突する）",
  );
  assert.match(adopt, /return newLocalCardId\(\);/, "cardId の無い旧保存データを採番できない");
  // localStorage は信頼境界の外。「cardId 無し」と「cardId: k1」が混じった壊れた
  // スナップショットでは、前者が採った k1 を後者が上書きして**カードが1枚黙って消える**
  assert.match(
    adopt,
    /!cardData\.has\(incoming\)/,
    "すでに使われているローカル ID を採用してしまう（復元でカードが消える）",
  );
  // 保持するカードの cardId はローカル ID に差し替える（次回の保存でそのまま出る）
  assert.match(
    fnBody("addCard"),
    /cardData\.set\(localId, \{ \.\.\.card, cardId: localId \}\)/,
    "保持するカードの cardId をローカル ID に揃えていない",
  );
  // 復元は addCard を通す（分岐を復元経路にコピーしない）
  assert.match(CODE, /for \(const \[, card\] of session\.cardData\) \{\s*const id = addCard\(card\);/);
});

test("セッション初期化で識別用の Map を3本ともクリアする", () => {
  // 1本でも残ると、新しいセッションの cardId が前回のカードへ写像される
  const clear = fnBody("clearSessionContent");
  for (const stmt of [
    "cardData.clear()",
    "termToCardId.clear()",
    "incomingCardId.clear()",
    "nextLocalCardId = 0",
  ]) {
    assert.ok(clear.includes(stmt), `${stmt} が clearSessionContent に無い`);
  }
  assert.match(fnBody("resetSessionState"), /clearSessionContent\(\)/);
});
