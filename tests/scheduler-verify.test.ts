import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import { client as enrichClient } from "../src/extract/enrich.js";
import type { ExtractorInput } from "../src/extract/extractor.js";
import type { ExtractedCard } from "../src/extract/schema.js";
import { card, candidate, settle, utterance } from "./helpers/cards.js";
import { ExtractionScheduler, selectVerifyTargets } from "../src/extract/scheduler.js";
import type { TermCard, TermLink } from "../src/protocol.js";

/**
 * 検証つき清書のスケジューラ側（#23）。
 *
 * 固定したいのは3つ。
 * 1. **検証対象の選定** — 補正あり・confidence low は必ず通す。従来のレア度上位も残す
 * 2. **`candidates` をクライアントへ送らない** — `{ ...c }` のスプレッドなので放っておくと漏れる
 * 3. **棄却しても表示を変えない**（既定）。記録は `term` と `reason` だけで、
 *    **文字起こし本文をログに出さない**
 *
 * 実 API は叩かない。抽出は private `extract` を差し替え、清書は `enrich.ts` の
 * `client.responses.create` を差し替える。**`enrichCard` は `void` の投げっぱなしなので、
 * 潰さないとダミーキーのまま api.openai.com へ本当にリクエストが飛ぶ。**
 */

type ExtractFn = (input: ExtractorInput) => Promise<ExtractedCard[]>;

// --- 検証対象の選定 -----------------------------------------------------

test("補正あり・confidence low は必ず検証する", () => {
  // **rare を3枚並べてレア度上位の枠を埋めておく。** 枠が空いていると C/D が
  // 従来条件だけで入ってしまい、追加した条件を消しても落ちないテストになる
  // （同レア度内では confidence low が優先されるので、common + low は特に紛れやすい）。
  const cards = [
    card("A", { rarity: "rare" }),
    card("B", { rarity: "rare" }),
    card("C", { rarity: "rare" }),
    card("D", { rarity: "common", correctedFrom: "でぃー" }),
    card("E", { rarity: "common", confidence: "low" }),
    card("F", { rarity: "common" }),
  ];
  const targets = selectVerifyTargets(cards);
  assert.deepEqual(
    [...targets].sort(),
    ["A", "B", "C", "D", "E"],
    "レア度上位の半数(A,B,C)に、補正ありの D と confidence low の E が加わる",
  );
  assert.ok(!targets.has("F"), "補正なし・high・レア度下位は対象外のまま");
});

test("補正なし・confidence high のカードは対象外になりうる", () => {
  // 従来どおりレア度上位の約半数だけが通る。補正なしカードまで web 検索に回すと
  // 呼び出しが増えるだけで、AC「単純で明確な補正は従来程度の低レイテンシ」も崩れる
  const cards = [card("A", { rarity: "rare" }), card("B", { rarity: "common" })];
  const targets = selectVerifyTargets(cards);
  assert.deepEqual([...targets], ["A"]);
});

test("空配列なら対象も空", () => {
  assert.equal(selectVerifyTargets([]).size, 0);
});

// --- スケジューラ経由 ---------------------------------------------------

interface Harness {
  emitted: TermCard[][];
  updates: Array<{ term: string; description: string; links: TermLink[] }>;
  warnings: string[];
  /** `responses.create` に渡った入力（清書1回につき1件） */
  verifyInputs: string[];
  send: (text: string, cards: ExtractedCard[]) => Promise<void>;
}

/** `chosen` を決めるモック。入力に含まれる用語で分岐させ、並列でも取り違えない。 */
function harness(t: TestContext, decide: (input: string) => string | null): Harness {
  const emitted: TermCard[][] = [];
  const updates: Array<{ term: string; description: string; links: TermLink[] }> = [];
  const warnings: string[] = [];
  const verifyInputs: string[] = [];
  let impl: ExtractFn = async () => [];

  const createSpy = mock.method(enrichClient.responses, "create", async (body: never) => {
    const input = String((body as unknown as { input: string }).input);
    verifyInputs.push(input);
    return {
      output_text: JSON.stringify({
        chosen: decide(input),
        reason: "テストの判定",
        description: "検証後の解説。",
      }),
      output: [],
    };
  });
  const warnSpy = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  t.after(() => {
    createSpy.mock.restore();
    warnSpy.mock.restore();
  });

  const scheduler = new ExtractionScheduler([], {
    onCards: (c) => emitted.push(c),
    onCardUpdate: (term, description, links) => updates.push({ term, description, links }),
    onExtracting: () => {},
    onError: () => {},
  });
  t.after(() => scheduler.stop());
  (scheduler as unknown as { extract: ExtractFn }).extract = (input) => impl(input);

  return {
    emitted,
    updates,
    warnings,
    verifyInputs,
    send: async (text, cards) => {
      impl = async () => cards;
      scheduler.addUtterance(text);
      // 清書は `void` の投げっぱなしなので、その解決まで見るには追加で巡回する
      await settle(4);
    },
  };
}

test("candidates はクライアント向けカードに含めない", async (t) => {
  const h = harness(t, () => "Kubernetes");
  await h.send(utterance("A"), [
    card("Kubernetes", { correctedFrom: "クバネテス" }),
    card("Grafana", { rarity: "common" }),
  ]);

  const cards = h.emitted.at(-1)!;
  assert.equal(cards.length, 2);
  for (const c of cards) {
    assert.ok(!("candidates" in c), `${c.term} に candidates が漏れている`);
  }
  assert.deepEqual(
    cards.map((c) => c.term),
    ["Kubernetes", "Grafana"],
    "落とすのは candidates だけで、カードそのものは従来どおり全部出す",
  );

  // 検証に回るのは1枚だけ。全カードを投げる退行は AC「単純で明確な補正は従来程度の
  // 低レイテンシ」とコストを直接壊すが、件数を見ていないと気づけない。
  assert.equal(h.verifyInputs.length, 1, "補正なし・common の Grafana は検証に回さない");
  // willEnrich は「後から card_update が来る」の予告。選定条件を広げた以上、
  // 選定とこのフラグが一致していることを固定しておく（ズレると確認中の表示が残る/出ない）。
  assert.deepEqual(
    cards.map((c) => [c.term, c.willEnrich]),
    [
      ["Kubernetes", true],
      ["Grafana", false],
    ],
  );
});

test("裏付けが取れたら card_update で差し替える", async (t) => {
  const h = harness(t, () => "Kubernetes");
  await h.send(utterance("A"), [card("Kubernetes", { correctedFrom: "クバネテス" })]);

  assert.deepEqual(h.updates, [
    { term: "Kubernetes", description: "検証後の解説。", links: [] },
  ]);
  assert.equal(h.warnings.length, 0);
  assert.ok(
    h.verifyInputs[0]!.includes("クバネテス"),
    "元の表記が検証側に渡っている（candidates を落としても検証段の入力は残る）",
  );
});

test("棄却しても解説は変えず、term と reason だけを記録する", async (t) => {
  const chunk = utterance("A");
  const h = harness(t, () => null);
  const drafted = card("クーベルタン", { correctedFrom: "クバネテス", confidence: "low" });
  await h.send(chunk, [drafted]);

  assert.equal(h.emitted.at(-1)!.length, 1, "速報カードは従来どおり出る（既定 (c)）");
  // **解説はそのまま・リンクは空**で更新を届ける。速報を willEnrich: true で送っている以上、
  // 何も返さないと「確認中」の表示が消えない（#23 のレビュー指摘）。
  assert.deepEqual(h.updates, [
    { term: "クーベルタン", description: drafted.description, links: [] },
  ], "解説は速報のまま。リンクが空なのでクライアントは確認中の表示を畳む");
  assert.equal(h.warnings.length, 1);
  assert.ok(h.warnings[0]!.includes("クーベルタン"), "term は記録する");
  assert.ok(h.warnings[0]!.includes("テストの判定"), "reason も記録する");
  assert.ok(!h.warnings[0]!.includes(chunk), "文字起こし本文はログに出さない");
});

test("候補#2 が選ばれても term は改名しない（protocol に経路が無い）", async (t) => {
  const h = harness(t, () => "Qdrant");
  const drafted = card("クアドラント", {
    correctedFrom: "クドラント",
    candidates: [
      candidate("クアドラント"),
      { term: "Qdrant", reading: "クドラント", rationale: "ベクトルDBの製品名" },
    ],
  });
  await h.send(utterance("A"), [drafted]);

  // card_update は term でカードを突き合わせるので、表示中のカードを別の用語へ
  // 改名できない。解説だけ差し込むと表示が食い違うため裏付け無しと同じ扱いにする。
  assert.deepEqual(h.updates, [
    { term: "クアドラント", description: drafted.description, links: [] },
  ], "term も解説も変えない。確認中の表示だけ畳む");
  assert.equal(h.warnings.length, 1);
  assert.ok(h.warnings[0]!.includes("クアドラント"));
});
