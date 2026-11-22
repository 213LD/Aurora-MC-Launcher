'use strict';
/**
 * 设置页的分类、搜索、重建时保持位置（rc2，试用 rc1 时提的两个问题）：
 * ① 所有设置项都在一个页面里滚来滚去，太难找 → 左边一列分类，点哪类只显示哪类；顶上搜索框跨分类筛出相关的设置项
 * ② 点了某个选项里的按钮，展开 / 收起更细的选项时页面位置会跳 → 设置页很多改动会整页重建（A.mount 换掉全部内容，
 *    滚动位置就丢了）。重建前记住刚点的那一行（没有就是屏幕最上面那一行）在屏幕上的位置，重建后把它放回原处
 * settings.js 只负责把各组设置分到分类里；这里不认识具体的设置项
 */
(function () {
  const { h, icon } = A;
  let active = null; // 这次运行里记住选的是哪一类，从别的页面回来还在
  let query = '';

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  /**
   * 一行 / 一组的身份：settings.js 建的时候打的 data-k（中文原文，不会被翻译）。没有的按在组里排第几个。
   * 不能用显示的文字：英文界面的文字是异步翻译的，重建后那一刻还是中文，对不上
   */
  function keyOf(el) {
    const group = el.closest('.set-group');
    const gk = group ? (group.dataset.k || `#${[...document.querySelectorAll('.set-group')].indexOf(group)}`) : '';
    if (el.classList.contains('set-group')) return `g|${gk}`;
    const same = group ? [...group.querySelectorAll('.set-row')] : [];
    return `r|${gk}|${el.dataset.k || `#${same.indexOf(el)}`}`;
  }
  const scrollerOf = (root) => root.closest('.page') || root;

  /**
   * 刚点过的那一行（rc3）：有的控件点了以后自己先重画（分段按钮），焦点跟着丢了，光看 activeElement 找不到点的是哪一行。
   * 在设置页上（捕获阶段）记下最后一次点 / 按键 / 获得焦点的那一行，3 秒内重建就用它
   */
  function watch(root) {
    if (root.__setWatch) return;
    root.__setWatch = true;
    const note = (e) => { const row = e.target && e.target.closest && e.target.closest('.set-row, .set-group'); if (row) root.__lastRow = { el: row, at: Date.now() }; };
    for (const ev of ['pointerdown', 'click', 'keydown', 'focusin']) root.addEventListener(ev, note, true);
  }

  /** 重建前：记下锚点（刚点的那一行，没有就是屏幕最上面露出来的那一行）离滚动区顶部多远 */
  function keepPlace(root) {
    if (!root || !root.isConnected) return null;
    watch(root);
    const sc = scrollerOf(root);
    const top = sc.getBoundingClientRect().top;
    const ae = document.activeElement;
    const last = root.__lastRow;
    let anchor = ae && root.contains(ae) ? ae.closest('.set-row, .set-group') : null;
    if (!anchor && last && Date.now() - last.at < 3000 && last.el.isConnected && last.el.offsetParent !== null) anchor = last.el;
    if (!anchor || anchor.offsetParent === null) {
      anchor = [...root.querySelectorAll('.set-row, .set-group')].find((r) => r.offsetParent !== null && r.getBoundingClientRect().bottom > top + 4) || null;
    }
    return { key: anchor ? keyOf(anchor) : null, y: anchor ? anchor.getBoundingClientRect().top - top : 0, scroll: sc.scrollTop };
  }

  /**
   * 重建后：同一行放回原来的位置；找不到就退回原来的滚动距离。
   * 下面收起了很多行、页面变短了滚不到那里时（比如主页背景换成图片，十几行场景设置没了），
   * 在最下面补一段空白，让点的那一行还在原处；换分类时去掉（rc3）
   */
  function restorePlace(root, saved) {
    if (!saved || !root) return;
    const sc = scrollerOf(root);
    sc.scrollTop = saved.scroll;
    if (!saved.key) return;
    const el = [...root.querySelectorAll('.set-row, .set-group')].find((r) => r.offsetParent !== null && keyOf(r) === saved.key);
    if (!el) return;
    const want = sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - saved.y;
    sc.scrollTop = want;
    const panes = root.querySelector('.set-panes');
    // 页面比窗口还短时 scrollHeight 一直等于窗口高，补的空白要一点点加到够为止（最多几次）
    let pad = 0;
    for (let i = 0; i < 6 && panes && want - sc.scrollTop > 1; i++) {
      pad += Math.ceil(Math.max(want - sc.scrollTop, want + sc.clientHeight - sc.scrollHeight));
      panes.style.paddingBottom = `${pad}px`;
      sc.scrollTop = want;
    }
  }

  /**
   * 分类布局。cats：[{ id, label, icon, groups: [元素] }]
   * 返回的元素带 pick(id) 和 reveal(el)：reveal 切到 el 所在的分类（别的页面跳到某个设置项时用）
   */
  function layout(cats) {
    const list = cats.filter((c) => c.groups.some(Boolean));
    if (!list.some((c) => c.id === active)) active = list[0].id;
    const search = h('input.input.set-search', {
      type: 'search', placeholder: '搜索设置…', value: query, spellcheck: 'false', 'aria-label': '搜索设置',
      oninput: (e) => { query = e.target.value; apply(); },
      onkeydown: (e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); query = ''; search.value = ''; apply(); } },
    });
    const btns = list.map((c) => h('button.set-cat', { type: 'button', 'data-cat': c.id, onclick: () => pick(c.id) }, icon(c.icon, 16), h('span', c.label)));
    const panes = list.map((c) => h('section.set-pane', { 'data-cat': c.id, 'aria-label': c.label }, h('h2.set-pane-title', c.label), ...c.groups.filter(Boolean)));
    const empty = h('div.set-empty', icon('search', 18), h('span', '没有找到相关的设置，换个说法试试'));
    const wrap = h('div.set-layout',
      h('nav.set-nav', { 'aria-label': '设置分类' }, search, h('div.set-cats', { role: 'tablist' }, btns)),
      h('div.set-panes', panes, empty));

    function pick(id, { keepScroll = false } = {}) {
      active = id;
      panes[0].parentNode.style.paddingBottom = ''; // 重建时为了不跳补的空白（restorePlace）
      query = ''; search.value = '';
      apply();
      if (!keepScroll) { const sc = wrap.closest('.page'); if (sc) sc.scrollTop = 0; }
    }

    function apply() {
      const q = norm(query);
      let any = false;
      for (const b of btns) {
        const on = !q && b.dataset.cat === active;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      for (const pane of panes) {
        if (!q) {
          pane.hidden = pane.dataset.cat !== active;
          for (const el of pane.querySelectorAll('.set-hide')) el.classList.remove('set-hide');
          continue;
        }
        // 搜索：标题、说明里有这个词的行；组标题对上了整组都留着
        let paneHit = false;
        for (const g of pane.querySelectorAll('.set-group')) {
          const gHit = norm((g.querySelector(':scope > h3') || {}).textContent).includes(q);
          let rowHit = false;
          for (const r of g.querySelectorAll('.set-row')) {
            const hit = gHit || norm(r.querySelector('.s-text') ? r.querySelector('.s-text').textContent : r.textContent).includes(q);
            r.classList.toggle('set-hide', !hit);
            if (hit) rowHit = true;
          }
          g.classList.toggle('set-hide', !gHit && !rowHit);
          if (gHit || rowHit) paneHit = true;
        }
        pane.hidden = !paneHit;
        if (paneHit) any = true;
      }
      wrap.classList.toggle('searching', !!q);
      empty.hidden = !q || any;
    }

    function reveal(el) {
      const pane = el && el.closest('.set-pane');
      if (pane) pick(pane.dataset.cat, { keepScroll: true });
    }

    apply();
    return Object.assign(wrap, { pick, reveal });
  }

  A.settingsNav = { layout, keepPlace, restorePlace, current: () => active };
})();
