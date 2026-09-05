// 発話グループの組み立て — 話者ラベルの揺れ(speaker jitter)の補正(#36)、
// 想定話者数を超えて検出された少数 speaker の島の補正(#48)、
// 統合先を決められなかった minor speaker の中立化(#50)、
// そして連続する同一話者の結合。
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

/** 1つの island として吸収してよい最大 word 数。長い誤割り当て区間は吸収しない(#48 の将来スコープ) */
export const MINOR_ISLAND_MAX_WORDS = 20;

/** これ未満の総 word 数では主要 speaker の順位が信用できないので補正しない */
export const MIN_TOTAL_WORDS_FOR_ISLANDS = 200;

/** 再接続の区切り印。発話ではないので結合にも補正にも参加させない。 */
const isReconnect = (line) => line?.type === "reconnect";

/** 話者が確定している行か。`speaker` は不明なら null / undefined で来る。 */
const hasSpeaker = (line) => line != null && line.speaker != null;

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
  if (String(line.text ?? "").length > JITTER_CHAR_LIMIT) return false;
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

// ---- 第2段: 想定話者数つきの minor speaker island 補正(#48) ----
//
// 実機で観測された形(2人の会話なのに4 speaker 検出、`0:78.7% / 1:1.3% / 2:19.5% / 3:0.5%`)では、
// `0 → 1 → 0` のように**主要 speaker に挟まれた少数 speaker の島**が何度も出る。これは
// jitter 補正では直らない — 同じ final の中で割れているとは限らず、`seq` が違うためである。
//
// 補正するのは speaker ラベルだけで、テキストも行数も変えない(#36 と同じ規律)。

/** 補正を見送った理由の内訳。**0 でも必ず全キーを出す**(件数を比べられるようにするため) */
const emptySkipped = () => ({ mismatch: 0, tooLong: 0, edge: 0, boundary: 0, unknown: 0 });

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
    disabledBy: reason,
  };
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
  const majors = ranked
    .slice(0, n)
    .filter((x) => x.ratio >= MINOR_ISLAND_MAX_RATIO)
    .map((x) => x.speaker);
  const majorSet = new Set(majors);
  // minor は「主要でない」だけでは足りない。割合の閾値も満たすこと
  // (想定を超えて検出された speaker が、実は無視できない量を話していることがある)
  const minors = s.speakers
    .filter((x) => !majorSet.has(x.speaker) && x.ratio < MINOR_ISLAND_MAX_RATIO)
    .map((x) => x.speaker);
  const minorSet = new Set(minors);
  // **主要でも minor でもない speaker も出す。** 「候補が1人もいなかった」と
  // 「候補はいたが条件で落ちた」を区別するために majors/minors を診断へ出しているが、
  // 割合が閾値以上なのに上位 N に入らなかった speaker はどちらにも現れず、run も作らないので
  // `skipped` にも出ない。診断だけを見ると存在ごと消える
  const others = s.speakers
    .filter((x) => !majorSet.has(x.speaker) && !minorSet.has(x.speaker))
    .map((x) => x.speaker);

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
  return { merges, skipped, skippedRuns, majors, minors, others, disabledBy: null };
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
 */
export function mergeSameSpeaker(lines) {
  const groups = [];
  for (const line of lines) {
    if (isReconnect(line)) {
      groups.push({ type: "reconnect", t: line.t });
      continue;
    }
    const last = groups[groups.length - 1];
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
      if (last?.unresolved && last.speaker === line.speaker) last.texts.push(line.text);
      else groups.push({ speaker: line.speaker, unresolved: true, t: line.t, texts: [line.text] });
      continue;
    }
    // 直前が中立化グループなら、speaker 番号が同じでも結合しない(上と同じ理由の裏返し。
    // 中立化した X の直後に通常の X が来たとき、後者まで中立チップの段落へ吸われてしまう)
    if (last && last.type !== "reconnect" && !last.unresolved && last.speaker === line.speaker)
      last.texts.push(line.text);
    else groups.push({ speaker: line.speaker, t: line.t, texts: [line.text] });
  }
  return groups;
}

/**
 * 表示・エクスポート用に speaker ラベルを補正した**コピー**を返す(グループ化の手前まで)。
 *
 * **①jitter → ②minor island → ③中立化 の順序が要点で、この順序を関数の中に閉じてある**
 * (呼び出し側の規律にしない)。①と②を逆にすると吸収できる island が減る:
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
  // **走査する配列は①通過後、統計は raw。** この2つの出どころは別物で、混同すると
  // 表示と診断がずれる(下の `planDisplayCorrection()` のコメントを参照)
  const jittered = smoothSpeakerJitter(lines);
  const plan = planMinorIslandMerges(jittered, {
    expectedSpeakers: opts.expectedSpeakers,
    stats: collectSpeakerStats(lines), // ← raw から(#46)
  });
  // ③は②の計画から作る。**添字は①通過後の配列に対するもの**で、②の適用は行数も並びも
  // 変えない(`speaker` を書き換えるだけ)ので、そのまま合成後の配列にも当たる
  const unresolvedPlan = planUnresolvedMinors(plan);
  return { plan, unresolvedPlan, corrected: applyNeutralize(applyMerges(jittered, plan), unresolvedPlan) };
}

/**
 * 表示・エクスポート用の発話グループを作る。**この4段の順序が要点**で、
 * 先に speaker ラベルを直してからでないと同一話者としてまとまらない
 * (①jitter → ②minor island → ③中立化 → ④同一話者の結合)。
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
  const { plan, unresolvedPlan, corrected } = correctSpeakers(lines, opts);
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
  return { plan, unresolvedPlan, displayDetected: collectSpeakerStats(forCount).detected };
}
