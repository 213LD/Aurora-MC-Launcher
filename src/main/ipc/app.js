'use strict';
/** IPC：窗口、应用信息、缓存、数据存储位置、设置、还原、外链和文件对话框 */
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { app, shell, dialog } = require('electron');

const config = require('../engine/config');
const paths = require('../engine/paths');
const mirrors = require('../engine/mirrors');
const tasks = require('../engine/tasks');
const javaMgr = require('../core/java');
const news = require('../core/news');
const reset = require('../core/reset');
const backup = require('../core/backup');
const location = require('../engine/location');
const placecheck = require('../core/placecheck');
const gamelock = require('../core/gamelock');
const jsonStore = require('../engine/jsonstore');
const { writeFileSafe } = require('../engine/fileops');
const { exists, totalMemMB, freeMemMB } = require('../engine/util');
const { handle, send, getWin } = require('./bus');

// 打开文件夹、日志、崩溃报告用的接口。系统打开 exe 就是运行它，这里不接受能直接运行的文件（2.0.0-pre8，全面测试）
const RUNNABLE = /\.(exe|com|bat|cmd|msi|msp|scr|pif|cpl|hta|jar|jse?|vb[se]?|wsf|wsh|ws|ps1|psm1|psd1|lnk|url|reg|msc|appx|appxbundle|msix|appref-ms|chm|scf|sct|inf|settingcontent-ms|library-ms|search-ms|application|gadget)[. ]*$/i;
function assertNotRunnable(p) {
  if (typeof p !== 'string' || !p || RUNNABLE.test(p)) throw new Error('不能用这种方式打开这个文件');
  // NTFS 的备用数据流（a.txt:b.exe）：盘符后面再出现冒号的都不收
  if (p.indexOf(':', 2) >= 0) throw new Error('不能用这种方式打开这个文件');
}

function register() {
  // ── 窗口 ──
  handle('win:minimize', () => getWin().minimize());
  handle('win:maximize', () => { const w = getWin(); if (w.isMaximized()) w.unmaximize(); else w.maximize(); return w.isMaximized(); });
  handle('win:close', () => getWin().close());
  handle('win:isMaximized', () => getWin().isMaximized());

  // ── 应用与系统 ──
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: (os.cpus()[0] && os.cpus()[0].model) || '',
    cpuCount: os.cpus().length,
    totalMem: totalMemMB(),
    freeMem: freeMemMB(),
    dataDir: paths.dataDir(),
    defaultGameDir: paths.defaultGameDir(),
    edition: require('../engine/edition').name, // 'internal' / 'public'
    // 「跟随系统」时会用哪种语言
    systemLanguage: require('../../shared/i18n').resolve('auto', (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale()),
  }));
  handle('sys:memory', () => ({ total: totalMemMB(), free: freeMemMB() }));
  handle('sys:netProbe', () => require('../engine/netprobe').probe()); // 离线模式：有没有网（1.8.0）
  // 主页背景按这台电脑推荐的档位（性能打磨）
  handle('sys:bgAdvice', () => require('../core/bgfit').advice());
  // 主页背景用的原版资源：终末之诗、音效（从已装好的游戏里读，1.5.16）
  handle('sys:endPoem', () => require('../core/gameassets').endPoem());
  handle('sys:gameSound', (event) => require('../core/gameassets').sound(String(event || '')));
  // 无障碍：打开讲述人设置页；打开 Windows 11 的实时辅助字幕（22H2 起才有，没有就说明替代办法）
  handle('sys:a11yOpen', async (kind) => {
    if (kind === 'narrator') {
      await shell.openExternal('ms-settings:easeofaccess-narrator');
      return { title: '已打开讲述人设置', hint: '在设置里打开「讲述人」即可朗读界面；以后随时按 Ctrl + Win + Enter 开关讲述人' };
    }
    if (kind === 'captions') {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'LiveCaptions.exe');
      if (await exists(exe)) {
        // 启动失败（被组策略拦了、文件坏了）是异步报的 error 事件：不接住会成为主进程里没人处理的异常
        const cp = require('child_process').spawn(exe, [], { detached: true, stdio: 'ignore' });
        cp.on('error', (e) => console.warn('[captions]', e.message));
        cp.unref();
        return { title: '已打开实时辅助字幕', hint: '第一次使用时 Windows 会下载语言包；以后可以直接按 Win + Ctrl + L 开关' };
      }
      return { title: '这台电脑没有实时辅助字幕', hint: '实时辅助字幕要 Windows 11 22H2 或更新的版本。也可以在 Minecraft 里打开字幕（选项 → 音乐和声音 → 显示字幕），或者打开「默认打开游戏字幕」' };
    }
    throw new Error('不支持的无障碍工具');
  });
  handle('app:disclaimer', () => {
    const d = require('../disclaimer');
    return { version: d.VERSION, updated: d.UPDATED, sections: d.SECTIONS, accepted: config.get().disclaimerAccepted === d.VERSION };
  });
  // 只记现在这一版声明：界面传来别的版本号（旧页面、被改过的调用）不算同意了现在这一版
  handle('app:acceptDisclaimer', (version) => {
    if (version !== require('../disclaimer').VERSION) throw new Error('免责声明已经更新，请重新阅读后再确认');
    config.set({ disclaimerAccepted: version, disclaimerAcceptedAt: Date.now() });
    return true;
  });
  // 首次启动向导：存档方式等；flush 保证随后切换数据位置时新位置的配置里也有这些选项
  handle('app:finishSetup', async (patch = {}) => {
    const allowed = { setupDone: true };
    if (patch.newProfileIsolation === 'shared' || patch.newProfileIsolation === 'isolated') allowed.newProfileIsolation = patch.newProfileIsolation;
    // 选了「安装推荐的 Java」又要换数据位置：记下来，重启后再下载
    if (typeof patch.pendingJava === 'string' && javaMgr.COMPONENT_NAMES[patch.pendingJava]) allowed.pendingJava = patch.pendingJava;
    config.set(allowed);
    await config.flush();
    return true;
  });
  handle('app:quit', () => app.quit());
  // 数据文件读坏 / 读不了（core/jsonstore.js，1.10.7）：界面准备好后取走攒着的，之后的直接发过去
  handle('app:dataNotices', () => jsonStore.drain((n) => send('data:notice', n)));
  // 切换界面语言（1.10.0）：写进设置，主进程换语言，整个窗口按新语言重新加载（网址参数 ?lang=）
  handle('app:setLanguage', async (id) => {
    const i18n = require('../../shared/i18n');
    config.set({ language: id || 'auto' });
    await config.flush();
    const sys = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale();
    const lang = i18n.setLang(i18n.resolve(id || 'auto', sys));
    const w = getWin();
    if (w) setTimeout(() => w.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'), { query: { lang } }), 50);
    return lang;
  });
  // 缓存（1.4.30）：Modrinth / CurseForge 的资源信息、图片（Chromium 的 HTTP 缓存）、下载的安装器和整合包
  const DL_CACHE = ['installers', 'modpacks'];
  handle('cache:usage', async () => {
    const info = await require('../engine/apicache').usage();
    const images = await require('electron').session.defaultSession.getCacheSize().catch(() => 0);
    const dl = { bytes: 0, files: 0 };
    for (const d of DL_CACHE) { const r = await backup.dirSize(path.join(paths.cacheDir(), d)); dl.bytes += r.bytes; dl.files += r.files; }
    return { info, images, downloads: dl };
  });
  handle('cache:clear', async (what) => {
    if (what === 'info' || what === 'all') await require('../engine/apicache').clear();
    if (what === 'images' || what === 'all') await require('electron').session.defaultSession.clearCache();
    if (what === 'downloads' || what === 'all') {
      if (tasks.hasLocks() || [...tasks.list()].some((t) => t.status === 'running' && ['install', 'modpack', 'java'].includes(t.kind))) throw new Error('有安装任务正在进行，等它完成后再清理下载缓存');
      for (const d of DL_CACHE) await require('../engine/util').rmrf(path.join(paths.cacheDir(), d));
    }
    return true;
  });
  // ── 数据存储位置 ──
  handle('location:get', () => ({ ...location.get(), gameDir: config.get().gameDir, systemGameDir: paths.systemGameDir() }));
  handle('location:size', async (dir) => location.dirSize(dir, 5000));
  // 首次启动时看看系统里有没有已经在用的 .minecraft（向导也用它看当前游戏目录）
  handle('location:probeGame', async (target) => {
    const dir = typeof target === 'string' && path.isAbsolute(target) ? target : paths.systemGameDir();
    const names = await fsp.readdir(path.join(dir, 'versions')).catch(() => null);
    const saves = await fsp.readdir(path.join(dir, 'saves')).catch(() => []);
    return { dir, exists: !!names, versions: names ? names.length : 0, saves: saves.length };
  });
  handle('location:switch', async (opts) => {
    await gamelock.assertNone('换数据存储位置');
    // 失败时由打开它的对话框提示
    return tasks.run({ title: '切换数据存储位置', kind: 'location', doneText: '已完成，重启后生效' }, (task) => location.switchTo(opts, task));
  });
  handle('location:relaunch', () => { setTimeout(() => location.relaunch(), 300); return true; });
  // ── 运行位置检测 ──
  handle('place:check', () => placecheck.check());
  handle('place:ignore', (issues) => placecheck.ignore(issues));
  handle('place:probe', (dir, kind) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('请选择一个文件夹'); // 相对路径会探测到当前目录
    return placecheck.probe(dir, kind);
  });
  handle('place:suggest', () => placecheck.suggest());
  handle('place:move', async (dir, opts) => {
    await gamelock.assertNone('移动启动器');
    return tasks.run({ title: '移动启动器', kind: 'location', doneText: '已完成，正在从新位置重启' }, (task) => placecheck.moveTo(dir, opts || {}, task));
  });
  handle('place:relaunch', () => { setTimeout(() => placecheck.relaunchMoved(), 300); return true; });
  handle('mirror:label', async () => { await mirrors.probe(); return mirrors.currentSourceLabel(); });
  // ── 配置 ──
  handle('config:get', () => config.get());
  // 调试菜单的显卡 / 处理器模拟器（1.5.7，只在这次运行里有效）：不传参数取当前模拟，传 null 取消
  handle('debug:hardware', (spec) => (spec === undefined ? require('../core/hardware').simulation() : require('../core/hardware').simulate(spec)));
  handle('config:debug', (action) => (action === 'hasBackup' ? config.hasDebugBackup() : config.debugAction(action)));
  // 主进程自己改了设置（移除 / 卸载默认的 Java 等）要告诉界面，不然界面还拿着旧的（1.10.8）。界面自己改的它已经知道了
  let fromUi = false;
  config.onChange((c) => { if (!fromUi) send('config:changed', c); });
  handle('config:set', (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的设置');
    const before = config.get().gameDir;
    fromUi = true;
    let c;
    try { c = config.set(patch || {}); } finally { fromUi = false; }
    if (patch && patch.gameDir && patch.gameDir !== before) send('versions:changed');
    return c;
  });
  // ── 一键还原启动器 ──
  handle('reset:preview', () => reset.preview());
  handle('reset:run', (opts) => reset.run(opts || {}));
  handle('reset:relaunch', () => { setTimeout(() => location.relaunch(), 300); return true; });
  // ── 新闻 ──
  handle('news:list', () => news.patchNotes(10));
  handle('news:body', (p) => news.patchNoteBody(p));

  // ── Shell / 对话框 ──
  handle('shell:open', async (p) => { assertNotRunnable(p); if (await exists(p)) return shell.openPath(p); throw new Error('路径不存在'); });
  handle('shell:showItem', (p) => { if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('路径不对'); shell.showItemInFolder(p); });
  handle('shell:external', (url) => {
    // 先按网址解析一遍再打开：只收 http / https，交给系统的是解析后规范的写法
    let u = null;
    try { u = typeof url === 'string' ? new URL(url) : null; } catch { /* 不是网址 */ }
    if (u && (u.protocol === 'https:' || u.protocol === 'http:')) return shell.openExternal(u.href);
    throw new Error('仅支持网页链接');
  });
  handle('dialog:folder', async (title, defaultPath) => {
    const r = await dialog.showOpenDialog(getWin(), { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (title, filters, multi) => {
    const r = await dialog.showOpenDialog(getWin(), { title, filters, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'] });
    return r.canceled ? null : multi ? r.filePaths : r.filePaths[0];
  });
  handle('dialog:saveBinary', async (title, defaultName, base64, filters) => {
    const r = await dialog.showSaveDialog(getWin(), { title, defaultPath: defaultName, filters });
    if (r.canceled || !r.filePath) return null;
    await writeFileSafe(r.filePath, Buffer.from(base64, 'base64'));
    return r.filePath;
  });
  handle('dialog:save', async (title, defaultName, content) => {
    const r = await dialog.showSaveDialog(getWin(), { title, defaultPath: defaultName });
    if (r.canceled || !r.filePath) return null;
    await writeFileSafe(r.filePath, content, 'utf8');
    return r.filePath;
  });
  // 启动时后台测速
  mirrors.probe().catch(() => {});
}

module.exports = register;
