'use strict';
/* 通用 UI 组件：提示、行内提醒、模态框、危险确认、步骤条、选择卡片、弹出菜单、下拉选择、开关、分段控件、滑块、提示气泡 */
(function () {
  const { h, icon, $, t } = A;

  // ── Toast（等级见 core.js 的 LEVELS；opts.level 或旧写法 opts.type 都可以）──
  // ───────────── 界面底层小件（2.0.0-pre7）：元素只建一次，之后只改文字和宽度 ─────────────
  /** 文字变了才写（比的是原文：翻译器改过的节点，textContent 已经不是原文了） */
  function setText(node, text) {
    if (node.__src === text) return;
    node.__src = text;
    const only = node.childNodes.length === 1 ? node.firstChild : null;
    if (only && only.nodeType === 3) only.nodeValue = text; else node.textContent = text; // 改文字节点就够了，不用换节点
  }
  /** 进度条。set(0~100) 改宽度，set(null) 是不确定进度 */
  function progressBar({ mini = false, value = null, style } = {}) {
    const bar = h('i');
    const el = h(`div.progress${mini ? '.mini' : ''}`, style ? { style } : {}, bar);
    let shown;
    el.set = (v) => {
      if (v === shown) return;
      shown = v;
      el.classList.toggle('indeterminate', v == null);
      bar.style.width = v == null ? '' : `${v}%`;
    };
    el.set(value);
    return el;
  }
  /** 按键更新一组子元素：make(item) 返回 { el, update(item) }。已有的只调 update，顺序变了才挪动，鼠标提示和选中的文字都不会丢 */
  function keyedList(parent, items, keyOf, make) {
    const rows = parent.__rows || (parent.__rows = new Map());
    const keep = new Set();
    let at = parent.__rowsStart ? parent.__rowsStart.nextSibling : parent.firstChild;
    for (const item of items) {
      const k = keyOf(item);
      keep.add(k);
      let row = rows.get(k);
      if (!row) { row = make(item); rows.set(k, row); }
      row.update(item);
      if (row.el === at) at = at.nextSibling;
      else parent.insertBefore(row.el, at);
    }
    for (const [k, row] of rows) if (!keep.has(k)) { row.el.remove(); rows.delete(k); }
  }

  // 提示的规则都在这里（2.0.0-pre7）：
  // - 常驻的只有：错误（crit）、要玩家处理的警告（warn 带按钮、没写 duration）、明确写了 sticky: true（要玩家做决定的）。其他定时消失，鼠标停在上面时暂停
  // - 同样的提示不叠：还在屏幕上就重新计时
  // - scope（字符串或数组）：事情解决了由代码一起收起，A.dismissToasts('launch:配置名')
  const liveToasts = new Map(); // 去重键 → { close, restart, scopes }
  function dismissToasts(scope) {
    for (const t of [...liveToasts.values()]) if (t.scopes.includes(scope)) t.close.dismiss();
  }
  function toast(opts) {
    if (typeof opts === 'string') opts = { text: opts };
    const lv = A.level(opts.level || opts.type);
    const key = opts.key || `${lv}|${opts.title || ''}|${opts.text || ''}`;
    const same = liveToasts.get(key);
    if (same && same.el.isConnected && !same.el.classList.contains('out')) { same.restart(); return same.close; }
    const hasActions = !!(opts.actions && opts.actions.length);
    // 都记进通知中心（「已复制」这类 3 秒内的小提示除外）
    const sticky = opts.sticky != null ? !!opts.sticky : (lv === 'crit' || (lv === 'warn' && hasActions && !opts.duration));
    const duration = opts.duration || (hasActions ? 9000 : 4500);
    const center = A.hooks.recorder;
    const record = center && !opts.noLog && !(opts.duration && opts.duration < 3000) ? center.add({ ...opts, level: lv }) : null;
    const el = h('div', { class: `toast ${lv}${sticky ? ' sticky' : ''}`, role: lv === 'crit' ? 'alert' : 'status' },
      h('div.t-ico', A.levelIcon(lv, 18)),
      h('div', { style: { flex: 1, minWidth: 0 } },
        opts.title ? h('div.t-title', opts.title) : null,
        opts.text ? h('div.t-text', opts.text) : null,
        opts.actions ? h('div.t-actions', opts.actions.map((a) => h('button.btn.sm', {
          onclick: (e) => { e.stopPropagation(); a.onClick(); if (record) center.markRead(record.id); close(); },
        }, a.label))) : null),
      sticky
        ? h('button.t-close', { title: '关闭', 'aria-label': '关闭', onclick: (e) => { e.stopPropagation(); if (record) center.markRead(record.id); close(); } }, icon('x', 14))
        : h('div.t-bar', { style: { animationDuration: `${duration}ms` } }));
    let timer = sticky ? null : setTimeout(close, duration);
    if (!sticky) {
      el.addEventListener('mouseenter', () => { clearTimeout(timer); el.querySelector('.t-bar').style.animationPlayState = 'paused'; });
      el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2000); });
      el.addEventListener('click', close);
    }
    function close() {
      clearTimeout(timer);
      if (el.classList.contains('out')) return;
      if (liveToasts.get(key) && liveToasts.get(key).close === close) liveToasts.delete(key);
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
    }
    close.dismiss = () => { if (record) center.markRead(record.id); close(); }; // 事情已经解决时由代码收起，通知中心里也算读过
    const restart = () => {
      if (sticky || el.classList.contains('out')) return;
      clearTimeout(timer);
      timer = setTimeout(close, duration);
      const bar = el.querySelector('.t-bar');
      if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; bar.style.animationDuration = `${duration}ms`; }
    };
    liveToasts.set(key, { close, restart, el, scopes: [].concat(opts.scope || []) });
    const root = $('#toastRoot');
    root.appendChild(el);
    // 超过 5 条先挤掉会自动消失的；挤掉的重要通知在通知中心里还能找到
    while (root.children.length > 5) {
      const old = root.querySelector(':scope > .toast:not(.sticky)') || root.firstChild;
      for (const [k, v] of liveToasts) if (v.el === old) liveToasts.delete(k);
      old.remove();
    }
    return close;
  }
  const errorToast = (title, e) => {
    if (e && e.cancelled) return;
    const hint = e && e.reason && e.reason.hint;
    toast({ level: 'crit', title, text: `${(e && e.message) || String(e || '')}${hint ? `\n建议：${hint}` : ''}` });
  };

  /** 给玩家看的原因：认得出是哪一类错误就说原因（「无法解析服务器地址」），认不出才显示原始信息（以前断网时只有 net::ERR_…） */
  const errText = (e) => {
    const r = e && e.reason;
    return (r && r.code && r.code !== 'UNKNOWN' && r.message) || (e && e.message) || String(e || '');
  };
  /** 行内显示错误：标题、原因、建议 */
  const errInline = (title, e, attrs) => {
    const hint = e && e.reason && e.reason.code !== 'UNKNOWN' && e.reason.hint;
    return h('div.err', attrs || {}, h('div', title), h('div', errText(e)), hint ? h('div.faint', hint) : null);
  };

  /** 行内提醒块（替代各页面各写一套的提示条），level 决定颜色与图标 */
  function alert({ level: lv = 'info', title, text, actions, icon: ic, compact, className } = {}) {
    const L = A.level(lv);
    const sz = compact ? 15 : 17;
    return h('div', { class: `alert ${L}${compact ? ' compact' : ''}${className ? ` ${className}` : ''}` },
      ic ? icon(ic, sz) : A.levelIcon(L, sz),
      h('div.alert-body', title ? h('div.alert-title', title) : null, text ? h('div.alert-text', text) : null),
      actions && actions.length ? h('div.alert-actions', actions) : null);
  }

  /** 小号步骤条（对话框里的多步流程用）：items = ['选择类型', …]，current 从 0 开始 */
  function steps(items, current) {
    return h('ol.msteps', { 'aria-label': `${current + 1} / ${items.length}` }, items.map((label, i) => h('li', {
      class: i < current ? 'done' : i === current ? 'on' : '',
      'aria-current': i === current ? 'step' : null,
    }, h('span.ms-num', i < current ? icon('check', 12, 3) : String(i + 1)), h('span.ms-label', label))));
  }

  /**
   * 选择卡片（新建配置、隔离预设、首次启动向导等共用）
   * layout = 'row'（图标在左）或 'tile'（图标在上、居中）
   */
  function choice({ img, iconName, title, desc, on, disabled, badge, layout = 'row', onClick }) {
    return h('button', {
      type: 'button', class: `choice ${layout}${on ? ' on' : ''}`, disabled: !!disabled,
      'aria-pressed': on == null ? null : String(!!on), onclick: onClick,
    },
    img ? h('img.ch-img', { src: img, alt: '' }) : iconName ? h('span.ch-ico', icon(iconName, 18)) : null,
    h('span.ch-body', h('span.ch-title', title, badge || null), desc ? h('span.ch-desc', desc) : null));
  }

  // ── Modal ──
  // 对话框尺寸档位：sm 简单确认 / md 表单 / lg 选择与列表 / xl 复杂流程
  const SIZES = { sm: 440, md: 560, lg: 720, xl: 880 };
  const modalStack = [];
  let modalSeq = 0;
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])';
  function modal({ title, subtitle, body, actions, width, size, icon: headIcon, level: lv, steps: stepInfo, onClose, dismissable = true, className }) {
    let closed = false;
    const opener = document.activeElement;
    const titleId = `modal-title-${++modalSeq}`;
    const w = SIZES[size] || width || SIZES.md;
    const back = h('div.modal-back');
    const box = h('div', { class: `modal ${className || ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : null, tabindex: '-1', style: { width: `${w}px` } });
    const close = (result) => {
      if (closed) return;
      closed = true;
      back.classList.add('closing');
      setTimeout(() => back.remove(), 180);
      const i = modalStack.indexOf(api);
      if (i >= 0) modalStack.splice(i, 1);
      // 焦点回到打开对话框的控件，键盘和读屏用户不会「迷路」
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      if (onClose) onClose(result);
      // 对话框关上了（还剩几个开着）：背后的页面要是被对话框里的操作改了，可以在这时按新的样子重画（rc16）
      A.emit('modalClosed', modalStack.length);
    };
    const foot = h('div.modal-foot');
    const renderActions = (list) => {
      A.clear(foot);
      for (const a of list || []) {
        const b = h('button', {
          class: `btn ${a.kind || ''} ${a.left ? 'left' : ''}`,
          onclick: async () => {
            if (!a.onClick) return close(a.value);
            b.disabled = true;
            try {
              const r = await a.onClick(api);
              if (r !== false) close(a.value);
            } catch (e) {
              errorToast(a.errorTitle || '操作失败', e);
            } finally { b.disabled = false; }
          },
        }, a.icon ? icon(a.icon, 16) : null, a.label);
        foot.appendChild(b);
        if (a.ref) a.ref(b);
      }
      foot.classList.toggle('hidden', !(list && list.length));
    };
    // 标题图标：传等级时用等级图标，传图标名时用统一的图标底座，也兼容直接传元素
    let ico = null;
    if (lv) ico = h('div', { class: `modal-ico ${A.level(lv)}` }, A.levelIcon(lv, 20));
    else if (typeof headIcon === 'string') ico = h('div.modal-ico', icon(headIcon, 20));
    else if (headIcon) ico = headIcon;
    const stepsEl = h('div.modal-steps');
    const setSteps = (s) => { A.mount(stepsEl, s && s.items ? steps(s.items, s.current || 0) : null); };
    setSteps(stepInfo);
    box.append(
      h('div.modal-head',
        ico,
        h('div', { style: { flex: 1, minWidth: 0 } }, title ? h('h2', { id: titleId }, title) : null, subtitle ? h('p', subtitle) : null, stepsEl),
        dismissable ? h('button.btn.ghost.icon.sm.x', { onclick: () => close(), 'aria-label': t('common.close') }, icon('x', 18)) : null),
      h('div.modal-body', body),
      foot);
    renderActions(actions);
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back && api.dismissable) close(); });
    // 焦点留在对话框里：Tab 到最后一个控件后回到第一个
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const list = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.appendChild(back);
    // 流程结束后把右上角的关闭按钮和点背景关闭加回来（一键 Debug、临时换 Java 测试做完后要能直接回去，1.4.7）
    const setDismissable = (v) => {
      api.dismissable = !!v;
      const head = box.querySelector('.modal-head');
      const x = head.querySelector('.x');
      if (v && !x) head.appendChild(h('button.btn.ghost.icon.sm.x', { onclick: () => close(), 'aria-label': t('common.close') }, icon('x', 18)));
      if (!v && x) x.remove();
    };
    const api = { close, el: box, body: box.querySelector('.modal-body'), setActions: renderActions, setSteps, setDismissable, dismissable };
    modalStack.push(api);
    setTimeout(() => {
      // 第一个输入框在可见区域里才聚焦它，否则聚焦对话框本身，免得打开时内容被滚到底部
      const f = box.querySelector('input:not([type=checkbox]), textarea');
      const bodyEl = box.querySelector('.modal-body');
      const visible = f && f.getBoundingClientRect().bottom <= bodyEl.getBoundingClientRect().bottom;
      (visible ? f : box).focus({ preventScroll: true });
    }, 60);
    return api;
  }
  /** 关掉最上面那个能关的对话框（Esc、顶栏「返回」、鼠标侧键共用），关了返回 true */
  function closeTopModal() {
    if (closePopover()) return true;
    const top = modalStack[modalStack.length - 1];
    if (top && top.dismissable) { top.close(); return true; }
    return false;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTopModal();
    // Alt+←：返回上一个页面（app.js）
    if (e.key === 'ArrowLeft' && e.altKey && A.hooks.goBack) { e.preventDefault(); A.hooks.goBack(); }
  });
  // 鼠标侧键「后退」
  window.addEventListener('mouseup', (e) => { if (e.button === 3 && A.hooks.goBack) { e.preventDefault(); A.hooks.goBack(); } });

  /** 确认框：level 显示等级图标（danger: true 相当于 crit），icon 显示功能图标 */
  function confirm(text, { title = '确认', okText = t('common.ok'), danger = false, level: lv, icon: headIcon, detail, size = 'sm' } = {}) {
    return new Promise((resolve) => {
      modal({
        title,
        size,
        level: lv || (danger ? 'crit' : null),
        icon: headIcon,
        body: h('div', h('p.confirm-text', text), detail || null),
        actions: [
          { label: t('common.cancel'), kind: 'ghost', value: false },
          { label: okText, kind: danger ? 'solid-danger' : 'primary', value: true },
        ],
        onClose: (v) => resolve(!!v),
      });
    });
  }

  /**
   * 危险操作确认
   * level 2：一次确认，用于进回收站等还能恢复的操作
   * level 3：两步确认，用于存档等玩家数据或无法恢复的操作——
   *   第一步列出受影响的内容（可勾选「先备份」），第二步再弹一次，确认按钮 5 秒后才能点
   *   （rc3：不再要玩家打字输入名字，也不用勾选；confirmName 只用来在第二步写清楚是哪一个）
   * 返回 Promise：取消时为 false，确认时为 { backup: 是否勾选了先备份 }
   */
  function dangerConfirm({ level: dl = 2, title, text, items = [], note, noteLevel = 'warn', okText = t('common.delete'), confirmName, backup }) {
    return new Promise((resolve) => {
      let result = false;
      const backupBox = backup ? h('input', { type: 'checkbox', checked: backup.checked !== false }) : null;
      const getResult = () => ({ backup: !!(backupBox && backupBox.checked) });
      const itemEls = items.length ? h('div.danger-items', h('div.danger-head', t('danger.affected')), items.map((it) => h('div', { class: `danger-item${it.keep ? ' keep' : ''}` },
        icon(it.icon || 'file', 16), h('div.di-body', h('div.di-label', it.label), it.sub ? h('div.di-sub', it.sub) : null)))) : null;
      const body = h('div.danger-box',
        text ? h('p.confirm-text', text) : null,
        itemEls,
        note ? alert({ level: noteLevel, text: note, compact: true }) : null,
        backupBox ? h('label.check-row', backupBox, h('span', backup.label || t('danger.backupFirst'))) : null);
      const m = modal({
        title, size: 'md', level: 'crit', body,
        actions: [
          { label: t('common.cancel'), kind: 'ghost' },
          {
            label: dl >= 3 ? t('common.continue') : okText, kind: dl >= 3 ? 'danger' : 'solid-danger',
            onClick: () => {
              if (dl < 3) { result = getResult(); return true; }
              step2();
              return false;
            },
          },
        ],
        onClose: () => resolve(result),
      });

      function step2() {
        const keep = getResult();
        // 调试菜单解除安全限制时不用等（1.5.7）
        let left = A.hooks.noDangerWait && A.hooks.noDangerWait() ? 0 : 5;
        let okBtn = null;
        const can = () => left <= 0;
        const refresh = () => {
          if (!okBtn) return;
          okBtn.disabled = !can();
          okBtn.lastChild.textContent = left > 0 ? t('danger.wait', { n: left }) : okText;
        };
        A.mount(m.body, h('div.danger-box',
          text ? h('p.confirm-text', text) : null,
          alert({ level: 'crit', compact: true, text: confirmName ? t('danger.lastCheckNamed', { name: A.nm(confirmName), action: okText }) : t('danger.lastCheck', { action: okText }) })));
        m.el.querySelector('.modal-head h2').textContent = t('danger.step2Title');
        m.setActions([
          { label: t('common.cancel'), kind: 'ghost' },
          { label: okText, kind: 'solid-danger', ref: (b) => { okBtn = b; }, onClick: () => { if (!can()) return false; result = keep; return true; } },
        ]);
        const timer = setInterval(() => { left--; refresh(); if (left <= 0) clearInterval(timer); }, 1000);
        refresh();
        // 焦点放在「取消」上：倒计时结束时手还按着回车也不会直接确认
        setTimeout(() => { const c = m.el.querySelector('.modal-foot .btn.ghost'); if (c) c.focus(); }, 60);
      }
    });
  }

  function prompt(title, { value = '', placeholder = '', label, hint, okText = t('common.ok'), validate } = {}) {
    return new Promise((resolve) => {
      const input = h('input.input', { value, placeholder, spellcheck: 'false', 'aria-label': label || title });
      const err = h('div.err.hidden', { role: 'alert' });
      let result = null;
      const m = modal({
        title,
        size: 'sm',
        body: h('div.field', label ? h('label', label) : null, input, hint ? h('div.hint', hint) : null, err),
        actions: [
          { label: t('common.cancel'), kind: 'ghost' },
          {
            label: okText, kind: 'primary', onClick: () => {
              const v = input.value.trim();
              const msg = validate ? validate(v) : null;
              if (msg) { err.textContent = msg; err.classList.remove('hidden'); return false; }
              result = v;
              return true;
            },
          },
        ],
        onClose: () => resolve(result),
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelector('.btn.primary').click(); });
      setTimeout(() => input.select(), 80);
    });
  }

  // ── Popover ──
  let openPop = null;
  function closePopover() {
    if (!openPop) return false;
    const p = openPop;
    openPop = null;
    p.el.remove();
    if (p.onClose) p.onClose();
    return true;
  }
  function popover(anchor, content, { align = 'left', width, onClose, placement, className } = {}) {
    closePopover();
    const el = h('div.popover', content);
    // 尺寸相关的类名必须在测量前加上，否则会按默认宽度定位导致超出窗口
    if (className) el.classList.add(...className.split(' '));
    if (width) el.style.width = `${width}px`;
    document.body.appendChild(el);
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (align === 'stretch') el.style.width = `${Math.max(r.width, width || 0)}px`;
      el.style.maxHeight = '';
      const pr = el.getBoundingClientRect();
      const below = vh - r.bottom - 16;
      const above = r.top - 16;
      const up = placement === 'top' || (pr.height > below && above > below);
      el.classList.toggle('up', up);
      const room = Math.max(160, up ? above : below);
      el.style.maxHeight = `${room}px`;
      const hgt = Math.min(pr.height, room);
      const top = up ? r.top - hgt - 6 : r.bottom + 6;
      let left = align === 'right' ? r.right - pr.width : r.left;
      left = Math.max(10, Math.min(left, vw - pr.width - 10));
      el.style.top = `${Math.max(10, top)}px`;
      el.style.left = `${left}px`;
    };
    place();
    openPop = { el, anchor, onClose, place };
    menuKeys(el, anchor);
    return { el, close: closePopover, reposition: place };
  }

  /** 弹出菜单的键盘操作：↑ ↓ Home End 移动，回车 / 空格选择，Esc 关闭，焦点回到打开它的按钮 */
  function menuKeys(el, anchor) {
    const items = () => [...el.querySelectorAll('.menu-item')].filter((x) => !x.classList.contains('disabled') && x.offsetParent !== null);
    const prep = () => { for (const x of el.querySelectorAll('.menu-item')) { x.tabIndex = -1; if (!x.getAttribute('role')) x.setAttribute('role', 'menuitem'); } };
    prep();
    new MutationObserver(prep).observe(el, { childList: true, subtree: true });
    el.addEventListener('keydown', (e) => {
      const list = items();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      const move = (n) => { e.preventDefault(); list[(n + list.length) % list.length].focus(); };
      if (e.key === 'ArrowDown') move(i + 1);
      else if (e.key === 'ArrowUp') move(i < 0 ? list.length - 1 : i - 1);
      else if ((e.key === 'Home' || e.key === 'End') && !e.target.matches('input')) move(e.key === 'Home' ? 0 : list.length - 1);
      else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); list[i].click(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); if (anchor.focus) anchor.focus(); }
      else if (e.key === 'Tab') { closePopover(); if (anchor.focus) anchor.focus(); }
    });
    // 有菜单项、没有搜索框时，把焦点放到当前选中的那项（键盘打开的菜单可以直接用方向键）
    setTimeout(() => {
      if (!el.isConnected || el.querySelector('input')) return;
      const first = el.querySelector('.menu-item.on') || items()[0];
      if (first) first.focus({ preventScroll: true });
    }, 0);
  }
  document.addEventListener('mousedown', (e) => {
    if (openPop && !openPop.el.contains(e.target) && !openPop.anchor.contains(e.target)) closePopover();
  }, true);
  window.addEventListener('resize', () => closePopover());
  window.addEventListener('blur', () => closePopover());

  /** 菜单：items = [{label, icon, sub, onClick, danger, on, img} | '-' | {head}] */
  function menu(anchor, items, opts = {}) {
    const list = h('div.menu');
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { list.appendChild(h('div.menu-sep')); continue; }
      if (it.head) { list.appendChild(h('div.menu-head', it.head)); continue; }
      list.appendChild(h('div', {
        class: `menu-item ${it.danger ? 'danger' : ''} ${it.on ? 'on' : ''}`,
        'data-simple-off': it.simpleOff ? '' : null, // 简洁模式下变灰（simplemode.js）
        'data-net': it.net ? '' : null, // 离线时变灰（offline.js）
        onclick: () => { closePopover(); if (it.onClick) it.onClick(); },
      },
      it.img ? h('img', { src: it.img }) : it.icon ? icon(it.icon, 16) : null,
      h('div.m-body', h('div.m-title', it.label), it.sub ? h('div.m-sub', it.sub) : null),
      it.on ? icon('check', 16) : null));
    }
    return popover(anchor, list, opts);
  }

  /** 下拉选择 */
  function select({ options, value, onChange, placeholder = '请选择', small, width, block, searchable, menuWidth }) {
    let cur = value;
    const label = h('span.label');
    // block：占满容器宽度（对话框里的下拉框都用它，不再各写各的像素宽度）
    const btn = h('button', { class: `select-btn ${small ? 'sm' : ''}`, type: 'button', 'aria-haspopup': 'listbox', style: block ? { width: '100%' } : width ? { width: `${width}px` } : null }, label, icon('chevronDown', 16));
    const render = () => {
      const o = options.find((x) => x.value === cur);
      label.textContent = o ? o.label : placeholder;
      label.classList.toggle('faint', !o);
    };
    btn.addEventListener('click', () => {
      if (btn.classList.contains('open')) { closePopover(); return; }
      btn.classList.add('open');
      const listEl = h('div.menu');
      const build = (q) => {
        A.clear(listEl);
        const ql = (q || '').toLowerCase();
        for (const o of options) {
          if (ql && !`${o.label} ${o.sub || ''}`.toLowerCase().includes(ql)) continue;
          if (o.head) { listEl.appendChild(h('div.menu-head', o.head)); continue; }
          listEl.appendChild(h('div', {
            class: `menu-item ${o.value === cur ? 'on' : ''}`, role: 'option', 'aria-selected': o.value === cur ? 'true' : 'false',
            onclick: () => { cur = o.value; render(); closePopover(); if (onChange) onChange(cur, o); },
          }, o.img ? h('img', { src: o.img }) : null, h('div.m-body', h('div.m-title', o.label), o.sub ? h('div.m-sub', o.sub) : null), o.value === cur ? icon('check', 16) : null));
        }
        if (!listEl.children.length) listEl.appendChild(h('div.menu-head', '没有匹配项'));
      };
      build('');
      const content = [];
      if (searchable && options.length > 8) {
        const s = h('input.input.sm', { placeholder: '搜索…', oninput: (e) => build(e.target.value) });
        content.push(h('div.menu-search', s));
        setTimeout(() => s.focus(), 30);
      }
      content.push(listEl);
      popover(btn, content, { align: 'stretch', width: menuWidth, onClose: () => btn.classList.remove('open') });
      const on = listEl.querySelector('.menu-item.on');
      if (on) on.scrollIntoView({ block: 'center' });
    });
    render();
    btn.setValue = (v) => { cur = v; render(); };
    btn.setOptions = (opts, v) => { options = opts; if (v !== undefined) cur = v; render(); };
    btn.getValue = () => cur;
    return btn;
  }

  function toggle(checked, onChange) {
    const input = h('input', { type: 'checkbox', role: 'switch', checked: !!checked });
    const el = h('label.switch', input, h('span.track'), h('span.thumb'));
    input.addEventListener('change', () => onChange && onChange(input.checked));
    el.set = (v) => { input.checked = !!v; };
    el.get = () => input.checked;
    return el;
  }

  function seg(options, value, onChange, { accent } = {}) {
    let cur = value;
    const el = h('div', { class: `seg ${accent ? 'accent' : ''}` });
    const render = () => {
      A.clear(el);
      for (const o of options) {
        el.appendChild(h('button', {
          class: o.value === cur ? 'on' : '',
          type: 'button',
          title: o.title || null,
          onclick: () => { if (cur === o.value) return; cur = o.value; render(); onChange && onChange(cur); },
        }, o.icon ? icon(o.icon, 16) : null, o.label));
      }
    };
    render();
    el.set = (v) => { cur = v; render(); };
    return el;
  }

  function range({ min, max, step = 1, value, onInput, onChange, disabled }) {
    const el = h('input.range', { type: 'range', min, max, step, value, disabled: !!disabled });
    const fill = () => { el.style.setProperty('--fill', `${((el.value - min) / (max - min)) * 100}%`); };
    el.addEventListener('input', () => { fill(); onInput && onInput(Number(el.value)); });
    el.addEventListener('change', () => onChange && onChange(Number(el.value)));
    fill();
    el.set = (v) => { el.value = v; fill(); };
    return el;
  }

  // ── Tooltip（data-tip 属性）──
  let tipEl = null;
  let tipTimer = null;
  document.addEventListener('mouseover', (e) => {
    // 简洁模式、离线模式下变灰的入口，提示要说为什么（它们在 tipBlocks 里登记）
    const block = e.target.closest ? A.hooks.tipBlocks.map((b) => { const el = b.on() && e.target.closest(b.selector); return el ? { el, tip: b.tip } : null; }).find(Boolean) : null;
    const t = block ? block.el : (e.target.closest && e.target.closest('[data-tip]'));
    clearTimeout(tipTimer);
    if (tipEl) { tipEl.remove(); tipEl = null; }
    if (!t) return;
    tipTimer = setTimeout(() => {
      tipEl = h('div.tooltip', block ? block.tip : A.nm(t.dataset.tip)); // data-tip 已经翻好了，里面可能有名字，不再过一次翻译器
      document.body.appendChild(tipEl);
      const r = t.getBoundingClientRect();
      const tr = tipEl.getBoundingClientRect();
      let top = r.top - tr.height - 8;
      if (top < 8) top = r.bottom + 8;
      tipEl.style.top = `${top}px`;
      tipEl.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8))}px`;
    }, 350);
  });
  document.addEventListener('mousedown', () => { clearTimeout(tipTimer); if (tipEl) { tipEl.remove(); tipEl = null; } });

  async function copy(text) {
    text = String(text).replace(/[\u2068\u2069]/g, ''); // 名字的翻译标记不带进剪贴板
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast({ level: 'ok', text: '已复制到剪贴板', duration: 1800 });
  }

  function drawer({ title, subtitle, img, body, width, onClose }) {
    const back = h('div.drawer-back');
    const panel = h('div.drawer', { style: width ? { width: `${width}px` } : null },
      h('div.drawer-head', img ? h('img', { src: img }) : null,
        h('div', { style: { flex: 1, minWidth: 0 } }, h('h2.ellipsis', title), subtitle ? h('div.muted', { style: { fontSize: '12.5px' } }, subtitle) : null),
        h('button.btn.ghost.icon.sm', { onclick: () => close() }, icon('x', 18))),
      h('div.drawer-body', body));
    back.appendChild(panel);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      back.classList.add('closing');
      setTimeout(() => back.remove(), 200);
      const i = modalStack.indexOf(apiObj);
      if (i >= 0) modalStack.splice(i, 1);
      if (onClose) onClose();
      A.emit('modalClosed', modalStack.length);
    }
    const apiObj = { close, el: panel, body: panel.querySelector('.drawer-body'), dismissable: true, drawer: true };
    modalStack.push(apiObj);
    return apiObj;
  }

  function closeDrawers() {
    for (const m of [...modalStack]) if (m.drawer) m.close();
  }

  function emptyState({ img, iconName, title, text, action }) {
    return h('div.empty',
      img ? h('img.art', { src: img }) : iconName ? h('div', { style: { color: 'var(--text-3)' } }, icon(iconName, 48, 1.5)) : null,
      h('h3', title), text ? h('p', text) : null, action || null);
  }

  /** 简易的 HTML 净化：只保留安全标签与属性 */
  const SAFE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'CODE', 'PRE', 'BLOCKQUOTE', 'IMG', 'HR', 'SPAN', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DEL', 'S', 'SUB', 'SUP']);
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const walk = (node) => {
      for (const child of [...node.children]) {
        if (!SAFE_TAGS.has(child.tagName)) {
          if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'LINK', 'META'].includes(child.tagName)) { child.remove(); continue; }
          walk(child);
          child.replaceWith(...child.childNodes);
          continue;
        }
        for (const attr of [...child.attributes]) {
          const n = attr.name.toLowerCase();
          const keep = (child.tagName === 'A' && n === 'href' && /^https?:/i.test(attr.value)) || (child.tagName === 'IMG' && n === 'src' && /^https:/i.test(attr.value)) || n === 'colspan';
          if (!keep) child.removeAttribute(attr.name);
        }
        if (child.tagName === 'A') child.setAttribute('target', '_blank');
        walk(child);
      }
    };
    walk(doc.body);
    const frag = document.createDocumentFragment();
    while (doc.body.firstChild) frag.appendChild(doc.body.firstChild);
    return frag;
  }

  /** 极简 Markdown 渲染（用于 Modrinth 项目介绍） */
  function markdown(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s)
      .replace(/!\[([^\]]*)\]\((https:[^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
    const out = [];
    let inList = false;
    for (const raw of String(md || '').split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (/^<\/?[a-z]/i.test(line.trim())) { out.push(line); continue; }
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      const li = line.match(/^\s*[-*+]\s+(.*)$/);
      if (!li && inList) { out.push('</ul>'); inList = false; }
      if (m) out.push(`<h${Math.min(3, m[1].length)}>${inline(m[2])}</h${Math.min(3, m[1].length)}>`);
      else if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(li[1])}</li>`); }
      else if (/^\s*(---|\*\*\*)\s*$/.test(line)) out.push('<hr>');
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (inList) out.push('</ul>');
    return sanitize(out.join('\n'));
  }

  const modalOpen = () => modalStack.length > 0;
  Object.assign(A, { setText, progressBar, keyedList, dismissToasts, toast, errorToast, errText, errInline, alert, steps, choice, modal, modalOpen, closeTopModal, confirm, dangerConfirm, prompt, popover, closePopover, menu, select, toggle, seg, range, copy, drawer, closeDrawers, emptyState, sanitize, markdown });
})();
