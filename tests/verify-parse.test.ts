import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  buildVerifyInput,
  client,
  countWebSearches,
  isVerified,
  MAX_WEB_SEARCHES,
  SYSTEM,
  searchLimit,
  normalizeVerification,
  parseVerifyOutput,
  verifyAndEnrich,
} from "../src/extract/enrich.js";
import { candidate } from "./helpers/cards.js";
import { VERIFIED, verifyOutput } from "./helpers/verify.js";

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

const CANDIDATES = [candidate("Qdrant"), candidate("Quadrant")];
const output = verifyOutput;

/**
 * SYSTEM の構造(#25)。**AC4「検証と解説の責務がコード上で区別される」の半分は
 * このプロンプトの見出しに載っている。** 案C は関数を分けずに責務だけ分ける設計なので、
 * 見出しを畳んで1節に戻す変更は AC を静かに壊す（型もテストも落ちない）。
 */
test("SYSTEM は検証と解説を別の節に書き分ける（AC4）", () => {
  assert.ok(SYSTEM.includes("## 候補の検証"), "検証の節がある");
  assert.ok(SYSTEM.includes("## 解説の作成"), "解説の節がある");
  assert.ok(
    SYSTEM.indexOf("## 候補の検証") < SYSTEM.indexOf("## 解説の作成"),
    "検証してから解説する順に書く",
  );
});

test("hard cap は soft cap より大きく、上限なしなら乗せない（AC5）", () => {
  // 同値だと API の打ち切りが先に効き、「取れなかったものとして扱う」という
  // soft cap の着地が発火する前に JSON が途切れる（＝棄却ではなく例外になる）
  assert.ok(searchLimit(5).max_tool_calls! > 5, "hard cap は soft cap より大きい");
  assert.ok(searchLimit(1).max_tool_calls! > 1);
  // 計測用の無検閲ベースライン。ここが残ると上限を外したつもりで測ることになる
  assert.deepEqual(searchLimit(0), {}, "上限なしなら max_tool_calls を送らない");
  assert.deepEqual(searchLimit(-1), {});
});

test("SYSTEM は検索回数の soft cap と関連語の使い方を指示する（AC5・AC2）", () => {
  // soft cap（モデルに自分で切り上げさせる指示）。hard cap だけだと API が応答ごと
  // 打ち切るので、「取れなかったものとして扱う」という着地が消える
  if (MAX_WEB_SEARCHES > 0) {
    assert.ok(SYSTEM.includes(`検索は多くても${MAX_WEB_SEARCHES}回まで`), "soft cap を伝える");
  } else {
    assert.ok(!SYSTEM.includes("検索は多くても"), "上限なしのときは行ごと落とす");
  }
  // ヒントを組み立てて送っておきながら使い方を書かないと、関連語は根拠として扱われない
  assert.ok(SYSTEM.includes("用語集の関連語"), "関連語の使い方を指示する");
});

test("裏付けが取れた候補を返す", () => {
  const decision = parseVerifyOutput(
    output({ chosen: "Qdrant", reason: "公式ドキュメントで確認", description: "ベクトルDB。" }),
    CANDIDATES,
  );
  assert.deepEqual(decision, {
    verification: VERIFIED,
    chosen: "Qdrant",
    rejection: null,
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
  assert.equal(decision.chosen, "Qdrant", "isVerified() の突き合わせを表記に振らせない");
});

test("読み注記付きの chosen は候補の表記へ寄せる", () => {
  // 候補一覧は `Qdrant — 読み: テスト` の形で渡しているが、モデルが読みを結合して
  // 返しても候補外にはしない(#42)。返るのは候補側の canonical な表記。
  const decision = parseVerifyOutput(output({ chosen: "Qdrant(読み: クドラント)" }), CANDIDATES);
  assert.equal(decision.chosen, "Qdrant");
  assert.equal(decision.rejection, null, "装飾が付いただけの同一用語を棄却しない");
});

test("読み注記を剥がしても候補に無い用語は候補外のまま棄却する", () => {
  // #42 は候補制約を緩めない。ここが通ると検証段を立てた意味が無くなる
  const decision = parseVerifyOutput(
    output({ chosen: "Pinecone(読み: パインコーン)", reason: "こちらのほうが自然" }),
    CANDIDATES,
  );
  assert.equal(decision.chosen, null);
  assert.equal(decision.rejection, "out-of-candidates", "棄却理由の内訳を変えない");
  assert.ok(decision.reason.includes("Pinecone"), "何が返ってきたかは追えるようにする");
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
    verification: VERIFIED,
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
  // **`verification` を欠いた応答も例外にする**（#25）。既定値で埋めて素通しにすると、
  // 判断の内訳が「常に exists: true」に化けて、棄却の原因分析ができない状態へ静かに戻る。
  assert.throws(() =>
    parseVerifyOutput(
      JSON.stringify({ chosen: "Qdrant", reason: "x", description: "y" }),
      CANDIDATES,
    ),
  );
});

/**
 * `exists` / `fitsContext` と `chosen` の整合（#25 の核心、AC3・AC4）。
 *
 * SYSTEM でも「どちらかが false のときは chosen を null にする」と指示しているが、
 * **LLM の従順さに依存しない**（`filterSurfaceForms()` / `normalizeStatus()` と同じ方針）。
 * 素通しにすると「実在が確認できていない用語」「モデル自身が文脈に合わないと言った用語」が
 * `confirmed` で表示され、web 検索が誤りを補強するという #23 以来防いできた形が戻る。
 */
test("exists が false なら chosen が入っていても棄却に倒す", () => {
  const decision = parseVerifyOutput(
    output({
      chosen: "Qdrant",
      reason: "たぶんこれ",
      verification: { exists: false, fitsContext: true, evidence: "該当なし" },
    }),
    CANDIDATES,
  );
  assert.equal(decision.chosen, null);
  assert.ok(decision.reason.includes("実在"), "棄却の内訳が理由に残る");
  assert.ok(decision.reason.includes("たぶんこれ"), "モデルの理由も捨てない");
});

test("fitsContext が false なら chosen が入っていても棄却に倒す", () => {
  const decision = parseVerifyOutput(
    output({
      chosen: "Quadrant",
      verification: { exists: true, fitsContext: false, evidence: "経営用語のページ" },
    }),
    CANDIDATES,
  );
  assert.equal(decision.chosen, null, "実在するだけでは採用しない");
  assert.ok(decision.reason.includes("文脈"), "「実在しない」と区別できる理由にする");
});

test("normalizeVerification: 整合が取れていればオブジェクトごと素通しする", () => {
  const decision = {
    verification: VERIFIED,
    chosen: "Qdrant",
    rejection: null,
    reason: "確認済み",
    description: "解説。",
  };
  assert.equal(normalizeVerification(decision), decision, "触っていないことを参照で固定する");
});

test("normalizeVerification: すでに棄却なら理由を書き換えない", () => {
  // 「候補に無い用語だったので棄却」の具体的な理由が、検証側の文言で上書きされないこと
  const decision = {
    verification: { exists: false, fitsContext: false, evidence: "" },
    chosen: null,
    rejection: "out-of-candidates" as const,
    reason: "候補に無い用語「Pinecone」が返されたため棄却しました。",
    description: "",
  };
  assert.equal(normalizeVerification(decision), decision);
});

/**
 * `isVerified()`。候補の2番目が選ばれた場合は「表示中のカードの裏付け」にはならない。
 * #38 で `card_update` は cardId ベースになったが、term を差し替える経路はまだ無いため。
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
    glossaryHints: [],
  });
  assert.ok(input.includes("1. Qdrant"));
  assert.ok(input.includes("2. Quadrant"));
  // 用語表記と読みを結合しない(#42)。`Qdrant(読み: テスト)` と描画すると、
  // 「候補として与えられた表記をそのまま入れる」に従ったモデルの応答が候補外に落ちる
  assert.ok(!input.includes("Qdrant(読み:"), "term と読みを1つの文字列にしない");
  assert.ok(input.includes("Qdrant — 読み: テスト"), "読みは別のフィールドとして渡す");
  assert.ok(input.includes("音韻が近い"), "根拠も渡す（候補ごとのスコア相当）");
  assert.ok(input.includes("クドラント"));
  assert.ok(input.indexOf("Qdrant") < input.indexOf("ベクトル検索の比較検討"));
});

test("補正なしのときは元の表記を (補正なし) と書く", () => {
  const input = buildVerifyInput({
    candidates: [candidate("スロットリング")],
    correctedFrom: null,
    context: "アラートの話です。",
    glossaryHints: [],
  });
  assert.ok(input.includes("(補正なし)"));
});

/**
 * 関連語の節（#25、AC2）。
 *
 * **入力は絞り込み済みのものしか受け取らない**（`glossaryHints`）。用語集は参加者名・
 * 社名を含む設計（`ROLE_PROMPT` 規則4）で、web 検索は**外部サービスへの送信**にあたる。
 * 絞り込みそのものは `related-glossary.test.ts`、渡す側の配線は
 * `scheduler-verify.test.ts` で固定してある。
 */
test("関連語は入力に並ぶ", () => {
  const input = buildVerifyInput({
    candidates: [candidate("Qdrant")],
    correctedFrom: "クドラント",
    context: "ベクトル検索の比較検討をしています。",
    glossaryHints: ["Qdrant"],
  });
  assert.ok(input.includes("用語集の関連語"), "節そのものが増えている");
  assert.ok(input.includes("Qdrant"), "判断材料として渡す");
});

test("関連語が無ければ (なし) と書く", () => {
  const input = buildVerifyInput({
    candidates: [candidate("Qdrant")],
    correctedFrom: null,
    context: "",
    glossaryHints: [],
  });
  assert.ok(input.includes("用語集の関連語"));
  assert.ok(input.includes("(なし)"));
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
      glossaryHints: [],
    });

    assert.ok(params, "responses.create が呼ばれていない");
    assert.deepEqual(params!.tools, [{ type: "web_search" }], "web検索を落としていない");
    assert.ok(params!.text, "構造化出力を要求していない");
    // 検索回数の hard cap（#25、AC5）。落とすと上限そのものが消える。
    // 値そのものは `searchLimit()` のテストで固定してあるので、ここは配線だけ見る
    assert.equal(params!.max_tool_calls, searchLimit(MAX_WEB_SEARCHES).max_tool_calls);
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
    assert.equal(result.searches, 1, "検索回数を計測して返す（#25 の第1段階）");
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
      verifyAndEnrich({ candidates: CANDIDATES, correctedFrom: null, context: "", glossaryHints: [] }),
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
      glossaryHints: [],
    });
    assert.equal(result.chosen, null);
    assert.equal(result.reason, "実在が確認できない");
  } finally {
    spy.mock.restore();
  }
});

/**
 * web 検索の回数の計測（#25 の第1段階）。
 *
 * **`MAX_WEB_SEARCHES` の値を人が決めるための数字**なので、数え落ちがあると判断が狂う。
 * 上限を絞りすぎると裏付けが取れず、#24 の最大リスク（過剰 unresolved）を悪化させる。
 */
test("countWebSearches: 応答に含まれる web 検索の回数を数える", () => {
  assert.equal(
    countWebSearches([
      { type: "web_search_call" },
      { type: "message" },
      { type: "web_search_call" },
      { type: "reasoning" },
      { type: "web_search_call" },
    ]),
    3,
    "複数回検索していれば件数がそのまま出る",
  );
  assert.equal(countWebSearches([{ type: "message" }]), 0, "検索していなければ 0");
  assert.equal(countWebSearches([]), 0, "output が無い応答は呼び出し側が [] にする");
});

test("verifyAndEnrich は検索回数を返す（棄却でも数える）", async () => {
  // 棄却されたカードほど検索を重ねている可能性がある。採用できたぶんだけ数えると、
  // 上限値を決めるための分布が「うまくいった側」に偏る
  const spy = mock.method(client.responses, "create", async () => ({
    output_text: output({ chosen: null, reason: "裏付けなし", description: "" }),
    output: [{ type: "web_search_call" }, { type: "web_search_call" }, { type: "message" }],
  }));
  try {
    const result = await verifyAndEnrich({
      candidates: CANDIDATES,
      correctedFrom: "クドラント",
      context: "",
      glossaryHints: [],
    });
    assert.equal(result.chosen, null);
    assert.equal(result.searches, 2);
  } finally {
    spy.mock.restore();
  }
});
