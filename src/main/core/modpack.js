'use strict';
/**
 * 整合包：Modrinth .mrpack 的安装与导出
 * 格式说明：https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const paths = require('../engine/paths');
const versions = require('./versions');
const loaders = require('./loaders');
const profiles = require('./profiles');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const mods = require('./mods');
const { downloadAll, downloadFile } = require('../engine/downloader');
const { withZip, ZipWriter } = require('../engine/zip');
const { exists, hashFile, rmrf, renameRetry } = require('../engine/util');
const { safeJoin, fileNameOnly } = require('../engine/fileops');
const { INSTALLING, installingHere } = require('./recover');
const { safeName } = require('../../shared/pathrules');
const { nm } = require('../../shared/i18n');

const LOADER_KEYS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const KEY_OF = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };

/** 读取整合包的索引（不安装）：Modrinth .mrpack / Aurora .aurora / CurseForge .zip */
async function readMrpack(file) {
  return withZip(file, async (z) => {
    const text = await z.readText('modrinth.index.json');
    if (!text) {
      const mf = await z.readText('manifest.json');
      if (!mf) throw new Error('不是有效的整合包（缺少 modrinth.index.json 或 CurseForge 的 manifest.json）');
      let pack;
      try { pack = curseforge.readManifest(mf, path.basename(file, path.extname(file))); } catch { throw new Error('CurseForge 整合包的 manifest.json 已损坏'); }
      const prefix = `${pack.overrides.replace(/\/+$/, '')}/`;
      const overrides = z.entries.filter((e) => !e.isDirectory && e.name.startsWith(prefix));
      return {
        ...pack,
        aurora: null,
        overridePrefix: prefix,
        overrideCount: overrides.length,
        overrideMods: overrides.filter((e) => /\/mods\/[^/]+\.jar$/i.test(e.name)).map((e) => path.basename(e.name)),
      };
    }
    const index = JSON.parse(text);
    const deps = index.dependencies || {};
    let loader = null;
    for (const [k, t] of Object.entries(LOADER_KEYS)) if (deps[k]) { loader = { type: t, version: deps[k] }; break; }
    const overrides = z.entries.filter((e) => !e.isDirectory && /^(client-)?overrides\//.test(e.name));
    let aurora = null;
    const at = await z.readText('aurora-profile.json');
    if (at) { try { aurora = JSON.parse(at); } catch { aurora = null; } }
    return {
      aurora,
      format: aurora ? 'aurora' : 'mrpack',
      name: index.name || path.basename(file, '.mrpack'),
      version: index.versionId || '',
      summary: index.summary || '',
      mc: deps.minecraft,
      loader,
      files: (index.files || []).filter((f) => !(f.env && f.env.client === 'unsupported')),
      overrideCount: overrides.length,
      overrideMods: overrides.filter((e) => /^(client-)?overrides\/mods\/[^/]+\.jar$/i.test(e.name)).map((e) => path.basename(e.name)),
    };
  });
}

// 正在安装的整合包占着的名字：同一个包点两次，文件夹还没建出来时第二次查不到（1.10.8）
const reservedNames = new Set();
async function uniqueName(name) {
  let n = safeName(name, { max: 60, fallback: '整合包' });
  let i = 2;
  const base = n;
  while ((await exists(versions.versionDir(n))) || reservedNames.has(n.toLowerCase())) n = `${base} (${i++})`;
  reservedNames.add(n.toLowerCase());
  return n;
}

async function resolveLoaderFull(loader, mc) {
  if (!loader) return null;
  if (loader.type !== 'forge') return { type: loader.type, version: loader.version };
  try {
    const list = await loaders.list('forge', mc);
    const hit = list.find((x) => x.version === loader.version || x.full === loader.version);
    if (hit) return { type: 'forge', version: hit.version, full: hit.full };
  } catch { /* 使用默认拼接 */ }
  return { type: 'forge', version: loader.version, full: `${mc}-${loader.version}` };
}

/**
 * 安装 .mrpack
 * @param {string} file
 * @param {{name?:string, source?:object}} opts
 */
async function installMrpack(file, opts, task) {
  const pack = await readMrpack(file);
  if (!pack.mc) throw new Error('整合包没有声明 Minecraft 版本');
  const name = await uniqueName(opts.name || pack.name);
  try {
    const id = await installPack(file, pack, name, opts, task);
    if (opts.installingMarker) await fsp.rm(opts.installingMarker, { force: true }).catch(() => {});
    return id;
  } finally {
    reservedNames.delete(name.toLowerCase());
    installingHere.delete(name);
  }
}

async function installPack(file, pack, name, opts, task) {
  task.update({ title: `安装整合包 ${nm(name)}`, detail: `Minecraft ${pack.mc}${pack.loader ? ` · ${pack.loader.type} ${pack.loader.version}` : ''}`, progress: -1 });

  const loader = await resolveLoaderFull(pack.loader, pack.mc);
  try {
    // 没装完就崩了的话，下次启动问玩家删不删（core/recover.js halfPacks）。名字是 uniqueName 给的，这个文件夹一定是这次新建的
    const marker = path.join(versions.versionDir(name), INSTALLING);
    await fsp.mkdir(path.dirname(marker), { recursive: true });
    await fsp.writeFile(marker, 'modpack');
    opts.installingMarker = marker;
    installingHere.add(name);
    await loaders.install({ mc: pack.mc, name, loader }, task);
    await profiles.markProfile(name, 'modpack', {
      name: pack.name,
      description: pack.summary,
      modpack: { name: pack.name, version: pack.version, ...(opts.source || {}) },
    });
    const info = await versions.versionInfo(name);
    const gameDir = versions.gameDirFor(name, info);
    if (pack.format === 'curseforge') {
      const r = await curseforge.downloadPackFiles(pack, gameDir, task);
      task.update({ detail: '解压配置文件…', progress: -1, speed: 0 });
      await withZip(file, (z) => z.extractAll(gameDir, {
        signal: task.signal,
        filter: (e) => e.name.startsWith(pack.overridePrefix) && e.name.length > pack.overridePrefix.length,
        map: (e) => e.name.slice(pack.overridePrefix.length),
      }));
      if (Object.keys(r.entries).length) await profiles.setModInfo(name, r.entries);
      // 作者关闭了第三方下载的文件：之后由玩家在浏览器里下载，启动器自动导入
      if (r.manual.length) await profiles.writeMeta(name, { cfManual: r.manual });
      if (opts.onManual) opts.onManual(r.manual, r.missing);
      return name;
    }
    const dl = pack.files.map((f) => ({
      urls: f.downloads || [],
      path: safeJoin(gameDir, f.path, '整合包'),
      sha1: f.hashes && f.hashes.sha1,
      size: f.fileSize,
    }));
    await downloadAll(dl, { task, label: '下载整合包文件' });

    task.update({ detail: '解压配置文件…', progress: -1, speed: 0 });
    await withZip(file, async (z) => {
      for (const prefix of ['overrides/', 'client-overrides/']) {
        await z.extractAll(gameDir, {
          signal: task.signal,
          filter: (e) => e.name.startsWith(prefix) && e.name.length > prefix.length,
          map: (e) => e.name.slice(prefix.length),
        });
      }
    });

    // 记录 Mod 来源，便于之后检查更新
    const entries = {};
    const pids = new Set();
    for (const f of pack.files) {
      if (!/^mods\/[^/]+$/.test(f.path)) continue;
      const ids = (f.downloads || []).map(modrinth.parseCdnUrl).find(Boolean);
      if (!ids) continue;
      entries[path.basename(f.path)] = { projectId: ids.projectId, versionId: ids.versionId, source: 'modrinth' };
      pids.add(ids.projectId);
    }
    try {
      const projs = await modrinth.projects([...pids]);
      const byId = new Map(projs.map((p) => [p.id, p]));
      for (const e of Object.values(entries)) {
        const p = byId.get(e.projectId);
        if (p) Object.assign(e, { slug: p.slug, title: p.title, icon: p.icon });
      }
    } catch { /* 仅用于显示 */ }
    if (Object.keys(entries).length) await profiles.setModInfo(name, entries);
    if (pack.aurora) await applyAuroraProfile(name, pack.aurora);
  } catch (e) {
    // 取消或失败都不留半个配置（以前只有取消才清）：名字是 uniqueName 新取的，文件夹里没有玩家的东西
    await discard(name);
    throw e;
  }
  return name;
}

/** 清掉这次新建的整合包配置。不进回收站：里面只有下载了一半的文件 */
async function discard(id) {
  await versions.removeVersion(id, { permanent: true }).catch((e) => console.warn(`[modpack] 清理 ${id} 失败`, e.message));
}

/** 导入 Aurora 配置包时恢复配置信息（不恢复与本机相关的路径与 Java） */
async function applyAuroraProfile(id, a) {
  const config = require('../engine/config');
  const isolation = require('./isolation');
  await profiles.writeMeta(id, {
    type: a.type || 'modpack',
    name: a.name || undefined,
    description: a.description || '',
    presets: Array.isArray(a.presets) ? a.presets : [],
    activePreset: a.activePreset || null,
    importedFrom: { at: Date.now(), source: a.exportedFrom || null, exportedAt: a.exportedAt || null },
  });
  const s = a.settings || {};
  const keep = {};
  for (const k of ['memoryMode', 'memoryMax', 'jvmArgs', 'gameArgs', 'window', 'server']) if (s[k] !== undefined) keep[k] = s[k];
  if (Object.keys(keep).length) config.setVersionSettings(id, keep);
  // 隔离策略中引用的其他配置在别的电脑上不存在，只保留以公共目录为来源的策略
  if (a.isolation && a.isolation.source === '@root') await isolation.setPolicy(id, a.isolation).catch(() => {});
}

async function installFromModrinth({ projectId, versionId, name, icon, title }, task) {
  const v = versionId ? await modrinth.version(versionId) : modrinth.bestVersion(await modrinth.projectVersions(projectId, { type: 'modpack' }));
  if (!v) throw new Error('没有找到可用的整合包版本');
  const file = v.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) || v.files.find((f) => f.filename.endsWith('.mrpack'));
  if (!file) throw new Error('该版本没有 .mrpack 文件');
  const dest = path.join(paths.cacheDir(), 'modpacks', fileNameOnly(file.filename, 'modpack.mrpack'));
  await downloadFile({ urls: [file.url], path: dest, sha1: file.sha1, size: file.size }, { task, label: '下载整合包' });
  try {
    return await installMrpack(dest, { name: name || title, source: { projectId: v.projectId, versionId: v.id, versionNumber: v.number, icon, title } }, task);
  } finally {
    await fsp.rm(dest, { force: true }).catch(() => {});
  }
}

/**
 * 把游戏配置导出为 .mrpack：能在 Modrinth 上找到的 Mod 以下载链接形式写入，其余文件打包进 overrides
 */
async function exportMrpack(versionId, dest, opts = {}, task) {
  const { name, version = '1.0.0', summary = '', include = ['config', 'resourcepacks', 'shaderpacks', 'options.txt'] } = opts;
  const info = await versions.versionInfo(versionId);
  if (!info) throw new Error('版本不存在');
  const gameDir = versions.gameDirFor(versionId, info);
  const { mods: list } = await mods.listMods(versionId, { withHash: true });
  const enabled = list.filter((m) => m.enabled);
  task.update({ detail: '在 Modrinth 上识别 Mod…', progress: -1 });
  // 没网或者接口出错时也能导出：认不出来的 Mod 打包进文件（2.0.0-pre8）
  const found = enabled.length ? await modrinth.identify(enabled.map((m) => m.sha1)).catch(() => ({})) : {};

  const files = [];
  const overrides = [];
  let i = 0;
  for (const m of enabled) {
    task.update({ detail: `处理 ${nm(m.file)}`, progress: (i++ / Math.max(1, enabled.length)) * 0.6 });
    const v = found[m.sha1];
    const f = v && v.files.find((x) => x.sha1 === m.sha1);
    if (f) {
      files.push({
        path: `mods/${m.file}`,
        hashes: { sha1: m.sha1, sha512: f.sha512 || (await hashFile(m.path, 'sha512')) },
        env: { client: 'required', server: 'required' },
        downloads: [f.url],
        fileSize: m.size,
      });
    } else {
      overrides.push(m);
    }
  }
  const deps = { minecraft: info.mcVersion };
  if (info.loader && KEY_OF[info.loader.type] && info.loader.version) deps[KEY_OF[info.loader.type]] = info.loader.version;
  const index = { formatVersion: 1, game: 'minecraft', versionId: version, name: name || versionId, summary, files, dependencies: deps };

  const tmp = `${dest}.tmp`;
  const w = await ZipWriter.create(tmp);
  try {
    await w.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'));
    if (opts.aurora) {
      // Aurora 配置包：在 mrpack 的基础上附带完整的配置档案
      const meta = await profiles.detail(versionId);
      const clean = JSON.parse(JSON.stringify(meta));
      if (clean.game) delete clean.game.gameDir;
      if (clean.settings) delete clean.settings.java;
      for (const c of (clean.history && clean.history.crashes) || []) { delete c.logFile; delete c.reportPath; }
      clean.exportedAt = Date.now();
      clean.exportedFrom = versionId;
      await w.addBuffer('aurora-profile.json', Buffer.from(JSON.stringify(clean, null, 2), 'utf8'));
    }
    for (const m of overrides) await w.addFile(`overrides/mods/${m.file}`, m.path);
    task.update({ detail: '打包配置文件…', progress: 0.8 });
    for (const item of include) {
      const p = path.join(gameDir, item);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await w.addDir(`overrides/${item}`, p);
      else await w.addFile(`overrides/${item}`, p);
    }
    await w.close();
    await fsp.rm(dest, { force: true });
    await renameRetry(tmp, dest);
  } catch (e) {
    if (w.fh) await w.fh.close().catch(() => {});
    await rmrf(tmp).catch(() => {});
    throw e;
  }
  return { file: dest, modrinth: files.length, bundled: overrides.length };
}

module.exports = { readMrpack, installMrpack, installFromModrinth, exportMrpack, uniqueName, discard };
