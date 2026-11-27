'use strict';
/**
 * 网址和微软登录 Client ID 的小规则：主进程和界面以前各抄了一份（http 升 https 的写法有五份）。
 * 主进程 require，渲染进程用 <script> 加载（全局 WEBURL）。
 */
(function (root, api) {
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WEBURL = api;
})(typeof self !== 'undefined' ? self : this, (function () {
  // Mojang 给的皮肤、披风地址是 http：升成 https（有的网络环境拦 http）。本机地址（测试、皮肤服务）照旧
  const LOCAL = /^http:\/\/(?!127\.0\.0\.1(?::|\/|$)|localhost(?::|\/|$))/i;
  /** http 升成 https；不是字符串的原样返回 */
  const toHttps = (u) => (typeof u === 'string' ? u.replace(LOCAL, 'https://') : u);

  // Azure 应用的「应用程序(客户端) ID」：一个 GUID（带不带连字符都认）
  const CLIENT_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
  const isClientId = (v) => typeof v === 'string' && CLIENT_ID.test(v.trim());

  return Object.freeze({ toHttps, isClientId });
})());
