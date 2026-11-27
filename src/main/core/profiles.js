'use strict';
/**
 * Aurora 配置文件（aurora-profile.json，格式版本 2）
 * 保存在 versions/<id>/aurora-profile.json，记录一个游戏配置的全部信息：
 *
 * {
 *   format: 'aurora-profile', formatVersion: 2,
 *   name, description, type,            // vanilla | vanillaplus | custom | modpack | planner
 *   game: { minecraft, loader: {type, version}, apiVersion, versionId, javaMajor },
 *   mods: { 文件名: { projectId, versionId, versionNumber, slug, title, icon, source } },
 *   presets: [{ name, enabled: [文件名] }], activePreset,
 *   isolation: { preset, source, items, worlds, refresh },
 *   saves: { count, worlds: [{ name, lastPlayed }], updatedAt },
 *   stats: { createdAt, lastPlayed, playTime, launchCount, testCount, crashCount },
 *   history: {
 *     launches: [{ at, duration, exitCode, crashed, test }],
 *     crashes: [{ at, exitCode, reasons, reportPath, logFile }],
 *     troubleshoot: [{ at, kind, ok, summary }],
 *   },
 *   modpack, planId, createdAt, updatedAt
 * }
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../engine/config');
const versions = require('./versions');
const { readJson, writeJson, exists, rmrf, renameRetry } = require('../engine/util');
const { copyDir } = require('../engine/fileops');
const store = require('../engine/jsonstore');
const { nm } = require('../../shared/i18n');

const META = 'aurora-profile.json';
const FORMAT_VERSION = 2;
const metaPath = (id) => path.join(versions.versionDir(id), META);
const metaLabel = (id) => `配置「${id}」的档案`;
const baseName = (file) => file.replace(/\.disabled$/i, '');

/** 读取并升级到最新格式 */
function upgrade(raw) {
  const m = { ...(raw || {}) };
  const stats = { createdAt: m.createdAt || Date.now(), lastPlayed: 0, playTime: 0, launchCount: 0, testCount: 0, crashCount: 0, ...(m.stats || {}) };
  if (m.lastPlayed && !stats.lastPlayed) stats.lastPlayed = m.lastPlayed;
  if (m.playTime && !stats.playTime) stats.playTime = m.playTime;
  delete m.lastPlayed;
  delete m.playTime;
  const history = { launches: [], crashes: [], troubleshoot: [], ...(m.history || {}) };
  return {
    format: 'aurora-profile',
    ...m,
    formatVersion: FORMAT_VERSION,
    mods: m.mods || {},
    presets: m.presets || [],
    stats,
    history,
  };
}

/** 读坏了：坏文件改名留着、有备份就恢复、告诉玩家（jsonstore）。读不了（被占着）时返回空档案，写入时会报错，不会拿空的去覆盖 */
async function readMeta(id) {
  const r = await store.load(metaPath(id), { label: metaLabel(id) });
  return upgrade(r.data || null);
}

/**
 * 读改写档案：fn(当前档案) 返回要合并进去的字段，同一个配置排队执行（1.10.7：以前几个任务同时写，后写的盖掉先写的）。
 * 基于旧值计算的写入（Mod 来源、历史记录、方案……）都要走这里，不要先 readMeta 再 writeMeta
 */
async function updateMeta(id, fn) {
  return store.update(metaPath(id), async (raw) => {
    const cur = upgrade(raw);
    const next = { ...cur, ...(await fn(cur)), updatedAt: Date.now() };
    if (!next.createdAt) next.createdAt = Date.now();
    return next;
  }, { label: metaLabel(id), fallback: null });
}

async function writeMeta(id, patch) {
  return updateMeta(id, () => patch);
}

/** 记录某个 Mod 文件的来源信息 */
async function setModInfo(id, entries) {
  return updateMeta(id, (meta) => {
    const mods = { ...(meta.mods || {}) };
    for (const [file, info] of Object.entries(entries)) {
      if (info === null) delete mods[baseName(file)];
      else mods[baseName(file)] = { ...(mods[baseName(file)] || {}), ...info };
    }
    return { mods };
  });
}

/**
 * 把版本标记为一个独立的游戏配置（强制版本隔离）。
 * opts.defaultShared：false 时先不按「新配置默认共享存档」去联接公共文件夹（整合包要先把自带的东西解压进自己的文件夹，装完再定，见 modpack.js）
 */
async function markProfile(id, type, extra = {}, { defaultShared = true } = {}) {
  config.setVersionSettings(id, { isolation: 'on' });
  const before = await readMeta(id);
  let meta = await writeMeta(id, { type, ...extra });
  // 首次启动时选了「共享存档」：新建的配置默认与公共 .minecraft 共享存档（创建时另选了方式的会随后覆盖）
  if (defaultShared && !before.isolation && config.get().newProfileIsolation === 'shared') {
    await require('./isolation').setPolicy(id, { preset: 'shared', source: '@root' }).catch((e) => console.warn('[profiles] 默认共享存档失败', e.message));
    meta = await readMeta(id);
  }
  await snapshot(id).catch(() => {});
  return meta;
}

async function countMods(dir) {
  try {
    const names = await fsp.readdir(path.join(dir, 'mods'));
    let enabled = 0;
    let total = 0;
    for (const n of names) {
      const l = n.toLowerCase();
      if (l.endsWith('.jar') || l.endsWith('.zip')) { enabled++; total++; } else if (l.endsWith('.jar.disabled') || l.endsWith('.zip.disabled')) total++;
    }
    return { enabled, total };
  } catch { return { enabled: 0, total: 0 }; }
}

/** 读取目录下的世界列表（跟随共享联接） */
async function listWorlds(dir) {
  const savesDir = path.join(dir, 'saves');
  let names = [];
  try { names = await fsp.readdir(savesDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (n.includes('.aurora')) continue;
    const st = await fsp.stat(path.join(savesDir, n, 'level.dat')).catch(() => null);
    if (st) out.push({ name: n, lastPlayed: st.mtimeMs });
  }
  return out.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

async function isLinked(p) {
  try { return (await fsp.lstat(p)).isSymbolicLink(); } catch { return false; }
}

async function list() {
  const all = await versions.listInstalled();
  const out = [];
  for (const v of all) {
    const meta = await readMeta(v.id);
    const gameDir = versions.gameDirFor(v.id, v);
    const isolated = gameDir !== versions.gameRoot();
    const mods = v.loader ? await countMods(gameDir) : { enabled: 0, total: 0 };
    const worlds = await listWorlds(gameDir);
    const usedAsParent = all.some((x) => x.inheritsFrom === v.id);
    out.push({
      ...v,
      profileType: meta.type || (v.loader ? 'custom' : 'vanilla'),
      displayName: meta.name || null,
      description: meta.description || '',
      modpack: meta.modpack || null,
      icon: meta.icon || null,
      lastPlayed: meta.stats.lastPlayed || 0,
      playTime: meta.stats.playTime || 0,
      launchCount: meta.stats.launchCount || 0,
      crashCount: meta.stats.crashCount || 0,
      createdAt: meta.stats.createdAt || meta.createdAt || v.installedAt,
      presets: (meta.presets || []).map((p) => ({ name: p.name, count: p.enabled.length })),
      activePreset: meta.activePreset || null,
      planId: meta.planId || null,
      isolation: meta.isolation || null,
      modsOff: (meta.modsOff || []).length,
      nostalgia: !!meta.nostalgia,
      savesLinked: isolated && (await isLinked(path.join(gameDir, 'saves'))),
      worlds: worlds.length,
      isolated,
      mods,
      usedAsParent,
      hasMeta: !!meta.type,
    });
  }
  return out;
}

/** 刷新配置文件中的游戏信息、Mod 与存档摘要 */
async function snapshot(id) {
  const info = await versions.versionInfo(id);
  if (!info) return null;
  const gameDir = versions.gameDirFor(id, info);
  const meta = await readMeta(id);
  const worlds = await listWorlds(gameDir);
  const mods = info.loader ? await countMods(gameDir) : { enabled: 0, total: 0 };
  const api = Object.entries(meta.mods || {}).find(([, m]) => ['fabric-api', 'qsl'].includes(m.slug));
  return writeMeta(id, {
    game: {
      minecraft: info.mcVersion,
      loader: info.loader ? { type: info.loader.type, version: info.loader.version } : null,
      apiVersion: api ? api[1].versionNumber || null : null,
      versionId: id,
      javaMajor: info.javaMajor || null,
      gameDir,
    },
    saves: { count: worlds.length, worlds: worlds.slice(0, 50), updatedAt: Date.now() },
    modCount: mods,
    settings: config.getVersionSettings(id),
  });
}

/** 完整的配置档案（用于“配置档案”界面与配置器） */
async function detail(id) {
  const meta = (await snapshot(id)) || (await readMeta(id));
  return meta;
}

/** 记录一次启动（含测试启动），崩溃时保存日志快照 */
async function recordLaunch(id, { startedAt, endedAt, exitCode, test, crash, lines }) {
  if (!(await exists(versions.versionJsonPath(id)))) return;
  const duration = Math.max(0, (endedAt || Date.now()) - startedAt);
  const crashed = !!(crash && exitCode !== 0);
  // 崩溃日志先写好，档案的读改写放在最后一步（排队，不和同时结束的排查记录互相覆盖）
  let logFile = null;
  if (crashed && !test) {
    try {
      const dir = path.join(versions.versionDir(id), 'aurora-logs');
      await fsp.mkdir(dir, { recursive: true });
      logFile = path.join(dir, `crash-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.log`);
      const body = [
        `# Aurora 崩溃记录 · ${id} · 退出代码 ${exitCode}`,
        `# 可能原因：${(crash.reasons || []).join('；') || '未识别'}`,
        crash.reportPath ? `# 崩溃报告：${crash.reportPath}` : '',
        '', '----- 游戏日志（最后 400 行）-----',
        ...(lines || []).slice(-400).map((l) => l.text),
        crash.report ? '\n----- 崩溃报告 -----' : '', crash.report || '',
      ].join('\n');
      await fsp.writeFile(logFile, body, 'utf8');
      // 只保留最近 20 份
      const files = (await fsp.readdir(dir)).filter((f) => f.startsWith('crash-')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 20))) await fsp.rm(path.join(dir, f), { force: true });
    } catch { logFile = null; }
  }
  await updateMeta(id, (meta) => {
    const stats = { ...meta.stats };
    const history = { ...meta.history };
    history.launches = [{ at: startedAt, duration, exitCode, crashed, test: !!test }, ...(history.launches || [])].slice(0, 30);
    if (test) stats.testCount = (stats.testCount || 0) + 1;
    else {
      stats.launchCount = (stats.launchCount || 0) + 1;
      stats.playTime = (stats.playTime || 0) + duration;
      stats.lastPlayed = endedAt || Date.now();
    }
    if (crashed && !test) {
      stats.crashCount = (stats.crashCount || 0) + 1;
      history.crashes = [{ at: startedAt, exitCode, reasons: crash.reasons || [], reportPath: crash.reportPath || null, logFile }, ...(history.crashes || [])].slice(0, 20);
    }
    return { stats, history };
  });
  await snapshot(id).catch(() => {});
}

/** 要保存的句子去掉名字的翻译标记（A.nm）：标记只给显示用，不写进文件 */
const plainMarks = (v) => JSON.parse(JSON.stringify(v).replace(/[\u2068\u2069]/g, ''));

async function recordTroubleshoot(id, entry) {
  if (!(await exists(versions.versionJsonPath(id)))) return;
  await updateMeta(id, (meta) => ({ history: { ...meta.history, troubleshoot: [{ at: Date.now(), ...plainMarks(entry) }, ...((meta.history && meta.history.troubleshoot) || [])].slice(0, 30) } }));
}

/**
 * 复制配置：复制版本文件夹（含 Mod、配置），跳过日志、本地库与共享联接
 * @param {{saves?: 'copy'|'none'}} opts
 */
async function duplicate(id, newName, opts = {}) {
  newName = (newName || '').trim();
  versions.validateName(newName);
  if (await exists(versions.versionDir(newName))) throw new Error(`版本 ${nm(newName)} 已存在`);
  const src = versions.versionDir(id);
  const dst = versions.versionDir(newName);
  const skipSaves = opts.saves === 'none';
  // 复制到旁边，版本文件改好才换成正式的名字：中途崩溃不留半个配置，不然再试只会报「已存在」（2.0.0-pre8，全面测试）
  const tmp = `${dst}.aurora-new-${Date.now()}`;
  try {
    await copyDir(src, tmp, {
      filter: (rel) => {
        const top = rel.split(path.sep)[0];
        if (/^natives-/.test(top) || ['logs', 'crash-reports', 'aurora-logs'].includes(top) || top.includes('.aurora-')) return false;
        if (/^aurora-profile\.json\.(bak|corrupt-)/.test(top)) return false; // 原配置档案的备份 / 坏文件不带过去
        if (skipSaves && top === 'saves') return false;
        // 共享的目录（联接）copyDir 不会带，之后按策略重新建立
        return true;
      },
    });
    const json = await readJson(path.join(tmp, `${id}.json`));
    await fsp.rm(path.join(tmp, `${id}.json`), { force: true });
    json.id = newName;
    if (!json.inheritsFrom && !json.jar) {
      const jar = path.join(tmp, `${id}.jar`);
      if (await exists(jar)) await renameRetry(jar, path.join(tmp, `${newName}.jar`));
      if (!json.clientVersion) json.clientVersion = id;
    } else {
      await fsp.rm(path.join(tmp, `${id}.jar`), { force: true }).catch(() => {});
    }
    await writeJson(path.join(tmp, `${newName}.json`), json);
    await renameRetry(tmp, dst);
    config.setVersionSettings(newName, { ...config.getVersionSettings(id) });
    const meta = await readMeta(newName);
    await writeJson(metaPath(newName), {
      ...meta,
      name: undefined,
      createdAt: Date.now(),
      stats: { createdAt: Date.now(), lastPlayed: 0, playTime: 0, launchCount: 0, testCount: 0, crashCount: 0 },
      history: { launches: [], crashes: [], troubleshoot: [] },
      duplicatedFrom: id,
    });
  } catch (e) {
    // 复制失败不留半成品（上面确认过这个名字原来不存在），不然再试只会报「已存在」（1.10.8）
    await rmrf(tmp).catch(() => {});
    await rmrf(dst).catch(() => {});
    config.setVersionSettings(newName, null);
    throw e;
  }
  return newName;
}

module.exports = {
  readMeta, writeMeta, updateMeta, setModInfo, markProfile, list, snapshot, detail, recordLaunch, recordTroubleshoot,
  duplicate, baseName, listWorlds, META, FORMAT_VERSION, upgrade,
};
