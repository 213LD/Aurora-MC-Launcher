'use strict';
/** 主页动态背景：随机事件和互动：流星、Herobrine、船、爆炸、烟花、按键、点击、天气（2.0.0-pre9 从 scene.js 拆出来） */
(function () {
  const { hex, pick, SPRITES } = A.sceneKit;

  Object.assign(A.Scene.prototype, {
    randomEvent(now) {
      const r = this.rnd();
      if (this.dim === 'over' && this.isNight()) {
        if (r < 0.55) this.shootingStar(now);
        else if (r < 0.75 && !this.opts.peaceful && this.opts.monsters) this.spawnMob('phantom', now, this.cam.x - 10);
        else if (r < 0.8) this.herobrine(now);
        else this.shootingStar(now);
      } else if (this.dim === 'over') {
        if (this.period === 'sunset' && r < 0.12) this.herobrine(now);
        else if (r < 0.3 && this.viewWater().length && this.opts.players) this.boat(now);
      } else if (this.dim === 'end' && r < 0.5 && !this.ending) {
        this.dragon(now);
      } else if (this.dim === 'nether' && r < 0.5 && !this.opts.peaceful) {
        const g = this.ents.find((e) => e.kind === 'ghast');
        if (g) this.fireball(g);
      }
    },

    shootingStar() {
      if (this.noFlash) return;
      const x = this.W * (0.2 + this.rnd() * 0.6);
      const y = this.H * (0.05 + this.rnd() * 0.15);
      for (let k = 0; k < 14; k++) this.parts.push({ x: x - k * 2, y: y - k * 0.6, vx: 70, vy: 22, life: 700 - k * 30, c: [255, 255, 255], glow: true, star: true });
    },

    herobrine(now) {
      // 远山上的白眼人影，几秒后消失
      const x = this.W * (0.15 + this.rnd() * 0.7);
      this.events.push({ type: 'herobrine', x, until: now + 4500 });
    },

    boat(now) {
      const w = this.viewWater().filter((x) => x[2]);
      if (w.length < 6) return;
      const [c] = pick(w, this.rnd());
      this.ents.push({ kind: 'boat', spr: SPRITES.steve, x: c * this.B, y: this.sea * this.B, dir: this.rnd() < 0.5 ? 1 : -1, state: 'walk', t: now, born: now, life: 30000, alpha: 0, until: now + 99999, boat: true });
    },

    dragon(now) {
      this.events.push({ type: 'dragon', x: -40, y: this.H * 0.25, until: now + 16000, t: now });
    },

    /** 恶魂吐火球；volume 是原版 entity.ghast.shoot 的音量（点它吐的响一些，自己吐的轻一些，1.7.0） */
    fireball(g, volume = 0.3) {
      if (A.gameSound) A.gameSound.play('entity.ghast.shoot', { volume, pitch: 0.9 + this.rnd() * 0.2 }).catch(() => {});
      for (let k = 0; k < 6; k++) this.parts.push({ x: g.x + 4, y: g.y - 3, vx: g.dir * (25 + k * 2), vy: 8, life: 1400, c: [255, 120 + k * 15, 30], glow: true, size: 2 });
    },

    puff(x, y, c, n = 8) {
      for (let k = 0; k < n; k++) this.parts.push({ x, y, vx: (this.rnd() - 0.5) * 24, vy: -6 - this.rnd() * 10, life: 600, c });
    },

    teleport(e) {
      for (let k = 0; k < 10; k++) this.parts.push({ x: e.x + this.rnd() * 3, y: e.y - this.rnd() * 11, vx: (this.rnd() - 0.5) * 10, vy: -this.rnd() * 10, life: 700, c: [200, 120, 255], glow: true });
      for (let tries = 0; tries < 10; tries++) {
        const nx = e.x + (this.rnd() - 0.5) * 80;
        const gy = this.groundY(nx);
        if (gy != null) { e.x = nx; e.y = gy; break; }
      }
    },

    /** 苦力怕被点燃的嘶嘶声（1.6.2）：原版也是这个声音事件、0.5 倍音高；没装游戏时用 gamesound.js 合成的 */
    fuseSound(volume = 0.6) {
      if (A.gameSound) A.gameSound.play('entity.creeper.primed', { volume, pitch: 0.5 }).catch(() => {});
    },

    explode(e, now) {
      this.ents = this.ents.filter((x) => x !== e);
      e.dead = true; // 盯着它的、躲着它的都知道它没了（rc14）
      const cx = e.x + 1;
      // 1.5.17：苦力怕爆炸以前是哑的；原版爆炸声（读本机游戏资源，没有就用合成的，gamesound.js）
      if (A.gameSound) A.gameSound.play('entity.generic.explode', { volume: e.clickFuse ? 0.7 : 0.5, pitch: 0.9 + this.rnd() * 0.2 }).catch(() => {});
      const nf = this.noFlash; // 减少闪烁：只有灰烟，没有发光的火花
      for (let k = 0; k < 30; k++) this.parts.push({ x: cx, y: e.y - 3, vx: (this.rnd() - 0.5) * 60, vy: -this.rnd() * 40, g: 50, life: 900, c: k % 3 || nf ? [150, 150, 150] : [255, 200, 80], glow: !nf && k % 3 === 0 });
      // 周围的生物被击退；玩家点燃的还会在地形上炸出一个坑（小屋不炸）
      this.blast(e, now);
      if (!e.clickFuse) return;
      const c = Math.floor(cx / this.B);
      // 坑宽 3 格：挨着小屋就不炸，免得把小屋底下挖空
      if (this.houses.some((h) => c + 1 >= h.col && c - 1 <= h.col + (h.w || 5) - 1)) return;
      // 炸到玩家搭的建筑就整个炸掉，不留悬空的方块
      this.builds = this.builds.filter((b) => {
        if (c + 1 < b.col || c - 1 > b.col + (b.w || 3) - 1) return true;
        for (const bl of b.blocks) this.puff((b.col + bl.x) * this.B + 2, (b.top - bl.y - 1) * this.B + 2, this.buildPuffColor(b, bl), 3);
        for (const x of this.ents) if (x.task && x.task.build === b) { x.task = null; x.state = 'walk'; x.until = now + 3000; }
        return false;
      });
      for (let k = -1; k <= 1; k++) if (this.heights[c + k] !== undefined && this.heights[c + k] < 900) this.heights[c + k] += k === 0 ? 2 : 1;
      this.trees = this.trees.filter((t) => Math.abs(t.col - c) > 1);
      this.decor = this.decor.filter((d) => Math.abs(d.col - c) > 1 || d.type === 'pillar' || d.type === 'bridge');
      if (this.torches) this.torches = this.torches.filter((t) => Math.abs(t.col - c) > 1);
      this.renderLand();
      for (const x of this.ents) if (!x.spr.fly && !x.spr.swims && !x.cave) { const gy = this.groundY(x.x); if (gy != null) x.y = gy; }
    },

    fireworks(n = 6) {
      if (this.noFlash) return;
      for (let k = 0; k < n; k++) {
        setTimeout(() => {
          const x = this.W * (0.15 + this.rnd() * 0.7);
          const y = this.H * (0.12 + this.rnd() * 0.25);
          const c = pick([[255, 90, 90], [90, 200, 255], [255, 220, 90], [160, 255, 120], [230, 130, 255]], this.rnd());
          for (let i = 0; i < 28; i++) {
            const a = (i / 28) * Math.PI * 2;
            const sp = 20 + this.rnd() * 18;
            this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 12, life: 1400, c, glow: true, screen: true });
          }
        }, k * 450);
      }
    },

    onKey(e) {
      const seq = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
      if (e.target && e.target.matches && e.target.matches('input, textarea')) return;
      this.konami.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
      this.konami = this.konami.slice(-seq.length);
      if (this.konami.join(',') === seq.join(',')) { this.konami = []; this.fireworks(12); }
    },

    /** 点击背景中的生物 */
    click(clientX, clientY) {
      const r = this.canvas.getBoundingClientRect();
      const ix = ((clientX - r.left) / r.width) * this.W;
      const iy = ((clientY - r.top) / r.height) * this.H;
      const lx = this.landX || 0;
      const ly = this.landY || 0;
      const hit = this.ents.find((e) => {
        const x = e.x + lx;
        const y = e.y + ly;
        return ix >= x - 2 && ix <= x + e.spr.w + 2 && iy >= y - e.spr.h - 2 && iy <= y + 2;
      });
      // 没点中生物：看看点没点中环境里能互动的东西（紫水晶、发光浆果、藤蔓、箱子、水……，sceneinteract.js）
      if (!hit) return this.clickEnv ? this.clickEnv(ix - lx, iy - ly, performance.now()) : false;
      const now = performance.now();
      const k = hit.kind;
      if (k === 'enderman') { this.teleport(hit); if (A.gameSound) A.gameSound.play('entity.enderman.teleport', { volume: 0.6 }).catch(() => {}); return true; }
      if (k === 'sheep') hit.color = pick(['#e84a4a', '#4a8ae8', '#4ae86a', '#e8d84a', '#b04ae8', '#ffffff', '#3a3a3a'], this.rnd());
      if (k === 'ghast') { this.fireball(hit, 0.7); return true; }
      // 点苦力怕：原地点燃，1.5 秒后爆炸并炸出一个坑（玩家点的才破坏地形，打斗里的爆炸不破坏）
      if (k === 'creeper') {
        if (!hit.creeperFuse) { hit.creeperFuse = now + 1500; hit.clickFuse = true; hit.moving = false; this.fuseSound(0.7); }
        return true;
      }
      // 点敌对生物：帮玩家打一下
      if (hit.spr.hostile) { this.hitMob(hit, 4, -hit.dir, now, 0.7); return true; }
      hit.jumpT = now;
      this.friendSound(hit, 0.6); // 友好生物被点了叫一声（1.7.2，scenefight.js）
      const heart = k === 'villager' ? [120, 220, 120] : [255, 80, 100];
      for (let i = 0; i < 4; i++) this.parts.push({ x: hit.x + 1 + i, y: hit.y - hit.spr.h - 1, vx: (this.rnd() - 0.5) * 8, vy: -8, life: 900, c: heart, glow: true, heart: k !== 'villager' });
      return true;
    },

    weather(sec) {
      // 雪原的雪跟着天气下（rc3，sceneweather.js），下得越大越密；圣诞节主世界都飘一点雪
      const wx = this.wx;
      const snowing = this.S.precip === 'snow' && wx && wx.level > 0.02;
      const kind = this.S.weather || (snowing || (this.fest === 'christmas' && this.dim === 'over') ? 'snow' : null);
      const n = ({ snow: snowing ? 8 + 34 * wx.level : 18, petals: 7, ash: 14 }[kind] || 0) * (0.3 + 0.7 * this.fxK); // 特效低档也留一点雪
      if (!n) return;
      // 视角整个在地下时不下雪 / 不飘花瓣（地表在画面上面）
      const surf = this.groundY(this.cam.x + this.W / 2);
      if (surf != null && surf + 8 < this.cam.y) return;
      if (this.rnd() < sec * n) {
        const px = this.rnd() * this.W;
        let c = kind === 'snow' ? [255, 255, 255] : kind === 'petals' ? hex(pick(['#f3b4d0', '#f8c6dc', '#e48fb6'], this.rnd())) : [120, 110, 110];
        if (this.dim === 'nether') c = this.netherAsh(px - (this.landX || 0)); // 下界按群系：绯红孢子、诡异孢子、灵魂、灰烬（scenenether.js）
        this.parts.push({ x: px, y: -2, vx: kind === 'petals' ? 6 + this.rnd() * 6 : (this.rnd() - 0.5) * 3, vy: kind === 'snow' ? 8 + this.rnd() * 6 : 5 + this.rnd() * 4, life: 20000, c, weather: true });
      }
      // 夜晚的萤火虫
      if (this.dim === 'over' && this.isNight() && ['plains', 'forest', 'cherry', 'darkforest', 'jungle'].includes(this.sceneId) && this.rnd() < sec * 1.2 * (0.3 + 0.7 * this.fxK)) {
        const x = this.rnd() * this.W;
        const gy = this.groundY(x - (this.landX || 0));
        if (gy != null) this.parts.push({ x: x - (this.landX || 0), y: gy - 2 - this.rnd() * 10, vx: (this.rnd() - 0.5) * 3, vy: -1, life: 3000, c: [210, 255, 120], glow: true, firefly: true, land: true });
      }
    },

    // ───────────── 绘制 ─────────────
  });
})();
