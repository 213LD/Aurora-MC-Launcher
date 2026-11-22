'use strict';
/**
 * 主页动态背景：深暗之域和远古城市（rc1 之前补上的）。挂在 A.Scene.prototype 上。
 * 照原版：远古城市在深板岩层底部、深暗之域里（这里只放在有山的场景底下，海洋、蘑菇岛没有）。
 * - 结构：一大块深板岩砖平台，中间是强化深板岩的「门」，两边深板岩砖小屋（灵魂灯笼、箱子、蜡烛），地上铺着灰地毯
 * - 幽匿块成片长在地面，幽匿感测体会冒出青色的光点，幽匿尖啸体；洞顶挂着幽匿脉络和灵魂灯笼
 * - 原版深暗之域里不刷任何生物：普通的洞穴生物不生成在城市范围里；只有很少的时候监守者会出来走一走
 * 由 scenecave.js 的地下结构生成器调用 makeAncientCity；生成规则见那里
 */
(function () {
  const { hash, pal, M, SPRITES, H, DEEP, DECO, FX } = A.sceneKit;
  const P = A.Scene.prototype;

  Object.assign(M, {
    // 地下这么深的地方整体会压暗一半左右，颜色比原版亮一些才认得出门和小屋
    sculk: pal('#12404a', '#0e3440', '#175058'),
    reinforced: pal('#7a8a86', '#6b7b77', '#8a9a96'),
    deepBrick: pal('#6c6c72', '#626268', '#77777d'),
    deepTile: pal('#5c5c62', '#54545a', '#66666c'),
  });

  // 监守者：深青色，胸口和头上的「角」发青光（原版没有眼睛）
  Object.assign(SPRITES, {
    warden: H([
      'A....A', '.HHHH.', '.HHHH.', '.HHHH.', 'BBBBBB', 'BCBBCB', 'BBCCBB', 'BBBBBB', '.BBBB.', '.L..L.', '.L..L.', '.L..L.',
    ], { A: '#2ad0d8', H: '#123a40', B: '#173f45', C: '#56e8f0', L: '#0f2e33' }, { hostile: true, emissive: 'AC' }),
  });

  /**
   * 远古城市（宽 40 列，地面在 fr，往上 13 格是空的大厅）。x0 是最左边一列
   */
  P.makeAncientCity = function (x0, rnd) {
    if (this.BOT == null) return null;
    const lo = this.baseRow + DEEP + 16; const hi = this.BOT - 14;
    if (hi <= lo) return null;
    const fr = lo + Math.floor(rnd() * (hi - lo));
    const W = 40;
    const cx = x0 + Math.floor(W / 2);
    const r0 = fr - 14;
    const s = this.wseed;
    const b = this.baseRow; // 随机数用相对基准地面的行号：拉窗口整体挪了以后还是同一个样子（rc6）
    // 两边的小屋（门朝着中间的「门」）
    const houses = [{ h0: x0 + 2, w: 7, h: 5, door: 'r' }, { h0: x0 + W - 9, w: 7, h: 5, door: 'l' }];
    const self = this;
    const air = (deco, fx) => { const cell = { mat: M.deepslate, cave: true, deep: true }; if (deco) cell.deco = deco; if (fx) cell.fx = fx; return cell; };
    const inGate = (c, r) => {
      const legs = (c >= cx - 6 && c <= cx - 5) || (c >= cx + 5 && c <= cx + 6);
      if (legs && r >= fr - 9 && r <= fr - 1) return true;
      if (r >= fr - 11 && r <= fr - 10 && c >= cx - 6 && c <= cx + 6) return true;
      return r === fr - 12 && c >= cx - 4 && c <= cx + 4;
    };
    return {
      type: 'ancient', ancient: true, c0: x0, c1: x0 + W - 1, r0, r1: fr + 1, fr,
      cell(c, r) {
        if (r === r0) return undefined; // 洞顶照常是石头
        if (r === fr + 1) return { mat: M.deepBrick };
        if (r === fr) return { mat: hash(c, r - b, s + 701) < 0.35 ? M.sculk : M.deepTile };
        if (inGate(c, r)) return { mat: M.reinforced };
        // 门两边的台阶
        if (r === fr - 1 && ((c >= cx - 8 && c <= cx - 7) || (c >= cx + 7 && c <= cx + 8))) return { mat: M.deepBrick };
        for (const h of houses) {
          const c1 = h.h0 + h.w - 1;
          if (c < h.h0 - 1 || c > c1 + 1 || r < fr - h.h - 1) continue;
          if (r === fr - h.h - 1) return { mat: M.deepTile }; // 屋顶（比墙宽一格）
          if (c === h.h0 - 1 || c === c1 + 1) break;
          const wall = c === h.h0 || c === c1;
          const doorSide = (h.door === 'r' && c === c1) || (h.door === 'l' && c === h.h0);
          if (wall && !(doorSide && r >= fr - 2)) return { mat: M.deepBrick };
          if (r === fr - h.h && c === h.h0 + Math.floor(h.w / 2)) return air('soulLantern', 'soul');
          if (r === fr - 1 && c === h.h0 + 1) return air('chest');
          if (r === fr - 1 && c === c1 - 1 && !doorSide) return air('candle', 'candle');
          return air(r === fr - 1 && hash(c, r - b, s + 702) < 0.5 ? 'carpet' : null);
        }
        // 大厅
        if (r === fr - 1) {
          const h = hash(c, r - b, s + 703);
          if (Math.abs(c - cx) <= 3 && h < 0.7) return air('carpet');
          // 感测体、尖啸体隔几格放一个（按哈希随机放时有的城市一个都没有）
          if ((c - x0) % 13 === 9) return air('shrieker');
          if ((c - x0) % 6 === 4) return air('sensor', 'sculk');
          if (h < 0.4) return air('sculkFloor');
          return air();
        }
        if (r === r0 + 1) {
          const h = hash(c, r - b, s + 704);
          if (h < 0.04) return air('soulLantern', 'soul');
          if (h < 0.3) return air('veinsTop');
        }
        return air();
      },
    };
  };

  /** 这一格在远古城市里吗（城市里不刷普通生物） */
  P.inAncientCity = function (c, r) {
    return this.structsIn(c, c).some((s) => s.ancient && r >= s.r0 && r <= s.r1);
  };

  // ───────────── 画进块里的小装饰 ─────────────
  const C = (x) => [parseInt(x.slice(1, 3), 16), parseInt(x.slice(3, 5), 16), parseInt(x.slice(5, 7), 16)];
  const SCULK = C('#0d2a30'); const SCULK2 = C('#123c44'); const CYAN = C('#3ee0e8'); const BONE = C('#d8d2c0');
  const CHAIN = C('#4a4a52'); const SOUL = C('#6af0ff'); const WOOLG = C('#5a5a60'); const WOOLG2 = C('#4c4c52');
  DECO.sculkFloor = (dot, cell, c) => { for (let x = 0; x < 4; x++) dot(x, 3, x % 2 ? SCULK2 : SCULK); if (c % 3 === 0) dot(1 + (c & 1), 3, CYAN, true); };
  DECO.sensor = (dot) => {
    for (let x = 0; x < 4; x++) { dot(x, 3, SCULK); dot(x, 2, x === 0 || x === 3 ? SCULK2 : SCULK); }
    dot(0, 1, CYAN, true); dot(3, 1, CYAN, true); dot(0, 0, CYAN, true); dot(3, 0, CYAN, true);
  };
  DECO.shrieker = (dot) => { for (let x = 0; x < 4; x++) { dot(x, 3, SCULK); dot(x, 2, SCULK2); dot(x, 1, x === 0 || x === 3 ? BONE : SCULK); } dot(1, 1, CYAN, true); };
  DECO.veinsTop = (dot, cell, c) => { dot(c % 4, 0, SCULK2); dot((c + 2) % 4, 0, SCULK); if (c % 5 === 0) dot(1, 0, CYAN, true); };
  DECO.soulLantern = (dot) => { dot(1, 0, CHAIN); dot(1, 1, CHAIN); dot(0, 2, CHAIN); dot(2, 2, CHAIN); dot(1, 2, SOUL, true); dot(0, 3, CHAIN); dot(1, 3, SOUL, true); dot(2, 3, CHAIN); };
  DECO.candle = (dot) => { dot(1, 1, C('#ffd27a'), true); dot(1, 2, C('#e8e2d0')); dot(1, 3, C('#e8e2d0')); };
  DECO.carpet = (dot) => { for (let x = 0; x < 4; x++) dot(x, 3, x % 2 ? WOOLG2 : WOOLG); };

  /** 幽匿感测体偶尔冒出青色的光点 */
  FX.sculk = function (x, y) {
    if (!this.noFlash && this.rnd() < 0.01 * this.fxK) this.parts.push({ x: x - this.landX + 1 + this.rnd() * 2, y: y - this.landY + 1, vx: 0, vy: -4, life: 900, c: [80, 230, 240], glow: true });
  };
  /** 灵魂灯笼、蜡烛：微微闪一下 */
  FX.soul = function (x, y) {
    if (this.rnd() < 0.004 * this.fxK) this.parts.push({ x: x - this.landX + 2, y: y - this.landY + 2, vx: 0, vy: -2, life: 700, c: [110, 240, 255], glow: true });
  };
  FX.candle = function (x, y) {
    if (this.rnd() < 0.004 * this.fxK) this.parts.push({ x: x - this.landX + 2, y: y - this.landY, vx: 0, vy: -3, life: 500, c: [255, 210, 120], glow: true });
  };

  /**
   * 画面里有远古城市、开着敌对生物时，很少的时候监守者会出来走一走（同时最多一个）。scenecave.js 的 caveSpawn 调用，返回 true 表示生成了
   */
  P.wardenSpawn = function (now) {
    const o = this.opts;
    if (!o.monsters || o.peaceful || this.ents.some((e) => e.kind === 'warden')) return false;
    const B = this.B;
    const c0 = Math.floor(this.cam.x / B); const c1 = Math.floor((this.cam.x + this.W) / B);
    const r0 = Math.floor(this.cam.y / B); const r1 = Math.floor((this.cam.y + this.H) / B);
    const city = this.structsIn(c0, c1).find((s) => s.ancient && s.fr >= r0 && s.fr <= r1);
    if (!city || this.rnd() > 0.06) return false;
    const c = Math.max(city.c0 + 1, Math.min(city.c1 - 1, c0 + 2 + Math.floor(this.rnd() * Math.max(1, c1 - c0 - 4))));
    const e = this.mkEnt('warden', c * B + 1, city.fr * B, now, { cave: true, life: 25000 + this.rnd() * 20000 });
    this.puff(e.x + 2, e.y - 4, [20, 60, 70], 14);
    return true;
  };
})();
