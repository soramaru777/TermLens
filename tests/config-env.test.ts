import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

/**
 * env ノブの検証（#25）。
 *
 * **素の `Number()` だと壊れた値がそのまま下流へ流れる。** `MAX_WEB_SEARCHES=2.5` は
 * `max_tool_calls: 4.5` になって API 側 400 を招き、`isPermanent()` 経由で
 * **そのセッションの検証が丸ごと止まる**。起動時に落ちるほうが分かりやすい。
 *
 * `config.ts` は import した瞬間に `.env` を読んで検証するので、別プロセスで確かめる。
 */
function loadConfig(env: Record<string, string>): { ok: boolean; message: string } {
  try {
    const out = execFileSync(
      "npx",
      ["tsx", "-e", 'import("./src/config.js").then((m) => console.log(m.config.maxWebSearches))'],
      { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, message: out.trim().split("\n").at(-1) ?? "" };
  } catch (err) {
    return { ok: false, message: String((err as { stderr?: string }).stderr ?? err) };
  }
}

test("MAX_WEB_SEARCHES は整数でなければ起動時に落とす", () => {
  for (const bad of ["2.5", "abc"]) {
    const r = loadConfig({ MAX_WEB_SEARCHES: bad });
    assert.equal(r.ok, false, `"${bad}" を通してはいけない`);
    assert.ok(r.message.includes("MAX_WEB_SEARCHES"), "何が悪いのかを名指しする");
  }
});

test("MAX_WEB_SEARCHES は未設定なら既定、0 なら上限なし", () => {
  assert.equal(loadConfig({ MAX_WEB_SEARCHES: "" }).message, "5", "空文字は未設定と同じ扱い");
  assert.equal(loadConfig({ MAX_WEB_SEARCHES: "0" }).message, "0", "0 は計測用の上限なし");
});
