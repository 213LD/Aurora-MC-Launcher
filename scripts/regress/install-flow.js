'use strict';
/**
 * 真实的安装 / 启动流程回归：要联网，要一份装好 1.20.1 的游戏目录省下载（和 game-locks.js 一样的环境变量）。
 *   AURORA_REGRESS_GAME_SRC、AURORA_REGRESS_JAVA_HOME
 * 用法：electron scripts/regress/install-flow.js <场景>
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const H = require('./harness');

const { sleep, waitFor, setup, core, ipc, tree, check, finish } = H;
const SRC = process.env.AURORA_REGRESS_GAME_SRC;
const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
const MC = '1.20.1';

async function common(name) {
  const dirs = setup(`flow-${name}`);
  process.env.AURORA_TEST_TRASH = path.join(dirs.root, 'fake-trash'); // 取消时走回收站的路径，这里不碰真实回收站
  for (const d of ['libraries', 'assets']) await fsp.cp(path.join(SRC, d), path.join(dirs.game, d), { recursive: true });
  await fsp.cp(path.join(SRC, 'versions', MC), path.join(dirs.game, 'versions', MC), { recursive: true });
  await fsp.cp(JAVA, path.join(dirs.data, 'runtime', 'regress-java'), { recursive: true });
  const config = core('config');
  config.set({ setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER, isolation: 'modded', java: { selected: path.join(dirs.data, 'runtime', 'regress-java', 'bin', 'java.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false }, backup: { beforeLaunch: false }, autoChinese: false });
  const bus = ipc();
  await core('auth/accounts').addOffline('RegressPlayer');
  return { ...dirs, bus, config, versions: core('versions'), profiles: core('profiles'), isolation: core('isolation'), tasks: core('tasks') };
}

async function waitTask(tasks, id, ms = 240000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = tasks.get(id);
    if (t && t.status !== 'running') return t;
    await sleep(200); // pitfall-ok：轮询里两次查看之间的间隔
  }
  return tasks.get(id);
}

const SCENARIOS = {
  /** 4-3：启动时点取消（这里在复制测试副本的阶段取消） */
  async 'launch-cancel'() {
    const c = await common('launch-cancel');
    const launcher = core('launcher');
    const dir = path.join(c.game, 'versions', 'SB');
    await fsp.mkdir(dir, { recursive: true });
    const json = JSON.parse(await fsp.readFile(path.join(c.game, 'versions', MC, `${MC}.json`), 'utf8'));
    json.id = 'SB';
    json.clientVersion = MC;
    await fsp.writeFile(path.join(dir, 'SB.json'), JSON.stringify(json));
    await fsp.copyFile(path.join(c.game, 'versions', MC, `${MC}.jar`), path.join(dir, 'SB.jar'));
    c.config.setVersionSettings('SB', { isolation: 'on' });
    await c.profiles.writeMeta('SB', { type: 'custom', isolation: { preset: 'sandbox', source: '@root' } });
    // 来源世界文件多，复制要花时间
    const world = path.join(c.game, 'saves', 'Big', 'region');
    await fsp.mkdir(world, { recursive: true });
    await fsp.writeFile(path.join(c.game, 'saves', 'Big', 'level.dat'), 'x');
    const blob = Buffer.alloc(64 * 1024, 1);
    await Promise.all(Array.from({ length: 3000 }, (_, i) => fsp.writeFile(path.join(world, `r.${i}.0.mca`), blob)));
    await fsp.writeFile(path.join(c.game, 'options.txt'), 'onboardAccessibility:false\nsoundCategory_master:0.0\n');
    const t0 = Date.now();
    const p = c.bus.call('launch:start', 'SB', {});
    let cancelled = false;
    let detail = '';
    for (let i = 0; i < 6000 && !cancelled; i++) {
      const t = c.tasks.list().find((x) => x.kind === 'launch' && x.status === 'running');
      if (t && /副本/.test(t.detail)) { detail = t.detail; c.tasks.cancel(t.id); cancelled = true; }
      await sleep(10); // pitfall-ok：轮询里两次查看之间的间隔
    }
    const r = await p;
    await sleep(800); // pitfall-ok：要证明取消以后游戏「没有」启动，只能等一会儿看
    const games = launcher.listGames();
    check('4-3', '确认场景成立：在复制副本时点了取消', cancelled, detail);
    check('4-3', '取消后游戏没有启动', !games.length, { games: games.length, ok: r.ok, ms: Date.now() - t0 });
    check('4-3', '这次启动报告为已取消', r.ok === false && r.cancelled === true, { ok: r.ok, cancelled: r.cancelled, err: r.error });
    for (const g of games) launcher.kill(g.id);
    for (let i = 0; i < 40 && launcher.running(); i++) await sleep(500);
  },

  /** 4-5、12-1：安装失败后选项丢失、重试永远失败 */
  async 'install-retry'() {
    const c = await common('install-retry');
    const name = 'FailMe';
    // 让一个库文件下载失败：把它的路径占成文件夹
    const json = JSON.parse(await fsp.readFile(path.join(c.game, 'versions', MC, `${MC}.json`), 'utf8'));
    const lib = json.libraries.find((l) => l.downloads && l.downloads.artifact && !l.rules).downloads.artifact.path; // 没有平台限制的库，这台电脑一定要下
    const libFile = path.join(c.game, 'libraries', ...lib.split('/'));
    await fsp.rm(libFile, { force: true });
    await fsp.mkdir(path.join(libFile, 'blocker'), { recursive: true });
    let r = await c.bus.call('versions:install', { mc: MC, name, asProfile: true, isolation: { preset: 'isolated' } });
    check('12-1', '开始安装', r.ok, r.error || '');
    let t = await waitTask(c.tasks, r.data);
    check('12-1', '确认场景成立：安装失败了', t.status === 'failed', { status: t.status, err: String(t.error).slice(0, 80) });
    const listed = (await c.versions.listInstalled()).some((v) => v.id === name);
    check('4-5', '失败后不留下没装好、选项也没生效的配置', !listed, { listed, dir: fs.existsSync(c.versions.versionDir(name)) });
    await fsp.rm(libFile, { recursive: true, force: true });
    r = await c.bus.call('tasks:retry', t.id);
    check('12-1', '点重试：能开始', r.ok, r.error || '');
    if (r.ok) {
      t = await waitTask(c.tasks, r.data);
      check('12-1', '重试：装好了（修之前报「版本已存在」）', t.status === 'done', { status: t.status, err: String(t.error).slice(0, 80) });
      const info = await c.versions.versionInfo(name);
      const own = info && c.versions.gameDirFor(name, info) !== c.versions.gameRoot();
      const meta = await c.profiles.readMeta(name);
      check('4-5', '重试成功后，当初选的存档方式生效', !!own && meta.isolation && meta.isolation.preset === 'isolated', { own: !!own, policy: meta.isolation && meta.isolation.preset });
    }
    // 不能改坏的：别人已有的同名配置，失败时不能被清掉
    await H.fakeVersion('Exists', { loader: false });
    await fsp.writeFile(path.join(c.versions.versionDir('Exists'), 'keep.txt'), 'keep');
    r = await c.bus.call('versions:install', { mc: MC, name: 'Exists' });
    t = await waitTask(c.tasks, r.data);
    check('12-1', '同名配置已存在：报错，原来的文件还在', t.status === 'failed' && /已存在/.test(t.error) && fs.existsSync(path.join(c.versions.versionDir('Exists'), 'keep.txt')), { status: t.status, err: t.error });
    // 文件夹在、JSON 不在（只剩存档的旧配置）：安装失败时只清自己写的，留下的存档不动
    const leftover = c.versions.versionDir('Leftover');
    await fsp.mkdir(path.join(leftover, 'saves', 'W'), { recursive: true });
    await fsp.writeFile(path.join(leftover, 'saves', 'W', 'level.dat'), 'w');
    await fsp.rm(libFile, { recursive: true, force: true });
    await fsp.mkdir(path.join(libFile, 'blocker'), { recursive: true });
    r = await c.bus.call('versions:install', { mc: MC, name: 'Leftover' });
    t = await waitTask(c.tasks, r.data);
    check('12-1', '只剩存档的旧文件夹：安装失败后存档还在', fs.existsSync(path.join(leftover, 'saves', 'W', 'level.dat')), { status: t.status, files: await tree(leftover) });
    await fsp.rm(libFile, { recursive: true, force: true });
  },

  /** 4-2 真实流程：全局不隔离 + 纯净版+ 选独立存档，Mod 要装进自己的目录 */
  async 'vanillaplus-iso'() {
    const c = await common('vanillaplus-iso');
    c.config.set({ isolation: 'none' });
    const name = 'VP';
    const r = await c.bus.call('vanillaplus:install', { mc: MC, name, loader: { type: 'fabric' }, choices: {}, isolation: { preset: 'isolated' } });
    check('4-2', '开始安装纯净版+', r.ok, r.error || '');
    if (!r.ok) return;
    const t = await waitTask(c.tasks, r.data, 400000);
    check('4-2', '纯净版+ 装好了', t.status === 'done', { status: t.status, err: String(t.error).slice(0, 120) });
    const info = await c.versions.versionInfo(name);
    const gd = info ? c.versions.gameDirFor(name, info) : null;
    const rootMods = await fsp.readdir(path.join(c.game, 'mods')).catch(() => []);
    const ownMods = await fsp.readdir(path.join(c.versions.versionDir(name), 'mods')).catch(() => []);
    check('4-2', '选了独立存档：游戏目录是自己的', gd && gd !== c.versions.gameRoot(), { own: gd !== c.versions.gameRoot() });
    check('4-2', '选了独立存档：Mod 装进自己的目录，公共目录没有多东西', ownMods.length > 0 && !rootMods.length, { ownMods: ownMods.length, rootMods: rootMods.length });
  },

  /** 7-5、4-6：同一个 Java 同时装两次 */
  async 'java-shared'() {
    const c = await common('java-shared');
    const rt = (n) => path.join(c.data, 'runtime', n);
    // Temurin 连点两下：以前两边互相删临时文件夹
    let a = await c.bus.call('java:installTemurin', 17, 'jre');
    let b = await c.bus.call('java:installTemurin', 17, 'jre');
    let ta = await waitTask(c.tasks, a.data, 400000);
    let tb = await waitTask(c.tasks, b.data, 400000);
    check('7-5', 'Temurin 连点两下：两个任务都成功', ta.status === 'done' && tb.status === 'done', { a: ta.status, b: tb.status, err: String(ta.error || tb.error).slice(0, 80) });
    check('7-5', 'Temurin 连点两下：装出来是完整的，不留临时文件夹', fs.existsSync(path.join(rt('temurin-17-jre'), 'bin', 'java.exe')) && !fs.existsSync(rt('temurin-17-jre.tmp')), { java: fs.existsSync(path.join(rt('temurin-17-jre'), 'bin', 'java.exe')), tmp: fs.existsSync(rt('temurin-17-jre.tmp')) });

    // 官方运行时：第二个任务要有进度，取消第一个不影响第二个
    a = await c.bus.call('java:installMojang', 'jre-legacy');
    await waitFor(() => { const t = c.tasks.get(a.data); return t && t.bytes && t.bytes.done > 0; }, 60000);
    // 边下载边放进最终目录：下载中有「没装完」的标记，检测 Java 不把它算进去（以前会去运行下了一半的 java.exe）
    const marker = path.join(rt('jre-legacy'), '.aurora-runtime-installing');
    const midway = await core('java').detect(true);
    check('Java', '官方运行时下载中：有没装完的标记，检测 Java 不算它', fs.existsSync(marker) && !midway.some((j) => /jre-legacy/.test(j.home)), { marker: fs.existsSync(marker), listed: midway.filter((j) => /jre-legacy/.test(j.home)).map((j) => j.home) });
    b = await c.bus.call('java:installMojang', 'jre-legacy');
    let seen = 0;
    for (let i = 0; i < 400 && !seen; i++) {
      const t = c.tasks.get(b.data);
      if (t && t.status === 'running' && t.bytes && t.bytes.done > 0) seen = t.bytes.done;
      if (t && t.status !== 'running') break;
      await sleep(50); // pitfall-ok：轮询里两次查看之间的间隔
    }
    check('4-6', '第二个任务也显示下载进度（修之前一直是「准备中」）', seen > 0, { bytes: seen, detail: c.tasks.get(b.data).detail });
    c.tasks.cancel(a.data);
    ta = await waitTask(c.tasks, a.data, 20000);
    check('4-6', '取消第一个任务：它自己马上停下', ta.status === 'cancelled', ta.status);
    tb = await waitTask(c.tasks, b.data, 400000);
    check('4-6', '取消第一个任务：第二个照常装完（修之前跟着失败）', tb.status === 'done' && fs.existsSync(path.join(rt('jre-legacy'), 'bin', 'java.exe')), { b: tb.status, err: String(tb.error).slice(0, 80) });
    const after = await core('java').detect(true);
    check('Java', '官方运行时装完：标记删掉了，检测 Java 认得出来', !fs.existsSync(marker) && after.some((j) => /jre-legacy/.test(j.home)), { marker: fs.existsSync(marker), listed: after.filter((j) => /jre-legacy/.test(j.home)).map((j) => j.home) });

    // 两个都取消：下载真的停下，不留临时文件夹，之后还能再装
    a = await c.bus.call('java:installTemurin', 8, 'jre');
    b = await c.bus.call('java:installTemurin', 8, 'jre');
    await waitFor(() => { const t = c.tasks.get(a.data); return t && t.bytes && t.bytes.done > 0; }, 60000);
    c.tasks.cancel(a.data);
    c.tasks.cancel(b.data);
    ta = await waitTask(c.tasks, a.data, 30000);
    tb = await waitTask(c.tasks, b.data, 30000);
    check('4-6', '两个都取消：都停下', ta.status === 'cancelled' && tb.status === 'cancelled', { a: ta.status, b: tb.status });
    await waitFor(() => !c.tasks.list().some((t) => t.status === 'running'), 15000);
    a = await c.bus.call('java:installTemurin', 8, 'jre');
    ta = await waitTask(c.tasks, a.data, 400000);
    check('4-6', '取消之后再装：能装好', ta.status === 'done', { status: ta.status, err: String(ta.error).slice(0, 80) });
  },

  /** 7-6：同一个配置同时跑两个任务 */
  async 'profile-lock'() {
    const c = await common('profile-lock');
    let r1 = await c.bus.call('versions:complete', MC);
    let r2 = await c.bus.call('versions:complete', MC);
    check('7-6', '同一个配置同时补全两次：第二个被拒绝', r1.ok && !r2.ok, { first: r1.ok, second: r2.ok, err: r2.error });
    let r3 = await c.bus.call('planner:applyEdit', { versionId: MC, plan: { items: [] }, removeMode: 'disable' });
    check('7-6', '补全时再让配置器修改同一个配置：被拒绝', !r3.ok, { ok: r3.ok, err: r3.error });
    await waitTask(c.tasks, r1.data, 300000);
    if (r2.ok) await waitTask(c.tasks, r2.data, 300000);
    if (r3.ok) await waitTask(c.tasks, r3.data, 300000);
    r1 = await c.bus.call('versions:complete', MC);
    check('7-6', '上一个结束后：能再开始', r1.ok, r1.error || '');
    if (r1.ok) await waitTask(c.tasks, r1.data, 300000);
    // 整合包点两次：不能装进同一个文件夹
    const { ZipWriter } = core('zip');
    const pack = path.join(c.root, 'twice.mrpack');
    const w = await ZipWriter.create(pack);
    await w.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'TwicePack', files: [], dependencies: { minecraft: MC } })));
    await w.close();
    r1 = await c.bus.call('modpack:installFile', pack, 'TwicePack', null);
    r2 = await c.bus.call('modpack:installFile', pack, 'TwicePack', null);
    const t1 = await waitTask(c.tasks, r1.data, 300000);
    const t2 = await waitTask(c.tasks, r2.data, 300000);
    const ids = (await c.versions.listInstalled()).map((v) => v.id).filter((n) => n.startsWith('TwicePack'));
    check('7-6', '整合包点两次：各装各的，都成功', t1.status === 'done' && t2.status === 'done' && ids.length === 2, { a: t1.status, b: t2.status, ids, err: String(t1.error || t2.error).slice(0, 80) });
  },

  /** 4-4：整合包解压配置文件、Java 解压时取消 */
  async 'pack-cancel'() {
    const c = await common('pack-cancel');
    const { ZipWriter } = core('zip');
    const pack = path.join(c.root, 'cancel.mrpack');
    const w = await ZipWriter.create(pack);
    await w.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'CancelPack', files: [], dependencies: { minecraft: MC } })));
    const blob = Buffer.alloc(32 * 1024, 7);
    for (let i = 0; i < 3000; i++) await w.addBuffer(`overrides/config/f${i}.bin`, blob);
    await w.close();
    const r = await c.bus.call('modpack:installFile', pack, 'CancelPack', null);
    check('4-4', '开始安装整合包', r.ok, r.error || '');
    if (!r.ok) return;
    let sent = false;
    const end = Date.now() + 240000;
    while (Date.now() < end && !sent) {
      const t = c.tasks.get(r.data);
      if (!t || t.status !== 'running') break;
      if (/解压配置文件/.test(t.detail)) { c.tasks.cancel(r.data); sent = true; }
      await sleep(5); // pitfall-ok：轮询里两次查看之间的间隔
    }
    const t0 = Date.now();
    const t = await waitTask(c.tasks, r.data);
    check('4-4', '整合包解压配置文件时取消：真的停下', sent && t.status === 'cancelled', { sent, status: t.status, ms: Date.now() - t0 });
    check('4-4', '整合包取消后不留半成品配置', !(await c.versions.listInstalled()).some((v) => v.id === 'CancelPack'), '');
  },

  // 整合包不是取消、而是失败（下载不下来）：不留半个配置，重试不会报「已存在」（2.0.0-pre3）
  async 'pack-fail'() {
    const c = await common('pack-fail');
    const http = require('http');
    let ok = false;
    const body = Buffer.from('modfile');
    const sha1 = require('crypto').createHash('sha1').update(body).digest('hex');
    const srv = http.createServer((req, res) => { if (ok) res.end(body); else { res.writeHead(404); res.end(); } });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/x.jar`;
    const { ZipWriter } = core('zip');
    const pack = path.join(c.root, 'fail.mrpack');
    const w = await ZipWriter.create(pack);
    await w.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'FailPack', files: [{ path: 'mods/x.jar', hashes: { sha1 }, env: { client: 'required' }, downloads: [url], fileSize: body.length }], dependencies: { minecraft: '1.20.1' } })));
    await w.close();
    const before = await c.versions.listInstalled();
    const r = await c.bus.call('modpack:installFile', pack, 'FailPack', null);
    check('pack', '开始安装整合包', r.ok, r.error || '');
    if (!r.ok) { srv.close(); return; }
    const t = await waitTask(c.tasks, r.data);
    check('pack', '下载不下来：任务失败', t.status === 'failed', { status: t.status, detail: String(t.detail).slice(0, 100) });
    const list = await c.versions.listInstalled();
    check('pack', '失败后配置列表里没有半个配置', !list.some((v) => v.id === 'FailPack') && list.length === before.length, list.map((v) => v.id));
    check('pack', '失败后文件夹也没留下', !fs.existsSync(c.versions.versionDir('FailPack')), c.versions.versionDir('FailPack').slice(-20));
    // 重试：同样的名字，这次服务器好了
    ok = true;
    const r2 = await c.bus.call('tasks:retry', r.data);
    check('pack', '点重试能开始', r2.ok, r2.error || '');
    if (r2.ok) {
      const t2 = await waitTask(c.tasks, r2.data);
      check('pack', '重试成功，名字不会变成 FailPack-2', t2.status === 'done' && (await c.versions.listInstalled()).some((v) => v.id === 'FailPack'), { status: t2.status, ids: (await c.versions.listInstalled()).map((v) => v.id), detail: String(t2.detail).slice(0, 100) });
      check('pack', '重试后 Mod 在', fs.existsSync(path.join(c.versions.versionDir('FailPack'), 'mods', 'x.jar')));
    }
    await new Promise((res) => srv.close(res));
  },
};

(async () => {
  await app.whenReady();
  const name = process.argv[process.argv.length - 1];
  if (!SRC || !JAVA) { check('flow', '跳过：没设 AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME', true); finish(); return; }
  if (!SCENARIOS[name]) { console.log(`场景：${Object.keys(SCENARIOS).join(' ')}`); finish(2); return; }
  try {
    await SCENARIOS[name]();
  } catch (e) {
    check(name, '脚本运行出错', false, e.stack || String(e));
    try { const l = core('launcher'); for (const g of l.listGames()) l.kill(g.id); } catch { /* ignore */ }
  }
  finish();
})();
