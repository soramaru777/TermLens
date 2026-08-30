// 発話グループの組み立て — 話者ラベルの揺れ(speaker jitter)の補正と、
// 連続する同一話者の結合(#36)。
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

/**
 * 連続する同一話者の発言を1つの段落にまとめる。
 *
 * `lines` には通常の発話行のほかに `{ type: "reconnect" }` という区切り印が混じる。
 * 区切りはそれ自身で1グループとし、直後の発話が直前の話者と同じでも絶対にまとめない
 * (再接続後は話者番号が振り直しなので、同じ番号でも別人の可能性がある)。
 */
export function mergeSameSpeaker(lines) {
  const groups = [];
  for (const line of lines) {
    if (isReconnect(line)) {
      groups.push({ type: "reconnect", t: line.t });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.type !== "reconnect" && last.speaker === line.speaker) last.texts.push(line.text);
    else groups.push({ speaker: line.speaker, t: line.t, texts: [line.text] });
  }
  return groups;
}

/**
 * 表示・エクスポート用の発話グループを作る。**この2段の順序が要点**で、
 * 先に speaker ラベルを直してからでないと同一話者としてまとまらない。
 *
 * @param lines raw の `finalLines`（変更しない）
 */
export function groupUtterances(lines) {
  return mergeSameSpeaker(smoothSpeakerJitter(lines));
}
