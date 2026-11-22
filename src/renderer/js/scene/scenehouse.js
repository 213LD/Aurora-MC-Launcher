'use strict';
/**
 * 主页背景里玩家的家（1.10.1）：以前只有一种 5 格宽的小木屋，现在每次换场景随机一种——
 * 小木屋约一半，其余是更大的：农舍（7 格）、两层小楼（7 格）、石头基地（9 格，平顶带栏杆和灯笼）。
 * 房子按「蓝图」画：每行一串字符，从上往下，最后一行贴着地面；左右各多一列给屋檐。
 *   W 墙  C 墙角（原木）  R 屋顶  K 烟囱  D 门  G 窗  L 横梁（原木）  S 圆石  F 栅栏  l 灯笼  . 空
 * 材质跟着场景的 house 风格走（橡木 / 云杉 / 砂岩 / 樱花）。门的位置、宽度、高度存在 house 上，
 * 走进走出、插火把、爆炸避让、点击敲击这些都按它算（scene.js / scenetorch.js / sceneinteract.js）
 */
(function () {
  const { hash, rgb, pal, M } = A.sceneKit;
  const P = A.Scene.prototype;

  const KINDS = {
    hut: { weight: 50, rows: [
      '..RRK..',
      '.RRRRR.',
      'RRRRRRR',
      '.CWWWC.',
      '.CDWGC.',
      '.CDWWC.'] },
    cottage: { weight: 18, rows: [
      '...RRRK..',
      '..RRRRK..',
      '.RRRRRRR.',
      'RRRRRRRRR',
      '.CWWWWWC.',
      '.CDWGWGC.',
      '.CDWWWWC.'] },
    twostory: { weight: 16, rows: [
      '...RRRK..',
      '..RRRRK..',
      '.RRRRRRR.',
      'RRRRRRRRR',
      '.CWWWWWC.',
      '.CWGWGWC.',
      '.LLLLLLL.',
      '.CWWWWWC.',
      '.CDWGWGC.',
      '.CDWWWWC.'] },
    base: { weight: 16, rows: [
      '.lFFFFFFFl.',
      'RRRRRRRRRRR',
      '.CWGWWWGWC.',
      '.SDSGSGSSS.',
      '.SDSSSSSSS.'] },
  };

  /** 解析蓝图：宽（不含屋檐）、高、门在第几列、窗户和烟囱的位置 */
  const PLANS = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    const rows = k.rows;
    const hgt = rows.length;
    const gw = rows[0].length;
    const cells = [];
    rows.forEach((line, i) => [...line].forEach((ch, gx) => { if (ch !== '.') cells.push({ ch, gx, up: hgt - i }); }));
    const bottom = rows[hgt - 1];
    PLANS[kind] = {
      kind, gw, hgt, w: gw - 2, cells,
      dc: bottom.indexOf('D') - 1,
      windows: cells.filter((c) => c.ch === 'G'),
      chimney: cells.filter((c) => c.ch === 'K').sort((a, b) => b.up - a.up)[0] || null,
    };
  }

  /**
   * 换场景时随机一种（不跟世界种子走，每次换都可能不同）；地方不够宽时退回小木屋。
   * 同一个场景拉窗口重建时用回同一种（rc6：以前每次重建都重新抽，拉一下窗口房子就换了样子、换了地方）
   */
  P.houseKinds = function () {
    if (this._houseKind && this._houseKind.key === this.camKey) return this._houseKind.kinds;
    const list = Object.entries(KINDS);
    let x = Math.random() * list.reduce((s, [, k]) => s + k.weight, 0);
    let kinds = ['hut'];
    for (const [kind, k] of list) { x -= k.weight; if (x < 0) { kinds = [kind, 'hut']; break; } }
    this._houseKind = { key: this.camKey, kinds };
    return kinds;
  };
  P.housePlan = (kind) => PLANS[kind] || PLANS.hut;

  const MATS = {
    planks: [M.planks, M.log, M.darkPlanks],
    sandstone: [M.sandstone, M.sandstone, M.planks],
    spruce: [M.spruce, M.log, M.darkPlanks],
    cherry: [pal('#ecc0c4', '#e2b2b8'), M.cherryLog, pal('#a8606e', '#9c5664', '#b26a78')],
  };

  /** 房子缓存成图（门开关、亮灯、换时段时重画），烟和窗户光晕每帧画 */
  P.drawHouse = function (h, ox, oy, now) {
    const { B } = this;
    const plan = this.housePlan(h.kind);
    const open = h.door > now;
    const lit = this.period === 'night' || this.period === 'sunset';
    const key = `${this.palV}|${open}|${lit}|${plan.kind}`;
    const x0 = (h.col - 1) * B;
    const g0 = h.ground * B;
    if (!h.cv || h.cvKey !== key) {
      const cv = document.createElement('canvas');
      cv.width = B * plan.gw; cv.height = B * plan.hgt;
      const keep = this.ctx;
      this.ctx = cv.getContext('2d');
      this.drawHouseRaw(h, -x0, cv.height - g0, open, lit);
      this.ctx = keep;
      h.cv = cv; h.cvKey = key;
    }
    this.ctx.drawImage(h.cv, x0 + ox, g0 + oy - h.cv.height);
    const k = plan.chimney;
    if (lit && k && this.rnd() < 0.08) this.parts.push({ x: x0 + k.gx * B + 2, y: g0 - k.up * B - 1, vx: 1 + this.rnd(), vy: -4, life: 2600, c: [160, 160, 170], land: true });
    if (lit) {
      // 窗户的光晕
      this.ctx.fillStyle = 'rgba(255, 210, 110, 0.18)';
      for (const wdw of plan.windows) this.ctx.fillRect(x0 + wdw.gx * B - 2 + ox, g0 - wdw.up * B - 2 + oy, B + 4, B + 4);
    }
  };

  P.drawHouseRaw = function (h, ox, oy, open, lit) {
    const { B } = this;
    const g = this.ctx;
    const plan = this.housePlan(h.kind);
    const [wall, corner, roof] = MATS[h.style] || MATS.planks;
    const x0 = (h.col - 1) * B;
    const g0 = h.ground * B;
    const px1 = (x, y, c, emissive) => { g.fillStyle = emissive ? rgb(c) : this.color(c); g.fillRect(x + ox, y + oy, 1, 1); };
    const BL = (bx, by, palette, shade = 1, emissive = false) => {
      for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) {
        const c = palette[Math.floor(hash(bx + px, by + py, 11) * palette.length)];
        px1(bx + px, by + py, emissive ? c : c.map((v) => v * shade), emissive);
      }
    };
    // 屋顶从下往上一层比一层暗一点
    const roofBase = Math.min(...plan.cells.filter((c) => c.ch === 'R').map((c) => c.up));
    for (const { ch, gx, up } of plan.cells) {
      const bx = x0 + gx * B;
      const by = g0 - up * B;
      if (ch === 'W') BL(bx, by, wall);
      else if (ch === 'C' || ch === 'L') BL(bx, by, corner, ch === 'L' ? 0.9 : 1);
      else if (ch === 'R') BL(bx, by, roof, 1 - (up - roofBase) * 0.05);
      else if (ch === 'K' || ch === 'S') BL(bx, by, M.cobble);
      else if (ch === 'D') BL(bx, by, open ? pal('#2a1a10') : pal('#6e4b24', '#5f4020'));
      else if (ch === 'G') BL(bx, by, lit ? pal('#ffd36b', '#ffc94a') : pal('#a9d6e5', '#b8e0ee'), 1, lit);
      else if (ch === 'F') {
        // 栅栏：中间一根柱子，两道横杆
        for (let py = 0; py < B; py++) { px1(bx + 1, by + py, corner[0]); px1(bx + 2, by + py, corner[1 % corner.length]); }
        for (let px = 0; px < B; px++) { px1(bx + px, by + 1, corner[0]); px1(bx + px, by + 3, corner[0]); }
      } else if (ch === 'l') {
        // 灯笼：一根柱子顶着一盏灯，天黑了发光
        for (let py = 2; py < B; py++) px1(bx + 1, by + py, corner[0]);
        const lamp = lit ? [255, 214, 110] : [120, 110, 90];
        px1(bx + 1, by, [60, 60, 60]); px1(bx + 2, by, [60, 60, 60]);
        px1(bx + 1, by + 1, lamp, lit); px1(bx + 2, by + 1, lamp, lit);
      }
    }
  };
})();
