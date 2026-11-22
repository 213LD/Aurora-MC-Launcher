'use strict';
/**
 * 主页动态背景：丛林场景（1.5.16）。场景定义在 scene.js 的 SCENES.jungle。
 * - 大丛林树：两格粗、很高，树冠又宽又厚，树干上挂可可豆，树冠边上垂下藤蔓（藤蔓每帧画，会轻轻摆，被点了晃得厉害）
 * - 丛林灌木：一格树干 + 贴地的一团叶子
 * - 地上：竹子（一丛丛的，会摆）、西瓜
 * - 生物：鹦鹉（红 / 蓝 / 绿，在树冠高度飞）、豹猫（跑得快）、熊猫
 * - 丛林神庙见 scenetemple.js
 */
(function () {
  const { hash, pal, M, SPRITES, H, treeDraw, decoDraw } = A.sceneKit;
  const P = A.Scene.prototype;

  Object.assign(M, {
    grassJungle: pal('#4fae2a', '#5abd31', '#47a024'),
    jungleLog: pal('#5a4424', '#4e3a1e', '#665030'),
    jungleLeaves: pal('#2f8a1e', '#277a18', '#36981f', '#22701a'),
  });

  const parrot = (body, wing) => H(['.bb.', 'bbbY', '.ww.', '..t.'], { b: body, Y: '#f0c040', w: wing, t: body }, { fly: true, canopy: true });
  Object.assign(SPRITES, {
    parrot: parrot('#d8302a', '#2a6ad8'),
    parrotBlue: parrot('#3a6ae0', '#e8c040'),
    parrotGreen: parrot('#4ab82a', '#d8302a'),
    ocelot: H(['.....ye', 'ySyySyy', '.l...l.'], { y: '#e0b850', S: '#7a5a28', e: '#3a8a3a', l: '#c89a40' }),
    panda: H(['....wwk', 'wwwwwke', 'kkkwkk.', 'k.k.k..'], { w: '#eeeeea', k: '#262626', e: '#ffffff' }),
  });

  // ───────────── 树 ─────────────

  treeDraw.jungle = function (tr, L, x, top, trunk, scale) {
    const B = this.B;
    for (let k = 1; k <= trunk; k++) { L(x, top - k * B, M.jungleLog); L(x + B, top - k * B, M.jungleLog, 0.88); }
    if (scale < 0.5) { L(x, top - (trunk + 1) * B, M.jungleLeaves); return; }
    const g = this.ctx;
    // 树干中间伸出一根小枝，带一团叶子
    const side = hash(tr.seed, 7, 5) < 0.5 ? -1 : 1;
    const mid = Math.max(3, Math.floor(trunk * 0.55));
    const bx = side < 0 ? x - B : x + 2 * B;
    L(bx, top - mid * B, M.jungleLog, 0.92);
    for (let dx = -1; dx <= 1; dx++) L(bx + side * B + dx * B, top - (mid + 1) * B, M.jungleLeaves, 0.95);
    L(bx + side * B, top - (mid + 2) * B, M.jungleLeaves);
    // 树冠：三层，下面两层宽
    const rows = [[-3, 4], [-3, 4], [-2, 3]];
    rows.forEach(([a, b], dy) => {
      for (let dx = a; dx <= b; dx++) {
        if ((dx === a || dx === b) && hash(dx + tr.seed, dy, 4) < 0.35) continue;
        L(x + dx * B, top - (trunk + 1 + dy) * B, M.jungleLeaves, 1 - dy * 0.05);
      }
    });
    // 可可豆：树干侧面 1~2 个
    for (let n = 0; n < 2; n++) {
      if (hash(tr.seed, 20 + n, 5) < 0.4) continue;
      const k = 2 + Math.floor(hash(tr.seed, 30 + n, 5) * Math.max(1, trunk - 4));
      const cx = n ? x + 2 * B : x - 2;
      const cy = top - k * B + 1;
      g.fillStyle = this.color([150, 90, 40]); g.fillRect(cx, cy, 2, 3);
      g.fillStyle = this.color([110, 60, 25]); g.fillRect(cx, cy + 2, 2, 1);
    }
    // 藤蔓（每帧画，见 drawVines）：从树冠边上垂下来
    if (!tr.vines) {
      tr.vines = [];
      for (const dx of [-3, 4, -2, 3]) {
        if (hash(tr.seed, dx + 40, 5) < 0.4) continue;
        tr.vines.push({ dx, up: 0, len: 2 + Math.floor(hash(tr.seed, dx + 50, 5) * 4) });
      }
    }
  };

  treeDraw.jungleBush = function (tr, L, x, top) {
    const B = this.B;
    L(x, top - B, M.jungleLog);
    for (let dx = -1; dx <= 1; dx++) { L(x + dx * B, top - 2 * B, M.jungleLeaves); if (dx) L(x + dx * B, top - B, M.jungleLeaves, 0.92); }
    if (hash(tr.seed, 3, 5) < 0.6) L(x, top - 3 * B, M.jungleLeaves, 0.96);
  };

  /** 丛林树的藤蔓：平时轻轻摆，被点了（tr.wig）晃得厉害 */
  P.drawVines = function (tr, ox, oy) {
    const g = this.ctx; const B = this.B;
    const now = performance.now();
    const w = this.wiggle(tr, now);
    const calm = this.fxK ? 0.6 : 0;
    const a = this.color([46, 120, 30]); const b = this.color([60, 145, 38]);
    for (const v of tr.vines) {
      const x = (tr.col + v.dx) * B + ox + 1 + (v.dx % 2 ? 1 : 0);
      const y0 = (tr.top - tr.trunk - v.up) * B + oy;
      const n = v.len * B;
      for (let k = 0; k < n; k++) {
        const f = k / n;
        const dx = Math.round((Math.sin(now / 1500 + v.dx + tr.seed) * calm + (w ? Math.sin(now / 150 + v.dx) * w * 3 : 0)) * f);
        g.fillStyle = k % 3 === 2 ? b : a;
        g.fillRect(x + dx, y0 + k, 1, 1);
        if (k % 5 === 3) g.fillRect(x + dx + (k % 10 === 3 ? -1 : 1), y0 + k, 1, 1); // 小叶子
      }
    }
  };

  // ───────────── 地上的装饰 ─────────────

  /** 丛林地上：竹子（多）或西瓜（sceneworld.populate 调用） */
  P.jungleDecor = function (col, top, rnd) {
    if (rnd() < 0.7) return { type: 'bamboo', col, top, h: 4 + Math.floor(rnd() * 7), ph: rnd() * 6 };
    return { type: 'melon', col, top };
  };

  decoDraw.bamboo = function (d, x, top, now) {
    const g = this.ctx;
    const n = d.h * this.B;
    const w = this.wiggle(d, now);
    const calm = this.fxK ? 0.5 : 0;
    const stalk = this.color([92, 150, 40]); const dark = this.color([70, 122, 32]); const node = this.color([150, 190, 70]); const leaf = this.color([80, 160, 40]);
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const dx = Math.round((Math.sin(now / 1800 + d.ph) * calm + (w ? Math.sin(now / 150 + d.ph) * w * 3 : 0)) * f);
      const y = top - 1 - k;
      g.fillStyle = k % 4 === 3 ? node : stalk; g.fillRect(x + 1 + dx, y, 1, 1);
      g.fillStyle = k % 4 === 3 ? node : dark; g.fillRect(x + 2 + dx, y, 1, 1);
      if (k > n * 0.5 && k % 4 === 1) { g.fillStyle = leaf; g.fillRect(k % 8 === 1 ? x + dx : x + 3 + dx, y, 1, 1); }
    }
    const dx = Math.round((Math.sin(now / 1800 + d.ph) * calm + (w ? Math.sin(now / 150 + d.ph) * w * 3 : 0)));
    g.fillStyle = leaf; g.fillRect(x + dx, top - n - 1, 4, 1); g.fillRect(x + 1 + dx, top - n - 2, 2, 1);
  };

  decoDraw.melon = function (d, x, top) {
    const g = this.ctx; const B = this.B;
    for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) {
      g.fillStyle = this.color(px % 2 ? [70, 120, 30] : py === 0 ? [140, 180, 60] : [110, 160, 45]);
      g.fillRect(x + px, top - B + py, 1, 1);
    }
  };
})();
