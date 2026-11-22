'use strict';
/* 性能模式（1.7.0 和简洁模式分开）：只为了省资源，不藏页面——
 * 关掉动画、毛玻璃、大阴影、3D 皮肤预览、背景音乐和主页更新日志（1.7.1 起这两样也关），
 * 主页背景画一帧就停（静止的画面），硬件加速在主进程启动时关（main.js），
 * 所以切换后要重启才完全生效。真正去掉功能的是简洁模式（simplemode.js），两个开关互相独立。
 * 1.7.0 以前性能模式是「迷你启动器」（只留几个页面），但其他地方还有那些功能的入口，所以分成两个开关 */
(function () {
  const { h, icon, api, state } = A;
  const DESC = '让启动器跑得更省：关掉动画、毛玻璃、阴影、3D 皮肤预览、背景音乐和主页的更新日志，主页背景变成静止的画面，并关闭硬件加速（重启后生效）。所有页面都还在。适合配置比较低的电脑。';

  const on = () => !!(state.config && state.config.perfMode);
  const apply = () => document.documentElement.classList.toggle('perf', on());

  async function restartPrompt(enabled) {
    const ok = await A.confirm(enabled
      ? '动画和效果已经关掉了。硬件加速要重启启动器后才会关闭，现在重启吗？'
      : '动画和效果已经恢复。硬件加速要重启启动器后才会重新打开，现在重启吗？', { title: enabled ? '已开启性能模式' : '已关闭性能模式', okText: '立即重启' });
    if (ok) api('location:relaunch').catch((e) => A.errorToast('重启失败', e));
  }

  /** 开 / 关性能模式（开和关都先确认），返回是否改了 */
  async function set(enabled) {
    if (enabled === on()) return false;
    const ok = enabled
      ? await A.confirm(DESC, {
        title: '开启性能模式', okText: '开启', icon: 'zap', size: 'md',
        detail: h('p.faint', { style: { fontSize: '12.5px', marginTop: '8px' } }, '想把用不到的功能也收起来，可以另外打开「简洁模式」，两个开关互不影响。随时可以在「设置 → 启动器」或侧边栏下面的「性能模式」关掉。'),
      })
      : await A.confirm('关掉以后动画、毛玻璃、动态的主页背景、3D 皮肤预览、背景音乐和更新日志会恢复，硬件加速要重启启动器后才重新打开。配置比较低的电脑可能会变卡。', { title: '关闭性能模式？', okText: '关闭性能模式', icon: 'zap' });
    if (!ok) return false;
    await A.setConfig({ perfMode: enabled });
    if (enabled && A.music && A.music.state && A.music.state.playing) A.music.stop();
    if (!enabled && !(A.simple && A.simple.on()) && A.music) A.music.init().catch(() => {});
    restartPrompt(enabled);
    return true;
  }

  /** 侧边栏底部的「性能模式」提示，点一下可以关（会先确认） */
  function sideChip(iconOnly) {
    if (!on()) return null;
    return h('button.nav-item.perf-chip', {
      onclick: () => set(false),
      'data-tip': iconOnly ? '性能模式已开启，点击关闭' : '点击关闭性能模式',
      'aria-label': '性能模式已开启，点击关闭',
    }, icon('zap', 20), h('span', '性能模式 · 已开启'));
  }

  A.perf = { on, apply, set, sideChip, DESC };
})();
