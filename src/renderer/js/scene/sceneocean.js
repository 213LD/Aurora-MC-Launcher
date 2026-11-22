'use strict';
/**
 * 主页动态背景：海洋和海底（第二阶段）。挂在 A.Scene.prototype 上，sceneworld.js / scene.js 调用。
 * - 海洋场景海平面抬高到画面一半；海底有深有浅：暖水区浅一些、长珊瑚礁，别的地方长海带和海草；离开打开时那一屏越远越可能有深海盆地
 * - 结构：海底神殿（剖开能看到宝库里的金块，周围有守卫者、偶尔一只远古守卫者）、沉船（有的倒扣着）、海底废墟。
 *   打开时那一屏的左半边一定有一个（沉船或废墟居多，神殿 20%），往两边走还有（神殿 8%）
 * - 鱼成群游、海豚跃出水面、守卫者偶尔朝附近的鱼发射激光、发光鱿鱼、海底冒气泡、白天水下有光柱
 * - 普通场景的湖底也有沙砾、黏土和海草
 */
(function () {
  const { hash, mix, rgb, pal, M, SPRITES, H, vnoise, smooth, REG, GEN, DECO, decoDraw } = A.sceneKit;
  const P = A.Scene.prototype;

  Object.assign(M, {
    prismarine: pal('#5fa597', '#4f9688', '#6bb0a0', '#589e90'),
    prisBrick: pal('#63ab9e', '#5a9f92', '#6db5a8'),
    darkPris: pal('#335b4f', '#2d5247', '#3a6658'),
    seaLantern: pal('#d8ece6', '#c4e4dc', '#eef8f4'),
    gold: pal('#f5d04a', '#e8c040', '#fde070'),
    wool: pal('#e8e4dc', '#d8d2c8', '#c8c2b8'),
    stoneBrick: pal('#7a7a7a', '#6e6e6e', '#858585'),
    mossyBrick: pal('#6a7a5a', '#7a7a7a', '#5e7050'),
  });
  // 珊瑚：管珊瑚、脑纹珊瑚、气泡珊瑚、火珊瑚、鹿角珊瑚
  const CORAL = [pal('#3051c6', '#2a46b0', '#3a5ed4'), pal('#d05aa0', '#b8488a', '#e070b4'), pal('#a12aa8', '#8a1f92', '#b43abc'),
    pal('#c8323a', '#a82830', '#d84048'), pal('#d8c040', '#c0a834', '#e8d050')];

  Object.assign(SPRITES, {
    salmon: H(['.rrS', 'rrrr'], { r: '#a84a3a', S: '#8a3a2a' }, { swims: true }),
    pufferfish: H(['.y.y', 'yyyE', '.yyy'], { y: '#e8c840', E: '#222222' }, { swims: true }),
    glowSquid: H(['.gg.', 'gGgg', 'gEgg', 'g.g.'], { g: '#1d6a72', G: '#7ff0e0', E: '#e0fff8' }, { swims: true, emissive: 'GE' }),
    guardian: H(['.s.s.', 'sgggg', 'gggEg', 'ggggs', '.s.s.'], { g: '#5f9e8e', s: '#d07a3a', E: '#f0e0a0' }, { swims: true }),
    elderGuardian: H(['.s.s.s.', 'sgggggg', 'gggggEg', 'ggggggg', 'sgggggs', '.s.s.s.'], { g: '#bcbca8', s: '#8a7a6a', E: '#a060c0' }, { swims: true }),
  });
  const SCHOOL = new Set(['cod', 'salmon', 'tropical']);

  // ───────────── 地形 ─────────────

  /** 海洋的海底高度（sceneworld.genHeight 转过来） */
  P.oceanHeight = function (c) {
    // 按打开时的窗口算（wr、去掉 lift 的海平面），最后整体挪 lift 行（rc6，见 sceneworld.initWorld）
    const rows = this.wr; const o = this.worldOff; const s = this.wseed;
    const sea = this.sea - this.lift;
    const n = Math.sin(c * 0.05 + o[0]) * 0.5 + Math.sin(c * 0.13 + o[1]) * 0.3 + Math.sin(c * 0.31 + o[2]) * 0.2;
    let h = rows * this.base0 - n * rows * this.S.hill;
    // 深海盆地：打开时那一屏没有（要看得到海底），越往两边越可能有
    const v = this.homeCols || this.cols;
    const dist = c < -v * 0.2 ? -v * 0.2 - c : c > v * 1.2 ? c - v * 1.2 : 0;
    h += smooth((vnoise(c / 96, 0.5, s + 61) - 0.45) / 0.3) * smooth(dist / (v * 0.5)) * rows * 0.32;
    h -= this.warmK(c) * rows * 0.1; // 暖水区浅一些
    if (this.S.isle) return Math.round(this.isleHeight(c, h, sea)) + this.lift; // 蘑菇岛（sceneland.js）
    // 偶尔露出水面的小沙岛（海龟在上面爬）
    const isl = vnoise(c / 44, 2.5, s + 62);
    if (isl > 0.72) h -= smooth((isl - 0.72) / 0.18) * (h - sea + rows * 0.07);
    return Math.round(h) + this.lift;
  };

  /** 0~1：这一列有多「暖」（> 0.5 长珊瑚） */
  P.warmK = function (c) { return smooth((vnoise(c / 80, 7.5, this.wseed + 63) - 0.52) / 0.14); };

  /** 这一列珊瑚礁有几格高 */
  P.reefH = function (c, top) {
    if (!this.S.ocean || this.warmK(c) < 0.5 || top - this.sea < 6) return 0;
    const v = vnoise(c * 0.3, 3.3, this.wseed + 65);
    return v < 0.32 ? 0 : Math.min(3, 1 + Math.floor((v - 0.32) * 7));
  };

  /**
   * 水底表层：沙子里夹着沙砾、黏土（湖底也一样）。1.10.3 照原版：暖水海洋底下全是沙子，
   * 深海（盆地）的海底大半是沙砾
   */
  P.seabed = function (c, r, top) {
    const v = vnoise(c * 0.22, (r - this.baseRow) * 0.3, this.wseed + 64);
    if (this.S.ocean && !this.S.isle) {
      if (this.warmK(c) > 0.5) return { mat: M.sand };
      if (top != null && top - this.sea > this.wr * 0.45) return { mat: v > 0.3 ? M.gravel : M.sand };
    }
    if (v > 0.8) return { mat: M.gravel };
    if (v < 0.14) return { mat: M.clay };
    return { mat: M.sand };
  };

  /** 水底的海草、海带、珊瑚、海泡菜（sceneworld.populate 最后调用） */
  P.populateSea = function (ch, rnd) {
    if (this.sea > 900 || this.dim !== 'over') return;
    const busy = this.structsIn(ch.c0, ch.c0 + 15).filter((s) => s.main);
    const ocean = !!this.S.ocean;
    for (let k = 0; k < ch.hs.length; k++) {
      const c = ch.c0 + k; const top = ch.hs[k];
      const dep = top - this.sea;
      if (dep < 2 || top > 900) continue;
      const r = rnd();
      if (busy.some((s) => c >= s.c0 - 1 && c <= s.c1 + 1)) continue; // 别挡住神殿和沉船
      let d = null;
      if (ocean && this.warmK(c) > 0.5) {
        const t2 = top - this.reefH(c, top);
        if (r < 0.45) d = { type: 'coral', col: c, top: t2, k: Math.floor(rnd() * 5), fan: rnd() < 0.5 };
        else if (r < 0.53) d = { type: 'pickle', col: c, top: t2, n: 1 + Math.floor(rnd() * 3) };
        else if (r < 0.65) d = { type: 'seagrass', col: c, top: t2, tall: false };
      } else if (ocean && dep >= 5 && r < 0.3) { // 海带只长在海里（原版的河、湖里没有）
        d = { type: 'kelp', col: c, top, h: 2 + Math.floor(rnd() * (dep - 3)), ph: rnd() * 6 };
      } else if (r < (ocean ? 0.62 : 0.35)) d = { type: 'seagrass', col: c, top, tall: rnd() < 0.35 };
      if (d) { d.ci = ch.ci; this.decor.push(d); }
    }
  };

  // ───────────── 结构 ─────────────

  // 海底神殿（23 列 × 10 行，下标 y 从底往上）
  const HALF = [11, 11, 11, 9, 7, 5, 4, 3, 2, 1];
  function monumentCell(x, y) {
    if (y < 0 || y > 9) return undefined;
    const d = Math.abs(x - 11);
    // 两边的塔：比中间低，顶上一圈暗海晶石和尖刺，塔身有海晶灯
    if ((x <= 3 || x >= 19) && y >= 3 && y <= 7) {
      if (y === 7) return x === 0 || x === 3 || x === 19 || x === 22 ? { mat: M.darkPris } : undefined;
      if (y === 6) return { mat: M.darkPris };
      if (y === 4 && (x === 1 || x === 2 || x === 20 || x === 21)) return { mat: M.seaLantern, glow: true };
      return { mat: M.prisBrick };
    }
    if (d > HALF[y]) return undefined;
    // 中间的宝库（剖开看得到）：金块和四角的海晶灯
    if (y >= 1 && y <= 4 && d <= 4) {
      if ((y === 1 && d <= 1) || (y === 2 && d === 0)) return { mat: M.gold };
      if (y === 4 && d === 4) return { mat: M.seaLantern, glow: true };
      return { mat: M.darkPris, cave: true };
    }
    if (y === 9) return { mat: M.seaLantern, glow: true };
    if (y === 0 || y === 5) return { mat: M.darkPris };
    if (d === HALF[y] || y === 8) return { mat: M.prismarine };
    if (y === 2 && (d === 7 || d === 9)) return { mat: M.seaLantern, glow: true };
    return { mat: M.prisBrick };
  }

  /** 把 c0~c1（两边各多两列）的海底压平到平均高度（水至少 need 格深），返回海底那一行；有岛或坡太陡返回 null */
  P.seaFloor = function (c0, c1, need) {
    let sum = 0; let lo = Infinity; let hi = -Infinity;
    for (let c = c0 - 2; c <= c1 + 2; c++) {
      const h = this.colHeight(c);
      if (h <= this.sea + 3) return null;
      sum += h; lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > 10) return null;
    const fb = Math.max(Math.round(sum / (c1 - c0 + 5)), this.sea + need);
    if (this.BOT != null && fb >= this.BOT - 4) return null;
    for (let c = c0 - 2; c <= c1 + 2; c++) this.hOver.set(c, fb);
    return fb;
  };

  P.makeMonument = function (at) {
    const c0 = at; const c1 = at + 22;
    const fb = this.seaFloor(c0, c1, 13);
    if (fb == null) return null;
    return { type: 'monument', c0, c1, r0: fb - 10, r1: fb - 1, cell: (c, r) => monumentCell(c - c0, fb - 1 - r) };
  };

  // 沉船（15 列；L 桅杆、S 破帆、W 船壳、P 甲板、d 船舱、C 箱子）
  const SHIP = [
    '........L......',
    '.......SLS.....',
    '......SSLSS....',
    '........L......',
    'WW......L.....W',
    'WPPPPPPPPPPPPPW',
    '.WdddCdddddddW.',
    '..WdddddddddW..',
    '...WWWWWWWWW...',
  ];
  P.makeShip = function (at, rnd) {
    const w = 15;
    const deep = this.seaFloor(at, at + w - 1, 7);
    if (deep == null) return null;
    const flip = rnd() < 0.3; const broken = rnd() < 0.5; const mirror = rnd() < 0.5;
    let rows = flip ? SHIP.slice(4).reverse() : broken ? SHIP.slice(3) : SHIP;
    if (deep - rows.length < this.sea + 1) rows = SHIP.slice(4); // 水太浅：只剩船身
    if (deep - rows.length < this.sea + 1) return null;
    const r0 = deep - rows.length + 1; // 最下一行埋进海底一格
    const s = this.wseed;
    return {
      type: 'ship', c0: at, c1: at + w - 1, r0, r1: deep,
      cell: (c, r) => {
        const ch = rows[r - r0][mirror ? at + w - 1 - c : c - at];
        if (ch === '.') return undefined;
        // 随机数用相对船顶的行号（r - r0）：拉窗口整体挪了以后还是同一个样子（rc6）
        if ((ch === 'W' || ch === 'P') && hash(c, r - r0, s + 70) < 0.1) return undefined; // 破洞
        if (ch === 'S') return hash(c, r - r0, s + 73) < 0.35 ? undefined : { mat: M.wool };
        if (ch === 'L') return { mat: M.log };
        if (ch === 'W') return { mat: M.spruce };
        if (ch === 'P') return { mat: M.planks };
        if (ch === 'C') return { mat: M.darkPlanks, cave: true, deco: 'chest' };
        return { mat: M.darkPlanks, cave: true };
      },
    };
  };

  // 海底废墟：塌了一半的石砖（暖水区是砂岩）小屋
  P.makeRuins = function (at, rnd) {
    const w = 7 + Math.floor(rnd() * 5); const h = 3 + Math.floor(rnd() * 4);
    const base = this.seaFloor(at, at + w - 1, h + 3);
    if (base == null) return null;
    const warmR = this.warmK(at) > 0.5;
    const mats = warmR ? [M.sandstone, M.sandstone, M.sand] : [M.stoneBrick, M.mossyBrick, M.stoneBrick];
    const chest = at + 1 + Math.floor(rnd() * (w - 2));
    const s = this.wseed;
    const pick3 = (c, r) => ({ mat: mats[Math.floor(hash(c, base - r, s + 71) * 3)], deco: 'brick', mortar: warmR ? [176, 158, 104] : [84, 84, 84] }); // 相对海底的行号（rc6）
    // 塌的方式：墙从上往下少几格；屋顶只剩连着一面完整的墙的一截
    const mid = w > 8 ? Math.floor(w / 2) : -1;
    const wallH = (x) => (x === 0 || x === w - 1 || x === mid ? h - Math.floor(hash(at + x, 7, s + 72) * 3) : 0);
    const leftRoof = wallH(0) >= h - 1;
    const roofLen = 2 + Math.floor(rnd() * (w - 3));
    return {
      type: 'ruins', c0: at, c1: at + w - 1, r0: base - h, r1: base,
      cell: (c, r) => {
        const x = c - at; const y = base - r;
        if (y === 0) return pick3(c, r);
        if (y <= wallH(x)) return pick3(c, r);
        if (y === h && (leftRoof ? x <= roofLen : x >= w - 1 - roofLen) && hash(c, y, s + 74) > 0.15) return pick3(c, r);
        return y === 1 && c === chest ? { deco: 'chest' } : undefined;
      },
    };
  };

  // 每个区域：一个主要结构（神殿 / 沉船 / 废墟，可能没有）+ 暖水区的珊瑚礁
  GEN.push(function (reg, rnd) {
    if (!this.S.ocean) return null;
    const out = [];
    const home = reg === 0;
    const roll = rnd();
    // 1.5.16 调低神殿：打开那一屏 50% → 20%，别的区域 22% → 8%（原版神殿本来就稀少）
    let type = home && this.S.isle ? null : home ? (roll < 0.2 ? 'monument' : roll < 0.62 ? 'ship' : 'ruins') : roll < 0.08 ? 'monument' : roll < 0.42 ? 'ship' : roll < 0.72 ? 'ruins' : null;
    // 打开时那一屏放在侧边栏右边、更新日志左边
    const hc = this.homeCols || this.cols; // 按打开时的窗口宽度放（拉窗口重建时不挪地方，rc6）
    const at = home ? Math.floor(hc * 0.22) + Math.floor(rnd() * Math.max(1, Math.floor(hc * 0.08))) : reg * REG + 3 + Math.floor(rnd() * (REG - 30));
    let main = null;
    if (type === 'monument') { main = this.makeMonument(at); if (!main) type = 'ship'; }
    if (type === 'ship') main = this.makeShip(at, rnd);
    if (type === 'ruins') main = this.makeRuins(at, rnd);
    if (main) { main.main = true; out.push(main); }
    // 珊瑚礁：长在海底上面几格（避开主要结构）
    const c0 = reg * REG;
    let r0 = Infinity; let r1 = -Infinity;
    for (let c = c0; c < c0 + REG; c++) {
      if (main && c >= main.c0 - 2 && c <= main.c1 + 2) continue;
      const top = this.colHeight(c);
      const h = this.reefH(c, top);
      if (h) { r0 = Math.min(r0, top - h); r1 = Math.max(r1, top - 1); }
    }
    if (r0 < Infinity) {
      const self = this;
      const skip = main ? [main.c0 - 2, main.c1 + 2] : null;
      out.push({
        type: 'reef', c0, c1: c0 + REG - 1, r0, r1,
        cell(c, r, top) {
          if (r >= top || (skip && c >= skip[0] && c <= skip[1])) return undefined;
          const h = self.reefH(c, top);
          return h && r >= top - h ? { mat: CORAL[Math.floor(hash(c >> 1, top - r, self.wseed + 66) * 5)] } : undefined; // 相对海底的行号（rc6）
        },
      });
    }
    return out;
  });

  // ───────────── 生物 ─────────────

  /** 画面里有海底神殿：先补守卫者（最多 3 只，偶尔一只远古守卫者） */
  P.seaSpawn = function (now) {
    if (!this.S.ocean || !this.opts.aquatic) return false;
    const B = this.B; const r = this.rnd;
    const c0 = Math.floor(this.cam.x / B); const c1 = Math.floor((this.cam.x + this.W) / B);
    for (const s of this.structsIn(c0, c1)) {
      if (s.type !== 'monument' || s.c1 < c0 || s.c0 > c1) continue;
      const mine = this.ents.filter((e) => e.guard === s);
      if (mine.length >= 3) continue;
      const kind = !mine.some((e) => e.kind === 'elderGuardian') && r() < 0.35 ? 'elderGuardian' : 'guardian';
      for (let t = 0; t < 30; t++) {
        const c = s.c0 - 3 + Math.floor(r() * (s.c1 - s.c0 + 7));
        const row = this.sea + 2 + Math.floor(r() * Math.max(1, s.r1 - this.sea - 2));
        if (row >= this.colHeight(c) - 1 || this.solidAt(c, row) || this.solidAt(c, row - 1)) continue;
        this.mkEnt(kind, c * B, (row + 1) * B - 1, now, { guard: s, home: [(s.c0 - 5) * B, (s.c1 + 5) * B], life: 60000 + r() * 60000 });
        return true;
      }
    }
    return false;
  };

  /** 鳕鱼、鲑鱼、热带鱼成群：带头的后面跟 2~5 条（跟着的不算进生物数量） */
  P.afterSpawn = function (e, now) {
    if (!SCHOOL.has(e.kind) || e.flock) return;
    const r = this.rnd;
    const n = 2 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      this.mkEnt(e.kind, e.x - e.dir * (4 + k * 3), e.y + (r() - 0.5) * 6, now,
        { leader: e, ox: 4 + k * 3 + r() * 2, oy: Math.round((r() - 0.5) * 8), flock: true, life: e.life, dir: e.dir });
    }
  };

  P.splash = function (x) {
    const y = this.sea * this.B;
    for (let k = 0; k < 6; k++) this.parts.push({ x: x + (this.rnd() - 0.5) * 4, y, vx: (this.rnd() - 0.5) * 20, vy: -10 - this.rnd() * 12, g: 50, life: 600, c: [220, 240, 255] });
  };

  /** 游泳（scene.updateEnt 转过来）：上下也会游、碰到结构掉头、跟着鱼群、海豚跃出水面 */
  P.swimTick = function (e, sec, now, spd) {
    const B = this.B; const r = this.rnd;
    const seaY = this.sea * B;
    const bottomAt = (x) => this.colHeight(Math.floor(x / B)) * B;
    const clampY = () => {
      const lo = seaY + e.spr.h + 1;
      const hi = bottomAt(e.x + e.spr.w / 2) - 1;
      e.y = Math.max(lo, Math.min(Math.max(lo, hi), e.y));
    };
    if (e.leap) {
      const p = (now - e.leap.t) / 900;
      const nx = e.x + e.dir * spd * 1.2 * sec;
      if (this.isWaterCol(nx) && this.isWaterCol(nx + e.spr.w * e.dir)) e.x = nx;
      if (p >= 1) { e.leap = null; this.splash(e.x + 3); clampY(); } else e.y = e.leap.y0 - Math.sin(p * Math.PI) * 14;
      return;
    }
    if (e.leader) {
      const L = e.leader;
      if (L.dead || L.fade) e.leader = null;
      else {
        e.dir = L.dir;
        // 跟着的鱼想不想游看带头的（rc11）：以前留着它自己那套「走 / 停」的旧值，带头的停下来它跟着停，却还标着「正在游」
        e.moving = !!L.moving;
        const k = Math.min(1, sec * 3);
        const nx = e.x + (L.x - L.dir * e.ox - e.x) * k;
        // 看往哪边挪就看哪边的边（rc4：以前不管往哪边都看右边外面一格，鱼放大以后靠岸的跟随鱼左右都挪不动，卡在原地）
        const lead = nx > e.x ? nx + e.spr.w - 1 : nx;
        if (this.isWaterCol(lead)) e.x = nx;
        else if (Math.abs(L.x - e.x) > 40) e.leader = null; // 跟丢了就自己游
        e.y += (L.y + e.oy - e.y) * k;
        clampY();
        return;
      }
    }
    e.y += Math.sin(now / 900 + e.born) * sec;
    if (e.moving) {
      const nx = e.x + e.dir * spd * sec;
      const lead = nx + (e.dir > 0 ? e.spr.w : 0);
      const blocked = !this.isWaterCol(lead) || !this.loadedAt(nx) || this.solidAt(Math.floor(lead / B), Math.floor((e.y - e.spr.h / 2) / B))
        || (e.home && (nx < e.home[0] || nx > e.home[1]));
      // 碰壁：掉头并停一下（和地上的生物一样）。以前每帧都掉头，两边都挡住时在原地来回抖
      if (blocked) { e.dir *= -1; e.state = 'idle'; e.until = now + 800 + r() * 1500; } else e.x = nx;
      // 隔一会儿换一个深度游过去，整片水都用得上
      if (e.ty == null || now > e.tyT) {
        e.ty = seaY + e.spr.h + 2 + r() * Math.max(1, bottomAt(e.x) - seaY - e.spr.h - 4);
        e.tyT = now + 2500 + r() * 5000;
      }
      const dy = e.ty - e.y;
      e.y += Math.sign(dy) * Math.min(Math.abs(dy), spd * 0.4 * sec);
    }
    clampY();
    if (e.kind === 'dolphin' && e.y - seaY < e.spr.h + 8 && r() < sec * 0.25) { e.leap = { t: now, y0: e.y }; this.splash(e.x + 3); }
    if (e.kind === 'glowSquid' && !this.noFlash && r() < sec * 1.5 * this.fxK) this.parts.push({ x: e.x + r() * 4, y: e.y - r() * 4, vx: 0, vy: -2, life: 900, c: [120, 240, 220], glow: true });
    if (e.guard) this.guardTick(e, now);
  };

  /** 守卫者偶尔朝附近的鱼发射激光（只是吓跑，不打死） */
  P.guardTick = function (e, now) {
    if (e.beam) {
      const o = e.beam.o;
      if (o.dead || now - e.beam.t > 2200) e.beam = null;
      else if (now - e.beam.t > 2000 && !e.beam.hit) { e.beam.hit = true; o.hurt = now + 300; o.dir = o.x > e.x ? 1 : -1; }
      return;
    }
    if (this.rnd() > 0.004) return;
    const o = this.ents.find((x) => x !== e && x.spr.swims && !x.guard && Math.hypot(x.x - e.x, x.y - e.y) < 50);
    if (o) e.beam = { o, t: now };
  };

  // ───────────── 绘制 ─────────────

  /** 砖块的砖缝（画进块里） */
  DECO.brick = (dot, cell, c, r) => {
    for (let x = 0; x < 4; x++) dot(x, 0, cell.mortar);
    dot((r & 1) * 2, 1, cell.mortar); dot((r & 1) * 2, 2, cell.mortar); dot((r & 1) * 2, 3, cell.mortar);
  };

  decoDraw.kelp = function (d, x, top, now) {
    const g = this.ctx;
    const w = this.wiggle(d, now); // 被点了：摆得厉害一点（sceneinteract.js）
    const wob = w ? Math.sin(now / 160) * w * 4 : 0;
    if (!this.fxK) now = 0; // 特效低档：海带不摆动
    const n = d.h * this.B;
    const stem = this.color([58, 112, 36]); const leaf = this.color([96, 158, 56]);
    let px = x + 1;
    for (let k = 0; k < n; k += 2) {
      px = x + 1 + Math.round((Math.sin(now / 1100 + d.ph + k * 0.08) * 3 + wob) * (k / n));
      const py = top - k - 2;
      g.fillStyle = stem; g.fillRect(px, py, 1, 2);
      if (k % 6 === 2) { g.fillStyle = leaf; g.fillRect(k % 12 === 2 ? px - 1 : px + 1, py, 1, 1); }
    }
    g.fillStyle = leaf; g.fillRect(px - 1, top - n - 1, 3, 1);
  };

  decoDraw.seagrass = function (d, x, top, now) {
    const g = this.ctx;
    const w = this.wiggle(d, now);
    const wob = w ? Math.sin(now / 140) * w * 2.5 : 0;
    if (!this.fxK) now = 0;
    const n = d.tall ? 7 : 4;
    g.fillStyle = this.color([70, 140, 50]);
    for (const [bx, hk] of [[0, 0.7], [1, 1], [3, 0.6]]) {
      const h = Math.max(2, Math.round(n * hk));
      for (let k = 0; k < h; k += 2) {
        const sway = Math.round((Math.sin(now / 900 + d.col + bx + k * 0.3) * 1.2 + wob) * (k / h));
        g.fillRect(x + bx + sway, top - 1 - k - Math.min(1, h - k - 1), 1, Math.min(2, h - k));
      }
    }
  };

  decoDraw.coral = function (d, x, top) {
    const g = this.ctx;
    const c = CORAL[d.k];
    if (d.fan) {
      g.fillStyle = this.color(c[1]); g.fillRect(x + 1, top - 1, 2, 1);
      g.fillStyle = this.color(c[0]); g.fillRect(x, top - 2, 4, 1); g.fillRect(x + 1, top - 3, 2, 1);
    } else {
      g.fillStyle = this.color(c[0]); g.fillRect(x + 1, top - 3, 1, 3); g.fillRect(x, top - 4, 1, 2); g.fillRect(x + 2, top - 4, 1, 2);
      g.fillStyle = this.color(c[2]); g.fillRect(x + 3, top - 3, 1, 1);
    }
  };

  decoDraw.pickle = function (d, x, top, now) {
    const g = this.ctx;
    for (let i = 0; i < d.n; i++) {
      g.fillStyle = this.color([90, 130, 50]); g.fillRect(x + i, top - 2, 1, 2);
      g.fillStyle = rgb([200, 255, 140], this.noFlash ? 0.8 : 0.6 + 0.3 * Math.sin(now / 500 + i)); g.fillRect(x + i, top - 3, 1, 1);
    }
  };

  /** 水面之后画：白天的水下光柱、守卫者的激光、海底冒的气泡（sceneworld.drawFluid 调用） */
  P.drawSea = function (lx, ly, now) {
    const { ctx, B } = this;
    const y0 = ly + this.sea * B;
    const rays = this.S.ocean && this.period !== 'night' ? Math.round(5 * this.fxK) : 0; // 特效档位：5 / 3 / 0 道光柱
    if (rays) {
      for (let i = 0; i < rays; i++) {
        const span = this.W + 80;
        const xr = ((i * 0.37 + now * 0.000008) % 1) * span - 40;
        for (let y = Math.max(y0 + 1, 0); y < this.H; y += 2) {
          const d = y - y0;
          const a = 0.07 * (1 - d / (this.H * 0.9));
          if (a <= 0) break;
          const x = xr + d * 0.35;
          const top = this.colHeight(Math.floor((x - lx) / B));
          if (!(top > this.sea) || top > 900 || y - ly >= top * B) break;
          ctx.fillStyle = `rgba(255,255,240,${a})`;
          ctx.fillRect(Math.round(x), y, 3, 2);
        }
      }
    }
    for (const e of this.ents) {
      if (!e.beam) continue;
      const o = e.beam.o;
      const p = Math.min(1, (now - e.beam.t) / 2000);
      const ax = e.x + e.spr.w / 2 + lx; const ay = e.y - e.spr.h / 2 + ly;
      const bx = o.x + o.spr.w / 2 + lx; const by = o.y - o.spr.h / 2 + ly;
      const n = Math.ceil(Math.hypot(bx - ax, by - ay));
      ctx.fillStyle = rgb(mix([140, 60, 200], [255, 230, 120], p), 0.5 + 0.4 * p);
      for (let k = 0; k <= n; k++) if ((k + Math.floor(now / 60)) % 3) ctx.fillRect(Math.round(ax + ((bx - ax) * k) / n), Math.round(ay + ((by - ay) * k) / n), 1, 1);
    }
    if (this.S.ocean && this.rnd() < 0.12 * this.fxK) {
      const x = this.cam.x + this.rnd() * this.W;
      const top = this.colHeight(Math.floor(x / B));
      if (top > this.sea + 3 && top < 900) {
        const vy = -9 - this.rnd() * 4;
        this.parts.push({ x, y: top * B - 1, vx: 0, vy, life: ((((top - this.sea) * B) - 3) / -vy) * 1000, c: [200, 230, 255] });
      }
    }
  };
})();
