'use strict';
/**
 * 内存泄漏（2.0.0-pre8，全面测试高优先级第 1 项）。不只切页面：每种操作循环很多遍，每轮强制 GC 后量渲染进程和主进程，看后半段还涨不涨。
 *   node scripts/regress/leak.js [场景,场景]
 * 量的是：DOM 节点、事件监听器、JS 堆（渲染进程）；JS 堆、外部内存（主进程）。
 * 启动器关在 sandbox-run.js 的隔离层里。真进游戏的循环（game）要 AURORA_REGRESS_GAME_SRC 和 AURORA_REGRESS_JAVA_HOME，没设就跳过。
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { start, fakeVersion } = require('./robust-ui');
const { sleep, calm } = require('./cdp');

const BASE = require('./editions').BASE;
const OUT = process.env.AURORA_REGRESS_OUT;
const results = [];
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}

async function measure(a) {
  await a.send('HeapProfiler.collectGarbage');
  await sleep(120); // pitfall-ok：两次垃圾回收之间留一点时间，第二次才收得干净
  await a.send('HeapProfiler.collectGarbage');
  const dom = await a.send('Memory.getDOMCounters');
  const heap = await a.send('Runtime.getHeapUsage');
  const main = await a.ev("aurora.invoke('debug:__mainStats').then((r) => r.data)");
  return { nodes: dom.nodes, listeners: dom.jsEventListeners, docs: dom.documents, heap: heap.usedSize, mainHeap: main.heapUsed, mainExt: main.external + main.arrayBuffers, tasks: main.tasks, games: main.games };
}

/** 跑 cycles 轮。前 warm 轮是预热（缓存、懒加载），之后每轮的平均增长要低于上限 */
async function loop(a, label, cycles, fn, { warm = 3, limit = {} } = {}) {
  const max = { nodes: 8, listeners: 3, heap: 60 * 1024, mainHeap: 60 * 1024, mainExt: 200 * 1024, ...limit };
  const series = [];
  for (let i = 0; i < cycles; i++) {
    await fn(i);
    series.push(await measure(a));
  }
  const first = series[Math.min(warm, series.length - 1)];
  const last = series[series.length - 1];
  const n = Math.max(1, series.length - 1 - Math.min(warm, series.length - 1));
  const slope = {};
  for (const k of ['nodes', 'listeners', 'heap', 'mainHeap', 'mainExt']) slope[k] = Math.round((last[k] - first[k]) / n);
  const over = Object.keys(max).filter((k) => slope[k] > max[k]);
  const text = `节点 ${first.nodes}→${last.nodes}，监听器 ${first.listeners}→${last.listeners}，界面堆 ${(first.heap / 1048576).toFixed(1)}→${(last.heap / 1048576).toFixed(1)} MB，主进程堆 ${(first.mainHeap / 1048576).toFixed(1)}→${(last.mainHeap / 1048576).toFixed(1)} MB，主进程外部 ${(first.mainExt / 1048576).toFixed(1)}→${(last.mainExt / 1048576).toFixed(1)} MB，任务 ${last.tasks}，游戏 ${last.games}`;
  check('泄漏', `${label}（${cycles} 轮）：每轮不再涨`, over.length === 0, `${text}${over.length ? `；超标：${over.map((k) => `${k} 每轮 ${slope[k]}`).join('，')}` : ''}`);
  fs.appendFileSync(path.join(BASE, 'leak-series.jsonl'), `${JSON.stringify({ label, series })}\n`);
}

const closeAll = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove()); 1";

function fixture({ game }) {
  for (let i = 0; i < 6; i++) {
    const d = fakeVersion(game, `P${i}`, { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] });
    for (let j = 0; j < 20; j++) fs.writeFileSync(path.join(d, 'mods', `m${j}.jar`), 'x');
    fs.mkdirSync(path.join(d, 'saves', 'W1'), { recursive: true });
    fs.writeFileSync(path.join(d, 'saves', 'W1', 'level.dat'), 'x');
  }
}
const CFG = (game) => {
  const versionSettings = {};
  for (let i = 0; i < 6; i++) versionSettings[`P${i}`] = { isolation: 'on' };
  return { disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: 'P0', migrateAsk: true, versionSettings, music: { enabled: false } };
};

const SCENARIOS = {
  /** 下载：真实的下载器和任务引擎，每轮 30 个文件 */
  async downloads() {
    const body = Buffer.alloc(256 * 1024, 7);
    const server = http.createServer((_q, r) => { r.setHeader('content-length', body.length); r.end(body); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/f`;
    const a = await start('leak-dl', { prepare: fixture, config: CFG, stats: true });
    await a.ev("A.go('tasks')");
    await loop(a, '下载（30 个文件，任务页开着）', 25, async () => {
      await a.ev(`aurora.invoke('debug:__download', ${JSON.stringify(url)}, 30)`, 60000);
      await sleep(300); // pitfall-ok：每一轮之间留一点时间，让定时器、缓存照常过期（量内存的节奏，不是在等某件事）
    }, { limit: { mainHeap: 80 * 1024 } });
    await a.ev("aurora.invoke('tasks:clear')");
    await a.stop();
    server.close();
  },

  /** 任务越积越多（玩家从来不点清除）：主进程和任务页都不能一直涨 */
  async 'tasks-pile'() {
    const body = Buffer.alloc(1024, 7);
    const server = http.createServer((_q, r) => { r.end(body); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/f`;
    const a = await start('leak-tasks', { prepare: fixture, config: CFG, stats: true });
    for (let i = 0; i < 400; i++) await a.ev(`aurora.invoke('debug:__download', ${JSON.stringify(url)}, 1)`, 20000);
    const m = await measure(a);
    check('泄漏', '做完 400 个任务不清除：留着的任务有上限', m.tasks <= 210, `留了 ${m.tasks} 个`);
    await a.stop();
    server.close();
  },

  /** 日志窗口：反复开关，每轮 3000 行日志；还有一局一局累积的旧日志 */
  async logs() {
    const a = await start('leak-logs', { prepare: fixture, config: CFG, stats: true });
    const lines = Array.from({ length: 3000 }, (_, i) => ({ text: `[12:00:00] [Render thread/INFO]: 这是第 ${i} 行日志 ${'x'.repeat(100)}`, level: 'info', t: i }));
    await a.ev('A.state.games.set("leak-game", { id: "leak-game", versionId: "P0", state: "running", startedAt: Date.now() }); 1');
    await loop(a, '日志窗口开关 + 同一局 3000 行', 20, async () => {
      await a.ev('A.logs.open("leak-game"); 1');
      await a.ev(`aurora.invoke('debug:__gameLog', 'leak-game', ${JSON.stringify(lines)})`, 30000);
      await calm(a.ev);
      await a.ev('A.logs.close(); 1');
      await calm(a.ev);
    }, { limit: { heap: 200 * 1024 } });
    // 一局一局累积：每局留 3000 行，放了 40 局
    const before = await measure(a);
    for (let i = 0; i < 40; i++) {
      await a.ev(`aurora.invoke('debug:__gameLog', 'old-game-${i}', ${JSON.stringify(lines.slice(0, 3000))})`, 30000);
      await a.ev(`A.state.games.set("old-game-${i}", { id: "old-game-${i}", versionId: "P0", state: "exited", startedAt: ${i} }); 1`);
    }
    await calm(a.ev);
    const after = await measure(a);
    const grew = (after.heap - before.heap) / 1048576;
    check('泄漏', '40 局的旧日志：不会一直留在内存里（40 局 × 3000 行约 40 MB）', grew < 20, `界面堆涨了 ${grew.toFixed(1)} MB`);
    await a.stop();
  },

  /** 皮肤页：3D 预览反复开关 */
  async skins() {
    const a = await start('leak-skins', { prepare: fixture, config: CFG, stats: true });
    await a.ev("A.go('skins')");
    await calm(a.ev);
    await loop(a, '皮肤预览开关', 25, async () => {
      await a.ev(`(() => { const v = A.skinView({ model: 'default', size: 200 }); document.body.append(v.el); window.__v = v; return 1; })()`);
      await calm(a.ev);
      await a.ev('window.__v.el.remove(); window.__v = null; 1');
      await calm(a.ev);
    });
    await loop(a, '皮肤页进出', 15, async () => {
      await a.ev("A.go('home')");
      await calm(a.ev);
      await a.ev("A.go('skins')");
      await calm(a.ev);
    });
    await a.stop();
  },

  /** 日志中心（rc9）：每次回到页面都重新读选中的那一局（3000 行），上一次的内容要放掉 */
  async logcenter() {
    const a = await start('leak-logcenter', {
      prepare: (ctx) => {
        fixture(ctx);
        const dir = path.join(ctx.data, 'logs', 'games');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'big.log'), `${Array.from({ length: 5000 }, (_, i) => `[12:00:00] [Render thread/INFO]: line ${i} ${'x'.repeat(80)}`).join('\n')}\n`);
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items: [{ id: 'big', file: 'big.log', versionId: 'P0', startedAt: Date.now() - 3600000, endedAt: Date.now() - 1800000, state: 'exited', exitCode: 0 }] }));
      },
      config: (game) => ({ ...CFG(game), background: { type: 'gradient' }, logs: { keepDays: 0 } }),
      stats: true,
    });
    await loop(a, '日志中心进出（每次重新读 3000 行）', 15, async () => {
      await a.ev("A.go('logs')");
      await calm(a.ev);
      await a.ev("A.go('home')");
      await calm(a.ev);
    }, { limit: { heap: 200 * 1024 } });
    await a.stop();
  },

  /** Mod 配置器：进出、建方案、搜索（网络被隔离，走失败路径）、删除 */
  async planner() {
    const a = await start('leak-planner', { prepare: fixture, config: CFG, stats: true });
    await loop(a, 'Mod 配置器进出 + 保存和删除方案', 25, async (i) => {
      await a.ev("A.go('planner')");
      await calm(a.ev);
      await a.ev(`aurora.invoke('planner:save', { id: 'leak${i}', name: '方案', mc: '1.20.1', items: [] })`);
      await a.ev(`aurora.invoke('planner:delete', 'leak${i}')`);
      await a.ev("A.go('home')");
      await calm(a.ev);
    });
    await a.stop();
  },

  /** 弹窗和菜单：配置抽屉、确认框、下拉、提示 */
  async dialogs() {
    const a = await start('leak-dialogs', { prepare: fixture, config: CFG, stats: true });
    await a.ev("A.go('versions')");
    await calm(a.ev);
    await loop(a, '确认框、提示、弹窗开关', 40, async () => {
      await a.ev(`(async () => {
        A.confirm('测试', { title: '测试' });
        await new Promise((r) => setTimeout(r, 40));
        const b = document.querySelector('.modal-back:not(.closing) .modal-foot button'); if (b) b.click();
        A.toast({ level: 'info', text: '测试 ' + Math.random() });
        await new Promise((r) => setTimeout(r, 40));
        A.dismissToasts && A.dismissToasts();
        return 1;
      })()`);
      await calm(a.ev);
      await a.ev(closeAll);
    });
    await a.stop();
  },

  /** 真进游戏（要环境变量）：启动、进主菜单、关掉，循环几遍 */
  async game() {
    const SRC = process.env.AURORA_REGRESS_GAME_SRC;
    const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
    if (!SRC || !JAVA) { console.log('  没设 AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME，跳过'); return; }
    process.env.AURORA_SANDBOX_SPAWN_ALLOW = '(javaw?\\.exe|taskkill(\\.exe)?)$';
    const a = await start('leak-game', {
      stats: true,
      prepare: ({ game }) => {
        // 库和资源只读，用联接省掉复制几个 GB；版本目录要写 natives，复制一份
        for (const d of ['libraries', 'assets']) fs.symlinkSync(path.join(SRC, d), path.join(game, d), 'junction');
        fs.cpSync(path.join(SRC, 'versions', '1.20.1'), path.join(game, 'versions', '1.20.1'), { recursive: true });
        fs.writeFileSync(path.join(game, 'options.txt'), 'onboardAccessibility:false\nsoundCategory_master:0.0\nsoundCategory_music:0.0\npauseOnLostFocus:false\nlang:en_us\n');
      },
      config: (game) => ({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: '1.20.1', isolation: 'none', afterLaunch: 'keep', restoreOnExit: false, java: { selected: path.join(JAVA, 'bin', 'javaw.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false } }),
    });
    await a.ev("aurora.invoke('accounts:addOffline', 'LeakPlayer')");
    await loop(a, '真进游戏再退出', 7, async () => {
      const r = await a.ev("aurora.invoke('launch:start', '1.20.1', {})", 180000);
      if (!r.ok) throw new Error(`启动失败：${r.error}`);
      const id = r.data.id;
      for (let i = 0; i < 90; i++) {
        const st = await a.ev(`aurora.invoke('games:list').then((x) => (x.data.find((g) => g.id === ${JSON.stringify(id)}) || {}).state)`);
        if (st === 'running') break;
        await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      await sleep(4000); // pitfall-ok：让游戏跑一会儿再关（量的是一局游戏前后的内存）
      await a.ev(`aurora.invoke('games:kill', ${JSON.stringify(id)})`);
      for (let i = 0; i < 30; i++) {
        const st = await a.ev(`aurora.invoke('games:list').then((x) => (x.data.find((g) => g.id === ${JSON.stringify(id)}) || {}).state)`);
        if (st === 'exited') break;
        await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
      }
      await calm(a.ev);
    }, { warm: 2, limit: { heap: 300 * 1024, mainHeap: 300 * 1024, nodes: 30, listeners: 6 } });
    const m = await measure(a);
    check('泄漏', '结束的游戏留在内存里的有上限', m.games <= 10, `留了 ${m.games} 局`);
    await a.stop();
    delete process.env.AURORA_SANDBOX_SPAWN_ALLOW;
  },
};

(async () => {
  const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENARIOS);
  fs.mkdirSync(BASE, { recursive: true });
  fs.rmSync(path.join(BASE, 'leak-series.jsonl'), { force: true });
  for (const name of pick) {
    console.log(`\n=== leak ${name} ===`);
    const t0 = Date.now();
    try { await SCENARIOS[name](); } catch (e) { check(name, '脚本运行出错', false, e.stack || String(e)); }
    console.log(`  用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  }
  if (OUT) fs.appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
