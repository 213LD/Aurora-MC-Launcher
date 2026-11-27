'use strict';
/**
 * 配置的组件管理：原地更换 Minecraft 版本 / 加载器（含卸载、换种类）、Fabric API、OptiFine、光影加载器
 *
 * 更换 MC 或加载器（change）：
 *   1. plan() 先算出 Mod 要怎么处理：同 MC 同加载器只换加载器版本 → Mod 不动；卸载加载器 → 全部禁用（之后能「恢复全部」）；
 *      其他情况逐个去 Modrinth / CurseForge 找新 MC / 新加载器上的版本：能换的换，找不到的禁用（不删）
 *   2. apply()：换 MC 前先备份存档（有世界才备份，失败就不继续）；旧的版本 JSON、客户端 jar、被替换的 Mod 都挪进
 *      versions/<id>/.aurora-components/<时间>/，记一份 record.json，undo() 按它还原
 *   3. 版本隔离设为「跟随全局 · 只隔离 Mod 版本」时，卸载加载器会让游戏目录变掉——这时把这个版本的隔离固定成原来的状态
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { oneSegment } = require('../engine/fileops');
const config = require('../engine/config');
const versions = require('./versions');
const loaders = require('./loaders');
const mods = require('./mods');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const profiles = require('./profiles');
const optifine = require('./optifine');
const { downloadFile } = require('../engine/downloader');
const { exists, readJson, writeJson, safeTrash, renameRetry } = require('../engine/util');
const store = require('../engine/jsonstore');
const { nm } = require('../../shared/i18n');

const SNAP = '.aurora-components';
const KEEP_SNAPSHOTS = 5;
const FABRIC_LIKE = ['fabric', 'quilt', 'legacyfabric'];
const API_IDS = ['fabric-api', 'fabric', 'quilted_fabric_api', 'legacy-fabric-api'];
const SHADER_IDS = ['iris', 'oculus'];

const snapRoot = (id) => path.join(versions.versionDir(id), SNAP);
const historyPath = (id) => path.join(snapRoot(id), 'history.json');
const loaderOf = (info) => (info && info.loader ? { type: info.loader.type, version: info.loader.version || '' } : null);
const sameLoader = (a, b) => (a ? a.type : null) === (b ? b.type : null);

function assertIdle() {
  if (require('./launcher').running()) throw new Error('有游戏正在运行，先关掉游戏再修改组件');
}

const histLabel = (id) => ({ label: `配置「${id}」的组件修改记录` });
async function history(id) {
  return (await store.read(historyPath(id), [], histLabel(id))) || [];
}

/** 组件概览：给配置抽屉的「组件」区用 */
async function info(id) {
  const v = await versions.versionInfo(id);
  if (!v) throw new Error(`找不到配置 ${nm(id)}`);
  const loader = loaderOf(v);
  const out = { id, mc: v.mcVersion, loader, api: null, optifine: null, shader: null, sodium: null, history: [] };
  if (loader && loader.type === 'optifine') out.optifine = { mode: 'loader', version: loader.version };
  if (loader && loader.type !== 'optifine' && loader.type !== 'liteloader') {
    const { mods: list } = await mods.listMods(id).catch(() => ({ mods: [] }));
    // 只认启用的：换过加载器后留下的、已禁用的旧 Mod 不算装了这个组件
    const pick = (ids) => list.find((m) => m.enabled && ids.includes(m.id));
    const brief = (m) => m && { file: m.file, path: m.path, version: m.version || '', enabled: m.enabled, name: m.name };
    out.api = brief(pick(API_IDS));
    const of = pick(['optifine']);
    if (of) out.optifine = { mode: 'mod', ...brief(of), version: (of.file.match(/OptiFine_[\d.]+_(\w+?)\.jar/i) || [])[1] || of.version || '' };
    const sh = pick(SHADER_IDS);
    if (sh) out.shader = { kind: sh.id, ...brief(sh) };
    out.sodium = brief(pick(['sodium', 'embeddium', 'rubidium']));
    out.optifabric = brief(pick(['optifabric']));
  }
  out.history = (await history(id)).filter((x) => !x.undone).slice(-3).reverse().map((x) => ({ ts: x.ts, from: x.from, to: x.to, label: x.label }));
  return out;
}

/** 版本在官方列表里的位置：越大越旧；找不到返回 -1 */
async function ageOf(mc) {
  const m = await versions.getManifest();
  return m.versions.findIndex((x) => x.id === mc);
}

/**
 * 算出更换后 Mod 要怎么处理
 * target: { mc, loader: null | { type, version, full?, entry? } }
 */
async function plan(id, target) {
  const v = await versions.versionInfo(id);
  if (!v) throw new Error(`找不到配置 ${nm(id)}`);
  const from = { mc: v.mcVersion, loader: loaderOf(v) };
  const to = { mc: target.mc, loader: target.loader && target.loader.type ? target.loader : null };
  const [a, b] = [await ageOf(from.mc), await ageOf(to.mc)];
  const out = { from, to, mcChanged: from.mc !== to.mc, downgrade: from.mc !== to.mc && a >= 0 && b > a, mode: 'none', mods: [] };
  const hadMods = from.loader && !['optifine', 'liteloader'].includes(from.loader.type);
  if (!hadMods) return out;
  const { mods: list } = await mods.listMods(id, { withHash: true });
  if (!list.length) return out;
  const modLoader = to.loader && !['optifine', 'liteloader'].includes(to.loader.type) ? to.loader.type : null;
  if (!modLoader) {
    out.mode = 'disableAll';
    out.mods = list.map((m) => ({ file: m.file, name: m.name, icon: m.icon, enabled: m.enabled, action: 'disable', reason: 'noloader' }));
    return out;
  }
  if (!out.mcChanged && sameLoader(from.loader, to.loader)) {
    out.mode = 'keep';
    const meta = await profiles.readMeta(id);
    const wasOff = new Set([...(meta.compDisabled || []), ...(meta.modsOff || [])]);
    out.mods = list.map((m) => ({ file: m.file, base: m.base, name: m.name, icon: m.icon, enabled: m.enabled, action: 'keep', reenable: !m.enabled && wasOff.has(m.base) }));
    return out;
  }
  out.mode = 'migrate';
  // 之前因为换加载器 / 卸载加载器被禁用的 Mod，这次能用了就重新启用
  const meta = await profiles.readMeta(id);
  const wasOff = new Set([...(meta.compDisabled || []), ...(meta.modsOff || [])]);
  const hashes = list.map((m) => m.sha1);
  const [current, latest] = await Promise.all([modrinth.identify(hashes), modrinth.updates(hashes, modLoader, to.mc)]);
  const cfOn = curseforge.available();
  const { pool } = require('../engine/util');
  await pool(list, 4, async (m) => {
    const row = { file: m.file, base: m.base, name: m.name, icon: m.icon, enabled: m.enabled };
    const l = latest[m.sha1];
    const ok = (ver) => ver && ver.gameVersions.includes(to.mc) && ver.loaders.some((x) => (modrinth.loaderList(modLoader) || []).includes(x));
    if (l && ok(l)) {
      const f = l.files.find((x) => x.primary) || l.files[0];
      if (f && f.sha1 === m.sha1) Object.assign(row, { action: 'keep' });
      else Object.assign(row, { action: 'replace', newVersion: l, newFile: f && f.filename, newNumber: l.number });
    } else if (!current[m.sha1] && m.curseforge && m.curseforge.projectId && cfOn) {
      try {
        const files = await curseforge.files(m.curseforge.projectId, { loader: modLoader, gameVersion: to.mc });
        const auto = files.filter((f) => !f.manual && f.gameVersions.includes(to.mc));
        const best = curseforge.bestFile(auto);
        if (best) Object.assign(row, { action: best.files[0].filename === m.file.replace(/\.disabled$/, '') ? 'keep' : 'replace', newVersion: best, newFile: best.files[0].filename, newNumber: best.number });
        else Object.assign(row, { action: 'disable', reason: files.length ? 'manual' : 'notfound' });
      } catch { Object.assign(row, { action: 'disable', reason: 'notfound' }); }
    } else {
      Object.assign(row, { action: 'disable', reason: current[m.sha1] || m.curseforge ? 'notfound' : 'unknown' });
    }
    if (!m.enabled && wasOff.has(m.base) && row.action !== 'disable') row.reenable = true;
    out.mods.push(row);
  });
  const order = { replace: 0, disable: 1, keep: 2 };
  out.mods.sort((x, y) => order[x.action] - order[y.action] || x.name.localeCompare(y.name));
  return out;
}

async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await renameRetry(src, dest); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

/** 只保留最近几份快照，更早的进回收站（里面有旧的 Mod jar） */
async function pruneSnapshots(id, hist) {
  const keep = hist.slice(-KEEP_SNAPSHOTS);
  for (const old of hist.slice(0, -KEEP_SNAPSHOTS)) {
    await safeTrash(path.join(snapRoot(id), String(old.ts))).catch(() => {});
  }
  return keep;
}

/**
 * 执行更换。target 同 plan；p 是 plan() 的结果（界面确认过的）。label 显示在历史里
 * 返回 { ts, replaced, disabled, failed: [{ file, error }] }
 */
async function apply(id, target, p, task, { label } = {}) {
  assertIdle();
  const before = await versions.versionInfo(id);
  if (!before) throw new Error(`找不到配置 ${nm(id)}`);
  const ts = Date.now();
  const dir = path.join(snapRoot(id), String(ts));
  await fsp.mkdir(dir, { recursive: true });
  const gameDirBefore = versions.gameDirFor(id, before);
  const vsBefore = config.getVersionSettings(id);
  const record = { ts, label: label || '', from: p.from, to: p.to, isolationBefore: vsBefore.isolation || null, jar: false, moved: [], added: [], disabled: [], enabled: [], disabledAll: false };

  // 1. 换 MC 版本前备份存档（有世界才备份，失败就停下）
  if (p.mcChanged) {
    const backup = require('./backup');
    // worlds() 给的是 { …, worlds: [世界] }；读不出存档就不换版本，不在没备份的情况下往下走
    let res;
    try { res = await backup.worlds(id); } catch (e) { throw new Error(`读不出这个配置的存档，先不换版本（${e.message}）`); }
    const worlds = res && Array.isArray(res.worlds) ? res.worlds : [];
    if (worlds.length) {
      task.update({ detail: '先备份存档…', progress: -1 });
      const entry = await backup.create(id, { type: 'saves', auto: 'component' }, task);
      record.backup = entry && entry.file;
    }
  }

  // 2. 新的版本 JSON
  const jsonPath = versions.versionJsonPath(id);
  const jarPath = versions.versionJarPath(id);
  await fsp.copyFile(jsonPath, path.join(dir, 'version.json'));
  const loader = p.to.loader && p.to.loader.type ? { ...p.to.loader, entry: target.loader && target.loader.entry } : null;
  const json = await loaders.buildJson(p.to.mc, loader, task);
  json.id = id;
  if (await exists(jarPath)) { await moveFile(jarPath, path.join(dir, 'client.jar')); record.jar = true; }
  try {
    await writeJson(jsonPath, json);
    await writeJson(path.join(dir, 'record.json'), record);
    await versions.completeVersion(id, task);
  } catch (e) {
    await fsp.copyFile(path.join(dir, 'version.json'), jsonPath).catch(() => {});
    if (record.jar) await moveFile(path.join(dir, 'client.jar'), jarPath).catch(() => {});
    throw e;
  }

  // 3. 游戏目录别跟着变
  const after = await versions.versionInfo(id);
  const gameDirAfter = versions.gameDirFor(id, after);
  if (path.resolve(gameDirAfter) !== path.resolve(gameDirBefore)) {
    config.setVersionSettings(id, { isolation: path.resolve(gameDirBefore) === path.resolve(versions.versionDir(id)) ? 'on' : 'none' });
    record.isolationPinned = true;
  }

  // 4. Mod
  const failed = [];
  const modsDir = path.join(gameDirBefore, 'mods');
  if (p.mode === 'disableAll') {
    task.update({ detail: '禁用全部 Mod…', progress: -1 });
    await mods.disableAll(id);
    record.disabledAll = true;
  }
  if (p.mode === 'migrate' || p.mode === 'keep') {
    const rows = p.mods.filter((m) => m.action !== 'keep' || m.reenable);
    let i = 0;
    for (const m of rows) {
      if (task.signal.aborted) break;
      i++;
      task.update({ detail: `处理 Mod（${i} / ${rows.length}）：${nm(m.name)}`, progress: i / rows.length });
      const cur = path.join(modsDir, m.file);
      if (!(await exists(cur))) continue;
      try {
        if (m.action === 'replace' && m.newVersion) {
          const nv = m.newVersion;
          const cf = nv.source === 'curseforge';
          const f = nv.files.find((x) => x.primary) || nv.files[0];
          const destName = m.enabled === false && !m.reenable ? `${f.filename}.disabled` : f.filename;
          const dest = path.join(modsDir, destName);
          await moveFile(cur, path.join(dir, 'mods', m.file));
          record.moved.push(m.file);
          try {
            await downloadFile({ urls: cf ? curseforge.cdnUrls(f.url) : [f.url], path: dest, sha1: f.sha1, size: f.size }, { task, label: f.filename });
          } catch (e) {
            await moveFile(path.join(dir, 'mods', m.file), cur);
            record.moved.pop();
            throw e;
          }
          record.added.push(destName);
          const proj = await (cf ? curseforge.project(nv.projectId, { body: false }) : modrinth.project(nv.projectId)).catch(() => ({}));
          await profiles.setModInfo(id, { [m.file]: null, [f.filename]: { projectId: nv.projectId, versionId: nv.id, versionNumber: nv.number, slug: proj.slug, title: proj.title, icon: proj.icon, url: cf ? proj.url : undefined, source: cf ? 'curseforge' : 'modrinth' } }).catch(() => {});
          if (m.reenable) record.enabled.push(m.base);
        } else if (m.action === 'keep' && m.reenable) {
          await mods.toggleMod(cur, true);
          record.enabled.push(m.base);
        } else if (m.action === 'disable' && m.enabled) {
          const np = await mods.toggleMod(cur, false);
          record.disabled.push(path.basename(np));
        }
      } catch (e) {
        if (e.cancelled) { failed.push({ file: m.file, error: '已取消' }); break; }
        failed.push({ file: m.file, error: e.message });
        if (m.enabled) {
          const np = await mods.toggleMod(cur, false).catch(() => null);
          if (np) record.disabled.push(path.basename(np));
        }
      }
    }
  }
  // 记下这次因为组件修改禁用 / 重新启用的 Mod，以后换回能用的加载器时自动重新启用
  const meta = await profiles.readMeta(id).catch(() => null);
  if (meta && (record.disabled.length || record.enabled.length)) {
    const set = new Set(meta.compDisabled || []);
    record.disabled.forEach((f) => set.add(f.replace(/\.disabled$/i, '')));
    record.enabled.forEach((b) => set.delete(b));
    record.compDisabledBefore = meta.compDisabled || [];
    const patch = { compDisabled: [...set] };
    if (record.enabled.length && meta.modsOff && meta.modsOff.length) { record.modsOffBefore = meta.modsOff; patch.modsOff = meta.modsOff.filter((b) => !record.enabled.includes(b)); }
    await profiles.writeMeta(id, patch).catch(() => {});
  }
  // 纯净版配置装了 Mod 加载器就算「Mod 配置」，卸载后变回纯净版
  const modLoaderNow = p.to.loader && !['optifine', 'liteloader'].includes(p.to.loader.type);
  const newType = meta && meta.type === 'vanilla' && modLoaderNow ? 'custom' : meta && meta.type === 'custom' && !modLoaderNow ? 'vanilla' : null;
  if (newType) { record.typeBefore = meta.type; await profiles.writeMeta(id, { type: newType }).catch(() => {}); }
  record.failed = failed;
  await writeJson(path.join(dir, 'record.json'), record);
  const hist = await history(id);
  hist.push({ ts, from: p.from, to: p.to, label: record.label });
  await store.write(historyPath(id), await pruneSnapshots(id, hist), histLabel(id));
  await profiles.snapshot(id).catch(() => {});
  return { ts, replaced: record.added.length, disabled: record.disabled.length + (record.disabledAll ? 1 : 0), disabledAll: record.disabledAll, failed, backup: record.backup || null, isolationPinned: !!record.isolationPinned };
}

/** 撤销一次更换 */
async function undo(id, ts, task) {
  assertIdle();
  const dir = path.join(snapRoot(id), oneSegment(String(ts), '记录'));
  const record = await readJson(path.join(dir, 'record.json'));
  if (!record) throw new Error('找不到这次修改的记录，可能已经被清理');
  const v = await versions.versionInfo(id);
  const modsDir = path.join(versions.gameDirFor(id, v), 'mods');

  task.update({ detail: '还原版本文件…', progress: -1 });
  const jarPath = versions.versionJarPath(id);
  await fsp.copyFile(path.join(dir, 'version.json'), versions.versionJsonPath(id));
  if (record.jar && (await exists(path.join(dir, 'client.jar')))) await moveFile(path.join(dir, 'client.jar'), jarPath);
  if (record.isolationPinned) config.setVersionSettings(id, { isolation: record.isolationBefore || 'global' });

  // 没还原成的（文件被占着等）记下来告诉玩家，不能都说成「已撤销」（1.10.8）
  const undoFailed = [];
  const undoneDir = path.join(dir, 'undone');
  for (const f of record.added || []) {
    const p = path.join(modsDir, f);
    if (await exists(p)) await moveFile(p, path.join(undoneDir, f)).catch(() => undoFailed.push(f));
  }
  for (const f of record.moved || []) {
    const src = path.join(dir, 'mods', f);
    if (await exists(src)) await moveFile(src, path.join(modsDir, f));
  }
  for (const f of record.disabled || []) {
    const p = path.join(modsDir, f);
    if (await exists(p)) await mods.toggleMod(p, true).catch(() => undoFailed.push(f));
  }
  for (const b of record.enabled || []) {
    const p = path.join(modsDir, b);
    if (await exists(p)) await mods.toggleMod(p, false).catch(() => undoFailed.push(b));
  }
  if (record.disabledAll) await mods.restoreAll(id);
  if (record.compDisabledBefore) await profiles.writeMeta(id, { compDisabled: record.compDisabledBefore }).catch(() => {});
  if (record.modsOffBefore) await profiles.writeMeta(id, { modsOff: record.modsOffBefore }).catch(() => {});
  if (record.typeBefore) await profiles.writeMeta(id, { type: record.typeBefore }).catch(() => {});
  await versions.completeVersion(id, task);

  const hist = await history(id);
  const h = hist.find((x) => x.ts === Number(ts));
  if (h) h.undone = Date.now();
  await store.write(historyPath(id), hist, histLabel(id));
  await mods.identify(id).catch(() => {});
  await profiles.snapshot(id).catch(() => {});
  return { ok: true, undoFailed };
}

// ───────────────────────── 单个组件 ─────────────────────────
async function needModLoader(id) {
  const v = await versions.versionInfo(id);
  const type = v && v.loader && v.loader.type;
  if (!type || ['optifine', 'liteloader'].includes(type)) throw new Error('这个配置没有 Mod 加载器');
  return { v, type };
}

async function installApi(id, task) {
  const { type } = await needModLoader(id);
  if (!FABRIC_LIKE.includes(type)) throw new Error('只有 Fabric / Quilt 需要 Fabric API');
  return mods.installFabricApi(id, task);
}

/** 更新某个 Mod 组件（Fabric API、光影加载器）到当前 MC / 加载器的最新版 */
async function updateMod(id, file, task) {
  const { v, type } = await needModLoader(id);
  const { mods: list } = await mods.listMods(id, { withHash: true });
  const m = list.find((x) => x.file === file);
  if (!m) throw new Error('找不到这个文件');
  const latest = (await modrinth.updates([m.sha1], type, v.mcVersion))[m.sha1];
  const f = latest && (latest.files.find((x) => x.primary) || latest.files[0]);
  if (!latest || !f || f.sha1 === m.sha1) return { updated: false };
  await mods.applyUpdate(id, { path: m.path, latest, enabled: m.enabled }, task);
  return { updated: true, version: latest.number };
}

async function removeMod(id, file) {
  const { dir } = await mods.targetDir(id, 'mod');
  const p = path.join(dir, file);
  if (path.dirname(p) !== dir || !(await exists(p))) throw new Error('找不到这个文件');
  await mods.removeMod(p, id);
}

/** 光影加载器：Fabric / Quilt 装 Iris，Forge / NeoForge 装 Oculus（连同必需的前置，如 Sodium / Embeddium） */
async function installShader(id, task) {
  const { v, type } = await needModLoader(id);
  const slug = FABRIC_LIKE.includes(type) ? 'iris' : 'oculus';
  const pv = modrinth.bestVersion(await modrinth.projectVersions(slug, { loader: type, gameVersion: v.mcVersion }));
  if (!pv) throw new Error(`${slug === 'iris' ? 'Iris' : 'Oculus'} 还没有适用于 ${nm(v.mcVersion)} 的版本`);
  return mods.installProjectVersion({ versionId: id, projectVersion: pv, kind: 'mod', withDeps: true }, task);
}

/**
 * OptiFine：纯净版当加载器装（走 apply，可撤销）；Forge 放进 mods；Fabric / Quilt 放进 mods 并装 OptiFabric；NeoForge 不支持
 * entry 是 optifine.list() 里的一项
 */
async function installOptifine(id, entry, task) {
  assertIdle();
  const v = await versions.versionInfo(id);
  const type = v.loader && v.loader.type;
  if (!type) {
    const target = { mc: v.mcVersion, loader: { type: 'optifine', version: entry.version, entry } };
    const p = await plan(id, target);
    return apply(id, target, p, task, { label: `安装 OptiFine ${entry.version}` });
  }
  if (type === 'neoforge') throw new Error('OptiFine 不支持 NeoForge，推荐改用 Embeddium + Oculus');
  if (type === 'optifine') throw new Error('这个配置已经装了 OptiFine');
  if (!['forge', ...FABRIC_LIKE].includes(type)) throw new Error('这个加载器不支持装 OptiFine');
  const jar = await optifine.download(entry, task);
  const { dir } = await mods.targetDir(id, 'mod');
  await fsp.mkdir(dir, { recursive: true });
  const installed = [entry.filename];
  await fsp.copyFile(jar, path.join(dir, entry.filename));
  if (FABRIC_LIKE.includes(type)) {
    task.update({ detail: '安装 OptiFabric…', progress: -1 });
    const pv = modrinth.bestVersion(await modrinth.projectVersions('optifabric', { loader: 'fabric', gameVersion: v.mcVersion }));
    if (!pv) {
      await fsp.rm(path.join(dir, entry.filename), { force: true });
      throw new Error(`OptiFabric 还没有适用于 ${nm(v.mcVersion)} 的版本，没法在 Fabric 上用 OptiFine`);
    }
    installed.push(...await mods.installProjectVersion({ versionId: id, projectVersion: pv, kind: 'mod', withDeps: true }, task));
  }
  return { installed };
}

async function removeOptifine(id, task) {
  assertIdle();
  const c = await info(id);
  if (!c.optifine) return { removed: false };
  if (c.optifine.mode === 'loader') {
    const target = { mc: c.mc, loader: null };
    const p = await plan(id, target);
    return apply(id, target, p, task, { label: '卸载 OptiFine' });
  }
  await removeMod(id, c.optifine.file);
  if (c.optifabric) await removeMod(id, c.optifabric.file).catch(() => {});
  return { removed: true };
}

module.exports = { info, plan, apply, undo, history, installApi, updateMod, removeMod, installShader, installOptifine, removeOptifine, optifineList: optifine.list };
