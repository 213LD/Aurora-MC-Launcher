'use strict';
/**
 * 主页动态背景：玩家盖的小建筑（1.7.0）。以前只有四种 3 格宽的方块堆（拱门、灯柱、矮墙、小塔），
 * 现在按权重随机抽：常见的还是小件，偶尔是小木屋、瞭望塔、水井、麦田，很少见的是下界传送门、雪傀儡、像素爱心；
 * 1.7.3 加了大一些的：两层小楼（7 宽）、灯塔（13 高）、城门（9 宽）、谷仓（7 宽）、凉亭。
 * 方块一块一块从下往上放（scene.js 的 work），宽的建筑玩家会走到另一边接着盖。
 * 每块 [x, y, 材质, 样子]：x 往右、y 往上（0 是地面上第一格）；材质 '*' 用这座建筑抽到的材质；
 * 样子：glass 玻璃、portal 传送门、water 水、crop 小麦、fence 栅栏、lamp 萤石灯、fire 篝火、pumpkin 南瓜头、wool 羊毛、door 门
 */
(function () {
  const { hash, M } = A.sceneKit;
  const P = A.Scene.prototype;
  const C = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

  const row = (y, x0, x1, mat = '*', kind) => { const out = []; for (let x = x0; x <= x1; x++) out.push([x, y, mat, kind]); return out; };
  const col = (x, y0, y1, mat = '*', kind) => { const out = []; for (let y = y0; y <= y1; y++) out.push([x, y, mat, kind]); return out; };

  const PLANS = [
    { name: 'arch', w: 3, weight: 12, blocks: [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]] },
    { name: 'lamp', w: 3, weight: 10, blocks: [[1, 0], [1, 1], [1, 2], [1, 3], [0, 3], [2, 3], [1, 4, 'glowstone', 'lamp']] },
    { name: 'wall', w: 3, weight: 8, blocks: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] },
    { name: 'tower', w: 3, weight: 8, blocks: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1], [1, 2]] },
    {
      // 小木屋：圆石地基、木板墙、中间的门、两扇玻璃窗、三层的屋顶
      name: 'cottage', w: 5, weight: 9, mats: ['planks', 'darkPlanks', 'spruce'],
      blocks: [...row(0, 0, 4, 'cobble').filter(([x]) => x !== 2), [2, 0, 'darkPlanks', 'door'], [0, 1], [1, 1, 'glass', 'glass'], [2, 1, 'darkPlanks', 'door'], [3, 1, 'glass', 'glass'], [4, 1],
        ...row(2, 0, 4), ...row(3, -1, 5, 'log'), ...row(4, 0, 4, 'log'), ...row(5, 1, 3, 'log'), [2, 6, 'cobble']],
    },
    {
      // 瞭望塔：两根原木柱、顶上一圈平台和栅栏
      name: 'watch', w: 3, weight: 6, mats: ['planks', 'spruce'],
      blocks: [...col(0, 0, 4, 'log'), ...col(2, 0, 4, 'log'), [1, 2], ...row(5, -1, 3), [-1, 6, '*', 'fence'], [3, 6, '*', 'fence'], [1, 6, 'glowstone', 'lamp']],
    },
    {
      // 水井：圆石井沿、中间是水，两根栅栏撑着顶
      name: 'well', w: 3, weight: 7,
      blocks: [[0, 0, 'cobble'], [1, 0, 'cobble', 'water'], [2, 0, 'cobble'], [0, 1, 'planks', 'fence'], [2, 1, 'planks', 'fence'], [0, 2, 'planks', 'fence'], [2, 2, 'planks', 'fence'], ...row(3, 0, 2, 'cobble')],
    },
    {
      // 麦田：两头栅栏，中间一排慢慢长高的小麦
      name: 'farm', w: 5, weight: 7,
      blocks: [[0, 0, 'planks', 'fence'], [1, 0, 'dirt', 'crop'], [2, 0, 'dirt', 'crop'], [3, 0, 'dirt', 'crop'], [4, 0, 'planks', 'fence']],
    },
    { name: 'fire', w: 1, weight: 6, blocks: [[0, 0, 'log', 'fire']] },
    { name: 'flag', w: 3, weight: 5, blocks: [...col(0, 0, 4, 'planks', 'fence'), [1, 4, 'wool', 'wool'], [2, 4, 'wool', 'wool'], [1, 3, 'wool', 'wool'], [2, 3, 'wool', 'wool']] },
    {
      // 下界传送门：黑曜石框，最后点亮
      name: 'portal', w: 4, weight: 3, over: true,
      blocks: [...row(0, 0, 3, 'obsidian'), ...col(0, 1, 3, 'obsidian'), ...col(3, 1, 3, 'obsidian'), ...row(4, 0, 3, 'obsidian'),
        [1, 1, 'obsidian', 'portal'], [2, 1, 'obsidian', 'portal'], [1, 2, 'obsidian', 'portal'], [2, 2, 'obsidian', 'portal'], [1, 3, 'obsidian', 'portal'], [2, 3, 'obsidian', 'portal']],
    },
    { name: 'golem', w: 1, weight: 3, snowy: 8, blocks: [[0, 0, 'snow'], [0, 1, 'snow'], [0, 2, 'snow', 'pumpkin']] },
    {
      // 像素爱心（红色羊毛）
      name: 'heart', w: 5, weight: 2,
      blocks: [[2, 0], [1, 1], [2, 1], [3, 1], ...row(2, 0, 4), [0, 3], [1, 3], [3, 3], [4, 3]].map(([x, y]) => [x, y, 'wool', 'wool']), color: [210, 40, 50],
    },
    // ───── 1.7.3 大一些的建筑（多点类型、大一点规模）─────
    {
      // 两层小楼：7 宽，原木框、两层窗户、楼层之间一圈横梁、四层屋顶 + 烟囱
      name: 'house2', w: 7, weight: 6, mats: ['planks', 'spruce', 'birchPlanks'],
      blocks: [...row(0, 0, 6, 'cobble').filter(([x]) => x !== 3), [3, 0, 'darkPlanks', 'door'],
        [0, 1, 'log'], [1, 1], [2, 1, 'glass', 'glass'], [3, 1, 'darkPlanks', 'door'], [4, 1, 'glass', 'glass'], [5, 1], [6, 1, 'log'],
        [0, 2, 'log'], ...row(2, 1, 5), [6, 2, 'log'], ...row(3, -1, 7, 'log'),
        [0, 4, 'log'], [1, 4], [2, 4, 'glass', 'glass'], [3, 4], [4, 4, 'glass', 'glass'], [5, 4], [6, 4, 'log'],
        [0, 5, 'log'], ...row(5, 1, 5), [6, 5, 'log'],
        ...row(6, -1, 7, 'darkPlanks'), ...row(7, 0, 6, 'darkPlanks'), ...row(8, 1, 5, 'darkPlanks'), ...row(9, 2, 4, 'darkPlanks'), [5, 9, 'cobble'], [5, 10, 'cobble']],
    },
    {
      // 灯塔：红白相间的塔身，顶上平台、栏杆和一盏灯
      name: 'lighthouse', w: 3, weight: 3, color: [200, 50, 50],
      blocks: [...[0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((y) => row(y, 0, 2, y % 3 === 2 ? 'wool' : 'stoneBricks', y % 3 === 2 ? 'wool' : undefined)),
        ...row(9, -1, 3, 'planks'), [-1, 10, 'planks', 'fence'], [1, 10, 'glowstone', 'lamp'], [3, 10, 'planks', 'fence'], ...row(11, 0, 2, 'darkPlanks'), [1, 12, 'darkPlanks']],
    },
    {
      // 城门：两座带垛口的角楼，中间一段城墙和木门，墙头挂一面旗
      name: 'castle', w: 9, weight: 3,
      blocks: [...[0, 1, 2, 3, 4, 5, 6].flatMap((y) => [[0, y, 'stoneBricks'], [1, y, 'stoneBricks'], [7, y, 'stoneBricks'], [8, y, 'stoneBricks']]),
        ...[0, 1, 2, 3].flatMap((y) => row(y, 2, 6, 'cobble').filter(([x]) => !(x === 4 && y < 2))), [4, 0, 'darkPlanks', 'door'], [4, 1, 'darkPlanks', 'door'],
        [2, 4, 'cobble'], [4, 4, 'cobble'], [6, 4, 'cobble'], [0, 7, 'stoneBricks'], [8, 7, 'stoneBricks'], [4, 5, 'planks', 'fence'], [4, 6, 'wool', 'wool'], [5, 6, 'wool', 'wool']],
    },
    {
      // 谷仓：深色木板墙、原木角柱、两格宽的大门、尖顶
      name: 'barn', w: 7, weight: 4,
      blocks: [...[0, 1, 2, 3].flatMap((y) => [[0, y, 'log'], ...row(y, 1, 5, 'darkPlanks').filter(([x]) => !((x === 3 || x === 4) && y < 3)), [6, y, 'log']]),
        [3, 0, 'spruce', 'door'], [4, 0, 'spruce', 'door'], [3, 1, 'spruce', 'door'], [4, 1, 'spruce', 'door'], [3, 2, 'spruce', 'door'], [4, 2, 'spruce', 'door'],
        ...row(4, -1, 7, 'log'), ...row(5, 0, 6, 'darkPlanks'), ...row(6, 1, 5, 'darkPlanks'), ...row(7, 2, 4, 'darkPlanks'), [3, 8, 'darkPlanks']],
    },
    {
      // 凉亭：四根栅栏柱撑起的屋顶，下面挂一盏灯
      name: 'pavilion', w: 5, weight: 4, mats: ['planks', 'spruce', 'darkPlanks'],
      blocks: [...col(0, 0, 2, '*', 'fence'), ...col(4, 0, 2, '*', 'fence'), [2, 2, 'glowstone', 'lamp'], ...row(3, -1, 5), ...row(4, 0, 4), ...row(5, 1, 3)],
    },
  ];
  const MATS = ['cobble', 'planks', 'stone', 'darkPlanks'];
  const WOOL = [[230, 230, 230], [220, 60, 60], [60, 110, 220], [240, 200, 50], [90, 180, 70], [170, 70, 200]];

  /** 抽一种建筑（按权重；传送门只在主世界；雪原多一些雪傀儡） */
  P.buildPlan = function (r) {
    const list = PLANS.filter((p) => !p.over || this.dim === 'over');
    const wt = (p) => (this.sceneId === 'snowy' && p.snowy ? p.snowy : p.weight);
    let roll = r() * list.reduce((a, p) => a + wt(p), 0);
    for (const p of list) { roll -= wt(p); if (roll <= 0) return p; }
    return list[0];
  };

  /** 在视野里找一块 w 格宽的平地；找不到返回 null */
  P.buildSite = function (w, r) {
    const B = this.B;
    for (let tries = 0; tries < 20; tries++) {
      const c = Math.floor(this.cam.x / B) + 4 + Math.floor(r() * Math.max(1, this.W / B - 8 - w));
      const hs = [];
      for (let k = -1; k <= w; k++) hs.push(this.heights[c + k]);
      const inner = hs.slice(1, -1);
      // 3 格以内的要完全平；宽的允许高低差一格、7 格以上两格（地基嵌进坡里），不然大建筑在起伏的地上几乎找不到地方
      if (inner.some((h) => h == null) || Math.max(...inner) - Math.min(...inner) > (w > 6 ? 2 : w > 3 ? 1 : 0) || Math.max(...inner) >= this.sea - 1) continue;
      if (this.trees.some((t) => t.col >= c - 3 && t.col <= c + w + 2) || this.houses.some((h) => h.col < c + w + 6 && h.col + (h.w || 5) > c - 6)) continue;
      // 两个建筑叠在一起会像错位的房子
      if (this.builds.some((b) => b.col < c + w + 3 && b.col + (b.w || 3) + 3 > c) || this.structsIn(c - 2, c + w + 1).some((s) => s.surface)) continue;
      return c;
    }
    return null;
  };

  /** 新建一座：先抽种类，宽的找不到地方就换成 3 格宽的小件 */
  P.newBuild = function (r) {
    let plan = this.buildPlan(r);
    let c = this.buildSite(plan.w, r);
    if (c == null && plan.w > 3) { plan = PLANS[Math.floor(r() * 4)]; c = this.buildSite(plan.w, r); }
    if (c == null) return null;
    const mats = plan.mats || MATS;
    let top = 0;
    for (let k = 0; k < plan.w; k++) top = Math.max(top, this.heights[c + k]); // 低的那边是地面
    return { col: c, top, w: plan.w, kind: plan.name, blocks: [], mat: mats[Math.floor(r() * mats.length)], plan: plan.blocks, color: plan.color || WOOL[Math.floor(r() * WOOL.length)] };
  };

  /** 视野附近有几座（世界能左右移动，远处的不算） */
  P.nearBuilds = function () {
    const c0 = Math.floor(this.cam.x / this.B) - 10; const c1 = c0 + Math.ceil(this.W / this.B) + 20;
    return this.builds.filter((b) => b.col + (b.w || 3) >= c0 && b.col <= c1).length;
  };

  /** 这一块用的材质（M 里的调色板） */
  const matOf = (b, bl) => M[bl.m && bl.m !== '*' ? bl.m : b.mat] || M.planks;

  /** 世界坐标上是不是玩家盖的某一块：返回 { pal, type }（type 是敲击声的类型，按方块的样子定；null 就按材质，sceneinteract.knock） */
  const KNOCK = { glass: 'glass', portal: 'glass', lamp: 'glass', wool: 'wool', fence: 'wood', door: 'wood', fire: 'wood', pumpkin: 'wood', crop: 'grass', water: 'stone' };
  P.buildAt = function (wx, wy) {
    const B = this.B;
    const c = Math.floor(wx / B); const r = Math.floor(wy / B);
    for (const b of this.builds) {
      const bl = b.blocks.find((x) => b.col + x.x === c && b.top - x.y - 1 === r);
      if (bl) return { pal: bl.k === 'wool' ? null : matOf(b, bl), type: KNOCK[bl.k] || null };
    }
    return null;
  };
  /** 放下一块时冒的碎屑颜色 */
  P.buildPuffColor = function (b, bl) {
    if (bl.k === 'wool') return b.color;
    if (bl.k === 'glass') return [190, 220, 240];
    return this.tint(matOf(b, bl)[0]);
  };

  const GLASS = C('#bcd8ea'); const FRAME = C('#e8f4fc');
  const WATER = C('#3a6ed8'); const WATER2 = C('#5a8ef0');
  const FENCE = C('#8a6a40'); const FENCE2 = C('#6a5030');
  const CROP = [C('#4a9a2a'), C('#7ab83a'), C('#c8b040'), C('#e0c860')];
  const PUMP = C('#e08a20'); const PUMP2 = C('#c06a10'); const FACE = C('#3a2408');

  P.drawBuild = function (b, ox, oy, now) {
    const { B, ctx } = this;
    for (const bl of b.blocks) {
      const age = Math.min(1, (now - bl.t) / 200);
      const bx = (b.col + bl.x) * B + ox;
      const by = (b.top - bl.y - 1) * B + oy;
      const px1 = (x, y, c, glow) => { ctx.fillStyle = this.color(c, glow); ctx.fillRect(bx + x, by + y, 1, 1); };
      // 方块纹理按建筑里的位置定（和地形一样，拖动视角、重画都不会变）
      const tex = (pal, glow, k = 1) => {
        for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) px1(px, py, pal[Math.floor(hash(px + bl.x * 4 + b.col, py + bl.y * 4, 9) * pal.length)].map((v) => v * k), glow);
      };
      ctx.globalAlpha = age;
      const k = bl.k;
      if (k === 'glass') {
        ctx.fillStyle = this.color(GLASS); ctx.globalAlpha = age * 0.55; ctx.fillRect(bx, by, B, B);
        ctx.globalAlpha = age;
        for (let i = 0; i < B; i++) { px1(i, 0, FRAME); px1(i, B - 1, FRAME); px1(0, i, FRAME); px1(B - 1, i, FRAME); }
        px1(1, 1, [255, 255, 255]);
      } else if (k === 'portal') {
        // 传送门在框架合上之后才点亮：每格每帧按位置和时间换紫色深浅
        const lit = b.blocks.length >= b.plan.length;
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
          const w = this.noFlash ? 0.5 : (Math.sin(now / 260 + (bl.x * B + x) * 0.9 + (bl.y * B + y) * 1.3) + 1) / 2;
          px1(x, y, lit ? [110 + w * 80, 30 + w * 40, 200 + w * 50] : [20, 14, 30], lit);
        }
        if (lit && !this.noFlash && this.rnd() < 0.01 * this.fxK) this.parts.push({ x: bx - ox + 2, y: by - oy + 2, vx: (this.rnd() - 0.5) * 6, vy: -4, life: 900, c: [190, 110, 255], glow: true });
      } else if (k === 'water') {
        tex(matOf(b, bl));
        for (let x = 1; x < B - 1; x++) for (let y = 1; y < B; y++) px1(x, y, (x + Math.floor(now / 400)) % 3 ? WATER : WATER2);
      } else if (k === 'crop') {
        // 小麦：放下以后 20 秒长满，绿 → 金
        const g = Math.min(1, (now - bl.t) / 20000);
        const h = 1 + Math.round(g * 3);
        const c = CROP[Math.min(3, Math.floor(g * 4))];
        for (const x of [0, 2]) for (let y = 0; y < h; y++) px1(x + (bl.x & 1), B - 1 - y, c);
        px1(1, B - 1, CROP[0]);
      } else if (k === 'fence') {
        for (let y = 0; y < B; y++) { px1(1, y, FENCE); px1(2, y, FENCE2); }
        px1(0, 1, FENCE); px1(3, 1, FENCE);
      } else if (k === 'fire') {
        // 篝火：两根交叉的原木，上面跳动的火苗，偶尔冒一缕烟
        const log = matOf(b, bl);
        for (let x = 0; x < B; x++) { px1(x, B - 1, log[x % log.length]); }
        px1(0, B - 2, log[0]); px1(3, B - 2, log[1]);
        const f = this.noFlash ? 0 : Math.floor(now / 110) % 3;
        px1(1, B - 2, [255, 150, 40], true); px1(2, B - 2, [255, 200, 70], true);
        px1(1 + (f === 1 ? 1 : 0), B - 3, [255, 220, 110], true);
        if (f === 2) px1(2, B - 4, [255, 160, 50], true);
        if (this.rnd() < 0.02 * this.fxK) this.parts.push({ x: bx - ox + 2, y: by - oy, vx: (this.rnd() - 0.5) * 2, vy: -5, g: -2, sway: 2, ph: this.rnd() * 6, life: 2200, c: [150, 150, 150] });
      } else if (k === 'pumpkin') {
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) px1(x, y, (x === 0 || x === B - 1) ? PUMP2 : PUMP);
        const night = this.period === 'night';
        px1(2, 1, night ? [255, 210, 80] : FACE, night); px1(3, 1, night ? [255, 210, 80] : FACE, night); px1(2, 3, FACE); px1(3, 3, FACE);
      } else if (k === 'wool') {
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) px1(x, y, b.color.map((v) => v * (0.88 + 0.12 * hash(bx - ox + x, by - oy + y, 5))));
      } else if (k === 'lamp') {
        tex(M.glowstone, true);
      } else if (k === 'door') {
        tex(matOf(b, bl), false, 0.72); // 门比墙暗一些（谷仓的大门和墙同色时看不出来）
        if (bl.y === 0) px1(B - 1, 0, [200, 180, 90]);
      } else {
        // 普通方块：纹理按位置定（和地形一样，重画不会变）
        tex(matOf(b, bl));
      }
      ctx.globalAlpha = 1;
    }
  };
})();
