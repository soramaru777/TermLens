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

let ws = null;
let audioContext = null;
let workletNode = null;
let mediaStream = null;
let wakeLock = null;
let sendAudio = false;
let sessionStartedAt = null;
let sessionEndedAt = null;
// 「戻る」の破棄警告に使う。片方だけ保存して戻ると、もう片方が失われるため別々に持つ
let savedTranscript = false;
let savedTerms = false;
let stopping = false; // 停止操作によるクローズか(意図しない切断と区別する)

// ---- 保存値の読み出し ----
// 設定は localStorage が正。入力欄は設定画面を開いたときにそこから復元する。
const getToken = () => localStorage.getItem("termlens.token") ?? "";
const getGlossaryText = () => localStorage.getItem("termlens.glossary") ?? "";
const getGlossary = () =>
  getGlossaryText()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

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
  homeError.hidden = true;
  showHome();
});

// ---- Wake Lock ----
async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {
    /* 非対応・拒否は無視 */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws) acquireWakeLock();
});

// ---- 開始 ----
startBtn.addEventListener("click", async () => {
  homeError.hidden = true;
  startBtn.disabled = true;
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
    await cleanupAudio();
    startBtn.disabled = false;
  }
});

function connectWs(token, glossary) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // トークンは URL に載せず Sec-WebSocket-Protocol で送る(ログ・履歴への漏えい防止)
  const protocols = ["termlens.v1"];
  if (token) protocols.push("auth." + encodeURIComponent(token));
  ws = new WebSocket(`${proto}://${location.host}/ws`, protocols);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    setStatus("STT接続中…");
    ws.send(JSON.stringify({ type: "start", glossary }));
  });

  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "ready":
        sendAudio = true;
        setStatus("聞き取り中");
        break;
      case "transcript":
        if (msg.isFinal) {
          finalLines.push({ text: msg.text, speaker: msg.speaker, t: Date.now() });
          renderTranscript();
          interimText.textContent = "";
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
        break;
    }
  });

  ws.addEventListener("close", (e) => {
    sendAudio = false;
    if (e.code === 1006 && finalText.textContent === "") {
      // 認証失敗などで即切断された可能性。マイクは取得済みなので必ず解放する
      releaseCapture();
      showHome();
      showError("接続が拒否されました。設定でトークンを確認してください。");
      startBtn.disabled = false;
    } else if (!stopping) {
      // 意図しない切断。ここもセッションの終端なので、停止したときと同じ後始末をする。
      // (停止操作によるクローズなら stopping が真で、finish() の表示を上書きしない)
      finish("切断されました");
    }
  });
}

// ---- 文字起こし内のカード用語ハイライト ----
const finalLines = [];
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
function groupUtterances() {
  const groups = [];
  for (const line of finalLines) {
    const last = groups[groups.length - 1];
    if (last && last.speaker === line.speaker) last.texts.push(line.text);
    else groups.push({ speaker: line.speaker, t: line.t, texts: [line.text] });
  }
  return groups;
}

// 文字起こし全体を再描画する。話者が変わったら新しい段落+話者チップを付ける。
// カード追加時のハイライト反映も兼ねる。
function renderTranscript() {
  finalText.textContent = "";
  for (const { speaker, texts } of groupUtterances()) {
    const group = el("div", "utterance");
    if (speaker != null) {
      group.append(el("span", `speaker-chip sp-${speaker % 6}`, speakerLabel(speaker)));
    }
    for (const text of texts) group.append(renderLine(text));
    finalText.append(group);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function addCard(card) {
  cardData.set(card.term, { ...card });
  const div = el("div", "card");
  div.dataset.term = card.term;
  const header = el("div");
  header.append(el("span", "term", card.term), el("span", "reading", card.reading));
  if (card.confidence === "low") header.append(el("span", "maybe", "もしかして?"));
  div.append(header);
  if (card.correctedFrom) div.append(el("div", "corrected", `音声: ${card.correctedFrom}`));
  div.append(el("div", "desc", card.description));
  // web検索対象(レア度上位)のカードのみ「確認中」を表示
  if (card.willEnrich) div.append(el("div", "links pending", "🔎 最新情報を確認中…"));
  cardsEl.prepend(div);
  // 追従中なら新しいカードに切り替える。固定中は表示を動かさず件数だけ更新する
  if (pinnedToTerm) renderCardNav();
  else setActiveCard(card.term);
}

// web検索による清書: 解説を最新情報ベースに差し替え、関連リンクを表示
function updateCard({ term, description, links }) {
  const stored = cardData.get(term);
  if (stored) Object.assign(stored, { description, links });
  const card = [...cardsEl.children].find((c) => c.dataset.term === term);
  if (!card) return;
  card.querySelector(".desc").textContent = description;
  const linksEl = card.querySelector(".links");
  linksEl.classList.remove("pending");
  linksEl.textContent = "";
  for (const link of links) {
    const a = el("a", "link", link.title);
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    linksEl.append(a);
  }
  if (links.length === 0) linksEl.remove();
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
    `- 発言数: ${finalLines.length}`,
    "",
    "> TermLens による自動文字起こしです。音声認識の誤りを含む場合があります。",
    "> 時刻は会議開始からの経過時間(サーバーが確定結果を返した時点)です。",
    "",
    "---",
    "",
  ];
  for (const { speaker, t, texts } of groupUtterances()) {
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
    if (card.links?.length) {
      out.push("**関連リンク**", "");
      for (const link of card.links) out.push(`- [${escMd(link.title)}](${mdUrl(link.url)})`);
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
  return true;
}

dlTranscriptBtn.addEventListener("click", async () => {
  const stamp = fmtStamp(sessionStartedAt ?? new Date());
  if (await saveMarkdown(`termlens-transcript-${stamp}.md`, buildTranscriptMarkdown())) {
    savedTranscript = true;
  }
});
dlTermsBtn.addEventListener("click", async () => {
  const stamp = fmtStamp(sessionStartedAt ?? new Date());
  if (await saveMarkdown(`termlens-terms-${stamp}.md`, buildTermsMarkdown())) {
    savedTerms = true;
  }
});

function showExport() {
  sessionEndedAt ??= new Date();
  dlTranscriptBtn.disabled = finalLines.length === 0;
  dlTermsBtn.disabled = cardData.size === 0;
  exportRow.hidden = false;
  measureLiveChrome();
}

// ---- 停止 / 戻る ----
// 1つのボタンが「停止」と「戻る」を兼ねる。ハンドラも1本にする
// (onclick を別に足すと、押すたびに停止処理まで走って警告状態がリセットされる)。
let finished = false;
let discardWarned = false;

stopBtn.addEventListener("click", async () => {
  if (finished) {
    // 「戻る」。リロードで内容を破棄するため、未保存のものがあれば1回目は警告に留める
    // (確認ダイアログは PWA で扱いが不安定なため使わない)。
    // 片方だけ保存した場合も、保存していない側は失われるので警告する
    const unsaved =
      (finalLines.length > 0 && !savedTranscript) || (cardData.size > 0 && !savedTerms);
    if (unsaved && !discardWarned) {
      discardWarned = true;
      setStatus("未保存です。もう一度押すと破棄");
      return;
    }
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
  await cleanupAudio();
  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  ws = null;
}

// セッションの終端。停止操作でも意図しない切断でも必ずここを通す
async function finish(statusText = "停止しました") {
  if (finished) return;
  finished = true;
  await releaseCapture();
  setStatus(statusText);
  showExport();
  stopBtn.textContent = "戻る";
}

async function cleanupAudio() {
  try { workletNode?.disconnect(); } catch {}
  workletNode = null;
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (audioContext) {
    try { await audioContext.close(); } catch {}
    audioContext = null;
  }
}

// ---- Service Worker (ホーム画面追加用) ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
