import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { Session } from "./session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");

const app = Fastify({ logger: true });

await app.register(fastifyStatic, { root: publicDir });

app.get("/healthz", async () => ({ ok: true }));

app.get("/api/info", async () => ({
  sttProvider: config.sttProvider,
  model: config.anthropicModel,
  authRequired: config.authToken.length > 0,
}));

function tokenMatches(provided: string): boolean {
  if (!config.authToken) return true; // 認証無効(ローカル開発)
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(config.authToken).digest();
  return timingSafeEqual(a, b);
}

const wss = new WebSocketServer({ noServer: true });

// トークンは URL クエリではなく Sec-WebSocket-Protocol で受け取る
// (プロキシやアクセスログの URL 欄・ブラウザ履歴にトークンを残さないため)。
// クライアントは new WebSocket(url, ["termlens.v1", "auth." + encodeURIComponent(token)]) で送る。
function extractToken(req: IncomingMessage): string {
  const header = req.headers["sec-websocket-protocol"];
  if (!header) return "";
  for (const part of String(header).split(",")) {
    const p = part.trim();
    if (p.startsWith("auth.")) {
      try {
        return decodeURIComponent(p.slice("auth.".length));
      } catch {
        return "";
      }
    }
  }
  return "";
}

app.server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!tokenMatches(extractToken(req))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    new Session(ws);
  });
});

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(
  `[server] listening on :${config.port}  stt=${config.sttProvider}  model=${config.anthropicModel}  auth=${config.authToken ? "on" : "OFF"}`,
);
