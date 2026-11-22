'use strict';
/**
 * 主页右上角的更新日志面板：「Minecraft」（官方更新日志，联网）和「启动器」（changelog.js）两个标签。
 * config.news = { enabled, open, tab, seenLauncher }（规则）：
 * - enabled 是总开关（设置页）：关掉后面板、收起后的「更新日志」小按钮、红点全都不显示
 * - open 只是展开 / 收起：面板上的按钮收起后留下小按钮，点它再展开
 * - 启动器版本和 seenLauncher 不同时，小按钮和「启动器」标签上有红点；看过「启动器」标签后消失
 * 用法：const np = A.newsPanel(); 把 np.panel、np.pill 放进页面；np.render() 在进入主页和配置变化时调用
 */
(function () {
  const { h, icon, api, state, t } = A;
  // 「启动器」更新日志只写简中，英文、繁中界面不显示这个标签，也没有红点
  const zhUi = () => !window.I18N || window.I18N.getLang() === 'zh-CN';
  const TABS = () => (zhUi() ? ['mc', 'launcher'] : ['mc']);

  function create() {
    let mcNews = null;
    let loading = false;
    const list = h('div.news-list');
    const tabs = h('div.news-tabs', { role: 'tablist', 'aria-label': t('news.title') });
    const refreshBtn = h('button.news-btn', { 'data-tip': t('news.refresh'), 'data-net': '', onclick: () => loadMc(true) }, icon('refresh', 14));
    const panel = h('div.news.hidden',
      h('div.news-head', tabs, h('span.row.gap-s', refreshBtn,
        h('button.news-btn', { 'data-tip': t('news.collapse'), onclick: () => setNews({ open: false }) }, icon('eyeOff', 14)))),
      list);
    const dot = h('i.news-dot.hidden');
    const pill = h('button.news-show.hidden', { onclick: openFromPill }, icon('eye', 14), t('news.title'), dot);

    const cfg = () => ({ enabled: true, open: false, tab: 'mc', seenLauncher: '', ...(state.config.news || {}) });
    const version = () => (state.info && state.info.version) || '';
    const unseen = () => { const n = cfg(); return zhUi() && n.enabled && !!version() && n.seenLauncher !== version(); };
    const setNews = (patch) => A.setConfig({ news: patch });

    /** 小按钮：有红点时直接打开「启动器」标签 */
    function openFromPill() {
      setNews(unseen() ? { open: true, tab: 'launcher' } : { open: true });
    }

    function render() {
      // 性能模式、简洁模式不显示更新日志，也不去拉取
      const n = (A.simple && A.simple.on()) || (A.perf && A.perf.on()) ? { ...cfg(), enabled: false } : cfg();
      panel.classList.toggle('hidden', !n.enabled || !n.open);
      pill.classList.toggle('hidden', !n.enabled || n.open);
      dot.classList.toggle('hidden', !unseen());
      pill.setAttribute('aria-label', unseen() ? `${t('news.title')}（${t('news.newLauncher')}）` : t('news.title'));
      if (!n.enabled || !n.open) return;
      const tab = TABS().includes(n.tab) ? n.tab : 'mc';
      A.mount(tabs, TABS().map((id) => h('button', {
        type: 'button', role: 'tab', class: `news-tab ${tab === id ? 'on' : ''}`, 'aria-selected': String(tab === id),
        onclick: () => { if (id !== tab) setNews({ tab: id }); },
      }, t(`news.tab.${id}`), id === 'launcher' && unseen() ? h('i.news-dot') : null)));
      refreshBtn.classList.toggle('hidden', tab !== 'mc');
      if (tab === 'launcher') {
        renderLauncher();
        if (unseen()) setNews({ seenLauncher: version() });
      } else loadMc(false);
    }

    // ── Minecraft 官方更新日志 ──
    async function loadMc(force) {
      if (mcNews && !force) { renderMc(); return; }
      if (loading) return;
      loading = true;
      A.mount(list, [0, 1, 2].map(() => h('div.skeleton', { style: { height: '80px', borderRadius: '15px', opacity: 0.4 } })));
      try {
        mcNews = await api('news:list');
        if (cfg().tab !== 'launcher') renderMc();
      } catch {
        if (cfg().tab !== 'launcher') A.mount(list, h('div.news-card', { style: { justifyContent: 'center', padding: '20px' } }, h('span', { style: { opacity: 0.7, fontSize: '12.5px' } }, t('news.loadFailed'))));
      } finally {
        loading = false;
      }
    }

    function renderMc() {
      A.mount(list, (mcNews || []).slice(0, 6).map((n) => h('div.news-card', { onclick: () => openMc(n) },
        h('img', { src: n.image, alt: '', loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
        h('div.n-body',
          h('div', { class: `n-type ${n.type}` }, n.type === 'release' ? '正式版' : n.type === 'snapshot' ? '快照' : n.type),
          h('div.n-title', n.title),
          h('div.n-sub', `${A.fmtDate(n.date)} · ${n.summary}`)))));
    }

    async function openMc(n) {
      const body = h('div.md-body', h('div.row', { style: { justifyContent: 'center', padding: '40px' } }, h('span.spinner.lg')));
      const installed = state.installed.some((v) => v.mcVersion === n.version);
      const inManifest = state.manifest && state.manifest.versions.some((v) => v.id === n.version);
      A.modal({
        title: n.title,
        subtitle: A.fmtDate(n.date),
        size: 'lg',
        body,
        actions: [
          inManifest && !installed ? { label: `安装 ${n.version}`, kind: 'primary', icon: 'download', onClick: () => A.go('download', { install: n.version }) } : null,
          { label: '关闭', kind: 'ghost' },
        ].filter(Boolean),
      });
      try {
        const d = await api('news:body', n.contentPath);
        A.mount(body, d.image ? h('img', { src: d.image, style: { width: '100%', borderRadius: '14px', marginBottom: '8px' } }) : null, A.sanitize(d.body));
      } catch (e) {
        A.mount(body, h('p', `加载失败：${e.message}`));
      }
    }

    // ── 启动器更新日志 ──
    const PREVIEW = 3;
    // 更新日志按内部版的版本号写；公开版显示成公开版的版本号（2.0.0 → 1.0.0）
    const shownV = (v) => (state.info && state.info.edition === 'public' ? window.EDITION.toPublic(v) : v);
    function renderLauncher() {
      const cur = version();
      A.mount(list, A.changelog().map((e) => h('div.news-card.cl-card', { onclick: () => openLauncher(e) },
        h('div.n-body',
          h('div.cl-head', h('b', `v${shownV(e.v)}`), e.date ? h('span', e.date) : null, shownV(e.v) === cur ? h('span.cl-cur', t('news.current')) : null),
          h('ul.cl-items', e.items.slice(0, PREVIEW).map((s) => h('li', s))),
          e.items.length > PREVIEW ? h('div.cl-more', t('news.more', { n: e.items.length - PREVIEW })) : null))));
    }

    function openLauncher(e) {
      A.modal({
        title: t('news.launcherTitle', { name: A.BRAND.short, v: shownV(e.v) }),
        subtitle: e.date || null,
        icon: 'sparkles',
        size: 'md',
        body: h('ul.cl-full', e.items.map((s) => h('li', s))),
        actions: [{ label: '关闭', kind: 'ghost' }],
      });
    }

    return { panel, pill, render };
  }

  A.newsPanel = create;
})();
