import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import { client as enrichClient } from "../src/extract/enrich.js";
import type { ExtractorInput } from "../src/extract/extractor.js";
import type { ExtractedCard } from "../src/extract/schema.js";
import { card, candidate, settle, utterance } from "./helpers/cards.js";
import { verifyOutput } from "./helpers/verify.js";
import { ExtractionScheduler } from "../src/extract/scheduler.js";
import { config } from "../src/config.js";
import type { CardRename, TermCard, TermLink, TermStatus } from "../src/protocol.js";

/**
 * unresolved カードの再評価（#40）。
 *
 * **表記はすべて匿名化した合成データ。** 実会話・固有名詞・実際の誤認識語は使わない
 * （`src/eval/cases.ts` / `src/stt/mock-script.ts` と同じ方針）。ここで模しているのは
 * 「序盤に不明瞭に聞き取られた語が、後半で明瞭に登場する」という**形**だけ。
 *
 * 固定したいのは4つ。
 * 1. **昇格は web 検証を通ったものだけ** — ローカル判定は検証に回す候補を絞るだけで、
 *    それ自体では昇格させない。裏付け不足・棄却・候補外はすべて unresolved のまま
 * 2. **同じ cardId のまま改名される** — `card_update` に `rename` が載る（#38 の
 *    不変 ID があって初めて成り立つ）
 * 3. **コストに上限がある** — 無関係なら回さない / 試行回数 / cooldown / 1 run あたり /
 *    保持件数 / `verifyDisabled`
 * 4. **#25 のプライバシー原則を維持する** — 会話全文を web 検索へ送らない、
 *    用語集は絞り込み済みだけ
 *
 * 実 API は叩かない。抽出は private `extract` を、検証は `enrich.ts` の
 * `client.responses.create` を差し替える。
 */

type ExtractFn = (input: ExtractorInput) => Promise<ExtractedCard[]>;

// --- 合成の表記 -------------------------------------------------------------
//
// 「音声認識が仮名で崩した表記」と「後から明瞭に登場した用語」の対。意味は持たせない。
/** 序盤に聞き取られた崩れた表記 */
const SURFACE = "えーび";
/** 抽出段が付けた推定 term（特定できていないので画面には出ない） */
const GUESS = "エービ";
/** 後半で明瞭に登場する表記 */
const CLEAR_SURFACE = "エービー";
/** 後半で確定する用語。抽出段は候補#2 に挙げていたが、確信が持てず unresolved にした */
const RESOLVED = "AB";
/** 後半で明瞭に登場する確定カードの用語 */
const HINT_TERM = "AB Studio";

/** 再評価待ちになる unresolved カード。 */
function unresolvedCard(guess = GUESS, surface = SURFACE): ExtractedCard {
  return card(guess, {
    status: "unresolved",
    surfaceForms: [surface],
    correctedFrom: surface,
    // 候補#2 まで挙がっているが特定はできていない、という抽出段の出力を模す
    candidates: [candidate(guess), candidate(RESOLVED)],
  });
}

/** 再評価のトリガになる確定カード。`surfaceForms` が崩れた表記と音で対応する。 */
function hintCard(term = HINT_TERM, surface = CLEAR_SURFACE): ExtractedCard {
  return card(term, { surfaceForms: [surface] });
}

/** 再評価とは何の関係もない確定カード。 */
function unrelatedCard(term = "Qdrant"): ExtractedCard {
  return card(term, { surfaceForms: ["クドラント"] });
}

/** 検証の入力から候補#1 を読む。清書側は素直にこれを選ばせる。 */
function firstCandidate(input: string): string | null {
  return /^1\. (.+?)\(読み:/m.exec(input)?.[1] ?? null;
}

/**
 * 再評価の呼び出しにだけ `chosen` を仕込むモック。
 *
 * **清書（`enrichCard`）は素直に候補#1 を選ばせる。** 清書まで棄却させると、
 * 観察したい再評価のログ・更新に清書の棄却が混ざって意図が濁る。
 */
function decider(chosen: string | null) {
  return (input: string) => (input.includes(SURFACE) ? chosen : firstCandidate(input));
}

interface Update {
  cardId: string;
  status: TermStatus;
  description: string;
  links: TermLink[];
  rename: CardRename | undefined;
}

interface Harness {
  emitted: TermCard[][];
  updates: Update[];
  warnings: string[];
  errors: Array<{ message: string; permanent: boolean | undefined }>;
  /** `responses.create` に渡った入力（清書・再評価の両方） */
  verifyInputs: string[];
  /**
   * そのうち**再評価の呼び出しだけ**。
   *
   * 清書（`enrichCard`）と同じ関数を通るので、入力で見分ける。再評価は
   * 「音声認識が崩した元の表記」に unresolved カードの表記を載せるので、そこで判別できる。
   */
  rematchInputs: () => string[];
  extractInputs: ExtractorInput[];
  /** 次回以降の検証を失敗させる */
  failVerify: (err: unknown) => void;
  /** 検証を打ち切った状態にする（`verifyDisabled`） */
  disableVerify: () => void;
  /** 保持中の再評価待ち件数 */
  pendingCount: () => number;
  /** 仮想時計を進める（cooldown を跨ぐため） */
  advance: (ms: number) => void;
  send: (text: string, cards: ExtractedCard[]) => Promise<void>;
}

/**
 * `chosen` を入力から決めるモック（`scheduler-verify.test.ts` と同じ作法）。
 *
 * **時計を差し替えてある。** cooldown と試行回数は実時間に依存するので、
 * 待たずに跨げないとテストが数十秒かかるか、あるいは cooldown を確かめられない。
 */
function harness(
  t: TestContext,
  decide: (input: string) => string | null,
  glossary: string[] = [],
): Harness {
  const emitted: TermCard[][] = [];
  const updates: Update[] = [];
  const warnings: string[] = [];
  const errors: Array<{ message: string; permanent: boolean | undefined }> = [];
  const verifyInputs: string[] = [];
  const extractInputs: ExtractorInput[] = [];
  let impl: ExtractFn = async () => [];
  let verifyError: unknown = null;

  // **スケジューラを作る前に時計を差し替える。** コンストラクタが `lastRunAt` を
  // 実時刻で初期化するので、後から差し替えると発火条件のほうがずれる
  const start = Date.now();
  let offset = 0;
  const nowSpy = mock.method(Date, "now", () => start + offset);

  const createSpy = mock.method(enrichClient.responses, "create", async (body: never) => {
    const input = String((body as unknown as { input: string }).input);
    verifyInputs.push(input);
    if (verifyError) throw verifyError;
    const chosen = decide(input);
    return {
      output_text: verifyOutput({
        verification: { exists: true, fitsContext: chosen !== null, evidence: "テストの根拠" },
        chosen,
        reason: "テストの判定",
        description: "検証後の解説。",
      }),
      output: [],
    };
  });
  const warnSpy = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  t.after(() => {
    createSpy.mock.restore();
    warnSpy.mock.restore();
    nowSpy.mock.restore();
  });

  const scheduler = new ExtractionScheduler(glossary, {
    onCards: (c) => emitted.push(c),
    onCardUpdate: (cardId, status, description, links, rename) =>
      updates.push({ cardId, status, description, links, rename }),
    onExtracting: () => {},
    onError: (message, permanent) => errors.push({ message, permanent }),
  });
  t.after(() => scheduler.stop());
  (scheduler as unknown as { extract: ExtractFn }).extract = (input) => {
    extractInputs.push(input);
    return impl(input);
  };
  const internals = scheduler as unknown as {
    verifyDisabled: boolean;
    pendingUnresolved: unknown[];
  };

  return {
    emitted,
    updates,
    warnings,
    errors,
    verifyInputs,
    // 「# 音声認識が崩した元の表記」に崩れた表記が載っているものが再評価の呼び出し。
    // 清書側は確定カードの correctedFrom（このテストでは null）なので混ざらない
    rematchInputs: () => verifyInputs.filter((i) => i.includes(`元の表記\n${SURFACE}`)),
    extractInputs,
    failVerify: (err) => {
      verifyError = err;
    },
    disableVerify: () => {
      // 残高切れ・恒久エラーで検証を打ち切った状態。実際の経路（`enrichCard` の catch）を
      // 通すと onError と清書の呼び出しが混ざり、見たい不変条件が濁る
      internals.verifyDisabled = true;
    },
    pendingCount: () => internals.pendingUnresolved.length,
    advance: (ms) => {
      offset += ms;
    },
    send: async (text, cards) => {
      impl = async () => cards;
      scheduler.addUtterance(text);
      // 清書も再評価も `void` の投げっぱなしなので、解決まで見るには追加で巡回する
      await settle(6);
    },
  };
}

// --- 昇格 -------------------------------------------------------------------

/**
 * この Issue の本題。序盤に unresolved になったカードが、後半の確定用語を手がかりに
 * **同じ cardId のまま**正しい用語へ直る。
 */
test("後続の確定用語で unresolved を昇格させ、同じ cardId で改名する", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  assert.equal(h.updates.length, 0, "unresolved の速報だけでは更新は来ない");
  const cardId = h.emitted[0]![0]!.cardId;

  await h.send(utterance("B"), [hintCard()]);

  const promoted = h.updates.find((u) => u.rename);
  assert.ok(promoted, "再評価の更新が届いていない");
  assert.equal(promoted.cardId, cardId, "**cardId は不変**（#38 の識別子をそのまま使う）");
  assert.equal(promoted.status, "confirmed");
  assert.equal(promoted.description, "検証後の解説。", "解説も検証結果に差し替わる");
  assert.equal(promoted.rename?.term, RESOLVED);
  assert.equal(
    promoted.rename?.correctedFrom,
    SURFACE,
    "「音声ではこう聞こえた」を残す（あのカードが直った、と分かる手がかり）",
  );
  assert.deepEqual(
    promoted.rename?.surfaceForms,
    [SURFACE],
    "**古い表記をそのまま渡す** — 文字起こし本文は崩れた表記のまま残るため",
  );
});

test("昇格したカードは再評価待ちから外れる（同じカードを2度昇格させない）", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  assert.equal(h.pendingCount(), 1);
  await h.send(utterance("B"), [hintCard("AB1")]);
  assert.equal(h.pendingCount(), 0, "昇格後も残ると次のチャンクでもう一度検証に回る");

  // cooldown を跨いで同じ手がかりをもう一度出しても、待ち行列に居ないので回らない
  h.advance(60_000);
  await h.send(utterance("C"), [hintCard("AB2")]);
  assert.equal(h.rematchInputs().length, 1, "昇格済みのカードをもう一度検証に回している");
});

/**
 * 特定できた以上、デデュープの枠を空けておく理由が消える。
 *
 * #24 は「特定できなかった推定で枠を永久に占有させない」ために unresolved の term を
 * `shownTerms` から外していた。昇格後に載せ直さないと、後続のチャンクで
 * **同じ用語のカードがもう1枚出る**（クライアント側の統合はその後始末でしかない）。
 */
test("昇格した用語は表示済みリストに載る", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  await h.send(utterance("B"), [hintCard("AB1")]);
  await h.send(utterance("C"), []);

  const shown = h.extractInputs.at(-1)!.shownTerms;
  assert.ok(shown.includes(RESOLVED), "昇格した用語が表示済みリストに無い");
  assert.ok(!shown.includes(GUESS), "特定できなかった推定は載せないまま（#24）");
});

/**
 * **`correctedFrom` も手がかりの表記に含める**（#40）。
 *
 * ローカル判定に渡すのは「そのカードが会議で名乗りうる表記の集合」で、`term` と
 * `surfaceForms` だけでは足りない。確定カード側の `correctedFrom`（= 音声認識が崩した
 * 元の表記）こそが、未解決カードの崩れた表記と音で対応する。ここを落とすと
 * **崩れた表記どうしでしか結び付かないペアが取りこぼされる**が、例外は出ず
 * 「なぜか発火しない」形で静かに効率が落ちる。
 */
test("確定カードの correctedFrom だけが対応していても再評価に回す", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  // term も surfaceForms も未解決側と似ていない。correctedFrom だけが音で対応する
  await h.send(utterance("B"), [
    card("Zulu", { surfaceForms: ["ズールー"], correctedFrom: CLEAR_SURFACE }),
  ]);

  assert.equal(h.rematchInputs().length, 1, "correctedFrom を手がかりに使っていない");
  assert.ok(h.updates.some((u) => u.rename), "昇格まで到達していない");
});

// --- 裏付けが取れなかった場合 -----------------------------------------------

/**
 * **改名を伴わない昇格は許さない**(#40 / #24)。
 *
 * 合成候補の先頭は `normalizeCandidates()` の不変条件により**抽出段の推定 term 自身**
 * なので、検証段がそれを選び直すだけで `isResolved()` は true になる。素通しにすると
 * 「音が似た確定カードが1枚出た」ことをトリガに、**改名もせず `unresolved` →
 * `confirmed` へ格上げ**でき、#24 が塞いだ形が復活する。
 *
 * このとき term は動かないのでクライアントの Map もハイライトも変わらないが、
 * `mergeCardUpdate()` は `rename` があれば昇格させるため、見出しだけが surface form
 * から「特定できなかった推定 term」に化ける — 最も避けたい表示になる。
 */
test("検証が元の推定 term を選び直しただけなら昇格させない", async (t) => {
  // 再評価の入力に対して候補#1（= 抽出段の推定 term）を返す decider
  const h = harness(t, decider(GUESS));
  await h.send(utterance("A"), [unresolvedCard()]);
  await h.send(utterance("B"), [hintCard("AB1")]);

  assert.equal(h.rematchInputs().length, 1, "検証には回っている");
  assert.equal(h.updates.filter((u) => u.rename).length, 0, "改名なしで昇格させている");
  assert.equal(
    h.updates.some((u) => u.cardId === h.emitted[0]![0]!.cardId),
    false,
    "据え置きのはずのカードへ更新を送っている",
  );
  assert.ok(
    h.warnings.some((w) => w.includes("kept the original term")),
    "改名を伴わない昇格を弾いたことがログに残らない",
  );
});


test("web 検証が棄却したら unresolved を維持する", async (t) => {
  const h = harness(t, decider(null));
  await h.send(utterance("A"), [unresolvedCard()]);
  await h.send(utterance("B"), [hintCard("AB1")]);

  assert.equal(h.rematchInputs().length, 1, "検証には回っている");
  assert.equal(h.updates.filter((u) => u.rename).length, 0, "改名は起きない");
  assert.equal(h.pendingCount(), 1, "据え置きなので再評価待ちに残る");
  // **`card_update` そのものを送らない。** 速報は willEnrich: false で届いており
  // 「確認中」の表示は出ていないので、送っても意味のない更新が増えるだけ
  assert.equal(
    h.updates.some((u) => u.cardId === h.emitted[0]![0]!.cardId),
    false,
    "据え置きのカードへ更新を送っている",
  );
  assert.ok(
    h.warnings.some((w) => w.includes("rematch not resolved")),
    "棄却は追跡できるようログに残す",
  );
});

/**
 * **候補外の用語を確定しない**（#23 の安全思想を再評価経路でも維持する）。
 *
 * 検証段が候補集合に無い用語を返しても改名しない。ここを素通しにすると、
 * 「web 検索が思いついた別の用語」でカードの見出しが書き換わる。
 *
 * **ガードは2枚ある。** `parseVerifyOutput()` が候補外の `chosen` を
 * `rejection: "out-of-candidates"` として null に倒し、`isResolved()` が改名の直前で
 * もう一度見る。このテストが固定するのは**端から端まで通したときの結末**で、
 * どちらか一方が消えても改名は起きないのが正しい（述語そのものは `rematch.test.ts`）。
 */
test("候補外の用語が返っても確定しない", async (t) => {
  const h = harness(t, decider("まったく別の用語"));
  await h.send(utterance("A"), [unresolvedCard()]);
  await h.send(utterance("B"), [hintCard("AB1")]);

  assert.equal(h.rematchInputs().length, 1);
  assert.equal(h.updates.filter((u) => u.rename).length, 0, "候補外で改名してはいけない");
  assert.equal(h.pendingCount(), 1, "unresolved のまま");
});

test("再評価が例外で落ちても card_update は送らず、抽出も止めない", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  h.failVerify(new Error("boom"));
  await h.send(utterance("B"), [hintCard("AB1")]);

  assert.equal(h.updates.filter((u) => u.rename).length, 0);
  assert.equal(h.pendingCount(), 1, "失敗しただけなので据え置く");
});

// --- コスト制御 -------------------------------------------------------------

test("無関係な確定カードでは再評価しない（LLM を呼ぶ前にローカルで落とす）", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  await h.send(utterance("B"), [unrelatedCard()]);

  assert.equal(h.rematchInputs().length, 0, "音の対応が無い用語で検証を投げている");
  assert.equal(h.pendingCount(), 1);
});

/**
 * 同じチャンクの中では回さない。
 *
 * 抽出段は unresolved カードと確定カードを**両方見たうえで** unresolved にしている。
 * その場で再評価しても新しい材料は1つも無く、unresolved が出るたびに web 検索つきの
 * 呼び出しが1本増えるだけになる。
 */
test("同じチャンクで出た確定カードでは再評価しない", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard(), hintCard()]);

  assert.equal(h.rematchInputs().length, 0);
  assert.equal(h.pendingCount(), 1, "次のチャンク以降のトリガのために保持はする");
});

test("MAX_REMATCH_ATTEMPTS で止まる", async (t) => {
  const h = harness(t, decider(null));
  await h.send(utterance("A"), [unresolvedCard()]);

  // cooldown を跨ぎながら何度もトリガを引く。確定カードは term が違えば毎回 fresh
  for (let i = 0; i < 5; i++) {
    h.advance(config.rematchCooldownMs + 1);
    await h.send(utterance(`B${i}`), [hintCard(`AB${i}`)]);
  }

  assert.equal(
    h.rematchInputs().length,
    config.maxRematchAttempts,
    "同じ unresolved を無制限に再評価している",
  );
});

test("cooldown 中は再評価しない", async (t) => {
  const h = harness(t, decider(null));
  await h.send(utterance("A"), [unresolvedCard()]);

  await h.send(utterance("B"), [hintCard("AB1")]);
  assert.equal(h.rematchInputs().length, 1, "1回目は回る");

  h.advance(config.rematchCooldownMs - 1);
  await h.send(utterance("C"), [hintCard("AB2")]);
  assert.equal(h.rematchInputs().length, 1, "cooldown 中の連打を通している");

  h.advance(2);
  await h.send(utterance("D"), [hintCard("AB3")]);
  assert.equal(h.rematchInputs().length, 2, "cooldown を過ぎたら回る");
});

/**
 * 1 run あたりの上限。確定カードが大量に出た回でも、web 検索つきの呼び出しが
 * 一気に飛ばないようにする。この回で漏れた分は次のトリガで拾える。
 */
test("1回の run で発火する再評価には上限がある", async (t) => {
  const h = harness(t, decider(null));
  await h.send(utterance("A"), [
    unresolvedCard("エービア", "えーびあ"),
    unresolvedCard("エービイ", "えーびい"),
    unresolvedCard("エービウ", "えーびう"),
  ]);
  assert.equal(h.pendingCount(), 3);

  await h.send(utterance("B"), [hintCard("AB1")]);
  // 3件とも音では関連するが、1 run の上限で2件までに絞られる
  assert.equal(h.verifyInputs.filter((i) => i.includes("えーび")).length, 2);
});

test("MAX_PENDING_UNRESOLVED を超えたら古いほうから捨てる", async (t) => {
  const h = harness(t, decider(null));
  // 上限(20)より1枚多く積む。1チャンクに何枚出ても保持の上限は同じ
  const many = Array.from({ length: 21 }, (_, i) => unresolvedCard(`エービ${i}`, `えーび${i}`));
  await h.send(utterance("A"), many);

  assert.equal(h.pendingCount(), 20, "件数の上限が効いていない");
  h.advance(60_000);
  // 最初の1枚（捨てられたはず）だけに音で対応する確定カードを出す
  await h.send(utterance("B"), [hintCard("AB1", "えーび0")]);
  assert.equal(
    h.verifyInputs.filter((i) => i.includes("元の表記\nえーび0")).length,
    0,
    "捨てたはずのカードが再評価されている（古いほうから捨てていない）",
  );
});

/**
 * 検証を打ち切った後は再評価も回さない。
 *
 * 残高切れ・恒久エラーで `verifyDisabled` が立っているのに再評価だけ生きていると、
 * 会話が進むたびに web 検索つきの呼び出しを投げ続け、**誰にも通知されないまま課金が進む**。
 */
test("verifyDisabled なら再評価しない", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  h.disableVerify();
  await h.send(utterance("B"), [hintCard("AB1")]);

  assert.equal(h.verifyInputs.length, 0, "清書も再評価も止まる");
  assert.equal(h.pendingCount(), 1);
});

// --- プライバシー（#25 の原則を維持する） -----------------------------------

/**
 * 再評価は**既存の Stage 2 をそのまま再利用する**ので、`verifyAndEnrich()` の口が
 * 受け取れるものしか外へ出ない。それでも配線が抜けていないことは本番の経路で見る
 * （#22 で踏んだ「単体では正しい部品が、配線だけ抜けても誰も気づかない」の再来を防ぐ）。
 */
test("再評価でも用語集は関連語だけが検証段へ渡る（参加者名は渡らない）", async (t) => {
  const h = harness(t, decider(RESOLVED), [
    "AB Cloud",
    "山田太郎",
    "株式会社テスト工業",
  ]);
  await h.send(utterance("A"), [unresolvedCard()]);
  await h.send(utterance("B"), [hintCard()]);

  const input = h.rematchInputs()[0]!;
  const hints = input.split("# 用語集の関連語")[1]!.split("#")[0]!;
  assert.ok(hints.includes("AB"), "候補と一致した用語集の語が届く");
  assert.ok(!hints.includes("(なし)"), "配線が抜けると節が (なし) に落ちる");
  assert.ok(!input.includes("山田太郎"), "参加者名は web 検索へ送らない");
});

test("再評価に渡す文脈は保存した抜粋と直近の文脈だけ（会話全文は渡さない）", async (t) => {
  const h = harness(t, decider(RESOLVED));
  const a = utterance("A");
  const b = utterance("B");
  const c = utterance("C");
  // 抽出が通ったチャンクだけが ContextWindow に積まれる。A→B→C と流して
  // 「保存した抜粋(A) + 直近の文脈(A B)」ちょうどであることを見る
  await h.send(a, [unresolvedCard()]);
  await h.send(b, []);
  await h.send(c, [hintCard()]);

  // **文字数の上限では固定できない。** 構造上の最大は MAX_BUFFER_CHARS(2000) +
  // MAX_CONTEXT_CHARS(1500) = 3500 なので、「4000 未満」はどんな実装でも通る。
  // `this.context.text()` を会話全文に差し替えても落ちないため、**完全一致**で押さえる。
  //
  // 中身は `pending.context`(unresolved が出たチャンク) + `ContextWindow` の中身。
  // 後者は**抽出に成功したチャンクだけ**を上限つきで持つもので、会話全文ではない
  // (`ContextWindow` が MAX_CONTEXT_CHARS で古い順に落とす)。
  const context = h.rematchInputs()[0]!.split("# 会議での文脈(文字起こし抜粋)\n")[1]!;
  assert.equal(
    context,
    `${a}\n${a} ${b} ${c}`,
    "渡す文脈が「保存した抜粋 + ContextWindow」ちょうどでない（別経路の本文が混ざっている）",
  );
});

test("再評価の候補は保存済み候補と後続の確定用語から作る", async (t) => {
  const h = harness(t, decider(RESOLVED));
  await h.send(utterance("A"), [unresolvedCard()]);
  await h.send(utterance("B"), [hintCard()]);

  const candidates = h.rematchInputs()[0]!.split("# 候補")[1]!.split("#")[0]!;
  assert.ok(candidates.includes(GUESS), "抽出段が挙げた候補を捨てていない");
  assert.ok(candidates.includes(RESOLVED), "後続の確定用語を候補に足していない");
});
