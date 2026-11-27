'use strict';
/* Java 管理：检测、选择、下载（Mojang 官方运行时 / Eclipse Temurin / Microsoft Build of OpenJDK） */
(function () {
  const { h, icon, api, state, on, $ } = A;

  let root;
  let listEl;
  let rtEl;
  let runtimes = null;
  let temurinMajor = 21;
  let temurinType = 'jdk';
  let msMajor = 21;
  let scanning = false;

  function build() {
    root = $('#page-java');
    listEl = h('div.grid.auto');
    rtEl = h('div');
    const temurinBox = h('div');
    const renderTemurin = () => A.mount(temurinBox,
      h('div.row.wrap', { style: { gap: '12px' } },
        h('div.chips', [8, 11, 17, 21, 25].map((m) => h('button', { class: `chip ${temurinMajor === m ? 'on' : ''}`, onclick: () => { temurinMajor = m; renderTemurin(); } }, `Java ${m}`))),
        h('div.spacer'),
        A.seg([{ value: 'jdk', label: 'JDK' }, { value: 'jre', label: 'JRE' }], temurinType, (v) => { temurinType = v; }),
        h('button.btn.primary', { onclick: () => installTemurin() }, icon('download', 16), '下载')),
      h('div.faint', { style: { fontSize: '12px', marginTop: '10px' } }, 'JDK 包含完整开发工具（约 190 MB），JRE 仅包含运行环境（约 45 MB）。国内网络会优先尝试清华大学镜像。'));
    renderTemurin();
    // Microsoft Build of OpenJDK：只有 JDK，Java 11 起
    const msBox = h('div');
    const renderMs = () => A.mount(msBox,
      h('div.row.wrap', { style: { gap: '12px' } },
        h('div.chips', [11, 17, 21, 25].map((m) => h('button', { class: `chip ${msMajor === m ? 'on' : ''}`, onclick: () => { msMajor = m; renderMs(); } }, `Java ${m}`))),
        h('div.spacer'),
        h('button.btn.primary', { onclick: () => installMicrosoft() }, icon('download', 16), '下载')),
      h('div.faint', { style: { fontSize: '12px', marginTop: '10px' } }, '微软维护的 OpenJDK，只有 JDK（约 190 MB），没有 Java 8。从微软的服务器下载。'));
    renderMs();

    A.mount(root, h('div.page-inner',
      h('div.page-head',
        h('div', h('h1', 'Java 管理'), h('p', '启动器会根据版本自动选择合适的 Java，缺失时可自动下载')),
        h('div.actions',
          h('button.btn', { onclick: addManual }, icon('plus', 16), '手动添加'),
          h('button.btn', { onclick: () => scan(true) }, icon('refresh', 16), '重新扫描'))),
      h('div.card', { style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '22px' } },
        h('div', { style: { width: '42px', height: '42px', borderRadius: '12px', background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center' } }, icon('sparkles', 20)),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: 650 } }, '版本对应关系'),
          h('div.muted', { style: { fontSize: '12.5px' } }, '1.16.5 及更早 → Java 8　·　1.17 → Java 16　·　1.18 ~ 1.20.4 → Java 17　·　1.20.5 ~ 1.21.x → Java 21　·　26.1 起 → Java 25')),
        h('div.row', h('span.faint', { style: { fontSize: '12.5px' } }, '缺失时自动下载'), A.toggle(state.config.java.autoDownload, (v) => A.setConfig({ java: { autoDownload: v } })))),
      h('div.section-title', '已检测到的 Java', h('small', '点击「设为默认」后所有版本都会使用它（版本设置中可单独覆盖）')),
      listEl,
      h('div.section-title', '下载 Java'),
      h('div.grid.cols-2',
        h('div.card',
          h('div.row', { style: { marginBottom: '6px' } }, A.blockImage ? h('img', { src: A.blockImage('grass', 48), style: { width: '30px', height: '30px', imageRendering: 'pixelated' } }) : null,
            h('div', h('div', { style: { fontWeight: 700 } }, 'Mojang 官方运行时'), h('div.faint', { style: { fontSize: '12px' } }, '与官方启动器相同，推荐用于游戏')), h('div.spacer'), h('span.badge.accent', '推荐')),
          rtEl),
        h('div.card',
          h('div.row', { style: { marginBottom: '14px' } }, h('div', { style: { width: '30px', height: '30px', borderRadius: '8px', background: 'linear-gradient(135deg,#ff6a3d,#c2185b)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: '13px' } }, 'T'),
            h('div', h('div', { style: { fontWeight: 700 } }, 'Eclipse Temurin'), h('div.faint', { style: { fontSize: '12px' } }, 'Adoptium 提供的 OpenJDK 发行版'))),
          temurinBox),
        h('div.card',
          h('div.row', { style: { marginBottom: '14px' } }, h('div', { style: { width: '30px', height: '30px', borderRadius: '8px', background: 'linear-gradient(135deg,#00a4ef,#7fba00)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: '13px' } }, 'M'),
            h('div', h('div', { style: { fontWeight: 700 } }, 'Microsoft Build of OpenJDK'), h('div.faint', { style: { fontSize: '12px' } }, '微软提供的 OpenJDK 发行版'))),
          msBox))));
  }

  function renderList() {
    if (!listEl) return;
    if (scanning && !state.javas) {
      A.mount(listEl, [...Array(3)].map(() => h('div.skeleton', { style: { height: '170px', borderRadius: '18px' } })));
      return;
    }
    const javas = state.javas || [];
    const sel = state.config.java.selected;
    const autoCard = h('div', { class: `card java-card ${sel === 'auto' ? 'default' : ''}` },
      h('div.j-top',
        h('div.j-major', { style: { color: 'var(--accent)' } }, icon('zap', 24)),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div.j-title', '自动选择'), h('div.j-sub', '根据每个版本的需求挑选最合适的 Java'))),
      h('div.j-path', `${javas.length} 个可用的 Java · 推荐保持此选项`),
      h('div.j-actions', sel === 'auto' ? h('span.badge.accent', icon('check', 12), '当前默认') : h('button.btn.sm', { onclick: () => A.setConfig({ java: { selected: 'auto' } }) }, '设为默认')));
    if (!javas.length) {
      A.mount(listEl, autoCard, h('div.card', { style: { gridColumn: 'span 2', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '8px', color: 'var(--text-2)' } },
        icon('coffee', 34, 1.5), h('b', { style: { color: 'var(--text)' } }, '没有找到 Java'), h('span', { style: { fontSize: '13px' } }, '可以在下方一键下载，或启动游戏时自动下载')));
      return;
    }
    A.mount(listEl, autoCard, javas.map((j) => {
      const isDefault = sel === j.path || sel === j.javaw;
      const ours = j.source === 'Aurora 下载';
      return h('div', { class: `card java-card ${isDefault ? 'default' : ''}` },
        h('div.j-top',
          h('div.j-major', h('span', j.major)),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div.j-title', `Java ${j.major}`),
            h('div.j-sub.ellipsis', `${j.version} · ${j.vendor}`)),
          h('div.row.gap-s', h('span.badge', j.arch), h('span', { class: `badge ${j.isJdk ? 'info' : ''}` }, j.isJdk ? 'JDK' : 'JRE'))),
        h('div.j-path.selectable', j.home),
        h('div.j-actions',
          isDefault ? h('span.badge.accent', icon('check', 12), '当前默认') : h('button.btn.sm', { onclick: () => A.setConfig({ java: { selected: j.path } }) }, '设为默认'),
          h('button.btn.sm.ghost', { onclick: () => api('shell:open', j.home) }, icon('folder', 14), '打开'),
          h('div.spacer'),
          h('span.faint', { style: { fontSize: '11.5px', alignSelf: 'center' } }, j.source),
          ours ? h('button.btn.sm.icon.ghost', { 'data-tip': '卸载', onclick: () => uninstall(j) }, icon('trash', 14)) : null,
          j.source === '手动添加' ? h('button.btn.sm.icon.ghost', { 'data-tip': '从列表移除', onclick: async () => { await api('java:remove', j.path); scan(true); } }, icon('x', 14)) : null));
    }));
  }

  async function renderRuntimes() {
    if (!rtEl) return;
    if (!runtimes) {
      A.mount(rtEl, h('div.row', { style: { padding: '16px 0' } }, h('span.spinner'), h('span.muted', '正在获取官方运行时列表…')));
      try { runtimes = await api('java:runtimes'); } catch (e) {
        A.mount(rtEl, A.errInline('获取失败', e, { style: { padding: '10px 0' } }), h('button.btn.sm', { onclick: () => { runtimes = null; renderRuntimes(); } }, '重试'));
        return;
      }
    }
    const seen = new Set();
    const list = runtimes.filter((r) => { const k = r.major; if (seen.has(k) && !r.installed) return false; seen.add(k); return true; });
    A.mount(rtEl, list.map((r) => {
      const installing = [...state.tasks.values()].some((t) => t.kind === 'java' && t.status === 'running' && t.title.includes(r.name));
      return h('div.rt-row',
        h('div.rt-major', r.major || '?'),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 600, fontSize: '13.5px' } }, r.name), h('div.faint.ellipsis', { style: { fontSize: '11.5px' } }, `${r.component} · ${r.version}`)),
        r.installed ? h('span.badge.ok', icon('check', 12), '已安装')
          : h('button.btn.sm', { disabled: installing, 'data-net': '', onclick: async (e) => {
            // 按钮要先记下来：await 之后 e.currentTarget 已经是 null，失败了没法把按钮放开
            const b = e.currentTarget;
            b.disabled = true;
            try { await api('java:installMojang', r.component); A.toast({ level: 'info', text: `开始下载 ${r.name}` }); } catch (err) { b.disabled = false; A.errorToast('无法下载', err); }
          } }, icon('download', 14), installing ? '下载中' : '安装'));
    }));
  }

  async function installTemurin() {
    if (!A.offline.check()) return;
    try {
      await api('java:installTemurin', temurinMajor, temurinType);
      A.toast({ level: 'info', text: `开始下载 Temurin ${temurinMajor} ${temurinType.toUpperCase()}` });
    } catch (e) { A.errorToast('无法下载', e); }
  }

  async function installMicrosoft() {
    if (!A.offline.check()) return;
    try {
      await api('java:installMicrosoft', msMajor);
      A.toast({ level: 'info', text: `开始下载 Microsoft OpenJDK ${msMajor}` });
    } catch (e) { A.errorToast('无法下载', e); }
  }

  async function addManual() {
    const p = await api('dialog:file', '选择 java.exe 或 javaw.exe', window.aurora.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : []);
    if (!p) return;
    try {
      const j = await api('java:add', p);
      A.toast({ level: 'ok', text: `已添加 Java ${j.version}` });
      scan(true);
    } catch (e) { A.errorToast('添加失败', e); }
  }

  async function uninstall(j) {
    if (!(await A.confirm(`确定要卸载 Java ${j.version} 吗？\n${j.home}`, { danger: true, okText: '卸载' }))) return;
    try { await api('java:uninstall', j.home); A.toast({ level: 'ok', text: '已卸载' }); runtimes = null; scan(true); renderRuntimes(); } catch (e) { A.errorToast('卸载失败', e); }
  }

  async function scan(force) {
    scanning = true;
    if (force) { state.javas = null; renderList(); }
    try { await A.refreshJavas(force); } catch (e) { A.errorToast('扫描失败', e); }
    scanning = false;
    renderList();
  }

  function init() {
    build();
    const refresh = A.pageRefresher('java', renderList);
    on('javas', refresh);
    on('config', (c, changed) => { if (A.configMatters(changed)) refresh(); });
    A.listen('java:changed', () => { runtimes = null; scan(true); if (state.page === 'java') renderRuntimes(); });
    on('task', (t) => { if (t.kind === 'java' && state.page === 'java' && t.status !== 'running') renderRuntimes(); });
  }

  A.pages.java = { init, show: () => { renderList(); renderRuntimes(); if (!state.javas) scan(false); }, title: 'Java 管理' };
})();
