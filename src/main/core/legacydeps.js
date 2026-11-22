'use strict';
/**
 * 旧版 Mod 的运行时依赖补全
 * 1.6 ~ 1.7 时代的 CodeChickenCore 等会在启动时从 files.minecraftforge.net 下载 CodeChickenLib，
 * 该地址早已失效。启动前读取 jar 内的 dependancies.info，从仍可用的 maven 预先放到 mods/<mc>/。
 */
const fsp = require('fs').promises;
const path = require('path');
const { withZip } = require('../engine/zip');
const { downloadFile } = require('../engine/downloader');
const { exists } = require('../engine/util');

const MAVENS = [
  'https://maven.covers1624.net/',
  'https://maven.minecraftforge.net/',
  'https://bmclapi2.bangbang93.com/maven/',
];

/** 已知的库 → maven 坐标（group/artifact） */
const ARTIFACTS = { 'codechicken.lib': ['codechicken', 'CodeChickenLib'] };

async function readDeps(jar) {
  try {
    return await withZip(jar, async (z) => {
      const text = await z.readText('dependancies.info') || await z.readText('dependencies.info');
      if (!text) return [];
      const j = JSON.parse(text);
      return Array.isArray(j) ? j : [j];
    });
  } catch {
    return [];
  }
}

const fill = (s, d) => String(s || '').replace(/@MCVERSION@/g, d.mcversion).replace(/@VERSION@/g, d.version);

/** 返回给启动日志的说明；无法补全时 problems 中给出手动处理办法 */
async function prepare(gameDir, mc, task) {
  const modsDir = path.join(gameDir, 'mods');
  let names;
  try { names = await fsp.readdir(modsDir); } catch { return { notes: [], problems: [] }; }
  const jars = names.filter((n) => /\.(jar|zip)$/i.test(n));
  const notes = [];
  const problems = [];
  const seen = new Set();
  for (const n of jars) {
    for (const d of await readDeps(path.join(modsDir, n))) {
      if (!d || !d.file || !d.version || !d.class) continue;
      const mcv = d.mcversion || mc;
      const dep = { ...d, mcversion: mcv };
      const file = fill(d.file, dep);
      if (seen.has(file)) continue;
      seen.add(file);
      const dir = path.join(modsDir, mcv);
      // DepLoader 会在 mods/ 与 mods/<mc>/ 中查找同名或同库的文件
      const present = jars.includes(file) || (await exists(path.join(dir, file)))
        || (await fsp.readdir(dir).catch(() => [])).some((x) => x.startsWith(file.split('-')[0]));
      if (present) continue;
      const pkg = d.class.split('.').slice(0, 2).join('.');
      const art = ARTIFACTS[pkg];
      const label = `${art ? art[1] : file} ${mcv}-${d.version}`;
      if (!art) { problems.push(`${n} 需要 ${file}，请手动放入 mods/${mcv}/`); continue; }
      const coord = `${mcv}-${d.version}`;
      const urls = MAVENS.map((m) => `${m}${art[0]}/${art[1]}/${coord}/${art[1]}-${coord}-universal.jar`);
      try {
        await fsp.mkdir(dir, { recursive: true });
        await downloadFile({ urls, path: path.join(dir, file) }, { task, label: `下载 ${label}` });
        notes.push(`已补全 ${label}`);
      } catch {
        problems.push(`${n} 需要的 ${label} 已没有可用下载源，请手动将 ${file} 放入 mods/${mcv}/`);
      }
    }
  }
  return { notes, problems };
}

module.exports = { prepare };
