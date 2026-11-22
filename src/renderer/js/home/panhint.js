'use strict';
/**
 * 主页背景「可以移动视角」的提示（1.7.4）：玩家前 3 次打开启动器时，在画面四边的感应位置画会动的箭头，
 * 中间一句「按住拖动、滚轮缩放」。真的平移 / 拖动 / 缩放过一次就淡出，并记成学会了，以后不再出现；
 * 没动的话 8 秒后自己淡出（这一次也算一次）。定格的画面（性能模式、简洁模式、减少动态效果、静态帧率）、
 * 「移动视角」关掉时不出现。记在 config.tips.panHint = { runs, learned }（调试菜单「清除已看过的提示」会清掉）
 */
(function () {
  const { h, icon, state } = A;
  const MAX_RUNS = 3;
  const SHOW_MS = 8000;
  let el = null;
  let poll = 0;
  let shownThisRun = false;

  const rec = () => ((state.config && state.config.tips) || {}).panHint || {};
  const save = (patch) => A.setConfig({ tips: { panHint: { ...rec(), ...patch } } });

  function remove(fast) {
    clearInterval(poll); poll = 0;
    if (!el) return;
    const e = el; el = null;
    e.classList.add('gone');
    setTimeout(() => e.remove(), fast ? 0 : 700);
  }

  /** 箭头放在感应带里：左右在竖直中间，上在顶栏下面，下在启动坞上面（启动坞那块不平移） */
  function layout(root, scene) {
    const rr = root.getBoundingClientRect();
    const { r, top, hgt, zx, zy } = scene.edgeZones();
    const dock = root.querySelector('.dock');
    const dTop = dock ? dock.getBoundingClientRect().top : r.bottom - hgt * zy;
    const left = Math.max(r.left, rr.left);
    const right = Math.min(r.right, rr.right);
    const midY = (top + dTop) / 2;
    const pos = {
      l: [left + (r.width * zx) / 2, midY],
      r: [right - (r.width * zx) / 2, midY],
      t: [(left + right) / 2, top + (hgt * zy) / 2],
      b: [(left + right) / 2, dTop - 26],
      c: [(left + right) / 2, midY],
    };
    for (const [k, [x, y]] of Object.entries(pos)) {
      const a = el.querySelector(`.ph-${k}`);
      if (a) { a.style.left = `${x - rr.left}px`; a.style.top = `${y - rr.top}px`; }
    }
  }

  /** 主页显示时调用：够条件就显示提示（对话框开着时先等，免得在对话框后面白白显示完） */
  function maybe(root, scene) {
    if (shownThisRun || el || !scene) return;
    const r = rec();
    if (r.learned || (r.runs || 0) >= MAX_RUNS) return;
    let waited = 0;
    clearInterval(poll);
    poll = setInterval(() => {
      if (state.page !== 'home' || scene.frozen || !scene.opts.pan) return;
      if (document.querySelector('.modal-back:not(.closing), .setup, .endpoem')) { waited = 0; return; }
      if ((waited += 250) < 1200) return;
      clearInterval(poll);
      show(root, scene);
    }, 250);
  }

  function show(root, scene) {
    shownThisRun = true;
    save({ runs: (rec().runs || 0) + 1 });
    const arrow = (k, ic) => h(`div.ph-arrow.ph-${k}`, icon(ic, 20));
    el = h('div.pan-hint', { 'aria-hidden': 'true' },
      arrow('l', 'chevronLeft'), arrow('r', 'chevronRight'), arrow('t', 'chevronUp'), arrow('b', 'chevronDown'),
      h('div.ph-c', icon('eye', 14), '鼠标移到画面四边可以移动视角 · 按住空白处拖动 · 滚轮缩放'));
    root.appendChild(el);
    layout(root, scene);
    const z0 = scene.zoomT;
    const t0 = performance.now();
    poll = setInterval(() => {
      if (!el) return;
      if (state.page !== 'home') { remove(true); return; }
      const now = performance.now();
      const moved = (scene.drag && scene.drag.moved) || (scene.edge && now - scene.edge.since > 450) || Math.abs(scene.zoomT - z0) > 0.01;
      if (moved) { save({ learned: true }); remove(); return; }
      if (now - t0 > SHOW_MS) { remove(); return; }
      layout(root, scene);
    }, 200);
  }

  A.panHint = { maybe, hide: () => remove(true) };
})();
