import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import { client as enrichClient } from "../src/extract/enrich.js";
import type { ExtractorInput } from "../src/extract/extractor.js";
import { APIError } from "openai";
import { UNRESOLVED_DESCRIPTION } from "../src/extract/extractor.js";
import type { ExtractedCard } from "../src/extract/schema.js";
import { card, candidate, settle, utterance } from "./helpers/cards.js";
import { verifyOutput } from "./helpers/verify.js";
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

/**
 * `unresolved` は検証に回さない（#24 のレビュー指摘）。
 *
 * 昇格の経路が無く（`card_update` は term で突き合わせるので改名できない）、解説も
 * 定型文で固定されるため、**検証結果を使える余地が1つも無い**。回すと web 検索の
 * 課金だけが増える。昇格を防ぎつつ解説だけ更新すると「特定できませんでした」の見出しの
 * 下に確定した別用語の断定的な解説が出て、この Issue が防ごうとした形そのものになる。
 */
test("unresolved は検証に回さない（#24）", () => {
  const cards = [
    card("A", { rarity: "rare", status: "unresolved", correctedFrom: "えー" }),
    card("B", { rarity: "common", status: "probable" }),
  ];
  const targets = selectVerifyTargets(cards);
  assert.ok(!targets.has("A"), "レア度上位でも補正ありでも回さない");
  assert.ok(targets.has("B"), "probable は従来どおり回す");
});

test("unresolved はレア度上位の枠も食わない", () => {
  // 枠まで食われると、検証すべき probable が漏れる。
  // 分母は元のカード数（4）のままなので枠は2つ
  const cards = [
    card("A", { rarity: "rare", status: "unresolved" }),
    card("B", { rarity: "rare", status: "unresolved" }),
    card("C", { rarity: "uncommon" }),
    card("D", { rarity: "common" }),
  ];
  const targets = selectVerifyTargets(cards);
  // 枠の分母は targetable の枚数（2）なので ceil(2/2) = 1。元のカード数（4）を分母に
  // すると枠が2つ余り、検証する意味のない confirmed まで入る
  assert.deepEqual([...targets].sort(), ["C"], "unresolved を除いた中から枠を埋める");
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
  /** `onError` で利用者へ届いた通知（メッセージと permanent の対） */
  errors: Array<{ message: string; permanent: boolean | undefined }>;
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

/**
 * `chosen` を決めるモック。入力に含まれる用語で分岐させ、並列でも取り違えない。
 *
 * `glossary` はスケジューラのコンストラクタへ渡す用語集（#25）。既定は空で、
 * 「関連語だけが検証側へ渡る」ことを見るテストだけ指定する。
 */
function harness(
  t: TestContext,
  decide: (input: string) => string | null,
  glossary: string[] = [],
): Harness {
  const emitted: TermCard[][] = [];
  const updates: Array<{ term: string; status: TermStatus; description: string; links: TermLink[] }> =
    [];
  const warnings: string[] = [];
  const errors: Array<{ message: string; permanent: boolean | undefined }> = [];
  const verifyInputs: string[] = [];
  const extractInputs: ExtractorInput[] = [];
  let impl: ExtractFn = async () => [];

  // 次回以降の検証を失敗させる（null で解除）。例外パスの回帰テスト用
  let verifyError: unknown = null;
  const createSpy = mock.method(enrichClient.responses, "create", async (body: never) => {
    const input = String((body as unknown as { input: string }).input);
    verifyInputs.push(input);
    if (verifyError) throw verifyError;
    const chosen = decide(input);
    return {
      // 棄却は「実在するが文脈に合わない」側で返す（#25）。`chosen` と矛盾しない組に
      // しておかないと `normalizeVerification()` が倒すので、テストの意図が濁る
      output_text: verifyOutput({
        verification: { exists: true, fitsContext: chosen !== null, evidence: "テストの根拠" },
        chosen,
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

  const scheduler = new ExtractionScheduler(glossary, {
    onCards: (c) => emitted.push(c),
    onCardUpdate: (term, status, description, links) =>
      updates.push({ term, status, description, links }),
    onExtracting: () => {},
    onError: (message, permanent) => errors.push({ message, permanent }),
  });
  t.after(() => scheduler.stop());
  (scheduler as unknown as { extract: ExtractFn }).extract = (input) => {
    extractInputs.push(input);
    return impl(input);
  };

  return {
    emitted,
    errors,
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

/**
 * 用語集が検証段まで届く配線（#25、AC2）。
 *
 * **届かないと関連語は常に空になり、絞り込みのテストが「何も渡していない」ことを
 * 確かめるだけの空回りになる**（#22 で踏んだ「単体では正しい部品が、配線だけ抜けても
 * 誰も気づかない」の再来）。同時に、**参加者名が web 検索へ乗らない**ことも本番の経路で見る。
 *
 * 関連語は「候補と語として一致したもの」なので候補の表記と重なる。配線が抜けたことは
 * **節が `(なし)` に落ちる**ことで判別する。
 */
test("用語集は関連語だけが検証段へ渡る（参加者名は渡らない）", async (t) => {
  const h = harness(t, () => "Qdrant", ["Qdrant Cloud", "山田太郎", "株式会社テスト工業"]);
  await h.send(utterance("A"), [card("Qdrant", { correctedFrom: "クドラント" })]);

  assert.equal(h.verifyInputs.length, 1);
  const hints = h.verifyInputs[0]!.split("# 用語集の関連語")[1]!.split("#")[0]!;
  assert.ok(hints.includes("Qdrant"), "候補と一致した用語集の語が届く");
  assert.ok(!hints.includes("(なし)"), "配線が抜けると節が (なし) に落ちる");
  assert.ok(!h.verifyInputs[0]!.includes("山田太郎"), "参加者名は web 検索へ送らない");
  assert.ok(!h.verifyInputs[0]!.includes("株式会社テスト工業"), "社名も送らない");
  assert.ok(!h.verifyInputs[0]!.includes("Cloud"), "当たった語以外は同じ行にあっても渡さない");
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
  // **棄却の内訳も記録する**（#25）。「実在しなかった」のか「実在するが会議の話では
  // なかった」のかが本番ログでも読めないと、過剰 unresolved の原因分析ができない
  assert.ok(h.warnings[0]!.includes("文脈に合わず"), "棄却の理由を記録する");
  assert.ok(!h.warnings[0]!.includes("テストの根拠"), "evidence は出さない（自由文を増やさない）");
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

  // **差し替えは棄却ではない。** ログの分岐が `!isVerified()` なのでここも通るが、
  // 一律に棄却として扱うと `rejection` が null のまま `(理由なし)` と出る
  // ——「実在: あり / 文脈整合: あり なのに棄却」と同じ形の自己矛盾した行になる。
  assert.equal(h.warnings.length, 1);
  assert.ok(h.warnings[0]!.includes("別候補"), "何が起きたのかを正しく書く");
  assert.ok(!h.warnings[0]!.includes("理由なし"), "棄却の内訳を差し替えに流用しない");
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

  // **打ち切りは利用者へ知らせる**（#25 のレビュー指摘）。抽出は `disableExtraction()` が
  // 通知するのに検証だけ無言だと、以降ずっと未検証のカードが出続けることを誰も知れない。
  // 確認中の表示すら出ないので、画面からは正常時と区別がつかない。
  assert.equal(h.errors.length, 1, "検証を打ち切ったことを通知する");
  assert.ok(h.errors[0]!.message.includes("検証を停止"), "何が止まったのかを伝える");
  assert.equal(h.errors[0]!.permanent, undefined, "抽出は生きているので permanent は立てない");
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
