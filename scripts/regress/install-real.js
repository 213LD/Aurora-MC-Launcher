'use strict';
/**
 * 真实的安装版、便携版、真实数据升级（2.0.0-pre2，接手以前人工测的部分）。
 *   node scripts/regress/install-real.js installer <旧版 Setup.exe> <新版 Setup.exe>
 *   node scripts/regress/install-real.js portable <便携版.exe>
 *   node scripts/regress/install-real.js realdata <打包好的 exe（win-unpacked 里的）>
 * 边界：安装目录和数据都在 AURORA_REGRESS_DIR 里；装之前查注册表，已经装过就不动；真实数据只读，测完核对哈希；
 * 真实数据的副本运行时屏蔽网络（不会用真实账号联网）；副本测完删掉。
 * 真实的游戏目录：AURORA_REAL_GAMES（分号隔开，第一个复制进副本，全部测完核对没被碰过）；不设就是 %APPDATA%\.minecraft。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { connect, waitExit, sleep, freePort, NO_THROTTLE, calm, waitFor } = require('./cdp');

const BASE = require('./editions').BASE;
const ED = require('./editions');
// 真实的启动器数据：这个版本自己的文件夹（AURORA_REAL_DATA 可以另指）。两个版本的真实数据都要守着没被碰过
const REAL_DATA = process.env.AURORA_REAL_DATA || path.join(process.env.APPDATA, ED.dataDirName);
const REAL_DIRS = [...new Set([REAL_DATA, ...Object.values(ED.TABLE).map((t) => path.join(process.env.APPDATA, t.dataDirName))])];
// 「新版」就是这份代码打出来的 exe：版本号看 package.json（公开版的副本里已经是公开版的号）
const WANT_VERSION = JSON.parse(fs.readFileSync(path.join(ED.REPO, 'package.json'), 'utf8')).version;
const REAL_GAMES = (process.env.AURORA_REAL_GAMES || path.join(process.env.APPDATA, '.minecraft')).split(';').map((d) => d.trim()).filter(Boolean);
const results = [];
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 400)}` : ''}`);
}

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], { encoding: 'utf8', windowsHide: true }).trim();
const uninstallKeys = () => ps(`foreach ($k in 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') { if (Test-Path $k) { Get-ChildItem $k -EA SilentlyContinue | % { $p = Get-ItemProperty $_.PSPath -EA SilentlyContinue; if ($p.DisplayName -match 'Aurora') { "$($p.DisplayName)|$($p.DisplayVersion)|$($p.InstallLocation)|$($p.UninstallString)" } } } }`).split(/\r?\n/).filter(Boolean);

/** 真实数据的指纹：文件名、大小、修改时间、内容哈希（只看 json 和顶层文件，不输出内容） */
function fingerprint(dir, deep = false) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (deep) walk(p, r); continue; }
      const st = fs.statSync(p);
      out[r] = `${st.size}:${Math.round(st.mtimeMs)}${st.size < 4 * 1024 * 1024 ? `:${crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')}` : ''}`;
    }
  };
  walk(dir, '');
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const realJson = () => { const o = {}; for (const d of REAL_DIRS) for (const n of ['config.json', 'accounts.json', 'plans.json']) { const f = path.join(d, n); if (fs.existsSync(f)) { const st = fs.statSync(f); o[`${path.basename(d)}/${n}`] = `${st.size}:${Math.round(st.mtimeMs)}:${crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex')}`; } } return o; };

function start(exe, port, env = {}, args = []) {
  const clean = { ...process.env, ...env };
  return spawn(exe, [`--remote-debugging-port=${port}`, ...NO_THROTTLE, ...args], { stdio: 'ignore', windowsHide: true, env: clean, detached: false });
}
const profile = (game, id, libs = []) => { const f = path.join(game, 'versions', id, `${id}.json`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ id, clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: libs })); };
const STATE = "(async () => ({ version: A.state.info.version, lang: window.I18N.getLang(), profiles: A.state.installed.map((v) => v.id).sort(), accounts: A.state.accounts.accounts.map((x) => x.name), config: { sidebarCollapsed: A.state.config.sidebarCollapsed, theme: A.state.config.theme, setupDone: A.state.config.setupDone }, notices: await A.api('app:dataNotices') }))()";

const SCENARIOS = {
  /** 安装旧版 → 用一下 → 覆盖安装新版 → 数据还在 → 卸载 */
  async installer(oldExe, newExe) {
    const before = uninstallKeys();
    if (before.length) { check('install', '这台电脑没有装过（装过就不动）', false, before); return; }
    check('install', '这台电脑没有装过，可以真实安装', true);
    // 版本号从安装包的文件名读，新旧换了不用改脚本
    const verOf = (f) => (path.basename(f).match(/Setup-(.+)\.exe$/i) || [])[1] || '';
    const oldVer = verOf(oldExe);
    const newVer = verOf(newExe);
    const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const desk = path.join(os.homedir(), 'Desktop');
    const lnk = 'Aurora MC Launcher.lnk';
    const hadLnk = fs.existsSync(path.join(desk, lnk)) || fs.existsSync(path.join(startMenu, lnk));
    if (hadLnk) { check('install', '没有同名快捷方式（有就不动）', false); return; }
    const real0 = realJson();
    const root = path.join(BASE, 'install-real', '安装 测试');
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
    const appDir = path.join(root, '程序 目录');
    const data = path.join(root, 'data'); const game = path.join(root, 'game');
    fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(game, { recursive: true });
    profile(game, 'Upgrade One', [{ name: 'net.fabricmc:fabric-loader:0.15.0' }]);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game }));
    const env = { AURORA_DATA_DIR: data, AURORA_GAME_DIR: game };
    let uninstalled = false;
    let running = null;
    try {
      // /D= 必须是最后一个参数，不带引号，路径可以有空格
      const r1 = spawnSync(`"${oldExe}" /S /currentuser /D=${appDir}`, { shell: true, windowsHide: true, timeout: 300000 });
      const exe = path.join(appDir, 'Aurora MC Launcher.exe');
      check('install', '安装旧版：静默安装到带中文和空格的目录', r1.status === 0 && fs.existsSync(exe), { status: r1.status });
      const k1 = uninstallKeys();
      check('install', '安装旧版：注册表有卸载项，版本对', k1.length === 1 && k1[0].includes(oldVer), k1);
      check('install', '安装旧版：有桌面和开始菜单快捷方式', fs.existsSync(path.join(desk, lnk)) && fs.existsSync(path.join(startMenu, lnk)));
      // 用旧版：写点真实数据
      let port = await freePort();
      let child = start(exe, port, env);
      let c = await connect(port);
      running = { child, c };
      const s1 = await c.ev(STATE);
      check('install', '旧版能启动', s1.version === oldVer && s1.profiles.includes('Upgrade One'), { version: s1.version, profiles: s1.profiles });
      await c.ev("A.api('accounts:addOffline', 'UpgradePlayer').then(() => A.refreshAccounts())");
      await c.ev("A.setConfig({ sidebarCollapsed: true, theme: 'light' })");
      await c.ev('A.api("isolation:set", "Upgrade One", { preset: "isolated" })');
      await c.quit();
      check('install', '旧版能正常退出', await waitExit(child));
      await waitFor(() => { try { fs.closeSync(fs.openSync(exe, 'r+')); return true; } catch { return false; } }, 15000);
      // 覆盖安装：不给 /D，看它是不是装回原来的目录
      const r2 = spawnSync(`"${newExe}" /S /currentuser`, { shell: true, windowsHide: true, timeout: 300000 });
      const k2 = uninstallKeys();
      check('install', '覆盖安装新版：只有一个卸载项，版本更新，还在原来的目录', r2.status === 0 && k2.length === 1 && k2[0].includes(newVer) && k2[0].toLowerCase().includes(appDir.toLowerCase()), k2);
      port = await freePort();
      child = start(exe, port, env);
      c = await connect(port);
      running = { child, c };
      const s2 = await c.ev(STATE);
      check('install', '覆盖安装后：版本是新的', s2.version === WANT_VERSION, { version: s2.version, want: WANT_VERSION });
      check('install', '覆盖安装后：账户、设置、配置都在', s2.accounts.includes('UpgradePlayer') && s2.config.sidebarCollapsed === true && s2.config.theme === 'light' && s2.profiles.includes('Upgrade One'), s2);
      check('install', '覆盖安装后：没有「数据读坏」的提示', !s2.notices || !s2.notices.length, s2.notices);
      const iso = await c.ev('A.api("isolation:get", "Upgrade One")');
      check('install', '覆盖安装后：配置的隔离策略还在', iso && iso.preset === 'isolated', iso && iso.preset);
      await c.quit();
      check('install', '新版能正常退出', await waitExit(child));
      check('install', '数据目录里没有读坏的文件', !fs.readdirSync(data).some((n) => n.includes('.corrupt-')));
      // 卸载
      const un = path.join(appDir, 'Uninstall Aurora MC Launcher.exe');
      const r3 = spawnSync(`"${un}" /S`, { shell: true, windowsHide: true, timeout: 120000 });
      for (let i = 0; i < 60 && fs.existsSync(exe); i++) await sleep(500);
      uninstalled = true;
      await waitFor(() => !uninstallKeys().length, 15000);
      check('install', '卸载：程序文件删了，注册表没了，快捷方式没了', r3.status === 0 && !fs.existsSync(exe) && !uninstallKeys().length && !fs.existsSync(path.join(desk, lnk)) && !fs.existsSync(path.join(startMenu, lnk)), { status: r3.status, keys: uninstallKeys() });
      check('install', '卸载：玩家数据留着', fs.existsSync(path.join(data, 'config.json')) && fs.existsSync(path.join(game, 'versions', 'Upgrade One')));
      check('install', '真实 Aurora 数据没有被碰过', same(real0, realJson()));
    } finally {
      // 中途出错也要卸干净，不把测试留在玩家电脑上
      if (!uninstalled) {
        if (running) { await running.c.quit().catch(() => {}); await waitExit(running.child); await waitFor(() => { try { fs.closeSync(fs.openSync(path.join(appDir, 'Aurora MC Launcher.exe'), 'r+')); return true; } catch { return false; } }, 15000); }
        const un = path.join(appDir, 'Uninstall Aurora MC Launcher.exe');
        if (fs.existsSync(un)) { spawnSync(`"${un}" /S`, { shell: true, windowsHide: true, timeout: 120000 }); await waitFor(() => !fs.existsSync(un), 30000); }
      }
    }
  },

  /** 便携版：带中文和空格的目录，标记文件，整个文件夹挪走再开 */
  async portable(exeSrc) {
    const real0 = realJson();
    const root = path.join(BASE, 'install-real', '便携 测试');
    fs.rmSync(root, { recursive: true, force: true });
    const a = path.join(root, '第一个 位置'); const b = path.join(root, '挪走 以后', '更深 一层');
    fs.mkdirSync(a, { recursive: true });
    const name = path.basename(exeSrc);
    fs.copyFileSync(exeSrc, path.join(a, name));
    fs.writeFileSync(path.join(a, 'aurora-portable.json'), JSON.stringify({ format: 'aurora-portable', note: 'test' }));
    // 预置配置，跳过第一次的向导；不设 AURORA_DATA_DIR，让它自己按标记文件找数据
    const dataA = path.join(a, 'AuroraData', 'launcher'); const gameA = path.join(a, 'AuroraData', '.minecraft');
    fs.mkdirSync(dataA, { recursive: true }); fs.mkdirSync(gameA, { recursive: true });
    profile(gameA, 'Portable One');
    fs.writeFileSync(path.join(dataA, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN' }));
    const env = { AURORA_DATA_DIR: '', AURORA_GAME_DIR: '' };
    let port = await freePort();
    let child = spawn(path.join(a, name), [`--remote-debugging-port=${port}`, ...NO_THROTTLE], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    let c = await connect(port);
    const s1 = await c.ev(STATE);
    const loc1 = await c.ev("A.api('location:get').catch((e) => ({ err: e.message }))");
    check('portable', '带中文和空格的目录里能启动，版本对', s1.version === WANT_VERSION, { version: s1.version, want: WANT_VERSION });
    check('portable', '按标记文件用旁边的 AuroraData', s1.profiles.includes('Portable One') && loc1 && loc1.mode === 'portable', { profiles: s1.profiles, mode: loc1 && loc1.mode, err: loc1 && loc1.err });
    await c.ev("A.api('accounts:addOffline', 'PortablePlayer').then(() => A.refreshAccounts())");
    await c.ev("A.setConfig({ sidebarCollapsed: true })");
    await c.quit();
    await waitExit(child);
    await waitFor(() => { try { fs.closeSync(fs.openSync(path.join(a, name), 'r+')); return true; } catch { return false; } }, 15000); // 便携版的外壳退出后还要清理解压出来的临时文件：等 exe 放开了再挪文件夹
    const cfg1 = JSON.parse(fs.readFileSync(path.join(dataA, 'config.json'), 'utf8'));
    check('portable', '数据写在文件夹里（不是系统目录）', fs.existsSync(path.join(dataA, 'accounts.json')), Object.keys(cfg1).length);
    // 整个文件夹挪走
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    port = await freePort();
    child = spawn(path.join(b, name), [`--remote-debugging-port=${port}`, ...NO_THROTTLE], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    c = await connect(port);
    const s2 = await c.ev(STATE);
    const game2 = await c.ev('A.state.config.gameDir');
    const pathsOk = await c.ev("A.api('location:get').catch(() => null)");
    check('portable', '整个文件夹挪走再开：账户、设置、配置都在', s2.accounts.includes('PortablePlayer') && s2.config.sidebarCollapsed === true && s2.profiles.includes('Portable One'), s2);
    check('portable', '挪走以后游戏目录跟着新位置，不指向旧位置', !String(game2 || '').includes('第一个 位置'), { gameDir: game2, data: pathsOk && pathsOk.dataDir });
    check('portable', '挪走以后没有「数据读坏」的提示', !s2.notices || !s2.notices.length, s2.notices);
    await c.quit();
    await waitExit(child);
    check('portable', '真实 Aurora 数据没有被碰过', same(real0, realJson()));
    check('portable', '旧位置没有留下东西', !fs.existsSync(a));
  },

  /** 真实数据的副本：真实 Aurora 数据和真实游戏目录（REAL_GAMES 的第一个）复制到草稿目录，用新版打开。屏蔽网络，测完删掉 */
  async realdata(exe) {
    const realA = REAL_DIRS.map((d) => fingerprint(d));
    const realG = REAL_GAMES.map((d) => fingerprint(d, false));
    const root = path.join(BASE, 'install-real', '真实数据副本');
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    let child = null;
    try {
      const data = path.join(root, 'data'); const game = path.join(root, 'game');
      fs.mkdirSync(root, { recursive: true });
      // Chromium 的缓存不用带
      const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'GPUPersistentCache', 'ShaderCache', 'Shared Dictionary', 'blob_storage', 'Network', 'Session Storage', 'Local Storage']);
      await fs.promises.cp(REAL_DATA, data, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || src === REAL_DATA });
      await fs.promises.cp(REAL_GAMES[0], game, { recursive: true }); // 不用 cpSync：系统 Node 24 不带 filter 时走 C++，中文目标路径会写到乱码目录
      const cfg0 = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
      const hadAccounts = fs.existsSync(path.join(data, 'accounts.json'));
      const plans0 = fs.existsSync(path.join(data, 'plans.json')) ? JSON.parse(fs.readFileSync(path.join(data, 'plans.json'), 'utf8')) : null;
      console.log(`  真实配置 ${Object.keys(cfg0).length} 项，账户文件 ${hadAccounts ? '有' : '没有'}，版本 ${fs.readdirSync(path.join(game, 'versions')).join('、')}`);
      const port = await freePort();
      child = start(exe, port, { AURORA_DATA_DIR: data, AURORA_GAME_DIR: game }, ['--host-resolver-rules=MAP * ~NOTFOUND']);
      const c = await connect(port);
      await calm(c.ev);
      const s = await c.ev(STATE);
      const cfgNow = await c.ev('A.state.config');
      check('realdata', '新版打开真实数据的副本，版本对', s.version === WANT_VERSION, { version: s.version, want: WANT_VERSION });
      check('realdata', '没有「数据读坏」的提示，也没有进第一次的向导', (!s.notices || !s.notices.length) && s.config.setupDone === cfg0.setupDone, { notices: s.notices, setupDone: s.config.setupDone });
      // 逐项比：原来有的值不能丢、不能变；新版补上的默认值和程序加的提示标记不算。只打印设置项的名字，不打印内容
      const lost = []; const added = [];
      const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
      const walk = (a, b, at) => {
        for (const k of Object.keys(a)) {
          const key = at ? `${at}.${k}` : k;
          if (key === 'gameDir' || key === 'tips.panHint.runs') continue; // runs 是每次打开加一的计数器
          if (isObj(a[k]) && isObj(b ? b[k] : null)) walk(a[k], b[k], key);
          else if (JSON.stringify(a[k]) !== JSON.stringify(b ? b[k] : undefined)) lost.push(key);
        }
        for (const k of Object.keys(b || {})) if (!(k in a)) added.push(at ? `${at}.${k}` : k);
      };
      walk(cfg0, cfgNow, '');
      console.log(`  新版多出来的设置项：${added.join('、') || '没有'}`);
      check('realdata', '原来的设置一项不差（游戏目录除外，测试时指到了副本）', lost.length === 0, lost);
      check('realdata', '账户读得出来', hadAccounts ? s.accounts.length > 0 : s.accounts.length === 0, { 账户数: s.accounts.length });
      const vs = fs.readdirSync(path.join(game, 'versions')).filter((n) => fs.existsSync(path.join(game, 'versions', n, `${n}.json`)));
      check('realdata', '配置都读得出来', vs.every((v) => s.profiles.includes(v)), { 实际: s.profiles, 文件夹: vs });
      if (plans0) {
        const plans = await c.ev("A.api('planner:list').catch(() => null)");
        check('realdata', 'Mod 清单读得出来', plans !== null, Array.isArray(plans) ? `${plans.length} 个` : typeof plans);
      }
      await c.quit();
      await waitExit(child);
      check('realdata', '退出后副本里没有读坏的文件', !fs.readdirSync(data).some((n) => n.includes('.corrupt-')));
      check('realdata', '真实 Aurora 数据没有被碰过（两个版本的数据文件夹）', same(realA, REAL_DIRS.map((d) => fingerprint(d))));
      check('realdata', '真实游戏目录没有被碰过', REAL_GAMES.every((d, i) => same(realG[i], fingerprint(d, false))));
    } finally {
      // 副本里是真实数据，可能有令牌：不管测试成没成功都删掉。不用 rmSync：系统 Node 24 删中文目录时崩过，崩了副本就留下了
      if (child && child.exitCode == null) { try { child.kill(); } catch { /* 已退出 */ } await waitExit(child, 5000); }
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
    check('realdata', '副本删掉了', !fs.existsSync(root));
  },
};

(async () => {
  const [name, ...rest] = process.argv.slice(2);
  if (!SCENARIOS[name]) { console.error('场景：installer portable realdata'); process.exit(2); }
  try { await SCENARIOS[name](...rest); } catch (e) { check(name, '脚本出错', false, e.stack || e.message); }
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
