'use strict';
/**
 * 存档的「随机操作序列」测试（rc10）。
 * 以前存档相关的测试都是一个场景一个场景写的：只守得住想到过的那几种先后顺序。
 * 这里不想场景：用固定种子的随机数，把「切成独立存档 / 切成共享存档 / 改名 / 复制配置 / 删进回收站 / 新开一个世界」
 * 随机排成很长的一串，走和界面一样的接口，每做一步就查一条不变的规矩：
 *     玩家的每一个世界，都还在硬盘上的某个地方（配置里、公共目录里、暂存里、回收站里），内容没变。
 * 操作可以被拒绝（改名重名、配置不存在），但不能弄丢世界，也不能抛出没处理的错误。
 *   electron scripts/regress/saves-fuzz.js all
 * 种子是固定的，失败了能原样重跑；报告里带着出问题之前的那几步。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const H = require('./harness');

const { setup, core, ipc, fakeVersion, check, finish } = H;
const SEEDS = [11, 23, 37, 59];
const STEPS = 60;

function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

/** root 下面所有的 level.dat：内容 → 在哪 */
async function worldsOnDisk(root) {
  const found = new Map();
  const walk = async (d, depth) => {
    if (depth > 9) return;
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue; // 联接指向的东西会在它真正的位置被数到
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name === 'level.dat') { const t = await fsp.readFile(p, 'utf8').catch(() => ''); if (!found.has(t)) found.set(t, path.relative(root, p)); }
    }
  };
  await walk(root, 0);
  return found;
}

app.whenReady().then(async () => {
  try {
    for (const seed of SEEDS) {
      const { root, game } = setup(`saves-fuzz-${seed}`);
      process.env.AURORA_TEST_TRASH = path.join(root, 'trash');
      await fsp.mkdir(process.env.AURORA_TEST_TRASH, { recursive: true });
      const config = core('config');
      config.load();
      config.set({ gameDir: game });
      const versions = core('versions');
      const bus = ipc();
      const rnd = rng(seed);
      const pickOf = (a) => a[Math.floor(rnd() * a.length)];
      let nWorld = 0;
      let nName = 0;
      const prints = new Set();
      const live = [];
      const makeWorld = async (savesDir) => {
        const fp = `world-${seed}-${++nWorld}`;
        const dir = path.join(savesDir, `W${nWorld}`);
        await fsp.mkdir(path.join(dir, 'region'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'level.dat'), fp);
        await fsp.writeFile(path.join(dir, 'region', 'r.0.0.mca'), `${fp}-region`);
        prints.add(fp);
      };
      const savesOf = async (id) => { const info = await versions.versionInfo(id); return path.join(versions.gameDirFor(id, info), 'saves'); };
      // 开局：公共目录里一个世界，三个配置各一个世界
      await makeWorld(path.join(game, 'saves'));
      for (const id of ['A', 'B', 'C']) { await fakeVersion(id); live.push(id); await makeWorld(await savesOf(id)); }

      const OPS = {
        async own(id) { return bus.call('isolation:set', id, { preset: 'isolated' }); },
        async shared(id) { return bus.call('isolation:set', id, { preset: 'shared', source: '@root' }); },
        async rename(id) { const to = `R${++nName}`; const r = await bus.call('versions:rename', id, to); if (r.ok) live[live.indexOf(id)] = to; return r; },
        async duplicate(id) { const to = `D${++nName}`; const r = await bus.call('profiles:duplicate', id, to, {}); if (r.ok) live.push(to); return r; },
        async trash(id) { if (live.length <= 1) return { ok: true, skipped: true }; const r = await bus.call('versions:remove', id, { permanent: false }); if (r.ok) live.splice(live.indexOf(id), 1); return r; },
        async play(id) { await makeWorld(await savesOf(id)); return { ok: true }; },
      };
      const names = Object.keys(OPS);
      const trail = [];
      let lost = null;
      let crashed = null;
      const refused = {};
      for (let step = 0; step < STEPS && !lost && !crashed; step++) {
        const op = pickOf(names);
        const id = pickOf(live);
        let r;
        try { r = await OPS[op](id); } catch (e) { crashed = `${op}(${id})：${e.stack || e}`; break; }
        trail.push(`${op}(${id})${r.ok ? '' : `✗${(r.reason && r.reason.code) || ''}`}`);
        if (!r.ok) {
          refused[op] = (refused[op] || 0) + 1;
          // 被拒绝可以，但得是说得清的拒绝：不能是没处理的程序错误
          if (/TypeError|ReferenceError|Cannot read|is not a function|undefined/.test(String(r.error))) { crashed = `${op}(${id})：${r.error}`; break; }
        }
        const disk = await worldsOnDisk(root);
        const missing = [...prints].filter((fp) => !disk.has(fp));
        if (missing.length) lost = { step, op: `${op}(${id})`, missing, error: r.ok ? '' : String(r.error).slice(0, 120), before: trail.slice(-8) };
      }
      const done = trail.length;
      const kinds = new Set(trail.map((x) => x.split('(')[0]));
      check('存档', `种子 ${seed}：随机 ${done} 步（切独立、切共享、改名、复制、删进回收站、开新世界），${prints.size} 个世界一个都没丢`, !lost && !crashed && done >= STEPS - 1, lost || crashed || `被拒绝的：${JSON.stringify(refused)}`);
      check('存档', `种子 ${seed}：六种操作都走到了，没有抛出没处理的错误`, kinds.size === names.length && !crashed, crashed || [...kinds].join(' '));
    }
  } catch (e) {
    check('脚本', '脚本运行出错', false, e.stack || String(e));
  }
  finish();
});
app.on('window-all-closed', () => {});
