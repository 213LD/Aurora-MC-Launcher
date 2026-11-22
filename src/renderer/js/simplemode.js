'use strict';
/* 简洁模式（1.7.0）：真正把不常用的功能收起来，只留下
 *   游戏启动（主页、游戏配置、Java）、存档管理、Mod 管理（启用 / 禁用和删除，不查冲突、不联网下载和查更新）、账户切换和改皮肤（账户页的皮肤按钮，没有单独的皮肤中心），以及设置。
 * 侧边栏只留这几个页面；别处的入口（配置卡片上的一键 Debug、Mod 配置器、下载、皮肤……）不藏起来，而是变灰，
 * 鼠标放上去提示要先关掉简洁模式，点了弹提示和「关闭简洁模式」按钮。
 * 和性能模式（perfmode.js）是两个独立的开关：开一个不会顺带开另一个。
 * 入口的写法：A.simple.mark(元素) 或 h(...) 里写 'data-simple-off': ''；开关切换时只改 <html class="simple">，不用重画界面 */
(function () {
  const { h, icon, state } = A;
  const PAGES = ['home', 'versions', 'mods', 'java', 'accounts', 'settings'];
  const DESC = '只留下最常用的：启动游戏、管理存档和 Java、启用 / 禁用或删除 Mod、切换账户和改皮肤。下载、Mod 配置器、一键修复、皮肤中心、背景音乐、主页动态背景和更新日志这些都会收起来，用到的地方会变灰。适合只想安安静静开游戏的时候。';
  const TIP = '简洁模式下不可用，关闭简洁模式后才能使用';

  const on = () => !!(state.config && state.config.simpleMode);
  const apply = () => document.documentElement.classList.toggle('simple', on());
  // 任务中心只是看进度，不算功能：侧边栏不显示，但别处的「打开任务中心」要能进去
  const allows = (page) => !on() || PAGES.includes(page);
  const canOpen = (page) => allows(page) || page === 'tasks';

  /** 把一个入口标成「简洁模式下不可用」（返回元素本身，方便写在 h() 里） */
  const mark = (el) => { if (el) el.setAttribute('data-simple-off', ''); return el; };

  /** 简洁模式下点了不可用的入口：提示一下，给个关掉的按钮 */
  function blocked() {
    A.toast({ level: 'info', title: '简洁模式下不可用', text: '这个功能在简洁模式里收起来了。', duration: 5000, noLog: true, scope: 'simple', actions: [{ label: '关闭简洁模式', onClick: () => set(false) }] });
  }
  /** 代码里的入口（不是按钮的地方）先问一下：能用返回 true，不能用就提示并返回 false */
  const check = () => { if (!on()) return true; blocked(); return false; };

  // 标了的入口在简洁模式下：点击、回车、空格都拦下来（捕获阶段，按钮自己的 onclick 收不到）
  const stop = (e) => {
    if (!on()) return;
    const el = e.target.closest && e.target.closest('[data-simple-off]');
    if (!el) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'mousedown') blocked();
  };
  document.addEventListener('click', stop, true);
  document.addEventListener('mousedown', stop, true);
  document.addEventListener('keydown', stop, true);

  /** 打开这些功能的函数（A.debugDialog 等）在简洁模式下先拦一下：入口没标到的地方（通知里的按钮、快捷操作）也不会打开 */
  function guard(names) {
    for (const n of names) {
      const fn = A[n];
      if (typeof fn !== 'function' || fn.simpleGuard) continue;
      A[n] = Object.assign(function (...args) { return check() ? fn.apply(this, args) : undefined; }, fn, { simpleGuard: true });
    }
  }

  /** 开 / 关简洁模式（开和关都先确认），返回是否改了 */
  async function set(enabled) {
    if (enabled === on()) return false;
    const ok = enabled
      ? await A.confirm(DESC, {
        title: '开启简洁模式', okText: '开启', icon: 'shrink', size: 'md',
        detail: h('p.faint', { style: { fontSize: '12.5px', marginTop: '8px' } }, '只是收起来，不会删除任何东西。想让启动器更省资源可以另外打开「性能模式」，两个开关互不影响。随时可以在「设置 → 启动器」或侧边栏下面的「简洁模式」关掉。'),
      })
      : await A.confirm('关掉以后所有页面和功能都会回来：下载、Mod 配置器、一键修复、皮肤中心、背景音乐、动态的主页背景和更新日志。', { title: '关闭简洁模式？', okText: '关闭简洁模式', icon: 'shrink' });
    if (!ok) return false;
    await A.setConfig({ simpleMode: enabled });
    if (!enabled) A.dismissToasts('simple');
    if (enabled && A.music && A.music.state && A.music.state.playing) A.music.stop();
    if (enabled && !PAGES.includes(state.page)) A.go('versions');
    if (!enabled && !A.perf.on() && A.music && !A.music.state.inited) A.music.init().catch(() => {});
    A.toast({ level: 'ok', text: enabled ? '已开启简洁模式' : '已关闭简洁模式，所有功能都回来了', duration: 2500, noLog: true });
    return true;
  }

  /** 侧边栏底部的「简洁模式」提示，点一下可以关（会先确认） */
  function sideChip(iconOnly) {
    if (!on()) return null;
    return h('button.nav-item.perf-chip', {
      onclick: () => set(false),
      'data-tip': iconOnly ? '简洁模式已开启，点击关闭' : '点击关闭简洁模式',
      'aria-label': '简洁模式已开启，点击关闭',
    }, icon('shrink', 20), h('span', '简洁模式 · 已开启'));
  }

  A.simple = { on, apply, allows, canOpen, mark, check, guard, set, sideChip, PAGES, DESC, TIP };
  A.hooks.tipBlocks.unshift({ on, selector: '[data-simple-off]', tip: TIP }); // 简洁模式的提示优先
})();
