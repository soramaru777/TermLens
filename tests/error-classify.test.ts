import assert from "node:assert/strict";
import test from "node:test";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "openai";
import { LengthFinishReasonError } from "openai/error";
import {
  isPermanent,
  isQuotaExhausted,
  isUnretryableChunk,
  toUserMessage,
} from "../src/extract/scheduler.js";

/**
 * SDK が実際に投げるのと同じ形のエラーを合成する。
 *
 * `APIError.generate(status, body, message, headers)` はレスポンス本文の `error`
 * オブジェクトから `code` / `message` を取り出し、ステータスごとの派生クラスを返す。
 * headers が undefined だと APIConnectionError になる仕様なので、HTTP エラーの合成では
 * 必ず Headers を渡す（= 実際のレスポンス経路と同じ分岐を通す）。
 */
function apiError(status: number, body: { code?: string; message: string }): APIError {
  return APIError.generate(status, { error: body }, undefined, new Headers());
}

interface Expectation {
  name: string;
  err: unknown;
  /**
   * SDK の派生クラス。合成が実経路と同じ分岐を通っていることの確認を兼ねる。
   * OpenAI の APIError 系は abstract を含みうるので抽象コンストラクタ型で受ける。
   */
  instanceOf: abstract new (...args: any[]) => unknown;
  permanent: boolean;
  message: string;
}

const cases: Expectation[] = [
  {
    name: "400 不正リクエスト",
    err: apiError(400, { code: "invalid_request_error", message: "Invalid schema for response_format." }),
    instanceOf: BadRequestError,
    permanent: true,
    message: "用語抽出のリクエストが受け付けられませんでした。",
  },
  {
    name: "401 認証失敗",
    err: apiError(401, { code: "invalid_api_key", message: "Incorrect API key provided." }),
    instanceOf: AuthenticationError,
    permanent: true,
    message: "APIキーが無効です。サーバーの設定を確認してください。",
  },
  {
    name: "403 権限不足",
    err: apiError(403, { code: "unsupported_country_region_territory", message: "Country not supported." }),
    instanceOf: PermissionDeniedError,
    permanent: true,
    message: "APIキーにこの操作の権限がありません。",
  },
  {
    name: "404 モデルが存在しない",
    err: apiError(404, { code: "model_not_found", message: "The model does not exist." }),
    instanceOf: NotFoundError,
    permanent: true,
    message: "用語抽出のモデルが見つかりません。サーバーの設定を確認してください。",
  },
  {
    name: "408 タイムアウト（SDK が再試行する）",
    // 408 に専用クラスは無く、素の APIError になる
    err: apiError(408, { message: "Request timeout." }),
    instanceOf: APIError,
    permanent: false,
    message: "用語抽出APIでエラーが発生しました (408)。",
  },
  {
    name: "409 競合（SDK が再試行する）",
    err: apiError(409, { message: "Conflict." }),
    instanceOf: ConflictError,
    permanent: false,
    message: "用語抽出APIでエラーが発生しました (409)。",
  },
  {
    name: "422 スキーマ不正",
    err: apiError(422, { message: "Unprocessable entity." }),
    instanceOf: UnprocessableEntityError,
    permanent: true,
    message: "用語抽出APIでエラーが発生しました (422)。",
  },
  {
    name: "429 残高切れ（恒久）",
    err: apiError(429, {
      code: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    }),
    instanceOf: RateLimitError,
    permanent: true,
    message: "OpenAIのクレジット残高が不足しています。コンソールで購入してください。",
  },
  {
    name: "429 通常のレート超過（一時）",
    err: apiError(429, {
      code: "rate_limit_exceeded",
      message: "Rate limit reached for requests. Please try again in 20s.",
    }),
    instanceOf: RateLimitError,
    permanent: false,
    message: "用語抽出APIでエラーが発生しました (429)。",
  },
  {
    name: "500 サーバーエラー（一時）",
    err: apiError(500, { message: "The server had an error." }),
    instanceOf: APIError,
    permanent: false,
    message: "用語抽出APIでエラーが発生しました (500)。",
  },
  {
    name: "接続エラー（status が undefined）",
    err: APIError.generate(undefined, undefined, "Connection error.", undefined),
    instanceOf: APIConnectionError,
    permanent: false,
    message: "用語抽出APIでエラーが発生しました (不明)。",
  },
];

for (const c of cases) {
  test(`エラー分類: ${c.name}`, () => {
    assert.ok(c.err instanceof c.instanceOf, `${c.name} が期待した SDK エラークラスになっていない`);
    assert.equal(isPermanent(c.err), c.permanent);
    assert.equal(toUserMessage(c.err), c.message);
  });
}

test("エラー分類: APIError 以外は一時扱いで汎用文言", () => {
  const err = new Error("Zod validation failed: cards[0].rarity");
  assert.equal(isPermanent(err), false);
  assert.equal(toUserMessage(err), "用語抽出でエラーが発生しました。");
  // 生のメッセージがブラウザまで漏れないこと（#10）
  assert.ok(!toUserMessage(err).includes("Zod"));
});

test("isQuotaExhausted: code で判定する", () => {
  assert.equal(isQuotaExhausted(apiError(429, { code: "insufficient_quota", message: "x" })), true);
  assert.equal(isQuotaExhausted(apiError(429, { code: "billing_hard_limit_reached", message: "x" })), true);
  assert.equal(isQuotaExhausted(apiError(429, { code: "rate_limit_exceeded", message: "x" })), false);
});

test("isQuotaExhausted: code が無ければメッセージで判定する", () => {
  assert.equal(isQuotaExhausted(apiError(429, { message: "You have insufficient quota." })), true);
  assert.equal(isQuotaExhausted(apiError(429, { message: "no credits remaining" })), true);
  assert.equal(isQuotaExhausted(apiError(429, { message: "check your plan and billing details" })), true);
  assert.equal(isQuotaExhausted(apiError(429, { message: "Rate limit reached. Try again in 20s." })), false);
});

test("恒久エラーだけがバッファを捨てる側に分類される", () => {
  const permanentStatuses = [400, 401, 403, 404, 422];
  const transientStatuses = [408, 409, 500, 502, 503];
  for (const status of permanentStatuses) {
    assert.equal(isPermanent(apiError(status, { message: "x" })), true, `${status} は恒久のはず`);
  }
  for (const status of transientStatuses) {
    assert.equal(isPermanent(apiError(status, { message: "x" })), false, `${status} は一時のはず`);
  }
});

/**
 * 出力長超過は「恒久」でも「一時」でもない第3の分類（#23）。
 *
 * 一時エラーに落ちると**同じ長さのチャンクを戻して再送し続ける**（確実に同じ所で切れる）。
 * かといって恒久エラーにすると会議中ずっと抽出が止まる。捨てるのはそのチャンクだけでよい。
 */
test("出力長超過はチャンク固有として分類される", () => {
  const lengthErr = new LengthFinishReasonError();
  assert.equal(isUnretryableChunk(lengthErr), true);
  // **ここが要点** — SDK 上は `APIError` ではないので既存の分類には引っかからない
  assert.equal(isPermanent(lengthErr), false, "恒久にすると抽出が丸ごと止まる");
});

test("通常の API エラーはチャンク固有ではない", () => {
  for (const status of [400, 429, 500]) {
    assert.equal(
      isUnretryableChunk(apiError(status, { message: "x" })),
      false,
      `${status} は既存の恒久/一時の分類で扱う`,
    );
  }
  assert.equal(isUnretryableChunk(new Error("boom")), false);
});
