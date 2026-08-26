import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { ExtractionResultSchema, type ExtractionResult } from "./schema.js";
import { config } from "../config.js";

// テストから `chat.completions.parse` を差し替えられるよう export する。
// そうしないと「extract() が buildUserTurn と filterSurfaceForms を実際に使っているか」を
// 実 API を叩かずに検証できない(どちらも単体では正しいのに配線だけ抜ける事故を防ぐ)。
export const client = new OpenAI();

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
   - 判断に迷う場合は、その会議で実際に話された表記に寄せること。
9. 「直前の会話」は語義や固有名詞を判断するための参考情報であり、カード化の対象ではない。直前の会話にしか登場しない用語は出力しないこと。カードにするのは「新しい文字起こし」に登場した用語だけとする。`;

export interface ExtractorInput {
  /** 今回カード化・surfaceForms 抽出の対象 */
  newTranscript: string;
  /**
   * 語義判定にだけ使う直前の会話（#22）。カード化の対象ではない。
   * 呼び出し側が省略できるよう optional にしてある(評価ハーネスは文脈なしでも回す)。
   */
  contextTranscript?: string;
  shownTerms: string[];
}

/**
 * `surfaceForms` を「新しい文字起こしに実在する表記」だけに絞る。
 *
 * プロンプト規則7で指示しているが**サーバー側の検証が無かった**ため、文脈を渡し始めると
 * 直前の会話に出てきただけの表記が混ざりうる。クライアントは surfaceForms で
 * 文字起こし本文をハイライトする(`public/app.js`)ので、本文に無い表記は害にしかならない。
 *
 * **カード自体は落とさない。** surfaceForms が空になってもカードは残す(ハイライトが効かない
 * だけで、`public/app.js` は `?? []` で受けている)。LLM が surfaceForms を出し渋っただけで
 * 正しい新規用語を捨てるほうが害が大きい。
 *
 * 置き場所が `scheduler.ts` ではなく抽出器側なのは、評価ハーネス(`src/eval/run.ts`)が
 * `createExtractor()` を直接呼ぶため。スケジューラに置くと**評価が本番と違う挙動を測る**。
 */
export function filterSurfaceForms<T extends { surfaceForms: string[] }>(
  cards: T[],
  newTranscript: string,
): T[] {
  return cards.map((card) => ({
    ...card,
    surfaceForms: card.surfaceForms.filter((f) => f !== "" && newTranscript.includes(f)),
  }));
}

/**
 * user ターンを組み立てる。
 *
 * **判断対象(新しい文字起こし)を末尾＝直近に置く。** 参考情報が先、対象が後。
 * 純関数として切り出してあるのは、`extract()` の中に埋めたままだと
 * 「`contextTranscript` が実際に LLM へ届いているか」を LLM を呼ばずに検証できないため。
 * `filterSurfaceForms()` を切り出したのと同じ理由。
 */
export function buildUserTurn(input: ExtractorInput): string {
  const context = input.contextTranscript ?? "";
  return [
    "# 直前の会話(文脈。カード化の対象外)",
    context.trim().length > 0 ? context : "(なし)",
    "",
    "# 表示済み用語リスト",
    input.shownTerms.length > 0 ? input.shownTerms.join("、") : "(なし)",
    "",
    "# 新しい文字起こし",
    input.newTranscript,
  ].join("\n");
}

export function createExtractor(glossary: string[]) {
  // system はセッション中バイト不変に保つ。OpenAI はプレフィックスが一致した入力を
  // 自動でキャッシュするため、可変部分(トランスクリプト・表示済みリスト)は user 側に置く。
  const glossaryText = glossary.length > 0 ? glossary.join("\n") : "(なし)";
  const systemPrompt = `${ROLE_PROMPT}\n\n# 会議の用語集(参加者名・社名・専門用語)\n${glossaryText}`;

  return async function extract(input: ExtractorInput): Promise<ExtractionResult["cards"]> {
    const userTurn = buildUserTurn(input);

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

    const cards = response.choices[0]?.message.parsed?.cards ?? [];
    return filterSurfaceForms(cards, input.newTranscript);
  };
}
