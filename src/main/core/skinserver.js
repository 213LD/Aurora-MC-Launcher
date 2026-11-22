'use strict';
/**
 * 本地皮肤服务：在 127.0.0.1 的随机端口上提供一个最小的 Yggdrasil 兼容接口，
 * 游戏通过 authlib-injector 连接它，就能看到离线账户的自定义皮肤和披风。做法参考 HMCL 的 YggdrasilServer。
 * 材质属性用启动时生成的 RSA 密钥签名（authlib-injector 用元数据里的公钥替换 Mojang 的公钥）。
 * 服务启动后一直开到启动器退出：游戏随时可能去取皮肤。
 */
const http = require('http');
const crypto = require('crypto');
const { app } = require('electron');
const BRAND = require('../../shared/brand');

let server = null;
let port = 0;
let keys = null;
let starting = null;
const log = [];

const dashed = (u) => u.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const undash = (u) => String(u || '').replace(/-/g, '').toLowerCase();

function accountsList() {
  const accounts = require('./auth/accounts');
  return accounts.raw().filter((a) => a.type === 'offline');
}

/** 离线玩家：已知账户用账户里的 UUID，其他名字（局域网里的朋友）用标准离线 UUID */
function profileByName(name) {
  const lower = String(name || '').toLowerCase();
  const acc = accountsList().find((a) => a.name.toLowerCase() === lower);
  if (acc) return acc;
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name || '')) return null;
  return { id: null, name, uuid: require('./auth/accounts').offlineUUID(name) };
}
function profileByUuid(uuid) {
  const u = undash(uuid);
  return accountsList().find((a) => a.uuid === u) || null;
}

const textures = new Map(); // hash → Buffer

async function texturesOf(acc) {
  const skins = require('./skins');
  const out = {};
  if (!acc.id) return out;
  const skin = await skins.readTexture(acc, 'skin');
  if (skin) {
    textures.set(skin.hash, skin.buf);
    out.SKIN = { url: `${apiRoot()}textures/${skin.hash}` };
    if (acc.custom.model === 'slim') out.SKIN.metadata = { model: 'slim' };
  }
  const cape = await skins.readTexture(acc, 'cape');
  if (cape) {
    textures.set(cape.hash, cape.buf);
    out.CAPE = { url: `${apiRoot()}textures/${cape.hash}` };
  }
  return out;
}

async function profileJson(acc, signed) {
  const json = { id: acc.uuid, name: acc.name, properties: [] };
  const tx = await texturesOf(acc);
  const value = Buffer.from(JSON.stringify({ timestamp: Date.now(), profileId: acc.uuid, profileName: acc.name, textures: tx })).toString('base64');
  const prop = { name: 'textures', value };
  if (signed) prop.signature = crypto.sign('sha1', Buffer.from(value), keys.privateKey).toString('base64');
  json.properties.push(prop);
  return json;
}

function metadata() {
  return {
    meta: {
      serverName: BRAND.name, implementationName: `${BRAND.short} local skin server`, implementationVersion: app.getVersion(),
      feature: { non_email_login: true },
    },
    skinDomains: ['127.0.0.1', 'localhost'],
    signaturePublickey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  if (body === undefined) { res.writeHead(status); res.end(); return; }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size < 64 * 1024) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

async function route(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  log.push(`${req.method} ${p}`);
  if (log.length > 200) log.shift();
  if (req.method === 'GET' && p === '/') return send(res, 200, metadata());
  if (req.method === 'GET' && p === '/status') return send(res, 200, { name: BRAND.name, port });
  // 按名字批量查 UUID
  if (req.method === 'POST' && p === '/api/profiles/minecraft') {
    let names = [];
    try { names = JSON.parse(await readBody(req)); } catch { /* 空 */ }
    const out = (Array.isArray(names) ? names : []).slice(0, 10).map(profileByName).filter(Boolean).map((a) => ({ id: a.uuid, name: a.name }));
    return send(res, 200, out);
  }
  // 进服务器：离线账户没有真正的会话，直接放行
  if (req.method === 'POST' && p === '/sessionserver/session/minecraft/join') { await readBody(req); return send(res, 204); }
  // 开局域网的一方验证加入的玩家：认识的名字都放行（和离线服务器一样）
  if (req.method === 'GET' && p === '/sessionserver/session/minecraft/hasJoined') {
    const acc = profileByName(u.searchParams.get('username'));
    return acc ? send(res, 200, await profileJson(acc, true)) : send(res, 204);
  }
  let m = p.match(/^\/sessionserver\/session\/minecraft\/profile\/([0-9a-fA-F-]{32,36})$/);
  if (req.method === 'GET' && m) {
    const acc = profileByUuid(m[1]);
    return acc ? send(res, 200, await profileJson(acc, u.searchParams.get('unsigned') === 'false')) : send(res, 204);
  }
  m = p.match(/^\/textures\/([0-9a-f]{64})$/);
  if (req.method === 'GET' && m) {
    const buf = textures.get(m[1]);
    return buf ? send(res, 200, buf, 'image/png') : send(res, 404, { error: 'Not Found' });
  }
  // 1.19+ 会访问的服务接口：给出不影响游戏的默认值
  if (req.method === 'GET' && p === '/minecraftservices/player/attributes') {
    return send(res, 200, { privileges: { onlineChat: { enabled: true }, multiplayerServer: { enabled: true }, multiplayerRealms: { enabled: false }, telemetry: { enabled: false } }, profanityFilterPreferences: { profanityFilterOn: false } });
  }
  if (req.method === 'GET' && p === '/minecraftservices/privacy/blocklist') return send(res, 200, { blockedProfiles: [] });
  if (req.method === 'GET' && p === '/minecraftservices/publickeys') {
    const der = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    return send(res, 200, { profilePropertyKeys: [{ publicKey: der }], playerCertificateKeys: [{ publicKey: der }] });
  }
  return send(res, 404, { error: 'Not Found', path: p });
}

function start() {
  if (server) return Promise.resolve();
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    // 密钥在后台生成（rc9）：以前用同步的，启动游戏时主进程卡几百毫秒，界面跟着顿一下
    crypto.generateKeyPair('rsa', { modulusLength: 2048 }, (err, pair) => {
      if (err) { starting = null; reject(err); return; }
      keys = pair;
      const s = http.createServer((req, res) => {
        route(req, res).catch((e) => { try { send(res, 500, { error: e.message }); } catch { /* 已断开 */ } });
      });
      s.on('error', (e) => { starting = null; reject(e); });
      s.listen(0, '127.0.0.1', () => {
        server = s;
        port = s.address().port;
        s.unref();
        console.log(`[skinserver] 127.0.0.1:${port}`);
        resolve();
      });
    });
  });
  return starting;
}

function stop() {
  if (server) server.close();
  server = null; starting = null; port = 0;
}

const apiRoot = () => `http://127.0.0.1:${port}/`;
const prefetched = () => Buffer.from(JSON.stringify(metadata())).toString('base64');
const running = () => !!server;

module.exports = { start, stop, apiRoot, prefetched, running, log, dashed };
