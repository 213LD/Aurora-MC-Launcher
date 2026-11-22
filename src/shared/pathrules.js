'use strict';
/**
 * 文件名的规则（2.0.0-pre2）。以前主进程和界面各写各的：有的只换非法字符、有的按下标截断，
 * 截断可能落在 emoji 中间，或者留下结尾的点，安装到一半才报「版本名称包含非法字符」。
 * 主进程 require，渲染进程用 <script> 加载（全局 PATHRULES，A.safeName、A.nameProblem）。
 */
(function (root, api) {
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PATHRULES = api;
})(typeof self !== 'undefined' ? self : this, (function () {
  // Windows 不能用的字符和控制字符，加上分号：配置名会进 -cp 和 java.library.path，那两个都用分号分隔
  const ILLEGAL = /[\\/:*?"<>|;\u0000-\u001f]/;
  const ILLEGAL_ALL = new RegExp(ILLEGAL.source, 'g');
  const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  /** 按看到的字符数截断，不会切开 emoji 和组合字符。超长时结尾放 tail，总长（连 tail）不超过 max */
  function cutChars(text, max, tail = '') {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    const room = Math.max(0, max - Array.from(tail).length);
    const parts = [];
    if (segmenter) {
      for (const { segment } of segmenter.segment(s)) {
        parts.push(segment);
        if (parts.length > max) return parts.slice(0, room).join('') + tail;
      }
    } else {
      for (const ch of s) {
        parts.push(ch);
        if (parts.length > max) return parts.slice(0, room).join('') + tail;
      }
    }
    return s;
  }

  const isDeviceName = (name) => DEVICE.test(String(name || '').trim());

  /** 把任意文字变成能当文件夹或文件名的名字：非法字符换成 _，按字符截断，去掉结尾的点和空格，避开设备名 */
  function safeName(name, { max = 60, fallback = '未命名' } = {}) {
    let n = String(name == null ? '' : name).replace(ILLEGAL_ALL, '_').trim();
    n = cutChars(n, max).replace(/[. ]+$/, '').trim();
    if (!n) return fallback;
    return isDeviceName(n) ? `_${n}` : n;
  }

  /** 这个名字有什么问题，没问题返回 null。empty 空的；illegal 有非法字符或结尾是点、空格；device 设备名；long 太长 */
  function nameProblem(name, { max = 80 } = {}) {
    const n = String(name == null ? '' : name);
    if (!n.trim()) return 'empty';
    if (ILLEGAL.test(n) || /[. ]$/.test(n)) return 'illegal';
    if (isDeviceName(n)) return 'device';
    if (Array.from(n).length > max) return 'long';
    return null;
  }

  /** 给玩家看的话（界面校验和主进程共用） */
  const PROBLEM_TEXT = { empty: '名称不能为空', illegal: '名称不能包含 \\ / : * ? " < > | ; ，结尾也不能是点或空格', device: '这个名字是 Windows 保留的，换一个吧', long: '名称太长了' };
  const problemText = (name, opts) => { const p = nameProblem(name, opts); return p ? PROBLEM_TEXT[p] : null; };

  return Object.freeze({ cutChars, safeName, nameProblem, problemText, isDeviceName, ILLEGAL });
})());
