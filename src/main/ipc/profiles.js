'use strict';
/** IPC：游戏配置、存档隔离、整合包 */
const path = require('path');
const { shell, dialog } = require('electron');

const tasks = require('../engine/tasks');
const versions = require('../core/versions');
const profiles = require('../core/profiles');
const modpack = require('../core/modpack');
const planner = require('../core/planner');
const isolation = require('../core/isolation');
const curseforge = require('../core/curseforge');
const gamelock = require('../core/gamelock');
const { under } = require('../engine/fileops');
const { nm } = require('../../shared/i18n');
const { safeName } = require('../../shared/pathrules');
const { t } = require('../../shared/i18n');
const { handle, send, getWin, startTask, manualNote } = require('./bus');

function register() {
  // ── 游戏配置与整合包 ──
  handle('profiles:list', () => profiles.list());
  // 上次没装完的整合包：界面问玩家删掉还是留着（以前是启动时直接删）
  const recover = require('../core/recover');
  handle('profiles:halfPacks', () => recover.halfPacks());
  handle('profiles:resolveHalfPack', async (id, action) => {
    if (typeof id !== 'string' || !['remove', 'removePermanent', 'keep'].includes(action)) throw new Error('参数不对');
    if (action !== 'keep') await gamelock.assertVersion(id, '删除');
    const ok = await recover.resolveHalfPack(id, action);
    if (ok) send('versions:changed');
    return ok;
  });
  handle('profiles:setMeta', async (id, patch) => {
    const allowed = {};
    for (const k of ['name', 'description', 'type', 'icon']) if (patch && k in patch) allowed[k] = patch[k];
    const r = await profiles.writeMeta(id, allowed);
    send('versions:changed');
    return r;
  });
  handle('profiles:duplicate', async (id, name, opts = {}) => {
    await gamelock.assertVersion(id, '复制');
    const r = await profiles.duplicate(id, name, opts);
    // 复制出来的配置：按要求设置隔离策略（例如以原配置的存档作为测试副本）
    if (opts.isolation) await isolation.setPolicy(r, opts.isolation);
    else if ((await profiles.readMeta(id)).isolation) {
      // 原配置选过隔离才照搬；没选过的（比如纯原版用公共目录）副本也不变（setPolicy 会让配置用自己的目录）
      await isolation.setPolicy(r, await isolation.getPolicy(id)).catch(() => {});
    }
    send('versions:changed');
    return r;
  });
  handle('profiles:detail', (id) => profiles.detail(id));
  handle('profiles:openLog', async (file) => {
    if (typeof file !== 'string' || !/\.(log|txt|gz)$/i.test(file) || !under(file, versions.versionsDir())) throw new Error('无效的路径');
    return shell.openPath(file);
  });

  // ── 存档 / 配置隔离 ──
  handle('isolation:get', (id) => isolation.getPolicy(id));
  handle('isolation:set', async (id, policy) => {
    if (typeof id === 'string' && require('../engine/config').getVersionSettings(id).customGameDir) throw new Error('这个配置直接用原来启动器的文件夹，不能改存档方式。想单独一份的话，删掉它，重新用「复制」的方式导入');
    tasks.assertFree(id); await gamelock.assertVersion(id, '切换存档与隔离'); const r = await isolation.setPolicy(id, policy); send('versions:changed'); return r; });
  // 公共目录的配置改成独立：先问带不带世界（1.10.9，core/isoworlds.js）
  handle('isolation:bringInfo', async (id, policy) => { await gamelock.assertVersion(id, '切换存档与隔离'); return require('../core/isoworlds').info(id, policy); });
  handle('isolation:bringWorlds', async (id, policy, names) => {
    return tasks.run({ title: `把公共目录的内容复制到 ${nm(id)}`, kind: 'backup', lock: id, meta: { name: id, bring: true }, doneText: '已改成独立存档' }, async (task) => {
      const r = await require('../core/isoworlds').bring(id, policy, names, task);
      send('versions:changed');
      send('mods:changed', id);
      return r;
    });
  });
  // 全局设置「独立游戏目录」（1.10.10）：改之前列出会搬走和回到公共目录的配置
  handle('isolation:globalInfo', (mode) => require('../core/isoworlds').globalInfo(mode));
  handle('isolation:globalApply', async (mode, sel) => {
    const iso = require('../core/isoworlds');
    const now = await iso.globalInfo(mode);
    const ids = [...now.outgoing, ...now.incoming].map((x) => x.id);
    ids.forEach(tasks.assertFree);
    if (!sel || !sel.target) { const r = await iso.globalApply(mode, null, null); send('versions:changed'); return r; }
    return tasks.run({ title: `把公共目录的内容复制到 ${sel.target}`, kind: 'backup', lock: ids, meta: { name: sel.target, bring: true }, doneText: '设置已保存' }, async (task) => {
      const r = await iso.globalApply(mode, sel, task);
      send('versions:changed');
      send('mods:changed', sel.target);
      return r;
    });
  });
  handle('isolation:worlds', (source, selfId) => isolation.worldsOf(source, selfId));
  // 测试副本 / 共享 → 转为正式配置（1.5.8）
  handle('isolation:promoteInfo', (id) => require('../core/promote').info(id));
  handle('isolation:promote', (id, opts) => tasks.run({ title: `把 ${nm(id)} 转为正式配置`, kind: 'install', meta: { name: id }, doneText: '已转为正式配置' }, async (task) => { const r = await require('../core/promote').promote(id, opts || {}, task); send('versions:changed'); return r; }));
  handle('backup:importWorlds', (id, fromId, worlds) => tasks.run({ title: `把存档导入 ${nm(id)}`, kind: 'backup', meta: { name: id }, doneText: '存档已导入' }, async (task) => { const r = await require('../core/worldimport').importWorlds(id, fromId, worlds, task); send('versions:changed'); return r; }));
  handle('modpack:read', (file) => modpack.readMrpack(file));
  const withExtras = (extras) => async (id, task) => {
    try {
      if (extras && ((extras.extraProjects && extras.extraProjects.length) || (extras.localFiles && extras.localFiles.length))) {
        await planner.addExtras(id, extras, task);
      }
      if (extras && extras.isolation) await isolation.setPolicy(id, extras.isolation);
    } catch (e) {
      // 整合包是这次新建的，附加内容没装上就不留半个（2.0.0-pre3），重试时名字也不会变
      await modpack.discard(id);
      throw e;
    }
    return id;
  };
  handle('modpack:installFile', (file, name, extras) => {
    let manual = [];
    return startTask('安装整合包', { kind: 'install', meta: { name: name || path.basename(file) }, doneText: '安装完成', failTitle: '整合包安装失败' },
      async (task) => withExtras(extras)(await modpack.installMrpack(file, { name, onManual: (m) => { manual = m; } }, task), task),
      (err, id) => { modpackDone(err, id); if (!err) manualNote(id, manual); });
  });
  handle('modpack:installModrinth', (params) => startTask(`安装整合包 ${nm(params.title) || ''}`, { kind: 'install', meta: { name: params.name || params.title }, doneText: '安装完成', failTitle: '整合包安装失败' },
    async (task) => withExtras(params.extras)(await modpack.installFromModrinth(params, task), task), (err, id) => modpackDone(err, id)));
  handle('modpack:installCurseforge', (params) => {
    let manual = [];
    return startTask(`安装整合包 ${nm(params.title) || ''}`, { kind: 'install', meta: { name: params.name || params.title }, doneText: '安装完成', failTitle: '整合包安装失败' },
      async (task) => withExtras(params.extras)(await curseforge.installModpack({ ...params, onManual: (m) => { manual = m; } }, task), task),
      (err, id) => { modpackDone(err, id); if (!err) manualNote(id, manual); });
  });
  handle('modpack:export', async (id, opts = {}) => {
    const ext = opts.aurora ? 'aurora' : 'mrpack';
    const r = await dialog.showSaveDialog(getWin(), {
      title: opts.aurora ? t('term.exportArchive') : t('term.exportMrpack'),
      defaultPath: `${safeName(opts.name || id, { max: 80 })}.${ext}`,
      filters: [opts.aurora ? { name: t('term.archive'), extensions: ['aurora'] } : { name: 'Modrinth 整合包', extensions: ['mrpack'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return startTask(`导出 ${nm(id)}`, { kind: 'export', meta: { name: id }, doneText: '导出完成', failTitle: '导出失败' }, (task) => modpack.exportMrpack(id, r.filePath, opts, task), (err, res) => {
      if (!err) send('notify', { level: 'ok', title: '整合包已导出', text: `${res.modrinth} 个 Mod 以 Modrinth 链接引用，${res.bundled} 个打包在文件内`, path: res.file });
    });
  });
}

function modpackDone(err, id) {
  send('versions:changed');
  if (!err) send('notify', { level: 'ok', title: '整合包安装完成', text: `${nm(id)} 已就绪，可以开始游戏了`, version: id });
}

module.exports = register;
