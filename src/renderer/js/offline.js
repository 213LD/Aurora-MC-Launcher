'use strict';
/* 离线模式（1.8.0）：检测到断网自动切过来，需要联网的功能停用；网络恢复了自动切回去。
 * - 判断：系统的 online / offline 事件 + 主进程 sys:netProbe（试几个启动器本来就用的地址，任何一个有响应就算有网）。
 *   开机 2 秒后查一次；断网时每分钟查一次；系统说网通了、或者别处的请求报「网络错误」时马上查一次
 * - 停用的入口：标 'data-net': '' 的元素（菜单项写 net: true）变灰，悬停提示「没有网络」，点击在捕获阶段拦下；
 *   需要联网的页面（下载、Mod 配置器）A.go 拦下；打开下载类对话框的函数用 guard() 包住；代码里的入口用 A.offline.check()
 * - 不需要网的照常：启动游戏（文件都在的话）、离线账户、存档、Mod 启用禁用、设置……外置登录 / 正版账户连不上认证服务器时用上次的登录凭证
 * 和简洁模式（simplemode.js）是同一种做法，两边互不影响 */
(function () {
  const { state } = A;
  const PAGES = ['download', 'planner'];
  const TIP = '没有网络，联网后才能使用（启动器检测到断网，已切换到离线模式）';
  let offline = false;
  let timer = 0;
  let checking = null;

  const on = () => offline;
  const apply = () => document.documentElement.classList.toggle('offline', offline);
  const allows = (page) => !offline || !PAGES.includes(page);

  function blocked() {
    A.toast({ level: 'info', title: '现在没有网络', text: '这个功能要联网才能用。网络恢复后启动器会自动切回来。', duration: 5000, noLog: true });
  }
  /** 代码里的入口先问一下：有网返回 true；没网提示并返回 false */
  const check = () => { if (!offline) return true; blocked(); return false; };

  function set(v) {
    if (v === offline) return;
    offline = v;
    apply();
    clearInterval(timer);
    if (offline) {
      timer = setInterval(probe, 60000);
      if (PAGES.includes(state.page)) A.go('home'); // 正在下载页 / 配置器里就回主页
      A.toast({ level: 'warn', title: '网络不可用，已切换到离线模式', text: '下载、在线搜索、登录这些要联网的功能先停用了（变灰）；启动游戏、存档、Mod 启用禁用照常能用。网络恢复后会自动切回来。', duration: 8000 });
    } else {
      A.toast({ level: 'ok', text: '网络恢复了，联网功能已经重新打开', duration: 3500, noLog: true });
    }
    A.emit('offline', offline);
  }

  /** 真的去试一下有没有网（同一时间只查一次） */
  function probe() {
    if (checking) return checking;
    checking = A.api('sys:netProbe').then((ok) => { set(!ok); return ok; }).catch(() => true).finally(() => { checking = null; });
    return checking;
  }

  window.addEventListener('offline', () => set(true));
  window.addEventListener('online', () => probe());
  /** 别处的请求报网络错误时调用（core.js 的 api 包装里），可能是刚断网 */
  const hint = () => { if (!offline) probe(); };

  // 标了 data-net 的入口在离线时：点击、回车、空格都拦下（捕获阶段）
  const stop = (e) => {
    if (!offline) return;
    const el = e.target.closest && e.target.closest('[data-net]');
    if (!el) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'mousedown') blocked();
  };
  document.addEventListener('click', stop, true);
  document.addEventListener('mousedown', stop, true);
  document.addEventListener('keydown', stop, true);

  /** 打开下载类对话框的函数在离线时先拦一下 */
  function guard(names) {
    for (const n of names) {
      const fn = A[n];
      if (typeof fn !== 'function' || fn.offlineGuard) continue;
      A[n] = Object.assign(function (...args) { return check() ? fn.apply(this, args) : undefined; }, fn, { offlineGuard: true });
    }
  }

  /** 开机：系统说没网就直接切；否则稍后真的试一次 */
  function init() {
    if (navigator.onLine === false) set(true);
    setTimeout(probe, 2000);
  }

  A.offline = { on, apply, allows, check, guard, init, probe, hint, TIP, PAGES };
  A.hooks.netError = hint;
  A.hooks.tipBlocks.push({ on, selector: '[data-net]', tip: TIP });
})();
