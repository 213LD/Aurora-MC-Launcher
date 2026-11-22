'use strict';
/**
 * 界面翻译（多语言，1.10.0）。代码里的界面文字照旧写简体中文（它就是「原文」），这里在显示的时候换成当前语言：
 * - 字典 I18N_TR[语言] = { 中文原文: 译文 }（src/shared/i18n/tr-*.js）。原文里的 {0} {1}… 是模板字符串里的 ${…}，
 *   匹配时当通配，捕获到的部分如果本身也在字典里（比如嵌进去的术语）也一起翻
 * - MutationObserver 盯着整个页面：新加的文字节点、改了的文字、placeholder / title / aria-label / data-tip / alt 属性都翻。
 *   主进程发来的提示、任务标题、错误信息到了界面上也一样翻
 * - 玩家起的、来自内容的名字不翻（2.0.0-pre6）：代码放进文字时用 A.nm 包起来（shared/i18n 的 nm），这里先把它们换成占位记号，
 *   翻完再换回去。只看字符串分不清「设置」是界面文字还是配置名，所以不能靠名单
 * - 不翻的地方：标了 data-no-tr 的元素（游戏日志、玩家自己输入的内容、语言名字），输入框里的内容，script / style
 * - 简体中文界面什么都不做
 * 新加界面文字以后：跑 python scripts/i18n.py check 看哪些还没有译文（找不到译文时显示原文）
 */
(function () {
  const lang = window.I18N ? window.I18N.getLang() : 'zh-CN';
  const api = { lang, tr: (s) => s, run() {}, missing: () => [] };
  window.I18N_TRANSLATE = api;
  if (lang === 'zh-CN') return;
  const dict = (window.I18N_TR || {})[lang] || {};
  const CJK = /[一-鿿]/;
  const exact = new Map();
  const outputs = new Set();
  const patterns = []; // [{ re, order: 原文里占位符的名字, dst, need, weight }]
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const PH = /\{(\w+)\}/g; // 占位符：模板的 {0} {1}…，t() 字典的 {name} {n}…
  // 繁体字典带一张单字对照表（__chars：简繁两两一组），字典里没有的文字按字转换，所以繁体不记「缺译文」
  const chars = new Map();
  // 按字（码点）取：表里有超出基本平面的生僻字，按 JS 下标取会从那里开始全部错位（1.10.6 修，以前「账户」会变成「賬账」）
  const charPairs = [...(dict.__chars || '')];
  for (let i = 0; i + 1 < charPairs.length; i += 2) chars.set(charPairs[i], charPairs[i + 1]);
  function addEntry(src, dst) {
    outputs.add(dst);
    if (/\{\w+\}/.test(src)) {
      const re = new RegExp(`^${src.split(/\{\w+\}/).map(esc).join('([\\s\\S]*?)')}$`);
      const order = [...src.matchAll(PH)].map((m) => m[1]);
      // 静态部分最长的放前面（更具体的先匹配）；need 是最长的一段静态文字，先用 includes 粗筛，省得每个都跑正则
      const need = src.split(/\{\w+\}/).sort((x, y) => y.length - x.length)[0];
      patterns.push({ re, order, dst, need, weight: src.replace(PH, '').length });
    } else if (!exact.has(src)) exact.set(src, dst);
  }
  for (const [src0, dst0] of Object.entries(dict)) {
    if (!dst0 || src0 === '__chars') continue;
    // 查字典之前会去掉两头的空白（lookup），所以字典这边也去掉（1.10.5：以前带空白的词条永远查不到，比如「其他启动器 」）
    // 原文没有空白时译文的空白要留着（中文紧挨着的「个 Mod」「（自动）」，英文前面要空一格）
    const src = src0.trim(); const dst = src === src0 ? dst0 : dst0.trim();
    if (!src) continue;
    addEntry(src, dst);
    // 「，未找到 {0}」这种带前导标点的片段：按标点拆句以后前面的标点没了，也要查得到（1.10.8）
    const bare = src.replace(/^[，；、。]/, '');
    if (bare && bare !== src && !dict[bare]) addEntry(bare, dst.replace(/^[,;.，；、。]\s*/, ''));
  }
  patterns.sort((a, b) => b.weight - a.weight);
  const missed = new Set();

  /** 按模板匹配：accept 决定这一轮用哪些模板 */
  function byPattern(s, accept, sameClause) {
    for (const p of patterns) {
      if (!accept(p) || (p.need && !s.includes(p.need))) continue;
      const m = s.match(p.re);
      if (!m) continue;
      // sameClause：通配的部分不能跨句（「新增 {0} 个」不能把「2 个，禁用 1 个」整个当成 {0}）
      if (sameClause && m.slice(1).some((a) => /[\n。；，]/.test(a))) continue;
      const args = m.slice(1).map((a) => (CJK.test(a) ? tr(a) : a));
      const out = p.dst.replace(PH, (x, n) => { const i = p.order.indexOf(n); return i >= 0 && args[i] != null ? args[i] : x; });
      // 英文单复数：译文统一写复数，数量是 1 时改回单数（1 profiles → 1 profile，1 entries → 1 entry）
      return lang === 'en' ? out.replace(/(^|[^\d.,])1 ([A-Za-z]+?)(ies|s)\b/g, (x, a, w, e) => `${a}1 ${w}${e === 'ies' ? 'y' : ''}`) : out;
    }
    return null;
  }
  // 英文拼回去时换成英文标点，繁体保持全角（以前繁体也换，混进半角逗号）
  const JOIN = lang === 'en' ? { '。': '. ', '；': '; ', '，': ', ', '：': ': ', '、': ', ' } : {};
  function bySeparator(s, seps) {
    for (const sep of seps) {
      if (!s.includes(sep)) continue;
      const parts = s.split(sep);
      const done = parts.map((x) => (x && CJK.test(x) ? lookup(x) : x));
      if (done.every((x) => x != null)) return JOIN[sep] ? done.join(JOIN[sep]).trim() : done.join(sep);
    }
    return null;
  }
  const CLAUSE_SEPS = ['\n', ' · ', '。', '；', '，', '：'];
  const LIST_SEPS = ['、'];
  const WORD_SEPS = [' ', '+'];
  /**
   * 翻一段文字：先整句查，再按下面的顺序一步步试，运行时拼出来的句子（「独立显卡 NVIDIA …」「性能优化+实用增强」）靠拆开分别查。
   * 顺序有讲究（1.10.8）：
   * 1. 静态文字占句子大头的模板，或者有几个字静态文字、通配部分又不跨句的模板（「加载失败：{0}」）：整句就是这个模板
   * 2. 按句号、分号、逗号、冒号拆：一段话里每一句分开翻
   * 3. 有几个字静态文字的模板：「{0} 的可选搭配」的 {0} 可能是「A、B」这样的列表，要整个填进去，所以排在按「、」拆之前
   * 4. 按「、」拆：列表的每一项
   * 5. 其余模板：「{0} 个{1}」这种几乎全是通配的。以前它们排在拆句前面，一整段话只要带个「个」就被吃掉，后面每一段都翻不成（「新增 2 , Disable 1 , …」）
   * 6. 按空格和 + 拆：太弱，放最后（「下载 Sodium」不能拆成两个词）
   */
  function core(s) {
    const hit = exact.get(s);
    if (hit != null) return hit;
    let r = byPattern(s, (p) => p.weight >= s.length * 0.4);
    if (r == null) r = byPattern(s, (p) => p.weight >= 4, true);
    if (r == null) r = bySeparator(s, CLAUSE_SEPS);
    if (r == null) r = byPattern(s, (p) => p.weight >= 3);
    if (r == null) r = bySeparator(s, LIST_SEPS);
    if (r == null) r = byPattern(s, () => true);
    if (r == null) r = bySeparator(s, WORD_SEPS);
    return r;
  }
  function lookup(s) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    let r = core(m[2]);
    const num = r == null && m[2].match(/^([①-⑳]\s*)([\s\S]+)$/);
    if (num) { const x = core(num[2]); if (x != null) r = num[1] + x; }
    return r == null ? null : m[1] + r + m[3];
  }
  // 英文句子里留下的中文标点（玩家起的名字、文件名之间的「、」，模板里没写到的括号）和拼接多出来的空格
  const tidy = (x) => x.replace(/、/g, ', ').replace(/；/g, '; ').replace(/：/g, ': ').replace(/（/g, ' (').replace(/）/g, ')').replace(/(\S) {2,}(?=\S)/g, '$1 ');
  // 名字：换成不含中文的记号再翻，翻完换回去。记号不会被拆句，也不会被当成字典词
  const NM_L = '\u2068'; const NM_R = '\u2069';
  const NM_RE = /\u2068([^\u2068\u2069]*)\u2069/g;
  function tr(s) {
    if (s && s.includes(NM_L)) {
      const saved = [];
      const masked = s.replace(NM_RE, (x, n) => { saved.push(n); return `\uE000${saved.length - 1}\uE001`; });
      return trPlain(masked).replace(/\uE000(\d+)\uE001/g, (x, i) => saved[+i]).replace(/[\u2068\u2069]/g, '');
    }
    return trPlain(s);
  }
  function trPlain(s) {
    if (!s || !CJK.test(s) || outputs.has(s)) return s;
    const r = lookup(s);
    if (r != null) return lang === 'en' ? tidy(r) : r;
    if (chars.size) {
      let o = '';
      for (const c of s) o += chars.get(c) || c;
      if (outputs.size < 50000) outputs.add(o);
      return o;
    }
    if (missed.size < 5000 && !missed.has(s)) { missed.add(s); }
    return s;
  }

  const ATTRS = ['placeholder', 'title', 'aria-label', 'aria-description', 'data-tip', 'alt'];
  const skip = (el) => !!(el && el.closest && el.closest('[data-no-tr], script, style, textarea'));
  // 带名字的文字翻完以后，这个节点或属性上的内容不能再翻一遍（这时候标记已经去掉了，名字会被当成界面文字）
  const doneText = new WeakMap();
  const doneAttr = new WeakMap();
  function doText(node) {
    const v = node.nodeValue;
    if (!v) return;
    if (doneText.get(node) === v) return;
    const marked = v.includes(NM_L);
    if (!marked && (!CJK.test(v) || outputs.has(v))) return;
    const p = node.parentElement;
    if (skip(p)) { if (marked) node.nodeValue = v.replace(/[\u2068\u2069]/g, ''); return; }
    const r = tr(v);
    if (marked) doneText.set(node, r);
    if (r !== v) node.nodeValue = r;
  }
  function doAttrs(el) {
    const skipped = !!(el && el.closest && el.closest('[data-no-tr], script, style')); // textarea 的内容不翻，但它的 placeholder、title 要翻
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      const seen = doneAttr.get(el);
      if (seen && seen[a] === v) continue;
      const marked = v.includes(NM_L);
      if (skipped) { if (marked) el.setAttribute(a, v.replace(/[\u2068\u2069]/g, '')); continue; }
      if (marked || CJK.test(v)) {
        const r = tr(v);
        if (marked) { const m = seen || {}; m[a] = r; doneAttr.set(el, m); }
        if (r !== v) el.setAttribute(a, r);
      }
    }
  }
  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    // 不翻译的区域也走一遍：textarea 的属性要翻，data-no-tr 里的名字标记要去掉（doText、doAttrs 自己判断）
    doAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 3) doText(n);
      else doAttrs(n);
    }
  }
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') { if (ATTRS.includes(m.attributeName)) doAttrs(m.target); }
      else for (const n of m.addedNodes) walk(n);
    }
  });
  function run() {
    walk(document.documentElement);
    obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    document.title = tr(document.title);
  }
  Object.assign(api, { tr, run, missing: () => [...missed] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
