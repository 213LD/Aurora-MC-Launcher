'use strict';
/**
 * 一键还原启动器，两档：
 * - 还原设置（默认）：设置回到默认、重新走首次启动；删掉启动器自己的记录和缓存（清单、调试备份、缓存、通知等本地存储）。
 *   可选：同时删除账户、同时删除启动器下载的 Java。游戏、存档、Mod 都不动
 * - 完全清理（单独勾选，界面要输入「删除」）：在上面的基础上，把游戏目录里的游戏配置、存档、Mod、资源等移到回收站，
 *   连同启动器删除配置前做的存档备份。回收站不可用时停下来，不会直接永久删除
 * 做完重启启动器
 */
const fsp = require('fs/promises');
const path = require('path');
const { session } = require('electron');
const config = require('../engine/config');
const paths = require('../engine/paths');
const gamelock = require('./gamelock');
const { exists, safeTrash, rmrf } = require('../engine/util');

// 完全清理时移到回收站的东西（游戏目录下）。只列 Minecraft 自己的文件夹，不整个删游戏目录，免得误删玩家放在里面的别的东西
const GAME_ITEMS = [
  ['versions', '全部游戏配置（含各配置独立的存档、Mod、设置）'],
  ['saves', '共享存档'],
  ['mods', '共享 Mod'], ['resourcepacks', '资源包'], ['shaderpacks', '光影包'], ['config', 'Mod 配置'],
  ['screenshots', '游戏截图'], ['libraries', '依赖库'], ['assets', '游戏资源'],
  ['logs', '游戏日志'], ['crash-reports', '崩溃报告'],
  ['options.txt', '游戏设置'], ['servers.dat', '服务器列表'], ['launcher_profiles.json', '启动器配置文件'],
];

async function countDir(p) { try { return (await fsp.readdir(p)).length; } catch { return 0; } }

/** 预览：每一档会删掉什么（界面列出来让玩家确认） */
async function preview() {
  const data = paths.dataDir();
  const gameDir = config.get().gameDir;
  const game = [];
  for (const [name, label] of GAME_ITEMS) {
    const p = path.join(gameDir, name);
    if (!(await exists(p))) continue;
    const n = name.includes('.') ? 0 : await countDir(p);
    game.push({ name, label, path: p, count: n });
  }
  const backups = path.join(data, 'backups');
  if (await exists(backups)) game.push({ name: 'backups', label: '启动器里的存档和设置备份', path: backups, count: await countDir(backups) });
  return {
    dataDir: data,
    gameDir,
    accounts: await exists(path.join(data, 'accounts.json')),
    java: await countDir(paths.runtimeDir()),
    game,
    running: await gamelock.anyRunning(),
  };
}

/**
 * @param {{ full?: boolean, accounts?: boolean, java?: boolean }} opts
 * @returns {{ trashed: string[], failed: {path, error}[] }} 完全清理时哪些进了回收站、哪些没成功
 */
async function run(opts = {}) {
  if (await gamelock.anyRunning()) throw new Error('有游戏正在运行，先关掉游戏再还原');
  const data = paths.dataDir();
  const trashed = [];
  const failed = [];

  // 完全清理：先挪游戏文件，失败的列出来，不永久删除
  if (opts.full) {
    const p = await preview();
    for (const it of p.game) {
      try { await safeTrash(it.path); trashed.push(it.path); } catch (e) { failed.push({ path: it.path, error: e.message }); }
    }
  }

  // 启动器自己的文件
  const own = ['plans.json', 'plans.json.bak', 'config.debug-backup.json', 'config.json.bak', 'config.b4.bak'];
  if (opts.accounts) own.push('accounts.json', 'accounts.json.bak');
  for (const f of own) await fsp.rm(path.join(data, f), { force: true }).catch(() => {});
  // 账户一起清掉时，各账户的皮肤缓存（skins/<账户>）也没人用了；皮肤中心自己的库（skins/library）留着
  if (opts.accounts) {
    const sk = path.join(data, 'skins');
    for (const n of await fsp.readdir(sk).catch(() => [])) if (n !== 'library') await rmrf(path.join(sk, n)).catch(() => {}); // pitfall-ok：启动器自己的皮肤缓存，删不掉下次会重新下载
  }
  // 只删启动器自己放进 cache 的东西：Windows 不分大小写，cache 和 Chromium 正在用的 Cache 是同一个文件夹，整个删会卡住
  for (const f of ['modpacks', 'installers', 'java', 'patch_notes.json']) await rmrf(path.join(paths.cacheDir(), f)).catch(() => {});
  if (opts.java) await rmrf(paths.runtimeDir()).catch(() => {});
  await rmrf(path.join(data, 'logs')).catch(() => {}); // 日志中心存的游戏日志（rc4）
  await config.factoryReset();
  // 网页缓存（本地存储由界面自己清：页面开着时 clearStorageData 可能一直不返回）；最多等 3 秒，清不掉也不影响还原
  await Promise.race([session.defaultSession.clearCache().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  return { trashed, failed };
}

module.exports = { preview, run, GAME_ITEMS };
