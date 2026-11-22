'use strict';
/**
 * 数据存储位置
 * - default：系统默认（%APPDATA%）
 * - portable：便携，启动器 exe 所在文件夹下的 AuroraData/（launcher/ 放启动器数据，.minecraft/ 放游戏），
 *   由 exe 旁边的 aurora-portable.json 标记，整个文件夹可以直接拷走
 * - custom：自定义文件夹（同样的 launcher/ + .minecraft/ 结构），由默认数据目录里的 location.json 指向
 * 必须在 app ready 之前调用 init()，因为要改 userData 路径。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const BRAND = require('../../shared/brand');
const EDITION = require('./edition');
const { under, copyDir, writeFileSafe } = require('./fileops');

const MARKER = 'aurora-portable.json';
const PORTABLE_DIR = 'AuroraData';
const POINTER = 'location.json';
const TOKEN = '@aurora-data';

let state = { mode: 'default', base: null, error: '' };

const { rootDir } = require('./rootdir');
const { nm } = require('../../shared/i18n');
const app = () => require('electron').app;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

/** 安装版的安装目录会被卸载程序整个删除，所以便携模式只给便携版 exe（和开发环境）用 */
function canPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR || !app().isPackaged;
}

function init() {
  const a = app();
  // 记住重定向之前的系统默认位置（指针文件就放在这里）。
  // 目录名固定用 BRAND.dataDirName（公开版用 BRAND.publicEdition.dataDirName，见 engine/edition.js），不随 productName 变化：以后改名时老用户的数据还在原处
  if (!global.__auroraDefaultUserData) global.__auroraDefaultUserData = path.join(a.getPath('appData'), EDITION.dataDirName);
  // 开发时测试首次启动向导：把「系统默认位置」换成测试文件夹（打包后无效，不会碰到玩家的数据）
  if (process.env.AURORA_TEST_DEFAULT_DIR && !a.isPackaged) global.__auroraDefaultUserData = path.resolve(process.env.AURORA_TEST_DEFAULT_DIR);
  const def = global.__auroraDefaultUserData;
  state ={ mode: 'default', base: null, defaultDataDir: def, error: '' };
  if (process.env.AURORA_DATA_DIR) {
    a.setPath('userData', path.resolve(process.env.AURORA_DATA_DIR));
    state.mode = 'env';
  } else {
    let base = null;
    let mode = 'default';
    if (fs.existsSync(path.join(rootDir(), MARKER))) { mode = 'portable'; base = path.join(rootDir(), PORTABLE_DIR); }
    else {
      const ptr = readJson(path.join(def, POINTER));
      if (ptr && typeof ptr.dir === 'string' && path.isAbsolute(ptr.dir)) { mode = 'custom'; base = ptr.dir; }
    }
    if (a.getPath('userData') !== def) a.setPath('userData', def);
    if (base) {
      try {
        fs.mkdirSync(path.join(base, 'launcher'), { recursive: true });
        a.setPath('userData', path.join(base, 'launcher'));
        state.mode = mode;
        state.base = base;
      } catch (e) {
        // 例如自定义文件夹所在的移动硬盘没插上：回到默认位置，并在设置页提示
        state.error = `无法使用数据文件夹 ${base}（${e.code || e.message}），已临时使用系统默认位置`;
        state.failedBase = base;
        state.failedMode = mode;
      }
    }
  }
  state.dataDir = a.getPath('userData');
  return state;
}

function get() {
  return { ...state, root: rootDir(), canPortable: canPortable(), portableBase: path.join(rootDir(), PORTABLE_DIR) };
}

/** 便携 / 自定义模式下的默认游戏目录 */
function gameDirDefault() {
  return state.base ? path.join(state.base, '.minecraft') : null;
}

// ───────────── 配置中的路径：便携模式下按相对位置保存，文件夹换盘符或换电脑后依然有效 ─────────────
function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}
function pack(obj, base = state.base) {
  if (!base) return obj;
  return mapStrings(obj, (s) => (path.isAbsolute(s) && under(s, base) ? path.join(TOKEN, path.relative(base, s)) : s));
}
function unpack(obj, base = state.base) {
  if (!base) return obj;
  return mapStrings(obj, (s) => (s === TOKEN || s.startsWith(TOKEN + path.sep) || s.startsWith(`${TOKEN}/`) ? path.join(base, s.slice(TOKEN.length)) : s));
}

// ───────────────────────── 切换 ─────────────────────────
async function writable(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const probe = path.join(dir, `.aurora-write-test-${process.pid}`);
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe, { force: true });
}

/** 统计目录大小（最多用 limitMs 毫秒，超时返回已统计的部分并标记 partial） */
async function dirSize(dir, limitMs = 4000) {
  const t0 = Date.now();
  let bytes = 0; let files = 0; let partial = false;
  const walk = async (d) => {
    if (Date.now() - t0 > limitMs) { partial = true; return; }
    let list;
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { bytes += (await fsp.stat(p)).size; files++; } catch { /* 忽略 */ } }
    }
  };
  await walk(dir);
  return { bytes, files, partial };
}

/** 复制目录：跳过目录联接 / 符号链接（共享存档的联接会在下次启动时按隔离策略重建） */
/** 复制整个目录（规则见 fileops.copyDir）。以前读不了的文件夹会悄悄跳过，换位置时等于丢数据；现在报错停下 */
const copyTree = (src, dst, onFile) => copyDir(src, dst, { onFile });

/** 启动器自己的数据（不复制 Electron 的浏览器缓存） */
async function launcherEntries(dir) {
  const list = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  // runtime：启动器下载的 Java；backups：删除存档前做的备份（core/saves.js）
  return list.filter((e) => (e.isFile() && /\.json$/i.test(e.name) && e.name !== POINTER) || (e.isDirectory() && (e.name === 'runtime' || e.name === 'backups'))).map((e) => e.name);
}

/**
 * 切换存储位置
 * @param {{mode: 'default'|'portable'|'custom', dir?: string, game: 'copy'|'empty'|'keep'}} opts
 */
async function switchTo(opts, task) {
  const config = require('./config');
  const paths = require('./paths');
  if (state.mode === 'env') throw new Error('当前通过环境变量指定了数据目录，无法切换');
  const { mode } = opts;
  let base = null;
  if (mode === 'portable') {
    if (!canPortable()) throw new Error('安装版请使用「自定义文件夹」，便携模式需要使用便携版 exe');
    base = path.join(rootDir(), PORTABLE_DIR);
  } else if (mode === 'custom') {
    if (!opts.dir || !path.isAbsolute(opts.dir)) throw new Error('请选择一个文件夹');
    base = path.resolve(opts.dir);
    if (app().isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && under(base, rootDir())) throw new Error('不能放在启动器的安装目录里（卸载时会被删除），请换一个文件夹');
  } else if (mode !== 'default') throw new Error('未知的存储位置');

  const fromData = app().getPath('userData');
  const toData = base ? path.join(base, 'launcher') : state.defaultDataDir;
  const cfg = config.get();
  const fromGame = cfg.gameDir;
  const toGame = opts.game === 'keep' ? fromGame : base ? path.join(base, '.minecraft') : paths.systemGameDir();

  task.update({ detail: '检查目标文件夹…', progress: -1 });
  try { await writable(toData); } catch (e) { throw new Error(`目标文件夹无法写入：${e.code || e.message}`); }
  if (opts.game !== 'keep') await writable(toGame);

  // 1. 启动器数据（配置、账户、方案、启动器下载的 Java）
  if (path.resolve(fromData) !== path.resolve(toData)) {
    for (const name of await launcherEntries(fromData)) {
      task.update({ detail: `复制启动器数据：${nm(name)}` });
      const s = path.join(fromData, name);
      if ((await fsp.stat(s)).isDirectory()) await copyTree(s, path.join(toData, name), () => {});
      else await fsp.copyFile(s, path.join(toData, name));
    }
  }

  // 2. 游戏目录
  if (opts.game === 'copy' && path.resolve(fromGame) !== path.resolve(toGame)) {
    const total = (await dirSize(fromGame, 15000)).files || 1;
    let done = 0;
    await copyTree(fromGame, toGame, (name) => {
      done++;
      if (done % 25 === 0 || done === total) task.update({ detail: `复制游戏目录：${done}/${total} · ${nm(name)}`, progress: Math.min(0.99, done / total) });
    });
  }

  // 3. 新位置的配置：路径改到新位置，并按新位置的相对路径保存
  await config.flush();
  let next = JSON.parse(JSON.stringify(cfg));
  const swap = (from, to) => { if (from && to && path.resolve(from) !== path.resolve(to)) next = mapStrings(next, (s) => (path.isAbsolute(s) && under(s, from) ? path.join(to, path.relative(from, s)) : s)); };
  swap(fromData, toData);
  if (opts.game !== 'keep') swap(fromGame, toGame);
  next.gameDir = toGame;
  // 首次启动就选了便携 / 自定义：系统默认位置里只有刚生成的空配置，重启后把它清掉
  next.cleanupDefaultData = !!opts.firstRun && mode !== 'default' && path.resolve(fromData) === path.resolve(state.defaultDataDir);
  await writeFileSafe(path.join(toData, 'config.json'), JSON.stringify(pack(next, base), null, 2), 'utf8');

  // 4. 记录新位置：便携标记 / 指针文件
  const marker = path.join(rootDir(), MARKER);
  const pointer = path.join(state.defaultDataDir, POINTER);
  if (mode === 'portable') {
    await writeFileSafe(marker, JSON.stringify({ format: 'aurora-portable', note: `存在此文件时，${BRAND.name} 把所有数据保存在旁边的 AuroraData 文件夹中` }, null, 2), 'utf8');
    await fsp.rm(pointer, { force: true });
  } else {
    await fsp.rm(marker, { force: true }).catch(() => {});
    if (mode === 'custom') {
      await writeFileSafe(pointer, JSON.stringify({ dir: base }, null, 2), 'utf8');
    } else await fsp.rm(pointer, { force: true });
  }
  return { mode, dataDir: toData, gameDir: toGame, oldDataDir: fromData, oldGameDir: fromGame };
}

/** 删除系统默认位置里首次启动留下的数据（指针文件保留），失败静默忽略 */
async function cleanupDefault() {
  const def = state.defaultDataDir;
  if (!def || (state.mode !== 'portable' && state.mode !== 'custom')) return false;
  if (path.resolve(def) === path.resolve(app().getPath('userData'))) return false;
  for (const n of await fsp.readdir(def).catch(() => [])) {
    if (n === POINTER) continue;
    await fsp.rm(path.join(def, n), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
  if (state.mode === 'portable') await fsp.rmdir(def).catch(() => {});
  return true;
}

function relaunch() {
  const a = app();
  // 便携版 exe 运行时实际程序在临时目录，需要重新启动外层的 exe
  if (process.env.PORTABLE_EXECUTABLE_FILE) a.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE, args: [] });
  else a.relaunch();
  a.exit(0);
}

module.exports = { init, get, gameDirDefault, pack, unpack, switchTo, relaunch, dirSize, cleanupDefault, writable, copyTree, launcherEntries, rootDir, MARKER, PORTABLE_DIR };
