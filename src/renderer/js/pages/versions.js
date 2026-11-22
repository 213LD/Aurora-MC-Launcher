'use strict';
/* 游戏配置：每个配置是一个独立的游戏实例（版本 + 独立的 Mod / 存档 / 设置） */
(function () {
  const { h, icon, api, state, on, $, t } = A;

  let root;
  let gridEl;
  let filter = 'all';
  let query = '';
  let showCores = false;

  function build() {
    root = $('#page-versions');
    gridEl = h('div.pgrid.fade-list');
    const search = h('div.input-wrap', icon('search', 16), h('input.input', { placeholder: '搜索配置…', oninput: A.debounce((e) => { query = e.target.value.trim().toLowerCase(); render(); }, 120) }));
    A.mount(root, h('div.page-inner',
      h('div.page-head',
        h('div', h('h1', t('term.profile')), h('p', '每个配置拥有独立的 Mod、存档与设置，可以随时切换：纯净版、自己搭配的 Mod 配置、整合包…')),
        h('div.actions',
          h('button.btn', { onclick: importPack, 'data-simple-off': '', 'data-net': '' }, icon('import', 16), t('term.importPack')),
          // rc8：从其他启动器迁移的入口放到这里也有一个（以前只在设置的数据分类里，玩家找不到）
          h('button.btn', { onclick: () => A.migrateUi.importDialog({ source: 'foreign' }), 'data-tip': '从官方启动器、HMCL、PCL2、MultiMC / Prism 导入游戏配置和存档。原来的文件不会被改动' }, icon('import', 16), '从其他启动器导入'),
          h('button.btn', { onclick: () => A.migrateUi.exportDialog(), 'data-tip': '把游戏配置、存档、设置打包，换电脑时用', 'data-simple-off': '' }, icon('upload', 16), '导出数据'),
          h('button.btn.primary', { onclick: newProfileDialog, 'data-simple-off': '', 'data-net': '' }, icon('plus', 16), t('term.newProfile')))),
      h('div.toolbar', search,
        A.seg([{ value: 'all', label: '全部' }, { value: 'vanilla', label: t('term.vanilla') }, { value: 'mod', label: 'Mod 配置' }, { value: 'modpack', label: t('term.modpack') }], filter, (v) => { filter = v; render(); }, { accent: true }),
        h('div.spacer'),
        h('label.row.gap-s', { style: { cursor: 'pointer', fontSize: '12.5px', color: 'var(--text-2)' }, 'data-tip': '作为加载器前置自动安装的原版核心' }, A.toggle(showCores, (v) => { showCores = v; render(); }), '显示前置核心'),
        h('button.btn.icon', { 'data-tip': '刷新', onclick: () => A.refreshInstalled() }, icon('refresh', 16)),
        h('button.btn.icon', { 'data-tip': '打开版本文件夹', onclick: () => openDir('', 'version') }, icon('folder', 16))),
      gridEl));
  }

  const isCore = (v) => v.usedAsParent && !v.hasMeta && !v.loader;

  function render() {
    if (!gridEl) return;
    const cur = A.currentVersion();
    let list = state.installed.filter((v) => showCores || !isCore(v) || (cur && cur.id === v.id));
    if (filter === 'vanilla') list = list.filter((v) => v.profileType === 'vanilla');
    if (filter === 'mod') list = list.filter((v) => v.profileType === 'custom' || v.profileType === 'planner');
    if (filter === 'modpack') list = list.filter((v) => v.profileType === 'modpack');
    if (query) list = list.filter((v) => `${v.id} ${v.displayName || ''} ${A.nm(v.mcVersion)} ${v.loader ? v.loader.type : ''}`.toLowerCase().includes(query));
    if (!state.installed.length) {
      A.mount(gridEl, h('div', { style: { gridColumn: '1 / -1' } }, A.emptyState({
        img: A.blockImage('grass', 96), title: '还没有任何游戏配置', text: '新建一个纯净版或 Mod 配置，或者直接安装一个整合包',
        action: h('div.row', h('button.btn.primary', { onclick: newProfileDialog, 'data-simple-off': '', 'data-net': '' }, icon('plus', 16), t('term.newProfile')), h('button.btn', { onclick: () => A.go('planner'), 'data-simple-off': '', 'data-net': '' }, icon('sparkles', 16), `使用${t('term.planner')}`)),
      })));
      return;
    }
    const sorted = [...list].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.installedAt || 0) - (a.installedAt || 0));
    const compact = A.uiStyle.is('compact');
    gridEl.className = compact ? 'vsplit' : 'pgrid fade-list';
    if (!sorted.length) { A.mount(gridEl, h('div', { style: { gridColumn: '1 / -1' } }, A.emptyState({ iconName: 'search', title: '没有匹配的配置' }))); return; }
    if (compact) { split(sorted, cur); return; }
    A.mount(gridEl, sorted.map((v) => card(v, cur && cur.id === v.id)));
  }

  /** 配置卡片和紧凑风格详情栏共用的操作 */
  function actions(v) {
    return [
      v.loader && { icon: 'puzzle', label: t('term.mods'), on: () => A.go('mods', { versionId: v.id }) },
      v.loader && { icon: 'folder', label: '打开 mods 文件夹', on: () => openDir(v.id, 'mods') },
      v.loader && { icon: 'wrench', label: t('term.debug'), on: () => A.debugDialog(v), off: true },
      { icon: 'save', label: t('backup.menu'), on: () => A.savesManager(v) },
      { icon: 'settings', label: '配置设置', on: () => openSettings(v) },
      { icon: 'more', label: '更多', on: (e) => moreMenu(e.currentTarget, v) },
    ].filter(Boolean);
  }

  function tagsOf(v) {
    const pt = A.PROFILE_TYPES[v.profileType] || A.PROFILE_TYPES.vanilla;
    const tags = [h('span', { class: `badge ${pt.cls}` }, pt.name)];
    if (v.loader) tags.push(h('span', { class: `badge ${v.loader.type}` }, (A.LOADERS[v.loader.type] || {}).name || v.loader.type));
    if (v.loader) tags.push(h('span.badge', `${v.mods.enabled}${v.mods.total !== v.mods.enabled ? `/${v.mods.total}` : ''} 个 Mod`));
    if (v.activePreset) tags.push(h('span.badge', icon('layers', 12), v.activePreset));
    if (v.modsOff) tags.push(h('span.badge.warn', { 'data-tip': `已${t('term.disableAll')}，可在菜单中「${t('term.restoreAll')}」` }, 'Mod 已全部禁用'));
    if (v.nostalgia) tags.push(h('span.badge', icon('clock', 12), t('term.nostalgia')));
    if (v.type && v.type !== 'release') tags.push(h('span.badge.warn', A.TYPE_NAMES[v.type] || v.type));
    if (v.missingParent) tags.push(h('span.badge.crit', '缺少前置版本'));
    if (!v.isolated && v.loader) tags.push(h('span.badge.warn', { 'data-tip': '与其他版本共享 mods 文件夹' }, '未隔离'));
    const noJava = A.javaCheck.badge(v);
    if (noJava) tags.push(noJava);
    return tags;
  }

  const iconOf = (v) => (v.modpack && v.modpack.icon ? v.modpack.icon : A.versionIcon(v, 96));
  const subOf = (v) => (v.displayName && v.displayName !== v.id ? `${A.nm(v.id)} · ${A.versionSub(v)}` : A.versionSub(v));
  const playedOf = (v) => (v.lastPlayed ? `${A.fmtRelative(v.lastPlayed)}游玩 · 共 ${A.fmtDuration(v.playTime)}` : '尚未游玩');
  const img = (v, cls) => h(cls, { src: iconOf(v), alt: '', onerror: (e) => { e.target.src = A.versionIcon(v, 96); } });

  /** 经典紧凑风格：左边配置列表、右边当前配置的详情和按钮（类似 MultiMC / Prism） */
  function split(list, cur) {
    const sel = (cur && list.find((v) => v.id === cur.id)) || list[0];
    const rows = list.map((v) => h('div', {
      class: `vl-row ${v.id === sel.id ? 'on' : ''}`, role: 'option', tabindex: 0, 'aria-selected': String(v.id === sel.id),
      onclick: () => A.setConfig({ selectedVersion: v.id }), ondblclick: () => A.launch(v.id),
      onkeydown: (e) => { if (e.key === 'Enter') A.launch(v.id); else if (e.key === ' ') { e.preventDefault(); A.setConfig({ selectedVersion: v.id }); } },
    }, img(v, 'img.vl-ico'), h('div.vl-text', h('div.vl-name', A.noTr(A.displayName(v))), h('div.vl-sub', subOf(v))),
    cur && cur.id === v.id ? h('span.badge.accent', '当前') : null));
    const detail = h('div.vl-detail',
      h('div.vl-head', img(sel, 'img.vl-big'), h('div', { style: { minWidth: 0 } }, h('div.vl-title', A.noTr(A.displayName(sel))), h('div.vl-sub', subOf(sel)))),
      h('button.btn.primary.vl-play', { onclick: () => A.launch(sel.id) }, icon('play', 16), '启动'),
      h('div.vl-actions', actions(sel).map((a) => h('button.btn', { onclick: a.on, 'data-simple-off': a.off ? '' : null }, icon(a.icon, 15), a.label))),
      h('div.vl-info',
        sel.description ? h('div.pc-desc', sel.description) : null,
        h('div.pc-tags', tagsOf(sel)),
        h('div.pc-iso', A.iso.chip(sel)),
        h('div.faint', { style: { fontSize: '12px' } }, playedOf(sel))));
    A.mount(gridEl, h('div.vl-list', { role: 'listbox', 'aria-label': t('term.profile') }, rows), detail);
  }

  function card(v, selected) {
    return h('div', { class: `pcard ${selected ? 'selected' : ''}`, onclick: () => A.setConfig({ selectedVersion: v.id }), ondblclick: () => A.launch(v.id) },
      selected ? h('span.badge.accent.pc-cur', icon('check', 12), '当前') : null,
      h('div.pc-top',
        img(v, 'img.pc-icon'),
        h('div.pc-head',
          h('div.pc-name', A.noTr(A.displayName(v))),
          h('div.pc-sub', subOf(v)))),
      v.description ? h('div.pc-desc', v.description) : null,
      h('div.pc-tags', tagsOf(v)),
      h('div.pc-iso', A.iso.chip(v)),
      // 游玩时间单独一行（1.8.0：以前和工具按钮挤在一行，按钮多了会被挡住）；卡片宽度跟网格列走，内容多了往下变长
      h('div.pc-played.faint', icon('clock', 12), h('span', playedOf(v))),
      h('div.pc-foot',
        h('div.pc-actions', { onclick: (e) => e.stopPropagation() },
          actions(v).map((a) => h('button.btn.sm.icon.ghost', { 'data-tip': a.label, 'aria-label': a.label, onclick: a.on, 'data-simple-off': a.off ? '' : null }, icon(a.icon, 16))),
          h('button.btn.sm.primary', { onclick: () => A.launch(v.id) }, icon('play', 14), '启动'))));
  }

  async function openDir(id, sub) {
    try { await api('shell:open', await api('versions:dir', id, sub)); } catch (e) { A.errorToast('无法打开目录', e); }
  }

  function moreMenu(anchor, v) {
    A.menu(anchor, [
      { label: '配置设置', icon: 'settings', onClick: () => openSettings(v) },
      { label: '组件管理', icon: 'layers', sub: '更换游戏版本、加载器，装 OptiFine / 光影', onClick: () => openSettings(v, { focus: 'components' }), simpleOff: true, net: true },
      { label: t('term.isolation'), icon: 'shield', sub: `独立 / 共享 / ${t('term.sandbox')}`, onClick: () => A.iso.editor(v), simpleOff: true },
      A.iso.isMixed(v) ? { label: '转为正式配置', icon: 'check', sub: '把测试副本 / 共享的内容留成自己的', onClick: () => A.iso.promote(v) } : null,
      v.loader ? { label: t('term.mods'), icon: 'puzzle', onClick: () => A.go('mods', { versionId: v.id }) } : null,
      v.loader ? { label: `用${t('term.planner')}修改`, icon: 'sparkles', sub: '自动识别版本与已装 Mod，快速增删', onClick: () => A.go('planner', { edit: v.id }), simpleOff: true, net: true } : null,
      v.loader ? { label: v.modsOff ? t('term.restoreAll') : t('term.disableAll'), icon: v.modsOff ? 'refresh' : 'x', sub: v.modsOff ? `恢复之前禁用的 ${v.modsOff} 个 Mod` : '暂时以无 Mod 状态游玩，之后可以恢复', onClick: () => A.toggleAllMods(v) } : null,
      '-',
      { head: '用这个配置的存档测试' },
      { label: t('term.testNewVersion'), icon: 'flask', sub: '新版本只会升级存档副本', onClick: () => A.iso.testNewVersion(v), simpleOff: true, net: true },
      v.loader ? { label: t('term.modUpdateCopy'), icon: 'flask', sub: '在副本里放心地更新 Mod', onClick: () => A.iso.modUpdateCopy(v), simpleOff: true } : null,
      '-',
      { label: '复制配置', icon: 'copy', sub: '连同 Mod、配置与存档一起复制', onClick: () => duplicate(v) },
      { label: t('term.exportArchive'), icon: 'upload', sub: '包含 Mod、配置与档案信息', onClick: () => exportPack(v, true), simpleOff: true },
      v.loader ? { label: t('term.exportMrpack'), icon: 'upload', sub: '可在其他启动器中导入', onClick: () => exportPack(v), simpleOff: true } : null,
      v.loader ? { label: t('term.exportModList'), icon: 'file', onClick: () => exportList(v), simpleOff: true } : null,
      { label: t('term.completeFiles'), icon: 'wrench', onClick: () => complete(v.id), simpleOff: true, net: true },
      { label: '重命名', icon: 'edit', onClick: () => rename(v) },
      '-',
      { label: '打开游戏目录', icon: 'folder', onClick: () => openDir(v.id) },
      { label: '打开存档文件夹', icon: 'globe', onClick: () => openDir(v.id, 'saves') },
      '-',
      { label: '删除配置', icon: 'trash', danger: true, onClick: () => remove(v) },
    ].filter(Boolean), { align: 'right' });
  }

  async function complete(id) {
    try { await api('versions:complete', id); A.toast({ level: 'info', text: `开始补全 ${A.nm(id)} 的游戏文件` }); } catch (e) { A.errorToast('无法补全', e); }
  }

  async function rename(v) {
    const name = await A.prompt('重命名配置', { value: v.id, label: '新的名称（同时也是版本文件夹名）', validate: (s) => A.nameProblem(s) });
    if (!name || name === v.id) return;
    try {
      await api('versions:rename', v.id, name);
      await api('profiles:setMeta', name, { name: null });
      if (state.config.selectedVersion === v.id) await A.setConfig({ selectedVersion: name });
      A.toast({ level: 'ok', text: `已重命名为 ${A.nm(name)}` });
    } catch (e) { A.errorToast('重命名失败', e); }
  }

  async function duplicate(v) {
    const name = await A.prompt('复制配置', { value: `${v.id} 副本`, label: '新配置的名称', hint: 'Mod、配置文件与存档都会被复制', validate: (s) => A.nameProblem(s) || (state.installed.some((x) => x.id === s) ? '已存在同名配置' : null) });
    if (!name) return;
    try {
      A.toast({ level: 'info', text: '正在复制…' });
      await api('profiles:duplicate', v.id, name);
      A.toast({ level: 'ok', text: `已复制为 ${A.nm(name)}` });
    } catch (e) { A.errorToast('复制失败', e); }
  }

  /**
   * 删除配置：没有自己的存档时一次确认（进回收站）；
   * 有存档时两步确认——列出存档、默认先备份，再弹一次、等 5 秒才能确认（rc3 起不用输入配置名）
   */
  async function remove(v) {
    const name = A.displayName(v);
    const deps = state.installed.filter((x) => x.inheritsFrom === v.id);
    let info = null;
    try { info = await api('versions:removeInfo', v.id); } catch { /* 读不到时按有存档处理，宁可多确认一次 */ }
    if (info && info.running) { A.toast({ level: 'warn', text: `「${info.running}」的游戏正在运行，先关掉游戏再删除` }); return; }
    const worlds = info ? info.worlds : [];
    const hasSaves = !info || worlds.length > 0;
    const worldLine = (w) => t(w.lastPlayed ? 'profile.world' : 'profile.worldNever', { name: w.name, size: `${A.fmtBytes(w.size)}${w.partial ? '+' : ''}`, time: A.fmtRelative(w.lastPlayed) });
    const items = [{ icon: 'folder', label: t('profile.deleteFolder'), sub: info ? info.dir : null }];
    if (worlds.length) items.push({ icon: 'globe', label: t('profile.deleteSaves', { n: worlds.length }), sub: worlds.slice(0, 6).map(worldLine).join('\n') + (worlds.length > 6 ? '\n…' : '') });
    else if (info && info.savesMode === 'link') items.push({ icon: 'link', keep: true, label: t('profile.deleteSavesShared', { source: A.nm(A.iso.sourceName(info.source)) }) });
    else if (info) items.push({ icon: 'globe', keep: true, label: t('profile.deleteSavesNone') });
    const notes = [];
    if (deps.length) notes.push(t('profile.deleteDeps', { names: A.nmJoin(deps.map((d) => d.id)) }));
    if (info && info.dependents.length) notes.push(t('profile.deleteDependents', { names: A.nmJoin(info.dependents), sandbox: t('term.sandbox') }));
    notes.push(t('danger.trashNote'));
    const r = await A.dangerConfirm({
      level: hasSaves ? 3 : 2,
      title: t('profile.deleteTitle'),
      text: t('profile.deleteQuestion', { name: A.nm(name) }),
      items,
      note: notes.join('\n'),
      noteLevel: notes.length > 1 ? 'warn' : 'info', // 只有「会进回收站」时是提示，有依赖关系时是警告
      confirmName: hasSaves ? v.id : null,
      backup: worlds.length ? { checked: true } : null,
    });
    if (!r) return;
    if (r.backup) {
      try {
        const b = await api('profiles:backupSaves', v.id);
        if (b.path) A.toast({ level: 'ok', text: t('danger.backupDone', { path: A.nm(b.path) }), actions: [{ label: '打开', onClick: () => api('shell:open', b.path) }] });
      } catch (e) { A.errorToast(t('danger.backupFailed'), e); return; }
    }
    await doRemove(v, false);
  }

  async function doRemove(v, permanent) {
    try {
      await api('versions:remove', v.id, { permanent });
      A.toast({ level: 'ok', text: t('profile.deleted', { name: A.nm(v.id) }) });
    } catch (e) {
      // 回收站不可用（U 盘、网络盘）：再确认一次，用户同意才永久删除
      if (!permanent && e.reason && e.reason.code === 'TRASH_UNAVAILABLE') {
        const ok = await A.dangerConfirm({ level: 3, title: t('trash.unavailableTitle'), text: t('trash.unavailable', { name: A.nm(v.id) }), note: t('danger.permanentNote'), noteLevel: 'crit', okText: t('trash.permanentDelete'), confirmName: v.id });
        if (ok) await doRemove(v, true);
        return;
      }
      A.errorToast(t('profile.deleteFailed'), e);
    }
  }

  function exportPack(v, aurora = false) {
    const nameIn = h('input.input', { value: A.displayName(v) });
    const verIn = h('input.input', { value: '1.0.0' });
    const sumIn = h('input.input', { value: v.description || '', placeholder: '可选' });
    const cfg = A.toggle(true);
    A.modal({
      title: aurora ? t('term.exportArchive') : t('term.exportMrpack'),
      subtitle: aurora ? `在 .mrpack 的基础上附带配置类型、${t('term.preset')}、隔离策略与游玩档案` : `Modrinth 格式，可在 ${A.BRAND.short}、Prism、Modrinth App 等启动器中导入`,
      icon: 'upload',
      size: 'md',
      body: h('div',
        h('div.field', h('label', '整合包名称'), nameIn),
        h('div.row', h('div.field', { style: { flex: 1 } }, h('label', '版本号'), verIn), h('div.field', { style: { flex: 2 } }, h('label', '简介'), sumIn)),
        h('label.row', { style: { cursor: 'pointer', fontSize: '13px' } }, cfg, '包含 config、资源包、光影与游戏选项'),
        h('p.faint', { style: { fontSize: '12px', margin: '12px 0 0' } }, '能在 Modrinth 上找到的 Mod 只会写入下载链接，其余文件会直接打包。存档不会被导出。')),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: '选择位置并导出', kind: 'primary', icon: 'upload',
          onClick: async () => {
            const include = cfg.get() ? ['config', 'resourcepacks', 'shaderpacks', 'options.txt', 'kubejs', 'defaultconfigs'] : [];
            const id = await api('modpack:export', v.id, { name: nameIn.value.trim() || v.id, version: verIn.value.trim() || '1.0.0', summary: sumIn.value.trim(), include, aurora });
            if (id) A.toast({ level: 'info', text: '开始导出，可在右上角查看进度' });
          },
        },
      ],
    });
  }

  async function exportList(v) {
    try {
      const r = await api('mods:list', v.id);
      const lines = r.mods.filter((m) => m.enabled).map((m) => (m.modrinth && m.modrinth.slug ? `https://modrinth.com/mod/${m.modrinth.slug}` : m.name));
      const text = `# ${A.displayName(v)} · Minecraft ${A.nm(v.mcVersion)}${v.loader ? ` · ${(A.LOADERS[v.loader.type] || {}).name} ${v.loader.version}` : ''}\n# 共 ${lines.length} 个 Mod，可在「${t('term.planner')} → 导入」中使用\n${lines.join('\n')}\n`;
      const p = await api('dialog:save', t('term.exportModList'), `${v.id}-mods.txt`, text);
      if (p) A.toast({ level: 'ok', text: `已保存到 ${p}` });
    } catch (e) { A.errorToast('导出失败', e); }
  }

  async function importPack() {
    const file = await api('dialog:file', t('term.importPack'), [{ name: `${t('term.modpack')} / ${t('term.archive')} / 数据导出包`, extensions: ['mrpack', 'aurora', 'zip', A.migrateUi.EXT] }]);
    if (!file) return;
    // 「导出数据」得到的整包（1.5.3）走数据导入
    if (file.toLowerCase().endsWith(`.${A.migrateUi.EXT}`)) { A.migrateUi.importDialog({ file }); return; }
    let info;
    try { info = await api('modpack:read', file); } catch (e) { A.errorToast('无法读取整合包', e); return; }
    A.modpackInstallDialog({
      title: `${info.format === 'aurora' ? `导入${t('term.archive')}` : t('term.importPack')}：${A.nm(info.name)}`,
      subtitle: `${info.version ? `${info.version} · ` : ''}Minecraft ${info.mc}${info.loader ? ` · ${(A.LOADERS[info.loader.type] || {}).name} ${info.loader.version}` : ''}`,
      name: info.name,
      mc: info.mc,
      loader: info.loader && info.loader.type,
      summary: info.summary,
      badges: [h('span.badge', `${info.files.length} 个下载文件`), h('span.badge', `${info.overrideCount} 个内置文件`)],
      onConfirm: async (name, extras, iso) => {
        await api('modpack:installFile', file, name, { ...extras, isolation: iso });
        A.toast({ level: 'info', text: '开始安装整合包，可在右上角查看进度' });
      },
    });
  }

  // ── 新建配置 ──
  function newProfileDialog() {
    const STEPS = [t('steps.type'), t('steps.version'), t('steps.loader')];
    const body = h('div');
    const m = A.modal({ title: t('term.newProfileTitle'), icon: 'plus', size: 'lg', steps: { items: STEPS, current: 0 }, body, actions: [] });
    const tile = (img, title, desc, onClick) => A.choice({ layout: 'tile', img, title, desc, onClick });
    const renderTypes = () => {
      m.setSteps({ items: STEPS, current: 0 });
      m.setActions([]);
      A.mount(body, h('div.choices.cols-3',
        tile(A.blockImage('grass', 96), t('term.vanilla'), '原汁原味的 Minecraft，拥有独立存档', () => versionStep('vanilla')),
        tile(A.blockImage('diamond', 96), t('term.vanillaPlus'), '原版玩法 + 小地图、物品管理器、背包整理、光影与优化', () => versionStep('vanillaplus')),
        tile(A.blockImage('fabric', 96), '自定义 Mod 配置', '选择版本与加载器，自己挑选 Mod', () => versionStep('custom')),
        tile(A.blockImage('old', 96), t('term.nostalgia'), 'Alpha / Beta、1.7.10、1.12.2 等经典版本，自动配置 Java 8', () => { m.close(); A.nostalgiaDialog(); }),
        tile(A.blockImage('neoforge', 96), '安装整合包', '从 Modrinth / CurseForge 下载，或导入整合包文件', () => { m.close(); A.go('download', { tab: 'modpack' }); }),
        tile(A.blockImage('quilt', 96), t('term.planner'), '按玩法生成清单，自动安装并排查冲突', () => { m.close(); A.go('planner', { fresh: true }); })));
    };
    renderTypes();

    async function versionStep(type) {
      m.setSteps({ items: type === 'vanilla' ? STEPS.slice(0, 2) : STEPS, current: 1 });
      if (!state.manifest) {
        A.mount(body, h('div.row', { style: { justifyContent: 'center', padding: '30px' } }, h('span.spinner')));
        try { state.manifest = await api('versions:manifest', false); } catch (e) { A.errorToast('获取版本列表失败', e); m.close(); return; }
      }
      const releases = state.manifest.versions.filter((x) => x.type === 'release');
      let mc = releases[0].id;
      const nameIn = h('input.input', { value: type === 'vanilla' ? `${mc} ${t('term.vanilla')}` : '' });
      let touched = false;
      nameIn.addEventListener('input', () => { touched = true; });
      const sel = A.select({
        options: [...releases, ...state.manifest.versions.filter((x) => x.type !== 'release')].map((x) => ({ value: x.id, label: x.id, sub: `${A.TYPE_NAMES[x.type] || x.type} · ${A.fmtDate(x.releaseTime)}` })),
        value: mc, searchable: true, block: true,
        onChange: (v) => { mc = v; if (!touched && type === 'vanilla') nameIn.value = `${v} ${t('term.vanilla')}`; },
      });
      A.mount(body,
        h('div.field', h('label', '游戏版本'), sel),
        type === 'vanilla' ? h('div.field', h('label', '配置名称'), nameIn, h('div.hint', '纯净版配置会使用独立的游戏目录，存档不会与其他配置混在一起'))
          : A.alert({ level: 'info', compact: true, text: type === 'vanillaplus' ? '下一步将选择需要的 QoL 功能、光影与优化，每一类都可以换成自己喜欢的 Mod' : '下一步将选择 Mod 加载器（Fabric / Forge / NeoForge / Quilt / Legacy Fabric）' }));
      m.setActions([
        { label: t('common.back'), kind: 'ghost', onClick: () => { renderTypes(); return false; } },
        {
          label: type === 'vanilla' ? '创建' : t('common.next'), kind: 'primary',
          onClick: async () => {
            const steps = { items: STEPS, current: 2 };
            if (type === 'custom') { setTimeout(() => A.installDialog(mc, { asProfile: true, requireLoader: true, steps }), 50); return true; }
            if (type === 'vanillaplus') { setTimeout(() => A.installDialog(mc, { asProfile: true, preset: 'vanillaplus', steps }), 50); return true; }
            const name = nameIn.value.trim() || mc;
            if (state.installed.some((x) => x.id === name)) { A.toast({ level: 'warn', text: '已存在同名配置' }); return false; }
            await api('versions:install', { mc, name, asProfile: true, profileType: 'vanilla' });
            A.toast({ level: 'info', title: '已开始安装', text: A.nm(name) });
            return true;
          },
        },
      ]);
    }
  }

  // ── 配置设置抽屉 ──
  async function openSettings(v, { focus } = {}) {
    const s = await api('versions:settings', v.id);
    const javas = state.javas || await A.refreshJavas();
    const req = await api('java:required', v.id).catch(() => null);
    const mem = await api('versions:memory', v.id).catch(() => ({ auto: 4096 }));
    const total = state.info.totalMem;
    const save = (patch) => api('versions:setSettings', v.id, patch).catch((e) => A.errorToast('保存失败', e));
    const javaNote = A.javaCheck.drawerNote(v.id);

    const javaOpts = [
      { value: 'global', label: '跟随全局设置', sub: state.config.java.selected === 'auto' ? '全局：自动选择' : `全局：${state.config.java.selected}` },
      { value: 'auto', label: '自动选择', sub: req ? `需要 Java ${req.req.major}${req.pick ? `，将使用 ${req.pick.version}` : '，未找到将自动下载'}` : '' },
      ...javas.map((j) => ({ value: j.path, label: `Java ${j.major}（${j.version}）`, sub: `${j.vendor} · ${j.arch} · ${j.path}` })),
    ];

    const memVal = h('div.mem-value');
    const memSlider = A.range({
      min: 512, max: Math.max(1024, Math.floor(total / 256) * 256), step: 256, value: s.memoryMax || mem.auto,
      disabled: s.memoryMode !== 'custom',
      onInput: (val) => { memVal.textContent = A.fmtMem(val); },
      onChange: (val) => save({ memoryMax: val }),
    });
    const setMemVal = (mode) => {
      memVal.textContent = mode === 'custom' ? A.fmtMem(Number(memSlider.value)) : mode === 'auto' ? `${A.fmtMem(mem.auto)}` : '全局';
    };
    setMemVal(s.memoryMode || 'global');

    const jvm = h('textarea.textarea', { placeholder: '留空则使用全局 JVM 参数', spellcheck: 'false', onchange: (e) => save({ jvmArgs: e.target.value.trim() }) }, s.jvmArgs || '');
    const game = h('textarea.textarea', { placeholder: '留空则使用全局游戏参数', spellcheck: 'false', onchange: (e) => save({ gameArgs: e.target.value.trim() }), style: { minHeight: '56px' } }, s.gameArgs || '');
    const server = s.server || { enabled: false, address: '' };
    const serverInput = h('input.input', { value: server.address || '', placeholder: 'mc.example.com:25565', disabled: !server.enabled, onchange: (e) => save({ server: { enabled: true, address: e.target.value.trim() } }) });
    const setMeta = (patch) => api('profiles:setMeta', v.id, patch).catch((e) => A.errorToast('保存失败', e));

    const folder = (label, ic, sub) => h('button.btn.sm', { onclick: () => openDir(v.id, sub) }, icon(ic, 14), label);
    const archiveEl = h('div');
    A.profileArchive(archiveEl, v);

    A.drawer({
      title: A.nm(A.displayName(v)),
      subtitle: A.versionSub(v),
      img: v.modpack && v.modpack.icon ? v.modpack.icon : A.versionIcon(v),
      width: 560,
      body: h('div',
        // 简洁模式（simplemode.js）：组件、隔离、游戏设置同步整块变灰
        h('div.drawer-section', { id: 'comp-sec', 'data-simple-off': '', 'data-net': '' }, h('h4', '组件'), A.components.section(v)),

        h('div.drawer-section', h('h4', '配置信息'),
          h('div.field', h('label', '显示名称'), h('input.input', { value: v.displayName || '', placeholder: A.nm(v.id), onchange: (e) => setMeta({ name: e.target.value.trim() || null }) })),
          h('div.field', h('label', '备注'), h('input.input', { value: v.description || '', placeholder: '例如：和朋友联机用', onchange: (e) => setMeta({ description: e.target.value.trim() }) })),
          h('div.field', { style: { marginBottom: 0 } }, h('label', '类型'), A.seg(Object.entries(A.PROFILE_TYPES).map(([k, t]) => ({ value: k, label: t.name })), v.profileType, (val) => setMeta({ type: val })))),

        h('div.drawer-section', { 'data-simple-off': '' }, h('h4', t('term.isolation')),
          h('div.row', A.iso.chip(v, () => { A.closeDrawers(); A.iso.editor(v); }), h('div.spacer'),
            h('button.btn.sm', { onclick: () => { A.closeDrawers(); A.iso.editor(v); } }, icon('shield', 14), '修改')),
          h('div.row', { style: { marginTop: '8px' } },
            h('button.btn.sm.ghost', { onclick: () => { A.closeDrawers(); A.iso.testNewVersion(v); } }, icon('flask', 14), t('term.testNewVersion')),
            v.loader ? h('button.btn.sm.ghost', { onclick: () => { A.closeDrawers(); A.iso.modUpdateCopy(v); } }, icon('flask', 14), t('term.modUpdateCopy')) : null)),

        A.simple.mark(A.gameSyncUi.drawerSection(v)),

        h('div.drawer-section', h('h4', 'Java'),
          A.select({ options: javaOpts, value: s.java || 'global', onChange: (val) => save({ java: val }).then(javaNote.refresh), block: true, searchable: true }),
          req ? h('div.faint', { style: { fontSize: '12px', margin: '8px 0' } }, `该版本需要 Java ${req.req.major}${req.req.component ? `（${req.req.component}）` : ''}`) : null,
          javaNote.el),

        h('div.drawer-section', h('h4', '内存分配'),
          h('div.row', A.seg([{ value: 'global', label: '跟随全局' }, { value: 'auto', label: '自动' }, { value: 'custom', label: '自定义' }], s.memoryMode || 'global', (mode) => {
            save({ memoryMode: mode, memoryMax: Number(memSlider.value) });
            memSlider.disabled = mode !== 'custom';
            setMemVal(mode);
          }), h('div.spacer'), memVal),
          h('div', { style: { marginTop: '10px' } }, memSlider),
          h('div.faint', { style: { fontSize: '12px' } }, `系统内存 ${A.fmtMem(total)}，自动分配为 ${A.fmtMem(mem.auto)}`)),

        h('div.drawer-section', h('h4', '自动进入服务器'),
          h('div.row', A.toggle(server.enabled, (en) => { serverInput.disabled = !en; save({ server: { enabled: en, address: serverInput.value.trim() } }); }), serverInput)),

        h('details.drawer-section.adv', h('summary', h('h4', '高级：JVM 与游戏参数')), h('div', { style: { marginTop: '10px' } }, jvm, h('div', { style: { height: '10px' } }), game)),

        h('div.drawer-section', h('h4', t('backup.title')),
          h('div.row', h('span.faint', { style: { fontSize: '12.5px', flex: 1 } }, t('backup.drawerDesc')),
            h('button.btn.sm', { onclick: () => A.savesManager(v) }, icon('save', 14), t('backup.drawerBtn')))),

        h('div.drawer-section', h('h4', '打开文件夹'),
          h('div.folder-grid',
            folder('游戏目录', 'folder'), folder('Mods', 'puzzle', 'mods'), folder('存档', 'globe', 'saves'),
            folder('资源包', 'image', 'resourcepacks'), folder('光影包', 'sun', 'shaderpacks'), folder('截图', 'monitor', 'screenshots'))),

        h('div.drawer-section', h('h4', t('term.archive')), archiveEl)),
      onClose: () => A.refreshInstalled(),
    });
    if (focus === 'components') setTimeout(() => { const el = document.getElementById('comp-sec'); if (el) el.scrollIntoView({ block: 'start' }); }, 80);
  }

  function init() {
    build();
    const refresh = A.pageRefresher('versions', render);
    on('installed', refresh);
    on('config', (c, changed) => { if (A.configMatters(changed)) refresh(); });
    on('javas', refresh);
    render();
  }

  A.pages.versions = { init, show: render, title: t('term.profile') };
  A.openVersionSettings = openSettings;
  A.newProfileDialog = newProfileDialog;
  A.removeProfile = remove;
  A.importModpackFile = importPack;
})();
