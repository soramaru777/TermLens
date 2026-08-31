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

/**
 * 0..1 の実数ノブを読む(#40)。
 *
 * `intEnv` と分けてあるのは、**類似度の閾値だけは小数でなければ意味が無い**ため
 * (0.5 を整数に丸めると 0 か 1 にしかならず、絞り込みが「素通し」か「完全一致のみ」の
 * 二択になる)。範囲を見るのは `intEnv` と同じ理由 — `REMATCH_MIN_SIMILARITY=5` は
 * どの語も通さない設定として黙って効き、**再評価が一度も発火しないまま静かに死ぬ**。
 * 0 は「絞り込みなし」として意味を持つので許す(分布計測用。`MAX_WEB_SEARCHES=0` と同じ)。
 */
function ratioEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1, got: ${raw}`);
  }
  return value;
}

/**
 * 0 以上の整数ノブを読む(#40)。
 *
 * `intEnv` と分けてあるのは、**負値が「無効化」として黙って効いてしまう**ノブがあるため。
 * `REMATCH_COOLDOWN_MS=-1` は `now - lastAttemptAt < -1` が常に false になるので
 * cooldown が丸ごと外れるが、エラーも警告も出ない。`ratioEnv` だけ範囲を見て
 * こちらが素通しなのは非対称なので、上限の意味を持つノブは入口で弾く。
 */
function nonNegativeIntEnv(name: string, fallback: number): number {
  const value = intEnv(name, fallback);
  if (value < 0) throw new Error(`${name} must be 0 or greater, got: ${value}`);
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
  // --- unresolved カードの再評価(#40) ---------------------------------------
  // **3つとも暫定値で、根拠は「まだ測っていない」。** 決め方は `MAX_WEB_SEARCHES` と
  // 同じ手順で、`REMATCH_MIN_SIMILARITY=0` の**絞り込みなし**で分布を測ってから人が
  // 決める(上限を入れたまま測ると、上限値を決めるための分布を上限が壊す)。
  // 値の意味は `extract/rematch.ts` と `extract/scheduler.ts` のコメントに一本化。
  //
  // 再評価に回す候補を絞る類似度の下限。**0 なら絞り込みなし**(分布計測用)
  rematchMinSimilarity: ratioEnv("REMATCH_MIN_SIMILARITY", 0.5),
  // 同じ unresolved カードを再評価する最大回数。0 なら再評価しない
  maxRematchAttempts: nonNegativeIntEnv("MAX_REMATCH_ATTEMPTS", 2),
  // 同じ unresolved カードを続けて再評価するまでの待ち時間(ミリ秒)。0 なら待たない
  rematchCooldownMs: nonNegativeIntEnv("REMATCH_COOLDOWN_MS", 30_000),
};

if (!config.authToken) {
  console.warn("[config] AUTH_TOKEN is not set — authentication is DISABLED (local dev only)");
}
