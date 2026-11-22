'use strict';
/**
 * 主页标题旁的黄色标语，仿原版主菜单：倾斜、一缩一放地跳动。
 * 每次打开主页随机一句；特定日期固定显示节日标语；点一下换一句并弹一下。
 */
(function () {
  const { h, t } = A;

  function create() {
    let last = -1;
    const el = h('span.splash-text', { 'data-tip': t('home.splashTip'), onclick: () => roll(true) });

    function today() {
      const d = new Date();
      return (t('home.splashDays') || {})[`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`];
    }

    function roll(bounce) {
      const list = t('home.splash');
      const day = !bounce && today();
      if (day) el.textContent = day;
      else {
        let i;
        do { i = Math.floor(Math.random() * list.length); } while (list.length > 1 && i === last);
        last = i;
        el.textContent = list[i];
      }
      if (bounce) {
        el.classList.remove('bounce');
        void el.offsetWidth; // 重新触发动画
        el.classList.add('bounce');
      }
    }

    roll(false);
    return { el, roll };
  }

  A.splash = create;
})();
