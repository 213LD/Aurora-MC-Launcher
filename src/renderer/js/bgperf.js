'use strict';
/**
 * 主页背景的性能档位（性能打磨 + 首次启动向导）
 * - 四档：高 / 中 / 低 / 静态，每档定好生物数量、世界生成范围、帧率上限、特效档位
 * - 只看硬件推荐（sys:bgAdvice → main/core/bgfit.js），给一句原因；卡片里推荐档预选，可以换档或展开逐项调，点完成 / 应用才生效
 * - 向导、设置 → 背景「按这台电脑推荐」用同一张卡片（card）
 * - 记住推荐时的硬件指纹（background.hwKey）；以后启动发现显卡 / 处理器 / 内存变了，在角落轻提示（watch），不弹窗；老用户没推荐过就不提示
 */
(function () {
  const { h, api, state } = A;

  const TIERS = {
    high: { mobs: 12, range: 'large', fps: 30, fx: 'high' },
    medium: { mobs: 8, range: 'medium', fps: 30, fx: 'medium' },
    low: { mobs: 5, range: 'small', fps: 20, fx: 'low' },
    static: { mobs: 4, range: 'small', fps: 0, fx: 'low' },
  };
  const NAMES = { high: '高', medium: '中', low: '低', static: '静态' };
  const RANGE_OPTS = [{ value: 'large', label: '大' }, { value: 'medium', label: '中' }, { value: 'small', label: '小' }];
  const FPS_OPTS = [{ value: 30, label: '30 帧' }, { value: 20, label: '20 帧' }, { value: 10, label: '10 帧' }, { value: 0, label: '静态' }];
  const FX_OPTS = [{ value: 'high', label: '全开' }, { value: 'medium', label: '一半' }, { value: 'low', label: '少' }];
  const label = (opts, v) => (opts.find((o) => o.value === v) || {}).label || v;

  /** 一句话说清这一组设置 */
  const summary = (v) => (v.fps === 0 ? '背景定格成一张画面（不动，最省电）'
    : `最多 ${v.mobs} 个生物 · 生成范围${label(RANGE_OPTS, v.range)} · ${v.fps} 帧 · 特效${label(FX_OPTS, v.fx)}`);

  /** 这组设置正好是哪一档（逐项调过就是 custom） */
  const tierOf = (v) => Object.keys(TIERS).find((k) => Object.entries(TIERS[k]).every(([key, x]) => v[key] === x)) || 'custom';

  let pending = null;
  /** 按这台电脑的硬件推荐（同一次运行里只查一次） */
  function advice() {
    if (!pending) pending = api('sys:bgAdvice').catch(() => null);
    return pending;
  }

  /** 卡片的状态：推荐好之后预选推荐档 */
  function newState() {
    const st = { adv: null, tier: null, values: null, open: false, ready: false };
    st.load = advice().then((a) => {
      st.adv = a;
      st.ready = true;
      if (!st.tier) { st.tier = a ? a.tier : 'medium'; st.values = { ...TIERS[st.tier] }; }
      return st;
    });
    return st;
  }

  /** 写进设置的内容 */
  const patch = (st) => ({ ...st.values, perfTier: tierOf(st.values), hwKey: st.adv ? st.adv.hwKey : '' });

  /**
   * 卡片：档位、原因、这一档包含什么、逐项调整
   * @param st newState() 的结果
   * @param rerender 改了之后重画卡片
   * @param where 'setup' 向导里（性能模式开关就在下面）/ 'settings'
   */
  function card(st, rerender, where = 'setup') {
    if (!st.ready) return h('div.card.bgperf', h('div.row.gap-s', h('span.spinner'), h('span.faint', '正在看这台电脑的配置…')));
    const rec = st.adv && st.adv.tier;
    const pick = (k) => { st.tier = k; st.values = { ...TIERS[k] }; rerender(); };
    const setOne = (key, v) => { st.values = { ...st.values, [key]: v }; st.tier = tierOf(st.values); rerender(); };
    const tierSeg = A.seg(Object.keys(TIERS).map((k) => ({ value: k, label: k === rec ? `${NAMES[k]}（推荐）` : NAMES[k] })), st.tier, pick, { accent: true });
    const count = h('b', String(st.values.mobs));
    const detail = st.open ? h('div.bgperf-detail',
      h('div.set-row.col',
        h('div.row', h('div.s-text', h('div.s-title', '生物数量'), h('div.s-desc', '背景里同时存在的生物上限')), count),
        A.range({ min: 0, max: 20, value: st.values.mobs, onInput: (v) => { count.textContent = String(v); }, onChange: (v) => setOne('mobs', v) })),
      h('div.set-row', h('div.s-text', h('div.s-title', '世界生成范围'), h('div.s-desc', '视野两边预先生成多远。小一些更省内存和处理器，移动视角时边上的地形会晚一点出现')),
        h('div.s-ctrl', A.seg(RANGE_OPTS, st.values.range, (v) => setOne('range', v)))),
      h('div.set-row', h('div.s-text', h('div.s-title', '帧率上限'), h('div.s-desc', '「静态」把背景定格成一张画面')),
        h('div.s-ctrl', A.seg(FPS_OPTS, st.values.fps, (v) => setOne('fps', v)))),
      h('div.set-row', h('div.s-text', h('div.s-title', '特效'), h('div.s-desc', '水下光柱、气泡、海带摆动、天上飘的粒子、闪光这些装饰')),
        h('div.s-ctrl', A.seg(FX_OPTS, st.values.fx, (v) => setOne('fx', v))))) : null;
    return h('div.card.bgperf',
      h('div.bgperf-reason', st.adv ? `${st.adv.reason}。推荐「${NAMES[rec]}」档。` : '没能读出这台电脑的配置，先按「中」档。'),
      h('div.bgperf-tiers', tierSeg),
      h('div.bgperf-sum', st.tier === 'custom' ? `自定义：${summary(st.values)}` : summary(st.values)),
      st.adv && st.adv.perfHint ? h('div.bgperf-hint', where === 'setup'
        ? '这台电脑配置比较低，也可以考虑打开下面的「性能模式」（连背景、音乐、动画一起关掉）。'
        : '这台电脑配置比较低，也可以考虑打开「设置 → 启动器 → 性能模式」（连背景、音乐、动画一起关掉）。') : null,
      h('button.btn.sm.ghost.bgperf-more', { type: 'button', onclick: () => { st.open = !st.open; rerender(); } }, st.open ? '收起' : '逐项调整…'),
      detail);
  }

  /** 设置 → 背景「按这台电脑推荐」：弹出同一张卡片，点「应用」才生效 */
  function openModal({ title = '按这台电脑推荐背景设置' } = {}) {
    const st = newState();
    const body = h('div');
    const render = () => A.mount(body, card(st, render, 'settings'));
    render();
    st.load.then(render);
    A.modal({
      title, icon: 'monitor', size: 'md', body,
      actions: [
        { label: '取消', kind: 'ghost' },
        { label: '应用', kind: 'primary', icon: 'check', onClick: async () => { if (!st.ready) return false; await A.setConfig({ background: patch(st) }); A.toast({ level: 'ok', text: `主页背景已改成「${st.tier === 'custom' ? '自定义' : NAMES[st.tier]}」档` }); return true; } },
      ],
    });
  }

  /** 启动时：推荐过、而且硬件变了，在角落轻提示一次（「不用了」就记住新硬件，不再提示） */
  async function watch() {
    const b = state.config.background || {};
    if (!b.hwKey) return;
    const a = await advice();
    if (!a || a.hwKey === b.hwKey) return;
    A.toast({
      level: 'info', sticky: true, title: '这台电脑的硬件变了', text: `${a.reason}。要重新推荐主页背景的设置吗？`,
      actions: [
        { label: '重新推荐', onClick: () => openModal({ title: '硬件变了：重新推荐背景设置' }) },
        { label: '不用了', onClick: () => A.setConfig({ background: { hwKey: a.hwKey } }) },
      ],
    });
  }

  A.bgPerf = { TIERS, NAMES, summary, tierOf, advice, newState, patch, card, openModal, watch };
})();
