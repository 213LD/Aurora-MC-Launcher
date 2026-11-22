'use strict';
/**
 * 主页动态背景：下界群系（第三阶段）。挂在 A.Scene.prototype 上，sceneworld.js / scene.js 调用。
 * - 五种群系按段交替：下界荒地、绯红森林（绯红菌、垂泪藤似的菌根、疣猪兽）、诡异森林（诡异菌、缠怨藤、末影人）、
 *   灵魂沙峡谷（灵魂沙 / 灵魂土、灵魂火、化石、骷髅和恶魂）、玄武岩三角洲（玄武岩柱、黑石、岩浆块、岩浆怪）。
 *   打开时那一屏的左边每天换一个有特色的群系
 * - 结构：堡垒遗迹（黑石城墙、宝库里的金块、猪灵蛮兵守着）、灵魂沙峡谷里的化石、废弃传送门（sceneland.js）；下界要塞的桥照旧
 * - 飘的粒子按群系换颜色：绯红孢子、诡异孢子、灵魂、灰烬
 */
(function () {
  const { hash, pal, M, SPRITES, H, vnoise, REG, GEN, decoDraw } = A.sceneKit;
  const P = A.Scene.prototype;

  Object.assign(M, {
    crimsonNylium: pal('#8a1c1c', '#a02424', '#7a1818'),
    warpedNylium: pal('#2a7a6a', '#24887a', '#1f6a5c'),
    soulSoil: pal('#4a3a30', '#42332a', '#544236'),
    bone: pal('#e2dcc8', '#d6cfb8', '#ece6d4'),
    blackBrick: pal('#2e2a30', '#36313a', '#28242a'),
    polBlackstone: pal('#3a343c', '#332e35', '#423b44'),
  });

  Object.assign(SPRITES, {
    hoglin: H(['....tt.', 'hhhhhhe', 'hhhhhhn', '.l..l..'], { h: '#c08060', t: '#e8d8c0', e: '#222222', n: '#a06848', l: '#8a5a40' }, { hostile: true }),
    piglinBrute: H(['HH.', 'SEN', 'KK.', 'KAa', 'KK.', 'PP.', 'PP.', 'BB.'], { H: '#e2a98f', S: '#e8b49c', E: '#222222', N: '#d6907a', K: '#3a3a3a', A: '#e8b49c', a: '#e0b030', P: '#2a2a2a', B: '#1a1a1a' }),
  });

  const BIOMES = ['wastes', 'crimson', 'warped', 'soul', 'basalt'];

  /** 这一列是什么群系（每段约 46 列，边界弯弯曲曲） */
  P.netherBiome = function (c) {
    if (this.dim !== 'nether') return null;
    const seg = Math.floor((c + 10 * Math.sin(c * 0.045 + this.worldOff[1])) / 46);
    if (seg === 0) return BIOMES[1 + (this.seed % 4)]; // 打开那一屏：每天换一个有特色的
    return BIOMES[Math.floor(hash(seg, 0, this.wseed + 203) * 5)];
  };

  /** 群系的地表（sceneworld.cellAt 调用）；返回 null = 照旧（下界岩） */
  P.netherCell = function (c, r, top, depth) {
    const b = this.netherBiome(c);
    const s = this.wseed;
    if (b === 'crimson') return depth === 0 ? { mat: M.crimsonNylium } : null;
    if (b === 'warped') return depth === 0 ? { mat: M.warpedNylium } : null;
    if (b === 'soul') return depth < 4 ? { mat: vnoise(c * 0.3, (r - this.baseRow) * 0.3, s + 204) > 0.5 ? M.soul : M.soulSoil } : null;
    if (b === 'basalt' && depth < 5) {
      if (hash(c, r - this.baseRow, s + 205) < 0.07) return { mat: M.magma, glow: true };
      return { mat: vnoise(c * 0.25, (r - this.baseRow) * 0.25, s + 206) > 0.55 ? M.blackstone : M.basalt };
    }
    return null;
  };

  /** 每个群系长什么菌（sceneworld.populate 调用） */
  P.netherTrees = function (c) {
    const b = this.netherBiome(c);
    if (b === 'crimson') return [['crimson', 0.32]];
    if (b === 'warped') return [['warped', 0.32]];
    return [];
  };

  /** 地上的小东西 */
  P.netherDecor = function (c, top, rnd) {
    const b = this.netherBiome(c);
    const r = rnd();
    if (b === 'crimson' && r < 0.35) return { type: 'fungus', col: c, top, warped: false, roots: r < 0.15 };
    if (b === 'warped') {
      if (r < 0.18) return { type: 'fungus', col: c, top, warped: true, roots: r < 0.08 };
      if (r < 0.32) return { type: 'twisting', col: c, top, h: 1 + Math.floor(rnd() * 4) };
    }
    if (b === 'soul' && r < 0.08) return { type: 'soulfire', col: c, top, ph: rnd() * 6 };
    if (b === 'basalt' && r < 0.14) return { type: 'basaltCol', col: c, top, h: 2 + Math.floor(rnd() * 5) };
    if (b === 'wastes' && r < 0.03) return { type: 'netherFire', col: c, top, ph: rnd() * 6 };
    return null;
  };

  /** 天上飘的粒子颜色 */
  P.netherAsh = function (x) {
    const b = this.netherBiome(Math.floor(x / this.B));
    if (b === 'crimson') return [210, 60, 60];
    if (b === 'warped') return [90, 220, 200];
    if (b === 'soul') return [110, 200, 230];
    if (b === 'basalt') return [210, 210, 210];
    return [120, 110, 110];
  };

  // ───────────── 结构 ─────────────

  /** 堡垒遗迹：两边高高的黑石城墙（带垛口）、中间一座塔，下层剖开是宝库（金块、箱子） */
  P.makeBastion = function (at) {
    const W = 21;
    if (this.netherBiome(at) === 'basalt' || this.netherBiome(at + W - 1) === 'basalt') return null; // 原版玄武岩三角洲里没有堡垒遗迹
    const g = this.landFloor(at, at + W - 1, 8);
    if (g == null) return null;
    const s = this.wseed;
    const brick = (c, r) => {
      // 随机数用相对地面的行号（g - r）：拉窗口整体挪了以后还是同一个样子（rc6）
      if (g - 1 - r > 2 && hash(c, g - r, s + 211) < 0.07) return undefined; // 城墙残缺
      const h = hash(c, g - r, s + 210);
      if (h < 0.06) return { mat: M.blackstone, ore: 'netherGold' }; // 镶金黑石
      return { mat: h < 0.35 ? M.polBlackstone : M.blackBrick, deco: 'brick', mortar: [24, 20, 26] };
    };
    return {
      type: 'bastion', surface: true, c0: at, c1: at + W - 1, r0: g - 13, r1: g, guards: ['piglinBrute', 'piglin', 'piglin'],
      cell(c, r) {
        const x = c - at; const y = g - 1 - r;
        if (y < 0 || y > 12) return undefined;
        if (x <= 1 || x >= W - 2) return y <= 10 || (y === 11 && x % 2 === 0) ? brick(c, r) : undefined;
        if (y === 0 || y === 6) return { mat: M.polBlackstone };
        if (y < 6) {
          // 宝库
          if (y <= 2 && x >= 9 && x <= 11 && (y === 1 || x === 10)) return { mat: M.gold };
          if (y === 1 && (x === 4 || x === 16)) return { mat: M.blackBrick, cave: true, deco: 'chest' };
          return { mat: M.blackBrick, cave: true };
        }
        if (x >= 7 && x <= 13) return y <= 10 || (y === 11 && x % 2 === 1) ? brick(c, r) : undefined;
        if (y === 7 && x % 3 === 0) return brick(c, r);
        return undefined;
      },
    };
  };

  /** 灵魂沙峡谷里半埋着的巨型骨架 */
  P.makeFossil = function (at) {
    if (this.netherBiome(at + 5) !== 'soul') return null;
    const base = this.colHeight(at + 5);
    if (base > 900 || base >= this.sea - 2) return null;
    return {
      type: 'fossil', c0: at, c1: at + 11, r0: base - 7, r1: base + 1,
      cell(c, r) {
        const x = c - at; const y = base + 1 - r; // 埋进地里两格
        const bone = (y === 5 && x <= 10) || (x % 2 === 1 && x < 10 && y < 5 && y >= (x === 1 || x === 9 ? 2 : 0)) || (x >= 10 && y >= 4 && y <= 6);
        return bone ? { mat: M.bone } : undefined;
      },
    };
  };

  GEN.push(function (reg, rnd) {
    if (this.dim !== 'nether') return null;
    const k = rnd();
    const at = reg === 0 ? Math.floor((this.homeCols || this.cols) * 0.22) : reg * REG + 4 + Math.floor(rnd() * (REG - 30));
    if (this.netherBiome(at + 5) === 'soul' && k < 0.6) return this.makeFossil(at); // 灵魂沙峡谷多半有化石
    if (k < 0.3) return this.makeBastion(at);
    if (k < 0.45) return this.makeFossil(at) || this.makeRuinedPortal(at, rnd);
    if (k < 0.62) return this.makeRuinedPortal(at, rnd);
    if (k < 0.88 && this.makeFortress) return this.makeFortress(this.fortressAt(reg, rnd), rnd); // 下界要塞（scenefortress.js）
    return null;
  });

  // ───────────── 生物 ─────────────

  // 每个群系的生物：[种类, 权重]
  const POOL = {
    wastes: [['zpiglin', 3], ['piglin', 2], ['ghast', 1], ['magma', 1], ['strider', 1]],
    crimson: [['hoglin', 3], ['piglin', 3], ['zpiglin', 1], ['strider', 1]],
    warped: [['enderman', 4], ['strider', 1]],
    soul: [['skeleton', 3], ['ghast', 2]],
    basalt: [['magma', 4], ['ghast', 1]],
  };

  /** 下界按画面里某个位置的群系生成生物（scene.spawn 调用）；返回 true 表示生成了 */
  P.netherSpawn = function (now) {
    if (this.dim !== 'nether') return false;
    const x = this.cam.x + 10 + this.rnd() * (this.W - 20);
    const list = POOL[this.netherBiome(Math.floor(x / this.B))].filter(([k]) => this.allowed(k));
    if (!list.length) return false;
    let roll = this.rnd() * list.reduce((a, k) => a + k[1], 0);
    let kind = list[0][0];
    for (const [k, w] of list) { roll -= w; if (roll <= 0) { kind = k; break; } }
    return !!this.spawnMob(kind, now, kind === 'strider' ? undefined : x);
  };

  // ───────────── 装饰 ─────────────

  decoDraw.fungus = function (d, x, top) {
    const g = this.ctx;
    const stem = d.warped ? [40, 120, 110] : [150, 40, 40];
    const cap = d.warped ? [20, 140, 140] : [190, 40, 40];
    if (d.roots) { g.fillStyle = this.color(stem); g.fillRect(x, top - 2, 1, 2); g.fillRect(x + 2, top - 3, 1, 3); g.fillRect(x + 3, top - 1, 1, 1); return; }
    g.fillStyle = this.color([200, 180, 150]); g.fillRect(x + 1, top - 2, 1, 2);
    g.fillStyle = this.color(cap); g.fillRect(x, top - 3, 3, 1);
    g.fillStyle = this.color(d.warped ? [240, 140, 60] : [240, 160, 70]); g.fillRect(x + 1, top - 4, 1, 1);
  };

  decoDraw.twisting = function (d, x, top, now) {
    const g = this.ctx;
    const n = d.h * this.B;
    const w = this.wiggle(d, now); // 被点了摆得厉害一点（sceneinteract.js）
    g.fillStyle = this.color([60, 200, 170]);
    for (let k = 0; k < n; k += 2) g.fillRect(x + 1 + Math.round(Math.sin(now / 1300 + d.col + k * 0.3) * 0.8 + (w ? Math.sin(now / 150) * w * 3 * (k / n) : 0)), top - 2 - k, 1, 2);
  };

  decoDraw.soulfire = function (d, x, top, now) {
    const g = this.ctx;
    const f = this.noFlash ? 0 : Math.sin(now / 120 + d.ph);
    g.fillStyle = 'rgb(70,200,230)'; g.fillRect(x, top - 2, 4, 2);
    g.fillStyle = 'rgb(150,240,255)'; g.fillRect(x + 1, top - 3 - (f > 0.3 ? 1 : 0), 2, 1 + (f > 0.3 ? 1 : 0));
    g.fillStyle = 'rgba(90,210,240,0.18)'; g.fillRect(x - 2, top - 6, 8, 6);
  };

  decoDraw.netherFire = function (d, x, top, now) {
    const g = this.ctx;
    const f = this.noFlash ? 0 : Math.sin(now / 110 + d.ph);
    g.fillStyle = 'rgb(255,150,40)'; g.fillRect(x, top - 2, 4, 2);
    g.fillStyle = 'rgb(255,220,90)'; g.fillRect(x + 1, top - 3 - (f > 0.3 ? 1 : 0), 2, 1 + (f > 0.3 ? 1 : 0));
  };

  decoDraw.basaltCol = function (d, x, top) {
    const g = this.ctx;
    const B = this.B;
    for (let k = 1; k <= d.h; k++) {
      // 玄武岩：竖纹（两边暗一条）
      g.fillStyle = this.color(M.basalt[k % 3]); g.fillRect(x, top - k * B, B, B);
      g.fillStyle = this.color(M.basalt[1].map((v) => v * 0.8)); g.fillRect(x, top - k * B, 1, B); g.fillRect(x + B - 1, top - k * B, 1, B);
    }
    g.fillStyle = this.color([110, 110, 118]); g.fillRect(x, top - d.h * B, B, 1);
  };

})();
