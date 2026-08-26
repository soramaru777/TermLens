# TermLens Wiki — Index

TermLens のプロジェクト固有知識。規約は `~/wiki/SCHEMA.md`、ハブページは `~/wiki/projects/termlens.md`。

生ソースは `docs/raw/`。運用ログは `docs/wiki/log.md`。

| ページ | 概要 |
|---|---|
| [[termlens-architecture]] | 全体構成、データフロー、技術スタック |
| [[termlens-stt-pipeline]] | Deepgram アダプタ、話者分離、発話単位の構築、用語集ブースト、mock モード |
| [[termlens-term-extraction]] | 用語カード二段構え（速報 → 清書）、デデュープ、誤認識復元 |
| [[termlens-deployment]] | Fly.io デプロイ、環境変数、認証、コスト |
| [[termlens-testing]] | 決定的テストと LLM 評価の2層構成、実行方法、指標、測れないもの |
| [[termlens-open-issues]] | 未検証項目・実装上の弱点・次の優先順位 |
