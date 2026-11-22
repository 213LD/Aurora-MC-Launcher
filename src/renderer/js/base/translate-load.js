'use strict';
/* 界面翻译的字典只加载当前语言那一份（每份几百 KB，简体中文不用加载）；字典加载完 translate.js 才开始翻 */
(function () {
  const l = window.I18N && window.I18N.getLang();
  if (l && l !== 'zh-CN') document.write(`<script src="../shared/i18n/tr-${l}.js"><\/script>`);
})();
