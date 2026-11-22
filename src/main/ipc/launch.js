'use strict';
/** IPC：启动游戏、运行中的游戏、任务列表，启动后窗口怎么办 */
const { app, dialog } = require('electron');

const config = require('../engine/config');
const tasks = require('../engine/tasks');
const launcher = require('../core/launcher');
const gamelogs = require('../core/gamelogs');
const profiles = require('../core/profiles');
const { withReason } = require('../engine/errors');
const { handle, send, getWin } = require('./bus');
const { nm } = require('../../shared/i18n');

function register() {
  launcher.setEmitter((ch, payload) => {
    send(ch, payload);
    onGameEvent(ch, payload);
  });
  // ── 启动 ──
  handle('launch:start', async (id, opts = {}) => {
    if (launching.has(id)) throw withReason('该版本正在启动中', { code: 'ALREADY_LAUNCHING', message: '该版本正在启动中', hint: '' });
    launching.add(id);
    try {
      const game = await tasks.run({ title: `启动 ${nm(id)}`, kind: 'launch', meta: { name: id }, doneText: '游戏已启动' }, (task) => launcher.launch(id, task, { skinClose: opts && opts.skinClose }));
      if (config.get().showLogOnLaunch) send('ui:showLog', game.id);
      return game;
    } catch (e) {
      if (e.gameId) send('ui:showLog', e.gameId);
      throw e;
    } finally {
      launching.delete(id);
      // 启动时可能发现登录失效（needRelogin），侧边栏和底栏要跟着变
      send('accounts:changed');
    }
  });
  handle('games:list', () => launcher.listGames());
  handle('games:log', (id) => launcher.getLog(id));
  handle('games:kill', (id) => launcher.kill(id));
  handle('games:clear', () => launcher.clearExited());
  // ── 日志中心（rc4）：存在数据目录里的每局游戏日志 ──
  handle('logs:list', () => gamelogs.list());
  handle('logs:read', (id, opts) => gamelogs.read(String(id || ''), opts && typeof opts === 'object' ? { tail: Number(opts.tail) || 3000, before: Number(opts.before) || 0 } : {}));
  handle('logs:delete', (id) => gamelogs.remove(String(id || '')));
  handle('logs:clear', () => gamelogs.clear());
  handle('logs:prune', () => gamelogs.prune());
  handle('logs:usage', () => gamelogs.usage());
  // 日志中心的「打开文件夹」：还没玩过游戏时这个文件夹不存在，先建出来（rc11 按钮走查发现：以前报「路径不存在」）
  handle('logs:dir', async () => { const d = gamelogs.dir(); await require('fs').promises.mkdir(d, { recursive: true }); return d; });
  // 导出整份：主进程直接复制文件（以前界面读最后 20000 行拼出来，长日志导不全）
  handle('logs:export', async (id) => {
    const it = (await gamelogs.list()).find((x) => x.id === String(id || ''));
    if (!it) throw new Error('这份日志已经不在了');
    const r = await dialog.showSaveDialog(getWin(), { title: '导出日志', defaultPath: `${it.versionId}-${it.id}.log`.replace(/[\/:*?"<>|]/g, '_') });
    if (r.canceled || !r.filePath) return null;
    return gamelogs.exportTo(it.id, r.filePath);
  });
  setTimeout(() => gamelogs.prune().catch(() => {}), 8000); // 打开启动器一会儿以后按保存时间清理一次
  // ── 任务 ──
  handle('tasks:list', () => tasks.list());
  handle('tasks:cancel', (id) => tasks.cancel(id));
  handle('tasks:clear', () => tasks.clearFinished());
  handle('tasks:remove', (id) => tasks.remove(id));
  handle('tasks:retry', (id) => {
    const t = tasks.get(id);
    if (!t || !t._retry) throw new Error('该任务不支持重试');
    if (t.status === 'running') throw new Error('任务仍在进行中');
    const nid = t._retry();
    tasks.remove(id);
    return nid;
  });
}

const launching = new Set();
const handledGames = new Set();
let quitAfterGames = false;

/** 启动后窗口行为 */
function onGameEvent(ch, payload) {
  // 写入配置档案：启动记录、游玩时长、崩溃日志快照
  if (ch === 'game:exit' && payload.startedAt) {
    const g = launcher.getGame(payload.id);
    profiles.recordLaunch(payload.versionId, {
      startedAt: payload.startedAt, endedAt: payload.endedAt, exitCode: payload.exitCode, test: payload.test,
      crash: payload.crash || (g && g.crash), lines: g ? g.lines : [],
    }).then(() => send('versions:changed')) // 游玩时间、最近游玩、世界数要更新
      .catch((e) => console.warn('[profiles] 记录失败', e.message));
    // 游戏设置「每次启动保持一致」：把玩家在游戏里改过的项读回主档
    require('../core/gamesettings').afterExit(payload.versionId, { test: payload.test }).catch((e) => console.warn('[gamesync] 读回失败', e.message));
  }
  const w = getWin();
  if (!w || w.isDestroyed()) return;
  const cfg = config.get();
  if (payload && payload.test) return;
  if (ch === 'game:state' && payload.state === 'running' && !handledGames.has(payload.id)) {
    handledGames.add(payload.id);
    if (cfg.afterLaunch === 'minimize') w.minimize();
    else if (cfg.afterLaunch === 'hide') w.hide();
    else if (cfg.afterLaunch === 'close') {
      // 用到本地皮肤服务时，关掉启动器皮肤就没了：按玩家的选择先藏到托盘，游戏都退出后再关
      const choice = payload.skinClose || ((cfg.skin || {}).closeChoice === 'close' ? 'close' : 'keep');
      if (payload.skinService && choice === 'keep') { quitAfterGames = true; w.hide(); } else setTimeout(() => app.quit(), 1500);
    }
  }
  if (ch === 'game:exit') {
    handledGames.delete(payload.id);
    const crashed = payload.crash && payload.exitCode !== 0;
    if (quitAfterGames && launcher.running() === 0) {
      quitAfterGames = false;
      // 崩溃了就留下启动器给玩家看原因
      if (!crashed) { setTimeout(() => app.quit(), 1000); return; }
    }
    if ((cfg.restoreOnExit && launcher.running() === 0) || crashed) {
      if (!w.isVisible()) w.show();
      if (w.isMinimized()) w.restore();
      if (crashed) w.focus();
    }
  }
}

module.exports = register;
