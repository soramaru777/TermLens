import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  buildVerifyInput,
  client,
  isVerified,
  parseVerifyOutput,
  verifyAndEnrich,
} from "../src/extract/enrich.js";
import type { Candidate } from "../src/extract/schema.js";

/**
 * 検証結果のパース（#23 の Stage 2）。
 *
 * 実 API で確認したとおり **web検索ツールと構造化出力は併用できる**ので、出力は JSON で
 * 返る。それでも生の `JSON.parse` では足りない。モデルはコードフェンスで包むことがあり、
 * `description` には指示に反して引用記法が混ざる（実 API の応答で観測済み）。
 *
 * いちばん効くのは **候補外の用語を採らない**こと。検証段は抽出段の誤補正を弾くために
 * あるので、ここで新しい用語を作れてしまうと独立した検証者を立てた意味が無くなる。
 */

function candidate(term: string): Candidate {
  return { term, reading: "テスト", rationale: "音韻が近い" };
}

const CANDIDATES = [candidate("Qdrant"), candidate("Quadrant")];

function output(value: {
  chosen: string | null;
  reason?: string;
  description?: string;
}): string {
  return JSON.stringify({ reason: "テスト", description: "テスト用の解説。", ...value });
}

test("裏付けが取れた候補を返す", () => {
  const decision = parseVerifyOutput(
    output({ chosen: "Qdrant", reason: "公式ドキュメントで確認", description: "ベクトルDB。" }),
    CANDIDATES,
  );
  assert.deepEqual(decision, {
    chosen: "Qdrant",
    reason: "公式ドキュメントで確認",
    description: "ベクトルDB。",
  });
});

test("chosen が null / 空文字なら棄却", () => {
  assert.equal(parseVerifyOutput(output({ chosen: null }), CANDIDATES).chosen, null);
  assert.equal(parseVerifyOutput(output({ chosen: "" }), CANDIDATES).chosen, null);
  assert.equal(parseVerifyOutput(output({ chosen: "   " }), CANDIDATES).chosen, null);
  assert.equal(
    parseVerifyOutput(output({ chosen: null, reason: "実在が確認できない" }), CANDIDATES).reason,
    "実在が確認できない",
    "棄却理由は内部記録用にそのまま残す",
  );
});

test("候補に無い用語は採らず、棄却して理由に残す", () => {
  const decision = parseVerifyOutput(
    output({ chosen: "Pinecone", reason: "こちらのほうが自然" }),
    CANDIDATES,
  );
  assert.equal(decision.chosen, null, "検証段で新しい用語を作らせない");
  assert.ok(decision.reason.includes("Pinecone"), "何が返ってきたかは追えるようにする");
  assert.ok(decision.reason.includes("こちらのほうが自然"), "モデルの理由も捨てない");
});

test("chosen の表記ゆれは候補側の表記に揃える", () => {
  const decision = parseVerifyOutput(output({ chosen: "qdrant " }), CANDIDATES);
  assert.equal(decision.chosen, "Qdrant", "card_update の term 突き合わせを表記に振らせない");
});

test("コードフェンスや前置きに包まれていても拾う", () => {
  const wrapped = "検索結果に基づきます。\n\n```json\n" + output({ chosen: "Qdrant" }) + "\n```";
  assert.equal(parseVerifyOutput(wrapped, CANDIDATES).chosen, "Qdrant");
});

test("後ろに別のオブジェクトや後書きが続いても最初の1件を拾う", () => {
  // 末尾の `}` まで舐めると2件目を巻き込んで丸ごとパースに失敗する
  const twice = output({ chosen: "Qdrant" }) + "\n" + output({ chosen: "Quadrant" });
  assert.equal(parseVerifyOutput(twice, CANDIDATES).chosen, "Qdrant", "先に返った判定を採る");

  const trailing = output({ chosen: "Qdrant" }) + "\n以上です（補足は無し）。}";
  assert.equal(parseVerifyOutput(trailing, CANDIDATES).chosen, "Qdrant");
});

test("文字列の中の括弧は数えない", () => {
  const braced = JSON.stringify({
    chosen: "Qdrant",
    reason: "本文に } と { を含む説明",
    description: 'エスケープした \\" と } を含む解説。',
  });
  assert.equal(parseVerifyOutput(braced, CANDIDATES).chosen, "Qdrant");
});

test("description の引用記法を落とし、120字で丸める", () => {
  const cited = parseVerifyOutput(
    output({ chosen: "Qdrant", description: "ベクトルDBです。 ([qdrant.tech](https://qdrant.tech/))" }),
    CANDIDATES,
  );
  assert.equal(cited.description, "ベクトルDBです。");

  const long = parseVerifyOutput(
    output({ chosen: "Qdrant", description: "あ".repeat(200) }),
    CANDIDATES,
  );
  assert.equal(long.description.length, 120);
});

test("JSON として解釈できない出力は例外にする", () => {
  // 握り潰すとドラフト解説のまま静かに終わり、検証が効いていないことに気づけない
  assert.throws(() => parseVerifyOutput("解説だけが返ってきました。", CANDIDATES));
  assert.throws(() => parseVerifyOutput("{ chosen: ", CANDIDATES));
  assert.throws(() => parseVerifyOutput("", CANDIDATES));
});

test("スキーマが合わない出力は例外にする", () => {
  assert.throws(() => parseVerifyOutput(JSON.stringify({ chosen: 1, reason: "x" }), CANDIDATES));
  assert.throws(() => parseVerifyOutput(JSON.stringify({ reason: "x" }), CANDIDATES));
});

/**
 * `isVerified()`。候補の2番目が選ばれた場合は「表示中のカードの裏付け」にはならない。
 * `card_update` は term でカードを突き合わせるので、改名する経路が無いため。
 */
test("裏付けの判定は表示中の用語に対して行う", () => {
  assert.equal(isVerified("Qdrant", "Qdrant"), true);
  assert.equal(isVerified("Qdrant", "qdrant "), true, "突き合わせは正規化キーで行う");
  assert.equal(isVerified("Qdrant", "Quadrant"), false, "候補#2 の採用は改名になるので裏付け無し");
  assert.equal(isVerified("Qdrant", null), false);
});

/** 候補が LLM に届く経路。届かなければ検証は「1候補の追認」に退化する。 */
test("候補・元の表記・文脈を入力に並べる", () => {
  const input = buildVerifyInput({
    candidates: [candidate("Qdrant"), candidate("Quadrant")],
    correctedFrom: "クドラント",
    context: "ベクトル検索の比較検討をしています。",
  });
  assert.ok(input.includes("1. Qdrant"));
  assert.ok(input.includes("2. Quadrant"));
  assert.ok(input.includes("音韻が近い"), "根拠も渡す（候補ごとのスコア相当）");
  assert.ok(input.includes("クドラント"));
  assert.ok(input.indexOf("Qdrant") < input.indexOf("ベクトル検索の比較検討"));
});

test("補正なしのときは元の表記を (補正なし) と書く", () => {
  const input = buildVerifyInput({
    candidates: [candidate("スロットリング")],
    correctedFrom: null,
    context: "アラートの話です。",
  });
  assert.ok(input.includes("(補正なし)"));
});

/**
 * `verifyAndEnrich()` の配線。**実 API は叩かず** `responses.create` だけ差し替える。
 * 「web検索ツールと構造化出力を同時に要求している」ことがこの実装の前提なので、
 * 片方が落ちたら気づけるようにここで固定する。
 */
test("verifyAndEnrich は web検索と構造化出力を同時に要求し、リンクを集める", async () => {
  let params: Record<string, unknown> | undefined;
  const spy = mock.method(client.responses, "create", async (body: never) => {
    params = body as unknown as Record<string, unknown>;
    return {
      output_text: output({ chosen: "Qdrant", description: "ベクトルDBです。" }),
      output: [
        {
          type: "message",
          content: [
            {
              annotations: [
                { type: "url_citation", url: "https://example.jp/a", title: "解説ページ" },
              ],
            },
          ],
        },
        {
          type: "web_search_call",
          results: [{ url: "https://example.com/b", title: "Docs" }],
        },
      ],
    };
  });
  try {
    const result = await verifyAndEnrich({
      candidates: CANDIDATES,
      correctedFrom: "クドラント",
      context: "ベクトル検索の比較検討をしています。",
    });

    assert.ok(params, "responses.create が呼ばれていない");
    assert.deepEqual(params!.tools, [{ type: "web_search" }], "web検索を落としていない");
    assert.ok(params!.text, "構造化出力を要求していない");
    // 検索結果そのものは `include` を付けないと応答に載らない。落とすと引用済みリンクだけに
    // 縮み、テストの deepEqual は annotations 側だけ見ていると気づけない。
    assert.deepEqual(
      params!.include,
      ["web_search_call.results"],
      "検索結果を応答に含めるよう要求している",
    );
    assert.ok(
      String(params!.input).includes("Quadrant"),
      "候補が入力に乗っている（buildVerifyInput の戻り値を捨てていない）",
    );
    assert.equal(result.chosen, "Qdrant");
    assert.equal(result.description, "ベクトルDBです。");
    assert.deepEqual(
      result.links.map((l) => l.url),
      ["https://example.jp/a", "https://example.com/b"],
      "引用済み優先の並びは従来どおり",
    );
  } finally {
    spy.mock.restore();
  }
});

test("裏付けが取れたのに解説が空なら例外にする", async () => {
  const spy = mock.method(client.responses, "create", async () => ({
    output_text: output({ chosen: "Qdrant", description: "" }),
    output: [],
  }));
  try {
    await assert.rejects(
      verifyAndEnrich({ candidates: CANDIDATES, correctedFrom: null, context: "" }),
      /要約が生成されませんでした/,
    );
  } finally {
    spy.mock.restore();
  }
});

test("棄却時は解説が空でも例外にしない（呼び出し元は表示を変えない）", async () => {
  const spy = mock.method(client.responses, "create", async () => ({
    output_text: output({ chosen: null, reason: "実在が確認できない", description: "" }),
    output: [],
  }));
  try {
    const result = await verifyAndEnrich({
      candidates: CANDIDATES,
      correctedFrom: "クドラント",
      context: "",
    });
    assert.equal(result.chosen, null);
    assert.equal(result.reason, "実在が確認できない");
  } finally {
    spy.mock.restore();
  }
});
