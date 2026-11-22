'use strict';
/**
 * 存档相关：删除配置前列出会受影响的存档，以及删除前的简单备份。
 * 完整的备份与还原在 backup.js。
 */
const path = require('path');
const fsp = require('fs').promises;
const versions = require('./versions');
const isolation = require('./isolation');
const profiles = require('./profiles');
const paths = require('../engine/paths');
const location = require('../engine/location');
const { exists } = require('../engine/util');
const { copyDir } = require('../engine/fileops');

// 配置自己的存档所在目录：独立模式下在 saves；共享 / 副本模式下暂存在 saves.aurora-own（重名时还有 saves.aurora-own-<时间>）。
// 不看策略只看实际目录：刚切到共享 / 副本、还没启动过时，自己的存档仍在 saves 里
async function ownSaveDirs(gameDir) {
  const savesDir = path.join(gameDir, 'saves');
  const dirs = [];
  if ((await exists(savesDir)) && !(await isolation.isLink(savesDir)) && !(await isolation.isSandboxCopy(savesDir))) dirs.push({ base: savesDir, stashed: false });
  for (const base of await isolation.stashesOf(savesDir)) dirs.push({ base, stashed: true });
  return dirs;
}

/** 删除确认框用：存档列表（按最近游玩排序）、隔离方式、以它为来源的其他配置 */
async function removeInfo(id) {
  const info = await versions.versionInfo(id);
  const dir = versions.versionDir(id);
  const gameDir = info ? versions.gameDirFor(id, info) : dir;
  const own = path.resolve(gameDir) === path.resolve(dir);
  const policy = await isolation.getPolicy(id);
  const out = { dir, isolated: own, savesMode: policy.items.saves, source: policy.source, worlds: [], dependents: [] };
  if (own) {
    for (const { base, stashed } of await ownSaveDirs(gameDir)) {
      for (const n of await fsp.readdir(base).catch(() => [])) {
        if (n.includes('.aurora')) continue;
        const st = await fsp.stat(path.join(base, n, 'level.dat')).catch(() => null);
        if (!st) continue;
        const size = await location.dirSize(path.join(base, n), 1500);
        out.worlds.push({ name: n, lastPlayed: st.mtimeMs, size: size.bytes, partial: size.partial, stashed });
      }
    }
    out.worlds.sort((a, b) => b.lastPlayed - a.lastPlayed);
  }
  // 删除后这些配置会恢复为独立存档
  for (const v of await versions.listInstalled()) {
    if (v.id === id) continue;
    const meta = await profiles.readMeta(v.id);
    if (meta.isolation && meta.isolation.source === id) out.dependents.push(v.id);
  }
  return out;
}

/**
 * 把配置自己的存档复制到 <数据目录>/backups/<配置>/<时间>-saves。
 * 暂存的存档（saves.aurora-own*）放进同名的子文件夹（aurora-own*），避免和同名世界混在一起。
 * 只复制配置自己的存档，共享来的存档属于来源配置，不在这里备份。
 */
async function backupSaves(id) {
  const info = await versions.versionInfo(id);
  if (!info) throw new Error('配置不存在');
  const gameDir = versions.gameDirFor(id, info);
  if (path.resolve(gameDir) !== path.resolve(versions.versionDir(id))) return { path: null, count: 0 };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = path.join(paths.dataDir(), 'backups', id.replace(/[\\/:*?"<>|]/g, '_'), `${stamp}-saves`);
  let count = 0;
  for (const { base, stashed } of await ownSaveDirs(gameDir)) {
    for (const w of await fsp.readdir(base).catch(() => [])) {
      if (w.includes('.aurora')) continue;
      const to = stashed ? path.join(dest, path.basename(base).replace(/^saves\./, ''), w) : path.join(dest, w);
      const from = path.join(base, w);
      const st = await fsp.lstat(from).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) await copyDir(from, to, { force: false });
      else if (!(await exists(to))) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.copyFile(from, to); }
      if (await exists(path.join(base, w, 'level.dat'))) count++;
    }
  }
  return { path: count ? dest : null, count };
}

module.exports = { removeInfo, backupSaves };
