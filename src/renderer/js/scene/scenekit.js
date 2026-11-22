'use strict';
/**
 * 主页动态背景共用的东西（2.0.0-pre9 从 scene.js 拆出来）：工具、天空、材质、精灵、场景表。别的 scene*.js 从 A.sceneKit 取
 */
(function () {
  // ───────────────────────── 工具 ─────────────────────────
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** 与位置绑定的确定性噪声：地形可以在局部修改后原样重绘 */
  function hash(x, y, s = 0) {
    let v = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const pal = (...a) => a.map(hex);
  const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];

  // ───────────────────────── 天空 ─────────────────────────
  const SKIES = {
    day: { top: '#3d7fe0', mid: '#79b1f2', hor: '#c4e2ff', sun: '#fff7d1', glow: '#fff2b0', far: '#8fb3dc', mid2: '#6f97c4', light: 1, tint: '#ffffff', cloud: '#ffffff', stars: 0 },
    sunset: { top: '#27306b', mid: '#b5577a', hor: '#ffb25c', sun: '#ffd9a0', glow: '#ff9f5a', far: '#8a5a86', mid2: '#5d3e6c', light: 0.78, tint: '#ffcfa8', cloud: '#ffd2c0', stars: 0.15 },
    dawn: { top: '#38508f', mid: '#c48aa8', hor: '#ffd3ae', sun: '#fff0d8', glow: '#ffc9a0', far: '#9a8fb3', mid2: '#76709a', light: 0.85, tint: '#ffe2cf', cloud: '#ffe9e0', stars: 0.1 },
    night: { top: '#03050f', mid: '#0b1430', hor: '#1c2a52', sun: '#e9eef8', glow: '#9fb4e6', far: '#1b2645', mid2: '#131c36', light: 0.42, tint: '#8fa6ff', cloud: '#5a6990', stars: 1 },
    nether: { top: '#1c0605', mid: '#3a0d09', hor: '#6b1d10', sun: null, glow: '#ff6a2a', far: '#4a120c', mid2: '#5c170e', light: 0.9, tint: '#ffb08a', cloud: null, stars: 0 },
    end: { top: '#07040c', mid: '#120a1c', hor: '#21142e', sun: null, glow: '#b07ad8', far: '#2a1d36', mid2: '#1d1426', light: 0.8, tint: '#d8c8ff', cloud: null, stars: 0.7 },
  };

  // 设置里的「时段」只认这四个；auto、手改坏了的值（数字、空的、拼错的）都按现在的时间算。
  // 以前什么值都原样返回，config.json 里 time 被改成数字时天空颜色查不到，主页背景建到一半出错、什么都不画
  const PERIODS = ['dawn', 'day', 'sunset', 'night'];
  function periodFor(mode) {
    if (PERIODS.includes(mode)) return mode;
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if (h >= 5 && h < 7) return 'dawn';
    if (h >= 7 && h < 17) return 'day';
    if (h >= 17 && h < 19.5) return 'sunset';
    return 'night';
  }

  // ───────────────────────── 方块材质 ─────────────────────────
  const M = {
    grass: pal('#60a83a', '#6cb640', '#56982f'),
    grassBright: pal('#6fbf3f', '#7ccb48', '#65b23a'),
    dirt: pal('#86603f', '#79553a', '#966c4b'),
    stone: pal('#7d7d7d', '#707070', '#8a8a8a'),
    sand: pal('#dbcfa3', '#d0c396', '#e4d9b0'),
    sandstone: pal('#cfbf8a', '#c4b37c', '#d8c996'),
    snow: pal('#f4f8fb', '#e6eef5', '#ffffff'),
    mycelium: pal('#6f6378', '#7b6e84', '#62586b'),
    netherrack: pal('#6e2a26', '#7d302b', '#5e2320', '#8a3a33'),
    soul: pal('#4f3b2e', '#5a4536', '#45332a'),
    endstone: pal('#dbdba0', '#cfcf92', '#e6e6b0'),
    obsidian: pal('#1a1028', '#140c20', '#22163a'),
    log: pal('#68502f', '#5c462a', '#745a35'),
    birch: pal('#d8d7d2', '#c8c7c2', '#d8d7d2'),
    spruce: pal('#3f2e1c', '#36281a', '#47331f'),
    leaves: pal('#3e7a28', '#367022', '#468830', '#2e6220'),
    birchLeaves: pal('#6ea03c', '#609434', '#7aad46'),
    spruceLeaves: pal('#2c5b3a', '#264f33', '#336842'),
    cherry: pal('#f3b4d0', '#eaa2c3', '#f8c6dc', '#e48fb6'),
    cherryLog: pal('#4a2a32', '#3f232b', '#55303a'),
    cactus: pal('#4f8f2f', '#457f29', '#5a9f36'),
    redCap: pal('#c0302a', '#d23a32', '#a8261f'),
    brownCap: pal('#9a6f4e', '#8a6244', '#a67a57'),
    stem: pal('#e8e2d0', '#ddd6c2'),
    crimson: pal('#8c1f2a', '#7a1a24', '#a12632'),
    wart: pal('#a3171c', '#8e1418', '#b81d22'),
    netherbrick: pal('#2c1416', '#341a1c', '#25100f'),
    planks: pal('#a8854f', '#9c7a47', '#b38f58'),
    darkPlanks: pal('#6b4a2a', '#5f4125', '#77532f'),
    cobble: pal('#7a7a7a', '#8a8a8a', '#666666', '#959595'),
    glowstone: pal('#f7d07a', '#e8b85c', '#ffe199'),
    chorus: pal('#8a5ca6', '#7a4f94', '#9a6ab6'),
    chorusFlower: pal('#c9a6e0', '#d9b8ee'),
    ice: pal('#9cc4ec', '#a8cdf2'),
    // 黑森林（第三阶段）
    grassDark: pal('#4f8a30', '#589436', '#46802a'),
    darkLog: pal('#3e2d1a', '#352616', '#47331e'),
    darkLeaves: pal('#2f5a1c', '#284e18', '#356422', '#22461a'),
    // 下界群系
    warped: pal('#1f6a64', '#195a55', '#247870'),
    warpedWart: pal('#147a7a', '#106868', '#1a8c8c'),
    shroomlight: pal('#f2a050', '#f8b868', '#e89040'),
  };

  // ───────────────────────── 生物像素图 ─────────────────────────
  // 朝右；"." 透明；大写字母可在 emissive 中声明为夜间自发光
  const H = (rows, colors, opts = {}) => ({ rows, w: rows[0].length, h: rows.length, colors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, hex(v)])), ...opts });
  // 玩家（1.7.0 重画）：4 × 10，比怪物大一圈。头 4 格宽，身子、腿 2 格宽放在头的正中间——
  // 以前身子贴着头的后半边，看起来像驼背的小人。脸朝右：后脑勺和头顶是头发，前面是眼白 + 眼珠、嘴；
  // 手臂叠在身子前半边。walk 是走路时两腿前后分开的那一帧，swing 是挥手（砍树、打架）时手臂伸到前面
  const player = (c, back = 'HSSN', shoulder = '.TT.') => {
    const head = ['HHHH', 'HHSS', 'HSWE', back];
    const legs = ['.PP.', '.Pp.', '.BB.'];
    return H([...head, shoulder, '.tA.', '.tA.', ...legs], c, {
      walk: [...head, shoulder, '.tA.', '.tA.', '.Pp.', 'P..p', 'B..b'],
      swing: [...head, shoulder.slice(0, 3) + 'A', '.tt.', '.tt.', ...legs],
    });
  };
  const SPRITES = {
    pig: H(['..ppe.', 'pppppS', 'pppppp', '.l..l.'], { p: '#f2a7a4', S: '#d4807f', e: '#2a1a1a', l: '#d48a87' }),
    cow: H(['.bwwbbh', 'bwwbbwe', 'wbbwwbn', 'bwwbbw.', '.l.l.l.'], { b: '#3b2a20', w: '#e8e4dc', h: '#3b2a20', e: '#111111', n: '#d9a0a0', l: '#2a1e18' }),
    mooshroom: H(['.r.R...', '.bwwbbh', 'bwwbbwe', 'wbbwwbn', '.l.l.l.'], { r: '#d23a32', R: '#e8e2d0', b: '#a82a24', w: '#d8d0c4', h: '#a82a24', e: '#111111', n: '#e0a0a0', l: '#5a2420' }),
    sheep: H(['.wwwww.', 'wwwwwwf', 'wwwwwfe', 'wwwwww.', '.l..l..'], { w: '#e8e8e8', f: '#c8b49a', e: '#222222', l: '#c8b49a' }),
    chicken: H(['..ww', '..we', 'wwwy', 'www.', '.l..'], { w: '#f2f2f2', e: '#111111', y: '#e8a82a', l: '#e8a82a' }),
    rabbit: H(['b.b', 'bbe', 'bb.'], { b: '#a8835a', e: '#111111' }),
    rabbitW: H(['b.b', 'bbe', 'bb.'], { b: '#eeeeee', e: '#111111' }),
    wolf: H(['....e', 'wwwww', 'w.l.l'], { w: '#d8d4cc', e: '#222222', l: '#b8b2a8' }),
    fox: H(['....oe', 'wooooo', '.l..l.'], { o: '#e07a2a', w: '#f2f2f2', e: '#222222', l: '#3a2a20' }),
    foxW: H(['....oe', 'wooooo', '.l..l.'], { o: '#f0f0f0', w: '#ffffff', e: '#222222', l: '#9a9a9a' }),
    polar: H(['.wwwwww', 'wwwwwwe', 'wwwwwwn', '.l.l.l.'], { w: '#f4f4f0', e: '#222222', n: '#333333', l: '#dddddd' }),
    camel: H(['.....hh', '..cc.he', '.cccccc', 'cccccc.', '.l..l..', '.l..l..'], { c: '#d6a95f', h: '#c99a52', e: '#222222', l: '#b88a48' }),
    bee: H(['.WW', 'ykY'], { W: '#d8eefc', y: '#f2c22a', k: '#222222', Y: '#f2c22a' }, { fly: true }),
    villager: H(['HH.', 'SEN', 'RR.', 'RA.', 'RR.', 'RR.', 'RR.', 'BB.'], { H: '#4a3020', S: '#c09070', E: '#2f6f3a', N: '#a87858', R: '#6e4b2e', A: '#c09070', B: '#3a2a20' }),
    // Steve：深棕短发、蓝紫眼睛、嘴边一圈深色（胡茬）、青色短袖、蓝裤子；Alex：橙色长发垂到肩后、绿眼睛、绿衣服、棕裤子
    steve: player({ H: '#3b2a17', S: '#c69c7d', W: '#f4f4f4', E: '#4b3a8c', N: '#8a5a3e', T: '#2fa8b8', t: '#24808c', A: '#c69c7d', P: '#3c3f9e', p: '#2c2f7a', B: '#555555', b: '#444444' }),
    alex: player({ H: '#e0853a', S: '#f3c9a7', W: '#f4f4f4', E: '#3c8a50', N: '#d89a80', T: '#4fa04a', t: '#3b7d37', A: '#f3c9a7', P: '#6a4a2a', p: '#553a20', B: '#4a4a4a', b: '#3a3a3a' }, 'HHSN', 'HTT.'),
    zombie: H(['HH.', 'SE.', 'TTA', 'TTA', 'TT.', 'PP.', 'PP.', 'BB.'], { H: '#2e5e2e', S: '#5a8f4a', E: '#111111', T: '#2f8f9a', A: '#5a8f4a', P: '#3a3a8f', B: '#3a3a3a' }, { hostile: true, burns: true }),
    husk: H(['HH.', 'SE.', 'TTA', 'TTA', 'TT.', 'PP.', 'PP.', 'BB.'], { H: '#6b5a3a', S: '#a8946a', E: '#111111', T: '#8a7a50', A: '#a8946a', P: '#5a4a30', B: '#3a3a3a' }, { hostile: true }),
    drowned: H(['HH.', 'SE.', 'TTA', 'TTA', 'TT.', 'PP.', 'PP.', 'BB.'], { H: '#2a6a6a', S: '#4a9a8a', E: '#7fe0ff', T: '#3a7a8a', A: '#4a9a8a', P: '#2a4a6a', B: '#2a3a3a' }, { hostile: true, swims: true, emissive: 'E' }),
    stray: H(['HH.', 'SE.', 'TT.', 'TAb', 'TAb', 'PP.', 'PP.', 'BB.'], { H: '#b8c8c8', S: '#c8d4d4', E: '#333333', T: '#6a8a8f', A: '#c8d4d4', P: '#5a7a7f', B: '#7a8a8a', b: '#6b4f2a' }, { hostile: true, burns: true }),
    skeleton: H(['HH.', 'SE.', 'TT.', 'TAb', 'TAb', 'TT.', 'TT.', 'TT.'], { H: '#c8c8c8', S: '#d0d0d0', E: '#333333', T: '#a8a8a8', A: '#c8c8c8', b: '#6b4f2a' }, { hostile: true, burns: true }),
    creeper: H(['.GG', '.GK', '.GG', '.gG', '.Gg', '.GG', 'G.G'], { G: '#5fb54a', g: '#3f8a32', K: '#111111' }, { hostile: true }),
    spider: H(['.kkkk..', 'kkkkkRR', 'l.l.l.l'], { k: '#3a3330', R: '#d02020', l: '#2a2420' }, { hostile: true, emissive: 'R' }),
    enderman: H(['KK.', 'PP.', 'KK.', 'KK.', 'KK.', 'KK.', 'K.K', 'K.K', 'K.K', 'K.K', 'K.K'], { K: '#151515', P: '#d78cff' }, { emissive: 'P' }),
    endermite: H(['mmm'], { m: '#5a3a7a' }),
    piglin: H(['HH.', 'SEN', 'GG.', 'GA.', 'GA.', 'PP.', 'PP.', 'BB.'], { H: '#e2a98f', S: '#e8b49c', E: '#222222', N: '#d6907a', G: '#e0b030', A: '#e8b49c', P: '#5a3a20', B: '#3a2a20' }),
    zpiglin: H(['HH.', 'SEN', 'GG.', 'GA.', 'GA.', 'PP.', 'PP.', 'BB.'], { H: '#d79a86', S: '#7fa06a', E: '#222222', N: '#e0a090', G: '#c0a050', A: '#7fa06a', P: '#5a3a20', B: '#3a2a20' }),
    strider: H(['.rrr', 'rrre', 'rrrr', '.l.l', '.l.l'], { r: '#b0353a', e: '#222222', l: '#7a3a3a' }),
    magma: H(['mmmm', 'mOmO', 'mmmm'], { m: '#4a1a10', O: '#ff9a2a' }, { emissive: 'O', hops: true }),
    blaze: H(['.yy.', 'yEyE', '.yy.', 'r..r', '.rr.', 'r..r', '.rr.'], { y: '#f2c23a', E: '#ffffff', r: '#e88a1a' }, { fly: true, emissive: 'yEr' }),
    ghast: H(['wwwwwwww', 'wwwwwwww', 'wEwwwwEw', 'wwwwwwww', 'wwwMMwww', 'wwwwwwww', 'w.w.w.w.', 'w...w..w'], { w: '#f2f2f2', E: '#555555', M: '#777777' }, { fly: true }),
    phantom: H(['p.....p', 'ppGppGp'], { p: '#4a5a8a', G: '#a8ff6a' }, { fly: true, emissive: 'G' }),
    squid: H(['.ss.', 'ssss', 'sEss', 's.s.'], { s: '#2a3a6a', E: '#dddddd' }, { swims: true }),
    cod: H(['ccC'], { c: '#b8a07a', C: '#8a7a5a' }, { swims: true }),
    tropical: H(['oow', 'wo.'], { o: '#f07a2a', w: '#ffffff' }, { swims: true }),
    dolphin: H(['..d...', 'dddddd'], { d: '#7a9ab8' }, { swims: true }),
    turtle: H(['.gg.', 'gggg'], { g: '#3f8a4a' }),
  };

  // ───────────────────────── 场景定义 ─────────────────────────
  const SCENES = {
    plains: { name: '平原', dim: 'over', top: 'grass', under: 'dirt', deep: 'stone', trees: [['oak', 0.045]], flowers: 0.22, water: 0.8, hill: 0.085, base: 0.74,
      animals: ['cow', 'pig', 'sheep', 'chicken', 'sheep'], hostile: ['zombie', 'skeleton', 'creeper', 'spider', 'slime'], aquatic: ['squid', 'cod'], house: 'planks' },
    forest: { name: '森林', dim: 'over', top: 'grass', under: 'dirt', deep: 'stone', trees: [['oak', 0.35], ['birch', 0.15]], flowers: 0.08, water: 0.83, hill: 0.1, base: 0.73,
      animals: ['pig', 'wolf', 'chicken', 'fox', 'sheep'], hostile: ['zombie', 'skeleton', 'creeper', 'spider', 'slime'], aquatic: ['cod'], house: 'planks' },
    desert: { name: '沙漠', dim: 'over', top: 'sand', under: 'sand', deep: 'sandstone', trees: [], cactus: 0.1, deadbush: 0.12, water: 0, hill: 0.07, base: 0.74, warm: true,
      animals: ['rabbit', 'camel', 'rabbit'], hostile: ['husk', 'creeper', 'skeleton', 'spider'], aquatic: [], house: 'sandstone' },
    snowy: { name: '雪原', dim: 'over', top: 'snow', under: 'dirt', deep: 'stone', trees: [['spruce', 0.07]], flowers: 0, water: 0.82, ice: true, hill: 0.1, base: 0.73, precip: 'snow', // 雪原不再一直下雪（rc3）：下不下看天气（sceneweather.js）
      animals: ['rabbitW', 'foxW', 'polar'], hostile: ['stray', 'zombie', 'creeper', 'spider'], aquatic: ['squid'], house: 'spruce' },
    // 海洋（第二阶段）：海平面在画面一半，海底、珊瑚礁、海底神殿、沉船见 sceneocean.js
    ocean: { name: '海洋', dim: 'over', top: 'sand', under: 'sand', deep: 'stone', trees: [], flowers: 0, water: 0.5, hill: 0.05, base: 0.84, ocean: true,
      animals: ['turtle'], hostile: ['drowned', 'zombie'], aquatic: ['cod', 'cod', 'salmon', 'tropical', 'tropical', 'squid', 'dolphin', 'pufferfish', 'glowSquid'], house: null },
    cherry: { name: '樱花林', dim: 'over', top: 'grassBright', under: 'dirt', deep: 'stone', trees: [['cherry', 0.22]], flowers: 0.15, water: 0.84, hill: 0.11, base: 0.72, weather: 'petals',
      animals: ['bee', 'pig', 'sheep', 'rabbit'], hostile: ['zombie', 'skeleton', 'creeper', 'spider'], aquatic: ['cod'], house: 'cherry' },
    // 蘑菇岛（第三阶段）：大海中间的一座岛，岛外是海底（sceneocean.js / sceneland.js）
    mushroom: { name: '蘑菇岛', dim: 'over', top: 'mycelium', under: 'dirt', deep: 'stone', trees: [['redMushroom', 0.09], ['brownMushroom', 0.07]], flowers: 0, water: 0.62, hill: 0.05, base: 0.84, noHostile: true,
      ocean: true, isle: true, animals: ['mooshroom'], hostile: [], aquatic: ['squid', 'cod', 'salmon', 'glowSquid'], house: null },
    // 黑森林（第三阶段）：深色橡树和巨型蘑菇，打开时那一屏有一座林地府邸（sceneland.js）
    // 丛林（1.5.16）：大丛林树挂着藤蔓、竹子、西瓜、鹦鹉和豹猫，偶尔有丛林神庙（scenejungle.js / scenetemple.js）
    jungle: { name: '丛林', dim: 'over', top: 'grassJungle', under: 'dirt', deep: 'stone', trees: [['jungle', 0.26], ['jungleBush', 0.14]], flowers: 0.05, water: 0.83, hill: 0.1, base: 0.73, jungle: true,
      animals: ['parrot', 'ocelot', 'parrotBlue', 'chicken', 'parrotGreen', 'panda'], hostile: ['zombie', 'skeleton', 'creeper', 'spider'], aquatic: ['cod', 'tropical'], house: 'planks' },
    darkforest: { name: '黑森林', dim: 'over', top: 'grassDark', under: 'dirt', deep: 'stone', trees: [['darkOak', 0.42], ['redMushroom', 0.035], ['brownMushroom', 0.035]], flowers: 0.06, water: 0.84, hill: 0.08, base: 0.74,
      animals: ['wolf', 'rabbit', 'chicken'], hostile: ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'slime'], aquatic: ['cod'], house: null, mansion: true },
    nether: { name: '下界', dim: 'nether', top: 'netherrack', under: 'netherrack', deep: 'netherrack', trees: [['crimson', 0.1]], hill: 0.14, base: 0.7, lava: 0.76, weather: 'ash',
      animals: ['strider', 'piglin', 'zpiglin'], hostile: ['ghast', 'magma', 'blaze', 'zpiglin'], aquatic: [] },
    end: { name: '末地', dim: 'end', top: 'endstone', under: 'endstone', deep: 'endstone', trees: [['chorus', 0.12]], hill: 0.08, base: 0.78, void: true,
      animals: ['enderman', 'enderman', 'endermite'], hostile: [], aquatic: [] },
  };
  const MAX_PLAYERS = 2;
  const OVERWORLD = ['plains', 'forest', 'desert', 'snowy', 'ocean', 'cherry', 'mushroom', 'darkforest', 'jungle'];

  // 「每次启动随机」：本次启动固定一个场景（包括下界和末地），尽量不和上次启动相同
  let launchPick = null;
  function randomScene() {
    if (launchPick) return launchPick;
    let last = null;
    try { last = localStorage.getItem('aurora.lastRandomScene'); } catch { /* 无痕环境 */ }
    const pool = Object.keys(SCENES).filter((k) => k !== last);
    launchPick = pool[Math.floor(Math.random() * pool.length)];
    try { localStorage.setItem('aurora.lastRandomScene', launchPick); } catch { /* 忽略 */ }
    return launchPick;
  }

  function sceneFor(id, seed) {
    if (id === 'random') return randomScene();
    if (id && id !== 'auto' && SCENES[id]) return id;
    // 自动：每天轮换一个主世界生态
    return OVERWORLD[seed % OVERWORLD.length];
  }

  /** 节日主题 */
  function festival() {
    const d = new Date();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (m === 10 && day >= 29) return 'halloween';
    if (m === 12 && day >= 23 && day <= 26) return 'christmas';
    if (m === 5 && day === 17) return 'birthday';
    if (m === 1 && day === 1) return 'newyear';
    return null;
  }

  const DEFAULTS = { scene: 'auto', time: 'auto', mobs: 8, animals: true, monsters: true, players: true, aquatic: true, peaceful: false, buildings: true, eggs: true, pan: true, mySkins: false, range: 'large', fps: 30, fx: 'high' };
  const FX_K = { high: 1, medium: 0.5, low: 0 }; // 特效档位：装饰粒子、光柱、气泡的多少（性能打磨）


  // 拆出去的模块要用的工具和材质。decoDraw：sceneocean.js 等模块加的装饰怎么画，drawDecor 先查这里
  A.sceneKit = { mulberry, hash, mix, rgb, hex, pal, pick, M, SPRITES, H, playerTemplate: (c, slim) => (slim ? player(c, 'HHSN', 'HTT.') : player(c)), decoDraw: {}, treeDraw: {}, tick: [], overlay: [], shade: [], hud: [], cellClick: {}, lerp, SKIES, periodFor, player, SCENES, MAX_PLAYERS, OVERWORLD, launchPick, randomScene, sceneFor, festival, DEFAULTS, FX_K };
  A.scenePeriod = periodFor;
  A.SCENES = Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, { name: v.name, dim: v.dim }]));
  A.SCENE_DEFAULTS = DEFAULTS;
})();
