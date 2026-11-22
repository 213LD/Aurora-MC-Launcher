'use strict';
/* Modrinth / CurseForge 资源标签翻译（1.4.8）
 * 只改显示：搜索、筛选仍用原始 id。中文界面查表，英文界面或表里没有的照原文显示 */
(function () {
  const ZH = {
    // Modrinth：Mod / 整合包分类
    adventure: '冒险', cursed: '整活', decoration: '装饰', economy: '经济', equipment: '装备',
    food: '食物', 'game-mechanics': '游戏机制', library: '前置库', magic: '魔法', management: '管理',
    minigame: '小游戏', mobs: '生物', optimization: '优化', social: '社交', storage: '存储',
    technology: '科技', transportation: '交通', utility: '实用', worldgen: '世界生成',
    challenging: '高难度', combat: '战斗', 'kitchen-sink': '大杂烩', lightweight: '轻量',
    multiplayer: '多人', quests: '任务',
    // 加载器 / 运行端
    fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', datapack: '数据包',
    minecraft: '原版', bukkit: 'Bukkit', paper: 'Paper', spigot: 'Spigot', iris: 'Iris', optifine: 'OptiFine',
    canvas: 'Canvas', vanilla: '原版着色器',
    // 资源包
    '8x-': '8x 及以下', '16x': '16x', '32x': '32x', '48x': '48x', '64x': '64x', '128x': '128x',
    '256x': '256x', '512x+': '512x 及以上',
    audio: '音效', blocks: '方块', core: '核心', entities: '实体', environment: '环境', fonts: '字体',
    gui: '界面', items: '物品', locale: '语言', models: '模型', 'combat-tweaks': '战斗调整',
    modded: 'Mod 适配', realistic: '写实', simplistic: '简约', themed: '主题', tweaks: '微调',
    'vanilla-like': '类原版',
    // 光影
    atmosphere: '大气', bloom: '泛光', 'colored-lighting': '彩色光照', foliage: '植被摆动',
    'path-tracing': '路径追踪', pbr: 'PBR 材质', reflections: '反射', shadows: '阴影',
    cartoon: '卡通', fantasy: '幻想', 'semi-realistic': '半写实',
    potato: '土豆配置', low: '低配', medium: '中配', high: '高配', screenshot: '截图用',
  };
  // CurseForge 给的是英文分类名（不是 id），按小写名字查
  const ZH_CF = {
    'adventure and rpg': '冒险与 RPG', 'api and library': '前置库', 'armor, tools, and weapons': '盔甲、工具与武器',
    cosmetic: '装饰外观', 'education': '教育', 'food': '食物', 'magic': '魔法', 'map and information': '地图与信息',
    'miscellaneous': '杂项', 'performance': '性能优化', 'player transport': '交通', 'redstone': '红石',
    'server utility': '服务器工具', 'storage': '存储', 'technology': '科技', 'utility & qol': '实用与便捷',
    'world gen': '世界生成', 'biomes': '生物群系', 'dimensions': '维度', 'mobs': '生物', 'structures': '结构',
    'ores and resources': '矿物与资源', 'energy': '能源', 'automation': '自动化', 'processing': '加工',
    'genetics': '基因', 'farming': '农业', 'energy, fluid, and item transport': '能量、流体与物品运输',
    'addons': '附属', 'thermal expansion': '热力膨胀', 'tinker\'s construct': '匠魂',
    'industrial craft': '工业', 'applied energistics 2': '应用能源 2', 'create': '机械动力', 'kubejs': 'KubeJS',
    'crafttweaker': 'CraftTweaker', 'skyblock': '空岛', 'exploration': '探索', 'quests': '任务',
    'hardcore': '硬核', 'combat / pvp': '战斗 / PVP', 'multiplayer': '多人', 'small / light': '小型 / 轻量',
    'extra large': '超大型', 'tech': '科技', 'sci-fi': '科幻', 'mini game': '小游戏', 'fabric': 'Fabric',
    'vanilla+': '原版增强', 'medieval': '中世纪', 'modern': '现代', 'animated': '动态', 'photo realistic': '写实',
    'traditional': '传统', 'steampunk': '蒸汽朋克', 'font packs': '字体', 'data packs': '数据包',
    'mod support': 'Mod 适配', 'misc': '杂项', 'shaders': '光影',
  };

  // 整条查不到时按单词翻：「Tech / Industrial」→「科技 / 工业」。有一个词不认识就整条显示原文，不出现半中半英
  const WORDS = {
    rpg: 'RPG', api: 'API', pvp: 'PVP', pve: 'PVE', qol: '便捷', hud: 'HUD', ui: '界面', mod: 'Mod', mods: 'Mod',
    armor: '盔甲', tools: '工具', tool: '工具', weapons: '武器', weapon: '武器', map: '地图', maps: '地图',
    information: '信息', info: '信息', world: '世界', gen: '生成', generation: '生成', biome: '生物群系',
    structure: '结构', dungeons: '地牢', dungeon: '地牢', ore: '矿物', ores: '矿物', resource: '资源',
    resources: '资源', fluid: '流体', fluids: '流体', item: '物品', transport: '运输', industrial: '工业',
    industry: '工业', farming: '农业', agriculture: '农业', mob: '生物', creatures: '生物', animals: '动物',
    server: '服务器', client: '客户端', player: '玩家', players: '玩家', building: '建筑', build: '建筑',
    furniture: '家具', vehicles: '载具', vehicle: '载具', survival: '生存', hardcore: '硬核',
    exploration: '探索', quest: '任务', singleplayer: '单人', mini: '小', game: '游戏', games: '游戏',
    small: '小型', light: '轻量', large: '大型', modern: '现代', medieval: '中世纪', 'sci-fi': '科幻',
    simple: '简约', misc: '杂项', miscellaneous: '杂项', addon: '附属', addons: '附属', integration: '联动',
    compatibility: '兼容', compat: '兼容', support: '适配', shader: '光影', shaders: '光影', pack: '包',
    packs: '包', texture: '材质', textures: '材质', data: '数据', font: '字体', sound: '音效', sounds: '音效',
    music: '音乐', interface: '界面', chat: '聊天', education: '教育', automation: '自动化',
    processing: '加工', energy: '能源', power: '能源', redstone: '红石', dimensions: '维度', dimension: '维度',
    structures: '结构', biomes: '生物群系', performance: '性能', cosmetic: '外观', cosmetics: '外观',
    tech: '科技', enchantments: '附魔', enchantment: '附魔', potions: '药水', potion: '药水',
    trees: '树木', plants: '植物', nature: '自然', weather: '天气', cave: '洞穴', caves: '洞穴',
    ocean: '海洋', nether: '下界', end: '末地', village: '村庄', villages: '村庄', villagers: '村民',
    bosses: 'Boss', boss: 'Boss', skyblock: '空岛', puzzle: '解谜', horror: '恐怖', story: '剧情',
    city: '城市', realism: '写实', recipes: '配方', recipe: '配方', crafting: '合成', inventory: '物品栏',
    minimap: '小地图', jei: 'JEI', config: '配置', configuration: '配置', twitch: 'Twitch', integrated: '整合',
    // 通用题材 / 游戏类型
    casual: '休闲', relaxing: '休闲', chill: '休闲', cozy: '温馨', creative: '创造', sandbox: '沙盒',
    roguelike: '类 Rogue', roguelite: '类 Rogue', rogue: 'Rogue', role: '角色', playing: '扮演', 'role-playing': '角色扮演',
    roleplay: '角色扮演', strategy: '策略', simulation: '模拟', action: '动作',
    mystery: '悬疑', apocalypse: '末日', 'post-apocalyptic': '末日', zombies: '僵尸', pirates: '海盗',
    space: '太空', anime: '动漫', kids: '儿童', family: '家庭', classic: '经典', retro: '复古', competitive: '竞技',
    cooperative: '合作', coop: '合作', 'co-op': '合作', parkour: '跑酷', pixel: '像素',
    // 难度
    difficulty: '难度', difficult: '困难', easy: '简单', normal: '普通', medium: '中等', hard: '困难', harder: '更难',
    expert: '专家', master: '大师', insane: '疯狂', extreme: '极限', nightmare: '噩梦', impossible: '不可能',
    beginner: '新手', beginners: '新手', friendly: '友好', newbie: '新手', noob: '新手', veteran: '老手', pro: '高手',
    challenge: '挑战', challenges: '挑战', mode: '模式', modes: '模式',
    // 地图类型 / 特殊玩法
    official: '官方', narrative: '剧情', 'story-driven': '剧情向', rhythm: '节奏', escape: '逃脱', maze: '迷宫', labyrinth: '迷宫',
    dropper: '坠落', trivia: '问答', quiz: '问答', arena: '竞技场', race: '竞速', racing: '竞速', speedrun: '速通',
    speedrunning: '速通', bedwars: '起床战争', skywars: '空岛战争', spleef: '掘一死战', manhunt: '猎人游戏',
    oneblock: '单方块', ctm: 'CTM', ctf: '夺旗', cinematic: '电影化', showcase: '展示', recreation: '复刻', replica: '复刻',
    remake: '重制', creation: '创作', creations: '创作', terrain: '地形', custom: '自定义', command: '命令', commands: '命令',
    thriller: '惊悚', scary: '恐怖', detective: '侦探', investigation: '侦探', mythology: '神话', western: '西部',
    survivalist: '生存', hub: '大厅', lobby: '大厅', spawn: '出生点', minigames: '小游戏', art: '艺术', statue: '雕像',
    statues: '雕像', castle: '城堡', castles: '城堡', island: '岛屿', islands: '岛屿', jump: '跳跃', jumping: '跳跃',
    run: '跑酷', runner: '跑酷', defense: '防守', defence: '防守', tower: '塔', wave: '波次', waves: '波次',
    // 排序 / 推荐类标签
    popular: '热门', trending: '流行', hot: '热门', featured: '置顶', pinned: '置顶', recommended: '推荐',
    most: '最', new: '最新', newest: '最新', updated: '最近更新', top: '热门', rated: '评分', downloads: '下载量',
  };
  // 逐词拼不通顺的固定说法
  const PHRASES = {
    'top rated': '高评分', 'most popular': '最热门', 'most downloaded': '下载最多', 'recently updated': '最近更新', "editor's choice": '编辑推荐', 'staff picks': '编辑推荐',
    'map based': '地图类', 'map-based': '地图类', 'official pack': '官方包', 'official modpack': '官方整合包',
    'auto scroll': '自动', 'auto-scroll': '自动', autoscroll: '自动', 'auto scrolling': '自动', 'story driven': '剧情向', 'story based': '剧情向', 'story-based': '剧情向',
    'escape room': '密室逃脱', 'find the button': '找按钮', 'complete the monument': '收集纪念碑', 'capture the flag': '夺旗',
    'hide and seek': '躲猫猫', 'hide & seek': '躲猫猫', 'bed wars': '起床战争', 'sky wars': '空岛战争', 'build battle': '建筑大赛',
    'hunger games': '饥饿游戏', 'survival games': '饥饿游戏', 'one block': '单方块', 'tower defense': '塔防', 'tower defence': '塔防',
    'king of the hill': '山丘之王', 'murder mystery': '谋杀之谜', 'tnt run': 'TNT 跑酷', 'boss rush': 'Boss 连战', 'boss fight': 'Boss 战',
    'pixel art': '像素画', 'note block': '音符盒', 'command block': '命令方块', 'command blocks': '命令方块', 'speed run': '速通',
    'expert mode': '专家模式', 'hard mode': '困难模式', 'easy mode': '简单模式', 'wave based': '波次', 'wave-based': '波次',
  };
  // 带专有名词的固定格式：名字原样保留，后半截翻译（「Cobblemon Official Pack」→「Cobblemon 官方包」）
  const PATTERNS = [
    [/^(.+?)\s+official\s+mod\s*packs?$/i, '$1 官方整合包'],
    [/^(.+?)\s+official\s+packs?$/i, '$1 官方包'],
    [/^official\s+(.+?)\s+mod\s*packs?$/i, '$1 官方整合包'],
    [/^official\s+(.+?)\s+packs?$/i, '$1 官方包'],
    [/^(.+?)\s+official$/i, '$1 官方'],
  ];
  // 连接符：and / & → 与，逗号 → 、，斜杠 → 「 / 」，其他（空格、连字符、下划线）直接拼
  const JOIN = { and: '与', '&': '与', ',': '、', '/': ' / ', '+': ' + ', '|': ' / ' };

  function word(w) {
    const k = w.toLowerCase();
    if (JOIN[k]) return { join: JOIN[k] };
    if (/^\d+x?$/.test(k)) return { text: w };
    const hit = WORDS[k] || ZH[k] || ZH_CF[k] || (k.endsWith('s') && (WORDS[k.slice(0, -1)] || ZH[k.slice(0, -1)]));
    return hit ? { text: hit } : null;
  }

  function splitTranslate(raw) {
    const parts = raw.split(/([,/&+|]|\s+|[-_]+)/).filter((p) => p && !/^\s+$|^[-_]+$/.test(p));
    if (!parts.length) return null;
    let out = '';
    let prevText = false;
    for (const p of parts) {
      const r = word(p);
      if (!r) return null;
      if (r.join) { out += r.join; prevText = false; continue; }
      // 英文词和中文词之间留个空格，和词库里「Mod 适配」一样
      if (prevText && (/[A-Za-z0-9]$/.test(out) || /^[A-Za-z0-9]/.test(r.text))) out += ' ';
      out += r.text;
      prevText = true;
    }
    return out.trim();
  }

  // 记下没翻出来的标签（只在本机 localStorage），调试菜单里能看，以后照着补词库
  const MISS_KEY = 'aurora.tagMisses';
  let misses = null;
  let saveTimer = null;
  function loadMisses() {
    if (misses) return misses;
    try { misses = JSON.parse(localStorage.getItem(MISS_KEY) || '{}') || {}; } catch { misses = {}; }
    return misses;
  }
  function recordMiss(raw) {
    const m = loadMisses();
    m[raw] = (m[raw] || 0) + 1;
    const keys = Object.keys(m);
    if (keys.length > 300) for (const k of keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - 300)) delete m[k];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(MISS_KEY, JSON.stringify(m)); } catch { /* ignore */ } }, 1000);
  }

  const cache = new Map();
  function tagLabel(tag) {
    const raw = String(tag == null ? '' : tag);
    // 只有简中界面翻标签；英文、繁中都照原文显示
    if (window.I18N.getLang() !== 'zh-CN') return raw;
    // CurseForge 光影的分类「Vanilla」是类原版风格；Modrinth 的小写 vanilla 是原版着色器（1.5.9）
    if (raw === 'Vanilla') return '类原版';
    const k = raw.toLowerCase();
    const direct = ZH[k] || ZH_CF[k] || PHRASES[k];
    if (direct) return direct;
    if (cache.has(raw)) return cache.get(raw);
    const pat = PATTERNS.find(([re]) => re.test(raw.trim()));
    if (pat) { const out = raw.trim().replace(pat[0], pat[1]); cache.set(raw, out); return out; }
    const split = splitTranslate(raw);
    if (!split) recordMiss(raw);
    cache.set(raw, split || raw);
    return split || raw;
  }

  A.tagLabel = tagLabel;
  A.tagMisses = {
    list: () => Object.entries(loadMisses()).sort((a, b) => b[1] - a[1]),
    clear: () => { misses = {}; cache.clear(); try { localStorage.removeItem(MISS_KEY); } catch { /* ignore */ } },
  };
})();
