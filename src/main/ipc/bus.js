'use strict';
/** IPC 的公共部分：发消息给界面、注册接口、统一的错误包装 */
const path = require('path');
const fsp = require('fs').promises;
const { ipcMain } = require('electron');

const config = require('../engine/config');
const tasks = require('../engine/tasks');
const versions = require('../core/versions');
const gamelock = require('../core/gamelock');
const { describe: describeError, friendly } = require('../engine/errors');
const { exists, rmrf } = require('../engine/util');
const { isAppPage } = require('../engine/apppage');
const { under } = require('../engine/fileops');

let currentWin = () => null;
function setWin(fn) { currentWin = fn; }
const getWin = () => currentWin();

function send(channel, payload) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** 认得出是哪一类错误（断网、文件被占用……）就带上原因和建议 */
function knownReason(err) {
  const r = describeError(err);
  return r.code && r.code !== 'UNKNOWN' && r.hint ? r : null;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    // 只回答启动器自己的页面（2.0.0-pre8）
    if (e.senderFrame && !isAppPage(e.senderFrame.url)) return { ok: false, error: '未知调用' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (!(err && err.cancelled)) console.error(`[ipc:${channel}]`, err); // 抛出来的不一定是对象
      return { ok: false, error: friendly(err), cancelled: !!(err && err.cancelled), reason: (err && err.reason) || knownReason(err) };
    }
  });
}

/** 后台任务（core/tasks.js start）：立即返回任务 id */
const startTask = (title, opts, fn, after) => tasks.start({ title, ...opts }, fn, after);

/**
 * 安装配置前记下现在的样子；失败时清掉这次写下的东西（1.10.8）：
 * 以前版本 JSON 留着，配置出现在列表里但选的存档方式、额外 Mod 都没生效，点「重试」又一直报「已存在」。
 * 库和资源放在公共目录，不会白下。原来就有这个配置（多半是报「已存在」）一个字都不动；
 * 文件夹在、JSON 不在（只剩存档的旧配置）时只清自己写的 JSON 和 jar
 */
async function installGuard(name) {
  const dir = versions.versionDir(name);
  const hadDir = await exists(dir);
  const hadJson = await exists(versions.versionJsonPath(name));
  return async () => {
    if (hadJson) return;
    if (!hadDir) {
      await rmrf(dir).catch(() => {});
      config.setVersionSettings(name, null);
    } else {
      for (const f of [`${name}.json`, `${name}.jar`]) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
    }
  };
}

/**
 * 界面传来的路径只能在游戏目录里（2.0.0-pre8，全面测试）。开关和删除 Mod 这些接口以前什么路径都收，
 * 界面一旦被恶意内容钻了空子，就能改名或删除电脑上任意文件。配置的独立目录也都在游戏目录里
 */
function assertInGame(p) {
  const root = versions.gameRoot();
  if (typeof p !== 'string' || !path.isAbsolute(p) || !root || path.resolve(p) === path.resolve(root)) throw new Error('无效的路径');
  if (under(p, root)) return p;
  // 引用别的启动器文件夹的配置（core/foreign.js），它们的 Mod 在那个文件夹里
  const custom = Object.values(config.get().versionSettings || {}).map((v) => v && v.customGameDir).filter(Boolean);
  if (!custom.some((d) => path.resolve(p) !== path.resolve(d) && under(p, d))) throw new Error('无效的路径');
  return p;
}

/** 这个配置的游戏开着、或者它用的 mods 文件夹正被别的配置的游戏用着（都在公共目录时）：不改 Mod */
async function assertModsFree(id, action) {
  await gamelock.assertVersion(id, action);
  const info = await versions.versionInfo(id).catch(() => null);
  if (info) await gamelock.assertPath(path.join(versions.gameDirFor(id, info), 'mods'), action);
}

/** CurseForge 里作者关闭了第三方下载的文件：告诉界面，让玩家手动下载 */
function manualNote(id, manual) {
  if (!manual || !manual.length) return;
  send('curseforge:manual', { versionId: id, items: manual });
}

module.exports = { setWin, getWin, send, handle, startTask, installGuard, assertModsFree, assertInGame, manualNote };
