# TermLens

[![Deploy](https://github.com/soramaru777/TermLens/actions/workflows/deploy.yml/badge.svg?branch=develop)](https://github.com/soramaru777/TermLens/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PWA](https://img.shields.io/badge/PWA-5A0FC8?logo=pwa&logoColor=white)](public/manifest.webmanifest)
[![PRs: not accepted](https://img.shields.io/badge/PRs-not%20accepted-lightgrey.svg)](CONTRIBUTING.md)

会議の会話をリアルタイムに文字起こしし、専門用語・固有名詞を検出して約100文字の解説カードを自動表示するPWA。スマホ / iPad / PCのブラウザで動作します。

打ち合わせ中に飛び交う知らない用語を、その場で「調べずに分かる」ようにすることが目的です。

## 主な機能

- **リアルタイム文字起こし** — Deepgram(Nova-3)のストリーミング音声認識。interim(未確定)→ final(確定)の2段階表示
- **話者分離** — 話者が変わると段落を分け、色付きの話者チップ(話者A/B/…)を表示
- **用語カード(二段構え)**
  - 速報: 会話から専門用語を検出し、LLMの知識によるドラフト解説を即表示
  - 清書: レア度上位の約半数の用語をweb検索し、最新情報に基づく約100文字の要約+**関連リンク3件**でカードを自動更新
- **誤認識復元** — 「クバネテス」→ Kubernetes のように、崩れた音声認識結果を文脈から正規化。確信度が低い場合は「もしかして?」バッジ付き
- **用語ハイライト** — カード化された用語は会話ログ内でオレンジ太字になり、タップすると該当カードを表示
- **スマホでは1枚表示** — 画面が狭いときはカードを最新1枚だけ表示。会話中の用語をタップするとその語に固定し、「最新」ボタンで追従に戻る。横向きの広い画面では従来どおり一覧表示
- **用語集ブースト** — 会議前に入力した用語集(参加者名・社名・専門用語)をSTTのkeyterm promptingに渡し、認識精度を底上げ
- **Markdownエクスポート** — 停止後に文字起こしと用語カードをそれぞれ `.md` でダウンロード。文字起こしは話者ごとの段落+会議開始からの経過時間、用語カードは解説と関連リンクを登場順に出力
- **自動再接続** — 回線が切れても指数バックオフ(1/2/4/8/16秒)で再接続し、会議を続行。再接続すると話者ラベルが振り直されるため、文字起こしとエクスポートに区切りを入れる
- **セッション復元** — 文字起こしと用語カードをこの端末に保存し、リロードやタブ破棄のあとでも復元してダウンロードできる。音声は保存しない。24時間で自動削除。設定でOFFにできる
- **PWA** — ホーム画面に追加してアプリのように起動。画面ロック防止(Wake Lock)対応

## アーキテクチャ

```
ブラウザ (public/)
  マイク → AudioWorklet (16kHz PCM16化) ─┐
  文字起こし表示・用語カードUI ←────────┤ WebSocket (音声=バイナリ / 制御=JSON)
                                         │
サーバー (src/)                          ▼
  session.ts ── STTアダプタ (stt/) ─── Deepgram streaming API (nova-3, ja, diarize, keyterm)
       │             └ mock.ts (キー不要のダミー会議再生モード)
       └ 抽出スケジューラ (extract/)
             ├ extractor.ts … Claude 構造化出力で用語抽出 (速報)
             └ enrich.ts   … Claude + web search で最新情報要約+リンク (清書)
```

- 抽出トリガー: 確定文字起こしが120文字溜まる、または前回から10秒経過
- 既出用語はプロンプト+サーバー側正規化Setの二重デデュープ
- web検索はLLMが判定したレア度上位の約半数のみ・用語1件あたり最大1回

## 技術スタック

| 層 | 技術 |
|---|---|
| サーバー | Node.js 22 / TypeScript / Fastify / ws |
| STT | Deepgram Nova-3 (streaming, 日本語, diarization, keyterm) — アダプタ切替式 |
| LLM | OpenAI GPT-5.6 Luna (既定: `gpt-5.6-luna`) — 構造化出力 + web search tool |
| フロント | フレームワークなしの素のHTML/JS/CSS (ビルド不要) |
| デプロイ | Docker + Fly.io (`fly.toml` 同梱) |

## セットアップ

```sh
npm install
cp .env.example .env   # 下表を参照して設定
npm run gen-icons      # PWAアイコン生成(初回のみ)
npm run dev            # http://localhost:8080
```

### 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | 用語抽出・web検索要約に使用 |
| `DEEPGRAM_API_KEY` | `deepgram`時 | ストリーミング音声認識に使用 |
| `STT_PROVIDER` | — | `deepgram` / `mock`(既定)。mockはキー・マイク不要のダミー会議再生 |
| `LLM_MODEL` | — | 既定 `gpt-5.6-luna`(安価・高速)。`gpt-5.6-terra` / `gpt-5.6-sol` に切替可 |
| `DEEPGRAM_MODEL` | — | 既定 `nova-3`(keyterm方式)。`nova-2`(keywords方式)に切替可 |
| `MAX_WEB_SEARCHES` | — | 1カードの検証で許す web 検索の回数。既定 5、`0` で上限なし(計測用) |
| `AUTH_TOKEN` | 公開時 | 共有アクセストークン。未設定なら認証なし(ローカル開発用) |
| `PORT` | — | 既定 8080 |

### テスト

```sh
npm test          # 決定的テストのみ。LLM は呼ばず数百msで終わる(CIが常時回す)
npm run typecheck # tsc --noEmit -p tsconfig.test.json
npm run eval:llm  # 用語抽出の精度をLLMで評価する(実API課金あり・オプトイン)
```

用語抽出の精度評価は既定では実行されません。`npm test` の中で回すには `RUN_LLM_EVAL=1` を
指定します。指標と評価ケースの詳細は `docs/wiki/termlens-testing.md` を参照してください。

> `tsconfig.json` に `tests/` を足さないでください。`rootDir` が繰り上がって出力が
> `dist/src/server.js` にずれ、`npm start` と Dockerfile が壊れます。型チェックは
> 専用の `tsconfig.test.json` で行います。
>
> `tsconfig.json` の `exclude` にある `src/eval` も外さないでください。外すと
> `dist/eval/` が生成され、評価ハーネスが本番イメージに同梱されます。`src/eval` の
> 型チェックは `tsconfig.test.json`（`"exclude": []`）が担当します。

### 開発のヒント

- `STT_PROVIDER=mock` にすると、誤認識入りのダミー会議(3話者)が自動再生され、文字起こし→カード→web検索清書→ハイライトまで全パイプラインをキーなし・マイクなしで確認できます
- localhostはsecure context扱いのため、マイクテストにHTTPSは不要です(スマホ実機はHTTPS必須)

## リリース (Fly.io)

公開先: https://termlens-tatsu.fly.dev/

**`develop` がリリースブランチです。** マージすると GitHub Actions が走り、自動でデプロイされます。手動操作は不要です。

| イベント | 動作 |
|---|---|
| `develop` への push | ビルド確認 → デプロイ → ヘルスチェック |
| `develop` 宛の PR | ビルド確認 + Claude によるコードレビュー(デプロイはしない) |

環境は1つだけ(`develop` → 本番)で、ステージングは設けていません。

### 手動デプロイ(初回構築時・CIが使えないとき)

```sh
fly apps create <app-name>          # アプリ名は Fly 全体でユニーク
fly secrets set OPENAI_API_KEY=... DEEPGRAM_API_KEY=... AUTH_TOKEN=... --stage
fly deploy --remote-only            # リモートビルドのためローカルDockerは不要
```

`fly launch` は作り込んだ `fly.toml` を書き換えることがあるため使いません。

スマホ/iPadのSafariで公開URLを開き、共有 → ホーム画面に追加。

## コストの目安(1時間の会議)

| 項目 | 概算 |
|---|---|
| Deepgram Nova-3 streaming | 約$0.46 |
| Claude Sonnet 5(抽出+要約) | 約$1〜2 |
| web search(用語15件×1検索) | 約$0.15 |
| **合計** | **約$2〜3(約300〜450円)** |

## セキュリティ

- WebSocket認証トークンはURLクエリではなく `Sec-WebSocket-Protocol` ヘッダで送信(ログ・履歴への漏えい防止)
- APIキーは `.env`(git対象外)で管理。カード描画はDOM API(`textContent`)ベースでXSS対策済み
- 用語カードの関連リンクは `http(s)` のスキームのみ採用。サーバー側とクライアント側の両方で検証する
- セッション復元で端末に保存するのは文字起こしと用語カードのテキストのみ。音声とアクセストークンは保存しない。24時間で自動削除され、設定でOFFにできる

## ライセンス

MIT License([LICENSE](LICENSE))。フォークして自由に使ってください。

ただし**ライセンスが許諾するのはこのリポジトリのコードのみ**です。Deepgram と OpenAI は
外部サービスであり、利用には各自でアカウントとAPIキーを取得し、それぞれの利用規約に同意する
必要があります。

外部からのプルリクエストは受け付けていません。理由は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。
