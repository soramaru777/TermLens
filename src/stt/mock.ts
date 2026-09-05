import type { SplitDiag, SttAdapter, SttInfo, TranscriptEvent, TranscriptWord } from "./types.js";
import { MOCK_SCRIPT, type MockLine } from "./mock-script.js";
import { buildFinalEvents } from "./split.js";

/**
 * 発話速度（文字/秒）。日本語の自然な会話速度。
 * `start` / `end` を手書きせず、ストリーム先頭からの累積文字数をこれで割って算出する。
 */
export const MOCK_CHARS_PER_SECOND = 8;

/** 1行につき発行する interim の回数。 */
export const MOCK_INTERIM_STEPS = 3;

/**
 * 1つの final に含める word 数。
 *
 * mock は元々 1 行をまるごと 1 つの final として出していたため、
 * 「**複数の final を1発話に統合する**」という UtteranceBuilder の中身が
 * mock 上で一度も発生せず、通しても素通しになっていた。
 * 実 Deepgram が 1 発話を複数の final に割って返すのに合わせて、機械的に分割する。
 *
 * `mock-script.ts` は変更しない。行単位の手書きデータに final の区切りまで持たせると
 * 型が複雑になるうえ、実物の区切り位置を再現できるわけでもないため。
 */
export const MOCK_WORDS_PER_FINAL = 4;

/** interim / final を刻む間隔（ミリ秒）。 */
export const MOCK_STEP_MS = 600;

/** final を出してから次の行を再生し始めるまでの待ち時間（ミリ秒）。 */
export const MOCK_LINE_GAP_MS = 1500;

/**
 * 行と行の間の無音として `start` / `end` に足し込む秒数。
 * `MOCK_LINE_GAP_MS`（final 後に実際に待つ時間）と一致させてある。
 */
export const MOCK_LINE_GAP_SEC = MOCK_LINE_GAP_MS / 1000;

/** 1行の再生に掛かる実時間（ミリ秒）。interim×3 + final + 行間ギャップ。 */
export const MOCK_LINE_CYCLE_MS = (MOCK_INTERIM_STEPS + 1) * MOCK_STEP_MS + MOCK_LINE_GAP_MS;

/** 通常の語に与える confidence。 */
export const MOCK_CONFIDENCE = 0.95;

/** 誤認識を模した語に与える confidence。 */
export const MOCK_MISHEARD_CONFIDENCE = 0.55;

/**
 * 誤認識を模した語。`mock-script.ts` が「わざと崩したカタカナ」として持っている表記で、
 * `tests/fixtures/term-cases.json` の `expectCorrection` のキー
 * （＝評価ハーネスが「正しい表記に直されるべき」と定義している表記）と一致するものを挙げている。
 *
 * ここに低い confidence を与えておくと、後続Issueの「confidence が低い語を優先的に補正する」
 * ロジックを mock だけで検証できる。
 *
 * `エンベディング` のような通常のカタカナ語は含めない（term-cases.json では誤認識ではなく
 * `rag-acronym` の `allowLowConfidence` 側に置かれている）。`スロットリング` も同様で、
 * `throttling-oncall` では `expectTerms` に入っている一方 `expectCorrection` は空
 * ＝「解説すべき用語ではあるが誤認識ではない」ため、通常の confidence のままにする。
 *
 * この集合が `term-cases.json` から drift しないよう、tests/mock-words.test.ts が
 * 「`expectCorrection` のキー ∩ MOCK_SCRIPT の word」との集合一致を検証している。
 */
export const MOCK_MISHEARD_WORDS: ReadonlySet<string> = new Set([
  "クバネテス", // Kubernetes
  "グラファナ", // Grafana
  "ラグ", // RAG
  "ピネコーネ", // Pinecone
  "クドラント", // Qdrant
  "オーオース", // OAuth
  "ピーケーシーイー", // PKCE
  "エヌディーエー", // NDA
  "ジラ", // Jira
]);

/** 秒を 3 桁で丸める。最短の語（1文字 = 0.125秒）でも潰れない精度。 */
function roundSec(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/**
 * 行の手書き word 分割から `TranscriptWord[]` を組み立てる。
 *
 * `start` / `end` は `baseSec`（ストリーム先頭からのその行の開始時刻）に
 * 行頭からの累積文字数 ÷ 発話速度を足したもの。`TranscriptWord.start` の契約が
 * 「ストリーム先頭からの相対」なので、実 Deepgram と同じくスクリプト一周を通して単調増加する。
 *
 * 文字数は**句読点を含む長さ**（`punctuated ?? word`）で数える。
 * そうしないと文字送りの総和が `text.length` と合わなくなる。
 *
 * `speaker` は行の値を全 word に入れる。`punctuatedWord` は句読点つき表記
 * （句読点が付かない語では `word` と同じ）。
 *
 * export しているのは tests/mock-words.test.ts から検証するため。
 */
export function buildMockWords(line: MockLine, baseSec = 0): TranscriptWord[] {
  let offset = 0;
  return line.words.map(({ word, punctuated }) => {
    const surface = punctuated ?? word;
    const start = roundSec(baseSec + offset / MOCK_CHARS_PER_SECOND);
    offset += surface.length;
    const end = roundSec(baseSec + offset / MOCK_CHARS_PER_SECOND);
    return {
      word,
      punctuatedWord: surface,
      start,
      end,
      confidence: MOCK_MISHEARD_WORDS.has(word) ? MOCK_MISHEARD_CONFIDENCE : MOCK_CONFIDENCE,
      speaker: line.speaker,
    };
  });
}

/** word の表示表記（句読点つき）。`text` との突き合わせは常にこちらで行う。 */
export function mockSurface(w: TranscriptWord): string {
  return w.punctuatedWord ?? w.word;
}

/**
 * interim 用に、先頭から `charLen` 文字ぶんの word だけを取り出す。
 *
 * **境界に跨る word は含めない。** 切れかけの語を出すと
 * 「words を連結すると text と一致する」という不変条件が interim で壊れ、
 * word 単位の処理が interim では成り立たなくなるため。
 * 結果として interim の words は `text.slice(0, charLen)` より短くなることがある。
 *
 * export しているのは tests/mock-words.test.ts から検証するため。
 */
export function sliceMockWords(words: TranscriptWord[], charLen: number): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  // 累積文字数は `end` から逆算せず数え直す。`end` は roundSec で丸めてあり、
  // 逆算（(end - baseSec) * MOCK_CHARS_PER_SECOND）は丸め誤差で整数からわずかにズレるため、
  // `> charLen` の厳密比較が境界でぶれる。
  let offset = 0;
  for (const w of words) {
    const len = mockSurface(w).length;
    if (offset + len > charLen) break;
    offset += len;
    out.push(w);
  }
  return out;
}

/**
 * words を `size` 語ずつに分ける。実 Deepgram が1発話を複数の final に割るのを模す。
 * 端数は最後のチャンクに入る。空配列なら空配列を返す。
 *
 * `size` が 1 未満だと進まず無限ループになるので 1 に丸める。
 *
 * export しているのは tests/mock-words.test.ts から検証するため。
 */
export function chunkMockWords(words: TranscriptWord[], size: number): TranscriptWord[][] {
  const step = Math.max(1, Math.floor(size));
  const out: TranscriptWord[][] = [];
  for (let i = 0; i < words.length; i += step) out.push(words.slice(i, i + step));
  return out;
}

/**
 * スクリプトを再生するモックSTT。マイクもAPIキーも不要で
 * transcript → 抽出 → カード表示のパイプライン全体を検証できる。
 * 1行につき interim を数回発行してから final を発行し、スクリプト末尾でループする。
 */
export class MockSttAdapter implements SttAdapter {
  private transcriptCb: ((e: TranscriptEvent) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /**
   * ストリーム先頭からの経過秒。行をまたいで持ち越す。
   * `TranscriptWord.start` / `end` は「ストリーム先頭からの相対」という契約なので、
   * 行ごとに 0 に戻すと行境界で時間が巻き戻り、時間ギャップを見る処理が実機と逆に振る舞う。
   */
  private streamOffsetSec = 0;

  async start(_opts: { keywords: string[] }): Promise<void> {
    this.stopped = false;
    this.streamOffsetSec = 0;
    this.playLine(0);
  }

  private playLine(index: number): void {
    if (this.stopped) return;
    const line = MOCK_SCRIPT[index % MOCK_SCRIPT.length];
    const { text, speaker } = line;
    const words = buildMockWords(line, this.streamOffsetSec);
    const steps = MOCK_INTERIM_STEPS;
    let step = 0;

    const tick = () => {
      if (this.stopped) return;
      step += 1;
      if (step <= steps) {
        const len = Math.ceil((text.length * step) / (steps + 1));
        const partial = sliceMockWords(words, len);
        // text も word 境界に合わせて切る。境界に跨る word を落とす以上、
        // text.slice(0, len) をそのまま出すと「words を連結すると text と一致する」
        // 不変条件が interim で崩れるため。
        //
        // 空の interim は送らない。deepgram.ts が `if (text.length > 0)` で握り潰すのと同じ扱い。
        // 送ると session.ts がそのまま転送し、app.js が表示中の interim を消してちらつく。
        if (partial.length > 0) {
          this.transcriptCb?.({
            text: partial.map(mockSurface).join(""),
            isFinal: false,
            speaker,
            words: partial,
          });
        }
        this.timer = setTimeout(tick, MOCK_STEP_MS);
      } else {
        // 1行を MOCK_WORDS_PER_FINAL 語ごとの final に割り、最後の1件にだけ speechFinal を立てる。
        // 実アダプタと同じ話者分割規則（buildFinalEvents）も通す。mock は1行1話者なので
        // 常に1セグメントで text は素通しされ、単一話者ケースの退行をここでも検出できる。
        const chunks = chunkMockWords(words, MOCK_WORDS_PER_FINAL);
        for (const [i, chunk] of chunks.entries()) {
          const isLast = i === chunks.length - 1;
          // `diag`(#52)は捨てる。mock は1行1話者で常に素通しになるため、積んでも
          // 「分割で落ちるか」は1件も観測できない。計測は実アダプタの経路でだけ意味を持つ
          const { events: evs } = buildFinalEvents(chunk.map(mockSurface).join(""), chunk);
          for (const [j, e] of evs.entries()) {
            // speechFinal を立てるのは行の最後のチャンクの、さらに最後の1件だけ。
            // deepgram.ts と同じ規則（全件に立てると話者分割ごとに発話が閉じる）。
            // 非最終には false を立てず undefined のままにする
            const last = isLast && j === evs.length - 1;
            this.transcriptCb?.(last ? { ...e, speechFinal: true } : e);
          }
        }
        // 行の発話ぶん＋行間の無音を経過時間に足してから次の行へ
        this.streamOffsetSec = roundSec(
          this.streamOffsetSec + text.length / MOCK_CHARS_PER_SECOND + MOCK_LINE_GAP_SEC,
        );
        this.timer = setTimeout(() => this.playLine(index + 1), MOCK_LINE_GAP_MS);
      }
    };
    this.timer = setTimeout(tick, MOCK_STEP_MS);
  }

  sendAudio(_chunk: Buffer): void {
    // モックでは音声は捨てる
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.streamOffsetSec = 0;
    if (this.timer) clearTimeout(this.timer);
    this.closeCb?.();
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.transcriptCb = cb;
  }
  /**
   * mock は UtteranceEnd 相当のシグナルを持たないので**登録するだけで呼ばない**。
   * speech_final だけで発話が閉じる経路を mock で通しておき、
   * UtteranceEnd 経路とタイムアウト経路は tests/utterance.test.ts の純関数テストで見る。
   */
  onUtteranceEnd(_cb: () => void): void {
    // 何もしない
  }
  /**
   * mock は STT のモデル情報を持たないので**登録するだけで呼ばない**(#46)。
   * クライアントは `stt_info` が来なくても壊れず、診断には
   * 「(取得できませんでした)」と出る(`tests/diagnostics.test.ts` が固定)。
   */
  onSttInfo(_cb: (info: SttInfo) => void): void {
    // 何もしない
  }
  /**
   * mock は分割の計測を出さないので**登録するだけで呼ばない**(#52)。
   * 上のとおり1行1話者で常に素通しになるため、積んでも分割経路の計測にはならない。
   * クライアントは `text_integrity` が来なくても壊れず、診断は節ごと出ない
   * (`tests/diagnostics.test.ts` が固定)。
   */
  onSplitDiag(_cb: (diag: SplitDiag) => void): void {
    // 何もしない
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
}
