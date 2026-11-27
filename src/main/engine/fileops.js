'use strict';
/**
 * 文件和目录的公共操作（2.0.0-pre2，重构方案「文件和路径引擎」）。以前每个功能各写一份，规则不一样：
 * 有的复制会带上 session.lock，有的会把联接原样带过去（写副本等于写原件），有的路径检查漏了反斜杠。
 * - safeJoin / under / fileNameOnly：路径在不在允许的范围里
 * - writeFileSafe：写玩家的文件，写一半崩溃不会留下半个（12-5）
 * - copyDir：复制目录，统一跳过 session.lock 和联接
 * - stash / stashesOf / unstash / replaceDir：把目录挪开、放回
 * 这是底层，不知道任何功能。
 */
const fsp = require('fs').promises;
const path = require('path');
const { constants } = require('fs');
const { exists, renameRetry, rmrf, queued, fileKey, throwIfAborted, writeSynced, writeQueues } = require('./util');
const { safeName, isDeviceName } = require('../../shared/pathrules');

// ───────────────────────── 路径 ─────────────────────────
/** p 在 base 里面（或者就是 base）。比 startsWith 准：backups2 不算在 backups 里面 */
function under(p, base) {
  const rel = path.relative(base, p);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

function unsafe(what, rel) {
  const e = new Error(`${what}里有不安全的路径：${rel}`);
  e.reason = { code: 'UNSAFE_PATH', message: '路径不安全', hint: '这个文件可能被改过，不要导入来路不明的文件' };
  return e;
}

/**
 * 把别人给的相对路径（导入包、整合包、网络接口）接到 root 下面。跑到 root 外面就抛错。
 * 正斜杠和反斜杠都算分隔符；Windows 会悄悄去掉结尾的点和空格，「.. 」其实就是 ..，也拦下来；
 * 冒号（盘符、NTFS 备用数据流）和设备名（CON、NUL）不能出现在任何一层。
 */
function safeJoin(root, rel, what = '文件') {
  const text = String(rel == null ? '' : rel);
  if (!text || text.includes('\0') || path.isAbsolute(text)) throw unsafe(what, rel);
  for (const seg of text.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    // 超长的一段：Windows 上递归建文件夹碰到它不报错也不返回（2.0.0-pre8，全面测试实测），一层文件夹名本来也放不下这么长
    if (seg.length > 255 || !seg.replace(/[. ]+$/, '') || seg.includes(':') || isDeviceName(seg)) throw unsafe(what, String(rel).slice(0, 80));
  }
  const dest = path.resolve(root, text);
  if (dest === path.resolve(root) || !under(dest, root)) throw unsafe(what, rel);
  return dest;
}

/**
 * 只能是一层文件夹名的东西（配置 id）：不能带分隔符、盘符，不能是 ..（2.0.0-pre8，全面测试：
 * 以前 versionDir 直接拼路径，接口传 ..\\..\\x 能删到版本目录外面，传空字符串就是整个版本目录）
 */
function oneSegment(name, what = '名字') {
  const text = typeof name === 'string' ? name : '';
  if (!text || text.length > 255 || text.includes('\0') || /[\\/:]/.test(text) || !text.replace(/[. ]+$/, '')) throw unsafe(what, String(name).slice(0, 80));
  return text;
}

/** 网络接口给的文件名：只留最后一段，非法字符换掉。不可能是路径 */
function fileNameOnly(name, fallback = '未命名文件') {
  const last = String(name == null ? '' : name).split(/[\\/]+/).filter(Boolean).pop();
  return safeName(last, { max: 200, fallback });
}

// ───────────────────────── 写文件 ─────────────────────────
let tmpSeq = 0;

/** 先写临时文件再改名替换：写到一半崩溃或断电，原来的文件还在。同一个文件的写入排队 */
function writeFileSafe(p, data, options) {
  return queued(writeQueues, fileKey(p), async () => {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.aurora-tmp-${process.pid}-${++tmpSeq}`;
    try {
      await writeSynced(tmp, data, options);
      await renameRetry(tmp, p);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  });
}

// ───────────────────────── 复制目录 ─────────────────────────
const isLockFile = (name) => /^session\.lock$/i.test(name);

/**
 * 把 src 的内容复制进 dst，返回复制的文件数。一律跳过：
 * - session.lock：游戏占着的话根本读不了，带过去也没有意义
 * - 联接和符号链接：复制过去还指向原来的地方，写副本等于写原件。要连着内容复制时，调用方先解析真实路径
 * opts:
 *   filter(rel, entry)  返回 false 跳过（rel 用系统分隔符，可以是 async）
 *   signal              每处理一个文件看一眼取消
 *   onFile(name)        每复制一个文件调用一次
 *   force               目标已有同名文件时覆盖（默认覆盖；false 就留着目标的）
 *   lenient             文件夹读不了时跳过而不是报错（默认报错：复制完可能要删原件，漏了就是丢数据）
 */
async function copyDir(src, dst, opts = {}) {
  const { filter, signal, onFile, force = true, lenient = false } = opts;
  let count = 0;
  const walk = async (from, to, prefix) => {
    throwIfAborted(signal);
    let list;
    try { list = await fsp.readdir(from, { withFileTypes: true }); } catch (e) { if (lenient) return; throw e; }
    await fsp.mkdir(to, { recursive: true });
    for (const e of list) {
      throwIfAborted(signal);
      if (e.isSymbolicLink() || isLockFile(e.name)) continue;
      const rel = prefix ? path.join(prefix, e.name) : e.name;
      if (filter && !(await filter(rel, e))) continue;
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) await walk(s, d, rel);
      else if (e.isFile()) {
        try {
          await fsp.copyFile(s, d, force ? 0 : constants.COPYFILE_EXCL);
          count++;
          if (onFile) onFile(e.name);
        } catch (err) { if (force || err.code !== 'EEXIST') throw err; }
      }
    }
  };
  await walk(src, dst, '');
  return count;
}

/** 复制一个文件夹，失败或取消就把没复制完的删掉，不留半份。dst 必须是新的 */
async function copyDirNew(src, dst, opts) {
  try { return await copyDir(src, dst, opts); } catch (e) {
    await rmrf(dst).catch(() => {});
    throw e;
  }
}

// ───────────────────────── 暂存和放回 ─────────────────────────
/** 把目录挪到一边：<名字>.aurora-own，已有就加时间 */
async function stash(p) {
  let dest = `${p}.aurora-own`;
  if (await exists(dest)) dest = `${p}.aurora-own-${Date.now()}`;
  await renameRetry(p, dest);
  return dest;
}

/** p 的所有暂存，新的在前：.aurora-own 是最早的那份，重名时才有 .aurora-own-<时间> */
async function stashesOf(p) {
  const base = `${path.basename(p)}.aurora-own`;
  const names = (await fsp.readdir(path.dirname(p)).catch(() => [])).filter((n) => n === base || (n.startsWith(`${base}-`) && /^\d+$/.test(n.slice(base.length + 1))));
  const ts = (n) => Number(n.slice(base.length + 1)) || 0;
  return names.sort((a, b) => ts(b) - ts(a)).map((n) => path.join(path.dirname(p), n));
}

/**
 * 放回来：最新的暂存放回原处，更早的并进来（1.10.7：以前只认 .aurora-own，新的那份世界找不回来）。
 * renameDup 为真时同名的改名保留（世界）；否则同名的不覆盖，留在暂存里
 */
async function unstash(p, { renameDup = false } = {}) {
  if (await exists(p)) return;
  const [newest, ...older] = await stashesOf(p);
  if (!newest) return;
  await renameRetry(newest, p);
  for (const s of older) {
    for (const n of await fsp.readdir(s).catch(() => [])) {
      let to = path.join(p, n);
      if (await exists(to)) {
        if (!renameDup) continue;
        to = path.join(p, `${n} (暂存)`);
        for (let i = 2; await exists(to); i++) to = path.join(p, `${n} (暂存 ${i})`);
      }
      await renameRetry(path.join(s, n), to);
    }
    if (!(await fsp.readdir(s).catch(() => [])).length) await fsp.rmdir(s).catch(() => {});
  }
}

/**
 * 换掉一个目录：新内容先做在旁边，全好了才换（2.0.0-pre8，全面测试：崩溃恢复。以前先把旧的挪开再解压，
 * 崩在中间时世界就只剩半个，完整的那份藏在 *.aurora-restore-* 里，玩家找不到）。
 * 崩溃时留下的 *.aurora-new-*、*.aurora-old-* 由 recover.js 收拾。返回原来有没有这个目录
 */
async function replaceDir(target, fill) {
  const had = await exists(target);
  const stamp = Date.now();
  const fresh = `${target}.aurora-new-${stamp}`;
  const old = `${target}.aurora-old-${stamp}`;
  try {
    await fsp.mkdir(fresh, { recursive: true });
    await fill(fresh);
    if (had) await renameRetry(target, old);
    try {
      await renameRetry(fresh, target);
    } catch (e) {
      if (had) await renameRetry(old, target).catch(() => {});
      throw e;
    }
  } catch (e) {
    await rmrf(fresh).catch(() => {});
    throw e;
  }
  if (had) await rmrf(old).catch(() => {});
  return had;
}

module.exports = { under, safeJoin, oneSegment, fileNameOnly, writeFileSafe, copyDir, copyDirNew, stash, stashesOf, unstash, replaceDir, isLockFile };
