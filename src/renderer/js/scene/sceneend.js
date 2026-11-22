'use strict';
/**
 * 主页动态背景：末地（1.5.16）
 * - 打开时那一屏是主岛（打末影龙的大岛）：中间是返回传送门（基岩的池子和中间的柱子，打败末影龙后池子里才是传送门），
 *   周围一圈高低不一的黑曜石柱，柱顶有末影水晶（最矮的两根有铁栏杆笼子）。主岛底下又厚又尖，像原版那样悬在虚空里
 * - 主岛外面隔一段虚空才是外岛：外岛上没有黑曜石柱和水晶，长紫颂植物，偶尔有末地城（有潜影贝），有的旁边浮着一艘末地船，船舱里挂着鞘翅
 * - 点末影水晶：爆炸，过一会儿重新出现（终极彩蛋的结局里不会再出现，scenending.js）
 * 布局按 wseed 和 homeCols 算一次（this.endLayout），柱子的水晶状态记在布局里（块卸载重建也不丢）
 */
(function () {
  const { hash, pal, M, SPRITES, H, vnoise, REG, GEN, DECO, FX, decoDraw, cellClick } = A.sceneKit;
  const P = A.Scene.prototype;
  const C = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

  Object.assign(M, {
    bedrockEnd: pal('#3a3a3a', '#555555', '#2a2a2a', '#4a4a4a'),
    endPortal: pal('#05030a', '#0a0614', '#070410'),
    purpur: pal('#a77ba7', '#9a6f9a', '#b386b3'),
    purpurPillar: pal('#ad82ad', '#a275a2', '#b88ab8'),
    endBricks: pal('#d8d89a', '#cece8e', '#e2e2a8'),
    magentaGlass: pal('#b04ab0', '#c058c0', '#a040a0'),
  });

  Object.assign(SPRITES, {
    shulker: H(['.pp.', 'pppp', 'pYYp', 'pppp'], { p: '#9a6a9a', Y: '#e8d870' }),
  });

  // ───────────── 布局 ─────────────

  /** 主岛中心、半径、主岛和外岛之间的虚空宽度、黑曜石柱 */
  P.endLay = function () {
    const v = this.homeCols || this.cols;
    const key = `${this.wseed}|${v}`; // 改窗口大小重建世界时布局不变（水晶炸没炸也记得）
    if (this.endLayout && this.endLayout.key === key) return this.endLayout;
    const cx = Math.round(v * 0.55);
    const R = Math.round(v * 0.46);
    const s = this.wseed;
    const pillars = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const col = Math.round(cx - R * 0.86 + (i / (n - 1)) * R * 1.72 + (hash(i, 1, s + 501) - 0.5) * 6);
      if (Math.abs(col - cx) < 10) continue; // 给传送门和末影龙让地方
      pillars.push({ col, w: 2 + (hash(i, 2, s + 502) < 0.5 ? 1 : 0), h: 11 + Math.floor(hash(i, 3, s + 503) * 13), crystal: true });
    }
    // 最矮的两根有笼子
    [...pillars].sort((a, b) => a.h - b.h).slice(0, 2).forEach((p) => { p.cage = true; });
    this.endLayout = { key, cx, R, gap: 26, pillars, portalRow: null };
    return this.endLayout;
  };

  P.onMainIsland = function (c) {
    if (this.dim !== 'end') return false;
    const L = this.endLay();
    return Math.abs(c - L.cx) <= L.R;
  };

  /** 末地地形高度：主岛是一块微微隆起的大平台；主岛外一段虚空；再往外交给 genHeight 原来的外岛算法（返回 null） */
  P.endHeight = function (c) {
    if (this.dim !== 'end') return null;
    const L = this.endLay();
    const d = Math.abs(c - L.cx) / L.R;
    if (d <= 1) {
      const dome = 1 - d * d;
      return Math.round(this.wr * 0.7 - dome * this.wr * 0.05 + (vnoise(c / 9, 0.5, this.wseed + 504) - 0.5) * 3 + (d > 0.93 ? (d - 0.93) * 40 : 0)) + this.lift;
    }
    if (Math.abs(c - L.cx) < L.R + L.gap) return 9999;
    return null;
  };

  /** 岛的底：主岛中间厚、往边上变薄（倒过来的山），外岛薄薄一层 */
  P.endBottom = function (c, top) {
    const L = this.endLay();
    const d = Math.abs(c - L.cx) / L.R;
    // 按打开时的窗口算，整体挪 lift 行（rc6，见 sceneworld.initWorld）
    if (d <= 1) return Math.min(this.wr + this.lift + 30, top + 3 + Math.round(Math.pow(1 - d * d, 0.8) * this.wr * 0.24 + hash(c, 3, 7) * 3));
    return Math.min(this.wr + this.lift, top + 4 + Math.floor(hash(c, 3, 7) * 5));
  };

  // ───────────── 返回传送门 ─────────────

  P.makeExitPortal = function () {
    const L = this.endLay();
    const g = this.landFloor(L.cx - 4, L.cx + 4, 20, true);
    if (g == null) return null;
    L.portalRow = g;
    const self = this;
    return {
      type: 'exitPortal', c0: L.cx - 3, c1: L.cx + 3, r0: g - 5, r1: g,
      cell(c, r) {
        const x = c - L.cx; const y = g - 1 - r;
        if (y === -1) return { mat: M.bedrockEnd };
        if (x === 0 && y >= 0 && y <= 3) return { mat: M.bedrockEnd };
        if (y === 0 && Math.abs(x) === 3) return { mat: M.bedrockEnd };
        if (y === 0 && self.endPortalOpen) return { mat: M.endPortal, glow: true, fx: 'endGate' };
        if (y === 2 && Math.abs(x) === 1) return { deco: x < 0 ? 'torchR' : 'torchL' };
        return undefined;
      },
    };
  };

  /** 打开 / 关上传送门（终极彩蛋打败末影龙后打开）：那几块要重画 */
  P.setEndPortal = function (open) {
    this.endPortalOpen = !!open;
    const L = this.endLay();
    for (const ch of this.chunks.values()) if (ch.c0 <= L.cx + 3 && ch.c0 + A.sceneKit.CH > L.cx - 3) ch.dirty = true;
  };

  FX.endGate = function (x, y, now) {
    const g = this.ctx;
    const B = this.B;
    for (let k = 0; k < 2; k++) {
      const h = hash(Math.floor(now / 400) + k * 7, x, 9);
      g.fillStyle = h < 0.33 ? 'rgba(120,220,200,0.9)' : h < 0.66 ? 'rgba(200,150,255,0.9)' : 'rgba(255,255,255,0.8)';
      g.fillRect(x + Math.floor(hash(x, k, Math.floor(now / 400)) * B), y + Math.floor(hash(k, x, Math.floor(now / 400) + 3) * B), 1, 1);
    }
  };

  const TORCH = C('#ffd040');
  DECO.torchL = (dot) => { dot(1, 1, C('#6b4a2a')); dot(1, 2, C('#6b4a2a')); dot(1, 0, TORCH, true); };
  DECO.torchR = (dot) => { dot(2, 1, C('#6b4a2a')); dot(2, 2, C('#6b4a2a')); dot(2, 0, TORCH, true); };

  // ───────────── 末地城、末地船 ─────────────

  const CW = 9;
  P.makeEndCity = function (at, rnd) {
    const g = this.landFloor(at, at + CW - 1, 4);
    if (g == null) return null;
    const ship = rnd() < 0.6;
    const s = this.wseed;
    const out = [{
      type: 'endCity', surface: true, c0: at - 1, c1: at + CW, r0: g - 19, r1: g, guards: ['shulker', 'shulker'],
      cell(c, r) {
        const x = c - at; const y = g - 1 - r;
        // 三层，越往上越窄；每层有挑出来的屋檐
        const tiers = [[0, 0, 8, 4], [6, 1, 7, 4], [12, 2, 6, 3]]; // [起始 y, 左, 右, 高]
        for (const [y0, a, b, hgt] of tiers) {
          if (y === y0 + hgt + 1) return x >= a - 1 && x <= b + 1 ? { mat: M.purpur } : undefined; // 屋檐
          if (y < y0 || y > y0 + hgt) continue;
          if (x < a || x > b) continue;
          if (y === y0 || x === a || x === b) {
            if ((x === a || x === b) && y === y0 + 2) return { mat: M.magentaGlass, glow: true };
            return hash(c, y, s + 511) < 0.15 ? { mat: M.purpurPillar } : { mat: M.purpur }; // y 是相对城底的行号：拉窗口整体挪了以后还是同一个样子（rc6）
          }
          if (y === y0 + 1 && x === a + 2 && y0 === 6) return { mat: M.purpur, cave: true, deco: 'chest' };
          if (y === y0 + hgt && x === Math.round((a + b) / 2)) return { mat: M.purpur, cave: true, deco: 'endRodDown' };
          return { mat: M.purpur, cave: true };
        }
        if (y === 18 && (x === 2 || x === 6)) return { deco: 'endRod' };
        if (y === 0 && (x === -1 || x === CW)) return { mat: M.endBricks };
        return undefined;
      },
    }];
    if (ship) {
      // 船浮在城旁边的半空（可能在虚空上面，sceneworld 会画）
      const sx = at + CW + 4; const sb = g - 9; // 船底那一行
      out.push({
        type: 'endShip', c0: sx, c1: sx + 20, r0: sb - 11, r1: sb,
        cell(c, r) {
          const x = c - sx; const y = sb - r;
          if (y === 0) return x >= 4 && x <= 14 ? { mat: M.purpur } : undefined;
          if (y === 1) {
            if (x === 2 || x === 16) return { mat: M.purpur };
            if (x === 9) return { mat: M.purpur, cave: true, deco: 'elytra' }; // 挂着鞘翅的物品展示框
            if (x === 12) return { mat: M.purpur, cave: true, deco: 'brewing' };
            if (x === 6) return { mat: M.purpur, cave: true, deco: 'chest' };
            return x > 2 && x < 16 ? { mat: M.purpur, cave: true } : undefined;
          }
          if (y === 2) return x >= 1 && x <= 18 ? { mat: x === 18 ? M.purpurPillar : M.purpur } : undefined; // 甲板
          if (y === 3 && x === 19) return { deco: 'dragonHead' }; // 船头的龙首
          if (y === 3 && x === 18) return { mat: M.purpur };
          if (y >= 3 && y <= 5 && x >= 1 && x <= 4) return (y === 4 && x === 3) ? { mat: M.magentaGlass, glow: true } : { mat: M.purpur }; // 船尾楼
          if (x === 10 && y >= 3 && y <= 10) return { mat: M.purpurPillar }; // 桅杆
          if (y === 11 && x === 10) return { deco: 'endRod' };
          if (y >= 6 && y <= 9 && x >= 8 && x <= 12 && x !== 10 && hash(x, y, s + 512) < 0.85) return { mat: M.magentaGlass, glow: true }; // 帆
          return undefined;
        },
      });
    }
    return out;
  };

  const ROD = C('#f4f0e8'); const ROD2 = C('#d8c8f0');
  DECO.endRod = (dot) => { for (let y = 0; y < 4; y++) dot(1, y, y ? ROD : ROD2, true); dot(2, 3, ROD2, true); };
  DECO.endRodDown = (dot) => { for (let y = 0; y < 3; y++) dot(2, y, ROD, true); };
  DECO.elytra = (dot) => {
    const F = C('#7a5232'); const E = C('#9a9aac'); const D = C('#6e6e84');
    for (let k = 0; k < 4; k++) { dot(k, 0, F); dot(k, 3, F); dot(0, k, F); dot(3, k, F); }
    dot(1, 1, E); dot(2, 1, E); dot(1, 2, D); dot(2, 2, D);
  };
  DECO.brewing = (dot) => { dot(1, 3, C('#3a3a3a')); dot(2, 3, C('#3a3a3a')); dot(2, 1, C('#d8d8a0')); dot(2, 2, C('#d8d8a0')); dot(1, 2, C('#c040c0'), true); dot(3, 2, C('#40a0e0'), true); };
  DECO.dragonHead = (dot) => {
    const K = C('#1a1a1a'); const G = C('#2e2e2e');
    for (let x = 0; x < 4; x++) for (let y = 1; y < 4; y++) dot(x, y, y === 1 ? G : K);
    dot(3, 2, C('#c040e0'), true); dot(0, 0, G);
  };

  cellClick.elytra = function (cell, c, r) {
    for (let k = 0; k < 6; k++) this.parts.push({ x: c * this.B + 2, y: r * this.B + 2, vx: (this.rnd() - 0.5) * 12, vy: -6 - this.rnd() * 8, life: 800, c: [200, 200, 230], glow: true });
    this.envSound('entity.item_frame.rotate_item');
  };

  // 主岛：返回传送门所在的区域；外岛（离主岛够远）35% 有末地城
  GEN.push(function (reg, rnd) {
    if (this.dim !== 'end') return null;
    const L = this.endLay();
    if (Math.floor(L.cx / REG) === reg) return this.makeExitPortal();
    const mid = reg * REG + REG / 2;
    if (Math.abs(mid - L.cx) < L.R + L.gap + REG / 2) return null;
    if (rnd() < 0.35) return this.makeEndCity(reg * REG + 6 + Math.floor(rnd() * (REG - 40)), rnd);
    return null;
  });

  // ───────────── 黑曜石柱和末影水晶 ─────────────

  /** 这一块里的黑曜石柱（sceneworld.populate 调用；外岛没有） */
  P.endPillarsIn = function (ch, CHW) {
    for (const p of this.endLay().pillars) {
      if (p.col < ch.c0 || p.col >= ch.c0 + CHW) continue;
      let top = Infinity;
      for (let k = 0; k < p.w; k++) top = Math.min(top, this.colHeight(p.col + k));
      this.decor.push({ type: 'pillar', col: p.col, top, h: p.h, w: p.w, p, ci: ch.ci });
    }
  };

  decoDraw.pillar = function (d, x, top, now) {
    const g = this.ctx; const B = this.B; const p = d.p || d;
    const w = d.w || 1;
    // 柱身缓存成小图（逐像素画一帧要 2ms 多），换时段（palV）重画
    if (!d.cv || d.cvKey !== this.palV) {
      d.cv = document.createElement('canvas');
      d.cv.width = w * B; d.cv.height = (d.h + 1) * B;
      const c = d.cv.getContext('2d');
      for (let k = 0; k <= d.h; k++) {
        for (let py = 0; py < B; py++) for (let px = 0; px < B * w; px++) {
          c.fillStyle = this.color(M.obsidian[Math.floor(hash(px + d.col * 4, py + k * 4, 6) * 3)].map((v) => v * (px < 2 ? 1.15 : 1)));
          c.fillRect(px, (d.h - k) * B + py, 1, 1);
        }
      }
      d.cvKey = this.palV;
    }
    g.drawImage(d.cv, x, top - d.h * B);
    const cx = x + (w * B) / 2;
    const yTop = top - d.h * B; // 柱顶（最上面那块的上沿）
    // 水晶底下的基岩和火
    g.fillStyle = this.color([70, 70, 70]); g.fillRect(cx - 2, yTop - B, 4, B);
    if (p.cage) {
      g.fillStyle = this.color([150, 150, 150]);
      for (let k = -1; k <= 3; k += 2) g.fillRect(cx - 5, yTop - B * 3 + k * 2, 10, 1);
      for (const dx of [-5, -2, 1, 4]) g.fillRect(cx + dx, yTop - B * 3 - 2, 1, B * 3 + 2);
    }
    if (p.crystal === false && p.crystalBack && now > p.crystalBack) { p.crystal = true; p.crystalBack = 0; }
    if (p.crystal === false) { p.hit = null; return; }
    // 末影水晶：上下浮动、转动的方块
    const cy = yTop - B * 2 - 3 + Math.round(Math.sin(now / 500 + d.col) * 2);
    const s = Math.floor(now / 250 + d.col) % 2;
    // 柔和的十字光晕（以前是一整块方形，在夜空里像个盒子）
    g.fillStyle = `rgba(255,150,230,${0.1 + 0.06 * Math.sin(now / 300)})`;
    g.fillRect(cx - 4, cy - 1, 8, 4); g.fillRect(cx - 2, cy - 3, 4, 8);
    g.fillStyle = 'rgba(255,120,220,0.9)';
    g.fillRect(cx - 2 + (s ? 0 : 1), cy, s ? 4 : 2, s ? 2 : 4);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(cx - 1, cy + 1, 2, 1);
    g.fillStyle = 'rgba(255,170,60,0.7)'; g.fillRect(cx - 1, yTop - B - 2, 2, 2); // 底下的火
    p.hit = [cx - this.landX, cy + 2 - this.landY]; // 世界坐标，点击用
  };

  /** 点末影水晶：爆炸（sceneinteract.clickEnv 先问这里） */
  P.clickCrystal = function (wx, wy, now) {
    if (this.dim !== 'end') return false;
    for (const p of this.endLay().pillars) {
      if (!p.hit || p.crystal === false) continue;
      if (Math.abs(wx - p.hit[0]) > 6 || Math.abs(wy - p.hit[1]) > 6) continue;
      this.blowCrystal(p, now, !!this.ending); // 结局里玩家帮忙炸的水晶也不再长回来（1.5.17）
      return true;
    }
    return false;
  };

  P.blowCrystal = function (p, now, keep) {
    p.crystal = false;
    p.crystalBack = keep ? 0 : now + 40000;
    const [x, y] = p.hit || [p.col * this.B, 0];
    for (let k = 0; k < 30; k++) this.parts.push({ x: x + (this.rnd() - 0.5) * 10, y: y + (this.rnd() - 0.5) * 10, vx: (this.rnd() - 0.5) * 60, vy: (this.rnd() - 0.6) * 50, life: 600 + this.rnd() * 600, c: this.rnd() < 0.4 ? [255, 160, 230] : this.rnd() < 0.5 ? [255, 255, 255] : [110, 110, 110], glow: true, size: this.rnd() < 0.3 ? 2 : 1 });
    if (A.gameSound) A.gameSound.play('entity.generic.explode', { volume: 0.6 }).catch(() => {});
  };

})();
