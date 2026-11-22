'use strict';
/* 配置的组件管理：配置设置抽屉最上面的「组件」区 + 更换 MC / 加载器的对话框 + OptiFine 对话框 */
(function () {
  const { h, icon, api, state } = A;
  const FABRIC_LIKE = ['fabric', 'quilt', 'legacyfabric'];
  const MOD_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'];
  const LN = (type) => (A.LOADERS[type] || {}).name || type;
  const loaderText = (l) => (l ? `${LN(l.type)}${l.version ? ` ${l.version}` : ''}` : '无（纯净版）');
  const REASON = {
    notfound: '新版本上没有这个 Mod，会禁用',
    unknown: '认不出来源（不是从 Modrinth / CurseForge 装的），会禁用',
    manual: '作者不允许第三方下载新版本，会禁用，可以自己去 CurseForge 下载',
    noloader: '没有加载器后不会加载，会禁用',
  };

  async function ensureManifest() {
    if (!state.manifest) state.manifest = await api('versions:manifest', false);
    return state.manifest;
  }

  const started = (title) => A.toast({ level: 'info', title, text: '进度在任务中心，完成后会通知你', actions: [{ label: '打开任务中心', onClick: () => A.go('tasks') }] });

  async function run(channel, title, ...args) {
    try { await api(channel, ...args); started(title); } catch (e) { A.errorToast(`${title}失败`, e); }
  }

  // ── 抽屉里的「组件」区 ──
  function section(v) {
    const box = h('div.comp-list', h('div.row.gap-s', h('span.spinner.sm'), h('span.faint', '正在读取组件…')));
    let info = null;
    const load = async () => {
      try { info = await api('components:info', v.id); render(); } catch (e) { A.mount(box, A.alert({ level: 'warn', compact: true, text: `读取组件失败：${e.message}` })); }
    };
    const off = A.listen('versions:changed', () => { if (!box.isConnected) { if (off) off(); return; } load(); });
    const btn = (label, onClick, opts = {}) => h(`button.btn.sm${opts.ghost ? '.ghost' : ''}${opts.danger ? '.danger' : ''}`, { onclick: onClick, disabled: !!opts.disabled, 'data-tip': opts.tip || null }, opts.icon ? icon(opts.icon, 14) : null, label);
    const row = (ic, name, value, sub, buttons) => h('div.comp-row',
      h('div.comp-ico', icon(ic, 16)),
      h('div.comp-main', h('div.comp-name', name, h('span.comp-val', value)), sub ? h('div.comp-sub', sub) : null),
      h('div.comp-btns', buttons.filter(Boolean)));

    function render() {
      const l = info.loader;
      const type = l && l.type;
      const modLoader = type && MOD_LOADERS.includes(type);
      const rows = [];
      rows.push(row('box', 'Minecraft', A.nm(info.mc), null, [btn('更换版本', () => changeDialog(v, info, 'mc'), { icon: 'refresh' })]));
      if (modLoader) {
        rows.push(row('puzzle', 'Mod 加载器', loaderText(l), null, [
          btn('更换', () => changeDialog(v, info, 'loader'), { icon: 'refresh' }),
          btn('卸载', () => uninstallLoader(v, info), { ghost: true, danger: true }),
        ]));
      } else {
        rows.push(row('puzzle', 'Mod 加载器', type === 'optifine' ? '无（现在是 OptiFine）' : '无（纯净版）',
          type === 'optifine' ? '装 Mod 加载器会替换掉 OptiFine；想在 Forge / Fabric 上用 OptiFine，装好加载器后再在下面装' : '装了加载器才能用 Mod',
          [btn('安装加载器', () => changeDialog(v, info, 'loader'), { icon: 'plus' })]));
      }
      if (modLoader && FABRIC_LIKE.includes(type)) {
        rows.push(row('layers', 'Fabric API', info.api ? info.api.version || info.api.file : '未安装', info.api ? null : '大部分 Fabric Mod 都需要它',
          info.api
            ? [btn('更新', () => run('components:updateMod', '更新 Fabric API', v.id, info.api.file)), btn('卸载', () => removeMod(v, info.api, 'Fabric API'), { ghost: true, danger: true })]
            : [btn('安装', () => run('components:installApi', '安装 Fabric API', v.id), { icon: 'download' })]));
      }
      // OptiFine
      const of = info.optifine;
      let ofSub = null;
      let ofBtns = [];
      if (type === 'neoforge') {
        ofSub = 'OptiFine 不支持 NeoForge，想要光影请装下面的 Oculus（会带上 Embeddium）';
      } else if (of) {
        ofSub = of.mode === 'loader' ? '作为加载器装在这个配置里' : `在 mods 文件夹里${info.optifabric ? '（带 OptiFabric）' : ''}`;
        ofBtns = [btn('卸载', () => removeOptifine(v, info), { ghost: true, danger: true })];
      } else if (!type || type === 'forge' || FABRIC_LIKE.includes(type)) {
        ofSub = FABRIC_LIKE.includes(type) ? '在 Fabric 上要靠 OptiFabric，兼容性一般，更推荐 Sodium + Iris' : null;
        ofBtns = [btn('安装', () => optifineDialog(v, info), { icon: 'download' })];
      }
      if (type !== 'liteloader') rows.push(row('sun', 'OptiFine', of ? of.version || '已安装' : type === 'neoforge' ? '不支持' : '未安装', ofSub, ofBtns));
      // 光影加载器
      if (modLoader) {
        const sname = FABRIC_LIKE.includes(type) ? 'Iris' : 'Oculus';
        const sh = info.shader;
        rows.push(row('sparkles', '光影加载器', sh ? `${sh.kind === 'iris' ? 'Iris' : 'Oculus'} ${sh.version || ''}` : '未安装',
          sh ? (of ? '和 OptiFine 一起用会冲突，建议只留一个' : null) : `装 ${A.nm(sname)} 就能用光影包${FABRIC_LIKE.includes(type) ? '（会带上 Sodium）' : '（会带上必需的前置）'}`,
          sh
            ? [btn('更新', () => run('components:updateMod', `更新 ${A.nm(sname)}`, v.id, sh.file)), btn('卸载', () => removeMod(v, sh, sname), { ghost: true, danger: true })]
            : [btn(`安装 ${A.nm(sname)}`, () => run('components:installShader', `安装 ${A.nm(sname)}`, v.id), { icon: 'download' })]));
      }
      const last = info.history && info.history[0];
      A.mount(box, rows,
        last ? h('div.comp-hist', icon('history', 14),
          h('span', `上次修改：${last.label || `${last.from.mc} ${loaderText(last.from.loader)} → ${last.to.mc} ${loaderText(last.to.loader)}`} · ${A.fmtRelative(last.ts)}`),
          h('div.spacer'), btn('撤销', () => undo(v, last), { ghost: true, icon: 'restore' })) : null,
        h('div.comp-note', '修改组件前会自动备份旧的版本文件和被替换的 Mod，换游戏版本前还会备份存档，都可以撤销。'));
    }
    load();
    return box;
  }

  async function removeMod(v, m, name) {
    const ok = await A.confirm(`把 ${A.nm(name)}（${A.nm(m.file)}）移到回收站？依赖它的 Mod 可能会无法启动。`, { title: `卸载 ${A.nm(name)}`, okText: '卸载', danger: true });
    if (!ok) return;
    try { await api('components:removeMod', v.id, m.file); A.toast({ level: 'ok', text: `已卸载 ${A.nm(name)}` }); } catch (e) { A.errorToast('卸载失败', e); }
  }

  async function undo(v, last) {
    const ok = await A.confirm(`把「${A.nm(A.displayName(v))}」恢复到这次修改之前（${last.from.mc} · ${loaderText(last.from.loader)}）？这次换上的 Mod 会被换回原来的文件，被禁用的会重新启用。存档不会被改动，需要的话可以在「存档与备份」里恢复自动备份。`, { title: '撤销组件修改', okText: '撤销' });
    if (ok) run('components:undo', '撤销组件修改', v.id, last.ts);
  }

  async function uninstallLoader(v, info) {
    const target = { mc: info.mc, loader: null };
    reviewDialog(v, info, target, `卸载 ${LN(info.loader.type)}`);
  }

  async function removeOptifine(v, info) {
    if (info.optifine.mode === 'loader') return reviewDialog(v, info, { mc: info.mc, loader: null }, '卸载 OptiFine');
    const ok = await A.confirm(`把 OptiFine${info.optifabric ? ' 和 OptiFabric' : ''} 从 mods 文件夹移到回收站？`, { title: '卸载 OptiFine', okText: '卸载', danger: true });
    if (ok) run('components:removeOptifine', '卸载 OptiFine', v.id);
    return null;
  }

  // ── 更换 MC 版本 / 加载器 ──
  async function changeDialog(v, info, focus) {
    let manifest;
    try { manifest = await ensureManifest(); } catch (e) { A.errorToast('获取版本列表失败', e); return; }
    const cur = info.loader && MOD_LOADERS.includes(info.loader.type) ? info.loader.type : null;
    let mc = info.mc;
    let type = focus === 'loader' && !cur ? 'fabric' : cur;
    let list = [];
    let loaderVer = null;
    let loading = false;
    let showSnap = false;
    const body = h('div');
    const types = [{ value: '', label: '无' }, { value: 'fabric', label: 'Fabric' }, { value: 'quilt', label: 'Quilt' }, { value: 'forge', label: 'Forge' }, { value: 'neoforge', label: 'NeoForge' }];
    const ageOf = (id) => manifest.versions.findIndex((x) => x.id === id);

    const loadLoaders = async () => {
      list = [];
      loaderVer = null;
      if (!type) { render(); return; }
      loading = true;
      render();
      const want = `${type}|${mc}`;
      try {
        const l = await api('loaders:list', type, mc);
        if (`${type}|${mc}` !== want) return;
        list = l || [];
        const keep = type === cur && mc === info.mc && list.find((x) => x.version === info.loader.version);
        loaderVer = keep || list.find((x) => x.recommended) || list.find((x) => x.stable) || list[0] || null;
      } catch (e) { list = []; A.errorToast('获取加载器版本失败', e); }
      loading = false;
      render();
    };

    const m = A.modal({ title: focus === 'mc' ? '更换游戏版本' : cur ? '更换 Mod 加载器' : '安装 Mod 加载器', subtitle: A.nm(A.displayName(v)), icon: 'refresh', size: 'md', body, actions: [] });
    function render() {
      const opts = manifest.versions.filter((x) => x.type === 'release' || (showSnap && x.type === 'snapshot')).slice(0, 200)
        .map((x) => ({ value: x.id, label: x.id === info.mc ? `${x.id}（现在）` : x.id, sub: `${A.TYPE_NAMES[x.type] || x.type} · ${A.fmtDate(x.releaseTime)}` }));
      const down = mc !== info.mc && ageOf(mc) > ageOf(info.mc) && ageOf(info.mc) >= 0;
      const noLoader = type && !loading && !list.length;
      const same = mc === info.mc && (type || null) === cur && (!type || (loaderVer && info.loader && loaderVer.version === info.loader.version));
      A.mount(body,
        h('div.field', h('label', 'Minecraft 版本'), A.select({ options: opts, value: mc, searchable: true, block: true, onChange: (val) => { mc = val; loadLoaders(); } }),
          h('label.row.gap-s', { style: { marginTop: '8px', cursor: 'pointer', fontSize: '12.5px', color: 'var(--text-2)' } }, A.toggle(showSnap, (val) => { showSnap = val; render(); }), '显示快照版')),
        h('div.field', h('label', 'Mod 加载器'), A.seg(types, type || '', (val) => { type = val || null; loadLoaders(); })),
        type ? h('div.field', h('label', `${LN(type)} 版本`),
          loading ? h('div.row.gap-s', h('span.spinner.sm'), h('span.faint', '正在获取版本列表…'))
            : noLoader ? A.alert({ level: 'warn', compact: true, text: `${LN(type)} 没有适用于 Minecraft ${mc} 的版本，换一个游戏版本或加载器` })
              : A.select({ options: list.map((x) => ({ value: x.version, label: x.version, sub: [x.recommended ? '推荐' : '', x.latest ? '最新' : '', x.stable ? '' : '测试版'].filter(Boolean).join(' · ') })), value: loaderVer && loaderVer.version, searchable: true, block: true, onChange: (val) => { loaderVer = list.find((x) => x.version === val); render(); } }))
          : null,
        down ? A.alert({ level: 'crit', compact: true, text: `这是降级（${A.nm(info.mc)} → ${mc}）。存档被新版本打开过，再用旧版本打开很可能损坏或丢失内容。会强制先备份存档。` })
          : mc !== info.mc ? A.alert({ level: 'info', compact: true, text: `换游戏版本前会自动备份存档。存档被 ${mc} 打开后就回不到 ${A.nm(info.mc)} 了，可以先用「测试新游戏版本」在副本里试一试。` }) : null,
        info.loader && info.loader.type === 'optifine' && type ? A.alert({ level: 'warn', compact: true, text: '装 Mod 加载器会替换掉现在的 OptiFine（可以撤销）' }) : null);
      m.setActions([
        { label: '取消', kind: 'ghost' },
        { label: '下一步', kind: 'primary', icon: 'chevronRight', onClick: () => {
          if (same) { A.toast({ level: 'info', text: '和现在一样，没有要改的' }); return false; }
          if (loading || noLoader || (type && !loaderVer)) return false;
          const target = { mc, loader: type ? { type, version: loaderVer.version, full: loaderVer.full } : null };
          const label = mc !== info.mc ? `${A.nm(info.mc)} → ${mc}` : !type ? `卸载 ${LN(cur)}` : type !== cur ? `${cur ? LN(cur) : '纯净版'} → ${LN(type)}` : `${LN(type)} ${info.loader.version} → ${loaderVer.version}`;
          setTimeout(() => reviewDialog(v, info, target, label), 0);
          return true;
        } },
      ]);
    }
    if (type) loadLoaders(); else render();
  }

  /** 第二步：列出 Mod 会怎么处理，确认后开始 */
  async function reviewDialog(v, info, target, label) {
    const body = h('div', h('div.row.gap-s', { style: { padding: '24px 0', justifyContent: 'center' } }, h('span.spinner'), h('span.faint', '正在查每个 Mod 在新版本上有没有对应的文件…')));
    const m = A.modal({ title: label, subtitle: A.nm(A.displayName(v)), icon: 'refresh', size: 'lg', body, actions: [{ label: '取消', kind: 'ghost' }] });
    let plan;
    try { plan = await api('components:plan', v.id, target); } catch (e) { A.mount(body, A.alert({ level: 'crit', text: `检查失败：${e.message}` })); return; }
    const cnt = (a) => plan.mods.filter((x) => x.action === a).length;
    const rows = plan.mods.map((x) => h('div.comp-mod',
      x.icon ? h('img.cm-ico', { src: x.icon, alt: '' }) : h('div.cm-ico', icon('puzzle', 14)),
      h('div.cm-main', h('div.cm-name', A.nm(x.name), x.enabled ? null : h('span.badge', '已禁用')), h('div.cm-sub', x.action === 'replace' ? `换成 ${A.nm(x.newNumber || x.newFile)}${x.reenable ? '，并重新启用' : ''}` : x.action === 'keep' ? (x.reenable ? '之前换加载器时禁用的，这次能用了，会重新启用' : '不用改') : REASON[x.reason] || '会禁用')),
      h('span', { class: `badge ${x.action === 'replace' || x.reenable ? 'ok' : x.action === 'keep' ? '' : 'warn'}` }, x.action === 'replace' ? '换新版本' : x.reenable ? '重新启用' : x.action === 'keep' ? '保持' : '禁用')));
    const lines = [];
    if (plan.mode === 'migrate') lines.push(`${cnt('replace')} 个 Mod 换成新版本，${cnt('keep')} 个不用改，${cnt('disable')} 个找不到新版本会禁用（不会删除）。`);
    if (plan.mode === 'disableAll') lines.push(`没有 Mod 加载器后，${plan.mods.length} 个 Mod 都不会加载，会全部禁用（不删除）；以后装回加载器，可以在配置菜单里「恢复全部 Mod」。`);
    if (plan.mode === 'keep') lines.push('只换加载器版本，Mod 都不用改。');
    if (plan.mods.some((x) => x.reenable)) lines.push(`${plan.mods.filter((x) => x.reenable).length} 个之前因为换加载器被禁用的 Mod 这次能用了，会重新启用。`);
    if (!plan.mods.length) lines.push('这个配置没有 Mod，只换版本文件。');
    A.mount(body,
      h('div.comp-plan-head',
        h('div', h('div.faint', '现在'), h('b', `${A.nm(plan.from.mc)} · ${loaderText(plan.from.loader)}`)),
        icon('chevronRight', 18),
        h('div', h('div.faint', '之后'), h('b', `${plan.to.mc} · ${loaderText(plan.to.loader)}`))),
      plan.downgrade ? A.alert({ level: 'crit', compact: true, text: '降级：存档被新版本打开过，再用旧版本打开很可能损坏或丢失内容。开始前会强制备份存档（不能跳过）。' })
        : plan.mcChanged ? A.alert({ level: 'info', compact: true, text: '开始前会自动备份存档。' }) : null,
      lines.map((x) => h('p', { style: { margin: '10px 0' } }, x)),
      rows.length ? h('div.comp-mods', rows) : null,
      h('div.faint', { style: { fontSize: '12px', marginTop: '10px' } }, '旧的版本文件和被替换的 Mod 会留一份，改完不满意可以在「组件」区或完成通知里撤销。'));
    m.setActions([
      { label: '取消', kind: 'ghost' },
      { label: plan.downgrade ? '降级…' : '开始', kind: plan.downgrade ? 'danger' : 'primary', icon: plan.downgrade ? null : 'play', onClick: async () => {
        if (plan.downgrade) {
          const r = await A.dangerConfirm({ level: 3, title: `把 Minecraft 降级到 ${plan.to.mc}`, text: `「${A.nm(A.displayName(v))}」会从 ${A.nm(plan.from.mc)} 降到 ${plan.to.mc}。会先备份存档；降级后如果世界打不开，请用备份里的存档。`, confirmName: '降级', okText: '降级' });
          if (!r) return false;
        } else if (plan.mcChanged || plan.mode === 'disableAll' || plan.mode === 'migrate') {
          if (!(await A.confirm(`确定开始「${label}」？`, { title: label, okText: '开始' }))) return false;
        }
        await api('components:apply', v.id, target, plan, label);
        started(label);
        return true;
      } },
    ]);
  }

  // ── OptiFine ──
  async function optifineDialog(v, info) {
    const type = info.loader && info.loader.type;
    const body = h('div', h('div.row.gap-s', { style: { padding: '20px 0', justifyContent: 'center' } }, h('span.spinner'), h('span.faint', '正在获取 OptiFine 版本…')));
    const m = A.modal({ title: '安装 OptiFine', subtitle: A.nm(A.displayName(v)), icon: 'sun', size: 'md', body, actions: [{ label: '取消', kind: 'ghost' }] });
    let list;
    try { list = await api('components:optifineList', info.mc); } catch (e) { A.mount(body, A.alert({ level: 'crit', text: `获取 OptiFine 版本失败：${e.message}` })); return; }
    if (!list.length) { A.mount(body, A.alert({ level: 'warn', text: `OptiFine 没有适用于 ${A.nm(info.mc)} 的版本` })); return; }
    let pick = list.find((x) => !x.preview) || list[0];
    const render = () => A.mount(body,
      h('div.field', h('label', 'OptiFine 版本'), A.select({ options: list.map((x) => ({ value: x.version, label: x.version.replace(/_/g, ' '), sub: [x.preview ? '预览版' : '', x.forge ? `兼容 ${x.forge}` : ''].filter(Boolean).join(' · ') })), value: pick.version, block: true, onChange: (val) => { pick = list.find((x) => x.version === val); render(); } })),
      !type ? A.alert({ level: 'info', compact: true, text: 'OptiFine 会作为加载器装进这个配置（不新建配置），之后可以在「组件」区卸载或撤销。' }) : null,
      type === 'forge' ? A.alert({ level: 'info', compact: true, text: `OptiFine 会放进 mods 文件夹。${pick.forge ? `这个版本标注兼容 ${pick.forge}，Forge 版本差太多可能启动不了。` : ''}` }) : null,
      FABRIC_LIKE.includes(type) ? A.alert({ level: 'warn', compact: true, text: 'OptiFine 不是为 Fabric 做的，要靠 OptiFabric 转接，和很多 Mod（尤其是 Sodium）冲突。更推荐用 Sodium + Iris。仍然安装会把 OptiFine 和 OptiFabric 一起放进 mods。' }) : null,
      info.shader ? A.alert({ level: 'warn', compact: true, text: `已经装了 ${info.shader.kind === 'iris' ? 'Iris' : 'Oculus'}，和 OptiFine 一起用会冲突，建议只留一个。` }) : null);
    render();
    m.setActions([
      { label: '取消', kind: 'ghost' },
      { label: FABRIC_LIKE.includes(type) ? '仍然安装' : '安装', kind: 'primary', icon: 'download', onClick: async () => {
        await api('components:installOptifine', v.id, pick);
        started('安装 OptiFine');
        return true;
      } },
    ]);
  }

  A.components = { section, changeDialog, undo: (id, ts) => run('components:undo', '撤销组件修改', id, ts) };
})();
