'use strict';
/**
 * 主页背景的玩家用「皮肤库」里的皮肤（1.10.1）：从每张 64×64 皮肤的对应部位取颜色，套进背景玩家的 4×10 小人模板
 * （头发、脸、眼睛、嘴、上衣、袖子 / 手、裤子、鞋），和 Steve / Alex 一起出现。
 * - 默认关，玩家在「设置 → 背景」里打开（background.mySkins）。皮肤只在这台电脑上读取和处理：从本地皮肤库读图片，
 *   在页面里取色，不联网、不上传
 * - 苗条（slim）模型套 Alex 的模板（长一点的头发、窄肩），经典模型套 Steve 的
 * - 最多用 16 张；皮肤库变了或开关变了，下次生成玩家时重新读
 */
(function () {
  const { SPRITES, playerTemplate } = A.sceneKit;
  const { api, state } = A;
  const MAX = 16;
  let cache = null; // null = 还没读；数组 = 读好的小人
  let loading = null;
  let loadedAt = 0;

  const on = () => !!((state.config && state.config.background) || {}).mySkins;

  /** 一个区域里最多的颜色（透明的不算；相近的颜色归成一类再取平均） */
  function dominant(px, x, y, w, h) {
    const buckets = new Map();
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * 64 + xx) * 4;
      if (px[i + 3] < 128) continue;
      const key = (px[i] >> 5) * 64 + (px[i + 1] >> 5) * 8 + (px[i + 2] >> 5);
      const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++; b.r += px[i]; b.g += px[i + 1]; b.b += px[i + 2];
      buckets.set(key, b);
    }
    let best = null;
    for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
    return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
  }
  const at = (px, x, y) => { const i = (y * 64 + x) * 4; return px[i + 3] < 128 ? null : [px[i], px[i + 1], px[i + 2]]; };
  const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  const dark = (c, k = 0.78) => c.map((v) => v * k);
  const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

  /** 64×64 皮肤的像素 → 小人的颜色表 */
  function colorsOf(px) {
    const skin = dominant(px, 9, 13, 6, 3) || [198, 156, 125];
    const hair = dominant(px, 8, 0, 8, 8) || dominant(px, 8, 8, 8, 2) || dark(skin, 0.5);
    // 眼睛在脸的第 5 行（y = 12）；脸朝右，取右边那只：亮的当眼白，暗的当眼珠
    const e1 = at(px, 13, 12) || skin; const e2 = at(px, 14, 12) || skin;
    const [eye, white] = lum(e1) < lum(e2) ? [e1, e2] : [e2, e1];
    const mouth = dominant(px, 11, 14, 2, 2) || dark(skin, 0.85);
    const shirt = dominant(px, 20, 20, 8, 6) || [47, 168, 184];
    const shirtLow = dominant(px, 20, 26, 8, 6) || shirt;
    const arm = dominant(px, 44, 26, 4, 6) || skin;
    const pants = dominant(px, 4, 20, 4, 8) || [60, 63, 158];
    const shoes = dominant(px, 4, 29, 4, 3) || dark(pants, 0.6);
    return {
      H: hex(hair), S: hex(skin), W: hex(lum(white) - lum(eye) > 40 ? white : [244, 244, 244]), E: hex(eye), N: hex(mouth),
      T: hex(shirt), t: hex(Math.abs(lum(shirtLow) - lum(shirt)) > 12 ? shirtLow : dark(shirt)), A: hex(arm),
      P: hex(pants), p: hex(dark(pants)), B: hex(shoes), b: hex(dark(shoes)),
    };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
  }

  /** 读皮肤库、生成小人（第一次要用时才读；同时只读一遍） */
  async function load() {
    const out = [];
    let list = [];
    try { list = await api('skins:library'); } catch { list = []; }
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const g = cv.getContext('2d', { willReadFrequently: true });
    for (const it of list.slice(0, MAX)) {
      try {
        // 用 base64 读进来（本地文件地址画进画布后读不出像素）
        const b64 = await api('skins:libraryRead', it.hash);
        const img = await loadImage(`data:image/png;base64,${b64}`);
        if (img.width !== 64 || img.height !== 64) continue;
        g.clearRect(0, 0, 64, 64);
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, 64, 64).data;
        out.push(playerTemplate(colorsOf(px), it.model === 'slim'));
      } catch { /* 读不了的跳过 */ }
    }
    cache = out;
    loadedAt = Date.now();
    loading = null;
    return out;
  }

  function sprites() {
    if (!on()) return [];
    // 皮肤库可能在皮肤中心里改过：读过超过一分钟就在后台重读一遍，先接着用旧的
    if (!loading && (!cache || Date.now() - loadedAt > 60000)) loading = load();
    return cache || [];
  }

  /** 背景里新出现的玩家穿什么：打开了「用我的皮肤」时，大约六成用皮肤库里的皮肤，其余是 Steve / Alex */
  A.Scene.prototype.pickPlayerSprite = function (r) {
    const list = sprites();
    if (list.length && r() < 0.6) return list[Math.floor(r() * list.length)];
    return SPRITES[r() < 0.5 ? 'steve' : 'alex'];
  };

  // 开关、皮肤库变了：下次重新读
  A.on('config', () => { if (!on()) cache = null; });
  A.homeSkins = { reset: () => { cache = null; }, on, colorsOf };
})();
