'use strict';
/**
 * 日志中心（rc4）：每次启动游戏的完整日志存到启动器数据目录的 logs/games 里，重开启动器也还在。
 * 以前日志只在内存里（最近 10 局、每局最多 8000 行），关掉启动器就没了，入口也只有顶栏一个。
 *
 * - 文件：logs/games/<开始时间>-<编号>.log，内容就是游戏的原文（和 latest.log 一样能直接打开看）
 * - 索引：logs/games/index.json，记配置名、开始结束时间、退出代码、是不是测试启动、崩溃原因
 * - 保存时间：config.logs.keepDays（7 / 30 / 90，0 = 一直保存），默认 30 天；启动时、每局结束、改设置时清理
 * - 一局最多写 20 MB，超出的不再写（文件末尾说明一句），免得刷屏的 Mod 把硬盘写满
 * 读的时候按行猜等级（和启动器解析实时日志的规则一样），只返回最后一段，界面要更早的再分段取
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const paths = require('../engine/paths');
const config = require('../engine/config');
const store = require('../engine/jsonstore');
const { writeFileSafe } = require('../engine/fileops');
const { tagged } = require('./loglevel');

const MAX_BYTES = 20 * 1024 * 1024;
const DAY = 86400000;
const IDX = { label: '日志索引', fallback: { items: [] } };
const dir = () => path.join(paths.dataDir(), 'logs', 'games');
const indexFile = () => path.join(dir(), 'index.json');
// 索引里记的文件名只当文件名用：索引被改坏了也读不到、删不到日志文件夹外面
const fileOf = (it) => path.join(dir(), path.basename(String(it.file || `${it.id}.log`)));
const open = new Map(); // gameId → { stream, bytes, id, full }

function stamp(t) {
  const d = new Date(t);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

/** 游戏开始：建文件、记一条索引（状态 running） */
function begin(game) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const id = `${stamp(game.startedAt)}-${game.id}-${Math.random().toString(36).slice(2, 6)}`;
    const file = `${id}.log`;
    const stream = fs.createWriteStream(path.join(dir(), file), { flags: 'a', encoding: 'utf8' });
    stream.on('error', () => { open.delete(game.id); });
    open.set(game.id, { stream, bytes: 0, id, full: false });
    game.logId = id;
    store.update(indexFile(), (idx) => {
      idx.items = (idx.items || []).filter((x) => x.id !== id);
      idx.items.push({ id, file, versionId: game.versionId, startedAt: game.startedAt, state: 'running', test: !!game.test, account: game.account || '' });
      return idx;
    }, IDX).catch(() => {});
  } catch { /* 写不了日志不影响玩 */ }
}

/** 一行日志 */
function write(game, text) {
  const o = open.get(game.id);
  if (!o || o.full) return;
  const s = `${text}\n`;
  o.bytes += Buffer.byteLength(s);
  if (o.bytes > MAX_BYTES) { o.full = true; o.stream.write('[Aurora] 这一局的日志超过 20 MB，后面的不再保存\n'); return; }
  o.stream.write(s);
}

/** 游戏结束：关文件、记下结果；顺便按保存时间清理 */
async function finish(game) {
  const o = open.get(game.id);
  open.delete(game.id);
  if (o) await new Promise((r) => o.stream.end(r));
  if (!game.logId) return;
  const crash = game.crash && !game.killed ? { reasons: (game.crash.reasons || []).slice(0, 5), reportPath: game.crash.reportPath || null } : null;
  let bytes = 0;
  try { bytes = (await fsp.stat(fileOf({ id: game.logId }))).size; } catch { /* ignore */ }
  await store.update(indexFile(), (idx) => {
    const it = (idx.items || []).find((x) => x.id === game.logId);
    if (it) Object.assign(it, { state: 'exited', endedAt: game.endedAt || Date.now(), exitCode: game.exitCode, killed: !!game.killed, crash, bytes });
    return idx;
  }, IDX).catch(() => {});
  prune().catch(() => {});
}

/** 列表：新的在前。文件没了的去掉；上次没正常结束的（启动器被关掉时游戏还开着）标成「不知道怎么结束的」 */
async function list() {
  const idx = await store.read(indexFile(), IDX.fallback, IDX).catch(() => ({ items: [] }));
  const live = new Set([...open.values()].map((o) => o.id));
  const out = [];
  for (const it of idx.items || []) {
    let size = it.bytes || 0;
    try { size = (await fsp.stat(fileOf(it))).size; } catch { continue; }
    out.push({ ...it, bytes: size, state: live.has(it.id) ? 'running' : it.state === 'running' ? 'unknown' : it.state });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** 按行猜等级：带等级标记的按标记；没有标记的报错堆栈跟着上一行（Throwable 的后续行） */
function levels(lines) {
  let prev = 'INFO';
  return lines.map((text) => {
    let level = tagged(text); // 认标记的规则和实时日志共用一份（loglevel.js）
    if (level) { /* 带标记 */ } else if (/^\s+at |^Caused by:|^\s+\.\.\. \d+ more/.test(text)) level = prev === 'INFO' ? 'ERROR' : prev;
    else if (/^\[Aurora\]/.test(text)) level = /警告|无法|失败/.test(text) ? 'WARN' : 'INFO';
    else if (/Exception|Error:/.test(text)) level = 'ERROR';
    else level = 'INFO';
    prev = level;
    return { text, level };
  });
}

/** 读一局的日志：opts.tail 取最后多少行（默认 3000），opts.before 从倒数第几行往前取（「显示更早的」） */
async function read(id, { tail = 3000, before = 0 } = {}) {
  const items = await list();
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error('这份日志已经不在了');
  const text = await fsp.readFile(fileOf(it), 'utf8');
  const all = text.replace(/\r/g, '').split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const end = Math.max(0, all.length - Math.max(0, before));
  const start = Math.max(0, end - Math.max(1, Math.min(20000, tail)));
  return { lines: levels(all.slice(start, end)), total: all.length, start, item: it };
}

async function remove(id) {
  const items = await list();
  const it = items.find((x) => x.id === id);
  if (it && it.state === 'running') throw new Error('游戏还在运行，这份日志现在不能删除');
  if (it) await fsp.rm(fileOf(it), { force: true });
  await store.update(indexFile(), (idx) => { idx.items = (idx.items || []).filter((x) => x.id !== id); return idx; }, IDX);
}

/** 清除全部（正在写的除外） */
async function clear() {
  const items = await list();
  let n = 0;
  for (const it of items) {
    if (it.state === 'running') continue;
    await fsp.rm(fileOf(it), { force: true }).catch(() => {});
    n++;
  }
  const keep = new Set(items.filter((x) => x.state === 'running').map((x) => x.id));
  await store.update(indexFile(), (idx) => { idx.items = (idx.items || []).filter((x) => keep.has(x.id)); return idx; }, IDX);
  return n;
}

/** 按保存时间清理；也顺便清掉索引里没有的散落 .log 文件（启动器崩溃时可能留下） */
async function prune() {
  const days = Number((config.get().logs || {}).keepDays ?? 30);
  const items = await list();
  const live = new Set([...open.values()].map((o) => o.id));
  const old = days > 0 ? items.filter((x) => x.state !== 'running' && !live.has(x.id) && Date.now() - (x.endedAt || x.startedAt) > days * DAY) : [];
  for (const it of old) await fsp.rm(fileOf(it), { force: true }).catch(() => {});
  const known = new Set(items.map((x) => x.file));
  const gone = new Set(old.map((x) => x.id));
  let files = [];
  try { files = await fsp.readdir(dir()); } catch { /* 还没有日志 */ }
  for (const f of files) {
    if (!/\.log$/.test(f) || known.has(f)) continue;
    const p = path.join(dir(), f);
    try { const st = await fsp.stat(p); if (days > 0 && Date.now() - st.mtimeMs > days * DAY) await fsp.rm(p, { force: true }); } catch { /* ignore */ }
  }
  // 文件已经不在的那几条也从索引里去掉（玩家自己在文件夹里删的；以前索引里那一条永远留着）。list() 只列文件还在的
  const shown = new Set(items.map((x) => x.id));
  const keep = (x) => !gone.has(x.id) && (shown.has(x.id) || live.has(x.id));
  const raw = await store.read(indexFile(), IDX.fallback, IDX).catch(() => ({ items: [] }));
  if ((raw.items || []).some((x) => !keep(x))) {
    await store.update(indexFile(), (idx) => { idx.items = (idx.items || []).filter(keep); return idx; }, IDX).catch(() => {});
  }
  return gone.size;
}

/**
 * 导出一整份（rc9）：直接复制存着的文件。以前界面用「读最后 N 行」的接口拼出来再存，
 * 那个接口最多给 20000 行，长日志前面的都没导出去，也没有提示
 */
async function exportTo(id, dest) {
  const it = (await list()).find((x) => x.id === id);
  if (!it) throw new Error('这份日志已经不在了');
  await writeFileSafe(dest, await fsp.readFile(fileOf(it)));
  return dest;
}

async function usage() {
  const items = await list();
  return { count: items.length, bytes: items.reduce((s, x) => s + (x.bytes || 0), 0), dir: dir() };
}

module.exports = { begin, write, finish, list, read, remove, clear, prune, usage, dir, levels, exportTo, MAX_BYTES };
