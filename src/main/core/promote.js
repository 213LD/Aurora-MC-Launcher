'use strict';
/**
 * 测试副本 / 共享 →「转为正式配置」（1.5.8）
 *
 * 场景：用测试副本试玩新版本满意了，想主玩它。直接把隔离改成「完全独立」会回到切换前自己的内容
 * （存档没了、Mod 配置回到初始、光影包文件夹是空的、原版辅助功能页和 Mod 欢迎页又弹出来）。
 * 这里把正在用的内容留成这个配置自己的：
 *   副本（存档、配置文件、游戏选项）→ 去掉测试副本标记，就地留下；存档也可以从来源重新复制一份最新的
 *   共享（资源包、光影包、截图、共享存档）→ 断开联接，从来源复制一份
 * 切到测试副本之前自己的内容（*.aurora-own）不删：不重名的并进来，剩下的改名成 *.aurora-before-promote 留着
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const versions = require('./versions');
const isolation = require('./isolation');
const gamelock = require('./gamelock');
const { exists, rmrf, throwIfAborted, renameRetry } = require('../engine/util');
const fileops = require('../engine/fileops');

const MARK = '.aurora-sandbox';

async function lstat(p) { try { return await fsp.lstat(p); } catch { return null; } }
async function removeLink(p) { try { await fsp.rmdir(p); } catch { await fsp.unlink(p); } }

async function uniq(p) {
  if (!(await exists(p))) return p;
  for (let i = 2; ; i++) if (!(await exists(`${p}-${i}`))) return `${p}-${i}`;
}

/** 把来源目录的内容复制进 dst（跳过启动器自己的文件和 session.lock） */
async function copyInto(src, dst, { worlds, task, label } = {}) {
  await fsp.mkdir(dst, { recursive: true });
  let names = await fsp.readdir(src).catch(() => []);
  names = names.filter((n) => !n.startsWith('.aurora') && !n.includes('.aurora-') && (!worlds || worlds.includes(n)));
  let i = 0;
  const signal = task && task.signal;
  for (const n of names) {
    i++;
    if (task) task.update({ detail: `${label}：${n}（${i}/${names.length}）`, progress: -1 });
    const s = path.join(src, n);
    const st = await lstat(s);
    if (!st || st.isSymbolicLink() || fileops.isLockFile(n)) continue;
    if (st.isDirectory()) await fileops.copyDir(s, path.join(dst, n), { signal });
    else await fsp.copyFile(s, path.join(dst, n));
  }
  return i;
}

/** 切到测试副本之前自己的内容（可能有好几份暂存）：不重名的并进来，剩下的改名留着。返回留下的路径 */
async function mergeStash(dst, isFile) {
  const kept = [];
  if (isFile) {
    const stash = `${dst}.aurora-own`;
    if (!(await exists(stash))) return kept;
    if (!(await exists(dst))) { await renameRetry(stash, dst); return kept; }
    const keep = await uniq(`${dst}.aurora-before-promote`);
    await renameRetry(stash, keep);
    kept.push(keep);
    return kept;
  }
  for (const stash of await isolation.stashesOf(dst)) {
    for (const n of await fsp.readdir(stash).catch(() => [])) {
      if (!(await exists(path.join(dst, n)))) await renameRetry(path.join(stash, n), path.join(dst, n));
    }
    if (!(await fsp.readdir(stash).catch(() => [])).length) { await fsp.rmdir(stash).catch(() => {}); continue; }
    const keep = await uniq(`${dst}.aurora-before-promote`);
    await renameRetry(stash, keep);
    kept.push(keep);
  }
  return kept;
}

async function newestWorld(savesDir) {
  let t = 0;
  for (const n of await fsp.readdir(savesDir).catch(() => [])) {
    const st = await fsp.stat(path.join(savesDir, n, 'level.dat')).catch(() => null);
    if (st) t = Math.max(t, st.mtimeMs);
  }
  return t;
}

async function context(id) {
  const info = await versions.versionInfo(id);
  if (!info) throw new Error('配置不存在');
  const policy = await isolation.getPolicy(id);
  const gameDir = versions.gameDirFor(id, info);
  const src = !policy.source || policy.source === '@root' ? versions.gameRoot()
    : await versions.versionInfo(policy.source).then((i) => (i ? versions.gameDirFor(policy.source, i) : null)).catch(() => null);
  return { info, policy, gameDir, src };
}

/** 转正前给界面看：每一项会怎么处理 */
async function info(id) {
  const { policy, gameDir, src } = await context(id);
  const items = [];
  for (const [kind, item] of Object.entries(isolation.ITEMS)) {
    const mode = policy.items[kind];
    if (mode === 'own') continue;
    const dst = path.join(gameDir, item.type === 'file' ? item.file : kind);
    items.push({ kind, label: item.label, mode, made: await exists(dst), stash: await exists(`${dst}.aurora-own`) });
  }
  const savesDst = path.join(gameDir, 'saves');
  const copyWorlds = policy.items.saves === 'copy' ? (await isolation.listWorlds(gameDir)).map((w) => w.name) : [];
  const markSt = await fsp.stat(path.join(savesDst, MARK)).catch(() => null);
  const srcNewest = src && policy.items.saves === 'copy' ? await newestWorld(path.join(src, 'saves')) : 0;
  return {
    preset: policy.preset, source: policy.source, sourceMissing: !src, items, copyWorlds,
    // 复制之后来源里的存档又玩过：留下副本就拿不到来源后来的进度
    sourceNewer: !!(markSt && srcNewest > markSt.mtimeMs + 60000),
    copiedAt: markSt ? markSt.mtimeMs : 0,
  };
}

/**
 * 转为正式配置
 * @param {{ saves?: 'keep'|'fresh' }} opts keep：留下测试副本里的存档（含测试时的进度）；fresh：从来源重新复制一份
 */
async function promote(id, opts = {}, task) {
  await gamelock.assertVersion(id, '转为正式配置');
  const { policy, gameDir, src } = await context(id);
  if (Object.values(policy.items).every((m) => m === 'own')) return { lines: ['已经是完全独立的配置'], kept: [] };
  if (!src) throw new Error('隔离策略的来源配置不存在了，没法从来源复制');
  // 要从来源复制存档时，来源的世界不能开着（比如公共目录里另一个配置正在玩）
  if (policy.items.saves !== 'own') await gamelock.assertPath(path.join(src, 'saves'), '转为正式配置');
  const lines = [];
  const kept = [];
  // 分两步：先把要复制的都复制到临时文件夹（这一步可以取消，取消了原来的东西一点没动），
  // 全部复制完再一次换过去（都是改名，很快）（1.10.8：以前边断联接边复制，取消不了，中途失败就停在一半）
  const swaps = [];
  const temps = [];
  const copyToTemp = async (from, dst, o) => {
    const tmp = `${dst}.aurora-promote-tmp`;
    await rmrf(tmp);
    temps.push(tmp);
    const n = await copyInto(from, tmp, { ...o, task });
    return { tmp, n };
  };
  try {
    for (const [kind, item] of Object.entries(isolation.ITEMS)) {
      const mode = policy.items[kind];
      if (mode === 'own') continue;
      const dst = path.join(gameDir, item.type === 'file' ? item.file : kind);
      const from = path.join(src, item.type === 'file' ? item.file : kind);
      if (item.type === 'file') {
        // 游戏选项：现在用的这份（启动前按版本转换过）就是要留下的；还没启动过就从来源复制一份
        swaps.push(async () => {
          if (!(await exists(dst)) && (await exists(from))) {
            const ok = await require('./gamesettings').translateCopy(from, dst, await vinfo(policy.source), await vinfo(id)).catch(() => false);
            if (!ok) await fsp.copyFile(from, dst);
          }
        });
        lines.push(`${item.label}：留下现在用的`);
      } else {
        const st = await lstat(dst);
        if (st && st.isSymbolicLink()) {
          const target = await fsp.realpath(dst).catch(() => from);
          const { tmp, n } = await copyToTemp(target, dst, { label: `复制${item.label}` });
          swaps.push(async () => { await removeLink(dst); await renameRetry(tmp, dst); });
          lines.push(`${item.label}：从来源复制了一份（${n} 项）`);
        } else if (mode === 'copy' && kind === 'saves' && opts.saves === 'fresh') {
          const { tmp, n } = await copyToTemp(from, dst, { worlds: policy.worlds, label: `复制${item.label}` });
          swaps.push(async () => {
            if (st) { const last = await uniq(`${dst}.aurora-sandbox-last`); await renameRetry(dst, last); kept.push(last); }
            await renameRetry(tmp, dst);
          });
          lines.push(`${item.label}：从来源重新复制了 ${n} 个`);
        } else if (!st) {
          const { tmp, n } = await copyToTemp(from, dst, { worlds: kind === 'saves' ? policy.worlds : null, label: `复制${item.label}` });
          swaps.push(() => renameRetry(tmp, dst));
          lines.push(`${item.label}：从来源复制了一份（${n} 项）`);
        } else {
          lines.push(`${item.label}：留下测试副本里的`);
        }
        swaps.push(() => fsp.rm(path.join(dst, MARK), { force: true }));
      }
      swaps.push(async () => { kept.push(...await mergeStash(dst, item.type === 'file')); });
    }
    throwIfAborted(task && task.signal);
  } catch (e) {
    for (const t of temps) await rmrf(t).catch(() => {});
    throw e;
  }
  for (const s of swaps) await s();
  await isolation.setPolicy(id, { preset: 'isolated' });
  return { lines, kept };
}

async function vinfo(vid) {
  const i = vid && vid !== '@root' ? await versions.versionInfo(vid).catch(() => null) : null;
  return { mc: i ? i.mcVersion : null, loader: i && i.loader ? i.loader.type : null };
}

module.exports = { info, promote };
