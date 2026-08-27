import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  buildUserTurn,
  client,
  createExtractor,
  filterSurfaceForms,
} from "../src/extract/extractor.js";

/**
 * `surfaceForms` のサーバー側フィルタ（#22）。
 *
 * 文脈（`contextTranscript`）を渡し始めると、LLM が「直前の会話に出てきただけの表記」を
 * 混ぜうる。クライアントは surfaceForms で文字起こし本文をハイライトするので、
 * 本文に無い表記は当たらないか、別の箇所に誤爆する。**LLM の従順さに依存せず**
 * 落とせていることをここで固定する。
 */

/** 検証対象は surfaceForms だけなので、他フィールドは素通しの確認用に適当な値を入れる。 */
function card(term: string, surfaceForms: string[]) {
  return {
    term,
    reading: "テスト",
    description: "テスト用のカード。",
    status: "confirmed" as const,
    rarity: "rare" as const,
    correctedFrom: null,
    surfaceForms,
    candidates: [{ term, reading: "テスト", rationale: "テスト用の根拠" }],
  };
}

test("新しい文字起こしに無い表記を落とす", () => {
  const transcript = "クバネテスのポッドが再起動しています。";
  const out = filterSurfaceForms([card("Kubernetes", ["クバネテス", "Kubernetes", "K8s"])], transcript);
  assert.deepEqual(out[0]!.surfaceForms, ["クバネテス"]);
});

test("文脈にしか無い表記も落ちる（includes は新しい文字起こしだけを見る）", () => {
  const transcript = "そちらのコードを整理したいです。";
  const out = filterSurfaceForms([card("Terraform", ["テラフォーム"])], transcript);
  assert.deepEqual(out[0]!.surfaceForms, []);
});

test("surfaceForms が空になってもカード自体は残す", () => {
  const out = filterSurfaceForms([card("Grafana", ["グラファナ"])], "関係のない文字起こし。");
  assert.equal(out.length, 1, "ハイライトが効かないだけで、カードは捨てない");
  assert.equal(out[0]!.term, "Grafana");
});

test("surfaceForms 以外のフィールドは変えない", () => {
  const original = {
    ...card("RAG", ["ラグ", "RAG"]),
    status: "probable" as const,
    correctedFrom: "ラグ",
  };
  const out = filterSurfaceForms([original], "ラグの検索精度が課題です。");
  const { surfaceForms: _dropped, ...restIn } = original;
  const { surfaceForms: _kept, ...restOut } = out[0]!;
  assert.deepEqual(restOut, restIn);
  assert.deepEqual(out[0]!.surfaceForms, ["ラグ"]);
});

test("入力を破壊しない（新しい配列・新しいオブジェクトを返す）", () => {
  const input = [card("Jira", ["ジラ", "Jira"])];
  const out = filterSurfaceForms(input, "ジラに起票します。");
  assert.notEqual(out[0], input[0]);
  assert.deepEqual(input[0]!.surfaceForms, ["ジラ", "Jira"], "元のカードはそのまま");
});

test("空配列・空文字列を落とす", () => {
  assert.deepEqual(filterSurfaceForms([], "何か"), []);
  const out = filterSurfaceForms([card("Jira", [])], "ジラに起票します。");
  assert.deepEqual(out[0]!.surfaceForms, []);
  // "" は includes() が常に true になるので、明示的に弾かないと素通りする
  const empty = filterSurfaceForms([card("Jira", ["", "ジラ"])], "ジラに起票します。");
  assert.deepEqual(empty[0]!.surfaceForms, ["ジラ"]);
  // 新しい文字起こしが空なら、残る表記は無い
  const noTranscript = filterSurfaceForms([card("Jira", ["ジラ"])], "");
  assert.deepEqual(noTranscript[0]!.surfaceForms, []);
});

/**
 * user ターンの組み立て（#22）。
 *
 * `filterSurfaceForms()` と `ContextWindow` が単体で正しくても、`extract()` が
 * **それを実際に使っている**ことは別の話。文脈が LLM に届く経路をここで固定する。
 */

test("文脈・表示済み・新しい文字起こしをこの順で並べる", () => {
  const turn = buildUserTurn({
    newTranscript: "あたらしい",
    contextTranscript: "まえのかいわ",
    shownTerms: ["Kubernetes"],
  });
  assert.equal(
    turn,
    [
      "# 直前の会話(文脈。カード化の対象外)",
      "まえのかいわ",
      "",
      "# 表示済み用語リスト",
      "Kubernetes",
      "",
      "# 新しい文字起こし",
      "あたらしい",
    ].join("\n"),
  );
  assert.ok(
    turn.indexOf("まえのかいわ") < turn.indexOf("あたらしい"),
    "判断対象は末尾＝直近に置く",
  );
});

test("文脈が無ければ (なし) で埋める", () => {
  const turn = buildUserTurn({ newTranscript: "ほんぶん", shownTerms: [] });
  assert.ok(turn.includes("# 直前の会話(文脈。カード化の対象外)\n(なし)"));
  assert.ok(turn.includes("# 表示済み用語リスト\n(なし)"));
});

test("空白だけの文脈も (なし) 扱いにする", () => {
  const turn = buildUserTurn({ newTranscript: "ほんぶん", contextTranscript: "   ", shownTerms: [] });
  assert.ok(turn.includes("# 直前の会話(文脈。カード化の対象外)\n(なし)"));
});

/**
 * `extract()` の配線。
 *
 * `buildUserTurn()` と `filterSurfaceForms()` が単体で正しくても、`extract()` が
 * その戻り値を捨てていたら AC は成立しない。**実 API は叩かず** `parse` だけ差し替えて、
 * 「渡した文脈が user ターンに乗る」「フィルタ済みのカードが返る」を1本で固定する。
 */
test("extract() は文脈を user ターンに乗せ、フィルタ済みのカードを返す", async () => {
  let sent: { system: string; user: string } | undefined;
  const spy = mock.method(client.chat.completions, "parse", async (params: never) => {
    const { messages } = params as unknown as { messages: Array<{ role: string; content: string }> };
    sent = {
      system: messages.find((m) => m.role === "system")!.content,
      user: messages.find((m) => m.role === "user")!.content,
    };
    return {
      choices: [
        {
          message: {
            // 「クバネテス」は新しい文字起こしにあるが「テラフォーム」は文脈にしか無い。
            // candidates は空で返し、サーバー側で term 自身が補われることも見る
            parsed: {
              cards: [{ ...card("Kubernetes", ["クバネテス", "テラフォーム"]), candidates: [] }],
            },
          },
        },
      ],
    };
  });
  try {
    const extract = createExtractor(["Kubernetes"]);
    const cards = await extract({
      newTranscript: "クバネテスのポッドが再起動しています。",
      contextTranscript: "テラフォームで基盤を組んでいます。",
      shownTerms: [],
    });

    assert.ok(sent, "parse が呼ばれていない");
    assert.ok(sent!.user.includes("テラフォームで基盤を組んでいます。"), "文脈が user ターンに乗る");
    assert.ok(sent!.system.includes("Kubernetes"), "用語集は system 側のまま");
    assert.ok(!sent!.system.includes("テラフォームで基盤"), "可変部分が system に漏れていない");
    assert.deepEqual(
      cards[0]!.surfaceForms,
      ["クバネテス"],
      "文脈にしか無い表記は extract() の戻り値から落ちている",
    );
    assert.deepEqual(
      cards[0]!.candidates.map((c) => c.term),
      ["Kubernetes"],
      "normalizeCandidates() も extract() の中で効いている（#23 の不変条件）",
    );
  } finally {
    spy.mock.restore();
  }
});
