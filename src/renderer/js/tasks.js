'use strict';
/* 任务：标题栏两个进度圈（下载 / 运行中的任务）、各自的弹出面板、下载管理页（共用一套增量更新的任务卡片）
 * 1.4.9：启动、测试启动、一键 Debug、二分排查（kind launch / test）不再混进下载，单独放「运行中的任务」 */
(function () {
  const { h, icon, api, state, emit, fmtSpeed, fmtEta, fmtBytes, $ } = A;

  const KIND_LABEL = { install: '安装', java: 'Java', mod: 'Mod', launch: '启动', complete: '补全', test: '测试', export: '导出', backup: '备份', mcmod: 'MC 百科', component: '组件', migrate: '迁移', generic: '任务' };
  const isRun = (t) => t.kind === 'launch' || t.kind === 'test' || t.kind === 'mcmod';
  const isDownload = (t) => !isRun(t);
  // 真的会开游戏的任务（背景音乐自动暂停只看这些；建 MC 百科缓存也放在运行面板里，但不开游戏，1.5.7）
  // 比上一次写进去的原文，不比界面上的文字：英文界面上的是翻译后的，永远不相等，每次都写一遍，翻译器又翻一遍
  const { setText, keyedList, progressBar } = A;
  const isGame = (t) => t.kind === 'launch' || t.kind === 'test';
  // 两组的按钮、面板文字；其余逻辑共用
  const GROUPS = {
    download: { btn: () => $('#btnTasks'), filter: isDownload, idle: 'download', title: '下载任务', empty: '暂无下载任务' },
    run: { btn: () => $('#btnRun'), filter: isRun, idle: 'zap', title: '运行中的任务', empty: '没有正在运行的任务', emptySub: '启动游戏、测试启动、一键 Debug、二分排查会显示在这里' },
  };

  // ───────────────────────── 标题栏按钮（进度圈只创建一次） ─────────────────────────
  const ringEls = {};
  function buildButton(g) {
    const b = GROUPS[g].btn();
    const R = 7;
    const C = 2 * Math.PI * R;
    const t = document.createElement('template');
    t.innerHTML = `<svg class="tb-ring" viewBox="0 0 18 18">
      <circle cx="9" cy="9" r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="2.4"/>
      <circle class="ring-fg" cx="9" cy="9" r="${R}" fill="none" stroke="var(--accent-2)" stroke-width="2.4" stroke-linecap="round"
        stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 9 9)"/></svg>`;
    const ring = t.content.firstChild;
    const idleIcon = icon(GROUPS[g].idle, 18);
    const label = h('span.tb-pct');
    const count = h('span.count.hidden');
    A.mount(b, idleIcon, ring, label, count);
    ringEls[g] = { ring, fg: ring.querySelector('.ring-fg'), C, idleIcon, label, count, last: null };
  }

  function renderButton() { renderGroupButton('download'); renderGroupButton('run'); }
  function renderGroupButton(g) {
    if (!ringEls[g]) buildButton(g);
    const mine = [...state.tasks.values()].filter(GROUPS[g].filter);
    const running = mine.filter((t) => t.status === 'running');
    const failed = mine.filter((t) => t.status === 'failed' && !t.seen).length;
    const r = ringEls[g];
    const active = running.length > 0;
    r.idleIcon.classList.toggle('hidden', active);
    r.ring.classList.toggle('hidden', !active);
    r.label.classList.toggle('hidden', !active);
    GROUPS[g].btn().classList.toggle('has-error', !active && failed > 0);
    if (active) {
      const known = running.filter((t) => t.progress >= 0);
      const avg = known.length ? known.reduce((s, t) => s + t.progress, 0) / known.length : -1;
      // 只修改属性，不重建元素，避免动画被重置
      r.ring.classList.toggle('spinning', avg < 0);
      r.fg.setAttribute('stroke-dashoffset', String(r.C * (1 - (avg < 0 ? 0.25 : avg))));
      const text = avg >= 0 ? `${Math.round(avg * 100)}%` : '处理中';
      setText(r.label, text);
    }
    r.count.classList.toggle('hidden', running.length < 2 && !(failed && !active));
    setText(r.count, String(running.length >= 2 ? running.length : failed ? '!' : ''));
  }

  // ───────────────────────── 任务卡片（增量更新） ─────────────────────────
  function statusIcon(status) {
    if (status === 'done') return h('span.tk-ico.ok', icon('checkCircle', 18));
    if (status === 'failed') return h('span.tk-ico.bad', icon('alertCircle', 18));
    if (status === 'cancelled') return h('span.tk-ico.faint', icon('x', 18));
    return h('span.tk-ico', h('span.spinner', { style: { width: '16px', height: '16px', borderWidth: '2px' } }));
  }

  function createView(t, full) {
    const el = h('div', { class: `task-item ${full ? 'full' : ''}` });
    const ico = h('span');
    const title = h('div.ti-title');
    const sub = h('div.ti-sub');
    const actions = h('div.ti-actions');
    const detail = h('div.ti-detail');
    const progress = progressBar();
    const stats = h('div.ti-meta');
    const current = h('div.ti-current');
    const errBox = h('div.ti-error');
    // DOM 的 append(null) 会插入文字「null」，紧凑卡片没有 current，要先滤掉
    el.append(...[
      h('div.ti-top', ico, h('div', { style: { flex: 1, minWidth: 0 } }, title, full ? sub : null), actions),
      progress, stats, detail, full ? current : null, errBox,
    ].filter(Boolean));
    const view = { el, status: null, update };
    let curLabel = null;
    let curRows = null;

    function update(task) {
      if (task.status !== view.status) {
        view.status = task.status;
        el.className = `task-item ${full ? 'full' : ''} ${task.status}`;
        A.mount(ico, statusIcon(task.status));
        renderActions(task);
      }
      setText(title, task.title);
      title.title = task.title;
      if (full) setText(sub, `${KIND_LABEL[task.kind] || '任务'} · ${new Date(task.createdAt).toTimeString().slice(0, 5)}${task.endedAt ? ` · 用时 ${fmtDur(task.endedAt - task.createdAt)}` : ''}`);
      const running = task.status === 'running';
      const pct = task.progress >= 0 ? Math.round(task.progress * 100) : -1;
      progress.classList.toggle('hidden', !running && task.status !== 'done');
      progress.set(running && pct < 0 ? null : task.status === 'done' ? 100 : Math.max(0, pct));

      const parts = [];
      if (running && pct >= 0) parts.push(`${pct}%`);
      if (task.files && task.files.total > 1) parts.push(`${task.files.done}/${task.files.total} 个文件`);
      if (task.bytes && task.bytes.total > 0 && (full || running)) parts.push(`${fmtBytes(task.bytes.done)} / ${fmtBytes(task.bytes.total)}`);
      if (running && task.speed > 0) parts.push(fmtSpeed(task.speed));
      if (running && task.eta) parts.push(`剩余 ${fmtEta(task.eta)}`);
      setText(stats, parts.join(' · '));
      stats.classList.toggle('hidden', !parts.length || task.status === 'failed');

      const showDetail = task.status !== 'failed';
      detail.classList.toggle('hidden', !showDetail);
      if (showDetail) { setText(detail, task.detail || ''); detail.title = task.detail || ''; }

      if (full) {
        const cur = running ? task.current || [] : [];
        current.classList.toggle('hidden', !cur.length);
        if (cur.length) {
          // 按文件名增量更新：鼠标提示、小进度条的过渡、选中的文字都不会断
          if (!curLabel) { curLabel = h('div.tc-label'); curRows = h('div.tc-rows'); current.append(curLabel, curRows); }
          setText(curLabel, `正在下载（${task.files && task.files.active ? task.files.active : cur.length} 个连接）`);
          keyedList(curRows, cur, (f) => f.name, (f0) => {
            const mini = progressBar({ mini: true, value: 0 });
            const size = h('span.cur-size');
            const retry = h('span.badge.warn.hidden');
            return {
              el: h('div.cur-row', h('span.cur-name', { title: A.nm(f0.name) }, A.nm(f0.name)), mini, size, retry),
              update(f) {
                mini.set(f.size ? Math.min(100, (f.received / f.size) * 100) : 0);
                setText(size, f.size ? `${fmtBytes(f.received)} / ${fmtBytes(f.size)}` : fmtBytes(f.received));
                retry.classList.toggle('hidden', !(f.attempt > 1));
                if (f.attempt > 1) setText(retry, `重试 ${f.attempt - 1}`);
              },
            };
          });
        }
      }

      const failed = task.status === 'failed';
      errBox.classList.toggle('hidden', !failed);
      if (failed && errBox.dataset.for !== `${task.id}:${task.endedAt}`) {
        errBox.dataset.for = `${task.id}:${task.endedAt}`;
        const r = task.reason || {};
        const fails = task.failures || [];
        A.mount(errBox,
          h('div.te-reason', icon('alert', 14), h('b', r.message || '失败')),
          h('div.te-msg', task.error),
          r.hint ? h('div.te-hint', icon('info', 14), r.hint) : null,
          fails.length ? h('details.te-files', h('summary', `查看失败的文件（${fails.length}）`),
            h('div', fails.slice(0, full ? 50 : 8).map((f) => h('div.te-file', h('span.cur-name', A.nm(f.name)), h('span.faint', f.message))))) : null);
      }
    }

    function renderActions(task) {
      A.clear(actions);
      if (task.status === 'running') {
        actions.append(h('button.btn.ghost.sm.icon', { 'data-tip': '取消', onclick: () => api('tasks:cancel', task.id) }, icon('x', 16)));
        return;
      }
      if (task.status === 'failed' && task.retryable) {
        actions.append(h('button.btn.sm', { onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await api('tasks:retry', task.id); } catch (err) { b.disabled = false; A.errorToast('无法重试', err); } } }, icon('refresh', 14), '重试'));
      }
      // 取消了的不给「打开文件夹」：取消时装了一半的东西已经清掉，文件夹多半不在了（rc12 按钮走查：点了报「路径不存在」）。
      // 完成了的文件夹后来也可能被删掉：说清楚是什么情况，不只说「路径不存在」
      if (task.dir && full && task.status !== 'cancelled') {
        actions.append(h('button.btn.ghost.sm.icon', { 'data-tip': '打开文件夹', onclick: () => api('shell:open', task.dir).catch((e) => (/路径不存在/.test(e.message || '')
          ? A.toast({ level: 'warn', title: '这个文件夹已经不在了', text: task.status === 'failed' ? '没装完的东西已经清理掉了，可以点「重试」重新装' : '可能已经删掉或者挪走了' })
          : A.errorToast('无法打开', e))) }, icon('folder', 16)));
      }
      actions.append(h('button.btn.ghost.sm.icon', { 'data-tip': '移除记录', onclick: () => api('tasks:remove', task.id) }, icon('trash', 14)));
    }

    update(t);
    return view;
  }

  const fmtDur = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`);

  /** 一个可增量更新的任务列表 */
  function createList(container, { full = false, filter = () => true, empty } = {}) {
    const views = new Map();
    const list = { container, views, render };
    function order(tasks) {
      return tasks.filter(filter).sort((a, b) => ((b.status === 'running') - (a.status === 'running')) || b.createdAt - a.createdAt);
    }
    function render() {
      const tasks = order([...state.tasks.values()]);
      const ids = new Set(tasks.map((t) => t.id));
      for (const [id, v] of views) if (!ids.has(id)) { v.el.remove(); views.delete(id); }
      const emptyEl = container.querySelector(':scope > .empty');
      if (!tasks.length) {
        if (!emptyEl && empty) container.appendChild(empty());
        return;
      }
      if (emptyEl) emptyEl.remove();
      let prev = null;
      for (const t of tasks) {
        let v = views.get(t.id);
        if (!v) { v = createView(t, full); views.set(t.id, v); } else v.update(t);
        // 只有顺序真的变化时才移动节点
        const want = prev ? prev.nextSibling : container.firstChild;
        if (want !== v.el) container.insertBefore(v.el, want);
        prev = v.el;
      }
    }
    render();
    return list;
  }

  // ───────────────────────── 弹出面板 ─────────────────────────
  async function clearRun() {
    for (const t of [...state.tasks.values()]) if (isRun(t) && t.status !== 'running') await api('tasks:remove', t.id);
  }

  let panel = null;
  function togglePanel(g = 'download') {
    const same = panel && panel.group === g;
    if (panel) A.closePopover();
    if (same) return;
    const G = GROUPS[g];
    const listEl = h('div.tp-list');
    // 运行中的任务：「清除已结束」只删这一组，不动下载记录
    const clear = g === 'run' ? clearRun : () => api('tasks:clear');
    const head = h('div.tp-head', h('b', G.title), h('div.row.gap-s',
      h('button.btn.ghost.sm', { onclick: clear }, g === 'run' ? '清除已结束' : '清除已完成'),
      g === 'download'
        ? h('button.btn.sm', { onclick: () => { A.closePopover(); openDownloads(); } }, '下载管理')
        : h('button.btn.sm', { onclick: () => { A.closePopover(); A.go('tasks'); } }, '任务中心')));
    const pop = A.popover(G.btn(), h('div.tp-wrap', head, listEl), { align: 'right', className: 'task-panel', onClose: () => { if (panel && panel.pop === pop) panel = null; } });
    panel = {
      group: g,
      list: createList(listEl, {
        filter: G.filter,
        empty: () => h('div.empty', { style: { padding: '30px 10px' } }, icon(G.idle, 34, 1.5), h('p', G.empty), G.emptySub ? h('p.faint', { style: { fontSize: '12px', marginTop: '4px' } }, G.emptySub) : null),
      }),
      pop,
    };
    pop.reposition();
    markSeen(g);
  }

  /** 看下载记录不要联网：离线或简洁模式进不了下载页，就在原地弹出只读的下载记录，失败原因还能看到 */
  function openDownloads() {
    if (A.simple.allows('download') && A.offline.allows('download')) { A.go('download', { tab: 'tasks' }); return; }
    const box = h('div.dm-list');
    A.modal({ title: '下载管理', icon: 'download', size: 'lg', body: box, actions: [{ label: A.t('common.close'), kind: 'primary' }], onClose: () => mgr.destroy() });
    const mgr = mountManager(box, { group: 'download', empty: () => A.emptyState({ iconName: 'download', title: '暂无下载任务' }) });
    mgr.render();
  }

  function markSeen(g) {
    for (const t of state.tasks.values()) if (t.status === 'failed' && GROUPS[g].filter(t)) t.seen = true;
    renderButton();
  }

  // 下载管理页
  const managers = new Set();
  function mountManager(container, opts = {}) {
    // 下载管理只放下载，侧边栏「任务」页只放运行类任务；传进来的筛选（进行中 / 已完成…）叠加在上面
    const base = GROUPS[opts.group || 'download'].filter;
    const extra = opts.filter || (() => true);
    const m = createList(container, { full: true, ...opts, filter: (t) => base(t) && extra(t) });
    // 页面每次显示都重建列表：换下来的旧列表现在就放掉（以前要等下一次任务更新，没有任务时一直攒着）
    for (const old of managers) if (!old.container.isConnected) managers.delete(old);
    managers.add(m);
    return { render: m.render, destroy: () => managers.delete(m) };
  }

  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderButton();
      if (panel) { panel.list.render(); panel.pop.reposition(); }
      for (const m of managers) if (m.container.isConnected) m.render(); else managers.delete(m);
    });
  }

  function onUpdate(t) {
    const prev = state.tasks.get(t.id);
    if (prev && prev.seen) t.seen = true;
    state.tasks.set(t.id, t);
    scheduleRender();
    emit('task', t);
    // 失败提示：重试或重新开始同一件事时收起
    if (t.status === 'running' && !prev) {
      if (t.retryOf) A.dismissToasts(`task:${t.retryOf}`);
      A.dismissToasts(`taskTitle:${t.title}`);
    }
    if (t.status === 'done') A.dismissToasts(`taskTitle:${t.title}`);
    if (t.status === 'failed' && (!prev || prev.status === 'running')) {
      // 谁来提示由任务引擎决定（core/tasks.js）：这里只提示标了 task 的，其他的主进程或调用方已经提示了
      if (t.notice === 'task') {
        A.toast({ level: 'crit', title: `${t.title} 失败`, text: `${t.reason ? t.reason.message : t.error}${t.reason && t.reason.hint ? `\n建议：${t.reason.hint}` : ''}`, scope: [`task:${t.id}`, `taskTitle:${t.title}`] });
      }
    }
  }

  async function init() {
    GROUPS.download.btn().addEventListener('click', () => togglePanel('download'));
    GROUPS.run.btn().addEventListener('click', () => togglePanel('run'));
    for (const t of await api('tasks:list')) state.tasks.set(t.id, t);
    A.listen('task:update', onUpdate);
    A.listen('task:cleared', (list) => {
      const old = state.tasks;
      state.tasks = new Map(list.map((t) => [t.id, { ...t, seen: old.get(t.id) && old.get(t.id).seen }]));
      scheduleRender();
      emit('task', { id: null, kind: 'cleared', status: 'cleared', meta: {} });
    });
    renderButton();
  }

  /** 现在算不算在玩：有游戏开着（含测试启动、一键 Debug），或者启动 / 测试任务还在准备。下载、安装不算 */
  const gameActive = () => [...state.games.values()].some((g) => g.state !== 'exited')
    || [...state.tasks.values()].some((t) => t.status === 'running' && isGame(t));

  A.tasks = { init, toggle: togglePanel, mountManager, openDownloads, isRun, isDownload, isGame, gameActive, clearRun };
})();
