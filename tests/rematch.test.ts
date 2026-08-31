import assert from "node:assert/strict";
import test from "node:test";
import {
  isRelated,
  isRename,
  isResolved,
  mergeCandidates,
  pickCandidate,
  similarity,
  toKana,
} from "../src/extract/rematch.js";
import { MAX_CANDIDATES } from "../src/extract/schema.js";
import { candidate } from "./helpers/cards.js";

/**
 * unresolved カード再評価の純関数（#40）。
 *
 * **実会話・固有名詞・実際の誤認識語は使わない。** 表記はすべて合成の匿名データで、
 * 音の崩れ方だけを模したもの（`src/eval/cases.ts` と同じ方針）。
 *
 * 固定したいのは3つ。
 * 1. **絞り込みは recall 寄りでよいが、素通しにはしない** — 最後に効くのは web 検証で、
 *    ここは「検証に回す候補を絞る」だけ。ただし `REMATCH_MIN_SIMILARITY=0` は
 *    分布計測のための素通しとして意味を持つ（`MAX_WEB_SEARCHES=0` と同じ約束）
 * 2. **候補は `MAX_CANDIDATES` で切る** — 検証段への入力を小さく保つのが上限の目的
 * 3. **候補外の用語では確定しない** — #23 の安全思想を再評価経路でも維持する
 */

// --- toKana ---------------------------------------------------------------

test("カタカナはひらがなに寄せる（音声認識の崩れは仮名種別をまたぐ）", () => {
  assert.equal(toKana("エービー"), "えーびー");
  assert.equal(toKana("えーびー"), "えーびー", "元がひらがなでも同じ結果になる");
});

test("全角・大文字小文字・空白は正規化で落とす", () => {
  assert.equal(toKana("ＡＢ"), "ab");
  assert.equal(toKana("Ab"), "ab");
  assert.equal(toKana("A B"), "ab");
});

test("長音符と中黒は残す（音の長さを潰すと別語が同じ表記になる）", () => {
  assert.ok(toKana("エービー").includes("ー"));
  assert.equal(toKana("エー・ビー"), "えー・びー");
});

test("null / undefined でも落ちない（復元データが壊れていても比較は続く）", () => {
  assert.equal(toKana(undefined as unknown as string), "");
  assert.equal(toKana(null as unknown as string), "");
});

// --- similarity -----------------------------------------------------------

test("同じ語なら 1、まったく違えば 0 に近づく", () => {
  assert.equal(similarity("えーびー", "えーびー"), 1);
  assert.ok(similarity("えーびー", "しーでぃー") < 0.5);
});

test("1文字違いは長さで割った値になる", () => {
  // 「えーび」→「えーびー」は挿入1回。長いほう(4)で割るので 0.75
  assert.equal(similarity("えーび", "えーびー"), 0.75);
});

/**
 * **短いほうで割らない。** 短いほうで割ると「部分文字列なら常に 1.0」になり、
 * 短い語が長い語に片端から当たる（絞り込みが絞り込みでなくなる）。
 */
test("長さの差そのものが不一致として効く", () => {
  assert.ok(similarity("えー", "えーびーすたじお") < 0.5, "部分一致でも満点にはしない");
});

test("空文字の扱い（呼び出し側にガードを増やさないため）", () => {
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("えー", ""), 0);
});

// --- isRelated ------------------------------------------------------------

const PENDING = ["えーび"];

test("表記が近ければ関連ありと判定する", () => {
  assert.equal(isRelated(PENDING, ["エービー"], 0.5), true);
});

test("無関係な用語は関連なし", () => {
  assert.equal(isRelated(PENDING, ["ベクトル検索"], 0.5), false);
  assert.equal(isRelated(PENDING, ["しーでぃーろむ"], 0.5), false);
});

test("閾値を上げると通らなくなる（閾値が実際に効いている）", () => {
  // 「えーび」と「えーびー」の類似度は 0.75
  assert.equal(isRelated(PENDING, ["エービー"], 0.7), true);
  assert.equal(isRelated(PENDING, ["エービー"], 0.8), false);
});

/**
 * **`minSimilarity <= 0` は素通し**（#40）。
 *
 * 上限や閾値を入れたまま測ると、値を決めるための分布を閾値自身が壊す。
 * `MAX_WEB_SEARCHES=0` が「上限なし」なのと同じ約束で、これが落ちると
 * **閾値を決めるための計測手順そのものが使えなくなる**。
 */
test("閾値 0 は絞り込みなし（分布計測用）", () => {
  assert.equal(isRelated(PENDING, ["まったく無関係な語"], 0), true);
  assert.equal(isRelated([], [], 0), true, "表記が無くても素通しにする");
  assert.equal(isRelated(PENDING, ["まったく無関係な語"], -1), true, "負値も素通し扱い");
});

test("語に割ってから突き合わせる（複合語が1本に潰れない）", () => {
  // 「エービースタジオ」は1語だが、区切りがあれば語として当たる
  assert.equal(isRelated(PENDING, ["エービー スタジオ"], 0.5), true);
  assert.equal(
    isRelated(PENDING, ["エービースタジオ"], 0.5),
    false,
    "区切りの無い長い複合語は長さの差で落ちる（web 検証まで回さない）",
  );
});

test("スクリプトの変わり目でも語に割る", () => {
  // splitWords がラテン文字と日本語の間に区切りを入れる
  assert.equal(isRelated(["Zoom"], ["Zoom株式会社"], 0.5), true);
});

/**
 * 1文字の語を類似度で比べない（#40）。
 *
 * 1文字どうしの編集距離は 0 か 1 しか取らないので類似度は 1.0 か 0.0 にしかならず、
 * **閾値が意味を失う**（どんな閾値でも「1文字の完全一致」と同義になる）。
 * 完全一致の枝は長さに関係なく効くので、落ちるのは「別の1文字が似ている」判定だけ。
 */
test("1文字の語は完全一致でだけ通す", () => {
  assert.equal(isRelated(["あ"], ["い"], 0.1), false, "1文字どうしを類似度で通さない");
  assert.equal(isRelated(["あ"], ["あ"], 0.9), true, "完全一致は長さに関係なく通す");
});

test("空の表記は比較対象から落ちる", () => {
  assert.equal(isRelated([""], ["エービー"], 0.5), false);
  assert.equal(isRelated(PENDING, [""], 0.5), false);
});

// --- mergeCandidates ------------------------------------------------------

test("保存済み候補を先頭に保ち、後から確定した用語を後ろへ足す", () => {
  const merged = mergeCandidates([candidate("Alfa")], [candidate("Bravo")]);
  assert.deepEqual(merged.map((c) => c.term), ["Alfa", "Bravo"]);
});

test("MAX_CANDIDATES で切る（検証段への入力を小さく保つ）", () => {
  const merged = mergeCandidates(
    [candidate("Alfa"), candidate("Bravo")],
    [candidate("Charlie"), candidate("Delta"), candidate("Echo")],
  );
  assert.equal(merged.length, MAX_CANDIDATES);
  assert.deepEqual(
    merged.map((c) => c.term),
    ["Alfa", "Bravo", "Charlie"],
    "確からしい順（保存済みが先）を保ったまま切る",
  );
});

/**
 * **手がかりには必ず1枠を空ける。**
 *
 * 単純に `[...stored, ...hints]` を上限で切ると、`stored` が上限ぶん埋まっている場合に
 * 手がかりが1件も入らない。しかも `unresolved` になるのはまさに「抽出段が候補の間で
 * 決めきれなかった」カードなので、**候補が埋まっている確率が最も高いのが再評価の
 * 主要ケース**という噛み合わせになる。`parseVerifyOutput()` は候補集合の外から
 * `chosen` を返さないため、そうなると後続文脈でどれだけ強く裏付けられても
 * `isResolved()` が真にならず、**昇格経路が例外もログも無しに無効化される**。
 */
test("保存済み候補が上限まで埋まっていても、手がかりは必ず入る", () => {
  const merged = mergeCandidates(
    [candidate("Alfa"), candidate("Bravo"), candidate("Charlie")],
    [candidate("Delta")],
  );
  assert.equal(merged.length, MAX_CANDIDATES, "上限は超えない");
  assert.ok(
    merged.some((c) => c.term === "Delta"),
    "手がかりが1件も入っていない（再評価が発火しなくなる）",
  );
  assert.deepEqual(
    merged.map((c) => c.term),
    ["Alfa", "Bravo", "Delta"],
    "確からしい順の下位を1件譲る（先頭は保つ）",
  );
});

/** 空ける枠は1つだけ。手がかりを優先しすぎると抽出段の確からしい候補を押し出す。 */
test("手がかりが複数でも保存済み候補を押し出しすぎない", () => {
  const merged = mergeCandidates(
    [candidate("Alfa"), candidate("Bravo"), candidate("Charlie")],
    [candidate("Delta"), candidate("Echo")],
  );
  assert.deepEqual(
    merged.map((c) => c.term),
    ["Alfa", "Bravo", "Delta"],
    "手がかりに2枠以上を渡していない",
  );
});

/** 手がかりが無ければ枠を空けない（余らせると検証の材料が減るだけ）。 */
test("手がかりが無ければ保存済み候補で上限まで埋める", () => {
  const merged = mergeCandidates(
    [candidate("Alfa"), candidate("Bravo"), candidate("Charlie")],
    [],
  );
  assert.deepEqual(merged.map((c) => c.term), ["Alfa", "Bravo", "Charlie"]);
});

/** 重複で手がかりが消えたなら枠を空ける理由も消える。埋め戻して枠を無駄にしない。 */
test("手がかりが保存済みと重複したら枠は埋め戻す", () => {
  const merged = mergeCandidates(
    [candidate("Alfa"), candidate("Bravo"), candidate("Charlie")],
    [candidate("ＡＬＦＡ")],
  );
  assert.deepEqual(
    merged.map((c) => c.term),
    ["Alfa", "Bravo", "Charlie"],
    "重複で消えた手がかりのために枠を空けたままにしている",
  );
});

test("重複は normalizeTerm で落とす（同じ用語が枠を2つ食わない）", () => {
  const merged = mergeCandidates([candidate("Alfa")], [candidate("ＡＬＦＡ"), candidate("Bravo")]);
  assert.deepEqual(merged.map((c) => c.term), ["Alfa", "Bravo"]);
});

test("空の term は候補にしない", () => {
  const merged = mergeCandidates([candidate("Alfa")], [candidate("  ")]);
  assert.deepEqual(merged.map((c) => c.term), ["Alfa"]);
});

test("引数を書き換えない", () => {
  const stored = [candidate("Alfa")];
  mergeCandidates(stored, [candidate("Bravo")]);
  assert.equal(stored.length, 1);
});

// --- isResolved -----------------------------------------------------------

/**
 * **候補外の用語では確定しない**（#23 の安全思想を再評価経路でも維持する）。
 *
 * `parseVerifyOutput()` が既に弾いているので多層防御だが、検証段の実装が変わっても
 * 「候補外の用語で改名する」経路を作らせないためにここでも見る。
 */
test("候補集合の中の用語だけを確定とみなす", () => {
  const candidates = [candidate("Alfa"), candidate("Bravo")];
  assert.equal(isResolved("Alfa", candidates), true);
  assert.equal(isResolved("Bravo", candidates), true);
  assert.equal(isResolved("Charlie", candidates), false, "候補外は確定しない");
});

test("棄却（chosen が null）は確定ではない", () => {
  assert.equal(isResolved(null, [candidate("Alfa")]), false);
});

test("空文字は確定ではない（候補側にも空は入らない）", () => {
  assert.equal(isResolved("", [candidate("Alfa")]), false);
  assert.equal(isResolved("  ", [candidate("  ")]), false);
});

test("突き合わせは normalizeTerm を通す（表記ゆれを取りこぼさない）", () => {
  assert.equal(isResolved("ａｌｆａ", [candidate("Alfa")]), true);
});

test("候補が空なら何も確定しない", () => {
  assert.equal(isResolved("Alfa", []), false);
});

// --- pickCandidate --------------------------------------------------------

/**
 * 改名に使う `term` / `reading` は**候補側を正典にする**。
 *
 * モデルが返した表記ゆれをそのまま見出しにすると、`termToCardId` のキーが候補集合と
 * 食い違ってクライアントのデデュープが当たらない。`reading` は検証段が返さないので、
 * そもそも候補から採るしかない。
 */
test("chosen に対応する候補を返す（表記は候補側）", () => {
  const picked = pickCandidate("ａｌｆａ", [candidate("Alfa")]);
  assert.equal(picked?.term, "Alfa", "モデルの表記ゆれではなく候補の表記を採る");
  assert.equal(picked?.reading, "テスト", "読みは候補から採る（検証段は返さない）");
});

test("候補外・棄却では null", () => {
  assert.equal(pickCandidate("Charlie", [candidate("Alfa")]), null);
  assert.equal(pickCandidate(null, [candidate("Alfa")]), null);
});

// --- isRename -------------------------------------------------------------

/**
 * **改名を伴わない昇格は許さない**(#40 / #24)。
 *
 * 合成候補の先頭は `normalizeCandidates()` の不変条件により**抽出段の推定 term 自身**
 * (= 特定できなかったと自分で言った表記)なので、検証段がそれを選び直すだけで
 * `isResolved()` は true になる。そこで止めないと「音が似た確定カードが1枚出た」ことを
 * トリガに、改名もせず `unresolved` → `confirmed` へ格上げできてしまう —
 * #24 が「unresolved は Stage 2 に回さない」で塞いだ形そのもの。
 */
test("同じ用語のままなら改名ではない（昇格させない）", () => {
  assert.equal(isRename("Alfa", "Alfa"), false, "同一表記で昇格できてはいけない");
  assert.equal(isRename("Bravo", "Alfa"), true, "別の用語に確定したなら改名");
});

/** 突き合わせは `normalizeTerm()` と同じ土俵。表記ゆれで「別物」に化けさせない。 */
test("表記ゆれは同じ用語として扱う", () => {
  assert.equal(isRename("ａｌｆａ", "Alfa"), false, "全角/半角・大小の違いは改名ではない");
  assert.equal(isRename("Al fa", "Alfa"), false, "空白の違いは改名ではない");
});
