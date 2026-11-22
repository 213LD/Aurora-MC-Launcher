'use strict';
/* 应用入口：导航、窗口控制、主题、启动流程 */
(function () {
  const { h, icon, api, state, on, $, $$, t } = A;

  const NAV = [
    { id: 'home', label: t('nav.home'), icon: 'home' },
    { id: 'versions', label: t('nav.versions'), icon: 'layers' },
    { id: 'download', label: t('nav.download'), icon: 'download' },
    { id: 'mods', label: t('nav.mods'), icon: 'puzzle' },
    { id: 'planner', label: t('nav.planner'), icon: 'sparkles' },
    { id: 'repair', label: t('nav.repair'), icon: 'wrench' },
    { id: 'tasks', label: t('nav.tasks'), icon: 'zap' },
    { id: 'logs', label: t('nav.logs'), icon: 'scroll' }, // 日志中心（rc4）
    '-',
    { id: 'java', label: t('nav.java'), icon: 'coffee' },
    { id: 'accounts', label: t('nav.accounts'), icon: 'users' },
    { id: 'skins', label: t('nav.skins'), icon: 'palette' },
    { id: 'settings', label: t('nav.settings'), icon: 'settings' },
  ];

  const inited = new Set();
  // 配置 id → 「安装完成 · 立即启动」这类提示的关闭函数（可能有好几条）：开始启动这个配置、配置没了、又改了一次组件时收起来（1.10.8）
  const installedToasts = new Map();
  function dropInstalled(id) {
    for (const close of installedToasts.get(id) || []) close.dismiss();
    installedToasts.delete(id);
  }
  // 简洁模式（1.7.0）只在侧边栏留主页、游戏配置、Mod 管理、账户和设置；性能模式不藏页面
  const navItems = () => (A.simple.on() ? NAV.filter((n) => n !== '-' && A.simple.allows(n.id)) : NAV);

  // 侧边栏徽标上的数字。任务进度大约 200ms 推送一次，只有数字变了才重建侧边栏，
  // 否则按钮一直被换掉：悬停动画一下一下闪，按下和松开落在不同的按钮上时点击会丢（1.5.7）
  const navCounts = () => {
    const list = [...state.tasks.values()].filter((t) => t.status === 'running');
    return [list.filter((t) => t.kind === 'install').length, list.filter((t) => A.tasks.isRun(t)).length];
  };
  let navKey = '';

  /**
   * 上次没装完的整合包（启动器被关掉或断电时装到一半）：问玩家删掉还是先留着。
   * 以前启动时直接删，改成先提示
   */
  async function halfPackAsk() {
    const ids = await api('profiles:halfPacks').catch(() => []);
    for (const id of ids) {
      const remove = await new Promise((resolve) => A.modal({
        title: '有整合包上次没装完', size: 'sm', level: 'warn',
        body: h('div', h('p.confirm-text', `「${A.nm(id)}」上次装到一半就中断了（可能是启动器被关掉或电脑断电），现在玩不了。删掉以后可以重新安装；也可以先留着，以后自己在配置里删除。`)),
        actions: [{ label: '先留着', kind: 'ghost', value: false }, { label: '删掉', kind: 'primary', value: true }],
        onClose: (v) => resolve(v === true),
      }));
      const done = await api('profiles:resolveHalfPack', id, remove ? 'remove' : 'keep').then(() => true, (e) => e);
      if (done === true) { if (remove) A.toast({ level: 'ok', text: `已把「${A.nm(id)}」移到回收站` }); continue; }
      // 游戏目录在 U 盘、网络盘上没有回收站（2026-11-07 实测：移到回收站会失败，文件原样留着）：和删配置一样，再确认一次才永久删除
      if (remove && done.reason && done.reason.code === 'TRASH_UNAVAILABLE') {
        const ok = await A.dangerConfirm({ level: 2, title: t('trash.unavailableTitle'), text: t('trash.unavailable', { name: A.nm(id) }), note: t('danger.permanentNote'), noteLevel: 'crit', okText: t('trash.permanentDelete') });
        if (ok) await api('profiles:resolveHalfPack', id, 'removePermanent').then(() => A.toast({ level: 'ok', text: t('profile.deleted', { name: A.nm(id) }) }), (e) => A.errorToast(t('profile.deleteFailed'), e));
        continue;
      }
      A.errorToast(t('profile.deleteFailed'), done);
    }
  }

  /** 任务中心的数字：有运行中的任务时是任务数；没有时灰色的数字是没做完的 Mod 配置有几份（rc3） */
  function tasksBadge(runTasks) {
    if (runTasks) return h('span.nav-badge', runTasks);
    const n = state.plannerUnfinished || 0;
    return n ? h('span.nav-badge.idle', { 'data-tip': `${n} 份 Mod 配置还没做完` }, n) : null;
  }

  function renderNav() {
    const nav = $('#nav');
    const [running, runTasks] = navCounts();
    navKey = `${running}/${runTasks}`;
    A.mount(nav, navItems().map((n) => (n === '-' ? h('div.nav-sep', { role: 'separator' }) : h('button', {
      class: `nav-item ${state.page === n.id ? 'active' : ''}`,
      onclick: () => go(n.id),
      'aria-current': state.page === n.id ? 'page' : null,
      'data-tip': iconOnly() ? n.label : null,
      'aria-label': n.label,
      'data-net': A.offline.PAGES.includes(n.id) ? '' : null,
    }, icon(n.icon, 20), h('span', n.label), n.id === 'download' && running ? h('span.nav-badge', running) : n.id === 'tasks' ? tasksBadge(runTasks) : null))), A.simple.sideChip(iconOnly()), A.perf.sideChip(iconOnly()));
    renderSideToggle();
  }

  // 侧边栏手动收起 / 展开（1.4.8），记在配置里；窗口很窄时 CSS 仍会自动收起
  // 像素风是顶部标签：窗口窄时没选中的标签只剩图标
  const iconOnly = () => (A.uiStyle.is('pixel') ? document.body.clientWidth <= 1240 : !!(state.config && state.config.sidebarCollapsed) || document.body.clientWidth <= 1000);
  function renderSideToggle() {
    const collapsed = !!(state.config && state.config.sidebarCollapsed);
    // 像素风没有侧边栏（顶部标签），不加收起样式
    document.documentElement.classList.toggle('side-collapsed', collapsed && !A.uiStyle.is('pixel'));
    const b = $('#sideToggle');
    if (!b) return;
    const label = t(collapsed ? 'nav.expand' : 'nav.collapse');
    b.replaceChildren(icon(collapsed ? 'chevronRight' : 'chevronLeft', 18), h('span', label));
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-expanded', String(!collapsed));
    if (iconOnly()) b.setAttribute('data-tip', label); else b.removeAttribute('data-tip');
    b.onclick = () => A.setConfig({ sidebarCollapsed: !collapsed });
  }

  function renderSideAccount() {
    const acc = A.currentAccount();
    A.mount($('#sideAccount'), h('div.account-chip', { onclick: () => go('accounts') },
      acc ? A.avatar(acc, 36) : h('div.avatar', { style: { width: '36px', height: '36px', display: 'grid', placeItems: 'center' } }, icon('user', 18)),
      h('div.meta',
        h('div.name', acc ? A.noTr(acc.name) : '未登录'),
        h('div.type', h('span', { class: `dot ${acc ? (acc.needRelogin ? 'warn' : acc.type === 'offline' ? 'ok' : 'ms') : ''}` }), acc ? A.accountLabel(acc) : '点击添加账户')),
      icon('chevronRight', 16)));
  }

  // 页面历史：顶栏左上角的「返回」、鼠标侧键后退、Alt+← 回到上一个页面（1.4.7：从一个页面跳到另一个页面后回不去）。
  // 只记页面不记参数，回去时不会重复打开对话框或重新开始排查
  const backStack = [];
  function go(page, params, { back = false } = {}) {
    const p = A.pages[page];
    if (!p) return;
    if (!A.simple.canOpen(page)) { A.simple.check(); return; } // 简洁模式里收起来的页面（别处的链接、菜单也会走到这里）
    if (!A.offline.allows(page)) { A.offline.check(); return; } // 离线模式：要联网的页面（offline.js）
    A.closePopover();
    A.closeDrawers();
    const prev = state.page;
    if (!back && prev && prev !== page && A.pages[prev]) { backStack.push(prev); if (backStack.length > 30) backStack.shift(); }
    if (prev !== page && inited.has(prev) && A.pages[prev] && A.pages[prev].hide) A.pages[prev].hide();
    state.page = page;
    $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
    if (!inited.has(page)) { inited.add(page); p.init(); }
    if (p.show) p.show(params);
    A.emit('page', page);
    $('#crumb').textContent = p.title || '';
    renderNav();
    renderBack();
    // 读 scrollTop 会马上排一次版：放在最后，侧边栏、返回按钮也改完了再排，整页只排一次（rc14：以前排完又改侧边栏，下一帧再排一遍）
    syncTitlebar($(`#page-${page}`));
  }

  function goBack() {
    // 有能关的对话框时先关对话框
    if (A.closeTopModal && A.closeTopModal()) return true;
    // 还开着关不掉的对话框（一键 Debug 进行中）时不切页面
    if (document.querySelector('.modal-back:not(.closing)')) return false;
    while (backStack.length && backStack[backStack.length - 1] === state.page) backStack.pop();
    const page = backStack.pop();
    if (!page) return false;
    go(page, undefined, { back: true });
    return true;
  }
  function renderBack() {
    const b = $('#btnBack');
    if (!b) return;
    const to = backStack[backStack.length - 1];
    b.classList.toggle('hidden', !to);
    if (to) { const title = (A.pages[to] && A.pages[to].title) || ''; b.title = title ? `${t('common.back')}：${title}` : t('common.back'); b.setAttribute('aria-label', b.title); }
  }

  function applyTheme(c) {
    document.documentElement.dataset.theme = c.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.accent = c.accent || 'aurora';
    A.perf.apply();
    A.simple.apply();
    A.offline.apply();
    A.a11y.apply();
    A.uiStyle.apply();
  }

  // 连点两下启动（以前弹一条不会消失的红色「正在启动中」）：
  // 0.8 秒内的第二下直接忽略，不然确认框也会叠两层；再晚点的由主进程拦下，下面按普通提示显示。
  // 不用「启动中」标记：中途哪个弹窗没走正常关闭流程，这个配置就一直启动不了
  const lastLaunchAt = new Map();

  /** opts.again：玩家已经明确选了「再启动一个实例」（主页按钮的菜单），不用再问 */
  async function launch(id, { again = false } = {}) {
    if (!id) return;
    if (!again && Date.now() - (lastLaunchAt.get(id) || 0) < 800) return;
    lastLaunchAt.set(id, Date.now());
    if (!A.currentAccount()) { A.toast({ level: 'warn', text: '请先添加一个账户' }); go('accounts', { add: true }); return; }
    // 游戏开着时先问一下（1.10.8）：以前只有主页大按钮知道，配置页双击、回车、Ctrl+Enter 都会直接再开一个
    if (!again && [...state.games.values()].some((g) => g.versionId === id && g.state !== 'exited')) {
      const ok = await A.confirm(`「${A.nm(id)}」的游戏已经开着了。要再启动一个实例吗？`, { title: '游戏正在运行', okText: '再启动一个' });
      if (!ok) return;
    }
    if (state.config.selectedVersion !== id) A.setConfig({ selectedVersion: id });
    if (state.page !== 'home' && !A.simple.on()) go('home');
    const onHome = state.page === 'home';
    // 配置里或全局指定的 Java 不合适时先问一下
    if (!(await A.javaCheck.beforeLaunch(id))) return;
    A.javaCheck.launching(id);
    dropInstalled(id);
    // 「启动后关闭启动器」和本地皮肤服务冲突时先问
    const skinClose = await A.skinCloseChoice(A.currentAccount());
    if (skinClose === null) return;
    // 简洁模式下不跳回主页：不在主页时提示一下去哪里看进度
    if (A.simple.on() && !onHome) A.toast({ level: 'info', text: `正在准备启动 ${A.nm(id)}，进度在顶栏「运行中的任务」（闪电图标）里`, duration: 3500, noLog: true });
    A.dismissToasts(`launch:${id}`);
    try {
      const game = await api('launch:start', id, { skinClose });
      state.games.set(game.id, game);
      A.emit('games');
      A.toast({ level: 'ok', title: '游戏已启动', scope: `game:${game.id}`, text: `${A.nm(id)} · Java ${game.java.major} · ${A.fmtMem(game.memory.max)}`, actions: [{ label: '查看日志', onClick: () => A.logs.open(game.id) }] });
    } catch (e) {
      if (e.cancelled) return;
      if (e.reason && e.reason.code === 'ALREADY_LAUNCHING') { A.toast({ level: 'info', text: `「${A.nm(id)}」正在启动，稍等一下`, duration: 2500, noLog: true }); return; }
      const needLogin = /(重新登录|登录信息已失效)[。！]?$/.test(e.message); // 看句子结尾：配置名里有这几个字不算
      A.toast({
        level: 'crit', title: '启动失败', text: e.message, scope: `launch:${id}`,
        actions: needLogin ? [{ label: '重新登录', onClick: () => go('accounts') }] : [{ label: '查看日志', onClick: () => A.logs.open() }],
      });
    }
  }

  function setupWindow() {
    const btns = $$('.win-ctrls button');
    const [min, max, close] = btns;
    min.append(icon('minus', 16));
    max.append(icon('square', 14));
    close.append(icon('x', 16));
    min.addEventListener('click', () => api('win:minimize'));
    max.addEventListener('click', () => api('win:maximize'));
    close.addEventListener('click', () => api('win:close'));
    const setMax = (m) => { A.clear(max).append(icon(m ? 'restore' : 'square', 14)); max.title = m ? '还原' : '最大化'; };
    A.listen('win:maximized', setMax);
    api('win:isMaximized').then(setMax).catch(() => {});
    $('.titlebar').addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; api('win:maximize'); });
    // 顶栏始终固定；页面滚动后加底色，内容从下面经过时不会透出来
    $('#pages').addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('active')) syncTitlebar(e.target); }, true);
  }

  function syncTitlebar(page) {
    $('.titlebar').classList.toggle('tb-solid', !!page && page.scrollTop > 4);
  }

  function initBack() {
    const b = $('#btnBack');
    if (!b) return;
    b.append(icon('chevronLeft', 18), h('span', t('common.back')));
    b.addEventListener('click', () => goBack());
  }

  // 这些设置变了，侧边栏不用重画（1-6）
  const NAV_QUIET = new Set(['selectedVersion', 'versionSettings']);
  async function boot() {
    document.title = A.BRAND.name;
    document.documentElement.lang = window.I18N.getLang();
    $('#brandName').textContent = A.BRAND.short;
    $('#brandSub').textContent = A.BRAND.tagline;
    $('#nav').setAttribute('aria-label', t('nav.label'));
    A.brandLogo.apply();
    setupWindow();
    initBack();
    const [config, info] = await Promise.all([api('config:get'), api('app:info')]);
    state.config = config;
    state.info = info;
    // 内部版的窗口标题（任务栏上看得到）标「内部版」，和公开版装在一起时分得清
    if (info.edition !== 'public') document.title = A.BRAND.name + (window.I18N_TRANSLATE ? window.I18N_TRANSLATE.tr('（内部版）') : '（内部版）');
    applyTheme(config);
    A.brandLogo.apply(); // 性能模式开着时换成 2D 版

    // 向导开着时主进程发的通知、向导里改的设置都不能丢
    on('config', (c, changed) => { if (!A.configMatters(changed)) return; applyTheme(c); if (!changed || changed.some((x) => !NAV_QUIET.has(x))) renderNav(); });
    on('accounts', renderSideAccount);
    on('installed', () => { for (const id of [...installedToasts.keys()]) if (!state.installed.some((v) => v.id === id)) dropInstalled(id); });
    on('task', (t) => { if ((t.kind === 'install' || t.kind === 'cleared' || A.tasks.isRun(t)) && navCounts().join('/') !== navKey) renderNav(); });
    on('plannerUnfinished', () => renderNav());

    A.listen('game:exit', (g) => { if (g && g.id) A.dismissToasts(`game:${g.id}`); });
    A.listen('versions:changed', () => A.refreshInstalled());
    // 配置卡片上有 Mod 数量（1.10.8）。连着点几个开关时合并成一次
    A.listen('mods:changed', A.debounce(() => A.refreshInstalled().catch(() => {}), 300));
    A.listen('accounts:changed', () => A.refreshAccounts());
    A.listen('notify', async (n) => {
      if (n.version) { await installedNotice(n); return; }
      const actions = n.path ? [{ label: '在文件夹中显示', onClick: () => api('shell:showItem', n.path) }] : undefined;
      A.toast({ level: n.level || n.type, title: n.title, text: n.text, actions, scope: n.taskId ? [`task:${n.taskId}`, `taskTitle:${n.taskTitle}`] : undefined });
    });

    await Promise.all([A.refreshInstalled(), A.refreshAccounts().catch(() => {})]);
    await A.tasks.init();
    A.notifCenter.init();
    await A.logs.init();
    // 设置、账户这些数据文件读坏 / 读不了时要告诉玩家（core/jsonstore.js，1.10.7）。排在免责声明和向导之前：读坏后走向导时玩家得知道为什么
    const dataNotice = (n) => A.toast({ level: n.level, title: n.title, text: n.text, sticky: true, actions: n.path ? [{ label: '在文件夹中显示', onClick: () => api('shell:showItem', n.path) }] : undefined });
    A.listen('data:notice', dataNotice);
    // 主进程自己改了设置（移除 / 卸载默认的 Java 等）（1.10.8）
    A.listen('config:changed', A.adoptConfig);
    for (const n of await api('app:dataNotices').catch(() => [])) dataNotice(n);

    renderNav();
    renderSideAccount();
    A.simple.guard(['debugDialog', 'installDialog', 'newProfileDialog', 'nostalgiaDialog', 'modpackInstallDialog', 'importModpackFile', 'vanillaPlusPanel']);
    A.offline.guard(['installDialog', 'newProfileDialog', 'nostalgiaDialog', 'modpackInstallDialog', 'importModpackFile']);
    A.offline.init();
    A.langUi.init();
    go('home');
    A.fontWarm.start(); // 空闲时把界面用到的字体、字重先读进来，第一次切页面不用等（fontwarm.js）
    // 首次运行的免责声明 → 运行位置检测 → 首次启动向导或没有 Java 的提醒，都关掉后再开始播放背景音乐
    await A.disclaimer();
    await A.placeCheck.run();
    if (!state.config.setupDone) await A.setup.open({ firstRun: true });
    else if (state.config.pendingJava) {
      // 向导里选了安装推荐的 Java 又换了数据位置：重启后在这里开始下载
      A.javaCheck.install(state.config.pendingJava, 21);
      A.setConfig({ pendingJava: '', tips: { noJava: true } });
    } else A.javaCheck.prompt();
    if (state.config.migrateAsk) A.migrateUi.offer();
    halfPackAsk().catch(() => {});
    // 推荐过背景档位、而且硬件变了：角落轻提示重新推荐（性能打磨）
    setTimeout(() => A.bgPerf.watch().catch(() => {}), 4000);
    A.ultimate.init(); // 终极彩蛋的挂机计时（ultimate.js）
    if (!A.simple.on() && !A.perf.on()) A.music.init().catch(() => {});
    A.gameSound.initButton(); // 顶栏的音效开关（rc3）
    if (!A.simple.on()) A.mcmodUi.checkConsent();

    // 后台加载
    A.refreshJavas(false).catch(() => {});
    A.listen('java:changed', () => A.refreshJavas(true).catch(() => {})); // 任何地方装好了 Java，主页、配置页都要知道（1.10.5）
    api('versions:manifest', false).then((m) => { state.manifest = m; A.emit('manifest', m); }).catch(() => {});
    api('mirror:label').then((l) => { state.mirrorLabel = l; A.emit('mirror'); }).catch(() => {});
    // 只在窗口前台时刷新可用内存（内存条显示用）
    setInterval(async () => { if (document.hidden || !document.hasFocus()) return; try { const m = await api('sys:memory'); state.info.freeMem = m.free; } catch { /* ignore */ } }, 15000);


    window.addEventListener('keydown', (e) => {
      if (A.a11y.zoomKey(e)) return;
      if (e.target.matches('input, textarea')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); A.logs.toggle(); }
      // 弹窗开着时不切页、不启动：确认框还在等回答，后面的页面不该动
      const modalOpen = !!document.querySelector('.modal-back:not(.closing)');
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); const v = A.currentVersion(); if (v && !modalOpen) launch(v.id); }
      if (e.ctrlKey && /^[1-9]$/.test(e.key) && !modalOpen) {
        const pages = navItems().filter((n) => n !== '-');
        const p = pages[Number(e.key) - 1];
        if (p) go(p.id);
      }
    });
    window.addEventListener('resize', A.debounce(renderNav, 200));
    // 窗口失去焦点时暂停装饰动画（style.css 的 html.win-blur）
    const syncFocus = () => document.documentElement.classList.toggle('win-blur', !document.hasFocus());
    window.addEventListener('blur', syncFocus);
    window.addEventListener('focus', syncFocus);
    syncFocus();
  }

  // 安装完成的通知：有 Mod 加载器的配置多给一个「一键 Debug」；安装时勾了自动 Debug 就直接开始
  async function installedNotice(n) {
    let v = state.installed.find((x) => x.id === n.version);
    if (!v) { await A.refreshInstalled().catch(() => {}); v = state.installed.find((x) => x.id === n.version); }
    const actions = [{ label: '立即启动', onClick: () => launch(n.version) }];
    if (v && v.loader && !n.autoDebug && !n.component) actions.push({ label: t('term.debug'), onClick: () => A.debugDialog(v) });
    if (n.component && n.component.ts) actions.push({ label: '撤销', onClick: () => A.components.undo(n.version, n.component.ts) });
    if (n.component) dropInstalled(n.version); // 又改了一次组件：旧提示上的「撤销」对应的不是最新一次了
    const close = A.toast({ level: n.level || n.type, title: n.title, text: n.autoDebug && v ? `${n.version} 已安装，正在${t('term.debug')}` : n.text, actions });
    installedToasts.set(n.version, [...(installedToasts.get(n.version) || []), close]);
    if (n.autoDebug && v && v.loader) A.debugDialog(v, { auto: true });
    // 没有能运行它的 Java 时提醒一下，可以现在就下载
    A.javaCheck.afterInstall(n.version);
  }

  A.go = go;
  A.goBack = goBack;
  A.hooks.goBack = goBack;
  A.launch = launch;
  A.installedNotice = installedNotice;
  boot().catch((e) => {
    console.error(e);
    document.body.appendChild(h('div', { style: { position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--text)', zIndex: 9999 } },
      h('div', { style: { textAlign: 'center' } }, h('h2', '启动器初始化失败'), h('p.muted', e.message))));
  });
})();
