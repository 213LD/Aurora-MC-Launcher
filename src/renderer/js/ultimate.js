'use strict';
/**
 * 终极彩蛋「Minecraft doesn't need you」（1.5.16，致敬 YouTube 上的同名视频：时间足够久，末影人和随机事件也能把末影龙打败）
 * 规则：
 * - 只算这一次打开启动器（关掉就清零），累计 4 小时触发；1 / 2 / 3 / 3.5 小时主页世界里的末影人一档比一档多（不占生物数量上限）
 * - 鼠标移动、点击（还有滚轮、按键）的那几秒不算；游戏在运行时不算；停在别的页面、没开游戏时最小化、挂在别的窗口后面都照算
 * - 「彩蛋」开关关了就整个禁用（设置里不提）；性能模式下不计时；只触发一次（config.ultimate.done），一键还原 / 恢复默认后才会再有
 * - 触发：切到主页、临时换成动态的末地场景（图片 / 纯色 / 帧率静态也临时换），末影人围攻末影龙（sceneending.js），
 *   龙死了就算完成（亮龙蛋），出现按钮，玩家回来点了播放终末之诗（endpoem.js）。减弱动态效果时直接自动播放终末之诗
 * - 完成后欢迎语名字右边一颗龙蛋（一开始是星星，后来改成龙蛋），点它重看终末之诗
 */
(function () {
  const { h, state } = A;
  const HOUR = 3600 * 1000;
  const STAGES = [[1 * HOUR, 3], [2 * HOUR, 5], [3 * HOUR, 7], [3.5 * HOUR, 10]]; // [累计时间, 多出来的末影人]
  const GOAL = 4 * HOUR;
  const MAX_GAP = 5 * 60 * 1000; // 电脑睡眠这类一下子跳很久的，最多算 5 分钟
  const U = { counted: 0, last: Date.now(), active: new Set(), running: false, defeated: false, timer: 0, watch: 0 };
  const zh = () => /^zh/i.test((window.I18N && window.I18N.getLang()) || 'zh-CN');

  const done = () => !!((state.config && state.config.ultimate) || {}).done;
  const eggsOn = () => ((state.config && state.config.background) || {}).eggs !== false;
  /** 现在算不算挂机时间（不含「这一秒有没有动鼠标」） */
  const counting = () => eggsOn() && !A.perf.on() && !A.simple.on() && !done() && !U.running && !gameRunning();
  function gameRunning() {
    const isGame = A.tasks && A.tasks.isGame;
    return [...state.games.values()].some((g) => g.state !== 'exited')
      || (!!isGame && [...state.tasks.values()].some((t) => t.status === 'running' && isGame(t)));
  }
  const extraFor = (ms) => STAGES.reduce((n, [t, k]) => (ms >= t ? k : n), 0);
  const stageOf = (ms) => STAGES.filter(([t]) => ms >= t).length + (ms >= GOAL ? 1 : 0);

  const mark = () => U.active.add(Math.floor(Date.now() / 1000));

  function tick() {
    const now = Date.now();
    const dt = Math.min(MAX_GAP, Math.max(0, now - U.last));
    U.last = now;
    const secs = U.active;
    U.active = new Set();
    if (counting()) {
      const from = Math.floor((now - dt) / 1000);
      let act = 0;
      for (const s of secs) if (s >= from) act++;
      U.counted += Math.max(0, dt - act * 1000);
      if (U.counted >= GOAL) trigger();
    }
    applyStage();
  }

  function applyStage() {
    const sc = A.homeScene && A.homeScene();
    if (sc) sc.extraEnder = eggsOn() && !done() && !U.running ? extraFor(U.counted) : 0;
  }

  const markDone = () => A.setConfig({ ultimate: { done: new Date().toISOString() } }).catch(() => {});

  // ───────────── 结局 ─────────────

  async function trigger(force) {
    if (U.running || (done() && !force)) return;
    U.running = true;
    U.defeated = false;
    applyStage();
    // 减弱动态效果：不演打龙，直接自动播放终末之诗
    if (A.a11y && A.a11y.reduceMotion()) {
      await markDone();
      await A.endPoem.play({ reduce: true });
      U.running = false;
      return;
    }
    A.go('home');
    A.homeEnding.begin('end');
    clearInterval(U.watch);
    U.watch = setInterval(watch, 400);
    watch();
  }

  /** 每 0.4 秒：场景准备好了就开始结局（窗口改大小、换主题重建场景后接着来）；更新 Boss 血条 */
  function watch() {
    const sc = A.homeScene && A.homeScene();
    const layer = A.homeEnding.layer();
    if (!sc || sc.dim !== 'end' || !sc.chunks) return;
    if (!sc.ending) {
      if (!sc.startEnding(onDefeated)) return;
      if (U.defeated) skipToAfter(sc);
    }
    const E = sc.ending;
    let bar = layer.querySelector('.end-boss');
    const showBar = E.phase === 'heal' || E.phase === 'fight' || E.phase === 'death' || (E.phase === 'arrive' && E.t > 3);
    if (showBar && !bar) {
      bar = h('div.end-boss', h('div.end-boss-name', zh() ? '末影龙' : 'Ender Dragon'), h('div.end-boss-bar', h('i')));
      layer.appendChild(bar);
    }
    if (bar) {
      bar.classList.toggle('gone', !showBar);
      bar.querySelector('i').style.width = `${(E.phase === 'death' ? 0 : E.hp / E.max) * 100}%`;
    }
  }

  function skipToAfter(sc) {
    const E = sc.ending;
    for (const p of sc.endLay().pillars) p.crystal = false;
    E.phase = 'after'; E.hp = 0; E.dead = 10; E.cb = null;
    sc.setEndPortal(true);
    E.egg = { x: E.px - 2, y: E.perchY };
    showButton();
  }

  function onDefeated() {
    U.defeated = true;
    markDone();
    showButton();
  }

  function showButton() {
    const layer = A.homeEnding.layer();
    if (layer.querySelector('.end-go')) return;
    const go = h('button.btn.primary.end-go', { type: 'button', onclick: playPoem }, zh() ? '跳进返回传送门' : 'Jump into the exit portal');
    layer.appendChild(h('div.end-cta', h('div.end-cap', 'Minecraft doesn\'t need you.'), go));
  }

  async function playPoem() {
    const layer = A.homeEnding.layer();
    const btn = layer.querySelector('.end-go');
    if (btn) btn.disabled = true;
    await A.endPoem.play();
    clearInterval(U.watch);
    A.homeEnding.end();
    U.running = false;
    U.counted = 0;
    applyStage();
  }

  /** 点龙蛋：重看终末之诗（不会再触发整个彩蛋） */
  const replay = () => A.endPoem.play();

  // 欢迎语旁边的像素龙蛋（8×10，黑底紫斑，左上一条亮边）
  const EGG = ['..llxx..', '.lxxxxx.', '.lxPxxx.', 'lxxxxPxx', 'xPxxxxxx', 'xxxxPxxx', 'xxxxxxPx', 'xPxxxxxx', '.xxxPxx.', '..xxxx..'];
  const EGG_C = { x: '#1c1426', l: '#4e3d68', P: '#b070f0' };
  function eggIcon() {
    const rects = EGG.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${EGG_C[ch]}"/>`))).join('');
    const span = document.createElement('span');
    span.className = 'egg-icon';
    span.innerHTML = `<svg viewBox="0 0 8 10" width="16" height="20" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
    return span;
  }
  const starTip = () => (zh() ? 'Minecraft doesn\'t need you · 点一下重看终末之诗' : 'Minecraft doesn\'t need you · click to read the End Poem again');

  function init() {
    for (const ev of ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart']) window.addEventListener(ev, mark, { passive: true, capture: true });
    U.last = Date.now();
    clearInterval(U.timer);
    U.timer = setInterval(tick, 1000);
  }

  // 调试菜单用（debugmenu.js）：不受「彩蛋」开关、性能模式、已完成的限制
  const debug = {
    info: () => ({ counted: U.counted, stage: stageOf(U.counted), extra: extraFor(U.counted), counting: counting(), eggs: eggsOn(), perf: A.perf.on(), game: gameRunning(), done: done(), running: U.running, defeated: U.defeated }),
    add(ms) { U.counted = Math.max(0, U.counted + ms); applyStage(); if (U.counted >= GOAL) trigger(true); },
    nextStage() {
      const t = [...STAGES.map(([x]) => x), GOAL].find((x) => x > U.counted);
      if (t != null) debug.add(t - U.counted);
    },
    trigger: () => { U.counted = GOAL; return trigger(true); },
    poem: (reduce) => A.endPoem.play({ reduce: !!reduce }),
    clearDone: () => A.setConfig({ ultimate: { done: '' } }),
    reset() { U.counted = 0; applyStage(); },
    STAGES, GOAL,
  };

  A.ultimate = { init, replay, starTip, eggIcon, debug };
})();
