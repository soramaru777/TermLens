import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { ExtractionResultSchema, type ExtractionResult } from "./schema.js";
import { config } from "../config.js";

const client = new OpenAI();

// モデル比較の実験でも同じ文面を使えるよう export する(コピーして drift させないため)
export const ROLE_PROMPT = `あなたは会議のリアルタイム文字起こしを監視し、聞き手が知らない可能性のある専門用語・固有名詞・重要語を抽出して、日本語で約100文字(最大120文字)の解説カードを作るアシスタントです。

ルール:
1. 文字起こしは音声認識由来で、特にカタカナ語・英語由来の用語が崩れていることがある。文脈と用語集から本来の用語を推定して term に正規化し、元の崩れた表記を correctedFrom に入れること(例: 「クバネテス」→ term: Kubernetes, correctedFrom: クバネテス)。推定に自信がなければ confidence を low にすること。
2. 「表示済み用語リスト」にある用語(表記ゆれ・言い換えを含む)は出力しないこと。
3. 一般的な日常語や、解説不要な平易な語は出力しないこと。該当する用語がなければ cards は空配列でよい。
4. 用語集の語は主に音声認識の補助情報である。参加者名・社名そのものはカード化不要だが、文脈上重要な専門用語であればカード化してよい。
5. 解説は前提知識のないビジネスパーソンにも分かる平易な日本語で書くこと。
6. rarity は用語のレア度: よく知られた一般用語は common、業界人なら知っている用語は uncommon、ニッチ・新しい・固有名詞・誤認識から復元した用語は rare とすること。
7. surfaceForms には、その用語が「新しい文字起こし」に登場した表記を原文のまま列挙すること(カタカナ表記・誤認識表記を含む。文字起こしに現れない表記は入れない)。
8. term の表記は次の基準で決めること。日本語の会議で読むカードなので、日本語話者が実際に使う表記に合わせる。
   - 製品名・サービス名・企業名・規格名・略語など、正式な原表記があるものはその表記のまま書く(例: Kubernetes、Grafana、Pinecone、Qdrant、OAuth、PKCE、NDA、Jira、RAG)。無理に日本語訳・カタカナ化しないこと。
   - それ以外で、日本語でカタカナ表記が定着している語はカタカナで書く(例: フェイルオーバー、マイグレーション、レイテンシ)。英語に戻さないこと。
   - 日本語の語として定着しているものは日本語で書く(例: 冗長化、二要素認証)。
   - この規則は表記の決め方だけを定めるものであり、どの語をカード化するかの判断(規則3)には影響しない。ここに挙げた例は表記の見本であって、「平易だから出力しない語」の例ではない。
   - 判断に迷う場合は、その会議で実際に話された表記に寄せること。`;

export interface ExtractorInput {
  newTranscript: string;
  shownTerms: string[];
}

export function createExtractor(glossary: string[]) {
  // system はセッション中バイト不変に保つ。OpenAI はプレフィックスが一致した入力を
  // 自動でキャッシュするため、可変部分(トランスクリプト・表示済みリスト)は user 側に置く。
  const glossaryText = glossary.length > 0 ? glossary.join("\n") : "(なし)";
  const systemPrompt = `${ROLE_PROMPT}\n\n# 会議の用語集(参加者名・社名・専門用語)\n${glossaryText}`;

  return async function extract(input: ExtractorInput): Promise<ExtractionResult["cards"]> {
    const userTurn = [
      "# 表示済み用語リスト",
      input.shownTerms.length > 0 ? input.shownTerms.join("、") : "(なし)",
      "",
      "# 新しい文字起こし",
      input.newTranscript,
    ].join("\n");

    const response = await client.chat.completions.parse({
      model: config.llmModel,
      // 低レイテンシ用途なので推論は最小限にする
      reasoning_effort: "low",
      max_completion_tokens: 3000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userTurn },
      ],
      response_format: zodResponseFormat(ExtractionResultSchema, "extraction_result"),
    });

    return response.choices[0]?.message.parsed?.cards ?? [];
  };
}
