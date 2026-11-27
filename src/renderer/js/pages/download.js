'use strict';
/* 下载中心：游戏版本（含加载器安装）+ 在线资源（Modrinth / CurseForge，resources.js） */
(function () {
  const { h, icon, api, state, on, $, t } = A;

  let root;
  let tab = 'game';
  let content;
  let typeFilter = 'release';
  let query = '';
  let listEl;
  let heroEl;
  let renderTabsRef = null;

  function build() {
    root = $('#page-download');
    content = h('div');
    const tabs = h('div.tabs');
    const renderTabs = () => {
      const running = [...state.tasks.values()].filter((t) => t.status === 'running' && A.tasks.isDownload(t)).length;
      A.mount(tabs, [
        ['game', '游戏版本', 'box'], ['modpack', '整合包', 'layers'], ['mod', 'Mod', 'puzzle'], ['resourcepack', '资源包', 'image'], ['shader', '光影', 'sun'], ['tasks', '下载管理', 'download'],
      ].map(([id, label, ic]) => h('button', { class: `tab ${tab === id ? 'on' : ''} ${id === 'tasks' ? 'tab-right' : ''}`, onclick: () => { tab = id; renderTabs(); renderTab(); } },
        icon(ic, 16), label, id === 'tasks' && running ? h('span.nav-badge', { style: { marginLeft: '2px' } }, running) : null)));
    };
    renderTabsRef = renderTabs;
    renderTabs();
    A.mount(root, h('div.page-inner',
      h('div.page-head',
        h('div', h('h1', '下载中心'), h('p', '从 Mojang 官方源 / BMCLAPI 镜像下载游戏，从 Modrinth 和 CurseForge 获取整合包、Mod 与资源')),
        h('div.actions', h('button.btn', { onclick: () => A.importModpackFile() }, icon('import', 16), t('term.importPack')))),
      tabs, content));
    renderTab();
  }

  function renderTab() {
    if (tab === 'game') renderGame();
    else if (tab === 'tasks') renderManager();
    else A.resources.render(content, tab);
  }

  // ───────────── 下载管理 ─────────────
  let mgrFilter = 'all';
  let mgrStats = null;
  function renderManager() {
    const listEl = h('div.dm-list');
    mgrStats = h('div.dm-head');
    const filters = {
      all: () => true,
      running: (t) => t.status === 'running',
      done: (t) => t.status === 'done',
      failed: (t) => t.status === 'failed' || t.status === 'cancelled',
    };
    A.mount(content,
      mgrStats,
      h('div.toolbar',
        A.seg([{ value: 'all', label: '全部' }, { value: 'running', label: '进行中' }, { value: 'done', label: '已完成' }, { value: 'failed', label: '失败 / 已取消' }], mgrFilter, (v) => { mgrFilter = v; renderManager(); }, { accent: true }),
        h('div.spacer'),
        h('button.btn', { onclick: async () => { for (const t of state.tasks.values()) if (t.status === 'running' && t.kind !== 'launch' && t.kind !== 'test') await api('tasks:cancel', t.id); } }, icon('x', 16), '全部取消'),
        h('button.btn', { onclick: () => api('tasks:clear') }, icon('trash', 16), '清除已结束')),
      listEl);
    A.tasks.mountManager(listEl, {
      filter: filters[mgrFilter],
      empty: () => A.emptyState({ iconName: 'download', title: mgrFilter === 'all' ? '还没有下载任务' : '没有符合条件的任务', text: '安装游戏、加载器、Java、Mod 或整合包时，任务会显示在这里' }),
    });
    renderMgrStats();
  }

  function renderMgrStats() {
    if (!mgrStats || !mgrStats.isConnected) return;
    const all = [...state.tasks.values()].filter(A.tasks.isDownload);
    const running = all.filter((t) => t.status === 'running');
    const speed = running.reduce((s, t) => s + (t.speed || 0), 0);
    const files = running.reduce((s, t) => s + ((t.files && t.files.active) || 0), 0);
    // 只改数字：每个任务每次更新都会走到这里
    if (!mgrStats.__cells) {
      const stat = (l) => { const b = h('b'); const el = h('div.dm-stat', b, h('span', l)); return { b, el }; };
      const cells = { running: stat('进行中'), speed: stat('总速度'), files: stat('活动连接'), done: stat('已完成'), failed: stat('失败'), src: h('span.faint', { style: { fontSize: '12px' } }) };
      A.mount(mgrStats, cells.running.el, cells.speed.el, cells.files.el, cells.done.el, cells.failed.el, h('div.spacer'), cells.src);
      mgrStats.__cells = cells;
    }
    const c = mgrStats.__cells;
    A.setText(c.running.b, String(running.length));
    A.setText(c.speed.b, speed ? A.fmtSpeed(speed) : '—');
    A.setText(c.files.b, String(files || '—'));
    A.setText(c.done.b, String(all.filter((t) => t.status === 'done').length));
    A.setText(c.failed.b, String(all.filter((t) => t.status === 'failed').length));
    A.setText(c.src, `下载源：${state.mirrorLabel || '自动'} · 并发 ${state.config.concurrency}`);
  }

  // ───────────── 游戏版本 ─────────────
  function renderGame() {
    heroEl = h('div.ver-hero');
    listEl = h('div.list');
    const counts = h('span');
    const search = h('div.input-wrap', icon('search', 16), h('input.input', { placeholder: '搜索版本号，例如 1.20.1', value: query, oninput: A.debounce((e) => { query = e.target.value.trim().toLowerCase(); renderList(); }, 120) }));
    A.mount(content,
      heroEl,
      h('div.toolbar',
        search,
        h('div.spacer'),
        A.seg([{ value: 'release', label: '正式版' }, { value: 'snapshot', label: '快照版' }, { value: 'old', label: '远古版' }, { value: 'all', label: '全部' }], typeFilter, (v) => { typeFilter = v; renderList(); }, { accent: true }),
        h('button.btn.icon', { 'data-tip': '刷新版本列表', onclick: () => loadManifest(true) }, icon('refresh', 16))),
      listEl);
    if (state.manifest) { renderHero(); renderList(); } else loadManifest(false);
  }

  async function loadManifest(force) {
    if (listEl) A.mount(listEl, [...Array(6)].map(() => h('div.skeleton', { style: { height: '68px' } })));
    try {
      state.manifest = await api('versions:manifest', force);
      A.emit('manifest', state.manifest);
      if (state.manifest._offline) A.toast({ level: 'warn', text: '无法连接到下载源，显示的是缓存的版本列表' });
    } catch (e) {
      if (listEl) A.mount(listEl, A.emptyState({ iconName: 'alertCircle', title: '获取版本列表失败', text: A.errText(e), action: h('button.btn', { onclick: () => loadManifest(true) }, '重试') }));
      return;
    }
    if (tab === 'game') { renderHero(); renderList(); }
  }

  function renderHero() {
    if (!heroEl || !state.manifest) return;
    const { latest, versions } = state.manifest;
    const find = (id) => versions.find((v) => v.id === id);
    const card = (label, v, cls) => v ? h('div', { class: `hero-card ${cls}` },
      h('img', { src: A.typeIcon(v.type, 96) }),
      h('div', h('div.h-label', label), h('div.h-title', v.id), h('div.h-sub', `发布于 ${A.fmtDate(v.releaseTime)} · ${A.fmtRelative(v.releaseTime)}`)),
      installedFor(v.id) ? h('span.badge.ok', { style: { marginLeft: 'auto' } }, icon('check', 12), '已安装') : h('button.btn.primary', { onclick: () => installDialog(v.id) }, icon('download', 16), '安装')) : null;
    A.mount(heroEl, card('最新正式版', find(latest.release), ''), latest.snapshot !== latest.release ? card('最新快照版', find(latest.snapshot), 'snap') : null);
  }

  const installedFor = (mc) => state.installed.some((v) => v.id === mc || (v.mcVersion === mc && !v.loader));

  function renderList() {
    if (!listEl || !state.manifest) return;
    let list = state.manifest.versions;
    if (typeFilter === 'release') list = list.filter((v) => v.type === 'release');
    else if (typeFilter === 'snapshot') list = list.filter((v) => v.type === 'snapshot');
    else if (typeFilter === 'old') list = list.filter((v) => v.type.startsWith('old'));
    if (query) list = list.filter((v) => v.id.toLowerCase().includes(query));
    if (!list.length) { A.mount(listEl, A.emptyState({ iconName: 'search', title: '没有找到匹配的版本' })); return; }
    const frag = document.createDocumentFragment();
    for (const v of list.slice(0, 400)) {
      const inst = installedFor(v.id);
      frag.appendChild(h('div.list-row.clickable', { onclick: () => installDialog(v.id) },
        h('div.ico', h('img', { src: A.typeIcon(v.type), loading: 'lazy' })),
        h('div.body',
          h('div.title', h('span', v.id), v.id === state.manifest.latest.release || v.id === state.manifest.latest.snapshot ? h('span.badge.accent', '最新') : null, inst ? h('span.badge.ok', '已安装') : null),
          h('div.sub', `${A.TYPE_NAMES[v.type] || v.type} · ${A.fmtDate(v.releaseTime)}`)),
        h('div.actions', h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); installDialog(v.id); } }, icon('download', 14), inst ? '再次安装' : '安装'))));
    }
    A.mount(listEl, frag);
  }

  // ───────────── 安装对话框 ─────────────
  const LOADER_TYPES = [
    { type: '', name: '原版', sub: 'Vanilla', kind: 'grass' },
    { type: 'vanillaplus', name: t('term.vanillaPlus'), sub: 'QoL + 光影', kind: 'diamond' },
    { type: 'fabric', name: 'Fabric', sub: '轻量 · 现代', kind: 'fabric' },
    { type: 'quilt', name: 'Quilt', sub: 'Fabric 分支', kind: 'quilt' },
    { type: 'legacyfabric', name: 'Legacy Fabric', sub: '旧版本 Fabric', kind: 'fabric' },
    { type: 'forge', name: 'Forge', sub: '经典', kind: 'forge' },
    { type: 'neoforge', name: 'NeoForge', sub: 'Forge 分支', kind: 'neoforge' },
  ];

  /** 按版本显示真正可能可用的加载器（1.14 之前只有 Forge 与 Legacy Fabric） */
  function loadersFor(mc) {
    const m = String(mc).match(/^1\.(\d+)/);
    const old = m ? Number(m[1]) < 14 : false;
    const allow = old ? ['', 'vanillaplus', 'forge', 'legacyfabric'] : ['', 'vanillaplus', 'fabric', 'quilt', 'forge', 'neoforge'];
    return LOADER_TYPES.filter((l) => allow.includes(l.type));
  }

  // 版本清单还没读完时连点两下「安装」：只开一个对话框
  let opening = false;
  async function installDialog(mc, dopts = {}) {
    if (opening) return;
    opening = true;
    try { if (!state.manifest) await loadManifest(false); } finally { opening = false; }
    const entry = state.manifest && state.manifest.versions.find((v) => v.id === mc);
    let loaderTypes = loadersFor(mc);
    if (dopts.requireLoader) loaderTypes = loaderTypes.filter((l) => l.type);
    if (dopts.vanillaOnly) loaderTypes = loaderTypes.filter((l) => !l.type);
    if (dopts.nostalgia) loaderTypes = loaderTypes.map((l) => (l.type === 'vanillaplus' ? { ...l, name: '怀旧+', sub: '经典 QoL Mod' } : l));
    let loaderType = '';
    let vp = null;
    const vpWrap = h('div.field.hidden');
    const iso = A.iso.picker();
    // 自动一键 Debug：玩家没动过开关时，跟着「有没有额外 Mod」自动打开 / 关闭
    let debugTouched = false;
    const debugToggle = A.toggle(false, () => { debugTouched = true; });
    const debugWrap = h('label.toggle-row.hidden', debugToggle, h('div', h('div.tr-title', t('test.autoDebug', { debug: t('term.debug') })), h('div.tr-desc', t('test.autoDebugDesc'))));
    const extras = A.extraMods({ mc, loader: null, onChange: (n) => { if (!debugTouched) debugToggle.set(n > 0); } });
    const extrasWrap = h('div.field.hidden', h('label', '额外 Mod（可选）'), extras.el);
    let modalRef = null;
    let loaderList = [];
    let loaderVer = null;
    let nameTouched = false;
    const cache = {};

    const nameInput = h('input.input', { value: mc, spellcheck: 'false', 'aria-label': '名称', oninput: () => { nameTouched = true; validate(); } });
    const nameErr = h('div.err.hidden', { role: 'alert' });
    const cards = h('div.loader-grid');
    const verWrap = h('div.field.hidden');
    const apiWrap = h('label.toggle-row.hidden');
    const apiToggle = A.toggle(true);
    apiWrap.append(apiToggle, h('div', h('div.tr-title', '同时安装 Fabric API'), h('div.tr-desc', '绝大多数 Fabric Mod 都需要它')));
    let installBtn;

    const defaultName = () => {
      if (loaderType === 'vanillaplus') return `${mc} ${t('term.vanillaPlus')}`;
      if (!loaderType || !loaderVer) return mc;
      return `${mc}-${(A.LOADERS[loaderType] || {}).name || loaderType}-${loaderVer.version}`;
    };
    const validate = () => {
      const v = nameInput.value.trim();
      let msg = '';
      if (!v) msg = '名称不能为空';
      else if (A.nameProblem(v)) msg = A.nameProblem(v);
      else if (state.installed.some((x) => x.id.toLowerCase() === v.toLowerCase())) msg = '已存在同名配置，请更换名称';
      nameErr.textContent = msg;
      nameErr.classList.toggle('hidden', !msg);
      const loaderMissing = loaderType && loaderType !== 'vanillaplus' && !loaderVer;
      if (installBtn) installBtn.disabled = !!msg || loaderMissing;
      return !msg;
    };

    cards.style.gridTemplateColumns = `repeat(${Math.min(6, loaderTypes.length)}, 1fr)`;
    const renderCards = () => A.mount(cards, loaderTypes.map((l) => h('div', {
      class: `loader-card ${loaderType === l.type ? 'on' : ''} ${cache[l.type] && !cache[l.type].length ? 'unavailable' : ''}`,
      onclick: () => selectLoader(l.type),
    }, h('img', { src: A.blockImage(l.kind, 64) }), h('div.lc-name', l.name), h('div.lc-sub', cache[l.type] && !cache[l.type].length && l.type ? '不可用' : l.sub))));

    async function selectLoader(type) {
      loaderType = type;
      loaderVer = null;
      renderCards();
      apiWrap.classList.toggle('hidden', !(type === 'fabric' || type === 'quilt' || type === 'legacyfabric'));
      vpWrap.classList.toggle('hidden', type !== 'vanillaplus');
      extrasWrap.classList.toggle('hidden', !type || type === 'vanillaplus');
      debugWrap.classList.toggle('hidden', !type || type === 'vanillaplus');
      extras.setTarget(mc, type && type !== 'vanillaplus' ? type : null);
      if (type === 'vanillaplus') {
        verWrap.classList.add('hidden');
        if (!vp) {
          vp = A.vanillaPlusPanel(mc);
          A.mount(vpWrap, h('label', '选择你需要的功能（每一类都可以换成自己喜欢的 Mod）'), vp.el);
        }
        if (!nameTouched) nameInput.value = defaultName();
        validate();
        return;
      }
      if (!type) {
        verWrap.classList.add('hidden');
        if (!nameTouched) nameInput.value = defaultName();
        validate();
        return;
      }
      verWrap.classList.remove('hidden');
      A.mount(verWrap, h('label', `${(A.LOADERS[type] || {}).name} 版本`), h('div.row', h('span.spinner'), h('span.muted', '正在获取版本列表…')));
      validate();
      try {
        if (!cache[type]) cache[type] = await api('loaders:list', type, mc);
      } catch (e) {
        if (loaderType !== type) return;
        A.mount(verWrap, h('label', `${(A.LOADERS[type] || {}).name} 版本`), A.errInline('获取失败', e));
        return;
      }
      if (loaderType !== type) return;
      loaderList = cache[type];
      renderCards();
      if (!loaderList.length) {
        A.mount(verWrap, h('label', `${(A.LOADERS[type] || {}).name} 版本`), h('div.faint', `${(A.LOADERS[type] || {}).name} 暂不支持 Minecraft ${mc}`));
        validate();
        return;
      }
      loaderVer = loaderList.find((x) => x.recommended) || loaderList.find((x) => x.stable) || loaderList[0];
      const sel = A.select({
        options: loaderList.map((x) => ({
          value: x.version, label: x.version,
          sub: [x.recommended ? '推荐' : '', x.latest ? '最新' : '', x.stable ? '' : '测试版'].filter(Boolean).join(' · '),
        })),
        value: loaderVer.version,
        searchable: true,
        block: true,
        onChange: (val) => { loaderVer = loaderList.find((x) => x.version === val); if (!nameTouched) nameInput.value = defaultName(); validate(); },
      });
      A.mount(verWrap, h('label', `${(A.LOADERS[type] || {}).name} 版本`), sel,
        type === 'forge' || type === 'neoforge' ? h('div.hint', '将下载官方安装器并以无界面方式执行，过程可能需要几分钟') : null);
      if (!nameTouched) nameInput.value = defaultName();
      validate();
    }

    modalRef = A.modal({
      title: `安装 Minecraft ${mc}`,
      subtitle: entry ? `${A.TYPE_NAMES[entry.type] || entry.type} · 发布于 ${A.fmtDate(entry.releaseTime)}` : '',
      icon: h('img.modal-img', { src: A.typeIcon(entry && entry.type, 96), alt: '' }),
      size: 'lg',
      steps: dopts.steps,
      body: h('div',
        dopts.nostalgia ? A.alert({ level: 'info', icon: 'clock', text: `怀旧模式：将自动使用 Java 8 运行，并为旧版本处理资源文件与本地库。${dopts.vanillaOnly ? '远古版本只能以原版运行。' : '经典 Mod 不在 Modrinth 上时，可以在「额外 Mod」中拖入自己下载的 jar。'}` }) : null,
        h('div.field', h('label', '类型 / Mod 加载器'), cards),
        verWrap,
        apiWrap,
        vpWrap,
        extrasWrap,
        debugWrap,
        h('div.field', h('label', '存档'), iso.el),
        h('div.field', h('label', '名称'), nameInput, nameErr, h('div.hint', `安装后显示在${t('term.profile')}中的名称，可以随时修改`))),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: '开始安装', kind: 'primary', icon: 'download', ref: (b) => { installBtn = b; },
          onClick: async () => {
            if (!validate()) return false;
            const name = nameInput.value.trim();
            const isolation = iso.get();
            if (loaderType === 'vanillaplus') {
              if (!vp || !vp.ready()) { A.toast({ level: 'warn', text: '正在检查可用的 Mod，请稍候' }); return false; }
              await api('vanillaplus:install', { mc, name, ...vp.get(), isolation, nostalgia: dopts.nostalgia || null });
              A.toast({ level: 'info', title: `已开始安装${t('term.vanillaPlus')}`, text: `${A.nm(name)}：${vp.summary()}` });
              A.setConfig({ selectedVersion: name });
              return true;
            }
            const opts = { mc, name, asProfile: !!dopts.asProfile, isolation, nostalgia: dopts.nostalgia || null, ...(loaderType ? extras.get() : {}) };
            if (loaderType && loaderVer) opts.loader = { type: loaderType, version: loaderVer.version, full: loaderVer.full };
            if (['fabric', 'quilt', 'legacyfabric'].includes(loaderType)) opts.fabricApi = apiToggle.get();
            if (opts.loader) opts.autoDebug = debugToggle.get();
            await api('versions:install', opts);
            A.toast({ level: 'info', title: '已开始安装', text: `${A.nm(name)}，可在右上角查看进度` });
            if (!state.config.selectedVersion || !state.installed.length || dopts.asProfile) A.setConfig({ selectedVersion: name });
            return true;
          },
        },
      ],
    });
    renderCards();
    validate();
    if (dopts.preset === 'vanillaplus') selectLoader('vanillaplus');
    else if (dopts.requireLoader) selectLoader(loaderTypes.find((l) => l.type && l.type !== 'vanillaplus').type);
  }

  function show(params) {
    if (params && params.install) {
      tab = 'game';
      build();
      installDialog(params.install);
      return;
    }
    if (params && params.tab) { tab = params.tab; build(); return; }
    if (tab !== 'game') return;
    if (tab === 'game') { renderHero(); renderList(); }
  }

  function init() {
    build();
    const refreshGame = A.pageRefresher('download', () => { if (tab === 'game') { renderHero(); renderList(); } });
    on('installed', refreshGame);
    let lastRunning = -1;
    on('task', () => {
      if (state.page !== 'download') return;
      const running = [...state.tasks.values()].filter((t) => t.status === 'running' && A.tasks.isDownload(t)).length;
      if (running !== lastRunning && renderTabsRef) { lastRunning = running; renderTabsRef(); }
      if (tab === 'tasks') renderMgrStats();
    });
  }

  A.pages.download = { init, show, title: '下载中心' };
  A.installDialog = installDialog;
})();
