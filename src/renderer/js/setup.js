'use strict';
/*
 * 首次启动向导：辅助功能（1.5.5）→ 数据位置 → 游戏目录 → 存档方式 → 主页背景（按硬件推荐档位）→ Java →（内部版、中文界面）MC 百科。
 * 设置页「关于」里可以重新打开。
 * 防连点（rc16）：每页刚出来的一小会儿点「下一步 / 完成」不算（双击不会一下翻两页）；在某一页停得太短就翻过去的记下来，
 * 到最后一页列出这几页用的是什么设置、可以点回去看，「完成」要等几秒。看得快、但每页都停了一下的玩家不受影响
 */
(function () {
  const { h, api, state, t } = A;

  const BASE_STEPS = ['a11y', 'location', 'game', 'saves', 'bg', 'java'];
  const GUARD_MS = 450; // 新的一页出来以后这么久之内的点击不算（双击、连点）
  const RUSH_MS = 1500; // 一页停不到这么久就翻过去，算「翻得太快」
  const WAIT_S = 5; // 有翻得太快的页，最后一页的「完成」等几秒
  const TIER_NAMES = { high: '高', medium: '中', low: '低', static: '静态' };
  const same = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
  const blocking = (p) => !!p && (!p.writable || p.issues.some((i) => i.level === 'crit'));

  /**
   * @param {{firstRun?: boolean}} opts firstRun：启动时自动弹出（不能用 Esc 关掉；切到便携 / 自定义后清理系统默认位置的空配置）
   * @returns {Promise<void>} 向导关闭时完成（换了数据位置会直接重启）
   */
  async function open({ firstRun = false } = {}) {
    const loc = await api('location:get');
    // MC 百科单独一页放在最后（rc16）：只有内部版（有真的实现）、中文界面才有；公开版的概念演示还是 Java 那一页里的一段说明
    const mcmodPage = !!(A.mcmodUi && !A.mcmodUi.CONCEPT && A.mcmodUi.setupPage && A.mcmodUi.zhUi());
    const STEPS = mcmodPage ? [...BASE_STEPS, 'mcmod'] : BASE_STEPS;
    const s = {
      step: 0,
      enteredAt: performance.now(), // 进这一页的时间（防连点）
      rushed: new Set(), // 翻得太快的页
      waitLeft: 0, // 最后一页「完成」还要等几秒
      bg: A.bgPerf.newState(), // 主页背景：一打开向导就开始看硬件，到这一步时多半已经推荐好了
      mode: loc.mode === 'env' ? 'env' : loc.mode,
      dir: loc.mode === 'custom' ? loc.base : null,
      game: null,
      iso: state.config.newProfileIsolation === 'shared' ? 'shared' : 'isolated',
      java: null, // 1.7.4：照样推荐 Java 21，但不预先选好，玩家自己点（什么都没选就是以后再说）
      perf: !!state.config.perfMode,
      simple: !!state.config.simpleMode,
      // 第一步选了哪种辅助（只决定展开哪些选项；已经开着的项算选过）
      need: { vision: (state.config.a11y || {}).zoom > 1 || !!(state.config.a11y || {}).largeText || !!(state.config.a11y || {}).cvd || (state.config.a11y || {}).contrast === 'on', hearing: !!(state.config.a11y || {}).subtitles },
      busy: false,
    };
    const perfBefore = !!state.config.perfMode;
    const probes = new Map();
    const games = new Map();
    const body = h('div.setup');
    let m;

    // 候选位置的检查结果（缓存）
    const probe = (dir) => {
      if (!dir) return null;
      if (!probes.has(dir)) {
        probes.set(dir, null);
        api('place:probe', dir, 'data').then((p) => { probes.set(dir, p); render(); }).catch(() => probes.delete(dir));
      }
      return probes.get(dir);
    };
    const gameInfo = (dir) => {
      if (!dir) return null;
      if (!games.has(dir)) {
        games.set(dir, null);
        api('location:probeGame', dir).then((g) => { games.set(dir, g); render(); }).catch(() => games.set(dir, { dir, exists: false, versions: 0, saves: 0 }));
      }
      return games.get(dir);
    };
    const baseOf = (mode) => (mode === 'portable' ? loc.portableBase : mode === 'custom' ? s.dir : null);
    const targetGame = () => {
      if (s.mode === 'env') return loc.gameDir;
      const base = baseOf(s.mode);
      return base ? `${base}\\.minecraft` : loc.systemGameDir;
    };
    const switching = () => {
      if (s.mode === 'env') return false;
      if (s.mode !== loc.mode || (s.mode === 'custom' && !same(s.dir, loc.base))) return true;
      return !same(targetGame(), loc.gameDir) && s.game && s.game !== 'keep';
    };

    // 便携版 exe 的便携位置可以写入、也没有问题时，第一次默认选便携模式
    if (firstRun && loc.canPortable && s.mode === 'default') {
      api('place:probe', loc.portableBase, 'data').then((p) => {
        probes.set(loc.portableBase, p);
        if (!blocking(p) && !p.issues.length && s.step <= STEPS.indexOf('location') && s.mode === 'default') s.mode = 'portable';
        render();
      }).catch(() => {});
    }
    const recommended = () => {
      const p = probes.get(loc.portableBase);
      return loc.canPortable && p && !blocking(p) && !p.issues.length ? 'portable' : 'default';
    };

    // ───────────── 第 1 步：数据位置 ─────────────
    function stepLocation() {
      const env = s.mode === 'env';
      const card = (id, iconName, title, desc, disabled) => A.choice({
        iconName, title, desc, on: s.mode === id, disabled: env || disabled,
        badge: loc.mode === id && !firstRun ? h('span.badge', t('setup.current')) : recommended() === id ? h('span.badge.accent', t('setup.recommended')) : null,
        onClick: async () => {
          if (id === 'custom') {
            const dir = await api('dialog:folder', t('setup.custom'), s.dir || undefined);
            if (!dir) return;
            s.dir = dir;
          }
          s.mode = id;
          s.game = null;
          render();
        },
      });
      const base = baseOf(s.mode);
      const p = base ? probe(base) : null;
      return [
        h('div.setup-head', t('setup.locationHead')),
        env ? A.alert({ level: 'info', compact: true, text: t('setup.envNote') }) : null,
        h('div.choices.cols-3',
          card('portable', 'box', t('setup.portable'), loc.canPortable ? t('setup.portableDesc') : t('setup.portableNo'), !loc.canPortable),
          card('default', 'monitor', t('setup.default'), t('setup.defaultDesc')),
          card('custom', 'folder', t('setup.custom'), s.dir || t('setup.customDesc'))),
        env ? null : h('div.loc-paths', { style: { marginTop: '14px' } },
          h('div', h('span.faint', t('setup.dataAt')), h('code', base ? `${base}\\launcher` : loc.defaultDataDir)),
          h('div', h('span.faint', t('setup.gameAt')), h('code', targetGame()))),
        base && p === null ? h('div.row', { style: { marginTop: '10px' } }, h('span.spinner'), h('span.muted', t('place.checking'))) : null,
        p && p.issues.length ? h('div.place-list', { style: { marginTop: '10px' } }, p.issues.map((it) => A.placeCheck.issueAlert(it, { compact: true, probe: true }))) : null,
      ];
    }

    // ───────────── 第 2 步：游戏目录 ─────────────
    function stepGame() {
      const target = targetGame();
      const cur = loc.gameDir;
      if (s.mode === 'env' || same(target, cur)) {
        const g = gameInfo(cur);
        return [
          h('div.setup-head', t('setup.gameHead')),
          A.choice({ iconName: 'folder', title: t('setup.gameSame', { dir: cur }), on: true, layout: 'row',
            desc: g === null ? t('place.checking') : g.exists ? t('setup.gameFound', { versions: g.versions, saves: g.saves }) : t('setup.gameNew') }),
          s.mode === 'default' ? h('p.faint.setup-note', t('setup.gameElsewhere')) : null,
        ];
      }
      const g = gameInfo(cur);
      const has = g && g.exists;
      if (!s.game && g) s.game = has && g.versions ? 'keep' : 'empty';
      const card = (id, iconName, title, desc, disabled) => A.choice({ iconName, title, desc, on: s.game === id, disabled, layout: 'row', onClick: () => { s.game = id; render(); } });
      return [
        h('div.setup-head', t('setup.gameHead')),
        g === null ? h('div.row', h('span.spinner'), h('span.muted', t('place.checking'))) : h('div.choices.setup-rows',
          card('empty', 'plus', t('setup.gameEmpty'), t('setup.gameEmptyDesc', { dir: target })),
          card('copy', 'copy', t('setup.gameCopy'), has ? t('setup.gameCopyDesc', { from: cur, versions: g.versions, saves: g.saves }) : t('setup.gameNone'), !has),
          card('keep', 'link', t('setup.gameKeep'), has ? t('setup.gameKeepDesc', { from: cur }) : t('setup.gameNone'), !has)),
      ];
    }

    // ───────────── 第 3 步：存档方式 ─────────────
    function stepSaves() {
      const card = (id, iconName, title, desc) => A.choice({ iconName, title, desc, on: s.iso === id, badge: id === 'isolated' ? h('span.badge.accent', t('setup.recommended')) : null, onClick: () => { s.iso = id; render(); } });
      return [
        h('div.setup-head', t('setup.savesHead')),
        h('div.choices.cols-2', card('isolated', 'shield', t('setup.isolated'), t('setup.isolatedDesc')), card('shared', 'link', t('setup.shared'), t('setup.sharedDesc'))),
        h('p.faint.setup-note', t('setup.savesNote')),
      ];
    }

    // ───────────── 第 4 步：Java ─────────────
    function stepJava() {
      const javas = state.javas;
      if (!javas) {
        A.refreshJavas(false).then(render).catch(() => {});
        return [h('div.setup-head', t('setup.javaHead')), h('div.row', h('span.spinner'), h('span.muted', t('java.scanning')))];
      }
      if (javas.length) {
        const majors = [...new Set(javas.map((j) => j.major))].sort((a, b) => a - b).map((n) => `Java ${n}`).join('、');
        return [h('div.setup-head', t('setup.javaHead')), A.alert({ level: 'ok', title: t('java.found', { list: majors }), text: t('java.foundDesc') })];
      }
      const card = (id, iconName, title, desc, onPick) => A.choice({ iconName, title, desc, on: s.java === id, layout: 'row', onClick: onPick || (() => { s.java = id; render(); }) });
      return [
        h('div.setup-head', t('setup.javaHead')),
        A.alert({ level: 'warn', compact: true, title: t('java.noneTitle'), text: t('java.noneText') }),
        h('div.choices.setup-rows', { style: { marginTop: '12px' } },
          card('install', 'download', t('java.installRecommended'), t('java.installRecommendedDesc')),
          card('pick', 'folder', t('java.pickExe'), t('java.pickExeDesc'), async () => { if (await A.javaCheck.pickExe()) render(); }),
          card('later', 'clock', t('java.later'), t('java.laterShort'))),
      ];
    }

    // 首次启动就说明 MC 百科功能是实验性的、默认关（mcmodui.js；公开版是一行概念演示说明）
    const mcmodNotice = () => A.mcmodUi.setupNotice(render);
    // 电脑比较旧的玩家可以一开始就用性能模式
    const perfRow = () => h('div.row.gap-s.setup-perf', { style: { marginTop: '14px', alignItems: 'flex-start' } },
      A.toggle(!!s.perf, (v) => { s.perf = v; }),
      h('div', h('div', { style: { fontWeight: 600, fontSize: '13px' } }, '性能模式（电脑配置比较低时推荐）'), h('div.faint', { style: { fontSize: '12px', marginTop: '2px' } }, A.perf.DESC)));
    // 简洁模式（1.7.4）：和性能模式并排，默认关
    const simpleRow = () => h('div.row.gap-s.setup-perf', { style: { marginTop: '10px', alignItems: 'flex-start' } },
      A.toggle(!!s.simple, (v) => { s.simple = v; }),
      h('div', h('div', { style: { fontWeight: 600, fontSize: '13px' } }, '简洁模式（只想安安静静开游戏时）'), h('div.faint', { style: { fontSize: '12px', marginTop: '2px' } }, A.simple.DESC)));
    // 按这台电脑的配置推荐主页背景的档位（预选，可以换、可以逐项调，点完成才生效）
    const stepBg = () => {
      if (!s.bg.ready) s.bg.load.then(() => { if (STEPS[s.step] === 'bg') render(); });
      return [h('div.setup-head', '主页背景'), h('div.faint', { style: { margin: '4px 0 12px', fontSize: '13px' } }, '主页的像素背景可以按这台电脑的配置调得轻一些，避免卡顿。以后在「设置」的背景部分也能改。'), A.bgPerf.card(s.bg, render, 'setup')];
    };
    const BUILD = {
      a11y: () => A.a11y.setupStep(s.need, render), location: stepLocation, game: stepGame, saves: stepSaves, bg: stepBg,
      java: () => [...stepJava(), perfRow(), simpleRow(), mcmodPage ? null : h('div', { style: { marginTop: '14px' } }, mcmodNotice())],
      mcmod: () => A.mcmodUi.setupPage(render),
    };

    // ───────────── 防连点 ─────────────
    // 每一页用的是什么设置（最后一页列「翻得太快的页」时用）
    function summaryOf(k) {
      if (k === 'a11y') return [s.need.vision ? '视觉辅助' : '', s.need.hearing ? '听觉辅助' : ''].filter(Boolean).join('、') || '没有打开辅助功能';
      if (k === 'location') return ({ portable: t('setup.portable'), default: t('setup.default'), custom: t('setup.custom'), env: '由启动参数指定' })[s.mode] || s.mode;
      if (k === 'game') return s.mode === 'env' || same(targetGame(), loc.gameDir) ? `沿用 ${loc.gameDir}` : ({ empty: t('setup.gameEmpty'), copy: t('setup.gameCopy'), keep: t('setup.gameKeep') })[s.game] || '还没选';
      if (k === 'saves') return s.iso === 'shared' ? t('setup.shared') : t('setup.isolated');
      if (k === 'bg') return s.bg.ready ? `背景档位：${TIER_NAMES[s.bg.tier] || s.bg.tier}` : '背景档位：推荐的';
      if (k === 'java') {
        const j = state.javas && state.javas.length ? '已经找到 Java' : ({ install: t('java.installRecommended'), pick: t('java.pickExe'), later: t('java.later') })[s.java] || 'Java 还没选（以后再说）';
        return `${j}；性能模式${s.perf ? '开' : '关'}、简洁模式${s.simple ? '开' : '关'}`;
      }
      return '';
    }
    function rushedNote() {
      if (!s.rushed.size) return null;
      const list = STEPS.filter((k) => s.rushed.has(k));
      return A.alert({
        level: 'warn', compact: true, title: `刚才有 ${list.length} 页翻得很快`,
        text: h('div',
          h('div', '这几页用的是下面的设置。确认没问题再点「完成」；想改的话点「回去看看」。'),
          h('ul.setup-rushed', list.map((k) => h('li', h('b', t(`setup.step.${k}`)), '：', summaryOf(k), ' ',
            h('button.btn.sm.ghost', { onclick: () => goStep(STEPS.indexOf(k)) }, '回去看看'))))),
      });
    }
    let finishBtn = null;
    let waitTimer = null;
    const syncFinish = () => {
      if (!finishBtn || !finishBtn.isConnected) return;
      finishBtn.disabled = !canNext() || s.waitLeft > 0;
      if (finishBtn.lastChild) finishBtn.lastChild.textContent = s.waitLeft > 0 ? `${t('setup.finish')}（${s.waitLeft}）` : t('setup.finish');
    };
    /** 换到第 n 页：往后翻时记下上一页停了多久；翻到最后一页、前面有翻得太快的，「完成」等 WAIT_S 秒 */
    function goStep(n) {
      const now = performance.now();
      if (n > s.step) { const k = STEPS[s.step]; if (now - s.enteredAt < RUSH_MS) s.rushed.add(k); else s.rushed.delete(k); }
      s.step = n;
      s.enteredAt = now;
      clearInterval(waitTimer);
      waitTimer = null;
      s.waitLeft = 0;
      if (s.step === STEPS.length - 1 && s.rushed.size) {
        s.waitLeft = WAIT_S;
        waitTimer = setInterval(() => { s.waitLeft--; syncFinish(); if (s.waitLeft <= 0) { clearInterval(waitTimer); waitTimer = null; } }, 1000); // pitfall-ok：数到 0 自己停；换页、向导关掉（onClose）时也 clearInterval
      }
      render();
    }
    const tooSoon = () => performance.now() - s.enteredAt < GUARD_MS;

    function canNext() {
      if (s.busy) return false;
      if (STEPS[s.step] === 'location') {
        if (s.mode === 'custom' && !s.dir) return false;
        const base = baseOf(s.mode);
        if (base) { const p = probes.get(base); if (!p || blocking(p)) return false; }
      }
      if (STEPS[s.step] === 'game' && !same(targetGame(), loc.gameDir) && s.mode !== 'env' && !s.game) return false;
      return true;
    }

    function render() {
      if (!m) return;
      const last = s.step === STEPS.length - 1;
      A.mount(body, [last ? rushedNote() : null, ...BUILD[STEPS[s.step]]()]);
      m.setSteps({ items: STEPS.map((k) => t(`setup.step.${k}`)), current: s.step });
      m.setActions([
        { label: firstRun ? t('setup.skip') : t('common.cancel'), kind: 'ghost', left: true, onClick: firstRun ? skip : undefined },
        s.step > 0 ? { label: t('setup.back'), kind: 'ghost', onClick: () => { goStep(s.step - 1); return false; } } : null,
        {
          label: last ? t('setup.finish') : t('setup.next'), kind: 'primary', icon: last ? 'check' : null, errorTitle: t('setup.failed'),
          ref: (b) => { b.disabled = !canNext(); finishBtn = last ? b : null; syncFinish(); },
          // 刚翻过来的一小会儿点了不算；最后一页还在等的时候也不算
          onClick: last ? () => (tooSoon() || s.waitLeft > 0 ? false : finish()) : () => { if (!tooSoon()) goStep(s.step + 1); return false; },
        },
      ].filter(Boolean));
    }

    async function skip() {
      await api('app:finishSetup', {});
      state.config = await api('config:set', { migrateAsk: true });
      A.emit('config', state.config);
      // 跳过了 Java 这一步：没有 Java 时单独提醒一次
      setTimeout(() => A.javaCheck.prompt(), 400);
    }

    async function finish() {
      const noJava = state.javas && !state.javas.length;
      const sw = switching();
      await api('app:finishSetup', { newProfileIsolation: s.iso, pendingJava: sw && noJava && s.java === 'install' ? A.javaCheck.RECOMMENDED : '' });
      // 向导里已经回答过 Java 的问题，以后不再单独弹「没有检测到 Java」
      // 向导做完问一次要不要导入以前的数据（1.5.3）：首次启动由 app.js 问；从「关于」重新打开向导的，下面关掉向导后问（rc8，以前只有首次启动问）。
      // 换了数据位置要重启的，重启后 app.js 看 migrateAsk 问
      const finished = await api('config:set', { tips: { noJava: true }, perfMode: !!s.perf, simpleMode: !!s.simple, ...(s.bg.ready ? { background: A.bgPerf.patch(s.bg) } : {}), migrateAsk: true });
      A.adoptConfig(finished);
      if (sw) {
        s.busy = true;
        render();
        A.mount(body, h('div.setup-busy', h('span.spinner'), h('span', t('setup.switching'))));
        try {
          await api('location:switch', { mode: s.mode, dir: s.dir, game: s.game || 'keep', firstRun });
        } catch (e) { s.busy = false; render(); throw e; }
        A.toast({ level: 'ok', text: t('setup.switched') });
        await api('location:relaunch');
        return false;
      }
      if (noJava && s.java === 'install') A.javaCheck.install(A.javaCheck.RECOMMENDED, 21);
      if (mcmodPage) A.mcmodUi.setupFinish(); // 最后一页打开了 MC 百科、选了建缓存的，在后台开始（换数据位置要重启的上面已经返回，不建）
      if (firstRun) A.toast({ level: 'ok', text: t('setup.done') });
      else setTimeout(() => A.migrateUi.offer(), 350); // 向导关掉以后再弹
      if (s.perf && !perfBefore) A.toast({ level: 'info', title: '已开启性能模式', text: '硬件加速会在下次启动启动器时关闭。随时可以在侧边栏下面或「设置 → 启动器」里关掉' });
      if (!s.perf && perfBefore) A.toast({ level: 'info', title: '已关闭性能模式', text: '硬件加速会在下次启动启动器时重新打开' });
      return true;
    }

    return new Promise((resolve) => {
      m = A.modal({
        title: t('setup.title', { name: A.BRAND.name }),
        subtitle: t('setup.subtitle'),
        icon: 'sparkles',
        size: 'lg',
        className: 'setup-modal',
        dismissable: !firstRun,
        body,
        actions: [],
        onClose: () => { clearInterval(waitTimer); resolve(); },
      });
      render();
    });
  }

  A.setup = { open };
})();
