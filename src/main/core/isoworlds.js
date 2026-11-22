'use strict';
/**
 * 配置从公共目录搬到自己的文件夹时，把公共目录的世界和其他内容带过去。两个入口：
 *   单个配置的「存档与隔离」（1.10.9）、全局设置「独立游戏目录」（1.10.10）
 * 分两步，所以取消或失败时什么都没变：
 *   1. 先复制到配置目录下的临时文件夹，隔离状态不动，原来的内容也不动
 *   2. 全部复制好才切换，再把内容改名放进去（同一个磁盘，很快）
 * 第 2 步切换失败会退回去；切换成功后个别内容没放进去的，放在返回值的 failed 里告诉玩家
 */
const fsp = require('fs').promises;
const path = require('path');
const backup = require('./backup');
const config = require('../engine/config');
const gamelock = require('./gamelock');
const isolation = require('./isolation');
const profiles = require('./profiles');
const versions = require('./versions');
const gamesettings = require('./gamesettings');
const { copyWorld, freeName } = require('./worldimport');
const { freeSpace, fmtBytes } = require('../engine/downloader');
const { withReason } = require('../engine/errors');
const { exists, rmrf, renameRetry, throwIfAborted } = require('../engine/util');

const TMP = 'saves.aurora-bring-tmp';
// 和下载前检查空间留的余量一样
const MARGIN = 64 * 1024 * 1024;
const COPYING = { mods: '复制 Mod 和配置文件', resourcepacks: '复制资源包', shaderpacks: '复制光影' };

const rootSaves = () => path.join(versions.gameRoot(), 'saves');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);

async function rootWorlds() {
  const worlds = [];
  for (const w of await isolation.listWorlds(versions.gameRoot())) {
    const s = await backup.dirSize(path.join(rootSaves(), w.name));
    worlds.push({ name: w.name, size: s.bytes, files: s.files });
  }
  return worlds;
}

/** 公共目录里真有的内容。只有空文件夹、光影的设置文件（xxx.zip.txt）这些不算 */
async function rootContent() {
  const root = versions.gameRoot();
  const names = (d) => fsp.readdir(path.join(root, d)).catch(() => []);
  const out = {};
  const jars = (await names('mods')).filter((n) => /\.jar(\.disabled)?$/i.test(n));
  if (jars.length) {
    const m = await backup.dirSize(path.join(root, 'mods'));
    const c = await backup.dirSize(path.join(root, 'config'));
    out.mods = { count: jars.length, size: m.bytes + c.bytes, files: m.files + c.files };
  }
  for (const [key, isContent] of [['resourcepacks', (n) => !n.startsWith('.')], ['shaderpacks', (n) => !/\.txt$/i.test(n)]]) {
    const found = (await names(key)).filter(isContent);
    if (found.length) {
      const s = await backup.dirSize(path.join(root, key));
      out[key] = { count: found.length, size: s.bytes, files: s.files };
    }
  }
  const opt = await fsp.stat(path.join(root, 'options.txt')).catch(() => null);
  if (opt && opt.size > 0) out.options = { count: 1, size: opt.size, files: 1 };
  return out;
}

/** 这个配置能带哪些内容：纯原版不带 Mod；隔离策略里不是「独立」的不带；自己已有游戏选项的不覆盖 */
async function offered(v, p, content) {
  const out = [];
  const add = (key) => out.push({ key, ...content[key], def: true });
  if (content.mods && v.loader) add('mods');
  if (content.resourcepacks && p.items.resourcepacks === 'own') add('resourcepacks');
  if (content.shaderpacks && p.items.shaderpacks === 'own') add('shaderpacks');
  if (content.options && p.items.options === 'own' && !(await exists(path.join(versions.versionDir(v.id), 'options.txt')))) add('options');
  return out;
}

/** 世界或 Mod 这些才算值得问；只有游戏选项（玩过就有）不单独弹窗 */
const worthAsking = (worlds, items) => worlds.length > 0 || items.some((i) => i.key !== 'options');

async function spaceAndBusy(id) {
  const space = await freeSpace(versions.versionDir(id));
  const game = await gamelock.forPath(rootSaves());
  return { free: space ? space.free : null, drive: space ? space.root : null, margin: MARGIN, busy: game ? game.versionId : null };
}

const conflictsOf = async (id, worlds) => {
  const mine = new Set((await isolation.listWorlds(versions.versionDir(id))).map((w) => w.name));
  return worlds.map((w) => w.name).filter((n) => mine.has(n));
};

/**
 * 这次保存要不要问玩家：配置现在在公共目录、改完存档是它自己的、公共目录里有世界或其他内容。
 * 共享和副本不问：它们的来源是玩家自己选的，世界还看得到
 */
async function info(id, policy) {
  const p = isolation.normalize(policy);
  const v = await versions.versionInfo(id);
  if (!v) throw new Error('配置不存在');
  if (p.items.saves !== 'own' || !samePath(versions.gameDirFor(id, v), versions.gameRoot())) return { ask: false };
  const worlds = await rootWorlds();
  const items = await offered(v, p, await rootContent());
  if (!worthAsking(worlds, items)) return { ask: false };
  const total = sum(worlds, 'size');
  const s = await spaceAndBusy(id);
  return {
    ask: true, worlds, total, items, ...s,
    need: total + MARGIN,
    enough: s.free == null || s.free >= total + MARGIN,
    conflicts: await conflictsOf(id, worlds),
  };
}

/** 从临时文件夹放到配置目录：目标不存在就整个改名；存在就一项一项放，自己已有的不覆盖 */
async function mergeInto(from, to) {
  if (!(await exists(to))) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try { await renameRetry(from, to); return { ok: true, kept: 0 }; } catch { return { ok: false, kept: 0 }; }
  }
  let ok = true;
  let kept = 0;
  for (const n of await fsp.readdir(from).catch(() => [])) {
    if (await exists(path.join(to, n))) { kept++; continue; }
    try { await renameRetry(path.join(from, n), path.join(to, n)); } catch { ok = false; }
  }
  return { ok, kept };
}

/**
 * 复制 → 切换 → 放进去。
 * @param {object} o id、v、p（隔离策略）、worlds、items、free、drive、task；
 *   check：复制前后各查一次游戏占用；sw：切换；undo：切换失败时退回去
 */
async function carry(o) {
  const { id, v, p, worlds, items, task } = o;
  await o.check();
  const bytes = sum(worlds, 'size') + sum(items, 'size');
  if (o.free != null && o.free < bytes + MARGIN) {
    throw withReason(`磁盘空间不足：需要约 ${fmtBytes(bytes + MARGIN)}，${o.drive} 只剩 ${fmtBytes(o.free)}`, {
      code: 'DISK_FULL', message: '磁盘空间不足', hint: '请清理磁盘空间，或者少选一些',
    });
  }
  const root = versions.gameRoot();
  const dir = versions.versionDir(id);
  const tmp = path.join(dir, TMP);
  const failed = [];

  // 第 1 步：复制到临时文件夹
  const src = await fsp.realpath(rootSaves()).catch(rootSaves);
  const steps = worlds.map((w, i) => ({ detail: `复制世界：${w.name}（${i + 1}/${worlds.length}）`, from: path.join(src, w.name), to: path.join(tmp, 'saves', w.name) }));
  const folders = (key) => (key === 'mods' ? (p.items.config === 'own' ? ['mods', 'config'] : ['mods']) : [key]);
  for (const it of items) {
    if (it.key === 'options') continue;
    for (const d of folders(it.key)) {
      if (await exists(path.join(root, d))) steps.push({ detail: COPYING[it.key], from: await fsp.realpath(path.join(root, d)), to: path.join(tmp, d) });
    }
  }
  const total = (sum(worlds, 'files') + sum(items, 'files')) || 1;
  let done = 0;
  try {
    await rmrf(tmp);
    await fsp.mkdir(tmp, { recursive: true });
    for (const s of steps) {
      task.update({ detail: s.detail, progress: Math.min(0.98, done / total) });
      await copyWorld(s.from, s.to, task.signal, () => {
        done++;
        if (done % 50 === 0) task.update({ progress: Math.min(0.98, done / total) });
      });
    }
    if (items.some((i) => i.key === 'options')) {
      // 游戏选项按目标版本转换（比如 DataVersion 比目标新，游戏会读坏）。转换不了就不带，不退回整份复制
      const ok = await gamesettings.translateCopy(path.join(root, 'options.txt'), path.join(tmp, 'options.txt'), { mc: null, loader: null }, { mc: v.mcVersion, loader: v.loader ? v.loader.type : null }).catch(() => false);
      if (!ok) failed.push('options');
    }
    // 复制的时候可能有人开了游戏：复制到的世界可能写到一半，不能当真
    await o.check();
    throwIfAborted(task.signal);
  } catch (e) {
    await rmrf(tmp).catch(() => {});
    throw e;
  }

  // 第 2 步：切换。失败就退回去
  task.update({ detail: '切换到独立存档', progress: 0.99 });
  let r;
  try {
    r = await o.sw();
  } catch (e) {
    await o.undo();
    await rmrf(tmp).catch(() => {});
    throw e;
  }
  const saves = path.join(dir, 'saves');
  await fsp.mkdir(saves, { recursive: true });
  const copied = [];
  for (const w of worlds) {
    const as = await freeName(saves, w.name, '公共目录');
    try {
      await renameRetry(path.join(tmp, 'saves', w.name), path.join(saves, as));
      copied.push({ name: w.name, as });
    } catch { failed.push(w.name); }
  }
  const carried = [];
  let kept = 0;
  for (const it of items) {
    if (it.key === 'options') {
      if (failed.includes('options')) continue;
      const m = await mergeInto(path.join(tmp, 'options.txt'), path.join(dir, 'options.txt'));
      if (m.ok) carried.push('options'); else failed.push('options');
      continue;
    }
    let ok = true;
    for (const d of folders(it.key)) {
      if (!(await exists(path.join(tmp, d)))) continue;
      const m = await mergeInto(path.join(tmp, d), path.join(dir, d));
      ok = ok && m.ok;
      kept += m.kept;
    }
    if (ok) carried.push(it.key); else failed.push(it.key);
  }
  await rmrf(tmp).catch(() => {});
  return { ...r, copied, items: carried, failed, kept };
}

/** 单配置：游戏开着不能复制（可能复制到写了一半的存档） */
async function assertFree(id) {
  await gamelock.assertVersion(id, '切换存档与隔离');
  await gamelock.assertPath(rootSaves(), '复制公共目录的内容');
}

const nothing = { copied: [], items: [], failed: [], kept: 0 };

/**
 * @param {{ worlds: string[], items: string[] }|string[]} sel 要带过去的世界和内容（只认公共目录里真有、这个配置能带的）
 */
async function bring(id, policy, sel, task) {
  const pick = Array.isArray(sel) ? { worlds: sel, items: [] } : { worlds: (sel && sel.worlds) || [], items: (sel && sel.items) || [] };
  const now = await info(id, policy);
  const worlds = now.ask ? now.worlds.filter((w) => pick.worlds.includes(w.name)) : [];
  const items = now.ask ? now.items.filter((i) => pick.items.includes(i.key)) : [];
  if (!worlds.length && !items.length) {
    await gamelock.assertVersion(id, '切换存档与隔离');
    return { ...(await isolation.setPolicy(id, policy)), ...nothing };
  }
  const oldSetting = config.getVersionSettings(id).isolation;
  const oldPolicy = (await profiles.readMeta(id)).isolation;
  return carry({
    id, v: await versions.versionInfo(id), p: isolation.normalize(policy), worlds, items, free: now.free, drive: now.drive, task,
    check: () => assertFree(id),
    sw: () => isolation.setPolicy(id, policy),
    undo: async () => {
      config.setVersionSettings(id, { isolation: oldSetting || 'global' });
      await profiles.writeMeta(id, { isolation: oldPolicy || null }).catch(() => {});
    },
  });
}

// ───────────────────────── 全局设置「独立游戏目录」 ─────────────────────────
const MODES = ['none', 'modded', 'all'];

/** 改全局设置时哪些配置会搬走、哪些会回到公共目录。一个设置只会往一个方向变 */
async function affected(mode) {
  if (!MODES.includes(mode)) throw new Error('未知的设置');
  const cur = config.get().isolation;
  const inRoot = (x, m) => samePath(versions.gameDirFor(x.id, x, m), versions.gameRoot());
  const list = (await profiles.list()).filter((x) => !(x.usedAsParent && !x.hasMeta && !x.loader));
  return {
    out: list.filter((x) => inRoot(x, cur) && !inRoot(x, mode)),
    back: list.filter((x) => !inRoot(x, cur) && inRoot(x, mode)),
  };
}

async function globalInfo(mode) {
  const { out, back } = await affected(mode);
  // 配置正开着的时候不能换它的目录
  for (const x of [...out, ...back]) await gamelock.assertVersion(x.id, '切换独立游戏目录');
  const res = { mode, outgoing: [], incoming: [], worlds: [], total: 0, items: [], hasContent: false, defaultTarget: null, free: null, drive: null, margin: MARGIN, busy: null };
  if (out.length) {
    res.worlds = await rootWorlds();
    res.total = sum(res.worlds, 'size');
    const content = await rootContent();
    for (const x of out) {
      const p = isolation.normalize(x.isolation);
      const canBring = p.items.saves === 'own';
      res.outgoing.push({ id: x.id, canBring, items: canBring ? await offered(x, p, content) : [], conflicts: canBring ? await conflictsOf(x.id, res.worlds) : [] });
    }
    res.hasContent = res.outgoing.some((o) => o.canBring && worthAsking(res.worlds, o.items));
    Object.assign(res, await spaceAndBusy(out[0].id));
    const sel = config.get().selectedVersion;
    if (res.outgoing.some((o) => o.id === sel && o.canBring)) res.defaultTarget = sel;
  }
  for (const x of back) {
    const dir = versions.versionDir(x.id);
    const jars = (await fsp.readdir(path.join(dir, 'mods')).catch(() => [])).filter((n) => /\.jar(\.disabled)?$/i.test(n));
    res.incoming.push({ id: x.id, worlds: (await isolation.listWorlds(dir)).length, mods: jars.length, dir });
  }
  return res;
}

/** @param {{ target: string, worlds: string[], items: string[] }} sel target：带给哪个配置，没有就只改设置 */
async function globalApply(mode, sel, task) {
  const now = await globalInfo(mode);
  const target = sel && sel.target ? now.outgoing.find((o) => o.id === sel.target && o.canBring) : null;
  const worlds = target ? now.worlds.filter((w) => (sel.worlds || []).includes(w.name)) : [];
  const items = target ? target.items.filter((i) => (sel.items || []).includes(i.key)) : [];
  if (!worlds.length && !items.length) {
    config.set({ isolation: mode });
    return { mode, ...nothing };
  }
  const id = target.id;
  const v = await versions.versionInfo(id);
  const old = config.get().isolation;
  const list = [...now.outgoing, ...now.incoming];
  return carry({
    id, v, p: isolation.normalize((await profiles.readMeta(id)).isolation), worlds, items, free: now.free, drive: now.drive, task,
    check: async () => {
      for (const x of list) await gamelock.assertVersion(x.id, '切换独立游戏目录');
      await gamelock.assertPath(rootSaves(), '复制公共目录的内容');
    },
    sw: async () => {
      config.set({ isolation: mode });
      // 以前暂存过的存档（saves.aurora-own）要先放回来，不然会被复制来的世界挡住
      await isolation.prepare(id, versions.gameDirFor(id, v), { allowCopy: false });
      return { mode };
    },
    undo: async () => { config.set({ isolation: old }); },
  });
}

module.exports = { info, bring, globalInfo, globalApply };
