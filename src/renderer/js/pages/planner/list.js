'use strict';
/* Mod 配置器：第 2 步：Mod 清单，兼容性分析 */
(function () {
  const { h, icon, api } = A;
  const K = A.plannerKit;
  const { P, SOURCE_BADGE, save } = K;
  let rowMarks = new Map(); // 第 2 步每一行的兼容性标记

  const minimal = (i) => ({
    projectId: i.projectId, slug: i.slug, title: i.title, selected: i.selected, style: i.style, source: i.source, pinnedVersionId: i.pinnedVersionId,
    local: i.local, localPath: i.localPath, installed: i.installed, file: i.file, enabled: i.enabled,
  });

  async function resolve() {
    const p = P.plan;
    const my = ++P.resolveSeq;
    P.resolving = true;
    if (P.step === 2) renderList();
    try {
      const r = await api('planner:resolve', { mc: p.mc, loader: p.loader, items: p.items.map(minimal) });
      if (my !== P.resolveSeq) return;
      P.resolved = r;
    } catch (e) {
      if (my === P.resolveSeq) A.errorToast('兼容性分析失败', e);
    } finally {
      if (my === P.resolveSeq) { P.resolving = false; if (P.step === 2) renderList(); }
    }
  }
  const resolveSoon = A.debounce(resolve, 700);

  function setSelected(pid, sel) {
    const it = P.plan.items.find((i) => i.projectId === pid);
    if (it) it.selected = sel;
    save();
    renderList();
    resolveSoon();
  }

  function addProject(p, style = 'custom') {
    if (P.plan.items.some((i) => i.projectId === p.id)) { setSelected(p.id, true); return; }
    P.plan.items.push({ projectId: p.id, slug: p.slug, title: p.title, description: p.description, icon: p.icon, downloads: p.downloads, categories: p.categories, style, source: style === 'custom' ? 'custom' : 'popular', selected: true });
    save();
    renderList();
    resolveSoon();
  }

  function renderList() {
    const p = P.plan;
    const r = P.resolved;
    const byId = new Map(r ? r.items.filter((i) => i.projectId).map((i) => [i.projectId, i]) : []);
    const t = r ? r.totals : null;
    const selectedCount = p.items.filter((i) => i.selected).length;
    // 已忽略的提醒不计入徽章和提醒栏
    const PC = A.plannerConflicts;
    const { active } = PC.split(p, r);
    const errors = active.filter((c) => c.severity === 'crit').length;
    const warnings = active.filter((c) => c.severity === 'warn').length;
    rowMarks = PC.marks(active, byId);

    const summary = h('div.plan-summary',
      h('div.ps-main',
        h('div.ps-title', A.nm(p.name) || K.defaultName()),
        h('div.faint', { style: { fontSize: '12.5px' } }, `Minecraft ${p.mc} · ${A.LOADERS[p.loader].name}`)),
      h('div.ps-stats',
        stat(t ? t.count : selectedCount, '个 Mod'),
        stat(t ? t.deps : '–', '个前置'),
        stat(t ? A.fmtBytes(t.size) : '–', '预计大小'),
        h('div.ps-compat', P.resolving ? h('span.row.gap-s', h('span.spinner', { style: { width: '14px', height: '14px', borderWidth: '2px' } }), h('span.muted', '分析中…'))
          : t ? (errors ? h('span.badge.crit', icon('xCircle', 12), `${errors} 个冲突`) : warnings ? h('span.badge.warn', icon('alert', 12), `${warnings} 个警告`) : h('span.badge.ok', icon('check', 12), '未发现冲突')) : null)),
      h('div.row.gap-s',
        h('button.btn.sm', { onclick: () => A.modkit.modrinthPicker({ mc: p.mc, loader: p.loader, mode: 'select', title: '搜索并添加 Mod', exclude: new Set(p.items.map((i) => i.projectId)), onPick: (proj) => addProject(proj) }) }, icon('plus', 14), '添加 Mod'),
        h('button.btn.sm', { onclick: () => K.importDialog() }, icon('import', 14), '导入'),
        h('button.btn.sm', { onclick: () => K.exportList() }, icon('upload', 14), '导出清单'),
        h('button.btn.sm.ghost.icon', { 'data-tip': '重新分析', onclick: resolve }, icon('refresh', 14))));

    // 冲突（卡片、忽略、恢复在 planner-conflicts.js）
    const conflicts = PC.section(r, { plan: p, byId, setSelected, onChange: () => { save(); renderList(); } });
    // 为了能一起运行自动换了版本的 Mod（jar 里声明的版本限制，1.5.8）
    const NL = String.fromCharCode(10);
    const adjusted = r && r.adjusted && r.adjusted.length ? h('div.issue.info',
      h('div.issue-ico', A.levelIcon('info', 18)),
      h('div.issue-body', h('div.issue-title', `为了能一起运行，换了 ${r.adjusted.length} 个 Mod 的版本`),
        h('div.issue-detail', r.adjusted.map((c) => `${c.title}：${c.from} → ${c.to}${NL}${c.reasons.map((x) => `　· ${x}`).join(NL)}`).join(NL),
          `${NL}这些限制写在 Mod 文件里，Modrinth 上看不到。想用别的版本，可以在清单里移除其中一个 Mod`))) : null;

    // 分组
    const styleOrder = (P.meta ? P.meta.styles : []).map((s) => s.id);
    const styleName = (id) => ({ import: '导入的 Mod', custom: '手动添加', installed: '已安装（取消勾选即移除）' }[id] || ((P.meta ? P.meta.styles : []).find((s) => s.id === id) || {}).name || '其他');
    const groups = new Map();
    for (const it of p.items) {
      const g = it.style || 'custom';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      if (a === 'installed') return -1;
      if (b === 'installed') return 1;
      const ia = styleOrder.indexOf(a); const ib = styleOrder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const groupEls = orderedKeys.map((g) => {
      const list = groups.get(g).sort((a, b) => (b.selected - a.selected) || (b.source === 'pick') - (a.source === 'pick') || (b.downloads || 0) - (a.downloads || 0));
      const sel = list.filter((i) => i.selected).length;
      return h('div.plan-group',
        h('div.pg-head', h('b', styleName(g)), h('span.faint', `${sel}/${list.length}`), h('div.spacer'),
          h('button.btn.sm.ghost', { onclick: () => { const all = sel < list.length; list.forEach((i) => { i.selected = all; }); save(); renderList(); resolveSoon(); } }, sel < list.length ? '全选' : '全不选')),
        list.map((it) => planRow(it, byId.get(it.projectId))));
    });

    const deps = r ? r.items.filter((i) => i.dependency) : [];
    const depGroup = deps.length ? h('div.plan-group',
      h('div.pg-head', h('b', '自动添加的前置 Mod'), h('span.faint', `${deps.length}`), h('div.spacer'), h('span.faint', { style: { fontSize: '12px' } }, '其他 Mod 需要它们才能运行')),
      deps.map((d) => planRow({ ...d, selected: true, source: 'dependency' }, d, true))) : null;

    const sugg = r && r.suggestions && r.suggestions.length ? h('div.plan-group',
      h('div.pg-head', h('b', '推荐搭配'), h('span.faint', { style: { fontSize: '12px' } }, '清单中 Mod 的可选扩展')),
      h('div.sugg-row', r.suggestions.map((s) => h('div.sugg', { onclick: () => addProject({ id: s.projectId, slug: s.slug, title: s.title, description: s.description, icon: s.icon, downloads: s.downloads, categories: s.categories }) },
        h('img', { src: s.icon || A.blockImage('unknown', 48) }), h('div', h('b', zhSpan(s.slug, s.projectId, s.title), A.nm(s.title)), h('div.faint', s.reason)), icon('plus', 16))))) : null;

    const empty = !p.items.length ? A.emptyState({ iconName: 'puzzle', title: '清单还是空的', text: '回到上一步选择玩法类型，或者直接搜索添加 / 导入你的 Mod 列表', action: h('div.row', h('button.btn.primary', { onclick: () => A.modkit.modrinthPicker({ mc: p.mc, loader: p.loader, mode: 'select', title: '搜索并添加 Mod', onPick: (proj) => addProject(proj) }) }, icon('search', 16), '搜索 Mod'), h('button.btn', { onclick: () => K.importDialog() }, '导入列表')) }) : null;

    const canNext = r && !P.resolving && t && (t.count + t.deps > 0 || p.mode === 'edit');
    // 提醒栏和上一步 / 下一步一起贴在页面底部；问题刚全部处理完时显示一下「都处理好了」再收起
    let alertBar = r ? PC.bar(r, p) : null;
    if (r && !P.resolving) {
      if (!alertBar && P.hadActive === p) alertBar = A.alertBar.cleared();
      P.hadActive = active.length ? p : null;
    }
    A.mount(K.body, summary, conflicts, adjusted, empty, ...groupEls, depGroup, sugg, h('div.pl-dock', alertBar,
      h('div.pl-foot',
        h('button.btn.ghost', { onclick: () => K.goStep(1) }, '上一步'),
        h('div.spacer'),
        r && t && t.unavailable ? h('span.faint', { style: { fontSize: '12.5px' } }, `${t.unavailable} 个 Mod 不支持此版本，安装时会跳过`) : null,
        h('button.btn.primary.lg', {
          disabled: !canNext,
          onclick: async () => {
            if (errors && !(await A.confirm(`清单中还有 ${errors} 个冲突没有解决，继续安装很可能导致游戏崩溃。\n确定要继续吗？`, { okText: '仍然继续' }))) return;
            K.goStep(3);
          },
        }, p.mode === 'edit' ? '下一步：应用修改' : '下一步：下载安装', icon('chevronRight', 16)))));
    fillPlanZh([...p.items, ...deps, ...(r && r.suggestions ? r.suggestions.map((s) => ({ slug: s.slug, projectId: s.projectId, title: s.title })) : [])]);
  }

  // Mod 的中文名（1.5.7：配置器以前全是英文）：本地对照表 → MC 百科缓存（百科的译名优先，1.6.1）→ 开着 MC 百科时按需查。清单里的 Mod 都是 Modrinth 项目
  const zhProj = (slug, id, title) => ({ source: 'modrinth', slug, id, title });
  function zhSpan(slug, id, title) {
    const zh = A.modNames.zhOf({ slug, title });
    return h('span.mn-zh', { 'data-key': A.mcmodUi.keyOf(zhProj(slug, id, title)) }, zh ? `${zh} ` : '');
  }
  let zhSeq = 0;
  function fillPlanZh(items) {
    const my = ++zhSeq;
    const list = items.filter((i) => !i.local && (i.slug || i.projectId)).map((i) => zhProj(i.slug, i.projectId, i.title));
    A.mcmodUi.fillZh(K.body, list, { lookup: true, lookupMax: 60, alive: () => my === zhSeq && P.step === 2 });
  }

  const stat = (v, label) => h('div.ps-stat', h('b', v), h('span', label));

  function planRow(it, res, locked) {
    let status = null;
    if (it.local) status = h('span.badge.warn', '本地文件');
    else if (!it.selected) status = h('span.faint', { style: { fontSize: '12px' } }, '未选择');
    else if (P.resolving && !res) status = h('span.spinner', { style: { width: '13px', height: '13px', borderWidth: '2px' } });
    else if (res && res.status === 'ok') {
      status = h('span.row.gap-s', h('span.ver-num', A.nm(res.version.number)), res.version.type !== 'release' ? h('span', { class: `badge ${res.version.type === 'beta' ? 'warn' : 'danger'}` }, res.version.type) : null,
        res.adjusted ? h('span.badge.info', { 'data-tip': `原本是 ${res.adjusted.from}，为了和清单里其他 Mod 一起运行换成了这个版本` }, '已换版本') : null);
    }
    else if (res && res.status === 'unavailable') status = h('span.badge.crit', `不支持 ${P.plan.mc}`);
    else if (it.status === 'not-found' || (res && res.status === 'not-found')) status = h('span.badge.crit', '未找到');
    const [bName, bCls] = SOURCE_BADGE[it.source] || (it.installed ? [it.enabled === false ? '已禁用' : '已安装', it.enabled === false ? 'warn' : 'ok'] : ['', '']);
    if (it.installed && it.local && it.selected) status = h('span.faint', { style: { fontSize: '12px' } }, A.nm(it.versionNumber) || '本地文件');
    if (it.installed && !it.selected) status = h('span.badge.crit', '将移除');
    const removable = !it.installed && (['import', 'custom', 'local'].includes(it.source) || it.status === 'not-found');
    const mark = it.selected !== false && (rowMarks.get(it.projectId) || rowMarks.get(it.slug));
    return h('div', { class: `plan-row ${it.selected ? '' : 'off'} ${res && res.status === 'unavailable' ? 'bad' : ''} ${mark ? `marked ${mark.level}` : ''}` },
      locked ? h('span.pr-lock', { 'data-tip': '前置 Mod 会随依赖它的 Mod 自动添加' }, icon('shield', 14)) : h('label.pr-check', h('input', {
        type: 'checkbox', checked: !!it.selected, disabled: !it.projectId && !it.installed && !it.local,
        onchange: (e) => { it.selected = e.target.checked; save(); renderList(); resolveSoon(); },
      })),
      h('img.pr-ico', { src: it.icon || A.blockImage(it.local ? 'unknown' : 'fabric', 48), loading: 'lazy', onerror: (e) => { e.target.src = A.blockImage('unknown', 48); } }),
      h('div.pr-body',
        h('div.pr-title', h('b', it.local ? null : zhSpan(it.slug, it.projectId, it.title), A.nm(it.title)),
          mark ? h('button', { type: 'button', class: `badge ${mark.level} pr-mark`, 'data-tip': A.t('conflict.jumpTip'), onclick: () => A.plannerConflicts.jump(mark.key) }, mark.label) : null,
          bName ? h('span', { class: `badge ${bCls}` }, bName) : null, it.matched === 'search' ? h('span.badge.warn', { 'data-tip': `根据「${it.input}」搜索匹配` }, '模糊匹配') : null),
        // 「被谁需要」是界面文字要翻；Mod 自己的简介是网上来的内容，和下载页一样标 data-no-tr，不翻也不当成界面文字
        locked && it.requiredBy && it.requiredBy.length
          ? h('div.pr-desc', `被 ${A.nmJoin(it.requiredBy.slice(0, 3))} 需要`)
          : h('div.pr-desc', { 'data-no-tr': '' }, A.nm(it.description) || A.nm(it.input) || '')),
      h('div.pr-status', status),
      it.slug ? h('button.btn.sm.icon.ghost', { 'data-tip': '在 Modrinth 查看', onclick: () => api('shell:external', `https://modrinth.com/mod/${it.slug}`) }, icon('external', 14)) : null,
      removable && !locked ? h('button.btn.sm.icon.ghost', { 'data-tip': '从清单移除', onclick: () => { P.plan.items = P.plan.items.filter((x) => x !== it); save(); renderList(); resolveSoon(); } }, icon('x', 14)) : null);
  }

  Object.assign(K, { minimal, renderList, resolve });
})();
