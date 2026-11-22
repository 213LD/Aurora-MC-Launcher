'use strict';
/*
 * 公开版的「MC 百科中文信息」（概念演示）：公开版不包含读取 MC 百科网页的代码，这里只展示这个想法。
 * 构建公开版（npm run dist:public）和导出公开仓库（scripts/export-public.js）时，用这个文件替换 src/renderer/js/mcmodui.js。
 * 接口和完整版一样（其他页面照常调用），但：中文名和中文搜索只用启动器自带的对照表（A.modNames）；
 * 设置里的开关是灰色的；向导、下载页搜索、Mod 详情里各有一行灰色说明。
 */
(function () {
  const { h } = A;

  const NOTICE = '概念演示：从 MC 百科（mcmod.cn）读取 Mod 的中文名、简介和评价。MC 百科没有公开接口，自动读取网页不适合放进公开发布的版本，'
    + '所以公开版不包含这部分代码，这里只是展示这个想法。中文名目前来自内置的对照表。';
  const SHORT = 'MC 百科中文信息是概念演示，公开版不包含这个功能';
  // 和完整版一样只在中文界面出现：MC 百科是给中文玩家查 Mod 中文名的，英文界面不显示设置卡片、向导和详情里的说明
  const zhUi = () => !window.I18N || window.I18N.getLang() === 'zh-CN';
  const line = () => (zhUi() ? h('span.faint.mcm-concept', SHORT) : null);

  const projOf = (p, source) => ({ source: source || p.source || 'modrinth', slug: p.slug, id: p.id, title: p.title });
  const keyOf = (p) => `${p.source === 'curseforge' ? 'cf' : 'mr'}:${String(p.slug || p.id || '').toLowerCase()}`;
  const none = async () => null;

  /** 设置：说明 + 灰色的开关 */
  function settingsRows(row) {
    const sw = A.toggle(false, null);
    const input = sw.querySelector('input');
    if (input) { input.disabled = true; input.setAttribute('aria-label', '从 MC 百科读取 Mod 中文信息（概念演示，不可用）'); }
    sw.classList.add('disabled');
    return [
      h('div.set-row.col', h('div.s-text', h('div.s-title', '说明'), h('div.s-desc', NOTICE))),
      row('从 MC 百科读取 Mod 中文信息', SHORT, sw),
    ];
  }

  /** 向导最后一步：一行灰色说明 */
  const setupNotice = () => (zhUi() ? A.alert({ level: 'info', compact: true, title: '概念演示：MC 百科中文信息', text: SHORT }) : null);

  /** 搜索框：只用本地对照表；对照表里没有的中文，提示试英文名，再附一行概念演示说明 */
  const resolveQuery = async (raw) => A.modNames.expand(String(raw || '').trim());
  function matchBar(ex, current, onPick) {
    if (ex.matches && ex.matches.length) {
      return [h('span.faint', `「${ex.original}」按中文名 / 缩写匹配到：`),
        ex.matches.map((m) => h('button', { class: `mn-chip ${m.en === current ? 'on' : ''}`, onclick: () => onPick(m.en) }, m.zh, h('span.faint', ` ${m.en}`)))];
    }
    if (!ex.missed) return null;
    return [h('span.faint', `启动器自带的中文名对照表里还没有「${String(ex.query || '').trim()}」，可以试试英文名。`), line()];
  }

  /** Mod 详情：一行灰色说明 */
  const detailBlock = () => (zhUi() ? h('div.mcm-box', line()) : null);

  A.mcmodUi = {
    zhUi, CONCEPT: true, TITLE: 'MC 百科中文信息（概念演示）', NOTICE, RISKS: [],
    on: () => false, consented: () => false, enable: async () => false, consentDialog: async () => false, checkConsent() {}, askOnce: none,
    precacheDialog() {}, settingsRows, setupNotice, debugLimits: none, resetLimits: none,
    cachedMap: async () => new Map(), fillZh: async () => {}, setZh: () => {}, searchZh: async () => [], searchOnce: none,
    resolveQuery, matchBar, detailBlock, keyOf, projOf, riskList: () => null,
  };
})();
