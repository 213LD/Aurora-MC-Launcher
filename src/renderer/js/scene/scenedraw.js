'use strict';
/** 主页动态背景：画东西：精灵、船、树、房子、装饰、事件（2.0.0-pre9 从 scene.js 拆出来） */
(function () {
  const { hash, rgb, hex, pal, M, SPRITES } = A.sceneKit;

  Object.assign(A.Scene.prototype, {
    color(c, emissive) {
      if (emissive) return rgb(c);
      const key = c.join(',');
      let v = this.tintCache.get(key);
      if (!v) { v = rgb(this.tint(c)); this.tintCache.set(key, v); }
      return v;
    },

    drawSprite(e, ox, oy, now) {
      const { ctx } = this;
      const spr = e.spr;
      const rainbow = e.jeb ? hex(`#${Math.floor(((Math.sin(now / 400) + 1) / 2) * 0xff).toString(16).padStart(2, '0')}${Math.floor(((Math.sin(now / 400 + 2) + 1) / 2) * 0xff).toString(16).padStart(2, '0')}${Math.floor(((Math.sin(now / 400 + 4) + 1) / 2) * 0xff).toString(16).padStart(2, '0')}`) : null;
      const x0 = Math.round(e.x + ox);
      const y0 = Math.round(e.y + oy) - spr.h + this.spriteBob(e, now);
      ctx.globalAlpha = Math.max(0, Math.min(1, e.alpha));
      // 减少闪烁（1.5.5，noFlash）：不闪白
      const flash = !this.noFlash && ((e.hurt && e.hurt > now) || (e.creeperFuse && Math.floor(now / 120) % 2));
      // 玩家挥手（砍树、打架）、走路迈腿用另外一帧（1.7.0）
      const swing = spr.swing && (e.state === 'work' || (e.swingT && now - e.swingT < 200)) && Math.floor(now / 225) % 2;
      const rows = swing ? spr.swing : spr.walk && e.moving && Math.floor(now / 180) % 2 ? spr.walk : spr.rows;
      for (let ry = 0; ry < spr.h; ry++) {
        const row = rows[e.flip ? spr.h - 1 - ry : ry];
        for (let rx = 0; rx < spr.w; rx++) {
          const ch = row[rx];
          if (ch === '.') continue;
          let c = spr.colors[ch];
          if (!c) continue;
          if (e.kind === 'sheep' && ch === 'w') c = rainbow || (e.color ? hex(e.color) : c);
          const px = e.dir > 0 ? x0 + rx : x0 + spr.w - 1 - rx;
          const emissive = spr.emissive && spr.emissive.includes(ch);
          ctx.fillStyle = flash ? '#ffffff' : e.cave && !emissive ? this.caveColor(c) : this.color(c, emissive);
          ctx.fillRect(px, y0 + ry, 1, 1);
        }
      }
      // 玩家砍树后抱着木头
      if (e.carry && e.carry > now) { ctx.fillStyle = this.color(M.log[0]); ctx.fillRect(x0 + (e.dir > 0 ? 3 : -1), y0 + 5, 2, 2); }
      if (e.burning) { ctx.fillStyle = Math.floor(now / 100) % 2 ? 'rgba(255,150,40,0.8)' : 'rgba(255,90,30,0.8)'; ctx.fillRect(x0, y0 - 1, spr.w, 2); }
      ctx.globalAlpha = 1;
    },

    /** 生物画的时候往上抬几像素：走路一颠一颠（有迈腿那一帧的不颠）、被点了跳一下。drawFight / drawHeldTorches 也用它对齐手的位置 */
    spriteBob(e, now) {
      let bob = e.moving && !e.spr.walk && Math.floor(now / 180) % 2 ? -1 : 0;
      if (e.jumpT && now - e.jumpT < 400) bob -= Math.round(Math.sin(((now - e.jumpT) / 400) * Math.PI) * 4);
      return bob;
    },

    drawBoat(e, ox, oy, now) {
      const { ctx } = this;
      const x = Math.round(e.x + ox);
      const y = Math.round(e.y + oy + Math.sin(now / 500) * 0.6);
      ctx.globalAlpha = Math.min(1, e.alpha);
      ctx.fillStyle = this.color(M.planks[1]);
      ctx.fillRect(x - 3, y - 1, 9, 2);
      ctx.fillRect(x - 4, y - 2, 1, 1);
      ctx.fillRect(x + 6, y - 2, 1, 1);
      const s = SPRITES.steve;
      for (let ry = 0; ry < 5; ry++) for (let rx = 0; rx < s.w; rx++) {
        const c = s.colors[s.rows[ry][rx]];
        if (!c) continue;
        ctx.fillStyle = this.color(c);
        ctx.fillRect(e.dir > 0 ? x + rx : x + s.w - 1 - rx, y - 6 + ry, 1, 1);
      }
      ctx.globalAlpha = 1;
      e.x += e.dir * 0.05;
      if (!this.isWaterCol(e.x + (e.dir > 0 ? 7 : -4))) e.dir *= -1;
    },

    /** 长成的树画成一张小图缓存起来，每帧只贴图（性能打磨：以前每帧逐像素画，黑森林一帧要 4ms）；换时段（palV 变）重画 */
    drawTree(tr, ox, oy) {
      if (tr.alive && tr.grow >= 1) {
        const B = this.B;
        if (!tr.cv || tr.cvKey !== this.palV) {
          const cv = document.createElement('canvas');
          cv.width = B * 11; cv.height = (tr.trunk + 5) * B;
          const keep = this.ctx;
          this.ctx = cv.getContext('2d');
          this.drawTreeRaw(tr, 5 * B - tr.col * B, cv.height - tr.top * B);
          this.ctx = keep;
          tr.cv = cv; tr.cvKey = this.palV;
        }
        this.ctx.drawImage(tr.cv, tr.col * B + ox - 5 * B, tr.top * B + oy - tr.cv.height);
        if (tr.vines) this.drawVines(tr, ox, oy); // 丛林树的藤蔓每帧画（会摆动，scenejungle.js）
        return;
      }
      this.drawTreeRaw(tr, ox, oy);
    },

    drawTreeRaw(tr, ox, oy) {
      const { B } = this;
      const g = this.ctx;
      const scale = tr.alive ? tr.grow : 0;
      if (!tr.alive) {
        // 树桩 / 树苗
        g.fillStyle = this.color(M.leaves[0]);
        g.fillRect(tr.col * B + ox + 1, (tr.top) * B + oy - 2, 2, 2);
        return;
      }
      const L = (bx, by, palette, shade = 1) => {
        for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) {
          const c = palette[Math.floor(hash(bx + px + tr.seed, by + py, 3) * palette.length)];
          g.fillStyle = this.color(c.map((v) => v * shade));
          g.fillRect(bx + px + ox, by + py + oy, 1, 1);
        }
      };
      const trunk = Math.max(1, Math.round(tr.trunk * scale));
      const x = tr.col * B;
      const top = tr.top * B;
      if (tr.kind === 'redMushroom' || tr.kind === 'brownMushroom') {
        for (let k = 1; k <= trunk; k++) L(x, top - k * B, M.stem);
        const cap = tr.kind === 'redMushroom' ? M.redCap : M.brownCap;
        const w = tr.kind === 'redMushroom' ? 1 : 2;
        for (let dx = -w; dx <= w; dx++) L(x + dx * B, top - (trunk + 1) * B, cap);
        if (tr.kind === 'redMushroom') for (let dx = -1; dx <= 1; dx++) L(x + dx * B, top - (trunk + 2) * B, cap, 0.95);
        return;
      }
      if (tr.kind === 'chorus') {
        for (let k = 1; k <= trunk; k++) {
          L(x, top - k * B, M.chorus);
          if (k === 2) L(x + B, top - k * B, M.chorus);
          if (k === 3 && trunk > 3) L(x - B, top - k * B, M.chorus);
        }
        L(x, top - (trunk + 1) * B, M.chorusFlower);
        return;
      }
      if (tr.kind === 'crimson' || tr.kind === 'warped') {
        // 绯红 / 诡异菌：菌柄 + 两层菌盖，菌盖下面挂着菌光体（自己发光）
        const warped = tr.kind === 'warped';
        for (let k = 1; k <= trunk; k++) L(x, top - k * B, warped ? M.warped : M.crimson);
        const wide = trunk > 4 ? 2 : 1;
        for (let dx = -wide; dx <= wide; dx++) L(x + dx * B, top - (trunk + 1) * B, warped ? M.warpedWart : M.wart);
        for (let dx = -wide + 1; dx <= wide - 1; dx++) L(x + dx * B, top - (trunk + 2) * B, warped ? M.warpedWart : M.wart, 0.94);
        if (scale >= 1 && hash(tr.seed, 1, 5) < 0.7) {
          const sx = x + (hash(tr.seed, 2, 5) < 0.5 ? -wide : wide) * B;
          for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) { g.fillStyle = rgb(M.shroomlight[(px + py) % 3]); g.fillRect(sx + px + ox, top - trunk * B + py + oy, 1, 1); }
        }
        return;
      }
      if (tr.kind === 'darkOak') {
        // 深色橡树：两格粗的树干，又宽又扁的树冠
        for (let k = 1; k <= trunk; k++) { L(x, top - k * B, M.darkLog); L(x + B, top - k * B, M.darkLog, 0.9); }
        if (scale < 0.5) { L(x, top - (trunk + 1) * B, M.darkLeaves); return; }
        for (let dy = 0; dy < 3; dy++) {
          const span = dy === 0 ? 2 : 3;
          for (let dx = -span; dx <= span + 1; dx++) {
            if (dy === 0 && Math.abs(dx - 0.5) > 2 && hash(dx + tr.seed, dy, 4) < 0.5) continue;
            L(x + dx * B, top - (trunk + 3 - dy) * B, M.darkLeaves, 1 - dy * 0.05);
          }
        }
        return;
      }
      // 别的模块画的树（丛林树，scenejungle.js）
      const custom = A.sceneKit.treeDraw && A.sceneKit.treeDraw[tr.kind];
      if (custom) { custom.call(this, tr, L, x, top, trunk, scale); return; }
      const wood = this.treeWood(tr);
      for (let k = 1; k <= trunk; k++) L(x, top - k * B, wood);
      const leaves = this.treeLeaves(tr);
      if (scale < 0.5) { L(x, top - (trunk + 1) * B, leaves); return; }
      if (tr.kind === 'spruce') {
        const lt = top - (trunk + 3) * B;
        for (let dy = 0; dy < 4; dy++) {
          const span = dy === 0 ? 0 : dy === 1 ? 1 : dy === 2 ? 1 : 2;
          for (let dx = -span; dx <= span; dx++) L(x + dx * B, lt + dy * B, leaves, 1 - dy * 0.05);
        }
        return;
      }
      const lt = top - (trunk + 2) * B;
      const wide = tr.kind === 'cherry' ? 3 : 2;
      for (let dy = 0; dy < 3; dy++) {
        const span = dy === 0 ? wide - 1 : wide;
        for (let dx = -span; dx <= span; dx++) {
          if (Math.abs(dx) === wide && hash(dx + tr.seed, dy, 4) < 0.35) continue;
          L(x + dx * B, lt + dy * B, leaves, 1 - dy * 0.06);
        }
      }
    },

    /** 小屋同样缓存成图（门开关、亮灯、换时段时重画），烟和窗户光晕每帧画 */
    drawHouse(h, ox, oy, now) {
      const { B } = this;
      const open = h.door > now;
      const lit = this.period === 'night' || this.period === 'sunset';
      const key = `${this.palV}|${open}|${lit}`;
      const x0 = h.col * B;
      const g0 = h.ground * B;
      if (!h.cv || h.cvKey !== key) {
        const cv = document.createElement('canvas');
        cv.width = B * 7; cv.height = B * 7;
        const keep = this.ctx;
        this.ctx = cv.getContext('2d');
        this.drawHouseRaw(h, B - x0, cv.height - g0, open, lit);
        this.ctx = keep;
        h.cv = cv; h.cvKey = key;
      }
      this.ctx.drawImage(h.cv, x0 + ox - B, g0 + oy - h.cv.height);
      if (lit && this.rnd() < 0.08) this.parts.push({ x: x0 + 3 * B + 2, y: g0 - 6 * B - 1, vx: 1 + this.rnd(), vy: -4, life: 2600, c: [160, 160, 170], land: true });
      if (lit) {
        // 窗户的光晕
        this.ctx.fillStyle = 'rgba(255, 210, 110, 0.18)';
        this.ctx.fillRect(x0 + 3 * B - 2 + ox, g0 - 2 * B - 2 + oy, B + 4, B + 4);
      }
    },

    drawHouseRaw(h, ox, oy, open, lit) {
      const { B } = this;
      const g = this.ctx;
      const mats = {
        planks: [M.planks, M.log, M.darkPlanks],
        sandstone: [M.sandstone, M.sandstone, M.planks],
        spruce: [M.spruce, M.log, M.darkPlanks],
        cherry: [pal('#ecc0c4', '#e2b2b8'), M.cherryLog, pal('#a8606e', '#9c5664', '#b26a78')],
      }[h.style] || [M.planks, M.log, M.darkPlanks];
      const [wall, corner, roof] = mats;
      const x0 = h.col * B;
      const g0 = h.ground * B;
      const BL = (bx, by, palette, shade = 1, emissive = false) => {
        for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) {
          const c = palette[Math.floor(hash(bx + px, by + py, 11) * palette.length)];
          g.fillStyle = emissive ? rgb(c) : this.color(c.map((v) => v * shade));
          g.fillRect(bx + px + ox, by + py + oy, 1, 1);
        }
      };
      for (let row = 1; row <= 3; row++) {
        for (let col = 0; col < 5; col++) {
          const bx = x0 + col * B;
          const by = g0 - row * B;
          if (col === 1 && row <= 2) {
            // 门
            BL(bx, by, open ? pal('#2a1a10') : pal('#6e4b24', '#5f4020'), 1);
            continue;
          }
          if (col === 3 && row === 2) {
            BL(bx, by, lit ? pal('#ffd36b', '#ffc94a') : pal('#a9d6e5', '#b8e0ee'), 1, lit);
            continue;
          }
          BL(bx, by, col === 0 || col === 4 ? corner : wall);
        }
      }
      // 屋顶
      for (let r = 0; r < 3; r++) for (let col = -1 + r; col <= 5 - r; col++) BL(x0 + col * B, g0 - (4 + r) * B, roof, 1 - r * 0.06);
      // 烟囱
      BL(x0 + 3 * B, g0 - 6 * B, M.cobble);
    },

    drawDecor(d, ox, oy, now) {
      const { B } = this;
      const g = this.ctx;
      const x = d.col * B + ox;
      const top = d.top * B + oy;
      const ext = A.sceneKit.decoDraw[d.type];
      if (ext) { ext.call(this, d, x, top, now); return; }
      if (d.type === 'flower') {
        // 樱花林地上大多是粉色的落花（原版的「粉红色花簇」），平铺在草上
        if (this.sceneId === 'cherry' && d.c < 0.75) {
          g.fillStyle = this.color(d.c < 0.4 ? [244, 176, 208] : [236, 150, 190]);
          g.fillRect(x + d.dx, top - 1, 2, 1); g.fillRect(x + d.dx + (d.c < 0.2 ? 2 : 1), top - 1, 1, 1);
          return;
        }
        const c = d.c < 0.3 ? [220, 60, 60] : d.c < 0.55 ? [240, 210, 70] : d.c < 0.7 ? [140, 120, 240] : [110, 190, 70];
        g.fillStyle = this.color([90, 150, 60]);
        g.fillRect(x + 1 + d.dx, top - 2, 1, 2);
        g.fillStyle = this.color(c);
        g.fillRect(x + 1 + d.dx, top - 3, 1, 1);
      } else if (d.type === 'cactus') {
        for (let k = 1; k <= d.h; k++) for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) {
          if (px === 0 || px === 3) { if (hash(px, py + k * 4, 2) < 0.5) continue; }
          g.fillStyle = this.color(M.cactus[Math.floor(hash(px + d.col, py + k * 4, 5) * 3)]);
          g.fillRect(x + px, top - k * B + py, 1, 1);
        }
      } else if (d.type === 'deadbush') {
        g.fillStyle = this.color([140, 100, 50]);
        g.fillRect(x + 1, top - 2, 1, 2); g.fillRect(x, top - 3, 1, 1); g.fillRect(x + 2, top - 3, 1, 1);
      } else if (d.type === 'pumpkin') {
        g.fillStyle = this.color([230, 130, 30]);
        g.fillRect(x, top - 3, 3, 3);
        g.fillStyle = this.isNight() ? '#ffd040' : this.color([60, 30, 10]);
        g.fillRect(x + 1, top - 2, 1, 1);
      } else if (d.type === 'pillar') {
        for (let k = 1; k <= d.h; k++) {
          for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) {
            g.fillStyle = this.color(M.obsidian[Math.floor(hash(px + d.col, py + k * 4, 6) * 3)]);
            g.fillRect(x + px, top - k * B + py, 1, 1);
          }
        }
        // 末影水晶（旋转闪烁）
        const cy = top - (d.h + 2) * B + Math.sin(now / 500) * 2;
        const s = Math.floor(now / 250) % 2;
        g.fillStyle = 'rgba(255,120,220,0.9)';
        g.fillRect(x + (s ? 0 : 1), cy, s ? 4 : 2, s ? 2 : 4);
        g.fillStyle = 'rgba(255,255,255,0.9)';
        g.fillRect(x + 1, cy + 1 - (s ? 0 : 0), 2, 1);
        g.fillStyle = `rgba(255,150,230,${0.12 + 0.08 * Math.sin(now / 300)})`;
        g.fillRect(x - 3, cy - 3, 10, 10);
      } else if (d.type === 'bridge') {
        const by = d.y * B + oy;
        for (let k = 0; k < d.len; k++) {
          for (let py = 0; py < B; py++) for (let px = 0; px < B; px++) {
            g.fillStyle = this.color(M.netherbrick[Math.floor(hash(px + k * 4, py, 8) * 3)]);
            g.fillRect(x + k * B + px, by + py, 1, 1);
          }
          if (k % 5 === 0) for (let r = 1; r <= (d.legs ? d.legs[k] : 5); r++) {
            g.fillStyle = this.color(M.netherbrick[r % 3]);
            g.fillRect(x + k * B, by + r * B, B, B);
          }
          if (k % 3 === 0) { g.fillStyle = this.color(M.netherbrick[1]); g.fillRect(x + k * B + 1, by - 2, 2, 2); }
        }
      }
    },

    /** layer：'sky' 在远山之前绘制，'ridge' 站在远山山脊上 */
    drawEvents(now, layer, ox = 0, oy = 0) {
      const { ctx } = this;
      if (layer === 'sky') this.events = this.events.filter((ev) => ev.until > now);
      for (const ev of this.events) {
        if (ev.type === 'herobrine' && layer === 'ridge') {
          // ev.x 是屏幕坐标；远山是循环拼接的，换算成远山画布上的位置找山脊高度
          const x = Math.round(ev.x) + ox;
          const fw = this.far.width;
          const fx = ((Math.round(ev.x) - (this.farOX || 0)) % fw + fw) % fw;
          const y = Math.round((this.farTops[fx] != null ? this.farTops[fx] : this.H * 0.5) - 8 + oy);
          const a = Math.min(1, (ev.until - now) / 800, 0.85);
          ctx.globalAlpha = a;
          ctx.fillStyle = '#2a2a3a';
          ctx.fillRect(x, y, 2, 8);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x + 1, y + 1, 1, 1);
          ctx.globalAlpha = 1;
          // 鼠标靠近时消失
          const r = this.canvas.getBoundingClientRect();
          if (this.mouse.cx != null) {
            const mx = ((this.mouse.cx - r.left) / r.width) * this.W;
            if (Math.abs(mx - x) < 18) ev.until = Math.min(ev.until, now + 200);
          }
        } else if (ev.type === 'dragon' && layer === 'sky') {
          const prog = (now - ev.t) / 16000;
          const x = Math.round(-30 + prog * (this.W + 60));
          const y = Math.round(ev.y + Math.sin(prog * 8) * 6);
          const flap = Math.floor(now / 200) % 2;
          // 翅膀（偏亮的紫灰色，避免和末地夜空融在一起）
          ctx.fillStyle = '#4a3a5e';
          ctx.fillRect(x + 4, y + (flap ? -6 : 3), 8, flap ? 6 : 4);
          ctx.fillStyle = '#2c2238';
          ctx.fillRect(x, y, 16, 3);
          ctx.fillRect(x + 16, y - 1, 4, 3);
          ctx.fillRect(x - 6, y + 1, 6, 1);
          ctx.fillStyle = '#5c4a72';
          for (let k = 0; k < 16; k += 3) ctx.fillRect(x + k, y - 1, 1, 1); // 背脊
          ctx.fillStyle = '#e080ff';
          ctx.fillRect(x + 18, y, 1, 1);
          ctx.fillStyle = 'rgba(224,128,255,0.25)';
          ctx.fillRect(x + 17, y - 1, 3, 3);
          if (this.rnd() < 0.2) this.parts.push({ x: x + 2, y: y + 1, vx: -6, vy: 3, life: 900, c: [190, 110, 240], glow: true });
        }
      }
    },

  });
})();
