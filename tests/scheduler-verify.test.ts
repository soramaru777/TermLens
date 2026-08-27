import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import { client as enrichClient } from "../src/extract/enrich.js";
import type { ExtractorInput } from "../src/extract/extractor.js";
import { APIError } from "openai";
import { UNRESOLVED_DESCRIPTION } from "../src/extract/extractor.js";
import type { ExtractedCard } from "../src/extract/schema.js";
import { card, candidate, settle, utterance } from "./helpers/cards.js";
import { ExtractionScheduler, selectVerifyTargets } from "../src/extract/scheduler.js";
import type { TermCard, TermLink, TermStatus } from "../src/protocol.js";

/**
 * 検証つき清書のスケジューラ側（#23）。
 *
 * 固定したいのは3つ。
 * 1. **検証対象の選定** — 補正あり・`status !== "confirmed"` は必ず通す。従来のレア度上位も残す
 * 2. **`candidates` をクライアントへ送らない** — `{ ...c }` のスプレッドなので放っておくと漏れる
 * 3. **棄却は `status: "unresolved"` として届く**（#24）。解説は速報のまま・リンクは空。
 *    記録は `term` と `reason` だけで、**文字起こし本文をログに出さない**
 *
 * 実 API は叩かない。抽出は private `extract` を差し替え、清書は `enrich.ts` の
 * `client.responses.create` を差し替える。**`enrichCard` は `void` の投げっぱなしなので、
 * 潰さないとダミーキーのまま api.openai.com へ本当にリクエストが飛ぶ。**
 */

type ExtractFn = (input: ExtractorInput) => Promise<ExtractedCard[]>;

// --- 検証対象の選定 -----------------------------------------------------

test("補正あり・status が confirmed でないカードは必ず検証する", () => {
  // **rare を3枚並べてレア度上位の枠を埋めておく。** 枠が空いていると C/D が
  // 従来条件だけで入ってしまい、追加した条件を消しても落ちないテストになる
  // （同レア度内では非 confirmed が優先されるので、common + probable は特に紛れやすい）。
  const cards = [
    card("A", { rarity: "rare" }),
    card("B", { rarity: "rare" }),
    card("C", { rarity: "rare" }),
    card("D", { rarity: "common", correctedFrom: "でぃー" }),
    card("E", { rarity: "common", status: "probable" }),
    card("F", { rarity: "common" }),
  ];
  const targets = selectVerifyTargets(cards);
  assert.deepEqual(
    [...targets].sort(),
    ["A", "B", "C", "D", "E"],
    "レア度上位の半数(A,B,C)に、補正ありの D と probable の E が加わる",
  );
  assert.ok(!targets.has("F"), "補正なし・confirmed・レア度下位は対象外のまま");
});

test("unresolved も検証対象に入れる（#24）", () => {
  // **`status === "probable"` と書いていると unresolved が黙って漏れる。**
  // 漏れると「特定できない」と言ったカードが一度も独立した情報源で確かめられない。
  // レア度上位の枠は rare 2枚で埋めておく（枠が空いていると条件を消しても通ってしまう）。
  const cards = [
    card("A", { rarity: "rare" }),
    card("B", { rarity: "rare" }),
    card("C", { rarity: "common", status: "unresolved" }),
    card("D", { rarity: "common" }),
  ];
  const targets = selectVerifyTargets(cards);
  assert.ok(targets.has("C"), "unresolved はレア度が下位でも検証する");
  assert.ok(!targets.has("D"), "補正なし・confirmed は従来どおり対象外になりうる");
});

test("補正なし・confirmed のカードは対象外になりうる", () => {
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
  updates: Array<{ term: string; status: TermStatus; description: string; links: TermLink[] }>;
  warnings: string[];
  /** `responses.create` に渡った入力（清書1回につき1件） */
  verifyInputs: string[];
  /** 次回以降の検証を失敗させる（null で解除） */
  failVerify: (err: unknown) => void;
  /** `extract()` に渡った入力（呼ばれた順） */
  extractInputs: ExtractorInput[];
  send: (text: string, cards: ExtractedCard[]) => Promise<void>;
}

/** SDK が実際に投げるのと同じ形のエラー（`error-classify.test.ts` と同じ作法）。 */
function apiError(status: number): APIError {
  return APIError.generate(status, { error: { message: "test" } }, undefined, new Headers());
}

/** `chosen` を決めるモック。入力に含まれる用語で分岐させ、並列でも取り違えない。 */
function harness(t: TestContext, decide: (input: string) => string | null): Harness {
  const emitted: TermCard[][] = [];
  const updates: Array<{ term: string; status: TermStatus; description: string; links: TermLink[] }> =
    [];
  const warnings: string[] = [];
  const verifyInputs: string[] = [];
  const extractInputs: ExtractorInput[] = [];
  let impl: ExtractFn = async () => [];

  // 次回以降の検証を失敗させる（null で解除）。例外パスの回帰テスト用
  let verifyError: unknown = null;
  const createSpy = mock.method(enrichClient.responses, "create", async (body: never) => {
    const input = String((body as unknown as { input: string }).input);
    verifyInputs.push(input);
    if (verifyError) throw verifyError;
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
    onCardUpdate: (term, status, description, links) =>
      updates.push({ term, status, description, links }),
    onExtracting: () => {},
    onError: () => {},
  });
  t.after(() => scheduler.stop());
  (scheduler as unknown as { extract: ExtractFn }).extract = (input) => {
    extractInputs.push(input);
    return impl(input);
  };

  return {
    emitted,
    updates,
    warnings,
    verifyInputs,
    failVerify: (err: unknown) => {
      verifyError = err;
    },
    extractInputs,
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

test("裏付けが取れたら card_update で差し替え、status は confirmed になる", async (t) => {
  const h = harness(t, () => "Kubernetes");
  // 速報は probable。**Stage 2 が裏付けたらここで格上げになる**ことまで見る
  await h.send(utterance("A"), [
    card("Kubernetes", { correctedFrom: "クバネテス", status: "probable" }),
  ]);

  assert.deepEqual(h.updates, [
    { term: "Kubernetes", status: "confirmed", description: "検証後の解説。", links: [] },
  ]);
  assert.equal(h.warnings.length, 0);
  assert.ok(
    h.verifyInputs[0]!.includes("クバネテス"),
    "元の表記が検証側に渡っている（candidates を落としても検証段の入力は残る）",
  );
});

test("棄却は status: unresolved として届き、term と reason だけを記録する", async (t) => {
  const chunk = utterance("A");
  const h = harness(t, () => null);
  const drafted = card("クーベルタン", { correctedFrom: "クバネテス", status: "probable" });
  await h.send(chunk, [drafted]);

  assert.equal(h.emitted.at(-1)!.length, 1, "速報カードは消さない（見た目だけ降格させる）");
  // **#24 の肝。** 棄却が初めて利用者に伝わる経路で、ここが confirmed のままだと
  // 「裏付けが取れなかったカード」が通常カードとして残る。
  // **解説も定型文に差し替える。** 速報の解説は「誤補正した用語」の説明なので、
  // 残すと「特定できませんでした」と言いながら別用語の断定的な定義を読ませることになる
  // （抽出段の `normalizeStatus` が同じことを担保しているので、降格経路だけ素通しにすると
  // 方針が非対称になる）。リンクは空でクライアントは確認中の表示を畳む。
  assert.deepEqual(h.updates, [
    {
      term: "クーベルタン",
      status: "unresolved",
      description: UNRESOLVED_DESCRIPTION,
      links: [],
    },
  ], "term は改名しない。status を unresolved へ降格し、解説は定型文にする");
  assert.notEqual(drafted.description, UNRESOLVED_DESCRIPTION, "速報の解説とは別物であること");
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
    {
      term: "クアドラント",
      status: "unresolved",
      description: UNRESOLVED_DESCRIPTION,
      links: [],
    },
  ], "term は変えず、status を unresolved にして見出しを surface form へ降ろす");
  assert.equal(h.warnings.length, 1);
  assert.ok(h.warnings[0]!.includes("クアドラント"));
});

/**
 * 検証が例外で落ちても「確認中」を畳む（#24 のレビュー指摘）。
 *
 * 速報を `willEnrich: true` で送った以上、黙ると回り続けるスピナーが残り、
 * localStorage にもその状態で保存されるので復元しても消えない。#23 で棄却時に
 * 踏んだのと同じ穴が、例外パスに残っていた。**#24 で `unresolved` を検証対象に
 * 足したぶん Stage 2 に回るカードが増えており、被弾面積が広がっている。**
 */
test("検証が例外で落ちても card_update を送り、速報の status を保つ", async (t) => {
  const h = harness(t, () => "Kubernetes");
  h.failVerify(new Error("boom"));
  const drafted = card("Kubernetes", { correctedFrom: "クバネテス", status: "probable" });
  await h.send(utterance("A"), [drafted]);

  assert.deepEqual(h.updates, [
    {
      term: "Kubernetes",
      status: "probable",
      description: drafted.description,
      links: [],
    },
  ], "検証できなかっただけなので status と解説はそのまま。リンクだけ空で確認中を畳む");
});

/**
 * 恒久エラーで検証を打ち切った後は `willEnrich: false` で送る。
 *
 * `willEnrich` は「後から `card_update` が来る」の予告なので、打ち切り後も true だと
 * 誰も更新を送らないまま確認中の表示が会議の終わりまで残る。
 */
test("検証を打ち切った後のカードは willEnrich: false で送る", async (t) => {
  const h = harness(t, () => "Kubernetes");
  h.failVerify(apiError(401));
  await h.send(utterance("A"), [card("Kubernetes", { correctedFrom: "クバネテス" })]);
  // 1チャンク目で verifyDisabled が立つ
  h.failVerify(null);
  await h.send(utterance("B"), [card("Grafana", { correctedFrom: "グラハム" })]);

  const second = h.emitted.at(-1)!;
  assert.deepEqual(
    second.map((c) => [c.term, c.willEnrich]),
    [["Grafana", false]],
    "打ち切り後は更新を送らないので、確認中の表示も出さない",
  );
  assert.equal(h.verifyInputs.length, 1, "2枚目は検証にも回さない");
});

/**
 * unresolved の推定 term はプロンプトの「表示済み用語リスト」に載せない（#24 のレビュー指摘）。
 *
 * 載せると規則2「表示済みの用語は出力しない」が効き、**後で誰かが同じ用語を明瞭に
 * 発話しても正しいカードが出なくなる**。特定できなかった推定でデデュープの枠を
 * 永久に占有させない。
 */
test("unresolved の term は表示済みリストに載せない", async (t) => {
  const h = harness(t, () => "Grafana");
  await h.send(utterance("A"), [
    card("Grafana", { status: "unresolved", correctedFrom: "グラファトス" }),
    card("Kubernetes", { status: "confirmed" }),
  ]);
  // 2チャンク目の入力に渡った表示済みリストを見る
  await h.send(utterance("B"), []);

  const shown = h.extractInputs.at(-1)!.shownTerms;
  assert.deepEqual(shown, ["Kubernetes"], "特定できた用語だけがリストに載る");
});
