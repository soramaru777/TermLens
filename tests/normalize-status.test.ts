import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  client,
  createExtractor,
  normalizeStatus,
  UNRESOLVED_DESCRIPTION,
} from "../src/extract/extractor.js";
import { card } from "./helpers/cards.js";

/**
 * `unresolved` の解説をサーバー側で定型文に差し替える（#24）。
 *
 * AC「unresolved 時に架空/別用語の説明を生成しない」を **LLM の従順さに依存せず**
 * 担保するための関数。プロンプト規則1でも「description は空文字でよい」と指示しているが、
 * 守らずに解説を書いてくると、**特定できていないのに別の用語の説明を断定的に読ませる**
 * ことになり、この Issue で防ぎたかった害がそのまま出る。
 * `filterSurfaceForms()` / `normalizeCandidates()` と同じ方針。
 */

test("unresolved の description を定型文に差し替える", () => {
  const out = normalizeStatus([
    card("Kubeflow", {
      status: "unresolved",
      description: "機械学習のワークフローを Kubernetes 上で動かす基盤です。",
      surfaceForms: ["クーベフロー"],
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.description, UNRESOLVED_DESCRIPTION);
  assert.ok(UNRESOLVED_DESCRIPTION.includes("特定できませんでした"), "文言は定型文のまま");
});

test("空文字で返ってきた unresolved も定型文で埋める", () => {
  // プロンプトの指示どおり空文字を返してきた場合。空のままだとカードの本文が
  // 消えて「解説の生成に失敗した」ようにしか見えない
  const out = normalizeStatus([
    card("？", { status: "unresolved", description: "", correctedFrom: "はてな" }),
  ]);
  assert.equal(out[0]!.description, UNRESOLVED_DESCRIPTION);
});

/**
 * 見出しに出せる材料が無い unresolved カードは落とす。
 *
 * クライアントは `surfaceForms[0] ?? correctedFrom ?? term` を見出しにするので、
 * どちらも無いと**推定した term が見出しに出る** — 「特定できませんでした」の
 * バッジ付きで誤った実在用語を断定するという、この Issue が最も避けたい形になる。
 */
test("surfaceForms も correctedFrom も無い unresolved は落とす", () => {
  const out = normalizeStatus([
    card("Grafana", { status: "unresolved", surfaceForms: [], correctedFrom: null }),
  ]);
  assert.deepEqual(out, [], "見出しに出せる材料が無いカードは利用者に何も伝えられない");
});

test("材料がどちらか片方でもあれば残す", () => {
  const bySurface = card("Grafana", {
    status: "unresolved",
    surfaceForms: ["グラファトス"],
    correctedFrom: null,
  });
  const byCorrected = card("Ansible", {
    status: "unresolved",
    surfaceForms: [],
    correctedFrom: "アンシブル",
  });
  assert.deepEqual(
    normalizeStatus([bySurface, byCorrected]).map((c) => c.term),
    ["Grafana", "Ansible"],
  );
});

test("confirmed / probable は材料が無くても落とさない", () => {
  // 落とすのは unresolved だけ。surfaceForms が空でもカードは残すという
  // `filterSurfaceForms()` の方針（ハイライトが効かないだけ）はそのまま
  const out = normalizeStatus([
    card("Kubernetes", { status: "confirmed", surfaceForms: [], correctedFrom: null }),
    card("Qdrant", { status: "probable", surfaceForms: [], correctedFrom: null }),
  ]);
  assert.equal(out.length, 2);
});

test("confirmed / probable の description は触らない", () => {
  const input = [
    card("Kubernetes", { status: "confirmed", description: "コンテナを束ねる基盤です。" }),
    card("Qdrant", { status: "probable", description: "ベクトル検索のデータベースです。" }),
  ];
  const out = normalizeStatus(input);
  assert.equal(out[0]!.description, "コンテナを束ねる基盤です。");
  assert.equal(out[1]!.description, "ベクトル検索のデータベースです。");
  // 触っていないカードは**オブジェクトごと素通し**（新しい参照を作らない）
  assert.equal(out[0], input[0]);
  assert.equal(out[1], input[1]);
});

test("description 以外のフィールドと入力配列は変えない", () => {
  const original = card("クーベルタン", {
    status: "unresolved",
    description: "架空の解説。",
    correctedFrom: "クバネテス",
    surfaceForms: ["クバネテス"],
  });
  const out = normalizeStatus([original]);
  const { description: _dropped, ...restIn } = original;
  const { description: _kept, ...restOut } = out[0]!;
  assert.deepEqual(restOut, restIn, "status も term も candidates もそのまま");
  assert.equal(original.description, "架空の解説。", "元のカードは破壊しない");
  assert.deepEqual(normalizeStatus([]), []);
});

/**
 * `extract()` の配線。
 *
 * `normalizeStatus()` が単体で正しくても、`extract()` がその戻り値を捨てていたら
 * AC は成立しない。**実 API は叩かず** `parse` だけ差し替えて固定する
 * （`surface-forms.test.ts` の配線テストと同じ作り）。
 */
test("extract() は unresolved の解説を定型文に差し替えてから返す", async () => {
  const spy = mock.method(client.chat.completions, "parse", async () => ({
    choices: [
      {
        message: {
          parsed: {
            cards: [
              card("Kubeflow", {
                status: "unresolved",
                description: "機械学習のワークフロー基盤です。",
                surfaceForms: ["クバフロー"],
              }),
              card("Kubernetes", {
                status: "confirmed",
                description: "コンテナを束ねる基盤です。",
                surfaceForms: ["クバネテス"],
              }),
            ],
          },
        },
      },
    ],
  }));
  try {
    const extract = createExtractor([]);
    const cards = await extract({
      newTranscript: "クバフローとクバネテスの話をしています。",
      shownTerms: [],
    });
    assert.equal(cards[0]!.description, UNRESOLVED_DESCRIPTION);
    assert.equal(cards[1]!.description, "コンテナを束ねる基盤です。", "他のカードは素通し");
    // 差し替えの順番も見る。normalizeStatus が先に走って surfaceForms のフィルタが
    // 後だと、定型文に差し替えたカードが上書きされる作りになりうる
    assert.deepEqual(cards[0]!.surfaceForms, ["クバフロー"]);
  } finally {
    spy.mock.restore();
  }
});
