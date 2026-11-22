'use strict';
const path = require('path');
const { app, BrowserWindow, Menu, Tray, shell, nativeImage, screen, session } = require('electron');
// 数据存储位置（系统默认 / 便携 / 自定义 / 测试用的 AURORA_DATA_DIR）必须在其他模块读取 userData 之前确定
require('./engine/location').init();
const config = require('./engine/config');
const ipc = require('./ipc');
// 程序图标：装着极光和一棵橡树的玻璃方块，各个大小分别画好打包在一个 ico 里（scripts/brand-icons.js）。窗口、任务栏、托盘都用它
const ICON = path.join(__dirname, 'brand', 'icon.ico');
const { isAppPage } = require('./engine/apppage');
const i18n = require('../shared/i18n');
const { t } = i18n;

const isDev = process.argv.includes('--dev');
// 公开版不给开发者工具（有人会被骗着往里粘贴东西）。内部版照旧 F12 / Ctrl+Shift+I
const EDITION = require('./engine/edition');
const PUBLIC_EDITION = EDITION.PUBLIC;
let win = null;

const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

app.setAppUserModelId(EDITION.appId);

// 性能模式会关掉硬件加速，必须在 app ready 之前决定，所以这里先读一次设置
try {
  config.load();
  if (config.get().perfMode) app.disableHardwareAcceleration();
} catch { /* 读不到设置就照常启动 */ }

function createWindow() {
  const icon = nativeImage.createFromPath(ICON);
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 1000,
    minHeight: 660,
    frame: false,
    show: false,
    backgroundColor: config.get().theme === 'light' ? '#eef1f7' : '#0b0d14',
    icon,
    title: EDITION.title(),
    webPreferences: {
      devTools: !PUBLIC_EDITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 背景音乐需要在没有用户操作时也能开始播放
      autoplayPolicy: 'no-user-gesture-required',
      // 无障碍「大字号」：最小字号 13px，只能在建窗口时定，切换后要重启
      minimumFontSize: (config.get().a11y || {}).largeText ? 13 : 0,
    },
  });
  Menu.setApplicationMenu(null);
  if (process.env.AURORA_SHOT_DIR) require('./devshot').attach(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { lang: i18n.getLang() } });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', applyZoom);

  win.on('maximize', () => ipc.send('win:maximized', true));
  win.on('unmaximize', () => ipc.send('win:maximized', false));

  // 外部链接一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 只能留在启动器自己的页面：以前 file:// 都放行，磁盘上任何一个 HTML 都能在这个窗口里打开，还带着 aurora 接口（2.0.0-pre8）
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppPage(url)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (!PUBLIC_EDITION && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
    if (input.key === 'F5' && isDev) win.webContents.reload();
  });
  win.on('closed', () => { win = null; });
}

/** 无障碍「界面缩放」：整体放大网页，窗口最小尺寸跟着放大（不超过屏幕工作区） */
function applyZoom() {
  if (!win) return;
  const z = Math.min(2, Math.max(1, Number((config.get().a11y || {}).zoom) || 1));
  win.webContents.setZoomFactor(z);
  const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
  const mw = Math.min(Math.round(1000 * z), area.width);
  const mh = Math.min(Math.round(660 * z), area.height);
  win.setMinimumSize(mw, mh);
  const [w, h] = win.getSize();
  if (!win.isMaximized() && (w < mw || h < mh)) { win.setSize(Math.max(w, mw), Math.max(h, mh)); win.center(); }
}

let tray = null;

function showWindow() {
  if (!win) { createWindow(); return; }
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip(EDITION.title());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.show'), click: showWindow },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

/**
 * 网页权限默认全拒（2.0.0-pre8）。Electron 不设的话通知、麦克风、摄像头这些请求一律同意。
 * 启动器只用到写剪贴板（复制按钮）和全屏
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
function lockPermissions() {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

app.whenReady().then(async () => {
  lockPermissions();
  config.load();
  // 打包时只带了中英文的 Chromium 语言包（1.4.12），getLocale 在其他系统语言下可能退回 en-US，先看系统首选语言
  const sysLang = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale();
  // 结构化消息（shared/i18n msg）在主进程按语言出句子，要用界面翻译字典：语言不是简中时读进来
  i18n.useTr((id) => {
    if (globalThis.I18N_TR && globalThis.I18N_TR[id]) return;
    try {
      const src = require('fs').readFileSync(path.join(__dirname, '..', 'shared', 'i18n', `tr-${id}.js`), 'utf8');
      const box = { window: {} };
      require('vm').runInNewContext(src, box, { timeout: 2000 });
      globalThis.I18N_TR = { ...(globalThis.I18N_TR || {}), ...(box.window.I18N_TR || {}) };
    } catch (e) { console.warn('[i18n] 读不了翻译字典', id, e.message); }
  });
  i18n.setLang(i18n.resolve(config.get().language, sysLang));
  ipc.register(() => win);
  config.onChange((_d, patch) => { if (patch && patch.a11y && 'zoom' in patch.a11y) applyZoom(); });
  // 上次没有正常退出：先把半成品收拾好，界面才看到对的配置和世界，最多等 1.5 秒，不能挡住启动。
  // 正常启动不等，过一会儿在后台顺手清掉旧的临时文件
  if (primary) {
    const recover = require('./core/recover');
    const quiet = () => recover.run().catch((e) => console.warn('[recover]', e.message));
    if (recover.markRunning()) await Promise.race([quiet(), new Promise((r) => { setTimeout(r, 1500); })]);
    else setTimeout(quiet, 20000);
  }
  createWindow();
  createTray();
  // 在启动器根目录生成免责声明（失败时忽略）
  setTimeout(() => require('./disclaimer').writeFile(), 1500);
  // 首次启动就切到了便携 / 自定义位置：清理系统默认位置里留下的空配置
  if (config.get().cleanupDefaultData) {
    setTimeout(() => require('./engine/location').cleanupDefault().catch(() => false).then(() => config.set({ cleanupDefaultData: false })), 4000);
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  app.quit();
});

// 退出前写完还没落盘的设置和缓存，只拦第一次
let quitFlushed = false;
app.on('before-quit', (e) => {
  if (quitFlushed) return;
  quitFlushed = true;
  e.preventDefault();
  require('./engine/shutdown').run().catch(() => {}).finally(() => app.quit());
});
