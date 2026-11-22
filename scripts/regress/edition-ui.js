'use strict';
/**
 * 内部版和公开版的每一处差别，按 editions.js 的差别表逐项查（两个版本都跑：内部仓库里查内部版，公开版的副本里查公开版）。
 *   node scripts/regress/edition-ui.js
 * 一、差别表和程序对得上：数据目录名、appId（brand.js、package.json、engine/edition.js）。名字是写死的，改了老数据就找不到了。
 * 二、界面上（中文、英文各开一次）：窗口标题、关于页的版本号和「内部版 / 公开版」、更新日志卡片和弹窗里的版本号、
 *     默认数据目录、MC 百科的设置卡片（只在中文界面）、首次启动向导的页数、「参考与致谢」的概念演示一节、调试菜单要不要密码。
 * 以前这些散在几个测试里，各自用不同的办法猜「现在是哪个版本」，公开版的替身在内部的关卡里根本没人跑，英文界面漏翻了也没人知道。
 */
const fs = require('fs');
const path = require('path');
const ED = require('./editions');
const { start, BASE_CONFIG } = require('./robust-ui');
const { guard, until, ready, calm } = require('./cdp');

const results = [];
guard(results, 'edition-ui');
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const CLEAN = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove());";
const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;

(async () => {
  // ── 一、差别表和程序 ──
  const BRAND = require(path.join(ED.REPO, 'src', 'shared', 'brand'));
  const APP = require(path.join(ED.REPO, 'src', 'main', 'engine', 'edition'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ED.REPO, 'package.json'), 'utf8'));
  const T = ED.TABLE;
  check('差别表', 'brand.js 里两个版本的数据目录名、appId 和差别表一样（名字一改，玩家的数据就找不到了）',
    BRAND.dataDirName === T.internal.dataDirName && BRAND.appId === T.internal.appId && BRAND.publicEdition.dataDirName === T.public.dataDirName && BRAND.publicEdition.appId === T.public.appId,
    { brand: [BRAND.dataDirName, BRAND.appId, BRAND.publicEdition], table: [T.internal.dataDirName, T.internal.appId, T.public.dataDirName, T.public.appId] });
  check('差别表', `程序认的版本（engine/edition.js）和差别表认的一样：${ED.name}`, APP.name === ED.name && APP.PUBLIC === ED.PUBLIC && APP.dataDirName === ED.dataDirName && APP.appId === ED.appId, { app: [APP.name, APP.dataDirName, APP.appId] });
  check('差别表', `打包用的 appId 是这个版本的（${ED.appId}）`, pkg.build && pkg.build.appId === ED.appId, pkg.build && pkg.build.appId);

  // ── 二、界面 ──
  for (const lang of ['zh-CN', 'en']) {
    const zh = lang === 'zh-CN';
    const L = zh ? '中文' : '英文';
    const a = await start(`edition-ui-${lang}`, { config: (game) => ({ ...BASE_CONFIG(game), language: lang, migrateAsk: false, background: { type: 'gradient' }, news: { enabled: true, open: true, tab: zh ? 'launcher' : 'mc', seenLauncher: '' } }) });
    if (a.startError) { check('启动', `${L}界面能打开`, false, a.startError); continue; }
    const ev = (code, t = 60000) => a.ev(code, t);
    await ready(ev);
    await ev(`(() => { ${CLEAN} return 1; })()`);

    // 标题、版本、默认数据目录
    let o = await ev("(async () => { const i = await A.api('app:info'); const loc = await A.api('location:get'); return { title: document.title, edition: i.edition, version: i.version, def: loc.defaultDataDir }; })()");
    const wantTitle = zh ? ED.title : (ED.PUBLIC ? BRAND.name : `${BRAND.name} (internal edition)`);
    check('标题', `${L}：窗口标题是「${wantTitle}」`, o.title === wantTitle, o.title);
    check('版本', `${L}：程序报的版本是 ${ED.name}、${pkg.version}`, o.edition === ED.name && o.version === pkg.version, o);
    check('数据目录', `${L}：默认数据目录是 %APPDATA%\\${ED.dataDirName}（测试时用的是隔离目录，这里只看默认的那个）`, path.basename(o.def || '') === ED.dataDirName && !(ED.PUBLIC ? [T.internal.dataDirName] : [T.public.dataDirName]).includes(path.basename(o.def || '')), o.def);

    // 关于页
    await ev(`(async () => { ${CLEAN} await A.go('settings', { focus: 'about' }); })()`);
    await until(ev, "!!document.getElementById('aboutVersion')", 15000);
    o = await ev("document.getElementById('aboutVersion').textContent");
    const tag = zh ? ED.aboutTag : (ED.PUBLIC ? ' (public edition)' : ' (internal edition)');
    check('关于', `${L}：关于页是 ${pkg.version}${tag.trim()}`, o.includes(pkg.version) && o.endsWith(tag), o);

    // MC 百科的设置卡片：只在中文界面；内部版是「实验性」，公开版是「概念演示」
    o = await ev(`(async () => { ${CLEAN} await A.go('settings', { focus: 'download' }); ${wait(300)} const g = document.getElementById('set-mcmod'); return { has: !!g, title: g ? (g.querySelector('h3') || g).textContent.trim().slice(0, 40) : '' }; })()`);
    const mcWant = ED.mcmod === 'real' ? '实验性' : '概念演示';
    check('MC 百科', zh ? `中文：设置里有 MC 百科的卡片，是「${mcWant}」` : '英文：设置里没有 MC 百科的卡片（只给中文界面）', zh ? o.has && o.title.includes(mcWant) : !o.has, o);

    // 首次启动向导的页数
    o = await ev(`(async () => { ${CLEAN} A.setup.open(); ${wait(700)} const m = document.querySelector('.setup-modal'); const n = m ? m.querySelectorAll('.msteps > li').length : -1;
      const names = m ? [...m.querySelectorAll('.msteps .ms-label')].map((x) => x.textContent.trim()) : []; ${CLEAN} return { n, names }; })()`);
    check('向导', `${L}：首次启动向导 ${ED.setupSteps[zh ? 'zh' : 'en']} 页`, o.n === ED.setupSteps[zh ? 'zh' : 'en'], o);

    // 参考与致谢：公开版多一节「概念演示（公开版未包含）」，内部版没有
    o = await ev(`(async () => { ${CLEAN} A.credits.open(); ${wait(500)} const titles = [...document.querySelectorAll('.modal-back .cr-sec > h3')].map((x) => x.textContent.trim()); ${CLEAN} return titles; })()`);
    const conceptTitle = zh ? '概念演示（公开版未包含）' : 'Concept demo (not in the public edition)';
    check('致谢', `${L}：「参考与致谢」${ED.mcmod === 'concept' ? '有' : '没有'}概念演示那一节`, o.includes(conceptTitle) === (ED.mcmod === 'concept') && o.length >= 3, o);

    // 调试菜单要不要密码（rc11-ui.js 查得更细）
    o = await ev('({ needPass: A.debugMenu.needPass(), standin: !!(A.debugKey && A.debugKey.PUBLIC_STANDIN) })');
    check('调试菜单', `${L}：调试菜单${ED.debugPassword ? '要' : '不要'}密码`, o.needPass === ED.debugPassword && o.standin === !ED.debugPassword, o);

    // 更新日志：卡片和弹窗里的版本号按这个版本显示（公开版显示 1.x），最新那条标「当前」
    if (zh) {
      // 启动时面板是收着的：像玩家一样在主页上打开，切到「启动器」标签
      await ev(`(async () => { ${CLEAN} await A.go('home'); await A.setConfig({ news: { enabled: true, open: true, tab: 'launcher' } }); })()`);
      const shown = await until(ev, "document.querySelectorAll('.news .cl-card').length > 0", 15000);
      o = await ev(`(async () => {
        const vs = A.changelog().map((e) => e.v);
        const cards = [...document.querySelectorAll('.news .cl-card')];
        const heads = cards.map((c) => (c.querySelector('.cl-head b') || {}).textContent);
        const cur = cards.length ? !!cards[0].querySelector('.cl-cur') : false;
        if (cards[0]) cards[0].click(); ${wait(500)}
        const m = [...document.querySelectorAll('.modal-back .modal')].pop();
        const modalTitle = m ? (m.querySelector('.modal-head') || m).textContent.trim().slice(0, 80) : '';
        ${CLEAN} return { vs, heads, cur, modalTitle }; })()`);
      const want = (o.vs || []).map((v) => `v${ED.shownVersion(v)}`);
      check('更新日志', `中文：更新日志卡片的版本号按${ED.PUBLIC ? '公开版（1.x）' : '内部版'}显示，最新那条标「当前」`, shown && JSON.stringify(o.heads) === JSON.stringify(want) && o.cur, { heads: o.heads, want });
      const first = ED.shownVersion((o.vs || [])[0] || '');
      check('更新日志', '中文：点开以后弹窗标题里也是这个版本号', !!first && o.modalTitle.includes(first) && (!ED.PUBLIC || !o.modalTitle.includes((o.vs || [])[0])), o.modalTitle);
    }

    check('页面', `${L}：没有页面错误`, a.errors.length === 0, a.errors.slice(0, 3));
    await a.stop();
  }

  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
