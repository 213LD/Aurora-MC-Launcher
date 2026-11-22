'use strict';
/**
 * 各页面截图基线（2.0.0-pre1）。重构时拿来对比有没有改出看得见的变化。
 *   node scripts/regress/baseline.js <输出文件夹>                     截图
 *   node scripts/regress/baseline.js <新文件夹> --compare=<基线文件夹>  截图并和基线比，列出变化大的
 * 动的东西都停掉：主页场景的画布隐藏，动画和过渡关掉，提示收起。比较在 Electron 里做（baseline-compare.js），不需要别的依赖。
 */
const { freePort, NO_THROTTLE, calm, waitExit } = require('./cdp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const OUT = args.find((a) => !a.startsWith('--'));
const compareTo = (args.find((a) => a.startsWith('--compare=')) || '').slice(10);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
if (!OUT) { console.error('用法：node scripts/regress/baseline.js <输出文件夹> [--compare=<基线文件夹>] [--only=组合,组合]'); process.exit(1); }

const { PAGES } = require('./pages'); // 页面清单只有一份（pages.js）
const CASES = [
  { name: 'aurora-dark', cfg: {} },
  { name: 'pixel-dark', cfg: { ui: { style: 'pixel' } } },
  { name: 'compact-dark', cfg: { ui: { style: 'compact' } } },
  { name: 'aurora-light', cfg: { theme: 'light' } },
  { name: 'aurora-contrast', cfg: { a11y: { contrast: 'on' } } },
  { name: 'aurora-zoom', cfg: { a11y: { zoom: 1.5 } } },
  { name: 'en', cfg: { language: 'en' } },
].filter((c) => !only || only.split(',').includes(c.name));

function seed(root, cfg) {
  fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data'); const game = path.join(root, 'game');
  const mk = (f, d = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
  const profile = (id, libs) => mk(path.join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: libs }));
  profile('ModP', [{ name: 'net.fabricmc:fabric-loader:0.15.0' }]);
  profile('Vanilla', []);
  // 配置列表按文件时间排序：时间固定，每次截图顺序才一样
  fs.utimesSync(path.join(game, 'versions', 'ModP', 'ModP.json'), 1700000200, 1700000200);
  fs.utimesSync(path.join(game, 'versions', 'Vanilla', 'Vanilla.json'), 1700000100, 1700000100);
  for (const j of ['a.jar', 'b.jar', 'c.jar.disabled']) mk(path.join(game, 'versions', 'ModP', 'mods', j));
  mk(path.join(game, 'versions', 'ModP', 'saves', 'World', 'level.dat'));
  fs.utimesSync(path.join(game, 'versions', 'ModP'), 1700000200, 1700000200);
  fs.utimesSync(path.join(game, 'versions', 'Vanilla'), 1700000100, 1700000100);
  mk(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: 'ModP', versionSettings: { ModP: { isolation: 'on' } }, ...cfg }));
  mk(path.join(data, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'a1', type: 'offline', name: 'BasePlayer', uuid: '00000000000000000000000000000001' }], selected: 'a1' }));
  return { data, game };
}

async function capture(c) {
  const port = await freePort();
  const root = path.join(process.env.AURORA_REGRESS_DIR || os.tmpdir(), `baseline-${c.name}`);
  const { data, game } = seed(root, c.cfg);
  const child = spawn(ELECTRON, [`--remote-debugging-port=${port}`, ...NO_THROTTLE, '.'], { cwd: REPO, stdio: 'ignore', windowsHide: true, env: { ...process.env, AURORA_DATA_DIR: data, AURORA_GAME_DIR: game, AURORA_TEST_TRASH: path.join(root, 'trash'), AURORA_SHOT_DIR: path.join(root, 'shots'), AURORA_SHOT_PAGES: '-#start', AURORA_SHOT_KEEP: '1', AURORA_SHOT_DELAY: '1500' } });
  let page = null;
  for (let i = 0; i < 120 && !page; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = l.find((t) => t.type === 'page' && !/devtools/.test(t.url)); } catch { /* 还没起来 */ } await sleep(500); }
  if (!page) { child.kill(); throw new Error('连不上调试端口'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const k = ++id; wait.set(k, (d) => res(d.result)); ws.send(JSON.stringify({ id: k, method, params })); });
  const ev = async (js) => { const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? null : r.result.value; };
  // 窗口大小固定，比较才有意义
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 80; i++) { if ((await ev('!!(window.A && A.state && A.state.config && A.pages.home && A.go)')) === true) break; await sleep(500); }
  await calm(ev);
  await ev(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } canvas { visibility: hidden !important; } .toast { display: none !important; } [class*="splash"], [class*="greet"], [class*="tip"] { visibility: hidden !important; }'; document.head.appendChild(s); })()`);
  const shots = [];
  for (const p of PAGES) {
    await ev(`A.go(${JSON.stringify(p)})`);
    await calm(ev, p === 'download' ? 15000 : 8000);
    // 还在转圈（Java 扫描、读列表）就再等等，不然两次截图不一样
    for (let i = 0; i < 40; i++) { if ((await ev(`!document.querySelector('#page-${p} .spinner')`)) === true) break; await sleep(300); }
    await calm(ev);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${c.name}-${p}.png`);
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    shots.push(file);
  }
  ws.close(); child.kill();
  await waitExit(child, 10000);
  return shots;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (const c of CASES) n += (await capture(c)).length;
  console.log(`截了 ${n} 张（${CASES.length} 种组合 × ${PAGES.length} 个页面）：${OUT}`);
  if (compareTo) {
    const r = spawnSync(ELECTRON, [path.join(__dirname, 'baseline-compare.js'), compareTo, OUT], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
    console.log((r.stdout || '').split(/\r?\n/).filter((l) => /^(对比|  )/.test(l)).join('\n'));
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
