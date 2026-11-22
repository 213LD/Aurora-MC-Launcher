'use strict';
/**
 * 首页动态背景：夜晚的火把。挂在 A.Scene.prototype 上，scene.js 在生成玩家、更新、干活、绘制时调用。
 * - 夜里有小屋时，玩家多数从屋里出来，约 60% 在屋子附近活动（走远了会折回来），会在屋子周围插火把照明
 * - 约 40% 拿着火把出远门；遇到怪物换成剑（scenefight.js 打斗时画剑，这里就不画火把）
 * - 火把插了就一直留着（天亮也不收），换场景时清掉
 */
(function () {
  const P = A.Scene.prototype;

  const MAX_TORCHES = 6;
  const LEASH = 9; // 留在家附近的玩家离小屋多少格就往回走
  const STICK = [110, 80, 40];
  const FLAME = [[255, 214, 90], [255, 170, 60], [255, 240, 160]];

  const houseCenter = (s) => { const h = s.houses[0]; return h ? (h.col + (h.w || 5) / 2) * s.B : null; };

  /** 夜里刚生成的玩家：分配「在家附近」还是「拿火把远行」 */
  P.nightPlayer = function (e) {
    if (!e || !this.houses[0]) return;
    e.night = this.rnd() < 0.4 ? 'roam' : 'home';
    e.torch = e.night === 'roam';
  };

  /** 每帧：家附近的玩家不走远、去插火把。返回 true 表示这一帧已经处理了移动 */
  P.torchTick = function (e, sec, now) {
    if (e.night !== 'home' || !this.isNight() || e.state === 'fight' || e.state === 'flee') return false;
    const hc = houseCenter(this);
    if (hc == null) return false;
    // 走远了就往回走
    if ((e.state === 'walk' || e.state === 'idle') && Math.abs(e.x - hc) > LEASH * this.B) {
      e.state = 'walk';
      e.dir = hc > e.x ? 1 : -1;
      e.until = now + 2000;
    }
    // 屋子周围火把不够，就去插一根
    if ((e.state === 'walk' || e.state === 'idle') && this.torches.length < MAX_TORCHES && this.rnd() < sec * 0.6) {
      const col = this.torchSpot();
      if (col != null) {
        e.state = 'goto';
        e.goal = col * this.B - (col * this.B > e.x ? 2 : -this.B);
        e.task = { type: 'torch', col };
        e.until = now + 15000;
      }
    }
    return false;
  };

  /** 小屋两侧找一格平地：不在屋子里、不在水里、离别的火把至少 2 格 */
  P.torchSpot = function () {
    const h = this.houses[0];
    if (!h) return null;
    const cands = [];
    const w = h.w || 5;
    for (let c = h.col - 5; c <= h.col + w + 4; c++) {
      if (c >= h.col && c <= h.col + w - 1) continue;
      if (!this.loadedAt((c - 1) * this.B) || !this.loadedAt((c + 1) * this.B)) continue;
      if (this.isWaterCol(c * this.B + 2)) continue;
      if (Math.abs(this.heights[c] - h.ground) > 2) continue;
      if (this.torches.some((t) => Math.abs(t.col - c) < 2)) continue;
      if (this.trees.some((t) => t.alive && t.col === c)) continue;
      cands.push(c);
    }
    if (!cands.length) return null;
    // 先插紧挨着门两边的，再往外
    cands.sort((a, b) => Math.abs(a - (h.col + w / 2)) - Math.abs(b - (h.col + w / 2)));
    return cands[Math.floor(this.rnd() * Math.min(3, cands.length))];
  };

  /** work() 里 task.type === 'torch'：挥一下手插上 */
  P.placeTorch = function (e, now) {
    if (e.swing < 0.5) return;
    const col = e.task.col;
    if (!this.torches.some((t) => t.col === col)) {
      this.torches.push({ col, top: this.heights[col], t: now });
      for (let k = 0; k < 6; k++) this.parts.push({ x: col * this.B + 2, y: this.heights[col] * this.B - 5, vx: (this.rnd() - 0.5) * 14, vy: -8 - this.rnd() * 8, g: 30, life: 500, c: FLAME[k % 3], glow: true, land: true });
    }
    e.task = null;
    e.swing = 0;
    e.state = 'walk';
    e.dir = this.rnd() < 0.5 ? -1 : 1;
    e.until = now + 2000 + this.rnd() * 3000;
  };

  const glow = (ctx, x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255, 190, 90, ${a})`);
    g.addColorStop(1, 'rgba(255, 190, 90, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  /** 地上的火把（光晕只在夜里、黄昏、黎明有） */
  P.drawTorches = function (ox, oy, now) {
    if (!this.torches.length) return;
    const { ctx, B } = this;
    const dark = this.period === 'night' ? 1 : this.period === 'sunset' || this.period === 'dawn' ? 0.5 : 0;
    for (const t of this.torches) {
      const x = Math.round(t.col * B + 2 + ox);
      const y = Math.round(t.top * B + oy);
      if (dark) glow(ctx, x + 0.5, y - 5, 14, 0.22 * dark + Math.sin(now / 160 + t.col) * 0.03);
      ctx.fillStyle = this.color(STICK);
      ctx.fillRect(x, y - 4, 1, 4);
      ctx.fillStyle = this.color(FLAME[((Math.floor(now / 140 + t.col) % 3) + 3) % 3], true); // 列号是负数时取余也可能是负的
      ctx.fillRect(x, y - 5, 1, 1);
      if (Math.floor(now / 300 + t.col) % 3 === 0) { ctx.fillStyle = this.color(FLAME[2], true); ctx.fillRect(x, y - 6, 1, 1); }
    }
  };

  /** 远行玩家手里的火把；打架时 scenefight.js 画剑，这里不画 */
  P.drawHeldTorches = function (ox, oy, now) {
    const { ctx } = this;
    for (const e of this.ents) {
      if (!e.torch || e.kind !== 'player' || e.boat || e.dead) continue;
      if (e.state === 'fight' || (e.swingT && now - e.swingT < 400)) continue;
      const x0 = Math.round(e.x + ox);
      const y0 = Math.round(e.y + oy) - e.spr.h + this.spriteBob(e, now);
      // 火把举在手前面（手在精灵图第 7 行）
      const hx = e.dir > 0 ? x0 + 3 : x0 + e.spr.w - 4;
      ctx.globalAlpha = Math.max(0, Math.min(1, e.alpha));
      if (this.isNight()) glow(ctx, hx + 0.5, y0 + 4, 12, 0.2);
      ctx.fillStyle = this.color(STICK);
      ctx.fillRect(hx, y0 + 5, 1, 2);
      ctx.fillStyle = this.color(FLAME[Math.floor(now / 140) % 3], true);
      ctx.fillRect(hx, y0 + 4, 1, 1);
      ctx.globalAlpha = 1;
    }
  };
})();
