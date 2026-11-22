'use strict';
/**
 * 在页面里跑的界面检查（rc9 起在 ui-snapshot.js 里，rc12 抽出来给 walk.js 共用）。不截图，全靠量：
 *   COLLECT：一块界面（默认是当前页面）有哪些入口、每一块在哪多大，以及不靠基线、任何时候都不该出现的毛病——
 *            伸到窗口外面、横向溢出、按钮上的字被截断、字上下被切掉、没居中、两块叠在一起、字和底色几乎一个颜色。
 *   collectAt(表达式)：换一块界面来量（最上面的弹窗、菜单、抽屉）。
 *   GLOBAL：侧边栏、顶栏有哪些入口，和这台电脑的字体指纹。
 * 都是字符串，交给 Runtime.evaluate；返回 { entries, boxes, texts, problems }。
 */
/** 页面里跑的：这一页有哪些入口、每一块在哪多大、有没有不该出现的毛病 */
const COLLECT = `(() => {
  const root = document.querySelector('.page.active');
  if (!root) return null;
  // 每次打开都不一样的东西不记：提示轮播、黄色标语、更新日志、提示条
  // 文字里的文件夹路径换成〈路径〉：每台电脑不一样，也不该进基线文件（rc12：以前向导第 3 步的「使用 C:\\Users\\…」原样记了进去）
  const SKIP = '.tips, .greet-sub, .splash-text, .news-card, .news-panel, .news-pill, .toast, .toasts, canvas, [data-snapshot-skip]';
  // 里面装着上面那些的容器：自己的大小跟着变，不记它自己，里面的照记
  const LOOSE = '.greet, .greet-title, .greet-title h1, .home-top, .home-content'; // h1 是问候语，跟着钟点变（英文的「Good afternoon」和「Late night」不一样宽，rc11 碰到）
  const css = (el) => getComputedStyle(el);
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = css(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const norm = (s) => String(s || '').replace(/[A-Za-z]:[\\\\/][^「」]*?(?=$|[「」，。；、）\\n])/g, '〈路径〉').replace(/\\s+/g, ' ').trim().replace(/\\d+(?:[.,:]\\d+)*/g, '#').slice(0, 48);
  const labelOf = (el) => norm(el.innerText) || norm(el.getAttribute('data-tip')) || norm(el.getAttribute('aria-label')) || norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder')) || '';
  const isTab = (el) => el.getAttribute('role') === 'tab' || el.classList.contains('tab') || el.classList.contains('seg-btn') || !!el.parentElement.closest('.seg') && el.tagName === 'BUTTON';
  const kindOf = (el) => { const t = el.tagName.toLowerCase(); if (t === 'input') return el.type === 'checkbox' ? '勾选' : '输入框'; if (t === 'select') return '下拉'; if (t === 'textarea') return '输入框'; if (t === 'a') return '链接'; if (isTab(el)) return '标签'; if (el.classList.contains('toggle') || el.getAttribute('role') === 'switch') return '开关'; return '按钮'; };
  const entries = new Map();
  for (const el of root.querySelectorAll('button, a, input, select, textarea, [role=button], [role=tab], [role=switch]')) {
    if (!vis(el) || el.closest(SKIP)) continue;
    const k = kindOf(el) + '「' + (labelOf(el) || '（没有文字）') + '」';
    entries.set(k, (entries.get(k) || 0) + 1);
  }
  const vw = document.documentElement.clientWidth;
  const problems = [];
  const boxes = {};
  const texts = {};
  /** 里面真正看得见的东西（字、图标）占的范围：不算空白的盒子和装饰用的伪元素 */
  const inkOf = (el) => {
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity; let n = 0; let text = false;
    const add = (q) => { if (q.width < 0.5 || q.height < 0.5) return; l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); n++; };
    for (const nd of el.childNodes) {
      if (nd.nodeType === 3) { if (!nd.nodeValue.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(nd); for (const q of rg.getClientRects()) add(q); text = true; continue; }
      if (nd.nodeType !== 1 || !vis(nd) || /absolute|fixed/.test(css(nd).position)) continue; // 浮在角上的小标记不算
      add(nd.getBoundingClientRect());
      if (nd.textContent.trim()) text = true;
    }
    return n ? { l, t, r, b, text } : null;
  };
  const lum = (c) => { const m = c.match(/[\\d.]+/g); if (!m) return null; const [r, g, b, a] = m.map(Number); if (a !== undefined && a < 0.6) return null; const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  /** 这段字后面的底色（往外找第一个不透明的纯色）；中间有图片、渐变就说不准，返回 null */
  const backOf = (el) => { for (let p = el; p; p = p.parentElement) { const cs = css(p); if (cs.backgroundImage !== 'none') return null; const v = lum(cs.backgroundColor); if (v != null) return v; } return null; };
  const controlChecks = (el, r, name) => {
    const cs = css(el);
    const ink = inkOf(el);
    if (!ink) return null;
    const dx = Math.round(((ink.l + ink.r) / 2 - (r.left + r.right) / 2) * 2) / 2;
    const dy = Math.round(((ink.t + ink.b) / 2 - (r.top + r.bottom) / 2) * 2) / 2;
    const ellipsis = [el, ...el.querySelectorAll('*')].some((x) => css(x).textOverflow === 'ellipsis');
    if (el.tagName === 'BUTTON' && cs.overflow !== 'visible' && !ellipsis && (ink.r > r.right + 2 || ink.l < r.left - 2)) problems.push('按钮上的字被截断：' + name);
    // 上下居中：一行高的按钮、标签、胶囊都该这样
    const oneLine = (ink.b - ink.t) < 34 && r.height < 80;
    if (oneLine && Math.abs(dy) > 3.5) problems.push('上下没居中：' + name + ' 里的内容偏' + (dy > 0 ? '下' : '上') + ' ' + Math.abs(dy) + ' 像素');
    // 左右居中：只有图标的按钮、分段按钮和标签、样式里写了居中的
    const iconOnly = !ink.text;
    const padL = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth); const padR = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
    const wantCenter = iconOnly || isTab(el) || (/flex/.test(cs.display) ? cs.justifyContent === 'center' : cs.textAlign === 'center');
    const off = iconOnly || isTab(el) ? dx : dx - (padL - padR) / 2; // 带字的普通按钮两边留白本来就可以不一样宽（带下拉箭头的），按留白折算
    if (wantCenter && oneLine && el.children.length <= 3 && Math.abs(off) > 3) problems.push('左右没居中：' + name + ' 里的内容偏' + (off > 0 ? '右' : '左') + ' ' + Math.abs(Math.round(off)) + ' 像素');
    return [dx, dy];
  };
  const walk = (el, key, depth) => {
    const counts = {};
    const pr = el.getBoundingClientRect();
    const kids = [];
    for (const ch of el.children) {
      if (!vis(ch) || ch.matches(SKIP)) continue;
      const cls = [...ch.classList].find((c) => !/^(active|on|open|show|hidden|disabled|selected|sm|md|lg|xl|ghost|primary|danger|busy)$/.test(c)) || '';
      const name = ch.tagName.toLowerCase() + (cls ? '.' + cls : '');
      counts[name] = (counts[name] || 0) + 1;
      const k = key + '/' + name + (counts[name] > 1 ? '#' + counts[name] : '');
      const r = ch.getBoundingClientRect();
      const cs = css(ch);
      const control = /^(BUTTON|INPUT|SELECT|TEXTAREA|IMG)$/.test(ch.tagName);
      const what = control ? kindOf(ch) + '「' + (labelOf(ch) || k) + '」' : k;
      if (control && (r.right > vw + 1 || r.left < -1)) problems.push('伸到窗口外面：' + what);
      let ink = null;
      if (ch.tagName === 'BUTTON' || ch.classList.contains('badge') || ch.classList.contains('stat-pill')) ink = controlChecks(ch, r, what);
      // 图标不单独记（按钮里的图标居不居中在上面查过了）：12 ~ 14 像素的小图标正好卡在「够不够大」的线上，时记时不记
      if (r.height >= 14 && ch.tagName !== 'svg' && (ch.children.length || control) && !ch.matches(LOOSE)) {
        boxes[k] = [Math.round(r.left - pr.left), Math.round(r.top - pr.top + el.scrollTop), Math.round(r.width), Math.round(r.height)].concat(ink || []);
        if (r.height < 120) { const tx = norm(ch.innerText).slice(0, 30); if (tx) texts[k] = tx; }
      }
      // 只有字的一小块：上下被切掉、和底色同色
      if (!ch.children.length && ch.textContent.trim() && !control) {
        const lineClamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
        if (cs.overflowY !== 'visible' && !lineClamp && ch.scrollHeight > ch.clientHeight + 3 && r.height < 60) problems.push('字上下被切掉：' + k + '「' + norm(ch.textContent).slice(0, 16) + '」');
        const fg = lum(cs.color); const bg = backOf(ch);
        // 主页的字压在单独一层背景上，往外找到的底色不是它后面的颜色，不查
        if (fg != null && bg != null && root.id !== 'page-home') { const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05); if (ratio < 1.25) problems.push('字和底色几乎一个颜色：' + k + '「' + norm(ch.textContent).slice(0, 16) + '」（对比 ' + ratio.toFixed(2) + '）'); }
      }
      // 贴边的条（position: sticky，比如 Mod 配置器底部的「上一步 / 下一步」）本来就盖在滚动的内容上面，和浮层一样不算「叠在一起」
      if (!/absolute|fixed|sticky/.test(cs.position) && r.height >= 6 && r.width >= 6) kids.push({ k: what, r });
      if (depth < 6 && ch.tagName !== 'svg' && Object.keys(boxes).length < 500) walk(ch, k, depth + 1); // 图标里面的线条不看
    }
    // 并排的两块叠在一起（各自都在正常排版里）
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].r; const b = kids[j].r;
      const ow = Math.min(a.right, b.right) - Math.max(a.left, b.left); const oh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ow > 4 && oh > 4) problems.push('两块叠在一起：' + kids[i].k + ' 和 ' + kids[j].k + '（叠了 ' + Math.round(ow) + '×' + Math.round(oh) + '）');
    }
  };
  walk(root, '', 1);
  const sc = [root, ...root.querySelectorAll('.page-inner, .set-pane')].filter(vis);
  // 横向溢出：找出是哪一块伸出去的，写进报告。伸出去的只有贴边的条（故意比内容宽一点、盖住两边的留白）就不算
  const inSticky = (x) => { for (let p = x; p && p !== document.body; p = p.parentElement) if (css(p).position === 'sticky') return true; return false; };
  for (const el of sc) {
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    const edge = el.getBoundingClientRect().left + el.clientLeft + el.clientWidth + 2;
    const wide = [...el.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > edge && vis(x));
    const out = wide.find((x) => !inSticky(x));
    // 没找到伸出去的元素（只有字伸出去，比如很长的英文单词）照样报；只有贴边的条伸出去才不报
    if (!out && wide.length) continue;
    const who = out ? out.tagName.toLowerCase() + (typeof out.className === 'string' && out.className.trim() ? '.' + out.className.trim().split(/\\s+/).join('.') : '') : '字';
    problems.push('横向溢出：' + (el.className || el.id) + ' 内容宽 ' + el.scrollWidth + '，只有 ' + el.clientWidth + '（伸出去的：' + who + '）');
  }
  return { entries: [...entries].map(([k, n]) => (n > 1 ? k + ' ×' + n : k)).sort(), boxes, texts, problems: [...new Set(problems)] };
})()`;

const GLOBAL = `(() => {
  const norm = (s) => String(s || '').replace(/[A-Za-z]:[\\\\/][^「」]*?(?=$|[「」，。；、）\\n])/g, '〈路径〉').replace(/\\s+/g, ' ').trim().replace(/\\d+(?:[.,:]\\d+)*/g, '#').slice(0, 40);
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const nav = [...document.querySelectorAll('#nav .nav-item')].filter(vis).map((el) => norm(el.innerText));
  const bar = [...document.querySelectorAll('.titlebar button')].filter(vis).filter((el) => el.id !== 'btnBack').map((el) => el.id || norm(el.getAttribute('data-tip')) || norm(el.getAttribute('aria-label')) || norm(el.innerText)).sort();
  // 文字的量法一样才比位置大小：换了电脑、显示器、缩放，或者连着远程桌面（会改分辨率和字体平滑），同一行字宽零点几个像素，
  // 换行就跟着变，几十处位置一起「变了」。rc13 以前只量一段字还取整，看不出这种差别（那次远程连上以后报了 35 处）：
  // 现在用页面里真的排出来的字，三种字号，保留两位小数
  const ff = getComputedStyle(document.body).fontFamily;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap';
  document.body.appendChild(probe);
  const sample = '极光启动器 Aurora MC Launcher 设置 Java 下载 0123456789 WWiil';
  const w = (font) => { probe.style.font = font; probe.textContent = sample; return probe.getBoundingClientRect().width.toFixed(2); };
  const env = [w(''), w('700 14.5px ' + ff), w('12px ' + ff)].join('/') + '@' + ff.slice(0, 60);
  probe.remove();
  return { nav, bar, env };
})()`;

/** 量别的一块界面：rootExpr 是在页面里算出那个元素的表达式 */
const collectAt = (rootExpr) => COLLECT.replace("document.querySelector('.page.active')", rootExpr);

module.exports = { COLLECT, GLOBAL, collectAt };
