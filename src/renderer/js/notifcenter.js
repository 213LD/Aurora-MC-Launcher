'use strict';
/* 通知中心（1.4.10）：顶栏铃铛，看之前弹过的通知。toast 自动记进来（ui.js），保留最近 100 条，跨重启保留。
 * 通知上的按钮只在这次运行里有效（函数存不下来），重启后只留文字 */
(function () {
  const { h, icon, $ } = A;

  const KEY = 'aurora.notifications';
  const MAX = 100;
  let items = [];
  const actions = new Map(); // id → 这次运行里的按钮
  let pop = null;

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(v)) items = v.slice(0, MAX); } catch { items = []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX))); } catch { /* 存不了就只在这次运行里有 */ }
  }

  function add(opts) {
    const it = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, time: Date.now(), level: opts.level, title: opts.title || '', text: opts.text || '', read: false };
    items.unshift(it);
    if (items.length > MAX) {
      for (const old of items.slice(MAX)) actions.delete(old.id); // 按钮里带着闭包，通知没了就放掉
      items.length = MAX;
    }
    if (opts.actions && opts.actions.length) actions.set(it.id, opts.actions);
    save();
    renderBell();
    if (pop) renderList();
    return it;
  }
  function markRead(id) {
    const it = items.find((x) => x.id === id);
    if (it && !it.read) { it.read = true; save(); renderBell(); }
  }
  function markAllRead() {
    let changed = false;
    for (const it of items) if (!it.read) { it.read = true; changed = true; }
    if (changed) { save(); renderBell(); }
  }
  function clear() { items = []; actions.clear(); save(); renderBell(); renderList(); }

  const unread = () => items.filter((x) => !x.read).length;

  function renderBell() {
    const b = $('#btnBell');
    if (!b) return;
    const n = unread();
    const crit = items.some((x) => !x.read && x.level === 'crit');
    A.mount(b, icon('bell', 18), n ? h('span.count', { class: `count${crit ? ' crit' : ''}` }, n > 99 ? '99+' : n) : null);
    b.title = n ? `通知（${n} 条未读）` : '通知';
    b.setAttribute('aria-label', b.title);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const hm = d.toTimeString().slice(0, 5);
    if (d.toDateString() === now.toDateString()) return hm;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }

  let listEl = null;
  function renderList() {
    if (!listEl) return;
    if (!items.length) {
      A.mount(listEl, h('div.empty', { style: { padding: '30px 10px' } }, icon('bell', 34, 1.5), h('p', '还没有通知'), h('p.faint', { style: { fontSize: '12px', marginTop: '4px' } }, '安装完成、出错等提示会留在这里，弹窗关掉了也能回来看')));
      return;
    }
    A.mount(listEl, items.map((it) => {
      const acts = actions.get(it.id);
      return h('div', { class: `nc-item ${it.level}${it.read ? '' : ' unread'}` },
        h('div.nc-ico', A.levelIcon(it.level, 16)),
        h('div.nc-body',
          h('div.nc-head', h('b', it.title || it.text), h('span.nc-time', fmtTime(it.time))),
          it.title && it.text ? h('div.nc-text', it.text) : null,
          acts ? h('div.nc-actions', acts.map((a) => h('button.btn.sm', { onclick: () => { A.closePopover(); a.onClick(); } }, a.label))) : null));
    }));
  }

  function toggle() {
    if (pop) { A.closePopover(); return; }
    // 弹窗会盖住面板，里面的内容通知中心都有，打开时收起
    for (const el of document.querySelectorAll('#toastRoot .toast')) el.remove();
    listEl = h('div.nc-list');
    const head = h('div.tp-head', h('b', '通知'), h('div.row.gap-s',
      h('button.btn.ghost.sm', { onclick: clear }, '清空')));
    pop = A.popover($('#btnBell'), h('div.tp-wrap', head, listEl), { align: 'right', className: 'task-panel notif-panel', onClose: () => { pop = null; listEl = null; markAllRead(); } });
    renderList();
    pop.reposition();
  }

  function init() {
    $('#btnBell').addEventListener('click', toggle);
    renderBell();
  }

  load();
  A.notifCenter = { init, add, markRead, toggle, list: () => items.slice() };
  A.hooks.recorder = A.notifCenter;
})();
