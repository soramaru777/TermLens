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

恒久エラー（4xx のうち SDK が再試行しないもの）では抽出を打ち切り、平易な文言で 1 回だけ
通知して再バッファしない。バッファには 2,000 文字の上限がある（[[termlens-open-issues]] の弱点12）。

> 2026-08-18 追記: **OpenAI へ移行したことで、残高切れの扱いが変わった。**
> Anthropic は残高切れを 400 で返すため 4xx の範囲判定だけで恒久と分類できたが、
> **OpenAI はレート超過と残高切れをどちらも 429 で返す**。429 は一時エラーとして
> 再試行する対象なので、ステータスだけで判定すると**残高切れを永久に再試行し、
> 弱点12 と同じ壊れ方をする**。`isQuotaExhausted()` で `insufficient_quota` /
> `billing_hard_limit_reached` を見て、429 のうち残高切れだけを恒久扱いにしている。

## デデュープ

既出用語の重複表示を、**プロンプト側の指示とサーバー側の正規化 Set** の二重で防いでいる。片方だけだと漏れる。

## 誤認識復元

STT が崩した表記を文脈から正規化し、`correctedFrom` に元の表記を残す。確信度が低い場合は UI に「もしかして?」バッジを出す。

STT 段階の keyterm ブーストと役割分担しており、**事前に用語集で拾えなかったものをここで回収する**構造。

## UI 連携

抽出結果には `surfaceForms`（会話中に現れうる表記ゆれ）が含まれ、`public/app.js` が文字起こし本文中の該当箇所をオレンジ太字にする。タップすると該当カードへスクロールする。
