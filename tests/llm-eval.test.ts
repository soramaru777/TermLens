import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "../src/eval/cases.js";
// 値の参照のみ。ダミーキー注入そのものは package.json の `--import` が済ませている
// （このファイルの import 順には依存しない）。
import { DUMMY_OPENAI_KEY } from "./helpers/openai-env.js";

/**
 * LLM を実際に呼ぶ評価（案B）。
 *
 * **既定の `npm test` では絶対に走らせない。** 実 API 課金が発生し、結果も非決定的なので、
 * `RUN_LLM_EVAL=1` を明示したときだけ実行する。CI（.github/workflows/test.yml）は
 * この環境変数を設定しないため、決定的テストだけが回る。
 */
const enabled = process.env.RUN_LLM_EVAL === "1";

let hasApiKey = false;
if (enabled) {
  // .env を読み込む（副作用のみ）。無効時は import しない = OpenAI にも config にも触らない。
  await import("../src/config.js");
  // ヘルパが入れたダミーは「キーがある」と数えない。数えると実 API を叩きに行って落ちる。
  const key = process.env.OPENAI_API_KEY;
  hasApiKey = Boolean(key) && key !== DUMMY_OPENAI_KEY;
}

// skip 理由には実際の値を出す。`RUN_LLM_EVAL=true` のように厳密一致から外れた指定は
// 黙って skip されるため、値が見えないと「有効にしたつもり」に気づけない。
const rawFlag = process.env.RUN_LLM_EVAL;
const skip = !enabled
  ? `RUN_LLM_EVAL=1 のときだけ実行する（現在: ${rawFlag === undefined ? "未設定" : JSON.stringify(rawFlag)}。"1" 以外はすべて skip）`
  : !hasApiKey
    ? "OPENAI_API_KEY が設定されていないためスキップ"
    : false;

// ケースファイルの検証だけは LLM 無しでできるので常に回す。
test("評価ケースの JSON がスキーマを満たす", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 8, `ケース数が少なすぎます: ${cases.length}`);
  for (const c of cases) {
    assert.ok(c.transcript.length > 0);
    // expectCorrection のキーは transcript に実際に現れる誤表記であること
    for (const wrong of Object.keys(c.expectCorrection)) {
      assert.ok(c.transcript.includes(wrong), `${c.id}: "${wrong}" が transcript に無い`);
    }
  }
});

test("LLM 用語抽出が閾値を満たす", { skip, timeout: 15 * 60_000 }, async () => {
  const { runEval, formatTable } = await import("../src/eval/run.js");
  const report = await runEval();
  console.error(formatTable(report));
  assert.ok(report.pass, report.failures.map((f) => `${f.metric}: ${f.actual}`).join(", "));
});
