'use strict';
/**
 * 品牌信息：界面上出现的启动器名称一律从这里取，以后改名只改这一处。
 * 数据与文件格式里的 aurora 标识（aurora-profile.json、.aurora、AuroraData 等）是历史格式，不随品牌变化。
 * 主进程 require，渲染进程用 <script> 加载（全局 BRAND）。
 */
(function (root, brand) {
  if (typeof module === 'object' && module.exports) module.exports = brand;
  else root.BRAND = brand;
})(typeof self !== 'undefined' ? self : this, Object.freeze({
  // 正式名字：全名 Aurora MC Launcher，缩写 AML，中文名极光启动器
  name: 'Aurora MC Launcher',
  // 用过的名字，从新到旧。只用来认以前按旧名字建的文件夹（core/placecheck.js），界面上不显示
  formerNames: ['Aurora Minecraft Launcher', 'Aurora Launcher'],
  short: 'Aurora',
  abbr: 'AML',
  zh: '极光启动器',
  tagline: 'MC LAUNCHER',
  // 系统默认数据目录名（%APPDATA%\<dataDirName>），写死以免改 productName 后找不到老数据
  dataDirName: 'Aurora Launcher',
  appId: 'dev.aurora.launcher',
  // 公开版（package.json 里有 auroraEdition: public）用自己的数据目录和 appId：和内部版装在同一台电脑上时互不覆盖、可以同时开
  publicEdition: { dataDirName: 'Aurora MC Launcher', appId: 'dev.aurora.mclauncher' },
  author: '213LD',
  license: 'GPL-3.0-or-later',
  // 公开仓库：发布新版本、问题和反馈（Issues）都在这里
  repo: 'https://github.com/213LD/Aurora-MC-Launcher',
  // 隐私声明（1.8.0）：设置 → 关于、免责声明、README 共用这段意思；改了要三处一起看
  privacy: [
    '启动器不收集任何数据：没有统计、没有遥测、不上传你的任何信息，也没有自己的后台服务器。',
    '启动器不检测版本更新。新版本请到作者发布的 GitHub 仓库或其他发布位置自行获取。',
    '只有你用到下面这些功能时才会联网，而且直接连对应的服务：下载游戏、Mod、资源包、光影和 Java（以及搜索它们）；微软正版登录和外置登录；主页的 Minecraft 新闻；按正版玩家名、LittleSkin 或网址导入皮肤；默认关闭的 MC 百科中文信息。',
    '其他功能都不需要网络；断网时启动器会自动切换到离线模式，需要联网的功能先停用。',
  ],
}));
