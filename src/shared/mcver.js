'use strict';
/**
 * Minecraft 版本比较（1.10.8 统一）。以前主进程和界面有三份，规则不一样，同一对版本三处结果不同。
 * 主进程 require，渲染进程用 <script> 加载（全局 MCVER，A.cmpMc）。
 */
(function (root, api) {
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MCVER = api;
})(typeof self !== 'undefined' ? self : this, (function () {
  function parse(v) {
    const s = String(v).trim();
    // 1.20.1、1.21-pre1（预发布按对应的正式版算）、26.3（2026 年起版本号改成年份）
    let m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
    // Alpha / Beta / Classic / Indev / Infdev / 最早的 rd-：比现代版本都旧
    if (/^(?:rd-|inf-|in-|[abc]\d)/i.test(s)) return [0, 0, 0];
    // 旧式快照 24w14a：排在所有 1.x 后面、26.x 前面，快照之间按时间比
    m = s.match(/^(\d\d)w(\d\d)/);
    if (m) return [1, 1000 + Number(m[1]), Number(m[2])];
    // 认不出来的按最新算：宁可多提醒一次版本更新
    return [999, 0, 0];
  }

  /** a 比 b 新返回 1，旧返回 -1，相同返回 0；有一边不知道版本也返回 0（不提醒） */
  function cmpMc(a, b) {
    if (!a || !b) return 0;
    const x = parse(a); const y = parse(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
  }

  return Object.freeze({ cmpMc });
})());
