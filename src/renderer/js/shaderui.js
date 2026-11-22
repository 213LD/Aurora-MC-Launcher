'use strict';
/* 下载页的光影：性能 / 特性 / 风格筛选和「适合这台电脑」徽章（1.5.9，B1）
 * Modrinth 的性能标签是「有这一档的预设」，按最低一档和这台电脑能带动的档次比；
 * CurseForge 没有性能标签，借 Modrinth 上同名光影的标签（主进程 shaderfit.borrow） */
(function () {
  const { h, api } = A;

  const LEVELS = ['potato', 'low', 'medium', 'high', 'screenshot'];
  const LEVEL_NAMES = { potato: '土豆', low: '低', medium: '中', high: '高', screenshot: '截图级' };
  const FEATS = ['path-tracing', 'pbr', 'reflections', 'shadows', 'colored-lighting', 'bloom', 'atmosphere', 'foliage'];
  const STYLES = ['vanilla-like', 'semi-realistic', 'realistic', 'fantasy', 'cartoon', 'cursed'];
  // CurseForge 光影只有这三个分类（名字 → 对应的 Modrinth 风格）
  const CF_STYLES = { 'vanilla-like': 'vanilla', realistic: 'realistic', fantasy: 'fantasy' };
  const LABEL = { 'path-tracing': '光追（路径追踪）', cursed: '整活' };
  const label = (tag) => LABEL[tag] || A.tagLabel(tag);

  // 筛选状态（风格只能选一个：CurseForge 一次只能按一个分类查）
  const sf = { perf: new Set(), feat: new Set(), style: '', fitOnly: false };
  let machineP = null;
  let cfCatsP = null;
  const borrowed = new Map();

  /** 这台电脑能带动哪一档：{ level, tier, gpu, conf, reason }；检测要几秒，只做一次 */
  const machine = () => (machineP = machineP || api('mods:shaderMachine').catch(() => null));

  /** 性能标签 → 判断：{ kind: fit | heavy | unknown, text, tip, pick } */
  function verdict(tags, m, from) {
    const have = LEVELS.map((l, i) => ((tags || []).includes(l) ? i : -1)).filter((i) => i >= 0);
    const src = from ? `（性能信息来自 Modrinth 上的同名光影「${from}」）` : '';
    if (!have.length) return { kind: 'unknown', text: '性能未知', tip: from === null ? '在 Modrinth 上没找到同名光影，不知道它的性能档次' : `作者没有标性能档次${src}` };
    if (!m) return null;
    const lowest = have[0];
    const pt = (tags || []).includes('path-tracing') && m.tier < 3 ? '；它带路径追踪（光追）效果，在这张显卡上帧数会比较低' : '';
    const guess = m.conf && m.conf !== 'known' ? '（显卡档次是按型号推算的）' : '';
    if (m.level >= lowest) {
      const pick = have.filter((i) => i <= m.level && i < 4).pop();
      return {
        kind: 'fit', text: '适合这台电脑', pick: LEVELS[pick],
        tip: `${m.reason}${guess}；这个光影有「${have.map((i) => LEVEL_NAMES[LEVELS[i]]).join(' / ')}」档预设，进游戏后在光影设置里选「${LEVEL_NAMES[LEVELS[pick]]}」档${pt}${src}`,
      };
    }
    return { kind: 'heavy', text: '可能带不动', tip: `${m.reason}${guess}；这个光影最低也是「${LEVEL_NAMES[LEVELS[lowest]]}」档${src}` };
  }

  /** 卡片上的徽章位置，fill() 之后填上 */
  const slot = (p) => h('span.sf-slot', { 'data-sid': p.id });

  /** 填徽章；CurseForge 先借标签。fitOnly 时 CurseForge 把不适合的卡片藏起来，返回藏了几个 */
  async function fill(root, hits, isCf) {
    const m = await machine();
    if (isCf) {
      const need = hits.filter((p) => !borrowed.has(p.id)).map((p) => ({ id: p.id, title: p.title, slug: p.slug }));
      if (need.length) {
        const r = await api('mods:shaderBorrow', need).catch(() => ({}));
        for (const p of need) borrowed.set(p.id, r[p.id] || null);
      }
    }
    let hidden = 0;
    for (const p of hits) {
      const el = root.querySelector(`.sf-slot[data-sid="${CSS.escape(String(p.id))}"]`);
      if (!el) continue;
      const b = isCf ? borrowed.get(p.id) : null;
      const v = verdict(isCf ? b && b.tags : p.tags, m, isCf ? (b ? b.title : null) : undefined);
      A.clear(el);
      if (v) el.appendChild(h(`span.badge${v.kind === 'fit' ? '.ok' : v.kind === 'heavy' ? '.warn' : ''}`, { 'data-tip': v.tip, title: v.tip }, v.text));
      const card = el.closest('.res-card');
      const hide = isCf && sf.fitOnly && (!v || v.kind !== 'fit');
      if (card) card.style.display = hide ? 'none' : '';
      if (hide) hidden++;
    }
    return hidden;
  }

  async function cfCategoryId(style) {
    if (!style || !CF_STYLES[style]) return undefined;
    cfCatsP = cfCatsP || api('curseforge:categories', 'shader').catch(() => { cfCatsP = null; return []; });
    const c = (await cfCatsP).find((x) => String(x.name).toLowerCase().startsWith(CF_STYLES[style]));
    return c ? c.id : undefined;
  }

  /** 搜索参数：Modrinth → categories；CurseForge → categoryId。{ empty: 原因 } 表示一定查不到 */
  async function params(isCf) {
    if (isCf) return { categoryId: await cfCategoryId(sf.style) };
    const categories = [];
    let levels = [...sf.perf];
    if (sf.fitOnly) {
      const m = await machine();
      if (m && m.level < 0) return { empty: m.reason };
      if (m) {
        const ok = LEVELS.slice(0, m.level + 1);
        levels = levels.length ? levels.filter((l) => ok.includes(l)) : ok;
        if (!levels.length) return { empty: `选的性能档次这台电脑带不动：${m.reason}` };
      }
    }
    if (levels.length) categories.push(levels);
    for (const f of sf.feat) categories.push(f);
    if (sf.style) categories.push(sf.style);
    return { categories };
  }

  /** 筛选面板。onChange() 时重新搜索 */
  function panel({ isCf, onChange }) {
    if (isCf && sf.style && !CF_STYLES[sf.style]) sf.style = '';
    const chip = (tag, on, toggle, disabled) => h('button.chip.sm', {
      class: on ? 'on' : '', disabled, 'aria-pressed': String(!!on),
      onclick: () => { toggle(); onChange(); },
    }, label(tag));
    const multi = (set, tag) => chip(tag, set.has(tag), () => { if (set.has(tag)) set.delete(tag); else set.add(tag); }, isCf);
    const machineEl = h('span.faint', '正在检测显卡…');
    machine().then((m) => {
      machineEl.textContent = m ? `${m.reason}${m.conf && m.conf !== 'known' ? '（按型号推算）' : ''}` : '没能检测显卡，不显示「适合这台电脑」';
    });
    const row = (name, kids) => h('div.sf-row', h('span.sf-name', name), h('div.chips', kids));
    return h('div.sf-panel',
      row('性能', LEVELS.map((l) => multi(sf.perf, l))),
      row('特性', FEATS.map((f) => multi(sf.feat, f))),
      row('风格', (isCf ? Object.keys(CF_STYLES) : STYLES).map((s) => chip(s, sf.style === s, () => { sf.style = sf.style === s ? '' : s; }))),
      isCf ? h('div.faint.sf-note', 'CurseForge 没有性能和特性分类，只能按风格筛；卡片上的「适合这台电脑」借用 Modrinth 上同名光影的标签') : null,
      h('div.sf-row.sf-fit',
        h('label.row', { style: { cursor: 'pointer', gap: '8px' } }, A.toggle(sf.fitOnly, (v) => { sf.fitOnly = v; onChange(); }), '只看适合这台电脑的'),
        machineEl));
  }

  /** 详情窗口里的一段：适不适合、该选哪一档 */
  function detail(p, isCf) {
    const box = h('div');
    (async () => {
      const m = await machine();
      let tags = p.tags;
      let from;
      if (isCf) {
        if (!borrowed.has(p.id)) {
          const r = await api('mods:shaderBorrow', [{ id: p.id, title: p.title, slug: p.slug }]).catch(() => ({}));
          borrowed.set(p.id, r[p.id] || null);
        }
        const b = borrowed.get(p.id);
        tags = b && b.tags;
        from = b ? b.title : null;
      }
      const v = verdict(tags, m, from);
      if (!v) return;
      const feats = (tags || []).filter((x) => FEATS.includes(x)).map(label);
      A.mount(box, A.alert({
        level: v.kind === 'fit' ? 'ok' : v.kind === 'heavy' ? 'warn' : 'info', compact: true,
        title: v.kind === 'fit' ? '适合这台电脑' : v.kind === 'heavy' ? '这台电脑可能带不动' : '不知道它的性能档次',
        text: `${v.tip}${feats.length ? `。效果：${feats.join('、')}` : ''}`,
      }));
    })();
    return box;
  }

  // 调试菜单换了模拟硬件后要重新检测
  const forget = () => { machineP = null; };

  A.shaderUi = { panel, params, slot, fill, detail, verdict, machine, forget, state: sf };
})();
