'use strict';
/**
 * 轻量 ZIP 读写：
 * - ZipReader：只读中央目录、按需解压单个条目；支持文件与内存缓冲区（用于读取嵌套 jar）
 * - ZipWriter：顺序写入 ZIP（导出整合包、存档备份），支持 ZIP64
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { nm } = require('../../shared/i18n');
const { safeJoin } = require('./fileops');

// 压缩包是别人给的，头里写的大小不能信（2.0.0-pre8，全面测试：坏输入）：
// 以前按它申请内存、解压也不设上限，几 MB 的压缩炸弹就能把启动器撑崩
const MAX_IN_MEMORY = 1024 * 1024 * 1024; // 读进内存的条目最多这么大；真的大文件走 extractTo 的流式
const BIG_ENTRY = 64 * 1024 * 1024; // 比这大就不整个读进内存
const SIZE_SLACK = 1024 * 1024; // 个别打包工具写的大小有一点出入，放宽一点

const inflateRaw = promisify(zlib.inflateRaw);
const deflateRaw = promisify(zlib.deflateRaw);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 没有 UTF-8 标记的文件名（1.10.8：以前一律按 latin1，中文全成乱码）。
 * 很多工具写 UTF-8 但不打标记，所以先按严格的 UTF-8 解；不是的话在中文系统上多半是 GBK（Windows 自带压缩、老压缩工具）
 */
const strictDecoders = [new TextDecoder('utf-8', { fatal: true }), new TextDecoder('gbk', { fatal: true })];
function decodeName(buf) {
  if (buf.every((b) => b < 0x80)) return buf.toString('latin1'); // 绝大多数是纯英文，不用解
  for (const d of strictDecoders) { try { return d.decode(buf); } catch { /* 下一种 */ } }
  return buf.toString('latin1');
}

const sizeWrong = (entry) => Object.assign(new Error(`压缩包里的 ${nm(entry.name)} 大小不对，可能已损坏`), { corrupt: true });

class ZipReader {
  static async open(file) {
    const z = new ZipReader();
    z.file = file;
    z.fh = await fsp.open(file, 'r');
    z.size = (await z.fh.stat()).size;
    try {
      await z._readDirectory();
    } catch (e) {
      await z.close();
      throw new Error(`无法读取压缩包 ${nm(path.basename(file))}：${e.message}`);
    }
    return z;
  }

  static async fromBuffer(buf, name = 'buffer') {
    const z = new ZipReader();
    z.file = name;
    z.buf = buf;
    z.size = buf.length;
    await z._readDirectory();
    return z;
  }

  /**
   * 远程 jar：readRange(pos, len) 用 HTTP Range 取一段，只下载目录和要读的条目（Mod 配置器下载前读 jar 的声明，1.5.8）。
   * 取过的片段留在内存里，后面落在里面的读取不再请求
   */
  static async fromRemote(readRange, size, name = 'remote') {
    const z = new ZipReader();
    z.file = name;
    z.remote = readRange;
    z.chunks = [];
    z.size = size;
    await z._readDirectory();
    return z;
  }
  async _read(pos, len) {
    // 不管头里写了多大，文件里最多就这么多，不多申请内存
    len = Math.max(0, Math.min(len, this.size - pos));
    if (this.buf) return this.buf.subarray(pos, Math.min(this.buf.length, pos + len));
    if (this.remote) {
      const hit = this.chunks.find((c) => pos >= c.pos && pos + len <= c.pos + c.buf.length);
      if (hit) return hit.buf.subarray(pos - hit.pos, pos - hit.pos + len);
      const buf = await this.remote(pos, len);
      this.chunks.push({ pos, buf });
      return buf;
    }
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await this.fh.read(buf, off, len - off, pos + off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return off === len ? buf : buf.subarray(0, off);
  }

  async _readDirectory() {
    const size = this.size;
    const tailLen = Math.min(size, 65557);
    const tail = await this._read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
      const locPos = eocd - 20;
      if (locPos >= 0 && tail.readUInt32LE(locPos) === 0x07064b50) {
        const z64Off = Number(tail.readBigUInt64LE(locPos + 8));
        const z64 = await this._read(z64Off, 56);
        if (z64.readUInt32LE(0) === 0x06064b50) {
          count = Number(z64.readBigUInt64LE(32));
          cdSize = Number(z64.readBigUInt64LE(40));
          cdOffset = Number(z64.readBigUInt64LE(48));
        }
      }
    }

    const cd = await this._read(cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const extAttr = cd.readUInt32LE(p + 38);
      let offset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800) ? nameBuf.toString('utf8') : decodeName(nameBuf);
      if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
            break;
          }
          e += 4 + len;
        }
      }
      entries.push({ name, method, compSize, size, offset, crc, isDirectory: name.endsWith('/'), mode: (extAttr >>> 16) & 0xffff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    this.entries = entries;
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  getEntry(name) { return this.byName.get(name) || null; }

  async read(entryOrName) {
    const entry = typeof entryOrName === 'string' ? this.getEntry(entryOrName) : entryOrName;
    if (!entry) return null;
    if (entry.size > MAX_IN_MEMORY) throw sizeWrong(entry);
    // 远程时条目头和数据一次取回（本地文件头的扩展字段一般不长，多取 1 KB）
    if (this.remote) await this._read(entry.offset, 30 + Buffer.byteLength(entry.name) + 1024 + entry.compSize);
    const head = await this._read(entry.offset, 30);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`条目头损坏：${nm(entry.name)}`);
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = await this._read(start, entry.compSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) {
      return inflateRaw(raw, { maxOutputLength: entry.size + SIZE_SLACK }).catch((e) => {
        throw e.code === 'ERR_BUFFER_TOO_LARGE' ? sizeWrong(entry) : e;
      });
    }
    throw new Error(`不支持的压缩方式 ${entry.method}：${nm(entry.name)}`);
  }

  async readText(name) {
    const b = await this.read(name);
    return b ? b.toString('utf8').replace(/^\uFEFF/, '') : null;
  }

  /** 解压一个条目到文件；大的条目边读边写，不整个读进内存。verify：核对 CRC，对不上就报错（文件损坏，err.corrupt） */
  async extractTo(entry, dest, { verify = false } = {}) {
    const bad = () => Object.assign(new Error(`文件已损坏（校验和不对）：${nm(entry.name)}`), { corrupt: true });
    if (entry.size < BIG_ENTRY || this.buf || this.remote || (entry.method !== 0 && entry.method !== 8)) {
      const data = await this.read(entry);
      if (verify && (data.length !== entry.size || crc32(data) !== entry.crc)) throw bad();
      await fsp.writeFile(dest, data);
      return;
    }
    const head = await this._read(entry.offset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) throw new Error(`条目头损坏：${nm(entry.name)}`);
    const self = this;
    async function* compressed() {
      let pos = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      let left = entry.compSize;
      while (left > 0) {
        const chunk = await self._read(pos, Math.min(left, 4 * 1024 * 1024));
        if (!chunk.length) throw new Error(`压缩包不完整：${nm(entry.name)}`);
        pos += chunk.length;
        left -= chunk.length;
        yield chunk;
      }
    }
    const out = await fsp.open(dest, 'w');
    let c = 0;
    let written = 0;
    const save = async (chunk) => {
      written += chunk.length;
      if (written > entry.size + SIZE_SLACK) throw sizeWrong(entry); // 解开比声明的大：炸弹，不写满磁盘
      if (verify) c = crc32Continue(c, chunk);
      await out.write(chunk);
    };
    try {
      if (entry.method === 0) {
        for await (const chunk of compressed()) await save(chunk);
      } else {
        await pipeline(Readable.from(compressed(), { objectMode: false }), zlib.createInflateRaw(), async (source) => {
          for await (const chunk of source) await save(chunk);
        });
      }
    } catch (e) {
      await out.close().catch(() => {});
      await fsp.rm(dest, { force: true }).catch(() => {});
      throw e;
    }
    await out.close();
    if (verify && ((c >>> 0) !== entry.crc || written !== entry.size)) { await fsp.rm(dest, { force: true }); throw bad(); }
  }

  /** 解压全部条目到目录；filter(entry) 返回 false 跳过，map(entry) 可返回自定义目标相对路径；signal 取消时抛错 */
  async extractAll(destDir, { filter, map, onEntry, signal } = {}) {
    const root = path.resolve(destDir);
    await this._assertRoom(root, filter);
    for (const entry of this.entries) {
      if (signal && signal.aborted) throw cancelled();
      if (filter && !filter(entry)) continue;
      const rel = map ? map(entry) : entry.name;
      if (!rel) continue;
      // 防止 Zip Slip 路径穿越：规则和导入包一样（反斜杠、结尾带点和空格的 ..、盘符、设备名），不安全的条目跳过
      let dest;
      try { dest = safeJoin(root, rel, '压缩包'); } catch { continue; }
      if (entry.isDirectory) {
        await fsp.mkdir(dest, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await this.extractTo(entry, dest);
      if (process.platform !== 'win32' && entry.mode & 0o111) await fsp.chmod(dest, 0o755).catch(() => {});
      if (onEntry) onEntry(entry);
    }
  }

  /** 解压前看一眼磁盘放不放得下，免得写到一半才发现，或者被一个声明几百 GB 的压缩包写满 */
  async _assertRoom(root, filter) {
    const want = this.entries.reduce((sum, e) => sum + (!filter || filter(e) ? e.size : 0), 0);
    let at = root;
    while (path.dirname(at) !== at && !fs.existsSync(at)) at = path.dirname(at);
    const st = await fsp.statfs(at).catch(() => null);
    if (st && want > st.bavail * st.bsize) throw Object.assign(new Error('磁盘空间不足：放不下这个压缩包解压后的内容'), { code: 'ENOSPC' });
  }

  async close() {
    if (this.fh) { await this.fh.close().catch(() => {}); this.fh = null; }
  }
}

async function withZip(file, fn) {
  const z = await ZipReader.open(file);
  try { return await fn(z); } finally { await z.close(); }
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX32 = 0xffffffff;
// 本身已经压缩过的文件直接存储，省时间（存档的区块文件 .mca 就是压缩过的）
const STORE_EXT = /\.(mca|mcc|png|jpe?g|zip|jar|gz|ogg|mp3|7z|rar)$/i;
// 大文件分块读写，不整个读进内存
const STREAM_MIN = 64 * 1024 * 1024;
const cancelled = () => Object.assign(new Error('已取消'), { cancelled: true });

/**
 * 顺序写入 ZIP。总大小或单个文件超过 4GB、或超过 65535 个条目时自动用 ZIP64（存档可能很大）
 */
class ZipWriter {
  static async create(file) {
    const w = new ZipWriter();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    w.fh = await fsp.open(file, 'w');
    w.offset = 0;
    w.entries = [];
    w.names = new Set();
    return w;
  }

  async _write(buf, pos = this.offset) {
    await this.fh.write(buf, 0, buf.length, pos);
    if (pos === this.offset) this.offset += buf.length;
  }

  /** 本地文件头；单个文件 ≥4GB 时带 ZIP64 扩展字段 */
  _localHeader(nameBuf, method, time, date, crc, compSize, size) {
    const big = size >= MAX32 || compSize >= MAX32;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(big ? 45 : 20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(big ? MAX32 : compSize, 18);
    h.writeUInt32LE(big ? MAX32 : size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    let extra = Buffer.alloc(0);
    if (big) {
      extra = Buffer.alloc(20);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(compSize), 12);
    }
    h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, nameBuf, extra]);
  }

  _claim(name) {
    name = name.replace(/\\/g, '/');
    if (this.names.has(name)) return null;
    this.names.add(name);
    return name;
  }

  async addBuffer(name, data, { compress = true, mtime = new Date() } = {}) {
    name = this._claim(name);
    if (!name) return;
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (compress && data.length > 64) {
      const d = await deflateRaw(data, { level: 6 });
      if (d.length < data.length) { body = d; method = 8; }
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(mtime);
    const offset = this.offset;
    await this._write(this._localHeader(nameBuf, method, time, date, crc, body.length, data.length));
    await this._write(body);
    this.entries.push({ nameBuf, method, time, date, crc, compSize: body.length, size: data.length, offset });
  }

  /** 大文件：分块读、直接存储，CRC 算完再回填到文件头 */
  async _addLarge(name, file, st, signal) {
    name = this._claim(name);
    if (!name) return;
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(st.mtime);
    const size = st.size;
    const offset = this.offset;
    await this._write(this._localHeader(nameBuf, 0, time, date, 0, size, size));
    const src = await fsp.open(file, 'r');
    let crc = 0;
    let done = 0;
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024);
      while (done < size) {
        if (signal && signal.aborted) throw cancelled();
        const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, size - done), done);
        if (!bytesRead) break;
        const chunk = buf.subarray(0, bytesRead);
        crc = crc32Continue(crc, chunk);
        await this._write(chunk);
        done += bytesRead;
      }
    } finally { await src.close(); }
    if (done !== size) throw new Error(`读取 ${nm(name)} 时文件变短了（可能正在被写入）`);
    const c = Buffer.alloc(4);
    c.writeUInt32LE(crc >>> 0, 0);
    await this._write(c, offset + 14);
    this.entries.push({ nameBuf, method: 0, time, date, crc: crc >>> 0, compSize: size, size, offset });
  }

  async addFile(name, file, { signal } = {}) {
    const st = await fsp.stat(file);
    if (st.size >= STREAM_MIN) return this._addLarge(name, file, st, signal);
    await this.addBuffer(name, await fsp.readFile(file), { mtime: st.mtime, compress: !STORE_EXT.test(name) });
  }

  /** 递归添加目录；onFile(name, fullPath) 用来报进度 */
  async addDir(prefix, dir, filter, { onFile, signal } = {}) {
    let list = [];
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    let n = 0;
    for (const d of list) {
      if (signal && signal.aborted) throw cancelled();
      const full = path.join(dir, d.name);
      const name = `${prefix}/${d.name}`;
      if (filter && !filter(name, d)) continue;
      if (d.isDirectory()) n += await this.addDir(name, full, filter, { onFile, signal });
      else if (d.isFile()) {
        await this.addFile(name, full, { signal });
        n++;
        if (onFile) onFile(name, full);
      }
    }
    return n;
  }

  async close() {
    const start = this.offset;
    for (const e of this.entries) {
      const need = [];
      if (e.size >= MAX32) need.push(e.size);
      if (e.compSize >= MAX32) need.push(e.compSize);
      if (e.offset >= MAX32) need.push(e.offset);
      let extra = Buffer.alloc(0);
      if (need.length) {
        extra = Buffer.alloc(4 + need.length * 8);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(need.length * 8, 2);
        need.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(need.length ? 45 : 20, 4);
      c.writeUInt16LE(need.length ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(Math.min(e.compSize, MAX32), 20);
      c.writeUInt32LE(Math.min(e.size, MAX32), 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE(Math.min(e.offset, MAX32), 42);
      await this._write(Buffer.concat([c, e.nameBuf, extra]));
    }
    const cdSize = this.offset - start;
    const count = this.entries.length;
    const z64 = count >= 0xffff || start >= MAX32 || cdSize >= MAX32;
    if (z64) {
      const recPos = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(count), 24);
      r.writeBigUInt64LE(BigInt(count), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(start), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(recPos), 8);
      loc.writeUInt32LE(1, 16);
      await this._write(Buffer.concat([r, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(z64 ? 0xffff : count, 8);
    end.writeUInt16LE(z64 ? 0xffff : count, 10);
    end.writeUInt32LE(z64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(z64 ? MAX32 : start, 16);
    await this._write(end);
    await this.fh.close();
    this.fh = null;
  }

  /** 出错时关掉文件（写了一半的文件由调用方删除） */
  async abort() {
    if (this.fh) { await this.fh.close().catch(() => {}); this.fh = null; }
  }
}

function crc32Continue(prev, buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev) >>> 0;
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { ZipReader, ZipWriter, withZip, crc32 };
