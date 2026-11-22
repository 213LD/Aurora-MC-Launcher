'use strict';
/**
 * 按钮走查用（electron -r）：把会跑到外面的东西都换掉。点按钮不能打开资源管理器和浏览器、不能弹系统对话框挡住流程、
 * 不能在桌面建快捷方式、不能改系统设置
 */
const electron = require('electron');

const note = (what, arg) => console.log(`[walk] ${what} ${arg == null ? '' : String(arg).slice(0, 120)}`);
const { shell, dialog, app } = electron;
shell.openExternal = async (u) => { note('openExternal', u); };
shell.openPath = async (p) => { note('openPath', p); return ''; };
shell.showItemInFolder = (p) => { note('showItem', p); };
shell.writeShortcutLink = () => { note('shortcut'); return true; };
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
dialog.showMessageBoxSync = () => 0;
app.relaunch = () => { note('relaunch'); };
app.setLoginItemSettings = () => { note('loginItem'); };
app.setAsDefaultProtocolClient = () => { note('protocol'); return true; };
// walk.js --net=fixture：网络都由 net-fixture.js 回答（内容每次都一样，还故意放了极端情况），不加这个就是真的联网
if (process.env.AURORA_WALK_NET === 'fixture') {
  const { answer } = require('./net-fixture');
  const fixture = async (u) => answer(u && u.url ? u.url : String(u));
  electron.net.fetch = fixture;
  app.whenReady().then(() => { electron.session.defaultSession.fetch = fixture; }).catch(() => {});
}
