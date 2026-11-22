'use strict';
/* 参考与致谢（1.5.9）：和其他启动器相似的功能写清楚是沿用代码、参考实现、受启发还是独立实现；
 * 用到的在线服务、第三方作品和许可证。仓库根目录的 ACKNOWLEDGEMENTS.md 由 scripts/build-credits.js 从这份数据生成，改这里再跑一次脚本
 * 做了和其他启动器相似的新功能，就在 FEATURES 里加一条 */
(function (root) {
  const REL = {
    code: '沿用代码',
    ref: '参考实现',
    idea: '受启发',
    own: '独立实现，功能相似',
  };

  // 和其他启动器相似的功能
  const FEATURES = [
    { name: '离线账户的本地皮肤服务', like: 'HMCL', rel: 'ref', note: '参考了 HMCL 的 YggdrasilServer 有哪些接口、怎么组织，代码是自己写的。协议是 authlib-injector 公开的 Yggdrasil 服务端规范' },
    { name: 'OptiFine 安装', like: 'HMCL', rel: 'ref', note: '参考 HMCL 的 OptiFineInstallTask 的思路：用 OptiFine 自带的 Patcher 生成库文件，再用 LaunchWrapper 启动。代码是自己写的，OptiFine 文件来自 BMCLAPI 镜像' },
    { name: 'Mod 中文名、中文 / 缩写搜索', like: 'PCL2、HMCL', rel: 'idea', note: '受 PCL2 的 Mod 中文名翻译和搜索、HMCL 内置的 Mod 对照表启发。本地对照表是本项目自己整理的，没有复制它们的数据文件；查不到时可以选择从 MC 百科读取' },
    { name: '皮肤管理和 3D 皮肤预览', like: 'HMCL、PCL2', rel: 'own', note: '3D 预览用 CSS 3D 自己实现' },
    { name: '崩溃分析、一键 Debug、一键修复', like: 'PCL2、HMCL', rel: 'own', note: '日志规则、二分排查、测试启动和硬件检测是自己写的。规则匹配的是游戏、Java 和加载器自己输出的报错原文，所以有些关键字和 HMCL、PCL2 的规则相同（例如 Pixel format not accelerated）' },
    { name: '版本隔离 / 每个配置一套存档和设置', like: 'PCL2、HMCL、Prism Launcher', rel: 'own', note: '「共享」和「测试副本」两种方式是本项目的做法' },
    { name: '整合包安装和导出（Modrinth / CurseForge）', like: 'HMCL、PCL2、Prism Launcher', rel: 'own', note: '按 Modrinth、CurseForge 公开的整合包格式实现' },
    { name: 'Forge / NeoForge 自动安装', like: 'HMCL、PCL2', rel: 'own', note: '按官方安装程序的格式，在后台运行它的处理步骤' },
    { name: '从其他启动器导入配置和存档', like: 'HMCL、PCL2、Prism Launcher', rel: 'own', note: '读这些启动器的文件结构。字段含义对照过它们公开的源码，代码是自己写的，没有沿用' },
    { name: 'Java 自动识别和下载', like: '官方启动器、HMCL、PCL2', rel: 'own', note: '' },
    { name: '官方源 / BMCLAPI 镜像切换', like: 'HMCL、PCL2', rel: 'own', note: '镜像服务由 BMCLAPI 提供' },
    { name: '外置登录（authlib-injector，LittleSkin 等）', like: 'HMCL、PCL2', rel: 'own', note: '按 authlib-injector 公开的启动器技术规范实现' },
    { name: '按电脑内存和有没有 Mod 自动分配内存', like: 'HMCL、PCL2', rel: 'own', note: '' },
    { name: '按文件哈希在 Modrinth 上认出 Mod、检查更新', like: 'HMCL、Prism Launcher', rel: 'own', note: '用 Modrinth 公开的 API' },
    { name: '启动后直接进服务器', like: 'HMCL、PCL2', rel: 'own', note: '用游戏自带的启动参数' },
    { name: '完成隐藏彩蛋后，主页名字旁边出现一个标记', like: "Five Nights at Freddy's（FNAF）", rel: 'idea', note: '创意来自 FNAF：通关后标题画面会出现星星。具体是什么标记、怎么出现，留给玩家自己发现' },
  ];

  // 用到的在线服务
  const SERVICES = [
    { name: 'Mojang / Microsoft', use: '游戏版本列表、游戏文件、资源文件、官方 Java、皮肤、更新日志、微软账户登录' },
    { name: 'BMCLAPI（bangbang93）', use: '国内镜像：游戏文件、Forge / NeoForge / OptiFine、authlib-injector' },
    { name: 'Modrinth', use: 'Mod、整合包、资源包、光影的搜索和下载（Modrinth API）' },
    { name: 'CurseForge', use: 'Mod、整合包、资源包、光影的搜索和下载（填了 API Key 时用官方接口）' },
    { name: 'curse.tools', use: '没填 CurseForge API Key 时用的社区代理' },
    { name: 'Fabric / Quilt / Legacy Fabric', use: '加载器版本信息（Meta API）' },
    { name: 'Forge / NeoForge Maven', use: '加载器安装程序' },
    { name: 'Eclipse Adoptium、清华大学 TUNA 镜像', use: 'Java（Temurin）下载' },
    { name: 'Microsoft Build of OpenJDK', use: 'Java 下载（可选）' },
    { name: 'covers1624 Maven', use: '老版本 CodeChickenLib（原来的下载地址已经失效）' },
    // concept：公开版里这一条挪到「概念演示（公开版未包含）」，说明用 concept（公开版不含这部分代码，见 src/edition/public）
    { name: 'MC 百科（mcmod.cn）', use: 'Mod 中文名和中文介绍。实验性功能，默认关闭；读取的是公开网页，频率很低并且有缓存；不是官方合作',
      concept: '概念演示：设想从 MC 百科读取 Mod 的中文名、简介和评价。公开版不包含这部分代码，不会访问 MC 百科' },
    { name: 'LittleSkin', use: '按名字导入皮肤' },
  ];

  // 第三方作品（随启动器分发的，和运行时才下载 / 读取的）
  const WORKS = [
    { name: 'Electron', license: 'MIT', use: '启动器的运行环境' },
    { name: 'Lucide 图标', license: 'ISC（其中源自 Feather 的图标为 MIT）', use: '界面上的线条图标大多取自或仿照 Lucide', text: 'lucide' },
    { name: 'Fusion Pixel Font 缝合像素字体（TakWolf）', license: 'SIL Open Font License 1.1', use: '「像素原版」界面风格的字体', file: 'fonts/OFL-fusion-pixel.txt' },
    { name: 'authlib-injector（yushijinhun）', license: 'AGPL-3.0，附 authlib-injector 例外', use: '不随启动器分发：用离线皮肤时从官方或 BMCLAPI 下载，作为 Java Agent 加载进游戏（属于许可证的例外情形）' },
    { name: 'CustomSkinLoader', license: 'GPL-3.0', use: '不分发、不包含它的代码；装了它时，启动器按它的本地皮肤文件格式写入皮肤' },
    { name: 'Minecraft 默认皮肤', license: 'Mojang', use: '不随启动器分发，从本机已经安装的游戏文件里读取' },
    { name: '终末之诗（The End Poem，Julian Gough）', license: 'CC0（作者 2022 年放弃版权）', use: '终极彩蛋结尾播放。优先从本机已经安装的游戏里读；没装游戏时用启动器自带的英文原文。中文翻译是本项目自己写的' },
    { name: 'Minecraft 音效和通关音乐', license: 'Mojang', use: '主页背景的互动音效（紫水晶、箱子、末影龙等）和终末之诗的背景音乐，不随启动器分发，从本机已经安装的游戏资源里读取' },
  ];

  const ORIGINAL = '背景音乐（用 Web Audio 实时合成）、主页的像素动态背景和方块图标是本项目原创的。Minecraft 是 Mojang Studios 的商标，Aurora MC Launcher（极光启动器）不是官方产品，和 Mojang、Microsoft 没有关系';

  const LICENSES = {
    lucide: `ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

Lucide icons derived from the Feather project are licensed under:

The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  };

  const CREDITS = { REL, FEATURES, SERVICES, WORKS, ORIGINAL, LICENSES };
  if (typeof module !== 'undefined' && module.exports) { module.exports = CREDITS; return; }

  // ── 界面：设置 → 关于 →「参考与致谢」 ──
  const A = root.A;
  const { h, icon } = A;

  function licenseDialog(title, text) {
    A.modal({ title, size: 'lg', body: h('pre.cr-license', text), actions: [{ label: A.t('common.close'), kind: '' }] });
  }

  async function showWork(w) {
    if (w.text) { licenseDialog(`${w.name}：许可证`, LICENSES[w.text]); return; }
    try {
      const r = await fetch(w.file);
      licenseDialog(`${w.name}：许可证`, await r.text());
    } catch (e) { A.errorToast('打不开许可证文件', e); }
  }

  function open() {
    const section = (title, kids) => h('div.cr-sec', h('h3', title), kids);
    const concept = !!(A.mcmodUi && A.mcmodUi.CONCEPT); // 公开版
    A.modal({
      title: '参考与致谢',
      size: 'lg',
      body: h('div.cr-body',
        h('p.faint', '和其他启动器相似的功能，下面写清楚了是沿用代码、参考实现、受启发，还是独立实现但功能相似。感谢这些项目和服务'),
        section('相似功能和参考关系', h('div.list', FEATURES.map((f) => h('div.list-row',
          h('div.body',
            h('div.title', h('span', f.name), h(`span.badge${f.rel === 'own' ? '' : '.info'}`, REL[f.rel])),
            h('div.sub', `相似：${f.like}`), f.note ? h('div.sub', f.note) : null))))),
        section('用到的在线服务', h('div.list', SERVICES.filter((s) => !(s.concept && concept)).map((s) => h('div.list-row', h('div.body', h('div.title', s.name), h('div.sub', s.use)))))),
        concept ? section('概念演示（公开版未包含）', h('div.list', SERVICES.filter((s) => s.concept).map((s) => h('div.list-row', h('div.body', h('div.title', s.name), h('div.sub', s.concept)))))) : null,
        section('第三方作品和许可证', h('div.list', WORKS.map((w) => h('div.list-row',
          h('div.body', h('div.title', h('span', w.name), h('span.badge', w.license)), h('div.sub', w.use)),
          w.text || w.file ? h('div.actions', h('button.btn.sm', { onclick: () => showWork(w) }, icon('file', 14), '许可证')) : null)))),
        h('p.faint.cr-orig', ORIGINAL)),
      actions: [{ label: A.t('common.close'), kind: '' }],
    });
  }

  A.credits = { ...CREDITS, open };
})(typeof window !== 'undefined' ? window : globalThis);
