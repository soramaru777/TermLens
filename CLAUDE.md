# TermLens

会議の会話をリアルタイムに文字起こしし、専門用語を検出して約100文字の解説カードを表示する PWA。

## LLM Wiki

このプロジェクトは LLM Wiki パターンで知識を管理している。**スキーマの定義は @~/wiki/SCHEMA.md を参照すること**（このファイルには複製しない）。

- `docs/raw/` — 不変のソース置き場。LLM は読むだけ
- `docs/wiki/` — LLM が保守するページ。エントリポイントは `docs/wiki/index.md`
- `docs/wiki/log.md` — 操作ログ（追記のみ）
- ハブページ: `~/wiki/projects/termlens.md`、横断知識: `~/wiki/knowledge/`

**作業を始める前に `docs/wiki/index.md` を読むこと。** 実装や課題の背景はそこに集約されている。

設計判断・既知の課題・運用手順が変わったら、コードと一緒に `docs/wiki/` を更新する。他プロジェクトでも通用する知見（Deepgram の使い方、Claude API の癖など）は `~/wiki/knowledge/` に昇格させる。

## このリポジトリ固有の注意

- `docs/local/` は git 未追跡。**Issue・PR・コミットメッセージで言及しない**
- API キー・トークンは `.env` にのみ置き、Wiki やコミットに書かない
- フロント（`public/`）はビルドレス。編集すればそのまま反映される
