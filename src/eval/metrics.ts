import { normalizeTerm } from "../extract/normalize.js";
import type { TermCase } from "./cases.js";

/**
 * 評価に必要なカードの部分集合。`createExtractor` の戻り値（schema.ts の TermCard）も
 * protocol.ts の TermCard も構造的にこれを満たす。
 */
export interface EvaluatedCard {
  term: string;
  confidence: "high" | "low";
  correctedFrom: string | null;
}

/** 1ケース・1試行ぶんの素点。集計は分子分母を足し合わせて行う（ケース平均の平均にしない）。 */
export interface CaseScore {
  id: string;
  /** 何回目の試行か（0 始まり） */
  run: number;
  /** 出力カードの term 一覧（レポート用） */
  terms: string[];
  /** expectTerms のうちカードが出たもの */
  recallHit: number;
  recallTotal: number;
  /** expectCorrection のうち correctedFrom と term の両方が期待どおりだったもの */
  correctionHit: number;
  correctionTotal: number;
  /** 誤補正が1件でもあったか（ケース単位の 0/1） */
  miscorrected: boolean;
  /** 誤補正の内訳（レポート用） */
  miscorrections: string[];
  /** expectTerms のうち、カードは出たが confidence が low だったもの */
  unresolved: number;
  /** 出力カード（正規化キーで dedupe 済み）のうち expectTerms ∪ allowLowConfidence に含まれるもの */
  precisionHit: number;
  /** dedupe 後の出力カード数。同じ用語が2枚出ても1件として数える */
  precisionTotal: number;
  /** 出るべきだったのに出なかった用語（レポート用） */
  missing: string[];
  /** 期待にも許容にも入っていないカード（レポート用。dedupe 後） */
  extra: string[];
}

export interface Metrics {
  /** 用語 Recall */
  recall: number;
  /** 正しい補正率 */
  correction: number;
  /** 誤補正率 */
  miscorrection: number;
  /** unresolved 率 */
  unresolved: number;
  /** カード Precision */
  precision: number;
}

export interface Totals {
  recallHit: number;
  recallTotal: number;
  correctionHit: number;
  correctionTotal: number;
  miscorrectedCases: number;
  caseRuns: number;
  unresolved: number;
  precisionHit: number;
  precisionTotal: number;
}

/**
 * 分母 0 のときは 1（= 減点しない）を返す。「期待が無い」ことは失敗ではない。
 *
 * 注意: precision の分母 0 は「カードを1枚も出さなかった」であって満点ではない。
 * ここが 1.0 と出ていても「精度が完璧」ではなく「測るものが無かった」と読むこと
 * （何枚出たかは CaseScore.precisionTotal / terms を見る）。
 */
function ratio(hit: number, total: number): number {
  return total === 0 ? 1 : hit / total;
}

/**
 * 1ケース・1試行を採点する。
 * 用語の突き合わせは必ず `normalizeTerm()` を通す。本番のデデュープと同じ土俵に揃え、
 * 「全角/半角・大文字小文字・空白だけ違う」ものを取りこぼさないため。
 */
export function scoreCase(c: TermCase, cards: EvaluatedCard[], run = 0): CaseScore {
  const byTerm = new Map<string, EvaluatedCard>();
  for (const card of cards) {
    const key = normalizeTerm(card.term);
    if (!byTerm.has(key)) byTerm.set(key, card);
  }

  // --- 用語 Recall / unresolved 率 ---
  let recallHit = 0;
  let unresolved = 0;
  const missing: string[] = [];
  for (const expected of c.expectTerms) {
    const card = byTerm.get(normalizeTerm(expected));
    if (!card) {
      missing.push(expected);
      continue;
    }
    recallHit += 1;
    if (card.confidence === "low") unresolved += 1;
  }

  // --- 正しい補正率 / 誤補正（②誤表記に対する term の取り違え） ---
  let correctionHit = 0;
  const miscorrections: string[] = [];
  for (const [wrong, right] of Object.entries(c.expectCorrection)) {
    const wrongKey = normalizeTerm(wrong);
    const matched = cards.filter((card) => normalizeTerm(card.correctedFrom ?? "") === wrongKey);
    const correct = matched.find((card) => normalizeTerm(card.term) === normalizeTerm(right));
    if (correct) {
      correctionHit += 1;
    } else if (matched.length > 0) {
      // 誤表記からの復元を試みたが、別の用語に着地した
      miscorrections.push(`${wrong} → ${matched.map((m) => m.term).join(" / ")}（期待: ${right}）`);
    }
  }

  // --- 誤補正（①出てはいけない用語） ---
  const forbidden = new Set(c.forbidTerms.map(normalizeTerm));
  for (const card of cards) {
    if (forbidden.has(normalizeTerm(card.term))) miscorrections.push(`禁止語が出た: ${card.term}`);
  }

  // --- カード Precision ---
  // Recall 側（byTerm）と同じく正規化キーで dedupe してから数える。同じ用語のカードが
  // 2枚出たときに分子・分母が両方 +2 されると、重複が精度に影響しない（= 見逃される）。
  const allowed = new Set([...c.expectTerms, ...c.allowLowConfidence].map(normalizeTerm));
  const extra: string[] = [];
  let precisionHit = 0;
  for (const card of byTerm.values()) {
    if (allowed.has(normalizeTerm(card.term))) precisionHit += 1;
    else extra.push(card.term);
  }

  return {
    id: c.id,
    run,
    terms: cards.map((card) => card.term),
    recallHit,
    recallTotal: c.expectTerms.length,
    correctionHit,
    correctionTotal: Object.keys(c.expectCorrection).length,
    miscorrected: miscorrections.length > 0,
    miscorrections,
    unresolved,
    precisionHit,
    precisionTotal: byTerm.size,
    missing,
    extra,
  };
}

export function sumTotals(scores: CaseScore[]): Totals {
  const totals: Totals = {
    recallHit: 0,
    recallTotal: 0,
    correctionHit: 0,
    correctionTotal: 0,
    miscorrectedCases: 0,
    caseRuns: scores.length,
    unresolved: 0,
    precisionHit: 0,
    precisionTotal: 0,
  };
  for (const s of scores) {
    totals.recallHit += s.recallHit;
    totals.recallTotal += s.recallTotal;
    totals.correctionHit += s.correctionHit;
    totals.correctionTotal += s.correctionTotal;
    totals.unresolved += s.unresolved;
    totals.precisionHit += s.precisionHit;
    totals.precisionTotal += s.precisionTotal;
    if (s.miscorrected) totals.miscorrectedCases += 1;
  }
  return totals;
}

export function toMetrics(totals: Totals): Metrics {
  return {
    recall: ratio(totals.recallHit, totals.recallTotal),
    correction: ratio(totals.correctionHit, totals.correctionTotal),
    // 誤補正率だけは「無ければ 0（良い）」。ratio() の 0除算=1 とは向きが逆なので個別に書く。
    miscorrection: totals.caseRuns === 0 ? 0 : totals.miscorrectedCases / totals.caseRuns,
    unresolved: totals.recallTotal === 0 ? 0 : totals.unresolved / totals.recallTotal,
    precision: ratio(totals.precisionHit, totals.precisionTotal),
  };
}

export function aggregate(scores: CaseScore[]): Metrics {
  return toMetrics(sumTotals(scores));
}
