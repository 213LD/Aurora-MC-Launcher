'use strict';
/**
 * 主页动态背景：地面上的结构（第三阶段）。挂在 A.Scene.prototype 上，结构走 sceneworld.js 的 GEN。
 * - 黑森林场景：打开时那一屏的左半边有一座林地府邸（圆石地基、深色橡木墙、三层窗户，夜里亮灯），门口有卫道士和唤魔者转悠
 * - 掠夺者前哨站：平原、沙漠、雪原、樱花林里偶尔出现（不在打开那一屏），塔顶挂旗帜，周围有掠夺者
 * - 废弃传送门：主世界和下界偶尔出现，黑曜石框缺了几块、哭泣的黑曜石会滴紫色的泪，旁边一圈下界岩、金块和箱子
 * - 蘑菇岛：大海中间的一座岛（海洋的海底照旧），岛上的小蘑菇
 * - 守卫结构的生物（府邸、前哨站、堡垒遗迹）只在结构附近走动（e.home）
 */
(function () {
  const { hash, pal, M, SPRITES, H, vnoise, smooth, REG, GEN, DECO, FX, ORE, decoDraw } = A.sceneKit;
  const P = A.Scene.prototype;

  Object.assign(M, {
    glass: pal('#a9c4d8', '#b8d0e0', '#9cb8cc'),
    litGlass: pal('#ffd36b', '#ffc94a', '#ffe08a'),
    birchPlanks: pal('#d8c890', '#cdbd84', '#e0d29c'),
    cryObs: pal('#20103a', '#2a1448', '#180c2c'),
    door: pal('#2a1c10', '#33220f'),
  });
  ORE.cry = pal('#9a3ae8', '#c070ff');

  // 灾厄村民：灰绿色皮肤，掠夺者拿弩、卫道士拿斧子、唤魔者穿黑金长袍；女巫（黑森林夜里）
  const ill = (C, item, extra) => H(['SS.', 'SEN', 'CC.', `CA${item}`, 'CC.', 'PP.', 'PP.', 'BB.'], { S: '#9aa39b', E: '#2a2a2a', N: '#7f8a82', A: '#9aa39b', B: '#2a2628', ...C }, { illager: true, ...extra });
  Object.assign(SPRITES, {
    pillager: ill({ C: '#4a4248', P: '#3a3540', x: '#6b4a2a' }, 'x'),
    vindicator: ill({ C: '#2f3a40', P: '#2a2f36', x: '#c8c8c8' }, 'x'),
    evoker: H(['SS.', 'SEN', 'RR.', 'RRA', 'RG.', 'RR.', 'RR.', 'RR.'], { S: '#9aa39b', E: '#2a2a2a', N: '#7f8a82', A: '#9aa39b', R: '#2a2a2e', G: '#d8b030' }, { illager: true }),
    witch: H(['.h.', 'hhh', 'SEN', 'PP.', 'PA.', 'PP.', 'PP.', 'PP.'], { h: '#3a2a4a', S: '#9a8a7a', E: '#2a8a3a', N: '#7a6a5a', P: '#4a2a5a', A: '#9a8a7a' }, { hostile: true }),
  });

  // ───────────── 地基 ─────────────

  /** 把 c0~c1（两边各多一列）的地面压平到平均高度，返回地面那一行；有水、虚空、坡太陡、挨着小屋返回 null（force 时只看虚空） */
  P.landFloor = function (c0, c1, spread = 6, force = false) {
    let sum = 0; let n = 0; let lo = Infinity; let hi = -Infinity;
    for (let c = c0 - 1; c <= c1 + 1; c++) {
      const h = this.colHeight(c);
      if (h > 900 || (!force && h >= this.sea - 1)) return null;
      sum += h; n++; lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (!force && hi - lo > spread) return null;
    if (this.houses.some((hs) => c1 + 3 >= hs.col && c0 - 3 <= hs.col + (hs.w || 5))) return null;
    if (this.structsIn(c0 - 3, c1 + 3).some((s) => s.type === 'lavaLake' && c1 + 3 >= s.c0 && c0 - 3 <= s.c1)) return null; // 地表岩浆湖旁边不建东西（rc4）
    const g = Math.min(Math.round(sum / n), this.sea < 900 ? this.sea - 2 : Infinity);
    for (let c = c0 - 1; c <= c1 + 1; c++) this.hOver.set(c, g);
    return g;
  };

  // ───────────── 林地府邸 ─────────────

  const MW = 29; // 府邸宽度
  const LOGS = [0, 7, 14, 21, 28];
  const ROOF = [[-1, 29], [1, 27], [3, 25], [6, 22], [10, 18]]; // 屋顶每层从哪列到哪列（y 13~17）

  P.makeMansion = function (at) {
    // 找一块够平的地（往右挪几次），实在没有就硬压平
    let g = null; let x0 = at;
    for (let k = 0; k < 6 && g == null; k++) { x0 = at + k * 2; g = this.landFloor(x0, x0 + MW - 1, 14, k === 5); }
    if (g == null) return null;
    const self = this;
    return {
      type: 'mansion', surface: true, c0: x0 - 1, c1: x0 + MW, r0: g - 19, r1: g - 1, guards: ['vindicator', 'evoker', 'vindicator'],
      cell(c, r) {
        const x = c - x0; const y = g - 1 - r;
        // 脚踩的那一行（y = -1）不归府邸管，照常是草地：以前也铺圆石，和墙根连成一片，门口的生物看着像飘在石墙中间（1.10.4）
        const chimney = (x === 5 || x === 23) && y >= 15 && y <= 18; // 烟囱从屋顶上伸出来
        if (y >= 13 && y <= 17) { const [a, b] = ROOF[y - 13]; return x >= a && x <= b ? { mat: M.darkPlanks } : chimney ? { mat: M.cobble } : undefined; }
        if (y >= 18) return chimney ? { mat: M.cobble } : undefined;
        if (x < 0 || x >= MW) return undefined;
        if (y === 0) return { mat: M.cobble };
        if (x >= 13 && x <= 15 && y <= 3) return x === 14 ? { mat: M.door } : { mat: M.darkLog }; // 大门
        if (LOGS.includes(x)) return { mat: M.darkLog };
        if (y === 4 || y === 8 || y === 12) return { mat: M.darkLog }; // 楼层之间的横梁
        // 窗户：每段墙中间两列，每层两格高；夜里亮灯（有几扇不亮）
        const bay = x % 7;
        if ((bay === 3 || bay === 4) && [2, 3, 6, 7, 10, 11].includes(y) && !(x >= 13 && x <= 15 && y <= 3)) {
          const lit = (self.period === 'night' || self.period === 'sunset') && hash(Math.floor(x / 7), Math.floor(y / 4), self.wseed + 302) < 0.7;
          return lit ? { mat: M.litGlass, glow: true } : { mat: M.glass };
        }
        return { mat: M.darkPlanks };
      },
    };
  };

  // ───────────── 掠夺者前哨站 ─────────────

  P.makeOutpost = function (at) {
    if (this.badlandsAt(at) || this.badlandsAt(at + 7)) return null;
    const g = this.landFloor(at - 1, at + 7, 5);
    if (g == null) return null;
    return {
      type: 'outpost', surface: true, c0: at - 1, c1: at + 7, r0: g - 17, r1: g, guards: ['pillager', 'pillager', 'pillager'],
      cell(c, r) {
        const x = c - at; const y = g - 1 - r;
        if (y === 13) return x === -1 || x === 7 || (x >= 0 && x <= 6 && x % 2 === 0) ? { deco: 'fence' } : undefined; // 塔顶栏杆
        if (y === 12) return { mat: M.darkPlanks }; // 塔顶平台（两边伸出去一格）
        if (y === 14) return x >= 0 && x <= 6 ? { mat: M.darkPlanks } : undefined;
        if (y === 15) return x >= 1 && x <= 5 ? { mat: M.darkPlanks } : undefined;
        if (y === 16) return x >= 2 && x <= 4 ? { mat: M.darkPlanks } : undefined;
        if (x === 7 && (y === 10 || y === 11)) return { deco: y === 11 ? 'bannerTop' : 'banner' }; // 平台下挂的旗帜
        if (x < 0 || x > 6 || y < 0 || y > 13) return undefined;
        if (y === 0) return { mat: M.cobble };
        if (x === 0 || x === 6) return { mat: M.darkLog };
        if (y === 4 || y === 8) return { mat: M.birchPlanks };
        if (x === 3 && (y === 2 || y === 6 || y === 10)) return { mat: M.darkPlanks, cave: true, deco: 'fence' }; // 射击孔
        return { mat: M.darkPlanks };
      },
    };
  };

  // ───────────── 废弃传送门 ─────────────

  P.makeRuinedPortal = function (at, rnd) {
    const g = this.landFloor(at - 1, at + 5, 3);
    if (g == null) return null;
    const s = this.wseed;
    const nether = this.dim === 'nether';
    // 随机数用相对地面的行号（g - r）：拉窗口整体挪了以后还是同一个样子（rc6）
    const missing = (c, r) => hash(c, g - r, s + 303) < 0.28;
    const chest = rnd() < 0.6;
    return {
      type: 'portal', surface: true, c0: at - 1, c1: at + 5, r0: g - 5, r1: g,
      cell(c, r) {
        const x = c - at; const y = g - 1 - r;
        // 地上一圈下界岩（下界里是岩浆块），中间有金块
        if (y === -1) return nether ? (hash(c, g - r, s + 304) < 0.5 ? { mat: M.magma, glow: true } : undefined) : hash(c, g - r, s + 304) < 0.75 ? { mat: M.netherrack } : undefined;
        if (x === 4 && y === 0) return { mat: M.gold };
        if (x === -1 && y === 0 && chest) return { deco: 'chest' };
        if (x < 0 || x > 3 || y < 0 || y > 4) return undefined;
        const frame = x === 0 || x === 3 || y === 0 || y === 4;
        if (!frame || (y > 0 && missing(c, r))) return undefined;
        if (hash(c, g - r, s + 305) < 0.3) return { mat: M.cryObs, ore: 'cry', fx: 'cry' };
        return { mat: M.obsidian };
      },
    };
  };

  // 主世界的地面结构：黑森林打开那一屏的府邸；别的区域偶尔有前哨站、废弃传送门
  // 原版的掠夺者前哨站：平原、沙漠、雪原、樱花林和雪山上有，森林、黑森林、丛林、恶地里没有（1.10.3 去掉了森林和黑森林）
  const OUTPOST_SCENES = new Set(['plains', 'desert', 'snowy', 'cherry']);
  GEN.push(function (reg, rnd) {
    if (this.dim !== 'over' || this.S.ocean) return null;
    if (reg === 0 && this.S.mansion) return this.makeMansion(Math.floor((this.homeCols || this.cols) * 0.2));
    if (reg === 0 || reg === -1) return null; // 打开那一屏留给小屋
    const k = rnd();
    const at = reg * REG + 4 + Math.floor(rnd() * (REG - 16));
    if (k < 0.16 && OUTPOST_SCENES.has(this.sceneId)) return this.makeOutpost(at);
    if (k >= 0.16 && k < 0.26) return this.makeRuinedPortal(at, rnd);
    // 沙漠神殿、丛林神庙（1.5.16，scenetemple.js）：每个区域 7% / 8%，不在打开那一屏
    if (k >= 0.26 && k < 0.33 && this.sceneId === 'desert') return this.makeDesertTemple(at);
    if (k >= 0.26 && k < 0.34 && this.sceneId === 'jungle') return this.makeJungleTemple(at);
    return null;
  });

  // ───────────── 蘑菇岛 ─────────────

  /** 蘑菇岛：打开那一屏中间隆起一座岛，两边是海（sceneocean.oceanHeight 调用；h、sea 都是按打开时的窗口算的行号） */
  P.isleHeight = function (c, h, sea) {
    const v = this.homeCols || this.cols;
    const d = Math.abs(c - v * 0.55) / (v * 0.5);
    if (d >= 1) return h;
    const land = sea - this.wr * 0.1 - (vnoise(c / 14, 4.5, this.wseed + 301) - 0.5) * this.wr * 0.08;
    return h + (land - h) * smooth((1 - d) / 0.45);
  };

  // ───────────── 山羊（rc1 之前补上的） ─────────────
  // 原版只生成在雪山上（积雪山坡、尖峭山峰、冰封山峰），雪原里没有：这里只放在场景两边雪山的高处，能跳上一两格高的坎，不往山下走
  SPRITES.goat = H(['.....H.', '....www', 'wwwwwwe', 'wwwwwwb', '.l..l..'], { w: '#e8e2d6', H: '#b8ab94', e: '#222222', b: '#d0c8b8', l: '#a89e8c' });
  /** 这一列是雪山的高处吗（和山坡上长云杉的线一样高） */
  P.alpineAt = function (x) {
    if (this.dim !== 'over' || !this.mountK || this.peakKind !== 'snow' || this.sceneId === 'cherry') return false;
    const c = Math.floor(x / this.B);
    const top = this.colHeight(c);
    return top < this.baseRow - 12 && top < 900 && !this.isWaterCol(x);
  };
  /** 画面里有雪山的高处才生成山羊 */
  P.goatSpawnable = function () {
    if (!this.mountK || this.peakKind !== 'snow') return false;
    for (let x = this.cam.x + 8; x < this.cam.x + this.W - 8; x += this.B * 3) if (this.alpineAt(x)) return true;
    return false;
  };

  // ───────────── 守卫结构的生物 ─────────────

  /** 画面里有府邸、前哨站、堡垒遗迹：先补它们的守卫（只在附近走动） */
  P.landSpawn = function (now) {
    if (this.dim === 'end') return false;
    const B = this.B;
    const c0 = Math.floor(this.cam.x / B); const c1 = Math.floor((this.cam.x + this.W) / B);
    for (const s of this.structsIn(c0, c1)) {
      if (!s.guards || s.c1 < c0 || s.c0 > c1) continue;
      const mine = this.ents.filter((e) => e.guardOf === s).length;
      if (mine >= s.guards.length) continue;
      const kind = s.guards[mine];
      if (!this.allowed(kind)) continue;
      const e = this.spawnMob(kind, now, (s.c0 - 4 + this.rnd() * (s.c1 - s.c0 + 8)) * B);
      if (!e) continue;
      Object.assign(e, { guardOf: s, home: [(s.c0 - 8) * B, (s.c1 + 8) * B], life: 60000 + this.rnd() * 60000 });
      return true;
    }
    return false;
  };

  // ───────────── 装饰 ─────────────

  const C = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const FENCE = C('#4a3520');
  DECO.fence = (dot) => { for (let y = 0; y < 4; y++) dot(1, y, FENCE); dot(0, 1, FENCE); dot(2, 1, FENCE); dot(3, 1, FENCE); };
  // 灾厄旗帜：白底，中间一张灰色的灾厄村民脸
  DECO.bannerTop = (dot) => { for (let x = 0; x < 3; x++) dot(x, 0, FENCE); for (let y = 1; y < 4; y++) for (let x = 0; x < 3; x++) dot(x, y, C('#e8e4dc')); dot(1, 2, C('#3a3a3a')); dot(1, 3, C('#7a7a7a')); };
  DECO.banner = (dot) => { for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) dot(x, y, C('#e8e4dc')); dot(0, 0, C('#5a5a5a')); dot(2, 0, C('#5a5a5a')); dot(1, 1, C('#3a3a3a')); dot(1, 3, C('#e8e4dc')); };

  /** 哭泣的黑曜石滴紫色的泪 */
  FX.cry = function (x, y) {
    if (this.rnd() < 0.004 * this.fxK) this.parts.push({ x: x - this.landX + 1 + this.rnd() * 2, y: y - this.landY + 4, vx: 0, vy: 0, g: 60, life: 800, c: [170, 80, 255], glow: true });
  };

  /** 蘑菇岛、黑森林地上的小蘑菇 */
  decoDraw.shroom = function (d, x, top) {
    const g = this.ctx;
    g.fillStyle = this.color([220, 210, 190]); g.fillRect(x + 1, top - 2, 1, 2);
    g.fillStyle = this.color(d.red ? [200, 50, 45] : [150, 110, 80]); g.fillRect(x, top - 3, 3, 1);
    if (d.red) { g.fillStyle = this.color([240, 240, 230]); g.fillRect(x + 1, top - 3, 1, 1); }
  };

})();
