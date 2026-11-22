'use strict';
/* Mod 配置器：第 3 步：下载安装 */
(function () {
  const { h, icon, api, state } = A;
  const K = A.plannerKit;
  const { LOADER_INFO, P, save } = K;

  function renderInstall() {
    const p = P.plan;
    const r = P.resolved;
    if (!r) { K.resolve().then(() => { if (P.step === 3) renderInstall(); }); A.mount(K.body, h('div.pl-loading', h('span.spinner.lg'), h('div', '正在准备…'))); return; }
    const t = r.totals;
    const same = state.installed.filter((v) => v.loader && v.loader.type === p.loader && v.mcVersion === p.mc);
    let mode = p.profileId && state.installed.some((v) => v.id === p.profileId) ? 'existing' : 'new';
    let existing = p.profileId || (same[0] && same[0].id) || null;
    const nameIn = h('input.input', { value: p.name || K.defaultName() });
    const err = h('div.err.hidden');
    const targetBox = h('div');
    const renderTarget = () => {
      A.mount(targetBox,
        A.seg([{ value: 'new', label: '创建新配置' }, { value: 'existing', label: '安装到已有配置' }], mode, (v) => { mode = v; renderTarget(); }),
        h('div', { style: { marginTop: '14px', maxWidth: '460px' } },
          mode === 'new'
            ? h('div.field', h('label', '配置名称'), nameIn, err, h('div.hint', `将自动安装 Minecraft ${p.mc} 与推荐版本的 ${A.LOADERS[p.loader].name}，并开启版本隔离`))
            : same.length
              ? h('div.field', h('label', '选择配置'), A.select({ options: same.map((v) => ({ value: v.id, label: A.nm(A.displayName(v)), sub: `${A.versionSub(v)} · ${v.mods.enabled} 个 Mod` })), value: existing, block: true, onChange: (v) => { existing = v; } }),
                h('div.hint', '已存在的同名文件会被跳过，不会删除配置中原有的 Mod'))
              : h('div.faint', `没有 Minecraft ${p.mc} · ${A.LOADERS[p.loader].name} 的配置，请创建新配置`)));
    };
    renderTarget();

    const progress = h('div.install-progress.hidden');
    const extras = A.extraMods({ mc: p.mc, loader: p.loader, compact: true });
    // 配置好清单以后两个选项（1.10.1）：跳过测试直接保存成游戏配置，或保存后马上测试启动。装好就算走完整个配置流程
    const btn = h('button.btn.primary.lg', { onclick: () => start('test') }, icon('play', 18), p.profileId ? '重新同步并测试启动' : '完成并测试启动');
    const skipBtn = h('button.btn.lg', { onclick: () => start('skip') }, icon('download', 18), p.profileId ? '重新同步，跳过测试' : '跳过启动测试，保存配置');

    async function start(after) {
      P.afterInstall = after;
      const target = mode === 'new' ? { mode: 'new', name: nameIn.value.trim() } : { mode: 'existing', versionId: existing };
      if (mode === 'new') {
        const n = target.name;
        const msg = A.nameProblem(n) ? A.nameProblem(n) : state.installed.some((v) => v.id.toLowerCase() === n.toLowerCase()) ? '已存在同名配置，请换一个名称或安装到已有配置' : '';
        err.textContent = msg;
        err.classList.toggle('hidden', !msg);
        if (msg) return;
      } else if (!existing) return;
      btn.disabled = true; skipBtn.disabled = true;
      try {
        P.installTaskId = await api('planner:install', { plan: { id: p.id, name: p.name || K.defaultName(), mc: p.mc, loader: p.loader, styles: p.styles, items: p.items.map(K.minimal) }, resolved: r, target, extras: extras.get() });
        P.installTarget = target.mode === 'new' ? target.name : target.versionId;
        progress.classList.remove('hidden');
        renderProgress();
      } catch (e) { btn.disabled = false; skipBtn.disabled = false; A.errorToast('无法开始安装', e); }
    }

    A.mount(K.body,
      h('div.card.install-card',
        h('div.row', { style: { gap: '16px' } },
          h('img', { src: A.blockImage(LOADER_INFO[p.loader].kind, 96), style: { width: '64px', height: '64px', imageRendering: 'pixelated' } }),
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontSize: '18px', fontWeight: 750 } }, A.nm(p.name) || K.defaultName()),
            h('div.muted', `Minecraft ${p.mc} · ${A.LOADERS[p.loader].name} · ${t.count} 个 Mod + ${t.deps} 个前置 · 约 ${A.fmtBytes(t.size)}`)),
          t.errors ? h('span.badge.crit', `${t.errors} 个未解决的冲突`) : h('span.badge.ok', icon('check', 12), '兼容性检查通过')),
        p.profileId ? A.alert({ level: 'ok', compact: true, className: 'done-banner', title: `已安装到「${p.profileId}」`, actions: [h('button.btn.sm', { onclick: () => K.goStep(4) }, '去测试')] }) : null),
      h('div.pl-section', h('div.pl-label', '安装位置'), targetBox),
      h('div.pl-section', h('div.pl-label', '额外 Mod', h('span.faint', { style: { fontWeight: 400, fontSize: '12.5px' } }, '自己的 jar 文件或其他想一起装的 Mod（可选）')), extras.el),
      progress,
      h('div.pl-foot',
        h('button.btn.ghost', { onclick: () => K.goStep(2) }, '上一步'),
        h('div.spacer'),
        p.profileId ? h('button.btn', { onclick: () => K.goStep(4) }, `下一步：${A.t('term.test')}`) : null,
        skipBtn, btn));
    P.installEls = { progress, btn, skip: skipBtn };
    if (P.installTaskId) { progress.classList.remove('hidden'); renderProgress(); btn.disabled = true; skipBtn.disabled = true; }
  }

  function renderProgress() {
    const els = P.installEls;
    if (!els || P.step !== 3) return;
    const t = state.tasks.get(P.installTaskId);
    if (!t) return;
    const pct = t.progress >= 0 ? Math.round(t.progress * 100) : -1;
    // 进度每 200 毫秒变一次：元素只建一次，只改文字和宽度（1.10.8）。以前每次重建，取消按钮一直被换掉，按下和松开落在不同的按钮上，点击会丢，不确定进度条也一抽一抽
    if (!els.view) {
      const v = { state: h('b'), rate: h('span.faint', { style: { fontSize: '12px' } }), bar: h('i'), box: h('div', { style: { margin: '10px 0 8px' } }), detail: h('div', { style: { fontSize: '12.5px', whiteSpace: 'pre-line' } }), cancel: h('button.btn.sm.ghost', { style: { marginTop: '8px' }, onclick: () => { if (P.installTaskId) api('tasks:cancel', P.installTaskId); } }, '取消') };
      v.box.append(v.bar);
      A.mount(els.progress, h('div.row', v.state, h('div.spacer'), v.rate), v.box, v.detail, v.cancel);
      els.view = v;
    }
    const v = els.view;
    v.state.textContent = t.status === 'done' ? '安装完成' : t.status === 'failed' ? '安装失败' : t.status === 'cancelled' ? '已取消' : '正在安装…';
    v.rate.textContent = [pct >= 0 ? `${pct}%` : '', A.fmtSpeed(t.speed)].filter(Boolean).join(' · ');
    v.box.className = `progress ${pct < 0 && t.status === 'running' ? 'indeterminate' : ''}`;
    v.bar.style.width = `${t.status === 'done' ? 100 : Math.max(0, pct)}%`;
    v.detail.className = t.status === 'failed' ? 'err' : 'faint';
    v.detail.textContent = t.detail;
    v.cancel.classList.toggle('hidden', t.status !== 'running');
    if (t.status !== 'running') {
      const ok = t.status === 'done';
      P.installTaskId = null;
      els.btn.disabled = false;
      if (els.skip) els.skip.disabled = false;
      if (ok) {
        // 保存成游戏配置就算完成了整个配置流程：之后离开再回来是全新的第一步，不再提示「未完成」
        P.plan.profileId = P.installTarget;
        P.plan.done = true;
        save();
        const id = P.installTarget;
        if (P.plan.mode !== 'edit' && P.afterInstall === 'skip') {
          setTimeout(() => {
            A.setConfig({ selectedVersion: id });
            A.toast({ level: 'ok', title: '配置完成', text: `已保存为游戏配置「${A.nm(id)}」，可以在主页启动；以后想测试，可以在配置的「更多」里做测试启动`, actions: [{ label: '去启动', onClick: () => A.go('home') }] });
            K.startNew();
          }, 600);
        } else {
          setTimeout(() => {
            A.toast({ level: 'ok', title: '安装完成', text: P.plan.mode === 'edit' ? '接下来测试一下能否正常启动吧' : '正在测试启动…' });
            K.goStep(4);
            if (P.plan.mode !== 'edit' && P.afterInstall === 'test') K.runTest();
          }, 600);
        }
      }
    }
  }

  Object.assign(K, { renderInstall, renderProgress });
})();
