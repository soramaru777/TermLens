// 話者分離の診断統計(#46)。想定話者数と**実検出話者数**の差を定量評価するための集計。
//
// **依存ゼロ・副作用ゼロで置く。** `public/app.js` はモジュール評価の時点で
// `document.getElementById` を呼ぶので Node のテストから import できない
// (`lowpass.js` / `card-status.js` / `capture-mode.js` / `utterances.js` と同じ理由)。
// DOM に触る処理をここに置かないこと。加えて `diagnostics.js` がここを import しており、
// **`diagnostics.js` は AudioWorklet からも static import される** ため、
// worklet スコープに無い API(`document` / `window` など)にも触れてはいけない。
//
// ---- なぜ raw の `finalLines` から集計すると word レベルと等価になるか ----
//
// `src/stt/split.ts` の `splitBySpeaker()` は **word の speaker が切り替わる位置でしか
// セグメントを切らない**。したがってクライアントが受け取る final イベント列は
// 「raw word の同一話者ラン」の列そのものになる。
//
//   Deepgram words: [w0:sp0][w1:sp0][w2:sp1][w3:sp1][w4:sp0]
//                            └─ seg(sp0) ─┴─ seg(sp1) ─┴─ seg(sp0)
//
// - 検出話者数 … ラン集合の speaker 種類数 ＝ word レベルと一致
// - 遷移       … 隣接ランの (from,to) ＝ word レベルと一致。`0→0` はそもそもランに
//                 ならないので「同一話者の継続を数えない」が構造で満たされる
// - word 数    … ランごとの `words.length`(= 行の `w`)を足すだけで一致
//
// **等価なのは「ランがそのまま届いたとき」まで。** `buildFinalEvents()` は切り出しに
// 失敗して空文字になったセグメントを捨てるので、真ん中のランが落ちると
// `0(A) → [1が消滅] → 2(C)` で観測していない `0→2` を1回数える。また
// `splitBySpeaker()` は speaker が undefined の word を現在のセグメントへ吸収するので、
// `w` にはそのランの speaker に帰属しない word が混じりうる。どちらも稀だが、
// 数値を突き合わせるときは「ほぼ一致」であって「常に厳密一致」ではない。
//
// **集計対象は raw の `finalLines` に限る。** `utterances.js` の `groupUtterances()` は
// 表示用に speaker ラベルを補正した**コピー**を返すので、そちらから集計すると
// 「表示補正と診断用 raw 統計が分離されている」という #46 の要件が静かに壊れる
// (補正の効き具合を測るための統計が、補正後の値になってしまう)。
//
// **唯一の例外は「表示上の話者数」(#48)。** 補正後に speaker が何人へ減ったかは、
// 定義上 raw からは出せない。`utterances.js` の `planDisplayCorrection()` が補正後の
// コピーへこの関数を当てて数え、診断は raw の検出話者数と**別ラベルで併記**する
// (raw が主、補正後が従)。それ以外の統計は raw から取ること。

/**
 * 想定話者数の選択肢。**定義箇所はここだけ。**
 * `app.js` が select を組み立て、`diagnostics.js` が表示名を引く。
 * HTML や app.js に文言を書き写すと定義が2箇所になる(`CAPTURE_MODES` と同じ規則)。
 *
 * `count` は比較に使う人数、`atLeast` は「以上」かどうか。`auto` は
 * **人数を指定しない**ことを表すので `count: null`。
 *
 * **これは Deepgram に話者数を強制指定する値ではない。** 診断で実検出数と
 * 突き合わせるためだけの申告値で、STT のパラメータには一切流れない。
 */
export const EXPECTED_SPEAKER_OPTIONS = [
  { value: "auto", label: "自動", count: null, atLeast: false },
  { value: "2", label: "2人", count: 2, atLeast: false },
  { value: "3", label: "3人", count: 3, atLeast: false },
  { value: "4plus", label: "4人以上", count: 4, atLeast: true },
];

/** 既定は「自動」。人数を申告していない状態で、差の警告は出さない */
export const DEFAULT_EXPECTED_SPEAKERS = "auto";

/**
 * 選択肢を1件引く。**配列の走査で引くのが要点。**
 *
 * オブジェクトの添字(`OPTIONS[value]`)にすると `"constructor"` / `"toString"` が
 * `Object.prototype` 経由で truthy になり、`count` が `undefined` のまま比較に流れる
 * (`capture-mode.js` が `Object.hasOwn` で塞いでいるのと同じ穴)。値は `localStorage`
 * ＝信頼境界の外から来るので、prototype に載っている名前が絶対に当たらない形で引く。
 */
function findOption(value) {
  return EXPECTED_SPEAKER_OPTIONS.find((o) => o.value === value);
}

/** 既知の値に丸める。`localStorage` が古い・壊れている・改変されていれば既定に倒す */
export function normalizeExpectedSpeakers(value) {
  return typeof value === "string" && findOption(value) ? value : DEFAULT_EXPECTED_SPEAKERS;
}

/** 画面と診断で使う表示名。設定画面・診断パネル・Markdown が同じ文言を使う */
export function expectedSpeakerLabel(value) {
  return findOption(normalizeExpectedSpeakers(value)).label;
}

/** 比較に使う人数。`auto` は null(＝人数を申告していない) */
export function expectedSpeakerCount(value) {
  return findOption(normalizeExpectedSpeakers(value)).count;
}

/**
 * その値が「N人以上」の意味か。`4plus` だけ真。
 *
 * **`utterances.js` の island 補正(#48)もここから引く。** 「以上」は上限が定まらないので
 * 補正を無効にする、という判断に使う。呼び出し側で `count === 4` と書くと、
 * 「4人ちょうど」の選択肢を将来足したときに黙って壊れる。
 */
export function expectedSpeakerAtLeast(value) {
  return findOption(normalizeExpectedSpeakers(value)).atLeast;
}

/** 再接続の区切り印。発話ではないので集計に参加させない(`utterances.js` と同じ判定) */
const isReconnect = (line) => line?.type === "reconnect";

/**
 * 有限な非負数だけ通す。壊れた値で合計を NaN に落とさない。
 *
 * **export しているのは `utterances.js` の #48 が同じ規則で行の word 数を読むため。**
 * 写しを置くと、片方だけ「負を許す」ように直したときに静かに食い違う。
 */
export function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 話者番号として扱える値か。**整数でなければ「話者不明」に倒す。**
 *
 * `finalLines` は `localStorage` から**検証なしで**復元される(`app.js` の
 * `finalLines.push(...session.finalLines)`)ので、`speaker` には任意の値が入りうる。
 * 丸めずに通すと `String(s.speaker)` が診断 Markdown に任意の文字列を1つ通す経路になり、
 * 遷移キー(`${prev}>${speaker}`)も `>` を含む文字列で分解が破綻し、`speaker` の昇順ソートも
 * NaN で壊れる。信頼境界の外から来る値をここで無害化しておく
 * (`card-status.js` の `cardStatus()` が「必ず3値に丸める」のと同じ発想)。
 *
 * **export しているのは `utterances.js` の #48 が統合先を決めるときに同じ規則で判定するため。**
 * 「整数でなければ話者不明」の定義が2箇所にあると、片方だけ緩めたときに、丸められなかった
 * 値が統合先として診断 Markdown へ抜ける経路ができる。
 */
export function definedSpeaker(value) {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * raw の `finalLines` から話者統計を集計する。**引数は変更しない。**
 *
 * 行は `{ text, speaker, t, seq, w }`。`w` はそのセグメントの word 数(`ServerMessage`
 * の `wordCount`)で、旧サーバー・#46 以前に保存されたセッションには無い。
 *
 * **`ratioBasis` を必ず返すのが要点。** `w` を持つ行が1件も無ければ割合の分母を
 * 文字数へフォールバックするが、分母が黙って入れ替わると数値どうしを比較できなくなる。
 * どちらで計算したかを返し、Markdown にも出す。
 *
 * **話者不明ぶんは分母に入るが、どの speaker にも帰属しない。** したがって
 * `Σ speakers[].ratio` は 1 に満たないことがある。閾値(`MINOR_SPEAKER_RATIO` /
 * `DOMINANT_SPEAKER_RATIO`)はこの分母に対して当たるので、未帰属の量が読めないと
 * 実データから閾値を決められない。`unknownWords` / `unknownChars` を返して診断に出す。
 *
 * @returns {{
 *   detected: number, ratioBasis: "words"|"chars",
 *   totalWords: number, totalChars: number, totalSegments: number,
 *   unknownSegments: number, unknownWords: number, unknownChars: number,
 *   reconnects: number,
 *   speakers: Array<{speaker:number, words:number, chars:number, segments:number, ratio:number, firstT:number|null, lastT:number|null}>,
 *   transitions: Array<{from:number, to:number, count:number}>,
 * }}
 */
export function collectSpeakerStats(lines) {
  const rows = Array.isArray(lines) ? lines.filter((l) => l != null && !isReconnect(l)) : [];
  // 1件でも `w` を持っていれば word 基準。`w` を欠く行はその行の word 数を 0 として扱う
  // (旧い行が混ざったセッションでも、分母の定義が行ごとに揺れない)。
  //
  // **代償**: `w` を持つ行と持たない行が混在すると、`w` を欠く行の speaker だけ割合が
  // 過小に出る。ただし Deepgram 経路では `words` の無い final は speaker も undefined に
  // なる(`buildFinalEvents(text, undefined)`)ので、**speaker 付きで `w` を欠く行は実質
  // 作れない**。混在が起きるのは改変・破損した `localStorage` からの復元だけ。
  const ratioBasis = rows.some((l) => typeof l.w === "number" && Number.isFinite(l.w)) ? "words" : "chars";

  const perSpeaker = new Map();
  const transitionCounts = new Map();
  let totalWords = 0;
  let totalChars = 0;
  let unknownSegments = 0;
  let unknownWords = 0;
  let unknownChars = 0;
  let reconnects = 0;
  // 直前の**確定話者つき**セグメント。再接続の区切りと話者不明の行で切れる
  let prev = null;

  for (const line of Array.isArray(lines) ? lines : []) {
    if (line == null) continue;
    if (isReconnect(line)) {
      // 再接続後は話者番号が振り直しで、同じ番号でも別人でありうる。
      // 境界をまたぐ遷移を数えると、実際には起きていない話者交代が積み上がる
      // (`utterances.js` が結合を切っているのと同じ理由)
      reconnects++;
      prev = null;
      continue;
    }
    const words = num(line.w);
    const chars = String(line.text ?? "").length;
    totalWords += words;
    totalChars += chars;

    if (!definedSpeaker(line.speaker)) {
      unknownSegments++;
      unknownWords += words;
      unknownChars += chars;
      // **話者不明のセグメントは遷移の鎖も切る。** 誰が話したか分からない区間を
      // またいで `0→1` を数えると、観測していない話者交代を作ってしまう
      prev = null;
      continue;
    }
    const speaker = line.speaker;
    const t = typeof line.t === "number" && Number.isFinite(line.t) ? line.t : null;
    const entry = perSpeaker.get(speaker) ?? {
      speaker,
      words: 0,
      chars: 0,
      segments: 0,
      ratio: 0,
      firstT: null,
      lastT: null,
    };
    entry.words += words;
    entry.chars += chars;
    entry.segments++;
    if (t != null) {
      entry.firstT = entry.firstT == null ? t : Math.min(entry.firstT, t);
      entry.lastT = entry.lastT == null ? t : Math.max(entry.lastT, t);
    }
    perSpeaker.set(speaker, entry);

    if (prev != null && prev !== speaker) {
      const key = `${prev}>${speaker}`;
      transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
    }
    prev = speaker;
  }

  const denom = ratioBasis === "words" ? totalWords : totalChars;
  const speakers = [...perSpeaker.values()].sort((a, b) => a.speaker - b.speaker);
  for (const s of speakers) {
    const own = ratioBasis === "words" ? s.words : s.chars;
    s.ratio = denom > 0 ? own / denom : 0;
  }

  // 回数の多い順 → from,to の昇順。同数のときの並びを決めておかないと、
  // 同じデータから作った Markdown が実行ごとに違う順序で出る
  const transitions = [...transitionCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(">").map(Number);
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count || a.from - b.from || a.to - b.to);

  return {
    detected: speakers.length,
    ratioBasis,
    totalWords,
    totalChars,
    totalSegments: rows.length,
    unknownSegments,
    unknownWords,
    unknownChars,
    reconnects,
    speakers,
    transitions,
  };
}

/** これ未満の割合しか持たない speaker は、偽 speaker の候補 */
export const MINOR_SPEAKER_RATIO = 0.05;
/** 1人がこれ以上を占有していたら、複数人が1人へ潰れている疑い */
export const DOMINANT_SPEAKER_RATIO = 0.9;

/**
 * `ratioBasis` に依存する表示を**まとめて1箇所で決める**。
 *
 * 単位名・見出し名・その speaker の値・words 列の中身は、どれも「割合をどちらの分母で
 * 出したか」の裏返しでしかない。分けて書くと、基準を1つ足したときに片方だけ直し漏らし、
 * **画面と Markdown で同じ数字の見え方が食い違う**（`diagnostics.js` 冒頭の
 * 「画面と Markdown が同じ配列から描く」という主張が静かに崩れる）。
 *
 * `ofTotal` が文全体を返すのは日本語の語間のため。単位だけ返すと `文字` のときに
 * 「全 文字 の 95.0%」という不自然な空白が入る。
 */
const RATIO_BASIS_VIEW = {
  words: {
    /** 「比率の基準」に出す名前 */
    basisLabel: "word 数",
    /** 診断パネルで値に添える単位 */
    unit: "word",
    /** その speaker の、分母と同じ単位の値 */
    value: (s) => s.words,
    /** 警告文の「全◯◯の N%」 */
    ofTotal: (pct) => `全 word の ${pct}`,
    /** Markdown の words 列 */
    wordsCell: (s) => String(s.words),
  },
  chars: {
    basisLabel: "文字数",
    unit: "文字",
    value: (s) => s.chars,
    ofTotal: (pct) => `全文字数の ${pct}`,
    // word 基準でないときに 0 を並べると「word が0個だった」と読めてしまう。
    // 集計していないことを "-" で示す
    wordsCell: () => "-",
  },
};

/** `ratioBasis` に対応する表示定義。未知の値は文字数側へ倒す(内部生成の値なので通常起きない) */
export function ratioBasisView(ratioBasis) {
  return Object.hasOwn(RATIO_BASIS_VIEW, ratioBasis)
    ? RATIO_BASIS_VIEW[ratioBasis]
    : RATIO_BASIS_VIEW.chars;
}

/**
 * 話者統計の割合表記。**`diagnostics.js` もここから取る。**
 * 桁数を2つの実装に分けて持つと、同じ診断ファイルの中で `95.0%` と `95.00%` が混ざる。
 */
export const pct1 = (r) => `${(r * 100).toFixed(1)}%`;

/**
 * 統計から警告文を作る。**断定しない文言にする**(#46 の指定)。
 *
 * ここが出すのは「実データを集めるための手掛かり」であって判定ではない。
 * この Issue では speaker を強制統合するなどの補正は一切行わないので、
 * 文面も「〜の可能性」に留める。
 *
 * - 想定と検出の差 … 想定が `auto`(人数を申告していない)なら出さない。
 *   `4plus` は「以上」なので、検出が4以上なら差とみなさない
 * - 少数派 speaker … 想定に関係なく出す(偽 speaker は人数の申告と独立に起きる)
 * - 占有       … 同上。1人しか検出していない場合も出る(それ自体が「潰れている」の兆候)
 *
 * **分母が 0 のときは割合の警告を一切出さない。** 全 speaker の `ratio` が 0 になるので、
 * 出すと「speaker 0 が全 word の 0.0%（偽 speaker の可能性）」が speaker の数だけ並び、
 * 観測事実ではなくデータ欠損の artifact が警告として残る。
 */
export function speakerWarnings(stats, expectedValue) {
  if (!stats || stats.totalSegments <= 0) return [];
  const out = [];
  const count = expectedSpeakerCount(expectedValue);
  const atLeast = expectedSpeakerAtLeast(expectedValue);
  const label = expectedSpeakerLabel(expectedValue);
  const view = ratioBasisView(stats.ratioBasis);
  const denom = stats.ratioBasis === "words" ? stats.totalWords : stats.totalChars;

  if (count != null) {
    const differs = atLeast ? stats.detected < count : stats.detected !== count;
    if (differs) out.push(`⚠ 想定${label}に対し ${stats.detected} speaker を検出`);
  }
  if (denom <= 0) return out;

  for (const s of stats.speakers) {
    if (s.ratio < MINOR_SPEAKER_RATIO) {
      out.push(`⚠ speaker ${s.speaker} が${view.ofTotal(pct1(s.ratio))}（偽 speaker の可能性）`);
    }
  }
  for (const s of stats.speakers) {
    if (s.ratio >= DOMINANT_SPEAKER_RATIO) {
      // 想定を申告していれば「何人が潰れたか」まで書ける。auto なら人数を断定しない
      const who = count != null ? label : "複数人";
      out.push(
        `⚠ speaker ${s.speaker} が${view.ofTotal(pct1(s.ratio))} を占有（${who}が1人へ潰れている可能性）`,
      );
    }
  }
  return out;
}
