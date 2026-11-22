'use strict';
/**
 * CurseForge（Core API v1）
 * https://docs.curseforge.com/rest-api/
 * - 设置里填了 API Key：直接访问 api.curseforge.com
 * - 没填（或 Key 无效）：通过社区代理 api.curse.tools（不需要密钥；2026-10 起地址是 /v1，也支持批量查询和指纹识别；
 *   会拦截通用的 User-Agent，net.js 发的「AuroraLauncher/版本」可以通过）
 * - 作者关闭了第三方下载的文件不会被绕过：downloadUrl 为空，或项目的 allowModDistribution 为 false
 *   （社区代理会自己补上下载地址，所以两个都要看），记录到配置档案的 cfManual，由玩家在浏览器里下载，
 *   启动器从「下载」文件夹自动导入
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { request, HttpError, shortUrl } = require('../engine/net');
const { pool, exists, hashFile, abortError, safeTrash, capMap } = require('../engine/util');
const { safeJoin, fileNameOnly } = require('../engine/fileops');

const GAME = 432;
const CLASS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552 };
const KIND_OF_CLASS = { 6: 'mod', 4471: 'modpack', 12: 'resourcepack', 6552: 'shader' };
const FOLDER_OF_CLASS = { 6: 'mods', 12: 'resourcepacks', 6552: 'shaderpacks' };
const URL_PART = { mod: 'mc-mods', modpack: 'modpacks', resourcepack: 'texture-packs', shader: 'shaders' };
// ModLoaderType：Quilt 可以加载 Fabric Mod，CurseForge 上大多数 Mod 只标了 Fabric
const LOADER_TYPE = { forge: 1, fabric: 4, quilt: 4, legacyfabric: 4, neoforge: 6 };
// ModsSearchSortField：2 热度 3 最近更新 6 总下载 11 发布时间 12 评分
const SORT = { relevance: 2, downloads: 6, follows: 12, newest: 11, updated: 3 };
const RELEASE = { 1: 'release', 2: 'beta', 3: 'alpha' };
const DEP = { 1: 'embedded', 2: 'optional', 3: 'required', 4: 'tool', 5: 'incompatible', 6: 'include' };
const PROXY = 'https://api.curse.tools/v1';
const OFFICIAL = 'https://api.curseforge.com/v1';

const TTL = 10 * 60 * 1000;
const cache = new Map();
// 1.4.30：存到磁盘（apicache.js），重启后也能用，断网时退回旧的结果；cache 只给下面批量取项目用
const cached = (key, fn, ttl = TTL) => require('../engine/apicache').get('curseforge', key, fn, ttl);
const { nm } = require('../../shared/i18n');

function settings() {
  const c = require('../engine/config').get().curseforge || {};
  return { apiKey: String(c.apiKey || '').trim(), proxy: c.proxy !== false };
}

function endpoints() {
  const s = settings();
  const list = [];
  if (s.apiKey) list.push({ id: 'official', base: OFFICIAL, headers: { 'x-api-key': s.apiKey }, post: true });
  if (s.proxy) list.push({ id: 'proxy', base: PROXY, headers: {}, post: true });
  return list;
}

const hasOfficial = () => !!settings().apiKey;
const available = () => endpoints().length > 0;

function cfError(message, reason) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

// 最近一次成功用的接口，以及官方 Key 有没有被拒（设置页「测试连接」显示）
const status = { via: '', keyRejected: false };

/** 依次尝试官方接口与社区代理 */
async function call(p, { method = 'GET', body, timeout = 20000, signal } = {}) {
  const eps = endpoints().filter((e) => method === 'GET' || e.post);
  if (!eps.length) {
    throw cfError('没有可用的 CurseForge 接口：请在「设置 → CurseForge」填写 API Key，或打开社区代理', 'CF_NO_ENDPOINT');
  }
  let last = null;
  for (const ep of eps) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { res, done } = await request(ep.base + p, { method, headers: { Accept: 'application/json', ...ep.headers }, json: body, timeout, signal });
        try {
          if (!res.ok) {
            let text = '';
            try { text = await res.text(); } catch { /* ignore */ }
            throw new HttpError(res.status, ep.base + p, text);
          }
          const json = await res.json();
          status.via = ep.id;
          if (ep.id === 'official') status.keyRejected = false;
          return json;
        } finally { done(); }
      } catch (e) {
        if (e.cancelled) throw e;
        last = e;
        if (e instanceof HttpError) {
          if (ep.id === 'official' && (e.status === 401 || e.status === 403)) { status.keyRejected = true; last = cfError('CurseForge API Key 无效或没有权限，请在设置中检查', 'CF_KEY'); break; }
          if (e.status === 404) throw cfError(`CurseForge 上没有找到该内容（${shortUrl(e.url)}）`, 'NOT_FOUND');
          if (e.status < 500 && e.status !== 429) break;
        }
      }
    }
  }
  if (last && last.reason) throw last;
  throw cfError(`无法连接 CurseForge：${last ? last.message : '未知错误'}`, 'CF_NETWORK');
}

// ───────────────────────── 数据转换（与 Modrinth 的结构保持一致，界面可以共用） ─────────────────────────
function webUrl(m) {
  if (m.links && m.links.websiteUrl) return m.links.websiteUrl;
  return `https://www.curseforge.com/minecraft/${URL_PART[KIND_OF_CLASS[m.classId]] || 'mc-mods'}/${m.slug}`;
}

function mapProject(m) {
  const loaders = [...new Set((m.latestFilesIndexes || []).map((x) => ({ 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' })[x.modLoader]).filter(Boolean))];
  return {
    id: String(m.id),
    source: 'curseforge',
    slug: m.slug,
    title: m.name,
    description: m.summary || '',
    icon: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || null,
    author: (m.authors && m.authors[0] && m.authors[0].name) || '',
    downloads: m.downloadCount || 0,
    follows: m.thumbsUpCount || 0,
    categories: (m.categories || []).map((c) => c.name).filter(Boolean),
    loaders,
    gameVersions: [...new Set((m.latestFilesIndexes || []).map((x) => x.gameVersion).filter(Boolean))],
    type: KIND_OF_CLASS[m.classId] || 'mod',
    classId: m.classId,
    updated: m.dateModified || m.dateReleased,
    url: webUrl(m),
    allowDistribution: m.allowModDistribution !== false,
  };
}

const MC_RE = /^\d+\.\d+(\.\d+)?$/;
const LOADER_RE = /^(forge|fabric|quilt|neoforge)$/i;

function mapFile(f) {
  const gv = f.gameVersions || [];
  const sha1 = (f.hashes || []).find((x) => x.algo === 1);
  return {
    id: String(f.id),
    projectId: String(f.modId),
    source: 'curseforge',
    name: f.displayName || f.fileName,
    number: f.displayName || f.fileName,
    type: RELEASE[f.releaseType] || 'release',
    published: f.fileDate,
    downloads: f.downloadCount || 0,
    loaders: gv.filter((v) => LOADER_RE.test(v)).map((v) => v.toLowerCase()),
    gameVersions: gv.filter((v) => MC_RE.test(v)),
    dependencies: (f.dependencies || []).map((d) => ({ projectId: String(d.modId), type: DEP[d.relationType] || 'other' })),
    files: [{ url: f.downloadUrl || null, filename: fileNameOnly(f.fileName, `${f.id || 'file'}.jar`), size: f.fileLength, sha1: sha1 ? sha1.value : undefined, primary: true }],
    manual: !f.downloadUrl,
    fingerprint: f.fileFingerprint,
  };
}

/** HTML 简介 → 界面可以显示的 Markdown 文本（不保留任何标签，避免注入） */
function htmlToText(html) {
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(html || '')
    .replace(/<\s*(script|style|iframe)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Math.min(3, Number(n)))} `)
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|table|tr|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (m, k) => (ent[k] !== undefined ? ent[k] : /^#\d+$/.test(k) ? String.fromCharCode(Number(k.slice(1))) : m))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^#+[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ───────────────────────── 查询 ─────────────────────────
async function search({ query = '', type = 'mod', loader, gameVersion, offset = 0, sort = 'relevance', limit = 20, categoryId } = {}) {
  const pageSize = Math.max(1, Math.min(50, limit));
  const index = Math.max(0, Math.min(offset, 10000 - pageSize));
  const q = new URLSearchParams({ gameId: GAME, classId: CLASS[type] || CLASS.mod, searchFilter: query, sortField: SORT[sort] || 2, sortOrder: 'desc', index, pageSize });
  if (gameVersion) q.set('gameVersion', gameVersion);
  if (categoryId) q.set('categoryId', categoryId);
  if (loader && LOADER_TYPE[loader] && (type === 'mod' || type === 'modpack')) q.set('modLoaderType', LOADER_TYPE[loader]);
  const r = await cached(`s:${q}`, () => call(`/mods/search?${q}`, { timeout: 20000 }), 3 * 60 * 1000);
  const total = Math.min((r.pagination && r.pagination.totalCount) || 0, 10000);
  return { total, offset: index, hits: (r.data || []).map(mapProject) };
}

/** 某类资源的分类（光影只有 Realistic / Fantasy / Vanilla 三个，1.5.9）：[{ id, name }]，缓存一天 */
async function categories(type) {
  const r = await cached(`c:${type}`, () => call(`/categories?gameId=${GAME}&classId=${CLASS[type] || CLASS.mod}`), 24 * 3600 * 1000);
  return (r.data || []).filter((c) => !c.isClass).map((c) => ({ id: c.id, name: c.name }));
}

async function project(id, { body = true } = {}) {
  const p = await cached(`p:${id}`, async () => mapProject((await call(`/mods/${encodeURIComponent(id)}`)).data));
  if (!body) return p;
  const desc = await cached(`d:${id}`, async () => htmlToText((await call(`/mods/${encodeURIComponent(id)}/description`)).data)).catch(() => '');
  return { ...p, body: desc || p.description };
}

/** 批量获取项目：先用批量接口，失败时逐个查询 */
async function projects(ids, signal) {
  const uniq = [...new Set(ids.map(String).filter(Boolean))];
  const out = new Map();
  let need = [];
  for (const id of uniq) { const hit = cache.get(`p:${id}`); if (hit) out.set(id, hit.v); else need.push(id); }
  try {
    for (let i = 0; i < need.length; i += 100) {
      const r = await call('/mods', { method: 'POST', body: { modIds: need.slice(i, i + 100).map(Number), filterPcOnly: true }, signal });
      for (const m of r.data || []) { const p = mapProject(m); cache.set(`p:${p.id}`, { t: Date.now(), v: p }); out.set(p.id, p); }
      capMap(cache, 4000);
    }
    need = [];
  } catch (e) {
    if (e.cancelled) throw e;
    need = need.filter((id) => !out.has(id));
  }
  await pool(need, 6, async (id) => {
    if (signal && signal.aborted) throw abortError();
    try { out.set(id, await project(id, { body: false })); } catch { /* 忽略找不到的 */ }
  });
  return out;
}

/** 作者关闭了第三方下载：去掉下载地址，按手动下载处理（社区代理会自己补上地址，不能只看 downloadUrl） */
function restrict(v, proj) {
  if (!v || !proj || proj.allowDistribution !== false || v.manual) return v;
  return { ...v, manual: true, files: v.files.map((f) => ({ ...f, url: null })) };
}

/** 某个项目的文件列表（最新的在前），找不到带加载器标记的文件时放宽到只按游戏版本筛选 */
async function files(id, { loader, gameVersion, type = 'mod' } = {}) {
  const get = async (lt) => {
    const q = new URLSearchParams({ pageSize: 50 });
    if (gameVersion) q.set('gameVersion', gameVersion);
    if (lt) q.set('modLoaderType', lt);
    return cached(`f:${id}:${q}`, async () => ((await call(`/mods/${encodeURIComponent(id)}/files?${q}`)).data || []).map(mapFile));
  };
  const lt = (type === 'mod' || type === 'modpack') && loader ? LOADER_TYPE[loader] : null;
  let list = await get(lt);
  if (!list.length && lt) {
    const want = loader === 'quilt' || loader === 'legacyfabric' ? ['fabric', 'quilt'] : [loader];
    list = (await get(null)).filter((f) => !f.loaders.length || f.loaders.some((l) => want.includes(l)));
  }
  const proj = await project(id, { body: false }).catch(() => null);
  return list.map((f) => restrict(f, proj)).sort((a, b) => new Date(b.published) - new Date(a.published));
}

async function file(projectId, fileId) {
  const v = await cached(`file:${fileId}`, async () => mapFile((await call(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`)).data));
  return restrict(v, await project(projectId, { body: false }).catch(() => null));
}

/** 正式版优先，其次 Beta，最后 Alpha */
function bestFile(list) {
  if (!list || !list.length) return null;
  return list.find((f) => f.type === 'release') || list.find((f) => f.type === 'beta') || list[0];
}

// ───────────────────────── 文件指纹（CurseForge 的 MurmurHash2，去掉空白字节，种子 1） ─────────────────────────
function fingerprint(buf) {
  const b = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) { const c = buf[i]; if (c !== 9 && c !== 10 && c !== 13 && c !== 32) b[n++] = c; }
  const m = 0x5bd1e995;
  let h = (1 ^ n) >>> 0;
  let i = 0;
  while (n - i >= 4) {
    let k = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
    k = Math.imul(k, m);
    k ^= k >>> 24;
    k = Math.imul(k, m);
    h = Math.imul(h, m) ^ k;
    i += 4;
  }
  const rest = n - i;
  if (rest === 3) h ^= b[i + 2] << 16;
  if (rest >= 2) h ^= b[i + 1] << 8;
  if (rest >= 1) { h ^= b[i]; h = Math.imul(h, m); }
  h ^= h >>> 13;
  h = Math.imul(h, m);
  h ^= h >>> 15;
  return h >>> 0;
}

/** 按指纹识别（官方接口或社区代理）：返回 { fingerprint: 文件 } */
async function identify(prints) {
  if (!available()) return {};
  const out = {};
  const uniq = [...new Set(prints.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 200) {
    const r = await call(`/fingerprints/${GAME}`, { method: 'POST', body: { fingerprints: uniq.slice(i, i + 200) } });
    for (const m of (r.data && r.data.exactMatches) || []) if (m.file) out[m.file.fileFingerprint] = mapFile(m.file);
  }
  return out;
}

// ───────────────────────── 安装 ─────────────────────────
const cdnUrls = (url) => (url ? [url, url.replace('://edge.forgecdn.net/', '://mediafilez.forgecdn.net/')].filter((u, i, a) => a.indexOf(u) === i) : []);
const downloadPage = (proj, fileId) => (proj && proj.url ? `${proj.url}/download/${fileId}` : `https://www.curseforge.com/minecraft/search?search=${fileId}`);

/** 记录需要手动下载的文件（作者关闭了第三方下载） */
async function addManual(versionId, items) {
  if (!items.length) return;
  const profiles = require('./profiles');
  await profiles.updateMeta(versionId, (meta) => ({ cfManual: [...(meta.cfManual || []).filter((x) => !items.some((y) => y.fileId === x.fileId)), ...items] }));
}

function modEntry(pv, proj) {
  return { projectId: pv.projectId, versionId: pv.id, versionNumber: pv.number, slug: proj && proj.slug, title: proj && proj.title, icon: proj && proj.icon, url: proj && proj.url, source: 'curseforge' };
}

/**
 * 安装 CurseForge 上的某个文件，并自动安装必需的前置
 * @returns {{installed: string[], manual: object[]}}
 */
async function installFile({ versionId, projectVersion, kind = 'mod', withDeps = true }, task) {
  const mods = require('./mods');
  const profiles = require('./profiles');
  const { downloadFile } = require('../engine/downloader');
  const { dir, info } = await mods.targetDir(versionId, kind);
  await fsp.mkdir(dir, { recursive: true });
  const loader = info.loader && info.loader.type;
  const meta = kind === 'mod' ? await profiles.readMeta(versionId) : {};
  const have = new Set(Object.values(meta.mods || {}).filter((m) => m && m.source === 'curseforge').map((m) => String(m.projectId)));
  const visited = new Set();
  const installed = [];
  const manual = [];
  const entries = {};

  const one = async (pv0, depth) => {
    if (visited.has(pv0.projectId)) return;
    visited.add(pv0.projectId);
    if (depth > 0 && have.has(pv0.projectId)) return;
    const proj = await project(pv0.projectId, { body: false }).catch(() => null);
    const pv = restrict(pv0, proj);
    const f = pv.files[0];
    if (!f) return;
    const dest = path.join(dir, f.filename);
    if (!f.url) {
      if (!(await exists(dest))) manual.push({ projectId: pv.projectId, fileId: pv.id, fileName: f.filename, title: (proj && proj.title) || f.filename, page: downloadPage(proj, pv.id), folder: path.basename(dir), sha1: f.sha1, size: f.size });
    } else if (!(await exists(dest))) {
      task.update({ detail: `下载 ${nm(f.filename)}` });
      await downloadFile({ urls: cdnUrls(f.url), path: dest, sha1: f.sha1, size: f.size }, { task, label: f.filename });
      installed.push(f.filename);
    } else installed.push(f.filename);
    if (kind === 'mod') entries[f.filename] = modEntry(pv, proj);
    if (!withDeps || depth > 3 || kind !== 'mod') return;
    for (const dep of pv.dependencies) {
      if (dep.type !== 'required' || visited.has(dep.projectId)) continue;
      try {
        const best = bestFile(await files(dep.projectId, { loader, gameVersion: info.mcVersion }));
        if (best) await one(best, depth + 1);
      } catch (e) {
        if (e.cancelled) throw e;
        console.warn('[curseforge] 前置安装失败', dep.projectId, e.message);
      }
    }
  };

  await one(projectVersion, 0);
  if (Object.keys(entries).length) await profiles.setModInfo(versionId, entries);
  await addManual(versionId, manual);
  return { installed, manual };
}

// ───────────────────────── CurseForge 整合包（zip + manifest.json） ─────────────────────────
function parseLoader(list) {
  const arr = Array.isArray(list) ? list : [];
  const l = arr.find((x) => x && x.primary) || arr[0];
  if (!l || !l.id) return null;
  const m = String(l.id).match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  // 少数整合包写成 neoforge-1.20.1-47.1.x 或 forge-1.20.1-47.2.0
  const version = m[2].replace(/^\d+\.\d+(\.\d+)?-(?=\d)/, '');
  return { type, version };
}

function readManifest(text, fallbackName) {
  const j = JSON.parse(text);
  const mc = (j.minecraft && j.minecraft.version) || '';
  return {
    format: 'curseforge',
    name: j.name || fallbackName,
    version: j.version || '',
    summary: j.author ? `作者：${j.author}` : '',
    mc,
    loader: parseLoader(j.minecraft && j.minecraft.modLoaders),
    files: (j.files || []).filter((f) => f && f.projectID && f.fileID).map((f) => ({ projectId: String(f.projectID), fileId: String(f.fileID), required: f.required !== false })),
    overrides: j.overrides || 'overrides',
  };
}

/**
 * 解析整合包里的全部文件并下载；作者关闭了第三方下载的文件放进 manual
 * @returns {{entries: object, manual: object[], count: number}}
 */
async function downloadPackFiles(pack, gameDir, task) {
  const { downloadAll } = require('../engine/downloader');
  const signal = task && task.signal;
  const wanted = pack.files.filter((f) => f.required);
  task.update({ detail: `查询 ${wanted.length} 个文件的下载地址…`, progress: 0 });
  const resolved = new Map();
  let done = 0;
  // 先用批量接口，失败时逐个查询
  try {
    for (let i = 0; i < wanted.length; i += 100) {
      const r = await call('/mods/files', { method: 'POST', body: { fileIds: wanted.slice(i, i + 100).map((f) => Number(f.fileId)) }, signal });
      for (const f of r.data || []) resolved.set(String(f.id), mapFile(f));
      task.update({ progress: Math.min(1, (i + 100) / wanted.length) * 0.3 });
    }
  } catch (e) { if (e.cancelled) throw e; }
  await pool(wanted.filter((f) => !resolved.has(f.fileId)), 8, async (f) => {
    if (signal && signal.aborted) throw abortError();
    try { resolved.set(f.fileId, await file(f.projectId, f.fileId)); } catch (e) { if (e.cancelled) throw e; }
    done++;
    if (done % 5 === 0) task.update({ detail: `查询下载地址 ${done}/${wanted.length}`, progress: (done / wanted.length) * 0.3 });
  });
  // 项目信息：决定资源包 / 光影放哪个文件夹（.jar 一定是 Mod），以及作者是否允许第三方下载
  task.update({ detail: '查询 Mod 信息…' });
  const projs = await projects(wanted.map((f) => f.projectId), signal).catch(() => new Map());
  const dl = [];
  const manual = [];
  const entries = {};
  const missing = [];
  for (const f of wanted) {
    const proj = projs.get(f.projectId) || null;
    const v = restrict(resolved.get(f.fileId), proj);
    if (!v) { missing.push(f); continue; }
    const fileInfo = v.files[0];
    const folder = /\.jar$/i.test(fileInfo.filename) ? 'mods' : (proj && FOLDER_OF_CLASS[proj.classId]) || 'resourcepacks';
    const dest = path.join(gameDir, folder, fileInfo.filename);
    if (fileInfo.url) dl.push({ urls: cdnUrls(fileInfo.url), path: dest, sha1: fileInfo.sha1, size: fileInfo.size });
    else if (!(await exists(dest))) manual.push({ projectId: f.projectId, fileId: f.fileId, fileName: fileInfo.filename, title: (proj && proj.title) || fileInfo.filename, page: proj ? downloadPage(proj, f.fileId) : `https://www.curseforge.com/projects/${f.projectId}`, folder, sha1: fileInfo.sha1, size: fileInfo.size });
    if (folder === 'mods') entries[fileInfo.filename] = modEntry(v, proj);
  }
  if (missing.length === wanted.length && wanted.length) throw cfError('无法从 CurseForge 获取整合包里的文件信息，请稍后重试或在设置中填写 API Key', 'CF_NETWORK');
  if (dl.length) await downloadAll(dl, { task, label: '下载整合包文件' });
  return { entries, manual, missing: missing.length, count: dl.length };
}

/** 安装 CurseForge 上的整合包：下载 zip 后按本地文件安装 */
async function installModpack({ projectId, fileId, name, title, icon, onManual }, task) {
  const paths = require('../engine/paths');
  const modpack = require('./modpack');
  const { downloadFile } = require('../engine/downloader');
  const v = fileId ? await file(projectId, fileId) : bestFile(await files(projectId, { type: 'modpack' }));
  if (!v) throw new Error('没有找到可用的整合包版本');
  const f = v.files[0];
  if (!f.url) {
    const proj = await project(projectId, { body: false }).catch(() => null);
    const e = cfError(`「${nm(title) || nm(f.filename)}」的作者关闭了第三方下载，请在网页上下载后用「导入整合包」安装`, 'CF_MANUAL');
    e.page = downloadPage(proj, v.id);
    throw e;
  }
  const dest = path.join(paths.cacheDir(), 'modpacks', f.filename);
  await downloadFile({ urls: cdnUrls(f.url), path: dest, sha1: f.sha1, size: f.size }, { task, label: '下载整合包' });
  try {
    return await modpack.installMrpack(dest, { name: name || title, onManual, source: { source: 'curseforge', projectId, fileId: v.id, versionNumber: v.number, icon, title } }, task);
  } finally {
    await fsp.rm(dest, { force: true }).catch(() => {});
  }
}

// ───────────────────────── 手动下载的文件：从「下载」文件夹导入 ─────────────────────────
const downloadsDir = () => { try { return require('electron').app.getPath('downloads'); } catch { return ''; } };
const inDownloads = (p) => !!downloadsDir() && path.dirname(path.resolve(p)).toLowerCase() === path.resolve(downloadsDir()).toLowerCase();

/** 浏览器可能把重名文件保存成「name (1).jar」 */
function candidates(dir, names, wanted) {
  const out = [];
  const base = wanted.replace(/\.[^.]+$/, '');
  const ext = path.extname(wanted);
  for (const n of names) {
    if (n === wanted) out.unshift(n);
    else if (n.startsWith(base) && n.endsWith(ext) && /^ \(\d+\)$/.test(n.slice(base.length, n.length - ext.length))) out.push(n);
  }
  return out.map((n) => path.join(dir, n));
}

/**
 * 检查「下载」文件夹（以及玩家选的文件），把匹配的手动下载文件放进配置
 * @returns {{imported: string[], remaining: object[], originals: string[]}} originals：从「下载」文件夹取用的原文件
 */
async function importManual(versionId, { files: picked = [] } = {}) {
  const profiles = require('./profiles');
  const versions = require('./versions');
  const meta = await profiles.readMeta(versionId);
  const list = meta.cfManual || [];
  if (!list.length) return { imported: [], remaining: [], originals: [] };
  const info = await versions.versionInfo(versionId);
  if (!info) throw new Error('配置不存在');
  const gameDir = versions.gameDirFor(versionId, info);
  const dirs = downloadsDir() ? [downloadsDir()] : [];
  const listing = new Map();
  for (const d of dirs) listing.set(d, await fsp.readdir(d).catch(() => []));
  const imported = [];
  const remaining = [];
  const originals = [];
  // 玩家自己选的文件：名字对得上的先试，改过名的也按大小和 sha1 认
  const pickedFor = (name) => {
    const named = picked.filter((p) => candidates(path.dirname(p), [path.basename(p)], name).length);
    return [...named, ...picked.filter((p) => !named.includes(p))];
  };
  for (const item of list) {
    // 这份清单存在配置档案里，也可能来自别人的导入包，再检查一次
    const dest = safeJoin(gameDir, `${item.folder || 'mods'}/${fileNameOnly(item.fileName)}`);
    if (await exists(dest)) { imported.push(item.fileName); continue; }
    let src = null;
    const pool2 = pickedFor(item.fileName);
    for (const [d, names] of listing) pool2.push(...candidates(d, names, item.fileName));
    for (const p of pool2) {
      try {
        const st = await fsp.stat(p);
        if (!st.isFile() || (item.size && st.size !== item.size)) continue;
        if (item.sha1 && (await hashFile(p, 'sha1')) !== item.sha1) continue;
        src = p;
        break;
      } catch { /* 下一个 */ }
    }
    if (!src) { remaining.push(item); continue; }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    // 「下载」文件夹里的原文件不在这里删：交给调用方按设置处理或询问玩家；玩家自己选的文件不动
    if (!picked.includes(src)) originals.push(src);
    imported.push(item.fileName);
  }
  // 按现在的清单去掉导入好的（中途别的任务加进来的不丢）
  if (imported.length) await profiles.updateMeta(versionId, (m) => ({ cfManual: (m.cfManual || []).filter((x) => !imported.includes(x.fileName)) }));
  return { imported, remaining, originals };
}

/** 把「下载」文件夹里的原文件移到回收站；只处理「下载」文件夹里的文件，回收站不可用时保留。返回移走的个数 */
async function trashOriginals(files) {
  let n = 0;
  for (const p of files || []) {
    if (!inDownloads(p)) continue;
    try { await safeTrash(p); n++; } catch { /* 保留原文件 */ }
  }
  return n;
}

/** 导入后按设置处理原文件：trash 移到回收站、keep 保留，ask 时原样返回、交给界面询问。返回还要询问的文件 */
async function settleOriginals(originals) {
  const mode = require('../engine/config').get().cfDownloads;
  if (!originals || !originals.length || mode === 'keep') return [];
  if (mode === 'trash') { await trashOriginals(originals); return []; }
  return originals;
}

async function dismissManual(versionId, fileId) {
  const profiles = require('./profiles');
  const meta = await profiles.updateMeta(versionId, (m) => ({ cfManual: (m.cfManual || []).filter((x) => fileId != null && x.fileId !== String(fileId)) }));
  return meta.cfManual;
}

/** 测试连接：返回实际用的接口（official / proxy）、耗时、填了的 Key 有没有被拒 */
async function test() {
  const t0 = Date.now();
  if (!available()) throw cfError('请填写 API Key 或打开社区代理', 'CF_NO_ENDPOINT');
  status.keyRejected = false;
  await call(`/mods/search?gameId=${GAME}&classId=6&pageSize=1&sortField=2&sortOrder=desc`, { timeout: 15000 });
  return { via: status.via, ms: Date.now() - t0, keyRejected: hasOfficial() && status.keyRejected };
}

module.exports = {
  categories, search, project, projects, files, file, bestFile, fingerprint, identify, installFile, installModpack,
  readManifest, downloadPackFiles, importManual, dismissManual, trashOriginals, settleOriginals, test, htmlToText, mapFile, mapProject,
  hasOfficial, available, cdnUrls,
};
