'use strict';
/**
 * 任务引擎：所有耗时操作（安装、下载、补全）都以任务形式运行，状态节流广播到渲染进程。
 * 入口两个（2.0.0-pre3，以前有 35 处各写各的）：
 * - start(opts, fn, after)：后台跑，马上返回任务 id，失败了能重试
 * - run(opts, fn)：等它跑完，返回结果，错误抛给调用方
 * opts: { title, kind, meta, dir, doneText（文字或 (结果) => 文字）, lock（要占用的配置 id，可以是数组）, failTitle }
 *
 * 失败时谁来提示只有一个地方决定（以前两边都提示）：
 * - failTitle：主进程发一条通知（notice: 'main'）
 * - start 没写 failTitle：界面按任务提示（notice: 'task'）
 * - run：错误抛给调用方，它自己提示（notice: 'caller'）
 * 取消永远不提示。
 */
const { describe, friendly } = require('./errors');
const { nm } = require('../../shared/i18n');

let seq = 0;
const tasks = new Map();
let broadcast = () => {};

function setBroadcaster(fn) { broadcast = fn; }

class Task {
  constructor(title, opts = {}) {
    this.id = `t${++seq}`;
    this.title = title;
    this.kind = opts.kind || 'generic';
    this.meta = opts.meta || {};
    this.status = 'running'; // running | done | failed | cancelled
    this.progress = 0; // 0..1，-1 表示不确定
    this.detail = '准备中…';
    this.speed = 0;
    this.eta = 0;
    this.error = '';
    this.reason = null; // { code, message, hint }
    this.files = { done: 0, total: 0, active: 0, failed: 0 };
    this.bytes = { done: 0, total: 0 };
    this.current = [];
    this.failures = [];
    this.dir = opts.dir || null;
    this.retryable = false;
    this.retryOf = opts.retryOf || null;
    this.notice = opts.notice || 'task'; // 失败时谁来提示，见文件开头
    this.createdAt = Date.now();
    this.endedAt = 0;
    this.controller = new AbortController();
    this._timer = null;
    this._dirty = false;
    tasks.set(this.id, this);
    pruneFinished();
    this.flush();
  }

  get signal() { return this.controller.signal; }

  update(patch) {
    Object.assign(this, patch);
    this._dirty = true;
    if (!this._timer) {
      this._timer = setTimeout(() => { this._timer = null; if (this._dirty) this.flush(); }, 200);
    }
  }

  flush() {
    this._dirty = false;
    broadcast('task:update', this.toJSON());
  }

  _end(status, detail) {
    this.status = status;
    this.detail = detail;
    this.speed = 0;
    this.eta = 0;
    this.current = [];
    this.endedAt = Date.now();
    clearTimeout(this._timer); this._timer = null;
    this.flush();
  }

  finish(detail = '已完成') {
    if (this.status !== 'running') return;
    this.progress = 1;
    this._end('done', detail);
  }

  fail(err) {
    if (this.status !== 'running') return;
    const cancelled = err && err.cancelled;
    if (cancelled) { this._end('cancelled', '已取消'); return; }
    this.reason = (err && err.reason) || describe(err);
    this.error = friendly(err);
    if (err && Array.isArray(err.failures)) this.failures = err.failures.slice(0, 50);
    this.retryable = !!this._retry;
    this._end('failed', this.error);
  }

  cancel() {
    if (this.status === 'running') this.controller.abort();
  }

  toJSON() {
    return {
      id: this.id, title: this.title, kind: this.kind, meta: this.meta, status: this.status, progress: this.progress,
      detail: this.detail, speed: this.speed, eta: this.eta, error: this.error, reason: this.reason, files: this.files,
      bytes: this.bytes, current: this.current, failures: this.failures, dir: this.dir, retryable: this.retryable,
      createdAt: this.createdAt, endedAt: this.endedAt, retryOf: this.retryOf, notice: this.notice,
    };
  }
}

// ───────────────────────── 按配置互斥 ─────────────────────────
// 同一个配置同时只跑一个会改它内容的任务（配置 id → 任务标题）（1.10.8）：
// 以前只有安装时查，组件更新、配置器修改、补全可以撞在一起，互相覆盖
const locks = new Map();
function assertFree(id) {
  if (locks.has(id)) throw new Error(`「${nm(id)}」还有任务在进行（${locks.get(id)}），等它完成后再试`);
}
function hasLocks() { return locks.size > 0; }
function takeLocks(lock, title) {
  const keys = Array.isArray(lock) ? lock : lock ? [lock] : [];
  keys.forEach(assertFree);
  keys.forEach((k) => locks.set(k, title));
  return () => keys.forEach((k) => locks.delete(k));
}

// ───────────────────────── 通知 ─────────────────────────
let notifier = () => {};
function setNotifier(fn) { notifier = fn; }

/** 错误信息 + 解决建议 */
function errText(err) {
  const r = (err && err.reason) || describe(err);
  return `${friendly(err)}${r && r.hint ? `\n建议：${r.hint}` : ''}`;
}

const doneTextOf = (opts, result) => (typeof opts.doneText === 'function' ? opts.doneText(result) : opts.doneText || '已完成');

// ───────────────────────── 两个入口 ─────────────────────────
/** 后台跑，马上返回任务 id。after(err, result)：结束后调用（失败时的提示不用写在这里，给 failTitle） */
function start(opts, fn, after) {
  const release = takeLocks(opts.lock, opts.title);
  const task = new Task(opts.title, { ...opts, notice: opts.failTitle ? 'main' : 'task' });
  // 失败后可以用同样的参数重新运行
  task._retry = () => start({ ...opts, retryOf: task.id }, fn, after);
  const callAfter = (err, result) => {
    if (!after) return;
    try { after(err, result); } catch (e) { console.error(`[task] ${opts.title} 的收尾出错`, e); }
  };
  (async () => {
    let result;
    try {
      result = await fn(task);
    } catch (e) {
      release();
      task.fail(e);
      if (opts.failTitle && !e.cancelled) notifier({ level: 'crit', title: opts.failTitle, text: errText(e), taskError: true, taskId: task.id, taskTitle: task.title });
      callAfter(e);
      return;
    }
    release();
    task.finish(doneTextOf(opts, result));
    callAfter(null, result);
  })();
  return task.id;
}

/** 等它跑完，返回结果；错误抛给调用方 */
async function run(opts, fn) {
  const release = takeLocks(opts.lock, opts.title);
  const task = new Task(opts.title, { ...opts, notice: 'caller' });
  try {
    const result = await fn(task);
    task.finish(doneTextOf(opts, result));
    return result;
  } catch (e) {
    task.fail(e);
    throw e;
  } finally {
    release();
  }
}

/** 结束的任务只留最近这么多个（2.0.0-pre8）：玩家不点清除的话一直留着，每个还带着重试用的闭包 */
const KEEP_FINISHED = 200;
function pruneFinished() {
  const done = [...tasks.values()].filter((t) => t.status !== 'running');
  if (done.length <= KEEP_FINISHED) return;
  for (const t of done.slice(0, done.length - KEEP_FINISHED)) tasks.delete(t.id);
  broadcast('task:cleared', list());
}

function list() { return [...tasks.values()].map((t) => t.toJSON()); }
function get(id) { return tasks.get(id) || null; }
function cancel(id) { const t = tasks.get(id); if (t) t.cancel(); }
function remove(id) {
  const t = tasks.get(id);
  if (t && t.status !== 'running') tasks.delete(id);
  broadcast('task:cleared', list());
}
function clearFinished() {
  for (const [id, t] of tasks) if (t.status !== 'running') tasks.delete(id);
  broadcast('task:cleared', list());
}

module.exports = { Task, run, list, get, cancel, remove, clearFinished, setBroadcaster, start, assertFree, hasLocks, setNotifier, errText };
