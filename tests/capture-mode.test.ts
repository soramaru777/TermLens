import assert from "node:assert/strict";
import test from "node:test";
// public/ はビルドレスな素の JS。tsconfig.test.json の allowJs で解決している
// （tsconfig.json 側は src/ だけを見るので本番ビルドには影響しない）。
import {
  CAPTURE_MODES,
  DEFAULT_CAPTURE_MODE,
  audioConstraints,
  captureModeHint,
  captureModeLabel,
  normalizeCaptureMode,
} from "../public/capture-mode.js";

/**
 * 収音モード（#26）。
 *
 * **このファイルで一番重要なのは最初の1本。** 収音モードは `getUserMedia` の
 * constraints を差し替えるので、既定モードの値が動くと**モードを一度も触っていない
 * 利用者の文字起こしまで変わる**。ここは唯一の見張りなので、期待値は `capture-mode.js`
 * から import せず**リテラルで書く**（定義元から取ると、定義を変えたときに一緒に
 * 動いてしまい何も守らない）。
 */

// #26 以前に `public/app.js` が getUserMedia へ直接渡していた値そのもの。
// **ここを書き換えるときは、実機で文字起こしの精度を測り直すこと。**
const LEGACY_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
};

test("既定モードの constraints は #26 以前と完全に一致する（AC6）", () => {
  assert.equal(DEFAULT_CAPTURE_MODE, "meeting");
  assert.deepEqual(audioConstraints(DEFAULT_CAPTURE_MODE), LEGACY_CONSTRAINTS);
  // 未設定（localStorage が空）でも同じ値になること。既定を経由する経路は2つある
  assert.deepEqual(audioConstraints(undefined), LEGACY_CONSTRAINTS);
});

test("スピーカー収音はエコーキャンセルとノイズ抑制だけを反転させる", () => {
  const speaker = audioConstraints("speaker");
  assert.equal(speaker.echoCancellation, true);
  assert.equal(speaker.noiseSuppression, true);
  // 自動ゲインとチャンネル数はモードに依らない。ここが動くと比較実験の変数が増える
  assert.equal(speaker.autoGainControl, LEGACY_CONSTRAINTS.autoGainControl);
  assert.equal(speaker.channelCount, LEGACY_CONSTRAINTS.channelCount);
  // 2モードが同じ値だと「切り替えられる」というAC自体が空文になる
  assert.notDeepEqual(speaker, audioConstraints("meeting"));
});

test("少なくとも対面会議とスピーカー収音の2モードがある（AC1）", () => {
  const names = Object.keys(CAPTURE_MODES);
  assert.ok(names.includes("meeting"));
  assert.ok(names.includes("speaker"));
});

test("すべてのモードに label と hint と constraints がある", () => {
  for (const [name, mode] of Object.entries(CAPTURE_MODES)) {
    assert.equal(typeof mode.label, "string", `${name} の label`);
    assert.ok(mode.label.length > 0, `${name} の label が空`);
    assert.equal(typeof mode.hint, "string", `${name} の hint`);
    assert.ok(mode.hint.length > 0, `${name} の hint が空`);
    assert.equal(typeof mode.constraints, "object", `${name} の constraints`);
    // 表示名は画面のどこに出しても同じであること（ラベルの定義箇所を増やさない）
    assert.equal(captureModeLabel(name), mode.label);
    assert.equal(captureModeHint(name), mode.hint);
  }
});

test("未知のモード名は既定に倒れる", () => {
  for (const bad of ["", "unknown", "MEETING", null, undefined, 42, {}]) {
    assert.equal(normalizeCaptureMode(bad as never), DEFAULT_CAPTURE_MODE, `${String(bad)}`);
    assert.deepEqual(audioConstraints(bad as never), LEGACY_CONSTRAINTS, `${String(bad)}`);
  }
});

test("Object.prototype 由来のキーをモードとして受け付けない", () => {
  // モード名は localStorage（信頼境界の外）から来る。素の `CAPTURE_MODES[mode]` だと
  // "constructor" が truthy になり、constraints が undefined のまま getUserMedia へ渡る
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(normalizeCaptureMode(key), DEFAULT_CAPTURE_MODE, key);
    assert.deepEqual(audioConstraints(key), LEGACY_CONSTRAINTS, key);
    assert.equal(captureModeLabel(key), CAPTURE_MODES[DEFAULT_CAPTURE_MODE].label, key);
  }
});

test("audioConstraints() は毎回新しいオブジェクトを返す", () => {
  // getUserMedia の実装や呼び出し側が書き換えても、モード定義が汚れないこと。
  // 汚れると以降のセッションが**別の constraints で開く**
  const first = audioConstraints("meeting");
  first.echoCancellation = true;
  assert.deepEqual(audioConstraints("meeting"), LEGACY_CONSTRAINTS);
});
