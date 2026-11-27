'use strict';
/** IPC：Mod 和资源，Modrinth、CurseForge 下载 */
const path = require('path');

const mods = require('../core/mods');
const profiles = require('../core/profiles');
const troubleshoot = require('../core/troubleshoot');
const curseforge = require('../core/curseforge');
const backup = require('../core/backup');
const gamelock = require('../core/gamelock');
const { handle, send, startTask, assertModsFree, assertInGame, manualNote } = require('./bus');
const { nm, msg, join } = require('../../shared/i18n');

function register() {
  // ── Mod 与资源 ──
  handle('mods:list', (id) => mods.listMods(id));
  // 不带配置 id 发 mods:changed：Mod 管理页是自己调用的，已经会刷新；这里只是让配置卡片上的数字跟着变（1.10.8）
  handle('mods:toggle', async (p, enable) => { assertInGame(p); await gamelock.assertPath(p, '开关 Mod'); const r = await mods.toggleMod(p, enable); send('mods:changed', null); return r; });
  handle('mods:remove', async (p, id, opts = {}) => { assertInGame(p); await gamelock.assertPath(p, '删除 Mod'); const r = await mods.removeMod(p, id, { permanent: !!opts.permanent }); send('mods:changed', null); return r; });
  // 往 mods 文件夹里加：和开关、删除一样，游戏开着时不改（资源包、光影不影响正在运行的游戏，照常加）
  handle('mods:add', async (id, files, kind) => { if (!kind || kind === 'mod') await assertModsFree(id, '添加 Mod'); const r = await mods.addFiles(id, Array.isArray(files) ? files : [], kind); send('mods:changed', null); return r; });
  handle('mods:search', (params) => mods.search(params || {}));
  // 光影「适合这台电脑」（1.5.9）
  handle('mods:shaderMachine', () => require('../core/shaderfit').machine());
  handle('mods:shaderBorrow', (list) => require('../core/shaderfit').borrow(list));
  handle('mods:versions', (projectId, opts) => mods.projectVersions(projectId, opts || {}));
  handle('mods:project', (id) => mods.project(id));
  handle('mods:install', (params) => {
    const file = (params.projectVersion.files.find((f) => f.primary) || params.projectVersion.files[0] || {}).filename || params.title;
    return startTask(`下载 ${nm(params.title) || nm(file)}`, { kind: 'mod', meta: { name: params.versionId }, doneText: '已安装', failTitle: '下载失败' }, (task) => mods.installProjectVersion(params, task), (err, files) => {
      if (err) return;
      send('mods:changed', params.versionId);
      send('notify', { level: 'ok', title: '下载完成', text: `${nm(params.title) || nm(file)} 已安装到 ${nm(params.versionId)}${files && files.length > 1 ? `（含 ${files.length - 1} 个前置）` : ''}` });
    });
  });

  // ── CurseForge ──
  handle('curseforge:search', (params) => curseforge.search(params || {}));
  handle('curseforge:categories', (type) => curseforge.categories(type));
  handle('curseforge:project', (id) => curseforge.project(id));
  handle('curseforge:files', (id, opts) => curseforge.files(id, opts || {}));
  handle('curseforge:test', () => curseforge.test());
  handle('curseforge:install', (params) => {
    const file = (params.projectVersion.files[0] || {}).filename || params.title;
    return startTask(`下载 ${nm(params.title) || nm(file)}`, { kind: 'mod', meta: { name: params.versionId }, doneText: '已安装', failTitle: '下载失败' }, (task) => curseforge.installFile(params, task), (err, r) => {
      send('mods:changed', params.versionId);
      if (err) return;
      if (r.installed.length) send('notify', { level: 'ok', title: '下载完成', text: `${nm(params.title) || nm(file)} 已安装到 ${nm(params.versionId)}${r.installed.length > 1 ? `（含 ${r.installed.length - 1} 个前置）` : ''}` });
      manualNote(params.versionId, r.manual);
    });
  });
  handle('curseforge:importManual', async (id, opts) => {
    const r = await curseforge.importManual(id, opts || {});
    if (r.imported.length) send('mods:changed', id);
    // 「下载」文件夹里的原文件按设置处理；ask 时把列表交给界面询问
    r.originals = await curseforge.settleOriginals(r.originals);
    return r;
  });
  handle('curseforge:trashOriginals', (files) => curseforge.trashOriginals(files));
  handle('curseforge:dismissManual', async (id, fileId) => { const r = await curseforge.dismissManual(id, fileId); send('mods:changed', id); return r; });
  handle('curseforge:manualList', async (id) => (await profiles.readMeta(id)).cfManual || []);
  handle('mods:identify', (id) => mods.identify(id));
  handle('mods:checkUpdates', (id) => mods.checkUpdates(id));
  handle('mods:update', async (id, items) => { await assertModsFree(id, '更新 Mod'); return startTask(`更新 ${items.length} 个 Mod`, { kind: 'mod', lock: id, meta: { name: id }, doneText: '更新完成', failTitle: '更新失败' }, async (task) => {
    const b = await backup.auto(id, 'modupdate', task);
    if (b.error) send('notify', { level: 'warn', title: '更新前备份 Mod 失败', text: `${b.error}。继续更新` });
    let n = 0;
    for (const it of items) {
      task.update({ detail: `更新 ${nm(it.name)}（${n + 1}/${items.length}）`, progress: n / items.length });
      await mods.applyUpdate(id, it, task);
      n++;
    }
    return n;
  }, (err, n) => {
    send('mods:changed', id);
    if (!err) send('notify', { level: 'ok', title: '更新完成', text: `已更新 ${n} 个 Mod` });
  }); }); // 更新会换掉 mods 里的文件：和开关、删除一样，游戏开着时不动
  handle('mods:presetSave', (id, name) => mods.savePreset(id, name));
  handle('mods:presetApply', async (id, name) => { await assertModsFree(id, '切换 Mod 方案'); const r = await mods.applyPreset(id, name); send('mods:changed', id); return r; });
  handle('mods:presetDelete', (id, name) => mods.deletePreset(id, name));
  handle('mods:check', (id) => troubleshoot.staticCheck(id));
  // 没禁用成的（文件被占着等）要告诉界面，不能都说成功（1.10.8）
  handle('mods:disableFiles', async (files, id) => {
    const failed = [];
    for (const f of files || []) await Promise.resolve().then(() => mods.toggleMod(assertInGame(f), false)).catch((e) => failed.push({ file: path.basename(f), error: e.code || e.message }));
    if (id) send('mods:changed', id);
    return { failed };
  });
  handle('mods:installDep', (id, modId, opts) => startTask(`${opts && opts.update ? '更换' : '安装前置'} ${modId}`, { kind: 'mod', meta: { name: id }, doneText: '已安装', failTitle: `安装 ${nm(modId)} 失败` }, (task) => troubleshoot.installDep(id, modId, task, opts || {}), (err, r) => {
    send('mods:changed', id);
    profiles.recordTroubleshoot(id, { kind: 'fix', ok: !err, summary: err ? `安装前置 ${nm(modId)} 失败：${err.message}` : r.disabled.length ? `${nm(r.title)} 换成 ${nm(r.version)}` : `自动安装前置 ${nm(r.title)}` }).catch(() => {});
    if (!err) send('notify', { level: 'ok', title: r.disabled.length ? `已换成 ${nm(r.title)} ${nm(r.version)}` : '前置已安装', text: join([r.files.length > 1 ? msg('{name}（含 {n} 个依赖）', { name: nm(r.title), n: r.files.length - 1 }) : nm(r.title), r.disabled.length ? msg('旧的 {list} 已禁用', { list: r.disabled.map((d) => nm(d.file)) }) : ''], 'clause') });
  }));
  handle('mods:disableAll', async (id) => { await assertModsFree(id, '禁用全部 Mod'); const r = await mods.disableAll(id); send('mods:changed', id); send('versions:changed'); return r; });
  handle('mods:restoreAll', async (id) => { await assertModsFree(id, '恢复全部 Mod'); const r = await mods.restoreAll(id); send('mods:changed', id); send('versions:changed'); return r; });
}

module.exports = register;
