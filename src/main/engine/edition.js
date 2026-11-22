'use strict';
/**
 * 这一份启动器是内部版还是公开版：公开仓库导出时 package.json 里写 auroraEdition: public（scripts/export-public.js）。
 * 两版的数据目录和 appId 不一样，同一台电脑上可以同时用、互不覆盖；内部版的窗口标题、托盘提示上标「内部版」。
 */
const BRAND = require('../../shared/brand');

const PUBLIC = (() => { try { return require('../../../package.json').auroraEdition === 'public'; } catch { return false; } })();

module.exports = {
  PUBLIC,
  name: PUBLIC ? 'public' : 'internal',
  // 系统默认数据目录名（%APPDATA%\<这个>）。内部版永远是 BRAND.dataDirName：改了老用户的数据就找不到了
  dataDirName: PUBLIC ? BRAND.publicEdition.dataDirName : BRAND.dataDirName,
  appId: PUBLIC ? BRAND.publicEdition.appId : BRAND.appId,
  // 窗口标题、托盘提示（按当前界面语言，所以是函数）
  title: () => (PUBLIC ? BRAND.name : require('../../shared/i18n').msg('{0}（内部版）', { 0: BRAND.name })),
};
