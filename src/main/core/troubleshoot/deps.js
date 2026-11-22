'use strict';
/** 按 Mod id 找项目、安装前置 */
const versions = require('../versions');
const mods = require('../mods');
const modrinth = require('../modrinth');
const path = require('path');
const { nm } = require('../../../shared/i18n');
const { ID_ALIAS, modLabel, rangeText, versionInRanges } = require('./compat');
const { findByModId } = require('./log');

async function findProjectForModId(modId, { loader, mc }) {
  const cands = [ID_ALIAS[modId], ID_ALIAS[modId.toLowerCase()], modId, modId.replace(/_/g, '-'), modId.toLowerCase()].filter(Boolean);
  for (const c of [...new Set(cands)]) {
    try {
      const p = await modrinth.project(c);
      if (p && p.type === 'mod') {
        const v = modrinth.bestVersion(await modrinth.projectVersions(p.id, { loader, gameVersion: mc }));
        if (v) return { project: p, version: v };
      }
    } catch { /* 继续尝试 */ }
  }
  const r = await modrinth.search({ query: modId.replace(/[_-]/g, ' '), type: 'mod', loader, gameVersion: mc, limit: 5 });
  for (const p of r.hits) {
    const v = modrinth.bestVersion(await modrinth.projectVersions(p.id, { loader, gameVersion: mc }));
    if (v) return { project: p, version: v };
  }
  return null;
}

/**
 * 安装前置。opts.ranges：要符合的版本范围（从 jar 声明 / 加载器日志来），按 jar 里的真实版本号挑；
 * opts.update：已经装了旧的，装好新的后把旧的禁用（1.5.10：以前直接再装一个最新版，变成重复的 Mod，最新版也不一定符合范围）
 */
async function installDep(versionId, modId, task, { ranges = null, rangeKind = 'semver', update = false } = {}) {
  const info = await versions.versionInfo(versionId);
  const loader = info.loader && info.loader.type;
  task.update({ detail: `在 Modrinth 上查找 ${nm(modId)}…`, progress: -1 });
  const found = await findProjectForModId(modId, { loader, mc: info.mcVersion });
  if (!found) throw new Error(`没有在 Modrinth 上找到适用于 ${nm(info.mcVersion)} 的 ${nm(modId)}，请手动安装`);
  let version = found.version;
  if (ranges && ranges.length) {
    const jarcheck = require('../jarcheck');
    const all = (await modrinth.projectVersions(found.project.id, { loader, gameVersion: info.mcVersion }))
      .sort((a, b) => (a.type === 'release' ? 0 : 1) - (b.type === 'release' ? 0 : 1)).slice(0, 40);
    // 符合范围的版本里，挑和已装的其他 Mod 冲突最少的（一样少取靠前的：正式版、新的）。
    // 只取最新的不行：Iris 要 Sodium 0.6.x，0.6.13 又挡着 BetterEnd
    const others = (await mods.listMods(versionId)).mods
      .filter((m) => m.enabled && !(m.ids || []).some((i) => i.toLowerCase() === modId.toLowerCase()))
      .map((m) => ({ key: m.path, title: modLabel(m), meta: m }));
    let best = null;
    for (const v of all) {
      task.update({ detail: `查找合适的 ${nm(found.project.title)} 版本：${nm(v.number)}` });
      const file = v.files.find((f) => f.primary) || v.files[0];
      const meta = file ? await jarcheck.remoteMeta(file).catch(() => null) : null;
      if (!meta || !meta.version || !versionInRanges(ranges, meta.version, rangeKind)) continue;
      const n = jarcheck.violations([...others, { key: 'candidate', title: found.project.title, meta }], loader, info.mcVersion).length;
      if (!best || n < best.n) best = { v, n };
      if (n === 0) break;
    }
    if (!best) throw new Error(`没有找到符合要求（${rangeText(ranges)}）的 ${nm(found.project.title)}，请手动处理`);
    version = best.v;
  }
  const old = update ? findByModId((await mods.listMods(versionId)).mods.filter((m) => m.enabled), modId) : [];
  const files = await mods.installProjectVersion({ versionId, projectVersion: version, kind: 'mod', withDeps: true }, task);
  const disabled = [];
  for (const m of old) {
    if (files.some((f) => path.basename(f) === m.file)) continue;
    disabled.push({ from: m.path, to: await mods.toggleMod(m.path, false), file: m.file });
  }
  return { title: found.project.title, version: version.number, files, disabled };
}

module.exports = { installDep };
