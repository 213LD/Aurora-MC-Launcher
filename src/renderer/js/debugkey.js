'use strict';
/* 公开版的替身（内部版是 src/renderer/js/debugkey.js）：公开版的调试菜单没有密码，设置 → 关于里连点版本号 7 次直接打开。
 * 没有密码的菜单里没有「安全限制」那一节（危险操作不用等、MC 百科跳过风险确认和改限速），见 debugmenu.js 的 trusted()。
 * 自己构建时想加密码：把 hash 换成 sha256(salt + 你的密码) 的十六进制小写 */
(function () {
  A.debugKey = { PUBLIC_STANDIN: true, salt: 'aurora-dbg:', hash: '' };
})();
