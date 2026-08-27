import { normalizeTerm } from "../extract/normalize.js";
import type { TermStatus } from "../protocol.js";
import type { TermCase } from "./cases.js";

/**
 * 評価に必要なカードの部分集合。`createExtractor` の戻り値（schema.ts の TermCard）も
 * protocol.ts の TermCard も構造的にこれを満たす。
 */
export interface EvaluatedCard {
  term: string;
  status: TermStatus;
  correctedFrom: string | null;
  /** 「特定できない」が正解の表記との突き合わせに使う(#24) */
  surfaceForms: string[];
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
  /**
   * expectTerms のうち、カードは出たが status が probable だったもの。
   *
   * **#24 以前の `unresolved` はこの量を指していた。** `status` の導入で
   * 同名のフィールドが別の意味になるため、旧指標は名前ごとこちらへ移してある
   * （同名で意味を変えると実装前後のレポート比較が静かに壊れる）。
   */
  probable: number;
  /** expectTerms のうち、カードは出たが status が unresolved だったもの(#24 で新設) */
  unresolved: number;
  /** expectUnresolved のうち、狙いどおり unresolved のカードが出たもの(#24) */
  unresolvedHit: number;
  unresolvedTotal: number;
  /** 「特定できない」が正解だったのにそうならなかった内訳（レポート用） */
  unresolvedMiss: string[];
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
  /** probable 率(旧 unresolved 率。#24 で改名) */
  probable: number;
  /** unresolved 率(#24 で新設。「特定できなかった」と明示した割合) */
  unresolved: number;
  /** 「特定できない」が正解のケースで、狙いどおり unresolved にできた割合(#24) */
  unresolvedRecall: number;
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
  probable: number;
  unresolved: number;
  unresolvedHit: number;
  unresolvedTotal: number;
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

  // --- 用語 Recall / probable 率 / unresolved 率 ---
  let recallHit = 0;
  let probable = 0;
  let unresolved = 0;
  const missing: string[] = [];
  for (const expected of c.expectTerms) {
    const card = byTerm.get(normalizeTerm(expected));
    if (!card) {
      missing.push(expected);
      continue;
    }
    recallHit += 1;
    // 2つを分けて数える。「補正したが自信がない(probable)」と「そもそも特定できない
    // (unresolved)」は利用者から見て別の失敗で、足し合わせると過剰 unresolved に気づけない
    if (card.status === "probable") probable += 1;
    else if (card.status === "unresolved") unresolved += 1;
  }

  // --- 正しい補正率 / 誤補正（②誤表記に対する term の取り違え） ---
  let correctionHit = 0;
  const miscorrections: string[] = [];
  // **unresolved のカードは補正の判定から外す**(#24)。降格したカードは term を画面に
  // 出さない（見出しは聞き取られた表記）ので、利用者から見て「その用語に補正した」とは
  // 言えない。ここを見ないと Stage 2 が正しく棄却しても誤補正として数え続け、
  // この機能の効果が指標に一切現れない。
  const corrected = cards.filter((card) => card.status !== "unresolved");
  for (const [wrong, right] of Object.entries(c.expectCorrection)) {
    const wrongKey = normalizeTerm(wrong);
    const matched = corrected.filter((card) => normalizeTerm(card.correctedFrom ?? "") === wrongKey);
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
  for (const card of corrected) {
    if (forbidden.has(normalizeTerm(card.term))) miscorrections.push(`禁止語が出た: ${card.term}`);
  }

  // --- 「特定できない」が正解だった表記(#24) ---
  // 聞き取られた表記を correctedFrom / surfaceForms に持つカードが unresolved で出たか。
  // expectTerms 経由では測れない（特定できないのが正解なので分母に入らない）。
  let unresolvedHit = 0;
  const unresolvedMiss: string[] = [];
  for (const surface of c.expectUnresolved) {
    const key = normalizeTerm(surface);
    const card = cards.find(
      (x) =>
        normalizeTerm(x.correctedFrom ?? "") === key ||
        x.surfaceForms.some((f) => normalizeTerm(f) === key),
    );
    if (card?.status === "unresolved") unresolvedHit += 1;
    else unresolvedMiss.push(`${surface} → ${card ? `${card.term}(${card.status})` : "カードなし"}`);
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
    probable,
    unresolved,
    unresolvedHit,
    unresolvedTotal: c.expectUnresolved.length,
    unresolvedMiss,
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
    probable: 0,
    unresolved: 0,
    unresolvedHit: 0,
    unresolvedTotal: 0,
    precisionHit: 0,
    precisionTotal: 0,
  };
  for (const s of scores) {
    totals.recallHit += s.recallHit;
    totals.recallTotal += s.recallTotal;
    totals.correctionHit += s.correctionHit;
    totals.correctionTotal += s.correctionTotal;
    totals.probable += s.probable;
    totals.unresolved += s.unresolved;
    totals.unresolvedHit += s.unresolvedHit;
    totals.unresolvedTotal += s.unresolvedTotal;
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
    // 分母はどちらも expectTerms の総数。同じ土俵で並べないと2列を足し引きして読めない
    probable: totals.recallTotal === 0 ? 0 : totals.probable / totals.recallTotal,
    unresolved: totals.recallTotal === 0 ? 0 : totals.unresolved / totals.recallTotal,
    // 分母 0（期待が無い）は減点しない。ratio() と同じ扱い
    unresolvedRecall: ratio(totals.unresolvedHit, totals.unresolvedTotal),
    precision: ratio(totals.precisionHit, totals.precisionTotal),
  };
}

export function aggregate(scores: CaseScore[]): Metrics {
  return toMetrics(sumTotals(scores));
}
