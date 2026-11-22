'use strict';
/**
 * 主页动态背景：终极彩蛋「Minecraft doesn't need you」的场景部分（1.5.16，计时和流程在 ultimate.js）
 * - extraEnder：挂机到 1 / 2 / 3 / 3.5 小时，世界里多出来的末影人（不占生物数量上限）
 * - startEnding(cb)：末地主岛上的结局：
 *   arrive 末影龙飞来停在返回传送门的基岩柱上 → heal 末影水晶给它回血，末影人「碰巧」一个个把水晶弄炸 →
 *   fight 末影人围着打龙（龙受伤闪红，Boss 血条见 ultimate.js）→ death 和原版一样：龙慢慢升起、身上射出光束、化掉，掉经验球 →
 *   after 返回传送门亮起，基岩柱顶上出现龙蛋（点龙蛋会传送走，和原版一样），回调 cb()
 * 时间用每帧的 sec 累加：窗口最小化时场景不画，结局也停住，玩家回来接着看
 */
(function () {
  const { tick, overlay } = A.sceneKit;
  const P = A.Scene.prototype;
  const snd = (ev, o) => { if (A.gameSound) A.gameSound.play(ev, o).catch(() => {}); };

  // ───────────── 挂机阶段：多出来的末影人 ─────────────

  function extraTick(self, now) {
    const want = self.ending ? 0 : self.extraEnder || 0;
    if (!want || now < (self.nextExtra || 0)) return;
    self.nextExtra = now + 2500;
    const have = self.ents.filter((e) => e.extra && !e.dead && !e.fade).length;
    if (have >= want) return;
    const e = self.spawnMob('enderman', now, self.cam.x + 10 + self.rnd() * (self.W - 20));
    if (e) { e.extra = true; e.life = 240000 + self.rnd() * 120000; }
  }

  // ───────────── 结局 ─────────────

  P.startEnding = function (cb) {
    if (this.dim !== 'end') return false;
    const L = this.endLay();
    this.structsIn(L.cx, L.cx); // 确保返回传送门生成了（portalRow）
    if (L.portalRow == null) return false;
    this.camHome();
    for (const p of L.pillars) { p.crystal = true; p.crystalBack = 0; }
    this.setEndPortal(false);
    const B = this.B;
    const px = L.cx * B + 2;
    const perchY = (L.portalRow - 4) * B;
    this.ending = { t: 0, phase: 'arrive', hp: 200, max: 200, cb, px, perchY, flash: 0, dead: 0, nextBlow: 9, egg: null, hurtAt: 0, rays: [] };
    this.ents = this.ents.filter((e) => e.kind === 'enderman' || e.kind === 'endermite');
    this.dropStale();
    snd('entity.ender_dragon.growl', { volume: 0.7 });
    return true;
  };

  /** 末影龙在哪（世界坐标，脚的位置）：停下来时前脚正好踩在基岩柱顶上（脚在龙身 +3~+4，柱子在 px-2~px+1） */
  function dragonPos(self, E) {
    const x = E.px - 4;
    if (E.phase === 'arrive') {
      const k = Math.min(1, E.t / 7);
      const e = 1 - Math.pow(1 - k, 2);
      return { x: x - self.W * 0.75 * (1 - e), y: E.perchY - 60 * (1 - e) + Math.sin(k * Math.PI) * -12, fly: k < 1 };
    }
    if (E.phase === 'death' || E.phase === 'after') return { x, y: E.perchY - E.dead * 5, fly: false };
    return { x, y: E.perchY, fly: false };
  }

  P.endingTick = function (sec, now) {
    const E = this.ending;
    E.t += sec;
    E.flash = Math.max(0, E.flash - sec);
    const B = this.B;
    const L = this.endLay();
    // 一群末影人（窗口改大小重建世界后也补回来）
    const crowd = this.ents.filter((e) => e.ending && !e.dead);
    if (E.phase !== 'after' && crowd.length < 14 && this.rnd() < sec * 6) {
      const e = this.spawnMob('enderman', now, E.px + (this.rnd() - 0.5) * this.W * 0.8);
      if (e) Object.assign(e, { ending: true, life: Infinity, state: 'ending', slot: (this.rnd() < 0.5 ? -1 : 1) * (9 + this.rnd() * 22), cd: 1 + this.rnd() * 2 });
    }
    const alive = L.pillars.filter((p) => p.crystal !== false);
    if (E.phase === 'arrive' && E.t >= 7) { E.phase = 'heal'; E.tp = E.t; }
    if (E.phase === 'heal') {
      // 末影人「碰巧」把水晶弄炸：先瞬移到柱子底下，过一会儿水晶炸了
      if (E.t >= E.nextBlow && alive.length) {
        const p = alive[Math.floor(this.rnd() * alive.length)];
        const e = crowd[Math.floor(this.rnd() * crowd.length)];
        if (e) { this.puffTp(e); e.x = (p.col + p.w / 2) * B - 2; const gy = this.groundY(e.x); if (gy != null) e.y = gy; this.puffTp(e); }
        setTimeout(() => { if (this.ending && p.crystal !== false) this.blowCrystal(p, performance.now(), true); }, 700);
        E.nextBlow = E.t + 2.2 + this.rnd() * 2;
      }
      if (!alive.length && E.t > E.nextBlow) { E.phase = 'fight'; snd('entity.ender_dragon.growl', { volume: 0.8 }); }
    }
    for (const e of crowd) {
      if (E.phase === 'after' || E.phase === 'death') { e.moving = false; continue; }
      const tx = E.px + e.slot;
      const d = tx - e.x;
      if (Math.abs(d) > 1.5) {
        e.dir = d > 0 ? 1 : -1;
        e.x += e.dir * Math.min(Math.abs(d), 7 * sec);
        e.moving = true;
        const gy = this.groundY(e.x); if (gy != null) e.y = gy;
      } else {
        e.moving = false;
        e.dir = E.px > e.x ? 1 : -1;
        if (E.phase === 'fight') {
          e.cd -= sec;
          if (e.cd <= 0) {
            e.cd = 2 + this.rnd() * 1.5;
            e.jumpT = now;
            E.hp = Math.max(0, E.hp - (0.8 + this.rnd() * 0.6));
            E.flash = 0.18;
            const dp = dragonPos(this, E);
            for (let k = 0; k < 3; k++) this.parts.push({ x: dp.x + (this.rnd() - 0.5) * 16, y: dp.y - 6 - this.rnd() * 8, vx: (this.rnd() - 0.5) * 14, vy: -8 - this.rnd() * 8, life: 600, c: [200, 120, 255], glow: true });
            if (now - E.hurtAt > 1300) { E.hurtAt = now; snd('entity.ender_dragon.hurt', { volume: 0.55, pitch: 0.9 + this.rnd() * 0.2 }); }
          }
        }
      }
      // 偶尔瞬移到另一边
      if (this.rnd() < sec * 0.03) { this.puffTp(e); e.slot = -e.slot; e.x = E.px + e.slot; const gy = this.groundY(e.x); if (gy != null) e.y = gy; this.puffTp(e); }
    }
    // 水晶还在时给龙回血（和原版一样，所以光点龙打不过满水晶的龙，1.5.17 玩家能点龙之后加的）
    if ((E.phase === 'arrive' || E.phase === 'heal') && alive.length) E.hp = Math.min(E.max, E.hp + alive.length * 0.4 * sec);
    if (E.phase !== 'death' && E.phase !== 'after' && E.hp <= 0) {
      for (const p of L.pillars) if (p.crystal !== false) this.blowCrystal(p, now, true);
      E.phase = 'death'; E.dead = 0;
      snd('entity.ender_dragon.death', { volume: 0.85 });
    }
    if (E.phase === 'death') {
      E.dead += sec;
      const dp = dragonPos(this, E);
      // 光束：越来越多、越来越长
      if (E.rays.length < 24 && this.rnd() < sec * 4) E.rays.push({ a: this.rnd() * Math.PI * 2, len: 0, w: 0.04 + this.rnd() * 0.05, c: this.rnd() < 0.5 ? [255, 255, 255] : this.rnd() < 0.5 ? [255, 230, 120] : [220, 140, 255] });
      for (const r of E.rays) r.len = Math.min(220, r.len + sec * 55);
      if (E.dead > 6 && this.rnd() < sec * 18) this.parts.push({ x: dp.x + (this.rnd() - 0.5) * 20, y: dp.y - 8, vx: (this.rnd() - 0.5) * 40, vy: -10 - this.rnd() * 25, g: 40, life: 2000, c: this.rnd() < 0.5 ? [200, 255, 80] : [255, 240, 90], glow: true, size: 2 });
      if (E.dead >= 10) {
        E.phase = 'after';
        this.setEndPortal(true);
        E.egg = { x: E.px - 2, y: E.perchY };
        for (let k = 0; k < 40; k++) this.parts.push({ x: E.px + (this.rnd() - 0.5) * 10, y: E.perchY - 10, vx: (this.rnd() - 0.5) * 60, vy: -20 - this.rnd() * 30, g: 50, life: 2500, c: this.rnd() < 0.5 ? [200, 255, 80] : [255, 240, 90], glow: true, size: 2 });
        snd('entity.experience_orb.pickup', { volume: 0.6 });
        if (E.cb) { const cb = E.cb; E.cb = null; setTimeout(cb, 600); }
      }
    }
  };

  P.puffTp = function (e) {
    for (let k = 0; k < 6; k++) this.parts.push({ x: e.x + this.rnd() * 3, y: e.y - this.rnd() * 11, vx: (this.rnd() - 0.5) * 10, vy: -this.rnd() * 10, life: 600, c: [200, 120, 255], glow: true });
  };

  // ───────────── 画 ─────────────

  /** 末影龙（脚在 fx, fy，朝右；dir -1 镜像） */
  function drawDragon(g, fx, fy, o) {
    const K = o.flash ? '#a02828' : '#141414';
    const D = o.flash ? '#c03a3a' : '#262626';
    const W = o.flash ? '#8a2020' : '#2b2b2f';
    const S = '#3c3c42';
    const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(o.dir > 0 ? fx + x : fx - x - w), Math.round(fy + y), w, h); };
    const t = o.t;
    // 翅膀（在身体后面）
    if (!o.fly) { R(-6, -13, 11, 4, W); R(-4, -17, 7, 4, W); R(-2, -20, 4, 3, W); R(-6, -13, 11, 1, K); }
    else if (Math.floor(t * 3) % 2) { R(-8, -14, 14, 5, W); R(-6, -19, 10, 5, W); R(-3, -24, 5, 5, W); R(-8, -14, 14, 1, K); }
    else { R(-8, -4, 14, 4, W); R(-6, 0, 10, 4, W); R(-3, 4, 5, 3, W); R(-8, -4, 14, 1, K); }
    // 尾巴
    for (let i = 0; i < 16; i++) {
      const ty = -7 + Math.round(Math.sin(i * 0.5 + t * 2) * (o.fly ? 1.5 : 0.8)) + Math.floor(i / 6);
      R(-11 - i, ty, 1, 3 - Math.floor(i / 7), K);
      if (i % 3 === 0) R(-11 - i, ty - 1, 1, 1, S);
    }
    // 身体、背脊
    R(-10, -9, 17, 5, K); R(-9, -4, 15, 1, D);
    for (let x = -9; x < 6; x += 3) R(x, -10, 1, 1, S);
    // 腿
    R(-8, -4, 2, 4, K); R(3, -4, 2, 4, K); R(-9, -1, 1, 1, D); R(5, -1, 1, 1, D);
    // 脖子、头
    R(6, -9, 2, 4, K); R(8, -10, 2, 4, K); R(10, -12, 2, 4, K);
    R(11, -15, 7, 4, K); R(13, -11, 5, 1, D); R(18, -14, 2, 2, K);
    R(11, -17, 1, 2, S); R(13, -17, 1, 2, S);
    // 紫色的眼睛
    g.fillStyle = 'rgba(224,112,255,0.35)'; g.fillRect(Math.round(o.dir > 0 ? fx + 14 : fx - 17), Math.round(fy - 15), 3, 3);
    R(15, -14, 1, 1, '#e070ff');
  }

  overlay.push(function (lx, ly, now) {
    const E = this.ending;
    if (!E) return;
    const g = this.ctx;
    const L = this.endLay();
    const dp = dragonPos(this, E);
    const x = Math.round(dp.x + lx); const y = Math.round(dp.y + ly);
    // 水晶给龙回血的光束
    if (E.phase === 'arrive' || E.phase === 'heal') {
      for (const p of L.pillars) {
        if (p.crystal === false || !p.hit) continue;
        const sx = p.hit[0] + lx; const sy = p.hit[1] + ly;
        const n = Math.max(Math.abs(x - sx), Math.abs(y - 8 - sy));
        g.fillStyle = `rgba(255,190,240,${0.45 + 0.25 * Math.sin(now / 90 + p.col)})`;
        for (let k = 0; k <= n; k += 1) g.fillRect(Math.round(sx + ((x - sx) * k) / n), Math.round(sy + ((y - 8 - sy) * k) / n), 1, 1);
      }
    }
    // 死亡的光束
    if (E.phase === 'death') {
      for (const r of E.rays) {
        g.fillStyle = `rgba(${r.c[0]},${r.c[1]},${r.c[2]},${0.35 + 0.2 * Math.sin(now / 120 + r.a)})`;
        g.beginPath();
        const a = r.a + E.dead * 0.15;
        g.moveTo(x, y - 8);
        g.lineTo(x + Math.cos(a - r.w) * r.len, y - 8 + Math.sin(a - r.w) * r.len);
        g.lineTo(x + Math.cos(a + r.w) * r.len, y - 8 + Math.sin(a + r.w) * r.len);
        g.closePath();
        g.fill();
      }
    }
    if (E.phase !== 'after') {
      g.globalAlpha = E.phase === 'death' ? Math.max(0, Math.min(1, (10 - E.dead) / 3)) : 1;
      drawDragon(g, x, y, { dir: 1, fly: dp.fly, flash: E.flash > 0, t: E.t });
      g.globalAlpha = 1;
    }
    // 龙蛋
    if (E.egg) {
      const ex = Math.round(E.egg.x + lx); const ey = Math.round(E.egg.y + ly);
      // 黑色带紫斑；左上一圈亮边，不然在末地的夜空里看不见
      const rows = ['.ll.', 'lKkk', 'lkkK', 'kkKk', '.kk.'];
      g.fillStyle = 'rgba(200,140,255,0.18)'; g.fillRect(ex - 2, ey - 7, 8, 8);
      rows.forEach((row, ry) => [...row].forEach((ch, rx) => {
        if (ch === '.') return;
        g.fillStyle = ch === 'K' ? '#b070f0' : ch === 'l' ? '#5a4a72' : '#231a30';
        g.fillRect(ex + rx, ey - 5 + ry, 1, 1);
      }));
      if (this.rnd() < 0.05 * (this.fxK || 0.3)) this.parts.push({ x: E.egg.x + 2 + (this.rnd() - 0.5) * 6, y: E.egg.y - 3, vx: 0, vy: -4, life: 900, c: [190, 110, 255], glow: true });
    }
  });

  /** 点末影龙：打它一下（1 点血），龙闪红、冒紫色粒子；从出现到开始死亡都能打（1.5.17） */
  function hitDragon(self, E, wx, wy, now) {
    if (E.phase === 'death' || E.phase === 'after') return false;
    const dp = dragonPos(self, E);
    // 身体 + 头 + 翅膀；尾巴细，不算
    if (wx < dp.x - 13 || wx > dp.x + 21 || wy < dp.y - (dp.fly ? 25 : 21) || wy > dp.y + (dp.fly ? 8 : 1)) return false;
    E.hp = Math.max(0, E.hp - 1);
    E.flash = 0.18;
    for (let k = 0; k < 4; k++) self.parts.push({ x: wx, y: wy, vx: (self.rnd() - 0.5) * 22, vy: -6 - self.rnd() * 12, life: 500, c: k % 2 ? [200, 120, 255] : [255, 255, 255], glow: true });
    if (now - E.hurtAt > 1300) { E.hurtAt = now; snd('entity.ender_dragon.hurt', { volume: 0.55, pitch: 0.9 + self.rnd() * 0.2 }); }
    return true;
  }

  // 点龙蛋：和原版一样传送到附近别的地方；结局里点龙：打它
  const baseClick = P.clickCrystal;
  P.clickCrystal = function (wx, wy, now) {
    const E = this.ending;
    if (E && !E.egg && hitDragon(this, E, wx, wy, now)) return true;
    if (E && E.egg && Math.abs(wx - (E.egg.x + 2)) < 5 && wy > E.egg.y - 8 && wy < E.egg.y + 2) {
      for (let k = 0; k < 10; k++) this.parts.push({ x: E.egg.x + 2, y: E.egg.y - 3, vx: (this.rnd() - 0.5) * 20, vy: (this.rnd() - 0.5) * 20, life: 700, c: [190, 110, 255], glow: true });
      for (let tries = 0; tries < 12; tries++) {
        const nx = E.egg.x + (this.rnd() - 0.5) * 120;
        const gy = this.groundY(nx);
        if (gy != null && Math.abs(nx - E.px) > 8) { E.egg.x = nx; E.egg.y = gy; break; }
      }
      snd('entity.enderman.teleport', { volume: 0.6 });
      return true;
    }
    return baseClick.call(this, wx, wy, now);
  };

  tick.push(function (sec, now) {
    extraTick(this, now);
    if (this.ending) this.endingTick(sec, now);
  });

})();
