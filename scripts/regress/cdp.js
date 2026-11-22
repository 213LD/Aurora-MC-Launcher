'use strict';
/** 回归脚本公用：连上启动器的调试端口，等它准备好；关闭只走 CDP 让它自己退出（不按进程名杀别的东西） */
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 测试窗口一律不降速（rc4 起）：窗口被挡住、显示器休眠时 Chromium 会把定时器限到每分钟一次、停掉动画，
 * 测试超时或者一帧都没走。以前七个启动测试窗口的地方各写各的，漏了四个、有两个少一项（rc9）；
 * 现在只写在这里，所有入口都用它
 */
const NO_THROTTLE = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

/** 等到条件成立（js 在页面里算出真值）再往下走，最多等 ms 毫秒；返回最后一次的值。代替「等固定的毫秒数」：机器慢时不会偶发失败，快时不白等 */
async function until(ev, js, ms = 8000, step = 100) {
  const t0 = Date.now();
  let v;
  for (;;) {
    try { v = await ev(js); } catch { v = null; }
    if (v || Date.now() - t0 >= ms) return v;
    await sleep(step);
  }
}

/**
 * 等 Node 这边的一件事（rc13）：fn 返回真值就停，最多等 ms 毫秒，到时还不行返回假值，后面的检查会报出来。
 * 代替「写完文件、杀了进程、开始下载以后 sleep 一会儿」：机器忙的时候等够，平时不白等
 */
async function waitFor(fn, ms = 8000, step = 50) {
  const t0 = Date.now();
  let v;
  for (;;) {
    try { v = await fn(); } catch { v = null; }
    if (v || Date.now() - t0 >= ms) return v;
    await sleep(step);
  }
}

/**
 * 等页面上的一件事，等不到就算这一项没通过（rc13）：抛出「等了 N 秒还没等到：what」，guard() 把它记成失败。
 * 用在后面的检查不直接看这件事的地方（不然 until 等不到，后面查的东西又不相干，失败原因就说不清）
 */
async function need(ev, js, ms, what) {
  const v = await until(ev, js, ms);
  if (!v) throw new Error(`等了 ${Math.round(ms / 1000)} 秒还没等到：${what}`);
  return v;
}

/**
 * 刚启动完（rc11）：等启动器的界面起来、不再变；主页背景是像素场景的话，等场景建出来。
 * 代替各个脚本里「启动以后 sleep 两三秒」。
 */
async function ready(ev) {
  await until(ev, '!!(window.A && A.state && A.state.info && A.state.config && A.pages && A.pages.home)', 30000, 200);
  await calm(ev);
  await until(ev, "(() => { const bg = A.state.config.background || {}; if (bg.type && bg.type !== 'scene') return true; const s = A.homeScene && A.homeScene(); return !!(s && s.W && s.heights && s.ents); })()", 10000, 100);
}

/**
 * 等界面不再变（rc11）：最上面的弹窗（没有弹窗就是当前页面）的元素个数、文字长度、高度连着 4 次都一样（约 0.4 秒），
 * 而且里面没有转圈。代替「切页面、点按钮以后 sleep 几百毫秒」：机器忙的时候等够，平时不白等。
 * 最多等 ms 毫秒，到时候还在变就不等了（返回假值），后面的检查自己会报出来。
 * 不能用它代替「就是要过这么久」的等待（等提示自己消失、等一秒看背景停没停），那种还用 sleep
 */
async function calm(ev, ms = 8000) {
  try { await ev('window.__calmSig = null; window.__calmN = 0; 1'); } catch { /* 页面正在重新加载：下面接着等 */ }
  return until(ev, `(() => { const m = [...document.querySelectorAll('.modal-back .modal')].pop(); const r = m || document.querySelector('.page.active') || document.body;
    const sig = r.querySelectorAll('*').length + ':' + r.innerText.length + ':' + r.scrollHeight + ':' + (window.A && A.state ? A.state.page : '');
    window.__calmN = sig === window.__calmSig ? (window.__calmN || 0) + 1 : 0; window.__calmSig = sig;
    return window.__calmN >= 3 && !r.querySelector('.spinner'); })()`, ms, 100);
}

/**
 * 主页的世界每天换一个种子，用到「今天的世界」的测试今天过、明天不一定过（rc3 那次点瀑布点到了岩浆就是这样）。
 * 在页面里跑这一段：现在的场景和之后新建的场景都用固定的种子。种子是在新建场景的那一刻定的，
 * 测试自己再给场景换种子不受影响（第一版写成「第一次生成世界时定」，把自己换种子的测试也锁死了）
 */
const WORLD_SEED = 20769; // 2026-11-12 那天的世界，场景类测试在它上面都跑通过
const FIX_SEED = `(() => {
  if (!window.A || !A.Scene || A.Scene.__seedFixed) return 0;
  const Orig = A.Scene;
  // 只拦「新建」这一下。不能换成子类：别的测试会临时替换 A.Scene.prototype 上的函数，换成子类以后替换的东西落不到已经建好的场景上
  A.Scene = new Proxy(Orig, { construct(t, args) { const s = new t(...args); s.seed = ${WORLD_SEED}; return s; } });
  Orig.__seedFixed = true;
  const s = A.homeScene && A.homeScene();
  if (s) { s.seed = ${WORLD_SEED}; if (s.W) s.build(); }
  return 1;
})()`;
/**
 * 世界还跟着窗口高度变：地形的起伏按窗口有多少行算，测试窗口的高度每次可能差一两个像素（看当时的显示器缩放），
 * 差一行，哪里有湖、有没有地表岩浆湖就不一样了（rc9 跑关卡时碰到）。这一段除了固定种子，还把场景的大小固定成 248 × 196 格：
 * 窗口再怎么变，场景不跟着重建；测试自己调 applySize 换大小照常管用
 */
const WORLD_SIZE = [248, 196];
const FIX_WORLD = `(() => {
  ${FIX_SEED};
  const P = A.Scene.prototype;
  if (!P.__sizeFixed) {
    P.__sizeFixed = true;
    P.resize = function () { if (!this.W) this.applySize(${WORLD_SIZE[0]}, ${WORLD_SIZE[1]}); };
    P.resize2 = function () {};
  }
  const s = A.homeScene && A.homeScene();
  if (s) { clearTimeout(s._resizeT); s.seed = ${WORLD_SEED}; s.applySize(${WORLD_SIZE[0]}, ${WORLD_SIZE[1]}); }
  return 1;
})()`;

// 这次测试自己启动的程序：脚本中途出错退出时只关它们（按进程号），不留一个没人管的窗口
const started = new Set();
const track = (child) => { started.add(child); child.once('exit', () => started.delete(child)); return child; };

/**
 * 脚本中途抛错：把已经有的结果连同一条失败写进汇总再退出。
 * 以前这类脚本全部跑完才写结果，中途出错就一条都不写，run.js 又不看退出码，汇总里显示「失败 0」（rc9，实测过）
 */
function guard(results, label) {
  let done = false;
  const bail = (e) => {
    if (done) return;
    done = true;
    const row = { id: label, name: '脚本运行出错，没跑完', ok: false, detail: String((e && e.stack) || e).slice(0, 1500) };
    results.push(row);
    console.log(`FAIL [${row.id}] ${row.name} — ${row.detail.slice(0, 600)}`);
    if (process.env.AURORA_REGRESS_OUT) { try { fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8'); } catch { /* 写不了就靠退出码 */ } }
    for (const c of started) { try { c.kill(); } catch { /* 已退出 */ } }
    process.exit(1);
  };
  process.on('unhandledRejection', bail);
  process.on('uncaughtException', bail);
}

/**
 * 找一个空闲端口。不能写死：系统的临时端口范围可能从 1024 开始（这台机器 1024 到 15000），
 * 别的程序外连时随时可能占着写死的那个，调试接口绑不上（EACCES），测试看起来像程序起不来（2.0.0-pre2 碰到 9482）
 */
const freePort = () => new Promise((res, rej) => {
  const s = require('net').createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function connect(port, { tries = 240, ready = true } = {}) {
  let page = null;
  for (let i = 0; i < tries && !page; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = l.find((t) => t.type === 'page' && !/devtools/.test(t.url)); } catch { /* 还没起来 */ }
    if (!page) await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
  }
  if (!page) throw new Error(`连不上调试端口 ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
    for (const fn of listeners) fn(d);
  };
  ws.onclose = () => { for (const fn of wait.values()) fn({ error: { message: '调试连接断了' } }); wait.clear(); };
  const send = (method, params = {}, ms = 30000) => new Promise((res, rej) => {
    const k = ++id;
    const timer = setTimeout(() => { wait.delete(k); rej(new Error(`${method} 没有响应`)); }, ms);
    wait.set(k, (d) => { clearTimeout(timer); if (d.error) rej(new Error(d.error.message)); else res(d.result); });
    try { ws.send(JSON.stringify({ id: k, method, params })); } catch (e) { clearTimeout(timer); wait.delete(k); rej(e); }
  });
  const ev = async (js, ms = 60000) => {
    const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  if (ready) {
    for (let i = 0; i < 160; i++) {
      let ok = false;
      try { ok = await ev('!!(window.A && A.state && A.state.config && A.pages.home)'); } catch { /* 页面在加载 */ }
      if (ok) break;
      await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
    }
    await calm(ev);
  }
  return {
    ws, send, ev, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    /** 让程序自己退出（关所有窗口） */
    quit: async () => {
      try { await send('Browser.close', {}, 5000); } catch { /* 连接随之断开 */ }
      try { ws.close(); } catch { /* 已断开 */ }
    },
    close: () => { try { ws.close(); } catch { /* 已断开 */ } },
  };
}

/** 等子进程退出，到时限就只杀它自己（pid） */
async function waitExit(child, ms = 20000) {
  if (child.exitCode != null) return true;
  const gone = new Promise((res) => child.once('exit', () => res(true)));
  const r = await Promise.race([gone, sleep(ms).then(() => false)]);
  if (!r) { try { child.kill(); } catch { /* 已退出 */ } await Promise.race([gone, sleep(5000)]); }
  return r;
}

module.exports = { connect, waitExit, sleep, freePort, NO_THROTTLE, until, waitFor, need, calm, ready, guard, track, FIX_SEED, FIX_WORLD, WORLD_SEED, WORLD_SIZE };
