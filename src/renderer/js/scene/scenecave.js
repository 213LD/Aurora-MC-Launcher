'use strict';
/**
 * 主页动态背景：地下（第二阶段）。挂在 A.Scene.prototype 上，sceneworld.js / scene.js 调用。
 * - 洞穴群系：繁茂洞穴（苔藓、杜鹃丛、垂下来的发光浆果藤、孢子花）、溶洞（滴水石块、石笋石钟乳，钟乳尖会滴水），
 *   普通洞穴的墙上偶尔有发光地衣
 * - 结构：废弃矿井（坑道、支撑木、铁轨、蜘蛛网、运输矿车、竖井梯子，偶尔有洞穴蜘蛛刷怪笼）、
 *   地牢（圆石 / 苔石小屋、刷怪笼、箱子）、紫水晶洞（玄武岩 → 方解石 → 紫水晶，里面长着发光的晶簇）
 * - 生物：视角在地下时洞里有蝙蝠乱飞、僵尸 / 骷髅 / 苦力怕 / 蜘蛛沿着洞底走；画面里的刷怪笼会刷出它的怪。
 *   洞里的生物不晒太阳、不和地面上的玩家打
 */
(function () {
  const { hash, pal, pick, M, SPRITES, H, vnoise, CH, REG, DEEP, GEN, DECO, FX } = A.sceneKit;
  const P = A.Scene.prototype;

  Object.assign(M, {
    moss: pal('#5a7a2a', '#4f6e24', '#668a32'),
    dripstone: pal('#866a5a', '#7a5f50', '#927565'),
    calcite: pal('#dfe0dc', '#d0d2cd', '#eaebe7'),
    basalt: pal('#4a4a52', '#424249', '#55555d'),
    amethyst: pal('#8a5cc8', '#7a4eb4', '#9a6ad8', '#6f44a4'),
    budding: pal('#b48ae8', '#a07ad8', '#c49af0'),
    mossyCobble: pal('#6a7a5a', '#7a7a7a', '#5e7050', '#888888'),
  });

  Object.assign(SPRITES, {
    bat: H(['w...w', 'wwbww', '..b..'], { w: '#2e2620', b: '#4a3a2e' }, { fly: true }),
    caveSpider: H(['.kkk.', 'kkkRR', 'l.l.l'], { k: '#1d3a48', R: '#d02020', l: '#16303c' }, { hostile: true, emissive: 'R' }),
  });
  // 美西螈（繁茂洞穴的水塘里）：原版五种颜色，蓝色的很少见
  const AXO = { axolotl: ['#f4a6c8', '#e07aa8', '#c8507a'], axolotlWild: ['#7a5a40', '#5e4430', '#a07a5a'], axolotlGold: ['#f0c850', '#d8a830', '#f08a3a'], axolotlCyan: ['#d8eef4', '#b8d8e0', '#e86aa0'], axolotlBlue: ['#5a6ae0', '#4250c0', '#e8d040'] };
  for (const [k, [b, d, g]] of Object.entries(AXO)) SPRITES[k] = H(['....G.G', 'tbbbbbe', '.d.d...'], { b, d, t: d, G: g, e: '#222222' }, { swims: true, axolotl: true });
  const WALK_SPD = { zombie: 3, skeleton: 3, creeper: 2.5, spider: 5, caveSpider: 5.5, warden: 1.6 };

  // ───────────── 洞穴群系 ─────────────

  // 繁茂洞穴（发光浆果、苔藓、杜鹃）在原版里看的是「湿度」，不是高山：湿度高的地方（丛林、黑森林、沼泽底下）才有，
  // 沙漠这类干燥的地方底下没有（1.10.2 按场景给湿度；以前所有场景一样多）
  const HUMID = { jungle: 1, darkforest: 0.8, forest: 0.45, plains: 0.35, ocean: 0.4, mushroom: 0.3, cherry: 0.3, snowy: 0.25, desert: 0 };
  /**
   * 这里是什么洞穴：'lush' 繁茂、'drip' 溶洞、null 普通。
   * 1.10.1：按原版的分布——溶洞在内陆高地下面，这里只在高山底下出现（地面比基准高出一截的列），也比以前少；繁茂洞穴见上面的 HUMID
   */
  P.caveBiome = function (c, r) {
    if (this.dim !== 'over') return null;
    const humid = HUMID[this.sceneId] != null ? HUMID[this.sceneId] : 0.35;
    const v = vnoise(c / 52, (r - this.baseRow) / 24, this.wseed + 91); // 相对基准地面的行号，窗口高度变了也不变
    if (humid > 0 && v > 0.9 - 0.25 * humid) return 'lush';
    if (v < 0.24 && r > this.baseRow + 14 && this.mountK && this.colHeight(c) < this.baseRow - this.wr * 0.12) return 'drip';
    return null;
  };

  // ───────────── 裂谷、地下水 ─────────────

  const RV = 110; // 每 110 列最多一条裂谷
  /** 裂谷（1.10.1）：窄而深的竖直裂缝，中间宽两头尖，弯弯曲曲往下，底下常积水；顶上留几格不通到地面（地表的树、房子不受影响） */
  P.ravineInfo = function (c) {
    const s = this.wseed;
    const z = Math.floor(c / RV);
    if (hash(z, 7, s + 401) > 0.42) return null;
    const cx0 = z * RV + 15 + Math.floor(hash(z, 8, s + 402) * (RV - 30));
    if (Math.abs(c - cx0) > 9) return null;
    const d0 = 4 + Math.floor(hash(z, 9, s + 403) * 6);
    const d1 = d0 + 28 + Math.floor(hash(z, 10, s + 404) * 26);
    // 大多数裂谷底下积着几格深的水
    const pool = hash(z, 13, s + 406) < 0.7 ? 4 + Math.floor(hash(z, 14, s + 407) * 6) : 0;
    return { z, cx0, d0, d1, pool };
  };
  P.ravineAt = function (c, r, depth) {
    const v = this.ravineInfo(c);
    if (!v) return false;
    const { z, cx0, d0, d1 } = v;
    const s = this.wseed;
    if (depth < d0 || depth > d1) return false;
    const t = (depth - d0) / (d1 - d0);
    const half = 0.6 + 3.2 * Math.pow(Math.sin(Math.PI * t), 0.8);
    const y = r - this.baseRow;
    const center = cx0 + Math.sin(y * 0.13 + z) * 1.6 + (vnoise(y * 0.08, z, s + 405) - 0.5) * 3;
    return Math.abs(c + 0.5 - center) < half;
  };

  const AQ = 40; // 地下水按 40 列一段，每段一个水位
  /** 这一段的地下水位（行号），没有地下水返回 null */
  P.waterLevel = function (c) {
    const s = this.wseed;
    const z = Math.floor(c / AQ);
    if (hash(z, 11, s + 411) > 0.55 || this.BOT == null) return null;
    const lo = this.baseRow + 10;
    const hi = this.BOT - 16;
    return lo + Math.floor(hash(z, 12, s + 412) * Math.max(1, hi - lo));
  };

  /** 这一行里包含 c 的那段空洞，左右两头都被石头堵住（在同一段地下水里）吗：堵住了水才存得住 */
  P.runBounded = function (c, r) {
    const memo = this._aqMemo || (this._aqMemo = new Map());
    const key = c * 16384 + r;
    if (memo.has(key)) return memo.get(key);
    if (memo.size > 200000) memo.clear();
    const z0 = Math.floor(c / AQ) * AQ; const z1 = z0 + AQ - 1;
    let a = c; while (a >= z0 && !this.rawSolid(a, r)) a--;
    let b = c; while (b <= z1 && !this.rawSolid(b, r)) b++;
    const ok = a >= z0 && b <= z1;
    for (let k = Math.max(a + 1, z0); k <= Math.min(b - 1, z1); k++) memo.set(k * 16384 + r, ok);
    return ok;
  };

  /** 洞里的这格泡在地下水里吗（地下湖、裂谷底的积水）：在水位以下，而且往下一直到底，每一行都被两边的石头兜住 */
  P.caveWaterAt = function (c, r) {
    const L = this.waterLevel(c);
    if (L == null || r < L || r >= this.BOT - 12) return false;
    for (let rr = r; rr < r + 40; rr++) {
      // 往下碰到岩浆层（BOT - 12 以下的洞都是岩浆）：水存不住，不然会出现水压在岩浆上（1.10.2）
      if (rr >= this.BOT - 12) return false;
      if (this.rawSolid(c, rr)) return true;
      if (!this.runBounded(c, rr)) return false;
    }
    return false;
  };

  /**
   * 繁茂洞穴洞底的小水塘（rc1 之前补上的）：原版繁茂洞穴里到处是浅水塘，
   * 底下是黏土，长着大型垂滴叶，美西螈在里面游。这里：洞底一段两头被石头堵住（12 格以内）的低洼处积 1~2 格水，
   * 不是每个低洼都有（约一半）。下面每格是实地或者也是水塘，水才存得住
   */
  P.lushPoolAt = function (c, r, top) {
    return this.poolRun(c, r, 2) === 1;
  };
  /**
   * 这一行包含 c 的那段洞底能不能积水：1 能、0 不能。每段只算一次，整段的结果一起记下来（以前每格都重扫一遍，生成地形慢了三四成）。
   * levels：往下最多再看几行（水塘最多 2 格深）
   */
  P.poolRun = function (c, r, levels) {
    if (this.dim !== 'over' || levels <= 0 || r >= this.BOT - 12) return 0;
    const memo = this._lpMemo || (this._lpMemo = new Map());
    const key = (c * 16384 + r) * 4 + levels;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let ok = 0;
    let a = c; let b = c;
    if (!this.rawSolid(c, r) && this.caveBiome(c, r) === 'lush') {
      // 往两边最多找 LUSH_W + 1 格，超过 LUSH_W 宽的不算：从这一段里哪一格开始查，找到的两头都一样，结果和查的先后无关
      // （rc6：以前两边各找 13 格，13~25 格宽的低洼从中间查能积水、从边上查不能，拉窗口后水塘可能变）
      const LUSH_W = 24;
      while (a > c - LUSH_W - 1 && !this.rawSolid(a, r)) a--;
      while (b < c + LUSH_W + 1 && !this.rawSolid(b, r)) b++;
      ok = this.rawSolid(a, r) && this.rawSolid(b, r) && b - a - 1 >= 2 && b - a - 1 <= LUSH_W && hash(a, r - this.baseRow, this.wseed + 131) < 0.55 ? 1 : 0;
      for (let k = a + 1; ok && k < b; k++) if (!this.rawSolid(k, r + 1) && this.poolRun(k, r + 1, levels - 1) !== 1) ok = 0;
    }
    if (memo.size > 200000) memo.clear();
    if (b > a + 1) for (let k = a + 1; k < b; k++) memo.set((k * 16384 + r) * 4 + levels, ok);
    else memo.set(key, ok);
    return ok;
  };

  /**
   * 水碰岩浆（rc3）：原版里水流到静止的岩浆（岩浆源）上会变成黑曜石，碰到流动的岩浆才是圆石。
   * 洞底的岩浆湖都是静止的，所以是黑曜石：岩浆湖面（BOT - 12 那一行，上面一格是洞里的空气）上，
   * 有瀑布正好落下来的那一列和左右各一列（水落地会往两边淌一点）变成黑曜石，瀑布落在黑曜石上溅水花。
   * 只看湖面一行；按列记住，不用每次往上找
   */
  P.fallInto = function (c) {
    const memo = this._fallInto || (this._fallInto = new Map());
    if (memo.has(c)) return memo.get(c);
    let hit = false;
    const surf = this.BOT - 12;
    const top = this.colHeight(c);
    const structs = this.structsIn(c, c);
    for (let r = surf - 1; r > surf - 49 && r > top; r--) {
      // 和画的时候一样：结构（矿井、地牢……）盖在洞穴上面
      const s = structs.length ? this.structCell(structs, c, r, top) : undefined;
      if (s !== undefined) { if (s && s.mat && !s.cave) break; continue; }
      if (this.rawSolid(c, r, top)) break;
      const cell = this.caveCell(c, r, top);
      if (cell.cwater) break;
      if (cell.fx === 'fall') { hit = true; break; }
    }
    if (memo.size > 20000) memo.clear();
    memo.set(c, hit);
    return hit;
  };
  P.quenchedAt = function (c, r) {
    if (this.dim !== 'over' || this.BOT == null || r !== this.BOT - 12) return false;
    const top = this.colHeight(c);
    if (r <= top + 1 || this.rawSolid(c, r, top) || this.rawSolid(c, r - 1, top)) return false;
    return this.fallInto(c) || this.fallInto(c - 1) || this.fallInto(c + 1);
  };

  /** 洞穴里的一格：地下水、瀑布在上面加（1.10.1） */
  P.caveCell = function (c, r, top) {
    const cell = this.caveCell0(c, r, top);
    if (cell.lava || this.dim !== 'over') return cell;
    const depth0 = r - (top == null ? this.colHeight(c) : top);
    const rv = this.ravineAt(c, r, depth0) && this.ravineInfo(c);
    // 水面按裂谷中线那列算，整条一样平；裂谷底伸进岩浆层的不积水
    const rvBot = rv ? this.colHeight(rv.cx0) + rv.d1 : 0;
    const poolRow = rv && rv.pool && rvBot < this.BOT - 14 ? rvBot - rv.pool : Infinity;
    const rvPool = r >= poolRow;
    if (rvPool || this.caveWaterAt(c, r)) {
      // 深板岩层里一部分地下水是岩浆（原版：Y=0 以下的含水层有的是岩浆，rc4，scenefluid.js）
      if (!rvPool && this.aquiferLava(c)) { delete cell.deco; delete cell.fx; cell.lava = true; cell.lavaPool = true; return cell; }
      cell.cwater = true;
      cell.surf = rvPool ? r === poolRow : r === this.waterLevel(c);
      if (cell.deco === 'vine' || cell.deco === 'tite' || cell.deco === 'lichen') delete cell.deco;
      if (cell.fx === 'drip') delete cell.fx;
      return cell;
    }
    if (cell.mat === M.moss && this.lushPoolAt(c, r, top)) { // 只有繁茂洞穴（苔藓背景）的格子才看，不然每格多算两次噪声
      cell.cwater = true;
      cell.lushPool = true;
      cell.surf = !this.lushPoolAt(c, r - 1, top);
      delete cell.deco; delete cell.fx; // 草、杜鹃、孢子花不长在水里
      return cell;
    }
    // 浅层的小岩浆湖（原版：Y=0 以上的地下有岩浆湖，rc4，scenefluid.js）
    if (this.lavaPoolAt(c, r)) { delete cell.deco; delete cell.fx; cell.lava = true; cell.lavaPool = true; return cell; }
    // 洞穴瀑布：从洞壁里流出来、往下落到洞底或水面。裂谷两壁又高又陡，瀑布多一些
    // 越深越多的是岩浆瀑布（原版的岩浆泉，rc4）
    const s = this.wseed;
    const depth = r - (top == null ? this.colHeight(c) : top);
    if (!cell.fx && depth > 10) {
      const wallL = this.rawSolid(c - 1, r, null); const wallR = this.rawSolid(c + 1, r, null);
      if ((wallL || wallR) && !this.rawSolid(c, r + 1, null)) {
        const p = this.ravineAt(c, r, depth) ? 0.035 : 0.006;
        if (hash(c, r - this.baseRow, s + 421) < p) {
          cell.fx = hash(c, r - this.baseRow, s + 437) < this.lavaFallShare(r) ? 'lavafall' : 'fall';
          cell.fallSide = wallL ? -1 : 1;
        }
      }
    }
    return cell;
  };

  /** 洞穴里的一格（sceneworld.cellAt 转过来）：背景墙 + 地上 / 顶上长的东西 */
  P.caveCell0 = function (c, r, top) {
    const baseMat = r >= this.baseRow + DEEP ? M.deepslate : M.stone;
    if (r >= this.BOT - 12) {
      // 瀑布落到岩浆湖上：落点和两边各一格的岩浆变成黑曜石，上面冒一点蒸汽（rc3，以前水碰岩浆没反应）
      if (this.quenchedAt(c, r)) return { mat: M.obsidian, quench: true, fx: 'steam' };
      return { mat: baseMat, cave: true, lava: true };
    }
    const bio = this.caveBiome(c, r);
    const solid = (rr) => this.rawSolid(c, rr, top);
    const s = this.wseed;
    if (bio === 'lush') {
      const cell = { mat: M.moss, cave: true };
      // 水塘水面上长着大型垂滴叶
      if (!solid(r + 1) && this.lushPoolAt(c, r + 1, top)) {
        if (hash(c, r - this.baseRow, s + 113) < 0.3) cell.deco = 'dripleaf';
        return cell;
      }
      if (solid(r + 1)) {
        const h = hash(c, r - this.baseRow, s + 101);
        if (h < 0.4) cell.deco = 'grass';
        else if (h < 0.5) cell.deco = 'azalea';
      } else if (solid(r - 1)) {
        if (hash(c, r - this.baseRow, s + 102) < 0.06) cell.deco = 'spore';
        else if (hash(c, 0, s + 103) < 0.45) cell.deco = 'vine';
      } else if (hash(c, 0, s + 103) < 0.45) {
        // 发光浆果藤从洞顶垂下来 1~5 格
        const len = 1 + Math.floor(hash(c, 1, s + 104) * 5);
        for (let k = 2; k <= len; k++) if (solid(r - k)) { cell.deco = 'vine'; break; }
      }
      if (cell.deco === 'vine') cell.berry = hash(c, r - this.baseRow, s + 105) < 0.35;
      return cell;
    }
    if (bio === 'drip') {
      const cell = { mat: M.dripstone, cave: true };
      // 石笋（从地上长）和石钟乳（从顶上挂），这一列有没有、多高按列定
      if (hash(c, 2, s + 106) < 0.35) {
        const len = 1 + Math.floor(hash(c, 3, s + 107) * 3);
        for (let k = 1; k <= len; k++) if (solid(r + k)) { Object.assign(cell, { deco: 'mite', part: k, len }); break; }
      }
      if (!cell.deco && hash(c, 4, s + 108) < 0.4) {
        const len = 1 + Math.floor(hash(c, 5, s + 109) * 3);
        for (let k = 1; k <= len; k++) {
          if (solid(r - k)) { Object.assign(cell, { deco: 'tite', part: k, len }); if (k === len) cell.fx = 'drip'; break; }
        }
      }
      return cell;
    }
    const cell = { mat: baseMat, cave: true };
    if (hash(c, r - this.baseRow, s + 110) < 0.035 && (solid(r + 1) || solid(r - 1))) cell.deco = 'lichen';
    return cell;
  };

  /** 洞穴旁边的实心格：繁茂洞穴是苔藓块（夹着黏土），溶洞是滴水石块（sceneworld.cellAt 调用，返回 null = 照常） */
  P.caveWall = function (c, r, top, depth) {
    if (this.dim !== 'over' || depth < 6) return null;
    const bio = this.caveBiome(c, r);
    // 水塘底下是黏土。水塘在繁茂洞穴最下沿时这一格已经不算繁茂洞穴：上面那格画的时候已经算过，直接查记下来的结果
    if (bio === 'lush' ? this.lushPoolAt(c, r - 1, null) : this._lpMemo && this._lpMemo.get(((c * 16384 + r - 1) * 4 + 2)) === 1) return { mat: M.clay };
    if (!bio) return null;
    const s = this.wseed;
    const near = this.isCave(c, r - 1, depth - 1) || this.isCave(c, r + 1, depth + 1);
    if (!near) return bio === 'drip' && vnoise(c * 0.25, (r - this.baseRow) * 0.3, s + 111) > 0.62 ? { mat: M.dripstone } : null;
    if (bio === 'lush') return { mat: this.lushPoolAt(c, r - 1, null) || hash(c, r - this.baseRow, s + 112) < 0.15 ? M.clay : M.moss }; // 水塘底下是黏土
    return { mat: M.dripstone };
  };

  // ───────────── 结构 ─────────────

  /** 坑道里的空气格（背景是石头 / 深板岩） */
  function air(sc, r, deco) {
    const cell = { mat: r >= sc.baseRow + DEEP ? M.deepslate : M.stone, cave: true };
    if (deco) cell.deco = deco;
    return cell;
  }

  /** 废弃矿井：一两层坑道（3 格高，每 5 列一组支撑木），两层之间有带梯子的竖井 */
  P.makeMineshaft = function (x0, rnd) {
    const lo = this.baseRow + 14; const hi = this.BOT - 16;
    if (hi - lo < 12) return null;
    const fr = lo + Math.floor(rnd() * (hi - lo - 10));
    const L = 30 + Math.floor(rnd() * 26);
    const halls = [{ c0: x0, c1: x0 + L - 1, fr }];
    let shaft = null;
    if (rnd() < 0.6) {
      const fr2 = fr + 7 + Math.floor(rnd() * 3);
      const c0b = x0 + 6 + Math.floor(rnd() * 10);
      const L2 = 18 + Math.floor(rnd() * 14);
      halls.push({ c0: c0b, c1: c0b + L2 - 1, fr: fr2 });
      const lo2 = c0b + 2; const hi2 = Math.min(x0 + L - 3, c0b + L2 - 3);
      if (hi2 > lo2) shaft = { c: lo2 + Math.floor(rnd() * (hi2 - lo2)), r0: fr - 3, r1: fr2 - 1 };
    }
    const cart = x0 + 2 + Math.floor(rnd() * (L - 4));
    // 一半的矿井有洞穴蜘蛛刷怪笼（周围一圈蜘蛛网）
    const sp = rnd() < 0.5 ? [x0 + 4 + Math.floor(rnd() * (L - 8)), fr - 1] : null;
    const s = this.wseed;
    const b = this.baseRow; // 随机数用相对基准地面的行号：拉窗口整体挪了以后还是同一个样子（rc6）
    const self = this;
    return {
      type: 'mineshaft', c0: Math.min(...halls.map((h) => h.c0)), c1: Math.max(...halls.map((h) => h.c1)),
      r0: fr - 3, r1: Math.max(...halls.map((h) => h.fr)), sp, mob: 'caveSpider',
      cell(c, r, top) {
        if (shaft && c >= shaft.c && c <= shaft.c + 1 && r >= shaft.r0 && r <= shaft.r1) return air(self, r, c === shaft.c ? 'ladder' : null);
        for (const h of halls) {
          if (c < h.c0 || c > h.c1 || r < h.fr - 3 || r > h.fr) continue;
          if (r === h.fr) return self.rawSolid(c, r, top) ? undefined : { mat: M.planks }; // 横穿洞穴的地方铺木板
          const post = (c - h.c0) % 5 === 2;
          if (sp && c === sp[0] && r === sp[1]) return { ...air(self, r), fx: 'spawner' };
          const nearSp = sp && Math.abs(c - sp[0]) <= 2 && Math.abs(r - sp[1]) <= 2;
          if (r === h.fr - 3) return post ? { mat: M.planks } : air(self, r, nearSp || hash(c, r - b, s + 120) < 0.12 ? 'web' : null);
          if (r === h.fr - 1) return air(self, r, post ? 'postRail' : c === cart && h === halls[0] ? 'cart' : 'rail');
          return air(self, r, post ? 'post' : nearSp || hash(c, r - b, s + 121) < 0.08 ? 'web' : null);
        }
        return undefined;
      },
    };
  };

  /** 地牢：圆石 / 苔石小屋，中间刷怪笼，两边箱子 */
  P.makeDungeon = function (x0, rnd) {
    const lo = this.baseRow + 12; const hi = this.BOT - 16;
    if (hi <= lo) return null;
    const fr = lo + Math.floor(rnd() * (hi - lo));
    const w = 7 + Math.floor(rnd() * 3);
    const mob = pick(['zombie', 'skeleton', 'spider'], rnd());
    const spc = x0 + Math.floor(w / 2);
    const chests = [x0 + 1, x0 + w - 2].filter(() => rnd() < 0.7);
    const s = this.wseed;
    const b = this.baseRow;
    return {
      type: 'dungeon', c0: x0, c1: x0 + w - 1, r0: fr - 4, r1: fr, sp: [spc, fr - 1], mob,
      cell(c, r) {
        if (c === x0 || c === x0 + w - 1 || r === fr - 4 || r === fr) return { mat: hash(c, r - b, s + 122) < (r === fr ? 0.6 : 0.35) ? M.mossyCobble : M.cobble };
        const cell = { mat: M.cobble, cave: true };
        if (r === fr - 1 && c === spc) cell.fx = 'spawner';
        else if (r === fr - 1 && chests.includes(c)) cell.deco = 'chest';
        else if (hash(c, r - b, s + 123) < 0.08) cell.deco = 'web';
        return cell;
      },
    };
  };

  /** 紫水晶洞：一圈圈的玄武岩、方解石、紫水晶，空心里长着发光的晶簇 */
  P.makeGeode = function (x0, rnd) {
    const R = 5 + Math.floor(rnd() * 3);
    const lo = this.baseRow + 16 + R; const hi = this.BOT - 16 - R;
    if (hi <= lo) return null;
    const gr = lo + Math.floor(rnd() * (hi - lo));
    const gc = x0 + R + 1;
    const s = this.wseed;
    const b = this.baseRow;
    return {
      type: 'geode', c0: gc - R - 1, c1: gc + R + 1, r0: gr - R - 1, r1: gr + R + 1,
      cell(c, r) {
        const d = Math.hypot(c - gc, r - gr) + (hash(c, r - b, s + 131) - 0.5) * 0.6;
        if (d > R + 0.5) return undefined;
        if (d > R - 0.5) return { mat: M.basalt };
        if (d > R - 1.5) return { mat: M.calcite };
        if (d > R - 2.5) return hash(c, r - b, s + 132) < 0.12 ? { mat: M.budding, glow: true } : { mat: M.amethyst };
        const cell = { mat: M.amethyst, cave: true };
        if (d > R - 3.5 && hash(c, r - b, s + 133) < 0.55) {
          // 晶簇从墙上朝中间长
          const dx = c - gc; const dy = r - gr;
          cell.deco = 'cluster';
          cell.side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : dy > 0 ? 'd' : 'u';
          if (hash(c, r - b, s + 134) < 0.25) cell.fx = 'sparkle';
        }
        return cell;
      },
    };
  };

  // 每个区域最多一个地下结构；打开时那一屏底下一定有一个
  GEN.push(function (reg, rnd) {
    if (this.dim !== 'over' || this.BOT == null) return null;
    let k = rnd();
    if (reg === 0 || reg === -1) k *= 0.85;
    const x0 = reg * REG + 3 + Math.floor(rnd() * 20);
    if (k < 0.36) return this.makeMineshaft(x0, rnd);
    if (k < 0.6) return this.makeDungeon(x0, rnd);
    if (k < 0.85) return this.makeGeode(x0, rnd);
    // 远古城市（scenedeep.js）：只在有山的场景底下，深板岩层最下面
    if (k < 0.97 && this.mountK && this.makeAncientCity) return this.makeAncientCity(x0, rnd);
    return null;
  });

  // ───────────── 画进块里的小装饰（dot(px, py, 颜色, 发光)，一格 B×B） ─────────────

  const C = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const GREEN = C('#5a9a32'); const DARKG = C('#3e7a26'); const WOOD = C('#9c7a47'); const DARKW = C('#6b4a2a');
  const IRON = C('#a8a8a8'); const WEB = C('#d8d8d8'); const DRIP = C('#a08070'); const DRIP2 = C('#8a6a5a');

  DECO.grass = (dot) => { dot(0, 3, GREEN); dot(1, 2, GREEN); dot(1, 3, DARKG); dot(3, 3, GREEN); dot(3, 2, DARKG); };
  DECO.azalea = (dot) => {
    for (let x = 0; x < 4; x++) { dot(x, 2, DARKG); dot(x, 3, x === 1 || x === 2 ? DARKW : GREEN); }
    dot(1, 1, GREEN); dot(2, 1, GREEN); dot(0, 2, C('#c070c8')); dot(3, 1, C('#d888d8'));
  };
  DECO.vine = (dot, cell, c) => {
    const x = 1 + (c & 1);
    for (let y = 0; y < 4; y++) dot(x, y, y % 2 ? DARKG : GREEN);
    if (cell.berry) { dot(x - 1, 2, C('#ffb83a'), true); dot(x + 1, 1, C('#ffd060'), true); }
  };
  // 大型垂滴叶：一根茎从水里伸出来，顶上一片平平的大叶子
  DECO.dripleaf = (dot) => { for (let x = 0; x < 4; x++) dot(x, 1, x === 0 || x === 3 ? GREEN : C('#7ab83a')); dot(1, 2, DARKG); dot(2, 2, DARKG); dot(1, 3, DARKG); };
  DECO.spore = (dot) => { dot(1, 0, GREEN); dot(2, 0, GREEN); dot(0, 1, C('#e070a8')); dot(1, 1, C('#f090c0')); dot(2, 1, C('#e070a8')); dot(3, 1, C('#f090c0')); dot(1, 2, C('#d0609a')); };
  DECO.lichen = (dot, cell, c, r) => { const y = hash(c, r, 7) < 0.5 ? 3 : 0; dot(0, y, C('#7fd8b0'), true); dot(2, y, C('#a8f0c8'), true); dot(3, y, C('#7fd8b0'), true); };
  // 石笋 / 石钟乳：part 1 是贴着地面 / 洞顶的那格，越往尖越细
  const spike = (dot, cell, up) => {
    const total = cell.len * 4;
    for (let py = 0; py < 4; py++) {
      const fromBase = up ? (cell.part - 1) * 4 + (3 - py) : (cell.part - 1) * 4 + py;
      const w = Math.max(1, Math.round(3 * (1 - fromBase / total)));
      for (let px = 2 - Math.ceil(w / 2); px < 2 - Math.ceil(w / 2) + w; px++) dot(px, py, (px + py) % 3 ? DRIP : DRIP2);
    }
  };
  DECO.mite = (dot, cell) => spike(dot, cell, true);
  DECO.tite = (dot, cell) => spike(dot, cell, false);
  DECO.rail = (dot) => { for (let x = 0; x < 4; x++) { dot(x, 3, x % 2 ? DARKW : WOOD); dot(x, 2, IRON); } };
  DECO.post = (dot) => { for (let y = 0; y < 4; y++) { dot(1, y, WOOD); dot(2, y, DARKW); } };
  DECO.postRail = (dot) => { DECO.rail(dot); DECO.post(dot); };
  DECO.web = (dot) => { dot(0, 0, WEB); dot(3, 0, WEB); dot(1, 1, WEB); dot(2, 1, WEB); dot(1, 2, WEB); dot(2, 2, WEB); dot(0, 3, WEB); dot(3, 3, WEB); dot(1, 0, WEB); };
  DECO.ladder = (dot) => { for (let y = 0; y < 4; y++) { dot(0, y, WOOD); dot(3, y, WOOD); } dot(1, 1, DARKW); dot(2, 1, DARKW); dot(1, 3, DARKW); dot(2, 3, DARKW); };
  DECO.cart = (dot) => {
    DECO.rail(dot);
    for (let x = 0; x < 4; x++) dot(x, 1, C('#6a6a6a'));
    dot(0, 0, C('#5a5a5a')); dot(3, 0, C('#5a5a5a')); dot(1, 0, C('#a8742a')); dot(2, 0, C('#a8742a'));
  };
  DECO.chest = (dot) => {
    for (let x = 0; x < 4; x++) for (let y = 1; y < 4; y++) dot(x, y, y === 1 ? C('#8a5a1e') : C('#a8742a'));
    dot(1, 2, C('#3a2a1a')); dot(2, 2, C('#e8c040'));
  };
  DECO.cluster = (dot, cell) => {
    const a = C('#d8a8ff'); const b = C('#b47ef0');
    const pts = { d: [[1, 3], [2, 3], [1, 2], [2, 1], [3, 3]], u: [[1, 0], [2, 0], [2, 1], [1, 2], [0, 0]], l: [[0, 1], [0, 2], [1, 2], [2, 1], [0, 3]], r: [[3, 1], [3, 2], [2, 2], [1, 1], [3, 0]] }[cell.side];
    pts.forEach(([x, y], i) => dot(x, y, i % 2 ? b : a, true));
  };

  // ───────────── 每帧动的效果 ─────────────

  /** 刷怪笼：笼子里转着一个小生物，冒火星 */
  FX.spawner = function (x, y, now) {
    const g = this.ctx;
    g.fillStyle = this.caveColor([90, 150, 90]);
    g.fillRect(x + 1 + Math.round(Math.sin(now / 300)), y + 1, 1, 2);
    g.fillStyle = this.caveColor([36, 40, 48]);
    g.fillRect(x, y, 4, 1); g.fillRect(x, y + 3, 4, 1); g.fillRect(x, y, 1, 4); g.fillRect(x + 3, y, 1, 4);
    if (!this.noFlash && this.rnd() < 0.08 * this.fxK) this.parts.push({ x: x - this.landX + 1 + this.rnd() * 2, y: y - this.landY + 1, vx: 0, vy: -4, life: 500, c: [255, 160, 60], glow: true });
  };
  /** 石钟乳尖上滴水 */
  /** 洞穴瀑布：往下一直落到洞底或水面（长度第一次用到时算好存着），水流一节节往下走，落点溅水花 */
  /** 瀑布从 (c, r) 往下落几格：落到洞底、水面、岩浆面或黑曜石为止（最多 48 格），按格子记住 */
  P.fallLen = function (c, r) {
    const fl = this._fallLen || (this._fallLen = new Map());
    const key = c * 16384 + r;
    let len = fl.get(key);
    if (len == null) {
      len = 1;
      while (len < 48 && !this.rawSolid(c, r + len, null) && !this.caveWaterAt(c, r + len) && !this.quenchedAt(c, r + len) && !this.lavaAt(c, r + len)) len++;
      fl.set(key, len);
    }
    return len;
  };
  /** 画一道往下落的水流 / 岩浆流（瀑布、岩浆瀑布，scenefluid.js 的流动也用） */
  P.drawStream = function (x, y, len, now, c, lava) {
    const B = this.B;
    const w = Math.max(2, Math.round(B * 0.7));
    const x0 = x + (B - w) / 2;
    const g = this.ctx;
    g.fillStyle = lava ? 'rgba(232,110,24,0.95)' : 'rgba(52,104,214,0.78)';
    g.fillRect(x0, y + B * 0.4, w, len * B - B * 0.4);
    g.fillStyle = lava ? 'rgba(255,214,90,0.85)' : 'rgba(150,190,255,0.7)';
    const off = (now * (lava ? 0.02 : 0.05)) % 6;
    for (let py = off; py < len * B; py += 6) g.fillRect(x0 + ((py / 6) & 1), y + B * 0.4 + py, 1, 2);
    // 出水口和落点的水花（岩浆是溅起的火星）
    g.fillStyle = lava ? 'rgba(255,190,80,0.85)' : 'rgba(200,225,255,0.8)';
    const by = y + len * B - 1;
    for (let k = 0; k < 3; k++) {
      const dx = Math.sin(now * (lava ? 0.004 : 0.01) + k * 2.1 + c) * (B * 0.9);
      g.fillRect(x + B / 2 + dx, by - Math.abs(Math.cos(now * 0.013 + k)) * 2, 1, 1);
    }
  };
  FX.fall = function (x, y, now, c, r) { this.drawStream(x, y, this.fallLen(c, r), now, c, false); };
  FX.lavafall = function (x, y, now, c, r) { this.drawStream(x, y, this.fallLen(c, r), now, c, true); };

  /** 黑曜石上（下面还是岩浆）：偶尔冒一缕蒸汽 */
  FX.steam = function (x, y) {
    if (this.rnd() < 0.05 * this.fxK) this.parts.push({ x: x - this.landX + this.rnd() * 4, y: y - this.landY - 1, vx: (this.rnd() - 0.5) * 3, vy: -7 - this.rnd() * 4, life: 900 + this.rnd() * 500, c: [215, 220, 228], glow: true, drag: 0.6 });
  };

  FX.drip = function (x, y) {
    if (this.rnd() < 0.006 * this.fxK) this.parts.push({ x: x - this.landX + 2, y: y - this.landY + 4, vx: 0, vy: 0, g: 80, life: 700, c: [140, 180, 255] });
  };
  /** 紫水晶闪光 */
  FX.sparkle = function (x, y) {
    if (!this.noFlash && this.rnd() < 0.015 * this.fxK) this.parts.push({ x: x - this.landX + this.rnd() * 4, y: y - this.landY + this.rnd() * 4, vx: 0, vy: -1, life: 600, c: [230, 200, 255], glow: true });
  };

  // ───────────── 生物 ─────────────

  /** 地下的颜色：不跟着昼夜变暗（洞里的生物、刷怪笼用） */
  const caveCache = new Map();
  P.caveColor = function (c) {
    const key = c.join(',');
    let v = caveCache.get(key);
    if (!v) { v = `rgb(${c[0] * 0.88 | 0},${c[1] * 0.88 | 0},${c[2] * 0.88 | 0})`; caveCache.set(key, v); }
    return v;
  };

  /**
   * 这格是水还是岩浆：洞穴深处的岩浆、地下湖和裂谷底的积水（按块画的时候记下的那些格）、地表的水。
   * 洞里的生物不生成在里面，走路、蝙蝠乱飞也绕开（1.10.3：以前只躲岩浆，蝙蝠和怪物会刷在积水里）
   */
  P.fluidAt = function (c, r) {
    if (this.lavaAt(c, r)) return 'lava';
    if (this.sea < 900 && r >= this.sea && r < this.colHeight(c)) return 'water';
    const ch = this.chunks.get(Math.floor(c / CH));
    if (!ch) return this.caveWaterAt(c, r) ? 'water' : null;
    if (!ch.wset) ch.wset = new Set((ch.cwater || []).map(([i, rr]) => rr * CH + i - ch.c0));
    return ch.wset.has(r * CH + c - ch.c0) ? 'water' : null;
  };

  /** 视角在地下：在洞里生成蝙蝠和怪物；画面里的刷怪笼先刷它的怪。返回 true 表示生成了（scene.spawn 调用） */
  P.caveSpawn = function (now) {
    if (this.dim !== 'over' || this.BOT == null) return false;
    const o = this.opts; const B = this.B; const r = this.rnd;
    const c0 = Math.floor(this.cam.x / B); const c1 = Math.floor((this.cam.x + this.W) / B);
    const r0 = Math.floor(this.cam.y / B); const r1 = Math.floor((this.cam.y + this.H) / B);
    const monsters = o.monsters && !o.peaceful;
    if (monsters) {
      for (const s of this.structsIn(c0, c1)) {
        if (!s.sp) continue;
        const [sc, sr] = s.sp;
        if (sc < c0 || sc > c1 || sr < r0 || sr > r1 || this.ents.filter((e) => e.spawner === s).length >= 2) continue;
        for (const dc of [-1, 1, -2, 2]) {
          if (this.solidAt(sc + dc, sr) || !this.solidAt(sc + dc, sr + 1) || this.fluidAt(sc + dc, sr)) continue;
          const e = this.mkEnt(s.mob, (sc + dc) * B, (sr + 1) * B, now, { cave: true, spawner: s, life: 25000 + r() * 30000 });
          this.puff(e.x + 1, e.y - 3, [120, 120, 130], 8);
          return true;
        }
      }
    }
    if (this.wardenSpawn && this.wardenSpawn(now)) return true;
    // 画面大半在地下才生成洞里的生物
    let sum = 0; let n = 0;
    for (let c = c0; c <= c1; c += 4) { const h = this.colHeight(c); if (h < 900) { sum += h; n++; } }
    if (!n || sum / n > r0 + (r1 - r0) * 0.4) return false;
    if (o.aquatic && this.axolotlSpawn(now, c0, c1, r0, r1)) return true;
    const kinds = [];
    if (o.animals) kinds.push(['bat', 3]);
    if (monsters) kinds.push(['zombie', 2], ['skeleton', 2], ['creeper', 1.5], ['spider', 1.5], ['slime', 1]); // 史莱姆（rc3）：原版地下的史莱姆区块里也有
    if (!kinds.length) return false;
    let roll = r() * kinds.reduce((a, k) => a + k[1], 0);
    let kind = kinds[0][0];
    for (const [k, w] of kinds) { roll -= w; if (roll <= 0) { kind = k; break; } }
    const fly = kind === 'bat';
    const tall = Math.ceil(SPRITES[kind].h / B);
    for (let t = 0; t < 40; t++) {
      const c = c0 + 1 + Math.floor(r() * Math.max(1, c1 - c0 - 2));
      const row = r0 + 1 + Math.floor(r() * Math.max(1, r1 - r0 - 2));
      if (row <= this.colHeight(c) + 2 || row >= this.BOT || this.solidAt(c, row) || this.fluidAt(c, row)) continue;
      if (this.inAncientCity && this.inAncientCity(c, row)) continue; // 原版深暗之域里不刷生物（scenedeep.js）
      if (fly) { this.mkEnt(kind, c * B + 1, row * B + 2, now, { cave: true, life: 30000 + r() * 30000 }); return true; }
      if (!this.solidAt(c, row + 1)) continue;
      let ok = true;
      for (let k = 1; k < tall; k++) if (this.solidAt(c, row - k) || this.fluidAt(c, row - k)) ok = false;
      if (!ok) continue;
      this.mkEnt(kind, c * B + 1, (row + 1) * B, now, { cave: true, life: 30000 + r() * 40000 });
      return true;
    }
    return false;
  };

  /** 繁茂洞穴的水塘在画面里：生成美西螈（同时最多 4 条）。caveSpawn 调用 */
  P.axolotlSpawn = function (now, c0, c1, r0, r1) {
    if (this.ents.filter((e) => e.spr.axolotl).length >= 4 || this.rnd() > 0.5) return false;
    const pools = [];
    for (const ch of this.chunks.values()) {
      if (ch.c0 + CH < c0 || ch.c0 > c1) continue;
      for (const [c, r] of ch.cwater || []) if (c >= c0 && c <= c1 && r >= r0 && r <= r1 && this.lushPoolAt(c, r, null)) pools.push([c, r]);
    }
    if (!pools.length) return false;
    const [c, row] = pick(pools, this.rnd());
    const v = this.rnd();
    const kind = v < 0.004 ? 'axolotlBlue' : v < 0.45 ? 'axolotl' : v < 0.65 ? 'axolotlWild' : v < 0.83 ? 'axolotlGold' : 'axolotlCyan';
    // 整条身子都要在水里（rc4：美西螈放大到 9 格宽以后，贴着水塘最右边那格放，身子一半在岸上）：这一行连着的水够宽才放，放在水面中间
    const B = this.B; const w = SPRITES[kind].w;
    let a = c; let b = c;
    while (a > c - 12 && this.fluidAt(a - 1, row) === 'water') a--;
    while (b < c + 12 && this.fluidAt(b + 1, row) === 'water') b++;
    const room = (b - a + 1) * B - w;
    if (room < 0) return false;
    this.mkEnt(kind, a * B + Math.floor(this.rnd() * (room + 1)), row * B + 3, now, { cave: true, swimCave: true, life: 40000 + this.rnd() * 30000 });
    return true;
  };

  /** 美西螈在水塘里慢慢游：只在有水的格子里，碰到岸边就掉头 */
  P.caveSwim = function (e, sec, now) {
    const B = this.B; const r = this.rnd;
    if (now > e.until) { e.vx = (r() - 0.5) * 7; e.vy = (r() - 0.5) * 1.5; e.until = now + 1200 + r() * 2500; }
    const nx = e.x + (e.vx || 0) * sec; const ny = e.y + (e.vy || 0) * sec;
    const lead = Math.floor((nx + ((e.vx || 0) > 0 ? e.spr.w - 1 : 0)) / B);
    const row = Math.floor((ny - 1) / B);
    if (this.fluidAt(lead, row) === 'water' && this.fluidAt(Math.floor((nx + e.spr.w / 2) / B), row) === 'water') { e.x = nx; e.y = ny; } else { e.vx = -(e.vx || 0); e.vy = 0; }
    if (e.vx) e.dir = e.vx > 0 ? 1 : -1;
  };

  /** 洞里的生物每帧（scene.updateEnt 转过来） */
  P.caveTick = function (e, sec, now) {
    const B = this.B; const r = this.rnd;
    if (e.swimCave) { this.caveSwim(e, sec, now); return; }
    if (e.spr.fly) {
      // 蝙蝠：一扑一扑地乱飞，碰到墙就弹回来（上下翻转当作扇翅膀）
      e.flip = Math.floor(now / 110 + e.born) % 2 === 0;
      if (now > e.until) { e.vx = (r() - 0.5) * 26; e.vy = (r() - 0.5) * 14; e.until = now + 400 + r() * 900; }
      const nx = e.x + (e.vx || 0) * sec; const ny = e.y + (e.vy || 0) * sec;
      const c = Math.floor((nx + 2) / B); const row = Math.floor((ny - 1) / B);
      if (this.solidAt(c, row) || this.fluidAt(c, row) || row <= this.colHeight(c)) { e.vx = -(e.vx || 0); e.vy = -(e.vy || 0); } else { e.x = nx; e.y = ny; }
      e.dir = (e.vx || 0) >= 0 ? 1 : -1;
      return;
    }
    if (now > e.until) {
      const walk = r() < 0.6;
      e.state = walk ? 'walk' : 'idle';
      if (walk && r() < 0.5) e.dir *= -1;
      e.until = now + (walk ? 1500 + r() * 3000 : 1200 + r() * 3000);
    }
    e.moving = e.state === 'walk';
    if (e.moving && !this.caveStep(e, e.dir, (WALK_SPD[e.kind] || 3) * sec)) { e.dir *= -1; e.state = 'idle'; e.moving = false; }
    if (e.fy == null) e.fy = Math.round(e.y / B);
    e.y += (e.fy * B - e.y) * Math.min(1, sec * 12); // 脚踩在地面方块的上沿
  };

  /** 沿洞底走一步：前面那列找能站的地面（平地、上一格、下一格），头顶要有空；走不过去返回 false（也给 scenefight 的击退用） */
  P.caveStep = function (e, dir, dist) {
    const B = this.B;
    const nx = e.x + dir * dist;
    const lead = Math.floor((nx + (dir > 0 ? e.spr.w - 1 : 0)) / B);
    const fr = e.fy != null ? e.fy : Math.round(e.y / B); // 脚下那格地面
    const tall = Math.ceil(e.spr.h / B);
    const ok = (f) => {
      if (!this.solidAt(lead, f)) return false;
      for (let k = 1; k <= tall; k++) if (this.solidAt(lead, f - k) || this.fluidAt(lead, f - k)) return false;
      return true;
    };
    for (const f of [fr, fr - 1, fr + 1]) {
      if (!ok(f)) continue;
      e.x = nx;
      e.fy = f;
      return true;
    }
    return false;
  };
})();
