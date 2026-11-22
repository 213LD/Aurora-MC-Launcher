'use strict';
/**
 * 「这个东西是不是正被游戏用着」（1.10.7）：以前有四种写法，有的只比配置 id（查不出共用目录的），一半操作根本不查。
 * 除了这次打开启动器之后开的游戏（launcher.listGames），还认启动器外面开的（2.0.0-pre2）：
 * 设了「启动后关闭启动器」再打开，或者别的启动器开的。查两样：Java 进程命令行里的 --gameDir；存档还要看 session.lock 拿不拿得到。
 * 只在 IPC 这一层拦玩家的操作，不放进 mods.toggleMod 这类底层函数：一键 Debug 内部要用它们。
 */
const fsp = require('fs').promises;
const path = require('path');
const { PS_UTF8 } = require('../engine/procenc');

const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const inside = (p, dir) => { const a = norm(p); const b = norm(dir); return a === b || a.startsWith(b + path.sep); };
async function real(p) { try { return await fsp.realpath(p); } catch { return p; } }

// 隔离策略可能联接到别处的目录（isolation.ITEMS 里能共享的）
const LINKED = ['saves', 'resourcepacks', 'shaderpacks', 'screenshots'];

function known() { return require('./launcher').listGames().filter((g) => g.state !== 'exited'); }

// ───────────────────────── 启动器外面开的游戏 ─────────────────────────
const EXT_TTL_MS = 5000; // 查一次约 0.3 秒，连着开关 Mod 时不用每次都查
let extCache = { at: 0, list: null };

const exec = (cmd, args, timeout) => new Promise((res) => {
  // 用的时候才取 execFile：测试要模拟查询失败
  require('child_process').execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (err, out) => res(err ? null : String(out || '')));
});

function argOf(cmd, name) {
  const m = cmd.match(new RegExp(`(?:^|\\s)--${name}\\s+(?:"([^"]*)"|(\\S+))`));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

/** 从命令行认出游戏。只取目录和版本，命令行里的登录令牌不留、不记 */
function parseGame(proc) {
  const cmd = String(proc.CommandLine || '');
  const gameDir = argOf(cmd, 'gameDir');
  if (!gameDir) return null;
  return { id: `external-${proc.ProcessId}`, external: true, pid: proc.ProcessId, state: 'running', versionId: argOf(cmd, 'version') || '', gameDir, java: proc.ExecutablePath ? { path: proc.ExecutablePath } : null };
}

async function queryExternal() {
  if (process.platform !== 'win32') return [];
  // 先用便宜的办法看有没有 Java 在跑，大多数时候到这里就结束了
  const tl = await exec('tasklist.exe', ['/FI', 'IMAGENAME eq java*', '/FO', 'CSV', '/NH'], 5000);
  if (tl !== null && !/javaw?\.exe/i.test(tl)) return [];
  const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${PS_UTF8}Get-CimInstance Win32_Process -Filter "Name='javaw.exe' or Name='java.exe'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`], 8000);
  if (!out || !out.trim()) return [];
  try {
    const list = JSON.parse(out);
    return (Array.isArray(list) ? list : [list]).map(parseGame).filter(Boolean);
  } catch { return []; }
}

let extPending = null;
async function externalGames() {
  const now = Date.now();
  if (extCache.list && now - extCache.at < EXT_TTL_MS) return extCache.list;
  if (!extPending) {
    extPending = queryExternal().catch(() => []).then((list) => { extCache = { at: Date.now(), list }; extPending = null; return list; });
  }
  return extPending;
}

/** 正在运行的全部游戏：启动器开的，加上外面开的 */
async function running() {
  const mine = known();
  const pids = new Set(mine.map((g) => g.pid));
  return [...mine, ...(await externalGames()).filter((g) => !pids.has(g.pid))];
}

/** 有几个游戏开着（不管是谁开的） */
async function anyRunning() { return (await running()).length; }

/** 文件被别的进程锁着：游戏开着世界时 session.lock 打得开，但读不了（EBUSY） */
async function isLocked(p) {
  let fh = null;
  try {
    fh = await fsp.open(p, 'r');
    await fh.read(Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

const subdirs = async (d) => (await fsp.readdir(d, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(d, e.name));

/** p 自己是世界，或者 p 是存档文件夹、游戏目录：找里面被占着的世界（进程查不到时的后备，也能查出 --gameDir 不一样的游戏）。没有返回 null */
async function lockedWorld(p) {
  const worlds = [p, ...(await subdirs(p)), ...(await subdirs(path.join(p, 'saves')))];
  for (const w of worlds.slice(0, 2000)) {
    if (await isLocked(path.join(w, 'session.lock'))) return w;
  }
  return null;
}

/** 世界开着但不知道是谁开的 */
const lockedGame = (world) => ({ id: 'locked-world', external: true, state: 'running', versionId: '', gameDir: path.dirname(path.dirname(world)), world });

/** 一个运行中的游戏用到的目录：游戏目录，加上联接过去的真实目录 */
async function dirsOf(g) {
  const out = [await real(g.gameDir)];
  for (const n of LINKED) {
    const p = path.join(g.gameDir, n);
    const r = await real(p);
    if (norm(r) !== norm(p)) out.push(r);
  }
  return out;
}

/** p 在 used 这个目录里面。公共目录里的游戏不占用别的配置自己的目录（公共目录下的 versions/<id>/） */
function covers(used, p) {
  if (!inside(p, used)) return false;
  const vs = require('./versions').versionsDir();
  return !(inside(p, vs) && !inside(used, vs));
}

/** 正在用 p（文件或文件夹）的游戏：p 在游戏用的目录里面，或者游戏用的目录在 p 里面。没有返回 null */
async function forPath(p) {
  const target = await real(p);
  for (const g of await running()) {
    for (const d of await dirsOf(g)) if (covers(d, target) || inside(d, target)) return g;
  }
  const world = await lockedWorld(target);
  return world ? lockedGame(world) : null;
}

/** 正在用这个配置的游戏：运行的就是它、运行的配置继承它、或者联接到了它的目录。公共目录里别的配置在跑不算 */
async function forVersion(id) {
  const versions = require('./versions');
  const games = await running();
  // 没有查到游戏也要看目录：世界可能被查不到的进程占着（forPath 里看 session.lock）
  if (!games.length) return forPath(versions.versionDir(id));
  const list = await versions.listInstalled().catch(() => []);
  const uses = (vid) => {
    let v = list.find((x) => x.id === vid);
    for (let i = 0; v && i < 8; i++) {
      if (v.id === id) return true;
      const parent = v.inheritsFrom;
      v = parent ? list.find((x) => x.id === parent) : null;
    }
    return false;
  };
  for (const g of games) if (g.versionId === id || uses(g.versionId)) return g;
  return forPath(versions.versionDir(id));
}

/** 正在用这个 Java 的游戏 */
async function forJava(home) {
  return (await running()).find((g) => g.java && g.java.path && inside(g.java.path, home)) || null;
}

/** action：「删除」「改名」这种动词，拼成给玩家看的话 */
function busyError(g, action) {
  const text = g.world ? `世界「${path.basename(g.world)}」正被一个游戏占着（可能是启动器外面开的），先关掉游戏再${action}`
    : g.external && g.versionId ? `启动器外面开的游戏「${g.versionId}」正在运行，先关掉游戏再${action}`
      : g.external ? `启动器外面开的游戏正在运行，先关掉游戏再${action}`
        : `「${g.versionId}」的游戏正在运行，先关掉游戏再${action}`;
  const e = new Error(text);
  e.reason = { code: 'GAME_RUNNING', message: '游戏正在运行', hint: '关掉游戏后再试' };
  return e;
}

async function assertVersion(id, action) { const g = await forVersion(id); if (g) throw busyError(g, action); }
async function assertPath(p, action) { const g = await forPath(p); if (g) throw busyError(g, action); }
async function assertJava(home, action) { const g = await forJava(home); if (g) throw busyError(g, action); }
async function assertNone(action) { const g = (await running())[0]; if (g) throw busyError(g, action); }

module.exports = { forPath, forVersion, forJava, busyError, assertVersion, assertPath, assertJava, assertNone, norm, externalGames, anyRunning, isLocked, lockedWorld };
