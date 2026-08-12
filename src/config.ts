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

export const config = {
  port: Number(process.env.PORT ?? 8080),
  authToken: process.env.AUTH_TOKEN ?? "",
  sttProvider: sttProvider as "mock" | "deepgram",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
};

if (!config.authToken) {
  console.warn("[config] AUTH_TOKEN is not set — authentication is DISABLED (local dev only)");
}
