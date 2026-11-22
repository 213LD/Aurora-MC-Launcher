'use strict';
/**
 * electron -r 用：把整个启动器关进 sandbox-hook 的隔离层（真实窗口的安全、坏输入测试）。
 * 记下主进程未捕获的异常（真实程序里就是弹「主进程出错」的窗口）和隔离层拦下的东西，写到 AURORA_SANDBOX_ROOT/sandbox-log.json。
 * AURORA_BADNET 设了的话，所有网络请求都由 bad-net 的规则回答（见 badResponse）。
 */
const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const { seal } = require('./sandbox-hook');

const root = process.env.AURORA_SANDBOX_ROOT;
const out = path.join(root, 'sandbox-log.json');
const nativeWrite = fs.writeFileSync;
// 开发时运行，程序启动 1.5 秒后会在项目根目录生成「免责声明.txt」（内容没变就不写）。刚导出的公开版副本、刚克隆的仓库里没有这个文件，
// 程序一写就被隔离层当成「写到测试目录外面」拦下；关进隔离层之前先替它写好，和平时开发时运行留下的一样。
// 程序目录用工作目录：测试都是在程序目录里跑 `electron .`（-r 加载这里时 app.getAppPath() 还是 Electron 自带的 default_app）
try {
  const d = require(path.join(process.cwd(), 'src', 'main', 'disclaimer.js'));
  const file = path.join(process.cwd(), d.FILE_NAME);
  const content = `\uFEFF${d.text()}\r\n`;
  let same = false;
  try { same = fs.readFileSync(file, 'utf8') === content; } catch { /* 还没有 */ }
  if (!same) fs.writeFileSync(file, content, 'utf8');
} catch { /* 老版本的程序（升级测试）没有这些导出：照旧 */ }
const box = seal(root);
box.allowQuit();
if (process.env.AURORA_SANDBOX_SAVE_TO) require('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: process.env.AURORA_SANDBOX_SAVE_TO });
const crashes = [];
const add = (kind, e) => crashes.push({ kind, text: String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ').slice(0, 500) });
process.on('uncaughtException', (e) => add('uncaught', e));
process.on('unhandledRejection', (e) => add('rejection', e));

/** 各种坏的接口返回。不是随机的：每种都是真实可能碰到的（接口改版、代理返回错误页、半截响应） */
function badResponse(mode, url) {
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const shapes = {
    html: () => new Response('<html><body><h1>502 Bad Gateway</h1><img src=x onerror=window.__xss=1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    error500: () => new Response('oops', { status: 500 }),
    empty: () => new Response('', { status: 200 }),
    nulljson: () => json(null),
    arrayjson: () => json([]),
    numberjson: () => json(5),
    truncated: () => new Response('{"hits":[{"title":"半截', { status: 200 }),
    // 字段都在但类型全错：最容易让界面崩
    wrongtypes: () => json({ hits: 5, total_hits: 'x', data: 'x', versions: 7, latest: 3, entries: 'x', files: 'x', categories: 9, pagination: 'x', loaders: 1, game_versions: 2 }),
    wrongitems: () => json({ hits: [null, 5, 'x', {}, { title: 5, slug: {}, icon_url: 9, versions: 'x', categories: 5, downloads: 'x', follows: {}, author: [] }], total_hits: 5, data: [null, 5, 'x', {}, { name: 5, id: 'x', authors: 5, logo: 5, categories: 5, latestFiles: 5 }], versions: [null, 5, 'x', {}, { id: 5, type: 5, url: 5 }], latest: {}, entries: [null, 5, {}, { title: 5, version: {}, image: 5 }], pagination: {} }),
    xss: () => json({ hits: [{ project_id: 'p1', slug: 'x', title: '<img src=x onerror=window.__xss=1>', description: '<script>window.__xss=1</script>', author: '<b>a</b>', icon_url: 'javascript:window.__xss=1', categories: ['<i>x</i>'], versions: ['1.20.1'], downloads: 1, follows: 1, project_type: 'mod', body: '<img src=x onerror=window.__xss=1>' }], total_hits: 1, data: [{ id: 1, name: '<img src=x onerror=window.__xss=1>', summary: '<script>window.__xss=1</script>', authors: [{ name: '<b>x</b>' }], logo: { url: 'javascript:window.__xss=1' }, links: { websiteUrl: 'javascript:window.__xss=1' }, categories: [], latestFiles: [], downloadCount: 1 }], entries: [{ title: '<img src=x onerror=window.__xss=1>', version: '1', type: 'release', body: '<img src=x onerror=window.__xss=1>', image: { url: 'javascript:1' }, contentPath: '../../x' }], pagination: { totalCount: 1 }, latest: { release: '1', snapshot: '1' }, versions: [{ id: '<img src=x onerror=window.__xss=1>', type: 'release', url: 'https://x/', releaseTime: 'x' }] }),
    huge: () => json({ hits: Array.from({ length: 5000 }, (_, i) => ({ project_id: `p${i}`, slug: `s${i}`, title: `项目 ${i}`, description: 'd'.repeat(2000), categories: [], versions: [], downloads: 1, follows: 1, project_type: 'mod' })), total_hits: 5000 }),
  };
  void url;
  return (shapes[mode] || shapes.error500)();
}

const mode = process.env.AURORA_BADNET;
if (mode) {
  const answer = async (u) => {
    const url = u && u.url ? u.url : String(u);
    box.log.net.push(url.slice(0, 200));
    if (mode === 'hang') return new Promise(() => {}); // 一直不回答：要靠超时
    if (mode === 'fixture') return require('./net-fixture').answer(url); // 固定的版本列表和加载器列表（界面快照量联网的弹窗用）
    return badResponse(mode, url);
  };
  net.fetch = answer;
  app.whenReady().then(() => { require('electron').session.defaultSession.fetch = answer; }).catch(() => {});
}

// 这台电脑上装了哪些 Java 不能影响界面测试（rc9：界面快照的基线存下以后，电脑上多装了一个 JDK，
// Java 页、配置卡片上的标记、设置里的几行全跟着变了）。AURORA_SANDBOX_JAVAS 是一份 JSON 列表（可以是 []）：检测 Java 的结果固定成它
if (process.env.AURORA_SANDBOX_JAVAS) {
  app.whenReady().then(() => {
    const fixed = JSON.parse(process.env.AURORA_SANDBOX_JAVAS);
    require(path.join(process.cwd(), 'src', 'main', 'core', 'java')).detect = async () => JSON.parse(JSON.stringify(fixed));
  }).catch(() => {});
}

// 这台电脑上装了哪些别的启动器也不能算进快照（rc12：「从其他启动器导入」列出了本机真实的官方启动器目录，换台电脑就不一样）。
// AURORA_SANDBOX_FOREIGN 是一份 JSON 列表：找别的启动器的结果固定成它
if (process.env.AURORA_SANDBOX_FOREIGN) {
  app.whenReady().then(() => {
    const fixed = JSON.parse(process.env.AURORA_SANDBOX_FOREIGN);
    require(path.join(process.cwd(), 'src', 'main', 'core', 'foreign')).scan = async () => JSON.parse(JSON.stringify(fixed));
  }).catch(() => {});
}

// 内存泄漏测试要看主进程：强制 GC 后的堆，和长期存在的表有多大。debug 命名空间在预加载的白名单里
if (process.env.AURORA_SANDBOX_STATS) {
  const { ipcMain } = require('electron');
  const v8 = require('v8');
  v8.setFlagsFromString('--expose-gc');
  const gc = require('vm').runInNewContext('gc');
  const coreDir = path.join(process.cwd(), 'src', 'main', 'core');
  const engineDir = path.join(process.cwd(), 'src', 'main', 'engine');
  ipcMain.handle('debug:__mainStats', async () => {
    for (let i = 0; i < 3; i++) { gc(); await new Promise((r) => setImmediate(r)); }
    const m = process.memoryUsage();
    const tasks = require(path.join(engineDir, 'tasks'));
    const launcher = require(path.join(coreDir, 'launcher'));
    return { ok: true, data: { heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss, tasks: tasks.list().length, games: launcher.listGames().length, handles: process._getActiveHandles().length, listeners: process.listenerCount('uncaughtException') } };
  });
  // 用真实的下载器和任务引擎从本机服务器下载：测下载循环
  ipcMain.handle('debug:__download', async (_e, url, count) => {
    const tasks = require(path.join(engineDir, 'tasks'));
    const { downloadAll } = require(path.join(engineDir, 'downloader'));
    const dir = path.join(root, 'downloads', String(Date.now()));
    const list = Array.from({ length: count }, (_, i) => ({ urls: [`${url}?i=${i}`], path: path.join(dir, `f${i}.bin`) }));
    const id = await new Promise((resolve) => {
      const t = tasks.start({ title: '泄漏测试下载', kind: 'mod', doneText: '完成' }, (task) => downloadAll(list, { task, label: '下载' }), () => resolve(t));
    });
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, data: id };
  });
  // 游戏日志窗口：模拟长日志（真的走 webContents.send 这条路）
  ipcMain.handle('debug:__gameLog', (e, id, lines) => { e.sender.send('game:log', { id, lines }); return { ok: true, data: true }; });
  // 给界面发任意一条主进程事件（模拟游戏退出这些）；让下一次「另存为」对话框选到指定的文件（只能在测试目录里，写屏障照样管着）
  ipcMain.handle('debug:__send', (e, channel, payload) => { e.sender.send(String(channel), payload); return { ok: true, data: true }; });
  ipcMain.handle('debug:__saveTo', (_e, file) => {
    const { dialog } = require('electron');
    const canceled = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => { dialog.showSaveDialog = canceled; return { canceled: false, filePath: String(file) }; };
    return { ok: true, data: true };
  });
}

// 定时落盘，测试随时可以看；窗口关掉前也写一次。这里写的是自己的日志，绕过屏障
const flush = () => {
  try { nativeWrite(out, JSON.stringify({ crashes, writes: box.log.writes, spawns: box.log.spawns.slice(-50), shell: box.log.shell.slice(-200), net: box.log.net.slice(-50), quit: box.log.quit }, null, 1)); } catch { /* 下次再写 */ }
};
setInterval(flush, 500).unref();
global.__auroraSandbox = { box, flush, realQuit: () => { box.release(); require('electron').app.exit(0); } };
void path;
