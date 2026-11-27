'use strict';
/**
 * 设置页分类和位置不跳（rc2，试用 rc1 时提的两个问题）。关在隔离层里，真实窗口。
 *   node scripts/regress/settings-layout.js
 * - 分类：每次只显示一类；每类都点得到；原来的 set-* 跳转目标都还在；从主页「更多背景设置…」这类入口跳进来会切到对应的分类
 * - 搜索：跨分类筛出相关的行；搜不到有说明；清空回到原来的分类
 * - 位置不跳：改「主页背景」「游戏启动后」这些会整页重建的选项，点的那一行在屏幕上的位置不变（误差 2 像素）
 * - 窄的时候分类变成顶上一排；3 种风格、明暗、1.5 倍、高对比度、英文：分类和内容不重叠、不横向溢出。截图存到 AURORA_REGRESS_DIR/settings-layout
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG, lookShown } = require('./robust-ui');
const { sleep, guard, ready, calm } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'settings-layout');
const results = [];
guard(results, 'settings-layout'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 500)}` : ''}`);
}
const LOOKS = [
  ['极光-深', {}], ['像素-深', { ui: { style: 'pixel' }, theme: 'dark' }], ['紧凑-深', { ui: { style: 'compact' }, theme: 'dark' }],
  ['极光-浅', { theme: 'light' }], ['像素-浅', { ui: { style: 'pixel' }, theme: 'light' }], ['紧凑-浅', { ui: { style: 'compact' }, theme: 'light' }],
  ['极光-1.5倍', { a11y: { zoom: 1.5 } }], ['极光-高对比', { a11y: { contrast: 'on' } }], ['极光-英文', { language: 'en' }],
];

// 量布局：分类栏和内容不重叠，页面不横向溢出，选中的分类只有一个
const LAYOUT = `(() => {
  const p = document.querySelector('#page-settings'); const nav = p.querySelector('.set-nav'); const panes = p.querySelector('.set-panes');
  const a = nav.getBoundingClientRect(); const b = panes.getBoundingClientRect();
  const out = [];
  const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  if (overlap) out.push('分类栏压在内容上');
  if (p.scrollWidth > p.clientWidth + 1) out.push('横向溢出 ' + (p.scrollWidth - p.clientWidth));
  for (const c of p.querySelectorAll('.set-cat')) if (c.scrollWidth > c.clientWidth + 1) out.push('分类名被截断：' + c.innerText);
  const shown = [...p.querySelectorAll('.set-pane')].filter((x) => !x.hidden).length;
  if (shown !== 1) out.push('显示了 ' + shown + ' 类');
  return { out, column: getComputedStyle(p.querySelector('.set-layout')).flexDirection, w: Math.round(p.querySelector('.set-page').clientWidth * 100) / 100, vw: innerWidth };
})()`;
// 内容区比这个宽才该是左边一列（style.css 里 .set-page 的 @container 断点）。
// 不能写死「宽的时候一定是左边一列」：1.5 倍时窗口正好是最小尺寸、网页宽 1000，侧边栏收不收（max-width: 1000px）看显示器缩放取整差的那 1 像素，
// 收了内容区 840 多，没收只有 687，两种都对（rc13 碰到：同一份代码换了显示器缩放就从一列变成一排）
const BREAK = 720;
const expect = (m) => (m.w > BREAK ? 'row' : 'column');

// 每一类的每一行：控件不伸出这一行（rc2 试用：游戏目录的输入框和按钮伸到了框外面；整页没有横向溢出，以前量不出来）
const ROWS = `(async () => {
  const out = [];
  for (const b of document.querySelectorAll('#page-settings .set-cat')) {
    b.click(); await new Promise((r) => setTimeout(r, 150));
    for (const row of document.querySelectorAll('#page-settings .set-pane:not([hidden]) .set-row')) {
      if (row.offsetParent === null) continue;
      const R = row.getBoundingClientRect();
      for (const el of row.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.right > R.right + 1 || r.left < R.left - 1) { out.push(b.dataset.cat + '：' + (row.dataset.k || '第' + [...row.parentNode.children].indexOf(row) + '行').slice(0, 14)); break; }
      }
    }
  }
  document.querySelector('#page-settings .set-cat').click();
  return [...new Set(out)];
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // ── 功能：分类、搜索、跳转、位置不跳（中文、默认风格） ──
  {
    const a = await start('settings-layout-main', { config: (game) => ({ ...BASE_CONFIG(game), migrateAsk: false }) });
    if (a.startError) { check('设置', '能打开', false, a.startError); process.exit(1); }
    await ready(a.ev);
    await a.ev("document.querySelectorAll('.modal-back').forEach((m) => m.remove()); A.go('settings'); 1");
    await calm(a.ev);
    const cats = await a.ev("[...document.querySelectorAll('#page-settings .set-cat')].map((b) => b.dataset.cat)");
    check('分类', '有 7 类：常规、外观、游戏、下载、数据、无障碍、关于', cats.join() === 'general,look,game,download,data,a11y,about', cats);
    const each = await a.ev(`(async () => { const out = {}; for (const b of document.querySelectorAll('#page-settings .set-cat')) { b.click(); await new Promise((r) => setTimeout(r, 120));
      const shown = [...document.querySelectorAll('#page-settings .set-pane')].filter((x) => !x.hidden); out[b.dataset.cat] = shown.length === 1 && shown[0].dataset.cat === b.dataset.cat ? shown[0].querySelectorAll('.set-row').length : -1; } return out; })()`);
    check('分类', '每类点了都只显示这一类，而且有设置项', Object.values(each).every((n) => n > 0), each);
    const ids = await a.ev("['gameDir', 'gamesync', 'cache', 'curseforge', 'a11y', 'background', 'perf', 'simple'].filter((k) => !document.getElementById('set-' + k))");
    check('分类', '原来的跳转目标（set-*）都还在', ids.length === 0, ids);
    const total = await a.ev("document.querySelectorAll('#page-settings .set-row').length");
    check('分类', '设置项一个没少（分类前后总数一样，都在页面里）', total >= 40, total);

    // 从别处跳进来
    await a.ev("A.go('home'); 1"); await calm(a.ev);
    await a.ev("A.go('settings', { focus: 'background' }); 1"); await calm(a.ev);
    const jump = await a.ev("(() => { const el = document.getElementById('set-background'); const r = el.getBoundingClientRect(); const act = document.querySelector('#page-settings .set-cat.active'); return { cat: act && act.dataset.cat, visible: r.top >= 0 && r.bottom <= innerHeight && el.offsetParent !== null }; })()");
    check('分类', '主页「更多背景设置…」跳进来：切到「外观」，那一行在屏幕里', jump.cat === 'look' && jump.visible, jump);

    // 搜索
    const search = async (q) => a.ev(`(async () => { const i = document.querySelector('#page-settings .set-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 150));
      const rows = [...document.querySelectorAll('#page-settings .set-row')].filter((r) => r.offsetParent !== null).map((r) => (r.querySelector('.s-title') || r).innerText.trim().slice(0, 20));
      const empty = !document.querySelector('#page-settings .set-empty').hidden; return { rows, empty }; })()`);
    const s1 = await search('Java');
    check('搜索', '搜「Java」：跨分类筛出 Java 相关的行（默认 Java、自动下载、JVM 参数…）', s1.rows.length >= 3 && s1.rows.some((t) => /默认 Java/.test(t)) && !s1.empty, s1.rows);
    const s2 = await search('强调色');
    check('搜索', '搜「强调色」：只剩这一行', s2.rows.length === 1 && /强调色/.test(s2.rows[0]), s2.rows);
    const s3 = await search('qqqzzz');
    check('搜索', '搜不到：说清楚', s3.rows.length === 0 && s3.empty, s3);
    const s4 = await search('');
    const back = await a.ev("(() => { const act = document.querySelector('#page-settings .set-cat.active'); return act && act.dataset.cat; })()");
    check('搜索', '清空：回到原来的分类', back === 'look' && !s4.empty, back);

    // 位置不跳：外观里改「主页背景」（整页重建）
    const steady = async (label, prep, click) => {
      await a.ev(prep); await calm(a.ev);
      const r = await a.ev(`(async () => {
        const row = ${click.row}; const sc = document.querySelector('#page-settings');
        row.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 200));
        const before = row.getBoundingClientRect().top; const key = row.dataset.k;
        ${click.act}
        await new Promise((r) => setTimeout(r, 900));
        const now = [...document.querySelectorAll('#page-settings .set-row')].find((x) => x.dataset.k === key && x.offsetParent !== null);
        return { before: Math.round(before), after: now ? Math.round(now.getBoundingClientRect().top) : null, scrolled: sc.scrollTop };
      })()`);
      check('位置', `${label}：点的那一行留在原处（前后差 ≤ 2 像素）`, r.after != null && Math.abs(r.after - r.before) <= 2, r);
    };
    const bgRow = "document.getElementById('set-background')";
    await steady('外观 → 主页背景换成「自定义图片」', "document.querySelector('#page-settings .set-cat[data-cat=look]').click(); 1", { row: bgRow, act: `const b = [...${bgRow}.querySelectorAll('.seg button')].find((x) => /自定义图片/.test(x.innerText)); b.focus(); b.click();` });
    await steady('外观 → 主页背景换回「像素场景」（下面多出十几行场景设置）', '1', { row: bgRow, act: `const b = [...${bgRow}.querySelectorAll('.seg button')].find((x) => /像素场景/.test(x.innerText)); b.focus(); b.click();` });
    const afterRow = "[...document.querySelectorAll('#page-settings .set-row')].find((x) => x.dataset.k === '游戏启动后')";
    await steady('常规 → 游戏启动后改成「关闭启动器」（下面多出一行）', "document.querySelector('#page-settings .set-cat[data-cat=general]').click(); 1", { row: afterRow, act: `const s = ${afterRow}.querySelector('.select-btn'); s.focus(); s.click(); await new Promise((r) => setTimeout(r, 300)); const it = [...document.querySelectorAll('.menu .menu-item, .menu [role=option], .menu button')].find((x) => /关闭启动器/.test(x.innerText)); if (it) it.click();` });
    const cfg = await a.ev("JSON.stringify({ bg: A.state.config.background.type, after: A.state.config.afterLaunch })");
    check('位置', '上面几下真的改到了设置（不是没点到）', /"bg":"scene"/.test(cfg) && /"after":"close"/.test(cfg), cfg);
    check('设置', '页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
    await a.stop();
  }

  // ── 各种外观、宽窄 ──
  let n = 0;
  for (const [name, cfg] of LOOKS) {
    const a = await start(`settings-layout-${n++}`, { config: (game) => ({ ...BASE_CONFIG(game), migrateAsk: false, ...cfg }) });
    if (a.startError) { check('外观', `${name}：能打开`, false, a.startError); continue; }
    await ready(a.ev);
    { const lk = await lookShown(a, cfg); check('外观', `${name}：外观真的换上了`, !lk, lk); }
    await a.ev("document.querySelectorAll('.modal-back').forEach((m) => m.remove()); A.go('settings'); 1");
    await calm(a.ev);
    const wide = await a.ev(LAYOUT);
    const r1 = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}-宽.png`), Buffer.from(r1.data, 'base64'));
    const rows = {};
    for (const w of ['', '760px', '560px']) {
      await a.ev(`document.querySelector('#page-settings .set-page').style.maxWidth = ${JSON.stringify(w)}; 1`);
      await calm(a.ev);
      rows[w || '默认'] = await a.ev(ROWS, 40000);
    }
    check('外观', `${name}：每一类的每一行，控件都在框里（默认宽度、760、560 像素）`, Object.values(rows).every((x) => !x.length), rows);
    // 窄：把内容区收到 560 像素（窗口拖窄、侧边栏展开时）
    await a.ev("document.querySelector('#page-settings .set-page').style.maxWidth = '560px'; 1");
    await calm(a.ev);
    const narrow = await a.ev(LAYOUT);
    const r2 = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}-窄.png`), Buffer.from(r2.data, 'base64'));
    check('外观', `${name}：宽的时候分类在左边一列，窄的时候在顶上一排；不重叠、不溢出、分类名完整`, !wide.out.length && !narrow.out.length && wide.column === expect(wide) && narrow.column === 'column' && narrow.w <= BREAK, { wide, narrow });
    check('外观', `${name}：没有页面错误`, a.errors.length === 0, a.errors.slice(0, 3));
    await a.stop();
  }
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}；截图在 ${SHOTS}`);
  process.exit(bad ? 1 : 0);
})();
