'use strict';
const config = require('./config');
const { request } = require('./net');

const BMCL = 'https://bmclapi2.bangbang93.com';

// 官方地址 → BMCLAPI 镜像
const RULES = [
  [/^https?:\/\/(piston-meta|launchermeta|launcher|piston-data)\.mojang\.com/, BMCL],
  [/^https?:\/\/resources\.download\.minecraft\.net/, `${BMCL}/assets`],
  [/^https?:\/\/libraries\.minecraft\.net/, `${BMCL}/maven`],
  [/^https?:\/\/maven\.minecraftforge\.net/, `${BMCL}/maven`],
  [/^https?:\/\/files\.minecraftforge\.net\/maven/, `${BMCL}/maven`],
  [/^https?:\/\/maven\.neoforged\.net\/releases/, `${BMCL}/maven`],
  [/^https?:\/\/maven\.fabricmc\.net/, `${BMCL}/maven`],
  [/^https?:\/\/meta\.fabricmc\.net/, `${BMCL}/fabric-meta`],
];

// 一些老旧地址统一修正到现在可用的官方地址
const OFFICIAL_FIX = [
  [/^http:\/\/files\.minecraftforge\.net\/maven/, 'https://maven.minecraftforge.net'],
  [/^https:\/\/files\.minecraftforge\.net\/maven/, 'https://maven.minecraftforge.net'],
  [/^http:\/\//, 'https://'],
];

function normalize(url) {
  let u = url;
  for (const [re, rep] of OFFICIAL_FIX) {
    if (re.test(u)) { u = u.replace(re, rep); break; }
  }
  return u;
}

function toMirror(url) {
  for (const [re, rep] of RULES) {
    if (re.test(url)) return url.replace(re, rep);
  }
  return null;
}

let autoPrefersMirror = null;
let probing = null;

/** 自动模式：对官方源与镜像源测速，选出更快的作为首选 */
async function probe() {
  if (autoPrefersMirror !== null) return autoPrefersMirror;
  if (probing) return probing;
  const official = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
  const mirror = `${BMCL}/mc/game/version_manifest_v2.json`;
  const time = async (url) => {
    const t = Date.now();
    try {
      const { res, done } = await request(url, { timeout: 6000, method: 'GET' });
      done();
      if (!res.ok) return Infinity;
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return Date.now() - t;
    } catch { return Infinity; }
  };
  probing = Promise.all([time(official), time(mirror)]).then(([a, b]) => {
    autoPrefersMirror = b < a * 0.8;
    console.log(`[mirror] official=${a}ms bmclapi=${b}ms → ${autoPrefersMirror ? 'BMCLAPI' : '官方'}`);
    probing = null;
    return autoPrefersMirror;
  });
  return probing;
}

function preferMirror() {
  const src = config.get().downloadSource;
  if (src === 'bmclapi') return true;
  if (src === 'official') return false;
  return autoPrefersMirror === true;
}

/** 返回按优先级排列的候选地址（官方与镜像互为回退） */
function candidates(url) {
  if (!url) return [];
  const official = normalize(url);
  const mirror = toMirror(official);
  if (!mirror) return [official];
  return preferMirror() ? [mirror, official] : [official, mirror];
}

config.onChange((_d, patch) => {
  if (patch && 'downloadSource' in patch) autoPrefersMirror = patch.downloadSource === 'auto' ? null : autoPrefersMirror;
});

function currentSourceLabel() {
  const src = config.get().downloadSource;
  if (src === 'auto') return autoPrefersMirror === null ? '自动（测速中）' : `自动（${autoPrefersMirror ? 'BMCLAPI' : '官方'}）`;
  return src === 'bmclapi' ? 'BMCLAPI' : '官方';
}

module.exports = { candidates, toMirror, normalize, probe, preferMirror, currentSourceLabel, BMCL };
