'use strict';
/**
 * 账户：离线、外置登录（Yggdrasil）、微软正版。
 * 令牌用系统加密存着，密码不存；启动前由 getLaunchAuth 换好这次用的登录信息。
 */
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const paths = require('../../engine/paths');
const config = require('../../engine/config');
const store = require('../../engine/jsonstore');
const ms = require('./microsoft');
const ygg = require('./yggdrasil');
const skins = require('../skins');
const { nm } = require('../../../shared/i18n');
const { toHttps } = require('../../../shared/weburl');

let state = null;

function file() { return path.join(paths.dataDir(), 'accounts.json'); }

// 敏感令牌使用系统级加密（Windows DPAPI / macOS 钥匙串）保存
function enc(s) {
  if (!s) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(s).toString('base64')}`;
  } catch { /* ignore */ }
  return `raw:${Buffer.from(s, 'utf8').toString('base64')}`;
}
function dec(s) {
  if (!s) return '';
  try {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
  } catch { /* ignore */ }
  return '';
}

// 账户文件读不了（被占着）时不写回，免得一个新账户把原来的列表整个盖掉（1.10.7）
let blocked = false;
const LABEL = '账户列表';

function load() {
  if (state) return state;
  const r = store.loadSync(file(), { label: LABEL });
  blocked = r.status === 'busy';
  state = r.data && typeof r.data === 'object' ? r.data : { accounts: [], selected: '' };
  if (!Array.isArray(state.accounts)) state.accounts = [];
  return state;
}

/** opts.resetBak：删了账户时备份也换成新的，旧备份里不留那个账户的令牌 */
function save(opts = {}) {
  if (blocked) return Promise.reject(store.busyError(LABEL, file()));
  return store.write(file(), state, { label: LABEL, ...opts });
}

/** 与原版服务端一致的离线 UUID：UUID.nameUUIDFromBytes("OfflinePlayer:" + name) */
function offlineUUID(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  return md5.toString('hex');
}

function publicView(a) {
  // 离线账户的自定义皮肤；正版账户优先用本地缓存（断网/防策略拦截），未缓存时将 Mojang http 升级为 https
  const custom = a.type === 'offline' ? skins.viewOf(a) : null;
  const cached = a.type === 'microsoft' ? skins.cachedViewOf(a) : null;
  const upgrade = (x) => (x && x.url && a.type === 'microsoft'
    ? { ...x, url: toHttps(x.url) }
    : x || null);
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    uuid: a.uuid,
    skin: (custom && custom.skin) || (cached && cached.skin) || upgrade(a.skin),
    cape: (custom && custom.cape) || (cached && cached.cape) || upgrade(a.cape),
    skinMethod: custom ? custom.method : (a.custom && a.custom.method) || 'auto',
    server: a.type === 'yggdrasil' && a.server ? { name: a.server.name, root: a.server.root, homepage: a.server.homepage || '' } : null,
    addedAt: a.addedAt,
    expired: a.type === 'microsoft' ? !a.mcExpiresAt || a.mcExpiresAt < Date.now() : false,
    needRelogin: !!a.needRelogin,
  };
}

function list() {
  load();
  if (!state.selected && state.accounts.length) state.selected = state.accounts[0].id;
  return { accounts: state.accounts.map(publicView), selected: state.selected };
}

function validateOfflineName(name) {
  if (!name) throw new Error('请输入玩家名');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('玩家名需为 3~16 位英文字母、数字或下划线');
}

async function addOffline(name, customUuid) {
  load();
  name = String(name || '').trim();
  validateOfflineName(name);
  let uuid = offlineUUID(name);
  if (customUuid) {
    const u = String(customUuid).replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(u)) throw new Error('UUID 格式不正确');
    uuid = u;
  }
  const existing = state.accounts.find((a) => a.type === 'offline' && a.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.uuid = uuid;
    state.selected = existing.id;
  } else {
    const acc = { id: `offline-${uuid}`, type: 'offline', name, uuid, addedAt: Date.now() };
    state.accounts.push(acc);
    state.selected = acc.id;
  }
  await save();
  return list();
}

const skinSyncAt = new Map(); // 账户 id → 上次补拉的时间（补拉失败时，隔一阵子再试）
const SKIN_RETRY_MS = 10 * 60000;
let skinBackfillPromise = null;

async function syncMicrosoftSkin(acc) {
  if (!acc || acc.type !== 'microsoft') return false;
  skinSyncAt.set(acc.id, Date.now());
  const cached = await skins.syncMicrosoftAccount(acc);
  if (!cached) return false;
  load();
  const live = state.accounts.find((a) => a.id === acc.id);
  if (!live) return false;
  live.skinCache = cached;
  await save();
  return true;
}

/** 有正版皮肤、但还没存到本地或还没进皮肤中心（升级上来的老账户、上次没下成功的）；本来就没设皮肤的不用拉 */
const needsSkinSync = (a) => !!(a && a.type === 'microsoft' && a.skin && a.skin.url
  && (!a.skinCache || !a.skinCache.syncedLib || !skins.cachedViewOf(a)));

/** 启动或升级后后台补拉尚未缓存/入库的微软正版皮肤 */
function syncMissingMicrosoftSkins(onChanged) {
  load();
  const now = Date.now();
  const todo = state.accounts.filter((a) => needsSkinSync(a) && now - (skinSyncAt.get(a.id) || 0) > SKIN_RETRY_MS);
  if (!todo.length || skinBackfillPromise) return skinBackfillPromise;
  skinBackfillPromise = (async () => {
    let updated = false;
    for (const acc of todo) {
      try { if (await syncMicrosoftSkin(acc)) updated = true; } catch (e) { console.warn('[accounts] 补拉微软账户皮肤失败', e.message); }
    }
    if (updated && typeof onChanged === 'function') onChanged();
  })().finally(() => { skinBackfillPromise = null; });
  return skinBackfillPromise;
}

async function upsertMicrosoft(result) {
  load();
  const id = `ms-${result.uuid}`;
  let acc = state.accounts.find((a) => a.id === id);
  if (!acc) {
    acc = { id, type: 'microsoft', addedAt: Date.now() };
    state.accounts.push(acc);
  }
  Object.assign(acc, {
    name: result.name,
    uuid: result.uuid,
    skin: result.skin,
    cape: result.cape,
    xuid: result.xuid,
    mcExpiresAt: result.mcExpiresAt,
    mcAccessToken: enc(result.mcAccessToken),
    needRelogin: false,
  });
  if (!result.skin) delete acc.skinCache;
  if (result.msRefreshToken) acc.msRefreshToken = enc(result.msRefreshToken);
  // 刷新令牌只能用签发它的那个 Azure 应用来刷：记下来，之后设置里换了 Client ID 也不影响这个账户
  if (result.clientId) acc.msClientId = result.clientId;
  state.selected = id;
  await save();
  try { await syncMicrosoftSkin(acc); } catch (e) { console.warn('[accounts] 同步微软账户皮肤失败', e.message); }
  return publicView(acc);
}

// ── 外置登录（1.8.0，yggdrasil.js） ──
const hostOf = (u) => { try { return new URL(u).host; } catch { return 'ygg'; } };

/**
 * 外置登录：server 是玩家填的地址（或预设的 LittleSkin），密码只用这一次、不保存。
 * 账号下有多个角色、又没指定 profileId 时返回 { pick: [{ id, name }] }，让界面问玩家选哪个后带着 profileId 再调一次
 */
async function yggLogin({ server, username, password, profileId } = {}) {
  load();
  if (!username || !password) throw new Error('请填写用户名（邮箱）和密码');
  const srv = await ygg.resolve(server);
  const ct = config.get().clientToken;
  const auth = await ygg.authenticate(srv.root, username.trim(), password, ct);
  if (!auth.profiles.length) throw new Error(`这个账号在 ${nm(srv.name)} 上还没有角色，先去它的网站上创建一个`);
  let prof = profileId ? auth.profiles.find((p) => p.id === profileId) : auth.selected;
  if (!prof && auth.profiles.length === 1) prof = auth.profiles[0];
  if (!prof) return { pick: auth.profiles.map((p) => ({ id: p.id, name: p.name })), server: srv.name };
  let token = auth.accessToken;
  if (!auth.selected || auth.selected.id !== prof.id) token = (await ygg.refresh(srv.root, token, ct, prof)).accessToken;
  const tex = await ygg.skinOf(srv.root, prof.id);
  const id = `ygg-${hostOf(srv.root)}-${prof.id}`;
  let acc = state.accounts.find((a) => a.id === id);
  if (!acc) { acc = { id, type: 'yggdrasil', addedAt: Date.now() }; state.accounts.push(acc); }
  Object.assign(acc, {
    name: prof.name, uuid: prof.id, server: { root: srv.root, name: srv.name, homepage: srv.homepage },
    accessToken: enc(token), skin: tex && tex.skin, cape: tex && tex.cape, needRelogin: false,
  });
  state.selected = id;
  await save();
  return { account: publicView(acc) };
}

/** 外置登录账户：令牌还能用就照旧，不能用就刷新；refresh 也失败就标「需要重新登录」 */
async function yggEnsure(acc, onStep = () => {}) {
  // 以前的版本导出账户时漏了认证服务器：这样导进来的账户不知道去哪登录，说清楚怎么办
  if (!acc.server || !acc.server.root) {
    acc.needRelogin = true; await save();
    const e = new Error(`外置登录账户「${nm(acc.name)}」缺少认证服务器的信息（可能是从旧版本导出的数据导进来的），请删掉它，再用「外置登录」重新添加`);
    e.needRelogin = true; throw e;
  }
  const ct = config.get().clientToken;
  let token = dec(acc.accessToken);
  const relogin = async () => { acc.needRelogin = true; await save(); const e = new Error(`${nm(acc.server.name)} 的登录信息已失效，请重新登录`); e.needRelogin = true; return e; };
  if (!token) throw await relogin();
  onStep(`正在检查 ${acc.server.name} 的登录…`);
  let ok;
  try { ok = await ygg.validate(acc.server.root, token, ct); } catch { ok = true; } // 连不上认证服务器：先用着旧令牌（单人游戏不受影响）
  if (!ok) {
    try {
      token = (await ygg.refresh(acc.server.root, token, ct, { id: acc.uuid, name: acc.name })).accessToken;
      acc.accessToken = enc(token); acc.needRelogin = false; await save();
    } catch (e) { if (e.needRelogin) throw await relogin(); throw e; }
  }
  return token;
}

// ── 设备代码登录会话 ──
let pending = null;
const msClientId = () => (config.get().msClientId || '').trim() || ms.DEFAULT_CLIENT_ID;

async function msStart() {
  const clientId = msClientId();
  if (pending) pending.controller.abort();
  const dc = await ms.startDeviceCode(clientId);
  pending = { dc, clientId, controller: new AbortController() };
  return { userCode: dc.userCode, verificationUri: dc.verificationUri, expiresIn: dc.expiresIn };
}

async function msWait(onStep) {
  if (!pending) throw new Error('没有进行中的登录');
  const { dc, clientId, controller } = pending;
  try {
    const token = await ms.pollDeviceCode(clientId, dc, controller.signal);
    onStep('已授权，正在登录…');
    const result = await ms.loginWithMsToken(token, onStep, controller.signal);
    return await upsertMicrosoft({ ...result, clientId });
  } finally {
    if (pending && pending.controller === controller) pending = null;
  }
}

function msCancel() {
  if (pending) { pending.controller.abort(); pending = null; }
}

// 同一个账户同时刷新两次（启动游戏和账户页一起）：微软每次刷新都换一个新的刷新令牌，两个请求拿同一个旧令牌会有一个失败。合成一次
const refreshing = new Map();
function refresh(id, onStep = () => {}) {
  if (refreshing.has(id)) return refreshing.get(id);
  const p = refreshOnce(id, onStep).finally(() => refreshing.delete(id));
  refreshing.set(id, p);
  return p;
}

async function refreshOnce(id, onStep) {
  load();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('账户不存在');
  if (acc.type === 'yggdrasil') {
    await yggEnsure(acc, onStep);
    const tex = await ygg.skinOf(acc.server.root, acc.uuid);
    if (tex) { acc.skin = tex.skin; acc.cape = tex.cape; await save(); }
    return publicView(acc);
  }
  if (acc.type !== 'microsoft') return publicView(acc);
  const clientId = acc.msClientId || msClientId();
  const rt = dec(acc.msRefreshToken);
  if (!clientId || !rt) {
    acc.needRelogin = true; await save();
    throw new Error('登录信息已失效，请重新登录微软账户');
  }
  try {
    onStep('正在刷新微软登录…');
    const token = await ms.refreshMsToken(clientId, rt);
    const result = await ms.loginWithMsToken(token, onStep);
    if (!result.msRefreshToken) result.msRefreshToken = rt;
    return await upsertMicrosoft({ ...result, clientId });
  } catch (e) {
    if (e.needRelogin) { acc.needRelogin = true; await save(); }
    throw e;
  }
}

/** 启动前获取可用的认证信息，必要时自动刷新令牌 */
async function getLaunchAuth(id, onStep) {
  load();
  const acc = state.accounts.find((a) => a.id === (id || state.selected));
  if (!acc) throw new Error('请先添加一个账户');
  if (acc.type === 'offline') {
    return { type: 'offline', name: acc.name, uuid: acc.uuid, accessToken: acc.uuid, xuid: '0', userType: 'legacy' };
  }
  if (acc.type === 'yggdrasil') {
    // 外置登录：游戏通过 authlib-injector 连认证服务器；元数据预取一份免得游戏启动时再请求（拿不到就让它自己取）
    const token = await yggEnsure(acc, onStep);
    onStep('准备 authlib-injector…');
    const jar = await require('../authlib').ensure(null);
    const srv = await ygg.resolve(acc.server.root).catch(() => null);
    const jvmPre = [`-javaagent:${jar}=${acc.server.root}`];
    if (srv) jvmPre.push(`-Dauthlibinjector.yggdrasil.prefetched=${srv.prefetched}`);
    return { type: 'yggdrasil', name: acc.name, uuid: acc.uuid, accessToken: token, xuid: '0', userType: 'mojang', jvmPre };
  }
  let a = acc;
  if (!acc.mcExpiresAt || acc.mcExpiresAt - Date.now() < 10 * 60 * 1000 || !dec(acc.mcAccessToken)) {
    try {
      await refresh(acc.id, onStep);
    } catch (e) {
      // 快过期了提前刷新，但这会儿连不上微软（断网、服务器出错）：手里的令牌还没过期就先用它进游戏，不挡着玩家
      const stillValid = !e.needRelogin && !e.cancelled && acc.mcExpiresAt && acc.mcExpiresAt - Date.now() > 60 * 1000 && dec(acc.mcAccessToken);
      if (!stillValid) throw e;
      onStep('暂时刷新不了微软登录，先用现有的登录进游戏');
    }
    a = state.accounts.find((x) => x.id === acc.id);
  }
  return { type: 'microsoft', name: a.name, uuid: a.uuid, accessToken: dec(a.mcAccessToken), xuid: a.xuid || '0', userType: 'msa' };
}

async function remove(id) {
  load();
  skinSyncAt.delete(id);
  await skins.removeAccount(id).catch(() => {});
  state.accounts = state.accounts.filter((a) => a.id !== id);
  if (state.selected === id) state.selected = state.accounts[0] ? state.accounts[0].id : '';
  await save({ resetBak: true });
  return list();
}

async function select(id) {
  load();
  if (state.accounts.some((a) => a.id === id)) state.selected = id;
  await save();
  return list();
}

/** 改离线账户的皮肤 / 模型 / 披风 / 生效方式（patch 见 skins.apply） */
async function setSkin(id, patch) {
  load();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('账户不存在');
  if (acc.type !== 'offline') throw new Error('正版账户的皮肤要上传到官方，不能在本地修改');
  const c = await skins.apply(acc, patch || {});
  if (c) acc.custom = c; else delete acc.custom;
  await save();
  return publicView(acc);
}

/**
 * 数据迁移（1.5.3）：导出用的账户记录——只有名字、UUID、皮肤；登录令牌一概不带（在别的电脑上也解不开，带上只会泄露）
 */
function exportList(src) {
  const from = src || (load(), state);
  return {
    selected: from.selected || '',
    accounts: (from.accounts || []).filter((a) => a && a.id && a.type).map((a) => {
      const out = { id: a.id, type: a.type, name: a.name, uuid: a.uuid, addedAt: a.addedAt };
      if (a.type === 'offline' && a.custom) out.custom = a.custom;
      if (a.type !== 'offline') { out.skin = a.skin; out.cape = a.cape; out.needRelogin = true; }
      // 外置登录要知道是哪个认证服务器（只有名字和地址，不含令牌）；以前漏了它，导进来以后刷新、启动直接报错
      if (a.type === 'yggdrasil' && a.server && a.server.root) out.server = { name: a.server.name || '', root: a.server.root, homepage: a.server.homepage || '' };
      return out;
    }),
  };
}

/** 导入账户：同一个账户（同 id）已经有了就保留这台电脑上的；正版账户导进来要重新登录。返回导入了几个 */
async function importList(data) {
  load();
  let n = 0;
  for (const a of exportList(data).accounts) {
    if (state.accounts.some((x) => x.id === a.id)) continue;
    if (a.type === 'offline' && !/^[A-Za-z0-9_]{3,16}$/.test(a.name || '')) continue;
    state.accounts.push(a);
    n++;
  }
  if (!state.selected && state.accounts.length) state.selected = (data && data.selected && state.accounts.some((x) => x.id === data.selected)) ? data.selected : state.accounts[0].id;
  await save();
  return n;
}

/** 主进程内部用（本地皮肤服务、启动）：原始账户记录 */
function raw() { load(); return state.accounts; }
function find(id) { load(); return state.accounts.find((a) => a.id === (id || state.selected)) || null; }

module.exports = { yggLogin, yggPresets: () => ygg.PRESETS, setSkin, raw, find, list, addOffline, msStart, msWait, msCancel, refresh, syncMicrosoftSkin, syncMissingMicrosoftSkins, getLaunchAuth, remove, select, offlineUUID, exportList, importList };
