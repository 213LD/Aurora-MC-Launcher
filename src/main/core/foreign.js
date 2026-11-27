'use strict';
/**
 * 从其他启动器导入（一键迁移第二、三步，2.0.0-pre10）。认两种结构：
 * - .minecraft 结构（官方启动器、HMCL、PCL2、别的启动器）：versions/<id>/<id>.json、libraries、saves……
 *   这个配置的游戏目录在哪：HMCL 看 hmclversion.cfg，PCL2 看 PCL/Setup.ini，都没写就看版本文件夹里有没有存档、Mod
 * - MultiMC / Prism：instances/<名字>/{instance.cfg, mmc-pack.json, .minecraft 或 minecraft}。没有版本文件，按 mmc-pack.json 重新安装
 * 每个配置三种方式：copy 复制（默认）、link 引用原目录（两个启动器共用一份，customGameDir）、saves 只导存档。
 * **原来的文件夹只读**：一个文件都不改、不删。复制进来的走 migrate.apply，改名、前置版本、补全都和导入 Aurora 数据一样。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const config = require('../engine/config');
const paths = require('../engine/paths');
const location = require('../engine/location');
const { exists, mavenPath, renameRetry } = require('../engine/util');
const { safeName } = require('../../shared/pathrules');
const { nm } = require('../../shared/i18n');
const versions = require('./versions');
const profiles = require('./profiles');
const migrate = require('./migrate');

const CONTENT = ['saves', 'mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt', 'servers.dat', 'screenshots'];
const SKIP_TOP = /^(natives(-[\w-]+)?|.*-natives(-\d+)?|logs|crash-reports|\.mixin\.out|\.fabric|\.cache|debug|PCL|\.hmcl|hmclversion\.cfg|instance-game-settings\.json|usercache\.json|usernamecache\.json|launcher_profiles\.json)$/i;
const LOADER_UIDS = { 'net.fabricmc.fabric-loader': 'fabric', 'org.quiltmc.quilt-loader': 'quilt', 'net.minecraftforge': 'forge', 'net.neoforged': 'neoforge' };

const readJson = async (p) => { try { return JSON.parse((await fsp.readFile(p, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } };
const readText = (p) => fsp.readFile(p, 'utf8').catch(() => '');
const isDir = async (p) => { const st = await fsp.stat(p).catch(() => null); return !!(st && st.isDirectory()); };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 这个文件夹是哪种结构 */
async function detect(dir) {
  if ((await exists(path.join(dir, 'mmc-pack.json'))) || (await exists(path.join(dir, 'instance.cfg')))) return { kind: 'mmc-one', dir };
  if (await isDir(path.join(dir, 'instances'))) return { kind: 'mmc', dir: path.join(dir, 'instances') };
  for (const c of [dir, path.join(dir, '.minecraft'), path.join(dir, 'minecraft')]) {
    if (await isDir(path.join(c, 'versions'))) return { kind: 'game', dir: c };
    if (await isDir(path.join(c, 'saves'))) return { kind: 'game', dir: c };
  }
  return null;
}

async function launcherName(gameDir) {
  const parent = path.dirname(gameDir);
  const near = await fsp.readdir(parent).catch(() => []);
  const vers = await fsp.readdir(path.join(gameDir, 'versions')).catch(() => []);
  const inVer = async (rel) => { for (const v of vers.slice(0, 40)) if (await exists(path.join(gameDir, 'versions', v, rel))) return true; return false; };
  if ((await exists(path.join(gameDir, 'PCL'))) || near.some((n) => /^(plain craft launcher|pcl).*\.exe$/i.test(n)) || (await inVer('PCL'))) return 'PCL2';
  if (near.some((n) => /^hmcl.*\.(exe|jar)$/i.test(n) || n === '.hmcl') || (await inVer('hmclversion.cfg')) || (await inVer('instance-game-settings.json')) || (await inVer('.hmcl'))) return 'HMCL';
  if (await exists(path.join(gameDir, 'launcher_profiles.json'))) return '官方启动器';
  return '其他启动器';
}

const worldsIn = async (gameDir) => {
  const out = [];
  for (const n of await fsp.readdir(path.join(gameDir, 'saves')).catch(() => [])) if (await exists(path.join(gameDir, 'saves', n, 'level.dat'))) out.push(n);
  return out;
};
const modsIn = async (gameDir) => (await fsp.readdir(path.join(gameDir, 'mods')).catch(() => [])).filter((n) => /\.jar(\.disabled)?$/i.test(n)).length;

/** HMCL 3.16 全局预设里的游戏工作目录（没写就是 null，表示根目录） */
async function hmclGlobalRun(root) {
  const conf = path.join(path.dirname(root), '.hmcl', 'config');
  const ls = await readJson(path.join(conf, 'launcher-settings.json'));
  const gs = await readJson(path.join(conf, 'game-settings.json'));
  const presets = gs && Array.isArray(gs.presets) ? gs.presets : [];
  const p = presets.find((x) => x && ls && x.id === ls.defaultGameSettingsPreset) || presets[0];
  return p && typeof p.runningDirectory === 'string' && p.runningDirectory.trim() ? p.runningDirectory.trim() : null;
}

/** HMCL 3.16 记的游戏目录：用户级的 user-game-directories.json（绝对路径）和便携的 game-directories.json（相对 HMCL 文件夹） */
async function hmclDirs(app) {
  const out = [];
  const take = (file, base) => readJson(file).then((j) => {
    for (const d of (j && Array.isArray(j.directories) ? j.directories : [])) {
      if (d && typeof d.path === 'string' && d.path) out.push(path.isAbsolute(d.path) ? d.path : path.resolve(base, d.path));
    }
  });
  await take(path.join(app, '.hmcl', 'config', 'user-game-directories.json'), path.join(app, '.hmcl'));
  await take(path.join(os.homedir(), '.hmcl', 'config', 'user-game-directories.json'), path.join(os.homedir(), '.hmcl'));
  return out;
}

/** 配置的游戏目录：启动器记了就按记的，没记就看版本文件夹里有没有内容 */
async function gameDirOf(root, id) {
  const vdir = path.join(root, 'versions', id);
  // HMCL 3.16 起（2026-11-07 用真的 HMCL 3.16.4 试出来的）：versions/<id>/.hmcl/config/instance-game-settings.json。
  // 开了「实例隔离」时 overrideProperties 里有 runningDirectory：值是空的就是版本文件夹，有路径就是自定义目录；
  // 没开就跟全局设置（HMCL 文件夹里 .hmcl/config/game-settings.json 的预设），全局也没写就是根目录
  const hm3 = await readJson(path.join(vdir, '.hmcl', 'config', 'instance-game-settings.json'));
  if (hm3 && Array.isArray(hm3.overrideProperties)) {
    let run;
    if (hm3.overrideProperties.includes('runningDirectory')) run = typeof hm3.runningDirectory === 'string' && hm3.runningDirectory.trim() ? hm3.runningDirectory.trim() : vdir;
    else run = await hmclGlobalRun(root);
    if (run && run !== vdir) {
      const abs = path.isAbsolute(run) ? run : path.resolve(path.dirname(root), run);
      return (await isDir(abs)) ? abs : root;
    }
    return run || root;
  }
  // HMCL 老版本：hmclversion.cfg 写序号，中间几版 instance-game-settings.json 写名字（对照过 HMCL 源码的 GameDirectoryType）
  const hm = await readJson(path.join(vdir, 'hmclversion.cfg')) || await readJson(path.join(vdir, 'instance-game-settings.json')) || await readJson(path.join(vdir, '.hmcl', 'instance-game-settings.json'));
  const type = hm ? hm.gameDirType : undefined;
  if ((type === 2 || type === 'CUSTOM') && typeof hm.gameDir === 'string' && path.isAbsolute(hm.gameDir) && (await isDir(hm.gameDir))) return hm.gameDir;
  if (type === 1 || type === 'VERSION_FOLDER') return vdir;
  if (type === 0 || type === 'ROOT_FOLDER') return root;
  // PCL2：VersionArgumentIndieV2 是真假，老的 VersionArgumentIndie 是 -1（没设）、0、1（对照过 PCL 源码）
  const ini = await readText(path.join(vdir, 'PCL', 'Setup.ini'));
  const v2 = /^VersionArgumentIndieV2\s*[:=]\s*(\S+)/im.exec(ini);
  if (v2) return /^true$/i.test(v2[1]) ? vdir : root;
  const v1 = /^VersionArgumentIndie\s*[:=]\s*(-?\d+)/im.exec(ini);
  if (v1 && v1[1] !== '-1') return v1[1] === '1' ? vdir : root;
  for (const c of CONTENT) if (await exists(path.join(vdir, c))) return vdir;
  return root;
}

async function gameInstances(root) {
  const raw = [];
  for (const d of await fsp.readdir(path.join(root, 'versions'), { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const json = await readJson(path.join(root, 'versions', d.name, `${d.name}.json`));
    if (json && typeof json === 'object') raw.push({ id: d.name, json });
  }
  const byId = new Map(raw.map((p) => [p.id, p]));
  const out = [];
  for (const { id, json } of raw) {
    const chain = [id];
    let j = json;
    while (j && j.inheritsFrom && chain.length < 8 && !chain.includes(j.inheritsFrom)) {
      chain.push(j.inheritsFrom);
      j = byId.has(j.inheritsFrom) ? byId.get(j.inheritsFrom).json : null;
    }
    const rootJson = byId.has(chain[chain.length - 1]) ? byId.get(chain[chain.length - 1]).json : null;
    const loader = versions.detectLoader(json);
    const gameDir = await gameDirOf(root, id);
    out.push({
      key: id, id, name: id, kind: 'game', chain, json,
      mc: json.clientVersion || (rootJson ? rootJson.clientVersion || rootJson.id : chain[chain.length - 1]) || '',
      loader: loader ? { type: loader.type, version: loader.version } : null,
      // 自定义目录（HMCL 可以给配置单独指定一个文件夹）：这边当独立配置，内容从那个文件夹带
      gameDir, isolated: !samePath(gameDir, root), custom: !samePath(gameDir, root) && !samePath(gameDir, path.join(root, 'versions', id)),
    });
  }
  return out;
}

async function mmcInstance(dir) {
  const pack = await readJson(path.join(dir, 'mmc-pack.json'));
  const cfg = await readText(path.join(dir, 'instance.cfg'));
  const ini = (k) => { const m = new RegExp(`^${k}=(.*)$`, 'm').exec(cfg); return m ? m[1].trim() : ''; };
  if (!pack || !Array.isArray(pack.components)) return null;
  let mc = '';
  let loader = null;
  for (const c of pack.components) {
    if (!c || typeof c.uid !== 'string') continue;
    if (c.uid === 'net.minecraft') mc = String(c.version || c.cachedVersion || '');
    if (LOADER_UIDS[c.uid]) loader = { type: LOADER_UIDS[c.uid], version: String(c.version || c.cachedVersion || '') };
  }
  if (!mc) return null;
  // 老的 MultiMC 实例里 Forge 的版本号写成「1.12.2-14.23.5.2860」（带着游戏版本）：去掉前面的游戏版本，装的时候才拼得对
  if (loader && loader.type === 'forge' && loader.version.startsWith(`${mc}-`)) loader.version = loader.version.slice(mc.length + 1);
  let gameDir = path.join(dir, '.minecraft');
  if (!(await isDir(gameDir)) && (await isDir(path.join(dir, 'minecraft')))) gameDir = path.join(dir, 'minecraft');
  const name = ini('name') || path.basename(dir);
  let id = safeName(name, { max: 60, fallback: path.basename(dir) });
  // 实例名正好是游戏版本号（Prism 默认就这样起名）又带加载器：加载器的版本文件会盖掉同名的原版、自己继承自己，进不了游戏（2026-11-07 用真的 Prism 试出来的）
  if (loader && id.toLowerCase() === mc.toLowerCase()) id = `${id}-${{ fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[loader.type] || loader.type}`;
  return { key: path.basename(dir), id, name, kind: 'mmc', instanceDir: dir, mc, loader, gameDir, isolated: true, chain: [], jvmArgs: ini('OverrideJavaArgs') === 'true' ? ini('JvmArgs') : '' };
}

async function mmcInstances(instancesDir) {
  const out = [];
  for (const d of await fsp.readdir(instancesDir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === '_MMC_TEMP') continue;
    const it = await mmcInstance(path.join(instancesDir, d.name));
    if (it) out.push(it);
  }
  return out;
}

/** 列出这个文件夹里能导入的配置 */
async function instancesOf(found) {
  if (found.kind === 'mmc-one') { const it = await mmcInstance(found.dir); return it ? [it] : []; }
  if (found.kind === 'mmc') return mmcInstances(found.dir);
  const list = await gameInstances(found.dir);
  // 公共目录里的世界：没有版本文件时也能只导存档
  if (!list.length && (await worldsIn(found.dir)).length) list.push({ key: '@root', id: '', name: '这个文件夹里的存档', kind: 'game', chain: [], mc: '', loader: null, gameDir: found.dir, isolated: false, savesOnly: true });
  return list;
}

/** 检查一个文件夹，给界面列出来 */
async function inspect(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('请选择一个文件夹');
  if (!(await isDir(dir))) throw new Error('这个文件夹不存在');
  const found = await detect(dir);
  if (!found) return { ok: false, problems: [{ level: 'block', text: '这个文件夹里没有认识的游戏数据。选 .minecraft 文件夹（里面有 versions），或者 Prism / MultiMC 的 instances 文件夹' }] };
  const root = versions.gameRoot();
  if (found.kind === 'game' && samePath(found.dir, root)) return { ok: false, problems: [{ level: 'block', text: '这就是启动器现在正在用的游戏目录' }] };
  const list = await instancesOf(found);
  if (!list.length) return { ok: false, problems: [{ level: 'block', text: '这里面没有找到游戏配置或存档' }] };
  const taken = new Set((await fsp.readdir(versions.versionsDir()).catch(() => [])).map((s) => s.toLowerCase()));
  const items = [];
  for (const it of list) {
    const size = await location.dirSize(it.isolated ? it.gameDir : path.join(found.kind === 'game' ? found.dir : it.gameDir, 'versions', it.id), 1500).catch(() => ({ bytes: 0, partial: true }));
    items.push({
      key: it.key, name: it.name, mc: it.mc, loader: it.loader, isolated: it.isolated, gameDir: it.gameDir, savesOnly: !!it.savesOnly,
      worlds: (await worldsIn(it.gameDir)).length, mods: await modsIn(it.gameDir), size: size.bytes, partial: !!size.partial,
      exists: !!it.id && taken.has(it.id.toLowerCase()), needsDownload: it.kind === 'mmc',
    });
  }
  const st = await fsp.statfs(root).catch(() => null);
  return {
    ok: true, problems: [],
    source: { dir: found.dir, kind: found.kind === 'game' ? 'game' : 'mmc', launcher: found.kind === 'game' ? await launcherName(found.dir) : 'Prism / MultiMC' },
    instances: items, free: st ? st.bavail * st.bsize : null,
  };
}

// ───────────────────────── 找 ─────────────────────────
/** 常见位置找一遍。只看名字，很快。找不到的玩家自己选文件夹 */
async function scan() {
  const out = [];
  const seen = new Set([path.resolve(versions.gameRoot()).toLowerCase()]);
  const add = async (dir, label) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    const found = await detect(dir).catch(() => null);
    if (!found) return;
    const rkey = path.resolve(found.dir).toLowerCase();
    if (seen.has(rkey)) return;
    seen.add(key);
    seen.add(rkey);
    const list = await instancesOf(found).catch(() => []);
    if (!list.length) return;
    out.push({ dir: found.dir, label: label || (found.kind === 'game' ? await launcherName(found.dir) : 'Prism / MultiMC'), count: list.length, kind: found.kind });
  };
  const app = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  await add(paths.systemGameDir(), '官方启动器');
  for (const n of ['PrismLauncher', 'MultiMC', 'PolyMC']) await add(path.join(app, n));
  const hmcl = await readJson(path.join(os.homedir(), '.hmcl', 'config.json')) || await readJson(path.join(app, '.hmcl', 'config.json'));
  const hmclDir = hmcl && hmcl.configurations && Object.values(hmcl.configurations).map((c) => c && c.gameDir).find((d) => typeof d === 'string' && path.isAbsolute(d));
  if (hmclDir) await add(hmclDir, 'HMCL');
  for (const d of await hmclDirs(app)) await add(d);
  // 常见的存放位置，往下看一层
  const roots = [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Games')];
  for (const letter of 'CDEFGH') {
    if (fs.existsSync(`${letter}:\\`)) roots.push(`${letter}:\\`, `${letter}:\\Games`, `${letter}:\\Minecraft`);
  }
  const SKIP = /^(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information|recovery|perflogs|users|appdata|node_modules)$/i;
  const until = Date.now() + 2500;
  for (const r of roots) {
    if (Date.now() > until) break;
    for (const d of await fsp.readdir(r, { withFileTypes: true }).catch(() => [])) {
      if (Date.now() > until) break;
      if (!d.isDirectory() || SKIP.test(d.name)) continue;
      if (d.name === '.minecraft' || (await exists(path.join(r, d.name, '.minecraft'))) || (await exists(path.join(r, d.name, 'versions'))) || (await exists(path.join(r, d.name, 'instances')))) await add(path.join(r, d.name));
    }
  }
  return out;
}

// ───────────────────────── 导入 ─────────────────────────
const fileEntry = (rel, file) => ({
  rel, size: 0, file,
  read: () => fsp.readFile(file),
  copy: (dest) => fsp.copyFile(file, dest),
});

/** 版本文件要用的库：有就带上，省得重新下载。没有的之后 completeVersion 下载 */
async function libraryEntries(root, json, seen, out) {
  const add = async (rel) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    const file = path.join(root, 'libraries', ...rel.split('/'));
    if (await exists(file)) out.push(fileEntry(`game/libraries/${rel}`, file));
  };
  for (const lib of Array.isArray(json.libraries) ? json.libraries : []) {
    if (!lib || typeof lib.name !== 'string') continue;
    const d = lib.downloads || {};
    let rel = d.artifact && d.artifact.path;
    if (!rel) { try { rel = mavenPath(lib.name); } catch { rel = null; } }
    await add(rel);
    for (const c of Object.values(d.classifiers || {})) if (c && c.path) await add(c.path);
  }
  for (const dir of migrate.generatedDirs(json)) {
    const list = [];
    await migrate.walk(path.join(root, 'libraries', ...dir.split('/')), dir, list);
    for (const f of list) if (!seen.has(f.rel)) { seen.add(f.rel); out.push(fileEntry(`game/libraries/${f.rel}`, f.file)); }
  }
}

/** 声音、材质这些资源：原来的文件夹里有就复制过来，几百 MB 不用重新下载。没有的之后补全时下载 */
async function assetEntries(root, indexId, seen, out) {
  if (typeof indexId !== 'string' || !/^[\w.-]+$/.test(indexId) || seen.has(`index:${indexId}`)) return;
  seen.add(`index:${indexId}`);
  const file = path.join(root, 'assets', 'indexes', `${indexId}.json`);
  const index = await readJson(file);
  if (!index || !index.objects || typeof index.objects !== 'object') return;
  out.push(fileEntry(`game/assets/indexes/${indexId}.json`, file));
  for (const o of Object.values(index.objects)) {
    if (!o || !/^[0-9a-f]{40}$/i.test(o.hash) || seen.has(o.hash)) continue;
    seen.add(o.hash);
    const rel = `objects/${o.hash.slice(0, 2)}/${o.hash}`;
    const obj = path.join(root, 'assets', 'objects', o.hash.slice(0, 2), o.hash);
    if (await exists(obj)) out.push(fileEntry(`game/assets/${rel}`, obj));
  }
}

async function dirEntries(dir, prefix, out, skip) {
  const list = [];
  await migrate.walk(dir, '', list, skip);
  for (const f of list) out.push(fileEntry(`${prefix}/${f.rel}`, f.file));
}

/** 世界放进公共目录。两个配置有同名世界时后面的改个名，不然会并成一个 */
async function worldEntries(it, used, out) {
  for (const w of await worldsIn(it.gameDir)) {
    let name = w;
    for (let k = 1; used.has(name.toLowerCase()); k++) name = k === 1 ? `${w} (${safeName(it.name, { max: 30 })})` : `${w} (${safeName(it.name, { max: 30 })} ${k})`;
    used.add(name.toLowerCase());
    await dirEntries(path.join(it.gameDir, 'saves', w), `game/root/saves/${name}`, out);
  }
}

const uniqueId = (base, taken) => {
  let n = base;
  for (let k = 2; taken.has(n.toLowerCase()); k++) n = `${base} (${k})`;
  taken.add(n.toLowerCase());
  return n;
};

/**
 * 导入。input：{ dir }；choices.picks：{ key: 'copy' | 'link' | 'saves' }，没写的不导入。
 * 返回 { imported: [{ from, id, mode }], worlds, pending, failedFiles }
 */
async function importForeign(input, choices, task) {
  const found = await detect(input.dir);
  if (!found) throw new Error('这个文件夹里没有认识的游戏数据');
  if (found.kind === 'game' && samePath(found.dir, versions.gameRoot())) throw new Error('这就是启动器现在正在用的游戏目录');
  const picks = (choices && choices.picks) || {};
  const list = (await instancesOf(found)).filter((it) => ['copy', 'link', 'saves'].includes(picks[it.key]) && (!it.savesOnly || picks[it.key] === 'saves'));
  if (!list.length) throw new Error('没有选要导入的内容');
  const launcher = found.kind === 'game' ? await launcherName(found.dir) : 'Prism / MultiMC';
  const result = { imported: [], worlds: [], pending: [], failedFiles: [], savedWorlds: 0 };
  const entries = [];
  const manifest = { profiles: [], versionSettings: {} };
  const libs = new Set();
  const assets = new Set();
  const usedWorlds = new Set();
  let rootCopied = false;
  const verSeen = new Set();
  task.update({ detail: '整理要复制的文件…', progress: -1 });
  for (const it of list) {
    const mode = picks[it.key];
    if (mode === 'saves') {
      const before = entries.length;
      await worldEntries(it, usedWorlds, entries);
      if (entries.length > before) result.savedWorlds += (await worldsIn(it.gameDir)).length;
      continue;
    }
    if (it.kind !== 'game') continue; // MultiMC / Prism 下面单独做
    manifest.profiles.push({ id: it.id, chain: it.chain, mc: it.mc, loader: it.loader, isolated: mode === 'copy' ? it.isolated : false, size: 0 });
    for (const vid of it.chain) {
      const vdir = path.join(found.dir, 'versions', vid);
      if (!(await isDir(vdir))) continue;
      if (vid === it.id && mode === 'copy' && it.isolated && !it.custom) {
        await dirEntries(vdir, `game/versions/${vid}`, entries, (rel) => SKIP_TOP.test(rel.split('/')[0]));
      } else if (vid === it.id && mode === 'copy' && it.custom) {
        for (const f of [`${vid}.json`, `${vid}.jar`]) if (await exists(path.join(vdir, f))) entries.push(fileEntry(`game/versions/${vid}/${f}`, path.join(vdir, f)));
        await dirEntries(it.gameDir, `game/versions/${vid}`, entries, (rel) => SKIP_TOP.test(rel.split('/')[0]) || /^versions$|^libraries$|^assets$/i.test(rel.split('/')[0]));
      } else if (!verSeen.has(vid)) {
        // 只要版本文件和 jar：前置版本、共用目录的配置、引用原目录的配置
        for (const f of [`${vid}.json`, `${vid}.jar`]) if (await exists(path.join(vdir, f))) entries.push(fileEntry(`game/versions/${vid}/${f}`, path.join(vdir, f)));
      }
      verSeen.add(vid);
      const j = await readJson(path.join(vdir, `${vid}.json`));
      if (j) await libraryEntries(found.dir, j, libs, entries);
      if (j && j.assetIndex) await assetEntries(found.dir, j.assetIndex.id, assets, entries);
      const logFile = j && j.logging && j.logging.client && j.logging.client.file && j.logging.client.file.id;
      if (typeof logFile === 'string' && /^[\w.-]+$/.test(logFile) && !assets.has(`log:${logFile}`) && (await exists(path.join(found.dir, 'assets', 'log_configs', logFile)))) {
        assets.add(`log:${logFile}`);
        entries.push(fileEntry(`game/assets/log_configs/${logFile}`, path.join(found.dir, 'assets', 'log_configs', logFile)));
      }
    }
    // 共用公共目录的配置：内容只带一次，放进这边的公共目录，同名的不盖（世界改名）
    if (mode === 'copy' && !it.isolated && !rootCopied) {
      rootCopied = true;
      for (const c of CONTENT) {
        const p = path.join(found.dir, c);
        const st = await fsp.stat(p).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) await dirEntries(p, `game/root/${c}`, entries);
        else entries.push(fileEntry(`game/root/${c}`, p));
      }
    }
  }
  for (const e of entries) {
    const st = await fsp.stat(e.file).catch(() => null);
    e.size = st ? st.size : 0;
  }
  if (entries.length || manifest.profiles.length) {
    const r = await migrate.apply(manifest, entries, { settings: false, accounts: false, skins: false, plans: false, profiles: {} }, task);
    result.worlds.push(...r.worlds);
    result.pending.push(...r.pending);
    result.failedFiles.push(...r.failedFiles);
    for (const m of r.imported) {
      const it = list.find((x) => x.id === m.from);
      if (!it) continue;
      const mode = picks[it.key];
      if (mode === 'link') config.setVersionSettings(m.id, { customGameDir: path.resolve(it.gameDir) });
      await profiles.writeMeta(m.id, { type: it.loader ? 'custom' : 'vanilla', importedFrom: { at: Date.now(), launcher, mode } }).catch(() => {});
      result.imported.push({ from: it.name, id: m.id, mode });
    }
  }
  // MultiMC / Prism：没有版本文件，先按记录装好，再把内容放进来
  const taken = new Set((await fsp.readdir(versions.versionsDir()).catch(() => [])).map((s) => s.toLowerCase()));
  for (const it of list) {
    const mode = picks[it.key];
    if (it.kind !== 'mmc' || mode === 'saves') continue;
    const id = uniqueId(it.id, taken);
    task.update({ detail: `安装 ${nm(it.name)} 的 ${it.loader ? it.loader.type : 'Minecraft'} ${it.mc}…`, progress: -1 });
    // 装到一半、复制到一半失败或取消：这个配置是这次新建的（uniqueId），整个删掉，不留半个配置在列表里
    const cleanup = () => versions.removeVersion(id, { permanent: true }).catch((err) => console.warn(`[foreign] 清理 ${id} 失败`, err.message));
    try {
      await require('./loaders').install({ mc: it.mc, name: id, loader: it.loader }, task);
    } catch (e) {
      await cleanup();
      if (e.cancelled) throw e;
      result.pending.push({ id: it.name, error: e.message, notInstalled: true });
      continue;
    }
    try {
      if (mode === 'link') {
        config.setVersionSettings(id, { customGameDir: path.resolve(it.gameDir) });
      } else {
        config.setVersionSettings(id, { isolation: 'on' });
        const list2 = [];
        await migrate.walk(it.gameDir, '', list2, (rel) => SKIP_TOP.test(rel.split('/')[0]));
        let n = 0;
        for (const f of list2) {
          if (task.signal.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
          const dest = path.join(versions.versionDir(id), ...f.rel.split('/'));
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          const part = `${dest}.aurora-tmp`;
          await fsp.copyFile(f.file, part);
          await renameRetry(part, dest);
          if (++n % 50 === 0) task.update({ detail: `复制 ${nm(it.name)}（${n}/${list2.length}）`, progress: n / list2.length });
        }
      }
    } catch (e) {
      await cleanup();
      if (e.cancelled) throw e;
      result.pending.push({ id: it.name, error: e.message, notInstalled: true });
      continue;
    }
    if (it.jvmArgs) config.setVersionSettings(id, { jvmArgs: it.jvmArgs });
    await profiles.writeMeta(id, { type: it.loader ? 'custom' : 'vanilla', name: it.name === id ? undefined : it.name, importedFrom: { at: Date.now(), launcher, mode } }).catch(() => {});
    result.imported.push({ from: it.name, id, mode });
  }
  await config.flush();
  return result;
}

module.exports = { scan, inspect, importForeign, detect };
