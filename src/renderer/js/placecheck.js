'use strict';
/* 启动器运行位置检测：启动时的提醒对话框、移动便携版、设置页和首次启动向导里的位置提醒 */
(function () {
  const { h, icon, api, t } = A;

  /** 一条问题的提醒块：标题、说明、涉及的文件夹 */
  function issueAlert(it, { compact = false, probe = false } = {}) {
    const kinds = it.kinds.map((k) => t(`place.kind.${k}`)).join('、');
    const text = h('div',
      h('div', probe && it.rule === 'unwritable' ? t('place.unwritable.probe') : t(`place.${it.rule}.text`)),
      h('div.place-dirs', it.dirs.map((d) => h('code', d))),
      it.ignored ? h('div.faint', { style: { fontSize: '12px', marginTop: '4px' } }, t('place.ignored')) : null);
    return A.alert({ level: it.level, compact, title: probe ? t(`place.${it.rule}.title`) : `${kinds} · ${t(`place.${it.rule}.title`)}`, text });
  }

  const worst = (issues) => (issues.some((i) => i.level === 'crit') ? 'crit' : issues.some((i) => i.level === 'warn') ? 'warn' : 'info');

  /**
   * 「移动到推荐位置」对应的做法：便携版 → 复制 exe（和数据）到新文件夹；自定义数据文件夹 → 换数据文件夹；只有游戏目录 → 设置页
   * @returns {null | {label, run}}
   */
  function moveAction(r, issues) {
    const kinds = new Set(issues.flatMap((i) => i.kinds));
    if (r.portableExe && (kinds.has('exe') || (kinds.has('data') && (r.mode === 'portable' || issues.some((i) => i.mode === 'portable'))))) {
      return { label: t('place.move'), run: () => moveDialog(r) };
    }
    if (kinds.has('data')) return { label: t('place.moveData'), run: async () => A.locationDialog('custom', await api('location:get')) };
    if (kinds.has('game')) return { label: t('place.moveGame'), run: () => A.go('settings', { focus: 'gameDir' }) };
    return null;
  }

  /** 启动时检查一次；有没被忽略的问题就弹出对话框，关掉后才继续（返回 Promise） */
  async function run() {
    let r;
    try { r = await api('place:check'); } catch { return; }
    const issues = r.issues.filter((i) => !i.ignored);
    if (!issues.length) return;
    const lv = worst(issues);
    const move = moveAction(r, issues);
    let moving = false;
    await new Promise((resolve) => {
      A.modal({
        title: t(`place.title.${lv}`),
        level: lv,
        size: 'md',
        body: h('div.place-list', issues.map((it) => issueAlert(it))),
        actions: [
          { label: t('place.ignore'), kind: 'ghost', left: true, onClick: () => api('place:ignore', issues) },
          { label: t('place.stay'), kind: move ? 'ghost' : 'primary' },
          move ? { label: move.label, kind: 'primary', icon: 'folder', onClick: () => { moving = true; } } : null,
        ].filter(Boolean),
        onClose: resolve,
      });
    });
    // 移动对话框关掉（取消）之后再继续后面的首次启动向导
    if (moving) await move.run();
  }

  // ───────────── 移动便携版 ─────────────
  /** 返回的 Promise 在对话框关闭时完成（移动成功会直接重启）；opts.dir 指定初始位置，不传就用推荐位置 */
  async function moveDialog(r, opts = {}) {
    let dir = opts.dir || await api('place:suggest').catch(() => '');
    let shortcut = true;
    let ok = false;
    const pathEl = h('code.place-target');
    const probeEl = h('div');
    const withData = r.mode === 'portable';
    const sizeEl = withData ? h('span.faint') : null;
    if (withData) {
      const loc = await api('location:get').catch(() => null);
      if (loc && loc.base) api('location:size', loc.base).then((s) => { sizeEl.textContent = t('place.size', { size: A.fmtBytes(s.bytes) }); }).catch(() => {});
    }
    let goBtn;
    const paint = async () => {
      pathEl.textContent = dir || '—';
      A.mount(probeEl, h('div.row', h('span.spinner'), h('span.muted', t('place.checking'))));
      ok = false;
      if (goBtn) goBtn.disabled = true;
      if (!dir) { A.clear(probeEl); return; }
      const p = await api('place:probe', dir, 'data').catch(() => null);
      if (!p) { A.clear(probeEl); return; }
      ok = p.writable && !p.issues.some((i) => i.level === 'crit');
      A.mount(probeEl, p.issues.length ? p.issues.map((it) => issueAlert(it, { compact: true, probe: true })) : A.alert({ level: 'ok', compact: true, text: t('place.targetOk') }));
      if (goBtn) goBtn.disabled = !ok;
    };
    const change = async () => {
      const picked = await api('dialog:folder', t('place.pickTitle'), dir || undefined);
      if (picked) { dir = picked; paint(); }
    };
    const check = h('input', { type: 'checkbox', checked: true, onchange: (e) => { shortcut = e.target.checked; } });
    let done;
    const closed = new Promise((resolve) => { done = resolve; });
    A.modal({
      title: t('place.moveTitle'),
      icon: 'folder',
      size: 'md',
      body: h('div.place-move',
        h('p.confirm-text', withData ? t('place.moveTextData') : t('place.moveText')),
        h('div.field', h('label', t('place.moveTarget'), sizeEl), h('div.row', pathEl, h('button.btn.sm', { onclick: change }, icon('folder', 14), t('place.change')))),
        probeEl,
        h('label.row.gap-s.place-check', check, h('span', t('place.shortcut')))),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('place.moveGo'), kind: 'primary', icon: 'check', errorTitle: t('place.moveFailed'), ref: (b) => { goBtn = b; b.disabled = true; },
          onClick: async () => {
            if (!ok) return false;
            A.toast({ text: t('place.moving') });
            await api('place:move', dir, { shortcut });
            await api('place:relaunch');
            return true;
          },
        },
      ],
      onClose: () => done(),
    });
    paint();
    return closed;
  }

  /** 设置页「数据存储位置」里显示当前的问题（包括已设为不再提示的） */
  function notes() {
    const el = h('div.place-notes');
    api('place:check').then((r) => {
      if (!r.issues.length) return;
      const move = moveAction(r, r.issues);
      A.mount(el, r.issues.map((it) => issueAlert(it, { compact: true })),
        move ? h('div.row', { style: { justifyContent: 'flex-end', marginTop: '6px' } }, h('button.btn.sm', { onclick: move.run }, icon('folder', 14), move.label)) : null);
    }).catch(() => {});
    return el;
  }

  A.placeCheck = { run, notes, issueAlert, moveDialog };
})();
