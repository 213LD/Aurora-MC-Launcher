'use strict';
/**
 * IPC：界面调用主进程的入口。具体的接口按功能放在 ipc/ 下面（2.0.0-pre3 拆开，以前这一个文件 1000 多行）。
 * 新增接口的命名空间或事件，要同时加进 preload.js 的白名单。
 */
const tasks = require('./engine/tasks');
const bus = require('./ipc/bus');

const MODULES = [
  require('./ipc/launch'), // 先注册：游戏事件的转发要最早挂上
  require('./ipc/app'),
  require('./ipc/versions'),
  require('./ipc/backup'),
  require('./ipc/java'),
  require('./ipc/accounts'),
  require('./ipc/mods'),
  require('./ipc/profiles'),
  require('./ipc/troubleshoot'),
  require('./ipc/migrate'),
  require('./ipc/planner'),
];

function register(winGetter) {
  bus.setWin(winGetter);
  tasks.setBroadcaster(bus.send);
  tasks.setNotifier((n) => bus.send('notify', n));
  for (const registerModule of MODULES) registerModule();
}

module.exports = { register, send: bus.send };
