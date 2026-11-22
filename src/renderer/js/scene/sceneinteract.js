'use strict';
/**
 * 主页动态背景：和环境互动（1.5.16）。scene.click 没点中生物时调用 clickEnv(世界坐标 x, y)
 * - 紫水晶（晶洞的方块和晶簇）：播放原版的紫水晶声音（A.gameSound，从游戏资源读），冒紫色闪光
 * - 繁茂洞穴的发光浆果：摘下来掉到地上，一会儿后消失，过一分钟重新长出来；整根藤蔓晃一晃
 * - 藤蔓（洞穴、丛林树上的）、海带、海草、竹子、缠怨藤：被点到的那一株摆动几秒
 * - 箱子：打开盖子，过两秒自己关上（原版开关箱子的声音）
 * - 水面溅起水花、水下冒泡；岩浆冒火星；树冠落几片叶子（樱花落花瓣）
 * - 末地水晶被点到会爆炸，过一会儿重新出现（sceneend.js 画）
 * 改动过的格子记在 this.envMods（renderChunk 通过 envPatch 读），到时间自动恢复
 */
(function () {
  const { M, DECO, CH, tick, overlay, rgb } = A.sceneKit;
  const P = A.Scene.prototype;
  const C = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const sound = (ev, o) => { if (A.gameSound) A.gameSound.play(ev, o).catch(() => {}); };

  const keyOf = (c, r) => `${c},${r}`;

  /** 世界里 (c, r) 这一格（结构优先，其次地形）；空气返回 null */
  P.cellAtWorld = function (c, r) {
    const top = this.colHeight(c);
    const structs = this.structsIn(c, c);
    let cell = structs.length ? this.structCell(structs, c, r, top) : undefined;
    if (cell !== undefined) return cell;
    if (top > 900 || r < top) return null;
    const steep = Math.abs(this.colHeight(c - 1) - top) + Math.abs(this.colHeight(c + 1) - top);
    return this.cellAt(c, r, top, steep);
  };

  /** 被点过的格子画的时候怎么变（renderChunk 调用，只在 envMods 有东西时） */
  P.envPatch = function (cell, c, r) {
    const m = this.envMods.get(keyOf(c, r));
    if (!m) return cell;
    const out = { ...cell };
    if (m.picked) out.berry = false;
    if (m.sway) out.deco = null; // 摆动时改成每帧画（overlay）
    if (m.open && cell.deco === 'chest') out.deco = 'chestOpen';
    if (m.deco) out.deco = m.deco; // 拉杆扳过去了这类（scenetemple.js）
    if (m.gone) return { mat: m.gone, cave: true }; // 炸掉的 TNT
    if (m.mat) { out.mat = m.mat; out.glow = !!m.glow; }
    return out;
  };

  const dirty = (self, c) => { const ch = self.chunks && self.chunks.get(Math.floor(c / CH)); if (ch) ch.dirty = true; };
  function mod(self, c, r, patch) {
    if (!self.envMods) self.envMods = new Map();
    const k = keyOf(c, r);
    self.envMods.set(k, { ...(self.envMods.get(k) || {}), ...patch, c, r });
    dirty(self, c);
  }

  /** 给别的模块用：改一格（patch 里 until 到时间自动恢复，否则一直保持到场景重建） */
  P.envMod = function (c, r, patch) { mod(this, c, r, patch); };
  P.envGet = function (c, r) { return this.envMods ? this.envMods.get(keyOf(c, r)) : null; };
  P.envSound = sound;

  /** 摆动的程度 0~1（被点后 2.5 秒内从 1 降到 0），海带、海草、竹子、藤蔓的画法用 */
  P.wiggle = function (d, now) {
    const t = d && d.wig ? now - d.wig : Infinity;
    return t < 2500 ? 1 - t / 2500 : 0;
  };

  const sparkle = (self, x, y, c, n = 6) => {
    for (let k = 0; k < n; k++) self.parts.push({ x: x + (self.rnd() - 0.5) * 6, y: y + (self.rnd() - 0.5) * 6, vx: (self.rnd() - 0.5) * 10, vy: -4 - self.rnd() * 8, life: 700 + self.rnd() * 400, c, glow: true });
  };

  // 每帧能晃的装饰（不是烘进块图里的）：类型 → 高度（像素）、声音
  const SWAY = {
    kelp: { h: (d, B) => d.h * B + 2, ev: 'block.wet_grass.hit' },
    seagrass: { h: (d) => (d.tall ? 8 : 5), ev: 'block.wet_grass.hit' },
    bamboo: { h: (d, B) => d.h * B + 2, ev: 'block.bamboo.hit' },
    twisting: { h: (d, B) => d.h * B + 2, ev: 'block.weeping_vines.hit' },
  };

  // ───── 敲方块（1.7.3）：点到任何方块都响一声原版挖掘时的敲击声（block.<类型>.hit，音高 0.5，和游戏里拿工具敲方块一样），掉几粒碎屑 ─────
  // 材质（M 里的键）→ 声音类型；没列出来的按石头。游戏版本太老、没有这种声音时退回石头的，再没有就用合成的
  const HIT = {
    grass: 'grass', grassBright: 'grass', grassDark: 'grass', grassJungle: 'grass', mycelium: 'grass', tnt: 'grass', tntFlash: 'grass',
    leaves: 'grass', birchLeaves: 'grass', spruceLeaves: 'grass', darkLeaves: 'grass', jungleLeaves: 'grass', cherry: 'cherry_leaves', moss: 'moss',
    dirt: 'gravel', gravel: 'gravel', clay: 'gravel', sand: 'sand', redSand: 'sand', soul: 'soul_sand', soulSand: 'soul_sand', soulSoil: 'soul_soil', snow: 'snow',
    ice: 'glass', packedIce: 'glass', glass: 'glass', litGlass: 'glass', magentaGlass: 'glass', glowstone: 'glass', seaLantern: 'glass',
    log: 'wood', planks: 'wood', darkLog: 'wood', darkPlanks: 'wood', birch: 'wood', birchPlanks: 'wood', spruce: 'wood', jungleLog: 'wood', door: 'wood',
    chorus: 'wood', chorusFlower: 'wood', redCap: 'wood', brownCap: 'wood', stem: 'wood', cherryLog: 'cherry_wood', cactus: 'wool', wool: 'wool',
    crimson: 'nylium', warped: 'nylium', crimsonNylium: 'nylium', warpedNylium: 'nylium', wart: 'wart_block', warpedWart: 'wart_block', shroomlight: 'shroomlight',
    netherrack: 'netherrack', netherbrick: 'nether_bricks', basalt: 'basalt', deepslate: 'deepslate', tuff: 'tuff', calcite: 'calcite', bone: 'bone_block',
    gold: 'metal', dripstone: 'dripstone_block', amethyst: 'amethyst_block', budding: 'amethyst_block',
    sculk: 'moss', reinforced: 'deepslate', deepBrick: 'deepslate', deepTile: 'deepslate',
  };
  let matKeys = null;
  const matKey = (pal) => {
    if (!matKeys || matKeys.size !== Object.keys(M).length) matKeys = new Map(Object.entries(M).map(([k, v]) => [v, k]));
    return matKeys.get(pal) || '';
  };
  /** 敲一下这块（pal 是 M 里的调色板，碎屑用它的颜色；type 直接给声音类型时不按材质查） */
  P.knock = function (wx, wy, pal, type) {
    const t = type || HIT[matKey(pal)] || 'stone';
    sound(`block.${t}.hit`, { volume: 0.55, pitch: 0.5, alt: t === 'stone' ? null : 'block.stone.hit', synth: 'aurora.knock', knock: t });
    if (!pal) return;
    for (let k = 0; k < 4; k++) this.parts.push({ x: wx + (this.rnd() - 0.5) * 3, y: wy + (this.rnd() - 0.5) * 3, vx: (this.rnd() - 0.5) * 16, vy: -8 - this.rnd() * 10, g: 60, life: 450 + this.rnd() * 250, c: this.tint(pal[k % pal.length]) });
  };

  /** 点到环境：处理了返回 true（不再冒点击粒子） */
  P.clickEnv = function (wx, wy, now) {
    const { B } = this;
    // 末地水晶
    if (this.clickCrystal && this.clickCrystal(wx, wy, now)) return true;
    // 每帧画的装饰：海带、海草、竹子、缠怨藤
    for (const d of this.decor) {
      const sw = SWAY[d.type];
      if (!sw) continue;
      const x = d.col * B; const top = d.top * B;
      if (wx < x - 1 || wx > x + 5 || wy > top + 1 || wy < top - sw.h(d, B) - 1) continue;
      d.wig = now;
      sound(sw.ev, { volume: 0.5 });
      return true;
    }
    // 丛林树上的藤蔓
    for (const tr of this.trees) {
      if (!tr.vines || !tr.alive || tr.grow < 1) continue;
      for (const v of tr.vines) {
        const x = (tr.col + v.dx) * B; const y0 = (tr.top - tr.trunk - v.up) * B;
        if (wx >= x - 1 && wx <= x + 4 && wy >= y0 && wy <= y0 + v.len * B) { tr.wig = now; sound('block.vine.step', { volume: 0.6 }); return true; }
      }
    }
    const c = Math.floor(wx / B); const r = Math.floor(wy / B);
    const cell = this.cellAtWorld(c, r);
    if (cell) {
      // 别的模块登记的（拉杆、绊线、压力板……，scenetemple.js）
      const ext = cell.deco && A.sceneKit.cellClick[cell.deco];
      if (ext && ext.call(this, cell, c, r, now, wx, wy) !== false) return true;
      // 紫水晶
      if (cell.deco === 'cluster' || cell.mat === M.amethyst || cell.mat === M.budding) {
        sound('block.amethyst_block.chime', { pitch: 0.75 + this.rnd() * 0.6, volume: 0.9 });
        sparkle(this, wx, wy, [216, 168, 255], 7);
        return true;
      }
      // 发光浆果藤
      if (cell.deco === 'vine') { this.swayVine(c, r, now); return true; }
      // 箱子
      if (cell.deco === 'chest') {
        const m = this.envMods && this.envMods.get(keyOf(c, r));
        if (!(m && m.open)) { mod(this, c, r, { open: now + 2200 }); sound('block.chest.open', { volume: 0.7 }); }
        return true;
      }
      // 洞穴里的岩浆
      if (cell.lava) { this.lavaPop(wx, wy); return true; }
      // 地下的水（积水洞、地下湖、裂谷底）：格子上记的是后面的墙，不判断就会敲成石头、深层板岩的声音（2.0.0-pre4）
      if (cell.cwater) {
        let surf = r;
        while (surf > r - 60) {
          const up = this.cellAtWorld(c, surf - 1);
          if (!up || !up.cwater) break;
          surf--;
        }
        this.waterPoke(wx, wy, r, surf);
        return true;
      }
      // 洞穴瀑布：同样画在墙前面
      const fall = this.caveFallAt(c, r);
      if (fall === 'lavafall') { this.lavaPop(wx, wy); return true; }
      if (fall) { this.waterPoke(wx, wy, r, r); return true; }
      // 流动的水 / 岩浆（rc4，scenefluid.js）：瀑布落地后淌开的、积水从开口流出去的
      const flow = this.flowAt && this.flowAt(c, r);
      if (flow === 'lava') { this.lavaPop(wx, wy); return true; }
      if (flow === 'water') { this.waterPoke(wx, wy, r, r); return true; }
    }
    // 下界的岩浆海
    if (this.dim === 'nether' && this.sea < 900 && r >= this.sea && r < this.colHeight(c)) { this.lavaPop(wx, this.sea * B); return true; }
    // 水：水面附近溅水花，深处冒泡
    if (this.dim === 'over' && this.sea < 900 && r >= this.sea && r < this.colHeight(c) && !cell) {
      this.waterPoke(wx, wy, r, this.sea);
      return true;
    }
    // 树干
    for (const tr of this.trees) {
      if (!tr.alive || tr.grow < 1) continue;
      const x = tr.col * B; const w = tr.kind === 'jungle' ? 2 * B : B;
      if (wx >= x - 1 && wx <= x + w && wy <= tr.top * B && wy >= (tr.top - tr.trunk) * B) {
        this.knock(wx, wy, this.treeWood(tr), tr.kind === 'cherry' ? 'cherry_wood' : tr.kind === 'crimson' || tr.kind === 'warped' ? 'stem' : null);
        return true;
      }
    }
    // 玩家盖的建筑、小屋
    const bl = this.buildAt && this.buildAt(wx, wy);
    if (bl) { this.knock(wx, wy, bl.pal, bl.type); return true; }
    if (this.houses.some((hs) => this.houseAt(wx) && wy < hs.ground * B && wy >= (hs.ground - (hs.hgt || 6) - 1) * B)) { this.knock(wx, wy, M.planks, 'wood'); return true; }
    // 树冠：落几片叶子（樱花落花瓣）
    for (const tr of this.trees) {
      if (!tr.alive || tr.grow < 1 || ['chorus', 'crimson', 'warped', 'redMushroom', 'brownMushroom'].includes(tr.kind)) continue;
      const cx = tr.col * B + 2; const ty = (tr.top - tr.trunk) * B;
      if (Math.abs(wx - cx) > 3.5 * B || wy > ty + 2 || wy < ty - 4 * B) continue;
      const leaves = this.treeLeaves(tr);
      for (let k = 0; k < 5; k++) {
        const col = leaves[Math.floor(this.rnd() * leaves.length)];
        this.parts.push({ x: wx + (this.rnd() - 0.5) * 8, y: wy + (this.rnd() - 0.5) * 4, vx: (this.rnd() - 0.5) * 6, vy: 4 + this.rnd() * 4, life: 1800 + this.rnd() * 900, c: col, sway: 10, ph: this.rnd() * 6 });
      }
      sound('block.azalea_leaves.hit', { volume: 0.5 });
      return true;
    }
    // 其他方块（地面、石头、矿石、结构……；洞穴里的背景墙也算）
    if (cell && cell.mat) { this.knock(wx, wy, cell.mat); return true; }
    return false;
  };

  /** 点到水：水面附近溅水花，深处冒泡。surf 是水面那一行 */
  P.waterPoke = function (wx, wy, r, surf) {
    const B = this.B;
    if (r - surf <= 2) {
      for (let k = 0; k < 9; k++) this.parts.push({ x: wx + (this.rnd() - 0.5) * 4, y: surf * B, vx: (this.rnd() - 0.5) * 22, vy: -18 - this.rnd() * 14, g: 70, life: 650, c: [200, 225, 255] });
      sound('entity.generic.splash', { volume: 0.35, pitch: 1 + this.rnd() * 0.3 });
    } else {
      for (let k = 0; k < 6; k++) this.parts.push({ x: wx + (this.rnd() - 0.5) * 4, y: wy - k * 2, vx: (this.rnd() - 0.5) * 2, vy: -10 - this.rnd() * 8, life: Math.max(300, (wy - surf * B) * 80), c: [215, 235, 255], glow: true });
      sound('block.bubble_column.bubble_pop', { volume: 0.5 });
    }
  };

  /** (c, r) 在洞穴瀑布里吗：这一格是瀑布的起点，或者往上没隔着石头就能碰到起点（瀑布最长 48 格，scenecave.js） */
  P.caveFallAt = function (c, r) {
    for (let rr = r; rr > r - 48; rr--) {
      if (this.rawSolid(c, rr, null)) return false;
      const x = this.cellAtWorld(c, rr);
      if (!x) return false;
      if (x.fx === 'fall' || x.fx === 'lavafall') return x.fx; // 岩浆瀑布（rc4）点了是岩浆的声音
    }
    return false;
  };

  /** 藤蔓：从点到的格子往上、往下找连着的藤蔓，一起摆；点到的这格有浆果就摘下来 */
  P.swayVine = function (c, r, now) {
    const isVine = (rr) => { const x = this.cellAtWorld(c, rr); return x && x.deco === 'vine' ? x : null; };
    let r0 = r; let r1 = r;
    while (r0 - 1 > r - 6 && isVine(r0 - 1)) r0--;
    while (r1 + 1 < r + 6 && isVine(r1 + 1)) r1++;
    for (let rr = r0; rr <= r1; rr++) {
      const cell = isVine(rr);
      const m = this.envMods && this.envMods.get(keyOf(c, rr));
      const picked = !!(m && m.picked);
      mod(this, c, rr, { sway: now + 2600, swayFrom: now, k: rr - r0 + 1, len: r1 - r0 + 1, cell: { ...cell, berry: cell.berry && !picked } });
    }
    const here = isVine(r);
    const m = this.envMods.get(keyOf(c, r));
    if (here && here.berry && !m.picked) {
      m.picked = now + 60000 + this.rnd() * 30000; // 过一阵重新长出来
      m.cell.berry = false;
      if (!this.items) this.items = [];
      this.items.push({ x: c * this.B + 1, y: r * this.B + 2, vy: 0, c: [255, 184, 58], born: now, life: 7000 });
      sound('block.cave_vines.pick_berries', { volume: 0.8 });
    } else sound('block.vine.step', { volume: 0.6 });
  };

  P.lavaPop = function (x, y) {
    for (let k = 0; k < 5; k++) this.parts.push({ x: x + (this.rnd() - 0.5) * 4, y, vx: (this.rnd() - 0.5) * 16, vy: -16 - this.rnd() * 14, g: 50, life: 800, c: [255, 160 + Math.floor(this.rnd() * 60), 50], glow: true });
    sound('block.lava.pop', { volume: 0.7 });
  };

  // 每帧：到时间的格子恢复原样（关箱子、停止摆动、浆果长回来）；掉落的浆果往下落
  tick.push(function (sec, now) {
    if (this.envMods && this.envMods.size) {
      for (const [k, m] of this.envMods) {
        let changed = false;
        if (m.sway && now > m.sway) { delete m.sway; changed = true; }
        if (m.open && now > m.open) { delete m.open; changed = true; sound('block.chest.close', { volume: 0.6 }); }
        if (m.picked && !m.sway && now > m.picked) { delete m.picked; changed = true; }
        if (m.until && now > m.until) { delete m.until; delete m.deco; delete m.gone; delete m.mat; changed = true; }
        if (changed) dirty(this, m.c);
        if (!m.sway && !m.open && !m.picked && !m.deco && !m.gone && !m.mat) this.envMods.delete(k);
      }
    }
    if (this.items && this.items.length) {
      const B = this.B;
      for (const it of this.items) {
        if (it.rest) continue;
        it.vy = Math.min(80, it.vy + 140 * sec);
        const ny = it.y + it.vy * sec;
        const c = Math.floor((it.x + 1) / B);
        if (this.solidAt(c, Math.floor((ny + 2) / B))) { it.y = Math.floor((ny + 2) / B) * B - 2; it.rest = now; } else it.y = ny;
        if (it.y > this.cam.y + this.H + 40) it.life = 0;
      }
      this.items = this.items.filter((it) => now - it.born < it.life);
    }
  });

  // 每帧画：摆动中的藤蔓、掉下来的浆果
  overlay.push(function (lx, ly, now) {
    const g = this.ctx; const { B } = this;
    if (this.envMods && this.envMods.size) {
      for (const m of this.envMods.values()) {
        if (!m.sway || !m.cell || !DECO[m.cell.deco]) continue;
        const left = (m.sway - now) / (m.sway - m.swayFrom);
        const dx = Math.round(Math.sin((now - m.swayFrom) / 170) * 2.4 * left * (m.k / m.len));
        const depth = m.r - this.colHeight(m.c);
        const x0 = lx + m.c * B + dx; const y0 = ly + m.r * B;
        DECO[m.cell.deco]((px, py, col, glow) => {
          g.fillStyle = glow ? rgb(col) : depth > 3 ? rgb(col.map((v) => v * 0.85)) : this.color(col);
          g.fillRect(x0 + px, y0 + py, 1, 1);
        }, m.cell, m.c, m.r, B);
      }
    }
    if (this.items && this.items.length) {
      for (const it of this.items) {
        const age = now - it.born;
        if (it.life - age < 1500 && Math.floor(now / 120) % 2) continue; // 快消失时闪
        const bob = it.rest ? Math.round(Math.sin((now - it.rest) / 300)) : 0;
        g.fillStyle = rgb(it.c);
        g.fillRect(Math.round(lx + it.x), Math.round(ly + it.y) - 1 + bob, 2, 2);
      }
    }
  });

  // 打开的箱子：盖子掀起来，里面黑的
  DECO.chestOpen = (dot) => {
    for (let x = 0; x < 4; x++) dot(x, 0, C('#8a5a1e'));
    dot(1, 1, C('#2a1a0a')); dot(2, 1, C('#2a1a0a')); dot(0, 1, C('#a8742a')); dot(3, 1, C('#a8742a'));
    for (let x = 0; x < 4; x++) for (let y = 2; y < 4; y++) dot(x, y, C('#a8742a'));
    dot(1, 2, C('#e8c040'));
  };

})();
