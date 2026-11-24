'use strict';
/**
 * 微软正版登录（FEATURES.msLogin = true）：
 *   node scripts/regress/ms-login-ui.js            功能 + 各种外观
 *   node scripts/regress/ms-login-ui.js --quick    只跑功能
 * 账户页顶上的按钮、「添加账户」菜单里的微软账户、设置「微软登录」那一行都已开放；
 * 断网离线模式会拦住微软登录；留空 Client ID 直接使用内置默认完成设备码登录（本地模拟接口）；
 * 报错后点「修改 Client ID」或「重试」不会被旧弹窗误取消；取消能正常停下；
 * 3 种风格、明暗、1.5 倍、高对比度、英文都不出界、不截断、无残留中文。
 * 截图在 AURORA_REGRESS_DIR/ms-login-ui
 */
const fs = require('fs');
const path = require('path');
const { start, BASE_CONFIG, fakeVersion } = require('./robust-ui');
const { guard, ready, until, calm } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'ms-login-ui');
const results = [];
guard(results, 'ms-login-ui');
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

const LAYOUT_CHECK = (mode) => `(() => {
  const out = [];
  const p = document.querySelector('.page.active');
  if (p && p.scrollWidth > p.clientWidth + 2) out.push('页面横向溢出');
  const msGroup = ${mode === 'settings' ? "[...document.querySelectorAll('#page-settings .set-group')].find((x) => /微软登录|Microsoft/.test((x.querySelector('h3') || {}).textContent || ''))" : 'null'};
  if (msGroup) msGroup.scrollIntoView({ block: 'center' });
  const sels = ${mode === 'overlay'
    ? "'.popover .menu-item, .modal-back .modal button, .modal-back .modal input'"
    : mode === 'settings'
      ? "'.page.active button, .page.active .set-row'"
      : "'.page.active button'"};
  for (const el of document.querySelectorAll(sels)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const checkY = ${mode === 'overlay' ? 'true' : '!!(msGroup && msGroup.contains(el))'};
    if (r.right > innerWidth + 1 || r.left < -1 || (checkY && (r.bottom > innerHeight + 1 || r.top < -1))) {
      out.push('控件超出窗口：' + (el.innerText || el.placeholder || el.className).slice(0, 30));
    }
    if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 2) out.push('按钮文字被截断：' + el.innerText.slice(0, 30));
  }
  return out;
})()`;

async function functional() {
  // 1. 入口与离线拦截（不设 badnet，隔离层默认无网）
  const off = await start('ms-login-offline', { prepare, config: (game) => ({ ...BASE_CONFIG(game) }) });
  if (off.startError) { check('启动', '离线环境能打开', false, off.startError); return; }
  await ready(off.ev);
  const ev0 = (code, t = 15000) => off.ev(code, t);
  check('开关', '微软登录开关已打开（FEATURES.msLogin = true）', (await ev0('A.FEATURES.msLogin')) === true);
  await ev0(`(async () => { ${clean} A.go('accounts'); })()`);
  await calm(ev0);
  let o = await ev0("(() => { const p = document.querySelector('#page-accounts'); const b = [...p.querySelectorAll('.page-head .actions button')].find((x) => /微软登录/.test(x.innerText)); return { hasSoon: !!p.querySelector('.soon-tag, .dev-soon'), text: p.innerText, cls: b && b.className, net: b && b.hasAttribute('data-net') }; })()");
  check('账户页', '顶上「微软登录」为主按钮且有联网标记，没有「正在申请」标记', !o.hasSoon && !/正在申请|正在开发|开发中/.test(o.text) && /btn primary/.test(o.cls || '') && o.net, o);
  await ev0("document.querySelector('#page-accounts .acc-add').click()");
  await until(ev0, "!!document.querySelector('.popover .menu-item')", 8000);
  o = await ev0("(() => [...document.querySelectorAll('.popover .menu-item')].map((m) => ({ title: (m.querySelector('.m-title') || {}).innerText, soon: m.classList.contains('soon'), dis: m.getAttribute('aria-disabled'), net: m.hasAttribute('data-net') })))()");
  const msItem = (o || []).find((x) => x.title === '微软账户');
  check('菜单', '「添加账户」菜单第一项为可用的「微软账户」且带联网标记', msItem && o[0] === msItem && !msItem.soon && !msItem.dis && msItem.net, o);
  await until(ev0, 'A.offline.on()', 10000);
  o = await ev0(`(async () => { ${clean} const b = [...document.querySelectorAll('#page-accounts .page-head .actions button')].find((x) => /微软登录/.test(x.innerText)); b.click(); return { modals: document.querySelectorAll('.modal-back').length }; })()`);
  await until(ev0, "document.querySelectorAll('.toast').length > 0", 8000);
  const offToast = await ev0("[...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' | ')");
  check('离线', '断网离线模式下点击「微软登录」被拦截并提示联网，不打开登录弹窗', o.modals === 0 && /没有网络|联网/.test(offToast), { modals: o.modals, offToast });
  await off.stop();

  // 2. 在线模拟（badnet: fixture）：默认内置 Client ID 登录、错误修改与重试、取消
  const a = await start('ms-login-ui', { prepare, badnet: 'fixture', config: (game) => ({ ...BASE_CONFIG(game), msClientId: '' }) });
  if (a.startError) { check('启动', '模拟联网环境能打开', false, a.startError); return; }
  await ready(a.ev);
  const ev = (code, t = 15000) => a.ev(code, t);
  await until(ev, '!A.offline.on()', 10000);

  // 设置页检查
  await ev(`(async () => { ${clean} A.go('settings'); const c = document.querySelector('#page-settings .set-cat[data-cat=general]'); if (c) c.click(); })()`);
  await until(ev, "!![...document.querySelectorAll('#page-settings .set-group h3')].find((h) => /微软登录/.test(h.textContent))", 8000);
  o = await ev("(() => { const g = [...document.querySelectorAll('#page-settings .set-group')].find((x) => /微软登录/.test((x.querySelector('h3') || {}).textContent || '')); const inp = g && g.querySelector('input'); return { text: g && g.innerText, ph: inp && inp.placeholder, hasSoon: !!(g && g.querySelector('.soon-tag')) }; })()");
  check('设置', '设置「常规 → 微软登录」显示内置说明与可选 Client ID 输入框', !o.hasSoon && /Azure 应用 Client ID/.test(o.text || '') && /内置/.test(o.text || '') && /内置/.test(o.ph || ''), o);

  // 空 msClientId 直接设备码登录成功
  await ev(`(async () => { ${clean} A.go('accounts'); })()`);
  await calm(ev);
  await ev("([...document.querySelectorAll('#page-accounts .page-head .actions button')].find((x) => /微软登录/.test(x.innerText))).click()");
  const gotCode = await until(ev, "(() => { const c = document.querySelector('.modal .ms-code'); return c && c.textContent.trim(); })()", 10000);
  check('登录', '未设自定义 Client ID 时直接出设备码弹窗（走内置默认）', gotCode === 'FXMS-8888', gotCode);
  await shot(a, '设备码弹窗');
  const loggedIn = await until(ev, "A.state.accounts.accounts.some((x) => x.type === 'microsoft' && x.name === 'FixtureSteve') && !document.querySelector('.modal .ms-code')", 15000);
  const accFile = fs.readFileSync(path.join(a.data, 'accounts.json'), 'utf8');
  check('登录', '设备码轮询完成后自动保存微软正版账户且不存明文令牌', loggedIn && !accFile.includes('fx-ms-access') && !accFile.includes('fx-ms-refresh'), { loggedIn });

  // 正版账户皮肤预览（非空、非 http:// 被 CSP 拦、真图片在页面 CSP 下能加载）与皮肤中心「正版账户皮肤」分组
  await ev("([...document.querySelectorAll('#page-accounts .acc-card .a-actions button')].find((b) => /皮肤/.test(b.textContent))).click()");
  await until(ev, "!!document.querySelector('.drawer .sk-face')", 8000);
  const preview = await ev(`(async () => {
    const face = document.querySelector('.drawer .sk-face');
    const cape = document.querySelector('.drawer .sk-cape .sk-face');
    const turn = document.querySelector('.drawer .sk-turn');
    const pickUrl = (el) => { const bg = el ? getComputedStyle(el).backgroundImage : ''; const m = bg.match(/^url\\("(.*)"\\)$/); return m ? m[1] : ''; };
    const loadImg = (u) => new Promise((res) => { if (!u) return res(null); const img = new Image(); img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => res({ err: true }); img.src = u; });
    const skinUrl = pickUrl(face);
    const capeUrl = pickUrl(cape);
    return { skinUrl, capeUrl, skinImg: await loadImg(skinUrl), capeImg: await loadImg(capeUrl), turnText: turn && turn.textContent };
  })()`);
  check('预览', '账户页点正版账户「皮肤」预览非空、非 http 链接且 64×64 皮肤和 64×32 披风可加载',
    preview && /^file:/i.test(preview.skinUrl || '') && preview.skinImg && preview.skinImg.w === 64 && preview.skinImg.h === 64
    && preview.capeImg && preview.capeImg.w === 64 && preview.capeImg.h === 32 && /看披风/.test(preview.turnText || ''), preview);
  await shot(a, '正版皮肤抽屉');
  await ev("A.closeDrawers ? A.closeDrawers() : document.querySelector('.drawer .drawer-head button').click()");
  await until(ev, "!document.querySelector('.drawer')", 5000);

  await ev(`(async () => { ${clean} A.go('skins'); })()`);
  await until(ev, "[...document.querySelectorAll('#page-skins .skc-chip')].some((c) => /正版账户皮肤/.test(c.textContent))", 10000);
  o = await ev(`(async () => {
    const chip = [...document.querySelectorAll('#page-skins .skc-chip')].find((c) => /正版账户皮肤/.test(c.textContent));
    chip.click();
    await new Promise((r) => setTimeout(r, 200));
    const tile = document.querySelector('#page-skins .skc-tile');
    if (tile) tile.click();
    const bigFace = document.querySelector('#page-skins .skc-side .sk-face');
    const bg = bigFace ? getComputedStyle(bigFace).backgroundImage : '';
    const m = bg.match(/^url\\("(.*)"\\)$/);
    const imgOk = await new Promise((res) => { if (!m) return res(false); const i = new Image(); i.onload = () => res(i.naturalWidth === 64 && i.naturalHeight === 64); i.onerror = () => res(false); i.src = m[1]; });
    return { chip: chip.textContent.replace(/\\s+/g, ' ').trim(), name: tile && (tile.querySelector('.skc-name') || {}).textContent, imgOk };
  })()`);
  check('皮肤中心', '登录正版后自动创建「正版账户皮肤」分组并保存该玩家皮肤且可正常预览',
    o && /正版账户皮肤\s*1/.test(o.chip || '') && o.name === 'FixtureSteve' && o.imgOk, o);

  // 错误 Client ID → 点「修改 Client ID」清空 → 自动续接登录成功
  await ev(`(async () => { ${clean} await A.setConfig({ msClientId: 'bad-client-id' }); ([...document.querySelectorAll('#page-accounts .page-head .actions button')].find((x) => /微软登录/.test(x.innerText))).click(); })()`);
  const gotErr = await until(ev, "(() => { const al = document.querySelector('.modal .alert.crit'); return al && al.textContent; })()", 10000);
  check('错误', '无效 Client ID 时报错并给出修改按钮', /获取登录代码失败/.test(gotErr || ''), gotErr);
  await ev("([...document.querySelectorAll('.modal-foot button')].find((b) => /修改 Client ID/.test(b.textContent))).click()");
  await until(ev, "!!document.querySelector('.modal input.input.mono')", 8000);
  await ev("(() => { const inp = document.querySelector('.modal input.input.mono'); inp.value = ''; ([...document.querySelectorAll('.modal-foot button')].find((b) => /保存并继续/.test(b.textContent))).click(); })()");
  const fixedCode = await until(ev, "(() => { const c = document.querySelector('.modal .ms-code'); return c && c.textContent.trim(); })()", 10000);
  const fixedDone = await until(ev, "!document.querySelector('.modal .ms-code')", 15000);
  check('恢复', '清空自定义 Client ID 保存并继续后自动使用内置默认完成登录', fixedCode === 'FXMS-8888' && fixedDone, { fixedCode, fixedDone });

  // 报错后点「重试」不被旧弹窗 onClose 误取消
  await ev(`(async () => { ${clean} await A.setConfig({ msClientId: 'bad-client-id' }); ([...document.querySelectorAll('#page-accounts .page-head .actions button')].find((x) => /微软登录/.test(x.innerText))).click(); })()`);
  await until(ev, "!!document.querySelector('.modal .alert.crit')", 10000);
  await ev("A.setConfig({ msClientId: '' })");
  await ev("([...document.querySelectorAll('.modal-foot button')].find((b) => /重试/.test(b.textContent))).click()");
  const retryCode = await until(ev, "(() => { const c = document.querySelector('.modal .ms-code'); return c && c.textContent.trim(); })()", 10000);
  const retryDone = await until(ev, "!document.querySelector('.modal .ms-code') && [...document.querySelectorAll('.toast.ok')].some((t) => /FixtureSteve/.test(t.innerText))", 15000);
  check('重试', '报错弹窗点「重试」正常开启新登录并完成，不被旧弹窗关闭误取消', retryCode === 'FXMS-8888' && retryDone, { retryCode, retryDone });

  // 取消流程（使用 fx-slow 保持 pending）
  await ev(`(async () => { ${clean} await A.setConfig({ msClientId: '00000000-0000-0000-0000-000000000001' }); ([...document.querySelectorAll('#page-accounts .page-head .actions button')].find((x) => /微软登录/.test(x.innerText))).click(); })()`);
  const slowCode = await until(ev, "(() => { const c = document.querySelector('.modal .ms-code'); return c && c.textContent.trim(); })()", 10000);
  await ev("([...document.querySelectorAll('.modal-foot button')].find((b) => /取消/.test(b.textContent))).click()");
  const closed = await until(ev, "!document.querySelector('.modal')", 8000);
  const errToasts = await ev("[...document.querySelectorAll('.toast.crit')].length");
  check('取消', '设备码等待期间点「取消」顺利关闭且不报错误提示', slowCode === 'SLOW-0001' && closed && errToasts === 0, { slowCode, closed, errToasts });
  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 3));
  await a.stop();
}

async function looks() {
  const list = [
    ['极光-深', { theme: 'dark' }], ['像素-深', { ui: { style: 'pixel' }, theme: 'dark' }], ['紧凑-深', { ui: { style: 'compact' }, theme: 'dark' }],
    ['极光-浅', { theme: 'light' }], ['像素-浅', { ui: { style: 'pixel' }, theme: 'light' }], ['紧凑-浅', { ui: { style: 'compact' }, theme: 'light' }],
    ['极光-1.5倍', { a11y: { zoom: 1.5 } }], ['极光-高对比', { a11y: { contrast: 'on' } }], ['极光-英文', { language: 'en' }],
  ];
  let n = 0;
  for (const [name, cfg] of list) {
    const a = await start(`ms-login-look-${n++}`, { prepare, badnet: 'fixture', config: (game) => ({ ...BASE_CONFIG(game), ...cfg }) });
    if (a.startError) { check('外观', `${name}：能打开`, false, a.startError); continue; }
    await ready(a.ev);
    const ev = (code, t = 15000) => a.ev(code, t);
    const en = cfg.language === 'en';
    const bad = [];
    await ev(`(async () => { ${clean} A.go('accounts'); })()`);
    await calm(ev);
    bad.push(...(await ev(LAYOUT_CHECK('page'))).map((x) => `账户页 ${x}`));
    await ev("document.querySelector('#page-accounts .acc-add').click()");
    await until(ev, "!!document.querySelector('.popover .menu-item')", 8000);
    bad.push(...(await ev(LAYOUT_CHECK('overlay'))).map((x) => `菜单 ${x}`));
    if (en) {
      const cn = await ev("(() => { const p = document.querySelector('.popover'); return p && /[一-鿿]/.test(p.innerText) ? p.innerText : ''; })()");
      if (cn) bad.push(`英文菜单残留中文：${cn.slice(0, 60)}`);
    }
    await shot(a, `${name}-菜单`);
    await ev(`(async () => { ${clean} A.go('settings'); const c = document.querySelector('#page-settings .set-cat[data-cat=general]'); if (c) c.click(); })()`);
    await until(ev, "!!document.querySelector('#page-settings .set-group')", 8000);
    await calm(ev);
    bad.push(...(await ev(LAYOUT_CHECK('settings'))).map((x) => `设置 ${x}`));
    if (en) {
      const cn = await ev("(() => { const g = [...document.querySelectorAll('#page-settings .set-group')].find((x) => /Microsoft/.test((x.querySelector('h3') || {}).textContent || '')); return !g ? 'missing' : /[一-鿿]/.test(g.innerText) ? g.innerText : ''; })()");
      if (cn) bad.push(`英文设置残留中文：${cn.slice(0, 60)}`);
    }
    await shot(a, `${name}-设置`);
    await ev("A.clientIdDialog()");
    await until(ev, "!!document.querySelector('.modal input.input.mono')", 8000);
    await calm(ev);
    bad.push(...(await ev(LAYOUT_CHECK('overlay'))).map((x) => `配置弹窗 ${x}`));
    if (en) {
      const cn = await ev("(() => { const m = document.querySelector('.modal'); return m && /[一-鿿]/.test(m.innerText) ? m.innerText : ''; })()");
      if (cn) bad.push(`英文配置弹窗残留中文：${cn.slice(0, 60)}`);
    }
    check('外观', `${name}：开放后的微软登录入口、菜单、设置和配置弹窗都不出界、不截断${en ? '，英文已翻全' : ''}`, bad.length === 0, bad.slice(0, 4));
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
