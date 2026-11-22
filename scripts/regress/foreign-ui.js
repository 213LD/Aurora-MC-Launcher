'use strict';
/**
 * 从其他启动器导入：真实窗口和真进游戏（2.0.0-pre10）。关在隔离层里。
 *   node scripts/regress/foreign-ui.js [ui,game]
 * - ui    导入窗口走一遍：找到其他启动器、列出配置、选方式、提示、开始导入；3 种风格、明暗、1.5 倍、高对比度、英文都截图
 * - game  真的进游戏（要 AURORA_REGRESS_GAME_SRC、AURORA_REGRESS_JAVA_HOME）：复制导入后进世界；引用原目录后进世界，存档写在原来的文件夹
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { start, BASE_CONFIG, fakeVersion } = require('./robust-ui');
const { sleep, until, calm, waitFor } = require('./cdp');

const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const OUT = process.env.AURORA_REGRESS_OUT;
const SHOTS = process.env.AURORA_FOREIGN_SHOTS || path.join(BASE, 'foreign-shots');
const results = [];
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 500)}` : ''}`);
}
const mk = (f, t = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const J = (id, extra = {}) => JSON.stringify({ id, type: 'release', clientVersion: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: [], ...extra });
const prepareHome = ({ root }) => {
  const hm = path.join(root, 'fakehome', 'Desktop', 'HMCL', '.minecraft');
  mk(path.join(root, 'fakehome', 'Desktop', 'HMCL', 'HMCL-3.6.exe'));
  mk(path.join(hm, 'versions', 'HM Fabric', 'HM Fabric.json'), J('HM Fabric', { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] }));
  mk(path.join(hm, 'versions', 'HM Fabric', 'hmclversion.cfg'), JSON.stringify({ gameDirType: 1 }));
  mk(path.join(hm, 'versions', 'HM Fabric', 'saves', 'HM World', 'level.dat'), 'world');
  mk(path.join(hm, 'versions', 'HM Fabric', 'mods', 'a.jar'), Buffer.alloc(300000));
  mk(path.join(hm, 'versions', 'Plain 1.20.1', 'Plain 1.20.1.json'), J('Plain 1.20.1'));
  mk(path.join(hm, 'saves', 'Root World', 'level.dat'), 'world');
  const pr = path.join(root, 'fakehome', 'AppData', 'Roaming', 'PrismLauncher', 'instances', 'Prism Pack');
  mk(path.join(pr, 'instance.cfg'), '[General]\nname=Prism Pack\n');
  mk(path.join(pr, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.15.0' }] }));
  mk(path.join(pr, '.minecraft', 'saves', 'P World', 'level.dat'), 'world');
};

const clickText = (a, text, sel = '.modal-back button') => a.ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.offsetParent && x.innerText.includes(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);
async function shot(a, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}
/** 打开到「配置列表」这一步 */
async function openList(a) {
  await a.ev('A.migrateUi.importDialog(); 1');
  await calm(a.ev);
  const card = await a.ev("(() => { const b = [...document.querySelectorAll('.modal-back .mg-card')].pop(); if (b) b.click(); return !!b; })()");
  await calm(a.ev);
  return card;
}

const SCENARIOS = {
  async ui() {
    const a = await start('foreign-ui', { prepare: prepareHome });
    if (a.startError) { check('界面', '能打开', false, a.startError); return; }
    await a.ev('document.querySelectorAll(".modal-back").forEach((m) => m.remove()); 1');
    check('界面', '「其他启动器」不再是正在开发，能点', await openList(a));
    const text = await a.ev('document.querySelector(".modal-back").innerText');
    check('界面', '找到了 HMCL 和 Prism，官方的没有就不列', /HMCL/.test(text) && /Prism/.test(text) && /2 个配置/.test(text), text.slice(0, 300));
    await clickText(a, 'HMCL', '.modal-back .mg-cand');
    await calm(a.ev);
    const list = await a.ev('document.querySelector(".modal-back").innerText');
    check('界面', '列出配置、世界数、Mod 数、复制大小、磁盘剩余', /HM Fabric/.test(list) && /1 个世界/.test(list) && /1 个 Mod/.test(list) && /要复制大约/.test(list) && /磁盘还剩/.test(list), list.slice(0, 400));
    check('界面', '说了原来的文件夹不会动', /只读，不会被改动/.test(list));
    check('界面', '存档在公共目录的说清楚', /存档在公共目录/.test(list));
    // 改成引用原目录：要有说明
    const opened = await a.ev(`(() => { const rows = [...document.querySelectorAll('.modal-back .mg-prof')]; const r = rows.find((x) => x.innerText.includes('HM Fabric')); const s = r.querySelector('.select, .sel, [role=combobox], button.select-btn, .a-select'); if (s) s.click(); return s ? s.className : (r.innerHTML.slice(0, 300)); })()`);
    await calm(a.ev);
    const picked = await a.ev(`(() => { const b = [...document.querySelectorAll('.menu > div, .popover .menu > div')].find((x) => x.offsetParent && x.innerText.trim() === '引用原目录'); if (b) b.click(); return !!b; })()`);
    await calm(a.ev);
    const after = await a.ev('document.querySelector(".modal-back").innerText');
    check('界面', '选「引用原目录」后说明会共用、卸载的风险', picked && /引用原目录是什么意思/.test(after) && /共用/.test(after) && /卸载/.test(after), { opened, picked });
    await shot(a, '极光-深-引用提示');
    // 开始导入
    await clickText(a, '开始导入', '.modal-back .modal-foot button');
    let ids = [];
    for (let i = 0; i < 50; i++) {
      await sleep(200); // pitfall-ok：轮询里两次查看之间的间隔
      ids = await a.ev('aurora.invoke("versions:installed").then((r) => r.data.map((v) => v.id))');
      if (ids.includes('HM Fabric') && ids.includes('Plain 1.20.1')) break;
    }
    check('界面', '导入以后配置出现在列表里', ids.includes('HM Fabric') && ids.includes('Plain 1.20.1'), ids);
    await until(a.ev, '!!document.querySelector(".toast")', 5000);
    const toast = await a.ev('[...document.querySelectorAll(".toast")].map((x) => x.innerText).join(" | ")');
    check('界面', '结束有提示，说了原来的文件夹没动', /导入完成/.test(toast) && /原来的文件夹没有动/.test(toast), toast.slice(0, 300));
    const vs = await a.ev('aurora.invoke("versions:settings", "HM Fabric").then((r) => r.data)');
    check('界面', '这个配置确实是引用原目录', !!vs.customGameDir && /HMCL/.test(vs.customGameDir), vs);
    check('界面', '页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 4));
    await a.stop();

    // 各种风格都要看得清（UI 改动的规矩）
    const looks = [
      ['像素-深', { ui: { style: 'pixel' }, theme: 'dark' }], ['紧凑-深', { ui: { style: 'compact' }, theme: 'dark' }], ['极光-浅', { theme: 'light' }], ['像素-浅', { ui: { style: 'pixel' }, theme: 'light' }], ['紧凑-浅', { ui: { style: 'compact' }, theme: 'light' }],
      ['极光-1.5倍', { a11y: { zoom: 1.5 } }], ['极光-高对比', { a11y: { contrast: 'high' } }], ['极光-英文', { language: 'en' }],
    ];
    let n = 0;
    const over = [];
    for (const [name, cfg] of looks) {
      const b = await start(`foreign-look-${n++}`, { prepare: prepareHome, config: (game) => ({ ...BASE_CONFIG(game), ...cfg }) });
      if (b.startError) { over.push(`${name}: ${b.startError}`); continue; }
      await b.ev('document.querySelectorAll(".modal-back").forEach((m) => m.remove()); 1');
      await openList(b);
      await clickText(b, '2 ', '.modal-back .mg-cand');
      await calm(b.ev);
      await shot(b, name);
      const bad = await b.ev(`(() => { const m = document.querySelector('.modal-back .modal'); if (!m) return 'no modal'; const box = m.getBoundingClientRect(); const out = []; if (box.right > innerWidth + 1 || box.left < -1) out.push('窗口超出屏幕'); for (const el of m.querySelectorAll('.mg-prof, .mg-list, .alert')) if (el.scrollWidth > el.clientWidth + 2) out.push('溢出 ' + el.className); return out.join(';'); })()`);
      if (bad) over.push(`${name}: ${bad}`);
      await b.stop();
    }
    check('界面', '3 种风格、明暗、1.5 倍、高对比度、英文：不溢出', over.length === 0, over.slice(0, 6));
    console.log(`  截图在 ${SHOTS}`);
  },

  async game() {
    const SRC = process.env.AURORA_REGRESS_GAME_SRC;
    const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
    if (!SRC || !JAVA) { console.log('  没设 AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME，跳过'); return; }
    process.env.AURORA_SANDBOX_SPAWN_ALLOW = '(javaw?\\.exe|taskkill(\\.exe)?)$';
    const WORLD = 'ForeignWorld';
    const root = path.join(BASE, 'foreign-game');
    const src = path.join(root, 'other', '.minecraft');
    const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已经没了 */ } };
    const prepare = ({ game }) => {
      fs.mkdirSync(src, { recursive: true });
      for (const d of ['libraries', 'assets']) fs.symlinkSync(path.join(SRC, d), path.join(src, d), 'junction');
      fs.cpSync(path.join(SRC, 'versions', '1.20.1'), path.join(src, 'versions', '1.20.1'), { recursive: true });
      // 测试用的游戏目录是别的测试玩过的，版本文件夹里有存档：清掉，才是官方启动器「全放在根目录」的样子
      for (const n of fs.readdirSync(path.join(src, 'versions', '1.20.1'))) if (!/^1\.20\.1\.(json|jar)$/.test(n)) fs.rmSync(path.join(src, 'versions', '1.20.1', n), { recursive: true, force: true });
      mk(path.join(src, 'launcher_profiles.json'), '{}');
      mk(path.join(src, 'options.txt'), 'onboardAccessibility:false\nsoundCategory_master:0.0\nsoundCategory_music:0.0\npauseOnLostFocus:false\nlang:en_us\n');
      fs.mkdirSync(path.join(src, 'saves'), { recursive: true });
      const r = spawnSync(path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(__dirname, 'crash-game.js'), path.join(src, 'saves')], { env: { ...process.env, AURORA_REGRESS_DIR: path.join(BASE, 'foreign-game-mk'), AURORA_WORLD_NAME: WORLD }, windowsHide: true, timeout: 60000 });
      fs.renameSync(path.join(src, 'saves', 'CrashWorld'), path.join(src, 'saves', WORLD));
      if (!fs.existsSync(path.join(src, 'saves', WORLD, 'level.dat'))) throw new Error(`造世界失败 ${r.status}`);
      void game;
    };
    const config = (game) => ({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, afterLaunch: 'keep', restoreOnExit: false, gameArgs: `--quickPlaySingleplayer ${WORLD}`, java: { selected: path.join(JAVA, 'bin', 'javaw.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false } });
    const a = await start('foreign-game', { root, prepare, config });
    if (a.startError) { check('真进游戏', '能打开', false, a.startError); return; }
    await a.ev("aurora.invoke('accounts:addOffline', 'ForeignPlayer')");
    const runImport = async (mode) => {
      const r = await a.ev(`aurora.invoke('migrate:foreignImport', { dir: ${JSON.stringify(src)} }, { picks: { '1.20.1': ${JSON.stringify(mode)} } })`, 60000);
      if (!r.ok) throw new Error(r.error);
      for (let i = 0; i < 600; i++) {
        const t = await a.ev(`aurora.invoke('tasks:list').then((x) => (x.data.find((y) => y.id === ${JSON.stringify(r.data)}) || {}))`);
        if (t.status && t.status !== 'running') return t;
        await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
      }
      throw new Error('导入超时');
    };
    const launch = async (id) => {
      const r = await a.ev(`aurora.invoke('launch:start', ${JSON.stringify(id)}, {})`, 240000);
      if (!r.ok) throw new Error(`启动失败：${r.error}`);
      for (let i = 0; i < 240; i++) {
        const log = await a.ev(`aurora.invoke('games:log', ${JSON.stringify(r.data.id)}).then((x) => x.data.map((l) => l.text).join('\\n'))`);
        if (i === 239) killTree(r.data.pid); // 超时不留下游戏
        if (/joined the game|logged in with entity id/.test(log)) return r.data;
        const st = await a.ev(`aurora.invoke('games:list').then((x) => (x.data.find((g) => g.id === ${JSON.stringify(r.data.id)}) || {}).state)`);
        if (st === 'exited') throw new Error(`游戏退出了：${log.slice(-500)}`);
        await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      throw new Error('等进世界超时');
    };
    const stopGame = async (g) => {
      killTree(g.pid);
      for (let i = 0; i < 40; i++) {
        const st = await a.ev(`aurora.invoke('games:list').then((x) => (x.data.find((y) => y.id === ${JSON.stringify(g.id)}) || {}).state)`);
        if (st === 'exited') break;
        await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
      }
      await until(a.ev, "![...A.state.tasks.values()].some((t) => t.status === 'running')", 15000);
    };
    const levelTime = () => fs.statSync(path.join(src, 'saves', WORLD, 'level.dat')).mtimeMs;
    const t0 = levelTime();
    const s1 = await runImport('copy');
    check('真进游戏', '复制导入：成功', s1.status === 'done', s1.error || '');
    const g1 = await launch('1.20.1').catch((e) => e);
    check('真进游戏', '复制导入的配置：真的进了世界', !(g1 instanceof Error), g1 instanceof Error ? g1.message : '');
    if (!(g1 instanceof Error)) await stopGame(g1);
    check('真进游戏', '世界在这边的公共目录里', fs.existsSync(path.join(a.game, 'saves', WORLD, 'level.dat')));
    check('真进游戏', '玩的是这边的副本，原来的世界没有被碰', levelTime() === t0 && !fs.existsSync(path.join(src, 'saves', WORLD, 'session.lock')));
    const s2 = await runImport('link');
    check('真进游戏', '引用原目录导入：成功（同名改名）', s2.status === 'done', s2.error || '');
    const g2 = await launch('1.20.1 (导入)').catch((e) => e);
    check('真进游戏', '引用原目录的配置：真的进了世界', !(g2 instanceof Error), g2 instanceof Error ? g2.message : '');
    await waitFor(() => fs.existsSync(path.join(src, 'saves', WORLD, 'session.lock')), 30000);
    check('真进游戏', '这次写的是原来的文件夹（有 session.lock）', fs.existsSync(path.join(src, 'saves', WORLD, 'session.lock')));
    if (!(g2 instanceof Error)) await stopGame(g2);
    check('真进游戏', '页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
    await a.stop();

    // Aurora 自己的导出和导入：导出包带运行库，换一套全新的数据导入，真进世界
    const pack = path.join(root, 'out', 'all.aurorapack');
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    process.env.AURORA_SANDBOX_SAVE_TO = pack;
    const ex = await start('foreign-game', { root, keepData: true });
    const exp = await ex.ev(`aurora.invoke('migrate:export', { saves: true, screenshots: false, logs: false, runtime: true, settings: false, skins: false, accounts: true, plans: false }, ['1.20.1'])`, 60000);
    check('真进游戏', 'Aurora 导出：开始了', exp.ok, exp.error || '');
    for (let i = 0; i < 400; i++) {
      const t = await ex.ev(`aurora.invoke('tasks:list').then((x) => (x.data.find((y) => y.id === ${JSON.stringify(exp.data)}) || {}).status)`);
      if (t && t !== 'running') break;
      await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
    }
    await ex.stop();
    delete process.env.AURORA_SANDBOX_SAVE_TO;
    check('真进游戏', 'Aurora 导出：文件有了', fs.existsSync(pack) && fs.statSync(pack).size > 1048576, fs.existsSync(pack) ? `${Math.round(fs.statSync(pack).size / 1048576)} MB` : '没有');
    const root2 = path.join(BASE, 'foreign-game-2');
    const b = await start('foreign-game-2', { root: root2, config, prepare: ({ game }) => {
      fs.symlinkSync(path.join(SRC, 'assets'), path.join(game, 'assets'), 'junction'); // 资源导出包不带，这里不联网
    } });
    const ins = await b.ev(`aurora.invoke('migrate:inspect', { file: ${JSON.stringify(pack)} }).then((r) => r.data)`, 60000);
    check('真进游戏', 'Aurora 导入：检查通过，没有改动', ins.ok && !ins.problems.some((x) => x.level === 'risk'), ins.problems);
    const imp = await b.ev(`aurora.invoke('migrate:import', { file: ${JSON.stringify(pack)} }, { settings: false, accounts: true, skins: false, plans: false, profiles: {} })`, 60000);
    let impStatus = '';
    for (let i = 0; i < 400; i++) {
      impStatus = await b.ev(`aurora.invoke('tasks:list').then((x) => (x.data.find((y) => y.id === ${JSON.stringify(imp.data)}) || {}).status)`);
      if (impStatus && impStatus !== 'running') break;
      await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
    }
    check('真进游戏', 'Aurora 导入：成功', impStatus === 'done', impStatus);
    const worldThere = fs.existsSync(path.join(b.game, 'saves', WORLD, 'level.dat'));
    check('真进游戏', 'Aurora 导入：世界带过来了', worldThere);
    await b.ev("aurora.invoke('accounts:addOffline', 'ForeignPlayer2')");
    const lr = await b.ev("aurora.invoke('launch:start', '1.20.1', {})", 240000);
    let inWorld = false;
    if (lr.ok) {
      for (let i = 0; i < 180 && !inWorld; i++) {
        const log = await b.ev(`aurora.invoke('games:log', ${JSON.stringify(lr.data.id)}).then((x) => x.data.map((l) => l.text).join('\\n'))`);
        inWorld = /joined the game|logged in with entity id/.test(log);
        if (!inWorld) await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      killTree(lr.data.pid);
    }
    check('真进游戏', 'Aurora 导入的配置：真的进了世界', inWorld, lr.ok ? '' : lr.error);
    await until(b.ev, "aurora.invoke('games:list').then((x) => x.data.every((y) => y.state === 'exited'))", 15000);
    await b.stop();
    delete process.env.AURORA_SANDBOX_SPAWN_ALLOW;
    void fakeVersion;
  },

  // 真的 HMCL 3.16.4、PCL2 自己装的版本和写的设置（2026-11-07，两个启动器放在 test/ 下，在它们自己的界面上装的）。
  // AURORA_FOREIGN_REAL=<HMCL 的 .minecraft>;<PCL2 的 .minecraft>，各有一个 RealWorld。复制后进世界，引用原目录后进世界，原来的只许游戏自己写
  async real() {
    const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
    const dirs = (process.env.AURORA_FOREIGN_REAL || '').split(';').filter(Boolean);
    if (!JAVA || dirs.length < 2) { console.log('  没设 AURORA_FOREIGN_REAL / AURORA_REGRESS_JAVA_HOME，跳过'); return; }
    process.env.AURORA_SANDBOX_SPAWN_ALLOW = '(javaw?\\.exe|taskkill(\\.exe)?)$';
    const [hm, pc] = dirs;
    const WORLD = 'RealWorld';
    const FAB = '1.20.1-Fabric';
    const FORGE = '1.20.1-Forge_47.4.28';
    const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已经没了 */ } };
    const snap = (d) => {
      const m = new Map();
      const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { const st = fs.statSync(f); m.set(f, `${st.size}:${st.mtimeMs}`); } } };
      walk(d);
      return m;
    };
    const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
    const before = [snap(hm), snap(pc)];
    const config = (game) => ({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, afterLaunch: 'keep', restoreOnExit: false, gameArgs: `--quickPlaySingleplayer ${WORLD}`, java: { selected: path.join(JAVA, 'bin', 'javaw.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false } });
    const a = await start('foreign-real', { root: path.join(BASE, 'foreign-real'), config });
    if (a.startError) { check('真启动器', '能打开', false, a.startError); return; }
    await a.ev("aurora.invoke('accounts:addOffline', 'RealPlayer')");
    const inspect = (d) => a.ev(`aurora.invoke('migrate:foreignInspect', ${JSON.stringify(d)}).then((r) => r.data)`, 60000);
    const iH = await inspect(hm);
    const iP = await inspect(pc);
    const f = (i, k) => ((i && i.instances) || []).find((x) => x.key === k) || {};
    const brief = (i) => ({ launcher: i && i.source && i.source.launcher, list: ((i && i.instances) || []).map((x) => [x.key, x.isolated, x.worlds, x.mods, x.loader && x.loader.type]) });
    check('真启动器', 'HMCL 3.16.4：认成 HMCL；Fabric 那个独立，原版那个用公共目录；世界、Mod、加载器都对', iH.ok && iH.source.launcher === 'HMCL' && f(iH, FAB).isolated && !f(iH, '1.20.1').isolated && f(iH, FAB).worlds === 1 && f(iH, FAB).mods === 1 && f(iH, FAB).loader && f(iH, FAB).loader.type === 'fabric' && f(iH, '1.20.1').worlds === 1, brief(iH));
    check('真启动器', 'PCL2：认成 PCL2；Forge 那个独立，读得出 Forge', iP.ok && iP.source.launcher === 'PCL2' && f(iP, FORGE).isolated && f(iP, FORGE).loader && f(iP, FORGE).loader.type === 'forge' && f(iP, FORGE).worlds === 1, brief(iP));
    const runImport = async (dir, picks) => {
      const r = await a.ev(`aurora.invoke('migrate:foreignImport', { dir: ${JSON.stringify(dir)} }, { picks: ${JSON.stringify(picks)} })`, 60000);
      if (!r.ok) throw new Error(r.error);
      for (let i = 0; i < 3600; i++) { // 网络盘上几千个资源小文件要复制很久，最多等 30 分钟
        const t = await a.ev(`aurora.invoke('tasks:list').then((x) => (x.data.find((y) => y.id === ${JSON.stringify(r.data)}) || {}))`);
        if (t.status && t.status !== 'running') return t;
        await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
      }
      throw new Error('导入超时');
    };
    const launch = async (id) => {
      const r = await a.ev(`aurora.invoke('launch:start', ${JSON.stringify(id)}, {})`, 300000);
      if (!r.ok) throw new Error(`启动失败：${r.error}`);
      for (let i = 0; i < 300; i++) {
        const log = await a.ev(`aurora.invoke('games:log', ${JSON.stringify(r.data.id)}).then((x) => x.data.map((l) => l.text).join('\\n'))`);
        if (i === 299) killTree(r.data.pid); // 超时不留下游戏
        if (/joined the game|logged in with entity id/.test(log)) return r.data;
        const st = await a.ev(`aurora.invoke('games:list').then((x) => (x.data.find((g) => g.id === ${JSON.stringify(r.data.id)}) || {}).state)`);
        if (st === 'exited') throw new Error(`游戏退出了：${log.slice(-800)}`);
        await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      throw new Error('等进世界超时');
    };
    const stopGame = async (g) => {
      killTree(g.pid);
      for (let i = 0; i < 40; i++) {
        const st = await a.ev(`aurora.invoke('games:list').then((x) => (x.data.find((y) => y.id === ${JSON.stringify(g.id)}) || {}).state)`);
        if (st === 'exited') break;
        await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
      }
      await until(a.ev, "![...A.state.tasks.values()].some((t) => t.status === 'running')", 15000);
    };
    const play = async (name, id) => {
      const g = await launch(id).catch((e) => e);
      check('真启动器', `${name}：真的进了世界`, !(g instanceof Error), g instanceof Error ? g.message : '');
      if (!(g instanceof Error)) await stopGame(g);
    };
    const s1 = await runImport(hm, { [FAB]: 'copy', '1.20.1': 'copy' });
    check('真启动器', 'HMCL 两个配置复制导入：成功', s1.status === 'done', s1.error || '');
    await play('HMCL 的 Fabric（复制）', FAB);
    await play('HMCL 的原版（复制）', '1.20.1');
    const s2 = await runImport(pc, { [FORGE]: 'copy' });
    check('真启动器', 'PCL2 的 Forge 复制导入：成功', s2.status === 'done', s2.error || '');
    await play('PCL2 的 Forge（复制）', FORGE);
    const mid = [snap(hm), snap(pc)];
    check('真启动器', '复制导入和玩复制的配置：两个启动器的文件夹一个文件都没变', diff(before[0], mid[0]).length === 0 && diff(before[1], mid[1]).length === 0, [...diff(before[0], mid[0]), ...diff(before[1], mid[1])].slice(0, 5));
    // 引用原目录时游戏要往原来的文件夹里写，隔离层只放行测试目录：在测试目录里放一份 HMCL 的（.hmcl 设置 + 这个版本）
    const linkSrc = path.join(BASE, 'foreign-real', 'hmcl-link', '.minecraft');
    fs.cpSync(path.join(path.dirname(hm), '.hmcl'), path.join(path.dirname(linkSrc), '.hmcl'), { recursive: true });
    fs.cpSync(path.join(hm, 'versions', FAB), path.join(linkSrc, 'versions', FAB), { recursive: true });
    const linkBefore = snap(linkSrc);
    const s3 = await runImport(linkSrc, { [FAB]: 'link' });
    check('真启动器', 'HMCL 的 Fabric 引用原目录导入：成功', s3.status === 'done', s3.error || '');
    const linked = (await a.ev("aurora.invoke('versions:installed').then((r) => r.data.map((v) => v.id))")).find((x) => x !== FAB && x.startsWith(FAB));
    await play('HMCL 的 Fabric（引用原目录）', linked || `${FAB} (导入)`);
    const after = snap(linkSrc);
    const vdir = path.join(linkSrc, 'versions', FAB) + path.sep;
    const outside = diff(linkBefore, after).filter((k) => !k.startsWith(vdir));
    check('真启动器', '引用原目录：游戏写的是 HMCL 那个版本文件夹，别处没动', diff(linkBefore, after).some((k) => k.startsWith(path.join(vdir, 'saves', WORLD))) && outside.length === 0, outside.slice(0, 5));
    check('真启动器', '真的 HMCL 和 PCL2 文件夹从头到尾一个文件都没变', diff(before[0], snap(hm)).length === 0 && diff(before[1], snap(pc)).length === 0);
    check('真启动器', '页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
    await a.stop();
    delete process.env.AURORA_SANDBOX_SPAWN_ALLOW;
  },

  // 真的 Prism Launcher 11.1.1 建的实例（2026-11-07，在它的界面上建的 1.20.1 + Fabric 0.20.1）。Prism 没有版本文件，
  // 要联网按 mmc-pack.json 重装：只放行 Mojang、Fabric 和 BMCLAPI 的主机，别的照样拦。资源文件用测试游戏目录里现成的，不重新下几百 MB。
  // AURORA_FOREIGN_PRISM=<Prism 文件夹>，实例里放一个 RealWorld
  async prism() {
    const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
    const SRC = process.env.AURORA_REGRESS_GAME_SRC;
    const PR = process.env.AURORA_FOREIGN_PRISM;
    if (!JAVA || !SRC || !PR) { console.log('  没设 AURORA_FOREIGN_PRISM / AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME，跳过'); return; }
    process.env.AURORA_SANDBOX_SPAWN_ALLOW = '(javaw?\\.exe|taskkill(\\.exe)?)$';
    process.env.AURORA_SANDBOX_NET_ALLOW = '(^|\\.)(mojang\\.com|minecraft\\.net|fabricmc\\.net|bangbang93\\.com)$';
    const WORLD = 'RealWorld';
    const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已经没了 */ } };
    const snap = (d) => {
      const m = new Map();
      const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { const st = fs.statSync(f); m.set(f, `${st.size}:${st.mtimeMs}`); } } };
      walk(d);
      return m;
    };
    const inst = path.join(PR, 'instances');
    const before = snap(inst);
    const config = (game) => ({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, afterLaunch: 'keep', restoreOnExit: false, gameArgs: `--quickPlaySingleplayer ${WORLD}`, java: { selected: path.join(JAVA, 'bin', 'javaw.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false } });
    const a = await start('foreign-prism', { root: path.join(BASE, 'foreign-prism'), config, prepare: ({ game }) => fs.symlinkSync(path.join(SRC, 'assets'), path.join(game, 'assets'), 'junction') });
    if (a.startError) { check('Prism', '能打开', false, a.startError); return; }
    await a.ev("aurora.invoke('accounts:addOffline', 'PrismPlayer')");
    const i = await a.ev(`aurora.invoke('migrate:foreignInspect', ${JSON.stringify(PR)}).then((r) => r.data)`, 60000);
    const it = ((i && i.instances) || [])[0] || {};
    check('Prism', '认成 Prism / MultiMC，读出 1.20.1 + Fabric 0.20.1，世界 1 个，要联网重装', i.ok && /Prism/.test(i.source.launcher) && it.mc === '1.20.1' && it.loader && it.loader.type === 'fabric' && it.loader.version === '0.20.1' && it.worlds === 1 && it.needsDownload, { launcher: i.source && i.source.launcher, it: [it.key, it.mc, it.loader, it.worlds, it.needsDownload] });
    const r = await a.ev(`aurora.invoke('migrate:foreignImport', { dir: ${JSON.stringify(PR)} }, { picks: { ${JSON.stringify(it.key)}: 'copy' } })`, 60000);
    let t = {};
    for (let k = 0; r.ok && k < 1800; k++) {
      t = await a.ev(`aurora.invoke('tasks:list').then((x) => (x.data.find((y) => y.id === ${JSON.stringify(r.data)}) || {}))`);
      if (t.status && t.status !== 'running') break;
      await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
    }
    check('Prism', '复制导入（联网装 1.20.1 和 Fabric）：成功', r.ok && t.status === 'done', r.ok ? (t.error || t.status) : r.error);
    const ids = await a.ev("aurora.invoke('versions:installed').then((x) => x.data.map((v) => v.id))");
    const id = ids.find((x) => /fabric/i.test(x));
    check('Prism', '实例名正好是版本号（1.20.1）：导入成 1.20.1-Fabric，不和原版重名', id === '1.20.1-Fabric', ids);
    const lr = await a.ev(`aurora.invoke('launch:start', ${JSON.stringify(id || '1.20.1')}, {})`, 300000);
    let inWorld = false;
    if (lr.ok) {
      for (let k = 0; k < 240 && !inWorld; k++) {
        const log = await a.ev(`aurora.invoke('games:log', ${JSON.stringify(lr.data.id)}).then((x) => x.data.map((l) => l.text).join('\\n'))`);
        inWorld = /joined the game|logged in with entity id/.test(log);
        if (!inWorld) await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      killTree(lr.data.pid);
    }
    check('Prism', '导入的配置：真的进了世界', inWorld, lr.ok ? '' : lr.error);
    const after = snap(inst);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    check('Prism', 'Prism 的实例文件夹一个文件都没变', changed.length === 0, changed.slice(0, 4));
    check('Prism', '页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
    await a.stop();
    delete process.env.AURORA_SANDBOX_SPAWN_ALLOW;
    delete process.env.AURORA_SANDBOX_NET_ALLOW;
  },
};

(async () => {
  const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENARIOS);
  fs.mkdirSync(BASE, { recursive: true });
  for (const name of pick) {
    console.log(`\n=== foreign-ui ${name} ===`);
    const t0 = Date.now();
    try { await SCENARIOS[name](); } catch (e) { check(name, '脚本运行出错', false, e.stack || String(e)); }
    console.log(`  用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  }
  if (OUT) fs.appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
