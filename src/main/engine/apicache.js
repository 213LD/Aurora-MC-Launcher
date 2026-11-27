'use strict';
/**
 * Modrinth / CurseForge 接口结果的缓存（1.4.30）：内存 + 磁盘（<数据目录>/cache/api/<来源>/<key 的 sha1>.json）
 * - 没过期（ttl，调用方决定）直接用；过期了重新请求，请求失败（断网、接口出错）时退回旧的结果
 * - 磁盘上超过 30 天的条目、或者总大小超过上限时从旧的删
 * Mod 图标、截图这些图片由 Chromium 自己的 HTTP 缓存保存（设置页一起显示和清除）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { rmrf } = require('./util');
const { writeFileSafe } = require('./fileops');

const MAX_AGE = 30 * 24 * 3600 * 1000;
const MAX_BYTES = 200 * 1024 * 1024;
const mem = new Map();
const root = () => path.join(paths.cacheDir(), 'api');
const fileOf = (ns, key) => path.join(root(), ns, `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
let pruned = false;

async function readDisk(ns, key) {
  try {
    const d = JSON.parse(await fsp.readFile(fileOf(ns, key), 'utf8'));
    return d && d.k === key ? d : null;
  } catch { return null; }
}

function writeDisk(ns, key, entry) {
  const f = fileOf(ns, key);
  // 先写临时文件再换上去：写到一半退出，下次读到的不会是半截 JSON
  writeFileSafe(f, JSON.stringify({ k: key, t: entry.t, v: entry.v })).catch(() => {});
  if (!pruned) { pruned = true; setTimeout(() => prune().catch(() => {}), 30000); }
}

/** 取缓存，没有或过期就调用 fn 拿新的 */
async function get(ns, key, fn, ttl) {
  const mk = `${ns}|${key}`;
  let hit = mem.get(mk);
  if (!hit) {
    hit = await readDisk(ns, key);
    if (hit) mem.set(mk, hit);
  }
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  try {
    const v = await fn();
    const entry = { t: Date.now(), v };
    mem.set(mk, entry);
    if (mem.size > 3000) for (const k of [...mem.keys()].slice(0, 800)) mem.delete(k);
    writeDisk(ns, key, entry);
    return v;
  } catch (e) {
    if (hit && !e.cancelled) return hit.v; // 断网时先用旧的
    throw e;
  }
}

async function listFiles() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(root()); } catch { return out; }
  for (const d of dirs) {
    let names = [];
    try { names = await fsp.readdir(path.join(root(), d)); } catch { continue; }
    for (const n of names) {
      const f = path.join(root(), d, n);
      const st = await fsp.stat(f).catch(() => null);
      if (st && st.isFile()) out.push({ f, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

/** 删掉太旧的，总大小超过上限时从旧的删 */
async function prune() {
  const files = (await listFiles()).sort((a, b) => a.mtime - b.mtime);
  let total = files.reduce((a, x) => a + x.size, 0);
  for (const x of files) {
    if (Date.now() - x.mtime < MAX_AGE && total <= MAX_BYTES) break;
    await fsp.unlink(x.f).catch(() => {});
    total -= x.size;
  }
}

async function usage() {
  const files = await listFiles();
  return { files: files.length, bytes: files.reduce((a, x) => a + x.size, 0) };
}

async function clear() {
  mem.clear();
  await rmrf(root());
}

/** 只清内存（切换 CurseForge 设置等情况） */
function forget(ns) {
  for (const k of [...mem.keys()]) if (!ns || k.startsWith(`${ns}|`)) mem.delete(k);
}

module.exports = { get, usage, clear, prune, forget };
