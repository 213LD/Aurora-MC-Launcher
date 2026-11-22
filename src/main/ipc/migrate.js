'use strict';
/** IPC：游戏设置同步，数据导出导入 */
const path = require('path');
const { dialog } = require('electron');

const gamelock = require('../core/gamelock');
const BRAND = require('../../shared/brand');
const { nm, msg, join } = require('../../shared/i18n');
const { handle, send, getWin, startTask } = require('./bus');

function register() {
  // ── 一键迁移 · 第一步：Aurora 数据导出 / 导入（1.5.3，core/migrate.js） ──
  // ── 游戏设置同步（1.5.6） ──
  const gamesync = require('../core/gamesettings');
  handle('gamesync:state', async () => ({ settings: gamesync.settings(), master: gamesync.summarize(await gamesync.readMaster()), categories: require('../core/optionsfmt').CATEGORIES }));
  handle('gamesync:sources', () => gamesync.listSources());
  handle('gamesync:import', async (id) => { if (await gamelock.anyRunning()) throw new Error('先关掉正在运行的游戏再导入'); return gamesync.captureFrom(id, { replace: true }); });
  handle('gamesync:apply', (id, cats) => gamesync.applyTo(id, { reason: 'manual', cats: cats || undefined }));
  handle('gamesync:copyTo', (fromId, toIds, cats) => gamesync.copyBetween(fromId, toIds, { cats: cats || undefined }));
  handle('gamesync:undo', (id) => gamesync.undo(id));
  handle('gamesync:profile', (id) => gamesync.profileState(id));
  handle('gamesync:setMode', (id, mode) => gamesync.setProfileMode(id, mode));
  handle('gamesync:unbind', (id) => gamesync.unbindConflicts(id));
  setTimeout(() => gamesync.startupScan().catch((e) => console.warn('[gamesync] 补读失败', e.message)), 4000);

  const migrate = require('../core/migrate');
  // 从其他启动器导入（2.0.0-pre10，core/foreign.js）。原来的文件夹只读
  const foreign = require('../core/foreign');
  handle('migrate:foreignScan', () => foreign.scan());
  handle('migrate:foreignInspect', (dir) => foreign.inspect(dir));
  handle('migrate:foreignImport', async (input, choices) => {
    if (!input || typeof input.dir !== 'string') throw new Error('请选择一个文件夹');
    if (await gamelock.anyRunning()) throw new Error('先关掉正在运行的游戏再导入（游戏开着时存档还在写）');
    return startTask('从其他启动器导入', { kind: 'migrate', meta: { name: path.basename(input.dir) }, doneText: '导入完成', failTitle: '导入失败' }, (task) => foreign.importForeign(input, choices || {}, task), (err, res) => {
      send('versions:changed');
      if (err) return;
      const parts = [];
      if (res.imported.length) parts.push(msg('{n} 个游戏配置', { n: res.imported.length }));
      if (res.savedWorlds) parts.push(msg('{n} 个世界（放在公共目录）', { n: res.savedWorlds }));
      const notes = [];
      if (res.pending.length) notes.push(msg('{list} 还没装好（{err}），联网后再试一次或者在配置卡片补全', { list: res.pending.map((p) => nm(p.id)), err: res.pending[0].error }));
      if (res.failedFiles.length) notes.push(msg('{n} 个文件读不出来，没有导入', { n: res.failedFiles.length }));
      if (res.worlds.length) notes.push(msg('同名的世界改名导入：{list}', { list: res.worlds.map((w) => nm(w.to)) }));
      send('notify', { level: res.pending.length || res.failedFiles.length ? 'warn' : 'ok', title: '导入完成', text: msg('导入了{what}。原来的文件夹没有动。{notes}', { what: parts.length ? parts : [msg('0 个配置')], notes: join(notes, 'clause') }) });
    });
  });
  handle('migrate:candidates', () => migrate.candidates());
  handle('migrate:estimate', (opts, ids) => migrate.estimate(opts || {}, ids));
  handle('migrate:inspect', (input) => migrate.inspect(input || {}));
  handle('migrate:export', async (opts = {}, ids) => {
    if (await gamelock.anyRunning()) throw new Error('先关掉正在运行的游戏再导出（游戏会一直改存档文件）');
    const day = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(getWin(), {
      title: '导出数据', defaultPath: `${BRAND.short} 数据 ${day}.${migrate.EXT}`,
      filters: [{ name: `${BRAND.short} 数据导出包`, extensions: [migrate.EXT] }],
    });
    if (r.canceled || !r.filePath) return null;
    return startTask('导出数据', { kind: 'export', meta: { name: path.basename(r.filePath) }, doneText: '导出完成', failTitle: '导出失败' }, (task) => migrate.exportData(opts, ids, r.filePath, task), (err, res) => {
      if (!err) send('notify', { level: 'ok', title: '数据已导出', text: `${res.profiles} 个游戏配置，共 ${(res.bytes / 1048576).toFixed(1)} MB。在别的电脑上用「导入」打开它`, path: res.file });
    });
  });
  handle('migrate:import', async (input, choices) => {
    if (await gamelock.anyRunning()) throw new Error('先关掉正在运行的游戏再导入');
    return startTask('导入数据', { kind: 'migrate', meta: { name: input.file ? path.basename(input.file) : input.dir }, doneText: '导入完成', failTitle: '导入失败' }, (task) => migrate.importData(input, choices || {}, task), (err, res) => {
      send('versions:changed');
      send('accounts:changed');
      if (err) return;
      const parts = [msg('{n} 个游戏配置', { n: res.imported.length })];
      if (res.accounts) parts.push(msg('{n} 个账户', { n: res.accounts }));
      if (res.skins) parts.push(msg('{n} 张皮肤', { n: res.skins }));
      if (res.plans) parts.push(msg('{n} 个 Mod 清单', { n: res.plans }));
      if (res.settings) parts.push(msg('启动器设置'));
      const notes = [];
      if (res.pending.length) notes.push(msg('{list} 的游戏文件还没补全（{err}），联网后在配置卡片「更多 → 补全游戏文件」或一键修复里补', { list: res.pending.map((p) => nm(p.id)), err: res.pending[0].error }));
      if (res.failedFiles.length) notes.push(msg('{n} 个文件已损坏、没有导入（例如 {file}）', { n: res.failedFiles.length, file: nm(res.failedFiles[0]) }));
      if (res.worlds.length) notes.push(msg('同名的世界改名导入：{list}', { list: res.worlds.map((w) => nm(w.to)) }));
      if (res.backups.length) notes.push(msg('被覆盖的配置备份在：{path}', { path: nm(res.backups[0].path) }));
      send('notify', { level: res.pending.length || res.failedFiles.length ? 'warn' : 'ok', title: '数据已导入', text: msg('导入了{what}。{notes}', { what: parts, notes: join(notes, 'clause') }), migrate: true, path: res.backups[0] && res.backups[0].path });
    });
  });
}

module.exports = register;
