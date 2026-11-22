'use strict';
/**
 * 点击主页背景空白处冒出的粒子，按场景和时段换样式。
 * 只负责生成粒子：挂在 A.Scene.prototype.burst 上，粒子的移动（含 drag 阻力、sway 左右摆动）和绘制在 scene.js。
 * 粒子字段：vx/vy 速度、g 重力（负数往上飘）、drag 阻力、sway 摆动幅度、life 寿命（毫秒）、c 颜色、glow 自发光、firefly 闪烁、bright 闪烁时不完全暗下去
 */
(function () {
  const MAX_PARTS = 600;
  const pick = (arr, r) => arr[Math.floor(r * arr.length)];

  const STYLES = {
    firefly: (r) => ({ vx: (r() - 0.5) * 24, vy: (r() - 0.5) * 16 - 3, drag: 1.4, life: 2200 + r() * 1800, c: [210, 255, 120], glow: true, firefly: true, bright: true }),
    petal: (r) => ({ vx: (r() - 0.5) * 26, vy: -6 - r() * 10, g: 14, drag: 0.8, sway: 8, life: 2600 + r() * 1200, c: pick([[243, 180, 208], [248, 198, 220], [228, 143, 182]], r()) }),
    leaf: (r) => ({ vx: (r() - 0.5) * 26, vy: -5 - r() * 10, g: 16, drag: 0.8, sway: 9, life: 2400 + r() * 1000, c: pick([[96, 150, 60], [120, 170, 70], [150, 120, 60]], r()) }),
    pollen: (r) => ({ vx: (r() - 0.5) * 22, vy: -4 - r() * 8, g: -1, drag: 1.1, sway: 5, life: 2000 + r() * 1200, c: pick([[255, 236, 140], [255, 255, 255], [250, 190, 220]], r()), glow: true }),
    spark: (r) => ({ vx: (r() - 0.5) * 44, vy: -20 - r() * 26, g: 60, life: 700 + r() * 500, c: pick([[255, 200, 60], [255, 140, 30], [255, 240, 150]], r()), glow: true }),
    smoke: (r) => ({ vx: (r() - 0.5) * 6, vy: -4 - r() * 5, drag: 0.6, life: 1400 + r() * 800, c: [110, 100, 100] }),
    ender: (r) => ({ vx: (r() - 0.5) * 20, vy: (r() - 0.5) * 20, drag: 1.6, sway: 4, life: 1300 + r() * 900, c: pick([[200, 120, 255], [160, 80, 230], [230, 170, 255]], r()), glow: true }),
    snow: (r) => ({ vx: (r() - 0.5) * 20, vy: -4 - r() * 8, g: 10, drag: 0.9, sway: 6, life: 2600 + r() * 1200, c: [255, 255, 255] }),
    dust: (r) => ({ vx: (r() - 0.3) * 34, vy: -2 - r() * 6, g: 4, drag: 1.3, life: 1200 + r() * 900, c: pick([[222, 200, 150], [200, 175, 120], [235, 215, 170]], r()) }),
    splash: (r) => ({ vx: (r() - 0.5) * 30, vy: -16 - r() * 18, g: 55, life: 800 + r() * 400, c: pick([[200, 230, 255], [150, 200, 240], [255, 255, 255]], r()) }),
    bubble: (r) => ({ vx: (r() - 0.5) * 6, vy: -6 - r() * 8, sway: 5, life: 1600 + r() * 900, c: [210, 240, 255] }),
    glowBubble: (r) => ({ vx: (r() - 0.5) * 6, vy: -6 - r() * 8, sway: 5, life: 1600 + r() * 900, c: [120, 255, 240], glow: true }),
    spore: (r) => ({ vx: (r() - 0.5) * 14, vy: -3 - r() * 6, drag: 1, sway: 5, life: 2200 + r() * 1200, c: pick([[180, 160, 190], [150, 140, 160], [200, 190, 210]], r()) }),
  };

  /** 每个场景用哪些粒子、各多少个 */
  function recipe(s) {
    const night = s.isNight();
    switch (s.sceneId) {
      case 'nether': return [['spark', 18], ['smoke', 5]];
      case 'end': return [['ender', 20]];
      case 'snowy': return [['snow', 18]];
      case 'desert': return [['dust', 16]];
      case 'ocean': return [['splash', 12], [night ? 'glowBubble' : 'bubble', 8]];
      case 'mushroom': return [['spore', 16]];
      case 'cherry': return night ? [['firefly', 16]] : [['petal', 16]];
      case 'forest': case 'darkforest': return night ? [['firefly', 16]] : [['leaf', 14]];
      default: return night ? [['firefly', 16]] : [['pollen', 16]];
    }
  }

  /** 在点击位置冒一团粒子；粒子太多时不再加 */
  A.Scene.prototype.burst = function burst(clientX, clientY) {
    if (!this.W || this.parts.length > MAX_PARTS) return false;
    const rect = this.canvas.getBoundingClientRect();
    // 粒子用地形坐标（绘制时加回 landX / landY 的视差偏移）
    const x = ((clientX - rect.left) / rect.width) * this.W - (this.landX || 0);
    const y = ((clientY - rect.top) / rect.height) * this.H - (this.landY || 0);
    const r = this.rnd;
    for (const [kind, n] of recipe(this)) {
      for (let i = 0; i < n; i++) this.parts.push({ x: x + (r() - 0.5) * 3, y: y + (r() - 0.5) * 3, ph: r() * 6.28, ...STYLES[kind](r) });
    }
    return true;
  };
})();
