# 参考与致谢

> 这个文件由 `scripts/build-credits.js` 从 `src/renderer/js/credits.js` 生成，启动器里「设置 → 关于 → 参考与致谢」显示的是同一份内容。

和其他启动器相似的功能，下面写清楚了是沿用代码、参考实现、受启发，还是独立实现但功能相似。感谢这些项目和服务。

## 相似功能和参考关系

| 功能 | 相似的启动器 | 关系 | 说明 |
| --- | --- | --- | --- |
| 离线账户的本地皮肤服务 | HMCL | 参考实现 | 参考了 HMCL 的 YggdrasilServer 有哪些接口、怎么组织，代码是自己写的。协议是 authlib-injector 公开的 Yggdrasil 服务端规范 |
| OptiFine 安装 | HMCL | 参考实现 | 参考 HMCL 的 OptiFineInstallTask 的思路：用 OptiFine 自带的 Patcher 生成库文件，再用 LaunchWrapper 启动。代码是自己写的，OptiFine 文件来自 BMCLAPI 镜像 |
| Mod 中文名、中文 / 缩写搜索 | PCL2、HMCL | 受启发 | 受 PCL2 的 Mod 中文名翻译和搜索、HMCL 内置的 Mod 对照表启发。本地对照表是本项目自己整理的，没有复制它们的数据文件；查不到时可以选择从 MC 百科读取 |
| 皮肤管理和 3D 皮肤预览 | HMCL、PCL2 | 独立实现，功能相似 | 3D 预览用 CSS 3D 自己实现 |
| 崩溃分析、一键 Debug、一键修复 | PCL2、HMCL | 独立实现，功能相似 | 日志规则、二分排查、测试启动和硬件检测是自己写的。规则匹配的是游戏、Java 和加载器自己输出的报错原文，所以有些关键字和 HMCL、PCL2 的规则相同（例如 Pixel format not accelerated） |
| 版本隔离 / 每个配置一套存档和设置 | PCL2、HMCL、Prism Launcher | 独立实现，功能相似 | 「共享」和「测试副本」两种方式是本项目的做法 |
| 整合包安装和导出（Modrinth / CurseForge） | HMCL、PCL2、Prism Launcher | 独立实现，功能相似 | 按 Modrinth、CurseForge 公开的整合包格式实现 |
| Forge / NeoForge 自动安装 | HMCL、PCL2 | 独立实现，功能相似 | 按官方安装程序的格式，在后台运行它的处理步骤 |
| 从其他启动器导入配置和存档 | HMCL、PCL2、Prism Launcher | 独立实现，功能相似 | 读这些启动器的文件结构。字段含义对照过它们公开的源码，代码是自己写的，没有沿用 |
| Java 自动识别和下载 | 官方启动器、HMCL、PCL2 | 独立实现，功能相似 |  |
| 官方源 / BMCLAPI 镜像切换 | HMCL、PCL2 | 独立实现，功能相似 | 镜像服务由 BMCLAPI 提供 |
| 外置登录（authlib-injector，LittleSkin 等） | HMCL、PCL2 | 独立实现，功能相似 | 按 authlib-injector 公开的启动器技术规范实现 |
| 按电脑内存和有没有 Mod 自动分配内存 | HMCL、PCL2 | 独立实现，功能相似 |  |
| 按文件哈希在 Modrinth 上认出 Mod、检查更新 | HMCL、Prism Launcher | 独立实现，功能相似 | 用 Modrinth 公开的 API |
| 启动后直接进服务器 | HMCL、PCL2 | 独立实现，功能相似 | 用游戏自带的启动参数 |
| 完成隐藏彩蛋后，主页名字旁边出现一个标记 | Five Nights at Freddy's（FNAF） | 受启发 | 创意来自 FNAF：通关后标题画面会出现星星。具体是什么标记、怎么出现，留给玩家自己发现 |

## 用到的在线服务

| 服务 | 用途 |
| --- | --- |
| Mojang / Microsoft | 游戏版本列表、游戏文件、资源文件、官方 Java、皮肤、更新日志、微软账户登录 |
| BMCLAPI（bangbang93） | 国内镜像：游戏文件、Forge / NeoForge / OptiFine、authlib-injector |
| Modrinth | Mod、整合包、资源包、光影的搜索和下载（Modrinth API） |
| CurseForge | Mod、整合包、资源包、光影的搜索和下载（填了 API Key 时用官方接口） |
| curse.tools | 没填 CurseForge API Key 时用的社区代理 |
| Fabric / Quilt / Legacy Fabric | 加载器版本信息（Meta API） |
| Forge / NeoForge Maven | 加载器安装程序 |
| Eclipse Adoptium、清华大学 TUNA 镜像 | Java（Temurin）下载 |
| Microsoft Build of OpenJDK | Java 下载（可选） |
| covers1624 Maven | 老版本 CodeChickenLib（原来的下载地址已经失效） |
| LittleSkin | 按名字导入皮肤 |

## 概念演示（公开版未包含）

| 服务 | 说明 |
| --- | --- |
| MC 百科（mcmod.cn） | 概念演示：设想从 MC 百科读取 Mod 的中文名、简介和评价。公开版不包含这部分代码，不会访问 MC 百科 |

## 第三方作品和许可证

| 作品 | 许可证 | 用途 |
| --- | --- | --- |
| Electron | MIT | 启动器的运行环境 |
| Lucide 图标 | ISC（其中源自 Feather 的图标为 MIT） | 界面上的线条图标大多取自或仿照 Lucide |
| Fusion Pixel Font 缝合像素字体（TakWolf） | SIL Open Font License 1.1（全文见 `src/renderer/fonts/OFL-fusion-pixel.txt`） | 「像素原版」界面风格的字体 |
| authlib-injector（yushijinhun） | AGPL-3.0，附 authlib-injector 例外 | 不随启动器分发：用离线皮肤时从官方或 BMCLAPI 下载，作为 Java Agent 加载进游戏（属于许可证的例外情形） |
| CustomSkinLoader | GPL-3.0 | 不分发、不包含它的代码；装了它时，启动器按它的本地皮肤文件格式写入皮肤 |
| Minecraft 默认皮肤 | Mojang | 不随启动器分发，从本机已经安装的游戏文件里读取 |
| 终末之诗（The End Poem，Julian Gough） | CC0（作者 2022 年放弃版权） | 终极彩蛋结尾播放。优先从本机已经安装的游戏里读；没装游戏时用启动器自带的英文原文。中文翻译是本项目自己写的 |
| Minecraft 音效和通关音乐 | Mojang | 主页背景的互动音效（紫水晶、箱子、末影龙等）和终末之诗的背景音乐，不随启动器分发，从本机已经安装的游戏资源里读取 |

背景音乐（用 Web Audio 实时合成）、主页的像素动态背景和方块图标是本项目原创的。Minecraft 是 Mojang Studios 的商标，Aurora MC Launcher（极光启动器）不是官方产品，和 Mojang、Microsoft 没有关系

## 许可证全文

### Lucide 图标

```
ISC License

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
SOFTWARE.
```
