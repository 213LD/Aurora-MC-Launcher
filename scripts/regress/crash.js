'use strict';
/**
 * 崩溃恢复（2.0.0-pre8，全面测试高优先级第 5 项）：每个会写文件的操作，在每一个写入步骤上杀掉进程，重启后检查。
 *   node scripts/regress/crash.js [操作,操作]
 *
 * 做法不靠碰运气的时间点：先空跑一遍数出这个操作有多少步写入，然后第 N 次运行在第 N 步（写文件的话写一半）
 * 直接终止进程，不给任何清理的机会。接着另起进程模拟重启，检查：
 *   丢数据    世界、Mod、账户、方案的内容在磁盘上哪儿都找不到了（最严重）
 *   看不见    内容还在，但重启后的启动器看不到（比如世界留在临时文件夹里，玩家不知道）
 *   读不了    设置、配置列表这些读出错
 *   卡住      重启后再做一次同样的操作做不成
 * 全部在 sandbox-hook 的隔离层里跑。这模拟的是进程崩溃和杀进程树，**不是真的断电**：
 * 断电时系统缓存丢失的情况测不出来，靠代码保证（writeSynced）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const IS_CHILD = !!process.versions.electron;
const REPO = path.resolve(__dirname, '..', '..');

if (IS_CHILD) child(); else parent();

// ───────────────────────── 重启后要看的东西 ─────────────────────────
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

function walkFiles(dir, out = []) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// ───────────────────────── 子进程（Electron 里） ─────────────────────────
function child() {
  const { app } = require('electron');
  const H = require('./harness');
  const { seal } = require('./sandbox-hook');
  const [mode, opName, killAt] = process.argv.slice(-3);
  const N = Number(killAt) || 0;
  const native = { append: fs.appendFileSync, write: fs.writeFileSync };

  /** 在第 N 步写入时直接终止。写文件的话先写一半，像真的写到一半崩了 */
  function arm(rootDir) {
    let count = 0;
    const logFile = path.join(rootDir, 'kill.log');
    const die = (op, p) => {
      native.append(logFile, `${count}\t${op}\t${path.relative(rootDir, String(p))}\n`);
      process.kill(process.pid, 'SIGKILL');
      // Windows 上是 TerminateProcess，到不了这里
      for (;;) { /* 等死 */ }
    };
    const step = (op, p, half) => {
      count++;
      if (N && count === N) {
        if (half) { try { half(); } catch { /* 写不了也一样要死 */ } }
        die(op, p);
      }
    };
    const halfOf = (p, data) => () => {
      if (typeof p !== 'string') return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      native.write(p, buf.subarray(0, Math.floor(buf.length / 2)));
    };
    const wrapP = (name, idx = 0) => {
      const orig = fsp[name];
      fsp[name] = function (...a) {
        step(name, a[idx], name === 'writeFile' ? halfOf(a[0], a[1]) : null);
        return orig.apply(this, a);
      };
    };
    for (const n of ['writeFile', 'appendFile', 'rename', 'rm', 'rmdir', 'unlink', 'mkdir', 'symlink']) wrapP(n);
    wrapP('copyFile', 1);
    const open = fsp.open;
    fsp.open = function (p, flags, ...rest) {
      if (/[wa+]/.test(String(flags || 'r'))) step('open', p);
      return open.call(this, p, flags, ...rest);
    };
    const wrapS = (name, idx = 0) => {
      const orig = fs[name];
      fs[name] = function (...a) {
        step(name, a[idx], name === 'writeFileSync' ? halfOf(a[0], a[1]) : null);
        return orig.apply(this, a);
      };
    };
    for (const n of ['writeFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'mkdirSync']) wrapS(n);
    return () => count;
  }

  const fakeTask = () => ({ signal: new AbortController().signal, update() {}, cancelled: false });

  app.whenReady().then(async () => {
    const root = process.env.AURORA_CRASH_ROOT;
    const data = path.join(root, 'data');
    const game = path.join(root, 'game');
    process.env.AURORA_DATA_DIR = data;
    process.env.AURORA_GAME_DIR = game;
    app.setPath('userData', data);
    const box = seal(root);
    // 不联网也能装原版：版本列表和版本文件用假的回答
    const { net } = require('electron');
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    net.fetch = async (u) => {
      const url = String(u && u.url ? u.url : u);
      if (/version_manifest/.test(url)) return json({ latest: { release: '1.20.1', snapshot: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: 'https://piston-meta.mojang.com/v1/1.20.1.json' }] });
      if (/1\.20\.1\.json/.test(url)) return json({ id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], javaVersion: { majorVersion: 17, component: 'java-runtime-gamma' }, downloads: { client: { url: 'https://piston-data.mojang.com/client.jar' } } });
      if (/client\.jar/.test(url)) return new Response('fake-client-jar', { status: 200 });
      return new Response('nope', { status: 404 });
    };
    const log = console.log.bind(console);
    console.error = () => {}; console.warn = () => {}; console.info = () => {}; console.log = () => {};
    const core = H.core;
    const report = {};
    try {
      if (mode === 'prepare') await prepare(core, root, game, fakeTask);
      if (mode === 'run') {
        const config = core('config'); config.load();
        const op = OPS(core, root, fakeTask)[opName];
        const counted = arm(root);
        await op.run();
        await core('util').queuedDone().catch(() => {});
        await config.flush().catch(() => {});
        report.steps = counted();
      }
      if (mode === 'verify') {
        const config = core('config'); config.load();
        const recover = safeRequire(core, 'recover');
        if (recover) await recover.run({ maxAge: 0 });
        report.problems = await verify(core, root, game, opName, fakeTask);
      }
    } catch (e) {
      report.error = String((e && e.stack) || e).slice(0, 800);
    }
    box.release();
    native.write(path.join(root, `${mode}-report.json`), JSON.stringify(report));
    void log;
    app.exit(0);
  });
  app.on('window-all-closed', () => {});
}

function safeRequire(core, name) { try { return core(name); } catch { return null; } }

/** 一份共用的数据，每次测试前原样复制回来 */
async function prepare(core, root, game, fakeTask) {
  const config = core('config');
  const versions = core('versions');
  const profiles = core('profiles');
  const planner = core('planner');
  const accounts = core('auth/accounts');
  const isolation = core('isolation');
  const backup = core('backup');
  const migrate = core('migrate');
  const nbt = core('nbt');
  const zlib = require('zlib');
  config.load();
  config.set({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, language: 'zh-CN', gameDir: game, selectedVersion: 'Prof', marker: 'golden', tips: { noJava: true } });
  const mk = async (id, settings, loader = true) => {
    const dir = versions.versionDir(id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, type: 'release', clientVersion: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: loader ? [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] : [] }));
    if (settings) config.setVersionSettings(id, settings);
    await profiles.writeMeta(id, { type: 'custom', name: id });
    return dir;
  };
  const T = nbt.T;
  const world = async (dir, name, seed) => {
    const w = path.join(dir, 'saves', name);
    await fsp.mkdir(path.join(w, 'region'), { recursive: true });
    await fsp.writeFile(path.join(w, 'level.dat'), zlib.gzipSync(nbt.serialize({ name: '', value: { Data: { type: T.COMPOUND, value: { LevelName: { type: T.STRING, value: name }, GameType: { type: T.INT, value: 0 } } } } })));
    await fsp.writeFile(path.join(w, 'region', 'r.0.0.mca'), crypto.createHash('sha512').update(seed).digest().toString('hex').repeat(600));
    await fsp.writeFile(path.join(w, 'session.lock'), 'x');
  };
  const prof = await mk('Prof', { isolation: 'on' });
  await world(prof, 'World1', 'prof-world-1');
  await world(prof, 'World2', 'prof-world-2');
  await fsp.mkdir(path.join(prof, 'mods'), { recursive: true });
  await fsp.writeFile(path.join(prof, 'mods', 'a.jar'), 'jar-a-content');
  await fsp.writeFile(path.join(prof, 'mods', 'b.jar'), 'jar-b-content');
  await fsp.mkdir(path.join(prof, 'config'), { recursive: true });
  await fsp.writeFile(path.join(prof, 'config', 'x.toml'), 'config-x-content');
  await fsp.writeFile(path.join(prof, 'options.txt'), 'version:3465\nfov:0.5\n');
  const src = await mk('Src', { isolation: 'on' });
  await world(src, 'SrcWorld', 'src-world');
  await mk('Pub', { isolation: 'none' }, false);
  await world(game, 'PubWorld', 'public-world');
  // 测试副本：转正、删除都要用
  const sand = await mk('Sand', { isolation: 'on' });
  await profiles.writeMeta('Sand', { isolation: { preset: 'sandbox', source: '@root' } });
  await isolation.prepare('Sand', sand, { allowCopy: true }).catch(() => {});
  await fsp.writeFile(path.join(sand, 'options.txt'), 'version:3465\nfov:0.9\n');
  await accounts.addOffline('Steve');
  await planner.savePlan({ id: 'p1', name: 'PlanOne', mc: '1.20.1', items: [] });
  // 备份和导入包
  const b = await backup.create('Prof', { type: 'saves', worlds: ['World1'] }, fakeTask());
  // 备份之后世界又变了，恢复才能看出是不是真的换了回去
  await fsp.writeFile(path.join(prof, 'saves', 'World1', 'region', 'r.0.0.mca'), crypto.createHash('sha512').update('prof-world-1-later').digest().toString('hex').repeat(600));
  await fsp.mkdir(path.join(root, 'in'), { recursive: true });
  const pack = path.join(root, 'in', 'pack.aurora');
  await migrate.exportData({ ...migrate.DEFAULT_OPTS, settings: false, accounts: true, skins: false, plans: true }, ['Src'], pack, fakeTask());
  await writeMrpack(core, path.join(root, 'in', 'pack.mrpack'));
  const s = await core('util').queuedDone().catch(() => {});
  void s;
  await config.flush();
  await fsp.writeFile(path.join(root, 'in', 'meta.json'), JSON.stringify({ backup: b.file }));
}

async function writeMrpack(core, file) {
  const { ZipWriter } = core('zip');
  const z = await ZipWriter.create(file);
  await z.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'PackP', dependencies: { minecraft: '1.20.1' }, files: [] })));
  await z.addBuffer('overrides/config/pack.txt', Buffer.from('pack-config'));
  await z.addBuffer('overrides/mods/pack.jar', Buffer.from('pack-jar'));
  await z.close();
}

/** 每个操作。keep：操作前后都必须能看到的内容（配置 id → 世界名） */
function OPS(core, root, fakeTask) {
  const meta = () => JSON.parse(fs.readFileSync(path.join(root, 'in', 'meta.json'), 'utf8'));
  const c = (m) => core(m);
  return {
    'config-save': { run: async () => { c('config').set({ jvmArgs: '-Xtest', marker2: 'x'.repeat(4000) }); await c('config').flush(); } },
    'accounts-save': { run: () => c('auth/accounts').addOffline('Alex') },
    'meta-save': { run: () => c('profiles').writeMeta('Prof', { description: 'd'.repeat(3000) }) },
    'plan-save': { run: () => c('planner').savePlan({ id: 'p2', name: 'PlanTwo', mc: '1.20.1', items: [] }) },
    rename: {
      run: async () => { await c('versions').renameVersion('Prof', 'Prof2'); await c('isolation').renameSource('Prof', 'Prof2').catch(() => {}); },
      alias: { Prof: ['Prof', 'Prof2'] },
      retry: async (ids) => (ids.includes('Prof') ? c('versions').renameVersion('Prof', 'Prof2') : null),
    },
    duplicate: { run: () => c('profiles').duplicate('Prof', 'Dup', {}), optional: ['Dup'], retry: async (ids) => (ids.includes('Dup') ? null : c('profiles').duplicate('Prof', 'Dup', {})) },
    'set-shared': {
      run: async () => { await c('isolation').setPolicy('Prof', { preset: 'shared', source: '@root' }); await c('isolation').prepare('Prof', c('versions').versionDir('Prof'), { allowCopy: false }); },
      retry: async () => { await c('isolation').setPolicy('Prof', { preset: 'isolated' }); await c('isolation').prepare('Prof', c('versions').versionDir('Prof'), { allowCopy: false }); },
      worldsAfterRetry: true,
    },
    'backup-create': { run: () => c('backup').create('Prof', { type: 'saves' }, fakeTask()) },
    'backup-restore': { mayLose: ['World1/region'], run: () => c('backup').restore('Prof', meta().backup, { mode: 'overwrite', worlds: ['World1'], noAuto: true }, fakeTask()), retry: () => c('backup').restore('Prof', meta().backup, { mode: 'overwrite', worlds: ['World1'], noAuto: true }, fakeTask()) },
    promote: { run: () => c('promote').promote('Sand', {}, fakeTask()), retry: () => c('promote').promote('Sand', {}, fakeTask()) },
    'world-import': { run: () => core('worldimport').importWorlds('Src', 'Prof', ['World1'], fakeTask()), retry: () => core('worldimport').importWorlds('Src', 'Prof', ['World2'], fakeTask()) },
    'world-delete': { run: () => c('backup').deleteWorld('Prof', 'World2'), mayLose: ['World2'] },
    'mods-disable': { run: () => c('mods').disableAll('Prof'), retry: () => c('mods').restoreAll('Prof') },
    'mods-toggle': { run: () => c('mods').toggleMod(path.join(c('versions').versionDir('Prof'), 'mods', 'a.jar'), false) },
    'pack-install': { run: () => c('modpack').installMrpack(path.join(root, 'in', 'pack.mrpack'), { name: 'PackP' }, fakeTask()), optional: ['PackP'], retry: async () => c('modpack').installMrpack(path.join(root, 'in', 'pack.mrpack'), { name: 'PackP' }, fakeTask()) },
    bring: { run: () => core('isoworlds').bring('Pub', { preset: 'isolated' }, ['PubWorld'], fakeTask()), retry: () => core('isoworlds').bring('Pub', { preset: 'isolated' }, ['PubWorld'], fakeTask()) },
    'pack-export': { run: () => c('modpack').exportMrpack('Prof', path.join(root, 'in', 'out.mrpack'), {}, fakeTask()) },
    'migrate-export': { run: () => c('migrate').exportData({ ...c('migrate').DEFAULT_OPTS, settings: true }, ['Prof'], path.join(root, 'in', 'out.aurora'), fakeTask()) },
    'migrate-import': {
      run: async () => { await c('versions').removeVersion('Src', {}); await c('migrate').importData({ file: path.join(root, 'in', 'pack.aurora') }, { settings: false, accounts: true, plans: true, skins: false, profiles: { Src: { action: 'import', as: 'Src' } } }, fakeTask()); },
      optional: ['Src'],
    },
    remove: { run: () => c('versions').removeVersion('Src', {}), optional: ['Src'] },
    'skin-add': {
      run: () => {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAJ0lEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAD8GEBAAAFvVYj8AAAAAElFTkSuQmCC', 'base64');
        return c('skins').libraryAdd({ png: png.toString('base64'), model: 'default', name: 'S1' }).catch((e) => { if (!/皮肤|尺寸|大小|PNG|png/.test(e.message)) throw e; });
      },
    },
  };
}

/** 重启后看一遍。返回问题列表 */
async function verify(core, root, game, opName, fakeTask) {
  const problems = [];
  const note = (kind, text) => problems.push({ kind, text: String(text).slice(0, 240) });
  const op = OPS(core, root, fakeTask)[opName];
  const config = core('config');
  const versions = core('versions');
  const cfg = config.get();
  if (cfg.marker !== 'golden' || !cfg.setupDone) note('读不了', `设置丢了：marker=${cfg.marker} setupDone=${cfg.setupDone}`);
  const list = await versions.listInstalled().catch((e) => { note('读不了', `配置列表：${e.message}`); return []; });
  const ids = list.map((v) => v.id);
  const expectIds = ['Prof', 'Src', 'Pub', 'Sand'];
  for (const id of expectIds) {
    const names = (op.alias && op.alias[id]) || [id];
    if ((op.optional || []).includes(id)) continue;
    if (!names.some((n) => ids.includes(n))) note('看不见', `配置 ${id} 不在列表里（现在：${ids.join(',')}）`);
  }
  await core('profiles').list().catch((e) => note('读不了', `档案列表：${e.message}`));
  const acc = core('auth/accounts').list();
  const accList = (acc && acc.accounts) || acc || [];
  if (!accList.some((a) => a.name === 'Steve')) note('丢数据', '账户 Steve 没了');
  const plans = await core('planner').listPlans().catch((e) => { note('读不了', `方案：${e.message}`); return []; });
  const planList = Array.isArray(plans) ? plans : (plans.plans || []);
  if (!planList.some((p) => p.id === 'p1')) note('丢数据', '方案 p1 没了');
  // 世界：内容在磁盘上还在，并且配置看得到
  const golden = JSON.parse(fs.readFileSync(path.join(root, 'in', 'golden.json'), 'utf8'));
  const all = new Map();
  for (const f of walkFiles(root)) {
    try { const h = sha(fs.readFileSync(f)); if (!all.has(h)) all.set(h, path.relative(root, f)); } catch { /* 读不了 */ }
  }
  for (const [rel, hash] of Object.entries(golden)) {
    if (op.mayLose && op.mayLose.some((m) => rel.includes(m))) continue;
    if (!all.has(hash)) note('丢数据', `内容找不到了：${rel}`);
  }
  // 配置看得到的世界
  const profDir = ['Prof', 'Prof2'].map((id) => versions.versionDir(id)).find((d) => fs.existsSync(d));
  if (profDir && !(op.worldsAfterRetry)) {
    for (const w of ['World1', 'World2']) {
      if (op.mayLose && op.mayLose.includes(w)) continue;
      const lv = path.join(profDir, 'saves', w, 'level.dat');
      if (!fs.existsSync(lv)) note('看不见', `世界 ${w} 不在 saves 里了`);
    }
    // 看得到的世界必须是完整的（恢复备份到一半时，半个世界不能顶替原来的）
    const mca = path.join(profDir, 'saves', 'World1', 'region', 'r.0.0.mca');
    if (fs.existsSync(mca)) {
      const h = sha(fs.readFileSync(mca));
      const known = [golden['game/versions/Prof/saves/World1/region/r.0.0.mca'], sha(crypto.createHash('sha512').update('prof-world-1').digest().toString('hex').repeat(600))];
      if (!known.includes(h)) note('看不见', `World1 的区域文件是半截的（${fs.statSync(mca).size} 字节）`);
    } else if (fs.existsSync(path.dirname(path.dirname(mca)))) note('看不见', 'World1 没有区域文件（半个世界）');
  }
  // 半截的配置不能在列表里占位
  for (const id of (op.optional || [])) {
    if (ids.includes(id)) {
      const j = await core('util').readJson(versions.versionJsonPath(id)).catch(() => null);
      if (!j) note('读不了', `配置 ${id} 在列表里但版本文件读不出来`);
    }
  }
  // 再做一次
  if (op.retry) {
    try {
      await op.retry(ids);
      await core('util').queuedDone().catch(() => {});
    } catch (e) {
      if (!e.cancelled) note('卡住', `重启后再做一次失败：${e.message}`);
    }
    if (op.worldsAfterRetry) {
      const d = versions.versionDir('Prof');
      for (const w of ['World1', 'World2']) if (!fs.existsSync(path.join(d, 'saves', w, 'level.dat'))) note('看不见', `切回独立后世界 ${w} 不见了`);
    }
  }
  // 留下的临时文件：不算丢数据，但记下来
  const junk = [];
  const jw = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/\.aurora-(restore|promote-tmp|tmp|new|old)|aurora-bring-tmp|\.tmp$|\.corrupt-/.test(e.name)) junk.push(path.relative(root, path.join(d, e.name)));
      // Chromium 自己的缓存目录不算（测试进程也是 Electron）
      if (e.isDirectory() && !/^(fakehome|trash|in|Code Cache|Shared Dictionary|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Cache|Network|Session Storage|Local Storage|blob_storage|WebStorage)$/.test(e.name)) jw(path.join(d, e.name));
    }
  };
  jw(root);
  if (junk.length) note('残留', junk.slice(0, 3).join(' ; '));
  return problems;
}

// ───────────────────────── 父进程 ─────────────────────────
function parent() {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { spawn } = require('child_process');
  const BASE = require('./editions').BASE;
  const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const OUT = process.env.AURORA_REGRESS_OUT;
  const MAX_KILLS = Number(process.env.AURORA_CRASH_MAX || 40);
  const WORKERS = Number(process.env.AURORA_CRASH_WORKERS || 4);
  const ALL_OPS = ['config-save', 'accounts-save', 'meta-save', 'plan-save', 'rename', 'duplicate', 'set-shared', 'backup-create', 'backup-restore', 'promote', 'world-import', 'world-delete', 'mods-disable', 'mods-toggle', 'pack-install', 'bring', 'pack-export', 'migrate-export', 'migrate-import', 'remove', 'skin-add'];
  const pick = process.argv[2] ? process.argv[2].split(',') : ALL_OPS;
  const run = (root, mode, op, n) => new Promise((resolve) => {
    const c = spawn(ELECTRON, [__filename, mode, op, String(n)], { env: { ...process.env, AURORA_CRASH_ROOT: root, ELECTRON_ENABLE_LOGGING: '' }, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } resolve({ timeout: true }); }, 60000);
    c.once('exit', (code) => { clearTimeout(timer); resolve({ code }); });
  });
  const readReport = (root, mode) => { try { return JSON.parse(fs.readFileSync(path.join(root, `${mode}-report.json`), 'utf8')); } catch { return null; } };
  void spawnSync;

  (async () => {
    fs.mkdirSync(BASE, { recursive: true });
    const golden = path.join(BASE, 'crash-golden');
    await fsp.rm(golden, { recursive: true, force: true });
    await fsp.mkdir(golden, { recursive: true });
    await run(golden, 'prepare', 'none', 0);
    const pr = readReport(golden, 'prepare');
    if (!pr || pr.error) { console.log(`FAIL [崩溃] 准备数据失败 — ${pr && pr.error}`); process.exit(1); }
    await fsp.rm(path.join(golden, 'prepare-report.json'), { force: true });
    // 记下世界、Mod 这些内容的指纹。session.lock 不算：复制时本来就跳过
    const fp = {};
    for (const f of walkFiles(golden)) {
      const rel = path.relative(golden, f).split(path.sep).join('/');
      if (/saves\/.*\/(level\.dat|region\/)|\/mods\/.*\.jar$|\/config\/x\.toml$/.test(rel) && !/\.aurora-/.test(rel)) fp[rel] = sha(fs.readFileSync(f));
    }
    fs.writeFileSync(path.join(golden, 'in', 'golden.json'), JSON.stringify(fp));
    const results = [];
    /** 共享配置里有联接，指向的是绝对路径：复制时要换成新目录里对应的位置（fs.cp 做不到，还要管理员权限） */
    const copyTree = async (from, to, top = from, topTo = to) => {
      await fsp.mkdir(to, { recursive: true });
      for (const e of await fsp.readdir(from, { withFileTypes: true })) {
        const s = path.join(from, e.name);
        const d = path.join(to, e.name);
        if (e.isSymbolicLink()) {
          const target = path.resolve(await fsp.readlink(s));
          const rel = path.relative(top, target);
          await fsp.symlink(rel.startsWith('..') ? target : path.join(topTo, rel), d, 'junction');
        } else if (e.isDirectory()) await copyTree(s, d, top, topTo);
        else await fsp.copyFile(s, d);
      }
    };
    const restore = async (root) => {
      await fsp.rm(root, { recursive: true, force: true });
      await copyTree(golden, root);
      // 备份路径在 meta.json 里是绝对路径，换成这个目录的
      const mf = path.join(root, 'in', 'meta.json');
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      m.backup = path.join(root, path.relative(golden, m.backup));
      fs.writeFileSync(mf, JSON.stringify(m));
      // 设置里的游戏目录也是绝对路径
      const cf = path.join(root, 'data', 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cf, 'utf8'));
      cfg.gameDir = path.join(root, 'game');
      fs.writeFileSync(cf, JSON.stringify(cfg));
    };
    const doOp = async (op) => {
      const root = path.join(BASE, `crash-${op}`);
      await restore(root);
      await run(root, 'run', op, 0);
      const dry = readReport(root, 'run');
      if (!dry || dry.error) { results.push({ op, fatal: `空跑失败：${dry && dry.error}` }); return; }
      const M = dry.steps;
      const stride = Math.max(1, Math.ceil(M / MAX_KILLS));
      const found = [];
      let kills = 0;
      for (let n = 1; n <= M; n += stride) {
        await restore(root);
        const r = await run(root, 'run', op, n);
        const log = fs.existsSync(path.join(root, 'kill.log')) ? fs.readFileSync(path.join(root, 'kill.log'), 'utf8').trim() : '';
        if (!log) continue; // 这一次没走到第 n 步（异步顺序有变化），不算
        kills++;
        void r;
        await run(root, 'verify', op, 0);
        const v = readReport(root, 'verify');
        if (!v) { found.push({ n, step: log, kind: '读不了', text: '重启检查没跑完（可能卡死或崩溃）' }); continue; }
        if (v.error) found.push({ n, step: log, kind: '读不了', text: v.error });
        for (const p of v.problems || []) found.push({ n, step: log, ...p });
      }
      results.push({ op, steps: M, kills, found });
      const bad = found.filter((f) => f.kind !== '残留');
      console.log(`  ${op}：${M} 步，杀了 ${kills} 次，问题 ${bad.length}，残留 ${found.length - bad.length}`);
    };
    const queue = [...pick];
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      while (queue.length) await doOp(queue.shift());
    }));
    fs.writeFileSync(path.join(BASE, 'crash-report.json'), JSON.stringify(results, null, 1));
    const lines = [];
    for (const kind of ['丢数据', '看不见', '读不了', '卡住']) {
      const hits = [];
      for (const r of results) for (const f of r.found || []) if (f.kind === kind) hits.push(`${r.op}#${f.n}(${f.step.split('\t')[1]} ${f.step.split('\t')[2] || ''}): ${f.text}`);
      const ok = hits.length === 0;
      console.log(`${ok ? 'PASS' : 'FAIL'} [崩溃] 每个写入步骤杀进程，重启后没有「${kind}」${ok ? '' : ` — ${hits.length} 处，例如 ${hits.slice(0, 4).join(' | ').slice(0, 900)}`}`);
      lines.push({ id: '崩溃', name: `每个写入步骤杀进程，重启后没有「${kind}」`, ok, detail: hits.slice(0, 6).join(' | ') });
    }
    const fatal = results.filter((r) => r.fatal);
    console.log(`${fatal.length ? 'FAIL' : 'PASS'} [崩溃] 每个操作都能空跑${fatal.length ? ` — ${JSON.stringify(fatal).slice(0, 700)}` : ''}`);
    lines.push({ id: '崩溃', name: '每个操作都能空跑', ok: !fatal.length, detail: JSON.stringify(fatal).slice(0, 500) });
    const total = results.reduce((s, r) => s + (r.kills || 0), 0);
    console.log(`  一共杀了 ${total} 次进程`);
    if (OUT) fs.appendFileSync(OUT, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    process.exit(lines.some((l) => !l.ok) ? 1 : 0);
  })();
}
