import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Session } from "../src/session.js";
import { ExtractionScheduler } from "../src/extract/scheduler.js";
import { MockSttAdapter } from "../src/stt/mock.js";
import type { ServerMessage } from "../src/protocol.js";
import type { TranscriptEvent } from "../src/stt/types.js";

/**
 * `Session` の配線（表示は即時 / 抽出は発話単位）を検証する。
 *
 * ここにテストが無かったせいで、「`stopSession()` がフィールドを null にしてから
 * `builder.flush()` を呼ぶので、発話が `this.scheduler?.` で握り潰されて
 * 最後の発話が抽出に届かない」というバグが素通りした。
 *
 * **mock の再生には頼らない。** `MockSttAdapter` は行の最後の final に必ず
 * `speechFinal` を立てるため、再生を途中で止めても未確定の発話が残らず、
 * 上記のバグを再現できない。アダプタが登録したコールバックを掴んで直接叩く。
 */

type Handler = (...args: unknown[]) => void;

/** Session が使う最小限だけを持つ偽 WebSocket。 */
class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  private handlers = new Map<string, Handler[]>();

  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  clientSend(msg: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
}

/** マイクロタスクを一巡させる（Session.start が await を挟むため）。 */
const settle = () => new Promise((r) => setImmediate(r));

interface Harness {
  ws: FakeWs;
  /** STT が transcript を出したことにする */
  transcript: (e: TranscriptEvent) => void;
  /** STT が UtteranceEnd を受けたことにする */
  utteranceEnd: () => void;
  /** スケジューラに渡った発話のテキスト */
  utterances: string[];
  stop: () => Promise<void>;
  restore: () => void;
}

/**
 * mock アダプタの再生を止め、コールバックだけ掴んだ Session を組み立てる。
 * `addUtterance` はスパイなのでスケジューラのバッファは空のまま＝
 * `flush()` が LLM を呼ぶことはない。
 */
async function harness(): Promise<Harness> {
  const utterances: string[] = [];
  // シグネチャの違う mock を1つの配列にまとめるので、restore だけ見える形に緩める
  const spies: Array<{ mock: { restore: () => void } }> = [
    mock.method(ExtractionScheduler.prototype, "addUtterance", (text: string) => {
      utterances.push(text);
    }),
    // 自動再生させない（タイマーも不要にする）
    mock.method(MockSttAdapter.prototype, "start", async () => {}),
    mock.method(MockSttAdapter.prototype, "stop", async () => {}),
  ];
  let transcriptCb: ((e: TranscriptEvent) => void) | undefined;
  let utteranceEndCb: (() => void) | undefined;
  spies.push(
    mock.method(MockSttAdapter.prototype, "onTranscript", (cb: (e: TranscriptEvent) => void) => {
      transcriptCb = cb;
    }),
    mock.method(MockSttAdapter.prototype, "onUtteranceEnd", (cb: () => void) => {
      utteranceEndCb = cb;
    }),
  );

  const ws = new FakeWs();
  new Session(ws as never);
  ws.clientSend({ type: "start", glossary: [] });
  await settle();
  assert.ok(transcriptCb, "onTranscript が登録されていない");
  assert.ok(utteranceEndCb, "onUtteranceEnd が登録されていない");

  return {
    ws,
    utterances,
    transcript: (e) => transcriptCb!(e),
    utteranceEnd: () => utteranceEndCb!(),
    stop: async () => {
      ws.clientSend({ type: "stop" });
      await settle();
      await settle();
    },
    restore: () => {
      // ExtractionScheduler は setInterval を張る。閉じないとプロセスが終わらないので、
      // WS の close を流して teardown させる（stopSession 済みなら何も起きない）
      ws.emit("close");
      for (const s of spies) s.mock.restore();
    },
  };
}

const fin = (text: string, speaker?: number, speechFinal = false): TranscriptEvent => ({
  text,
  isFinal: true,
  speaker,
  speechFinal,
});

test("interim も final も、届いた時点でそのままクライアントへ送る（表示は遅延ゼロ）", async () => {
  const h = await harness();
  try {
    h.transcript({ text: "とちゅう", isFinal: false, speaker: undefined });
    h.transcript(fin("かくてい", 0));
    const transcripts = h.ws.sent.filter((m) => m.type === "transcript");
    assert.deepEqual(
      transcripts.map((m) => ({
        text: (m as { text: string }).text,
        isFinal: (m as { isFinal: boolean }).isFinal,
      })),
      [
        { text: "とちゅう", isFinal: false },
        // 発話が閉じていなくても final はその場で送る
        { text: "かくてい", isFinal: true },
      ],
    );
    assert.deepEqual(h.utterances, [], "抽出側はまだ発話を受け取っていない");
  } finally {
    h.restore();
  }
});

test("発話が閉じたときだけ抽出スケジューラへ渡す", async () => {
  const h = await harness();
  try {
    h.transcript(fin("まえはん", 0));
    h.transcript(fin("うしろはん", 0, true));
    assert.deepEqual(h.utterances, ["まえはんうしろはん"], "1発話にまとめて渡す");
  } finally {
    h.restore();
  }
});

test("UtteranceEnd も発話を閉じる経路として配線されている", async () => {
  const h = await harness();
  try {
    h.transcript(fin("とじる", 0));
    assert.deepEqual(h.utterances, []);
    h.utteranceEnd();
    assert.deepEqual(h.utterances, ["とじる"]);
  } finally {
    h.restore();
  }
});

/**
 * **回帰テスト**: `stopSession()` で未確定の発話が抽出に届くこと。
 *
 * `speechFinal` が立たないまま stop すると発話は未確定のまま残る。
 * `builder.flush()` が発行した発話がスケジューラまで到達しなければ、停止直前の発話が丸ごと失われる。
 * コールバックが `this.scheduler?.` を見ていると、`stopSession()` が先にフィールドを
 * null にするため黙って握り潰される。
 */
test("stop したとき、未確定の発話が抽出スケジューラに届く", async () => {
  const h = await harness();
  try {
    h.transcript(fin("とじられていない発話", 0));
    assert.deepEqual(h.utterances, [], "まだ閉じていない");
    await h.stop();
    assert.deepEqual(
      h.utterances,
      ["とじられていない発話"],
      "stop 時の flush が抽出まで届いていない",
    );
  } finally {
    h.restore();
  }
});

test("stop したとき、閉じる発話が無ければ何も渡さない", async () => {
  const h = await harness();
  try {
    h.transcript(fin("すでに閉じた", 0, true));
    await h.stop();
    assert.deepEqual(h.utterances, ["すでに閉じた"], "同じ発話を二重に渡さない");
  } finally {
    h.restore();
  }
});

// ---- finalSeq の採番（#36） ----
//
// クライアントは「同じ final 由来か」を `finalSeq` だけで判定し、話者ラベルの揺れで
// 細切れになった行を再結合する（`public/utterances.js`）。**採番がずれても例外は出ない** —
// 別々の final に同じ番号が付けば違う発話が1段落に混ざり、逆に分割されたイベントに
// 違う番号が付けば補正がまったく効かなくなる。どちらも黙って表示だけが変わる。

/** 話者で N 分割された final のイベント列。`segIndex` は split.ts が付ける。 */
function split(texts: string[]): TranscriptEvent[] {
  return texts.map((text, i) => ({
    text,
    isFinal: true,
    speaker: i % 2,
    segIndex: i,
  }));
}

/** 送信済み transcript の finalSeq 列。 */
function seqs(ws: FakeWs): Array<number | undefined> {
  return ws.sent
    .filter((m) => m.type === "transcript")
    .map((m) => (m as { finalSeq?: number }).finalSeq);
}

test("話者で分割された final には同じ finalSeq が付く", async () => {
  const h = await harness();
  try {
    for (const e of split(["いち", "に", "さん"])) h.transcript(e);
    assert.deepEqual(seqs(h.ws), [1, 1, 1], "分割されたイベントごとに採番している");
  } finally {
    h.restore();
  }
});

test("別の final には別の finalSeq が付く", async () => {
  const h = await harness();
  try {
    for (const e of split(["いち", "に"])) h.transcript(e);
    for (const e of split(["さん", "よん"])) h.transcript(e);
    assert.deepEqual(seqs(h.ws), [1, 1, 2, 2], "Results の先頭で採番が進んでいない");
  } finally {
    h.restore();
  }
});

test("分割されなかった final（segIndex 0）も1つずつ採番する", async () => {
  const h = await harness();
  try {
    h.transcript({ text: "いち", isFinal: true, speaker: 0, segIndex: 0 });
    h.transcript({ text: "に", isFinal: true, speaker: 0, segIndex: 0 });
    assert.deepEqual(seqs(h.ws), [1, 2]);
  } finally {
    h.restore();
  }
});

/** `segIndex` を持たないアダプタ（将来の実装）は「分割なし」と同じ扱いにする。 */
test("segIndex を持たない final は1件ごとに採番する", async () => {
  const h = await harness();
  try {
    h.transcript(fin("いち", 0));
    h.transcript(fin("に", 1));
    assert.deepEqual(seqs(h.ws), [1, 2]);
  } finally {
    h.restore();
  }
});

test("interim には finalSeq を付けず、採番も進めない", async () => {
  const h = await harness();
  try {
    h.transcript({ text: "とちゅう", isFinal: false, speaker: undefined });
    h.transcript(fin("かくてい", 0));
    assert.deepEqual(seqs(h.ws), [undefined, 1], "interim が採番を進めている");
  } finally {
    h.restore();
  }
});
