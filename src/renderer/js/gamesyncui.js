'use strict';
/* 游戏设置同步（1.5.6）：设置页分组、选择主档来源、查看主档、配置抽屉里的一节、同步报告。后端在 core/gamesettings.js */
(function () {
  const { h, icon, api, state } = A;

  const cfg = () => ({ enabled: false, mode: 'once', cats: ['keys', 'modKeys', 'controls', 'video', 'sound', 'lang', 'skin'], ...((state.config && state.config.gameSync) || {}) });
  const setCfg = (patch) => A.setConfig({ gameSync: { ...cfg(), ...patch } });
  const CAT_DESC = {
    keys: '前进、跳跃、物品栏等原版动作', modKeys: '各个 Mod 的按键；没装这个 Mod 的配置里先存着，以后装了再写回去',
    controls: '灵敏度、反转鼠标、自动跳跃、潜行 / 疾跑切换', video: '渲染距离、帧率、视场角、亮度、图像品质', sound: '各类音量、字幕', lang: '游戏语言',
    skin: '披风、外套等皮肤部件显示', chat: '聊天栏、旁白、屏幕效果等', packs: '启用了哪些资源包（只启用目标里有的）',
    servers: '多人游戏的服务器列表，按地址合并，不会删掉目标里已有的', hotbar: '创造模式保存的快捷栏；只给不比来源旧的版本',
    modSettings: 'Sodium / Embeddium、OptiFine 的画面设置；只给装了它的配置',
    modConfig: 'config 文件夹里的 Mod 配置；只给装了同一个 Mod、版本号第一段相同的配置。格式各不相同，风险最大',
  };
  const MODES = [{ value: 'once', label: '只在新建时' }, { value: 'follow', label: '每次启动保持一致' }];
  const MODE_DESC = {
    once: '新建的配置第一次启动前写一次，之后各版本各管各的。已经玩过的配置不会被改',
    follow: '每次启动前写入；游戏里改了设置，退出后读回来，其他版本下次启动时也跟着变',
  };
  const REASONS = {
    missing: '这个版本没有这些选项', modifier: '这个版本不支持组合键（只有 Forge / NeoForge 支持），只写了主键', packMissing: '这个配置里没有这些资源包',
    older: '快捷栏来自更新的版本，游戏没法把物品降级，没有复制', noMod: '没装对应的 Mod，没有复制', modVersion: 'Mod 版本不同，配置可能不兼容，没有复制', broken: '文件读不出来',
  };
  let catLabels = {};
  // 原版动作的中文名（冲突列表里用）
  const ACTIONS = {
    attack: '攻击 / 破坏', use: '使用 / 放置', forward: '前进', left: '向左', back: '后退', right: '向右', jump: '跳跃', sneak: '潜行', sprint: '疾跑',
    inventory: '物品栏', drop: '丢弃物品', chat: '聊天', playerlist: '玩家列表', pickItem: '选取方块', command: '输入命令', screenshot: '截图',
    togglePerspective: '切换视角', smoothCamera: '电影视角', fullscreen: '全屏', spectatorOutlines: '高亮玩家', swapOffhand: '与副手交换', swapHands: '与副手交换',
    saveToolbarActivator: '保存快捷栏', loadToolbarActivator: '加载快捷栏', advancements: '进度', socialInteractions: '社交屏幕',
  };
  const actionName = (a) => { const k = String(a).replace(/^key\./, ''); const hb = k.match(/^hotbar\.(\d)$/); return ACTIONS[k] || (hb ? `快捷栏 ${hb[1]}` : k); };

  // ───────────────────────── 设置页 ─────────────────────────
  function settingsRows(row, rerender) {
    const c = cfg();
    const info = h('span.faint', '正在读取…');
    const refresh = async () => {
      try {
        const s = await api('gamesync:state');
        catLabels = Object.fromEntries(s.categories.map((x) => [x.id, x.label]));
        A.mount(info, s.master ? masterLine(s.master) : '还没有主档');
      } catch { info.textContent = ''; }
    };
    refresh();
    const catsBox = h('div.gs-cats');
    api('gamesync:state').then((s) => {
      catLabels = Object.fromEntries(s.categories.map((x) => [x.id, x.label]));
      A.mount(catsBox, s.categories.map((x) => h('label.check-row', { 'data-tip': CAT_DESC[x.id] || null },
        h('input', { type: 'checkbox', checked: cfg().cats.includes(x.id), onchange: (e) => { const set = new Set(cfg().cats); if (e.target.checked) set.add(x.id); else set.delete(x.id); setCfg({ cats: [...set] }); } }),
        h('span', x.label, x.id === 'modConfig' ? h('span.badge.warn', { style: { marginLeft: '6px' } }, '风险较大') : null))));
    }).catch(() => {});
    return [
      row('跨版本同步游戏设置', '把按键、灵敏度、画面等游戏里的设置记成一份「主档」，新配置自动套用，不同版本之间自动转换写法（例如 1.12 的数字按键 ↔ 新版的按键名）。写之前都会备份，可以撤销',
        A.toggle(c.enabled, async (v) => {
          // 先看现在真实的状态（rc16）：开关显示的可能是旧的，已经是这样就只把开关对齐，不再弹导入主档
          if (v === cfg().enabled) { if (rerender) rerender(); return; }
          if (v) {
            const s = await api('gamesync:state').catch(() => ({}));
            if (!s.master) { await importDialog({ enable: true }); if (rerender) rerender(); return; }
          }
          await setCfg({ enabled: v });
          if (rerender) rerender();
        })),
      c.enabled ? row('设置主档', info, h('div.row.gap-s',
        h('button.btn.sm', { onclick: viewDialog }, icon('eye', 14), '查看'),
        h('button.btn.sm', { onclick: async () => { await importDialog({}); refresh(); } }, icon('import', 14), '重新导入…'))) : null,
      c.enabled ? row('什么时候同步', MODE_DESC[c.mode], A.seg(MODES, c.mode, async (v) => { await setCfg({ mode: v }); if (rerender) rerender(); })) : null,
      c.enabled ? row('同步哪些', '每个配置还可以在它的设置里单独选「不同步」', catsBox, { col: true }) : null,
    ];
  }

  function masterLine(m) {
    const n = m.counts;
    const src = m.source ? (m.source.id === '@root' ? '公共 .minecraft' : m.source.id) : '';
    return `${src ? `来自 ${src} · ` : ''}${n.values} 项设置、${n.keys} 个按键${n.modKeys ? `、${n.modKeys} 个 Mod 按键` : ''}${m.updatedAt ? ` · ${A.fmtRelative(m.updatedAt)}更新` : ''}`;
  }

  // ───────────────────────── 选择来源 ─────────────────────────
  async function importDialog({ enable } = {}) {
    let list = [];
    try { list = await api('gamesync:sources'); } catch (e) { A.errorToast('读取游戏配置失败', e); return false; }
    if (!list.length) {
      await A.confirm('还没有哪个配置保存过游戏设置（options.txt）。先进一次游戏、在「选项」里调好设置，再回来导入。', { title: '没有可以导入的设置', okText: '知道了' });
      return false;
    }
    let pick = list[0].id;
    const rows = h('div.mg-list');
    const draw = () => A.mount(rows, list.map((s) => h('label.check-row.mg-cand', { style: { alignItems: 'flex-start' } },
      h('input', { type: 'radio', name: 'gs-src', checked: s.id === pick, onchange: () => { pick = s.id; } }),
      h('span', h('b', A.nm(s.name)), h('span.faint', ` ${[s.mc, s.loader].filter(Boolean).join(' · ')}`),
        h('div.faint', { style: { fontSize: '12px' } }, `${A.fmtRelative(s.modified)}改过 · ${s.count} 项${s.full ? '' : '（只有几项，可能还没在游戏里调过设置）'}`)))));
    draw();
    return new Promise((resolve) => {
      A.modal({
        title: '从哪个配置导入游戏设置？',
        subtitle: '选你平时玩得最多、设置调得最顺手的那个。按键、画面、声音等都会读进主档；Mod 按键、服务器列表、Mod 配置文件也会一起存着，用不用看「同步哪些」的勾选',
        icon: 'import', size: 'md', body: h('div.mg', rows),
        onClose: () => resolve(false),
        actions: [
          { label: A.t('common.cancel'), kind: 'ghost' },
          { label: '导入', kind: 'primary', icon: 'import', onClick: async () => {
            try {
              const r = await api('gamesync:import', pick);
              if (enable) await setCfg({ enabled: true });
              A.toast({ level: 'ok', title: '已导入游戏设置', text: masterLine(r.master) });
              resolve(true);
              return true;
            } catch (e) { A.errorToast('导入失败', e); return false; }
          } },
        ],
      });
    });
  }

  // ───────────────────────── 查看主档 ─────────────────────────
  async function viewDialog() {
    let s;
    try { s = await api('gamesync:state'); } catch (e) { A.errorToast('读取失败', e); return; }
    const m = s.master;
    if (!m) return;
    const kv = (k, v) => (v == null ? null : h('div.gs-kv', h('span.faint', k), h('span', v)));
    const keyName = (k) => (k ? k.replace(/^key\.(keyboard|mouse)\./, (x, t) => (t === 'mouse' ? '鼠标 ' : '')).replace(/\./g, ' ').toUpperCase() : null);
    A.modal({
      title: '设置主档', subtitle: masterLine(m), icon: 'eye', size: 'md',
      body: h('div.mg',
        h('div.mg-label', '部分内容'),
        h('div.gs-kvs',
          kv('语言', m.sample.lang), kv('渲染距离', m.sample.renderDistance), kv('鼠标灵敏度', m.sample.mouseSensitivity != null ? `${Math.round(Number(m.sample.mouseSensitivity) * 200)}%` : null),
          kv('视场角', m.sample.fov != null ? String(Math.round(70 + Number(m.sample.fov) * 40)) : null), kv('前进', keyName(m.sample.forward)), kv('跳跃', keyName(m.sample.jump))),
        h('div.mg-label', '附带的文件'),
        h('div.faint', [
          m.counts.packs ? `${m.counts.packs} 个资源包的选择` : null, m.counts.servers ? '服务器列表' : null, m.counts.hotbar ? '保存的快捷栏' : null,
          m.counts.modSettings ? `${m.counts.modSettings} 个画面增强 Mod 设置` : null, m.counts.modConfig ? `${m.counts.modConfig} 个 Mod 配置文件` : null,
        ].filter(Boolean).join('、') || '没有'),
        m.modKeyNames.length ? h('div', h('div.mg-label', `Mod 按键（${m.counts.modKeys}）`), h('div.faint.gs-modkeys', A.nmJoin(m.modKeyNames.map((k) => k.replace(/^key_(key\.)?/, ''))))) : null),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  }

  // ───────────────────────── 配置抽屉 ─────────────────────────
  const OWN = [{ value: 'default', label: '跟随设置' }, { value: 'follow', label: '保持一致' }, { value: 'once', label: '只同步一次' }, { value: 'off', label: '不同步' }];
  const nameOf = (v) => v.displayName || A.displayName(v) || v.id;
  // 每个配置都能手动操作（1.5.7）：用它当主档、把它的设置同步到其他配置、从主档同步过来；自动同步的开关和方式在下面
  function drawerSection(v) {
    const body = h('div', h('span.faint', '正在读取…'));
    const draw = async () => {
      let st;
      try { st = await api('gamesync:profile', v.id); } catch { body.textContent = ''; return; }
      const goSettings = h('button.btn.sm.ghost', { onclick: () => { A.closeDrawers(); A.go('settings', { focus: 'gamesync' }); } }, icon('settings', 14), '去设置');
      const noOpts = st.hasOptions ? null : '这个配置还没有游戏设置，先进一次游戏、在「选项」里调好';
      const r = st.lastReport;
      const manual = h('div.row.gap-s.wrap',
        h('button.btn.sm', { disabled: !st.hasOptions, 'data-tip': noOpts || '用这个配置现在的按键和设置替换主档；以后新配置套用的就是这一份', onclick: () => useAsMaster(v, st).then(draw) }, icon('star', 14), '用它当主档'),
        h('button.btn.sm', { disabled: !st.hasOptions, 'data-tip': noOpts || '把这个配置现在的设置按版本转换后写进你选的配置，不改主档', onclick: () => copyDialog(v).then(draw) }, icon('upload', 14), '同步到其他配置…'),
        h('button.btn.sm', { disabled: !st.hasMaster || st.copyMode, 'data-tip': st.copyMode ? '这个配置的游戏选项设成了每次从来源复制' : st.hasMaster ? '把设置主档写进这个配置' : '还没有设置主档', onclick: async () => {
          if (!(await A.confirm(`把设置主档写进「${A.nm(nameOf(v))}」？会先备份，之后可以撤销。`, { title: '从主档同步', okText: '同步' }))) return;
          try { const rep = await api('gamesync:apply', v.id); reportDialog(v, rep); draw(); } catch (e) { A.errorToast('同步失败', e); }
        } }, icon('import', 14), '从主档同步'),
        r ? h('button.btn.sm.ghost', { onclick: () => reportDialog(v, r) }, icon('file', 14), `上次同步（${A.fmtRelative(r.at)}）`) : null,
        st.canUndo ? h('button.btn.sm.ghost', { onclick: () => undo(v).then(draw) }, icon('history', 14), '撤销上次同步') : null);
      let auto;
      if (!st.enabled) auto = h('div.row', h('span.faint', { style: { flex: 1 } }, '自动同步没有打开。打开后新配置会自动套用你常用的按键和设置'), goSettings);
      else if (st.copyMode) auto = h('div.faint', '这个配置的「游戏选项与按键」在「存档与隔离」里设成了每次从来源复制（会按版本转换），不参与自动同步');
      else {
        auto = h('div',
          h('div.row', A.seg(OWN, st.own, async (val) => { await api('gamesync:setMode', v.id, val); draw(); })),
          h('div.faint', { style: { fontSize: '12px', marginTop: '6px' } }, st.own === 'default' ? `跟随设置：${MODES.find((x) => x.value === st.mode).label}` : st.mode === 'off' ? '这个配置不会被自动同步' : MODE_DESC[st.mode] || ''));
      }
      A.mount(body, manual, h('div.gs-auto', h('div.mg-label', '自动同步'), auto));
    };
    draw();
    return h('div.drawer-section', { id: 'gamesync-sec' }, h('h4', '游戏设置同步'), body);
  }

  /** 用这个配置当主档（替换现在的主档） */
  async function useAsMaster(v, st) {
    const s = await api('gamesync:state').catch(() => ({}));
    const text = s.master
      ? `用「${A.nm(nameOf(v))}」现在的按键和设置替换设置主档？原来的主档（${masterLine(s.master)}）会被换掉；各个配置里已经写好的设置不受影响。`
      : `用「${A.nm(nameOf(v))}」现在的按键和设置建立设置主档？`;
    if (!(await A.confirm(text, { title: '用它当主档', okText: s.master ? '替换主档' : '建立主档' }))) return;
    try {
      const r = await api('gamesync:import', v.id);
      A.toast({
        level: 'ok', title: '设置主档已更新', text: masterLine(r.master),
        actions: st.enabled ? undefined : [{ label: '打开自动同步', onClick: () => { A.closeDrawers(); A.go('settings', { focus: 'gamesync' }); } }],
      });
    } catch (e) { A.errorToast('更新主档失败', e); }
  }

  /** 同步到其他配置：选目标（可多选）和类别，按版本转换后写进去，每个目标单独备份、可在它自己的抽屉里撤销 */
  async function copyDialog(v) {
    try { const s = await api('gamesync:state'); catLabels = Object.fromEntries(s.categories.map((x) => [x.id, x.label])); } catch { /* 用旧的 */ }
    const others = state.installed.filter((x) => x.id !== v.id && !x.broken && !(x.usedAsParent && !x.hasMeta && !x.loader));
    if (!others.length) { A.toast({ level: 'info', text: '没有其他游戏配置可以同步' }); return; }
    const picked = new Set();
    const cats = new Set(cfg().cats);
    const targets = h('div.mg-list.gs-targets', others.map((x) => h('label.check-row.mg-cand',
      h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) picked.add(x.id); else picked.delete(x.id); } }),
      h('img', { src: A.versionIcon(x, 32), alt: '', style: { width: '20px', height: '20px' } }),
      h('span', h('b', A.nm(A.displayName(x))), h('span.faint', ` ${A.versionSub(x)}`)))));
    const catBox = h('div.gs-cats', Object.entries(catLabels).map(([id, label]) => h('label.check-row', { 'data-tip': CAT_DESC[id] || null },
      h('input', { type: 'checkbox', checked: cats.has(id), onchange: (e) => { if (e.target.checked) cats.add(id); else cats.delete(id); } }),
      h('span', label, id === 'modConfig' ? h('span.badge.warn', { style: { marginLeft: '6px' } }, '风险较大') : null))));
    await new Promise((resolve) => {
      A.modal({
        title: `把「${A.nm(nameOf(v))}」的设置同步到…`, icon: 'upload', size: 'md', onClose: () => resolve(),
        subtitle: '按目标的游戏版本转换写法（例如 1.12 的数字按键 ↔ 新版的按键名），只改勾选的类别。不经过、也不改设置主档。每个目标改之前都会备份，可以在它自己的设置里撤销',
        body: h('div.mg', h('div.mg-label', '同步到哪些配置'), targets, h('div.mg-label', '同步哪些'), catBox),
        actions: [
          { label: A.t('common.cancel'), kind: 'ghost' },
          { label: '同步', kind: 'primary', icon: 'refresh', onClick: async () => {
            if (!picked.size) { A.toast({ level: 'warn', text: '先勾选要同步到的配置' }); return false; }
            if (!cats.size) { A.toast({ level: 'warn', text: '至少勾选一类设置' }); return false; }
            let res;
            try { res = await api('gamesync:copyTo', v.id, [...picked], [...cats]); } catch (e) { A.errorToast('同步失败', e); return false; }
            copyResult(v, res);
            return true;
          } },
        ],
      });
    });
  }

  function copyResult(v, res) {
    const ok = res.filter((x) => x.report).length;
    A.modal({
      title: '同步结果', subtitle: `来自「${A.nm(nameOf(v))}」· ${ok} 个成功${res.length - ok ? `，${res.length - ok} 个没同步` : ''}`, icon: 'refresh', size: 'md',
      body: h('div.mg-list', res.map((x) => {
        const tv = state.installed.find((y) => y.id === x.id) || { id: x.id };
        const n = x.report ? Object.values(x.report.written || {}).reduce((a, b) => a + b, 0) : 0;
        return h('div.row.gs-res', h('b', { style: { flex: 1, minWidth: 0 } }, A.nm(A.displayName(tv))),
          x.report ? h('span.faint', n ? `写入 ${n} 项` : '没有需要改的') : h('span', { style: { color: 'var(--danger)', fontSize: '12.5px' } }, x.error),
          x.report ? h('button.btn.sm.ghost', { onclick: () => reportDialog(tv, x.report) }, icon('file', 14), '报告') : null);
      })),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  }

  async function undo(v) {
    if (!(await A.confirm('把上次同步改过的文件放回原样？同步时新建的文件会删掉。', { title: '撤销上次同步', okText: '撤销' }))) return;
    try {
      const r = await api('gamesync:undo', v.id);
      A.toast({ level: 'ok', text: `已撤销：还原 ${r.restored} 个文件${r.removed ? `，删掉 ${r.removed} 个新建的` : ''}` });
    } catch (e) { A.errorToast('撤销失败', e); }
  }

  // ───────────────────────── 同步报告 ─────────────────────────
  function reportDialog(v, r) {
    const total = Object.values(r.written || {}).reduce((a, b) => a + b, 0);
    const byReason = {};
    for (const x of r.skipped || []) (byReason[x.reason] = byReason[x.reason] || []).push(x);
    const short = (k) => String(k).replace(/^key_(key\.)?/, '').replace(/^resourcePacks:/, '');
    const conflicts = r.conflicts || [];
    let m;
    const body = h('div.mg',
      h('div.mg-label', '写入'),
      h('div.gs-written', Object.entries(r.written || {}).filter(([, n]) => n).map(([c, n]) => h('span.badge.ok', `${catLabels[c] || c} ${n}`))),
      !total ? h('div.faint', '没有需要改的') : null,
      r.notes && r.notes.includes('vanillaModKeys') ? h('div.faint', '这是纯净版，Mod 按键没写进去，还留在主档里，以后同步到装了这些 Mod 的配置时会写回去') : null,
      r.modKeysKept && !(r.notes && r.notes.includes('vanillaModKeys')) ? h('div.faint', `${r.modKeysKept} 个 Mod 按键对应的 Mod 这个配置里没装，留在主档里`) : null,
      Object.keys(byReason).length ? h('div', h('div.mg-label', '跳过'), Object.entries(byReason).map(([why, items]) => h('details.gs-skip',
        h('summary', `${REASONS[why] || why}（${items.length}）`),
        h('div.faint', items.map((x) => short(x.k) + (x.detail ? `（${x.detail}）` : '')).join('、'))))) : null,
      (r.clamped || []).length ? h('div', h('div.mg-label', '调整到这个版本能用的范围'), h('div.faint', r.clamped.map((x) => `${short(x.k)}：${x.from} → ${x.to}`).join('、'))) : null,
      (r.unbound || []).length ? h('div', h('div.mg-label', '这个版本没有的按键，设成了未绑定'), h('div.faint', r.unbound.map((x) => `${short(x.k)}（${x.key}）`).join('、'))) : null,
      conflicts.length ? h('div', h('div.mg-label', `按键冲突（${conflicts.length}）`),
        h('div.faint', { style: { marginBottom: '6px' } }, '同一个键绑了几个动作，在游戏里可能会同时触发。可以进游戏「选项 → 控制 → 按键绑定」自己改，或者让启动器把撞车的 Mod 按键解绑（保留原版的）'),
        h('div.gs-conf', conflicts.map((c) => h('div', h('b', c.bind.replace(/^key\.(keyboard|mouse)\./, '').toUpperCase()), h('span.faint', ` ${c.actions.map(actionName).join('、')}`)))),
        h('button.btn.sm', { style: { marginTop: '8px' }, onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { const u = await api('gamesync:unbind', v.id); A.toast({ level: 'ok', text: `已解绑 ${u.count} 个 Mod 按键（之前的设置备份了，可以撤销）` }); if (m) m.close(); } catch (err) { A.errorToast('解绑失败', err); }
        } }, icon('x', 14), '解绑撞车的 Mod 按键')) : null,
      r.backup ? h('div.faint', { style: { fontSize: '12px', marginTop: '6px' } }, `改之前的文件备份在游戏目录的 .aurora-sync-bak/${r.backup}`) : null);
    m = A.modal({
      title: '同步报告', subtitle: `${A.nm(nameOf(v))}${r.from ? `（来自「${r.from}」）` : ''} · ${A.fmtRelative(r.at)} · 写入 ${total} 项`, icon: 'refresh', size: 'md', body,
      actions: [
        r.backup ? { label: '撤销这次同步', kind: 'ghost', onClick: async () => { await undo(v); return true; } } : null,
        { label: '关闭', kind: 'primary' },
      ].filter(Boolean),
    });
    return m;
  }

  A.gameSyncUi = { settingsRows, importDialog, viewDialog, drawerSection, reportDialog };
})();
