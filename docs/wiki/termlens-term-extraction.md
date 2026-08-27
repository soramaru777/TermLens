---
title: TermLens 用語抽出と解説カード生成
type: concept
project: termlens
scope: shared
sources:
  - README.md
  - docs/local/status-2026-08-13.md
  - docs/raw/session-2026-08-13-fly-deploy.md
related: [[termlens-architecture]], [[termlens-stt-pipeline]], [[termlens-open-issues]], [[termlens-testing]]
confidence: high
updated: 2026-08-27
---

# TermLens 用語抽出と解説カード生成

文字起こしから専門用語を検出し、約100文字の解説カードとして表示する中核機能。汎用的な実装知見は `~/wiki/knowledge/anthropic-structured-output-websearch.md` に切り出してある。

## 二段構え

体感速度と情報鮮度を両立させるための構成。

1. **速報** — `extractor.ts`。構造化出力で用語を抽出し、内部知識によるドラフト解説を即座に表示する
2. **清書** — `enrich.ts`。web search tool で最新情報を取得し、約100文字の要約 + 関連リンク3件に `card_update` メッセージで差し替える

2026-08-27（#23）から、清書は**候補の検証も兼ねる**（下記「誤認識補正は候補生成と検証の2段階」）。

## トリガー

`scheduler.ts` が判定する。

- 確定文字起こしが **120文字** 溜まる、**または** 前回から **10秒** 経過
- チェック間隔は5秒

### 入力の単位は final ではなく「発話」

> 2026-08-26 変更（Issue #21）: `scheduler.addFinal()` を **`addUtterance()`** に変えた。
> `run()` はバッファ全部を持っていくので、**チャンクの切れ目は常に「最後に append した
> テキストの末尾」**になる（120文字は切断位置ではなく発火の閾値）。`is_final` を
> そのまま受けていた頃は、その末尾が認識区間の区切り＝**発話の途中でありえた**。
> `is_final` は人の意味的な発話完了ではないため、文脈不足のまま抽出される原因になっていた。

`UtteranceBuilder`（[[termlens-stt-pipeline]]）が複数の final を1発話にまとめてから渡す。
**バッファの中身が「完成した発話の集まり」になるので、末尾が必ず発話の終わりになる。**
`maybeRun()` の発火条件（120文字 / 10秒）そのものは変えていない — 渡す単位を変えるだけで
発話境界の尊重が成立するため、スケジューラ側に境界判定を持ち込まずに済んでいる。

`appendToBuffer()` が発話同士を `" "` で連結するのは従来どおり。発話**内部**の連結は
`UtteranceBuilder` 側が区切り文字なしで行う（役割が違う）。

**`MAX_BUFFER_CHARS`（2,000字）の切り捨てだけは発話境界を見ない**（`slice(-2000)`）。
過負荷時の保険なので、先頭が発話の途中で切れることは許容している。

### 代償: カード表示が遅くなる

抽出の入力が発話の完成を待つぶん、**カードが出るまでの時間は延びる**。待ち時間は
発話確定（`speech_final` / `UtteranceEnd` が来なければ最大 `UTTERANCE_TIMEOUT_MS` = 3秒）が
スケジューラの待ち（最大 `MAX_WAIT_MS` = 10秒）に**上乗せ**される形で、最悪 13 秒。
文字起こしの表示は即時のままなので、遅れるのはカードだけ。

1発話が最大 500 字まとまってから渡るので、**LLM 呼び出しは従来より粗く・回数は少なくなる**
（1回あたりのトークンは増える）。実際にどう振れるかは #18 の評価基盤で測る。

## 直前の会話を文脈として渡す

> 2026-08-27 追加（Issue #22、案A）。

`run()` はバッファを**丸ごと**持っていって空にするため、**チャンク間に文脈の持ち越しが
一切なかった**。短いチャンクだけでは語義や固有名詞の候補を絞れず、前後関係が無いまま
誤補正する原因になる。

抽出器の入力を役割で2つに分けた（`ExtractorInput`）。

| フィールド | 役割 |
|---|---|
| `newTranscript` | 今回**カード化・`surfaceForms` 抽出の対象** |
| `contextTranscript` | 語義判定にだけ使う直前の会話。**カード化の対象ではない** |

user ターンは「**直前の会話 → 表示済み用語リスト → 新しい文字起こし**」の順に組む
（判断対象を末尾＝直近に置く。空なら「(なし)」）。`ROLE_PROMPT` の**規則9**が
「直前の会話にしか登場しない用語は出力しない」を担当する。

**system プロンプトはセッション中バイト不変のまま**。可変部分は従来どおり user 側にしか
無いので、OpenAI のプレフィックスキャッシュへの影響はない。

### 上限は「秒」ではなく文字数

`ContextWindow`（`src/extract/context.ts`。**依存ゼロで保つ** — `normalize.ts` `split.ts`
`utterance.ts` と同じ理由）が抽出済みチャンクを `MAX_CONTEXT_CHARS` = **1,500字**まで保持する。

Issue は「直前30〜60秒 または 1000〜2000文字」としていたが、**抽出側にタイムスタンプが無い**。
`Utterance` は `{ text, speaker }` だけで、時刻を通すには `UtteranceBuilder` → `Session` →
`Scheduler` の3層に手を入れることになる。既存の `MAX_BUFFER_CHARS`（2,000字）と同じ考え方の
文字数上限で始め、必要になってから時間軸を足す。

- **古いチャンクから丸ごと捨てる**。チャンクの切れ目は発話の終わり（#21）なので境界を保てる
- 1チャンク単独で上限を超えるときだけ `slice(-1500)` で頭を削る（`MAX_BUFFER_CHARS` と同じ割り切り）
- 連結は `" "` 区切り。`appendToBuffer()` と揃えてある

増えるのは**入力トークンだけ**（1,500字の日本語 ≒ 1,100トークン）。新しい API 呼び出しは無い。

### 積むのは抽出に**成功した後**だけ

一時エラーではチャンクを `appendToBuffer(chunk, true)` でバッファ先頭に戻す。先に積むと、
**戻ってきたチャンクが次回 `contextTranscript` と `newTranscript` の両方に現れる**。
`tests/scheduler-context.test.ts` はこの回帰が本題。

恒久エラーの `disableExtraction()` では `context.clear()` も呼ぶ（バッファを捨てるのと同じ理由。
抽出が止まった後に古い文脈を抱え続ける意味がない）。

デデュープ（`shownSet` / `shownTerms`）には手を入れていない。

### `surfaceForms` は抽出器側で絞る

`filterSurfaceForms()` が、返ってきた `surfaceForms` を **`newTranscript` に実在する表記だけ**に
絞る（`newTranscript.includes(form)`）。規則7で指示はしていたが**サーバー側の検証が無く**、
文脈を渡し始めると「直前の会話に出てきただけの表記」が混ざりうる。

- 置き場所は `extractor.ts` の `extract()` 内で、**`scheduler.ts` ではない**。評価ハーネス
  （`src/eval/run.ts`）は `createExtractor()` を直接呼ぶので、スケジューラに置くと
  **評価が本番と違う挙動を測る**ことになる
- **カード自体は落とさない。** `surfaceForms` が空になってもカードは残す（ハイライトが効かない
  だけで `public/app.js` は `?? []` で受けている）。LLM が表記を出し渋っただけで正しい新規用語を
  捨てるほうが害が大きい
- 純関数として export してあるので、**LLM を呼ばずに決定的テストで固定できる**

### 今回やらなかったこと

- `enrichCard(term, chunk)`（清書時の文脈）への `contextTranscript` 追加 — AC に無く、効果が読めない
- 時間軸での上限 — 上記のとおり3層改修になる

## 誤認識補正は候補生成と検証の2段階

> 2026-08-27 追加（Issue #23、案B）。

**独立した検証者を立てることが眼目。** 1回の抽出で「崩れた表記 → 正規化した用語」まで
決めていたため、**音韻的にそれらしく実在する別用語へ誤補正すると、その後の解説生成と
web 検索がその誤りを強化していた**。同じ推論パスの中で自己検証させても、この自己強化は
断ち切れない。

**Stage 2 は新設していない。** すでに走っている清書（web 検索つき）に検証を同居させた。
現行の清書ランキングは `rarity` 降順・非 `confirmed` 優先（#24 以前は `confidence: low` 優先）で、「誤補正が疑わしいカード」と
ほぼ同じ集合を選んでいるので、**LLM 呼び出しの回数はほとんど増えない**。増えるのは主に
Stage 1 の出力トークン（`candidates` 配列ぶん）。

| 段 | 置き場所 | 役割 |
|---|---|---|
| Stage 1 候補生成 | `extractor.ts`（規則10） | STT 表記・直前文脈・用語集から候補を確からしい順に最大3件 |
| Stage 2 候補検証 | `enrich.ts` `verifyAndEnrich()` | 実在性と文脈整合性を **web 検索という独立した情報源**で確認し、1件を選ぶか棄却する |

### 候補の不変条件

`candidates[0].term === term`、件数は `MAX_CANDIDATES` = **3件**。
こうしておくと「候補が1件だけ＝迷いがない」が素直に表現でき、Stage 2 は `candidates` だけ
見れば足りる。整形は `normalizeCandidates()`（`extractor.ts` の純関数）が担当し、
空 term を落とし、正規化キーで重複を畳み、`term` を先頭へ移し（表記は `term` 側で上書き）、
**先頭を差し込んだ後に**切り詰める。

**上限をサーバー側でも切るのは体裁の問題ではない。** 構造化出力は件数の指示を守らないことが
あり、超過ぶんが `max_completion_tokens`（3,000）を圧迫すると **JSON が途中で切れて
`parsed` が null になり、そのチャンクのカードが全部消える**（`?? []` で握り潰される）。
`filterSurfaceForms()` と同じ「LLM の従順さに依存しない」方針。

### `candidates` はクライアントへ送らない

検証段への内部入力であって、クライアントは使わない。`protocol.ts` の `TermCard` には
載せず、`scheduler.ts` が送信時に**明示的に落とす**。#19 で `words` を送らなかったのと
同じ理由（WS ペイロードと `localStorage` を太らせない）。

> **落とし穴**: 送信するカードは `{ ...c, links: [], willEnrich }` のスプレッドで組んでいる。
> 放っておくと `candidates` がそのまま流れるので、分割代入で明示的に外している。

### web 検索と構造化出力は併用できる（実 API で確認済み）

設計時は「`responses.create` で `web_search` ツールと構造化出力が同時に使えるか」が
未検証で、駄目なら出力1行目の `CHOSEN:` 行をパースするフォールバックに落とす想定だった。
**実際には併用できる。** `web_search_call` が実行されたうえで `output_text` に JSON が返り、
`url_citation` の annotations も従来どおり付くので、リンク収集の実装は変えていない。

ただし **`description` には指示に反して引用記法が混ざる**（実応答で観測）ため、
`stripInlineCitations()` と `clampDescription()` は構造化出力でも通す。パースは
`parseVerifyOutput()`（純関数）に切り出してテストで固定してある。

**`chosen` は候補の中からしか採らない。** 候補外の用語が返ってきたら棄却に倒す。
検証段は抽出段の誤補正を弾くためにあり、ここで新しい用語を作れてしまうと独立した
検証者を立てた意味が無くなる。

### 棄却されたカードの扱い

> 2026-08-27 変更（Issue #24）: **棄却は `status: "unresolved"` として表示に反映される
> ようになった。** 下記の「表示は変えない」は #23 時点の既定で、#24 で置き換わっている。
> `console.warn` に `term` と `reason` だけを出す（**文字起こし本文は出さない**）ところは
> そのまま。判定は従来どおり `isVerified(term, chosen)` に集約してある。

> #23 時点: 棄却しても表示は変えず、内部に記録するだけだった。棄却の是非を測る土台
> （誤補正率の変化）を先に作り、表示の変更は unresolved 状態の Issue でまとめて入れるほうが、
> 悪化したときの切り分けが効くという判断。

**候補の2番目以降が選ばれた場合も改名はしない。** `card_update` は `term` でカードを
突き合わせる仕様なので、**表示中のカードを別の用語に改名する経路が無い**。#24 以降、
この場合も棄却と同じく `unresolved` へ降格する（見出しは当てにならないと伝えるほうが正確）。
改名そのものは引き続き別 Issue。

**清書側でも恒久エラー（残高切れを含む）を見る。** 抽出は `disableExtraction()` で1回止まるのに
検証が素通しだと、選ばれたカードごとに web 検索つきの呼び出しを投げ続け、誰にも通知されない
まま課金だけが進む（#23 で対象集合を広げたぶん影響が大きい）。`enrichCard` の catch で
`isPermanent()` を見て以降の検証を打ち切る。

**棄却しても `card_update` は必ず送る。** 速報は `willEnrich: true` で送っており、
クライアント（`public/app.js`）は `card_update` が来るまで「確認中」の表示を畳まない。
何も返さないと**誤補正が最も疑わしいカードにだけ**回り続けるスピナーが残る。
解説は速報のまま・リンクは空で送る（#24 以降は `status: "unresolved"` も載る）。

**現行の protocol では Stage 2 は term ベースの指標を動かさない。** 改名できず、棄却しても
速報カードは残るので、`term` から算出される Recall / Precision / 誤補正率はどれも変わらない。
したがって**評価ハーネス（`src/eval/run.ts`）の既定も本番と同じくカード集合を変えない**。
（#24 で `status` だけは動かすようになった。本番が `confirmed` / `unresolved` を送る以上、
評価も同じにしないと `EVAL_WITH_VERIFY=1` の probable / unresolved 列が Stage 1 の申告の
ままになり、検証の効果が数字に出ない。term は変えないので合否ゲートには影響しない。）
評価だけ差し替え・棄却を適用すると、本番なら誤補正に数えられるカードが正しい補正に化けて、
**合否ゲート（`maxMiscorrection`）が本番より甘い側にずれる**。

検証が何をしたかは `VerifyTally`（確認 / 棄却 / 差し替え / 失敗）として集計し `formatTable` に
出す。**既定モードではこの内訳だけが Stage 2 の判断材料**になる。

`EVAL_ALLOW_RENAME=1` は「改名できたらどうなるか」の探索モードで、別候補が選ばれたら
差し替え、裏付けが取れなければ落とす。**この数値は本番の挙動ではないので合否の根拠にしない。**
Precision は分母が用語数なので、カードを落とすほど見かけ上よくなる点にも注意する。

### 今回やらなかったこと

- **word confidence の利用。** `TranscriptEvent.words[].confidence` は #19 で保持しているが、
  `UtteranceBuilder` が `{ text, speaker }` に落とすため抽出層に届いていない。使うには
  `UtteranceBuilder` → `Session` → `Scheduler` → `Extractor` の4層改修が要る（#22 で
  時間軸を諦めたのと同じ構造の問題）。まず「STT 表記 + 直前文脈 + 用語集」で効果を測る
- unresolved 状態の表示（Issue 本文どおり別 Issue → **#24 で実装済み**。下記）

## 不確実な用語は断定しない（`status`）

> 2026-08-27 追加（Issue #24、案B）。

**カードの確信度は `confidence: "high" | "low"` を廃し、`status` に置き換えた**
（`low` → `probable` が 1:1 対応）。併存させると同じ事実を2フィールドで持つことになり、
LLM が `high` かつ `unresolved` のような矛盾した組を返したときの正解が決まらない。

| status | 意味 | 見た目 |
|---|---|---|
| `confirmed` | 補正なし、または確信のある補正 | 通常カード |
| `probable` | 補正したが確信がない（旧 `confidence: "low"`） | 「もしかして?」バッジ（従来どおり） |
| `unresolved` | 用語を特定できない | **見出しが surface form**、`❓ 用語を特定できませんでした`、リンクなし |

> **`src/stt/` の `confidence` は別物。** `TranscriptWord.confidence` は Deepgram の
> 語単位スコアで、この置き換えの対象ではない。一括置換すると STT が壊れる。

### 状態遷移

```
抽出（Stage 1）→ confirmed / probable / unresolved
検証（Stage 2）→ 裏付けあり: confirmed へ（probable からの格上げが起きる）
                 棄却・候補#2: unresolved へ**降格**
```

**`unresolved` は Stage 2 に回さない。** 昇格の経路が無いうえ解説も定型文で固定される
ため、**検証結果を使える余地が1つも無い**（回すと web 検索の課金だけが増える）。
`selectVerifyTargets()` は最初に `unresolved` を除くので、レア度ランキング経由でも入らない。

**`unresolved` から上へは戻さない。** Stage 2 が別候補を選んでも `card_update` は `term` で
突き合わせるため改名できず、解説だけ差し替えると表示が食い違う（#23 で確定済みの制約）。
再接続でカードが再送されたときも `status` は上書きしない（速報の判断で格上げしないため）。
`card_update` を受ける `mergeCardUpdate()`（`card-status.js` の純関数）にも同じガードがある。
**状態を据え置くときは解説とリンクも据え置く** — 本文だけ更新すると「特定できませんでした」
の見出しの下に**確定した別用語の断定的な解説**が出て、この Issue が防ごうとした形そのものに
なる（リンクは画面には出ないが Markdown エクスポートには出る）。サーバーが unresolved を
検証に回さなくなったのでこの経路は本来来ないが、古いサーバーに繋いだときのために
表示側でも揃えてある。

### 改名はしない。降ろすのは「表示の主役」だけ

`term` は **DOM の `dataset.term`・`cardData` のキー・デデュープのキー**として残したまま、
`unresolved` のときだけ**見出しを `surfaceForms[0] ?? correctedFrom ?? term`**（音声認識が
実際に聞き取った表記）にする。特定できていない用語名を見せる意味がないため。
再キー（`highlightOwner`・サーバー側の `shownSet` を含む）は別 Issue のまま。

### サーバー側でも整合させる

`normalizeStatus()`（`extractor.ts` の純関数）が `unresolved` の `description` を
`UNRESOLVED_DESCRIPTION` に差し替える。プロンプト規則1でも「description は空文字でよい」と
指示しているが、**LLM の従順さに依存しない**（`filterSurfaceForms()` / `normalizeCandidates()`
と同じ方針）。特定できていないのに解説だけ書いてくると、**別の用語の説明を断定的に
読ませる**ことになり、この Issue で防ぎたかった害がそのまま出る。
`extract()` は `filterSurfaceForms` → `normalizeCandidates` → `normalizeStatus` の順に通す。

**Stage 2 の降格でも description を定型文に差し替える。** 速報の解説は「誤補正した用語」の
説明なので、残すと**「特定できませんでした」と言いながら別用語の断定的な定義を読ませる**
ことになる。しかも見出しは surface form に替わっているので、何の説明なのかも分からない。
抽出段の `normalizeStatus()` が同じことをサーバー側で担保している以上、降格経路だけ
素通しにすると方針が非対称になる。

**見出しに出せる材料が無い `unresolved` カードは落とす。** `normalizeStatus()` が
`surfaceForms` も `correctedFrom` も無い unresolved を除く。見出しは
`surfaceForms[0] ?? correctedFrom ?? term` に落ちるので、どちらも無いと**推定した term が
見出しに出る** — バッジ付きで誤った実在用語を断定するという、この Issue が最も避けたい形に
なる。`filterSurfaceForms()` は文字起こしに実在する表記しか残さないので、表記が僅かに
ズレただけで surfaceForms は空になりうる。

**`unresolved` の推定 term はプロンプトの「表示済み用語リスト」に載せない。** 載せると
規則2「表示済みの用語は出力しない」が効き、**後で誰かが同じ用語を明瞭に発話しても正しい
カードが出なくなる**。`shownSet`（サーバー側のデデュープ）には積むので、同じチャンク内の
重複は防げる。

**検証が例外で落ちても `card_update` は送る。** 速報を `willEnrich: true` で送った以上、
黙るとクライアントの「確認中」が会議の終わりまで回り続け、localStorage にもその状態で
保存されるので復元しても消えない（#23 で棄却時に踏んだのと同じ穴が例外パスに残っていた）。
検証できなかっただけなので**速報の status と解説はそのまま**、リンクだけ空で送る。
恒久エラーで検証を打ち切った後は `willEnrich: false` で送る（誰も更新を送らないため）。

### クライアント側の導出は1関数に閉じる

`public/card-status.js` の `cardStatus()` / `cardHeading()` が唯一の定義箇所で、
**描画（`addCard` / `updateCard`）も Markdown エクスポートもここだけを見る**。
`card.status` を直接読む箇所を作ると、**localStorage から復元した古いカード**（`status` を
持たない）でその経路だけ表示が変わる。`cardStatus()` は `status` が無ければ旧 `confidence`
から導出する（`low` → `probable`、それ以外 → `confirmed`）。

`app.js` から切り出してあるのは Node のテストから読めるようにするため
（`public/lowpass.js` と同じ理由。`app.js` はモジュール評価の時点で `document` を触る）。

### 評価指標

旧 `unresolved` 率は「カードは出たが `confidence: low`」＝ **`probable` 率**のことだった。
`status` の導入で同名のフィールドが別の意味になるため、**旧指標は名前ごと `probable` へ移し**、
`unresolved` を新設した（同名で意味を変えると実装前後のレポート比較が静かに壊れる）。
`formatTable` も2列に分けてある。

**`expectUnresolved` は「特定できないのが正解」の表記を並べる分母。** `expectTerms` は
「出てほしい用語」の集合なので、特定できないのが正解のケースは分母にも分子にも入らず、
**そのために追加した fixture が `unresolved` 率をまったく動かせなかった**（#24 のレビューで
判明）。聞き取られた表記を `correctedFrom` か `surfaceForms` に持つカードが `unresolved` で
出れば正解として `unresolvedRecall` に数える。

**`unresolved` のカードは誤補正に数えない。** `forbidTerms` / `expectCorrection` の判定は
`status !== "unresolved"` のカードだけを見る。降格したカードは term を画面に出さない
（見出しは聞き取られた表記）ので、利用者から見て「その用語に補正した」とは言えない。
ここを見ないと **Stage 2 が正しく棄却しても誤補正として数え続け、この機能の効果が指標に
一切現れない**。

**過剰 unresolved が最大のリスク。** `unresolved` 率が上がること自体は成功でも失敗でもなく、
Recall と正しい補正率が落ちていないかと**必ずセットで**読む（誤補正率だけを見て「改善した」と
判断できないのと同じ構造）。

## 清書対象の絞り込み

コスト制御のため、**LLM が判定したレア度の上位およそ半数だけ**を清書対象にしている。

> 2026-08-27 訂正: 「1用語あたりの検索は最大1回（`max_uses: 1`）」と書いていたが、
> `enrich.ts` の `tools` にそのような指定は無い（`{ type: "web_search" }` のみ）。
> **検索回数を縛っているのは対象カードの絞り込みだけ**で、1回の清書内でモデルが
> 何回検索するかは制御していない。

> 2026-08-27 変更（Issue #23、条件は #24 で `status` 基準に書き換え）: 選定条件を
> **「補正あり または `status !== "confirmed"`」∪「レア度上位の約半数」** の和集合に広げた。誤補正が疑わしいのはこの2つで、レア度ランキングが選ぶ集合とは
> 大きく重なるため web 検索の増分は小さい。判定は `selectVerifyTargets()`（`scheduler.ts` の
> 純関数）で、**評価ハーネスも同じ関数を呼ぶ**（コピーすると本番の条件を変えたときに
> 評価だけ古い条件のまま緑になる）。
>
> 並べ替えの第2キー（同レア度なら非 `confirmed` を先に詰める）は**対象を広げるためでは
> なく狭く保つためにある** — 非 confirmed はどのみち全部入るので、上位半数の枠を先に
> 食わせておくと和集合の増分が小さくなる。
>
> **`unresolved` も検証対象に入れる（#24）。** 裏付けが取れても `confirmed` へは昇格しない
> （改名の経路が無い）が、Stage 2 は「候補のどれも実在しない/文脈に合わない」を独立した
> 情報源で確かめる唯一の場なので、外すと unresolved が一度も検証されないまま残る。
> 条件は `!== "confirmed"` と書く（値を列挙すると status が増えたときに黙って漏れる）。
>
> **補正のないカードは Stage 2 を通さない**ので、AC「単純で明確な補正は従来程度の低レイテンシ」は
> 自動的に満たされる。そもそも速報は即時表示で Stage 2 は非同期の `card_update` なので、
> 表示までの時間はどちらにせよ変わらない。

**この選定は一発勝負で、漏れた用語は以後も検索されない**（[[termlens-open-issues]] の弱点7）。

## 失敗時の挙動

抽出に失敗すると `scheduler.ts` は**そのチャンクをバッファの先頭に戻して次回に回す**。
一時的なエラーからは自動的に復帰できる設計。

恒久エラー（4xx のうち SDK が再試行しないもの）では抽出を打ち切り、平易な文言で 1 回だけ
通知して再バッファしない。

> 2026-08-27 追記（Issue #23）: **出力が `max_completion_tokens` に達したときは再バッファしない。**
> SDK は `parsed` を null にするのではなく `LengthFinishReasonError` を投げる
> （`openai/lib/parser.js`）。これは `APIError` ではなく `OpenAIError` の直下なので
> `isPermanent()` は false を返し、素通しにすると**同じ長さのチャンクを戻して再送し続ける**
> （確実に同じ所で切れる）。`isUnretryableChunk()` でそのチャンクだけ捨て、
> 連続失敗にも数えない（次のチャンクは通りうるため抽出を止める理由にならない）。
> なお `LengthFinishReasonError` はパッケージのルートから再エクスポートされていないので
> `openai/error` から import する。バッファには 2,000 文字の上限がある（[[termlens-open-issues]] の弱点12）。

> 2026-08-18 追記: **OpenAI へ移行したことで、残高切れの扱いが変わった。**
> Anthropic は残高切れを 400 で返すため 4xx の範囲判定だけで恒久と分類できたが、
> **OpenAI はレート超過と残高切れをどちらも 429 で返す**。429 は一時エラーとして
> 再試行する対象なので、ステータスだけで判定すると**残高切れを永久に再試行し、
> 弱点12 と同じ壊れ方をする**。`isQuotaExhausted()` で `insufficient_quota` /
> `billing_hard_limit_reached` を見て、429 のうち残高切れだけを恒久扱いにしている。

## デデュープ

既出用語の重複表示を、**プロンプト側の指示とサーバー側の正規化 Set** の二重で防いでいる。片方だけだと漏れる。

## 誤認識復元

STT が崩した表記を文脈から正規化し、`correctedFrom` に元の表記を残す。確信度は `status`
（`confirmed` / `probable` / `unresolved`）で表し、`probable` は UI に「もしかして?」バッジを出す。

STT 段階の keyterm ブーストと役割分担しており、**事前に用語集で拾えなかったものをここで回収する**構造。

判断そのものは #23 以降 **候補生成（Stage 1）と検証（Stage 2）の2段階**に分かれている（上記）。

## UI 連携

抽出結果には `surfaceForms`（会話中に現れうる表記ゆれ）が含まれ、`public/app.js` が文字起こし本文中の該当箇所をオレンジ太字にする。タップすると該当カードへスクロールする。本文に無い表記は当たらないか誤爆するだけなので、サーバー側で `filterSurfaceForms()` が絞ってから送る（上記）。
