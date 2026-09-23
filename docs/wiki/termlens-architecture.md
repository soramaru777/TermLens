---
title: TermLens アーキテクチャ
type: concept
project: termlens
scope: shared
sources:
  - README.md
  - public/zip.js
  - https://github.com/soramaru777/TermLens/issues/65
related: [[termlens-stt-pipeline]], [[termlens-term-extraction]], [[termlens-deployment]], [[termlens-open-issues]]
confidence: high
updated: 2026-09-23
---

# TermLens アーキテクチャ

ブラウザで音声を拾い、WebSocket でサーバーに送り、STT と LLM を通して用語カードを返す単一プロセス構成。フレームワークを持たない素の HTML/JS フロントと、Node.js サーバーの2層のみ。

## データフロー

```
ブラウザ (public/)
  マイク → AudioWorklet (16kHz PCM16化) ─┐
  文字起こし表示・用語カードUI ←────────┤ WebSocket（音声=バイナリ / 制御=JSON）
                                         │
サーバー (src/)                          ▼
  session.ts ── STTアダプタ (stt/) ─── Deepgram streaming API
       │             └ mock.ts（キー不要のダミー会議再生）
       └ 抽出スケジューラ (extract/)
             ├ extractor.ts … Claude 構造化出力で用語抽出（速報）
             └ enrich.ts   … Claude + web search で要約+リンク（清書）
```

WebSocket 1本の中で、**音声はバイナリフレーム、制御メッセージは JSON** という使い分けをしている。

## プロトコル（`src/protocol.ts`）

型定義は `src/protocol.ts` が唯一の場所。要点だけ:

| メッセージ | 向き | 覚えておくこと |
|---|---|---|
| `start` | C→S | `glossary` と `shownTerms`（再接続時のデデュープ、#8）。**`shownTerms` は term の一覧**であってカードの ID ではない（#38） |
| `transcript` | S→C | `finalSeq` は「同じ Deepgram の final 由来か」の印（#36）。話者で分割されたイベントには同じ番号が付く |
| `cards` | S→C | 速報カード。`TermCard.cardId` はサーバーがセッション内通番（`c1`, `c2`, …）で配る**不変の識別子**（#38） |
| | | `importance` は**表示優先度**（#44）。`rarity` とは別軸で、`low` は「その他の用語」へ折りたたむ |
| `card_update` | S→C | 清書（検証）の結果。**更新対象は `cardId` で指定する**（#38 以前は `term`）。`status` は optional にしない（#24）。`rename?` が載るのは #40 の再評価だけ |

> **`card_update` と `CardRename` には `importance` を載せない**（#44）。載せないかぎり
> `mergeCardUpdate()` の `{ ...stored, ...renamed }` で元の値が必ず残る — **入れないこと自体が
> 「rename で importance を失わない」の実装**で、別途ガードは書いていない。

> 2026-08-30 変更（#38）: `TermCard` に `cardId` を追加し、`card_update` から `term` を
> 落とした。**`term` は識別子ではなくなり、「意味上の同一性」（デデュープ）だけに使う。**
> クライアントは受信 ID を自分のローカル ID（`k1`, `k2`, …）へ写像して持つので、
> 再接続でサーバーの採番が `c1` から振り直されても更新が迷子にならない。
> 詳細は [[termlens-term-extraction]]。**#38 単独では挙動を変えていない**（識別子の分離だけ）。

### `card_update.rename` — 唯一の改名経路（#40）

> 2026-09-01 追加（Issue #40、案A）。

`unresolved` になったカードを後続の会話で再評価し、裏付けが取れたときだけ
**同じ `cardId` のまま**改名する。流れは1本道。

```
scheduler.rematchCard()
  └─ verifyAndEnrich()（既存の Stage 2 を再利用）→ isResolved()
        └─ onCardUpdate(cardId, "confirmed", description, links, rename)
              └─ session.ts が WS へ透過（rename が無いときはキーごと落とす）
                    └─ app.js updateCard({ ..., rename })
                          ├─ mergeCardUpdate()  … rename があるときだけ unresolved から昇格
                          ├─ termToCardId を旧 term → 新 term へ張り替え
                          ├─ 衝突していれば mergeDuplicateCards() で統合
                          └─ 見出し・ハイライト・active/pinned・保存を整合させる
```

`rename` は **`{ term, reading, correctedFrom, surfaceForms }` の入れ子**。boolean フラグ +
平置きの term にすると「フラグは立っているが term が無い」矛盾した組を型として書けてしまう
ため、昇格の許可と新しい表示内容を1つの存在で結んである。**`cardId` は入れない** —
識別子は不変（#38）で、入れると「改名で ID が変わる」経路を型が許してしまう。

**既存の3経路（裏付けあり / 棄却 / 例外フォールバック）は `rename` を付けない**ので、
素の `card_update` に対する #24 のガードはそのまま効く。詳細は [[termlens-term-extraction]]。

## 技術スタック

| 層 | 技術 |
|---|---|
| サーバー | Node.js 22 / TypeScript / Fastify / ws |
| STT | Deepgram Nova-3（streaming, ja, diarization, keyterm）— アダプタ切替式 |
| LLM | OpenAI GPT-5.6 Luna（既定 `gpt-5.6-luna`）— 構造化出力 + web search tool |
| フロント | フレームワークなしの素の HTML/JS/CSS（ビルド不要） |
| デプロイ | Docker + Fly.io |

フロントをビルドレスにしているため、`public/` を直接編集すれば反映される。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/session.ts` | WS / STT / 抽出のオーケストレータ。全体の要 |
| `src/stt/deepgram.ts` | Deepgram アダプタ（nova-3, diarize, keyterm, KeepAlive） |
| `src/stt/mock.ts` | キー・マイク不要のダミー会議再生 |
| `src/extract/extractor.ts` | 速報抽出（構造化出力、レア度・surfaceForms 付き） |
| `src/extract/enrich.ts` | 清書（web search、リンク収集、前置き除去） |
| `src/extract/scheduler.ts` | トリガー判定・デデュープ・清書対象の選定・unresolved の再評価（#40） |
| `src/extract/rematch.ts` | 再評価の純関数（仮名寄せ・類似度・候補合成・確定判定）。**依存ゼロ**（#40） |
| `public/card-status.js` | カードの状態・見出しの導出、`card_update` の畳み込み、重複カードの統合（純関数だけ） |
| `public/app.js` | UI 全般（話者段落、用語ハイライト、カードジャンプ、改名の適用） |
| `public/utterances.js` | 表示・エクスポート用の発話グループ化（話者ラベルの揺れの補正 + 同一話者の結合、#36） |
| `public/zip.js` | エクスポート用の無圧縮（store）ZIP の組み立て・CRC-32・保存名の整形（純関数、#65） |

## 設計上の選択

- **STT をアダプタ層で抽象化**した。Deepgram / mock を差し替えられ、キーなしで全パイプラインを検証できる（[[termlens-stt-pipeline]]）
- **用語解説を二段構え**にした。速報を即返して体感速度を確保し、web 検索結果で後から上書きする（[[termlens-term-extraction]]）
- **話者ラベルの揺れは表示側の後処理で直す。** STT の分割規則（`splitBySpeaker()`）は変えず、
  `public/utterances.js` がコピーの上で `speaker` だけを補正する。raw の文字起こしと用語抽出の
  経路は無変更で、**テキストは一切削除しない**（[[termlens-stt-pipeline]]）
- **カードの識別子と用語名を分けた**（#38）。`cardId` が識別・更新・UI 参照を担い、`term` は
  デデュープだけに使う。`term` が主キーだった頃は、同じ用語のカードを2枚持てず、用語名を
  後から直す余地も無かった（[[termlens-term-extraction]]）
- **用語カードだけを直し、raw transcript は書き換えない**（#40）。再評価で用語が確定しても
  文字起こし本文の ASR 結果には触らない。崩れた表記のハイライトも残すので、**過去の行から
  直ったカードへ辿れる**。確定した用語を表示用 transcript に反映するのは別の課題
  - ただし**この「残す」はライブ中だけ**。保存/復元は `term` / `correctedFrom` /
    `surfaceForms` からハイライトを組み直すので、改名前の推定 term と、統合で消えた側の
    `correctedFrom` は復元後に引けなくなる。カード自体は残るので実害は「過去の行を
    タップしても飛ばない」に留まるが、ライブと復元後で挙動が違う点は把握しておくこと
- **表示優先度で折りたたむが、情報は落とさない**（#44）。`importance=low` のカードは
  「その他の用語」へ畳むだけで、Markdown エクスポートと localStorage には**全カードが残る**。
  折りたたみは DOM を動かさずクラスと CSS の `order` だけで表現する — `cardsEl.children` を
  走査している `findCardEl()` / `setActiveCard()` を壊すと、**例外を出さずに `card_update` が
  low カードにだけ届かなくなる**（[[termlens-term-extraction]]）
- **エクスポートは名前を付けた ZIP 1つ**（#65）。停止後の export 行は名前欄 + `⬇ まとめて保存(.zip)`
  だけで、中身は `<名前>/文字起こし.md` / `用語カード.md` / `収音診断.md`（診断は出せるときだけ）。
  Markdown は画面用と同じ `build*()` を呼ぶので、個別の Markdown と中身は変わらない。
  **ZIP はブラウザ内で組む** — サーバーで組むと会議本文を送ることになり「この端末にのみ保存」の方針に反する。
  ビルドレス・外部ライブラリなしを保つため、ライブラリを入れず store 方式を `public/zip.js` に自前実装した
  （対象は Markdown 数 MB 以下で圧縮の利点が小さい）。日本語名は UTF-8 フラグ（bit 11）で格納する。
  **会議名は localStorage に書かない**（本文と同じ扱い。保存 OFF のときに何も残さないため）。
  保存は共有シート（standalone PWA）/ `<a download>` の既存経路 `saveFile()` に載せる。
  個別ボタンの撤去により、#26 の「診断だけを本文なしで渡す」経路は無くなった（ZIP を展開して
  `収音診断.md` だけを渡す運用になる。[[termlens-stt-pipeline]]）。
  保存名は Windows の予約名（`CON` 等）・制御文字・双方向制御文字を除き、UTF-8 で 200 バイトまでに切る。
  > 2026-09-23 まで: 文字起こし・用語カード・収音診断を個別の `.md` ボタン 3 つで保存していた。
  > #65 でユーザー判断により撤去（[[termlens-open-issues]]）。
- **状態をサーバーに永続化していない。** ブラウザメモリのみのため、リロードで全消失する（[[termlens-open-issues]] の弱点4）
