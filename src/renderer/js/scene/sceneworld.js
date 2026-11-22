'use strict';
/**
 * 主页动态背景的无限世界（第一阶段）：左右无限、地下到基岩，视角可以移动。
 * - 世界按 16 列一块按需生成，只留视野附近的块。`heights` 是代理：读哪列算哪列，
 *   爆炸、小屋压平这些改动存在 hOver 里，块被卸载再生成也还在
 * - 每块一张画布（ImageData 逐像素写）：地表、石头 / 深板岩、矿石、洞穴（暗一些的背景墙）、基岩；
 *   水、洞穴里的岩浆每帧单独画（有波光）。树、花、柱子这些按块生成，块卸载时一起去掉
 * - 山：离开打开时那一屏越远越可能出现高山，雪顶、陡坡露石头
 * - 视角 cam：home.js 把「边缘空白处停留」和「拖动空白处」转给 panEdge / panDrag
 */
(function () {
  const { mulberry, hash, mix, hex, pal, M, SPRITES } = A.sceneKit;
  const P = A.Scene.prototype;

  const CH = 16; // 每块多少列
  const DEPTH = 96; // 基准地面往下多少格到基岩
  // 世界生成范围（性能打磨）：视野两边各预先生成多少屏、再多留几块才卸载
  const RANGE = { large: [0.6, 3], medium: [0.35, 2], small: [0.15, 1] };
  const DEEP = 52; // 基准地面往下多少格开始是深板岩
  const REG = 64; // 结构（海底神殿、矿井、地牢……）按 64 列一个区域生成
  // 第二阶段的扩展点（sceneocean.js / scenecave.js 往里加）：
  // GEN：结构生成器 fn.call(scene, 区域号, rnd) → 结构 / 结构数组 / null。结构 { type, c0, c1, r0, r1, cell(c, r, top) }，
  //   cell 返回 undefined = 这格不归它管，null = 空（水 / 空气），否则是一格 { mat, cave, glow, deco, fx, ... }
  // DECO：画进块画布的小装饰（蜘蛛网、铁轨、发光浆果……）fn(dot, cell, c, r, B)，dot(px, py, 颜色, 发光)
  // FX：每帧动的效果（刷怪笼、滴水……）fn.call(scene, 屏幕 x, 屏幕 y, now, c, r)
  const GEN = [];
  const DECO = {};
  const FX = {};

  Object.assign(M, {
    deepslate: pal('#4d4d55', '#45454c', '#56565e', '#3f3f45'),
    tuff: pal('#6c6d66', '#62635c', '#74756d'),
    granite: pal('#9a6a55', '#8f6250', '#a5735e'),
    diorite: pal('#c8c8c8', '#b8b8b8', '#d4d4d4'),
    andesite: pal('#8a8a8a', '#7f7f80', '#959595'),
    gravel: pal('#857f7c', '#777170', '#938c88', '#6a6461'),
    bedrock: pal('#3a3a3a', '#555555', '#262626', '#6a6a6a'),
    blackstone: pal('#2e292e', '#262226', '#363036'),
    magma: pal('#8a3a10', '#a84a14', '#6a2a0c'),
    clay: pal('#9fa4b0', '#959aa6', '#a8adb8'),
  });
  // 矿石：底色（石头 / 深板岩 / 下界岩）上撒的斑点颜色
  const ORE = {
    coal: pal('#262626', '#383838'),
    iron: pal('#d8af93', '#c49a7c'),
    copper: pal('#e07a4c', '#5ea88e'),
    gold: pal('#f5d04a', '#e0b030'),
    redstone: pal('#e02020', '#ff4a3a'),
    lapis: pal('#2a4fb8', '#3a62d0'),
    diamond: pal('#5ee8e0', '#a8fff8'),
    emerald: pal('#2fd060', '#7ff0a0'),
    quartz: pal('#efe6dc', '#d8ccc0'),
    netherGold: pal('#f0c040', '#ffd860'),
  };
  ORE.debris = pal('#6b4b3e', '#8a6452');
  const GLOW_ORE = { redstone: 0.5, diamond: 0.25, emerald: 0.2 };
  // 每个场景的山：0 没有；数字越大山越多越高
  const MOUNTAINS = { plains: 0.85, forest: 1, snowy: 1.3, cherry: 1.1, desert: 0.6, darkforest: 0.8, jungle: 0.7 };
  // 噪声超过多少才长山（越大山越少）：平原的山少一些（rc7，试用 rc6 觉得平原的高山多了点）
  const MOUNT_LO = { plains: 0.53 };
  const VIEW_DOWN = 0.1; // 主世界地面在画面里比场景表里写的 base 高多少（见 initWorld）
  // 山是什么样（1.10.3，照原版按温度选山峰群系）：冷 / 温和的地方是雪山（尖峭山峰、冰封山峰），
  // 暖的丛林旁边是石峰（光秃秃的石头夹着方解石，没有雪），热的沙漠旁边是恶地（一层层彩色陶瓦，顶上红沙）
  const PEAKS = { desert: 'badlands', jungle: 'stony' };
  const WIDE_TREES = new Set(['darkOak', 'jungle']); // 树干两格粗的树
  const tc = (a, b) => pal(a, b, a);
  Object.assign(M, {
    redSand: pal('#be6621', '#b35e1e', '#c8702a'),
    packedIce: pal('#8db2e6', '#9abdee', '#84a8dc'),
  });
  // 恶地的陶瓦：普通、橙、黄、白、红、棕、淡灰
  const TERRA = [tc('#985e43', '#8f5840'), tc('#a05325', '#984e22'), tc('#ba8523', '#b07e22'), tc('#d1b1a1', '#c8a898'),
    tc('#8f3d2e', '#87392b'), tc('#4d3323', '#463020'), tc('#876a61', '#7f645b')];

  /** 平滑的值噪声（0~1），x / y 可以是任意实数 */
  function vnoise(x, y, s) {
    const xi = Math.floor(x); const yi = Math.floor(y);
    const xf = x - xi; const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf); const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s); const b = hash(xi + 1, yi, s); const c = hash(xi, yi + 1, s); const d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  Object.assign(A.sceneKit, { vnoise, smooth, CH, REG, DEEP, GEN, DECO, FX, ORE });

  // ───────────── 世界 ─────────────

  /** build() 里调用：清空块、定好种子和小屋，生成视野里的块 */
  P.initWorld = function (rnd) {
    const S = this.S;
    // 换场景、换种子时视角回到地面；改窗口大小重建时保持。
    // 地形的尺度（起伏多大、山多高、海平面离地面多远、打开那一屏的建筑在哪）按打开这个场景时的窗口定（homeCols / homeRows），
    // 之后拉窗口不再变（rc6：以前窗口一变高变矮，地表、海平面、靠近地表的瀑布和流动全跟着变）。
    // 地面在画面里的位置照旧跟着窗口高度走：整个世界上下挪 lift 行（世界里的行号都是「按打开时算的行号 + lift」）
    const key = `${this.sceneId}:${this.seed}`;
    const oldLift = this.cam && this.camKey === key ? this.lift : null;
    if (!this.cam || this.camKey !== key) { this.cam = { x: 0, y: 0, tx: 0, ty: 0 }; this.homeCols = this.cols; this.homeRows = this.rows; }
    this.camKey = key;
    this.wr = this.homeRows || this.rows;
    this.worldOff = [rnd() * 50, rnd() * 50, rnd() * 50];
    this.wseed = (this.seed * 131 + this.sceneId.length * 17 + this.sceneId.charCodeAt(0)) | 0;
    // 主世界的地面（和海平面）在画面里放高 VIEW_DOWN：打开时天空少一些、多露出一些地下（rc7，以前默认视角天空太多）。
    // 下界、末地照旧。base0 / water0 是实际用的比例，地形、海平面、远景都按它们算
    const down = this.dim === 'over' ? VIEW_DOWN : 0;
    this.base0 = S.base - down;
    this.water0 = S.water ? S.water - down : 0;
    this.baseRow = Math.round(this.rows * this.base0);
    this.lift = this.baseRow - Math.round(this.wr * this.base0);
    // 拉窗口时视角平移在别处（地下、远处）：镜头跟着世界一起挪，看着的还是原来那块地方；在地面视角时不动，地面照旧在画面里同样的位置
    if (oldLift != null && oldLift !== this.lift && (this.cam.ty || this.cam.y)) {
      const dy = (this.lift - oldLift) * this.B;
      this.cam.y += dy; this.cam.ty += dy;
    }
    this.sea = S.water ? Math.floor(this.wr * this.water0) + this.lift : S.lava ? Math.floor(this.wr * S.lava) + this.lift : 9999;
    this.BOT = this.dim === 'end' ? null : this.baseRow + DEPTH;
    this.mountK = this.dim === 'over' ? MOUNTAINS[this.sceneId] || 0 : 0;
    this.peakKind = PEAKS[this.sceneId] || 'snow';
    this.hOver = new Map();
    this.chunks = new Map();
    this.regions = new Map();
    this._aqMemo = null; this._lpMemo = null; this._fallLen = null; this._fallInto = null; this._lvMemo = null; this._flows = null; this._flowCells = null; this._flowDraw = null; // 地下水、繁茂洞穴水塘的缓存按格子位置记，换场景 / 种子后要清掉（以前一直沿用上一个世界的）
    this.trees = [];
    this.decor = [];
    this.houses = [];
    this.builds = [];
    this.water = [];
    this.envMods = null; // 点过的格子（sceneinteract.js）
    this.items = [];
    const self = this;
    this.heights = new Proxy({}, {
      get(_, k) { const c = Number(k); return Number.isInteger(c) ? self.colHeight(c) : undefined; },
      set(_, k, v) { const c = Number(k); if (Number.isInteger(c)) self.setHeight(c, v); return true; },
    });
    this.placeHouse(rnd);
    this.ensureChunks(true);
  };

  /** 地形高度（行号，越小越高；9999 = 末地的虚空） */
  P.genHeight = function (c) {
    const S = this.S;
    if (S.ocean) return this.oceanHeight(c); // 海洋另算（sceneocean.js）
    if (this.dim === 'end') { const e = this.endHeight(c); if (e != null) return e; } // 末地主岛和它周围的虚空（sceneend.js）
    const o = this.worldOff;
    let n = Math.sin(c * 0.07 + o[0]) * 0.55 + Math.sin(c * 0.17 + o[1]) * 0.3 + Math.sin(c * 0.41 + o[2]) * 0.15;
    if (S.island) n = n * 1.3 - 0.35;
    // 按打开时的窗口算（wr），再整体挪 lift 行（见 initWorld）
    const wr = this.wr;
    let h = wr * this.base0 - n * wr * S.hill;
    const [m, fade] = this.mountParts(c);
    if (m > 0 && fade > 0) {
      // 山体：低频噪声决定哪里有山，再叠一层中频起伏让山坡有缓有陡（不是一堵墙）
      const ridge = 0.75 + 0.25 * vnoise(c / 9, 1.5, this.wseed + 4);
      const peak = Math.pow(m, 1.8) * ridge * wr * 1.35 * this.mountK * fade;
      h -= peak + Math.sin(c * 0.9 + o[1]) * m * 1.5 * fade;
    }
    if (S.void && Math.sin(c * 0.11 + o[1]) < -0.55) return 9999;
    return Math.round(h) + this.lift;
  };

  /** 这一列的山：[山有多大 0~1, 离打开那一屏的远近 0~1]（打开时那一屏附近不长山，越往两边越可能有） */
  P.mountParts = function (c) {
    if (!this.mountK) return [0, 0];
    const v = this.homeCols || this.cols;
    const dist = c < -v * 0.15 ? -v * 0.15 - c : c > v * 1.15 ? c - v * 1.15 : 0;
    const fade = smooth(dist / (v * 0.6));
    if (fade <= 0) return [0, 0];
    const lo = MOUNT_LO[this.sceneId] || 0.44;
    return [smooth((vnoise(c / 64, 0.5, this.wseed + 3) - lo) / (0.78 - lo)), fade];
  };

  /** 沙漠旁边的山是恶地（从山脚开始，按列定，不看高度） */
  P.badlandsAt = function (c) {
    if (this.peakKind !== 'badlands') return false;
    const [m, fade] = this.mountParts(c);
    return m * fade > 0.15;
  };

  /** 恶地的陶瓦：按高度一条条横纹（两格一条，同一高度整片同色），纹路随山势稍微起伏 */
  P.terracotta = function (c, r) {
    const y = r - this.baseRow + Math.round((vnoise(c / 24, 9.5, this.wseed + 59) - 0.5) * 4);
    const h = hash(Math.floor(y / 2), 0, this.wseed + 58);
    return { mat: TERRA[h < 0.45 ? 0 : 1 + Math.floor(((h - 0.45) / 0.55) * 6)] };
  };

  P.colHeight = function (c) {
    if (this.hOver.has(c)) return this.hOver.get(c);
    const ch = this.chunks && this.chunks.get(Math.floor(c / CH));
    return ch ? ch.hs[c - ch.c0] : this.genHeight(c);
  };

  P.setHeight = function (c, v) {
    this.hOver.set(c, v);
    const ch = this.chunks.get(Math.floor(c / CH));
    if (ch) { ch.hs[c - ch.c0] = v; ch.dirty = true; ch.water = this.waterOf(ch); this.collectWater(); }
  };

  /**
   * c 开始 w 列盖房子要动多少土：[地面那一行, 离地面最远的那一列差几格]。有虚空返回 null。
   * 地面取中位数，动的土最少；不能泡在水里，低洼的地方填到水面上面（和 landFloor 一样）
   */
  P.houseFloor = function (c, w) {
    const hs = Array.from({ length: w }, (_, k) => this.genHeight(c + k));
    if (hs.some((h) => h > 900)) return null;
    const sorted = [...hs].sort((a, b) => a - b);
    const ground = Math.min(sorted[Math.floor(w / 2)], this.sea < 900 ? this.sea - 2 : Infinity);
    return [ground, Math.max(...hs.map((h) => Math.abs(h - ground)))];
  };

  /**
   * 小屋：放在打开时那一屏的左半边（避开右边的更新日志），压平那几列，两边修成缓坡。
   * 2.0.0-pre1：以前随机试 60 次、要求几乎全平，找不到就退回小木屋；世界种子每天固定，
   * 平原水多、平地少，碰上放不下的一天怎么刷都只有小木屋。现在候选位置全看一遍，挑最平的
   */
  P.placeHouse = function (rnd) {
    const S = this.S;
    if (!(this.dim === 'over' && S.house && this.opts.buildings)) return;
    // 最多动这么多格土（画面越高地形起伏越大），再多就太假了
    const limit = Math.max(3, Math.round(this.wr * 0.05));
    const hc = this.homeCols || this.cols; // 按打开时的窗口宽度放（拉窗口重建时房子不挪地方）
    // 房子样式每次换场景随机（scenehouse.js）：大房子实在放不下才退回小木屋
    for (const kind of this.houseKinds ? this.houseKinds() : ['hut']) {
      const plan = this.housePlan ? this.housePlan(kind) : { w: 5, hgt: 6, dc: 1 };
      const w = plan.w;
      const lo = Math.max(4, Math.floor(hc * 0.08));
      const hi = Math.max(lo, Math.floor(hc * 0.45) - (w - 5));
      const hiWide = Math.max(hi, 6 + hc - 18 - w);
      // 先看左半边；都不行再看整屏（右边可能被更新日志挡住，所以放在后面）
      for (const [c0, c1] of [[lo, hi], [hi + 1, hiWide]]) {
        const spots = [];
        for (let c = c0; c <= c1; c++) {
          const f = this.houseFloor(c, w);
          if (f && f[1] <= limit) spots.push({ c, ground: f[0], cost: f[1] });
        }
        if (!spots.length) continue;
        // 差不多平的里面随机一个，不总是同一个位置
        const best = Math.min(...spots.map((s) => s.cost));
        const near = spots.filter((s) => s.cost <= best + 1);
        const { c, ground } = near[Math.floor(rnd() * near.length)];
        for (let k = 0; k < w; k++) this.hOver.set(c + k, ground);
        // 两边修成缓坡：离房子每远一格最多差一格，房子旁边不会是一堵墙或者悬崖
        for (const dir of [-1, 1]) {
          for (let d = 1; d <= limit + 2; d++) {
            const col = dir < 0 ? c - d : c + w - 1 + d;
            const h = this.genHeight(col);
            if (Math.abs(h - ground) <= d) break;
            this.hOver.set(col, ground + (h > ground ? d : -d));
          }
        }
        this.houses.push({ col: c, ground, kind, w, hgt: plan.hgt, dc: plan.dc, style: S.house, door: 0, lit: this.period === 'night' || this.period === 'sunset' });
        return;
      }
    }
  };

  /** 视野（含两边各一屏）要的块都生成好；sync=false 时每帧最多生成两块，免得卡一下 */
  P.ensureChunks = function (sync) {
    const span = CH * this.B;
    const cx = this.cam ? this.cam.x : 0;
    const [pre, KEEP] = RANGE[this.opts.range] || RANGE.large;
    // 两边至少多生成两块（32 列）：水和岩浆从源头最远淌出 17 列左右，源头在画面外的流动也要先算好（rc6）
    const need0 = Math.min(Math.floor((cx - this.W * pre) / span), Math.floor(cx / span) - 2);
    const need1 = Math.max(Math.floor((cx + this.W * (1 + pre)) / span), Math.floor((cx + this.W) / span) + 2);
    let made = 0;
    let changed = false;
    // 先生成视野里的，再生成两边的
    const order = [];
    const v0 = Math.floor(cx / span); const v1 = Math.floor((cx + this.W) / span);
    for (let ci = v0; ci <= v1; ci++) order.push(ci);
    for (let ci = need0; ci <= need1; ci++) if (ci < v0 || ci > v1) order.push(ci);
    for (const ci of order) {
      if (this.chunks.has(ci)) continue;
      if (!sync && made >= 2 && (ci < v0 || ci > v1)) continue;
      this.genChunk(ci);
      made++;
      changed = true;
    }
    for (const ci of [...this.chunks.keys()]) {
      if (ci >= need0 - KEEP && ci <= need1 + KEEP) continue;
      this.chunks.delete(ci);
      this.trees = this.trees.filter((t) => t.ci !== ci);
      this.decor = this.decor.filter((d) => d.ci !== ci);
      changed = true;
    }
    if (changed) this.collectWater();
  };

  P.genChunk = function (ci) {
    const c0 = ci * CH;
    this.structsIn(c0, c0 + CH - 1); // 先生成附近的结构：海底神殿会压平海底，要在算高度之前
    const hs = [];
    for (let k = 0; k < CH; k++) hs.push(this.hOver.has(c0 + k) ? this.hOver.get(c0 + k) : this.genHeight(c0 + k));
    const ch = { ci, c0, hs, lava: [], canvas: null, rTop: 0, palV: -1, dirty: true };
    ch.water = this.waterOf(ch);
    this.chunks.set(ci, ch);
    this.populate(ch);
    if (this.P) this.renderChunk(ch);
    return ch;
  };

  P.waterOf = function (ch) {
    const out = [];
    if (this.sea > 900) return out;
    for (let k = 0; k < CH; k++) {
      const top = ch.hs[k];
      if (top > this.sea && top < 900) for (let r = this.sea; r < top; r++) out.push([ch.c0 + k, r, r === this.sea]);
    }
    return out;
  };

  P.collectWater = function () {
    const all = [];
    for (const ch of this.chunks.values()) for (const w of ch.water) all.push(w);
    this.water = all;
  };

  /** 树、花、仙人掌、末地柱子、下界要塞的桥（按块的种子，同一块每次生成都一样） */
  P.populate = function (ch) {
    const S = this.S;
    const rnd = mulberry((this.wseed ^ Math.imul(ch.ci, 2654435761)) >>> 0);
    const house = this.houses[0];
    let lastTree = -10;
    for (let k = 0; k < CH; k++) {
      const i = ch.c0 + k;
      const top = ch.hs[k];
      const r = rnd(); const r2 = rnd();
      if (top >= this.sea - 1 || top > 900) continue;
      if (house && i >= house.col - 4 && i <= house.col + (house.w || 5) + 3) continue; // 小屋周围不长树，免得树冠挡住
      if (this.structsIn(i - 2, i + 2).some((s) => s.surface && i >= s.c0 - 2 && i <= s.c1 + 2)) continue; // 前哨站、府邸、堡垒周围也不长
      const steep = Math.abs(this.colHeight(i - 1) - top) + Math.abs(this.colHeight(i + 1) - top);
      const peak = this.isPeak(top);
      if (steep >= 4 || (steep >= 3 && this.mountK)) continue; // 山上的陡坡露着石头，上面不长东西
      if (k - lastTree > 4 && !peak) {
        let acc = 0;
        let placed = false;
        // 下界按群系长绯红菌 / 诡异菌（scenenether.js）
        // 末地主岛上不长紫颂植物（原版只长在外岛，sceneend.js）
        for (const [kind, p] of this.dim === 'nether' ? this.netherTrees(i) : this.onMainIsland(i) ? [] : S.trees) {
          acc += p;
          if (r < acc) {
            // 雪山的山坡上是云杉（原版的雪林、草甸）；樱花林本来就长在山坡上，照旧是樱花树；丛林旁边的石峰山坡照旧是丛林树
            const alpine = this.mountK && top < this.baseRow - 12 && this.peakKind === 'snow' && this.sceneId !== 'cherry';
            const treeKind = alpine ? 'spruce' : kind;
            // 两格粗的树干要站在两列一样高的地上，不然半边树干悬空或者插进地里（1.10.4）；这一列不长，后面的列还有机会
            if (WIDE_TREES.has(treeKind) && this.colHeight(i + 1) !== top) break;
            const tr = this.makeTree(treeKind, i, top, rnd);
            tr.ci = ch.ci; this.trees.push(tr); lastTree = k; placed = true; break;
          }
        }
        if (placed) continue;
      }
      let d = null;
      if (peak) continue;
      if (this.dim === 'nether') { d = this.netherDecor(i, top, rnd); if (d) { d.ci = ch.ci; this.decor.push(d); } continue; }
      if (S.cactus && r2 < S.cactus) d = { type: 'cactus', col: i, top, h: 1 + Math.floor(rnd() * 3) };
      else if (S.deadbush && r2 < S.cactus + S.deadbush) d = { type: 'deadbush', col: i, top };
      else if (S.flowers && r2 < S.flowers) d = { type: 'flower', col: i, top, c: rnd(), dx: Math.floor(rnd() * 2) };
      else if (S.jungle && r2 < 0.17) d = this.jungleDecor(i, top, rnd); // 竹子、西瓜（scenejungle.js）
      else if (this.fest === 'halloween' && r2 < 0.06) d = { type: 'pumpkin', col: i, top };
      else if ((S.isle || S.mansion) && r2 < 0.1) d = { type: 'shroom', col: i, top, red: rnd() < 0.5 }; // 小蘑菇（sceneland.js）
      if (d) { d.ci = ch.ci; this.decor.push(d); }
    }
    if (this.dim === 'end') this.endPillarsIn(ch, CH); // 黑曜石柱与末影水晶：只在主岛上，位置固定（sceneend.js）
    if (this.dim === 'nether' && rnd() < 0.16) {
      // 下界要塞的桥：桥面比底下最高的地面高几格（每座桥高度不同），每隔 5 格一根桥墩一直伸到地面（1.5.16：以前都在同一高度，桥墩只有 5 格，悬在半空）
      const col = ch.c0 + Math.floor(rnd() * 8);
      const len = 14 + Math.floor(rnd() * 8);
      const hs = Array.from({ length: len }, (_, k) => this.colHeight(col + k));
      const ground = hs.filter((v) => v < 900);
      if (ground.length > len / 2) {
        const y = Math.max(Math.floor(this.wr * 0.25) + this.lift, Math.min(...ground) - 3 - Math.floor(rnd() * 6));
        const legs = hs.map((v, k) => (k % 5 === 0 ? Math.max(0, (v < 900 ? v : this.wr + this.lift + 4) - y - 1) : 0));
        this.decor.push({ type: 'bridge', col, len, y, legs, ci: ch.ci });
      }
    }
    if (this.populateSea) this.populateSea(ch, rnd); // 水底的海草、海带、珊瑚（sceneocean.js）
  };

  // ───────────── 结构 ─────────────

  /** 一个区域里的结构（第一次用到时生成；可能压平海底，所以要在生成这些列的块之前） */
  P.structsOf = function (reg) {
    let list = this.regions.get(reg);
    if (list) return list;
    list = [];
    this.regions.set(reg, list);
    const rnd = mulberry((this.wseed ^ Math.imul(reg, 0x9e3779b1) ^ 0x5bd1e995) >>> 0);
    for (const g of GEN) {
      const s = g.call(this, reg, rnd);
      if (s) for (const x of [].concat(s)) list.push(x);
    }
    return list;
  };

  /** 覆盖 c0~c1 列的结构（结构最宽不超过一个区域，所以看左右各一个区域就够了） */
  P.structsIn = function (c0, c1) {
    const out = [];
    for (let reg = Math.floor(c0 / REG) - 1; reg <= Math.floor(c1 / REG) + 1; reg++) {
      for (const s of this.structsOf(reg)) if (s.c1 >= c0 && s.c0 <= c1) out.push(s);
    }
    return out;
  };

  /** 结构在这一格放了什么：undefined = 不归结构管，null = 空（水 / 空气） */
  P.structCell = function (list, c, r, top) {
    for (const s of list) {
      if (c < s.c0 || c > s.c1 || r < s.r0 || r > s.r1) continue;
      const v = s.cell(c, r, top);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  /** 只看地形（不看结构）：这格是实心的吗 */
  P.rawSolid = function (c, r, top) {
    if (top == null) top = this.colHeight(c);
    if (top > 900 || r < top) return false;
    if (this.BOT != null && r >= this.BOT) return true;
    if (this.dim === 'end') return true;
    return !this.isCave(c, r, r - top);
  };

  /** 地形 + 结构：生物能不能站上去 / 穿过去 */
  P.solidAt = function (c, r) {
    const top = this.colHeight(c);
    const s = this.structCell(this.structsIn(c, c), c, r, top);
    if (s !== undefined) return !!s && !!s.mat && !s.cave;
    return this.rawSolid(c, r, top);
  };

  /** 洞穴深处的岩浆（生物不走进去） */
  P.lavaAt = function (c, r) {
    if (this.dim !== 'over' || this.BOT == null || r >= this.BOT) return false;
    if (r < this.BOT - 12) return !!(this.lavaAbove && this.lavaAbove(c, r)); // 岩浆层上面：深层岩浆含水层、浅层岩浆湖、地表岩浆湖（rc4，scenefluid.js）
    const top = this.colHeight(c);
    return r > top && this.isCave(c, r, r - top) && !this.quenchedAt(c, r); // 瀑布浇成黑曜石的不算（scenecave.js）
  };

  /** 生成一个生物（不经过 spawnMob 的位置规则：洞穴、海底神殿用） */
  P.mkEnt = function (kind, x, y, now, extra) {
    const r = this.rnd;
    const e = {
      kind, spr: SPRITES[kind], x, y, dir: r() < 0.5 ? 1 : -1, vx: 0, state: 'idle', t: now, until: now + 1000 + r() * 3000, born: now,
      life: 45000 + r() * 60000, alpha: 0, flip: false, color: null, ...extra,
    };
    this.ents.push(e);
    return e;
  };

  /** 高过雪线的山顶 */
  P.isPeak = function (top) { return this.mountK > 0 && top < this.baseRow - this.wr * (this.peakKind === 'snow' ? 0.55 : 0.4); };

  // ───────────── 方块 ─────────────

  P.isCave = function (c, r, depth) {
    if (r >= this.BOT - 3) return false;
    if (this.dim === 'over' && this.ravineAt && this.ravineAt(c, r, depth)) return true; // 裂谷（scenecave.js）
    if (depth < 8) return false;
    const s = this.wseed;
    // 噪声用相对基准地面的行号：窗口高度变了（baseRow 跟着变）洞穴形状不变（1.10.2）
    const y = r - this.baseRow;
    // 大洞（越深越多）+ 细长的通道
    if (vnoise(c * 0.06, y * 0.1, s + 11) > 0.79 - Math.min(0.12, depth * 0.0016)) return true;
    return Math.abs(vnoise(c * 0.035, y * 0.07, s + 23) - 0.5) < 0.026;
  };

  /** 一格的材质：{ mat, ore, cave, lava } */
  P.cellAt = function (c, r, top, steep) {
    const S = this.S;
    const depth = r - top;
    const y = r - this.baseRow; // 噪声、纹理用相对基准地面的行号（1.10.2）
    const s = this.wseed;
    if (this.BOT != null) {
      if (r >= this.BOT) return { mat: M.bedrock };
      if (r >= this.BOT - 4 && hash(c, y, s + 9) < (r - (this.BOT - 5)) / 5) return { mat: M.bedrock };
    }
    if (this.dim === 'nether') {
      if (this.isCave(c, r, depth)) return { mat: M.netherrack, cave: true, lava: r > this.sea + 14 };
      const nb = this.netherCell(c, r, top, depth); // 群系的地表（scenenether.js）；下界荒地返回 null 照旧
      if (nb) return nb;
      // 下界荒地（1.10.3 照原版）：以前地表随机四分之一是灵魂沙，满地斑点；原版是岩浆海岸边一片片的灵魂沙和沙砾，
      // 岩浆海面附近夹着岩浆块，岩浆海下面深处偶尔有远古残骸
      const shore = top >= this.sea - 3 && top < 900 && this.netherBiome(c) === 'wastes';
      if (shore && depth < 3) {
        const v = vnoise(c * 0.15, y * 0.3, s + 45);
        if (v > 0.62) return { mat: M.soul };
        if (v < 0.3) return { mat: M.gravel };
      }
      if (depth > 0 && Math.abs(r - this.sea) <= 3 && hash(c, y, s + 46) < 0.05) return { mat: M.magma, glow: true };
      if (vnoise(c * 0.12, y * 0.14, s + 41) > 0.8) return { mat: depth < 30 ? M.soul : M.blackstone };
      const hh = hash(c >> 1, y >> 1, s + 77);
      if (depth > 3 && hh < 0.05 && hash(c, y, 3) < 0.6) return { mat: M.netherrack, ore: hh < 0.03 ? 'quartz' : 'netherGold' };
      if (depth > 3 && r > this.sea + 4 && hash(c, y, s + 48) < 0.0006) return { mat: M.netherrack, ore: 'debris' };
      return { mat: M.netherrack };
    }
    if (this.dim === 'end') return { mat: M[S.deep] };
    // 主世界
    const nearSea = top >= this.sea - 1;
    if (nearSea && depth < 3 && top > this.sea) return this.seabed(c, r, top, depth); // 水底：沙子里夹着沙砾、黏土
    const bad = this.peakKind === 'badlands' && !nearSea && this.badlandsAt(c); // 沙漠旁边的恶地
    const peak = this.isPeak(top);
    const stony = (k) => ({ mat: this.peakKind === 'stony' && vnoise(c * 0.2, y * 0.6, s + 57) > k ? M.calcite : M.stone }); // 石峰夹着方解石
    if (depth === 0) {
      if (nearSea) return { mat: M.sand };
      if (bad) return steep >= 3 || peak ? this.terracotta(c, r) : { mat: M.redSand };
      if (peak) return this.peakKind === 'snow' ? { mat: M.snow, snowCap: true } : stony(0.8); // 表面的方解石少一些，不然远看像积雪
      if (steep >= 3 && this.mountK) return stony(0.84);
      return { mat: M[S.top] };
    }
    if (depth < 3) {
      if (nearSea) return { mat: M.sand };
      if (bad) return steep >= 3 || peak || depth === 2 ? this.terracotta(c, r) : { mat: M.redSand };
      // 冰封山峰（雪原的山）：雪下面夹着浮冰
      if (peak && this.sceneId === 'snowy') return { mat: vnoise(c * 0.3, y * 0.5, s + 56) > 0.5 ? M.packedIce : M.snow };
      if (peak || (steep >= 3 && this.mountK)) return stony(0.8);
      if (this.sceneId === 'snowy' && depth === 1) return { mat: M.dirt };
      return { mat: M[S.under] };
    }
    // 洞穴：繁茂洞穴、溶洞、发光地衣（scenecave.js）
    if (this.isCave(c, r, depth)) return this.caveCell(c, r, top, depth);
    // 繁茂洞穴的苔藓地面、溶洞的滴水石块
    const wall = this.caveWall(c, r, top, depth);
    if (wall) return wall;
    if (bad && r < this.baseRow + 6) return this.terracotta(c, r); // 恶地的陶瓦一直到山脚下几格，再往下是石头
    if (S.ocean && !S.isle && r < this.sea + 8) return { mat: M.sandstone }; // 海里的小岛是砂岩，不是一根石柱
    const deep = r >= this.baseRow + DEEP + Math.floor(hash(c, 0, s + 5) * 3);
    let mat = deep ? M.deepslate : depth < 8 && S.deep === 'sandstone' && !bad ? M.sandstone : M.stone;
    // 一小团一小团的花岗岩、闪长岩、安山岩、沙砾、泥土（深板岩层里是凝灰岩）
    if (deep) { if (vnoise(c * 0.2, y * 0.24, s + 51) > 0.86) mat = M.tuff; }
    else {
      const b = vnoise(c * 0.2, y * 0.24, s + 31);
      if (b > 0.87) mat = M.granite;
      else if (b < 0.1) mat = M.diorite;
      else if (vnoise(c * 0.2, y * 0.24, s + 37) > 0.88) mat = M.andesite;
      else if (depth < 30 && vnoise(c * 0.24, y * 0.28, s + 43) > 0.9) mat = M.gravel;
      else if (depth < 40 && vnoise(c * 0.24, y * 0.28, s + 47) > 0.91) mat = M.dirt;
    }
    // 矿石：2×2 的矿脉里随机几格。1.10.3 按原版的高度分布重排（基准地面约是 y=64，到基岩 96 格 ≈ 原版 128 格）：
    // 煤只在 y=0 以上；铁到处有，山里还有一层；铜在中层；金在深处（恶地的山里也有）；红石、钻石在 y=16 以下、越深越多；
    // 绿宝石只在雪山、石峰里（恶地没有）。每种矿占自己的一段，条件不满足就空着，不再让给下一种
    const hh = hash(c >> 1, y >> 1, s + 77);
    if (hh < 0.0475 && hash(c, y, s + 78) < 0.55) {
      const d = y;
      const lucky = hash(c, y, s + 79);
      let ok = false;
      let ore = null;
      if (hh < 0.016) { ore = 'coal'; ok = d < 48; }
      else if (hh < 0.026) { ore = 'iron'; ok = d > 4 || (this.mountK > 0 && d < -12); }
      else if (hh < 0.032) { ore = 'copper'; ok = d > -10 && d < 60; }
      else if (hh < 0.036) { ore = 'gold'; ok = d > 40 || (bad && d < 10); }
      else if (hh < 0.041) { ore = 'redstone'; ok = d > 37 && (d > 62 || lucky < 0.5); }
      else if (hh < 0.044) { ore = 'lapis'; ok = d > 30; }
      else if (hh < 0.0465) { ore = 'diamond'; ok = d > 48 && (d > 72 || lucky < 0.35); }
      else { ore = 'emerald'; ok = this.mountK > 0 && !bad && d < -6 && lucky < 0.25; }
      if (ok) return { mat, ore };
    }
    return { mat };
  };

  /** 把一块画到它自己的画布上（逐像素写 ImageData，比 fillRect 快得多） */
  P.renderChunk = function (ch) {
    const { B } = this;
    const end = this.dim === 'end';
    const structs = this.structsIn(ch.c0, ch.c0 + CH - 1);
    let rTop = Infinity;
    let rBot = -Infinity;
    // 每列从哪一行画起：地面，或者更高的结构（海底神殿、沉船立在水里）
    const starts = [];
    const bottoms = ch.hs.map((top, k) => {
      starts.push(top);
      const c = ch.c0 + k;
      let sb = -Infinity;
      for (const s of structs) if (c >= s.c0 && c <= s.c1) { if (s.r0 < starts[k]) starts[k] = s.r0; sb = Math.max(sb, s.r1 + 1); }
      if (top > 900) {
        // 虚空上面也可能有结构（末地船浮在半空，sceneend.js）
        if (sb === -Infinity) return top;
        rTop = Math.min(rTop, starts[k]); rBot = Math.max(rBot, sb);
        return sb;
      }
      rTop = Math.min(rTop, starts[k]);
      // 末地的岛底：主岛中间厚（sceneend.js 的 endBottom），外岛薄薄一层
      const b = end ? (this.endBottom ? this.endBottom(c, top) : Math.min(this.wr + this.lift, top + 4 + Math.floor(hash(ch.c0 + k, 3, 7) * 5))) : this.BOT + 1;
      rBot = Math.max(rBot, b);
      return b;
    });
    ch.lava = [];
    ch.cwater = [];
    ch.wset = null; // fluidAt 的查找表，下次用到时按新的 cwater 重建（scenecave.js）
    ch.fx = [];
    ch.palV = this.palV;
    ch.dirty = false;
    if (rTop === Infinity) { ch.canvas = null; return; }
    const w = CH * B;
    const hgt = (rBot - rTop) * B;
    if (!ch.canvas || ch.canvas.width !== w || ch.canvas.height !== hgt) {
      ch.canvas = document.createElement('canvas');
      ch.canvas.width = w; ch.canvas.height = hgt;
    }
    const g = ch.canvas.getContext('2d');
    const img = g.createImageData(w, hgt);
    const data = img.data;
    const Pl = this.P;
    // 地下的光照不跟着昼夜变（晚上看地下也看得清），越往下越接近白天的亮度
    const over = this.dim === 'over';
    const tint = (c, k, d) => {
      const u = over && d ? smooth((d - 3) / 10) : 0;
      const L = Pl.light + (1 - Pl.light) * u;
      const t = mix(c, Pl.tint, 0.25 * (1 - u));
      return [t[0] * L * k, t[1] * L * k, t[2] * L * k];
    };
    const put = (x, y, col) => { const i = (y * w + x) * 4; data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = 255; };
    for (let k = 0; k < CH; k++) {
      const top = ch.hs[k];
      if (top > 900 && starts[k] > 900) continue;
      const c = ch.c0 + k;
      const steep = Math.abs(this.colHeight(c - 1) - top) + Math.abs(this.colHeight(c + 1) - top);
      for (let r = starts[k]; r < bottoms[k]; r++) {
        const depth = Math.max(0, r - top);
        let cell = structs.length ? this.structCell(structs, c, r, top) : undefined;
        if (cell === undefined) cell = r < top ? null : this.cellAt(c, r, top, steep);
        if (this.envMods && this.envMods.size && cell) cell = this.envPatch(cell, c, r); // 被点过的格子：浆果摘了、藤蔓在摆、箱子开着（sceneinteract.js）
        if (!cell) continue;
        // 地表附近亮，越深越暗；洞穴是更暗的背景墙
        const base = 1 - Math.min(0.35, depth * 0.03) - Math.min(0.12, Math.max(0, depth - 12) * 0.002);
        const shade = cell.cave ? base * 0.55 : base;
        if (cell.lava) ch.lava.push([c, r]);
        if (cell.cwater) ch.cwater.push([c, r, cell.surf]);
        if (cell.fx) ch.fx.push([c, r, cell.fx]);
        const bx = c * B; const by = r * B;
        const ore = cell.ore && ORE[cell.ore];
        const palt = cell.mat;
        if (palt) {
          for (let py = 0; py < B; py++) {
            for (let px = 0; px < B; px++) {
              let col = palt[Math.floor(hash(bx + px, by + py, palt.length) * palt.length)];
              let lit = shade;
              if (ore && hash(bx + (px & ~1), by + (py & ~1), 61) < 0.45) {
                col = ore[Math.floor(hash(bx + px, by + py, 62) * ore.length)];
                lit = Math.max(shade, GLOW_ORE[cell.ore] ? shade + GLOW_ORE[cell.ore] : shade);
              }
              // 自己发光的方块（海晶灯、紫水晶）不受昼夜和深度影响
              put(k * B + px, (r - rTop) * B + py, cell.glow ? col : tint(col, lit, depth));
            }
          }
        }
        // 小装饰比背景墙亮一些，看得清
        const draw = cell.deco && DECO[cell.deco];
        if (draw) draw((px, py, col, glow) => put(k * B + px, (r - rTop) * B + py, glow ? col : tint(col, base * 0.9, depth)), cell, c, r, B);
        // 雪原、雪顶的上沿一条白边
        if (r === top && (this.sceneId === 'snowy' || cell.snowCap) && !cell.cave) { const wc = tint(hex('#ffffff'), 1); for (let px = 0; px < B; px++) put(k * B + px, (r - rTop) * B, wc); }
      }
    }
    g.putImageData(img, 0, 0);
    ch.rTop = rTop;
  };

  /** 有改动的块重画；换了时段（palV 变了）的块全部重画 */
  P.renderLand = function () {
    if (!this.chunks) return;
    for (const ch of this.chunks.values()) if (ch.dirty || ch.palV !== this.palV) this.renderChunk(ch);
    const fluid = this.dim === 'nether' ? hex('#e8641a') : hex('#3468ce');
    this.FLUID = this.dim === 'nether' ? fluid : this.tint(fluid);
    this.LAVA = hex('#e8641a');
  };

  /** 画视野里的块、水和洞穴岩浆 */
  /** 视野里每个水柱（海面到水底）：fn(列, 水底行) */
  P.eachWaterCol = function (fn) {
    if (this.sea > 900 || !this.visChunks) return;
    for (const ch of this.visChunks) {
      for (let k = 0; k < CH; k++) {
        const top = ch.hs[k];
        if (top > this.sea && top < 900) fn(ch.c0 + k, top);
      }
    }
  };

  /** 画视野里的块和洞穴岩浆；水分两层：不透明的水下底色在这里，半透明的水面在 drawFluid（水里的东西夹在中间） */
  P.drawWorld = function (lx, ly) {
    const { ctx, B } = this;
    const { rgb } = A.sceneKit;
    const span = CH * B;
    const v0 = Math.floor((this.cam.x - 40) / span);
    const v1 = Math.floor((this.cam.x + this.W + 40) / span);
    const vis = [];
    for (let ci = v0; ci <= v1; ci++) {
      const ch = this.chunks.get(ci);
      if (!ch) continue;
      if (ch.dirty || ch.palV !== this.palV) this.renderChunk(ch);
      vis.push(ch);
    }
    this.visChunks = vis;
    const lavaSea = this.dim === 'nether';
    const y0 = ly + this.sea * B;
    if (!lavaSea && this.sea < 900 && y0 < this.H) {
      // 水下的底色：挡住后面的天空和远山，越深越暗
      const g = ctx.createLinearGradient(0, y0, 0, y0 + this.rows * B);
      g.addColorStop(0, rgb(mix(this.FLUID, [255, 255, 255], 0.12)));
      g.addColorStop(0.35, rgb(mix(this.FLUID, [6, 14, 40], 0.3)));
      g.addColorStop(1, rgb(mix(this.FLUID, [4, 8, 24], 0.78)));
      ctx.fillStyle = g;
      this.eachWaterCol((c, top) => ctx.fillRect(lx + c * B, y0, B, (top - this.sea) * B));
    }
    for (const ch of vis) if (ch.canvas) ctx.drawImage(ch.canvas, lx + ch.c0 * B, ly + ch.rTop * B);
    const yMin = this.cam.y - B * 2; const yMax = this.cam.y + this.H + B * 2;
    for (const ch of vis) {
      // 下界的岩浆海（不透明，在生物前面画也没关系：炽足兽站在表面上）
      if (lavaSea) {
        for (const [i, r, surface] of ch.water) {
          if (r * B < yMin || r * B > yMax) continue;
          ctx.fillStyle = rgb(this.FLUID);
          ctx.fillRect(lx + i * B, ly + r * B, B, B);
          if (surface && Math.sin(this.t * 0.003 + i * 0.9) > 0.55) { ctx.fillStyle = 'rgba(255,230,120,0.6)'; ctx.fillRect(lx + i * B + 1, ly + r * B, 2, 1); }
        }
      }
      // 洞穴深处的岩浆湖（自己发光，不受昼夜影响）
      for (const [i, r] of ch.lava) {
        if (r * B < yMin || r * B > yMax) continue;
        const k = Math.sin(this.t * 0.002 + i * 0.7 + r * 1.3);
        ctx.fillStyle = rgb(mix(this.LAVA, [255, 200, 80], Math.max(0, k) * 0.35));
        ctx.fillRect(lx + i * B, ly + r * B, B, B);
      }
    }
    // 地下湖、裂谷底的积水（1.10.1）：半透明的水，水面有波光
    for (const ch of vis) {
      for (const [i, r, surf] of ch.cwater || []) {
        if (r * B < yMin || r * B > yMax) continue;
        ctx.fillStyle = 'rgba(46,92,200,0.62)';
        ctx.fillRect(lx + i * B, ly + r * B, B, B);
        if (surf) {
          ctx.fillStyle = 'rgba(120,170,255,0.75)';
          ctx.fillRect(lx + i * B, ly + r * B, B, 1);
          if (Math.sin(this.t * 0.003 + i * 0.9) > 0.6) { ctx.fillStyle = 'rgba(220,235,255,0.7)'; ctx.fillRect(lx + i * B + 1, ly + r * B, 2, 1); }
        }
      }
    }
    // 每帧动的效果：刷怪笼、滴水、紫水晶闪光、洞穴瀑布（瀑布从屏幕上方落下来时也要画）
    const now = performance.now();
    for (const ch of vis) {
      for (const [c, r, name] of ch.fx) {
        if (r * B < (name === 'fall' || name === 'lavafall' ? yMin - 48 * B : yMin) || r * B > yMax || !FX[name]) continue;
        FX[name].call(this, lx + c * B, ly + r * B, now, c, r);
      }
    }
  };

  /** 半透明的水（在生物、海草之后画，水里的东西都蒙上一层蓝），然后是海面的波光和水下的光（sceneocean.js） */
  P.drawFluid = function (lx, ly, now) {
    if (this.sea > 900 || this.dim === 'nether' || !this.visChunks) return;
    const { ctx, B } = this;
    const { rgb } = A.sceneKit;
    const y0 = ly + this.sea * B;
    if (y0 > this.H) return;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + this.rows * B * 0.8);
    g.addColorStop(0, rgb(this.FLUID, 0.2));
    g.addColorStop(1, rgb(mix(this.FLUID, [4, 10, 30], 0.6), 0.6));
    ctx.fillStyle = g;
    this.eachWaterCol((c, top) => ctx.fillRect(lx + c * B, y0, B, (top - this.sea) * B));
    // 海面：一条亮边 + 闪烁的波光；雪原的湖面结冰
    const snowy = this.sceneId === 'snowy';
    this.eachWaterCol((c) => {
      const x = lx + c * B;
      // c & 1：列号是负的奇数时 c % 2 是 -1，取不到颜色，画这一帧就报错、背景停住（rc9）
      if (snowy) { ctx.fillStyle = this.color(M.ice[c & 1]); ctx.fillRect(x, y0, B, 1); return; }
      ctx.fillStyle = rgb(mix(this.FLUID, [255, 255, 255], 0.35), 0.75);
      ctx.fillRect(x, y0, B, 1);
      if (Math.sin(this.t * 0.003 + c * 0.9) > 0.55) { ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(x + 1, y0, 2, 1); }
    });
    if (this.drawSea) this.drawSea(lx, ly, now);
  };

  /** 视野里的水（水生生物、船只在这里生成） */
  P.viewWater = function () {
    const x0 = this.cam.x; const x1 = x0 + this.W; const B = this.B;
    return this.water.filter((w) => w[0] * B >= x0 && w[0] * B < x1 && w[1] * B >= this.cam.y - B && w[1] * B < this.cam.y + this.H);
  };

  /** 这个位置所在的块已经生成了（生物不走出已生成的范围） */
  P.loadedAt = function (x) { return this.chunks.has(Math.floor(x / (CH * this.B))); };

  // ───────────── 视角 ─────────────

  /** 视角能到的范围：上面留出高山，下面到基岩 */
  P.camBounds = function () {
    const { B } = this;
    // 往上最多看到附近最高的山顶再多一点天空；没有山就只能往上一点点
    let top = Infinity;
    const c0 = Math.floor((this.cam.x - this.W * 0.5) / B); const c1 = Math.floor((this.cam.x + this.W * 1.5) / B);
    for (let c = c0; c <= c1; c += 2) { const h = this.colHeight(c); if (h < top) top = h; }
    const minY = Math.min(0, top * B - this.H * 0.3);
    const maxY = this.BOT != null ? Math.max(0, (this.BOT + 1) * B - this.H) : this.H * 0.3;
    return { minY, maxY };
  };

  /** 每帧：边缘停留平移、平滑跟随、生成需要的块 */
  P.camTick = function (dt, now) {
    const cam = this.cam;
    const sec = dt / 1000;
    const e = this.edge;
    if (e && !this.drag && now - e.since > 450) {
      const ramp = Math.min(1, (now - e.since - 450) / 700);
      const speed = 95 * ramp; // 画布像素 / 秒
      cam.tx += e.dx * speed * sec;
      cam.ty += e.dy * speed * sec;
    }
    const { minY, maxY } = this.camBounds();
    cam.ty = Math.max(minY, Math.min(maxY, cam.ty));
    const k = this.drag ? 1 : Math.min(1, sec * 7);
    cam.x += (cam.tx - cam.x) * k;
    cam.y += (cam.ty - cam.y) * k;
    if (Math.abs(cam.tx - cam.x) < 0.05) cam.x = cam.tx;
    if (Math.abs(cam.ty - cam.y) < 0.05) cam.y = cam.ty;
    // 回到地面时缩放带来的平移也归零（scene.js applyZoom），远景回到打开时的位置
    if (!cam.tx && !cam.ty && this.zoomT === 1 && (this.zx || this.zy)) {
      this.zx += (0 - this.zx) * k; this.zy += (0 - this.zy) * k;
      if (Math.abs(this.zx) < 0.05) this.zx = 0;
      if (Math.abs(this.zy) < 0.05) this.zy = 0;
    }
    this.ensureChunks(false);
    const away = Math.abs(cam.x) > this.W * 0.25 || Math.abs(cam.y) > this.H * 0.2 || Math.abs(this.zoomT - 1) > 0.01;
    if (away !== this.camAway) { this.camAway = away; if (this.onCam) this.onCam(away); }
  };

  /**
   * 边缘感应带的几何（屏幕坐标）：r 画布、top 上边感应带从哪里开始、hgt 从 top 到画布底、zx / zy 左右 / 上下感应带占的比例。
   * 上边从顶栏的下沿算起（1.7.0）：顶栏是拖动窗口的区域，鼠标在上面时网页收不到移动事件。调试菜单的「显示边缘平移范围」也用它画。
   * 下边（rc3）：从启动栏顶边再往上一条（和上边一样宽）开始，一直到窗口底部都算；启动栏、「回到地面」按钮是界面，home.js 不转过来。
   * 以前是画布最下面 10%，画布比窗口大一圈、启动栏又盖住了大半，几乎碰不到。bot：下边感应带从哪里开始；dockTop 由 home.js 给
   */
  P.edgeZones = function () {
    const r = this.canvas.getBoundingClientRect();
    const now = performance.now();
    if (!this._cover || now - this._cover.at > 1000) this._cover = { at: now, px: this.topCover() };
    const top = r.top + this._cover.px;
    const hgt = r.bottom - top;
    const zy = 0.1;
    const floor = Math.min(r.bottom, window.innerHeight || r.bottom);
    const dock = this.dockTop ? this.dockTop() : null;
    const bot = (dock != null && dock > top ? Math.min(dock, floor) : floor) - hgt * zy;
    return { r, top, hgt, bot, floor, cover: this._cover.px, zx: 0.07, zy };
  };

  /** 鼠标停在画面边缘：dx / dy 是 -1~1（越靠边越快），null 表示离开了边缘 */
  P.panEdge = function (clientX, clientY) {
    if (!this.opts.pan || this.frozen || !this.W) { this.edge = null; return; }
    const { r, top, hgt, bot, zx, zy } = this.edgeZones();
    const fx = (clientX - r.left) / r.width;
    const fy = (clientY - top) / hgt;
    const band = hgt * zy;
    const dx = fx < zx ? -(1 - fx / zx) : fx > 1 - zx ? (fx - (1 - zx)) / zx : 0;
    const dy = fy < zy ? -(1 - Math.max(0, fy) / zy) : clientY > bot ? Math.min(1, (clientY - bot) / band) : 0;
    if (!dx && !dy) { this.edge = null; return; }
    const sx = Math.sign(dx); const sy = Math.sign(dy);
    if (!this.edge || Math.sign(this.edge.dx) !== sx || Math.sign(this.edge.dy) !== sy) this.edge = { dx, dy, since: performance.now() };
    else { this.edge.dx = dx; this.edge.dy = dy; }
  };
  P.panStop = function () { this.edge = null; };

  /** 按住空白处拖动：start → move（屏幕像素）→ end 返回有没有真的拖动（拖过就不算点击） */
  P.panDragStart = function (clientX, clientY) {
    if (!this.opts.pan || this.frozen || !this.W) return false;
    this.drag = { x: clientX, y: clientY, cx: this.cam.tx, cy: this.cam.ty, moved: false };
    return true;
  };
  P.panDragMove = function (clientX, clientY) {
    const d = this.drag;
    if (!d) return;
    const r = this.canvas.getBoundingClientRect();
    const kx = this.W / r.width; const ky = this.H / r.height;
    const mx = clientX - d.x; const my = clientY - d.y;
    if (!d.moved && Math.hypot(mx, my) < 5) return;
    d.moved = true;
    this.edge = null;
    this.cam.tx = d.cx - mx * kx;
    this.cam.ty = d.cy - my * ky;
  };
  P.panDragEnd = function () {
    const moved = !!(this.drag && this.drag.moved);
    this.drag = null;
    return moved;
  };

  /** 回到打开时的位置（地面） */
  P.camHome = function () { this.cam.tx = 0; this.cam.ty = 0; this.edge = null; this.zoomT = 1; this.zoomAt = null; if (this.frozen && !this.running) { this.applyZoom(1); this.zx = 0; this.zy = 0; this.draw(16); } };
})();
