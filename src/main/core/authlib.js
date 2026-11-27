'use strict';
/**
 * authlib-injector：让游戏连接本地皮肤服务，以后的外置登录也用它。
 * 下载到 runtime/authlib-injector/，按 sha256 校验；拿不到最新版本信息时用已经下载过的。
 */
const fsp = require('fs').promises;
const path = require('path');
const paths = require('../engine/paths');
const net = require('../engine/net');
const mirrors = require('../engine/mirrors');
const { downloadFile } = require('../engine/downloader');
const { exists, hashFile } = require('../engine/util');

const OFFICIAL = 'https://authlib-injector.yushi.moe';
const MIRROR = `${mirrors.BMCL}/mirrors/authlib-injector`;
const dir = () => path.join(paths.runtimeDir(), 'authlib-injector');

async function cached() {
  let names = [];
  try { names = await fsp.readdir(dir()); } catch { return null; }
  const jars = names.filter((n) => /^authlib-injector-[\d.]+\.jar$/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return jars.length ? path.join(dir(), jars[0]) : null;
}

let checkedAt = 0;
let checkedPath = null;

/** 返回 jar 路径；一天内只检查一次更新 */
async function ensure(task) {
  if (checkedPath && Date.now() - checkedAt < 24 * 3600 * 1000 && (await exists(checkedPath))) return checkedPath;
  const old = await cached();
  let meta;
  try {
    const urls = mirrors.preferMirror() ? [`${MIRROR}/artifact/latest.json`, `${OFFICIAL}/artifact/latest.json`] : [`${OFFICIAL}/artifact/latest.json`, `${MIRROR}/artifact/latest.json`];
    meta = await net.getJson(urls, { retries: 1, timeout: 12000 });
  } catch (e) {
    if (old) { checkedPath = old; checkedAt = Date.now(); return old; }
    throw new Error(`获取 authlib-injector 失败：${e.message}`);
  }
  // 版本号来自网络、要拼进文件名：只认数字和点（和上面找旧版本的规则一样）
  if (!meta || !/^[0-9][0-9.]*$/.test(String(meta.version || '')) || !/^[0-9]+$/.test(String(meta.build_number || ''))) {
    if (old) { checkedPath = old; checkedAt = Date.now(); return old; }
    throw new Error('获取 authlib-injector 失败：版本信息不对');
  }
  const file = path.join(dir(), `authlib-injector-${meta.version}.jar`);
  const sha256 = meta.checksums && meta.checksums.sha256;
  if (!(await exists(file)) || (sha256 && (await hashFile(file, 'sha256')) !== sha256)) {
    const official = `${OFFICIAL}/artifact/${meta.build_number}/authlib-injector-${meta.version}.jar`;
    const mirror = `${MIRROR}/artifact/${meta.build_number}/authlib-injector-${meta.version}.jar`;
    if (task) task.update({ detail: `下载 authlib-injector ${meta.version}…`, progress: -1 });
    await fsp.mkdir(dir(), { recursive: true });
    try {
      await downloadFile({ urls: mirrors.preferMirror() ? [mirror, official] : [official, mirror], path: file, sha256 }, { task, label: 'authlib-injector' });
    } catch (e) {
      if (e.cancelled || !old) throw e;
      checkedPath = old; checkedAt = Date.now();
      return old;
    }
    // 只留最新的一个
    for (const n of await fsp.readdir(dir())) if (n !== path.basename(file) && /^authlib-injector-.*\.jar$/.test(n)) await fsp.rm(path.join(dir(), n), { force: true }).catch(() => {}); // pitfall-ok：旧版正被开着的游戏占着，先留着，下次再删
  }
  checkedPath = file; checkedAt = Date.now();
  return file;
}

module.exports = { ensure, cached };
