'use strict';
/**
 * 模拟系统语言（electron -r）：启动器先看系统首选语言（getPreferredSystemLanguages），--lang 只改得了 Chromium 的 getLocale，
 * 所以把这个函数换掉，走的还是启动器真实的判断。这台电脑不是繁体系统，差别是 Windows 自己的界面（文件对话框等）还是原来的语言
 */
const { app } = require('electron');

const locale = process.env.AURORA_TEST_LOCALE;
if (locale) {
  app.getPreferredSystemLanguages = () => [locale];
  app.commandLine.appendSwitch('lang', locale);
}
