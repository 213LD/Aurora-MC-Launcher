'use strict';
/**
 * 主页动态背景：沙漠神殿、丛林神庙（1.5.16，生成概率都低，不在打开那一屏，见 sceneland.js 的 GEN）
 * 都是剖面画法（能看到里面）：
 * - 沙漠神殿：两座橙蓝陶瓦条纹的塔 + 阶梯金字塔，大厅地上一块蓝色陶瓦；正下面一条竖井通到地下的密室，
 *   密室里四个箱子、中间一块压力板，压力板下面是 TNT。点压力板：TNT 闪几下炸掉（不破坏别的地形），过一会儿复原
 * - 丛林神庙：苔石和圆石，外墙挂藤蔓；一楼走廊有绊线和发射器（点绊线射出箭），地下室墙上三根拉杆（点了扳过去），楼上和地下各一个箱子
 */
(function () {
  const { hash, pal, M, DECO, cellClick } = A.sceneKit;
  const P = A.Scene.prototype;
  const C = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

  Object.assign(M, {
    cutSandstone: pal('#d8c890', '#cfbf86', '#e0d29a'),
    chiseledSandstone: pal('#c8b47a', '#bfa86e', '#d4c088'),
    orangeTerracotta: pal('#a0532a', '#984e27', '#a85a2f'),
    blueTerracotta: pal('#4a5a7a', '#435272', '#506284'),
    tnt: pal('#c8342a', '#d8402e', '#b02a22'),
    tntFlash: pal('#ffffff', '#f4f4f4'),
    stoneBricks: pal('#7a7a7a', '#727272', '#848484'),
    chiseledStone: pal('#8a8a8a', '#7c7c7c', '#969696'),
  });

  // ───────────── 沙漠神殿 ─────────────

  const DW = 21;
  P.makeDesertTemple = function (at) {
    if (this.colHeight(at + 10) < this.baseRow - 8) return null; // 不建在山上
    const g = this.landFloor(at, at + DW - 1, 7);
    if (g == null) return null;
    const s = this.wseed;
    const sand = (c, r) => (hash(c, g - r, s + 401) < 0.3 ? { mat: M.cutSandstone } : { mat: M.sandstone }); // 相对地面的行号：拉窗口整体挪了以后还是同一个样子（rc6）
    return {
      type: 'desertTemple', surface: true, c0: at, c1: at + DW - 1, r0: g - 15, r1: g + 15,
      cell(c, r) {
        const x = c - at; const y = g - 1 - r;
        // 地下：竖井 + 密室（y -10 ~ -13 是房间，-14 地板，-15 TNT）
        if (y < 0) {
          if (x === 10 && y >= -9) return { mat: M.sandstone, cave: true }; // 竖井
          if (y <= -9 && y >= -15 && x >= 6 && x <= 14) {
            if (y === -15) return x >= 9 && x <= 11 ? { mat: M.tnt, tnt: true } : { mat: M.sandstone };
            if (y === -9 || y === -14 || x === 6 || x === 14) return y === -14 && x >= 9 && x <= 11 ? { mat: M.sandstone } : sand(c, r);
            if (y === -13 && x === 10) return { mat: M.sandstone, cave: true, deco: 'plate' };
            if (y === -13 && (x === 7 || x === 8 || x === 12 || x === 13)) return { mat: M.sandstone, cave: true, deco: 'chest' };
            if (y === -10 && (x === 7 || x === 13)) return { mat: M.orangeTerracotta };
            return { mat: M.sandstone, cave: true };
          }
          return undefined;
        }
        if (x < 0 || x >= DW) return undefined;
        // 两座塔
        if (x <= 4 || x >= 16) {
          const tx = x <= 4 ? x : x - 16;
          if (y === 13) return tx % 2 === 0 ? { mat: M.cutSandstone } : undefined; // 垛口
          if (y > 13) return undefined;
          if (y === 12) return { mat: M.cutSandstone };
          if ((y === 8 || y === 10) && tx >= 1 && tx <= 3) return { mat: M.orangeTerracotta };
          if (y === 9 && tx === 2) return { mat: M.blueTerracotta };
          if (y === 9 && (tx === 1 || tx === 3)) return { mat: M.orangeTerracotta };
          if ((y === 4 || y === 5) && tx === 2) return { mat: M.sandstone, cave: true }; // 小窗
          return sand(c, r);
        }
        // 中间的阶梯金字塔
        const roof = [[5, 15], [6, 14], [7, 13], [8, 12], [9, 11]]; // y 6~10
        if (y >= 6) { const k = roof[y - 6]; if (!k) return undefined; return x >= k[0] && x <= k[1] ? (y === 10 ? { mat: M.chiseledSandstone } : sand(c, r)) : undefined; }
        if (y === 0) {
          if (x === 10) return { mat: M.blueTerracotta };
          if (x === 9 || x === 11) return { mat: M.orangeTerracotta };
          return { mat: M.sandstone };
        }
        if (x === 5 || x === 15) return sand(c, r);
        if ((x === 7 || x === 13) && y <= 5) return { mat: M.cutSandstone }; // 柱子
        if (y === 3 && x >= 8 && x <= 12 && x !== 10) return { mat: M.orangeTerracotta, cave: true }; // 后墙的花纹
        return { mat: M.sandstone, cave: true };
      },
    };
  };

  // ───────────── 丛林神庙 ─────────────

  const JW = 15;
  P.makeJungleTemple = function (at) {
    if (this.colHeight(at + 7) < this.baseRow - 8) return null; // 不建在山上
    const g = this.landFloor(at - 1, at + JW, 9);
    if (g == null) return null;
    const s = this.wseed;
    const stone = (c, r) => (hash(c, g - r, s + 411) < 0.45 ? { mat: M.mossyCobble } : { mat: M.cobble }); // 相对地面的行号（rc6）
    return {
      type: 'jungleTemple', surface: true, c0: at - 1, c1: at + JW, r0: g - 13, r1: g + 6,
      cell(c, r) {
        const x = c - at; const y = g - 1 - r;
        // 外墙挂的藤蔓
        if ((x === -1 || x === JW) && y >= 2 && y <= 8) return hash(c, y > 5 ? 1 : 0, s + 412) < 0.6 && y > 2 + Math.floor(hash(c, 2, s + 413) * 3) ? { deco: 'vine' } : undefined;
        if (x < 0 || x >= JW) return undefined;
        // 地下室：三根拉杆、一个箱子
        if (y < 0) {
          if (y < -5) return undefined;
          if (y === -1 && x === 7) return { mat: M.stoneBricks, cave: true }; // 楼梯口
          if (y === -1) return undefined; // 脚踩的那一行照常是地面，和墙根分得开，路过的生物不会像飘在石墙中间（1.10.4）
          if (y === -5 || x <= 1 || x >= JW - 2) return stone(c, r);
          if (y === -3 && x >= 5 && x <= 7) return { mat: M.mossyCobble, cave: true, deco: 'lever' };
          if (y === -4 && x === 11) return { mat: M.mossyCobble, cave: true, deco: 'chest' };
          return { mat: M.mossyCobble, cave: true };
        }
        // 屋顶
        const roof = [[0, 14], [1, 13], [3, 11], [5, 9]]; // y 8~11
        if (y >= 8) { const k = roof[y - 8]; if (!k) return undefined; return x >= k[0] && x <= k[1] ? (y === 11 || (y === 9 && (x === 3 || x === 11)) ? { mat: M.chiseledStone } : stone(c, r)) : undefined; }
        if (y === 0 || x === 0 || x === JW - 1) {
          if (x === 0 && y === 1) return { mat: M.cobble, deco: 'dispenser' }; // 箭的发射器
          if (y === 0 && x === 7) return { mat: M.stoneBricks, cave: true }; // 通往地下室
          return stone(c, r);
        }
        if (y === 4) return x === 12 ? { mat: M.mossyCobble, cave: true } : { mat: M.stoneBricks }; // 二楼地板（右边留个口）
        if (y === 1 && x >= 2 && x <= 6) return { mat: M.mossyCobble, cave: true, deco: 'tripwire' };
        if (y === 5 && x === 4) return { mat: M.mossyCobble, cave: true, deco: 'chest' };
        if ((y === 6 && (x === 3 || x === 11)) || (y === 2 && x === 10)) return { mat: M.chiseledStone, cave: true };
        return { mat: M.mossyCobble, cave: true };
      },
    };
  };

  // ───────────── 小装饰 ─────────────

  const PLATE = C('#c8b47a'); const WOOD = C('#6b4a2a'); const STONE = C('#8a8a8a'); const STRING = C('#e8e8e8');
  DECO.plate = (dot) => { for (let x = 0; x < 4; x++) dot(x, 3, PLATE); };
  DECO.platePressed = (dot) => { for (let x = 0; x < 4; x++) dot(x, 3, C('#a89460')); };
  DECO.lever = (dot) => { dot(1, 3, STONE); dot(2, 3, STONE); dot(2, 2, WOOD); dot(3, 1, WOOD); dot(3, 0, C('#c03020')); };
  DECO.leverOn = (dot) => { dot(1, 3, STONE); dot(2, 3, STONE); dot(1, 2, WOOD); dot(0, 1, WOOD); dot(0, 0, C('#ff4030'), true); };
  DECO.tripwire = (dot) => { for (let x = 0; x < 4; x++) dot(x, 3, STRING); };
  DECO.dispenser = (dot) => { dot(1, 1, C('#2a2a2a')); dot(2, 1, C('#2a2a2a')); dot(1, 2, C('#2a2a2a')); dot(2, 2, C('#2a2a2a')); };

  // ───────────── 点击 ─────────────

  // 拉杆：扳过去 / 扳回来
  cellClick.lever = function (cell, c, r) {
    const m = this.envGet(c, r);
    this.envMod(c, r, { deco: m && m.deco === 'leverOn' ? 'lever' : 'leverOn' });
    this.envSound('block.lever.click', { pitch: m && m.deco === 'leverOn' ? 0.5 : 0.6 });
  };
  cellClick.leverOn = cellClick.lever;

  // 绊线：左边墙里的发射器射出一支箭
  cellClick.tripwire = function (cell, c, r) {
    const B = this.B;
    let x0 = c;
    for (let k = 1; k < 10; k++) { const x = this.cellAtWorld(c - k, r); if (x && x.deco === 'dispenser') { x0 = c - k; break; } }
    this.envSound('block.tripwire.click_on');
    setTimeout(() => this.envSound('block.dispenser.launch'), 120);
    this.parts.push({ x: x0 * B + 4, y: r * B + 2, vx: 70, vy: 0, life: 1400, c: [200, 200, 200], size: 2 });
    this.parts.push({ x: x0 * B + 2, y: r * B + 2, vx: 70, vy: 0, life: 1400, c: [120, 90, 60] });
  };

  // 爆炸半径（格，横向宽一点）：9 块 TNT 在原版里会把整个密室炸穿，这里炸出一个椭圆的坑
  const RX = 4.6;
  const RY = 3.6;

  /** 以 (c0, r0) 为中心炸出一个坑：坑里的方块（连同箱子、压力板）变成空洞，30 秒后和神殿一起复原 */
  function crater(self, c0, r0, until) {
    const B = self.B;
    for (let dy = -Math.ceil(RY); dy <= Math.ceil(RY); dy++) {
      for (let dx = -Math.ceil(RX); dx <= Math.ceil(RX); dx++) {
        if ((dx / RX) ** 2 + (dy / RY) ** 2 > 1) continue;
        const c = c0 + dx;
        const r = r0 + dy;
        const cell = self.cellAtWorld(c, r);
        if (!cell || !cell.mat || cell.mat === M.bedrock) continue;
        if (cell.cave && !cell.deco) continue; // 本来就是空的
        const mat = cell.tnt ? M.sandstone : cell.mat;
        self.envMod(c, r, { gone: mat, until });
        // 边上的碎块飞出来一点
        if (self.rnd() < 0.4) self.parts.push({ x: c * B + 2, y: r * B + 2, vx: dx * 9 + (self.rnd() - 0.5) * 16, vy: dy * 7 - 18 - self.rnd() * 14, g: 60, life: 700 + self.rnd() * 500, c: self.tint(mat[0]), size: 2 });
      }
    }
  }

  // 压力板：密室的 TNT 闪三下后炸掉——炸出一个坑（箱子、地板、下面的沙子都炸没），附近的生物被击退；30 秒后复原（1.5.17）
  cellClick.plate = function (cell, c, r, now) {
    if (this.envGet(c, r)) return;
    this.envMod(c, r, { deco: 'platePressed', until: now + 30000 });
    this.envSound('block.stone_pressure_plate.click_on');
    this.envSound('entity.tnt.primed');
    const tnt = [-1, 0, 1].map((dx) => [c + dx, r + 2]);
    let n = 0;
    const flash = setInterval(() => {
      n++;
      for (const [tc, tr] of tnt) this.envMod(tc, tr, n % 2 ? { mat: M.tntFlash, glow: true, until: now + 30000 } : { mat: M.tnt, until: now + 30000 });
      if (n < 6) return;
      clearInterval(flash);
      const t = performance.now();
      crater(this, c, r + 2, t + 30000);
      this.blast({ x: c * this.B - 1, y: (r + 2) * this.B }, t);
      const B = this.B;
      for (let k = 0; k < 26; k++) this.parts.push({ x: c * B + 2 + (this.rnd() - 0.5) * 14, y: (r + 1) * B + (this.rnd() - 0.5) * 10, vx: (this.rnd() - 0.5) * 50, vy: (this.rnd() - 0.7) * 40, life: 700 + this.rnd() * 500, c: this.rnd() < 0.5 ? [255, 200, 80] : [90, 90, 90], glow: this.rnd() < 0.5, size: 2 });
      this.envSound('entity.generic.explode', { volume: 0.7 });
    }, 250);
  };
})();
