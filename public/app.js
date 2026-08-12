// TermLens クライアント。
// サーバーとのWSプロトコル: バイナリ = 16kHz mono PCM16 音声、テキスト = JSON (src/protocol.ts 参照)

const $ = (id) => document.getElementById(id);

const setup = $("setup");
const live = $("live");
const tokenInput = $("token");
const glossaryInput = $("glossary");
const startBtn = $("start-btn");
const stopBtn = $("stop-btn");
const statusBadge = $("status-badge");
const finalText = $("final-text");
const interimText = $("interim-text");
const cardsEl = $("cards");
const setupError = $("setup-error");
const setupInfo = $("setup-info");

let ws = null;
let audioContext = null;
let workletNode = null;
let mediaStream = null;
let wakeLock = null;
let sendAudio = false;

// ---- 保存値の復元 / サーバー情報 ----
tokenInput.value = localStorage.getItem("termlens.token") ?? "";
glossaryInput.value = localStorage.getItem("termlens.glossary") ?? "";

let serverInfo = null;
fetch("/api/info")
  .then((r) => r.json())
  .then((info) => {
    serverInfo = info;
    setupInfo.textContent = `STT: ${info.sttProvider} / モデル: ${info.model} / 認証: ${info.authRequired ? "あり" : "なし"}`;
  })
  .catch(() => {});

// ---- 画面遷移 ----
function showLive() {
  setup.hidden = true;
  live.hidden = false;
}
function showSetup() {
  live.hidden = true;
  setup.hidden = false;
}

function setStatus(text) {
  statusBadge.textContent = text;
}

function showError(message) {
  setupError.textContent = message;
  setupError.hidden = false;
}

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
  setupError.hidden = true;
  startBtn.disabled = true;
  const token = tokenInput.value.trim();
  const glossary = glossaryInput.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  localStorage.setItem("termlens.token", token);
  localStorage.setItem("termlens.glossary", glossaryInput.value);

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
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
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
          finalLines.push(msg.text);
          finalText.append(renderLine(msg.text));
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
        rebuildTranscript();
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
      // 認証失敗などで即切断された可能性
      showSetup();
      showError("接続が拒否されました。トークンを確認してください。");
      startBtn.disabled = false;
    } else {
      setStatus("切断されました");
    }
  });
}

// ---- 文字起こし内のカード用語ハイライト ----
const finalLines = [];
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

function jumpToCard(term) {
  const card = [...cardsEl.children].find((c) => c.dataset.term === term);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  card.classList.remove("flash");
  void card.offsetWidth; // reflow を挟んで連続タップでも再アニメーションさせる
  card.classList.add("flash");
}

// 新しいカードが出たら、既に表示済みの文字起こしにもハイライトを反映する
function rebuildTranscript() {
  finalText.textContent = "";
  for (const text of finalLines) finalText.append(renderLine(text));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function addCard(card) {
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
}

// web検索による清書: 解説を最新情報ベースに差し替え、関連リンクを表示
function updateCard({ term, description, links }) {
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

// ---- 停止 ----
stopBtn.addEventListener("click", async () => {
  sendAudio = false;
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

async function finish() {
  await cleanupAudio();
  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  ws = null;
  setStatus("停止しました");
  stopBtn.textContent = "戻る";
  stopBtn.onclick = () => location.reload();
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
