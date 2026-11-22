'use strict';
/**
 * 存档 / 配置隔离策略
 *
 * 在“每个配置有独立游戏目录”的基础上，可以按文件夹决定：
 *   own   独立：使用该配置自己的文件
 *   link  共享：通过目录联接（Windows junction）直接使用来源目录，读写同一份文件
 *   copy  副本：启动前把来源复制一份（测试模式），游戏只修改副本，原文件不受影响
 *
 * 切换模式时原有的内容不会被删除：会先移到 <名称>.aurora-own，切回“独立”时再恢复。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const BRAND = require('../../shared/brand');
const config = require('../engine/config');
const versions = require('./versions');
const profiles = require('./profiles');
const { exists, rmrf, renameRetry } = require('../engine/util');
const fileops = require('../engine/fileops');
const { nm, msg } = require('../../shared/i18n');

const { stash, stashesOf } = fileops;

const ITEMS = {
  saves: { label: '存档', type: 'dir', modes: ['own', 'link', 'copy'] },
  config: { label: '配置文件', type: 'dir', modes: ['own', 'copy'] },
  resourcepacks: { label: '资源包', type: 'dir', modes: ['own', 'link'] },
  shaderpacks: { label: '光影包', type: 'dir', modes: ['own', 'link'] },
  options: { label: '游戏选项与按键', type: 'file', file: 'options.txt', modes: ['own', 'copy'] },
  screenshots: { label: '截图', type: 'dir', modes: ['own', 'link'] },
};

const PRESETS = {
  isolated: { saves: 'own', config: 'own', resourcepacks: 'own', shaderpacks: 'own', options: 'own', screenshots: 'own' },
  shared: { saves: 'link', config: 'own', resourcepacks: 'link', shaderpacks: 'link', options: 'copy', screenshots: 'link' },
  sandbox: { saves: 'copy', config: 'copy', resourcepacks: 'link', shaderpacks: 'link', options: 'copy', screenshots: 'own' },
};

const MARK = '.aurora-sandbox';
// 副本正在复制（标记文件在复制之前就写好，复制完才去掉这个）：refresh once 不沿用没复制完的
const COPYING = '.aurora-sandbox-copying';
const MODE_LABEL = { own: '独立', link: '共享', copy: '副本' };

// ───────────────────────── 文件系统辅助 ─────────────────────────
async function lstat(p) { try { return await fsp.lstat(p); } catch { return null; } }
async function isLink(p) { const s = await lstat(p); return !!(s && s.isSymbolicLink()); }
const norm = (p) => path.resolve(String(p).replace(/^\\\\\?\\/, '')).toLowerCase();

async function linkTarget(p) {
  try { return await fsp.readlink(p); } catch { return null; }
}

async function removeLink(p) {
  // 删除的是联接本身，不会碰到目标目录中的内容
  try { await fsp.rmdir(p); } catch { await fsp.unlink(p); }
}

async function makeLink(target, p) {
  await fsp.mkdir(target, { recursive: true });
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.symlink(target, p, process.platform === 'win32' ? 'junction' : 'dir');
}

async function isEmptyDir(p) {
  try { return (await fsp.readdir(p)).length === 0; } catch { return true; }
}

/** 切回「独立」：放回暂存的内容。存档同名时改名留着，其他文件夹同名的不覆盖 */
const unstash = (p, kind) => fileops.unstash(p, { renameDup: kind === 'saves' });

/**
 * 换掉旧副本：留成 *.aurora-sandbox-last，玩家在副本里的进度至少还能找回一次。
 * 改不了名（里面有文件正被占着，一般是游戏还开着）就报错停下，绝不退回直接删除（1.10.7：实测会连 -last 都不留）
 */
async function discardSandbox(p) {
  const last = `${p}.aurora-sandbox-last`;
  await rmrf(last).catch(() => {});
  try { await renameRetry(p, last); } catch (e) {
    throw new Error(`测试副本「${nm(path.basename(p))}」里有文件正被占着（可能是游戏还开着），没法换成新的副本。关掉游戏或占用它的程序后再试`);
  }
}

// ───────────────────────── 策略 ─────────────────────────
function normalize(policy) {
  const p = policy && typeof policy === 'object' ? policy : {};
  const preset = PRESETS[p.preset] || p.preset === 'custom' ? p.preset : 'isolated';
  const items = { ...PRESETS.isolated, ...(PRESETS[preset] || {}), ...(preset === 'custom' ? p.items || {} : {}) };
  for (const [k, v] of Object.entries(items)) if (!ITEMS[k] || !ITEMS[k].modes.includes(v)) items[k] = 'own';
  return {
    preset,
    source: p.source || '@root',
    items,
    worlds: Array.isArray(p.worlds) && p.worlds.length ? p.worlds : null,
    refresh: p.refresh === 'once' ? 'once' : 'always',
  };
}

async function sourceDir(source, selfId) {
  if (!source || source === '@root') return versions.gameRoot();
  if (source === selfId) return null;
  const info = await versions.versionInfo(source);
  if (!info) return null;
  return versions.gameDirFor(source, info);
}

async function getPolicy(id) {
  const meta = await profiles.readMeta(id);
  return normalize(meta.isolation);
}

const isDefault = (p) => Object.values(p.items).every((m) => m === 'own');

// ───────────────────────── 应用 ─────────────────────────
/** 复制 src 下面的一项（文件或文件夹）。session.lock 和联接不带（fileops.copyDir） */
async function copyEntry(s, d, signal) {
  const st = await fsp.lstat(s);
  if (st.isSymbolicLink() || fileops.isLockFile(path.basename(s))) return;
  if (st.isDirectory()) await fileops.copyDir(s, d, { signal });
  else await fsp.copyFile(s, d);
}

async function copyDir(src, dst, { worlds, task, label } = {}) {
  const real = await fsp.realpath(src).catch(() => null);
  await fsp.mkdir(dst, { recursive: true });
  if (!real) return 0;
  let names = await fsp.readdir(real).catch(() => []);
  if (worlds) names = names.filter((n) => worlds.includes(n));
  let i = 0;
  const signal = task && task.signal;
  for (const n of names) {
    if (n.startsWith('.aurora') || n.includes('.aurora-')) continue;
    i++;
    if (task) task.update({ detail: `${label}：${n}（${i}/${names.length}）`, progress: -1 });
    // 每个文件都看一眼取消（1.10.8）：大存档复制要很久。没复制完的留着 COPYING 标记，下次启动会重新复制
    await copyEntry(path.join(real, n), path.join(dst, n), signal);
  }
  return i;
}

async function applyDir(kind, mode, src, dst, opts) {
  const linked = await isLink(dst);
  const st = linked ? null : await lstat(dst);
  const marked = st && st.isDirectory() && (await exists(path.join(dst, MARK)));

  if (mode === 'own') {
    if (linked) await removeLink(dst);
    else if (marked) await discardSandbox(dst);
    await unstash(dst, kind);
    return null;
  }

  const srcPath = path.join(src, kind);
  if (norm(srcPath) === norm(dst)) throw new Error(`${ITEMS[kind].label}的来源不能是它自己`);

  if (mode === 'link') {
    let stashed = false;
    let emptied = false;
    if (linked) {
      const t = await linkTarget(dst);
      if (t && norm(t) === norm(await fsp.realpath(srcPath).catch(() => srcPath))) return `${ITEMS[kind].label}：共享`;
      await removeLink(dst);
    } else if (st) {
      if (marked) await discardSandbox(dst);
      else if (await isEmptyDir(dst)) { await fsp.rmdir(dst); emptied = true; } else { await stash(dst); stashed = true; }
    }
    try {
      await makeLink(await fsp.realpath(srcPath).catch(() => srcPath), dst);
    } catch (e) {
      // 网络盘、exFAT / FAT32 的 U 盘建不了文件夹联接（2026-11-07 在群晖上实测：EISDIR）。
      // 以前这里直接报错，刚挪进暂存的存档没放回来，进游戏像是世界没了：先放回原处再报错
      if (stashed) await unstash(dst, kind).catch(() => {});
      else if (emptied) await fsp.mkdir(dst, { recursive: true }).catch(() => {});
      const err = new Error(msg('{what}没法设成「共享」：游戏文件夹所在的盘不支持文件夹联接（网络盘、exFAT / FAT32 格式的 U 盘常见这样）。可以改用「独立」或「副本」', { what: ITEMS[kind].label }));
      err.reason = { code: 'LINK_UNSUPPORTED', message: e.code || e.message };
      throw err;
    }
    return `${ITEMS[kind].label}：共享`;
  }

  // copy
  if (!opts.allowCopy) return null;
  if (linked) await removeLink(dst);
  else if (st) {
    if (marked) {
      if (opts.refresh === 'once' && !(await exists(path.join(dst, COPYING)))) return `${ITEMS[kind].label}：沿用已有副本`;
      // 上一份副本留成 *.aurora-sandbox-last，玩家在副本里的进度至少还能找回一次
      await discardSandbox(dst);
    } else if (await isEmptyDir(dst)) await fsp.rmdir(dst);
    else await stash(dst);
  }
  // 先写标记再复制：复制到一半失败时，下次也认得出这是副本，不会当成玩家自己的存档暂存起来（1.10.7）
  await fsp.mkdir(dst, { recursive: true });
  await fsp.writeFile(path.join(dst, MARK), `由 ${BRAND.short} 创建的测试副本，来源：${srcPath}\n此目录会在下次启动时被重新复制，请不要在这里保存重要内容。\n`, 'utf8');
  await fsp.writeFile(path.join(dst, COPYING), '', 'utf8');
  const n = await copyDir(srcPath, dst, { worlds: kind === 'saves' ? opts.worlds : null, task: opts.task, label: `复制${ITEMS[kind].label}副本` });
  await fsp.rm(path.join(dst, COPYING), { force: true });
  return `${ITEMS[kind].label}：副本（${n} 项）`;
}

async function applyFile(item, mode, src, dst, opts) {
  const stashPath = `${dst}.aurora-own`;
  if (mode === 'own') {
    if (await exists(stashPath)) { await fsp.rm(dst, { force: true }); await renameRetry(stashPath, dst); }
    return null;
  }
  if (!opts.allowCopy) return null;
  const srcPath = path.join(src, item.file);
  if (norm(srcPath) === norm(dst)) return null;
  if (!(await exists(srcPath))) return null;
  if ((await exists(dst)) && !(await exists(stashPath))) await fsp.copyFile(dst, stashPath);
  // options.txt 按两边的版本翻译（1.5.6）；翻译失败退回整份复制
  if (item.file === 'options.txt' && opts.versions) {
    const ok = await require('./gamesettings').translateCopy(srcPath, dst, opts.versions.src, opts.versions.dst).catch(() => false);
    if (ok) return `${item.label}：同步自来源（按版本转换）`;
  }
  await fsp.copyFile(srcPath, dst);
  return `${item.label}：同步自来源`;
}

/**
 * 启动前应用隔离策略
 * @param {{allowCopy?: boolean, task?: object, inUse?: boolean}} opts allowCopy=false 时只处理共享 / 独立，不复制副本；
 *   inUse：这个配置已经有游戏开着（再启动一个实例）：什么都不动，新实例沿用现在的目录（1.10.7）
 */
async function prepare(id, gameDir, opts = {}) {
  const meta = await profiles.readMeta(id);
  if (!meta.isolation) return [];
  if (opts.inUse) return ['这个配置已有实例在运行，沿用现在的存档和配置目录'];
  const policy = normalize(meta.isolation);
  if (norm(gameDir) === norm(versions.gameRoot())) return [];
  const src = await sourceDir(policy.source, id);
  const needSource = !isDefault(policy);
  if (needSource && !src) throw new Error('隔离策略的来源配置不存在，请在「存档与隔离」中重新选择');
  const out = [];
  // 游戏选项副本按版本转换要知道两边的 MC 版本和加载器
  const vinfo = async (vid) => { const i = vid && vid !== '@root' ? await versions.versionInfo(vid) : null; return { mc: i ? i.mcVersion : null, loader: i && i.loader ? i.loader.type : null }; };
  const vers = policy.items.options === 'copy' ? { src: await vinfo(policy.source), dst: await vinfo(id) } : null;
  for (const [kind, item] of Object.entries(ITEMS)) {
    const mode = policy.items[kind];
    const dst = path.join(gameDir, item.type === 'file' ? item.file : kind);
    const ctx = { allowCopy: opts.allowCopy !== false, task: opts.task, worlds: policy.worlds, refresh: policy.refresh, versions: vers };
    const r = item.type === 'file' ? await applyFile(item, mode, src, dst, ctx) : await applyDir(kind, mode, src, dst, ctx);
    if (r) out.push(r);
  }
  return out;
}

/** 删除 / 复制配置前，先断开所有联接，避免误操作到共享的目标 */
async function detachAll(gameDir) {
  for (const [kind, item] of Object.entries(ITEMS)) {
    if (item.type !== 'dir') continue;
    const p = path.join(gameDir, kind);
    if (await isLink(p)) await removeLink(p);
  }
}

async function setPolicy(id, policy) {
  const p = normalize(policy);
  const info = await versions.versionInfo(id);
  if (!info) throw new Error('配置不存在');
  if (!isDefault(p)) {
    if (p.source === id) throw new Error('不能把自己作为来源');
    if (!(await sourceDir(p.source, id))) throw new Error('来源配置不存在');
  }
  // 隔离策略要求该配置拥有独立的游戏目录。选「独立」也一样：以前只有共享、副本才设，
  // 纯原版配置或全局不隔离时选了独立，提示已保存，实际还在公共目录（1.10.8）
  config.setVersionSettings(id, { isolation: 'on' });
  const before = (await profiles.readMeta(id)).isolation || null;
  await profiles.writeMeta(id, { isolation: p });
  const gameDir = versions.gameDirFor(id, info);
  let applied;
  try {
    applied = await prepare(id, gameDir, { allowCopy: false });
  } catch (e) {
    // 这个盘建不了联接：设置退回原来的，前面已经换过的几项也按原来的放回去，玩家看到的还是改之前的样子
    if (e.reason && e.reason.code === 'LINK_UNSUPPORTED') {
      await profiles.writeMeta(id, { isolation: before });
      await prepare(id, gameDir, { allowCopy: false }).catch(() => {});
    }
    throw e;
  }
  return { policy: p, applied };
}

const listWorlds = (dir) => profiles.listWorlds(dir);

async function worldsOf(source, selfId) {
  const dir = await sourceDir(source, selfId);
  return dir ? listWorlds(dir) : [];
}

/** 当某个配置被重命名时，修正以它为来源的其他配置 */
async function renameSource(oldId, newId) {
  for (const v of await versions.listInstalled()) {
    const meta = await profiles.readMeta(v.id);
    if (meta.isolation && meta.isolation.source === oldId) {
      await profiles.updateMeta(v.id, (m) => ({ isolation: { ...m.isolation, source: newId } }));
    }
  }
}

/** 某个配置被删除时，把以它为来源的配置恢复为独立 */
async function dropSource(id) {
  for (const v of await versions.listInstalled()) {
    if (v.id === id) continue;
    const meta = await profiles.readMeta(v.id);
    if (meta.isolation && meta.isolation.source === id && !isDefault(normalize(meta.isolation))) {
      await profiles.writeMeta(v.id, { isolation: { preset: 'isolated' } });
      await prepare(v.id, versions.gameDirFor(v.id, v), { allowCopy: false }).catch(() => {});
    }
  }
}

/** 用于界面展示的简要说明 */
function summary(policy) {
  const p = normalize(policy);
  return { preset: p.preset, source: p.source, items: p.items, worlds: p.worlds, refresh: p.refresh, modes: MODE_LABEL };
}

/** 目录是不是启动器复制出来的测试副本（里面有标记文件） */
const isSandboxCopy = (dir) => exists(path.join(dir, MARK));

module.exports = { ITEMS, PRESETS, normalize, getPolicy, setPolicy, prepare, detachAll, listWorlds, worldsOf, renameSource, dropSource, summary, isLink, isSandboxCopy, stashesOf };
