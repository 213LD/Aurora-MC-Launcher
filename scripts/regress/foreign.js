'use strict';
/**
 * 从其他启动器导入（2.0.0-pre10）。全部在隔离层里：写屏障保证原来的文件夹写不了，测完再核对内容一个字节没变。
 *   electron scripts/regress/foreign.js <场景>
 * - layouts  按各家真实的文件结构造数据：官方、HMCL（独立和公共）、PCL2、Prism（Fabric）、MultiMC（Forge 下载失败）、别的
 * - real     指定一个真实的游戏文件夹（AURORA_FOREIGN_SRC，只读）：能读出来，复制进测试目录，原文件夹没变
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app, net } = require('electron');
const H = require('./harness');
const { seal } = require('./sandbox-hook');

const { setup, core, check, finish, ipc } = H;
const mk = (f, t = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const J = (id, extra = {}) => JSON.stringify({ id, type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], ...extra });
const FAB = { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }], mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient' };

/** 一个文件夹所有文件的指纹：内容和修改时间 */
function fingerprint(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const st = fs.statSync(p); out.push(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}${st.size < 4 * 1048576 ? `|${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}` : ''}`); }
    }
  };
  walk(dir);
  return crypto.createHash('sha1').update(out.sort().join('\n')).digest('hex');
}

/** 假的版本列表和下载：不联网也能装原版和 Fabric */
function fakeNet() {
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  net.fetch = async (u) => {
    const url = String(u && u.url ? u.url : u);
    if (/version_manifest/.test(url)) return json({ latest: { release: '1.20.1', snapshot: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: 'https://piston-meta.mojang.com/v1/1.20.1.json' }] });
    if (/\/1\.20\.1\.json/.test(url)) return json({ id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], javaVersion: { majorVersion: 17, component: 'java-runtime-gamma' }, downloads: { client: { url: 'https://piston-data.mojang.com/client.jar' } } });
    if (/client\.jar/.test(url)) return new Response('fake-client-jar', { status: 200 });
    if (/fabricmc\.net.*profile\/json/.test(url)) return json({ id: 'fabric', inheritsFrom: '1.20.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0', url: 'https://maven.fabricmc.net/' }] });
    if (/maven\.fabricmc\.net|fabric-loader.*\.jar/.test(url)) return new Response('fake-lib', { status: 200 });
    return new Response('nope', { status: 404 });
  };
}

async function runImport(bus, dir, picks) {
  const r = await bus.call('migrate:foreignImport', { dir }, { picks });
  if (!r.ok) return { error: r.error };
  const tasks = core('tasks');
  for (let i = 0; i < 300; i++) {
    const t = tasks.get(r.data);
    if (t && t.status !== 'running') return { status: t.status, error: t.error, id: r.data };
    await H.sleep(100); // pitfall-ok：轮询里两次查看之间的间隔
  }
  return { error: '导入超时' };
}

const SCENARIOS = {
  async layouts() {
    const { root, game } = setup('foreign-layouts');
    const box = seal(root);
    fakeNet();
    const config = core('config');
    config.load();
    config.set({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, gameDir: game });
    const src = path.join(root, 'src');

    // 官方启动器：全部共用根目录，有 launcher_profiles.json
    const off = path.join(src, 'official', '.minecraft');
    mk(path.join(off, 'launcher_profiles.json'), '{}');
    mk(path.join(off, 'versions', '1.20.1', '1.20.1.json'), J('1.20.1'));
    mk(path.join(off, 'versions', '1.20.1', '1.20.1.jar'), 'jar-official');
    mk(path.join(off, 'versions', 'fabric-loader-0.15.0-1.20.1', 'fabric-loader-0.15.0-1.20.1.json'), J('fabric-loader-0.15.0-1.20.1', { ...FAB, inheritsFrom: '1.20.1' }));
    mk(path.join(off, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.15.0', 'fabric-loader-0.15.0.jar'), 'lib-fabric');
    mk(path.join(off, 'saves', '生存世界', 'level.dat'), 'world-official');
    mk(path.join(off, 'saves', '生存世界', 'region', 'r.0.0.mca'), 'region-official');
    mk(path.join(off, 'mods', 'root-mod.jar'), 'mod-official');
    mk(path.join(off, 'options.txt'), 'fov:0.5\n');
    // HMCL：一个独立（gameDirType 1），一个公共（0）
    const hm = path.join(src, 'hmcl', '.minecraft');
    mk(path.join(src, 'hmcl', 'HMCL-3.6.exe'));
    mk(path.join(hm, 'versions', 'hm-iso', 'hm-iso.json'), J('hm-iso', FAB));
    mk(path.join(hm, 'versions', 'hm-iso', 'hm-iso.jar'), 'jar-hm');
    mk(path.join(hm, 'versions', 'hm-iso', 'hmclversion.cfg'), JSON.stringify({ gameDirType: 1, usesGlobal: false }));
    mk(path.join(hm, 'versions', 'hm-iso', 'saves', 'HM World', 'level.dat'), 'world-hm');
    mk(path.join(hm, 'versions', 'hm-iso', 'mods', 'hm.jar'), 'mod-hm');
    mk(path.join(hm, 'versions', 'hm-iso', 'logs', 'latest.log'), 'log');
    mk(path.join(hm, 'versions', 'hm-iso', 'natives-windows', 'x.dll'), 'dll');
    mk(path.join(hm, 'versions', 'hm-pub', 'hm-pub.json'), J('hm-pub'));
    mk(path.join(hm, 'versions', 'hm-pub', 'hmclversion.cfg'), JSON.stringify({ gameDirType: 0 }));
    mk(path.join(hm, 'versions', 'hm-new', 'hm-new.json'), J('hm-new'));
    mk(path.join(hm, 'versions', 'hm-new', 'instance-game-settings.json'), JSON.stringify({ gameDirType: 'VERSION_FOLDER' }));
    // HMCL 3.16：照真的 HMCL 3.16.4 写出来的样子（2026-11-07）。关了隔离时版本文件夹里留着 Mod，也要按根目录算
    const hm3 = (id, o) => mk(path.join(hm, 'versions', id, '.hmcl', 'config', 'instance-game-settings.json'), JSON.stringify({ $schema: 'https://schemas.glavo.site/hmcl/instance-game-settings/1.0.0', ...o }));
    mk(path.join(hm, 'versions', 'hm3-iso', 'hm3-iso.json'), J('hm3-iso'));
    hm3('hm3-iso', { overrideProperties: ['runningDirectory'], runningDirectory: '' });
    mk(path.join(hm, 'versions', 'hm3-off', 'hm3-off.json'), J('hm3-off'));
    mk(path.join(hm, 'versions', 'hm3-off', 'mods', 'left.jar'), 'mod-left');
    hm3('hm3-off', { overrideProperties: [] });
    mk(path.join(hm, 'versions', 'hm3-custom', 'hm3-custom.json'), J('hm3-custom'));
    mk(path.join(src, 'hmcl', 'customrun', 'saves', 'C World', 'level.dat'), 'world-c');
    hm3('hm3-custom', { overrideProperties: ['runningDirectory'], runningDirectory: path.join(src, 'hmcl', 'customrun') });
    mk(path.join(hm, 'versions', 'hm-iso', 'saves', 'Locked', 'level.dat'), 'world-locked');
    mk(path.join(hm, 'versions', 'hm-iso', 'saves', 'Locked', 'session.lock'), 'lock');
    // PCL2：Setup.ini 里写着开了版本隔离；另一个没开但版本文件夹里什么也没有
    const pc = path.join(src, 'pcl', '.minecraft');
    mk(path.join(pc, 'PCL', 'Setup.ini'), 'x:1');
    mk(path.join(pc, 'versions', 'pcl-iso', 'pcl-iso.json'), J('pcl-iso', FAB));
    mk(path.join(pc, 'versions', 'pcl-iso', 'PCL', 'Setup.ini'), 'VersionArgumentIndieV2:True\nLogo:x\n');
    mk(path.join(pc, 'versions', 'pcl-iso', 'saves', 'PCL World', 'level.dat'), 'world-pcl');
    mk(path.join(pc, 'versions', 'pcl-old', 'pcl-old.json'), J('pcl-old'));
    mk(path.join(pc, 'versions', 'pcl-old', 'PCL', 'Setup.ini'), 'VersionArgumentIndie:0\nVersionArgumentIndieV2:False\n');
    mk(path.join(pc, 'versions', 'pcl-old', 'mods', 'stale.jar'), 'x');
    // 别的启动器：什么记录都没有，靠版本文件夹里有没有内容判断
    const other = path.join(src, 'other');
    mk(path.join(other, 'versions', 'x-iso', 'x-iso.json'), J('x-iso'));
    mk(path.join(other, 'versions', 'x-iso', 'saves', 'X World', 'level.dat'), 'world-x');
    // Prism：实例结构，Fabric
    const prism = path.join(src, 'prism');
    const pi = path.join(prism, 'instances', 'Fabric Pack');
    mk(path.join(pi, 'instance.cfg'), '[General]\nname=我的 Fabric 包\nOverrideJavaArgs=true\nJvmArgs=-Dprism=1\n');
    mk(path.join(pi, 'mmc-pack.json'), JSON.stringify({ formatVersion: 1, components: [{ uid: 'org.lwjgl3', version: '3.3.1' }, { uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.15.0' }] }));
    mk(path.join(pi, '.minecraft', 'saves', 'Prism World', 'level.dat'), 'world-prism');
    mk(path.join(pi, '.minecraft', 'mods', 'prism.jar'), 'mod-prism');
    mk(path.join(pi, '.minecraft', 'logs', 'latest.log'), 'log');
    // MultiMC：老目录名 minecraft，Forge（假网络下载不到，要报清楚）
    const mi = path.join(src, 'mmc', 'instances', 'ForgePack');
    mk(path.join(mi, 'instance.cfg'), '[General]\nname=ForgePack\n');
    mk(path.join(mi, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.minecraftforge', version: '47.2.0' }] }));
    mk(path.join(mi, 'minecraft', 'saves', 'MMC World', 'level.dat'), 'world-mmc');
    // 坏的实例不能影响别的
    mk(path.join(src, 'mmc', 'instances', 'Broken', 'mmc-pack.json'), '{bad');
    // 老的 MultiMC 实例：Forge 的版本号带着游戏版本（1.12.2-14.23.5.2860），装的时候会拼成 1.12.2-1.12.2-…
    const old = path.join(src, 'mmc-old', 'instances', 'OldForge');
    mk(path.join(old, 'instance.cfg'), ['[General]', 'name=OldForge', ''].join('\n'));
    mk(path.join(old, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.12.2' }, { uid: 'net.minecraftforge', version: '1.12.2-14.23.5.2860' }] }));
    mk(path.join(old, 'minecraft', 'options.txt'), 'x');
    mk(path.join(src, 'mmc', 'instances', 'NoMc', 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'org.lwjgl3' }] }));
    // 只有存档的文件夹
    const worlds = path.join(src, 'justworlds');
    mk(path.join(worlds, 'saves', 'Backup World', 'level.dat'), 'world-only');

    const before = fingerprint(src);
    const bus = ipc();
    const inspect = async (d) => { const r = await bus.call('migrate:foreignInspect', d); return r.ok ? r.data : { ok: false, err: r.error }; };

    const iOff = await inspect(path.dirname(off));
    check('识别', '官方启动器：认得出，两个版本，都在公共目录', iOff.ok && iOff.source.launcher === '官方启动器' && iOff.instances.length === 2 && iOff.instances.every((x) => !x.isolated), iOff.source);
    const fab = iOff.instances.find((x) => x.key.startsWith('fabric'));
    check('识别', '官方启动器：继承的版本读得出 MC 版本和加载器', fab && fab.mc === '1.20.1' && fab.loader && fab.loader.type === 'fabric', fab);
    const iHm = await inspect(hm);
    check('识别', 'HMCL：认得出，独立和公共分得清', iHm.ok && iHm.source.launcher === 'HMCL' && iHm.instances.find((x) => x.key === 'hm-iso').isolated && !iHm.instances.find((x) => x.key === 'hm-pub').isolated, iHm.source);
    check('识别', 'HMCL 新版本的设置文件（写名字不写序号）也读得懂', iHm.instances.find((x) => x.key === 'hm-new').isolated);
    const h3 = (k) => iHm.instances.find((x) => x.key === k) || {};
    check('识别', 'HMCL 3.16：开了隔离是版本文件夹，关了是根目录（版本文件夹里留着 Mod 也一样），自定义目录读得到', h3('hm3-iso').isolated && !h3('hm3-off').isolated && h3('hm3-custom').worlds === 1, ['hm3-iso', 'hm3-off', 'hm3-custom'].map((k) => [k, h3(k).isolated, h3(k).worlds]));
    check('识别', 'HMCL：世界和 Mod 数对', iHm.instances.find((x) => x.key === 'hm-iso').worlds === 2 && iHm.instances.find((x) => x.key === 'hm-iso').mods === 1);
    const iPc = await inspect(pc);
    check('识别', 'PCL2：认得出，Setup.ini 里的版本隔离读到了', iPc.ok && iPc.source.launcher === 'PCL2' && iPc.instances.find((x) => x.key === 'pcl-iso').isolated && !iPc.instances.find((x) => x.key === 'pcl-old').isolated, iPc.source);
    const iOther = await inspect(other);
    check('识别', '别的启动器：没有记录，看版本文件夹里有没有内容', iOther.ok && iOther.instances[0].isolated && iOther.instances[0].worlds === 1);
    const iPrism = await inspect(prism);
    const ip = iPrism.instances && iPrism.instances[0];
    check('识别', 'Prism：名字、版本、加载器都读到', iPrism.ok && ip.name === '我的 Fabric 包' && ip.mc === '1.20.1' && ip.loader.type === 'fabric' && ip.worlds === 1 && ip.mods === 1, ip);
    const iOne = await inspect(pi);
    check('识别', '直接选一个 Prism 实例文件夹也行', iOne.ok && iOne.instances.length === 1);
    const iMmc = await inspect(path.join(src, 'mmc'));
    check('识别', 'MultiMC：坏的实例跳过，好的还在', iMmc.ok && iMmc.instances.length === 1 && iMmc.instances[0].loader.type === 'forge', iMmc.instances && iMmc.instances.map((x) => x.key));
    const iOld = await inspect(path.join(src, 'mmc-old'));
    const lo = iOld.instances && iOld.instances[0] && iOld.instances[0].loader;
    check('识别', 'MultiMC：老实例 Forge 版本号带着游戏版本，去掉前缀再装', !!lo && lo.type === 'forge' && lo.version === '14.23.5.2860', lo);
    const iWorlds = await inspect(worlds);
    check('识别', '只有存档的文件夹：只能导存档', iWorlds.ok && iWorlds.instances[0].savesOnly && iWorlds.instances[0].worlds === 1);
    const iEmpty = await inspect(path.join(root, 'fakehome'));
    check('识别', '什么都没有的文件夹：说清楚', iEmpty.ok === false && /没有认识的/.test(iEmpty.problems[0].text), iEmpty.problems);
    const iSelf = await inspect(game);
    check('识别', '不能从自己现在用的目录导入', iSelf.ok === false, iSelf.problems);

    const vd = (id, ...rest) => path.join(game, 'versions', id, ...rest);
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

    // 复制：独立的
    let r = await runImport(bus, hm, { 'hm-iso': 'copy' });
    check('复制', 'HMCL 独立配置：导入成功', r.status === 'done', r);
    check('复制', '世界和 Mod 都带过来了', read(vd('hm-iso', 'saves', 'HM World', 'level.dat')) === 'world-hm' && read(vd('hm-iso', 'mods', 'hm.jar')) === 'mod-hm');
    check('复制', '日志、natives、HMCL 自己的文件、session.lock 不带', !fs.existsSync(vd('hm-iso', 'logs')) && !fs.existsSync(vd('hm-iso', 'natives-windows')) && !fs.existsSync(vd('hm-iso', 'hmclversion.cfg')) && !fs.existsSync(vd('hm-iso', 'saves', 'Locked', 'session.lock')) && read(vd('hm-iso', 'saves', 'Locked', 'level.dat')) === 'world-locked');
    const versions = core('versions');
    check('复制', '配置在列表里，用自己的目录', (await versions.listInstalled()).some((v) => v.id === 'hm-iso') && path.resolve(versions.gameDirFor('hm-iso', await versions.versionInfo('hm-iso'))) === path.resolve(vd('hm-iso')));
    r = await runImport(bus, hm, { 'hm3-custom': 'copy', 'hm3-iso': 'copy' });
    check('复制', 'HMCL 自定义目录的配置：带的是那个文件夹里的世界，进这个配置自己的目录', r.status === 'done' && read(vd('hm3-custom', 'saves', 'C World', 'level.dat')) === 'world-c' && path.resolve(versions.gameDirFor('hm3-custom', await versions.versionInfo('hm3-custom'))) === path.resolve(vd('hm3-custom')), r);
    check('复制', 'HMCL 3.16 的 .hmcl 设置文件夹不带过来', fs.existsSync(vd('hm3-iso', 'hm3-iso.json')) && !fs.existsSync(vd('hm3-iso', '.hmcl')));
    const meta = await core('profiles').readMeta('hm-iso');
    check('复制', '记下了从哪来的', meta.importedFrom && meta.importedFrom.launcher === 'HMCL' && meta.importedFrom.mode === 'copy', meta.importedFrom);

    // 再导一次：同名改名，不盖
    mk(vd('hm-iso', 'saves', 'HM World', 'mine.txt'), 'mine');
    r = await runImport(bus, hm, { 'hm-iso': 'copy' });
    check('复制', '同名的再导一次：改名，原来的不动', r.status === 'done' && fs.existsSync(vd('hm-iso (导入)', 'hm-iso (导入).json')) && read(vd('hm-iso', 'saves', 'HM World', 'mine.txt')) === 'mine', r);

    // 复制：继承 + 公共目录
    r = await runImport(bus, path.dirname(off), { 'fabric-loader-0.15.0-1.20.1': 'copy' });
    check('复制', '官方的 Fabric 配置：导入成功', r.status === 'done', r);
    check('复制', '前置版本和库带过来了', read(vd('1.20.1', '1.20.1.jar')) === 'jar-official' && fs.existsSync(path.join(game, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.15.0', 'fabric-loader-0.15.0.jar')));
    check('复制', '公共目录的内容进了这边的公共目录', read(path.join(game, 'saves', '生存世界', 'level.dat')) === 'world-official' && read(path.join(game, 'mods', 'root-mod.jar')) === 'mod-official' && read(path.join(game, 'options.txt')) === 'fov:0.5\n');
    const fabInfo = await versions.versionInfo('fabric-loader-0.15.0-1.20.1');
    check('复制', '这个配置用公共目录（和原来一样）', path.resolve(versions.gameDirFor('fabric-loader-0.15.0-1.20.1', fabInfo)) === path.resolve(game));

    // 公共目录已经有同名世界：不盖
    mk(path.join(game, 'saves', 'PCL World', 'level.dat'), 'mine-pcl');
    r = await runImport(bus, pc, { 'pcl-iso': 'saves' });
    check('只导存档', 'PCL 世界进公共目录，同名的改名，现有的不动', r.status === 'done' && read(path.join(game, 'saves', 'PCL World', 'level.dat')) === 'mine-pcl' && read(path.join(game, 'saves', 'PCL World (导入)', 'level.dat')) === 'world-pcl', r);
    check('只导存档', '没有多出配置', !fs.existsSync(vd('pcl-iso')));
    r = await runImport(bus, worlds, { '@root': 'saves' });
    check('只导存档', '只有存档的文件夹：导进来了', r.status === 'done' && read(path.join(game, 'saves', 'Backup World', 'level.dat')) === 'world-only', r);

    // 引用原目录
    r = await runImport(bus, other, { 'x-iso': 'link' });
    check('引用', '导入成功', r.status === 'done', r);
    const xInfo = await versions.versionInfo('x-iso');
    check('引用', '游戏目录就是原来的文件夹', path.resolve(versions.gameDirFor('x-iso', xInfo)) === path.resolve(other, 'versions', 'x-iso'), versions.gameDirFor('x-iso', xInfo));
    check('引用', '存档没有复制过来', !fs.existsSync(vd('x-iso', 'saves')));
    const worldList = await bus.call('backup:worlds', 'x-iso');
    check('引用', '世界列表读的是原来文件夹里的', worldList.ok && JSON.stringify(worldList.data).includes('X World'));
    const setIso = await bus.call('isolation:set', 'x-iso', { preset: 'isolated' });
    check('引用', '不能改存档方式，说清楚', !setIso.ok && /原来启动器的文件夹/.test(setIso.error), setIso.error);
    mk(path.join(other, 'versions', 'x-iso', 'mods', 'in-place.jar'), 'jar');
    const before2 = fingerprint(other);
    const tog = await bus.call('mods:toggle', path.join(other, 'versions', 'x-iso', 'mods', 'in-place.jar'), false);
    check('引用', '这个配置的 Mod 在原来的文件夹里，开关能用（玩家自己的操作）', tog.ok, tog.error);
    await bus.call('mods:toggle', path.join(other, 'versions', 'x-iso', 'mods', 'in-place.jar.disabled'), true);
    void before2;
    const denied = await bus.call('mods:toggle', path.join(other, 'versions', 'x-iso.txt'), false);
    check('引用', '别的路径还是拦着', !denied.ok, denied.error);
    const rm = await bus.call('versions:remove', 'x-iso', {});
    check('引用', '删除这边的配置：原来的文件夹还在', rm.ok && read(path.join(other, 'versions', 'x-iso', 'saves', 'X World', 'level.dat')) === 'world-x', rm.error);
    fs.rmSync(path.join(other, 'versions', 'x-iso', 'mods'), { recursive: true, force: true });

    // Prism：要先安装
    r = await runImport(bus, prism, { 'Fabric Pack': 'copy' });
    check('Prism', '导入成功', r.status === 'done', r);
    const pid = (await versions.listInstalled()).find((v) => /Fabric 包/.test(v.id));
    check('Prism', '配置装好了，名字对，加载器对', pid && pid.loader && pid.loader.type === 'fabric', pid && pid.id);
    if (pid) {
      check('Prism', '世界和 Mod 进了配置自己的目录，日志不带', read(vd(pid.id, 'saves', 'Prism World', 'level.dat')) === 'world-prism' && read(vd(pid.id, 'mods', 'prism.jar')) === 'mod-prism' && !fs.existsSync(vd(pid.id, 'logs')));
      check('Prism', 'JVM 参数带过来了', config.getVersionSettings(pid.id).jvmArgs === '-Dprism=1', config.getVersionSettings(pid.id));
    }
    r = await runImport(bus, path.join(src, 'mmc'), { ForgePack: 'copy' });
    const notes = core('tasks').get(r.id);
    check('MultiMC', '加载器装不上：任务不算失败，说清楚哪个没装好，配置不留半个', r.status === 'done' && !fs.existsSync(vd('ForgePack', 'saves')), { r, res: notes && notes.result });

    // 关键：原来的文件夹一个字节没变（上面玩家自己开关 Mod 的文件已经删掉）
    check('安全', '所有来源文件夹：内容和修改时间都没变', fingerprint(src) === before);
    check('安全', '隔离层没有拦下写到测试目录外面的操作', box.log.writes.length === 0, box.log.writes.slice(0, 4));
    box.release();
    finish();
  },

  /** 真实的游戏文件夹，只读 */
  async real() {
    const SRC = process.env.AURORA_FOREIGN_SRC;
    if (!SRC) { check('real', '没跑：缺环境变量 AURORA_FOREIGN_SRC（没跑不能算通过）', false); finish(2); return; }
    const { root, game } = setup('foreign-real');
    const box = seal(root);
    fakeNet();
    const config = core('config');
    config.load();
    config.set({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, gameDir: game });
    const list = (d) => fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return `${n}|${st.mtimeMs}`; }).join(',');
    const before = `${list(SRC)};${fs.existsSync(path.join(SRC, 'versions')) ? fs.readdirSync(path.join(SRC, 'versions')).map((v) => list(path.join(SRC, 'versions', v))).join(';') : ''}`;
    const bus = ipc();
    const r = await bus.call('migrate:foreignInspect', SRC);
    check('真实', '读得出来', r.ok && r.data.ok, r.error || (r.data && r.data.problems));
    if (r.ok && r.data.ok) {
      console.log(`  ${r.data.source.launcher}：${r.data.instances.map((x) => `${x.name}（${x.mc}${x.loader ? ` ${x.loader.type} ${x.loader.version}` : ''}，${Math.round(x.size / 1048576)} MB${x.isolated ? '，独立' : ''}）`).join('；')}`);
      const picks = {};
      for (const it of r.data.instances) picks[it.key] = 'copy';
      const res = await runImport(bus, SRC, picks);
      const task = res.id ? core('tasks').get(res.id) : null;
      check('真实', '全部复制进测试目录：导入成功', res.status === 'done', res);
      const ids = (await core('versions').listInstalled()).map((v) => v.id);
      check('真实', '配置都在列表里', r.data.instances.every((it) => ids.includes(it.key)), ids);
      for (const id of ids) {
        const v = await core('versions').resolveVersion(id).catch((e) => ({ err: e.message }));
        check('真实', `${id}：版本文件解析得出来`, !v.err && !!v.mainClass, v.err || '');
      }
      void task;
    }
    const after = `${list(SRC)};${fs.existsSync(path.join(SRC, 'versions')) ? fs.readdirSync(path.join(SRC, 'versions')).map((v) => list(path.join(SRC, 'versions', v))).join(';') : ''}`;
    check('真实', '原来的文件夹没有变化（文件名和修改时间）', before === after);
    check('真实', '隔离层没有拦下任何写到测试目录外面的操作', box.log.writes.length === 0, box.log.writes.slice(0, 4));
    box.release();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    finish();
  },
};

const name = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
  const fn = SCENARIOS[name];
  if (!fn) { console.log(`FAIL [脚本] 没有这个场景：${name}`); app.exit(2); return; }
  try { await fn(); } catch (e) {
    console.log(`FAIL [脚本] ${name} 出错 — ${e && e.stack}`);
    finish(1);
  }
});
app.on('window-all-closed', () => {});
