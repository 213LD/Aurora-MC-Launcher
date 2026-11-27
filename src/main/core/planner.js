'use strict';
/**
 * Mod 配置器：规划 → 推荐清单 → 依赖解析与冲突分析 → 安装 → （测试由 troubleshoot 完成）
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const paths = require('../engine/paths');
const versions = require('./versions');
const loaders = require('./loaders');
const profiles = require('./profiles');
const modrinth = require('./modrinth');
const mods = require('./mods');
const jarcheck = require('./jarcheck');
const modpack = require('./modpack');
const envelope = require('../engine/envelope');
const { downloadAll } = require('../engine/downloader');
const { exists, pool } = require('../engine/util');
const { fileNameOnly } = require('../engine/fileops');
const store = require('../engine/jsonstore');
const { nm, nmJoin } = require('../../shared/i18n');

// ───────────────────────── 玩法风格 ─────────────────────────
const FF = ['fabric', 'quilt'];
const STYLES = [
  {
    id: 'performance', name: '性能优化', icon: 'zap', desc: '提升帧率、减少卡顿与内存占用，几乎不改变原版体验',
    categories: ['optimization'],
    picks: {
      fabric: ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix', 'dynamic-fps', 'krypton'],
      forge: ['embeddium', 'ferrite-core', 'entityculling', 'modernfix', 'immediatelyfast', 'dynamic-fps', 'canary'],
      neoforge: ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'modernfix', 'immediatelyfast', 'dynamic-fps'],
    },
  },
  {
    id: 'qol', name: '实用增强', icon: 'wrench', desc: '小地图、合成表、方块信息、背包整理等便利功能',
    categories: ['utility'],
    picks: {
      fabric: ['modmenu', 'xaeros-minimap', 'xaeros-world-map', 'jei', 'jade', 'appleskin', 'mouse-tweaks', 'inventory-profiles-next'],
      forge: ['xaeros-minimap', 'xaeros-world-map', 'jei', 'jade', 'appleskin', 'mouse-tweaks', 'controlling', 'inventory-profiles-next'],
      neoforge: ['xaeros-minimap', 'xaeros-world-map', 'jei', 'jade', 'appleskin', 'mouse-tweaks', 'controlling', 'inventory-profiles-next'],
    },
  },
  {
    id: 'visual', name: '画质光影', icon: 'sun', desc: '光影加载器、连接纹理、动态光源与更生动的动画',
    categories: [],
    query: 'animation',
    picks: {
      fabric: ['iris', 'sodium', 'continuity', 'lambdynamiclights', 'entity-model-features', 'entitytexturefeatures', '3dskinlayers', 'falling-leaves', 'visuality'],
      forge: ['oculus', 'embeddium', 'entity-model-features', 'entitytexturefeatures', '3dskinlayers', 'falling-leaves', 'not-enough-animations'],
      neoforge: ['iris', 'sodium', 'entity-model-features', 'entitytexturefeatures', '3dskinlayers', 'falling-leaves', 'not-enough-animations'],
    },
  },
  {
    id: 'adventure', name: '冒险探索', icon: 'globe', desc: '更壮观的地形、遗迹结构、新的生物群系与地下城',
    categories: ['adventure', 'worldgen'],
    picks: { all: ['terralith', 'tectonic', 'yungs-better-dungeons', 'yungs-better-mineshafts', 'yungs-better-strongholds', 'when-dungeons-arise', 'towns-and-towers', 'explorify'] },
  },
  {
    id: 'tech', name: '科技工业', icon: 'cpu', desc: '机器、自动化、物流、能源与存储网络',
    categories: ['technology', 'storage'],
    picks: { forge: ['create', 'ae2'], neoforge: ['create', 'ae2', 'modern-industrialization'], fabric: ['create-fabric', 'modern-industrialization', 'tech-reborn', 'ae2'] },
  },
  {
    id: 'magic', name: '魔法奇幻', icon: 'sparkles', desc: '法术、魔法物品、神秘仪式与奇幻生物',
    categories: ['magic'],
    picks: { forge: ['ars-nouveau', 'irons-spells-n-spellbooks', 'botania'], neoforge: ['ars-nouveau', 'irons-spells-n-spellbooks', 'botania'], fabric: ['botania'] },
  },
  {
    id: 'building', name: '建筑装饰', icon: 'home', desc: '家具、装饰方块与更方便的建造',
    categories: ['decoration'],
    picks: { all: ['supplementaries', 'handcrafted', 'macaws-furniture'] },
  },
  {
    id: 'farming', name: '农业美食', icon: 'heart', desc: '新作物、料理与更丰富的农场生活',
    categories: ['food'],
    picks: { forge: ['farmers-delight'], neoforge: ['farmers-delight'], fabric: ['farmers-delight-refabricated'] },
  },
  {
    id: 'mobs', name: '生物挑战', icon: 'shield', desc: '新的生物与 Boss，以及更具挑战的生存机制',
    categories: ['mobs', 'game-mechanics'],
    picks: {},
  },
  {
    id: 'skins', name: '皮肤与模型', icon: 'user', desc: '离线皮肤、3D 皮肤层、耳朵和尾巴；换模 Mod 可以在推荐清单里自己加',
    categories: [],
    query: 'skin',
    picks: { all: ['customskinloader', '3dskinlayers', 'ears'] },
  },
  {
    id: 'social', name: '联机社交', icon: 'users', desc: '语音聊天、动作表情等多人游戏辅助',
    categories: ['social'],
    picks: { all: ['simple-voice-chat', 'emotecraft'] },
  },
];

// 已知冲突与功能重复（Modrinth slug）
const CONFLICTS = [
  [['sodium'], ['embeddium', 'rubidium', 'magnesium'], '渲染引擎冲突，只能安装其中一个'],
  [['embeddium'], ['rubidium'], '渲染引擎冲突，只能安装其中一个'],
  [['iris'], ['oculus'], '都是光影加载器，只能安装其中一个'],
  [['lithium'], ['canary', 'radium'], '功能相同的优化 Mod（移植版），只能保留一个'],
  [['starlight'], ['phosphor'], '光照引擎优化相互冲突'],
  [['fabric-api'], ['qsl'], 'Quilt 上请只保留 QFAPI 或 Fabric API 之一'],
];
const OVERLAPS = [
  ['小地图', ['xaeros-minimap', 'journeymap', 'voxelmap-updated', 'ftb-chunks-forge', 'ftb-chunks-fabric']],
  ['合成表查看', ['jei', 'rei', 'emi']],
  ['方块信息显示', ['jade', 'wthit', 'the-one-probe']],
  ['视野缩放', ['ok-zoomer', 'zoomify', 'logical-zoom']],
  ['背包整理', ['inventory-profiles-next', 'inventory-sorter', 'mouse-wheelie']],
  ['动态光源', ['lambdynamiclights', 'sodium-dynamic-lights', 'dynamiclights-reforged']],
  ['离线皮肤', ['customskinloader', 'offlineskins']],
  ['换模', ['custom-player-models', 'yes-steve-model', 'figura']],
];
const OBSOLETE = [
  ['starlight', [1, 20, 0], '1.20 起原版已整合 Starlight 的光照优化，无需再安装'],
  ['phosphor', [1, 19, 0], '1.19 起已不再需要 Phosphor'],
  ['lazydfu', [1, 20, 5], '新版本已不再需要 LazyDFU'],
];

const RECOMMENDED_VERSIONS = [
  { mc: '1.20.1', tag: 'Mod 最丰富', loaders: ['forge', 'fabric', 'neoforge'] },
  { mc: '1.21.1', tag: '新版主流', loaders: ['neoforge', 'fabric'] },
  { mc: '1.18.2', tag: '经典整合包', loaders: ['forge', 'fabric'] },
  { mc: '1.16.5', tag: '老牌整合包', loaders: ['forge', 'fabric'] },
  { mc: '1.12.2', tag: '怀旧经典', loaders: ['forge'] },
];

function parseVer(s) {
  const m = String(s).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}
const verGte = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

function picksFor(style, loader) {
  const p = style.picks || {};
  const key = FF.includes(loader) ? 'fabric' : loader;
  return [...new Set([...(p.all || []), ...(p[key] || []), ...(loader === 'quilt' ? p.quilt || [] : [])])];
}

const supports = (p, mc, loader) => {
  const ll = modrinth.loaderList(loader) || [];
  return (!mc || (p.gameVersions || []).includes(mc)) && (!loader || (p.loaders || []).some((l) => ll.includes(l)));
};

const itemOf = (p, extra) => ({
  projectId: p.id, slug: p.slug, title: p.title, description: p.description, icon: p.icon, downloads: p.downloads,
  categories: (p.categories || []).filter((c) => !['fabric', 'forge', 'neoforge', 'quilt'].includes(c)), clientSide: p.clientSide, ...extra,
});

/** 根据版本、加载器与玩法生成推荐清单 */
async function recommend({ mc, loader, styles = [] }) {
  const chosen = STYLES.filter((s) => styles.includes(s.id));
  const items = new Map();
  const add = (p, extra) => {
    if (items.has(p.id)) return;
    items.set(p.id, itemOf(p, extra));
  };

  // 精选（只保留支持该版本与加载器的）
  const pickSlugs = chosen.flatMap((s) => picksFor(s, loader).map((slug) => ({ slug, style: s.id })));
  const projs = pickSlugs.length ? await modrinth.projects(pickSlugs.map((x) => x.slug)) : [];
  const bySlug = new Map(projs.map((p) => [p.slug, p]));
  const pickCount = {};
  for (const { slug, style } of pickSlugs) {
    const p = bySlug.get(slug);
    if (!p || !supports(p, mc, loader)) continue;
    add(p, { style, source: 'pick', selected: true });
    pickCount[style] = (pickCount[style] || 0) + 1;
  }

  // 热门（按分类搜索）
  await pool(chosen, 3, async (s) => {
    const queries = s.categories.length ? s.categories.map((c) => ({ categories: [c] })) : [{ query: s.query || '' }];
    for (const q of queries) {
      try {
        const r = await modrinth.search({ type: 'mod', gameVersion: mc, loader, sort: 'downloads', limit: 12, ...q });
        let n = 0;
        for (const p of r.hits) {
          if ((p.categories || []).includes('library')) continue;
          if (items.has(p.id)) continue;
          const autoSelect = (pickCount[s.id] || 0) + n < 3;
          add(p, { style: s.id, source: 'popular', selected: autoSelect });
          n++;
          if (n >= 8) break;
        }
      } catch (e) { console.warn('[planner] 搜索失败', s.id, e.message); }
    }
  });
  return { items: [...items.values()] };
}

/** 解析清单：为每个 Mod 选出适配的版本、补全前置、分析冲突 */
async function resolve({ mc, loader, items = [] }) {
  const selected = items.filter((i) => i.selected && !i.local && (i.projectId || i.slug));
  const ids = selected.map((i) => i.projectId || i.slug);
  const projs = ids.length ? await modrinth.projects(ids) : [];
  const projById = new Map();
  for (const p of projs) { projById.set(p.id, p); projById.set(p.slug, p); }

  const out = new Map(); // projectId → item
  const queue = [];
  for (const it of selected) {
    const p = projById.get(it.projectId || it.slug);
    if (!p) {
      out.set(`missing:${it.projectId || it.slug}`, { ...it, status: 'not-found' });
      continue;
    }
    if (out.has(p.id)) continue;
    out.set(p.id, {
      ...itemOf(p, { style: it.style, source: it.source }), selected: true, pinnedVersionId: it.pinnedVersionId || null,
      // 编辑已有配置时：保留“已安装”的标记，避免重复下载
      installed: !!it.installed, file: it.file || null, enabled: it.enabled,
    });
    queue.push(p.id);
  }

  const optional = new Map();
  const incompatible = [];
  const resolveVersion = async (pid, pinned) => {
    if (pinned) {
      const v = await modrinth.version(pinned).catch(() => null);
      if (v && v.gameVersions.includes(mc)) return v;
    }
    return modrinth.bestVersion(await modrinth.projectVersions(pid, { loader, gameVersion: mc }).catch(() => []));
  };

  for (let depth = 0; queue.length && depth < 5; depth++) {
    const batch = queue.splice(0, queue.length);
    const newDeps = new Map();
    await pool(batch, 6, async (pid) => {
      const item = out.get(pid);
      const v = await resolveVersion(pid, item.pinnedVersionId);
      if (!v) { item.status = 'unavailable'; return; }
      const file = v.files.find((f) => f.primary) || v.files[0];
      item.status = file ? 'ok' : 'unavailable';
      item.version = { id: v.id, number: v.number, type: v.type, published: v.published, file };
      for (const d of v.dependencies) {
        let depPid = d.projectId;
        if (!depPid && d.versionId) {
          const dv = await modrinth.version(d.versionId).catch(() => null);
          depPid = dv && dv.projectId;
        }
        if (!depPid || depPid === pid) continue;
        if (d.type === 'required') {
          if (!out.has(depPid)) {
            if (!newDeps.has(depPid)) newDeps.set(depPid, []);
            newDeps.get(depPid).push(item.title);
          } else {
            const ex = out.get(depPid);
            ex.requiredBy = [...new Set([...(ex.requiredBy || []), item.title])];
          }
        } else if (d.type === 'incompatible') {
          incompatible.push([pid, depPid]);
        } else if (d.type === 'optional') {
          if (!optional.has(depPid)) optional.set(depPid, []);
          optional.get(depPid).push(item.title);
        }
      }
    });
    if (newDeps.size) {
      const depProjs = await modrinth.projects([...newDeps.keys()]);
      for (const p of depProjs) {
        if (out.has(p.id)) continue;
        out.set(p.id, { ...itemOf(p, { style: 'deps', source: 'dependency' }), selected: true, dependency: true, requiredBy: newDeps.get(p.id) || [] });
        queue.push(p.id);
      }
    }
  }

  // jar 里声明的版本限制（1.5.8）：Modrinth 的依赖信息没有版本范围，下载前远程读 jar 的声明，能换版本解决的自动换。
  // 玩家固定了版本的、编辑配置时已经装好的不动
  const entries = [...out.values()].filter((i) => i.status === 'ok' && i.version && i.version.file)
    .map((i) => ({ key: i.projectId, title: i.title, pinned: !!i.pinnedVersionId || !!i.installed, version: i.version, item: i }));
  const jar = entries.length ? await jarcheck.solve(entries, { loader, mc }).catch(() => null) : null;
  if (jar) {
    for (const c of jar.changes) {
      const e = entries.find((x) => x.key === c.key);
      e.item.version = e.version;
      e.item.adjusted = { from: c.from, reasons: c.reasons };
    }
  }

  // 冲突分析
  const list = [...out.values()];
  const present = new Map(list.filter((i) => i.status === 'ok').map((i) => [i.slug, i]));
  const conflicts = [];
  // 每条冲突带类型和稳定的 key（类型 + 排序后的项目 id），界面按 key 记住玩家忽略了哪些
  // 类型：incompatible 作者声明不兼容、known 内置已知冲突、dep-unsupported 前置不支持该版本（crit，不能忽略）；overlap 功能重复、obsolete 已过时（warn，可以忽略）
  const add = (type, severity, ids, c) => conflicts.push({ type, severity, key: `${type}:${[...ids].sort().join(',')}`, ...c });
  for (const [a, b] of incompatible) {
    const x = out.get(a);
    const y = out.get(b);
    if (x && y && x.status === 'ok' && y.status === 'ok') {
      add('incompatible', 'crit', [x.projectId, y.projectId], { a: x.projectId, b: y.projectId, title: `${nm(x.title)} 与 ${nm(y.title)} 不兼容`, detail: `${nm(x.title)} 的作者在 Modrinth 上标注了与 ${nm(y.title)} 不兼容` });
    }
  }
  for (const [as, bs, reason] of CONFLICTS) {
    const x = as.map((s) => present.get(s)).find(Boolean);
    const y = bs.map((s) => present.get(s)).find(Boolean);
    if (x && y) add('known', 'crit', [x.projectId, y.projectId], { a: x.projectId, b: y.projectId, title: `${nm(x.title)} 与 ${nm(y.title)} 冲突`, detail: reason });
  }
  for (const [group, slugs] of OVERLAPS) {
    const hit = slugs.map((s) => present.get(s)).filter(Boolean);
    if (hit.length > 1) {
      add('overlap', 'warn', hit.map((h) => h.projectId), { projects: hit.map((h) => h.projectId), title: `功能重复：${nmJoin(hit.map((h) => h.title))}`, detail: `都属于「${nm(group)}」类 Mod，通常只需要保留一个` });
    }
  }
  const mcv = parseVer(mc);
  if (mcv) {
    for (const [slug, since, reason] of OBSOLETE) {
      const x = present.get(slug);
      if (x && verGte(mcv, since)) add('obsolete', 'warn', [x.projectId], { a: x.projectId, title: `${nm(x.title)} 已过时`, detail: reason });
    }
  }
  for (const c of (jar && jar.left) || []) {
    add('jar', 'crit', [c.a, c.b], { a: c.a, b: c.b, title: c.title, detail: `${c.detail}。换了别的版本也没能解决，请移除其中一个` });
  }
  const unavailable = list.filter((i) => i.status !== 'ok');
  for (const u of unavailable.filter((i) => i.dependency)) {
    add('dep-unsupported', 'crit', [u.projectId], { a: u.projectId, title: `前置 ${nm(u.title)} 不支持 ${mc}`, detail: `${nmJoin(u.requiredBy || [])} 需要它，但它没有适用于该版本的文件` });
  }

  // 可选搭配（不自动添加）
  const optIds = [...optional.keys()].filter((id) => !out.has(id)).slice(0, 12);
  const optProjs = optIds.length ? await modrinth.projects(optIds).catch(() => []) : [];
  const suggestions = optProjs.filter((p) => supports(p, mc, loader)).map((p) => itemOf(p, { style: 'suggest', source: 'optional', reason: `${nmJoin(optional.get(p.id).slice(0, 2))} 的可选搭配` }));

  const ok = list.filter((i) => i.status === 'ok');
  return {
    items: list,
    conflicts,
    suggestions,
    // 为了能一起用自动换了版本的 Mod：[{ key, title, from, to, reasons }]；jarChecked：读到了 jar 声明的 Mod 数
    adjusted: jar ? jar.changes : [],
    jarChecked: jar ? jar.checked : 0,
    totals: {
      count: ok.filter((i) => !i.dependency).length,
      deps: ok.filter((i) => i.dependency).length,
      size: ok.reduce((s, i) => s + ((i.version && i.version.file && i.version.file.size) || 0), 0),
      unavailable: unavailable.length,
      errors: conflicts.filter((c) => c.severity === 'crit').length,
      warnings: conflicts.filter((c) => c.severity === 'warn').length,
    },
  };
}

/** 按计划安装：创建（或使用已有）游戏配置并下载全部 Mod */
async function install(params, task) {
  const created = { id: null };
  try {
    return await installInto(params, task, created);
  } catch (e) {
    // 新建的配置装到一半失败或取消：整个删掉（是这次新建的，里面没有玩家的东西），不留半个配置在列表里。装进已有配置的不删
    if (created.id) await versions.removeVersion(created.id, { permanent: true }).catch((err) => console.warn(`[planner] 清理 ${created.id} 失败`, err.message));
    throw e;
  }
}

async function installInto({ plan, resolved, target }, task, created) {
  const { mc, loader } = plan;
  let versionId;
  if (target.mode === 'existing') {
    versionId = target.versionId;
    const info = await versions.versionInfo(versionId);
    if (!info) throw new Error('目标配置不存在');
    if (!info.loader || info.loader.type !== loader) throw new Error(`目标配置的加载器（${info.loader ? info.loader.type : '无'}）与计划不一致`);
    if (info.mcVersion !== mc) throw new Error(`目标配置的游戏版本（${nm(info.mcVersion)}）与计划不一致`);
  } else {
    versionId = (target.name || plan.name || `${mc}-${loader}`).trim();
    versions.validateName(versionId);
    if (await exists(versions.versionJsonPath(versionId))) throw new Error(`配置 ${nm(versionId)} 已存在`);
    task.update({ detail: `获取 ${loader} 版本`, progress: -1 });
    const list = await loaders.list(loader, mc);
    const lv = list.find((x) => x.recommended) || list.find((x) => x.stable) || list[0];
    if (!lv) throw new Error(`${loader} 不支持 Minecraft ${mc}`);
    created.id = versionId;
    await loaders.install({ mc, name: versionId, loader: { type: loader, version: lv.version, full: lv.full } }, task);
  }
  await profiles.markProfile(versionId, plan.profileType || 'planner', {
    planId: plan.id, name: plan.name,
    description: plan.description || (plan.styles || []).map((s) => (STYLES.find((x) => x.id === s) || {}).name).filter(Boolean).join(' · '),
  });

  const { dir } = await mods.targetDir(versionId, 'mod');
  await fsp.mkdir(dir, { recursive: true });
  const ok = (resolved.items || []).filter((i) => i.status === 'ok' && i.version && i.version.file && /^https:\/\//.test(i.version.file.url));
  // 文件名来自网络（经过界面传回来）：只留最后一段再拼进 mods 文件夹
  const files = ok.map((i) => ({ urls: [i.version.file.url], path: path.join(dir, fileNameOnly(i.version.file.filename, 'mod.jar')), sha1: i.version.file.sha1, size: i.version.file.size }));
  await downloadAll(files, { task, label: '下载 Mod' });

  let copied = 0;
  for (const it of (plan.items || []).filter((i) => i.local && i.selected && i.localPath)) {
    if (await exists(it.localPath)) { await fsp.copyFile(it.localPath, path.join(dir, path.basename(it.localPath))); copied++; }
  }
  const entries = {};
  for (const i of ok) entries[fileNameOnly(i.version.file.filename, 'mod.jar')] = { projectId: i.projectId, versionId: i.version.id, versionNumber: i.version.number, slug: i.slug, title: i.title, icon: i.icon, source: 'modrinth' };
  await profiles.setModInfo(versionId, entries);

  const { autoDeps, unresolved } = await fillMissingDeps(versionId, task);
  return { versionId, downloaded: files.length, copied, autoDeps, unresolved };
}

/** Modrinth 上的依赖信息并不总是完整：再按 jar 内声明的依赖检查一遍，自动补齐缺失的前置 */
async function fillMissingDeps(versionId, task) {
  const autoDeps = [];
  const unresolved = [];
  const troubleshoot = require('./troubleshoot');
  for (let pass = 0; pass < 2; pass++) {
    task.update({ detail: '检查 Mod 声明的前置…', progress: -1 });
    const check = await troubleshoot.staticCheck(versionId);
    const missing = check.issues.filter((i) => i.type === 'missing-dep' && !unresolved.includes(i.modId));
    if (!missing.length) break;
    for (const m of missing) {
      try {
        const r = await troubleshoot.installDep(versionId, m.modId, task);
        autoDeps.push(r.title);
      } catch (e) {
        if (e.cancelled) throw e;
        unresolved.push(m.modId);
      }
    }
  }
  return { autoDeps, unresolved };
}

/**
 * 额外 Mod：任何方式创建配置后，都可以再加上玩家自选的 Modrinth Mod 与本地 jar
 * @param {{extraProjects?: string[], localFiles?: string[]}} extras
 */
async function addExtras(versionId, { extraProjects = [], localFiles = [] } = {}, task) {
  const info = await versions.versionInfo(versionId);
  if (!info || !info.loader) return { added: [], copied: 0, autoDeps: [], unresolved: [] };
  const loader = info.loader.type;
  const added = [];
  for (const id of extraProjects) {
    try {
      const v = modrinth.bestVersion(await modrinth.projectVersions(id, { loader, gameVersion: info.mcVersion }));
      if (!v) continue;
      task.update({ detail: '下载额外的 Mod…', progress: -1 });
      added.push(...(await mods.installProjectVersion({ versionId, projectVersion: v, kind: 'mod', withDeps: true }, task)));
    } catch (e) {
      if (e.cancelled) throw e;
      console.warn('[extras] 安装失败', id, e.message);
    }
  }
  let copied = 0;
  if (localFiles.length) {
    const { dir } = await mods.targetDir(versionId, 'mod');
    await fsp.mkdir(dir, { recursive: true });
    for (const f of localFiles) {
      if (!/\.(jar|zip)$/i.test(f)) continue;
      try { await fsp.copyFile(f, path.join(dir, path.basename(f))); copied++; } catch (e) { console.warn('[extras] 复制失败', f, e.message); }
    }
  }
  const deps = added.length || copied ? await fillMissingDeps(versionId, task) : { autoDeps: [], unresolved: [] };
  return { added, copied, ...deps };
}

// ───────────────────────── 修改已有配置 ─────────────────────────
/** 读取已有配置：自动识别游戏版本、加载器、API 版本与已安装的 Mod */
async function fromProfile(versionId) {
  const info = await versions.versionInfo(versionId);
  if (!info) throw new Error('配置不存在');
  if (!info.loader || !['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'].includes(info.loader.type)) throw new Error('该配置没有安装 Mod 加载器，无法用配置器修改');
  await mods.identify(versionId).catch(() => {});
  const { mods: list } = await mods.listMods(versionId);
  const meta = await profiles.detail(versionId);
  const items = [];
  const seen = new Set();
  for (const m of list) {
    const src = m.modrinth;
    if (src && src.projectId && !seen.has(src.projectId)) {
      seen.add(src.projectId);
      items.push({
        projectId: src.projectId, slug: src.slug, title: src.title || m.name, icon: src.icon || m.icon, description: m.description || '',
        selected: m.enabled, enabled: m.enabled, installed: true, file: m.file, versionNumber: src.versionNumber || m.version,
        pinnedVersionId: src.versionId, style: 'installed', source: 'installed',
      });
    } else {
      items.push({
        title: m.name, description: m.description || m.file, icon: m.icon, local: true, installed: true, file: m.file, enabled: m.enabled,
        selected: m.enabled, versionNumber: m.version, style: 'installed', source: 'installed-local', status: 'local',
      });
    }
  }
  const api = list.find((m) => (m.ids || []).includes('fabric-api') || (m.ids || []).includes('qsl'));
  return {
    profileId: versionId,
    name: meta.name || versionId,
    mc: info.mcVersion,
    loader: info.loader.type,
    loaderVersion: info.loader.version,
    apiVersion: api ? api.version : null,
    saves: meta.saves ? meta.saves.count : 0,
    playTime: meta.stats ? meta.stats.playTime : 0,
    profileType: meta.type,
    items,
  };
}

/**
 * 应用对已有配置的修改：下载新增的 Mod，移除（禁用或删除）取消勾选的 Mod，重新启用勾选的已禁用 Mod
 * @param {{versionId:string, plan:object, resolved:object, removeMode:'disable'|'trash'}} params
 */
async function applyEdit({ versionId, plan, resolved, removeMode = 'disable' }, task) {
  const { dir } = await mods.targetDir(versionId, 'mod');
  const { mods: current } = await mods.listMods(versionId);
  const byBase = new Map(current.map((m) => [m.base, m]));
  const installedProjects = new Set(current.map((m) => m.modrinth && m.modrinth.projectId).filter(Boolean));

  // 没能在 Modrinth 上识别的本地 Mod，通过 Mod ID / 文件名避免重复安装
  const localIds = new Set(current.flatMap((m) => [...(m.ids || []), ...(m.provides || [])].map((x) => String(x).toLowerCase())));
  const files = new Set(current.map((m) => m.base));
  const added = (resolved.items || []).filter((i) => i.status === 'ok' && !i.installed && !installedProjects.has(i.projectId)
    && i.version && i.version.file && /^https:\/\//.test(i.version.file.url)
    && !files.has(i.version.file.filename) && !(i.dependency && localIds.has(String(i.slug).toLowerCase())));
  task.update({ detail: `下载 ${added.length} 个新增的 Mod`, progress: -1 });
  await downloadAll(added.map((i) => ({ urls: [i.version.file.url], path: path.join(dir, i.version.file.filename), sha1: i.version.file.sha1, size: i.version.file.size })), { task, label: '下载 Mod' });
  const entries = {};
  for (const i of added) entries[i.version.file.filename] = { projectId: i.projectId, versionId: i.version.id, versionNumber: i.version.number, slug: i.slug, title: i.title, icon: i.icon, source: 'modrinth' };
  if (Object.keys(entries).length) await profiles.setModInfo(versionId, entries);

  const removed = [];
  const enabled = [];
  for (const it of plan.items || []) {
    if (!it.installed || !it.file) continue;
    const m = byBase.get(profiles.baseName(it.file));
    if (!m) continue;
    if (!it.selected && m.enabled) {
      // 回收站不可用时改为禁用，不永久删除玩家的文件
      if (removeMode === 'trash') await mods.removeMod(m.path, versionId).catch(() => mods.toggleMod(m.path, false));
      else await mods.toggleMod(m.path, false);
      removed.push(m.name);
    } else if (it.selected && !m.enabled) {
      await mods.toggleMod(m.path, true);
      enabled.push(m.name);
    }
  }
  const { autoDeps, unresolved } = await fillMissingDeps(versionId, task);
  await profiles.recordTroubleshoot(versionId, {
    kind: 'edit', ok: true,
    summary: `配置器修改：新增 ${added.length} 个、${removeMode === 'trash' ? `删除 ${removed.length} 个` : `禁用 ${removed.length} 个`}、重新启用 ${enabled.length} 个${autoDeps.length ? `，自动补齐 ${autoDeps.length} 个前置` : ''}`,
  }).catch(() => {});
  return { versionId, added: added.map((i) => i.title), removed, enabled, autoDeps, unresolved, removeMode };
}

// ───────────────────────── 导入 ─────────────────────────
function parseLine(raw) {
  let s = raw.trim().replace(/^[-*•\d.)、\s]+/, '').trim();
  if (!s || s.startsWith('#') || s.startsWith('//')) return null;
  const mr = s.match(/modrinth\.com\/(?:mod|plugin|datapack)\/([\w.-]+)/i);
  if (mr) return { slug: mr[1], raw: s };
  const cf = s.match(/curseforge\.com\/minecraft\/mc-mods\/([\w-]+)/i);
  if (cf) return { slug: cf[1], query: cf[1].replace(/-/g, ' '), raw: s };
  // 文件名形式（sodium-fabric-0.5.3+mc1.20.1.jar）去掉版本号与加载器后缀
  if (/\.jar$/i.test(s) || !/\s/.test(s)) {
    s = s.replace(/\.jar$/i, '');
    const stripped = s.replace(/[-_+ ](?:v?\d[\w.+-]*|mc\d.*|fabric.*|forge.*|neoforge.*|quilt.*)$/i, '');
    if (stripped) s = stripped;
  }
  s = s.trim();
  return { slug: s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, ''), query: s, raw: raw.trim() };
}

async function importText(text, { mc, loader } = {}) {
  const lines = String(text || '').split(/\r?\n|,|，/).map(parseLine).filter(Boolean).slice(0, 300);
  const results = [];
  // 连不上网时不用一行一行试：每行都要等重试，300 行要等好几分钟（2.0.0-pre8，全面测试）。HTTP 错误（比如 404）不算断网
  let netFails = 0;
  const tryNet = (q) => q.catch((e) => { if (!e.status) netFails++; return null; });
  await pool(lines, 5, async (l) => {
    let p = null;
    let how = 'exact';
    if (netFails < 5 && l.slug) p = await tryNet(modrinth.project(l.slug));
    if (p && p.type !== 'mod') p = null;
    if (netFails < 5 && !p && l.query) {
      how = 'search';
      const r = await tryNet(modrinth.search({ query: l.query, type: 'mod', gameVersion: mc, loader, limit: 1 }));
      p = r && r.hits[0];
      if (!p) {
        const r2 = await tryNet(modrinth.search({ query: l.query, type: 'mod', limit: 1 }));
        p = r2 && r2.hits[0];
      }
    }
    results.push(p ? itemOf(p, { style: 'import', source: 'import', selected: true, matched: how, input: l.raw }) : { title: l.raw, input: l.raw, status: 'not-found', style: 'import', source: 'import', selected: false });
  });
  return { items: results };
}

async function itemsFromJars(jars) {
  const found = await modrinth.identify(jars.map((j) => j.sha1));
  const pids = [...new Set(Object.values(found).map((v) => v.projectId))];
  const projs = pids.length ? await modrinth.projects(pids) : [];
  const byId = new Map(projs.map((p) => [p.id, p]));
  const items = [];
  for (const j of jars) {
    const v = found[j.sha1];
    const p = v && byId.get(v.projectId);
    if (p) items.push(itemOf(p, { style: 'import', source: 'import', selected: true, matched: 'hash', input: j.file, pinnedVersionId: v.id }));
    else items.push({ title: j.name || j.file, input: j.file, local: true, localPath: j.path, selected: true, style: 'import', source: 'local', status: 'local' });
  }
  return items;
}

async function importFolder(dir) {
  const files = (await mods.scanDir(dir)).filter((f) => f.enabled);
  const jars = [];
  await pool(files, 6, async (f) => {
    const meta = await mods.readModMeta(f.full).catch(() => null);
    jars.push({ file: f.fileName, path: f.full, sha1: await mods.sha1Of(f.full, f.st), name: meta && meta.name, loaders: meta && meta.loaders });
  });
  const detectedLoader = (() => {
    const c = {};
    for (const j of jars) for (const l of j.loaders || []) c[l] = (c[l] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  })();
  return { items: await itemsFromJars(jars), loader: detectedLoader ? detectedLoader[0] : null };
}

async function importProfile(versionId) {
  const { mods: list, info } = await mods.listMods(versionId, { withHash: true });
  const jars = list.filter((m) => m.enabled).map((m) => ({ file: m.file, path: m.path, sha1: m.sha1, name: m.name }));
  return { items: await itemsFromJars(jars), mc: info.mcVersion, loader: info.loader && info.loader.type };
}

async function importMrpack(file) {
  const pack = await modpack.readMrpack(file);
  const ids = [];
  const pinned = new Map();
  for (const f of pack.files) {
    if (!/^mods\//.test(f.path)) continue;
    const x = (f.downloads || []).map(modrinth.parseCdnUrl).find(Boolean);
    if (x) { ids.push(x.projectId); pinned.set(x.projectId, x.versionId); }
  }
  const projs = ids.length ? await modrinth.projects(ids) : [];
  const items = projs.map((p) => itemOf(p, { style: 'import', source: 'import', selected: true, matched: 'mrpack', pinnedVersionId: pinned.get(p.id) }));
  return { items, mc: pack.mc, loader: pack.loader && pack.loader.type, name: pack.name, bundled: pack.overrideMods };
}

/** 以 Modrinth 上的整合包为基础 */
async function importModrinthPack(projectId) {
  const v = modrinth.bestVersion(await modrinth.projectVersions(projectId, { type: 'modpack' }));
  if (!v) throw new Error('该整合包没有可用版本');
  const file = v.files.find((f) => f.filename.endsWith('.mrpack'));
  if (!file) throw new Error('该整合包没有 .mrpack 文件');
  const dest = path.join(paths.cacheDir(), 'modpacks', file.filename);
  const { downloadFile } = require('../engine/downloader');
  await downloadFile({ urls: [file.url], path: dest, sha1: file.sha1, size: file.size }, { label: '读取整合包' });
  try { return await importMrpack(dest); } finally { await fsp.rm(dest, { force: true }).catch(() => {}); }
}

// ───────────────────────── 清单文件（1.5.1，外壳和校验在 envelope.js）─────────────────────────
const LIST_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
const MR_ID = /^[A-Za-z0-9]{6,12}$/;

/** 只导出勾选了的 Modrinth Mod；本地文件的路径只在这台电脑上有效，不导出 */
function exportList(plan) {
  const sel = ((plan && plan.items) || []).filter((i) => i.selected);
  const items = sel.filter((i) => i.projectId).map((i) => ({
    projectId: i.projectId, slug: i.slug || '', title: i.title || '', style: i.style || 'import', pinnedVersionId: i.pinnedVersionId || null,
  }));
  const data = { name: plan.name || '', mc: plan.mc || '', loader: plan.loader || '', styles: plan.styles || [], items };
  return { text: envelope.seal('mod-list', data), count: items.length, skippedLocal: sel.length - items.length };
}

async function importList(file) {
  const st = await fsp.stat(file);
  if (st.size > 5 * 1024 * 1024) return { ok: false, problems: [{ level: 'block', code: 'size', text: '文件太大（超过 5 MB），不像是 Mod 清单' }] };
  const r = envelope.open(await fsp.readFile(file, 'utf8'), 'mod-list');
  if (!r.ok) return { ok: false, problems: r.problems };
  const d = r.data;
  const problems = [...r.problems];
  const risk = (text) => problems.push({ level: 'risk', code: 'schema', text });
  if (!Array.isArray(d.items)) return { ok: false, problems: [...problems, { level: 'block', code: 'schema', text: '文件里的 Mod 列表缺失或格式不对，无法导入' }] };
  let mc = typeof d.mc === 'string' && /^\d+\.\d+/.test(d.mc) ? d.mc : null;
  if (d.mc && !mc) risk(`Minecraft 版本「${String(d.mc).slice(0, 30)}」写法不对，导入时不会切换版本`);
  let loader = LIST_LOADERS.includes(d.loader) ? d.loader : null;
  if (d.loader && !loader) risk(`不认识的加载器「${String(d.loader).slice(0, 30)}」，导入时不会切换加载器`);
  if (!mc) loader = null;
  if (d.items.length > 500) risk(`Mod 超过 500 个（${d.items.length} 个），只导入前 500 个`);
  const valid = [];
  let bad = 0;
  let badPin = 0;
  for (const it of d.items.slice(0, 500)) {
    if (!it || typeof it !== 'object' || typeof it.projectId !== 'string' || !MR_ID.test(it.projectId)) { bad++; continue; }
    if (it.pinnedVersionId != null && !(typeof it.pinnedVersionId === 'string' && MR_ID.test(it.pinnedVersionId))) badPin++;
    valid.push(it);
  }
  if (bad) risk(`有 ${bad} 项不符合清单格式（缺少或写错了 Modrinth 项目 ID），已跳过`);
  if (badPin) risk(`有 ${badPin} 项指定的 Mod 版本写法不对，这几项改为自动挑选版本`);
  const ids = [...new Set(valid.map((i) => i.projectId))];
  const projs = ids.length ? await modrinth.projects(ids) : [];
  const byId = new Map(projs.map((p) => [p.id, p]));
  const styleIds = new Set(STYLES.map((s) => s.id));
  const seen = new Set();
  const items = [];
  for (const it of valid) {
    if (seen.has(it.projectId)) continue;
    seen.add(it.projectId);
    const p = byId.get(it.projectId);
    const label = typeof it.title === 'string' && it.title ? it.title.slice(0, 80) : it.projectId;
    if (!p || p.type !== 'mod') { items.push({ title: label, input: it.projectId, status: 'not-found', style: 'import', source: 'import', selected: false }); continue; }
    const pin = typeof it.pinnedVersionId === 'string' && MR_ID.test(it.pinnedVersionId) ? it.pinnedVersionId : null;
    items.push(itemOf(p, { style: styleIds.has(it.style) ? it.style : 'import', source: 'import', selected: true, matched: 'list', pinnedVersionId: pin }));
  }
  const name = typeof d.name === 'string' ? d.name.slice(0, 60) : '';
  return { ok: true, items, mc, loader, name, meta: r.meta, problems, fromList: true };
}

// ───────────────────────── 方案存储 ─────────────────────────
const plansFile = () => path.join(paths.dataDir(), 'plans.json');
// 读坏了不会被下一次保存盖掉（jsonstore，1.10.7）
const PLANS = { label: 'Mod 配置器清单', fallback: { plans: [] } };

async function listPlans() {
  const d = await store.read(plansFile(), PLANS.fallback, PLANS);
  return (d.plans || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function savePlan(plan) {
  const p = { ...plan, id: plan.id || crypto.randomUUID(), updatedAt: Date.now() };
  if (!p.createdAt) p.createdAt = Date.now();
  await store.update(plansFile(), (d) => {
    const plans = d.plans || [];
    const i = plans.findIndex((x) => x.id === p.id);
    if (i >= 0) plans[i] = p; else plans.push(p);
    return { plans: plans.slice(-50) };
  }, PLANS);
  return p;
}

async function deletePlan(id) {
  await store.update(plansFile(), (d) => ({ plans: (d.plans || []).filter((p) => p.id !== id) }), PLANS);
}

function styles() {
  return { styles: STYLES.map(({ id, name, icon, desc }) => ({ id, name, icon, desc })), versions: RECOMMENDED_VERSIONS };
}

module.exports = { styles, recommend, resolve, install, fromProfile, applyEdit, fillMissingDeps, addExtras, importText, importFolder, importProfile, importMrpack, importModrinthPack, exportList, importList, listPlans, savePlan, deletePlan, STYLES };
