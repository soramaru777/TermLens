import { z } from "zod";

/**
 * 1カードあたりの候補数の上限(#23)。
 *
 * 目的は**検証段(`enrich.ts`)へ渡す入力を小さく保つこと**。プロンプトでも指示するが、
 * `normalizeCandidates()` がサーバー側でも切る(`filterSurfaceForms()` と同じ方針)。
 *
 * なお `max_completion_tokens`(3000) の超過はこの上限では防げない。切り詰めは
 * **パース成功後**に走るのに対し、超過時は SDK が `LengthFinishReasonError` を投げるので
 * `normalizeCandidates()` まで到達しない。その扱いは `scheduler.ts` 側にある。
 */
export const MAX_CANDIDATES = 3;

export const CandidateSchema = z.object({
  term: z.string().describe("候補となる正規化後の用語名"),
  reading: z.string().describe("候補のカタカナ読み"),
  rationale: z
    .string()
    .describe("この候補を挙げた根拠。音韻の近さ・文脈・用語集のどれに基づくかを一言で"),
});

export type Candidate = z.infer<typeof CandidateSchema>;

export const TermCardSchema = z.object({
  // **`term` より前に置く。** 構造化出力はスキーマの順に生成されるので、term を
  // 書き終えてから status を決めさせると、規則1の「自信がなければ term を無理に
  // 確定しない」が原理的に守りにくい。先に状態を決めさせてから表記を書かせる。
  // #24 で `confidence: "high" | "low"` を置き換えた(`low` → `probable` が 1:1 対応)。
  // 併存させると同じ事実を2フィールドで持つことになり、矛盾した組が返ったときの正解が
  // 決まらない。**enum の値そのものが仕様の説明**になるよう describe に3値の使い分けを書く。
  status: z
    .enum(["confirmed", "probable", "unresolved"])
    .describe(
      "用語の判定状態。confirmed=補正していない、または確信のある補正。probable=補正したが確信がない。unresolved=音声認識の表記から正しい用語を特定できない(この場合 term を無理に確定せず、description も書かない)",
    ),
  term: z.string().describe("正規化した用語名。誤認識で崩れたカタカナは正しい表記に直す(例: クバネテス → Kubernetes)"),
  reading: z.string().describe("用語のカタカナ読み"),
  description: z.string().describe("日本語の解説。約100文字、最大120文字"),
  rarity: z
    .enum(["common", "uncommon", "rare"])
    .describe(
      "用語のレア度。common=よく知られた一般的な用語、uncommon=その業界の人なら知っている用語、rare=ニッチ・新しい・固有名詞・誤認識から復元した用語など、最新情報の確認価値が高いもの",
    ),
  correctedFrom: z.string().nullable().describe("誤認識から復元した場合の元の表記。復元していなければ null"),
  surfaceForms: z
    .array(z.string())
    .describe(
      "この用語が「新しい文字起こし」の中に実際に登場した表記を、原文のままの文字列で列挙(例: term が Pod なら「ポッド」、Kubernetes なら「クバネテス」)",
    ),
  // 検証段(enrich.ts)への内部入力。**protocol.ts の TermCard には載せない** —
  // クライアントは候補を使わないので、WS ペイロードと localStorage を太らせるだけになる
  // (#19 で words を送らなかったのと同じ理由)。
  candidates: z
    .array(CandidateSchema)
    .describe(
      `この用語の候補を確からしい順に最大${MAX_CANDIDATES}件。先頭は term と一致させること。補正していない場合も term 自身を1件だけ入れる`,
    ),
});

export const ExtractionResultSchema = z.object({
  cards: z.array(TermCardSchema).describe("抽出した用語カード。該当がなければ空配列"),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ExtractedCard = ExtractionResult["cards"][number];
