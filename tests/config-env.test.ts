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
function loadConfig(
  env: Record<string, string>,
  key = "maxWebSearches",
): { ok: boolean; message: string } {
  try {
    const out = execFileSync(
      "npx",
      ["tsx", "-e", `import("./src/config.js").then((m) => console.log(m.config.${key}))`],
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

/**
 * 再評価のノブ（#40）。値はすべて暫定で、`REMATCH_MIN_SIMILARITY=0` の**絞り込みなし**で
 * 分布を測ってから人が決める（`MAX_WEB_SEARCHES` と同じ手順）。
 *
 * **`0` を素通しとして受け付けることがこの計測手順の前提。** ここが弾かれると、
 * 閾値を決めるための分布そのものが取れなくなる。
 */
test("REMATCH_MIN_SIMILARITY は 0..1 の実数。0 は絞り込みなし", () => {
  const key = "rematchMinSimilarity";
  assert.equal(loadConfig({ REMATCH_MIN_SIMILARITY: "" }, key).message, "0.5", "未設定は既定");
  assert.equal(loadConfig({ REMATCH_MIN_SIMILARITY: "0" }, key).message, "0", "計測用の素通し");
  assert.equal(loadConfig({ REMATCH_MIN_SIMILARITY: "0.7" }, key).message, "0.7");
});

/**
 * 範囲外は起動時に落とす。
 *
 * `REMATCH_MIN_SIMILARITY=5` はどの語も通さない設定として黙って効き、
 * **再評価が一度も発火しないまま静かに死ぬ**（例外もログも出ない）。
 */
test("REMATCH_MIN_SIMILARITY は範囲外・非数値なら起動時に落とす", () => {
  for (const bad of ["5", "-1", "abc"]) {
    const r = loadConfig({ REMATCH_MIN_SIMILARITY: bad }, "rematchMinSimilarity");
    assert.equal(r.ok, false, `"${bad}" を通してはいけない`);
    assert.ok(r.message.includes("REMATCH_MIN_SIMILARITY"), "何が悪いのかを名指しする");
  }
});

test("試行回数と cooldown は整数ノブ（既定は暫定値）", () => {
  assert.equal(loadConfig({ MAX_REMATCH_ATTEMPTS: "" }, "maxRematchAttempts").message, "2");
  assert.equal(loadConfig({ REMATCH_COOLDOWN_MS: "" }, "rematchCooldownMs").message, "30000");
  assert.equal(loadConfig({ MAX_REMATCH_ATTEMPTS: "0" }, "maxRematchAttempts").message, "0");
  const bad = loadConfig({ MAX_REMATCH_ATTEMPTS: "1.5" }, "maxRematchAttempts");
  assert.equal(bad.ok, false, "小数を通すと上限が上限として効かない");
});

/**
 * **負値は上限の無効化として黙って効く。**
 *
 * `REMATCH_COOLDOWN_MS=-1` は `now - lastAttemptAt < -1` が常に false になるので
 * cooldown が丸ごと外れるが、例外もログも出ない。`MAX_REMATCH_ATTEMPTS=-1` も同様に
 * `attempts >= -1` が最初から真になり、逆に**一度も再評価されなくなる**。
 * `REMATCH_MIN_SIMILARITY` だけ範囲を見て他が素通しなのは非対称なので入口で弾く。
 */
test("試行回数と cooldown は負値を拒む（上限が黙って外れないように）", () => {
  for (const key of ["MAX_REMATCH_ATTEMPTS", "REMATCH_COOLDOWN_MS"] as const) {
    const field = key === "MAX_REMATCH_ATTEMPTS" ? "maxRematchAttempts" : "rematchCooldownMs";
    const r = loadConfig({ [key]: "-1" }, field);
    assert.equal(r.ok, false, `${key}=-1 を通すと上限が上限として効かない`);
    assert.ok(r.message.includes(key), "何が悪いのかを名指しする");
  }
});
