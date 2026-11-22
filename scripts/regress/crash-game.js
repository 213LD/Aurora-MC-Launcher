'use strict';
/**
 * 真进游戏时启动器崩了（2.0.0-pre8，全面测试高优先级第 5 项）。要 AURORA_REGRESS_GAME_SRC 和 AURORA_REGRESS_JAVA_HOME。
 *   node scripts/regress/crash-game.js
 * - 只杀启动器：游戏接着跑，重启启动器后认得出游戏还开着，不能删配置；关掉游戏后一切正常
 * - 连游戏一起杀（模拟电脑突然重启，**不是真的重启**）：重启启动器后数据完好，留下的 session.lock 不挡路
 * 启动器关在隔离层里。只杀这个测试自己启动的进程（按 PID）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { start } = require('./robust-ui');
const { sleep, until, waitFor } = require('./cdp');

const IS_CHILD = !!process.versions.electron;
const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const OUT = process.env.AURORA_REGRESS_OUT;
const SRC = process.env.AURORA_REGRESS_GAME_SRC;
const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
const WORLD = 'CrashWorld';

if (IS_CHILD) {
  // 只负责造一个能进的世界（level.dat 要用启动器自己的 NBT 写）
  const { app } = require('electron');
  app.whenReady().then(async () => {
    const H = require('./harness');
    const kit = require('./game-kit');
    const dir = process.argv[process.argv.length - 1];
    H.setup('crash-game-mk');
    await kit.makeWorld(dir, WORLD);
    app.exit(0);
  });
} else main();

function main() {
  const results = [];
  const check = (name, ok, detail = '') => {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    results.push({ id: '崩溃', name, ok: !!ok, detail: d });
    console.log(`${ok ? 'PASS' : 'FAIL'} [崩溃] ${name}${d ? ` — ${d.slice(0, 600)}` : ''}`);
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已经没了 */ } };

  (async () => {
    if (!SRC || !JAVA) { console.log('  没设 AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME，跳过'); return; }
    process.env.AURORA_SANDBOX_SPAWN_ALLOW = '(javaw?\\.exe|taskkill(\\.exe)?|tasklist(\\.exe)?|powershell(\\.exe)?)$';
    const root = path.join(BASE, 'crash-game');
    const prepare = ({ game }) => {
      for (const d of ['libraries', 'assets']) fs.symlinkSync(path.join(SRC, d), path.join(game, d), 'junction');
      fs.cpSync(path.join(SRC, 'versions', '1.20.1'), path.join(game, 'versions', '1.20.1'), { recursive: true });
      fs.writeFileSync(path.join(game, 'options.txt'), 'onboardAccessibility:false\nsoundCategory_master:0.0\nsoundCategory_music:0.0\npauseOnLostFocus:false\nlang:en_us\n');
      fs.mkdirSync(path.join(game, 'saves'), { recursive: true });
      const r = spawnSync(path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'), [__filename, path.join(game, 'saves')], { env: { ...process.env, AURORA_REGRESS_DIR: path.join(BASE, 'crash-game-mk') }, windowsHide: true, timeout: 60000 });
      if (!fs.existsSync(path.join(game, 'saves', WORLD, 'level.dat'))) throw new Error(`造世界失败 ${r.status}`);
    };
    const config = (game) => ({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: '1.20.1', isolation: 'none', afterLaunch: 'keep', restoreOnExit: false, gameArgs: `--quickPlaySingleplayer ${WORLD}`, java: { selected: path.join(JAVA, 'bin', 'javaw.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false }, crashMarker: 'keep-me' });
    const game = path.join(root, 'game');
    const world = path.join(game, 'saves', WORLD);
    const launchAndEnter = async (a) => {
      const r = await a.ev("aurora.invoke('launch:start', '1.20.1', {})", 180000);
      if (!r.ok) throw new Error(`启动失败：${r.error}`);
      const id = r.data.id;
      for (let i = 0; i < 200; i++) {
        const log = await a.ev(`aurora.invoke('games:log', ${JSON.stringify(id)}).then((x) => x.data.map((l) => l.text).join('\\n'))`);
        if (/joined the game|logged in with entity id/.test(log)) return { id, pid: r.data.pid };
        const st = await a.ev(`aurora.invoke('games:list').then((x) => (x.data.find((g) => g.id === ${JSON.stringify(id)}) || {}).state)`);
        if (st === 'exited') throw new Error(`游戏退出了：${log.slice(-400)}`);
        await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      throw new Error('等进世界超时');
    };
    const dataOk = async (a) => {
      const prob = [];
      const cfg = await a.ev('aurora.invoke("config:get").then((r) => r.data)');
      if (cfg.crashMarker !== 'keep-me') prob.push('设置丢了');
      const acc = await a.ev('aurora.invoke("accounts:list").then((r) => r.data)');
      if (!acc.accounts.some((x) => x.name === 'CrashPlayer')) prob.push('账户丢了');
      const ids = await a.ev('aurora.invoke("versions:installed").then((r) => r.data.map((v) => v.id))');
      if (!ids.includes('1.20.1')) prob.push('配置不在列表里');
      if (!fs.existsSync(path.join(world, 'level.dat'))) prob.push('世界的 level.dat 没了');
      return prob;
    };

    // ── 只杀启动器 ──
    let a = await start('crash-game', { root, prepare, config });
    if (a.startError) throw new Error(a.startError);
    await a.ev("aurora.invoke('accounts:addOffline', 'CrashPlayer')");
    await a.ev("aurora.invoke('config:set', { touched: 1 })");
    let g = await launchAndEnter(a);
    check('确认场景成立：游戏进了世界', true, `Java 进程 ${g.pid}`);
    a.child.kill(); // Windows 上是 TerminateProcess，不给启动器任何收尾的机会
    await waitFor(() => !alive(a.child.pid), 15000); await sleep(1000); // pitfall-ok：先等启动器真的没了，再看一秒游戏有没有跟着退出（证明「没有」只能看一段时间）
    check('只杀启动器：游戏还开着', alive(g.pid));
    a = await start('crash-game', { root, keepData: true });
    if (a.startError) throw new Error(a.startError);
    let prob = await dataOk(a);
    check('只杀启动器：重启后设置、账户、配置、世界都在', prob.length === 0, prob);
    const rm = await a.ev("aurora.invoke('versions:remove', '1.20.1', {})");
    check('只杀启动器：认得出游戏还开着，不让删配置', !rm.ok && /运行|占用|开着/.test(rm.error), rm.error || '');
    const info = await a.ev("aurora.invoke('versions:removeInfo', '1.20.1').then((r) => r.data)");
    check('只杀启动器：删除前的提示也知道游戏开着', !!info.running, info.running || '');
    killTree(g.pid);
    await until(a.ev, "aurora.invoke('versions:removeInfo', '1.20.1').then((r) => !r.data.running)", 15000); // 外面开的游戏查询有 5 秒缓存：等它认出游戏关了（最多 15 秒）
    const rmInfo2 = await a.ev("aurora.invoke('versions:removeInfo', '1.20.1').then((r) => r.data)");
    check('只杀启动器：游戏关掉以后不再拦', !rmInfo2.running, rmInfo2.running || '');
    check('只杀启动器：页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
    await a.stop();

    // ── 连游戏一起杀：模拟电脑突然重启 ──
    a = await start('crash-game', { root, keepData: true });
    if (a.startError) throw new Error(a.startError);
    g = await launchAndEnter(a);
    await waitFor(() => fs.existsSync(path.join(world, 'session.lock')), 30000); // 等游戏真的打开了世界
    const lockHeld = fs.existsSync(path.join(world, 'session.lock'));
    killTree(a.child.pid);
    await waitFor(() => !alive(a.child.pid) && !alive(g.pid), 15000);
    check('模拟突然重启：启动器和游戏都没了', !alive(a.child.pid) && !alive(g.pid), { launcher: alive(a.child.pid), game: alive(g.pid) });
    a = await start('crash-game', { root, keepData: true });
    if (a.startError) throw new Error(a.startError);
    prob = await dataOk(a);
    check('模拟突然重启：重启后设置、账户、配置、世界都在', prob.length === 0, prob);
    const running = await a.ev("aurora.invoke('games:list').then((r) => r.data.filter((x) => x.state !== 'exited').length)");
    check('模拟突然重启：没有幽灵游戏', running === 0, String(running));
    const b = await a.ev("aurora.invoke('backup:create', '1.20.1', { type: 'saves' })", 60000);
    check(`模拟突然重启：留下的 session.lock${lockHeld ? '' : '（没有）'}不挡备份`, b.ok, b.error || '');
    const again = await launchAndEnter(a).then(() => null, (e) => e.message);
    check('模拟突然重启：还能再进同一个世界', !again, again || '');
    for (const x of (await a.ev("aurora.invoke('games:list').then((r) => r.data)"))) if (x.state !== 'exited') killTree(x.pid);
    await until(a.ev, "aurora.invoke('games:list').then((r) => r.data.every((x) => x.state === 'exited'))", 15000);
    check('模拟突然重启：页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
    await a.stop();
  })().catch((e) => check('脚本运行', false, e.stack || String(e))).finally(() => {
    if (OUT && results.length) fs.appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const bad = results.filter((r) => !r.ok).length;
    console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
    process.exit(bad ? 1 : 0);
  });
}
