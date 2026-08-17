# TermLens Wiki — Operation Log

追記のみ。新しいものを下に足す。

---

2026-08-13 init — LLM Wiki を導入。`docs/raw/` と `docs/wiki/` を作成し、`~/wiki/mounts/termlens` から symlink で接続。
2026-08-13 ingest — `README.md` と `docs/local/status-2026-08-13.md` を取り込み、5ページを生成（architecture / stt-pipeline / term-extraction / deployment / open-issues）。横断知見2件を `~/wiki/knowledge/` へ昇格。
2026-08-13 ingest — Fly.io デプロイと iPad 実機テストのセッションを `docs/raw/session-2026-08-13-fly-deploy.md` として固定し取り込み。deployment（手順を `fly launch` → `apps create` に訂正、トライアル5分制限・`.dockerignore` 必須・HA 2台を追記）、open-issues（弱点12 バッファ肥大を新規、実機テストを一部解決、優先順位を再編）、stt-pipeline（diarization のウォームアップ挙動）、term-extraction（失敗時の再バッファ挙動）の4ページを更新。Fly.io の汎用知見を `~/wiki/knowledge/fly-io-deployment.md` へ昇格。
2026-08-14 update — CI/CD 導入に伴い deployment を改訂。develop への push で自動デプロイする構成、CI の認証（アプリスコープ限定トークン）、アクションを SHA 固定する方針を追記。手動デプロイは初回構築時の手順として残した。あわせて credential helper の評価順による push 404 の対処を追加。
2026-08-15 update — 公開前の棚卸し。open-issues から運用10（認証情報の取り扱いに関する記述）を削除。該当の資格情報はローテーション済みで課題が解消したため。あわせて運用11にレート制限の欠如を追記。
2026-08-16 update — ライセンスを MIT に決定（依存88パッケージがすべて permissive でコピーレフト無しを確認）。レート制限は「トークンが128bitのため不要」と判断し、open-issues の運用11から除外して deployment に判断の根拠を記録。AUTH_TOKEN の強度要件（暗号論的乱数で128bit以上、入力性から16進数を推奨）と、URL が CT ログにより秘匿できないことを deployment に追記。
2026-08-17 update — 会議ログの Markdown エクスポートを実装（弱点5 を解決）。open-issues の優先順位を再編し、実装上の判断（cardData Map の追加、経過時間が受信時刻ベースであること、PWA での共有シート優先が未検証であること）を記録。
2026-08-17 update — 狭い画面で用語カードを最新1枚だけ表示する挙動を追加（追従／固定／最新の3状態）。閾値 899px を app.js と style.css で共用している点、iPad 縦向きも1枚表示になる点を open-issues に記録。
2026-08-17 update — PR #7 のレビュー指摘に対応。セッション終端でのマイク/AudioContext/Wake Lock 解放を finish() に集約し、未保存警告を文字起こし/用語カードで分離。検証中に見つかった「停止ボタンの二重ハンドラで戻るが機能しない」不具合もあわせて修正し、いずれも open-issues に注意点として記録。
2026-08-17 update — PR #7 の2巡目レビュー(5件)に対応。セッション再開時の状態初期化、1006 判定のガード、破棄警告フラグのリセット、解放処理での await 前のグローバル退避、Wake Lock 取得競合、<a download> の成否判定を修正し、いずれも再発防止の注意点として open-issues に追記。
2026-08-18 update — LLM を Anthropic Claude Sonnet 5 から OpenAI GPT-5.6 Luna へ移行。ベンチで抽出・清書とも品質が同等（誤認識復元 11/11）、レイテンシ 3割〜3倍速、コスト 7〜21倍安を確認したうえでの判断。あわせて enrich.ts に引用除去・URL正規化・字数ガードを追加（モデル非依存の既存不具合）。残高切れが 400 から 429 に変わるため、scheduler の恒久エラー判定に insufficient_quota の判別を追加。
