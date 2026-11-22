'use strict';
/**
 * 主页背景的原版音效（1.5.16）：A.gameSound.play('block.amethyst_block.chime')
 * 声音从玩家已经装好的游戏资源里读（sys:gameSound，启动器不打包 Mojang 的声音）；
 * 读不到时用 fallback 合成一个近似的（只有紫水晶这类简单的声音有），其余不出声。
 * 音效有自己的开关和音量（rc3：顶栏音乐旁边、设置「常规 → 声音」里都能开关；以前跟着背景音乐的音量走），
 * 静音的规矩和背景音乐一样：关掉就不响，玩游戏的时候一律不响（2.0.0-pre4：主页背景里小人打怪的声音不能盖在游戏上面）。
 * 所有声音都接到一个总音量节点上，开关、调音量马上对正在响的（比如雨声）生效。
 * 终末之诗的通关音乐（opts.music）算音乐：跟背景音乐的音量走，不受音效开关管
 */
(function () {
  const { api, state, on } = A;
  let ctx = null;
  const buffers = new Map(); // 声音文件名 → AudioBuffer（同一事件有几个变体，读到哪个记哪个）
  const missing = new Set(); // 读不到的事件，不再问
  const pending = new Map();
  let lastAt = 0;
  const inGame = () => !!A.tasks && A.tasks.gameActive();

  let soundBus = null; // 音效的总音量
  let musicBus = null; // 通关音乐（跟背景音乐的音量）
  const clamp01 = (v, d) => Math.max(0, Math.min(1, v ?? d));
  const soundCfg = () => (state.config && state.config.sound) || {};
  /** 音效开着没有：关掉、性能模式（和背景音乐一样，性能模式不放）都不响 */
  const soundOn = () => soundCfg().enabled !== false && !(A.perf && A.perf.on());
  const soundGain = () => (soundOn() ? clamp01(soundCfg().volume, 0.45) * 1.4 : 0);
  const musicGain = () => clamp01(((state.config && state.config.music) || {}).volume, 0.45) * 1.4;

  const ensure = () => {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      soundBus = ctx.createGain(); soundBus.gain.value = soundGain(); soundBus.connect(ctx.destination);
      musicBus = ctx.createGain(); musicBus.gain.value = musicGain(); musicBus.connect(ctx.destination);
    }
    if (ctx.state === 'suspended' && !inGame()) ctx.resume().catch(() => {});
    return ctx;
  };
  const bus = () => { ensure(); return soundBus; };
  /** 设置变了：总音量马上跟着变（0.15 秒滑过去，不咔哒一下） */
  function syncGain() {
    if (!ctx) return;
    const t = ctx.currentTime;
    soundBus.gain.setTargetAtTime(soundGain(), t, 0.05);
    musicBus.gain.setTargetAtTime(musicGain(), t, 0.05);
  }
  on('config', syncGain);

  async function load(event) {
    if (missing.has(event) || event.startsWith('aurora.')) return null; // aurora.* 是启动器自己合成的，不去游戏里找
    if (pending.has(event)) return pending.get(event);
    const p = (async () => {
      const r = await api('sys:gameSound', event).catch(() => null);
      if (!r || !r.data) { missing.add(event); return null; }
      if (buffers.has(r.name)) return { buf: buffers.get(r.name), r };
      const bin = atob(r.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const buf = await ensure().decodeAudioData(bytes.buffer).catch(() => null);
      if (!buf) { missing.add(event); return null; }
      buffers.set(r.name, buf);
      return { buf, r };
    })();
    pending.set(event, p);
    try { return await p; } finally { pending.delete(event); }
  }

  /** 合成的替代声音：partials = [[频率, 衰减秒数, 音量]] */
  function synth(partials, vol) {
    const c = ensure();
    const t = c.currentTime;
    for (const [f, d, v] of partials) {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v * vol), t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(bus());
      o.start(t); o.stop(t + d + 0.05);
    }
  }

  /** 合成的爆炸（没装游戏、读不到原版声音时用）：一记往下掉的低频闷响 + 滤波噪声，0.1 秒内起来，一秒多散掉 */
  function boom(vol) {
    const c = ensure();
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 1.6);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.2;
    const src = c.createBufferSource();
    src.buffer = buf;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 1.2);
    const g = c.createGain();
    g.gain.setValueAtTime(Math.min(1.2, vol * 0.9), t);
    src.connect(lp).connect(g).connect(bus());
    src.start(t);
    const o = c.createOscillator();
    const og = c.createGain();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.6);
    og.gain.setValueAtTime(Math.min(1.2, vol * 0.8), t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(og).connect(bus());
    o.start(t);
    o.stop(t + 1);
  }
  /** 合成的引信嘶嘶声（苦力怕被点燃，1.6.2）：带通的噪声，偶尔噼啪一下，一秒半里慢慢变响再收掉 */
  function hiss(vol) {
    const c = ensure();
    const t = c.currentTime;
    const dur = 1.5;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.002 ? 3 : 1);
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, t);
    bp.frequency.linearRampToValueAtTime(3200, t + dur);
    bp.Q.value = 0.7;
    const g = c.createGain();
    const v = Math.min(0.9, vol * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v * 0.6, t + 0.06);
    g.gain.linearRampToValueAtTime(v, t + dur - 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(bus());
    src.start(t);
  }
  /** 合成的受伤声（1.7.0，怪物挨打）：一声很短、往下掉的闷哼 */
  function hurt(vol) {
    const c = ensure();
    const t = c.currentTime;
    const o = c.createOscillator(); const g = c.createGain(); const lp = c.createBiquadFilter();
    o.type = 'square';
    const f = 230 + Math.random() * 80;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.16);
    lp.type = 'lowpass'; lp.frequency.value = 900;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.min(0.6, vol * 0.35), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(lp).connect(g).connect(bus());
    o.start(t); o.stop(t + 0.25);
  }
  /** 合成的火球呼啸（1.7.0，恶魂吐火球）：扫频的噪声 + 一点低音，半秒 */
  function whoosh(vol) {
    const c = ensure();
    const t = c.currentTime;
    const dur = 0.6;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(380, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + 0.2);
    bp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.min(0.9, vol * 0.7), t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(bus());
    src.start(t);
    const o = c.createOscillator(); const og = c.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.35);
    og.gain.setValueAtTime(Math.min(0.6, vol * 0.4), t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(og).connect(bus());
    o.start(t); o.stop(t + 0.45);
  }
  /** 合成的「友好生物叫一声」（1.7.2，读不到原版声音时用）：两声往上滑的短音 */
  function chirp(vol) {
    const c = ensure();
    const t = c.currentTime;
    const f = 520 + Math.random() * 260;
    for (const [d, k] of [[0, 1], [0.09, 1.25]]) {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f * k, t + d);
      o.frequency.exponentialRampToValueAtTime(f * k * 1.3, t + d + 0.07);
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(Math.min(0.5, vol * 0.25), t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.09);
      o.connect(g).connect(bus());
      o.start(t + d); o.stop(t + d + 0.12);
    }
  }
  /** 合成的敲方块声（1.7.3，没装游戏时用）：很短的一下滤波噪声，石头脆、木头闷、草和雪软、玻璃亮 */
  const KNOCK = { stone: [1900, 4, 1], wood: [700, 6, 1.1], grass: [2600, 1.2, 0.5], gravel: [1500, 1.5, 0.8], sand: [2800, 1, 0.5], snow: [3200, 1, 0.4], glass: [4200, 8, 0.9], wool: [500, 1, 0.4], metal: [3000, 12, 0.9] };
  const KNOCK_LIKE = { cherry_wood: 'wood', stem: 'wood', soul_sand: 'sand', soul_soil: 'gravel', moss: 'grass', cherry_leaves: 'grass', amethyst_block: 'glass', wart_block: 'wool', shroomlight: 'wool' };
  function knock(vol, opts = {}) {
    const [f, q, k] = KNOCK[opts.knock] || KNOCK[KNOCK_LIKE[opts.knock]] || KNOCK.stone;
    const c = ensure();
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.08);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f * (0.9 + Math.random() * 0.2); bp.Q.value = q;
    const g = c.createGain();
    g.gain.value = Math.min(1, vol * 0.9 * k);
    src.connect(bp).connect(g).connect(bus());
    src.start(t);
  }
  /** 合成的雨声（rc3，没装游戏时用）：一段一秒半的「沙沙」声，前后淡入淡出，一段接一段地放就连成一片 */
  function rain(vol) {
    const c = ensure();
    const t = c.currentTime;
    const dur = 1.6;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = last * 0.55 + w * 0.45; d[i] = last + (Math.random() < 0.003 ? (Math.random() - 0.5) * 2.5 : 0); }
    const src = c.createBufferSource();
    src.buffer = buf;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
    const g = c.createGain();
    const v = Math.min(0.8, vol * 0.55);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.35);
    g.gain.setValueAtTime(v, t + dur - 0.45);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(hp).connect(lp).connect(g).connect(bus());
    src.start(t);
  }
  /** 合成的雷声（rc3，没装游戏时用）：开头「咔」的一下，接着三四秒往下沉的隆隆声 */
  function thunder(vol) {
    const c = ensure();
    const t = c.currentTime;
    const dur = 4.2;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 14 * (0.6 + 0.4 * Math.sin(i / c.sampleRate * 9 + Math.sin(i / c.sampleRate * 2.3) * 3)); }
    const src = c.createBufferSource();
    src.buffer = buf;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(140, t + 1.6);
    const g = c.createGain();
    const v = Math.min(1.2, vol * 1.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.06);
    g.gain.setTargetAtTime(v * 0.5, t + 0.4, 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(bus());
    src.start(t);
    // 开头的一声脆响
    const clen = Math.floor(c.sampleRate * 0.18);
    const cb = c.createBuffer(1, clen, c.sampleRate);
    const cd = cb.getChannelData(0);
    for (let i = 0; i < clen; i++) cd[i] = (Math.random() * 2 - 1) * (1 - i / clen) ** 2;
    const cs = c.createBufferSource(); cs.buffer = cb;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const cg = c.createGain(); cg.gain.value = Math.min(0.7, vol * 0.5);
    cs.connect(hp).connect(cg).connect(bus());
    cs.start(t);
  }
  const FALLBACK_FN = { 'aurora.rain': rain, 'aurora.thunder': thunder, 'aurora.knock': knock, 'aurora.friendly': chirp, 'entity.generic.explode': boom, 'entity.creeper.primed': hiss, 'entity.generic.hurt': hurt, 'entity.generic.death': hurt, 'entity.ghast.shoot': whoosh };

  const FALLBACK = {
    'block.amethyst_block.chime': () => { const b = 1200 + Math.random() * 900; return [[b, 1.4, 0.18], [b * 2.76, 0.7, 0.07], [b * 5.4, 0.35, 0.03]]; },
    'block.amethyst_cluster.hit': () => { const b = 1600 + Math.random() * 600; return [[b, 0.6, 0.15], [b * 2.4, 0.3, 0.05]]; },
    'entity.experience_orb.pickup': () => { const b = 900 + Math.random() * 500; return [[b, 0.25, 0.12], [b * 1.5, 0.2, 0.06]]; },
  };

  /**
   * 播放一个原版声音事件。opts：volume（0~1，再乘音效音量）、pitch（播放速度）、loop（返回可以 stop() 的对象）
   * alt：游戏里没有这个事件时改用的另一个（比如某种怪物没有专门的受伤声，就用通用的）；synth：两个都读不到时用哪个合成的
   * music：算音乐（终末之诗的通关音乐），跟背景音乐的音量、不受音效开关管
   * 音效关着时只响的一下直接不放；loop 的照样开始（音量是 0），之后打开音效马上就能听到。
   * ambient：一段接一段放的环境声（雨声、雷声，sceneweather.js），不受「25 毫秒最多一个」的限制，也不占这个名额
   * 同一时间点很多下（比如狂点）时最多 25 毫秒一个
   */
  async function play(event, opts = {}) {
    if (inGame()) return null;
    if (!opts.music && !opts.loop && !soundOn()) return null;
    const now = performance.now();
    if (!opts.loop && !opts.ambient && now - lastAt < 25) return null;
    if (!opts.ambient) lastAt = now;
    const vol = opts.volume ?? 1;
    if (vol <= 0) return null;
    let got = await load(event);
    if (!got && opts.alt) got = await load(opts.alt);
    if (inGame()) return null; // 读文件的时候游戏开始了
    if (!got) {
      const f = FALLBACK[event];
      const fn = FALLBACK_FN[event] || FALLBACK_FN[opts.alt] || FALLBACK_FN[opts.synth];
      if (f) synth(f(), vol);
      else if (fn) fn(vol, opts);
      return null;
    }
    const c = ensure();
    const src = c.createBufferSource();
    src.buffer = got.buf;
    src.playbackRate.value = (opts.pitch ?? 1) * (got.r.pitch || 1);
    src.loop = !!opts.loop;
    const g = c.createGain();
    g.gain.value = Math.min(1.5, vol * (got.r.volume || 1));
    src.connect(g).connect(opts.music ? musicBus : bus());
    src.start();
    return {
      stop(fade = 1.5) {
        try { g.gain.setTargetAtTime(0.0001, c.currentTime, fade / 4); src.stop(c.currentTime + fade); } catch { /* 已经停了 */ }
      },
      gain: g,
      duration: got.buf.duration / Math.max(0.1, src.playbackRate.value),
    };
  }

  /** 游戏里有没有这个声音（不播放），用来决定要不要换成启动器自己的音乐 */
  const has = async (event) => !!(await load(event));

  /** 游戏开始：正在响的也马上停，结束后接着 */
  function setGameActive(active) {
    if (!ctx) return;
    if (active && ctx.state === 'running') ctx.suspend().catch(() => {});
    if (!active && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /** 顶栏音乐旁边的音效开关（rc3）：一个喇叭按钮，点一下开 / 关；性能模式、简洁模式下和音乐一样不显示 */
  function renderButton() {
    const b = document.getElementById('btnSound');
    if (!b) return;
    const on = soundCfg().enabled !== false;
    const tip = A.t(on ? 'sound.turnOff' : 'sound.turnOn');
    A.mount(b, A.icon(on ? 'volume' : 'volumeX', 16));
    b.classList.toggle('off', !on);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', tip);
    b.dataset.tip = tip;
  }
  function setEnabled(v) { return A.setConfig({ sound: { enabled: !!v } }); }
  function initButton() {
    const b = document.getElementById('btnSound');
    if (!b || b.dataset.ready) return;
    b.dataset.ready = '1';
    b.addEventListener('click', () => setEnabled(soundCfg().enabled === false));
    on('config', renderButton);
    renderButton();
  }

  A.gameSound = { play, has, setGameActive, setEnabled, initButton, on: soundOn };
})();
