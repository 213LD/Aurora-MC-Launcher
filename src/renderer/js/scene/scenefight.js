'use strict';
/**
 * 首页动态背景：敌对生物和玩家的互动。挂在 A.Scene.prototype 上，scene.js 在更新、绘制、点击时调用。
 * - 主世界里僵尸、尸壳、流浪者、骷髅、苦力怕、蜘蛛发现附近的玩家就追过去：近战的贴身打，骷髅隔开距离射箭，苦力怕靠近后闪白爆炸
 * - 玩家拿剑迎战；血少了、怪太多、苦力怕要炸时就跑：有小屋跑回屋里（怪进不了屋），没有就往远处跑
 * - 玩家不会死（血量最低留 1 颗心），不受伤一会儿后慢慢回血；怪物被打死冒烟、掉落物品，玩家路过会捡走
 * - 爆炸只有击退，不破坏地形；白天亡灵照旧燃烧（scene.js）
 * - 鼠标点怪物：帮玩家打一下（hitMob）
 */
(function () {
  const P = A.Scene.prototype;

  const MELEE = new Set(['zombie', 'husk', 'spider']);
  const RANGED = new Set(['skeleton', 'stray']);
  const SPEED = { zombie: 4, husk: 4, stray: 3.5, spider: 7, skeleton: 3.5, creeper: 3.5 };
  const MOB_HP = { spider: 8, witherSkeleton: 14, warden: 60 }; // 监守者很耐打（原版 500 血）
  const SIGHT = 56; // 敌对生物发现玩家的距离（像素）
  const PLAYER_HP = 20;
  const LOW_HP = 8; // 血量到这里就逃跑
  // 掉落物颜色：腐肉、骨头、火药、线
  const DROP = { zombie: [120, 70, 40], husk: [120, 70, 40], stray: [235, 235, 225], skeleton: [235, 235, 225], creeper: [80, 80, 80], spider: [240, 240, 240] };
  const BLADE = [110, 230, 225];
  const HILT = [110, 80, 40];

  const fighter = (o) => o.spr.hostile && (MELEE.has(o.kind) || RANGED.has(o.kind) || o.kind === 'creeper') && !o.spr.fly && !o.spr.swims && !o.cave;
  const alive = (o) => o && !o.dead && !o.fade && !o.burning;

  P.nearestEnt = function (e, pred, range) {
    let best = null;
    let bd = range;
    for (const o of this.ents) {
      if (o === e || !alive(o) || o.alpha < 0.5 || !pred(o)) continue;
      const d = Math.abs(o.x - e.x);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };

  /** 地面上走一步，走不过去（台阶太高、水、屋子、屏幕边）返回 false */
  P.stepEnt = function (e, dir, dist) {
    if (e.cave) return this.caveStep(e, dir, dist); // 洞穴里的生物沿洞底走（scenecave.js）
    const nx = e.x + dir * dist;
    const lead = nx + (dir > 0 ? e.spr.w : 0);
    const cur = this.groundY(e.x);
    const next = this.groundY(lead);
    if (cur == null || next == null || Math.abs(next - cur) > this.B || this.isWaterCol(lead) || !this.loadedAt(nx) || (this.surfLavaAt && this.surfLavaAt(lead))) return false;
    if (this.houseAt(nx) && !this.houseAt(e.x)) return false;
    e.x = nx;
    this.follow(e);
    return true;
  };

  /** 击退：一个像素一个像素推，碰到障碍就停 */
  P.pushEnt = function (e, dx) {
    const dir = dx > 0 ? 1 : -1;
    for (let k = 0; k < Math.abs(dx); k++) if (!this.stepEnt(e, dir, 1)) break;
  };

  /** 每个生物更新时先问一下：在打斗吗？返回 true 表示这一帧的移动已经处理了 */
  P.fight = function (e, sec, now) {
    if (this.dim !== 'over' || e.boat) return false;
    if (e.kind === 'player') return this.playerFight(e, sec, now);
    if (fighter(e) && !e.burning) return this.mobFight(e, sec, now);
    return false;
  };

  P.mobFight = function (e, sec, now) {
    const k = e.kind;
    // 被鼠标点燃的苦力怕：站着等爆炸（scene.js 的 creeperFuse 处理），打斗逻辑不去熄火
    if (e.clickFuse) { e.moving = false; return false; }
    if (e.hp == null) e.hp = MOB_HP[k] || 10;
    const keep = alive(e.prey) && Math.abs(e.prey.x - e.x) < SIGHT * 1.5 ? e.prey : null;
    const p = keep || this.nearestEnt(e, (o) => o.kind === 'player', SIGHT);
    e.prey = p;
    if (!p) {
      if (e.creeperFuse) e.creeperFuse = 0;
      return false;
    }
    const dx = p.x - e.x;
    const dist = Math.abs(dx);
    const toward = dx > 0 ? 1 : -1;
    e.dir = toward;
    const spd = SPEED[k] || 3.5;
    if (k === 'creeper') {
      // 玩家跑远了就熄火，离得近继续倒计时（爆炸在 scene.js 的 creeperFuse 里）
      if (e.creeperFuse) { if (dist > 14) e.creeperFuse = 0; else return false; }
      if (dist < 3) { e.creeperFuse = now + 1500; e.moving = false; this.fuseSound(0.45); return true; }
      e.moving = this.stepEnt(e, toward, spd * sec);
      return true;
    }
    if (RANGED.has(k)) {
      // 骷髅保持距离射箭：太远靠近，太近往后退
      let move = 0;
      if (dist > 36) move = toward; else if (dist < 14) move = -toward;
      e.moving = move ? this.stepEnt(e, move, spd * sec * (move === toward ? 1 : 0.7)) : false;
      e.dir = toward;
      if (dist < 50 && now > (e.atkT || 0)) { e.atkT = now + 2200 + this.rnd() * 900; this.shootArrow(e, p, now); }
      return true;
    }
    if (dist > 2.5) { e.moving = this.stepEnt(e, toward, spd * sec); return true; }
    e.moving = false;
    if (now > (e.atkT || 0)) {
      e.atkT = now + 1000;
      e.jumpT = now;
      this.hurtPlayer(p, k === 'spider' ? 2 : 3, toward, now, 3);
    }
    return true;
  };

  P.playerFight = function (e, sec, now) {
    if (e.hp == null) e.hp = PLAYER_HP;
    if (e.hp < PLAYER_HP && now - (e.hurtAt || 0) > 4000 && now > (e.regenT || 0)) { e.hp += 1; e.regenT = now + 1200; }
    this.pickDrops(e, now);
    // 正盯着自己的怪优先，其次是很近的怪
    // 够不着的怪（隔着两格高的台阶）先不管它
    const can = (o) => fighter(o) && !(o === e.ignore && now < e.ignoreUntil);
    const threat = this.nearestEnt(e, (o) => can(o) && o.prey === e, 48) || this.nearestEnt(e, can, 26);
    if (!threat) {
      if (e.state === 'fight' || e.state === 'flee') { e.state = 'walk'; e.until = now + 2500; }
      if (e.run && e.state !== 'home') e.run = false;
      return e.run ? this.runHome(e, sec, now) : false;
    }
    // 被打断：放下手里的活
    if (e.task) {
      if (e.task.tree) e.task.tree.target = false;
      e.task = null;
    }
    const fuse = this.nearestEnt(e, (o) => o.kind === 'creeper' && o.creeperFuse, 18);
    const crowd = this.ents.filter((o) => fighter(o) && alive(o) && Math.abs(o.x - e.x) < 30).length;
    const house = this.opts.buildings && this.houses[0];
    if (e.run || e.hp <= LOW_HP || crowd > 2 || fuse) {
      // 逃跑：血少或怪多时回屋，苦力怕要炸时先拉开距离
      if (house && !fuse && (e.run || e.hp <= LOW_HP || crowd > 2)) { e.run = true; e.state = 'home'; return this.runHome(e, sec, now); }
      e.state = 'flee';
      const from = fuse || threat;
      const away = e.x > from.x ? 1 : -1;
      e.dir = away;
      e.moving = this.stepEnt(e, away, 9 * sec);
      // 被逼到角落：转身硬拼
      if (!e.moving && !fuse) { e.state = 'fight'; e.dir = -away; }
      return true;
    }
    e.state = 'fight';
    const dx = threat.x - e.x;
    const toward = dx > 0 ? 1 : -1;
    e.dir = toward;
    const reach = threat.kind === 'creeper' ? 4.5 : 3;
    if (Math.abs(dx) > reach) {
      e.moving = this.stepEnt(e, toward, 6 * sec);
      if (e.moving) e.stuckT = 0;
      else if (!e.stuckT) e.stuckT = now;
      else if (now - e.stuckT > 1500) { e.ignore = threat; e.ignoreUntil = now + 8000; e.stuckT = 0; e.state = 'walk'; e.dir = -toward; e.until = now + 3000; }
      return true;
    }
    e.moving = false;
    if (now > (e.atkT || 0)) {
      e.atkT = now + 550;
      e.swingT = now;
      this.hitMob(threat, 4, toward, now);
    }
    return true;
  };

  /** 跑回小屋：不管地形一路跑过去，进门就安全了 */
  P.runHome = function (e, sec, now) {
    const h = this.houses[0];
    if (!h) { e.run = false; return false; }
    const hx = (h.col + (h.dc || 1)) * this.B + 1;
    e.dir = hx > e.x ? 1 : -1;
    e.moving = true;
    e.x += e.dir * Math.min(9 * sec, Math.abs(hx - e.x));
    this.follow(e);
    if (Math.abs(hx - e.x) < 1) { h.door = now + 1600; e.dead = true; }
    return true;
  };

  P.hurtPlayer = function (p, dmg, dir, now, kb) {
    p.hp = Math.max(2, (p.hp == null ? PLAYER_HP : p.hp) - dmg);
    p.hurt = now + 300;
    p.hurtAt = now;
    this.pushEnt(p, dir * kb);
    for (let k = 0; k < 3; k++) this.parts.push({ x: p.x + 1, y: p.y - 6, vx: (this.rnd() - 0.5) * 14, vy: -6 - this.rnd() * 6, g: 30, life: 500, c: [200, 30, 30] });
  };

  // 怪物挨打 / 被打死的原版声音（1.7.0）。事件名一般就是 entity.<生物>.hurt，下面几个名字和精灵图的不一样
  const SND = { magma: 'magma_cube', zpiglin: 'zombified_piglin', caveSpider: 'spider' };
  const sndName = (k) => SND[k] || k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  P.mobSound = function (m, what, volume) {
    if (!volume || !A.gameSound) return;
    A.gameSound.play(`entity.${sndName(m.kind)}.${what}`, { volume, pitch: 0.9 + this.rnd() * 0.2, alt: `entity.generic.${what}` }).catch(() => {});
  };

  // 点友好生物时它叫一声（1.7.2）：一般是 entity.<生物>.ambient，下面这些叫法不一样（鱼没有叫声，用扑腾声）
  const FRIEND = {
    mooshroom: 'entity.cow.ambient', polar: 'entity.polar_bear.ambient', bee: 'entity.bee.pollinate', turtle: 'entity.turtle.ambient_land',
    cod: 'entity.cod.flop', salmon: 'entity.salmon.flop', tropical: 'entity.tropical_fish.flop', pufferfish: 'entity.puffer_fish.blow_up',
    parrotBlue: 'entity.parrot.ambient', parrotGreen: 'entity.parrot.ambient', rabbitW: 'entity.rabbit.ambient', foxW: 'entity.fox.ambient',
    // 2026-11-07 新加的：美西螈几种颜色都是同一种叫声
    axolotl: 'entity.axolotl.idle_water', axolotlWild: 'entity.axolotl.idle_water', axolotlGold: 'entity.axolotl.idle_water', axolotlCyan: 'entity.axolotl.idle_water', axolotlBlue: 'entity.axolotl.idle_water',
  };
  P.friendSound = function (m, volume = 0.6) {
    if (!A.gameSound) return;
    // 游戏里没有（没装游戏、或者这个版本还没有这种生物）就用启动器合成的一声
    A.gameSound.play(FRIEND[m.kind] || `entity.${sndName(m.kind)}.ambient`, { volume, pitch: 0.9 + this.rnd() * 0.2, alt: 'aurora.friendly' }).catch(() => {});
  };

  /**
   * 打怪物一下（玩家的剑或鼠标点击）。返回 true 表示打死了。
   * vol 是挨打声的音量：鼠标点的响一些，背景里自己打起来的轻一些，爆炸波及的更轻
   */
  P.hitMob = function (m, dmg, dir, now, vol = 0.25) {
    if (m.hp == null) m.hp = MOB_HP[m.kind] || 10;
    m.hp -= dmg;
    this.mobSound(m, m.hp > 0 ? 'hurt' : 'death', vol);
    m.hurt = now + 300;
    if (m.creeperFuse && !m.clickFuse) m.creeperFuse = 0;
    this.pushEnt(m, dir * 3);
    if (!this.noFlash) for (let k = 0; k < 3; k++) this.parts.push({ x: m.x + 1, y: m.y - m.spr.h / 2, vx: dir * (6 + this.rnd() * 10), vy: -4 - this.rnd() * 6, life: 300, c: [255, 255, 255], glow: true });
    if (m.hp > 0) return false;
    m.dead = true;
    this.puff(m.x + 1, m.y - 3, [210, 210, 210], 10);
    if (DROP[m.kind]) this.drops.push({ x: m.x + 1, y: m.y, c: DROP[m.kind], born: now, until: now + 8000 });
    return true;
  };

  P.shootArrow = function (e, p, now) {
    const x = e.x + 1 + e.dir * 2;
    const y = e.y - 5;
    const vx = e.dir * 45;
    const t = Math.max(0.2, Math.abs(p.x + 1 - x) / 45);
    const g = 60;
    const vy = ((p.y - 5) - y) / t - (g * t) / 2;
    this.arrows.push({ x, y, vx, vy, g, born: now });
  };

  /** 爆炸：周围的玩家和怪物被击退、受伤，不破坏地形 */
  P.blast = function (e, now) {
    const cx = e.x + 1;
    for (const o of this.ents) {
      if (o === e || !alive(o) || o.spr.fly || o.spr.swims || o.boat) continue;
      if (Math.abs(o.y - e.y) > 24) continue; // 地上的爆炸不波及地下的洞穴
      const d = Math.abs(o.x - cx);
      if (d > 20) continue;
      const dir = o.x >= cx ? 1 : -1;
      const dmg = Math.round(10 * (1 - d / 20)) + 2;
      if (o.kind === 'player') this.hurtPlayer(o, dmg, dir, now, 10);
      else if (o.spr.hostile) this.hitMob(o, dmg, dir, now, 0.12);
      else this.pushEnt(o, dir * 8);
      o.jumpT = now;
    }
  };

  /** 箭的飞行、掉落物过期（scene.js 的 update 每帧调用） */
  P.fightTick = function (sec, now) {
    for (const a of this.arrows) {
      if (a.stuck) { if (now - a.stuck > 3000) a.dead = true; continue; }
      a.x += a.vx * sec; a.y += a.vy * sec; a.vy += a.g * sec;
      const hit = this.ents.find((o) => o.kind === 'player' && alive(o) && Math.abs(a.x - (o.x + 1)) < 2 && a.y > o.y - 8 && a.y < o.y + 1);
      if (hit) { this.hurtPlayer(hit, 2, a.vx > 0 ? 1 : -1, now, 2); a.dead = true; continue; }
      const gy = this.groundY(a.x);
      if ((gy != null && a.y >= gy) || this.houseAt(a.x)) { a.stuck = now; a.ang = Math.atan2(a.vy, a.vx); }
      if (a.x < this.cam.x - 10 || a.x > this.cam.x + this.W + 10 || a.y > this.cam.y + this.H + 10) a.dead = true;
    }
    this.arrows = this.arrows.filter((a) => !a.dead);
    this.drops = this.drops.filter((d) => now < d.until);
  };

  P.pickDrops = function (e, now) {
    for (const d of this.drops) {
      if (Math.abs(d.x - (e.x + 1)) < 3 && now - d.born > 600) {
        d.until = 0;
        this.parts.push({ x: d.x, y: d.y - 2, vx: 0, vy: -10, life: 400, c: [255, 255, 160], glow: true });
      }
    }
  };

  /** 箭、掉落物、玩家的剑和血条（画在生物之后，坐标跟随地形视差） */
  P.drawFight = function (ox, oy, now) {
    const { ctx } = this;
    for (const a of this.arrows) {
      const ang = a.stuck ? a.ang : Math.atan2(a.vy, a.vx);
      const cx = Math.cos(ang);
      const cy = Math.sin(ang);
      ctx.globalAlpha = a.stuck ? Math.min(1, (3000 - (now - a.stuck)) / 600) : 1;
      for (let k = 0; k < 4; k++) {
        ctx.fillStyle = this.color(k === 0 ? [200, 200, 200] : k === 3 ? [240, 240, 240] : [120, 90, 50]);
        ctx.fillRect(Math.round(a.x - cx * k + ox), Math.round(a.y - cy * k + oy), 1, 1);
      }
    }
    ctx.globalAlpha = 1;
    for (const d of this.drops) {
      const bob = Math.round(Math.sin((now - d.born) / 300));
      ctx.globalAlpha = Math.min(1, (d.until - now) / 800);
      ctx.fillStyle = this.color(d.c);
      ctx.fillRect(Math.round(d.x + ox), Math.round(d.y + oy) - 2 + bob, 2, 1);
    }
    ctx.globalAlpha = 1;
    for (const e of this.ents) {
      if (e.kind !== 'player' || e.boat) continue;
      const fighting = e.state === 'fight' || (e.swingT && now - e.swingT < 400);
      // 和 drawSprite 的位置算法一致
      const x0 = Math.round(e.x + ox);
      const y0 = Math.round(e.y + oy) - e.spr.h + this.spriteBob(e, now);
      const fx = (dx) => (e.dir > 0 ? x0 + dx : x0 + e.spr.w - 1 - dx);
      ctx.globalAlpha = Math.max(0, Math.min(1, e.alpha));
      if (fighting) {
        const swinging = e.swingT && now - e.swingT < 200;
        // 剑握在手里（玩家精灵图第 7 行的手；挥的时候手伸到肩膀前面，剑横着砍出去）
        const hy = swinging ? y0 + 4 : y0 + 6;
        ctx.fillStyle = this.color(HILT);
        ctx.fillRect(fx(3), hy, 1, 1);
        // 剑身不跟着夜色变暗（emissive），夜里也看得清
        ctx.fillStyle = this.color(BLADE, true);
        if (swinging) for (let k = 4; k <= 7; k++) ctx.fillRect(fx(k), hy, 1, 1);
        else for (let k = 1; k <= 4; k++) ctx.fillRect(fx(3), hy - k, 1, 1);
      }
      // 受伤后几秒内显示血条
      if (e.hp != null && e.hp < PLAYER_HP && (now - (e.hurtAt || 0) < 3000 || fighting || e.state === 'flee' || e.run)) {
        const w = 5;
        const filled = Math.max(1, Math.round((e.hp / PLAYER_HP) * w));
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x0 - 1, y0 - 3, w, 1);
        ctx.fillStyle = e.hp <= LOW_HP ? '#ff4040' : '#e02828';
        ctx.fillRect(x0 - 1, y0 - 3, filled, 1);
      }
      ctx.globalAlpha = 1;
    }
  };
})();
