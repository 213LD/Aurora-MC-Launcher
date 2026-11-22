'use strict';
/* Mod 配置器：导入导出清单 */
(function () {
  const { h, icon, api, state } = A;
  const K = A.plannerKit;
  const { LOADER_INFO, P, newPlan } = K;

  // 列表里写的中文名 / 缩写先按启动器自带的对照表换成英文名再识别（一次导入很多行，不去 MC 百科逐个查）
  const zhLines = (text) => text.split(/\r?\n/).map((line) => {
    const ex = A.modNames.expand(line);
    return ex.matches && ex.matches.length && ex.original ? ex.matches[0].en : line;
  }).join('\n');

  /** 导出成 Aurora Mod 清单（带格式版本、启动器版本和校验值，见 envelope.js） */
  async function exportList(plan = P.plan) {
    if (!plan || !(plan.items || []).some((i) => i.selected)) return A.toast({ level: 'info', text: '清单里还没有勾选的 Mod，没有可导出的内容' });
    try {
      const r = await api('planner:exportList', { name: plan.name, mc: plan.mc, loader: plan.loader, styles: plan.styles, items: plan.items.map(K.minimal) });
      if (!r.count) return A.toast({ level: 'info', text: '勾选的都是本地文件，本地文件只在这台电脑上有，不能导出到清单' });
      const safe = A.safeName(plan.name, { max: 60, fallback: 'Mod 清单' });
      const f = await api('dialog:save', '导出 Mod 清单', `${safe}.json`, r.text);
      if (f) A.toast({ level: 'ok', title: '已导出 Mod 清单', text: `${r.count} 个 Mod${r.skippedLocal ? `；${r.skippedLocal} 个本地文件只在这台电脑上有，没有导出` : ''}。在别的电脑上用「导入 → 清单文件」打开` });
    } catch (e) { A.errorToast('导出失败', e); }
  }

  function importDialog() {
    let tab = 'text';
    let preview = null; // { items, mc, loader, name }
    const content = h('div');
    const tabs = h('div.tabs', { style: { marginBottom: '14px' } });
    let addBtn;
    const renderTabs = () => A.mount(tabs, [['text', '粘贴列表', 'file'], ['list', '清单文件', 'save'], ['folder', 'Mod 文件夹', 'folder'], ['mrpack', '整合包文件', 'box'], ['profile', '已有配置', 'layers']]
      .map(([id, label, ic]) => h('button', { class: `tab ${tab === id ? 'on' : ''}`, onclick: () => { tab = id; preview = null; renderTabs(); renderBody(); } }, icon(ic, 16), label)));

    const loading = (text) => A.mount(content, h('div.row', { style: { justifyContent: 'center', padding: '30px', gap: '10px' } }, h('span.spinner'), h('span.muted', text)));
    const run = async (fn, text) => {
      loading(text);
      try { preview = await fn(); renderPreview(); } catch (e) { A.errorToast('导入失败', e); renderBody(); }
    };

    function renderBody() {
      if (addBtn) addBtn.disabled = true;
      if (tab === 'text') {
        const ta = h('textarea.textarea', { style: { minHeight: '180px' }, placeholder: '每行一个，支持：\nSodium\nhttps://modrinth.com/mod/lithium\nxaeros-minimap\njei-1.20.1-forge-15.2.0.27.jar\n\n也可以粘贴从其他启动器导出的 Mod 列表', spellcheck: 'false' });
        A.mount(content, ta, h('div.row', { style: { marginTop: '10px' } }, h('span.faint', { style: { fontSize: '12px' } }, '支持 Mod 名称、Modrinth / CurseForge 链接、slug 与 jar 文件名'), h('div.spacer'),
          h('button.btn.primary', { onclick: () => { if (ta.value.trim()) run(() => api('planner:importText', zhLines(ta.value), { mc: P.plan.mc, loader: P.plan.loader }), '正在 Modrinth 上识别…'); } }, '识别')));
      } else if (tab === 'list') {
        A.mount(content, h('div.import-pick', icon('save', 34, 1.5), h('div', '选择用「导出清单」保存的 Aurora Mod 清单（.json）'),
          h('div.faint', { style: { fontSize: '12px' } }, '会先检查文件是哪个版本的启动器导出的、内容有没有损坏或被改动过'),
          h('button.btn.primary', { onclick: async () => { const f = await api('dialog:file', '选择 Mod 清单', [{ name: 'Aurora Mod 清单', extensions: ['json'] }]); if (f) run(() => api('planner:importList', f), '正在检查文件并识别…'); } }, '选择文件')));
      } else if (tab === 'folder') {
        A.mount(content, h('div.import-pick', icon('folder', 34, 1.5), h('div', '选择一个包含 .jar 的文件夹（例如其他启动器的 mods 文件夹）'), h('div.faint', { style: { fontSize: '12px' } }, '通过文件哈希在 Modrinth 上精确识别，识别不了的文件会作为本地文件一起安装'),
          h('button.btn.primary', { onclick: async () => { const d = await api('dialog:folder', '选择 mods 文件夹'); if (d) run(() => api('planner:importFolder', d), '正在计算哈希并识别…'); } }, '选择文件夹')));
      } else if (tab === 'mrpack') {
        A.mount(content, h('div.import-pick', icon('box', 34, 1.5), h('div', '选择一个 Modrinth 整合包（.mrpack）'), h('div.faint', { style: { fontSize: '12px' } }, '会读取其中的 Mod 列表作为方案的基础，你可以再自由增删、换版本'),
          h('button.btn.primary', { onclick: async () => { const f = await api('dialog:file', '选择整合包', [{ name: 'Modrinth 整合包', extensions: ['mrpack'] }]); if (f) run(() => api('planner:importMrpack', f), '正在读取整合包…'); } }, '选择文件')));
      } else {
        const list = state.installed.filter((v) => v.loader);
        A.mount(content, list.length ? h('div.field', h('label', '选择配置'), A.select({ options: list.map((v) => ({ value: v.id, label: A.nm(A.displayName(v)), sub: `${A.versionSub(v)} · ${v.mods.enabled} 个 Mod` })), value: null, placeholder: '选择…', block: true, onChange: (id) => run(() => api('planner:importProfile', id), '正在识别 Mod…') }))
          : h('div.faint', '没有安装了 Mod 加载器的配置'));
      }
    }

    // 清单文件的检查结果（主进程 envelope.js）：block 不能导入；risk 要打开「仍然导入」才能添加；warn 只提醒
    function checkView() {
      const probs = preview.problems || [];
      const risks = probs.filter((x) => x.level === 'risk');
      const meta = preview.meta;
      preview.accept = risks.length ? A.toggle(false, () => { if (addBtn) addBtn.disabled = !preview.accept.get() || !preview.items.some((i) => i.projectId); }) : null;
      return h('div', { style: { display: 'grid', gap: '8px', marginBottom: '12px' } },
        meta ? h('div.faint', { style: { fontSize: '12px' } }, `由 ${A.BRAND.short} ${meta.app || '未知版本'} 导出${meta.exportedAt && !Number.isNaN(Date.parse(meta.exportedAt)) ? ` · ${new Date(meta.exportedAt).toLocaleString()}` : ''}`) : null,
        ...probs.filter((x) => x.level === 'warn').map((x) => A.alert({ level: 'warn', compact: true, text: x.text })),
        risks.length ? A.alert({ level: 'crit', title: '文件可能被改动过或已经损坏',
          text: h('div', risks.map((x) => h('div', `· ${x.text}`)), h('div', { style: { marginTop: '6px' } }, '继续导入可能得到和原来不一样的 Mod，后果由你自己承担。')) })
          : A.alert({ level: 'ok', compact: true, text: '文件检查通过：格式正确，导出之后内容没有被改动' }),
        preview.accept ? h('label.row', { style: { cursor: 'pointer', fontSize: '13px', padding: '10px 12px', borderRadius: '10px', background: 'var(--surface-2)' } }, preview.accept, '我了解风险，仍然导入') : null);
    }

    function renderPreview() {
      if (preview.ok === false) {
        A.mount(content,
          A.alert({ level: 'crit', title: '这个文件不能导入', text: h('div', (preview.problems || []).map((x) => h('div', x.text))) }),
          h('div.row', { style: { marginTop: '12px' } }, h('div.spacer'), h('button.btn', { onclick: () => { preview = null; renderBody(); } }, '换一个文件')));
        if (addBtn) addBtn.disabled = true;
        return;
      }
      const items = preview.items;
      const found = items.filter((i) => i.projectId || i.local);
      const applyVer = preview.mc && (preview.mc !== P.plan.mc || (preview.loader && preview.loader !== P.plan.loader));
      const verToggle = applyVer ? A.toggle(true) : null;
      preview.verToggle = verToggle;
      A.mount(content,
        preview.fromList ? checkView() : null,
        h('div.row', { style: { marginBottom: '10px' } }, h('b', `识别到 ${found.length} / ${items.length} 个`), h('div.spacer'),
          items.some((i) => !i.projectId && !i.local) ? h('span.badge.crit', `${items.filter((i) => !i.projectId && !i.local).length} 个未找到`) : null),
        verToggle ? h('label.row', { style: { cursor: 'pointer', fontSize: '13px', marginBottom: '10px', padding: '10px 12px', borderRadius: '10px', background: 'var(--surface-2)' } }, verToggle,
          `同时把${A.t('term.plan')}切换为 Minecraft ${preview.mc}${preview.loader ? ` · ${(A.LOADERS[preview.loader] || {}).name || preview.loader}` : ''}（来源的版本）`) : null,
        h('div.import-list', items.map((i) => h('div.imp-row',
          h('img', { src: i.icon || A.blockImage(i.local ? 'unknown' : 'fabric', 48) }),
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div.ellipsis', h('b', A.nm(i.title))), i.input && i.input !== i.title ? h('div.faint.ellipsis', { style: { fontSize: '11.5px' } }, A.nm(i.input)) : null),
          i.local ? h('span.badge.warn', '本地文件') : i.projectId ? h('span', { class: `badge ${i.matched === 'search' ? 'warn' : 'ok'}` }, i.matched === 'search' ? '模糊匹配' : i.matched === 'hash' ? '哈希识别' : '已识别') : h('span.badge.crit', '未找到')))),
        preview.bundled && preview.bundled.length ? h('div.faint', { style: { fontSize: '12px', marginTop: '8px' } }, `整合包内还有 ${preview.bundled.length} 个直接打包的 Mod，无法导入到清单`) : null);
      if (addBtn) addBtn.disabled = !found.length || !!(preview.accept && !preview.accept.get());
    }

    renderTabs();
    renderBody();
    A.modal({
      title: '导入 Mod 列表',
      subtitle: `把你已有的 Mod 列表导入${A.t('term.plan')}，配置器会为当前版本重新挑选合适的文件`,
      icon: 'import',
      size: 'lg',
      body: h('div', tabs, content),
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: `添加到${A.t('term.plan')}`, kind: 'primary', ref: (b) => { addBtn = b; b.disabled = true; },
          onClick: () => {
            if (!preview || preview.ok === false || (preview.accept && !preview.accept.get())) return false;
            mergeImport(preview, preview.verToggle ? preview.verToggle.get() : false);
            return true;
          },
        },
      ],
    });
  }

  function mergeImport(preview, applyVersion) {
    if (!P.plan) P.plan = newPlan();
    const p = P.plan;
    if (p.troubleshootOnly) { P.plan = newPlan(); }
    const plan = P.plan;
    if (applyVersion && preview.mc) {
      plan.mc = preview.mc;
      if (preview.loader && LOADER_INFO[preview.loader]) plan.loader = preview.loader;
    }
    if (!plan.name && preview.name) plan.name = preview.fromList ? preview.name : `${preview.name} 定制版`;
    const have = new Set(plan.items.map((i) => i.projectId).filter(Boolean));
    let n = 0;
    for (const it of preview.items) {
      if (!it.projectId && !it.local) continue;
      if (it.projectId && have.has(it.projectId)) continue;
      // 清单文件保留原来的玩法分组和指定版本
      plan.items.push({ ...it, style: preview.fromList ? it.style || 'import' : 'import', source: it.local ? 'local' : 'import', selected: true });
      if (it.projectId) have.add(it.projectId);
      n++;
    }
    P.resolved = null;
    A.toast({ level: 'ok', text: `已添加 ${n} 个 Mod 到${A.t('term.plan')}` });
    K.goStep(2);
  }

  async function fromModpack(project) {
    K.startNew();
    A.mount(K.body, h('div.pl-loading', h('span.spinner.lg'), h('div', `正在读取整合包「${A.nm(project.title)}」…`)));
    try {
      const r = await api('planner:importModrinthPack', project.id);
      P.plan.name = `${project.title} 定制版`;
      mergeImport({ ...r, name: project.title }, true);
    } catch (e) {
      A.errorToast('读取整合包失败', e);
      K.goStep(1);
    }
  }

  Object.assign(K, { exportList, fromModpack, importDialog });
})();
