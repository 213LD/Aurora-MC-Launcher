'use strict';
/* 界面风格：极光（默认）/ 像素原版 / 经典紧凑。和深浅色、强调色独立组合。
 * - 写到 <html data-style="…">，样式在 css/styles/<风格>.css（选择器都带 [data-style]，三份一起加载）
 * - 像素风：泥土 / 石头纹理用 canvas 现画（16×16，放大 4 倍），像素字体 Fusion Pixel Font（OFL，fonts/）可换回系统字体（<html class="px-font">）
 * - 经典紧凑：游戏配置页换成左边列表、右边详情（pages/versions.js 看 A.uiStyle.is('compact')），其他页面只改密度 */
(function () {
  const { state } = A;
  const STYLES = [
    { value: 'aurora', label: '极光' },
    { value: 'pixel', label: '像素原版' },
    { value: 'compact', label: '经典紧凑' },
  ];
  const DESC = {
    aurora: '默认：侧边栏、圆角卡片、光晕和动画',
    pixel: '模仿 Minecraft 游戏里的界面：泥土 / 石头纹理、立体按钮、方角，顶部标签导航',
    compact: '信息更密：小字号、方角、没有动画；游戏配置页是左边列表、右边详情（类似 MultiMC / Prism）',
  };

  const cfg = () => ({ style: 'aurora', pixelFont: true, ...((state.config && state.config.ui) || {}) });
  const cur = () => (STYLES.some((s) => s.value === cfg().style) ? cfg().style : 'aurora');
  const is = (s) => cur() === s;

  // 程序生成的方块纹理：同一个种子每次画出来一样
  function texture(kind) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    let seed = kind === 'dirt' ? 7 : 13;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const pal = kind === 'dirt'
      ? ['#866043', '#79553a', '#6c4a30', '#96704f', '#5d3f29']
      : ['#7f7f7f', '#747474', '#6a6a6a', '#8f8f8f', '#5f5f5f'];
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const r = rnd();
        g.fillStyle = pal[r < 0.42 ? 0 : r < 0.68 ? 1 : r < 0.84 ? 2 : r < 0.94 ? 3 : 4];
        g.fillRect(x, y, 1, 1);
      }
    }
    return c.toDataURL();
  }
  let texDone = false;
  function textures() {
    if (texDone) return;
    texDone = true;
    const de = document.documentElement.style;
    de.setProperty('--px-dirt', `url(${texture('dirt')})`);
    de.setProperty('--px-stone', `url(${texture('stone')})`);
  }

  let last = '';
  function apply() {
    const de = document.documentElement;
    const s = cur();
    de.dataset.style = s;
    de.classList.toggle('px-font', s === 'pixel' && cfg().pixelFont !== false);
    if (s === 'pixel') textures();
    if (s !== last) { const first = !last; last = s; if (!first) A.emit('uistyle', s); }
  }

  const set = (patch) => A.setConfig({ ui: patch }).catch((e) => A.errorToast('保存失败', e));

  /** 设置 → 启动器里的两行：界面风格、像素字体（只在像素风时显示） */
  function settingsRows(row, render) {
    const c = cfg();
    return [
      Object.assign(row('界面风格', DESC[cur()], A.seg(STYLES, cur(), async (v) => { await set({ style: v }); render(); })), { id: 'set-uistyle' }),
      is('pixel') ? row('像素字体', '关掉后像素风也用系统字体，小字更清楚。字体：Fusion Pixel Font（SIL Open Font License 1.1）',
        A.toggle(c.pixelFont !== false, (v) => set({ pixelFont: v }))) : null,
    ];
  }

  A.uiStyle = { STYLES, cur, is, apply, settingsRows };
})();
