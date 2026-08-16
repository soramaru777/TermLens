# TermLens

会議の会話をリアルタイムに文字起こしし、専門用語・固有名詞を検出して約100文字の解説カードを自動表示するPWA。スマホ / iPad / PCのブラウザで動作します。

打ち合わせ中に飛び交う知らない用語を、その場で「調べずに分かる」ようにすることが目的です。

## 主な機能

- **リアルタイム文字起こし** — Deepgram(Nova-3)のストリーミング音声認識。interim(未確定)→ final(確定)の2段階表示
- **話者分離** — 話者が変わると段落を分け、色付きの話者チップ(話者A/B/…)を表示
- **用語カード(二段構え)**
  - 速報: 会話から専門用語を検出し、LLMの知識によるドラフト解説を即表示
  - 清書: レア度上位の約半数の用語をweb検索し、最新情報に基づく約100文字の要約+**関連リンク3件**でカードを自動更新
- **誤認識復元** — 「クバネテス」→ Kubernetes のように、崩れた音声認識結果を文脈から正規化。確信度が低い場合は「もしかして?」バッジ付き
- **用語ハイライト** — カード化された用語は会話ログ内でオレンジ太字になり、タップすると該当カードへスクロール
- **用語集ブースト** — 会議前に入力した用語集(参加者名・社名・専門用語)をSTTのkeyterm promptingに渡し、認識精度を底上げ
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
| LLM | Anthropic Claude (既定: `claude-sonnet-5`) — 構造化出力 + web search tool |
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
| `ANTHROPIC_API_KEY` | ✅ | 用語抽出・web検索要約に使用 |
| `DEEPGRAM_API_KEY` | `deepgram`時 | ストリーミング音声認識に使用 |
| `STT_PROVIDER` | — | `deepgram` / `mock`(既定)。mockはキー・マイク不要のダミー会議再生 |
| `ANTHROPIC_MODEL` | — | 既定 `claude-sonnet-5`。`claude-opus-4-8`(高精度) / `claude-haiku-4-5`(安価)に切替可 |
| `DEEPGRAM_MODEL` | — | 既定 `nova-3`(keyterm方式)。`nova-2`(keywords方式)に切替可 |
| `AUTH_TOKEN` | 公開時 | 共有アクセストークン。未設定なら認証なし(ローカル開発用) |
| `PORT` | — | 既定 8080 |

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
fly secrets set ANTHROPIC_API_KEY=... DEEPGRAM_API_KEY=... AUTH_TOKEN=... --stage
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

## ライセンス

MIT License([LICENSE](LICENSE))。フォークして自由に使ってください。

ただし**ライセンスが許諾するのはこのリポジトリのコードのみ**です。Deepgram と Anthropic は
外部サービスであり、利用には各自でアカウントとAPIキーを取得し、それぞれの利用規約に同意する
必要があります。

外部からのプルリクエストは受け付けていません。理由は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。
