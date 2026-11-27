'use strict';
/**
 * 不需要真实启动游戏的数据安全回归（用 run.js 跑；单独跑一个：electron scripts/regress/data-safety.js <场景>）。
 * 编号是修这些问题时用的条目号。脚本只用公开接口和 IPC 处理函数，修之前修之后都能跑，方便对比。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const H = require('./harness');

const { sleep, waitFor, setup, core, ipc, lockFile, fakeVersion, tree, findWithContent, check, finish } = H;
const truncated = (obj) => { const s = JSON.stringify(obj, null, 2); return s.slice(0, Math.floor(s.length * 0.6)); };
const noticesOf = async (bus) => { const r = await bus.call('app:dataNotices'); return r && r.ok ? r.data : []; };

/** 修之前占用时也可能真的进了回收站：把这个测试文件夹拿回来接着测（只认这个名字） */
async function restoreOwn(name, target) {
  if (process.env.AURORA_REGRESS_REAL_TRASH !== '1') return;
  const { execFileSync } = require('child_process');
  const cmd = '$bin=(New-Object -ComObject Shell.Application).Namespace(10); $hit=@($bin.Items() | Where-Object { $_.Name -eq $env:T_NAME }); if ($hit.Count -ne 1) { "found:$($hit.Count)"; exit }; (New-Object -ComObject Shell.Application).Namespace($env:T_DIR).MoveHere($hit[0], 0x14); Start-Sleep 2; "restored"';
  console.log(`  已进回收站的测试文件夹：${execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, env: { ...process.env, T_NAME: name, T_DIR: path.dirname(target) } }).trim()}`);
}

const SCENARIOS = {
  // ── 11-1 config.json ──
  async 'config-nobak'() {
    const { data } = setup('config-nobak');
    const bad = truncated({ gameDir: 'D:\\my-game', setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER, theme: 'light', versionSettings: { X: { isolation: 'on' } } });
    await fsp.writeFile(path.join(data, 'config.json'), bad);
    const config = core('config');
    config.get();
    const bus = ipc();
    check('11-1', '读坏的 config.json 原样留着（不被默认值盖掉）', await findWithContent(data, bad), await findWithContent(data, bad) || '找不到原内容');
    const n = await noticesOf(bus);
    check('11-1', '没有备份时告诉玩家', n.some((x) => /设置/.test(`${x.title}`)), n.map((x) => x.title));
  },
  async 'config-bak-1'() {
    const { data } = setup('config-bak');
    const config = core('config');
    config.set({ theme: 'light', setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER, versionSettings: { X: { isolation: 'on', java: 'auto' } } });
    await config.flush();
    config.set({ accent: 'ocean' });
    await config.flush();
    // 准备的这一步也交一条结果：run.js 把「一条结果都没写」当成脚本没跑完（rc9）
    check('7-3', '第一步（准备）：设置写进了文件', fs.existsSync(path.join(data, 'config.json')), fs.readdirSync(data));
  },
  async 'config-bak-2'() {
    const { data } = setup('config-bak', { keep: true });
    const f = path.join(data, 'config.json');
    const good = JSON.parse(await fsp.readFile(f, 'utf8'));
    const bad = truncated(good);
    await fsp.writeFile(f, bad);
    const config = core('config');
    const c = config.get();
    const bus = ipc();
    check('11-1', '有备份时从备份恢复：向导不重走、配置单独设置还在', c.setupDone === true && c.theme === 'light' && !!c.versionSettings.X, { setupDone: c.setupDone, theme: c.theme, versionSettings: Object.keys(c.versionSettings) });
    check('11-1', '恢复时读坏的文件也留着', await findWithContent(data, bad), await findWithContent(data, bad) || '找不到原内容');
    const n = await noticesOf(bus);
    check('11-1', '恢复时告诉玩家', n.some((x) => /设置/.test(`${x.title}`)), n.map((x) => x.title));
  },
  async 'config-locked'() {
    const { data } = setup('config-locked');
    const f = path.join(data, 'config.json');
    const good = JSON.stringify({ gameDir: path.join(data, 'g'), setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER, theme: 'light', versionSettings: { X: { isolation: 'on' } } }, null, 2);
    await fsp.writeFile(f, good);
    const release = await lockFile(f, 'None', 15);
    const config = core('config');
    const c = config.get(); // 文件被占用（杀毒软件常见）
    const bus = ipc();
    await sleep(500); // pitfall-ok：文件占着的这段时间里，让启动器自己的保存定时器（200 毫秒防抖）有机会跑一次
    await release();
    config.set({ accent: 'ocean' }); // 玩家接着改了一个设置
    await config.flush();
    const now = JSON.parse(await fsp.readFile(f, 'utf8'));
    check('11-1', '读的时候被占用：解除后原来的设置没被盖掉', now.setupDone === true && !!(now.versionSettings || {}).X, { setupDone: now.setupDone, versionSettings: Object.keys(now.versionSettings || {}), loaded: c.setupDone });
    const n = await noticesOf(bus);
    check('11-1', '读不了时告诉玩家', n.some((x) => /设置/.test(`${x.title}`)), n.map((x) => x.title));
  },

  // ── 11-2 accounts.json ──
  async 'accounts-bak-1'() {
    const { data } = setup('accounts-bak');
    const accounts = core('auth/accounts');
    await accounts.addOffline('OldPlayer');
    await accounts.addOffline('SecondPlayer');
    await accounts.select((accounts.list().accounts.find((a) => a.name === 'OldPlayer') || {}).id);
    check('7-3', '第一步（准备）：账户写进了文件', fs.existsSync(path.join(data, 'accounts.json')), fs.readdirSync(data));
  },
  async 'accounts-bak-2'() {
    const { data } = setup('accounts-bak', { keep: true });
    const f = path.join(data, 'accounts.json');
    const bad = truncated(JSON.parse(await fsp.readFile(f, 'utf8')));
    await fsp.writeFile(f, bad);
    const accounts = core('auth/accounts');
    const bus = ipc();
    await accounts.addOffline('NewPlayer');
    const names = JSON.parse(await fsp.readFile(f, 'utf8')).accounts.map((a) => a.name);
    check('11-2', '读坏的 accounts.json：从备份恢复，旧账户还在', names.includes('OldPlayer') && names.includes('NewPlayer'), names);
    check('11-2', '读坏的文件留着', await findWithContent(data, bad), await findWithContent(data, bad) || '找不到原内容');
    const n = await noticesOf(bus);
    check('11-2', '告诉玩家', n.some((x) => /账户/.test(`${x.title}`)), n.map((x) => x.title));
  },
  async 'accounts-nobak'() {
    const { data } = setup('accounts-nobak');
    const f = path.join(data, 'accounts.json');
    const bad = '{"accounts":[{"id":"a1","type":"offline","name":"OldPlayer"}],"selected":"a1"';
    await fsp.writeFile(f, bad);
    const accounts = core('auth/accounts');
    const bus = ipc();
    await accounts.addOffline('NewPlayer');
    check('11-2', '没有备份：读坏的文件原样留着（可以手工救）', await findWithContent(data, bad), await findWithContent(data, bad) || '找不到原内容');
    const n = await noticesOf(bus);
    check('11-2', '没有备份时告诉玩家', n.some((x) => /账户/.test(`${x.title}`)), n.map((x) => x.title));
  },

  // ── 11-3 aurora-profile.json ──
  async 'meta-corrupt'() {
    const { game } = setup('meta-corrupt');
    const profiles = core('profiles');
    const bus = ipc();
    await fakeVersion('M1');
    await profiles.writeMeta('M1', { type: 'custom', isolation: { preset: 'shared', source: '@root' }, mods: { 'a.jar': { projectId: 'x' } }, stats: { playTime: 12345 } });
    await profiles.writeMeta('M1', { description: '第二次写入' });
    const f = path.join(core('versions').versionDir('M1'), 'aurora-profile.json');
    const bad = truncated(JSON.parse(await fsp.readFile(f, 'utf8')));
    await fsp.writeFile(f, bad);
    await profiles.recordTroubleshoot('M1', { kind: 'test', ok: true, summary: '随手一次写入' });
    const m = JSON.parse(await fsp.readFile(f, 'utf8'));
    check('11-3', '档案读坏后的下一次写入不丢隔离策略、Mod 来源、游戏时长', !!m.isolation && Object.keys(m.mods).length === 1 && m.stats.playTime === 12345, { isolation: !!m.isolation, mods: Object.keys(m.mods).length, playTime: m.stats.playTime });
    check('11-3', '读坏的文件留着', await findWithContent(path.dirname(f), bad), await findWithContent(path.dirname(f), bad) || '找不到原内容');

    await fakeVersion('M2');
    const f2 = path.join(core('versions').versionDir('M2'), 'aurora-profile.json');
    const bad2 = '{"type":"custom","isolation":{"preset":"shared"';
    await fsp.writeFile(f2, bad2);
    await profiles.writeMeta('M2', { description: '写一下' });
    check('11-3', '没有备份：读坏的文件留着', await findWithContent(path.dirname(f2), bad2), await findWithContent(path.dirname(f2), bad2) || '找不到原内容');
    // 第一次取走之后通知改走实时事件，所以两个场景放到最后一起取
    const n = await noticesOf(bus);
    check('11-3', '告诉玩家', n.some((x) => /M1/.test(`${x.title}`)), n.map((x) => x.title));
    check('11-3', '没有备份时告诉玩家', n.some((x) => /M2/.test(`${x.title}`)), n.map((x) => x.title));
    void game;
  },

  // ── 老用户升级：1.10.6 写的文件原样能读，没有误报，文件格式不变 ──
  // 每次启动都读一遍设置：内容没变就不重写（以前每次都写，.bak 也跟着被换成同一份）；补了东西才写
  async 'config-quiet-load'() {
    const { data } = setup('config-quiet-load');
    const f = path.join(data, 'config.json');
    const config = core('config');
    config.set({ theme: 'light', setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER });
    await config.flush();
    config.set({ accent: 'ocean' });
    await config.flush();
    const stamp = () => [f, `${f}.bak`].map((x) => (fs.existsSync(x) ? `${fs.statSync(x).mtimeMs}:${fs.readFileSync(x, 'utf8')}` : '-'));
    const before = stamp();
    await sleep(50); // pitfall-ok：让文件的修改时间能分得出先后
    config.load();
    await sleep(600); // pitfall-ok：保存是攒 200 毫秒再写的，要等过这一段才知道它写没写
    check('设置', '再读一遍、内容没变：config.json 和 .bak 都没被重写', JSON.stringify(stamp()) === JSON.stringify(before), { changed: stamp().map((x, i) => x !== before[i]) });
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete raw.clientToken;
    fs.writeFileSync(f, JSON.stringify(raw, null, 2));
    config.load();
    await sleep(600); // pitfall-ok：同上，攒 200 毫秒再写
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    check('设置', '读的时候补了东西（缺 clientToken）：照常写回去', typeof after.clientToken === 'string' && after.clientToken.length > 10 && after.accent === 'ocean', { clientToken: after.clientToken });
    // 配置的单独设置：界面传来的配置名、设置不对就不收
    const bad = [['', {}], ['__proto__', {}], [42, {}], ['X', 'on'], ['X', [1]]].filter(([id, s]) => { try { config.setVersionSettings(id, s); return true; } catch { return false; } });
    config.setVersionSettings('X', JSON.parse('{"isolation":"on","__proto__":{"polluted":1}}'));
    const vs = config.getVersionSettings('X');
    check('设置', '配置的单独设置：配置名不是正常字符串、设置不是对象的都不收；__proto__ 这种名字去掉', bad.length === 0 && vs.isolation === 'on' && !Object.prototype.hasOwnProperty.call(vs, '__proto__') && ({}).polluted === undefined, { accepted: bad.map((x) => String(x[0])), vs });
  },
  async 'old-data'() {
    const { data, game } = setup('old-data');
    await fsp.writeFile(path.join(data, 'config.json'), JSON.stringify({ gameDir: game, setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER, theme: 'light', configVersion: 5, versionSettings: { P: { isolation: 'on', java: 'auto' } } }, null, 2));
    await fsp.writeFile(path.join(data, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'a1', type: 'offline', name: 'OldPlayer', uuid: 'u1' }], selected: 'a1' }, null, 2));
    await fsp.writeFile(path.join(data, 'plans.json'), JSON.stringify({ plans: [{ id: 'p1', name: '方案', updatedAt: 1 }] }, null, 2));
    await fsp.mkdir(path.join(data, 'skins', 'library'), { recursive: true });
    await fsp.writeFile(path.join(data, 'skins', 'library', 'library.json'), JSON.stringify({ items: [], groups: ['G'] }, null, 2));
    const bus = ipc();
    const config = core('config');
    const c = config.get();
    await fakeVersion('P');
    const metaFile = path.join(core('versions').versionDir('P'), 'aurora-profile.json');
    await fsp.writeFile(metaFile, JSON.stringify({ format: 'aurora-profile', formatVersion: 2, type: 'custom', mods: { 'a.jar': { projectId: 'x' } }, stats: { playTime: 777 }, isolation: { preset: 'isolated' } }, null, 2));
    const accounts = core('auth/accounts').list();
    const plans = await core('planner').listPlans();
    const lib = await core('skins').libraryAll();
    const meta = await core('profiles').readMeta('P');
    check('升级', '老文件都能读', c.theme === 'light' && c.setupDone === true && accounts.accounts[0].name === 'OldPlayer' && plans[0].id === 'p1' && lib.groups[0] === 'G' && meta.stats.playTime === 777, { theme: c.theme, account: accounts.accounts[0] && accounts.accounts[0].name, plan: plans[0] && plans[0].id, group: lib.groups[0], playTime: meta.stats.playTime });
    await core('profiles').writeMeta('P', { description: 'x' });
    config.set({ accent: 'ocean' });
    await config.flush();
    const all = await tree(data);
    check('升级', '没有误判成读坏', !all.some((f) => f.includes('.corrupt-')), all.filter((f) => f.includes('.corrupt-')));
    const n = await noticesOf(bus);
    check('升级', '没有多余的提示', n.length === 0, n.map((x) => x.title));
    const again = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    check('升级', '写回的还是原来的格式（旧版本能读）', again.format === 'aurora-profile' && again.formatVersion === 2 && again.stats.playTime === 777 && again.description === 'x', { format: again.format, v: again.formatVersion });
    const cfg = JSON.parse(await fsp.readFile(path.join(data, 'config.json'), 'utf8'));
    check('升级', '设置文件写回后内容还在，备份留下了改动前的', cfg.theme === 'light' && cfg.accent === 'ocean' && fs.existsSync(path.join(data, 'config.json.bak')), { accent: cfg.accent });
  },

  // ── 11-4 其他同样写法的文件 ──
  async 'stores-corrupt'() {
    const { data } = setup('stores-corrupt');
    const bus = ipc();
    const skins = core('skins');
    const planner = core('planner');
    // 皮肤库
    await skins.libraryGroup({ op: 'add', name: 'GroupA' });
    await skins.libraryGroup({ op: 'add', name: 'GroupB' });
    const lib = path.join(data, 'skins', 'library', 'library.json');
    const badLib = truncated(JSON.parse(await fsp.readFile(lib, 'utf8')));
    await fsp.writeFile(lib, badLib);
    await skins.libraryGroup({ op: 'add', name: 'GroupC' });
    const groups = (await skins.libraryAll()).groups;
    check('11-4', '皮肤库：读坏后写入不丢旧分组', groups.includes('GroupA') && groups.includes('GroupC'), groups);
    check('11-4', '皮肤库：读坏的文件留着', await findWithContent(path.dirname(lib), badLib), await findWithContent(path.dirname(lib), badLib) || '找不到原内容');
    // 配置器方案
    await planner.savePlan({ id: 'p1', name: '方案一' });
    await planner.savePlan({ id: 'p2', name: '方案二' });
    const plans = path.join(data, 'plans.json');
    const badPlans = truncated(JSON.parse(await fsp.readFile(plans, 'utf8')));
    await fsp.writeFile(plans, badPlans);
    await planner.savePlan({ id: 'p3', name: '方案三' });
    const ids = (await planner.listPlans()).map((p) => p.id);
    check('11-4', '配置器方案：读坏后写入不丢旧方案', ids.includes('p1') && ids.includes('p3'), ids);
    check('11-4', '配置器方案：读坏的文件留着', await findWithContent(data, badPlans), await findWithContent(data, badPlans) || '找不到原内容');
    // MC 百科缓存（内部版）：读坏后加载时会触发一次保存
    const target = path.join(data, 'cache', 'mcmod.json');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const badMc = '{"items":{"mr:sodium":{"zh":"钠"}},"search":{},"v":3';
    await fsp.writeFile(target, badMc);
    const mcmod = core('mcmod');
    if (mcmod.CONCEPT) {
      // 公开版的 MC 百科模块是替身，不读也不写这个缓存（rc10：以前这里直接调内部版才有的函数，公开仓库里一跑就报错）
      check('11-4', 'MC 百科缓存（公开版没有这个功能）：替身不碰缓存文件', (await fsp.readFile(target, 'utf8')) === badMc);
    } else {
      await mcmod.cached([{ id: 'sodium', slug: 'sodium', source: 'modrinth' }]).catch(() => null); // 读缓存（不联网）
      await waitFor(async () => (await fsp.readFile(target, 'utf8').catch(() => badMc)) !== badMc, 5000); // 读坏时缓存当成 v1，升级后防抖 800 毫秒写回：等它写回来
      check('11-4', 'MC 百科缓存：读坏的文件留着', await findWithContent(path.dirname(target), badMc), await findWithContent(path.dirname(target), badMc) || `找不到原内容（${path.basename(target)}）`);
    }
    // 游戏设置主档
    const gs = core('gamesettings');
    const masterFile = path.join(data, 'game-settings.json');
    const badMaster = '{"values":{"fov":"1.0"},"updatedAt":1';
    await fsp.writeFile(masterFile, badMaster);
    // 从一个配置合并读取设置进主档（不是 replace）：会先读主档再写回
    const g1 = await fakeVersion('G1', { loader: false });
    core('config').setVersionSettings('G1', { isolation: 'on' });
    await fsp.writeFile(path.join(g1, 'options.txt'), 'fov:0.5\nlang:en_us\n');
    await gs.captureFrom('G1', {}).catch(() => null);
    check('11-4', '游戏设置主档：读坏的文件留着', await findWithContent(path.dirname(masterFile), badMaster), await findWithContent(path.dirname(masterFile), badMaster) || '找不到原内容');
    // 组件修改记录
    await fakeVersion('C1');
    const hist = path.join(core('versions').versionDir('C1'), '.aurora-components', 'history.json');
    await fsp.mkdir(path.dirname(hist), { recursive: true });
    const badHist = '[{"ts":1,"label":"x"}';
    await fsp.writeFile(hist, badHist);
    await core('components').info('C1').catch(() => null);
    check('11-4', '组件修改记录：读坏的文件留着', await findWithContent(path.dirname(hist), badHist), await findWithContent(path.dirname(hist), badHist) || '找不到原内容');
    const n = await noticesOf(bus);
    // 公开版的 MC 百科模块是替身，不读缓存，也就没有这一条提示
    for (const [label, re] of [['皮肤库', /皮肤/], ['配置器清单', /清单/], ...(mcmod.CONCEPT ? [] : [['MC 百科缓存', /百科/]]), ['游戏设置主档', /游戏设置/], ['组件修改记录', /组件/]]) {
      check('11-4', `${label}：告诉玩家`, n.some((x) => re.test(`${x.title}`)), n.map((x) => x.title));
    }
  },
  async 'migrate-import'() {
    // 导入数据时合并皮肤库、方案（migrate.js）：目标文件读坏时不能把内容盖掉
    const { data } = setup('migrate-import');
    const skins = core('skins');
    const planner = core('planner');
    const migrate = core('migrate');
    const tasks = core('tasks');
    await skins.libraryGroup({ op: 'add', name: 'Exported' });
    await planner.savePlan({ id: 'exported', name: '导出的方案' });
    const pack = path.join(data, `out.${migrate.EXT}`);
    const t1 = new tasks.Task('导出');
    await migrate.exportData({ ...migrate.DEFAULT_OPTS, skins: true, plans: true, settings: false, accounts: false }, [], pack, t1);
    await skins.libraryGroup({ op: 'add', name: 'LocalA' });
    await skins.libraryGroup({ op: 'add', name: 'LocalB' });
    await planner.savePlan({ id: 'localA', name: '本地方案' });
    await planner.savePlan({ id: 'localB', name: '本地方案二' });
    const lib = path.join(data, 'skins', 'library', 'library.json');
    const plans = path.join(data, 'plans.json');
    const badLib = truncated(JSON.parse(await fsp.readFile(lib, 'utf8')));
    const badPlans = truncated(JSON.parse(await fsp.readFile(plans, 'utf8')));
    await fsp.writeFile(lib, badLib);
    await fsp.writeFile(plans, badPlans);
    const t2 = new tasks.Task('导入');
    await migrate.importData({ file: pack }, { skins: true, plans: true, settings: false, accounts: false, profiles: {} }, t2);
    const groups = (await skins.libraryAll().catch(() => ({ groups: [] }))).groups;
    const ids = (await planner.listPlans().catch(() => [])).map((p) => p.id);
    check('11-4', '导入时目标皮肤库读坏：本地分组还在', groups.includes('LocalA'), groups);
    check('11-4', '导入时目标方案读坏：本地方案还在', ids.includes('localA'), ids);
    check('11-4', '导入时读坏的文件留着', (await findWithContent(path.dirname(lib), badLib)) && (await findWithContent(data, badPlans)), '两个文件都要找得到');
  },

  // ── 7-3 配置档案并发读改写 ──
  async 'meta-race'() {
    setup('meta-race');
    const profiles = core('profiles');
    const { writeJson } = core('util');
    await fakeVersion('R1');
    const N = 12;
    const errs = [];
    await Promise.all(Array.from({ length: N }, async (_, i) => {
      await sleep(i * 3);
      try { await profiles.setModInfo('R1', { [`m${i}.jar`]: { projectId: `p${i}` } }); } catch (e) { errs.push(e.code || e.message); }
    }));
    let meta = await profiles.readMeta('R1');
    check('7-3', '12 个 Mod 每隔 3 毫秒记一次来源：一条不少、不报错', Object.keys(meta.mods).length === N && !errs.length, { kept: Object.keys(meta.mods).length, errors: errs });

    await fakeVersion('R2');
    const rs = await Promise.allSettled(Array.from({ length: N }, (_, i) => profiles.setModInfo('R2', { [`m${i}.jar`]: { projectId: `p${i}`, pad: 'x'.repeat(4000) } })));
    meta = await profiles.readMeta('R2');
    check('7-3', '12 次同一时刻写入：一条不少、不报错', Object.keys(meta.mods).length === N && !rs.some((r) => r.status === 'rejected'), { kept: Object.keys(meta.mods).length, errors: rs.filter((r) => r.status === 'rejected').length });

    // 游戏退出时两种记录撞车（ipc.js 的 recordLaunch 和 recordTroubleshoot）
    await fakeVersion('R3');
    await Promise.all([
      profiles.recordLaunch('R3', { startedAt: Date.now() - 5000, endedAt: Date.now(), exitCode: 1, test: true, crash: { reasons: ['x'] }, lines: [{ text: 'a' }] }),
      profiles.recordTroubleshoot('R3', { kind: 'test', ok: false, summary: '测试失败' }),
    ]);
    meta = await profiles.readMeta('R3');
    check('7-3', '测试启动记录和排查记录同时写：两条都在', meta.history.launches.length === 1 && meta.history.troubleshoot.length === 1 && meta.stats.testCount === 1, { launches: meta.history.launches.length, troubleshoot: meta.history.troubleshoot.length });

    // writeJson 本身（7-3 的底层）
    const f = path.join(path.dirname(core('versions').versionDir('R1')), 'wj', 'x.json');
    let bad = 0;
    for (let round = 0; round < 20; round++) {
      const res = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => writeJson(f, { round, i, pad: 'x'.repeat(2000) })));
      bad += res.filter((r) => r.status === 'rejected').length;
    }
    const left = (await fsp.readdir(path.dirname(f))).filter((n) => n.endsWith('.tmp')).length;
    let last = null;
    try { last = JSON.parse(await fsp.readFile(f, 'utf8')); } catch { /* 坏了 */ }
    check('7-3', 'writeJson 同一文件并发 200 次：不失败、不留临时文件、最后写入的生效', !bad && !left && last && last.round === 19 && last.i === 9, { failed: bad, tmpLeft: left, last: last && [last.round, last.i] });
  },

  // ── 6-6 暂存只认一个名字 ──
  async 'stash-merge'() {
    setup('stash-merge');
    const bus = ipc();
    const config = core('config');
    const versions = core('versions');
    await fakeVersion('ST');
    config.setVersionSettings('ST', { isolation: 'on' });
    const gd = versions.versionDir('ST');
    await fsp.mkdir(path.join(gd, 'saves', 'NewWorld'), { recursive: true });
    await fsp.writeFile(path.join(gd, 'saves', 'NewWorld', 'level.dat'), 'new');
    await fsp.mkdir(path.join(gd, 'saves.aurora-own', 'OldWorld'), { recursive: true });
    await fsp.writeFile(path.join(gd, 'saves.aurora-own', 'OldWorld', 'level.dat'), 'old');
    await fsp.mkdir(path.join(gd, 'saves.aurora-own', 'Same'), { recursive: true });
    await fsp.writeFile(path.join(gd, 'saves.aurora-own', 'Same', 'level.dat'), 'old-same');
    await fsp.mkdir(path.join(gd, 'saves', 'Same'), { recursive: true });
    await fsp.writeFile(path.join(gd, 'saves', 'Same', 'level.dat'), 'new-same');
    await fsp.mkdir(path.join(versions.gameRoot(), 'saves'), { recursive: true });
    await bus.call('isolation:set', 'ST', { preset: 'shared', source: '@root' });
    const during = await bus.call('versions:removeInfo', 'ST');
    check('6-6', '共享期间删除确认框能看到所有暂存的世界', ['NewWorld', 'OldWorld'].every((w) => during.data.worlds.some((x) => x.name === w)), during.data.worlds.map((x) => x.name));
    await bus.call('isolation:set', 'ST', { preset: 'isolated' });
    const inSaves = await fsp.readdir(path.join(gd, 'saves')).catch(() => []);
    const texts = {};
    for (const w of inSaves) texts[w] = await fsp.readFile(path.join(gd, 'saves', w, 'level.dat'), 'utf8').catch(() => null);
    const values = Object.values(texts);
    check('6-6', '切回独立后两份暂存的世界都看得到，同名世界都保留', inSaves.includes('NewWorld') && inSaves.includes('OldWorld') && values.includes('new-same') && values.includes('old-same'), { saves: inSaves, stash: (await fsp.readdir(gd)).filter((n) => n.includes('aurora-own')) });
  },

  // ── 6-7 副本中途失败 ──
  async 'sandbox-midway'() {
    setup('sandbox-midway');
    const bus = ipc();
    const config = core('config');
    const versions = core('versions');
    const isolation = core('isolation');
    const profiles = core('profiles');
    const root = versions.gameRoot();
    const w = path.join(root, 'saves', 'World');
    await fsp.mkdir(path.join(w, 'region'), { recursive: true });
    await fsp.writeFile(path.join(w, 'level.dat'), 'source');
    await fsp.writeFile(path.join(w, 'region', 'r.0.0.mca'), 'region');
    for (const [id, refresh] of [['SB1', 'always'], ['SB2', 'once']]) {
      await fakeVersion(id);
      config.setVersionSettings(id, { isolation: 'on' });
      await profiles.writeMeta(id, { isolation: { preset: 'sandbox', source: '@root', refresh } });
      const gd = versions.gameDirFor(id, await versions.versionInfo(id));
      const release = await lockFile(path.join(w, 'region', 'r.0.0.mca'), 'None', 20);
      let err = null;
      try { await isolation.prepare(id, gd, { allowCopy: true }); } catch (e) { err = e.code || e.message; }
      await release();
      check('6-7', `${refresh}：来源被占用时复制失败（确认场景成立）`, !!err, err || '没有失败');
      await isolation.prepare(id, gd, { allowCopy: true }); // 第二次启动：占用解除
      const copied = await tree(path.join(gd, 'saves', 'World'));
      check('6-7', `${refresh}：第二次启动得到完整副本`, copied.includes('region/r.0.0.mca') && copied.includes('level.dat'), copied);
      await bus.call('isolation:set', id, { preset: 'isolated' });
      const own = await fsp.readdir(path.join(gd, 'saves')).catch(() => []);
      const stash = (await fsp.readdir(gd)).filter((n) => n.includes('aurora-own'));
      check('6-7', `${refresh}：切回独立后，半成品没有被当成玩家自己的存档`, !own.includes('World') && !stash.length, { saves: own, stash });
    }
  },

  // ── 12-2 改名回滚 ──
  async 'rename-rollback'() {
    setup('rename-rollback');
    const bus = ipc();
    const versions = core('versions');
    const config = core('config');
    // 中途失败方式一：新名字的 JSON 改名失败（目标被一个同名文件夹占着）
    await fakeVersion('Old1');
    config.setVersionSettings('Old1', { isolation: 'on', java: 'auto' });
    await fsp.mkdir(path.join(versions.versionDir('Old1'), 'New1.json'), { recursive: true });
    let r = await bus.call('versions:rename', 'Old1', 'New1');
    check('12-2', '改名中途失败（确认场景成立）', !r.ok, r.error || '没有失败');
    let list = (await versions.listInstalled()).map((v) => v.id);
    check('12-2', 'JSON 改名失败：配置回到原名字、还在列表里、设置还在', list.includes('Old1') && !fs.existsSync(versions.versionDir('New1')) && !!config.getVersionSettings('Old1').java, { list, newDir: fs.existsSync(versions.versionDir('New1')), settings: config.getVersionSettings('Old1') });

    // 中途失败方式二：依赖它的另一个版本写不进去（只读文件）
    await fakeVersion('Base');
    await fakeVersion('Child', { extra: { inheritsFrom: 'Base' } });
    const childJson = versions.versionJsonPath('Child');
    await fsp.chmod(childJson, 0o444);
    r = await bus.call('versions:rename', 'Base', 'BaseNew');
    await fsp.chmod(childJson, 0o666).catch(() => {});
    check('12-2', '改名中途失败 2（确认场景成立）', !r.ok, r.error || '没有失败');
    list = (await versions.listInstalled()).map((v) => v.id);
    const child = JSON.parse(await fsp.readFile(childJson, 'utf8'));
    check('12-2', '依赖版本写入失败：两边都回到原样', list.includes('Base') && !list.includes('BaseNew') && child.inheritsFrom === 'Base', { list, inheritsFrom: child.inheritsFrom });
  },

  // ── 6-3 不能改坏的：回收站真的不可用（U 盘、网络盘）时仍然问永久删除；删除失败时共享联接要接回去 ──
  async 'trash-unavailable'() {
    const { root } = setup('trash-unavailable');
    const id = `NoBin-${Date.now()}`;
    process.env.AURORA_TEST_TRASH = path.join(root, 'fake-trash');
    process.env.AURORA_TEST_TRASH_FAIL = id;
    const bus = ipc();
    const versions = core('versions');
    const config = core('config');
    const gd = await fakeVersion(id);
    config.setVersionSettings(id, { isolation: 'on' });
    await fsp.mkdir(path.join(versions.gameRoot(), 'saves', 'Shared'), { recursive: true });
    await bus.call('isolation:set', id, { preset: 'shared', source: '@root' });
    const isLink = async () => core('isolation').isLink(path.join(gd, 'saves'));
    check('6-3', '确认场景成立：存档是共享联接', await isLink());
    let r = await bus.call('versions:remove', id, { permanent: false });
    check('6-3', '回收站真的不可用：仍然报 TRASH_UNAVAILABLE（界面才会问永久删除）', !r.ok && r.reason && r.reason.code === 'TRASH_UNAVAILABLE', { ok: r.ok, code: r.reason && r.reason.code });
    check('6-3', '没删成：共享联接接回去了，公共目录的存档还在', (await isLink()) && fs.existsSync(path.join(versions.gameRoot(), 'saves', 'Shared')), { link: await isLink() });
    r = await bus.call('versions:remove', id, { permanent: true });
    check('6-3', '玩家确认永久删除后能删掉，公共目录的存档还在', r.ok && !fs.existsSync(gd) && fs.existsSync(path.join(versions.gameRoot(), 'saves', 'Shared')), r.error || '');
  },

  // ── 6-3 回收站（AURORA_REGRESS_REAL_TRASH=1 时用真实回收站，只动这里自己建的 aurora-regress-trash-test-* 文件） ──
  // ── 换 MC 版本前先备份存档（components.apply）：以前 backup.worlds() 给的是对象、这里当数组用，备份从来没做 ──
  async 'component-backup'() {
    setup('component-backup');
    const { makeWorld } = require('./game-kit');
    const comps = core('components');
    const backup = core('backup');
    const loaders = core('loaders');
    const realBuild = loaders.buildJson;
    let built = 0;
    // 走到下载新版本这一步就停：测试不真的下载；备份是在这一步之前做的
    loaders.buildJson = async () => { built++; throw new Error('测试到这里为止'); };
    const task = { update() {}, signal: undefined };
    const plan = (from) => ({ from: { mc: from, loader: { type: 'fabric', version: '0.15.0' } }, to: { mc: '1.21.1', loader: null }, mcChanged: true, mode: 'none', mods: [] });
    try {
      // 有世界：先备份
      const dir = await fakeVersion('CB', { extra: { clientVersion: '1.20.1' } });
      core('config').setVersionSettings('CB', { isolation: 'on' });
      await makeWorld(path.join(dir, 'saves'), 'MyWorld');
      const json0 = await fsp.readFile(path.join(dir, 'CB.json'), 'utf8');
      const e1 = await comps.apply('CB', { mc: '1.21.1' }, plan('1.20.1'), task).then(() => null, (e) => e.message);
      const list = (await backup.list('CB')).own;
      const auto = list.filter((x) => x.auto === 'component');
      check('comp', '换 MC 版本前自动备份了存档，备份里有这个世界', auto.length === 1 && auto[0].type === 'saves' && JSON.stringify(auto[0].worlds).includes('MyWorld'), { err: e1, list: list.map((x) => ({ name: x.name, auto: x.auto, worlds: x.worlds })) });
      check('comp', '下载新版本那一步失败：版本信息原样退回', (await fsp.readFile(path.join(dir, 'CB.json'), 'utf8')) === json0 && built === 1, { built });
      // 没有世界：不备份，照常往下走
      const dir2 = await fakeVersion('CN', { extra: { clientVersion: '1.20.1' } });
      core('config').setVersionSettings('CN', { isolation: 'on' });
      await comps.apply('CN', { mc: '1.21.1' }, plan('1.20.1'), task).catch(() => null);
      check('comp', '没有世界时不备份，照常往下走', (await backup.list('CN')).own.length === 0 && built === 2 && !!dir2, { built });
      // 读不出存档：停下，不在没备份的情况下换版本
      const realWorlds = backup.worlds;
      backup.worlds = async () => { throw new Error('存档文件夹读不了'); };
      let e3;
      try { e3 = await comps.apply('CB', { mc: '1.21.1' }, plan('1.20.1'), task).then(() => null, (e) => e.message); } finally { backup.worlds = realWorlds; }
      check('comp', '读不出存档时停下、不换版本，说清楚原因', /读不出这个配置的存档/.test(e3 || '') && built === 2, { e3, built });
    } finally { loaders.buildJson = realBuild; }
  },
  // ── 选了「新配置默认共享存档」时装整合包：整合包自带的世界、资源包不能写进公共 .minecraft（以前先联接再解压，同名的世界被盖掉）──
  async 'pack-shared-default'() {
    const { root, game } = setup('pack-shared-default');
    const config = core('config');
    config.set({ newProfileIsolation: 'shared' });
    const loaders = core('loaders');
    const modpack = core('modpack');
    const { ZipWriter } = core('zip');
    const realInstall = loaders.install;
    loaders.install = async ({ name }) => { await fakeVersion(name, { extra: { clientVersion: '1.20.1' } }); }; // 不下载：只建一个配置
    const task = { update() {}, signal: new AbortController().signal };
    const mk = async (file, name, extra) => {
      const w = await ZipWriter.create(file);
      await w.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name, files: [], dependencies: { minecraft: '1.20.1' } })));
      for (const [n, t] of Object.entries(extra)) await w.addBuffer(n, Buffer.from(t));
      await w.close();
    };
    const pub = path.join(game, 'saves', 'PackWorld', 'level.dat');
    fs.mkdirSync(path.dirname(pub), { recursive: true });
    fs.writeFileSync(pub, 'player-world');
    try {
      const f1 = path.join(root, 'with-world.mrpack');
      await mk(f1, 'WithWorld', { 'overrides/saves/PackWorld/level.dat': 'pack-world', 'overrides/resourcepacks/pack.zip': 'rp', 'overrides/config/a.toml': 'x' });
      const id1 = await modpack.installMrpack(f1, {}, task);
      const d1 = core('versions').versionDir(id1);
      const isolation = core('isolation');
      check('整合包', '整合包自带的世界没有写进公共存档（玩家同名的世界原样在）', fs.readFileSync(pub, 'utf8') === 'player-world', fs.readFileSync(pub, 'utf8'));
      check('整合包', '自带的世界、资源包留在整合包自己的文件夹里（不联到公共文件夹）', fs.readFileSync(path.join(d1, 'saves', 'PackWorld', 'level.dat'), 'utf8') === 'pack-world' && !(await isolation.isLink(path.join(d1, 'saves'))) && !(await isolation.isLink(path.join(d1, 'resourcepacks'))));
      check('整合包', '整合包没带的（光影、截图）照选好的默认和公共文件夹共享', (await isolation.isLink(path.join(d1, 'shaderpacks'))) && (await isolation.isLink(path.join(d1, 'screenshots'))));
      const f2 = path.join(root, 'plain.mrpack');
      await mk(f2, 'Plain', { 'overrides/config/b.toml': 'y' });
      const id2 = await modpack.installMrpack(f2, {}, task);
      const d2 = core('versions').versionDir(id2);
      check('整合包', '没带世界的整合包：存档照选好的默认和公共 .minecraft 共享', await isolation.isLink(path.join(d2, 'saves')));
      // 装到一半失败：清掉半成品时不碰公共存档
      const w3 = await ZipWriter.create(path.join(root, 'b3.mrpack'));
      await w3.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Fail', files: [{ path: 'mods/x.jar', downloads: ['http://127.0.0.1:1/x.jar'], hashes: { sha1: '0'.repeat(40) }, fileSize: 1 }], dependencies: { minecraft: '1.20.1' } })));
      await w3.close();
      const e3 = await modpack.installMrpack(path.join(root, 'b3.mrpack'), {}, task).then(() => null, (e) => e.message);
      check('整合包', '装到一半失败：半成品清掉了，公共存档一点没动', !!e3 && fs.readFileSync(pub, 'utf8') === 'player-world' && fs.readdirSync(path.join(game, 'saves')).length === 1, { e3: e3 && e3.slice(0, 80), saves: fs.readdirSync(path.join(game, 'saves')) });
    } finally { loaders.install = realInstall; config.set({ newProfileIsolation: 'isolated' }); }
  },
  // ── 备份：同一秒备份两次不撞名；恢复只认备份文件夹里的文件，备份包里的世界名不能跳出存档文件夹 ──
  async 'backup-guards'() {
    const { root } = setup('backup-guards');
    const { makeWorld } = require('./game-kit');
    const backup = core('backup');
    const { ZipWriter } = core('zip');
    const dir = await fakeVersion('BG');
    core('config').setVersionSettings('BG', { isolation: 'on' });
    await makeWorld(path.join(dir, 'saves'), 'W');
    const both = await Promise.all([backup.create('BG', { type: 'saves' }), backup.create('BG', { type: 'saves' })]).then((r) => r.map((x) => x.file), (e) => [`出错：${e.message}`]);
    const own = (await backup.list('BG')).own;
    check('备份', '同一时刻备份两次：两个文件名字不同，都是完整的备份', both.length === 2 && both[0] !== both[1] && own.length === 2 && own.every((x) => !x.broken && JSON.stringify(x.worlds).includes('"W"')), { both, own: own.map((x) => x.name) });
    // 备份文件夹外面的文件：不恢复
    const outside = path.join(root, 'outside.zip');
    fs.copyFileSync(both[0], outside);
    const e1 = await backup.restore('BG', outside, { mode: 'new' }).then(() => null, (e) => e.message);
    check('备份', '备份文件夹外面的文件不拿来恢复', /只能恢复备份文件夹里的文件/.test(e1 || ''), e1);
    // 被改过的备份包：世界名是 ..（放到 saves 下面就是配置文件夹本身）
    const evil = path.join(backup.dirOf('BG'), '20990101-000000-saves.zip');
    const w = await ZipWriter.create(evil);
    await w.addBuffer('saves/../level.dat', Buffer.from('evil'));
    await w.addBuffer('aurora-backup.json', Buffer.from(JSON.stringify({ format: 1, profile: 'BG', type: 'saves', worlds: [{ name: '..', displayName: 'x' }], parts: ['saves'], dirs: [], files: [] })));
    await w.close();
    const before = await tree(dir);
    const e2 = await backup.restore('BG', evil, { mode: 'overwrite' }).then(() => null, (e) => e.message);
    const after = await tree(dir);
    check('备份', '备份包里的世界名是 .. ：不恢复，配置文件夹里什么都没动', !!e2 && JSON.stringify(before) === JSON.stringify(after), { e2, added: after.filter((f) => !before.includes(f)).slice(0, 5) });
  },
  // ── 外置登录账户导出、导入（迁移到别的电脑）：以前导出时漏了认证服务器，导进来以后刷新、启动直接 TypeError ──
  async 'ygg-export'() {
    const { data } = setup('ygg-export');
    const server = { name: '测试皮肤站', root: 'https://skin.invalid/api/yggdrasil', homepage: 'https://skin.invalid' };
    await fsp.writeFile(path.join(data, 'accounts.json'), JSON.stringify({ selected: 'y1', accounts: [{ id: 'y1', type: 'yggdrasil', name: 'YggPlayer', uuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', server, addedAt: 1 }] }));
    const accounts = core('auth/accounts');
    const exported = accounts.exportList();
    const ex = exported.accounts.find((x) => x.id === 'y1');
    check('ygg', '导出的外置登录账户带着认证服务器（名字、地址），不带令牌', ex && ex.server && ex.server.root === server.root && ex.server.name === server.name && !/accessToken|enc:/.test(JSON.stringify(exported)), ex);
    await accounts.remove('y1');
    await accounts.importList(exported);
    const back = accounts.raw().find((x) => x.id === 'y1');
    check('ygg', '导进来以后认证服务器还在', back && back.server && back.server.root === server.root, back && back.server);
    const why = (id) => accounts.refresh(id).then(() => 'ok', (e) => `${e.constructor.name}: ${e.message}`);
    const r1 = await why('y1');
    check('ygg', '导进来的账户刷新：提示重新登录这个皮肤站（不是程序错误）', /^Error: /.test(r1) && /测试皮肤站/.test(r1) && /登录/.test(r1), r1);
    // 旧版本导出的数据里没有认证服务器
    await accounts.importList({ selected: '', accounts: [{ id: 'y2', type: 'yggdrasil', name: 'OldYgg', uuid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', addedAt: 2 }] });
    const r2 = await why('y2');
    check('ygg', '旧数据导进来、缺认证服务器的账户：说清楚要删掉重新添加，不是程序错误', /^Error: /.test(r2) && /缺少认证服务器/.test(r2) && /重新添加/.test(r2), r2);
    const v2 = accounts.list().accounts.find((x) => x.id === 'y2');
    check('ygg', '这个账户标成要重新登录，账户列表照常能列出来', v2 && v2.needRelogin === true, v2);
  },
  async 'trash-inuse'() {
    const real = process.env.AURORA_REGRESS_REAL_TRASH === '1';
    const { root } = setup('trash-inuse');
    if (!real) { process.env.AURORA_TEST_TRASH = path.join(root, 'fake-trash'); }
    const bus = ipc();
    const versions = core('versions');
    const config = core('config');
    const stamp = Date.now();
    const id = `aurora-regress-trash-test-${stamp}`;
    const gd = await fakeVersion(id);
    config.setVersionSettings(id, { isolation: 'on' });
    await fsp.mkdir(path.join(gd, 'saves', 'World', 'region'), { recursive: true });
    await fsp.writeFile(path.join(gd, 'saves', 'World', 'level.dat'), 'world');
    await fsp.writeFile(path.join(gd, 'saves', 'World', 'region', 'r.0.0.mca'), 'region');
    const lockTarget = path.join(gd, 'saves', 'World', 'region', 'r.0.0.mca');
    const before = await tree(gd);
    for (const [tag, share] of [['不共享', 'None'], ['读写删共享（Java NIO）', 'ReadWrite,Delete']]) {
      const release = await lockFile(lockTarget, share, 25);
      const r = await bus.call('versions:remove', id, { permanent: false });
      await release();
      const code = r.reason && r.reason.code;
      const after = await tree(gd);
      console.log(`  实测：${tag}占用时 versions:remove 返回 ok=${r.ok} code=${code} msg=${String(r.error).slice(0, 80)}；目录剩 ${after.length}/${before.length} 个文件`);
      check('6-3', `${tag}占用时不说「回收站不可用」（不引导永久删除）`, !r.ok && code !== 'TRASH_UNAVAILABLE', { ok: r.ok, code, msg: String(r.error).slice(0, 60) });
      check('6-3', `${tag}占用时文件一个不少`, after.length === before.length, { before: before.length, after: after.length });
      if (r.ok && !fs.existsSync(gd)) await restoreOwn(id, gd);
    }
    // 真的「永久删除」不能删半截（修之前界面会引导玩家走到这一步）
    {
      const release = await lockFile(lockTarget, 'ReadWrite,Delete', 25);
      const r = await bus.call('versions:remove', id, { permanent: true });
      await release();
      const after = await tree(gd);
      check('6-3', '占用时连永久删除也拒绝（不留半截）', !r.ok && after.length === before.length, { ok: r.ok, left: after.length });
    }
    // 没有占用时正常进回收站，能还原
    if (!fs.existsSync(path.join(gd, 'saves', 'World', 'level.dat'))) {
      await fakeVersion(id);
      await fsp.mkdir(path.join(gd, 'saves', 'World', 'region'), { recursive: true });
      await fsp.writeFile(path.join(gd, 'saves', 'World', 'level.dat'), 'world');
      await fsp.writeFile(path.join(gd, 'saves', 'World', 'region', 'r.0.0.mca'), 'region');
    }
    {
      const r = await bus.call('versions:remove', id, { permanent: false });
      check('6-3', '没有占用时正常删除', r.ok && !fs.existsSync(gd), r.error || '');
    }
    if (real) {
      // 从回收站把测试文件夹还原出来，再清理掉。只认这个时间戳的名字，回收站里别的东西一概不动
      const { execFileSync } = require('child_process');
      const ps = (cmd, env) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true }).trim();
      const restore = `$bin=(New-Object -ComObject Shell.Application).Namespace(10); $hit=@($bin.Items() | Where-Object { $_.Name -eq $env:T_NAME }); if ($hit.Count -ne 1) { "found:$($hit.Count)"; exit }; (New-Object -ComObject Shell.Application).Namespace($env:T_DIR).MoveHere($hit[0], 0x14); Start-Sleep 2; "restored"`;
      const out = ps(restore, { T_NAME: id, T_DIR: path.dirname(gd) });
      const back = await tree(gd);
      check('6-3', '真实回收站：测试文件夹能还原，内容完整', out.includes('restored') && back.length === before.length, { out, back: back.length, before: before.length });
      const leftInBin = ps('$bin=(New-Object -ComObject Shell.Application).Namespace(10); @($bin.Items() | Where-Object { $_.Name -eq $env:T_NAME }).Count', { T_NAME: id });
      check('6-3', '真实回收站：测试文件没留在回收站', leftInBin === '0', leftInBin);
      await fsp.rm(gd, { recursive: true, force: true }).catch(() => {});
    }
  },
};

(async () => {
  await app.whenReady();
  const name = process.argv[process.argv.length - 1];
  if (!SCENARIOS[name]) { console.log(`场景：${Object.keys(SCENARIOS).join(' ')}`); finish(2); return; }
  try {
    await SCENARIOS[name]();
  } catch (e) {
    check(name, '脚本运行出错', false, e.stack || String(e));
  }
  finish();
})();

module.exports = { names: () => Object.keys(SCENARIOS) };
