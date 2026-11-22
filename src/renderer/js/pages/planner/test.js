'use strict';
/* Mod 配置器：第 4 步：测试和排查 */
(function () {
  const { h, icon, api, state } = A;
  const K = A.plannerKit;
  const { newPlan } = K;
  const { P, save } = K;

  async function runCheck() {
    const id = P.plan && P.plan.profileId;
    if (!id) return;
    P.check = 'loading';
    if (P.step === 4) renderTest();
    try { P.check = await api('mods:check', id); } catch (e) { P.check = { issues: [], error: e.message }; }
    if (P.step === 4) renderTest();
  }

  async function runTest() {
    const id = P.plan.profileId;
    P.testing = true; P.test = null;
    renderTest();
    try {
      P.test = await api('troubleshoot:test', id);
    } catch (e) {
      if (!e.cancelled) P.test = { ok: false, reason: 'launch-error', error: e.message, issues: [] };
    }
    P.testing = false;
    renderTest();
    if (P.test && P.test.ok) A.toast(P.test.warn ? { level: 'warn', title: A.t('test.passWarn'), text: P.test.notices.find((n) => n.severity === 'warn').title } : { level: 'ok', title: '测试通过', text: '游戏成功进入了主菜单' });
  }

  async function runBisect() {
    const id = P.plan.profileId;
    const ok = await A.confirm(`${A.t('term.bisect')}会多次启动游戏：每轮禁用一半的 Mod，观察是否还会崩溃，从而定位出问题的 Mod。\n\n· 每轮约 30 秒 ~ 2 分钟，期间会弹出游戏窗口\n· 排查结束后会恢复所有 Mod 的启用状态\n· 可以随时在右上角的任务面板中取消\n\n${A.t('test.how')}\n${A.t('test.dont')}`, { title: `开始${A.t('term.bisect')}`, okText: '开始排查', level: 'info', size: 'md' });
    if (!ok) return;
    P.bisecting = true; P.bisect = null; P.rounds = [];
    renderTest();
    try {
      P.bisect = await api('troubleshoot:bisect', id);
    } catch (e) {
      if (e.reason && e.reason.code === 'TEST_INTERRUPTED') P.bisect = { status: 'interrupted', rounds: P.rounds.filter((r) => r.ok !== undefined) };
      else if (!e.cancelled) A.errorToast('排查失败', e);
    }
    P.bisecting = false;
    renderTest();
  }

  function liveDetail(kind) {
    const id = P.plan.profileId;
    const t = [...state.tasks.values()].reverse().find((x) => x.kind === 'test' && x.meta && x.meta.name === id && x.status === 'running');
    return t ? t.detail : kind;
  }

  function renderTest() {
    const p = P.plan;
    const v = p.profileId && state.installed.find((x) => x.id === p.profileId);
    if (!v) {
      const candidates = state.installed.filter((x) => x.loader);
      A.mount(K.body,
        h('div.card', { style: { textAlign: 'center', padding: '36px' } },
          h('div', { style: { color: 'var(--text-3)', marginBottom: '8px' } }, icon('box', 40, 1.5)),
          h('h3', { style: { margin: '0 0 6px' } }, '还没有可以测试的配置'),
          h('p.muted', { style: { margin: '0 0 16px' } }, '先完成安装，或者选择一个已有的 Mod 配置进行排查'),
          h('div.row', { style: { justifyContent: 'center' } },
            !p.troubleshootOnly ? h('button.btn.primary', { onclick: () => K.goStep(3) }, '前往安装') : null,
            candidates.length ? A.select({ options: candidates.map((x) => ({ value: x.id, label: A.nm(A.displayName(x)), sub: A.versionSub(x) })), value: null, placeholder: '选择已有配置…', width: 260, onChange: (id) => { troubleshootProfile(id); } }) : null)));
      return;
    }

    // 静态检查
    const checkBody = P.check === 'loading' || !P.check
      ? h('div.row', h('span.spinner'), h('span.muted', '正在分析 Mod 元数据…'))
      : P.check.issues.length
        ? A.modkit.issueList(P.check.issues, { versionId: v.id, mc: v.mcVersion, onFixed: runCheck })
        : A.alert({ level: 'ok', compact: true, text: `${P.check.count} 个 Mod 的前置完整、加载器匹配，没有声明的冲突` });

    // 测试启动
    let testBody;
    if (P.testing) {
      testBody = h('div.testing', h('span.spinner.lg'), h('div', h('b', '正在测试启动…'), h('div.faint', { style: { fontSize: '12.5px' } }, liveDetail('准备中…'))));
    } else if (P.test) {
      const t = P.test;
      const interrupted = t.reason === 'interrupted';
      const reasonText = { success: '游戏成功进入了主菜单', interrupted: A.t('test.interruptedHint'), error: '加载 Mod 时出现错误', exited: `游戏意外退出（代码 ${t.exitCode}）`, timeout: '超时：游戏在规定时间内没有进入主菜单', 'launch-error': t.error || '启动失败' }[t.reason] || t.reason;
      testBody = h('div',
        A.alert({
          // 三种结果：通过 / 通过但有提示 / 未通过
          level: t.ok ? (t.warn ? 'warn' : 'ok') : interrupted ? 'warn' : 'crit',
          title: t.ok ? (t.warn ? A.t('test.passWarn') : '测试通过') : interrupted ? A.t('test.interrupted') : '测试未通过',
          text: interrupted ? reasonText : `${t.warn ? A.t('test.passWarnText') : reasonText}${t.duration ? ` · 用时 ${Math.round(t.duration / 1000)} 秒` : ''}`,
          actions: [
            interrupted ? h('button.btn.sm', { onclick: runTest }, icon('refresh', 14), A.t('test.retry')) : null,
            t.gameId ? h('button.btn.sm', { onclick: () => A.logs.open(t.gameId) }, icon('terminal', 14), '查看日志') : null,
          ].filter(Boolean),
        }),
        t.ok ? A.notices.block(t, { versionId: v.id, mc: v.mcVersion, onFixed: () => { runCheck(); } }) : null,
        !t.ok && t.issues && t.issues.length ? h('div', h('div.faint', { style: { fontSize: '12.5px', marginBottom: '8px' } }, '根据日志分析出的可能原因：'), A.modkit.issueList(t.issues, { versionId: v.id, mc: v.mcVersion, onFixed: () => { runCheck(); } })) : null,
        !t.ok && !interrupted && (!t.issues || !t.issues.length) ? h('p.muted', { style: { fontSize: '13px', margin: 0 } }, `日志中没有找到明确的原因，可以使用下方的${A.t('term.bisect')}来定位问题 Mod。`) : null);
    } else {
      testBody = h('p.muted', { style: { margin: 0, fontSize: '13px', whiteSpace: 'pre-line' } }, `启动器会以测试模式启动一次游戏，检测能否顺利进入主菜单，并分析日志中的错误。\n${A.t('test.how')}\n${A.t('test.dont')}`);
    }

    // 二分排查
    let bisectBody;
    if (P.bisecting) {
      bisectBody = h('div',
        h('div.testing', h('span.spinner.lg'), h('div', h('b', `正在排查…${P.rounds.length ? `第 ${P.rounds.length} 轮` : ''}`), h('div.faint', { style: { fontSize: '12.5px' } }, liveDetail('准备中…')))),
        roundsList());
    } else if (P.bisect) {
      const b = P.bisect;
      const culprits = b.culprits || (b.culprit ? [b.culprit] : []);
      const culpritRows = () => h('div.issues', { style: { marginTop: '10px' } }, culprits.map((c) => {
        const btn = h('button.btn.sm', { onclick: async () => { btn.disabled = true; const done = await A.disableFiles([c.path], v.id); if (done) btn.textContent = '已禁用'; else btn.disabled = false; runCheck(); } }, '禁用');
        return h('div.issue.crit', h('div.issue-ico', icon('puzzle', 16)), h('div.issue-body', h('div.issue-title', A.nm(c.name)), h('div.issue-detail', A.nm(c.file))),
          h('div.issue-actions', btn, c.modrinth && c.modrinth.slug ? h('button.btn.sm.ghost', { onclick: () => api('shell:external', `https://modrinth.com/mod/${c.modrinth.slug}/versions`) }, '其他版本') : null));
      }));
      const disableAll = async () => { if (await A.disableFiles(culprits.map((c) => c.path), v.id)) A.toast({ level: 'ok', text: `已禁用 ${culprits.length} 个问题 Mod` }); runCheck(); };
      const head = {
        found: () => h('div',
          A.alert({
            level: 'crit',
            title: culprits.length > 1 ? `找到 ${culprits.length} 个问题 Mod` : `找到问题 Mod：${A.nm(culprits[0].name)}`,
            text: '禁用它们后游戏可以正常进入主菜单',
            actions: [h('button.btn.sm.primary', { onclick: disableAll }, culprits.length > 1 ? A.t('term.disableAll').replace('全部 Mod', '全部') : '禁用它')],
          }),
          culpritRows()),
        inconclusive: () => h('div', A.alert({ level: 'warn', title: `最可疑的 Mod：${A.nmJoin(culprits.map((c) => c.name))}`, text: b.note }), culpritRows()),
        'not-in-mods': () => A.alert({ level: 'warn', title: '问题不在普通 Mod 中', text: b.note }),
        'no-crash': () => A.alert({ level: 'ok', title: '当前配置可以正常启动', text: '没有需要排查的问题' }),
        interrupted: () => A.alert({ level: 'warn', title: A.t('test.interrupted'), text: `${A.t('test.interruptedHint')}所有 Mod 已恢复原来的启用状态。`, actions: [h('button.btn.sm', { onclick: runBisect }, icon('refresh', 14), A.t('test.retry'))] }),
      }[b.status];
      bisectBody = h('div', head ? head() : null, roundsList(b.rounds));
    } else {
      bisectBody = h('p.muted', { style: { margin: 0, fontSize: '13px' } }, `当${A.t('term.test')}失败、又看不出原因时使用：每轮禁用一半 Mod 并测试启动，大约 log₂(Mod 数量) 轮即可定位问题 Mod。前置库会自动保留，结束后恢复原状。`);
    }

    const busy = P.testing || P.bisecting;
    A.mount(K.body,
      h('div.card.install-card', h('div.row', { style: { gap: '14px' } },
        h('img', { src: A.versionIcon(v, 96), style: { width: '52px', height: '52px', imageRendering: 'pixelated' } }),
        h('div', { style: { flex: 1 } }, h('div', { style: { fontSize: '17px', fontWeight: 750 } }, A.nm(A.displayName(v))), h('div.muted', { style: { fontSize: '12.5px' } }, `${A.versionSub(v)} · ${v.mods.enabled} 个已启用的 Mod`)),
        h('button.btn.sm', { onclick: () => A.go('mods', { versionId: v.id }) }, icon('puzzle', 14), A.t('term.mods')))),
      h('div.tcard', h('div.tc-head', h('div.tc-num', '1'), h('div', { style: { flex: 1 } }, h('b', A.t('term.check')), h('div.faint', '分析前置、加载器、Minecraft 版本与冲突声明，不启动游戏')), h('button.btn.sm.ghost', { onclick: runCheck, disabled: busy }, icon('refresh', 14), '重新检查')), checkBody),
      h('div.tcard', h('div.tc-head', h('div.tc-num', '2'), h('div', { style: { flex: 1 } }, h('b', A.t('term.test')), h('div.faint', '实际启动一次游戏，确认能否进入主菜单')),
        h('button.btn.primary', { onclick: runTest, disabled: busy }, icon('play', 14), P.test ? '再次测试' : '开始测试')), testBody),
      h('div.tcard', h('div.tc-head', h('div.tc-num', '3'), h('div', { style: { flex: 1 } }, h('b', A.t('term.bisect')), h('div.faint', '自动定位导致崩溃的 Mod')),
        h('button.btn', { onclick: runBisect, disabled: busy || v.mods.enabled < 1 }, icon('filter', 14), '开始排查')), bisectBody),
      h('div.pl-foot',
        !p.troubleshootOnly ? h('button.btn.ghost', { onclick: () => K.goStep(3) }, '上一步') : null,
        h('div.spacer'),
        h('button.btn.primary.lg', { onclick: () => { if (!p.troubleshootOnly) { p.done = true; save(); } A.setConfig({ selectedVersion: v.id }); A.go('home'); } }, icon('play', 16), '完成，前往启动')));
  }

  function roundsList(rounds) {
    const list = rounds || P.rounds;
    if (!list.length) return null;
    return h('div.round-list', list.map((r) => h('div.round', h('span', { class: `rdot ${r.ok === undefined ? '' : r.ok ? 'ok' : 'bad'}` }), h('span', `第 ${r.round} 轮`), h('span.faint', r.label), h('div.spacer'), h('span.faint', `禁用 ${Array.isArray(r.disabled) ? r.disabled.length : r.disabled} 个`), h('span', r.ok === undefined ? '测试中…' : r.ok ? '正常' : '崩溃'))));
  }

  function troubleshootProfile(id) {
    const v = state.installed.find((x) => x.id === id);
    if (!v) return;
    P.plan = { ...newPlan(), name: A.displayName(v), mc: v.mcVersion, loader: v.loader ? v.loader.type : 'fabric', profileId: id, troubleshootOnly: true };
    P.test = null; P.bisect = null; P.rounds = []; P.check = null;
    K.goStep(4);
  }

  Object.assign(K, { renderTest, runCheck, runTest, troubleshootProfile });
})();
