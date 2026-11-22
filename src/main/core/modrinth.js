'use strict';
/**
 * Modrinth API v2 封装（带缓存）
 * https://docs.modrinth.com/api/
 */
const { getJson, postJson } = require('../engine/net');
const { pool, capMap } = require('../engine/util');

const API = 'https://api.modrinth.com/v2';
const TTL = 10 * 60 * 1000;
// 1.4.30：存到磁盘（apicache.js），重启后也能用，断网时退回旧的结果
const cached = (key, fn, ttl = TTL) => require('../engine/apicache').get('modrinth', key, fn, ttl);
// 批量取项目（projects）用的内存缓存：1.5.0 改磁盘缓存时把它一起删了，projects() 直接报错，1.5.1 补回
const cache = new Map();

const enc = encodeURIComponent;
const j = (v) => enc(JSON.stringify(v));

/** Quilt 可以加载 Fabric Mod */
function loaderList(loader) {
  if (!loader) return null;
  if (loader === 'quilt') return ['quilt', 'fabric'];
  if (loader === 'legacyfabric') return ['legacy-fabric', 'fabric'];
  return [loader];
}

function mapProject(p) {
  return {
    id: p.id || p.project_id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    icon: p.icon_url || null,
    author: p.author || null,
    downloads: p.downloads,
    follows: p.follows || p.followers,
    categories: p.display_categories || p.categories || [],
    // 全部标签（光影的性能档次 potato / low / … 不在 display_categories 里，1.5.9）
    tags: p.categories || [],
    loaders: p.loaders || [],
    gameVersions: p.game_versions || p.versions || [],
    type: p.project_type,
    clientSide: p.client_side,
    serverSide: p.server_side,
    updated: p.date_modified || p.updated,
    gallery: p.featured_gallery || null,
  };
}

function mapVersion(v) {
  return {
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    number: v.version_number,
    type: v.version_type,
    published: v.date_published,
    downloads: v.downloads,
    loaders: v.loaders || [],
    gameVersions: v.game_versions || [],
    dependencies: (v.dependencies || []).map((d) => ({ projectId: d.project_id, versionId: d.version_id, fileName: d.file_name, type: d.dependency_type })),
    files: (v.files || []).map((f) => ({ url: f.url, filename: f.filename, size: f.size, sha1: f.hashes && f.hashes.sha1, sha512: f.hashes && f.hashes.sha512, primary: f.primary })),
  };
}

async function search({ query = '', type = 'mod', loader, gameVersion, offset = 0, sort = 'relevance', limit = 20, categories } = {}) {
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if ((type === 'mod' || type === 'modpack') && loader) facets.push(loaderList(loader).map((l) => `categories:${l}`));
  // 每项是一个标签（必须有），或一组标签（有其中一个就行），或 '!标签'（不能有）
  for (const c of categories || []) facets.push((Array.isArray(c) ? c : [c]).map((x) => (String(x).startsWith('!') ? `categories!=${String(x).slice(1)}` : `categories:${x}`)));
  const url = `${API}/search?query=${enc(query)}&limit=${limit}&offset=${offset}&index=${sort}&facets=${j(facets)}`;
  const r = await cached(`s:${url}`, () => getJson(url, { timeout: 15000 }), 3 * 60 * 1000);
  return { total: r.total_hits, offset: r.offset, hits: (r.hits || []).map(mapProject) };
}

async function project(idOrSlug) {
  return cached(`p:${idOrSlug}`, async () => {
    const p = await getJson(`${API}/project/${enc(idOrSlug)}`, { timeout: 15000, retries: 1 });
    return { ...mapProject(p), body: p.body, url: `https://modrinth.com/${p.project_type}/${p.slug}`, gallery: p.gallery || [] };
  });
}

/** 批量获取项目（id 或 slug），未找到的会被忽略 */
async function projects(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = [];
  for (let i = 0; i < uniq.length; i += 80) {
    const chunk = uniq.slice(i, i + 80);
    const fresh = (id) => { const hit = cache.get(`p:${id}`); return hit && Date.now() - hit.t < TTL; };
    const need = chunk.filter((id) => !fresh(id));
    if (need.length) {
      const arr = await getJson(`${API}/projects?ids=${j(need)}`, { timeout: 20000 });
      for (const p of arr || []) {
        const m = { ...mapProject(p), url: `https://modrinth.com/${p.project_type}/${p.slug}` };
        cache.set(`p:${p.id}`, { t: Date.now(), v: m });
        cache.set(`p:${p.slug}`, { t: Date.now(), v: m });
      }
      capMap(cache, 4000);
    }
    for (const id of chunk) {
      const hit = cache.get(`p:${id}`);
      if (hit) out.push(hit.v);
    }
  }
  const seen = new Set();
  return out.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
}

async function projectVersions(id, { loader, gameVersion, type = 'mod' } = {}) {
  const q = [];
  const ll = (type === 'mod' || type === 'modpack') ? loaderList(loader) : null;
  if (ll) q.push(`loaders=${j(ll)}`);
  if (gameVersion) q.push(`game_versions=${j([gameVersion])}`);
  const url = `${API}/project/${enc(id)}/version${q.length ? `?${q.join('&')}` : ''}`;
  return cached(`v:${url}`, async () => (await getJson(url, { timeout: 15000 })).map(mapVersion));
}

async function version(id) {
  return cached(`ver:${id}`, async () => mapVersion(await getJson(`${API}/version/${enc(id)}`, { timeout: 15000 })));
}

async function versionsBatch(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = [];
  for (let i = 0; i < uniq.length; i += 80) {
    const arr = await getJson(`${API}/versions?ids=${j(uniq.slice(i, i + 80))}`, { timeout: 20000 });
    out.push(...(arr || []).map(mapVersion));
  }
  return out;
}

/** 挑选最合适的版本：优先正式版，其次 beta，最后 alpha */
function bestVersion(list) {
  if (!list || !list.length) return null;
  return list.find((v) => v.type === 'release') || list.find((v) => v.type === 'beta') || list[0];
}

/** 通过文件 SHA1 识别 Mod：返回 { sha1: version } */
async function identify(hashes) {
  const out = {};
  const uniq = [...new Set(hashes.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 200) {
    const r = await postJson(`${API}/version_files`, { hashes: uniq.slice(i, i + 200), algorithm: 'sha1' }, { timeout: 20000 });
    if (!r.ok) throw new Error(`Modrinth 识别失败（HTTP ${r.status}）`);
    for (const [h, v] of Object.entries(r.data || {})) out[h] = mapVersion(v);
  }
  return out;
}

/** 检查更新：返回 { sha1: 最新版本 } */
async function updates(hashes, loader, gameVersion) {
  const out = {};
  const uniq = [...new Set(hashes.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 200) {
    const body = { hashes: uniq.slice(i, i + 200), algorithm: 'sha1' };
    if (loader) body.loaders = loaderList(loader);
    if (gameVersion) body.game_versions = [gameVersion];
    const r = await postJson(`${API}/version_files/update`, body, { timeout: 20000 });
    if (!r.ok) throw new Error(`Modrinth 检查更新失败（HTTP ${r.status}）`);
    for (const [h, v] of Object.entries(r.data || {})) out[h] = mapVersion(v);
  }
  return out;
}

/** 并发获取多个项目在指定版本/加载器下的最佳版本 */
async function resolveMany(ids, { loader, gameVersion }, concurrency = 6) {
  const result = new Map();
  await pool(ids, concurrency, async (id) => {
    try {
      const list = await projectVersions(id, { loader, gameVersion });
      result.set(id, bestVersion(list));
    } catch (e) {
      result.set(id, null);
    }
  });
  return result;
}

/** 从 Modrinth CDN 地址中解析项目 ID 与版本 ID */
function parseCdnUrl(url) {
  const m = String(url || '').match(/cdn\.modrinth\.com\/data\/([A-Za-z0-9]{8})\/versions\/([A-Za-z0-9]{8})\//);
  return m ? { projectId: m[1], versionId: m[2] } : null;
}

module.exports = { search, project, projects, projectVersions, version, versionsBatch, bestVersion, identify, updates, resolveMany, parseCdnUrl, loaderList, mapProject };
