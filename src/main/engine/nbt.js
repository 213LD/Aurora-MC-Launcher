'use strict';
/**
 * 最小的 NBT 读写（level.dat 用）：读出世界名、游戏模式、最后游玩时间；「恢复为新世界」时改世界名再写回。
 * 解析结果保留每个标签的类型（{ type, value }），写回时原样输出，不丢精度（long 用 BigInt）
 */
const zlib = require('zlib');
const fsp = require('fs').promises;
const { writeFileSafe } = require('./fileops');

const MAX_LEVEL_BYTES = 256 * 1024 * 1024;
const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

/**
 * NBT 的字符串是 Java 的 modified UTF-8（1.10.8）：emoji 这类基本平面以外的字符写成两个 3 字节的代理项，NUL 写成 C0 80。
 * 以前按标准 UTF-8 读写，服务器名里的 emoji 同步一次就成了乱码。
 * 遇到不符合的字节（别的工具直接写的标准 UTF-8）就按标准 UTF-8 读
 */
function decodeStr(buf, start, end) {
  let out = '';
  for (let i = start; i < end;) {
    const a = buf[i];
    const cont = (k) => i + k < end && (buf[i + k] & 0xc0) === 0x80;
    if (a < 0x80) { out += String.fromCharCode(a); i += 1; }
    else if ((a & 0xe0) === 0xc0 && cont(1)) { out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i + 1] & 0x3f)); i += 2; }
    else if ((a & 0xf0) === 0xe0 && cont(1) && cont(2)) { out += String.fromCharCode(((a & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f)); i += 3; }
    else return buf.toString('utf8', start, end);
  }
  return out;
}

function encodeStr(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(bytes);
}

function parse(buf) {
  let p = 0;
  // 长度是坏文件给的：负数会让读指针往回走，运气不好就是死循环，界面跟着卡死（2.0.0-pre8，全面测试：坏输入）
  const len = () => { const n = buf.readInt32BE(p); p += 4; if (n < 0) throw new Error('NBT 里的长度不对'); return n; };
  const str = () => { const n = buf.readUInt16BE(p); p += 2; const s = decodeStr(buf, p, p + n); p += n; return s; };
  function payload(type) {
    switch (type) {
      case T.BYTE: { const v = buf.readInt8(p); p += 1; return v; }
      case T.SHORT: { const v = buf.readInt16BE(p); p += 2; return v; }
      case T.INT: { const v = buf.readInt32BE(p); p += 4; return v; }
      case T.LONG: { const v = buf.readBigInt64BE(p); p += 8; return v; }
      case T.FLOAT: { const v = buf.readFloatBE(p); p += 4; return v; }
      case T.DOUBLE: { const v = buf.readDoubleBE(p); p += 8; return v; }
      case T.BYTE_ARRAY: { const n = len(); const v = Buffer.from(buf.subarray(p, p + n)); p += n; return v; }
      case T.STRING: return str();
      case T.LIST: {
        const et = buf.readInt8(p); p += 1; const n = len();
        const items = [];
        for (let i = 0; i < n; i++) items.push(payload(et));
        return { type: et, items };
      }
      case T.COMPOUND: {
        const out = {};
        for (;;) {
          const t = buf.readInt8(p); p += 1;
          if (t === T.END) return out;
          const name = str();
          const value = payload(t);
          if (name !== '__proto__') out[name] = { type: t, value };
        }
      }
      case T.INT_ARRAY: { const n = len(); const v = []; for (let i = 0; i < n; i++) { v.push(buf.readInt32BE(p)); p += 4; } return v; }
      case T.LONG_ARRAY: { const n = len(); const v = []; for (let i = 0; i < n; i++) { v.push(buf.readBigInt64BE(p)); p += 8; } return v; }
      default: throw new Error(`未知的 NBT 类型 ${type}`);
    }
  }
  const t = buf.readInt8(p); p += 1;
  if (t !== T.COMPOUND) throw new Error('不是 NBT 文件');
  const name = str();
  return { name, value: payload(T.COMPOUND) };
}

function serialize(root) {
  const parts = [];
  const push = (b) => parts.push(b);
  const num = (fn, size, v) => { const b = Buffer.alloc(size); b[fn](v, 0); push(b); };
  const str = (s) => { const b = encodeStr(s); num('writeUInt16BE', 2, b.length); push(b); };
  function payload(type, v) {
    switch (type) {
      case T.BYTE: return num('writeInt8', 1, v);
      case T.SHORT: return num('writeInt16BE', 2, v);
      case T.INT: return num('writeInt32BE', 4, v);
      case T.LONG: return num('writeBigInt64BE', 8, v);
      case T.FLOAT: return num('writeFloatBE', 4, v);
      case T.DOUBLE: return num('writeDoubleBE', 8, v);
      case T.BYTE_ARRAY: num('writeInt32BE', 4, v.length); return push(v);
      case T.STRING: return str(v);
      case T.LIST: num('writeInt8', 1, v.type); num('writeInt32BE', 4, v.items.length); v.items.forEach((x) => payload(v.type, x)); return undefined;
      case T.COMPOUND:
        for (const [k, tag] of Object.entries(v)) { num('writeInt8', 1, tag.type); str(k); payload(tag.type, tag.value); }
        return num('writeInt8', 1, T.END);
      case T.INT_ARRAY: num('writeInt32BE', 4, v.length); v.forEach((x) => num('writeInt32BE', 4, x)); return undefined;
      case T.LONG_ARRAY: num('writeInt32BE', 4, v.length); v.forEach((x) => num('writeBigInt64BE', 8, x)); return undefined;
      default: throw new Error(`未知的 NBT 类型 ${type}`);
    }
  }
  num('writeInt8', 1, T.COMPOUND);
  str(root.name || '');
  payload(T.COMPOUND, root.value);
  return Buffer.concat(parts);
}

async function readLevel(file) {
  const raw = await fsp.readFile(file);
  // level.dat 只有几十 KB，上限防的是压缩炸弹：几 MB 的文件解开有几 GB，会把启动器撑崩
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw, { maxOutputLength: MAX_LEVEL_BYTES }) : raw;
  return parse(buf);
}

/** level.dat 里玩家关心的几项；读不出来返回 null */
async function levelInfo(file) {
  try {
    const root = await readLevel(file);
    const d = root.value.Data && root.value.Data.value;
    if (!d) return null;
    const v = (k) => (d[k] ? d[k].value : undefined);
    const ver = v('Version');
    return {
      name: v('LevelName') || null,
      gameType: v('GameType') ?? null,
      hardcore: !!v('hardcore'),
      lastPlayed: typeof v('LastPlayed') === 'bigint' ? Number(v('LastPlayed')) : null,
      version: ver && ver.Name ? ver.Name.value : null,
    };
  } catch { return null; }
}

/** 改世界显示名（level.dat，gzip 压缩写回） */
async function setLevelName(file, name) {
  const root = await readLevel(file);
  const d = root.value.Data && root.value.Data.value;
  if (!d) throw new Error('level.dat 里没有 Data');
  d.LevelName = { type: T.STRING, value: name };
  await writeFileSafe(file, zlib.gzipSync(serialize(root)));
}

module.exports = { T, parse, serialize, readLevel, levelInfo, setLevelName };
