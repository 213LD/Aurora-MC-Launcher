'use strict';
/* 主页：动态场景 + 新闻 + 启动坞 */
(function () {
  const { h, icon, api, state, on, $, t } = A;

  let root;
  let scene = null;
  let els = {};
  // 骰子临时换的场景：只在这次打开启动器时有效，不写进设置
  let sceneOverride = null;
  // 终极彩蛋的结局（ultimate.js）：临时强制成动态的末地场景（不管背景设置是图片、纯色还是帧率静态），结束后恢复
  let forceScene = null;

  function greeting() {
    const hr = new Date().getHours();
    if (hr < 5) return '夜深了';
    if (hr < 11) return '早上好';
    if (hr < 13) return '中午好';
    if (hr < 18) return '下午好';
    if (hr < 23) return '晚上好';
    return '夜深了';
  }

  function build() {
    root = $('#page-home');
    const bg = h('div.home-bg');
    els.bg = bg;
    els.greetTitle = h('h1');
    els.greetSub = h('p');
    els.tips = A.homeTips(els.greetSub);
    els.splash = A.splash();
    els.scenePill = A.scenePill({ onPick: pickScene, onTime: (v) => A.setConfig({ background: { time: v } }), onReroll: rerollScene, onWeather: (v) => { if (scene && scene.setWeather) scene.setWeather(v); }, isTemp: () => !!sceneOverride });
    els.stats = h('div.home-stats');
    // 右上角的更新日志面板（Minecraft / 启动器两个标签）和收起后的小按钮，见 home/newspanel.js
    els.news = A.newsPanel();

    els.verPick = h('button.dock-pick', { onclick: (e) => pickVersion(e.currentTarget) });
    els.accPick = h('button.dock-pick.dock-account', { onclick: (e) => pickAccount(e.currentTarget) });
    els.launch = h('button.launch-btn', { onclick: onLaunchClick });
    els.tools = h('div.dock-tools');
    els.endLayer = h('div.end-layer'); // 结局的 Boss 血条和按钮（ultimate.js）
    els.camHome = h('button.btn.sm.cam-home.hidden', { 'data-tip': '视角和缩放回到打开时的样子', onclick: () => { if (scene) scene.camHome(); } }, icon('home', 14), '回到地面');

    A.mount(root,
      bg,
      h('div.home-shade'),
      h('div.home-content',
        h('div.home-top',
          h('div.greet', h('div.greet-title', els.greetTitle, els.splash.el), els.greetSub, els.stats),
          els.news.panel, els.news.pill),
        els.dock = h('div.dock', els.verPick, h('div.dock-sep'), els.accPick, els.tools, els.launch)),
      els.camHome, els.endLayer);
    root.addEventListener('click', onBgClick);
    // 背景视角：鼠标停在边缘的空白处慢慢平移，按住空白处拖动
    root.addEventListener('mousemove', onBgMove);
    root.addEventListener('mouseleave', () => { if (scene) scene.panStop(); });
    root.addEventListener('mousedown', onBgDown);
    root.addEventListener('wheel', onBgWheel, { passive: false });
    new ResizeObserver(fitDock).observe(els.dock);
    applyBackground();
  }

  let gamePaused = false; // 游戏运行时背景暂停着（syncGamePause）
  let gamePauseTimer = null;

  function applyBackground() {
    const cfg = state.config;
    // 性能模式、简洁模式（1.7.0）：像素场景只画一帧就停（全静态，1.5.7；以前换成纯色渐变），自定义图片照常显示
    const cfgB = (cfg && cfg.background) || { type: 'scene' };
    const b = forceScene ? { ...cfgB, type: 'scene', fps: 30 } : cfgB;
    if (scene) { scene.stop(); scene = null; }
    els.camHome.classList.add('hidden');
    A.clear(els.bg);
    if (b.type === 'image' && b.image) {
      els.bg.appendChild(h('div.img', { style: { backgroundImage: `url("file:///${b.image.replace(/\\/g, '/').replace(/"/g, '%22')}")` } }));
    } else if (b.type === 'gradient') {
      els.bg.append(h('div', { style: { position: 'absolute', inset: 0, background: 'var(--bg-1)' } }), h('div.grad'));
    } else {
      const canvas = h('canvas');
      els.bg.appendChild(canvas);
      scene = new A.Scene(canvas);
      scene.frozen = forceScene ? false : A.a11y.reduceMotion() || A.perf.on() || A.simple.on() || b.fps === 0; // 帧率选「静态」也定格（性能打磨）
      scene.noFlash = A.a11y.noFlash();
      scene.setOptions(sceneOptions(b));
      scene.onCam = (away) => els.camHome.classList.toggle('hidden', !away);
      scene.dockTop = () => (els.dock.isConnected ? els.dock.getBoundingClientRect().top : null); // 下边的平移感应带从启动栏上面开始
      if (state.page === 'home' && !gamePaused) scene.start();
    }
    if (!scene) A.emit('scene', null);
  }

  const sceneOptions = (b) => {
    const o = Object.fromEntries(Object.keys(A.SCENE_DEFAULTS).map((k) => [k, b[k] !== undefined ? b[k] : A.SCENE_DEFAULTS[k]]));
    if (sceneOverride) o.scene = sceneOverride;
    if (forceScene) Object.assign(o, { scene: forceScene, animals: true, eggs: true, pan: false });
    return o;
  };

  /** 场景胶囊里选的场景写进设置，同时取消骰子的临时场景 */
  async function pickScene(v) {
    sceneOverride = null;
    await A.setConfig({ background: { scene: v } });
    if (scene) scene.setOptions(sceneOptions(state.config.background || {}));
  }

  /** 骰子：随机换一个和现在不同的场景（含下界、末地），不改设置 */
  function rerollScene() {
    if (!scene) return;
    const cur = scene.info().scene;
    const pool = Object.keys(A.SCENES).filter((id) => id !== cur);
    sceneOverride = pool[Math.floor(Math.random() * pool.length)];
    scene.setOptions(sceneOptions(state.config.background || {}));
  }

  // 只有这些算「点到了界面」；其余都算点背景。不要写 .greet / .news 这类容器：
  // 它们在 flex 布局里会被拉伸到整列高度，左半边屏幕点了都没反应（1.4.1 修）
  const UI_TARGETS = 'button, a, input, select, textarea, .dock, .news-card, .news-head, .stat-pill, .splash-text';

  const blankAt = (el) => !!el && root.contains(el) && !el.closest(UI_TARGETS);
  // 边缘平移比点击宽松（1.7.4）：停在黄色标语这类文字上也平移，按钮、胶囊、卡片、启动坞照旧不平移
  const PAN_UI = UI_TARGETS.replace(', .splash-text', '');
  const panBlankAt = (el) => !!el && root.contains(el) && !el.closest(PAN_UI);
  A.homeBlankAt = (el) => panBlankAt(el); // 调试菜单「显示边缘平移范围」用：鼠标停在这个元素上会不会平移
  let dragged = false;

  function onBgMove(e) {
    if (!scene || scene.drag) return;
    if (panBlankAt(e.target)) scene.panEdge(e.clientX, e.clientY); else scene.panStop();
  }

  /** 按住空白处拖动视角；拖过的这一下不算点击（不冒粒子） */
  function onBgDown(e) {
    if (!scene || e.button !== 0 || !blankAt(e.target) || !scene.panDragStart(e.clientX, e.clientY)) return;
    const move = (ev) => { scene.panDragMove(ev.clientX, ev.clientY); if (scene.drag && scene.drag.moved) root.classList.add('cam-dragging'); };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      root.classList.remove('cam-dragging');
      if (scene && scene.panDragEnd()) { dragged = true; setTimeout(() => { dragged = false; }, 50); }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /**
   * 滚轮缩放主页世界（1.6.0）：0.75 ~ 2.5 倍，朝鼠标的位置缩放；在更新日志这类界面上滚动不算。
   * 和拖动视角一样跟着「移动视角」设置走，定格的画面（性能模式、减少动态效果、静态帧率）和终极彩蛋结局里不缩放
   */
  function onBgWheel(e) {
    if (!scene || scene.frozen || !scene.opts.pan || !blankAt(e.target) || e.ctrlKey) return;
    e.preventDefault();
    const r = scene.canvas.getBoundingClientRect();
    const k = Math.max(0.8, Math.min(1.25, Math.exp(-e.deltaY * 0.0015)));
    scene.zoomBy(k, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }

  /** 点击主页空白处：点中生物就互动，否则冒一团粒子 */
  function onBgClick(e) {
    // 定格的画面（性能模式、减少动态效果）不互动；刚拖动过视角的也不算
    if (dragged) { dragged = false; return; }
    if (!scene || scene.frozen || e.target.closest(UI_TARGETS)) return;
    if (!scene.click(e.clientX, e.clientY)) scene.burst(e.clientX, e.clientY);
  }

  function renderGreet() {
    const acc = A.currentAccount();
    // 完成终极彩蛋后名字右边一颗龙蛋（像 FNAF 通关五夜的星星，这里用龙蛋），点它重看终末之诗（ultimate.js）
    const star = (state.config.ultimate || {}).done && A.ultimate ? h('button.greet-egg', {
      type: 'button', 'data-tip': A.ultimate.starTip(), 'aria-label': A.ultimate.starTip(), onclick: (e) => { e.stopPropagation(); A.ultimate.replay(); },
    }, A.ultimate.eggIcon()) : null;
    A.mount(els.greetTitle, `${greeting()}，`, acc ? A.noTr(acc.name) : h('span', '冒险家'), star);
    const latest = state.manifest && state.manifest.latest;
    const hasLatest = latest && state.installed.some((v) => v.mcVersion === latest.release);
    // 新版本通知并入提示轮播，不再独占这一行
    els.tips.setSpecial(latest && !hasLatest && !A.simple.on() ? { // 简洁模式不提示去下载新版本
      key: latest.release,
      render: () => [icon('sparkles', 13), `${t('home.newRelease', { v: latest.release })} · `, h('a', { onclick: () => A.go('download', { install: latest.release }) }, t('home.installNow'))],
    } : null);
    // 问候下面只留背景场景胶囊和骰子（rc3）：配置数、下载源、背景音乐这几个胶囊去掉了——
    // 配置在左边栏，下载源在设置里，背景音乐和音效的开关在顶栏。
    // 只有检测完了、一个 Java 都没找到时多一个红色光圈一闪一闪的「未检测到 Java」，点了去 Java 页面（rc3）
    const noJava = Array.isArray(state.javas) && state.javas.length === 0;
    if (noJava && !els.javaPill) {
      els.javaPill = h('button.stat-pill.java-missing', { type: 'button', 'data-tip': '这台电脑上还没有找到 Java，点这里去下载或手动添加', onclick: () => A.go('java') }, icon('coffee', 14), '未检测到 Java');
    }
    const want = [A.simple.mark(els.scenePill.el), noJava ? els.javaPill : null].filter(Boolean);
    if (want.length !== els.stats.children.length || want.some((el, i) => els.stats.children[i] !== el)) A.mount(els.stats, ...want);
  }

  function renderDock() {
    const v = A.currentVersion();
    A.mount(els.verPick,
      h('img', { src: v ? A.versionIcon(v) : A.blockImage('unknown'), alt: '' }),
      h('div.d-body',
        h('div.d-label', t('term.profile'), v ? isoLabel(v) : null),
        h('div.d-title', v ? A.noTr(A.displayName(v)) : '还没有游戏配置'),
        h('div.d-sub', v ? (v.modsOff ? h('span', { style: { color: 'var(--warn)' } }, `Mod 已全部禁用 · ${A.versionSub(v)}`)
          : isSandbox(v) ? h('span.sandbox-note', { 'data-tip': t('sandbox.noticeTip') }, icon('flask', 12), t('sandbox.notice'))
            : A.versionSub(v)) : '点击前往下载')),
      icon('chevronUp', 18));

    A.clear(els.tools);
    els.tools.classList.toggle('hidden', !(v && v.loader));
    if (v && v.loader) {
      els.tools.append(
        h('button.dock-tool', { 'data-tip': `${t('term.debug')}：自动检测并修复 Mod 冲突`, onclick: () => A.debugDialog(v), 'data-simple-off': '' }, icon('wrench', 16), h('span', t('term.debug'))),
        h('button', { class: `dock-tool ${v.modsOff ? 'warn' : ''}`, 'data-tip': v.modsOff ? `恢复之前禁用的 ${v.modsOff} 个 Mod` : '暂时以无 Mod 状态游玩，之后可以恢复', onclick: () => A.toggleAllMods(v) },
          icon(v.modsOff ? 'refresh' : 'puzzle', 16), h('span', v.modsOff ? t('term.restoreAll') : t('term.disableAll'))));
    }

    const acc = A.currentAccount();
    A.mount(els.accPick,
      acc ? A.avatar(acc, 44) : h('div.avatar', { style: { width: '44px', height: '44px', display: 'grid', placeItems: 'center' } }, icon('user', 20)),
      h('div.d-body',
        h('div.d-label', '账户'),
        h('div.d-title', acc ? A.noTr(acc.name) : '未登录'),
        h('div.d-sub', acc ? (acc.needRelogin ? '登录已失效' : acc.type === 'offline' ? '离线模式' : A.accountLabel(acc)) : '点击添加账户')),
      icon('chevronUp', 18));
    renderLaunch();
  }

  /**
   * 启动栏变窄（rc3）：先把「一键 Debug」「禁用全部 Mod」收成只剩图标，再把启动按钮变窄，最后启动按钮只剩播放图标。
   * 看启动栏自己的宽度（窗口、侧边栏、1.5 倍缩放都算进去了）；只剩图标时鼠标停上去显示按钮上原来的字
   */
  const FIT = [[860, 'full'], [760, 'tools'], [640, 'small'], [0, 'icon']];
  function fitDock() {
    const w = els.dock.clientWidth;
    if (!w) return;
    const fit = FIT.find(([min]) => w >= min)[1];
    if (els.dock.dataset.fit === fit) return;
    els.dock.dataset.fit = fit;
    syncLaunchTip();
  }
  function syncLaunchTip() {
    const b = els.launch;
    if (els.dock.dataset.fit === 'icon' && b.dataset.label) { b.dataset.tip = b.dataset.label; b.setAttribute('aria-label', b.dataset.label); } else { delete b.dataset.tip; b.removeAttribute('aria-label'); }
  }

  /** 存档是每次启动都重新复制的测试副本：在这里玩的进度不会保留 */
  // 底栏里的存档隔离标签：放不下时省略号截断，不换行
  function isoLabel(v) {
    const i = A.iso.info(v);
    return h('span', { class: `d-iso ${i.cls}`, 'data-tip': i.text }, icon(i.icon, 12), h('span.ellipsis', i.text));
  }

  function isSandbox(v) {
    const p = v.isolation;
    if (!p || p.refresh === 'once') return false;
    return p.preset === 'sandbox' || (p.preset === 'custom' && p.items && p.items.saves === 'copy');
  }

  function launchTask(id) {
    return [...state.tasks.values()].find((t) => t.kind === 'launch' && t.status === 'running' && t.meta && t.meta.name === id);
  }
  function runningGames(id) {
    return [...state.games.values()].filter((g) => g.versionId === id && g.state !== 'exited');
  }

  /**
   * 正在准备启动：进度每 200 毫秒变一次，这里只改进度条和文字（1.10.5）。
   * 以前每次都重建按钮内容，转圈动画每次从头开始（每秒重来好几次，转不到四分之一圈就被打回去，一抽一抽的），进度条的过渡动画也没了
   */
  let busy = null;
  function renderBusy(b, t) {
    if (!busy || busy.b !== b) {
      busy = { b, fill: h('div.l-fill'), main: h('div.l-main', { style: { fontSize: '16px' } }), sub: h('div.l-sub') };
      b.className = 'launch-btn busy';
      A.mount(b, busy.fill, h('span.spinner', { style: { borderColor: 'rgba(0,0,0,.15)', borderTopColor: 'currentColor' } }), h('div.l-text', busy.main, busy.sub));
      b.dataset.label = '正在启动';
      syncLaunchTip();
    }
    const pct = t.progress >= 0 ? t.progress * 100 : 0;
    busy.fill.style.width = `${pct}%`;
    busy.main.textContent = t.progress >= 0 ? `准备中 ${Math.round(pct)}%` : '正在启动';
    busy.sub.textContent = t.detail || '';
  }

  function renderLaunch() {
    const b = els.launch;
    const v = A.currentVersion();
    const acc = A.currentAccount();
    const t = v && acc ? launchTask(v.id) : null;
    if (t) { renderBusy(b, t); return; }
    busy = null;
    b.className = 'launch-btn';
    A.clear(b);
    const put = (label, ...kids) => { b.append(...kids); b.dataset.label = label; syncLaunchTip(); };
    if (!v) {
      put('安装游戏', icon('download', 24), h('div.l-text', h('div.l-main', '安装游戏'), h('div.l-sub', '选择一个版本开始')));
      return;
    }
    if (!acc) {
      put('添加账户', icon('user', 24), h('div.l-text', h('div.l-main', '添加账户'), h('div.l-sub', A.FEATURES.msLogin ? '离线或微软正版' : '创建离线账户')));
      return;
    }
    const games = runningGames(v.id);
    if (games.length) {
      b.classList.add('running');
      put('游戏运行中', h('span.pulse'), h('div.l-text', h('div.l-main', { style: { fontSize: '17px' } }, '游戏运行中'), h('div.l-sub', games.length > 1 ? `${games.length} 个实例 · 点击管理` : '点击管理')));
      return;
    }
    put('启动游戏', icon('play', 26), h('div.l-text', h('div.l-main', '启动游戏'), h('div.l-sub', A.noTr(A.displayName(v)))));
  }

  async function onLaunchClick(e) {
    const v = A.currentVersion();
    if (!v) return A.go('download');
    if (!A.currentAccount()) return A.go('accounts', { add: true });
    if (launchTask(v.id)) { A.tasks.toggle('run'); return; }
    const games = runningGames(v.id);
    if (games.length) {
      A.menu(e.currentTarget, [
        { label: '查看日志', icon: 'terminal', onClick: () => A.logs.open(games[0].id) },
        { label: '再启动一个实例', icon: 'play', onClick: () => A.launch(v.id, { again: true }) },
        '-',
        ...games.map((g) => ({ label: `结束进程 ${g.pid}`, icon: 'stop', danger: true, onClick: () => api('games:kill', g.id) })),
      ], { align: 'right', placement: 'top' });
      return;
    }
    A.launch(v.id);
  }

  function pickVersion(anchor) {
    if (!state.installed.length) return A.go('download');
    const cur = A.currentVersion();
    const visible = state.installed.filter((v) => !(v.usedAsParent && !v.hasMeta && !v.loader) || (cur && cur.id === v.id));
    const sorted = [...visible].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    const items = sorted.slice(0, 40).map((v) => ({
      label: A.nm(A.displayName(v)),
      sub: `${(A.PROFILE_TYPES[v.profileType] || {}).name || ''} · ${A.versionSub(v)}${v.loader && v.mods ? ` · ${v.mods.enabled} 个 Mod` : ''}`,
      img: v.modpack && v.modpack.icon ? v.modpack.icon : A.versionIcon(v, 48), on: cur && v.id === cur.id,
      onClick: () => A.setConfig({ selectedVersion: v.id }),
    }));
    A.menu(anchor, [{ head: '切换游戏配置' }, ...items, '-',
      cur && cur.loader ? { label: '打开当前配置的 mods 文件夹', icon: 'folder', onClick: () => api('versions:dir', cur.id, 'mods').then((p) => api('shell:open', p)).catch((e) => A.errorToast('无法打开目录', e)) } : null,
      { label: '管理游戏配置', icon: 'layers', onClick: () => A.go('versions') },
      { label: t('term.planner'), icon: 'sparkles', onClick: () => A.go('planner'), simpleOff: true, net: true },
      { label: '安装新版本 / 整合包', icon: 'download', onClick: () => A.go('download'), simpleOff: true, net: true }], { placement: 'top', width: Math.max(340, anchor.offsetWidth) });
  }

  function pickAccount(anchor) {
    const { accounts, selected } = state.accounts;
    const items = accounts.map((a) => ({
      label: A.nm(a.name), sub: A.accountLabel(a), on: a.id === selected,
      img: null, icon: a.type === 'microsoft' ? 'shield' : a.type === 'yggdrasil' ? 'globe' : 'user',
      onClick: async () => { await api('accounts:select', a.id); },
    }));
    A.menu(anchor, [{ head: '切换账户' }, ...items, items.length ? '-' : null,
      { label: '添加账户', icon: 'plus', onClick: () => A.go('accounts', { add: true }) },
      { label: '管理账户', icon: 'users', onClick: () => A.go('accounts') }], { placement: 'top', width: 280 });
  }

  const bgKeyOf = (c) => { const b = c.background || {}; return `${b.type}|${b.image}|${c.theme}|${!!c.perfMode}|${!!c.simpleMode}|${b.fps === 0}|${A.a11y.reduceMotion()}|${A.a11y.noFlash()}`; };

  function show() {
    renderGreet();
    renderDock();
    els.news.render();
    els.tips.start();
    // 性能模式、简洁模式：提示只显示一条，不轮换
    if (A.perf.on() || A.simple.on()) els.tips.stop();
    if (scene && !gamePaused) scene.start();
    A.panHint.maybe(root, scene); // 前 3 次打开时提示可以移动视角（home/panhint.js）
  }
  function hide() { els.tips.stop(); if (scene) scene.stop(); A.panHint.hide(); }

  // 游戏运行时背景暂停（2.0.0-pre4）：启动 1 秒后停下，不再打怪、不再出声；游戏都退出后接着动。声音在 gamesound.js 里马上就拦
  const GAME_PAUSE_DELAY = 1000;
  function syncGamePause() {
    const active = A.tasks.gameActive();
    A.gameSound.setGameActive(active);
    if (!active) {
      clearTimeout(gamePauseTimer);
      gamePauseTimer = null;
      if (gamePaused) {
        gamePaused = false;
        if (scene && state.page === 'home') scene.start();
      }
      return;
    }
    if (gamePaused || gamePauseTimer) return;
    gamePauseTimer = setTimeout(() => {
      gamePauseTimer = null;
      if (!A.tasks.gameActive()) return;
      gamePaused = true;
      if (scene) scene.stop();
    }, GAME_PAUSE_DELAY);
  }

  function init() {
    // 场景第一次生成就在 build() 里发 scene 事件，所以先注册
    on('scene', (info) => { if (els.scenePill) els.scenePill.setInfo(info); });
    // 天气变了（自己变的、或在胶囊里强制的）：胶囊上的字跟着变（rc3）
    on('sceneWeather', () => { if (els.scenePill && scene) els.scenePill.setInfo(scene.info()); });
    build();
    const refresh = A.pageRefresher('home', () => { renderDock(); renderGreet(); });
    on('installed', refresh);
    on('accounts', refresh);
    on('javas', refresh);
    on('manifest', refresh);
    on('task', (t) => { if (t.kind === 'launch') renderLaunch(); if (t.kind === 'cleared' || A.tasks.isGame(t)) syncGamePause(); });
    on('games', () => { renderLaunch(); syncGamePause(); });
    on('config', (c, changed) => {
      if (!A.configMatters(changed)) return;
      refresh();
      const b = c.background || {};
      const key = bgKeyOf(c);
      if (key !== els.bgKey) { els.bgKey = key; applyBackground(); }
      else if (scene) scene.setOptions(sceneOptions(b));
      if (els.news) els.news.render();
    });
    els.bgKey = bgKeyOf(state.config);
    // 减少动态效果开关（含跟随系统）变了：场景改成定格 / 恢复动画
    on('a11y', () => { const key = bgKeyOf(state.config); if (key !== els.bgKey) { els.bgKey = key; applyBackground(); } });
  }

  A.pages.home = { init, show, hide, title: '' };
  A.homeScene = () => scene;
  // 终极彩蛋的结局（ultimate.js）：begin 强制换成动态场景、藏起主页的内容；end 恢复
  A.homeEnding = {
    begin(id) { forceScene = id; root.classList.add('ending'); applyBackground(); return scene; },
    end() { forceScene = null; root.classList.remove('ending'); A.clear(els.endLayer); applyBackground(); renderGreet(); },
    layer: () => els.endLayer,
    active: () => !!forceScene,
  };
})();
