'use strict';
/**
 * 主页动态背景的天气（rc3）：晴天 / 下雨 / 雷雨，雪原下的是雪，沙漠、下界、末地不下雨。
 * 规则照游戏：晴 → 雨（或雷雨）→ 晴轮流，每段持续一段随机的时间，雨是慢慢下大、慢慢停的。
 * 但玩家在启动器里待的时间不长，节奏比游戏快（rc3）：打开时 20% 在下雨、8% 是雷雨；
 * 雨（雷雨）下 3~6 分钟放晴，晴天一般持续 15~25 分钟。
 * 场景胶囊里可以强制成某种天气：强制以后不再变，换场景时（或重开启动器）重新按概率算。
 * 下雨时不死生物白天不会着火（和游戏一样）；雷雨天黑，白天也会刷怪物。
 * 声音从玩家装好的游戏里读（雨声、雷声），没装游戏时用启动器合成的（gamesound.js），跟着音效开关和音量走
 */
(function () {
  const { tick, shade } = A.sceneKit;
  const MIN = 60000;
  const CHANCE = { thunder: 0.08, rain: 0.2 }; // 打开时（换场景时）
  const DUR = { clear: [15 * MIN, 25 * MIN], rain: [3 * MIN, 6 * MIN], thunder: [3 * MIN, 6 * MIN] };
  const between = ([a, b]) => a + Math.random() * (b - a);

  /** 这个场景会下什么：'rain' / 'snow' / null（不下） */
  function precipOf(scene) {
    const S = scene.S;
    if (!S || scene.dim !== 'over') return null;
    if (S.warm || S.precip === false) return null;
    return S.precip || 'rain';
  }

  Object.assign(A.Scene.prototype, {
    precip() { return precipOf(this); },

    /** 换了场景（或第一次）：按概率重新算；同一个场景里重建世界（改窗口大小、换时段）天气不变 */
    weatherInit() {
      const can = !!precipOf(this);
      const r = Math.random();
      const kind = !can ? 'clear' : r < CHANCE.thunder ? 'thunder' : r < CHANCE.thunder + CHANCE.rain ? 'rain' : 'clear';
      const on = kind === 'clear' ? 0 : 1;
      this.wx = { scene: this.sceneId, kind, forced: false, until: Date.now() + between(DUR[kind]), level: on, storm: kind === 'thunder' ? 1 : 0, nextBolt: 0, nextRain: 0, bolts: [], flash: 0 };
    },

    /** 场景胶囊：'auto' 回到自动（从现在起重新计时），'clear' / 'rain' / 'thunder' 强制 */
    setWeather(kind) {
      if (!this.wx || this.wx.scene !== this.sceneId) this.weatherInit();
      const w = this.wx;
      if (kind === 'auto') { w.forced = false; w.until = Date.now() + between(DUR[w.kind]); }
      else if (DUR[kind]) {
        if (kind !== 'clear' && !precipOf(this)) return;
        w.kind = kind; w.forced = true;
        if (kind === 'thunder') w.nextBolt = performance.now() + 1500;
      }
      if (this.frozen && !this.running && this.W) { w.level = w.kind === 'clear' ? 0 : 1; w.storm = w.kind === 'thunder' ? 1 : 0; this.draw(16); }
      A.emit('sceneWeather', this.weatherInfo());
    },

    weatherInfo() {
      // 刚换了场景还没画第一帧时（骰子、选场景），先按新场景算好天气再报：以前报的是上一个场景的，
      // 骰子摇到正在下雨的地方，胶囊上却写着「现在：晴天」（rc4 试用）
      if (this.sceneId && (!this.wx || this.wx.scene !== this.sceneId)) this.weatherInit();
      const w = this.wx;
      const p = precipOf(this);
      return { kind: w ? w.kind : 'clear', forced: !!(w && w.forced), precip: p, can: !!p, until: w ? w.until : 0 };
    },

    /** 天上在下雨（不是雪）：不死生物白天不着火 */
    wetSky() { const w = this.wx; return !!w && w.level > 0.5 && precipOf(this) === 'rain'; },
    /** 雷雨天暗下来了：白天也刷怪物 */
    stormDark() { const w = this.wx; return !!w && w.storm > 0.6; },

    weatherTick(sec, now) {
      if (!this.wx || this.wx.scene !== this.sceneId) this.weatherInit();
      const w = this.wx;
      const can = !!precipOf(this);
      if (!can && w.kind !== 'clear') { w.kind = 'clear'; w.forced = false; }
      // 换天气
      if (!w.forced && Date.now() > w.until) {
        w.kind = w.kind !== 'clear' || !can ? 'clear' : Math.random() < CHANCE.thunder / (CHANCE.thunder + CHANCE.rain) ? 'thunder' : 'rain';
        w.until = Date.now() + between(DUR[w.kind]);
        if (w.kind === 'thunder') w.nextBolt = now + 4000;
        A.emit('sceneWeather', this.weatherInfo());
      }
      // 雨慢慢下大、慢慢停（游戏里也是渐变的，大约 8 秒）
      const k = Math.min(1, sec / 8);
      w.level += ((w.kind === 'clear' ? 0 : 1) - w.level) * k * 3;
      w.storm += ((w.kind === 'thunder' ? 1 : 0) - w.storm) * k * 3;
      if (w.level < 0.002) w.level = 0;
      if (w.storm < 0.002) w.storm = 0;
      if (!w.level) { w.bolts = []; w.flash = 0; return; }
      // 视角整个在地下时不下（地表在画面上面），声音也闷一点
      const surf = this.groundY(this.cam.x + this.W / 2);
      const under = surf != null && surf + 8 < this.cam.y;
      if (precipOf(this) === 'rain' && !under) this.rainDrops(sec, w.level);
      this.rainLand();
      this.rainSound(now, w.level, under);
      if (w.storm > 0.5) this.lightning(now, under);
      w.bolts = w.bolts.filter((b) => now - b.at < b.life);
      w.flash = Math.max(0, w.flash - sec * 4);
    },

    /** 雨点：屏幕坐标，斜着往下落，多少跟着画面宽度和特效档位 */
    rainDrops(sec, level) {
      if (this.parts.length > 1400) return;
      const n = 150 * level * (this.W / 240) * (0.3 + 0.7 * this.fxK) * sec;
      let m = Math.floor(n) + (this.rnd() < n % 1 ? 1 : 0);
      while (m-- > 0) {
        this.parts.push({ x: this.rnd() * (this.W + 40) - 10, y: -4 - this.rnd() * 12, vx: -14 - this.rnd() * 6, vy: 150 + this.rnd() * 50, life: 6000, c: [175, 195, 235], weather: true, rain: true });
      }
    },

    /** 落到地面（或水面）的雨点溅一下就没了 */
    rainLand() {
      const lx = this.landX || 0; const ly = this.landY || 0;
      for (const p of this.parts) {
        if (!p.rain || p.life <= 0) continue;
        const gy = this.groundY(p.x - lx);
        if (gy == null || p.y - ly < gy) continue;
        p.life = 0;
        if (this.rnd() < 0.25 * this.fxK) this.parts.push({ x: p.x, y: gy + ly - 1, vx: (this.rnd() - 0.5) * 10, vy: -10, g: 60, life: 180, c: [200, 215, 245], screen: true });
      }
    },

    /** 雨声：一段接一段地放游戏里的雨声（每段一两秒），读不到就放合成的；画面不动（主页没显示）时自然就停了 */
    rainSound(now, level, under) {
      const w = this.wx;
      if (precipOf(this) !== 'rain' || !A.gameSound || !this.running) return;
      if (now < w.nextRain) return;
      w.nextRain = now + 900; // 先占着，等读到声音再按长度排下一段
      const vol = 0.32 * level * (under ? 0.35 : 1) * (w.kind === 'thunder' ? 1.15 : 1);
      A.gameSound.play('weather.rain', { volume: vol, pitch: 0.92 + this.rnd() * 0.16, alt: 'ambient.weather.rain', synth: 'aurora.rain', ambient: true })
        .then((s) => { w.nextRain = performance.now() + (s && s.duration ? Math.max(0.5, s.duration * 0.72) * 1000 : 1100); })
        .catch(() => {});
    },

    /** 闪电：雷雨天每 5~18 秒一道，落在画面里随便哪里；雷声按远近晚一会儿到 */
    lightning(now, under) {
      const w = this.wx;
      if (!w.nextBolt) w.nextBolt = now + 3000 + this.rnd() * 6000;
      if (now < w.nextBolt) return;
      w.nextBolt = now + 5000 + this.rnd() * 13000;
      const far = this.rnd();
      const visible = !under && far < 0.75;
      if (visible) {
        const lx = this.landX || 0; const ly = this.landY || 0;
        const x0 = Math.round(this.W * (0.08 + this.rnd() * 0.84));
        const g = this.groundY(x0 - lx);
        const gy = g == null ? this.H * 0.75 : Math.min(this.H, g + ly);
        const pts = [[x0 + Math.round((this.rnd() - 0.5) * 10), -2]];
        let x = pts[0][0]; let y = -2;
        while (y < gy) { y = Math.min(gy, y + 3 + Math.floor(this.rnd() * 5)); x += Math.round((this.rnd() - 0.5) * 6); pts.push([x, y]); }
        const branch = pts.length > 6 && this.rnd() < 0.6 ? (() => {
          const i = 2 + Math.floor(this.rnd() * (pts.length / 2));
          let [bx, by] = pts[i]; const dir = this.rnd() < 0.5 ? -1 : 1; const out = [[bx, by]];
          for (let j = 0; j < 4 + Math.floor(this.rnd() * 4); j++) { by += 3 + Math.floor(this.rnd() * 3); bx += dir * (1 + Math.floor(this.rnd() * 3)); out.push([bx, by]); }
          return out;
        })() : null;
        w.bolts.push({ pts, branch, at: now, life: 380 });
        w.struck = (w.struck || 0) + 1;
        if (!this.noFlash) w.flash = 1 - far * 0.6;
      } else if (!this.noFlash && !under) w.flash = 0.35;
      if (!A.gameSound || !this.running) return;
      const delay = visible ? 150 + far * 1800 : 1500 + this.rnd() * 1500;
      setTimeout(() => {
        if (!this.running) return;
        A.gameSound.play('entity.lightning_bolt.thunder', { volume: (under ? 0.3 : 0.75) * (1 - far * 0.45), pitch: 0.8 + this.rnd() * 0.2, alt: 'ambient.weather.thunder', synth: 'aurora.thunder', ambient: true }).catch(() => {});
        if (visible && far < 0.25) A.gameSound.play('entity.lightning_bolt.impact', { volume: 0.4, pitch: 0.5 + this.rnd() * 0.2, ambient: true }).catch(() => {});
      }, delay);
    },
  });

  tick.push(function (sec, now) { if (this.W) this.weatherTick(sec, now); });

  // 天色变暗（盖在地形、生物和水上，雨点画在它上面），再画闪电和闪光
  shade.push(function (lx, ly, now) {
    const w = this.wx;
    if (!w || !w.level) return;
    const ctx = this.ctx;
    const snow = precipOf(this) === 'snow';
    const a = (w.level * (snow ? 0.16 : 0.26) + w.storm * 0.16) * (this.isNight() ? 0.55 : 1);
    ctx.fillStyle = snow ? `rgba(150,158,172,${a})` : `rgba(38,46,60,${a})`;
    ctx.fillRect(0, 0, this.W, this.H);
    if (w.flash > 0) { ctx.fillStyle = `rgba(235,240,255,${w.flash * 0.28})`; ctx.fillRect(0, 0, this.W, this.H); }
    for (const b of w.bolts) {
      const t = (now - b.at) / b.life;
      // 闪两下再淡掉；减少闪烁时不闪，直接慢慢淡掉
      const alpha = this.noFlash ? 1 - t : t < 0.25 ? 1 : t < 0.4 ? 0.25 : t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      if (alpha <= 0) continue;
      const line = (pts, c, wd) => {
        ctx.fillStyle = c;
        for (let i = 1; i < pts.length; i++) {
          const [x1, y1] = pts[i - 1]; const [x2, y2] = pts[i];
          const steps = Math.max(1, Math.abs(y2 - y1));
          for (let s = 0; s <= steps; s++) ctx.fillRect(Math.round(x1 + ((x2 - x1) * s) / steps), Math.round(y1 + ((y2 - y1) * s) / steps), wd, 1);
        }
      };
      line(b.pts, `rgba(170,190,255,${alpha * 0.45})`, 3);
      line(b.pts, `rgba(250,252,255,${alpha})`, 1);
      if (b.branch) line(b.branch, `rgba(235,240,255,${alpha * 0.8})`, 1);
    }
  });

  // 场景停下（主页隐藏、换背景）时，排着的下一段雨声不用再管：rainSound 看 this.running
  A.sceneKit.precipOf = precipOf;
})();
