// TermLens クライアント。
// サーバーとのWSプロトコル: バイナリ = 16kHz mono PCM16 音声、テキスト = JSON (src/protocol.ts 参照)

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

function refreshGlossaryCount() {
  glossaryCount.textContent = `${getGlossary().length}語`;
}
refreshGlossaryCount();

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
  const h = (header?.offsetHeight ?? 52) + (exportRow.hidden ? 0 : exportRow.offsetHeight);
  document.documentElement.style.setProperty("--live-chrome", `${h}px`);
}
function showHome() {
  live.hidden = true;
  settings.hidden = true;
  home.hidden = false;
  refreshGlossaryCount();
}
function showSettings() {
  // 入力欄は開くたびに保存値から復元する(「戻る」で破棄できるようにするため)
  tokenInput.value = getToken();
  glossaryInput.value = getGlossaryText();
  persistToggle.checked = getPersistEnabled();
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
// 「戻る」は保存せずに破棄する
closeSettingsBtn.addEventListener("click", () => showHome());
saveSettingsBtn.addEventListener("click", () => {
  localStorage.setItem("termlens.token", tokenInput.value.trim());
  localStorage.setItem("termlens.glossary", glossaryInput.value);
  localStorage.setItem("termlens.persist", String(persistToggle.checked));
  // OFF にした時点で保存済みのものも消す。「ONに戻すまで一切残さない」を保証するため(要件5)。
  // 復元案内(pendingRestoreSession とバナー)も一緒に戻さないと、保存をOFFにしたのに
  // 案内からは復元できてしまう(L1)
  if (!persistToggle.checked) {
    deleteSavedSession();
    pendingRestoreSession = null;
    restoreBanner.hidden = true;
  }
  homeError.hidden = true;
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
  cardData.clear();
  highlightOwner.clear();
  highlightRe = null;
  activeTerm = null;
  pinnedToTerm = false;
  finalText.textContent = "";
  interimText.textContent = "";
  cardsEl.textContent = ""; // エラーバナーもここで消えるので参照を落とす
  errorBanner = null;
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
      // iOS Safari: getUserMedia と AudioContext 生成はユーザージェスチャ内で行う必要がある
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // sampleRate は指定しない(iOSでは無視/失敗するため)。実測値からWorkletでダウンサンプルする
      audioContext = new AudioContext();
      await audioContext.resume();
      await audioContext.audioWorklet.addModule("/audio-processor.js");

      workletNode = new AudioWorkletNode(audioContext, "pcm16-downsampler", {
        processorOptions: { inputSampleRate: audioContext.sampleRate, targetSampleRate: 16000 },
      });
      workletNode.port.onmessage = (e) => {
        if (sendAudio && ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000) {
          ws.send(e.data);
        }
      };
      const source = audioContext.createMediaStreamSource(mediaStream);
      source.connect(workletNode);
      // 出力には繋がない(モニタ不要)
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
    sock.send(JSON.stringify({ type: "start", glossary, shownTerms: [...cardData.keys()] }));
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
          finalLines.push({ text: msg.text, speaker: msg.speaker, t: Date.now() });
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
          addCard(card);
          addHighlightTerm(card.term, card.term);
          addHighlightTerm(card.correctedFrom, card.term);
          for (const form of card.surfaceForms ?? []) addHighlightTerm(form, card.term);
        }
        renderTranscript();
        setStatus("聞き取り中");
        break;
      case "card_update":
        updateCard(msg);
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

// カードの元データ。DOM は新しい順に prepend するが、こちらは挿入順(古い順)を保つ。
// エクスポートは登場順の方が読みやすいため、この Map を正とする。
const cardData = new Map(); // term → TermCard
const highlightOwner = new Map(); // 表記(小文字) → 対応するカードの term
let highlightRe = null;

function addHighlightTerm(form, cardTerm) {
  if (!form || !form.trim()) return;
  const key = form.trim().toLowerCase();
  if (!highlightOwner.has(key)) highlightOwner.set(key, cardTerm);
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
    span.dataset.term = highlightOwner.get(m[0].toLowerCase()) ?? m[0];
    line.append(span);
    last = m.index + m[0].length;
  }
  line.append(text.slice(last) + " ");
  return line;
}

// ハイライト語のタップ → 該当カードへスクロールして一瞬光らせる
$("transcript").addEventListener("click", (e) => {
  const hl = e.target.closest(".hl");
  if (hl) jumpToCard(hl.dataset.term);
});

// ---- 表示するカードの選択 ----
// 縦積みレイアウト(スマホ)では .active の1枚だけを CSS で表示する。
// 既定は「最新に追従」。会話中の用語をタップするとその語に固定し、「最新」で追従に戻す。
// 横並びレイアウトでは全カードが見えるので、この状態は表示に影響しない。
let activeTerm = null;
let pinnedToTerm = false;
// style.css の @media (max-width: 899px) と対になっている。片方だけ変えないこと
const stackedLayout = window.matchMedia("(max-width: 899px)");

function setActiveCard(term) {
  activeTerm = term;
  for (const card of cardsEl.children) {
    card.classList.toggle("active", card.dataset.term === term);
  }
  renderCardNav();
}

function renderCardNav() {
  const terms = [...cardData.keys()];
  if (terms.length === 0) {
    cardNav.hidden = true;
    return;
  }
  cardNav.hidden = false;
  const index = terms.indexOf(activeTerm);
  const newer = index < 0 ? 0 : terms.length - 1 - index; // 表示中より後に出たカード数
  cardPosition.textContent = `${index + 1} / ${terms.length}　${pinnedToTerm ? "固定中" : "最新に追従"}`;
  latestBtn.textContent = newer > 0 ? `最新 +${newer}` : "最新";
  latestBtn.disabled = !pinnedToTerm;
}

latestBtn.addEventListener("click", () => {
  pinnedToTerm = false;
  const terms = [...cardData.keys()];
  setActiveCard(terms[terms.length - 1] ?? null);
});

function jumpToCard(term) {
  const card = [...cardsEl.children].find((c) => c.dataset.term === term);
  if (!card) return;
  // 縦積みのときだけ、タップした語に固定する(以後、新しいカードが出ても表示は変わらない)。
  // 横並びでは全カードが見えており、固定する意味がないうえ回転時に古いカードが残るため。
  if (stackedLayout.matches) {
    pinnedToTerm = true;
    setActiveCard(term);
  }
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  card.classList.remove("flash");
  void card.offsetWidth; // reflow を挟んで連続タップでも再アニメーションさせる
  card.classList.add("flash");
}

function speakerLabel(speaker) {
  return "話者" + String.fromCharCode(65 + (speaker % 26)); // 話者A, 話者B, …
}

// 連続する同一話者の発言を1つの段落にまとめる。描画とエクスポートで共有する。
// finalLines には通常の発話行のほかに { type: "reconnect" } という区切り印が混じる。
// 区切りはそれ自身で1グループとし、直後の発話が直前の話者と同じでも絶対にまとめない
// (再接続後は話者番号が振り直しなので、同じ番号でも別人の可能性がある)。
function groupUtterances() {
  const groups = [];
  for (const line of finalLines) {
    if (line.type === "reconnect") {
      groups.push({ type: "reconnect", t: line.t });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.type !== "reconnect" && last.speaker === line.speaker) last.texts.push(line.text);
    else groups.push({ speaker: line.speaker, t: line.t, texts: [line.text] });
  }
  return groups;
}

// 文字起こし全体を再描画する。話者が変わったら新しい段落+話者チップを付ける。
// カード追加時のハイライト反映も兼ねる。
function renderTranscript() {
  finalText.textContent = "";
  for (const group of groupUtterances()) {
    if (group.type === "reconnect") {
      finalText.append(el("div", "reconnect-marker", "― 再接続(以降の話者ラベルは振り直し)―"));
      continue;
    }
    const { speaker, texts } = group;
    const div = el("div", "utterance");
    if (speaker != null) {
      div.append(el("span", `speaker-chip sp-${speaker % 6}`, speakerLabel(speaker)));
    }
    for (const text of texts) div.append(renderLine(text));
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
function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

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

function addCard(card) {
  const existing = cardData.get(card.term);
  if (existing) {
    // 同じ term のカードが再送されても DOM を新規に作らない(冪等化, #8)。
    // 再接続直後はサーバー側のデデュープ状態が空から始まるため、既出用語が再びカードとして
    // 届きうる。清書済み(既存 links がある)ならドラフト(links: [])で
    // description/links を上書きしない。未清書ならドラフト説明の更新は許可する。
    if (existing.links.length === 0) {
      existing.description = card.description;
      existing.willEnrich = card.willEnrich;
      const div = [...cardsEl.children].find((c) => c.dataset.term === card.term);
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
    return;
  }

  cardData.set(card.term, { ...card });
  const div = el("div", "card");
  div.dataset.term = card.term;
  const header = el("div");
  header.append(el("span", "term", card.term), el("span", "reading", card.reading));
  if (card.confidence === "low") header.append(el("span", "maybe", "もしかして?"));
  div.append(header);
  if (card.correctedFrom) div.append(el("div", "corrected", `音声: ${card.correctedFrom}`));
  div.append(el("div", "desc", card.description));
  // リンクは renderCardLinks で描画する(updateCard と共通)。清書済み(links がある)なら
  // willEnrich の真偽によらずリンクを出す。復元直後は WS が無く card_update が来ないため、
  // ここでリンクを出さないと清書済みカードでも「確認中」のまま固まってしまう(#10)。
  // 「確認中」は清書前(links が空)かつ willEnrich のときだけに限定する。
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
  // バナーがあればその直後に挿入し、バナーを常に先頭に保つ
  cardsEl.insertBefore(div, errorBanner ? errorBanner.nextSibling : cardsEl.firstChild);
  // 追従中なら新しいカードに切り替える。固定中は表示を動かさず件数だけ更新する
  if (pinnedToTerm) renderCardNav();
  else setActiveCard(card.term);
  scheduleSessionSave();
}

function updateCard({ term, description, links }) {
  const stored = cardData.get(term);
  // cardData が変化するのはここなので、DOM が見つからず早期returnする場合でも保存はする
  if (stored) {
    Object.assign(stored, { description, links });
    scheduleSessionSave();
  }
  const card = [...cardsEl.children].find((c) => c.dataset.term === term);
  if (!card) return;
  card.querySelector(".desc").textContent = description;
  let linksEl = card.querySelector(".links");
  if (!linksEl) {
    linksEl = el("div", "links");
    card.append(linksEl);
  }
  linksEl.classList.remove("pending");
  if (renderCardLinks(linksEl, links) === 0) linksEl.remove();
}

// ---- Markdown エクスポート ----

const pad2 = (n) => String(n).padStart(2, "0");

function fmtDateTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtStamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
// 会議開始からの経過時間。1時間を超えたら h:mm:ss にする
function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

// Markdown の記号が含まれても記法として解釈されないようにする。
// 記号を含まない文字列は素通りするので、通常の発話では出力は変わらない。
const escMd = (s) => String(s ?? "").replace(/([\\`*_[\]<>#])/g, "\\$1");
// 括弧を含む URL は <> で囲む(囲まないとリンクが途中で切れる)
const mdUrl = (u) => (/[()\s]/.test(u) ? `<${u}>` : u);

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
  for (const group of groupUtterances()) {
    if (group.type === "reconnect") {
      out.push("---", "", "*再接続しました。以降の話者ラベルは振り直しです。*", "");
      continue;
    }
    const { speaker, t, texts } = group;
    const label = speaker != null ? speakerLabel(speaker) : "発言";
    out.push(`**${label}** \`${fmtElapsed(t - started.getTime())}\``, "", texts.map(escMd).join(" "), "");
  }
  return out.join("\n");
}

function buildTermsMarkdown() {
  const started = sessionStartedAt ?? new Date();
  const cards = [...cardData.values()];
  const out = [
    `# 用語カード ${fmtDateTime(started)}`,
    "",
    `- 件数: ${cards.length}`,
    "",
    "> TermLens が会話から自動抽出した用語です。解説は生成AIによるもので、誤りを含む場合があります。",
    "> 登場順に並んでいます。",
    "",
    "---",
    "",
  ];
  for (const card of cards) {
    const reading = card.reading ? `（${escMd(card.reading)}）` : "";
    const maybe = card.confidence === "low" ? " ※要確認" : "";
    out.push(`## ${escMd(card.term)}${reading}${maybe}`, "");
    if (card.correctedFrom) out.push(`> 音声認識では「${escMd(card.correctedFrom)}」と聞き取られた語です。`, "");
    if (card.description) out.push(escMd(card.description), "");
    // 復元経路では links が localStorage 由来になり信頼境界が一段緩いため、
    // addCard/updateCard の描画と同じ isHttpUrl 検証をここでも通す(M5)
    const validLinks = (card.links ?? []).filter((link) => isHttpUrl(link.url));
    if (validLinks.length) {
      out.push("**関連リンク**", "");
      for (const link of validLinks) out.push(`- [${escMd(link.title)}](${mdUrl(link.url)})`);
      out.push("");
    }
  }
  return out.join("\n");
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

function showExport() {
  sessionEndedAt ??= new Date();
  dlTranscriptBtn.disabled = spokenLines().length === 0;
  dlTermsBtn.disabled = cardData.size === 0;
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
    cardData: [...cardData], // Map は JSON化できないため [term, card] の配列に落とす
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
      addCard(card);
      // カードを描き直すだけでは会話中の用語がオレンジ表示にならないため、
      // "cards" 受信時(connectWs 内)と同じくハイライトも復元する
      addHighlightTerm(card.term, card.term);
      addHighlightTerm(card.correctedFrom, card.term);
      for (const form of card.surfaceForms ?? []) addHighlightTerm(form, card.term);
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
