'use strict';
/**
 * 提醒栏：一条横栏汇总当前的问题。最高等级的图标 +「2 个严重冲突 · 3 个提醒」+ 每条问题一个小标签。
 *   A.alertBar({ items: [{ key, level, label }], ignored, onJump(key), onShowAll() }) → 元素；没有问题也没有忽略项时返回 null
 *   A.alertBar.cleared() → 问题刚刚全部处理完时显示一下再收起的绿色横栏
 * 配置器第 2 步在用；模组页的兼容性检查、一键 Debug 的结果以后也用它
 */
(function () {
  const { h, icon, t } = A;
  const ORDER = ['crit', 'warn', 'info'];
  const MAX_CHIPS = 6;

  function alertBar({ items = [], ignored = 0, onJump, onShowAll } = {}) {
    if (!items.length && !ignored) return null;
    if (!items.length) {
      return h('div.alertbar.quiet', { role: 'status' }, icon('eyeOff', 14), h('span', t('alertbar.ignoredOnly', { n: ignored })),
        onShowAll ? h('button.btn.sm.ghost', { onclick: onShowAll }, t('alertbar.showAll')) : null);
    }
    const top = ORDER.find((lv) => items.some((i) => i.level === lv)) || 'info';
    const n = (lv) => items.filter((i) => i.level === lv).length;
    const summary = [
      n('crit') ? t('alertbar.crit', { n: n('crit') }) : null,
      n('warn') ? t('alertbar.warn', { n: n('warn') }) : null,
      n('info') ? t('alertbar.info', { n: n('info') }) : null,
      ignored ? t('alertbar.ignored', { n: ignored }) : null,
    ].filter(Boolean).join(' · ');
    // 严重的排前面；标签太多时只放前几个，剩下的用「+N」代替
    const sorted = [...items].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
    const chips = sorted.slice(0, MAX_CHIPS).map((i) => h('button', {
      type: 'button', class: `ab-chip ${i.level}`, title: i.label, onclick: () => onJump && onJump(i.key),
    }, i.label));
    if (sorted.length > MAX_CHIPS) chips.push(h('button', { type: 'button', class: 'ab-chip more', onclick: () => onShowAll && onShowAll() }, `+${sorted.length - MAX_CHIPS}`));
    return h('div', { class: `alertbar ${top}`, role: 'status', 'aria-live': 'polite' },
      h('div.ab-ico', A.levelIcon(top, 18)),
      h('div.ab-main', h('div.ab-title', summary), h('div.ab-chips', chips)),
      onShowAll ? h('button.btn.sm.ghost', { onclick: onShowAll }, t('alertbar.showAll')) : null);
  }

  alertBar.cleared = () => h('div.alertbar.ok.closing', { role: 'status' }, h('div.ab-ico', A.levelIcon('ok', 18)), h('div.ab-title', t('alertbar.cleared')));

  A.alertBar = alertBar;
})();
