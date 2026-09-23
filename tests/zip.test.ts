import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as zlibCrc32 } from "node:zlib";
import { buildZip, crc32, sanitizeExportName, toDosDateTime } from "../public/zip.js";

/**
 * `public/zip.js`（#65）。自前の store 方式 ZIP なので、**壊れても例外は出ず、展開側で
 * 初めて失敗する**（CRC 不一致・日本語名の文字化け・オフセットずれ）。ここでヘッダ構造を
 * テスト内の最小パーサで読み戻し、各フィールドを固定する。
 */

const dec = new TextDecoder();
const enc = new TextEncoder();

interface ParsedEntry {
  name: string;
  nameBytes: Uint8Array;
  flag: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compSize: number;
  size: number;
  localOffset: number;
  data: Uint8Array;
  local: { flag: number; method: number; crc: number; compSize: number; size: number; name: string };
}

/** EOCD → セントラルディレクトリ → ローカルヘッダの順に読む最小パーサ。 */
function parseZip(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22; // コメント長 0 を前提にする（buildZip は常に 0）
  assert.equal(v.getUint32(eocd, true), 0x06054b50, "EOCD のシグネチャ");
  const countDisk = v.getUint16(eocd + 8, true);
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  const commentLen = v.getUint16(eocd + 20, true);
  const entries: ParsedEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50, "セントラルディレクトリのシグネチャ");
    const flag = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true);
    const date = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen2 = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    const nameBytes = buf.slice(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen2;

    const lp = localOffset;
    assert.equal(v.getUint32(lp, true), 0x04034b50, "ローカルヘッダのシグネチャ");
    const lNameLen = v.getUint16(lp + 26, true);
    const lExtraLen = v.getUint16(lp + 28, true);
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    entries.push({
      name: dec.decode(nameBytes),
      nameBytes,
      flag,
      method,
      time,
      date,
      crc,
      compSize,
      size,
      localOffset,
      data: buf.slice(dataStart, dataStart + compSize),
      local: {
        flag: v.getUint16(lp + 6, true),
        method: v.getUint16(lp + 8, true),
        crc: v.getUint32(lp + 14, true),
        compSize: v.getUint32(lp + 18, true),
        size: v.getUint32(lp + 22, true),
        name: dec.decode(buf.slice(lp + 30, lp + 30 + lNameLen)),
      },
    });
  }
  return { countDisk, count, cdSize, cdOffset, commentLen, cdEnd: p, entries };
}

const MTIME = new Date(2026, 8, 10, 8, 20, 30);

test("crc32 は node:zlib の crc32 と一致する", () => {
  const big = new Uint8Array(1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  for (const bytes of [new Uint8Array(0), enc.encode("hello, world"), enc.encode("文字起こし・用語カード"), big]) {
    assert.equal(crc32(bytes), zlibCrc32(bytes));
  }
});

test("1 エントリ: シグネチャ・store・UTF-8 フラグ・サイズ・名前が往復する", () => {
  const text = "# 文字起こし\n\n本文";
  const zip = buildZip([{ name: "議事録.md", data: text }], { mtime: MTIME });
  const z = parseZip(zip);
  assert.equal(z.count, 1);
  assert.equal(z.countDisk, 1);
  assert.equal(z.commentLen, 0);
  const [e] = z.entries;
  const bytes = enc.encode(text);
  assert.equal(e.method, 0);
  assert.equal(e.local.method, 0);
  assert.equal(e.flag & 0x0800, 0x0800, "セントラルの bit 11 が立っていない");
  assert.equal(e.local.flag & 0x0800, 0x0800, "ローカルの bit 11 が立っていない");
  assert.equal(e.compSize, bytes.length);
  assert.equal(e.size, bytes.length);
  assert.equal(e.local.compSize, bytes.length);
  assert.equal(e.local.size, bytes.length);
  assert.deepEqual(e.nameBytes, enc.encode("議事録.md"));
  assert.equal(e.name, "議事録.md");
  assert.equal(e.local.name, "議事録.md");
  assert.equal(e.crc, zlibCrc32(bytes));
  assert.equal(e.local.crc, e.crc);
  assert.equal(dec.decode(e.data), text);
  assert.equal(zip.length, z.cdEnd + 22, "末尾に余計なバイトがある");
});

test("3 エントリ: EOCD の件数・セントラルの位置とサイズ・ローカルのオフセットが実位置と一致", () => {
  const entries = [
    { name: "a/文字起こし.md", data: "one" },
    { name: "a/用語カード.md", data: "two two" },
    { name: "a/収音診断.md", data: new Uint8Array([1, 2, 3, 0, 255]) },
  ];
  const zip = buildZip(entries, { mtime: MTIME });
  const z = parseZip(zip);
  assert.equal(z.count, 3);
  let expectedOffset = 0;
  z.entries.forEach((e, i) => {
    assert.equal(e.localOffset, expectedOffset, `エントリ ${i} のオフセット`);
    expectedOffset += 30 + e.nameBytes.length + e.compSize;
    assert.equal(e.name, entries[i].name);
  });
  assert.equal(z.cdOffset, expectedOffset, "セントラルディレクトリの開始位置");
  assert.equal(z.cdSize, z.cdEnd - z.cdOffset, "セントラルディレクトリのサイズ");
  assert.deepEqual([...z.entries[2].data], [1, 2, 3, 0, 255]);
});

test("`/` を含む名前はそのままフォルダ区切りとして格納する", () => {
  const z = parseZip(buildZip([{ name: "会議/文字起こし.md", data: "x" }], { mtime: MTIME }));
  assert.equal(z.entries[0].name, "会議/文字起こし.md");
  assert.equal(z.count, 1, "フォルダ用の独立エントリは作らない");
});

test("DOS 日時: 2 秒刻み、1980 年未満は 1980-01-01 00:00:00", () => {
  const z = parseZip(buildZip([{ name: "a", data: "" }], { mtime: MTIME }));
  const { time, date } = z.entries[0];
  assert.equal(time >> 11, 8);
  assert.equal((time >> 5) & 0x3f, 20);
  assert.equal((time & 0x1f) * 2, 30);
  assert.equal((date >> 9) + 1980, 2026);
  assert.equal((date >> 5) & 0x0f, 9);
  assert.equal(date & 0x1f, 10);
  // 奇数秒は切り捨て
  assert.equal((toDosDateTime(new Date(2026, 0, 1, 0, 0, 31)).time & 0x1f) * 2, 30);
  const old = toDosDateTime(new Date(1970, 0, 1, 12, 34, 56));
  assert.deepEqual(old, { time: 0, date: (1 << 5) | 1 });
});

test("空の entries は throw する", () => {
  assert.throws(() => buildZip([]), /entries is empty/);
});

test("sanitizeExportName: 禁止文字・制御文字・ドット・長さ・fallback", () => {
  const fb = "termlens-20260910-0820";
  assert.equal(sanitizeExportName('a\\b/c:d*e?f"g<h>i|j', fb), "abcdefghij");
  assert.equal(sanitizeExportName("a\u0000b\u001fc\u007fd\te", fb), "abcde");
  assert.equal(sanitizeExportName("  ..隠し.  ", fb), "隠し");
  assert.equal(sanitizeExportName("末尾ドット...", fb), "末尾ドット");
  assert.equal(sanitizeExportName("x".repeat(100), fb), "x".repeat(80));
  // 80 文字で切ったあとの末尾空白も落とす
  assert.equal(sanitizeExportName("x".repeat(79) + " y", fb), "x".repeat(79));
  // 先頭に `.` と空白が交互に来ても残さない
  assert.equal(sanitizeExportName("  ...  a", fb), "a");
  assert.equal(sanitizeExportName(" .. /x", fb), "x");
  // 絵文字(サロゲートペア)を途中で割らない。1 個 4 バイトなので 200 バイト上限で 50 個
  const emoji = "😀".repeat(90);
  assert.equal(sanitizeExportName(emoji, fb), "😀".repeat(50));
  // 日本語は 1 文字 3 バイトなので 80 文字(240 バイト)ではなく 66 文字で切れる
  assert.equal(sanitizeExportName("あ".repeat(80), fb), "あ".repeat(66));
  // C1 制御文字と双方向制御文字(拡張子の見た目の偽装)を除く
  assert.equal(sanitizeExportName("a\u0085b\u202egpj.exe\u2066c", fb), "abgpj.exec");
  // Windows の予約名は大文字小文字・拡張子の有無によらず fallback
  for (const reserved of ["CON", "nul", "Com1", "LPT9", "aux.txt"]) {
    assert.equal(sanitizeExportName(reserved, fb), fb, reserved);
  }
  assert.equal(sanitizeExportName("CONSOLE", fb), "CONSOLE");
  for (const empty of ["", "   ", ".", "..", "///", "\u0000"]) {
    assert.equal(sanitizeExportName(empty, fb), fb, JSON.stringify(empty));
  }
  assert.equal(sanitizeExportName("定例会議 🎉 2026", fb), "定例会議 🎉 2026");
});

test("純関数: 同じ入力で同じバイト列、入力配列を書き換えない", () => {
  const data = new Uint8Array([9, 8, 7]);
  const entries = [
    { name: "x/1.md", data: "本文" },
    { name: "x/2.bin", data },
  ];
  const snapshot = structuredClone(entries);
  const a = buildZip(entries, { mtime: MTIME });
  const b = buildZip(entries, { mtime: MTIME });
  assert.deepEqual(a, b);
  assert.deepEqual(entries, snapshot);
  assert.equal(entries.length, 2);
});
