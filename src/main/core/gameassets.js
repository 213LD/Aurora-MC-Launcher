'use strict';
/**
 * 从玩家已经装好的游戏文件里读东西给主页背景用（1.5.16）：不把 Mojang 的资源打包进启动器
 * - endPoem()：终末之诗（client jar 里的 assets/minecraft/texts/end.txt，Java 版只有英文）
 * - sound(event)：原版音效（资源索引里的 minecraft/sounds.json → 对应的 .ogg），点紫水晶、末影龙死亡这些用
 * 没装游戏、资源没下载时返回 null，界面那边用自己的替代（自带的英文原文 / 合成的声音 / 不出声）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const versions = require('./versions');
const { withZip } = require('../engine/zip');

/** 已安装的版本按发布时间从新到旧，读第一个能读到的 end.txt */
async function endPoem() {
  const list = (await versions.listInstalled()).filter((v) => !v.broken)
    .sort((a, b) => String(b.releaseTime || '').localeCompare(String(a.releaseTime || '')));
  const tried = new Set();
  for (const v of list) {
    for (const id of [v.id, v.inheritsFrom].filter(Boolean)) {
      if (tried.has(id)) continue;
      tried.add(id);
      const jar = versions.versionJarPath(id);
      if (!fs.existsSync(jar)) continue;
      try {
        const text = await withZip(jar, (z) => z.readText('assets/minecraft/texts/end.txt'));
        if (text && text.length > 1000) return { text, version: id };
      } catch { /* 坏掉的 jar：试下一个 */ }
    }
  }
  return null;
}

// 资源索引和 sounds.json 读一次就记住（换了游戏目录会对不上，按目录记）
let cache = null;
async function soundIndex() {
  const dir = versions.assetsDir();
  if (cache && cache.dir === dir) return cache;
  cache = { dir, objects: null, sounds: null };
  let files = [];
  try { files = await fsp.readdir(path.join(dir, 'indexes')); } catch { return cache; }
  const stats = await Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => {
    const p = path.join(dir, 'indexes', f);
    try { return { p, t: (await fsp.stat(p)).mtimeMs }; } catch { return null; }
  }));
  for (const s of stats.filter(Boolean).sort((a, b) => b.t - a.t)) {
    try {
      const idx = JSON.parse(await fsp.readFile(s.p, 'utf8'));
      const obj = idx.objects && idx.objects['minecraft/sounds.json'];
      if (!obj) continue;
      const sounds = JSON.parse(await fsp.readFile(objectPath(dir, obj.hash), 'utf8'));
      cache.objects = idx.objects; cache.sounds = sounds;
      break;
    } catch { /* 这个索引不完整：试下一个 */ }
  }
  return cache;
}

const objectPath = (dir, hash) => path.join(dir, 'objects', hash.slice(0, 2), hash);

/** 原版音效：随机挑一个变体，返回 { data: base64 的 ogg, volume, pitch }；没有返回 null */
async function sound(event) {
  const { dir, objects, sounds } = await soundIndex();
  if (!sounds) return null;
  let def = sounds[event];
  for (let hop = 0; def && hop < 3; hop++) {
    const list = def.sounds || [];
    if (!list.length) return null;
    const pick = list[Math.floor(Math.random() * list.length)];
    const s = typeof pick === 'string' ? { name: pick } : pick;
    if (s.type === 'event') { def = sounds[s.name.replace(/^minecraft:/, '')]; continue; }
    const name = s.name.replace(/^minecraft:/, '');
    const obj = objects[`minecraft/sounds/${name}.ogg`];
    if (!obj) return null;
    try {
      const buf = await fsp.readFile(objectPath(dir, obj.hash));
      return { data: buf.toString('base64'), volume: s.volume || 1, pitch: s.pitch || 1, name };
    } catch { return null; }
  }
  return null;
}

module.exports = { endPoem, sound };
