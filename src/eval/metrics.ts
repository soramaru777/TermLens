import { normalizeTerm } from "../extract/normalize.js";
import type { TermImportance, TermStatus } from "../protocol.js";
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
  /** 表示優先度(#44)。分布と「重要語の取りこぼし」を測る */
  importance: TermImportance;
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
  // --- unresolved カードの再評価(#40) ---------------------------------------
  //
  // **unresolved 率だけを下げることを成功条件にしない。** 誤って何でも確定すれば
  // unresolved 率は下がるので、昇格の数と**そのうち間違っていた数**を必ず対にして数える。
  /** 再評価を試みた回数（web 検証まで回したもの） */
  rematchAttempts: number;
  /** 再評価で昇格（改名）した数 */
  rematchPromoted: number;
  /** 昇格のうち `expectRematch` と一致した数 */
  rematchCorrect: number;
  /** 昇格したが期待と違った数。**これが増えるなら閾値を締める** */
  rematchMiscorrected: number;
  /** 再評価の内訳（レポート用）。`聞き取られた表記 → 確定した用語` の並び */
  rematches: string[];
  // --- 表示優先度(#44) -------------------------------------------------------
  //
  // **low の件数だけを成功条件にしない。** 全部 low にすれば「通常表示のノイズ」は
  // ゼロになるので、件数と**取りこぼし件数を必ず対で**出す(#40 の
  // 「unresolved 率だけを下げない」と同じ理屈)。
  /** dedupe 後のカードの high / medium / low 枚数 */
  importanceCounts: { high: number; medium: number; low: number };
  /** 通常表示される枚数（high + medium）。折りたたまれない枚数 */
  shownCards: number;
  /** `expectImportance` で high/medium を期待した用語のうち、low になったもの＝重要語の取りこぼし */
  importanceDemoted: number;
  /** 取りこぼしの分母（high/medium を期待した用語のうち、カードが出たもの） */
  importanceDemotedTotal: number;
  /** 取りこぼしの内訳（レポート用） */
  importanceDemotions: string[];
  /** status × importance のクロス集計。`unresolved × high` を埋もれさせないため */
  unresolvedByImportance: { high: number; medium: number; low: number };
}

/**
 * 1ケース・1試行で再評価が実際に何をしたか。`scoreCase()` の入力。
 *
 * **カード集合からは復元できない。** 昇格したカードは普通の confirmed カードとして
 * 出てくるので、「もともと unresolved だったが再評価で直った」ことは、再評価を回した
 * 側が記録しておくしかない。
 */
export interface RematchOutcome {
  attempts: number;
  /** 実際に起きた改名。`from` は unresolved のときに聞き取られていた表記 */
  renames: Array<{ from: string; to: string }>;
}

const NO_REMATCH: RematchOutcome = { attempts: 0, renames: [] };

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
  /** 再評価の昇格成功率（昇格 ÷ 試行）(#40) */
  rematchPromotion: number;
  /**
   * **再評価による誤補正率**（期待と違った昇格 ÷ 昇格）(#40)。
   *
   * 全体の `miscorrection` とは**別に持つ**。合算すると、再評価が悪さをしていても
   * 抽出段の誤補正に埋もれて見えない。unresolved 率と必ずセットで読むこと。
   */
  rematchMiscorrection: number;
  /** 通常表示される割合（high + medium ÷ 全カード）(#44) */
  shownRate: number;
  /**
   * **重要語の取りこぼし率**（high/medium を期待したのに low になった割合）(#44)。
   *
   * `shownRate` とは**必ずセットで読むこと**。カードを全部 low にすれば `shownRate` は
   * 0 に近づくが、それは折りたたみが効いているのではなく重要語ごと隠しているだけ。
   */
  importanceDemotion: number;
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
  rematchAttempts: number;
  rematchPromoted: number;
  rematchCorrect: number;
  rematchMiscorrected: number;
  /** 全カード枚数（dedupe 後）。`importanceCounts` の合計と一致する(#44) */
  cards: number;
  shownCards: number;
  importanceDemoted: number;
  importanceDemotedTotal: number;
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
export function scoreCase(
  c: TermCase,
  cards: EvaluatedCard[],
  run = 0,
  rematch: RematchOutcome = NO_REMATCH,
): CaseScore {
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

  // --- 再評価による正しい補正 / 誤補正(#40) ---------------------------------
  // **`from` と `to` の両方が一致して初めて正解。** `to` だけを見ると、別の未解決語が
  // たまたま期待した用語に着地した場合も加点され、誤補正率が過小に出る
  // （`expectCorrection` の採点が correctedFrom と term の両方を見るのと同じ理由）。
  let rematchCorrect = 0;
  for (const rename of rematch.renames) {
    const fromKey = normalizeTerm(rename.from);
    const toKey = normalizeTerm(rename.to);
    const expected = c.expectRematch.some(
      (e) => normalizeTerm(e.from) === fromKey && normalizeTerm(e.to) === toKey,
    );
    if (expected) rematchCorrect += 1;
  }

  // --- 表示優先度の分布と取りこぼし(#44) -------------------------------------
  // **分母は dedupe 後のカード**（`byTerm`）。Precision と同じ土俵に揃えておかないと、
  // 同じ用語が2枚出た回だけ分布が歪む。
  const importanceCounts = { high: 0, medium: 0, low: 0 };
  const unresolvedByImportance = { high: 0, medium: 0, low: 0 };
  for (const card of byTerm.values()) {
    importanceCounts[card.importance] += 1;
    // status と importance は別軸(#44)。`unresolved × high`（本当に重要そうだが
    // まだ特定できていない）を埋もれさせないため、クロスで数える
    if (card.status === "unresolved") unresolvedByImportance[card.importance] += 1;
  }

  // **「low が何件出たか」ではなく「本来 high/medium のものが low に落ちたか」を測る。**
  // 前者だけを見ると、全部 low にした実装が最良のスコアになってしまう。
  let importanceDemoted = 0;
  let importanceDemotedTotal = 0;
  const importanceDemotions: string[] = [];
  for (const [term, expected] of Object.entries(c.expectImportance)) {
    if (expected === "low") continue; // low を期待した語は取りこぼしの対象外
    const card = byTerm.get(normalizeTerm(term));
    if (!card) continue; // カードが出なかったのは Recall の問題。ここでは数えない
    importanceDemotedTotal += 1;
    if (card.importance === "low") {
      importanceDemoted += 1;
      importanceDemotions.push(`${term}: 期待 ${expected} → low`);
    }
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
    rematchAttempts: rematch.attempts,
    rematchPromoted: rematch.renames.length,
    rematchCorrect,
    rematchMiscorrected: rematch.renames.length - rematchCorrect,
    rematches: rematch.renames.map((r) => `${r.from} → ${r.to}`),
    importanceCounts,
    shownCards: importanceCounts.high + importanceCounts.medium,
    importanceDemoted,
    importanceDemotedTotal,
    importanceDemotions,
    unresolvedByImportance,
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
    rematchAttempts: 0,
    rematchPromoted: 0,
    rematchCorrect: 0,
    rematchMiscorrected: 0,
    cards: 0,
    shownCards: 0,
    importanceDemoted: 0,
    importanceDemotedTotal: 0,
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
    totals.rematchAttempts += s.rematchAttempts;
    totals.rematchPromoted += s.rematchPromoted;
    totals.rematchCorrect += s.rematchCorrect;
    totals.rematchMiscorrected += s.rematchMiscorrected;
    totals.cards += s.importanceCounts.high + s.importanceCounts.medium + s.importanceCounts.low;
    totals.shownCards += s.shownCards;
    totals.importanceDemoted += s.importanceDemoted;
    totals.importanceDemotedTotal += s.importanceDemotedTotal;
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
    // 分母 0（再評価が一度も走らなかった）は 0。ratio() の「分母 0 は減点しない＝1」を
    // 使うと、**再評価が一度も発火していないランが「昇格率 100%」に見える**
    rematchPromotion:
      totals.rematchAttempts === 0 ? 0 : totals.rematchPromoted / totals.rematchAttempts,
    // 誤補正率は `miscorrection` と同じく「無ければ 0（良い）」の向き
    rematchMiscorrection:
      totals.rematchPromoted === 0 ? 0 : totals.rematchMiscorrected / totals.rematchPromoted,
    // カードが1枚も出なかった回は 1（= 隠していない）。`ratio()` と同じ「分母 0 は減点しない」
    shownRate: ratio(totals.shownCards, totals.cards),
    // 取りこぼし率は `miscorrection` と同じく「無ければ 0（良い）」の向き
    importanceDemotion:
      totals.importanceDemotedTotal === 0
        ? 0
        : totals.importanceDemoted / totals.importanceDemotedTotal,
  };
}

export function aggregate(scores: CaseScore[]): Metrics {
  return toMetrics(sumTotals(scores));
}
