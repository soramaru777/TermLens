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
 * **画面と Markdown エクスポートは同じ `groupUtterances()` を、同じ引数で通る。**
 *
 * 片方が自前で `finalLines` をまとめ直すと、jitter 補正の効いた画面と効かない
 * エクスポートに割れる（AC「画面表示と Markdown export で同じ補正結果になる」が
 * 静かに落ちる。純関数のテストは全部緑のまま）。
 *
 * **引数が同じであることまで固定する**（#48）。想定話者数を片方にだけ渡すと、
 * 画面と Markdown で話者ラベルが割れる — これも例外は出ない。
 */
const GROUP_CALL = "groupUtterances(finalLines, { expectedSpeakers: getExpectedSpeakers() })";

test("表示とエクスポートは同じ groupUtterances() を同じ引数で通す", () => {
  assert.match(APP, /from "\.\/utterances\.js"/, "utterances.js を import していない");
  // 呼び出しは描画（renderTranscript）とエクスポート（buildTranscriptMarkdown）の2箇所だけ
  const calls = CODE.match(/groupUtterances\(/g) ?? [];
  assert.equal(calls.length, 2, `groupUtterances の呼び出しが ${calls.length} 箇所ある`);
  // **同じ形の呼び出しが2箇所ある**ことを数で固定する。総数が2で、この形が2なら、
  // 2箇所は必ず同一（片方だけ引数を変えるとどちらかの数が合わなくなる）
  assert.equal(
    CODE.split(GROUP_CALL).length - 1,
    2,
    `2箇所が同じ引数で groupUtterances() を呼んでいない: ${GROUP_CALL}`,
  );
  const render = CODE.slice(CODE.indexOf("function renderTranscript"), CODE.indexOf("function el("));
  assert.ok(render.includes(GROUP_CALL), "描画がグループ化を通していない");
  const md = CODE.slice(
    CODE.indexOf("function buildTranscriptMarkdown"),
    CODE.indexOf("function buildTranscriptMarkdown") + 1500,
  );
  assert.ok(md.includes(GROUP_CALL), "エクスポートがグループ化を通していない");
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
    /finalLines\.push\(\{ text: msg\.text, speaker: msg\.speaker, t: Date\.now\(\), seq: msg\.finalSeq, w: msg\.wordCount \}\)/,
    "final の行に seq / w を積んでいない",
  );
});

// ---- 話者分離の診断（#46） ----

/**
 * **診断統計は raw の `finalLines` から取る。**
 *
 * `groupUtterances()` の結果から集計しても例外は出ないが、#36 の jitter 補正が
 * 掛かった後の speaker ラベルを数えることになり、「表示補正と診断用 raw 統計が
 * 分離されている」という #46 の AC が**静かに**壊れる（補正の効き具合を測るための
 * 統計が、補正後の値になる）。純関数側のテストでは守れない配線なので、
 * 呼び出しの引数をここで固定する。
 */
test("話者統計は raw の finalLines から集計する", () => {
  assert.match(APP, /from "\.\/speaker-stats\.js"/, "speaker-stats.js を import していない");
  const calls = CODE.match(/collectSpeakerStats\(([^)]*)\)/g) ?? [];
  assert.ok(calls.length >= 1, "collectSpeakerStats を呼んでいない");
  for (const call of calls) {
    assert.equal(call, "collectSpeakerStats(finalLines)", `raw 以外から集計している: ${call}`);
  }
  // app.js 側に集計を書き直すと、import した純関数が使われないまま別の定義で動く
  assert.doesNotMatch(CODE, /function collectSpeakerStats\(/, "app.js に定義が残っている");
});

/**
 * **表示補正の計画（#48）も、画面パネルと Markdown が同じ形で作る。**
 *
 * `renderDiagnostics()` と `buildDiagnosticsMd()` で計画の作り方が割れると、
 * 画面に出る補正件数と Markdown の補正件数が食い違う（例外は出ない）。
 *
 * **計画は `planDisplayCorrection()` から取る。`planMinorIslandMerges()` を raw の
 * `finalLines` に直接当ててはいけない。** 表示に効くのは jitter 補正（#36）を通した後の
 * 行に対する計画なので、raw から立てると診断の件数が表示と**両方向にずれる**
 * （jitter が島を潰していれば過大に、jitter が島を作っていれば 0 件と出る）。
 * その件数は「実データを見て閾値を決める」ための唯一の材料なので、ずれた数字は無意味。
 */
const ISLAND_WIRING = [
  "const speakerStats = collectSpeakerStats(finalLines);",
  "const { plan: islandPlan, displayDetected } = planDisplayCorrection(finalLines, {",
];

test("診断の2箇所は表示補正の計画を同じ形で作る", () => {
  const panel = fnBody("renderDiagnostics");
  const md = fnBody("buildDiagnosticsMd");
  for (const stmt of ISLAND_WIRING) {
    assert.ok(panel.includes(stmt), `診断パネルに無い: ${stmt}`);
    assert.ok(md.includes(stmt), `診断 Markdown に無い: ${stmt}`);
    // ファイル全体でもこの2箇所だけ。3箇所目ができると同期の対象が増える
    assert.equal(CODE.split(stmt).length - 1, 2, `${stmt} が2箇所ではない`);
  }
  // 計画も表示上の話者数も純関数側（utterances.js）の定義を使う
  assert.doesNotMatch(CODE, /function planDisplayCorrection\(/, "app.js に定義が残っている");
  // **raw の finalLines に直接計画を当てていないこと。** これが残っていると、
  // 表示に効いた補正と診断の件数がずれる（上のコメント参照）
  assert.doesNotMatch(
    CODE,
    /planMinorIslandMerges\(/,
    "app.js が raw から直接計画を立てている（planDisplayCorrection を通すこと）",
  );
});

test("想定話者数の選択肢は EXPECTED_SPEAKER_OPTIONS から組み立てる", () => {
  // HTML に <option> を書き写すと、選択肢の定義が2箇所になる（収音モードと同じ規則）
  assert.match(HTML, /id="expected-speakers"/, "設定画面に想定話者数が無い");
  // **`<select>` の中だけを切り出して見る。** 固定したいのは「この select に option を
  // 書き写していない」ことなので、文字数で切ると後続の要素が増減しただけで意味が変わる
  const openTag = HTML.indexOf('id="expected-speakers"');
  const closeTag = HTML.indexOf("</select>", openTag);
  assert.ok(closeTag > openTag, "expected-speakers の </select> が見つからない");
  const select = HTML.slice(openTag, closeTag);
  assert.doesNotMatch(select, /<option/, "HTML に選択肢が書き写されている");
  assert.match(CODE, /for \(const opt of EXPECTED_SPEAKER_OPTIONS\)/);
  // 保存値は信頼境界の外。読み側で必ず丸める
  assert.match(
    CODE,
    /normalizeExpectedSpeakers\(localStorage\.getItem\("termlens\.expectedSpeakers"\)\)/,
    "想定話者数を丸めずに読んでいる",
  );
  assert.match(CODE, /localStorage\.setItem\("termlens\.expectedSpeakers"/, "保存していない");
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

/**
 * **収音側と話者側でライフタイムが違う**（#46 で条件が変わった）。
 *
 * 収音の設定・入力統計はマイクを開いた区間（`hasDiagnostics()`）にしか無いが、
 * 話者統計は `finalLines` に紐づくので、マイクを開いていない復元セッションでも出せる。
 * 旧条件（`!hasDiagnostics()` だけ）に戻すと、復元セッションから話者分離の診断を
 * 取り出す経路が消える — ボタンが押せないだけで例外は出ないので気づけない。
 */
test("診断のダウンロードは、収音か発話のどちらかがあれば押せる", () => {
  assert.match(
    CODE,
    /dlDiagnosticsBtn\.disabled = !hasDiagnostics\(\) && spokenLines\(\)\.length === 0/,
  );
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
    /function updateCard\(\{ cardId, status, description, links, rename \}\)/,
    "updateCard の受け取るペイロードが変わっている（#40 の rename を含む）",
  );
  const update = fnBody("updateCard");
  assert.match(update, /incomingCardId\.get\(cardId\)/, "受信 ID を写像していない");
  // **カードを引くのは今も cardId だけ。** #40 で term を触るようになったが、それは
  // 「改名後の意味上の同一性を貼り直す」ためで、**更新対象を探すのには使わない**。
  // 引き当てに term が混じると、同じ term のカードが2枚あるときに取り違える（#38）
  assert.doesNotMatch(
    update,
    /termToCardId\.get\(\s*(cardId|previousTerm)\b/,
    "更新対象を term で引いている",
  );
  assert.doesNotMatch(update, /cardData\.get\((?!localId|targetId)/, "cardData を ID 以外で引いている");
});

/**
 * 改名の適用（#40）。
 *
 * **`termToCardId` は delete と set の両方が要る。** 旧 term のキーを消し忘れると、
 * 古い表記でカードが引かれ続け、後から出た別の用語のカードが同じローカル ID を掴む。
 * set を忘れると、改名後のカードが**デデュープから外れて2枚目が生える**。
 * どちらも例外は出ないので、配線として固定しておく。
 */
test("改名は termToCardId を旧 term から新 term へ張り替える", () => {
  const update = fnBody("updateCard");
  assert.match(update, /termToCardId\.delete\(previousTerm\)/, "旧 term のキーを消していない");
  assert.match(update, /termToCardId\.set\(stored\.term, localId\)/, "新 term のキーを貼っていない");
  // 改名が実際に効いたときだけ張り替える（据え置かれた更新で Map を触らない）
  assert.match(update, /stored\.term !== previousTerm/, "改名の有無を見ていない");
});

/**
 * 統合で消える側を指す**すべての**参照を張り替える（#40）。
 *
 * `incomingCardId` は再接続のたびにエントリが増えるので、同じカードを指す serverCardId は
 * 複数ありうる。1つだけ直すと以降の `card_update` が消えたカードを引いて静かに捨てられる。
 * `highlightOwner` は追加専用で削除 API が無かったため、付け替え関数を新設している。
 */
test("統合は受信 ID の写像とハイライトの持ち主を張り替える", () => {
  const merge = fnBody("mergeRenamedCard");
  assert.match(merge, /reassignIncomingCardId\(dropId, keepId\)/, "受信 ID を張り替えていない");
  assert.match(merge, /reassignHighlightOwner\(dropId, keepId\)/, "ハイライトを張り替えていない");
  // **全件走査であることまで見る。** 1件だけ直す実装に戻しても例外は出ない
  assert.match(
    fnBody("reassignIncomingCardId"),
    /for \(const \[serverCardId, localId\] of incomingCardId\)/,
    "受信 ID の張り替えが全件走査になっていない",
  );
  assert.match(
    fnBody("reassignHighlightOwner"),
    /for \(const \[form, owner\] of highlightOwner\)/,
    "ハイライトの張り替えが全件走査になっていない",
  );
});

/**
 * 統合で表示が飛ばないこと（#40）。
 *
 * `activeCardId` が消えた DOM を指したままだと、縦積みレイアウト（`.active` の1枚だけを
 * CSS で見せる）で**カードが1枚も表示されない画面**になる。固定中（`pinnedToCard`）でも
 * 同じで、こちらは真偽値なので付け替えは要らないが active を移さないと同じ結末になる。
 */
test("統合は active カードと件数表示を引き継ぐ", () => {
  const merge = fnBody("mergeRenamedCard");
  assert.match(merge, /activeCardId === dropId/, "消える側を指していないか見ていない");
  assert.match(merge, /setActiveCard\(keepId\)/, "残す側へ移していない");
  assert.match(merge, /renderCardNav\(\)/, "件数が減ったことを反映していない");
  // 消える側の DOM を残すと、同じ用語のカードが2枚並んだままになる
  assert.match(merge, /findCardEl\(dropId\)\?\.remove\(\)/, "消える側の DOM を除去していない");
});

/**
 * **統合を起動する側**を固定する（#40）。
 *
 * `mergeRenamedCard()` の中身をいくら固めても、`updateCard()` が呼ばなくなれば統合は
 * 丸ごと止まる。しかもその壊れ方は**例外もテスト失敗も出さない** — 同じ用語のカードが
 * 2枚並ぶだけで、画面を見ないと分からない。実際、衝突判定の条件を潰しても
 * `mergeRenamedCard` の中身を見るテストは全部緑のままだった。
 *
 * 固定するのは3つ: (1) 改名が効いたときだけ張り替えに入る (2) 同じ term の別カードを
 * 探す (3) 見つかったら統合し、その戻り値を以後の対象にする。
 */
test("改名で term が衝突したら統合を起動する", () => {
  const update = fnBody("updateCard");
  // 改名が効かなかった（据え置かれた）ときに Map を触らない条件
  assert.match(update, /stored\.term !== previousTerm/, "改名が効いたかを見ていない");
  // 同じ term を既に持つカードを探す
  assert.match(
    update,
    /const otherId = termToCardId\.get\(stored\.term\)/,
    "衝突相手を探していない",
  );
  // 自分自身・消えたカードを掴まないためのガードごと固定する。
  // **`if (` から始めて見る。** 部分一致で書くと `if (false && otherId !== ...)` の
  // ように**条件を丸ごと殺した書き換え**が素通りする（実際に取り逃がした）
  assert.match(
    update,
    /if \(otherId !== undefined && otherId !== localId && cardData\.has\(otherId\)\) \{/,
    "衝突判定のガードが変わっている（条件が無効化されていないか）",
  );
  // 統合を実際に呼び、**戻り値を以後の対象にする**（描画対象が別カードに移るため）
  assert.match(
    update,
    /targetId = mergeRenamedCard\(localId, otherId\)/,
    "統合を呼んでいない、または戻り値を使っていない",
  );
  // 衝突しなかった側の分岐も固定する。ここを消すと新しい term でカードを引けなくなる
  assert.match(update, /termToCardId\.set\(stored\.term, localId\)/, "新しい term を貼っていない");
});

/**
 * **どちらの cardId を残すか**は設計の中心決定なので式ごと固定する（#40）。
 *
 * 「登場順が早いほう」を選ぶのは、#38 の目的が ID の永続性だから — 既に画面に居て人が
 * 固定しているかもしれないカードを消さない。`<` を `>` にしても落ちるテストが無い状態
 * だったが、逆にすると**人が見ていたカードのほうが消える**。
 */
test("統合で残すのは登場順が早いカードの ID", () => {
  const merge = fnBody("mergeRenamedCard");
  // 登場順は cardData の挿入順。別の順序（例: term の辞書順）に変えられていないか
  assert.match(merge, /const order = \[\.\.\.cardData\.keys\(\)\]/, "登場順を挿入順から採っていない");
  assert.match(
    merge,
    /order\.indexOf\(otherId\) < order\.indexOf\(renamedId\) \? otherId : renamedId/,
    "残す側の選び方が変わっている（早い順ではなくなっている）",
  );
  assert.match(
    merge,
    /const dropId = keepId === renamedId \? otherId : renamedId/,
    "消す側が残す側の裏返しになっていない",
  );
  // 統合結果を残す側の ID で置き、消す側を落とす。片方だけだとカードが2枚残るか消える
  assert.match(merge, /cardData\.set\(keepId, merged\)/, "統合結果を残す側へ書いていない");
  assert.match(merge, /cardData\.delete\(dropId\)/, "消す側を cardData から落としていない");
  assert.match(
    merge,
    /termToCardId\.set\(merged\.term, keepId\)/,
    "意味上の同一性を残す側へ寄せていない",
  );
});

/**
 * 統合ルールそのものは純関数に委ねる（#40）。
 *
 * `mergeDuplicateCards()` を通さずに `cardData.set(keepId, {...})` を手で書くと、
 * surfaceForms と links の統合ルールが app.js 側に散り、**テストで固定した規則と
 * 実際の挙動が別になる**（`mergeCardUpdate()` を集約したのと同じ理由）。
 */
test("統合の中身は mergeDuplicateCards() に委譲する", () => {
  assert.match(
    fnBody("mergeRenamedCard"),
    /mergeDuplicateCards\(keepBase, cardData\.get\(dropId\)\)/,
    "統合ルールを app.js に書き下している",
  );
  assert.match(APP, /mergeDuplicateCards,/, "card-status.js から import していない");
});

/**
 * 古い surface form のハイライトを消さない（#40）。
 *
 * 文字起こし本文は崩れた表記のまま残る（この Issue は raw transcript を書き換えない）。
 * ハイライトを置き換えると、**過去の行からカードへ辿れなくなる**。
 */
test("改名は新しい表記を足すだけで、古いハイライトを消さない", () => {
  const update = fnBody("updateCard");
  assert.match(update, /addHighlightTerm\(renamedCard\.term, targetId\)/);
  assert.match(update, /addHighlightTerm\(renamedCard\.correctedFrom, targetId\)/);
  assert.match(update, /addHighlightTerm\(form, targetId\)/);
  // 削除・クリアの経路を作らない（highlightOwner は追加と付け替えだけ）
  assert.doesNotMatch(CODE, /highlightOwner\.delete\(/, "ハイライトを消す経路ができている");
});

/**
 * **raw transcript は書き換えない**（#40 の AC）。
 *
 * 用語カードを直しても文字起こし本文の ASR 結果には触らない。`finalLines` を書き換える
 * 経路が増えていないことを、**要素への代入が1箇所も無い**ことで固定する。
 */
test("カードの更新経路は finalLines を書き換えない", () => {
  for (const fn of ["updateCard", "mergeRenamedCard"]) {
    assert.doesNotMatch(fnBody(fn), /finalLines/, `${fn} が文字起こし本文に触っている`);
  }
  // 行のテキストを後から差し替える経路そのものが無い（push と切り詰めだけ）
  assert.doesNotMatch(CODE, /finalLines\[[^\]]*\]\.text\s*=/, "文字起こし本文を書き換えている");
  assert.doesNotMatch(CODE, /\.text = .*card\./, "カードの内容を文字起こし本文へ書き戻している");
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
      // targetId / dropId は #40 の統合経路。どちらもローカル ID
      /findCardEl\((cardId|localId|existingId|targetId|dropId)\)/,
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

// ---- 表示優先度と折りたたみ（#44） ----------------------------------------

/**
 * 表示優先度の導出は `card-status.js` の1本を通す（#44）。
 *
 * `cardStatus()` と同じ理由。`card.importance` を直接読む箇所が増えると、
 * **旧保存データ（importance を持たない）でその経路だけ判定が変わる**。
 */
test("表示優先度の導出は cardImportance() を通す", () => {
  assert.match(CODE, /cardImportance,?\n\} from "\.\/card-status\.js"/, "import していない");
  // 生の比較を書き散らさない。既定値の埋め込みも1箇所（card-status.js）に閉じる
  assert.doesNotMatch(CODE, /card\.importance\s*===/, "card.importance を直接比べている");
  assert.doesNotMatch(CODE, /importance\s*\?\?\s*"/, "既定値を app.js 側に書いている");
});

/**
 * `low` クラスは `renderCardHead()` で付け外しする。
 *
 * `renderCardHead` は addCard / updateCard の両方が通る**唯一の再構築点**なので、
 * ここに置けば片方だけ付け忘れる形が作れない（状態クラスと同じ扱い）。
 */
test("low クラスは renderCardHead で付け外しする", () => {
  assert.match(
    fnBody("renderCardHead"),
    /classList\.toggle\("low", cardImportance\(card\) === "low"\)/,
    "renderCardHead が low クラスを扱っていない",
  );
  // 他所で付けると、更新で importance が変わったときに剥がし忘れる
  const toggles = CODE.match(/classList\.(add|toggle|remove)\("low"/g) ?? [];
  assert.equal(toggles.length, 1, `low クラスの操作が ${toggles.length} 箇所ある`);
});

/**
 * **折りたたみは DOM を動かさない**（#44 / 案B）。
 *
 * low カードを別コンテナへ移すと `[...cardsEl.children]` を走査している
 * `findCardEl` / `setActiveCard` が引けなくなり、**例外を出さずに card_update が
 * low カードにだけ届かなくなる**。DOM を触る経路が増えていないことで固定する。
 */
test("折りたたみはクラスの付け外しだけで、カードを別コンテナへ移さない", () => {
  assert.match(CODE, /cardsEl\.classList\.toggle\("show-low"/, "展開状態がクラスで表現されていない");
  // #cards への挿入は3箇所だけ: カード本体・エラーバナー・トグル行。
  // 4箇所目が生えたら「low を別の場所へ入れている」疑いがある
  const appends = CODE.match(/cardsEl\.(append|appendChild|insertBefore|prepend)\(/g) ?? [];
  assert.equal(appends.length, 3, `#cards への挿入が ${appends.length} 箇所ある`);
  assert.doesNotMatch(CODE, /<details/, "details コンテナを使っている");
  assert.doesNotMatch(CODE, /lowCardsEl|lowContainer/, "low 専用のコンテナがある");
});

/**
 * 追従・巡回の対象は `visibleCardIds()` 一本。
 *
 * **これは見た目の好みではなく空画面の防止**。縦積みでは `.active` の1枚だけが出るので、
 * 折りたたまれた low が active になると**表示できるカードが1枚も無くなる**。
 */
test("追従と巡回は visibleCardIds() を通す", () => {
  assert.match(CODE, /function visibleCardIds\(\)/, "ヘルパが無い");
  // renderCardNav / latestBtn / addCard の3経路が同じ集合を見る
  assert.match(fnBody("renderCardNav"), /visibleCardIds\(\)/, "件数表示が全カードを数えている");
  assert.match(fnBody("addCard"), /visibleCardIds\(\)/, "追従が折りたたみを見ていない");
  // 巡回対象を `cardData` から直に組む経路が残っていないこと（残ると辿り着けない番号が出る）
  const rawKeys = CODE.match(/\[\.\.\.cardData\.keys\(\)\]/g) ?? [];
  assert.equal(rawKeys.length, 2, `cardData.keys() の直接展開が ${rawKeys.length} 箇所ある`);
});

/**
 * 折りたたまれた low へのハイライトジャンプは、先に展開してから通常経路へ合流する。
 * 展開せずに `scrollIntoView` すると、何も見えないまま終わる（AC）。
 */
test("low カードへのジャンプは自動で展開する", () => {
  const body = fnBody("jumpToCard");
  assert.match(body, /classList\.contains\("low"\)/, "low かどうかを見ていない");
  assert.match(body, /setLowExpanded\(true\)/, "展開していない");
  // 展開は scrollIntoView より前。後に置くと、折りたたまれたままスクロールしてしまう
  assert.ok(
    body.indexOf("setLowExpanded(true)") < body.indexOf("scrollIntoView"),
    "展開がスクロールより後になっている",
  );
});

/**
 * `cardData` そのものは絞らない（AC: Markdown と保存には全カードが残る）。
 * 絞るのは「いま画面に出せるカード」だけ。
 */
test("エクスポートと保存は全カードを見る（visibleCardIds を通さない）", () => {
  assert.match(
    fnBody("buildTermsMarkdown"),
    /\[\.\.\.cardData\.values\(\)\]/,
    "Markdown が全カードを渡していない",
  );
  assert.doesNotMatch(fnBody("buildTermsMarkdown"), /visibleCardIds/, "Markdown が low を落としている");
  assert.doesNotMatch(
    fnBody("buildSessionSnapshot"),
    /visibleCardIds/,
    "保存が low を落としている（復元で消える）",
  );
});

/**
 * セッションを初期化したら、トグル行の参照と展開状態も一緒に落とす。
 * 片方だけ残すと「展開済みだがトグルが無い」状態が次のセッションへ持ち越される。
 */
test("セッション初期化で折りたたみの状態も戻す", () => {
  const body = fnBody("clearSessionContent");
  assert.match(body, /lowToggle = null/, "トグル行の参照が残る");
  assert.match(body, /lowExpanded = false/, "展開状態が残る");
  assert.match(body, /classList\.remove\("show-low"\)/, "#cards のクラスが残る");
});
