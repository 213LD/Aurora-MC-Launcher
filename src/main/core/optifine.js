'use strict';
/**
 * OptiFine：版本列表和下载走 BMCLAPI 镜像（OptiFine 官网没有可用的接口）
 * - 纯净版：OptiFine 作为「加载器」，生成继承原版的版本 JSON（launchwrapper + OptiFineTweaker）
 * - Forge / Fabric：OptiFine 的 jar 直接放进 mods（Fabric 还要 OptiFabric，由 components.js 处理）
 * 安装方式参考 HMCL 的 OptiFineInstallTask：jar 里有 optifine/Patcher 就用它对照原版客户端生成补丁后的库，
 * 没有就直接把 jar 当库；launchwrapper 优先用 jar 里自带的 launchwrapper-2.0 / launchwrapper-of
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const mirrors = require('../engine/mirrors');
const paths = require('../engine/paths');
const versions = require('./versions');
const javaMgr = require('./java');
const { getJson } = require('../engine/net');
const { downloadFile } = require('../engine/downloader');
const { withZip } = require('../engine/zip');
const { exists } = require('../engine/util');

const enc = encodeURIComponent;
const isPreview = (e) => /^pre/i.test(e.patch) || /^preview_/i.test(e.filename || '');

/** 某个 MC 版本可用的 OptiFine，新的在前，预览版排后面 */
async function list(mc) {
  const arr = await getJson(`${mirrors.BMCL}/optifine/${enc(mc)}`, { timeout: 15000 });
  return (arr || []).filter((e) => e && e.patch && e.type).map((e) => ({
    mc: e.mcversion || mc,
    type: e.type,
    patch: e.patch,
    filename: e.filename || `OptiFine_${mc}_${e.type}_${e.patch}.jar`,
    forge: e.forge && !/N\/A/i.test(e.forge) ? e.forge : '',
    preview: isPreview(e),
  })).map((e) => ({ ...e, version: `${e.type}_${e.patch}` }))
    .sort((a, b) => (a.preview - b.preview) || b.version.localeCompare(a.version, undefined, { numeric: true }));
}

/** 最适合的一个（最新的正式版） */
async function best(mc) {
  const l = await list(mc);
  return l.find((e) => !e.preview) || l[0] || null;
}

/** 下载 OptiFine 的 jar（安装器本身），返回本地路径 */
async function download(entry, task) {
  const file = path.join(paths.cacheDir(), 'installers', entry.filename);
  if (await exists(file)) {
    const ok = await withZip(file, async (z) => !!z.getEntry('optifine/OptiFineTweaker.class') || !!z.getEntry('Config.class')).catch(() => false);
    if (ok) return file;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const url = `${mirrors.BMCL}/optifine/${enc(entry.mc)}/${enc(entry.type)}/${enc(entry.patch)}`;
  await downloadFile({ urls: [url], path: file }, { task, label: entry.filename });
  return file;
}

const libPath = (name) => path.join(versions.librariesDir(), ...name);

/**
 * 生成「OptiFine 作为加载器」的版本 JSON（不写文件，id 由调用方设置）
 * 会准备好补丁后的 OptiFine 库和 launchwrapper
 */
async function buildJson(mc, entry, task) {
  await versions.ensureVanilla(mc, task);
  const jar = await download(entry, task);
  const libVer = `${mc}_${entry.type}_${entry.patch}`;
  const dest = libPath(['optifine', 'OptiFine', libVer, `OptiFine-${libVer}.jar`]);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const inner = await withZip(jar, async (z) => {
    const out = { patcher: !!z.getEntry('optifine/Patcher.class'), lw: null };
    if (z.getEntry('launchwrapper-2.0.jar')) {
      out.lw = { name: 'optifine:launchwrapper:2.0', file: libPath(['optifine', 'launchwrapper', '2.0', 'launchwrapper-2.0.jar']), data: await z.read('launchwrapper-2.0.jar') };
    } else {
      const v = ((await z.readText('launchwrapper-of.txt')) || '').trim();
      if (v && z.getEntry(`launchwrapper-of-${v}.jar`)) {
        out.lw = { name: `optifine:launchwrapper-of:${v}`, file: libPath(['optifine', 'launchwrapper-of', v, `launchwrapper-of-${v}.jar`]), data: await z.read(`launchwrapper-of-${v}.jar`) };
      }
    }
    return out;
  });

  task.update({ detail: '生成 OptiFine 库…', progress: -1 });
  if (inner.patcher) {
    const mcJson = await versions.resolveVersion(mc);
    const { java } = await javaMgr.resolveForVersion(versions.requiredJava(mcJson), {}, task);
    const { runJava } = require('./loaders');
    await runJava(java.path, ['-cp', jar, 'optifine.Patcher', versions.versionJarPath(mcJson._jarId || mc), jar, dest], paths.cacheDir(), task);
    if (!(await exists(dest))) throw new Error('OptiFine 补丁程序运行完了，但没有生成库文件');
  } else {
    await fsp.copyFile(jar, dest);
  }

  const libraries = [{ name: `optifine:OptiFine:${libVer}`, downloads: { artifact: { path: `optifine/OptiFine/${libVer}/OptiFine-${libVer}.jar`, url: '' } } }];
  if (inner.lw) {
    await fsp.mkdir(path.dirname(inner.lw.file), { recursive: true });
    await fsp.writeFile(inner.lw.file, inner.lw.data);
    const rel = path.relative(versions.librariesDir(), inner.lw.file).split(path.sep).join('/');
    libraries.push({ name: inner.lw.name, downloads: { artifact: { path: rel, url: '' } } });
  } else {
    // 很老的 OptiFine：用官方的 launchwrapper 1.12 和它需要的 asm、jopt
    libraries.push({ name: 'net.minecraft:launchwrapper:1.12' });
    libraries.push({ name: 'org.ow2.asm:asm-all:5.2', url: 'https://maven.minecraftforge.net/' });
  }

  const parent = await versions.readVersionJson(mc);
  const json = {
    inheritsFrom: mc,
    type: parent.type || 'release',
    time: new Date().toISOString(),
    releaseTime: parent.releaseTime,
    mainClass: 'net.minecraft.launchwrapper.Launch',
    libraries,
  };
  if (parent.arguments) json.arguments = { game: ['--tweakClass', 'optifine.OptiFineTweaker'], jvm: [] };
  else json.minecraftArguments = `${parent.minecraftArguments || ''} --tweakClass optifine.OptiFineTweaker`.trim();
  return json;
}

module.exports = { list, best, download, buildJson };
