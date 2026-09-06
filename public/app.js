// TermLens クライアント。
// サーバーとのWSプロトコル: バイナリ = 16kHz mono PCM16 音声、テキスト = JSON (src/protocol.ts 参照)

// 目標サンプルレートは Worklet 側のローパス設計と揃っている必要があるため、
// 定義元(lowpass.js)から取る。ここで数値をベタ書きすると片方だけ変わりうる。
import { TARGET_SAMPLE_RATE } from "./lowpass.js";
// カードの状態と見出しの導出は card-status.js が唯一の定義箇所(#24)。
// ここで `card.status` を直接読むと、復元経路（status を持たない旧カード）だけ表示が変わる。
import {
  cardHeading,
  cardStatus,
  mergeCardUpdate,
  mergeDuplicateCards,
  shouldApplyResend,
  UNRESOLVED_LABEL,
  cardImportance,
} from "./card-status.js";
import {
  buildTermsMarkdown as buildTermsMarkdownPure,
  escMd,
  isHttpUrl,
} from "./terms-markdown.js";
// 収音モードの constraints は capture-mode.js が唯一の定義箇所(#26)。
// ここに constraints をベタ書きすると、既定モードを固定しているテストが空振りする。
import {
  CAPTURE_MODES,
  audioConstraints,
  captureModeHint,
  captureModeLabel,
  normalizeCaptureMode,
} from "./capture-mode.js";
// 発話グループの組み立て(話者 jitter の補正 + minor island の補正 + 中立化 + 同一話者の結合)は
// utterances.js が唯一の定義箇所(#36 / #48 / #50)。ここでまとめ直すと、画面と Markdown
// エクスポートで補正結果が食い違う。
// **groupUtterances() の2箇所には必ず同じ引数を渡すこと** — 片方だけ想定話者数を
// 渡すと画面と Markdown で話者ラベルが割れ、しかも例外は出ない。
// **段落内の連結はグループの `runs` を描く**(#55)。同じ final 由来の行は区切りなし、
// 別の final は半角スペース。連結子の規則は `mergeSameSpeaker()` が決めるので、
// 画面と Markdown で割れない(`texts` を直接連結しないこと)
import { groupUtterances, planDisplayCorrection } from "./utterances.js";
// 話者統計の集計・想定話者数の選択肢は speaker-stats.js が唯一の定義箇所(#46)。
// **集計は raw の finalLines に対して行う**(groupUtterances() の結果ではない) —
// 表示補正の効き具合を測るための統計が、補正後の値になってしまうため。
// 中立ラベル(#50)もここが定義箇所。画面・Markdown・診断が同じ文言を使う
import {
  EXPECTED_SPEAKER_OPTIONS,
  UNRESOLVED_SPEAKER_LABEL,
  collectSpeakerStats,
  normalizeExpectedSpeakers,
} from "./speaker-stats.js";
// 診断の整形も純関数側(diagnostics.js)。getSettings() の採用リストもそこにある。
// 経過時間の整形(fmtElapsed)もそこが定義箇所 — 話者の初出・最終と文字起こしの
// 時刻表記が別実装にならないよう、1箇所から取る。
import {
  audioStatRows,
  buildDiagnosticsMarkdown,
  countTextChars,
  emptyAudioStats,
  fmtElapsed,
  mergeAudioStats,
  pickTrackSettings,
  speakerDiagRows,
  textIntegrityRows,
  trackSettingRows,
} from "./diagnostics.js";

const $ = (id) => document.getElementById(id);

const home = $("home");
const settings = $("settings");
const live = $("live");
const tokenInput = $("token");
const glossaryInput = $("glossary");
const startBtn = $("start-btn");
const stopBtn = $("stop-btn");
const statusBadge = $("status-badge");
const finalText = $("final-text");
const interimText = $("interim-text");
const cardsEl = $("cards");
const homeError = $("home-error");
const homeInfo = $("home-info");
const glossaryRow = $("glossary-row");
const glossaryCount = $("glossary-count");
const openSettingsBtn = $("open-settings");
const closeSettingsBtn = $("close-settings");
const saveSettingsBtn = $("save-settings");
const cardNav = $("card-nav");
const cardPosition = $("card-position");
const latestBtn = $("latest-btn");
const exportRow = $("export-row");
const dlTranscriptBtn = $("dl-transcript");
const dlTermsBtn = $("dl-terms");
const persistToggle = $("persist-toggle");
const restoreBanner = $("restore-banner");
const restoreInfo = $("restore-info");
const restoreBtn = $("restore-btn");
const discardBtn = $("discard-btn");
const captureModeSelect = $("capture-mode");
const captureModeHintEl = $("capture-mode-hint");
const captureModeRow = $("capture-mode-row");
const captureModeCurrent = $("capture-mode-current");
const expectedSpeakersSelect = $("expected-speakers");
const dlDiagnosticsBtn = $("dl-diagnostics");
const diagPanel = $("diag-panel");
const diagTable = $("diag-table");

let ws = null;
let audioContext = null;
let workletNode = null;
let mediaStream = null;
let wakeLock = null;
let sendAudio = false;
let sessionStartedAt = null;
let sessionEndedAt = null;
let captureActive = false; // マイク/Wake Lock を保持している区間か
// 「戻る」の破棄警告に使う。片方だけ保存して戻ると、もう片方が失われるため別々に持つ
let savedTranscript = false;
let savedTerms = false;
/**
 * 収音診断(#26)。**マイクを開いた区間でだけ非 null。**
 *
 * `{ mode, trackSettings, contextSampleRate, stats }` の4つは同じライフタイムを持つ
 * (同時に決まり、同時に捨てる)。別々の変数にすると「全部そろっているか」が代入の順序と
 * コメントで守られることになり、項目を足すたびに宣言・リセット・代入・描画・書き出しの
 * 5箇所を機械的に直す羽目になる。1本なら初期化は `diag = null` の1行で済む。
 *
 * `trackSettings` は `pickTrackSettings()` を通した後の値だけを持つ。生の
 * `getSettings()` は保持しない — 端末識別子を握った変数を作らなければ、
 * うっかり表示・保存する経路も作れない。
 */
let diag = null;
/**
 * STT のモデル情報(#46)。`ServerMessage.stt_info` の中身をそのまま持つ。
 *
 * **`diag` とは別のライフタイム**なので同じ入れ物に入れない。`diag` は
 * 「マイクを開いた区間」に紐づくが、こちらはサーバーから届くものなので、
 * マイクを開いていない mock モードでも来うる(逆に、マイクを開いていても
 * Deepgram が metadata を返さなければ来ない)。
 */
let sttInfo = null;
/**
 * STT テキスト完全性の累計(#52)。`ServerMessage.text_integrity` の中身をそのまま持つ。
 *
 * 累計が届くので**上書きでよい**(差分を積まない)。
 *
 * **`localStorage` に保存しない。** 復元した値はセッションをまたいだ集計になり、
 * 同じ表に並ぶ③④(今の画面の行から数える)と対応しなくなる。診断が答えるのは
 * 「今のセッションで何が起きたか」で、混ざった数字はその問いに答えられない。
 */
let textIntegrity = null;
let stopping = false; // 停止操作によるクローズか(意図しない切断と区別する)
// 再接続: 指数バックオフ 1s, 2s, 4s, 8s, 16s の最大5回。
// マイクは掴んだまま(releaseCapture を呼ばない)、送信だけ止めて待つ
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
let reconnectAttempt = 0; // これまでの試行回数(0=再接続していない)
let reconnectTimer = null; // 待機中の setTimeout。停止操作でキャンセルするため保持する
// ready を一度でも受け取ったか。サーバーが ready を返した時点でトークンは受理済みなので、
// 認証失敗と回線断を切り分ける材料になる(文字起こしの有無で判定すると、
// 無音のまま回線が切れた場合に「トークンを確認してください」と誤表示していた)
let everReady = false;
// 接続がこの時間だけ維持できたら「復帰した」とみなして再接続の試行回数を戻す
const STABLE_MS = 30_000;
let stableTimer = null;

// ---- 保存値の読み出し ----
// 設定は localStorage が正。入力欄は設定画面を開いたときにそこから復元する。
const getToken = () => localStorage.getItem("termlens.token") ?? "";
const getGlossaryText = () => localStorage.getItem("termlens.glossary") ?? "";
const getGlossary = () =>
  getGlossaryText()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
// 既定 ON。明示的に "false" が保存されている場合のみ OFF(要件5)
const getPersistEnabled = () => localStorage.getItem("termlens.persist") !== "false";
// 保存値は信頼境界の外なので必ず normalizeCaptureMode() を通す(未知の名前は既定に倒れる)
const getCaptureMode = () => normalizeCaptureMode(localStorage.getItem("termlens.captureMode"));
// 同上。想定話者数も信頼境界の外から来るので normalizeExpectedSpeakers() を通す(#46)。
//
// **収音モードと違い、セッション開始時に固定しない。** captureMode は getUserMedia に
// 渡る値なので途中で変わると収音が変わるが、想定話者数は診断に添える**申告値**でしかない。
// 会議のあとで「やっぱり2人だった」と申告し直して診断を出し直せるほうが、実データを
// 集めるという #46 の目的には合う。
const getExpectedSpeakers = () =>
  normalizeExpectedSpeakers(localStorage.getItem("termlens.expectedSpeakers"));

function refreshGlossaryCount() {
  glossaryCount.textContent = `${getGlossary().length}語`;
}
refreshGlossaryCount();

// ---- 収音モード(#26) ----
// 選択肢は CAPTURE_MODES から組み立てる。HTML に文言を書き写すと定義が2箇所になる
for (const [value, mode] of Object.entries(CAPTURE_MODES)) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = mode.label;
  captureModeSelect.append(option);
}

// ホーム画面に現在のモードを常時出す。設定画面を開かないと分からない状態にすると、
// 前回スピーカー収音で使った設定のまま対面会議を始める事故が起きる
function refreshCaptureMode() {
  captureModeCurrent.textContent = captureModeLabel(getCaptureMode());
}

/** 設定画面の説明文を選択中のモードに合わせる */
function syncCaptureHint() {
  captureModeHintEl.textContent = captureModeHint(captureModeSelect.value);
}
refreshCaptureMode();

captureModeSelect.addEventListener("change", () => {
  syncCaptureHint();
});

// ---- 想定話者数(#46) ----
// 選択肢は EXPECTED_SPEAKER_OPTIONS から組み立てる。HTML に文言を書き写すと定義が2箇所になる。
// **この値は STT には一切流れない** — 診断で実検出話者数と突き合わせるためだけの申告値
for (const opt of EXPECTED_SPEAKER_OPTIONS) {
  const option = document.createElement("option");
  option.value = opt.value;
  option.textContent = opt.label;
  expectedSpeakersSelect.append(option);
}

// ---- サーバー情報 ----
let serverInfo = null;
fetch("/api/info")
  .then((r) => r.json())
  .then((info) => {
    serverInfo = info;
    homeInfo.textContent = `STT: ${info.sttProvider} / モデル: ${info.model} / 認証: ${info.authRequired ? "あり" : "なし"}`;
    // 初回起動: 認証が必要なのにトークン未設定なら、設定画面へ誘導する
    if (info.authRequired && !getToken()) {
      showSettings();
      showError("アクセストークンを設定してください。");
    }
  })
  .catch(() => {});

// ---- 画面遷移 ----
function showLive() {
  home.hidden = true;
  settings.hidden = true;
  live.hidden = false;
  measureLiveChrome();
}

// 横並びレイアウト(min-width:900px)では transcript/cards の高さを
// 100dvh からヘッダ分を引いて決める。その実測値を CSS 変数に渡す。
function measureLiveChrome() {
  const header = live.querySelector("header");
  const h =
    (header?.offsetHeight ?? 52) +
    (exportRow.hidden ? 0 : exportRow.offsetHeight) +
    (diagPanel.hidden ? 0 : diagPanel.offsetHeight);
  document.documentElement.style.setProperty("--live-chrome", `${h}px`);
}
function showHome() {
  live.hidden = true;
  settings.hidden = true;
  home.hidden = false;
  refreshGlossaryCount();
  refreshCaptureMode();
}
function showSettings() {
  // 入力欄は開くたびに保存値から復元する(「戻る」で破棄できるようにするため)
  tokenInput.value = getToken();
  glossaryInput.value = getGlossaryText();
  persistToggle.checked = getPersistEnabled();
  captureModeSelect.value = getCaptureMode();
  expectedSpeakersSelect.value = getExpectedSpeakers();
  syncCaptureHint();
  home.hidden = true;
  live.hidden = true;
  settings.hidden = false;
}

function setStatus(text) {
  statusBadge.textContent = text;
}

function showError(message) {
  homeError.textContent = message;
  homeError.hidden = false;
}

// ---- 設定画面 ----
openSettingsBtn.addEventListener("click", () => showSettings());
glossaryRow.addEventListener("click", () => showSettings());
captureModeRow.addEventListener("click", () => showSettings());
// 「戻る」は保存せずに破棄する
closeSettingsBtn.addEventListener("click", () => showHome());
saveSettingsBtn.addEventListener("click", () => {
  localStorage.setItem("termlens.token", tokenInput.value.trim());
  localStorage.setItem("termlens.glossary", glossaryInput.value);
  localStorage.setItem("termlens.persist", String(persistToggle.checked));
  // 保存はそのまま。option は CAPTURE_MODES から自分で組み立てたもの(＝信頼境界の内側)で、
  // ここで丸めても option 生成が壊れたときに黙って既定へ倒すだけになる。
  // 境界は読み側の getCaptureMode() 1箇所に閉じる
  localStorage.setItem("termlens.captureMode", captureModeSelect.value);
  // 収音モードと同じ扱い。丸めるのは読み側(getExpectedSpeakers)1箇所に閉じる
  localStorage.setItem("termlens.expectedSpeakers", expectedSpeakersSelect.value);
  // OFF にした時点で保存済みのものも消す。「ONに戻すまで一切残さない」を保証するため(要件5)。
  // 復元案内(pendingRestoreSession とバナー)も一緒に戻さないと、保存をOFFにしたのに
  // 案内からは復元できてしまう(L1)
  if (!persistToggle.checked) {
    deleteSavedSession();
    pendingRestoreSession = null;
    restoreBanner.hidden = true;
  }
  homeError.hidden = true;
  // **想定話者数を変えたら文字起こしを描き直す(#48)。** 表示補正は毎描画で
  // `getExpectedSpeakers()` を読むので、設定だけ変えて再描画しないと、画面と
  // 診断・エクスポートで違う話者ラベルが出る。今は設定画面へ入る導線がホームだけなので
  // 表示中のセッションに当たることは無いが、導線が増えたときに黙って割れる形にしない
  renderTranscript();
  showHome();
});

// ---- Wake Lock ----
async function acquireWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    const lock = await navigator.wakeLock.request("screen");
    // 要求中にセッションが終わっていたら、掴んだ直後に手放す。
    // そうしないと releaseCapture() が「まだ未取得」と判断してすり抜け、
    // 誰も解放しないロックが残って画面が点いたままになる
    if (!captureActive) {
      try { await lock.release(); } catch {}
      return;
    }
    wakeLock = lock;
  } catch {
    /* 非対応・拒否は無視 */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws) acquireWakeLock();
});

// ---- 開始 ----
// 認証失敗やマイク拒否ではリロードを挟まずホームに戻るため、
// 前回のセッションの終端状態が残る。開始のたびに必ず初期化する
// (残ると停止ボタンが「戻る」のまま新しいセッションに入り、停止できなくなる)
// セッションの内容(文字起こし・カード・ハイライト)を空に戻す。
// 画面遷移だけでは残るため、新しいセッションを始める前に必ず通す。
// 残ると次の start で shownTerms に前回の用語が混ざり、新しい会議の用語が
// デデュープで弾かれてカード化されない。DOM にも前回の残骸が並ぶ。
function clearSessionContent() {
  finalLines.length = 0;
  // カードの識別に関わる Map は**3本まとめて**空にする(#38)。1本でも残ると、
  // 新しいセッションの cardId が前回のカードへ写像されて更新が迷子になる
  cardData.clear();
  termToCardId.clear();
  incomingCardId.clear();
  nextLocalCardId = 0;
  highlightOwner.clear();
  highlightRe = null;
  activeCardId = null;
  pinnedToCard = false;
  finalText.textContent = "";
  interimText.textContent = "";
  cardsEl.textContent = ""; // エラーバナーもここで消えるので参照を落とす
  errorBanner = null;
  // トグル行も cardsEl の子なのでここで消えている。参照と展開状態を必ず一緒に落とす(#44) —
  // 片方だけ残すと、次のセッションで「展開済みだがトグルが無い」状態が作れてしまう
  lowToggle = null;
  lowExpanded = false;
  cardsEl.classList.remove("show-low");
  renderCardNav();
}

function resetSessionState() {
  clearSessionContent();
  stopping = false;
  finishing = false;
  finished = false;
  discardWarned = false;
  savedTranscript = false;
  savedTerms = false;
  sessionEndedAt = null;
  exportRow.hidden = true;
  stopBtn.textContent = "停止";
  // 診断は前回のセッションの値を持ち越さない。持ち越すと、比較のために
  // モードを変えて撮り直した数値に前回ぶんが混ざる(#26)
  diag = null;
  // モデル情報も持ち越さない。前回のセッションの diarizer が今回の診断に残ると、
  // 「どの diarizer で録ったか」という記録そのものが嘘になる(#46)
  sttInfo = null;
  // テキスト完全性の累計も持ち越さない(#52)。前回の final 数・文字数が残ると、
  // ①②(サーバー累計)だけが前回ぶんを含み、③④(今の finalLines)と対応しなくなる
  textIntegrity = null;
  diagPanel.hidden = true;
  renderDiagnostics();
  // 前回セッションの再接続待ちが万一残っていたら止める(持ち越さない)
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  everReady = false;
  clearTimeout(stableTimer);
  stableTimer = null;
}

startBtn.addEventListener("click", async () => {
  homeError.hidden = true;
  startBtn.disabled = true;
  // 復元案内が出ている状態で「開始」すると、案内に触れないまま前回の保存データが
  // 今回の最初の保存で無警告に上書きされてしまう。事前に明示して破棄する(M4)
  if (pendingRestoreSession) {
    deleteSavedSession();
    pendingRestoreSession = null;
    restoreBanner.hidden = true;
  }
  resetSessionState();
  captureActive = true;
  const token = getToken();
  const glossary = getGlossary();

  try {
    // モックSTTモードでは音声不要なのでマイク取得をスキップ
    if (serverInfo?.sttProvider !== "mock") {
      // iOS Safari: getUserMedia と AudioContext 生成はユーザージェスチャ内で行う必要がある。
      // constraints はモードごとに capture-mode.js が持つ(既定=対面会議の値は #26 以前と同一)。
      // このセッションで使うモードはここで固定する。以降は会議中に設定が変わっても影響しない
      const mode = getCaptureMode();
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(mode) });
      // ブラウザ/端末が実際に適用した設定。**採用リストを通した値だけを持つ** —
      // 生の getSettings() には端末ごとに安定した識別子が含まれる(diagnostics.js を参照)
      const trackSettings = pickTrackSettings(mediaStream.getAudioTracks()[0]?.getSettings?.());
      // sampleRate は指定しない(iOSでは無視/失敗するため)。実測値からWorkletでダウンサンプルする
      audioContext = new AudioContext();
      // **マイクも AudioContext も開けてから一度に作る。** 途中で代入していくと、
      // 許可拒否や addModule 失敗で catch へ抜けたときに「一部だけ埋まった診断」が残り、
      // 「マイクを開いた区間でだけ真」という hasDiagnostics() の意味が壊れる
      diag = {
        mode,
        trackSettings,
        contextSampleRate: audioContext.sampleRate,
        stats: emptyAudioStats(),
      };
      await audioContext.resume();
      await audioContext.audioWorklet.addModule("/audio-processor.js");

      workletNode = new AudioWorkletNode(audioContext, "pcm16-downsampler", {
        processorOptions: {
          inputSampleRate: audioContext.sampleRate,
          targetSampleRate: TARGET_SAMPLE_RATE,
        },
      });
      // Worklet は同じポートで**音声(ArrayBuffer)と入力統計(プレーンオブジェクト)**の
      // 2種類を送ってくる。判別しないと統計オブジェクトが音声ストリームに混ざって
      // そのまま Deepgram へ送られる(#26)。型で分岐する
      // 種類は名前で分ける(理由は audio-processor.js の postMessage 側)
      workletNode.port.onmessage = (e) => {
        switch (e.data?.type) {
          case "audio":
            if (sendAudio && ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000) {
              ws.send(e.data.buf);
            }
            return;
          case "stats":
            if (diag) diag.stats = mergeAudioStats(diag.stats, e.data.stats);
            renderDiagnostics();
            return;
          default:
            return;
        }
      };
      const source = audioContext.createMediaStreamSource(mediaStream);
      source.connect(workletNode);
      // 出力には繋がない(モニタ不要)
      diagPanel.hidden = false;
      renderDiagnostics();
    }

    sessionStartedAt = new Date();
    connectWs(token, glossary);
    showLive();
    acquireWakeLock();
  } catch (err) {
    console.error(err);
    showError(`開始できませんでした: ${err.message ?? err}`);
    captureActive = false;
    await cleanupAudio();
    startBtn.disabled = false;
  }
});

function connectWs(token, glossary) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // トークンは URL に載せず Sec-WebSocket-Protocol で送る(ログ・履歴への漏えい防止)
  const protocols = ["termlens.v1"];
  if (token) protocols.push("auth." + encodeURIComponent(token));
  // sock をローカルに持ち、以後すべてのハンドラはこれを参照する(グローバル ws ではない)。
  // 接続試行中(CONNECTING)に停止されて ws が null に差し替わった後もこのソケットの
  // open/message/close イベントは発火しうるため、各ハンドラの先頭で
  // 「自分がまだ現行のソケットか」を確認し、古いイベントは無視する(M1)
  const sock = new WebSocket(`${proto}://${location.host}/ws`, protocols);
  sock.binaryType = "arraybuffer";
  ws = sock;

  sock.addEventListener("open", () => {
    if (sock !== ws) return;
    setStatus("STT接続中…");
    // shownTerms: 再接続時、既に表示済みのカードの term を渡す。サーバーは WS 1本ごとに
    // ExtractionScheduler を作り直すためデデュープ状態が空から始まり、渡さないと同じ用語の
    // カードが再送されカードが二重化する(#8)
    //
    // **値から term を取り出す。キーはローカル ID なので送ってはいけない(#38 / R2)。**
    // ID を送ると normalizeTerm() を通って shownSet に `k1` などが積まれ、デデュープが
    // 丸ごと無効化される（再接続後に既出カードが全部再表示される ＝ #8 の回帰）。
    sock.send(
      JSON.stringify({
        type: "start",
        glossary,
        shownTerms: [...cardData.values()].map((c) => c.term),
      }),
    );
  });

  sock.addEventListener("message", (e) => {
    if (sock !== ws) return;
    if (typeof e.data !== "string") return;
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "ready":
        sendAudio = true;
        setStatus("聞き取り中");
        // reconnectAttempt > 0 は今回の ready が再接続の成功であることの印。
        // サーバー側は新しい STT セッションを張るため話者番号が振り直しになる。
        // 「話者A」が別人になり得ることを区切りとして残す
        everReady = true;
        if (reconnectAttempt > 0) {
          finalLines.push({ type: "reconnect", t: Date.now() });
          // **テキスト完全性の累計も捨てる**(#52)。①②を持つサーバー側の `SplitIntegrity` は
          // この新しいセッションで 0 から数え直すのに、ここを残すと前のセッションの
          // 大きい累計が①②に居座る。③④は再接続以降だけを数えるので、新しい final が
          // 1件届くまで「①②＝前セッション分 / ③④＝0」という組み合わせが表示され、
          // 判定文が「クライアントが取りこぼしている」と言う — **何も落ちていないのに**。
          // null に戻せば次の1件が届くまで節ごと出ない（「0件」と「未取得」を混同しない）
          textIntegrity = null;
          renderTranscript();
          scheduleSessionSave();
        }
        // 試行回数は「安定して繋がり続けた」ことを確認してから戻す。
        // ready を受けた時点で戻すと、接続直後に切れる状態(フラッピング)で
        // カウンタが上がらず、上限に到達しないまま永久に再接続し続ける
        clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { reconnectAttempt = 0; }, STABLE_MS);
        break;
      case "transcript":
        if (msg.isFinal) {
          // seq(= サーバーの finalSeq)は「同じ Deepgram の final 由来か」の印。
          // 1つの final が話者で分割されると同じ seq の行が複数並ぶので、
          // utterances.js の jitter 補正がそれを手掛かりに再結合する(#36)。
          // w(= サーバーの wordCount)はそのセグメントの word 数(#46)。話者ごとの
          // word 数と割合を出すために積む。**キーを1文字にするのは `t` / `seq` と同じ
          // 短縮キーの流儀に揃えるため** — 保存は `SESSION_MAX_CHARS`(1MB)で頭打ちに
          // なるので、行数ぶん効くキー名の長さがそのまま復元できる履歴の長さになる。
          // seq / w はどちらも旧サーバーからは届かない。undefined のまま積む(復元経路と同じ扱い)
          finalLines.push({ text: msg.text, speaker: msg.speaker, t: Date.now(), seq: msg.finalSeq, w: msg.wordCount });
          renderTranscript();
          interimText.textContent = "";
          scheduleSessionSave();
        } else {
          interimText.textContent = msg.text;
        }
        finalText.parentElement.scrollTop = finalText.parentElement.scrollHeight;
        break;
      case "cards":
        for (const card of msg.cards) {
          // ハイライトの持ち主は addCard が決めたローカル ID(#38)。
          // ここで card.cardId を使うと、再送で写像だけ貼り替えた場合に食い違う
          const id = addCard(card);
          addHighlightTerm(card.term, id);
          addHighlightTerm(card.correctedFrom, id);
          for (const form of card.surfaceForms ?? []) addHighlightTerm(form, id);
        }
        renderTranscript();
        setStatus("聞き取り中");
        break;
      case "card_update":
        updateCard(msg);
        break;
      case "stt_info":
        // 変化したときだけ届く(サーバー側で判定済み)。type は捨てて中身だけ持つ
        sttInfo = { model: msg.model, diarizer: msg.diarizer };
        renderDiagnostics();
        break;
      case "text_integrity":
        // final ごとに**累計**が届く(#52)。差分を積まないので上書きでよい。
        // **キーを明示して持つ** — サーバーがフィールドを足しても、ここへ書き足さない
        // 限り診断には出ない(`stt_info` と同じ採用リストの発想)
        textIntegrity = {
          finals: msg.finals,
          splitFinals: msg.splitFinals,
          rawChars: msg.rawChars,
          rawVisible: msg.rawVisible,
          splitChars: msg.splitChars,
          splitVisible: msg.splitVisible,
          fallbacks: msg.fallbacks,
          droppedEvents: msg.droppedEvents,
          headDrops: msg.headDrops,
        };
        renderDiagnostics();
        break;
      case "status":
        if (msg.state === "extracting") setStatus("用語を調べています…");
        else if (msg.state === "stt_closed") setStatus("STT切断");
        break;
      case "error":
        setStatus(`エラー: ${msg.message}`);
        // permanent が真のときだけ、消えないバナーで伝える(#10)。stt_error や
        // 連続失敗の通知(一時エラー)は復旧しうるため、ステータス表示だけに留め
        // バナーが会議の最後まで残り続けないようにする
        if (msg.permanent) showErrorBanner(msg.message);
        break;
    }
  });

  sock.addEventListener("close", async (e) => {
    if (sock !== ws) return;
    sendAudio = false;
    clearTimeout(stableTimer);
    // 停止処理の最中や終了後の 1006 を認証失敗と誤判定しない。
    // 誤判定すると「トークンを確認してください」と嘘を表示したうえ、
    // 終端状態を抱えたままホームに戻ってしまう
    if (!stopping && !finished && !everReady && e.code === 1006) {
      // 認証失敗などで即切断された可能性。マイクは取得済みなので必ず解放する
      await releaseCapture();
      showHome();
      showError("接続が拒否されました。設定でトークンを確認してください。");
      startBtn.disabled = false;
    } else if (!stopping && !finished) {
      // 意図しない切断。即座に終端にはせず、マイクを保持したままバックオフ再接続を試みる。
      // (停止操作によるクローズなら stopping が真で、ここには来ない)
      scheduleReconnect();
    }
  });
}

// 指数バックオフで再接続する。releaseCapture/cleanupAudio は呼ばない
// (マイクを離すと再接続できても音声が送れなくなる)。
// 送信は sendAudio=false で止めており、再接続成功時は "ready" 受信で再開する
function scheduleReconnect() {
  if (reconnectAttempt >= RECONNECT_DELAYS.length) {
    // 最大回数まで試して復帰しなかった。ここで初めて終端状態にする
    finish("接続が復帰しませんでした");
    return;
  }
  const delay = RECONNECT_DELAYS[reconnectAttempt];
  reconnectAttempt++;
  setStatus(`再接続中… (${reconnectAttempt}/${RECONNECT_DELAYS.length})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs(getToken(), getGlossary());
  }, delay);
}

// ---- 文字起こし内のカード用語ハイライト ----
const finalLines = [];
// 再接続の印は発言ではないので、件数を数えるときは除く
const spokenLines = () => finalLines.filter((l) => l.type !== "reconnect");

/**
 * 最後の再接続の印より後ろだけを返す(#52)。印が無ければ全体。
 *
 * **テキスト完全性の ③④ にはこれが要る。** ①② を数えるサーバー側の `SplitIntegrity` は
 * WS 1本ごとに作り直されるのに、クライアントは再接続しても `finalLines` を持ち続ける。
 * 境界で切らないと ③④ だけが前のセッションぶんを含んだまま比較され、②→③ に
 * 実在しない増加が出る。`finalSeq`(#36) が同じ問題を持たないのは、クライアントが
 * この印を入れて番号の振り直しをそこで吸収しているから — 同じ印をここでも使う。
 */
const sinceLastReconnect = (items) => {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.type === "reconnect") return items.slice(i + 1);
  }
  return items;
};

// カードの元データ。DOM は新しい順に prepend するが、こちらは挿入順(古い順)を保つ。
// エクスポートは登場順の方が読みやすいため、この Map を正とする。
//
// **3本に分けてあるのが #38 の目的そのもの。** 片方へ寄せると分離が消える。
// - `cardData`       … 識別。表示・エクスポート・DOM 参照の正。キーはローカル ID
// - `termToCardId`   … 意味上の同一性。デデュープと再送判定だけに使う
// - `incomingCardId` … サーバーが採番した cardId をローカル ID へ写像する
const cardData = new Map(); // localCardId → TermCard
// **キーは生の term 文字列**(正規化しない)。#38 以前の `cardData.get(card.term)` と
// 完全に同じ突き合わせにするため。ここに正規化を入れるとデデュープの挙動が変わる。
const termToCardId = new Map(); // term → localCardId
const incomingCardId = new Map(); // serverCardId → localCardId
const highlightOwner = new Map(); // 表記(小文字) → 対応するカードの localCardId
let highlightRe = null;

// ローカル ID の採番(#38)。サーバー由来の `c\d+` と混ざらないよう `k` を前置する。
let nextLocalCardId = 0;
function newLocalCardId() {
  nextLocalCardId += 1;
  return `k${nextLocalCardId}`;
}

const LOCAL_CARD_ID_RE = /^k\d+$/;

/**
 * 新規カードのローカル ID を決める(#38)。
 *
 * 保存データの `cardId` は**保存時点のローカル ID**なので、`k\d+` ならそのまま採用して
 * 採番カウンタを追い越させる（復元しても ID が変わらない ＝ AC「保存/復元で cardId が
 * 維持される」）。サーバー由来の `c\d+` と、#38 以前の保存データ（cardId なし）は新しく採る。
 *
 * **すでに使われている ID なら採用しない。** localStorage は改変・破損しうる信頼境界の外で、
 * 「cardId 無しのカード」と「cardId: k1 のカード」が混じったスナップショットを食わせると、
 * 前者が採った k1 を後者が上書きして**カードが1枚黙って消える**（DOM には data-card-id が
 * 重複したまま残る）。壊れた値をここで無害化するのは `cardStatus()` と同じ方針。
 */
function adoptLocalCardId(incoming) {
  if (typeof incoming === "string" && LOCAL_CARD_ID_RE.test(incoming) && !cardData.has(incoming)) {
    nextLocalCardId = Math.max(nextLocalCardId, Number(incoming.slice(1)));
    return incoming;
  }
  return newLocalCardId();
}

/**
 * 受信 ID(`c\d+`) → ローカル ID の写像を貼る(#38)。
 *
 * **新規・再送の両方から呼ぶ。** 片方でも漏らすと `card_update` が
 * `incomingCardId.get()` で undefined を引き、**例外も出さずに更新を捨てる**
 * （検証に回ったカードが「確認中」のまま会議の終わりまで回り続ける）。
 * 1関数に括ってあるのは、呼び忘れをテストで数えられるようにするため。
 */
function registerIncoming(serverCardId, localId) {
  if (serverCardId) incomingCardId.set(serverCardId, localId);
}

/**
 * 受信 ID の写像で `fromId` を指すエントリを**すべて** `toId` へ張り替える(#40)。
 *
 * **1つだけ直しても足りない。** 再接続でサーバーの採番は c1 から振り直されるので、
 * 同じカードを指す serverCardId が複数溜まりうる(`addCard` の再送経路が貼り替える)。
 * 統合で片方の localId が消えるとき、残った写像は**消えたカードを指したまま**になり、
 * 以降の `card_update` が `cardData.get()` で undefined を引いて静かに捨てられる。
 */
function reassignIncomingCardId(fromId, toId) {
  for (const [serverCardId, localId] of incomingCardId) {
    if (localId === fromId) incomingCardId.set(serverCardId, toId);
  }
}

/**
 * ハイライトの持ち主で `fromId` を指すキーを**すべて** `toId` へ張り替える(#40)。
 *
 * `highlightOwner` は**追加専用**（`addHighlightTerm` は既存キーを上書きしない）で、
 * 削除も付け替えも API が無かった。統合でカードが1枚消えると、そのカードが持っていた
 * 表記のハイライトは**タップしても何も起きない**（`jumpToCard` が DOM を引けない）。
 *
 * **キーは変えないので正規表現は組み直さない。** 値だけの付け替えなので、
 * `addHighlightTerm` が行う `highlightRe` の再構築は要らない。
 */
function reassignHighlightOwner(fromId, toId) {
  for (const [form, owner] of highlightOwner) {
    if (owner === fromId) highlightOwner.set(form, toId);
  }
}

/**
 * ローカル ID から DOM のカード要素を引く(#38)。
 *
 * **検索をここ1箇所に集約する。** 各所で `[...cardsEl.children].find(...)` を書くと、
 * 識別子を変えるたびに置換漏れが出る（漏れても例外は出ず、更新が静かに届かなくなる）。
 */
function findCardEl(cardId) {
  return [...cardsEl.children].find((c) => c.dataset.cardId === cardId);
}

function addHighlightTerm(form, cardId) {
  if (!form || !form.trim()) return;
  const key = form.trim().toLowerCase();
  if (!highlightOwner.has(key)) highlightOwner.set(key, cardId);
  // 長い語を優先マッチさせるため、長さ降順で正規表現を組み直す
  const patterns = [...highlightOwner.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  highlightRe = new RegExp(patterns.join("|"), "gi");
}

function renderLine(text) {
  const line = el("span", "line");
  if (!highlightRe) {
    line.textContent = text + " ";
    return line;
  }
  highlightRe.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = highlightRe.exec(text)) !== null) {
    if (m.index > last) line.append(text.slice(last, m.index));
    const span = el("span", "hl", m[0]);
    // 持ち主はカードのローカル ID(#38)。正規表現は highlightOwner のキーから組むので
    // 通常は必ず引けるが、引けなかったときは属性を付けない（タップしても何も起きない）
    const owner = highlightOwner.get(m[0].toLowerCase());
    if (owner) span.dataset.cardId = owner;
    line.append(span);
    last = m.index + m[0].length;
  }
  line.append(text.slice(last) + " ");
  return line;
}

// ハイライト語のタップ → 該当カードへスクロールして一瞬光らせる
$("transcript").addEventListener("click", (e) => {
  const hl = e.target.closest(".hl");
  if (hl?.dataset.cardId) jumpToCard(hl.dataset.cardId);
});

// ---- 表示するカードの選択 ----
// 縦積みレイアウト(スマホ)では .active の1枚だけを CSS で表示する。
// 既定は「最新に追従」。会話中の用語をタップするとその語に固定し、「最新」で追従に戻す。
// 横並びレイアウトでは全カードが見えるので、この状態は表示に影響しない。
// 追従/固定の対象は **カードのローカル ID**(#38)。同じ term のカードが増えても
// 取り違えないよう、term ではなく識別子で指す。
let activeCardId = null;
let pinnedToCard = false;
// style.css の @media (max-width: 899px) と対になっている。片方だけ変えないこと
const stackedLayout = window.matchMedia("(max-width: 899px)");

/**
 * 「その他の用語」を展開しているか(#44)。**セッション内だけの状態**で永続化しない
 * (Issue の要件: 折りたたみ状態はセッション内で維持すれば十分)。
 */
let lowExpanded = false;

/**
 * 追従・巡回の対象になるカードのローカル ID(#44)。折りたたみ中は `low` を除く。
 *
 * **これは UX の好みではなく、空画面を防ぐための必要条件。** 縦積み(スマホ)では
 * `.card` が既定で `display:none` で、`.active` の1枚だけが出る。そこへ
 * 「折りたたみ中の low を隠す」規則が加わるので、`activeCardId` が low を指した瞬間に
 * **表示できるカードが1枚も無くなる**(low は折りたたみで消え、他は .active が無い)。
 * `addCard()` は追従中なら新しいカードを無条件に active にするため、low が届いた
 * だけでその状態になりうる。
 *
 * **`cardData` そのものは絞らない。** Markdown エクスポートと保存は全カードを見る
 * (AC: low を落とさない)。ここで絞るのは「いま画面に出せるカード」だけ。
 */
function visibleCardIds() {
  return [...cardData.keys()].filter(
    (id) => lowExpanded || cardImportance(cardData.get(id)) !== "low",
  );
}

function setActiveCard(cardId) {
  activeCardId = cardId;
  for (const card of cardsEl.children) {
    card.classList.toggle("active", card.dataset.cardId === cardId);
  }
  renderCardNav();
}

// ---- 「その他の用語」の折りたたみ(#44) ----
// **DOM は #cards 直下のまま**にする。`<details>` の別コンテナへ移すと
// `findCardEl()` / `setActiveCard()` / `mergeRenamedCard()` の `cardsEl.children` 走査が
// 引けなくなり、**例外を出さずに card_update が low カードだけ届かなくなる**。
// `#cards` は flex column なので、CSS の `order` で「下部へ寄せる」がDOMを動かさずに済む。
//
// トグル行に `.card` クラスを付けないのは `.error-banner` と同じ理由 —
// 縦積みの `#cards .card { display:none }` を受けず、入口として常に見えるようにするため。
let lowToggle = null;

function lowCardCount() {
  let n = 0;
  for (const card of cardData.values()) if (cardImportance(card) === "low") n++;
  return n;
}

function setLowExpanded(expanded) {
  if (lowExpanded === expanded) return;
  lowExpanded = expanded;
  cardsEl.classList.toggle("show-low", lowExpanded);
  renderLowToggle();
  // 巡回対象が変わるので件数表示を作り直す。追従中に low が可視化されたときは
  // 表示を動かさない（人が展開した直後にカードが勝手に飛ぶのを避ける）
  renderCardNav();
}

function renderLowToggle() {
  const count = lowCardCount();
  if (count === 0) {
    lowToggle?.remove();
    lowToggle = null;
    return;
  }
  if (!lowToggle) {
    lowToggle = el("button", "low-toggle");
    lowToggle.type = "button";
    lowToggle.addEventListener("click", () => setLowExpanded(!lowExpanded));
    cardsEl.append(lowToggle);
  }
  lowToggle.textContent = `${lowExpanded ? "▼" : "▶"} その他の用語（${count}件）`;
  lowToggle.setAttribute("aria-expanded", String(lowExpanded));
}

function renderCardNav() {
  // 巡回対象は**いま画面に出せるカードだけ**(#44)。`cardData` を直に使うと、
  // 折りたたまれた low まで「N / M」に数えられ、辿り着けない番号が出る。
  // キーはローカル ID で挿入順 = 登場順なので、並びの意味は #38 前と同じ
  const ids = visibleCardIds();
  if (ids.length === 0) {
    cardNav.hidden = true;
    return;
  }
  cardNav.hidden = false;
  const index = ids.indexOf(activeCardId);
  const newer = index < 0 ? 0 : ids.length - 1 - index; // 表示中より後に出たカード数
  cardPosition.textContent = `${index + 1} / ${ids.length}　${pinnedToCard ? "固定中" : "最新に追従"}`;
  latestBtn.textContent = newer > 0 ? `最新 +${newer}` : "最新";
  latestBtn.disabled = !pinnedToCard;
}

latestBtn.addEventListener("click", () => {
  pinnedToCard = false;
  // 「最新」も可視カードの中で選ぶ(#44)。折りたたまれた low へ飛ぶと画面が空になる
  const ids = visibleCardIds();
  setActiveCard(ids[ids.length - 1] ?? null);
});

function jumpToCard(cardId) {
  const card = findCardEl(cardId);
  if (!card) return;
  // **折りたたまれた low へ飛ぶと何も見えない**(#44)。先に展開してから通常経路へ合流する。
  // 展開すると visibleCardIds() に low が入るので、この後の active 切り替えもそのまま効く。
  // DOM の付け替えもレイアウト確定待ちも要らず、クラス1つの付け外しで済む
  if (card.classList.contains("low")) setLowExpanded(true);
  // 縦積みのときだけ、タップした語に固定する(以後、新しいカードが出ても表示は変わらない)。
  // 横並びでは全カードが見えており、固定する意味がないうえ回転時に古いカードが残るため。
  if (stackedLayout.matches) {
    pinnedToCard = true;
    setActiveCard(cardId);
  }
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  card.classList.remove("flash");
  void card.offsetWidth; // reflow を挟んで連続タップでも再アニメーションさせる
  card.classList.add("flash");
}

function speakerLabel(speaker) {
  return "話者" + String.fromCharCode(65 + (speaker % 26)); // 話者A, 話者B, …
}

// 文字起こし全体を再描画する。話者が変わったら新しい段落+話者チップを付ける。
// カード追加時のハイライト反映も兼ねる。
function renderTranscript() {
  finalText.textContent = "";
  for (const group of groupUtterances(finalLines, { expectedSpeakers: getExpectedSpeakers() })) {
    if (group.type === "reconnect") {
      finalText.append(el("div", "reconnect-marker", "― 再接続(以降の話者ラベルは振り直し)―"));
      continue;
    }
    const { speaker } = group;
    const div = el("div", "utterance");
    // **中立化した行は話者色を付けない**(#50)。統合先を決められなかった minor speaker を
    // 「話者C」として見せないための表示なので、通常の話者チップと同じ見た目にすると
    // 「3人目がいる」という誤解が色付きのまま残る。
    // **`speaker == null`(raw で speaker が付かなかった行)の経路は変えない** —
    // あちらは従来どおりチップ無しで、こちらは中立チップ。原因が別なので見え方も分ける
    if (group.unresolved) {
      div.append(el("span", "speaker-chip speaker-chip-unresolved", UNRESOLVED_SPEAKER_LABEL));
    } else if (speaker != null) {
      div.append(el("span", `speaker-chip sp-${speaker % 6}`, speakerLabel(speaker)));
    }
    // run 単位で描く(#55)。同じ final 由来の断片は 1 つの run になるので、run をまたぐ語にも
    // ハイライトが当たる。`renderLine()` が run の末尾に付ける半角スペースが run 間の連結子
    for (const run of group.runs) div.append(renderLine(run));
    finalText.append(div);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---- 恒久エラーバナー ----
// サーバーが抽出を打ち切ったとき(例: OpenAI クレジット残高切れ)に表示する。
// ステータスバッジと違い後続の status メッセージで上書きされず、閉じるまで残り続ける。
// class を "card" にしない: #cards .card を1枚だけ表示する縦積みレイアウトの
// 対象から外れ、常に見えるようにするため(要件8)。
let errorBanner = null;

function showErrorBanner(message) {
  if (!errorBanner) {
    errorBanner = el("div", "error-banner");
    errorBanner.append(el("span", "error-banner-text"));
    const closeBtn = el("button", "error-banner-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "エラー通知を閉じる");
    closeBtn.addEventListener("click", () => {
      errorBanner.remove();
      errorBanner = null;
    });
    errorBanner.append(closeBtn);
    cardsEl.prepend(errorBanner);
  }
  // 同じエラーが複数回届いても増殖させず、既存の1枚を更新するだけにする(要件4)
  errorBanner.querySelector(".error-banner-text").textContent = message;
}

// web検索による清書: 解説を最新情報ベースに差し替え、関連リンクを表示
// http/https 以外のスキームを弾く(サーバー側 src/extract/enrich.ts の isHttpUrl と同じ検証)。
// サーバー側で既に弾いている想定だが、上流(web検索の citation)の出力形式に検証をかけず
// a.href に渡すのは危険なため、クライアント側でも多層防御として同じチェックを行う。

// カードのリンク一覧を linksEl に描画する共通関数。addCard(cards受信・セッション復元)と
// updateCard(card_update)の両方から呼ぶことで、描画コードを二重に持たない(#10)。
// 戻り値は実際に描画できた件数(スキーム不正なリンクは除く)。
function renderCardLinks(linksEl, links) {
  linksEl.textContent = "";
  let shown = 0;
  for (const link of links ?? []) {
    // スキームが不正なリンクは要素自体を作らずスキップする(テキストとしても出さない)
    if (!isHttpUrl(link.url)) continue;
    const a = el("a", "link", link.title);
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    linksEl.append(a);
    shown++;
  }
  return shown;
}

// カードの見出し部（状態クラス・見出し・バッジ・音声表記）を card の**現在の中身から
// 組み直す**。addCard と updateCard の両方が呼ぶ(#24)。
//
// updateCard で `probable → unresolved` の降格が起きると、見出しそのものが term から
// surface form に変わる。差分だけを当てにいくと「バッジは消えたが見出しは古いまま」の
// 中途半端な状態が作れてしまうので、状態に依存する部分は毎回まとめて作り直す。
function renderCardHead(div, card) {
  const status = cardStatus(card);
  const heading = cardHeading(card);
  div.classList.remove("confirmed", "probable", "unresolved");
  div.classList.add(status);
  // 表示優先度のクラスも**ここで付け外しする**(#44)。renderCardHead は addCard と
  // updateCard の両方が通る唯一の再構築点なので、片方だけ付け忘れる形が作れない。
  // 折りたたみは CSS 側(`#cards:not(.show-low) .card.low`)がこのクラスだけを見る
  div.classList.toggle("low", cardImportance(card) === "low");

  let header = div.querySelector(".card-header");
  if (!header) {
    header = el("div", "card-header");
    div.prepend(header);
  }
  header.textContent = "";
  header.append(el("span", "term", heading));
  // unresolved の reading は「特定できなかった用語」の読みなので出さない。
  // 見出しが surface form(カタカナ)になっている以上、読み仮名を添える意味もない。
  if (status !== "unresolved" && card.reading) {
    header.append(el("span", "reading", card.reading));
  }
  if (status === "probable") header.append(el("span", "maybe", "もしかして?"));
  if (status === "unresolved") header.append(el("span", "unknown", `❓ ${UNRESOLVED_LABEL}`));

  // 「音声: 〜」は見出しと違う表記のときだけ意味がある。unresolved では見出し自体が
  // 聞き取られた表記なので、同じ文字列を2行に並べない。
  div.querySelector(".corrected")?.remove();
  if (card.correctedFrom && card.correctedFrom !== heading) {
    header.after(el("div", "corrected", `音声: ${card.correctedFrom}`));
  }
}

/**
 * カードを1枚受け取り、**そのカードのローカル ID を返す**（#38）。
 *
 * 戻り値を返すのは、呼び出し側（`cards` 受信・セッション復元）が続けて
 * `addHighlightTerm()` にカードの持ち主を渡すため。ここで採番したローカル ID は
 * 呼び出し側からは他に知りようがない。
 */
function addCard(card) {
  // 突き合わせは **term**（意味上の同一性）。cardId で引くと、再接続でサーバーの採番が
  // c1 から振り直されたときに同じ用語がもう1枚生えて #8 の重複が復活する
  const existingId = termToCardId.get(card.term);
  const existing = existingId === undefined ? undefined : cardData.get(existingId);
  if (existing) {
    // **受信 ID の写像は畳み込みの可否に関わらず必ず貼り替える(#38 / R1)。**
    // 再接続でサーバーは c1 から採番し直すので、同じ用語が別の cardId で再送される。
    // ここで貼り替えないと、後続の card_update が**どのカードにも当たらない**
    // （`incomingCardId.get()` が undefined になり、静かに無視される）。
    registerIncoming(card.cardId, existingId);
    // 同じ term のカードが再送されても DOM を新規に作らない(冪等化, #8)。
    // 再接続直後はサーバー側のデデュープ状態が空から始まるため、既出用語が再びカードとして
    // 届きうる。清書済み(既存 links がある)ならドラフト(links: [])で
    // description/links を上書きしない。未清書ならドラフト説明の更新は許可する。
    // 畳み込むかの判断は shouldApplyResend() に集約する（DOM 抜きで固定するため）
    if (shouldApplyResend(existing)) {
      existing.description = card.description;
      existing.willEnrich = card.willEnrich;
      // status は上書きしない。「unresolved から上へは戻さない」は再接続の経路でも守る
      const div = findCardEl(existingId);
      if (div) {
        div.querySelector(".desc").textContent = card.description;
        const linksEl = div.querySelector(".links");
        if (card.willEnrich && !linksEl) {
          div.append(el("div", "links pending", "🔎 最新情報を確認中…"));
        } else if (!card.willEnrich) {
          linksEl?.remove();
        }
      }
      scheduleSessionSave();
    }
    return existingId;
  }

  // 新規カード。ローカル ID を決めてから3本の Map をそろえて更新する
  const localId = adoptLocalCardId(card.cardId);
  registerIncoming(card.cardId, localId);
  // **保持するカードの cardId はローカル ID に差し替える。** 保存/復元でそのまま
  // 使い回せるようにするため（スナップショットの cardId ＝ 保存時点のローカル ID）
  cardData.set(localId, { ...card, cardId: localId });
  termToCardId.set(card.term, localId);
  const div = el("div", "card");
  // **DOM の識別子はローカル ID(#38)。** 見出しが surface form になっても
  // カードの identity は動かない（#24 の「改名しない」はそのまま維持される）。
  div.dataset.cardId = localId;
  renderCardHead(div, card);
  div.append(el("div", "desc", card.description));
  // リンクは renderCardLinks で描画する(updateCard と共通)。清書済み(links がある)なら
  // willEnrich の真偽によらずリンクを出す。復元直後は WS が無く card_update が来ないため、
  // ここでリンクを出さないと清書済みカードでも「確認中」のまま固まってしまう(#10)。
  // 「確認中」は清書前(links が空)かつ willEnrich のときだけに限定する。
  //
  // **unresolved はリンクを一切出さない(#24)。** どの用語か特定できていない以上、
  // 関連リンクは「別の用語の資料」になりかねない。そもそも検証にも回さないので
  // (`selectVerifyTargets` が除く)、「確認中」を見せても更新は来ない。
  if (cardStatus(card) !== "unresolved") {
    const linksEl = el("div", "links");
    div.append(linksEl);
    if (renderCardLinks(linksEl, card.links) === 0) {
      if (card.willEnrich) {
        linksEl.classList.add("pending");
        linksEl.textContent = "🔎 最新情報を確認中…";
      } else {
        linksEl.remove();
      }
    }
  }
  // バナーがあればその直後に挿入し、バナーを常に先頭に保つ
  cardsEl.insertBefore(div, errorBanner ? errorBanner.nextSibling : cardsEl.firstChild);
  // 「その他の用語」の件数はカードが増えるたびに変わる(#44)。
  // **DOM への追加より後**に呼ぶ — トグル行は cardsEl.append() で末尾に置くので、
  // 先に呼ぶと新しいカードがトグル行より後ろに入る(CSS の order で見た目は揃うが、
  // DOM 順は登場順の意味を持つので崩さない)
  renderLowToggle();
  // 追従中なら新しいカードに切り替える。固定中は表示を動かさず件数だけ更新する。
  // **折りたたまれた low には追従しない**(#44) — 縦積みで表示できるカードが
  // 1枚も無い状態になるため。可視でないカードが来たときは件数だけ更新する
  if (pinnedToCard || !visibleCardIds().includes(localId)) renderCardNav();
  else setActiveCard(localId);
  scheduleSessionSave();
  return localId;
}

/**
 * 改名で新しい term が既存カードと衝突したときの統合(#40)。**残す cardId を返す。**
 *
 * 統合ルール（どちらの cardId を残すか・surfaceForms / links をどう連結するか）は
 * `mergeDuplicateCards()` に置いてある。ここが担うのは**その結果を3本の Map・
 * ハイライト・選択状態・DOM に行き渡らせること**で、1つでも漏らすと
 * 「例外は出ないがカードが迷子になる」形で壊れる。
 *
 * @param renamedId 改名されたカードのローカル ID（内容はこちらが正）
 * @param otherId   同じ term を既に持っていたカードのローカル ID
 */
function mergeRenamedCard(renamedId, otherId) {
  // **残すのは登場順が早いほう。** `cardData` は挿入順（＝登場順）を保つ Map なので、
  // キーの並びがそのまま登場順になる。#38 の目的は ID の永続性で、既に画面に居て
  // 人が固定しているかもしれないカードを消さない
  const order = [...cardData.keys()];
  const keepId = order.indexOf(otherId) < order.indexOf(renamedId) ? otherId : renamedId;
  const dropId = keepId === renamedId ? otherId : renamedId;
  const renamed = cardData.get(renamedId);
  // 内容（term / reading / status / description / correctedFrom）は**再評価の結果**が正。
  // 残す側が先に居た別カードなら、その ID を保ったまま中身だけ移す。
  // links を写さないのは統合ルールで「残す側優先」だから（`mergeDuplicateCards`）
  const keepBase =
    keepId === renamedId
      ? renamed
      : {
          ...cardData.get(keepId),
          term: renamed.term,
          reading: renamed.reading,
          status: renamed.status,
          description: renamed.description,
          correctedFrom: renamed.correctedFrom,
        };
  const merged = mergeDuplicateCards(keepBase, cardData.get(dropId));
  // cardId はカードの主キー。統合後も残す側のものであることを明示しておく
  merged.cardId = keepId;
  cardData.set(keepId, merged);
  cardData.delete(dropId);
  // 意味上の同一性も残す側へ寄せる。両方のキーを消してから貼り直す
  termToCardId.set(merged.term, keepId);
  reassignIncomingCardId(dropId, keepId);
  reassignHighlightOwner(dropId, keepId);
  findCardEl(dropId)?.remove();
  // **固定中でも表示が飛ばないようにする。** `pinnedToCard` は真偽値なので付け替えは
  // 要らないが、`activeCardId` が消えた DOM を指したままだと縦積みレイアウトで
  // カードが1枚も表示されない画面になる
  // 統合で「その他の用語」の件数が変わる（低いほうが消える／統合で high に昇格する、#44）
  renderLowToggle();
  if (activeCardId === dropId) setActiveCard(keepId);
  else renderCardNav(); // 件数が1枚減るので位置表示だけ更新する
  return keepId;
}

function updateCard({ cardId, status, description, links, rename }) {
  // 受信 ID はサーバーの採番(`c\d+`)。ローカル ID へ写像してから引く(#38)。
  // 写像に無い ID は、このクライアントが持っていないカードへの更新なので黙って捨てる
  //
  // **旧サーバー（`term` だけを送る）との互換は取らない。** `mergeCardUpdate()` が
  // 「status を持たない旧サーバー」を考慮しているのと非対称に見えるが、あちらは
  // **localStorage から復元した古いカード**が相手で、こちらは**同時に動いている
  // 旧サーバー**が相手。前者は消えずに残り続けるのに対し、後者はデプロイで揃うので
  // 二重経路を残す価値がない（デプロイ跨ぎのタブはリロードで回復する）。
  const localId = incomingCardId.get(cardId);
  const stored = localId === undefined ? undefined : cardData.get(localId);
  // 表示の材料は cardData が正。stored が無ければ描く根拠が無いので何もしない
  // （合成すると surfaceForms が空になり、unresolved の見出しが**推定した term** に
  // 落ちる — 特定できていない用語名をバッジ付きで断定してしまう）。
  if (!stored) return;
  // **unresolved からは戻さない。** 再接続でカードが再抽出されると同じ用語が再び
  // Stage 2 に回り、今度は裏付けが取れることがある（LLM + web 検索なので非決定的）。
  // 昇格を許すと「特定できませんでした」が通常カードに戻り、見出しが surface form から
  // term に切り替わる。addCard の再送経路にも同じガードがあり、そちらと揃える。
  // **例外は `rename` を伴う再評価だけ**（#40）。term が同時に届くので見出しと本文が
  // 食い違わない。判断は mergeCardUpdate() に集約する（不変条件を DOM 抜きで固定するため）
  const previousTerm = stored.term;
  Object.assign(stored, mergeCardUpdate(stored, { status, description, links, rename }));

  // 改名が実際に効いたときだけ、意味上の同一性とハイライトを張り替える（#40）。
  // `rename` が来ても `mergeCardUpdate()` が据え置いた（＝term が動かなかった）場合まで
  // Map を触ると、消したキーを貼り直すだけの無駄な往復になる
  let targetId = localId;
  if (stored.term !== previousTerm) {
    // 旧 term のキーは必ず消す。残すと古い表記でカードが引かれ続け、
    // 別の用語のカードが後から同じ localId を掴む
    termToCardId.delete(previousTerm);
    const otherId = termToCardId.get(stored.term);
    if (otherId !== undefined && otherId !== localId && cardData.has(otherId)) {
      // 同じ用語のカードが既にある。2枚並べずに統合する（統合ルールは
      // mergeDuplicateCards() が持ち、Map / DOM への反映は mergeRenamedCard()）
      targetId = mergeRenamedCard(localId, otherId);
    } else {
      termToCardId.set(stored.term, localId);
    }
    // **古い surface form のハイライトは消さない。** 文字起こし本文は崩れた表記のまま
    // 残る（#40 は raw transcript を書き換えない）ので、消すと過去の行からカードへ
    // 辿れなくなる。新しい表記を足すだけにする
    const renamedCard = cardData.get(targetId);
    addHighlightTerm(renamedCard.term, targetId);
    addHighlightTerm(renamedCard.correctedFrom, targetId);
    for (const form of renamedCard.surfaceForms ?? []) addHighlightTerm(form, targetId);
    renderTranscript();
  }

  scheduleSessionSave();
  const div = findCardEl(targetId);
  if (!div) return;
  // 状態の判定はカード全体を渡して cardStatus() に任せる（`status` を直接読まない）。
  // **統合が起きると描く対象は別のカードになる**ので、message ではなく cardData から引く
  const card = cardData.get(targetId);
  // 検証の結果で見出しが変わりうる（probable → unresolved の降格で surface form になる、
  // #40 の再評価で unresolved から確定した用語へ改名される）
  renderCardHead(div, card);
  div.querySelector(".desc").textContent = card.description;

  let linksEl = div.querySelector(".links");
  if (cardStatus(card) === "unresolved") {
    // 特定できなかったカードにリンクは出さない(addCard と同じ理由)。
    // サーバーは棄却時に links: [] を送るが、ここでも落としておく
    linksEl?.remove();
    return;
  }
  if (!linksEl) {
    linksEl = el("div", "links");
    div.append(linksEl);
  }
  linksEl.classList.remove("pending");
  // **メッセージの links ではなく畳み込み後のカードから描く。** 統合では残す側の
  // リンクが優先されるので、引数をそのまま描くと DOM と cardData がずれる
  if (renderCardLinks(linksEl, card.links) === 0) linksEl.remove();
}

// ---- Markdown エクスポート ----

const pad2 = (n) => String(n).padStart(2, "0");

function fmtDateTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtStamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
// 会議開始からの経過時間(fmtElapsed)は diagnostics.js が定義箇所(#46)。
// 話者の初出・最終を診断側で整形する必要があるので、両方に書かず import する。

// Markdown の記号が含まれても記法として解釈されないようにする。
// 記号を含まない文字列は素通りするので、通常の発話では出力は変わらない。
// 括弧を含む URL は <> で囲む(囲まないとリンクが途中で切れる)

function buildTranscriptMarkdown() {
  const started = sessionStartedAt ?? new Date();
  const ended = sessionEndedAt ?? new Date();
  const out = [
    `# 文字起こし ${fmtDateTime(started)}`,
    "",
    `- 開始: ${fmtDateTime(started)}`,
    `- 終了: ${fmtDateTime(ended)}`,
    `- 発言数: ${spokenLines().length}`,
    "",
    "> TermLens による自動文字起こしです。音声認識の誤りを含む場合があります。",
    "> 時刻は会議開始からの経過時間(サーバーが確定結果を返した時点)です。",
    "",
    "---",
    "",
  ];
  for (const group of groupUtterances(finalLines, { expectedSpeakers: getExpectedSpeakers() })) {
    if (group.type === "reconnect") {
      out.push("---", "", "*再接続しました。以降の話者ラベルは振り直しです。*", "");
      continue;
    }
    const { speaker, t } = group;
    // 画面と同じ判断を同じ順で行う(#50)。**`speaker == null` の `発言` は据え置き** —
    // raw で speaker が付かなかった行と、中立化した行は別の事実
    const label = group.unresolved
      ? UNRESOLVED_SPEAKER_LABEL
      : speaker != null
        ? speakerLabel(speaker)
        : "発言";
    out.push(`**${label}** \`${fmtElapsed(t - started.getTime())}\``, "", group.runs.map(escMd).join(" "), "");
  }
  return out.join("\n");
}

// ---- 収音診断(#26) ----
// 画面の表と Markdown が **同じ行データ**(diagnostics.js)から描く。ラベルを両方に
// 書き写すと、項目を足したときに片方だけ増える。

// 診断が1つでも出せる状態か。mock モードや復元経路ではマイクを開いていないので false
const hasDiagnostics = () => diag !== null;

/**
 * テキスト完全性の③④をクライアント側で数える(#52)。
 *
 * **画面パネルと Markdown が同じ1回の計算を共有する。** 別々に数えると、同じセッションから
 * 段階別文字数の違う表が2つ出る(#48 の `planDisplayCorrection()` と同じ理由)。
 *
 * - ③は raw の `finalLines`(サーバーから届いた text をそのまま積んだもの)
 * - ④は `groupUtterances()` の出力。**表示・エクスポートと同じ引数で通すこと** —
 *   別の引数で呼ぶと、画面に出ていない補正結果の文字数を診断が報告する
 *
 * 文字数の数え方(`countTextChars`)は `diagnostics.js` が定義箇所。ここで数え直すと
 * 「空白を除く」の定義が3つ目になる。
 */
function textIntegrityStages() {
  // **サーバーから累計が来ていなければ数えない。** 呼び出し側は `textIntegrity` が
  // 無ければ節ごと落とすので、ここで表示パイプラインを1周しても結果は捨てられる
  // (会議中ずっと、開いたパネルの再描画のたびに全行を無駄に補正することになる)
  if (!textIntegrity) return { received: null, displayed: null };
  const lines = sinceLastReconnect(finalLines);
  const displayedTexts = [];
  // **範囲を切るのはグループにしてから**(#52)。#48 の統合は全体の語数比で決まるので、
  // 切った行に対して組み直すと画面に出ているのと違うグループを数えることになる
  for (const group of sinceLastReconnect(
    groupUtterances(finalLines, { expectedSpeakers: getExpectedSpeakers() }),
  )) {
    if (group.texts) displayedTexts.push(...group.texts);
  }
  return {
    received: countTextChars(lines.filter((l) => l.type !== "reconnect").map((l) => l.text)),
    displayed: countTextChars(displayedTexts),
  };
}

function renderDiagnostics() {
  // **畳んだままなら描かない。** 統計は毎秒届くが、既定で閉じている <details> の
  // 中身を作り直しても誰も見ない(会議中ずっと捨てる仕事になる)。開いた瞬間に
  // toggle から呼ぶので、表示される内容は変わらない
  if (!diagPanel.open) return;
  diagTable.textContent = "";
  // **統計は raw から(#46)、表示補正の計画は `planDisplayCorrection()` から(#48)。**
  // 計画を raw の finalLines に直接当ててはいけない — 表示に効くのは jitter 補正を
  // 通した後の行に対する計画なので、raw から立てると診断の件数が表示とずれる
  // (詳細は utterances.js の planDisplayCorrection() のコメント)。
  // ここと buildDiagnosticsMd() は同じ形にすること
  const speakerStats = collectSpeakerStats(finalLines);
  const { boundaryPlan, plan: islandPlan, unresolvedPlan, displayDetected } = planDisplayCorrection(finalLines, {
    expectedSpeakers: getExpectedSpeakers(),
  });
  const stages = textIntegrityStages();
  const rows = [
    // 収音側はマイクを開いた区間の値。話者統計は finalLines に紐づく別のライフタイムなので、
    // 片方が空でももう片方は出す(復元セッションでは話者統計だけが出る)(#46)
    ...(hasDiagnostics()
      ? [
          ["収音モード", captureModeLabel(diag.mode)],
          ...trackSettingRows(diag.trackSettings, diag.contextSampleRate),
          ...audioStatRows(diag.stats),
        ]
      : // **黙って省かない。** Markdown 側は同じ状況で見出し +「(取得できませんでした)」を
        // 必ず出すので、ここだけ行ごと消すと「項目が無い」のか「取れなかった」のかを
        // 画面から区別できず、`diagnostics.js` 冒頭の「画面と Markdown が同じものを描く」
        // という主張が崩れる
        [["収音の統計", "(取得できませんでした)"]]),
    ...speakerDiagRows({
      speakerStats,
      expectedSpeakers: getExpectedSpeakers(),
      sttInfo,
      boundaryPlan,
      islandPlan,
      unresolvedPlan,
      displayDetected,
    }),
    // テキスト完全性(#52)。サーバーから `text_integrity` を1件も受けていなければ
    // 行ごと出ない(「0文字」と「未取得」を混同させない)
    ...textIntegrityRows({
      integrity: textIntegrity,
      received: stages.received,
      displayed: stages.displayed,
    }),
  ];
  for (const [label, value] of rows) {
    const tr = el("tr");
    tr.append(el("td", null, label), el("td", null, value));
    diagTable.append(tr);
  }
}

// パネルの開閉で高さが変わる。横並びレイアウトの --live-chrome を取り直す
diagPanel.addEventListener("toggle", () => {
  renderDiagnostics();
  measureLiveChrome();
});

function buildDiagnosticsMd() {
  const started = sessionStartedAt ?? new Date();
  const ended = sessionEndedAt ?? new Date();
  // **統計は raw から(#46)、表示補正の計画は `planDisplayCorrection()` から(#48)。**
  // 計画を raw の finalLines に直接当ててはいけない — 表示に効くのは jitter 補正を
  // 通した後の行に対する計画なので、raw から立てると診断の件数が表示とずれる
  // (詳細は utterances.js の planDisplayCorrection() のコメント)。
  // ここと renderDiagnostics() は同じ形にすること
  const speakerStats = collectSpeakerStats(finalLines);
  const { boundaryPlan, plan: islandPlan, unresolvedPlan, displayDetected } = planDisplayCorrection(finalLines, {
    expectedSpeakers: getExpectedSpeakers(),
  });
  const stages = textIntegrityStages();
  // 整形は diagnostics.js の純関数に任せる(テストから読めるようにするため)。
  // trackSettings は既に採用リストを通してあるが、整形側でももう一度通る
  return buildDiagnosticsMarkdown({
    // マイクを開いていない復元セッションでは収音モードが分からない。既定モードを
    // 書くと「実際には別のモードで録ったかもしれない値」が事実として残るので渡さない
    modeLabel: hasDiagnostics() ? captureModeLabel(diag.mode) : null,
    startedAt: fmtDateTime(started),
    // 話者の初出・最終を**相対時間**にするための基準。絶対時刻は診断に出さない
    startedAtMs: started.getTime(),
    elapsed: fmtElapsed(ended.getTime() - started.getTime()),
    trackSettings: diag?.trackSettings,
    contextSampleRate: diag?.contextSampleRate,
    stats: diag?.stats,
    // **raw の finalLines から集計する。** groupUtterances() の結果を渡すと、
    // 表示補正の効き具合を測るための統計が補正後の値になる(#46)
    speakerStats,
    expectedSpeakers: getExpectedSpeakers(),
    sttInfo,
    boundaryPlan,
    islandPlan,
    unresolvedPlan,
    displayDetected,
    // ③④は1回の計算から両方取る(#52)。2回呼ぶと、その間に届いた final の行が
    // 片方にだけ入り、③と④が別々の時点の画面を指す
    textIntegrity,
    receivedChars: stages.received,
    displayedChars: stages.displayed,
  });
}

function buildTermsMarkdown() {
  // 整形は `terms-markdown.js` の純関数に任せる（テストから読めるようにするため）。
  // ここは画面の状態（開始時刻・カード順）を渡すだけ。
  return buildTermsMarkdownPure([...cardData.values()], fmtDateTime(sessionStartedAt ?? new Date()));
}

// ホーム画面に追加した PWA では <a download> が働かない場合があるため、
// スタンドアロン表示かつファイル共有に対応していれば共有シートを優先する。
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// 保存できたら true、ユーザーがキャンセルしたら false を返す
async function saveMarkdown(filename, text) {
  const file = new File([text], filename, { type: "text/markdown" });
  if (isStandalone() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      if (err.name === "AbortError") return false; // ユーザーがキャンセルした
      // それ以外は下のダウンロードにフォールバックする
    }
  }
  const url = URL.createObjectURL(file);
  const a = el("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  // ホーム画面追加の PWA では <a download> が黙って何もしないことがあり、
  // 成否を知る手段がない。保存できたと見なさず、未保存警告を残す側に倒す
  return !isStandalone();
}

dlTranscriptBtn.addEventListener("click", async () => {
  const stamp = fmtStamp(sessionStartedAt ?? new Date());
  if (await saveMarkdown(`termlens-transcript-${stamp}.md`, buildTranscriptMarkdown())) {
    savedTranscript = true;
    discardWarned = false; // 保存後は未保存のものが減るので、警告をやり直す
  }
});
dlTermsBtn.addEventListener("click", async () => {
  const stamp = fmtStamp(sessionStartedAt ?? new Date());
  if (await saveMarkdown(`termlens-terms-${stamp}.md`, buildTermsMarkdown())) {
    savedTerms = true;
    discardWarned = false;
  }
});
// 診断は会話本文を含まないため、未保存警告(discardWarned)の対象にしない。
// 対象にすると、診断を見ていない大多数のセッションでも「戻る」が毎回警告になり、
// 本当に守りたい文字起こし・用語カードの警告まで無視されるようになる(#26)
dlDiagnosticsBtn.addEventListener("click", async () => {
  const stamp = fmtStamp(sessionStartedAt ?? new Date());
  await saveMarkdown(`termlens-diagnostics-${stamp}.md`, buildDiagnosticsMd());
});

function showExport() {
  sessionEndedAt ??= new Date();
  dlTranscriptBtn.disabled = spokenLines().length === 0;
  dlTermsBtn.disabled = cardData.size === 0;
  // **復元セッションでも押せる。** マイクを開いていなくても話者統計は出せるので、
  // 収音側の有無(hasDiagnostics)だけで閉じると #46 の診断が取り出せない
  dlDiagnosticsBtn.disabled = !hasDiagnostics() && spokenLines().length === 0;
  // 押せる内容があるならパネルも出す。条件を1つにして「ボタンは押せるのに
  // 画面には何も無い」状態を作らない
  diagPanel.hidden = dlDiagnosticsBtn.disabled;
  // **停止時にも描き直す。** 他の呼び出し元(開始時 / worklet の stats / stt_info 受信 /
  // toggle)はどれも停止後には来ないので、パネルを開いたまま停止すると、停止時の flush で
  // 届いた final がパネルに反映されず、ダウンロードした Markdown とだけ食い違う
  renderDiagnostics();
  exportRow.hidden = false;
  measureLiveChrome();
}

// ---- セッション保存・復元 ----
// 状態はブラウザメモリにしかなく、リロード・タブ破棄・端末のスリープで全消失する。
// エクスポート(上記)は「停止まで到達できた場合」しか使えないため、進行中の状態も
// localStorage に書いておき、次回起動時に復元できるようにする(Issue #9 後半)。
// 保存しない: 音声そのもの、アクセストークン(トークンは別キーで既に保存されている)

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // これを超えたら読み込み時に案内も出さず破棄する(要件4)
const SESSION_SAVE_DEBOUNCE_MS = 1000; // 文字起こしは数秒に1回、カード更新も走るため毎回書くと重い(要件2)
// 目安1MB。文字数で近似する(UTF-16なので実バイト数とは厳密には一致しない)。
// 多くのブラウザの localStorage 上限(5MB前後)に対して余裕を持たせる(L5)
const SESSION_MAX_CHARS = 1 * 1024 * 1024;

function deleteSavedSession() {
  try { localStorage.removeItem("termlens.session"); } catch {}
}

function buildSessionSnapshot() {
  return {
    savedAt: Date.now(),
    sessionStartedAt: sessionStartedAt ? sessionStartedAt.getTime() : null,
    finalLines,
    // Map は JSON化できないため配列に落とす。要素は [localCardId, card](#38)。
    // キーとカード側の `cardId` は常に同値だが、**復元が読むのは card.cardId のほう**
    // （キーは捨てる）。形を変えないのは #38 以前の保存データと同じ構造で読めるようにするため
    cardData: [...cardData],
  };
}

// 実際に書き出す。呼び出し元は scheduleSessionSave() 経由が基本(デバウンス、要件2)。
// visibilitychange(hidden) での即時書き出しだけこの関数を直接呼ぶ。
function trySaveSession() {
  // captureActive を「保存すべき区間か」の判定に流用している。finalLines/cardData が
  // 変化しうるのはマイク/WS を保持している間(停止後の flush 待ちも含む)だけなので、
  // 専用フラグを別に持つ必要がなかった
  if (!getPersistEnabled() || !captureActive) return;
  // 発言もカードもない空のセッションは保存しない。無意味な復元案内を出さないため(L2)
  if (finalLines.length === 0 && cardData.size === 0) return;
  let snapshot = buildSessionSnapshot();
  let json = JSON.stringify(snapshot);
  // 大きすぎる場合は古い finalLines から捨てて収める(要件6)。cardData は用語解説の
  // 本体なので削らない
  while (json.length > SESSION_MAX_CHARS && snapshot.finalLines.length > 0) {
    const drop = Math.max(1, Math.ceil(snapshot.finalLines.length / 10));
    snapshot = { ...snapshot, finalLines: snapshot.finalLines.slice(drop) };
    json = JSON.stringify(snapshot);
  }
  try {
    localStorage.setItem("termlens.session", json);
  } catch {
    // 容量超過(QuotaExceededError 等)は finalLines を大きく削って1回だけ再試行する(L5)。
    // それでも失敗したら諦める。会議自体は止めない(要件6)
    try {
      const shrunk = { ...snapshot, finalLines: snapshot.finalLines.slice(-50) };
      localStorage.setItem("termlens.session", JSON.stringify(shrunk));
    } catch {
      /* 諦める */
    }
  }
}

let saveSessionTimer = null;
function scheduleSessionSave() {
  if (!getPersistEnabled()) return;
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(() => {
    saveSessionTimer = null;
    trySaveSession();
  }, SESSION_SAVE_DEBOUNCE_MS);
}

// ページが隠れる/閉じられる直前は取りこぼせない。beforeunload は iOS で発火が
// 不確実なため、visibilitychange の hidden を主経路にする(要件2)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  clearTimeout(saveSessionTimer);
  saveSessionTimer = null;
  trySaveSession();
});

// ---- 復元案内(ホーム画面) ----
let pendingRestoreSession = null;

function loadPendingSession() {
  let raw;
  try {
    raw = localStorage.getItem("termlens.session");
  } catch {
    return null;
  }
  if (!raw) return null;
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null; // 壊れたJSONは復元しようがないので無視する
  }
  if (!session || typeof session !== "object") return null;
  if (!session.savedAt || Date.now() - session.savedAt > SESSION_MAX_AGE_MS) {
    deleteSavedSession(); // 期限切れは案内を出さずに破棄する(要件4)
    return null;
  }
  // finalLines/cardData が配列でない壊れたデータは復元しようがないので破棄する(L3)。
  // ここで弾いておけば、復元処理側で catch する例外は「配列の中身」に起因するものに絞れる
  if (!Array.isArray(session.finalLines) || !Array.isArray(session.cardData)) {
    deleteSavedSession();
    return null;
  }
  return session;
}

function checkPendingSession() {
  // 保存 OFF なら復元案内を出さない。OFF 時点で保存データ自体も消しているが、
  // 手動で termlens.persist だけ触られた場合の防御として読み込み側でも見る(L1)
  if (!getPersistEnabled()) return;
  pendingRestoreSession = loadPendingSession();
  if (!pendingRestoreSession) return;
  const started = pendingRestoreSession.sessionStartedAt
    ? new Date(pendingRestoreSession.sessionStartedAt)
    : new Date(pendingRestoreSession.savedAt);
  // 再接続の区切り印は発言ではないので、spokenLines() と同じく数から除く
  const spoken = pendingRestoreSession.finalLines.filter((l) => l.type !== "reconnect").length;
  const cardCount = pendingRestoreSession.cardData.length;
  // 発言もカードもない空のセッションは、案内を出さず破棄する(L2)
  if (spoken === 0 && cardCount === 0) {
    deleteSavedSession();
    pendingRestoreSession = null;
    return;
  }
  restoreInfo.textContent = `${fmtDateTime(started)} の会議・発言 ${spoken} 件・カード ${cardCount} 件`;
  restoreBanner.hidden = false;
}

// 「復元する」: 本番画面を終端状態(停止後と同じ)で開く。録音は再開せず WebSocket も張らない —
// 復元の目的は失われた内容を持ち出せるようにすることであり、会議の続きを録るのは別の話(要件3)
restoreBtn.addEventListener("click", () => {
  if (!pendingRestoreSession) return;
  const session = pendingRestoreSession;
  pendingRestoreSession = null;
  restoreBanner.hidden = true;

  // loadPendingSession() で形の壊れたデータはある程度弾いているが、中身(card の形など)
  // までは検証していない。復元中の例外で案内だけ消えて操作不能にならないよう、
  // 保存データを丸ごと信頼せず try/catch で囲む(L3)
  try {
    resetSessionState();
    sessionStartedAt = session.sessionStartedAt ? new Date(session.sessionStartedAt) : new Date(session.savedAt);
    sessionEndedAt = new Date(session.savedAt); // 会議の「終了」ではなく最後に保存できた時刻
    finalLines.push(...session.finalLines);
    for (const [, card] of session.cardData) {
      // addCard の新規分岐が cardId の維持（`k\d+` はそのまま採用）と、
      // #38 以前の保存データ（cardId なし）への採番の両方を吸収する
      const id = addCard(card);
      // カードを描き直すだけでは会話中の用語がオレンジ表示にならないため、
      // "cards" 受信時(connectWs 内)と同じくハイライトも復元する
      addHighlightTerm(card.term, id);
      addHighlightTerm(card.correctedFrom, id);
      for (const form of card.surfaceForms ?? []) addHighlightTerm(form, id);
    }
    renderTranscript();
    finished = true;
    // 停止経由は finish() が finishing=true を立てるが、復元経由はここまで finish() を
    // 通らない。将来 finish() を呼ぶ経路が増えたときの多重実行ガードを効かせるため、
    // 復元完了時点でも立てておく(L6)
    finishing = true;
    stopBtn.textContent = "戻る";
    setStatus("復元しました(録音は再開していません)");
    showLive();
    showExport();
  } catch (err) {
    console.error("[restore] failed:", err);
    // 途中まで書き込まれた内容を残すと、次のセッションの shownTerms に混ざって
    // 新しい会議の用語がデデュープで弾かれる。必ず空に戻してからホームへ返す
    clearSessionContent();
    // 壊れた保存データを残しても次回また同じ例外になるだけなので破棄し、ホームに留まる
    deleteSavedSession();
    showHome();
    showError("保存されていたデータが壊れていたため、復元できませんでした。");
  }
});

discardBtn.addEventListener("click", () => {
  deleteSavedSession();
  pendingRestoreSession = null;
  restoreBanner.hidden = true;
});

checkPendingSession();

// ---- 停止 / 戻る ----
// 1つのボタンが「停止」と「戻る」を兼ねる。ハンドラも1本にする
// (onclick を別に足すと、押すたびに停止処理まで走って警告状態がリセットされる)。
let finished = false;   // 終端処理が完了し、ボタンが「戻る」になっているか
let finishing = false;  // 終端処理の実行中(多重実行を防ぐ)
let discardWarned = false;

stopBtn.addEventListener("click", async () => {
  // 再接続の待機中(setTimeout待ち)なら、まずそれを止める。
  // 残したまま停止処理を進めると、片付けが終わった後にタイマーが発火して
  // 勝手に再接続してしまう
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  if (finished) {
    // 「戻る」。リロードで内容を破棄するため、未保存のものがあれば1回目は警告に留める
    // (確認ダイアログは PWA で扱いが不安定なため使わない)。
    // 片方だけ保存した場合も、保存していない側は失われるので警告する
    const unsaved =
      (spokenLines().length > 0 && !savedTranscript) || (cardData.size > 0 && !savedTerms);
    if (unsaved && !discardWarned) {
      discardWarned = true;
      setStatus("未保存です。もう一度押すと破棄");
      return;
    }
    // 会議を正常に終えてホームへ戻るので、持ち出しも済んだはずの保存データは残さない(要件6)
    deleteSavedSession();
    location.reload();
    return;
  }

  if (stopping) return; // 停止処理の最中は二重に走らせない
  sendAudio = false;
  stopping = true;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    // 残りの抽出結果(flush)を受け取る猶予
    setStatus("まとめ中…");
    setTimeout(() => {
      ws?.close();
      finish();
    }, 8000);
  } else {
    finish();
  }
});

// マイク・AudioContext・Wake Lock を解放する。セッションが終わる経路すべてで必ず通す。
// 解放を怠るとページをリロードするまでマイクが掴まれたままになる。
async function releaseCapture() {
  // ws.close() は同期呼び出しなので ws を null で外す前に呼ぶ。CONNECTING 中でも
  // 閉じられる。ここで閉じないまま ws=null にすると、接続試行中に停止した場合に
  // ソケットが開いたまま残り、後から届く open ハンドラがステータス表示を上書きしたり
  // 閉じたはずのソケットへの send が TypeError になったりする(M1)
  ws?.close();
  // グローバルは await の前に外す。await のあとで代入すると、
  // その間に開始し直された新しいセッションの参照を潰してしまう
  captureActive = false;
  ws = null;
  const lock = wakeLock;
  wakeLock = null;
  await cleanupAudio();
  if (lock) {
    try { await lock.release(); } catch {}
  }
}

// セッションの終端。停止操作でも意図しない切断でも必ずここを通す
async function finish(statusText = "停止しました") {
  if (finishing) return;
  finishing = true;
  // releaseCapture() が captureActive を false にすると、保留中の1秒デバウンス保存が
  // trySaveSession() の captureActive チェックに落ちて無言で捨てられる。
  // それより前に強制フラッシュしておく(M2)
  clearTimeout(saveSessionTimer);
  saveSessionTimer = null;
  trySaveSession();
  await releaseCapture();
  // 解放が済んでから「戻る」に切り替える。先に finished を立てると、
  // ボタンの表示が「停止」のまま戻る側の分岐に入り、警告が空振りする
  finished = true;
  setStatus(statusText);
  showExport();
  stopBtn.textContent = "戻る";
}

async function cleanupAudio() {
  // 参照をローカルに移してからグローバルを外す(await のあとで null を代入すると、
  // その間に開始し直された新しいセッションの AudioContext を消してしまう)
  const node = workletNode;
  const stream = mediaStream;
  const ctx = audioContext;
  workletNode = null;
  mediaStream = null;
  audioContext = null;

  // ハンドラを先に外す。disconnect と ctx.close() の間にキュー済みの統計が届くと、
  // 停止後の数十ms ぶんが診断に足される
  if (node) node.port.onmessage = null;
  try { node?.disconnect(); } catch {}
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  if (ctx) {
    try { await ctx.close(); } catch {}
  }
}

// ---- Service Worker (ホーム画面追加用) ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
