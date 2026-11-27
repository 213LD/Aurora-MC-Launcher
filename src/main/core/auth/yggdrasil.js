'use strict';
/**
 * 外置登录（1.8.0）：按 authlib-injector 规范的 Yggdrasil 认证服务器，LittleSkin 是预设，也能填别的地址。
 * - 地址先做 API 地址指示（ALI）：访问玩家填的地址，响应头 X-Authlib-Injector-API-Location 指向真正的 API 根
 * - 用户名 / 密码只在登录这一下发给认证服务器，不保存；保存的是 accessToken（系统加密，见 accounts.js）
 * - 一个账号下有多个角色时先列出来让玩家选，选好用 refresh 把令牌绑到这个角色上
 * - 启动前 validate，失效就 refresh，refresh 也失败就要重新登录；游戏里用 -javaagent:authlib-injector.jar=<API 根>
 * 规范：https://github.com/yushijinhun/authlib-injector/wiki （Yggdrasil 服务端技术规范、启动器技术规范）
 */
const { request, postJson } = require('../../engine/net');

const PRESETS = [{ id: 'littleskin', name: 'LittleSkin', url: 'https://littleskin.cn/api/yggdrasil' }];

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

/** 玩家填的地址 → API 根地址 + 元数据（服务器名、皮肤域名、公钥），元数据原文用来给 authlib-injector 预取 */
// 不加密的 http：登录时密码会明文传过去。只认本机和局域网里的（自己搭的测试服务器），外面的要 https
function assertSafeRoot(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('认证服务器地址格式不对'); }
  if (u.protocol === 'https:') return;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const local = /^(localhost|127\.\d+\.\d+\.\d+|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i.test(h) || /\.local$/i.test(h);
  if (u.protocol !== 'http:' || !local) throw new Error('这个认证服务器用的是不加密的 http，登录时密码会明文传出去。请换成 https 开头的地址（本机、局域网里的服务器可以用 http）');
}

async function resolve(input) {
  let url = trimSlash(input);
  if (!url) throw new Error('请填写认证服务器地址');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  assertSafeRoot(url);
  let root = url;
  let text = '';
  for (let hop = 0; hop < 2; hop++) {
    const { res, done } = await request(root, { headers: { Accept: 'application/json' }, timeout: 15000 });
    try {
      const ali = res.headers.get('x-authlib-injector-api-location');
      if (ali && hop === 0) {
        const next = trimSlash(new URL(ali, root).href);
        assertSafeRoot(next); // 服务器指过去的真正地址也要查：不能从 https 被带到明文的 http
        if (next !== root) { root = next; continue; }
      }
      text = await res.text();
      if (!res.ok) throw new Error(`认证服务器返回 ${res.status}`);
    } finally { done(); }
    break;
  }
  let meta;
  try { meta = JSON.parse(text); } catch { throw new Error('这个地址不是 Yggdrasil 认证服务器（返回的不是 JSON）'); }
  if (!meta || !meta.meta || !meta.signaturePublickey) throw new Error('这个地址不是 authlib-injector 兼容的认证服务器（缺少元数据或公钥）');
  return { root, name: meta.meta.serverName || new URL(root).host, homepage: (meta.meta.links || {}).homepage || '', prefetched: Buffer.from(text, 'utf8').toString('base64') };
}

/** 认证服务器的错误说成人话 */
function yggError(r, fallback) {
  const d = r.data || {};
  const msg = d.errorMessage || d.error || '';
  if (/invalid credentials|密码|password/i.test(msg) || d.error === 'ForbiddenOperationException') return new Error(msg ? `登录失败：${msg}` : '用户名或密码不对');
  return new Error(msg ? `${fallback}：${msg}` : `${fallback}（${r.status}）`);
}

/** 用户名（多数服务器是邮箱）+ 密码登录；返回 { accessToken, profiles, selected } */
async function authenticate(root, username, password, clientToken) {
  const r = await postJson(`${root}/authserver/authenticate`, { agent: { name: 'Minecraft', version: 1 }, username, password, clientToken, requestUser: false });
  if (!r.ok || !r.data || !r.data.accessToken) throw yggError(r, '登录失败');
  return { accessToken: r.data.accessToken, profiles: r.data.availableProfiles || [], selected: r.data.selectedProfile || null };
}

/** 刷新令牌（可以顺便绑定角色）；令牌已经彻底失效时抛 needRelogin */
async function refresh(root, accessToken, clientToken, profile) {
  const body = { accessToken, clientToken, requestUser: false };
  if (profile) body.selectedProfile = { id: profile.id, name: profile.name };
  const r = await postJson(`${root}/authserver/refresh`, body);
  if (!r.ok || !r.data || !r.data.accessToken) {
    const e = yggError(r, '刷新登录失败');
    if (r.status === 403 || r.status === 401) { e.needRelogin = true; e.message = '外置登录的登录信息已失效，请重新登录'; }
    throw e;
  }
  return { accessToken: r.data.accessToken, selected: r.data.selectedProfile || profile || null };
}

/** 令牌还能不能用（204 = 能用） */
async function validate(root, accessToken, clientToken) {
  const r = await postJson(`${root}/authserver/validate`, { accessToken, clientToken });
  return r.status === 204;
}

/** 角色的皮肤地址（头像用）；拿不到返回 null */
async function skinOf(root, uuid) {
  try {
    const { res, done } = await request(`${root}/sessionserver/session/minecraft/profile/${uuid}?unsigned=true`, { timeout: 10000 });
    try {
      if (!res.ok) return null;
      const p = await res.json();
      const prop = (p.properties || []).find((x) => x.name === 'textures');
      if (!prop) return null;
      const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures || {};
      // 和正版账户一样的格式（skin: { url, variant }，cape: { url }），头像、皮肤预览直接能用
      return { skin: tex.SKIN ? { url: tex.SKIN.url, variant: tex.SKIN.metadata && tex.SKIN.metadata.model === 'slim' ? 'SLIM' : 'CLASSIC' } : null, cape: tex.CAPE ? { url: tex.CAPE.url } : null };
    } finally { done(); }
  } catch { return null; }
}

module.exports = { PRESETS, resolve, authenticate, refresh, validate, skinOf };
