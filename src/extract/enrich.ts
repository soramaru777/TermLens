import Anthropic from "@anthropic-ai/sdk";
import type { TermLink } from "../protocol.js";
import { config } from "../config.js";

const client = new Anthropic();

const SYSTEM = `あなたは会議支援アシスタントです。指定された用語をウェブ検索し、最新情報に基づいて日本語の解説を書いてください。

ルール:
- 必ず web_search を使って最新情報を確認すること(製品名・サービス名・企業名は特に、現在の状況が変わっている可能性がある)
- 検索では日本語のソースを優先すること(適切な日本語ソースがなければ英語も可)
- 解説は用語そのものの定義を主体とし、約100文字、最大120文字。前提知識のないビジネスパーソンにも分かる平易な日本語で
- 会議の文脈(文字起こし抜粋)は語義の特定にのみ使い、会議の状況説明は書かないこと
- 最後のメッセージは解説本文のみを書くこと。「検索結果に基づくと」「〜について解説します」などの前置き、URLの列挙、箇条書きは一切書かず、解説の一文目から始めること`;

/** モデルに応じたweb searchツール定義(haiku 4.5 は旧バリアントのみ対応) */
function webSearchTool(): Anthropic.Messages.ToolUnion {
  const type = config.anthropicModel.includes("haiku")
    ? "web_search_20250305"
    : "web_search_20260209";
  return { type, name: "web_search", max_uses: 1 } as Anthropic.Messages.ToolUnion;
}

export interface EnrichResult {
  description: string;
  links: TermLink[];
}

/**
 * 用語1件をweb検索付きで再調査し、最新情報ベースの要約と引用リンク(最大3件)を返す。
 * リンクはモデルが実際に引用したソース(citations)を優先し、不足分は検索結果から補完する。
 */
export async function enrichTerm(term: string, context: string): Promise<EnrichResult> {
  const params = {
    model: config.anthropicModel,
    max_tokens: 2000,
    // Sonnet 5 の adaptive thinking 自動有効化を避ける(extractor.ts と同じ理由)
    thinking: { type: "disabled" as const },
    system: [
      { type: "text" as const, text: SYSTEM, cache_control: { type: "ephemeral" as const } },
    ],
    tools: [webSearchTool()],
  };

  let messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `用語:「${term}」\n\n会議での文脈(文字起こし抜粋):\n${context}`,
    },
  ];

  const allBlocks: unknown[] = [];
  let response = await client.messages.create({ ...params, messages });
  allBlocks.push(...response.content);

  // サーバーサイドツールの反復上限に達した場合は再送して続きを実行させる
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < 2) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await client.messages.create({ ...params, messages });
    allBlocks.push(...response.content);
    continuations += 1;
  }

  // 解説 = 最終回答のテキスト。citations によって最終回答は複数の text ブロックに
  // 分割されるため、最後の非 text ブロック(検索結果等)以降を全て連結する。
  const content = response.content;
  let lastNonTextIdx = -1;
  content.forEach((b, i) => {
    if (b.type !== "text") lastNonTextIdx = i;
  });
  const fullText = content
    .slice(lastNonTextIdx + 1)
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  // 「検索結果を確認しました…」等の前置き段落が混入することがあるため、
  // 複数段落の場合は最終段落(解説本文)のみを採用する
  const paragraphs = fullText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const description = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : fullText;

  // リンク収集: citations 優先 → 検索結果で補完
  const links: TermLink[] = [];
  const seen = new Set<string>();
  const addLink = (url?: string, title?: string) => {
    if (!url || seen.has(url) || links.length >= 3) return;
    seen.add(url);
    links.push({ url, title: title?.trim() || url });
  };

  for (const raw of allBlocks) {
    const block = raw as { type?: string; citations?: unknown };
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations as Array<{ url?: string; title?: string }>) {
        addLink(c.url, c.title);
      }
    }
  }
  for (const raw of allBlocks) {
    const block = raw as { type?: string; content?: unknown };
    // エラー時は content が配列ではなくエラーオブジェクトになるため配列チェックが必要
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content as Array<{ url?: string; title?: string }>) {
        addLink(r.url, r.title);
      }
    }
  }

  if (!description) throw new Error(`web検索による要約が生成されませんでした: ${term}`);
  return { description, links };
}
