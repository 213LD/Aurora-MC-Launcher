'use strict';
/* 程序化像素美术：等距方块图标、玩家头像 */
(function () {
  const { h } = A;

  function rand(x, y, s) {
    let v = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
  }
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const pal = (...cols) => cols.map(hex);

  // 各种“材质”
  const MATERIALS = {
    grass: { top: pal('#60a83a', '#6cb640', '#56982f', '#76be48', '#4e8c2e'), side: pal('#86603f', '#79553a', '#966c4b', '#6d4d34', '#8c6446'), strip: pal('#5ca036', '#509030', '#68ac3c') },
    snapshot: { top: pal('#d9893f', '#c97a36', '#e59a52', '#bd6f2f'), side: pal('#a8642e', '#9a5a29', '#b8713a', '#8c5124'), strip: pal('#cf8040', '#bf7438'), stripRows: 3 },
    old: { top: pal('#8d8d8d', '#7b7b7b', '#a0a0a0', '#6a6a6a', '#b0b0b0'), side: pal('#828282', '#727272', '#959595', '#636363') },
    fabric: { top: pal('#e1d5b8', '#d4c7a7', '#ece2c8', '#c8ba98'), side: pal('#cdbf9e', '#bfb08e', '#dacdae', '#b3a483'), strip: pal('#38342a', '#2d2a22'), stripRows: 2 },
    quilt: { top: pal('#a07bf0', '#9068e3', '#b18dff', '#7f58d6', '#c19fff'), side: pal('#8d64de', '#7e56cf', '#9b74ea', '#6f4ac0'), checker: true },
    forge: { top: pal('#5e6575', '#525868', '#6b7282', '#474c5a'), side: pal('#4c5260', '#424754', '#575d6c', '#3a3e4a'), strip: pal('#7a8293', '#6e7687'), stripRows: 2 },
    neoforge: { top: pal('#ec8a35', '#de7b28', '#f59d4c', '#cf6d20'), side: pal('#cf7027', '#c06420', '#dc7f35', '#b05a1b'), strip: pal('#2c2c34', '#24242b'), stripRows: 2 },
    optifine: { top: pal('#de5050', '#cd4242', '#ea6262', '#bb3838'), side: pal('#c24040', '#b03535', '#cf4f4f', '#9d2e2e') },
    liteloader: { top: pal('#5aa6ef', '#4b96e0', '#6ab3f8', '#3d85cf'), side: pal('#4a8fd6', '#3f82c6', '#579de2', '#3474b6') },
    diamond: { top: pal('#5fe0d4', '#4fd2c5', '#7beee3', '#3fc0b4'), side: pal('#47c6ba', '#3db6ab', '#5ad4c9', '#33a499') },
    unknown: { top: pal('#6b7280', '#5b6270', '#7b8290'), side: pal('#555c6a', '#4b525f', '#606775') },
  };

  function texel(m, face, u, v, seed) {
    const tu = Math.min(15, Math.floor(u * 16));
    const tv = Math.min(15, Math.floor(v * 16));
    const pick = (arr, s) => arr[Math.floor(rand(tu, tv, s + seed) * arr.length)];
    if (face === 'top') {
      if (m.checker && ((tu >> 2) + (tv >> 2)) % 2) return pick(m.side, 11);
      return pick(m.top, 1);
    }
    if (m.strip) {
      const rows = m.stripRows || (3 + Math.floor(rand(tu, 0, face === 'left' ? 2 : 3) * 2.2));
      if (tv < rows) return pick(m.strip, 4);
    }
    if (m.checker && ((tu >> 2) + (tv >> 2)) % 2) return pick(m.top, 12);
    return pick(m.side, face === 'left' ? 5 : 6);
  }

  const T = [16, 2.5]; const R = [29.5, 9.75]; const L = [2.5, 9.75]; const C = [16, 17]; const B = [16, 30.5];
  const FACES = [
    ['top', T, [R[0] - T[0], R[1] - T[1]], [L[0] - T[0], L[1] - T[1]], 1.0],
    ['left', L, [C[0] - L[0], C[1] - L[1]], [0, B[1] - C[1]], 0.82],
    ['right', C, [R[0] - C[0], R[1] - C[1]], [0, B[1] - C[1]], 0.64],
  ];

  // 每个面的 16×16 纹理只和格子有关：先按格子算好（texel 用格子中心取色，结果和逐点取一样），
  // 逐点只算落在哪个面、哪一格，循环里不建数组、不解构（rc14：以前 96 像素的图标每个都现算 8 万多次 texel，
  // 第一次打开游戏配置页、下载页要多花一两百毫秒，CPU 慢的电脑上要一秒多）
  const faceTex = (m, seed) => FACES.map(([name]) => {
    const tex = [];
    for (let tv = 0; tv < 16; tv++) for (let tu = 0; tu < 16; tu++) tex.push(texel(m, name, (tu + 0.5) / 16, (tv + 0.5) / 16, seed));
    return tex;
  });
  const FACE_NUM = FACES.map(([, o, a, b, shade]) => ({ ox: o[0], oy: o[1], a0: a[0], a1: a[1], b0: b[0], b1: b[1], det: a[0] * b[1] - a[1] * b[0], shade }));

  const blockCache = new Map();
  function blockImage(kind = 'grass', size = 64) {
    const key = `${kind}:${size}`;
    if (blockCache.has(key)) return blockCache.get(key);
    const m = MATERIALS[kind] || MATERIALS.unknown;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const ss = 3;
    const seed = kind.length * 7;
    const texs = faceTex(m, seed);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let r = 0; let g = 0; let bb = 0; let cnt = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const x = ((px + (sx + 0.5) / ss) / size) * 32;
            const y = ((py + (sy + 0.5) / ss) / size) * 32;
            for (let f = 0; f < 3; f++) {
              const F = FACE_NUM[f];
              const dx = x - F.ox; const dy = y - F.oy;
              const u = (dx * F.b1 - dy * F.b0) / F.det;
              const v = (F.a0 * dy - F.a1 * dx) / F.det;
              if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
                const col = texs[f][Math.min(15, Math.floor(v * 16)) * 16 + Math.min(15, Math.floor(u * 16))];
                r += col[0] * F.shade; g += col[1] * F.shade; bb += col[2] * F.shade; cnt++;
                break;
              }
            }
          }
        }
        if (cnt) {
          const i = (py * size + px) * 4;
          img.data[i] = r / cnt; img.data[i + 1] = g / cnt; img.data[i + 2] = bb / cnt;
          img.data[i + 3] = (cnt / (ss * ss)) * 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = c.toDataURL();
    blockCache.set(key, url);
    return url;
  }

  /** 根据版本信息挑选方块材质 */
  function versionKind(v) {
    if (!v) return 'unknown';
    if (v.profileType === 'vanillaplus') return 'diamond';
    if (v.loader && v.loader.type === 'legacyfabric') return 'fabric';
    if (v.loader && MATERIALS[v.loader.type]) return v.loader.type;
    if (v.type === 'snapshot') return 'snapshot';
    if (v.type === 'old_alpha' || v.type === 'old_beta') return 'old';
    return 'grass';
  }
  const versionIcon = (v, size = 64) => blockImage(versionKind(v), size);
  const typeIcon = (type, size = 64) => blockImage(type === 'snapshot' ? 'snapshot' : type && type.startsWith('old') ? 'old' : 'grass', size);

  // ── 头像 ──
  const FACES_PX = {
    steve: {
      map: ['HHHHHHHH', 'HHHHHHHH', 'HSSSSSSH', 'SSSSSSSS', 'SWESSEWS', 'SSSNNSSS', 'SSMSSMSS', 'SSMMMMSS'],
      colors: { H: ['#2f2010', '#3a2814', '#28190b'], S: ['#c69c7d', '#bb8f6e', '#d0a687'], W: ['#ffffff'], E: ['#4b3a8c'], N: ['#94634a'], M: ['#6a4232', '#5d3828'] },
    },
    alex: {
      map: ['HHHHHHHH', 'HHHHHHHH', 'HHSSSSSS', 'HSSSSSSS', 'SWESSEWS', 'SSSSSSSS', 'SSSMMSSS', 'SSSSSSSS'],
      colors: { H: ['#e0853a', '#cf7430', '#ea9550'], S: ['#f3c9a7', '#eabd98', '#f8d4b6'], W: ['#ffffff'], E: ['#3c8a50'], M: ['#c97a6a'] },
    },
  };
  const faceCache = new Map();
  /** 把 8×8 的像素脸画到 (ox, oy) */
  function paintFace(ctx, kind, ox = 0, oy = 0) {
    const f = FACES_PX[kind] || FACES_PX.steve;
    f.map.forEach((row, y) => [...row].forEach((ch, x) => {
      const cols = f.colors[ch];
      ctx.fillStyle = cols[Math.floor(rand(x, y, 9) * cols.length)];
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }));
  }
  function defaultFace(kind) {
    if (faceCache.has(kind)) return faceCache.get(kind);
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    paintFace(c.getContext('2d'), kind);
    const url = c.toDataURL();
    faceCache.set(kind, url);
    return url;
  }

  function defaultSkinKind(uuid) {
    const s = String(uuid || '').replace(/-/g, '');
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
    return x & 1 ? 'alex' : 'steve';
  }

  // ── 默认皮肤（64×64 贴图）：没导入皮肤、电脑上也没装原版游戏时给 3D 预览用（1.5.7，以前是空白）。
  // 启动器自己画的 Steve / Alex 风格（脸用上面的头像像素），不是游戏里的原图
  const BODY_PX = {
    steve: { H: ['#2f2010', '#3a2814'], S: ['#c69c7d', '#bb8f6e'], T: ['#2fa8b8', '#2a98a7', '#36b3c3'], P: ['#3c3f9e', '#35388f'], B: ['#555555', '#4a4a4a'] },
    alex: { H: ['#e0853a', '#cf7430'], S: ['#f3c9a7', '#eabd98'], T: ['#5d9c48', '#548f41', '#68a851'], P: ['#6b4a2b', '#5f4126'], B: ['#4a4a4a', '#404040'] },
  };
  const skinCache = new Map();
  function defaultSkin(kind = 'steve') {
    if (skinCache.has(kind)) return skinCache.get(kind);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const P = BODY_PX[kind] || BODY_PX.steve;
    const fill = (x, y, w, hh, key) => {
      for (let j = 0; j < hh; j++) {
        for (let i = 0; i < w; i++) {
          const cols = P[typeof key === 'function' ? key(i, j) : key];
          ctx.fillStyle = cols[Math.floor(rand(x + i, y + j, 5) * cols.length)];
          ctx.fillRect(x + i, y + j, 1, 1);
        }
      }
    };
    // 头：顶面和后脑勺是头发，侧面上面两行头发，正面用头像的像素
    fill(8, 0, 8, 8, 'H'); fill(16, 0, 8, 8, 'S');
    fill(0, 8, 8, 8, (i, j) => (j < 2 ? 'H' : 'S')); fill(16, 8, 8, 8, (i, j) => (j < 2 ? 'H' : 'S')); fill(24, 8, 8, 8, 'H');
    paintFace(ctx, kind, 8, 8);
    // 身体：衣服
    fill(16, 16, 24, 16, 'T');
    // 两只胳膊：上面 4 行是袖子，下面是皮肤（Alex 是 3 像素宽的纤细手臂，贴图照样画满 4 列）
    for (const [x, y] of [[40, 16], [32, 48]]) {
      fill(x + 4, y, 4, 4, 'T'); fill(x + 8, y, 4, 4, 'S');
      fill(x, y + 4, 16, 12, (i, j) => (j < 4 ? 'T' : 'S'));
    }
    // 两条腿：裤子，最下面两行是鞋
    for (const [x, y] of [[0, 16], [16, 48]]) {
      fill(x + 4, y, 4, 4, 'P'); fill(x + 8, y, 4, 4, 'B');
      fill(x, y + 4, 16, 12, (i, j) => (j >= 10 ? 'B' : 'P'));
    }
    const url = c.toDataURL();
    skinCache.set(kind, url);
    return url;
  }

  /** 玩家头像：有皮肤的用皮肤（脸 + 帽子层），没有的用默认皮肤像素脸 */
  function avatar(account, size = 40) {
    const el = h('div.avatar', { style: { width: `${size}px`, height: `${size}px` } });
    if (account && account.skin && account.skin.url) {
      const url = account.skin.url.replace(/^http:/, 'https:');
      // 贴图的大小和位置按头像实际宽度算（style.css 里用容器单位 cqw），像素风等样式把头像改小时不会只剩一角（1.5.7）
      el.classList.add('skin');
      el.append(h('div.face', { style: { backgroundImage: `url("${url}")` } }), h('div.hat', { style: { backgroundImage: `url("${url}")` } }));
    } else {
      el.appendChild(h('img', { src: defaultFace(account ? defaultSkinKind(account.uuid) : 'steve'), alt: '' }));
    }
    return el;
  }

  function msLogo(size = 18) {
    return h('div.ms-logo', { style: { width: `${size}px`, height: `${size}px` } },
      h('i', { style: { background: '#f25022' } }), h('i', { style: { background: '#7fba00' } }),
      h('i', { style: { background: '#00a4ef' } }), h('i', { style: { background: '#ffb900' } }));
  }

  Object.assign(A, { blockImage, versionIcon, versionKind, typeIcon, avatar, defaultFace, defaultSkin, defaultSkinKind, msLogo });
})();
