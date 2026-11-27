'use strict';
/**
 * 有没有网（离线模式，1.8.0）：同时试几个启动器本来就要用的地址，任何一个在几秒内有响应（不管状态码）就算有网。
 * 只发 HEAD、不带任何玩家信息；渲染进程的 offline.js 断网时每分钟问一次，网络事件变化时也会问
 */
const { request } = require('./net');

const HOSTS = ['https://piston-meta.mojang.com/', 'https://bmclapi2.bangbang93.com/', 'https://api.modrinth.com/'];

async function probe() {
  // 有一个通了就够了：其余还在连的取消掉，不白占着连接
  const ctrl = new AbortController();
  const one = (url) => request(url, { method: 'HEAD', timeout: 5000, signal: ctrl.signal }).then(({ done }) => { done(); return true; });
  try {
    return await Promise.any(HOSTS.map(one));
  } catch {
    return false;
  } finally {
    ctrl.abort();
  }
}

module.exports = { probe };
