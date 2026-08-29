---
title: TermLens アーキテクチャ
type: concept
project: termlens
scope: shared
sources:
  - README.md
related: [[termlens-stt-pipeline]], [[termlens-term-extraction]], [[termlens-deployment]]
confidence: high
updated: 2026-08-29
---

# TermLens アーキテクチャ

ブラウザで音声を拾い、WebSocket でサーバーに送り、STT と LLM を通して用語カードを返す単一プロセス構成。フレームワークを持たない素の HTML/JS フロントと、Node.js サーバーの2層のみ。

## データフロー

```
ブラウザ (public/)
  マイク → AudioWorklet (16kHz PCM16化) ─┐
  文字起こし表示・用語カードUI ←────────┤ WebSocket（音声=バイナリ / 制御=JSON）
                                         │
サーバー (src/)                          ▼
  session.ts ── STTアダプタ (stt/) ─── Deepgram streaming API
       │             └ mock.ts（キー不要のダミー会議再生）
       └ 抽出スケジューラ (extract/)
             ├ extractor.ts … Claude 構造化出力で用語抽出（速報）
             └ enrich.ts   … Claude + web search で要約+リンク（清書）
```

WebSocket 1本の中で、**音声はバイナリフレーム、制御メッセージは JSON** という使い分けをしている。

## 技術スタック

| 層 | 技術 |
|---|---|
| サーバー | Node.js 22 / TypeScript / Fastify / ws |
| STT | Deepgram Nova-3（streaming, ja, diarization, keyterm）— アダプタ切替式 |
| LLM | OpenAI GPT-5.6 Luna（既定 `gpt-5.6-luna`）— 構造化出力 + web search tool |
| フロント | フレームワークなしの素の HTML/JS/CSS（ビルド不要） |
| デプロイ | Docker + Fly.io |

フロントをビルドレスにしているため、`public/` を直接編集すれば反映される。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/session.ts` | WS / STT / 抽出のオーケストレータ。全体の要 |
| `src/stt/deepgram.ts` | Deepgram アダプタ（nova-3, diarize, keyterm, KeepAlive） |
| `src/stt/mock.ts` | キー・マイク不要のダミー会議再生 |
| `src/extract/extractor.ts` | 速報抽出（構造化出力、レア度・surfaceForms 付き） |
| `src/extract/enrich.ts` | 清書（web search、リンク収集、前置き除去） |
| `src/extract/scheduler.ts` | トリガー判定・デデュープ・清書対象の選定 |
| `public/app.js` | UI 全般（話者段落、用語ハイライト、カードジャンプ） |
| `public/utterances.js` | 表示・エクスポート用の発話グループ化（話者ラベルの揺れの補正 + 同一話者の結合、#36） |

## 設計上の選択

- **STT をアダプタ層で抽象化**した。Deepgram / mock を差し替えられ、キーなしで全パイプラインを検証できる（[[termlens-stt-pipeline]]）
- **用語解説を二段構え**にした。速報を即返して体感速度を確保し、web 検索結果で後から上書きする（[[termlens-term-extraction]]）
- **話者ラベルの揺れは表示側の後処理で直す。** STT の分割規則（`splitBySpeaker()`）は変えず、
  `public/utterances.js` がコピーの上で `speaker` だけを補正する。raw の文字起こしと用語抽出の
  経路は無変更で、**テキストは一切削除しない**（[[termlens-stt-pipeline]]）
- **状態をサーバーに永続化していない。** ブラウザメモリのみのため、リロードで全消失する（[[termlens-open-issues]] の弱点4）
