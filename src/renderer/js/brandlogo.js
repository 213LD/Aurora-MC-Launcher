'use strict';
/**
 * 侧边栏左上角的标志：装着极光的玻璃方块，里面的植物跟着主页背景的场景换
 * （平原橡树、森林白桦、沙漠枯萎的灌木、雪原云杉、海洋管珊瑚、樱花林樱花树、蘑菇岛红蘑菇、黑森林深色橡树、丛林丛林树、下界绯红菌、末地末地水晶）。
 * 性能模式下换成同一场景的正面 2D 版。背景不是动态场景（图片、纯色）时是橡树，和程序图标一样。
 * 图在 img/brand/scene-<场景>.svg 和 scene-<场景>-2d.svg；主页建好场景时发 'scene'（不是动态场景时发 null）
 */
(function () {
  const { on, state } = A;
  const SCENES = ['plains', 'forest', 'desert', 'snowy', 'ocean', 'cherry', 'mushroom', 'darkforest', 'jungle', 'nether', 'end'];
  let scene = null;

  /** 现在该用哪张图（相对 index.html） */
  function src() {
    const key = SCENES.includes(scene) ? scene : 'plains';
    const flat = !!(state.config && state.config.perfMode);
    return `img/brand/scene-${key}${flat ? '-2d' : ''}.svg`;
  }

  function apply() {
    const img = document.getElementById('brandLogo');
    if (!img) return;
    const s = src();
    if (img.getAttribute('src') !== s) img.setAttribute('src', s);
  }

  on('scene', (info) => { scene = info ? info.scene : null; apply(); });
  on('config', (c, changed) => { if (!changed || changed.includes('perfMode')) apply(); });

  A.brandLogo = { apply, src, SCENES };
})();
