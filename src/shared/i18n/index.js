'use strict';
/**
 * 多语言：t(key, vars) 按当前语言查字典，缺失时回退到简体中文。
 * 插值写 {name}；值也可以是列表或对象（提示、标语这类一组文字），t() 原样返回。主进程 require('../shared/i18n')，渲染进程用 <script> 依次加载 zh-CN.js、en.js、index.js（全局 I18N）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./zh-CN'), require('./en'));
  else {
    root.I18N = factory(root.I18N_DICTS['zh-CN'], root.I18N_DICTS.en);
    // 主进程加载页面时把语言放在网址参数里（?lang=），这样各脚本一加载就能用对语言
    const q = root.location && new URLSearchParams(root.location.search).get('lang');
    if (q) root.I18N.setLang(q);
  }
})(typeof self !== 'undefined' ? self : this, (zh, en) => {
  const DICTS = { 'zh-CN': zh, en };
  // 1.10.0：界面文字的翻译主要靠 renderer/js/translate.js 按原文换（字典 tr-*.js）；这里的 t() 键值字典只有简中和一部分英文，
  // 其他语言 t() 先给简中原文，显示时再被 translate.js 换掉。short 是顶栏语言按钮上的字
  const LANGS = [
    // 其他语言暂时禁用：配置里存着的不改写，按简体中文显示
    { id: 'zh-CN', name: '简体中文', short: '简', game: 'zh_cn', ready: true },
    { id: 'en', name: 'English', short: 'EN', game: '', ready: true },
  ];
  let lang = 'zh-CN';
  const warned = new Set();

  /** 把设置里的语言（'auto' 或语言 id）和系统语言解析成实际使用的语言 */
  function resolve(pref, locale) {
    const ok = (id) => LANGS.some((l) => l.id === id && l.ready);
    if (pref && pref !== 'auto') return ok(pref) ? pref : 'zh-CN';
    // 跟随系统：所有中文都是简中，其他 → English
    return /^zh/i.test(String(locale || '')) ? 'zh-CN' : 'en';
  }

  function setLang(id) {
    lang = LANGS.some((l) => l.id === id) ? id : 'zh-CN';
    return lang;
  }

  function t(key, vars) {
    let s = (DICTS[lang] || {})[key];
    // 渲染进程加载了界面翻译字典（tr-*.js）时，用它翻简中原文，和界面上别处的同一句保持一致
    const tr = lang !== 'zh-CN' && typeof globalThis !== 'undefined' && globalThis.I18N_TR && globalThis.I18N_TR[lang];
    if (tr && typeof zh[key] === 'string' && tr[zh[key]]) s = tr[zh[key]];
    if (s == null) {
      s = zh[key];
      // 不是简中时回退到简中是正常的（translate.js 显示时再翻），只有键根本不存在才提醒
      if (!warned.has(key) && s == null) {
        warned.add(key);
        if (typeof console !== 'undefined') console.warn(`[i18n] 缺少 ${lang} 的「${key}」`);
      }
      if (s == null) return key;
    }
    // 字典里也可以放列表或对象（例如提示、标语），原样返回
    if (typeof s !== 'string') return s;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s;
  }

  // 玩家起的、来自内容的名字（配置、账户、世界、Mod、文件名……）放进要显示的文字时用 nm 包起来（2.0.0-pre6）：
  // 翻译器看到标记就把这一段整个跳过，不管它是不是字典词、里面有没有分隔符。标记是不可见的方向隔离符，到界面上会去掉。
  // 简体中文界面不翻译，什么都不加。不要用在文件名、接口参数、输入框默认值上
  const nm = (s) => (typeof s === 'string' && s && lang !== 'zh-CN' ? `\u2068${s}\u2069` : s);

  // ── 结构化消息（现在做） ──
  // 主进程拼句子不再自己 join 成中文再让界面拆开猜，而是 msg(模板, 参数)：模板是简中原句，{名字} 占位；
  // 参数可以是文字、名字（nm 包过的，原样）、数字、列表（按语言用「、」或「, 」连）。按当前语言直接出成句：
  // 不是简中时查界面翻译字典（tr-*.js；主进程由 useTr 注册的加载函数读进来）里这个模板的译文，再填参数，参数里的词也查字典
  const SEPS = { list: { 'zh-CN': '、', en: ', ' }, clause: { 'zh-CN': '；', en: '; ' }, comma: { 'zh-CN': '，', en: ', ' }, colon: { 'zh-CN': '：', en: ': ' } };
  const sepOf = (kind) => (SEPS[kind] || SEPS.list)[lang] || (SEPS[kind] || SEPS.list)['zh-CN'];
  const trDict = () => (lang !== 'zh-CN' && typeof globalThis !== 'undefined' && globalThis.I18N_TR && globalThis.I18N_TR[lang]) || null;
  const word = (s) => { const d = trDict(); return d && typeof s === 'string' && !s.includes('\u2068') && d[s] != null ? d[s] : s; };
  /** 列表：kind 是 list（、）、clause（；）、comma（，）、colon（：），空的项去掉 */
  const join = (items, kind = 'list') => (items || []).filter((x) => x != null && x !== '').map((x) => word(String(x))).join(sepOf(kind));
  function msg(tpl, args = {}) {
    const d = trDict();
    const pattern = (d && typeof d[tpl] === 'string' && d[tpl]) || tpl;
    const out = pattern.replace(/\{(\w+)\}/g, (m, k) => {
      const v = args[k];
      if (v == null) return m;
      if (Array.isArray(v)) return join(v);
      return typeof v === 'number' ? String(v) : word(String(v));
    });
    // 英文译文统一写复数，数量是 1 时改回单数（和 translate.js 一样）
    return lang === 'en' ? out.replace(/(^|[^\d.,])1 ((?:[a-z]+ )?)([A-Za-z]+?)(ies|s)\b/g, (x, a, mid, w, e) => `${a}1 ${mid}${w}${e === 'ies' ? 'y' : ''}`) : out;
  }
  const nmJoin = (list, sep) => (list || []).map(nm).join(sep || sepOf('list'));
  // 主进程没有 window：语言换成非简中时，由主进程注册的函数把 tr-*.js 读进 globalThis.I18N_TR
  let trLoader = null;
  const useTr = (fn) => { trLoader = fn; if (lang !== 'zh-CN') trLoader(lang); };
  const setLangAndLoad = (id) => { const r = setLang(id); if (trLoader && r !== 'zh-CN') trLoader(r); return r; };
  return { LANGS, DICTS, t, setLang: setLangAndLoad, resolve, getLang: () => lang, nm, nmJoin, msg, join, useTr };
});
