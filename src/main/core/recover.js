'use strict';
/**
 * 启动时收拾上次崩溃或断电留下的半成品（2.0.0-pre8，全面测试：崩溃和断电恢复）。
 * 会动玩家文件的操作都是「先做在旁边，全好了再换」，崩溃时最多留下下面这些。这里只按名字认这些东西，别的一概不碰：
 * - replaceDir 留下的 <目录>.aurora-new-<时间> 和 <目录>.aurora-old-<时间>：
 *   目录不在、旧的在，说明换到一半，放回去；目录在、旧的也在，说明换好了，删旧的；只有新的，说明还没做完，删掉
 * - 改名改到一半：文件夹换了名字，里面的版本文件还是旧名字，配置会从列表里消失。按文件夹的名字接着改完
 * - .aurora-installing：整合包没装完就崩了（只有全新建的配置才有这个标记）。这里不动，界面问玩家删不删（先提示，见 halfPacks）
 * - 写文件用的临时文件
 * 同一个游戏目录可能有另一个启动器正开着（内部版和公开版），所以太新的不删。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../engine/config');
const versions = require('./versions');
const paths = require('../engine/paths');
const shutdown = require('../engine/shutdown');
const { exists, rmrf, writeJson, readJson, renameRetry } = require('../engine/util');

const SWAP = /^(.+)\.aurora-(new|old)-(\d+)$/;
const LEGACY = /^(.+)\.aurora-restore-(\d+)$/; // 2.0.0-pre8 之前的 replaceDir：旧目录挪到这里，然后才开始解压
const TMP_FILE = /(\.\d+\.\d{10,}\.\d+\.tmp|\.aurora-tmp-\d+-\d+)$/;
const INSTALLING = '.aurora-installing';
const ONE_MINUTE = 60 * 1000;

const readNames = (dir) => fsp.readdir(dir).catch(() => []);

async function settleSwaps(dir, maxAge, out) {
  const groups = new Map();
  for (const n of await readNames(dir)) {
    const m = SWAP.exec(n);
    if (m) {
      const key = `${m[1]}|${m[3]}`;
      groups.set(key, { base: m[1], stamp: Number(m[3]), ...(groups.get(key) || {}), [m[2]]: path.join(dir, n) });
    } else {
      const old = LEGACY.exec(n);
      // 老版本的：目录已经没了才放回去。目录还在就分不清哪份是完整的，留着不动
      if (old && !(await exists(path.join(dir, old[1])))) {
        await renameRetry(path.join(dir, n), path.join(dir, old[1])).then(() => out.restored.push(path.join(dir, old[1]))).catch(() => {});
      }
    }
  }
  for (const g of groups.values()) {
    const target = path.join(dir, g.base);
    if (g.old) {
      if (!(await exists(target))) {
        await renameRetry(g.old, target);
        out.restored.push(target);
      } else await rmrf(g.old);
    }
    if (g.new && Date.now() - g.stamp >= maxAge) {
      await rmrf(g.new);
      out.removed++;
    }
  }
}

/** 把 D 文件夹里还叫 X 的版本文件改完：X 是改名前的名字 */
async function finishRename(X, D, json) {
  const vdir = versions.versionDir(D);
  const oldJson = path.join(vdir, `${X}.json`);
  const newJson = path.join(vdir, `${D}.json`);
  if (await exists(oldJson)) await renameRetry(oldJson, newJson);
  const oldJar = path.join(vdir, `${X}.jar`);
  if (!json.jar && !json.inheritsFrom && await exists(oldJar) && !(await exists(path.join(vdir, `${D}.jar`)))) await renameRetry(oldJar, path.join(vdir, `${D}.jar`));
  json.id = D;
  if (!json.inheritsFrom && !json.clientVersion) json.clientVersion = X;
  await writeJson(newJson, json);
  for (const other of await readNames(versions.versionsDir())) {
    const p = path.join(versions.versionsDir(), other, `${other}.json`);
    const j = await readJson(p).catch(() => null);
    if (!j || j.inheritsFrom !== X) continue;
    j.inheritsFrom = D;
    if (j.jar === X) j.jar = D;
    await writeJson(p, j);
  }
  config.renameVersionSettings(X, D);
  await require('./isolation').renameSource(X, D).catch(() => {});
}

async function fixRenames(out) {
  const root = versions.versionsDir();
  const names = await readNames(root);
  for (const D of names) {
    if (D.includes('.aurora-')) {
      // 只改大小写时中转用的临时名字
      if (D.endsWith('.aurora-tmp') && !(await exists(path.join(root, D.slice(0, -'.aurora-tmp'.length))))) {
        await renameRetry(path.join(root, D), path.join(root, D.slice(0, -'.aurora-tmp'.length))).catch(() => {});
      }
      continue;
    }
    const dir = path.join(root, D);
    const own = await readJson(path.join(dir, `${D}.json`)).catch(() => null);
    let X = null;
    let json = own;
    if (own) {
      // 版本文件改好了名字，里面的 id 还没改
      if (typeof own.id === 'string' && own.id !== D && !own.id.includes('/') && !own.id.includes('\\') && !(await exists(path.join(root, own.id)))) X = own.id;
    } else {
      const list = (await readNames(dir)).filter((n) => /\.json$/i.test(n) && !/^aurora-/.test(n) && !n.includes('.aurora-'));
      const found = [];
      for (const n of list) {
        const j = await readJson(path.join(dir, n)).catch(() => null);
        const id = n.slice(0, -5);
        if (j && (j.mainClass || j.inheritsFrom) && !(await exists(path.join(root, id)))) found.push({ id, j });
      }
      if (found.length === 1) { X = found[0].id; json = found[0].j; }
    }
    if (X) {
      await finishRename(X, D, json);
      out.renamed.push(`${X} → ${D}`);
    }
  }
}

/**
 * 没装完的整合包（有 .aurora-installing 标记）。以前启动时直接删，改成先问。
 * 太新的标记可能是另一个启动器（内部版和公开版共用游戏目录时）正在装，不算
 */
async function halfPacks({ minAge = ONE_MINUTE } = {}) {
  const out = [];
  for (const id of await readNames(versions.versionsDir())) {
    if (id.includes('.aurora-')) continue;
    const st = await fsp.stat(path.join(versions.versionDir(id), INSTALLING)).catch(() => null);
    if (st && Date.now() - st.mtimeMs >= minAge && !installingHere.has(id)) out.push(id);
  }
  return out;
}

/** 玩家选了：remove 删掉（进回收站，重装就好），removePermanent 没有回收站时确认过的永久删除，keep 留着（去掉标记，以后当普通配置，不再问） */
async function resolveHalfPack(id, action) {
  const ids = await halfPacks({ minAge: 0 });
  if (!ids.includes(id)) return false;
  if (action === 'remove' || action === 'removePermanent') await versions.removeVersion(id, { permanent: action === 'removePermanent' });
  else await fsp.rm(path.join(versions.versionDir(id), INSTALLING), { force: true });
  return true;
}

// 这次运行里正在装的整合包（modpack.js 记），不能问玩家要不要删
const installingHere = new Set();

async function sweepTemp(dir, maxAge, out) {
  for (const n of await readNames(dir)) {
    if (!TMP_FILE.test(n)) continue;
    const p = path.join(dir, n);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.isFile() && Date.now() - st.mtimeMs >= maxAge) {
      await fsp.rm(p, { force: true }).catch(() => {});
      out.removed++;
    }
  }
}

/**
 * 启动时记一笔，正常退出时擦掉。下次启动看到这个标记，就是上次没有正常退出（崩溃、断电、被杀）。
 * 只有这时才值得在开窗口之前收拾：配置很多时全扫一遍要读每个版本文件，不能让每次启动都等这个
 */
function markRunning() {
  const flag = path.join(paths.dataDir(), '.aurora-running');
  let dirty = false;
  try {
    dirty = fs.existsSync(flag);
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, String(process.pid));
  } catch { /* 记不了就当正常 */ }
  shutdown.onQuit(() => fsp.rm(flag, { force: true }).catch(() => {}));
  return dirty;
}

/** maxAge：比这新的半成品可能是别的启动器正在做的，不删 */
async function run({ maxAge = 10 * ONE_MINUTE } = {}) {
  const out = { restored: [], renamed: [], removed: 0 };
  const root = versions.gameRoot();
  if (!root || !(await exists(root))) return out;
  const step = async (fn) => { try { await fn(); } catch (e) { console.warn('[recover]', e.message); } };
  await step(() => fixRenames(out));
  const vroot = versions.versionsDir();
  const dirs = [root, path.join(root, 'saves'), vroot];
  for (const id of await readNames(vroot)) {
    if (id.includes('.aurora-')) continue;
    dirs.push(path.join(vroot, id), path.join(vroot, id, 'saves'));
  }
  for (const d of dirs) {
    await step(() => settleSwaps(d, Math.min(maxAge, ONE_MINUTE), out));
    await step(() => sweepTemp(d, maxAge, out));
  }
  await step(() => sweepTemp(paths.dataDir(), maxAge, out));
  await step(() => sweepTemp(path.join(paths.dataDir(), 'skins', 'library'), maxAge, out));
  if (out.restored.length || out.renamed.length) console.warn('[recover] 上次没做完的已经收拾好', JSON.stringify(out));
  return out;
}

module.exports = { run, markRunning, INSTALLING, halfPacks, resolveHalfPack, installingHere };
