'use strict';
/**
 * Mod 加载器：Fabric / Quilt / Forge / NeoForge
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const mirrors = require('../engine/mirrors');
const paths = require('../engine/paths');
const versions = require('./versions');
const javaMgr = require('./java');
const { getJson, getText } = require('../engine/net');
const { downloadAll, downloadFile } = require('../engine/downloader');
const { withZip } = require('../engine/zip');
const { exists, writeJson, mavenPath, abortError, readJson, rmrf, renameRetry } = require('../engine/util');
const { cutChars } = require('../../shared/pathrules');
const { lineDecoder } = require('../engine/procenc');
const { nm } = require('../../shared/i18n');

const enc = encodeURIComponent;
const cmpVer = (a, b) => b.localeCompare(a, undefined, { numeric: true });

// ───────────────────────── 版本列表 ─────────────────────────
// Fabric 系加载器的元数据地址（Legacy Fabric 为 1.13 之前的旧版本提供 Fabric）
const FABRIC_META = {
  fabric: 'https://meta.fabricmc.net/v2',
  quilt: 'https://meta.quiltmc.org/v3',
  legacyfabric: 'https://meta.legacyfabric.net/v2',
};

async function fabricLike(kind, mc) {
  const url = `${FABRIC_META[kind]}/versions/loader/${enc(mc)}`;
  let arr;
  try {
    arr = await getJson(mirrors.candidates(url));
  } catch (e) {
    // 不支持的版本可能直接返回 4xx
    if (e.status && e.status >= 400 && e.status < 500) return [];
    throw e;
  }
  return (arr || []).map((x, i) => ({
    version: x.loader.version,
    stable: kind !== 'quilt' ? !!x.loader.stable : !/beta|pre|rc/i.test(x.loader.version),
    recommended: false,
    latest: i === 0,
  })).map((x, i, all) => {
    if (!all.some((y) => y.recommended) && x.stable) x.recommended = true;
    return x;
  });
}

async function forgeOfficialList(mc) {
  const meta = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json', { timeout: 15000 });
  return (meta && meta[mc]) || [];
}

async function forgeBmclList(mc) {
  const arr = await getJson(`${mirrors.BMCL}/forge/minecraft/${enc(mc)}`, { timeout: 15000 });
  return (arr || []).map((x) => `${mc}-${x.version}${x.branch ? `-${x.branch}` : ''}`);
}

async function forgeList(mc) {
  const sources = mirrors.preferMirror() ? [forgeBmclList, forgeOfficialList] : [forgeOfficialList, forgeBmclList];
  let list = [];
  let lastErr = null;
  for (const src of sources) {
    try { list = await src(mc); lastErr = null; break; } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  let promos = {};
  try {
    const p = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', { retries: 1, timeout: 10000 });
    promos = (p && p.promos) || {};
  } catch { /* 可选 */ }
  const rec = promos[`${mc}-recommended`];
  const lat = promos[`${mc}-latest`];
  return list.map((full) => {
    let v = full.startsWith(`${mc}-`) ? full.slice(mc.length + 1) : full;
    if (v.endsWith(`-${mc}`)) v = v.slice(0, -(mc.length + 1));
    return { version: v, full, stable: true, recommended: v === rec, latest: v === lat };
  }).sort((a, b) => cmpVer(a.version, b.version));
}

function neoMcVersion(v) {
  const base = v.split('-')[0];
  const parts = base.split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1] || '0', 10);
  if (major >= 26) {
    return parts.length >= 4 && parts[2] !== '0' ? `${parts[0]}.${parts[1]}.${parts[2]}` : `${parts[0]}.${parts[1]}`;
  }
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

async function neoforgeList(mc) {
  if (mc === '1.20.1') {
    const r = await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge');
    return (r.versions || []).filter((v) => v.startsWith('1.20.1-')).map((full) => ({
      version: full.slice('1.20.1-'.length), full, artifact: 'forge', stable: !/beta/i.test(full), recommended: false, latest: false,
    })).sort((a, b) => cmpVer(a.version, b.version));
  }
  let vers = [];
  try {
    const r = await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
    vers = r.versions || [];
  } catch (e) {
    // 回退到 BMCLAPI 的 NeoForge 列表
    const r = await getJson(`${mirrors.BMCL}/neoforge/list/${enc(mc)}`);
    vers = (r || []).map((x) => x.version || x.rawVersion).filter(Boolean);
  }
  const out = vers.filter((v) => neoMcVersion(v) === mc).map((full) => ({
    version: full, full, artifact: 'neoforge', stable: !/beta|alpha/i.test(full), recommended: false, latest: false,
  })).sort((a, b) => cmpVer(a.version, b.version));
  const firstStable = out.find((x) => x.stable);
  if (firstStable) firstStable.recommended = true;
  if (out[0]) out[0].latest = true;
  return out;
}

async function list(type, mc) {
  if (type === 'fabric' || type === 'quilt' || type === 'legacyfabric') return fabricLike(type, mc);
  if (type === 'forge') return forgeList(mc);
  if (type === 'neoforge') return neoforgeList(mc);
  throw new Error(`未知的加载器：${type}`);
}

// ───────────────────────── 安装 ─────────────────────────
async function installFabricLike(kind, mc, loader, name, task) {
  await versions.ensureVanilla(mc, task);
  task.update({ detail: `获取 ${{ fabric: 'Fabric', quilt: 'Quilt', legacyfabric: 'Legacy Fabric' }[kind]} 配置`, progress: -1 });
  const url = `${FABRIC_META[kind]}/versions/loader/${enc(mc)}/${enc(loader)}/profile/json`;
  const json = await getJson(mirrors.candidates(url));
  json.id = name;
  json.inheritsFrom = mc;
  delete json.jar;
  await writeJson(versions.versionJsonPath(name), json);
  await versions.completeVersion(name, task);
}

/** 运行一个 Java 进程并把输出转为任务详情 */
function runJava(javaPath, args, cwd, task) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    const tail = [];
    const onData = (text) => {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        tail.push(t);
        if (tail.length > 40) tail.shift();
        task.update({ detail: cutChars(t, 120, '…') });
      }
    };
    // 安装器不带 -Dfile.encoding，输出是系统编码
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = lineDecoder(onData);
      stream.on('data', (b) => decoder.write(b));
      stream.on('end', () => decoder.end());
    }
    const onAbort = () => { try { child.kill(); } catch { /* ignore */ } };
    task.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(new Error(`无法启动安装器：${e.message}`)));
    child.on('close', (code) => {
      task.signal.removeEventListener('abort', onAbort);
      if (task.signal.aborted) return reject(abortError());
      if (code === 0) resolve(tail);
      else {
        const hint = tail.slice(-6).join('\n');
        reject(new Error(`安装器退出（代码 ${code}）${hint ? `：\n${hint}` : ''}`));
      }
    });
  });
}

function libsToFiles(libs) {
  const out = [];
  for (const lib of libs || []) {
    const a = lib && lib.downloads && lib.downloads.artifact;
    if (!a || !a.url) continue;
    out.push({ urls: mirrors.candidates(a.url), path: path.join(versions.librariesDir(), a.path || mavenPath(lib.name)), sha1: a.sha1, size: a.size });
  }
  return out;
}

/**
 * 通过官方安装器安装 Forge / NeoForge
 * - 旧版（install_profile 含 versionInfo）：直接解析写入
 * - 新版：先用镜像预下载依赖库，再以 --installClient 无界面方式运行安装器执行处理器
 */
async function installWithInstaller(installer, mc, name, task, label) {
  const info = await withZip(installer, async (z) => {
    const profileText = await z.readText('install_profile.json');
    if (!profileText) throw new Error('安装器中没有 install_profile.json');
    const profile = JSON.parse(profileText);
    let versionJson = null;
    if (profile.json) {
      const t = await z.readText(profile.json.replace(/^\//, ''));
      if (t) versionJson = JSON.parse(t);
    }
    let universal = null;
    if (profile.versionInfo && profile.install && profile.install.filePath) {
      universal = await z.read(profile.install.filePath);
    }
    return { profile, versionJson, universal };
  });

  const { profile } = info;

  if (profile.versionInfo) {
    // 旧版安装器（1.12.2 及更早）
    const json = profile.versionInfo;
    json.id = name;
    if (!json.inheritsFrom) json.inheritsFrom = mc;
    if (!json.jar) json.jar = mc;
    for (const lib of json.libraries || []) {
      if (lib.url && /files\.minecraftforge\.net/.test(lib.url)) lib.url = 'https://maven.minecraftforge.net/';
    }
    if (info.universal && profile.install.path) {
      const dest = path.join(versions.librariesDir(), mavenPath(profile.install.path));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, info.universal);
    }
    await writeJson(versions.versionJsonPath(name), json);
    await versions.completeVersion(name, task);
    return;
  }

  // 新版安装器
  task.update({ detail: '预下载依赖库', progress: -1 });
  const files = [...libsToFiles(profile.libraries), ...libsToFiles(info.versionJson && info.versionJson.libraries)];
  await downloadAll(files, { task, label: `下载 ${label} 依赖` });

  await versions.ensureLauncherProfiles();
  const mcJson = await versions.resolveVersion(mc);
  const { java } = await javaMgr.resolveForVersion(versions.requiredJava(mcJson), {}, task);

  const createdId = profile.version || (info.versionJson && info.versionJson.id);
  if (!createdId) throw new Error('无法识别安装器生成的版本名称');
  const sameName = createdId.toLowerCase() === name.toLowerCase();
  // 安装器会覆盖同名版本：若用户已有同名版本，先临时移开
  const createdDir = versions.versionDir(createdId);
  const backup = `${createdDir}.aurora-bak`;
  const hadExisting = !sameName && (await exists(createdDir));
  if (hadExisting) await renameRetry(createdDir, backup);

  try {
    task.update({ detail: `运行 ${label} 安装器…`, progress: -1, speed: 0 });
    await runJava(java.path, ['-jar', installer, '--installClient', versions.gameRoot()], paths.cacheDir(), task);
    if (!(await exists(versions.versionJsonPath(createdId)))) {
      throw new Error('安装器已运行，但没有找到生成的版本文件');
    }
    if (createdId !== name) await versions.renameVersion(createdId, name);
  } catch (e) {
    if (hadExisting) await rmrf(createdDir).catch(() => {});
    throw e;
  } finally {
    if (hadExisting && !(await exists(createdDir))) await renameRetry(backup, createdDir).catch(() => {});
  }
  await versions.completeVersion(name, task);
}

async function downloadInstaller(url, file, task, label) {
  let sha1;
  try {
    const t = await getText(mirrors.candidates(`${url}.sha1`), { retries: 1, timeout: 8000 });
    if (/^[0-9a-f]{40}$/i.test(t.trim())) sha1 = t.trim();
  } catch { /* 可选 */ }
  await downloadFile({ urls: mirrors.candidates(url), path: file, sha1 }, { task, label: `下载 ${label} 安装器` });
}

async function installForge(mc, full, name, task) {
  await versions.ensureVanilla(mc, task);
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  const file = path.join(paths.cacheDir(), 'installers', `forge-${full}-installer.jar`);
  await downloadInstaller(url, file, task, 'Forge');
  await installWithInstaller(file, mc, name, task, 'Forge');
}

async function installNeoForge(mc, fullIn, name, task) {
  const full = mc === '1.20.1' && !String(fullIn).startsWith('1.20.1-') ? `1.20.1-${fullIn}` : fullIn;
  await versions.ensureVanilla(mc, task);
  const artifact = mc === '1.20.1' ? 'forge' : 'neoforge';
  const url = `https://maven.neoforged.net/releases/net/neoforged/${artifact}/${full}/${artifact}-${full}-installer.jar`;
  const file = path.join(paths.cacheDir(), 'installers', `neoforge-${full}-installer.jar`);
  await downloadInstaller(url, file, task, 'NeoForge');
  await installWithInstaller(file, mc, name, task, 'NeoForge');
}

/**
 * 安装一个版本（可附带加载器）
 * @param {{mc:string, name:string, loader?:{type:string, version:string, full?:string}, fabricApi?:boolean}} opts
 */
async function install(opts, task) {
  const { mc, loader } = opts;
  const name = (opts.name || mc).trim();
  versions.validateName(name);
  // 带加载器的配置不能和游戏版本同名：加载器的版本文件会盖掉原版、自己继承自己，进不了游戏
  if (loader && loader.type && name.toLowerCase() === String(mc).toLowerCase()) throw new Error(`带 ${loader.type} 的配置不能叫「${nm(name)}」：和游戏版本号重名了，换个名字（比如 ${nm(`${name}-${loader.type}`)}）`);
  if (await exists(versions.versionJsonPath(name))) throw new Error(`版本 ${nm(name)} 已存在`);
  try {
    if (!loader || !loader.type) {
      await versions.installVanilla(mc, name, task);
    } else if (loader.type === 'fabric' || loader.type === 'quilt' || loader.type === 'legacyfabric') {
      await installFabricLike(loader.type, mc, loader.version, name, task);
    } else if (loader.type === 'forge') {
      await installForge(mc, loader.full || `${mc}-${loader.version}`, name, task);
    } else if (loader.type === 'neoforge') {
      await installNeoForge(mc, loader.full || loader.version, name, task);
    } else {
      throw new Error(`不支持的加载器：${loader.type}`);
    }
  } catch (e) {
    if (e.cancelled && name !== mc) {
      const j = await readJson(versions.versionJsonPath(name));
      if (j) await versions.removeVersion(name).catch(() => {});
    }
    throw e;
  }
  return name;
}

/**
 * 生成一个加载器版本 JSON 但不新建配置（组件管理原地更换用），返回不含 id 的 JSON；
 * loader 为空时返回原版 JSON。Forge / NeoForge 要跑安装器，先装到临时版本再取出 JSON，临时版本随后删掉
 */
async function buildJson(mc, loader, task) {
  if (!loader || !loader.type) {
    const manifest = await versions.getManifest();
    const entry = manifest.versions.find((x) => x.id === mc);
    if (!entry) throw new Error(`官方版本列表中找不到 ${mc}`);
    task.update({ detail: `获取 ${mc} 版本信息`, progress: -1 });
    const json = await getJson(mirrors.candidates(entry.url));
    json.clientVersion = mc;
    return json;
  }
  if (loader.type === 'optifine') return require('./optifine').buildJson(mc, loader.entry, task);
  if (FABRIC_META[loader.type]) {
    await versions.ensureVanilla(mc, task);
    task.update({ detail: '获取加载器配置', progress: -1 });
    const json = await getJson(mirrors.candidates(`${FABRIC_META[loader.type]}/versions/loader/${enc(mc)}/${enc(loader.version)}/profile/json`));
    json.inheritsFrom = mc;
    delete json.jar;
    return json;
  }
  if (loader.type !== 'forge' && loader.type !== 'neoforge') throw new Error(`不支持的加载器：${loader.type}`);
  const tmp = `aurora-tmp-${Date.now().toString(36)}`;
  try {
    if (loader.type === 'forge') await installForge(mc, loader.full || `${mc}-${loader.version}`, tmp, task);
    else await installNeoForge(mc, loader.full || loader.version, tmp, task);
    const json = await readJson(versions.versionJsonPath(tmp));
    if (!json) throw new Error('安装器没有生成版本文件');
    delete json.id;
    return json;
  } finally {
    await rmrf(versions.versionDir(tmp)).catch(() => {});
  }
}

module.exports = { list, install, buildJson, runJava, neoMcVersion };
