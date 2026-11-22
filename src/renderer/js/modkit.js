'use strict';
/* Mod 相关的共享组件：问题列表（含一键修复）、在线搜索选择器（Modrinth / CurseForge） */
(function () {
  const { h, icon, api, t } = A;

  const fileName = (p) => String(p || '').split(/[\\/]/).pop().replace(/\.disabled$/, '');

  /**
   * 渲染问题列表
   * @param {Array} issues
   * @param {{versionId:string, mc?:string, onFixed?:Function, compact?:boolean}} ctx
   */
  function issueList(issues, ctx = {}) {
    const wrap = h('div.issues');
    if (!issues || !issues.length) return wrap;
    for (const i of issues) {
      const lv = A.level(i.severity);
      const actions = h('div.issue-actions');
      const fix = i.fix || {};
      const run = async (btn, fn) => {
        btn.disabled = true;
        try { await fn(); } catch (e) { A.errorToast('操作失败', e); btn.disabled = false; return; }
        btn.textContent = '已处理';
        if (ctx.onFixed) setTimeout(ctx.onFixed, 300);
      };
      if (fix.kind === 'install-dep' && ctx.versionId) {
        const b = h('button.btn.sm.primary', { onclick: () => run(b, async () => { await api('mods:installDep', ctx.versionId, fix.modId, { ranges: fix.ranges || null, rangeKind: fix.rangeKind, update: !!fix.update }); A.toast({ level: 'info', text: fix.update ? `正在 Modrinth 上查找符合要求的 ${A.nm(fix.modId)}…` : `正在 Modrinth 上查找并安装 ${A.nm(fix.modId)}…` }); }) }, icon('download', 14), fix.ranges ? `换成合适版本的 ${A.nm(fix.modId)}` : fix.update ? `更新 ${A.nm(fix.modId)}` : `安装 ${A.nm(fix.modId)}`);
        actions.append(b);
      } else if (fix.kind === 'disable' && fix.files && fix.files.length && ctx.versionId) {
        const b = h('button.btn.sm', { onclick: () => run(b, () => A.disableFiles(fix.files, ctx.versionId)) }, icon('x', 14), fix.label || (fix.files.length > 1 ? `禁用 ${fix.files.length} 个文件` : `禁用 ${A.nm(fileName(fix.files[0]))}`));
        actions.append(b);
      } else if (fix.kind === 'choose' && fix.files && ctx.versionId) {
        for (const f of fix.files.slice(0, 2)) {
          const b = h('button.btn.sm', { onclick: () => run(b, () => A.disableFiles([f], ctx.versionId)) }, `禁用 ${A.nm(fileName(f))}`);
          actions.append(b);
        }
      } else if (fix.kind === 'tweak' && ctx.versionId) {
        // 改 Mod 自己的开关关掉提示画面（例如 BetterX 的欢迎页）
        const b = h('button.btn.sm.primary', { onclick: () => run(b, async () => { await api('troubleshoot:tweak', ctx.versionId, fix.tweak); A.toast({ level: 'ok', text: t('notice.tweakDone') }); }) }, icon('eyeOff', 14), t('notice.tweakBclib'));
        actions.append(b);
      } else if (fix.kind === 'java-retest' && ctx.versionId) {
        // Mod 需要更高版本的 Java：临时用 Java N 再测一次（javaretest.js）
        actions.append(h('button.btn.sm.primary', { onclick: () => A.javaRetest(ctx.versionId, fix.major, { onDone: ctx.onFixed }) }, icon('coffee', 14), t('java.retest', { n: fix.major })));
      } else if (fix.kind === 'install-loader' && ctx.mc) {
        actions.append(h('button.btn.sm.primary', { onclick: () => A.installDialog(ctx.mc) }, '安装加载器'));
      }
      wrap.appendChild(h('div', { class: `issue ${lv}` },
        h('div.issue-ico', A.levelIcon(lv, 18)),
        h('div.issue-body', h('div.issue-title', i.title), i.detail ? h('div.issue-detail', i.detail) : null,
          // 提示的英文原文折叠在下面
          i.raw ? h('details.issue-raw', h('summary', t('notice.raw')), h('pre', { 'data-no-tr': '' }, i.raw)) : null),
        actions.childElementCount ? actions : null));
    }
    return wrap;
  }

  function summaryChip(issues) {
    const e = issues.filter((i) => A.level(i.severity) === 'crit').length;
    const w = issues.filter((i) => A.level(i.severity) === 'warn').length;
    if (!e && !w) return h('span.badge.ok', icon('check', 12), '未发现问题');
    return h('span.row.gap-s', e ? h('span.badge.crit', icon('xCircle', 12), `${e} 个严重问题`) : null, w ? h('span.badge.warn', icon('alert', 12), `${w} 个警告`) : null);
  }

  /**
   * 在线搜索 Mod 的选择器
   * mode = 'install'：直接安装到 versionId，可以切换来源（Modrinth / CurseForge）；exclude / excludeCf 是两边已经装了的项目
   * mode = 'select'：回调 onPick(project)，只用 Modrinth（配置器和额外 Mod 按 Modrinth 项目分析）
   */
  function modrinthPicker({ mc, loader, versionId, mode = 'install', title = '从 Modrinth 添加 Mod', exclude = new Set(), excludeCf = new Set(), onPick }) {
    let seq = 0;
    let source = mode === 'install' ? A.sources.current() : 'modrinth';
    const list = h('div.picker-list');
    const more = h('div.row', { style: { justifyContent: 'center', marginTop: '10px' } });
    const matchEl = h('div.mn-match');
    const input = h('input.input', { placeholder: '搜索 Mod，英文名或常见中文名 / 缩写，例如 Sodium、JEI、机械动力…', spellcheck: 'false' });
    let picked = null; // 中文名匹配到多个时，玩家点选的那个
    const sort = A.select({ options: [{ value: 'relevance', label: '相关度' }, { value: 'downloads', label: '下载量' }, { value: 'updated', label: '最近更新' }], value: 'relevance', small: true, width: 120, onChange: () => run() });
    const sourceSeg = mode === 'install' ? A.sources.seg(source, (v) => { source = v; A.sources.set(v); run(); }) : null;
    const added = new Set();

    let offset = 0;
    async function run(append = false) {
      const my = ++seq;
      const S = A.sources.get(source);
      const have = source === 'curseforge' ? excludeCf : exclude;
      if (!append) { offset = 0; A.mount(list, h('div.row', { style: { justifyContent: 'center', padding: '30px' } }, h('span.spinner'))); }
      A.mount(more, append ? h('span.spinner') : null);
      // 中文名 / 缩写：先查本地对照表，换成英文名再搜；没查到的中文用 MC 百科（开着时自动，关着时可以「查一次」）
      if (!append && A.modNames.expand(input.value).missed && A.mcmodUi.on()) A.mount(matchEl, h('span.row.gap-s', h('span.spinner'), h('span.faint', '本地对照表没有，正在查 MC 百科…')));
      const ex = await A.mcmodUi.resolveQuery(input.value);
      if (my !== seq) return;
      const query = picked || ex.query;
      if (!append) A.mount(matchEl, A.mcmodUi.matchBar(ex, query, (en) => { picked = en; run(); }, () => run()));
      try {
        const r = await S.search({ query, type: 'mod', loader, gameVersion: mc, sort: sort.getValue(), offset, limit: 20 });
        if (my !== seq) return;
        if (!append && !r.hits.length) { A.mount(list, A.emptyState({ iconName: 'search', title: '没有找到匹配的 Mod', text: mc ? `仅显示支持 ${mc}${loader ? ` · ${(A.LOADERS[loader] || {}).name}` : ''} 的结果` : '' })); A.clear(more); return; }
        offset += r.hits.length;
        const total = r.total || 0;
        A.mount(more, r.hits.length && offset < total
          ? h('button.btn.sm', { onclick: () => run(true) }, `加载更多（已显示 ${offset} / ${A.fmtNum(total)}）`)
          : h('span.faint', `共 ${offset} 个结果`));
        const rows = r.hits.map((p) => {
          const key = `${source}:${p.id}`;
          const already = have.has(p.id) || added.has(key);
          const btn = h('button', { class: `btn sm ${already ? '' : 'primary'}`, disabled: already }, already ? '已添加' : mode === 'install' ? '安装' : '添加');
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              if (mode === 'install') {
                const v = A.sources.best(await S.versions(p.id, { loader, gameVersion: mc, type: 'mod' }));
                if (!v) throw new Error(`${A.nm(p.title)} 没有适用于 ${mc} 的版本`);
                await S.install({ versionId, projectVersion: v, kind: 'mod', title: p.title, withDeps: true });
                A.toast({ level: 'info', text: `开始下载 ${A.nm(p.title)}` });
              } else if (onPick) {
                await onPick(p);
              }
              added.add(key);
              btn.textContent = mode === 'install' ? '已开始' : '已添加';
              btn.className = 'btn sm';
            } catch (e) { btn.disabled = false; A.errorToast('添加失败', e); }
          });
          return h('div.picker-row',
            h('img', { src: p.icon || A.blockImage('unknown', 64), loading: 'lazy', onerror: (e) => { e.target.src = A.blockImage('unknown', 64); } }),
            h('div.p-body',
              h('div.p-title', h('b.mn-zh', { 'data-key': A.mcmodUi.keyOf({ source, slug: p.slug, id: p.id }) }, A.modNames.zhOf(p) ? `${A.modNames.zhOf(p)} ` : ''), h(A.modNames.zhOf(p) ? 'span' : 'b', A.nm(p.title)), h('span.faint', ` · ${A.fmtNum(p.downloads)} 下载`), p.allowDistribution === false ? A.sources.manualBadge() : null),
              h('div.p-desc', A.nm(p.description))),
            btn);
        });
        if (append) rows.forEach((el) => list.appendChild(el)); else A.mount(list, rows);
        // MC 百科缓存里有中文名的用百科的译名（比本地对照表优先，1.6.1；只读缓存，不联网）
        const zhMap = await A.mcmodUi.cachedMap(r.hits.map((p) => A.mcmodUi.projOf(p, source)));
        list.querySelectorAll('.mn-zh').forEach((el) => { const i = zhMap.get(el.dataset.key); if (i) A.mcmodUi.setZh(el, i.zh); });
      } catch (e) {
        if (my !== seq) return;
        if (append) A.mount(more, h('button.btn.sm', { onclick: () => run(true) }, '加载失败，重试'));
        else { A.clear(more); A.mount(list, A.emptyState({ iconName: 'xCircle', title: '搜索失败', text: e.message, action: A.sources.setupAction(e) })); }
      }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    input.addEventListener('input', () => { picked = null; });
    input.addEventListener('input', A.debounce(() => run(), 450));
    const m = A.modal({
      title,
      subtitle: mc ? `Minecraft ${mc}${loader ? ` · ${(A.LOADERS[loader] || {}).name}` : ''}` : '',
      icon: 'globe',
      size: 'lg',
      body: h('div', h('div.row', { style: { marginBottom: '12px' } }, sourceSeg, h('div.input-wrap', { style: { flex: 1 } }, icon('search', 16), input), sort), matchEl, list, more),
      actions: [{ label: t('common.close'), kind: 'primary' }],
    });
    run();
    return m;
  }

  /** 批量禁用 Mod：没禁用成的（文件被占着等）提示玩家，返回是不是全部成功（1.10.8） */
  A.disableFiles = async (files, versionId) => {
    const r = await api('mods:disableFiles', files, versionId);
    const failed = (r && r.failed) || [];
    if (failed.length) A.toast({ level: 'warn', title: `有 ${failed.length} 个 Mod 没禁用成`, text: `${A.nmJoin(failed.map((f) => f.file))}。可能正被占着，关掉占用它的程序后再试` });
    return !failed.length;
  };

  A.modkit = { issueList, summaryChip, modrinthPicker, fileName };
})();
