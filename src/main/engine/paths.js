'use strict';
const { app } = require('electron');
const path = require('path');
const os = require('os');

/** 便携 / 自定义存储位置时，游戏目录默认放在数据文件夹里 */
function defaultGameDir() {
  return require('./location').gameDirDefault() || systemGameDir();
}

/** 系统默认的 .minecraft */
function systemGameDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  }
  return path.join(os.homedir(), '.minecraft');
}

const dataDir = () => app.getPath('userData');
const runtimeDir = () => path.join(dataDir(), 'runtime');
const cacheDir = () => path.join(dataDir(), 'cache');

module.exports = { defaultGameDir, systemGameDir, dataDir, runtimeDir, cacheDir };
