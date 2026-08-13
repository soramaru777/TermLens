---
title: TermLens STT パイプライン
type: concept
project: termlens
scope: shared
sources:
  - README.md
  - docs/local/status-2026-08-13.md
  - docs/raw/session-2026-08-13-fly-deploy.md
related: [[termlens-architecture]], [[termlens-term-extraction]], [[termlens-open-issues]], [[termlens-deployment]]
confidence: high
updated: 2026-08-13
---

# TermLens STT パイプライン

マイク音声を Deepgram に流し、文字起こしを UI と用語抽出の両方に配る部分。汎用的な知見は `~/wiki/knowledge/deepgram-streaming-ja.md` に切り出してある。

## 入力

ブラウザの AudioWorklet で 16kHz PCM16 に変換し、WebSocket のバイナリフレームで送る。サーバーはそのまま Deepgram の streaming API に中継する。

## Deepgram の設定

`nova-3` / `language=ja` / `diarize` / `keyterm` を有効化。`DEEPGRAM_MODEL` で `nova-2` に切り替えられるが、**語彙ブーストのパラメータ名が nova-3=keyterm / nova-2=keywords と異なる**ためアダプタ側で吸収している。

## 用語集ブースト

会議前に入力した用語集（参加者名・社名・専門用語）を keyterm prompting に渡す。**LLM による後段補正の前に、STT の段階で認識精度が上がる**のが利点。

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

**final が文の途中で切れることがある**ため、抽出チャンクが意味の切れ目で分断される場合がある。`endpointing` の調整余地あり（[[termlens-open-issues]] の弱点6）。

## mock モード

`STT_PROVIDER=mock` で、誤認識入りのダミー会議（3話者）が自動再生される。**API キーもマイクも不要**で、文字起こし → カード生成 → web 検索清書 → ハイライトまで全パイプラインを通せる。

開発とリグレッション確認の主力。既定値も `mock` になっている。
