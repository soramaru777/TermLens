import OpenAI from "openai";
import type { TermLink } from "../protocol.js";
import { config } from "../config.js";

const client = new OpenAI();

/** 解説の上限。これを超えたら切り詰める(カードUIが約100字前提のため) */
const MAX_DESCRIPTION_CHARS = 120;
const MAX_LINKS = 3;

// モデル比較の実験でも同じ文面を使えるよう export する(コピーして drift させないため)
export const SYSTEM = `あなたは会議支援アシスタントです。指定された用語をウェブ検索し、最新情報に基づいて日本語の解説を書いてください。

ルール:
- 必ずウェブ検索を使って最新情報を確認すること(製品名・サービス名・企業名は特に、現在の状況が変わっている可能性がある)
- 検索クエリは日本語で組み立て、日本語のページを優先して引用すること。英語のソースは、日本語で十分な情報が見つからない場合に限る
- 解説は用語そのものの定義を主体とし、約100文字、最大120文字。前提知識のないビジネスパーソンにも分かる平易な日本語で
- 会議の文脈(文字起こし抜粋)は語義の特定にのみ使い、会議の状況説明は書かないこと
- 最後のメッセージは解説本文のみを書くこと。「検索結果に基づくと」「〜について解説します」などの前置き、URLの列挙、箇条書き、出典の併記は一切書かず、解説の一文目から始めること`;

export interface EnrichResult {
  description: string;
  links: TermLink[];
}

/**
 * 本文に混ざった Markdown の引用記法を落とす。
 * モデルは指示に反して「([example.com](https://…))」を本文へ埋め込むことがあり、
 * カードは textContent で描画するため、そのままだと記法が文字列として見えてしまう。
 */
export function stripInlineCitations(text: string): string {
  return String(text ?? "")
    // 「([a](u))」「([a](u), [b](v))」のような括弧でくくられた引用群
    .replace(/\s*\((?:\[[^\]]*\]\([^)]*\)(?:\s*,\s*)?)+\)/g, "")
    // 素の Markdown リンクはラベルだけ残す
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 本文に直接書かれた裸の URL
    .replace(/\s*https?:\/\/\S+/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * 同一ページが計測パラメータ違いで重複するのを防ぐための正規化キー。
 * web検索の結果には utm_source が付くことがあり、素の URL 比較では重複を弾けない。
 */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === "ref" || key === "source") u.searchParams.delete(key);
    }
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url);
  }
}

/** 上限を超えた解説を文の切れ目で丸める。切れ目が無ければそのまま切り詰める。 */
export function clampDescription(text: string, max = MAX_DESCRIPTION_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastEnd = Math.max(head.lastIndexOf("。"), head.lastIndexOf("."));
  // 短くなりすぎる位置で切ると意味を成さないため、半分以上残る場合のみ文末で丸める
  return lastEnd >= max / 2 ? head.slice(0, lastEnd + 1) : head;
}

interface Annotation {
  type?: string;
  url?: string;
  title?: string;
}
interface OutputItem {
  type?: string;
  content?: Array<{ annotations?: Annotation[] }>;
  results?: Array<{ url?: string; title?: string }>;
  action?: { results?: Array<{ url?: string; title?: string }> };
}

/**
 * 用語1件をweb検索付きで再調査し、最新情報ベースの要約と引用リンク(最大3件)を返す。
 * リンクはモデルが実際に引用したソース(annotations)を優先し、不足分は検索結果から補完する。
 */
export async function enrichTerm(term: string, context: string): Promise<EnrichResult> {
  const response = await client.responses.create({
    model: config.llmModel,
    reasoning: { effort: "low" },
    instructions: SYSTEM,
    input: `用語:「${term}」\n\n会議での文脈(文字起こし抜粋):\n${context}`,
    tools: [{ type: "web_search" }],
    max_output_tokens: 2000,
    // 引用されなかった検索結果もリンク候補に使うため、結果本体を返させる
    include: ["web_search_call.results"],
  });

  const fullText = (response.output_text ?? "").trim();
  // 「検索結果を確認しました…」等の前置き段落が混入することがあるため、
  // 複数段落の場合は最終段落(解説本文)のみを採用する
  const paragraphs = fullText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const raw = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : fullText;
  const description = clampDescription(stripInlineCitations(raw));

  const links: TermLink[] = [];
  const seen = new Set<string>();
  const addLink = (url?: string, title?: string) => {
    if (!url || links.length >= MAX_LINKS) return;
    const key = urlKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ url, title: title?.trim() || url });
  };

  const output = (response.output ?? []) as unknown as OutputItem[];
  // 1) モデルが実際に引用したソース
  for (const item of output) {
    for (const block of item.content ?? []) {
      for (const a of block.annotations ?? []) {
        if (a.type === "url_citation") addLink(a.url, a.title);
      }
    }
  }
  // 2) 足りない分を検索結果から補完
  for (const item of output) {
    if (!String(item.type).includes("web_search")) continue;
    for (const r of item.results ?? item.action?.results ?? []) addLink(r.url, r.title);
  }

  if (!description) throw new Error(`web検索による要約が生成されませんでした: ${term}`);
  return { description, links };
}
