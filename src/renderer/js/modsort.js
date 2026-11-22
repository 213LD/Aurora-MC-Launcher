'use strict';
/**
 * Mod 管理页的排序：名称 A–Z / Z–A、最新安装、按类型分组。
 * 类型判断：被其他已装 Mod 依赖的、或在前置库名单里的算「前置库」；其余按常见 Mod 的 id 名单归类，认不出的算「其他」。
 */
(function () {
  const { t } = A;

  const SORTS = ['name', 'nameDesc', 'added', 'type'];
  const TYPES = ['library', 'performance', 'qol', 'utility', 'misc'];

  // 常见 Mod 的 id（Fabric / Forge 的 mod id，统一小写、去掉 - 和 _ 再比较）
  const KNOWN = {
    library: ['fabricapi', 'fabric', 'architectury', 'clothconfig', 'clothconfig2', 'geckolib', 'geckolib3', 'owo', 'owolib', 'fabriclanguagekotlin', 'kotlinforforge',
      'forgeconfigapiport', 'balm', 'puzzleslib', 'bookshelf', 'moonlight', 'yungsapi', 'collective', 'resourcefullib', 'creativecore', 'curios', 'trinkets', 'citadel',
      'terrablender', 'playeranimator', 'malilib', 'cardinalcomponents', 'cca', 'libz', 'midnightlib', 'yacl', 'yetanotherconfiglib', 'placeholderapi', 'fzzyconfig',
      'supermartijn642corelib', 'supermartijn642configlib', 'framework', 'lithostitched', 'konkrete', 'fancymenu', 'iceberg', 'prism', 'searchables', 'sodiumoptionsapi',
      'indium', 'forgifiedfabricapi', 'connectormod', 'mixinextras', 'jamlib', 'coroutil', 'glitchcore', 'zeta', 'autoreglib', 'blueprint', 'cristellib', 'satin', 'veil', 'lodestone'],
    performance: ['sodium', 'iris', 'oculus', 'embeddium', 'rubidium', 'lithium', 'canary', 'radium', 'phosphor', 'starlight', 'ferritecore', 'modernfix', 'entityculling',
      'immediatelyfast', 'krypton', 'c2me', 'memoryleakfix', 'lazydfu', 'smoothboot', 'dynamicfps', 'enhancedblockentities', 'moreculling', 'badoptimizations', 'noisium',
      'fpsreducer', 'clumps', 'betterfpsdist', 'ksyxis', 'sodiumextra', 'reesessodiumoptions', 'nvidium', 'exordium', 'cullleaves', 'cull_less_leaves', 'debugify',
      'saturn', 'spark', 'fastload', 'letmedespawn', 'servercore', 'vmp', 'threadtweak', 'alternatecurrent', 'scalablelux', 'distanthorizons', 'bobby', 'voxy', 'optifine'],
    qol: ['jei', 'rei', 'roughlyenoughitems', 'emi', 'jade', 'wthit', 'hwyla', 'appleskin', 'journeymap', 'xaerominimap', 'xaeroworldmap', 'mousetweaks',
      'inventoryprofilesnext', 'itemscroller', 'controlling', 'betterf3', 'chatheads', 'shulkerboxtooltip', 'zoomify', 'okzoomer', 'lambdynlights', 'dynamiclights',
      'betterthirdperson', 'freecam', 'continuity', 'capes', 'skinlayers3d', 'notenoughanimations', 'eatinganimation', 'justenoughresources', 'torohealth', 'durabilitytooltip',
      'betterpingdisplay', 'smoothscrollingeverywhere', 'cleanview', 'betterbeds', 'carryon', 'inventorysorter', 'invmove', 'mousewheelie',
      'betteradvancements', 'jeresources', 'travelersbackpack', 'sophisticatedbackpacks', 'waystones', 'fallingtree', 'veinminer', 'ftbultimine'],
    utility: ['modmenu', 'configured', 'catalogue', 'litematica', 'minihud', 'tweakeroo', 'worldedit', 'replaymod', 'voicechat', 'simplevoicechat', 'axiom', 'worldeditcui',
      'ftbchunks', 'ftbteams', 'ftbessentials', 'essentialcommands', 'luckperms', 'chunky', 'servux', 'syncmatica', 'screenshotviewer', 'betterconfig',
      'nochatreports', 'essential', 'feathercore', 'authme', 'cameraoverhaul', 'replay', 'flashback', 'worldtools', 'simplebackups', 'ftbbackups2', 'mcbackup'],
  };
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
  const LOOKUP = new Map();
  for (const type of TYPES) for (const id of KNOWN[type] || []) if (!LOOKUP.has(norm(id))) LOOKUP.set(norm(id), type);
  // 加载器和游戏本身不算前置
  const BASE_DEPS = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'forge', 'neoforge', 'quiltloader', 'quilt_loader', 'quiltbase', 'fml', 'javafml'].map(norm));

  const idsOf = (m) => [m.id, ...(m.ids || []), ...(m.provides || [])].filter(Boolean).map(norm);

  /** 已装 Mod 互相依赖的 id 集合：被依赖的就是前置 */
  function neededIds(mods) {
    const set = new Set();
    for (const m of mods) {
      const own = new Set(idsOf(m));
      for (const sec of Object.values(m.byLoader || {})) {
        for (const dep of Object.keys(sec.deps || {})) {
          const d = norm(dep);
          if (!BASE_DEPS.has(d) && !own.has(d)) set.add(d);
        }
      }
    }
    return set;
  }

  function typeOf(m, needed) {
    const ids = idsOf(m);
    if (!ids.length) ids.push(norm((m.name || m.file || '').replace(/\.(jar|zip)(\.disabled)?$/i, '')));
    if (ids.some((id) => needed.has(id))) return 'library';
    for (const id of ids) if (LOOKUP.has(id)) return LOOKUP.get(id);
    return 'misc';
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');

  /**
   * 排序并（按类型时）分组。返回 [{ type, mods }]；不分组时只有一组，type 为 null
   */
  function apply(mods, sort) {
    const list = [...mods];
    if (sort === 'nameDesc') return [{ type: null, mods: list.sort((a, b) => byName(b, a)) }];
    if (sort === 'added') return [{ type: null, mods: list.sort((a, b) => (b.added || b.mtime || 0) - (a.added || a.mtime || 0) || byName(a, b)) }];
    if (sort === 'type') {
      const needed = neededIds(mods);
      const groups = new Map(TYPES.map((k) => [k, []]));
      for (const m of list) groups.get(typeOf(m, needed)).push(m);
      return TYPES.map((type) => ({ type, mods: groups.get(type).sort(byName) })).filter((g) => g.mods.length);
    }
    return [{ type: null, mods: list.sort(byName) }];
  }

  const options = () => SORTS.map((value) => ({ value, label: t(`modSort.${value}`) }));
  const typeLabel = (type) => t(`modSort.type.${type}`);

  A.modSort = { SORTS, TYPES, apply, options, typeLabel, typeOf, neededIds };
})();
