'use strict';
/**
 * 主页动态背景：下界要塞（1.7.0）。以前下界只有背景层里一段段的桥，看不出是要塞。
 * 现在是地面层里的一整座：
 * - 高过两边地面的长桥（下界砖桥面、栏杆，每 9 列一对桥墩一直伸到地面，桥墩之间有拱），
 * - 中间一座两层的主楼：剖开能看到里面（一楼地狱疣长在灵魂沙上、箱子，二楼烈焰人刷怪笼冒火），
 *   窗户是下界砖栅栏，屋顶有垛口，中间再起一座塔
 * - 烈焰人和凋灵骷髅守着（sceneland.js 的守卫：只在附近走动）
 * 生成：scenenether.js 的 GEN 按区域抽，一个区域最多一座；打开那一屏也可能有
 */
(function () {
  const { hash, pal, M, SPRITES, H, REG, DECO, FX } = A.sceneKit;
  const P = A.Scene.prototype;

  Object.assign(M, {
    soulSand: pal('#5a4232', '#4e392b', '#644a38'),
  });

  Object.assign(SPRITES, {
    // 凋灵骷髅：比普通骷髅高一格、骨头是黑的，拿石剑
    witherSkeleton: H(['HH.', 'SE.', 'TT.', 'TA.', 'TAs', 'TAs', 'TT.', 'TT.', 'TT.'], { H: '#2a2a2a', S: '#333333', E: '#0a0a0a', T: '#252525', A: '#303030', s: '#9a9a9a' }, { hostile: true }),
  });

  const FW = 46; // 整座要塞的宽度（列）
  const K0 = 14; const K1 = 31; // 主楼左右墙
  const T0 = K0 + 6; const T1 = K0 + 11; // 塔

  /** at：最左一列。返回结构，或者 null（下面的地太高、一半以上是空的） */
  P.makeFortress = function (at, rnd) {
    const hs = [];
    for (let x = 0; x < FW; x++) hs.push(this.colHeight(at + x));
    const ground = hs.filter((v) => v < 900);
    if (ground.length < FW / 2) return null;
    const hi = Math.min(...ground); // 最高的地面（行号越小越高）
    const deck = hi - 4 - Math.floor(rnd() * 3); // 桥面那一行
    if (deck - this.lift < 22) return null; // 太高了塔会顶到天花板（按打开时的窗口算，拉窗口重建时同一座要塞还在，rc6）
    const s = this.wseed;
    const brick = { mat: M.netherbrick, deco: 'nbrick' };
    const back = { mat: M.netherbrick, cave: true }; // 主楼里面的背景墙
    const lowest = Math.max(...ground);
    return {
      type: 'fortress', surface: true, c0: at, c1: at + FW - 1, r0: deck - 18, r1: Math.max(deck + 2, lowest + 1),
      guards: ['blaze', 'witherSkeleton', 'blaze', 'witherSkeleton'],
      cell(c, r, top) {
        const x = c - at; const y = deck - r;
        if (x < 0 || x >= FW) return undefined;
        // 桥下：桥墩一直伸到地面，桥墩之间是拱
        if (y < 0) {
          const m = x % 9;
          const leg = m <= 1 || x >= FW - 2;
          if (leg) return top < 900 && r >= top ? undefined : (hash(c, y, s + 401) < 0.04 ? undefined : brick); // y 相对桥面
          if (y === -1 && (m === 2 || m === 8)) return brick;
          return undefined;
        }
        if (y === 0) {
          if (x >= K0 + 2 && x <= K0 + 5) return { mat: M.soulSand }; // 一楼种地狱疣的灵魂沙
          return brick;
        }
        const inKeep = x >= K0 && x <= K1;
        if (!inKeep) {
          // 两边的桥：栏杆，桥头残了几格
          if (y === 1 && (x > 1 && x < FW - 2) && hash(c, y, s + 402) > 0.12) return { deco: 'nfence' };
          return undefined;
        }
        const wall = x === K0 || x === K1;
        if (y <= 10) {
          if (wall) return y <= 3 ? { ...back, deco: 'nfence' } : brick; // 门洞（能走过去）
          if (y === 5 || y === 10) return x === K1 - 3 && y === 5 ? { ...back, deco: 'nladder' } : brick; // 二楼地板、屋顶
          // 一楼：地狱疣、箱子；二楼：烈焰人刷怪笼
          if (y === 1 && x >= K0 + 2 && x <= K0 + 5) return { ...back, deco: 'wart' };
          if (y === 1 && x === K1 - 2) return { ...back, deco: 'chest' };
          if (y === 6 && x === K0 + 9) return { mat: M.netherbrick, cave: true, deco: 'spawner', fx: 'spawner' };
          if (y < 5 && x === K1 - 3) return { ...back, deco: 'nladder' };
          // 窗户：每 4 列一扇两格高
          if ((x - K0) % 4 === 2 && (y === 2 || y === 3 || y === 7 || y === 8)) return { ...back, deco: 'nwin' };
          return back;
        }
        // 屋顶以上：垛口和塔
        const inTower = x >= T0 && x <= T1;
        if (y === 11 && !inTower) return x % 2 === 0 ? brick : undefined;
        if (!inTower) return undefined;
        if (y <= 15) {
          if (x === T0 || x === T1) return brick;
          return y === 13 && (x === T0 + 2 || x === T0 + 3) ? { ...back, deco: 'nwin' } : back;
        }
        if (y === 16) return brick;
        if (y === 17) return x % 2 === 0 ? brick : undefined;
        return undefined;
      },
    };
  };

  /** 一个区域里放一座要塞的位置（不越过区域边界，免得和隔壁区域的结构叠在一起） */
  P.fortressAt = function (reg, rnd) {
    if (reg === 0) return 4;
    return reg * REG + 2 + Math.floor(rnd() * (REG - FW - 4));
  };

  // ───────────── 绘制（画进块里） ─────────────

  const C = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const MORTAR = C('#1a0a0b'); const FENCE = C('#3a1c1e'); const FENCE2 = C('#4a2628');
  /** 下界砖的砖缝 */
  DECO.nbrick = (dot, cell, c, r) => {
    for (let x = 0; x < 4; x++) dot(x, 0, MORTAR);
    const o = (r & 1) * 2;
    dot(o, 1, MORTAR); dot(o, 2, MORTAR); dot(o, 3, MORTAR);
  };
  /** 下界砖栅栏 */
  DECO.nfence = (dot) => { for (let y = 0; y < 4; y++) { dot(1, y, FENCE2); dot(2, y, FENCE); } dot(0, 1, FENCE); dot(3, 1, FENCE); };
  /** 窗户：暗的洞口 + 栅栏，透出一点岩浆的光 */
  DECO.nwin = (dot) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) dot(x, y, C('#120607'));
    dot(0, 3, C('#5a1a08'), true); dot(3, 3, C('#5a1a08'), true);
    for (let y = 0; y < 4; y++) dot(1, y, FENCE2), dot(2, y, FENCE);
  };
  DECO.nladder = (dot) => { for (let y = 0; y < 4; y++) { dot(0, y, FENCE2); dot(3, y, FENCE2); } dot(1, 1, FENCE); dot(2, 1, FENCE); dot(1, 3, FENCE); dot(2, 3, FENCE); };
  /** 地狱疣：长在灵魂沙上的红色小芽 */
  DECO.wart = (dot, cell, c) => {
    const h = 1 + Math.floor(hash(c, 0, 77) * 3);
    for (let y = 3; y > 3 - h; y--) { dot(1, y, C('#7a1a1e')); dot(2, y, C('#8e2026')); }
    dot(0, 4 - h, C('#a02a2e')); dot(3, 4 - h, C('#a02a2e'));
  };
  /** 刷怪笼：黑色铁笼，里面一点火 */
  DECO.spawner = (dot) => {
    for (let k = 0; k < 4; k++) { dot(k, 0, C('#1c2430')); dot(k, 3, C('#1c2430')); dot(0, k, C('#1c2430')); dot(3, k, C('#1c2430')); }
    dot(1, 2, C('#ff8a20'), true); dot(2, 1, C('#ffd060'), true); dot(2, 2, C('#ff6a10'), true);
  };
  /** 刷怪笼冒的小火苗 */
  FX.spawner = function (x, y) {
    if (this.rnd() < 0.03 * this.fxK) this.parts.push({ x: x - this.landX + 1 + this.rnd() * 2, y: y - this.landY + 1, vx: (this.rnd() - 0.5) * 3, vy: -6, g: -4, life: 700, c: [255, 150 + Math.floor(this.rnd() * 80), 40], glow: !this.noFlash });
  };
})();
