---
title: TermLens 用語抽出と解説カード生成
type: concept
project: termlens
scope: shared
sources:
  - README.md
  - docs/local/status-2026-08-13.md
  - docs/raw/session-2026-08-13-fly-deploy.md
related: [[termlens-architecture]], [[termlens-stt-pipeline]], [[termlens-open-issues]]
confidence: high
updated: 2026-08-13
---

# TermLens 用語抽出と解説カード生成

文字起こしから専門用語を検出し、約100文字の解説カードとして表示する中核機能。汎用的な実装知見は `~/wiki/knowledge/anthropic-structured-output-websearch.md` に切り出してある。

## 二段構え

体感速度と情報鮮度を両立させるための構成。

1. **速報** — `extractor.ts`。Claude の構造化出力で用語を抽出し、内部知識によるドラフト解説を即座に表示する
2. **清書** — `enrich.ts`。web search tool で最新情報を取得し、約100文字の要約 + 関連リンク3件に `card_update` メッセージで差し替える

## トリガー

`scheduler.ts` が判定する。

- 確定文字起こしが **120文字** 溜まる、**または** 前回から **10秒** 経過
- チェック間隔は5秒

## 清書対象の絞り込み

コスト制御のため、**LLM が判定したレア度の上位およそ半数だけ**を清書対象にし、1用語あたりの検索は最大1回（`max_uses: 1`）に制限している。

**この選定は一発勝負で、漏れた用語は以後も検索されない**（[[termlens-open-issues]] の弱点7）。

## 失敗時の挙動

抽出に失敗すると `scheduler.ts` は**そのチャンクをバッファの先頭に戻して次回に回す**。
一時的なエラーからは自動的に復帰できる設計。

ただし**エラーの種別を区別していない**ため、400（クレジット残高切れなど）のように成功し得ない
エラーでも同じく再試行し、バッファが際限なく肥大する。2026-08-13 に実際に発生した
（[[termlens-open-issues]] の弱点12）。

なお Anthropic SDK 自体は 400 を再試行しない（429/5xx のみ）。連続失敗として数えられるのは
スケジューラのトリガー回数。6 回ごとに UI へ通知される。

## デデュープ

既出用語の重複表示を、**プロンプト側の指示とサーバー側の正規化 Set** の二重で防いでいる。片方だけだと漏れる。

## 誤認識復元

STT が崩した表記を文脈から正規化し、`correctedFrom` に元の表記を残す。確信度が低い場合は UI に「もしかして?」バッジを出す。

STT 段階の keyterm ブーストと役割分担しており、**事前に用語集で拾えなかったものをここで回収する**構造。

## UI 連携

抽出結果には `surfaceForms`（会話中に現れうる表記ゆれ）が含まれ、`public/app.js` が文字起こし本文中の該当箇所をオレンジ太字にする。タップすると該当カードへスクロールする。
