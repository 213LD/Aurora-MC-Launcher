'use strict';
/**
 * 问题卡片在窄的栏里不重叠（rc1 试用：一键修复页「BetterX 的欢迎页挡住了主菜单」那张卡片，「关掉 BetterX 的欢迎页」按钮压在标题上）。
 *   node scripts/regress/issue-layout.js
 * 把同样的提示块（带处理按钮、带画面截图）放进 260 ~ 900 像素宽的栏里，量：按钮和标题、说明不重叠，按钮、截图不超出卡片和栏。
 * 3 种风格、明暗、1.5 倍、高对比度、英文都量一遍，截图存到 AURORA_REGRESS_DIR/issue-layout
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG, lookShown } = require('./robust-ui');
const { sleep, guard, ready } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'issue-layout');
const results = [];
guard(results, 'issue-layout'); // 中途出错也把已有结果写进汇总（cdp.js）
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
const WIDTHS = [260, 340, 420, 520, 640, 900];

// 页面里：放一个固定宽度的栏，挂上和一键修复页一样的提示块（一张带按钮的卡片 + 一张截图）；再挂一张一键修复页自己的卡片
const MEASURE = (w) => `(async () => {
  document.querySelectorAll('.modal-back').forEach((m) => m.remove());
  let box = document.getElementById('il-box');
  if (!box) { box = document.createElement('div'); box.id = 'il-box'; Object.assign(box.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, background: 'var(--bg-1)', padding: '10px', maxHeight: '95vh', overflow: 'auto' }); document.body.appendChild(box); }
  box.style.width = '${w}px';
  box.innerHTML = '';
  const img = (() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); g.fillStyle = '#335'; g.fillRect(0, 0, 320, 180); return c.toDataURL('image/png'); })();
  const r = { ok: true, warn: true, notices: [{ id: 'screen:welcome', severity: 'warn', type: 'screen', title: A.t('notice.bclibWelcome'), detail: A.t('notice.bclibWelcomeDetail'), raw: 'Welcome to BetterX', fix: { kind: 'tweak', tweak: 'bclib-welcome' } }], screen: { kind: 'unknown', image: img } };
  box.appendChild(A.notices.block(r, { versionId: 'Plain', mc: '1.20.1', showLog: true }));
  await new Promise((res) => setTimeout(res, 300));
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
  const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  const inside = (a, b) => a.l >= b.l - 0.5 && a.r <= b.r + 0.5;
  const out = [];
  const boxR = R(box);
  for (const card of box.querySelectorAll('.issue')) {
    const cr = R(card);
    const title = card.querySelector('.issue-title'); const detail = card.querySelector('.issue-detail');
    for (const btn of card.querySelectorAll('.issue-actions .btn')) {
      const br = R(btn);
      if (title && hit(br, R(title))) out.push('按钮压在标题上');
      if (detail && hit(br, R(detail))) out.push('按钮压在说明上');
      if (!inside(br, cr)) out.push('按钮超出卡片');
      if (btn.scrollWidth > btn.clientWidth + 1) out.push('按钮里的字被截断');
    }
    if (title && title.getBoundingClientRect().width < 120) out.push('标题被挤得太窄 ' + Math.round(title.getBoundingClientRect().width));
    if (!inside(cr, boxR)) out.push('卡片超出栏');
  }
  const shot = box.querySelector('.notice-shot');
  if (shot && !inside(R(shot), boxR)) out.push('截图超出栏');
  for (const card of box.querySelectorAll('.issue')) if (shot && hit(R(shot), R(card))) out.push('截图压在卡片上');
  return out;
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let n = 0;
  for (const [name, cfg] of LOOKS) {
    const a = await start(`issue-layout-${n++}`, { config: (game) => ({ ...BASE_CONFIG(game), migrateAsk: false, ...cfg }) });
    if (a.startError) { check('布局', `${name}：能打开`, false, a.startError); continue; }
    await ready(a.ev);
    { const lk = await lookShown(a, cfg); check('布局', `${name}：外观真的换上了`, !lk, lk); }
    const bad = [];
    for (const w of WIDTHS) {
      const o = await a.ev(MEASURE(w), 15000);
      if (o.length) bad.push(`${w}px：${[...new Set(o)].join('、')}`);
      if (w === 340 || w === 640) {
        const r = await a.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOTS, `${name}-${w}.png`), Buffer.from(r.data, 'base64'));
      }
    }
    check('布局', `${name}：260 ~ 900 像素宽的栏里，按钮不压标题和说明、不超出，截图不压卡片`, bad.length === 0, bad);
    check('布局', `${name}：没有页面错误`, a.errors.length === 0, a.errors.slice(0, 3));
    await a.stop();
  }
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}；截图在 ${SHOTS}`);
  process.exit(bad ? 1 : 0);
})();
