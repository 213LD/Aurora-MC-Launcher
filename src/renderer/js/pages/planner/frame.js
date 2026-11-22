'use strict';
/* Mod 配置器：框架：步骤条、切换步骤、编辑横幅、应用修改、新建和打开方案 */
(function () {
  const { h, icon, api, $ } = A;
  const K = A.plannerKit;
  let root;
  let stepper;
  const { P, STEPS, newPlan, save } = K;

  function build() {
    root = $('#page-planner');
    stepper = h('div.stepper');
    K.body = h('div.pl-body');
    A.mount(root, h('div.page-inner',
      h('div.page-head',
        h('div', h('h1', A.t('term.planner')), h('p', '告诉我你想玩什么，帮你规划清单、下载安装 Mod，并测试启动、排查冲突')),
        h('div.actions',
          h('button.btn', { onclick: K.openPlans }, icon('file', 16), A.t('term.myPlans')),
          h('button.btn', { onclick: () => K.importDialog() }, icon('import', 16), '导入 Mod 列表'),
          h('button.btn', { onclick: () => { startNew(); } }, icon('plus', 16), A.t('term.newPlan')))),
      stepper, K.body));
  }

  function renderStepper() {
    const reach = maxStep();
    const edit = P.plan && P.plan.mode === 'edit';
    const steps = edit ? STEPS.map((s) => (s.n === 1 ? { ...s, title: '想加点什么', sub: '按玩法推荐更多 Mod（可跳过）' } : s.n === 2 ? { ...s, title: '调整清单', sub: '取消勾选即移除，勾选新增' } : s.n === 3 ? { ...s, title: '应用修改', sub: '下载新增、移除取消的 Mod' } : s)) : STEPS;
    A.mount(stepper, steps.map((s) => h('div', {
      class: `step-item ${P.step === s.n ? 'on' : ''} ${s.n < P.step ? 'done' : ''} ${s.n <= reach ? 'reach' : ''}`,
      onclick: () => { if (s.n <= reach && !P.plan.troubleshootOnly) goStep(s.n); },
    }, h('div.si-num', s.n < P.step ? icon('check', 14, 3) : s.n), h('div', h('div.si-title', s.title), h('div.si-sub', s.sub)))));
  }

  function maxStep() {
    const p = P.plan;
    if (!p) return 1;
    if (p.troubleshootOnly) return 4;
    if (p.profileId) return 4;
    if (p.items.length) return 3;
    return 1;
  }

  function goStep(n) {
    P.step = n;
    renderStepper();
    render();
    save();
    if (n === 2 && !P.resolved) K.resolve();
    if (n === 4) { K.runCheck(); }
    root.scrollTop = 0;
  }

  function render() {
    if (!K.body) return;
    if (P.step === 1) K.renderChoose();
    else if (P.step === 2) K.renderList();
    else if (P.step === 3) (P.plan.mode === 'edit' ? renderApply() : K.renderInstall());
    else K.renderTest();
    if (P.plan && P.plan.mode === 'edit' && P.step !== 4) K.body.prepend(editBanner());
  }

  /** 修改已有配置时，顶部显示自动识别到的信息（不可修改） */
  function editBanner() {
    const p = P.plan;
    const i = p.info || {};
    return h('div.edit-banner',
      icon('lock', 16),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('b', `正在修改「${A.nm(p.name)}」`),
        h('div.eb-tags',
          h('span', `Minecraft ${p.mc}`),
          h('span', `${(A.LOADERS[p.loader] || {}).name || p.loader} ${i.loaderVersion || ''}`),
          i.apiVersion ? h('span', `API ${i.apiVersion}`) : null,
          h('span', `${p.items.filter((x) => x.installed).length} 个已装 Mod`),
          h('span', `${i.saves || 0} 个存档`),
          i.playTime ? h('span', `已游玩 ${A.fmtDuration(i.playTime)}`) : null)),
      h('span.faint', { style: { fontSize: '12px' } }, '版本与加载器已自动识别，不会被改动'));
  }

  async function editProfile(id) {
    P.opened = true;
    A.mount(K.body, h('div.pl-loading', h('span.spinner.lg'), h('div', '正在识别配置中的游戏版本、加载器与已安装的 Mod…'), h('div.faint', '会通过文件哈希在 Modrinth 上查找每个 Mod')));
    try {
      const r = await api('planner:fromProfile', id);
      P.plan = {
        ...newPlan(), mode: 'edit', profileId: id, name: r.name, mc: r.mc, loader: r.loader, styles: [], items: r.items,
        info: { loaderVersion: r.loaderVersion, apiVersion: r.apiVersion, saves: r.saves, playTime: r.playTime },
      };
      P.resolved = null; P.test = null; P.bisect = null; P.rounds = []; P.check = null;
      goStep(2);
    } catch (e) {
      A.errorToast('无法读取配置', e);
      startNew();
    }
  }

  function renderApply() {
    const p = P.plan;
    const r = P.resolved;
    if (!r) { K.resolve().then(() => { if (P.step === 3) render(); }); A.mount(K.body, h('div.pl-loading', h('span.spinner.lg'), h('div', '正在分析改动…'))); return; }
    const installedIds = new Set(p.items.filter((i) => i.installed && i.projectId).map((i) => i.projectId));
    const added = r.items.filter((i) => i.status === 'ok' && !i.installed && !installedIds.has(i.projectId));
    const removed = p.items.filter((i) => i.installed && !i.selected && i.enabled !== false);
    const reenabled = p.items.filter((i) => i.installed && i.selected && i.enabled === false);
    let removeMode = 'disable';
    const list = (title, items, cls, name) => h('div.diff-col', h('div.diff-head', h('span', { class: `badge ${cls}` }, items.length), title),
      items.length ? h('div.diff-list', items.slice(0, 60).map((i) => h('div.diff-item', i.icon ? h('img', { src: i.icon }) : h('span.diff-dot'), h('span.ellipsis', name(i))))) : h('div.faint', { style: { fontSize: '12.5px' } }, '无'));
    const btn = h('button.btn.primary.lg', { disabled: !added.length && !removed.length && !reenabled.length, onclick: apply }, icon('check', 18), '应用修改');
    const progress = h('div.install-progress.hidden');
    A.mount(K.body,
      h('div.diff', list('新增（下载）', added, 'ok', (i) => `${A.nm(i.title)}${i.dependency ? '（前置）' : ''}`), list('移除', removed, 'danger', (i) => A.nm(i.title)), list('重新启用', reenabled, 'info', (i) => A.nm(i.title))),
      removed.length ? h('div.pl-section', h('div.pl-label', '移除方式'), A.seg([{ value: 'disable', label: '禁用（可随时恢复）' }, { value: 'trash', label: '删除到回收站' }], removeMode, (v) => { removeMode = v; })) : null,
      progress,
      h('div.pl-foot', h('button.btn.ghost', { onclick: () => goStep(2) }, '上一步'), h('div.spacer'),
        r.totals.errors ? h('span.badge.crit', `${r.totals.errors} 个冲突未解决`) : null, btn));
    P.installEls = { progress, btn };

    async function apply() {
      btn.disabled = true;
      try {
        P.installTaskId = await api('planner:applyEdit', { versionId: p.profileId, plan: { items: p.items.map(K.minimal) }, resolved: r, removeMode });
        P.installTarget = p.profileId;
        progress.classList.remove('hidden');
        K.renderProgress();
      } catch (e) { btn.disabled = false; A.errorToast('无法应用修改', e); }
    }
  }

  function startNew() {
    P.plan = newPlan();
    P.resolved = null; P.test = null; P.bisect = null; P.rounds = []; P.check = null;
    goStep(1);
  }

  function openPlan(plan) {
    P.plan = { ...newPlan(), ...plan };
    P.resolved = null; P.test = null; P.bisect = null; P.rounds = []; P.check = null;
    goStep(Math.min(plan.step || 1, maxStep()));
  }

  Object.assign(K, { build, editProfile, goStep, maxStep, openPlan, render, renderStepper, startNew });
})();
