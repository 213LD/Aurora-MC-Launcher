'use strict';
/**
 * 主页问候区的提示轮播：每 13 秒淡出淡入换一条。
 * 新版本通知（setSpecial）并入轮播：出现时立即显示，之后每隔几条再出现一次，不再独占这一行。
 * 离开主页（stop）、窗口最小化、鼠标停在上面时暂停计时。
 */
(function () {
  const { h, t } = A;
  const INTERVAL = 13000;
  const SPECIAL_EVERY = 4;

  function create(el) {
    let order = [];
    let pos = 0;
    let count = 0;
    let elapsed = 0;
    let timer = 0;
    let hover = false;
    let special = null;
    let showing = null; // 'special' 或提示的序号

    el.classList.add('tip-line');
    el.addEventListener('mouseenter', () => { hover = true; });
    el.addEventListener('mouseleave', () => { hover = false; });

    const tips = () => t('home.tips');

    function nextTip() {
      if (pos >= order.length) {
        // 洗牌，且不让新一轮的第一条和正在显示的重复
        order = tips().map((_, i) => i).sort(() => Math.random() - 0.5);
        if (order.length > 1 && order[0] === showing) order.push(order.shift());
        pos = 0;
      }
      return order[pos++];
    }

    function render(which) {
      showing = which;
      if (which === 'special') A.mount(el, h('span.tip-hot', ...special.render()));
      else el.textContent = tips()[which] || '';
    }

    /** 淡出 → 换内容 → 淡入 */
    function swap(which, animate = true) {
      elapsed = 0;
      if (!animate) { render(which); return; }
      el.classList.add('out');
      setTimeout(() => { render(which); el.classList.remove('out'); }, 260);
    }

    function advance() {
      count++;
      swap(special && count % SPECIAL_EVERY === 0 ? 'special' : nextTip());
    }

    function tick() {
      if (hover || document.hidden) return;
      elapsed += 1000;
      if (elapsed >= INTERVAL) advance();
    }

    return {
      /** 进入主页：有新版本通知时先显示它，否则随机一条 */
      start() {
        clearInterval(timer);
        pos = order.length;
        swap(special ? 'special' : nextTip(), false);
        timer = setInterval(tick, 1000);
      },
      stop() { clearInterval(timer); timer = 0; },
      /** sp = { key, render() → 节点数组 } 或 null；key 变了才立即切过去 */
      setSpecial(sp) {
        const changed = (sp && sp.key) !== (special && special.key);
        special = sp;
        if (!changed) { if (showing === 'special' && sp) render('special'); return; }
        if (sp) swap('special', !!timer);
        else if (showing === 'special') swap(nextTip(), !!timer);
      },
    };
  }

  A.homeTips = create;
})();
