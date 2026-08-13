# セッション記録 2026-08-13 — Fly.io デプロイと iPad 実機テスト

作業ログの生記録。以後書き換えない。

## 1. Sonnet 5 価格の確認

公式ドキュメント（platform.claude.com/docs/en/about-claude/pricing）で確認:

> The $2/$10 per million input/output token pricing for Claude Sonnet 5, announced at launch as
> introductory pricing through August 31, 2026, is now the standard price. The previously scheduled
> increase to $3/$15 per million input/output tokens on September 1, 2026 will not occur.

- Sonnet 5: $2 / MTok(入力)、$10 / MTok(出力)。Batch は $1 / $5、キャッシュヒット $0.20 / MTok
- 「導入価格が 2026-08-31 で終了」という前提は撤回された

## 2. デプロイ先の比較検討

TermLens の要件: ①クライアントとの長時間 WebSocket ②サーバから Deepgram への常時 WebSocket
③会議中ずっと生きているセッション状態。

| 候補 | 判定 | 理由 |
|---|---|---|
| Fly.io | 採用 | 現行 Dockerfile がそのまま動く。WS の時間上限なし |
| Cloudflare Workers + Durable Objects | 将来の候補 | アーキテクチャ的には最良だが全面書き換えが必要 |
| Cloud Run（Firebase の実体） | 不可 | リクエスト最大 60 分。WS もこの上限に縛られる |
| Firebase Hosting / Functions | 不可 | Hosting は静的のみ。Functions 2nd gen は Cloud Run と同じ制約 |
| Supabase | ホストとしては不可 | Edge Functions は有料でも wall clock 400 秒、CPU 2 秒/リクエスト |

補足:
- 2026-06-19 の Cloudflare 変更で、外向き WebSocket 接続が Durable Object の退避を防ぐようになった
  （退避防止は 1 接続あたり最大 15 分。内向きトラフィックが続く限り実害なし）
- Supabase は永続化層としてなら候補になる（会議ログ保存・セッション復元）
- ホスティング費はどの選択肢でも LLM+STT の $2〜3/時間 に比べれば誤差

## 3. デプロイ前に修正した点

| # | 問題 | 対処 |
|---|---|---|
| A | `.dockerignore` が存在せず、`.env`（APIキー平文）と `node_modules` がビルドコンテキストに含まれる | `.dockerignore` を新規作成 |
| B | fly.toml の `ANTHROPIC_MODEL` が `claude-opus-4-8`、`.env` は `claude-sonnet-5` | fly.toml を `claude-sonnet-5` に統一 |
| C | `AUTH_TOKEN` 未設定だと `config.ts` が認証を自動的に無効化する（警告ログのみ） | deploy 前に `fly secrets set` |
| D | アプリ名 `termlens` は Fly 全体でグローバルユニーク | `termlens-tatsu` に変更 |

fly.toml には `[[http_service.checks]]`（`/healthz`、interval 30s）も追加した。

## 4. デプロイ手順（実際に成功したもの）

```sh
brew install flyctl
flyctl auth login          # 対話操作。本物の TTY が必要
flyctl apps create termlens-tatsu
flyctl secrets set ANTHROPIC_API_KEY=... DEEPGRAM_API_KEY=... AUTH_TOKEN=... --stage
flyctl deploy --remote-only
```

- `fly launch` は既存 fly.toml を書き換えることがあるため `apps create` + `deploy` を使った
- `--remote-only` によりローカル Docker（colima）は不要
- イメージサイズ 70MB、リージョン nrt
- 初回デプロイで **HA のためマシンが 2 台**作られた（`min_machines_running = 0` を設定していても）。
  抑制するには `fly deploy --ha=false`。後から `fly scale count 1` で 1 台に減らした

公開 URL: https://termlens-tatsu.fly.dev/

## 5. デプロイ後の検証結果

| 項目 | 結果 |
|---|---|
| `/healthz` | 200（東京から 48ms） |
| `/api/info` | `deepgram` / `claude-sonnet-5` / `authRequired: true` |
| WS トークンなし | 401 拒否 |
| WS 誤トークン | 401 拒否 |
| WS 正トークン | 接続成功 |

curl で手書きの Upgrade ヘッダを送る方法では正しい WebSocket ハンドシェイクにならず、
Fastify が通常の GET として扱って 404 を返した。認証の検証には本物の WS クライアントが必要。

## 6. Fly トライアルの 5 分制限

カード未登録の状態では、マシンが起動から 301 秒で強制停止される。ログ:

```
runner[...] warn: Trial machine stopping. To run for longer than 5m0s,
  add a credit card by visiting https://fly.io/trial.
app[...] INFO Sending signal SIGINT to main child process
app[...] [ 301.086340] reboot: Restarting system
```

会議中に文字起こしが止まり「切断されました」と表示された原因はこれ。カード登録後に解消。

デプロイ自体はカード未登録でも成功するため、**制限は実行時間として現れる**（デプロイ時のエラーではない）。

## 7. iPad 実機テスト結果

- マイク許可・音声からの文字起こしは**成功**
- 話者チップ（話者A）の表示を確認。ただし話者は 1 人のみで、複数話者の分離精度は未検証
- 「話者分離が会話開始から数分しないと機能しない」という観察

  → Deepgram のストリーミング diarization は音声を蓄積して声をクラスタリングするため、
    開始直後は判別材料が足りず全員を話者0に寄せる。仕様上の挙動でバグではない。
    加えて 5 分で強制停止されていたため、分離が効き始める時間帯にほぼ到達できていなかった

## 8. Anthropic クレジット残高切れ

用語抽出が 6 回連続で失敗し、UI に生の JSON エラーが表示された:

```
400 {"type":"error","error":{"type":"invalid_request_error",
 "message":"Your credit balance is too low to access the Anthropic API.
  Please go to Plans & Billing to upgrade or purchase credits."}}
```

クレジット購入で解消。ここで `src/extract/scheduler.ts:110-125` の設計問題が露呈した:

- エラーの種別を区別せず、恒久エラー（400/401/403）も一時エラーと同じく再試行し続ける
- 失敗したチャンクをバッファに戻す（`this.buffer = chunk + ...`）ため、
  恒久エラーが続くと**バッファが会議の全文字起こしまで際限なく肥大**する
- 復旧時に蓄積された巨大チャンクが 1 回のリクエストで送られ、入力トークンが跳ね上がる
- ユーザーには 6 回ごとに開発者向けの生 JSON が表示される

Anthropic SDK 自体は 400 を再試行しない（429/5xx のみ）。上記はスケジューラのトリガー 6 回分。

## 9. 未着手のまま残った作業

- スケジューラのエラー分類修正（恒久/一時の区別、バッファ長の上限）
- `fly.toml` と `.dockerignore` の git コミット
- 複数話者での話者分離精度の検証
