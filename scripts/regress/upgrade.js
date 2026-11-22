'use strict';
/**
 * 数据升级矩阵（2.0.0-pre8，全面测试高优先级第 4 项）：用老版本自己的代码造数据，新版打开；再把新版的数据给老版打开（降级），最后回到新版。
 *   node scripts/regress/upgrade.js [v1.0.0,v1.10.10]
 * 老版本的代码从 git tag 取，放进临时目录，用当前的 Electron 跑。全部关在 sandbox-hook 的隔离层里：
 * 老版本就算有路径上的问题也写不出测试目录。只在 v1.10.10、最新的 pre 上另外打开老版本的真实窗口。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execSync } = require('child_process');

const IS_CHILD = !!process.versions.electron;
const REPO = path.resolve(__dirname, '..', '..');
const TAGS = ['v1.0.0', 'v1.3.0', 'v1.4.29', 'v1.5.6', 'v1.7.4', 'v1.8.0', 'v1.10.0', 'v1.10.6', 'v1.10.7', 'v1.10.10', 'v2.0.0-pre1', 'v2.0.0-pre3', 'v2.0.0-pre6', 'v2.0.0-pre7'];
const OLD_UI = new Set(['v1.10.10', 'v2.0.0-pre7']);

if (IS_CHILD) child(); else parent();

/** 一张真的 64×64 PNG（皮肤库要校验尺寸） */
function skinPng() {
  const crc32 = (b) => zlib.crc32(b) >>> 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((1 + 64 * 4) * 64, 0x55);
  for (let y = 0; y < 64; y++) raw[y * (1 + 64 * 4)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ───────────────────────── 子进程 ─────────────────────────
function child() {
  const { app } = require('electron');
  const { seal } = require('./sandbox-hook');
  const [mode, tag] = process.argv.slice(-2);
  app.whenReady().then(async () => {
    const root = process.env.AURORA_UP_ROOT;
    const data = path.join(root, 'data');
    const game = path.join(root, 'game');
    process.env.AURORA_DATA_DIR = data;
    process.env.AURORA_GAME_DIR = game;
    app.setPath('userData', data);
    const box = seal(root);
    const native = { write: require('fs').writeFileSync };
    const quiet = () => {};
    console.log = quiet; console.warn = quiet; console.error = quiet; console.info = quiet;
    // 用哪一份代码：造数据和降级用老版本，其余用当前
    const srcRoot = mode === 'gen' || mode === 'back' ? process.env.AURORA_UP_SRC : REPO;
    // 老版本都在 core/，2.0.0-pre9 起引擎在 engine/
    const core = (m) => {
      const engine = path.join(srcRoot, 'src', 'main', 'engine', `${m}.js`);
      return require(fs.existsSync(engine) ? engine : path.join(srcRoot, 'src', 'main', 'core', m));
    };
    const report = { tag, mode, problems: [], facts: {} };
    const crashes = [];
    process.on('uncaughtException', (e) => crashes.push(String(e && e.stack).slice(0, 300)));
    process.on('unhandledRejection', (e) => crashes.push(String(e && e.stack).slice(0, 300)));
    try {
      if (mode === 'gen') await gen(core, root, game, report);
      else if (mode === 'check') await check(core, root, game, report, false);
      else if (mode === 'recheck') await check(core, root, game, report, true);
      else if (mode === 'back') await back(core, report);
    } catch (e) {
      report.problems.push(`脚本出错：${String((e && e.stack) || e).slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // 老版本的设置防抖
    for (const c of crashes) report.problems.push(`未捕获的异常：${c}`);
    report.denied = box.log.writes.slice(0, 5);
    box.release();
    native.write(path.join(root, `${mode}-report.json`), JSON.stringify(report, null, 1));
    app.exit(0);
  });
  app.on('window-all-closed', () => {});
}

const tryIt = async (report, label, fn) => {
  try { return await fn(); } catch (e) { report.facts[`${label}-失败`] = String(e && e.message).slice(0, 160); return undefined; }
};

/** 老版本造数据。老版本没有的功能就跳过，并记下来（facts） */
async function gen(core, root, game, report) {
  const config = core('config');
  const versions = core('versions');
  const profiles = core('profiles');
  config.load();
  config.set({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, gameDir: game, language: 'zh-CN', jvmArgs: '-Dold=1', theme: 'light', memory: { auto: false, max: 3072, min: 512 }, selectedVersion: 'OldProf', upgradeMarker: 'keep-me' });
  const mk = async (id, settings, loader) => {
    const dir = versions.versionDir(id);
    await fsp.mkdir(path.join(dir, 'mods'), { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, type: 'release', clientVersion: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: loader ? [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] : [] }));
    if (settings) config.setVersionSettings(id, settings);
    return dir;
  };
  const world = async (dir, name) => {
    await fsp.mkdir(path.join(dir, 'saves', name, 'region'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'saves', name, 'level.dat'), `level-${name}`);
    await fsp.writeFile(path.join(dir, 'saves', name, 'region', 'r.0.0.mca'), Buffer.alloc(4096, 3));
  };
  const prof = await mk('OldProf', { isolation: 'on', jvmArgs: '-Dprof=1' }, true);
  await world(prof, 'OldWorld');
  await fsp.writeFile(path.join(prof, 'mods', 'on.jar'), 'jar');
  await fsp.writeFile(path.join(prof, 'mods', 'off.jar.disabled'), 'jar');
  await fsp.writeFile(path.join(prof, 'options.txt'), 'version:3465\nfov:0.5\n');
  await tryIt(report, 'meta', () => profiles.writeMeta('OldProf', { name: '老配置', description: '老版本写的描述', type: 'custom' }));
  await mk('OldPub', { isolation: 'none' }, false);
  await world(game, 'PubWorld');
  const shared = await mk('OldShared', { isolation: 'on' }, true);
  await world(shared, 'OwnWorld');
  const iso = await tryIt(report, 'isolation', async () => {
    const isolation = core('isolation');
    await isolation.setPolicy('OldShared', { preset: 'shared', source: '@root' });
    await isolation.prepare('OldShared', shared, { allowCopy: false });
    return true;
  });
  report.facts.isolation = !!iso;
  const accounts = core('auth/accounts');
  await tryIt(report, 'account', () => accounts.addOffline('OldSteve'));
  report.facts.plan = !!(await tryIt(report, 'plan', async () => { await core('planner').savePlan({ id: 'oldplan', name: '老方案', mc: '1.20.1', items: [] }); return true; }));
  report.facts.preset = !!(await tryIt(report, 'preset', async () => { await core('mods').savePreset('OldProf', '老预设'); return true; }));
  report.facts.skin = !!(await tryIt(report, 'skin', async () => {
    const skins = core('skins');
    if (!skins.libraryAdd) return false;
    await skins.libraryAdd({ png: skinPng().toString('base64'), model: 'default', name: '老皮肤' });
    return true;
  }));
  report.facts.backup = !!(await tryIt(report, 'backup', async () => {
    const backup = core('backup');
    if (!backup.create) return false;
    const r = await backup.create('OldProf', { type: 'saves' }, { update() {}, signal: new AbortController().signal });
    return !!r;
  }));
  report.facts.gamesync = !!(await tryIt(report, 'gamesync', async () => {
    const g = core('gamesettings');
    await g.captureFrom('OldProf', { replace: true });
    return true;
  }));
  if (config.flush) await config.flush();
  fs.writeFileSync(path.join(root, 'gen-facts.json'), JSON.stringify(report.facts));
}

/** 当前版本读老数据 */
async function check(core, root, game, report, after) {
  const facts = JSON.parse(fs.readFileSync(path.join(root, 'gen-facts.json'), 'utf8'));
  const bad = (t) => report.problems.push(t);
  const config = core('config');
  const versions = core('versions');
  const profiles = core('profiles');
  config.load();
  const c = config.get();
  if (c.jvmArgs !== '-Dold=1') bad(`设置 jvmArgs 变了：${c.jvmArgs}`);
  if (c.theme !== 'light') bad(`设置 theme 变了：${c.theme}`);
  if (!c.memory || c.memory.max !== 3072 || c.memory.auto !== false) bad(`设置 memory 变了：${JSON.stringify(c.memory)}`);
  if (c.selectedVersion !== 'OldProf') bad(`选中的配置变了：${c.selectedVersion}`);
  if (c.setupDone !== true) bad('向导状态丢了，会重新弹首次启动向导');
  if (c.upgradeMarker !== 'keep-me') bad('不认识的设置项丢了');
  if (c.gameDir !== game) bad(`游戏目录变了：${c.gameDir}`);
  const list = await versions.listInstalled();
  const ids = list.map((v) => v.id);
  for (const id of ['OldProf', 'OldPub', 'OldShared']) if (!ids.includes(id)) bad(`配置 ${id} 不在列表里`);
  const vs = config.getVersionSettings('OldProf');
  if (vs.jvmArgs !== '-Dprof=1') bad(`配置的 JVM 参数丢了：${JSON.stringify(vs)}`);
  const meta = await profiles.readMeta('OldProf');
  if (!facts['meta-失败'] && meta.name !== '老配置') bad(`配置显示名丢了：${meta.name}`);
  if (!facts['meta-失败'] && meta.description !== '老版本写的描述') bad(`配置描述丢了：${meta.description}`);
  await profiles.list().catch((e) => bad(`配置档案列表：${e.message}`));
  const { mods } = await core('mods').listMods('OldProf');
  const on = mods.find((m) => /on\.jar/.test(m.file || m.path));
  const off = mods.find((m) => /off\.jar/.test(m.file || m.path));
  if (!on || !on.enabled || !off || off.enabled) bad(`Mod 开关状态不对：${JSON.stringify(mods.map((m) => [m.file || m.path, m.enabled]))}`);
  if (facts.preset) {
    const m2 = await profiles.readMeta('OldProf');
    if (!m2.presets || !Object.keys(m2.presets).length) bad('Mod 预设丢了');
  }
  const accs = core('auth/accounts').list();
  if (!accs.accounts.some((a) => a.name === 'OldSteve')) bad('账户丢了');
  if (!accs.selected) bad('选中的账户丢了');
  if (facts.plan) {
    const plans = await core('planner').listPlans();
    const arr = Array.isArray(plans) ? plans : (plans.plans || []);
    if (!arr.some((p) => p.id === 'oldplan')) bad('方案丢了');
  }
  if (facts.skin) {
    const lib = await core('skins').libraryAll();
    const items = Array.isArray(lib) ? lib : (lib.items || []);
    if (!items.length) bad('皮肤库丢了');
  }
  if (facts.isolation) {
    const pol = await core('isolation').getPolicy('OldShared');
    if (pol.preset !== 'shared') bad(`隔离策略变了：${pol.preset}`);
    const d = versions.versionDir('OldShared');
    if (!fs.existsSync(path.join(d, 'saves.aurora-own', 'OwnWorld', 'level.dat')) && !fs.existsSync(path.join(d, 'saves', 'OwnWorld', 'level.dat'))) bad('共享前自己的世界找不到了');
    await core('isolation').prepare('OldShared', d, { allowCopy: false }).catch((e) => bad(`重新接好共享目录：${e.message}`));
    if (!fs.existsSync(path.join(d, 'saves', 'PubWorld', 'level.dat'))) bad('共享目录里看不到公共世界');
  }
  const worlds = await core('backup').worlds('OldProf').catch((e) => { bad(`世界列表：${e.message}`); return null; });
  if (worlds && !JSON.stringify(worlds).includes('OldWorld')) bad('世界不在列表里');
  if (facts.backup) {
    const bl = await core('backup').list('OldProf');
    const own = (bl && bl.own) || [];
    if (!own.length) bad('备份不在列表里');
    else if (own[0].broken) bad('老备份读不出来');
    else {
      await fsp.rm(path.join(versions.versionDir('OldProf'), 'saves', 'OldWorld', 'level.dat'), { force: true });
      await core('backup').restore('OldProf', own[0].file, { mode: 'overwrite', noAuto: true }, { update() {}, signal: new AbortController().signal }).catch((e) => bad(`恢复老备份失败：${e.message}`));
      const lv = await fsp.readFile(path.join(versions.versionDir('OldProf'), 'saves', 'OldWorld', 'level.dat'), 'utf8').catch(() => null);
      if (lv !== 'level-OldWorld') bad(`恢复老备份后世界内容不对：${lv}`);
    }
  }
  const notes = core('jsonstore').drain ? core('jsonstore').drain(() => {}) : [];
  const corrupt = (notes || []).filter((n) => /corrupt|bad|broken|损坏/.test(JSON.stringify(n)));
  if (corrupt.length) bad(`读老数据报损坏：${JSON.stringify(corrupt).slice(0, 200)}`);
  if (!after) {
    // 新版接着写：设置、账户。之后再给老版本看
    config.set({ jvmArgs: '-Dold=1', newVersionOnly: { a: 1 } });
    await core('auth/accounts').addOffline('NewSteve');
    await core('planner').savePlan({ id: 'newplan', name: '新方案', mc: '1.20.1', items: [] }).catch(() => {});
    await config.flush();
  } else {
    if (!c.newVersionOnly || c.newVersionOnly.a !== 1) bad('降级再回来：新版的设置项丢了');
    if (!accs.accounts.some((a) => a.name === 'NewSteve')) bad('降级再回来：新版加的账户丢了');
    if (!accs.accounts.some((a) => a.name === 'BackSteve')) bad('降级再回来：老版加的账户丢了');
  }
}

/** 老版本读新版写过的数据，并且写一次 */
async function back(core, report) {
  const bad = (t) => report.problems.push(t);
  const config = core('config');
  const versions = core('versions');
  config.load();
  const c = config.get();
  if (c.jvmArgs !== '-Dold=1') bad(`老版本读到的设置不对：${c.jvmArgs}`);
  const ids = (await versions.listInstalled()).map((v) => v.id);
  for (const id of ['OldProf', 'OldPub', 'OldShared']) if (!ids.includes(id)) bad(`老版本看不到配置 ${id}`);
  await core('profiles').list().catch((e) => bad(`老版本读配置档案：${e.message}`));
  await core('mods').listMods('OldProf').catch((e) => bad(`老版本读 Mod：${e.message}`));
  const accs = core('auth/accounts').list();
  if (!accs.accounts.some((a) => a.name === 'OldSteve')) bad('老版本看不到账户');
  await core('auth/accounts').addOffline('BackSteve').catch((e) => bad(`老版本加账户：${e.message}`));
  config.set({ theme: 'light' });
  if (config.flush) await config.flush();
}

// ───────────────────────── 父进程 ─────────────────────────
function parent() {
  const BASE = require('./editions').BASE;
  const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const OUT = process.env.AURORA_REGRESS_OUT;
  // 要哪些老版本（editions.js）：内部版是上面挑的那几版；公开仓库用它自己最近的几个 tag（内部版的 v1.x 和公开版的 v1.x 是不同的代码）
  const ED = require('./editions');
  const old = ED.oldTags(TAGS);
  const pick = process.argv[2] ? process.argv[2].split(',') : old.tags;
  const oldUi = ED.PUBLIC ? new Set(old.tags.slice(-1)) : OLD_UI;
  const results = [];
  const check = (id, name, ok, detail = '') => {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    results.push({ id, name, ok: !!ok, detail: d });
    console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
  };
  const run = (root, srcDir, mode, tag) => new Promise((resolve) => {
    const c = spawn(ELECTRON, [__filename, mode, tag], { env: { ...process.env, AURORA_UP_ROOT: root, AURORA_UP_SRC: srcDir, ELECTRON_ENABLE_LOGGING: '' }, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } resolve(null); }, 90000);
    c.once('exit', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(fs.readFileSync(path.join(root, `${mode}-report.json`), 'utf8'))); } catch { resolve(null); }
    });
  });
  const stage = (tag, label, r) => {
    if (!r) { check(tag, label, false, '没有跑完（可能卡死或崩溃）'); return false; }
    const denied = r.denied && r.denied.length ? [`隔离层拦下写到外面：${JSON.stringify(r.denied[0])}`] : [];
    const p = [...r.problems, ...denied];
    check(tag, label, p.length === 0, p.slice(0, 6));
    return p.length === 0;
  };
  (async () => {
    const { start, visitAll } = require('./robust-ui');
    const table = [];
    if (old.missing.length && !process.argv[2]) console.log(`  跳过 ${old.missing.length} 个老版本：这份代码里没有它们的 git tag（${old.missing.join('、')}）`);
    if (!pick.length) check('老版本', '没有可比的老版本（公开仓库还没有发布过的 tag），跳过', true, '');
    for (const tag of pick) {
      // 按提交号缓存（和 legacy-location.js 共用）：两个仓库同名的 tag 是不同的代码
      const srcDir = ED.oldSrcDir(BASE, tag);
      if (!srcDir) { check(tag, '找得到这个版本的代码', false, '这份代码里没有这个 git tag'); continue; }
      if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
        fs.mkdirSync(srcDir, { recursive: true });
        execSync(`git archive --format=tar ${tag} src package.json | tar -x -C "${srcDir.split(path.sep).join('/')}"`, { cwd: REPO, stdio: 'pipe', shell: 'bash' });
      }
      const root = path.join(BASE, 'upgrade', tag);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.mkdir(root, { recursive: true });
      const g = await run(root, srcDir, 'gen', tag);
      const row = { tag };
      row.gen = !!g && !g.problems.length;
      if (!row.gen) { check(tag, '老版本造数据', false, g ? g.problems.slice(0, 4) : '没跑完'); table.push(row); continue; }
      console.log(`  ${tag} 造了：${JSON.stringify(g.facts)}`);
      row.read = stage(tag, '当前版本读老数据', await run(root, srcDir, 'check', tag));
      // 真实窗口打开老数据
      const a = await start(`up-${tag}`, { root, keepData: true });
      if (a.startError) { check(tag, '当前版本的窗口打开老数据', false, a.startError); row.ui = false; } else {
        const blank = await visitAll(a);
        const list = await a.ev('A.state.installed.map((v) => v.id).join()').catch((e) => e.message);
        const lg = a.log();
        const prob = [...blank, ...a.errors.slice(0, 3), ...lg.crashes.slice(0, 2).map((c) => c.text)];
        if (!/OldProf/.test(list)) prob.push(`配置列表：${list}`);
        row.ui = prob.length === 0;
        check(tag, '当前版本的窗口打开老数据：各页不报错', row.ui, prob.slice(0, 4));
        await a.stop();
      }
      row.back = stage(tag, '老版本再读新版写过的数据（降级）', await run(root, srcDir, 'back', tag));
      if (oldUi.has(tag)) {
        const o = await start(`old-${tag}`, { root, keepData: true, appDir: srcDir });
        if (o.startError) { check(tag, '老版本的真实窗口打开新数据', false, o.startError); row.oldui = false; } else {
          const blank = await visitAll(o);
          const lg = o.log();
          const prob = [...blank, ...o.errors.slice(0, 3), ...lg.crashes.slice(0, 2).map((c) => c.text)];
          row.oldui = prob.length === 0;
          check(tag, '老版本的真实窗口打开新数据：各页不报错', row.oldui, prob.slice(0, 4));
          await o.stop();
        }
      }
      row.again = stage(tag, '回到当前版本：什么都没丢', await run(root, srcDir, 'recheck', tag));
      table.push(row);
    }
    console.log('\n版本 | 造数据 | 新版读 | 新版窗口 | 降级读 | 老版窗口 | 回新版');
    const mark = (v) => (v === undefined ? '-' : v ? '过' : '不过');
    for (const r of table) console.log(`${r.tag} | ${mark(r.gen)} | ${mark(r.read)} | ${mark(r.ui)} | ${mark(r.back)} | ${mark(r.oldui)} | ${mark(r.again)}`);
    fs.writeFileSync(path.join(BASE, 'upgrade-report.json'), JSON.stringify({ table, results }, null, 1));
    if (OUT) fs.appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const bad = results.filter((r) => !r.ok).length;
    console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
    process.exit(bad ? 1 : 0);
  })();
}
