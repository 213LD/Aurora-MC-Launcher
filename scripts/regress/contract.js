'use strict';
/**
 * 接口契约（2.0.0-pre8 之后，全面测试中优先级）：启动器依赖的外部接口，返回的格式还是不是代码用的那样。
 * 要联网，只读公开接口，不带账号。node scripts/regress/contract.js
 * 连不上不算格式变了（可能只是网络），单独列出来。
 */
const fs = require('fs');
const OUT = process.env.AURORA_REGRESS_OUT;
const UA = { 'User-Agent': 'AuroraLauncher/regress' };

const arr = (x) => Array.isArray(x);
const str = (x) => typeof x === 'string';
const num = (x) => typeof x === 'number';
const obj = (x) => !!x && typeof x === 'object' && !arr(x);

const J = (o) => JSON.stringify(o);
// 可以是空的（null / 没有这个字段），有的话类型要对：下载页的卡片照这样处理（rc13：固定数据里也故意放了空的）
const opt = (x, t) => x == null || t(x);
const CHECKS = [
  ['Mojang 版本列表', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', (d) => [obj(d.latest) && str(d.latest.release) && str(d.latest.snapshot), arr(d.versions) && d.versions.length > 100, d.versions.every((v) => str(v.id) && str(v.type) && str(v.url))]],
  ['BMCLAPI 版本列表', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json', (d) => [obj(d.latest) && str(d.latest.release), arr(d.versions) && d.versions.every((v) => str(v.id) && str(v.url))]],
  ['Mojang 版本文件', async (get) => (await get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).versions.find((v) => v.id === '1.20.1').url, (d) => [str(d.mainClass), arr(d.libraries) && d.libraries.every((l) => str(l.name)), obj(d.downloads) && str(d.downloads.client.url) && str(d.downloads.client.sha1), obj(d.assetIndex) && str(d.assetIndex.id) && str(d.assetIndex.url), d.javaVersion && num(d.javaVersion.majorVersion), obj(d.arguments) && arr(d.arguments.game) && arr(d.arguments.jvm)]],
  ['官方 Java 运行时', 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json', (d) => [obj(d['windows-x64']), arr(d['windows-x64']['java-runtime-gamma']) && d['windows-x64']['java-runtime-gamma'][0] && str(d['windows-x64']['java-runtime-gamma'][0].manifest.url)]],
  ['Mojang 更新日志', 'https://launchercontent.mojang.com/v2/javaPatchNotes.json', (d) => [arr(d.entries) && d.entries.length > 0, d.entries.every((e) => str(e.title) && str(e.version))]],
  ['Modrinth 搜索', `https://api.modrinth.com/v2/search?query=sodium&limit=2&facets=${encodeURIComponent(J([['project_type:mod']]))}`, (d) => [arr(d.hits), num(d.total_hits), d.hits.every((h) => str(h.project_id) && str(h.slug) && str(h.title) && arr(h.versions) && arr(h.categories) && num(h.downloads)),
    // 卡片上用到的其余字段（modrinth.js 的 mapProject）
    d.hits.every((h) => opt(h.description, str) && opt(h.icon_url, str) && opt(h.author, str) && opt(h.follows, num) && opt(h.display_categories, arr) && str(h.project_type) && opt(h.client_side, str) && opt(h.date_modified, str))]],
  ['Modrinth 项目', 'https://api.modrinth.com/v2/project/sodium', (d) => [str(d.id), str(d.slug), str(d.title), str(d.body), str(d.project_type), arr(d.game_versions)]],
  ['Modrinth 版本', `https://api.modrinth.com/v2/project/sodium/version?loaders=${encodeURIComponent(J(['fabric']))}&game_versions=${encodeURIComponent(J(['1.20.1']))}`, (d) => [arr(d) && d.length > 0, d.every((v) => str(v.id) && str(v.version_number) && arr(v.files) && arr(v.dependencies) && arr(v.game_versions) && arr(v.loaders)), d[0].files.every((f) => str(f.url) && str(f.filename) && f.hashes && str(f.hashes.sha1))]],
  ['CurseForge 代理搜索', 'https://api.curse.tools/v1/mods/search?gameId=432&classId=6&searchFilter=jei&pageSize=2', (d) => [arr(d.data), obj(d.pagination), d.data.every((m) => num(m.id) && str(m.name) && str(m.summary) && arr(m.latestFiles)),
    // 卡片上用到的其余字段（curseforge.js 的 mapProject）：图标、作者、下载数、各版本的加载器
    d.data.every((m) => opt(m.logo, (l) => obj(l) && (str(l.thumbnailUrl) || str(l.url))) && arr(m.authors) && m.authors.every((a) => str(a.name)) && num(m.downloadCount) && arr(m.latestFilesIndexes) && m.latestFilesIndexes.every((x) => str(x.gameVersion) && opt(x.modLoader, num)))]],
  ['Fabric 加载器', 'https://meta.fabricmc.net/v2/versions/loader/1.20.1', (d) => [arr(d) && d.length > 0, d.every((x) => x.loader && str(x.loader.version))]],
  ['Fabric 配置', async (get) => `https://meta.fabricmc.net/v2/versions/loader/1.20.1/${(await get('https://meta.fabricmc.net/v2/versions/loader/1.20.1'))[0].loader.version}/profile/json`, (d) => [str(d.id), str(d.mainClass), arr(d.libraries), str(d.inheritsFrom)]],
  ['Quilt 加载器', 'https://meta.quiltmc.org/v3/versions/loader/1.20.1', (d) => [arr(d) && d.length > 0, d.every((x) => x.loader && str(x.loader.version))]],
  ['Legacy Fabric 加载器', 'https://meta.legacyfabric.net/v2/versions/loader/1.8.9', (d) => [arr(d) && d.length > 0, d.every((x) => x.loader && str(x.loader.version))]],
  ['Forge 版本', 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json', (d) => [obj(d), arr(d['1.20.1']) && d['1.20.1'].every(str)]],
  ['Forge 推荐版本', 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', (d) => [obj(d.promos), str(d.promos['1.20.1-latest'])]],
  ['BMCLAPI Forge', 'https://bmclapi2.bangbang93.com/forge/minecraft/1.20.1', (d) => [arr(d) && d.length > 0, d.every((x) => str(x.version) || num(x.build))]],
  ['NeoForge 版本', 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', (d) => [arr(d.versions) && d.versions.every(str)]],
  ['BMCLAPI NeoForge', 'https://bmclapi2.bangbang93.com/neoforge/list/1.20.1', (d) => [arr(d)]],
  ['Temurin', 'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse', (d) => [arr(d) && d.length > 0, d.every((x) => x.binary && x.binary.package && str(x.binary.package.link) && str(x.binary.package.checksum) && num(x.binary.package.size) && x.version)]],
  ['authlib-injector', 'https://authlib-injector.yushi.moe/artifact/latest.json', (d) => [str(d.version), str(d.download_url), d.checksums && str(d.checksums.sha256)]],
];

(async () => {
  const cache = new Map();
  const get = async (url) => {
    if (cache.has(url)) return cache.get(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(url, { headers: UA, signal: ctrl.signal });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { http: r.status });
      const d = await r.json();
      cache.set(url, d);
      return d;
    } finally { clearTimeout(timer); }
  };
  const lines = [];
  const unreachable = [];
  await Promise.all(CHECKS.map(async ([name, urlOf, fn]) => {
    let data;
    try {
      const url = typeof urlOf === 'function' ? await urlOf(get) : urlOf;
      data = await get(url);
    } catch (e) {
      if (e.http && e.http < 500 && e.http !== 403 && e.http !== 429) lines.push({ id: '接口', name, ok: false, detail: `地址不对了：${e.message}` });
      else unreachable.push(`${name}（${e.message}）`);
      return;
    }
    let results;
    try { results = fn(data); } catch (e) { results = [false]; data = e.message; }
    const bad = results.map((x, i) => (x ? null : i)).filter((x) => x != null);
    lines.push({ id: '接口', name, ok: bad.length === 0, detail: bad.length ? `第 ${bad.join('、')} 条检查不过：${String(typeof data === 'string' ? data : J(data)).slice(0, 200)}` : '' });
  }));
  // 固定数据（net-fixture.js，按钮走查和界面快照用）也按同样的格式查（rc13，不用联网）：固定数据要照真实接口的样子造，
  // 这里的检查跟着真实接口改了、固定数据没跟上，就报出来。只查有固定数据、而且检查里不数条数的那几个接口；搜索换成空关键词，拿全部的假数据来查
  const fixture = require('./net-fixture');
  const SHAPES = ['Modrinth 搜索', 'Modrinth 项目', 'Modrinth 版本', 'CurseForge 代理搜索', 'Fabric 加载器', 'Quilt 加载器', 'Legacy Fabric 加载器', 'Forge 版本', 'Forge 推荐版本', 'NeoForge 版本'];
  for (const [name, urlOf, fn] of CHECKS) {
    if (!SHAPES.includes(name) || typeof urlOf !== 'string') continue;
    const r = await fixture.answer(urlOf.replace(/([?&])(query|searchFilter)=[^&]*/, '$1$2='));
    let ok = false; let detail = '';
    try {
      const d = await r.json();
      const res = fn(d);
      const bad = res.map((x, i) => (x ? null : i)).filter((x) => x != null);
      ok = r.status === 200 && !bad.length;
      detail = r.status !== 200 ? `固定数据回答了 ${r.status}` : bad.length ? `第 ${bad.join('、')} 条检查不过` : '';
    } catch (e) { detail = e.message; }
    lines.push({ id: '固定数据', name: `${name}：net-fixture.js 和真实接口的格式一样`, ok, detail });
  }
  lines.sort((a, b) => a.name.localeCompare(b.name));
  for (const l of lines) console.log(`${l.ok ? 'PASS' : 'FAIL'} [${l.id}] ${l.name}${l.detail ? ` — ${l.detail}` : ''}`);
  if (unreachable.length) console.log(`  连不上（不算格式变了）：${unreachable.join('；')}`);
  if (OUT) fs.appendFileSync(OUT, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  console.log(`\n共 ${lines.length} 项，通过 ${lines.filter((l) => l.ok).length}，连不上 ${unreachable.length}`);
  process.exit(lines.some((l) => !l.ok) ? 1 : 0);
})();
