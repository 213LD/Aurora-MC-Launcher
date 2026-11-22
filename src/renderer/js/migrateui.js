'use strict';
/* 一键迁移 · 第一步（1.5.3）：导出数据 / 导入数据 / 首次启动时问要不要导入。后端在 core/migrate.js。
 * 入口：游戏配置页「导出…」、「导入整合包」选 .aurorapack、设置 → 数据存储位置、首次启动向导之后 */
(function () {
  const { h, icon, api, state } = A;
  const EXT = 'aurorapack';
  const OPT_ROWS = [
    ['saves', '存档', '每个配置的世界'],
    ['screenshots', '截图', ''],
    ['logs', '日志和崩溃报告', ''],
    ['runtime', '游戏本体和运行库', '新电脑上不用联网重新下载 Forge / Fabric 等，包会大不少'],
    ['settings', '启动器设置', '主题、内存、下载源、背景等；数据位置、Java 路径这类只在这台电脑有效的不带'],
    ['skins', '皮肤收藏', '皮肤中心里的皮肤和分组'],
    ['accounts', '账户', '只有名字和皮肤，不含登录凭据；正版账户到新电脑上要重新登录一次'],
    ['plans', 'Mod 配置器清单', ''],
  ];
  const DEFAULTS = { saves: true, screenshots: false, logs: false, runtime: false, settings: true, skins: true, accounts: true, plans: true };

  const checkRow = (checked, onChange, label, sub) => h('label.check-row',
    h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }),
    h('span', label, sub ? h('span.faint', ` ${sub}`) : null));

  // ───────────────────────── 导出 ─────────────────────────
  function exportDialog() {
    const list = state.installed.filter((v) => !v.broken);
    if (!list.length) { A.toast({ level: 'info', text: '还没有游戏配置，没有可以导出的' }); return; }
    const opts = { ...DEFAULTS };
    const picked = new Set(list.map((v) => v.id));
    const sizeEl = h('span.faint', '正在估算大小…');
    const perEl = new Map();
    let goBtn;
    let seq = 0;
    const refresh = A.debounce(async () => {
      const my = ++seq;
      sizeEl.textContent = '正在估算大小…';
      if (goBtn) goBtn.disabled = !picked.size;
      try {
        const r = await api('migrate:estimate', opts, [...picked]);
        if (my !== seq) return;
        sizeEl.textContent = picked.size ? `大约 ${A.fmtBytes(r.total)}（${picked.size} 个配置）` : '至少选一个游戏配置';
        for (const [id, el] of perEl) el.textContent = r.perProfile[id] != null ? A.fmtBytes(r.perProfile[id]) : '';
      } catch (e) { if (my === seq) sizeEl.textContent = `估算失败：${e.message}`; }
    }, 350);

    const profRows = list.map((v) => {
      const sz = h('span.faint', { style: { marginLeft: 'auto', fontSize: '12px' } });
      perEl.set(v.id, sz);
      return h('label.check-row.mg-prof',
        h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) picked.add(v.id); else picked.delete(v.id); refresh(); } }),
        h('img', { src: A.versionIcon(v, 32), style: { width: '20px', height: '20px' } }),
        h('span', A.nm(A.displayName(v)), h('span.faint', ` ${A.versionSub(v)}`)), sz);
    });
    const body = h('div.mg',
      h('div.mg-label', '游戏配置'),
      h('div.mg-list', profRows),
      h('div.mg-label', '一起带上'),
      h('div.mg-opts', OPT_ROWS.map(([k, label, sub]) => checkRow(opts[k], (v) => { opts[k] = v; refresh(); }, label, sub))),
      A.alert({ level: 'info', compact: true, text: '声音、材质这些资源文件不打包，导入后会自动下载补全。登录凭据、CurseForge API Key 不会导出。' }),
      h('div.mg-size', icon('save', 14), sizeEl));
    A.modal({
      title: '导出数据', subtitle: `打包成一个 .${EXT} 文件，拷到别的电脑上用「导入」恢复`, icon: 'upload', size: 'lg', body,
      actions: [
        { label: A.t('common.cancel'), kind: 'ghost' },
        {
          label: '选择位置并导出', kind: 'primary', icon: 'upload', ref: (b) => { goBtn = b; },
          onClick: async () => {
            if (!picked.size) return false;
            const id = await api('migrate:export', opts, [...picked]);
            if (!id) return false;
            A.toast({ level: 'info', text: '正在导出，进度在顶栏的下载 / 任务里', duration: 3000, noLog: true });
            return true;
          },
        },
      ],
    });
    refresh();
  }

  // ───────────────────────── 导入 ─────────────────────────
  /** opts：{ file } 直接检查这个导出包；{ source: 'foreign' } 直接选其他启动器；{ firstRun } 首次启动时打开（默认勾上「启动器设置」） */
  async function importDialog(opts = {}) {
    const body = h('div.mg');
    let m;
    let goBtn;
    let st = null; // { input, info, choices }

    const loading = (text) => A.mount(body, h('div.row', { style: { justifyContent: 'center', padding: '30px', gap: '10px' } }, h('span.spinner'), h('span.muted', text)));

    async function pickSource() {
      if (goBtn) goBtn.disabled = true;
      st = null;
      loading('正在找这台电脑上的其他 Aurora 数据…');
      const cands = await api('migrate:candidates').catch(() => []);
      A.mount(body,
        h('div.mg-label', '从哪里导入？'),
        h('div.mg-src',
          h('button.mg-card', { onclick: async () => { const f = await api('dialog:file', '选择导出包', [{ name: `${A.BRAND.short} 数据导出包`, extensions: [EXT] }]); if (f) check({ file: f }); } },
            icon('box', 22), h('div', h('b', '导出包文件'), h('div.faint', `旧电脑上「导出数据」得到的 .${EXT} 文件`))),
          h('button.mg-card', { onclick: async () => { const d = await api('dialog:folder', '选择 Aurora 的数据文件夹'); if (d) check({ dir: d }); } },
            icon('folder', 22), h('div', h('b', '另一套 Aurora 数据'), h('div.faint', '比如便携版的 AuroraData 文件夹、旧电脑拷过来的数据文件夹'))),
          // 第二 / 三步（2.0.0-pre10）：官方启动器、HMCL / PCL2、MultiMC / Prism，后端在 core/foreign.js
          h('button.mg-card.mg-wide', { onclick: () => foreignPick() },
            icon('import', 22), h('div', h('b', '其他启动器'), h('div.faint', '从官方启动器、HMCL、PCL2、MultiMC / Prism 导入游戏配置和存档。原来的文件不会被改动')))),
        cands.length ? h('div', h('div.mg-label', '在这台电脑上找到的'),
          h('div.mg-list', cands.map((c) => h('button.check-row.mg-cand', { onclick: () => check({ dir: c.dir }) },
            icon('folder', 16), h('span', h('b', c.label), h('span.faint', ` ${c.profiles} 个游戏配置 · ${c.modified ? `上次用过：${A.fmtRelative(c.modified)}` : ''}`), h('div.faint.ellipsis', { style: { fontSize: '11.5px' } }, c.dir)),
            icon('chevronRight', 16))))) : null);
    }

    // ── 其他启动器 ──
    let foreignState = null;
    async function foreignPick() {
      if (goBtn) goBtn.disabled = true;
      st = null;
      foreignState = null;
      loading('正在找这台电脑上的其他启动器…');
      const found = await api('migrate:foreignScan').catch(() => []);
      const pickDir = async () => { const d = await api('dialog:folder', '选择游戏文件夹（.minecraft，或者 Prism / MultiMC 的文件夹）'); if (d) foreignCheck(d); };
      A.mount(body,
        h('div.row', { style: { marginBottom: '10px' } }, h('button.btn.sm.ghost', { onclick: () => pickSource() }, icon('chevronLeft', 14), '换一个来源')),
        found.length ? h('div', h('div.mg-label', '在这台电脑上找到的'),
          h('div.mg-list', found.map((c) => h('button.check-row.mg-cand', { onclick: () => foreignCheck(c.dir) },
            icon('folder', 16), h('span', h('b', c.label), h('span.faint', ` ${c.count} 个配置`), h('div.faint.ellipsis', { style: { fontSize: '11.5px' } }, c.dir)),
            icon('chevronRight', 16))))) : h('div.faint', { style: { margin: '6px 0 12px' } }, '常见位置没有找到，可以自己选文件夹。'),
        h('div.mg-label', '自己选'),
        h('div.mg-src', h('button.mg-card', { onclick: pickDir }, icon('folder', 22), h('div', h('b', '选一个文件夹'), h('div.faint', '.minecraft 文件夹（里面有 versions），或者 Prism / MultiMC 的文件夹')))));
    }

    const MODES = [{ value: 'copy', label: '复制' }, { value: 'link', label: '引用原目录' }, { value: 'saves', label: '只导存档' }];
    async function foreignCheck(dir) {
      loading('正在读取这个文件夹，大的话要一会儿…');
      let info;
      try { info = await api('migrate:foreignInspect', dir); } catch (e) { info = { ok: false, problems: [{ text: e.message }] }; }
      foreignState = { dir, info, picks: {} };
      if (info.ok) for (const it of info.instances) foreignState.picks[it.key] = it.savesOnly ? 'saves' : 'copy';
      foreignRender();
    }

    function foreignRender() {
      const { info, picks } = foreignState;
      const back = h('button.btn.sm.ghost', { onclick: () => foreignPick() }, icon('chevronLeft', 14), '换一个文件夹');
      if (!info.ok) {
        A.mount(body, A.alert({ level: 'crit', title: '不能导入', text: h('div', (info.problems || []).map((x) => h('div', x.text))) }), h('div.row', { style: { marginTop: '12px' } }, back));
        if (goBtn) goBtn.disabled = true;
        return;
      }
      const sizeEl = h('div.mg-size');
      const noteEl = h('div');
      const sync = () => {
        const on = info.instances.filter((it) => picks[it.key]);
        if (goBtn) goBtn.disabled = !on.length;
        const copying = on.filter((it) => picks[it.key] !== 'link').reduce((s, it) => s + (it.size || 0), 0);
        const lack = info.free != null && copying > info.free;
        A.mount(sizeEl, icon('save', 14), h('span.faint', `要复制大约 ${A.fmtBytes(copying)}${info.free != null ? `，磁盘还剩 ${A.fmtBytes(info.free)}` : ''}`));
        A.mount(noteEl,
          lack ? A.alert({ level: 'warn', compact: true, text: '磁盘空间可能不够。可以少选几个，或者改成「引用原目录」' }) : null,
          on.some((it) => picks[it.key] === 'link') ? A.alert({ level: 'warn', compact: true, title: '引用原目录是什么意思', text: '不复制，两个启动器共用同一份存档和 Mod：这边玩的进度那边也看得到。卸载原来的启动器可能连游戏一起删掉，这边也就没了。删除这边的配置不会动原来的文件夹' }) : null,
          on.some((it) => it.needsDownload && picks[it.key] !== 'saves') ? A.alert({ level: 'info', compact: true, text: 'Prism / MultiMC 的配置要联网重新安装游戏和加载器，需要几分钟' }) : null,
          on.some((it) => picks[it.key] === 'saves') ? A.alert({ level: 'info', compact: true, text: '只导存档：世界放进公共目录，同名的会改名，不会盖掉你现在的世界' }) : null);
      };
      const row = (it) => {
        const off = h('input', { type: 'checkbox', checked: !!picks[it.key], onchange: (e) => { picks[it.key] = e.target.checked ? (it.savesOnly ? 'saves' : modeSel.value()) : null; sync(); } });
        let current = picks[it.key] || 'copy';
        const select = it.savesOnly ? null : A.select({ small: true, width: 130, value: current, options: MODES, onChange: (v) => { current = v; if (picks[it.key]) { picks[it.key] = v; sync(); } } });
        const modeSel = { value: () => current };
        const facts = [it.mc, it.loader ? (A.LOADERS[it.loader.type] || {}).name || it.loader.type : '', it.worlds ? `${it.worlds} 个世界` : '', it.mods ? `${it.mods} 个 Mod` : '', it.size ? `${A.fmtBytes(it.size)}${it.partial ? ' 以上' : ''}` : ''].filter(Boolean).join(' · ');
        return h('div.check-row.mg-prof', off,
          h('span', h('b', A.nm(it.name)), h('span.faint', ` ${facts}`), it.isolated ? null : h('span.faint', '（存档在公共目录）')),
          h('div.row', { style: { marginLeft: 'auto', gap: '8px', flexShrink: 0 } }, it.exists ? h('span.badge.warn', '这边有同名的，会改名') : null, select));
      };
      A.mount(body,
        h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, icon('folder', 16),
          h('span.ellipsis', { style: { flex: 1, minWidth: 0, fontSize: '12.5px' } }, `${info.source.launcher}：${info.source.dir}`), back),
        A.alert({ level: 'ok', compact: true, text: '原来的文件夹只读，不会被改动' }),
        h('div.mg-label', `游戏配置（${info.instances.length}）`),
        h('div.mg-list', info.instances.map(row)),
        noteEl, sizeEl);
      sync();
    }

    async function foreignRun() {
      const { dir, picks } = foreignState;
      const chosen = Object.fromEntries(Object.entries(picks).filter(([, v]) => v));
      if (!Object.keys(chosen).length) return false;
      try {
        const id = await api('migrate:foreignImport', { dir }, { picks: chosen });
        watch(id);
        A.toast({ level: 'info', text: '正在导入，进度在顶栏的下载 / 任务里；做完会通知你', duration: 3500, noLog: true });
        return true;
      } catch (e) { A.errorToast('导入失败', e); return false; }
    }

    async function check(input) {
      foreignState = null;
      loading(input.file ? '正在检查导出包…' : '正在读取这套数据…');
      let info;
      try { info = await api('migrate:inspect', input); } catch (e) { info = { ok: false, problems: [{ level: 'block', text: e.message }] }; }
      st = { input, info, choices: { profiles: {}, settings: !!opts.firstRun && !!(info.has && info.has.settings), accounts: true, skins: true, plans: true }, accept: null, picked: new Set((info.profiles || []).map((p) => p.id)) };
      render();
    }

    function render() {
      const { info, choices } = st;
      const back = h('button.btn.sm.ghost', { onclick: () => (opts.file && !opts.allowBack ? null : pickSource()) }, icon('chevronLeft', 14), '换一个来源');
      if (!info.ok) {
        A.mount(body, A.alert({ level: 'crit', title: '不能导入', text: h('div', (info.problems || []).map((x) => h('div', x.text))) }), h('div.row', { style: { marginTop: '12px' } }, back));
        if (goBtn) goBtn.disabled = true;
        return;
      }
      const risks = info.problems.filter((x) => x.level === 'risk');
      const src = info.source;
      const when = src.exportedAt && !Number.isNaN(new Date(src.exportedAt).getTime()) ? new Date(src.exportedAt).toLocaleString() : '';
      const sync = () => { if (goBtn) goBtn.disabled = !st.picked.size && !choices.settings && !choices.accounts || !!(st.accept && !st.accept.checked); };
      st.accept = risks.length ? h('input', { type: 'checkbox', onchange: sync }) : null;
      const profRow = (p) => {
        const conflict = p.exists ? A.select({
          small: true, width: 150, value: choices.profiles[p.id] || 'rename',
          options: [{ value: 'rename', label: '改名导入' }, { value: 'overwrite', label: '覆盖（先备份）' }, { value: 'skip', label: '跳过' }],
          onChange: (v) => { choices.profiles[p.id] = v; },
        }) : null;
        return h('div.check-row.mg-prof',
          h('input', { type: 'checkbox', checked: st.picked.has(p.id), onchange: (e) => { if (e.target.checked) st.picked.add(p.id); else st.picked.delete(p.id); sync(); } }),
          h('span', h('b', A.nm(p.id)), h('span.faint', ` ${p.mc || ''}${p.loader ? ` · ${(A.LOADERS[p.loader.type] || {}).name || p.loader.type}` : ''}${p.size ? ` · ${A.fmtBytes(p.size)}` : ''}`)),
          p.exists ? h('span.badge.warn', { style: { marginLeft: 'auto' } }, '这台电脑上有同名的') : null,
          conflict);
      };
      const opt = (k, label, sub) => (info.has[k] ? checkRow(choices[k], (v) => { choices[k] = v; sync(); }, label, sub) : null);
      A.mount(body,
        h('div.row', { style: { marginBottom: '10px', gap: '8px' } },
          icon(src.kind === 'pack' ? 'box' : 'folder', 16),
          h('span.ellipsis', { style: { flex: 1, minWidth: 0, fontSize: '12.5px' } }, src.kind === 'pack' ? `导出包：${src.path}` : `数据文件夹：${src.path}`),
          back),
        h('div.faint', { style: { fontSize: '12px', marginBottom: '8px' } }, [src.app ? `由 ${A.BRAND.short} ${src.app} 导出` : '', when ? `${src.kind === 'pack' ? '导出于' : '最后使用'} ${when}` : '', info.total ? `共 ${A.fmtBytes(info.total)}` : '', info.has.runtime ? '带游戏本体和运行库' : '不带运行库（导入后联网下载）'].filter(Boolean).join(' · ')),
        ...info.problems.filter((x) => x.level === 'warn').map((x) => A.alert({ level: 'warn', compact: true, text: x.text })),
        risks.length ? A.alert({ level: 'crit', title: '文件可能被改动过或已经损坏', text: h('div', risks.map((x) => h('div', `· ${x.text}`)), h('div', { style: { marginTop: '6px' } }, '继续导入可能得到和原来不一样的内容，损坏的文件会跳过，后果由你自己承担。')) })
          : src.kind === 'pack' ? A.alert({ level: 'ok', compact: true, text: '文件检查通过：格式正确，导出之后内容没有被改动' }) : null,
        st.accept ? h('label.check-row', st.accept, h('span', '我了解风险，仍然导入')) : null,
        h('div.mg-label', `游戏配置（${info.profiles.length}）`),
        info.profiles.length ? h('div.mg-list', info.profiles.map(profRow)) : h('div.faint', '这里面没有游戏配置'),
        h('div.mg-label', '启动器的数据'),
        h('div.mg-opts',
          opt('settings', '用这里的启动器设置', opts.firstRun ? '新电脑恢复成原来的样子；数据位置、游戏目录不会变' : '会替换现在的主题、内存、下载源等设置；数据位置、游戏目录不会变'),
          opt('accounts', '账户', '同一个账户已经有了就保留这里的；正版账户要重新登录'),
          opt('skins', '皮肤收藏', ''),
          opt('plans', 'Mod 配置器清单', '')),
        A.alert({ level: 'info', compact: true, text: info.has.runtime ? '导入后会自动下载缺的声音、材质等资源文件。' : '导入后会联网下载游戏本体、运行库和资源文件；Forge / NeoForge 会重新运行安装程序，需要几分钟。' }));
      sync();
    }

    async function run() {
      if (foreignState) return foreignRun();
      if (!st || !st.info.ok) return false;
      if (st.accept && !st.accept.checked) return false;
      const profiles = {};
      for (const p of st.info.profiles) profiles[p.id] = st.picked.has(p.id) ? (st.choices.profiles[p.id] || (p.exists ? 'rename' : 'import')) : 'skip';
      const over = st.info.profiles.filter((p) => profiles[p.id] === 'overwrite');
      if (over.length) {
        const ok = await A.dangerConfirm({
          level: 2, title: '覆盖同名的游戏配置', okText: '覆盖导入',
          text: `这些配置会被导入的内容替换：${A.nmJoin(over.map((p) => p.id))}。原来的整个文件夹会先移到「数据目录 → backups → replaced」，需要时可以找回。`,
        });
        if (!ok) return false;
      }
      try {
        const id = await api('migrate:import', st.input, { ...st.choices, profiles });
        watch(id);
        A.toast({ level: 'info', text: '正在导入，进度在顶栏的下载 / 任务里；做完会通知你', duration: 3500, noLog: true });
        return true;
      } catch (e) { A.errorToast('导入失败', e); return false; }
    }

    m = A.modal({
      title: opts.firstRun ? '要导入以前的数据吗？' : '导入数据',
      subtitle: opts.firstRun ? '从其他启动器、旧电脑的导出包、或者这台电脑上的另一套 Aurora 数据，把游戏配置、存档、设置搬过来。不需要的话直接跳过' : '从其他启动器、导出包或另一套 Aurora 数据导入游戏配置、存档、设置',
      icon: 'import', size: 'lg', body,
      actions: [
        { label: opts.firstRun ? '跳过' : A.t('common.cancel'), kind: 'ghost' },
        { label: '开始导入', kind: 'primary', icon: 'import', ref: (b) => { goBtn = b; b.disabled = true; }, onClick: run },
      ],
    });
    // source: 'foreign' 直接到「其他启动器」那一步（rc8：设置、游戏配置页的「从其他启动器导入」按钮），「换一个来源」能回到选来源
    if (opts.file) { opts.allowBack = true; check({ file: opts.file }); } else if (opts.source === 'foreign') foreignPick(); else pickSource();
    return m;
  }

  /** 导入任务结束后刷新设置、配置列表（设置可能被换掉了） */
  function watch(taskId) {
    const off = A.on('task', async (t) => {
      if (!t || t.id !== taskId || t.status === 'running') return;
      off && off();
      try { state.config = await api('config:get'); A.emit('config', state.config); } catch { /* ignore */ }
      A.refreshInstalled().catch(() => {});
      A.refreshAccounts().catch(() => {});
    });
  }

  /** 首次启动向导完成后问一次（config.migrateAsk） */
  async function offer() {
    await A.setConfig({ migrateAsk: false }).catch(() => {});
    return importDialog({ firstRun: true });
  }

  A.migrateUi = { exportDialog, importDialog, offer, EXT };
})();
