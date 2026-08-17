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
updated: 2026-08-16
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
| `OPENAI_API_KEY` | ✅ | 用語抽出・web 検索要約 |
| `DEEPGRAM_API_KEY` | `deepgram` 時 | ストリーミング音声認識 |
| `STT_PROVIDER` | — | `deepgram` / `mock`（既定）。mock はキー・マイク不要 |
| `LLM_MODEL` | — | 既定 `gpt-5.6-luna`。`gpt-5.6-terra` / `gpt-5.6-sol` に切替可 |
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
flyctl secrets set OPENAI_API_KEY=... DEEPGRAM_API_KEY=... AUTH_TOKEN=... --stage
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
| `fly.toml` の `LLM_MODEL` | `.env` と食い違うと本番だけ別モデルで動く。過去に `opus-4-8` と `sonnet-5` で不一致していた |
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
| `/api/info` | `deepgram` / `gpt-5.6-luna` / `authRequired: true` |
| WS トークンなし / 誤トークン | 401 拒否 |
| WS 正トークン | 接続成功 |

curl の手書き Upgrade ヘッダでは正しいハンドシェイクにならず、Fastify が通常の GET として 404 を
返す。**認証の検証には本物の WS クライアントが必要。**

## セキュリティ

- WebSocket 認証トークンは URL クエリではなく **`Sec-WebSocket-Protocol` ヘッダ**で送信する。URL に載せるとログや履歴に残るため
- トークン照合は SHA-256 でハッシュ化してから `timingSafeEqual` で比較する（`src/server.ts`）。タイミング攻撃で先頭から 1 文字ずつ特定されるのを防ぐため
- カード描画は DOM API（`textContent`）ベースで XSS 対策済み
- 認証は**単一の共有トークン**で、ローテーションは手動（[[termlens-open-issues]] の運用11）

### AUTH_TOKEN の強度要件

**暗号論的乱数から生成した 128 bit 以上の値を使う**（`openssl rand -hex 16` = 32 文字）。
自分で考えた文字列は長さのわりに実効エントロピーが低いため使わない。

`*.fly.dev` のホスト名は証明書の Certificate Transparency ログに載るため URL は秘匿できない。
`fly.toml` にアプリ名が書かれている以上、リポジトリ公開後は URL が自明になる。
**URL の秘匿は防御にならず、防御はトークンの強度のみが担う。**

16 進数を勧めるのはセキュリティ上の理由ではなく入力性による。base64 は大文字小文字と
`+` `/` が混在し、iPad の Safari で手入力すると誤りやすい。

### レート制限を設けない判断（2026-08-16）

WS 認証失敗に回数制限を設けていない。**トークンが 128 bit あるため総当たりが成立せず、
制限する対象が存在しない**ため。ネットワーク越しの試行は 1 回ごとに TLS ハンドシェイクを
要し、毎秒 100 万回という非現実的な速度を仮定しても 64 bit で 29 万年かかる。

実装しない理由は「不要だから」であって、コストが理由ではない。ただし実装した場合の
副作用も小さくない。

- **ブラウザは 401 と 429 を区別できない。** WebSocket API はハンドシェイク失敗時の HTTP
  ステータスを JS に渡さず、`close` の code は一律 1006 になる（`public/app.js`）。正しい
  トークンでも「トークンを確認してください」と表示され続ける状態が生じる
- **Fly のプロキシ配下では `remoteAddress` がプロキシの IP になる。** 全利用者が同一バケットに
  入り、攻撃者 1 人が閾値を使い切ると正規利用者も締め出される。`Fly-Client-IP` を読む必要がある
- **`auto_stop_machines` でマシンが停止するとメモリ上のカウンタが消える**

トークンを弱いものに変える場合はこの判断が崩れる。その時は上記3点ごと再検討すること。

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
