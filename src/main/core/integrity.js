'use strict';
/**
 * 一键修复的文件和设置检查：
 * - 文件完整性：游戏本体（客户端、依赖库校验 SHA-1，资源文件看大小）、Mod 文件是不是完整的 jar（压缩包结尾目录在不在）
 * - 设置与按键：options.txt 损坏、按键冲突（同一个键绑了多个动作）、config 文件夹里损坏的配置文件
 * 所有修改都返回撤销用的数据
 */
const fsp = require('fs/promises');
const path = require('path');
const versions = require('./versions');
const { exists, readJson, hashFile, renameRetry } = require('../engine/util');
const { writeFileSafe } = require('../engine/fileops');
const { nmJoin } = require('../../shared/i18n');

// ───────── 游戏本体 ─────────
async function sizeOk(f) {
  try { const st = await fsp.stat(f.path); return !f.size || st.size === f.size; } catch { return false; }
}

/** 返回 { missing, bad, total }：missing 缺的文件数，bad 大小 / 校验不对的 */
async function verifyGame(id) {
  const v = await versions.resolveVersion(id);
  const list = [];
  if (v.downloads && v.downloads.client) list.push({ path: versions.versionJarPath(v._jarId), sha1: v.downloads.client.sha1, size: v.downloads.client.size, hash: true });
  else list.push({ path: versions.versionJarPath(v._jarId), hash: false });
  for (const f of versions.collectLibraries(v).files) list.push({ ...f, hash: !f.local });
  let assets = [];
  if (v.assetIndex) {
    const idx = await readJson(path.join(versions.assetsDir(), 'indexes', `${v.assetIndex.id}.json`)).catch(() => null);
    if (!idx || !idx.objects) list.push({ path: path.join(versions.assetsDir(), 'indexes', `${v.assetIndex.id}.json`), hash: false, missingIndex: true });
    else assets = versions.assetFilesFromIndex(idx);
  }
  let missing = 0;
  let bad = 0;
  const samples = [];
  for (const f of list) {
    if (!(await exists(f.path))) { missing++; if (samples.length < 3) samples.push(path.basename(f.path)); continue; }
    if (!(await sizeOk(f))) { bad++; if (samples.length < 3) samples.push(path.basename(f.path)); continue; }
    if (f.hash && f.sha1) {
      const h = await hashFile(f.path).catch(() => '');
      if (h && h.toLowerCase() !== f.sha1.toLowerCase()) { bad++; if (samples.length < 3) samples.push(path.basename(f.path)); }
    }
  }
  for (const f of assets) {
    if (!(await sizeOk(f))) { if (await exists(f.path)) bad++; else missing++; }
  }
  return { missing, bad, total: list.length + assets.length, samples };
}

// ───────── Mod 文件 ─────────
/** jar 就是 zip：结尾 64KB 里找不到「中央目录结束」标记，说明下载不完整或文件坏了 */
async function zipOk(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    if (size < 22) return false;
    const len = Math.min(size, 65557);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    for (let i = len - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) return true;
    return false;
  } catch { return false; } finally { if (fh) await fh.close().catch(() => {}); }
}

async function verifyMods(gameDir) {
  const dir = path.join(gameDir, 'mods');
  const broken = [];
  let total = 0;
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!/\.jar$/i.test(f)) continue;
    total++;
    if (!(await zipOk(path.join(dir, f)))) broken.push(path.join(dir, f));
  }
  return { total, broken };
}

// ───────── options.txt 和按键 ─────────
const VANILLA_KEYS = {
  attack: '攻击 / 破坏', use: '使用物品 / 放置方块', forward: '前进', left: '向左', back: '后退', right: '向右', jump: '跳跃',
  sneak: '潜行', sprint: '疾跑', inventory: '打开物品栏', drop: '丢弃物品', chat: '聊天', playerlist: '玩家列表', pickItem: '选取方块',
  command: '输入命令', screenshot: '截图', togglePerspective: '切换视角', smoothCamera: '电影视角', fullscreen: '全屏',
  spectatorOutlines: '高亮玩家', swapOffhand: '与副手交换物品', saveToolbarActivator: '保存快捷栏', loadToolbarActivator: '加载快捷栏',
  advancements: '进度', socialInteractions: '社交屏幕',
};
function actionName(k) {
  const m = k.match(/^key\.(\w+)$/);
  if (m && VANILLA_KEYS[m[1]]) return VANILLA_KEYS[m[1]];
  const hb = k.match(/^key\.hotbar\.(\d)$/);
  if (hb) return `快捷栏 ${hb[1]}`;
  return k.replace(/^key\./, '');
}
function keyName(v) {
  const [k, mod] = v.split(':');
  const MOUSE = { left: '鼠标左键', right: '鼠标右键', middle: '鼠标中键' };
  let name = k.replace(/^key\.keyboard\./, '').replace(/^key\.mouse\./, (x) => x);
  if (k.startsWith('key.mouse.')) name = MOUSE[k.slice(10)] || `鼠标键 ${k.slice(10)}`;
  else name = name.replace(/\./g, ' ').toUpperCase();
  const MODS = { CONTROL: 'Ctrl + ', SHIFT: 'Shift + ', ALT: 'Alt + ' };
  return `${mod && MODS[mod] ? MODS[mod] : ''}${name}`;
}
const isVanilla = (k) => /^key\.(\w+|hotbar\.\d)$/.test(k) && (VANILLA_KEYS[k.slice(4)] || /^key\.hotbar\.\d$/.test(k));

async function readOptionsRaw(gameDir) {
  try { return await fsp.readFile(path.join(gameDir, 'options.txt'), 'utf8'); } catch { return null; }
}

function keyConflicts(text) {
  const byKey = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^key_(.+?):(key\.[^\s]+)$/);
    if (!m || /\.unknown(:|$)/.test(m[2])) continue;
    // Forge 在键后面加修饰键（:CONTROL），没有修饰键时可能写 :NONE
    const bind = m[2].replace(/:NONE$/, '');
    if (!byKey.has(bind)) byKey.set(bind, []);
    byKey.get(bind).push(m[1]);
  }
  return [...byKey.entries()].filter(([, acts]) => acts.length > 1).map(([bind, acts]) => ({ bind, actions: acts }));
}

/** 解绑冲突里非原版的按键（每组保留原版的，没有原版就保留第一个）。返回 { 'key_xxx': 原值 } */
async function unbindConflicts(gameDir) {
  const file = path.join(gameDir, 'options.txt');
  const text = await fsp.readFile(file, 'utf8');
  const drop = new Set();
  for (const c of keyConflicts(text)) {
    const keep = c.actions.find(isVanilla) || c.actions[0];
    for (const a of c.actions) if (a !== keep) drop.add(a);
  }
  const before = {};
  const out = text.split(/\r?\n/).map((line) => {
    const m = line.match(/^key_(.+?):(.+)$/);
    if (m && drop.has(m[1])) { before[`key_${m[1]}`] = m[2]; return `key_${m[1]}:key.keyboard.unknown`; }
    return line;
  });
  await writeFileSafe(file, out.join(text.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
  return before;
}

async function restoreKeys(gameDir, before) {
  const file = path.join(gameDir, 'options.txt');
  const text = await fsp.readFile(file, 'utf8');
  const out = text.split(/\r?\n/).map((line) => { const i = line.indexOf(':'); const k = i > 0 ? line.slice(0, i) : ''; return before[k] != null ? `${k}:${before[k]}` : line; });
  await writeFileSafe(file, out.join(text.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
}

// ───────── config 文件夹 ─────────
/** 宽松解析 JSON：很多 Mod 的 .json 带注释、末尾多逗号、不加引号的键（JSON5 风格），这些不算坏 */
function looseJsonOk(text) {
  try { JSON.parse(text); return true; } catch { /* 再宽松试一次 */ }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { // 字符串原样保留（单引号的换成双引号）
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const inner = text.slice(i + 1, j);
      out += c === '"' ? `"${inner}"` : `"${inner.replace(/"/g, '\\"')}"`;
      i = j;
    } else if ((c === '/' && text[i + 1] === '/') || c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 1;
    } else out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
  try { JSON.parse(out); return true; } catch { return false; }
}

const RESET_LOG = 'reset-log.json';
async function readResetLog(gameDir) {
  try { return JSON.parse(await fsp.readFile(path.join(gameDir, '.aurora-backup', RESET_LOG), 'utf8')); } catch { return {}; }
}

/**
 * 有问题的配置文件。sure：文件里有 NUL（崩溃 / 断电时写了一半），确定坏了；
 * 其余（宽松解析也不行的 .json、空的 .json / .toml）可能是 Mod 自己的特殊格式，不确定
 */
async function brokenConfigs(gameDir) {
  const root = path.join(gameDir, 'config');
  const out = [];
  const walk = async (dir, depth) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) await walk(p, depth + 1); continue; }
      if (!/\.(json|json5|toml|cfg|properties|txt|yml|yaml)$/i.test(e.name)) continue;
      let buf;
      try { const st = await fsp.stat(p); if (st.size > 4 * 1048576) continue; buf = await fsp.readFile(p); } catch { continue; }
      let why = '';
      let sure = false;
      if (buf.includes(0)) { why = '文件里有一段空数据，可能是上次崩溃或断电时没写完'; sure = true; }
      else if (!buf.length && /\.(json|toml)$/i.test(e.name)) why = '文件是空的';
      else if (/\.json$/i.test(e.name)) {
        const text = buf.toString('utf8').replace(/^\uFEFF/, '');
        if (!looseJsonOk(text)) {
          try { JSON.parse(text); } catch (err) { why = `和标准 JSON 格式不一样：${err.message.slice(0, 80)}`; }
        }
      }
      if (why) out.push({ path: p, rel: path.relative(gameDir, p).split(path.sep).join('/'), why, sure });
      if (out.length >= 20) return;
    }
  };
  await walk(root, 0);
  return out;
}

/** 把文件挪进 .aurora-backup/<时间>/ 让 Mod / 游戏重新生成默认配置；返回 [{ from, to }] 用于撤销 */
async function quarantine(gameDir, files) {
  const dir = path.join(gameDir, '.aurora-backup', new Date().toISOString().replace(/[:.]/g, '-'));
  const moved = [];
  for (const f of files) {
    const rel = path.relative(gameDir, f);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // 跨盘时是绝对路径
    const to = path.join(dir, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await renameRetry(f, to);
    moved.push({ from: f, to });
  }
  // 记下重置过哪些文件：之后又被 Mod 写成同样的格式，说明是 Mod 自己的格式，下次检测就不再当成坏文件
  if (moved.length) {
    const log = await readResetLog(gameDir);
    for (const m of moved) log[path.relative(gameDir, m.from).split(path.sep).join('/')] = Date.now();
    await writeFileSafe(path.join(gameDir, '.aurora-backup', RESET_LOG), JSON.stringify(log, null, 2)).catch(() => {});
  }
  return moved;
}

async function unquarantine(moved) {
  for (const m of moved) {
    await fsp.mkdir(path.dirname(m.from), { recursive: true });
    if (await exists(m.from)) await fsp.rm(m.from, { force: true });
    await renameRetry(m.to, m.from);
  }
}

// ───────── 汇总成检查条目 ─────────
async function check(id) {
  const info = await versions.versionInfo(id);
  const gameDir = versions.gameDirFor(id, info);
  const items = [];

  // 游戏本体
  try {
    const g = await verifyGame(id);
    if (g.missing || g.bad) {
      items.push({
        severity: 'crit', type: 'game-files', area: 'files',
        title: `游戏文件不完整：缺 ${g.missing} 个${g.bad ? `，${g.bad} 个损坏` : ''}`,
        detail: `例如 ${g.samples.length ? nmJoin(g.samples) : '资源文件'}。补全会重新下载这些文件，不会动存档和 Mod`,
        fix: { kind: 'complete', label: '补全游戏文件' },
      });
    } else items.push({ severity: 'ok', area: 'files', title: `游戏文件完整（${g.total} 个文件）` });
  } catch (e) { items.push({ severity: 'warn', area: 'files', title: '没能检查游戏文件', detail: e.message }); }

  // Mod 文件
  if (info.loader) {
    const m = await verifyMods(gameDir);
    if (m.broken.length) {
      items.push({
        severity: 'crit', type: 'mod-broken', area: 'files',
        title: `${m.broken.length} 个 Mod 文件损坏`,
        detail: `${nmJoin(m.broken.slice(0, 4).map((f) => path.basename(f)))}${m.broken.length > 4 ? ' 等' : ''}：文件不完整（下载中断或磁盘出错），游戏会直接崩溃。禁用后到「Mod 管理」重新下载`,
        fix: { kind: 'disable', files: m.broken, label: '禁用损坏的文件' },
      });
    } else if (m.total) items.push({ severity: 'ok', area: 'files', title: `Mod 文件完整（${m.total} 个）` });
  }

  // options.txt
  const opts = await readOptionsRaw(gameDir);
  if (opts != null && (!opts.trim() || opts.includes('\0') || !/^\w+:/m.test(opts))) {
    items.push({ severity: 'crit', type: 'options-broken', area: 'config', title: '游戏设置文件（options.txt）损坏了', detail: '会导致启动失败或设置全乱。备份后让游戏重新生成默认设置（画质、按键会恢复默认）', fix: { kind: 'quarantine', files: [path.join(gameDir, 'options.txt')], label: '备份并重置' } });
  } else if (opts) {
    const conflicts = keyConflicts(opts);
    if (conflicts.length) {
      items.push({
        severity: 'warn', type: 'key-conflict', area: 'config',
        title: `${conflicts.length} 个按键冲突：同一个键绑了好几个动作`,
        detail: conflicts.slice(0, 5).map((c) => `${keyName(c.bind)}：${c.actions.map(actionName).join(' / ')}`).join('\n') + (conflicts.length > 5 ? `\n…还有 ${conflicts.length - 5} 个` : '') + '\n有些是 Mod 故意设计的（只在特定界面生效），按了没反应或者乱触发时再处理',
        fix: { kind: 'unbind-keys', label: '解绑冲突的 Mod 按键' },
      });
    } else items.push({ severity: 'ok', area: 'config', title: '按键没有冲突' });
  }

  // config 文件夹
  const broken = await brokenConfigs(gameDir);
  // 重置过、之后又被写成这样：是 Mod 自己的格式
  const log = await readResetLog(gameDir);
  for (const b of broken) {
    if (!log[b.rel]) continue;
    const st = await fsp.stat(b.path).catch(() => null);
    if (st && st.mtimeMs > log[b.rel]) b.recurring = true;
  }
  const list = (arr) => arr.slice(0, 4).map((b) => `${b.rel}：${b.why}`).join('\n') + (arr.length > 4 ? `\n……还有 ${arr.length - 4} 个` : '');
  const sure = broken.filter((b) => b.sure && !b.recurring);
  const unsure = broken.filter((b) => !b.sure && !b.recurring);
  const recurring = broken.filter((b) => b.recurring);
  if (sure.length) {
    items.push({
      severity: 'crit', type: 'config-broken', area: 'config',
      title: `${sure.length} 个配置文件损坏`,
      detail: `${list(sure)}\n备份后删除，对应的 Mod 下次启动会重新生成默认配置`,
      fix: { kind: 'quarantine', files: sure.map((b) => b.path), label: '备份并重置这些配置' },
    });
  }
  // 不确定的不进「全部修复」（auto: false），要玩家自己点
  if (unsure.length) {
    items.push({
      severity: 'warn', type: 'config-odd', area: 'config',
      title: `${unsure.length} 个配置文件格式不标准（可能是正常的）`,
      detail: `${list(unsure)}\n有些 Mod 的配置文件用自己的格式，游戏里没发现问题就不用管。只有玩的时候这个 Mod 真的出错了，再点「仍然重置」让它重新生成默认配置`,
      fix: { kind: 'quarantine', files: unsure.map((b) => b.path), label: '仍然重置', auto: false },
    });
  }
  if (recurring.length) {
    items.push({
      severity: 'info', type: 'config-mod-format', area: 'config',
      title: `${recurring.length} 个配置文件重置后又变回了同样的格式`,
      detail: `${list(recurring)}\n说明是对应的 Mod 自己这样写的，多半是正常的，不用处理。只有游戏里这个 Mod 真的出问题时再重置`,
      fix: { kind: 'quarantine', files: recurring.map((b) => b.path), label: '仍然重置', auto: false },
    });
  }
  if (!broken.length && info.loader) items.push({ severity: 'ok', area: 'config', title: '配置文件没有损坏' });

  return items;
}

module.exports = { check, verifyGame, verifyMods, zipOk, keyConflicts, unbindConflicts, restoreKeys, brokenConfigs, quarantine, unquarantine };
