import { z } from "zod";

export const TermCardSchema = z.object({
  term: z.string().describe("正規化した用語名。誤認識で崩れたカタカナは正しい表記に直す(例: クバネテス → Kubernetes)"),
  reading: z.string().describe("用語のカタカナ読み"),
  description: z.string().describe("日本語の解説。約100文字、最大120文字"),
  confidence: z.enum(["high", "low"]).describe("誤認識からの推定に自信がない場合は low"),
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
});

export const ExtractionResultSchema = z.object({
  cards: z.array(TermCardSchema).describe("抽出した用語カード。該当がなければ空配列"),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
