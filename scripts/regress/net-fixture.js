'use strict';
/**
 * 假的「有网」（rc11）：隔离层里没有网，启动器按离线处理，新建配置、安装版本这些要联网的弹窗打不开，界面快照量不了。
 * AURORA_BADNET=fixture 时，sandbox-run.js 用这里的回答顶替网络：版本列表和各个加载器的列表给一份固定的小数据，
 * 别的地址一律 404。数据是固定的，所以弹窗里的内容每次都一样，可以进界面快照。
 * rc13 起也回答 Modrinth / CurseForge 的搜索、项目、版本（下载页的资源几栏），按钮走查 walk.js --net=fixture 用。
 * 只回答「列表」，不回答文件下载：用它的测试不能真的去装东西。
 * 它替代不了真实的网：真实数据的样子、接口的格式变了、网慢网断，要靠真联网的走查和 contract.js。
 */
const T = (d) => `${d}T12:00:00+00:00`;
const VERSIONS = [
  ['25w02a', 'snapshot', '2025-01-08'], ['1.21.4', 'release', '2024-12-03'], ['1.21.1', 'release', '2024-08-08'], ['1.20.1', 'release', '2023-06-12'],
  ['1.19.2', 'release', '2022-08-05'], ['1.16.5', 'release', '2021-01-14'], ['1.12.2', 'release', '2017-09-18'], ['1.8.9', 'release', '2015-12-03'],
  ['1.7.10', 'release', '2014-05-14'], ['b1.7.3', 'old_beta', '2011-07-07'], ['a1.2.6', 'old_alpha', '2010-12-03'],
];
const MANIFEST = {
  latest: { release: '1.21.4', snapshot: '25w02a' },
  versions: VERSIONS.map(([id, type, d]) => ({ id, type, url: `https://piston-meta.mojang.com/v1/packages/0000000000000000000000000000000000000000/${id}.json`, time: T(d), releaseTime: T(d), sha1: '0000000000000000000000000000000000000000', complianceLevel: 1 })),
};
const RELEASES = VERSIONS.filter((v) => v[1] === 'release').map((v) => v[0]);
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

// ── Modrinth / CurseForge（rc13）：下载页的 Mod、整合包、资源包、光影几栏 ──
// 照真实接口的字段造，故意放进真实数据里会碰到的极端情况：很长不带空格的名字、很长的中文名、emoji、从右往左的文字、
// 名字和简介里有 HTML（要按文字显示）、没有图标、图标打不开、下载数 0 和上千亿、一大堆标签和游戏版本、没见过的加载器、什么字段都是空的。
// 搜「nothing」没有结果，「boom」服务器出错，「limit」被限流，「slow」三秒以后才回答（看转圈、看先发后到会不会把后搜的结果盖掉）
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const MANY = Array.from({ length: 80 }, (_, i) => `1.${21 - Math.floor(i / 6)}.${i % 6}`);
const P = (slug, o = {}) => ({
  project_id: `fx-${slug}`, slug, title: slug, description: `${slug} 的简介`, author: 'Fixture', downloads: 1000, follows: 10, icon_url: PNG,
  display_categories: ['optimization'], categories: ['optimization', 'fabric'], versions: ['1.20.1', '1.21.1'], loaders: ['fabric'],
  client_side: 'required', server_side: 'optional', date_modified: T('2025-01-01'), featured_gallery: null, ...o,
});
const HITS = [
  P('sodium', { title: 'Sodium', description: 'The fastest and most compatible rendering optimization mod for Minecraft.', author: 'jellysquid3', downloads: 52345678, follows: 21876 }),
  P('very-long-name', { title: 'ThisModNameIsExtremelyLongAndHasNoSpacesAtAllSoItCannotWrapAnywhereOnTheCard', description: '一段很长的简介，'.repeat(30), author: 'SomeoneWithAnExtremelyLongAuthorNameThatJustKeepsGoing', downloads: 123456789012, follows: 0, icon_url: null }),
  P('cjk-long', { title: '一个名字特别特别长的中文模组，用来看看卡片能不能放下这么多字而不把旁边的东西挤坏', description: '中文简介'.repeat(20), author: '作者', icon_url: 'https://fixture.invalid/icon.png' }),
  P('emoji', { title: '🌸 Cherry Blossom ✨ 樱花 🌸🌸🌸', description: '带 emoji 的名字和简介 🎉🎉🎉 👍', author: '花见🌸' }),
  P('rtl', { title: 'مود عربي للاختبار', description: 'نص من اليمين إلى اليسار مع English في الوسط', author: 'مؤلف' }),
  P('html', { title: '<b>Bold</b> & <i>Mod</i> <script>alert(1)</script>', description: '<img src=x onerror=alert(1)> 名字和简介里有 HTML，要按文字显示，不能真的执行', author: 'a&b<c>' }),
  P('many-tags', { title: 'Many Tags', display_categories: ['adventure', 'cursed', 'decoration', 'economy', 'equipment', 'food', 'game-mechanics', 'library', 'magic', 'management', 'minigame', 'mobs', 'optimization', 'social', 'storage', 'technology', 'transportation', 'utility', 'worldgen'], versions: MANY }),
  P('new-loader', { title: 'New Loader Mod', categories: ['babric', 'ornithe', 'fabric'], loaders: ['babric', 'ornithe', 'fabric'], display_categories: [], client_side: 'unknown', server_side: 'unknown' }),
  P('empty-fields', { title: 'Empty', description: '', author: '', downloads: 0, follows: 0, icon_url: null, display_categories: [], categories: [], versions: [], loaders: [] }),
  P('lithium', { title: 'Lithium', author: 'jellysquid3', downloads: 31234567 }),
  P('iris', { title: 'Iris Shaders', downloads: 40123456 }),
  P('fabric-api', { title: 'Fabric API', downloads: 90123456, display_categories: ['library'] }),
  // 后面几页：翻页时页数、条数对得上
  ...Array.from({ length: 40 }, (_, i) => P(`filler-${i}`, { title: `Filler Mod ${i}`, downloads: 500 - i })),
];
const findHit = (key) => HITS.find((h) => h.slug === key || h.project_id === key || String(100000 + HITS.indexOf(h)) === key);
const special = (query, body) => {
  if (query === 'boom') return json({ error: 'internal', description: 'fixture 500' }, 500);
  if (query === 'limit') return new Response('{"error":"ratelimited","description":"Too many requests"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } });
  return query === 'slow' ? new Promise((r) => setTimeout(() => r(json(body)), 3000)) : json(body);
};
const matching = (query) => (query === 'nothing' ? [] : HITS.filter((h) => !query || query === 'slow' || query === 'boom' || query === 'limit' || h.slug.includes(query) || h.title.toLowerCase().includes(query)));
const mrVersion = (h, n, type) => ({
  id: `v-${h.slug}-${n}`, project_id: h.project_id, name: `${h.title} ${n}.0.0`, version_number: `${n}.0.0`, changelog: `第 ${n} 版的更新说明\n`.repeat(n * 5),
  game_versions: h.versions.length ? h.versions : ['1.20.1'], loaders: h.loaders.length ? h.loaders : ['fabric'], version_type: type, date_published: T(`2025-0${n}-01`), downloads: 100 * n,
  files: [{ url: `https://fixture.invalid/${h.slug}-${n}.jar`, filename: `${h.slug}-${n}.0.0.jar`, size: 123456 * n, primary: true, hashes: { sha1: '0'.repeat(40), sha512: '0'.repeat(128) } }], dependencies: [],
});
const cfMod = (h) => ({
  id: 100000 + HITS.indexOf(h), gameId: 432, name: h.title, slug: h.slug, summary: h.description, logo: h.icon_url ? { thumbnailUrl: h.icon_url, url: h.icon_url } : null,
  authors: h.author ? [{ name: h.author }] : [], downloadCount: h.downloads, thumbsUpCount: h.follows, dateModified: h.date_modified, classId: 6,
  latestFilesIndexes: (h.versions.length ? h.versions : ['1.20.1']).slice(0, 40).map((gameVersion, k) => ({ gameVersion, modLoader: 4, fileId: k + 1, filename: `${h.slug}.jar`, releaseType: 1 })),
  categories: h.display_categories.map((name, k) => ({ id: k + 1, name, slug: name })), links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${h.slug}` },
  latestFiles: [cfFileOf(h, 3)], // 只在调用时用到，下面定义的也来得及
});
const cfFileOf = (h, n) => ({ id: n, modId: 100000 + HITS.indexOf(h), displayName: `${h.title} ${n}.0.0`, fileName: `${h.slug}-${n}.0.0.jar`, releaseType: n, fileDate: T(`2025-0${n}-01`), fileLength: 123456 * n, downloadCount: 100 * n, downloadUrl: `https://fixture.invalid/${h.slug}-${n}.jar`, gameVersions: (h.versions.length ? h.versions : ['1.20.1']).concat(['Fabric']), hashes: [{ value: '0'.repeat(40), algo: 1 }], dependencies: [] });

function resources(u) {
  let m = u.match(/api\.modrinth\.com\/v2\/search\?([^#]*)/);
  if (m) {
    const q = new URLSearchParams(m[1]);
    const query = (q.get('query') || '').toLowerCase();
    const offset = Number(q.get('offset')) || 0; const limit = Number(q.get('limit')) || 20;
    const type = ((q.get('facets') || '').match(/project_type:(\w+)/) || [])[1] || 'mod';
    const all = matching(query);
    return special(query, { hits: all.slice(offset, offset + limit).map((h) => ({ ...h, project_type: type })), offset, limit, total_hits: all.length });
  }
  if ((m = u.match(/api\.modrinth\.com\/v2\/projects\?ids=([^&#]*)/))) {
    let ids = []; try { ids = JSON.parse(decodeURIComponent(m[1])); } catch { /* 坏参数：空列表 */ }
    return json(ids.map(findHit).filter(Boolean).map((h) => ({ ...h, id: h.project_id, project_type: 'mod', game_versions: h.versions })));
  }
  if ((m = u.match(/api\.modrinth\.com\/v2\/project\/([^/?#]+)\/version/))) {
    const h = findHit(decodeURIComponent(m[1]));
    return h ? json([mrVersion(h, 3, 'release'), mrVersion(h, 2, 'beta'), mrVersion(h, 1, 'alpha')]) : json({ error: 'not_found' }, 404);
  }
  if ((m = u.match(/api\.modrinth\.com\/v2\/project\/([^/?#]+)$/))) {
    const h = findHit(decodeURIComponent(m[1]));
    return h ? json({ ...h, id: h.project_id, project_type: 'mod', game_versions: h.versions, body: `# ${h.title}\n\n${h.description}\n\n${'很长的说明，'.repeat(200)}\n\n\`\`\`\n${'x'.repeat(400)}\n\`\`\``, gallery: [] }) : json({ error: 'not_found' }, 404);
  }
  if (!/api\.(curse\.tools|curseforge\.com)\/v1\//.test(u)) return null;
  if ((m = u.match(/\/v1\/mods\/search\?([^#]*)/))) {
    const q = new URLSearchParams(m[1]);
    const query = (q.get('searchFilter') || '').toLowerCase();
    const index = Number(q.get('index')) || 0; const pageSize = Number(q.get('pageSize')) || 20;
    const all = matching(query);
    return special(query, { data: all.slice(index, index + pageSize).map(cfMod), pagination: { index, pageSize, resultCount: Math.min(pageSize, Math.max(0, all.length - index)), totalCount: all.length } });
  }
  if (/\/v1\/categories\?/.test(u)) return json({ data: [{ id: 1, name: 'Performance', isClass: false }, { id: 2, name: 'Adventure and RPG', isClass: false }, { id: 3, name: 'A Category With An Unusually Long Name For Layout', isClass: false }] });
  if ((m = u.match(/\/v1\/mods\/(\d+)\/files/))) { const h = findHit(m[1]); return h ? json({ data: [cfFileOf(h, 3), cfFileOf(h, 2), cfFileOf(h, 1)], pagination: { index: 0, pageSize: 50, resultCount: 3, totalCount: 3 } }) : json({ error: 'not found' }, 404); }
  if ((m = u.match(/\/v1\/mods\/(\d+)\/description/))) { const h = findHit(m[1]); return h ? json({ data: `<p>${h.description}</p><p>${'很长的说明，'.repeat(100)}</p>` }) : json({ error: 'not found' }, 404); }
  if ((m = u.match(/\/v1\/mods\/(\d+)(?:[?#]|$)/))) { const h = findHit(m[1]); return h ? json({ data: cfMod(h) }) : json({ error: 'not found' }, 404); }
  return null;
}

/** 这个地址该回答什么；没有准备的回答 404 */
function answer(url) {
  const u = String(url);
  const r = resources(u);
  if (r) return r;
  if (/version_manifest(_v2)?\.json/.test(u)) return json(MANIFEST);
  // Fabric / Quilt / Legacy Fabric 的 meta
  if (/meta\.(fabricmc\.net|quiltmc\.org|legacyfabric\.net)\/v\d\/versions\/game/.test(u)) return json(RELEASES.map((version) => ({ version, stable: true })));
  const m = u.match(/meta\.(fabricmc\.net|quiltmc\.org|legacyfabric\.net)\/v\d\/versions\/loader(?:\/([^/?]+))?/);
  if (m) {
    const loaders = ['0.16.9', '0.16.5', '0.15.11'].map((version, i) => ({ separator: '.', build: 9 - i, maven: `net.fabricmc:fabric-loader:${version}`, version, stable: i === 0 }));
    return json(m[2] ? loaders.map((loader) => ({ loader, intermediary: { maven: `net.fabricmc:intermediary:${m[2]}`, version: m[2], stable: true }, launcherMeta: { version: 1, libraries: { client: [], common: [], server: [] }, mainClass: { client: 'net.fabricmc.loader.impl.launch.knot.KnotClient' } } })) : loaders);
  }
  // Forge
  if (/forge\/maven-metadata\.json/.test(u)) return json({ '1.20.1': ['1.20.1-47.3.0', '1.20.1-47.2.0'], '1.19.2': ['1.19.2-43.4.0'], '1.16.5': ['1.16.5-36.2.42'], '1.12.2': ['1.12.2-14.23.5.2860'], '1.8.9': ['1.8.9-11.15.1.2318-1.8.9'], '1.7.10': ['1.7.10-10.13.4.1614-1.7.10'] });
  if (/promotions_slim\.json/.test(u)) return json({ homepage: 'https://files.minecraftforge.net/', promos: { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.3.0', '1.19.2-recommended': '43.4.0', '1.16.5-recommended': '36.2.42', '1.12.2-recommended': '14.23.5.2860', '1.8.9-recommended': '11.15.1.2318', '1.7.10-recommended': '10.13.4.1614' } });
  if (/bmclapi[^/]*\/forge\/minecraft\/([^/?]+)/.test(u)) return json([{ build: 1, mcversion: RegExp.$1, version: '47.3.0', modified: T('2024-06-01'), files: [] }]);
  // NeoForge
  if (/maven\/versions\/releases\/net\/neoforged\/neoforge/.test(u)) return json({ isSnapshot: false, versions: ['21.1.90', '21.4.50', '21.4.60-beta'] });
  if (/maven\/versions\/releases\/net\/neoforged\/forge/.test(u)) return json({ isSnapshot: false, versions: ['1.20.1-47.1.106'] });
  // OptiFine（BMCLAPI）
  if (/\/optifine\/versionList/i.test(u) || /\/optifine\/[\d.]+$/.test(u)) return json([{ mcversion: '1.20.1', patch: 'I6', type: 'HD_U', filename: 'OptiFine_1.20.1_HD_U_I6.jar', forge: 'Forge 47.1.3' }]);
  return json({ error: 'not in fixture' }, 404);
}

module.exports = { answer, MANIFEST, HITS };
