'use strict';
/**
 * 接手以前人工测的部分：动画和观感、环境模拟、系统对话框、拖放、无障碍树、声音（2.0.0-pre2）。
 *   node scripts/regress/experience.js <输出文件夹> [场景,场景]
 * 场景：motion looks leak resize dpi nogpu throttle offline cnpath a11y dialogs drop sound
 * 量得出的（卡顿、闪烁、溢出、静音）判通过；好不好看要人看拼图：截图都放在输出文件夹。
 * 边界：全部用隔离目录；系统对话框用 UI 自动化接口操作，不动鼠标键盘；只关测试自己启动的进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { connect, waitExit, sleep, freePort, NO_THROTTLE, calm, until } = require('./cdp');

const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = process.argv[2] || path.join(BASE, 'experience');
const { PAGES } = require('./pages'); // 页面清单只有一份（pages.js）
// Node 24 的 rmSync 删中文目录时见过进程直接崩（0xC0000409），测试脚本一律用异步的
const rmrf = (p) => fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
const results = [];
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 500)}` : ''}`);
}
const info = (s) => console.log(`  ${s}`);
const mk = (f, d = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };

async function launch(name, { cfg = {}, args = [], dirs } = {}) {
  const port = await freePort();
  const root = dirs || path.join(BASE, 'exp', `${name}-${port}`);
  await rmrf(root);
  const data = path.join(root, 'data'); const game = path.join(root, 'game');
  const prof = (id, libs) => mk(path.join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: libs }));
  prof('ModP', [{ name: 'net.fabricmc:fabric-loader:0.15.0' }]);
  prof('Vanilla', []);
  for (const j of ['a.jar', 'b.jar']) mk(path.join(game, 'versions', 'ModP', 'mods', j));
  mk(path.join(game, 'versions', 'ModP', 'saves', 'World', 'level.dat'));
  mk(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: 'ModP', versionSettings: { ModP: { isolation: 'on' } }, ...cfg }));
  mk(path.join(data, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'a1', type: 'offline', name: 'ExpPlayer', uuid: '00000000000000000000000000000001' }], selected: 'a1' }));
  const child = spawn(ELECTRON, [`--remote-debugging-port=${port}`, ...NO_THROTTLE, ...args, '.'], {
    cwd: REPO, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, AURORA_DATA_DIR: data, AURORA_GAME_DIR: game, AURORA_TEST_TRASH: path.join(root, 'trash'), AURORA_SHOT_DIR: path.join(root, 'shots'), AURORA_SHOT_PAGES: '-#start', AURORA_SHOT_KEEP: '1', AURORA_SHOT_DELAY: '1500' },
  });
  const c = await connect(port);
  const errors = [];
  c.on((d) => {
    if (d.method === 'Runtime.exceptionThrown') errors.push(((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text || '').slice(0, 200));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 200));
  });
  await c.send('Runtime.enable');
  return { ...c, child, port, root, data, game, errors, stop: async () => { await c.quit(); await waitExit(child); await rmrf(root); } };
}
const shot = async (a, name, params = {}) => { fs.mkdirSync(OUT, { recursive: true }); const s = await a.send('Page.captureScreenshot', { format: 'png', ...params }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64')); };
const OVERFLOW = "(() => { const m = document.querySelector('.page.active') || document.body; const h = document.documentElement; return { pageX: h.scrollWidth > h.clientWidth + 1, active: m.id, tooWide: [...m.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 2 && getComputedStyle(e).position !== 'fixed' && !e.closest('[style*=\"overflow\"]') && !e.closest('.modal-back'); }).slice(0, 3).map((e) => e.className || e.tagName) }; })()";
const median = (l) => { if (!l.length) return 0; const s = [...l].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (l, p) => { if (!l.length) return 0; const s = [...l].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const WATCH = `(() => {
  const m = window.__m = { frames: [], shifts: 0, longs: 0, longMs: 0, muts: 0 };
  let last = performance.now();
  const tick = (t) => { if (window.__m !== m) return; m.frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  if (!window.__obs) {
    window.__obs = true;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.shifts += e.value; }).observe({ type: 'layout-shift' });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__m.longs++; window.__m.longMs += e.duration; } }).observe({ entryTypes: ['longtask'] });
    new MutationObserver((l) => { window.__m.muts += l.length; }).observe(document.documentElement, { subtree: true, childList: true });
  }
  return 1;
})()`;
const READ = '(() => { const m = window.__m; return { n: m.frames.length, frames: m.frames.slice(5), shifts: m.shifts, longs: m.longs, longMs: Math.round(m.longMs), muts: m.muts }; })()';

const SCENARIOS = {
  /** 动画：切页面、开关弹窗、空闲时有没有卡、闪、跳 */
  async motion() {
    const a = await launch('motion');
    try {
      const rows = [];
      for (const p of PAGES) {
        await a.ev(WATCH);
        const t0 = Date.now();
        await a.ev(`A.go(${JSON.stringify(p)})`);
        const goMs = Date.now() - t0;
        await sleep(1500); // pitfall-ok：量的就是切页面之后这 1.5 秒里的帧
        const sw = await a.ev(READ);
        await a.ev(WATCH);
        await sleep(3000); // pitfall-ok：量的就是空闲时这 3 秒里的帧
        const idle = await a.ev(READ);
        rows.push({ p, goMs, sw, idle });
        info(`${p.padEnd(9)} 切换 ${String(goMs).padStart(4)} ms，长任务 ${sw.longs}（${sw.longMs} ms），位移 ${sw.shifts.toFixed(3)}，帧 p95 ${Math.round(pct(sw.frames, 0.95))} ms；空闲 3 秒：DOM 变化 ${idle.muts}，长任务 ${idle.longs}，帧中位 ${Math.round(median(idle.frames))} ms`);
      }
      check('motion', '切页面都在 300 毫秒内响应', rows.every((r) => r.goMs < 300), rows.filter((r) => r.goMs >= 300).map((r) => `${r.p}:${r.goMs}`));
      check('motion', '切页面后内容不乱跳（累计位移小于 0.1）', rows.every((r) => r.sw.shifts < 0.1), rows.filter((r) => r.sw.shifts >= 0.1).map((r) => `${r.p}:${r.sw.shifts.toFixed(2)}`));
      check('motion', '空闲时页面不反复重建（3 秒内 DOM 变化少于 30 次）', rows.filter((r) => r.p !== 'home').every((r) => r.idle.muts < 30), rows.filter((r) => r.idle.muts >= 30).map((r) => `${r.p}:${r.idle.muts}`));
      check('motion', '空闲时没有长任务', rows.filter((r) => r.p !== 'home').every((r) => r.idle.longs === 0), rows.filter((r) => r.idle.longs).map((r) => `${r.p}:${r.idle.longs}`));
      // 弹窗开关：连续截帧看过程
      await a.ev("A.go('settings')");
      await calm(a.ev);
      await a.ev(WATCH);
      const frames = [];
      const off = a.on((d) => { if (d.method === 'Page.screencastFrame') { frames.push(d.params.data); a.send('Page.screencastFrameAck', { sessionId: d.params.sessionId }).catch(() => {}); } });
      await a.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
      await a.ev("A.confirm('这是一个测试弹窗，看开关动画。', { title: '动画测试' }); 1");
      await sleep(700); // pitfall-ok：录弹窗打开的动画，要录满动画的时长
      await a.ev("document.querySelector('.modal-back:not(.closing) .modal-foot button').click(); 1");
      await sleep(700); // pitfall-ok：录弹窗关上的动画，要录满动画的时长
      await a.send('Page.stopScreencast');
      off();
      const m = await a.ev(READ);
      fs.mkdirSync(OUT, { recursive: true });
      const pick = Array.from({ length: Math.min(12, frames.length) }, (_, i) => frames[Math.floor((i * frames.length) / Math.min(12, frames.length))]);
      pick.forEach((f, i) => fs.writeFileSync(path.join(OUT, `modal-frame-${String(i).padStart(2, '0')}.jpg`), Buffer.from(f, 'base64')));
      info(`弹窗开关：录到 ${frames.length} 帧，帧 p95 ${Math.round(pct(m.frames, 0.95))} ms，最长 ${Math.round(Math.max(0, ...m.frames))} ms，长任务 ${m.longs}`);
      check('motion', '弹窗开关动画不卡（最长一帧小于 100 毫秒）', Math.max(0, ...m.frames) < 100 && frames.length >= 5, { frames: frames.length, max: Math.round(Math.max(0, ...m.frames)) });
      // 转圈：动画一直在走，元素不被换掉
      const spin = await a.ev(`(async () => {
        const el = document.createElement('span'); el.className = 'spinner'; el.style.cssText = 'position:fixed;left:50%;top:50%;z-index:9999'; document.body.appendChild(el);
        const an = el.getAnimations()[0];
        const t0 = an ? an.currentTime : null;
        await new Promise((r) => setTimeout(r, 1200));
        const t1 = an ? an.currentTime : null;
        el.remove();
        return { hasAnimation: !!an, advanced: t1 - t0 };
      })()`);
      check('motion', '转圈动画一直在走', spin.hasAnimation && spin.advanced > 1000, spin);
      // 主页场景的帧率
      await a.ev("A.go('home')");
      await calm(a.ev);
      await a.ev(WATCH);
      await sleep(6000); // pitfall-ok：量的就是主页这 6 秒里的帧
      const home = await a.ev(READ);
      info(`主页场景 6 秒：帧中位 ${Math.round(median(home.frames))} ms，p95 ${Math.round(pct(home.frames, 0.95))} ms，p99 ${Math.round(pct(home.frames, 0.99))} ms，长任务 ${home.longs}（${home.longMs} ms）`);
      check('motion', '主页场景不卡（p95 小于 34 毫秒，约 30 帧）', pct(home.frames, 0.95) < 34, { median: median(home.frames), p95: pct(home.frames, 0.95) });
      check('motion', '整个过程没有脚本错误', !a.errors.length, a.errors.slice(0, 5));
    } finally { await a.stop(); }
  },

  /** 观感：所有场景、性能模式、简洁模式的样子，放到拼图里看 */
  async looks() {
    const a = await launch('looks');
    try {
      await a.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
      await calm(a.ev);
      const st = "(() => { const s = document.createElement('style'); s.textContent = '.toast { display:none !important; }'; document.head.appendChild(s); })()";
      await a.ev(st);
      const anomalies = [];
      for (const scene of ['plains', 'forest', 'desert', 'snowy', 'ocean', 'cherry', 'mushroom', 'darkforest', 'jungle', 'nether', 'end']) {
        for (const time of scene === 'nether' || scene === 'end' ? ['day'] : ['day', 'night']) {
          await a.ev(`(() => { const s = A.homeScene(); s.opts = { ...s.opts, scene: ${JSON.stringify(scene)}, time: ${JSON.stringify(time)}, buildings: true }; s.ents = []; s.cam = null; s.build(); return 1; })()`);
          await sleep(4000); // 让生物刷出来走一走 // pitfall-ok：截图前让生物刷出来走一会儿（要的是动起来的样子）
          await shot(a, `scene-${scene}-${time}`);
          // 量得出的悬空：站在地上的生物脚下一格是空的
          const bad = await a.ev(`(() => { const s = A.homeScene(); const out = []; for (const e of s.ents || []) { if (e.fly || e.flying || e.swim || e.inWater || e.dead || e.state === 'jump' || e.state === 'fall' || /tropical|squid|drowned|ghast|phantom|bat|bee|parrot|fish|dolphin|turtle|guardian|axolotl|allay|vex|blaze|salmon|cod|pufferfish/i.test(e.kind)) continue; const col = Math.floor(e.x / s.B); const top = s.colHeight(col); if (top > 900) continue; const feet = e.y / s.B; if (feet < top - 2.5) out.push(e.kind + '@' + col + ':' + feet.toFixed(1) + '/' + top); } return out.slice(0, 5); })()`);
          if (bad.length) anomalies.push(`${scene}/${time}: ${bad.join(' ')}`);
        }
      }
      info(`场景里脚下悬空超过 2.5 格的生物：${anomalies.length ? anomalies.join('；') : '没有'}`);
      await a.ev("(() => { const s = A.homeScene(); s.opts = { ...s.opts, scene: 'plains', time: 'day' }; s.cam = null; s.build(); return 1; })()");
      // 性能模式、简洁模式
      await a.ev('A.setConfig({ perfMode: true })');
      await calm(a.ev);
      for (const p of ['home', 'versions', 'settings']) { await a.ev(`A.go(${JSON.stringify(p)})`); await sleep(1000); await shot(a, `perf-${p}`); }
      await a.ev('A.setConfig({ perfMode: false })');
      await a.ev('A.setConfig({ simpleMode: true })'); // A.simple.set 会先弹确认框
      await calm(a.ev);
      for (const p of ['home', 'versions', 'settings']) { await a.ev(`A.go(${JSON.stringify(p)})`); await sleep(1000); await shot(a, `simple-${p}`); }
      check('looks', '所有场景和模式都能显示，没有脚本错误', !a.errors.length, a.errors.slice(0, 5));
    } finally { await a.stop(); }
  },

  /** 反复切页面、开关弹窗：强制 GC 后界面节点和监听器不涨（挂机时查出来的：任务页每进一次留下 38 个节点） */
  async leak() {
    const a = await launch('leak');
    try {
      await a.send('HeapProfiler.enable');
      for (const p of PAGES) { await a.ev(`A.go(${JSON.stringify(p)}); 1`); await sleep(800); }
      await a.ev("A.go('home'); 1");
      await calm(a.ev);
      const read = async () => { await a.send('HeapProfiler.collectGarbage'); await sleep(150); await a.send('HeapProfiler.collectGarbage'); return a.send('Memory.getDOMCounters'); }; // pitfall-ok：两次垃圾回收之间留一点时间，第二次才收得干净
      const before = await read();
      for (let i = 0; i < 5; i++) {
        for (const p of PAGES) { await a.ev(`A.go(${JSON.stringify(p)}); 1`); await sleep(150); }
        await a.ev("A.confirm('测试', { title: '测试' }); 1"); await calm(a.ev);
        await a.ev("(() => { const b = document.querySelector('.modal-back:not(.closing) .modal-foot button'); if (b) b.click(); return 1; })()"); await calm(a.ev);
      }
      await a.ev("A.go('home'); 1");
      await calm(a.ev);
      const after = await read();
      info(`切 5 轮页面：节点 ${before.nodes} → ${after.nodes}，监听器 ${before.jsEventListeners} → ${after.jsEventListeners}`);
      check('leak', '反复切页面、开关弹窗：节点和监听器不涨', after.nodes - before.nodes < 30 && after.jsEventListeners - before.jsEventListeners < 10, { nodes: [before.nodes, after.nodes], listeners: [before.jsEventListeners, after.jsEventListeners] });
    } finally { await a.stop(); }
  },

  /** 真的改窗口大小、最大化 */
  async resize() {
    const a = await launch('resize');
    try {
      const v = await (await fetch(`http://127.0.0.1:${a.port}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let id = 0; const wait = new Map();
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
      const bsend = (method, params = {}) => new Promise((res) => { const k = ++id; wait.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
      const list = await bsend('Target.getTargets');
      const target = (list.result.targetInfos || []).find((t) => t.type === 'page');
      const w = await bsend('Browser.getWindowForTarget', { targetId: target && target.targetId });
      if (!w.result || !w.result.windowId) { info(`拿不到窗口：${JSON.stringify(w).slice(0, 160)}，用视口模拟`); }
      const sizes = [[1000, 660], [1300, 800], [1920, 1040], 'maximized', 'normal'];
      const bad = [];
      for (const sz of sizes) {
        if (w.result && w.result.windowId) {
          await bsend('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: Array.isArray(sz) ? { windowState: 'normal', width: sz[0], height: sz[1] } : { windowState: sz } });
        } else if (Array.isArray(sz)) await a.send('Emulation.setDeviceMetricsOverride', { width: sz[0], height: sz[1], deviceScaleFactor: 1, mobile: false });
        await calm(a.ev);
        const real = await a.ev('[innerWidth, innerHeight]');
        for (const p of ['home', 'versions', 'settings', 'download']) {
          await a.ev(`A.go(${JSON.stringify(p)})`);
          await calm(a.ev);
          const o = await a.ev(OVERFLOW);
          if (o.pageX) bad.push(`${sz}/${p}`);
        }
        await a.ev("A.go('home')");
        await calm(a.ev);
        const label = Array.isArray(sz) ? `${sz[0]}x${sz[1]}` : sz;
        await shot(a, `resize-${label}`);
        info(`${label}：视口 ${real.join('×')}`);
      }
      try { ws.close(); } catch { /* */ }
      check('resize', '改窗口大小、最大化后页面没有横向溢出', !bad.length, bad);
      check('resize', '没有脚本错误', !a.errors.length, a.errors.slice(0, 5));
    } finally { await a.stop(); }
  },

  /** 高 DPI */
  async dpi() {
    for (const f of [1.25, 1.5, 2]) {
      const a = await launch(`dpi${f}`, { args: [`--force-device-scale-factor=${f}`] });
      try {
        const r = await a.ev('devicePixelRatio');
        const bad = [];
        for (const p of PAGES) {
          await a.ev(`A.go(${JSON.stringify(p)})`);
          await calm(a.ev);
          const o = await a.ev(OVERFLOW);
          if (o.pageX) bad.push(p);
        }
        await a.ev("A.go('home')"); await calm(a.ev);
        await shot(a, `dpi-${f}-home`);
        await a.ev("A.go('settings')"); await calm(a.ev);
        await shot(a, `dpi-${f}-settings`);
        check('dpi', `缩放 ${f * 100}%：比例生效，页面不溢出，没有脚本错误`, Math.abs(r - f) < 0.01 && !bad.length && !a.errors.length, { dpr: r, bad, errors: a.errors.slice(0, 3) });
      } finally { await a.stop(); }
    }
  },

  /** 没有 GPU */
  async nogpu() {
    const a = await launch('nogpu', { args: ['--disable-gpu'] });
    try {
      await calm(a.ev);
      await a.ev(WATCH);
      await sleep(6000); // pitfall-ok：量的就是这 6 秒里的帧
      const m = await a.ev(READ);
      const s = await a.ev('(() => { const s = A.homeScene(); return s ? { scene: s.sceneId, ents: (s.ents || []).length } : null; })()');
      await shot(a, 'nogpu-home');
      info(`没有 GPU：主页帧中位 ${Math.round(median(m.frames))} ms，p95 ${Math.round(pct(m.frames, 0.95))} ms，长任务 ${m.longs}`);
      const bad = [];
      for (const p of PAGES) { await a.ev(`A.go(${JSON.stringify(p)})`); await sleep(300); }
      check('nogpu', '没有 GPU 时能启动、能切页面、没有脚本错误', !!s && !bad.length && !a.errors.length, { s, errors: a.errors.slice(0, 3) });
      check('nogpu', '没有 GPU 时主页还能动', median(m.frames) < 200, { median: median(m.frames) });
    } finally { await a.stop(); }
  },

  /** 低配：CPU 降到六分之一 */
  async throttle() {
    const a = await launch('throttle');
    try {
      // 启动后空闲时会先把字体读进来（fontwarm.js，第一次读系统字体文件很慢）；量的是玩家看到主页以后再切页面的情况，等它做完
      const warmed = await until(a.ev, 'A.fontWarm && A.fontWarm.done', 20000);
      check('throttle', '启动后字体预热在 20 秒内做完', !!warmed);
      await a.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      const rows = [];
      for (const p of PAGES) {
        const t0 = Date.now();
        await a.ev(`A.go(${JSON.stringify(p)})`);
        rows.push([p, Date.now() - t0]);
        await calm(a.ev);
      }
      info(`CPU 六分之一，切页面耗时：${rows.map((r) => `${r[0]} ${r[1]}ms`).join('，')}`);
      await a.ev("A.go('home')");
      await calm(a.ev);
      await a.ev(WATCH);
      await sleep(6000); // pitfall-ok：量的就是这 6 秒里的帧
      const m = await a.ev(READ);
      info(`CPU 六分之一，主页帧中位 ${Math.round(median(m.frames))} ms，p95 ${Math.round(pct(m.frames, 0.95))} ms`);
      const quality = await a.ev('(() => { const s = A.homeScene(); return s ? { fx: s.opts.fx, range: s.opts.range } : null; })()');
      await a.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      // rc14 把方块图标改快、加了字体预热以后，最慢的页面从 1.3 ~ 2.1 秒降到 0.5 秒左右，门槛收到 1 秒（留一倍余量）
      check('throttle', 'CPU 六分之一时切页面都在 1 秒内', rows.every((r) => r[1] < 1000), rows.filter((r) => r[1] >= 1000));
      check('throttle', 'CPU 六分之一时没有脚本错误', !a.errors.length, { errors: a.errors.slice(0, 3), quality });
    } finally { await a.stop(); }
  },

  /** 断网 */
  async offline() {
    const a = await launch('offline', { args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
    try {
      await calm(a.ev);
      // 要联网才有用的页面断网时点不进去，只给提示；能进的页面，转圈最多 25 秒就要有结果
      const rows = [];
      for (const p of PAGES) {
        await a.ev(`A.go(${JSON.stringify(p)})`);
        await calm(a.ev);
        const entered = await a.ev('A.state.page') === p;
        let spin = 0;
        const t0 = Date.now();
        while (entered && Date.now() - t0 < 25000 && await a.ev(`!!document.querySelector('#page-${p} .spinner')`)) { spin = Date.now() - t0; await sleep(500); }
        rows.push({ p, entered, spinMs: spin, stuck: entered && await a.ev(`!!document.querySelector('#page-${p} .spinner')`), err: entered ? await a.ev(`(() => { const e = document.querySelector('#page-${p} .err'); return e ? e.innerText.slice(0, 120) : ''; })()`) : '' });
      }
      info(`断网时：${rows.map((r) => `${r.p}${r.entered ? (r.spinMs ? ` 转圈 ${r.spinMs} ms` : '') : ' 进不去'}${r.err ? `（${r.err}）` : ''}`).join('，')}`);
      await a.ev("A.go('settings')"); await calm(a.ev);
      await a.ev("A.go('download')"); await calm(a.ev);
      const toast = await a.ev("[...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | ')");
      await shot(a, 'offline-download');
      const st = await a.ev('A.offline ? (A.offline.on ? A.offline.on() : A.offline.state) : null');
      const r = await a.ev("A.api('versions:manifest', true).then(() => '成功了', (e) => A.errText(e))");
      info(`离线状态 ${JSON.stringify(st)}；点下载时的提示：${toast.slice(0, 120)}；读版本列表：${String(r).slice(0, 120)}`);
      check('offline', '断网时点要联网的页面会说明原因', /网络|联网|离线|断网/.test(toast), toast.slice(0, 120));
      check('offline', '断网时没有页面一直转圈', rows.every((x) => !x.stuck), rows.filter((x) => x.stuck).map((x) => x.p));
      check('offline', '断网的报错是看得懂的中文', /[一-鿿]/.test(String(r)) && !/ERR_|ENOTFOUND/.test(String(r)), r);
      const javaErr = rows.find((x) => x.p === 'java').err;
      check('offline', 'Java 页的报错说原因，不是错误码', /无法解析|网络/.test(javaErr) && !/ERR_/.test(javaErr), javaErr);
    } finally { await a.stop(); }
  },

  /** 慢网、下载中途断开、一直失败：起一个本地服务器，用主进程的下载器真的下（场景在 pre2.js 的 net-flaky） */

  /** 中文和带空格的路径 */
  async cnpath() {
    const dirs = path.join(BASE, 'exp', '玩家 名字（测试）', '我的 游戏 目录');
    const a = await launch('cnpath', { dirs });
    try {
      const s = await a.ev("(async () => ({ profiles: A.state.installed.map((v) => v.id).sort(), mods: (await A.api('mods:list', 'ModP')).mods.length, worlds: (await A.api('backup:worlds', 'ModP')).worlds.length }))()");
      const b = await a.ev("A.api('backup:create', 'ModP', { type: 'saves' }).then(() => 'ok', (e) => e.message)");
      const t = await a.ev("A.api('mods:toggle', A.state.installed.length && 'x', false).then(() => 'ok', () => 'skip')");
      const mp = await a.ev("(async () => { const l = (await A.api('mods:list', 'ModP')).mods; const r = await A.api('mods:toggle', l[0].path, false); return !!r; })()");
      check('cnpath', '中文和带空格的路径：配置、Mod、世界都读得到', s.profiles.length === 2 && s.mods === 2 && s.worlds === 1, s);
      check('cnpath', '中文和带空格的路径：备份和开关 Mod 都能用', b === 'ok' && mp === true, { b, mp, t });
      check('cnpath', '没有脚本错误', !a.errors.length, a.errors.slice(0, 3));
    } finally { await a.stop(); await rmrf(path.dirname(dirs)); }
  },

  /** 讲述人测不了，查无障碍树：按钮和输入框有没有名字，强制高对比度能不能看 */
  async a11y() {
    const a = await launch('a11y');
    try {
      await a.send('Accessibility.enable');
      const rows = [];
      const all = [];
      for (const p of PAGES) {
        await a.ev(`A.go(${JSON.stringify(p)})`);
        await calm(a.ev);
        const tree = await a.send('Accessibility.getFullAXTree', {}, 60000);
        const nodes = tree.nodes || [];
        const inter = nodes.filter((n) => !n.ignored && ['button', 'textbox', 'checkbox', 'combobox', 'link', 'switch', 'slider', 'radio', 'listbox', 'menuitem', 'tab'].includes(n.role && n.role.value));
        const noName = inter.filter((n) => !(n.name && String(n.name.value || '').trim()));
        rows.push({ p, total: inter.length, noName: noName.length });
        for (const n of noName.slice(0, 6)) all.push(`${p}:${n.role.value}`);
      }
      info(`可操作的元素和没有名字的：${rows.map((r) => `${r.p} ${r.noName}/${r.total}`).join('，')}`);
      const total = rows.reduce((n, r) => n + r.total, 0); const nameless = rows.reduce((n, r) => n + r.noName, 0);
      check('a11y', '按钮和输入框基本都有名字（没名字的少于 3%）', nameless / Math.max(total, 1) < 0.03, { total, nameless, eg: all.slice(0, 10) });
      // 强制高对比度（Windows 的对比度主题）和减少动画
      await a.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
      await a.ev("A.go('settings')"); await calm(a.ev);
      await shot(a, 'a11y-forced-colors-settings');
      await a.ev("A.go('home')"); await calm(a.ev);
      await shot(a, 'a11y-forced-colors-home');
      await a.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await calm(a.ev);
      const rm = await a.ev("matchMedia('(prefers-reduced-motion: reduce)').matches");
      check('a11y', '系统设置「减少动画」能被读到', rm === true, rm);
    } finally { await a.stop(); }
  },

  /** 真实的文件对话框：用 UI 自动化接口填路径、点按钮（不动鼠标键盘） */
  async dialogs() {
    const a = await launch('dialogs');
    const dir = path.join(BASE, 'exp', '对话框 测试');
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '选我 测试.txt');
    fs.writeFileSync(file, 'hello');
    const uia = (pid, value, button) => new Promise((res) => {
      // 窗口用 UIAutomation 找；底部的输入框和按钮是老式 Win32 控件，UIAutomation 不给操作，直接发窗口消息（不动键鼠）
      const script = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
}
'@
$A = [Windows.Automation.AutomationElement]
$root = $A::RootElement
$pc = New-Object Windows.Automation.PropertyCondition($A::ClassNameProperty, '#32770')
$win = $null
for ($i = 0; $i -lt 60 -and -not $win; $i++) {
  foreach ($w in $root.FindAll([Windows.Automation.TreeScope]::Children, $pc)) { if ($w.Current.ProcessId -eq ${pid}) { $win = $w; break } }
  if (-not $win) { Start-Sleep -Milliseconds 250 }
}
if (-not $win) { 'no-dialog'; exit }
$title = $win.Current.Name
function ById($id) { for ($k = 0; $k -lt 40; $k++) { $e = $win.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id))); if ($e) { return $e }; Start-Sleep -Milliseconds 100 }; return $null }
${value == null ? '' : `
$edit = [IntPtr]::Zero
foreach ($id in '1148', '1001', '1152') {
  $e = ById $id
  if (-not $e) { continue }
  $h = [IntPtr]$e.Current.NativeWindowHandle
  if ($e.Current.ClassName -eq 'Edit') { $edit = $h; break }
  $cb = [W32]::FindWindowEx($h, [IntPtr]::Zero, 'ComboBox', $null)
  $edit = [W32]::FindWindowEx($(if ($cb -ne [IntPtr]::Zero) { $cb } else { $h }), [IntPtr]::Zero, 'Edit', $null)
  if ($edit -ne [IntPtr]::Zero) { break }
}
if ($edit -eq [IntPtr]::Zero) { 'no-edit'; exit }
[void][W32]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $env:AURORA_DLG_VALUE)
Start-Sleep -Milliseconds 300
`}
$b = ById '${button}'
if (-not $b) { 'no-button'; exit }
# WM_COMMAND：窗口不在最前面时 BM_CLICK 不起作用。选文件夹时第一次是进到这个文件夹里，还开着就再点一次
$dlg = [IntPtr]$win.Current.NativeWindowHandle
for ($k = 0; $k -lt 4 -and [W32]::IsWindow($dlg); $k++) {
  [void][W32]::PostMessage($dlg, 0x0111, [IntPtr]${button}, [IntPtr]$b.Current.NativeWindowHandle)
  Start-Sleep -Milliseconds 900
}
"ok:$title"
`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { env: { ...process.env, AURORA_DLG_VALUE: value || '' }, windowsHide: true, encoding: 'utf8', timeout: 40000 }, (err, out) => res((out || (err && err.message) || '').trim()));
    });
    try {
      const pid = a.child.pid;
      const run = async (js, value, button) => {
        const p = a.ev(js, 30000).catch((e) => `没有结果：${e.message}`);
        const u = await uia(pid, value, button);
        const r = await p;
        return { r, u };
      };
      const open1 = await run("A.api('dialog:file', '选一个文件', [{ name: '文本', extensions: ['txt'] }], false)", file, '1');
      check('dialogs', '真实的选择文件对话框：填路径、点打开，选到带中文和空格的文件', JSON.stringify(open1.r).includes('选我 测试.txt') && open1.u.startsWith('ok'), open1);
      const cancel = await run("A.api('dialog:file', '选一个文件', [{ name: '文本', extensions: ['txt'] }], false)", null, '2');
      check('dialogs', '真实的选择文件对话框：点取消，什么都不选', (cancel.r == null || (Array.isArray(cancel.r) && !cancel.r.length)) && cancel.u.startsWith('ok'), cancel);
      // 选文件夹的「确定」发窗口消息点不动（只会进到文件夹里），这里只测打开和取消；选中之后走的代码和选文件一样
      const folder = await run("A.api('dialog:folder', '选一个文件夹')", null, '2');
      check('dialogs', '真实的选择文件夹对话框：能打开，点取消什么都不选', folder.r == null && folder.u.startsWith('ok'), folder);
      const target = path.join(dir, '存到这里 测试.txt');
      const save = await run(`A.api('dialog:save', '保存', '默认.txt', '内容 content')`, target, '1');
      check('dialogs', '真实的保存文件对话框：文件真的写出来了', String(save.r).includes('存到这里') && fs.existsSync(target) && fs.readFileSync(target, 'utf8') === '内容 content', { ...save, exists: fs.existsSync(target) });
    } finally { await a.stop(); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); } // Node 24 的 rmSync 在这里会让进程直接崩（0xC0000409）
  },

  /** 拖放：CDP 模拟（真人从资源管理器拖走的是系统的 OLE 拖放，这里从 Chromium 的拖放事件开始，后面的代码路径一样） */
  async drop() {
    const a = await launch('drop');
    const dir = path.join(BASE, 'exp', '拖放 测试');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const png = await a.ev("(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0, 0, 64, 64); return c.toDataURL('image/png').split(',')[1]; })()");
      const skin = path.join(dir, '我的 皮肤.png');
      fs.writeFileSync(skin, Buffer.from(png, 'base64'));
      const jar = path.join(dir, '拖进来的 mod.jar');
      fs.writeFileSync(jar, 'PK\u0005\u0006' + '\0'.repeat(18));
      const bad = path.join(dir, '不支持.exe');
      fs.writeFileSync(bad, 'x');
      const dropFile = async (file, x = 700, y = 420) => {
        const data = { items: [], files: [file], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) { await a.send('Input.dispatchDragEvent', { type, x, y, data }); await sleep(120); }
        await calm(a.ev);
      };
      await a.ev("A.go('mods', { versionId: 'ModP' })");
      await calm(a.ev);
      await a.ev("A.setConfig({ selectedVersion: 'ModP' })");
      await dropFile(jar);
      const mods = fs.readdirSync(path.join(a.game, 'versions', 'ModP', 'mods'));
      check('drop', '把 jar 拖到 Mod 页：装进当前配置', mods.some((n) => n.includes('拖进来的')), mods);
      await a.ev("document.querySelectorAll('.toast').forEach((t) => t.remove()); 1");
      await dropFile(bad);
      const t = await a.ev("[...document.querySelectorAll('.toast')].map((x) => x.innerText.replace(/\\s+/g, ' ').slice(0, 100))");
      const mods2 = fs.readdirSync(path.join(a.game, 'versions', 'ModP', 'mods'));
      check('drop', '把不支持的文件拖到 Mod 页：不会装进去', !mods2.some((n) => n.includes('不支持')), { toast: t, mods: mods2 });
      await a.ev("A.go('skins')");
      await calm(a.ev);
      const before = await a.ev("A.api('skins:library').then((l) => (l.skins || l.items || l).length).catch(() => -1)");
      await dropFile(skin);
      await until(a.ev, `A.api('skins:library').then((l) => (l.skins || l.items || l).length > ${before})`, 8000);
      const after = await a.ev("A.api('skins:library').then((l) => (l.skins || l.items || l).length).catch(() => -1)");
      check('drop', '把 png 拖到皮肤页：进皮肤库', after === before + 1, { before, after });
      check('drop', '没有脚本错误', !a.errors.length, a.errors.slice(0, 3));
    } finally { await a.stop(); await rmrf(dir); }
  },

  /** 声音：抓 Web Audio 的输出，判断有声、不爆音、音量和循环；好不好听判断不了 */
  async sound() {
    const a = await launch('sound', { args: ['--autoplay-policy=no-user-gesture-required'], cfg: { music: { enabled: false, volume: 0.6 } } });
    try {
      await a.ev(`(() => {
        const ctx = (A.music.state.ctx = A.music.state.ctx || null);
        const orig = AudioNode.prototype.connect;
        window.__tap = null;
        AudioNode.prototype.connect = function (dest, ...rest) {
          if (dest instanceof AudioDestinationNode) {
            const c = dest.context;
            if (!c.__tap) { const an = c.createAnalyser(); an.fftSize = 2048; orig.call(an, dest); c.__tap = an; window.__tap = an; }
            return orig.call(this, c.__tap, ...rest);
          }
          return orig.call(this, dest, ...rest);
        };
        window.__listen = async (ms) => {
          const an = window.__tap;
          if (!an) return { noTap: true };
          const buf = new Float32Array(an.fftSize);
          let sum = 0; let n = 0; let peak = 0; let clip = 0; let silent = 0; let chunks = 0; let longestSilent = 0; let curSilent = 0;
          const end = performance.now() + ms;
          while (performance.now() < end) {
            an.getFloatTimeDomainData(buf);
            let s = 0; for (const v of buf) { s += v * v; const m = Math.abs(v); if (m > peak) peak = m; if (m >= 0.999) clip++; }
            const r = Math.sqrt(s / buf.length);
            sum += r; n++; chunks++;
            if (r < 0.0005) { silent++; curSilent += 50; if (curSilent > longestSilent) longestSilent = curSilent; } else curSilent = 0;
            await new Promise((res) => setTimeout(res, 50));
          }
          return { rms: +(sum / Math.max(n, 1)).toFixed(4), peak: +peak.toFixed(3), clip, silentPct: Math.round((silent / Math.max(chunks, 1)) * 100), longestSilentMs: longestSilent };
        };
        return 1;
      })()`);
      const tracks = await a.ev('A.music.TRACKS.map((t) => ({ id: t.id, secs: Math.round(((t.beats || 48) / (t.bpm || 60)) * 60) }))');
      await a.ev('A.setConfig({ music: { enabled: true, volume: 0.6 } })');
      const rows = [];
      for (const t of tracks) {
        await a.ev(`A.music.play(${JSON.stringify(t.id)}, { quick: true })`);
        await sleep(600); // pitfall-ok：等音乐淡入
        const r = await a.ev('window.__listen(6000)', 30000);
        rows.push({ id: t.id, ...r, secs: t.secs });
        info(`${t.id.padEnd(10)} 平均音量 ${r.rms}，峰值 ${r.peak}，爆音采样 ${r.clip}，静音 ${r.silentPct}%（一轮约 ${t.secs} 秒）`);
      }
      check('sound', '每首音乐都有声音', rows.every((r) => r.rms > 0.001), rows.filter((r) => !(r.rms > 0.001)).map((r) => r.id));
      check('sound', '没有爆音（峰值不到满幅）', rows.every((r) => r.clip === 0), rows.filter((r) => r.clip).map((r) => `${r.id}:${r.clip}`));
      // 循环：听过一整轮加上接缝
      const shortest = [...tracks].sort((x, y) => x.secs - y.secs)[0];
      await a.ev(`A.music.play(${JSON.stringify(shortest.id)}, { quick: true })`);
      const loop = await a.ev(`window.__listen(${Math.min(shortest.secs + 8, 70) * 1000})`, 120000);
      info(`循环（${shortest.id}，${shortest.secs} 秒一轮）：最长一段静音 ${loop.longestSilentMs} ms，爆音 ${loop.clip}`);
      check('sound', '循环接缝没有断（静音不超过 1.5 秒）', loop.longestSilentMs < 1500 && loop.clip === 0, loop);
      // 音量
      await a.ev('A.music.setVolume(0.6)'); await sleep(800); // pitfall-ok：音量是慢慢变过去的，等它到位再听
      const hi = await a.ev('window.__listen(3000)');
      await a.ev('A.music.setVolume(0.15)'); await sleep(1200); // pitfall-ok：音量是慢慢变过去的，等它到位再听
      const lo = await a.ev('window.__listen(3000)');
      info(`音量：0.6 时 ${hi.rms}，0.15 时 ${lo.rms}`);
      check('sound', '音量调低，声音真的变小', lo.rms < hi.rms * 0.6, { hi: hi.rms, lo: lo.rms });
      await a.ev('A.setConfig({ music: { volume: 0.6 } })');
      // 游戏开始时暂停，结束后恢复
      const pauseState = "(() => { const s = A.music.state; return { playing: !!s.playing, suspended: s.ctx && s.ctx.state }; })()";
      const s0 = await a.ev(pauseState);
      await a.ev("(() => { const t = { id: 'fake-game', kind: 'launch', status: 'running', title: 'x', meta: {} }; A.state.tasks.set(t.id, t); A.emit('task', t); return 1; })()");
      await sleep(5000); // 音乐淡出，混响还有尾巴 // pitfall-ok：音乐淡出要这么久
      const during = await a.ev('window.__listen(1500)');
      await a.ev("(() => { const t = A.state.tasks.get('fake-game'); t.status = 'done'; A.emit('task', t); A.state.tasks.delete('fake-game'); return 1; })()");
      await sleep(2500); // pitfall-ok：游戏结束后音乐慢慢回来，等它淡入
      const after = await a.ev('window.__listen(1500)');
      info(`游戏任务：之前 ${JSON.stringify(s0)}，运行时音量 ${during.rms}，结束后 ${after.rms}`);
      check('sound', '游戏运行时音乐停，结束后恢复', during.rms < 0.001 && after.rms > 0.001, { during: during.rms, after: after.rms });
      await a.ev('A.music.stop && A.music.stop()');
    } finally { await a.stop(); }
  },
};

(async () => {
  const names = process.argv[3] ? process.argv[3].split(',') : Object.keys(SCENARIOS);
  for (const n of names) {
    console.log(`=== ${n} ===`);
    try { await SCENARIOS[n](); } catch (e) { check(n, '脚本出错', false, (e.stack || e.message).slice(0, 400)); }
  }
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
