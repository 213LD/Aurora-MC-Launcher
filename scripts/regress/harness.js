'use strict';
/**
 * 回归脚本的公共部分（在 Electron 主进程里跑）：隔离的数据目录和游戏目录、加载核心模块、直接调用 IPC 处理函数、
 * 用不共享的方式占用文件、记录结果。
 * 所有文件都放在 AURORA_REGRESS_DIR（默认系统临时目录下的 aurora-regress，公开版是 aurora-regress-public：两个版本可以同时跑，见 editions.js）里，不碰真实数据。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, ipcMain } = require('electron');

const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建隔离目录，要在加载任何核心模块之前调用。keep：保留上一步留下的文件（分两个进程的场景） */
function setup(name, { keep = false } = {}) {
  const root = path.join(BASE, name);
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data');
  const game = path.join(root, 'game');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(game, { recursive: true });
  process.env.AURORA_DATA_DIR = data;
  process.env.AURORA_GAME_DIR = game;
  app.setPath('userData', data);
  return { root, data, game };
}

/** 主进程模块：引擎在 engine/，功能在 core/（2.0.0-pre9 按分层搬的） */
const core = (m) => {
  const engine = path.join(REPO, 'src', 'main', 'engine', `${m}.js`);
  return require(fs.existsSync(engine) ? engine : path.join(REPO, 'src', 'main', 'core', m));
};

/** 把 ipc.js 注册的处理函数收集起来，用和界面一样的路径调用（返回 { ok, data, error, reason }） */
function ipc() {
  const handlers = new Map();
  ipcMain.handle = (ch, fn) => { handlers.set(ch, fn); };
  require(path.join(REPO, 'src', 'main', 'ipc.js')).register(() => null);
  const call = async (ch, ...args) => {
    const h = handlers.get(ch);
    if (!h) return { ok: false, error: `没有这个通道：${ch}`, missing: true };
    return h({}, ...args);
  };
  return { call, has: (ch) => handlers.has(ch) };
}

/** 用另一个进程占用文件。share：None（完全不共享）或 ReadWrite,Delete（Java NIO 默认的打开方式） */
async function lockFile(file, share = 'None', seconds = 60) {
  const flag = `${file}.${Date.now()}.locked`;
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[IO.File]::Open($env:LOCK_FILE,'Open','ReadWrite',$env:LOCK_SHARE); New-Item -ItemType File -Path $env:LOCK_FLAG | Out-Null; Start-Sleep ${seconds}; $f.Close()`],
  { windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCK_FILE: file, LOCK_SHARE: share, LOCK_FLAG: flag } });
  for (let i = 0; i < 200 && !fs.existsSync(flag); i++) await sleep(100);
  if (!fs.existsSync(flag)) throw new Error(`占用文件失败：${file}`);
  fs.rmSync(flag, { force: true });
  return async () => {
    ps.kill();
    await new Promise((r) => { ps.once('exit', r); setTimeout(r, 2000); });
    await waitFor(() => { try { fs.closeSync(fs.openSync(file, 'r+')); return true; } catch { return false; } }, 5000);
  };
}

/** 假的版本（没有游戏文件），用来测配置档案、隔离这些不需要真启动的逻辑 */
async function fakeVersion(id, { loader = true, extra = {} } = {}) {
  const dir = core('versions').versionDir(id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify({
    id, type: 'release', mainClass: 'net.minecraft.client.main.Main',
    libraries: loader ? [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] : [], ...extra,
  }));
  return dir;
}

/** 目录树里的文件（相对路径，/ 分隔），用来看状态 */
async function tree(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  await walk(dir);
  return out.sort();
}

/** dir 下面有没有内容等于 text 的文件（判断「读坏的文件有没有留下来」） */
async function findWithContent(dir, text) {
  for (const f of await tree(dir)) {
    const s = await fsp.readFile(path.join(dir, f), 'utf8').catch(() => null);
    if (s === text) return f;
  }
  return null;
}

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

/** 结束：结果写到 AURORA_REGRESS_OUT（run.js 汇总），退出进程 */
function finish(code = 0) {
  // 覆盖率：app.exit 不走 Node 的退出流程，要自己写一次
  if (process.env.NODE_V8_COVERAGE) { try { require('v8').takeCoverage(); } catch { /* 没开就算了 */ } }
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  // 有失败就非零退出：单独跑脚本时看退出码也知道没过（run.js 照旧按每一项的结果汇总）
  setTimeout(() => app.exit(code || (results.some((r) => !r.ok) ? 1 : 0)), 100);
}

// 等一件事成立（最多等多久），代替固定的 sleep（cdp.js）
const { waitFor } = require('./cdp');

module.exports = { REPO, BASE, sleep, waitFor, setup, core, ipc, lockFile, fakeVersion, tree, findWithContent, check, finish };
