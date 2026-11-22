'use strict';
/* Java 检测：没有 Java 时的提醒、装完游戏后检查、启动前检查指定的 Java、配置卡片上的「缺少 Java」小标签、配置抽屉里的提醒 */
(function () {
  const { h, icon, api, state, t } = A;

  /** 推荐安装的官方运行时：Java 21 能运行 1.17 ~ 1.21.x */
  const RECOMMENDED = 'java-runtime-delta';
  const MISMATCH = ['tooOld', 'tooNew', 'missing'];

  /** 已安装的 Java 里有没有自动选择会用的（和主进程 java.pick 的 strict 规则一致：Java 8 的版本只用 Java 8） */
  function hasFor(major, javas = state.javas || []) {
    if (javas.some((j) => j.major === major)) return true;
    return major > 8 && javas.some((j) => j.major > major);
  }

  /** 这个配置是不是自动选择 Java（配置里没指定，全局也是自动） */
  function isAuto(id) {
    const vs = ((state.config.versionSettings || {})[id] || {}).java;
    if (vs === 'auto') return true;
    if (vs && vs !== 'global') return false;
    return state.config.java.selected === 'auto';
  }

  const downloading = (major) => [...state.tasks.values()].some((x) => x.kind === 'java' && x.status === 'running' && x.title.includes(`Java ${major}`));

  async function install(component, major) {
    if (A.offline && !A.offline.check()) return false; // 离线模式下不能下载 Java（offline.js）
    if (downloading(major)) { A.toast({ level: 'info', text: t('java.alreadyDownloading', { n: major }) }); return; }
    try {
      await api('java:installMojang', component);
      A.toast({ level: 'info', text: t('java.downloading', { n: major }) });
    } catch (e) { A.errorToast(t('java.downloadFailed'), e); }
  }

  async function installFor(id) {
    try {
      const s = await api('java:status', id);
      await install(s.component, s.req.major);
    } catch (e) { A.errorToast(t('java.downloadFailed'), e); }
  }

  /** 手动选 java.exe，加进列表；取消时返回 false */
  async function pickExe() {
    const p = await api('dialog:file', t('java.pickTitle'), window.aurora.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : []);
    if (!p) return false;
    try {
      const j = await api('java:add', p);
      A.toast({ level: 'ok', text: t('java.added', { v: j.version }) });
      await A.refreshJavas(true).catch(() => {});
      return j;
    } catch (e) { A.errorToast(t('java.addFailed'), e); return false; }
  }

  /** 这个配置改用自动选择 Java（只改这个配置，不动全局） */
  async function useAuto(id) {
    await api('versions:setSettings', id, { java: 'auto' });
    state.config = await api('config:get');
    A.emit('config', state.config);
  }

  /** 指定的 Java 不合适时的说明文字 */
  function mismatchText(s, name) {
    const who = s.from === 'profile' ? t('java.whoProfile') : t('java.whoGlobal');
    if (s.problem === 'missing') return t('java.missingText', { who, path: A.nm(s.path) });
    if (s.problem === 'tooNew') return t('java.tooNewText', { name: A.nm(name), who, have: s.java.major });
    return t('java.tooOldText', { name: A.nm(name), who, need: s.req.major, have: s.java.major });
  }

  // ───────────── 配置卡片的小标签 ─────────────
  /** 自动选择 Java 的配置找不到合适的 Java 时显示；Java 列表还没扫完时不显示 */
  function badge(v) {
    if (!state.javas || v.broken || !isAuto(v.id)) return null;
    const major = v.javaMajor || 8;
    if (hasFor(major)) return null;
    const tip = state.config.java.autoDownload ? t('java.badgeTipAuto', { n: major }) : t('java.badgeTip', { n: major });
    return h('button.badge.warn.badge-btn', { 'data-tip': tip, onclick: (e) => { e.stopPropagation(); installFor(v.id); } }, icon('coffee', 12), t('java.badge', { n: major }));
  }

  // ───────────── 装完游戏、整合包、清单之后 ─────────────
  // 「需要 Java N」的提示带按钮，不会自己消失：有了合适的 Java，或者开始启动（启动时会自动下载）就收起来（1.10.5）
  let needToasts = [];
  function dropNeed(test) {
    needToasts = needToasts.filter((x) => { if (!test(x)) return true; x.close.dismiss(); return false; });
  }
  A.on('javas', () => dropNeed((x) => !x.mismatch && hasFor(x.major)));
  // 「指定的 Java 不合适」：换了 Java 或改回自动以后再查一次，合适了就收起
  const recheckMismatch = A.debounce(async () => {
    for (const x of needToasts.filter((y) => y.mismatch)) {
      const s = await api('java:status', x.id).catch(() => null);
      if (s && !MISMATCH.includes(s.problem)) dropNeed((y) => y === x);
    }
  }, 300);
  for (const ev of ['javas', 'config', 'installed']) A.on(ev, () => { if (needToasts.some((y) => y.mismatch)) recheckMismatch(); });
  function launching(id) { if (state.config.java.autoDownload) dropNeed((x) => x.id === id); }

  async function afterInstall(id) {
    let s;
    try { s = await api('java:status', id); } catch { return; }
    const name = A.displayName(state.installed.find((x) => x.id === id) || { id });
    if (s.problem === 'none') {
      const close = A.toast({
        level: 'warn', duration: 12000,
        title: t('java.needTitle', { n: s.req.major }),
        text: state.config.java.autoDownload ? t('java.needAuto', { name: A.nm(name) }) : t('java.needManual', { name: A.nm(name) }),
        actions: [{ label: t('java.downloadNow'), onClick: () => install(s.component, s.req.major) }],
      });
      needToasts.push({ id, major: s.req.major, close });
    } else if (MISMATCH.includes(s.problem)) {
      const close = A.toast({ level: 'warn', duration: 12000, title: t('java.mismatchTitle'), text: mismatchText(s, name), actions: [{ label: t('java.useAuto'), onClick: () => useAuto(id) }] });
      needToasts.push({ id, mismatch: true, close });
    }
  }

  // ───────────── 启动前 ─────────────
  /** 指定的 Java 不合适时先问一下；返回 false 表示不启动 */
  async function beforeLaunch(id) {
    let s;
    try { s = await api('java:status', id); } catch { return true; }
    if (!MISMATCH.includes(s.problem)) return true;
    const name = A.displayName(state.installed.find((x) => x.id === id) || { id });
    return new Promise((resolve) => {
      A.modal({
        title: t('java.mismatchTitle'),
        level: 'warn',
        size: 'sm',
        body: h('p.confirm-text', mismatchText(s, name)),
        actions: [
          { label: t('common.cancel'), kind: 'ghost', value: false },
          s.problem === 'missing' ? null : { label: t('java.launchAnyway'), value: true },
          { label: t('java.useAutoLaunch'), kind: 'primary', value: true, onClick: () => useAuto(id) },
        ].filter(Boolean),
        onClose: (v) => resolve(!!v),
      });
    });
  }

  // ───────────── 配置抽屉 ─────────────
  /** Java 下拉框下面的提醒；改了选择后调用 refresh() */
  function drawerNote(id) {
    const el = h('div');
    const refresh = async () => {
      let s;
      try { s = await api('java:status', id); } catch { A.clear(el); return; }
      const name = A.displayName(state.installed.find((x) => x.id === id) || { id });
      if (MISMATCH.includes(s.problem)) A.mount(el, A.alert({ level: 'warn', compact: true, text: mismatchText(s, name) }));
      else if (s.problem === 'none') {
        A.mount(el, A.alert({
          level: 'warn', compact: true,
          text: state.config.java.autoDownload ? t('java.needAuto', { name: A.nm(name) }) : t('java.needManual', { name: A.nm(name) }),
          actions: [h('button.btn.sm', { onclick: () => install(s.component, s.req.major) }, icon('download', 14), t('java.downloadNow'))],
        }));
      } else A.clear(el);
    };
    refresh();
    return { el, refresh };
  }

  // ───────────── 一个 Java 都没有 ─────────────
  /** 没有向导时（老用户）单独提醒一次；向导里的「Java」一步用 setup.js 自己的界面 */
  async function prompt() {
    if (state.config.tips && state.config.tips.noJava) return;
    const javas = state.javas || await A.refreshJavas(false).catch(() => null);
    if (!javas || javas.length) return;
    A.setConfig({ tips: { noJava: true } });
    A.modal({
      title: t('java.noneTitle'),
      level: 'warn',
      size: 'md',
      // 1.7.2：不替玩家选版本，只告诉玩家去 Java 页面下载；三个按钮：以后再说 / 手动选 java.exe / 前往 Java 页面
      body: h('div', h('p.confirm-text', t('java.noneTextPage')), h('p.faint', { style: { fontSize: '12.5px', margin: '10px 0 0' } }, t('java.laterDesc'))),
      actions: [
        { label: t('java.later'), kind: 'ghost' },
        { label: t('java.pickExe'), icon: 'folder', onClick: async () => (await pickExe()) !== false },
        { label: t('java.goPage'), kind: 'primary', icon: 'coffee', onClick: () => A.go('java') },
      ],
    });
  }

  A.javaCheck = { RECOMMENDED, hasFor, badge, afterInstall, beforeLaunch, launching, drawerNote, prompt, pickExe, install, installFor, useAuto };
})();
