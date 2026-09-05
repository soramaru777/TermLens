import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Session } from "../src/session.js";
import { MockSttAdapter } from "../src/stt/mock.js";
import type { ServerMessage } from "../src/protocol.js";

type Handler = (...args: unknown[]) => void;

class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  private handlers = new Map<string, Handler[]>();

  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  clientSend(msg: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const countClosed = (ws: FakeWs): number =>
  ws.sent.filter((m) => m.type === "status" && m.state === "stt_closed").length;

test("通常の stop では stt_closed を1回通知する", async () => {
  const startSpy = mock.method(MockSttAdapter.prototype, "start", async () => {});
  const ws = new FakeWs();
  new Session(ws as never);

  try {
    ws.clientSend({ type: "start", glossary: [] });
    await settle();
    assert.equal(ws.sent.filter((m) => m.type === "ready").length, 1);

    ws.clientSend({ type: "stop" });
    await settle();
    await settle();

    assert.equal(countClosed(ws), 1, "正常停止の stt_closed が失われている");
  } finally {
    ws.emit("close");
    startSpy.mock.restore();
  }
});

test("旧 stop の完了が新セッションへ stt_closed を混ぜない", async () => {
  let releaseFirstStop!: () => void;
  const firstStop = new Promise<void>((resolve) => {
    releaseFirstStop = resolve;
  });
  let stopCount = 0;

  const startSpy = mock.method(MockSttAdapter.prototype, "start", async () => {});
  const stopSpy = mock.method(MockSttAdapter.prototype, "stop", async () => {
    stopCount++;
    if (stopCount === 1) await firstStop;
  });
  const ws = new FakeWs();
  new Session(ws as never);

  try {
    ws.clientSend({ type: "start", glossary: [] });
    await settle();

    ws.clientSend({ type: "stop" });
    await settle();
    ws.clientSend({ type: "start", glossary: [] });
    await settle();
    assert.equal(ws.sent.filter((m) => m.type === "ready").length, 2);

    releaseFirstStop();
    await settle();
    await settle();
    assert.equal(countClosed(ws), 0, "旧 stop の stt_closed が新セッションへ混入した");

    ws.clientSend({ type: "stop" });
    await settle();
    await settle();
    assert.equal(countClosed(ws), 1, "現行セッションの stt_closed が通知されていない");
  } finally {
    releaseFirstStop();
    ws.emit("close");
    stopSpy.mock.restore();
    startSpy.mock.restore();
  }
});
