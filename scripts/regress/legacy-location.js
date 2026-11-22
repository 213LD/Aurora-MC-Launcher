'use strict';
/**
 * 老数据文件夹一直认得出来（rc13 起，一直保留）。启动器改过两次名字（Aurora Launcher → Aurora Minecraft Launcher
 * → Aurora MC Launcher），玩家电脑上老版本放数据的地方，新版本都要找得到：配置、账户、游戏目录一样不少。
 *   node scripts/regress/legacy-location.js [v1.0.0,v2.0.0-rc10]
 *
 * 一、老版本自己的代码（从 git tag 取，和 upgrade.js 共用缓存）按它自己的程序名决定数据放哪，三种位置各造一份：
 *     默认位置（%APPDATA% 下面）、便携（exe 旁边的标记文件 + AuroraData）、自定义文件夹（默认位置里的指针文件）。
 *     再用现在的代码、现在的程序名去找，接着写一次，看写回了同一个地方、没有按新名字另起一份。
 *     最新发布的那一版自动加进来；没有这些 tag 的副本（公开版）跳过老版本，只跑现在的代码。
 *     upgrade.js 管的是「老数据的格式新版读得懂」，它用环境变量直接指定数据目录；这里管「新版去哪找」。
 * 二、老名字的启动器开着时，新名字的打开同一份数据：要让给先开的那个（两边同时写，配置会互相盖掉）。
 * 三、移动便携版：桌面上按老名字建的快捷方式改成指新位置，不另建一个（不然点旧图标打开的是原位置那一份数据）。
 * 四、几个名字常量没变（踩坑检查的「必须一直在的写法」也守着）。
 * 全部关在 sandbox-hook 的隔离层里，用假的 AppData 和桌面。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const IS_CHILD = !!process.versions.electron;
const REPO = path.resolve(__dirname, '..', '..');
// 每个时期挑一两版：1.0 ~ 1.2 的默认位置是 Electron 按程序名给的（那时程序名恰好是 Aurora Launcher），1.3.0 起写死；
// 1.7.3 / 1.7.4、rc10 / rc11 是两次改名的前后
const TAGS = ['v1.0.0', 'v1.2.2', 'v1.3.0', 'v1.7.3', 'v1.7.4', 'v1.10.10', 'v2.0.0-pre7', 'v2.0.0-rc1', 'v2.0.0-rc10', 'v2.0.0-rc11'];
const SCENES = ['default', 'portable', 'custom'];
const SCENE_NAME = { default: '默认位置', portable: '便携', custom: '自定义文件夹' };
// 这几个名字一改，老玩家的数据就找不到了
const LEGACY = { dataDirName: 'Aurora Launcher', MARKER: 'aurora-portable.json', PORTABLE_DIR: 'AuroraData', POINTER: 'location.json', TOKEN: '@aurora-data' }; // pitfall-ok：老数据用到的名字，这个测试守的就是它们
// 这份代码自己的默认数据文件夹名（editions.js 的差别表）：内部版就是上面的 Aurora Launcher；公开版有自己的文件夹，
// 不去读内部版的数据。「另起了一份数据」照样查：公开版要是往 Aurora Launcher 里写了配置，也会报出来
const ED = require('./editions');
const CURRENT_DIR = ED.dataDirName;

if (IS_CHILD) child(); else parent();

// ───────────────────────── 子进程 ─────────────────────────
function child() {
  const { app, shell } = require('electron');
  const realLink = { write: shell.writeShortcutLink.bind(shell), read: shell.readShortcutLink.bind(shell) };
  const { seal } = require('./sandbox-hook');
  const [mode, tag, scene] = process.argv.slice(-3);
  for (const k of ['AURORA_DATA_DIR', 'AURORA_GAME_DIR', 'AURORA_TEST_DEFAULT_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR']) delete process.env[k];
  const root = process.env.AURORA_LEG_ROOT;
  app.whenReady().then(async () => {
    const box = seal(root);
    const quiet = () => {};
    console.log = quiet; console.warn = quiet; console.error = quiet; console.info = quiet;
    const report = { tag, mode, scene, problems: [], facts: {} };
    const crashes = [];
    process.on('uncaughtException', (e) => crashes.push(String(e && e.stack).slice(0, 300)));
    process.on('unhandledRejection', (e) => crashes.push(String(e && e.stack).slice(0, 300)));
    const ctx = { app, root, report, bad: (t) => report.problems.push(t) };
    try {
      if (mode === 'gen') await gen(ctx, process.env.AURORA_LEG_SRC, scene);
      else if (mode === 'check') await check(ctx, scene);
      else if (mode === 'lock') await lock(ctx, tag, scene);
      else if (mode === 'shortcut') { shell.writeShortcutLink = realLink.write; shell.readShortcutLink = realLink.read; await shortcut(ctx, realLink); }
    } catch (e) {
      report.problems.push(`脚本出错：${String((e && e.stack) || e).slice(0, 500)}`);
    }
    for (const c of crashes) report.problems.push(`未捕获的异常：${c}`);
    report.denied = box.log.writes.slice(0, 5);
    box.release();
    fs.writeFileSync(path.join(root, `${mode}-${scene}-report.json`), JSON.stringify(report, null, 1));
    app.exit(0);
  });
  app.on('window-all-closed', () => {});
}

/** 老版本的代码在 src/main/、src/main/core/，2.0.0-pre9 起引擎在 src/main/engine/ */
function mod(srcRoot, m) {
  for (const d of ['engine', 'core', '']) {
    const f = path.join(srcRoot, 'src', 'main', d, `${m}.js`);
    if (fs.existsSync(f)) return require(f);
  }
  throw new Error(`找不到模块 ${m}`);
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

/**
 * 模拟那个版本的 exe 刚启动时的样子：userData 是 Electron 按程序名给的（AppData 下面的同名文件夹），
 * 便携版 exe 所在的文件夹是 root/exe（新版就放在老版旁边，和玩家换新 exe 时一样）
 */
function boot(ctx, srcRoot) {
  const appData = ctx.app.getPath('appData');
  const pkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
  const name = process.env.AURORA_LEG_NAME || pkg.productName || pkg.name;
  ctx.app.setPath('userData', path.join(appData, name));
  const exeDir = path.join(ctx.root, 'exe');
  fs.mkdirSync(exeDir, { recursive: true });
  process.env.PORTABLE_EXECUTABLE_DIR = exeDir;
  return { appData, name, exeDir };
}

/** 那个位置上启动器数据该在的文件夹 */
function expected(ctx, scene, appData, exeDir) {
  if (scene === 'portable') return { mode: 'portable', dir: path.join(exeDir, LEGACY.PORTABLE_DIR, 'launcher'), game: path.join(exeDir, LEGACY.PORTABLE_DIR, '.minecraft') };
  if (scene === 'custom') return { mode: 'custom', dir: path.join(ctx.root, 'custom', 'launcher'), game: path.join(ctx.root, 'custom', '.minecraft') };
  return { mode: 'default', dir: path.join(appData, CURRENT_DIR), game: path.join(ctx.root, 'game') };
}

/** 老版本（或现在的代码）造数据，再像玩家在设置里那样换到便携 / 自定义位置 */
async function gen(ctx, srcRoot, scene) {
  const { appData, name, exeDir } = boot(ctx, srcRoot);
  const loc = mod(srcRoot, 'location');
  loc.init();
  const config = mod(srcRoot, 'config');
  config.load();
  const game = path.join(ctx.root, 'game');
  await fsp.mkdir(path.join(game, 'versions'), { recursive: true });
  await fsp.writeFile(path.join(game, 'legacy-game.txt'), ctx.report.tag);
  config.set({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, gameDir: game, language: 'zh-CN', legacyMarker: `${ctx.report.tag}/${scene}` });
  await mod(srcRoot, 'auth/accounts').addOffline('LegacySteve');
  await config.flush();
  const defaultDir = ctx.app.getPath('userData');
  if (scene !== 'default') {
    const task = { update() {}, signal: new AbortController().signal };
    await loc.switchTo(scene === 'portable' ? { mode: 'portable', game: 'copy' } : { mode: 'custom', dir: path.join(ctx.root, 'custom'), game: 'copy' }, task);
  }
  const want = expected(ctx, scene, appData, exeDir);
  ctx.report.facts = { name, defaultDir, dataDir: want.dir };
  // 老版本自己放的地方和这里以为的一样（不一样说明这个测试对老版本的理解错了）
  if (scene === 'default' && !same(defaultDir, want.dir)) ctx.bad(`老版本把数据放在 ${defaultDir}，不是 ${want.dir}`);
  if (!fs.existsSync(path.join(want.dir, 'config.json'))) ctx.bad(`老版本换位置以后 ${want.dir} 里没有配置`);
}

/** 现在的代码、现在的程序名去找老数据 */
async function check(ctx, scene) {
  const { appData, name, exeDir } = boot(ctx, REPO);
  const g = readJson(path.join(ctx.root, `gen-${scene}-report.json`)) || { facts: {} };
  const want = expected(ctx, scene, appData, exeDir);
  const loc = mod(REPO, 'location');
  const st = loc.init();
  const dataDir = ctx.app.getPath('userData');
  ctx.report.facts = { name, mode: st.mode, dataDir };
  if (st.mode !== want.mode) ctx.bad(`存储位置认成了「${st.mode}」，应该是「${want.mode}」`);
  if (st.error) ctx.bad(`报错：${st.error}`);
  if (!same(dataDir, want.dir)) ctx.bad(`数据目录是 ${dataDir}，老数据在 ${want.dir}`);
  if (g.facts.dataDir && !same(g.facts.dataDir, want.dir)) ctx.bad(`老版本的数据在 ${g.facts.dataDir}`);
  const config = mod(REPO, 'config');
  config.load();
  const c = config.get();
  if (c.legacyMarker !== `${ctx.report.tag}/${scene}`) ctx.bad(`配置不是老版本的那份：${JSON.stringify(c.legacyMarker)}`);
  if (!same(c.gameDir, want.game)) ctx.bad(`游戏目录是 ${c.gameDir}，应该是 ${want.game}`);
  if (!fs.existsSync(path.join(c.gameDir || ctx.root, 'legacy-game.txt'))) ctx.bad('游戏目录里的东西不见了');
  const accs = mod(REPO, 'auth/accounts').list();
  if (!(accs.accounts || []).some((a) => a.name === 'LegacySteve')) ctx.bad('账户丢了');
  // 新版接着写：写回同一个地方
  config.set({ legacyNewWrite: 1 });
  await config.flush();
  const back = readJson(path.join(want.dir, 'config.json'));
  if (!back || back.legacyNewWrite !== 1) ctx.bad('新版改的设置没有写回老数据文件夹');
  // 按程序名另起一份（以后再改名，最容易出的就是这个）
  for (const d of fs.readdirSync(appData)) {
    if (d.toLowerCase() === CURRENT_DIR.toLowerCase()) continue;
    if (fs.existsSync(path.join(appData, d, 'config.json'))) ctx.bad(`AppData 下面另起了一份数据：${d}`);
  }
}

/** 防双开：程序名是 tag 那个参数（老名字 / 新名字），数据都在同一个 AppData 里 */
async function lock(ctx, progName, role) {
  ctx.app.setName(progName);
  ctx.app.setPath('userData', path.join(ctx.app.getPath('appData'), progName));
  mod(REPO, 'location').init();
  ctx.report.facts = { name: progName, dataDir: ctx.app.getPath('userData'), lock: ctx.app.requestSingleInstanceLock() };
  if (role !== 'hold') return;
  // 先开的那个一直开着，等父进程说可以关了（最多 60 秒）
  fs.writeFileSync(path.join(ctx.root, 'lock-hold-ready'), '1');
  const t0 = Date.now();
  while (!fs.existsSync(path.join(ctx.root, 'lock-hold-release')) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
}

/** 移动便携版时的桌面快捷方式（真的建 .lnk，桌面是隔离层给的假桌面） */
async function shortcut(ctx, link) {
  const BRAND = require(path.join(REPO, 'src', 'shared', 'brand'));
  const placecheck = mod(REPO, 'placecheck');
  const desk = ctx.app.getPath('desktop');
  const fromDir = path.join(ctx.root, 'old');
  await fsp.mkdir(fromDir, { recursive: true });
  const fromExe = path.join(fromDir, 'Aurora-Launcher-2.0.0-rc10-Portable.exe');
  await fsp.writeFile(fromExe, 'exe');
  const other = path.join(ctx.root, 'other', 'Aurora-Launcher-2.0.0-rc5-Portable.exe');
  await fsp.mkdir(path.dirname(other), { recursive: true });
  await fsp.writeFile(other, 'exe');
  process.env.PORTABLE_EXECUTABLE_FILE = fromExe;
  process.env.PORTABLE_EXECUTABLE_DIR = fromDir;
  const lnk = (n) => path.join(desk, `${n}.lnk`);
  const target = (n) => { try { return link.read(lnk(n)).target; } catch { return null; } };
  const clean = async () => { for (const f of await fsp.readdir(desk)) await fsp.rm(path.join(desk, f), { force: true }); };
  const now = BRAND.name;
  const [old1, old2] = BRAND.formerNames;
  const out = {};
  const move = async (k, pre) => {
    await clean();
    for (const [n, t] of pre) link.write(lnk(n), 'create', { target: t });
    const r = await placecheck.moveTo(path.join(ctx.root, k), { shortcut: true });
    const icons = (await fsp.readdir(desk)).sort();
    out[k] = { exe: r.exe, icons, targets: Object.fromEntries(icons.map((f) => [f, target(f.replace(/\.lnk$/, ''))])) };
    return r.exe;
  };
  let exe = await move('A', [[old1, fromExe]]);
  out.A.ok = same(target(old1), exe) && target(now) === null;
  exe = await move('B', [[old1, other]]);
  out.B.ok = same(target(old1), other) && same(target(now), exe);
  exe = await move('C', []);
  out.C.ok = same(target(now), exe) && out.C.icons.length === 1;
  exe = await move('D', [[old1, fromExe], [old2, fromExe], [now, fromExe]]);
  out.D.ok = same(target(old1), exe) && same(target(old2), exe) && same(target(now), exe) && out.D.icons.length === 3;
  ctx.report.facts = out;
}

// ───────────────────────── 父进程 ─────────────────────────
function parent() {
  const BASE = require('./editions').BASE;
  const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const OUT = process.env.AURORA_REGRESS_OUT;
  const results = [];
  const check = (id, name, ok, detail = '') => {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    results.push({ id, name, ok: !!ok, detail: d });
    console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
  };
  const exists = (p) => fs.existsSync(p);
  const spawnChild = (root, mode, tag, scene, extra = {}) => spawn(ELECTRON, [__filename, mode, tag, scene], { env: { ...process.env, AURORA_LEG_ROOT: root, ELECTRON_ENABLE_LOGGING: '', ...extra }, stdio: 'ignore', windowsHide: true });
  const run = (root, mode, tag, scene, extra = {}) => new Promise((resolve) => {
    const c = spawnChild(root, mode, tag, scene, extra);
    // 启动 Electron 加读写几个小文件，平时两三秒；超过 90 秒算卡死
    const timer = setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } resolve(null); }, 90000);
    c.once('exit', () => { clearTimeout(timer); resolve(readJson(path.join(root, `${mode}-${scene}-report.json`))); });
  });
  const problemsOf = (r) => (r ? [...r.problems, ...(r.denied && r.denied.length ? [`隔离层拦下写到外面：${JSON.stringify(r.denied[0])}`] : [])] : ['没有跑完（可能卡死或崩溃）']);
  const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/).filter(Boolean); } catch { return []; } };

  (async () => {
    // ── 四、名字常量 ──
    const BRAND = require(path.join(REPO, 'src', 'shared', 'brand'));
    const locSrc = fs.readFileSync(path.join(REPO, 'src', 'main', 'engine', 'location.js'), 'utf8');
    const consts = Object.fromEntries(['MARKER', 'PORTABLE_DIR', 'POINTER', 'TOKEN'].map((k) => [k, (locSrc.match(new RegExp(`^const ${k} = '([^']+)'`, 'm')) || [])[1]]));
    const changed = Object.entries(LEGACY).filter(([k, v]) => (k === 'dataDirName' ? BRAND.dataDirName : consts[k]) !== v);
    check('名字', '老数据用到的几个名字没变（数据文件夹名、便携标记、便携数据文件夹、自定义位置的指针、路径记号）', !changed.length, changed.length ? changed.map(([k, v]) => `${k} 应该是 ${v}`) : LEGACY);
    const edSrc = fs.readFileSync(path.join(REPO, 'src', 'main', 'engine', 'edition.js'), 'utf8');
    check('名字', '默认位置按写死的文件夹名算，不按程序名（getPath(\'userData\') 会跟着程序名变）；内部版就是 BRAND.dataDirName', /path\.join\(a\.getPath\('appData'\),\s*EDITION\.dataDirName\)/.test(locSrc) && /dataDirName:\s*PUBLIC \? BRAND\.publicEdition\.dataDirName : BRAND\.dataDirName/.test(edSrc));
    check('名字', '以前用过的名字都记着（「移动便携版」的推荐文件夹、桌面快捷方式要认它们）', ['Aurora Minecraft Launcher', 'Aurora Launcher'].every((n) => (BRAND.formerNames || []).includes(n)), BRAND.formerNames); // pitfall-ok：以前用过的名字

    // ── 一、老版本的三种位置 ──
    // 要哪些老版本（editions.js）：内部版是上面挑的那几版加最新发布的一版；公开仓库用它自己最近的几个 tag
    const tags = new Set(git('tag'));
    const latest = git('tag --sort=-creatordate')[0];
    const old = ED.oldTags(TAGS);
    const pick = process.argv[2] ? process.argv[2].split(',') : [...new Set([...old.tags, ...(ED.PUBLIC ? [] : [latest])].filter(Boolean))];
    const table = [];
    let skipped = 0;
    const one = async (tag, src, scene, extra) => {
      const root = path.join(BASE, 'legacy', tag, scene);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.mkdir(root, { recursive: true });
      const g = await run(root, 'gen', tag, scene, { AURORA_LEG_SRC: src, ...extra });
      if (problemsOf(g).length) return { gen: false, p: problemsOf(g) };
      const c = await run(root, 'check', tag, scene);
      return { gen: true, name: g.facts.name, p: problemsOf(c), dir: c && c.facts.dataDir };
    };
    for (const tag of pick) {
      if (tag !== 'current' && !tags.has(tag)) { skipped++; continue; }
      let src = REPO;
      if (tag !== 'current') {
        // 按提交号缓存（和 upgrade.js 共用）：两个仓库同名的 tag 是不同的代码，按 tag 名缓存会拿错
        src = ED.oldSrcDir(BASE, tag);
        if (!exists(path.join(src, 'package.json'))) {
          await fsp.mkdir(src, { recursive: true });
          execSync(`git archive --format=tar ${tag} src package.json | tar -x -C "${src.split(path.sep).join('/')}"`, { cwd: REPO, stdio: 'pipe', shell: 'bash' });
        }
      }
      const row = { tag };
      const rs = await Promise.all(SCENES.map((s) => one(tag, src, s, {})));
      SCENES.forEach((s, i) => {
        const r = rs[i];
        row[s] = r.gen && !r.p.length;
        if (!r.gen) check(tag, `${SCENE_NAME[s]}：老版本造数据`, false, r.p.slice(0, 4));
        else check(tag, `${SCENE_NAME[s]}：${r.name} 放的数据，新版本找得到，配置、账户、游戏目录都在，接着写也写回原处`, !r.p.length, r.p.length ? r.p.slice(0, 4) : r.dir);
      });
      table.push(row);
    }
    // 现在的代码自己（公开版也跑）：假装是以前的名字的 exe 造的数据
    for (const former of BRAND.formerNames) {
      const rs = await Promise.all(SCENES.map((s) => one(`current-${former.replace(/\s+/g, '-')}`, REPO, s, { AURORA_LEG_NAME: former })));
      const p = rs.flatMap((r, i) => r.p.map((x) => `${SCENE_NAME[SCENES[i]]}：${x}`));
      check('现在的代码', `程序名是「${former}」时放的数据（三种位置），换成现在的名字也找得到`, !p.length, p.slice(0, 4));
    }
    if (skipped || old.missing.length) console.log(`  跳过 ${skipped || old.missing.length} 个老版本：这份代码里没有它们的 git tag（${ED.PUBLIC ? '公开仓库只有它自己的版本' : old.missing.join('、')}）`);
    if (ED.PUBLIC && !table.length) console.log('  公开仓库还没有发布过的 tag：老版本这部分没有可比的，只跑现在的代码');

    // ── 二、防双开 ──
    const lroot = path.join(BASE, 'legacy', 'lock');
    const oroot = path.join(BASE, 'legacy', 'lock-other');
    for (const d of [lroot, oroot]) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); }
    const holder = spawnChild(lroot, 'lock', BRAND.formerNames[0], 'hold');
    const held = new Promise((resolve) => holder.once('exit', resolve));
    const t0 = Date.now();
    while (!exists(path.join(lroot, 'lock-hold-ready')) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
    const second = await run(lroot, 'lock', BRAND.name, 'second');
    const twin = await run(lroot, 'lock', BRAND.formerNames[0], 'twin');
    const other = await run(oroot, 'lock', BRAND.name, 'other');
    fs.writeFileSync(path.join(lroot, 'lock-hold-release'), '1');
    await Promise.race([held, new Promise((r) => setTimeout(r, 70000))]);
    const hold = readJson(path.join(lroot, 'lock-hold-report.json'));
    const f = (r) => (r ? r.facts : null);
    check('防双开', `「${BRAND.formerNames[0]}」开着时，「${BRAND.name}」打开同一份数据：让给先开的那个`, !!(hold && second && hold.facts.lock === true && second.facts.lock === false), { hold: f(hold), second: f(second) });
    check('防双开', '确认场景成立：同一个名字再开一个，被拦下', !!(twin && twin.facts.lock === false), f(twin));
    check('防双开', '确认场景成立：另一份数据（别的 AppData）可以同时开', !!(other && other.facts.lock === true), f(other));

    // ── 三、桌面快捷方式 ──
    const sroot = path.join(BASE, 'legacy', 'shortcut');
    await fsp.rm(sroot, { recursive: true, force: true });
    await fsp.mkdir(sroot, { recursive: true });
    const s = await run(sroot, 'shortcut', 'x', 'all');
    const sp = problemsOf(s);
    const sf = (s && s.facts) || {};
    const ok = (k) => !sp.length && sf[k] && sf[k].ok;
    check('快捷方式', '桌面上有按老名字建的、指着原来那个 exe 的快捷方式：改成指新位置，不另建一个', ok('A'), sp.length ? sp.slice(0, 3) : sf.A);
    check('快捷方式', '老名字的快捷方式指着别的地方（另一份启动器）：不动它，按现在的名字新建一个', ok('B'), sf.B);
    check('快捷方式', '桌面上没有快捷方式：按现在的名字新建一个', ok('C'), sf.C);
    check('快捷方式', '新老名字的都指着原来那个 exe：都改成指新位置，不多出来', ok('D'), sf.D);

    if (table.length) {
      console.log('\n版本 | 默认位置 | 便携 | 自定义文件夹');
      const mark = (v) => (v === undefined ? '-' : v ? '过' : '不过');
      for (const r of table) console.log(`${r.tag} | ${mark(r.default)} | ${mark(r.portable)} | ${mark(r.custom)}`);
    }
    if (OUT) fs.appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const bad = results.filter((r) => !r.ok).length;
    console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
    process.exit(bad ? 1 : 0);
  })();
}
