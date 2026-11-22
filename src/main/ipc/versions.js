'use strict';
/** IPC：版本的安装、补全、删除、改名，加载器，组件管理 */
const fsp = require('fs').promises;

const config = require('../engine/config');
const tasks = require('../engine/tasks');
const versions = require('../core/versions');
const loaders = require('../core/loaders');
const launcher = require('../core/launcher');
const mods = require('../core/mods');
const profiles = require('../core/profiles');
const planner = require('../core/planner');
const isolation = require('../core/isolation');
const saves = require('../core/saves');
const components = require('../core/components');
const gamelock = require('../core/gamelock');
const { safeJoin } = require('../engine/fileops');
const { handle, send, startTask, installGuard } = require('./bus');
const { nm, msg, join } = require('../../shared/i18n');

function register() {
  // ── 版本 ──
  handle('versions:manifest', (force) => versions.getManifest(!!force));
  handle('versions:installed', () => versions.listInstalled());
  handle('versions:install', (opts) => {
    const name = (opts.name || opts.mc).trim();
    versions.validateName(name);
    const label = opts.loader && opts.loader.type ? `${opts.mc} · ${loaderName(opts.loader.type)} ${opts.loader.version}` : opts.mc;
    return startTask(`安装 ${nm(name)}`, { kind: 'install', lock: name, meta: { name, label }, dir: versions.versionDir(name), doneText: '安装完成', failTitle: `安装 ${nm(name)} 失败` }, async (task) => {
      const undo = await installGuard(name);
      try {
        await loaders.install(opts, task);
        const type = opts.profileType || (opts.loader && opts.loader.type ? 'custom' : 'vanilla');
        if (opts.asProfile || opts.isolation) await profiles.markProfile(name, type, opts.profileName ? { name: opts.profileName } : {});
        else await profiles.writeMeta(name, { type });
        if (opts.nostalgia) await profiles.writeMeta(name, { nostalgia: opts.nostalgia });
        if (opts.isolation) await isolation.setPolicy(name, opts.isolation);
        if ((opts.extraProjects && opts.extraProjects.length) || (opts.localFiles && opts.localFiles.length)) {
          await planner.addExtras(name, opts, task);
        }
        if (opts.fabricApi && opts.loader && ['fabric', 'quilt', 'legacyfabric'].includes(opts.loader.type)) {
          task.update({ detail: '安装 Fabric API…', progress: -1 });
          try { await mods.installFabricApi(name, task); } catch (e) { if (e.cancelled) throw e; console.warn('Fabric API 安装失败', e.message); }
        }
      } catch (e) {
        await undo();
        throw e;
      }
      return name;
    }, (err) => {
      send('versions:changed');
      if (!err) send('notify', { level: 'ok', title: '安装完成', text: `${nm(name)} 已安装，可以开始游戏了`, version: name, autoDebug: !!(opts.autoDebug && opts.loader) });
    });
  });
  handle('versions:complete', (id) => startTask(`补全 ${nm(id)}`, { kind: 'complete', lock: id, meta: { name: id }, doneText: '文件完整', failTitle: `补全 ${nm(id)} 失败` }, (task) => versions.completeVersion(id, task, { verify: 'hash' }), (err) => {
    if (!err) send('notify', { level: 'ok', title: '补全完成', text: `${nm(id)} 的游戏文件已校验完整` });
  }));
  // 删除前给确认框用：会受影响的存档、共享关系；删除前的简单备份
  handle('versions:removeInfo', async (id) => {
    const game = await gamelock.forVersion(id);
    return { ...(await saves.removeInfo(id)), running: game ? game.versionId : null };
  });
  handle('profiles:backupSaves', async (id) => { await gamelock.assertVersion(id, '备份存档'); return saves.backupSaves(id); });
  handle('versions:remove', async (id, opts = {}) => {
    tasks.assertFree(id);
    await gamelock.assertVersion(id, '删除');
    // 先断开共享联接，确保删除时不会波及共享目标；没删成（文件被占着等）就按原来的策略接回去
    await isolation.detachAll(versions.versionDir(id)).catch(() => {});
    try {
      await versions.removeVersion(id, { permanent: !!opts.permanent });
    } catch (e) {
      const info = await versions.versionInfo(id).catch(() => null);
      if (info) await isolation.prepare(id, versions.gameDirFor(id, info), { allowCopy: false }).catch(() => {});
      throw e;
    }
    await isolation.dropSource(id).catch(() => {});
    send('versions:changed');
  });
  handle('versions:rename', async (oldId, newId) => {
    tasks.assertFree(oldId);
    await gamelock.assertVersion(oldId, '重命名');
    await versions.renameVersion(oldId, newId);
    await isolation.renameSource(oldId, newId).catch(() => {});
    send('versions:changed');
    return newId;
  });
  handle('versions:settings', (id) => config.getVersionSettings(id));
  handle('versions:setSettings', (id, s) => config.setVersionSettings(id, s));
  handle('versions:dir', async (id, sub) => {
    // 不带配置名 + 'version'：放着所有配置的 versions 文件夹（游戏配置页顶上的「打开版本文件夹」）。
    // 2.0.0-pre2 起配置名要过一遍路径检查，空名字过不去，那个按钮从那时起一点就报「配置名里有不安全的路径」（rc11 按钮走查发现）
    if (!id && sub === 'version') { const root = versions.versionsDir(); await fsp.mkdir(root, { recursive: true }); return root; }
    const info = await versions.versionInfo(id);
    const base = sub === 'version' ? versions.versionDir(id) : versions.gameDirFor(id, info);
    const p = sub && sub !== 'version' ? safeJoin(base, sub, '文件夹') : base;
    await fsp.mkdir(p, { recursive: true });
    return p;
  });
  handle('versions:memory', async (id) => {
    const info = id ? await versions.versionInfo(id) : null;
    return { auto: launcher.autoMemory(!!(info && info.loader)), effective: launcher.memoryFor(id || '', info) };
  });
  // ── 加载器 ──
  handle('loaders:list', (type, mc) => loaders.list(type, mc));
  // ── 组件管理 ──
  const compTask = (id, title, fn, done) => startTask(title, { kind: 'component', lock: id, meta: { name: id }, doneText: done || '已完成', failTitle: `${title}失败` }, fn, (err, r) => {
    send('versions:changed'); send('mods:changed', id);
    if (!err) send('notify', { level: r && ((r.failed && r.failed.length) || (r.undoFailed && r.undoFailed.length)) ? 'warn' : 'ok', title: `${title}完成`, text: compSummary(r), version: id, component: { id, ts: r && r.ts } });
  });
  const compSummary = (r) => {
    if (!r) return '';
    const parts = [];
    if (r.replaced) parts.push(msg('换了 {n} 个 Mod 的版本', { n: r.replaced }));
    if (r.disabledAll) parts.push(msg('Mod 已全部禁用'));
    else if (r.disabled) parts.push(msg('禁用了 {n} 个找不到新版本的 Mod', { n: r.disabled }));
    if (r.failed && r.failed.length) parts.push(msg('{n} 个 Mod 处理失败，已禁用', { n: r.failed.length }));
    if (r.undoFailed && r.undoFailed.length) parts.push(msg('{n} 个文件没还原成（可能正被占着）：{list}', { n: r.undoFailed.length, list: r.undoFailed.slice(0, 3).map(nm) }));
    if (r.installed) parts.push(msg('已安装 {list}', { list: r.installed.map(nm) }));
    if (r.updated === false) parts.push(msg('已经是最新版'));
    else if (r.version) parts.push(msg('更新到 {v}', { v: nm(r.version) }));
    return join(parts, 'comma') || msg('可以开始游戏了');
  };
  handle('components:info', (id) => components.info(id));
  handle('components:plan', (id, target) => components.plan(id, target));
  handle('components:optifineList', (mc) => components.optifineList(mc));
  handle('components:apply', (id, target, plan, label) => compTask(id, label || `修改 ${id} 的组件`, (task) => components.apply(id, target, plan, task, { label })));
  handle('components:undo', (id, ts) => compTask(id, `撤销 ${id} 的组件修改`, (task) => components.undo(id, ts, task), '已撤销'));
  handle('components:installApi', (id) => compTask(id, `给 ${id} 安装 Fabric API`, async (task) => ({ installed: await components.installApi(id, task) })));
  handle('components:installShader', (id) => compTask(id, `给 ${id} 安装光影加载器`, async (task) => ({ installed: await components.installShader(id, task) })));
  handle('components:installOptifine', (id, entry) => compTask(id, `给 ${id} 安装 OptiFine`, (task) => components.installOptifine(id, entry, task)));
  handle('components:removeOptifine', (id) => compTask(id, `卸载 ${id} 的 OptiFine`, (task) => components.removeOptifine(id, task)));
  handle('components:updateMod', (id, file) => compTask(id, `更新 ${id} 的组件`, (task) => components.updateMod(id, file, task)));
  handle('components:removeMod', async (id, file) => { await components.removeMod(id, file); send('mods:changed', id); send('versions:changed'); });
}

function loaderName(t) {
  return { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[t] || t;
}

module.exports = register;
