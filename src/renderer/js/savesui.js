'use strict';
/* 存档与备份：每个游戏配置的世界列表（备份 / 删除 / 打开文件夹）、备份列表（新建 / 恢复 / 删除）、恢复向导和撤销。
 * 入口：配置卡片「更多」菜单、配置设置抽屉；设置页「存档备份」组在 settings.js */
(function () {
  const { h, icon, api, t, cmpMc } = A;

  const GAME_TYPES = ['survival', 'creative', 'adventure', 'spectator'];
  const typeLabel = (type) => t(`backup.type.${type}`);
  const autoLabel = (reason) => t(`backup.auto.${reason}`);
  const when = (ts) => `${A.fmtDate(ts)} ${new Date(ts).toTimeString().slice(0, 5)}`;
  const worldMode = (w) => (w.hardcore ? t('backup.mode.hardcore') : w.gameType != null && GAME_TYPES[w.gameType] ? t(`backup.mode.${GAME_TYPES[w.gameType]}`) : '');

  /** 主窗口：tab = 'worlds' | 'backups' */
  function open(v, { tab = 'worlds' } = {}) {
    const st = { tab, worlds: null, backups: null, others: false, selected: new Set(), error: null };
    const body = h('div.sv');
    const m = A.modal({
      title: t('backup.title'), subtitle: A.nm(A.displayName(v)), icon: 'save', size: 'lg', body,
      actions: [{ label: t('common.close'), kind: 'ghost' }],
    });

    async function load() {
      try {
        const [w, b] = await Promise.all([api('backup:worlds', v.id), api('backup:list', v.id, { others: st.others })]);
        st.worlds = w; st.backups = b; st.error = null;
        for (const n of [...st.selected]) if (!w.worlds.some((x) => x.name === n)) st.selected.delete(n);
      } catch (e) { st.error = e; }
      render();
    }

    function render() {
      if (!document.body.contains(m.el)) return;
      const nW = st.worlds ? st.worlds.worlds.length : 0;
      const nB = st.backups ? st.backups.own.length : 0;
      A.mount(body,
        h('div.sv-tabs', A.seg([
          { value: 'worlds', label: `${t('backup.tabWorlds')}${st.worlds ? ` · ${nW}` : ''}`, icon: 'globe' },
          { value: 'backups', label: `${t('backup.tabBackups')}${st.backups ? ` · ${nB}` : ''}`, icon: 'history' },
        ], st.tab, (val) => { st.tab = val; render(); })),
        st.error ? A.alert({ level: 'crit', title: t('backup.loadFailed'), text: st.error.message })
          : !st.worlds ? h('div.row.sv-loading', h('span.spinner'), h('span.muted', t('backup.loading')))
            : st.tab === 'worlds' ? worldsTab() : backupsTab());
    }

    // ── 存档 ──
    function sourceNote(w) {
      if (w.mode === 'link') return A.alert({ level: 'info', compact: true, text: t('backup.srcLink', { source: w.source === '@root' ? t('backup.rootDir') : A.nm(w.source) }) });
      if (w.mode === 'root') return A.alert({ level: 'info', compact: true, text: t('backup.srcRoot') });
      if (w.mode === 'copy') return A.alert({ level: 'warn', compact: true, text: t('backup.srcCopy', { sandbox: t('term.sandbox') }) });
      return null;
    }

    function worldsTab() {
      const w = st.worlds;
      const all = w.worlds.length && w.worlds.every((x) => st.selected.has(x.name));
      const sel = st.selected.size;
      return h('div.sv-pane',
        w.running ? A.alert({ level: 'warn', compact: true, title: t('backup.runningTitle'), text: t('backup.runningText') }) : null,
        sourceNote(w),
        h('div.sv-bar',
          w.worlds.length ? h('label.sv-all', h('input', { type: 'checkbox', checked: all, onchange: (e) => { st.selected = new Set(e.target.checked ? w.worlds.map((x) => x.name) : []); render(); } }), t('backup.selectAll')) : null,
          h('div.spacer'),
          h('button.btn.sm', { onclick: () => api('backup:savesDir', v.id).then((d) => api('shell:open', d)).catch((e) => A.errorToast(t('backup.openFailed'), e)) }, icon('folder', 14), t('backup.openSaves')),
          h('button.btn.sm', { disabled: w.running, onclick: () => A.importWorlds(v, load) }, icon('import', 14), '从其他配置导入'),
          h('button.btn.sm', { disabled: w.running && false, onclick: () => createDialog(v, 'settings', null, load) }, icon('settings', 14), t('backup.backupSettings')),
          h('button.btn.sm.primary', { disabled: !sel || w.running, onclick: () => createDialog(v, 'saves', [...st.selected], load) }, icon('save', 14), sel ? t('backup.backupSelected', { n: sel }) : t('backup.backupWorlds'))),
        w.worlds.length ? h('div.sv-list', w.worlds.map((x) => worldRow(x)))
          : A.emptyState({ iconName: 'globe', title: t('backup.noWorlds'), text: t('backup.noWorldsText') }));
    }

    function worldRow(x) {
      const on = st.selected.has(x.name);
      const meta = [worldMode(x), x.version ? `Minecraft ${x.version}` : '', x.lastPlayed ? t('backup.lastPlayed', { when: A.fmtRelative(x.lastPlayed) }) : '', A.fmtBytes(x.size)].filter(Boolean).join(' · ');
      return h('div', { class: `sv-row ${on ? 'on' : ''}` },
        h('input', { type: 'checkbox', checked: on, 'aria-label': A.nm(x.displayName), onchange: (e) => { if (e.target.checked) st.selected.add(x.name); else st.selected.delete(x.name); render(); } }),
        x.icon ? h('img.sv-icon', { src: x.icon, alt: '' }) : h('div.sv-icon.ph', icon('globe', 20)),
        h('div.sv-main',
          h('div.sv-name', A.nm(x.displayName), x.hardcore ? h('span.badge.crit', t('backup.mode.hardcore')) : null),
          h('div.sv-sub', x.displayName !== x.name ? `${A.nm(x.name)} · ${meta}` : meta)),
        h('div.sv-acts',
          h('button.btn.sm.icon.ghost', { 'data-tip': t('backup.backupThis'), disabled: st.worlds.running, onclick: () => createDialog(v, 'saves', [x.name], load) }, icon('save', 16)),
          h('button.btn.sm.icon.ghost', { 'data-tip': t('backup.openFolder'), onclick: () => api('shell:open', x.dir).catch((e) => A.errorToast(t('backup.openFailed'), e)) }, icon('folder', 16)),
          h('button.btn.sm.icon.ghost.danger', { 'data-tip': t('backup.deleteWorld'), disabled: st.worlds.running, onclick: () => deleteWorld(v, x, load) }, icon('trash', 16))));
    }

    // ── 备份 ──
    function backupsTab() {
      const b = st.backups;
      return h('div.sv-pane',
        h('div.sv-bar',
          h('label.sv-all', h('input', { type: 'checkbox', checked: st.others, onchange: (e) => { st.others = e.target.checked; load(); } }), t('backup.showOthers')),
          h('div.spacer'),
          h('button.btn.sm', { onclick: () => api('shell:open', b.dir).catch(() => api('backup:dir').then((d) => api('shell:open', d))).catch((e) => A.errorToast(t('backup.openFailed'), e)) }, icon('folder', 14), t('backup.openBackups')),
          h('button.btn.sm.primary', { onclick: (e) => A.menu(e.currentTarget, [
            { label: typeLabel('saves'), icon: 'globe', sub: t('backup.newSavesSub'), onClick: () => createDialog(v, 'saves', null, load) },
            { label: typeLabel('settings'), icon: 'settings', sub: t('backup.newSettingsSub'), onClick: () => createDialog(v, 'settings', null, load) },
            { label: typeLabel('full'), icon: 'box', sub: t('backup.newFullSub'), onClick: () => createDialog(v, 'full', null, load) },
          ], { align: 'right' }) }, icon('plus', 14), t('backup.newBackup'))),
        b.own.length ? h('div.sv-list', b.own.map((x) => backupRow(x, false)))
          : A.emptyState({ iconName: 'history', title: t('backup.noBackups'), text: t('backup.noBackupsText') }),
        st.others ? h('div.sv-others',
          h('h5', t('backup.othersTitle')),
          h('div.faint.sv-hint', t('backup.othersHint')),
          b.others.length ? h('div.sv-list', b.others.map((x) => backupRow(x, true))) : h('div.faint.sv-hint', t('backup.othersNone'))) : null);
    }

    function backupRow(x, other) {
      const ic = { saves: 'globe', settings: 'settings', mods: 'puzzle', full: 'box' }[x.type] || 'file';
      const what = x.worlds.length ? A.nmJoin(x.worlds.map((w) => w.displayName)) : x.parts.map((p) => t(`backup.part.${p}`)).join('、');
      const tags = [
        x.auto ? h('span.badge', autoLabel(x.auto)) : h('span.badge.accent', t('backup.manual')),
        x.legacy ? h('span.badge', t('backup.legacy')) : null,
        x.broken ? h('span.badge.crit', t('backup.broken')) : null,
        other ? h('span.badge', A.nm(x.profileName) || A.nm(x.profile)) : null,
      ];
      const sub = [when(x.createdAt), A.fmtBytes(x.size), x.minecraft ? `Minecraft ${A.nm(x.minecraft)}` : '', x.note].filter(Boolean).join(' · ');
      return h('div.sv-row',
        h('div.sv-icon.ph', icon(ic, 20)),
        h('div.sv-main',
          h('div.sv-name', typeLabel(x.type), ...tags),
          h('div.sv-sub', what ? `${what}` : ''),
          h('div.sv-sub.faint', sub)),
        h('div.sv-acts',
          h('button.btn.sm', { disabled: !!x.broken, onclick: () => restoreDialog(v, x, st.worlds, other, load) }, icon('history', 14), t('common.restore')),
          h('button.btn.sm.icon.ghost', { 'data-tip': t('common.more'), onclick: (e) => A.menu(e.currentTarget, [
            { label: t('backup.showInFolder'), icon: 'folder', onClick: () => api('shell:showItem', x.file) },
            '-',
            { label: t('backup.deleteBackup'), icon: 'trash', danger: true, onClick: () => deleteBackup(x, load) },
          ], { align: 'right' }) }, icon('more', 16))));
    }

    load();
  }

  // ═════════════ 新建备份 ═════════════
  function createDialog(v, type, worlds, after) {
    const note = h('input.input', { placeholder: t('backup.notePh'), maxlength: 80 });
    const withConfig = h('input', { type: 'checkbox', checked: !!v.loader });
    const body = h('div',
      h('p.confirm-text', worlds && worlds.length ? t('backup.createWorlds', { n: worlds.length }) : t(`backup.createDesc.${type}`)),
      type === 'settings' ? h('label.check-row', { style: { marginTop: '10px' } }, withConfig, h('span', t('backup.withConfig'), h('span.faint', ` ${t('backup.withConfigSub')}`))) : null,
      type === 'full' ? A.alert({ level: 'info', compact: true, text: t('backup.fullNote') }) : null,
      h('div.field', { style: { marginTop: '12px' } }, h('label', t('backup.note')), note));
    A.modal({
      title: t('backup.createTitle', { type: typeLabel(type) }), icon: 'save', size: 'sm', body,
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('backup.startBackup'), kind: 'primary', icon: 'save',
          onClick: () => { run(v, { type, worlds, config: withConfig.checked, note: note.value.trim() }, after); return true; },
        },
      ],
    });
    setTimeout(() => note.focus(), 60);
  }

  async function run(v, opts, after) {
    A.toast({ level: 'info', text: t('backup.started') });
    try {
      const e = await api('backup:create', v.id, opts);
      A.toast({ level: 'ok', title: t('backup.doneTitle'), text: t('backup.doneText', { type: typeLabel(e.type), size: A.fmtBytes(e.size) }), actions: [{ label: t('backup.showInFolder'), onClick: () => api('shell:showItem', e.file) }] });
    } catch (err) {
      if (!err.cancelled) A.errorToast(t('backup.failed'), err);
    }
    if (after) after();
  }

  // ═════════════ 删除 ═════════════
  async function deleteWorld(v, x, after) {
    const r = await A.dangerConfirm({
      level: 3, title: t('backup.deleteWorldTitle'), text: t('backup.deleteWorldText', { name: A.nm(x.displayName) }),
      items: [{ icon: 'globe', label: A.nm(x.displayName), sub: `${A.nm(x.name)} · ${A.fmtBytes(x.size)}` }],
      note: t('danger.trashNote'), noteLevel: 'info', confirmName: x.displayName, backup: { checked: true },
    });
    if (!r) return;
    if (r.backup) {
      try { await api('backup:create', v.id, { type: 'saves', worlds: [x.name], note: t('backup.beforeDeleteNote') }); } catch (e) { A.errorToast(t('danger.backupFailed'), e); return; }
    }
    try {
      await api('backup:deleteWorld', v.id, x.name);
      A.toast({ level: 'ok', text: t('backup.worldDeleted', { name: A.nm(x.displayName) }) });
    } catch (e) { A.errorToast(t('backup.deleteFailed'), e); }
    after();
  }

  async function deleteBackup(x, after) {
    const ok = await A.dangerConfirm({
      level: 2, title: t('backup.deleteBackupTitle'), text: t('backup.deleteBackupText'),
      items: [{ icon: 'history', label: `${typeLabel(x.type)} · ${when(x.createdAt)}`, sub: `${A.nmJoin(x.worlds.map((w) => w.displayName)) || A.nm(x.name)} · ${A.fmtBytes(x.size)}` }],
      note: t('danger.permanentNote'), noteLevel: 'warn',
    });
    if (!ok) return;
    try { await api('backup:remove', x.file); } catch (e) { A.errorToast(t('backup.deleteFailed'), e); }
    after();
  }

  // ═════════════ 恢复 ═════════════
  function restoreDialog(v, x, current, other, after) {
    const existing = new Set(current ? current.worlds.map((w) => w.name) : []);
    const crossOnlySaves = other || x.legacy;
    const parts = crossOnlySaves ? ['saves'] : x.parts;
    const st = { worlds: new Set(x.worlds.map((w) => w.name)), parts: new Set(parts), mode: 'overwrite' };
    const body = h('div.sv-restore');
    const ver = cmpMc(x.minecraft, v.mcVersion);
    let okBtn = null;

    const render = () => {
      const doSaves = st.parts.has('saves') && st.worlds.size;
      const overwrites = doSaves && st.mode === 'overwrite' ? [...st.worlds].filter((n) => existing.has(n.split('/').pop())) : [];
      A.mount(body,
        h('div.sv-rs-head',
          h('div', h('b', typeLabel(x.type)), x.auto ? h('span.badge', autoLabel(x.auto)) : null),
          h('div.faint', [when(x.createdAt), A.fmtBytes(x.size), x.minecraft ? `Minecraft ${A.nm(x.minecraft)}${x.loader ? ` · ${(A.LOADERS[x.loader.type] || {}).name || x.loader.type}` : ''}` : '', x.note].filter(Boolean).join(' · '))),
        ver > 0 ? A.alert({ level: 'crit', compact: true, title: t('backup.newerTitle'), text: t('backup.newerText', { from: A.nm(x.minecraft), to: A.nm(v.mcVersion) }) })
          : ver < 0 && doSaves ? A.alert({ level: 'warn', compact: true, title: t('backup.olderTitle'), text: t('backup.olderText', { from: A.nm(x.minecraft), to: A.nm(v.mcVersion) }) }) : null,
        crossOnlySaves && x.parts.length > 1 ? A.alert({ level: 'info', compact: true, text: t('backup.crossOnlySaves') }) : null,
        parts.length > 1 ? h('div.sv-rs-sec', h('h5', t('backup.restoreWhat')),
          h('div.sv-rs-parts', parts.map((p) => h('label.check-row', h('input', { type: 'checkbox', checked: st.parts.has(p), onchange: (e) => { if (e.target.checked) st.parts.add(p); else st.parts.delete(p); render(); } }),
            h('span', t(`backup.part.${p}`), p === 'dirs' ? h('span.faint', ` ${x.dirs.filter((d) => d !== 'mods').join('、')}`) : null))))) : null,
        st.parts.has('saves') && x.worlds.length ? h('div.sv-rs-sec', h('h5', t('backup.whichWorlds')),
          h('div.sv-rs-worlds', x.worlds.map((w) => h('label.check-row',
            h('input', { type: 'checkbox', checked: st.worlds.has(w.name), onchange: (e) => { if (e.target.checked) st.worlds.add(w.name); else st.worlds.delete(w.name); render(); } }),
            h('span', A.noTr(w.displayName), w.displayName !== w.name.split('/').pop() ? h('span.faint', ` ${A.nm(w.name.split('/').pop())}`) : null),
            h('div.spacer'),
            existing.has(w.name.split('/').pop()) ? h('span.badge.warn', t('backup.exists')) : h('span.badge', t('backup.notExists'))))),
          h('div.sv-rs-mode', A.seg([
            { value: 'overwrite', label: t('backup.modeOverwrite') },
            { value: 'new', label: t('backup.modeNew') },
          ], st.mode, (val) => { st.mode = val; render(); })),
          h('div.faint.sv-hint', st.mode === 'new' ? t('backup.modeNewHint') : t('backup.modeOverwriteHint'))) : null,
        overwrites.length || (st.parts.size && [...st.parts].some((p) => p !== 'saves'))
          ? A.alert({ level: 'info', compact: true, text: t('backup.autoBeforeRestore') }) : null);
      if (okBtn) okBtn.disabled = !st.parts.size || (st.parts.has('saves') && x.worlds.length > 0 && !st.worlds.size && st.parts.size === 1);
    };

    const m = A.modal({
      title: t('backup.restoreTitle'), subtitle: A.nm(A.displayName(v)), icon: 'history', size: 'md', body,
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        { label: t('common.restore'), kind: 'primary', icon: 'history', ref: (b) => { okBtn = b; }, onClick: () => { setTimeout(() => confirmRestore(v, x, st, existing, after), 150); return true; } },
      ],
    });
    render();
  }

  async function confirmRestore(v, x, st, existing, after) {
    const worlds = st.parts.has('saves') ? x.worlds.filter((w) => st.worlds.has(w.name)) : [];
    const overwrites = st.mode === 'overwrite' ? worlds.filter((w) => existing.has(w.name.split('/').pop())) : [];
    const others = [...st.parts].filter((p) => p !== 'saves');
    // 会覆盖现有的东西：L3 确认（会先自动备份当前状态，之后可以撤销）
    if (overwrites.length || others.length) {
      const items = [
        ...overwrites.map((w) => ({ icon: 'globe', label: A.nm(w.displayName), sub: t('backup.willOverwrite') })),
        ...others.map((p) => ({ icon: p === 'mods' ? 'puzzle' : 'settings', label: t(`backup.part.${p}`), sub: t('backup.willReplace') })),
      ];
      const ok = await A.dangerConfirm({ level: 3, title: t('backup.confirmTitle'), text: t('backup.confirmText'), items, note: t('backup.autoBeforeRestore'), noteLevel: 'info', okText: t('backup.confirmOk') });
      if (!ok) return;
    }
    A.toast({ level: 'info', text: t('backup.restoring') });
    let r;
    try {
      r = await api('backup:restore', v.id, x.file, { worlds: worlds.map((w) => w.name), parts: [...st.parts], mode: st.mode });
    } catch (e) {
      if (!e.cancelled) A.errorToast(t('backup.restoreFailed'), e);
      after();
      return;
    }
    after();
    resultDialog(v, r, after);
  }

  function resultDialog(v, r, after) {
    const lines = [
      ...r.worlds.map((w) => (w.to !== w.from.split('/').pop() ? t('backup.resWorldNew', { name: A.nm(w.to) }) : w.replaced ? t('backup.resWorldOver', { name: A.nm(w.to) }) : t('backup.resWorld', { name: A.nm(w.to) }))),
      r.files ? t('backup.resFiles', { n: r.files }) : null,
      ...r.dirs.map((d) => t('backup.resDir', { name: A.nm(d) })),
    ].filter(Boolean);
    const canUndo = !!(r.undo || r.created.length);
    A.modal({
      title: t('backup.resTitle'), level: 'ok', size: 'sm',
      body: h('div',
        h('ul.sv-res', lines.map((l) => h('li', l))),
        r.skipped.length ? A.alert({ level: 'info', compact: true, text: t('backup.resSkipped', { names: A.nmJoin(r.skipped) }) }) : null,
        canUndo ? h('p.faint', { style: { marginTop: '10px' } }, t('backup.resUndoHint')) : null),
      actions: [
        canUndo ? { label: t('backup.undo'), kind: 'ghost', icon: 'refresh', onClick: () => { undo(v, r, after); return true; } } : null,
        { label: t('common.done'), kind: 'primary' },
      ].filter(Boolean),
    });
  }

  async function undo(v, r, after) {
    const ok = await A.confirm(t('backup.undoText'), { title: t('backup.undoTitle'), okText: t('backup.undo') });
    if (!ok) return;
    try {
      await api('backup:undo', v.id, { undo: r.undo, created: r.created });
      A.toast({ level: 'ok', text: t('backup.undone') });
    } catch (e) { A.errorToast(t('backup.undoFailed'), e); }
    after();
  }

  A.savesManager = open;
})();
