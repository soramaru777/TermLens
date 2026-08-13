---
title: TermLens デプロイと運用
type: howto
project: termlens
scope: shared
sources:
  - README.md
  - docs/local/status-2026-08-13.md
  - docs/raw/session-2026-08-13-fly-deploy.md
related: [[termlens-architecture]], [[termlens-open-issues]], [[termlens-stt-pipeline]]
confidence: high
updated: 2026-08-14
---

# TermLens デプロイと運用

## ローカル起動

```sh
npm install
cp .env.example .env
npm run gen-icons      # PWA アイコン生成（初回のみ）
npm run dev            # http://localhost:8080
```

localhost は secure context 扱いのため、**マイクテストに HTTPS は不要**。ただしスマホ実機は HTTPS 必須。

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | 用語抽出・web 検索要約 |
| `DEEPGRAM_API_KEY` | `deepgram` 時 | ストリーミング音声認識 |
| `STT_PROVIDER` | — | `deepgram` / `mock`（既定）。mock はキー・マイク不要 |
| `ANTHROPIC_MODEL` | — | 既定 `claude-sonnet-5`。opus / haiku に切替可 |
| `DEEPGRAM_MODEL` | — | 既定 `nova-3`（keyterm 方式）。`nova-2` は keywords 方式 |
| `AUTH_TOKEN` | 公開時 | 共有アクセストークン。未設定なら認証なし（ローカル開発用） |
| `PORT` | — | 既定 8080 |

**値そのものは `.env` にのみ置き、Wiki には書かない。**

## リリース: develop へマージすると自動デプロイ

**公開先: https://termlens-tatsu.fly.dev/** （リージョン nrt、イメージ 70MB）

**`develop` がリリースブランチ。** ここに push（マージ）されると GitHub Actions
（`.github/workflows/deploy.yml`）が走り、本番へデプロイされる。手動操作は不要。

| イベント | 動作 |
|---|---|
| `develop` への push | ビルド確認 → `flyctl deploy --remote-only` → `/healthz` を最大10回ポーリング |
| `develop` 宛の PR | ビルド確認のみ。デプロイはしない |
| 手動 | `workflow_dispatch` で任意に実行できる |

build ジョブで先に `tsc` を通すのは、型エラーをリモートビルド前に落として失敗を速くするため。

**環境は1つだけ**（develop → 本番）。`main` は 2026-08-13 時点の状態で止まっており、
現在は使っていない。ステージングは設けていない。

### CI の認証

`flyctl tokens create deploy` で発行した**アプリスコープ限定のトークン**を、リポジトリの
シークレット `FLY_API_TOKEN` に登録している。組織全体の権限を持つ個人トークンは使わない。
有効期限は1年（2027-08 頃に更新が必要）。

サードパーティのアクションは**コミット SHA に固定**する。タグは付け替え可能なため、
バージョンタグでも固定にはならない。ワークフローの既定権限は `contents: read`。

### 手動デプロイ（初回構築時・CI が使えないとき）

```sh
flyctl apps create termlens-tatsu
flyctl secrets set ANTHROPIC_API_KEY=... DEEPGRAM_API_KEY=... AUTH_TOKEN=... --stage
flyctl deploy --remote-only
```

**リモートビルド（`--remote-only`）を使えばローカルの colima は不要。**

> 2026-08-13 更新: 以前は `fly launch --no-deploy` と書いていたが、**`fly launch` は作り込んだ
> `fly.toml` を書き換えることがある**ため `apps create` + `deploy` に改めた。またアプリ名は Fly 全体で
> グローバルユニークのため、`termlens` ではなく `termlens-tatsu` を使っている。

デプロイ後、スマホ/iPad の Safari で公開 URL を開き、共有 → ホーム画面に追加で PWA として起動できる。

### 事前に必要な設定

| 対象 | 内容 |
|---|---|
| `.dockerignore` | **必須。** 無いと `.env`（APIキー平文）と `node_modules` がリモートビルダーへ送信される |
| `fly.toml` の `ANTHROPIC_MODEL` | `.env` と食い違うと本番だけ別モデルで動く。実際に `opus-4-8` と `sonnet-5` で不一致していた |
| `AUTH_TOKEN` | deploy **前**に投入する。未設定だと `config.ts` が認証を自動的に無効化する（警告ログのみ） |
| `[[http_service.checks]]` | 明示しないとヘルスチェックが設定されない（`/healthz`、interval 30s） |

### マシン構成

初回デプロイでは `min_machines_running = 0` を設定していても **HA のため 2 台**作られる。
`fly scale count 1` で 1 台に減らした（2026-08-13）。

状態をメモリに持つ設計のため 2 台構成に恩恵がない。セッションを保持しているマシンが落ちたら
もう 1 台があっても引き継げないため（[[termlens-open-issues]] の弱点4）。

`fly machines list` で `stopped` / `CHECKS 0/1` と出るのは `auto_stop_machines = "stop"` による
正常なアイドル停止。接続中の WebSocket があれば停止しない。

### 運用上の罠: トライアルの 5 分制限

**カード未登録だとマシンが起動から 301 秒で強制停止される。** デプロイ自体は成功するため、
問題は実行時間として現れる。会議中に文字起こしが止まって「切断されました」と出る症状の原因になった。
カード登録で解消。

汎用的な Fly.io の知見は `~/wiki/knowledge/fly-io-deployment.md` に切り出してある。

## デプロイ後の検証結果（2026-08-13）

| 項目 | 結果 |
|---|---|
| `/healthz` | 200（東京から 48ms） |
| `/api/info` | `deepgram` / `claude-sonnet-5` / `authRequired: true` |
| WS トークンなし / 誤トークン | 401 拒否 |
| WS 正トークン | 接続成功 |

curl の手書き Upgrade ヘッダでは正しいハンドシェイクにならず、Fastify が通常の GET として 404 を
返す。**認証の検証には本物の WS クライアントが必要。**

## セキュリティ

- WebSocket 認証トークンは URL クエリではなく **`Sec-WebSocket-Protocol` ヘッダ**で送信する。URL に載せるとログや履歴に残るため
- カード描画は DOM API（`textContent`）ベースで XSS 対策済み
- 認証は**単一の共有トークン**で、ローテーションは手動（[[termlens-open-issues]] の運用11）

## git push が 404 になるとき

private リポジトリへの push が `Repository not found` で失敗する場合、リポジトリの不在ではなく
**権限のないアカウントで認証されている**可能性が高い。GitHub は権限のない private リポジトリに
403 ではなく 404 を返すため。

原因は credential helper の**評価順**にあることが多い。git は helper を上から順に試し、
最初に資格情報を返したものを採用する。macOS では システム設定の `osxkeychain` が先に評価され、
リポジトリローカルに `!gh auth git-credential` を設定していても呼ばれない。

```sh
git config --get-all credential.helper          # 適用順を確認
printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain get   # keychain 側の username を確認
```

リポジトリローカルで**空文字を挟んで前段をリセット**すると解決する。

```sh
git config --local --unset-all credential.helper
git config --local --add credential.helper ""            # ここまでをリセット
git config --local --add credential.helper "!gh auth git-credential"
```

この設定は `.git/config` に入るのでこのリポジトリ限定。keychain の資格情報は削除しないので、
他のアカウントを使う作業には影響しない。

## コスト（1時間の会議）

| 項目 | 概算 |
|---|---|
| Deepgram Nova-3 streaming | 約 $0.46 |
| Claude Sonnet 5（抽出 + 要約） | 約 $1〜2 |
| web search（用語15件 × 1検索） | 約 $0.15 |
| **合計** | **約 $2〜3（約300〜450円）** |

> 2026-08-13 更新: Sonnet 5 の $2/$10 per MTok が恒久価格になり、9月の値上げは行われないと公式発表。以前想定していた「導入価格が 2026-08-31 で終了」は撤回され、LLM 費は現状維持。
