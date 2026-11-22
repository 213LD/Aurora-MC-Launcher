'use strict';
/**
 * 预加载脚本：界面只能通过这里露出的 aurora.call / invoke / on 和主进程说话。
 * 命名空间（NAMESPACES）和事件（EVENTS）都是白名单，新增接口的命名空间、新增事件要加进来。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const NAMESPACES = ['win', 'app', 'sys', 'mirror', 'config', 'versions', 'loaders', 'java', 'accounts', 'launch', 'games', 'tasks', 'mods', 'news', 'shell', 'dialog',
  'profiles', 'modpack', 'planner', 'troubleshoot', 'isolation', 'vanillaplus', 'location', 'curseforge', 'place', 'repair', 'reset', 'backup', 'skins', 'mcmod', 'components', 'cache', 'migrate', 'gamesync', 'debug', 'logs'];
const EVENTS = ['task:update', 'task:cleared', 'game:log', 'game:state', 'game:exit', 'versions:changed', 'java:changed', 'accounts:changed',
  'accounts:msStep', 'mods:changed', 'notify', 'ui:showLog', 'win:maximized', 'troubleshoot:round', 'debug:step', 'curseforge:manual', 'troubleshoot:ask', 'troubleshoot:askClosed', 'data:notice', 'config:changed'];

contextBridge.exposeInMainWorld('aurora', {
  async call(channel, ...args) {
    if (!NAMESPACES.includes(String(channel).split(':')[0])) throw new Error(`未知调用：${channel}`);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (r && r.ok) return r.data;
    const e = new Error((r && r.error) || '未知错误');
    if (r && r.cancelled) e.cancelled = true;
    if (r && r.reason) e.reason = r.reason;
    throw e;
  },
  // 返回原始结果 {ok, data, error, cancelled, reason}，由渲染进程自己生成 Error：
  // 抛出的 Error 经过 contextBridge 会丢掉自定义属性（reason、cancelled），1.4.4 才发现
  async invoke(channel, ...args) {
    if (!NAMESPACES.includes(String(channel).split(':')[0])) return { ok: false, error: `未知调用：${channel}` };
    return ipcRenderer.invoke(channel, ...args);
  },
  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error(`未知事件：${event}`);
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  platform: process.platform,
});
