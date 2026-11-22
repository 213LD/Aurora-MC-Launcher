'use strict';
/**
 * 翻译回归用的句子：都是代码里真实拼出来的句子，数字和名字换成示例。
 * [清单编号, 中文原文, 英文译文里必须有的片段…]。残留中文一律算失败。
 */
module.exports = [
  // 9-1 用「、」「；」拼接的句子
  ['9-1', '导入了3 个游戏配置、2 个账户。', 'Imported 3 game profiles, 2 accounts.'],
  ['9-1', '导入了3 个游戏配置、2 个账户、1 张皮肤、1 个 Mod 清单、启动器设置。p1、p2 的游戏文件还没补全（网络未连接），联网后在配置卡片「更多 → 补全游戏文件」或一键修复里补；2 个文件已损坏、没有导入（例如 a/b.jar）；同名的世界改名导入：w1、w2；被覆盖的配置备份在：C:\\x\\y', 'Imported 3 game profiles, 2 accounts', 'p1, p2', 'w1, w2'],
  ['9-1', '已安装 Fabric API、Mod Menu', 'Fabric API, Mod Menu'],
  ['9-1', 'a.jar（1.0）、b.jar（2.0） 都是 fabric-api，只能保留一个', 'a.jar (1.0), b.jar (2.0)'],
  ['9-1', '1.20.1 Fabric：下载了 12 个 Mod；复制了 2 个本地文件；自动补齐前置：A、B；未能找到：C', 'ownloaded 12 mods', 'A, B'],
  ['9-1', '一键 Debug：能进游戏，但有提示，改动 2 处，未找到 A、B', 'A, B not found'],
  ['9-1', 'a.jar、b.jar。可能正被占着，关掉占用它的程序后再试', 'a.jar, b.jar.'],
  ['9-1', '当前：视距 16、画质「极佳」、光影 Complementary、120 个 Mod；显卡：Intel UHD Graphics（认不出的 Intel 型号，按普通核显估计）。建议：视距降到 8；画质改成「流畅」；关掉光影，或换成轻量光影（如 Complementary 的低配置预设）', '120 mods', 'Intel UHD Graphics ('],
  ['9-1', '建议：① 用「纯净版+」装上 Sodium、Lithium 这类优化 Mod，原版玩法不变；② 减少 Mod 数量，或者换轻量整合包；③ 关掉浏览器、直播软件等后台程序；笔记本插上电源并切到高性能模式', '①', '②', '③'],
  ['9-1', 'Fabric API、Sodium 的可选搭配', 'Fabric API, Sodium'],
  ['9-1', 'Fabric API、Sodium 等 5 个 Mod 需要它', 'Fabric API, Sodium'],
  ['9-1', 'Sodium（含 2 个依赖）；旧的 a.jar、b.jar 已禁用', 'a.jar, b.jar'],
  ['9-1', '共改动 3 处；Modrinth 上找不到：a、b', 'a, b'],
  // 9-2 「N 个」被拆开
  ['9-2', '换了 3 个 Mod 的版本，Mod 已全部禁用', '3 mods'],
  ['9-2', '换了 3 个 Mod 的版本，禁用了 2 个找不到新版本的 Mod，1 个 Mod 处理失败，已禁用，已安装 Fabric API、Mod Menu，更新到 1.2.3', '3 mods', '2 mods', '1 mod '],
  ['9-2', '新增 2 个，禁用 1 个，重新启用 1 个，自动补齐前置：Fabric API、Mod Menu', '2 added', '1 disabled', '1 re-enabled', 'Fabric API, Mod Menu'],
  ['9-2', '1.20.1 Fabric：新增 2 个，删除 1 个，重新启用 1 个，自动补齐前置：Fabric API、Mod Menu；未能找到：C、D', '2 added', '1 deleted', '1 re-enabled', 'C, D'],
  ['9-2', '配置器修改：新增 2 个、禁用 1 个、重新启用 1 个，自动补齐 2 个前置', '2 added', '1 disabled', '1 re-enabled'],
  ['9-2', '有 2 个 Mod 没禁用成', '2 mods'],
  ['9-2', '1 个文件没还原成（可能正被占着）：a.jar、b.jar', '1 file', 'a.jar, b.jar'],
  // 9-3 下载详情和错误原因
  ['9-3', '下载游戏文件 12/300（1 个失败）', '12/300 (1 failed)'],
  ['9-3', '下载 Mod 12/300（2 个失败）', '12/300 (2 failed)'],
  ['9-3', '3 个文件下载失败：网络未连接', '3 files failed'],
  ['9-3', '3 个文件下载失败：网络错误：example.com/a.jar（ECONNRESET）', '3 files failed', 'Network error', '(ECONNRESET)'],
  ['9-3', '3 个文件下载失败：请求超时：example.com/a.jar', '3 files failed', 'timed out'],
  ['9-3', '磁盘空间不足：需要约 1.2 GB，C:\\ 只剩 300 MB', '1.2 GB', '300 MB'],
  ['9-3', '游戏启动后立即退出（代码 1）\n可能原因：缺少前置 Mod：请根据日志安装缺失的依赖\nline1', '(code 1)', 'line1'],
  // 原来就对的，不能被新的拆句顺序带坏
  ['回归', '下载 Sodium', 'Download Sodium'],
  ['回归', '下载 Fabric Loader 0.16.10 for Minecraft 1.20.1', 'Download Fabric Loader'],
  ['回归', '安装 1.20.1', 'Install 1.20.1'],
  ['回归', '3 个 Mod', '3 mods'],
  ['回归', '1 个 Mod', '1 mod'],
  ['回归', '12 分 30 秒', '12 min 30 s'],
  ['回归', '导入了 3 个世界', 'Imported 3 worlds'],
  ['回归', '版本 x 已存在', 'Version x already exists'],
  ['回归', '「1.20.1」的游戏已经开着了。要再启动一个实例吗？', '"1.20.1"', 'another instance'],
];
