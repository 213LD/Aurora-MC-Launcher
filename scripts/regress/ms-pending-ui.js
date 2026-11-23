'use strict';
/**
 * 微软正版登录还在申请（FEATURES.msLogin = false）时的入口：
 *   node scripts/regress/ms-pending-ui.js            功能 + 各种外观
 *   node scripts/regress/ms-pending-ui.js --quick    只跑功能
 * 账户页顶上的按钮、「添加账户」菜单里的灰色入口、设置「微软登录」那一行都标「正在申请」；
 * 鼠标停上去有同一段说明（为什么还不能用、在等什么、现在先用什么），点了弹同样的说明、不跳走也不开登录框；
 * 页面上不再有「正在开发」「内部测试阶段」。3 种风格、明暗、1.5 倍、高对比度、英文：标签和说明都不出界。
 * 截图在 AURORA_REGRESS_DIR/ms-pending-ui
 */
const fs = require('fs');
const path = require('path');
const { start, BASE_CONFIG, fakeVersion } = require('./robust-ui');
const { guard, ready, until, calm } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'ms-pending-ui');
const results = [];
guard(results, 'ms-pending-ui');
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 600)}` : ''}`);
}
const prepare = ({ game }) => { fakeVersion(game, 'Plain', { clientVersion: '1.20.1' }); };
const clean = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove()); A.closePopover && A.closePopover();";
async function shot(a, name) {
  const r = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}

// 鼠标移到某个元素上，等提示出来，量提示框（在不在窗口里、字有没有被截断）
const HOVER = (sel) => `(async () => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { found: false };
  document.querySelectorAll('.tooltip').forEach((t) => t.remove());
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  for (let i = 0; i < 40 && !document.querySelector('.tooltip'); i++) await new Promise((r) => setTimeout(r, 50));
  const tip = document.querySelector('.tooltip');
  if (!tip) return { found: true, tip: null };
  const b = tip.getBoundingClientRect();
  const out = { found: true, tip: tip.innerText, inside: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, cut: tip.scrollWidth > tip.clientWidth + 1 || tip.scrollHeight > tip.clientHeight + 1 };
  document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // 鼠标移开，提示收起（按下鼠标会把菜单也关掉）
  return out;
})()`;
// 标签有没有伸出它的按钮 / 那一行
const TAG_FITS = `(() => {
  const out = [];
  for (const t of document.querySelectorAll('.page.active .soon-tag')) {
    const host = t.closest('button, .set-row, .row') || t.parentElement;
    const a = t.getBoundingClientRect(); const b = host.getBoundingClientRect();
    if (a.width === 0) continue;
    if (a.left < b.left - 1 || a.right > b.right + 1 || a.top < b.top - 1 || a.bottom > b.bottom + 1) out.push('标签伸出：' + t.innerText);
    if (t.scrollWidth > t.clientWidth + 1) out.push('标签的字被截断：' + t.innerText);
  }
  return out;
})()`;

async function functional() {
  const a = await start('ms-pending-ui', { prepare, config: (game) => ({ ...BASE_CONFIG(game) }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); return; }
  await ready(a.ev);
  const ev = (code, t = 15000) => a.ev(code, t);
  const PENDING = await ev('A.MS_PENDING');
  check('说明', '说明写了为什么不能用、在等什么、现在先用什么', /Azure/.test(PENDING || '') && /审核/.test(PENDING) && /申请正在进行/.test(PENDING) && /离线账户/.test(PENDING) && /外置登录/.test(PENDING), PENDING);
  check('说明', '还是没开放的状态（FEATURES.msLogin = false）', (await ev('A.FEATURES.msLogin')) === false);

  // ── 账户页 ──
  await ev(`(async () => { ${clean} A.go('accounts'); })()`);
  await calm(ev);
  let o = await ev("(() => { const b = document.querySelector('#page-accounts .btn.dev-soon'); const p = document.querySelector('#page-accounts .page-head p'); return { btn: b && b.innerText, tip: b && b.dataset.tip, head: p && p.innerText, page: document.querySelector('#page-accounts').innerText }; })()");
  check('账户页', '顶上的「微软登录」按钮标「正在申请」，鼠标停上去是那段说明', /微软登录/.test(o.btn || '') && /正在申请/.test(o.btn) && o.tip === PENDING, o);
  check('账户页', '页面说明写「正在申请」，不再有「正在开发」「开发中」「内部测试阶段」', /正在申请/.test(o.head || '') && !/正在开发|开发中|内部测试阶段/.test(o.page), o.head);
  o = await ev(HOVER('#page-accounts .btn.dev-soon'));
  check('账户页', '鼠标停在按钮上真的弹出说明，整段在窗口里', o.tip === PENDING && o.inside && !o.cut, o);
  o = await ev(`(async () => { ${clean} document.querySelector('#page-accounts .btn.dev-soon').click(); await new Promise((r) => setTimeout(r, 300)); const t = [...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' | '); return { toast: t, modals: document.querySelectorAll('.modal-back').length, page: A.state.page }; })()`);
  check('账户页', '点了按钮弹出同一段说明，不开登录框、不跳走', o.toast.includes(PENDING) && /正在申请/.test(o.toast) && o.modals === 0 && o.page === 'accounts', o);

  // ── 「添加账户」菜单 ──
  o = await ev(`(async () => { ${clean} document.querySelector('#page-accounts .acc-add').click(); await new Promise((r) => setTimeout(r, 300));
    const items = [...document.querySelectorAll('.popover .menu-item')].map((m) => ({ title: (m.querySelector('.m-title') || {}).innerText, sub: (m.querySelector('.m-sub') || {}).innerText, soon: m.classList.contains('soon'), dis: m.getAttribute('aria-disabled'), tip: m.dataset.tip || '', op: +getComputedStyle(m).opacity }));
    return items; })()`);
  const ms = (o || []).find((x) => x.title === '微软账户');
  check('菜单', '「添加账户」菜单里有灰色的「微软账户 · 正在申请」，排在第一个', ms && o[0] === ms && ms.soon && ms.dis === 'true' && /正在申请/.test(ms.sub || '') && ms.tip === PENDING && ms.op < 0.7, o);
  // 外置登录要联网：测试环境没有网，离线模式本来就把它变灰（offline.js），不算这里的事
  check('菜单', '另外两种没被标成「正在申请」，离线账户照常能用（不灰）', ['外置登录', '离线账户'].every((n) => { const x = (o || []).find((y) => y.title === n); return x && !x.soon && !x.dis; }) && (o.find((y) => y.title === '离线账户') || {}).op === 1, o);
  o = await ev(HOVER('.popover .menu-item.soon'));
  check('菜单', '鼠标停在灰色入口上弹出说明，整段在窗口里', o.tip === PENDING && o.inside && !o.cut, o);
  await shot(a, '菜单-默认');
  o = await ev(`(async () => { document.querySelector('.popover .menu-item.soon').click(); await new Promise((r) => setTimeout(r, 300)); return { pop: !!document.querySelector('.popover'), toast: [...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' | '), modals: document.querySelectorAll('.modal-back').length }; })()`);
  check('菜单', '点灰色入口：菜单关掉，弹出说明，不开登录框', !o.pop && o.toast.includes(PENDING) && o.modals === 0, o);

  // ── 设置「微软登录」 ──
  o = await ev(`(async () => { ${clean} A.go('settings'); const c = document.querySelector('#page-settings .set-cat[data-cat=general]'); if (c) c.click(); await new Promise((r) => setTimeout(r, 400)); const t = document.querySelector('#page-settings .soon-tag'); const row = t && t.closest('.set-row, .row'); return { tag: t && t.innerText, tip: t && t.dataset.tip, row: row && row.innerText }; })()`);
  check('设置', '「微软正版登录」那一行标「正在申请」，说明也改了，鼠标停上去是那段说明', o.tag === '正在申请' && o.tip === PENDING && /正在向微软申请/.test(o.row || '') && !/内部测试阶段|正在开发/.test(o.row || ''), o);
  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 3));
  await a.stop();
}

async function looks() {
  const list = [
    ['极光-深', { theme: 'dark' }], ['像素-深', { ui: { style: 'pixel' }, theme: 'dark' }], ['紧凑-深', { ui: { style: 'compact' }, theme: 'dark' }],
    ['极光-浅', { theme: 'light' }], ['像素-浅', { ui: { style: 'pixel' }, theme: 'light' }], ['紧凑-浅', { ui: { style: 'compact' }, theme: 'light' }],
    ['极光-1.5倍', { a11y: { zoom: 1.5 } }], ['极光-高对比', { a11y: { contrast: 'high' } }], ['极光-英文', { language: 'en' }],
  ];
  let n = 0;
  for (const [name, cfg] of list) {
    const a = await start(`ms-pending-look-${n++}`, { prepare, config: (game) => ({ ...BASE_CONFIG(game), ...cfg }) });
    if (a.startError) { check('外观', `${name}：能打开`, false, a.startError); continue; }
    await ready(a.ev);
    const ev = (code, t = 15000) => a.ev(code, t);
    const en = cfg.language === 'en';
    const bad = [];
    await ev(`(async () => { ${clean} A.go('accounts'); })()`);
    await calm(ev);
    bad.push(...(await ev(TAG_FITS)).map((x) => `账户页 ${x}`));
    let o = await ev(HOVER('#page-accounts .btn.dev-soon'));
    if (!o.tip || !o.inside || o.cut) bad.push(`账户页按钮的说明：${JSON.stringify(o)}`);
    await ev("(async () => { document.querySelector('#page-accounts .acc-add').click(); await new Promise((r) => setTimeout(r, 300)); })()");
    o = await ev(`(() => { const m = document.querySelector('.popover .menu-item.soon'); if (!m) return { found: false }; const p = m.closest('.popover').getBoundingClientRect(); const r = m.getBoundingClientRect(); const s = m.querySelector('.m-sub');
      return { found: true, sub: s && s.innerText, inMenu: r.left >= p.left - 1 && r.right <= p.right + 1, inWin: p.right <= innerWidth && p.bottom <= innerHeight, cut: !!s && s.scrollWidth > s.clientWidth + 1 }; })()`);
    if (!o.found || !o.inMenu || !o.inWin || o.cut) bad.push(`菜单里的灰色入口：${JSON.stringify(o)}`);
    if (en && !/Being applied for/.test(o.sub || '')) bad.push(`英文菜单没翻：${o.sub}`);
    o = await ev(HOVER('.popover .menu-item.soon'));
    if (!o.tip || !o.inside || o.cut) bad.push(`菜单入口的说明：${JSON.stringify(o)}`);
    if (en && !/Azure/.test(o.tip || '') || en && /[一-鿿]/.test(o.tip || '')) bad.push(`英文说明没翻：${o.tip}`);
    await shot(a, `${name}-菜单`);
    await ev(`(async () => { ${clean} A.go('settings'); const c = document.querySelector('#page-settings .set-cat[data-cat=general]'); if (c) c.click(); await new Promise((r) => setTimeout(r, 400)); })()`);
    await calm(ev);
    bad.push(...(await ev(TAG_FITS)).map((x) => `设置 ${x}`));
    o = await ev("(() => { const t = document.querySelector('#page-settings .soon-tag'); return t ? t.innerText : null; })()");
    if (o !== (en ? 'Applying' : '正在申请')) bad.push(`设置的标签：${o}`);
    await shot(a, `${name}-设置`);
    check('外观', `${name}：「正在申请」的标签、灰色入口和说明都不出界、不截断${en ? '，都翻成了英文' : ''}`, bad.length === 0, bad.slice(0, 4));
    check('外观', `${name}：没有页面错误`, a.errors.length === 0, a.errors.slice(0, 3));
    await a.stop();
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await functional();
  if (!process.argv.includes('--quick')) await looks();
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}；截图在 ${SHOTS}`);
  process.exit(bad ? 1 : 0);
})();
