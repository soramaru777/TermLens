import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// カレントディレクトリに依存せず、常にプロジェクトルートの .env を読む
loadEnv({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

const sttProvider = process.env.STT_PROVIDER ?? "mock";
if (sttProvider !== "mock" && sttProvider !== "deepgram") {
  throw new Error(`STT_PROVIDER must be "mock" or "deepgram", got: ${sttProvider}`);
}
if (sttProvider === "deepgram" && !process.env.DEEPGRAM_API_KEY) {
  throw new Error("STT_PROVIDER=deepgram requires DEEPGRAM_API_KEY");
}

/**
 * 整数の env ノブを読む。**検証をここに一本化する** — 素の `Number()` だと小数や負値が
 * そのまま下流へ流れる(`max_tool_calls: 4.5` は API 側 400 になり、`isPermanent()` 経由で
 * そのセッションの検証が丸ごと止まる)。
 */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got: ${raw}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  authToken: process.env.AUTH_TOKEN ?? "",
  sttProvider: sttProvider as "mock" | "deepgram",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
  deepgramModel: process.env.DEEPGRAM_MODEL ?? "nova-3",
  // 用語抽出・清書に使う LLM。OpenAI の Chat Completions / Responses API を叩く
  llmModel: process.env.LLM_MODEL ?? "gpt-5.6-luna",
  // 1カードの検証で許す web 検索の回数(#25)。0 以下なら上限なし。
  // **値の決め方は `extract/enrich.ts` の `MAX_WEB_SEARCHES` のコメントに一本化**
  maxWebSearches: intEnv("MAX_WEB_SEARCHES", 5),
};

if (!config.authToken) {
  console.warn("[config] AUTH_TOKEN is not set — authentication is DISABLED (local dev only)");
}
