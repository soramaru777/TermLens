/**
 * 検証で候補を棄却した理由(#25)。**依存ゼロで保つこと。**
 *
 * `enrich.ts` に置くと、見出しを読みたいだけの評価ハーネスまで
 * モジュール読み込み時の `new OpenAI()` を引き込む(`normalize.ts` を切り出したのと同じ理由)。
 * 本番ログと評価レポートで**同じ言葉**を使うためのモジュールなので、
 * 片方だけを直して食い違わせないこと。
 */

/**
 * 棄却の理由。**`verification` から導けない理由があるので別に持つ。**
 *
 * `out-of-candidates`(候補に無い用語が返された)は `parseVerifyOutput()` 側の判断なので、
 * モデルは `exists: true, fitsContext: true` と言ったままになる。`verification` だけを
 * 見て内訳を数えると**これが「文脈に合わなかった」に化け**、ログには
 * 「実在: あり / 文脈整合: あり なのに棄却」という自己矛盾した行が出る。
 * 内訳は「過剰 unresolved が諦めか正しい棄却か」を人が読むためのものなので、
 * 静かに汚れると指標そのものが判断材料にならなくなる。
 */
export type RejectionKind =
  /** そんな用語は実在しないとモデルが報告した */
  | "not-exist"
  /** 実在するが、この会議の文脈に合わない */
  | "off-context"
  /** 候補に無い用語が返されたので採らなかった(モデルの検証結果とは独立の判断) */
  | "out-of-candidates"
  /** 実在も文脈も否定していないのにモデル自身が選ばなかった */
  | "unspecified";

/** すべての理由。内訳の初期化と、表示順の正典を兼ねる。 */
export const REJECTION_KINDS = [
  "not-exist",
  "off-context",
  "out-of-candidates",
  "unspecified",
] as const satisfies readonly RejectionKind[];

/** 内訳の見出し。ログと評価レポートで同じ言葉を使う。 */
export const REJECTION_LABEL: Record<RejectionKind, string> = {
  "not-exist": "実在せず",
  "off-context": "文脈に合わず",
  "out-of-candidates": "候補外",
  unspecified: "理由なし",
};
