'use strict';
const path = require('path');

const electronApp = () => require('electron').app;

/** 启动器“根目录”：便携版为 exe 所在目录，安装版为安装目录，开发时为项目目录 */
function rootDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  const app = electronApp();
  if (app.isPackaged) return path.dirname(process.execPath);
  return app.getAppPath();
}

module.exports = { rootDir };
