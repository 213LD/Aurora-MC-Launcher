'use strict';
/** 主页动态背景：生物和玩家：生成、走动、跟随、干活（2.0.0-pre9 从 scene.js 拆出来） */
(function () {
  const { pick, M, SPRITES, MAX_PLAYERS } = A.sceneKit;

  Object.assign(A.Scene.prototype, {
    spawn(now) {
      const o = this.opts;
      const max = Math.max(0, Math.min(30, Number(o.mobs) || 0));
      const count = this.ents.filter((e) => !e.event && !e.flock && !e.extra && !e.ending).length; // 鱼群里跟着游的、终极彩蛋加的末影人不算（sceneending.js）
      if (count >= max) return;
      // 视角在地下时生成洞穴里的生物；画面里有刷怪笼、海底神殿时先补那里的（scenecave.js / sceneocean.js）
      if (this.caveSpawn(now) || this.seaSpawn(now) || this.landSpawn(now) || this.netherSpawn(now)) return;
      const S = this.S;
      const r = this.rnd;
      const night = this.isNight() || this.dim !== 'over' || this.stormDark(); // 雷雨天白天也刷怪物（rc3）
      const options = [];
      if (o.animals) for (const k of S.animals) if (this.allowed(k)) options.push([k, 3]);
      if (o.animals && this.dim === 'over' && this.goatSpawnable()) options.push(['goat', 3]); // 雪山的高处（sceneland.js）
      if (o.monsters && !o.peaceful && !S.noHostile && night) for (const k of S.hostile) if (this.allowed(k)) options.push([k, this.dim === 'over' ? 3 : 2]);
      if (o.aquatic && this.viewWater().length) for (const k of S.aquatic) options.push([k, 2]);
      // 同时最多 2 个玩家（1.10.4）：以前不限，和府邸门口的灾厄村民加起来满屏都是小人
      if (o.players && this.dim === 'over' && S.house !== undefined && this.ents.filter((e) => e.kind === 'player').length < MAX_PLAYERS) options.push(['player', o.buildings ? 2 : 1]);
      if (this.dim === 'over' && this.sceneId === 'plains' && r() < 0.4) options.push(['villager', 1]);
      if (!options.length) return;
      const total = options.reduce((s, x) => s + x[1], 0);
      let roll = r() * total;
      let kind = options[0][0];
      for (const [k, w] of options) { roll -= w; if (roll <= 0) { kind = k; break; } }
      if (kind === 'player') { this.spawnPlayer(now); return; }
      this.spawnMob(kind, now);
    },

    spawnMob(kind, now, at) {
      const spr = SPRITES[kind];
      const r = this.rnd;
      const offset = 16;
      let x;
      let y;
      if (spr.swims) {
        // 水要比身子宽一截才放（rc4：生物放大以后，窄水塘里的鱿鱼、鳕鱼转不过身，在原地来回抖）
        const room = (c) => { let n = 1; for (let k = 1; k < 8 && this.isWaterCol((c + k) * this.B); k++) n++; for (let k = 1; k < 8 && this.isWaterCol((c - k) * this.B); k++) n++; return n * this.B; };
        const deep = (c) => (this.colHeight(c) - this.sea) * this.B; // 水深（像素）：身子要放得下
        const vw = this.viewWater().filter((w) => room(w[0]) >= spr.w + this.B * 2 && deep(w[0]) >= spr.h + 3);
        if (!vw.length) return null;
        const [c, row] = pick(vw.filter((w) => !w[2]), r()) || vw[0];
        x = c * this.B + 1; y = row * this.B + 2 + r() * 2;
      } else if (spr.fly) {
        x = at != null ? at : this.cam.x + r() * this.W;
        y = this.H * (0.18 + r() * 0.3);
        if (kind === 'bee' || spr.canopy) {
          // 蜜蜂贴着花丛低飞；鹦鹉在树冠那么高的地方飞（scenejungle.js）
          const gy = this.groundY(x);
          if (gy == null) return null;
          y = gy - (spr.canopy ? 14 + r() * 18 : 4 + r() * 8);
        }
      } else {
        for (let tries = 0; tries < 20; tries++) {
          x = at != null ? at : this.cam.x + offset + r() * (this.W - 10);
          const gy = this.groundY(x);
          if (gy == null) continue;
          if (kind === 'strider' && !this.isWaterCol(x)) continue;
          if (kind === 'goat' && !this.alpineAt(x)) continue;
          if (kind !== 'strider' && kind !== 'turtle' && this.isWaterCol(x)) continue;
          if (this.surfLavaAt && this.surfLavaAt(x)) continue; // 地表岩浆湖上不生成（rc4）
          y = kind === 'strider' ? this.sea * this.B : gy;
          break;
        }
        if (y == null) return null;
      }
      const e = {
        kind, spr, x, y, dir: r() < 0.5 ? 1 : -1, vx: 0, state: 'idle', t: now, until: now + 1000 + r() * 3000, born: now,
        life: 45000 + r() * 60000, alpha: 0, flip: false, color: null,
      };
      if (this.opts.eggs) {
        // 1.5.16 调：倒立以前每只 3%，生物一多几乎总能看到；彩虹羊以前 6% 很难碰到。
        // 彩虹羊同一时间最多一只：平原的羊占动物的四成，生物数量调高以后每只 15% 常常同时出来好几只（30 个生物时最多 5 只）
        if (kind === 'sheep' && !this.ents.some((x) => x.jeb && !x.dead) && r() < 0.15) e.jeb = true;
        if (!spr.fly && !spr.swims && r() < 0.006) e.flip = true; // Dinnerbone
      }
      if (kind === 'sheep' && !e.jeb && r() < 0.15) e.color = pick(['#3a3a3a', '#8a6a4a', '#c8c8c8', '#f0a8c8'], r());
      this.ents.push(e);
      this.afterSpawn(e, now); // 鱼成群（sceneocean.js）
      return e;
    },

    spawnPlayer(now) {
      const r = this.rnd;
      const skin = r() < 0.5 ? 'steve' : 'alex';
      const house = this.houses[0];
      const inView = (col) => col * this.B > this.cam.x + 8 && col * this.B < this.cam.x + this.W - 8;
      const trees = this.trees.filter((t) => t.alive && t.grow >= 1 && !t.target && inView(t.col) && ['oak', 'birch', 'spruce', 'cherry', 'darkOak', 'jungle'].includes(t.kind));
      const roll = r();
      // 打开了「用我的皮肤」时，部分玩家穿皮肤库里的皮肤（sceneskin.js）
      const base = { kind: 'player', spr: this.pickPlayerSprite ? this.pickPlayerSprite(r) : SPRITES[skin], dir: 1, vx: 0, t: now, born: now, life: 90000, alpha: 0, swing: 0 };
      if (this.opts.buildings && house && roll < (this.isNight() ? 0.85 : 0.35)) {
        // 从小屋里走出来；夜里多数玩家待在家附近或者拿着火把出门（scenetorch.js）
        const x = (house.col + (house.dc || 1)) * this.B + 1;
        house.door = now + 1600;
        const e = { ...base, x, y: house.ground * this.B, state: 'walk', dir: r() < 0.5 ? -1 : 1, until: now + 4000 + r() * 4000, alpha: 1 };
        if (this.isNight()) this.nightPlayer(e);
        this.ents.push(e);
        return;
      }
      if (this.opts.buildings && trees.length && roll < 0.75) {
        const tr = pick(trees, r());
        tr.target = true;
        const side = r() < 0.5 ? -1 : 1;
        const tx = tr.col * this.B + (side > 0 ? -3 : this.B + 0);
        const sx = tx + (side > 0 ? -40 : 40);
        const y = this.groundY(sx);
        if (y == null) { tr.target = false; return; }
        this.ents.push({ ...base, x: sx, y, dir: side, state: 'goto', goal: tx, task: { type: 'chop', tree: tr }, until: now + 20000 });
        return;
      }
      if (this.opts.buildings && this.nearBuilds() < 2 && roll < 0.95) {
        // 找一块平地搭建（种类、选址在 scenebuild.js）
        const bx = this.newBuild(r);
        if (bx) {
          const sx = (bx.col - 8) * this.B;
          const y = this.groundY(sx);
          if (y != null) {
            this.builds.push(bx);
            this.ents.push({ ...base, x: sx, y, dir: 1, state: 'goto', goal: (bx.col - 1) * this.B, task: { type: 'build', build: bx }, until: now + 30000 });
            return;
          }
        }
      }
      // 只是散步
      const x = this.cam.x + 10 + r() * (this.W - 20);
      const y = this.groundY(x);
      if (y == null || this.isWaterCol(x)) return;
      this.ents.push({ ...base, x, y, state: 'idle', until: now + 1500 });
    },

    // ───────────── 更新 ─────────────
    update(dt, now) {
      if (now > this.nextSpawn) {
        this.spawn(now);
        this.nextSpawn = now + 2500 + this.rnd() * 3500;
      }
      if (this.opts.eggs && now > this.nextEvent) {
        this.randomEvent(now);
        this.nextEvent = now + 15000 + this.rnd() * 30000;
      }
      const sec = dt / 1000;
      // 画面停过（去了别的页面、窗口最小化）：停着的那段不算「卡住」
      if (this._updAt && now - this._updAt > 1000) for (const e of this.ents) if (e.movedAt != null) e.movedAt += now - this._updAt;
      this._updAt = now;
      for (const e of this.ents) {
        const x0 = e.x;
        // 一个生物出错只去掉它自己（rc14）：以前一个出错，这一帧后面的生物都不更新，下一帧又一样，整个背景定住
        try { this.updateEnt(e, sec, now); this.stuckCheck(e, x0, now); } catch (err) {
          e.dead = true;
          this.entErrors = (this.entErrors || 0) + 1;
          if (this.entErrors === 1) console.error(`[scene] 生物 ${e.kind}（${e.state}）更新出错，去掉了它`, err);
        }
        this.lifeGuard(e, now);
      }
      // 离视野太远的生物去掉（视角移走以后）
      const mid = this.cam.x + this.W / 2;
      const midY = this.cam.y + this.H / 2;
      const n0 = this.ents.length;
      this.ents = this.ents.filter((e) => !e.dead && (e.event || (Math.abs(e.x - mid) < this.W * 2.5 && Math.abs(e.y - midY) < this.H * 2.5)));
      if (this.ents.length !== n0) this.dropStale();
      this.fightTick(sec, now);
      for (const fn of A.sceneKit.tick) fn.call(this, sec, now); // 别的模块每帧要更新的（环境互动、终极彩蛋）
      for (const p of this.parts) {
        // drag：阻力，速度逐渐变慢；sway：左右摆动（花瓣、落叶、雪花），见 sceneburst.js
        if (p.drag) { const k = Math.max(0, 1 - p.drag * sec); p.vx *= k; p.vy *= k; }
        p.x += p.vx * sec; p.y += p.vy * sec; p.vy += (p.g || 0) * sec; p.life -= dt;
        if (p.sway) p.x += Math.sin(now / 380 + (p.ph || 0)) * p.sway * sec;
      }
      this.parts = this.parts.filter((p) => p.life > 0 && p.y < (p.weather || p.star || p.screen ? this.H + 4 : this.cam.y + this.H + 8));
      this.weather(sec);
      // 树苗生长
      for (const tr of this.trees) if (!tr.alive && now > tr.regrow) { tr.alive = true; tr.grow = 0.2; tr.hp = 6; tr.target = false; }
      for (const tr of this.trees) if (tr.alive && tr.grow < 1) tr.grow = Math.min(1, tr.grow + sec * 0.05);
    },

    updateEnt(e, sec, now) {
      const r = this.rnd;
      // 玩家点燃的苦力怕一定会炸（天亮了也不会先消失）
      if (e.clickFuse && e.creeperFuse) { e.alpha = Math.min(1, e.alpha + sec * 1.5); e.fade = false; if (now > e.creeperFuse) this.explode(e, now); return; }
      // 正在消失的只变淡、不再变浓（rc15：以前先「淡入」+1.5 再「淡出」−1.2，一帧下来反而变浓，停在 96% 永远消失不掉，
      // 也不再动；活到寿命的生物全卡在原地、占满数量上限不再刷新，主页一两分钟后所有生物都定住）
      if (e.fade) { e.alpha -= sec * 1.2; if (e.alpha <= 0) e.dead = true; return; }
      e.alpha = Math.min(1, e.alpha + sec * 1.5);
      if (now - e.born > e.life && e.state !== 'work') e.fade = true;
      if (e.boat) return; // 船在绘制时沿水面移动
      if (e.hurt && now > e.hurt) e.hurt = 0;
      // 白天敌对生物燃烧消失
      // 下雨时不着火、不消失（和游戏一样），雨停了再说；雷雨天暗得和晚上差不多（sceneweather.js）
      if (e.spr.hostile && this.dim === 'over' && !this.isNight() && !this.wetSky() && !this.stormDark() && !e.burning && e.kind !== 'drowned' && !e.cave && !e.spr.swims) {
        if (e.spr.burns || e.kind === 'zombie') { e.burning = now + 3000; }
        else e.fade = true;
      }
      if (e.burning) {
        if (r() < 0.4) this.parts.push({ x: e.x + r() * 3, y: e.y - r() * e.spr.h, vx: 0, vy: -6, life: 500, c: r() < 0.5 ? [255, 160, 40] : [255, 90, 30], glow: true });
        if (now > e.burning) { this.puff(e.x + 1, e.y - 3, [90, 90, 90], 8); e.dead = true; }
      }
      // 洞穴里的生物（scenecave.js）：沿着洞底走、蝙蝠乱飞，不和地面上的玩家打
      if (e.cave) { this.caveTick(e, sec, now); return; }
      // 敌对生物和玩家打斗（scenefight.js），处理了就不再闲逛
      if (this.fight(e, sec, now)) return;
      if (e.creeperFuse) {
        if (now > e.creeperFuse) this.explode(e, now);
        return;
      }
      const spd = { player: 5, villager: 3, zombie: 3, husk: 3, drowned: 2.5, stray: 3.5, skeleton: 3.5, creeper: 2.5, spider: 6, enderman: 4, endermite: 3, chicken: 2.5, rabbit: 6, rabbitW: 6, pig: 2.5, cow: 2, mooshroom: 2, sheep: 2, wolf: 5, fox: 6, foxW: 6, polar: 2.5, camel: 3, piglin: 3, zpiglin: 2.5, strider: 2, magma: 3, turtle: 1, squid: 2, glowSquid: 2, cod: 4, salmon: 4.5, tropical: 4, pufferfish: 2, guardian: 3, elderGuardian: 1.5, dolphin: 9, bee: 6, blaze: 2, ghast: 2, phantom: 22, parrot: 7, parrotBlue: 7, parrotGreen: 7, ocelot: 6.5, panda: 1.5, shulker: 0 , goat: 3 }[e.kind] ?? 3;
      if (e.state === 'goto') {
        const d = e.goal - e.x;
        e.dir = d > 0 ? 1 : -1;
        e.moving = true;
        e.x += e.dir * spd * sec;
        this.follow(e);
        if (Math.abs(d) < 1) { e.state = 'work'; e.swing = 0; e.moving = false; e.workT = now; e.dir = e.task.type === 'chop' ? (e.task.tree.col * this.B > e.x ? 1 : -1) : e.task.type === 'build' ? ((e.task.build.col + (e.task.build.w || 3) / 2) * this.B > e.x ? 1 : -1) : 1; }
        return;
      }
      if (e.state === 'work') { this.work(e, sec, now); return; }
      if (e.night) this.torchTick(e, sec, now);
      if (e.state === 'goto') return;
      if (now > e.until) {
        if (e.state === 'idle' || e.state === 'walk') {
          const walk = r() < 0.65;
          e.state = walk ? 'walk' : 'idle';
          if (walk && r() < 0.5) e.dir *= -1;
          e.until = now + (walk ? 1500 + r() * 4000 : 1000 + r() * 3500);
          // 走回小屋
          const house = this.houses[0];
          if (e.kind === 'player' && house && r() < 0.25 && this.opts.buildings) { e.state = 'home'; }
        }
      }
      e.moving = e.state === 'walk' || e.state === 'home';
      if (e.state === 'home') {
        const hx = (this.houses[0].col + (this.houses[0].dc || 1)) * this.B + 1;
        e.dir = hx > e.x ? 1 : -1;
        e.x += e.dir * spd * sec;
        this.follow(e);
        if (Math.abs(hx - e.x) < 1) { this.houses[0].door = now + 1600; e.dead = true; }
        return;
      }
      if (e.spr.fly) {
        e.x += e.dir * spd * sec * (e.moving ? 1 : 0.3);
        e.y += Math.sin(now / 600 + e.born) * sec * 2;
        if (e.kind === 'phantom') e.y += Math.sin(now / 300) * sec * 10;
        if (e.x < this.cam.x - this.W * 0.5 || e.x > this.cam.x + this.W * 1.5) e.dead = true;
        if (e.kind === 'ghast' && r() < sec * 0.08) this.fireball(e);
        return;
      }
      if (e.spr.swims) { this.swimTick(e, sec, now, spd); return; } // 游泳、鱼群、海豚跃出水面（sceneocean.js）
      if (e.spr.hops && e.moving) {
        e.hop = (e.hop || 0) + sec;
        if (e.hop > 0.8) { e.hop = 0; e.jumpT = now; }
      }
      if (e.moving) {
        const nx = e.x + e.dir * spd * sec;
        const cur = this.groundY(e.x);
        const next = this.groundY(nx + (e.dir > 0 ? e.spr.w : 0));
        // 山羊能跳上两格多高的坎，但只在雪山的高处转悠
        const climb = e.kind === 'goat' ? this.B * 2.5 : this.B;
        const blocked = next == null || Math.abs(next - cur) > climb || (e.kind === 'goat' && !this.alpineAt(nx)) || (e.kind !== 'strider' && e.kind !== 'turtle' && this.isWaterCol(nx + (e.dir > 0 ? e.spr.w : 0)))
          || (e.kind === 'strider' && !this.isWaterCol(nx)) || (this.houseAt(nx) && !this.houseAt(e.x)) || !this.loadedAt(nx)
          || (e.home && (nx < e.home[0] || nx > e.home[1])) // 掠夺者、卫道士只在前哨站 / 府邸附近转悠
          || (this.surfLavaAt && this.surfLavaAt(nx + (e.dir > 0 ? e.spr.w : 0))); // 不走进地表岩浆湖（rc4）
        if (blocked) { e.dir *= -1; e.state = 'idle'; } else {
          if (e.kind === 'goat' && Math.abs(next - cur) > this.B * 0.6 && !(e.jumpT && now - e.jumpT < 400)) e.jumpT = now;
          e.x = nx; this.follow(e);
        }
      }
      // 末影人偶尔瞬移
      if (e.kind === 'enderman' && r() < sec * 0.03) this.teleport(e);
    },

    /**
     * 卡住的生物（rc4，试用时看到生物在原地一动不动）：想走的生物 20 秒都没挪过地方（两边都被挡住、窄水塘里转不过身），
     * 就像原版那样慢慢消失，别一直杵在那里。打斗中、干活、特殊事件、船、飞的不算
     */
    stuckCheck(e, x0, now) {
      if (e.dead || e.fade || e.event || e.boat || e.ending || e.creeperFuse || e.clickFuse) { e.movedAt = now; return; }
      // 站着干活、打架、盯着猎物的本来就可以不动；但它要是「迈着步子」却 20 秒没挪地方，一样是卡住了（rc14：以前这几种一律不算，
      // 盯着一个已经不在的目标的怪会一直原地走下去）
      if (!e.moving && (e.state === 'work' || e.state === 'fight' || e.prey)) { e.movedAt = now; e.movedX = e.x; return; }
      if (e.movedAt == null || Math.abs(e.x - (e.movedX ?? e.x)) > 0.5) { e.movedAt = now; e.movedX = e.x; return; }
      if (now - e.movedAt > 20000) e.fade = true;
    },

    /**
     * 兜底（rc15）：「正在消失」是个结束的状态，正常 1 秒内就没了；5 秒还没消失说明消失的逻辑又坏了，直接去掉，
     * 别让它一直占着数量上限（v1.2.2 起淡入淡出写反，挂机几分钟所有生物定住，存在了快一个月才发现）。
     * lifeFixes 记兜底兜了几次：测试要求它一直是 0，兜底只保护玩家，不替代修 bug
     */
    lifeGuard(e, now) {
      if (!e.fade || e.dead) { e.fadeAt = 0; return; }
      if (!e.fadeAt) { e.fadeAt = now; return; }
      if (now - e.fadeAt > 5000) {
        e.dead = true;
        this.lifeFixes = (this.lifeFixes || 0) + 1;
        if (this.lifeFixes === 1) console.warn(`[scene] 生物 ${e.kind} 「正在消失」超过 5 秒还没消失，直接去掉（消失的逻辑可能又坏了）`);
      }
    },

    /**
     * 去掉了的生物（走远了、死了、拉窗口时不在画面里）：别的生物不要再盯着它、跟着它（rc14）。
     * 以前留着这些引用，怪会一直去追一个已经不在场景里的玩家，跟随的鱼跟着一条看不见的鱼原地游
     */
    dropStale() {
      const live = new Set(this.ents);
      for (const e of this.ents) {
        if (e.prey && !live.has(e.prey)) e.prey = null;
        if (e.leader && !live.has(e.leader)) e.leader = null;
        if (e.ignore && !live.has(e.ignore)) e.ignore = null;
      }
    },

    houseAt(x) {
      return this.houses.some((h) => x > h.col * this.B + 2 && x < (h.col + (h.w || 5)) * this.B - 2);
    },

    follow(e) {
      if (e.kind === 'strider') { e.y = this.sea * this.B; return; }
      const gy = this.groundY(e.x + 1);
      if (gy != null) e.y += (gy - e.y) * 0.5;
    },

    work(e, sec, now) {
      const task = e.task;
      e.swing = (e.swing || 0) + sec;
      if (task.type === 'chop') {
        const tr = task.tree;
        if (!tr.alive) { e.state = 'walk'; e.task = null; e.until = now + 4000; return; }
        if (e.swing > 0.45) {
          e.swing = 0;
          e.hits = (e.hits || 0) + 1;
          const wood = this.treeWood(tr);
          for (let k = 0; k < 3; k++) this.parts.push({ x: tr.col * this.B + 2, y: (tr.top - 1) * this.B, vx: (this.rnd() - 0.5) * 20, vy: -15 - this.rnd() * 10, g: 60, life: 600, c: this.tint(pick(wood, this.rnd())) });
          if (e.hits >= 8) {
            // 树被砍倒
            tr.alive = false;
            tr.regrow = now + 40000 + this.rnd() * 30000;
            const leaves = this.treeLeaves(tr);
            for (let k = 0; k < 24; k++) this.parts.push({ x: tr.col * this.B + (this.rnd() - 0.5) * 12, y: (tr.top - tr.trunk) * this.B + this.rnd() * 10, vx: (this.rnd() - 0.5) * 30, vy: -10 - this.rnd() * 20, g: 70, life: 900, c: this.tint(pick(leaves, this.rnd())) });
            e.carry = now + 2500;
            e.task = null;
            e.state = 'walk';
            e.dir *= -1;
            e.until = now + 5000;
          }
        }
        return;
      }
      if (task.type === 'torch') { this.placeTorch(e, now); return; }
      if (task.type === 'build') {
        const b = task.build;
        if (e.swing > 0.7) {
          e.swing = 0;
          const next = b.plan[b.blocks.length];
          if (!next) { e.task = null; e.state = 'walk'; e.dir = -1; e.until = now + 5000; return; }
          // 宽的建筑（小木屋、两层小楼、城门……）：站到建筑正前面的中间去盖（画面上玩家在建筑前面），两边都够得着；
          // 1.7.0 是左半边站左边、右半边站右边，每层来回跑，大建筑半天盖不完
          const w = b.w || 3;
          const spot = w > 3 ? Math.round((b.col + w / 2 - 0.5) * this.B) : (b.col - 1) * this.B;
          if (Math.abs(spot - e.x) > 2) { e.state = 'goto'; e.goal = spot; return; }
          const bl = { x: next[0], y: next[1], m: next[2], k: next[3], t: now };
          b.blocks.push(bl);
          this.puff((b.col + next[0]) * this.B + 2, (b.top - next[1] - 1) * this.B + 2, this.buildPuffColor(b, bl), 4);
        }
      }
    },

    treeLeaves(tr) {
      return { oak: M.leaves, birch: M.birchLeaves, spruce: M.spruceLeaves, cherry: M.cherry, darkOak: M.darkLeaves, jungle: M.jungleLeaves, jungleBush: M.jungleLeaves }[tr.kind] || M.leaves;
    },

    treeWood(tr) {
      return { birch: M.birch, spruce: M.spruce, cherry: M.cherryLog, darkOak: M.darkLog, jungle: M.jungleLog, jungleBush: M.jungleLog }[tr.kind] || M.log;
    },

    // ───────────── 彩蛋与事件 ─────────────
  });
})();
