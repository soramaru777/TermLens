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
 * http/https 以外のスキームを弾く。web検索の citation は本来 http(s) の想定だが、
 * 上流サービスの出力形式に検証をかけず a.href に渡すと javascript: 等の混入時に
 * ページのオリジンで任意スクリプトが実行されうるため、多層防御として存在チェックする。
 * 不正な URL・相対 URL(new URL() が投げるもの)も同様に弾く。
 */
export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
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

/**
 * タイトルまたは URL から「日本語ソースらしさ」を判定する。
 * SYSTEM プロンプトで日本語ソースを優先するよう指示しても LLM が部分的にしか従わないため、
 * 収集した候補の中からコード側で選び直す(enrichTerm 参照)ための判定に使う。
 */
export function isJapaneseSource(url: string, title?: string): boolean {
  // 漢字だけでは中国語ページと区別できない(実際に qdrant.org.cn の中国語ページを
  // 日本語と誤判定して優先していた)。かなの有無を日本語の判定材料にする。
  // 「冗長化」のようなかな無しの日本語タイトルは取りこぼすが、その場合は
  // 従来どおりの順序に落ちるだけで、誤って優先するより害が小さい。
  if (title && /[぀-ヿ]/.test(title)) return true;
  try {
    const { hostname, pathname } = new URL(url);
    if (/\.jp$/i.test(hostname)) return true;
    if (/\/ja\/|\/ja[-_]jp\//i.test(pathname)) return true;
  } catch {
    // 不正な URL は isHttpUrl 側で候補から除外される想定
  }
  return false;
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

interface LinkCandidate {
  url: string;
  title: string;
  cited: boolean;
}

/**
 * 引用済み(cited)を最優先、次に日本語ソースを優先する順位を返す(数値が小さいほど上位)。
 * 同順位内は Array#sort の安定ソート(ES2019+で仕様上保証)により候補収集時の順序を保つ。
 */
function linkRank(candidate: LinkCandidate): number {
  return (candidate.cited ? 0 : 2) + (isJapaneseSource(candidate.url, candidate.title) ? 0 : 1);
}

/**
 * 用語1件をweb検索付きで再調査し、最新情報ベースの要約と引用リンク(最大3件)を返す。
 * リンクは「候補を全部集めてから最大3件選ぶ」の2段階で決める。
 * 集めながら3件で打ち切る実装だと、日本語ソースが4番目以降にあるだけで
 * 採用されずに終わってしまう(SYSTEM の指示だけでは LLM が日本語優先を徹底しないため)。
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

  const candidates: LinkCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (url: string | undefined, title: string | undefined, cited: boolean) => {
    // URL不正・スキーム不正な候補はここで弾く(件数を「候補として全部集める」対象にも入れない)
    if (!url || !isHttpUrl(url)) return;
    const key = urlKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ url, title: title?.trim() || url, cited });
  };

  const output = (response.output ?? []) as unknown as OutputItem[];
  // 1) モデルが実際に引用したソース
  for (const item of output) {
    for (const block of item.content ?? []) {
      for (const a of block.annotations ?? []) {
        if (a.type === "url_citation") addCandidate(a.url, a.title, true);
      }
    }
  }
  // 2) 引用されなかった検索結果も候補に加える(打ち切らずに全件集め、後段の優先順位付けで選ぶ)
  for (const item of output) {
    if (!String(item.type).includes("web_search")) continue;
    for (const r of item.results ?? item.action?.results ?? []) addCandidate(r.url, r.title, false);
  }

  // 引用済み優先 → 日本語ソース優先の順位で並べ替え、上位 MAX_LINKS 件を採用する。
  // 日本語ソースが無ければ従来どおり英語ソースだけで埋まる(件数は減らさない)。
  const links: TermLink[] = candidates
    .sort((a, b) => linkRank(a) - linkRank(b))
    .slice(0, MAX_LINKS)
    .map(({ url, title }) => ({ url, title }));

  if (!description) throw new Error(`web検索による要約が生成されませんでした: ${term}`);
  return { description, links };
}
