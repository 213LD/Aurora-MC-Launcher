'use strict';
/**
 * 需要真实启动游戏的回归：游戏开着时的各种操作。
 *
 * 环境变量（缺了就跳过）：
 *   AURORA_REGRESS_GAME_SRC   一个装好 1.20.1 的游戏目录（有 libraries、assets、versions/1.20.1），只读，会复制一份
 *   AURORA_REGRESS_JAVA_HOME  Java 17 的目录（有 bin/javaw.exe），只读，会复制到隔离数据目录的 runtime 里
 * 用法：electron scripts/regress/game-locks.js <own|sandbox|root>
 *
 * 用手工做的超平坦世界 + --quickPlaySingleplayer 直接进世界，游戏才真的占着 session.lock 和区域文件。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { app } = require('electron');
const H = require('./harness');

const { sleep, setup, core, ipc, tree, check, finish } = H;
const SRC = process.env.AURORA_REGRESS_GAME_SRC;
const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;

const { MC, makeWorld, writeOptions, prepareGame, makeProfile, waitInWorld, killAll, common } = require('./game-kit');

const SCENARIOS = {
  /** 独立配置，游戏开着：改名、切隔离、复制、Mod 操作、卸载 Java、删除 */
  async own() {
    const c = await common('own');
    const id = `aurora-regress-trash-game-${Date.now()}`;
    const gd = await makeProfile(c.game, id);
    c.config.setVersionSettings(id, { isolation: 'on', gameArgs: '--quickPlaySingleplayer RegressWorld' });
    await c.profiles.writeMeta(id, { type: 'custom' });
    await writeOptions(gd);
    await makeWorld(path.join(gd, 'saves'), 'RegressWorld');
    await fsp.mkdir(path.join(gd, 'mods'), { recursive: true });
    await fsp.writeFile(path.join(gd, 'mods', 'demo.jar'), 'x');
    await c.profiles.writeMeta(id, { presets: [{ name: 'P', enabled: [] }] });
    const r = await c.bus.call('launch:start', id, {});
    if (!r.ok) { check('6-1', '真实启动游戏', false, r.error); return; }
    const w = await waitInWorld(id, r.data.id);
    check('6-1', '游戏真的进了世界（确认场景成立）', w.ok, w.ok ? '' : w);
    if (!w.ok) { await killAll(); return; }
    const world = path.join(gd, 'saves', 'RegressWorld');
    await fsp.writeFile(path.join(world, 'player-progress.txt'), '玩家的进度');
    const before = (await tree(world)).length;
    console.log(`  世界文件 ${before} 个，session.lock 存在=${fs.existsSync(path.join(world, 'session.lock'))}`);
    const refuse = (res) => !res.ok && /游戏|运行/.test(res.error || '');
    // 改名
    let res = await c.bus.call('versions:rename', id, `${id}-renamed`);
    check('6-1', '游戏开着：改名被拒绝，并说明原因', refuse(res), res.ok ? '成功了' : res.error);
    const liveId = fs.existsSync(c.versions.versionDir(id)) ? id : `${id}-renamed`;
    // 切隔离
    res = await c.bus.call('isolation:set', liveId, { preset: 'shared', source: '@root' });
    check('6-1', '游戏开着：切隔离被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    // 复制
    res = await c.bus.call('profiles:duplicate', liveId, `${id}-copy`, {});
    check('6-1', '游戏开着：复制配置被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    // Mod
    res = await c.bus.call('mods:toggle', path.join(c.versions.versionDir(liveId), 'mods', 'demo.jar'), false);
    check('6-1', '游戏开着：开关 Mod 被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    res = await c.bus.call('mods:presetApply', liveId, 'P');
    check('6-1', '游戏开着：切换 Mod 方案被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    res = await c.bus.call('mods:disableAll', liveId);
    check('6-1', '游戏开着：全部禁用被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    res = await c.bus.call('mods:restoreAll', liveId);
    check('6-1', '游戏开着：恢复全部 Mod 被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    res = await c.bus.call('mods:remove', path.join(c.versions.versionDir(liveId), 'mods', 'demo.jar'), liveId, { permanent: true });
    check('6-1', '游戏开着：删除 Mod 被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    res = await c.bus.call('planner:applyEdit', { versionId: liveId, plan: { items: [] }, removeMode: 'disable' });
    check('6-1', '游戏开着：配置器修改被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    res = await c.bus.call('profiles:backupSaves', liveId);
    check('6-1', '游戏开着：删除前的存档备份被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    res = await c.bus.call('versions:removeInfo', liveId);
    check('6-1', '游戏开着：删除确认框一开始就知道游戏在运行', res.ok && !!res.data.running, res.ok ? res.data.running : res.error);
    res = await c.bus.call('location:switch', { mode: 'custom', dir: path.join(c.root, 'moved'), game: 'keep' });
    check('6-1', '游戏开着：换数据存储位置被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    // 卸载正在用的 Java
    res = await c.bus.call('java:uninstall', path.join(c.data, 'runtime', 'regress-java'));
    const javaOk = fs.existsSync(path.join(c.data, 'runtime', 'regress-java', 'bin', 'java.exe'));
    check('6-1', '游戏开着：卸载正在用的 Java 被拒绝，Java 完好', refuse(res) && javaOk, { refused: !res.ok, msg: res.error, javaExists: javaOk });
    // 删除：不永久（这里用真实回收站时只会动这个带 aurora-regress-trash 名字的测试配置）
    if (process.env.AURORA_REGRESS_REAL_TRASH !== '1') process.env.AURORA_TEST_TRASH = path.join(c.root, 'fake-trash');
    res = await c.bus.call('versions:remove', liveId, { permanent: false });
    const code = res.reason && res.reason.code;
    console.log(`  实测：游戏开着删除（进回收站）ok=${res.ok} code=${code} msg=${String(res.error).slice(0, 100)}`);
    check('6-3', '游戏开着删除：不说「回收站不可用」', !res.ok && code !== 'TRASH_UNAVAILABLE', { ok: res.ok, code });
    let after = fs.existsSync(world) ? (await tree(world)).length : 0;
    check('6-3', '游戏开着删除：世界文件一个不少', after >= before, { before, after });
    // 删除：永久（修之前界面会引导到这一步）
    res = await c.bus.call('versions:remove', liveId, { permanent: true });
    after = fs.existsSync(world) ? (await tree(world)).length : 0;
    check('6-3', '游戏开着永久删除也被拒绝，世界文件一个不少', !res.ok && after >= before, { ok: res.ok, before, after, msg: String(res.error).slice(0, 80) });
    await killAll();
    const progress = await fsp.readFile(path.join(world, 'player-progress.txt'), 'utf8').catch(() => null);
    check('6-1', '关掉游戏后，玩家的世界还在', !!progress && fs.existsSync(path.join(world, 'level.dat')), { progress: !!progress, levelDat: fs.existsSync(path.join(world, 'level.dat')) });
    // 真实回收站模式下如果测试配置被移进了回收站，还原并清理
    if (process.env.AURORA_REGRESS_REAL_TRASH === '1' && !fs.existsSync(gd)) await restoreFromBin(path.basename(gd), path.dirname(gd));
  },

  /** 测试副本配置，游戏开着再启动一个实例 */
  async sandbox() {
    const c = await common('sandbox');
    const id = 'GameSB';
    await makeProfile(c.game, id);
    await makeWorld(path.join(c.game, 'saves'), 'RegressWorld');
    await writeOptions(c.versions.versionDir(id));
    await writeOptions(c.game);
    c.config.setVersionSettings(id, { isolation: 'on', gameArgs: '--quickPlaySingleplayer RegressWorld' });
    await c.profiles.writeMeta(id, { type: 'custom', isolation: { preset: 'sandbox', source: '@root' } });
    const gd = c.versions.versionDir(id);
    const r = await c.bus.call('launch:start', id, {});
    if (!r.ok) { check('7-4', '真实启动游戏', false, r.error); return; }
    const w = await waitInWorld(id, r.data.id);
    check('7-4', '游戏真的进了副本世界（确认场景成立）', w.ok, w.ok ? '' : w);
    if (!w.ok) { await killAll(); return; }
    const world = path.join(gd, 'saves', 'RegressWorld');
    await fsp.writeFile(path.join(world, 'player-progress.txt'), '在副本里玩的进度');
    console.log(`  副本世界文件 ${(await tree(world)).length} 个，session.lock 存在=${fs.existsSync(path.join(world, 'session.lock'))}`);
    const t0 = Date.now();
    const second = await c.bus.call('launch:start', id, {});
    console.log(`  第二个实例：ok=${second.ok} 用时 ${Date.now() - t0}ms ${second.ok ? '' : String(second.error).slice(0, 160)}`);
    const progress = await fsp.readFile(path.join(world, 'player-progress.txt'), 'utf8').catch(() => null);
    const last = path.join(gd, 'saves.aurora-sandbox-last', 'RegressWorld', 'player-progress.txt');
    const kept = progress === '在副本里玩的进度' || fs.existsSync(last);
    check('7-4', '游戏开着再启动一个实例：副本里的进度还在', kept, { inPlace: !!progress, inLast: fs.existsSync(last) });
    await killAll();
    const end = await fsp.readFile(path.join(world, 'player-progress.txt'), 'utf8').catch(() => null);
    check('7-4', '全部关掉后，副本世界和进度都在原处', end === '在副本里玩的进度', { progress: !!end, tree: fs.existsSync(world) ? (await tree(world)).length : 0 });
  },

  /** 公共目录的世界被开着：别的配置来导入、转正、同步设置 */
  async root() {
    const c = await common('root');
    await makeWorld(path.join(c.game, 'saves'), 'RootWorld');
    await writeOptions(c.game);
    c.config.setVersionSettings(MC, { gameArgs: '--quickPlaySingleplayer RootWorld' });
    await c.profiles.writeMeta(MC, { type: 'vanilla' });
    await H.fakeVersion('Target');
    c.config.setVersionSettings('Target', { isolation: 'on' });
    await c.profiles.writeMeta('Target', { type: 'custom' });
    await H.fakeVersion('Sand');
    c.config.setVersionSettings('Sand', { isolation: 'on' });
    await c.profiles.writeMeta('Sand', { type: 'custom', isolation: { preset: 'sandbox', source: '@root' } });
    await fsp.mkdir(path.join(c.versions.versionDir('Sand'), 'saves'), { recursive: true });
    const r = await c.bus.call('launch:start', MC, {});
    if (!r.ok) { check('6-1', '真实启动游戏', false, r.error); return; }
    const w = await waitInWorld(MC, r.data.id);
    check('6-1', '游戏真的在公共目录进了世界（确认场景成立）', w.ok, w.ok ? '' : w);
    if (!w.ok) { await killAll(); return; }
    const refuse = (res) => !res.ok && /游戏|运行/.test(res.error || '');
    let res = await c.bus.call('backup:importWorlds', 'Target', '@root', ['RootWorld']);
    check('6-1', '公共目录的世界正开着：从「公共目录」导入被拒绝（修之前只比 @root 这个 id）', refuse(res), res.ok ? '成功了，复制的是正在写入的存档' : res.error);
    res = await c.bus.call('isolation:promote', 'Sand', { saves: 'fresh' });
    check('6-1', '来源的世界正开着：转正（重新复制）被拒绝', refuse(res), res.ok ? '成功了，复制的是正在写入的存档' : res.error);
    await H.fakeVersion('RootSibling', { loader: false });
    await c.profiles.writeMeta('RootSibling', { type: 'vanilla' });
    res = await c.bus.call('gamesync:copyTo', 'RootSibling', ['Target'], null);
    check('6-1', '共用同一游戏目录的配置在跑：同步设置被拒绝', refuse(res), res.ok ? '成功了' : res.error);
    // 公共目录的配置改成独立时带世界（1.10.9）：世界正开着，不能复制写到一半的存档
    await H.fakeVersion('PubSibling', { loader: false });
    c.config.setVersionSettings('PubSibling', { isolation: 'none' });
    let bi = await c.bus.call('isolation:bringInfo', 'PubSibling', { preset: 'isolated' });
    check('4-1', '公共目录的世界正开着：询问时说明是谁占着', bi.ok && bi.data.ask === true && bi.data.busy === MC, bi.ok ? { ask: bi.data.ask, busy: bi.data.busy } : bi);
    res = await c.bus.call('isolation:bringWorlds', 'PubSibling', { preset: 'isolated' }, ['RootWorld']);
    const pubInfo = await c.versions.versionInfo('PubSibling');
    check('4-1', '公共目录的世界正开着：复制被拒绝，配置还在公共目录', refuse(res) && path.resolve(c.versions.gameDirFor('PubSibling', pubInfo)) === path.resolve(c.game) && !fs.existsSync(path.join(c.versions.versionDir('PubSibling'), 'saves.aurora-bring-tmp')), res.ok ? '成功了，复制的是正在写入的存档' : res.error);
    bi = await c.bus.call('isolation:bringInfo', MC, { preset: 'isolated' });
    check('4-1', '正开着的配置自己：直接拒绝切换', refuse(bi), bi.ok ? bi.data : bi.error);
    // 全局设置（1.10.10）：会被搬走的配置正开着，不能改
    const gi = await c.bus.call('isolation:globalInfo', 'all');
    check('4-1', '全局：会被搬走的配置正开着，直接拒绝改设置', refuse(gi) && c.config.get().isolation === 'modded', gi.ok ? gi.data.outgoing.map((x) => x.id) : gi.error);
    const ga = await c.bus.call('isolation:globalApply', 'all', {});
    check('4-1', '全局：直接改也被拒绝', refuse(ga) && c.config.get().isolation === 'modded', ga.ok ? '成功了' : ga.error);
    // 不该被拦的：别的独立配置的 Mod 操作不受公共目录里的游戏影响
    await fsp.mkdir(path.join(c.versions.versionDir('Target'), 'mods'), { recursive: true });
    await fsp.writeFile(path.join(c.versions.versionDir('Target'), 'mods', 'demo.jar'), 'x');
    res = await c.bus.call('mods:toggle', path.join(c.versions.versionDir('Target'), 'mods', 'demo.jar'), false);
    check('6-1', '公共目录的游戏开着：别的独立配置的 Mod 还能开关（不误拦）', res.ok, res.error || '');
    res = await c.bus.call('versions:rename', 'Target', 'TargetRenamed');
    check('6-1', '公共目录的游戏开着：别的独立配置还能改名（不误拦）', res.ok, res.error || '');
    await killAll();
  },
};

async function restoreFromBin(name, dir) {
  const { execFileSync } = require('child_process');
  const cmd = '$bin=(New-Object -ComObject Shell.Application).Namespace(10); $hit=@($bin.Items() | Where-Object { $_.Name -eq $env:T_NAME }); if ($hit.Count -ne 1) { "found:$($hit.Count)"; exit }; (New-Object -ComObject Shell.Application).Namespace($env:T_DIR).MoveHere($hit[0], 0x14); Start-Sleep 2; "restored"';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, env: { ...process.env, T_NAME: name, T_DIR: dir } }).trim();
  console.log(`  从回收站还原测试配置：${out}`);
  await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
}

(async () => {
  await app.whenReady();
  const name = process.argv[process.argv.length - 1];
  if (!SRC || !JAVA) { check('game', '跳过：没设 AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME', true); finish(); return; }
  if (!SCENARIOS[name]) { console.log(`场景：${Object.keys(SCENARIOS).join(' ')}`); finish(2); return; }
  try {
    await SCENARIOS[name]();
  } catch (e) {
    check(name, '脚本运行出错', false, e.stack || String(e));
    await killAll().catch(() => {});
  }
  finish();
})();
