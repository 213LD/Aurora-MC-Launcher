'use strict';
/**
 * 日志中心（rc4）：以前日志只能从顶栏的日志抽屉看，而且只有这次打开启动器以后的几局。
 * 现在每局游戏的日志都存在数据目录里（主进程 core/gamelogs.js），这里按时间列出来：
 * 左边是每一局（正在玩的、崩溃的、测试启动的都标出来），右边看内容——分等级、搜索、复制、导出、删除，崩溃的能看分析。
 * 保存几天在「设置 → 数据 → 日志」里改（默认 30 天）
 */
(function () {
  const { h, icon, api, state, on, $ } = A;

  let root;
  let items = [];
  let sel = null; // 选中的日志 id
  let filter = 'all'; // all / crash / test
  let level = 'all'; // all / warn / error
  let query = '';
  let view = { lines: [], total: 0, start: 0, id: null };
  let loadSeq = 0;
  let els = null;
  let fresh = false; // 页面刚重新建过，右边还是空的（render 里设，load 读完那一份后清掉）
  let loadingEarlier = false;
  // 页面上最多留这么多行（和筛选后显示的上限一样）；正在玩的那一局新行一直进来，超出一截就把最早的收起来，
  // 要看用「显示更早的」。以前没有上限，开着日志中心玩几个小时，页面上几万行，越来越卡（rc9）
  const KEEP_LINES = 6000;
  const TRIM_SLACK = 1000;

  const LEVELS = { warn: ['WARN', 'ERROR', 'FATAL'], error: ['ERROR', 'FATAL'] };
  const visible = (l) => (level === 'all' || LEVELS[level].includes(l.level)) && (!query || l.text.toLowerCase().includes(query));
  const gameOf = (it) => [...state.games.values()].find((g) => g.logId === it.id);
  const isCrash = (it) => !!it.crash || (it.state === 'exited' && it.exitCode !== 0 && !it.killed && it.exitCode != null);

  function when(t) {
    const d = new Date(t);
    const p = (x) => String(x).padStart(2, '0');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = d >= today ? '今天' : d >= today - 86400000 ? '昨天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function sub(it) {
    if (it.state === 'running') return `${when(it.startedAt)} · 正在运行`;
    const parts = [when(it.startedAt)];
    if (it.endedAt) parts.push(`玩了 ${A.fmtDuration(it.endedAt - it.startedAt)}`);
    if (it.state === 'unknown') parts.push('启动器关掉时游戏还开着');
    else if (it.killed) parts.push('被强制结束');
    else if (it.exitCode != null) parts.push(it.exitCode === 0 ? '正常退出' : `退出代码 ${it.exitCode}`);
    parts.push(A.fmtBytes(it.bytes || 0));
    return parts.join(' · ');
  }

  function shown() {
    return items.filter((it) => (filter === 'crash' ? isCrash(it) : filter === 'test' ? it.test : true));
  }

  async function load() {
    try { items = await api('logs:list'); } catch (e) { items = []; A.errorToast('读不到日志列表', e); }
    if (sel && !items.some((x) => x.id === sel)) sel = null;
    renderList();
    // 页面刚重新建过（离开再回来、从日志抽屉带着某一局过来）：选中的那一局也要重新读出来。
    // 以前只重画标题，右边是空白，要点一下别的再点回来（rc9）
    const reload = fresh || view.id !== sel;
    fresh = false;
    if (!sel && shown().length) pick(shown()[0].id); else if (sel && reload) pick(sel); else if (sel) renderHead();
  }

  function renderList() {
    if (!els) return;
    const list = shown();
    A.mount(els.list, list.length ? list.map((it) => h('div', {
      class: `lc-item ${it.id === sel ? 'on' : ''} ${isCrash(it) ? 'crash' : ''}`, tabindex: 0, role: 'button', 'data-log': it.id,
      onclick: () => pick(it.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(it.id); } },
    },
    h('span', { class: `lc-dot ${it.state === 'running' ? 'run' : isCrash(it) ? 'bad' : 'ok'}` }),
    h('div.lc-body',
      h('div.lc-title', h('span.ellipsis', A.noTr(A.nm(it.versionId))), it.test ? h('span.badge', '测试启动') : null, isCrash(it) ? h('span.badge.crit', '崩溃') : null),
      h('div.lc-sub', sub(it))))) : A.emptyState({ iconName: 'scroll', title: items.length ? '没有符合条件的日志' : '还没有保存的日志', text: items.length ? '换个筛选看看' : '启动一次游戏，日志就会自动存到这里' }));
  }

  async function pick(id) {
    sel = id;
    renderList();
    const seq = ++loadSeq;
    A.mount(els.body, h('div.log-empty', h('span.spinner'), ' 正在读取…'));
    try {
      const r = await api('logs:read', id, { tail: 3000 });
      if (seq !== loadSeq) return;
      view = { lines: r.lines, total: r.total, start: r.start, id };
    } catch (e) {
      if (seq !== loadSeq) return;
      view = { lines: [], total: 0, start: 0, id };
      A.mount(els.body, h('div.log-empty', `读不到这份日志：${(e && e.message) || e}`));
      renderHead();
      return;
    }
    renderHead();
    renderBody(true);
  }

  async function earlier() {
    if (loadingEarlier) return; // 连点两下，同一段会加两遍
    loadingEarlier = true;
    const id = view.id;
    const r = await api('logs:read', id, { tail: 5000, before: view.total - view.start }).catch(() => null);
    loadingEarlier = false;
    if (!r || view.id !== id) return;
    const h0 = els.body.scrollHeight;
    view.lines = [...r.lines, ...view.lines];
    view.start = r.start;
    renderBody(false);
    els.body.scrollTop = els.body.scrollHeight - h0; // 留在原来看的地方
  }

  function renderHead() {
    const it = items.find((x) => x.id === sel);
    if (!it) { A.clear(els.head); return; }
    const g = gameOf(it);
    A.mount(els.head,
      h('div.lc-head-title', h('b', A.noTr(A.nm(it.versionId))), h('span.faint', sub(it))),
      h('div.lc-tools',
        A.seg([{ value: 'all', label: '全部' }, { value: 'warn', label: '警告' }, { value: 'error', label: '错误' }], level, (v) => { level = v; renderBody(true); }),
        h('input.input.sm.lc-search', { placeholder: '搜索日志…', value: query, 'aria-label': '搜索日志', oninput: A.debounce((e) => { query = e.target.value.trim().toLowerCase(); renderBody(true); }, 200) }),
        isCrash(it) && it.crash ? h('button.btn.sm', { onclick: () => A.logs.showCrash({ id: (g && g.id) || it.id, versionId: it.versionId, exitCode: it.exitCode, startedAt: it.startedAt, endedAt: it.endedAt || it.startedAt, crash: it.crash }) }, icon('alert', 14), '崩溃分析') : null,
        h('button.btn.sm.ghost.icon', { 'data-tip': '复制看得到的这些行', onclick: () => A.copy(view.lines.filter(visible).map((l) => l.text).join('\n')) }, icon('copy', 15)),
        h('button.btn.sm.ghost.icon', { 'data-tip': '导出整份日志', onclick: exportLog }, icon('upload', 15)),
        h('button.btn.sm.ghost.icon', { 'data-tip': '打开日志所在的文件夹', onclick: openDir }, icon('folder', 15)),
        it.state === 'running' ? null : h('button.btn.sm.ghost.icon', { 'data-tip': '删除这份日志', onclick: () => remove(it) }, icon('trash', 15))));
  }

  function renderBody(toBottom) {
    if (!els) return;
    const list = view.lines.filter(visible);
    const frag = document.createDocumentFragment();
    if (view.start > 0) frag.appendChild(h('div.lc-more', h('button.btn.sm.ghost', { onclick: earlier }, icon('chevronUp', 14), `显示更早的（前面还有 ${view.start} 行）`)));
    if (!list.length) frag.appendChild(h('div.log-empty', view.lines.length ? '没有匹配的日志' : '这份日志是空的'));
    for (const l of list.slice(-6000)) frag.appendChild(A.logs.lineEl(l, query));
    A.clear(els.body);
    els.body.appendChild(frag);
    if (toBottom) els.body.scrollTop = els.body.scrollHeight;
  }

  /** 正在玩的这一局：新行实时加到下面 */
  function onLive({ id, lines }) {
    if (!els || state.page !== 'logs' || !view.id) return;
    const g = state.games.get(id);
    if (!g || g.logId !== view.id) return;
    const atBottom = els.body.scrollHeight - els.body.scrollTop - els.body.clientHeight < 40;
    view.lines.push(...lines);
    view.total += lines.length;
    const empty = els.body.querySelector('.log-empty');
    if (empty) empty.remove();
    const frag = document.createDocumentFragment();
    for (const l of lines) if (visible(l)) frag.appendChild(A.logs.lineEl(l, query));
    els.body.appendChild(frag);
    if (view.lines.length > KEEP_LINES + TRIM_SLACK) {
      // 最早的收起来，重画一次（每多 TRIM_SLACK 行才重画一回）；没在看最下面的话留在原来看的地方
      const fromBottom = els.body.scrollHeight - els.body.scrollTop;
      const drop = view.lines.length - KEEP_LINES;
      view.lines.splice(0, drop);
      view.start += drop;
      renderBody(atBottom);
      if (!atBottom) els.body.scrollTop = Math.max(0, els.body.scrollHeight - fromBottom);
      return;
    }
    if (atBottom) els.body.scrollTop = els.body.scrollHeight;
  }

  /** 导出整份：主进程直接复制存着的文件（以前在这里读最后 20000 行拼出来，长日志前面的没导出去） */
  async function exportLog() {
    const it = items.find((x) => x.id === sel);
    if (!it) return;
    const p = await api('logs:export', it.id).catch((e) => { A.errorToast('导出失败', e); return null; });
    if (p) A.toast({ level: 'ok', text: '日志已导出' });
  }

  async function openDir() {
    try { await api('shell:open', await api('logs:dir')); } catch (e) { A.errorToast('打不开文件夹', e); }
  }

  async function remove(it) {
    if (!(await A.confirm(`删除「${A.nm(it.versionId)}」${when(it.startedAt)} 的这份日志？删除后不能恢复。`, { title: '删除日志', okText: '删除', danger: true }))) return;
    try { await api('logs:delete', it.id); } catch (e) { A.errorToast('删除失败', e); return; }
    sel = null;
    load();
  }

  function render(params) {
    if (params && params.open) sel = params.open;
    const days = Number((state.config.logs || {}).keepDays ?? 30);
    els = { list: h('div.lc-list'), head: h('div.lc-head'), body: h('div.log-body.lc-log', { 'data-no-tr': '' }) };
    fresh = true;
    A.mount(root, h('div.page-inner.lc-page',
      h('div.page-head',
        h('div', h('h1', '日志中心'), h('p', `每次启动游戏的完整日志都存在这里，${days ? `保存 ${days} 天` : '一直保存'}；关掉启动器也还在。崩溃了可以回来看原因`)),
        h('div.actions',
          h('button.btn', { onclick: openDir }, icon('folder', 16), '打开文件夹'),
          h('button.btn', { onclick: () => A.go('settings', { focus: 'logs' }) }, icon('settings', 16), '日志设置'))),
      h('div.lc-layout',
        h('div.lc-side',
          A.seg([{ value: 'all', label: '全部' }, { value: 'crash', label: '崩溃' }, { value: 'test', label: '测试启动' }], filter, (v) => { filter = v; renderList(); }),
          els.list),
        h('div.lc-main', els.head, els.body))));
    load();
  }

  function init() {
    root = $('#page-logs');
    A.listen('game:log', onLive);
    // 开始 / 结束一局：列表跟着变（日志中心开着时）
    const refresh = A.debounce(() => { if (state.page === 'logs') load(); }, 600);
    on('games', refresh);
  }

  A.pages.logs = { init, show: (p) => render(p), title: '日志中心' };
})();
