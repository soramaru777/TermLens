/**
 * 抽出済みチャンクを直近ぶんだけ保持するリングバッファ。**依存ゼロで保つこと**（import なし）。
 *
 * `ExtractionScheduler.run()` はバッファを丸ごと持っていって空にするため、
 * チャンク間に文脈の持ち越しが一切なかった（#22）。ここに直前の会話を溜め、
 * `contextTranscript` として LLM の語義判断だけに使わせる。
 *
 * `scheduler.ts` に置くと、リングバッファを検証したいだけのテストが extractor / enrich 経由で
 * `new OpenAI()` と `config.ts` を連れ込む。`normalize.ts` `split.ts` `utterance.ts` と同じ理由で分ける。
 */

/**
 * 文脈として渡す最大文字数。
 *
 * Issue #22 は「直前30〜60秒 または 1000〜2000文字」としているが、**抽出側にタイムスタンプが無い**
 * （`Utterance` は `{ text, speaker }` だけ）。時間軸を通すには UtteranceBuilder → Session →
 * Scheduler の3層に手を入れることになるので、まず文字数だけで入れる。
 * 1,500字の日本語 ≒ 1,100トークンで、入力コストの上振れも直接抑えられる。
 */
export const MAX_CONTEXT_CHARS = 1_500;

/**
 * 直近の会話を上限つきで保持する。
 *
 * **古いチャンクから丸ごと捨てる**。チャンクの切れ目は発話の終わり（#21）なので、
 * 境界を保ったまま落とせる。1チャンク単独で上限を超えるときだけ頭を削る
 * （`MAX_BUFFER_CHARS` の切り捨てと同じ割り切り）。
 *
 * 連結は `" "` 区切りで、`ExtractionScheduler.appendToBuffer()` と揃えてある。
 */
export class ContextWindow {
  private parts: string[] = [];

  constructor(private maxChars: number = MAX_CONTEXT_CHARS) {}

  /** 抽出に**成功した**チャンクを積む。空白だけのチャンクは無視する。 */
  push(text: string): void {
    // 空白だけを積むと `text()` が空白で始まり、`buildUserTurn()` の「(なし)」判定も
    // すり抜けて空白だけの文脈がプロンプトに入る。両側とも trim で揃えてある。
    if (text.trim() === "") return;
    this.parts.push(text);
    // 2件以上あるうちは古い方から丸ごと捨てる（発話境界を壊さない）
    while (this.parts.length > 1 && this.totalLength() > this.maxChars) {
      this.parts.shift();
    }
    // 残り1件でも超えるなら、そのチャンクの頭を削るしかない
    if (this.parts.length === 1 && this.parts[0]!.length > this.maxChars) {
      this.parts[0] = this.parts[0]!.slice(-this.maxChars);
    }
  }

  /** LLM に渡す文脈テキスト。空なら空文字列。 */
  text(): string {
    return this.parts.join(" ");
  }

  /** 抽出を打ち切ったときに捨てる。古い文脈を抱え続ける意味がない。 */
  clear(): void {
    this.parts = [];
  }

  /** `text()` の長さ。`" "` 区切りぶんを含めて数える。 */
  private totalLength(): number {
    let n = 0;
    for (const p of this.parts) n += p.length;
    return n + Math.max(0, this.parts.length - 1);
  }
}
