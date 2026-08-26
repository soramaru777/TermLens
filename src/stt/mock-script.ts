// モックSTT用のダミー会議トランスクリプト(話者付き)。
// 音声認識の誤りを模して、一部のカタカナ語をわざと崩している
// (クバネテス→Kubernetes、ラグ→RAG、ピネコーネ→Pinecone など)。

/**
 * 手書き word 分割の1語。
 *
 * 実 Deepgram は句読点を独立した word として出さず、`punctuated_word` に付随させる
 * （`word: "います"` / `punctuated_word: "います。"`）。mock もそれに合わせる。
 * 句読点を独立 word にすると 1 行あたりの word 数が1割ほど水増しされ、
 * 「話者分割の粒度」「低 confidence word の割合」のような word 数ベースの処理が
 * mock と実機で系統的にズレる。
 */
export interface MockWord {
  /** 句読点を含まない素の表記。`TranscriptWord.word` になる */
  word: string;
  /** 句読点つき表記。句読点が付かない語では省略する。`TranscriptWord.punctuatedWord` になる */
  punctuated?: string;
}

export interface MockLine {
  text: string;
  speaker: number;
  /**
   * 手書きの word 分割。**`punctuated ?? word` を連結すると `text` と一致すること**
   * （tests/mock-words.test.ts で不変条件として固定している）。
   *
   * **日本語は分かち書きしないため、Deepgram の word 区切りを機械的に再現できない。**
   * ここにあるのは Deepgram の区切りに近づけて人が書いたもので、
   * 実物とは「形が同じだけの別物」である（docs/wiki/termlens-stt-pipeline.md）。
   */
  words: MockWord[];
}

export const MOCK_SCRIPT: MockLine[] = [
  {
    text: "それでは定例ミーティングを始めます。まずインフラ側の状況からお願いします。",
    speaker: 0,
    words: [
      { word: "それでは" },
      { word: "定例" },
      { word: "ミーティング" },
      { word: "を" },
      { word: "始めます", punctuated: "始めます。" },
      { word: "まず" },
      { word: "インフラ" },
      { word: "側" },
      { word: "の" },
      { word: "状況" },
      { word: "から" },
      { word: "お願いします", punctuated: "お願いします。" },
    ],
  },
  {
    text: "先週からクバネテスのポッドが頻繁に再起動していて、原因を調査しています。",
    speaker: 1,
    words: [
      { word: "先週" },
      { word: "から" },
      { word: "クバネテス" },
      { word: "の" },
      { word: "ポッド" },
      { word: "が" },
      { word: "頻繁に" },
      { word: "再起動して" },
      { word: "いて", punctuated: "いて、" },
      { word: "原因" },
      { word: "を" },
      { word: "調査して" },
      { word: "います", punctuated: "います。" },
    ],
  },
  {
    text: "メモリリークの可能性が高いので、グラファナでメトリクスを監視しているところです。",
    speaker: 1,
    words: [
      { word: "メモリリーク" },
      { word: "の" },
      { word: "可能性" },
      { word: "が" },
      { word: "高い" },
      { word: "ので", punctuated: "ので、" },
      { word: "グラファナ" },
      { word: "で" },
      { word: "メトリクス" },
      { word: "を" },
      { word: "監視して" },
      { word: "いる" },
      { word: "ところ" },
      { word: "です", punctuated: "です。" },
    ],
  },
  {
    text: "了解です。次に新機能の件ですが、ラグの検索精度がまだ課題になっています。",
    speaker: 0,
    words: [
      { word: "了解" },
      { word: "です", punctuated: "です。" },
      { word: "次に" },
      { word: "新機能" },
      { word: "の" },
      { word: "件" },
      { word: "です" },
      { word: "が", punctuated: "が、" },
      { word: "ラグ" },
      { word: "の" },
      { word: "検索" },
      { word: "精度" },
      { word: "が" },
      { word: "まだ" },
      { word: "課題" },
      { word: "に" },
      { word: "なって" },
      { word: "います", punctuated: "います。" },
    ],
  },
  {
    text: "エンベディングのモデルを変えるか、チャンクの分割方法を見直すか検討中です。",
    speaker: 2,
    words: [
      { word: "エンベディング" },
      { word: "の" },
      { word: "モデル" },
      { word: "を" },
      { word: "変える" },
      { word: "か", punctuated: "か、" },
      { word: "チャンク" },
      { word: "の" },
      { word: "分割" },
      { word: "方法" },
      { word: "を" },
      { word: "見直す" },
      { word: "か" },
      { word: "検討中" },
      { word: "です", punctuated: "です。" },
    ],
  },
  {
    text: "ベクトルデータベースはピネコーネの想定でしたが、コスト面でクドラントも比較しています。",
    speaker: 2,
    words: [
      { word: "ベクトル" },
      { word: "データベース" },
      { word: "は" },
      { word: "ピネコーネ" },
      { word: "の" },
      { word: "想定" },
      { word: "でした" },
      { word: "が", punctuated: "が、" },
      { word: "コスト" },
      { word: "面" },
      { word: "で" },
      { word: "クドラント" },
      { word: "も" },
      { word: "比較して" },
      { word: "います", punctuated: "います。" },
    ],
  },
  {
    text: "認証まわりはオーオースの認可コードフローにピーケーシーイーを組み合わせる方針です。",
    speaker: 1,
    words: [
      { word: "認証" },
      { word: "まわり" },
      { word: "は" },
      { word: "オーオース" },
      { word: "の" },
      { word: "認可" },
      { word: "コード" },
      { word: "フロー" },
      { word: "に" },
      { word: "ピーケーシーイー" },
      { word: "を" },
      { word: "組み合わせる" },
      { word: "方針" },
      { word: "です", punctuated: "です。" },
    ],
  },
  {
    text: "契約面では、先方とエヌディーエーを締結してから詳細仕様を共有する流れになります。",
    speaker: 0,
    words: [
      { word: "契約" },
      { word: "面" },
      { word: "で" },
      { word: "は", punctuated: "は、" },
      { word: "先方" },
      { word: "と" },
      { word: "エヌディーエー" },
      { word: "を" },
      { word: "締結して" },
      { word: "から" },
      { word: "詳細" },
      { word: "仕様" },
      { word: "を" },
      { word: "共有する" },
      { word: "流れ" },
      { word: "に" },
      { word: "なります", punctuated: "なります。" },
    ],
  },
  {
    text: "サーバー費用の減価償却の扱いについては経理と確認中です。",
    speaker: 0,
    words: [
      { word: "サーバー" },
      { word: "費用" },
      { word: "の" },
      { word: "減価償却" },
      { word: "の" },
      { word: "扱い" },
      { word: "に" },
      { word: "ついて" },
      { word: "は" },
      { word: "経理" },
      { word: "と" },
      { word: "確認中" },
      { word: "です", punctuated: "です。" },
    ],
  },
  {
    text: "リリースはカナリアデプロイで段階的に出して、問題があればすぐロールバックします。",
    speaker: 1,
    words: [
      { word: "リリース" },
      { word: "は" },
      { word: "カナリア" },
      { word: "デプロイ" },
      { word: "で" },
      { word: "段階的に" },
      { word: "出して", punctuated: "出して、" },
      { word: "問題" },
      { word: "が" },
      { word: "あれば" },
      { word: "すぐ" },
      { word: "ロールバック" },
      { word: "します", punctuated: "します。" },
    ],
  },
  {
    text: "監視のアラートはスロットリングを入れて、オンコール担当の負荷を下げたいですね。",
    speaker: 2,
    words: [
      { word: "監視" },
      { word: "の" },
      { word: "アラート" },
      { word: "は" },
      { word: "スロットリング" },
      { word: "を" },
      { word: "入れて", punctuated: "入れて、" },
      { word: "オンコール" },
      { word: "担当" },
      { word: "の" },
      { word: "負荷" },
      { word: "を" },
      { word: "下げたい" },
      { word: "です" },
      { word: "ね", punctuated: "ね。" },
    ],
  },
  {
    text: "では次回までに、それぞれのタスクをジラに起票しておいてください。",
    speaker: 0,
    words: [
      { word: "では" },
      { word: "次回" },
      { word: "まで" },
      { word: "に", punctuated: "に、" },
      { word: "それぞれ" },
      { word: "の" },
      { word: "タスク" },
      { word: "を" },
      { word: "ジラ" },
      { word: "に" },
      { word: "起票して" },
      { word: "おいて" },
      { word: "ください", punctuated: "ください。" },
    ],
  },
];
