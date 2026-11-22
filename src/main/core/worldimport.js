'use strict';
/**
 * 从其他配置导入存档（1.5.8）：把别的配置（或公共 .minecraft）里的世界复制进这个配置。
 * 只复制、不动原存档；重名的改成「名字 (来自 某配置)」。
 * 这个配置的存档是共享 / 测试副本时不导入（导进去会进别人的存档，或者下次启动被副本覆盖）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const versions = require('./versions');
const gamelock = require('./gamelock');
const { exists } = require('../engine/util');
const { copyDirNew } = require('../engine/fileops');
const { nm } = require('../../shared/i18n');

/** 复制一个世界：跳过 session.lock，每个文件都看一眼取消；取消或失败不留半个世界（1.10.8）。onFile：每处理一项调一次，算进度用 */
function copyWorld(src, dest, signal, onFile) {
  return copyDirNew(src, dest, { signal, onFile: onFile ? () => onFile() : undefined });
}

/** dir 里没被占用的名字：重名的改成「名字 (来自 来源)」 */
async function freeName(dir, name, fromName) {
  if (!(await exists(path.join(dir, name)))) return name;
  let as = `${name} (来自 ${fromName})`;
  for (let k = 2; await exists(path.join(dir, as)); k++) as = `${name} (来自 ${fromName} ${k})`;
  return as;
}

async function savesOf(id) {
  if (!id || id === '@root') return { dir: path.join(versions.gameRoot(), 'saves'), mc: null };
  const info = await versions.versionInfo(id);
  if (!info) throw new Error(`配置 ${nm(id)} 不存在`);
  return { dir: path.join(versions.gameDirFor(id, info), 'saves'), mc: info.mcVersion };
}


/**
 * @param {string[]} worlds 来源里的世界文件夹名
 * @returns {Promise<{ copied: [{ name, as }] }>}
 */
async function importWorlds(id, fromId, worlds, task) {
  if (fromId === id) throw new Error('不能从自己导入');
  const to = await savesOf(id);
  const from = await savesOf(fromId);
  // 按实际的存档目录查：来源是公共目录时，开着的可能是任何一个用公共目录的配置（1.10.7：以前只比配置 id，复制的是正在写入的存档）
  await gamelock.assertPath(to.dir, '导入存档');
  await gamelock.assertPath(from.dir, '导入存档');
  const st = await fsp.lstat(to.dir).catch(() => null);
  if (st && st.isSymbolicLink()) throw new Error('这个配置的存档是和别的配置共享的，导入会放进别人的存档里。先在「存档与隔离」里转为正式配置或改成完全独立');
  if (await exists(path.join(to.dir, '.aurora-sandbox'))) throw new Error('这个配置的存档是测试副本，下次启动会被重新复制覆盖。先在「存档与隔离」里转为正式配置');
  const src = await fsp.realpath(from.dir).catch(() => from.dir);
  await fsp.mkdir(to.dir, { recursive: true });
  const fromName = !fromId || fromId === '@root' ? '公共目录' : fromId;
  const copied = [];
  let i = 0;
  for (const name of worlds || []) {
    i++;
    const s = path.join(src, name);
    if (name.includes('..') || /[\\/]/.test(name) || !(await exists(path.join(s, 'level.dat')))) continue;
    const as = await freeName(to.dir, name, fromName);
    if (task) task.update({ detail: `复制世界：${nm(name)}（${i}/${worlds.length}）`, progress: -1 });
    // 取消或失败时已经导入好的世界不动，正在复制的这个不留
    await copyWorld(s, path.join(to.dir, as), task && task.signal);
    copied.push({ name, as });
  }
  return { copied };
}

module.exports = { importWorlds, copyWorld, freeName };
