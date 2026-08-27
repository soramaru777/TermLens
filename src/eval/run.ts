import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// config.js は dotenv を読むだけ（OpenAI クライアントは作らない）。
// レポートに実際のモデル名を残すために import する。
import { config as appConfig } from "../config.js";
// 型だけ。schema.js は zod しか読まないので OpenAI クライアントは評価されない。
import type { ExtractedCard } from "../extract/schema.js";
// 依存ゼロのモジュール。`enrich.js` から取ると既定モードでも `new OpenAI()` が走る
import { REJECTION_KINDS, REJECTION_LABEL, type RejectionKind } from "../extract/rejection.js";
import { loadCases, type TermCase } from "./cases.js";
import {
  aggregate,
  scoreCase,
  sumTotals,
  toMetrics,
  type CaseScore,
  type EvaluatedCard,
  type Metrics,
} from "./metrics.js";

/**
 * LLM 評価ハーネス（案B）。
 *
 * **既定の `npm test` からは呼ばれない。** 実 API を叩いて課金が発生し、結果も非決定的なので、
 * `RUN_LLM_EVAL=1` を明示したときだけ走らせるオプトイン実行にしている。
 * 手で回すときは `npm run eval:llm`。
 */

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} は数値で指定してください: ${raw}`);
  return value;
}

/**
 * 試行回数・並列数のような「1以上の整数」用。
 *
 * numEnv のままだと `EVAL_RUNS=0` がジョブ0件（= 何も測らずに全指標 1.0 で PASS）に、
 * `EVAL_RUNS=2.5` が黙って2回になる。品質ゲートとして最悪の失敗モードなので入口で弾く。
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} は1以上の整数で指定してください: ${raw}`);
  }
  return value;
}

/**
 * 0/1 のフラグ用。
 *
 * `EVAL_NO_CONTEXT=true` のような書き方を黙って無視すると、「文脈なしで測ったつもりが
 * 文脈ありだった」レポートができ、比較そのものが無意味になる。入口で弾く。
 */
function flagEnv(name: string): boolean {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return false;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${name} は 0 か 1 で指定してください: ${raw}`);
}

/** 閾値と試行回数の既定値。すべて環境変数で上書きできる。ここが唯一の定義箇所。 */
export const EVAL_DEFAULTS = {
  /** 1ケースあたりの試行回数。LLM の出力が揺れるため複数回の平均で見る */
  runs: 3,
  /** 同時に投げる (ケース × 試行) の数 */
  concurrency: 4,
  /** ケースの `context` を抽出器に渡すか。`EVAL_NO_CONTEXT=1` で false にして比較する */
  useContext: true,
  /**
   * Stage 2（検証つき清書）まで通すか。`EVAL_WITH_VERIFY=1` で true にする（#23）。
   *
   * 既定は false。ハーネスは `createExtractor()` を直接呼ぶので、そのままでは
   * **Stage 1 しか測らない**。2モードに分けてあるのは切り分けのためで、
   * 「候補列挙のプロンプト変更」と「検証そのもの」は別々に悪化しうる。
   * 有効にすると web 検索を伴うので**遅く高い**。
   */
  withVerify: false,
  /**
   * 検証の判定を評価側で適用するか。`EVAL_ALLOW_RENAME=1` で true（#23）。
   *
   * 既定 false は**本番と同じ**（改名の経路が無いので Stage 2 は term ベースの指標を
   * 動かさない）。true は「改名できたらどうなるか」の探索用で、合否の根拠にはしない。
   */
  allowRename: false,
  minRecall: 0.8,
  maxMiscorrection: 0.05,
  minPrecision: 0.6,
} as const;

export interface EvalConfig {
  runs: number;
  concurrency: number;
  useContext: boolean;
  withVerify: boolean;
  allowRename: boolean;
  minRecall: number;
  maxMiscorrection: number;
  minPrecision: number;
}

export function resolveConfig(overrides: Partial<EvalConfig> = {}): EvalConfig {
  return {
    runs: positiveIntEnv("EVAL_RUNS", EVAL_DEFAULTS.runs),
    concurrency: positiveIntEnv("EVAL_CONCURRENCY", EVAL_DEFAULTS.concurrency),
    useContext: EVAL_DEFAULTS.useContext && !flagEnv("EVAL_NO_CONTEXT"),
    withVerify: flagEnv("EVAL_WITH_VERIFY") || EVAL_DEFAULTS.withVerify,
    allowRename: flagEnv("EVAL_ALLOW_RENAME") || EVAL_DEFAULTS.allowRename,
    minRecall: numEnv("EVAL_MIN_RECALL", EVAL_DEFAULTS.minRecall),
    maxMiscorrection: numEnv("EVAL_MAX_MISCORRECTION", EVAL_DEFAULTS.maxMiscorrection),
    minPrecision: numEnv("EVAL_MIN_PRECISION", EVAL_DEFAULTS.minPrecision),
    ...overrides,
  };
}

export interface Failure {
  metric: string;
  actual: number;
  threshold: number;
}

/** 実行そのものが失敗したジョブ（429・5xx・タイムアウト等）。指標の分母には入らない。 */
export interface JobError {
  id: string;
  run: number;
  message: string;
}

export interface EvalReport {
  /** 前回結果との差分比較で「同じ条件か」を見分けるための情報 */
  startedAt: string;
  model: string;
  /** そのランで実際に効いていた web 検索の上限(#25)。0 なら上限なし */
  maxWebSearches: number;
  config: EvalConfig;
  /** 投入したジョブ数（ケース数 × 試行回数） */
  totalJobs: number;
  /** ケース別スコア（試行ごと）。失敗したジョブは含まれない */
  scores: CaseScore[];
  /** ケース別の集計（試行をまとめたもの） */
  perCase: Array<{ id: string; metrics: Metrics; runs: number }>;
  /** 全体スコア */
  overall: Metrics;
  /**
   * 実行できなかったジョブ。1件でもあれば **結果は不完全** で、pass にはしない
   * （測れなかったぶんが指標に反映されないため、通してしまうと過大評価になる）。
   */
  jobErrors: JobError[];
  /** 検証（EVAL_WITH_VERIFY=1）の内訳。無効時は undefined */
  verifyTally?: VerifyTally;
  failures: Failure[];
  pass: boolean;
}

/** 上限つき並列実行。順序は保たない（結果は id/run で識別する）。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

type Verifier = (
  cards: ExtractedCard[],
  context: string,
  glossary: string[],
) => Promise<ExtractedCard[]>;

/** 検証が何をしたかの内訳。指標だけ見ても過剰棄却か正しい修正かが分からないため別に数える */
export interface VerifyTally {
  /** 検証にかけたカード数 */
  checked: number;
  /**
   * 棄却の内訳(#25)。**`rejected` の一本槍から理由別に割ったのが #25 の核心。**
   *
   * 合算したままだと「実在しない」と「実在するが会議の話ではない」が混ざり、
   * **過剰 unresolved が諦めなのか正しい棄却なのかを読めない**（#24 で最大リスクと
   * した問題の原因分析ができない）。合計を見たいときは値を足す。
   *
   * **`replaced` は含まない。** 別候補への差し替えも本番相当モードでは unresolved 降格
   * ＝棄却の一種だが、原因が違う（候補の順位づけの問題）ので別に数える。
   * 「棄却」の欄だけを読んで全体像だと思わないこと。
   */
  rejected: Record<RejectionKind, number>;
  /** 検証が別候補へ差し替えたカード数 */
  replaced: number;
  /** 検証の呼び出し自体が失敗し、判断保留にしたカード数 */
  failed: number;
  /**
   * web 検索の実行回数の合計(#25)。**`MAX_WEB_SEARCHES` の値を人が決めるための材料。**
   * `checked` で割れば1カードあたりの平均になる。
   */
  searches: number;
}

/**
 * 1ケース内で同時に走らせる検証の数。
 *
 * カード同士は独立なので直列にする理由が無い。実効の同時実行数は
 * `config.concurrency`(既定4) × この値になるので、429 を踏まない範囲で小さく取る。
 */
const VERIFY_CONCURRENCY = 2;

/**
 * Stage 2（検証つき清書）を評価に通すための関数を組み立てる（#23）。
 *
 * 選定は本番と同じ `selectVerifyTargets()` を使う。ここにコピーを置くと、
 * 本番の選定条件を変えたときに**評価だけ古い条件のまま緑になる**。
 *
 * **既定はカード集合を一切変えない（本番と同じ）。** 本番の `card_update` は `term` で
 * カードを突き合わせるので改名の経路が無く、棄却しても速報カードはそのまま残る。
 * つまり**現行の protocol では Stage 2 は term ベースの指標を動かさない**。評価だけ
 * 差し替え・棄却を適用すると、本番なら `miscorrections` に数えられるカードが
 * `correctionHit` に化け、**合否ゲート(`maxMiscorrection`)が本番より甘い側にずれる**。
 * 検証が何をしたかは `VerifyTally` に出るので、判断材料はそちらで読む。
 *
 * `EVAL_ALLOW_RENAME=1` で「改名できたらどうなるか」の探索モードになる。別候補が
 * 選ばれたら差し替え、裏付けがまったく取れなければ落とす。**この数値は本番の挙動では
 * ないので、合否の根拠にはしないこと。** 読むときは誤補正率と正しい補正率を必ず
 * セットで見る（何も補正しなくなれば誤補正率は 0 になる）。Precision の分母は用語数なので、
 * カードを落とすほど見かけの Precision も上がる。
 */
async function createVerifier(allowRename: boolean): Promise<{
  verify: Verifier;
  tally: VerifyTally;
}> {
  // enrich.js / scheduler.js は import しただけで `new OpenAI()` を評価する。
  // 既定モードでは読み込まないよう、createExtractor と同じく動的 import にする。
  const { isVerified, verifyAndEnrich } = await import("../extract/enrich.js");
  const { selectVerifyTargets } = await import("../extract/scheduler.js");
  const { buildGlossaryIndex, relatedGlossary } = await import("../extract/glossary.js");
  const tally: VerifyTally = {
    checked: 0,
    rejected: Object.fromEntries(REJECTION_KINDS.map((k) => [k, 0])) as Record<
      RejectionKind,
      number
    >,
    replaced: 0,
    failed: 0,
    searches: 0,
  };

  const verify: Verifier = async (cards, context, glossary) => {
    const targets = selectVerifyTargets(cards);
    // **本番と同じく1ケースにつき1度だけ索引を作る**(`ExtractionScheduler` のフィールドと対)
    const glossaryIndex = buildGlossaryIndex(glossary);
    const verified = await mapLimit(cards, VERIFY_CONCURRENCY, async (card) => {
      if (!targets.has(card.term)) return card;
      tally.checked += 1;
      try {
        const result = await verifyAndEnrich({
          candidates: card.candidates,
          correctedFrom: card.correctedFrom,
          context,
          // **用語集も本番と同じ経路で渡す**(#25)。渡さないと関連語が常に空になり、
          // 評価だけ本番と違う入力を測る(`selectVerifyTargets()` を共有しているのと同じ理由)。
          glossaryHints: relatedGlossary(glossaryIndex, card.candidates),
        });
        tally.searches += result.searches;
        // **本番の Stage 2 は status を動かす(#24)。** 既定モードはカード集合を変えないが、
        // status だけは本番と同じに揃える。揃えないと `EVAL_WITH_VERIFY=1` の
        // probable / unresolved 列が Stage 1 の申告のままになり、検証の効果が数字に出ない。
        // term は変えないので Recall / 誤補正率 / Precision には影響しない。
        if (isVerified(card.term, result.chosen)) return { ...card, status: "confirmed" as const };
        if (result.chosen !== null) {
          tally.replaced += 1;
          // 候補#2 の採用は本番では裏付け無し扱い（改名の経路が無い）＝ unresolved へ降格
          return allowRename
            ? { ...card, term: result.chosen }
            : { ...card, status: "unresolved" as const };
        }
        // **棄却は内訳に分けて数える**(#25)。理由は `verifyAndEnrich()` が
        // `rejection` として返すものをそのまま使い、ここで `verification` から
        // 推測し直さない。候補外の棄却はモデルが `exists: true, fitsContext: true` と
        // 言ったまま起きるので、推測すると「文脈に合わない」に化ける。
        tally.rejected[result.rejection ?? "unspecified"] += 1;
        return allowRename ? null : { ...card, status: "unresolved" as const };
      } catch (err) {
        // 抽出の課金は済んでいる。1カードの検証失敗でそのケース1試行を丸ごと捨てない
        // （このファイルの「1本の 429/500 で 30本ぶんの課金を捨てない」と同じ方針）。
        // 判断がつかなかったので現状維持に倒す。
        tally.failed += 1;
        console.error(`[eval] verify failed for "${card.term}":`, err);
        return card;
      }
    });
    return verified.filter((c): c is ExtractedCard => c !== null);
  };
  return { verify, tally };
}

export async function runEval(
  options: { cases?: TermCase[]; config?: Partial<EvalConfig> } = {},
): Promise<EvalReport> {
  const config = resolveConfig(options.config);
  const cases = options.cases ?? loadCases();
  const startedAt = new Date().toISOString();

  const jobs = cases.flatMap((c) =>
    Array.from({ length: config.runs }, (_, run) => ({ case: c, run })),
  );
  // 「何も測らなかった」を「合格」にしないための最後の砦。
  // resolveConfig が runs>=1 を保証していても、ケースが空なら同じ穴が開く。
  if (jobs.length === 0) {
    throw new Error(
      `評価ジョブが0件です（ケース ${cases.length}件 × 試行 ${config.runs}回）。何も測れません`,
    );
  }

  // createExtractor は import しただけで `new OpenAI()` を評価する（extractor.ts）。
  // 静的 import にすると OPENAI_API_KEY 未設定のとき main() の try/catch より前、
  // モジュール評価の時点で生スタックが出るため、ここまで遅らせる。
  const { createExtractor } = await import("../extract/extractor.js");
  // 用語集はケースごとに違うので抽出器もケースごとに作る（本番と同じく system は不変）
  const extractors = new Map(cases.map((c) => [c.id, createExtractor(c.glossary)]));
  const verifier = config.withVerify ? await createVerifier(config.allowRename) : undefined;

  const jobErrors: JobError[] = [];
  const results = await mapLimit(jobs, config.concurrency, async (job) => {
    try {
      const extract = extractors.get(job.case.id)!;
      const extracted = await extract({
        newTranscript: job.case.transcript,
        // 同じ fixture で文脈あり/なしを比較するため、無効化は空文字で表現する（#22）
        contextTranscript: config.useContext ? job.case.context : "",
        shownTerms: job.case.shownTerms,
      });
      // 本番の清書は「今回のチャンク」を文脈に渡す。評価では transcript がそれに当たる
      const cards = (
        verifier
          ? await verifier.verify(extracted, job.case.transcript, job.case.glossary)
          : extracted
      ) as EvaluatedCard[];
      return scoreCase(job.case, cards, job.run);
    } catch (err) {
      // 1本の 429/500 で 30本ぶんの課金を捨てない。失敗は記録して集計は続ける。
      jobErrors.push({
        id: job.case.id,
        run: job.run,
        message: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  });
  const scores = results.filter((s): s is CaseScore => s !== undefined);
  // 並列実行なので push 順は非決定的。レポートの差分比較のために並べ直す。
  jobErrors.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);

  if (scores.length === 0) {
    throw new Error(
      `全 ${jobs.length} ジョブが失敗しました（最初のエラー: ${jobErrors[0]?.message ?? "不明"}）`,
    );
  }

  const perCase = cases.map((c) => {
    const own = scores.filter((s) => s.id === c.id);
    return { id: c.id, metrics: aggregate(own), runs: own.length };
  });
  const overall = toMetrics(sumTotals(scores));

  const failures: Failure[] = [];
  if (overall.recall < config.minRecall) {
    failures.push({ metric: "用語 Recall", actual: overall.recall, threshold: config.minRecall });
  }
  if (overall.miscorrection > config.maxMiscorrection) {
    failures.push({
      metric: "誤補正率",
      actual: overall.miscorrection,
      threshold: config.maxMiscorrection,
    });
  }
  if (overall.precision < config.minPrecision) {
    failures.push({
      metric: "カード Precision",
      actual: overall.precision,
      threshold: config.minPrecision,
    });
  }

  return {
    startedAt,
    // 実際に叩いたモデル。process.env.LLM_MODEL だと未設定時に "(既定)" としか残らず、
    // 後日 config.ts の既定を変えたときに別モデルの結果が同じラベルで並んでしまう。
    model: appConfig.llmModel,
    // 上限も**実効値**を残す(`model` と同じ理由)。`web検索 N回` の行は、
    // そのランの上限がいくつだったか分からなければ読めない
    maxWebSearches: appConfig.maxWebSearches,
    config,
    totalJobs: jobs.length,
    scores,
    perCase,
    overall,
    jobErrors,
    verifyTally: verifier?.tally,
    failures,
    // 失敗ジョブがあると測れなかったぶんが指標に出ない。不完全な結果は PASS にしない。
    pass: failures.length === 0 && jobErrors.length === 0,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** コンソール向けの表。等幅前提で桁を揃える。 */
function formatVerifyTally(report: EvalReport): string {
  const t = report.verifyTally;
  if (!t) return "なし";
  const mode = report.config.allowRename ? "改名あり(探索)" : "本番と同じ";
  // **棄却は必ず内訳つきで出す**(#25)。合計だけだと「実在しない」と「実在するが文脈に
  // 合わない」が混ざり、過剰 unresolved が諦めなのか正しい棄却なのかを読めない。
  const rejected = Object.values(t.rejected).reduce((a, b) => a + b, 0);
  // 0 の理由まで並べると読みづらいので、出たものだけ内訳に出す
  const breakdown = REJECTION_KINDS.filter((kind) => t.rejected[kind] > 0)
    .map((kind) => `${REJECTION_LABEL[kind]} ${t.rejected[kind]}`)
    .join(" / ");
  // 平均検索回数は上限値を決めるための数字。0件確認のときは割らない
  const perCard = t.checked > 0 ? (t.searches / t.checked).toFixed(1) : "-";
  // **そのランの上限も一緒に出す。** 上限がいくつだったか分からない平均は読めない
  const cap = report.maxWebSearches > 0 ? `上限${report.maxWebSearches}` : "上限なし";
  return (
    `${t.checked}件を確認 / 棄却 ${rejected}${breakdown === "" ? "" : `(${breakdown})`} / ` +
    `差し替え ${t.replaced} / 失敗 ${t.failed} / ` +
    `web検索 ${t.searches}回(1件あたり ${perCard} / ${cap})  適用: ${mode}`
  );
}

export function formatTable(report: EvalReport): string {
  // probable と unresolved は**2列に分ける**(#24)。合算すると「補正はしたが自信がない」と
  // 「そもそも特定できない」が混ざり、過剰 unresolved（何でも諦める退行）に気づけない。
  // 旧「unresolved」列は probable に当たる。名前ごと移してあるので、実装前後のレポートを
  // 同じ列名で比べたときに意味が入れ替わることはない。
  const headers = ["ケース", "Recall", "補正", "誤補正", "probable", "unresolved", "Precision"];
  const rows = report.perCase.map((p) => [
    p.id,
    pct(p.metrics.recall),
    pct(p.metrics.correction),
    pct(p.metrics.miscorrection),
    pct(p.metrics.probable),
    pct(p.metrics.unresolved),
    pct(p.metrics.precision),
  ]);
  rows.push([
    "全体",
    pct(report.overall.recall),
    pct(report.overall.correction),
    pct(report.overall.miscorrection),
    pct(report.overall.probable),
    pct(report.overall.unresolved),
    pct(report.overall.precision),
  ]);

  // 見出しもケース ID も日本語を含むので「表示幅」で揃える（全角は2幅として数える）
  const WIDE =
    /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
  const width = (s: string) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
  const cols = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]!))));
  const line = (cells: string[]) =>
    cells.map((c, i) => c + " ".repeat(cols[i]! - width(c))).join("  ").trimEnd();

  const out = [
    `モデル: ${report.model}  試行: ${report.config.runs}回/ケース  ` +
      `文脈: ${report.config.useContext ? "あり" : "なし"}  ` +
      `開始: ${report.startedAt}`,
    `ジョブ: ${report.scores.length}/${report.totalJobs} 成功` +
      (report.jobErrors.length > 0
        ? `  ⚠ ${report.jobErrors.length}件が失敗しています（下の数字は成功したぶんだけの集計です）`
        : ""),
    // 内訳を出さないと、下の指標が「検証が効いた結果」なのか「単に棄却しただけ」なのか
    // 読めない。既定では棄却も差し替えも指標に反映されない（本番と同じ）ので、
    // Stage 2 が何をしたかはこの行だけが伝える。
    `検証: ${formatVerifyTally(report)}`,
    "",
    line(headers),
    cols.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
    "",
  ];

  const problems = report.scores.filter(
    (s) => s.missing.length > 0 || s.miscorrections.length > 0 || s.extra.length > 0,
  );
  if (problems.length > 0) {
    out.push("内訳:");
    for (const s of problems) {
      const parts: string[] = [];
      if (s.missing.length > 0) parts.push(`未検出=[${s.missing.join(", ")}]`);
      if (s.miscorrections.length > 0) parts.push(`誤補正=[${s.miscorrections.join(", ")}]`);
      if (s.extra.length > 0) parts.push(`想定外=[${s.extra.join(", ")}]`);
      out.push(`  ${s.id} #${s.run}: ${parts.join(" ")}`);
    }
    out.push("");
  }

  if (report.jobErrors.length > 0) {
    out.push(`実行に失敗したジョブ（${report.jobErrors.length}/${report.totalJobs}）:`);
    for (const e of report.jobErrors) out.push(`  ${e.id} #${e.run}: ${e.message}`);
    out.push("");
  }

  if (report.pass) {
    out.push("判定: PASS（すべての閾値を満たしています）");
  } else {
    out.push("判定: FAIL");
    for (const f of report.failures) {
      out.push(`  ${f.metric}: ${pct(f.actual)}（閾値 ${pct(f.threshold)}）`);
    }
    if (report.jobErrors.length > 0) {
      out.push(
        `  ジョブ失敗: ${report.jobErrors.length}件（結果が不完全なため閾値を満たしていても PASS にしない）`,
      );
    }
  }
  return out.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const outIndex = argv.indexOf("--out");
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !outPath) throw new Error("--out にはファイルパスを指定してください");

  // 環境変数の検証はキーの有無より先に。EVAL_RUNS=0 のような設定ミスは
  // キーが無い環境でも同じメッセージで気づけるべきなので、順序を固定しておく。
  resolveConfig();

  // 最頻の失敗はキー未設定。config.js の import で .env は読み込み済みなので、
  // ここで見れば SDK の生スタックより先に読める1行で落とせる。
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY が設定されていません（.env か環境変数に設定してください）");
  }

  const report = await runEval();
  const json = JSON.stringify(report, null, 2);

  // 表は stderr、JSON は stdout。`npm run eval:llm > report.json` がそのまま使える。
  console.error(formatTable(report));
  if (outPath) {
    writeFileSync(outPath, `${json}\n`);
    console.error(`\nJSON レポート: ${outPath}`);
  } else {
    console.log(json);
  }

  if (!report.pass) process.exitCode = 1;
}

// 直接起動されたときだけ実行する（テストから import しても走らせない）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    // API キー未設定・課金エラーなどは生スタックより読める1行で落とす
    console.error(`評価の実行に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
