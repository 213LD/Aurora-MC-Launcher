'use strict';
/* 一键修复：左边是全部游戏配置（上次崩溃过的标「推荐检测」排前面），右边对选中的配置做全面检测：
 * 运行环境（Java、内存、磁盘）→ Mod 兼容性 → 真的测试启动一次。环境问题在这里直接修，Mod 问题交给一键 Debug（它是修复的一个分支，原来的入口都保留） */
(function () {
  const { h, icon, api, state, on, $ } = A;

  let root;
  let selected = null;
  let overview = [];
  const results = new Map(); // id → { phase, steps, env, test, error, envChanges }

  const STEPS = [
    { id: 'java', label: 'Java', desc: '版本合不合适、装没装', ico: 'coffee' },
    { id: 'memory', label: '内存', desc: '分配得太多还是太少', ico: 'cpu' },
    { id: 'disk', label: '磁盘', desc: '游戏所在的盘还剩多少空间', ico: 'save' },
    { id: 'hardware', label: '硬件与显卡', desc: '显卡驱动新不新、电脑带不带得动现在的画质和 Mod', ico: 'monitor' },
    { id: 'files', label: '文件完整性', desc: '游戏本体（客户端、依赖库、资源）和 Mod 文件有没有缺失、损坏', ico: 'file' },
    { id: 'config', label: '设置与按键', desc: '游戏设置、Mod 配置文件有没有损坏，按键有没有冲突', ico: 'settings' },
    { id: 'mods', label: 'Mod 兼容性', desc: '缺前置、重复、加载器或版本不对、声明的冲突', ico: 'puzzle', modded: true },
    { id: 'test', label: '测试启动', desc: '真的启动一次，进主菜单后自动关掉，看日志和画面', ico: 'play' },
  ];

  const REASONS = { exited: '游戏没进主菜单就退出了', error: '游戏报错了', timeout: '等了 4 分钟还没进主菜单', missing: '游戏没能启动', cancelled: '已取消' };
  const reasonText = (t) => (t.issues[0] && t.issues[0].title) || REASONS[t.reason] || t.reason;
  const profileOf = (id) => state.installed.find((x) => x.id === id);
  const infoOf = (id) => overview.find((x) => x.id === id) || {};

  function sortedProfiles() {
    return [...state.installed].sort((a, b) => (infoOf(b.id).recommend - infoOf(a.id).recommend) || ((infoOf(b.id).lastPlayed || 0) - (infoOf(a.id).lastPlayed || 0)));
  }

  // ───────── 左边：配置列表 ─────────
  function listRow(v) {
    const o = infoOf(v.id);
    const r = results.get(v.id);
    const sub = [`Minecraft ${A.nm(v.mcVersion) || '?'}`, v.loader ? A.LOADERS[v.loader.type] && A.LOADERS[v.loader.type].name : '原版'].filter(Boolean).join(' · ');
    const badge = r && r.phase === 'running' ? h('span.badge.info', h('span.spinner.xs'), '检测中')
      : r && r.phase === 'done' ? (verdict(r).level === 'ok' ? h('span.badge.ok', icon('check', 12), '已检测') : h('span.badge.warn', icon('alert', 12), '有问题'))
        : o.recommend ? h('span.badge.crit', icon('alert', 12), '推荐检测')
          : null;
    const state2 = o.recommend ? `上次崩溃 · ${A.fmtRelative(o.crashAt)}${o.reason ? ` · ${o.reason}` : ''}`
      : o.lastPlay ? `上次正常 · ${A.fmtRelative(o.lastPlay.at)}` : '还没玩过';
    return h('button', { type: 'button', class: `rp-item ${selected === v.id ? 'on' : ''} ${o.recommend ? 'warn' : ''}`, onclick: () => { selected = v.id; render(); } },
      h('img', { src: A.versionIcon(v), alt: '' }),
      h('div.rp-item-body', h('div.rp-item-name', A.noTr(A.displayName(v))), h('div.faint', sub), h('div', { class: `rp-item-state ${o.recommend ? 'crit' : ''}` }, state2)),
      badge);
  }

  // ───────── 右边：检测 ─────────
  function verdict(r) {
    if (r.error) return { level: 'crit', title: `检测出错：${r.error}` };
    const env = (r.env && r.env.items) || [];
    const crit = env.filter((i) => A.level(i.severity) === 'crit').length + (r.test && !r.test.ok && r.test.reason !== 'interrupted' ? 1 : 0);
    const warn = env.filter((i) => A.level(i.severity) === 'warn').length + (r.test && r.test.warn ? 1 : 0);
    if (r.test && r.test.reason === 'interrupted') return { level: 'warn', title: '测试启动被中断', text: '提前关掉了游戏窗口。可以重新检测' };
    if (!crit && !warn) return { level: 'ok', title: '没有发现问题，游戏可以正常进入主菜单' };
    return { level: crit ? 'crit' : 'warn', title: `发现 ${crit + warn} 个问题`, text: crit ? '先点「全部修复」：能直接改的设置马上改好，Mod 的问题交给一键 Debug 自动排查' : '都是提醒，不影响启动；可以按需处理' };
  }

  function stepState(r, s) {
    if (!r) return 'idle';
    const st = r.steps[s.id];
    return st || 'idle';
  }

  function stepRow(r, s, v) {
    if (s.modded && !v.loader) return null;
    const st = stepState(r, s);
    const items = r && r.env ? r.env.items.filter((i) => i.area === s.id) : [];
    let note = s.desc;
    if (s.id === 'test' && r && r.test) note = r.test.ok ? (r.test.warn ? '能进游戏，但有提示' : `通过，${Math.round(r.test.duration / 1000)} 秒进入主菜单`) : r.test.reason === 'interrupted' ? '被中断' : `失败：${reasonText(r.test)}${r.test.exitCode ? `（退出代码 ${r.test.exitCode}）` : ''}`;
    else if (s.id === 'test' && st === 'skip') note = r.skipNote || '跳过';
    else if (s.id === 'test' && st === 'running') note = r.testDetail || '正在启动游戏…';
    else if (items.length && st !== 'running') {
      const bad = items.filter((i) => ['crit', 'warn'].includes(A.level(i.severity)));
      const other = items.find((i) => A.level(i.severity) === 'info') || items[0];
      note = bad.length ? (bad.length > 1 ? `${bad.length} 个问题：${bad[0].title}…` : bad[0].title) : other.title;
    }
    const ico = st === 'running' ? h('span.spinner.sm') : st === 'ok' ? icon('checkCircle', 18) : st === 'warn' ? icon('alert', 18) : st === 'crit' ? icon('xCircle', 18) : st === 'skip' ? icon('minus', 18) : icon(s.ico, 18);
    return h('div', { class: `rp-step ${st}` }, h('span.rp-step-ico', ico), h('div', h('b', s.label), h('div.faint', note)));
  }

  function levelOf(items) {
    if (items.some((i) => A.level(i.severity) === 'crit')) return 'crit';
    if (items.some((i) => A.level(i.severity) === 'warn')) return 'warn';
    return 'ok';
  }

  async function runCheck(v) {
    const r = { phase: 'running', steps: {}, env: null, test: null, error: null, envChanges: (results.get(v.id) || {}).envChanges || [] };
    results.set(v.id, r);
    for (const s of STEPS) if (!s.modded || v.loader) r.steps[s.id] = s.id === 'test' ? 'idle' : 'running';
    render();
    try {
      r.env = await api('repair:env', v.id);
      for (const s of STEPS) if (s.id !== 'test' && r.steps[s.id]) r.steps[s.id] = levelOf(r.env.items.filter((i) => i.area === s.id));
      // Java 都没有 / 指定的不存在时，测试启动注定失败：先修 Java
      const javaBlock = r.env.items.find((i) => ['java-none', 'java-missing'].includes(i.type));
      // 测试启动要用账户（离线账户就行）：没有时先让玩家加一个，不报错
      if (!A.currentAccount()) {
        r.env.items.push({ severity: 'crit', type: 'no-account', area: 'account', title: '还没有账户，没法测试启动', detail: '添加一个账户（离线账户就行，不用登录）后点「重新检测」', fix: { kind: 'go-accounts', label: '添加账户' } });
      }
      if (javaBlock) { r.steps.test = 'skip'; r.skipNote = '先修好 Java 再测试启动'; }
      else if (!A.currentAccount()) { r.steps.test = 'skip'; r.skipNote = '先添加账户再测试启动'; }
      else {
        r.steps.test = 'running';
        render();
        r.test = await api('troubleshoot:test', v.id);
        r.steps.test = r.test.ok ? (r.test.warn ? 'warn' : 'ok') : r.test.reason === 'interrupted' ? 'warn' : 'crit';
      }
    } catch (e) {
      r.error = e.cancelled ? '已取消' : e.message;
      for (const k of Object.keys(r.steps)) if (r.steps[k] === 'running' || r.steps[k] === 'idle') r.steps[k] = 'skip';
    }
    r.phase = 'done';
    loadOverview();
    render();
  }

  /** 全部修复：先改能直接改的设置（Java、内存），再把 Mod 的问题交给一键 Debug */
  async function fixAll(v, r) {
    const env = r.env ? r.env.items : [];
    for (const i of env) {
      if (!i.fix) continue;
      if (i.fixed) continue;
      if (i.fix.auto === false) continue; // 不确定的（可能是 Mod 自己的格式）不进全部修复，要玩家自己点
      if (['java-auto', 'mem-auto', 'gfx-lower', 'quarantine'].includes(i.fix.kind)) await fixOne(v, r, i, false);
      else if (i.fix.kind === 'disable') { if (await A.disableFiles(i.fix.files, v.id)) i.fixed = true; }
      else if (i.fix.kind === 'complete') { await api('versions:complete', v.id); i.fixed = true; }
      else if (i.fix.kind === 'java-install') A.javaCheck.install(i.fix.component, i.fix.major);
    }
    const modProblem = env.some((i) => i.area === 'mods' && ['crit', 'warn'].includes(A.level(i.severity))) || (r.test && !r.test.ok && r.test.reason !== 'interrupted') || (r.test && r.test.warn);
    if (modProblem && v.loader) A.debugDialog(v, { auto: true, from: 'repair' });
    else { A.toast({ level: 'ok', title: '已修复', text: '可以点「重新检测」确认一下' }); render(); }
  }

  async function fixOne(v, r, item, rerender = true) {
    try {
      const before = await api('repair:fix', v.id, item.fix);
      r.envChanges.push({ title: item.fix.label, before });
      item.fixed = true;
      state.config = await api('config:get');
      A.emit('config', state.config);
      if (rerender) render();
    } catch (e) { A.errorToast('修复失败', e); }
  }

  async function undoEnv(v, r) {
    for (const c of [...r.envChanges].reverse()) await api('repair:undo', v.id, c.before);
    r.envChanges = [];
    state.config = await api('config:get');
    A.emit('config', state.config);
    A.toast({ level: 'ok', text: '已撤销设置改动' });
    render();
  }

  function envIssueList(v, r, items) {
    const wrap = h('div.issues');
    for (const i of items) {
      const lv = A.level(i.severity);
      const actions = h('div.issue-actions');
      if (i.fixed) actions.append(h('span.badge.ok', icon('check', 12), '已改'));
      else if (i.fix && i.fix.kind === 'go-accounts') actions.append(h('button.btn.sm.primary', { onclick: () => A.go('accounts', { add: true }) }, icon('users', 14), i.fix.label));
      else if (i.fix && i.fix.kind === 'open-url') actions.append(h('button.btn.sm', { onclick: () => api('shell:external', i.fix.url) }, icon('external', 14), i.fix.label));
      else if (i.fix && i.fix.kind === 'complete') actions.append(h('button.btn.sm.primary', { onclick: async (e) => { e.currentTarget.disabled = true; try { await api('versions:complete', v.id); i.fixed = true; A.toast({ level: 'info', text: '正在补全游戏文件，进度在下载管理里；完成后点「重新检测」' }); render(); } catch (err) { A.errorToast('补全失败', err); } } }, icon('download', 14), i.fix.label));
      else if (i.fix && i.fix.kind === 'disable') actions.append(h('button.btn.sm.primary', { onclick: async () => { if (await A.disableFiles(i.fix.files, v.id)) i.fixed = true; render(); } }, icon('x', 14), i.fix.label));
      else if (i.fix && ['java-auto', 'mem-auto', 'gfx-lower', 'unbind-keys', 'quarantine'].includes(i.fix.kind)) actions.append(h('button.btn.sm.primary', { onclick: () => fixOne(v, r, i) }, icon('wrench', 14), i.fix.label));
      else if (i.fix && i.fix.kind === 'java-install') actions.append(h('button.btn.sm.primary', { onclick: () => A.javaCheck.install(i.fix.component, i.fix.major) }, icon('download', 14), i.fix.label));
      // 推算的 / 认不出的标出来；认不出的自动修复不进「全部修复」，点之前要知道可能修不好
      const confTag = i.conf === 'inferred' ? h('span.badge.info', { 'data-tip': '按型号或版本号的规律推算，不是启动器认识的型号 / 版本' }, '推算')
        : i.conf === 'unknown' ? h('span.badge.warn', { 'data-tip': '启动器认不出，结果只是估计' }, '认不出') : null;
      const risky = i.conf === 'unknown' && i.fix && !i.fixed ? h('div.issue-detail', { style: { color: 'var(--warn)' } }, '启动器认不出这里的情况：自动修复可能修不好，甚至带来新问题，所以不在「全部修复」里，确认后再点') : null;
      wrap.append(h('div', { class: `issue ${lv}` }, h('div.issue-ico', A.levelIcon(lv, 18)),
        h('div.issue-body', h('div.issue-title', i.title, confTag ? ' ' : null, confTag), i.detail ? h('div.issue-detail', i.detail) : null, risky),
        actions.childElementCount ? actions : null));
    }
    return wrap;
  }

  function resultBlock(v, r) {
    const out = [];
    // 测试启动还在跑时先把已经查出来的问题列出来，结论等测试完再给
    if (r.phase === 'done') { const vd = verdict(r); out.push(A.alert({ level: vd.level, title: vd.title, text: vd.text || null })); }
    const env = r.env ? r.env.items : [];
    const envBad = env.filter((i) => i.area !== 'mods' && i.severity !== 'ok' && A.level(i.severity) !== 'ok');
    const modBad = env.filter((i) => i.area === 'mods' && i.severity !== 'ok' && A.level(i.severity) !== 'ok');
    if (envBad.length) out.push(h('div.rp-group', h('div.rp-group-title', '运行环境'), envIssueList(v, r, envBad)));
    if (modBad.length) out.push(h('div.rp-group', h('div.rp-group-title', 'Mod 兼容性'), A.modkit.issueList(modBad, { versionId: v.id, mc: v.mcVersion, onFixed: () => runCheckQuiet(v) })));
    if (r.test && !r.test.ok && r.test.reason !== 'interrupted' && !(r.test.issues && r.test.issues.length)) {
      out.push(h('div.rp-group', h('div.rp-group-title', '测试启动'), A.alert({ level: 'crit', title: reasonText(r.test), text: v.loader ? '日志里没找到明确的原因。点「全部修复」或「一键 Debug」会自动排查：根据日志修复，必要时二分找出有问题的 Mod' : '日志里没找到明确的原因，可以在日志窗口里看看最后几行', actions: [h('button.btn.sm', { onclick: () => A.logs.open(r.test.gameId) }, icon('terminal', 14), '看日志')] })));
    }
    if (r.test && !r.test.ok && r.test.issues && r.test.issues.length) out.push(h('div.rp-group', h('div.rp-group-title', '测试启动'), A.modkit.issueList(r.test.issues.slice(0, 8), { versionId: v.id, mc: v.mcVersion })));
    if (r.test && r.test.ok && (r.test.warn || (r.test.screen && r.test.screen.remembered))) { const nb = A.notices.block(r.test, { versionId: v.id, mc: v.mcVersion, showLog: true }); if (nb) out.push(nb); }
    if (r.envChanges.length) out.push(h('div.rp-changes', icon('history', 14), h('span', `改过的设置：${r.envChanges.map((c) => c.title).join('、')}`), h('button.btn.ghost.sm', { onclick: () => undoEnv(v, r) }, '撤销')));
    return out;
  }

  // Mod 问题单独处理完后只刷新静态检查，不再测试启动
  async function runCheckQuiet(v) {
    const r = results.get(v.id);
    if (!r || r.phase !== 'done') return;
    try {
      const env = await api('repair:env', v.id);
      r.env = env;
      for (const s of STEPS) if (s.id !== 'test' && r.steps[s.id]) r.steps[s.id] = levelOf(env.items.filter((i) => i.area === s.id));
      render();
    } catch { /* 下次重新检测时再看 */ }
  }

  function panel(v) {
    const r = results.get(v.id);
    const o = infoOf(v.id);
    const running = r && r.phase === 'running';
    const cancel = async () => { for (const tk of state.tasks.values()) if (tk.kind === 'test' && tk.status === 'running' && tk.meta.name === v.id) await api('tasks:cancel', tk.id); };
    const head = h('div.rp-head',
      h('img', { src: A.versionIcon(v), alt: '' }),
      h('div', { style: { flex: 1, minWidth: 0 } }, h('h2', A.nm(A.displayName(v))), h('div.faint', `Minecraft ${A.nm(v.mcVersion) || '?'}${v.loader ? ` · ${(A.LOADERS[v.loader.type] || {}).name || v.loader.type} · ${v.mods ? v.mods.enabled : 0} 个 Mod` : ' · 原版'}`)),
      running ? h('button.btn', { onclick: cancel }, icon('x', 16), '取消')
        : h('button.btn.primary', { onclick: () => runCheck(v) }, icon(r ? 'refresh' : 'shield', 16), r ? '重新检测' : '开始全面检测'));
    const recommend = !r && o.recommend ? A.alert({ level: 'warn', compact: true, title: '上次游玩崩溃了，推荐检测', text: `${A.fmtRelative(o.crashAt)}${o.reason ? `：${o.reason}` : ''}` }) : null;
    const intro = !r ? A.alert({ level: 'info', compact: true, text: `会依次检查下面几项，最后真的启动一次游戏，进入主菜单后自动关掉，不用手动退出。\n${A.t('test.dont')}` }) : null;
    const steps = h('div.rp-steps', STEPS.map((s) => stepRow(r, s, v)));
    const result = r && r.env ? resultBlock(v, r) : [];
    const vd = r && r.phase === 'done' ? verdict(r) : null;
    const actions = h('div.rp-actions',
      v.loader ? h('button.btn', { 'data-tip': '只排查 Mod：自动装前置、禁用冲突，必要时二分排查', onclick: () => A.debugDialog(v) }, icon('wrench', 16), A.t('term.debug')) : null,
      h('button.btn', { onclick: () => A.openVersionSettings(v) }, icon('settings', 16), '配置设置'),
      h('div.spacer'),
      vd && vd.level !== 'ok' && !r.error ? h('button.btn.primary', { onclick: () => fixAll(v, r) }, icon('wrench', 16), '全部修复') : null,
      vd && vd.level === 'ok' ? h('button.btn.primary', { onclick: () => A.launch(v.id) }, icon('play', 16), '启动游戏') : null);
    return h('div.rp-panel', head, recommend, intro, steps, ...result, actions);
  }

  function render() {
    if (!root) return;
    const list = sortedProfiles();
    if (!list.length) {
      A.mount(root, h('div.page-inner', pageHead(), A.emptyState({ img: A.blockImage('grass', 96), title: '还没有任何游戏配置', text: '先在「游戏配置」里新建一个，或者安装一个整合包' })));
      return;
    }
    if (!selected || !profileOf(selected)) selected = list[0].id;
    const v = profileOf(selected);
    A.mount(root, h('div.page-inner', pageHead(),
      h('div.rp-grid', h('div.rp-list', list.map(listRow)), panel(v))));
  }

  function pageHead() {
    const n = overview.filter((o) => o.recommend).length;
    return h('div.page-head',
      h('div', h('h1', A.t('nav.repair')), h('p', '选一个游戏配置做全面检测：Java、内存、磁盘、显卡与硬件、文件完整性、设置与按键、Mod 兼容性，最后真的测试启动一次。发现问题可以一键修复，Mod 的问题交给一键 Debug 自动排查')),
      n ? h('div.actions', h('span.badge.crit', icon('alert', 12), `${n} 个配置上次崩溃过`)) : null);
  }

  async function loadOverview() {
    try { overview = await api('repair:overview'); } catch { overview = []; }
    render();
  }

  function init() {
    root = $('#page-repair');
    on('installed', A.pageRefresher('repair', render));
    on('task', (t) => {
      if (t.kind !== 'test' || t.status !== 'running' || !t.meta) return;
      const r = results.get(t.meta.name);
      if (r && r.phase === 'running' && r.steps.test === 'running') { r.testDetail = t.detail; if (state.page === 'repair' && selected === t.meta.name) { const el = root.querySelector('.rp-step.running .faint'); if (el) el.textContent = t.detail || ''; } }
    });
  }

  A.pages.repair = {
    init,
    show: (p) => { if (p && p.versionId) selected = p.versionId; render(); loadOverview(); },
    title: '一键修复',
  };
})();
