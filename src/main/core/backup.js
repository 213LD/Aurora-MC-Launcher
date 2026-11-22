'use strict';
/**
 * 存档与游戏设置的备份和恢复。
 *
 * 存放：<数据目录>/backups/<配置>/<时间>-<类型>[-auto-<原因>].zip，zip 里的 aurora-backup.json 记录内容。
 * 类型：
 *   saves     存档（可以只选部分世界）
 *   settings  游戏设置（options.txt 等，可选连同 config/）
 *   mods      Mod 和 Mod 配置（自动备份用：一键 Debug、更新 Mod 之前）
 *   full      整个配置：Mod、配置、资源包、光影、存档、游戏设置
 * 自动备份文件名带 -auto-<原因>，按「每个配置每种原因保留最近 N 份 + 总大小上限」清理；手动备份不会被自动删除。
 * 删除配置前的旧备份是文件夹（<时间>-saves），照样列出、能恢复和删除。
 */
const path = require('path');
const fsp = require('fs').promises;
const config = require('../engine/config');
const paths = require('../engine/paths');
const versions = require('./versions');
const profiles = require('./profiles');
const isolation = require('./isolation');
const gamelock = require('./gamelock');
const { under, safeJoin, copyDir, replaceDir } = require('../engine/fileops');
const nbt = require('../engine/nbt');
const { ZipWriter, ZipReader } = require('../engine/zip');
const { exists, safeTrash, renameRetry } = require('../engine/util');
const { nm } = require('../../shared/i18n');

const FORMAT = 1;
const MANIFEST = 'aurora-backup.json';
const SETTINGS_FILES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat', 'hotbar.nbt'];
const MOD_DIRS = ['mods', 'config', 'defaultconfigs', 'kubejs'];
const FULL_DIRS = [...MOD_DIRS, 'resourcepacks', 'shaderpacks'];
const TYPES = ['saves', 'settings', 'mods', 'full'];
const AUTO_REASONS = ['launch', 'debug', 'modupdate', 'restore', 'delete', 'component'];
const SKIP_FILE = /(^|[\\/])session\.lock$/i;

const safeId = (id) => String(id).slice(0, 200).replace(/[\\/:*?"<>|]/g, '_').replace(/^[. ]+$/, '_');
const root = () => path.join(paths.dataDir(), 'backups');
const dirOf = (id) => path.join(root(), safeId(id));
const norm = (p) => path.resolve(p).toLowerCase();
const cancelled = () => Object.assign(new Error('已取消'), { cancelled: true });

function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

async function realpath(p) { try { return await fsp.realpath(p); } catch { return p; } }

// ───────────────────────── 配置的目录 ─────────────────────────
/** 配置的游戏目录、存档实际所在的目录（共享存档时是来源的目录）和来源说明 */
async function ctxOf(id) {
  const info = await versions.versionInfo(id);
  if (!info) throw new Error('配置不存在');
  const gameDir = versions.gameDirFor(id, info);
  const savesLink = path.join(gameDir, 'saves');
  const linked = await isolation.isLink(savesLink);
  const shared = norm(gameDir) === norm(versions.gameRoot());
  const policy = await isolation.getPolicy(id);
  const meta = await profiles.readMeta(id);
  return {
    id, info, gameDir, meta,
    saves: await realpath(savesLink),
    // own 独立 / link 共享来源的存档 / copy 测试副本 / root 直接用公共游戏目录
    savesMode: shared ? 'root' : linked ? 'link' : policy.items.saves === 'copy' ? 'copy' : 'own',
    savesSource: linked ? policy.source : null,
  };
}

/** 有没有正在运行的游戏在用这个目录（存档 / 游戏目录） */
async function busy(ctx) {
  const g = await gamelock.forPath(ctx.saves);
  return g ? { saves: true, game: norm(g.gameDir) === norm(ctx.gameDir) } : { saves: false, game: false };
}

async function dirSize(dir) {
  let bytes = 0; let files = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { files++; bytes += (await fsp.stat(p).catch(() => ({ size: 0 }))).size; }
    }
  };
  await walk(dir);
  return { bytes, files };
}

// ───────────────────────── 存档列表 ─────────────────────────
async function worldNames(savesDir) {
  const out = [];
  for (const e of await fsp.readdir(savesDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.includes('.aurora')) continue;
    if (await exists(path.join(savesDir, e.name, 'level.dat'))) out.push(e.name);
  }
  return out;
}

/** 存档管理用：世界列表（名称、图标、最后游玩、大小、模式）和存档来源 */
async function worlds(id) {
  const ctx = await ctxOf(id);
  const list = [];
  for (const name of await worldNames(ctx.saves)) {
    const dir = path.join(ctx.saves, name);
    const lv = await nbt.levelInfo(path.join(dir, 'level.dat'));
    const st = await fsp.stat(path.join(dir, 'level.dat')).catch(() => null);
    const size = await dirSize(dir);
    let iconData = null;
    const ic = await fsp.readFile(path.join(dir, 'icon.png')).catch(() => null);
    if (ic && ic.length < 256 * 1024) iconData = `data:image/png;base64,${ic.toString('base64')}`;
    list.push({
      name, dir,
      displayName: (lv && lv.name) || name,
      lastPlayed: (lv && lv.lastPlayed) || (st ? st.mtimeMs : 0),
      gameType: lv ? lv.gameType : null,
      hardcore: !!(lv && lv.hardcore),
      version: lv ? lv.version : null,
      size: size.bytes,
      icon: iconData,
    });
  }
  list.sort((a, b) => b.lastPlayed - a.lastPlayed);
  const b = await busy(ctx);
  return { savesDir: ctx.saves, mode: ctx.savesMode, source: ctx.savesSource, running: b.saves, worlds: list };
}

// ───────────────────────── 备份 ─────────────────────────
/** 一次备份要放进去的东西：[{ zip: 'saves/W', src, dir: true }] */
async function plan(ctx, opts) {
  const type = opts.type;
  const items = [];
  const skipped = [];
  const addDir = async (name) => {
    const p = path.join(ctx.gameDir, name);
    if (!(await exists(p))) return;
    if (await isolation.isLink(p)) { skipped.push(name); return; } // 共享来的属于来源配置
    items.push({ zip: name, src: p, dir: true, part: name === 'mods' ? 'mods' : 'dirs' });
  };
  let worldsIn = [];
  if (type === 'saves' || type === 'full') {
    if (type === 'full' && ctx.savesMode === 'link') skipped.push('saves');
    else {
      const all = await worldNames(ctx.saves);
      worldsIn = Array.isArray(opts.worlds) ? all.filter((w) => opts.worlds.includes(w)) : all;
      for (const w of worldsIn) items.push({ zip: `saves/${w}`, src: path.join(ctx.saves, w), dir: true, part: 'saves', world: w });
    }
  }
  if (type === 'settings' || type === 'full') {
    for (const f of SETTINGS_FILES) {
      const p = path.join(ctx.gameDir, f);
      if (await exists(p)) items.push({ zip: f, src: p, dir: false, part: 'settings' });
    }
  }
  if (type === 'settings' && opts.config) await addDir('config');
  if (type === 'mods') for (const d of MOD_DIRS) await addDir(d);
  if (type === 'full') for (const d of FULL_DIRS) await addDir(d);
  return { items, worlds: worldsIn, skipped };
}

/**
 * 备份。opts: { type, worlds?: 世界文件夹名, config?: 设置连同 config/, note?, auto?: 自动备份原因 }
 * 返回备份条目（和 list 里的一样）
 */
async function create(id, opts = {}, task) {
  if (!TYPES.includes(opts.type)) throw new Error(`未知的备份类型：${opts.type}`);
  const ctx = await ctxOf(id);
  const b = await busy(ctx);
  const { items, worlds: worldsIn, skipped } = await plan(ctx, opts);
  if (b.saves && items.some((i) => i.part === 'saves')) {
    throw new Error('游戏正在运行，存档还在被写入。等游戏退出后再备份存档（运行中可以备份游戏设置）');
  }
  if (!items.length) throw new Error(opts.type === 'saves' ? '没有可以备份的世界' : '没有可以备份的文件');

  const dir = dirOf(id);
  await fsp.mkdir(dir, { recursive: true });
  let base = `${stamp()}-${opts.type}${opts.auto ? `-auto-${opts.auto}` : ''}`;
  for (let i = 2; await exists(path.join(dir, `${base}.zip`)); i++) base = `${base.replace(/_\d+$/, '')}_${i}`;
  const file = path.join(dir, `${base}.zip`);
  const part = `${file}.part`;

  // 先数文件数，用来显示进度
  let total = 0;
  for (const it of items) total += it.dir ? (await dirSize(it.src)).files : 1;
  let done = 0;
  const signal = task && task.signal;
  const tick = (name) => {
    done++;
    if (task && (done % 20 === 0 || done === total)) task.update({ progress: total ? done / total : -1, detail: `${done}/${total} · ${name}`, files: { done, total, active: 0, failed: 0 } });
  };

  const w = await ZipWriter.create(part);
  let bytes = 0;
  try {
    for (const it of items) {
      if (signal && signal.aborted) throw cancelled();
      if (it.dir) {
        await w.addDir(it.zip, it.src, (name) => !SKIP_FILE.test(name), { signal, onFile: (name) => tick(name) });
      } else {
        await w.addFile(it.zip, it.src, { signal });
        tick(it.zip);
      }
    }
    bytes = w.entries.reduce((s, e) => s + e.size, 0);
    const v = ctx.info;
    const manifest = {
      format: FORMAT,
      app: BRAND_APP(),
      profile: id,
      profileName: ctx.meta.name || null,
      minecraft: v.mcVersion || null,
      loader: v.loader ? { type: v.loader.type, version: v.loader.version || null } : null,
      type: opts.type,
      auto: opts.auto || null,
      note: opts.note || '',
      createdAt: Date.now(),
      worlds: await Promise.all(worldsIn.map(async (n) => {
        const lv = await nbt.levelInfo(path.join(ctx.saves, n, 'level.dat'));
        return { name: n, displayName: (lv && lv.name) || n };
      })),
      savesSource: worldsIn.length ? { mode: ctx.savesMode, source: ctx.savesSource } : null,
      parts: [...new Set(items.map((i) => i.part))],
      dirs: items.filter((i) => i.dir && i.part !== 'saves').map((i) => i.zip),
      files: items.filter((i) => !i.dir).map((i) => i.zip),
      skipped,
      size: bytes,
    };
    await w.addBuffer(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
    await w.close();
    await renameRetry(part, file);
  } catch (e) {
    await w.abort();
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  }
  await prune().catch(() => {});
  return entryOf(file);
}

function BRAND_APP() {
  try { return require('electron').app.getVersion(); } catch { return ''; }
}

// ───────────────────────── 列表 ─────────────────────────
const cache = new Map(); // file → { mtime, entry }

async function entryOf(file) {
  const st = await fsp.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.entry;
  let m = null;
  try {
    const z = await ZipReader.open(file);
    try { m = JSON.parse(await z.readText(MANIFEST)); } finally { await z.close(); }
  } catch { m = null; }
  const name = path.basename(file);
  const auto = (name.match(/-auto-([a-z]+)/) || [])[1] || null;
  const entry = m ? {
    file, name, size: st.size, createdAt: m.createdAt || st.mtimeMs, profile: m.profile, profileName: m.profileName,
    type: m.type, auto: m.auto || auto, note: m.note || '', worlds: m.worlds || [], parts: m.parts || [], dirs: m.dirs || [], files: m.files || [],
    skipped: m.skipped || [], minecraft: m.minecraft, loader: m.loader, savesSource: m.savesSource || null, contentSize: m.size || 0,
  } : { file, name, size: st.size, createdAt: st.mtimeMs, broken: true, type: (name.match(/-(saves|settings|mods|full)/) || [])[1] || 'saves', auto, worlds: [], parts: [] };
  cache.set(file, { mtime: st.mtimeMs, entry });
  return entry;
}

/** 删除配置前的旧备份（文件夹）：里面直接是世界文件夹，暂存的在 aurora-own/ 下 */
async function legacyEntry(dir, profile) {
  const st = await fsp.stat(dir);
  const worldsIn = [];
  const named = async (base, n) => ((await nbt.levelInfo(path.join(base, n, 'level.dat'))) || {}).name || n;
  for (const n of await worldNames(dir)) worldsIn.push({ name: n, displayName: await named(dir, n) });
  for (const n of await worldNames(path.join(dir, 'aurora-own'))) worldsIn.push({ name: `aurora-own/${n}`, displayName: await named(path.join(dir, 'aurora-own'), n) });
  const m = path.basename(dir).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  // 旧备份的时间是 UTC（toISOString）
  const at = m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : st.mtimeMs;
  return { file: dir, name: path.basename(dir), legacy: true, size: (await dirSize(dir)).bytes, createdAt: at, profile, type: 'saves', auto: 'delete', worlds: worldsIn, parts: ['saves'], dirs: [], files: [] };
}

async function listDir(dir, profile) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isFile() && /\.zip$/i.test(e.name)) out.push(await entryOf(p).catch(() => null));
    else if (e.isDirectory() && /^\d{8}-\d{6}-saves/.test(e.name)) out.push(await legacyEntry(p, profile).catch(() => null));
  }
  return out.filter(Boolean).map((x) => ({ ...x, profile: x.profile || profile }));
}

/** 某个配置的备份（新的在前）；others: true 时也列出其他配置（含已删除的）的存档备份 */
async function list(id, { others = false } = {}) {
  const own = await listDir(dirOf(id), id);
  let other = [];
  if (others) {
    for (const e of await fsp.readdir(root(), { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name === safeId(id)) continue;
      other.push(...(await listDir(path.join(root(), e.name), e.name)).filter((x) => x.worlds.length));
    }
  }
  const by = (a, b) => b.createdAt - a.createdAt;
  return { dir: dirOf(id), own: own.sort(by), others: other.sort(by) };
}

// ───────────────────────── 恢复 ─────────────────────────
/** 恢复为新世界时找一个不重名的文件夹名 */
async function uniqueName(savesDir, base) {
  if (!(await exists(path.join(savesDir, base)))) return base; // 现在没有同名世界就用原名
  let name = `${base} (恢复)`;
  for (let i = 2; await exists(path.join(savesDir, name)); i++) name = `${base} (恢复 ${i})`;
  return name;
}

/** 从备份（zip 或旧的文件夹）取出一个前缀下的全部内容到目标目录 */
async function extractPrefix(src, prefix, dest, signal) {
  if (src.zip) {
    const pre = `${prefix}/`;
    for (const e of src.zip.entries) {
      if (signal && signal.aborted) throw cancelled();
      if (!e.name.startsWith(pre) || e.isDirectory) continue;
      const rel = e.name.slice(pre.length);
      let to;
      try { to = safeJoin(dest, rel, '备份'); } catch { continue; } // 防路径穿越
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await src.zip.extractTo(e, to);
    }
  } else {
    await copyDir(path.join(src.dir, prefix), dest, { filter: (rel) => !SKIP_FILE.test(rel) });
  }
}

/**
 * 恢复。opts: {
 *   worlds?: 要恢复的世界（备份里的名称，默认全部），mode: 'overwrite' 覆盖同名 | 'new' 恢复为新世界（自动改名）,
 *   parts?: ['saves','settings','mods','dirs'] 要恢复的部分（默认全部）, noAuto?: 不先备份当前状态（撤销时用）
 * }
 * 返回 { worlds: [{ from, to, replaced }], files, dirs, skipped, undo }
 */
async function restore(id, file, opts = {}, task) {
  const ctx = await ctxOf(id);
  const b = await busy(ctx);
  if (b.game || b.saves) throw new Error('游戏正在运行。先关掉游戏再恢复');
  const legacy = !/\.zip$/i.test(file);
  const entry = legacy ? await legacyEntry(file, null) : await entryOf(file);
  if (entry.broken) throw new Error('这个备份文件损坏了，读不出内容');
  const crossProfile = !legacy && entry.profile && entry.profile !== id;
  let parts = Array.isArray(opts.parts) && opts.parts.length ? opts.parts : entry.parts;
  if (crossProfile || legacy) parts = parts.filter((p) => p === 'saves'); // 其他配置的备份只恢复存档
  const mode = opts.mode === 'new' ? 'new' : 'overwrite';
  const pick = Array.isArray(opts.worlds) ? entry.worlds.filter((w) => opts.worlds.includes(w.name)) : entry.worlds;
  const doSaves = parts.includes('saves') && pick.length;
  const doSettings = parts.includes('settings') && entry.files.length;
  const dirsIn = entry.dirs.filter((d) => parts.includes(d === 'mods' ? 'mods' : 'dirs'));
  if (!doSaves && !doSettings && !dirsIn.length) throw new Error('没有选要恢复的内容');

  // 覆盖前先把当前状态备份一份，用来撤销
  let undoBackup = null;
  if (!opts.noAuto) {
    const existing = mode === 'overwrite' && doSaves ? (await worldNames(ctx.saves)).filter((w) => pick.some((p) => path.basename(p.name) === w)) : [];
    const needFull = doSettings || dirsIn.length;
    if (existing.length || needFull) {
      if (task) task.update({ detail: '先备份当前状态…', progress: -1 });
      const t = needFull ? (entry.type === 'saves' ? 'settings' : entry.type) : 'saves';
      try {
        undoBackup = await create(id, { type: t, worlds: existing, config: dirsIn.includes('config'), auto: 'restore', note: `恢复 ${entry.name} 之前` });
      } catch (e) {
        if (!/没有可以备份/.test(e.message)) throw new Error(`恢复前备份当前状态失败，已停止恢复：${e.message}`);
      }
    }
  }

  const src = legacy ? { dir: file } : { zip: await ZipReader.open(file) };
  const out = { worlds: [], files: 0, dirs: [], skipped: [], created: [], undo: undoBackup ? undoBackup.file : null };
  const signal = task && task.signal;
  try {
    if (doSaves) {
      await fsp.mkdir(ctx.saves, { recursive: true });
      let n = 0;
      for (const w of pick) {
        if (task) task.update({ detail: `恢复世界 ${nm(w.displayName)}（${++n}/${pick.length}）`, progress: n / (pick.length + 1) });
        const baseName = path.basename(w.name);
        const to = mode === 'new' ? await uniqueName(ctx.saves, baseName) : baseName;
        const target = path.join(ctx.saves, to);
        const replaced = await replaceDir(target, (d) => extractPrefix(src, legacy ? w.name : `saves/${w.name}`, d, signal));
        if (to !== baseName) await nbt.setLevelName(path.join(target, 'level.dat'), `${w.displayName} (恢复)`).catch(() => {});
        if (!replaced) out.created.push(target);
        out.worlds.push({ from: w.name, to, replaced });
      }
    }
    if (doSettings) {
      for (const f of entry.files) {
        const e = src.zip.getEntry(f);
        if (!e) continue;
        await src.zip.extractTo(e, safeJoin(ctx.gameDir, f, '备份'));
        out.files++;
      }
    }
    for (const d of dirsIn) {
      const target = safeJoin(ctx.gameDir, d, '备份');
      if (await isolation.isLink(target)) { out.skipped.push(d); continue; } // 共享的目录不改来源
      if (task) task.update({ detail: `恢复 ${d}…`, progress: -1 });
      const replaced = await replaceDir(target, (dd) => extractPrefix(src, d, dd, signal));
      if (!replaced) out.created.push(target);
      out.dirs.push(d);
    }
  } finally {
    if (src.zip) await src.zip.close();
  }
  return out;
}

/** 撤销一次恢复：恢复前的自动备份放回去，新建出来的世界 / 目录移到回收站 */
async function undoRestore(id, { undo, created = [] } = {}, task) {
  const r = { trashed: [], restored: null };
  for (const p of created) {
    if (!(await exists(p))) continue;
    await safeTrash(p);
    r.trashed.push(p);
  }
  if (undo) r.restored = await restore(id, undo, { mode: 'overwrite', noAuto: true }, task);
  return r;
}

// ───────────────────────── 删除、清理、占用 ─────────────────────────
function insideRoot(p) {
  if (path.resolve(p) === path.resolve(root()) || !under(p, root())) throw new Error('只能删除备份文件夹里的文件');
}

async function remove(file) {
  insideRoot(file);
  await fsp.rm(file, { recursive: true, force: true });
  cache.delete(file);
  return true;
}

/** 删除一个世界（进回收站） */
async function deleteWorld(id, name) {
  const ctx = await ctxOf(id);
  if ((await busy(ctx)).saves) throw new Error('游戏正在运行，先关掉游戏再删除世界');
  const p = path.join(ctx.saves, name);
  if (path.dirname(p) !== ctx.saves || !(await exists(path.join(p, 'level.dat')))) throw new Error('找不到这个世界');
  await safeTrash(p);
  return p;
}

async function allEntries() {
  const out = [];
  for (const e of await fsp.readdir(root(), { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    for (const f of await fsp.readdir(path.join(root(), e.name), { withFileTypes: true }).catch(() => [])) {
      const p = path.join(root(), e.name, f.name);
      if (f.isFile() && /\.zip$/i.test(f.name)) {
        const st = await fsp.stat(p).catch(() => null);
        if (st) out.push({ file: p, profile: e.name, size: st.size, at: st.mtimeMs, auto: (f.name.match(/-auto-([a-z]+)/) || [])[1] || null });
      } else if (f.isDirectory() && /^\d{8}-\d{6}-saves/.test(f.name)) {
        const st = await fsp.stat(p).catch(() => null);
        if (st) out.push({ file: p, profile: e.name, size: (await dirSize(p)).bytes, at: st.mtimeMs, auto: null, legacy: true });
      }
    }
  }
  return out;
}

/** 自动备份的保留策略：每个配置每种原因留最近 keepAuto 份；自动备份总大小超过上限时从最旧的删。手动备份不动 */
async function prune() {
  const cfg = config.get().backup || {};
  const keep = Math.max(1, Number(cfg.keepAuto) || 5);
  const cap = Math.max(1, Number(cfg.maxTotalGB) || 20) * 1024 ** 3;
  const autos = (await allEntries()).filter((e) => e.auto).sort((a, b) => b.at - a.at);
  const removed = [];
  const seen = new Map();
  const kept = [];
  for (const e of autos) {
    const k = `${e.profile}|${e.auto}`;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > keep) { await remove(e.file).catch(() => {}); removed.push(e.file); } else kept.push(e);
  }
  // 超过总大小上限：从最旧的删，但删除配置前的备份不按大小删（配置已经没了，这是存档仅剩的一份）
  const capped = kept.filter((e) => e.auto !== 'delete');
  let total = capped.reduce((s, e) => s + e.size, 0);
  for (let i = capped.length - 1; i >= 0 && total > cap; i--) {
    await remove(capped[i].file).catch(() => {});
    removed.push(capped[i].file);
    total -= capped[i].size;
  }
  return removed;
}

/** 设置页：备份占了多少空间 */
async function usage() {
  const all = await allEntries();
  const installed = new Set((await versions.listInstalled()).map((v) => safeId(v.id)));
  const by = new Map();
  for (const e of all) {
    const p = by.get(e.profile) || { profile: e.profile, exists: installed.has(e.profile), size: 0, count: 0, auto: 0 };
    p.size += e.size; p.count++; if (e.auto) p.auto++;
    by.set(e.profile, p);
  }
  return {
    dir: root(),
    total: all.reduce((s, e) => s + e.size, 0),
    autoSize: all.filter((e) => e.auto).reduce((s, e) => s + e.size, 0),
    count: all.length,
    autoCount: all.filter((e) => e.auto).length,
    profiles: [...by.values()].sort((a, b) => b.size - a.size),
  };
}

/** 清理：auto 只删自动备份；profile 删某个配置的全部备份 */
async function clean({ autoOnly = true, profile = null } = {}) {
  let n = 0;
  for (const e of await allEntries()) {
    if (profile && e.profile !== profile) continue;
    if (autoOnly && !e.auto) continue;
    await remove(e.file).catch(() => {});
    n++;
  }
  return n;
}

// ───────────────────────── 自动备份 ─────────────────────────
/**
 * 按设置自动备份。reason：
 *   launch    启动前备份存档（默认关；存档自上次自动备份后没变就跳过）
 *   debug / modupdate  一键 Debug、更新 Mod 之前备份 Mod 和配置（默认开）
 * 失败不挡住后面的操作，返回 { entry } 或 { skipped } 或 { error }
 */
async function auto(id, reason, task) {
  const cfg = config.get().backup || {};
  try {
    if (reason === 'launch') {
      if (!cfg.beforeLaunch) return { skipped: 'off' };
      const ctx = await ctxOf(id);
      if (ctx.savesMode === 'copy') return { skipped: 'sandbox' }; // 测试副本，原存档不会被改
      const names = await worldNames(ctx.saves);
      if (!names.length) return { skipped: 'empty' };
      let latest = 0;
      for (const n of names) {
        const st = await fsp.stat(path.join(ctx.saves, n, 'level.dat')).catch(() => null);
        if (st) latest = Math.max(latest, st.mtimeMs);
      }
      const last = (await listDir(dirOf(id), id)).filter((e) => e.auto === 'launch').sort((a, b) => b.createdAt - a.createdAt)[0];
      if (last && last.createdAt > latest) return { skipped: 'unchanged' };
      if (task) task.update({ detail: '启动前备份存档…', progress: -1 });
      return { entry: await create(id, { type: 'saves', auto: 'launch' }, task && { update: (p) => task.update({ ...p, detail: `启动前备份存档 · ${p.detail || ''}` }), signal: task.signal }) };
    }
    if (reason === 'debug' || reason === 'modupdate') {
      if (cfg.beforeModChange === false) return { skipped: 'off' };
      const ctx = await ctxOf(id);
      if (!(await exists(path.join(ctx.gameDir, 'mods')))) return { skipped: 'empty' };
      if (task) task.update({ detail: '先备份 Mod 和配置…', progress: -1 });
      return { entry: await create(id, { type: 'mods', auto: reason }) };
    }
    return { skipped: 'unknown' };
  } catch (e) {
    if (e.cancelled) throw e;
    return { error: e.message };
  }
}

module.exports = { dirSize, TYPES, AUTO_REASONS, SETTINGS_FILES, worlds, create, list, restore, undoRestore, remove, deleteWorld, prune, usage, clean, auto, root, dirOf };
