'use strict';
/**
 * 自动点遍界面时用（electron -r）：打开文件夹、外部网页、文件选择框、重启都变成什么也不做，
 * 不弹窗口到用户屏幕上，也不会卡在系统对话框。回收站已经由 AURORA_TEST_TRASH 换成测试目录。
 */
const fs = require('fs');
const { app, shell, dialog, ipcMain } = require('electron');

shell.openExternal = async () => {};
shell.openPath = async () => '';
shell.showItemInFolder = () => {};
shell.writeShortcutLink = () => false;
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
dialog.showErrorBox = () => {};
app.relaunch = () => {};

// 标记泄漏（2.0.0-pre7）：名字的翻译标记 U+2068、U+2069 只能出现在要显示的文字里。
// 查到进了接口参数、写入的文件名或文件内容，就记进 AURORA_TEST_LEAK_LOG
const LEAK = process.env.AURORA_TEST_LEAK_LOG;
if (LEAK) {
  const MARK = /[\u2068\u2069]/;
  const append = fs.appendFileSync; // 自己写日志不能再被下面的监听抓到
  const log = (kind, what) => { try { append(LEAK, `${kind}\t${String(what).replace(/\s+/g, ' ').slice(0, 300)}\n`); } catch { /* 记不了就算了 */ } };
  const has = (x) => {
    if (typeof x === 'string') return MARK.test(x);
    if (Buffer.isBuffer(x)) return x.length < 2000000 && MARK.test(x.toString('utf8'));
    if (x && typeof x === 'object') { try { return MARK.test(JSON.stringify(x)); } catch { return false; } }
    return false;
  };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => handle(channel, (e, ...args) => {
    if (has(args)) log('ipc', `${channel} ${JSON.stringify(args)}`);
    return fn(e, ...args);
  });
  const wrap = (obj, names) => {
    for (const name of names) {
      const orig = obj[name];
      if (typeof orig !== 'function') continue;
      obj[name] = function (...args) {
        // 二进制文件（下载的 Java 之类）里碰巧有这几个字节不算，内容只查文字文件
        const textFile = /\.(json|txt|toml|properties|bak|log)$/i.test(String(args[0]));
        if (args.some((a, i) => (typeof a === 'string' && (i === 0 || textFile || name.startsWith('rename') || name.startsWith('copy')) && has(a)) || (Buffer.isBuffer(a) && textFile && has(a)))) log('fs', `${name} ${String(args[0])}`);
        return orig.apply(this, args);
      };
    }
  };
  wrap(fs, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'symlink', 'symlinkSync']);
  wrap(fs.promises, ['writeFile', 'appendFile', 'mkdir', 'rename', 'copyFile', 'cp', 'symlink']);
}
