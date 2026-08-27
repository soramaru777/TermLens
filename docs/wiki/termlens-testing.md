---
title: TermLens のテストと評価
type: howto
project: termlens
scope: shared
sources:
  - package.json
  - tsconfig.test.json
  - tests/
  - src/eval/
  - .github/workflows/test.yml
related: [[termlens-stt-pipeline]], [[termlens-term-extraction]], [[termlens-open-issues]], [[termlens-architecture]]
confidence: high
updated: 2026-08-27
---

# TermLens のテストと評価

品質を測る仕組みは **2層** に分かれている。上の層は決定的で CI が常時回す。下の層は実 API を
叩くのでオプトインでしか動かない。この分離が設計の中心で、崩すと CI が課金と非決定性を抱える。

| 層 | 対象 | 実行 | 決定的か |
|---|---|---|---|
| 決定的テスト | 純関数（正規化・エラー分類・引用除去・話者分割・FIR 設計） | `npm test` / CI 常時 | はい |
| LLM 評価 | 用語抽出そのものの精度 | `RUN_LLM_EVAL=1 npm test` / `npm run eval:llm` | いいえ（3回平均） |

## コマンド

```
npm test        # 決定的テストのみ。LLM は呼ばない。数百ms で終わる
                # (tsx --test --import ./tests/helpers/openai-env.ts で先にダミーキーを入れる)
npm run typecheck   # tsc --noEmit -p tsconfig.test.json
npm run build       # 本番ビルド。dist/server.js を生成する
npm run eval:llm    # LLM 評価を手で回す(課金あり)
```

### tsconfig を分けている理由

**`tsconfig.json` に `tests/` を足してはいけない。** 現行は `rootDir: "src"` なので、
include に `tests/**/*` を加えると rootDir がリポジトリ直下へ繰り上がり、出力が
`dist/server.js` から **`dist/src/server.js` にずれて `npm start` と Dockerfile の
`CMD ["node", "dist/server.js"]` が壊れる**。

そのため型チェック専用の `tsconfig.test.json`（`noEmit` + `rootDir: "."` + `allowJs`）を
別に置き、テストの実行は型チェックを伴わない `tsx --test` に寄せている。
`allowJs` は `tests/lowpass.test.ts` が `public/lowpass.js`（ビルドレスな素の JS）を
import するために要る。

`tsconfig.json` の `exclude` には **`src/eval` を入れてある**。評価ハーネスは tsx で
ソースのまま実行するもので、include に残すと `dist/eval/*.js` が出力され、Dockerfile の
`COPY --from=build /app/dist ./dist` で本番イメージに評価コード一式が入ってしまう。
`rootDir` は `src` のままなので `dist/server.js` の出力構造は変わらない。
`exclude` は `extends` でマージされず継承されるため、**`tsconfig.test.json` 側で
`"exclude": []` に戻して** `src/eval` も型チェックの対象に含めている。

### 新しい依存は入れていない

`node:test` は Node 組み込み、`tsx` は既存の devDependency。vitest 等のテストランナーは
導入していない。フロント（`public/`）はビルドレスのままで、バンドラも入れていない。

## 決定的テスト（`tests/`）

| ファイル | 対象 | 固定していること |
|---|---|---|
| `split-by-speaker.test.ts` | `splitBySpeaker()` / `buildFinalEvents()`（`src/stt/split.ts`） | 話者の切り替わりで分割されること、**1語の相槌も独立して残ること**（閾値を入れていない担保）、`speaker` 不明の word が境界を作らず吸収されること、word を落とさず順序も変えないこと、**単一話者では `transcript` が1文字も変わらず素通しされること**、分割時の text が `transcript` からの**切り出し**であること（語間の空白が落ちないこと）、各イベントに自分のセグメントの `words` だけが載ること、空の text を送らないこと |
| `session-wiring.test.ts` | `Session` の配線（`src/session.ts`） | **表示は即時・抽出は発話単位**の分岐、`UtteranceEnd` の配線、**stop 時に未確定の発話が抽出まで届くこと**（回帰テスト）。mock の再生には頼らず、アダプタが登録したコールバックを掴んで直接叩く |
| `utterance.test.ts` | `UtteranceBuilder`（`src/stt/utterance.ts`） | 4つの確定契機（`speechFinal` / `UtteranceEnd` / **タイムアウト** / 文字数上限）、**定義済み話者**の交代で結合しないこと、`undefined` は境界を作らず吸収されること（`splitBySpeaker` と同じ規則）、1語の相槌が独立して残ること、空バッファで何も発行しないこと、`flush()` / `stop()`。タイムアウトは偽タイマーで検証 |
| `transcript-events.test.ts` | `buildTranscriptEvents()`（`src/stt/deepgram.ts`） | **interim は分割せず `speaker` が `undefined`** であること、`text` が空なら何も返さないこと、全語 speaker 不明でも1件のままであること、**`speechFinal` が分割後の最後の1件にだけ立つこと** |
| `transcript-words.test.ts` | `toTranscriptWords()`（`src/stt/deepgram.ts`） | `punctuated_word` → `punctuatedWord` の変換、欠落フィールドが `undefined` のまま通ること、空配列・undefined は `undefined` |
| `mock-words.test.ts` | `MOCK_SCRIPT` / `buildMockWords()` / `sliceMockWords()` / `MockSttAdapter` | 手書き word 分割の不変条件 `words.map(w => w.punctuated ?? w.word).join("") === text`、句読点を独立 word にしないこと、`start` が**スクリプト一周を通して**単調増加すること、誤認識語だけ低 confidence（`term-cases.json` の `expectCorrection` と**集合一致**）、interim で境界に跨る word を出さず空 transcript も送らないこと、スクリプトを一周すること（所要時間は `MOCK_SCRIPT.length` から算出）、**1 行が複数 final に割れること**と**`UtteranceBuilder` で組み直すと元の行に1文字も違わず戻ること**（この2つはセット。割れていなければ統合を何も検証しないテストになる） |
| `context-window.test.ts` | `ContextWindow`（`src/extract/context.ts`） | 上限で**古いチャンクから丸ごと捨てる**こと（`" "` の区切りも長さに数える）、1チャンク単独で超えるときだけ `slice(-maxChars)` で頭を削ること、空文字を無視すること、`clear()` |
| `surface-forms.test.ts` | `filterSurfaceForms()`（`src/extract/extractor.ts`） | `newTranscript` に**実在する表記だけ**が残ること、**空になってもカードは落とさない**こと、他フィールドと入力配列を変えないこと、空文字列（`includes("")` が常に true になる穴） |
| `normalize-status.test.ts` | `normalizeStatus()`（`src/extract/extractor.ts`） | `unresolved` の `description` が**定型文（`UNRESOLVED_DESCRIPTION`）に差し替わる**こと（空文字で返ってきた場合も埋める）、`confirmed` / `probable` は**オブジェクトごと素通し**すること（`assert.equal(out[0], input[0])` で参照ごと固定）、他フィールドと入力配列を変えないこと、**`extract()` が実際に通していること**（配線。`parse` だけ差し替えて実 API は叩かない） |
| `card-status.test.ts` | `cardStatus()` / `cardHeading()`（`public/card-status.js`） | **後方互換** — `status` が無い旧カードを `confidence` から導出すること（`low` → `probable`、それ以外 `confirmed`）、`status` を `confidence` より優先すること（降格したカードが復元で戻らない）、どちらも無ければ `confirmed` に倒すこと。**`unresolved` の見出し**が `surfaceForms[0]` → `correctedFrom` → `term` の順に落ちること、`confirmed` / `probable` は `term` のままであること |
| `app-wiring.test.ts` | `public/app.js` が `card-status.js` のガードを**実際に呼んでいる**こと | **ソース文字列を読む不格好なテスト**。純関数の中身は押さえてあっても「app.js がそれを使っている」ことは1本も守られておらず、**#24 のレビューで2度指摘された不具合そのものを書き戻しても全テストが緑のまま**だった（変異で確認）。`app.js` はモジュール評価時に `document` を触るので Node から import できず、jsdom はビルドレスの方針に対して重い。壊れやすいが**壊れたときに直すべきなのは呼び出し側**なので誤検知にならない。「本文を畳み込み後のカードから描く」は該当行が2箇所あるため**悪い形の不在**で判定する |
| `candidates.test.ts` | `normalizeCandidates()`（`src/extract/extractor.ts`） | 上限（`MAX_CANDIDATES` = 3）で切ること、**先頭を差し込んだ後に切る**こと（先に切ると `term` 自身が枠から溢れる）、`term` を先頭へ移すこと、候補が空なら `term` 1件を補うこと、**先頭の表記を `card.term` に揃える**こと（不変条件 `candidates[0].term === term` を表記ゆれで条件付きにしない）、正規化キーが同じ候補を畳むこと、空・空白だけの候補を落とすこと、他フィールドと入力配列を変えないこと |
| `verify-parse.test.ts` | `parseVerifyOutput()` / `isVerified()` / `buildVerifyInput()` / `verifyAndEnrich()` の配線（`src/extract/enrich.ts`） | **候補に無い用語を採らない**こと（採れると検証段が新しい誤補正を作れてしまう）、`chosen` が null/空文字なら棄却、`chosen` の表記ゆれを候補側の表記に揃えること、コードフェンス・前置き越しでも JSON を拾うこと、`description` の引用記法除去と120字クランプ、**解釈できない出力を例外にする**こと（握り潰すと検証が効いていないことに気づけない）、`isVerified()` が候補#2 の採用を裏付け無しとすること、**`tools`（web検索）と `text`（構造化出力）と `include`（検索結果の同梱）を同時に要求している**こと、**後ろに別のオブジェクトや `}` を含む後書きが続いても最初の1件だけを拾う**こと（末尾の `}` まで舐めると巻き込んでパースに失敗する）。`responses.create` だけ差し替えて実 API は叩かない |
| `scheduler-verify.test.ts` | `selectVerifyTargets()` と検証つき清書の分岐（`src/extract/scheduler.ts`） | 補正あり・`status !== "confirmed"` はレア度が最下位でも検証対象になること（**レア度上位の枠を埋めた状態で確かめる**。枠が空いていると従来条件だけで通ってしまい、追加した条件を消しても落ちないテストになる）、**`unresolved` も対象に入ること**（`status === "probable"` と書くと黙って漏れる）、検証に回るカード数が選定と一致すること、`willEnrich` が選定と一致すること、補正なし `confirmed` は対象外になりうること、**`candidates` がクライアント向けカードに含まれない**こと（スプレッドで漏れる）、棄却時に **`status: "unresolved"` が `card_update` で届く**こと（#24 の肝。ここが `confirmed` のままだと裏付けの取れなかったカードが通常カードとして残る）、**裏付けが取れたら `confirmed` が届く**こと、解説は速報のまま・リンクは空であること（送らないと「確認中」の表示が畳まれず回り続ける）、速報カードは消さないこと、`console.warn` が `term` と `reason` だけを出し**文字起こし本文を含まない**こと、候補#2 が選ばれた場合も改名せず `unresolved` に降格すること |
| `scheduler-context.test.ts` | `ExtractionScheduler` の文脈保持（`src/extract/scheduler.ts`） | 成功したチャンクだけが次回の `contextTranscript` になること、**一時エラーのチャンクは積まれない**こと（回帰テストの本体。戻ってきたチャンクが文脈と新規の両方に出ない）、恒久エラーで文脈も捨てること、**既出用語のデデュープが壊れていない**こと。private の `extract` を差し替えて LLM を呼ばずに回す |
| `normalize-term.test.ts` | `normalizeTerm()`（`src/extract/normalize.ts`） | NFKC・小文字化・空白除去で表記ゆれが同一キーに畳まれる／別語は衝突しない |
| `error-classify.test.ts` | `isPermanent()` / `isQuotaExhausted()` / `toUserMessage()` | 400/401/403/404/422/429(quota) は恒久、408/409/429(rate)/5xx/接続エラーは一時。利用者向け文言 |
| `strip-citations.test.ts` | `stripInlineCitations()` | 除去する記法と、触ってはいけない日本語の記号 |
| `lowpass.test.ts` | `designLowpass()` | 通過域・阻止域・直流ゲイン・線形位相 |
| `eval-metrics.test.ts` | `src/eval/metrics.ts` | 6指標の計算そのもの（LLM 抜き）。**`probable` と `unresolved` を別々の列に数える**こと（#24。合算すると過剰 unresolved に気づけない） |
| `llm-eval.test.ts` | 用語抽出（LLM） | 既定では **skip**。ケース JSON のスキーマ検証だけ常時実行 |

### fixture に会話内容を入れない

`tests/fixtures/deepgram-words.json`（Issue #19 で追加）は word の全フィールドを持つが、
**`word` も `punctuated_word` もすべて `w1` / `w2.` … のダミー文字列**で、テストが形式を
検証している。加えて**許可キーのホワイトリスト**（`word` / `punctuated_word` / `start` /
`end` / `confidence` / `speaker`）を検査し、`transcript` のような余計なキーが混ざれば失敗する。

`tests/fixtures/speaker-segments.json`（Issue #20 で追加）は **speaker 番号と id しか持たない**。
話者分割の検証に語句は不要なので、実会議の断片が混ざる経路をそもそも作らない。

- `id` は**ケバブケース ASCII に限定**する。ケースの意図（日本語の説明）は fixture ではなく
  テストファイル側の定数に置く。**fixture に自由記述の欄を作らない** — 匿名化検査を当てられない
  穴になり、実会議の語をそこに書けてしまうため
- ホワイトリストは**入れ子にも当てる**。`expect` の要素は `speaker` / `count` だけを許す
- `speakers` / `expect` の数値は整数か `null` であることを検査する（文字列が入り得ない）

> **fixture のケースは集合一致で固定する。** `for (const c of cases) test(...)` だけだと、
> fixture からケースを消してもテストが静かに減るだけで通る。`speaker-segments.json` は
> テスト側に期待 id の一覧を持ち、集合が一致しなければ失敗する。
> `MOCK_MISHEARD_WORDS`（[[termlens-stt-pipeline]]）で同じ片方向 drift を踏んだ教訓。

> 2026-08-26: Issue #20 で `diarize-words.json` を削除した（`dominantSpeaker()` の廃止に伴い、
> それを検証していた `dominant-speaker.test.ts` ごと不要になったため）。**期待値のキー名を
> `expect` に揃える**という規約は残っている fixture でも継続している。

### OpenAI クライアントの読み込み対策

`src/extract/extractor.ts` と `enrich.ts` は **モジュール読み込み時に `new OpenAI()` を評価する**。
API キーが無いとその場で例外になる。対策は2つ。

1. **純粋な文字列関数を切り離す。** `normalizeTerm()` は依存ゼロの `src/extract/normalize.ts`
   に置く。`scheduler.ts`（OpenAI を抱える）と同居させていたせいで、正規化を使いたいだけの
   `normalize-term.test.ts` / `eval-metrics.test.ts` / `src/eval/metrics.ts` まで API キーを
   要求していた。`scheduler.ts` は `normalize.ts` から import して使う（re-export はしない）。
2. **残りはランナーレベルで注入する。** `package.json` の test スクリプトが
   `tsx --test --import ./tests/helpers/openai-env.ts` でダミーキーを先回りさせる。
   ファイル先頭の import 順に依存しないので、将来 import ソート（Prettier organize-imports、
   eslint `import/order`）を入れても壊れない。

`extractor.ts` の `client` と `enrich.ts` の `client` は **どちらも export してある**。
`chat.completions.parse` / `responses.create` だけを差し替えれば、実 API を叩かずに
配線（文脈が user ターンに乗るか、検証結果で分岐しているか）を端から端まで通せる。
**`enrichCard` は `void` の投げっぱなし**なので、スケジューラのテストでここを潰さないと
ダミーキーのまま api.openai.com へ本当にリクエストが飛ぶ。

ヘルパは **キーの有無で分岐せず無条件に上書きする**。分岐させると `export OPENAI_API_KEY=sk-...`
しているシェルでは実キーがクライアントに入り、「決定的テストからは本物の API を叩けない」が
条件付きの主張になってしまう。

唯一の例外がオプトインの `RUN_LLM_EVAL=1`。`--import` は **全テストプロセスで走る**ので
（`node:test` はファイルごとに子プロセスを立てる）、ここでダミーを入れると
`RUN_LLM_EVAL=1 npm test` の実 API 呼び出しまで潰れてしまう。そのためヘルパは
`RUN_LLM_EVAL=1` のときだけ先に `.env` を読み、実キーがあればそれを残す。
実キーが無ければダミーを入れたうえで、`llm-eval.test.ts` が
`DUMMY_OPENAI_KEY` と突き合わせて「キー無し」と判定し skip する
（ダミーを実キーと誤認して API を叩きに行かないため）。

### ローパス FIR の実測値

`public/audio-processor.js` から `designLowpass` を **`public/lowpass.js` に切り出した**。
AudioWorklet から static import しつつ、Node のテストからも読めるようにするためで、
そのため `lowpass.js` には副作用（`registerProcessor` など worklet 固有の API）を置かない。

**設計パラメータ（`FIR_TAPS` / `CUTOFF_MARGIN` / `TARGET_SAMPLE_RATE`）も `lowpass.js` が
唯一の定義箇所。** `audio-processor.js`・`app.js`・`tests/lowpass.test.ts` はすべてここから
import する。テストが値をコピーしていると、本番側を変えてもテストが緑のまま通り、
守りたい当のパラメータを守れない。

> **未検証: AudioWorklet 内の static import はブラウザ差があるため、実機確認が別途必要。**
> `addModule()` は module script として読むので Chrome/Safari では動く想定だが、
> iPad Safari での確認は 2026-08-25 時点で未実施。ここは推測であり実測していない。

`tests/lowpass.test.ts` は係数から DFT で `|H(f)| = |Σ h[n]·e^(-j2πf·n/fs)|` を求める。
本番と同じ 63タップ・遮断 7000Hz（= 目標ナイキスト 8kHz の 87.5%）での実測値:

| 入力レート | 通過域 1k–6kHz の最悪 | 阻止域 9kHz–ナイキストの最悪 |
|---|---|---|
| 48000 Hz | **-0.726 dB** @ 6000 Hz | **-64.613 dB** @ 9000 Hz |
| 44100 Hz | **-0.557 dB** @ 6000 Hz | **-75.315 dB** @ 9845 Hz |

採用した閾値は **通過域 ≥ -1.0 dB / 阻止域 ≤ -64.0 dB**。

> 訂正済み（2026-08-25）: [[termlens-stt-pipeline]] と `audio-processor.js` のコメントは阻止域を
> 「約 -65dB 以下」と書いていた。48kHz 入力の最悪点（帯域端の 9kHz）は **-64.6dB** で -65dB に
> わずかに届かないため、コメントは `lowpass.js`（定数の移動先）で実測値に書き換えてある。
> 44.1kHz は入力ナイキストが低いぶん阻止域が 9.8kHz 付近まで押し下がり、10dB 以上の余裕がある。
> 実用上の差は無いが、閾値は実測から決めている。

## LLM 評価（`src/eval/`）

### 実行方法

```
RUN_LLM_EVAL=1 npm test          # node:test の中で回す
npm run eval:llm                  # 単体で回す。表は stderr、JSON は stdout
npm run eval:llm -- --out /tmp/eval.json   # JSON をファイルへ
npm run eval:llm > /tmp/eval.json          # stdout のリダイレクトでも同じ
```

**JSON はリポジトリに書き出さない。** 既定の出力先は標準出力で、保存したいときだけ
`--out` に任意のパスを渡す。JSON にはケース別スコアと全体スコアの両方が入るので、
前回の結果との差分比較に使える。

### ケース（`tests/fixtures/term-cases.json`）

17件。**すべて合成**で、実会議の録音・文字起こしからの抜粋は使っていない
（`src/stt/mock-script.ts` と同じ方針）。実会議の情報が混ざる経路を原理的に断つため。
誤認識カタカナ（クバネテス／グラファナ／ピネコーネ）、略語の読み上げ（オーオース／
ピーケーシーイー／エヌディーエー）、用語集ブースト、既出用語のデデュープ、
「カードが出ないのが正解」の一般語のみのケースを混ぜてある。

`context`（#22）は「直前の会話」として抽出器に渡すフィールドで、既定は空文字。
これを使う2ケースを足してある。

- `context-disambiguation` — 文脈がドメインを確立し、`transcript` 単体では曖昧な誤認識語を
  `expectCorrection` に置く。**文脈あり/なしで正しい補正率が動くか**を見る
- `context-no-recard` — `context` にしか登場しない用語を `forbidTerms` に置く。
  AC「過去文脈の用語を再カード化しない」を誤補正率として測る

#23 で「**音韻的にそれらしい実在の別用語へ誤補正しやすい**」ケースを2件足した。
誤答側を `forbidTerms`、正答側を `expectCorrection` に置いてあるので、検証が効いたかが
数値で出る。狙いは「実在しない語を弾く」ではなく「**実在するが文脈に合わない語**を弾く」ほうで、
そこが Stage 2 に web 検索という独立した情報源を持たせた理由でもある。

- `lookalike-ansible` — 「アンシブル」→ `Ansible`。誤答側は `アンサンブル` / `Ensemble`
  （ML の実在手法）。`context` は自動化・構成管理の話
- `lookalike-confluence` — 「コンフルエンス」→ `Confluence`。誤答側は `Confluent`
  （Kafka の企業。カタカナではほぼ同音）。`context` はドキュメントの置き場所の話

#24 で「**そもそも特定できないのが正解**」のケースを2件足した。どちらも `expectTerms` と
`expectCorrection` は空で、**音韻が近いだけの実在用語を `forbidTerms` に置いてある**。
測っているのは「断定しないこと」で、指標としては誤補正率に出る。聞き取られた表記そのものは
`allowLowConfidence` に入れてある（`unresolved` でも `term` は残る＝ Precision の分母に入るため）。

- `unresolved-garbled-product` — 「グラファトス」。誤答側は `Grafana` / `Graphite`。
  `context` は監視ツールを揃えたいという話で、**文脈が誤答を後押しする向き**に置いてある
- `unresolved-lookalike-noise` — 「ケルベロッサ」。誤答側は `Kerberos`。
  `context` は認証の話を**あえて含めていない**（含めると Kerberos が正答になりうる）

> **unresolved 率だけを見て良し悪しを判断しない。** 何でも「特定できません」にすれば
> この2ケースは通るが、Recall と正しい補正率が落ちる。**セットで読むこと。**

### 指標

| 指標 | 定義 | 既定の閾値 |
|---|---|---|
| 用語 Recall | `expectTerms` のうち出力カードの `term` に一致した割合 | ≥ 0.8 |
| 正しい補正率 | `correctedFrom` が誤表記かつ `term` が正表記のカードが出た割合 | （報告のみ） |
| 誤補正率 | 禁止語が出た、または誤表記から別の用語に着地したケース ÷ 全ケース | ≤ 0.05 |
| probable 率 | `expectTerms` のうちカードは出たが `status === "probable"` ÷ `expectTerms` 総数 | （報告のみ） |
| unresolved 率 | `expectTerms` のうちカードは出たが `status === "unresolved"` ÷ `expectTerms` 総数 | （報告のみ） |
| カード Precision | 出力カード（**正規化キーで dedupe 後**）のうち `expectTerms ∪ allowLowConfidence` に含まれる割合 | ≥ 0.6 |

- **突き合わせは必ず `normalizeTerm()` を通す**（`src/extract/scheduler.ts` から import）。
  本番のデデュープと同じ土俵に揃えないと、全角/半角の違いだけで取りこぼす
- 集計は**分子分母の合算**で行う。ケースごとの割合を平均すると、期待用語が1件のケースと
  4件のケースが同じ重みになってしまう
- 期待が空のケース（`plain-japanese-only`）は Recall/補正の分母に入らない。
  禁止語と Precision だけで評価する

閾値と試行回数は `src/eval/run.ts` の `EVAL_DEFAULTS` に1か所でまとめてあり、
`EVAL_RUNS` / `EVAL_CONCURRENCY` / `EVAL_MIN_RECALL` / `EVAL_MAX_MISCORRECTION` /
`EVAL_MIN_PRECISION` で上書きできる。既定は3回試行・並列4。

### 文脈あり/なしの比較

`EVAL_NO_CONTEXT=1` を付けるとケースの `context` を空にして流す（`EvalConfig.useContext`）。
**同じ fixture で2回回して差分を見る**ための切り替えで、`EvalReport` は `config` を丸ごと
持つので**どちらのモードで測ったかがレポートに残る**（表の見出しにも出る）。

```sh
npm run eval:llm -- --out /tmp/with-context.json
EVAL_NO_CONTEXT=1 npm run eval:llm -- --out /tmp/without-context.json
```

`0` / `1` 以外の値は例外にする。`EVAL_NO_CONTEXT=true` を黙って無視すると
「文脈なしで測ったつもりが文脈ありだった」レポートができ、比較そのものが無意味になる。

### 検証あり/なしの比較（`EVAL_WITH_VERIFY`）

> 2026-08-27 追加（Issue #23）。

**評価ハーネスは `createExtractor()` を直接呼ぶので、既定では Stage 1 しか測らない。**
`EVAL_WITH_VERIFY=1` を付けると Stage 2（検証つき清書）まで通す。既定は false で、
`flagEnv()` の作法は `EVAL_NO_CONTEXT` と同じ。`EvalConfig` に載るのでレポートにも表にも残る。

| モード | 測るもの |
|---|---|
| 既定（Stage 1 のみ） | **候補列挙のプロンプト変更**が既存の指標を悪化させていないか |
| `EVAL_WITH_VERIFY=1` | **検証そのもの**の効果。誤補正率が下がるか、正しい補正率が落ちていないか |

分けるのは切り分けのため。プロンプト変更と検証は別々に悪化しうるので、まとめて測ると
原因が分からない。`EVAL_WITH_VERIFY=1` は web 検索を伴うので**遅く高い**。

検証対象の選定は本番と同じ `selectVerifyTargets()` を呼ぶ。**ここにコピーを置くと、
本番の選定条件を変えたときに評価だけ古い条件のまま緑になる。**

**裏付けの取れなかったカードは指標から落とす**（`EVAL_ALLOW_RENAME=1` のとき）。
評価で測りたいのは検証の判断そのものなので、判断を反映させる。

> 2026-08-27 追記（#24）: **既定モードでも `status` だけは本番と同じに動かす**
> （裏付けあり → `confirmed`、棄却・候補#2 → `unresolved`）。揃えないと probable /
> unresolved の2列が Stage 1 の申告のままになり、検証の効果が数字に出ない。
> `term` は変えないので Recall / 誤補正率 / Precision には影響せず、合否ゲートは動かない。

> **誤補正率だけを見ると過剰棄却を見逃す。** 何も補正しなくなれば誤補正率は 0 になる。
> `expectCorrection`（正しい補正率）と**必ずセットで**読むこと。リスクとしてはここが最大。

### 「何も測らなかった」を PASS にしない

品質ゲートの最悪の失敗モードは、測っていないのに緑になることなので、3か所で塞いである。

- **`EVAL_RUNS` / `EVAL_CONCURRENCY` は1以上の整数として検証する。** `EVAL_RUNS=0` は
  ジョブ0件 → 全指標 1.0 → PASS になっていた。`EVAL_RUNS=2.5` が黙って2回になる件も同じ入口で弾く
- **ジョブが0件なら `runEval()` が例外を投げる。** ケースが空でも同じ穴が開くため
- **1ジョブの失敗で全体を落とさない。** 429/500 は `jobErrors` に記録して集計を続ける
  （33本中1本の失敗で完了済み32本の課金を捨てない）。ただし測れなかったぶんは指標に出ないので、
  **`jobErrors` が1件でもあれば `pass` にはしない**。全滅した場合は集計する意味が無いので例外にする

レポートの `model` は `process.env.LLM_MODEL` ではなく **`config.llmModel`（実際に叩いた
モデル名）** を記録する。未設定時に `"(既定)"` としか残らないと、後日 `src/config.ts` の既定を
変えたときに別モデルの結果が同じラベルで並んでレポート比較が破綻するため。

## CI（`.github/workflows/test.yml`）

`npm ci` → `npm test` → `npm run typecheck`。Node 22（Dockerfile の `node:22-slim` に合わせる）。
**`RUN_LLM_EVAL` は設定しない**ので LLM 評価は必ず skip される。
push は develop / main に絞り、feature ブランチは `pull_request` 側で回す（同じコミットを
2回テストしないため）。ビルド確認は既存の `deploy.yml` が担当している。

## この仕組みで測れないもの

[[termlens-open-issues]] の未検証1と対応する。ここは**依然として実声でしか測れない**。

- **CER / WER**（文字誤り率・単語誤り率）— 正解トランスクリプトと実音声のペアが要る。
  現状は正解ラベル付きの音声資産が無い
- **Deepgram 自身の話者クラスタリング精度** — テストできるのは
  「単語配列 → セグメント列」の分割ロジックだけで、各単語に `speaker` を付けているのは Deepgram。
  複数話者の実声が要る。Issue #20 で多数決をやめて以降、**Deepgram 側の `speaker` の揺れが
  そのまま細切れの発話として出る**ようになったため、ここが測れないことの重みは増している
- **AudioWorklet の実機挙動** — FIR の係数は検証できるが、worklet が実際に動くか、
  static import が iPad Safari で通るかは実機でしか分からない
