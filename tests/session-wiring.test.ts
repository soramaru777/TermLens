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

/** `ExtractionScheduler` のコンストラクタ第2引数（Session が渡す配線）。 */
type SchedulerCallbacks = ConstructorParameters<typeof ExtractionScheduler>[1];

interface Harness {
  ws: FakeWs;
  /** `Session` が組み立てた `ExtractionScheduler` に渡したコールバック（#38 の中継確認用） */
  callbacks: SchedulerCallbacks;
  /** STT が transcript を出したことにする */
  transcript: (e: TranscriptEvent) => void;
  /** STT が UtteranceEnd を受けたことにする */
  utteranceEnd: () => void;
  /** STT がモデル情報を通知したことにする（#46） */
  sttInfo: (info: unknown) => void;
  /** STT が final の分割計測を出したことにする（#52） */
  splitDiag: (diag: unknown) => void;
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
  let sttInfoCb: ((info: unknown) => void) | undefined;
  let splitDiagCb: ((diag: unknown) => void) | undefined;
  spies.push(
    mock.method(MockSttAdapter.prototype, "onTranscript", (cb: (e: TranscriptEvent) => void) => {
      transcriptCb = cb;
    }),
    mock.method(MockSttAdapter.prototype, "onUtteranceEnd", (cb: () => void) => {
      utteranceEndCb = cb;
    }),
    // mock は onSttInfo を呼ばない（登録するだけ）。配線の有無はここで掴む
    mock.method(MockSttAdapter.prototype, "onSttInfo", (cb: (info: unknown) => void) => {
      sttInfoCb = cb;
    }),
    // mock は onSplitDiag も呼ばない（登録するだけ）。#52 の計測は実アダプタの
    // 経路でしか出ないので、配線の有無はここで掴む
    mock.method(MockSttAdapter.prototype, "onSplitDiag", (cb: (diag: unknown) => void) => {
      splitDiagCb = cb;
    }),
  );

  const ws = new FakeWs();
  const session = new Session(ws as never);
  ws.clientSend({ type: "start", glossary: [] });
  await settle();
  assert.ok(transcriptCb, "onTranscript が登録されていない");
  assert.ok(utteranceEndCb, "onUtteranceEnd が登録されていない");
  assert.ok(sttInfoCb, "onSttInfo が登録されていない");
  assert.ok(splitDiagCb, "onSplitDiag が登録されていない");
  // Session が scheduler へ渡した配線をそのまま掴む。`card_update` の中継は
  // scheduler を動かさずにこのコールバックを叩けば確かめられる（#38）
  const scheduler = (session as unknown as { scheduler: ExtractionScheduler }).scheduler;
  const callbacks = (scheduler as unknown as { callbacks: SchedulerCallbacks }).callbacks;
  assert.ok(callbacks, "scheduler の配線を取り出せない");

  return {
    ws,
    callbacks,
    utterances,
    transcript: (e) => transcriptCb!(e),
    utteranceEnd: () => utteranceEndCb!(),
    sttInfo: (info) => sttInfoCb!(info as never),
    splitDiag: (diag) => splitDiagCb!(diag as never),
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

// ---- card_update の中継（#38） ----

/**
 * **更新対象の指定は `cardId`。**
 *
 * `term` を送っていた頃の形が残ると、クライアントは `incomingCardId` を引けず
 * `card_update` を黙って捨てる（例外は出ない。「確認中」が回り続けるだけ）。
 * Session は scheduler の第1引数をそのまま中継するだけの層なので、
 * ここが term を読んでいないことを1本で固定しておく。
 */
test("card_update は scheduler の cardId をそのまま中継する", async () => {
  const h = await harness();
  try {
    h.callbacks.onCardUpdate("c7", "confirmed", "検証後の解説。", [
      { title: "公式", url: "https://example.com/" },
    ]);
    const update = h.ws.sent.at(-1)!;
    assert.deepEqual(update, {
      type: "card_update",
      cardId: "c7",
      status: "confirmed",
      description: "検証後の解説。",
      links: [{ title: "公式", url: "https://example.com/" }],
    });
    assert.ok(!("term" in update), "term を載せると主キーが2本になる");
    // **既存の3経路は `rename` を付けない**（#40）。付かないかぎりクライアントの
    // #24 のガード（unresolved から戻さない）はそのまま効く
    assert.ok(!("rename" in update), "改名しない経路に rename が載っている");
  } finally {
    h.restore();
  }
});

/**
 * 再評価の改名は WS まで透過する（#40）。
 *
 * **Session は中継するだけの層。** ここで落とすと、サーバーが昇格を決めたのに
 * クライアントは `rename` の無い `card_update` として受け取り、#24 のガードが
 * 正しく効いて**据え置かれる** — 例外も出ず、カードが直らないだけになる。
 */
test("card_update の rename をそのまま中継する", async () => {
  const h = await harness();
  try {
    h.callbacks.onCardUpdate("c7", "confirmed", "検証後の解説。", [], {
      term: "AB",
      reading: "エービー",
      correctedFrom: "えーび",
      surfaceForms: ["えーび"],
    });
    const update = h.ws.sent.at(-1)!;
    assert.deepEqual(update, {
      type: "card_update",
      cardId: "c7",
      status: "confirmed",
      description: "検証後の解説。",
      links: [],
      rename: {
        term: "AB",
        reading: "エービー",
        correctedFrom: "えーび",
        surfaceForms: ["えーび"],
      },
    });
  } finally {
    h.restore();
  }
});

/**
 * **改名は `cardId` を動かさない**（#38 の不変条件）。
 *
 * `rename` に cardId を混ぜる形にすると「改名で ID が変わる」経路が作れてしまい、
 * クライアントの3本の Map が一斉に迷子になる。
 */
test("rename に cardId は載らない", async () => {
  const h = await harness();
  try {
    h.callbacks.onCardUpdate("c7", "confirmed", "解説。", [], {
      term: "AB",
      reading: "エービー",
      correctedFrom: null,
      surfaceForms: [],
    });
    const update = h.ws.sent.at(-1) as unknown as {
      cardId: string;
      rename: Record<string, unknown>;
    };
    assert.equal(update.cardId, "c7", "更新対象の ID はトップレベルのまま");
    assert.ok(!("cardId" in update.rename), "改名の中に識別子を持ち込まない");
  } finally {
    h.restore();
  }
});

// ---- word 数とモデル情報（#46） ----
//
// クライアントは話者ごとの word 数からしか「割合」を出せない。載っていなければ
// 文字数へフォールバックするので**例外は出ず、分母が黙って入れ替わる**だけ。

/** 送信済み transcript の wordCount 列。 */
function wordCounts(ws: FakeWs): Array<number | undefined> {
  return ws.sent
    .filter((m) => m.type === "transcript")
    .map((m) => (m as { wordCount?: number }).wordCount);
}

const WORD = (word: string, speaker: number) => ({
  word,
  punctuatedWord: word,
  start: 0,
  end: 0.5,
  confidence: 0.9,
  speaker,
});

test("final の wordCount はそのセグメントの word 数と一致する", async () => {
  const h = await harness();
  try {
    h.transcript({
      text: "w0w1",
      isFinal: true,
      speaker: 0,
      words: [WORD("w0", 0), WORD("w1", 0)],
      segIndex: 0,
    });
    h.transcript({ text: "w2", isFinal: true, speaker: 1, words: [WORD("w2", 1)], segIndex: 1 });
    assert.deepEqual(wordCounts(h.ws), [2, 1], "分割後のセグメントごとの件数になっていない");
  } finally {
    h.restore();
  }
});

test("words を持たない final の wordCount は付かない（0 と偽らない）", async () => {
  const h = await harness();
  try {
    // words を出せないアダプタもありうる（TranscriptEvent.words は optional）。
    // 0 を送ると「word が0個だった」と読め、割合の分母が狂う
    h.transcript({ text: "words なし", isFinal: true, speaker: 0 });
    assert.deepEqual(wordCounts(h.ws), [undefined]);
  } finally {
    h.restore();
  }
});

test("interim には wordCount を付けない", async () => {
  const h = await harness();
  try {
    // interim は分割されず、話者統計の対象でもない。付けても読み手がいないうえ、
    // クライアントが interim を数えると word 数が二重計上される
    h.transcript({ text: "とちゅう", isFinal: false, speaker: undefined, words: [WORD("w0", 0)] });
    assert.deepEqual(wordCounts(h.ws), [undefined]);
  } finally {
    h.restore();
  }
});

test("stt_info はそのままクライアントへ中継する", async () => {
  const h = await harness();
  try {
    h.sttInfo({ model: { name: "nova-3" }, diarizer: { arch: "v1" } });
    const infos = h.ws.sent.filter((m) => m.type === "stt_info");
    assert.deepEqual(infos, [
      { type: "stt_info", model: { name: "nova-3" }, diarizer: { arch: "v1" } },
    ]);
    // **キーを明示して並べていることの固定。** `{ ...info }` にすると
    // TypeScript の excess property check が効かず、SttInfo にフィールドが1つ増えた
    // だけで型エラーゼロのままクライアントへ出ていく（request_id を出さない、という
    // この変更の中心的な主張が型の網目を素通りする）
    assert.deepEqual(Object.keys(infos[0]).sort(), ["diarizer", "model", "type"]);
  } finally {
    h.restore();
  }
});

// ---- STT テキスト完全性（#52） ----

/** 会話内容を持たない `SplitDiag`。省略したキーは「正常な素通し」の値になる。 */
const DIAG = (over: Record<string, unknown> = {}) => ({
  rawChars: 10,
  rawVisible: 9,
  splitChars: 10,
  splitVisible: 9,
  segments: 1,
  events: 1,
  fallback: false,
  headDropped: false,
  ...over,
});

const integrities = (ws: FakeWs) => ws.sent.filter((m) => m.type === "text_integrity");

test("text_integrity は final ごとに累計として送る", async () => {
  const h = await harness();
  try {
    h.splitDiag(DIAG());
    h.splitDiag(DIAG({ segments: 3, events: 2, fallback: true, headDropped: true }));
    const sent = integrities(h.ws);
    assert.equal(sent.length, 2, "final ごとに送る（スロットルは入れていない）");
    // 2件目は1件目を含む累計。差分を送ると、クライアントが取りこぼした瞬間に
    // 表の数字が恒久的にずれる（累計なら次の1件で追いつく）
    assert.equal(sent[1].finals, 2);
    assert.equal(sent[1].splitFinals, 1);
    assert.equal(sent[1].rawVisible, 18);
    assert.equal(sent[1].fallbacks, 1);
    assert.equal(sent[1].headDrops, 1);
    assert.equal(sent[1].droppedEvents, 1);
  } finally {
    h.restore();
  }
});

/**
 * **キーを明示して並べていることの固定**（`stt_info` と同じ理由、#46 のレビュー）。
 *
 * `{ ...snapshot }` にするとオブジェクトリテラルへの excess property check が効かず、
 * `IntegritySnapshot` にフィールドが1つ増えただけで**型エラーゼロのままクライアントへ
 * 出ていく**。「診断に出るのは件数と文字数だけ」という主張が型の網目を素通りする。
 */
test("text_integrity のキーは採用リストで、余分な値を通さない", async () => {
  const h = await harness();
  try {
    h.splitDiag(DIAG());
    const sent = integrities(h.ws);
    assert.deepEqual(Object.keys(sent[0]).sort(), [
      "droppedEvents",
      "fallbacks",
      "finals",
      "headDrops",
      "rawChars",
      "rawVisible",
      "splitChars",
      "splitFinals",
      "splitVisible",
      "type",
    ]);
  } finally {
    h.restore();
  }
});

