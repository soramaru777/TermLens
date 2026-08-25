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
  /** 会議の用語集（Deepgram のブーストと LLM の system プロンプトに入る想定） */
  glossary: z.array(z.string()).default([]),
  /** 既に表示済みとして抽出器に渡す用語。デデュープ（規則2）の検証に使う */
  shownTerms: z.array(z.string()).default([]),
  /** 出てほしい用語（Recall の分母） */
  expectTerms: z.array(z.string()).default([]),
  /** 誤認識表記 → 正しい表記。正しい補正率の分母 */
  expectCorrection: z.record(z.string(), z.string()).default({}),
  /** 出てはいけない用語。1つでも出たら誤補正扱い */
  forbidTerms: z.array(z.string()).default([]),
  /** 出ても減点しない用語（表記ゆれ・関連語）。Precision の分子に算入する */
  allowLowConfidence: z.array(z.string()).default([]),
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
