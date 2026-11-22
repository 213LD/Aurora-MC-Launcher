'use strict';
/**
 * 下载器：批量并发下载，按哈希或大小校验，候选地址轮着试，同一个文件同时只下一次，进度报给任务。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { request, HttpError, shortUrl } = require('./net');
const { sleep, abortError, hashFile, renameRetry, fileKey } = require('./util');
const { describe, withReason } = require('./errors');
const config = require('./config');
const { nm } = require('../../shared/i18n');

// 这些错误重试也没有意义
const FATAL = new Set(['DISK_FULL', 'PERMISSION', 'PATH_TOO_LONG']);
const REPORT_MS = 100;

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * 校验本地文件是否可用
 * mode: 'hash' 完整校验哈希；'size' 仅校验大小（启动时快速检查）
 */
async function isValid(file, mode) {
  let st;
  try { st = await fsp.stat(file.path); } catch { return false; }
  if (!st.isFile()) return false;
  if (file.size && st.size !== file.size) return false;
  if (mode === 'size' || mode === 'exists') return st.size > 0 || file.size === 0;
  if (file.sha1) return (await hashFile(file.path, 'sha1')) === file.sha1.toLowerCase();
  if (file.sha256) return (await hashFile(file.path, 'sha256')) === file.sha256.toLowerCase();
  return st.size > 0 || file.size === 0;
}

async function freeSpace(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 30; i++) {
    try {
      const s = await fsp.statfs(d);
      return { free: Number(s.bavail) * Number(s.bsize), root: path.parse(d).root };
    } catch {
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
  return null;
}

/** 下载前检查磁盘空间，空间不足时直接给出明确提示 */
async function checkDiskSpace(list, totalBytes) {
  if (totalBytes < 32 * 1024 * 1024 || !list.length) return;
  const info = await freeSpace(path.dirname(list[0].path));
  if (!info || info.free > totalBytes + 64 * 1024 * 1024) return;
  let existing = 0;
  for (const f of list) {
    try { const st = await fsp.stat(f.path); existing += Math.min(st.size, f.size || st.size); } catch { /* 不存在 */ }
  }
  const need = totalBytes - existing;
  if (need > 0 && info.free < need + 64 * 1024 * 1024) {
    throw withReason(`磁盘空间不足：需要约 ${fmtBytes(need)}，${info.root} 只剩 ${fmtBytes(info.free)}`, {
      code: 'DISK_FULL', message: '磁盘空间不足', hint: '请清理磁盘空间，或在「设置 → 游戏目录」中换到空间更大的磁盘',
    });
  }
}

async function fetchToFile(url, file, ctx, slot) {
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  ctx.signal.addEventListener('abort', onOuter, { once: true });
  let idle = null;
  let stalled = false;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { stalled = true; ctrl.abort(); }, 25000);
  };
  const tmp = `${file.path}.part`;
  let received = 0;
  slot.received = 0;
  slot.host = shortUrl(url).split('/')[0];
  kick();
  try {
    const { res, done } = await request(url, { signal: ctrl.signal, timeout: 10 * 60 * 1000 });
    try {
      if (!res.ok || !res.body) throw new HttpError(res.status, url);
      const len = Number(res.headers.get('content-length')) || 0;
      if (!slot.size && len) slot.size = len;
      await fsp.mkdir(path.dirname(file.path), { recursive: true });
      const algo = file.sha1 ? 'sha1' : file.sha256 ? 'sha256' : null;
      const hash = algo ? crypto.createHash(algo) : null;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          slot.received = received;
          if (hash) hash.update(chunk);
          ctx.addBytes(chunk.length);
          kick();
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
      if (hash) {
        const got = hash.digest('hex');
        const want = (file.sha1 || file.sha256).toLowerCase();
        if (got !== want) throw Object.assign(new Error(`文件校验失败（${nm(path.basename(file.path))}）`), { code: 'CHECKSUM' });
      } else if (file.size && received !== file.size) {
        throw Object.assign(new Error(`文件大小不匹配（${nm(path.basename(file.path))}）`), { code: 'CHECKSUM' });
      }
      // 直接覆盖：以前先删再改名，中间有一段文件不存在
      await renameRetry(tmp, file.path);
      if (file.executable && process.platform !== 'win32') await fsp.chmod(file.path, 0o755);
    } finally {
      done();
    }
  } catch (e) {
    ctx.addBytes(-received);
    try { ctrl.abort(); } catch { /* 已经断了 */ } // HTTP 报错时响应体还没读完：断开，连接马上放掉，不等垃圾回收
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (ctx.signal.aborted) throw abortError();
    if (stalled) throw Object.assign(new Error(`下载停滞（${shortUrl(url)}）`), { code: 'STALLED' });
    throw e;
  } finally {
    clearTimeout(idle);
    ctx.signal.removeEventListener('abort', onOuter);
  }
}

// 正在下载的文件（路径 → Promise）：同一个文件同时只下载一次（1.10.8）。
// 同时装两个共用库和资源的版本、补全和启动撞车时，以前两边写同一个 .part，文件会损坏或者消失一段时间
const inflight = new Map();

/** 等另一个任务下完（不管它成没成功，回来再校验一次）；自己取消了马上返回 */
function waitOther(other, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    other.finally(() => { signal.removeEventListener('abort', onAbort); resolve(); });
  });
}

async function downloadOne(file, ctx) {
  const key = fileKey(file.path);
  for (;;) {
    if (await isValid(file, ctx.verify)) {
      ctx.addSkipped(file.size || 0);
      return;
    }
    const other = inflight.get(key);
    if (!other) break;
    await waitOther(other, ctx.signal);
  }
  // 从上面 get 到这里没有 await，不会两个任务同时走到这里
  let release;
  inflight.set(key, new Promise((r) => { release = r; }));
  try {
    await fetchWithRetry(file, ctx);
  } finally {
    inflight.delete(key);
    release();
  }
}

async function fetchWithRetry(file, ctx) {
  const name = path.basename(file.path);
  const urls = (file.urls || [file.url]).filter(Boolean);
  if (!urls.length) throw withReason(`缺少文件且无下载地址：${nm(name)}`, { code: 'NO_SOURCE', message: '没有可用的下载地址', hint: '该文件只能由安装器生成，请重新安装对应的版本或加载器' });
  const slot = { name, size: file.size || 0, received: 0, started: Date.now() };
  ctx.active.add(slot);
  let lastErr = null;
  try {
    const attempts = Math.max(4, urls.length * 2);
    for (let i = 0; i < attempts; i++) {
      if (ctx.signal.aborted) throw abortError();
      const url = urls[i % urls.length];
      slot.attempt = i + 1;
      try {
        await fetchToFile(url, file, ctx, slot);
        return;
      } catch (e) {
        if (e.cancelled) throw e;
        lastErr = e;
        if (FATAL.has(describe(e).code)) break;
        // 404 时直接换下一个地址，否则稍等后重试
        if (!(e instanceof HttpError && e.status === 404)) await sleep(400 * (i + 1));
      }
    }
  } finally {
    ctx.active.delete(slot);
  }
  const reason = describe(lastErr);
  throw withReason(`${name}：${reason.message}`, reason, { fileName: name, raw: lastErr && lastErr.message });
}

/**
 * 批量并发下载。
 * @param {Array<{urls:string[], path:string, sha1?:string, sha256?:string, size?:number}>} files
 * @param {{task?:import('./tasks').Task, signal?:AbortSignal, verify?:'hash'|'size', concurrency?:number, label?:string}} opts
 */
async function downloadAll(files, opts = {}) {
  const task = opts.task;
  const signal = opts.signal || (task && task.signal) || new AbortController().signal;
  const concurrency = opts.concurrency || config.get().concurrency || 32;
  const verify = opts.verify || 'hash';
  const label = opts.label || '下载文件';

  // 按路径去重
  const map = new Map();
  for (const f of files) if (f && f.path && !map.has(f.path)) map.set(f.path, f);
  const list = [...map.values()];

  const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
  await checkDiskSpace(list, totalBytes);

  let bytes = 0;
  let filesDone = 0;
  const failures = [];
  const active = new Set();

  let lastBytes = 0;
  let lastTime = Date.now();
  let speed = 0;

  // 每个数据块都会走到这里，算一次要排序活动连接、拼列表。发给界面本来就有 200 毫秒节流，计算也节流
  let lastReport = 0;
  const report = (force) => {
    if (!task) return;
    const now = Date.now();
    if (!force && now - lastReport < REPORT_MS) return;
    lastReport = now;
    const dt = (now - lastTime) / 1000;
    if (dt >= 0.5) {
      const inst = Math.max(0, (bytes - lastBytes) / dt);
      speed = speed ? speed * 0.6 + inst * 0.4 : inst;
      lastBytes = bytes; lastTime = now;
    }
    const progress = totalBytes > 0 ? Math.min(1, bytes / totalBytes) : list.length ? filesDone / list.length : 1;
    const remain = Math.max(0, totalBytes - bytes);
    const current = [...active].sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 6)
      .map((s) => ({ name: s.name, received: s.received, size: s.size, host: s.host, attempt: s.attempt }));
    task.update({
      progress,
      speed,
      eta: speed > 1024 && totalBytes ? Math.round(remain / speed) : 0,
      files: { done: filesDone, total: list.length, active: active.size, failed: failures.length },
      bytes: { done: Math.max(0, bytes), total: totalBytes },
      current,
      failures: failures.slice(0, 50),
      detail: `${label} ${filesDone}/${list.length}${failures.length ? `（${failures.length} 个失败）` : ''}`,
    });
  };

  const ctx = {
    signal,
    verify,
    active,
    addBytes(n) { bytes += n; report(); },
    addSkipped(n) { bytes += n; lastBytes += n; },
  };

  let idx = 0;
  let fatal = null;
  const worker = async () => {
    while (idx < list.length && !fatal) {
      if (signal.aborted) throw abortError();
      const f = list[idx++];
      try {
        await downloadOne(f, ctx);
      } catch (e) {
        if (e.cancelled) throw e;
        const r = e.reason || describe(e);
        failures.push({ name: e.fileName || path.basename(f.path), code: r.code, message: r.message, hint: r.hint, raw: e.raw || '' });
        // 磁盘满 / 没有权限时停止整个任务
        if (FATAL.has(r.code)) fatal = e;
      }
      filesDone++;
      report();
    }
  };
  report(true);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, worker));
  report(true); // 最后一次一定要算，不然停在节流之前的进度上
  if (signal.aborted) throw abortError();
  if (failures.length) {
    // 选出最主要的失败原因
    const counts = new Map();
    for (const f of failures) counts.set(f.code, (counts.get(f.code) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const sample = failures.find((f) => f.code === top);
    const e = withReason(
      `${failures.length} 个文件下载失败：${sample.message}${failures.length === 1 ? `（${sample.name}）` : ''}`,
      { code: sample.code, message: sample.message, hint: sample.hint },
      { failures },
    );
    if (task) task.update({ failures: failures.slice(0, 50) });
    throw e;
  }
  return { count: list.length, bytes: totalBytes };
}

/** 下载单个文件（带候选地址与校验） */
async function downloadFile(file, opts = {}) {
  return downloadAll([file], { ...opts, concurrency: 1 });
}

module.exports = { downloadAll, downloadFile, isValid, freeSpace, fmtBytes };
