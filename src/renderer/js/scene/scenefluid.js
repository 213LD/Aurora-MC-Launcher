'use strict';
/**
 * 主页背景的水和岩浆（rc4，试用 rc3 后提的）：
 *
 * 一、按原版（1.18 起）补上的生成规则（以前岩浆只在最底下一层，其余全是水）：
 *   - 最底下几层洞穴里全是岩浆（原版 Y=-55 ~ -63）：和以前一样
 *   - 深板岩层（原版 Y=0 以下）里一部分地下水是岩浆：aquiferLava
 *   - 浅层地下（Y=0 以上）的洞底偶尔积着小岩浆湖：lavaPoolAt
 *   - 地表偶尔有小岩浆湖（原版很少见）：下面的 GEN
 *   - 洞壁上的泉：越深越多是岩浆瀑布（scenecave.js 生成，这里给比例 lavaFallShare）
 *
 * 二、会流：瀑布落地后往两边淌 4 格（岩浆 3 格，原版主世界的数），没碰到崖边就停；
 *   碰到崖边就顺着往下落，落地再淌，最多接力 4 次。地下湖、水塘、岩浆湖旁边有开口的，从开口流出去，规则一样。
 *   流动的水画成薄一层（越远越薄）、往流的方向走的纹理；往下落的按列连成一整段，和洞里的瀑布一样画成一道（rc6）。
 *   水碰到静止的岩浆变黑曜石，岩浆流进水里变圆石（往下落进水里是石头），碰到的地方冒蒸汽。
 *
 * 流动在生成区块时找源头（renderChunk 之后），算好存起来，每帧在画面里的才画；点上去有水声 / 岩浆声（sceneinteract.js）。
 * 算的时候只看世界本身（fluid / solid），不看哪些区块已经生成：同一个世界不管窗口多大、先生成哪块，算出来都一样（rc6）
 */
(function () {
  const { hash, M, REG, DEEP, GEN } = A.sceneKit;
  const P = A.Scene.prototype;
  const RUN = { water: 4, lava: 3 }; // 一次淌几格
  const HOPS = 4; // 落下去再淌，最多接力几次
  const MAX_FALL = 48;
  const MAX_CELLS = 500; // 一处流动最多多少格，免得哪里出错画满屏
  const key = (c, r) => c * 16384 + r;

  // ───────────── 生成 ─────────────

  /** 这一段地下水是不是岩浆：水位在深板岩层里的，四成是岩浆（原版：Y=0 以下的含水层有的是岩浆） */
  P.aquiferLava = function (c) {
    const L = this.waterLevel(c);
    if (L == null || L < this.baseRow + DEEP) return false;
    return hash(Math.floor(c / 40), 15, this.wseed + 415) < 0.4;
  };

  /** 浅层（深板岩以上）洞底的小岩浆湖：一段两头被石头堵住的低洼处（最宽 POOL_W 格）积 1~2 格岩浆，大约一成的低洼有 */
  P.lavaPoolAt = function (c, r) { return this.lavaPoolRun(c, r, 2) === 1; };
  // 往两边找石头最多找 POOL_W + 1 格，超过 POOL_W 宽的不算：这样从这一段里哪一格开始查，找到的两头都一样，
  // 结果和查的先后无关（rc6：以前两边各找 10 格，10~19 格宽的低洼从中间查是岩浆湖、从边上查不是，拉窗口后可能变）
  const POOL_W = 12;
  P.lavaPoolRun = function (c, r, levels) {
    if (this.dim !== 'over' || levels <= 0 || this.BOT == null || r >= this.baseRow + DEEP) return 0;
    const memo = this._lvMemo || (this._lvMemo = new Map());
    const k = (c * 16384 + r) * 4 + levels;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let ok = 0;
    let a = c; let b = c;
    const top = this.colHeight(c);
    if (top < 900 && r - top > 6 && !this.rawSolid(c, r) && this.caveBiome(c, r) !== 'lush') {
      while (a > c - POOL_W - 1 && !this.rawSolid(a, r)) a--;
      while (b < c + POOL_W + 1 && !this.rawSolid(b, r)) b++;
      ok = this.rawSolid(a, r) && this.rawSolid(b, r) && b - a - 1 >= 2 && b - a - 1 <= POOL_W && hash(a, r - this.baseRow, this.wseed + 433) < 0.12 ? 1 : 0;
      for (let x = a + 1; ok && x < b; x++) if (!this.rawSolid(x, r + 1) && this.lavaPoolRun(x, r + 1, levels - 1) !== 1) ok = 0;
      // 和地下水重叠的不算（地下水优先）
      for (let x = a + 1; ok && x < b; x++) if (this.caveWaterAt(x, r)) ok = 0;
    }
    if (memo.size > 200000) memo.clear();
    if (b > a + 1) for (let x = a + 1; x < b; x++) memo.set((x * 16384 + r) * 4 + levels, ok);
    else memo.set(k, ok);
    return ok;
  };

  /** 洞壁上的泉有多少是岩浆：离地面 20 格以内没有，越往下越多，到深板岩层大约一半 */
  P.lavaFallShare = function (r) {
    const d = r - this.baseRow;
    if (d < 20) return 0;
    return Math.min(0.5, ((d - 20) / Math.max(1, DEEP - 20)) * 0.5);
  };

  /** 岩浆层上面的岩浆（sceneworld.lavaAt 调用）：深层岩浆含水层、浅层岩浆湖、地表岩浆湖 */
  P.lavaAbove = function (c, r) {
    const top = this.colHeight(c);
    if (top > 900) return false;
    if (r >= top - 1 && r <= top + 3) {
      const s = this.structCell(this.structsIn(c, c), c, r, top);
      if (s && s.lava) return true;
    }
    if (r <= top) return false;
    if (this.caveWaterAt(c, r) && this.aquiferLava(c)) return true;
    return this.lavaPoolAt(c, r);
  };

  /** 地表的小岩浆湖（原版很少见）：平地上一个 3~5 格宽、1~2 格深的坑，灌满岩浆；打开那一屏和小屋旁边没有 */
  // 用自己的散列取随机数，不动 structsOf 的 rnd：不然后面的前哨站、废弃传送门、神殿全换了位置
  GEN.push(function (reg) {
    if (this.dim !== 'over' || this.S.ocean || reg === 0 || reg === -1) return null;
    const s = this.wseed + 441;
    if (hash(reg, 1, s) > 0.08) return null;
    const w = 3 + Math.floor(hash(reg, 2, s) * 3);
    // 在这个区域里找一段平地（坑两边各多一格也一样高、不挨着水、不在小屋旁边），有好几段的话按散列挑一段
    const house = this.houses && this.houses[0];
    const spots = [];
    for (let c = reg * REG + 8; c <= reg * REG + REG - 8 - w; c++) {
      const top0 = this.genHeight(c - 1);
      let flat = top0 < 900 && !(this.sea < 900 && top0 >= this.sea - 1);
      for (let k = 0; flat && k <= w; k++) if (this.genHeight(c + k) !== top0) flat = false;
      if (!flat || (house && c + w >= house.col - 6 && c <= house.col + (house.w || 5) + 6)) continue;
      spots.push([c, top0]);
    }
    if (!spots.length) return null;
    const [c0, top] = spots[Math.floor(hash(reg, 3, s) * spots.length)];
    const d = 1 + Math.floor(hash(reg, 4, s) * 2);
    return {
      type: 'lavaLake', surface: true, c0, c1: c0 + w - 1, r0: top, r1: top + d,
      cell: (c, r) => (r < top + d ? { mat: M.stone, lava: true, surfLava: true } : { mat: M.stone }),
    };
  });

  /** 这一列（像素 x）是地表岩浆湖吗：地上的生物不走进去、不生成在上面 */
  P.surfLavaAt = function (x) {
    const c = Math.floor(x / this.B);
    return this.structsIn(c, c).some((s) => s.type === 'lavaLake' && c >= s.c0 && c <= s.c1);
  };

  // ───────────── 流动 ─────────────

  // 流动只看世界本身，不看哪些区块已经生成（rc6）：以前用 fluidAt，旁边的区块还没生成时只能粗略判断（看不到裂谷底的积水），
  // 窗口大小一变，生成了哪些区块、先后顺序都不同，同一个世界算出来的流动就不一样

  /** 流动算的时候用的「实心」：地形 + 结构，瀑布浇出来的黑曜石也算。先生成这一列的结构（结构会压平地面，高度要在它之后读） */
  const solid = (sc, c, r) => { sc.structsIn(c, c); return sc.solidAt(c, r) || sc.quenchedAt(c, r); };

  /** 这一格是水还是岩浆：和画区块时记下的一样（地下水、裂谷底的积水、岩浆、海水），但不用等区块生成 */
  function fluid(sc, c, r) {
    if (sc.lavaAt(c, r)) return 'lava';
    sc.structsIn(c, c);
    const top = sc.colHeight(c);
    if (sc.sea < 900 && r >= sc.sea && r < top) return 'water';
    if (top > 900 || r < top) return null;
    const cell = sc.cellAtWorld(c, r);
    return cell && cell.cwater ? 'water' : cell && cell.lava ? 'lava' : null;
  }

  /**
   * 一处流动：kind 'water' / 'lava'。cells：key → { c, r, t: 'flow' | 'fall', lvl, dir }；
   * touch：碰到别的液体的地方 → { c, r, mat }（黑曜石 / 圆石 / 石头）
   */
  function newFlow(kind) { return { kind, cells: new Map(), touch: new Map(), c0: Infinity, c1: -Infinity, r0: Infinity, r1: -Infinity }; }
  function add(f, c, r, t, lvl, dir) {
    const k = key(c, r);
    const old = f.cells.get(k);
    if (old && (old.t === 'fall' || old.lvl >= lvl)) return false;
    if (f.cells.size >= MAX_CELLS) return false;
    f.cells.set(k, { c, r, t, lvl, dir });
    if (c < f.c0) f.c0 = c; if (c > f.c1) f.c1 = c;
    if (r < f.r0) f.r0 = r; if (r > f.r1) f.r1 = r;
    return true;
  }
  /** 碰到另一种液体：水碰岩浆 → 黑曜石（岩浆湖都是静止的），岩浆往下落进水 → 石头，岩浆从旁边流进水 → 圆石 */
  function touch(sc, f, c, r, other, falling) {
    if (other === f.kind) return;
    const mat = f.kind === 'water' ? 'obsidian' : falling ? 'stone' : 'cobble';
    f.touch.set(key(c, r), { c, r, mat });
    if (c < f.c0) f.c0 = c; if (c > f.c1) f.c1 = c;
    if (r < f.r0) f.r0 = r; if (r > f.r1) f.r1 = r;
  }

  /** 从 (c, r) 往 dir 淌 run 格；路上碰到崖边就落下去 */
  function spread(sc, f, c, r, dir, run, hops) {
    for (let k = 1; k <= run; k++) {
      const x = c + dir * k;
      if (solid(sc, x, r)) return;
      const fl = fluid(sc, x, r);
      if (fl) { touch(sc, f, x, r, fl, false); return; }
      if (!add(f, x, r, 'flow', run - k + 1, dir)) return;
      if (!solid(sc, x, r + 1)) {
        const below = fluid(sc, x, r + 1);
        if (below) { touch(sc, f, x, r + 1, below, true); return; }
        drop(sc, f, x, r + 1, hops - 1);
        return;
      }
    }
  }

  /** 从 (c, r) 往下落，落地以后往两边淌（还有接力次数的话） */
  function drop(sc, f, c, r, hops) {
    let y = r;
    while (y < r + MAX_FALL && !solid(sc, c, y) && !fluid(sc, c, y)) { add(f, c, y, 'fall', 9, 0); y++; }
    const below = fluid(sc, c, y);
    if (below) { touch(sc, f, c, y, below, true); return; }
    if (y === r || hops < 0) return;
    land(sc, f, c, y - 1, hops);
  }

  /** 落到 (c, r)（下面是地）：这一格是流动的源头，往两边淌 */
  function land(sc, f, c, r, hops) {
    const run = RUN[f.kind];
    add(f, c, r, 'flow', run + 1, 0);
    if (hops <= 0) return;
    spread(sc, f, c, r, -1, run, hops);
    spread(sc, f, c, r, 1, run, hops);
  }

  /** 瀑布 / 岩浆瀑布落地：从落点开始流 */
  P.flowFromFall = function (c, r, kind) {
    const len = this.fallLen(c, r);
    const y = r + len - 1; // 落点（最后一格空的）
    const f = newFlow(kind);
    // 落进另一种液体：水落进岩浆湖 → 黑曜石，岩浆落进水里 → 石头（最底下岩浆层的黑曜石在 scenecave.quenchedAt 生成时就有了）
    const below = fluid(this, c, y + 1);
    if (below) { touch(this, f, c, y + 1, below, true); return f.touch.size ? f : null; }
    if (this.quenchedAt(c, y + 1) || !this.rawSolid(c, y + 1, null)) return null; // 落在黑曜石上，或者 48 格还没落地
    if (solid(this, c, y)) return null; // 落点被结构（矿井的木板……）占着
    land(this, f, c, y, HOPS);
    return f;
  };

  /** 积水 / 岩浆湖从旁边的开口流出去（这一格 (c, r) 是液体，dir 那边是空的） */
  P.flowFromOutlet = function (c, r, dir, kind) {
    const f = newFlow(kind);
    spread(this, f, c, r, dir, RUN[kind], HOPS);
    return f.cells.size || f.touch.size ? f : null;
  };

  /** 生成 / 重画一个区块以后，找这个区块里的源头：瀑布、带开口的积水和岩浆湖（每个区块只找一次） */
  P.flowScan = function (ch) {
    if (this.dim !== 'over' || ch.flowScanned) return;
    ch.flowScanned = true;
    const flows = this._flows || (this._flows = new Map());
    const put = (k, f) => { if (f) { flows.set(k, f); this._flowCells = null; this._flowDraw = null; } };
    for (const [c, r, name] of ch.fx || []) {
      if (name !== 'fall' && name !== 'lavafall') continue;
      const k = `f${c},${r}`;
      if (!flows.has(k)) put(k, this.flowFromFall(c, r, name === 'lavafall' ? 'lava' : 'water'));
    }
    // 开口是竖着一整面时（地下水在分段的地方齐刷刷断开），只从最上面那一行流出去，顺着外面那一列落下来；
    // 以前每一行都各流一次，同一列里叠了一摞薄水，看着像一格一格切开的（rc6，试用 rc5 时发现）
    const open = (c, r) => !fluid(this, c, r) && !solid(this, c, r);
    const outlets = (list, kind) => {
      for (const [c, r] of list || []) {
        if (kind === 'lava' && r >= this.BOT - 12) continue; // 最底下的岩浆层没有更低的地方可流
        for (const d of [-1, 1]) {
          if (!open(c + d, r)) continue;
          if (fluid(this, c, r - 1) === kind && open(c + d, r - 1)) continue;
          const k = `o${c},${r},${d}`;
          if (!flows.has(k)) put(k, this.flowFromOutlet(c, r, d, kind));
        }
      }
    };
    outlets(ch.cwater, 'water');
    outlets(ch.lava, 'lava');
    // 走远了的流动不留着（离视野很远）
    if (flows.size > 600) {
      const mid = (this.cam.x + this.W / 2) / this.B;
      for (const [k, f] of flows) if (Math.abs((f.c0 + f.c1) / 2 - mid) > 400) flows.delete(k);
      this._flowCells = null; this._flowDraw = null;
    }
  };

  /** 这一格有流动的水 / 岩浆吗（点击用） */
  P.flowAt = function (c, r) {
    if (!this._flows) return null;
    if (!this._flowCells) {
      const m = new Map();
      for (const f of this._flows.values()) for (const k of f.cells.keys()) m.set(k, f.kind);
      this._flowCells = m;
    }
    return this._flowCells.get(key(c, r)) || null;
  };

  const MAT = { obsidian: () => M.obsidian, cobble: () => M.cobble, stone: () => M.stone };

  /**
   * 所有流动合在一起准备好画的东西（流动有变化时重算一次，rc6）：
   *   - 同一格只画一次（几处流动叠在同一格时，以前半透明的水一层层叠深）
   *   - 往下落的格子按列连成一整段（runs），像瀑布一样画成一道；落着的格子不再画淌开的薄层
   */
  function merged(sc) {
    if (sc._flowDraw) return sc._flowDraw;
    const falls = { water: new Map(), lava: new Map() };
    const layers = new Map();
    const touches = new Map();
    for (const f of sc._flows.values()) {
      for (const [k, x] of f.cells) {
        if (x.t === 'fall') { falls[f.kind].set(k, x); continue; }
        const o = layers.get(k);
        if (!o || o.lvl < x.lvl) layers.set(k, { c: x.c, r: x.r, lvl: x.lvl, dir: x.dir, kind: f.kind });
      }
      for (const [k, t] of f.touch) touches.set(k, t);
    }
    for (const k of [...layers.keys()]) if (falls.water.has(k) || falls.lava.has(k)) layers.delete(k);
    const runs = [];
    for (const kind of ['water', 'lava']) {
      const cols = new Map();
      for (const x of falls[kind].values()) (cols.get(x.c) || cols.set(x.c, []).get(x.c)).push(x.r);
      for (const [c, rs] of cols) {
        rs.sort((a, b) => a - b);
        let a = rs[0];
        for (let i = 1; i <= rs.length; i++) {
          if (i < rs.length && rs[i] === rs[i - 1] + 1) continue;
          runs.push({ c, r0: a, r1: rs[i - 1], kind });
          a = rs[i];
        }
      }
    }
    sc._flowDraw = { falls, layers, touches, runs };
    return sc._flowDraw;
  }

  /** 每帧：画面里的流动（在洞里的水、岩浆、瀑布之后画） */
  P.drawFlows = function (lx, ly) {
    if (!this._flows || !this._flows.size) return;
    const { ctx, B } = this;
    const now = performance.now();
    const c0 = Math.floor(this.cam.x / B) - 2; const c1 = Math.ceil((this.cam.x + this.W) / B) + 2;
    const r0 = Math.floor(this.cam.y / B) - 2; const r1 = Math.ceil((this.cam.y + this.H) / B) + 2;
    const d = merged(this);
    // 淌开的一层：离源头越远越薄，表面有一个往流的方向走的亮点
    for (const x of d.layers.values()) {
      if (x.c < c0 || x.c > c1 || x.r < r0 || x.r > r1) continue;
      const lava = x.kind === 'lava';
      const run = RUN[x.kind];
      const px = lx + x.c * B; const py = ly + x.r * B;
      const lvl = Math.min(run + 1, x.lvl);
      const hpx = Math.max(1, Math.round(B * (0.25 + (0.65 * lvl) / (run + 1))));
      if (lava) {
        const k = Math.sin(now * 0.002 + x.c * 0.7 + x.r * 1.3);
        ctx.fillStyle = `rgba(${Math.round(222 + 30 * Math.max(0, k))},${Math.round(96 + 60 * Math.max(0, k))},24,0.96)`;
      } else ctx.fillStyle = 'rgba(46,92,200,0.66)';
      ctx.fillRect(px, py + B - hpx, B, hpx);
      ctx.fillStyle = lava ? 'rgba(255,214,90,0.8)' : 'rgba(150,190,255,0.75)';
      ctx.fillRect(px, py + B - hpx, B, 1);
      const speed = lava ? 0.004 : 0.012;
      const phase = ((now * speed * (x.dir || 1)) % (B * 3) + B * 3) % (B * 3);
      const sx = (x.c * B + phase) % (B * 3);
      if (sx < B) { ctx.fillStyle = lava ? 'rgba(255,240,170,0.9)' : 'rgba(225,238,255,0.85)'; ctx.fillRect(px + Math.floor(sx), py + B - hpx, 1, 1); }
    }
    // 往下落的：一列一整段，和洞里的瀑布一样宽、一样的颜色；亮点按在世界里的高度排，整段一起往下走，跨格不断开。
    // 旁边一列也在落的那几行连成一片，不留缝
    const w = Math.max(2, Math.round(B * 0.7));
    for (const s of d.runs) {
      if (s.c < c0 || s.c > c1 || s.r1 < r0 || s.r0 > r1) continue;
      const lava = s.kind === 'lava';
      const set = d.falls[s.kind];
      const px = lx + s.c * B;
      const ra = Math.max(s.r0, r0); const rb = Math.min(s.r1, r1);
      ctx.fillStyle = lava ? 'rgba(232,110,24,0.95)' : 'rgba(52,104,214,0.78)';
      for (let r = ra; r <= rb; r++) {
        const xa = set.has(key(s.c - 1, r)) ? px : px + (B - w) / 2;
        const xb = set.has(key(s.c + 1, r)) ? px + B : px + (B + w) / 2;
        ctx.fillRect(xa, ly + r * B, xb - xa, B);
      }
      ctx.fillStyle = lava ? 'rgba(255,214,90,0.85)' : 'rgba(150,190,255,0.7)';
      const phase = now * (lava ? 0.02 : 0.05);
      const base = Math.floor(phase / 6);
      const off = phase - base * 6;
      const x0 = px + Math.floor((B - w) / 2);
      for (let n = Math.ceil((ra * B - off) / 6); 6 * n + off < (rb + 1) * B; n++) {
        const wy = 6 * n + off;
        if (wy < ra * B) continue;
        ctx.fillRect(x0 + (((n - base) % 2) + 2) % 2, ly + wy, 1, 2);
      }
      // 落地的水花（岩浆是溅起的火星）
      if (rb === s.r1) {
        ctx.fillStyle = lava ? 'rgba(255,190,80,0.85)' : 'rgba(200,225,255,0.8)';
        const by = ly + (s.r1 + 1) * B - 1;
        for (let k = 0; k < 3; k++) {
          const dx = Math.sin(now * (lava ? 0.004 : 0.01) + k * 2.1 + s.c) * (B * 0.9);
          ctx.fillRect(px + B / 2 + dx, by - Math.abs(Math.cos(now * 0.013 + k)) * 2, 1, 1);
        }
      }
    }
    // 碰到别的液体变成的方块（黑曜石 / 圆石 / 石头），上面偶尔冒蒸汽
    for (const t of d.touches.values()) {
      if (t.c < c0 || t.c > c1 || t.r < r0 || t.r > r1) continue;
      const pal = MAT[t.mat]();
      const px = lx + t.c * B; const py = ly + t.r * B;
      for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) {
        ctx.fillStyle = this.color(pal[Math.floor(hash(t.c * B + xx, t.r * B + yy, pal.length) * pal.length)]);
        ctx.fillRect(px + xx, py + yy, 1, 1);
      }
      if (this.rnd() < 0.03 * this.fxK) this.parts.push({ x: px - lx + this.rnd() * B, y: py - ly - 1, vx: (this.rnd() - 0.5) * 3, vy: -7 - this.rnd() * 4, life: 900, c: [215, 220, 228], glow: true, drag: 0.6 });
    }
  };

  // 接到世界的生成和绘制上：区块画好以后找源头；画完世界以后画流动
  const render0 = P.renderChunk;
  P.renderChunk = function (ch) { render0.call(this, ch); this.flowScan(ch); };
  const draw0 = P.drawWorld;
  P.drawWorld = function (lx, ly) { draw0.call(this, lx, ly); this.drawFlows(lx, ly); };
})();
