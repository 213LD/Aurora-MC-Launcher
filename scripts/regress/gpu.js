'use strict';
/**
 * 不同显卡下顺不顺（2026-11-07：用核显测一测低配置跑起来顺不顺）。关在隔离层里。
 *   node scripts/regress/gpu.js          启动器：默认（这台电脑上是核显）、强制独显、不用显卡（软件渲染，当作很差的电脑）
 *   node scripts/regress/gpu.js game     游戏：默认和用 SHIM_MCCOMPAT 让游戏走核显（要 AURORA_REGRESS_GAME_SRC、AURORA_REGRESS_JAVA_HOME）
 * 量：页面第一次画出来的时间、主页动画 10 秒的帧率和最长的一帧；游戏从点启动到进世界多久、是不是在独显上。只是记录，不算过不过。
 * 不改系统设置（显卡偏好、驱动设置都不动）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { start, BASE_CONFIG } = require('./robust-ui');
const { sleep } = require('./cdp');

const REPO = path.resolve(__dirname, '..', '..');
const VARIANTS = [
  { name: '默认（系统给的显卡）', args: [] },
  { name: '强制独显', args: ['--force_high_performance_gpu'] },
  { name: '不用显卡（软件渲染）', args: ['--disable-gpu'] },
  { name: '不用显卡 + 背景「低」档', args: ['--disable-gpu'], bg: { mobs: 5, range: 'small', fps: 20, fx: 'low' } },
];
const FPS = `new Promise((r) => { let n = 0; const t0 = performance.now(); let last = t0; const gaps = [];
  function f(t) { n++; gaps.push(t - last); last = t; if (t - t0 < 10000) requestAnimationFrame(f); else { gaps.sort((a, b) => b - a); r({ fps: +(n / ((t - t0) / 1000)).toFixed(1), worst: Math.round(gaps[0]), p99: Math.round(gaps[Math.floor(gaps.length * 0.01)] || 0), over50: gaps.filter((g) => g > 50).length }); } }
  requestAnimationFrame(f); })`;
const GPU = "(() => { try { const c = document.createElement('canvas').getContext('webgl'); const e = c.getExtension('WEBGL_debug_renderer_info'); return c.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch (x) { return '没有 WebGL：' + x.message; } })()";

async function launcherRuns() {
  const out = [];
  for (const v of VARIANTS) {
    const t0 = Date.now();
    const a = await start(`gpu-${out.length}`, { args: v.args, config: (game) => ({ ...BASE_CONFIG(game), background: { type: 'scene', fx: 'high', fps: 60, ...(v.bg || {}) } }) });
    if (a.startError) { out.push({ name: v.name, error: a.startError }); continue; }
    const ready = Date.now() - t0;
    await sleep(4000); // pitfall-ok：让背景先跑几秒再量（量的是跑起来以后的样子）
    const paint = await a.ev("JSON.stringify(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]))");
    const gpu = await a.ev(GPU);
    const fps = await a.ev(FPS, 20000);
    const advice = await a.ev("aurora.invoke('sys:bgAdvice').then((r) => r.data && r.data.tier)").catch(() => '');
    out.push({ name: v.name, gpu, readyMs: ready, paint, ...fps, advice, errors: a.errors.length });
    await a.stop();
  }
  for (const o of out) console.log(JSON.stringify(o));
}

async function gameRuns() {
  const SRC = process.env.AURORA_REGRESS_GAME_SRC;
  const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
  if (!SRC || !JAVA) { console.log('没设 AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME，跳过'); return; }
  process.env.AURORA_SANDBOX_SPAWN_ALLOW = '(javaw?\\.exe|taskkill(\\.exe)?)$';
  const WORLD = 'GpuWorld';
  const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已经没了 */ } };
  const onNvidia = () => { try { return /javaw?\.exe/i.test(execFileSync('nvidia-smi', [], { encoding: 'utf8' })); } catch { return null; } };
  const out = [];
  for (const v of [{ name: '游戏：默认', env: {} }, { name: '游戏：核显（SHIM_MCCOMPAT）', env: { SHIM_MCCOMPAT: '0x800000000' } }]) {
    for (const [k, x] of Object.entries(v.env)) process.env[k] = x;
    const prepare = ({ game: g }) => {
      for (const d of ['libraries', 'assets']) fs.symlinkSync(path.join(SRC, d), path.join(g, d), 'junction');
      fs.cpSync(path.join(SRC, 'versions', '1.20.1'), path.join(g, 'versions', '1.20.1'), { recursive: true });
      for (const n of fs.readdirSync(path.join(g, 'versions', '1.20.1'))) if (!/^1\.20\.1\.(json|jar)$/.test(n)) fs.rmSync(path.join(g, 'versions', '1.20.1', n), { recursive: true, force: true });
      fs.writeFileSync(path.join(g, 'options.txt'), 'onboardAccessibility:false\nsoundCategory_master:0.0\npauseOnLostFocus:false\nlang:en_us\n');
      fs.mkdirSync(path.join(g, 'saves'), { recursive: true });
      spawnSync(path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(__dirname, 'crash-game.js'), path.join(g, 'saves')], { env: { ...process.env, AURORA_REGRESS_DIR: path.join(path.dirname(g), 'mk') }, windowsHide: true, timeout: 60000 });
      fs.renameSync(path.join(g, 'saves', 'CrashWorld'), path.join(g, 'saves', WORLD));
    };
    const config = (g) => ({ ...BASE_CONFIG(g), selectedVersion: '1.20.1', afterLaunch: 'keep', restoreOnExit: false, gameArgs: `--quickPlaySingleplayer ${WORLD}`, java: { selected: path.join(JAVA, 'bin', 'javaw.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false } });
    const a = await start(`gpu-game-${out.length}`, { prepare, config });
    if (a.startError) { out.push({ name: v.name, error: a.startError }); continue; }
    await a.ev("aurora.invoke('accounts:addOffline', 'GpuPlayer')");
    const t0 = Date.now();
    const r = await a.ev("aurora.invoke('launch:start', '1.20.1', {})", 240000);
    let sec = null; let nv = null;
    if (r.ok) {
      for (let i = 0; i < 240; i++) {
        const log = await a.ev(`aurora.invoke('games:log', ${JSON.stringify(r.data.id)}).then((x) => x.data.map((l) => l.text).join('\\n'))`);
        if (/joined the game|logged in with entity id/.test(log)) { sec = Math.round((Date.now() - t0) / 100) / 10; break; }
        await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      await sleep(5000); // pitfall-ok：游戏在世界里跑 5 秒，量这段时间用的是哪块显卡
      nv = onNvidia();
      killTree(r.data.pid);
    }
    out.push({ name: v.name, enteredWorldSec: sec, onNvidia: nv, error: r.ok ? '' : r.error });
    await a.stop();
    for (const k of Object.keys(v.env)) delete process.env[k];
  }
  for (const o of out) console.log(JSON.stringify(o));
}

(async () => {
  if (process.argv[2] === 'game') await gameRuns();
  else await launcherRuns();
  process.exit(0);
})();
