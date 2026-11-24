'use strict';
/**
 * 皮肤管理：每个账户的皮肤 / 模型 / 披风，皮肤库，按正版玩家名 / LittleSkin / 网址导入，游戏自带的默认皮肤。
 * 图片在界面里用 canvas 规范化（旧版 64×32 转 64×64、识别纤细模型），这里只校验尺寸并保存。
 * 让皮肤在游戏里生效（本地皮肤服务 / CustomSkinLoader）见 prepareLaunch。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const paths = require('../engine/paths');
const net = require('../engine/net');
const { exists } = require('../engine/util');
const { cutChars } = require('../../shared/pathrules');
const jsonStore = require('../engine/jsonstore');
const { nm } = require('../../shared/i18n');

const METHODS = ['auto', 'service', 'csl', 'none'];
const MS_GROUP = '正版账户皮肤';
const root = () => path.join(paths.dataDir(), 'skins');
const safe = (id) => String(id).replace(/[^\w.-]/g, '_');
const accDir = (id) => path.join(root(), safe(id));
const libDir = () => path.join(root(), 'library');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const httpsTexUrl = (u) => (typeof u === 'string' ? u.replace(/^http:\/\/(?!127\.0\.0\.1(?::|\/|$)|localhost(?::|\/|$))/i, 'https://') : '');

/** PNG 的宽高；不是 PNG 返回 null */
function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function checkSkin(buf) {
  const s = pngSize(buf);
  if (!s) throw new Error('不是有效的 PNG 图片');
  if (s.w !== 64 || s.h !== 64) throw new Error(`皮肤尺寸应为 64×64（这张是 ${s.w}×${s.h}）`);
}
function checkCape(buf) {
  const s = pngSize(buf);
  if (!s) throw new Error('不是有效的 PNG 图片');
  if (s.w !== s.h * 2 || s.w % 64) throw new Error(`披风尺寸应为 64×32（这张是 ${s.w}×${s.h}）`);
}

const fromB64 = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(String(b || '').replace(/^data:image\/png;base64,/, ''), 'base64'));
const fileUrl = (p, hash) => `${pathToFileURL(p).href}?v=${hash.slice(0, 12)}`;

// ───────────────────────── 账户皮肤 ─────────────────────────
// 账户记录里只存引用：custom = { skin: hash, model: 'classic'|'slim', cape: hash|null, method }

function skinFile(id, hash) { return path.join(accDir(id), `${hash}.png`); }

/** 给 accounts.publicView 用：自定义皮肤对应的 skin / cape 字段（头像、预览都用它） */
function viewOf(acc) {
  const c = acc && acc.custom;
  if (!c || !c.skin) return null;
  const sp = skinFile(acc.id, c.skin);
  if (!fs.existsSync(sp)) return null;
  const cp = c.cape ? skinFile(acc.id, c.cape) : null;
  return {
    skin: { url: fileUrl(sp, c.skin), variant: c.model === 'slim' ? 'SLIM' : 'CLASSIC', custom: true },
    cape: cp && fs.existsSync(cp) ? { url: fileUrl(cp, c.cape), custom: true } : null,
    method: METHODS.includes(c.method) ? c.method : 'auto',
  };
}

/** 微软正版账户的本地缓存皮肤（断网或升级后预览、防止第三方链接受策略拦截） */
function cachedViewOf(acc) {
  const c = acc && acc.skinCache;
  if (!c || !c.skin) return null;
  const sp = skinFile(acc.id, c.skin);
  if (!fs.existsSync(sp)) return null;
  const cp = c.cape ? skinFile(acc.id, c.cape) : null;
  return {
    skin: { url: fileUrl(sp, c.skin), variant: c.model === 'slim' ? 'SLIM' : 'CLASSIC' },
    cape: cp && fs.existsSync(cp) ? { url: fileUrl(cp, c.cape) } : null,
  };
}

function copyMirroredBitmap(src, dst, sx, sy, dx, dy, w, hh, d) {
  const faces = [
    [sx + d, sy, w, d, dx + d], [sx + d + w, sy, w, d, dx + d + w],
    [sx, sy + d, d, hh, dx + d + w], [sx + d, sy + d, w, hh, dx + d],
    [sx + d + w, sy + d, d, hh, dx], [sx + 2 * d + w, sy + d, w, hh, dx + 2 * d + w],
  ];
  for (let i = 0; i < faces.length; i++) {
    const [fx, fy, fw, fh, tx] = faces[i];
    const ty = i < 2 ? dy : dy + d;
    for (let row = 0; row < fh; row++) {
      for (let col = 0; col < fw; col++) {
        const si = ((fy + row) * 64 + (fx + col)) * 4;
        const di = ((ty + row) * 64 + (tx + fw - 1 - col)) * 4;
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
      }
    }
  }
}

function normalizeSkinBuffer(buf) {
  const s = pngSize(buf);
  if (!s || s.w !== 64 || (s.h !== 64 && s.h !== 32)) return null;
  if (s.h === 64) return { png: buf, model: null, legacy: false };
  const { nativeImage } = require('electron');
  const src = nativeImage.createFromBuffer(buf).toBitmap();
  if (src.length < 64 * 32 * 4) return null;
  const dst = Buffer.alloc(64 * 64 * 4);
  src.copy(dst, 0, 0, 64 * 32 * 4);
  copyMirroredBitmap(src, dst, 0, 16, 16, 48, 4, 12, 4);
  copyMirroredBitmap(src, dst, 40, 16, 32, 48, 4, 12, 4);
  let solidHat = true;
  for (let y = 0; y < 16 && solidHat; y++) {
    for (let x = 32; x < 64; x++) {
      if (dst[(y * 64 + x) * 4 + 3] < 128) { solidHat = false; break; }
    }
  }
  if (solidHat) {
    for (let y = 0; y < 16; y++) dst.fill(0, (y * 64 + 32) * 4, (y * 64 + 64) * 4);
  }
  for (const [bx, by, bw, bh] of [[0, 0, 32, 16], [0, 16, 64, 16], [16, 48, 32, 16]]) {
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) dst[(y * 64 + x) * 4 + 3] = 255;
    }
  }
  const png = nativeImage.createFromBitmap(dst, { width: 64, height: 64 }).toPNG();
  return { png, model: 'classic', legacy: true };
}

function normalizeCapeBuffer(buf) {
  const s = pngSize(buf);
  if (!s) return null;
  if (s.w === s.h * 2 && s.w % 64 === 0) return buf;
  if (s.w === 22 && s.h === 17) {
    const { nativeImage } = require('electron');
    const src = nativeImage.createFromBuffer(buf).toBitmap();
    if (src.length < 22 * 17 * 4) return null;
    const dst = Buffer.alloc(64 * 32 * 4);
    for (let y = 0; y < 17; y++) src.copy(dst, y * 64 * 4, y * 22 * 4, (y + 1) * 22 * 4);
    return nativeImage.createFromBitmap(dst, { width: 64, height: 32 }).toPNG();
  }
  return null;
}

async function store(id, buf) {
  const hash = sha256(buf);
  await fsp.mkdir(accDir(id), { recursive: true });
  const p = skinFile(id, hash);
  if (!(await exists(p))) await fsp.writeFile(p, buf);
  return hash;
}

/** 清掉账户目录里不再被引用的图片 */
async function prune(id, keep) {
  let names = [];
  try { names = await fsp.readdir(accDir(id)); } catch { return; }
  for (const n of names) if (/^[0-9a-f]{64}\.png$/.test(n) && !keep.includes(n.slice(0, 64))) await fsp.rm(path.join(accDir(id), n), { force: true });
}

/**
 * 改账户的自定义皮肤。patch：{ skin?: base64|null, model?, cape?: base64|null, method? }
 * skin: null 表示恢复默认（同时去掉披风）
 */
async function apply(acc, patch) {
  const c = { ...(acc.custom || {}) };
  if (patch.skin === null) { delete c.skin; delete c.cape; } else if (patch.skin) {
    const buf = fromB64(patch.skin);
    checkSkin(buf);
    c.skin = await store(acc.id, buf);
  }
  if (patch.model) c.model = patch.model === 'slim' ? 'slim' : 'classic';
  if (patch.cape === null) c.cape = null;
  else if (patch.cape) {
    const buf = fromB64(patch.cape);
    checkCape(buf);
    c.cape = await store(acc.id, buf);
  }
  if (patch.method && METHODS.includes(patch.method)) c.method = patch.method;
  if (!c.model) c.model = 'classic';
  if (!c.method) c.method = 'auto';
  await prune(acc.id, [c.skin, c.cape].filter(Boolean));
  return c.skin || c.method !== 'auto' ? c : null;
}

/** 删除账户时一并删掉它的皮肤目录 */
async function removeAccount(id) { await fsp.rm(accDir(id), { recursive: true, force: true }); }

/** 读账户的皮肤原图（本地皮肤服务、CSL 复制用） */
async function readTexture(acc, kind) {
  const c = acc && (acc.custom || acc.skinCache);
  const hash = c && (kind === 'cape' ? c.cape : c.skin);
  if (!hash) return null;
  try { return { hash, buf: await fsp.readFile(skinFile(acc.id, hash)) }; } catch { return null; }
}

// ───────────────────────── 导入 ─────────────────────────
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

function decodeTextures(profile) {
  const prop = (profile.properties || []).find((p) => p.name === 'textures');
  if (!prop) return {};
  try { return JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures || {}; } catch { return {}; }
}

async function fromMojang(name) {
  if (!NAME_RE.test(name)) throw new Error('正版玩家名只能包含英文字母、数字和下划线');
  let id;
  try {
    id = (await net.getJson([`https://api.minecraftservices.com/minecraft/profile/lookup/name/${name}`, `https://api.mojang.com/users/profiles/minecraft/${name}`], { retries: 1, timeout: 15000 })).id;
  } catch (e) {
    if (e instanceof net.HttpError && (e.status === 404 || e.status === 204)) throw new Error(`没有找到正版玩家「${nm(name)}」`);
    throw e;
  }
  if (!id) throw new Error(`没有找到正版玩家「${nm(name)}」`);
  const prof = await net.getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, { retries: 2, timeout: 15000 });
  const tx = decodeTextures(prof);
  if (!tx.SKIN) throw new Error(`「${nm(prof.name) || nm(name)}」用的是默认皮肤`);
  const https = (u) => u.replace(/^http:/, 'https:');
  const skin = await net.getBuffer(https(tx.SKIN.url), { timeout: 20000 });
  const cape = tx.CAPE ? await net.getBuffer(https(tx.CAPE.url), { timeout: 20000 }).catch(() => null) : null;
  return { name: prof.name || name, skin: skin.toString('base64'), model: tx.SKIN.metadata && tx.SKIN.metadata.model === 'slim' ? 'slim' : 'classic', cape: cape ? cape.toString('base64') : null };
}

/** LittleSkin 的 CustomSkinAPI：{ username, skins: { default|slim: hash }, cape: hash } */
async function fromLittleSkin(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('请输入角色名');
  let j;
  try { j = await net.getJson(`https://littleskin.cn/csl/${encodeURIComponent(name)}.json`, { retries: 2, timeout: 15000 }); } catch (e) {
    if (e instanceof net.HttpError && e.status === 404) j = {};
    else throw e;
  }
  if (!j || !j.username) throw new Error(`LittleSkin 上没有找到角色「${nm(name)}」`);
  const skins = j.skins || {};
  const hash = skins.slim || skins.default || Object.values(skins)[0];
  if (!hash) throw new Error(`「${nm(j.username)}」在 LittleSkin 上还没有设置皮肤`);
  const tex = (h) => net.getBuffer(`https://littleskin.cn/textures/${h}`, { timeout: 20000 });
  const skin = await tex(hash);
  const cape = j.cape ? await tex(j.cape).catch(() => null) : null;
  return { name: j.username, skin: skin.toString('base64'), model: skins.slim ? 'slim' : 'classic', cape: cape ? cape.toString('base64') : null };
}

async function fromUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error('网址格式不正确'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http / https 网址');
  const buf = await net.getBuffer(u.href, { retries: 1, timeout: 20000 });
  if (buf.length > 2 * 1024 * 1024) throw new Error('图片太大了');
  if (!pngSize(buf)) throw new Error('这个网址不是 PNG 图片');
  return { name: path.basename(u.pathname).replace(/\.png$/i, '') || 'skin', skin: buf.toString('base64'), model: null, cape: null };
}

function fetchSkin({ source, value }) {
  if (source === 'mojang') return fromMojang(String(value || '').trim());
  if (source === 'littleskin') return fromLittleSkin(value);
  if (source === 'url') return fromUrl(value);
  throw new Error('未知的来源');
}

// ───────────────────────── 游戏自带的默认皮肤 ─────────────────────────
// 不随启动器分发 Mojang 的图片：从本机已安装的原版 jar 里读
let defaultsCache = null;
async function defaults() {
  if (defaultsCache) return defaultsCache;
  const versions = require('./versions');
  const { withZip } = require('../engine/zip');
  let jars = [];
  try {
    const dirs = await fsp.readdir(versions.versionsDir(), { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const jar = path.join(versions.versionsDir(), d.name, `${d.name}.jar`);
      try { jars.push({ jar, t: (await fsp.stat(jar)).mtimeMs }); } catch { /* 没有 jar */ }
    }
  } catch { /* 没有 versions */ }
  jars = jars.sort((a, b) => b.t - a.t).slice(0, 12);
  let best = [];
  for (const { jar } of jars) {
    try {
      const list = await withZip(jar, async (z) => {
        const out = [];
        const want = z.entries.filter((e) => /^assets\/minecraft\/textures\/entity\/(player\/(wide|slim)\/\w+|steve|alex)\.png$/.test(e.name));
        for (const e of want) {
          const m = e.name.match(/(?:player\/(wide|slim)\/)?(\w+)\.png$/);
          const model = m[1] ? (m[1] === 'slim' ? 'slim' : 'classic') : m[2] === 'alex' ? 'slim' : 'classic';
          const buf = await z.read(e);
          const s = pngSize(buf);
          if (!s || s.w !== 64) continue;
          out.push({ id: `${m[2]}-${model}`, name: m[2], model, png: buf.toString('base64') });
        }
        return out;
      });
      if (list.length > best.length) best = list;
      if (best.length >= 18) break;
    } catch { /* 不是有效的 jar */ }
  }
  const ORDER = ['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri'];
  best.sort((a, b) => (ORDER.indexOf(a.name) - ORDER.indexOf(b.name)) || a.model.localeCompare(b.model));
  if (best.length) defaultsCache = best;
  return best;
}

// ───────────────────────── 皮肤库 ─────────────────────────
const libIndex = () => path.join(libDir(), 'library.json');
// 读坏了不会被下一次写入盖掉（jsonstore，1.10.7）；改动都走 jsonStore.update 排队
const LIB = { label: '皮肤库', fallback: { items: [] } };

async function library() {
  const idx = await jsonStore.read(libIndex(), LIB.fallback, LIB);
  const items = [];
  for (const it of idx.items || []) {
    const p = path.join(libDir(), `${it.hash}.png`);
    if (await exists(p)) items.push({ ...it, url: fileUrl(p, it.hash) });
  }
  return items;
}

const cleanName = (s) => cutChars(String(s || '').trim(), 40);

/** 加一张皮肤到库里。已经有同一张图（同 hash）时：keep = true 保留原来的名字 / 分组，只挪到最前面 */
async function libraryAdd({ png, model, name, group, keep }) {
  const buf = fromB64(png);
  checkSkin(buf);
  const hash = sha256(buf);
  await fsp.mkdir(libDir(), { recursive: true });
  const p = path.join(libDir(), `${hash}.png`);
  if (!(await exists(p))) await fsp.writeFile(p, buf);
  await jsonStore.update(libIndex(), (idx) => {
    const old = (idx.items || []).find((x) => x.hash === hash);
    idx.items = (idx.items || []).filter((x) => x.hash !== hash);
    const item = keep && old ? old : { hash, model: model === 'slim' ? 'slim' : 'classic', name: cleanName(name) || '皮肤', addedAt: Date.now() };
    if (group !== undefined && !(keep && old && old.group)) item.group = cleanName(group) || undefined;
    if (item.group) idx.groups = [...new Set([...(idx.groups || []), item.group])];
    idx.items.unshift(item);
    return idx;
  }, LIB);
  return library();
}

/** 皮肤中心：库的全部信息，{ items, groups } */
async function libraryAll() {
  const idx = await jsonStore.read(libIndex(), LIB.fallback, LIB);
  const groups = [...new Set([...(idx.groups || []), ...(idx.items || []).map((x) => x.group).filter(Boolean)])];
  return { items: await library(), groups };
}

/** 改库里一张皮肤的名字 / 模型 / 分组（group: '' 表示移出分组） */
async function libraryUpdate(hash, patch = {}) {
  await jsonStore.update(libIndex(), (idx) => {
    const it = (idx.items || []).find((x) => x.hash === hash);
    if (!it) throw new Error('皮肤不存在');
    if (patch.name !== undefined) it.name = cleanName(patch.name) || it.name;
    if (patch.model) it.model = patch.model === 'slim' ? 'slim' : 'classic';
    if (patch.group !== undefined) {
      const g = cleanName(patch.group);
      if (g) { it.group = g; idx.groups = [...new Set([...(idx.groups || []), g])]; } else delete it.group;
    }
    return idx;
  }, LIB);
  return libraryAll();
}

/** 分组：add / rename / remove。删除分组不删皮肤，里面的皮肤变成「未分组」 */
async function libraryGroup({ op, name, to }) {
  await jsonStore.update(libIndex(), (idx) => {
    const g = cleanName(name);
    const groups = new Set([...(idx.groups || []), ...(idx.items || []).map((x) => x.group).filter(Boolean)]);
    if (op === 'add') { if (!g) throw new Error('请填写分组名'); groups.add(g); }
    if (op === 'rename') {
      const n = cleanName(to);
      if (!n) throw new Error('请填写分组名');
      groups.delete(g); groups.add(n);
      for (const it of idx.items || []) if (it.group === g) it.group = n;
    }
    if (op === 'remove') {
      groups.delete(g);
      for (const it of idx.items || []) if (it.group === g) delete it.group;
    }
    idx.groups = [...groups];
    return idx;
  }, LIB);
  return libraryAll();
}

/** 从文件夹里找皮肤图片（递归，最多 200 张），只要 64×64 / 64×32 的 PNG；返回 [{ name, png }] */
async function scanFolder(dir) {
  const out = [];
  async function walk(d, depth) {
    if (depth > 4 || out.length >= 200) return;
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= 200) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.png$/i.test(e.name)) {
        const st = await fsp.stat(p).catch(() => null);
        if (!st || st.size > 512 * 1024) continue;
        const buf = await fsp.readFile(p);
        const s = pngSize(buf);
        if (s && s.w === 64 && (s.h === 64 || s.h === 32)) out.push({ name: e.name.replace(/\.png$/i, ''), png: buf.toString('base64') });
      }
    }
  }
  await walk(dir, 0);
  return out;
}

async function libraryRemove(hash) {
  await jsonStore.update(libIndex(), (idx) => ({ ...idx, items: (idx.items || []).filter((x) => x.hash !== hash) }), LIB);
  if (/^[0-9a-f]{64}$/.test(hash)) await fsp.rm(path.join(libDir(), `${hash}.png`), { force: true });
  return library();
}

async function libraryRead(hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('皮肤不存在');
  return (await fsp.readFile(path.join(libDir(), `${hash}.png`))).toString('base64');
}

// ───────────────────────── 正版账户上传（微软登录开放后用） ─────────────────────────
async function uploadMicrosoft(token, png, model) {
  const buf = fromB64(png);
  checkSkin(buf);
  const form = new FormData();
  form.append('variant', model === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');
  const { res, done } = await net.request('https://api.minecraftservices.com/minecraft/profile/skins', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, timeout: 30000 });
  try {
    if (!res.ok) throw new net.HttpError(res.status, 'minecraft/profile/skins', await res.text().catch(() => ''));
    return await res.json();
  } finally { done(); }
}

// ───────────────────────── 启动时让皮肤生效 ─────────────────────────
const CSL_RE = /customskinloader/i;

/** 这个配置装了（并启用了）CustomSkinLoader 吗 */
async function hasCsl(gameDir) {
  try { return (await fsp.readdir(path.join(gameDir, 'mods'))).some((f) => CSL_RE.test(f) && /\.jar$/i.test(f)); } catch { return false; }
}

/** 把皮肤写进 CustomSkinLoader 的本地皮肤文件夹，并通过 ExtraList 把它排到加载顺序最前面 */
async function writeCsl(gameDir, acc) {
  const base = path.join(gameDir, 'CustomSkinLoader');
  const skin = await readTexture(acc, 'skin');
  if (!skin) return false;
  const cape = await readTexture(acc, 'cape');
  await fsp.mkdir(path.join(base, 'LocalSkin', 'skins'), { recursive: true });
  await fsp.writeFile(path.join(base, 'LocalSkin', 'skins', `${acc.name}.png`), skin.buf);
  const capeFile = path.join(base, 'LocalSkin', 'capes', `${acc.name}.png`);
  if (cape) { await fsp.mkdir(path.dirname(capeFile), { recursive: true }); await fsp.writeFile(capeFile, cape.buf); } else await fsp.rm(capeFile, { force: true });
  // ExtraList 里的条目会被 CSL 插到加载列表最前面（处理完它会删掉这个文件，所以每次启动都写）
  await fsp.mkdir(path.join(base, 'ExtraList'), { recursive: true });
  await fsp.writeFile(path.join(base, 'ExtraList', 'AuroraLocalSkin.json'), JSON.stringify({
    name: 'AuroraLocalSkin', type: 'Legacy', checkPNG: false,
    skin: 'LocalSkin/skins/{USERNAME}.png', model: acc.custom.model === 'slim' ? 'slim' : 'default', cape: 'LocalSkin/capes/{USERNAME}.png',
  }, null, 2), 'utf8');
  return true;
}

/**
 * 启动前：根据账户的生效方式准备参数。
 * 返回 { jvm: [...], userType?, accessToken?, service: bool, notes: [...] }
 */
async function prepareLaunch(acc, gameDir, task) {
  const out = { jvm: [], service: false, notes: [] };
  if (!acc || acc.type !== 'offline' || !acc.custom || !acc.custom.skin) return out;
  if (!(await readTexture(acc, 'skin'))) return out;
  const method = METHODS.includes(acc.custom.method) ? acc.custom.method : 'auto';
  if (method === 'none') return out;
  const csl = await hasCsl(gameDir);
  if (method === 'csl' || (method === 'auto' && csl)) {
    if (!csl) out.notes.push('皮肤生效方式选的是 CustomSkinLoader，但这个配置没有安装它，这次游戏里看不到自定义皮肤');
    else if (await writeCsl(gameDir, acc).catch((e) => { out.notes.push(`写入 CustomSkinLoader 皮肤失败：${e.message}`); return false; })) out.notes.push('已把皮肤写入 CustomSkinLoader 的本地皮肤');
  }
  if (method === 'service' || method === 'auto') {
    try {
      if (task) task.update({ detail: '准备本地皮肤服务…', progress: -1 });
      const jar = await require('./authlib').ensure(task);
      const server = require('./skinserver');
      await server.start();
      out.jvm.push(`-javaagent:${jar}=${server.apiRoot()}`, `-Dauthlibinjector.yggdrasil.prefetched=${server.prefetched()}`, '-Dauthlibinjector.noShowServerName');
      out.service = true;
      out.accessToken = crypto.randomBytes(16).toString('hex');
      out.userType = 'msa';
      out.notes.push(`本地皮肤服务：${server.apiRoot()}`);
    } catch (e) {
      if (e.cancelled) throw e;
      out.notes.push(`本地皮肤服务没有启动（${e.message}），这次游戏里看不到自定义皮肤`);
    }
  }
  return out;
}

/** 拉取微软正版账户的当前皮肤和披风并保存到本地缓存与皮肤中心 */
async function syncMicrosoftAccount(acc) {
  if (!acc || acc.type !== 'microsoft') return null;
  let skinBuf = null;
  let capeBuf = null;
  let model = acc.skin && acc.skin.variant === 'SLIM' ? 'slim' : 'classic';
  const skinUrl = httpsTexUrl(acc.skin && acc.skin.url);
  const capeUrl = httpsTexUrl(acc.cape && acc.cape.url);
  if (skinUrl) {
    try { skinBuf = await net.getBuffer(skinUrl, { retries: 1, timeout: 20000 }); } catch (e) { console.warn('[skins] 下载正版账户皮肤失败', e.message); }
  }
  if (!skinBuf && acc.name) {
    try {
      const fetched = await fromMojang(acc.name);
      if (fetched && fetched.skin) skinBuf = fromB64(fetched.skin);
      if (fetched && fetched.model) model = fetched.model;
      if (fetched && fetched.cape) capeBuf = fromB64(fetched.cape);
    } catch (e) { console.warn('[skins] 按玩家名拉取正版皮肤失败', e.message); }
  }
  if (!skinBuf) return null;
  const norm = normalizeSkinBuffer(skinBuf);
  if (!norm) return null;
  skinBuf = norm.png;
  const skinHash = await store(acc.id, skinBuf);
  let capeHash = null;
  if (!capeBuf && capeUrl) {
    try { capeBuf = await net.getBuffer(capeUrl, { retries: 1, timeout: 20000 }); } catch (e) { console.warn('[skins] 下载正版账户披风失败', e.message); }
  }
  if (capeBuf) {
    const capeNorm = normalizeCapeBuffer(capeBuf);
    if (capeNorm) capeHash = await store(acc.id, capeNorm);
  }
  await prune(acc.id, [skinHash, capeHash].filter(Boolean));
  await libraryAdd({ png: skinBuf, model, name: acc.name || '皮肤', group: MS_GROUP, keep: true });
  return { skin: skinHash, model, cape: capeHash, sourceUrl: skinUrl || '', syncedLib: true };
}

module.exports = {
  METHODS, MS_GROUP, pngSize, viewOf, cachedViewOf, normalizeSkinBuffer, normalizeCapeBuffer, syncMicrosoftAccount,
  apply, removeAccount, readTexture, fetchSkin, defaults,
  library, libraryAdd, libraryRemove, libraryRead, libraryAll, libraryUpdate, libraryGroup, scanFolder, uploadMicrosoft, hasCsl, writeCsl, prepareLaunch, root,
};
