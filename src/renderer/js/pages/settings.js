'use strict';
/* 设置 */
(function () {
  const { h, icon, api, state, on, $ } = A;

  let root;
  let nav = null; // 分类布局（settingsnav.js）
  let javaSelEl = null;
  const javaOptions = () => [{ value: 'auto', label: '自动选择（推荐）', sub: '根据版本需求自动挑选' }, ...(state.javas || []).map((j) => ({ value: j.path, label: `Java ${j.major}（${j.version}）`, sub: `${j.vendor} · ${j.path}` }))];

  const ACCENTS = [
    ['aurora', 'linear-gradient(135deg,#34d399,#22d3ee,#818cf8)', '极光'],
    ['ocean', 'linear-gradient(135deg,#38bdf8,#6366f1,#a855f7)', '深海'],
    ['sunset', 'linear-gradient(135deg,#fb923c,#f43f5e,#c026d3)', '日落'],
    ['forest', 'linear-gradient(135deg,#a3e635,#22c55e,#14b8a6)', '森林'],
    ['sakura', 'linear-gradient(135deg,#f9a8d4,#e879f9,#818cf8)', '樱花'],
    ['gold', 'linear-gradient(135deg,#fde047,#fb923c,#f43f5e)', '黄金'],
    ['mono', 'linear-gradient(135deg,#e5e7eb,#a1a1aa,#52525b)', '素雅'],
  ];

  const row = (title, desc, ctrl, opts = {}) => {
    // 开关只有一个透明的勾选框，读屏读不到它是干什么的：用这一行的标题当名字
    const sw = ctrl && ctrl.querySelector && ctrl.querySelector('input[role=switch]');
    if (sw && !sw.getAttribute('aria-label') && typeof title === 'string') sw.setAttribute('aria-label', title);
    return h('div', { class: `set-row ${opts.col ? 'col' : ''}`, 'data-k': typeof title === 'string' ? title : '' },
      h('div.s-text', h('div.s-title', title), desc ? h('div.s-desc', desc) : null), h('div.s-ctrl', ctrl));
  };
  const group = (title, ic, ...rows) => h('div.card.set-group', { style: { padding: 0 }, 'data-k': typeof title === 'string' ? title : '' }, h('h3', icon(ic, 16), title), ...rows);
  const set = (patch) => A.setConfig(patch).catch((e) => A.errorToast('保存失败', e));
  const ISOLATION_MODES = [{ value: 'none', label: '不使用' }, { value: 'modded', label: 'Mod 版与快照' }, { value: 'all', label: '全部版本' }];

  /** 像素场景：场景、时间、生物、和平模式、建筑、彩蛋 */
  function sceneRows(c) {
    const b = { ...A.SCENE_DEFAULTS, ...c.background };
    const setBg = (patch) => set({ background: patch });
    const scenes = Object.entries(A.SCENES);
    const dimName = { over: '主世界', nether: '下界', end: '末地' };
    const count = h('b', String(b.mobs));
    const kinds = [['animals', '动物'], ['monsters', '敌对生物'], ['aquatic', '水生生物'], ['players', '玩家']];
    const chips = h('div.chips', { style: { justifyContent: 'flex-end' } }, kinds.map(([k, label]) => {
      const el = h('button.chip', { class: b[k] ? 'on' : '', disabled: k === 'monsters' && b.peaceful, onclick: () => { b[k] = !b[k]; el.classList.toggle('on', b[k]); setBg({ [k]: b[k] }); } }, label);
      return el;
    }));
    return [
      row('场景', '「每日轮换」每天换一个主世界生态；「每次启动随机」从全部场景（含下界、末地）里随机选一个', A.select({
        width: 220, value: b.scene, onChange: (v) => setBg({ scene: v }),
        options: [{ value: 'auto', label: '自动（每日轮换）' }, { value: 'random', label: '自动（每次启动随机）' }, ...scenes.map(([id, s]) => ({ value: id, label: `${dimName[s.dim]} · ${s.name}` }))],
      })),
      row('场景时间', '主世界的天色、灯光与生物随时间变化，夜晚才会出现敌对生物', A.seg([
        { value: 'auto', label: '跟随时间' }, { value: 'dawn', label: '黎明' }, { value: 'day', label: '白天' }, { value: 'sunset', label: '黄昏' }, { value: 'night', label: '夜晚' },
      ], b.time || 'auto', (v) => setBg({ time: v }))),
      h('div.set-row.col',
        h('div.row', h('div.s-text', h('div.s-title', '生物数量'), h('div.s-desc', '背景中同时存在的生物上限，0 为不生成')), count),
        A.range({ min: 0, max: 20, value: b.mobs, onInput: (v) => { count.textContent = String(v); }, onChange: (v) => setBg({ mobs: v, perfTier: A.bgPerf.tierOf({ ...b, mobs: v }) }) })),
      row('生物种类', '玩家会砍树、搭建筑、进出小屋', chips),
      row('和平模式', '不生成任何敌对生物', A.toggle(b.peaceful, (v) => { setBg({ peaceful: v }); render(); })),
      row('建筑与玩家活动', '主世界的小屋（夜晚亮灯）、砍树和搭建', A.toggle(b.buildings, (v) => setBg({ buildings: v }))),
      row('背景玩家用我的皮肤', '用皮肤中心「皮肤库」里收藏的皮肤生成背景里的玩家，和 Steve、Alex 一起出现。皮肤只在这台电脑上读取和处理，不联网、不上传', A.toggle(!!b.mySkins, (v) => setBg({ mySkins: v }))),
      row('彩蛋', '一些罕见的小惊喜，等你自己发现', A.toggle(b.eggs, (v) => setBg({ eggs: v }))),
      row('移动视角', '鼠标停在背景边缘的空白处会慢慢移动视角，按住空白处也能拖动，可以看到两边更远的地方、高山和地下', A.toggle(b.pan !== false, (v) => setBg({ pan: v }))),
      // 性能打磨：按硬件推荐档位 + 三项性能设置（改了任何一项档位就记成「自定义」）
      row('按这台电脑推荐', `按显卡、处理器和内存推荐生物数量、生成范围、帧率和特效。现在：${b.perfTier && b.perfTier !== 'custom' ? `「${A.bgPerf.NAMES[b.perfTier]}」档` : '自定义'}`,
        h('button.btn.sm', { onclick: () => A.bgPerf.openModal() }, '推荐…')),
      row('世界生成范围', '视野两边预先生成多远。小一些更省内存和处理器，移动视角时边上的地形会晚一点出现', A.seg([{ value: 'large', label: '大' }, { value: 'medium', label: '中' }, { value: 'small', label: '小' }], b.range, (v) => setBg({ range: v, perfTier: A.bgPerf.tierOf({ ...b, range: v }) }))),
      row('帧率上限', '「静态」把背景定格成一张画面；窗口不在前台时最多 10 帧', A.seg([{ value: 30, label: '30' }, { value: 20, label: '20' }, { value: 10, label: '10' }, { value: 0, label: '静态' }], b.fps, (v) => setBg({ fps: v, perfTier: A.bgPerf.tierOf({ ...b, fps: v }) }))),
      row('特效', '水下光柱、气泡、海带摆动、天上飘的粒子、闪光这些装饰', A.seg([{ value: 'high', label: '全开' }, { value: 'medium', label: '一半' }, { value: 'low', label: '少' }], b.fx, (v) => setBg({ fx: v, perfTier: A.bgPerf.tierOf({ ...b, fx: v }) }))),
    ];
  }

  /** CurseForge：社区代理、自己的 API Key、测试连接、手动下载的原文件 */
  /** 新游戏目录首次启动的游戏语言：跟着启动器语言；英文界面不改游戏语言，不显示这一行 */
  function gameLangRow(row, c, set) {
    const l = window.I18N.LANGS.find((x) => x.id === window.I18N.getLang());
    if (!l || !l.game) return null;
    const name = l.id === 'zh-CN' ? '简体中文' : l.name;
    return row(`首次启动设为${name}`, `新的游戏目录首次启动时自动将语言设为${name}`, A.toggle(c.autoChinese, (v) => set({ autoChinese: v })));
  }

  function cfRows(c) {
    const cf = c.curseforge || {};
    const keyInput = h('input.input.mono', {
      type: 'password', value: cf.apiKey || '', placeholder: A.t('cf.apiKeyPlaceholder'), spellcheck: 'false', autocomplete: 'off',
      style: { width: '260px', fontSize: '12px' }, onchange: (e) => set({ curseforge: { apiKey: e.target.value.trim() } }),
    });
    const testBtn = h('button.btn.sm', {
      onclick: async () => {
        testBtn.disabled = true;
        try {
          const r = await api('curseforge:test');
          A.toast({ level: 'ok', text: A.t('cf.testOk', { via: A.t(r.via === 'official' ? 'cf.viaOfficial' : 'cf.viaProxy'), ms: r.ms }) });
          if (r.keyRejected) A.toast({ level: 'warn', text: A.t('cf.testKeyRejected') });
        } catch (e) { A.errorToast(A.t('cf.testFailed'), e); } finally { testBtn.disabled = false; }
      },
    }, icon('refresh', 14), A.t('cf.test'));
    return [
      row(A.t('cf.proxy'), A.t('cf.proxyDesc'), A.toggle(cf.proxy !== false, (v) => set({ curseforge: { proxy: v } }))),
      row(A.t('cf.apiKey'), A.t('cf.apiKeyDesc'), h('div.input-group', keyInput,
        h('button.btn.sm.icon.ghost', { 'data-tip': A.t('cf.showKey'), onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, icon('eye', 16)))),
      row(A.t('cf.test'), A.t('cf.testDesc'), testBtn),
      row(A.t('cf.downloadsSetting'), A.t('cf.downloadsSettingDesc'), A.select({
        options: [{ value: 'ask', label: A.t('cf.downloadsAsk') }, { value: 'trash', label: A.t('cf.downloadsTrash') }, { value: 'keep', label: A.t('cf.downloadsKeep') }],
        value: c.cfDownloads || 'ask', width: 180, onChange: (v) => set({ cfDownloads: v }),
      })),
      row(A.t('cf.manualHow'), A.t('cf.manualHowDesc'), null),
    ];
  }

  // ───────────── 数据存储位置 ─────────────
  const LOC_MODES = [
    { id: 'default', icon: 'monitor', name: '系统默认', desc: '启动器数据在 AppData，游戏在系统的 .minecraft' },
    { id: 'portable', icon: 'box', name: '便携模式', desc: '全部放在启动器 exe 旁边的 AuroraData 文件夹，整个文件夹可以直接拷走' },
    { id: 'custom', icon: 'folder', name: '自定义文件夹', desc: '启动器数据、Java、游戏、Mod 与存档全部放进你选的文件夹' },
  ];

  /** 存档备份：自动备份开关、保留份数、大小上限、占用空间和清理 */
  function backupRows(c) {
    const t = A.t;
    const b = { beforeLaunch: false, beforeModChange: true, keepAuto: 5, maxTotalGB: 20, ...c.backup };
    const setB = (patch) => set({ backup: patch });
    const usageText = h('span.faint', t('backup.set.reading'));
    const deletedRow = h('div');
    let u = null;
    const load = async () => {
      try { u = await api('backup:usage'); } catch (e) { usageText.textContent = e.message; return; }
      usageText.textContent = t('backup.set.usageText', { total: A.fmtBytes(u.total), auto: A.fmtBytes(u.autoSize), n: u.autoCount });
      const gone = u.profiles.filter((p) => !p.exists);
      A.mount(deletedRow, gone.length ? row(t('backup.set.deleted'), t('backup.set.deletedText', { n: gone.length, size: A.fmtBytes(gone.reduce((s, p) => s + p.size, 0)) }), null) : null);
    };
    const clean = async () => {
      if (!u || !u.autoCount) return;
      const ok = await A.dangerConfirm({ level: 2, title: t('backup.set.cleanTitle'), text: t('backup.set.cleanText', { n: u.autoCount, size: A.fmtBytes(u.autoSize) }), note: t('danger.permanentNote') });
      if (!ok) return;
      try { const n = await api('backup:clean', { autoOnly: true }); A.toast({ level: 'ok', text: t('backup.set.cleaned', { n }) }); } catch (e) { A.errorToast(t('backup.deleteFailed'), e); }
      load();
    };
    load();
    return [
      row(t('backup.set.beforeLaunch'), t('backup.set.beforeLaunchDesc'), A.toggle(b.beforeLaunch, (v) => setB({ beforeLaunch: v }))),
      row(t('backup.set.beforeMod'), t('backup.set.beforeModDesc'), A.toggle(b.beforeModChange !== false, (v) => setB({ beforeModChange: v }))),
      row(t('backup.set.keep'), t('backup.set.keepDesc'), A.select({ width: 140, value: b.keepAuto, options: [1, 3, 5, 10, 20].map((n) => ({ value: n, label: t('backup.set.keepN', { n }) })), onChange: (v) => setB({ keepAuto: Number(v) }).then(() => api('backup:prune')).then(load) })),
      row(t('backup.set.cap'), t('backup.set.capDesc'), A.select({ width: 140, value: b.maxTotalGB, options: [5, 10, 20, 50, 100].map((n) => ({ value: n, label: `${n} GB` })), onChange: (v) => setB({ maxTotalGB: Number(v) }).then(() => api('backup:prune')).then(load) })),
      row(t('backup.set.usage'), usageText, h('div.row.gap-s',
        h('button.btn.sm', { onclick: () => api('backup:dir').then((d) => api('shell:open', d)).catch((e) => A.errorToast(t('backup.openFailed'), e)) }, icon('folder', 14), t('backup.set.open')),
        h('button.btn.sm', { onclick: clean }, icon('trash', 14), t('backup.set.clean')))),
      deletedRow,
    ];
  }

  function storageSection() {
    const box = h('div.loc-box', h('div.faint', { style: { padding: '14px 18px' } }, '读取中…'));
    api('location:get').then((loc) => {
      const cur = loc.mode === 'env' ? null : loc.mode;
      A.mount(box,
        // 运行位置的问题（含数据文件夹不可用）
        A.placeCheck.notes(),
        loc.mode === 'env' ? A.alert({ level: 'info', compact: true, text: '当前通过环境变量 AURORA_DATA_DIR 指定了数据目录，无法在这里切换' }) : null,
        h('div.choices.cols-3', LOC_MODES.map((m) => {
          const noPortable = m.id === 'portable' && !loc.canPortable;
          return A.choice({
            iconName: m.icon, title: m.name, on: cur === m.id, disabled: loc.mode === 'env' || noPortable,
            badge: cur === m.id ? h('span.badge.accent', '当前') : null,
            desc: noPortable ? '安装版的安装目录会在卸载时被删除，请使用「自定义文件夹」，或改用便携版 exe' : m.desc,
            onClick: () => { if (cur !== m.id || m.id === 'custom') switchDialog(m.id, loc); },
          });
        })),
        h('div.loc-paths',
          h('div', h('span.faint', '启动器数据'), h('code', loc.dataDir), h('button.btn.ghost.sm.icon', { 'data-tip': '打开', onclick: () => api('shell:open', loc.dataDir) }, icon('folder', 14))),
          h('div', h('span.faint', '游戏目录'), h('code', loc.gameDir), h('button.btn.ghost.sm.icon', { 'data-tip': '打开', onclick: () => api('shell:open', loc.gameDir) }, icon('folder', 14)))));
    }).catch((e) => A.mount(box, A.alert({ level: 'crit', compact: true, text: e.message })));
    return box;
  }

  A.locationDialog = (mode, loc) => switchDialog(mode, loc);
  async function switchDialog(mode, loc) {
    let dir = null;
    if (mode === 'custom') {
      dir = await api('dialog:folder', '选择用来存放全部数据的文件夹', loc.base || undefined);
      if (!dir) return;
    }
    const base = mode === 'portable' ? loc.portableBase : mode === 'custom' ? dir : null;
    const targetGame = base ? `${base}\\.minecraft` : loc.systemGameDir;
    const sizeEl = h('span.faint', '（正在统计大小…）');
    api('location:size', loc.gameDir).then((s) => { sizeEl.textContent = `（${s.partial ? '至少 ' : ''}${A.fmtBytes ? A.fmtBytes(s.bytes) : `${(s.bytes / 1073741824).toFixed(2)} GB`}，${s.files} 个文件）`; }).catch(() => { sizeEl.textContent = ''; });
    let game = mode === 'default' ? 'keep' : 'copy';
    const gameDesc = h('div.faint', { style: { fontSize: '12px', marginTop: '6px' } });
    const gamePath = h('code');
    const paintDesc = () => {
      gamePath.textContent = game === 'keep' ? loc.gameDir : targetGame;
      gameDesc.textContent = game === 'copy' ? `把当前游戏目录复制到 ${A.nm(targetGame)}，原目录保持不动${mode === 'default' ? '（会与已有的 .minecraft 合并）' : ''}`
        : game === 'empty' ? `使用新的空目录 ${A.nm(targetGame)}，需要重新安装版本`
          : `继续使用 ${loc.gameDir}`;
    };
    paintDesc();
    const name = LOC_MODES.find((m) => m.id === mode).name;
    A.modal({
      title: `切换到「${name}」`,
      icon: 'folder',
      size: 'md',
      body: h('div.loc-dialog',
        h('div.loc-paths',
          h('div', h('span.faint', '启动器数据'), h('code', base ? `${base}\\launcher` : '系统默认（AppData）')),
          h('div', h('span.faint', '游戏目录'), gamePath)),
        h('div.field', h('label', '游戏目录（版本、Mod、存档）', sizeEl),
          A.seg([{ value: 'copy', label: '复制过去' }, { value: 'empty', label: '新建空目录' }, { value: 'keep', label: '保持不变' }], game, (v) => { game = v; paintDesc(); }),
          gameDesc),
        h('ul.loc-notes',
          h('li', '原位置的数据不会被删除，确认新位置正常后可以自行清理'),
          h('li', `启动器下载的 Java、账户、设置与${A.t('term.planner')}的${A.t('term.plan')}会一起复制`),
          mode === 'portable' ? h('li', '拷到其他电脑后，正版账户需要重新登录一次（登录凭据由 Windows 加密，只在本机有效）') : null,
          h('li', '切换完成后启动器会自动重启'))),
      actions: [
        { label: A.t('common.cancel'), kind: 'ghost' },
        {
          label: '开始切换', kind: 'primary', icon: 'check', errorTitle: '切换失败',
          onClick: async () => {
            A.toast({ text: '正在复制数据，请稍候…' });
            await api('location:switch', { mode, dir, game });
            A.toast({ level: 'ok', text: '已切换，正在重启启动器…' });
            await api('location:relaunch');
          },
        },
      ],
    });
  }

  function memorySection() {
    const c = state.config;
    const total = state.info.totalMem;
    const used = total - state.info.freeMem;
    const maxSlider = Math.max(1024, Math.floor(total / 256) * 256);
    const val = h('div.mem-value');
    const bar = h('div.mem-bar');
    const legend = h('div.mem-legend');
    let autoMb = 4096;
    let cur = c.memory.max;

    const paint = () => {
      const alloc = c.memory.auto ? autoMb : cur;
      const usedPct = Math.min(100, (used / total) * 100);
      const allocPct = Math.min(100 - usedPct, (alloc / total) * 100);
      const over = alloc > total - used;
      A.mount(bar, h('i.used', { style: { width: `${usedPct}%` } }), h('i', { class: over ? 'over' : 'alloc', style: { width: `${allocPct}%` } }));
      A.mount(legend,
        h('span', h('i', { style: { background: 'var(--text-3)' } }), `系统已用 ${A.fmtMem(used)}`),
        h('span', h('i', { style: { background: over ? 'var(--danger)' : 'var(--accent-2)' } }), `游戏分配 ${A.fmtMem(alloc)}`),
        h('span', h('i', { style: { background: 'var(--surface-3)' } }), `总内存 ${A.fmtMem(total)}`),
        over ? h('span', { style: { color: 'var(--danger)' } }, icon('alert', 12), '分配超过了当前可用内存') : null);
      A.mount(val, A.fmtMem(alloc), h('small', c.memory.auto ? ' 自动' : ''));
    };
    const slider = A.range({
      min: 512, max: maxSlider, step: 256, value: cur, disabled: c.memory.auto,
      onInput: (v) => { cur = v; paint(); },
      onChange: (v) => set({ memory: { max: v } }),
    });
    api('versions:memory', state.config.selectedVersion || '').then((m) => { autoMb = m.auto; paint(); }).catch(() => {});
    paint();
    return [
      row('自动分配内存', '根据系统内存与是否安装 Mod 自动计算', A.toggle(c.memory.auto, (v) => { c.memory.auto = v; slider.disabled = v; set({ memory: { auto: v } }); paint(); })),
      h('div.set-row.col', h('div.row', h('div.s-text', h('div.s-title', '最大内存'), h('div.s-desc', '推荐：原版 2~4 GB，大型整合包 6~10 GB')), val), slider, bar, legend),
      row('最小内存', '启动时预先分配的内存（-Xms）', h('div.input-group', h('input.input.num-input', { type: 'number', min: 128, max: 4096, step: 128, value: c.memory.min, onchange: (e) => set({ memory: { min: Math.max(128, Number(e.target.value) || 256) } }) }), h('span.faint', 'MB'))),
    ];
  }

  // 缓存（1.4.30 / 1.5.0）：资源信息、图片、下载的安装包，分别显示大小和清除
  function cacheRows() {
    const els = { info: h('span.faint'), images: h('span.faint'), downloads: h('span.faint') };
    const refresh = async () => {
      try {
        const u = await api('cache:usage');
        els.info.textContent = `${A.fmtBytes(u.info.bytes)}（${u.info.files} 项）`;
        els.images.textContent = A.fmtBytes(u.images);
        els.downloads.textContent = `${A.fmtBytes(u.downloads.bytes)}（${u.downloads.files} 个文件）`;
      } catch { /* ignore */ }
    };
    const clear = (what, label) => async () => {
      if (!(await A.confirm(`清除${label}？以后用到时会重新下载。`, { title: '清除缓存', okText: '清除' }))) return;
      try { await api('cache:clear', what); A.toast({ level: 'ok', text: `已清除${label}` }); } catch (e) { A.errorToast('清除失败', e); }
      refresh();
    };
    const btn = (what, label) => h('button.btn.sm', { onclick: clear(what, label) }, icon('trash', 14), '清除');
    refresh();
    return [
      row('Mod 资源信息', h('span', 'Modrinth / CurseForge 上的简介、版本、兼容性和搜索结果，保存后重新打开更快，断网时也能看到上次的内容（超过 30 天的自动清理）。占用 ', els.info), btn('info', 'Mod 资源信息缓存')),
      row('图片', h('span', 'Mod 图标、截图等图片。占用 ', els.images), btn('images', '图片缓存')),
      row('下载的安装包', h('span', '加载器安装器和整合包文件，安装完以后就用不到了。占用 ', els.downloads), btn('downloads', '下载的安装包')),
      row('全部清除', '以上三项一起清除（不影响已安装的游戏、Mod 和存档，也不影响 MC 百科中文信息缓存）', h('button.btn.sm.danger', { onclick: clear('all', '全部缓存') }, icon('trash', 14), '全部清除')),
    ];
  }

  /**
   * 日志（rc4）：每局游戏日志保存几天（默认 30 天）、现在存了多少、打开日志中心、清除全部
   */
  function logRows(c) {
    const keep = String(Number((c.logs || {}).keepDays ?? 30));
    const usage = h('span', '正在统计…');
    api('logs:usage').then((u) => { usage.textContent = u.count ? `现在存着 ${u.count} 份，共 ${A.fmtBytes(u.bytes)}` : '还没有保存的日志'; }).catch(() => { usage.textContent = ''; });
    async function clearAll() {
      const ok = await A.dangerConfirm({ level: 2, title: '清除全部游戏日志', text: '已保存的游戏日志会全部删除（正在运行的游戏的日志会留着），删除后不能恢复。', okText: '清除' });
      if (!ok) return;
      try { const n = await api('logs:clear'); A.toast({ level: 'ok', text: `已清除 ${n} 份日志` }); } catch (e) { A.errorToast('清除失败', e); }
      render();
    }
    return [
      row('游戏日志保存多久', '每次启动游戏的完整日志都存在启动器的数据文件夹里，在左边的「日志中心」查看；超过时间的自动删掉', A.select({
        options: [{ value: '7', label: '7 天' }, { value: '30', label: '30 天' }, { value: '90', label: '90 天' }, { value: '0', label: '一直保存' }],
        value: keep, width: 160, onChange: async (v) => { await set({ logs: { keepDays: Number(v) } }); await api('logs:prune').catch(() => {}); render(); },
      })),
      row('已保存的日志', usage, h('div.row.gap-s',
        h('button.btn.sm', { onclick: () => A.go('logs') }, icon('scroll', 14), '日志中心'),
        h('button.btn.sm.ghost', { onclick: clearAll }, icon('trash', 14), '清除全部…'))),
    ];
  }

  function render() {
    root = $('#page-settings');
    const keep = A.settingsNav.keepPlace(root); // 重建后把刚点的那一行放回原处（rc2：展开 / 收起时页面会跳）
    const c = state.config;
    const javaSel = A.select({
      options: javaOptions(),
      value: c.java.selected, width: 320, searchable: true, onChange: (v) => set({ java: { selected: v } }),
    });
    javaSelEl = javaSel;
    const gameDirInput = h('input.input.mono', { value: c.gameDir, readonly: true, style: { width: '330px', fontSize: '12px' } });
    const serverInput = h('input.input', { value: c.server.address, placeholder: 'mc.example.com:25565', disabled: !c.server.enabled, style: { width: '240px' }, onchange: (e) => set({ server: { address: e.target.value.trim() } }) });
    const bgImage = h('div.row.gap-s', { class: c.background.type === 'image' ? '' : 'hidden' },
      h('input.input.mono', { value: c.background.image || '', readonly: true, placeholder: '未选择图片', style: { width: '220px', fontSize: '12px' } }),
      h('button.btn.sm', { onclick: async () => { const p = await api('dialog:file', '选择背景图片', [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]); if (p) { await set({ background: { image: p } }); render(); } } }, '选择'));

    const G = {};
    G.game = group('游戏', 'gamepad',
        Object.assign(row('游戏目录', '.minecraft 文件夹的位置，版本、资源与依赖库都保存在这里', h('div.input-group', gameDirInput,
          h('button.btn.sm', { onclick: async () => { const p = await api('dialog:folder', '选择游戏目录', c.gameDir); if (p) { await set({ gameDir: p }); await A.refreshInstalled(); render(); } } }, '更改'),
          h('button.btn.sm.icon.ghost', { 'data-tip': '打开', onclick: () => api('shell:open', c.gameDir).catch((e) => A.errorToast('无法打开', e)) }, icon('folder', 16)))), { id: 'set-gameDir' }),
        row(A.t('setup.defaultIso'), A.t('setup.defaultIsoDesc'), A.seg([
          { value: 'isolated', label: A.t('setup.isolated'), icon: 'shield' }, { value: 'shared', label: A.t('setup.shared'), icon: 'link' },
        ], c.newProfileIsolation === 'shared' ? 'shared' : 'isolated', (v) => set({ newProfileIsolation: v }))),
        row('独立游戏目录', `哪些版本使用自己的游戏目录（Mod、存档、设置分开存放）；存档共享与${A.t('term.sandbox')}请在「${A.t('term.isolation')}」中设置`, A.seg(ISOLATION_MODES, c.isolation, async (v) => {
          // 配置会搬走或回到公共目录：先问（1.10.10）。取消就什么都不改，按钮回到原来的选项
          try { await A.isoWorlds.changeGlobal(v, ISOLATION_MODES.find((x) => x.value === v).label); } catch (e) { A.errorToast('保存失败', e); }
          render();
        })),
        row('游戏窗口', '初始窗口大小', h('div.input-group',
          h('input.input.num-input', { type: 'number', value: c.window.width, min: 320, onchange: (e) => set({ window: { width: Number(e.target.value) || 854 } }) }),
          h('span.faint', '×'),
          h('input.input.num-input', { type: 'number', value: c.window.height, min: 240, onchange: (e) => set({ window: { height: Number(e.target.value) || 480 } }) }),
          h('label.row.gap-s', { style: { marginLeft: '10px', cursor: 'pointer' } }, A.toggle(c.window.fullscreen, (v) => set({ window: { fullscreen: v } })), h('span.muted', '全屏')))),
        row('自动进入服务器', '启动后直接连接到指定服务器', h('div.input-group', A.toggle(c.server.enabled, (v) => { serverInput.disabled = !v; set({ server: { enabled: v } }); }), serverInput)),
        // 游戏语言跟着启动器语言：英文界面不改游戏语言，没有这一行
        gameLangRow(row, c, set),
        row('版本类型标识', '显示在游戏主菜单左下角', h('input.input', { value: c.versionType, style: { width: '200px' }, onchange: (e) => set({ versionType: e.target.value.trim() || A.BRAND.short }) })));
    G.sync = Object.assign(group('游戏设置同步', 'refresh', ...A.gameSyncUi.settingsRows(row, render)), { id: 'set-gamesync' });
    G.storage = group('数据存储位置', 'folder', storageSection(),
        // rc8：以前这一行叫「换电脑 / 搬数据」，说明里没提其他启动器，玩家找不到从官方启动器迁移的入口
        Object.assign(row('导入、导出数据', '从官方启动器、HMCL、PCL2、MultiMC / Prism 导入游戏配置和存档；换电脑时把游戏配置、存档、设置、皮肤打包带走，或者从导出包、另一套 Aurora 数据导入',
          h('div.row.gap-s', h('button.btn.sm', { onclick: () => A.migrateUi.importDialog({ source: 'foreign' }) }, icon('import', 14), '从其他启动器导入…'),
            h('button.btn.sm', { onclick: () => A.migrateUi.exportDialog() }, icon('upload', 14), '导出数据…'), h('button.btn.sm', { onclick: () => A.migrateUi.importDialog() }, icon('import', 14), '导入…'))), { id: 'set-migrate' }));
    G.backup = group(A.t('backup.set.group'), 'save', ...backupRows(c));
    G.memory = group('内存', 'memory', ...memorySection());
    G.java = group('Java', 'coffee',
        row('默认 Java', '自动模式会为每个版本选择合适的 Java', javaSel),
        row('自动下载缺失的 Java', '找不到合适的 Java 时自动下载 Mojang 官方运行时', A.toggle(c.java.autoDownload, (v) => set({ java: { autoDownload: v } }))),
        h('div.set-row.col', h('div.s-text', h('div.s-title', 'JVM 参数'), h('div.s-desc', '附加到所有版本的 Java 虚拟机参数。设置了 -XX:+Use…GC 时将替换默认的 G1 垃圾回收参数')),
          h('textarea.textarea', { placeholder: '例如：-XX:+UseZGC -Dsun.java2d.opengl=true', spellcheck: 'false', onchange: (e) => set({ jvmArgs: e.target.value.trim() }) }, c.jvmArgs)),
        h('div.set-row.col', h('div.s-text', h('div.s-title', '游戏参数'), h('div.s-desc', '附加到所有版本的游戏启动参数')),
          h('textarea.textarea', { style: { minHeight: '56px' }, placeholder: '例如：--demo', spellcheck: 'false', onchange: (e) => set({ gameArgs: e.target.value.trim() }) }, c.gameArgs)));
    G.download = group('下载', 'download',
        row('下载源', '自动模式会测速后选择更快的源，失败时自动切换', A.seg([
          { value: 'auto', label: '自动' }, { value: 'official', label: 'Mojang 官方' }, { value: 'bmclapi', label: 'BMCLAPI 镜像' },
        ], c.downloadSource, async (v) => { await set({ downloadSource: v }); state.mirrorLabel = await api('mirror:label').catch(() => ''); A.emit('mirror'); })),
        (() => {
          const v = h('span.mem-value', { style: { fontSize: '16px', minWidth: '40px' } }, c.concurrency);
          return row('最大并发下载数', '同时下载的文件数量，网络较差时可适当调低', h('div.row', { style: { width: '300px' } },
            A.range({ min: 4, max: 128, step: 4, value: c.concurrency, onInput: (x) => { v.textContent = x; }, onChange: (x) => set({ concurrency: x }) }), v));
        })());
    G.cache = Object.assign(group('缓存', 'box', ...cacheRows()), { id: 'set-cache' });
    G.logs = Object.assign(group('日志', 'scroll', ...logRows(c)), { id: 'set-logs' });
    G.cf = Object.assign(group('CurseForge', 'flame', ...cfRows(c)), { id: 'set-curseforge' });
    G.mcmod = A.mcmodUi.zhUi && !A.mcmodUi.zhUi() ? null : Object.assign(group(A.mcmodUi.TITLE, 'globe', ...A.mcmodUi.settingsRows(row, render)), { id: 'set-mcmod' });
    G.launcher = group('启动器', 'settings',
        A.langUi.settingsRow(row),
        Object.assign(row('性能模式', '让启动器更省资源：关掉动画、毛玻璃、阴影、3D 皮肤预览、背景音乐和音效、主页更新日志和硬件加速（重启后生效），主页背景变成静止的画面。页面都还在，配置比较低的电脑推荐打开', A.toggle(!!c.perfMode, async (v) => { await A.perf.set(v); render(); })), { id: 'set-perf' }),
        Object.assign(row('简洁模式', '只留下启动游戏、存档和 Java 管理、启用 / 禁用或删除 Mod、切换账户和改皮肤，其余功能收起来（入口变灰）。和性能模式互不影响', A.toggle(!!c.simpleMode, async (v) => { await A.simple.set(v); render(); })), { id: 'set-simple' }),
        row(A.t('news.setting'), A.t('news.settingDesc'), A.toggle(c.news.enabled, (v) => set({ news: { enabled: v } }))),
        row('游戏启动后', null, A.select({
          options: [
            { value: 'keep', label: '保持启动器' }, { value: 'minimize', label: '最小化启动器' },
            { value: 'hide', label: '隐藏启动器' }, { value: 'close', label: '关闭启动器' },
          ],
          value: c.afterLaunch, width: 180, onChange: async (v) => { await set({ afterLaunch: v }); render(); },
        })),
        // 关闭启动器会让本地皮肤服务一起停掉
        c.afterLaunch === 'close' ? row('用到本地皮肤服务时', '离线账户的自定义皮肤靠启动器提供，启动器关掉后游戏里就看不到了', A.select({
          options: [
            { value: 'ask', label: '每次询问' }, { value: 'keep', label: '游戏结束后再关闭' }, { value: 'close', label: '照常关闭（看不到皮肤）' },
          ],
          value: (c.skin || {}).closeChoice || 'ask', width: 200, onChange: (v) => set({ skin: { closeChoice: v } }),
        })) : null,
        row('游戏退出后恢复窗口', null, A.toggle(c.restoreOnExit, (v) => set({ restoreOnExit: v }))),
        row('启动时显示日志', '游戏启动后自动打开日志面板', A.toggle(c.showLogOnLaunch, (v) => set({ showLogOnLaunch: v }))));
    G.look = group('界面', 'palette',
        ...A.uiStyle.settingsRows(row, render),
        row('主题', null, A.seg([{ value: 'dark', label: '深色', icon: 'moon' }, { value: 'light', label: '浅色', icon: 'sun' }], c.theme, (v) => set({ theme: v }))),
        row('强调色', null, h('div.swatches', ACCENTS.map(([id, bg, name]) => h('div', { class: `swatch ${c.accent === id ? 'on' : ''}`, style: { background: bg }, 'data-tip': name, onclick: async () => { await set({ accent: id }); render(); } })))));
    G.bg = group('主页背景', 'image',
        Object.assign(row('主页背景', '动态像素场景会随真实时间变化', h('div.row.wrap', { style: { justifyContent: 'flex-end' } },
          A.seg([{ value: 'scene', label: '像素场景' }, { value: 'image', label: '自定义图片' }, { value: 'gradient', label: '渐变' }], c.background.type, async (v) => { await set({ background: { type: v } }); render(); }),
          bgImage)), { id: 'set-background' }),
        ...(c.background.type === 'scene' ? sceneRows(c) : []));
    G.a11y = Object.assign(group('无障碍', 'eye', ...A.a11y.settingsRows(row, render)), { id: 'set-a11y' });
    // 声音（rc3）：背景音乐和音效的开关都放在「常规」里，顶栏也有这两个开关
    const volRow = (title, cur, key) => {
      const val = h('span.mem-value', { style: { fontSize: '16px', minWidth: '48px' } }, `${Math.round(cur * 100)}%`);
      return row(title, null, h('div.row', { style: { width: '300px' } },
        A.range({ min: 0, max: 100, step: 1, value: Math.round(cur * 100), onInput: (x) => { val.textContent = `${x}%`; }, onChange: (x) => set({ [key]: { volume: x / 100 } }) }), val));
    };
    const snd = c.sound || { enabled: true, volume: 0.45 };
    G.music = Object.assign(group('声音', 'music',
        row('播放背景音乐', '10 首原创的 Minecraft 风格氛围曲（含 6 首背景场景主题曲），由启动器实时合成；默认关闭', A.toggle(c.music.enabled, (v) => A.music.setEnabled(v))),
        volRow('背景音乐音量', c.music.volume, 'music'),
        row('游戏运行时自动暂停', '避免和游戏内的音乐重叠', A.toggle(c.music.pauseInGame, (v) => set({ music: { pauseInGame: v } }))),
        row('曲目与 MIDI', '切换曲目、单曲循环，或把曲谱导出为 MIDI 文件', h('button.btn.sm', { onclick: () => document.querySelector('#btnMusic .mb-main').click() }, icon('music', 14), '打开播放器')),
        Object.assign(row('音效', '主页背景里的声音：点方块、生物叫、下雨打雷等。从你装好的游戏里读原版声音，没装游戏时用启动器合成的；玩游戏时不响', A.toggle(snd.enabled !== false, (v) => A.gameSound.setEnabled(v))), { id: 'set-sound' }),
        volRow('音效音量', snd.volume ?? 0.45, 'sound')), { id: 'set-music' });
    G.ms = group('微软登录', 'shield',
        A.FEATURES.msLogin
          ? row('自定义 Client ID（一般不用填）', '启动器已内置通过微软审核的应用，直接就能登录。只有想用自己申请的 Azure 应用时才填这里', h('div.input-group',
            h('input.input.mono', { value: c.msClientId, placeholder: '留空使用内置默认', style: { width: '300px', fontSize: '12px' }, spellcheck: 'false', onchange: (e) => {
              const v = e.target.value.trim();
              // 格式不对就不存，退回原来的（以前什么都收，登录时才报一个看不懂的错）
              if (v && !window.WEBURL.isClientId(v)) { A.toast({ level: 'warn', text: 'Client ID 格式不正确：应该是「应用程序(客户端) ID」那一串，形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }); e.target.value = state.config.msClientId || ''; return; }
              set({ msClientId: v });
            } }),
            h('button.btn.sm.ghost.icon', { 'data-tip': '配置说明', onclick: () => A.clientIdDialog() }, icon('info', 16))))
          : row('微软正版登录', '正在向微软申请，通过审核后开放；现在请先使用离线账户或外置登录', h('span.soon-tag.lg', { 'data-tip': A.MS_PENDING }, '正在申请')));
    G.about = group('关于', 'info',
        row(h('span', { id: 'aboutVersion', onclick: () => A.debugMenu.versionClick(), style: { userSelect: 'none' } }, `${A.BRAND.name}${window.I18N.getLang() === 'en' ? ' ' : `（${A.BRAND.zh}）`}${state.info.version}`, h('span', state.info.edition === 'public' ? '（公开版）' : '（内部版）')), `Electron ${state.info.electron} · ${state.info.platform}-${state.info.arch} · ${state.info.cpu}`,
          h('button.btn.sm', { onclick: () => api('shell:open', state.info.dataDir) }, icon('folder', 14), '数据目录')),
        // 隐私声明（1.8.0，文字在 shared/brand.js）
        row('隐私', h('div', A.BRAND.privacy.map((p) => h('div', { style: { marginTop: '4px' } }, p))), h('span.badge.ok', icon('shield', 12), '无数据收集')),
        row(A.t('setup.rerun'), A.t('setup.rerunDesc'), h('button.btn.sm', { onclick: () => A.setup.open() }, icon('sparkles', 14), A.t('setup.rerunBtn'))),
        row('还原启动器', '设置恢复默认、清掉启动器的记录，回到刚安装的状态；也可以连游戏和存档一起清理（移到回收站）', h('button.btn.sm.danger', { onclick: () => A.resetLauncher() }, icon('history', 14), '还原…')),
        row('免责声明', '开源、免费的第三方启动器，与 Microsoft / Mojang 无关', h('button.btn.sm', { onclick: () => A.disclaimer({ force: true }) }, icon('file', 14), '查看免责声明')),
        row('参考与致谢', '和其他启动器相似的功能参考了谁、用到的在线服务、第三方作品和许可证', h('button.btn.sm', { onclick: () => A.credits.open() }, icon('heart', 14), '查看')));

    // 分类（rc2：所有设置在一个页面里滚来滚去太难找）。别的页面跳到某个设置项时 show() 用 reveal 切到对应的分类
    nav = A.settingsNav.layout([
      { id: 'general', label: '常规', icon: 'settings', groups: [G.launcher, G.music, G.ms] },
      { id: 'look', label: '外观', icon: 'palette', groups: [G.look, G.bg] },
      { id: 'game', label: '游戏', icon: 'gamepad', groups: [G.game, G.sync, G.memory, G.java] },
      { id: 'download', label: '下载', icon: 'download', groups: [G.download, G.cf, G.mcmod] },
      { id: 'data', label: '数据', icon: 'folder', groups: [G.storage, G.backup, G.cache, G.logs] },
      { id: 'a11y', label: '无障碍', icon: 'eye', groups: [G.a11y] },
      { id: 'about', label: '关于', icon: 'info', groups: [G.about] },
    ]);
    A.mount(root, h('div.page-inner.set-page',
      h('div.page-head', h('div', h('h1', '设置'), h('p', '全局设置对所有版本生效，可在版本设置中单独覆盖'))),
      nav));
    A.settingsNav.restorePlace(root, keep);
  }

  function init() {
    // 只刷新 Java 下拉框：Java 扫描结束时整页重建会把正在输入的内容清掉
    on('javas', () => { if (javaSelEl && javaSelEl.isConnected) javaSelEl.setOptions(javaOptions(), state.config.java.selected); });
    // 对话框里改了设置（首次启动向导、导入数据、调试菜单……）：对话框都关上以后整页按新设置重画（rc16：以前在向导里打开了
    // MC 百科，回到背后的设置页还显示关着，玩家以为没打开，又去开一次）
    let stale = false;
    on('config', () => { if (state.page === 'settings' && A.modalOpen()) stale = true; });
    on('modalClosed', (left) => { if (left || !stale) return; stale = false; if (state.page === 'settings') render(); });
  }

  /** params.focus：滚动到对应的设置项并闪一下（例如主页场景胶囊的「更多背景设置…」） */
  function show(params) {
    render();
    const el = params && params.focus && document.getElementById(`set-${params.focus}`);
    if (!el) return;
    if (nav) nav.reveal(el);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.add('set-flash');
    setTimeout(() => el.classList.remove('set-flash'), 1600);
  }

  A.pages.settings = { init, show, title: '设置' };
})();
