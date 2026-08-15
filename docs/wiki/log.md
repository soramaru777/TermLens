# TermLens Wiki — Operation Log

追記のみ。新しいものを下に足す。

---

2026-08-13 init — LLM Wiki を導入。`docs/raw/` と `docs/wiki/` を作成し、`~/wiki/mounts/termlens` から symlink で接続。
2026-08-13 ingest — `README.md` と `docs/local/status-2026-08-13.md` を取り込み、5ページを生成（architecture / stt-pipeline / term-extraction / deployment / open-issues）。横断知見2件を `~/wiki/knowledge/` へ昇格。
2026-08-13 ingest — Fly.io デプロイと iPad 実機テストのセッションを `docs/raw/session-2026-08-13-fly-deploy.md` として固定し取り込み。deployment（手順を `fly launch` → `apps create` に訂正、トライアル5分制限・`.dockerignore` 必須・HA 2台を追記）、open-issues（弱点12 バッファ肥大を新規、実機テストを一部解決、優先順位を再編）、stt-pipeline（diarization のウォームアップ挙動）、term-extraction（失敗時の再バッファ挙動）の4ページを更新。Fly.io の汎用知見を `~/wiki/knowledge/fly-io-deployment.md` へ昇格。
2026-08-14 update — CI/CD 導入に伴い deployment を改訂。develop への push で自動デプロイする構成、CI の認証（アプリスコープ限定トークン）、アクションを SHA 固定する方針を追記。手動デプロイは初回構築時の手順として残した。あわせて credential helper の評価順による push 404 の対処を追加。
2026-08-15 update — 公開前の棚卸し。open-issues から運用10（認証情報の取り扱いに関する記述）を削除。該当の資格情報はローテーション済みで課題が解消したため。あわせて運用11にレート制限の欠如を追記。
