'use strict';
/* 任务中心（1.4.9）：启动、测试启动、一键 Debug、二分排查这类运行任务；下载在「下载中心 → 下载管理」。
 * rc3：最上面多一块「没做完的 Mod 配置」，Mod 配置器里没走完的可以从这里接着做或删掉重来（A.plannerResume，planner/main.js） */
(function () {
  const { h, icon, state, on, $ } = A;

  let root;
  let filter = 'all';
  let plansEl = null;
  let plansSeq = 0;
  const FILTERS = {
    all: () => true,
    running: (t) => t.status === 'running',
    ended: (t) => t.status !== 'running',
  };

  function render() {
    const listEl = h('div.dm-list');
    plansEl = h('div.tc-plans.hidden');
    A.mount(root, h('div.page-inner',
      h('div.page-head',
        h('div', h('h1', '任务中心'), h('p', '启动游戏、测试启动、一键 Debug、二分排查、建 MC 百科缓存的进度，还有没做完的 Mod 配置都在这里；下载任务在「下载中心 → 下载管理」')),
        h('div.actions', h('button.btn', { onclick: () => A.tasks.openDownloads() }, icon('download', 16), '下载管理'))),
      plansEl,
      h('div.toolbar',
        A.seg([{ value: 'all', label: '全部' }, { value: 'running', label: '进行中' }, { value: 'ended', label: '已结束' }], filter, (v) => { filter = v; render(); }, { accent: true }),
        h('div.spacer'),
        h('button.btn', { onclick: () => A.tasks.clearRun() }, icon('trash', 16), '清除已结束')),
      listEl));
    A.tasks.mountManager(listEl, {
      group: 'run',
      filter: FILTERS[filter],
      empty: () => A.emptyState({ iconName: 'zap', title: filter === 'all' ? '现在没有任务' : '没有符合条件的任务', text: '启动游戏、测试启动、一键 Debug、二分排查时，进度会显示在这里' }),
    });
    renderPlans();
  }

  /** 没做完的 Mod 配置：每份一行，「接着做」回到配置器停下的那一步，「删除重来」删掉这份、从第一步重新开始 */
  async function renderPlans() {
    if (!A.plannerResume || !plansEl) return;
    const seq = ++plansSeq;
    const el = plansEl;
    const list = await A.plannerResume.list();
    if (seq !== plansSeq || !el.isConnected) return;
    el.classList.toggle('hidden', !list.length);
    if (!list.length) { A.clear(el); return; }
    const loaderName = (x) => (A.LOADERS[x.loader] || {}).name || x.loader || '';
    const row = (x) => {
      const n = (x.items || []).filter((i) => i.selected !== false).length;
      const edit = x.mode === 'edit';
      const title = edit ? `修改「${A.nm(x.name)}」` : A.nm(x.name) || `${x.mc} ${loaderName(x)}`;
      const sub = edit ? `还没有应用修改${n ? ` · 清单里有 ${n} 个 Mod` : ''}`
        : [`Minecraft ${x.mc} · ${loaderName(x)}`, `停在第 ${Math.min(x.step || 1, 4)} 步「${A.plannerResume.stepTitle(x.step)}」`, n ? `${n} 个 Mod` : null, x.updatedAt ? `${A.fmtRelative(x.updatedAt)}更新` : null].filter(Boolean).join(' · ');
      return h('div.list-row.tc-plan', { 'data-plan': x.memory ? 'memory' : x.id },
        h('div.ico', h('img', { src: A.plannerResume.iconOf(x), alt: '' })),
        h('div.body', h('div.title', h('span', title), x.profileId ? h('span.badge.ok', '已安装') : null), h('div.sub', sub)),
        h('div.actions',
          // Mod 配置器要联网：断网时这两个按钮和别的联网入口一样变灰（offline.js）
          h('button.btn.sm.ghost', { 'data-net': '', onclick: () => restart(x) }, icon('refresh', 14), '删除重来'),
          h('button.btn.sm.primary', { 'data-net': '', onclick: () => A.plannerResume.resume(x.memory ? 'memory' : x.id) }, icon('play', 14), '接着做')));
    };
    A.mount(el,
      h('div.tc-plans-head', icon('sparkles', 16), h('b', '没做完的 Mod 配置'), h('span.faint', '在 Mod 配置器里没走完的，随时可以回来接着做')),
      h('div.list', list.map(row)));
  }

  async function restart(x) {
    const ok = await A.confirm(x.profileId
      ? '不再接着这次的配置流程，回到第一步重新开始。已经装好的游戏配置会留着，不会被删除。'
      : '这份没做完的清单会被删除，回到第一步重新开始。', { title: '删除重来', okText: '删除重来', danger: !x.profileId });
    if (!ok) return;
    await A.plannerResume.discard(x);
    A.go('planner', { fresh: true });
  }

  function init() {
    root = $('#page-tasks');
    render();
    on('plannerUnfinished', () => { if (state.page === 'tasks') renderPlans(); });
  }

  A.pages.tasks = { init, show: render, title: '任务中心' };
})();
