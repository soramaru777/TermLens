import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import { client as extractClient } from "../src/extract/extractor.js";
import { client as enrichClient, type Verification } from "../src/extract/enrich.js";
import type { ExtractedCard } from "../src/extract/schema.js";
import { card, candidate } from "./helpers/cards.js";
import { verifyOutput } from "./helpers/verify.js";
import { TermCaseSchema } from "../src/eval/cases.js";
import { formatTable, runEval, type EvalReport, type VerifyTally } from "../src/eval/run.js";

/**
 * 検証の内訳（`VerifyTally`）を評価ハーネスが正しく数えるか（#25 の第1・第2段階）。
 *
 * **この2つは「人が判断するための数字」なので、静かに狂うと実装より害が大きい。**
 *
 * - `searches` — `MAX_WEB_SEARCHES` の値を決める材料。測らずに上限を勘で入れると、
 *   絞りすぎて裏付けが取れず **#24 の最大リスク（過剰 unresolved）を悪化させる**
 * - 棄却の内訳 — 「実在しなかった」と「実在するが会議の話ではなかった」を合算すると、
 *   過剰 unresolved が**諦めなのか正しい棄却なのか**を読めない
 *
 * **実 API は叩かない。** 抽出は `chat.completions.parse`、検証は `responses.create` を
 * 差し替えて、`runEval()` を本番と同じ経路で1周させる。
 */

/** 抽出段が返すカード1枚。検証にかかる形（補正あり・非 confirmed）にしておく。 */
function extractedCard(term: string, correctedFrom: string): ExtractedCard {
  return card(term, {
    description: "速報の解説。",
    status: "probable",
    correctedFrom,
    surfaceForms: [correctedFrom],
  });
}

interface VerifyReply {
  /** 検証の内訳。棄却の分類はこれで決まる */
  verification: Verification;
  chosen: string | null;
  /** この応答で走った web 検索の回数 */
  searches: number;
}

/**
 * 抽出・検証の両方を差し替えて `runEval()` を1周させる。
 * 検証の応答はカード（＝入力に含まれる用語）ごとに引く。
 */
async function runWith(
  t: TestContext,
  cards: ReturnType<typeof extractedCard>[],
  replies: Record<string, VerifyReply>,
  options: { glossary?: string[]; verifyInputs?: string[] } = {},
): Promise<EvalReport> {
  const verifyInputs = options.verifyInputs ?? [];
  const extractSpy = mock.method(extractClient.chat.completions, "parse", async () => ({
    choices: [{ message: { parsed: { cards } } }],
  }));
  const verifySpy = mock.method(enrichClient.responses, "create", async (body: never) => {
    const input = String((body as unknown as { input: string }).input);
    verifyInputs.push(input);
    const hit = Object.entries(replies).find(([term]) => input.includes(term));
    assert.ok(hit, `検証の応答を用意していない入力: ${input}`);
    const reply = hit[1];
    return {
      output_text: verifyOutput({
        verification: reply.verification,
        chosen: reply.chosen,
        reason: "テストの判定",
        description: "検証後の解説。",
      }),
      // 件数だけが意味を持つ。リンクは別のテストで見ている
      output: Array.from({ length: reply.searches }, () => ({ type: "web_search_call" })),
    };
  });
  t.after(() => {
    extractSpy.mock.restore();
    verifySpy.mock.restore();
  });

  return runEval({
    cases: [
      TermCaseSchema.parse({
        id: "tally",
        transcript: "テスト用の文字起こし。",
        expectTerms: cards.map((c) => c.term),
        ...(options.glossary ? { glossary: options.glossary } : {}),
      }),
    ],
    config: { runs: 1, concurrency: 1, withVerify: true, allowRename: false },
  });
}

const EXISTS_AND_FITS = { exists: true, fitsContext: true, evidence: "公式ドキュメント" };

test("棄却は「実在しない」と「文脈に合わない」に分けて数える", async (t) => {
  const report = await runWith(
    t,
    [extractedCard("Qdrant", "クドラント"), extractedCard("Ansible", "アンシブル")],
    {
      // 実在しない
      Qdrant: {
        verification: { exists: false, fitsContext: false, evidence: "該当なし" },
        chosen: null,
        searches: 3,
      },
      // 実在するが会議の話ではない
      Ansible: {
        verification: { exists: true, fitsContext: false, evidence: "別分野のページ" },
        chosen: null,
        searches: 2,
      },
    },
  );

  const tally = report.verifyTally!;
  assert.equal(tally.checked, 2);
  // 合算した実装（旧 `rejected` 一本）に戻すと、この2本のどちらかが必ず落ちる
  assert.equal(tally.rejected["not-exist"], 1, "実在しなかったぶん");
  assert.equal(tally.rejected["off-context"], 1, "実在するが文脈に合わなかったぶん");
});

/**
 * **候補外の棄却を「文脈に合わない」に混ぜない。**
 *
 * モデルは `exists: true, fitsContext: true` と言ったうえで候補に無い用語を返しうる。
 * 棄却したのは `parseVerifyOutput()` 側の判断なので、`verification` を見て内訳を
 * 決め直すと**この棄却が「文脈に合わなかった」に化ける**。内訳は過剰 unresolved の
 * 原因分析に使う数字なので、静かに汚れると指標そのものが判断材料にならなくなる。
 */
test("候補外の用語が返された棄却は独立の理由として数える", async (t) => {
  const report = await runWith(t, [extractedCard("Qdrant", "クドラント")], {
    Qdrant: { verification: EXISTS_AND_FITS, chosen: "Pinecone", searches: 2 },
  });

  const tally = report.verifyTally!;
  assert.equal(tally.rejected["out-of-candidates"], 1, "候補外はそれと分かる形で数える");
  assert.equal(tally.rejected["off-context"], 0, "モデルの申告から推測し直すと化ける");
  assert.equal(tally.rejected["not-exist"], 0);
});

/**
 * 評価ハーネスも**本番と同じ絞り込みを通す**（#25、AC2）。
 *
 * 素通しにすると評価だけ違う入力を測ることになり、しかも用語集は参加者名・社名を含むので
 * **評価ランのたびに氏名が web 検索へ乗る**（`selectVerifyTargets()` を共有しているのと
 * 同じ理由。片方だけ経路が違うと、緑のまま本番と食い違う）。
 */
test("評価も用語集を絞り込んでから検証へ渡す", async (t) => {
  const verifyInputs: string[] = [];
  await runWith(
    t,
    [extractedCard("Qdrant", "クドラント")],
    { Qdrant: { verification: EXISTS_AND_FITS, chosen: "Qdrant", searches: 1 } },
    { glossary: ["Qdrant Cloud", "山田太郎", "株式会社テスト工業"], verifyInputs },
  );

  assert.equal(verifyInputs.length, 1);
  assert.ok(!verifyInputs[0]!.includes("山田太郎"), "参加者名を web 検索へ送らない");
  assert.ok(!verifyInputs[0]!.includes("株式会社テスト工業"), "社名も送らない");
  assert.ok(!verifyInputs[0]!.includes("Cloud"), "当たった語以外は同じ行にあっても送らない");
});

test("web 検索の回数を合計する（棄却でも数える）", async (t) => {
  const report = await runWith(
    t,
    [extractedCard("Qdrant", "クドラント"), extractedCard("Ansible", "アンシブル")],
    {
      Qdrant: { verification: EXISTS_AND_FITS, chosen: "Qdrant", searches: 4 },
      Ansible: {
        verification: { exists: true, fitsContext: false, evidence: "別分野" },
        chosen: null,
        searches: 2,
      },
    },
  );

  const tally = report.verifyTally!;
  assert.equal(tally.searches, 6, "採用できたカードだけ数えると分布が良い側へ偏る");
  assert.equal(tally.checked, 2);
});

/** 数えていてもレポートに出さなければ人は判断できない。 */
test("formatTable が検索回数と棄却の内訳を出す", async (t) => {
  // **レポートは実物を使う。** ここで `EvalReport` を手で組み立てて `as unknown as` で
  // 型を潰すと、`config` や `overall` にフィールドが増えてもこのモックだけ古いまま通る
  const base = await runWith(t, [extractedCard("Qdrant", "クドラント")], {
    Qdrant: { verification: EXISTS_AND_FITS, chosen: "Qdrant", searches: 1 },
  });
  const tally: VerifyTally = {
    checked: 4,
    rejected: { "not-exist": 1, "off-context": 2, "out-of-candidates": 0, unspecified: 0 },
    replaced: 0,
    failed: 1,
    searches: 10,
    rematchChecked: 0,
    rematchSearches: 0,
    rematchFailed: 0,
  };
  const report: EvalReport = { ...base, verifyTally: tally };

  const table = formatTable(report);
  assert.ok(table.includes("実在せず 1"), "実在しなかった棄却の件数");
  assert.ok(table.includes("文脈に合わず 2"), "文脈に合わなかった棄却の件数");
  assert.ok(table.includes("棄却 3"), "合計も読めるようにする");
  assert.ok(table.includes("web検索 10回"), "上限値を決める材料をレポートに出す");
  assert.ok(table.includes("1件あたり 2.5"), "1カードあたりの平均が上限値の目安になる");
  // **そのランの上限も出す。** 上限がいくつだったか分からない平均は読めない
  // （`model` を実効値で残しているのと同じ理由）
  assert.ok(/上限(なし|\d+)/.test(table), "そのランで効いていた上限をレポートに残す");
});

/**
 * **再評価(#40)の数字は Stage 2 と混ぜない。**
 *
 * `searches` を `checked` で割った値が `MAX_WEB_SEARCHES` を決めるための「1カードあたり
 * 平均検索回数」で、再評価の検索を足すと**分母に対応しない回数が入って水増しされる**。
 * `failed` も同様で、あちらは「Stage 2 の呼び出しが失敗し判断保留にしたカード数」という
 * 定義。混ぜると意味が2つになり、どちらの数字なのか読めなくなる。
 *
 * 再評価を発火させるため、崩れた表記の unresolved カードと、それと音で対応する確定
 * カードを1ケースに置く（表記はすべて匿名化した合成データ）。
 */
test("再評価の検索回数と失敗は Stage 2 の集計に混ぜない", async (t) => {
  const unresolved = card("エービ", {
    status: "unresolved",
    surfaceForms: ["えーび"],
    correctedFrom: "えーび",
    candidates: [candidate("エービ"), candidate("AB")],
  });
  // **`surfaceForms` は当てにできない。** `filterSurfaceForms()` が「文字起こしに実在する
  // 表記」だけに絞るので、合成ケースの短い transcript では空になる。音で対応する手がかりは
  // `correctedFrom`（＝ 音声認識が崩した元の表記）から届く
  const hint = card("AB Studio", { status: "confirmed", correctedFrom: "エービー" });
  const report = await runWith(t, [unresolved, hint], {
    // 再評価の入力（元の表記が「えーび」）には AB を返して昇格させる
    えーび: { verification: EXISTS_AND_FITS, chosen: "AB", searches: 4 },
    // 清書（Stage 2）はそのまま通す
    "AB Studio": { verification: EXISTS_AND_FITS, chosen: "AB Studio", searches: 1 },
  });

  const t2 = report.verifyTally!;
  assert.ok(t2.rematchChecked > 0, "再評価が発火していない（テストの前提が崩れている）");
  assert.equal(t2.rematchSearches, 4, "再評価の検索を別に数えていない");
  assert.equal(
    t2.searches,
    1,
    "再評価の検索が searches に混ざっている（1カードあたり平均が水増しされる）",
  );
});

/**
 * **再評価の母集団は本番の `pendingUnresolved` に合わせる。**
 *
 * 本番で積まれるのは抽出段が `unresolved` にしたカードだけで、Stage 2 が降格させた
 * カードは積まれない。評価だけ降格後のカードまで再検証すると、**直前に棄却された
 * カードをほぼ同じ候補で問い直す**ことになり、本番に存在しない母集団の数字が
 * `rematchChecked` と誤補正率に混ざる（人が閾値と増分コストを決める前提が崩れる）。
 */
test("Stage 2 が降格させたカードは再評価の対象にしない", async (t) => {
  // 抽出段は probable。Stage 2 が棄却して unresolved に落とす
  const demoted = extractedCard("エービ", "えーび");
  const hint = card("AB Studio", { status: "confirmed", correctedFrom: "エービー" });
  const report = await runWith(t, [demoted, hint], {
    えーび: { verification: { exists: false, fitsContext: false, evidence: "該当なし" }, chosen: null, searches: 2 },
    "AB Studio": { verification: EXISTS_AND_FITS, chosen: "AB Studio", searches: 1 },
  });

  assert.equal(
    report.verifyTally!.rematchChecked,
    0,
    "Stage 2 で降格したカードを再評価に回している（本番には無い母集団）",
  );
});
