'use strict';
/* Mod 配置器：我的方案、页面生命周期 */
(function () {
  const { h, icon, api, state, on } = A;
  const K = A.plannerKit;
  const { LOADER_INFO, P, STEPS, newPlan } = K;

  async function openPlans() {
    const list = await api('planner:list').catch(() => []);
    const body2 = h('div.list');
    const modded = state.installed.filter((v) => v.loader && ['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'].includes(v.loader.type));
    const editBox = modded.length ? h('div', { style: { marginTop: '18px' } }, h('div.menu-head', '修改已有配置'),
      h('div.list', modded.slice(0, 12).map((v) => h('div.list-row.clickable', { onclick: () => { m.close(); K.editProfile(v.id); } },
        h('div.ico', h('img', { src: A.versionIcon(v, 64) })),
        h('div.body', h('div.title', A.noTr(A.displayName(v))), h('div.sub', `${A.versionSub(v)} · ${v.mods.enabled} 个 Mod`)),
        h('div.actions', h('span.badge', icon('sparkles', 12), '修改')))))) : null;
    const m = A.modal({ title: A.t('term.myPlans'), subtitle: `${A.t('term.plan')}会自动保存，可以随时回来继续；也可以直接修改已经创建好的配置`, icon: 'file', size: 'md', body: h('div', body2, editBox), actions: [{ label: A.t('term.newPlan'), kind: 'primary', icon: 'plus', onClick: () => K.startNew() }] });
    const render2 = (items) => A.mount(body2, items.length ? items.map((pl) => h('div.list-row.clickable', { onclick: () => { m.close(); K.openPlan(pl); } },
      h('div.ico', h('img', { src: A.blockImage((LOADER_INFO[pl.loader] || {}).kind || 'grass', 64) })),
      h('div.body',
        h('div.title', h('span', A.nm(pl.name) || `未命名${A.t('term.plan')}`), pl.profileId ? h('span.badge.ok', '已安装') : null),
        h('div.sub', `Minecraft ${pl.mc} · ${(A.LOADERS[pl.loader] || {}).name || pl.loader} · ${(pl.items || []).filter((i) => i.selected).length} 个 Mod · ${A.fmtRelative(pl.updatedAt)}更新`)),
      h('div.actions', { onclick: (e) => e.stopPropagation() },
        h('button.btn.sm.icon.ghost', { 'data-tip': '导出清单', onclick: () => K.exportList(pl) }, icon('upload', 16)),
        h('button.btn.sm.icon.ghost', { 'data-tip': `删除${A.t('term.plan')}`, onclick: async () => { await api('planner:delete', pl.id); render2(items.filter((x) => x.id !== pl.id)); if (P.plan && P.plan.id === pl.id) P.plan.id = null; } }, icon('trash', 16)))))
      : A.emptyState({ iconName: 'file', title: `还没有保存的${A.t('term.plan')}` }));
    render2(list);
  }

  async function init() {
    K.build();
    P.plan = newPlan();
    try { P.meta = await api('planner:styles'); } catch { P.meta = { styles: [], versions: [] }; }
    // 不再自动打开上次的方案（1.10.1）：第一次进页面时由 resume() 问继续还是丢弃
    try {
      const plans = await api('planner:list');
      P.pendingStored = plans.find(unfinished) || null;
    } catch { /* ignore */ }
    K.renderStepper();
    K.render();
    on('task', (t) => {
      if (state.page !== 'planner') return;
      if (P.installTaskId && t.id === P.installTaskId) K.renderProgress();
      if (t.kind === 'test' && (P.testing || P.bisecting) && P.step === 4) {
        const el = K.body.querySelector('.testing .faint');
        if (el) el.textContent = t.detail;
      }
    });
    on('manifest', () => { if (P.step === 1 && state.page === 'planner') K.renderChoose(); });
    on('installed', () => { if (state.page === 'planner' && (P.step === 3 || P.step === 4) && !P.testing && !P.bisecting) K.render(); });
    A.listen('troubleshoot:round', (r) => {
      if (!P.bisecting) return;
      const i = P.rounds.findIndex((x) => x.round === r.round);
      if (i >= 0) P.rounds[i] = r; else P.rounds.push(r);
      if (P.step === 4) K.renderTest();
    });
    A.listen('mods:changed', (id) => { if (P.plan && P.plan.profileId === id && P.step === 4 && !P.testing && !P.bisecting) K.runCheck(); });
    refreshCount();
  }

  function show(params) {
    if (!P.meta) return;
    if (params && params.resume) { P.opened = true; P.pendingStored = null; resumeFrom(params.resume); return; }
    if (params && params.troubleshoot) { P.opened = true; K.troubleshootProfile(params.troubleshoot); return; }
    if (params && params.edit) { K.editProfile(params.edit); return; }
    if (params && params.fromModpack) { P.opened = true; K.fromModpack(params.fromModpack); return; }
    if (params && params.fresh) { P.opened = true; K.startNew(); return; }
    resume();
  }

  /** 有没有走完：保存成游戏配置（或第四步点了完成）才算完成；排查模式和什么都没选的不算「未完成」 */
  function unfinished(plan) {
    return !!plan && !plan.done && !plan.troubleshootOnly && (plan.mode === 'edit' || (plan.items || []).length > 0 || (plan.step || 1) > 1);
  }

  /**
   * 回到配置器页面（1.10.1）：上次有没走完的配置（这次打开启动器里切走的，或者上次关掉启动器时留下的）就问继续还是丢弃；
   * 没有就固定从第一步开始，后面的步骤点不了。正在安装 / 测试 / 排查时照常显示当前进度
   */
  function resume() {
    if (P.testing || P.bisecting || P.installTaskId || P.asking) { K.renderStepper(); K.render(); return; }
    const cand = unfinished(P.plan) ? P.plan : P.pendingStored;
    P.pendingStored = null;
    if (!cand) { if (P.plan && (P.plan.done || P.plan.troubleshootOnly || P.step !== 1)) K.startNew(); else { K.renderStepper(); K.render(); } return; }
    const inMemory = cand === P.plan;
    // 先显示一个空白的第一步，弹窗在上面
    P.plan = newPlan(); P.step = 1;
    K.renderStepper(); K.render();
    const step = Math.min(cand.step || 1, 4);
    const stepTitle = (STEPS.find((s) => s.n === step) || STEPS[0]).title;
    const n = (cand.items || []).filter((i) => i.selected !== false).length;
    let decided = false;
    P.asking = true;
    A.modal({
      title: '上次的 Mod 配置还没完成',
      icon: 'file',
      size: 'sm',
      body: h('div',
        h('p', { style: { marginTop: 0 } }, cand.mode === 'edit' ? `正在修改「${A.nm(cand.name)}」，还没有应用修改。` : `「${A.nm(cand.name) || `${cand.mc} ${(A.LOADERS[cand.loader] || {}).name || ''}`}」停在第 ${step} 步「${stepTitle}」${n ? `，清单里有 ${n} 个 Mod` : ''}。`),
        h('p.muted', { style: { marginBottom: 0 } }, cand.profileId ? '已经装好的游戏配置不会被删除，丢弃只是不再继续这次的配置流程。' : '丢弃后这份未完成的清单会被删除，从第一步重新开始。')),
      actions: [
        { label: '丢弃，重新开始', kind: 'ghost', onClick: () => { decided = true; discard(cand); } },
        { label: '继续上次的配置', kind: 'primary', onClick: () => {
          decided = true;
          if (inMemory) { P.plan = cand; K.goStep(P.plan.mode === 'edit' ? Math.min(step, 3) : Math.min(step, K.maxStep())); } else K.openPlan(cand);
        } },
      ],
      onClose: () => {
        P.asking = false;
        // 直接关掉弹窗：先停在空白的第一步，未完成的配置留着，下次回来再问
        if (!decided) P.pendingStored = cand;
      },
    });
  }

  async function discard(plan, { restart = true } = {}) {
    try {
      if (plan.id && plan.profileId) await api('planner:save', { ...plan, done: true });
      else if (plan.id) await api('planner:delete', plan.id);
    } catch { /* 忽略 */ }
    if (restart || (P.plan && (P.plan === plan || (plan.id && P.plan.id === plan.id)))) K.startNew();
    refreshCount();
  }

  // ───────────── 任务中心里的「没做完的 Mod 配置」（rc3） ─────────────
  // 配置器页面自己的「上次的 Mod 配置还没完成」提示照旧；任务中心多一个地方能看到、接着做或删掉重来

  /** 正在安装 / 测试 / 排查的那一个已经是运行中的任务了，不算「没做完」 */
  const busyNow = () => !!(P.testing || P.bisecting || P.installTaskId);

  /** 没做完的配置：存着的方案 + 这次打开启动器里正在改、还没存的（修改已有配置不存盘） */
  async function unfinishedList() {
    let plans = [];
    try { plans = await api('planner:list'); } catch { /* ignore */ }
    const list = plans.filter(unfinished);
    const cur = P.plan;
    if (cur && unfinished(cur) && !list.some((x) => x.id && x.id === cur.id)) list.unshift({ ...cur, step: P.step, memory: true });
    if (busyNow() && cur) return list.filter((x) => !(x.memory || (x.id && x.id === cur.id)));
    return list.map((x) => (cur && x.id && x.id === cur.id ? { ...x, step: P.step } : x));
  }

  /** 从任务中心回来接着做：key 是方案 id，或 'memory'（这次打开启动器里正在改的） */
  async function resumeFrom(key) {
    if (busyNow()) { K.renderStepper(); K.render(); return; }
    if (key === 'memory' || (P.plan && P.plan.id && P.plan.id === key && unfinished(P.plan))) {
      if (P.plan && unfinished(P.plan)) { K.goStep(P.plan.mode === 'edit' ? Math.min(P.step || 1, 3) : Math.min(P.step || P.plan.step || 1, K.maxStep())); return; }
    }
    const plans = await api('planner:list').catch(() => []);
    const plan = plans.find((x) => x.id === key);
    if (plan) K.openPlan(plan);
    else { A.toast({ level: 'warn', text: '这份配置已经不在了，可能已经完成或删掉了' }); K.startNew(); }
  }

  /** 删掉一份没做完的配置；装好了的游戏配置留着，只是不再接着这次的流程 */
  async function discardFromTasks(item) {
    if (item.memory || (P.plan && item.id && P.plan.id === item.id)) { await discard(P.plan || item, { restart: true }); return; }
    await discard(item, { restart: false });
  }

  /** 侧边栏「任务中心」上的数字：没有运行中的任务时，显示有几份没做完的配置 */
  let countSeq = 0;
  async function refreshCount() {
    const seq = ++countSeq;
    const n = (await unfinishedList()).length;
    if (seq !== countSeq || n === state.plannerUnfinished) return;
    state.plannerUnfinished = n;
    A.emit('plannerUnfinished', n);
  }
  on('page', (page) => { if (page !== 'planner') refreshCount(); });

  const stepTitle = (n) => (STEPS.find((s) => s.n === Math.min(n || 1, 4)) || STEPS[0]).title;
  const iconOf = (x) => A.blockImage((LOADER_INFO[x.loader] || {}).kind || 'grass', 64);
  A.plannerResume = { list: unfinishedList, resume: (key) => A.go('planner', { resume: key }), discard: discardFromTasks, refreshCount, stepTitle, iconOf };

  A.pages.planner = {
    init: async () => { await init(); },
    show: (p) => { if (!P.meta) { setTimeout(() => show(p), 150); return; } show(p); },
    title: 'Mod 配置器',
  };

  Object.assign(K, { openPlans });
})();
