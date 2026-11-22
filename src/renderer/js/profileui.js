'use strict';
/* 配置相关的共享界面：存档隔离、测试流程、配置档案、纯净版+ 面板、免责声明 */
(function () {
  const { h, icon, api, state, t } = A;

  // ═════════════════════ 存档与隔离 ═════════════════════
  const PRESETS = [
    { id: 'isolated', icon: 'shield', name: '完全独立', desc: '存档、配置、资源包都只属于这个配置，和其他版本互不影响' },
    { id: 'shared', icon: 'link', name: '共享存档', desc: '与来源使用同一份存档、资源包和光影，适合同一个世界换不同的 Mod 组合来玩' },
    { id: 'sandbox', icon: 'flask', name: t('term.sandbox'), desc: '每次启动前复制来源的存档与配置，游戏只修改副本——测试 Mod 更新或新版本，原存档完全不受影响' },
    { id: 'custom', icon: 'settings', name: '自定义', desc: '逐项决定独立、共享或使用副本' },
  ];
  const ITEMS = [
    ['saves', '存档', ['own', 'link', 'copy']],
    ['config', '配置文件', ['own', 'copy']],
    ['resourcepacks', '资源包', ['own', 'link']],
    ['shaderpacks', '光影包', ['own', 'link']],
    ['options', '游戏选项与按键', ['own', 'copy']],
    ['screenshots', '截图', ['own', 'link']],
  ];
  const MODE_NAME = { own: '独立', link: '共享', copy: '副本' };

  const sourceName = (src) => {
    if (!src || src === '@root') return '公共 .minecraft';
    const v = state.installed.find((x) => x.id === src);
    return v ? A.displayName(v) : src;
  };

  function isoInfo(v) {
    const p = v.isolation;
    if (!v.isolated) return { cls: 'warn', icon: 'globe', text: '公共目录', tip: '与其他未隔离的版本共用 mods、存档与配置' };
    if (!p || !p.preset || p.preset === 'isolated') return { cls: 'ok', icon: 'shield', text: `独立存档${v.worlds ? ` · ${v.worlds} 个世界` : ''}`, tip: '存档、配置都只属于这个配置' };
    if (p.preset === 'shared') return { cls: 'info', icon: 'link', text: `共享「${sourceName(p.source)}」的存档`, tip: '与来源读写同一份存档' };
    if (p.preset === 'sandbox') return { cls: 'accent', icon: 'flask', text: `${t('term.sandbox')} ← ${sourceName(p.source)}`, tip: '每次启动复制来源的存档，不会修改原存档' };
    return { cls: '', icon: 'settings', text: '自定义隔离', tip: '逐项设置的隔离策略' };
  }

  function chip(v, onClick) {
    const i = isoInfo(v);
    return h('button', { class: `iso-chip ${i.cls}`, 'data-tip': `${i.tip}（点击修改）`, onclick: (e) => { e.stopPropagation(); (onClick || (() => editor(v)))(); } }, icon(i.icon, 14), h('span', i.text));
  }

  async function editor(v) {
    let policy;
    try { policy = await api('isolation:get', v.id); } catch (e) { A.errorToast('读取隔离策略失败', e); return; }
    const p = { preset: policy.preset, source: policy.source, items: { ...policy.items }, worlds: policy.worlds, refresh: policy.refresh };
    const body = h('div');
    let worlds = null;
    let worldsFor = null;
    const others = state.installed.filter((x) => x.id !== v.id && !(x.usedAsParent && !x.hasMeta && !x.loader));

    const render = async () => {
      const needSrc = p.preset !== 'isolated';
      if (needSrc && worldsFor !== p.source) {
        worldsFor = p.source;
        worlds = null;
        api('isolation:worlds', p.source, v.id).then((w) => { if (worldsFor === p.source) { worlds = w; render(); } }).catch(() => { worlds = []; render(); });
      }
      const src = state.installed.find((x) => x.id === p.source);
      const verWarn = needSrc && p.preset !== 'sandbox' && (p.items.saves === 'link' || p.preset === 'shared') && src && src.mcVersion !== v.mcVersion;
      A.mount(body,
        // 测试副本 / 共享试玩满意了：一键留下现在用的内容（1.5.8）。直接改成「完全独立」会回到切换前自己的内容
        Object.values(policy.items).some((m) => m !== 'own') ? A.alert({
          level: 'info', icon: 'flask', title: '试玩满意了，想主玩这个配置？',
          text: '用「转为正式配置」：把现在用的存档、Mod 配置、游戏选项、光影包都留成这个配置自己的。直接选「完全独立」会回到切换之前这个配置自己的内容（可能是空的）',
          actions: [h('button.btn.sm.primary', { onclick: () => { m.close(); A.iso.promote(v); } }, icon('check', 14), '转为正式配置…')],
        }) : null,
        !v.isolated ? A.alert({ level: 'warn', title: '该配置使用公共游戏目录', text: '它和其他未隔离的版本共用 mods、存档与配置。保存隔离策略时会自动改为独立目录。' }) : null,
        h('div.choices.cols-2', PRESETS.map((x) => A.choice({
          iconName: x.icon, title: x.name, desc: x.desc, on: p.preset === x.id,
          onClick: () => { p.preset = x.id; if (x.id !== 'custom' && x.id !== 'isolated') p.items = presetItems(x.id); render(); },
        }))),
        needSrc ? h('div.field', { style: { marginTop: '14px' } }, h('label', p.preset === 'sandbox' ? '复制谁的存档' : '与谁共享'),
          A.select({
            options: [{ value: '@root', label: '公共 .minecraft 目录', sub: '官方启动器与未隔离版本使用的目录' }, ...others.map((x) => ({ value: x.id, label: A.nm(A.displayName(x)), sub: `${A.versionSub(x)} · ${x.worlds || 0} 个世界`, img: A.versionIcon(x, 48) }))],
            value: p.source, block: true, searchable: true, onChange: (val) => { p.source = val; render(); },
          })) : null,
        verWarn ? A.alert({ level: 'crit', title: `来源是 Minecraft ${A.nm(src.mcVersion)}，本配置是 ${A.nm(v.mcVersion)}`, text: `用较高的版本打开共享存档会把世界不可逆地升级，旧版本将无法再打开。建议改用「${t('term.sandbox')}」。` }) : null,
        (p.preset === 'sandbox' || (p.preset === 'custom' && p.items.saves === 'copy')) ? h('div.field',
          h('label', '要复制的世界'),
          worlds === null ? h('div.row', h('span.spinner'), h('span.muted', '读取存档…'))
            : worlds.length ? h('div.world-list', worlds.map((w) => {
              const on = !p.worlds || p.worlds.includes(w.name);
              return h('label.world-row', h('input', { type: 'checkbox', checked: on, onchange: (e) => {
                const all = worlds.map((x) => x.name);
                const set = new Set(p.worlds || all);
                if (e.target.checked) set.add(w.name); else set.delete(w.name);
                p.worlds = set.size === all.length ? null : [...set];
              } }), h('span', { style: { flex: 1 }, 'data-no-tr': '' }, w.name), h('span.faint', A.fmtRelative(w.lastPlayed)));
            })) : h('div.faint', { style: { fontSize: '12.5px' } }, '来源中还没有存档'),
          h('div.row', { style: { marginTop: '10px' } }, h('span.faint', { style: { fontSize: '12.5px' } }, '副本更新方式'),
            A.seg([{ value: 'always', label: '每次启动重新复制' }, { value: 'once', label: '保留副本中的进度' }], p.refresh, (val) => { p.refresh = val; }))) : null,
        p.preset === 'custom' ? h('div.iso-items', ITEMS.map(([k, label, modes]) => h('div.iso-item', h('span', label), A.seg(modes.map((m) => ({ value: m, label: MODE_NAME[m] })), p.items[k], (val) => { p.items[k] = val; render(); })))) : null,
        needSrc && p.preset !== 'custom' ? h('div.iso-summary', ITEMS.map(([k, label]) => h('span', { class: `badge ${p.items[k] === 'own' ? '' : p.items[k] === 'link' ? 'info' : 'accent'}` }, `${label}：${MODE_NAME[p.items[k]]}`))) : null,
        h('p.faint', { style: { fontSize: '12px', margin: '12px 0 0' } }, '切换策略时，原来属于这个配置的存档会自动移到「saves.aurora-own」保留，切回「完全独立」时恢复，不会丢失。'));
    };

    const m = A.modal({
      title: t('term.isolation'),
      subtitle: `${A.nm(A.displayName(v))} · ${A.versionSub(v)}`,
      icon: 'shield',
      size: 'lg',
      body,
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        { label: '保存', kind: '', onClick: () => save(false) },
        { label: '保存并启动', kind: 'primary', icon: 'play', onClick: () => save(true) },
      ],
    });
    render();

    async function save(launch) {
      // 公共目录的配置改成独立：先问带不带世界（1.10.9）。玩家取消就回到这个对话框，什么都没改
      const sw = await A.isoWorlds.switchToOwn(v, p);
      if (sw === false) return false;
      const r = sw || await api('isolation:set', v.id, p);
      A.toast({ level: sw && sw.failed.length ? 'warn' : 'ok', title: '隔离策略已保存', text: sw ? A.isoWorlds.resultText(sw) : r.applied && r.applied.length ? r.applied.join('，') : '下次启动时生效' });
      await A.refreshInstalled();
      if (launch) setTimeout(() => A.launch(v.id), 200);
      return true;
    }
    return m;
  }

  function presetItems(id) {
    return {
      isolated: { saves: 'own', config: 'own', resourcepacks: 'own', shaderpacks: 'own', options: 'own', screenshots: 'own' },
      shared: { saves: 'link', config: 'own', resourcepacks: 'link', shaderpacks: 'link', options: 'copy', screenshots: 'link' },
      sandbox: { saves: 'copy', config: 'copy', resourcepacks: 'link', shaderpacks: 'link', options: 'copy', screenshots: 'own' },
    }[id];
  }

  /** 安装对话框里的紧凑隔离选择 */
  function picker() {
    // 默认选中设置里「新配置的默认存档方式」；默认共享时和公共 .minecraft 共享（与主进程 markProfile 一致）
    const sharedDefault = state.config.newProfileIsolation === 'shared';
    let preset = sharedDefault ? 'shared' : 'isolated';
    let source = sharedDefault ? '@root' : (A.currentVersion() || {}).id || '@root';
    const el = h('div');
    const render = () => A.mount(el,
      A.seg([{ value: 'isolated', label: '独立存档', icon: 'shield' }, { value: 'shared', label: '共享存档', icon: 'link' }, { value: 'sandbox', label: t('term.sandbox'), icon: 'flask' }], preset, (v) => { preset = v; render(); }),
      preset !== 'isolated' ? h('div', { style: { marginTop: '10px' } }, A.select({
        options: [{ value: '@root', label: '公共 .minecraft 目录' }, ...state.installed.filter((x) => !(x.usedAsParent && !x.hasMeta && !x.loader)).map((x) => ({ value: x.id, label: A.nm(A.displayName(x)), sub: `${A.versionSub(x)} · ${x.worlds || 0} 个世界` }))],
        value: source, block: true, searchable: true, onChange: (v) => { source = v; },
      }), h('div.hint', preset === 'sandbox' ? '每次启动复制所选配置的存档，测试时不会改动原存档' : '与所选配置读写同一份存档（用高版本打开会升级存档）')) : null);
    render();
    // 「独立存档」也明确返回，主进程才会给这个配置开隔离（1.10.5：以前默认独立时返回 null，下载页装纯原版就落到了公共目录）
    return { el, get: () => (preset === 'isolated' ? { preset: 'isolated' } : { preset, source }) };
  }

  // ── 快捷测试流程 ──
  async function testNewVersion(v) {
    if (!state.manifest) { try { state.manifest = await api('versions:manifest', false); } catch (e) { A.errorToast('获取版本列表失败', e); return; } }
    let mode = 'new';
    let mc = state.manifest.latest.release;
    let target = null;
    const body = h('div');
    const nameIn = h('input.input', { value: `${mc} 测试（${A.displayName(v)}）` });
    let touched = false;
    nameIn.addEventListener('input', () => { touched = true; });
    const others = state.installed.filter((x) => x.id !== v.id && !(x.usedAsParent && !x.hasMeta && !x.loader));
    const render = () => A.mount(body,
      A.alert({ level: 'info', icon: 'flask', text: h('span', `以「${t('term.sandbox')}」启动：每次启动复制`, h('b', `「${A.nm(A.displayName(v))}」`), '的存档，新版本只会升级副本，原存档完全不受影响。') }),
      A.seg([{ value: 'new', label: '新建一个配置' }, { value: 'existing', label: '使用已有配置' }], mode, (val) => { mode = val; render(); }),
      mode === 'new' ? h('div', { style: { marginTop: '14px' } },
        h('div.field', h('label', '要测试的游戏版本'), A.select({
          options: state.manifest.versions.filter((x) => x.type === 'release' || x.type === 'snapshot').slice(0, 120).map((x) => ({ value: x.id, label: x.id, sub: `${A.TYPE_NAMES[x.type]} · ${A.fmtDate(x.releaseTime)}` })),
          value: mc, searchable: true, block: true, onChange: (val) => { mc = val; if (!touched) nameIn.value = `${val} 测试（${A.displayName(v)}）`; },
        })),
        h('div.field', h('label', '配置名称'), nameIn))
        : h('div.field', { style: { marginTop: '14px' } }, h('label', '选择配置'), others.length ? A.select({ options: others.map((x) => ({ value: x.id, label: A.nm(A.displayName(x)), sub: A.versionSub(x) })), value: target, placeholder: '选择…', block: true, searchable: true, onChange: (val) => { target = val; } }) : h('div.faint', '没有其他配置')));
    render();
    A.modal({
      title: t('term.testNewVersion'),
      subtitle: A.nm(A.displayName(v)),
      icon: 'flask',
      size: 'md',
      body,
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: mode === 'new' ? '安装并设置' : '设置并启动', kind: 'primary', icon: 'flask',
          onClick: async () => {
            const iso = { preset: 'sandbox', source: v.id };
            if (mode === 'new') {
              const name = nameIn.value.trim();
              const bad = A.nameProblem(name) || (state.installed.some((x) => x.id.toLowerCase() === name.toLowerCase()) ? '已存在同名配置' : null);
              if (bad) { A.toast({ level: 'warn', text: bad }); return false; }
              await api('versions:install', { mc, name, asProfile: true, profileType: 'vanilla', isolation: iso });
              A.toast({ level: 'info', title: '已开始安装', text: `${A.nm(name)} 安装完成后即可启动测试` });
            } else {
              if (!target) { A.toast({ level: 'warn', text: '请选择一个配置' }); return false; }
              await api('isolation:set', target, iso);
              await A.refreshInstalled();
              A.launch(target);
            }
            return true;
          },
        },
      ],
    });
  }

  async function modUpdateCopy(v) {
    const name = await A.prompt(t('term.modUpdateCopy'), {
      value: `${A.displayName(v)} 更新测试`,
      label: '副本名称',
      hint: `会复制这个配置的 Mod 与配置（不复制存档），存档使用原配置存档的${t('term.sandbox')}。你可以放心地在副本里更新 Mod，确认没问题后再更新原配置。`,
      validate: (s) => A.nameProblem(s) || (state.installed.some((x) => x.id.toLowerCase() === s.toLowerCase()) ? '已存在同名配置' : null),
    });
    if (!name) return;
    try {
      A.toast({ level: 'info', text: '正在创建副本…' });
      await api('profiles:duplicate', v.id, name, { saves: 'none', isolation: { preset: 'sandbox', source: v.id } });
      await A.refreshInstalled();
      A.toast({ level: 'ok', title: '副本已创建', text: `${A.nm(name)}：存档使用「${A.nm(A.displayName(v))}」的${t('term.sandbox')}`, actions: [{ label: '检查 Mod 更新', onClick: () => A.go('mods', { versionId: name }) }] });
    } catch (e) { A.errorToast('创建副本失败', e); }
  }

  // ═════════════════════ 配置档案 ═════════════════════
  async function archive(container, v) {
    A.mount(container, h('div.row', h('span.spinner'), h('span.muted', '读取配置档案…')));
    let d;
    try { d = await api('profiles:detail', v.id); } catch (e) { A.mount(container, h('div.err', e.message)); return; }
    const s = d.stats || {};
    const hst = d.history || {};
    const g = d.game || {};
    const stat = (val, label) => h('div.arc-stat', h('b', val), h('span', label));
    const when = (t) => (t ? `${A.fmtDate(t)} ${new Date(t).toTimeString().slice(0, 5)}` : '—');
    A.mount(container,
      h('div.arc-stats',
        stat(A.fmtDuration(s.playTime), '游玩时间'),
        stat(s.launchCount || 0, '启动次数'),
        stat(s.crashCount || 0, '崩溃次数'),
        stat(d.saves ? d.saves.count : 0, '存档'),
        stat(s.lastPlayed ? A.fmtRelative(s.lastPlayed) : '—', '上次游玩'),
        stat(s.testCount || 0, '测试启动')),
      h('div.arc-game',
        h('span', `Minecraft ${A.nm(g.minecraft || v.mcVersion)}`),
        g.loader ? h('span', `${(A.LOADERS[g.loader.type] || {}).name || g.loader.type} ${g.loader.version || ''}`) : null,
        g.apiVersion ? h('span', `API ${g.apiVersion}`) : null,
        d.modCount ? h('span', `${d.modCount.enabled}/${d.modCount.total} 个 Mod`) : null,
        h('span', `创建于 ${A.fmtDate(s.createdAt || d.createdAt)}`)),
      h('div.arc-sec', h('h5', icon('history', 14), '启动记录'),
        (hst.launches || []).length ? h('div.arc-list', hst.launches.slice(0, 8).map((l) => h('div.arc-row',
          h('span', when(l.at)), h('span.faint', A.fmtDuration(l.duration)), h('div.spacer'),
          l.test ? h('span.badge', '测试') : null,
          l.crashed ? h('span.badge.crit', `崩溃 · ${l.exitCode}`) : h('span.badge.ok', '正常')))) : h('div.faint.arc-empty', '还没有启动过')),
      h('div.arc-sec', h('h5', icon('xCircle', 14), '崩溃记录'),
        (hst.crashes || []).length ? h('div.arc-list', hst.crashes.slice(0, 6).map((c) => h('div.arc-row.col',
          h('div.row', h('b', when(c.at)), h('span.badge.crit', `代码 ${c.exitCode}`), h('div.spacer'),
            c.logFile ? h('button.btn.sm.ghost', { onclick: () => api('profiles:openLog', c.logFile).catch((e) => A.errorToast('无法打开', e)) }, icon('file', 14), '日志快照') : null,
            c.reportPath ? h('button.btn.sm.ghost', { onclick: () => api('shell:open', c.reportPath).catch((e) => A.errorToast('无法打开', e)) }, '崩溃报告') : null),
          h('div.faint', { style: { fontSize: '12px' } }, (c.reasons || []).join('；') || '未识别原因')))) : h('div.faint.arc-empty', '没有崩溃记录')),
      h('div.arc-sec', h('h5', icon('shield', 14), '排查记录'),
        (hst.troubleshoot || []).length ? h('div.arc-list', hst.troubleshoot.slice(0, 8).map((r) => h('div.arc-row',
          h('span', when(r.at)), h('span', { class: `badge ${r.ok ? 'ok' : 'warn'}` }, { test: t('term.test'), bisect: t('term.bisect'), debug: t('term.debug'), fix: '修复', edit: `${t('term.planner')}修改` }[r.kind] || r.kind),
          h('span.arc-sum', r.summary)))) : h('div.faint.arc-empty', '还没有排查记录')),
      h('div.faint', { style: { fontSize: '11.5px', marginTop: '10px' } }, `以上信息保存在版本目录下的 aurora-profile.json（${t('term.archive')}格式 v${d.formatVersion}），${t('term.exportArchive')}时会一并带上。`));
  }

  // ═════════════════════ 额外 Mod（通用） ═════════════════════
  /**
   * 任何方式创建 Mod 配置时都可以附加：Modrinth 上自选的 Mod + 本地 jar（拖入或选择）
   */
  // Mod 的中文名：MC 百科缓存（只读缓存，不联网）→ 本地对照表；百科的译名优先（1.6.1）。1.5.9：创建配置页的纯净版+ 选项和额外 Mod 以前只显示英文名
  const zhCache = new Map();
  const zhAsked = new Set();
  const zhName = (p) => zhCache.get(A.mcmodUi.keyOf(A.mcmodUi.projOf(p))) || A.modNames.zhOf(p) || '';
  // 本来就是中文的说明（如「完整套件（Sodium + …）」）不再加
  const withZh = (p) => { const zh = /[一-鿿]/.test(p.title) ? '' : zhName(p); return zh ? `${zh} ${p.title}` : p.title; };
  async function loadZh(projects, then) {
    const need = projects.filter((p) => p && (p.slug || p.id)).map((p) => A.mcmodUi.projOf(p)).filter((p) => !zhAsked.has(A.mcmodUi.keyOf(p)));
    if (!need.length) return;
    need.forEach((p) => zhAsked.add(A.mcmodUi.keyOf(p)));
    let got = false;
    for (const [k, i] of await A.mcmodUi.cachedMap(need)) if (i && i.zh) { zhCache.set(k, i.zh); got = true; }
    if (got) then();
  }

  function extraMods({ mc, loader, compact, onChange } = {}) {
    const st = { mc, loader, extra: [], local: [] };
    const el = h('div.extra-mods');
    const render = () => {
      if (onChange) onChange(st.extra.length + st.local.length);
      const chips = [
        ...st.extra.map((p, i) => h('span.vp-chip', p.icon ? h('img', { src: p.icon }) : null, withZh(p), h('button', { onclick: () => { st.extra.splice(i, 1); render(); } }, icon('x', 12)))),
        ...st.local.map((f, i) => h('span.vp-chip.local', icon('file', 12), A.nm(f.split(/[\\/]/).pop()), h('button', { onclick: () => { st.local.splice(i, 1); render(); } }, icon('x', 12)))),
      ];
      A.mount(el,
        chips.length ? h('div.vp-extra', chips) : null,
        h('div.vp-drop', icon('import', 16), h('span', compact ? '拖入 .jar，或' : '把 .jar 拖到这里，或'),
          h('button.btn.sm', {
            disabled: !st.loader,
            'data-tip': st.loader ? null : '请先选择 Mod 加载器',
            onclick: () => A.modkit.modrinthPicker({ mc: st.mc, loader: st.loader, mode: 'select', title: '添加额外的 Mod', exclude: new Set(st.extra.map((x) => x.id)), onPick: (p) => { st.extra.push(p); render(); loadZh([p], render); } }),
          }, icon('globe', 14), '在 Modrinth 中挑选'),
          h('button.btn.sm', { onclick: async () => { const fs = await api('dialog:file', '选择 Mod 文件', [{ name: 'Mod 文件', extensions: ['jar', 'zip'] }], true); if (fs) { add(fs); } } }, icon('file', 14), '选择文件')),
        compact ? null : h('div.faint', { style: { fontSize: '11.5px', marginTop: '6px' } }, '本地 jar 会原样复制到 mods 文件夹（适合论坛下载的经典 Mod、自己开发的 Mod 等），安装后会自动检查并补齐缺失的前置'));
    };
    const add = (files) => {
      const jars = files.filter((p) => /\.(jar|zip)$/i.test(p));
      if (!jars.length) { A.toast({ level: 'warn', text: '只支持 .jar / .zip 格式的 Mod 文件' }); return; }
      st.local.push(...jars.filter((f) => !st.local.includes(f)));
      render();
    };
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('drop-hover'); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-hover'); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-hover');
      add([...e.dataTransfer.files].map((f) => window.aurora.pathForFile(f)).filter(Boolean));
    });
    render();
    return {
      el,
      setTarget: (m, l) => { st.mc = m || st.mc; st.loader = l; render(); },
      get: () => ({ extraProjects: st.extra.map((p) => p.id), localFiles: [...st.local] }),
      count: () => st.extra.length + st.local.length,
    };
  }

  /** 安装整合包（Modrinth 或文件）时的确认框，也可以附加额外 Mod */
  function modpackInstallDialog({ title, subtitle, name, mc, loader, summary, badges, onConfirm }) {
    const nameIn = h('input.input', { value: name });
    const extras = extraMods({ mc, loader, compact: true });
    const iso = picker();
    A.modal({
      title,
      subtitle,
      icon: 'box',
      size: 'md',
      body: h('div',
        summary ? h('p.muted', { style: { marginTop: 0 } }, summary) : null,
        badges ? h('div.row.wrap', { style: { marginBottom: '14px' } }, badges) : null,
        h('div.field', h('label', '配置名称'), nameIn),
        h('div.field', h('label', '额外 Mod（可选）'), extras.el),
        h('div.field', h('label', '存档'), iso.el)),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        { label: '安装', kind: 'primary', icon: 'download', onClick: () => onConfirm(nameIn.value.trim(), extras.get(), iso.get()) },
      ],
    });
  }

  // ═════════════════════ 怀旧版本 ═════════════════════
  const ERAS = [
    { id: 'alpha', name: '远古时代', years: '2009 – 2011', kind: 'old', desc: 'Classic、Alpha 与 Beta：没有饥饿、没有附魔、没有末地的最初体验', note: '只能以原版运行；当年的皮肤服务器与正版验证已关闭，皮肤会显示为默认的 Steve', pick: 'old' },
    { id: 'early', name: '正式版初期', years: '2011 – 2013', kind: 'grass', desc: '1.0 ~ 1.5.2：末地、村民交易、红石比较器登场', versions: ['1.5.2', '1.4.7', '1.2.5'], note: '1.5.2 可以使用 Forge（附带经典的 NEI 合成表）' },
    { id: '164', name: '1.6.4', years: '2013', kind: 'snapshot', desc: '马与新启动器诞生，大量经典 Mod 的最后一个老格式版本', versions: ['1.6.4'], note: '可使用 Forge 或 Legacy Fabric' },
    { id: '1710', name: '1.7.10 · 模组黄金年代', years: '2014', kind: 'forge', desc: 'GregTech、Thaumcraft、BuildCraft、IC2 等经典模组的家园', versions: ['1.7.10'], note: '推荐 Forge；Modrinth 上有 Xaero 小地图、JourneyMap 与 NEI 的社区版' },
    { id: '189', name: '1.8.9 · PvP 时代', years: '2015', kind: 'diamond', desc: '经典的战斗系统，PvP 与小游戏服务器的首选版本', versions: ['1.8.9'], note: '可使用 Forge 或 Legacy Fabric' },
    { id: '1122', name: '1.12.2 · 大型整合包时代', years: '2017', kind: 'neoforge', desc: '最长寿的模组版本，几乎所有大型整合包都有 1.12.2 版本', versions: ['1.12.2'], note: '推荐 Forge；JEI、Xaero、AppleSkin 等都有该版本' },
  ];

  async function nostalgiaDialog() {
    if (!state.manifest) { try { state.manifest = await api('versions:manifest', false); } catch (e) { A.errorToast('获取版本列表失败', e); return; } }
    const old = state.manifest.versions.filter((v) => v.type === 'old_alpha' || v.type === 'old_beta');
    const body = h('div');
    let m;
    const pickEra = (era) => {
      const list = era.pick === 'old' ? old.map((v) => v.id) : era.versions;
      let mc = era.pick === 'old' ? (old.find((v) => v.id === 'b1.7.3') || old[0]).id : list[0];
      A.mount(body,
        h('div.era-head', h('img', { src: A.blockImage(era.kind, 96), alt: '' }), h('div', h('div.era-name', era.name), h('div.faint', `${era.years} · ${era.desc}`))),
        h('div.field', { style: { marginTop: '16px' } }, h('label', '选择版本'),
          era.pick === 'old'
            ? A.select({ options: old.map((v) => ({ value: v.id, label: v.id, sub: `${A.TYPE_NAMES[v.type]} · ${A.fmtDate(v.releaseTime)}` })), value: mc, searchable: true, block: true, onChange: (v) => { mc = v; } })
            : h('div.chips', list.map((v) => h('button', { class: `chip ${v === mc ? 'on' : ''}`, onclick: (e) => { mc = v; e.currentTarget.parentNode.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget)); } }, v)))),
        A.alert({ level: 'info', text: era.note }),
        h('ul.era-tips',
          h('li', '旧版本会自动使用 Java 8 运行（找不到时自动下载 Mojang 官方的 Java 8）'),
          h('li', '自动处理旧版资源（声音、语言）与 LWJGL 2 本地库，并在首次启动时设为简体中文'),
          h('li', `默认独立存档；也可以选择「${t('term.sandbox')}」，用新版本的存档在旧版本中怀旧`),
          h('li', 'OptiFine、Rei\'s Minimap、InventoryTweaks 等经典 Mod 不在 Modrinth 上，可在下一步的「额外 Mod」中拖入自己下载的 jar')));
      m.setSteps({ items: NOSTALGIA_STEPS, current: 1 });
      m.setActions([
        { label: t('common.back'), kind: 'ghost', onClick: () => { renderEras(); return false; } },
        { label: t('common.next'), kind: 'primary', onClick: () => { setTimeout(() => A.installDialog(mc, { asProfile: true, nostalgia: era.id, vanillaOnly: era.pick === 'old', steps: { items: NOSTALGIA_STEPS, current: 2 } }), 50); return true; } },
      ]);
    };
    const renderEras = () => {
      A.mount(body, h('div.choices.cols-2', ERAS.map((e) => A.choice({
        img: A.blockImage(e.kind, 96), title: e.name, desc: h('span', h('span.ch-em', e.years), ` · ${e.desc}`), onClick: () => pickEra(e),
      }))));
      if (m) { m.setActions([]); m.setSteps({ items: NOSTALGIA_STEPS, current: 0 }); }
    };
    m = A.modal({ title: t('term.nostalgia'), subtitle: '为回到当年的玩家准备：按年代挑选经典版本，自动配置合适的 Java 与加载器', icon: 'clock', size: 'lg', steps: { items: NOSTALGIA_STEPS, current: 0 }, body, actions: [] });
    renderEras();
  }
  const NOSTALGIA_STEPS = [t('steps.era'), t('steps.version'), t('steps.loader')];

  // ═════════════════════ 一键 Debug / 禁用全部 Mod ═════════════════════
  /**
   * 一键 Debug。auto 为 true 时跳过开始前的确认（安装完成后自动运行、中断后重新开始）；
   * 测试启动会不会自动关游戏的说明在确认框和进度对话框里都显示
   */
  async function debugDialog(v, { auto = false } = {}) {
    if (!auto) {
      const ok = await A.confirm(`${t('term.debug')} 会依次：\n① ${t('term.check')}：分析 Mod 元数据，自动安装缺失的前置、禁用重复 / 不兼容 / 版本不符的 Mod（冲突时保留较早安装的那个）\n② ${t('term.test')}，并根据日志继续修复\n③ 仍然失败时自动${t('term.bisect')}，找出问题 Mod 并禁用\n\n所有改动都可以在结束后一键撤销。`, {
        title: `${t('term.debug')} · ${A.nm(A.displayName(v))}`, okText: '开始', icon: 'wrench', size: 'md',
        detail: A.alert({ level: 'info', compact: true, title: '过程中会多次弹出游戏窗口', text: `${t('test.how')}\n${t('test.dont')}` }),
      });
      if (!ok) return;
    }
    const stepsEl = h('div.dbg-steps');
    const statusEl = h('div');
    // 只改文字：测试启动时每 0.5 秒更新一次，重建整块时屏幕阅读器会反复朗读
    let runEl = null;
    const running = (detail) => {
      if (!runEl || !runEl.isConnected) { runEl = A.alert({ level: 'info', icon: 'wrench', title: '正在排查…', text: ' ' }); A.mount(statusEl, runEl); }
      const tx = runEl.querySelector('.alert-text');
      A.setText(tx, detail || '');
      tx.classList.toggle('hidden', !detail);
    };
    running();
    const off = A.listen('debug:step', (s) => {
      if (s.versionId !== v.id) return;
      const ico = { ok: 'checkCircle', fail: 'xCircle', fix: 'wrench', warn: 'alert', bisect: 'filter', test: 'play', static: 'shield' }[s.phase] || 'info';
      stepsEl.appendChild(h('div', { class: `dbg-step ${s.phase}` }, icon(ico, 14), h('span', s.text)));
      stepsEl.scrollTop = stepsEl.scrollHeight;
    });
    // 测试启动时任务的 detail 是「等待主菜单 / 几秒后关闭」，实时显示出来
    const offTask = A.on('task', (tk) => { if (tk.kind === 'test' && tk.status === 'running' && tk.meta && tk.meta.name === v.id) running(tk.detail); });
    const cancelTasks = async () => { for (const tk of state.tasks.values()) if (tk.kind === 'test' && tk.status === 'running' && tk.meta.name === v.id) await api('tasks:cancel', tk.id); return false; };
    const m = A.modal({
      title: t('term.debug'), subtitle: A.nm(A.displayName(v)), icon: 'wrench', size: 'lg', dismissable: false,
      body: h('div', statusEl, A.alert({ level: 'info', compact: true, className: 'dbg-note', text: `${t('test.how')}\n${t('test.dont')}` }), stepsEl),
      actions: [{ label: t('common.cancel'), kind: 'ghost', onClick: cancelTasks }],
    });
    const done = () => { off(); offTask(); const n = m.el.querySelector('.dbg-note'); if (n) n.remove(); };
    let r;
    try {
      r = await api('troubleshoot:debug', v.id);
    } catch (e) {
      done();
      A.mount(statusEl, A.alert({ level: e.cancelled ? 'warn' : 'crit', title: e.cancelled ? '已取消' : `出错了：${e.message}` }));
      m.setActions([{ label: t('common.close'), kind: 'primary' }]);
      m.setDismissable(true);
      return;
    }
    done();
    const changeText = `共改动 ${r.changes.length} 处${r.unresolved.length ? `；Modrinth 上找不到：${A.nmJoin(r.unresolved)}` : ''}`;
    A.mount(statusEl, r.interrupted
      ? A.alert({ level: 'warn', title: t('test.interrupted'), text: `${t('test.interruptedHint')}\n${changeText}` })
      : r.warn ? A.alert({ level: 'warn', title: t('test.passWarn'), text: `${t('test.passWarnText')}${r.changes.length ? `\n${changeText}` : ''}` })
      // 需要更高版本的 Java：换 Mod 解决不了，给「用 Java N 再测一次」
      : r.javaNeed ? A.alert({ level: 'crit', title: t('java.modNeedTitle', { n: r.javaNeed }), text: `${(r.lastIssues.find((i) => i.type === 'java-version') || {}).detail || ''}${r.changes.length ? `\n${changeText}` : ''}` })
      : r.ok && !r.changes.length ? A.alert({ level: 'ok', title: '没有发现问题，游戏可以正常进入主菜单' })
        : A.alert({ level: r.ok ? 'ok' : 'warn', title: r.ok ? '修复完成，游戏可以正常进入主菜单' : '未能完全修复', text: changeText }));
    if (r.changes.length) {
      stepsEl.appendChild(h('div.dbg-changes', h('b', '本次改动'), r.changes.map((c) => h('div.dbg-change', h('span', { class: `badge ${c.type === 'install' ? 'ok' : 'warn'}` }, { install: '安装', tweak: '改设置' }[c.type] || '禁用'), h('span', A.nm(c.file) || c.title), h('span.faint', c.why)))));
    }
    if (!r.ok && r.lastIssues.length) stepsEl.appendChild(A.modkit.issueList(r.lastIssues, { versionId: v.id, mc: v.mcVersion }));
    const nb = r.ok && A.notices.block(r, { versionId: v.id, mc: v.mcVersion, showLog: true });
    if (nb) statusEl.appendChild(nb);
    const primary = r.ok ? { label: '启动游戏', kind: 'primary', icon: 'play', onClick: () => { A.launch(v.id); } }
      : r.interrupted ? { label: t('test.retry'), kind: 'primary', icon: 'refresh', onClick: () => { setTimeout(() => debugDialog(v, { auto: true }), 200); } }
        : r.javaNeed ? { label: t('java.retest', { n: r.javaNeed }), kind: 'primary', icon: 'coffee', onClick: () => { setTimeout(() => A.javaRetest(v.id, r.javaNeed), 200); } }
        : { label: t('common.close'), kind: 'primary' };
    // 做完了：右上角可以关，也有「关闭」按钮，只想回去不想启动游戏时不会卡住（1.4.7）
    m.setDismissable(true);
    m.setActions([
      r.changes.length ? { label: '撤销全部改动', kind: 'ghost', left: true, icon: 'history', onClick: async () => { const n = await api('troubleshoot:undo', v.id, r.changes); A.toast({ level: 'ok', text: `已撤销 ${n} 处改动` }); return true; } } : null,
      { label: '查看 Mod', kind: '', onClick: () => { A.go('mods', { versionId: v.id }); } },
      { label: '全面检测', kind: '', icon: 'shield', onClick: () => { A.go('repair', { versionId: v.id }); } },
      primary.label !== t('common.close') ? { label: t('common.close'), kind: '' } : null,
      primary,
    ].filter(Boolean));
  }

  async function toggleAllMods(v) {
    try {
      if (v.modsOff) {
        const r = await api('mods:restoreAll', v.id);
        A.toast({ level: 'ok', title: `已${t('term.restoreAll')}`, text: `重新启用了 ${r.enabled} 个 Mod` });
      } else {
        const r = await api('mods:disableAll', v.id);
        A.toast({ level: 'info', title: `已${t('term.disableAll')}`, text: `${r.disabled} 个 Mod 已暂时禁用，现在启动将以“无 Mod”状态运行（加载器仍然生效）。之后可以「${t('term.restoreAll')}」。` });
      }
      await A.refreshInstalled();
    } catch (e) { A.errorToast('操作失败', e); }
  }

  // ═════════════════════ 纯净版+ 面板 ═════════════════════
  function vanillaPlus(mc, { onLoader } = {}) {
    const st = { loader: null, loaders: null, catalog: null, choices: {}, shaders: null, shaderIds: [], loading: false };
    const extras = extraMods({ mc, loader: null });
    const el = h('div.vp');
    const old = (() => { const m = String(mc).match(/^1\.(\d+)/); return m ? Number(m[1]) < 14 : false; })();

    async function loadLoaders() {
      const types = old ? ['forge', 'legacyfabric'] : ['fabric', 'neoforge', 'forge', 'quilt'];
      const out = {};
      await Promise.all(types.map(async (t) => { try { out[t] = (await api('loaders:list', t, mc)).length; } catch { out[t] = 0; } }));
      st.loaders = out;
      st.loader = types.find((t) => out[t] > 0) || null;
      if (onLoader) onLoader(st.loader);
      await loadCatalog();
    }

    async function loadCatalog() {
      if (!st.loader) { render(); return; }
      st.loading = true;
      render();
      try {
        st.catalog = await api('vanillaplus:catalog', mc, st.loader);
        st.choices = {};
        for (const f of st.catalog.features) if (f.default && f.available) st.choices[f.id] = f.recommended;
        if (!st.shaders) {
          api('vanillaplus:shaders', mc).then((s) => { st.shaders = s; if (!st.shaderIds.length && s[0]) st.shaderIds = [s[0].id]; render(); }).catch(() => { st.shaders = []; render(); });
        }
      } catch (e) { st.catalog = { error: e.message, features: [] }; }
      st.loading = false;
      render();
      loadZh(st.catalog.features.flatMap((f) => f.options), render);
    }

    function featureRow(f) {
      const on = !!st.choices[f.id];
      const avail = f.options.filter((o) => o.available);
      const cur = avail.find((o) => o.id === st.choices[f.id]) || avail[0];
      return h('div', { class: `vp-row ${f.available ? '' : 'na'} ${on ? 'on' : ''}` },
        h('label.vp-check', h('input', { type: 'checkbox', checked: on, disabled: !f.available, onchange: (e) => { if (e.target.checked) st.choices[f.id] = cur.id; else delete st.choices[f.id]; render(); } })),
        h('div.vp-body',
          h('div.vp-name', f.name, !f.available ? h('span.badge', '此版本暂无') : null),
          h('div.vp-desc', f.desc)),
        f.available ? (avail.length > 1
          ? A.select({ options: avail.map((o) => ({ value: o.id, label: withZh(o), sub: [o.note, o.with.length ? `附带 ${o.with.join('、')}` : '', `${A.fmtNum(o.downloads)} 下载`].filter(Boolean).join(' · '), img: o.icon })), value: cur.id, small: true, width: 210, menuWidth: 340, onChange: (val) => { st.choices[f.id] = val; if (!on) render(); } })
          : h('span.vp-one', cur.icon ? h('img', { src: cur.icon }) : null, withZh(cur))) : null);
    }

    function render() {
      if (!st.loaders) { A.mount(el, h('div.row', h('span.spinner'), h('span.muted', '检查可用的加载器…'))); return; }
      const types = Object.keys(st.loaders);
      const loaderSeg = A.seg(types.map((t) => ({ value: t, label: `${A.LOADERS[t].name}${st.loaders[t] ? '' : '（不可用）'}` })), st.loader, async (v) => {
        if (!st.loaders[v]) { A.toast({ level: 'warn', text: `${A.LOADERS[v].name} 不支持 Minecraft ${mc}` }); render(); return; }
        st.loader = v; if (onLoader) onLoader(v); await loadCatalog();
      });
      if (!st.loader) { A.mount(el, h('div.err', `Minecraft ${mc} 没有可用的 Mod 加载器`)); return; }
      const groups = st.catalog && st.catalog.groups ? st.catalog.groups : {};
      const feats = (st.catalog && st.catalog.features) || [];
      const shadersOn = !!st.choices.shaders;
      A.mount(el,
        h('div.vp-loader', h('span.faint', 'Mod 加载器'), loaderSeg, old ? h('span.faint', { style: { fontSize: '11.5px' } }, '旧版本：可用 Forge 或 Legacy Fabric') : null),
        st.loading ? h('div.row', { style: { padding: '20px 0' } }, h('span.spinner'), h('span.muted', '检查每类 Mod 在该版本上的可用性…')) : null,
        st.catalog && st.catalog.error ? h('div.err', st.catalog.error) : null,
        !st.loading ? Object.entries(groups).map(([gid, gname]) => {
          const list = feats.filter((f) => f.group === gid);
          if (!list.length) return null;
          return h('div.vp-group', h('div.vp-gh', h('b', gname), h('span.faint', `${list.filter((f) => st.choices[f.id]).length}/${list.filter((f) => f.available).length}`)), list.map(featureRow));
        }) : null,
        shadersOn && !st.loading ? h('div.vp-group', h('div.vp-gh', h('b', '光影包'), h('span.faint', '可多选，第一个会被自动启用')),
          st.shaders === null ? h('div.row', h('span.spinner'), h('span.muted', '获取热门光影…'))
            : h('div.vp-shaders', st.shaders.map((s) => {
              const sel = st.shaderIds.includes(s.id);
              return h('div', { class: `vp-shader ${sel ? 'on' : ''}`, onclick: () => { st.shaderIds = sel ? st.shaderIds.filter((x) => x !== s.id) : [...st.shaderIds, s.id]; render(); } },
                h('img', { src: s.gallery || s.icon || A.blockImage('diamond', 64), loading: 'lazy' }),
                h('div.vs-name', A.nm(s.title)), sel ? h('span.vs-check', icon('check', 12, 3)) : null);
            }))) : null,
        !st.loading ? h('div.vp-group', h('div.vp-gh', h('b', '额外 Mod'), h('span.faint', '想再加点自己喜欢的？')), extras.el) : null);
      extras.setTarget(mc, st.loader);
    }

    render();
    loadLoaders();
    return {
      el,
      ready: () => !!st.loader && !!st.catalog && !st.loading,
      get: () => ({ loader: { type: st.loader }, choices: { ...st.choices }, ...extras.get(), shaderIds: st.choices.shaders ? [...st.shaderIds] : [] }),
      summary: () => `${Object.keys(st.choices).length} 项功能${extras.count() ? ` + ${extras.count()} 个额外 Mod` : ''}`,
    };
  }

  // ═════════════════════ 免责声明 ═════════════════════
  async function disclaimer({ force = false } = {}) {
    let d;
    try { d = await api('app:disclaimer'); } catch { return true; }
    if (d.accepted && !force) return true;
    const mustAccept = !d.accepted;
    return new Promise((resolve) => {
      const check = h('input', { type: 'checkbox' });
      let okBtn;
      check.addEventListener('change', () => { if (okBtn) okBtn.disabled = !check.checked; });
      const body = h('div',
        h('div.disc-body', h('p.muted', { style: { marginTop: 0 } }, `在使用 ${A.BRAND.name} 之前，请仔细阅读以下声明。使用本启动器即表示你已阅读、理解并同意本声明的全部内容。`),
          // 译本注明以中文版为准
          window.I18N.getLang() !== 'zh-CN' ? h('p.muted', { style: { fontWeight: 600 } }, '本声明的译文仅供参考，与简体中文版有出入时，以简体中文版为准。') : null,
          d.sections.map((s) => h('div.disc-sec', h('h4', s.title), h('ol', s.items.map((it) => h('li', it)))))),
        mustAccept ? h('label.disc-agree', check, '我已阅读并同意上述免责声明') : null);
      A.modal({
        title: '免责声明',
        subtitle: `版本 ${d.version} · 更新于 ${d.updated}`,
        icon: 'file',
        size: 'lg',
        dismissable: !mustAccept,
        body,
        actions: mustAccept ? [
          { label: '不同意并退出', kind: 'ghost', onClick: () => { api('app:quit'); return false; } },
          { label: '同意并继续', kind: 'primary', ref: (b) => { okBtn = b; b.disabled = true; }, onClick: async () => { await api('app:acceptDisclaimer', d.version); resolve(true); } },
        ] : [{ label: t('common.close'), kind: 'primary', onClick: () => resolve(true) }],
        onClose: () => resolve(true),
      });
    });
  }

  A.iso = { chip, editor, picker, info: isoInfo, testNewVersion, modUpdateCopy, sourceName };
  A.profileArchive = archive;
  A.vanillaPlusPanel = vanillaPlus;
  A.extraMods = extraMods;
  A.modpackInstallDialog = modpackInstallDialog;
  A.nostalgiaDialog = nostalgiaDialog;
  A.debugDialog = debugDialog;
  A.toggleAllMods = toggleAllMods;
  A.disclaimer = disclaimer;
})();
