// 発話グループの組み立て — 同じ final の中で語の途中に入った speaker 境界の平滑化(#55)、
// 話者ラベルの揺れ(speaker jitter)の補正(#36)、
// 想定話者数を超えて検出された少数 speaker の島の補正(#48)、
// 統合先を決められなかった minor speaker の中立化(#50)、
// そして連続する同一話者の結合と、段落内の連結子の出し分け(#55)。
//
// **app.js から切り出してあるのは、Node のテストから読めるようにするため**
// (`card-status.js` / `terms-markdown.js` / `lowpass.js` と同じ理由)。app.js は
// モジュール評価の時点で `document.getElementById` を呼ぶのでテストから import できない。
// ここには DOM を触る処理を一切置かないこと。
//
// **グルーピングの定義箇所はここだけ。** 画面(`renderTranscript()`)と Markdown
// エクスポート(`buildTranscriptMarkdown()`)の両方が `groupUtterances()` を通る。
// 片方が自前でまとめ直すと、補正の効いた画面と効かないエクスポートに割れる。
//
// **raw の `finalLines` は書き換えない。** 補正はコピーの上だけで行う。localStorage に
// 保存されるのも、用語抽出(サーバー側の `UtteranceBuilder`)が見るのも常に補正前の生データで、
// あとで閾値を変えたときに保存済みのセッションが古い補正結果に固定されない。

// 話者統計の集計・想定話者数の選択肢は `speaker-stats.js` が唯一の定義箇所(#46)。
// **ここが import しても制約違反にならない**: どちらも依存ゼロ・副作用ゼロの純関数モジュールで、
// `diagnostics.js → speaker-stats.js` と同じ形。
//
// **`ratioBasis` の分岐はここには置かない。** 分母が文字数へ落ちるセッション(旧サーバー・
// #46 以前の保存データ)では補正そのものを無効にするので(`charsBasis` ゲート)、
// この先に来る統計の分母は必ず word 数になる。`speaker-stats.js` に閉じてある分岐を
// こちらで再現すると、基準を1つ足したときに直し漏れる(#46 のレビューで一度潰した形)。
import {
  collectSpeakerStats,
  definedSpeaker,
  expectedSpeakerAtLeast,
  expectedSpeakerCount,
  num,
} from "./speaker-stats.js";
// **`UNRESOLVED_SPEAKER_LABEL` はここでは import しない。** ③(#50)が立てるのは
// 「この行を通常の話者として表示しない」という印(`unresolved`)だけで、表示名は付けない。
// 文言を知るのは画面・Markdown・診断の側だけにしておくと、ラベルを変えても
// このモジュールのテスト(段落の割れ方)が一切動かない。

// ---- jitter 補正の閾値 ----
//
// **人が実機データを見てチューニングするのはこの2つだけ。** ここ以外に数値を書かないこと。
//
// 背景: Android 実機の約49分・複数話者セッションで、補正なしの `groupUtterances()` は
// 642 グループを作り、そのうち3文字以下が 255 件(約39.7%)あった。さらにその約78%は
// 「同一秒内に複数の speaker が切り替わる」箇所に含まれていた。1つの発話が話者ラベルの
// 揺れだけで細切れに表示されている。

/**
 * jitter と見なす行の最大文字数。
 *
 * 実機データの分布は 3文字以下が約39.7%、5文字以下が約53.4%。**5文字まで広げない**のは、
 * 「そうですね」「なるほど」のような**本物の短い発話が5文字前後に集中する**ため。
 * 3文字＋余白1文字の4文字を暫定値にしている。
 *
 * ここを広げても**テキストは消えない**（後述のとおり補正するのは speaker ラベルだけ）。
 * 広げすぎたときの害は「別話者の短い発話が隣の段落に混ざる」ことであって、発言の消失ではない。
 */
export const JITTER_CHAR_LIMIT = 4;

/**
 * `seq` を持たない行に対するフォールバック判定の時間窓(ミリ秒)。
 *
 * `seq`(= `finalSeq`) が全行に載っていれば「同じ final 由来か」を厳密に判定できるので
 * この窓は使わない。**使うのは #36 以前に localStorage へ保存されたセッションを
 * 復元したときだけ**（当時の行は `seq` を持たない）。
 *
 * 同じ final を分割したイベントはサーバーが同じ tick で連続送信するため、受信時刻の差は
 * 実質 0ms。窓はネットワークと JS スケジューリングの揺れを吸収するためだけのもので、
 * **意図的に狭く取っている** — 広げるほど、別の final として届いた本物の相槌
 * (Deepgram の endpointing による無音を挟む)を巻き込む。
 */
export const JITTER_WINDOW_MS = 500;

// ---- minor speaker island の閾値(#48) ----
//
// **jitter 補正(上の2つ)とは効く条件がまったく違う。** jitter は「同じ final が話者ラベルの
// 揺れで割れた」ことを `seq` で確かめてから直す局所的な補正で、想定話者数を見ない。
// こちらは**ユーザーが想定話者数を申告していて、Deepgram がそれを超える speaker を検出した
// ときにだけ**動く、セッション全体の統計に基づく補正。

/**
 * minor と見なす最大の割合(#48)。
 * **`speaker-stats.js` の `MINOR_SPEAKER_RATIO`(5%) とは別物。** あちらは
 * 「人が見て疑うべき」線で診断の警告に使う。こちらは「機械が黙って統合してよい」線。
 * 役割が違うので、名前とファイルの両方で離してある(片方を実機データで動かしたときに
 * もう片方を触ったつもりにならないため)。
 */
export const MINOR_ISLAND_MAX_RATIO = 0.03;

/**
 * 相対判定の閾値(#59)。**主要 speaker の最小割合に対する extra speaker の割合**がこれ以下なら
 * minor 候補にする。固定の絶対閾値だけだと `56.6% / 40.0% / 3.4%` のように 3% を僅かに超える
 * 偽 speaker を取りこぼす一方で、絶対閾値を広げると本物の短時間話者まで巻き込む。
 * 「主要 speaker との差が十分大きい」ことを別の経路で見るための値で、絶対判定は据え置く。
 * 実機 2 サンプル目(3.4 / 40.0 = 0.085)が通る側に置いた暫定値。
 */
export const MINOR_ISLAND_RELATIVE_MAX_RATIO = 0.1;

/**
 * 相対判定で minor にしてよい絶対割合の上限(#59)。**未満**のときだけ相対判定が成立する。
 * 相対比だけだと `70% / 10%` のような本物の短時間話者まで minor になるので、絶対の歯止めを置く。
 *
 * **`speaker-stats.js` の `MINOR_SPEAKER_RATIO`(5%) と同じ値だが別定数。** あちらは診断の
 * 「偽 speaker の可能性」の警告線で、こちらは機械が相対判定で寄せてよい上限。値を揃えてあるのは
 * 「診断が疑わない割合の speaker を機械が相対判定で寄せることはない」という関係を保つためで、
 * 定数を共有しないのは #48 と同じ理由(片方を実機データで動かしたときにもう片方を触ったつもりに
 * ならないため)。値の一致はテストで固定してあり、片方だけ動かすと意図的な判断を求められる。
 */
export const MINOR_ISLAND_RELATIVE_CAP_RATIO = 0.05;

/**
 * minor 判定の種別(#59)。**順序も含めてここが定義箇所**で、`diagnostics.js` の
 * `MINOR_KIND_LABELS` がこの順で表示名を持つ(一致はテストで固定)。外へは計画の `minorKinds` の
 * キー列として出る(⓪の `BOUNDARY_APPLIED_KINDS` と同じで、export はしない)。
 * `absolute` = 絶対閾値未満 / `relative` = 相対判定で minor / `none` = どちらでもない(対象外)。
 */
const MINOR_KINDS = Object.freeze(["absolute", "relative", "none"]);

/** 1つの island として吸収してよい最大 word 数。長い誤割り当て区間は吸収しない(#48 の将来スコープ) */
export const MINOR_ISLAND_MAX_WORDS = 20;

/** これ未満の総 word 数では主要 speaker の順位が信用できないので補正しない */
export const MIN_TOTAL_WORDS_FOR_ISLANDS = 200;

// ---- speaker boundary の閾値(#55) ----
//
// **①jitter とは効く形が違う。** jitter は「同じ final の中で、前後が同じ話者に挟まれた島」を
// 直す。こちらは「同じ final を話者で割った断片のうち、隣より極端に短いほう」を隣へ寄せる。
// `A: テキ | B: ストを確認します` のように**後ろに元の話者が戻ってこない 2 行の形**は
// 挟まれていないので①には当たらず、#52 で観測された「発話の冒頭が欠けて見える」の正体が
// これだった(文字は 1 つも落ちておらず、語の途中で段落が切れている)。

/**
 * 通常断片と見なす最大文字数(#55)。
 *
 * `JITTER_CHAR_LIMIT`(4)より 1 小さい。⓪は「前後が同じ話者に挟まれている」という証拠が
 * 1 つ少ないぶん、寄せてよい長さを狭く取る。ここを広げても**テキストは消えない**
 * (寄せるのは speaker だけ)。広げすぎたときの害は、同じ final に混ざった相手の短い相槌が
 * 隣の話者の段落へ入ること。
 */
export const BOUNDARY_FRAGMENT_CHAR_LIMIT = 3;

/**
 * 拡張断片(4〜5 文字)の上限(#57)。この長さの行は、同じ final に**これより長い本体(anchor)**が
 * あって、境目の文字種の連続性が「中」以上のときだけ寄せられる。通常断片より証拠を 1 つ多く要求する。
 * `JITTER_CHAR_LIMIT`(4)を超えるので、同じ final の中で長い同じ話者に挟まれた 4 文字の島は
 * ⓪が先に寄せ、①の出番が減る(結果の speaker は同じで矛盾しない)。
 */
export const BOUNDARY_EXTENDED_CHAR_LIMIT = 5;

/**
 * 1 つの chain / run でまとめて寄せる行の総文字数の上限(#57)。「短い語の応酬」を丸ごと
 * 隣の話者へ吸う事故を止める総量ゲート。超えたら `chainTooLong` に数える。
 */
export const BOUNDARY_CHAIN_MAX_CHARS = 8;

/**
 * 文字種の連続性(`continuity()`)を「語の途中」と認める最低の強さ(#57)。4〜5 文字の断片と
 * 句読点で閉じた行にだけ効く。表の中で最も緩い「ひらがな → ひらがな」もこの値に含まれるので、
 * 診断の `4〜5文字` の適用が不自然に多ければ、語彙より先にここを `strong` へ上げることを検討する。
 */
export const BOUNDARY_CONTINUITY_MIN = "medium";

/**
 * 「閉じた独立発話」の印になる句読点(#55)。#57 で**絶対条件ではなくなった** — 語の途中で
 * speaker が切れてその後半に句読点が付く形(`専門スキ | ルです。`)があるため、句読点で閉じた行は
 * 「直前の行との文字種の連続性」を語尾の証拠として要求する(無ければ従来どおり `punctuated`)。
 * 相槌語彙の判定はこの句読点を剥がしてから行う。
 */
export const BOUNDARY_PUNCTUATION = "。、？！?!";

/**
 * 相槌・独立短文として独立させる語彙(#55 / #57)。⓪が「同じ final の中の短い行」を隣の話者へ
 * 寄せるとき、この語だけは寄せない。**末尾の句読点を剥がして完全一致で引く**(`はい。` → `はい`)。
 *
 * ⓪の証拠は「同じ final に入っている」ことだけで、①jitter のように前後で挟まれてはいない。
 * 相手の相槌が endpointing の無音を挟まず同じ final に混ざると、証拠の上では
 * 「語の途中で切れた断片」と区別が付かない。語彙で弾くのはそのための最後のゲート。
 *
 * **`BOUNDARY_EXTENDED_CHAR_LIMIT` 以下の語だけを載せる。** それより長い語は長さのゲートで
 * 先に落ちるので、ここに書いても効かない(書くと効いているように読める)。テストで固定している。
 * 4〜5 文字の語(#57 で追加)は暫定の初期リストで、実機の診断を見て調整する。
 * ⓪の調整つまみ(文字数・総量・句読点・語彙・連続性)はすべてこの節にまとめ、他のファイルに散らさない。
 */
export const BACKCHANNEL_WORDS = Object.freeze([
  "はい",
  "ええ",
  "うん",
  "そう",
  "へえ",
  "あー",
  "えー",
  "ん",
  "はー",
  "ほう",
  "ふむ",
  "なるほど",
  "そうです",
  "そうですね",
  "はいはい",
  "了解です",
  "ですよね",
  "わかった",
  "ありがとう",
  "お疲れ様",
  // 以下はひらがなだけの頻出相槌(#57 レビュー)。文字種の表で「ひらがな → ひらがな」を「中」に
  // しているため、語彙に無いと 6 文字以上のひらがな始まりの行が同じ final にあるだけで寄ってしまう
  "うんうん",
  "そうそう",
  "たしかに",
  "ちょっと",
  "えっと",
  "えーと",
  "あのー",
]);

/** 再接続の区切り印。発話ではないので結合にも補正にも参加させない。 */
const isReconnect = (line) => line?.type === "reconnect";

/** 話者が確定している行か。`speaker` は不明なら null / undefined で来る。 */
const hasSpeaker = (line) => line != null && line.speaker != null;
/** 行のテキスト。復元データで `text` が欠けた行は空文字として扱う */
const lineText = (line) => String(line?.text ?? "");
/** 行の長さ。**素の `length`**(空白を除かない)で、①の閾値も⓪の閾値も診断の文字数もこれで測る */
const textLength = (line) => lineText(line).length;

/**
 * `line` が前後(`prev` / `next`)に挟まれた話者ラベルの揺れかどうか。
 *
 * **判定に通っても消すのは speaker ラベルの食い違いだけで、テキストは1文字も落とさない。**
 * これが「短い相槌を無条件に削除しない」を閾値の当たり外れではなく構造として満たす形。
 * 判定を外した(＝本物の相槌を jitter と誤認した)ときの害は、その相槌が隣の話者の段落に
 * 入ることだけで済む。
 */
function isSpeakerJitter(prev, line, next) {
  // 端の行は前後で挟めない
  if (!prev || !next) return false;
  // 再接続の境界は越えない(再接続後は話者番号が振り直しで、同じ番号でも別人の可能性がある)。
  //
  // **この1行は今のところ多重防御。** 区切り印は `speaker` を持たないので、下の
  // 「前後が同じ確定話者」の条件だけでも実際には落ちる（外しても現状のテストは緑のまま）。
  // それでも残しているのは、意図が「印を越えない」ことであって「印に speaker が無い」ことでは
  // ないため。印にフィールドが増えても意味が変わらない形にしておく。
  if (isReconnect(prev) || isReconnect(line) || isReconnect(next)) return false;
  // 前後が同じ話者で、真ん中だけが違う「島」であること。
  // **補正先は必ず確定した話者**。`prev.speaker` が不明なら、確定している `line.speaker` を
  // 不明で上書きすることになり情報が減る
  if (!hasSpeaker(prev)) return false;
  if (prev.speaker !== next.speaker) return false;
  if (prev.speaker === line.speaker) return false;
  // 長い発話は、話者が本当に交代したと考えるほうが自然
  if (textLength(line) > JITTER_CHAR_LIMIT) return false;
  return sameFinalish(prev, line, next);
}

/**
 * 3行が「同じ final 由来」と言えるか。
 *
 * `seq` は 1つの Deepgram Results に対して1つ振られる連番(`ServerMessage.finalSeq`)。
 * **1つの final を話者で分割した結果だけが同じ `seq` を持つ**ので、これが揃っていれば
 * 「本来1発話だったものが話者ラベルの揺れで割れた」ことがほぼ確定する。逆に、別の final
 * として届いた「はい」のような本物の相槌は `seq` が違うため絶対に吸収されない。
 *
 * 3行のうち1つでも `seq` を持たない場合だけ、受信時刻の窓で近似する(#36 以前に保存された
 * セッションの復元経路)。**`seq` が3つとも揃っているのに食い違うときは時間窓へ落とさない** —
 * 落とすと厳密な判定を緩い判定で上書きすることになる。
 */
function sameFinalish(prev, line, next) {
  const seqs = [prev.seq, line.seq, next.seq];
  if (seqs.every((s) => typeof s === "number")) {
    return seqs[0] === seqs[1] && seqs[1] === seqs[2];
  }
  const ts = [prev.t, line.t, next.t];
  if (!ts.every((t) => typeof t === "number")) return false;
  return (
    Math.abs(ts[1] - ts[0]) <= JITTER_WINDOW_MS && Math.abs(ts[2] - ts[1]) <= JITTER_WINDOW_MS
  );
}

/**
 * 話者ラベルの揺れを補正した**コピー**を返す。引数の配列と要素は変更しない。
 *
 * **何も削除しない。** 直すのは `speaker` だけで、テキストも行数も入力のまま。jitter と
 * 判定された行は前後と同じ話者になり、結果として `mergeSameSpeaker()` で同じ段落に入る。
 *
 * 走査は左から順で、**補正済みの結果を次の判定に使う**。`A → B(短) → A → C(短) → A` は
 * B を A に直した時点で「C の直前は A」になるため、そのまま1パスで畳める。
 *
 * **1パスで足りる**（再走査のループは持たない）。補正は `out[i].speaker = out[i-1].speaker`
 * なので、i を直したことで i-1 の判定が新たに成立することはあり得ない — 成立には
 * 「前後が同じ話者で真ん中だけ違う」が要るが、補正後の i は i-1 と同じ話者になるため。
 * 後ろ向きの波及だけを気にすればよく、それは同じパスの中で処理されている。
 */
export function smoothSpeakerJitter(lines) {
  const out = lines.map((line) => ({ ...line }));
  for (let i = 1; i < out.length - 1; i++) {
    const prev = out[i - 1];
    const line = out[i];
    if (!isSpeakerJitter(prev, line, out[i + 1])) continue;
    line.speaker = prev.speaker;
  }
  return out;
}

// ---- 第0段: 同じ final の中で語の途中に入った speaker 境界の平滑化(#55 / #57) ----
//
// 補正するのは speaker ラベルだけで、テキストも行数も変えない(#36 と同じ規律)。
// **別の final は絶対に跨がない。** 別の final として届いた「はい」(endpointing の無音を
// 挟んだ本物の相槌)は `seq` が違うので、①と同じ理由で構造的に吸収されない。
//
// #57 で判定の単位を「1 行」から「同じ final の中で連続する短い行の run(chain)」に変えた。
// 判定は 2 段で、(a) が成立すれば (b) は走らない。
//
//   (a) `BOUNDARY_EXTENDED_CHAR_LIMIT` より長い行を anchor とし、その間の chain をまとめて判定する。
//       4〜5 文字の行(拡張断片)も chain の一員 = 寄せられる側になる
//   (b) (a) で寄せ先が決まらなければ、4 文字以上の行を本体・3 文字以下の行だけを断片とする
//       #55 の規則に落とす。断片の連鎖(run)はまとめて寄せる
//
// (a) は「6 文字以上の本体が同じ final にある」という #55 より強い証拠を要求しているので、
// 両者の結果が食い違う形(`A長 | B:4〜5文字 | A:短`)では (a) を優先する。(b) を残すのは
// **4〜5 文字の行を一律に断片にすると #55 で本体だった行が断片になる**ため — `今日は | 晴れですね`
// のような「短い断片 + 4〜5 文字の本体」は (b) で従来どおり寄る。

/** 理由キーの列から 0 埋めの内訳を作る。②③⓪の「0 でも必ず全キーを出す」を 1 か所で満たす */
const zeroCounts = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));

/**
 * ⓪が見送った理由のキー。**順序も含めてここが定義箇所**(②の `emptySkipped()` と同じ流儀で、
 * 表示名は `diagnostics.js` が持つ)。表示名の表がこの列と一致することはテストで固定する —
 * 理由を足して表示名を付け忘れると、その件数が診断から黙って消えるため。
 *
 * **既存のキーは改名しない**(#57)。過去セッションの診断 Markdown と件数を比べられなくなる。
 *
 * - `ambiguous` … 両側の anchor が別 speaker で、chain が「既に割れている」形でもない
 * - `unresolvedChain` … 両側に寄せ先が無い run(隣がすべて断片、または final の全体が断片)。
 *   #55 の `shortNeighbor` を置き換えた(断片の連鎖は run として判定するので「隣も断片」は理由にならない)
 * - `chainTooLong` … 寄せる行の総文字数が `BOUNDARY_CHAIN_MAX_CHARS` を超えた
 * - `weakContinuity` … 4〜5 文字の断片で、境目の文字種の連続性が「中」に届かない
 * - `punctuated` … 句読点で閉じていて、前の語の続きである証拠(直前との連続性)が無い
 * - `backchannel` … 相槌・独立短文の語彙(句読点を剥がして一致)
 * - `differentFinal` … 隣が別の final
 * - `boundary` … 隣が再接続の印
 * - `unknown` … 断片自身か隣の speaker が不明
 * - `noSeq` … `seq` の無い旧セッションの行
 *
 * 内訳は「閾値と語彙を決める唯一の材料」。理由ごとの読み方は Wiki(`termlens-stt-pipeline` の
 * ⓪の節)に 1 か所だけ書く。
 */
const BOUNDARY_SKIP_REASONS = [
  "ambiguous",
  "unresolvedChain",
  "chainTooLong",
  "weakContinuity",
  "punctuated",
  "backchannel",
  "differentFinal",
  "boundary",
  "unknown",
  "noSeq",
];
const emptyBoundarySkipped = () => zeroCounts(BOUNDARY_SKIP_REASONS);

/**
 * 行の段(tier)。**空文字は断片ではない**(寄せる文字が無い。`split.ts` は空を送らないので
 * 復元データだけの経路だが、`chars: 0` の適用が診断に載ると読めない)。
 *
 * - `0` … 対象外(`BOUNDARY_EXTENDED_CHAR_LIMIT` より長い / 空 / 再接続の印)。(a) の anchor
 * - `1` … 通常断片(`BOUNDARY_FRAGMENT_CHAR_LIMIT` 以下)。(a)(b) どちらでも寄せられる側
 * - `2` … 拡張断片(4〜5 文字)。(a) では寄せられる側、(b) では本体(寄せ先)
 */
function fragmentTier(line) {
  if (line == null || isReconnect(line)) return 0;
  const n = textLength(line);
  if (n === 0) return 0;
  if (n <= BOUNDARY_FRAGMENT_CHAR_LIMIT) return 1;
  return n <= BOUNDARY_EXTENDED_CHAR_LIMIT ? 2 : 0;
}

/**
 * 同じ final か。`seq` の無い行(#36 以前に保存されたセッション)は「同じ final」を確かめられない
 * ので、何とも同じ final にならない。時間窓へは落とさない — ⓪は挟まれていない分、①より弱い
 * 証拠で動くため、緩い判定に落とすと本物の相槌を寄せる側へ倒れる。
 */
const sameSeq = (a, b) => typeof a === "number" && a === b;
/** 隣 `n` が同じ final の発話行か(再接続の印と別 `seq` は隣として数えない)。(a) の anchor と内容ゲートの共通の述語 */
const sameFinalNeighbor = (n, seq) => n != null && !isReconnect(n) && sameSeq(seq, n.seq);

const isPunctuated = (text) => text.length > 0 && BOUNDARY_PUNCTUATION.includes(text.at(-1));
/** 末尾の句読点を**すべて**剥がす(`はい。` → `はい`、`ね？！` → `ね`) */
function stripTrailingPunctuation(text) {
  let s = text;
  while (s.length > 0 && BOUNDARY_PUNCTUATION.includes(s.at(-1))) s = s.slice(0, -1);
  return s;
}
/**
 * 相槌・独立短文の語彙に当たるか。**句読点を剥がしてから引く**(#57)。#55 は `text` の完全一致
 * だったので `はい。` は語彙では弾けず、句読点ゲートに依存していた。句読点を絶対条件から
 * 外した今、語彙が先に効かないと `A: 進めます。 | B: はい。 | A: 次です。` の `はい。` が寄る。
 */
const isBackchannel = (text) => BACKCHANNEL_WORDS.includes(stripTrailingPunctuation(text));

/**
 * 文字種。境界をまたぐ 2 文字の組み合わせから「語の途中で切れた確度」を出すためのもので、
 * 辞書は使わない。範囲は Unicode のブロックで引く(長音「ー」はカタカナのブロック内、
 * 「々」は漢字扱い)。`BOUNDARY_PUNCTUATION` と空白は `punct`。
 */
function charClass(ch) {
  if (!ch) return "none";
  if (BOUNDARY_PUNCTUATION.includes(ch) || /\s/.test(ch)) return "punct";
  const code = ch.codePointAt(0);
  if (code >= 0x3040 && code <= 0x309f) return "hiragana";
  if ((code >= 0x30a0 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) return "katakana";
  if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || ch === "々") {
    return "kanji";
  }
  if (/[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/.test(ch)) return "latin";
  return "other";
}

const CONTINUITY_RANK = Object.freeze({ none: 0, weak: 1, medium: 2, strong: 3 });

/**
 * 文字列の端の 1 文字(コードポイント単位。空なら `""`)。`String#at` は UTF-16 コード単位なので、
 * サロゲートペアの漢字(CJK 拡張 B 以降)が孤立サロゲートになって `other`(= 弱)に落ちる。
 * `[...text]` で全文を展開しない — 隣は長い anchor で、要るのは端の 1 文字だけ。
 */
const firstChar = (s) => (s.length === 0 ? "" : String.fromCodePoint(s.codePointAt(0)));
function lastChar(s) {
  if (s.length === 0) return "";
  const lo = s.charCodeAt(s.length - 1);
  const isPair = lo >= 0xdc00 && lo <= 0xdfff && s.length >= 2 && (s.charCodeAt(s.length - 2) & 0xfc00) === 0xd800;
  return s.slice(isPair ? -2 : -1);
}

/**
 * `prevText` の末尾と `nextText` の先頭の文字種から、境目が「語の途中」である強さを返す(#57)。
 *
 * | 前の末尾 → 後の先頭 | 強さ |
 * |---|---|
 * | カタカナ → カタカナ / 漢字 → 漢字 / 英数 → 英数 | `strong`(`スキ｜ル`、`専｜門`) |
 * | 漢字 → ひらがな / ひらがな → ひらがな | `medium`(送り仮名・助詞。`始｜めていた`、`な｜ので`) |
 * | ひらがな → 漢字 など上記以外 | `weak`(助詞 → 名詞は典型的な語境界。`です｜了解`) |
 * | どちらかが句読点・空白・空 | `none` |
 *
 * 通常断片(3 文字以下)にはこのゲートを掛けない(#55 の挙動を変えない)。掛けるのは拡張断片と
 * 句読点で閉じた行だけ。表は日本語前提で、英数は 1 クラスにまとめているだけ。
 */
export function continuity(prevText, nextText) {
  const a = charClass(lastChar(String(prevText ?? "")));
  const b = charClass(firstChar(String(nextText ?? "")));
  if (a === "none" || b === "none" || a === "punct" || b === "punct") return "none";
  if (a === b && (a === "katakana" || a === "kanji" || a === "latin")) return "strong";
  if ((a === "kanji" || a === "hiragana") && b === "hiragana") return "medium";
  return "weak";
}
const continuityOk = (level) => CONTINUITY_RANK[level] >= CONTINUITY_RANK[BOUNDARY_CONTINUITY_MIN];

/**
 * 候補行 `k` の内容ゲート。通れば `null`、落ちれば理由キー。
 *
 * 判定順は 語彙 → 句読点 → 文字種。**語彙を最初に見る**のは、`はい。` のように句読点付きの
 * 相槌を「句読点で閉じている」ではなく「相槌語彙」に数えるため(語彙リストを調整する材料は
 * 「語彙が無ければ寄っていた」数でなければならない)。
 *
 * - 句読点で閉じた行: **直前の行との境目**が中以上で、直前の行が句読点で閉じていなければ通る。
 *   「次の行との境目」は見ない — 句読点で閉じた行の後ろに続く語は無い
 * - 拡張断片(4〜5 文字): 前後どちらかの境目が中以上なら通る(前後は同じ final の行に限る。
 *   chain の中の行でも anchor でもよい)
 * - 通常断片で句読点の無い行: 文字種は見ない(#55 と同じ)
 */
function contentGate(out, k, seq) {
  const text = lineText(out[k]);
  if (isBackchannel(text)) return "backchannel";
  const neighborText = (n) => (sameFinalNeighbor(n, seq) ? lineText(n) : null);
  const prevText = neighborText(out[k - 1]);
  if (isPunctuated(text)) {
    const tail =
      prevText != null && !isPunctuated(prevText) && continuityOk(continuity(prevText, text));
    return tail ? null : "punctuated";
  }
  if (fragmentTier(out[k]) === 2) {
    const nextText = neighborText(out[k + 1]);
    const ok =
      (prevText != null && continuityOk(continuity(prevText, text))) ||
      (nextText != null && continuityOk(continuity(text, nextText)));
    if (!ok) return "weakContinuity";
  }
  return null;
}

/**
 * 寄せた行の種別(#57)。**1 行 1 種類で、リスクの高い規則から優先して付ける** —
 * 句読点を緩めた規則 → 4〜5 文字を対象にした規則 → 連鎖をまとめた規則 → #55 相当。
 * 「どの新しい規則が寄せたか」を診断で見るための分類なので、危ない規則ほど上に置く。
 */
function appliedKind(line, groupSize) {
  if (isPunctuated(lineText(line))) return "punctuated";
  if (fragmentTier(line) === 2) return "extended";
  return groupSize >= 2 ? "chain" : "basic";
}
/**
 * 種別のキー。**順序も含めてここが定義箇所**(`BOUNDARY_SKIP_REASONS` と同じ流儀で、表示名は
 * `diagnostics.js` の `BOUNDARY_KIND_LABELS`)。計画の `kinds` にこの順で 0 埋めの件数を出し、
 * 表示名の表がこの列と一致することはテストで固定する。
 */
const BOUNDARY_APPLIED_KINDS = ["basic", "extended", "punctuated", "chain"];

/** (a) の anchor: 同じ final で speaker が確定した、テキストのある行。無ければ `null` */
function anchorSpeaker(n, seq) {
  if (!sameFinalNeighbor(n, seq) || !hasSpeaker(n) || textLength(n) === 0) return null;
  return n.speaker;
}

// ---- (a)(b) 共通: 寄せ先が決まった後の「候補 → 総量 → 内容ゲート → 適用」 ----
//
// 判定順(総量 → 内容)と「全部か無しか」の持ち主はここ 1 か所。(a) と (b) の違いは
// **落ちた行のどれを数えるか**だけなので、それは呼び出し側に残す。

/** `[s, e]` の中で寄せ先 `to` と speaker が異なる行(= 動かす候補)の添字 */
function movers(out, s, e, to) {
  const candidates = [];
  for (let k = s; k <= e; k++) if (out[k].speaker !== to) candidates.push(k);
  return candidates;
}

/**
 * 候補行を総量 → 内容ゲートに掛ける。通れば `null`、落ちれば `[k, reason]` の列
 * (総量超過は候補の全行が `chainTooLong`)。**1 行でも落ちたら全体を寄せない**(部分的に寄せると
 * chain の途中で speaker が入れ替わり、観測より複雑な形を作る)。
 */
function gateFailures(out, candidates, seq) {
  const chars = candidates.reduce((n, k) => n + textLength(out[k]), 0);
  if (chars > BOUNDARY_CHAIN_MAX_CHARS) return candidates.map((k) => [k, "chainTooLong"]);
  const failed = candidates.map((k) => [k, contentGate(out, k, seq)]).filter(([, r]) => r != null);
  return failed.length > 0 ? failed : null;
}

/** 候補行をすべて `to` へ寄せる。`kind` は候補の本数で決まる(2 本以上なら `chain`) */
function applyAll(out, candidates, to, apply) {
  for (const k of candidates) apply(k, to, appliedKind(out[k], candidates.length));
}

/**
 * (a) 長い anchor による chain の判定。**chain の外側の同じ final の行は tier 0 なので、
 * 隣にあれば必ず anchor の長さ**(chain は tier > 0 の極大 run)。
 *
 * 戻り値は「この chain の判定を終えたか」。`true` なら (b) は走らない(寄せた / 既に割れていて
 * 何もしない)。`false` なら (b) に落とす(anchor が無い / 両側が別 speaker / 総量超過 /
 * 内容ゲートで落ちた)。
 *
 * **両側の anchor が別 speaker でも、chain が先頭から左の speaker・途中から右の speaker と
 * 単調に並んでいれば「既に割れている」**(#55 の「同じ話者の本体に接している断片は対象外」の
 * 一般化)。各行は自分の本体に接しているので何もしないし見送りにも数えない。
 *
 * 内容ゲートは **全部か無しか**。1 行でも落ちたら chain 全体を寄せない(部分的に寄せると chain の
 * 途中で speaker が入れ替わり、観測より複雑な形を作る)。落ちた行のうち **拡張断片と句読点付きの
 * 行だけ**ここで数える — 通常断片は (b) が改めて判定して数えるので、1 行を 2 度数えない。
 * 拡張断片を数えるのは (a) の候補になったときだけ((b) では本体側)。数えないと
 * 「4〜5 文字の行の大半が見送り」になって内訳が読めなくなる(#55 で長い行を数えない理由と同じ)。
 */
function resolveByAnchors(out, start, end, skip, apply) {
  const seq = out[start].seq;
  if (typeof seq !== "number") return false;
  for (let k = start; k <= end; k++) if (!hasSpeaker(out[k])) return false;
  const left = anchorSpeaker(out[start - 1], seq);
  const right = anchorSpeaker(out[end + 1], seq);
  if (left == null && right == null) return false;
  if (left != null && right != null && left !== right) {
    let k = start;
    while (k <= end && out[k].speaker === left) k++;
    while (k <= end && out[k].speaker === right) k++;
    return k > end;
  }
  const to = left ?? right;
  const candidates = movers(out, start, end, to);
  if (candidates.length === 0) return true;
  const failed = gateFailures(out, candidates, seq);
  if (failed) {
    // 数えるのは拡張断片と、内容ゲートで落ちた句読点付きの行だけ。通常断片は (b) が改めて判定して
    // 数える(総量超過の通常断片も (b) の run の総量で数え直す)
    for (const [k, reason] of failed) {
      const counted = fragmentTier(out[k]) === 2 || (reason !== "chainTooLong" && isPunctuated(lineText(out[k])));
      if (counted) skip(reason, k);
    }
    return false;
  }
  applyAll(out, candidates, to, apply);
  return true;
}

/** `classifyNeighbor()` の戻り値: 同じ final の同じ話者の本体に接している(断片はその一部) */
const ANCHOR = Object.freeze({ anchor: true });

/**
 * (b) で run の端 `line` から見た隣 `n` を 1 つ分類する。#55 の規則そのもので、
 * 「本体」は **4 文字以上**(tier 1 でない行)。
 *
 * - `null` … 境界ではない(端 / 同じ speaker の隣)。判定に参加しない
 * - `ANCHOR` … 同じ final の同じ speaker の本体。断片はその一部で、寄せる対象外
 * - `{ reason }` … 境界だが寄せ先にならない(理由は `BOUNDARY_SKIP_REASONS` のキー)
 * - `{ to }` … 寄せ先の候補(同じ final の別 speaker の本体)
 *
 * 判定順は **構造(seq・隣)を先に、内容(句読点・語彙)は呼び出し側で後に**。逆にすると
 * 「別 final の『はい』」が `backchannel` に数えられ、語彙リストを調整するための件数が
 * 構造上どのみち寄らないケースで水増しされる。内容ゲートの件数は「それが無ければ寄っていた」数だけ。
 */
function classifyNeighbor(line, n) {
  if (n == null) return null;
  if (isReconnect(n)) return { reason: "boundary" };
  const sameFinal = sameSeq(line.seq, n.seq);
  if (n.speaker === line.speaker) return sameFinal && fragmentTier(n) !== 1 ? ANCHOR : null;
  if (!sameFinal) return { reason: "differentFinal" };
  if (!hasSpeaker(n)) return { reason: "unknown" };
  if (fragmentTier(n) === 1) return { reason: "unresolvedChain" };
  return { to: n.speaker };
}

/**
 * (b) #55 互換の判定を、通常断片の run `[s, e]` に当てる。
 *
 * 1 行の run に対しては #55 の `boundaryFragmentTarget()` と同じ結果になる。run が 2 行以上の
 * とき(`A:テ | A:キ | B:ストです`)は #55 が `キ` だけを寄せて `テ` を `shortNeighbor` にしていた
 * 形で、run をまとめて寄せる(#57 のパターン 3)。
 *
 * 本体に接している側(`ANCHOR`)からは、その speaker の行を順に「本体の一部」として外す。
 * `A長 | A:あ | A:い | B長` は両方 A の本体で、何もしない(#55 は 1 行の窓で `い` を B へ寄せていたが、
 * raw が A と言っている連続を割る根拠は無い)。
 *
 * 見送りの計上は **境界に立つ行**(隣と speaker が違う行)だけ。run の中で全行が同じ speaker で
 * 両隣も境界でなければ、判定の対象外で何も数えない。run 全体の verdict(`noSeq` / `unknown` /
 * `ambiguous` / 総量 / 内容ゲート)は境界に立つ全行に、側の理由(`differentFinal` / `boundary` /
 * `unknown`)はその側に接する行だけに付け、残りの境界の行は `unresolvedChain` に数える。
 */
function resolveRun(out, s, e, skip, apply) {
  let left = classifyNeighbor(out[s], out[s - 1]);
  let right = classifyNeighbor(out[e], out[e + 1]);
  // 同じ話者の本体に接している側は run から刈り取り、**その本体を反対側の行の寄せ先にはしない**
  // (`BODY(0) | あ(0) | い(1) | う(0) | BODY(0)` の `い` は寄らず `unresolvedChain`)。
  // #55 も `shortNeighbor` で寄せていなかった形で、挟まれた 1 行は①jitter が拾う。
  // 寄せ先にすると (b) が設計に無い「断片に挟まれた断片」まで動かすことになる
  if (left === ANCHOR) {
    const sp = out[s - 1].speaker;
    while (s <= e && out[s].speaker === sp) s++;
    left = { reason: "unresolvedChain" };
  }
  if (right === ANCHOR) {
    const sp = out[e + 1].speaker;
    while (e >= s && out[e].speaker === sp) e--;
    right = { reason: "unresolvedChain" };
  }
  if (s > e) return;
  const atBoundary = (k) =>
    [out[k - 1], out[k + 1]].some(
      (n) => n != null && (isReconnect(n) || n.speaker !== out[k].speaker),
    );
  const countAll = (reason) => {
    for (let k = s; k <= e; k++) if (atBoundary(k)) skip(reason, k);
  };
  const sides = [left, right].filter((v) => v != null);
  // 両隣が端か別 final の同じ話者。run の中に話者交代が無ければ `atBoundary()` が全行 false で何も数えない
  if (sides.length === 0) return countAll("unresolvedChain");
  if (typeof out[s].seq !== "number") return countAll("noSeq");
  // 断片自身の speaker が不明なら寄せない。①は不明行を prev で上書きするが、あちらは
  // 前後が同じ確定話者に挟まれている分だけ証拠が強い。こちらは「誰から」が無いまま
  // 隣へ寄せることになるので、`from` を持たない適用は作らない
  for (let k = s; k <= e; k++) if (!hasSpeaker(out[k])) return countAll("unknown");
  const targets = sides.filter((v) => "to" in v).map((v) => v.to);
  if (targets.length === 0) {
    for (let k = s; k <= e; k++) {
      if (k === s && left?.reason) skip(left.reason, k);
      else if (k === e && right?.reason) skip(right.reason, k);
      else if (atBoundary(k)) skip("unresolvedChain", k);
    }
    return;
  }
  if (targets.length === 2 && targets[0] !== targets[1]) return countAll("ambiguous");
  const to = targets[0];
  const candidates = movers(out, s, e, to);
  if (candidates.length === 0) return;
  const failed = gateFailures(out, candidates, out[s].seq);
  if (failed) {
    for (const [k, reason] of failed) skip(reason, k);
    return;
  }
  applyAll(out, candidates, to, apply);
}

/** (b) chain の中の通常断片の run ごとに `resolveRun()` を当てる。拡張断片は run を切る本体 */
function resolveByRuns(out, start, end, skip, apply) {
  let s = start;
  while (s <= end) {
    if (fragmentTier(out[s]) !== 1) {
      s++;
      continue;
    }
    let e = s;
    while (e + 1 <= end && fragmentTier(out[e + 1]) === 1) e++;
    resolveRun(out, s, e, skip, apply);
    s = e + 1;
  }
}

/**
 * 同じ final の中で語の途中に入った speaker 境界を平滑化した**コピー**と、その計画を返す。
 * 引数の配列も要素も変更しない。**何も削除しない。** 直すのは `speaker` だけ。
 *
 * コピーは copy-on-write — 配列だけ複製し、寄せた行だけを新しいオブジェクトに差し替える。
 * ⓪が書き換えるのは「境界に立つ短い行」だけで全行のごく一部なのに、
 * `renderTranscript()`(final のたび)と `renderDiagnostics()`(毎秒)から呼ばれるパイプラインに
 * 全行コピーをもう 1 段足す理由が無い(①が直後にどのみち全行コピーする)。
 *
 * 走査は左から 1 パスで、**同じ `seq` の短い行(tier > 0)が続く限りを 1 つの chain として閉じてから
 * 判定する**。寄せた結果は次の chain の判定に使う(①と同じ規律)が、chain は tier 0 の行で
 * 切れるので、寄せても次の chain から見た anchor の speaker は変わらない。`seq` の無い行は
 * 何とも同じ final にならず、1 行の chain になる。
 *
 * 見送りの計上は **1 行 1 理由**(`decided`)。(a) で数えた行を (b) で数え直さない。寄せた行が
 * 後から数えられることは無い — (a) が寄せれば (b) は走らず、(b) の run どうしは重ならず、
 * 同じ行の内容ゲートは (a) でも (b) でも同じ結果になる(見るのは同じ `out` の同じ隣)ため。
 *
 * @typedef {Record<string, number>} BoundarySkipped キーは `BOUNDARY_SKIP_REASONS`
 * @typedef {Record<string, number>} BoundaryKinds キーは `BOUNDARY_APPLIED_KINDS`
 * @typedef {{
 *   applied: Array<{index:number, from:number, to:number, chars:number, kind:string}>,
 *   kinds: BoundaryKinds,
 *   skipped: BoundarySkipped,
 * }} BoundaryPlan
 * @returns {{ lines: Array<Record<string, any>>, plan: BoundaryPlan }}
 */
export function smoothSpeakerBoundaries(lines) {
  const out = lines.slice();
  const applied = [];
  const kinds = zeroCounts(BOUNDARY_APPLIED_KINDS);
  const skipped = emptyBoundarySkipped();
  const decided = new Set();
  const skip = (reason, k) => {
    if (decided.has(k)) return;
    decided.add(k);
    skipped[reason] += 1;
  };
  const apply = (k, to, kind) => {
    applied.push({ index: k, from: out[k].speaker, to, chars: textLength(out[k]), kind });
    kinds[kind] += 1;
    out[k] = { ...out[k], speaker: to };
  };
  let i = 0;
  while (i < out.length) {
    if (fragmentTier(out[i]) === 0) {
      i++;
      continue;
    }
    const start = i;
    const seq = out[i].seq;
    i++;
    while (i < out.length && fragmentTier(out[i]) > 0 && sameSeq(seq, out[i].seq)) i++;
    const end = i - 1;
    if (!resolveByAnchors(out, start, end, skip, apply)) resolveByRuns(out, start, end, skip, apply);
  }
  return { lines: out, plan: { applied, kinds, skipped } };
}

// ---- 第2段: 想定話者数つきの minor speaker island 補正(#48) ----
//
// 実機で観測された形(2人の会話なのに4 speaker 検出、`0:78.7% / 1:1.3% / 2:19.5% / 3:0.5%`)では、
// `0 → 1 → 0` のように**主要 speaker に挟まれた少数 speaker の島**が何度も出る。これは
// jitter 補正では直らない — 同じ final の中で割れているとは限らず、`seq` が違うためである。
//
// 補正するのは speaker ラベルだけで、テキストも行数も変えない(#36 と同じ規律)。

/** 補正を見送った理由の内訳。**0 でも必ず全キーを出す**(件数を比べられるようにするため) */
const emptySkipped = () => zeroCounts(["mismatch", "tooLong", "edge", "boundary", "unknown"]);

/**
 * minor 判定に使った閾値。**計画に値として載せる**のは、`diagnostics.js` が AudioWorklet から
 * static import されるために `utterances.js` を import できず、診断が「絶対 3.0% → 超過」を
 * 描くのに値そのものが要るため(#59)。
 */
const MINOR_THRESHOLDS = Object.freeze({
  absolute: MINOR_ISLAND_MAX_RATIO,
  relative: MINOR_ISLAND_RELATIVE_MAX_RATIO,
  cap: MINOR_ISLAND_RELATIVE_CAP_RATIO,
});

/** ゲートで弾かれたときの空の計画。`disabledBy` に理由を入れる */
function disabledPlan(reason) {
  return {
    merges: [],
    skipped: emptySkipped(),
    // **空でも必ずキーを持たせる。** ③(#50)は `plan.skippedRuns` を走査するので、
    // ゲートで弾かれた計画だけキーが無いと、そこだけ `undefined` の分岐が要る
    skippedRuns: [],
    majors: [],
    minors: [],
    others: [],
    // #59 の判定明細も空で必ずキーを持たせる(診断が `undefined` の分岐を持たないため)
    minorJudgements: [],
    minorKinds: zeroCounts(MINOR_KINDS),
    smallestMajorRatio: null,
    thresholds: MINOR_THRESHOLDS,
    disabledBy: reason,
  };
}

/**
 * 絶対閾値未満か(#48 / #59)。主要 speaker の選定(これを満たす speaker は統合先にしない)と
 * minor の `absolute` 判定は**同じ境界**なので、述語を 1 つにして両方から使う。
 */
const belowAbsolute = (ratio) => ratio < MINOR_ISLAND_MAX_RATIO;

/**
 * extra speaker(主要でない speaker)1 人ぶんの minor 判定(#59)。**絶対が先。**
 * 両方に当たる speaker は `absolute` に 1 回だけ数える(古くて強い規則を優先し、1 speaker 1 種別)。
 *
 * 相対判定は「統合先になれる主要 speaker の最小割合」を基準にする。上位 N 位でも絶対閾値未満で
 * majors から落ちた speaker は基準にしない(統合先になれない speaker を基準に「十分小さい」と
 * 言っても意味が無い)。majors が空なら `smallestMajorRatio` は `null` で、相対判定は行わない。
 *
 * **3 つの比較の結果(`checks`)も明細に載せる。** 診断はそれを描くだけで、比較を持たない —
 * `diagnostics.js` は `utterances.js` を import できないので、比較演算子を 2 か所に書くと
 * 厳密/包含の向き(絶対と上限は `<`、相対は `<=`)が片方だけ変わり「種別は相対なのに上限 超過」
 * という自己矛盾行が黙って出る。`kind` は `checks` から導く。
 *
 * @returns {{
 *   speaker:number, ratio:number, relativeRatio:number|null,
 *   checks:{absolute:boolean, relative:boolean|null, cap:boolean},
 *   kind:"absolute"|"relative"|"none",
 * }}
 */
function judgeMinor(x, smallestMajorRatio) {
  const ratio = x.ratio;
  const relativeRatio = smallestMajorRatio > 0 ? ratio / smallestMajorRatio : null;
  const checks = {
    absolute: belowAbsolute(ratio),
    // 基準が無ければ判定そのものが無い(`false` にすると「相対 超過」と読めてしまう)
    relative: relativeRatio == null ? null : relativeRatio <= MINOR_ISLAND_RELATIVE_MAX_RATIO,
    cap: ratio < MINOR_ISLAND_RELATIVE_CAP_RATIO,
  };
  const kind = checks.absolute ? "absolute" : checks.relative && checks.cap ? "relative" : "none";
  return { speaker: x.speaker, ratio, relativeRatio, checks, kind };
}

/**
 * minor island の補正計画を返す。**何も変更しない純関数。**
 *
 * 表示に効かせずに計画だけ見たい(診断)ときも同じ関数を通るので、
 * 「表示に効かせた補正」と「診断に出す件数」が別実装になりようがない。
 *
 * @param lines 発話行の配列(変更しない)
 * @param opts.expectedSpeakers 想定話者数の選択値(`EXPECTED_SPEAKER_OPTIONS` の value)
 * @param opts.stats **raw の `finalLines` から取った** `collectSpeakerStats()` の戻り。
 *   省略時は `lines` から集計する(テストと診断の呼び出しを簡単にするためのフォールバック)
 * @returns {{
 *   merges: Array<{from:number, to:number, segments:number, words:number, indexes:number[]}>,
 *   skipped: {mismatch:number, tooLong:number, edge:number, boundary:number, unknown:number},
 *   skippedRuns: Array<{reason:string, speaker:number, words:number, indexes:number[]}>,
 *   majors: number[], minors: number[], others: number[],
 *   minorJudgements: Array<{speaker:number, ratio:number, relativeRatio:number|null,
 *     checks:{absolute:boolean, relative:boolean|null, cap:boolean}, kind:"absolute"|"relative"|"none"}>,
 *   minorKinds: {absolute:number, relative:number, none:number},
 *   smallestMajorRatio: number|null,
 *   thresholds: {absolute:number, relative:number, cap:number},
 *   disabledBy: "auto"|"atLeast"|"noStats"|"detectedNotOver"|"charsBasis"|"tooFewWords"|null,
 * }}
 */
export function planMinorIslandMerges(lines, { expectedSpeakers, stats } = {}) {
  const rows = Array.isArray(lines) ? lines : [];
  const s = stats ?? collectSpeakerStats(rows);

  // ---- ゲート ----
  // どれか1つでも当たれば計画は空。**「効いていない」と「効いた結果0件」は別の事実**なので、
  // 空にした理由を `disabledBy` で必ず返す(診断がそれを1行出す)。
  const n = expectedSpeakerCount(expectedSpeakers);
  // 想定人数の申告が無い(既定)。減らす根拠が無いので何もしない
  if (n == null) return disabledPlan("auto");
  // 「4人以上」は上限が定まらない。**`count === 4` のハードコードにしない** —
  // 「4人ちょうど」の選択肢を将来足したときに黙って壊れる
  if (expectedSpeakerAtLeast(expectedSpeakers)) return disabledPlan("atLeast");
  // 統計そのものが壊れている(呼び出し側が別の形を渡した)。素通りさせると後段で throw する
  if (!Number.isFinite(s?.detected) || !Array.isArray(s?.speakers)) return disabledPlan("noStats");
  // 検出が想定以下なら減らす理由が無い
  if (s.detected <= n) return disabledPlan("detectedNotOver");
  // **分母が文字数へ落ちるセッションでは補正しない。** 下の2つの閾値は word 数で決めた値で、
  // 文字数に当てると意味が変わる — しかも**逆方向にずれる**。日本語のおよそ 1 word ≒ 2 文字で
  // 見ると、`MINOR_ISLAND_MAX_WORDS`(20) は「約40文字ぶんの島」のつもりが20文字までに縮んで
  // 取りこぼし、`MIN_TOTAL_WORDS_FOR_ISLANDS`(200) は「約400文字ぶんの会話」のつもりが
  // 200文字で開く。**安全側であるべき総量ゲートが緩む向きに外れる**ので、
  // 旧サーバー・#46 以前の保存データのために補正精度を賭けない
  if (s.ratioBasis !== "words") return disabledPlan("charsBasis");
  const denom = s.totalWords;
  // 序盤は順位が信用できない(最初の数発話で主要 speaker が決まってしまう)
  if (denom < MIN_TOTAL_WORDS_FOR_ISLANDS) return disabledPlan("tooFewWords");

  // ---- 主要 speaker と minor speaker ----
  // **tie-break を明示するのは純関数の決定性のため。** 同数が上位 N の境界にまたがると
  // 順位が不定になり、同じ入力から違う補正結果が出る
  const ranked = [...s.speakers].sort((a, b) => b.words - a.words || a.speaker - b.speaker);
  // **上位 N 件でも、minor と同じ割合しか持たない speaker は統合先にしない。**
  // 1人が支配的で残りが全員小さい(diarization が崩れたとき現実に起きる)分布では、
  // 「このコードが minor と判定するはずの speaker」が順位だけで主要になれてしまう。
  // そこへ島を寄せるのは、誤りを別の誤りに置き換えるだけ。落ちた run は自然に mismatch になる
  const majorEntries = ranked.slice(0, n).filter((x) => !belowAbsolute(x.ratio));
  const majors = majorEntries.map((x) => x.speaker);
  const majorSet = new Set(majors);
  // 相対判定の基準は「統合先になれる主要 speaker の最小割合」(#59)。majors が空なら null
  const smallestMajorRatio =
    majorEntries.length > 0 ? Math.min(...majorEntries.map((x) => x.ratio)) : null;
  // minor は「主要でない」だけでは足りない。割合の条件も満たすこと
  // (想定を超えて検出された speaker が、実は無視できない量を話していることがある)。
  // 条件は **絶対閾値未満 OR 相対判定(絶対上限つき)** の 2 経路(#59)。判定明細を
  // `stats.speakers` の順で残し、診断が「どの経路で minor になったか」を出せるようにする
  const minorJudgements = s.speakers
    .filter((x) => !majorSet.has(x.speaker))
    .map((x) => judgeMinor(x, smallestMajorRatio));
  const minorKinds = zeroCounts(MINOR_KINDS);
  for (const j of minorJudgements) minorKinds[j.kind]++;
  const minors = minorJudgements.filter((j) => j.kind !== "none").map((j) => j.speaker);
  const minorSet = new Set(minors);
  // **主要でも minor でもない speaker も出す。** 「候補が1人もいなかった」と
  // 「候補はいたが条件で落ちた」を区別するために majors/minors を診断へ出しているが、
  // 割合が閾値以上なのに上位 N に入らなかった speaker はどちらにも現れず、run も作らないので
  // `skipped` にも出ない。診断だけを見ると存在ごと消える
  const others = minorJudgements.filter((j) => j.kind === "none").map((j) => j.speaker);

  // ---- 行を走査用のトークンへ落とす ----
  // 発話行(確定 speaker つき) / 話者不明 / 再接続の印の3種。**元の添字を持たせる**ので、
  // 計画をそのまま `smoothMinorSpeakerIslands()` が適用できる
  // 分母は上のゲートで word 数に確定している(chars 基準はここへ来ない)
  const lineValue = (line) => num(line.w);
  const tokens = [];
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i];
    if (isReconnect(line)) {
      tokens.push({ kind: "reconnect" });
      continue;
    }
    if (line == null || !definedSpeaker(line.speaker)) {
      tokens.push({ kind: "unknown" });
      continue;
    }
    tokens.push({ kind: "speaker", speaker: line.speaker, index: i, value: lineValue(line) });
  }

  // ---- run(同一 minor speaker の連続)の抽出 ----
  //
  // **異なる minor が隣接したら run を切る。** `A → X → Y → A` は X も Y も補正しない。
  // `X → Y` という遷移**そのものが観測された話者交代**であり、またいで両方を A へ寄せると
  // 「ここで話者が変わった」という観測事実を消すことになる。少数派どうしの取り違えは
  // 「どちらが誰か」の問題であって「島かどうか」の問題ではない。
  const runs = [];
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i];
    if (head.kind !== "speaker" || !minorSet.has(head.speaker)) continue;
    const start = i;
    let words = 0;
    const indexes = [];
    while (i < tokens.length && tokens[i].kind === "speaker" && tokens[i].speaker === head.speaker) {
      words += tokens[i].value;
      indexes.push(tokens[i].index);
      i++;
    }
    runs.push({ speaker: head.speaker, start, end: i - 1, words, indexes });
    i--; // while で1つ進みすぎているぶんを for の i++ と相殺する
  }

  /**
   * run の外側へ向かって最初の「確定 speaker つき発話行」を探す。
   *
   * - 再接続の印に当たったら**探索を打ち切って境界を返す**。再接続後は話者番号が振り直しで、
   *   同じ番号でも別人でありうる(`mergeSameSpeaker()` が結合を切っているのと同じ理由)
   * - **話者不明の行でも打ち切る。** run のほうは不明で切るので、跨いで探すと
   *   `A → X → ? → X → A` で**run の反対側にいる同じ minor X が「隣」として見つかり**、
   *   両方の run が「前後の主要 speaker が不一致」として落ちる — 事実と違う見送り理由が、
   *   閾値を決めるための内訳に混ざる。加えて `speaker-stats.js` は「不明をまたいで
   *   `0→1` を数えると観測していない話者交代を作る」として遷移の鎖を切っており、
   *   不明をまたいで統合するのは同じ理屈で「観測していない話者の連続」を作る行為になる
   * - 端まで来たら `null`(前後で挟めない)
   */
  const neighbor = (from, step) => {
    for (let i = from; i >= 0 && i < tokens.length; i += step) {
      if (tokens[i].kind === "reconnect") return { boundary: true };
      if (tokens[i].kind === "unknown") return { unknown: true };
      if (tokens[i].kind === "speaker") return { speaker: tokens[i].speaker };
    }
    return null;
  };

  const skipped = emptySkipped();
  // **見送った run を「どの行だったか」まで残す(#50)。**
  //
  // ③(`planUnresolvedMinors()`)は「統合先を決められなかった run の行」を中立化するので、
  // 件数だけでは足りず run の `indexes` が要る。**③の側で run を切り直させないため**に
  // ここへ足してある — 切り直すと「同一 minor の連続を、別 speaker・話者不明・再接続で切る」
  // という規則が2箇所に実装されることになり、片方だけ直したときに②の見送り件数と
  // ③の中立化件数が静かに食い違う(どちらも診断の数字なので、気づく手掛かりが無い)。
  //
  // `skipped` の件数は据え置く(既存の呼び出し・テストとの互換)。両者は必ず
  // 同じ `skip()` を通るので、件数と run 一覧がずれようがない形にしてある。
  const skippedRuns = [];
  const skip = (reason, run) => {
    skipped[reason]++;
    // `indexes` は複製して渡す。計画は純粋な**値**として扱うので、内部で組み立てた
    // 配列を外へそのまま出さない(run はこの関数のローカルだが、共有しない形に揃えておく)
    skippedRuns.push({ reason, speaker: run.speaker, words: run.words, indexes: [...run.indexes] });
  };
  const merged = new Map();
  // **1つの run は1つの理由にしか計上しない。** 優先順位は
  // boundary → unknown → edge → mismatch → tooLong で、上にあるものほど
  // 「そもそも隣を見られなかった」に近い。内訳は閾値を決めるための材料なので、
  // 二重に数えると `tooLong` の多さから `MINOR_ISLAND_MAX_WORDS` を判断できなくなる
  for (const run of runs) {
    const prev = neighbor(run.start - 1, -1);
    const next = neighbor(run.end + 1, 1);
    if (prev?.boundary || next?.boundary) {
      skip("boundary", run);
      continue;
    }
    if (prev?.unknown || next?.unknown) {
      skip("unknown", run);
      continue;
    }
    if (!prev || !next) {
      skip("edge", run);
      continue;
    }
    // 前後が同じ主要 speaker でなければ島ではない。**統合先は必ず主要 speaker**
    // (minor へ寄せても speaker の数は減らず、誤りを別の誤りに置き換えるだけ)
    if (prev.speaker !== next.speaker || !majorSet.has(prev.speaker)) {
      skip("mismatch", run);
      continue;
    }
    // 長い区間は「誤割り当てされた本物の発話」でありうるので吸収しない
    if (run.words > MINOR_ISLAND_MAX_WORDS) {
      skip("tooLong", run);
      continue;
    }
    const key = `${run.speaker}>${prev.speaker}`;
    const entry = merged.get(key) ?? {
      from: run.speaker,
      to: prev.speaker,
      segments: 0,
      words: 0,
      indexes: [],
    };
    entry.segments += run.indexes.length;
    entry.words += run.words;
    entry.indexes.push(...run.indexes);
    merged.set(key, entry);
  }

  // 並びを決めておく。決めないと同じデータから作った診断 Markdown が実行ごとに違う順序で出る
  const merges = [...merged.values()].sort((a, b) => a.from - b.from || a.to - b.to);
  // `skippedRuns` は run の走査順(＝行の添字の昇順)のまま。走査が1パスなので決定的で、
  // ③がここから作る `neutralized` の順序も入力だけで決まる
  return {
    merges,
    skipped,
    skippedRuns,
    majors,
    minors,
    others,
    minorJudgements,
    minorKinds,
    smallestMajorRatio,
    thresholds: MINOR_THRESHOLDS,
    disabledBy: null,
  };
}

/**
 * 計画を適用した**コピー**を返す。引数の配列も要素も変更しない。
 *
 * 直すのは `speaker` ラベルだけで、テキストも行数も入力のまま(#36 と同じ)。
 */
export function smoothMinorSpeakerIslands(lines, opts = {}) {
  return applyMerges(lines, planMinorIslandMerges(lines, opts));
}

/** 計画の `indexes` は `lines` の添字。**計画を立てた配列と同じものへ当てること** */
function applyMerges(lines, plan) {
  const out = lines.map((line) => ({ ...line }));
  for (const m of plan.merges) {
    for (const i of m.indexes) out[i].speaker = m.to;
  }
  return out;
}

// ---- 第3段: 統合先を決められなかった minor speaker の中立化(#50) ----
//
// ②が見送った run のうち `mismatch`(前後の主要 speaker が違う ＝ `B → X → A`)は、
// **表示上は minor X が「話者C」として残る**。2人の会話だと申告しているのに、実際には
// 第三者が発言したように見える — これが #48 のあとに残った問題。
//
// 取る手は「A/B のどちらかへ推測で寄せる」ではなく、**通常の追加話者として表示しない**。
// 前後が違う以上どちらへ寄せても根拠が無く、寄せた側の発言として本文が残るほうが、
// 「誰の発言か決められなかった」と示すより誤解を生む。
//
// **`speaker` は書き換えない(`null` に潰さない)。** 潰すと2つ壊れる:
// 1. `mergeSameSpeaker()` は `last.speaker === line.speaker` で結合するので、
//    隣接した**異なる** minor が `null === null` で1段落に溶ける。`X → Y` という遷移
//    そのものが観測された話者交代であり、②が run を切って守った不変条件をここで崩す
// 2. 診断で追えなくなる。raw で speaker が付かなかった行(#46 の「話者不明のセグメント」)と
//    「番号は付いたが統合先を決められなかった行」は別の事実で、後者だけが閾値の材料になる
// 代わりに `unresolved: true` という印を立て、表示側がそれを見て中立チップにする。

/** 中立化の対象にする見送り理由。**`mismatch` だけ**(#50 の確定事項) */
const NEUTRALIZE_REASON = "mismatch";

/**
 * 中立化の計画。**何も変更しない純関数。** ②の計画を入力に取る。
 *
 * **ゲートは②と同一で、独自のゲートは足さない。** ②が無効なら中立化も無効
 * (「想定話者数を超えて検出された」という前提そのものが無いところで、minor を
 * 隠す根拠は無い)。ゲートを2組持つと「②は効いているのに③だけ無効」という
 * 説明のつかない状態が作れてしまう。
 *
 * @param plan `planMinorIslandMerges()` の戻り
 * @returns {{
 *   neutralized: Array<{speaker:number, segments:number, words:number, indexes:number[]}>,
 *   skippedRuns: Array<{reason:string, speaker:number, words:number, indexes:number[]}>,
 *   disabledBy: string|null,
 * }}
 */
export function planUnresolvedMinors(plan) {
  // **計画は必須。** 渡されていないのを「有効・0件」と区別できないと、診断が
  // 「中立化 0 seg」と言い切ってしまう(`minorIslandRows()` が `!islandPlan` を
  // 節ごと出さない扱いにしているのと同じ理由)
  if (!plan) return { neutralized: [], skippedRuns: [], disabledBy: "noPlan" };
  const disabledBy = plan.disabledBy ?? null;
  if (disabledBy) return { neutralized: [], skippedRuns: [], disabledBy };

  const runs = Array.isArray(plan.skippedRuns) ? plan.skippedRuns : [];
  // speaker ごとにまとめる。診断が `speaker 2 → 話者不明: 1 seg / 2 word` を出せる形
  const grouped = new Map();
  // 対象外にした run は**そのまま返す**。理由別の件数を診断が出せないと、
  // `edge` / `unknown` を将来この段の対象に加えるべきかを判断する材料が無くなる
  const skippedRuns = [];
  for (const run of runs) {
    if (run.reason !== NEUTRALIZE_REASON) {
      skippedRuns.push(run);
      continue;
    }
    // **長い run は中立化しない。** ②が `tooLong` で統合を見送るのと同じ理由 —
    // 誤割り当てされた「本物の発話」でありうるので、隠すと発言者が消えたように見える。
    //
    // **ここで当て直さないと、この段だけ長さの安全弁が効かない。** ②の判定順は
    // `mismatch → tooLong` なので、`B → X(長い) → A` は `mismatch` が先に立ち
    // `tooLong` に到達しない。②の内訳では `mismatch` として出るため、そのまま
    // 中立化すると**上限なしで**隠すことになる(Issue の「長い minor speaker は対象外」に反する)。
    //
    // 落とした run は `tooLong` に付け替えて返す。診断の「中立化の対象外」が
    // ②の「表示補正の見送り」と違う数字になるのは、まさにこの差ぶんである
    if (run.words > MINOR_ISLAND_MAX_WORDS) {
      skippedRuns.push({ ...run, reason: "tooLong" });
      continue;
    }
    const entry = grouped.get(run.speaker) ?? {
      speaker: run.speaker,
      segments: 0,
      words: 0,
      indexes: [],
    };
    entry.segments += run.indexes.length; // 行数
    entry.words += run.words;
    entry.indexes.push(...run.indexes);
    grouped.set(run.speaker, entry);
  }
  // 並びを決めておく。決めないと同じデータから作った診断 Markdown が実行ごとに違う順序で出る
  const neutralized = [...grouped.values()].sort((a, b) => a.speaker - b.speaker);
  return { neutralized, skippedRuns, disabledBy: null };
}

/**
 * 計画を適用した**コピー**を返す。引数の配列も要素も変更しない。**`speaker` は変えない。**
 *
 * 立てるのは `unresolved` の印だけ。テキストも行数も speaker 番号も入力のまま
 * (#36 / #48 と同じ規律で、この段でも「何も削除しない」)。
 */
function applyNeutralize(lines, plan) {
  // **復元データ由来の印は信じない。** `finalLines` は localStorage から**検証なしで**
  // 復元される(`app.js` の `finalLines.push(...session.finalLines)`)ので、`unresolved` にも
  // 任意の値が入りうる。素通りさせると、想定話者数が既定の `auto`(＝この段が無効)でも
  // 画面には中立チップが出て、診断は「無効（想定話者数が自動）」と言う —
  // **画面と診断が違う事実を語る**。印はこのパイプラインが立てたものだけを有効にする
  // (`definedSpeaker()` / `num()` / `normalizeExpectedSpeakers()` と同じ、消費側で丸める規律)
  const out = lines.map(({ unresolved, ...rest }) => rest);
  for (const n of plan.neutralized) for (const i of n.indexes) out[i].unresolved = true;
  return out;
}

/**
 * 連続する同一話者の発言を1つの段落にまとめる。
 *
 * `lines` には通常の発話行のほかに `{ type: "reconnect" }` という区切り印が混じる。
 * 区切りはそれ自身で1グループとし、直後の発話が直前の話者と同じでも絶対にまとめない
 * (再接続後は話者番号が振り直しなので、同じ番号でも別人の可能性がある)。
 *
 * ③(#50)で `unresolved` が立った行は、**通常の発話とは絶対に結合しない**。
 * 中立行どうしは「同じ raw speaker が続いたときだけ」まとまる(下のコメント参照)。
 *
 * グループは `texts`(行ごと。ハイライトも診断の④(#52)もこれを数える)と **`runs`**(#55)を持つ。
 * `runs` は同じ final 由来の行を区切りなしで連結した文字列の列で、画面(`renderLine()`)と
 * Markdown(`join(" ")`)は run の間にだけ半角スペースを置く。従来は行ごとにスペースを置いていた
 * ので、⓪①が同じ段落へ入れた「1 つの final の 1 文が割れたもの」が `テキ ストを確認します` の
 * ように**日本語の語の途中にスペースを挟んで**いた(speaker を揃えるだけでは表示が自然に
 * ならない理由)。**連結子の規則をグループを作る場所で決める**のは、画面と Markdown の
 * 2 箇所に書くと片方だけ直したときに割れるため。副次効果として、同じ final 由来の断片が
 * またがる語(「テキスト」)にもハイライトが当たる。
 */
export function mergeSameSpeaker(lines) {
  const groups = [];
  // 発話グループの末尾(再接続の印を挟んだら null)と、そこに最後に足した行の `seq`
  let last = null;
  let lastSeq;
  // **`texts` と `runs` へ書くのはここだけ。** `runs` は「同じ final 由来の行は区切りなし、
  // 別の final は別 run」(#55)。判定は隣どうしの `seq` が**両方とも数値で一致する**ときだけで、
  // `seq` の無い旧セッションの行は `undefined === undefined` で繋がず、従来どおり別 run(スペース連結)。
  // 復元データは検証を通っていないので `text` が欠けうる。従来の `escMd(undefined)` は空に
  // 落ちていたが、run の連結で `"a" + undefined` にすると "aundefined" が本文に出る
  const append = (line) => {
    last.texts.push(line.text);
    const text = String(line.text ?? "");
    if (last.runs.length > 0 && typeof line.seq === "number" && line.seq === lastSeq) {
      last.runs[last.runs.length - 1] += text;
    } else {
      last.runs.push(text);
    }
    lastSeq = line.seq;
  };
  const start = (line, extra) => {
    last = { speaker: line.speaker, ...extra, t: line.t, texts: [], runs: [] };
    lastSeq = undefined;
    groups.push(last);
    append(line);
  };
  for (const line of lines) {
    if (isReconnect(line)) {
      groups.push({ type: "reconnect", t: line.t });
      last = null;
      continue;
    }
    // **中立化した行は通常の発話と絶対に結合しない**(#50)。帰属不明であることを保つ。
    //
    // ただし**同じ raw speaker の中立行が続くときは1段落にまとめる**。run は
    // 「同一 minor の連続」を別 speaker・話者不明・再接続で切って作ってあるので、
    // 隣接する中立行の speaker が同じなら**同じ run ＝ 1つの発話のかたまり**。ここで割ると
    // #36 が正面から潰した「1発話が細切れに表示される」を、この段が作り直すことになる。
    //
    // 逆に `X → Y`(隣接した**異なる** minor)は speaker が違うので割れる。`X → Y` という
    // 遷移そのものが観測された話者交代であり、②が run を切ってまで守った不変条件を
    // ここで崩さない。**`speaker` を残したまま印だけで判定するのが要点** —
    // `null` に潰すと `null === null` が成立し、この2つを区別できなくなる。
    if (line.unresolved) {
      if (last?.unresolved && last.speaker === line.speaker) append(line);
      else start(line, { unresolved: true });
      continue;
    }
    // 直前が中立化グループなら、speaker 番号が同じでも結合しない(上と同じ理由の裏返し。
    // 中立化した X の直後に通常の X が来たとき、後者まで中立チップの段落へ吸われてしまう)
    if (last && !last.unresolved && last.speaker === line.speaker) append(line);
    else start(line, {});
  }
  return groups;
}

/**
 * 表示・エクスポート用に speaker ラベルを補正した**コピー**を返す(グループ化の手前まで)。
 *
 * **⓪boundary → ①jitter → ②minor island → ③中立化 の順序が要点で、この順序を関数の中に
 * 閉じてある**(呼び出し側の規律にしない)。①と②を逆にすると吸収できる island が減る:
 *
 * ```
 * A → [jitter B] → minorX → A
 *   ② を先にすると … prev が B なので「前後が同じ主要 speaker」に当たらず補正されない
 *   ① を先にすると … B が A に直り、A → minorX → A が見えるので補正できる
 * ```
 *
 * どちらの段も自分の条件は緩めないまま、**後段が見える範囲だけが広がる**。
 *
 * ③は②の計画から作るので、②のあとでなければ成立しない(②が「統合先を決められなかった」と
 * 判定した run が入力そのもの)。
 *
 * **主要 speaker の選定は raw の統計から取る。** `tests/app-wiring.test.ts` が
 * 「`collectSpeakerStats` は `finalLines` に対して呼ぶ」を固定しており(#46)、
 * ①通過後のコピーから取るとその不変条件を壊す。実害の面でも、①が動かすのは
 * 4文字以下の行だけなので word 数の順位は動かない。
 *
 * @param lines raw の `finalLines`（変更しない）
 * @param opts.expectedSpeakers 想定話者数の選択値(#48)。渡さなければ②は何もしない
 */
function correctSpeakers(lines, opts) {
  // ⓪(#55)は「同じ final」という最も強い証拠だけで動くので先頭。①以降は⓪通過後の行を見る。
  // ⓪は行数も並びも変えないので、②③が①通過後の配列に対して立てる添字はそのまま合う
  const boundary = smoothSpeakerBoundaries(lines);
  // **走査する配列は⓪①通過後、統計は raw。** この2つの出どころは別物で、混同すると
  // 表示と診断がずれる(下の `planDisplayCorrection()` のコメントを参照)
  const jittered = smoothSpeakerJitter(boundary.lines);
  const plan = planMinorIslandMerges(jittered, {
    expectedSpeakers: opts.expectedSpeakers,
    stats: collectSpeakerStats(lines), // ← raw から(#46)
  });
  // ③は②の計画から作る。**添字は①通過後の配列に対するもの**で、②の適用は行数も並びも
  // 変えない(`speaker` を書き換えるだけ)ので、そのまま合成後の配列にも当たる
  const unresolvedPlan = planUnresolvedMinors(plan);
  return {
    boundaryPlan: boundary.plan,
    plan,
    unresolvedPlan,
    corrected: applyNeutralize(applyMerges(jittered, plan), unresolvedPlan),
  };
}

/**
 * 表示・エクスポート用の発話グループを作る。**この5段の順序が要点**で、
 * 先に speaker ラベルを直してからでないと同一話者としてまとまらない
 * (⓪boundary → ①jitter → ②minor island → ③中立化 → ④同一話者の結合)。
 *
 * @param lines raw の `finalLines`（変更しない）
 * @param opts.expectedSpeakers 想定話者数の選択値(#48)
 */
export function groupUtterances(lines, opts = {}) {
  return mergeSameSpeaker(correctSpeakers(lines, opts).corrected);
}

/**
 * 診断が見る「表示補正の実際」(#48)。**計画と表示上の話者数を1回の計算から返す。**
 *
 * **診断は必ずここを通すこと。`planMinorIslandMerges()` を raw の `finalLines` に
 * 直接当ててはいけない。** 表示に効くのは①jitter 通過後の行に対する計画なので、
 * raw から立てた計画とは**両方向にずれる**:
 *
 * - jitter が先に島を潰していれば、raw の計画は #48 の手柄を過大に数える
 * - jitter が島を作っていれば、raw の計画は 0 件なのに表示では補正が効く
 *   (「表示補正 0 seg」と「表示上の話者数が減っている」が同じ節に並ぶ)
 *
 * どちらも `skipped` の理由別内訳を事実と違う値にする。その内訳は
 * 「実機データを見て `MINOR_ISLAND_MAX_WORDS` を決める」ための唯一の材料なので、
 * ずれた数字は測定器の目盛りが狂っているのと同じ。
 *
 * **統計(majors/minors の選定)を raw から取ることとは別の話。** そちらは #46 の
 * 不変条件どおりで正しい。揃えるのは「走査する行の配列」のほう。
 *
 * @param lines raw の `finalLines`（変更しない）
 * @param opts.expectedSpeakers 想定話者数の選択値。`groupUtterances()` と同じ引数を渡すこと
 * @returns {{
 *   boundaryPlan: BoundaryPlan,
 *   plan: object,
 *   unresolvedPlan: {
 *     neutralized: Array<{speaker:number, segments:number, words:number, indexes:number[]}>,
 *     skippedRuns: Array<{reason:string, speaker:number, words:number, indexes:number[]}>,
 *     disabledBy: string|null,
 *   },
 *   displayDetected: number,
 * }}
 */
export function planDisplayCorrection(lines, opts = {}) {
  const { boundaryPlan, plan, unresolvedPlan, corrected } = correctSpeakers(lines, opts);
  // **`displayDetected` は「表示上の通常話者数」**(#50)。中立化した speaker は
  // 画面にもエクスポートにも「話者C」としては出ないので、数に入れると
  // 「話者Cは表示されないのに表示上の話者数は3」という読めない値になる。
  //
  // **`collectSpeakerStats()` には手を入れない**(#46 の raw 統計の定義箇所。
  // あちらに「表示の都合」を持ち込むと、補正の効き具合を測るための統計が汚れる)。
  // 数えるためだけのローカルなコピーで `unresolved` を speaker 不明へ落とす。
  // **このコピーは表示には使わない** — 表示側は raw speaker を保持したままの
  // `corrected` を見る(`groupUtterances()` 経由)。潰した配列を表示に回すと、
  // `mergeSameSpeaker()` で隣接した異なる minor が `null === null` で1段落に溶ける
  const forCount = corrected.map((l) => (l.unresolved ? { ...l, speaker: null } : l));
  // 補正後に speaker が何人へ減ったか。**計画の merges から引き算しない** —
  // 適用と数え方が別実装になり、片方だけ直したときに静かにずれる
  return { boundaryPlan, plan, unresolvedPlan, displayDetected: collectSpeakerStats(forCount).detected };
}
