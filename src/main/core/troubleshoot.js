'use strict';
/**
 * Mod 兼容性排查（2.0.0-pre9 按职责拆开，都在 troubleshoot/ 里，这里只汇总）：
 *  - staticCheck  静态检查（缺少前置、加载器不匹配、重复、声明的不兼容、MC 版本不符）
 *  - analyzeLog   解析崩溃日志 / 崩溃报告，定位问题 Mod
 *  - installDep   安装前置
 *  - testLaunch   测试启动，自动判断是否成功进入游戏
 *  - bisect       自动二分排查，找出导致崩溃的 Mod
 *  - autoDebug    一键 Debug
 */
module.exports = {
  ...require('./troubleshoot/compat'),
  ...require('./troubleshoot/static'),
  ...require('./troubleshoot/log'),
  ...require('./troubleshoot/deps'),
  ...require('./troubleshoot/test'),
  ...require('./troubleshoot/bisect'),
  ...require('./troubleshoot/debug'),
};
