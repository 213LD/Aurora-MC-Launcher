'use strict';
/**
 * 预热字体（rc14）：界面第一次用到某个字体的某个字重时，浏览器要现读系统字体文件
 * （Segoe UI Variable 约 1.8 MB，每个字重各实例化一次；微软雅黑常规、粗体各 17 ~ 20 MB），
 * 第一次打开游戏配置页、设置页时排版因此多花几十到上百毫秒，CPU 慢的电脑上要大半秒。
 * 启动后在空闲时把界面用到的两种字体、各个字重各排一次版，之后打开页面就不用再等。
 * 每次空闲只排一种，不让主页动画卡一下；排完把临时元素删掉
 */
(function () {
  const FAMILIES = ['var(--font)', 'var(--font-display)'];
  const WEIGHTS = [400, 500, 550, 600, 650, 700, 750, 800]; // style.css 里用到的字重
  // 中文、英文、数字都要有（中文字体和西文字体是两个文件）；英文界面也原样用这一句（词典里译成它自己），不然雅黑预热不到
  const TEXT = '极光启动器 游戏配置 设置 Aa Bb 0123';
  let started = false;

  function start(delay = 1500) {
    if (started) return;
    started = true;
    const jobs = [];
    for (const f of FAMILIES) for (const w of WEIGHTS) jobs.push([f, w]);
    const idle = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 }) : (fn) => setTimeout(fn, 50);
    const box = document.createElement('div');
    box.className = 'font-warm';
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap';
    const step = () => {
      const job = jobs.shift();
      if (!job) { box.remove(); api.done = true; return; }
      if (!box.isConnected) document.body.append(box);
      const s = document.createElement('span');
      s.textContent = TEXT;
      s.style.fontFamily = job[0];
      s.style.fontWeight = String(job[1]);
      box.append(s);
      void s.offsetWidth; // 排一次版：字体在这时读进来
      idle(step);
    };
    setTimeout(() => idle(step), delay);
  }

  const api = { start, done: false }; // done：都排过了（测试等它）
  A.fontWarm = api;
})();
