'use strict';
/**
 * Mod 配置器第 2 步的冲突：冲突卡片、清单里 Mod 行的标记、底部提醒栏、忽略与恢复。
 * 主进程给每条冲突带了 type 和稳定的 key（core/planner.js）。
 * warn（功能重复、已过时）可以忽略，忽略的 key 存在清单的 plan.ignored[]，跟清单一起保存；crit 不能忽略。
 * ctx = { plan, byId, setSelected(id, on), onChange() }：onChange 负责保存清单并重新渲染
 */
(function () {
  const { h, icon, t } = A;
  const TYPE_LABEL = { incompatible: 'conflict.incompatible', known: 'conflict.known', 'dep-unsupported': 'conflict.depUnsupported', overlap: 'conflict.overlap', obsolete: 'conflict.obsolete', jar: 'conflict.incompatible' };

  const canIgnore = (c) => c.severity === 'warn' && !!c.key;
  const isIgnored = (plan, c) => canIgnore(c) && (plan.ignored || []).includes(c.key);
  const idsOf = (c) => c.projects || [c.a, c.b].filter(Boolean);
  const typeLabel = (c) => t(TYPE_LABEL[c.type] || 'conflict.known');

  /** 拆成还要处理的（active）和已忽略的（ignored） */
  function split(plan, r) {
    const all = (r && r.conflicts) || [];
    return { active: all.filter((c) => !isIgnored(plan, c)), ignored: all.filter((c) => isIgnored(plan, c)) };
  }

  /**
   * projectId / slug → { level, label, key }：滚动清单时也能看出是哪几个 Mod 有问题；一个 Mod 有多条时取最严重的。
   * 冲突里是 Modrinth 的项目 id，清单里有的条目只有 slug（byId 是分析结果 id → 条目），所以两种都记
   */
  function marks(active, byId) {
    const m = new Map();
    const put = (k, v) => { const cur = m.get(k); if (k && (!cur || (cur.level !== 'crit' && v.level === 'crit'))) m.set(k, v); };
    for (const c of active) {
      const v = { level: A.level(c.severity), label: typeLabel(c), key: c.key };
      for (const id of idsOf(c)) { put(id, v); put((byId && byId.get(id) || {}).slug, v); }
    }
    return m;
  }

  function card(c, ctx) {
    const { plan, byId, setSelected, onChange } = ctx;
    const nameOf = (id) => (byId.get(id) || plan.items.find((i) => i.projectId === id) || {}).title || id;
    const removable = (id) => plan.items.some((i) => i.projectId === id && i.selected);
    const acts = [];
    if (c.a && c.b) { for (const id of [c.a, c.b]) if (removable(id)) acts.push(h('button.btn.sm', { onclick: () => setSelected(id, false) }, `移除 ${A.nm(nameOf(id))}`)); }
    else if (c.projects) { for (const id of c.projects) if (removable(id)) acts.push(h('button.btn.sm', { onclick: () => { for (const o of c.projects) if (o !== id) setSelected(o, false); } }, `只保留 ${A.nm(nameOf(id))}`)); }
    else if (c.a && removable(c.a)) acts.push(h('button.btn.sm', { onclick: () => setSelected(c.a, false) }, `移除 ${A.nm(nameOf(c.a))}`));
    if (canIgnore(c)) {
      acts.push(h('button.btn.sm.ghost', { 'data-tip': t('conflict.ignoreTip'), onclick: () => { plan.ignored = [...new Set([...(plan.ignored || []), c.key])]; onChange(); } }, icon('eyeOff', 14), t('conflict.ignore')));
    }
    const lv = A.level(c.severity);
    return h('div', { class: `issue ${lv}`, 'data-ckey': c.key || '' },
      h('div.issue-ico', A.levelIcon(lv, 18)),
      h('div.issue-body', h('div.issue-title', h('span.conf-type', typeLabel(c)), c.title), h('div.issue-detail', c.detail)),
      acts.length ? h('div.issue-actions', acts) : null);
  }

  /** 冲突区：还要处理的卡片 + 底部一行「已忽略 N 项 · 恢复」 */
  function section(r, ctx) {
    const { active, ignored } = split(ctx.plan, r);
    if (!active.length && !ignored.length) return null;
    return h('div.pl-conflicts', { id: 'pl-conflicts' },
      active.map((c) => card(c, ctx)),
      ignored.length ? h('div.pl-ignored', icon('eyeOff', 14), h('span', t('conflict.ignoredCount', { n: ignored.length })),
        h('button.btn.sm.ghost', { onclick: () => { ctx.plan.ignored = []; ctx.onChange(); } }, t('conflict.restore'))) : null);
  }

  /** 滚到对应的冲突卡片并闪一下；没有 key 时滚到冲突区开头 */
  function jump(key) {
    const el = (key && document.querySelector(`.issue[data-ckey="${CSS.escape(key)}"]`)) || document.getElementById('pl-conflicts');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  /** 底部提醒栏 */
  function bar(r, plan) {
    const { active, ignored } = split(plan, r);
    return A.alertBar({
      items: active.map((c) => ({ key: c.key, level: A.level(c.severity), label: c.title })),
      ignored: ignored.length,
      onJump: jump,
      onShowAll: () => jump(null),
    });
  }

  A.plannerConflicts = { split, marks, section, bar, jump };
})();
