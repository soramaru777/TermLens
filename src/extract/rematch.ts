/**
 * unresolved カードの再評価に使う純関数(#40)。**依存ゼロで保つこと。**
 *
 * `normalize.ts` / `glossary.ts` と同じ扱い。`enrich.ts` / `extractor.ts` / `scheduler.ts` は
 * モジュール読み込みの時点で `new OpenAI()` を評価するので、そこから何かを取ると
 * **この純関数を確かめたいだけのテストと評価ハーネスまで API キーを要求する**。
 *
 * ここから輸入してよいのは同じく依存ゼロの `normalize.js` と、値としては定数1つしか
 * 使わない `schema.js`(読むのは zod だけで、OpenAI クライアントは作らない)まで。
 *
 * **このモジュールは昇格を決めない。** `isRelated()` は「web 検証に回す候補を絞る」だけ、
 * `isResolved()` は「検証が返した答えが候補集合の中にあるか」を見るだけで、
 * 実在確認そのものは既存の Stage 2(`verifyAndEnrich()`)が行う。
 */

import { normalizeTerm, splitWords } from "./normalize.js";
// **値として使うのは `MAX_CANDIDATES` だけ。** ここで独自の上限を定義すると、抽出段が
// 候補を切る枚数と再評価が合成する枚数が黙って食い違う(検証段の入力を小さく保つという
// 目的は両方に共通なので、定義は1箇所に置く)。`schema.js` が読み込むのは zod だけで、
// 「依存ゼロ」が防ごうとしている `new OpenAI()` は評価されない。
import { MAX_CANDIDATES, type Candidate } from "./schema.js";

/**
 * 仮名を1種類に寄せた比較用の表記を返す(#40)。
 *
 * **音声認識の崩れは仮名種別をまたぐ。** 同じ音でも回によって「エービー」「えーびー」と
 * 揺れるので、そのまま編集距離を取ると種別の違いだけで全文字が不一致になる。
 * NFKC で全角/半角を、小文字化で大文字/小文字を、カタカナ→ひらがなで仮名種別を潰す。
 *
 * **空白は落とす**(`normalizeTerm()` と同じ)。語に割った後で使う想定だが、
 * 複合語をそのまま渡されても区切りの有無で類似度が動かないようにしておく。
 */
export function toKana(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    // カタカナ(ァ〜ヶ)をひらがなへ。長音符「ー」と「・」は範囲外なのでそのまま残る
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** 編集距離(Levenshtein)。語の比較にしか使わないので素の DP で足りる。 */
function editDistance(a: string, b: string): number {
  // 1行だけ持って使い回す。語は数文字〜十数文字なので、行列を作るより読みやすさを取る
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * 正規化済み2語の類似度(0..1)。編集距離を**長いほうの長さ**で割った補数。
 *
 * 短いほうで割ると「部分文字列なら常に 1.0」になり、1文字の語が何にでも当たる。
 * 長いほうで割れば、長さの差そのものが不一致として効く。
 *
 * 両方空なら 1(区別する材料が無い)、片方だけ空なら 0。呼び出し側で空を弾く手間を
 * 増やさないためのガードで、`isRelated()` は空語を `splitWords()` の時点で落としている。
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - editDistance(a, b) / max;
}

/**
 * 類似度で比較する語の最短長(#40)。
 *
 * 1文字の語は編集距離が 0 か 1 しか取らないので、類似度は 1.0 か 0.0 のどちらかにしか
 * ならず、**閾値が意味を持たない**(どんな閾値でも「1文字どうしの完全一致」と同義になる)。
 * 完全一致の枝は長さに関係なく効くので、ここで落ちるのは「1文字の語に別の1文字が
 * 似ている」という判定だけ。
 */
const MIN_SIMILARITY_WORD_LEN = 2;

/**
 * 新しく確定した用語が、未解決カードの表記と関連しそうか(#40)。
 *
 * **これは「検証に回す候補を絞る」だけで、それ自体では昇格させない。** 最後に効くのは
 * web 検証(`verifyAndEnrich()`)なので、ここは recall 寄りでよい。逆に締めすぎると
 * **再評価が一度も発火しないまま緑になる**ほうの失敗をする。
 *
 * 判定は `splitWords()` で語に割ったうえで、**語レベルの完全一致 または 類似度 ≥ 閾値**。
 * 文字列全体で比べないのは、`normalizeTerm()` が空白を落とすぶん複合語が1本に潰れて
 * 語の境界が消えるため(#25 の `relatedGlossary()` で実際に踏んだ穴と同じ)。
 *
 * **`minSimilarity <= 0` は素通し。** 上限や閾値を入れたまま測ると、値を決めるための
 * 分布を閾値自身が壊す(`MAX_WEB_SEARCHES=0` と同じ約束)。分布計測のときは
 * `REMATCH_MIN_SIMILARITY=0` で全 unresolved を再評価に回せる。
 */
export function isRelated(
  pendingForms: string[],
  hintForms: string[],
  minSimilarity: number,
): boolean {
  if (minSimilarity <= 0) return true;
  const pending = pendingForms.flatMap((f) => splitWords(f ?? ""));
  const hints = hintForms.flatMap((f) => splitWords(f ?? ""));
  for (const p of pending) {
    const pk = toKana(p.raw);
    for (const h of hints) {
      // 完全一致は語の長さに関係なく通す。表記が同じなら音も同じなので、
      // 類似度を計算するまでもない
      if (p.key === h.key) return true;
      const hk = toKana(h.raw);
      if (pk.length < MIN_SIMILARITY_WORD_LEN || hk.length < MIN_SIMILARITY_WORD_LEN) continue;
      if (similarity(pk, hk) >= minSimilarity) return true;
    }
  }
  return false;
}

/**
 * 合成した候補に付ける根拠。モデルには「後から確定した用語」であることを伝える。
 *
 * **`mergeCandidates()` と同じファイルに置く。** 本番と評価ハーネスの両方が候補を
 * 合成するので、文言が2箇所にあると検証プロンプトの入力が黙って食い違う。
 */
export const REMATCH_RATIONALE = "後続の会話で確定した用語と表記が近い";

/**
 * 保存済みの候補に、後から確定した用語を足して検証段への入力を組み立てる(#40)。
 *
 * **足す用語は「速報段階で確定したカードの term」**であって、検証段がゼロから作る用語では
 * ない。#23 の「検証段が候補外の用語を勝手に生成しない」というガードは
 * `parseVerifyOutput()` 側にそのまま残る — あちらは*ここで渡した候補集合*の中からしか
 * `chosen` を返さない。
 *
 * 保存済み候補を**先頭に保つ**のは、抽出段が確からしい順に並べたものだから。
 * 突き合わせは `normalizeTerm()` で、`MAX_CANDIDATES` 件で切る。
 *
 * **ただし手がかりには必ず1枠を空ける。** 単純に `[...stored, ...hints]` を上限で切ると、
 * `stored` が上限ぶん埋まっている場合に**手がかりが1件も入らない**。しかも
 * `unresolved` になるのはまさに「抽出段が候補の間で決めきれなかった」カードなので、
 * **候補が埋まっている確率が最も高いのが再評価の主要ケース**という噛み合わせになる。
 * `parseVerifyOutput()` は候補集合の外から `chosen` を返さないので、そうなると
 * 後続文脈でどれだけ強く裏付けられても `isResolved()` が真にならず、
 * **昇格経路が例外もログも無しに無効化される**。
 *
 * 空けるのは1枠だけ。手がかりを優先しすぎると、抽出段が確からしい順に並べた候補
 * （正解がここに居ることも多い）を押し出してしまう。余った枠は `stored` の残りで
 * 埋め戻すので、枠は無駄にならない。
 */
export function mergeCandidates(
  stored: Candidate[],
  hints: Candidate[],
  limit = MAX_CANDIDATES,
): Candidate[] {
  const seen = new Set<string>();
  // 空文字と重複を先に落とす。**stored を先に通す**ので、同じ用語が両方にあれば
  // 抽出段側の表記が残り、手がかりは枠を消費しない
  const dedupe = (list: Candidate[]): Candidate[] => {
    const out: Candidate[] = [];
    for (const candidate of list) {
      const key = normalizeTerm(candidate.term);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    return out;
  };
  const uniqueStored = dedupe(stored);
  const uniqueHints = dedupe(hints);
  // 手がかりが1件でもあるなら、その枠を stored から取り上げる
  const reserve = Math.min(uniqueHints.length, 1);
  const storedTaken = Math.min(uniqueStored.length, Math.max(0, limit - reserve));
  const merged = uniqueStored.slice(0, storedTaken);
  for (const hint of uniqueHints) {
    if (merged.length >= limit) break;
    merged.push(hint);
  }
  // 手がかりが少なくて枠が余ったら stored の残りで埋め戻す
  for (const candidate of uniqueStored.slice(storedTaken)) {
    if (merged.length >= limit) break;
    merged.push(candidate);
  }
  return merged;
}

/**
 * ローカル判定に渡す表記を1枚のカードから集める(#40)。
 *
 * **手がかり側と未解決側で同じ関数を使う。** どちらも「そのカードが会議で名乗りうる
 * 表記の集合」で、非対称にする理由が無い。未解決側の推定 term を入れるのは、特定
 * できなかったとはいえ音声から起こした推定であり正しい用語と音韻的に近いことが多い
 * ため(ここは recall 寄りでよい — 最後に効くのは web 検証で、ローカル判定は候補を
 * 絞るだけ)。
 *
 * **`scheduler.ts` と評価ハーネスの両方がここを呼ぶ。** 以前は評価側が同じ式を
 * 書き写していて、片方から `correctedFrom` を落としても評価が緑のままだった。
 * 判定の入力が2箇所にあると、drift しても誰も気づけない。
 */
export function hintForms(card: {
  term: string;
  surfaceForms: string[];
  correctedFrom: string | null;
}): string[] {
  return [card.term, ...card.surfaceForms, ...(card.correctedFrom ? [card.correctedFrom] : [])];
}

/**
 * 再評価が候補集合のどれかを裏付けたか(#40)。
 *
 * **`isVerified()` は触らない。** あちらは「*表示中の* term が裏付けられたか」で、
 * 候補#2 が選ばれたら false(= 降格)を返すのが #24 の降格判断そのもの。一律に緩めると
 * 通常の Stage 2 の降格が壊れ、再評価とは無関係な経路で誤補正が通るようになる。
 * **広げるのは再評価経路だけ**なので、述語を別に立てる。
 *
 * `parseVerifyOutput()` が既に候補外の `chosen` を弾いているので、ここは多層防御。
 * 検証段の実装が変わっても「候補外の用語で改名する」経路を作らせないために置く。
 */
export function isResolved(chosen: string | null, candidates: Array<{ term: string }>): boolean {
  if (chosen === null) return false;
  const key = normalizeTerm(chosen);
  if (key === "") return false;
  return candidates.some((c) => normalizeTerm(c.term) === key);
}

/**
 * 昇格が**改名を伴うか**(#40)。伴わないなら昇格させない。
 *
 * **`isResolved()` だけでは #24 が塞いだ経路が開く。** 合成した候補の先頭は
 * `normalizeCandidates()` の不変条件により**抽出段の推定 term そのもの**
 * (= 特定できなかったと自分で言った表記)なので、検証段がそれを選び直すだけで
 * `isResolved()` は true になる。そのまま通すと「音が似た確定カードが1枚出た」ことを
 * トリガに、**改名もせずに `unresolved` → `confirmed` へ格上げ**できてしまう。
 * これは #24 が「unresolved は Stage 2 に回さない」で意図的に塞いだ形そのもの。
 *
 * この Issue が開けたのは「**後続の文脈で別の用語だと分かったカードを改名する**」経路
 * だけで、「同じ用語のまま自信だけ上げる」経路ではない。クライアント側の
 * `mergeCardUpdate()` が `rename` の存在でしか昇格を許さないのと同じ線引きを、
 * サーバー側でも引いておく(片側だけだと、もう一方の経路から入られる)。
 */
export function isRename(chosenTerm: string, pendingTerm: string): boolean {
  return normalizeTerm(chosenTerm) !== normalizeTerm(pendingTerm);
}

/**
 * `chosen` に対応する候補を返す。無ければ null。
 *
 * **改名の `term` / `reading` は候補側を正典にする。** モデルが返した表記ゆれをそのまま
 * 見出しにすると、`termToCardId` のキーが候補集合と食い違い、クライアントの
 * デデュープが当たらなくなる(`parseVerifyOutput()` が `chosen` を候補の表記へ寄せて
 * いるのと同じ理由)。`reading` に至っては検証段が返さないので、候補から採るしかない。
 */
export function pickCandidate(chosen: string | null, candidates: Candidate[]): Candidate | null {
  if (chosen === null) return null;
  const key = normalizeTerm(chosen);
  return candidates.find((c) => normalizeTerm(c.term) === key) ?? null;
}
