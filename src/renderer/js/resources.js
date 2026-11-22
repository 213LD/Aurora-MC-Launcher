'use strict';
/* 下载页的在线资源：Mod / 资源包 / 光影 / 整合包；来源可以切换 Modrinth / CurseForge */
(function () {
  const { h, icon, api, state, t } = A;

  const rs = { type: 'mod', source: '', query: '', sort: 'relevance', target: null, offset: 0, hits: [], total: 0, seq: 0, packMc: '', packLoader: '' };
  const TYPE_LABEL = { mod: 'Mod', resourcepack: '资源包', shader: '光影包', modpack: '整合包' };
  const PACK_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];
  const src = () => A.sources.get(rs.source);
  const isCf = () => rs.source === 'curseforge';

  function resTarget() {
    const found = state.installed.find((v) => v.id === rs.target);
    if (found) return found;
    const cur = A.currentVersion();
    if (rs.type === 'mod') return (cur && cur.loader ? cur : A.modTargets.moddedFirst()[0]) || cur || null;
    return cur || null;
  }

  function render(container, type) {
    const source = A.sources.current();
    if (rs.type !== type || rs.source !== source) { rs.type = type; rs.source = source; rs.hits = []; rs.offset = 0; }
    const isPack = type === 'modpack';
    const tgt = isPack ? null : resTarget();
    if (!isPack) rs.target = tgt ? tgt.id : null;
    const grid = h('div.res-grid');
    const more = h('div.row', { style: { justifyContent: 'center', marginTop: '16px' } });
    const warn = h('div');
    const zhEl = h('div.mn-match');
    // 输入框里的字按玩家打的为准（rs.draft）：删空后立刻回到不带关键词的列表，切换页面回来也不会再填回上次搜的词（1.5.7）
    const input = h('input.input', {
      placeholder: t('res.search', { source: src().name, type: TYPE_LABEL[type] }), value: rs.draft != null ? rs.draft : rs.query,
      onkeydown: (e) => { if (e.key === 'Enter') { rs.query = input.value.trim(); rs.picked = null; search(true); } },
      oninput: () => {
        rs.draft = input.value;
        if (!input.value.trim() && rs.query) { rs.query = ''; rs.picked = null; search(true); }
      },
    });
    const sortSel = A.select({
      options: [
        { value: 'relevance', label: '相关度' }, { value: 'downloads', label: '下载量' }, { value: 'follows', label: isCf() ? t('res.sortRating') : '关注数' },
        { value: 'newest', label: '最新发布' }, { value: 'updated', label: '最近更新' },
      ],
      value: rs.sort, width: 130, onChange: (v) => { rs.sort = v; search(true); },
    });
    // Mod 标签多一个来源「MC 百科国创」（内部版、简体中文界面才有，mcmodcn.js）；选它时整块交给 mcmodcn 画
    const cnOk = type === 'mod' && A.mcmodCn && A.mcmodCn.available();
    if (!cnOk) rs.cn = false;
    const sourceSeg = A.seg([...A.sources.list.map((s) => ({ value: s.id, label: s.name })), ...(cnOk ? [{ value: 'mcmodcn', label: 'MC 百科国创' }] : [])],
      rs.cn ? 'mcmodcn' : rs.source, (v) => { rs.cn = v === 'mcmodcn'; if (!rs.cn) A.sources.set(v); render(container, type); });
    if (rs.cn) {
      rs.els = null;
      rs.seq++; // 还在进行的 Modrinth / CurseForge 搜索作废（回来时不会往已经不在的列表里画）
      A.mcmodCn.render(container, { head: h('div.toolbar.res-search', sourceSeg), target: tgt, openProject: (source, slug) => openBySlug(container, type, source, slug) });
      return;
    }
    let filters;
    if (isPack) {
      const releases = state.manifest ? state.manifest.versions.filter((v) => v.type === 'release').slice(0, 60) : [];
      filters = [
        A.select({ options: [{ value: '', label: '全部版本' }, ...releases.map((v) => ({ value: v.id, label: v.id }))], value: rs.packMc, width: 140, searchable: true, onChange: (v) => { rs.packMc = v; search(true); } }),
        A.select({ options: [{ value: '', label: '全部加载器' }, ...PACK_LOADERS.map((l) => ({ value: l, label: A.LOADERS[l].name }))], value: rs.packLoader, width: 140, onChange: (v) => { rs.packLoader = v; search(true); } }),
      ];
    } else {
      filters = [h('span.faint', { style: { fontSize: '12.5px' } }, '安装到'), A.select({
        options: [{ value: '', label: '不限版本', sub: '浏览全部资源' }, ...A.modTargets.options()],
        value: rs.target || '', width: 240, searchable: true, placeholder: '安装到…',
        onChange: (v) => { rs.target = v || null; search(true); },
      })];
    }
    // 两行：来源 + 搜索；安装到 / 筛选 + 排序（放一行在默认窗口宽度下会折行）
    A.mount(container,
      h('div.toolbar.res-search',
        sourceSeg,
        h('div.input-wrap', icon('search', 16), input),
        h('button.btn.primary', { onclick: () => { rs.query = input.value.trim(); rs.picked = null; search(true); } }, '搜索')),
      h('div.toolbar', ...filters, h('div.spacer'), sortSel),
      type === 'shader' ? A.shaderUi.panel({ isCf: isCf(), onChange: () => { rs.hits = []; render(container, type); } }) : null,
      zhEl, warn, grid, more);
    rs.els = { grid, more, warn, zhEl };

    rs.renderWarn = () => {
      const tv = state.installed.find((v) => v.id === rs.target);
      A.clear(warn);
      if (type === 'mod' && tv && !tv.loader) {
        warn.appendChild(A.alert({
          level: 'warn', text: `「${tv.id}」没有安装 Mod 加载器，下载的 Mod 不会生效`,
          actions: [h('button.btn.sm', { onclick: () => A.installDialog(tv.mcVersion, { asProfile: true, requireLoader: true }) }, '创建 Mod 配置')],
        }));
      }
      if (type === 'shader') warn.appendChild(h('div.faint', { style: { fontSize: '12.5px', margin: '-4px 0 12px' } }, '光影需要 Iris（Fabric/Quilt/NeoForge）或 OptiFine 才能使用'));
      if (isPack) warn.appendChild(h('div.faint', { style: { fontSize: '12.5px', margin: '-4px 0 12px' } }, isCf() ? t('res.packNoteCf', { profile: t('term.profile') }) : `整合包会被安装为一个独立的${t('term.profile')}；也可以把它导入「${t('term.planner')}」作为基础自由增删`));
    };
    rs.renderWarn();
    if (rs.hits.length) renderHits(); else search(true);
  }

  async function search(reset) {
    if (!rs.els) return;
    const isPack = rs.type === 'modpack';
    const tv = isPack ? null : state.installed.find((v) => v.id === rs.target);
    if (reset) { rs.offset = 0; rs.hits = []; A.mount(rs.els.grid, [...Array(6)].map(() => h('div.skeleton', { style: { height: '96px', borderRadius: '18px' } }))); A.clear(rs.els.more); }
    if (rs.renderWarn) rs.renderWarn();
    const my = ++rs.seq;
    const S = src();
    // Mod 的中文名 / 缩写：本地对照表 → MC 百科（开着时自动，关着时候选条里可以「查一次」）
    let query = rs.query;
    if (rs.type === 'mod') {
      const ex = await A.mcmodUi.resolveQuery(rs.query);
      if (my !== rs.seq) return;
      query = rs.picked || ex.query;
      if (reset) A.mount(rs.els.zhEl, A.mcmodUi.matchBar(ex, query, (en) => { rs.picked = en; search(true); }, () => search(true)));
    } else A.clear(rs.els.zhEl);
    // 光影的性能 / 特性 / 风格筛选（1.5.9）
    const extra = rs.type === 'shader' ? await A.shaderUi.params(isCf()) : {};
    if (my !== rs.seq) return;
    if (extra.empty) {
      rs.hits = []; rs.total = 0;
      rs.els.grid.style.display = 'block';
      A.mount(rs.els.grid, A.emptyState({ iconName: 'search', title: '没有适合这台电脑的光影', text: extra.empty }));
      A.clear(rs.els.more);
      return;
    }
    try {
      const r = await S.search({
        ...extra, query, type: rs.type, sort: rs.sort, offset: rs.offset,
        gameVersion: isPack ? rs.packMc || undefined : tv ? tv.mcVersion : undefined,
        loader: isPack ? rs.packLoader || undefined : rs.type === 'mod' && tv && tv.loader ? tv.loader.type : undefined,
      });
      if (my !== rs.seq) return;
      rs.hits = reset ? r.hits : [...rs.hits, ...r.hits];
      rs.total = r.total;
      rs.offset = rs.hits.length;
      renderHits();
    } catch (e) {
      if (my !== rs.seq) return;
      rs.els.grid.style.display = 'block';
      A.mount(rs.els.grid, A.emptyState({
        iconName: 'xCircle', title: t('res.connectFailed', { source: S.name }), text: e.message,
        action: h('div.row', h('button.btn', { onclick: () => search(true) }, '重试'), A.sources.setupAction(e)),
      }));
    }
  }

  function renderHits() {
    const { grid, more } = rs.els;
    if (!rs.hits.length) {
      A.mount(grid, A.emptyState({ iconName: 'search', title: '没有找到相关资源', text: '换个关键词或更换筛选条件试试' }));
      grid.style.display = 'block';
      A.clear(more);
      return;
    }
    grid.style.display = '';
    A.mount(grid, rs.hits.map(resCard));
    // Mod 的中文名：本地对照表没有的用 MC 百科缓存补（只读缓存，不联网；1.5.7 之前下载页只认对照表）
    if (rs.type === 'mod') A.mcmodUi.fillZh(grid, rs.hits.map((p) => A.mcmodUi.projOf(p, isCf() ? 'curseforge' : 'modrinth')));
    A.mount(more, rs.hits.length < rs.total
      ? h('button.btn', { onclick: (e) => { e.currentTarget.disabled = true; search(false); } }, `加载更多（${rs.hits.length}/${rs.total}）`)
      : h('span.faint', { style: { fontSize: '12.5px' } }, `共 ${rs.total} 个结果`));
    // 光影徽章；CurseForge 只能在拿到结果后按借来的标签藏掉不适合的
    if (rs.type === 'shader') {
      const seq = rs.seq;
      A.shaderUi.fill(grid, rs.hits, isCf()).then((hidden) => {
        if (!hidden || seq !== rs.seq) return;
        more.insertBefore(h('div.faint', { style: { fontSize: '12.5px', marginBottom: '8px', textAlign: 'center' } }, `已隐藏 ${hidden} 个可能带不动或性能未知的光影`), more.firstChild);
        if (hidden === rs.hits.length && rs.hits.length >= rs.total) grid.appendChild(h('div.faint', { style: { gridColumn: '1 / -1', textAlign: 'center', padding: '20px' } }, '这一页没有适合这台电脑的光影'));
      });
    }
  }

  /** 标题前的中文名：本地对照表先写上，MC 百科缓存 / 查到的译名再换上去（百科优先，1.6.1；fillZh） */
  const zhSpan = (p) => {
    const zh = A.modNames.zhOf(p);
    return h('span.mn-zh', { 'data-key': A.mcmodUi.keyOf(A.mcmodUi.projOf(p, isCf() ? 'curseforge' : 'modrinth')) }, zh ? `${zh} ` : '');
  };

  function resCard(p) {
    const fallback = rs.type === 'mod' ? 'fabric' : rs.type === 'shader' ? 'diamond' : rs.type === 'modpack' ? 'neoforge' : 'grass';
    return h('div.res-card', { onclick: () => openProject(p) },
      h('img.r-ico', { src: p.icon || A.blockImage(fallback, 64), loading: 'lazy', onerror: (e) => { e.target.src = A.blockImage('unknown', 64); } }),
      h('div.r-body',
        // 名字、作者、简介是作者自己写的（和详情里的正文一样）：不翻译
        h('div.r-title', h('b', { 'data-no-tr': '' }, rs.type === 'mod' ? zhSpan(p) : null, A.nm(p.title)), h('span.r-author', { 'data-no-tr': '', title: p.author ? A.nm(p.author) : '' }, `by ${A.nm(p.author)}`)),
        h('div.r-desc', { 'data-no-tr': '' }, A.nm(p.description)),
        h('div.r-meta',
          h('span', icon('download', 12), A.fmtNum(p.downloads)),
          // CurseForge 的点赞数接口一直返回 0，不显示
          p.follows ? h('span', icon('heart', 12), A.fmtNum(p.follows)) : null,
          h('span', icon('clock', 12), A.fmtRelative(p.updated)),
          p.allowDistribution === false ? A.sources.manualBadge(rs.type === 'modpack' ? t('res.packManualTip') : undefined) : null,
          rs.type === 'shader' ? A.shaderUi.slot(p) : null,
          ...p.categories.filter((c) => !['fabric', 'forge', 'neoforge', 'quilt', 'babric', 'legacy-fabric'].includes(String(c).toLowerCase())).slice(0, 3).map((c) => h('span.badge', { title: c }, A.tagLabel(c))))));
  }

  /** 国创浏览里点「在启动器里安装」：切回对应来源，找到这个项目打开它的安装界面 */
  async function openBySlug(container, type, source, slug) {
    rs.cn = false;
    A.sources.set(source);
    render(container, type);
    try {
      let p;
      if (source === 'modrinth') p = await A.sources.get('modrinth').project(slug);
      else {
        const r = await A.sources.get('curseforge').search({ query: slug.replace(/-/g, ' '), type: 'mod', sort: 'relevance', offset: 0 });
        p = r.hits.find((x) => String(x.slug).toLowerCase() === slug) || null;
      }
      if (!p) throw new Error(`在 ${A.sources.get(source).name} 上没找到「${slug}」`);
      openProject(p);
    } catch (e) { A.errorToast('打开失败', e); }
  }

  async function openProject(p) {
    const isPack = rs.type === 'modpack';
    const S = src();
    const cf = isCf();
    const tv = isPack ? null : state.installed.find((v) => v.id === rs.target);
    let showAll = !tv;
    const verList = h('div.list');
    const desc = h('div.md-body', { 'data-no-tr': '', style: { maxHeight: '220px', overflow: 'auto', marginBottom: '6px' } }, h('p', p.description));
    // 标题的中文名：对照表 → MC 百科缓存（有就换成百科的译名，1.6.1）→ 下面详情块查到后也写上（1.5.7：以前详情块有中文名、标题还是英文）
    const titleZh = zhSpan(p);
    if (rs.type === 'mod') A.mcmodUi.fillZh(titleZh, [A.mcmodUi.projOf(p, cf ? 'curseforge' : 'modrinth')]);
    const setTitleZh = (info) => { if (info) A.mcmodUi.setZh(titleZh, info.zh); };
    const header = h('div.row', { style: { gap: '14px', marginBottom: '14px' } },
      h('img', { src: p.icon || A.blockImage('unknown', 64), style: { width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover', background: 'var(--surface-2)' } }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontSize: '19px', fontWeight: 750 } }, rs.type === 'mod' ? titleZh : null, A.nm(p.title)),
        h('div.muted', { style: { fontSize: '12.5px' } }, `by ${A.nm(p.author)} · ${A.fmtNum(p.downloads)} 次下载${p.follows ? ` · ${A.fmtNum(p.follows)} 关注` : ''}`),
        h('div.row.wrap', { style: { marginTop: '6px', gap: '5px' } }, p.categories.slice(0, 6).map((c) => h('span.badge', { title: c }, A.tagLabel(c))))));
    const allToggle = h('label.row', { style: { cursor: 'pointer', fontSize: '12.5px', gap: '8px' } }, A.toggle(showAll, (v) => { showAll = v; loadVersions(); }), '显示全部版本');

    const m = A.modal({
      title: '',
      size: 'lg',
      body: h('div', header,
        p.allowDistribution === false ? A.alert({ level: 'info', compact: true, text: isPack ? t('res.packManualTip') : t('res.manualTip') }) : null,
        rs.type === 'mod' ? A.mcmodUi.detailBlock(p, cf ? 'curseforge' : 'modrinth', { onInfo: setTitleZh }) : null,
        rs.type === 'shader' ? A.shaderUi.detail(p, cf) : null,
        desc,
        h('div.row', { style: { margin: '16px 0 10px' } }, h('b', isPack ? '整合包版本' : '可用版本'), tv ? h('span.faint', { style: { fontSize: '12.5px' } }, `适用于 ${A.nm(A.displayName(tv))}`) : null, h('div.spacer'), tv ? allToggle : null),
        verList),
      actions: [
        { label: t('res.viewOn', { source: S.name }), kind: 'ghost', left: true, icon: 'external', onClick: () => { api('shell:external', S.page(p, rs.type)); return false; } },
        isPack && !cf ? { label: `用${t('term.planner')}定制`, kind: '', icon: 'sparkles', onClick: () => { A.go('planner', { fromModpack: p }); } } : null,
        { label: t('common.close'), kind: '' },
      ].filter(Boolean),
    });

    S.project(p.id).then((d) => { if (d.body) A.mount(desc, A.markdown(d.body.slice(0, 20000))); }).catch(() => {});

    const packButton = (v) => {
      if (v.manual) {
        return h('button.btn.sm', {
          'data-tip': t('res.packManualTip'),
          onclick: () => { api('shell:external', `${p.url}/download/${v.id}`); A.toast({ level: 'info', duration: 10000, title: t('res.packManual'), text: t('res.packManualToast', { importPack: t('term.importPack') }) }); },
        }, icon('external', 14), t('res.packManual'));
      }
      return h('button.btn.sm.primary', {
        onclick: () => {
          A.modpackInstallDialog({
            title: `安装整合包：${A.nm(p.title)}`,
            subtitle: `${A.nm(v.name || v.number)} · Minecraft ${v.gameVersions.join(', ')}`,
            name: p.title,
            mc: v.gameVersions[v.gameVersions.length - 1],
            loader: (v.loaders || []).find((l) => PACK_LOADERS.includes(l)),
            onConfirm: async (name, extras, iso) => {
              if (A.nameProblem(name)) { A.toast({ level: 'warn', text: A.nameProblem(name) }); return false; }
              const params = { name, icon: p.icon, title: p.title, extras: { ...extras, isolation: iso } };
              if (cf) await api('modpack:installCurseforge', { ...params, projectId: p.id, fileId: v.id });
              else await api('modpack:installModrinth', { ...params, projectId: p.id, versionId: v.id });
              A.toast({ level: 'info', text: `开始安装整合包 ${name}` });
              m.close();
              return true;
            },
          });
        },
      }, icon('download', 14), '安装');
    };

    const installButton = (v) => h('button.btn.sm.primary', {
      disabled: !rs.target,
      'data-tip': rs.target ? `安装到 ${rs.target}` : '请先选择要安装到的配置',
      onclick: async () => {
        try {
          await S.install({ versionId: rs.target, projectVersion: v, kind: rs.type, title: p.title, withDeps: true });
          A.toast({ level: 'info', text: `开始下载 ${A.nm(p.title)}` });
          m.close();
        } catch (e) { A.errorToast('无法下载', e); }
      },
    }, icon('download', 14), '安装');

    async function loadVersions() {
      A.mount(verList, h('div.row', { style: { justifyContent: 'center', padding: '20px' } }, h('span.spinner')));
      try {
        const vs = await S.versions(p.id, showAll || !tv ? { type: rs.type } : { type: rs.type, loader: tv.loader ? tv.loader.type : undefined, gameVersion: tv.mcVersion });
        if (!vs.length) {
          A.mount(verList, A.emptyState({ iconName: 'box', title: '没有适用于该版本的文件', text: tv ? `${A.nm(p.title)} 暂不支持 ${A.nm(tv.mcVersion)}${tv.loader ? ` · ${(A.LOADERS[tv.loader.type] || {}).name}` : ''}` : '' }));
          return;
        }
        A.mount(verList, vs.slice(0, 30).map((v, i) => {
          const file = v.files.find((f) => f.primary) || v.files[0];
          const typeBadge = v.type === 'release' ? h('span.badge.ok', '正式') : v.type === 'beta' ? h('span.badge.warn', 'Beta') : h('span.badge.crit', 'Alpha');
          return h('div.list-row',
            h('div.body',
              h('div.title', h('span', A.nm(v.name || v.number)), typeBadge, i === 0 ? h('span.badge.accent', '最新') : null, v.manual ? A.sources.manualBadge(isPack ? t('res.packManualTip') : undefined) : null),
              h('div.sub', `${v.gameVersions.slice(-4).join(', ')}${v.gameVersions.length > 4 ? ' …' : ''} · ${v.loaders.join(', ')} · ${A.fmtDate(v.published)} · ${file ? A.fmtBytes(file.size) : ''}`)),
            h('div.actions', isPack ? packButton(v) : installButton(v)));
        }));
      } catch (e) {
        A.mount(verList, A.errInline('加载失败', e));
      }
    }
    loadVersions();
  }

  A.resources = { render };
})();
