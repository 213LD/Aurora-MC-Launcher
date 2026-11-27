'use strict';
/* Mod 管理（本地 + 更新 + 方案 + 兼容性检查 + CurseForge 手动下载提醒）；下载页的资源浏览器在 resources.js */
(function () {
  const { h, icon, api, state, on, $, t } = A;

  // ═════════════════════ 本地 Mod 管理 ═════════════════════
  let root;
  let target = null;
  let data = { mods: [], presets: [], activePreset: null };
  let query = '';
  let updates = new Map(); // file → update
  let checkResult = null;
  let listEl;
  let summaryEl;
  let issuesEl;
  let manualEl;
  let verSelect;
  let sortSelect;
  let updateBtn;
  let allBtn;
  const identified = new Set();

  const moddedFirst = () => [...state.installed].sort((a, b) => (!!b.loader - !!a.loader) || (b.lastPlayed || 0) - (a.lastPlayed || 0));

  function pickDefaultTarget() {
    const cur = A.currentVersion();
    if (target && state.installed.some((v) => v.id === target)) return;
    target = cur && cur.loader ? cur.id : (moddedFirst()[0] || {}).id || null;
  }

  function versionOptions() {
    return moddedFirst().map((v) => ({ value: v.id, label: A.nm(A.displayName(v)), sub: v.loader ? A.versionSub(v) : `${A.versionSub(v)} · 未安装加载器`, img: A.versionIcon(v, 48) }));
  }

  const targetInfo = () => state.installed.find((v) => v.id === target);

  function build() {
    root = $('#page-mods');
    listEl = h('div.list');
    summaryEl = h('span.muted', { style: { fontSize: '13px' } });
    issuesEl = h('div');
    manualEl = h('div');
    updateBtn = h('button.btn.hidden', { onclick: updateAll, 'data-simple-off': '', 'data-net': '' }, icon('arrowDown', 16), '全部更新');
    allBtn = h('button.btn', { onclick: async () => { const v = targetInfo(); if (v) { await A.toggleAllMods(v); load(); } } });
    verSelect = A.select({ options: versionOptions(), value: target, placeholder: '选择配置', width: 280, searchable: true, onChange: (v) => { target = v; updates = new Map(); load(); } });
    A.mount(root, h('div.page-inner',
      h('div.page-head',
        h('div', h('h1', t('term.mods')), h('p', `启用、禁用、更新 Mod，保存${t('term.preset')}，或把 .jar 文件拖到这里安装`)),
        h('div.actions',
          h('button.btn.primary', { onclick: addOnline, 'data-simple-off': '', 'data-net': '' }, icon('globe', 16), t('mods.addOnline')),
          h('button.btn', { onclick: addFiles, 'data-simple-off': '' }, icon('plus', 16), '添加文件'),
          h('button.btn.icon', { 'data-tip': '打开 mods 文件夹', onclick: () => target && api('versions:dir', target, 'mods').then((p) => api('shell:open', p)) }, icon('folder', 16)))),
      h('div.toolbar',
        verSelect,
        h('div.input-wrap', icon('search', 16), h('input.input', { placeholder: '搜索 Mod…', oninput: A.debounce((e) => { query = e.target.value.trim().toLowerCase(); render(); }, 120) })),
        sortSelect = A.select({ options: A.modSort.options(), value: state.config.modSort || 'name', width: 130, onChange: (v) => { A.setConfig({ modSort: v }); render(v); } }),
        h('div.spacer'), summaryEl,
        allBtn,
        h('button.btn', { onclick: (e) => presetMenu(e.currentTarget) }, icon('layers', 16), t('term.preset')),
        h('button.btn', { onclick: checkUpdates, 'data-simple-off': '', 'data-net': '' }, icon('refresh', 16), '检查更新'),
        updateBtn),
      manualEl,
      issuesEl,
      listEl));
  }

  async function load() {
    pickDefaultTarget();
    verSelect.setOptions(versionOptions(), target);
    if (!target) { data = { mods: [], presets: [] }; render(); renderIssues(); return; }
    if (!data.mods.length) A.mount(listEl, [...Array(4)].map(() => h('div.skeleton', { style: { height: '68px' } })));
    const my = target;
    let next;
    try {
      next = await api('mods:list', target);
    } catch (e) {
      next = { mods: [], presets: [] };
      if (my === target) A.errorToast('读取 Mod 列表失败', e);
    }
    // 切换配置时慢的那次结果不能盖掉新的（1.10.8：以前先赋值再判断，下次筛选时显示的是另一个配置的 Mod，开关的也是它的文件）
    if (my !== target) return;
    data = next;
    render();
    // 简洁模式（1.7.0）：只管启用 / 禁用，不做冲突检查、不联网识别
    if (A.simple.on()) { checkResult = null; renderIssues(); return; }
    runCheck();
    // 后台在 Modrinth 上识别 Mod（每个配置每次会话一次）
    if (data.mods.length && !identified.has(target)) {
      identified.add(target);
      api('mods:identify', target).then((r) => { if (r.identified && my === target) api('mods:list', target).then((d) => { if (my === target) { data = d; render(); } }); }).catch(() => {});
    }
  }

  async function runCheck() {
    const v = targetInfo();
    if (!v) return;
    // 检查要一会儿：期间换了配置，这份结果是上一个配置的，不能画到新配置上
    const my = target;
    let r = null;
    try { r = await api('mods:check', my); } catch { r = null; }
    if (my !== target) return;
    checkResult = r;
    renderIssues();
  }

  function renderIssues() {
    A.clear(issuesEl);
    const v = targetInfo();
    if (!v || !checkResult || !data.mods.length || A.simple.on()) return;
    const issues = checkResult.issues;
    const lv = issues.some((i) => A.level(i.severity) === 'crit') ? 'crit' : issues.length ? 'warn' : 'ok';
    const box = h('div.check-box',
      A.alert({
        level: lv,
        title: issues.length ? `${t('term.check')}发现 ${issues.length} 个问题` : `${t('term.check')}：未发现问题`,
        text: issues.length ? '根据 Mod 的元数据分析前置、加载器、版本与冲突声明（不启动游戏）' : `${checkResult.count} 个已启用的 Mod 依赖完整、加载器匹配`,
        actions: [
          h('button.btn.sm.ghost', { onclick: runCheck }, icon('refresh', 14), '重新检查'),
          h('button.btn.sm', { onclick: () => A.debugDialog(targetInfo()) }, icon('wrench', 14), t('term.debug')),
        ],
      }),
      issues.length ? A.modkit.issueList(issues, { versionId: target, mc: v.mcVersion, onFixed: load }) : null);
    issuesEl.appendChild(box);
  }

  function render(sort = state.config.modSort) {
    if (!listEl) return;
    const v = targetInfo();
    const mods = data.mods || [];
    A.mount(manualEl, v && data.cfManual && data.cfManual.length ? A.cfManual.notice(v.id, data.cfManual) : null);
    if (!state.installed.length || !v) {
      A.mount(listEl, A.emptyState({ img: A.blockImage('fabric', 96), title: '还没有可用的配置', text: '先创建一个带有 Fabric / Forge / NeoForge / Quilt 的配置吧', action: h('button.btn.primary', { onclick: () => A.go('versions') }, `前往${t('term.profile')}`) }));
      summaryEl.textContent = '';
      return;
    }
    const enabled = mods.filter((m) => m.enabled).length;
    summaryEl.textContent = mods.length ? `共 ${mods.length} 个，已启用 ${enabled} 个${data.activePreset ? ` · ${t('term.preset')}：${data.activePreset}` : ''}` : '';
    A.mount(allBtn, ...(v.modsOff ? [icon('refresh', 16), t('term.restoreAll')] : [icon('x', 16), t('term.disableAll')]));
    allBtn.classList.toggle('hidden', !mods.length);
    allBtn.classList.toggle('warn-btn', !!v.modsOff);
    updateBtn.classList.toggle('hidden', !updates.size);
    if (updates.size) A.mount(updateBtn, icon('arrowDown', 16), `全部更新（${updates.size}）`);
    const shown = query ? mods.filter((m) => `${m.name} ${m.id || ''} ${m.file} ${m.description || ''}`.toLowerCase().includes(query)) : mods;
    if (!mods.length) {
      A.mount(listEl,
        !v.loader ? A.alert({
          level: 'warn', title: '该配置没有安装 Mod 加载器', text: 'Mod 需要 Fabric、Forge、NeoForge 或 Quilt 才能加载',
          actions: [h('button.btn.sm.primary', { onclick: () => A.installDialog(v.mcVersion, { asProfile: true, requireLoader: true }) }, '创建 Mod 配置')],
        }) : null,
        A.emptyState({ iconName: 'puzzle', title: '这里还没有 Mod', text: `从 Modrinth / CurseForge 在线添加、拖入 .jar 文件，或用「${t('term.planner')}」按玩法一键生成`, action: h('div.row', h('button.btn.primary', { onclick: addOnline, 'data-simple-off': '', 'data-net': '' }, icon('globe', 16), t('mods.addOnline')), h('button.btn', { onclick: () => A.go('planner', { fresh: true }) }, icon('sparkles', 16), t('term.planner'))) }));
      return;
    }
    if (!shown.length) { A.mount(listEl, A.emptyState({ iconName: 'search', title: '没有匹配的 Mod' })); return; }
    // 排序：按类型时分组并加小标题
    sortSelect.setValue(sort || 'name');
    const groups = A.modSort.apply(shown, sort);
    A.mount(listEl, groups.flatMap((g) => [
      g.type ? h('div.mod-group-head', { 'data-tip': g.type === 'library' ? t('modSort.libraryHint') : null }, A.modSort.typeLabel(g.type), h('span.faint', String(g.mods.length))) : null,
      ...g.mods.map(modRow),
    ]));
    fillZh(shown);
  }

  /** 已安装 Mod 的项目信息（给中文名用）：有来源记录用来源，没有就用 modid 当 Modrinth slug 试试 */
  function projOfMod(m) {
    const src = m.modrinth || m.curseforge;
    return src ? { source: src.source || 'modrinth', slug: src.slug, title: src.title || m.name } : { source: 'modrinth', slug: m.id || '', title: m.name };
  }

  /** 中文名：本地对照表 → MC 百科缓存（开关关着也读，有就用百科的译名，1.6.1）→ 打开了 MC 百科时对照表没有的按需查（排队，慢慢补上） */
  let zhSeq = 0;
  function fillZh(list) {
    const my = ++zhSeq;
    A.mcmodUi.fillZh(listEl, list.map(projOfMod), { lookup: !A.simple.on() && !A.offline.on(), lookupMax: 200, alive: () => my === zhSeq });
  }

  /** 链接到 Mod 的来源页面（Modrinth 或 CurseForge） */
  function sourceLink(m) {
    const url = m.modrinth && m.modrinth.slug ? `https://modrinth.com/mod/${m.modrinth.slug}` : m.curseforge && m.curseforge.url;
    if (!url) return null;
    return h('button.btn.sm.icon.ghost', { 'data-tip': t('res.viewOn', { source: m.modrinth ? 'Modrinth' : 'CurseForge' }), onclick: () => api('shell:external', url), 'data-simple-off': '' }, icon('external', 16));
  }

  function modRow(m) {
    const up = updates.get(m.file);
    const loaderBadge = m.loader ? h('span', { class: `badge ${m.loader}` }, (A.LOADERS[m.loader] || {}).name || m.loader) : null;
    return h('div', { class: `list-row ${m.enabled ? '' : 'disabled-mod'}` },
      h('div.ico.boxed', m.icon ? h('img', { src: m.icon, alt: '', style: { imageRendering: 'auto' } }) : h('span.faint', icon('puzzle', 22, 1.6))),
      h('div.body',
        h('div.title', h('b.mn-zh', { 'data-key': A.mcmodUi.keyOf(projOfMod(m)) }, A.modNames.zhOf(projOfMod(m)) ? `${A.modNames.zhOf(projOfMod(m))} ` : ''), h('span', A.nm(m.name)), m.version ? h('span.faint', { style: { fontWeight: 400, fontSize: '12.5px' } }, A.nm(m.version)) : null, loaderBadge,
          up ? h('span.badge.info', { 'data-tip': `${up.current} → ${up.latest.number}` }, icon('arrowDown', 12), `可更新 ${up.latest.number}`) : null),
        h('div.sub', { title: A.nm(m.description) || A.nm(m.file) }, m.description ? A.nm(m.description.split('\n')[0]) : A.nm(m.file)),
        m.description ? h('div.sub.faint', { style: { fontSize: '11.5px' } }, `${A.nm(m.file)} · ${A.fmtBytes(m.size)}${m.authors && m.authors.length ? ` · ${m.authors.slice(0, 3).join(', ')}` : ''}`) : null),
      h('div.actions',
        up && !A.simple.on() ? h('button.btn.sm', { 'data-net': '', onclick: (e) => { e.currentTarget.disabled = true; doUpdate([up]); } }, '更新') : null,
        sourceLink(m),
        h('span', { 'data-tip': m.enabled ? '点击禁用' : '点击启用' }, A.toggle(m.enabled, async (en) => {
          try { await api('mods:toggle', m.path, en); load(); } catch (e) { A.errorToast('操作失败', e); load(); }
        })),
        h('button.btn.sm.icon.ghost', { 'data-tip': '在文件夹中显示', onclick: () => api('shell:showItem', m.path) }, icon('folder', 16)),
        h('button.btn.sm.icon.ghost', { 'data-tip': t('common.delete'), onclick: () => removeMod(m) }, icon('trash', 16))));
  }

  /** 删除 Mod：进回收站，一次确认；回收站不可用时再确认一次才永久删除 */
  async function removeMod(m, permanent = false) {
    if (!permanent && !(await A.dangerConfirm({ level: 2, title: '删除 Mod', text: `确定要删除「${A.nm(m.name)}」吗？`, items: [{ icon: 'file', label: A.nm(m.file), sub: A.fmtBytes(m.size) }], note: t('danger.trashNote'), noteLevel: 'info' }))) return;
    try {
      await api('mods:remove', m.path, target, { permanent });
      load();
    } catch (e) {
      if (!permanent && e.reason && e.reason.code === 'TRASH_UNAVAILABLE') {
        if (await A.dangerConfirm({ level: 3, title: t('trash.unavailableTitle'), text: t('trash.unavailable', { name: A.nm(m.file) }), note: t('danger.permanentNote'), noteLevel: 'crit', okText: t('trash.permanentDelete') })) removeMod(m, true);
        return;
      }
      A.errorToast(t('profile.deleteFailed'), e);
    }
  }

  async function checkUpdates() {
    if (!target) return;
    A.toast({ level: 'info', text: t('mods.checkingUpdates'), duration: 2500 });
    const my = target;
    try {
      const list = await api('mods:checkUpdates', my);
      if (my !== target) return; // 查的时候换了配置：结果是上一个配置的
      updates = new Map(list.map((u) => [u.file, u]));
      render();
      A.toast({ level: list.length ? 'info' : 'ok', text: list.length ? `有 ${list.length} 个 Mod 可以更新` : '所有 Mod 都是最新版本' });
    } catch (e) { A.errorToast('检查更新失败', e); }
  }

  async function doUpdate(list) {
    try {
      await api('mods:update', target, list.map((u) => ({ path: u.path, name: u.name, latest: u.latest, enabled: u.enabled })));
      for (const u of list) updates.delete(u.file);
      render();
    } catch (e) { A.errorToast('更新失败', e); render(); } // 重画一遍：点「更新」时置灰的按钮放开，可以再点
  }
  const updateAll = () => doUpdate([...updates.values()]);

  function presetMenu(anchor) {
    if (!target) return;
    const presets = data.presets || [];
    A.menu(anchor, [
      { head: `${t('term.preset')}：保存一组启用的 Mod，随时切换` },
      ...presets.map((p) => ({
        label: A.nm(p.name), sub: `${p.enabled.length} 个 Mod`, icon: 'layers', on: p.name === data.activePreset,
        onClick: async () => {
          try {
            const r = await api('mods:presetApply', target, p.name);
            A.toast({ level: 'ok', text: `已切换到${t('term.preset')}「${A.nm(p.name)}」${r.missing.length ? `（${r.missing.length} 个文件已不存在）` : ''}` });
            load();
          } catch (e) { A.errorToast('切换失败', e); }
        },
      })),
      presets.length ? '-' : null,
      {
        label: `把当前启用状态保存为${t('term.preset')}…`, icon: 'save', onClick: async () => {
          const name = await A.prompt(`保存${t('term.preset')}`, { value: data.activePreset || '', placeholder: '例如：轻量生存、全部开启', label: '名称', hint: '同名的会被覆盖' });
          if (!name) return;
          try { await api('mods:presetSave', target, name); A.toast({ level: 'ok', text: `已保存${t('term.preset')}「${A.nm(name)}」` }); load(); } catch (e) { A.errorToast('保存失败', e); }
        },
      },
      presets.length ? {
        label: `删除${t('term.preset')}…`, icon: 'trash', danger: true, onClick: () => {
          A.menu(anchor, presets.map((p) => ({ label: A.nm(p.name), icon: 'trash', danger: true, onClick: async () => { await api('mods:presetDelete', target, p.name); load(); } })));
        },
      } : null,
    ], { align: 'right' });
  }

  function addOnline() {
    const v = targetInfo();
    if (!v) return A.toast({ level: 'warn', text: '请先选择一个配置' });
    if (!v.loader) return A.toast({ level: 'warn', text: '该配置没有安装 Mod 加载器' });
    const have = (key) => new Set((data.mods || []).map((m) => m[key] && String(m[key].projectId)).filter(Boolean));
    A.modkit.modrinthPicker({ mc: v.mcVersion, loader: v.loader.type, versionId: v.id, mode: 'install', title: t('mods.addTitle', { name: A.nm(A.displayName(v)) }), exclude: have('modrinth'), excludeCf: have('curseforge') });
  }

  async function addFiles() {
    if (!target) return A.toast({ level: 'warn', text: '请先选择一个配置' });
    const files = await api('dialog:file', '选择 Mod 文件', [{ name: 'Mod 文件', extensions: ['jar', 'zip'] }], true);
    if (!files || !files.length) return;
    await importFiles(files);
  }

  async function importFiles(paths) {
    if (!target) return A.toast({ level: 'warn', text: '请先选择一个配置' });
    const jars = paths.filter((p) => /\.(jar|zip)$/i.test(p));
    if (!jars.length) return A.toast({ level: 'warn', text: '只支持 .jar / .zip 格式的 Mod 文件' });
    try {
      const n = await api('mods:add', target, jars, 'mod');
      A.toast({ level: 'ok', text: `已添加 ${n} 个文件到 ${target}` });
      identified.delete(target);
      load();
    } catch (e) { A.errorToast('添加失败', e); }
  }

  function setupDrop() {
    const overlay = $('#dropOverlay');
    overlay.appendChild(h('div.drop-box', icon('import', 42), '松开以安装到当前配置', h('span.muted', { style: { fontSize: '13px', fontWeight: 400 } }, '支持 .jar / .zip')));
    let depth = 0;
    const active = () => state.page === 'mods' && !A.simple.on(); // 简洁模式不能拖文件进来装
    window.addEventListener('dragenter', (e) => { if (!active() || !e.dataTransfer.types.includes('Files')) return; depth++; overlay.classList.add('show'); });
    window.addEventListener('dragleave', () => { if (!active()) return; depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('show'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      if (!active()) return;
      const paths = [...e.dataTransfer.files].map((f) => window.aurora.pathForFile(f)).filter(Boolean);
      if (paths.length) importFiles(paths);
    });
  }

  function init() {
    pickDefaultTarget();
    build();
    setupDrop();
    on('installed', () => { pickDefaultTarget(); if (verSelect) verSelect.setOptions(versionOptions(), target); });
    A.listen('mods:changed', (id) => { if (id === target && state.page === 'mods') load(); });
  }

  A.pages.mods = {
    init,
    show: (p) => { if (p && p.versionId) { target = p.versionId; updates = new Map(); } load(); },
    title: t('term.mods'),
  };

  A.modTargets = { moddedFirst, options: versionOptions };
})();
