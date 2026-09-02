import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * LLM 評価ケース。
 *
 * トランスクリプトは **すべて合成** で、実会議の録音・文字起こしからの抜粋は使わない
 * （`src/stt/mock-script.ts` と同じ方針）。実会議の情報が混ざる経路を原理的に断つため。
 */
export const TermCaseSchema = z.object({
  /** 失敗レポートで識別するための短い ID */
  id: z.string().min(1),
  /** 抽出器に渡す「新しい文字起こし」 */
  transcript: z.string().min(1),
  /**
   * 抽出器に渡す「直前の会話」（#22）。語義の判断材料であって、カード化の対象ではない。
   * `EVAL_NO_CONTEXT=1` で空にして流せば、同じケースで文脈あり/なしを比較できる。
   */
  context: z.string().default(""),
  /** 会議の用語集（Deepgram のブーストと LLM の system プロンプトに入る想定） */
  glossary: z.array(z.string()).default([]),
  /** 既に表示済みとして抽出器に渡す用語。デデュープ（規則2）の検証に使う */
  shownTerms: z.array(z.string()).default([]),
  /** 出てほしい用語（Recall の分母） */
  expectTerms: z.array(z.string()).default([]),
  /** 誤認識表記 → 正しい表記。正しい補正率の分母 */
  expectCorrection: z.record(z.string(), z.string()).default({}),
  /**
   * 出てはいけない用語。1つでも出たら誤補正扱い。
   *
   * **`status: "unresolved"` のカードは対象外**（#24）。降格したカードは term を画面に
   * 出さない（見出しは聞き取られた表記になる）ので、利用者から見て「その用語に補正した」
   * とは言えない。ここを見ないと、Stage 2 が正しく棄却しても誤補正として数え続け、
   * この機能の効果が指標に一切現れない。
   */
  forbidTerms: z.array(z.string()).default([]),
  /**
   * 「特定できない」が正解の表記（#24）。**音声認識が聞き取った表記**を並べる。
   *
   * その表記を `correctedFrom` か `surfaceForms` に持つカードが `status: "unresolved"`
   * で出れば正解。`expectTerms` は「出てほしい用語」の集合なので、特定できないのが
   * 正解のケースは分母にも分子にも入らず、**unresolved 率をまったく動かせなかった**。
   */
  expectUnresolved: z.array(z.string()).default([]),
  /**
   * 再評価で直ってほしい改名（#40）。`from` は**音声認識が聞き取った表記**、
   * `to` は最終的に確定してほしい用語。
   *
   * **`expectCorrection` とは別物。** あちらは「抽出段が1回で正しく補正できたか」で、
   * こちらは「1度 unresolved にしたものを、後続の文脈で正しく直せたか」。同じ欄に
   * まとめると、**再評価による誤補正が抽出段の誤補正に埋もれて見えなくなる**
   * （unresolved 率だけを下げて誤補正が増えても気づけない）。
   *
   * `from` と `to` の**両方**が一致して初めて正解に数える。`to` だけを見ると、
   * 別の未解決語がたまたま期待した用語に着地した場合まで加点される。
   */
  expectRematch: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .default([]),
  /**
   * 出ても減点しない用語（表記ゆれ・関連語）。Precision の分子に算入する。
   *
   * **名前は `confidence` 時代のままだが、判定に status は使っていない**（#24）。
   * ここは「この用語のカードが出ても想定内」という**用語の集合**で、状態とは無関係に
   * Precision の分子へ入れる。`unresolved` のカードも term はそのまま残る（改名しない）
   * ので、unresolved を期待するケースでは**聞き取られた表記そのもの**をここに置く。
   * 改名すると過去レポートとの比較がしづらくなるため、キー名は据え置いてある。
   */
  allowLowConfidence: z.array(z.string()).default([]),
  /**
   * 用語 → 期待する表示優先度(#44)。**high/medium を期待した語が low になったら取りこぼし**。
   *
   * **`low` を期待した語は取りこぼしの分母に入れない。** 測りたいのは「重要な語を
   * 折りたたみへ落としていないか」であって、low の判定精度そのものではない。
   * low を分母に入れると、平易な語を medium に置いただけで数字が悪化し、
   * **「全部 low にする」ほうがスコアの良い実装になってしまう**。
   *
   * カードが出なかった語は分母にも入らない（それは Recall の問題）。
   */
  expectImportance: z
    .record(z.string(), z.enum(["high", "medium", "low"]))
    .default({}),
});

export type TermCase = z.infer<typeof TermCaseSchema>;

export const TermCasesSchema = z.array(TermCaseSchema).min(1);

/**
 * 既定のケースファイル。`src/eval/` から見た相対パスとして解決する。
 *
 * 評価ハーネスは tsx で **ソースのまま** 実行する（`npm run eval:llm`）。
 * `tsconfig.json` が `src/eval` を exclude しているため `dist/eval/` は生成されない
 * ＝ 本番イメージにも入らないので、ビルド後のパスを気にする必要はない。
 */
export const DEFAULT_CASES_PATH = fileURLToPath(
  new URL("../../tests/fixtures/term-cases.json", import.meta.url),
);

export function parseCases(json: unknown): TermCase[] {
  const result = TermCasesSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`評価ケースの検証に失敗しました:\n${z.prettifyError(result.error)}`);
  }
  const ids = new Set<string>();
  for (const c of result.data) {
    if (ids.has(c.id)) throw new Error(`評価ケースの id が重複しています: ${c.id}`);
    ids.add(c.id);
  }
  return result.data;
}

export function loadCases(path: string = DEFAULT_CASES_PATH): TermCase[] {
  return parseCases(JSON.parse(readFileSync(path, "utf8")));
}
