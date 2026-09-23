// 無圧縮(store 方式)の ZIP をブラウザ内で組み立てる純関数(#65)。DOM に依存しない。
//
// **会議本文をブラウザの外に出さないため、ZIP はクライアントで作る。** サーバーで組むと
// 「この端末にのみ保存」の方針に反する。フロントはビルドレス・外部ライブラリなしなので、
// ライブラリを入れず store 方式だけを自前で書く(対象は Markdown 数十 KB〜数 MB で、
// 圧縮しなくても実害がない)。ZIP64・暗号化・フォルダ用の独立エントリは扱わない。

/** @type {Uint32Array | null} */
let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/**
 * 標準 CRC-32(IEEE 802.3、ZIP / gzip と同じ多項式)。
 * @param {Uint8Array} bytes
 * @returns {number} 符号なし 32bit
 */
export function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// OS がファイル名に使えない文字(Windows 基準)。`/` は ZIP 内のフォルダ区切りにもなる
// C0/C1 制御文字と、拡張子の見た目を偽装できる双方向制御文字(U+202A-202E, U+2066-2069)も除く
const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const MAX_NAME_CODEPOINTS = 80;
// ext4 などのファイル名上限は 255 バイト。`.zip` と余裕を見て名前部分は 200 バイトまでにする
const MAX_NAME_BYTES = 200;
// Windows が予約しているデバイス名(拡張子付きでも不可)。ZIP 名にも ZIP 内のフォルダ名にもなる
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const encoder = new TextEncoder();

/**
 * 利用者が入力した保存名を、ファイル名・ZIP 内のフォルダ名として安全な形にする。
 *
 * 1. 前後の空白を落とし、制御文字と `\ / : * ? " < > |` を除く
 * 2. 先頭の `.`(隠しファイル化)と、末尾の `.` / 空白(Windows が黙って落とす)を除く
 * 3. 80 文字(コードポイント)かつ UTF-8 で 200 バイトまでに切る。サロゲートペアの絵文字を途中で割らない
 * 4. 空、`.` / `..`、または Windows の予約名(`CON` / `NUL` / `COM1` など)になったら `fallback`
 *
 * @param {string} raw
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeExportName(raw, fallback) {
  let name = String(raw ?? "").replace(FORBIDDEN_CHARS, "");
  // 先頭は `.` と空白が交互に来ても(`" .. a"`)まとめて落とす。`.` / `..` もここで空になる
  name = name.replace(/^[.\s]+/, "");
  // コードポイント単位で数えて切るので、サロゲートペアの絵文字を割らない
  let codepoints = 0;
  let bytes = 0;
  let end = 0;
  for (const ch of name) {
    bytes += encoder.encode(ch).length;
    if (codepoints === MAX_NAME_CODEPOINTS || bytes > MAX_NAME_BYTES) break;
    codepoints++;
    end += ch.length;
  }
  // 末尾の `.` / 空白は切ったあとに 1 回だけ落とす(切る前に落としても切った位置に現れうる)
  name = name.slice(0, end).replace(/[.\s]+$/, "");
  if (name === "" || WINDOWS_RESERVED.test(name)) return fallback;
  return name;
}

/**
 * Date を DOS 形式の日時(ローカル時刻)に変換する。2 秒刻み、1980 年未満は 1980-01-01 00:00:00。
 * @param {Date} d
 * @returns {{ time: number, date: number }}
 */
export function toDosDateTime(d) {
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}


/**
 * @typedef {{ name: string, data: string | Uint8Array }} ZipEntry
 */

/**
 * store 方式の ZIP を組む。ファイル名は UTF-8(general purpose flag の bit 11)で格納し、
 * `/` 区切りでフォルダを表す。
 *
 * @param {ZipEntry[]} entries
 * @param {{ mtime?: Date }} [opts]
 * @returns {Uint8Array}
 */
export function buildZip(entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("entries is empty");
  const { time, date } = toDosDateTime(opts.mtime ?? new Date());

  const files = entries.map((e) => {
    const name = encoder.encode(e.name);
    const data = typeof e.data === "string" ? encoder.encode(e.data) : e.data;
    return { name, data, crc: crc32(data) };
  });

  const localSize = files.reduce((s, f) => s + 30 + f.name.length + f.data.length, 0);
  const centralSize = files.reduce((s, f) => s + 46 + f.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v) => {
    view.setUint16(p, v, true);
    p += 2;
  };
  const u32 = (v) => {
    view.setUint32(p, v >>> 0, true);
    p += 4;
  };
  const bytes = (b) => {
    out.set(b, p);
    p += b.length;
  };

  const FLAG_UTF8 = 0x0800;
  /** @type {number[]} */
  const offsets = [];
  for (const f of files) {
    offsets.push(p);
    u32(0x04034b50); // local file header signature
    u16(20); // version needed to extract
    u16(FLAG_UTF8);
    u16(0); // compression method: store
    u16(time);
    u16(date);
    u32(f.crc);
    u32(f.data.length); // compressed size
    u32(f.data.length); // uncompressed size
    u16(f.name.length);
    u16(0); // extra field length
    bytes(f.name);
    bytes(f.data);
  }

  const centralStart = p;
  files.forEach((f, i) => {
    u32(0x02014b50); // central directory header signature
    u16(20); // version made by
    u16(20); // version needed to extract
    u16(FLAG_UTF8);
    u16(0);
    u16(time);
    u16(date);
    u32(f.crc);
    u32(f.data.length);
    u32(f.data.length);
    u16(f.name.length);
    u16(0); // extra field length
    u16(0); // file comment length
    u16(0); // disk number start
    u16(0); // internal file attributes
    u32(0); // external file attributes
    u32(offsets[i]);
    bytes(f.name);
  });

  u32(0x06054b50); // end of central directory signature
  u16(0); // number of this disk
  u16(0); // disk where central directory starts
  u16(files.length);
  u16(files.length);
  u32(centralSize); // size of central directory
  u32(centralStart);
  u16(0); // comment length
  return out;
}
