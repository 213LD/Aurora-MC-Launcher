'use strict';
/**
 * Mod 配置器下载前按 jar 里的声明检查冲突，并试着换成能一起用的版本（1.5.8）
 *
 * Modrinth 的依赖信息只有「需要 / 可选 / 不兼容」，不带版本范围。真正的限制写在 jar 的 fabric.mod.json / mods.toml 里，
 * 比如「Sodium 0.8.13 不能和 1.8.13 之前的 Iris 一起用」「Iris 1.8.8 只能配 Sodium 0.6.x」。
 * 以前只有装好以后（Mod 管理、测试与 Debug、游戏启动时）才看得到。
 * 这里用 HTTP Range 只取 jar 的目录和元数据文件（每个几十 KB），按和静态检查相同的规则判断，结果按文件 sha1 缓存到硬盘。
 */
const fsp = require('fs').promises;
const path = require('path');
const paths = require('../engine/paths');
const modrinth = require('./modrinth');
const { ZipReader } = require('../engine/zip');
const { getBuffer } = require('../engine/net');
const { pool, capMap } = require('../engine/util');

const ts = () => require('./troubleshoot');
const mem = new Map();
const MAX_CANDIDATES = 40;
const TYPE_RANK = { release: 0, beta: 1, alpha: 2 };
const typeRank = (v) => TYPE_RANK[v.type] ?? 3;
const MAX_ROUNDS = 6;

/** 远程读一个 Modrinth 文件的 Mod 元数据：{ id, name, version, ids, byLoader }，读不到返回 null */
function remoteMeta(file) {
  const key = (file && (file.sha1 || file.url)) || '';
  if (!key || !file.url || !file.size) return Promise.resolve(null);
  if (mem.has(key)) return mem.get(key);
  const p = (async () => {
    const disk = path.join(paths.cacheDir(), 'jarmeta', `${key.replace(/[^\w]/g, '_').slice(-80)}.json`);
    try { return JSON.parse(await fsp.readFile(disk, 'utf8')); } catch { /* 没缓存 */ }
    const range = async (pos, len) => {
      const buf = await getBuffer(file.url, { headers: { Range: `bytes=${pos}-${pos + len - 1}` }, timeout: 20000 });
      // 服务器不支持 Range 时返回整个文件
      return buf.length > len && buf.length === file.size ? buf.subarray(pos, pos + len) : buf;
    };
    const z = await ZipReader.fromRemote(range, file.size, file.filename);
    const m = await require('./mods').metaFromZip(z, { light: true });
    const slim = m ? { id: m.id, name: m.name, version: m.version, ids: m.ids, byLoader: m.byLoader } : null;
    await fsp.mkdir(path.dirname(disk), { recursive: true }).catch(() => {});
    await fsp.writeFile(disk, JSON.stringify(slim)).catch(() => {});
    return slim;
  })();
  mem.set(key, p);
  capMap(mem, 2000);
  p.catch(() => mem.delete(key));
  return p;
}

const fileOf = (v) => v && (v.file || (v.files || []).find((f) => f.primary) || (v.files || [])[0]);
const rangeText = (r) => (r || []).filter((x) => x && x !== '*').join(' / ');

/**
 * 一组 Mod 之间按 jar 声明的版本冲突。entries：[{ title, meta }]
 * 只比对各 Mod 自己的 id 和版本（嵌套模块不算），版本认不出来的不报，避免误报
 */
function violations(entries, loader, mc) {
  const { section, versionInRanges, parseVer } = ts();
  const byId = new Map();
  for (const e of entries) if (e.meta) for (const id of e.meta.ids || []) byId.set(String(id).toLowerCase(), e);
  const out = [];
  for (const e of entries) {
    if (!e.meta) continue;
    const sec = section(e.meta, loader, mc);
    for (const [dep, ranges] of Object.entries(sec.breaks || {})) {
      const o = byId.get(dep.toLowerCase());
      if (o && o !== e && versionInRanges(ranges, o.meta.version, sec.kind)) out.push({ type: 'breaks', a: e, b: o, ranges });
    }
    for (const [dep, ranges] of Object.entries(sec.deps || {})) {
      const o = byId.get(dep.toLowerCase());
      if (o && o !== e && parseVer(o.meta.version || '') && !versionInRanges(ranges, o.meta.version, sec.kind)) out.push({ type: 'depends', a: e, b: o, ranges });
    }
  }
  return out;
}

const sameV = (x, y) => x.type === y.type && x.a.key === y.a.key && x.b.key === y.b.key;

/** 一条冲突的说明：「Sodium 0.8.13 不能和 Iris 1.8.13 之前的版本一起用」「Iris 需要 Sodium 0.6.x」 */
function describe(v) {
  const r = rangeText(v.ranges);
  return v.type === 'breaks'
    ? `${v.a.title} ${v.a.meta.version} 声明不能和 ${v.b.title}${r ? `（${r}）` : ''} 一起用，清单里的是 ${v.b.meta.version}`
    : `${v.a.title} ${v.a.meta.version} 需要 ${v.b.title} ${r}，清单里的是 ${v.b.meta.version}`;
}

/**
 * 检查并尽量解决：每轮试着把一个有冲突的 Mod 换成别的版本（新的优先、正式版优先），选冲突减少最多的那个，最多几轮。
 * entries：[{ key, title, pinned, version: { id, number, type, published, file } }]，会被原地改掉 version
 * @returns {{ changes: [{key, title, from, to, reasons}], left: [{a, b, title, detail}], checked: number }}
 */
async function solve(entries, { loader, mc }) {
  await pool(entries, 8, async (e) => { e.meta = await remoteMeta(fileOf(e.version)).catch(() => null); });
  const changes = [];
  const versionsOf = new Map();
  const listFor = async (e) => {
    if (!versionsOf.has(e.key)) {
      const all = await modrinth.projectVersions(e.key, { loader, gameVersion: mc }).catch(() => []);
      // 正式版优先，同类里新的优先（Modrinth 返回的已经是新的在前）
      versionsOf.set(e.key, all.filter((v) => fileOf(v)).sort((x, y) => typeRank(x) - typeRank(y)).slice(0, MAX_CANDIDATES));
    }
    return versionsOf.get(e.key);
  };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const bad = violations(entries, loader, mc);
    if (!bad.length) break;
    const involved = [...new Set(bad.flatMap((v) => [v.a, v.b]))].filter((e) => !e.pinned);
    let best = null;
    for (const e of involved) {
      // 从新到旧一批批读，取冲突剩得最少的版本（一样少取靠前的，即正式版、较新的）；能全部解决就不再往下读。
      // 不能见好就收：Sodium 0.6.13 只解决 Iris，0.6.9 才同时不挡 BetterEnd
      const cands = (await listFor(e)).filter((v) => v.id !== e.version.id);
      let found = null;
      for (let i = 0; i < cands.length && !(found && found.n === 0); i += 6) {
        const batch = cands.slice(i, i + 6);
        await pool(batch, 6, async (v) => { if (v.meta === undefined) v.meta = await remoteMeta(fileOf(v)).catch(() => null); });
        for (const v of batch) {
          if (!v.meta) continue;
          const n = violations(entries.map((x) => (x === e ? { ...x, meta: v.meta } : x)), loader, mc).length;
          if (n < bad.length && (!found || n < found.n)) found = { e, v, n };
        }
      }
      // 冲突剩得少的优先；一样多时正式版优先（宁可用旧一点的正式版，也不换成测试版）
      if (found && (!best || found.n < best.n || (found.n === best.n && typeRank(found.v) < typeRank(best.v)))) best = found;
    }
    if (!best) break;
    const { e, v } = best;
    const before = e.version;
    const said = new Map(bad.map((x) => [x, describe(x)])); // 换之前的说明（换完 meta 就变了）
    e.version = { id: v.id, number: v.number, type: v.type, published: v.published, file: fileOf(v) };
    e.meta = v.meta;
    const after = violations(entries, loader, mc);
    const fixed = bad.filter((x) => (x.a === e || x.b === e) && !after.some((y) => sameV(x, y))).map((x) => said.get(x));
    const prev = changes.find((c) => c.key === e.key);
    if (prev) { prev.to = e.version.number; prev.reasons.push(...fixed); } else changes.push({ key: e.key, title: e.title, from: before.number, to: e.version.number, reasons: fixed });
  }
  const left = violations(entries, loader, mc).map((v) => ({ type: v.type, a: v.a.key, b: v.b.key, title: `${v.a.title} 与 ${v.b.title} 版本不搭`, detail: describe(v) }));
  return { changes: changes.filter((c) => c.from !== c.to), left, checked: entries.filter((e) => e.meta).length };
}

module.exports = { remoteMeta, violations, solve };
