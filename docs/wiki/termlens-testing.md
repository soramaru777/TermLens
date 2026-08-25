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
updated: 2026-08-26
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
| `transcript-events.test.ts` | `buildTranscriptEvents()`（`src/stt/deepgram.ts`） | **interim は分割せず `speaker` が `undefined`** であること、`text` が空なら何も返さないこと、全語 speaker 不明でも1件のままであること |
| `transcript-words.test.ts` | `toTranscriptWords()`（`src/stt/deepgram.ts`） | `punctuated_word` → `punctuatedWord` の変換、欠落フィールドが `undefined` のまま通ること、空配列・undefined は `undefined` |
| `mock-words.test.ts` | `MOCK_SCRIPT` / `buildMockWords()` / `sliceMockWords()` / `MockSttAdapter` | 手書き word 分割の不変条件 `words.map(w => w.punctuated ?? w.word).join("") === text`、句読点を独立 word にしないこと、`start` が**スクリプト一周を通して**単調増加すること、誤認識語だけ低 confidence（`term-cases.json` の `expectCorrection` と**集合一致**）、interim で境界に跨る word を出さず空 transcript も送らないこと、スクリプトを一周すること（所要時間は `MOCK_SCRIPT.length` から算出） |
| `normalize-term.test.ts` | `normalizeTerm()`（`src/extract/normalize.ts`） | NFKC・小文字化・空白除去で表記ゆれが同一キーに畳まれる／別語は衝突しない |
| `error-classify.test.ts` | `isPermanent()` / `isQuotaExhausted()` / `toUserMessage()` | 400/401/403/404/422/429(quota) は恒久、408/409/429(rate)/5xx/接続エラーは一時。利用者向け文言 |
| `strip-citations.test.ts` | `stripInlineCitations()` | 除去する記法と、触ってはいけない日本語の記号 |
| `lowpass.test.ts` | `designLowpass()` | 通過域・阻止域・直流ゲイン・線形位相 |
| `eval-metrics.test.ts` | `src/eval/metrics.ts` | 5指標の計算そのもの（LLM 抜き） |
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

11件。**すべて合成**で、実会議の録音・文字起こしからの抜粋は使っていない
（`src/stt/mock-script.ts` と同じ方針）。実会議の情報が混ざる経路を原理的に断つため。
誤認識カタカナ（クバネテス／グラファナ／ピネコーネ）、略語の読み上げ（オーオース／
ピーケーシーイー／エヌディーエー）、用語集ブースト、既出用語のデデュープ、
「カードが出ないのが正解」の一般語のみのケースを混ぜてある。

### 指標

| 指標 | 定義 | 既定の閾値 |
|---|---|---|
| 用語 Recall | `expectTerms` のうち出力カードの `term` に一致した割合 | ≥ 0.8 |
| 正しい補正率 | `correctedFrom` が誤表記かつ `term` が正表記のカードが出た割合 | （報告のみ） |
| 誤補正率 | 禁止語が出た、または誤表記から別の用語に着地したケース ÷ 全ケース | ≤ 0.05 |
| unresolved 率 | `expectTerms` のうちカードは出たが `confidence === "low"` ÷ `expectTerms` 総数 | （報告のみ） |
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
