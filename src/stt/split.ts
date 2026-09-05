import type { SplitDiag, TranscriptEvent, TranscriptWord } from "./types.js";

/**
 * word 単位の話者分割。**依存ゼロで保つこと**（import は `./types.js` の型のみ）。
 *
 * `deepgram.ts` に置くと、ここを使いたいだけの `mock.ts` とそのテストが
 * `ws` と `config.ts` を連れ込む。`config.ts` はモジュール評価時に dotenv を読み、
 * `STT_PROVIDER=deepgram` かつキー未設定なら throw するため、
 * 「マイクも API キーも不要」なはずの mock 経路が実行環境の設定に依存してしまう。
 * `src/extract/normalize.ts` を切り出したのと同じ理由。
 */

/** 話者が切り替わる位置で words を分けた結果。 */
export interface SpeakerSegment {
  /** そのセグメント内で最初に現れた定義済み speaker。全語で不明なら undefined */
  speaker?: number;
  words: TranscriptWord[];
}

/** word の表示表記。`text` の突き合わせは常にこちら（句読点つき）で行う。 */
function wordSurface(w: TranscriptWord): string {
  return w.punctuatedWord ?? w.word;
}

/**
 * 空白を除いた文字数（#52）。**テキスト完全性の判定に使うのはこちらで、素の `length` ではない。**
 *
 * `sliceFromTranscript()` は切り出しに `.trim()` を掛けるので、**正常に動いていても素の
 * `length` は減る**。素の文字数で段階を比べると「正常な空白の消失」と「本物の欠落」が
 * 混ざって読めなくなる。切り出しに成功しているかぎり空白を除いた文字数は保存されるので、
 * **ここが減っていれば欠落**。
 *
 * **ただしフォールバックした final は例外**（`SplitDiag.fallback`）。フォールバックは
 * `transcript` と `words[]` が食い違ったときにだけ起きるので、`join("")` で組み直した
 * テキストは `transcript` と**別の文字列**であり、空白を除いた文字数も増減しうる
 * （`"10時"` に words `["10", "時です"]` なら増え、逆なら減る）。診断の判定文は
 * `fallbacks > 0` のとき①→②の差を別扱いにする（`public/diagnostics.js`）。
 *
 * 判定式は正規表現 `/\s/g` そのもの。**同じ定義がクライアント側
 * （`public/diagnostics.js` の `visibleChars()`）にもある** — 言語境界をまたぐので実装は
 * 2つになるが、`tests/integrity.test.ts` が両者の一致を全角空白・タブ・改行まで含めて
 * 突き合わせている（片方だけ直すと段階別の文字数が意味を失う）。
 */
export function visibleChars(s: string): number {
  return s.replace(/\s/g, "").length;
}

/**
 * words を話者の切り替わりで分割する。規則は2つだけ。
 *
 * 1. セグメントの `speaker` は、そのセグメント内で**最初に現れた**定義済み speaker
 * 2. 定義済みの speaker が現在のセグメントの speaker と異なったら、そこで新しいセグメントを開始する
 *
 * `speaker` が undefined の word は**境界を作らず現在のセグメントに吸収**する。
 * diarize 有効時に speaker が欠けるのは例外的で、独立させると1語だけの発話が量産されるため。
 * 先頭が undefined 続きの場合は、そのセグメントで最初に現れた定義済み speaker を後から採用する。
 *
 * **最小語数の閾値は入れていない**（相槌が消えるため）。代償として話者番号の揺れが
 * 細切れとして露出する。判断の経緯は docs/wiki/termlens-stt-pipeline.md を参照。
 */
export function splitBySpeaker(words: TranscriptWord[]): SpeakerSegment[] {
  const segments: SpeakerSegment[] = [];
  let current: SpeakerSegment | undefined;
  for (const w of words) {
    if (!current) {
      current = { speaker: w.speaker, words: [] };
      segments.push(current);
    } else if (typeof w.speaker === "number") {
      if (current.speaker === undefined) {
        // 先頭が undefined 続きだったセグメント。最初に現れた定義済み speaker を採用する
        current.speaker = w.speaker;
      } else if (w.speaker !== current.speaker) {
        current = { speaker: w.speaker, words: [] };
        segments.push(current);
      }
    }
    current.words.push(w);
  }
  return segments;
}

/**
 * 各セグメントに対応する範囲を `transcript` から**切り出す**。
 *
 * word の表記を先頭から順に `transcript` 上で探し、セグメント末尾の word の位置で slice する。
 * こうすると分割後の text も **Deepgram が組み立てた文字列の実体そのまま**になり、
 * 語間の空白（日本語 transcript でも `AWS Lambda` のようなラテン文字列には入る）や
 * 記号の扱いを、こちらの連結規則で作り直さずに済む。
 *
 * 1語でも `transcript` 上に見つからない場合と、切り出しが空になる場合は `undefined` を返し、
 * 呼び出し側が連結による再構成へフォールバックする。
 */
function sliceFromTranscript(
  transcript: string,
  segments: SpeakerSegment[],
): string[] | undefined {
  const texts: string[] = [];
  let searchFrom = 0;
  let sliceFrom = 0;
  for (const seg of segments) {
    for (const w of seg.words) {
      const surface = wordSurface(w);
      const idx = transcript.indexOf(surface, searchFrom);
      if (idx < 0) return undefined;
      searchFrom = idx + surface.length;
    }
    // 語間の空白は前側のセグメントに寄せたうえで落とす
    const text = transcript.slice(sliceFrom, searchFrom).trim();
    if (text.length === 0) return undefined;
    texts.push(text);
    sliceFrom = searchFrom;
  }
  return texts;
}

/**
 * final の `TranscriptEvent` を組み立てる。`alt` を持たない mock からも同じ規則を通せるよう、
 * Deepgram 固有の形（`DeepgramAlternative`）に依存しないシグネチャにしてある
 * （同じ規則を2か所に書くと、片方だけ直したときに静かに食い違うため）。
 *
 * セグメントが1つ以下なら `text` を**素通し**する。words から組み直すと
 * 句読点・数値表記などで Deepgram の出力と1文字でも違ったときに、
 * 既存の表示と用語抽出が静かに変わるため。分割が必要なときだけ切り出し・再構成を行う。
 *
 * 各イベントには `segIndex` を付ける。**採番はここではしない** —
 * 純関数にグローバルカウンタを持たせるとテストの決定性が壊れるため、分割の事実だけを
 * 載せて `session.ts` に採番させる（`TranscriptEvent.segIndex` のコメント、#36）。
 *
 * 戻り値に `diag` を足してあるのは #52 の計測のため。**カウンタは持たない** — ここは
 * 純関数のままで、セッション累計は `src/stt/integrity.ts` が積む。
 */
export function buildFinalEvents(
  text: string,
  words?: TranscriptWord[],
): { events: TranscriptEvent[]; diag: SplitDiag } {
  const rawChars = text.length;
  const rawVisible = visibleChars(text);
  // **空 text は全ゼロを返す。** テキストが無い以上テキスト完全性に言うことは無い。
  // ここで `segments` だけ埋めると `SplitIntegrity` が `segments - events` を
  // 「捨てたセグメント」として積み、実際には1件も発行していないのに破棄件数が増える。
  // `deepgram.ts` は空 transcript でここまで来ないが、**不変条件を呼び出し側にだけ
  // 置かない**（mock や将来のアダプタから呼ばれても同じ値になる形にしておく）
  if (text.length === 0) {
    return {
      events: [],
      diag: {
        rawChars,
        rawVisible,
        splitChars: 0,
        splitVisible: 0,
        segments: 0,
        events: 0,
        fallback: false,
        headDropped: false,
      },
    };
  }
  const segments = words ? splitBySpeaker(words) : [];
  if (segments.length <= 1) {
    return {
      events: [
        {
          text,
          isFinal: true,
          speaker: segments[0]?.speaker,
          words: segments[0]?.words ?? words,
          segIndex: 0,
        },
      ],
      // 素通しなので文字数は定義上そのまま。**ここを `rawChars` の再計算ではなく同じ値に
      // するのが要点** — 「分割が起きなければ文字は構造的に落ちない」という事実を、
      // 計測側でも1つの式として書いておく（別々に数えると、素通しの経路に差が出たときに
      // それが計測のバグなのか欠落なのか読み手が判断できない）
      diag: {
        rawChars,
        rawVisible,
        splitChars: rawChars,
        splitVisible: rawVisible,
        segments: segments.length,
        events: 1,
        fallback: false,
        headDropped: false,
      },
    };
  }
  const sliced = sliceFromTranscript(text, segments);
  const texts = sliced ?? segments.map((seg) => seg.words.map(wordSurface).join(""));
  const kept = segments
    .map((seg, i) => ({ text: texts[i], isFinal: true, speaker: seg.speaker, words: seg.words }))
    // 空の transcript は送らない（app.js の表示中 interim が消えてちらつくため）。
    // 切り出しに失敗して連結へフォールバックしたとき、word が空表記だと起こりうる
    .filter((e) => e.text.length > 0);
  // **`segIndex` は空を捨てた後に振る。** 捨てる前に振ると、先頭のセグメントが落ちたときに
  // `segIndex === 0` のイベントが1件も出ず、`session.ts` の採番が進まない。
  // 直前の final と同じ `finalSeq` になり、別々の final がクライアント側の jitter 補正で
  // 1発話として結合されうる（#36）。
  const events: TranscriptEvent[] = kept.map((e, i) => ({ ...e, segIndex: i }));
  return {
    events,
    diag: {
      rawChars,
      rawVisible,
      splitChars: events.reduce((n, e) => n + e.text.length, 0),
      splitVisible: events.reduce((n, e) => n + visibleChars(e.text), 0),
      segments: segments.length,
      events: events.length,
      fallback: sliced === undefined,
      // **先頭が落ちたかを独立した boolean にする。** 「発話の冒頭が丸ごと消える」を
      // 構造的に説明できる唯一の経路（#52 の調査）なので、`segments - events` の
      // 件数に埋めると「何件落ちたか」は分かっても「頭が落ちたか」が読めない
      headDropped: texts[0].length === 0,
    },
  };
}
