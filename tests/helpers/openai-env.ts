// src/extract/extractor.ts と enrich.ts は、モジュール読み込み時に `new OpenAI()` を
// 評価する。API キーが無いと SDK がその場で例外を投げるため、決定的テスト（LLM を呼ばない層）
// はダミー値を入れてから対象モジュールを読み込む必要がある。
//
// 読み込み方: `package.json` の test スクリプトが
// `tsx --test --import ./tests/helpers/openai-env.ts` で注入する。
// テストファイル側の import 順に依存しないので、将来 import ソート（Prettier の
// organize-imports、eslint の import/order 等）を入れても壊れない。
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `--import` は全テストプロセスで走る。オプトインの LLM 評価（RUN_LLM_EVAL=1）は実 API を
// 叩くのが目的なので、実キーがあるならそれを残さなければならない。dotenv は既存の環境変数を
// 上書きしないため、ここでダミーを入れてしまうと後から .env を読んでも戻せない。
// だから「実キーがあるか」を .env まで見て先に確定させる。src/config.ts と同じファイルを読む。
if (process.env.RUN_LLM_EVAL === "1") {
  loadEnv({
    path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
    quiet: true,
  });
}

/**
 * 決定的テスト用のダミーキー。**これが入っている = 実 API は叩けない**。
 * `llm-eval.test.ts` は「キーがある」と誤認しないためにこの値と突き合わせる。
 */
export const DUMMY_OPENAI_KEY = "test-dummy-key-not-used";

// ダミーの代入は **キーの有無で分岐させない**。分岐させると
// `export OPENAI_API_KEY=sk-...` しているシェルでは実キーがクライアントに入り、
// 「決定的テストからは本物の API を叩けない」が条件付きの主張になってしまう。
// 例外は上記の RUN_LLM_EVAL=1 かつ実キーがある場合だけ。
if (process.env.RUN_LLM_EVAL !== "1" || !process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = DUMMY_OPENAI_KEY;
}
