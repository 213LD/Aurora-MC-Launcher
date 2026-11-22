'use strict';
/**
 * 游戏版本和配置：版本清单、安装和补全（库、资源、natives）、版本 JSON 的继承和解析、
 * 游戏目录怎么定（公共目录 / 独立目录 / 引用别的启动器的目录）、改名和删除。
 */
const BRAND = require('../../shared/brand');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const config = require('../engine/config');
const paths = require('../engine/paths');
const mirrors = require('../engine/mirrors');
const { getJson } = require('../engine/net');
const { downloadAll, downloadFile } = require('../engine/downloader');
const { oneSegment, safeJoin } = require('../engine/fileops');
const { exists, readJson, writeJson, mavenPath, parseMaven, osName, systemArch, normArch, rmrf, safeTrash, inUse, inUseError, renameRetry } = require('../engine/util');
const { problemText } = require('../../shared/pathrules');
const { nm } = require('../../shared/i18n');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// ───────────────────────── 目录 ─────────────────────────
const gameRoot = () => config.get().gameDir;
const versionsDir = () => path.join(gameRoot(), 'versions');
const librariesDir = () => path.join(gameRoot(), 'libraries');
const assetsDir = () => path.join(gameRoot(), 'assets');
const versionDir = (id) => path.join(versionsDir(), oneSegment(id, '配置名'));
const versionJsonPath = (id) => path.join(versionDir(id), `${id}.json`);
const versionJarPath = (id) => path.join(versionDir(id), `${id}.jar`);

async function ensureLauncherProfiles() {
  const p = path.join(gameRoot(), 'launcher_profiles.json');
  if (!(await exists(p))) {
    await writeJson(p, {
      profiles: {},
      selectedProfile: '',
      authenticationDatabase: {},
      launcherVersion: { name: BRAND.short, format: 21, profilesFormat: 2 },
    });
  }
}

// ───────────────────────── 版本清单 ─────────────────────────
let manifestCache = null;

/**
 * 接口返回的格式不对就当没拿到（2.0.0-pre8，全面测试：坏输入）。镜像或代理可能返回错误页、改过的内容，
 * 以前原样交给界面，下载页和配置器一打开就崩，还会存进缓存
 */
function cleanManifest(m) {
  const ok = m && typeof m === 'object' && Array.isArray(m.versions) && m.latest && typeof m.latest.release === 'string';
  const list = ok ? m.versions.filter((v) => v && typeof v.id === 'string' && typeof v.url === 'string' && typeof v.type === 'string') : [];
  if (!list.length) throw new Error('版本列表的格式不对');
  return { ...m, versions: list };
}

async function getManifest(force = false) {
  if (manifestCache && !force) return manifestCache;
  const cacheFile = path.join(paths.cacheDir(), 'version_manifest_v2.json');
  try {
    await mirrors.probe();
    manifestCache = cleanManifest(await getJson(mirrors.candidates(MANIFEST_URL), { timeout: 15000 }));
    writeJson(cacheFile, manifestCache, false).catch(() => {});
  } catch (e) {
    manifestCache = null;
    const cached = await readJson(cacheFile).then(cleanManifest).catch(() => null);
    if (!cached) throw new Error(`获取版本列表失败：${e.message}`);
    manifestCache = cached;
    manifestCache._offline = true;
  }
  return manifestCache;
}

// ───────────────────────── 规则 ─────────────────────────
function ruleArch(arch) {
  return arch === 'x86' ? 'x86' : arch === 'arm64' ? 'arm64' : 'x86_64';
}

function ruleAllows(rules, features = {}, arch = systemArch()) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== osName()) match = false;
      if (r.os.arch && r.os.arch !== ruleArch(arch) && !(r.os.arch === 'x86' && arch === 'x86')) match = false;
      if (r.os.version) {
        try { if (!new RegExp(r.os.version).test(os.release())) match = false; } catch { /* ignore */ }
      }
    }
    if (r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false;
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

// ───────────────────────── 版本 JSON ─────────────────────────
async function readVersionJson(id) {
  const j = await readJson(versionJsonPath(id));
  if (!j) throw new Error(`版本 ${nm(id)} 不存在或其 JSON 已损坏`);
  return j;
}

function mergeVersion(parent, child) {
  const out = { ...parent, ...child };
  out.id = child.id;
  out.mainClass = child.mainClass || parent.mainClass;
  out.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  if (parent.arguments || child.arguments) {
    out.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
    };
  }
  out.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  for (const k of ['assetIndex', 'assets', 'downloads', 'javaVersion', 'logging']) {
    out[k] = child[k] || parent[k];
  }
  out.type = parent.type || child.type;
  out._jarId = child.jar || parent._jarId;
  out._chain = [child.id, ...parent._chain];
  out._mcVersion = parent._mcVersion;
  delete out.inheritsFrom;
  return out;
}

async function resolveVersion(id, depth = 0) {
  if (depth > 8) throw new Error('版本继承层级过深');
  const json = await readVersionJson(id);
  if (!json.inheritsFrom) {
    return { ...json, _jarId: json.jar || json.id, _chain: [json.id], _mcVersion: guessMcVersion(json) };
  }
  if (!(await exists(versionJsonPath(json.inheritsFrom)))) {
    const err = new Error(`缺少前置版本 ${json.inheritsFrom}`);
    err.missingParent = json.inheritsFrom;
    throw err;
  }
  const parent = await resolveVersion(json.inheritsFrom, depth + 1);
  return mergeVersion(parent, json);
}

function guessMcVersion(json) {
  if (json.clientVersion) return json.clientVersion;
  if (json.inheritsFrom) return json.inheritsFrom;
  if (json.jar) return json.jar;
  // 从 client 下载地址或 id 推断
  return json.id;
}

// ───────────────────────── 依赖库 ─────────────────────────
function nativeArchOf(classifier) {
  const c = classifier.toLowerCase();
  if (/(arm64|aarch64)/.test(c)) return 'arm64';
  if (/-x86$|-x86_32$|-i386$/.test(c)) return 'x86';
  return 'x64';
}

function libraryUrl(lib, relPath) {
  if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path === relPath) return lib.downloads.artifact.url;
  const base = (lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
  return base + relPath;
}

/**
 * 收集 classpath、natives 以及需要下载的文件
 * @param {object} v 解析后的版本
 * @param {{arch?: string, features?: object}} opts
 */
function collectLibraries(v, opts = {}) {
  const arch = normArch(opts.arch || systemArch());
  const libs = librariesDir();
  const seen = new Set();
  const classpath = [];
  const natives = [];
  const files = [];
  const archBits = arch === 'x86' ? '32' : '64';

  for (const lib of v.libraries || []) {
    if (!lib || !lib.name) continue;
    if (!ruleAllows(lib.rules, opts.features, arch)) continue;
    const m = parseMaven(lib.name);

    // 旧版 natives 格式
    if (lib.natives) {
      const raw = lib.natives[osName()];
      if (raw) {
        const classifier = raw.replace('${arch}', archBits);
        const info = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier];
        const rel = info && info.path ? info.path : mavenPath(`${lib.name}:${classifier}`);
        const p = safeJoin(libs, rel, '版本文件'); // 版本文件可能来自导入包，里面的路径不能信（2.0.0-pre8）
        const key = `native:${m.group}:${m.artifact}`;
        if (!seen.has(key)) {
          seen.add(key);
          natives.push({ path: p, exclude: (lib.extract && lib.extract.exclude) || ['META-INF/'], flatten: false });
          files.push({
            urls: mirrors.candidates(info && info.url ? info.url : libraryUrl(lib, rel)),
            path: p, sha1: info && info.sha1, size: info && info.size,
          });
        }
      }
      if (!(lib.downloads && lib.downloads.artifact)) continue;
    }

    const isNative = m.classifier.startsWith('natives-');
    if (isNative && nativeArchOf(m.classifier) !== arch) continue;

    const key = `${m.group}:${m.artifact}:${m.classifier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const artifact = lib.downloads && lib.downloads.artifact;
    const rel = (artifact && artifact.path) || mavenPath(lib.name);
    const p = safeJoin(libs, rel, '版本文件');
    classpath.push(p);
    if (isNative) natives.push({ path: p, exclude: ['META-INF/'], flatten: true });

    if (artifact && artifact.url === '') {
      // 由安装器生成的本地文件（如 Forge 的 client 补丁），无法下载，仅检查存在性
      files.push({ urls: [], path: p, sha1: artifact.sha1, size: artifact.size, local: true });
    } else {
      files.push({
        urls: mirrors.candidates(artifact ? artifact.url : libraryUrl(lib, rel)),
        path: p,
        sha1: (artifact && artifact.sha1) || lib.sha1,
        size: (artifact && artifact.size) || lib.size,
      });
    }
  }
  return { classpath, natives, files };
}

// ───────────────────────── 资源文件 ─────────────────────────
async function ensureAssetIndex(v, task) {
  const idx = v.assetIndex;
  if (!idx) return null;
  const p = path.join(assetsDir(), 'indexes', `${idx.id}.json`);
  await downloadFile({ urls: mirrors.candidates(idx.url), path: p, sha1: idx.sha1, size: idx.size }, { task, label: '资源索引', verify: 'hash' });
  const index = await readJson(p);
  if (!index || !index.objects) throw new Error('资源索引文件损坏');
  return index;
}

function assetFilesFromIndex(index) {
  const seen = new Set();
  const out = [];
  for (const o of Object.values(index.objects)) {
    if (seen.has(o.hash) || !/^[0-9a-f]{40}$/i.test(o.hash)) continue;
    seen.add(o.hash);
    const sub = `${o.hash.slice(0, 2)}/${o.hash}`;
    out.push({
      urls: mirrors.candidates(`https://resources.download.minecraft.net/${sub}`),
      path: path.join(assetsDir(), 'objects', sub),
      sha1: o.hash,
      size: o.size,
    });
  }
  return out;
}

/** 旧版本（1.7.2 及更早）需要把资源复制为“虚拟”目录结构 */
async function prepareLegacyAssets(v, gameDir) {
  const idx = v.assetIndex;
  if (!idx) return null;
  const index = await readJson(path.join(assetsDir(), 'indexes', `${idx.id}.json`));
  if (!index || !(index.virtual || index.map_to_resources)) return null;
  const target = index.map_to_resources ? path.join(gameDir, 'resources') : path.join(assetsDir(), 'virtual', idx.id);
  const entries = Object.entries(index.objects);
  for (const [name, o] of entries) {
    const dest = path.join(target, name);
    if (await exists(dest)) continue;
    const src = path.join(assetsDir(), 'objects', o.hash.slice(0, 2), o.hash);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest).catch(() => {});
  }
  return target;
}

// ───────────────────────── 安装与补全 ─────────────────────────
async function installVersionJson(mcId, name = mcId, task) {
  const manifest = await getManifest();
  const entry = manifest.versions.find((x) => x.id === mcId);
  if (!entry) throw new Error(`官方版本列表中找不到 ${nm(mcId)}`);
  if (task) task.update({ detail: `获取 ${nm(mcId)} 版本信息`, progress: -1 });
  const json = await getJson(mirrors.candidates(entry.url));
  json.id = name;
  if (name !== mcId) json.clientVersion = mcId;
  await writeJson(versionJsonPath(name), json);
  return json;
}

/** 确保继承链上的前置版本 JSON 都存在 */
async function ensureParents(id, task) {
  let cur = await readVersionJson(id);
  for (let i = 0; i < 8 && cur.inheritsFrom; i++) {
    const parentId = cur.inheritsFrom;
    if (!(await exists(versionJsonPath(parentId)))) await installVersionJson(parentId, parentId, task);
    cur = await readVersionJson(parentId);
  }
}

/**
 * 补全版本所需的全部文件：客户端、依赖库、natives、资源索引与资源、日志配置
 * @param {string} id
 * @param {import('./tasks').Task} task
 * @param {{verify?: 'hash'|'size', arch?: string}} opts
 */
async function completeVersion(id, task, opts = {}) {
  await ensureParents(id, task);
  const v = await resolveVersion(id);
  const files = [];

  // 客户端 jar
  const jarId = v._jarId;
  if (v.downloads && v.downloads.client) {
    const c = v.downloads.client;
    files.push({ urls: mirrors.candidates(c.url), path: versionJarPath(jarId), sha1: c.sha1, size: c.size });
  } else if (!(await exists(versionJarPath(jarId)))) {
    throw new Error(`缺少客户端文件 ${nm(jarId)}.jar，且版本信息中没有下载地址`);
  }

  // 依赖库
  const libs = collectLibraries(v, { arch: opts.arch });
  for (const f of libs.files) {
    if (f.local) {
      if (!(await exists(f.path))) throw new Error(`缺少由安装器生成的文件 ${nm(path.basename(f.path))}，请重新安装该加载器`);
      continue;
    }
    files.push(f);
  }

  // 日志配置
  const logFile = v.logging && v.logging.client && v.logging.client.file;
  if (logFile) {
    files.push({ urls: mirrors.candidates(logFile.url), path: path.join(assetsDir(), 'log_configs', logFile.id), sha1: logFile.sha1, size: logFile.size });
  }

  // 资源
  if (task) task.update({ detail: '获取资源索引', progress: -1 });
  const index = await ensureAssetIndex(v, task);
  if (index) files.push(...assetFilesFromIndex(index));

  await downloadAll(files, { task, verify: opts.verify || 'hash', label: '下载游戏文件' });
  return v;
}

async function installVanilla(mcId, name, task) {
  name = (name || mcId).trim();
  validateName(name);
  if (await exists(versionJsonPath(name))) throw new Error(`版本 ${nm(name)} 已存在`);
  await installVersionJson(mcId, name, task);
  try {
    await completeVersion(name, task);
  } catch (e) {
    if (e.cancelled) await rmrf(versionDir(name));
    throw e;
  }
}

/** 确保原版（作为加载器的前置）已安装且完整 */
async function ensureVanilla(mcId, task) {
  if (!(await exists(versionJsonPath(mcId)))) await installVersionJson(mcId, mcId, task);
  await completeVersion(mcId, task);
}

function validateName(name) {
  const problem = problemText(name, { max: 80 });
  if (problem) throw new Error(problem);
}

// ───────────────────────── 已安装版本 ─────────────────────────
function detectLoader(json) {
  const names = (json.libraries || []).map((l) => (l && l.name) || '');
  const find = (prefix) => names.find((n) => n.startsWith(prefix));
  let lib;
  if ((lib = find('net.fabricmc:fabric-loader:'))) {
    const legacy = names.some((n) => n.startsWith('net.legacyfabric'));
    return { type: legacy ? 'legacyfabric' : 'fabric', version: parseMaven(lib).version };
  }
  if ((lib = find('org.quiltmc:quilt-loader:'))) return { type: 'quilt', version: parseMaven(lib).version };
  if ((lib = find('net.neoforged:neoforge:')) || (lib = find('net.neoforged.fancymodloader')) || /neoforge/i.test(json.id)) {
    const args = ((json.arguments && json.arguments.game) || []).filter((x) => typeof x === 'string');
    const i = args.indexOf('--fml.neoForgeVersion');
    const ver = i >= 0 ? args[i + 1] : lib && lib.startsWith('net.neoforged:neoforge:') ? parseMaven(lib).version : '';
    return { type: 'neoforge', version: ver };
  }
  if ((lib = find('net.neoforged:forge:'))) {
    return { type: 'neoforge', version: parseMaven(lib).version.split('-').slice(1).join('-') };
  }
  const args = ((json.arguments && json.arguments.game) || []).filter((x) => typeof x === 'string');
  const fi = args.indexOf('--fml.forgeVersion');
  if (fi >= 0) return { type: 'forge', version: args[fi + 1] };
  if ((lib = find('net.minecraftforge:forge:')) || (lib = find('net.minecraftforge:fmlloader:'))) {
    const v = parseMaven(lib).version;
    return { type: 'forge', version: v.split('-').slice(1).join('-') || v };
  }
  // 1.6.x / 1.5.x 的旧版 Forge：库名为 minecraftforge，通过 FML tweaker 启动
  if ((lib = find('net.minecraftforge:minecraftforge:'))) return { type: 'forge', version: parseMaven(lib).version };
  if (/cpw\.mods\.fml/.test(json.minecraftArguments || '')) return { type: 'forge', version: '' };
  if (/minecraftforge|cpw\.mods/.test(json.mainClass || '') || /forge/i.test(json.id)) return { type: 'forge', version: '' };
  if ((lib = find('optifine:OptiFine:'))) return { type: 'optifine', version: parseMaven(lib).version };
  if (find('com.mumfrey:liteloader:')) return { type: 'liteloader', version: '' };
  return null;
}

async function listInstalled() {
  const dir = versionsDir();
  let dirs = [];
  try { dirs = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const id = d.name;
    const jsonPath = versionJsonPath(id);
    if (!(await exists(jsonPath))) continue;
    const json = await readJson(jsonPath);
    if (!json) { out.push({ id, broken: true, reason: 'JSON 损坏' }); continue; }
    const loader = detectLoader(json);
    let mcVersion = guessMcVersion(json);
    if (!json.inheritsFrom && loader && mcVersion === id) {
      const m = id.match(/^(\d+\.\d+(?:\.\d+)?)/);
      if (m) mcVersion = m[1];
    }
    let stat = null;
    try { stat = await fsp.stat(jsonPath); } catch { /* ignore */ }
    out.push({
      id,
      mcVersion,
      type: json.type || 'release',
      loader,
      inheritsFrom: json.inheritsFrom || null,
      releaseTime: json.releaseTime || null,
      installedAt: stat ? stat.mtimeMs : 0,
      javaMajor: json.javaVersion ? json.javaVersion.majorVersion : null,
    });
  }
  // 继承信息中补全 javaMajor 与类型
  const byId = new Map(out.map((v) => [v.id, v]));
  for (const v of out) {
    let p = v.inheritsFrom && byId.get(v.inheritsFrom);
    if (v.inheritsFrom && !p) v.missingParent = true;
    for (let i = 0; p && i < 5; i++) {
      if (!v.javaMajor && p.javaMajor) v.javaMajor = p.javaMajor;
      if (p.type) v.type = p.type;
      p = p.inheritsFrom && byId.get(p.inheritsFrom);
    }
  }
  out.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
  return out;
}

/** 删除版本文件夹：默认进回收站，回收站不可用时抛出 TRASH_UNAVAILABLE；permanent 只在用户二次确认后使用 */
async function removeVersion(id, { permanent = false } = {}) {
  const dir = versionDir(id);
  if (!(await exists(dir))) return;
  if (permanent) {
    // 有文件被占着时 rmrf 会删掉没被占着的那些，留下半截：先看一下，占着就不动（1.10.7）
    if (await inUse(dir)) throw inUseError(dir);
    await rmrf(dir);
  } else await safeTrash(dir);
  config.setVersionSettings(id, null);
}

async function renameVersion(oldId, newId) {
  newId = (newId || '').trim();
  validateName(newId);
  if (oldId === newId) return;
  const caseOnly = oldId.toLowerCase() === newId.toLowerCase();
  if (!caseOnly && (await exists(versionDir(newId)))) throw new Error(`版本 ${nm(newId)} 已存在`);
  const json = await readVersionJson(oldId);
  const oldDir = versionDir(oldId);
  const newDir = versionDir(newId);
  // 改名分好几步，中途失败要全部退回去：以前会停在中间（目录改了、JSON 没改），配置从列表里消失（1.10.7）
  const undo = [];
  const move = async (from, to) => { await renameRetry(from, to); undo.push(() => renameRetry(to, from)); };
  try {
    if (caseOnly) {
      // 大小写不敏感的文件系统上需要经过临时名称中转
      const tmp = versionDir(`${newId}.aurora-tmp`);
      await move(oldDir, tmp);
      await move(tmp, newDir);
    } else {
      await move(oldDir, newDir);
    }
    await move(path.join(newDir, `${oldId}.json`), path.join(newDir, `${newId}.json`));
    const oldJar = path.join(newDir, `${oldId}.jar`);
    if (await exists(oldJar)) {
      if (!json.jar && !json.inheritsFrom) {
        await move(oldJar, path.join(newDir, `${newId}.jar`));
      }
    }
    const before = JSON.stringify(json);
    json.id = newId;
    if (!json.inheritsFrom && !json.clientVersion) json.clientVersion = oldId;
    await writeJson(path.join(newDir, `${newId}.json`), json);
    undo.push(() => writeJson(path.join(newDir, `${newId}.json`), JSON.parse(before)));
    // 修正依赖此版本的其他版本
    for (const v of await listInstalled()) {
      if (v.inheritsFrom === oldId) {
        const j = await readVersionJson(v.id);
        const was = JSON.stringify(j);
        j.inheritsFrom = newId;
        if (j.jar === oldId) j.jar = newId;
        await writeJson(versionJsonPath(v.id), j);
        undo.push(() => writeJson(versionJsonPath(v.id), JSON.parse(was)));
      }
    }
  } catch (e) {
    for (const back of undo.reverse()) await back().catch((err) => console.warn('[versions] 改名回滚失败', err.message));
    throw e;
  }
  config.renameVersionSettings(oldId, newId);
}

/** 根据版本信息判断所需 Java */
function requiredJava(v) {
  if (v.javaVersion && v.javaVersion.majorVersion) {
    return { major: v.javaVersion.majorVersion, component: v.javaVersion.component || null };
  }
  return { major: 8, component: 'jre-legacy' };
}

/** 版本隔离：决定游戏运行目录 */
/** global：按这个全局设置算（改设置之前要知道会搬走谁，1.10.10），默认是现在的设置 */
function gameDirFor(id, info, global = config.get().isolation) {
  const vs = config.getVersionSettings(id);
  // 从别的启动器「引用原目录」导入的（2.0.0-pre10，core/foreign.js）：两个启动器共用那个文件夹
  if (vs.customGameDir) return vs.customGameDir;
  const mode = vs.isolation && vs.isolation !== 'global' ? vs.isolation : global;
  let isolate = false;
  if (mode === 'all' || mode === 'on') isolate = true;
  else if (mode === 'modded') isolate = !!(info && info.loader) || (info && info.type && info.type !== 'release');
  return isolate ? versionDir(id) : gameRoot();
}

async function versionInfo(id) {
  const list = await listInstalled();
  return list.find((v) => v.id === id) || null;
}

module.exports = {
  MANIFEST_URL, getManifest, gameRoot, versionsDir, librariesDir, assetsDir, versionDir, versionJsonPath, versionJarPath,
  ensureLauncherProfiles, ruleAllows, readVersionJson, resolveVersion, collectLibraries, assetFilesFromIndex, prepareLegacyAssets,
  installVersionJson, ensureParents, completeVersion, installVanilla, ensureVanilla, validateName, detectLoader,
  listInstalled, removeVersion, renameVersion, requiredJava, gameDirFor, versionInfo,
};
