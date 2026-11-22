'use strict';
/* 皮肤中心：以皮肤库为中心——批量导入（多选 / 文件夹 / 拖入）、网格预览、改名、搜索、分组、
 * 模型切换、分配给离线账户（同时选生效方式）。账户卡片上的「皮肤」抽屉保留，两边共用同一个皮肤库 */
(function () {
  const { h, icon, api, state, $ } = A;

  const METHODS = [
    { value: 'auto', label: '自动（推荐）' },
    { value: 'service', label: '只用本地皮肤服务' },
    { value: 'csl', label: '只用 CustomSkinLoader' },
    { value: 'none', label: '不在游戏里使用' },
  ];
  const MODEL = [{ value: 'classic', label: '经典（Steve）' }, { value: 'slim', label: '纤细（Alex）' }];
  const ALL = '\u0000all';
  const NONE = '\u0000none';

  let root;
  const st = { items: null, groups: [], group: ALL, query: '', sel: null, walk: true, layer: true, busy: false };
  let gridEl; let sideEl; let groupsEl; let countEl;
  const big = () => st.bigView || (st.bigView = A.skinView({ size: 230 }));

  // ───────── 数据 ─────────
  async function load() {
    try { Object.assign(st, await api('skins:libraryAll')); } catch (e) { st.items = []; A.errorToast('读取皮肤库失败', e); }
    if (st.group !== ALL && st.group !== NONE && !st.groups.includes(st.group)) st.group = ALL;
    if (st.sel && !st.items.some((x) => x.hash === st.sel)) st.sel = null;
    renderAll();
  }
  const apply = (r) => { Object.assign(st, r); renderAll(); };
  const selItem = () => (st.items || []).find((x) => x.hash === st.sel) || null;

  function visible() {
    const q = st.query.toLowerCase();
    return (st.items || []).filter((it) => (st.group === ALL || (st.group === NONE ? !it.group : it.group === st.group))
      && (!q || String(it.name).toLowerCase().includes(q)));
  }

  // ───────── 导入 ─────────
  /** files: [{ name, b64 }]，逐张整理（旧版转换、识别模型）后存进库；放进当前选中的分组 */
  async function importMany(files) {
    if (!files.length) { A.toast({ level: 'warn', text: '没有找到可用的皮肤图片（需要 64×64 或 64×32 的 PNG）' }); return; }
    const before = new Set((st.items || []).map((x) => x.hash));
    const group = st.group !== ALL && st.group !== NONE ? st.group : undefined;
    let bad = 0; let last = null;
    if (files.length > 5) A.mount(gridEl, h('div.row', { style: { padding: '30px', justifyContent: 'center' } }, h('span.spinner'), h('span.muted', `正在导入 ${files.length} 张皮肤…`)));
    for (const f of files) {
      try {
        const n = await A.skinTools.normalize(f.b64);
        const items = await api('skins:libraryAdd', { png: n.png, model: n.model, name: f.name, group, keep: true });
        last = items[0] && items[0].hash;
      } catch { bad++; }
    }
    await load();
    const added = (st.items || []).filter((x) => !before.has(x.hash)).length;
    const dup = files.length - bad - added;
    if (last) { st.sel = last; renderAll(); }
    A.toast({ level: bad && !added ? 'warn' : 'ok', text: [`导入了 ${added} 张`, dup > 0 ? `${dup} 张已经在库里` : '', bad ? `${bad} 张不是有效的皮肤` : ''].filter(Boolean).join('，') });
  }

  function pickFiles() {
    const input = h('input', { type: 'file', accept: '.png,image/png', multiple: true, style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const list = [...input.files];
      input.remove();
      const files = [];
      for (const f of list) { try { files.push({ name: f.name.replace(/\.png$/i, ''), b64: await A.skinTools.readFile(f) }); } catch { /* 跳过 */ } }
      importMany(files);
    });
    document.body.append(input);
    input.click();
  }

  async function pickFolder() {
    const dir = await api('dialog:folder', '选择放皮肤图片的文件夹');
    if (!dir) return;
    try {
      const found = await api('skins:scanFolder', dir);
      importMany(found.map((x) => ({ name: x.name, b64: x.png })));
    } catch (e) { A.errorToast('读取文件夹失败', e); }
  }

  /** 拖进来的文件和文件夹（文件夹会往里找，最多 200 张） */
  async function fromDrop(dt) {
    const out = [];
    const readEntry = (entry, depth) => new Promise((resolve) => {
      if (out.length >= 200 || depth > 4) { resolve(); return; }
      if (entry.isFile) {
        if (!/\.png$/i.test(entry.name)) { resolve(); return; }
        entry.file(async (f) => { try { out.push({ name: f.name.replace(/\.png$/i, ''), b64: await A.skinTools.readFile(f) }); } catch { /* 跳过 */ } resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const next = () => reader.readEntries(async (ents) => {
          if (!ents.length) { for (const e of all) await readEntry(e, depth + 1); resolve(); return; }
          all.push(...ents); next();
        }, () => resolve());
        next();
      } else resolve();
    });
    const entries = [...(dt.items || [])].map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    // 有的来源（从浏览器、聊天软件里拖出来的图片）拿不到文件系统条目，只有 files（1.5.7）
    const files = entries.length ? [] : [...(dt.files || [])];
    for (const e of entries) await readEntry(e, 0);
    for (const f of files) { try { out.push({ name: f.name.replace(/\.png$/i, ''), b64: await A.skinTools.readFile(f) }); } catch { /* 跳过 */ } }
    importMany(out);
  }

  // ───────── 分组 ─────────
  async function addGroup() {
    const name = await A.prompt('新建分组', { placeholder: '例如 日常、节日、整活', validate: (v) => (v.trim() ? '' : '请填写分组名') });
    if (!name) return;
    try { apply(await api('skins:libraryGroup', { op: 'add', name })); st.group = A.cutChars(name.trim(), 40); renderAll(); } catch (e) { A.errorToast('新建分组失败', e); }
  }

  function groupMenu(anchor, g) {
    A.menu(anchor, [
      { label: '重命名分组', icon: 'edit', onClick: async () => {
        const to = await A.prompt('重命名分组', { value: g, validate: (v) => (v.trim() ? '' : '请填写分组名') });
        if (!to || to.trim() === g) return;
        try { apply(await api('skins:libraryGroup', { op: 'rename', name: g, to })); if (st.group === g) { st.group = A.cutChars(to.trim(), 40); renderAll(); } } catch (e) { A.errorToast('重命名失败', e); }
      } },
      { label: '删除分组', icon: 'trash', sub: '只删分组，里面的皮肤会变成「未分组」', onClick: async () => {
        if (!(await A.confirm(`删除分组「${A.nm(g)}」？里面的皮肤不会被删除，会移到「未分组」。`, { title: '删除分组', okText: '删除分组' }))) return;
        try { apply(await api('skins:libraryGroup', { op: 'remove', name: g })); } catch (e) { A.errorToast('删除失败', e); }
      } },
    ]);
  }

  // ───────── 单张皮肤 ─────────
  async function update(patch) {
    const it = selItem();
    if (!it) return;
    try { apply(await api('skins:libraryUpdate', it.hash, patch)); } catch (e) { A.errorToast('保存失败', e); }
  }

  async function rename() {
    const it = selItem();
    if (!it) return;
    const name = await A.prompt('重命名皮肤', { value: it.name, validate: (v) => (v.trim() ? '' : '请填写名字') });
    if (name && name.trim() !== it.name) update({ name });
  }

  async function remove() {
    const it = selItem();
    if (!it) return;
    if (!(await A.confirm(`从皮肤库删除「${A.nm(it.name)}」？已经用着这张皮肤的账户不受影响。`, { title: '删除皮肤', okText: '删除', danger: true }))) return;
    try { await api('skins:libraryRemove', it.hash); st.sel = null; await load(); } catch (e) { A.errorToast('删除失败', e); }
  }

  /** 分配给离线账户：选账户 + 生效方式（默认显示这个账户现在的方式） */
  function assign() {
    const it = selItem();
    if (!it) return;
    const accs = state.accounts.accounts || [];
    const offline = accs.filter((a) => a.type === 'offline');
    if (!offline.length) {
      A.modal({ title: '还没有离线账户', icon: 'user', size: 'sm', body: h('p', { style: { marginTop: 0 } }, '皮肤只能分配给离线账户。先去「账户」页创建一个离线账户吧。'),
        actions: [{ label: '关闭', kind: 'ghost' }, { label: '去创建', kind: 'primary', onClick: () => A.go('accounts', { add: true }) }] });
      return;
    }
    let accId = (offline.find((a) => a.id === state.accounts.selected) || offline[0]).id;
    let method = null;
    const listEl = h('div.skc-accs');
    const methodWrap = h('div');
    const curMethod = () => (offline.find((a) => a.id === accId) || {}).skinMethod || 'auto';
    function draw() {
      A.mount(listEl, offline.map((a) => h('label', { class: `skc-acc ${a.id === accId ? 'on' : ''}` },
        h('input', { type: 'radio', name: 'skc-acc', checked: a.id === accId, onchange: () => { accId = a.id; method = null; draw(); } }),
        A.avatar(a, 28),
        h('div', h('b', A.nm(a.name)), h('div.faint', a.skin && a.skin.custom ? '现在用的是自定义皮肤' : '现在用的是默认皮肤')))),
        accs.some((a) => a.type !== 'offline') ? h('div.hint', '微软正版账户的皮肤在 Mojang 那边管理，不能在这里分配') : null);
      A.mount(methodWrap, h('div.field', h('label', '在游戏里怎么生效'),
        A.select({ options: METHODS, value: method || curMethod(), width: 300, onChange: (v) => { method = v; } }),
        h('div.hint', '默认是这个账户现在的设置；以后也可以在账户卡片的「皮肤」里改')));
    }
    draw();
    A.modal({
      title: `把「${A.nm(it.name)}」分配给账户`, icon: 'user', size: 'sm',
      body: h('div', listEl, methodWrap),
      actions: [
        { label: '取消', kind: 'ghost' },
        { label: '分配', kind: 'primary', errorTitle: '分配失败', onClick: async () => {
          const png = await api('skins:libraryRead', it.hash);
          await api('skins:set', accId, { skin: png, model: it.model, method: method || curMethod() });
          await A.refreshAccounts();
          A.toast({ level: 'ok', text: `已把「${A.nm(it.name)}」分配给 ${A.nm((offline.find((a) => a.id === accId) || {}).name)}` });
          return true;
        } },
      ],
    });
  }

  // ───────── 界面 ─────────
  function tile(it) {
    const mini = A.skinView({ url: it.url, model: it.model, size: 104 });
    mini.set({ walk: false });
    mini.el.classList.add('sk-mini');
    return h('div', { class: `sk-tile skc-tile ${it.hash === st.sel ? 'on' : ''}`, 'data-hash': it.hash, tabindex: 0, role: 'button', 'aria-label': A.nm(it.name),
      onclick: () => select(it.hash), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(it.hash); } } },
    mini.el,
    h('div.skc-name', A.noTr(it.name)),
    h('div.skc-meta', it.model === 'slim' ? '纤细' : '经典', it.group && st.group === ALL ? ` · ${A.nm(it.group)}` : ''));
  }

  function select(hash) {
    st.sel = hash;
    gridEl.querySelectorAll('.skc-tile').forEach((el) => el.classList.toggle('on', el.dataset.hash === hash));
    renderSide();
  }

  function renderGroups() {
    const chip = (value, label, n, menu) => h('button', { class: `skc-chip ${st.group === value ? 'on' : ''}`, onclick: () => { st.group = value; renderAll(); },
      oncontextmenu: menu ? (e) => { e.preventDefault(); groupMenu(e.currentTarget, value); } : null },
    label, h('span.faint', ` ${n}`),
    menu ? h('span.skc-chip-more', { role: 'button', 'aria-label': `管理分组 ${label}`, onclick: (e) => { e.stopPropagation(); groupMenu(e.currentTarget, value); } }, icon('more', 13)) : null);
    const items = st.items || [];
    A.mount(groupsEl,
      chip(ALL, '全部', items.length),
      chip(NONE, '未分组', items.filter((x) => !x.group).length),
      st.groups.map((g) => chip(g, A.nm(g), items.filter((x) => x.group === g).length, true)),
      h('button.skc-chip.add', { onclick: addGroup }, icon('plus', 13), '新建分组'));
  }

  function renderGrid() {
    if (st.items === null) { A.mount(gridEl, h('div.row', { style: { padding: '30px', justifyContent: 'center' } }, h('span.spinner'))); return; }
    const list = visible();
    countEl.textContent = st.query || st.group !== ALL ? `${list.length} / ${st.items.length} 张` : `${st.items.length} 张`;
    if (!st.items.length) {
      A.mount(gridEl, A.emptyState({ iconName: 'palette', title: '皮肤库还是空的', text: '点「导入图片」一次选多张 PNG，或者「导入文件夹」；也可以直接把图片 / 文件夹拖到这个页面上',
        action: h('div.row', h('button.btn.primary', { onclick: pickFiles }, icon('import', 16), '导入图片'), h('button.btn', { onclick: pickFolder }, icon('folder', 16), '导入文件夹')) }));
      return;
    }
    if (!list.length) { A.mount(gridEl, A.emptyState({ iconName: 'search', title: '没有符合条件的皮肤', text: st.query ? `没有名字包含「${st.query}」的皮肤` : '这个分组里还没有皮肤：选中皮肤后在右边改分组，或者在这个分组下导入' })); return; }
    A.mount(gridEl, h('div.skc-grid', list.map(tile)));
  }

  function renderSide() {
    const it = selItem();
    if (!it) {
      A.mount(sideEl, h('div.skc-side-empty', icon('palette', 28), h('p', '点左边的皮肤，在这里看大预览、改名、换模型、分组，或者分配给账户')));
      return;
    }
    const v = big();
    v.set({ url: it.url, model: it.model, cape: null, walk: st.walk, layer: st.layer });
    const groupOpts = [{ value: '', label: '未分组' }, ...st.groups.map((g) => ({ value: g, label: A.nm(g) }))];
    A.mount(sideEl,
      h('div.sk-stage', v.el, h('div.sk-stage-tools',
        h('label.row', A.toggle(st.layer, (x) => { st.layer = x; renderSide(); }), '外层'),
        v.flat ? null : h('label.row', A.toggle(st.walk, (x) => { st.walk = x; renderSide(); }), '走动'),
        A.skinTools.turnButton(v),
        h('span.faint', v.flat ? '性能模式下是平面预览，点人物看背面' : '拖动可以旋转'))),
      h('div.skc-title', h('b', A.noTr(it.name)), h('button.btn.icon.ghost.sm', { onclick: rename, 'aria-label': '重命名', 'data-tip': '重命名' }, icon('edit', 14))),
      h('div.skc-actions',
        h('button.btn.primary', { onclick: assign }, icon('user', 15), '分配给账户'),
        h('button.btn.ghost', { onclick: remove }, icon('trash', 15), '删除')),
      h('div.sk-sec', h('h4', '模型'), A.seg(MODEL, it.model, (m) => update({ model: m })), h('div.hint', '导入时已自动识别，手臂不对时再切换')),
      h('div.sk-sec', h('h4', '分组'), A.select({ options: groupOpts, value: it.group || '', width: 220, onChange: (g) => update({ group: g }) })));
  }

  function renderAll() {
    if (!root) return;
    renderGroups();
    renderGrid();
    renderSide();
  }

  function build() {
    root = $('#page-skins');
    gridEl = h('div.skc-main');
    sideEl = h('div.skc-side');
    groupsEl = h('div.skc-groups');
    countEl = h('span.faint');
    const search = h('div.input-wrap', { style: { width: '240px' } }, icon('search', 16),
      h('input.input', { placeholder: '搜索皮肤名字…', 'aria-label': '搜索皮肤', oninput: A.debounce((e) => { st.query = e.target.value.trim(); renderGrid(); }, 120) }));
    const page = h('div.page-inner.skc-page',
      h('div.page-head',
        h('div', h('h1', '皮肤中心'), h('p', '管理你收藏的皮肤：批量导入、预览、分组，再分配给离线账户。账户卡片上的「皮肤」按钮也能用')),
        h('div.actions',
          h('button.btn', { onclick: pickFolder }, icon('folder', 16), '导入文件夹'),
          h('button.btn.primary', { onclick: pickFiles }, icon('import', 16), '导入图片'))),
      h('div.toolbar', groupsEl, h('div.spacer'), countEl, search),
      h('div.skc-body', gridEl, sideEl));
    // 拖放挂在整个页面上（1.5.7：以前只挂在中间最宽 1180px、高度随内容的那一栏，拖到两边或下面的空白处没反应）
    // 高亮用 drop-hover（1.5.9）：以前用的 drag 是全局的窗口拖动区（-webkit-app-region: drag），框里放不下文件、框一直闪
    const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
    root.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; page.classList.add('drop-hover'); });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) page.classList.remove('drop-hover'); });
    root.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); page.classList.remove('drop-hover'); fromDrop(e.dataTransfer); });
    A.mount(root, page);
  }

  function init() { build(); }

  A.pages.skins = { init, show: () => { renderAll(); load(); }, title: '皮肤中心' };
})();
