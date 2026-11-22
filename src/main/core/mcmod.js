'use strict';
/**
 * 公开版的 MC 百科模块（概念演示）：公开版不包含读取 MC 百科网页的代码。
 * 构建公开版（npm run dist:public）和导出公开仓库（scripts/export-public.js）时，用这个文件替换 src/main/core/mcmod.js。
 * 不注册任何 IPC；界面那边（renderer/js/mcmodui.js 的公开版）也不会调用。
 */
module.exports = { CONCEPT: true, register() {} };
