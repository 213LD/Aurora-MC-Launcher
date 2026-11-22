'use strict';
/**
 * 玩家数据的 JSON 文件：设置、账户、配置档案、皮肤库、方案、缓存……（1.10.7）
 *
 * 以前 readJson 读不出来（文件坏了、被杀毒软件占着）就当成空的，下一次保存把原来的内容整个盖掉。现在：
 * - 读：分清「没有这个文件」「文件坏了」「暂时读不了」
 *   · 坏了：原样改名留着（name.corrupt-时间），有上一份备份（name.bak）就用它恢复
 *   · 暂时读不了：重试一会儿，还不行就不写回，免得盖掉原来的内容
 * - 写：覆盖之前把现在这份（能读的话）留成 .bak；同一个文件的读改写排队（update），不会互相覆盖
 * - 恢复、没救回来、读不了都会记一条通知，界面取走后告诉玩家（ipc app:dataNotices、事件 data:notice）
 * 文件格式没变，老版本照常能读。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { writeJson, renameRetry, queued, fileKey, sleep } = require('./util');

const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const TRIES = 6; // 读不了时重试约 1.5 秒
const queues = new Map();

const parse = (text) => JSON.parse(String(text).replace(/^\uFEFF/, ''));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bakOf = (p) => `${p}.bak`;

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function corruptName(p) {
  const base = `${p}.corrupt-${stamp()}`;
  for (let i = 1; ; i++) { const n = i === 1 ? base : `${base}-${i}`; if (!fs.existsSync(n)) return n; }
}

// ───────────────────────── 通知 ─────────────────────────
const pending = [];
const reported = new Set();
let listener = null;

function notice(type, label, file, keptAs) {
  const key = `${type}|${fileKey(file)}`;
  if (reported.has(key)) return; // 同一个文件同一种情况只说一次
  reported.add(key);
  const n = type === 'recovered'
    ? { level: 'warn', title: `${label}读不出来，已经用备份恢复`, text: '恢复成了上一次保存之前的内容，最近一次改动可能没了。读坏的文件没有删，点下面的按钮可以找到它', path: keptAs }
    : type === 'lost'
      ? { level: 'crit', title: `${label}读不出来，也没有可用的备份`, text: '这次只能从空白开始。读坏的文件没有删，点下面的按钮可以找到它，可以自己检查或找人帮忙恢复', path: keptAs }
      : type === 'savefail'
        ? { level: 'crit', title: `${label}暂时保存不了`, text: '文件可能被杀毒软件或别的程序占着。启动器会一直重试，改动还在；重试成功之前先别关启动器。' }
        : { level: 'crit', title: `${label}暂时读不了`, text: '文件可能被杀毒软件或别的程序占着。为了不盖掉原来的内容，这次相关的改动不会保存。关掉占用它的程序，重启启动器后再试', path: file };
  const item = { type, file, ...n, at: Date.now() };
  console.warn(`[jsonstore] ${type} ${file}${keptAs ? ` → ${keptAs}` : ''}`);
  if (listener) listener(item); else pending.push(item);
}

/** 一个文件连续写失败：告诉玩家一次（调用方自己重试）。写成功后调 writeRecovered，下次再失败才能再说一次 */
function writeFailed(label, file) { notice('savefail', label, file); }
function writeRecovered(label, file) {
  const key = `savefail|${fileKey(file)}`;
  if (!reported.delete(key)) return;
  const item = { type: 'saved', file, level: 'ok', title: `${label}已经保存好了`, text: '刚才保存不了的改动，重试后写进去了。', at: Date.now() };
  if (listener) listener(item); else pending.push(item);
}

/** 界面准备好以后：取走攒着的通知，之后的直接交给 fn */
function drain(fn) {
  if (fn) listener = fn;
  return pending.splice(0);
}

function busyError(label, file, cause) {
  const e = new Error(`${label}暂时读不了（可能被杀毒软件或别的程序占着），这次的改动没有保存，免得盖掉原来的内容。稍后再试`);
  e.reason = { code: 'DATA_BUSY', message: '数据文件暂时读不了', hint: '关掉占用它的程序，或者重启启动器后再试' };
  e.path = file;
  e.cause = cause;
  return e;
}

// ───────────────────────── 读 ─────────────────────────
/** 读一次：{ status: 'ok', data } | 'missing' | 'corrupt' | 'busy' */
async function readRaw(p) {
  for (let i = 0; ; i++) {
    let text;
    try { text = await fsp.readFile(p, 'utf8'); } catch (e) {
      if (MISSING.has(e.code)) return { status: 'missing' };
      if (i < TRIES - 1) { await sleep(50 * 2 ** i); continue; }
      return { status: 'busy', error: e };
    }
    try { return { status: 'ok', data: parse(text) }; } catch (e) { return { status: 'corrupt', error: e }; }
  }
}

const block = new Int32Array(new SharedArrayBuffer(4));
function readRawSync(p) {
  for (let i = 0; ; i++) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) {
      if (MISSING.has(e.code)) return { status: 'missing' };
      if (i < TRIES - 1) { Atomics.wait(block, 0, 0, 50 * 2 ** i); continue; }
      return { status: 'busy', error: e };
    }
    try { return { status: 'ok', data: parse(text) }; } catch (e) { return { status: 'corrupt', error: e }; }
  }
}

/** 坏了的文件：改名留着，有能读的 .bak 就恢复成它 */
async function recover(p, label) {
  const keptAs = corruptName(p);
  try { await renameRetry(p, keptAs); } catch (e) { notice('busy', label, p); return { status: 'busy', error: e }; }
  const bak = await readRaw(bakOf(p));
  if (bak.status === 'ok') {
    await writeJson(p, bak.data);
    notice('recovered', label, p, keptAs);
    return { status: 'recovered', data: bak.data, keptAs };
  }
  notice('lost', label, p, keptAs);
  return { status: 'lost', keptAs };
}

function recoverSync(p, label) {
  const keptAs = corruptName(p);
  try { fs.renameSync(p, keptAs); } catch (e) { notice('busy', label, p); return { status: 'busy', error: e }; }
  const bak = readRawSync(bakOf(p));
  if (bak.status === 'ok') {
    // 写回失败也不要紧：内容已经在内存里，下一次保存会写出去。启动时不能因为这个崩溃
    const tmp = `${p}.${process.pid}.${Date.now()}.recover.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(bak.data, null, 2), 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) {
      console.warn('[jsonstore] 恢复时写回失败', e.message);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    notice('recovered', label, p, keptAs);
    return { status: 'recovered', data: bak.data, keptAs };
  }
  notice('lost', label, p, keptAs);
  return { status: 'lost', keptAs };
}

async function loadIn(p, label) {
  const r = await readRaw(p);
  if (r.status === 'corrupt') return recover(p, label);
  if (r.status === 'busy') notice('busy', label, p);
  return r;
}

/**
 * 读取并处理坏文件。返回 { status, data }：ok / missing / recovered（data 是备份） / lost（坏文件已改名留着） / busy（读不了，别写回）
 * opts.label：给玩家看的名字（「设置」「配置「x」的档案」）
 */
async function load(p, { label = path.basename(p) } = {}) {
  const r = await readRaw(p);
  if (r.status === 'ok' || r.status === 'missing') return r;
  if (r.status === 'busy') { notice('busy', label, p); return r; }
  // 坏了：排队处理，免得几个同时读到的调用一起去改名
  return queued(queues, fileKey(p), () => loadIn(p, label));
}

function loadSync(p, { label = path.basename(p) } = {}) {
  const r = readRawSync(p);
  if (r.status === 'corrupt') return recoverSync(p, label);
  if (r.status === 'busy') notice('busy', label, p);
  return r;
}

/** 读到的内容，没有 / 没救回来时用 fallback；读不了时抛错（调用方别拿空的去覆盖） */
async function read(p, fallback, opts = {}) {
  const r = await load(p, opts);
  if (r.status === 'busy') throw busyError(opts.label || path.basename(p), p, r.error);
  return r.data !== undefined && r.data !== null ? r.data : clone(fallback);
}

// ───────────────────────── 写 ─────────────────────────
/** 覆盖之前：现在这份能读就留成 .bak；坏了就改名留着（新内容整份写入，不需要它） */
async function keepCurrent(p, label) {
  const cur = await readRaw(p);
  if (cur.status === 'ok') await writeJson(bakOf(p), cur.data).catch((e) => console.warn('[jsonstore] 备份失败', e.message));
  else if (cur.status === 'corrupt') await renameRetry(p, corruptName(p)).catch(() => {});
  else if (cur.status === 'busy') throw busyError(label, p, cur.error);
}

/** 整份写入（调用方手里就是完整内容，比如内存里的设置）。opts.resetBak：备份也换成这份（删了账户，旧备份里不该还留着它） */
function write(p, data, { label = path.basename(p), resetBak = false } = {}) {
  const snapshot = clone(data);
  return queued(queues, fileKey(p), async () => {
    await keepCurrent(p, label);
    await writeJson(p, snapshot);
    if (resetBak) await writeJson(bakOf(p), snapshot).catch(() => {});
  });
}

/**
 * 读改写：fn(当前内容) 返回新内容（返回 undefined 就不写），同一个文件排队执行。fn 里不要再 update 同一个文件。
 * 读不了时抛错，不会拿空的去覆盖
 */
function update(p, fn, { label = path.basename(p), fallback } = {}) {
  return queued(queues, fileKey(p), async () => {
    const r = await loadIn(p, label);
    if (r.status === 'busy') throw busyError(label, p, r.error);
    const cur = r.data !== undefined && r.data !== null ? r.data : clone(fallback);
    const next = await fn(cur);
    if (next === undefined) return cur;
    await keepCurrent(p, label);
    await writeJson(p, next);
    return next;
  });
}

module.exports = { load, loadSync, read, write, update, drain, busyError, writeFailed, writeRecovered };
