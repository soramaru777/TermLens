import type { TranscriptEvent, TranscriptWord } from "./types.js";

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
 */
export function buildFinalEvents(text: string, words?: TranscriptWord[]): TranscriptEvent[] {
  if (text.length === 0) return [];
  const segments = words ? splitBySpeaker(words) : [];
  if (segments.length <= 1) {
    return [{ text, isFinal: true, speaker: segments[0]?.speaker, words: segments[0]?.words ?? words }];
  }
  const texts =
    sliceFromTranscript(text, segments) ??
    segments.map((seg) => seg.words.map(wordSurface).join(""));
  return segments
    .map((seg, i) => ({ text: texts[i], isFinal: true, speaker: seg.speaker, words: seg.words }))
    // 空の transcript は送らない（app.js の表示中 interim が消えてちらつくため）。
    // 切り出しに失敗して連結へフォールバックしたとき、word が空表記だと起こりうる
    .filter((e) => e.text.length > 0);
}
