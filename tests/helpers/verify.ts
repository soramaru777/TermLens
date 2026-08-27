import type { Verification } from "../../src/extract/enrich.js";

/**
 * 検証段（`responses.create`）の応答を組み立てるファクトリ。
 *
 * **1箇所にまとめてあるのは体裁の問題ではない。** 同じ形の JSON が3ファイルに散っていて、
 * #25 で `verification` を1つ足したときに既存2箇所を両方直す必要があった。しかも
 * `JSON.stringify` を通るので**型検査が効かない** — 直し漏れると「モックだけ古いスキーマを
 * 返し続け、テストは緑のまま実装とズレる」という一番気づきにくい形で出る
 * （`cards.ts` の `card()` を集約したのと同じ理由）。
 */

/** 裏付けが取れた検証結果。既定はこれで、棄却を見たいテストだけ上書きする。 */
export const VERIFIED: Verification = {
  exists: true,
  fitsContext: true,
  evidence: "公式ドキュメント",
};

export function verifyOutput(value: {
  chosen: string | null;
  reason?: string;
  description?: string;
  verification?: Verification;
}): string {
  return JSON.stringify({
    verification: VERIFIED,
    reason: "テスト",
    description: "テスト用の解説。",
    ...value,
  });
}
