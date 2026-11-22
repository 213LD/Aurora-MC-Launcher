'use strict';
/** 版本范围和已知的 Mod 关系：前置、不兼容、MC 版本范围怎么比较 */

const BUILTIN = {
  fabric: ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'mixinextras'],
  legacyfabric: ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'mixinextras'],
  quilt: ['minecraft', 'java', 'quilt_loader', 'fabricloader', 'fabric-loader', 'mixinextras'],
  forge: ['minecraft', 'forge', 'javafml', 'lowcodefml', 'mcp', 'fml', 'mixinextras'],
  neoforge: ['minecraft', 'neoforge', 'forge', 'javafml', 'lowcodefml', 'fml', 'fancymodloader', 'mixinextras'],
};

// 常见 Mod ID → Modrinth slug（大多数情况下二者相同）
const ID_ALIAS = {
  fabric: 'fabric-api', 'fabric-api': 'fabric-api', architectury: 'architectury-api', cloth_config: 'cloth-config', 'cloth-config2': 'cloth-config',
  kotlinforforge: 'kotlin-for-forge', yet_another_config_lib_v3: 'yacl', yet_another_config_lib: 'yacl', owo: 'owo-lib',
  puzzleslib: 'puzzles-lib', forgeconfigapiport: 'forge-config-api-port', resourcefullib: 'resourceful-lib', bookshelf: 'bookshelf-lib',
  supermartijn642corelib: 'supermartijn642s-core-lib', supermartijn642configlib: 'supermartijn642s-config-lib', ftblibrary: 'ftb-library-forge',
  cardinal_components: 'cardinal-components-api', 'cardinal-components-base': 'cardinal-components-api', trinkets: 'trinkets', curios: 'curios',
  geckolib: 'geckolib', playeranimator: 'playeranimator', balm: 'balm', fzzy_config: 'fzzy-config', libipn: 'libipn',
  fabric_language_kotlin: 'fabric-language-kotlin', 'fabric-language-kotlin': 'fabric-language-kotlin', sodium: 'sodium', iris: 'iris',
  jei: 'jei', rei: 'rei', roughlyenoughitems: 'rei', modmenu: 'modmenu', indium: 'indium', terrablender: 'terrablender',
  citadel: 'citadel', moonlight: 'moonlight', collective: 'collective', creativecore: 'creativecore', yungsapi: 'yungs-api',
  ferritecore: 'ferrite-core', entityculling: 'entityculling', lithium: 'lithium', 'zeta': 'zeta', 'kambrik': 'kambrik',
};

// 已知的硬冲突（Mod ID）
const KNOWN_CONFLICTS = [
  [['sodium'], ['embeddium', 'rubidium', 'magnesium', 'optifine'], '渲染引擎冲突：Sodium 与 Embeddium / Rubidium / OptiFine 只能安装一个'],
  [['embeddium'], ['rubidium', 'optifine'], '渲染引擎冲突：Embeddium 与 Rubidium / OptiFine 只能安装一个'],
  [['iris'], ['oculus', 'optifine'], '光影加载器冲突：Iris、Oculus 与 OptiFine 只能保留一个'],
  [['lithium'], ['canary', 'radium'], 'Lithium 与它的移植版（Canary / Radium）功能相同，只能保留一个'],
  [['starlight'], ['phosphor'], '光照引擎优化 Starlight 与 Phosphor 冲突'],
  [['fabric-api', 'fabric'], ['qsl', 'quilted_fabric_api'], 'Fabric API 与 Quilted Fabric API 冲突'],
];

const isRelease = (v) => /^\d+\.\d+(\.\d+)?$/.test(String(v));
function parseVer(s) {
  const m = String(s).trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [+m[1], +(m[2] || 0), +(m[3] || 0)] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Fabric 的 SemVer（1.5.10）：版本核心可以有任意段，「-」后面是预发布（逐段比，数字按大小、文字按字典序，
 * 带预发布的比不带的小，「1.21-」这种空预发布最小），「+」后面的构建信息不参与比较。
 * 以前只取前三个数字，「1.20-3.1.44」和「1.20-2.7.32」都成了 1.20.0，Sodium 对 Supplementaries 的 breaks 被误判
 */
function parseSemver(s) {
  const str = String(s).trim().replace(/^v/i, '');
  const m = str.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.+-]*)?$/);
  if (m) return { core: m[1].split('.').map(Number), pre: m[2] === undefined ? null : m[2] === '' ? [] : m[2].split('.') };
  // 不标准的写法（如 1.20.1_v2）退回只看开头的数字
  const loose = parseVer(str);
  return loose ? { core: loose, pre: null } : null;
}

function cmpSemver(a, b) {
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const d = (a.core[i] || 0) - (b.core[i] || 0);
    if (d) return d;
  }
  if (!a.pre || !b.pre) return (a.pre ? -1 : 0) - (b.pre ? -1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const x = a.pre[i];
    const y = b.pre[i];
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x - +y; } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function semverOne(c, v) {
  const m = c.trim().match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
  if (!m) return true;
  const op = m[1] || '=';
  const raw = m[2].trim();
  const core = raw.split(/[-+]/)[0].replace(/\.$/, '');
  if (/[xX*]/.test(core)) {
    const parts = core.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (/[xX*]/.test(parts[i])) return true;
      if (+parts[i] !== (v.core[i] || 0)) return false;
    }
    return true;
  }
  const t = parseSemver(raw);
  if (!t) return true;
  const c2 = cmpSemver(v, t);
  // ~1.2.3：>=1.2.3 且 <1.3.0-；^1.2.3：>=1.2.3 且 <2.0.0-（「-」= 下一档的最小预发布）
  const below = (next) => cmpSemver(v, { core: next, pre: [] }) < 0;
  switch (op) {
    case '>=': return c2 >= 0;
    case '<=': return c2 <= 0;
    case '>': return c2 > 0;
    case '<': return c2 < 0;
    case '~': return c2 >= 0 && below(t.core.length > 1 ? [t.core[0], t.core[1] + 1] : [t.core[0] + 1]);
    case '^': return c2 >= 0 && below([t.core[0] + 1]);
    default: return c2 === 0;
  }
}

function semverMatch(ranges, mc) {
  const v = parseSemver(mc);
  if (!v) return false;
  return ranges.some((r) => {
    const s = String(r).trim();
    if (!s || s === '*') return true;
    return s.split('||').some((part) => part.trim().split(/\s+/).filter(Boolean).every((c) => semverOne(c, v)));
  });
}

function mavenMatch(ranges, mc) {
  const v = parseVer(mc);
  return ranges.some((r) => {
    const s = String(r).replace(/\s/g, '');
    if (!s || s === '*') return true;
    const groups = s.match(/[[(][^\])]*[\])]/g);
    if (!groups) return true; // 不带括号的版本号只是“推荐版本”
    return groups.some((g) => {
      const lowInc = g[0] === '[';
      const highInc = g[g.length - 1] === ']';
      const inner = g.slice(1, -1);
      if (!inner.includes(',')) { const t = parseVer(inner); return !t || cmp(v, t) === 0; }
      const [lo, hi] = inner.split(',');
      if (lo) { const t = parseVer(lo); if (t && (lowInc ? cmp(v, t) < 0 : cmp(v, t) <= 0)) return false; }
      if (hi) { const t = parseVer(hi); if (t && (highInc ? cmp(v, t) > 0 : cmp(v, t) >= 0)) return false; }
      return true;
    });
  });
}

function mcMatches(spec, mc) {
  if (!spec || !isRelease(mc)) return true;
  try {
    return spec.kind === 'maven' ? mavenMatch(spec.ranges, mc) : semverMatch(spec.ranges, mc);
  } catch { return true; }
}

function compatibleLoaders(loader, mc) {
  if (loader === 'fabric' || loader === 'legacyfabric') return ['fabric'];
  if (loader === 'quilt') return ['quilt', 'fabric'];
  if (loader === 'forge') return ['forge'];
  if (loader === 'neoforge') {
    const v = parseVer(mc);
    // 1.20.5 之前的 NeoForge Mod 仍使用 mods.toml
    return v && cmp(v, [1, 20, 5]) < 0 ? ['neoforge', 'forge'] : ['neoforge'];
  }
  return [];
}

const LOADER_NAMES = { fabric: 'Fabric', legacyfabric: 'Legacy Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', optifine: 'OptiFine' };
const modLabel = (m) => m.name || m.file;
const EMPTY_SECTION = { kind: 'semver', deps: {}, breaks: {}, conflicts: {}, mc: null };

/** 取出当前加载器实际会读取的那份元数据（多加载器 jar 中其他加载器的依赖不应参与检查） */
function section(m, loader, mc) {
  const b = (m && m.byLoader) || {};
  const order = compatibleLoaders(loader, mc);
  for (const l of order) if (b[l]) return b[l];
  return EMPTY_SECTION;
}

/** 判断一个 Mod 的版本是否落在声明的范围内；无法解析的版本不视为命中（避免误报） */
function versionInRanges(ranges, version, kind) {
  if (!ranges || !ranges.length || ranges.some((r) => !r || String(r).trim() === '*')) return true;
  if (!version || !parseVer(version)) return false;
  try {
    return kind === 'maven' ? mavenMatch(ranges, version) : semverMatch(ranges, version);
  } catch { return false; }
}

/** 版本范围写成玩家看得懂的话：~0.5.11 → 0.5.11 及以上、低于 0.6 */
function rangeText(ranges) {
  const one = (r) => {
    const s = String(r).trim();
    let m;
    if (!s || s === '*') return '任意版本';
    if ((m = s.match(/^~\s*v?(\d+)\.(\d+)(.*)$/))) return `${m[1]}.${m[2]}${m[3].split(/[-+]/)[0]} 及以上、低于 ${m[1]}.${Number(m[2]) + 1}`;
    if ((m = s.match(/^\^\s*v?(\d+)(.*)$/))) return `${m[1]}${m[2].split(/[-+]/)[0]} 及以上、低于 ${Number(m[1]) + 1}.0`;
    return s.replace(/>=\s*/g, '≥').replace(/<=\s*/g, '≤').replace(/(\d)-(?=\s|$)/g, '$1');
  };
  return (ranges || []).map(one).join(' 或 ');
}

module.exports = { BUILTIN, ID_ALIAS, KNOWN_CONFLICTS, LOADER_NAMES, compatibleLoaders, mcMatches, modLabel, parseVer, rangeText, section, versionInRanges };
