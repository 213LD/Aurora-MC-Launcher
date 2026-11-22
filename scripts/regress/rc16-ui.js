'use strict';
/**
 * rc16（用户试用 rc15 时提的）：
 *   node scripts/regress/rc16-ui.js
 * 一、设置里关掉 MC 百科 → 从「关于」重新打开首次启动向导 → 向导里打开：其实开了，但背后的设置页还显示关着（没跟着重画），
 *     玩家以为没开、又开一次。现在对话框里改了设置，对话框关上以后设置页按新设置重画。
 * 二、内部版、中文界面：MC 百科在向导最后单独一页，打开了可以选做完以后建缓存；英文界面、公开版（概念演示）没有这一页。
 * 三、防连点：刚翻过来的一小会儿点「下一步 / 完成」不算（双击不会翻两页）；一页停不到 1.5 秒就翻过去的，
 *     最后一页列出来、可以点回去，「完成」等 5 秒；每页都停了一下的不用等。
 * 在内部版里跑（用到 MC 百科的真实界面）；公开版没有 MC 百科这一页，这个脚本直接跳过那几项
 */
const fs = require('fs');
const path = require('path');
const { start, BASE_CONFIG } = require('./robust-ui');
const { guard, until, ready, calm } = require('./cdp');

const results = [];
guard(results, 'rc16-ui');
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const CLEAN = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove());";
// 向导里的小工具：现在第几页、主按钮、点主按钮
const W = `const wm = () => document.querySelector('.setup-modal');
  const prim = () => wm() && wm().querySelector('.modal-foot .btn.primary');
  
  const stepIdx = () => { const all = wm() ? [...wm().querySelectorAll('.msteps > li')] : []; return all.findIndex((x) => x.classList.contains('on')); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));`;

(async () => {
  const a = await start('rc16-ui', { config: (game) => ({ ...BASE_CONFIG(game), migrateAsk: false, background: { type: 'gradient' }, mcmod: { enabled: true, consentAt: Date.now() - 86400000, consentVer: 'rc14' } }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  const ev = (code, t = 90000) => a.ev(code, t);
  await ready(ev);
  await ev(`(() => { ${CLEAN} return 1; })()`);
  const internal = await ev('!!(A.mcmodUi && !A.mcmodUi.CONCEPT && A.mcmodUi.setupPage)');
  // 页面里的 MC 百科是真的还是概念演示，要和 editions.js 的差别表对得上（不然下面按哪个版本查就是猜的）
  check('版本', `MC 百科模块和这个版本对得上（${require('./editions').name}：${require('./editions').mcmod}）`, internal === (require('./editions').mcmod === 'real'), { internal });

  if (internal) {
    // ── 一、二：设置里关掉 → 向导最后一页打开 → 背后的设置页跟着变 ──
    let o = await ev(`(async () => { ${W}
      await A.go('settings', { focus: 'mcmod' }); await wait(1000);
      const sw = () => { const row = [...document.querySelectorAll('.set-row')].find((r) => r.offsetParent && /从 MC 百科读取 Mod 中文信息/.test(r.textContent)); return row && row.querySelector('input[role=switch], input[type=checkbox]'); };
      sw().click(); await wait(800);
      const offBefore = !(await A.api('config:get')).mcmod.enabled;
      let called = 0; const fin0 = A.mcmodUi.setupFinish; A.mcmodUi.setupFinish = () => { called++; return Promise.resolve(); };
      const p = A.setup.open(); await wait(700);
      const names = [...wm().querySelectorAll('.msteps .ms-label')].map((x) => x.textContent.trim());
      for (let i = 0; i < 12 && !/完成/.test(prim().textContent); i++) { await wait(500); prim().click(); await wait(300); }
      const page = wm().textContent; const lastName = names[names.length - 1];
      // 打开：「我了解风险，想打开…」→ 勾三条、等 5 秒、确认
      [...wm().querySelectorAll('button')].find((b) => /我了解风险/.test(b.textContent)).click(); await wait(600);
      const c = [...document.querySelectorAll('.modal-back')].pop(); c.querySelectorAll('.mcm-pledges input[type=checkbox]').forEach((b) => { b.checked = true; b.dispatchEvent(new Event('change')); });
      await wait(5600); [...c.querySelectorAll('.modal-foot .btn')].find((b) => /确认/.test(b.textContent)).click(); await wait(1200);
      const afterEnable = { cache: /做完向导以后建一份中文信息缓存/.test(wm().textContent), opened: /已打开/.test(wm().textContent) };
      await wait(600); prim().click(); await Promise.race([p, wait(4000)]); await wait(800);
      const s2 = sw(); const ui = { checked: s2 ? s2.checked : null, cacheRow: [...document.querySelectorAll('.set-row')].some((r) => r.offsetParent && /本地缓存/.test(r.textContent)) };
      A.mcmodUi.setupFinish = fin0;
      return { offBefore, names, lastName, pageHasRisk: /风险/.test(page), afterEnable, enabled: (await A.api('config:get')).mcmod.enabled, ui, page: A.state.page, finishCalled: called }; })()`, 120000);
    check('MC 百科一页', '中文界面的内部版：向导最后一页是「MC 百科」，说明了风险；打开以后可以选做完建缓存', o.lastName === 'MC 百科' && o.pageHasRisk && o.afterEnable.opened && o.afterEnable.cache, { names: o.names, afterEnable: o.afterEnable });
    check('设置页刷新', '设置里关掉 → 向导里打开 → 做完回到设置页：开关显示开着、有「本地缓存」那一行（以前还显示关着）', o.offBefore && o.enabled === true && o.ui.checked === true && o.ui.cacheRow && o.page === 'settings', o.ui);
    check('MC 百科一页', '做完向导会去开始建缓存（按最后一页选的）', o.finishCalled === 1, o.finishCalled);

    // 开关显示的是旧状态（设置在背后被改了、页面没重画）：点开关只把它对齐，不再走一遍确认、不弹建缓存
    o = await ev(`(async () => { ${W} ${CLEAN} await A.setConfig({ mcmod: { ...A.state.config.mcmod, enabled: false } }); await A.go('home'); await wait(300); await A.go('settings', { focus: 'mcmod' }); await wait(800);
      const sw = () => { const row = [...document.querySelectorAll('.set-row')].find((r) => r.offsetParent && /从 MC 百科读取 Mod 中文信息/.test(r.textContent)); return row && row.querySelector('input[role=switch], input[type=checkbox]'); };
      const before = sw().checked;
      await A.api('config:set', { mcmod: { ...(await A.api('config:get')).mcmod, enabled: !before } }); // 只改设置，不经过界面
      A.state.config = await A.api('config:get');
      const n0 = document.querySelectorAll('.modal-back').length;
      sw().click(); await wait(900);
      const dialogs = document.querySelectorAll('.modal-back').length - n0; const stillShown = sw().checked;
      ${CLEAN}
      return { before, dialogs, stillShown, enabled: (await A.api('config:get')).mcmod.enabled }; })()`);
    check('开关先看真实状态', 'MC 百科开关显示「关」、其实已经开着时，点它只把开关对齐，不再弹风险确认和建缓存', o.before === false && o.dialogs === 0 && o.stillShown === o.enabled && o.enabled === !o.before, o);

    // 公开版（概念演示）、英文界面：没有这一页
    o = await ev(`(async () => { ${W} const c0 = A.mcmodUi.CONCEPT; A.mcmodUi.CONCEPT = true; const p = A.setup.open(); await wait(700);
      const names = [...wm().querySelectorAll('.msteps .ms-label')].map((x) => x.textContent.trim()); wm().closest('.modal-back').querySelector('.modal-head .x').click(); await wait(400); A.mcmodUi.CONCEPT = c0; return { names }; })()`);
    check('MC 百科一页', '公开版（概念演示）没有 MC 百科这一页，还是 6 页', o.names.length === 6 && !o.names.includes('MC 百科'), o);
  } else console.log('  公开版：没有 MC 百科的真实界面，跳过一、二');

  // ── 三、防连点 ──
  // 双击「下一步」：只翻一页
  let o = await ev(`(async () => { ${W} ${CLEAN} const p = A.setup.open(); await wait(900);
    const i0 = stepIdx(); prim().click(); await wait(60); prim().click(); await wait(500); const i1 = stepIdx();
    wm().closest('.modal-back').querySelector('.modal-head .x').click(); await wait(400); return { i0, i1 }; })()`);
  check('防连点', '双击「下一步」只翻一页', o.i0 === 0 && o.i1 === 1, o);

  // 连着快速点到最后：最后一页列出翻得太快的页，「完成」等 5 秒；点「回去看看」能回到那一页
  o = await ev(`(async () => { ${W} ${CLEAN} const p = A.setup.open(); await wait(900);
    const total = wm().querySelectorAll('.msteps > li').length;
    for (let i = 0; i < total - 1; i++) { await wait(600); prim().click(); }
    await wait(300);
    const note = [...wm().querySelectorAll('.alert')].find((x) => /页翻得很快/.test(x.textContent));
    const items = note ? [...note.querySelectorAll('.setup-rushed li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim()) : [];
    const b = prim(); const waiting = { disabled: b.disabled, label: b.textContent.trim() };
    b.click(); await wait(300); const stillOpen = !!wm();
    await wait(5600); const after = { disabled: prim().disabled, label: prim().textContent.trim() };
    // 回去看看第一页（辅助功能）：回到第 0 页
    const names = [...wm().querySelectorAll('.msteps .ms-label')].map((x) => x.textContent.trim()); const firstB = note && note.querySelector('.setup-rushed li b'); const firstIdx = firstB ? names.indexOf(firstB.textContent.trim()) : -2;
    const back = note && [...wm().querySelectorAll('.setup-rushed .btn')][0]; if (back) back.click(); await wait(500); const backTo = stepIdx();
    // 这回每页都停一下再翻：最后一页的提示里少了这些页
    for (let i = backTo; i < total - 1; i++) { await wait(1700); prim().click(); }
    await wait(400); const note2 = [...wm().querySelectorAll('.alert')].find((x) => /页翻得很快/.test(x.textContent)); const b2 = { disabled: prim().disabled, label: prim().textContent.trim() };
    // 量这一页有没有溢出
    const body = wm().querySelector('.modal-body'); const over = body.scrollWidth > body.clientWidth + 1;
    wm().closest('.modal-back').querySelector('.modal-head .x').click(); await wait(400);
    return { total, items, waiting, stillOpen, after, backTo, firstIdx, note2: note2 ? note2.textContent.slice(0, 40) : null, b2, over }; })()`, 120000);
  check('防连点', '一路很快点到最后：最后一页列出这些页用的设置，「完成」写着倒计时、点了不算', o.items.length >= o.total - 2 && o.waiting.disabled && /完成（[1-5]）/.test(o.waiting.label) && o.stillOpen, { items: o.items, waiting: o.waiting });
  check('防连点', '5 秒以后「完成」可以点了', !o.after.disabled && /^完成$/.test(o.after.label), o.after);
  check('防连点', '点「回去看看」回到那一页；之后每页都停一下再翻，最后一页不再提示、「完成」不用等', o.firstIdx >= 0 && o.backTo === o.firstIdx && !o.note2 && !o.b2.disabled && /^完成$/.test(o.b2.label), { backTo: o.backTo, firstIdx: o.firstIdx, note2: o.note2, b2: o.b2 });
  check('布局', '最后一页（有提示时）不横向溢出', !o.over, o.over);

  // 正常看（每页停 1.7 秒）：最后一页没有提示，完成不用等
  o = await ev(`(async () => { ${W} ${CLEAN} const p = A.setup.open(); await wait(900); const total = wm().querySelectorAll('.msteps > li').length;
    for (let i = 0; i < total - 1; i++) { await wait(1700); prim().click(); }
    await wait(600); const note = [...wm().querySelectorAll('.alert')].some((x) => /页翻得很快/.test(x.textContent)); const b = { disabled: prim().disabled, label: prim().textContent.trim() };
    wm().closest('.modal-back').querySelector('.modal-head .x').click(); await wait(400); return { note, b }; })()`, 120000);
  check('防连点', '每页都停一下（1.7 秒）再翻：最后一页没有提示，「完成」马上能点', !o.note && !o.b.disabled && /^完成$/.test(o.b.label), o);

  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  await a.stop();
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
