import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { TermLink } from "../protocol.js";
import { normalizeTerm } from "./normalize.js";
import type { Candidate } from "./schema.js";
import { config } from "../config.js";

// テストから `responses.create` を差し替えられるよう export する(extractor.ts の client と同じ理由)。
// スケジューラ経由の検証・棄却の分岐を、実 API を叩かずに端から端まで通せるようにするため。
export const client = new OpenAI();

/** 解説の上限。これを超えたら切り詰める(カードUIが約100字前提のため) */
const MAX_DESCRIPTION_CHARS = 120;
const MAX_LINKS = 3;

// モデル比較の実験でも同じ文面を使えるよう export する(コピーして drift させないため)
export const SYSTEM = `あなたは会議支援アシスタントです。音声認識が崩した表記から復元した用語の候補が複数与えられます。ウェブ検索で候補を検証して最も確からしい1件を選び、その用語の日本語の解説を書いてください。

ルール:
- 候補それぞれについて、(1) 実在する用語か、(2) 会議の文脈に合うか をウェブ検索で確認すること
- どの候補も裏付けが取れない場合は、無理に選ばず chosen を null にすること。音韻が似ているだけの実在用語を選ぶくらいなら、選ばないほうがよい
- chosen には候補として与えられた表記をそのまま入れること。候補に無い用語を新たに作らないこと
- 必ずウェブ検索を使って最新情報を確認すること(製品名・サービス名・企業名は特に、現在の状況が変わっている可能性がある)
- 検索クエリは日本語で組み立て、日本語のページを優先して引用すること。英語のソースは、日本語で十分な情報が見つからない場合に限る
- description は chosen の用語そのものの定義を主体とし、約100文字、最大120文字。前提知識のないビジネスパーソンにも分かる平易な日本語で。chosen が null なら空文字でよい
- 会議の文脈(文字起こし抜粋)は語義の特定にのみ使い、会議の状況説明は書かないこと
- description には「検索結果に基づくと」「〜について解説します」などの前置き、URLの列挙、箇条書き、出典の併記を一切書かず、解説の一文目から始めること
- reason には選択または棄却の理由を日本語で一言だけ書くこと(内部記録用。利用者には表示しない)`;

/**
 * 検証結果の構造化出力(#23)。
 *
 * **web検索ツールと構造化出力は併用できる**ことを実 API で確認済み。
 * `web_search_call` が実行されたうえで `output_text` に JSON が返り、
 * `url_citation` の annotations も従来どおり付く(= リンク収集は変えなくてよい)。
 */
const VerifyResultSchema = z.object({
  chosen: z
    .string()
    .nullable()
    .describe("裏付けが取れた候補の表記。どの候補も裏付けが取れなければ null"),
  reason: z.string().describe("選択または棄却の理由。内部記録用"),
  description: z.string().describe("chosen の日本語解説。約100文字、最大120文字。棄却時は空文字"),
});

export interface VerifyAndEnrichInput {
  /** 抽出段が挙げた候補。先頭が表示中の用語(`normalizeCandidates()` の不変条件) */
  candidates: Candidate[];
  /** 誤認識から復元した場合の元の表記。null なら補正なし */
  correctedFrom: string | null;
  /** 会議での文脈(文字起こし抜粋) */
  context: string;
}

/** 検証の判断だけを取り出したもの。リンク収集と分けてあるので純関数で固定できる。 */
export interface VerifyDecision {
  /** 裏付けが取れた候補。どれも取れなければ null(棄却) */
  chosen: string | null;
  /** 選択・棄却の理由。内部記録用 */
  reason: string;
  description: string;
}

export interface VerifyAndEnrichResult extends VerifyDecision {
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
 * 収集した候補の中からコード側で選び直す(verifyAndEnrich 参照)ための判定に使う。
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

/**
 * user 入力を組み立てる。候補が LLM へ届く経路をテストから固定できるよう純関数にしてある
 * (`buildUserTurn()` と同じ理由)。
 */
export function buildVerifyInput(input: VerifyAndEnrichInput): string {
  const list = input.candidates
    .map((c, i) => `${i + 1}. ${c.term}(読み: ${c.reading}) — 根拠: ${c.rationale}`)
    .join("\n");
  return [
    "# 候補(確からしい順)",
    list.length > 0 ? list : "(なし)",
    "",
    "# 音声認識が崩した元の表記",
    input.correctedFrom ?? "(補正なし)",
    "",
    "# 会議での文脈(文字起こし抜粋)",
    input.context,
  ].join("\n");
}

/**
 * 先頭の `{` から**対応する閉じ括弧まで**を切り出す。文字列リテラル内の括弧は数えない。
 *
 * ```json … ``` のフェンスや前置きに埋もれていても拾うためのものだが、単純な
 * `lastIndexOf("}")` だと後ろに別の JSON や `}` を含む後書きが続いたときに
 * 最初のオブジェクトを飛び越して丸ごと掴み、パースに失敗する。
 * 見つからなければ null を返し、呼び出し側で例外にする。
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * 検証結果のテキストを `VerifyDecision` に変換する。
 *
 * 構造化出力を使っていても、モデルはコードフェンスで包んだり前置きを添えたりすることがある。
 * また **description には指示に反して引用記法が混ざる**(実 API で確認済み)ため、
 * 素の JSON.parse だけでは足りない。
 *
 * **`chosen` は候補の中からしか採らない。** 候補外の用語が返ってきたら棄却に倒す。
 * 検証段は「抽出段の誤補正を弾く」ためにあり、ここで新しい用語を作れてしまうと
 * 独立した検証者を立てた意味が無くなる。
 */
export function parseVerifyOutput(
  outputText: string,
  candidates: Array<{ term: string }>,
): VerifyDecision {
  const body = extractJsonObject(outputText);
  if (body === null) {
    throw new Error("検証結果が JSON として返りませんでした");
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("検証結果の JSON を解釈できませんでした");
  }
  const parsed = VerifyResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`検証結果のスキーマが一致しません: ${z.prettifyError(parsed.error)}`);
  }

  const description = clampDescription(stripInlineCitations(parsed.data.description));
  const reason = parsed.data.reason.trim();
  const raw = (parsed.data.chosen ?? "").trim();
  if (raw === "") return { chosen: null, reason, description };

  const matched = candidates.find((c) => normalizeTerm(c.term) === normalizeTerm(raw));
  if (!matched) {
    return {
      chosen: null,
      reason: `候補に無い用語「${raw}」が返されたため棄却しました。${reason}`,
      description,
    };
  }
  // 表記は候補側を正典とする。モデルが返した表記ゆれをそのまま採ると、
  // 呼び出し元の `isVerified()` や card_update の term 突き合わせが表記に振られる。
  return { chosen: matched.term, reason, description };
}

/**
 * 検証が「表示中の用語」を裏付けたか。
 *
 * 候補の2番目以降が選ばれた場合は裏付け無しとして扱う。`card_update` は term で
 * カードを突き合わせる仕様なので、**表示中のカードを別の用語に改名する経路が無い**
 * (改名は unresolved 状態の Issue でまとめて入れる)。
 */
export function isVerified(term: string, chosen: string | null): boolean {
  return chosen !== null && normalizeTerm(chosen) === normalizeTerm(term);
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

/** zod → JSON Schema の変換は定数なので、カードごとのリクエスト経路で組み直さない。 */
const VERIFY_FORMAT = zodTextFormat(VerifyResultSchema, "verify_result");

interface LinkCandidate {
  url: string;
  title: string;
  cited: boolean;
  /** 並べ替えの順位。**候補を作るときに1度だけ計算する** — `sort` の比較関数の中で
   *  求めると `new URL()` と正規表現が O(n log n) 回走る（`include` を付けた結果、
   *  候補は引用済みの数件ではなく検索結果の全件になっている）。 */
  rank: number;
}

/**
 * 引用済み(cited)を最優先、次に日本語ソースを優先する順位を返す(数値が小さいほど上位)。
 * 同順位内は Array#sort の安定ソート(ES2019+で仕様上保証)により候補収集時の順序を保つ。
 */
function linkRank(url: string, title: string, cited: boolean): number {
  return (cited ? 0 : 2) + (isJapaneseSource(url, title) ? 0 : 1);
}

/**
 * 候補をweb検索で検証したうえで清書する(#23 の Stage 2)。
 *
 * **1カードあたりの LLM 呼び出しは増えない。** 従来の清書(web検索つき)にそのまま検証を同居させ、
 * 「実在するか」「文脈に合うか」を**独立した情報源**で確かめる。抽出段と同じ推論パスの
 * 中で自己検証しても、誤補正の自己強化は断ち切れないため。
 * ただし**チャンクあたりでは増える** — `selectVerifyTargets()` が「補正あり or 非 confirmed」を
 * 和集合で足すぶん、対象カードが増えればそのぶん web 検索つきの呼び出しが増える。
 *
 * リンクは「候補を全部集めてから最大3件選ぶ」の2段階で決める。
 * 集めながら3件で打ち切る実装だと、日本語ソースが4番目以降にあるだけで
 * 採用されずに終わってしまう(SYSTEM の指示だけでは LLM が日本語優先を徹底しないため)。
 */
export async function verifyAndEnrich(
  input: VerifyAndEnrichInput,
): Promise<VerifyAndEnrichResult> {
  const response = await client.responses.create({
    model: config.llmModel,
    reasoning: { effort: "low" },
    instructions: SYSTEM,
    input: buildVerifyInput(input),
    tools: [{ type: "web_search" }],
    max_output_tokens: 2000,
    // 引用されなかった検索結果もリンク候補に使うため、結果本体を返させる
    include: ["web_search_call.results"],
    text: { format: VERIFY_FORMAT },
  });

  // 出力が上限に達すると Responses API は例外ではなく `status: "incomplete"` で返す。
  // 見ないと JSON が途中で切れたぶんが「JSON として返らなかった」という汎用エラーに化け、
  // 抽出段では一級の失敗モードとして扱っている出力長超過が、ここでは原因不明になる。
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason ?? "unknown";
    throw new Error(`検証の応答が途中で打ち切られました: ${reason}`);
  }

  const decision = parseVerifyOutput(response.output_text ?? "", input.candidates);

  // 棄却なら以降のリンク収集は無駄。呼び出し元は棄却時のリンクを使わない
  // (`scheduler.ts` は空配列を送り、評価ハーネスは links を見ない)。
  if (decision.chosen === null) return { ...decision, links: [] };
  // 裏付けが取れたのに解説が空なら清書として成立しない
  if (!decision.description) {
    throw new Error(`web検索による要約が生成されませんでした: ${decision.chosen}`);
  }

  const linkCandidates: LinkCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (url: string | undefined, title: string | undefined, cited: boolean) => {
    // URL不正・スキーム不正な候補はここで弾く(件数を「候補として全部集める」対象にも入れない)
    if (!url || !isHttpUrl(url)) return;
    const key = urlKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    const label = title?.trim() || url;
    linkCandidates.push({ url, title: label, cited, rank: linkRank(url, label, cited) });
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
  const links: TermLink[] = linkCandidates
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_LINKS)
    .map(({ url, title }) => ({ url, title }));

  return { ...decision, links };
}
