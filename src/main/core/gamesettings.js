'use strict';
/**
 * 游戏内设置跨版本同步（1.5.6）
 *
 * - 设置主档：数据目录下的 game-settings.json（中间格式，每项记值、来自哪个配置、什么时候），附带的文件（服务器列表、快捷栏、
 *   画面增强 Mod 的设置、Mod 配置文件）放在 game-settings/ 文件夹。便携模式下跟着数据文件夹走
 * - 写入：按目标版本翻译（optionsfmt.js），只改选中的类别，其他行原样保留；写之前把要改的文件备份到 <游戏目录>/.aurora-sync-bak/<时间>/（留 5 份），可撤销
 * - 时机（默认「只在新建时」）：
 *     once    新配置第一次正式启动前同步一次（没正式启动过、也没同步过的配置）
 *     follow  每次启动前写入；游戏退出后把改过的项读回主档（启动器没开着时，下次打开启动器或下次启动前补读）
 *     off     这个配置不同步
 *   每个配置可以单独选，default = 跟随设置里的默认
 * - Mod 按键：主档里一直留着；写进目标时只写目标里可能有这个 Mod 的（纯净版不写）
 * - 按键冲突只提示，报告里给「解绑撞车的 Mod 按键」按钮（integrity.unbindConflicts）
 * - Mod 配置文件只复制给装了同一个 Mod（同 id、同加载器、版本号第一段相同）的配置；快捷栏只复制给不比来源旧的版本（游戏能升级物品格式，不能降级）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../engine/config');
const paths = require('../engine/paths');
const versions = require('./versions');
const profiles = require('./profiles');
const fmt = require('./optionsfmt');
const nbt = require('../engine/nbt');
const { exists, readJson, writeJson, rmrf } = require('../engine/util');
const { writeFileSafe } = require('../engine/fileops');
const jsonStore = require('../engine/jsonstore');

const FORMAT = 1;
const BAK_DIR = '.aurora-sync-bak';
const KEEP_BAK = 5;
const MOD_SETTINGS = ['config/sodium-options.json', 'config/embeddium-options.json', 'config/rubidium-options.json', 'optionsof.txt', 'optionsshaders.txt'];
const MAX_CONFIG_FILES = 600;
const MAX_CONFIG_SIZE = 2 * 1024 * 1024;

const masterPath = () => path.join(paths.dataDir(), 'game-settings.json');
const storeDir = () => path.join(paths.dataDir(), 'game-settings');
const schemaPath = (mc) => path.join(paths.cacheDir(), 'options-schema', `${String(mc).replace(/[^\w.-]/g, '_')}.json`);

function settings() {
  const s = config.get().gameSync || {};
  return { enabled: !!s.enabled, cats: Array.isArray(s.cats) ? s.cats : fmt.DEFAULT_CATEGORIES, mode: s.mode === 'follow' ? 'follow' : 'once' };
}

const MASTER = { label: '游戏设置主档' };
async function readMaster() { return jsonStore.read(masterPath(), null, MASTER); }
async function writeMaster(m) { m.updatedAt = Date.now(); await jsonStore.write(masterPath(), m, MASTER); return m; }

// ───────────────────────── 配置信息 ─────────────────────────
const ROOT = '@root';
async function targetInfo(id) {
  if (id === ROOT) return { id, mc: null, loader: null, gameDir: versions.gameRoot(), name: '公共 .minecraft' };
  const info = await versions.versionInfo(id);
  if (!info) throw new Error('配置不存在');
  return { id, mc: info.mcVersion, loader: info.loader ? info.loader.type : null, gameDir: versions.gameDirFor(id, info), info, name: id };
}

/** 目标版本的 DataVersion：游戏 jar 里的 version.json（1.14 起），读不到用内置表 */
async function dataVersionOf(mc) {
  if (!mc || !fmt.atLeast(mc, '1.13')) return null;
  try {
    const { withZip } = require('../engine/zip');
    const j = await withZip(versions.versionJarPath(mc), async (z) => JSON.parse(await z.readText('version.json')));
    if (j && Number(j.world_version)) return Number(j.world_version);
  } catch { /* 没有 jar 或太老 */ }
  return fmt.dataVersionGuess(mc);
}

async function readSchema(mc) { return mc ? readJson(schemaPath(mc), null) : null; }
/** 游戏自己写过的完整 options.txt：记下这个版本真实存在的键和值的样子 */
async function learnFrom(mc, text, loader) {
  if (!mc || !text || !fmt.looksGameWritten(text)) return;
  const l = fmt.learn(text);
  // 有 Mod 的配置里会混进 Mod 按键：只留原版的东西，Mod 按键不算这个版本的
  if (loader) l.keys = l.keys.filter((k) => !k.startsWith('key_') || fmt.isVanillaAction(fmt.actionOf(k)));
  const old = await readSchema(mc);
  if (old && loader && !old.modded) return; // 已经有纯净版学到的，更准
  await writeJson(schemaPath(mc), { ...l, mc, modded: !!loader, at: Date.now() }).catch(() => {});
}

async function readText(p) { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } }

/** 这个配置的 options.txt 正被游戏用着：共用公共目录的其他配置在跑也算（同一份文件，1.10.7） */
async function running(id) {
  const t = await targetInfo(id).catch(() => null);
  return !!(t && (await require('./gamelock').forPath(path.join(t.gameDir, 'options.txt'))));
}

// ───────────────────────── 来源 ─────────────────────────
/** 可以导入主档的地方：每个配置和公共 .minecraft，带最近修改时间和设置项数 */
async function listSources() {
  const out = [];
  const seen = new Set();
  const add = async (id, name, gameDir, mc, loader) => {
    const key = path.resolve(gameDir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const p = path.join(gameDir, 'options.txt');
    const st = await fsp.stat(p).catch(() => null);
    if (!st) return;
    const text = await readText(p);
    const n = fmt.parse(text || '').lines.filter((l) => l.k != null).length;
    out.push({ id, name, mc, loader, gameDir, modified: st.mtimeMs, count: n, full: fmt.looksGameWritten(text || '') });
  };
  for (const v of await versions.listInstalled()) {
    if (v.broken) continue;
    await add(v.id, v.id, versions.gameDirFor(v.id, v), v.mcVersion, v.loader ? v.loader.type : null);
  }
  await add(ROOT, '公共 .minecraft', versions.gameRoot(), null, null);
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

// ───────────────────────── 读进主档 ─────────────────────────
const stamp = (v, from, at) => ({ ...v, from, at });

/** 配置里装的 Mod：[{id, version, loader}]（启用的） */
async function modsOf(id, loader) {
  if (id === ROOT || !loader) return [];
  try {
    const { mods } = await require('./mods').listMods(id);
    return mods.filter((m) => m.enabled).flatMap((m) => (m.ids && m.ids.length ? m.ids : [m.id]).filter(Boolean).map((mid) => ({ id: String(mid).toLowerCase(), version: m.version || '', loader })));
  } catch { return []; }
}

/** Mod 版本号的第一段（去掉前面的 MC 版本）：15.2.0.27 → 15，mc1.20.1-0.5.3 → 0 */
function modMajor(v) {
  const s = String(v || '').replace(/^(mc)?1\.\d+(\.\d+)?[-_+]/i, '');
  const m = s.match(/\d+/);
  return m ? m[0] : '';
}

/** config/ 里的文件属于哪个 Mod：第一层文件夹名，或者文件名去掉 -client / -common 等后缀 */
function configOwner(rel, ids) {
  const norm = (s) => s.toLowerCase().replace(/[-_\s]/g, '');
  const parts = rel.split('/');
  const cands = [];
  if (parts.length > 1) cands.push(parts[0]);
  const base = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  cands.push(base, base.replace(/[-_.](client|common|server|config|options|settings)$/i, ''), base.split(/[-_.]/)[0]);
  for (const c of cands) {
    const hit = ids.find((m) => norm(m.id) === norm(c));
    if (hit) return hit;
  }
  return null;
}

async function walk(dir, rel = '', out = []) {
  let list = [];
  try { list = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    if (out.length >= MAX_CONFIG_FILES) break;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) await walk(dir, r, out);
    else if (d.isFile()) out.push(r);
  }
  return out;
}

/**
 * 从一个配置（或公共 .minecraft）读进主档。
 * @param {object} opts { only?: Set<选项键> 只更新这些（每次启动保持一致时读回改过的项）, at?: 时间, replace?: true 整个主档换掉,
 *   temp?: 文件夹 —— 不碰真正的主档，读成一份临时主档（附带文件放在这个文件夹），返回 { m }（「同步到其他配置」用，1.5.7）}
 */
async function captureFrom(id, opts = {}) {
  const t = await targetInfo(id);
  const at = opts.at || Date.now();
  const text = await readText(path.join(t.gameDir, 'options.txt'));
  const prev = opts.replace || opts.temp ? null : await readMaster();
  const m = prev && prev.formatVersion === FORMAT ? prev : { formatVersion: FORMAT, values: {}, keys: {}, modKeys: {}, packs: null, files: {} };
  if (opts.replace || opts.temp) m.source = { id, mc: t.mc, loader: t.loader, at };
  const want = (k) => !opts.only || opts.only.has(k);
  let n = 0;
  if (text) {
    const c = fmt.toCanonical(text);
    for (const [k, v] of Object.entries(c.values)) if (want(k)) { m.values[k] = stamp({ v }, id, at); n++; }
    for (const [a, p] of Object.entries(c.keys)) {
      if (!want(`key:${a}`)) continue;
      // 纯净版 / Fabric 读不出 Forge 的修饰键：主档里原来有修饰键、主键也一样时留着
      const old = m.keys[a];
      m.keys[a] = stamp({ key: p.key, mod: p.mod || (old && old.key === p.key && !['forge', 'neoforge'].includes(t.loader) ? old.mod : null) }, id, at);
      n++;
    }
    for (const [k, p] of Object.entries(c.modKeys)) {
      if (!want(k)) continue;
      const old = m.modKeys[k];
      m.modKeys[k] = stamp({ key: p.key, mod: p.mod || (old && old.key === p.key && !['forge', 'neoforge'].includes(t.loader) ? old.mod : null) }, id, at);
      n++;
    }
    if (c.packs && want('resourcePacks')) m.packs = stamp({ list: c.packs }, id, at);
    await learnFrom(t.mc, text, t.loader);
  }
  if (!opts.only) await captureFiles(t, m, at, opts.temp);
  if (opts.temp) return { count: n, m };
  await writeMaster(m);
  return { count: n, master: summarize(m) };
}

/** 服务器列表、快捷栏、画面增强 Mod 的设置、Mod 配置文件：复制一份到 game-settings/（或临时文件夹） */
async function captureFiles(t, m, at, store = storeDir()) {
  const put = async (rel, dstRel = rel) => {
    const src = path.join(t.gameDir, rel);
    const st = await fsp.stat(src).catch(() => null);
    if (!st || !st.isFile() || st.size > MAX_CONFIG_SIZE) return false;
    const dst = path.join(store, dstRel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    return true;
  };
  m.files = m.files || {};
  if (await put('servers.dat')) m.files.servers = { from: t.id, at };
  if (await put('hotbar.nbt')) m.files.hotbar = { from: t.id, at, mc: t.mc, dataVersion: await dataVersionOf(t.mc) };
  const ms = [];
  await rmrf(path.join(store, 'mod-settings')).catch(() => {});
  for (const rel of MOD_SETTINGS) if (await put(rel, `mod-settings/${rel}`)) ms.push({ rel, from: t.id, at });
  m.files.modSettings = ms;
  // Mod 配置文件：只收认得出属于哪个 Mod 的
  const ids = await modsOf(t.id, t.loader);
  await rmrf(path.join(store, 'mod-config')).catch(() => {});
  const mc = [];
  if (ids.length) {
    for (const rel of await walk(path.join(t.gameDir, 'config'))) {
      if (MOD_SETTINGS.includes(`config/${rel}`)) continue;
      const owner = configOwner(rel, ids);
      if (!owner) continue;
      if (await put(`config/${rel}`, `mod-config/${rel}`)) mc.push({ rel, modid: owner.id, modVersion: owner.version, loader: owner.loader, from: t.id, at });
    }
  }
  m.files.modConfig = mc;
}

/** 主档的概况（界面用） */
function summarize(m) {
  if (!m) return null;
  const files = m.files || {};
  return {
    source: m.source || null, updatedAt: m.updatedAt || null,
    counts: {
      values: Object.keys(m.values || {}).length, keys: Object.keys(m.keys || {}).length, modKeys: Object.keys(m.modKeys || {}).length,
      packs: m.packs ? m.packs.list.length : 0, servers: files.servers ? 1 : 0, hotbar: files.hotbar ? 1 : 0,
      modSettings: (files.modSettings || []).length, modConfig: (files.modConfig || []).length,
    },
    sample: {
      lang: m.values.lang && m.values.lang.v, renderDistance: m.values.renderDistance && m.values.renderDistance.v,
      mouseSensitivity: m.values.mouseSensitivity && m.values.mouseSensitivity.v, fov: m.values.fov && m.values.fov.v,
      forward: m.keys.forward && m.keys.forward.key, jump: m.keys.jump && m.keys.jump.key,
    },
    modKeyNames: Object.keys(m.modKeys || {}).slice(0, 60),
  };
}

// ───────────────────────── 写进配置 ─────────────────────────
function newBackup(gameDir) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
  const dir = path.join(gameDir, BAK_DIR, name);
  const list = { created: [], saved: [] };
  return {
    dir, name, list,
    /** 改一个文件之前调用：有就复制一份，没有就记下「这次新建的」，撤销时删掉 */
    async save(rel) {
      if (list.saved.includes(rel) || list.created.includes(rel)) return;
      const src = path.join(gameDir, rel);
      if (await exists(src)) {
        const dst = path.join(dir, 'files', rel);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
        list.saved.push(rel);
      } else list.created.push(rel);
    },
    async finish() {
      if (!list.saved.length && !list.created.length) return null;
      await fsp.mkdir(dir, { recursive: true });
      await writeJson(path.join(dir, 'backup.json'), { at: Date.now(), ...list });
      // 只留最近 5 份
      const all = (await fsp.readdir(path.join(gameDir, BAK_DIR)).catch(() => [])).sort();
      for (const old of all.slice(0, Math.max(0, all.length - KEEP_BAK))) await rmrf(path.join(gameDir, BAK_DIR, old)).catch(() => {});
      return name;
    },
  };
}

/** 服务器列表按地址合并：目标已有的不动，主档里有、目标没有的加到后面 */
function mergeServers(targetBuf, masterBuf) {
  const read = (b) => {
    const root = nbt.parse(b);
    const list = root.value.servers && root.value.servers.value;
    return { root, items: list && list.items ? list.items : [] };
  };
  const src = read(masterBuf);
  if (!targetBuf) return { buf: masterBuf, added: src.items.length };
  const dst = read(targetBuf);
  const ipOf = (s) => String((s.ip && s.ip.value) || '').trim().toLowerCase();
  const have = new Set(dst.items.map(ipOf));
  const add = src.items.filter((s) => ipOf(s) && !have.has(ipOf(s)));
  if (!add.length) return { buf: null, added: 0 };
  if (!dst.root.value.servers) dst.root.value.servers = { type: nbt.T.LIST, value: { type: nbt.T.COMPOUND, items: [] } };
  dst.root.value.servers.value.items.push(...add);
  return { buf: nbt.serialize(dst.root), added: add.length };
}

/**
 * 把主档写进一个配置。
 * @param {string} id 配置
 * @param {{cats?: string[], reason?: string, force?: boolean, master?: object, store?: string}} opts reason: once / follow / manual / copy
 *   master / store：用一份临时主档（「同步到其他配置」，从另一个配置直接读的，1.5.7）
 * @returns 报告
 */
async function applyTo(id, opts = {}) {
  const m = opts.master || await readMaster();
  if (!m) throw new Error('还没有设置主档，先在「设置 → 游戏设置同步」里选从哪个配置导入');
  const t = await targetInfo(id);
  if (await running(id)) throw new Error('这个配置的游戏正在运行，等它退出后再同步');
  const cats = opts.cats || settings().cats;
  const at = Date.now();
  const report = { at, reason: opts.reason || 'manual', from: opts.master && m.source ? m.source.id : null, mc: t.mc, loader: t.loader, written: {}, skipped: [], clamped: [], unbound: [], modKeysKept: 0, conflicts: [], files: [], backup: null, notes: [] };
  const bak = newBackup(t.gameDir);
  const optFile = path.join(t.gameDir, 'options.txt');
  const before = await readText(optFile);
  if (before) await learnFrom(t.mc, before, t.loader);
  const schema = await readSchema(t.mc);

  // options.txt
  const canon = {
    values: Object.fromEntries(Object.entries(m.values || {}).map(([k, x]) => [k, x.v])),
    keys: Object.fromEntries(Object.entries(m.keys || {}).map(([a, x]) => [a, { key: x.key, mod: x.mod }])),
    modKeys: Object.fromEntries(Object.entries(m.modKeys || {}).map(([k, x]) => [k, { key: x.key, mod: x.mod }])),
    packs: m.packs ? m.packs.list : null,
  };
  const optCats = cats.filter((c) => !['servers', 'hotbar', 'modSettings', 'modConfig'].includes(c));
  let modFilter = () => false;
  if (t.loader) {
    const lines = before ? fmt.toMap(fmt.parse(before)) : new Map();
    const ids = new Set((await modsOf(id, t.loader)).map((x) => x.id.replace(/[-_]/g, '')));
    const ns = (k) => (k.match(/^key_key\.([^.]+)\./) || k.match(/^key_([^.]+)\./) || [])[1];
    // 目标里可能有这个 Mod：options.txt 里已经有这一行 / 游戏还没写过 options.txt（新配置，游戏会忽略不认识的行）/ 按键名里的 Mod id 对得上
    const fresh = !before || !fmt.looksGameWritten(before);
    modFilter = (k) => lines.has(k) || fresh || (ns(k) && ids.has(String(ns(k)).toLowerCase().replace(/[-_]/g, '')));
  } else if (optCats.includes('modKeys') && Object.keys(canon.modKeys).length) report.notes.push('vanillaModKeys');
  if (optCats.length) {
    const r = fmt.fromCanonical(before, canon, { mc: t.mc || '99', loader: t.loader, dataVersion: await dataVersionOf(t.mc), schema, cats: optCats, modKeysFilter: modFilter, packsExist: (f) => fs.existsSync(path.join(t.gameDir, 'resourcepacks', f)) });
    Object.assign(report, { written: r.report.written, skipped: r.report.skipped, clamped: r.report.clamped, unbound: r.report.unbound, modKeysKept: r.report.modKeysKept.length });
    if (r.text !== (before || '')) {
      await bak.save('options.txt');
      await writeFileSafe(optFile, r.text);
      report.files.push('options.txt');
    }
    report.conflicts = require('./integrity').keyConflicts(r.text);
  }

  // 附带的文件
  const store = opts.store || storeDir();
  const files = m.files || {};
  const copyIn = async (srcRel, rel) => {
    await bak.save(rel);
    await fsp.mkdir(path.dirname(path.join(t.gameDir, rel)), { recursive: true });
    await fsp.copyFile(path.join(store, srcRel), path.join(t.gameDir, rel));
    report.files.push(rel);
  };
  if (cats.includes('servers') && files.servers && (await exists(path.join(store, 'servers.dat')))) {
    try {
      const cur = await fsp.readFile(path.join(t.gameDir, 'servers.dat')).catch(() => null);
      const r = mergeServers(cur, await fsp.readFile(path.join(store, 'servers.dat')));
      if (r.buf) { await bak.save('servers.dat'); await writeFileSafe(path.join(t.gameDir, 'servers.dat'), r.buf); report.files.push('servers.dat'); }
      report.written.servers = r.added;
    } catch (e) { report.skipped.push({ k: 'servers.dat', reason: 'broken', detail: e.message }); }
  }
  if (cats.includes('hotbar') && files.hotbar && (await exists(path.join(store, 'hotbar.nbt')))) {
    const srcMc = files.hotbar.mc;
    // 游戏能把旧格式的物品升级，不能降级：只给不比来源旧的版本
    if (srcMc && t.mc && fmt.verNum(t.mc) != null && fmt.verNum(srcMc) != null && fmt.verNum(t.mc) < fmt.verNum(srcMc)) report.skipped.push({ k: 'hotbar.nbt', reason: 'older', detail: srcMc });
    else { await copyIn('hotbar.nbt', 'hotbar.nbt'); report.written.hotbar = 1; }
  }
  if (cats.includes('modSettings') && t.loader !== null) {
    const ids = new Set((await modsOf(id, t.loader)).map((x) => x.id));
    const owner = { 'config/sodium-options.json': ['sodium'], 'config/embeddium-options.json': ['embeddium'], 'config/rubidium-options.json': ['rubidium'], 'optionsof.txt': ['optifine'], 'optionsshaders.txt': ['optifine', 'oculus', 'iris'] };
    const optifine = t.info && t.info.loader && t.info.loader.type === 'optifine';
    for (const f of files.modSettings || []) {
      const need = owner[f.rel] || [];
      if (need.some((x) => ids.has(x)) || (optifine && need.includes('optifine'))) { await copyIn(`mod-settings/${f.rel}`, f.rel); report.written.modSettings = (report.written.modSettings || 0) + 1; } else report.skipped.push({ k: f.rel, reason: 'noMod' });
    }
  }
  if (cats.includes('modConfig') && (files.modConfig || []).length) {
    const mine = await modsOf(id, t.loader);
    for (const f of files.modConfig) {
      const hit = mine.find((x) => x.id === f.modid);
      if (!hit) { report.skipped.push({ k: `config/${f.rel}`, reason: 'noMod', mod: f.modid }); continue; }
      if (hit.loader !== f.loader || modMajor(hit.version) !== modMajor(f.modVersion)) { report.skipped.push({ k: `config/${f.rel}`, reason: 'modVersion', mod: f.modid, detail: `${f.modVersion} → ${hit.version}` }); continue; }
      await copyIn(`mod-config/${f.rel}`, `config/${f.rel}`);
      report.written.modConfig = (report.written.modConfig || 0) + 1;
    }
  }

  report.backup = await bak.finish();
  // 记下这次写进去的值，「每次启动保持一致」时用来判断玩家在游戏里改了什么
  const after = await readText(optFile);
  if (id !== ROOT) {
    const st = await fsp.stat(optFile).catch(() => null);
    await profiles.updateMeta(id, (meta) => ({ settingsSync: { ...(meta.settingsSync || {}), appliedAt: at, snapshot: after ? snapshotOf(after) : null, snapshotMtime: st ? st.mtimeMs : null, lastReport: report } }));
  }
  return report;
}

/**
 * 配置抽屉的「同步到其他配置」（1.5.7）：把 fromId 现在的设置直接按版本翻译写进 toIds，不经过、也不改主档。
 * 每个目标单独备份、单独出报告；某个目标失败（游戏开着等）不影响其他的。返回 [{ id, report } | { id, error }]
 */
async function copyBetween(fromId, toIds, { cats } = {}) {
  if (await running(fromId)) throw new Error('来源配置的游戏正在运行，先关掉游戏再同步（游戏退出时才会把设置写进文件）');
  const temp = path.join(paths.cacheDir(), 'gamesync-tmp', String(Date.now()));
  try {
    const src = await targetInfo(fromId);
    if (!(await exists(path.join(src.gameDir, 'options.txt')))) throw new Error('这个配置还没有游戏设置（options.txt），先进一次游戏、在「选项」里调好再同步');
    const { m } = await captureFrom(fromId, { temp });
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const out = [];
    for (const id of toIds || []) {
      if (id === fromId) continue;
      try {
        // 没开隔离、和来源共用一个游戏目录的配置本来就是同一份设置
        if (same((await targetInfo(id)).gameDir, src.gameDir)) { out.push({ id, error: '和来源共用同一个游戏目录，本来就是同一份设置' }); continue; }
        out.push({ id, report: await applyTo(id, { master: m, store: temp, cats, reason: 'copy' }) });
      } catch (e) { out.push({ id, error: e.message }); }
    }
    return out;
  } finally { await rmrf(temp).catch(() => {}); }
}

/** 中间格式拍平成 { 键: 值 }（比较用） */
function snapshotOf(text) {
  const c = fmt.toCanonical(text);
  const out = {};
  for (const [k, v] of Object.entries(c.values)) out[k] = String(v);
  for (const [a, p] of Object.entries(c.keys)) out[`key:${a}`] = `${p.key}|${p.mod || ''}`;
  for (const [k, p] of Object.entries(c.modKeys)) out[k] = `${p.key}|${p.mod || ''}`;
  if (c.packs) out.resourcePacks = JSON.stringify(c.packs);
  return out;
}

/** 撤销最近一次同步：把备份的文件放回去，这次新建的文件删掉 */
async function undo(id) {
  const t = await targetInfo(id);
  if (await running(id)) throw new Error('这个配置的游戏正在运行，等它退出后再撤销');
  const root = path.join(t.gameDir, BAK_DIR);
  const all = (await fsp.readdir(root).catch(() => [])).sort();
  const name = all[all.length - 1];
  if (!name) throw new Error('没有可以撤销的同步');
  const info = await readJson(path.join(root, name, 'backup.json'), null);
  if (!info) throw new Error('备份不完整，没法撤销');
  for (const rel of info.saved) {
    await fsp.mkdir(path.dirname(path.join(t.gameDir, rel)), { recursive: true });
    await fsp.copyFile(path.join(root, name, 'files', rel), path.join(t.gameDir, rel));
  }
  for (const rel of info.created) await fsp.rm(path.join(t.gameDir, rel), { force: true });
  await rmrf(path.join(root, name));
  if (id !== ROOT) {
    await profiles.updateMeta(id, (meta) => ({ settingsSync: { ...(meta.settingsSync || {}), lastReport: null, undoneAt: Date.now() } }));
  }
  return { restored: info.saved.length, removed: info.created.length };
}

// ───────────────────────── 时机 ─────────────────────────
async function modeOf(id) {
  const meta = await profiles.readMeta(id);
  const own = meta.settingsSync && meta.settingsSync.mode;
  return { mode: own && own !== 'default' ? own : settings().mode, own: own || 'default', meta };
}

/** 「每次启动保持一致」：游戏写过 options.txt（修改时间比上次同步新）就把改过的项读回主档 */
async function captureChanges(id) {
  const { meta } = await modeOf(id);
  const s = meta.settingsSync || {};
  if (!s.snapshot) return 0;
  const t = await targetInfo(id);
  const optFile = path.join(t.gameDir, 'options.txt');
  const st = await fsp.stat(optFile).catch(() => null);
  if (!st || (s.snapshotMtime && st.mtimeMs <= s.snapshotMtime + 1)) return 0;
  const text = await readText(optFile);
  const now = snapshotOf(text);
  // 只算原来就有、值变了的。游戏第一次保存时会补上同步时没写的选项（默认值），那些只当成新的基准，不读进主档（实测 1.21.1 补了 menuBackgroundBlurriness、resourcePacks）
  const changed = new Set(Object.keys(now).filter((k) => k in s.snapshot && now[k] !== s.snapshot[k]));
  if (changed.size) await captureFrom(id, { only: changed, at: st.mtimeMs });
  else await learnFrom(t.mc, text, t.loader);
  await profiles.updateMeta(id, (m) => ({ settingsSync: { ...(m.settingsSync || {}), snapshot: now, snapshotMtime: st.mtimeMs } }));
  return changed.size;
}

/**
 * 启动前（launcher.buildLaunch，在隔离之后）。返回给任务显示的说明，或 null
 * 测试启动（一键 Debug 等）不写，免得改了玩家的设置
 */
async function beforeLaunch(id, gameDir, { test } = {}) {
  const s = settings();
  if (!s.enabled || test) return null;
  if (!(await readMaster())) return null;
  const { mode, meta } = await modeOf(id);
  if (mode === 'off') return null;
  // 游戏选项每次从来源复制（存档与隔离），这个配置不参与同步
  if (meta.isolation && require('./isolation').normalize(meta.isolation).items.options === 'copy') return null;
  // 和别的配置共用公共游戏目录、里面已经有设置的，不去动
  if (path.resolve(gameDir).toLowerCase() === path.resolve(versions.gameRoot()).toLowerCase() && (await exists(path.join(gameDir, 'options.txt')))) return null;
  const ss = meta.settingsSync || {};
  if (mode === 'once') {
    const played = ((meta.history && meta.history.launches) || []).some((l) => !l.test);
    if (ss.appliedAt || played) return null;
  } else await captureChanges(id).catch(() => 0);
  const r = await applyTo(id, { reason: mode });
  return r;
}

/** 游戏退出后（ipc 的 game:exit） */
async function afterExit(id, { test } = {}) {
  if (test || !settings().enabled) return 0;
  const { mode } = await modeOf(id);
  if (mode !== 'follow') return 0;
  return captureChanges(id);
}

/** 启动器打开时：游戏退出时启动器没开着（「启动后关闭启动器」）的，补读一次 */
async function startupScan() {
  if (!settings().enabled || !(await readMaster())) return 0;
  let n = 0;
  for (const v of await versions.listInstalled()) {
    if (v.broken) continue;
    try { if ((await modeOf(v.id)).mode === 'follow') n += await captureChanges(v.id); } catch { /* 跳过 */ }
  }
  return n;
}

/** 配置抽屉用：这个配置的同步状态 */
async function profileState(id) {
  const { mode, own, meta } = await modeOf(id);
  const t = await targetInfo(id);
  const ss = meta.settingsSync || {};
  const baks = (await fsp.readdir(path.join(t.gameDir, BAK_DIR)).catch(() => [])).length;
  const copyMode = !!(meta.isolation && require('./isolation').normalize(meta.isolation).items.options === 'copy');
  const hasOptions = await exists(path.join(t.gameDir, 'options.txt'));
  return { enabled: settings().enabled, hasMaster: !!(await readMaster()), mode, own, appliedAt: ss.appliedAt || null, lastReport: ss.lastReport || null, canUndo: baks > 0, copyMode, hasOptions };
}

async function setProfileMode(id, mode) {
  await profiles.updateMeta(id, (meta) => ({ settingsSync: { ...(meta.settingsSync || {}), mode: ['follow', 'once', 'off'].includes(mode) ? mode : 'default' } }));
  return profileState(id);
}

/** 解绑报告里冲突的 Mod 按键（玩家点按钮时），先备份可撤销 */
async function unbindConflicts(id) {
  const t = await targetInfo(id);
  const bak = newBackup(t.gameDir);
  await bak.save('options.txt');
  const before = await require('./integrity').unbindConflicts(t.gameDir);
  await bak.finish();
  return { count: Object.keys(before).length };
}

/**
 * 存档与隔离的「游戏选项：副本」：以前整份复制，现在按两边的版本翻译（来源的全部类别 + Mod 按键），目标里看不懂的行保留
 */
async function translateCopy(srcFile, dstFile, src, dst) {
  const text = await readText(srcFile);
  if (text == null) return false;
  const before = await readText(dstFile);
  const canon = fmt.toCanonical(text);
  const all = fmt.CATEGORIES.map((c) => c.id).filter((c) => !['servers', 'hotbar', 'modSettings', 'modConfig'].includes(c));
  const r = fmt.fromCanonical(before, canon, { mc: dst.mc || '99', loader: dst.loader, dataVersion: await dataVersionOf(dst.mc), schema: await readSchema(dst.mc), cats: all, modKeysFilter: () => !!dst.loader });
  await writeFileSafe(dstFile, r.text);
  return true;
}

module.exports = {
  ROOT, settings, readMaster, summarize, listSources, captureFrom, applyTo, copyBetween, undo, beforeLaunch, afterExit, startupScan,
  profileState, setProfileMode, unbindConflicts, translateCopy, mergeServers, modMajor, configOwner, dataVersionOf, snapshotOf,
};
