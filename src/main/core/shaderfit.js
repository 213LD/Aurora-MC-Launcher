'use strict';
/**
 * 光影「适合这台电脑」（1.5.9，B1）
 * - machine()：按一键修复测出的显卡档次（hardware.info）算出这台电脑大约能带动哪一档光影
 * - borrow(list)：CurseForge 的光影没有性能 / 特性标签，按名字到 Modrinth 找同名光影借它的标签
 * Modrinth 的性能标签是「有这一档的预设」（Complementary 同时标了土豆到高），所以按最低一档判断
 */
const hardware = require('./hardware');
const modrinth = require('./modrinth');

const LEVELS = ['potato', 'low', 'medium', 'high', 'screenshot'];
const LEVEL_NAMES = { potato: '土豆', low: '低', medium: '中', high: '高', screenshot: '截图级' };

/** 显卡档次 → 能带动的最高一档（-1 = 光影基本带不动） */
function levelOfTier(tier) {
  if (tier >= 2.5) return 3;
  if (tier >= 2) return 2;
  if (tier >= 1.5) return 1;
  if (tier >= 1) return 0;
  return -1;
}

/** { level, tier, gpu, conf, reason }：level 是 LEVELS 的下标 */
async function machine() {
  const hw = await hardware.info();
  const real = hw.gpus.filter((g) => !g.basic && !g.vm);
  if (!real.length) {
    const why = hw.gpus.some((g) => g.vm) || hw.vm ? '虚拟机里的显卡是模拟的' : '显卡驱动没装好（只有「基本显示适配器」）';
    return { level: -1, tier: 0, gpu: (hw.gpus[0] || {}).name || '', conf: 'known', reason: `${why}，光影基本开不起来` };
  }
  // 有独显看独显，否则看最好的那块
  const best = real.slice().sort((a, b) => (b.discrete - a.discrete) || (b.tier - a.tier))[0];
  const level = best.oldGl ? -1 : levelOfTier(best.tier);
  const reason = level < 0
    ? `${best.name} 太老了，大部分光影带不动（最多试试土豆档）`
    : `${best.name} 大约能带动「${LEVEL_NAMES[LEVELS[level]]}」档的光影`;
  return { level, tier: best.tier, gpu: best.name, conf: best.conf || 'known', reason };
}

const norm = (s) => String(s || '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\b(shaders?|shaderpacks?|pack|for|minecraft|java|edition|optifine|iris)\b/g, ' ')
  .replace(/[^a-z0-9一-鿿]+/g, '');

/** 名字对得上：整个名字、或「|」前面那段一样，或 slug 一样 */
function sameShader(cf, mr) {
  const a = [norm(cf.title), norm(String(cf.title).split('|')[0])].filter(Boolean);
  const b = [norm(mr.title), norm(String(mr.title).split('|')[0])].filter(Boolean);
  if (a.some((x) => b.includes(x))) return true;
  return !!cf.slug && !!mr.slug && norm(cf.slug) === norm(mr.slug) && norm(cf.slug).length >= 4;
}

/** 一个 CurseForge 光影 → { tags, title, slug } 或 null；结果存一周 */
async function borrowOne(p) {
  const key = `shaderborrow:${norm(p.title) || p.slug}`;
  return require('../engine/apicache').get('modrinth', key, async () => {
    const q = String(p.title).split('|')[0].replace(/\bshaders?\b/ig, '').trim() || p.title;
    const r = await modrinth.search({ query: q, type: 'shader', limit: 8 });
    const hit = r.hits.find((h) => sameShader(p, h));
    return hit ? { tags: hit.tags, title: hit.title, slug: hit.slug } : { none: true };
  }, 7 * 24 * 3600 * 1000).then((v) => (v && !v.none ? v : null));
}

/** list: [{ id, title, slug }] → { [id]: { tags, title, slug } | null }，最多 4 个一起查 */
async function borrow(list) {
  const out = {};
  const queue = (list || []).filter((p) => p && p.id && p.title).slice(0, 60);
  await Promise.all([...Array(4)].map(async () => {
    while (queue.length) {
      const p = queue.shift();
      out[p.id] = await borrowOne(p).catch(() => null);
    }
  }));
  return out;
}

module.exports = { LEVELS, machine, borrow, levelOfTier, sameShader };
