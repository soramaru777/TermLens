---
title: TermLens STT パイプライン
type: concept
project: termlens
scope: shared
sources:
  - README.md
  - docs/local/status-2026-08-13.md
  - docs/raw/session-2026-08-13-fly-deploy.md
related: [[termlens-architecture]], [[termlens-term-extraction]], [[termlens-open-issues]], [[termlens-deployment]], [[termlens-testing]]
confidence: high
updated: 2026-08-25
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
`dominantSpeaker()` がセグメント内の単語の多数決で話者番号を決める（`src/stt/deepgram.ts`）。

**開始直後は分離が効かない。** Deepgram のストリーミング diarization は音声を蓄積して声を
クラスタリングするため、判別材料が溜まるまで全員を話者0に寄せる。仕様上の挙動であり実装のバグではない。
「会話開始から数分しないと機能しない」という観察はこれで説明できる。

**合成音声（macOS `say`）では全発言が話者0になり分離しない。** テストには実声が必要。

2026-08-13 に iPad 実機で話者チップの表示までは確認したが、**話者が 1 人だったため分離精度は未検証**。
加えて当時は Fly のトライアル制限でセッションが 5 分で切れており、分離が効き始める時間帯に
ほぼ到達できていなかった（[[termlens-deployment]]、[[termlens-open-issues]] の未検証1）。

## interim / final

interim（未確定）を薄く表示し、final（確定）で置き換える2段階表示。final のテキストが用語抽出の入力になる。

> 2026-08-20 対応: **final が文の途中で切れる**問題（弱点6）に対し、`endpointing=300` を
> 指定した。既定値は 10ms で、わずかな間でも確定してしまう。300ms にすると自然な文単位で
> まとまり、`smart_format` の句読点も付きやすくなる。
>
> ただし長くしすぎると 1 セグメントに複数話者が入り、**話者判定（`dominantSpeaker` の
> 多数決）が鈍る**。話者の切り替わりの間は通常 300ms より長いので実用上は問題ない想定だが、
> さらに上げるときはこのトレードオフを意識すること。

## mock モード

`STT_PROVIDER=mock` で、誤認識入りのダミー会議（3話者）が自動再生される。**API キーもマイクも不要**で、文字起こし → カード生成 → web 検索清書 → ハイライトまで全パイプラインを通せる。

開発とリグレッション確認の主力。既定値も `mock` になっている。


## マイクの取得設定

対面の会議で使う前提のため、`getUserMedia` では **エコーキャンセルとノイズ抑制を切って
いる**（`public/app.js`）。どちらもブラウザ側で「近くの1人の声」を残す方向に働き、
会議室の離れた席の声を環境音として削ってしまうため。距離差による音量差は自動ゲインで均す。

オンライン会議で端末のスピーカーから相手の声を出す使い方をする場合は、エコーキャンセルを
戻す必要がある。その場合はタブ音声を直接取る方が精度は上。
