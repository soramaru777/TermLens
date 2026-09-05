---
title: TermLens STT パイプライン
type: concept
project: termlens
scope: shared
sources:
  - README.md
  - public/capture-mode.js
  - public/diagnostics.js
  - public/utterances.js
  - https://developers.deepgram.com/docs/diarization
  - https://developers.deepgram.com/reference/speech-to-text/listen-streaming
  - docs/local/status-2026-08-13.md
  - docs/raw/session-2026-08-13-fly-deploy.md
  - src/stt/
  - public/speaker-stats.js
related: [[termlens-architecture]], [[termlens-term-extraction]], [[termlens-open-issues]], [[termlens-deployment]], [[termlens-testing]]
confidence: high
updated: 2026-09-05
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

### Deepgram 側のパラメータは `diarize=true` のまま（Issue #46 で確認）

`src/stt/deepgram.ts` は `diarize=true` を送っている。**`diarize` は deprecated だが、
今日の挙動は `diarize_model` と変わらない。**

- streaming の `diarize_model` は **`v1` と `latest` のみ**（`v2` は streaming 非対応）
- その `latest` は**現状 v1 に解決される**。deprecated な `diarize=true` も v1 に行く
  ＝ どちらを送っても同じ diarizer が動く
- **`diarize` と `diarize_model` の同時指定は 400 で拒否される。** つまり切り替えるなら
  「足す」ではなく**入れ替え**になり、失敗したときに diarization ごと落ちる

> 出典は Deepgram の公式ドキュメント（下の `sources`）。**実機で 400 を確認したわけではない**
> ため、切り替える PR では mock ではなく実接続で 1 回確かめること。

以上から #46 では触っていない。切り替えるなら単独の PR にする。どの diarizer が実際に
動いていたかは `diarize_info`（後述の診断）で観測できるようになった。

`splitBySpeaker()`（`src/stt/split.ts`）の規則は2つだけ。

1. セグメントの `speaker` は、そのセグメント内で**最初に現れた**定義済み speaker
2. 定義済みの speaker が現セグメントの speaker と異なったら、そこで新セグメントを開始する

`speaker` が `undefined` の word は**境界を作らず直前のセグメントに吸収**する。diarize 有効時に
speaker が欠けるのは例外的で、独立させると 1 語だけの発話が量産されるため。先頭が `undefined` 続きの
場合は、そのセグメントで最初に現れた定義済み speaker を後から採用する。全語で不明ならセグメントの
`speaker` も `undefined` になる（`app.js` は `speaker != null` でチップ表示を分岐しており対応済み）。

分割された発話は `transcriptCb` を複数回呼ぶことで流す。`onTranscript` は 1 メッセージに
つき何回でも呼べる契約であり、`app.js` の `groupUtterances()` が連続する同一話者をまとめ直すため、
分割された発話が届いても表示は自然にまとまる。

> 2026-08-26 まで: 「**`SttAdapter` / `TranscriptEvent` / `protocol.ts` / `session.ts` /
> `public/app.js` はいずれも無変更**」（2026-08-29 更新）。Issue #36 で
> `TranscriptEvent` に `segIndex`、`ServerMessage.transcript` に `finalSeq` が
> 増え、`session.ts` が採番するようになった。`groupUtterances()` は `public/utterances.js` へ
> 移してある。分割規則そのもの（`splitBySpeaker()`）は変わっていない。

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

> 2026-08-29 更新（Issue #36）: **実機データが取れたので、表示側の後処理として補正を入れた。**
> Android 実機の約 49 分・複数話者セッションで、補正なしの `groupUtterances()` は 642 グループを
> 作り、うち 3 文字以下が 255 件（約 39.7%）。さらにその約 78% が「同一秒内に複数の speaker が
> 切り替わる」箇所に含まれていた。**`splitBySpeaker()` の判断（閾値を入れない）は据え置き**で、
> 補正は下記のとおり表示・エクスポートの直前にだけ効く。

### 話者ラベルの揺れは表示側で補正する（Issue #36）

**サーバー側の分割規則は変えず、`public/utterances.js` が表示・エクスポート用のコピーの上で
`speaker` ラベルだけを直す。** raw の `finalLines` は無変更のまま `localStorage` に保存される。

中心にある判断は **「何も削除しない」**。補正するのは `speaker` ラベルだけで、テキストも行数も
減らない。jitter と判定された行は前後と同じ話者になり、結果として同じ段落へ入る。これで
「短い相槌を無条件に消さない」を**閾値の当たり外れではなく構造として**満たす — 閾値を外しても
起きるのは「短い発話が隣の段落に混ざる」ことであって、発言の消失ではない。

判定は `finalLines[i]` について次を**すべて**満たすとき。

1. `prev` / `next` が存在し、どちらも再接続の区切り印ではない（境界を越えない）
2. `prev.speaker === next.speaker` かつ `line.speaker` と異なる。**補正先は必ず確定した話者**
   （前後が不明なら、確定していたラベルを不明で上書きすることになるので補正しない）
3. `line.text.length <= JITTER_CHAR_LIMIT`
4. `prev.seq === line.seq === next.seq`（3 件とも同じ final 由来）。1 つでも `seq` を欠く場合だけ
   受信時刻の窓（`JITTER_WINDOW_MS`）へフォールバックする

**4 が「本物の相槌を消さない」の本体。** 別の final として届いた「はい」は `seq` が違うので、
どれだけ短くても吸収されない。長さの閾値が効くのは「1 つの final が話者ラベルの揺れで割れた」
場合だけに絞られる。

走査は左から順で、補正済みの結果を次の判定に使うため `A → B(短) → A → C(短) → A` は 1 パスで
畳める。**再走査のループは持たない** — 補正は `out[i].speaker = out[i-1].speaker` なので、i を
直したことで i-1 の判定が新たに成立することはあり得ない（成立には「前後が同じ話者で真ん中だけ
違う」が要るが、補正後の i は i-1 と同じ話者になる）。後ろ向きの波及は同じパスの中で処理される。

> 2026-08-29 更新: 当初は `JITTER_MAX_PASSES`（既定 4）で再走査していたが、**1 に落としても
> 結果が変わらない**ことがレビューで判明した（20 万件のランダム入力で差分 0）。「人がチューニング
> する定数」として並べたうちの 1 つが動かしても何も起きない状態は、調整担当を誤らせるので削除した。

閾値は `public/utterances.js` の先頭に 2 つだけ置いてある。**実機データを見てチューニングする
のはそこだけ**という形にしてある。

| 定数 | 暫定値 | 根拠 |
|---|---|---|
| `JITTER_CHAR_LIMIT` | 4 | 実機の分布は 3 文字以下 39.7% / 5 文字以下 53.4%。5 文字まで広げないのは「そうですね」のような**本物の短い発話**がそこに集中するため。3 文字＋余白 1 文字 |
| `JITTER_WINDOW_MS` | 500 | `seq` を欠く行（#36 以前に保存されたセッション）専用のフォールバック。同じ final 由来のイベントは同じ tick で送られ受信時刻差は実質 0ms なので、意図的に狭い |

**未検証**: 実機での前後比較はまだ人が行っていない（[[termlens-open-issues]]）。

#### 同じ final 由来かを `finalSeq` で判定する

`ServerMessage.transcript` に **`finalSeq`（final 1 件ごとの連番）を追加した**。1 つの Results を
話者で分割したイベントには同じ番号が付く。クライアントへ増えたフィールドはこれ 1 つだけで、
`words` / `speechFinal` と同じく `segIndex` はサーバー内部に留めている。

採番は `src/session.ts` が持つ。`buildFinalEvents()` は**純関数なので自分では採番しない** —
グローバルカウンタを持たせるとテストの決定性が壊れる。分割の事実（`segIndex`）だけをイベントに
載せ、`session.ts` が `segIndex === 0`（または `undefined`）でカウンタを進める。分割数は載せない
（採番に要るのは「先頭かどうか」だけで、件数には読み手がいない）。

- 分割されなかった final も `segIndex: 0` を通るので必ず 1 つ採番される
- `segIndex` は**空の text を捨てた後に**振る。捨てる前に振ると先頭が落ちたときに
  `segIndex === 0` が 1 件も出ず、採番が進まないまま前の final と同じ番号になる
- mock アダプタも `buildFinalEvents()` を通るので同じ規則が効く
- **配る番号は 1 から。** サーバー側カウンタ（`Session.lastFinalSeq`）の 0 は「まだ 1 件も
  配っていない」ことを表す初期値で、クライアントに 0 は届かない
- カウンタは WS 1 本の生存期間を通じて持ち、**同じ接続で stop → start しても 0 に戻さない**
  （戻すと停止前後の final に同じ番号が付き、別発話が結合されうる）。再接続で WS ごと張り直された
  場合は 1 から振り直しになるが、クライアントは再接続の境界で必ずグループを切るので衝突しない

用語抽出（`UtteranceBuilder`）は `session.ts` が final を直接渡す別経路のままで、この補正の
影響を受けない。**画面と Markdown エクスポートは同じ `groupUtterances()` を通る**（片方が
自前でまとめ直すと補正結果が割れる。`tests/app-wiring.test.ts` が呼び出しを固定している）。

#### 診断統計はクライアント側で raw から集計する（Issue #46）

想定話者数と**実検出話者数**の差を測るための統計を、`public/speaker-stats.js` の
`collectSpeakerStats()` が **`public/app.js` の raw な `finalLines`** から集計する
（サーバーは word 数と diarizer の metadata だけを足す）。

**なぜクライアント集計で raw と等価になるか。** `splitBySpeaker()` は **word の speaker が
切り替わる位置でしかセグメントを切らない**ので、クライアントが受け取る final イベント列は
「raw word の同一話者ラン」の列そのものになる。

```
Deepgram words:  [w0:sp0][w1:sp0][w2:sp1][w3:sp1][w4:sp0]
                          └─ seg(sp0) ─┴─ seg(sp1) ─┴─ seg(sp0)
```

- **検出話者数** … ラン集合の speaker 種類数 ＝ word レベルと一致
- **遷移** … 隣接ランの `(from,to)` ＝ word レベルと一致。`0→0` はそもそもランにならないので
  「同一話者の継続を数えない」が構造で満たされる
- **word 数** … ランごとの `words.length` を `ServerMessage.transcript.wordCount`（**整数1つ**）
  として送れば一致する。`words` 配列そのものは #19 の判断どおり載せない

**集計元は必ず `finalLines`（`groupUtterances()` の結果ではない）。** 上の jitter 補正は
コピーの上で `speaker` を書き換えるので、補正後から集計すると**補正の効き具合を測るための
統計が補正後の値になる**。この配線は純関数のテストでは守れないので、
`tests/app-wiring.test.ts` が `collectSpeakerStats(finalLines)` という呼び出しを固定している。

**`w` を持つ行が1件も無ければ割合の分母は文字数へ落ちる**（旧サーバー・#46 以前に保存された
セッションの復元経路）。落ちること自体より **どちらで計算したかを返す**ことが要点で、
`ratioBasis` として返し Markdown にも書く — 分母が黙って入れ替わると、別々のセッションから
取った数値どうしを比較できなくなる。

診断に出るのは speaker 番号・word/segment 数・割合・遷移数・**セッション開始からの相対時間**・
diarizer の metadata だけ。**会話本文・音声・絶対時刻・`request_id` は出さない**
（`request_id` はセッションを一意に指す値で、診断ファイルは共有されうる。
`public/diagnostics.js` の `TRACK_KEYS` と同じ採用リストの発想で、`DeepgramMetadata` の型に
そもそも持たせていない）。

**この Issue では speaker の強制統合などの補正は行っていない。** 警告文も
「偽 speaker の可能性」「潰れている可能性」と断定しない形にしてある。閾値
（`MINOR_SPEAKER_RATIO` = 0.05 / `DOMINANT_SPEAKER_RATIO` = 0.90）は暫定値で、
実データを集めてから判断する（[[termlens-open-issues]]）。

#### 想定話者数を超えた少数 speaker の島を寄せる（Issue #48）

**表示側の補正は 3 段になった**（#50 で③が加わり、グループ化まで含めて 4 段）。どの段も
raw の `finalLines` は書き換えず、表示・エクスポート用コピーだけを直す。テキストも行数も
変えない。

```
finalLines（raw / localStorage に保存されるのもこれ）
  │
  ├─ collectSpeakerStats(finalLines) ──▶ #46 の診断統計（raw）
  │                                          │
  │                          主要 speaker の選定に使う
  │                                          ▼
  └─ ① smoothSpeakerJitter() ─▶ ② planMinorIslandMerges() ─▶ ③ planUnresolvedMinors() ─▶ ④ mergeSameSpeaker()
     #36 局所 jitter              + applyMerges                + applyNeutralize             既存
                                  #48 minor island             #50 中立化
```

順序は `correctSpeakers()` の中に閉じてあり、呼び出し側の規律にはしていない。

きっかけは実機の 1 サンプル（2 人の会話で 4 speaker 検出、
`0: 646 word (78.7%) / 1: 11 (1.3%) / 2: 160 (19.5%) / 3: 4 (0.5%)`）。
`0 → 1 → 0` のような島が複数回出る一方、`2 → 3 → 0` のように前後の主要 speaker が
異なるケースもあった（[[termlens-open-issues]]）。

##### ゲート（どれか 1 つでも当たれば 1 件も補正しない）

| 条件 | `disabledBy` | 理由 |
|---|---|---|
| 想定話者数が「自動」 | `auto` | 人数の申告が無いので減らす根拠が無い |
| 想定話者数が「N 人以上」 | `atLeast` | 上限が定まらない。**`count === 4` のハードコードにしない**（「4 人ちょうど」を将来足したときに黙って壊れる） |
| 検出話者数 ≦ 想定話者数 | `detectedNotOver` | 検出が想定以下なら減らす理由が無い |
| 総 word 数（または総文字数）< `MIN_TOTAL_WORDS_FOR_ISLANDS` | `tooFewWords` | 序盤は主要 speaker の順位が信用できない |

**「効いていない」と「効いた結果 0 件」は別の事実**なので、ゲートで空にした理由は
`disabledBy` として返し、診断に 1 行出す。

##### 判定

主要 speaker は統計の値の降順 → speaker 番号の昇順で上位 N 名。**tie-break を明示するのは
純関数の決定性のため**で、同数が上位 N の境界にまたがると順位が不定になる。minor は
「主要でない」かつ `ratio < MINOR_ISLAND_MAX_RATIO`。

発話行を 1 パスで走査し、**同一 minor speaker が連続する run** を切り出す。run は別の
speaker（主要でも別の minor でも）・話者不明・再接続の印で切れる。run 全体を寄せるのは
次を全部満たすときだけで、満たさなかった run は理由別に数える（`skipped`）。

1. run の前後に**確定 speaker つきの発話行**がある … 無ければ `edge`
2. run と前後の間に再接続の印が無い … あれば `boundary`
3. 前後の speaker が一致し、かつそれが主要 speaker … 違えば `mismatch`
4. run の合計 word 数 ≦ `MINOR_ISLAND_MAX_WORDS` … 超えれば `tooLong`

**run として切り出すことが要点。** 1 行ずつ判定すると `A → X → X → A` は
「1 つ目の X の次が X、2 つ目の X の前が X」で**一度も発火しない**が、実データはこの形で出る。
逆に **異なる minor が隣接したら run を切る** — `A → X → Y → A` の `X → Y` という遷移
**そのものが観測された話者交代**であり、またいで両方を A へ寄せると観測事実を消してしまう。

##### ①→② の順序が結果を変える

```
A → [jitter B] → minorX → A

  ② を先にすると … prev が B なので「前後が同じ主要 speaker」に当たらず補正されない
  ① を先にすると … B が A に直り、A → minorX → A が見えるので補正できる
```

どちらの段も自分の条件は緩めないまま、**後段が見える範囲だけが広がる**。順序は
`groupUtterances()` の中に閉じてあり、呼び出し側の規律にはしていない
（`tests/utterances.test.ts` に「順序を入れ替えたら落ちるテスト」がある）。

##### 主要 speaker は raw の統計から選ぶ

②に渡す統計は `collectSpeakerStats(finalLines)`、つまり**①を通す前の raw** から取る。
`tests/app-wiring.test.ts` が「`collectSpeakerStats` は `finalLines` に対して呼ぶ」を
固定しており（#46）、①通過後のコピーから取るとその不変条件が壊れる。実害の面でも、
①が動かすのは 4 文字以下の行だけなので word 数の順位は動かない。

##### 閾値（`public/utterances.js`。すべて 1 サンプル由来の暫定値）

| 定数 | 暫定値 | 役割 |
|---|---|---|
| `MINOR_ISLAND_MAX_RATIO` | 0.03 | **機械が黙って統合してよい**線 |
| `MINOR_ISLAND_MAX_WORDS` | 20 | 1 つの島として吸収してよい最大 word 数 |
| `MIN_TOTAL_WORDS_FOR_ISLANDS` | 200 | これ未満では主要 speaker の順位を信用しない |

**分母が文字数へ落ちるセッション（旧サーバー・#46 以前の保存データ）では補正しない**
（`charsBasis` ゲート）。閾値は word 数で決めた値で、文字数に当てると意味が変わり、しかも
**逆方向にずれる** — 日本語のおよそ 1 word ≒ 2 文字で見ると `MINOR_ISLAND_MAX_WORDS` は
厳しくなって取りこぼし、`MIN_TOTAL_WORDS_FOR_ISLANDS` は**緩くなって危険側に外れる**。
旧セッションのために補正精度を賭けない。

**`speaker-stats.js` の `MINOR_SPEAKER_RATIO`（5%）とは別物。** あちらは「**人が見て疑うべき**」
線で、診断の警告文（「偽 speaker の可能性」）にしか使わない。こちらは機械が自動で
ラベルを書き換える線なので、当然もっと厳しくなる。役割が違うので**名前とファイルの両方で
離してある** — 片方を実機データで動かしたときに、もう片方を触ったつもりにならないため。

##### 診断への出方

「話者分離の診断」に、raw の**検出話者数**と別ラベルで**表示上の通常話者数**（補正後の行から
`collectSpeakerStats()` で数える。#50 で中立化したぶんは除く）が並び、`### 表示補正（minor island）` として補正の
`from → to` 表・主要/minor/対象外の顔ぶれ・**見送りの理由別件数**が出る。#46 の「診断は raw から」は
崩していない（raw が主で、補正後は従の併記）。

**診断は必ず `planDisplayCorrection()` を通す。`planMinorIslandMerges()` を raw の
`finalLines` に直接当ててはいけない。** 表示に効くのは①jitter を通した後の行に対する計画なので、
raw から立てた計画とは**両方向にずれる**:

- jitter が先に島を潰していれば、raw の計画は #48 の手柄を過大に数える
- jitter が島を作っていれば、raw の計画は 0 件なのに表示では補正が効く
  （「表示補正 0 seg」と「表示上の話者数が減っている」が同じ節に並ぶ）

どちらも `skipped` の理由別内訳を事実と違う値にする。その内訳は閾値を決めるための唯一の
材料なので、ずれた数字は測定器の目盛りが狂っているのと同じ。**「統計を raw から取る」
（#46 の不変条件。こちらは正しい）と「走査する行の配列」は別の話**で、揃えるのは後者。

**見送りの内訳を出すのが要点。** 「`run が長い` が多い ⇒ `MINOR_ISLAND_MAX_WORDS` が狭すぎる」
と実データから読める。これが無いと人が閾値を決められない。会話本文は 1 文字も出ず、
出るのは speaker 番号・件数・word 数だけ。

#### 統合先を決められなかった minor speaker を中立化する（Issue #50）

#48 が安全に統合できたのは `A → X → A`（前後が同じ主要 speaker）だけで、残った
`B → X → A`（前後の主要 speaker が異なる ＝ `skipped.mismatch`）は見送っていた。
見送ったぶんは**表示上 minor X が「話者C」として残る**ため、2 人だと申告した会話に
第三者が発言したように見える。

**取る手は「A/B のどちらかへ推測で寄せる」ではなく「通常の追加話者として表示しない」。**
前後が違う以上どちらへ寄せても根拠が無く、寄せた側の発言として本文が残るほうが、
「誰の発言か決められなかった」と示すより誤解を生む。中立ラベルは **`話者不明`**
（`public/speaker-stats.js` の `UNRESOLVED_SPEAKER_LABEL` が唯一の定義箇所。画面・
Markdown・診断が同じ文言を引く）。

##### 対象は `mismatch` だけ

| 見送り理由 | 中立化 | なぜ |
|---|---|---|
| `mismatch` かつ run が上限以下 | する | 「統合先を安全に決められない」そのもの |
| `mismatch` かつ run が上限超え | しない | 下の `tooLong` と同じ理由。**③で長さを当て直す** |
| `tooLong` | しない | 誤割り当てされた**本物の発話**でありうる（隠すと発言者が消えたように見える） |
| `edge` / `boundary` / `unknown` | しない | そもそも隣を見られなかっただけで、島かどうかの判断が付いていない |

**③が長さ（`MINOR_ISLAND_MAX_WORDS`）を当て直すのが要点。** ②の判定順は
`mismatch → tooLong` なので、`B → X(長い) → A` は `mismatch` が先に立ち `tooLong` に
到達しない。③で当て直さないと「長い run は隠さない」という安全弁が**この段だけ効かず**、
上限なしで隠すことになる。落とした run は `tooLong` へ付け替えて返すので、診断の
「中立化の対象外」は②の「表示補正の見送り」とその差ぶんだけ違う数字になる。

`edge` / `unknown` を将来含めるかどうかは実機の件数を見てから決める
（[[termlens-open-issues]]）。判断できるよう、診断は**対象外の理由別件数**を必ず出す。

##### `speaker` を `null` に潰さない

③が立てるのは `unresolved: true` という印だけで、**raw の speaker 番号は表示用コピーにも
残す**。潰すと 2 つ壊れる。

1. `mergeSameSpeaker()` は `last.speaker === line.speaker` で結合するので、隣接した
   **異なる** minor が `null === null` で 1 段落に溶ける。`X → Y` という遷移そのものが
   観測された話者交代であり、②が run を切ってまで守った不変条件をここで崩す
2. 診断で追えなくなる。raw で speaker が付かなかった行（#46 の「話者不明のセグメント」）と
   「番号は付いたが統合先を決められなかった行」は別の事実で、閾値の材料になるのは後者だけ

したがって `mergeSameSpeaker()` は `unresolved` の行を**通常の発話とは絶対に結合しない**。
ただし**同じ raw speaker の中立行が続くときは 1 段落にまとめる** — run は「同一 minor の
連続」を別 speaker・話者不明・再接続で切って作ってあるので、隣接する中立行の speaker が
同じなら同じ run ＝ 1 つの発話のかたまりであり、ここで割ると #36 が正面から潰した
「1 発話が細切れに表示される」をこの段が作り直すことになる。`X → Y` は speaker が違うので
割れる。**`speaker` を残しているからこの 2 つを区別できる**。

##### 復元データ由来の `unresolved` は信じない

`finalLines` は `localStorage` から**検証なしで**復元されるので、`unresolved` にも任意の値が
入りうる。素通りさせると、想定話者数が既定の `auto`（＝この段が無効）でも画面には中立チップが
出て、診断は「無効（想定話者数が自動）」と言う — **画面と診断が違う事実を語る**。
`applyNeutralize()` は最初に印を落としてから計画を当てる（`definedSpeaker()` / `num()` /
`normalizeExpectedSpeakers()` と同じ、消費側で丸める規律）。

##### ②に `skippedRuns` を足した

③が「どの行を中立化するか」を知るには run の `indexes` が要る。②が見送り理由の**件数だけ**を
返す形のままだと③が run を切り直すことになり、「同一 minor の連続を、別 speaker・話者不明・
再接続で切る」という規則が 2 箇所に実装される。片方だけ直したときに②の見送り件数と③の
中立化件数が静かに食い違うので、②の戻りに
`skippedRuns: [{ reason, speaker, words, indexes }]` を足した。`skipped` の件数は互換のため
据え置きで、両者は同じ 1 つの関数を通るため構造上ずれない
（`tests/utterances.test.ts` が一致を固定している）。

##### ゲートは②と同一

②が `disabledBy` を持つならそのまま返して空の計画にする。**独自のゲートは足さない** —
「想定話者数を超えて検出された」という前提が無いところで minor を隠す根拠は無く、
ゲートを 2 組持つと「②は効いているのに③だけ無効」という説明のつかない状態が作れてしまう。

##### 表示上の話者数の定義が変わった

`planDisplayCorrection()` の `displayDetected` は「**表示上の通常話者数**」になった。
中立化した speaker は画面にも Markdown にも「話者C」として出ないので、数え続けると
「話者Cは表示されないのに表示上の話者数は 3」という読めない値になる。

**`collectSpeakerStats()` には手を入れない**（#46 の raw 統計の定義箇所）。数えるためだけの
ローカルなコピーで `unresolved` を speaker 不明へ落とす。**このコピーは表示に使わない** —
表示側は raw speaker を保持したままの配列を見る。

##### 診断への出方

`### 表示補正（minor island）` の中に続けて出る。会話本文は 1 文字も出ない。

```
- 表示上の通常話者数: 2
- 表示中立化: 1 seg / 2 word
- 表示中立化 2 → 話者不明: 1 seg / 2 word
- 中立化の対象外: run が長い 1 / 端 0 / 再接続境界 0 / 隣が話者不明 0
```

見出しを「表示中立化」にしたのは、**既存の「話者不明のセグメント」（#46。raw で speaker が
付かなかった行）と紛れないため**。表示上はどちらも「話者不明」と出るが、原因も対策も別
（前者は diarization そのものの問題、後者は #48 の統合条件の問題）で、同じ見出しに並ぶと
実データを見た人がどちらの数字を見ているのか分からなくなる。②と同じく「効いていない」
（ゲートで無効）と「効いた結果 0 件」も区別する。

#### 残っている弱点: 段落内の連結は半角スペース

同じ段落に入った行は、画面（`renderLine()`）でも Markdown（`texts.join(" ")`）でも
**半角スペースで連ねられる**。両者は一致しているので「表示とエクスポートで同じ結果」は満たすが、
#36 は「1 つの final の 1 文が割れたもの」を意図的に同じ段落へ入れる機能なので、
**日本語の文の途中にスペースが入るケースが増える**。下の「用語抽出バッファに空白が入る」と
同じ現象が、今回から表示・エクスポート側にも出るようになった。

直すなら、グループに `seq` の境界を持たせて連結子を出し分ける（同じ final 由来なら区切りなし）。
情報は手元にあるが、`mergeSameSpeaker()` がグループを作る時点で `seq` を捨てている。

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

> 2026-08-29 追記（Issue #36）: **表示の細切れだけが解消し、下記 3 つはそのまま残っている。**
> jitter 補正は表示・エクスポート用のコピーにしか効かず、raw の `finalLines` も抽出経路も
> 無変更のため。

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

## 発話単位の構築

> 2026-08-26 追加（Issue #21）: **`is_final` をそのまま用語抽出へ渡すのをやめ、
> `UtteranceBuilder`（`src/stt/utterance.ts`）で発話にまとめてから渡すようにした。**
> `is_final` は認識区間の確定であって人の意味的な発話完了ではないため、
> 文の途中で抽出が走り、文脈不足のまま LLM に渡っていた。

`split.ts` と同じく**依存ゼロ**で置いてある（import は `types.ts` の型のみ）。

### 表示と抽出で単位を分ける

```
STT の final ──┬─→ 表示用: そのまま send   ← 遅延ゼロ（従来と同じ）
               └─→ 抽出用: UtteranceBuilder → 発話が完成したら scheduler へ
```

**表示まで発話単位にすると確定テキストが数秒遅れる**ので分岐させている。
`protocol.ts` と `public/app.js` は無変更。

### 確定の契機は4つ

優先順位ではなく、どれか1つでも成立したら発話を閉じる。

| # | 契機 | 由来 |
|---|---|---|
| 1 | `speechFinal` が立った final を足した直後 | Deepgram の**無音**検出（`endpointing=300`） |
| 2 | `UtteranceEnd` を受信（バッファが空なら何もしない） | Deepgram の **word ギャップ**検出（`utterance_end_ms=1000`） |
| 3 | 最後の final から `UTTERANCE_TIMEOUT_MS`（3秒）経過 | どのシグナルも来ない場合の保険 |
| 4 | バッファが `MAX_UTTERANCE_CHARS`（500字）超過 | 病的ケースの保険 |

加えて、**話者が変わったら足す前に閉じる**（相槌や話者交代をまたいで結合しない）。

**`speech_final` と `UtteranceEnd` の両方を使うのは省略できない。** 公式ドキュメントは
「**背景ノイズがあると VAD が反応し続け、無音と判定されず `speech_final` が来ない**」ことを
明記しており、会議室のエアコン音・キーボード音がある本アプリの用途はまさにこれに当たる。
`UtteranceEnd` は音声を見ず word の時間ギャップだけで判定するのでこの失敗モードを迂回できる。

> **未検証**: 実機の Deepgram が日本語で `speech_final` / `UtteranceEnd` をどれだけ出すかは
> 確かめていない。どちらも来なければ発話は 3 秒のタイムアウト頼りで閉じることになり、
> 切れ目が会話の内容と無関係に決まる（[[termlens-open-issues]] の未検証1）。
>
> **`UtteranceEnd` は対応する final より先に届きうる**（そのために Deepgram は
> `last_word_end` を提供している）。先に届いた場合は発話が一足早く閉じ、直後の final が
> 短い発話になる。頻度が測れるまで `last_word_end` による並べ替えは入れていない。

`speech_final` が **transcript 空の Results に立つ**ことがある。イベントは発行できない
（空 transcript は送らない）が、終端シグナルまで捨てると確定契機が1つ黙って消えるので、
`UtteranceEnd` と同じ「境界だけ」の通知として `UtteranceBuilder` に伝えている。

### 話者不明の扱いは splitBySpeaker と同じ

`speaker` が `undefined` のイベントは**境界を作らず現在の発話に吸収**し、発話の speaker は
「その中で最初に現れた定義済み speaker」とする。`split.ts` とまったく同じ規則。
同じ「話者不明」に対して隣接する2層が逆の規則を持つと、diarize が一時的に speaker を
返さない final が1件挟まるだけで同一話者の発話が3つに割れる。

### speechFinal は分割後の最後の1件にだけ立てる

1つの Results が話者で N 分割された場合、`speechFinal` を立てるのは**最後のセグメントだけ**。
発話終端は「その Results の終わり」であって「各セグメントの終わり」ではないため、
全件に立てるとセグメントごとに発話が閉じ、分割（#20）と結合（#21）が噛み合わなくなる。

### 発話内の連結は区切り文字なし

`UtteranceBuilder` が担うのは「1つの発話を組み立てる」ことなので間に何も挟まない。
別々の発話をつなぐ `ExtractionScheduler` 側が `" "` 区切りなのとは役割が違う
（[[termlens-term-extraction]]）。副作用として、語の途中で final が割れると
`AWS` と `Lambda` が `AWSLambda` になりうる。#20 の切り出しと違い、ここには照合すべき
元の完全な文字列が存在しない（別々の Results なので）ため対処できない。
final は無音 300ms で切れるので語の途中で割れるのは稀、という前提に乗っている。

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

> 2026-08-26 変更（Issue #21）: mock は 1 行を `MOCK_WORDS_PER_FINAL`（4）語ごとの
> **複数の final に割って**出すようになった。1 行 = 1 final のままだと、
> 「複数 final を1発話に統合する」という `UtteranceBuilder` の中身が mock 上で
> **一度も発生せず**、通しても素通しになってテストが何も守らなかったため。
> 最後の final にだけ `speechFinal` を立てる。`UtteranceEnd` 相当は mock では発火させない
> （`onUtteranceEnd` は登録するだけ）。`mock-script.ts` は変更していない。
>
> 副作用として、mock では `public/app.js` の `finalLines` が行あたり数倍に増え、
> `SESSION_MAX_CHARS` の `localStorage` トリムが早く効く。**mock だけの話**で、
> 実 Deepgram の final の数は変わらない。

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

> 2026-08-27 変更（Issue #26）: **constraints を `public/app.js` から
> `public/capture-mode.js` へ移し、収音モードで切り替えられるようにした。** 既定の
> 「対面会議」は #26 以前の値と1バイトも変わっていない（`tests/capture-mode.test.ts` が
> **期待値をリテラルで持って**固定している。定義元から import すると、定義を変えたときに
> 一緒に動いて何も守らない）。

`getUserMedia` の constraints は **`public/capture-mode.js` の `CAPTURE_MODES` が唯一の
定義箇所**。`app.js` は `audioConstraints(mode)` を呼ぶだけで、値を持たない。両方に書くと
片方だけ変えてもテストが緑のまま通る。

| モード | echoCancellation | noiseSuppression | autoGainControl | channelCount |
|---|---|---|---|---|
| `meeting`（既定・対面会議） | false | false | true | 1 |
| `speaker`（スピーカー収音） | **true** | **true** | true | 1 |

対面会議でエコーキャンセルとノイズ抑制を切っているのは、どちらもブラウザ側で
「近くの1人の声」を残す方向に働き、会議室の離れた席の声を環境音として削ってしまうため。
距離差による音量差は自動ゲインで均す。

> **スピーカー収音の constraints は未検証。** 端末のマイクが自分のスピーカーの音を拾うと
> 同じ音が二重に入るので、それを消すエコーキャンセルは効くはず——という**仮説**で
> `true` にしてある。ただしブラウザのエコーキャンセルは「**自端末の**スピーカー出力を
> 参照して打ち消す」実装なので、**別の端末**のスピーカーを拾う場合は参照信号が無く
> 効かない可能性がある。実機で効かないようなら `false` に倒す
> （[[termlens-open-issues]]）。

モードは `localStorage`（`termlens.captureMode`）に保存する。**保存する以上、前回
スピーカー収音で使った設定のまま対面会議を始める事故が起きうる**ので、ホーム画面に
現在のモードを常時表示している（設定画面を開かないと分からない状態にしない）。
保存値は信頼境界の外なので `normalizeCaptureMode()` で必ず既知の名前に丸める
（素の `CAPTURE_MODES[mode]` だと `"constructor"` が truthy になり、`constraints` が
`undefined` のまま `getUserMedia` へ渡る）。

オンライン会議で端末のスピーカーから相手の声を出す使い方をする場合、`speaker` モードでも
足りなければタブ音声を直接取る方が精度は上。

## 収音の診断情報

> 2026-08-27 追加（Issue #26・案B）: 収音モードの差を**主観ではなく数値で**比べられるよう、
> 実際に適用された設定と入力統計を出せるようにした。

```
getUserMedia ─→ MediaStreamTrack.getSettings() ─→ pickTrackSettings() ─┐
AudioContext.sampleRate ───────────────────────────────────────────────┼→ 診断パネル
AudioWorklet（生入力の統計）─→ postMessage ─→ mergeAudioStats() ───────┘   収音診断.md
```

### getSettings() は採用リストで拾う

`getSettings()` は **`deviceId` / `groupId` を含む**。会話本文でも音声でもないが、
これは端末ごとに安定した識別子で、エクスポートすると**端末を特定できる値が外に出る**。
AC「診断情報に会話本文・音声を含めない」はプライバシーの要件なので、除外リストではなく
**採用リスト（`diagnostics.js` の `TRACK_KEYS`）**で書く。ブラウザが将来 `getSettings()` に
新しいキーを足しても、こちらが明示的に足さない限り診断には出ない。

`app.js` は**採用リストを通した後の値しか変数に持たない**。生の `getSettings()` を握った
変数を作らなければ、そこから表示・保存する経路もそもそも作れない。整形側
（`trackSettingRows()`）でももう一度通すので、呼び出し側が忘れても外へは出ない。

### 入力統計はローパス**前**の生入力から取る

`audio-processor.js` が生入力から集計し、約1秒ぶんまとめて `postMessage` する。
累積は `app.js` 側（`mergeAudioStats()`）。

- **生入力で取る。** 見たいのは「マイクが実際にどう入っているか」で、こちらで加工した
  後の波形ではない。`tests/audio-stats.test.ts` は**阻止域の 12kHz を入れて RMS が
  落ちない**ことで、ローパス後から取っていないことを判定している（順番を目で確かめる
  だけだと、後から `filter()` の後ろへ動かされて静かに壊れる）
- **FIR とダウンサンプルの経路には触っていない。** 加算と比較だけなので音声スレッドの
  負荷もほぼ増えない（実測 252ns/ブロック = リアルタイム予算の 0.0094%）

#### 閾値ではなく分布を出す

> 2026-08-28 変更（#26 のレビュー指摘）: 当初は `CLIP_THRESHOLD` (0.99) と
> `SILENCE_THRESHOLD` (0.01) の2つの閾値で数えた**比率だけ**を出していたが、
> **閾値を決めるために要る分布を、その閾値自身が壊していた**。無音率が 100% と出ても、
> 実際のノイズ底が -30dBFS なのか -60dBFS なのかは分からない。人タスク「実機の数値を見て
> 閾値を決める」が、その数値が出ていないので実行不能だった（#25 の `MAX_WEB_SEARCHES` と
> 同じ形）。
>
> **機構が足りていない印は差分の中に既にあった。** レビュー対応で足した `peak` の理由が
> 「クリップ率が 0% のとき、ピークが分からないと閾値の妥当性を判定できない」で、
> つまりコード自身が「このスカラーは背後の分布なしでは読めない」と書いていた。
>
> 今は worklet が**窓ごとの RMS を dBFS のビン（-80〜0dBFS を 5dB 幅で 16本）に積む**。
> 無音の水準（`SILENCE_DBFS = -40`）は**表示するときに当てる読み値**で、集計には効かない。
> 同じエクスポートを別の水準で読み直せるし、「この端末の底は -45dBFS」という端末ごとの
> 事実がそのまま数字になる（定数1本では代表できない量だった）。
>
> **クリップ側は分布にしていない。** 無音の水準は環境ノイズ次第で端末ごとに変わるが、
> クリップは「フルスケールに張り付いたか」で端末に依らない。しかも 0dBFS 直下の話なので、
> 5dB 幅のビンでは解像度が足りず分布にする利点がない（-5〜0dBFS が1本に潰れる）。
> 率が 0% のときの妥当性は `peak` で読める。

#### 無音判定の窓は時間で定義する

> 2026-08-28 変更（同上）: 当初は render quantum（128サンプル ≒ 2.7ms）を1単位として
> 無音を数えていたが、これは**分母が「`process()` が呼ばれた回数」**であって時間の割合では
> ない。ブラウザの実装粒度に依存するうえ、語間や破裂音の直前の谷まで無音に数える。
>
> 閾値は定数で変えられるのに窓長だけホストのブロック長に溶接されている、という非対称は
> 層として逆（可変にすべきなのは窓のほう）。`SILENCE_WINDOW_SEC = 0.1` をサンプル数に
> 換算して累積する形にしたので、分母が時間に揃い、「無音率(ブロック)」「クリップ率(サンプル)」
> という単位の注記も要らなくなった。

### 診断は独立した3つ目のエクスポート

既存の「文字起こし」「用語カード」とは別ファイル（`termlens-diagnostics-*.md`）にする。
実機比較の結果を共有するとき、**会話本文を含むファイルを渡さずに済む**ので、
AC の趣旨をファイルの単位でも守れる。

**未保存警告（「戻る」の破棄警告）の対象にはしていない。** 診断は会話本文ではないので、
対象にすると診断を見ていない大多数のセッションでも毎回警告が出て、本当に守りたい
文字起こし・用語カードの警告まで無視されるようになる。

### 統計は音声と同じ port を通る

メッセージは **`{ type: "audio" | "stats", ... }` の封筒**で送り、受け側は
`switch (e.data?.type)` で分岐して**扱わない種類は `default` で捨てる**。
判別しないと統計オブジェクトが音声ストリームに混ざってそのまま Deepgram へ送られる。
`tests/app-wiring.test.ts` が「`ws.send` が audio の枝の中だけにあること」を固定している
（純関数が正しくても配線が抜ければ壊れる、という #22 で踏んだ形そのもの）。

> 2026-08-28 変更（#26 のレビュー指摘）: 当初は `e.data instanceof ArrayBuffer` の**型**で
> 判別していたが、これは「ArrayBuffer 以外は全部統計」という分岐で、**判別の空間に3つ目の
> 席が無い**。worklet が3種類目（案C の confidence 集計、エラー通知など）を送ると、例外に
> ならず統計として畳み込まれる — しかも `num()` が未知の値を 0 に潰すので静かに壊れる。
> 名前で分ければ「明示的に扱わない種類は無視される」が既定になる。
> 音声は封筒に入れても transfer list はそのまま効く（コピーは発生しない）。

### word confidence は診断に入れていない

Issue #26 の元案には「平均 word confidence / 低 confidence 語率」があったが、
**`protocol.ts` の変更を伴う**ので入れていない（案C として先送り）。上の「クライアントには
送っていない」節のとおり、words そのものではなく集計値を送る形になる。まず案B で
「音がどう入っているか」を測り、それでも切り分けられない場合に足す順序。
