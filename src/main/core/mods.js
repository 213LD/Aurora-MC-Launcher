'use strict';
/**
 * Mod 管理：本地 Mod 列表与元数据解析、启用/禁用、Modrinth 识别与更新、Mod 方案、在线安装
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const versions = require('./versions');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const profiles = require('./profiles');
const { downloadFile, isValid } = require('../engine/downloader');
const { withZip, ZipReader } = require('../engine/zip');
const { exists, hashFile, pool, safeTrash, inUse, inUseError, capMap, renameRetry } = require('../engine/util');
const { nm } = require('../../shared/i18n');

const FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };

async function targetDir(versionId, kind = 'mod') {
  const info = await versions.versionInfo(versionId);
  if (!info) throw new Error('版本不存在');
  const dir = path.join(versions.gameDirFor(versionId, info), FOLDERS[kind] || 'mods');
  return { dir, info };
}

// ───────────────────────── 元数据解析 ─────────────────────────
function lenientJson(text) {
  try { return JSON.parse(text); } catch { /* 容错 */ }
  try {
    let out = '';
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== '\\') inStr = !inStr;
      if (inStr && (c === '\n' || c === '\r' || c === '\t')) { out += c === '\n' ? '\\n' : c === '\t' ? '\\t' : ''; continue; }
      out += c;
    }
    return JSON.parse(out);
  } catch { return null; }
}

function tomlValue(block, key) {
  const multi = block.match(new RegExp(`^\\s*${key}\\s*=\\s*'''([\\s\\S]*?)'''`, 'm')) || block.match(new RegExp(`^\\s*${key}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm'));
  if (multi) return multi[1].trim();
  const m = block.match(new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')) || block.match(new RegExp(`^\\s*${key}\\s*=\\s*'([^']*)'`, 'm'));
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const b = block.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, 'm'));
  return b ? b[1] : '';
}

/** 拆分 TOML 中的 [[xxx]] 表数组 */
function tomlTables(text, header) {
  const out = [];
  // 表头后面可以跟注释：Forge 官方模板就是 [[mods]] #mandatory、[[dependencies.examplemod]] #optional，很多 Mod 原样留着。
  // rc12 以前不认带注释的表头，这样的 Mod 整个读不出来（没有名字、版本、前置）
  const re = /^\s*\[\[([^\]]+)\]\]\s*(?:#.*)?$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ name: m[1].trim(), start: m.index, bodyStart: re.lastIndex });
  // 单个 [xxx] 表也作为分界
  const re2 = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/gm;
  const singles = [];
  while ((m = re2.exec(text))) singles.push(m.index);
  for (let i = 0; i < marks.length; i++) {
    if (!marks[i].name.startsWith(header)) continue;
    const ends = [marks[i + 1] ? marks[i + 1].start : text.length, ...singles.filter((s) => s > marks[i].start)];
    out.push({ name: marks[i].name, body: text.slice(marks[i].bodyStart, Math.min(...ends)) });
  }
  return out;
}

async function readIcon(z, iconPath) {
  if (!iconPath) return null;
  const e = z.getEntry(String(iconPath).replace(/^\.?\//, ''));
  if (!e || e.size > 512 * 1024) return null;
  try {
    const buf = await z.read(e);
    const mime = /\.jpe?g$/i.test(iconPath) ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

const asRanges = (v) => (Array.isArray(v) ? v : v == null ? ['*'] : [String(v)]);

/**
 * Quilt 的版本条件：一个范围、几个里任选其一的数组，或者 { any: […] }（任选其一）/ { all: […] }（都要满足）的对象，可以套着写。
 * 整理成「几个里满足一个就行」的数组；都要满足的用空格连成一个范围。看不懂的写法当成不限（宁可少报，不乱报）。
 * rc12 以前对象直接转成了字符串「[object Object]」
 */
function quiltRanges(v) {
  if (v == null) return ['*'];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) { const l = v.flatMap(quiltRanges); return l.length ? l : ['*']; }
  if (typeof v === 'object') {
    if (Array.isArray(v.any)) return quiltRanges(v.any);
    if (Array.isArray(v.all)) { const parts = v.all.map(quiltRanges); return parts.every((p) => p.length === 1) ? [parts.map((p) => p[0]).join(' ')] : ['*']; }
  }
  return ['*'];
}

/**
 * 读取嵌套 jar（jar-in-jar）：返回其提供的 Mod ID，以及嵌套模块声明的 Minecraft 版本范围
 * （有些 Mod 把真正的版本限制写在内部的 runtime 模块里）
 */
async function nestedInfo(z, list, depth = 0) {
  const out = { ids: [], mc: [] };
  if (depth > 2) return out;
  for (const name of list) {
    const e = z.getEntry(name);
    if (!e || e.size > 64 * 1024 * 1024) continue;
    try {
      const buf = await z.read(e);
      const nz = await ZipReader.fromBuffer(buf, name);
      const fj = await nz.readText('fabric.mod.json');
      if (fj) {
        const j = lenientJson(fj) || {};
        if (j.id) out.ids.push(j.id);
        out.ids.push(...(j.provides || []));
        if (j.depends && j.depends.minecraft) out.mc.push({ kind: 'semver', ranges: asRanges(j.depends.minecraft) });
        if (Array.isArray(j.jars)) {
          const sub = await nestedInfo(nz, j.jars.map((x) => x.file).filter(Boolean), depth + 1);
          out.ids.push(...sub.ids);
          out.mc.push(...sub.mc);
        }
      }
      const tm = (await nz.readText('META-INF/neoforge.mods.toml')) || (await nz.readText('META-INF/mods.toml'));
      if (tm) for (const t of tomlTables(tm, 'mods')) { const id = tomlValue(t.body, 'modId'); if (id) out.ids.push(id); }
    } catch { /* 忽略损坏的嵌套 jar */ }
  }
  return out;
}

/**
 * Mod 实际要的 Java 版本：读 class 文件头（CAFEBABE 后第 7、8 字节是 class 版本，减 44 就是 Java 版本）。
 * 元数据里写的 depends.java 不一定对（Veinminer 2.0.7 写 >=17，其实是 Java 21 编译的）。
 * 先看入口类，没有入口类（Forge）就看前几个类；META-INF/versions 下的多版本类不算。读不到返回 0
 */
async function classJava(z, entryClasses) {
  const own = entryClasses.map((c) => `${c.replace(/\./g, '/')}.class`).filter((n) => z.getEntry(n));
  const names = own.length ? own.slice(0, 2) : z.entries.filter((e) => e.name.endsWith('.class') && !e.name.startsWith('META-INF/') && e.size < 512 * 1024).slice(0, 3).map((e) => e.name);
  let max = 0;
  for (const n of names) {
    try {
      const buf = await z.read(n);
      if (buf && buf.length > 8 && buf.readUInt32BE(0) === 0xcafebabe) max = Math.max(max, buf.readUInt16BE(6) - 44);
    } catch { /* 读不了就跳过 */ }
  }
  return max > 0 ? max : 0;
}

async function readModMeta(file) {
  return withZip(file, (z) => metaFromZip(z));
}

/** light：只要 id、版本和依赖声明（Mod 配置器下载前远程读 jar 用，1.5.8），不读图标、嵌套 jar 和 class 版本 */
async function metaFromZip(z, { light = false } = {}) {
  const iconOf = (p) => (light ? null : readIcon(z, p));
  // 多加载器 jar 会同时带有多份元数据，依赖信息按加载器分别记录
  const meta = { loaders: [], ids: [], provides: [], byLoader: {}, env: null };
  const section = (loader, kind) => {
    if (!meta.byLoader[loader]) meta.byLoader[loader] = { kind, deps: {}, breaks: {}, conflicts: {}, mc: null };
    return meta.byLoader[loader];
  };
  let primary = null;

  // Fabric
  const fj = await z.readText('fabric.mod.json');
  if (fj) {
    const j = lenientJson(fj) || {};
    meta.loaders.push('fabric');
    const sec = section('fabric', 'semver');
    let icon = j.icon;
    if (icon && typeof icon === 'object') icon = icon[Object.keys(icon).sort((a, b) => b - a)[0]];
    primary = {
      id: j.id, name: j.name || j.id, version: j.version, description: j.description || '',
      authors: (j.authors || []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean), icon: await iconOf(icon),
    };
    if (j.id) meta.ids.push(j.id);
    // 入口类：用来看这个 Mod 实际是用哪个版本的 Java 编译的（classJava）
    meta.entryClasses = Object.values(j.entrypoints || {}).flat().map((x) => (typeof x === 'string' ? x : x && x.value)).filter(Boolean).map((x) => x.split('::')[0]);
    meta.provides.push(...(j.provides || []));
    for (const [k, v] of Object.entries(j.depends || {})) sec.deps[k] = asRanges(v);
    for (const [k, v] of Object.entries(j.breaks || {})) sec.breaks[k] = asRanges(v);
    for (const [k, v] of Object.entries(j.conflicts || {})) sec.conflicts[k] = asRanges(v);
    if (j.depends && j.depends.minecraft) sec.mc = { kind: 'semver', ranges: asRanges(j.depends.minecraft) };
    meta.env = j.environment || '*';
    if (Array.isArray(j.jars) && !light) {
      const nested = await nestedInfo(z, j.jars.map((x) => x.file).filter(Boolean));
      meta.provides.push(...nested.ids);
      // Fabric 会同样校验嵌套模块的依赖，因此它们的版本限制也必须满足
      sec.nestedMc = nested.mc;
    }
  }

  // Quilt
  const qj = await z.readText('quilt.mod.json');
  if (qj) {
    const q = (lenientJson(qj) || {}).quilt_loader || {};
    const md = q.metadata || {};
    meta.loaders.push('quilt');
    const sec = section('quilt', 'semver');
    if (!primary) {
      let icon = md.icon;
      if (icon && typeof icon === 'object') icon = icon[Object.keys(icon).sort((a, b) => b - a)[0]];
      primary = { id: q.id, name: md.name || q.id, version: q.version, description: md.description || '', authors: Object.keys(md.contributors || {}), icon: await iconOf(icon) };
    }
    if (q.id) meta.ids.push(q.id);
    for (const p of q.provides || []) meta.provides.push(typeof p === 'string' ? p : p.id);
    for (const d of q.depends || []) {
      if (typeof d === 'string') sec.deps[d] = ['*'];
      else if (d && d.id && !d.optional) sec.deps[d.id] = quiltRanges(d.versions);
    }
    for (const d of q.breaks || []) {
      if (typeof d === 'string') sec.breaks[d] = ['*'];
      else if (d && d.id) sec.breaks[d.id] = quiltRanges(d.versions);
    }
    const mcDep = (q.depends || []).find((d) => d && (d === 'minecraft' || d.id === 'minecraft'));
    if (mcDep && mcDep.versions) sec.mc = { kind: 'semver', ranges: quiltRanges(mcDep.versions) };
  }

  // Forge / NeoForge
  const neo = await z.readText('META-INF/neoforge.mods.toml');
  const forge = await z.readText('META-INF/mods.toml');
  for (const [text, loader] of [[neo, 'neoforge'], [forge, 'forge']]) {
    if (!text) continue;
    meta.loaders.push(loader);
    const sec = section(loader, 'maven');
    const modTables = tomlTables(text, 'mods');
    for (const t of modTables) {
      const id = tomlValue(t.body, 'modId');
      if (id) meta.ids.push(id);
    }
    if (!primary && modTables[0]) {
      const block = modTables[0].body;
      let version = tomlValue(block, 'version');
      if (!version || version.includes('${')) {
        const mf = await z.readText('META-INF/MANIFEST.MF');
        const m = mf && mf.match(/^Implementation-Version:\s*(.+)$/m);
        version = m ? m[1].trim() : version;
      }
      const authors = tomlValue(block, 'authors') || tomlValue(text, 'authors');
      primary = {
        id: tomlValue(block, 'modId'), name: tomlValue(block, 'displayName') || tomlValue(block, 'modId'), version,
        description: tomlValue(block, 'description'), authors: authors ? [authors] : [],
        icon: await iconOf(tomlValue(block, 'logoFile') || tomlValue(text, 'logoFile')),
      };
    }
    for (const t of tomlTables(text, 'dependencies')) {
      const depId = tomlValue(t.body, 'modId');
      if (!depId) continue;
      const type = (tomlValue(t.body, 'type') || '').toLowerCase();
      const mandatory = tomlValue(t.body, 'mandatory');
      const side = (tomlValue(t.body, 'side') || 'BOTH').toUpperCase();
      const range = tomlValue(t.body, 'versionRange') || '*';
      if (side === 'SERVER') continue;
      if (type === 'incompatible') sec.breaks[depId] = [range];
      else if (type === 'discouraged') sec.conflicts[depId] = [range];
      else if (type === 'required' || mandatory === 'true' || (!type && mandatory === '')) {
        if (!(mandatory === 'false') && type !== 'optional') sec.deps[depId] = [range];
      }
      if (depId === 'minecraft') sec.mc = { kind: 'maven', ranges: [range] };
    }
    const jarjar = z.entries.filter((e) => e.name.startsWith('META-INF/jarjar/') && e.name.endsWith('.jar')).map((e) => e.name);
    if (jarjar.length && !light) meta.provides.push(...(await nestedInfo(z, jarjar)).ids);
  }

  // 旧版 Forge
  if (!primary) {
    const t = await z.readText('mcmod.info');
    if (t) {
      let j = lenientJson(t);
      if (j && j.modList) j = j.modList;
      const arr = Array.isArray(j) ? j : j ? [j] : [];
      if (arr[0]) {
        meta.loaders.push('forge');
        const sec = section('forge', 'maven');
        const m = arr[0];
        primary = { id: m.modid, name: m.name || m.modid, version: m.version, description: m.description || '', authors: m.authorList || m.authors || [], icon: await iconOf(m.logoFile) };
        for (const x of arr) if (x.modid) meta.ids.push(x.modid);
        for (const r of m.requiredMods || []) {
          const [id, range] = String(r).split('@');
          if (id && !['forge', 'minecraft', 'mod_minecraftforge', 'fml'].includes(id.toLowerCase())) sec.deps[id] = [range || '*'];
        }
      }
    }
  }
  if (!primary && z.getEntry('optifine/Differ.class')) {
    meta.loaders.push('optifine');
    primary = { id: 'optifine', name: 'OptiFine', version: '', description: '', authors: [], icon: null };
    meta.ids.push('optifine');
  }
  if (!primary) return null;
  meta.classJava = light ? 0 : await classJava(z, meta.entryClasses || []);
  delete meta.entryClasses;
  meta.ids = [...new Set(meta.ids.filter(Boolean))];
  meta.provides = [...new Set(meta.provides.filter(Boolean))];
  return { ...primary, loader: meta.loaders[0] || null, ...meta };
}

const metaCache = new Map();
const shaCache = new Map();

async function sha1Of(full, st) {
  const key = `${full}|${st.size}|${st.mtimeMs}`;
  if (shaCache.has(key)) return shaCache.get(key);
  const h = await hashFile(full, 'sha1');
  shaCache.set(key, h);
  capMap(shaCache, 5000);
  return h;
}

async function scanDir(dir) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const fileName of names) {
    const lower = fileName.toLowerCase();
    const enabled = lower.endsWith('.jar') || lower.endsWith('.zip');
    const disabled = lower.endsWith('.jar.disabled') || lower.endsWith('.zip.disabled');
    if (!enabled && !disabled) continue;
    const full = path.join(dir, fileName);
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ fileName, full, enabled, st });
  }
  return out;
}

async function listMods(versionId, { withHash = false } = {}) {
  const { dir, info } = await targetDir(versionId, 'mod');
  const meta = await profiles.readMeta(versionId);
  const known = meta.mods || {};
  const files = await scanDir(dir);
  const mods = [];
  await pool(files, 8, async ({ fileName, full, enabled, st }) => {
    const key = `${full}|${st.size}|${st.mtimeMs}`;
    let m = metaCache.get(key);
    if (m === undefined) {
      m = await readModMeta(full).catch(() => null);
      metaCache.set(key, m);
      capMap(metaCache, 3000); // 带图标，换过版本的旧文件也一直留着
    }
    const base = profiles.baseName(fileName);
    const src = known[base] || null;
    mods.push({
      file: fileName,
      base,
      path: full,
      enabled,
      size: st.size,
      mtime: st.mtimeMs,
      // 放进文件夹的时间：复制文件时 Windows 会保留原来的修改时间，但创建时间是复制的时间，取两者较晚的（排序用）
      added: Math.max(st.birthtimeMs || 0, st.mtimeMs),
      sha1: withHash ? await sha1Of(full, st) : undefined,
      name: (m && m.name) || (src && src.title) || fileName.replace(/\.(jar|zip)(\.disabled)?$/i, ''),
      ...(m || {}),
      icon: (m && m.icon) || (src && src.icon) || null,
      modrinth: src && src.projectId && src.source !== 'curseforge' ? src : null,
      curseforge: src && src.projectId && src.source === 'curseforge' ? src : null,
    });
  });
  mods.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, mods, info, presets: meta.presets || [], activePreset: meta.activePreset || null, cfManual: meta.cfManual || [] };
}

async function toggleMod(filePath, enable) {
  const isDisabled = filePath.endsWith('.disabled');
  let target = filePath;
  if (enable && isDisabled) target = filePath.slice(0, -'.disabled'.length);
  else if (!enable && !isDisabled) target = `${filePath}.disabled`;
  if (target === filePath) return target;
  // 另一个名字已经有文件了（a.jar 和 a.jar.disabled 两份都在）：改名会把那一份悄悄盖掉，停下让玩家自己挑
  if (await exists(target)) throw new Error(`已经有一个「${nm(path.basename(target))}」了（同一个 Mod 启用、禁用的两份都在），先删掉不要的那一份再切换`);
  await renameRetry(filePath, target);
  return target;
}

async function setEnabledMany(versionId, map) {
  const { mods } = await listMods(versionId);
  for (const m of mods) {
    if (!(m.base in map)) continue;
    const want = !!map[m.base];
    if (want !== m.enabled) await toggleMod(m.path, want);
  }
}

/** 删除 Mod 文件：默认进回收站，回收站不可用时抛出 TRASH_UNAVAILABLE，由界面确认后再 permanent 删除 */
async function removeMod(filePath, versionId, { permanent = false } = {}) {
  if (permanent) {
    if (await inUse(filePath)) throw inUseError(filePath);
    await fsp.rm(filePath, { force: true });
  } else await safeTrash(filePath);
  if (versionId) await profiles.setModInfo(versionId, { [path.basename(filePath)]: null }).catch(() => {});
}

async function addFiles(versionId, files, kind = 'mod') {
  const { dir } = await targetDir(versionId, kind);
  await fsp.mkdir(dir, { recursive: true });
  let count = 0;
  for (const f of files) {
    if (!f) continue;
    const st = await fsp.stat(f).catch(() => null);
    if (!st || !st.isFile()) continue;
    await fsp.copyFile(f, path.join(dir, path.basename(f)));
    count++;
  }
  return count;
}

// ───────────────────────── Modrinth 识别与更新 ─────────────────────────
/** 用文件哈希识别 Mod 在 Modrinth 上的项目，并写入配置元数据 */
async function identify(versionId) {
  const { mods } = await listMods(versionId, { withHash: true });
  const found = await modrinth.identify(mods.map((m) => m.sha1));
  const projectIds = [...new Set(Object.values(found).map((v) => v.projectId))];
  const projs = projectIds.length ? await modrinth.projects(projectIds) : [];
  const byId = new Map(projs.map((p) => [p.id, p]));
  const entries = {};
  for (const m of mods) {
    const v = found[m.sha1];
    if (!v) continue;
    const p = byId.get(v.projectId) || {};
    entries[m.base] = { projectId: v.projectId, versionId: v.id, versionNumber: v.number, slug: p.slug, title: p.title, icon: p.icon, source: 'modrinth' };
  }
  // Modrinth 上找不到的再用 CurseForge 的文件指纹识别（官方接口或社区代理）
  const rest = mods.filter((m) => !entries[m.base] && !(m.curseforge && m.curseforge.versionId));
  if (rest.length && curseforge.available()) {
    try {
      const prints = new Map();
      for (const m of rest) prints.set(m.base, curseforge.fingerprint(await fsp.readFile(m.path)));
      const found2 = await curseforge.identify([...prints.values()]);
      const projs = await curseforge.projects([...new Set(Object.values(found2).map((v) => v.projectId))]);
      for (const m of rest) {
        const v = found2[prints.get(m.base)];
        if (!v) continue;
        const p = projs.get(v.projectId) || {};
        entries[m.base] = { projectId: v.projectId, versionId: v.id, versionNumber: v.number, slug: p.slug, title: p.title, icon: p.icon, url: p.url, source: 'curseforge' };
      }
    } catch (e) { console.warn('[mods] CurseForge 识别失败', e.message); }
  }
  if (Object.keys(entries).length) await profiles.setModInfo(versionId, entries);
  return { total: mods.length, identified: Object.keys(entries).length };
}

async function checkUpdates(versionId) {
  const { mods, info } = await listMods(versionId, { withHash: true });
  const loader = info.loader && info.loader.type;
  const latest = await modrinth.updates(mods.map((m) => m.sha1), loader, info.mcVersion);
  const current = await modrinth.identify(mods.map((m) => m.sha1));
  const out = [];
  for (const m of mods) {
    const l = latest[m.sha1];
    const c = current[m.sha1];
    if (!l || !c || l.id === c.id) continue;
    if (new Date(l.published) <= new Date(c.published)) continue;
    out.push({ file: m.file, path: m.path, name: m.name, current: c.number, latest: l, enabled: m.enabled });
  }
  // 来自 CurseForge 的 Mod：按记录的文件 ID 比较同版本 / 加载器下的最新文件（作者关闭第三方下载的跳过）
  const cf = mods.filter((m) => m.curseforge && m.curseforge.versionId && !current[m.sha1]);
  await pool(cf, 4, async (m) => {
    try {
      const list = await curseforge.files(m.curseforge.projectId, { loader, gameVersion: info.mcVersion });
      const best = curseforge.bestFile(list.filter((f) => !f.manual));
      const cur = list.find((f) => f.id === String(m.curseforge.versionId));
      if (!best || best.id === String(m.curseforge.versionId)) return;
      if (cur && new Date(best.published) <= new Date(cur.published)) return;
      if (best.files[0].filename === m.file.replace(/\.disabled$/, '')) return;
      out.push({ file: m.file, path: m.path, name: m.name, current: m.curseforge.versionNumber || (cur && cur.number) || '', latest: best, enabled: m.enabled });
    } catch { /* 查询失败的跳过 */ }
  });
  return out;
}

async function applyUpdate(versionId, { path: oldPath, latest, enabled }, task) {
  const { dir } = await targetDir(versionId, 'mod');
  const file = latest.files.find((f) => f.primary) || latest.files[0];
  if (!file || !file.url) throw new Error('新版本没有可下载的文件');
  const cf = latest.source === 'curseforge';
  const destName = enabled === false ? `${file.filename}.disabled` : file.filename;
  const dest = path.join(dir, destName);
  await downloadFile({ urls: cf ? curseforge.cdnUrls(file.url) : [file.url], path: dest, sha1: file.sha1, size: file.size }, { task, label: file.filename });
  // 旧版本的 jar 已被新文件取代，回收站不可用时直接删掉也不会丢失玩家数据
  if (path.resolve(dest) !== path.resolve(oldPath)) await removeMod(oldPath, versionId).catch(() => removeMod(oldPath, versionId, { permanent: true }));
  const p = await (cf ? curseforge.project(latest.projectId, { body: false }) : modrinth.project(latest.projectId)).catch(() => ({}));
  await profiles.setModInfo(versionId, { [file.filename]: { projectId: latest.projectId, versionId: latest.id, versionNumber: latest.number, slug: p.slug, title: p.title, icon: p.icon, url: cf ? p.url : undefined, source: cf ? 'curseforge' : 'modrinth' } });
  return file.filename;
}

// ───────────────────────── Mod 方案 ─────────────────────────
async function savePreset(versionId, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('方案名称不能为空');
  const { mods } = await listMods(versionId);
  const meta = await profiles.updateMeta(versionId, (cur) => {
    const presets = (cur.presets || []).filter((p) => p.name !== name);
    presets.push({ name, enabled: mods.filter((m) => m.enabled).map((m) => m.base), createdAt: Date.now() });
    return { presets, activePreset: name };
  });
  return meta.presets;
}

async function applyPreset(versionId, name) {
  const meta = await profiles.readMeta(versionId);
  const p = (meta.presets || []).find((x) => x.name === name);
  if (!p) throw new Error('方案不存在');
  const want = new Set(p.enabled);
  const { mods } = await listMods(versionId);
  const map = {};
  for (const m of mods) map[m.base] = want.has(m.base);
  await setEnabledMany(versionId, map);
  await profiles.writeMeta(versionId, { activePreset: name });
  const missing = p.enabled.filter((b) => !mods.some((m) => m.base === b));
  return { applied: mods.length, missing };
}

async function deletePreset(versionId, name) {
  const meta = await profiles.updateMeta(versionId, (cur) => ({ presets: (cur.presets || []).filter((p) => p.name !== name), activePreset: cur.activePreset === name ? null : cur.activePreset }));
  return meta.presets;
}

// ───────────────────────── 一键禁用 / 恢复全部 Mod ─────────────────────────
/** 禁用所有已启用的 Mod，并记住它们，之后可以原样恢复 */
async function disableAll(versionId) {
  const { mods: list } = await listMods(versionId);
  const off = [];
  const record = () => profiles.updateMeta(versionId, (cur) => ({ modsOff: [...new Set([...(cur.modsOff || []), ...off])], modsOffAt: Date.now() }));
  try {
    for (const m of list) {
      if (!m.enabled) continue;
      await toggleMod(m.path, false);
      off.push(m.base);
    }
  } catch (e) {
    // 禁用到一半出错（文件被占着）：已经禁用的也要记下来，「恢复全部」才能把它们放回去
    if (off.length) await record().catch(() => {}); // pitfall-ok：下面照样把原来的错误抛给玩家，这里只是尽量记下
    throw e;
  }
  const meta = await record();
  return { disabled: off.length, total: meta.modsOff.length };
}

async function restoreAll(versionId) {
  const meta = await profiles.readMeta(versionId);
  const want = new Set(meta.modsOff || []);
  const { mods: list } = await listMods(versionId);
  let n = 0;
  for (const m of list) {
    if (!m.enabled && want.has(m.base)) { await toggleMod(m.path, true); n++; }
  }
  await profiles.writeMeta(versionId, { modsOff: [], modsOffAt: null });
  return { enabled: n };
}

// ───────────────────────── 在线安装 ─────────────────────────
/** 安装 Modrinth 上的某个版本，并自动安装必需的前置 */
async function installProjectVersion({ versionId, projectVersion, kind = 'mod', withDeps = true }, task) {
  const { dir, info } = await targetDir(versionId, kind);
  await fsp.mkdir(dir, { recursive: true });
  const loader = info.loader && info.loader.type;
  const installed = [];
  const visited = new Set();
  const existing = kind === 'mod' ? (await profiles.readMeta(versionId)).mods || {} : {};
  const haveProject = new Set(Object.values(existing).map((m) => m.projectId));
  const metaEntries = {};

  const installOne = async (pv, depth) => {
    if (visited.has(pv.projectId)) return;
    visited.add(pv.projectId);
    if (depth > 0 && haveProject.has(pv.projectId)) return;
    const file = pv.files.find((f) => f.primary) || pv.files[0];
    if (!file) return;
    const dest = path.join(dir, file.filename);
    // 已经有这个文件：按大小和 SHA-1 看它是不是完整的（以前只看在不在，下载到一半坏掉的文件就一直留着）
    const want = { urls: [file.url], path: dest, sha1: file.sha1, size: file.size };
    if (!(await isValid(want))) {
      task.update({ detail: `下载 ${nm(file.filename)}` });
      await downloadFile(want, { task, label: file.filename });
    }
    installed.push(file.filename);
    if (kind === 'mod') {
      const p = await modrinth.project(pv.projectId).catch(() => ({}));
      metaEntries[file.filename] = { projectId: pv.projectId, versionId: pv.id, versionNumber: pv.number, slug: p.slug, title: p.title, icon: p.icon, source: 'modrinth' };
    }
    if (!withDeps || depth > 3 || kind !== 'mod') return;
    for (const dep of pv.dependencies) {
      if (dep.type !== 'required' || !dep.projectId || visited.has(dep.projectId)) continue;
      try {
        let depVer = null;
        if (dep.versionId) depVer = await modrinth.version(dep.versionId).catch(() => null);
        if (!depVer || (info.mcVersion && !depVer.gameVersions.includes(info.mcVersion))) {
          depVer = modrinth.bestVersion(await modrinth.projectVersions(dep.projectId, { loader, gameVersion: info.mcVersion }));
        }
        if (depVer) await installOne(depVer, depth + 1);
      } catch (e) {
        if (e.cancelled) throw e;
        console.warn('[mods] 前置安装失败', dep.projectId, e.message);
      }
    }
  };

  await installOne(projectVersion, 0);
  if (Object.keys(metaEntries).length) await profiles.setModInfo(versionId, metaEntries);
  return installed;
}

/** 为新安装的 Fabric/Quilt 版本附带安装 Fabric API */
async function installFabricApi(versionId, task) {
  const info = await versions.versionInfo(versionId);
  const loader = info && info.loader && info.loader.type;
  const project = loader === 'legacyfabric' ? 'legacy-fabric-api' : 'P7dR8mSH';
  const pv = modrinth.bestVersion(await modrinth.projectVersions(project, { loader: loader === 'quilt' || loader === 'legacyfabric' ? loader : 'fabric', gameVersion: info.mcVersion }));
  if (!pv) throw new Error('没有找到适用于该版本的 Fabric API');
  return installProjectVersion({ versionId, projectVersion: pv, kind: 'mod', withDeps: false }, task);
}

module.exports = {
  targetDir, readModMeta, metaFromZip, listMods, toggleMod, setEnabledMany, removeMod, addFiles, scanDir, sha1Of,
  identify, checkUpdates, applyUpdate, savePreset, applyPreset, deletePreset, disableAll, restoreAll,
  installProjectVersion, installFabricApi,
  search: modrinth.search, projectVersions: modrinth.projectVersions, project: modrinth.project,
};
