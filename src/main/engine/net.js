'use strict';
const { net, app } = require('electron');
const { sleep, abortError } = require('./util');

// UA 固定写 AuroraLauncher，不跟着改名：CurseForge 社区代理的 Cloudflare 认这个，换了可能被拦
const UA = () => `AuroraLauncher/${app.getVersion()} (Minecraft Launcher)`;

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status}：${shortUrl(url)}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function shortUrl(u) {
  try { const x = new URL(u); return x.host + x.pathname; } catch { return u; }
}

/**
 * 基于 Chromium 网络栈的 fetch（自动使用系统代理）。
 * timeout 覆盖“连接 + 读取响应体”的整个过程（由调用方读取 body 前不会清除计时器）。
 */
async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, json, timeout = 20000, signal } = opts;
  // 下载地址可能来自别人的整合包。net.fetch 也能读 file://，不限制的话能把电脑上的文件「下载」进游戏目录（2.0.0-pre8）
  if (!/^https?:\/\//i.test(String(url))) throw new Error(`不支持的下载地址：${String(url).slice(0, 60)}`);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const h = { 'User-Agent': UA(), ...headers };
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    h['Content-Type'] = 'application/json';
    h.Accept = h.Accept || 'application/json';
  }
  const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
  try {
    const res = await net.fetch(url, { method, headers: h, body: payload, signal: ctrl.signal, cache: 'no-store' });
    return { res, done, isTimeout: () => timedOut };
  } catch (e) {
    done();
    if (signal && signal.aborted) throw abortError();
    if (timedOut) throw new Error(`请求超时：${shortUrl(url)}`);
    throw new Error(`网络错误：${shortUrl(url)}（${e.message}）`);
  }
}

async function readBody(url, opts, kind) {
  const { res, done, isTimeout } = await request(url, opts);
  try {
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      throw new HttpError(res.status, url, text);
    }
    if (kind === 'json') return await res.json();
    if (kind === 'buffer') return Buffer.from(await res.arrayBuffer());
    return await res.text();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (opts.signal && opts.signal.aborted) throw abortError();
    if (isTimeout()) throw new Error(`请求超时：${shortUrl(url)}`);
    throw e;
  } finally {
    done();
  }
}

/** 按顺序尝试多个候选地址，每个地址最多重试 retries 次 */
async function fetchAny(urls, opts = {}, kind = 'json') {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const retries = opts.retries ?? 2;
  let lastErr = null;
  for (const url of list) {
    for (let i = 0; i < retries; i++) {
      try {
        return await readBody(url, opts, kind);
      } catch (e) {
        if (e.cancelled) throw e;
        lastErr = e;
        if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) break;
        await sleep(300 * (i + 1));
      }
    }
  }
  throw lastErr || new Error('没有可用的下载地址');
}

const getJson = (urls, opts) => fetchAny(urls, opts, 'json');
const getText = (urls, opts) => fetchAny(urls, opts, 'text');
const getBuffer = (urls, opts) => fetchAny(urls, opts, 'buffer');

/**
 * 发一个请求，返回 { status, ok, data }，不自动抛出 4xx（登录接口要看错误内容）。
 * 下面三个以前各写了一遍；读响应时超时、被取消也没换成自己的说法，界面看到的是英文的「operation was aborted」
 */
async function exchange(url, reqOpts) {
  const { res, done, isTimeout } = await request(url, reqOpts);
  try {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    if (reqOpts.signal && reqOpts.signal.aborted) throw abortError();
    if (isTimeout()) throw new Error(`请求超时：${shortUrl(url)}`);
    throw e;
  } finally { done(); }
}

/** 用于 POST 接口 */
const postJson = (url, payload, opts = {}) => exchange(url, { ...opts, method: 'POST', json: payload });

const postForm = (url, form, opts = {}) => exchange(url, {
  ...opts,
  method: 'POST',
  body: new URLSearchParams(form).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(opts.headers || {}) },
});

const getJsonAuth = (url, token, opts = {}) => exchange(url, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

module.exports = { request, getJson, getText, getBuffer, postJson, postForm, getJsonAuth, HttpError, UA, shortUrl };
