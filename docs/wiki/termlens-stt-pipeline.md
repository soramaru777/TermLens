---
title: TermLens STT パイプライン
type: concept
project: termlens
scope: shared
sources:
  - README.md
  - docs/local/status-2026-08-13.md
  - docs/raw/session-2026-08-13-fly-deploy.md
  - src/stt/
related: [[termlens-architecture]], [[termlens-term-extraction]], [[termlens-open-issues]], [[termlens-deployment]], [[termlens-testing]]
confidence: high
updated: 2026-08-26
---

# TermLens STT パイプライン

マイク音声を Deepgram に流し、文字起こしを UI と用語抽出の両方に配る部分。汎用的な知見は `~/wiki/knowledge/deepgram-streaming-ja.md` に切り出してある。

## 入力

ブラウザの AudioWorklet で 16kHz PCM16 に変換し、WebSocket のバイナリフレームで送る。サーバーはそのまま Deepgram の streaming API に中継する。

### 間引く前に必ずローパスを掛ける

> 2026-08-20 修正: **当初の実装は線形補間だけで間引いており、アンチエイリアスのローパスが
> 無かった。** その結果、8kHz を超える成分が**そのままの大きさで**音声帯域に折り返していた
> （実測: 9kHz→7kHz、12kHz→4kHz、14kHz→2kHz がいずれも 0dB）。日本語の子音（サ行・
> シャ行・ツ・ハ行・破裂音）は 8〜16kHz に強いエネルギーを持つため、音声認識が最も頼る
> 手がかりが壊れていた。誤変換・欠落の主因と考えられる。
>
> 63タップの sinc + Blackman 窓 FIR を間引く前に掛けるよう修正した。実測で通過域は
> 4kHz まで 0.0dB・6kHz で -0.8dB、折り返しは 9kHz で -65dB、12kHz 以上は検出限界以下。
> 係数は端末ごとに入力レートが違うため実行時に設計する。ブロック境界で FIR が途切れると
> 周期ノイズになるので、直前ブロックの末尾を持ち越している。

> 2026-08-25 訂正・追記: 係数設計（`designLowpass`）を `public/lowpass.js` に切り出し、
> `tests/lowpass.test.ts` が DFT で振幅応答を毎回検証するようにした（[[termlens-testing]]）。
> **その実測で、阻止域の最悪値は 48kHz 入力で -64.6dB（帯域端の 9kHz）** と分かった。
> 上の「9kHz で -65dB」はわずかに楽観的だったので訂正する。44.1kHz 入力は入力ナイキストが
> 低いぶん阻止域が 9.8kHz 付近まで押し下がり **-75.3dB** と 10dB 以上の余裕がある。
> 実用上の差は無いが、テストの閾値は -64.0dB を採用している。上の記述と
> `audio-processor.js` のコメントは実測値に書き換え済み（コメントは定数と一緒に
> `lowpass.js` へ移動した）。
>
> **96kHz 入力ではローパスの阻止域が -21.9dB まで劣化する（実測、2026-08-25）。**
> 通過域も -2.46dB まで落ちる。63タップ固定で遮断周波数だけ実行時に決める設計のため、
> 入力レートが上がるほど遷移域が相対的に広がるのが原因。48kHz / 44.1kHz では問題ないが、
> 96kHz でマイクが開く端末では折り返し抑圧が実質2桁ぶん弱い。既存挙動として記録するに留め、
> テストは追加していない（Issue #18 の範囲外）。
>
> `lowpass.js` は AudioWorklet から static import されるため、**副作用（`registerProcessor` など
> worklet 固有の API）を置いてはいけない**。Node のテストから読めなくなる。
> 設計パラメータ（`FIR_TAPS` / `CUTOFF_MARGIN` / `TARGET_SAMPLE_RATE`）も `lowpass.js` が
> 唯一の定義箇所で、`audio-processor.js` / `app.js` / テストはすべてそこから import する。
> **未検証: AudioWorklet 内の static import はブラウザ差があり、iPad Safari での実機確認は未実施。**

## Deepgram の設定

`nova-3` / `language=ja` / `diarize` / `keyterm` を有効化。`DEEPGRAM_MODEL` で `nova-2` に切り替えられるが、**語彙ブーストのパラメータ名が nova-3=keyterm / nova-2=keywords と異なる**ためアダプタ側で吸収している。

## 用語集ブースト

会議前に入力した用語集（参加者名・社名・専門用語）を keyterm prompting に渡す。
Nova-3 の keyterm は**日本語を含む多言語に対応済み**（2026-08 時点で確認）。**LLM による後段補正の前に、STT の段階で認識精度が上がる**のが利点。

実測: 「クバネテス」→ Kubernetes の修正を確認済み。

## 話者分離

話者が変わると段落を分け、色付きの話者チップ（話者A/B/…）を表示する。

> 2026-08-26 更新（Issue #20）: **多数決（`dominantSpeaker()`）をやめ、word の `speaker` が
> 切り替わる位置で発話を分割するようにした。** それまでは 1 セグメント全体を 1 話者に潰していたため、
> 1 セグメント内に入った短い相槌や話者交代が多数派話者に吸収されて消えていた。
> `dominantSpeaker()` は削除済み。

`splitBySpeaker()`（`src/stt/split.ts`）の規則は2つだけ。

1. セグメントの `speaker` は、そのセグメント内で**最初に現れた**定義済み speaker
2. 定義済みの speaker が現セグメントの speaker と異なったら、そこで新セグメントを開始する

`speaker` が `undefined` の word は**境界を作らず直前のセグメントに吸収**する。diarize 有効時に
speaker が欠けるのは例外的で、独立させると 1 語だけの発話が量産されるため。先頭が `undefined` 続きの
場合は、そのセグメントで最初に現れた定義済み speaker を後から採用する。全語で不明ならセグメントの
`speaker` も `undefined` になる（`app.js` は `speaker != null` でチップ表示を分岐しており対応済み）。

分割された発話は `transcriptCb` を複数回呼ぶことで流す。**`SttAdapter` / `TranscriptEvent` /
`protocol.ts` / `session.ts` / `public/app.js` はいずれも無変更**。`onTranscript` は 1 メッセージに
つき何回でも呼べる契約であり、`app.js` の `groupUtterances()` が連続する同一話者をまとめ直すため、
分割された発話が届いても表示は自然にまとまる。

分割ロジックは **`src/stt/split.ts` に依存ゼロで置いてある**（import は `types.ts` の型のみ）。
`deepgram.ts` に置くと、使いたいだけの `mock.ts` とそのテストが `ws` と `config.ts` を連れ込み、
`STT_PROVIDER=deepgram` でキー未設定の環境では **mock のテストが import 時に throw する**
（実際に踏んだ）。`src/extract/normalize.ts` を切り出したのと同じ理由（[[termlens-testing]]）。

### 最小語数の閾値は入れていない

**「短い相槌を別話者として残す」ことと「1 語だけの話者番号の揺れを無視する」ことは同じ現象の裏表**。
相槌は 1〜2 語なので、閾値（例: 2 語未満は前後に吸収）を入れると相槌そのものが消える。

その代償として、Deepgram の speaker がノイズで揺れた `[0,1,0,1]` のような列は**そのまま 4 分割として
露出する**。多数決はこの揺れを吸収していたので、ここは退行しうる点。どの程度細切れになるかは
実機データがないと測れないため、[[termlens-testing]] の評価基盤で話者誤分類率を測ってから
閾値の要否を判断する（それまで根拠のない定数は入れない）。

### interim は分割しない

`public/app.js` の interim 表示ハンドラは `interimText.textContent = msg.text` の**上書き**なので、
interim を 2 件に分けて送ると前半の話者ぶんが後半に消される。したがって interim は
`alt.transcript` を丸ごと 1 件で送る。**interim の `speaker` はクライアントで読まれていない**ため
`undefined` にしてよく、これで多数決を interim のために残す必要もなくなった。

### text は組み立て直さず transcript から切り出す

話者が変わらないセグメントでは **Deepgram の `transcript` にまったく手を触れない**。組み直すと
句読点・数値表記などで元と 1 文字でも違ったときに、既存の表示と用語抽出が静かに変わるため。

分割が必要なときも、**word の表記を `transcript` 上で順に探して境界の位置で `slice` する**。
`punctuatedWord ?? word` の単純な連結にしないのは、**日本語の transcript でもラテン文字列の語間には
空白が入る**（`AWS Lambda`）ため。空白なしで連結すると `AWSLambda` になり、表示だけでなく
`normalizeTerm()` のキーやハイライトの照合まで巻き込んで壊れる。切り出しなら分割後の text も
Deepgram が組み立てた文字列の実体そのままになる。1 語でも `transcript` 上に見つからないときだけ
連結にフォールバックし、text が空になるイベントは送らない。

同じ規則は `buildFinalEvents()`（`src/stt/split.ts`）にあり、mock も final ではこの経路を通る
（mock は 1 行 1 話者なので常に 1 セグメント＝素通し。単一話者ケースの退行を mock 経由でも検出するため）。

### 分割の代償は表示の外にも及ぶ

`session.ts` は無変更で動くが、**発行されるイベント数が増えること自体に副作用がある**。
いずれもクラッシュではなく静かな品質劣化なので、実機で測る前に閾値で塞がないこと。

- **用語抽出バッファに空白が入る。** `scheduler.appendToBuffer()` は final を `" "` 区切りで
  連結するので、1 つの Deepgram セグメントが N 分割されると日本語の文中に N-1 個の空白が入る
- **LLM 抽出が断片に対して走りうる。** `maybeRun()` は「120 文字以上」または
  「前回から 20 秒経過」で発火する。後者の経路では、分割された 1 件目（相槌なら 1〜2 語）だけで
  `run()` が走り、同じセグメントの残りは次のチャンクに回る。**「LLM 呼び出し回数は変わらない」
  という Issue #20 の設計時の見立ては、この経路について正しくない**
- **`localStorage` の履歴が早く痩せる。** `public/app.js` は final 1 件につき 1 エントリを
  `finalLines` に積み、`SESSION_MAX_CHARS` 超過時に古い順で捨てる。件数が増えるぶん本文以外の
  オーバーヘッドが増え、同じ会話時間で復元できる履歴が短くなる（Issue #19 で words を
  クライアントに送らないと決めたのと同じ性質の劣化）

**開始直後は分離が効かない。** Deepgram のストリーミング diarization は音声を蓄積して声を
クラスタリングするため、判別材料が溜まるまで全員を話者0に寄せる。仕様上の挙動であり実装のバグではない。
「会話開始から数分しないと機能しない」という観察はこれで説明できる。

**合成音声（macOS `say`）では全発言が話者0になり分離しない。** テストには実声が必要。

## word 単位の情報

> 2026-08-25 追記（Issue #19）: **Deepgram の `alternatives[0].words[]` を捨てずに
> `TranscriptEvent.words` に載せるようにした。** それまでは `dominantSpeaker()` の多数決に
> 潰したあと破棄していて、`start` / `end` / `confidence` / `speaker` を後段で使えなかった。

`toTranscriptWords()`（`src/stt/deepgram.ts`、export 済み）が `punctuated_word` →
`punctuatedWord` のキャメルケース化だけ行って通す。**words が無ければ空配列ではなく
`undefined` を返す**（「来なかった」と「0個だった」を区別する必要がないため）。

`TranscriptEvent.words` は **optional**。必須にすると `SttAdapter` を実装している側が
即座に型エラーになるため、既存アダプタを壊さない形で入れている。

### クライアントには送っていない

**`src/protocol.ts` / `src/session.ts` / `public/app.js` は変更していない。** words は
`session.ts` の `stt.onTranscript((e) => …)` までは届くが、`ServerMessage.transcript` には
載せない（案A）。理由:

- WS ペイロードが**見積もりで約13倍**（110B → 1.4KB／発話）になる。**実測ではない**：
  1 word の JSON が `word` / `punctuated_word` / `start` / `end` / `confidence` / `speaker` で
  約 100B、1 発話 14 words という試算（`confidence: low` の数値）。interim は1発話につき何度も飛ぶ
- `public/app.js` はセッションを `localStorage` に保存し、`SESSION_MAX_CHARS` を超えると
  古い `finalLines` から捨てる。words を `finalLines` に入れると**保存できる発話数が桁違いに減り、
  リロード復元が静かに劣化する**（上の試算どおりなら 1/13 程度）
- words を使うのは word 単位話者分割・confidence 補正で、どちらもサーバー側の処理。
  クライアントに送らなくても用途を満たせる

必要になったら `protocol.ts` に足すだけで拡張できる（現状は後から足せる部分集合）。
その際も「interim には載せない」「`localStorage` には保存しない」は守ること。

**interim の words は確定前**。`is_final` 前の word 境界・confidence・speaker は後から変わるため、
interim の words を信頼して処理を書くと確定時に矛盾する。

words を実際に使うのは Issue #20 の話者分割（上の「話者分離」節）。

2026-08-13 に iPad 実機で話者チップの表示までは確認したが、**話者が 1 人だったため分離精度は未検証**。
加えて当時は Fly のトライアル制限でセッションが 5 分で切れており、分離が効き始める時間帯に
ほぼ到達できていなかった（[[termlens-deployment]]、[[termlens-open-issues]] の未検証1）。

## interim / final

interim（未確定）を薄く表示し、final（確定）で置き換える2段階表示。final のテキストが用語抽出の入力になる。

> 2026-08-20 対応: **final が文の途中で切れる**問題（弱点6）に対し、`endpointing=300` を
> 指定した。既定値は 10ms で、わずかな間でも確定してしまう。300ms にすると自然な文単位で
> まとまり、`smart_format` の句読点も付きやすくなる。
>
> 長くすると 1 セグメントに複数話者が入りやすくなる。Issue #20 以降は word の `speaker` で
> 分割するので**多数派に潰されることはなくなった**が、代わりに話者番号の揺れが細切れとして
> 出るため、壊れ方が変わっただけで**トレードオフは残っている**（上の「最小語数の閾値は
> 入れていない」節）。セグメントが長いほど 1 件の final 到着が遅れる点も変わらない。

## mock モード

`STT_PROVIDER=mock` で、誤認識入りのダミー会議（3話者）が自動再生される。**API キーもマイクも不要**で、文字起こし → カード生成 → web 検索清書 → ハイライトまで全パイプラインを通せる。

開発とリグレッション確認の主力。既定値も `mock` になっている。

### mock の word 分割は手書きで、実物とは別物

> 2026-08-25 追記（Issue #19）: mock も `TranscriptEvent.words` を出すようにした。

**日本語は分かち書きしないため、Deepgram の word 区切りを機械的に再現できない。**
`src/stt/mock-script.ts` の `MockLine.words` は、Deepgram の区切りに近づけて**人が書いた**もの
（`「先週」「から」「クバネテス」「の」「ポッド」…`）。実物とは「形が同じだけの別物」で、
**mock で word 単位ロジックのテストが通っても実機で挙動が違いうる**
（[[termlens-testing]] の「合成データでは Deepgram 自身の挙動は測れない」と同じ構図）。

**とはいえ「実物と同じセマンティクス」だけは守る。** 形が違うのは仕方がないが、
word 数の数え方や時刻の基準がズレていると、mock で調整した閾値が実機で外れるため。

- **句読点は独立 word にしない。** `MockWord` は `{ word, punctuated? }` の組で、
  `word` が素の表記、`punctuated` が句読点つき表記（`{ word: "います", punctuated: "います。" }`）。
  実 Deepgram も句読点を独立 word にせず `punctuated_word` に付随させる。
  独立 word にすると 1 行あたりの word 数が1割ほど水増しされ、「話者分割の粒度」
  「低 confidence word の割合」のような word 数ベースの処理が mock と実機で系統的にズレる
  （`。` が 0.125 秒の発話長を持つのも物理的に無意味だった）
- 不変条件: **`words.map(w => w.punctuated ?? w.word).join("") === text`**。
  `tests/mock-words.test.ts` が全行で固定している
- `punctuatedWord` には `punctuated ?? word` が入る。句読点が付く語だけ `word` と異なる
- `start` / `end` は手書きせず、**8 文字/秒**（`MOCK_CHARS_PER_SECOND`）から累積文字数で算出。
  文字数は**句読点を含む長さ**で数える（そうしないと総和が `text.length` と合わない）
- **`start` / `end` はストリーム先頭からの相対**（`TranscriptWord` の契約どおり）。
  `MockSttAdapter` が `streamOffsetSec` を行をまたいで持ち越し、1行の発話ぶん
  （`text.length / 8` 秒）＋行間ギャップ `MOCK_LINE_GAP_SEC`（1.5 秒＝final 後に実際に待つ時間）
  を足していく。行ごとに 0 に戻すと行境界で時間が巻き戻り、「前の word との時間ギャップが
  N 秒以上なら話者境界」のような時間ベース判定が実機と逆に振る舞う。
  `start()` / `stop()` でリセットする
- `confidence` は既定 0.95、**誤認識を模した語だけ 0.55**（`MOCK_MISHEARD_WORDS`）。
  対象は `tests/fixtures/term-cases.json` の `expectCorrection` のキーと一致させてある
  （クバネテス / グラファナ / ラグ / ピネコーネ / クドラント / オーオース / ピーケーシーイー /
  エヌディーエー / ジラ）。テストが**集合一致**（`expectCorrection` のキー ∩ MOCK_SCRIPT の word）
  で固定しているので、term-cases に誤認識ケースを足したのに漏らす drift は検出される。
  `エンベディング` のような通常のカタカナ語や、`スロットリング`（用語ではあるが誤認識ではない）
  は含めない。後続 Issue の「confidence が低い語を優先的に補正する」ロジックを mock だけで検証できる
- interim は**境界に跨る word を含めない**。あわせて `text` も word 境界で切っている
  （`text.slice(0, len)` をそのまま出すと上記の不変条件が interim で崩れるため）。
  切り出した結果が空になったら**その interim は送らない**（`deepgram.ts` の
  `if (text.length > 0)` と同じ扱い。空 transcript を送ると `app.js` が表示中の interim を消す）

## マイクの取得設定

対面の会議で使う前提のため、`getUserMedia` では **エコーキャンセルとノイズ抑制を切って
いる**（`public/app.js`）。どちらもブラウザ側で「近くの1人の声」を残す方向に働き、
会議室の離れた席の声を環境音として削ってしまうため。距離差による音量差は自動ゲインで均す。

オンライン会議で端末のスピーカーから相手の声を出す使い方をする場合は、エコーキャンセルを
戻す必要がある。その場合はタブ音声を直接取る方が精度は上。
