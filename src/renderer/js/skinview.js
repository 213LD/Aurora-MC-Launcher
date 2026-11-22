'use strict';
/* 皮肤 3D 预览：不用第三方库，用 CSS 3D 变换拼出人物。
 * 每个部位是 6 个面的长方体，面用背景定位从皮肤贴图里取，image-rendering: pixelated。
 * A.skinView({ url, model, cape, size }) → { el, set({url, model, cape, layer, walk}) }；拖动旋转
 * A.skinTools：normalize（旧版 64×32 转 64×64、识别纤细模型）、readFile */
(function () {
  const { h } = A;

  // 皮肤贴图上的位置：[u, v, 宽, 高, 深]
  const PARTS = {
    head: { base: [0, 0, 8, 8, 8], over: [32, 0, 8, 8, 8], at: [0, 4, 0], inflate: 0.5 },
    body: { base: [16, 16, 8, 12, 4], over: [16, 32, 8, 12, 4], at: [0, 14, 0], inflate: 0.25 },
    rarm: { base: [40, 16, 4, 12, 4], over: [40, 32, 4, 12, 4], pivot: [-6, 8, 0], inflate: 0.25, arm: true },
    larm: { base: [32, 48, 4, 12, 4], over: [48, 48, 4, 12, 4], pivot: [6, 8, 0], inflate: 0.25, arm: true },
    rleg: { base: [0, 16, 4, 12, 4], over: [0, 32, 4, 12, 4], pivot: [-2, 20, 0], inflate: 0.25 },
    lleg: { base: [16, 48, 4, 12, 4], over: [0, 48, 4, 12, 4], pivot: [2, 20, 0], inflate: 0.25 },
  };

  /** 一个长方体：中心在 (0,0,0)，dims 是像素尺寸（可以带 inflate），uv 取贴图 */
  function cuboid(s, [u, v, w, hh, d], tex, texW, texH, inflate = 0) {
    const W = (w + inflate * 2) * s; const H = (hh + inflate * 2) * s; const D = (d + inflate * 2) * s;
    const face = (fu, fv, fw, fh, pw, ph, transform) => h('div.sk-face', {
      style: {
        width: `${pw}px`, height: `${ph}px`, marginLeft: `${-pw / 2}px`, marginTop: `${-ph / 2}px`, transform,
        backgroundImage: `url("${tex}")`,
        backgroundSize: `${texW * s * (pw / (fw * s))}px ${texH * s * (ph / (fh * s))}px`,
        backgroundPosition: `${-fu * s * (pw / (fw * s))}px ${-fv * s * (ph / (fh * s))}px`,
      },
    });
    return h('div.sk-box',
      face(u + d, v + d, w, hh, W, H, `translateZ(${D / 2}px)`), // 前
      face(u + 2 * d + w, v + d, w, hh, W, H, `rotateY(180deg) translateZ(${D / 2}px)`), // 后
      face(u, v + d, d, hh, D, H, `rotateY(-90deg) translateZ(${W / 2}px)`), // 右（人物的右手边）
      face(u + d + w, v + d, d, hh, D, H, `rotateY(90deg) translateZ(${W / 2}px)`), // 左
      face(u + d, v, w, d, W, D, `rotateX(90deg) translateZ(${H / 2}px)`), // 上
      face(u + d + w, v, w, d, W, D, `rotateX(-90deg) translateZ(${H / 2}px) scaleY(-1)`)); // 下
  }

  /**
   * 平面预览（性能模式用，1.5.7）：把正面 / 背面的贴图画到一张 16×32 的小画布上再放大，不用 CSS 3D。
   * 性能模式关了硬件加速，3D 预览由 CPU 合成，内存会一下翻倍。点人物切换正面 / 背面
   */
  function flatView({ url, model = 'classic', cape = null, size = 260 } = {}) {
    const st = { url, model, cape, layer: true, back: false };
    const canvas = h('canvas.sk-flat', { width: 16, height: 32 });
    const el = h('div.sk-view.sk-flat-view', { style: { width: `${size * 0.8}px`, height: `${size}px` }, 'data-tip': '点一下看背面', onclick: () => { st.back = !st.back; draw(); } }, canvas);
    let seq = 0;
    function draw() {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 16, 32);
      if (!st.url) return;
      const my = ++seq;
      const img = new Image();
      img.onload = () => {
        if (my !== seq) return;
        const w = st.model === 'slim' ? 3 : 4;
        const b = st.back;
        // [贴图 x, y, 宽, 高, 画布 x, y]；背面时左右对调（玩家的右手在看的人右边）
        const parts = [
          [b ? 24 : 8, 8, 8, 8, 4, 0], [b ? 32 : 20, 20, 8, 12, 4, 8],
          [b ? 44 + w + 4 : 44, 20, w, 12, b ? 12 : 4 - w, 8], [b ? 36 + w + 4 : 36, 52, w, 12, b ? 4 - w : 12, 8],
          [b ? 12 : 4, 20, 4, 12, b ? 8 : 4, 20], [b ? 28 : 20, 52, 4, 12, b ? 4 : 8, 20],
        ];
        const over = [
          [b ? 56 : 40, 8, 8, 8, 4, 0], [b ? 32 : 20, 36, 8, 12, 4, 8],
          [b ? 44 + w + 4 : 44, 36, w, 12, b ? 12 : 4 - w, 8], [b ? 52 + w + 4 : 52, 52, w, 12, b ? 4 - w : 12, 8],
          [b ? 12 : 4, 36, 4, 12, b ? 8 : 4, 20], [b ? 12 : 4, 52, 4, 12, b ? 4 : 8, 20],
        ];
        ctx.imageSmoothingEnabled = false;
        for (const [sx, sy, sw, sh, dx, dy] of parts) ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
        // 旧版 64×32 贴图没有外层和左手左脚（导入时已转换，这里只是保险）
        if (st.layer && img.height >= 64) for (const [sx, sy, sw, sh, dx, dy] of over) ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
        // 背面盖上披风（rc4：平面预览以前不画披风）：披风外侧在贴图 (1, 1)，10 × 16，从肩膀挂下来
        if (b && st.cape) {
          const cimg = new Image();
          cimg.onload = () => { if (my === seq) ctx.drawImage(cimg, 1, 1, 10, 16, 3, 8, 10, 16); };
          cimg.src = st.cape;
        }
      };
      img.src = st.url;
    }
    draw();
    return { el, set(patch) { Object.assign(st, patch); draw(); }, showBack(v) { st.back = v === undefined ? !st.back : !!v; draw(); return st.back; }, get state() { return { ...st }; }, flat: true };
  }

  function skinView({ url, model = 'classic', cape = null, size = 260 } = {}) {
    if (A.perf && A.perf.on()) return flatView({ url, model, cape, size });
    const st = { url, model, cape, layer: true, walk: true, yaw: -28, pitch: -8 };
    const s = size / 40; // 人物 32 像素高，留点边
    const scene = h('div.sk-scene');
    const el = h('div.sk-view', { style: { width: `${size * 0.8}px`, height: `${size}px` } }, scene);

    function build() {
      A.clear(scene);
      if (!st.url) return;
      const root = h('div.sk-root', { class: st.walk ? 'walking' : '' });
      for (const [name, p] of Object.entries(PARTS)) {
        const slim = p.arm && st.model === 'slim';
        const dims = (b) => (slim ? [b[0], b[1], 3, b[3], b[4]] : b);
        const group = h('div.sk-group');
        group.append(cuboid(s, dims(p.base), st.url, 64, 64));
        if (st.layer) group.append(h('div.sk-over', cuboid(s, dims(p.over), st.url, 64, 64, p.inflate)));
        if (p.pivot) {
          // 手脚绕肩膀 / 胯部摆动：外层定位在支点，里面再往下挪半个长度
          const x = p.arm ? (p.pivot[0] < 0 ? -1 : 1) * (slim ? 5.5 : 6) : p.pivot[0];
          const pivot = h(`div.sk-pivot.sk-${name}`, { style: { transform: `translate3d(${x * s}px, ${(p.pivot[1] - 16) * s}px, 0)` } });
          group.style.transform = `translateY(${6 * s}px)`;
          pivot.append(h('div.sk-swing', group));
          root.append(pivot);
        } else {
          group.style.transform = `translate3d(${p.at[0] * s}px, ${(p.at[1] - 16) * s}px, ${p.at[2] * s}px)`;
          root.append(group);
        }
      }
      if (st.cape) {
        // 披风贴图 64×32：外侧在 (1,1)，挂在背后、稍微往外飘
        const pivot = h('div.sk-pivot.sk-cape', { style: { transform: `translate3d(0, ${-8 * s}px, ${-2.5 * s}px) rotateX(-8deg)` } });
        const g = h('div.sk-group', { style: { transform: `translateY(${8 * s}px) rotateY(180deg)` } }, cuboid(s, [0, 0, 10, 16, 1], st.cape, 64, 32));
        pivot.append(g);
        root.append(pivot);
      }
      scene.append(root);
      orient();
    }

    function orient() { scene.style.transform = `rotateX(${st.pitch}deg) rotateY(${st.yaw}deg)`; }
    /**
     * 转到背面 / 正面（rc4）：默认从正前方偏一点看，披风挂在背后被身子挡住，以前得自己拖着转过去才看得到。
     * 转的时候有一点过渡；拖动时不要过渡（见下面的 pointerdown）
     */
    function showBack(v) {
      const back = v === undefined ? Math.cos(((st.yaw + 28) * Math.PI) / 180) > 0 : !!v;
      st.yaw = back ? 152 : -28; st.pitch = -8;
      scene.classList.add('sk-turning');
      orient();
      setTimeout(() => scene.classList.remove('sk-turning'), 650);
      return back;
    }

    // 拖动旋转
    el.addEventListener('pointerdown', (e) => {
      const x0 = e.clientX; const y0 = e.clientY; const yaw0 = st.yaw; const pitch0 = st.pitch;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const move = (ev) => { st.yaw = yaw0 + (ev.clientX - x0) * 0.6; st.pitch = Math.max(-40, Math.min(40, pitch0 - (ev.clientY - y0) * 0.4)); orient(); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.classList.remove('dragging'); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });

    build();
    return {
      el,
      set(patch) { Object.assign(st, patch); build(); },
      showBack,
      get state() { return { ...st }; },
    };
  }

  // ───────────── 图片处理 ─────────────
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片无法读取'));
      img.src = src;
    });
  }
  const dataUrl = (b64) => (String(b64).startsWith('data:') ? b64 : `data:image/png;base64,${b64}`);
  const toB64 = (canvas) => canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

  /** 旧版 64×32 → 64×64：左手、左腿用右手、右腿镜像（每个面左右翻转，左右两个侧面互换） */
  function copyMirrored(ctx, src, sx, sy, dx, dy, w, hh, d) {
    const faces = [
      // [源 x, 源 y, 宽, 高, 目标 x]（同一行里的面）
      [sx + d, sy, w, d, dx + d], [sx + d + w, sy, w, d, dx + d + w], // 上、下
      [sx, sy + d, d, hh, dx + d + w], [sx + d, sy + d, w, hh, dx + d], // 右 → 左、前
      [sx + d + w, sy + d, d, hh, dx], [sx + 2 * d + w, sy + d, w, hh, dx + 2 * d + w], // 左 → 右、后
    ];
    faces.forEach(([x, y, fw, fh, tx], i) => {
      const ty = i < 2 ? dy : dy + d;
      ctx.save();
      ctx.translate(tx + fw, ty);
      ctx.scale(-1, 1);
      ctx.drawImage(src, x, y, fw, fh, 0, 0, fw, fh);
      ctx.restore();
    });
  }

  /**
   * 旧版皮肤转换后和游戏里看到的一样（rc3，试用：Notch 的皮肤变成一个大黑头）：
   * 游戏读 64×32 皮肤时，帽子层那一块（x 32~63，y 0~15）如果每个像素都不透明，就当作没有帽子、整块变透明——
   * 很多早期皮肤把这块填满了颜色（Notch 的是纯黑），不这样处理就会在头外面套一个黑盒子。
   * 头、身体、手脚的底层在游戏里一律按不透明画，这里也一样
   */
  function legacyFix(ctx) {
    const hat = ctx.getImageData(32, 0, 32, 16);
    let solid = true;
    for (let i = 3; i < hat.data.length; i += 4) if (hat.data[i] < 128) { solid = false; break; }
    if (solid) ctx.clearRect(32, 0, 32, 16);
    for (const [x, y, w, hh] of [[0, 0, 32, 16], [0, 16, 64, 16], [16, 48, 32, 16]]) {
      const d = ctx.getImageData(x, y, w, hh);
      for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;
      ctx.putImageData(d, x, y);
    }
  }

  /** 把导入的皮肤整理成 64×64，返回 { png, model, legacy }；不是皮肤尺寸时报错 */
  async function normalize(b64) {
    const img = await loadImage(dataUrl(b64));
    if (img.width !== 64 || (img.height !== 64 && img.height !== 32)) throw new Error(`皮肤尺寸应为 64×64 或旧版的 64×32（这张是 ${img.width}×${img.height}）`);
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    const legacy = img.height === 32;
    if (legacy) {
      copyMirrored(ctx, img, 0, 16, 16, 48, 4, 12, 4); // 右腿 → 左腿
      copyMirrored(ctx, img, 40, 16, 32, 48, 4, 12, 4); // 右手 → 左手
      legacyFix(ctx);
    }
    // 纤细模型：右手贴图最右边一列（x=54、55，y=20~31）是透明的
    let slim = !legacy;
    if (slim) {
      const px = ctx.getImageData(54, 20, 2, 12).data;
      for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) { slim = false; break; }
    }
    return { png: toB64(c), model: slim ? 'slim' : 'classic', legacy };
  }

  /** 披风：64×32 原样；旧的 22×17 放进 64×32 的左上角 */
  async function normalizeCape(b64) {
    const img = await loadImage(dataUrl(b64));
    if (img.width === 64 && img.height === 32) return String(b64).replace(/^data:image\/png;base64,/, '');
    if (img.width === 22 && img.height === 17) {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 32;
      c.getContext('2d').drawImage(img, 0, 0);
      return toB64(c);
    }
    throw new Error(`披风尺寸应为 64×32（这张是 ${img.width}×${img.height}）`);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/\.png$/i.test(file.name || '') && file.type !== 'image/png') { reject(new Error('只支持 PNG 图片')); return; }
      if (file.size > 2 * 1024 * 1024) { reject(new Error('图片太大了')); return; }
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(new Error('读取文件失败'));
      r.readAsDataURL(file);
    });
  }

  /**
   * 预览下面的「看背面 / 看正面」按钮（rc4）。hasCape：有披风时按钮上写「看披风」，一眼知道披风在背后
   */
  function turnButton(view, { hasCape } = {}) {
    const front = hasCape ? '看披风' : '看背面';
    const label = h('span', front);
    const b = h('button.btn.sm.ghost.sk-turn', { type: 'button', onclick: () => { const back = view.showBack(); label.textContent = back ? '看正面' : front; b.classList.toggle('on', back); } }, A.icon(hasCape ? 'flag' : 'refresh', 14), label);
    return b;
  }

  A.skinView = skinView;
  A.skinTools = { normalize, normalizeCape, readFile, dataUrl, turnButton };
})();
