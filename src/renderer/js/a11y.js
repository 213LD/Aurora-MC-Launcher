'use strict';
/* 无障碍：界面缩放、大字号、高对比度、减少动态效果、色弱友好配色、讲述人 / 实时辅助字幕入口、游戏字幕。
 * - 缩放由主进程 setZoomFactor 做（main.js，跟着 config.a11y.zoom 变），这里只管快捷键和设置项
 * - 大字号是窗口创建时的 minimumFontSize（最小 13px），要重启才生效
 * - 高对比度 / 减少动态效果「跟随系统」= Windows 的高对比度主题、「显示动画」开关（Chromium 的 forced-colors / prefers-reduced-motion）
 * - 给 <html> 加 hc / reduce-motion / motion-soft / no-flash / cvd，样式在 style.css 末尾；动态效果「全部关闭」时主页像素场景定格成一张静止的画面（home.js）
 * - 动态效果三档（1.5.5）：完整 / 减弱（动画更短、不循环，场景照常动）/ 全部关闭；「减少闪烁」单独开关：去掉爆炸白光、烟花、流星、受伤和苦力怕闪白、萤火虫明暗、按钮流光、标语跳动
 * - 首次启动向导第一步（setupStep）：问要不要视觉 / 听力辅助，讲述人只给入口不自动打开 */
(function () {
  const { h, icon, api, state } = A;
  const ZOOMS = [1, 1.25, 1.5, 1.75, 2];
  const MQ = {
    motion: window.matchMedia('(prefers-reduced-motion: reduce)'),
    contrast: window.matchMedia('(forced-colors: active), (prefers-contrast: more)'),
  };
  const cfg = () => ({ zoom: 1, largeText: false, contrast: 'auto', motion: 'auto', noFlash: false, cvd: false, subtitles: false, ...((state.config && state.config.a11y) || {}) });
  /** 动态效果实际是哪一档：full / soft / off（跟随系统时，Windows 关了「显示动画」= 全部关闭） */
  const motionLevel = () => { const m = cfg().motion; return m === 'reduce' ? 'off' : m === 'soft' ? 'soft' : m === 'full' ? 'full' : MQ.motion.matches ? 'off' : 'full'; };
  const reduceMotion = () => motionLevel() === 'off';
  const noFlash = () => !!cfg().noFlash;
  const highContrast = () => { const c = cfg().contrast; return c === 'on' || (c === 'auto' && MQ.contrast.matches); };

  let last = '';
  function apply() {
    const de = document.documentElement;
    de.classList.toggle('reduce-motion', reduceMotion());
    de.classList.toggle('motion-soft', motionLevel() === 'soft');
    de.classList.toggle('no-flash', noFlash());
    de.classList.toggle('hc', highContrast());
    de.classList.toggle('cvd', !!cfg().cvd);
    de.classList.toggle('large-text', !!cfg().largeText);
    const key = `${motionLevel()}|${noFlash()}|${highContrast()}|${!!cfg().cvd}`;
    if (key !== last) { last = key; A.emit('a11y'); }
  }
  MQ.motion.addEventListener('change', apply);
  MQ.contrast.addEventListener('change', apply);

  const set = (patch) => A.setConfig({ a11y: patch }).catch((e) => A.errorToast('保存失败', e));

  /** Ctrl + 加号 / 减号 / 0 缩放界面 */
  function zoomKey(e) {
    if (!e.ctrlKey || e.altKey) return false;
    const z = cfg().zoom;
    let next = null;
    if (e.key === '=' || e.key === '+') next = ZOOMS.find((x) => x > z + 0.01);
    else if (e.key === '-' || e.key === '_') next = [...ZOOMS].reverse().find((x) => x < z - 0.01);
    else if (e.key === '0') next = 1;
    else return false;
    e.preventDefault();
    if (next == null || Math.abs(next - z) < 0.01) return true;
    set({ zoom: next }).then(() => A.toast({ level: 'info', text: `界面缩放 ${Math.round(next * 100)}%（Ctrl + 0 恢复）`, duration: 1800, noLog: true }));
    return true;
  }

  async function setLargeText(v) {
    await set({ largeText: v });
    const ok = await A.confirm(v ? '界面上最小的字会放大到 13 像素，要重启启动器后才生效，现在重启吗？' : '要重启启动器后才恢复原来的字号，现在重启吗？',
      { title: v ? '已打开大字号' : '已关闭大字号', okText: '立即重启' });
    if (ok) api('location:relaunch').catch((e) => A.errorToast('重启失败', e));
  }

  async function openTool(kind) {
    try {
      const r = await api('sys:a11yOpen', kind);
      if (r && r.hint) A.toast({ level: 'info', title: r.title, text: r.hint, duration: 9000 });
    } catch (e) { A.errorToast('打不开', e); }
  }

  const SHORTCUTS = [
    ['Ctrl + 1 ~ 9', '切换到侧边栏第几个页面'],
    ['Ctrl + Enter', '启动当前游戏配置'],
    ['Ctrl + L', '打开 / 关闭游戏日志'],
    ['Alt + ← 或鼠标侧键', '返回上一个页面'],
    ['Esc', '关闭菜单或对话框'],
    ['Tab / Shift + Tab', '在按钮和输入框之间移动'],
    ['↑ ↓ / 回车', '在下拉框和菜单里选择'],
    ['Ctrl + 加号 / 减号 / 0', '放大 / 缩小 / 恢复界面'],
    ['Ctrl + Win + Enter', '打开 / 关闭 Windows 讲述人（系统快捷键）'],
  ];

  const MOTIONS = [{ value: 'auto', label: '跟随系统' }, { value: 'full', label: '完整' }, { value: 'soft', label: '减弱' }, { value: 'reduce', label: '全部关闭' }];
  const MOTION_DESC = {
    full: '现在是完整的动态效果：页面切换、按钮动画、主页背景都照常动',
    soft: '现在是减弱：动画更短、不再循环播放，鼠标移上去卡片不会浮起来；主页背景照常动',
    off: '现在是全部关闭：没有动画和过渡，主页背景定格成一张静止的画面',
  };
  const FLASH_DESC = '去掉忽明忽暗和突然变亮的效果：爆炸白光、烟花、流星、生物受伤闪白、苦力怕闪烁、萤火虫明暗、启动按钮流光、黄色标语跳动';

  const followSeg = (value, onChange, labels) => A.seg([
    { value: 'auto', label: '跟随系统' }, { value: labels[0], label: '开' }, { value: labels[1], label: '关' },
  ], value, onChange);

  /** 设置页「无障碍」分组的行 */
  function settingsRows(row, render) {
    const c = cfg();
    const sysNote = (on) => (on ? '（系统设置现在是开着的）' : '');
    return [
      row('界面缩放', '整个启动器按比例放大，也可以按 Ctrl + 加号 / 减号 / 0。放大后窗口的最小尺寸也会跟着变大',
        A.seg(ZOOMS.map((z) => ({ value: z, label: `${Math.round(z * 100)}%` })), ZOOMS.find((z) => Math.abs(z - c.zoom) < 0.01) || 1, (v) => set({ zoom: v }))),
      row('大字号', '把界面上最小的字放大到 13 像素（不影响其他内容的大小），重启启动器后生效', A.toggle(c.largeText, (v) => setLargeText(v))),
      row('高对比度', `纯色背景、清楚的边框、更亮的文字，去掉半透明和模糊。「跟随系统」= Windows 的高对比度主题${sysNote(MQ.contrast.matches)}`,
        followSeg(c.contrast, (v) => set({ contrast: v }), ['on', 'off'])),
      row('动态效果', `${MOTION_DESC[motionLevel()]}。「跟随系统」= Windows 的「显示动画」${sysNote(MQ.motion.matches)}`,
        A.seg(MOTIONS, c.motion, async (v) => { await set({ motion: v }); render(); })),
      row('减少闪烁', FLASH_DESC, A.toggle(c.noFlash, (v) => set({ noFlash: v }))),
      row('色弱友好配色', '把表示成功和错误的绿色、红色换成蓝色和橙色（提示图标本来就是不同形状：圆圈 i、三角叹号、圆圈叉、对勾）', A.toggle(c.cvd, (v) => set({ cvd: v }))),
      row('屏幕阅读器（讲述人）', '视障玩家可以用 Windows 自带的讲述人朗读启动器界面。随时按 Ctrl + Win + Enter 开关',
        h('button.btn.sm', { onclick: () => openTool('narrator') }, icon('volume', 14), '讲述人设置')),
      row('实时辅助字幕', '听障玩家可以用 Windows 11 的实时辅助字幕，把电脑里播放的声音转成文字（Win + Ctrl + L）',
        h('button.btn.sm', { onclick: () => openTool('captions') }, icon('file', 14), '打开实时字幕')),
      row('默认打开游戏字幕', '新的游戏目录第一次启动时打开 Minecraft 自带的字幕（显示脚步声、怪物声音等），1.9 及以上版本才有；已经玩过的不会改', A.toggle(c.subtitles, (v) => set({ subtitles: v }))),
      h('div.set-row.col', h('div.s-text', h('div.s-title', '键盘快捷键'), h('div.s-desc', '不用鼠标也能操作启动器')),
        h('div.kbd-list', SHORTCUTS.map(([k, d]) => h('div.kbd-row', h('span.kbd-key', k), h('span', d))))),
    ];
  }

  /**
   * 首次启动向导的第一步（1.5.5）：要不要视觉 / 听力辅助、动态效果、减少闪烁。改了马上生效。
   * @param {{vision: boolean, hearing: boolean}} need 向导里记着玩家选了哪种辅助（只决定展开哪些选项）
   * @param {() => void} rerender 改完配置后让向导重画
   */
  function setupStep(need, rerender) {
    const c = cfg();
    const upd = async (patch) => { await set(patch); rerender(); };
    const line = (title, desc, ctrl) => h('div.sa-row', h('div.sa-text', h('div.sa-title', title), desc ? h('div.sa-desc', desc) : null), h('div.sa-ctrl', ctrl));
    const pick = (key) => async () => {
      need[key] = !need[key];
      // 选了听力辅助就打开游戏字幕，取消就关掉（玩家还可以在下面单独改）
      if (key === 'hearing') await set({ subtitles: need.hearing });
      rerender();
    };
    const none = !need.vision && !need.hearing;
    return [
      h('div.setup-head', '需要辅助功能吗？'),
      h('p.faint.setup-note', '可以多选，选了以后马上生效。不需要就直接点「下一步」，以后也可以在「设置 → 无障碍」里改。'),
      h('div.choices.cols-3',
        A.choice({ iconName: 'eye', title: '视觉辅助', desc: '放大界面、大字号、高对比度、色弱友好配色，屏幕阅读器（讲述人）', on: need.vision, onClick: pick('vision') }),
        A.choice({ iconName: 'volume', title: '听力辅助', desc: '游戏字幕（显示脚步声、怪物声音等）、Windows 实时辅助字幕', on: need.hearing, onClick: pick('hearing') }),
        A.choice({ iconName: 'check', title: '都不需要', desc: '保持默认', on: none, onClick: async () => { if (need.hearing) await set({ subtitles: false }); need.vision = false; need.hearing = false; rerender(); } })),
      need.vision ? h('div.sa-group',
        h('div.sa-head', icon('eye', 15), '视觉辅助'),
        line('界面缩放', '整个启动器按比例放大（Ctrl + 加号 / 减号也可以）',
          A.seg(ZOOMS.map((z) => ({ value: z, label: `${Math.round(z * 100)}%` })), ZOOMS.find((z) => Math.abs(z - c.zoom) < 0.01) || 1, (v) => upd({ zoom: v }))),
        line('大字号', '最小的字放大到 13 像素，重启启动器后生效', A.toggle(c.largeText, (v) => upd({ largeText: v }))),
        line('高对比度', '纯色背景、清楚的边框、更亮的文字', followSeg(c.contrast, (v) => upd({ contrast: v }), ['on', 'off'])),
        line('色弱友好配色', '把表示成功和错误的绿色、红色换成蓝色和橙色', A.toggle(c.cvd, (v) => upd({ cvd: v }))),
        line('屏幕阅读器（讲述人）', '讲述人不会自动打开。需要时按 Ctrl + Win + Enter 开关，或者先去设置里调好声音和语速',
          h('button.btn.sm', { onclick: () => openTool('narrator') }, icon('volume', 14), '讲述人设置'))) : null,
      need.hearing ? h('div.sa-group',
        h('div.sa-head', icon('volume', 15), '听力辅助'),
        line('默认打开游戏字幕', '新的游戏目录第一次启动时打开 Minecraft 自带的字幕（1.9 及以上版本）', A.toggle(c.subtitles, (v) => upd({ subtitles: v }))),
        line('实时辅助字幕', 'Windows 11 可以把电脑里播放的声音转成文字（Win + Ctrl + L）',
          h('button.btn.sm', { onclick: () => openTool('captions') }, icon('file', 14), '打开实时字幕'))) : null,
      h('div.sa-group',
        h('div.sa-head', icon('zap', 15), '动态效果'),
        line('动态效果', MOTION_DESC[motionLevel()], A.seg(MOTIONS, c.motion, (v) => upd({ motion: v }))),
        line('减少闪烁', FLASH_DESC, A.toggle(c.noFlash, (v) => upd({ noFlash: v })))),
    ];
  }

  A.a11y = { apply, reduceMotion, motionLevel, noFlash, highContrast, zoomKey, settingsRows, setupStep, cfg };
})();
