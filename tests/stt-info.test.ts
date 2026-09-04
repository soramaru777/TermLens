import assert from "node:assert/strict";
import test from "node:test";
import { toSttInfo } from "../src/stt/deepgram.js";

/**
 * Deepgram の Results metadata → `SttInfo`（#46）。
 *
 * 固定するのは2つ。
 *
 * 1. **セッションを一意に指す値を通さない。** 診断ファイルは実機比較の結果として
 *    共有されうる。`request_id` は会話本文でも音声でもないが、そのセッションを
 *    一意に指す値なので、`public/diagnostics.js` の `TRACK_KEYS`（採用リスト）と
 *    同じ思想で、必要なものだけを明示的に通す
 * 2. **取れなかったことを「取れた」と偽らない。** `diarize_info` は diarizer が
 *    動いたときだけ present で、metadata 自体が無いメッセージもある
 */

/** 実際の streaming metadata が持つ形（値はダミー）。 */
const METADATA = {
  request_id: "0d5e6a1b-1111-2222-3333-444455556666",
  model_info: { name: "nova-3", version: "2025-01-01.0", arch: "nova-3" },
  model_uuid: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
  diarize_info: { model_uuid: "11112222-3333-4444-5555-666677778888", arch: "v1" },
};

test("model_info と diarize_info をキャメルケースへ写す", () => {
  assert.deepEqual(toSttInfo(METADATA), {
    model: { name: "nova-3", version: "2025-01-01.0", arch: "nova-3" },
    diarizer: { arch: "v1", modelUuid: "11112222-3333-4444-5555-666677778888" },
  });
});

/**
 * **`request_id` は診断へ出さない。** 型（`DeepgramMetadata`）に持たせていないので
 * そもそも書きようがないが、素通し実装へ戻したときにここが落ちる。
 */
test("request_id は通さない", () => {
  const info = toSttInfo(METADATA)!;
  const json = JSON.stringify(info);
  assert.equal(json.includes(METADATA.request_id), false, "request_id が診断へ流れている");
  assert.equal(json.includes("request"), false);
  // 認識モデルの model_uuid も載せない（診断で読むのは diarizer 側）
  assert.equal(json.includes(METADATA.model_uuid), false);
});

test("diarize_info が無ければ diarizer のキーごと落とす", () => {
  // diarize が無効/未起動のときは present にならない。空オブジェクトを入れると
  // 受け手が「取れたが中身が空だった」と区別できなくなる
  const info = toSttInfo({ model_info: METADATA.model_info })!;
  assert.deepEqual(Object.keys(info), ["model"]);
  assert.equal("diarizer" in info, false);
});

test("model_info が無くても diarizer だけで返す", () => {
  assert.deepEqual(toSttInfo({ diarize_info: { arch: "v1" } }), {
    diarizer: { arch: "v1" },
  });
});

test("metadata 自体が無い/空なら undefined（コールバックを呼ばせない）", () => {
  assert.equal(toSttInfo(undefined), undefined);
  assert.equal(toSttInfo({}), undefined);
  assert.equal(toSttInfo({ model_info: {}, diarize_info: {} }), undefined);
});
