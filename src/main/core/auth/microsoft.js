'use strict';
/**
 * 微软正版登录（OAuth 2.0 设备代码流）
 * Microsoft → Xbox Live → XSTS → Minecraft Services
 */
const { postForm, postJson, getJsonAuth } = require('../../engine/net');
const { sleep, abortError } = require('../../engine/util');

const MS_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

const XSTS_ERRORS = {
  2148916227: '该账户已被 Xbox 封禁',
  2148916229: '该账户受家长控制限制，无法进行在线游戏',
  2148916233: '该微软账户还没有 Xbox 档案，请先访问 xbox.com 创建后再登录',
  2148916234: '请先在 Xbox 网站上同意服务条款',
  2148916235: '你所在的国家/地区不支持 Xbox Live',
  2148916236: '该账户需要完成成人验证（韩国地区）',
  2148916237: '该账户需要完成成人验证（韩国地区）',
  2148916238: '该账户为未成年账户，需要由家长将其加入微软家庭组后才能登录',
};

function msError(data, fallback) {
  if (!data) return fallback;
  return data.error_description ? data.error_description.split(/\r?\n/)[0] : data.error || fallback;
}

async function startDeviceCode(clientId) {
  if (!clientId) throw new Error('尚未配置 Azure 应用 Client ID');
  const r = await postForm(`${MS_BASE}/devicecode`, { client_id: clientId, scope: SCOPE });
  if (!r.ok || !r.data || !r.data.device_code) {
    throw new Error(`获取登录代码失败：${msError(r.data, `HTTP ${r.status}`)}`);
  }
  return {
    userCode: r.data.user_code,
    deviceCode: r.data.device_code,
    verificationUri: r.data.verification_uri || 'https://www.microsoft.com/link',
    expiresIn: r.data.expires_in || 900,
    interval: r.data.interval || 5,
    message: r.data.message,
  };
}

async function pollDeviceCode(clientId, dc, signal) {
  let interval = Math.max(1, dc.interval) * 1000;
  const deadline = Date.now() + dc.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    if (signal && signal.aborted) throw abortError();
    const r = await postForm(`${MS_BASE}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: dc.deviceCode,
    }, { signal });
    if (r.ok && r.data && r.data.access_token) return r.data;
    const err = r.data && r.data.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    if (err === 'authorization_declined') throw new Error('你拒绝了授权');
    if (err === 'expired_token') throw new Error('登录代码已过期，请重试');
    if (err === 'bad_verification_code') throw new Error('登录代码无效');
    throw new Error(`登录失败：${msError(r.data, `HTTP ${r.status}`)}`);
  }
  throw new Error('登录代码已过期，请重试');
}

async function refreshMsToken(clientId, refreshToken) {
  const r = await postForm(`${MS_BASE}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  if (!r.ok || !r.data || !r.data.access_token) {
    const e = new Error(`刷新微软登录失败：${msError(r.data, `HTTP ${r.status}`)}，请重新登录`);
    e.needRelogin = true;
    throw e;
  }
  return r.data;
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}

async function xboxChain(msAccessToken, onStep = () => {}) {
  onStep('正在验证 Xbox Live…');
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!xbl.ok || !xbl.data || !xbl.data.Token) throw new Error(`Xbox Live 验证失败（HTTP ${xbl.status}）`);
  const uhs = xbl.data.DisplayClaims.xui[0].uhs;

  onStep('正在获取 XSTS 令牌…');
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  if (!xsts.ok || !xsts.data || !xsts.data.Token) {
    const code = xsts.data && xsts.data.XErr;
    throw new Error(XSTS_ERRORS[code] || `XSTS 授权失败（${code || `HTTP ${xsts.status}`}）`);
  }

  onStep('正在登录 Minecraft 服务…');
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.data.Token}`,
  });
  if (!mc.ok || !mc.data || !mc.data.access_token) {
    const raw = JSON.stringify(mc.data || {});
    if (mc.status === 403 || /Invalid app registration/i.test(raw)) {
      throw new Error('该 Azure 应用尚未获得 Minecraft API 访问权限。请前往 https://aka.ms/mce-reviewappid 提交 Client ID 审核，通过后即可登录');
    }
    if (mc.status === 429) throw new Error('登录过于频繁，请稍后再试');
    throw new Error(`Minecraft 登录失败（HTTP ${mc.status}）`);
  }
  const claims = decodeJwt(mc.data.access_token);
  return {
    accessToken: mc.data.access_token,
    expiresAt: Date.now() + (mc.data.expires_in || 86400) * 1000,
    xuid: claims.xuid || '',
  };
}

async function fetchProfile(mcToken, onStep = () => {}) {
  onStep('正在获取游戏档案…');
  const r = await getJsonAuth('https://api.minecraftservices.com/minecraft/profile', mcToken);
  if (r.status === 404) throw new Error('该账户没有 Minecraft: Java 版，或尚未设置角色名（可在 minecraft.net 设置）');
  if (!r.ok || !r.data || !r.data.id) throw new Error(`获取游戏档案失败（HTTP ${r.status}）`);
  const skin = (r.data.skins || []).find((s) => s.state === 'ACTIVE') || (r.data.skins || [])[0];
  const cape = (r.data.capes || []).find((c) => c.state === 'ACTIVE');
  return {
    uuid: r.data.id,
    name: r.data.name,
    skin: skin ? { url: skin.url, variant: skin.variant } : null,
    cape: cape ? { url: cape.url, alias: cape.alias } : null,
  };
}

/** 完整登录：微软令牌 → Minecraft 档案 */
async function loginWithMsToken(ms, onStep) {
  const mc = await xboxChain(ms.access_token, onStep);
  const profile = await fetchProfile(mc.accessToken, onStep);
  return {
    msRefreshToken: ms.refresh_token,
    mcAccessToken: mc.accessToken,
    mcExpiresAt: mc.expiresAt,
    xuid: mc.xuid,
    ...profile,
  };
}

module.exports = { startDeviceCode, pollDeviceCode, refreshMsToken, loginWithMsToken, fetchProfile };
