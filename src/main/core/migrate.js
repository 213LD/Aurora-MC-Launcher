'use strict';
/**
 * 一键迁移 · 第一步（1.5.3）：Aurora 自己的数据导出成一个包，或者从导出包 / 另一套 Aurora 数据导入。
 * 规则：
 * - 导出可勾选：哪些游戏配置、存档（默认带）、截图 / 日志（默认不带）、游戏本体和运行库（默认不带，带上可以离线恢复）、
 *   启动器设置、皮肤收藏、账户（只有名字和皮肤，登录令牌不导出）、Mod 配置器清单；声音材质资源一律不带，导入后自动补全
 * - 文件外壳用 envelope.js：格式版本更新 → 不能导入；只是启动器版本更新 → 警告；清单里每个文件记大小和 CRC，
 *   对不上（缺文件、被改、损坏）要玩家确认后才导入，解压时再逐个核对 CRC
 * - 同名配置逐个选：改名导入（默认）/ 覆盖（先把原来的整个移到 数据目录/backups/replaced）/ 跳过
 * - 启动器设置可勾选（首次启动默认覆盖，平时默认不覆盖）；数据位置、游戏目录、Java 路径这类只在原电脑有效的不导入
 *
 * 导出包结构（.aurorapack，就是 zip）：
 *   game/versions/<id>/…   版本 JSON、配置档案、独立的游戏内容（mods、config、存档…）；不带运行库时没有 <id>.jar
 *   game/root/…            共享游戏目录里的内容（没开隔离的配置用的）
 *   game/libraries/…       运行库（勾了「游戏本体和运行库」才有）
 *   launcher/…             config.json（去掉本机路径）、accounts.json（去掉令牌）、plans.json、skins/、background.*
 *   aurora-export.json     外壳 + 清单（最后写）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../engine/config');
const paths = require('../engine/paths');
const versions = require('./versions');
const envelope = require('../engine/envelope');
const { ZipWriter, ZipReader } = require('../engine/zip');
const { exists, writeJson, rmrf, renameRetry } = require('../engine/util');
const fileops = require('../engine/fileops');
const { safeName } = require('../../shared/pathrules');
const store = require('../engine/jsonstore');
const { nm } = require('../../shared/i18n');

const KIND = 'aurora-data';
const EXT = 'aurorapack';
const MANIFEST = 'aurora-export.json';
const DEFAULT_OPTS = { saves: true, screenshots: false, logs: false, runtime: false, settings: true, skins: true, accounts: true, plans: true };
// 从另一套 Aurora 数据（文件夹）导入：本机文件直接复制，运行库、截图都带上比重新下载快
const FOLDER_OPTS = { saves: true, screenshots: true, logs: false, runtime: true, settings: true, skins: true, accounts: true, plans: true };

// 只在原电脑有效、或者不该带走的设置
const LOCAL_KEYS = ['gameDir', 'cleanupDefaultData', 'setupDone', 'disclaimerAccepted', 'pendingJava', 'versionSettings', 'clientToken', 'msClientId', 'mcmod', 'configVersion', 'migrateAsk', 'selectedVersion'];
// 版本目录里不导出的：解压出来的 natives、组件管理的撤销快照、各种缓存
const CACHE_TOP = /^(natives(-[\w-]+)?|.*-natives(-\d+)?|\.aurora-components|\.fabric|\.mixin\.out|\.cache|debug|.*\.aurora-tmp)$/i;
const ROOT_ITEMS = ['options.txt', 'servers.dat', 'resourcepacks', 'shaderpacks', 'mods', 'config'];

const cancelled = () => Object.assign(new Error('已取消'), { cancelled: true });
const posix = (p) => p.split(path.sep).join('/');
// 导入包里的相对路径：统一按 safeJoin 的规则判断（2.0.0-pre2：以前只按 / 切开判断 ..，反斜杠能跑出去）
const isSafeRel = (rel) => { try { fileops.safeJoin('C:\\x', rel); return true; } catch { return false; } };

async function readJsonSafe(p) {
  try { return JSON.parse((await fsp.readFile(p, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

function validId(id) {
  if (typeof id !== 'string' || !id) return false;
  try { versions.validateName(id); return true; } catch { return false; }
}

function sanitizeConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  for (const k of LOCAL_KEYS) delete c[k];
  if (c.curseforge) delete c.curseforge.apiKey;
  if (c.java && c.java.selected && c.java.selected !== 'auto') c.java.selected = 'auto'; // Java 路径只在原电脑有效
  if (c.background) delete c.background.image; // 背景图片单独打包
  return c;
}

/** 单个配置的设置：指定的 Java 路径不带 */
function sanitizeVs(vs) {
  const v = JSON.parse(JSON.stringify(vs || {}));
  if (v.java && !['auto', 'global'].includes(v.java)) delete v.java;
  delete v.customGameDir; // 引用别的启动器的文件夹：路径只在这台电脑有效
  return v;
}

// ───────────────────────── 数据来源 ─────────────────────────
function currentSource() {
  return { kind: 'current', dataDir: paths.dataDir(), gameDir: config.get().gameDir, cfg: config.get() };
}

/** 选的文件夹可能是数据目录本身（有 config.json）、它的上一层（launcher/config.json，便携 / 自定义位置）或者有 AuroraData 的文件夹 */
function folderSource(dir) {
  const dataDir = [dir, path.join(dir, 'launcher'), path.join(dir, 'AuroraData', 'launcher')].find((d) => fs.existsSync(path.join(d, 'config.json')));
  if (!dataDir) throw new Error('这个文件夹里没有 Aurora 的数据（找不到 config.json）');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('这套数据的 config.json 已损坏，读不出来'); }
  const base = path.basename(dataDir).toLowerCase() === 'launcher' ? path.dirname(dataDir) : null;
  if (base) cfg = require('../engine/location').unpack(cfg, base);
  const gameDir = cfg.gameDir && path.isAbsolute(cfg.gameDir) ? cfg.gameDir : base ? path.join(base, '.minecraft') : paths.systemGameDir();
  return { kind: 'folder', dataDir, gameDir, cfg };
}

/** 来源里的全部游戏配置：继承链、Minecraft 版本、加载器、是不是独立游戏目录（和 versions.gameDirFor 同样的规则，用来源自己的设置） */
async function profilesOf(src) {
  const vroot = path.join(src.gameDir, 'versions');
  const raw = [];
  for (const d of await fsp.readdir(vroot, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const json = await readJsonSafe(path.join(vroot, d.name, `${d.name}.json`));
    if (json) raw.push({ id: d.name, json });
  }
  const byId = new Map(raw.map((p) => [p.id, p]));
  return raw.map(({ id, json }) => {
    const chain = [id];
    let j = json;
    while (j && j.inheritsFrom && chain.length < 8 && !chain.includes(j.inheritsFrom)) {
      chain.push(j.inheritsFrom);
      j = byId.has(j.inheritsFrom) ? byId.get(j.inheritsFrom).json : null;
    }
    const rootJson = byId.has(chain[chain.length - 1]) ? byId.get(chain[chain.length - 1]).json : null;
    const mc = json.clientVersion || (rootJson ? rootJson.clientVersion || rootJson.id : chain[chain.length - 1]);
    const loader = versions.detectLoader(json);
    const vs = (src.cfg.versionSettings || {})[id] || {};
    const mode = vs.isolation && vs.isolation !== 'global' ? vs.isolation : src.cfg.isolation || 'modded';
    const isolated = mode === 'all' || mode === 'on' || (mode === 'modded' && (!!loader || (!!json.type && json.type !== 'release')));
    return { id, json, chain, mc, loader: loader ? { type: loader.type, version: loader.version } : null, isolated };
  });
}

/** 递归列出文件；目录联接 / 符号链接（共享存档）不跟进去 */
async function walk(dir, rel, out, skip) {
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    if (d.isSymbolicLink()) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (skip && skip(r, d)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) await walk(full, r, out, skip);
    else if (d.isFile() && !/session\.lock$/i.test(d.name)) out.push({ rel: r, file: full });
  }
}

/**
 * Forge / NeoForge 安装程序生成的文件（补丁过的 client jar 等）不写在版本 JSON 的库里，启动时按 --fml.* 参数去运行库目录里找。
 * 返回这些文件所在的目录（相对运行库目录），带运行库导出时整个带上，导入时缺了就重新跑安装程序
 */
function generatedDirs(json) {
  const args = [...((json.arguments && json.arguments.game) || []), ...String(json.minecraftArguments || '').split(' ')].filter((x) => typeof x === 'string');
  const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const mc = arg('--fml.mcVersion');
  const out = [];
  const forge = arg('--fml.forgeVersion');
  const neo = arg('--fml.neoForgeVersion');
  // 1.19 以后的 Forge 还有几个语言模块（fmlcore、javafmllanguage……）也只在运行库目录里，库列表不写，
  // 只在 JVM 参数的 ignoreList 里提到。2026-11-07 用真的 PCL2 装的 Forge 47.4.28 复制过来进不了游戏才发现（缺 fmlcore）。
  // 只算版本 JSON 提到的，老版本 Forge 没有这些，不能当成缺了去重装
  if (mc && forge) {
    const group = (arg('--fml.forgeGroup') || 'net.minecraftforge').replace(/\./g, '/');
    const said = JSON.stringify((json.arguments && json.arguments.jvm) || []);
    out.push(`${group}/forge/${mc}-${forge}`);
    for (const n of ['fmlcore', 'javafmllanguage', 'lowcodelanguage', 'mclanguage']) if (said.includes(n)) out.push(`${group}/${n}/${mc}-${forge}`);
  }
  if (neo) out.push(`net/neoforged/neoforge/${neo}`);
  const mcp = arg('--fml.mcpVersion') || arg('--fml.neoFormVersion');
  if (mc && mcp) out.push(`net/minecraft/client/${mc}-${mcp}`);
  return out.filter((d) => !d.split('/').includes('..'));
}

const contentSkip = (opts) => (r) => {
  const top = r.split('/')[0];
  if (CACHE_TOP.test(top)) return true;
  if (/^aurora-profile\.json\.(bak|corrupt-)/.test(top)) return true; // 档案的备份和读坏的文件不跟着走
  if (!opts.saves && top === 'saves') return true;
  if (!opts.screenshots && top === 'screenshots') return true;
  if (!opts.logs && (top === 'logs' || top === 'crash-reports')) return true;
  return false;
};

/**
 * 要打包 / 复制的文件清单。items: [{ rel, file } | { rel, data }]
 * ids：只要这些配置（不传就是全部）
 */
async function inventory(src, opts, ids) {
  opts = { ...DEFAULT_OPTS, ...opts };
  const all = await profilesOf(src);
  const byId = new Map(all.map((p) => [p.id, p]));
  const chosen = (ids ? ids.filter((id) => byId.has(id)) : all.map((p) => p.id)).map((id) => byId.get(id));
  const chosenIds = new Set(chosen.map((p) => p.id));
  const items = [];
  const skip = contentSkip(opts);

  // 游戏配置
  const deps = new Set();
  for (const p of chosen) {
    const list = [];
    await walk(path.join(src.gameDir, 'versions', p.id), '', list, (r) => (!opts.runtime && r === `${p.id}.jar`) || skip(r));
    for (const f of list) items.push({ rel: `game/versions/${p.id}/${f.rel}`, file: f.file });
    for (const parent of p.chain.slice(1)) if (!chosenIds.has(parent) && byId.has(parent)) deps.add(parent);
  }
  // 继承的前置版本（比如 Fabric 配置继承的原版）：只带版本 JSON，带运行库时再带 jar
  for (const id of deps) {
    const dir = path.join(src.gameDir, 'versions', id);
    items.push({ rel: `game/versions/${id}/${id}.json`, file: path.join(dir, `${id}.json`) });
    if (opts.runtime && await exists(path.join(dir, `${id}.jar`))) items.push({ rel: `game/versions/${id}/${id}.jar`, file: path.join(dir, `${id}.jar`) });
  }
  // 没开隔离的配置用共享游戏目录：带一份共享的内容
  if (chosen.some((p) => !p.isolated)) {
    const names = [...ROOT_ITEMS, ...(opts.saves ? ['saves'] : []), ...(opts.screenshots ? ['screenshots'] : []), ...(opts.logs ? ['logs', 'crash-reports'] : [])];
    for (const n of names) {
      const full = path.join(src.gameDir, n);
      const st = await fsp.lstat(full).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isFile()) items.push({ rel: `game/root/${n}`, file: full });
      else if (st.isDirectory()) { const list = []; await walk(full, '', list); for (const f of list) items.push({ rel: `game/root/${n}/${f.rel}`, file: f.file }); }
    }
  }
  // 运行库
  if (opts.runtime) {
    const rels = new Set();
    const libBase = versions.librariesDir();
    for (const p of chosen) {
      const libs = [];
      for (const id of p.chain) if (byId.has(id)) libs.push(...(byId.get(id).json.libraries || []));
      for (const f of versions.collectLibraries({ libraries: libs }).files) rels.add(posix(path.relative(libBase, f.path)));
      for (const d of generatedDirs(p.json)) {
        const list = [];
        await walk(path.join(src.gameDir, 'libraries', ...d.split('/')), d, list, (r) => /\.cache$/.test(r));
        for (const f of list) rels.add(f.rel);
      }
    }
    for (const rel of rels) {
      if (rel.startsWith('..')) continue;
      const full = path.join(src.gameDir, 'libraries', ...rel.split('/'));
      if (await exists(full)) items.push({ rel: `game/libraries/${rel}`, file: full });
    }
  }
  // 启动器自己的数据
  if (opts.settings) {
    items.push({ rel: 'launcher/config.json', data: Buffer.from(JSON.stringify(sanitizeConfig(src.cfg), null, 2), 'utf8') });
    const bg = src.cfg.background;
    if (bg && bg.type === 'image' && bg.image && await exists(bg.image)) items.push({ rel: `launcher/background${path.extname(bg.image).toLowerCase() || '.png'}`, file: bg.image });
  }
  if (opts.plans && await exists(path.join(src.dataDir, 'plans.json'))) items.push({ rel: 'launcher/plans.json', file: path.join(src.dataDir, 'plans.json') });
  if (opts.accounts) {
    const acc = await readJsonSafe(path.join(src.dataDir, 'accounts.json'));
    if (acc) items.push({ rel: 'launcher/accounts.json', data: Buffer.from(JSON.stringify(require('./auth/accounts').exportList(acc), null, 2), 'utf8') });
  }
  if (opts.skins || opts.accounts) {
    const list = [];
    await walk(path.join(src.dataDir, 'skins'), '', list, (r) => (r.split('/')[0] === 'library' ? !opts.skins : !opts.accounts));
    for (const f of list) items.push({ rel: `launcher/skins/${f.rel}`, file: f.file });
  }

  const manifest = {
    app: require('electron').app.getVersion(),
    platform: process.platform,
    options: opts,
    profiles: chosen.map((p) => ({ id: p.id, mc: p.mc, loader: p.loader, isolated: p.isolated, chain: p.chain })),
    versionSettings: Object.fromEntries(chosen.map((p) => [p.id, sanitizeVs((src.cfg.versionSettings || {})[p.id])])),
    selectedVersion: src.cfg.selectedVersion || '',
    configVersion: src.cfg.configVersion || 0,
  };
  return { items, manifest };
}

async function sizeOf(items) {
  let bytes = 0;
  for (const it of items) bytes += it.data ? it.data.length : ((await fsp.stat(it.file).catch(() => null)) || { size: 0 }).size;
  return bytes;
}

/** 导出前估算大小：总数和每个配置各自的 */
async function estimate(opts, ids) {
  const { items } = await inventory(currentSource(), opts, ids);
  const per = {};
  let total = 0;
  for (const it of items) {
    const size = it.data ? it.data.length : ((await fsp.stat(it.file).catch(() => null)) || { size: 0 }).size;
    total += size;
    const m = it.rel.match(/^game\/versions\/([^/]+)\//);
    if (m) per[m[1]] = (per[m[1]] || 0) + size;
  }
  return { total, files: items.length, perProfile: per };
}

// ───────────────────────── 导出 ─────────────────────────
async function exportData(opts, ids, dest, task) {
  const { items, manifest } = await inventory(currentSource(), opts, ids);
  task.update({ detail: '统计大小…', progress: -1 });
  const total = Math.max(1, await sizeOf(items));
  const tmp = `${dest}.tmp`;
  const w = await ZipWriter.create(tmp);
  try {
    let done = 0;
    let last = 0;
    for (const it of items) {
      if (task.signal.aborted) throw cancelled();
      if (it.data) await w.addBuffer(it.rel, it.data);
      else {
        const st = await fsp.stat(it.file).catch(() => null);
        if (!st) continue; // 统计之后被删了
        await w.addFile(it.rel, it.file, { signal: task.signal });
        done += st.size;
      }
      if (Date.now() - last > 200) { last = Date.now(); task.update({ detail: `打包 ${nm(it.rel.replace(/^game\/versions\//, ''))}`, progress: Math.min(0.99, done / total) }); }
    }
    manifest.files = w.entries.map((e) => ({ path: e.nameBuf.toString('utf8'), size: e.size, crc: e.crc }));
    await w.addBuffer(MANIFEST, Buffer.from(envelope.seal(KIND, manifest), 'utf8'));
    await w.close();
    await fsp.rm(dest, { force: true });
    await renameRetry(tmp, dest);
  } catch (e) {
    if (w.fh) await w.fh.close().catch(() => {});
    await rmrf(tmp).catch(() => {});
    throw e;
  }
  return { file: dest, profiles: manifest.profiles.length, bytes: (await fsp.stat(dest)).size };
}

// ───────────────────────── 检查（导入前） ─────────────────────────
const block = (code, text) => ({ ok: false, problems: [{ level: 'block', code, text }] });

/** 把清单里的配置列成导入窗口用的样子：这台电脑上有没有同名的、大概多大 */
async function describe(manifest, sizes) {
  const profiles = [];
  for (const p of manifest.profiles || []) {
    if (!p || !validId(p.id)) continue;
    profiles.push({
      id: p.id, mc: p.mc, loader: p.loader || null, isolated: !!p.isolated,
      exists: await exists(versions.versionDir(p.id)),
      size: sizes[p.id] || 0,
    });
  }
  return profiles;
}

async function inspect(input) {
  return input && input.file ? inspectPack(input.file) : inspectFolder(input && input.dir);
}

async function inspectPack(file) {
  let z;
  try { z = await ZipReader.open(file); } catch (e) { return block('zip', `打不开这个文件：${e.message.replace(/^无法读取压缩包 [^：]*：/, '')}`); }
  try {
    const text = await z.readText(MANIFEST).catch(() => null);
    if (!text) return block('notAurora', '这不是 Aurora 的数据导出包（里面没有 aurora-export.json）');
    const r = envelope.open(text, KIND);
    if (!r.ok) return { ok: false, problems: r.problems };
    const m = r.data;
    const problems = [...r.problems];
    const risk = (code, t) => problems.push({ level: 'risk', code, text: t });
    if (!Array.isArray(m.profiles) || !Array.isArray(m.files)) return { ok: false, problems: [...problems, { level: 'block', code: 'schema', text: '导出包的清单格式不对，无法导入' }] };
    // 清单里的文件和压缩包逐个对照（大小、CRC）
    const listed = new Map();
    let unsafe = 0;
    for (const f of m.files) {
      if (!f || typeof f.path !== 'string') continue;
      if (!isSafeRel(f.path)) { unsafe++; continue; }
      listed.set(f.path, f);
    }
    let missing = 0;
    let changed = 0;
    for (const [p, f] of listed) {
      const e = z.getEntry(p);
      if (!e) missing++;
      else if (e.size !== f.size || e.crc !== f.crc) changed++;
    }
    const extra = z.entries.filter((e) => !e.isDirectory && e.name !== MANIFEST && !listed.has(e.name)).length;
    if (missing) risk('missing', `少了 ${missing} 个文件：导出包不完整，可能没下载完或者被删改过`);
    if (changed) risk('changed', `有 ${changed} 个文件和导出时不一样：被改动过或者已经损坏`);
    if (extra) risk('extra', `多了 ${extra} 个清单里没有的文件（导入时会忽略）`);
    if (unsafe) risk('unsafe', `清单里有 ${unsafe} 个路径不正常的文件（会忽略）`);
    const badIds = m.profiles.filter((p) => !p || !validId(p.id)).length;
    if (badIds) risk('schema', `有 ${badIds} 个游戏配置的名字不合规范，会跳过`);
    const sizes = {};
    for (const [p, f] of listed) { const mm = p.match(/^game\/versions\/([^/]+)\//); if (mm) sizes[mm[1]] = (sizes[mm[1]] || 0) + (f.size || 0); }
    const keys = [...listed.keys()];
    return {
      ok: true,
      problems,
      source: { kind: 'pack', path: file, app: r.meta.app, exportedAt: r.meta.exportedAt, platform: m.platform || '' },
      profiles: await describe(m, sizes),
      has: {
        settings: listed.has('launcher/config.json'),
        accounts: listed.has('launcher/accounts.json'),
        skins: keys.some((k) => k.startsWith('launcher/skins/library/')),
        plans: listed.has('launcher/plans.json'),
        runtime: keys.some((k) => k.startsWith('game/libraries/')),
        saves: !!(m.options && m.options.saves),
      },
      total: [...listed.values()].reduce((a, f) => a + (f.size || 0), 0),
    };
  } finally { await z.close(); }
}

async function inspectFolder(dir) {
  if (!dir) return block('nodir', '没有选择文件夹');
  let src;
  try { src = folderSource(dir); } catch (e) { return block('notAurora', e.message); }
  if (path.resolve(src.dataDir).toLowerCase() === path.resolve(paths.dataDir()).toLowerCase()) return block('self', '这就是启动器现在正在用的数据，不用导入');
  const problems = [];
  if ((src.cfg.configVersion || 0) > (config.get().configVersion || 0)) problems.push({ level: 'warn', code: 'newerApp', text: '这套数据来自更新版本的启动器，个别新设置可能会被忽略' });
  const { items, manifest } = await inventory(src, FOLDER_OPTS);
  const sizes = {};
  let total = 0;
  for (const it of items) {
    const size = it.data ? it.data.length : ((await fsp.stat(it.file).catch(() => null)) || { size: 0 }).size;
    total += size;
    const m = it.rel.match(/^game\/versions\/([^/]+)\//);
    if (m) sizes[m[1]] = (sizes[m[1]] || 0) + size;
  }
  const rels = items.map((i) => i.rel);
  const cfgFile = path.join(src.dataDir, 'config.json');
  return {
    ok: true,
    problems,
    source: { kind: 'folder', path: src.dataDir, gameDir: src.gameDir, app: '', exportedAt: ((await fsp.stat(cfgFile).catch(() => null)) || {}).mtime || '' },
    profiles: await describe(manifest, sizes),
    has: {
      settings: true,
      accounts: rels.includes('launcher/accounts.json'),
      skins: rels.some((k) => k.startsWith('launcher/skins/library/')),
      plans: rels.includes('launcher/plans.json'),
      runtime: true,
      saves: true,
    },
    total,
  };
}

/** 自动找这台电脑上的另一套 Aurora 数据：系统默认位置、启动器旁边的便携数据、自定义位置 */
async function candidates() {
  const location = require('../engine/location');
  const st = location.get();
  const cur = path.resolve(paths.dataDir()).toLowerCase();
  const out = [];
  const seen = new Set([cur]);
  const add = async (dir, label) => {
    if (!dir) return;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key) || !(await exists(path.join(dir, 'config.json')))) return;
    seen.add(key);
    let n = 0;
    try { n = (await profilesOf(folderSource(dir))).length; } catch { /* 读不出来也列出来，选了再报错 */ }
    const stt = await fsp.stat(path.join(dir, 'config.json')).catch(() => null);
    out.push({ dir, label, profiles: n, modified: stt ? stt.mtimeMs : 0 });
  };
  await add(st.defaultDataDir, '系统默认位置');
  await add(path.join(st.portableBase, 'launcher'), '启动器旁边的便携数据');
  const ptr = await readJsonSafe(path.join(st.defaultDataDir || '', 'location.json'));
  if (ptr && typeof ptr.dir === 'string' && path.isAbsolute(ptr.dir)) await add(path.join(ptr.dir, 'launcher'), '自定义位置');
  return out;
}

// ───────────────────────── 导入 ─────────────────────────
async function moveDir(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try { await renameRetry(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await require('../engine/location').copyTree(from, to, () => {});
    await rmrf(from);
  }
}

/**
 * 导入。input：{ file } 导出包 / { dir } 另一套数据；choices：
 *   profiles: { [id]: 'rename' | 'overwrite' | 'skip' }（没写的、这台电脑上没有同名的就直接导入；有同名的默认改名）
 *   settings / accounts / skins / plans: 布尔
 */
async function importData(input, choices = {}, task) {
  let z = null;
  let manifest;
  let entries;
  if (input && input.file) {
    z = await ZipReader.open(input.file);
    const r = envelope.open(await z.readText(MANIFEST), KIND);
    if (!r.ok) { await z.close(); throw new Error(r.problems.map((p) => p.text).join('；')); }
    manifest = r.data;
    const listed = new Set((manifest.files || []).map((f) => f && f.path).filter(Boolean));
    entries = z.entries.filter((e) => !e.isDirectory && listed.has(e.name)).map((e) => ({
      rel: e.name, size: e.size, read: () => z.read(e), copy: (dest) => z.extractTo(e, dest, { verify: true }),
    }));
  } else {
    const src = folderSource(input && input.dir);
    if (path.resolve(src.dataDir).toLowerCase() === path.resolve(paths.dataDir()).toLowerCase()) throw new Error('这就是启动器现在正在用的数据');
    const inv = await inventory(src, FOLDER_OPTS);
    manifest = inv.manifest;
    entries = [];
    for (const it of inv.items) {
      entries.push(it.data
        ? { rel: it.rel, size: it.data.length, read: async () => it.data, copy: (d) => fsp.writeFile(d, it.data) }
        : { rel: it.rel, size: ((await fsp.stat(it.file).catch(() => null)) || { size: 0 }).size, read: () => fsp.readFile(it.file), copy: (d) => fsp.copyFile(it.file, d) });
    }
  }
  try { return await apply(manifest, entries, choices, task); } finally { if (z) await z.close(); }
}

async function apply(manifest, entries, choices, task) {
  const sel = { settings: !!choices.settings, accounts: choices.accounts !== false, skins: choices.skins !== false, plans: choices.plans !== false };
  const gameRoot = config.get().gameDir;
  const result = { imported: [], skipped: [], pending: [], failedFiles: [], backups: [], accounts: 0, skins: 0, plans: 0, settings: false, worlds: [] };
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  // 1. 每个配置导入成什么名字
  const taken = new Set((await fsp.readdir(versions.versionsDir()).catch(() => [])).map((s) => s.toLowerCase()));
  const map = new Map();
  const profiles = (manifest.profiles || []).filter((p) => p && validId(p.id));
  const uniqueId = (base) => {
    let n = `${base} (导入)`;
    for (let k = 2; taken.has(n.toLowerCase()); k++) n = `${base} (导入 ${k})`;
    taken.add(n.toLowerCase());
    return n;
  };
  for (const p of profiles) {
    const want = (choices.profiles || {})[p.id];
    if (want === 'skip' || want === false) { result.skipped.push(p.id); continue; }
    if (!taken.has(p.id.toLowerCase())) { map.set(p.id, p.id); taken.add(p.id.toLowerCase()); continue; }
    if (want === 'overwrite') {
      const to = path.join(paths.dataDir(), 'backups', 'replaced', `${safeName(p.id)}-${stamp}`);
      task.update({ detail: `备份原来的 ${nm(p.id)}…`, progress: -1 });
      await moveDir(versions.versionDir(p.id), to);
      result.backups.push({ id: p.id, path: to });
      map.set(p.id, p.id);
    } else map.set(p.id, uniqueId(p.id));
  }
  // 继承的前置版本：这台电脑上没有的才放进来，有就用这里的
  const newDeps = new Set();
  for (const p of profiles) {
    for (const d of (p.chain || []).slice(1)) {
      if (map.has(d) || !validId(d)) continue;
      if (!(await exists(versions.versionDir(d)))) newDeps.add(d);
    }
  }

  // 2. 解压 / 复制文件
  const total = Math.max(1, entries.reduce((a, e) => a + (e.size || 0), 0));
  const special = {};
  const worldName = new Map();
  let done = 0;
  let last = 0;
  for (const e of entries) {
    if (task.signal.aborted) throw cancelled();
    if (!isSafeRel(e.rel)) { result.skippedUnsafe = (result.skippedUnsafe || 0) + 1; continue; }
    const seg = e.rel.split('/');
    let dest = null;
    let keepExisting = true;
    if (seg[0] === 'game' && seg[1] === 'versions' && seg.length >= 4) {
      const vid = seg[2];
      let rest = seg.slice(3).join('/');
      if (map.has(vid)) {
        const nid = map.get(vid);
        if (rest === `${vid}.json`) rest = `${nid}.json`;
        else if (rest === `${vid}.jar`) rest = `${nid}.jar`;
        dest = path.join(versions.versionDir(nid), ...rest.split('/'));
        keepExisting = false;
      } else if (newDeps.has(vid)) dest = path.join(versions.versionDir(vid), ...rest.split('/'));
    } else if (seg[0] === 'game' && seg[1] === 'libraries') {
      dest = path.join(versions.librariesDir(), ...seg.slice(2));
    } else if (seg[0] === 'game' && seg[1] === 'assets') {
      dest = path.join(versions.assetsDir(), ...seg.slice(2)); // 从其他启动器导入时带上（core/foreign.js），导出包不带
    } else if (seg[0] === 'game' && seg[1] === 'root' && seg.length >= 3) {
      const rest = seg.slice(2);
      // 共享目录里的存档：这台电脑上有同名的世界就改名放进来，不覆盖
      if (rest[0] === 'saves' && rest.length >= 3) {
        if (!worldName.has(rest[1])) {
          let n = rest[1];
          if (await exists(path.join(gameRoot, 'saves', n))) {
            n = `${rest[1]} (导入)`;
            for (let k = 2; await exists(path.join(gameRoot, 'saves', n)); k++) n = `${rest[1]} (导入 ${k})`;
            result.worlds.push({ from: rest[1], to: n });
          }
          worldName.set(rest[1], n);
        }
        rest[1] = worldName.get(rest[1]);
      }
      dest = path.join(gameRoot, ...rest);
    } else if (e.rel === 'launcher/config.json') { special.config = e; continue; }
    else if (e.rel === 'launcher/accounts.json') { special.accounts = e; continue; }
    else if (e.rel === 'launcher/plans.json') { special.plans = e; continue; }
    else if (/^launcher\/background\.\w+$/.test(e.rel)) { special.background = e; continue; }
    else if (e.rel === 'launcher/skins/library/library.json') { special.library = e; continue; }
    else if (seg[0] === 'launcher' && seg[1] === 'skins' && seg.length >= 4) {
      if (seg[2] === 'library' ? !sel.skins : !sel.accounts) continue;
      dest = path.join(paths.dataDir(), 'skins', ...seg.slice(2));
      if (seg[2] === 'library') result.skins++;
    }
    if (!dest) continue;
    if (keepExisting && await exists(dest)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // 写完才放到位（2.0.0-pre8）：中途崩溃不留半个版本文件。导入一半的配置下次补全就好，读不出来的版本文件补不了
    const part = `${dest}.aurora-tmp`; // 名字固定：崩溃后再导入一次会盖掉，不会越积越多
    try {
      await e.copy(part);
      await renameRetry(part, dest);
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (!err.corrupt) throw err;
      result.failedFiles.push(e.rel);
    }
    done += e.size || 0;
    if (Date.now() - last > 200) { last = Date.now(); task.update({ detail: `导入 ${nm(e.rel.replace(/^game\/(versions|root)\//, ''))}`, progress: Math.min(0.95, (done / total) * 0.9) }); }
  }

  // 3. 改了名的配置：版本 JSON 的 id、继承关系；配置的设置；独立 / 共享游戏目录保持和原来一样
  for (const p of profiles) {
    if (!map.has(p.id)) continue;
    const nid = map.get(p.id);
    const jp = versions.versionJsonPath(nid);
    const j = await readJsonSafe(jp);
    if (!j) { result.pending.push({ id: nid, error: '版本文件缺失' }); continue; }
    let changed = false;
    if (nid !== p.id) {
      j.id = nid;
      if (!j.inheritsFrom && !j.clientVersion) j.clientVersion = p.id;
      changed = true;
    }
    if (j.inheritsFrom && map.has(j.inheritsFrom) && map.get(j.inheritsFrom) !== j.inheritsFrom) {
      const old = j.inheritsFrom;
      j.inheritsFrom = map.get(old);
      if (j.jar === old) j.jar = j.inheritsFrom;
      changed = true;
    }
    if (changed) await writeJson(jp, j);
    const vs = (manifest.versionSettings || {})[p.id];
    if (vs && Object.keys(vs).length) config.setVersionSettings(nid, sanitizeVs(vs));
    const info = await versions.versionInfo(nid);
    const isoNow = path.resolve(versions.gameDirFor(nid, info)) === path.resolve(versions.versionDir(nid));
    if (isoNow !== !!p.isolated) config.setVersionSettings(nid, { isolation: p.isolated ? 'on' : 'none' });
  }

  // 4. 启动器自己的数据
  if (sel.settings && special.config) {
    const patch = sanitizeConfig(JSON.parse((await special.config.read()).toString('utf8')));
    if (special.background && patch.background && patch.background.type === 'image') {
      const to = path.join(paths.dataDir(), `background-imported${path.extname(special.background.rel)}`);
      await special.background.copy(to).catch(() => null);
      if (await exists(to)) patch.background.image = to; else patch.background.type = 'scene';
    } else if (patch.background && patch.background.type === 'image') patch.background.type = 'scene';
    if (manifest.selectedVersion && map.has(manifest.selectedVersion)) patch.selectedVersion = map.get(manifest.selectedVersion);
    config.set(patch);
    result.settings = true;
  }
  if (sel.accounts && special.accounts) {
    try { result.accounts = await require('./auth/accounts').importList(JSON.parse((await special.accounts.read()).toString('utf8'))); } catch { /* 账户文件坏了就不导入账户 */ }
  }
  if (sel.skins && special.library) {
    try {
      const inc = JSON.parse((await special.library.read()).toString('utf8'));
      const file = path.join(paths.dataDir(), 'skins', 'library', 'library.json');
      // 这边的文件读坏时不会被导入的内容盖掉（jsonstore，1.10.7）
      await store.update(file, (idx) => {
        const have = new Set((idx.items || []).map((x) => x.hash));
        idx.items = [...(idx.items || []), ...(inc.items || []).filter((x) => x && /^[0-9a-f]{64}$/.test(x.hash) && !have.has(x.hash))];
        idx.groups = [...new Set([...(idx.groups || []), ...(inc.groups || [])])];
        return idx;
      }, { label: '皮肤库', fallback: { items: [] } });
    } catch { /* 索引坏了就只有图片 */ }
  }
  if (sel.plans && special.plans) {
    try {
      const inc = JSON.parse((await special.plans.read()).toString('utf8'));
      const file = path.join(paths.dataDir(), 'plans.json');
      await store.update(file, (cur) => {
        const have = new Set((cur.plans || []).map((x) => x.id));
        for (const pl of inc.plans || []) {
          if (!pl || !pl.id || have.has(pl.id)) continue;
          if (pl.profileId) pl.profileId = map.get(pl.profileId) || pl.profileId;
          // 本地 jar 的路径只在原电脑有效
          pl.items = (pl.items || []).filter((i) => !i.local || (i.localPath && fs.existsSync(i.localPath)));
          cur.plans = [...(cur.plans || []), pl];
          result.plans++;
        }
        return { plans: (cur.plans || []).slice(-50) };
      }, { label: 'Mod 配置器清单', fallback: { plans: [] } });
    } catch { /* 清单文件坏了就不导入 */ }
  }

  // 5. 补全游戏文件：不带运行库时重新下载（加载器生成的文件下载不到，就按记录重新安装加载器）；资源文件总是要补
  const ids = [...map.entries()];
  for (let i = 0; i < ids.length; i++) {
    const [oid, nid] = ids[i];
    if (task.signal.aborted) throw cancelled();
    task.update({ detail: `补全 ${nid} 的游戏文件（${i + 1}/${ids.length}）…`, progress: 0.9 + (i / ids.length) * 0.1 });
    try {
      await ensureRuntime(nid, task);
      await versions.completeVersion(nid, task);
    } catch (e) {
      if (e.cancelled) throw e;
      result.pending.push({ id: nid, error: e.message });
    }
    result.imported.push({ from: oid, id: nid });
  }
  return result;
}

/** 加载器生成的库（Forge 的 client 补丁等，下载不到）不在：按记录重新跑加载器安装，生成新的版本 JSON */
async function ensureRuntime(id, task) {
  await versions.ensureParents(id, task);
  const v = await versions.resolveVersion(id);
  const missing = [];
  for (const f of versions.collectLibraries(v).files) if (f.local && !(await exists(f.path))) missing.push(f.path);
  for (const d of generatedDirs(v)) {
    const dir = path.join(versions.librariesDir(), ...d.split('/'));
    if (!(await fsp.readdir(dir).catch(() => [])).some((n) => /\.jar$/i.test(n))) missing.push(dir);
  }
  if (!missing.length) return;
  const info = await versions.versionInfo(id);
  if (!info || !info.loader || !info.loader.type) throw new Error('缺少加载器生成的文件，请在「组件管理」里重新安装加载器');
  task.update({ detail: `重新安装 ${nm(id)} 的 ${info.loader.type}…`, progress: -1 });
  const json = await require('./loaders').buildJson(info.mcVersion, { type: info.loader.type, version: info.loader.version }, task);
  json.id = id;
  await writeJson(versions.versionJsonPath(id), json);
}

module.exports = { generatedDirs, EXT, KIND, DEFAULT_OPTS, estimate, exportData, inspect, importData, candidates, inventory, folderSource, sanitizeConfig, apply, walk };
