'use strict';
/**
 * 主进程的小工具：读写 JSON（先写临时文件再改名、同一个文件排队）、改名重试、哈希、进回收站、
 * 文件占用探测、裁日志、有上限的缓存。这是最底层，不依赖别的模块。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { nm } = require('../../shared/i18n');

const isWin = process.platform === 'win32';

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readJson(p, fallback = null) {
  try {
    const text = await fsp.readFile(p, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readJsonSync(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

// Windows 上改名的目标被短暂占着（杀毒软件、索引、另一次改名）时会报这几种，等一下再试
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
async function renameRetry(from, to, tries = 8) {
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return; } catch (e) {
      if (!RETRY_CODES.has(e.code) || i >= tries - 1) throw e;
      await sleep(30 * 2 ** Math.min(i, 5));
    }
  }
}

// 同一个文件的写入排队：按调用顺序落盘，最后一次调用的内容生效（1.10.7：以前并发写会撞上同名临时文件）。
// writeJson 和 fileops.writeFileSafe 共用这一个队列：同一个文件不管用哪个写，都排在一起
const writeQueues = new Map();
let tmpSeq = 0;
const inFlight = new Set();
function queued(map, key, fn) {
  const next = (map.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  map.set(key, next);
  inFlight.add(next);
  next.catch(() => {}).finally(() => { inFlight.delete(next); if (map.get(key) === next) map.delete(key); });
  return next;
}
/** 等现在排着队的写入都结束（退出前用） */
async function queuedDone() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}
const fileKey = (p) => path.resolve(p).toLowerCase();

/**
 * 崩溃分析之前先裁日志（2.0.0-pre8，全面测试：坏输入）。分析用很多正则，而日志是 Mod 写的：
 * 实测一行 2 MB 的日志能让正则回溯到主进程卡死，整个启动器没有响应。有用的信息都不会在这么长的一行里。
 * 每行最多 line 个字符，总共留最后 total 个字符（报错都在日志末尾）
 */
function clipLog(text, { line = 4000, total = 4 * 1024 * 1024 } = {}) {
  let s = String(text == null ? '' : text);
  if (s.length > total) s = s.slice(-total);
  return s.split('\n').map((l) => (l.length > line ? l.slice(0, line) : l)).join('\n');
}

/** 长期开着的缓存要有上限（2.0.0-pre8）：超过就丢掉最早放进去的一批（Map 按放入的顺序） */
function capMap(map, max) {
  if (map.size <= max) return;
  let drop = map.size - max + Math.floor(max / 5);
  for (const k of map.keys()) {
    if (drop-- <= 0) break;
    map.delete(k);
  }
}

/**
 * 写完刷到磁盘再关文件（2.0.0-pre8）。只「先写临时文件再改名」防得住进程崩溃，防不住断电：
 * 改名先落盘、内容还在系统缓存里时断电，重启后就是一个长度对、内容全是 0 的文件
 */
function writeSynced(file, data, options) {
  const opts = typeof options === 'string' ? { encoding: options } : (options || {});
  return fsp.writeFile(file, data, { ...opts, flush: true });
}

/** 原子写入：先写临时文件再重命名，避免写到一半崩溃导致文件损坏 */
function writeJson(p, data, pretty = true) {
  const text = JSON.stringify(data, null, pretty ? 2 : 0); // 调用时就定下内容，之后调用方再改对象也不影响
  return queued(writeQueues, fileKey(p), async () => {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;
    await writeSynced(tmp, text, 'utf8');
    try { await renameRetry(tmp, p); } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
  });
}

function hashFile(p, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 解析 Maven 坐标 group:artifact:version[:classifier][@ext] */
function parseMaven(name) {
  let ext = 'jar';
  let n = name;
  const at = n.indexOf('@');
  if (at >= 0) { ext = n.slice(at + 1); n = n.slice(0, at); }
  const [group, artifact, version, classifier] = n.split(':');
  return { group, artifact, version, classifier: classifier || '', ext };
}

function mavenPath(name) {
  const { group, artifact, version, classifier, ext } = parseMaven(name);
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

/** 统一的架构名：x64 / x86 / arm64 */
function normArch(a) {
  const s = String(a || '').toLowerCase();
  if (['amd64', 'x86_64', 'x64'].includes(s)) return 'x64';
  if (['aarch64', 'arm64'].includes(s)) return 'arm64';
  if (['x86', 'i386', 'i486', 'i586', 'i686', 'ia32'].includes(s)) return 'x86';
  return s || 'x64';
}

function systemArch() {
  return normArch(process.arch);
}

/** 类 shell 的参数分割，支持单双引号 */
function splitArgs(str) {
  const out = [];
  if (!str) return out;
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += c;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortError(reason) {
  const e = new Error(typeof reason === 'string' ? reason : '已取消');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** 并发执行，限制同时进行的数量 */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * 移到回收站。回收站不可用（U 盘、部分网络盘）时抛出 TRASH_UNAVAILABLE，
 * 由界面二次确认后再决定是否永久删除——这里绝不悄悄改成永久删除
 */
async function safeTrash(p) {
  const { shell } = require('electron');
  if (!(await exists(p))) return; // 已经不在了，不要误报「回收站不可用」
  // 先看有没有文件被占着：占用时回收站也会失败，以前一律说成「回收站不可用」，把玩家引向永久删除（1.10.7）
  if (await inUse(p)) throw inUseError(p);
  // 开发测试用：不碰真的回收站，挪到 AURORA_TEST_TRASH 文件夹；路径包含 AURORA_TEST_TRASH_FAIL 时模拟回收站不可用（打包后不生效）
  const { app } = require('electron');
  if (process.env.AURORA_TEST_TRASH && !app.isPackaged) {
    if (process.env.AURORA_TEST_TRASH_FAIL && p.includes(process.env.AURORA_TEST_TRASH_FAIL)) {
      const err = new Error('无法移到回收站：测试模拟');
      err.reason = { code: 'TRASH_UNAVAILABLE', message: '回收站不可用' };
      err.path = p;
      throw err;
    }
    await fsp.mkdir(process.env.AURORA_TEST_TRASH, { recursive: true });
    await renameRetry(p, path.join(process.env.AURORA_TEST_TRASH, `${Date.now()}-${path.basename(p)}`));
    return;
  }
  try {
    // 杀毒软件短暂占着时第一次会失败，等一下再试一次
    await shell.trashItem(p).catch(async () => { await sleep(500); await shell.trashItem(p); });
  } catch (e) {
    if (await inUse(p)) throw inUseError(p);
    const err = new Error(`无法移到回收站：${e.message}`);
    err.reason = { code: 'TRASH_UNAVAILABLE', message: '回收站不可用', hint: '这个位置可能在 U 盘或网络盘上，没有回收站' };
    err.path = p;
    throw err;
  }
}

/**
 * 文件或文件夹是不是正被别的程序占着：改个名再改回来试试。Windows 上里面有文件开着的文件夹改不了名，
 * 回收站和删除也会失败（实测：回收站报 Operation was aborted，永久删除会删掉没被占着的那些，留下半截）
 */
async function inUse(p) {
  const probe = `${p}.aurora-probe-${process.pid}`;
  // 刚复制或改名之后，杀毒软件和系统索引会短暂占着，不算真的被占用（2.0.0-pre8 之后，全面测试实测）：多试几次
  for (const wait of [150, 400, 800, 0]) {
    try {
      await fsp.rename(p, probe);
      await renameRetry(probe, p);
      return false;
    } catch (e) {
      if (!RETRY_CODES.has(e.code)) return false;
      if (wait) await sleep(wait);
    }
  }
  return true;
}

function inUseError(p) {
  const err = new Error(`「${nm(path.basename(p))}」里有文件正被别的程序占着（可能是游戏、资源管理器或杀毒软件），没有删除`);
  err.reason = { code: 'IN_USE', message: '文件被占用', hint: '关掉占用它的程序后再删除' };
  err.path = p;
  return err;
}

async function copyIfMissing(src, dest) {
  if (await exists(dest)) return;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

function totalMemMB() { return Math.floor(os.totalmem() / 1048576); }
function freeMemMB() { return Math.floor(os.freemem() / 1048576); }

module.exports = { writeSynced, capMap, clipLog,
  isWin, exists, readJson, readJsonSync, writeJson, renameRetry, queued, queuedDone, fileKey, writeQueues, hashFile, parseMaven, mavenPath,
  osName, normArch, systemArch, splitArgs, sleep, abortError, throwIfAborted, pool, rmrf, safeTrash, inUse, inUseError,
  copyIfMissing, totalMemMB, freeMemMB,
};
