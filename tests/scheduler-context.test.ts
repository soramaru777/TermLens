import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import { APIError } from "openai";
import { ContextWindow } from "../src/extract/context.js";
import type { ExtractorInput } from "../src/extract/extractor.js";
import type { ExtractionResult } from "../src/extract/schema.js";
import { ExtractionScheduler } from "../src/extract/scheduler.js";
import type { TermCard } from "../src/protocol.js";

/**
 * `ExtractionScheduler` が直前の会話をどう持ち回すか（#22）。
 *
 * **本体は「一時エラー時は文脈に積まない」の回帰テスト。** 一時エラーではチャンクを
 * バッファ先頭に戻す（次回の `newTranscript` に再登場する）ので、抽出の成否と無関係に
 * 積むと同じ発話が `contextTranscript` と `newTranscript` の両方に現れる。
 *
 * LLM は呼ばない。インスタンスの private `extract` フィールドを差し替えて回す。
 */

type ExtractFn = (input: ExtractorInput) => Promise<ExtractionResult["cards"]>;

// 清書(enrich)も実 API を叩く。`void` で投げっぱなしなので失敗は握り潰されるが、
// ダミーキーのまま api.openai.com へ本当に HTTP リクエストが飛ぶので黙らせる。
mock.method(
  ExtractionScheduler.prototype as unknown as { enrichCard: () => Promise<void> },
  "enrichCard",
  async () => {},
);

/** `MIN_CHARS`(120) を必ず超える発話。先頭の目印でどのチャンクか見分ける。 */
function utterance(mark: string): string {
  return `${mark}:${"あ".repeat(130)}`;
}

function card(term: string): ExtractionResult["cards"][number] {
  return {
    term,
    reading: "テスト",
    description: "テスト用のカード。",
    confidence: "high",
    rarity: "rare",
    correctedFrom: null,
    surfaceForms: [],
  };
}

/** SDK が実際に投げるのと同じ形のエラー（`error-classify.test.ts` と同じ作法）。 */
function apiError(status: number): APIError {
  return APIError.generate(status, { error: { message: "test" } }, undefined, new Headers());
}

/** run() の中の await を1巡させる。setImmediate はマイクロタスクを全部流してから走る。 */
const settle = () => new Promise((r) => setImmediate(r));

interface Harness {
  scheduler: ExtractionScheduler;
  /** `extract()` に渡った入力（呼ばれた順） */
  inputs: ExtractorInput[];
  /** `onCards` で外に出たカード（デデュープ後） */
  emitted: TermCard[][];
  errors: Array<{ message: string; permanent?: boolean }>;
  /** 次回以降の `extract()` の振る舞いを差し替える */
  setImpl: (fn: ExtractFn) => void;
  /** 発話を1つ流し、抽出が終わるまで待つ */
  send: (text: string) => Promise<void>;
  /** 内部に溜まっている文脈。外から観測する手段が無いので private を覗く */
  context: () => string;
}

function harness(t: TestContext, shownTerms: string[] = []): Harness {
  const inputs: ExtractorInput[] = [];
  const emitted: TermCard[][] = [];
  const errors: Array<{ message: string; permanent?: boolean }> = [];
  let impl: ExtractFn = async () => [];

  const scheduler = new ExtractionScheduler(
    [],
    {
      onCards: (c) => emitted.push(c),
      onCardUpdate: () => {},
      onExtracting: () => {},
      onError: (message, permanent) => errors.push({ message, permanent }),
    },
    shownTerms,
  );
  // setInterval を張るので、止めないとテストプロセスが終わらない
  t.after(() => scheduler.stop());

  const internals = scheduler as unknown as { extract: ExtractFn; context: ContextWindow };
  internals.extract = async (input) => {
    inputs.push(input);
    return impl(input);
  };

  return {
    scheduler,
    inputs,
    emitted,
    errors,
    setImpl: (fn) => {
      impl = fn;
    },
    send: async (text) => {
      scheduler.addUtterance(text);
      await settle();
    },
    context: () => internals.context.text(),
  };
}

// --- 成功時 -------------------------------------------------------------

test("抽出に成功したチャンクが次回の contextTranscript になる", async (t) => {
  const h = harness(t);
  const first = utterance("A");
  const second = utterance("B");

  await h.send(first);
  assert.equal(h.inputs.length, 1);
  assert.equal(h.inputs[0]!.newTranscript, first);
  assert.equal(h.inputs[0]!.contextTranscript, "", "初回は文脈が無い");

  await h.send(second);
  assert.equal(h.inputs.length, 2);
  assert.equal(h.inputs[1]!.newTranscript, second);
  assert.equal(h.inputs[1]!.contextTranscript, first, "直前のチャンクだけが文脈に入る");
  assert.ok(
    !h.inputs[1]!.contextTranscript!.includes(second),
    "今回のチャンクは文脈に含めない（同じ発話を二重に読ませない）",
  );
});

test("複数チャンクは \" \" で連結して渡す", async (t) => {
  const h = harness(t);
  await h.send(utterance("A"));
  await h.send(utterance("B"));
  await h.send(utterance("C"));
  assert.equal(h.inputs[2]!.contextTranscript, `${utterance("A")} ${utterance("B")}`);
});

// --- 一時エラー（このファイルの本題） -----------------------------------

test("一時エラーのチャンクは文脈に積まれない", async (t) => {
  const h = harness(t);
  const failed = utterance("A");
  const next = utterance("B");

  h.setImpl(async () => {
    throw apiError(500);
  });
  await h.send(failed);
  assert.equal(h.inputs.length, 1);
  assert.equal(h.context(), "", "失敗したチャンクは積まれていない");

  h.setImpl(async () => []);
  await h.send(next);
  // 一時エラーでは失敗したチャンクがバッファ先頭に戻るので、次回の newTranscript に再登場する
  assert.equal(h.inputs[1]!.newTranscript, `${failed} ${next}`);
  assert.equal(
    h.inputs[1]!.contextTranscript,
    "",
    "戻ってきたチャンクが文脈と新規の両方に出てはいけない",
  );

  h.setImpl(async () => []);
  await h.send(utterance("C"));
  assert.equal(
    h.inputs[2]!.contextTranscript,
    `${failed} ${next}`,
    "成功した回のチャンクは（再試行ぶんも含めて）文脈になる",
  );
});

// --- 恒久エラー ---------------------------------------------------------

test("恒久エラーで抽出を打ち切ると文脈も捨てる", async (t) => {
  const h = harness(t);
  await h.send(utterance("A"));
  assert.notEqual(h.context(), "", "前提: 1回成功して文脈が溜まっている");

  h.setImpl(async () => {
    throw apiError(400);
  });
  await h.send(utterance("B"));

  assert.equal(h.errors.at(-1)?.permanent, true, "前提: 恒久エラーとして打ち切っている");
  assert.equal(h.context(), "", "抽出が止まった後に古い文脈を抱え続けない");
});

// --- デデュープの回帰 ---------------------------------------------------

test("既出用語のデデュープは文脈追加の影響を受けない", async (t) => {
  const h = harness(t, ["Kubernetes"]);

  h.setImpl(async () => [card("kubernetes "), card("Grafana")]);
  await h.send(utterance("A"));
  assert.deepEqual(
    h.emitted.at(-1)?.map((c) => c.term),
    ["Grafana"],
    "正規化キーが一致する既出用語は落ちる（再接続で渡された shownTerms も含む）",
  );

  h.setImpl(async () => [card("Grafana"), card("Pinecone")]);
  await h.send(utterance("B"));
  assert.deepEqual(h.emitted.at(-1)?.map((c) => c.term), ["Pinecone"]);
  assert.deepEqual(
    h.inputs[1]!.shownTerms,
    ["Kubernetes", "Grafana"],
    "表示済み用語リストはこれまでどおり LLM にも渡る",
  );
});
