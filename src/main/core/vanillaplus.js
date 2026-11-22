'use strict';
/**
 * 纯净版+：保持原版玩法，只加入小地图、物品管理器、背包整理等 QoL 功能与光影 / 性能优化
 * 每类功能可以在多个同类 Mod 中自选，也可以额外添加 Modrinth 上的 Mod 或本地 .jar 文件
 */
const fsp = require('fs').promises;
const path = require('path');
const versions = require('./versions');
const loaders = require('./loaders');
const profiles = require('./profiles');
const modrinth = require('./modrinth');
const planner = require('./planner');
const { downloadFile } = require('../engine/downloader');
const { nm } = require('../../shared/i18n');

/**
 * options：同类 Mod 的候选（按顺序作为推荐）
 *   slug       Modrinth 项目
 *   loaders    仅适用于这些加载器（省略表示不限）
 *   with       选择它时一并安装的 Mod
 *   note       给玩家的说明
 */
const FEATURES = [
  {
    id: 'minimap', group: 'qol', name: '小地图', desc: '屏幕角落的小地图，支持路径点与死亡点。想用 Rei\'s Minimap 等未上架 Modrinth 的经典版本，可在下方「额外 Mod」中拖入 jar', default: true,
    options: [
      { slug: 'xaeros-minimap' },
      { slug: 'journeymap', note: '自带全屏地图与网页地图' },
      { slug: 'voxelmap-updated', note: 'Rei\'s Minimap 的继任者，风格相近' },
      { slug: 'minimap-ce', note: '适用于 1.6.4 等旧版本（Legacy Fabric）' },
    ],
  },
  {
    id: 'worldmap', group: 'qol', name: '世界地图', desc: '按 M 打开可缩放的全屏地图（JourneyMap 已自带，可不选）', default: true,
    options: [{ slug: 'xaeros-world-map' }],
  },
  {
    id: 'recipes', group: 'qol', name: '物品管理器 / 合成表', desc: '查询配方与用途；开启作弊模式后可直接拿取物品（类似 NEI）', default: true,
    options: [
      { slug: 'jei', note: '最经典，Forge 系整合包首选' },
      { slug: 'rei', note: '功能丰富，Fabric 上常见', with: ['architectury-api', 'cloth-config'] },
      { slug: 'emi', note: '界面现代，可显示合成树' },
      { slug: 'nei', note: '经典的 Not Enough Items，适用于 1.2.5 ~ 1.8 的 Forge', with: ['codechicken-core'],
        blocked: [/^1\.6(\.|$)/, '1.6.x 的 NEI 依赖 CodeChickenLib 1.6.4，其官方下载源已关闭（可自行把它拖入额外 Mod 后再装 NEI）'] },
    ],
  },
  {
    id: 'info', group: 'qol', name: '方块信息显示', desc: '准星对准时显示方块、生物与容器信息', default: true,
    options: [{ slug: 'jade' }, { slug: 'wthit' }, { slug: 'the-one-probe' }],
  },
  {
    id: 'hunger', group: 'qol', name: '饱食度显示', desc: '显示食物能恢复的饱食度与饱和度', default: true,
    options: [{ slug: 'appleskin' }],
  },
  {
    id: 'sort', group: 'qol', name: '背包整理', desc: '一键整理背包与箱子', default: true,
    options: [
      { slug: 'inventory-profiles-next', note: '还能自动补充损坏的工具' },
      { slug: 'mouse-wheelie', note: '轻量，鼠标中键整理' },
      { slug: 'inventory-sorter' },
    ],
  },
  {
    id: 'mousetweaks', group: 'qol', name: '鼠标快捷操作', desc: '拖动、滚轮快速转移物品', default: true,
    options: [{ slug: 'mouse-tweaks' }],
  },
  {
    id: 'zoom', group: 'qol', name: '视野缩放', desc: '按住按键像望远镜一样放大视野',
    options: [{ slug: 'zoomify' }, { slug: 'ok-zoomer' }, { slug: 'logical-zoom' }],
  },
  { id: 'controlling', group: 'qol', name: '按键设置搜索', desc: '在按键设置中搜索，快速找出冲突的按键', options: [{ slug: 'controlling' }] },
  { id: 'betterf3', group: 'qol', name: '更清晰的 F3 信息', desc: '分类、上色的调试信息界面', options: [{ slug: 'betterf3' }] },
  { id: 'chatheads', group: 'qol', name: '聊天头像', desc: '在聊天消息前显示玩家头像', options: [{ slug: 'chat-heads' }] },

  {
    id: 'shaders', group: 'visual', name: '光影支持', desc: '安装光影加载器，可以使用下方选择的光影包', default: true,
    options: [
      { slug: 'iris', loaders: ['fabric', 'quilt', 'neoforge'], with: ['sodium'] },
      { slug: 'oculus', loaders: ['forge'], with: ['embeddium'] },
    ],
  },
  {
    id: 'dynlights', group: 'visual', name: '动态光源', desc: '手持火把等发光物品时照亮周围',
    options: [{ slug: 'lambdynamiclights' }, { slug: 'sodium-dynamic-lights' }, { slug: 'dynamiclights-reforged' }],
  },
  { id: 'ctm', group: 'visual', name: '连接纹理', desc: '玻璃、书架等方块无缝连接（需要资源包支持）', options: [{ slug: 'continuity' }] },
  { id: 'leaves', group: 'visual', name: '飘落的树叶', desc: '树叶会缓缓飘落', options: [{ slug: 'falling-leaves' }] },

  {
    id: 'perf', group: 'perf', name: '性能优化', desc: '大幅提升帧率并降低内存占用', default: true,
    options: [
      { slug: 'sodium', loaders: ['fabric', 'quilt', 'neoforge'], label: '完整套件（Sodium + Lithium + FerriteCore 等）', with: ['lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix'] },
      { slug: 'embeddium', loaders: ['forge'], label: '完整套件（Embeddium + FerriteCore 等）', with: ['ferrite-core', 'entityculling', 'modernfix', 'immediatelyfast'] },
      { slug: 'sodium', id: 'sodium-lite', loaders: ['fabric', 'quilt', 'neoforge'], label: '仅渲染优化（Sodium）' },
      { slug: 'embeddium', id: 'embeddium-lite', loaders: ['forge'], label: '仅渲染优化（Embeddium）' },
    ],
  },
  { id: 'dynfps', group: 'perf', name: '后台降帧', desc: '窗口不在前台时自动降低帧率，省电省资源', default: true, options: [{ slug: 'dynamic-fps' }] },

  // 皮肤与模型
  {
    id: 'offlineskin', group: 'skin', name: '离线皮肤', desc: '离线账户也能显示皮肤：读取启动器里设置的皮肤，也能从 LittleSkin、正版等皮肤站加载其他玩家的皮肤。不装也行，启动器自带的本地皮肤服务能让你自己的皮肤生效',
    options: [
      { slug: 'customskinloader', note: '推荐，支持的版本和加载器最多' },
      { slug: 'offlineskins', note: '轻量，只有新版 Fabric' },
    ],
  },
  {
    id: 'playermodel', group: 'skin', name: '换模', desc: '把玩家换成自定义的模型（要另外准备模型文件）。和别人联机时，对方也装了同一个 Mod 才看得到',
    options: [
      { slug: 'custom-player-models', note: '在游戏里直接编辑模型，版本覆盖最广' },
      { slug: 'yes-steve-model', note: '国内流行，模型资源多' },
      { slug: 'figura', note: '用 Lua 脚本做模型和动画，最高到 1.21.4' },
    ],
  },
  { id: 'ears', group: 'skin', name: '耳朵和尾巴', desc: '在皮肤图片里画上耳朵、尾巴、翅膀等，游戏里就会显示出来（Ears）', options: [{ slug: 'ears' }] },
  { id: 'skins3d', group: 'skin', name: '3D 皮肤层', desc: '让皮肤外层变成立体效果', options: [{ slug: '3dskinlayers' }] },
];
const GROUPS = { qol: '实用功能（QoL）', visual: '画面与光影', skin: '皮肤与模型', perf: '性能优化' };

const optionId = (o) => o.id || o.slug;
const loaderOk = (o, loader) => !o.loaders || o.loaders.includes(loader === 'quilt' ? 'quilt' : loader) || (loader === 'quilt' && o.loaders.includes('fabric'));

const supports = (p, mc, loader) => {
  const ll = modrinth.loaderList(loader) || [];
  return (p.gameVersions || []).includes(mc) && (p.loaders || []).some((l) => ll.includes(l));
};

/** 某个版本 + 加载器下每类功能可选的 Mod */
async function catalog(mc, loader) {
  const slugs = [...new Set(FEATURES.flatMap((f) => f.options.flatMap((o) => [o.slug, ...(o.with || [])])))];
  const projs = await modrinth.projects(slugs);
  const bySlug = new Map(projs.map((p) => [p.slug, p]));
  const features = FEATURES.map((f) => {
    const options = f.options.filter((o) => loaderOk(o, loader)).map((o) => {
      const p = bySlug.get(o.slug);
      const blocked = o.blocked && o.blocked[0].test(mc);
      const ok = !!(p && supports(p, mc, loader)) && !blocked;
      return {
        id: optionId(o), slug: o.slug, title: o.label || (p ? p.title : o.slug), icon: p ? p.icon : null,
        downloads: p ? p.downloads : 0, note: blocked ? o.blocked[1] : o.note || '', available: ok,
        with: (o.with || []).map((s) => (bySlug.get(s) || {}).title || s),
      };
    });
    const firstOk = options.find((o) => o.available);
    return {
      id: f.id, group: f.group, name: f.name, desc: f.desc, default: !!f.default,
      available: !!firstOk, options, recommended: firstOk ? firstOk.id : null,
    };
  });
  return { mc, loader, groups: GROUPS, features };
}

/** 热门光影包 */
async function shaders(mc) {
  const r = await modrinth.search({ type: 'shader', sort: 'downloads', limit: 10 });
  return r.hits.map((p) => ({ id: p.id, slug: p.slug, title: p.title, description: p.description, icon: p.icon, downloads: p.downloads, gallery: p.gallery, categories: p.categories, supportsVersion: !mc || (p.gameVersions || []).includes(mc) }));
}

/** 选择首选的加载器：Fabric → NeoForge → Forge → Legacy Fabric（旧版本） */
async function bestLoader(mc) {
  for (const type of ['fabric', 'neoforge', 'forge', 'legacyfabric']) {
    try {
      const list = await loaders.list(type, mc);
      if (list.length) return { type, versions: list };
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

/**
 * @param {{mc, name, loader?, choices: {featureId: optionId}, extraProjects?: string[], localFiles?: string[], shaderIds?: string[]}} opts
 */
async function install({ mc, name, loader, choices = {}, extraProjects = [], localFiles = [], shaderIds = [] }, task) {
  name = (name || `${mc} 纯净版+`).trim();
  versions.validateName(name);
  let lt = loader && loader.type;
  let lv = loader && loader.version ? loader : null;
  if (!lt) {
    const b = await bestLoader(mc);
    if (!b) throw new Error(`Minecraft ${mc} 暂时没有可用的 Mod 加载器`);
    lt = b.type;
  }
  if (!lv) {
    const list = await loaders.list(lt, mc);
    const pick = list.find((x) => x.recommended) || list.find((x) => x.stable) || list[0];
    if (!pick) throw new Error(`${lt} 不支持 Minecraft ${mc}`);
    lv = { type: lt, version: pick.version, full: pick.full };
  }
  await loaders.install({ mc, name, loader: { type: lt, version: lv.version, full: lv.full } }, task);

  // 根据每类功能选中的 Mod 组装清单
  const slugs = [];
  const chosenNames = [];
  for (const f of FEATURES) {
    const sel = choices[f.id];
    if (!sel) continue;
    const o = f.options.find((x) => optionId(x) === sel && loaderOk(x, lt));
    if (!o || (o.blocked && o.blocked[0].test(mc))) continue;
    slugs.push(o.slug, ...(o.with || []));
    chosenNames.push(f.name);
  }
  if (lt === 'fabric' || lt === 'quilt') slugs.push('modmenu');
  if (lt === 'legacyfabric') slugs.push('legacy-fabric-api');
  const projs = await modrinth.projects([...new Set(slugs)]);
  const items = projs.filter((p) => supports(p, mc, lt)).map((p) => ({ projectId: p.id, slug: p.slug, title: p.title, selected: true, style: 'vanillaplus', source: 'pick' }));
  for (const id of extraProjects) {
    if (!items.some((i) => i.projectId === id)) items.push({ projectId: id, selected: true, style: 'custom', source: 'custom' });
  }
  const description = chosenNames.join(' · ');

  task.update({ detail: '解析 Mod 与前置…', progress: -1 });
  const resolved = await planner.resolve({ mc, loader: lt, items });
  const r = await planner.install({
    plan: { id: null, name: null, mc, loader: lt, profileType: 'vanillaplus', description, items },
    resolved,
    target: { mode: 'existing', versionId: name },
  }, task);

  const info = await versions.versionInfo(name);
  const gameDir = versions.gameDirFor(name, info);

  // 玩家自己的 .jar
  let copied = 0;
  if (localFiles.length) {
    const modsDir = path.join(gameDir, 'mods');
    await fsp.mkdir(modsDir, { recursive: true });
    for (const f of localFiles) {
      try {
        if (!/\.(jar|zip)$/i.test(f)) continue;
        await fsp.copyFile(f, path.join(modsDir, path.basename(f)));
        copied++;
      } catch (e) { console.warn('[vanilla+] 复制本地 Mod 失败', f, e.message); }
    }
    if (copied) {
      const more = await planner.fillMissingDeps(name, task);
      r.autoDeps = [...(r.autoDeps || []), ...more.autoDeps];
      r.unresolved = [...new Set([...(r.unresolved || []), ...more.unresolved])];
    }
  }

  // 光影包
  const shaderFiles = [];
  if (shaderIds.length) {
    const dir = path.join(gameDir, 'shaderpacks');
    await fsp.mkdir(dir, { recursive: true });
    for (const id of shaderIds.slice(0, 6)) {
      try {
        let v = modrinth.bestVersion(await modrinth.projectVersions(id, { type: 'shader', gameVersion: mc }));
        if (!v) v = modrinth.bestVersion(await modrinth.projectVersions(id, { type: 'shader' }));
        const f = v && (v.files.find((x) => x.primary) || v.files[0]);
        if (!f) continue;
        task.update({ detail: `下载光影包 ${nm(f.filename)}`, progress: -1 });
        await downloadFile({ urls: [f.url], path: path.join(dir, f.filename), sha1: f.sha1, size: f.size }, { task, label: f.filename });
        shaderFiles.push(f.filename);
      } catch (e) {
        if (e.cancelled) throw e;
        console.warn('[vanilla+] 光影下载失败', id, e.message);
      }
    }
    // 默认启用第一个光影包
    if (shaderFiles.length && choices.shaders) {
      const cfgDir = path.join(gameDir, 'config');
      await fsp.mkdir(cfgDir, { recursive: true });
      const file = lt === 'forge' ? 'oculus.properties' : 'iris.properties';
      await fsp.writeFile(path.join(cfgDir, file), `enableShaders=true\nshaderPack=${shaderFiles[0]}\n`, 'utf8');
    }
  }
  await profiles.writeMeta(name, { type: 'vanillaplus', description, vanillaPlus: { choices, extraProjects, shaders: shaderFiles, localFiles: localFiles.map((f) => path.basename(f)) } });
  await profiles.snapshot(name).catch(() => {});
  return { ...r, loader: lt, shaders: shaderFiles, copied };
}

module.exports = { FEATURES, GROUPS, catalog, shaders, install, bestLoader };
