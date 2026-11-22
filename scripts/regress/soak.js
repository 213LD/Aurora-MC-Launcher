'use strict';
/**
 * 挂机（2.0.0-pre2，接手以前人工测的部分）：一直开着，看内存、CPU、界面节点和监听器涨不涨。默认 15 分钟。
 *   node scripts/regress/soak.js <启动器 exe> <小时数，默认 0.25> <结果 jsonl>
 * 前半段每轮切一遍页面、开关弹窗；后半段在主页空闲。隔离目录，只看自己启动的进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { connect, waitExit, sleep, freePort, NO_THROTTLE, calm } = require('./cdp');

const [exe, hoursArg, outFile] = process.argv.slice(2);
const HOURS = Number(hoursArg) || 0.25;
const BASE = require('./editions').BASE;
const { PAGES } = require('./pages'); // 页面清单只有一份（pages.js）
const mk = (f, d = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };

const treeStats = (pid) => new Promise((res) => {
  // 只看这个进程和它的子进程
  const cmd = `$all = Get-CimInstance Win32_Process; $ids = New-Object System.Collections.ArrayList; [void]$ids.Add(${pid}); for ($i = 0; $i -lt 4; $i++) { foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } }; $ps = Get-Process -Id $ids -ErrorAction SilentlyContinue; "$(($ps | Measure-Object WorkingSet64 -Sum).Sum)|$(($ps | Measure-Object PrivateMemorySize64 -Sum).Sum)|$(($ps | Measure-Object CPU -Sum).Sum)|$(@($ps).Count)|$(($ps | Measure-Object HandleCount -Sum).Sum)"`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8', timeout: 60000 }, (err, out) => {
    const p = String(out || '').trim().split('|').map(Number);
    res(p.length >= 5 ? { wsMB: Math.round(p[0] / 1048576), privMB: Math.round(p[1] / 1048576), cpuSec: p[2], procs: p[3], handles: p[4] } : null);
  });
});

(async () => {
  const root = path.join(BASE, 'soak');
  fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data'); const game = path.join(root, 'game');
  for (let i = 0; i < 8; i++) {
    mk(path.join(game, 'versions', `P${i}`, `P${i}.json`), JSON.stringify({ id: `P${i}`, clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: i % 2 ? [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] : [] }));
    for (let j = 0; j < 30; j++) mk(path.join(game, 'versions', `P${i}`, 'mods', `m${j}.jar`));
  }
  mk(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: 'P1' }));
  const port = await freePort();
  const child = spawn(exe, [`--remote-debugging-port=${port}`, ...NO_THROTTLE], { stdio: 'ignore', windowsHide: true, env: { ...process.env, AURORA_DATA_DIR: data, AURORA_GAME_DIR: game } });
  const c = await connect(port);
  await c.send('Runtime.enable');
  await c.send('HeapProfiler.enable').catch(() => {});
  let exc = 0;
  c.on((d) => { if (d.method === 'Runtime.exceptionThrown') exc++; });
  const started = Date.now();
  const end = started + HOURS * 3600000;
  let lastCpu = null; let lastAt = Date.now();
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, '');
  let cycle = 0;
  const sceneRows = [];
  while (Date.now() < end) {
    const half = Date.now() < started + (HOURS * 3600000) / 2;
    if (half) {
      cycle++;
      for (const p of PAGES) { await c.ev(`A.go(${JSON.stringify(p)})`).catch(() => {}); await sleep(1500); }
      await c.ev("A.confirm('挂机测试', { title: '测试' }); 1").catch(() => {});
      await calm(c.ev);
      await c.ev("(() => { const b = document.querySelector('.modal-back:not(.closing) .modal-foot button'); if (b) b.click(); return 1; })()").catch(() => {});
      await c.ev("A.toast({ level: 'info', text: '挂机测试' }); A.go('home')").catch(() => {});
    } else await c.ev("A.go('home')").catch(() => {});
    await sleep(half ? 30000 : 60000); // pitfall-ok：挂机测试每隔这么久量一次，量的就是这段时间
    // 主页的场景还活着吗（rc15）：以前只量内存、CPU、节点，场景整个定住了也照样「通过」（生物活到寿命后消失不掉，挂机几分钟全部定住）。
    // 记：生物数、「正在消失」超过 3 秒的、3 秒里有几个在走
    const scene = await c.ev(`(async () => { const s = A.homeScene && A.homeScene(); if (!s || A.state.page !== 'home') return null; const now = performance.now();
      const seen = window.__soakFade || (window.__soakFade = new Map()); let stale = 0;
      for (const e of s.ents) if (e.fade) { if (!seen.has(e)) seen.set(e, now); else if (now - seen.get(e) > 3000) stale++; }
      const list = s.ents.slice(); const x0 = list.map((e) => e.x); await new Promise((r) => setTimeout(r, 3000));
      for (const e of list) if (e.fade && !seen.has(e)) seen.set(e, now);
      return { ents: s.ents.length, staleFade: stale, moving: list.filter((e, i) => Math.abs(e.x - x0[i]) > 1).length }; })()`, 20000).catch(() => null);
    if (scene) sceneRows.push({ phase: half ? 'cycle' : 'idle', ...scene });
    const st = await treeStats(child.pid);
    const heap = await c.send('Runtime.getHeapUsage').catch(() => null);
    const dom = await c.send('Memory.getDOMCounters').catch(() => null);
    const now = Date.now();
    const cpuPct = st && lastCpu != null ? +(((st.cpuSec - lastCpu) / ((now - lastAt) / 1000)) * 100 / os.cpus().length).toFixed(2) : null;
    if (st) { lastCpu = st.cpuSec; lastAt = now; }
    fs.appendFileSync(outFile, `${JSON.stringify({ min: Math.round((now - started) / 60000), phase: half ? 'cycle' : 'idle', cycle, ...st, cpuPct, scene: sceneRows[sceneRows.length - 1] || null, heapMB: heap ? Math.round(heap.usedSize / 1048576) : null, nodes: dom ? dom.nodes : null, listeners: dom ? dom.jsEventListeners : null, exc })}\n`);
    if (child.exitCode != null) { fs.appendFileSync(outFile, `${JSON.stringify({ exited: child.exitCode })}\n`); break; }
  }
  // 结论（rc15）：空闲在主页的那半段，每次都要有生物在走、没有「正在消失」超过 3 秒还没消失的
  const idle = sceneRows.filter((r) => r.phase === 'idle');
  const badScene = idle.filter((r) => r.staleFade > 0 || r.moving === 0);
  fs.appendFileSync(outFile, `${JSON.stringify({ verdict: idle.length && !badScene.length ? 'scene-alive' : 'scene-stuck', idleSamples: idle.length, bad: badScene.slice(0, 5) })}
`);
  await c.quit();
  await waitExit(child);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  process.exit(0);
})().catch((e) => { fs.appendFileSync(outFile, `${JSON.stringify({ error: e.message })}\n`); process.exit(1); });
