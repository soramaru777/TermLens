# TermLens

会議の会話をリアルタイム文字起こしし、専門用語・固有名詞を検出して約100文字の解説カードを表示するPWA(スマホ/iPad対応)。

## 構成

- ブラウザ: マイク → AudioWorklet で 16kHz PCM16 化 → WebSocket でサーバーへ
- サーバー (Node.js + Fastify + ws): 音声を Deepgram streaming STT に中継、final transcript を蓄積して Claude で用語抽出(構造化出力)
- 解説は二段構え: **速報**(LLM知識のドラフトを即表示)→ **清書**(Anthropic の web search ツールで最新情報を検索し、約100文字要約+関連リンク3件でカードを更新)
- 精度対策: 用語集による STT keyword ブースト / LLM による誤認識復元(`もしかして?`表示)/ 表示済み用語のデデュープ
- コスト注意: web search はレア度上位の約半数の用語のみ・1件あたり最大1回検索($10/1,000検索 + トークン)。`src/extract/enrich.ts` の `max_uses`、`src/extract/scheduler.ts` の選定ロジックで調整可

## セットアップ

```sh
npm install
cp .env.example .env   # 各値を設定
npm run gen-icons      # PWAアイコン生成(初回のみ)
npm run dev            # http://localhost:8080
```

- `STT_PROVIDER=mock` なら Deepgram キー・マイク不要でパイプライン全体を検証できる(ダミー会議を自動再生)
- 用語抽出には Anthropic の認証情報が必要(`ANTHROPIC_API_KEY` または `ant auth login` プロファイル)
- `ANTHROPIC_MODEL=claude-haiku-4-5` にすると安価・高速側に切替

## デプロイ (Fly.io)

```sh
fly launch --no-deploy   # 初回のみ(fly.toml は同梱)
fly secrets set ANTHROPIC_API_KEY=... DEEPGRAM_API_KEY=... AUTH_TOKEN=$(openssl rand -hex 24)
fly deploy
```

スマホ/iPad の Safari で公開URLを開き、共有 → ホーム画面に追加。マイク利用には HTTPS が必須(Fly が終端)。
