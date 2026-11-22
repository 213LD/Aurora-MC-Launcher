'use strict';
/**
 * 内部版和公开版的版本号对应：内部版 2.x.y ↔ 公开版 1.x.y（主版本减 1），同号同代码。
 * 导出公开仓库、打公开版、文件里的版本比较、更新日志显示都用这里，规则只写一处。
 * 主进程和脚本 require，渲染进程用 <script> 加载（全局 EDITION）。
 */
(function (root, edition) {
  if (typeof module === 'object' && module.exports) module.exports = edition;
  else root.EDITION = edition;
})(typeof self !== 'undefined' ? self : this, (() => {
  const split = (v) => {
    const m = /^(\d+)(\..*)?$/.exec(String(v || '').trim());
    return m ? { major: +m[1], rest: m[2] || '' } : null;
  };
  /** 内部版的版本号 → 公开版的（2.0.0 → 1.0.0）；认不出来的原样返回 */
  const toPublic = (v) => { const p = split(v); return p && p.major >= 1 ? `${p.major - 1}${p.rest}` : String(v || ''); };
  /** 公开版的版本号 → 内部版的（1.0.0 → 2.0.0） */
  const toInternal = (v) => { const p = split(v); return p ? `${p.major + 1}${p.rest}` : String(v || ''); };
  /** 换成内部版的写法，好放在一起比大小；edition 不是 'public' 的都当内部版（公开以前导出的文件都是内部版） */
  const comparable = (v, edition) => (edition === 'public' ? toInternal(v) : String(v || ''));
  return Object.freeze({ toPublic, toInternal, comparable });
})());
