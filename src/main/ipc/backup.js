'use strict';
/** IPC：存档和设置备份 */
const fsp = require('fs').promises;

const tasks = require('../engine/tasks');
const backup = require('../core/backup');
const { handle, send } = require('./bus');
const { nm } = require('../../shared/i18n');

function register() {
  // 存档与设置备份
  const BACKUP_NAMES = { saves: '存档', settings: '游戏设置', mods: 'Mod 和配置', full: '整个配置' };
  handle('backup:worlds', (id) => backup.worlds(id));
  handle('backup:list', (id, opts) => backup.list(id, opts));
  handle('backup:create', (id, opts) => tasks.run({ title: `备份 ${nm(id)} 的${BACKUP_NAMES[opts && opts.type] || ''}`, kind: 'backup', meta: { name: id }, doneText: '备份完成' }, (task) => backup.create(id, opts, task)));
  handle('backup:restore', async (id, file, opts) => {
    const r = await tasks.run({ title: `恢复 ${nm(id)} 的备份`, kind: 'backup', meta: { name: id }, doneText: '恢复完成' }, (task) => backup.restore(id, file, opts, task));
    send('mods:changed', id); send('versions:changed');
    return r;
  });
  handle('backup:undo', async (id, info) => {
    const r = await tasks.run({ title: `撤销 ${nm(id)} 的恢复`, kind: 'backup', meta: { name: id }, doneText: '已撤销' }, (task) => backup.undoRestore(id, info, task));
    send('mods:changed', id); send('versions:changed');
    return r;
  });
  handle('backup:remove', (file) => backup.remove(file));
  handle('backup:deleteWorld', async (id, name) => { const p = await backup.deleteWorld(id, name); send('versions:changed'); return p; });
  handle('backup:usage', () => backup.usage());
  handle('backup:clean', (opts) => backup.clean(opts));
  handle('backup:prune', () => backup.prune());
  // 「打开存档文件夹」用：这个配置的存档文件夹，还没玩过、文件夹不存在时先建出来（rc12 按钮走查发现：以前报「路径不存在」）
  handle('backup:savesDir', async (id) => { const d = (await backup.worlds(id)).savesDir; await fsp.mkdir(d, { recursive: true }); return d; });
  handle('backup:dir', async (id) => { const d = id ? backup.dirOf(id) : backup.root(); await fsp.mkdir(d, { recursive: true }); return d; });
}

module.exports = register;
