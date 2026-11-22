'use strict';
/**
 * 主页动态像素风景
 * - 多种场景：平原、森林、沙漠、雪原、海洋、樱花林、蘑菇岛、下界、末地
 * - 随真实时间变化的天空；敌对生物只在夜晚出现，白天会燃烧消失
 * - 生物按维度与生态生成；玩家会砍树、搭建筑、进出小屋（仅主世界），小屋夜晚亮灯
 * - 罕见彩蛋：流星、jeb_ 彩虹羊、Dinnerbone、Herobrine、幻翼、末影龙、点击互动、Konami 烟花、节日主题
 *
 * 这个文件是场景的主体（尺寸、视角、世界、每帧的绘制）。工具和材质在 scenekit.js，生物在 sceneents.js，事件在 sceneevents.js，画东西在 scenedraw.js
 */
(function () {
  const { mulberry, hash, mix, rgb, hex, pick, SKIES, periodFor, M, SPRITES, SCENES, sceneFor, festival, DEFAULTS, FX_K } = A.sceneKit;

  class Scene {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.PX = 4;
      this.B = 4;
      // 滚轮缩放（1.6.0）：W0 / H0 是布局尺寸（生成世界用，和缩放无关），W / H 是视野 = 布局 ÷ zoom（画布分辨率、剔除、刷怪都用它）
      this.zoom = 1;
      this.zoomT = 1;
      this.zoomAt = null;
      this.W0 = 0;
      this.H0 = 0;
      this.running = false;
      this.opts = { ...DEFAULTS };
      this.mouse = { x: 0, y: 0, tx: 0, ty: 0 };
      this.t = 0;
      this.last = 0;
      this.seed = Math.floor(Date.now() / 86400000);
      this.ents = [];
      this.parts = [];
      this.events = [];
      this.tintCache = new Map();
      this.konami = [];
      this._onMove = (e) => {
        const r = this.canvas.getBoundingClientRect();
        this.mouse.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
        this.mouse.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
        this.mouse.cx = e.clientX; this.mouse.cy = e.clientY;
      };
      this._onKey = (e) => this.onKey(e);
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }

    setMode(m) { this.setOptions({ time: m }); }

    /** 特效档位的系数：1 全开、0.5 一半、0 只留必要的 */
    get fxK() { const k = FX_K[this.opts.fx]; return k == null ? 1 : k; }

    setOptions(o) {
      const prev = this.opts;
      this.opts = { ...DEFAULTS, ...this.opts, ...(o || {}) };
      if (!prev || prev.scene !== this.opts.scene || prev.time !== this.opts.time || prev.buildings !== this.opts.buildings) { this.ents = []; this.parts = []; this.build(); }
      else { this.ents = this.ents.filter((e) => this.allowed(e.kind)); this.dropStale(); }
      // 定格的画面（性能模式、减少动态效果）换场景后重画这一帧
      if (this.frozen && !this.running && this.W) this.draw(16);
    }

    /**
     * 窗口大小变了：拖动过程中画布按 CSS 拉伸着先用，停下 250ms 后再按新尺寸重建（1.5.10）。
     * 以前每变一格就清空生物、重建世界，拖窗口时生物一直闪。重建后还在画面里的生物和火把留下，放回新的地面上
     */
    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const w = Math.ceil(r.width / this.PX);
      const hgt = Math.ceil(r.height / this.PX);
      if (w === this.W0 && hgt === this.H0) return;
      clearTimeout(this._resizeT);
      if (!this.W) { this.applySize(w, hgt); return; }
      this._resizeT = setTimeout(() => this.resize2(), 250);
    }

    resize2() {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const w = Math.ceil(r.width / this.PX);
      const hgt = Math.ceil(r.height / this.PX);
      if (w === this.W0 && hgt === this.H0) return;
      const ents = this.ents;
      const torches = this.torches || [];
      const lift0 = this.lift || 0;
      this.applySize(w, hgt);
      // 世界本身不变（rc6 起），窗口高度变了只是整体上下挪了几行：生物跟着挪同样的距离，还在原来那块地方（rc14：
      // 以前生物留在旧的高度，鱼一下子全在水面上面被清掉、或者埋进海底，洞里的生物全被去掉）
      const dy = ((this.lift || 0) - lift0) * this.B;
      if (dy) for (const e of ents) { e.y += dy; if (e.ty != null) e.ty += dy; if (e.leap) e.leap.y0 += dy; }
      // 留下还在画面里的；树、建筑是新生成的对象，原来的砍树 / 盖房任务作废，改成随便走走
      const now = performance.now();
      this.ents = ents.filter((e) => {
        if (e.x < this.cam.x - 8 || e.x > this.cam.x + this.W + 8) return false;
        if (e.cave) return true;
        if (e.boat || e.spr.swims) return this.isWaterCol(e.x) && e.y > this.sea * this.B;
        if (e.spr.fly) return true;
        const gy = this.groundY(e.x);
        if (gy == null || this.isWaterCol(e.x)) return false;
        e.y = gy;
        if (e.task && (e.task.tree || e.task.build)) { e.task = null; e.state = 'walk'; e.until = now + 3000; }
        return true;
      });
      this.dropStale(); // 去掉了的生物，别的生物不要再盯着它、跟着它（sceneents.js）
      if (this.torches) {
        this.torches = torches.filter((t) => this.loadedAt(t.col * this.B) && this.heights[t.col] < 900 && !this.isWaterCol(t.col * this.B))
          .map((t) => ({ ...t, top: this.heights[t.col] }));
      }
      if (this.frozen && !this.running) this.draw(16);
    }

    applySize(w, hgt) {
      this.W0 = w; this.H0 = hgt;
      this.setView();
      this.ents = [];
      this.build();
      if (this.frozen && !this.running) this.draw(16);
    }

    // ───────────── 世界生成 ─────────────
    /** 按布局尺寸和缩放算视野，画布分辨率跟着变（一个场景像素始终是一个画布像素，像素画不会糊） */
    setView() {
      const w = Math.max(16, Math.round(this.W0 / this.zoom));
      const hgt = Math.max(16, Math.round(this.H0 / this.zoom));
      if (w === this.W && hgt === this.H && this.canvas.width === w) return;
      this.W = w; this.H = hgt;
      this.canvas.width = w; this.canvas.height = hgt;
    }

    /**
     * 滚轮缩放：factor > 1 放大；(u, v) 是鼠标在画面里的位置（0~1），缩放时鼠标下面那个点不动。
     * 0.75 ~ 2.5 倍：再小要画的东西太多，再大像素太粗
     */
    zoomBy(factor, u = 0.5, v = 0.5) {
      if (!this.W0) return;
      this.zoomT = Math.max(0.75, Math.min(2.5, this.zoomT * factor));
      this.zoomAt = [u, v];
      if (this.frozen && !this.running) { this.applyZoom(this.zoomT); this.draw(16); }
    }

    applyZoom(z) {
      const oldW = this.W; const oldH = this.H;
      this.zoom = z;
      this.setView();
      if (!this.cam) return;
      const [u, v] = this.zoomAt || [0.5, 0.5];
      const dx = u * (oldW - this.W); const dy = v * (oldH - this.H);
      this.cam.x += dx; this.cam.y += dy;
      // 缩放带来的平移单独记下（zx / zy）：远景、天空在缩放时和地形一起移，只有拖动视角时才按视差慢慢移。
      // 以前远景也按视差算缩放的平移，缩放时山和地形错开，山脚还会露出来
      this.zx = (this.zx || 0) + dx; this.zy = (this.zy || 0) + dy;
      // 回到地面（zoomAt = null）时目标就是原点，不跟着挪
      if (this.zoomAt) { this.cam.tx += dx; this.cam.ty += dy; }
    }

    build() {
      if (!this.W) return;
      const { W0: W, H0: Hh, B } = this;
      this.sceneId = sceneFor(this.opts.scene, this.seed);
      const S = SCENES[this.sceneId];
      this.S = S;
      this.dim = S.dim;
      this.fest = festival();
      this.period = S.dim === 'nether' ? 'nether' : S.dim === 'end' ? 'end' : periodFor(this.opts.time);
      this.events = [];
      this.parts = [];
      this.arrows = []; // 箭和掉落物（scenefight.js）
      this.torches = []; // 玩家夜里插的火把（scenetorch.js），插了就一直留着
      this.drops = [];
      this.setPalette();
      const rnd = mulberry(this.seed * 31 + this.sceneId.length * 7);
      this.rnd = mulberry(Date.now() & 0xffffff);

      this.cols = Math.ceil((W + 32) / B) + 1;
      this.rows = Math.ceil(Hh / B);
      this.initWorld(rnd); // 无限世界，见 sceneworld.js
      // 缩放着换了场景（视角刚回到原点）：让视野的中心对准打开时那一屏的中心
      const cm = this.cam;
      if (!cm.x && !cm.y && !cm.tx && !cm.ty) {
        const ox = (this.W0 - this.W) / 2; const oy = (this.H0 - this.H) / 2;
        Object.assign(cm, { x: ox, tx: ox, y: oy, ty: oy });
        this.zx = ox; this.zy = oy;
      }
      this.paint();

      // 云
      this.clouds = [];
      if (this.dim === 'over') {
        const n = Math.max(4, Math.round(W / 70));
        for (let i = 0; i < n; i++) {
          const cw = 5 + Math.floor(rnd() * 7);
          const rects = [[0, 1, cw, 1]];
          const tw = Math.max(2, cw - 2 - Math.floor(rnd() * 3));
          rects.push([1 + Math.floor(rnd() * Math.max(1, cw - tw - 1)), 0, tw, 1]);
          if (rnd() < 0.5) rects.push([Math.floor(cw * 0.4), 2, Math.max(2, Math.floor(cw * 0.5)), 1]);
          const farC = rnd() < 0.45;
          this.clouds.push({ x: rnd() * (W + 60) - 30, y: Hh * 0.11 + rnd() * Hh * 0.22, rects, w: cw, speed: farC ? 0.35 + rnd() * 0.3 : 0.7 + rnd() * 0.6, bw: farC ? 4 : 6, bh: farC ? 2 : 3, alpha: farC ? 0.62 : 0.9 });
        }
        this.clouds.sort((a, b) => a.bw - b.bw);
      }
      this.nextSpawn = 0;
      this.nextEvent = 8000 + this.rnd() * 15000;
      this.draw(0);
      A.emit('scene', this.info()); // 背景音乐据此切换主题曲
    }

    setPalette() {
      const P = {};
      for (const [k, v] of Object.entries(SKIES[this.period])) P[k] = typeof v === 'string' ? hex(v) : v;
      if (this.S.warm && this.period === 'day') P.hor = mix(P.hor, hex('#ffe3b0'), 0.5);
      if (this.sceneId === 'snowy' && this.period === 'day') P.hor = mix(P.hor, hex('#eef6ff'), 0.4);
      this.P = P;
      this.palV = (this.palV || 0) + 1; // 已生成的块按新的光照重画
      this.tintCache.clear();
    }

    /** 绘制天空、远景与地形贴图（时段变化时只需重绘这些，世界保持不变） */
    paint() {
      const { W0: W, H0: Hh, P } = this;
      const rnd = mulberry(this.seed * 13 + 5);
      // 天空（1.7.0 改）：竖直渐变只画一列，绘制时横向拉满整个视野；噪点和星星放在能横向循环的贴图里，
      // 太阳单独画在视野中间。以前整张天空图按布局宽度画，滚轮缩小后两边是拉伸边缘像素的条纹
      const sky = document.createElement('canvas');
      sky.width = 1; sky.height = Hh;
      const s = sky.getContext('2d');
      for (let y = 0; y < Hh; y++) {
        const t = y / (Hh * 0.72);
        const c = t < 0.55 ? mix(P.top, P.mid, t / 0.55) : mix(P.mid, P.hor, Math.min(1, (t - 0.55) / 0.45));
        s.fillStyle = rgb(c);
        s.fillRect(0, y, 1, 1);
      }
      const SW = Math.ceil((W * 2) / 4) * 4;
      const noise = document.createElement('canvas');
      noise.width = SW; noise.height = Hh;
      const ns = noise.getContext('2d');
      for (let i = 0; i < SW * Hh * 0.04; i++) {
        ns.fillStyle = `rgba(255,255,255,${0.02 + rnd() * 0.03})`;
        ns.fillRect((rnd() * SW) | 0, (rnd() * Hh * 0.75) | 0, 1, 1);
      }
      this.sky = sky;
      this.skyNoise = noise;
      this.sun = null;
      if (P.sun) {
        const sunX = Math.round(W * (this.period === 'sunset' ? 0.56 : this.period === 'dawn' ? 0.4 : this.period === 'night' ? 0.6 : 0.52));
        const sunY = Math.round(Hh * (this.period === 'sunset' || this.period === 'dawn' ? 0.36 : 0.17));
        this.sun = { x: sunX, y: sunY, sz: Math.max(8, Math.round(W / 34)) };
      }
      this.ceil = this.dim === 'nether' ? this.netherCeiling() : null;
      this.stars = [];
      this.starW = SW;
      if (P.stars) for (let i = 0; i < (SW * Hh) / 260; i++) this.stars.push({ x: rnd() * SW, y: rnd() * Hh * 0.6, p: rnd() * Math.PI * 2, s: rnd() < 0.12 ? 2 : 1 });

      // 远景
      // 远景横向会循环拼接（视角能左右移动）：宽两屏，频率取整到能首尾相接
      const FW = Math.ceil(((W + 24) * 2) / 12) * 12;
      const per = (f) => (2 * Math.PI * Math.max(1, Math.round((f * FW) / (2 * Math.PI)))) / FW;
      // 远景画到两倍布局高：滚轮缩小、视野比布局大时，山脚下面不会露出天空
      const FH = Hh * 2;
      const far = (layerSeed, base, amp, color, bw, tops) => {
        const c = document.createElement('canvas');
        c.width = FW; c.height = FH;
        const g = c.getContext('2d');
        const r2 = mulberry(this.seed + layerSeed);
        const o1 = r2() * 100; const o2 = r2() * 100; const o3 = r2() * 100;
        const f1 = per(0.018); const f2 = per(0.041); const f3 = per(0.093);
        for (let x = 0; x < FW; x += bw) {
          const n = Math.sin(x * f1 + o1) * 0.5 + Math.sin(x * f2 + o2) * 0.3 + Math.sin(x * f3 + o3) * 0.2;
          const top = Math.round((Hh * base - n * Hh * amp) / bw) * bw;
          if (tops) for (let k = 0; k < bw; k++) tops[x + k] = top;
          if (this.S.ocean && n < 0.25) continue; // 海洋：海平线上只有零星的远岛
          if (this.dim === 'end') {
            // 末地：远处漂浮的小岛
            if (n > 0.35) { g.fillStyle = rgb(color); g.fillRect(x, top, bw, Math.max(bw, (n - 0.35) * Hh * 0.2)); }
            continue;
          }
          g.fillStyle = rgb(color);
          g.fillRect(x, top, bw, FH - top);
          const capped = this.period !== 'night' && this.dim === 'over' && (n > 0.62 || this.sceneId === 'snowy');
          if (capped) { g.fillStyle = rgb(mix(color, [255, 255, 255], 0.55)); g.fillRect(x, top, bw, bw); }
        }
        return c;
      };
      const farColor = this.sceneId === 'desert' ? mix(P.far, hex('#d8bf86'), 0.45) : this.sceneId === 'cherry' ? mix(P.far, hex('#e8a8c8'), 0.25) : mix(P.far, P.hor, 0.35);
      this.farTops = [];
      // 远山跟着地面一起放高（主世界的地面比场景表里的 base 高 base - base0，rc7）
      const up = this.S.base - (this.base0 == null ? this.S.base : this.base0);
      const sea = this.S.ocean ? this.water0 : 0;
      this.far = far(11, sea ? sea + 0.02 : 0.5 - up, sea ? 0.08 : 0.13, farColor, 3, this.farTops);
      this.mid = far(23, sea ? 2 : 0.58 - up, 0.1, mix(P.mid2, P.far, 0.2), 4);
      this.renderLand();
    }

    makeTree(kind, col, top, rnd) {
      const tr = { kind, col, top, trunk: 3 + Math.floor(rnd() * 2), alive: true, grow: 1, hp: 6 };
      if (kind === 'spruce') tr.trunk = 4 + Math.floor(rnd() * 2);
      if (kind === 'redMushroom' || kind === 'brownMushroom') tr.trunk = 3 + Math.floor(rnd() * 2);
      if (kind === 'darkOak') tr.trunk = 4 + Math.floor(rnd() * 2);
      if (kind === 'chorus') tr.trunk = 3 + Math.floor(rnd() * 4);
      if (kind === 'crimson' || kind === 'warped') tr.trunk = 3 + Math.floor(rnd() * 4);
      if (kind === 'jungle') tr.trunk = 7 + Math.floor(rnd() * 4);
      if (kind === 'jungleBush') tr.trunk = 1;
      tr.seed = Math.floor(rnd() * 1e6);
      return tr;
    }

    tint(c, k = 1) {
      const P = this.P;
      const t = mix(c, mix(c, P.tint, 0.25), 1);
      return [t[0] * P.light * k, t[1] * P.light * k, t[2] * P.light * k];
    }

    /** 绘制一个带随机纹理的方块（位置决定纹理，可重复重绘） */
    block(g, bx, by, palette, shade = 1, glow = false) {
      const B = this.B;
      for (let py = 0; py < B; py++) {
        for (let px = 0; px < B; px++) {
          const c = palette[Math.floor(hash(bx + px, by + py, palette.length) * palette.length)];
          g.fillStyle = rgb(glow ? c : this.tint(c, shade));
          g.fillRect(bx + px, by + py, 1, 1);
        }
      }
    }

    /** 画面顶上被界面盖住的高度（屏幕像素）：顶栏，像素原版主题还有顶栏下面那排标签 */
    topCover() {
      const cr = this.canvas.getBoundingClientRect();
      let y = cr.top;
      for (const sel of ['.titlebar', '.sidebar']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        // 画布比窗口大一圈（往上超出 12px），所以按窗口顶端比，不按画布顶端
        if (r.height && r.top <= Math.max(y, 0) + 2 && r.width > cr.width * 0.5) y = Math.max(y, r.bottom);
      }
      return Math.max(0, y - cr.top);
    }

    /**
     * 下界顶上的岩层和萤石（1.7.0）：以前画在天空图里，不跟着拖动和缩放，颜色又暗，几乎只看得见萤石。
     * 现在是挂在世界上的一层（每 64 列循环的贴图），从被顶栏盖住的地方往下再露出 2~5 格，越往上越暗；
     * 世界第 0 行上面多画 12 行，再往上看是实心的下界岩
     */
    netherCeiling() {
      const { B } = this;
      const N = 64; const UP = 12;
      const cover = Math.ceil(this.topCover() / this.PX / B);
      const deep = cover + 6;
      const c = document.createElement('canvas');
      c.width = N * B; c.height = (UP + deep + 3) * B;
      const g = c.getContext('2d');
      for (let i = 0; i < N; i++) {
        const d = cover + 2 + Math.floor(hash(i, 1, 9) * 4);
        for (let r = 0; r < UP + d; r++) this.block(g, i * B, r * B, M.netherrack, 0.5 + 0.35 * Math.min(1, Math.max(0, (r - UP + 3) / (d + 3))));
        if (hash(i, 2, 9) < 0.14) {
          const n = 1 + Math.floor(hash(i, 3, 9) * 3);
          for (let k = 0; k < n; k++) this.block(g, i * B, (UP + d + k) * B, M.glowstone, 1, true);
        }
      }
      return { img: c, up: UP, fill: rgb(this.tint(M.netherrack[2], 0.5)) };
    }

    // ───────────── 生物生成规则 ─────────────
    isNight() { return this.period === 'night'; }

    allowed(kind) {
      const o = this.opts;
      const spr = SPRITES[kind];
      if (!spr) return ['player', 'boat'].includes(kind) ? o.players : true;
      const hostile = (this.S.hostile.includes(kind) || spr.hostile || spr.illager) && !this.S.animals.includes(kind);
      if (hostile && (o.peaceful || !o.monsters)) return false;
      if (spr.swims && !o.aquatic) return false;
      if (!hostile && !spr.swims && !o.animals) return false;
      return true;
    }

    groundY(x) {
      const h = this.heights[Math.floor(x / this.B)];
      return h > 900 ? null : h * this.B;
    }
    isWaterCol(x) {
      const c = Math.floor(x / this.B);
      const h = this.heights[c];
      return h !== undefined && h > this.sea && this.sea < 900;
    }

    /**
     * 画一帧。出错不往外抛（rc9）：以前画到一半报错，动画循环就不再继续，背景停在那里不动，
     * 切走再回来也一样（雪原结冰的湖在画面左边时就是这样）。现在记一次日志，下一帧照常画；drawErrors 给测试看
     */
    draw(dt) {
      try {
        this.drawFrame(dt);
      } catch (e) {
        this.drawErrors = (this.drawErrors || 0) + 1;
        if (this.drawErrors === 1) console.error('[scene] 画这一帧出错', e);
        try { this.ctx.globalAlpha = 1; } catch { /* 画布没了 */ }
      }
    }

    drawFrame(dt) {
      const { ctx, P } = this;
      if (!this.W || !this.sky) return;
      const now = performance.now();
      this.t += dt;
      if (dt) this.update(dt, now);
      this.mouse.x += (this.mouse.tx - this.mouse.x) * 0.05;
      this.mouse.y += (this.mouse.ty - this.mouse.y) * 0.05;
      const mx = this.mouse.x;
      const my = this.mouse.y;
      // 缩放平滑过渡（滚轮一格不是一下子跳过去）
      if (this.zoom !== this.zoomT) {
        const z = Math.abs(this.zoomT - this.zoom) < 0.003 ? this.zoomT : this.zoom + (this.zoomT - this.zoom) * Math.min(1, (dt || 16) / 1000 * 12);
        this.applyZoom(z);
      }
      const { W } = this;
      ctx.imageSmoothingEnabled = false;
      // 视角（sceneworld.js）：远处的东西移动得慢（视差），地形跟着视角走
      if (dt && this.cam) this.camTick(dt, now);
      const cam = this.cam || { x: 0, y: 0 };
      // 背景层的位置：拖动视角按视差系数 k 移，缩放带来的平移（zx / zy）不打折，和地形一起移
      const zx = this.zx || 0; const zy = this.zy || 0;
      const bx = (k) => k * cam.x + (1 - k) * zx;
      const by = (k) => k * cam.y + (1 - k) * zy;
      // 远景、贴图横向循环拼接（画布本身左右能接上）
      const tile = (img, x, y) => {
        const w = img.width;
        let x0 = ((Math.round(x) % w) + w) % w - w;
        for (; x0 < W; x0 += w) ctx.drawImage(img, x0, Math.round(y));
        return ((Math.round(x) % w) + w) % w;
      };
      // 天空：一列渐变横向拉满；渐变上面接天顶色、下面接地平线色
      const skyY = Math.round(-by(0.25));
      const SH = this.sky.height;
      if (skyY > 0) { ctx.fillStyle = rgb(P.top); ctx.fillRect(0, 0, W, skyY); }
      if (skyY + SH < this.H) { ctx.fillStyle = rgb(P.hor); ctx.fillRect(0, skyY + SH, W, this.H - skyY - SH); }
      ctx.drawImage(this.sky, 0, 0, 1, SH, 0, skyY, W, SH);
      tile(this.skyNoise, -mx - bx(0), skyY);
      // 下雨、下雪时太阳、月亮和星星被云遮住（rc3 天气，sceneweather.js）
      const clearSky = this.wx ? 1 - this.wx.level * 0.9 : 1;
      ctx.globalAlpha = clearSky;
      if (this.sun && clearSky > 0.02) {
        const { sz } = this.sun;
        const sx = Math.round(this.sun.x - bx(0) - mx); const sy = this.sun.y + skyY;
        const night0 = this.period === 'night';
        for (let r = 5; r >= 1; r--) {
          ctx.fillStyle = rgb(P.glow, 0.06 * (6 - r) * (night0 ? 0.6 : 1));
          const g = sz + r * 5;
          ctx.fillRect(sx - g / 2, sy - g / 2, g, g);
        }
        ctx.fillStyle = rgb(P.sun);
        ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
        if (night0) {
          ctx.fillStyle = 'rgba(150,160,190,0.35)';
          ctx.fillRect(sx - sz / 2 + 2, sy - sz / 2 + 2, 2, 2);
          ctx.fillRect(sx + 1, sy + 1, 3, 2);
        }
      }
      if (this.stars.length && clearSky > 0.02) {
        const SW = this.starW; const ox = -mx * 1.5 - bx(0);
        for (const st of this.stars) {
          const x = Math.round((((st.x + ox) % SW) + SW) % SW);
          if (x >= W) continue;
          const a = (0.35 + 0.65 * Math.abs(Math.sin(this.t * 0.0012 + st.p))) * P.stars;
          ctx.fillStyle = `rgba(255,255,255,${a})`;
          ctx.fillRect(x, Math.round(st.y + skyY), st.s, st.s);
        }
      }
      ctx.globalAlpha = 1;
      const night = this.period === 'night';
      const cloudX = bx(0.15);
      for (const c of this.clouds) {
        c.x += c.speed * dt * 0.004;
        const width = c.w * c.bw;
        const span = W + width + 40;
        const x0 = Math.round((((c.x - cloudX) % span) + span) % span - width - 20 - mx * (c.bw > 4 ? 3 : 1.5));
        const y0 = Math.round(c.y - my * 1 - by(0.4));
        const a = c.alpha * (night ? 0.4 : 1);
        ctx.fillStyle = rgb(P.cloud, a);
        for (const [rx, ry, rw, rh] of c.rects) ctx.fillRect(x0 + rx * c.bw, y0 + ry * c.bh, rw * c.bw, rh * c.bh);
      }
      this.drawEvents(now, 'sky');
      // 远山、近山
      const fy = Math.round(-my * 1 - by(0.4));
      this.farOX = tile(this.far, -8 - mx * 3 - bx(0.12), fy);
      this.drawEvents(now, 'ridge', 0, fy);
      tile(this.mid, -12 - mx * 5 - bx(0.25), -my * 1.5 - by(0.6));
      const lx = Math.round(-16 - mx * 8 - cam.x);
      const ly = Math.round(-my * 2 - cam.y);
      this.landX = lx; this.landY = ly;
      // 下界顶上的岩层：挂在世界上，和地形一起拖动、缩放
      if (this.ceil) {
        const { img, up, fill } = this.ceil;
        const top = ly - up * this.B;
        if (top > 0) { ctx.fillStyle = fill; ctx.fillRect(0, 0, W, top); }
        tile(img, lx, top);
      }

      // 天空中的飞行生物（在地形之前，看起来更远）
      for (const e of this.ents) if (e.spr.fly && e.kind === 'ghast') this.drawSprite(e, lx, ly, now);
      for (const d of this.decor) if (d.type === 'bridge') this.drawDecor(d, lx, ly, now);
      // 地形、水、洞穴岩浆（sceneworld.js）
      this.drawWorld(lx, ly);
      if (this.dim === 'nether' && this.water.length && this.rnd() < 0.2) {
        const sv = this.water.filter((w) => w[2] && w[0] * this.B > cam.x && w[0] * this.B < cam.x + W);
        const [i, r] = pick(sv, this.rnd()) || [];
        if (i != null) this.parts.push({ x: i * this.B + 2, y: r * this.B, vx: (this.rnd() - 0.5) * 6, vy: -14, g: 30, life: 700, c: [255, 170, 60], glow: true, land: true });
      }

      for (const d of this.decor) if (d.type !== 'bridge') this.drawDecor(d, lx, ly, now);
      for (const tr of this.trees) this.drawTree(tr, lx, ly);
      for (const h of this.houses) this.drawHouse(h, lx, ly, now);
      this.drawTorches(lx, ly, now);
      for (const b of this.builds) this.drawBuild(b, lx, ly, now);
      for (const e of this.ents) {
        if (e.kind === 'ghast') continue;
        if (e.boat) { this.drawBoat(e, lx, ly, now); continue; }
        this.drawSprite(e, lx, ly, now);
      }
      this.drawFight(lx, ly, now);
      this.drawHeldTorches(lx, ly, now);
      for (const fn of A.sceneKit.overlay) fn.call(this, lx, ly, now); // 别的模块画在生物上面的（掉落的浆果、末影龙）
      this.drawFluid(lx, ly, now); // 半透明的水盖在水里的东西上（sceneworld.js）
      for (const fn of A.sceneKit.shade) fn.call(this, lx, ly, now); // 整个画面变暗的（下雨天，sceneweather.js），粒子画在上面
      // 粒子
      for (const p of this.parts) {
        // 天气、流星、烟花用屏幕坐标，其余跟随地形视差
        const scr = p.weather || p.star || p.screen;
        // 天气是屏幕坐标：落到地面（或山体、地下）后面的不画
        if (p.weather && this.dim === 'over') { const gy = this.groundY(p.x - lx); if (gy != null && p.y - ly > gy) continue; }
        const px = Math.round(p.x + (scr ? 0 : lx));
        const py = Math.round(p.y + (scr ? 0 : ly));
        const a = Math.min(1, p.life / 400);
        if (p.heart) {
          ctx.fillStyle = rgb(p.c, a);
          ctx.fillRect(px, py, 1, 1); ctx.fillRect(px + 2, py, 1, 1); ctx.fillRect(px, py + 1, 3, 1); ctx.fillRect(px + 1, py + 2, 1, 1);
          continue;
        }
        if (p.rain) { ctx.fillStyle = rgb(p.c, 0.5); ctx.fillRect(px, py, 1, 3); continue; } // 雨点是一道短竖线（sceneweather.js）
        if (p.firefly) {
          // bright：点击冒出的萤火虫闪烁时不会完全暗下去，否则一团里总有一半看不见
          const fl = this.noFlash ? 0.6 : Math.sin(now / 200 + p.x);
          ctx.fillStyle = rgb(p.c, Math.min(a, p.bright ? 0.6 + 0.4 * fl : 0.5 + 0.5 * fl));
          ctx.fillRect(px, py, 1, 1);
          continue;
        }
        ctx.fillStyle = p.glow ? rgb(p.c, a) : rgb(this.tint(p.c), a);
        const sz = p.size || 1;
        ctx.fillRect(px, py, sz, sz);
      }
      for (const fn of A.sceneKit.hud) fn.call(this, now); // 屏幕坐标的（Boss 血条）
    }

    loop(now) {
      if (!this.running) return;
      const dt = this.last ? Math.min(100, now - this.last) : 16;
      // 窗口没有焦点时降到约 10 帧，被挡住 / 最小化时不画
      // 帧率上限（性能打磨）：30 / 20 / 10 帧；没有焦点时最多 10 帧
      const fpsGap = Math.floor(1000 / (Number(this.opts.fps) || 30));
      const gap = document.hidden ? Infinity : document.hasFocus() ? fpsGap : Math.max(100, fpsGap);
      if (now - this.last >= gap) {
        this.last = now;
        this.draw(dt);
        // 减少动态效果：画一帧就停，背景定格成一张静止的画面
        if (this.frozen) { this.stop(); return; }
      }
      this.raf = requestAnimationFrame((t) => this.loop(t));
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = 0;
      window.addEventListener('mousemove', this._onMove);
      window.addEventListener('keydown', this._onKey);
      this.resize();
      this._periodTimer = setInterval(() => {
        if (this.W && this.dim === 'over' && periodFor(this.opts.time) !== this.period) {
          // 时段变化：世界与生物保留，只重绘天空与光照（天亮后敌对生物会燃烧）
          this.period = periodFor(this.opts.time);
          this.setPalette();
          this.paint();
          A.emit('scene', this.info());
        }
      }, 60000);
      if (this.fest === 'birthday' || this.fest === 'newyear') setTimeout(() => this.fireworks(10), 2500);
      this.raf = requestAnimationFrame((t) => this.loop(t));
    }

    stop() {
      this.running = false;
      cancelAnimationFrame(this.raf);
      clearInterval(this._periodTimer);
      clearTimeout(this._resizeT);
      window.removeEventListener('mousemove', this._onMove);
      window.removeEventListener('keydown', this._onKey);
    }

    info() {
      return { scene: this.sceneId, name: SCENES[this.sceneId] ? SCENES[this.sceneId].name : '', period: this.period, mobs: this.ents.length, festival: this.fest, weather: this.weatherInfo ? this.weatherInfo() : null };
    }
  }


  A.Scene = Scene;
})();
