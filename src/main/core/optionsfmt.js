'use strict';
/**
 * options.txt 的读写和跨版本翻译（1.5.6）。只做纯计算，不碰文件，方便单元测试。
 *
 * 思路：把来源的 options.txt 读成和版本无关的「中间格式」，再按目标版本的写法写回去：
 *   - 按键统一成 1.13 起的名字（key.keyboard.w）；1.12.2 及更早的 LWJGL2 数字码按对照表互转；Forge 的修饰键后缀单独记
 *   - 图像品质、平滑光照、语言代码统一成含义（fancy / max / zh_cn），写的时候按目标版本换回去
 *   - 目标 options.txt 里没选中的行、看不懂的行（包括 Mod 的）原样保留，顺序不变
 * 各版本的写法差异先用内置表（VERSIONED），实际以「学到的版本表」为准：游戏自己写过的 options.txt 里有哪些键、值是什么样子（gamesettings.js 记在 cache/options-schema）。
 */

// ───────────────────────── 版本号 ─────────────────────────
/** 把 1.20.1 / 1.8 / 26.1 这样的版本号变成可以比较的数字；快照等认不出的返回 null */
function verNum(mc) {
  const m = String(mc || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3] || 0);
}
/** mc 是否 >= v；认不出的版本号当成最新 */
function atLeast(mc, v) {
  const a = verNum(mc);
  return a == null ? true : a >= verNum(v);
}

// 正式版的 DataVersion（游戏 jar 里 version.json 的 world_version，1.14 起才有；读不到时用这张表，取不超过目标版本的最近一项）
const DATA_VERSIONS = [
  ['1.13', 1519], ['1.13.1', 1628], ['1.13.2', 1631], ['1.14', 1952], ['1.14.4', 1976], ['1.15', 2225], ['1.15.2', 2230],
  ['1.16', 2566], ['1.16.5', 2586], ['1.17', 2724], ['1.17.1', 2730], ['1.18', 2860], ['1.18.2', 2975], ['1.19', 3105],
  ['1.19.2', 3120], ['1.19.3', 3218], ['1.19.4', 3337], ['1.20', 3463], ['1.20.1', 3465], ['1.20.2', 3578], ['1.20.4', 3700],
  ['1.20.6', 3839], ['1.21', 3953], ['1.21.1', 3955], ['1.21.3', 4082], ['1.21.4', 4189],
];
function dataVersionGuess(mc) {
  if (!atLeast(mc, '1.13')) return null;
  const n = verNum(mc);
  let best = null;
  for (const [v, d] of DATA_VERSIONS) if (n == null || verNum(v) <= n) best = d;
  return best;
}

// ───────────────────────── 解析 / 序列化 ─────────────────────────
/** 解析成行列表，保留原来的顺序、空行和看不懂的行。{ lines: [{k, v} | {raw}], eol } */
function parse(text) {
  const eol = /\r\n/.test(text || '') ? '\r\n' : '\n';
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return {
    eol,
    lines: lines.map((raw) => {
      const i = raw.indexOf(':');
      return i > 0 ? { k: raw.slice(0, i), v: raw.slice(i + 1) } : { raw };
    }),
  };
}
function serialize(doc) {
  return doc.lines.map((l) => (l.raw != null ? l.raw : `${l.k}:${l.v}`)).join(doc.eol) + doc.eol;
}
function toMap(doc) {
  const m = new Map();
  for (const l of doc.lines) if (l.k != null) m.set(l.k, l.v);
  return m;
}
/** 改一个键：有就原地改，没有就加在最后 */
function setLine(doc, k, v) {
  const l = doc.lines.find((x) => x.k === k);
  if (l) l.v = v; else doc.lines.push({ k, v });
}
function dropLine(doc, k) { doc.lines = doc.lines.filter((x) => x.k !== k); }

// ───────────────────────── 按键码 ─────────────────────────
// LWJGL2 键码（1.12.2 及更早）→ 1.13 起的按键名
const LWJGL2 = {
  1: 'escape', 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0', 12: 'minus', 13: 'equal', 14: 'backspace', 15: 'tab',
  16: 'q', 17: 'w', 18: 'e', 19: 'r', 20: 't', 21: 'y', 22: 'u', 23: 'i', 24: 'o', 25: 'p', 26: 'left.bracket', 27: 'right.bracket', 28: 'enter', 29: 'left.control',
  30: 'a', 31: 's', 32: 'd', 33: 'f', 34: 'g', 35: 'h', 36: 'j', 37: 'k', 38: 'l', 39: 'semicolon', 40: 'apostrophe', 41: 'grave.accent', 42: 'left.shift', 43: 'backslash',
  44: 'z', 45: 'x', 46: 'c', 47: 'v', 48: 'b', 49: 'n', 50: 'm', 51: 'comma', 52: 'period', 53: 'slash', 54: 'right.shift', 55: 'keypad.multiply', 56: 'left.alt', 57: 'space', 58: 'caps.lock',
  59: 'f1', 60: 'f2', 61: 'f3', 62: 'f4', 63: 'f5', 64: 'f6', 65: 'f7', 66: 'f8', 67: 'f9', 68: 'f10', 69: 'num.lock', 70: 'scroll.lock',
  71: 'keypad.7', 72: 'keypad.8', 73: 'keypad.9', 74: 'keypad.subtract', 75: 'keypad.4', 76: 'keypad.5', 77: 'keypad.6', 78: 'keypad.add',
  79: 'keypad.1', 80: 'keypad.2', 81: 'keypad.3', 82: 'keypad.0', 83: 'keypad.decimal', 87: 'f11', 88: 'f12',
  100: 'f13', 101: 'f14', 102: 'f15', 103: 'f16', 104: 'f17', 105: 'f18', 113: 'f19', 141: 'keypad.equal', 156: 'keypad.enter', 157: 'right.control',
  181: 'keypad.divide', 183: 'print.screen', 184: 'right.alt', 197: 'pause', 199: 'home', 200: 'up', 201: 'page.up', 203: 'left', 205: 'right',
  207: 'end', 208: 'down', 209: 'page.down', 210: 'insert', 211: 'delete', 219: 'left.win', 220: 'right.win', 221: 'menu',
};
const NAME2LWJGL = Object.fromEntries(Object.entries(LWJGL2).map(([c, n]) => [n, Number(c)]));
const MOUSE = { 0: 'left', 1: 'right', 2: 'middle' };

/** 旧版数字码 → 新版按键名；转不了返回 null */
function codeToName(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'key.keyboard.unknown';
  if (n < 0) { // 鼠标：-100 + 按钮号
    const b = n + 100;
    if (b < 0 || b > 15) return null;
    return `key.mouse.${MOUSE[b] || b + 1}`;
  }
  return LWJGL2[n] ? `key.keyboard.${LWJGL2[n]}` : null;
}
/** 新版按键名 → 旧版数字码；转不了返回 null */
function nameToCode(name) {
  if (name === 'key.keyboard.unknown') return 0;
  let m = name.match(/^key\.mouse\.(.+)$/);
  if (m) {
    const b = { left: 0, right: 1, middle: 2 }[m[1]] ?? (/^\d+$/.test(m[1]) ? Number(m[1]) - 1 : null);
    return b == null || b < 0 ? null : -100 + b;
  }
  m = name.match(/^key\.keyboard\.(.+)$/);
  return m && NAME2LWJGL[m[1]] != null ? NAME2LWJGL[m[1]] : null;
}

/** 解析一个按键值：'key.keyboard.w' / '17' / 'key.keyboard.w:CONTROL' / '17:NONE' → { key, mod } 或 null（转不了） */
function parseKey(v) {
  const parts = String(v).split(':');
  const mod = parts[1] && parts[1] !== 'NONE' ? parts[1] : null;
  const key = /^-?\d+$/.test(parts[0]) ? codeToName(parts[0]) : (/^(key|scancode)\./.test(parts[0]) ? parts[0] : null);
  return key ? { key, mod } : null;
}

// ───────────────────────── 原版按键和选项 ─────────────────────────
// 原版动作（不在这里的都算 Mod 按键）。since：哪个版本起有；aliases：老版本里的名字
const VANILLA_KEYS = {
  attack: {}, use: {}, forward: {}, left: {}, back: {}, right: {}, jump: {}, sneak: {}, sprint: {}, inventory: {}, drop: {}, chat: {},
  playerlist: {}, pickItem: {}, command: {}, screenshot: {}, togglePerspective: {}, smoothCamera: {}, fullscreen: {}, spectatorOutlines: { since: '1.8' },
  swapOffhand: { since: '1.9', old: 'swapHands', renamed: '1.13' }, advancements: { since: '1.12' },
  saveToolbarActivator: { since: '1.12' }, loadToolbarActivator: { since: '1.12' }, socialInteractions: { since: '1.16.4' },
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => [`hotbar.${i}`, {}])),
};
const OLD_KEY_NAMES = { swapHands: 'swapOffhand' };
// 1.19 起写成带引号的文字选项
const QUOTED = ['renderClouds', 'mainHand', 'soundDevice'];
/** 选项键里的动作名：key_key.forward → forward（统一成新名字），不是按键返回 null */
function actionOf(k) {
  const m = k.match(/^key_key\.(.+)$/);
  if (!m) return k.startsWith('key_') ? k.slice(4) : null;
  return OLD_KEY_NAMES[m[1]] || m[1];
}
const isVanillaAction = (a) => Object.prototype.hasOwnProperty.call(VANILLA_KEYS, a);
/** 目标版本里这个原版动作的选项键名；这个版本还没有返回 null */
function vanillaKeyName(a, mc) {
  const d = VANILLA_KEYS[a];
  if (!d) return null;
  if (d.since && !atLeast(mc, d.since)) return null;
  if (d.old && !atLeast(mc, d.renamed)) return `key_key.${d.old}`;
  return `key_key.${a}`;
}

// 同步类别。def：默认勾不勾（Mod 配置、服务器列表、快捷栏默认不勾）
const CATEGORIES = [
  { id: 'keys', label: '按键（原版动作）', def: true },
  { id: 'modKeys', label: '按键（Mod 动作）', def: true },
  { id: 'controls', label: '鼠标与操作', def: true },
  { id: 'video', label: '画面', def: true },
  { id: 'sound', label: '声音', def: true },
  { id: 'lang', label: '语言', def: true },
  { id: 'skin', label: '皮肤部件', def: true },
  { id: 'chat', label: '聊天与无障碍', def: false },
  { id: 'packs', label: '资源包选择', def: false },
  { id: 'servers', label: '服务器列表', def: false },
  { id: 'hotbar', label: '保存的快捷栏', def: false },
  { id: 'modSettings', label: '画面增强 Mod 的设置', def: false },
  { id: 'modConfig', label: 'Mod 配置文件', def: false },
];
const DEFAULT_CATEGORIES = CATEGORIES.filter((c) => c.def).map((c) => c.id);

// 普通选项：类别、哪个版本起有（since）/ 到哪个版本为止（until，不含）、取值范围
const OPTIONS = {
  // 鼠标与操作
  mouseSensitivity: { cat: 'controls', range: [0, 1] }, invertYMouse: { cat: 'controls' }, mouseWheelSensitivity: { cat: 'controls', since: '1.14', range: [0.01, 10] },
  rawMouseInput: { cat: 'controls', since: '1.15' }, discrete_mouse_scroll: { cat: 'controls', since: '1.14' }, autoJump: { cat: 'controls', since: '1.11' },
  toggleCrouch: { cat: 'controls', since: '1.15' }, toggleSprint: { cat: 'controls', since: '1.15' }, bobView: { cat: 'controls' },
  attackIndicator: { cat: 'controls', since: '1.9' }, mainHand: { cat: 'controls', since: '1.9' }, touchscreen: { cat: 'controls' },
  // 画面
  renderDistance: { cat: 'video', range: [2, 32], int: true }, simulationDistance: { cat: 'video', since: '1.18', range: [5, 32], int: true },
  maxFps: { cat: 'video', range: [10, 260], int: true }, enableVsync: { cat: 'video' }, guiScale: { cat: 'video', int: true }, gamma: { cat: 'video', range: [0, 1] },
  fov: { cat: 'video', range: [-1, 1] }, renderClouds: { cat: 'video' }, particles: { cat: 'video', range: [0, 2], int: true },
  entityShadows: { cat: 'video' }, fullscreen: { cat: 'video' }, mipmapLevels: { cat: 'video', range: [0, 4], int: true },
  biomeBlendRadius: { cat: 'video', since: '1.13', range: [0, 7], int: true }, fovEffectScale: { cat: 'video', since: '1.16', range: [0, 1] },
  entityDistanceScaling: { cat: 'video', since: '1.16', range: [0.5, 5] }, prioritizeChunkUpdates: { cat: 'video', since: '1.19', int: true },
  // 图像品质、平滑光照在下面单独处理（graphics / ao）
  // 声音（soundCategory_* 在下面按前缀处理）
  soundDevice: { cat: 'sound', since: '1.17' }, showSubtitles: { cat: 'sound', since: '1.9' }, directionalAudio: { cat: 'sound', since: '1.19' },
  // 聊天与无障碍
  chatVisibility: { cat: 'chat', int: true }, chatColors: { cat: 'chat' }, chatLinks: { cat: 'chat' }, chatLinksPrompt: { cat: 'chat' },
  chatOpacity: { cat: 'chat', range: [0, 1] }, chatScale: { cat: 'chat', range: [0, 1] }, chatWidth: { cat: 'chat', range: [0, 1] },
  chatHeightFocused: { cat: 'chat', range: [0, 1] }, chatHeightUnfocused: { cat: 'chat', range: [0, 1] }, chatLineSpacing: { cat: 'chat', since: '1.16' },
  chatDelay: { cat: 'chat', since: '1.16' }, textBackgroundOpacity: { cat: 'chat', since: '1.14', range: [0, 1] }, backgroundForChatOnly: { cat: 'chat', since: '1.14' },
  narrator: { cat: 'chat', since: '1.12', int: true }, autoSuggestions: { cat: 'chat', since: '1.13' }, reducedDebugInfo: { cat: 'chat' },
  screenEffectScale: { cat: 'chat', since: '1.16' }, darkMojangStudiosBackground: { cat: 'chat', since: '1.16' }, hideLightningFlashes: { cat: 'chat', since: '1.19' },
  damageTiltStrength: { cat: 'chat', since: '1.19.4' }, highContrast: { cat: 'chat', since: '1.19.4' }, glintSpeed: { cat: 'chat', since: '1.19' },
  glintStrength: { cat: 'chat', since: '1.19' }, notificationDisplayTime: { cat: 'chat', since: '1.20' }, hideMatchedNames: { cat: 'chat', since: '1.16' },
  menuBackgroundBlurriness: { cat: 'chat', since: '1.20.5', int: true }, panoramaScrollSpeed: { cat: 'chat', since: '1.19.4' },
  // 语言
  lang: { cat: 'lang' },
};

/** 选项键属于哪个类别；null = 不同步（窗口大小、调试项、教程进度、版本号等） */
function categoryOf(k) {
  if (k.startsWith('key_')) return isVanillaAction(actionOf(k)) ? 'keys' : 'modKeys';
  if (k.startsWith('soundCategory_')) return 'sound';
  if (k.startsWith('modelPart_')) return 'skin';
  if (k === 'fancyGraphics' || k === 'graphicsMode' || k === 'ao') return 'video';
  if (k === 'resourcePacks' || k === 'incompatibleResourcePacks') return 'packs';
  return OPTIONS[k] ? OPTIONS[k].cat : null;
}

// ───────────────────────── 中间格式 ─────────────────────────
/**
 * options.txt → 中间格式 { values: {名字: 值}, keys: {动作: {key, mod}}, modKeys: {动作: {key, mod}}, packs: [文件名], bad: [键] }
 * 值统一成：graphics = fast / fancy / fabulous，ao = off / min / max，lang 小写，其余原样（字符串）
 */
function toCanonical(text) {
  const doc = typeof text === 'string' ? parse(text) : text;
  const out = { values: {}, keys: {}, modKeys: {}, packs: null, bad: [], dataVersion: null };
  for (const { k, v } of doc.lines) {
    if (k == null) continue;
    if (k === 'version') { out.dataVersion = Number(v) || null; continue; }
    if (k.startsWith('key_')) {
      const a = actionOf(k);
      const p = parseKey(v);
      if (!p) { out.bad.push(k); continue; }
      // 原版按动作名记（处理改名）；Mod 按键按整个选项键记（key_key.jei.showRecipe）
      if (isVanillaAction(a)) out.keys[a] = p; else out.modKeys[k] = p;
      continue;
    }
    if (k === 'fancyGraphics') { if (!out.values.graphics) out.values.graphics = v === 'true' ? 'fancy' : 'fast'; continue; }
    if (k === 'graphicsMode') { out.values.graphics = { 0: 'fast', 1: 'fancy', 2: 'fabulous', fast: 'fast', fancy: 'fancy', fabulous: 'fabulous' }[v] || 'fancy'; continue; }
    if (k === 'ao') { out.values.ao = { 0: 'off', 1: 'min', 2: 'max', false: 'off', true: 'max' }[v] || 'max'; continue; }
    if (k === 'lang') { out.values.lang = v.toLowerCase(); continue; }
    if (k === 'resourcePacks') { out.packs = userPacks(packList(v)); continue; }
    if (k === 'incompatibleResourcePacks' || !categoryOf(k)) continue;
    // 1.19 起文字选项带引号：renderClouds:"true"，中间格式里去掉
    let val = v;
    if (/^".*"$/.test(v)) { try { val = String(JSON.parse(v)); } catch { /* 原样 */ } }
    out.values[k] = val;
  }
  return out;
}

/** 资源包列表里玩家自己的包（文件名）。1.13 起是 file/xxx，其余是内置包（vanilla、fabric…）；更老的版本只有文件名 */
function userPacks(list) {
  const modern = list.some((p) => p === 'vanilla' || p.startsWith('file/'));
  return modern ? list.filter((p) => p.startsWith('file/')).map((p) => p.slice(5)) : list;
}

function packList(v) {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(String) : [];
  } catch { return []; }
}

/**
 * 目标版本的写法。schema：学到的版本表 { keys: [...], samples: {键: 值} }（可以没有），用来认出内置表写错的地方
 */
function styleFor(mc, schema) {
  const has = (k) => !!(schema && schema.keys && schema.keys.includes(k));
  const sample = (k) => schema && schema.samples ? schema.samples[k] : undefined;
  return {
    mc,
    numericKeys: schema && schema.numericKeys != null ? schema.numericKeys : !atLeast(mc, '1.13'),
    graphicsKey: has('graphicsMode') ? 'graphicsMode' : has('fancyGraphics') ? 'fancyGraphics' : atLeast(mc, '1.16') ? 'graphicsMode' : 'fancyGraphics',
    // 平滑光照：1.19 起是 true / false，以前是 0 / 1 / 2（实测 1.12.2 = 2、1.20.1 = true；学到的样子优先）
    aoBool: sample('ao') != null ? /^(true|false)$/.test(sample('ao')) : atLeast(mc, '1.19'),
    // 文字选项带不带引号（实测 1.12.2 renderClouds:true、1.20.1 renderClouds:"true"）
    quoted: (k) => (sample(k) != null ? /^".*"$/.test(sample(k)) : QUOTED.includes(k) && atLeast(mc, '1.19')),
    upperLang: !atLeast(mc, '1.11'),
    has: (k) => (schema && schema.keys ? schema.keys.includes(k) : null),
  };
}

/** 这个版本有没有这个普通选项（学到的表优先，否则看内置表） */
function optionExists(k, st) {
  // 学到的表来自游戏自己写的完整文件：有就是有，没有就是真没有
  const learned = st.has(k);
  if (learned != null) return learned;
  const d = OPTIONS[k];
  if (!d) return k.startsWith('soundCategory_') || k.startsWith('modelPart_');
  return !d.since || atLeast(st.mc, d.since);
}

function clamp(k, v, report) {
  const d = OPTIONS[k];
  if (!d || !d.range) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const c = Math.min(d.range[1], Math.max(d.range[0], n));
  if (c === n) return v;
  report.clamped.push({ k, from: v, to: String(c) });
  return d.int ? String(Math.round(c)) : String(c);
}

/**
 * 把中间格式写进目标的 options.txt。只改 cats 里的类别，其他行原样保留。
 * @param {string|null} targetText 目标现有的 options.txt（没有就是 null）
 * @param {object} canon toCanonical 的结果（或设置主档整理出来的同样形状）
 * @param {{mc: string, loader: string|null, dataVersion: number|null, schema: object|null, cats: string[], modKeysFilter?: (action) => boolean, packsExist?: (file) => boolean}} t
 * @returns {{ text: string, report: object }}
 */
function fromCanonical(targetText, canon, t) {
  const doc = parse(targetText || '');
  const st = styleFor(t.mc, t.schema);
  const cats = new Set(t.cats);
  const forge = t.loader === 'forge' || t.loader === 'neoforge';
  const report = { written: {}, skipped: [], clamped: [], modKeysKept: [], unbound: [] };
  const count = (c) => { report.written[c] = (report.written[c] || 0) + 1; };
  const skip = (k, reason) => report.skipped.push({ k, reason });

  // 普通选项
  for (const [k, v] of Object.entries(canon.values || {})) {
    if (k === 'graphics' || k === 'ao' || k === 'lang') continue;
    const c = categoryOf(k);
    if (!c || !cats.has(c)) continue;
    if (!optionExists(k, st)) { skip(k, 'missing'); continue; }
    setLine(doc, k, st.quoted(k) ? JSON.stringify(String(v)) : clamp(k, v, report));
    count(c);
  }
  if (cats.has('video') && canon.values.graphics) {
    const g = canon.values.graphics;
    if (st.graphicsKey === 'graphicsMode') { dropLine(doc, 'fancyGraphics'); setLine(doc, 'graphicsMode', String({ fast: 0, fancy: 1, fabulous: 2 }[g] ?? 1)); } else {
      dropLine(doc, 'graphicsMode');
      if (g === 'fabulous') report.clamped.push({ k: 'graphicsMode', from: 'fabulous', to: 'fancy' });
      setLine(doc, 'fancyGraphics', g === 'fast' ? 'false' : 'true');
    }
    count('video');
  }
  if (cats.has('video') && canon.values.ao) {
    const a = canon.values.ao;
    setLine(doc, 'ao', st.aoBool ? String(a !== 'off') : String({ off: 0, min: 1, max: 2 }[a]));
    count('video');
  }
  if (cats.has('lang') && canon.values.lang) {
    const l = canon.values.lang;
    setLine(doc, 'lang', st.upperLang ? l.replace(/_([a-z]+)$/, (m, r) => `_${r.toUpperCase()}`) : l);
    count('lang');
  }

  // 按键
  const writeKey = (optKey, p, c) => {
    let v;
    if (st.numericKeys) {
      const code = nameToCode(p.key);
      if (code == null) { report.unbound.push({ k: optKey, key: p.key }); v = '0'; } else v = String(code);
    } else v = p.key;
    if (p.mod && forge) v += `:${p.mod}`;
    else if (p.mod) report.skipped.push({ k: optKey, reason: 'modifier', key: p.key, mod: p.mod });
    setLine(doc, optKey, v);
    count(c);
  };
  if (cats.has('keys')) {
    for (const [a, p] of Object.entries(canon.keys || {})) {
      const name = vanillaKeyName(a, t.mc);
      if (!name) { skip(`key_key.${a}`, 'missing'); continue; }
      // 改过名的动作：把老名字那一行去掉，免得两行打架
      if (VANILLA_KEYS[a].old) dropLine(doc, name === `key_key.${a}` ? `key_key.${VANILLA_KEYS[a].old}` : `key_key.${a}`);
      writeKey(name, p, 'keys');
    }
  }
  if (cats.has('modKeys')) {
    for (const [k, p] of Object.entries(canon.modKeys || {})) {
      if (t.modKeysFilter && !t.modKeysFilter(k)) { report.modKeysKept.push(k); continue; }
      writeKey(k, p, 'modKeys');
    }
  }

  // 资源包：只留目标里真的有的；1.13 起写 file/ 前缀，带上目标原来的内置包（vanilla、fabric 等）
  if (cats.has('packs') && Array.isArray(canon.packs)) {
    const files = canon.packs;
    const keep = files.filter((f) => !t.packsExist || t.packsExist(f));
    for (const f of files) if (!keep.includes(f)) skip(`resourcePacks:${f}`, 'packMissing');
    const modern = atLeast(t.mc, '1.13');
    const cur = toMap(doc).get('resourcePacks');
    const builtins = modern ? (cur ? packList(cur).filter((p) => !p.startsWith('file/')) : ['vanilla']) : [];
    if (modern && !builtins.includes('vanilla')) builtins.unshift('vanilla');
    setLine(doc, 'resourcePacks', JSON.stringify([...builtins, ...keep.map((f) => (modern ? `file/${f}` : f))]));
    dropLine(doc, 'incompatibleResourcePacks');
    count('packs');
  }

  // DataVersion：1.13 起写目标版本自己的，免得游戏把已经换好的值再升级一遍；更老的版本没有这一行
  if (atLeast(t.mc, '1.13')) {
    const dv = t.dataVersion || dataVersionGuess(t.mc);
    if (dv) {
      const first = doc.lines.findIndex((l) => l.k === 'version');
      if (first >= 0) doc.lines[first].v = String(dv); else doc.lines.unshift({ k: 'version', v: String(dv) });
    }
  } else {
    // 1.9–1.12 自己也写 version（实测 1.12.2 = 1343）。比 1.13 还新的版本号要去掉，否则以后用新版本打开时游戏不会再把数字按键升级成名字
    const cur = Number(toMap(doc).get('version'));
    if (cur && cur >= 1519) dropLine(doc, 'version');
  }

  return { text: serialize(doc), report };
}

/** 把一个完整的 options.txt 学成版本表：有哪些键、各键的值长什么样、按键是不是数字码 */
function learn(text) {
  const doc = parse(text);
  const keys = [];
  const samples = {};
  let numeric = 0;
  let named = 0;
  for (const { k, v } of doc.lines) {
    if (k == null) continue;
    keys.push(k);
    if (['ao', 'graphicsMode', 'fancyGraphics', 'lang', 'version', ...QUOTED].includes(k)) samples[k] = v;
    if (k.startsWith('key_')) { if (/^-?\d+(:|$)/.test(v)) numeric++; else named++; }
  }
  return { keys, samples, numericKeys: numeric + named ? numeric > named : null };
}

/** 游戏自己写出来的完整 options.txt（而不是启动器写的几行）才值得学 */
const looksGameWritten = (text) => parse(text).lines.filter((l) => l.k != null).length >= 40;

module.exports = {
  verNum, atLeast, dataVersionGuess, parse, serialize, toMap, codeToName, nameToCode, parseKey, actionOf, isVanillaAction,
  vanillaKeyName, CATEGORIES, DEFAULT_CATEGORIES, OPTIONS, categoryOf, toCanonical, fromCanonical, learn, looksGameWritten, VANILLA_KEYS,
};
