'use strict';
/**
 * Minecraft 官方的更新日志（主页更新日志面板的「Minecraft」标签）：读 Mojang 的补丁说明，带本地缓存。
 */
const path = require('path');
const paths = require('../engine/paths');
const { getJson } = require('../engine/net');
const { readJson, writeJson } = require('../engine/util');

const BASE = 'https://launchercontent.mojang.com';

const abs = (u) => (!u ? '' : /^https?:/.test(u) ? u : `${BASE}${u.startsWith('/') ? '' : '/'}${u}`);

/** 官方 Java 版更新日志（与官方启动器同源） */
async function patchNotes(limit = 8) {
  const cache = path.join(paths.cacheDir(), 'patch_notes.json');
  let data;
  try {
    data = await getJson(`${BASE}/v2/javaPatchNotes.json`, { timeout: 12000 });
    writeJson(cache, data, false).catch(() => {});
  } catch (e) {
    data = await readJson(cache);
    if (!data) throw e;
  }
  return (data.entries || []).slice(0, limit).map((e) => ({
    id: e.id,
    title: e.title,
    version: e.version,
    type: e.type,
    date: e.date,
    image: abs(e.image && e.image.url),
    summary: e.shortText || '',
    contentPath: e.contentPath,
  }));
}

async function patchNoteBody(contentPath) {
  if (!/^[\w\-/.]+$/.test(contentPath || '')) throw new Error('无效的路径');
  const j = await getJson(`${BASE}/v2/${contentPath}`, { timeout: 12000 });
  return { title: j.title, version: j.version, body: j.body || '', image: abs(j.image && j.image.url) };
}

module.exports = { patchNotes, patchNoteBody };
