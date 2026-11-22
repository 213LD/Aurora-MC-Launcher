'use strict';
/**
 * 界面快照（rc9）：防「改了一处，别处好好的界面跟着坏了」——错位、字不居中、叠在一起、入口不见了。
 *   node scripts/regress/ui-snapshot.js            和基线比，有差别就失败，逐条列出来
 *   node scripts/regress/ui-snapshot.js --update   差别都是这次有意改的：把现在的样子存成新基线（scripts/regress/ui-snapshot.json）
 *
 * 为什么要有它：rc3 给设置行加了「放不下就换行」，设置「游戏」里上下排的几行从此空出一大块，rc7 试用才看到；
 * 当时的测试只量了那一版新做的东西，没人回头看别的页面。专门写的测试只守得住想得到的地方，这个测试不用想。
 *
 * 做两件事：
 * 一、和基线比（上一次确认过的样子）。每个页面、设置的每一类，记下：
 *       - 有哪些入口（按钮、标签、开关、输入框，侧边栏和顶栏）
 *       - 每一块在它外面那一块里的位置和宽高
 *       - 每个按钮里的字和图标偏离按钮正中多少
 *     入口少了、哪一块挪了地方或者变了大小、按钮里的字挪了，都逐条列出来。是有意改的就 --update，
 *     基线文件的变化跟着提交走，发版汇报里要写这次界面快照变了什么。
 * 二、不靠基线、任何时候都不该出现的（新做的界面第一次就能查）：
 *       - 页面横向溢出、控件伸到窗口外面
 *       - 按钮上的字被截断；一行字上下被切掉
 *       - 该居中的没居中：只有图标的按钮、分段按钮、标签、写了居中的按钮，字和图标要在正中；按钮里的内容上下要居中
 *       - 并排的两块叠在一起
 *       - 字和底色几乎一个颜色（看不见）
 *
 * 每次运行最后还有一段自检：故意把界面弄坏几处（按以前真出过的问题来：设置行空出一大块、按钮的字偏到一边、
 * 一块挪了位置、两块叠在一起、入口没了、字和底色同色），确认上面的检查每一处都报得出来。检查自己失灵了也会失败。
 *
 * 数据是固定的（假的配置、账户、一个假的 Java 17，渐变背景，不联网），窗口固定 1200×760 和最小的 1000×660，三种界面风格、深浅色。
 * 位置和大小只在文字量法一样时比（同一台电脑、同样的显示器和缩放、没连远程桌面）：不一样时只比入口，不比位置大小。
 * 弹窗和抽屉（DIALOGS）在带 dialogs 的几种外观里量：rc10 加了 9 个；rc11 加了首次启动向导的每一步，
 * 和要联网才能打开的几个（新建配置和它的后两步、安装版本、怀旧版本）——这几个另开一个窗口量，
 * 网络由 net-fixture.js 用固定的版本列表顶替。
 * 英文界面（rc11）：最后一种外观是英文，18 个页面和全部弹窗都量。英文比中文长，最容易出溢出和截断。
 * 没管到的：其余的弹窗、点开的菜单、别的弹窗第二步以后的样子（那些由 ui.js、walk.js 和各版的专门测试看），主页的像素场景。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG, fakeVersion } = require('./robust-ui');
const { sleep, guard, until, calm, ready } = require('./cdp');
const { PAGES, SETTINGS } = require('./pages');

const BASE = require('./editions').BASE;
const FILE = path.join(__dirname, 'ui-snapshot.json');
const UPDATE = process.argv.includes('--update');
const results = [];
guard(results, 'ui-snapshot');
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 1500)}` : ''}`);
}

const VARIANTS = [
  { id: 'aurora', dialogs: true, name: '极光 深色 1200×760', style: 'aurora', theme: 'dark', w: 1200, h: 760 },
  { id: 'aurora-min', dialogs: true, name: '极光 深色 最小窗口 1000×660', style: 'aurora', theme: 'dark', w: 1000, h: 660 },
  { id: 'aurora-light', name: '极光 浅色 1200×760', style: 'aurora', theme: 'light', w: 1200, h: 760 },
  { id: 'pixel', name: '像素原版 深色 1200×760', style: 'pixel', theme: 'dark', w: 1200, h: 760 },
  { id: 'pixel-light', dialogs: true, name: '像素原版 浅色 1200×760', style: 'pixel', theme: 'light', w: 1200, h: 760 },
  { id: 'compact', dialogs: true, name: '经典紧凑 深色 1200×760', style: 'compact', theme: 'dark', w: 1200, h: 760 },
  // 英文界面放最后：换语言要重新加载整个窗口
  { id: 'aurora-en', dialogs: true, lang: 'en', name: '极光 深色 英文界面 1200×760', style: 'aurora', theme: 'dark', w: 1200, h: 760 },
];
const VIEWS = [...PAGES.filter((p) => p !== 'settings'), ...SETTINGS.map((c) => `settings:${c}`)];
/**
 * 弹窗、抽屉（rc10：以前只量页面，弹窗里面没管）。[编号, 名字, 打开它的一句代码]。
 * 量的是最上面那个弹窗 / 抽屉；量完直接拿掉，不点里面的按钮。带 dialogs 的四种外观各量一遍
 */
// 点最上面那个弹窗底部的主按钮（下一步）n 次；点不到就报错，这个弹窗就算没打开
// 每一页停 1.6 秒再点（rc16）：向导防连点——刚翻过来 0.45 秒内的点击不算，一页停不到 1.5 秒就翻过去的，最后一页会多一段提示、
// 「完成」要等 5 秒。快照量的是正常看的玩家看到的样子，所以像人一样每页停一下
const NEXT = (n) => `for (let i = 0; i < ${n}; i++) { await new Promise((r) => setTimeout(r, 1600)); const m = [...document.querySelectorAll('.modal-back .modal')].pop(); const b = m && [...m.querySelectorAll('.modal-foot .btn.primary')].pop(); if (!b) throw new Error('没有下一步的按钮'); if (/^(完成|Finish)/.test(b.textContent.trim())) throw new Error('已经是最后一步了，不点「完成」'); b.click(); }`;
// 点最上面那个弹窗里的第 k 个选择卡片
const PICK = (k) => `await new Promise((r) => setTimeout(r, 350)); { const m = [...document.querySelectorAll('.modal-back .modal')].pop(); const c = m && m.querySelectorAll('.choice')[${k}]; if (!c) throw new Error('没有这个选项'); c.click(); }`;
const DIALOGS = [
  ['export', '弹窗·导出数据', 'A.migrateUi.exportDialog(); 1'],
  ['import', '弹窗·导入数据', 'A.migrateUi.importDialog(); 1'],
  ['import-foreign', '弹窗·从其他启动器导入', "A.migrateUi.importDialog({ source: 'foreign' }); 1"],
  ['credits', '弹窗·参考与致谢', 'A.credits.open(); 1'],
  ['skin', '抽屉·皮肤', "A.go('accounts'); A.skinDrawer(A.state.accounts.accounts[0]); 1"],
  ['debug', '弹窗·一键 Debug', "A.debugDialog(A.state.installed.find((x) => x.id === 'Fab')); 1"],
  ['confirm', '弹窗·确认', "A.confirm('删除「Fab」？删除后不能恢复。', { title: '删除配置', okText: '删除', danger: true }); 1"],
  ['logdrawer', '抽屉·游戏日志', 'A.logs.open(); 1'],
  ['setup', '弹窗·首次启动向导', 'A.setup.open(); 1'],
  // 向导的后面几步（rc11）：一步一步点「下一步」过去。最后一步的主按钮是「完成」，不点
  // 第 7 步「MC 百科」（rc16）只有内部版有（公开版的 MC 百科是概念演示，没有这一页；editions.js 的 setupSteps）
  ...[2, 3, 4, 5, 6].map((k) => [`setup-${k}`, `弹窗·首次启动向导·第 ${k} 步`, `A.setup.open(); ${NEXT(k - 1)}`]),
  // 第四项的 when：这一种外观里有没有这个弹窗（页面里求值，假就不量），英文界面没有这一步
  ...(require('./editions').setupSteps.zh === 7 ? [['setup-7', '弹窗·首次启动向导·第 7 步', `A.setup.open(); ${NEXT(6)}`, { when: '!!(A.mcmodUi && A.mcmodUi.setupPage && A.mcmodUi.zhUi())' }]] : []),
  // 要联网才能打开的（rc11）：另开一个窗口量，网络是 net-fixture.js 里固定的数据。第四项 online
  ['new-profile', '弹窗·新建配置', 'A.newProfileDialog(); 1', { online: true }],
  ['new-profile-version', '弹窗·新建配置·原版选版本', `A.newProfileDialog(); ${PICK(0)}`, { online: true }],
  ['new-profile-custom', '弹窗·新建配置·自定义选版本', `A.newProfileDialog(); ${PICK(2)}`, { online: true }],
  ['install', '弹窗·安装版本', "A.installDialog('1.20.1'); 1", { online: true }],
  ['install-loader', '弹窗·安装版本·选了加载器', "A.installDialog('1.20.1', { requireLoader: true }); 1", { online: true }],
  ['nostalgia', '弹窗·怀旧版本', 'A.nostalgiaDialog(); 1', { online: true }],
];
const isOnline = (d) => !!(d[3] && d[3].online);
const DIALOG_ROOT = "(() => { const m = [...document.querySelectorAll('.modal-back .modal, .drawer, #logDrawer.open')].filter((x) => x.getBoundingClientRect().width > 0); return m[m.length - 1] || null; })()";
const CLOSE_ALL = "(() => { document.querySelectorAll('.modal-back, .toast').forEach((x) => x.remove()); if (A.closeDrawers) A.closeDrawers(); A.logs.close(); A.closePopover(); return 1; })()";
const KEYS = [...VIEWS, ...DIALOGS.map((d) => `dialog:${d[0]}`)];
const VIEW_NAME = { home: '主页', versions: '游戏配置', download: '下载中心', mods: 'Mod 管理', planner: 'Mod 配置器', repair: '一键修复', tasks: '任务中心', logs: '日志中心', java: 'Java', accounts: '账户', skins: '皮肤',
  ...Object.fromEntries(DIALOGS.map((d) => [`dialog:${d[0]}`, d[1]])),
  'settings:general': '设置·常规', 'settings:look': '设置·外观', 'settings:game': '设置·游戏', 'settings:download': '设置·下载', 'settings:data': '设置·数据', 'settings:a11y': '设置·无障碍', 'settings:about': '设置·关于' };

const { COLLECT, GLOBAL } = require('./snapshot-collect'); // 在页面里跑的检查，walk.js 也用

function prepare({ data, game }) {
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({ selected: 'a1', accounts: [{ id: 'a1', type: 'offline', name: 'Snapshot', uuid: '00000000000000000000000000000001' }] }));
  const fab = fakeVersion(game, 'Fab', { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }], inheritsFrom: '1.20.1' });
  for (let j = 0; j < 3; j++) fs.writeFileSync(path.join(fab, 'mods', `mod${j}.jar`), 'x');
  fs.mkdirSync(path.join(fab, 'saves', 'World'), { recursive: true });
  fs.writeFileSync(path.join(fab, 'saves', 'World', 'level.dat'), 'x');
}
// 这台电脑上装了哪些 Java 不能算进快照（装一个、卸一个，Java 页和配置卡片上的标记就变了）：固定成一个假的 Java 17
const JAVAS = [{ home: 'C:\\Java\\jdk-17', path: 'C:\\Java\\jdk-17\\bin\\java.exe', javaw: 'C:\\Java\\jdk-17\\bin\\javaw.exe', version: '17.0.9', major: 17, arch: 'x64', vendor: 'Eclipse Adoptium', isJdk: true, source: '测试' }];
// 别的启动器也固定：一个假的官方启动器目录（不在这台电脑上真的去找）
const FOREIGN = [{ dir: 'C:\\Games\\.minecraft', label: '官方启动器', count: 3, kind: 'game' }];
const CONFIG = (game) => ({ ...BASE_CONFIG(game), theme: 'dark', background: { type: 'gradient' }, music: { enabled: false }, sound: { enabled: false }, selectedVersion: 'Fab', versionSettings: { Fab: { isolation: 'on' } }, logs: { keepDays: 30 } });

async function openView(a, view) {
  const [pid, cat] = view.split(':');
  await a.ev(`(() => { A.go(${JSON.stringify(pid)}); return 1; })()`);
  if (cat) await a.ev(`(() => { const b = document.querySelector('#page-settings .set-cat[data-cat=${cat}]'); if (b) b.click(); return !!b; })()`);
  // 等页面画完、不再变：元素个数、文字长度、整页高度连着六次都一样（约 1 秒），没有转圈，也没有「正在获取」这类字。
  // 三次（约半秒）不够：联网失败后的重试中间要等 0.3 ~ 0.6 秒，那一行「获取失败」出来得早晚不一定（rc10 又碰到）。
  // 只比两次元素个数不够：机器忙的时候后到的内容（Java 检测的结果、数据占了多大）还没到就量了，
  // 一行字变长换行，后面的全跟着挪（rc9：同时开着另一个测试窗口时碰到过，报了 14 处不同）
  await settle(a, "document.querySelector('.page.active')");
}

async function settle(a, rootJs) {
  await a.ev('window.__snapSig = null; window.__snapSame = 0; 1');
  await until(a.ev, `(() => { const r = ${rootJs}; if (!r) return false; const sig = r.querySelectorAll('*').length + ':' + r.innerText.length + ':' + r.scrollHeight; window.__snapSame = sig === window.__snapSig ? window.__snapSame + 1 : 0; window.__snapSig = sig; return window.__snapSame >= 5 && !r.querySelector('.spinner') && !/正在(获取|加载|读取|检测|查找|计算|扫描|连接)|加载中|(Loading|Fetching|Reading|Detecting|Scanning|Calculating|Connecting)[^.\\n]{0,30}(…|\\.\\.\\.)/.test(r.innerText); })()`, 12000, 150);
}

/** 换界面语言：主进程写设置，整个窗口按新语言重新加载。等新页面起来（旧页面上做的记号没了，语言也对了） */
async function setLang(a, lang) {
  if ((await a.ev('window.I18N && I18N.getLang()')) === lang) return;
  await a.ev(`(() => { window.__snapOld = 1; A.api('app:setLanguage', ${JSON.stringify(lang)}); return 1; })()`);
  await until(a.ev, `!window.__snapOld && !!(window.A && A.state && A.state.config && A.state.info && A.pages && A.pages.home && window.I18N && I18N.getLang() === ${JSON.stringify(lang)})`, 30000, 200);
  await calm(a.ev); // 让开头的那些异步的东西（检测 Java、读配置）先到；每一页量之前还会再等它不变
}

async function setVariant(a, v) {
  await setLang(a, v.lang || 'zh-CN');
  await a.send('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: false });
  await a.ev(`A.setConfig({ theme: ${JSON.stringify(v.theme)}, ui: { style: ${JSON.stringify(v.style)} } }).then(() => 1)`);
  await a.ev("(() => { document.querySelectorAll('.modal-back, .toast').forEach((x) => x.remove()); A.go('home'); return 1; })()");
  await calm(a.ev);
}

/** 量一批弹窗：挨个打开、等它不再变、量、拿掉 */
async function captureDialogs(a, list, views) {
  for (const [id, , open, opt] of list) {
    if (opt && opt.when && !(await a.ev(opt.when))) continue;
    await a.ev(CLOSE_ALL);
    const err = await a.ev(`(async () => { try { ${open}; return ''; } catch (e) { return String(e.message || e); } })()`);
    await settle(a, DIALOG_ROOT);
    views[`dialog:${id}`] = (err ? null : await a.ev(COLLECT.replace("document.querySelector('.page.active')", DIALOG_ROOT))) || { entries: [], boxes: {}, problems: [`这个弹窗没有打开${err ? `（${err}）` : ''}`] };
  }
  await a.ev(CLOSE_ALL);
}

async function capture(a) {
  const snap = { env: null, variants: {} };
  for (const v of VARIANTS) {
    await setVariant(a, v);
    const g = await a.ev(GLOBAL);
    if (!snap.env) snap.env = g.env;
    const views = {};
    for (const view of VIEWS) {
      await openView(a, view);
      views[view] = (await a.ev(COLLECT)) || { entries: [], boxes: {}, problems: ['这一页没有显示出来'] };
    }
    if (v.dialogs) await captureDialogs(a, DIALOGS.filter((d) => !isOnline(d)), views);
    snap.variants[v.id] = { nav: g.nav, bar: g.bar, views };
  }
  return snap;
}

/** 要联网才能打开的弹窗：在另一个「有网」的窗口里量（网络是 net-fixture.js 的固定数据），并进同一份快照 */
async function captureOnline(b, snap) {
  for (const v of VARIANTS.filter((x) => x.dialogs)) {
    await setVariant(b, v);
    await until(b.ev, '!A.offline.on()', 8000, 200);
    await captureDialogs(b, DIALOGS.filter(isOnline), snap.variants[v.id].views);
  }
}

/** 两份快照比一遍，返回一条条看得懂的差别 */
function diff(base, now, sameEnv, variants = VARIANTS, views = KEYS) {
  const out = [];
  for (const v of variants) {
    const b = base.variants[v.id]; const n = now.variants[v.id];
    if (!b) { out.push(`[${v.name}] 基线里没有这种外观`); continue; }
    const list = (label, x, y) => {
      for (const k of x.filter((i) => !y.includes(i))) out.push(`[${v.name}] ${label}不见了：${k}`);
      for (const k of y.filter((i) => !x.includes(i))) out.push(`[${v.name}] ${label}新出现：${k}`);
    };
    list('侧边栏的入口', b.nav, n.nav);
    list('顶栏的按钮', b.bar, n.bar);
    for (const view of views) {
      const bv = b.views[view]; const nv = n.views[view];
      if (!nv) continue; // 这种外观不量弹窗
      const where = `[${v.name} · ${VIEW_NAME[view] || view}]`;
      if (!bv) { out.push(`${where} 基线里没有这一页`); continue; }
      for (const k of bv.entries.filter((i) => !nv.entries.includes(i))) out.push(`${where} 入口不见了：${k}`);
      for (const k of nv.entries.filter((i) => !bv.entries.includes(i))) out.push(`${where} 新出现的入口：${k}`);
      if (!sameEnv) continue;
      const gone = Object.keys(bv.boxes).filter((k) => !(k in nv.boxes));
      const added = Object.keys(nv.boxes).filter((k) => !(k in bv.boxes));
      if (gone.length) out.push(`${where} 少了 ${gone.length} 块：${gone.slice(0, 3).join('，')}${gone.length > 3 ? ' …' : ''}`);
      if (added.length) out.push(`${where} 多了 ${added.length} 块：${added.slice(0, 3).join('，')}${added.length > 3 ? ' …' : ''}`);
      // 一处改动会带着一串变化：里面一块变高，外面几层跟着变高，排在后面的跟着往下挪。只报源头：
      // 大小变了，里面有同样变了的就不报外面这层；位置挪了，同一层里前面已经有变了的就不报后面的
      const big = (p, q) => Math.abs(p - q) > Math.max(6, Math.abs(p) * 0.08);
      const ch = [];
      for (const [k, b0] of Object.entries(bv.boxes)) {
        const m = nv.boxes[k];
        if (!m) continue;
        const c = { k, parent: k.slice(0, k.lastIndexOf('/')), b0, m, h: big(b0[3], m[3]), w: big(b0[2], m[2]), x: Math.abs(b0[0] - m[0]) > 4, y: Math.abs(b0[1] - m[1]) > 4,
          ix: b0.length > 4 && m.length > 4 && Math.abs(b0[4] - m[4]) > 2, iy: b0.length > 4 && m.length > 4 && Math.abs(b0[5] - m[5]) > 2 };
        if (c.h || c.w || c.x || c.y || c.ix || c.iy) ch.push(c);
      }
      const lines = [];
      const seen = new Set(); // 这一层里已经有一块变过了
      for (const c of ch) {
        const inner = (d) => ch.some((o) => o !== c && o.k.startsWith(`${c.k}/`) && o[d]);
        const msgs = [];
        if (c.h && !inner('h')) msgs.push(`高 ${c.b0[3]} → ${c.m[3]}`);
        if (c.w && !inner('w')) msgs.push(`宽 ${c.b0[2]} → ${c.m[2]}`);
        const first = !seen.has(c.parent);
        if (c.x && first) msgs.push(`往${c.m[0] > c.b0[0] ? '右' : '左'}挪了 ${Math.abs(c.m[0] - c.b0[0])}`);
        if (c.y && first) msgs.push(`往${c.m[1] > c.b0[1] ? '下' : '上'}挪了 ${Math.abs(c.m[1] - c.b0[1])}`);
        if (c.ix) msgs.push(`里面的字和图标左右挪了 ${Math.abs(c.m[4] - c.b0[4])}`);
        if (c.iy) msgs.push(`里面的字和图标上下挪了 ${Math.abs(c.m[5] - c.b0[5])}`);
        seen.add(c.parent);
        if (msgs.length) {
          const t0 = (bv.texts || {})[c.k]; const t1 = (nv.texts || {})[c.k];
          const note = t1 == null && t0 == null ? '' : t0 === t1 ? `（「${t1}」）` : `（上面的字也变了：基线「${t0 || ''}」，现在「${t1 || ''}」）`;
          lines.push(`${where} ${c.k}：${msgs.join('，')}${note}`);
        }
      }
      for (const x of lines.slice(0, 12)) out.push(x);
      if (lines.length > 12) out.push(`${where} 还有 ${lines.length - 12} 块变了位置或大小`);
    }
  }
  return out;
}

/**
 * 自检：故意把界面弄坏，看上面的检查报不报得出来。坏法照着以前真出过的问题：
 * 每一条是 [名字, 在哪一页, 往页面里加的样式或做的手脚, 报告里应该出现的字]
 */
const BREAKS = [
  ['设置里上下排的行空出一大块（rc3 → rc8 的那个问题）', 'settings:game', { css: '.set-row.col > .s-text { flex: 1 1 240px !important; }' }, /高 \d+ → \d+/],
  ['一块挪了位置（错位）', 'settings:general', { js: "(() => { const el = [...document.querySelectorAll('.page.active .set-pane .set-row')].filter((x) => x.offsetParent)[1]; el.style.position = 'relative'; el.style.left = '30px'; return 1; })()" }, /往右挪了 30/],
  ['按钮里的字偏到一边', 'versions', { js: "(() => { const b = [...document.querySelectorAll('.page.active .page-head .btn')].filter((x) => x.offsetParent)[0]; b.style.minWidth = (b.offsetWidth + 60) + 'px'; b.style.justifyContent = 'flex-start'; return 1; })()" }, /里面的字和图标左右挪了/],
  ['只有图标的按钮，图标没在正中', ['versions', 'mods', 'java', 'accounts', 'skins', 'tasks', 'download', 'home'], { js: "(() => { const b = [...document.querySelectorAll('.page.active button')].filter((x) => x.offsetParent && !x.innerText.trim() && x.querySelector('svg'))[0]; if (!b) return 0; b.style.paddingLeft = '14px'; b.style.paddingRight = '0'; b.style.minWidth = (b.offsetWidth + 14) + 'px'; return 1; })()" }, /左右没居中/],
  ['按钮里的字上下没对齐', 'versions', { css: '.page.active .page-head .btn { padding-top: 14px !important; padding-bottom: 0 !important; }' }, /上下没居中/],
  ['并排的两块叠在一起（按钮压在标题上）', 'versions', { js: "(() => { const hd = document.querySelector('.page.active .page-head'); const kids = [...hd.children].filter((x) => x.offsetParent); const a = kids[0].getBoundingClientRect(); const last = kids[kids.length - 1]; const b = last.getBoundingClientRect(); last.style.position = 'relative'; last.style.left = (a.left - b.left + 20) + 'px'; last.style.top = (a.top - b.top + 6) + 'px'; return kids.length > 1 ? 1 : 0; })()" }, /叠在一起/],
  ['入口不见了', 'settings:data', { js: "(() => { const b = [...document.querySelectorAll('.page.active .set-pane button')].filter((x) => x.offsetParent)[0]; if (b) b.style.display = 'none'; return !!b; })()" }, /入口不见了/],
  ['侧边栏少了一项', 'home', { js: "(() => { const n = document.querySelectorAll('#nav .nav-item')[3]; n.style.display = 'none'; return 1; })()" }, /侧边栏的入口不见了/],
  ['字和底色一个颜色（看不见）', 'settings:general', { css: '.page.active .set-pane-title { color: var(--bg-1, #0b0d14) !important; background: var(--bg-1, #0b0d14) !important; }' }, /几乎一个颜色/],
  ['控件伸到窗口外面', 'versions', { js: "(() => { const b = [...document.querySelectorAll('.page.active .page-head .btn')].filter((x) => x.offsetParent).pop(); b.style.position = 'relative'; b.style.left = '400px'; return 1; })()" }, /伸到窗口外面|横向溢出/],
  // 很长、不带空格的名字把卡片撑出页面（rc13 资源卡片的作者名）：报出来，还要说清楚是哪一块
  ['一块比页面宽，撑出去了', 'settings:general', { js: "(() => { const p = document.querySelector('.page.active .page-inner'); const d = document.createElement('div'); d.setAttribute('data-snap-break', ''); d.className = 'snap-wide'; d.style.cssText = 'width:' + (p.clientWidth + 40) + 'px;height:12px'; p.appendChild(d); return 1; })()" }, /横向溢出.*伸出去的：div\.snap-wide/],
  ['只有字伸出去（很长、不换行的单词，盒子本身没变宽）', 'settings:general', { js: "(() => { const p = document.querySelector('.page.active .page-inner'); const d = document.createElement('div'); d.setAttribute('data-snap-break', ''); d.style.cssText = 'width:120px;white-space:nowrap'; d.textContent = 'W'.repeat(400); p.appendChild(d); return 1; })()" }, /横向溢出.*伸出去的：字/],
];
/** 反过来：故意这么做、不是毛病的，不能报（报了以后就会有人把真毛病也当成「又是误报」） */
const FINE = [
  // Mod 配置器底部的「上一步 / 下一步」：贴在底部、盖在滚动的清单上，两边比内容各宽 14 像素
  ['贴边的条比内容宽一点、盖在滚动的内容上', 'settings:general', { js: "(() => { const p = document.querySelector('.page.active .page-inner'); const d = document.createElement('div'); d.setAttribute('data-snap-break', ''); d.style.cssText = 'position:sticky;bottom:0;margin:-60px -14px 0;height:60px;padding:12px 14px;background:#123'; const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'OK'; d.appendChild(b); p.appendChild(d); return 1; })()" }, /横向溢出|叠在一起/],
];

async function selfTest(a, good) {
  const v = VARIANTS[0];
  await setVariant(a, v);
  const missed = [];
  const wrong = [];
  for (const [name, where, how, want, fine] of [...BREAKS, ...FINE.map((x) => [...x, true])]) {
    // 写了几个页面的：挨个试，找到能下手的那个（比如哪一页有只带图标的按钮）
    let view = null;
    for (const v1 of [].concat(where)) {
      await openView(a, v1);
      // 记下每个元素原来的行内样式，这一条查完原样放回去（页面再进一次不一定重画）
      await a.ev("(() => { window.__snapStyles = [...document.querySelectorAll('.page.active, .page.active *, #nav *')].map((el) => [el, el.getAttribute('style')]); return 1; })()");
      if (how.css) await a.ev(`(() => { const s = document.createElement('style'); s.id = 'snap-break'; s.textContent = ${JSON.stringify(how.css)}; document.head.appendChild(s); return 1; })()`);
      if (!how.js || await a.ev(how.js)) { view = v1; break; }
    }
    if (!view) { missed.push(`${name}（没找到能下手的地方）`); continue; }
    await calm(a.ev);
    const g = await a.ev(GLOBAL);
    const got = await a.ev(COLLECT);
    const now = { variants: { [v.id]: { nav: g.nav, bar: g.bar, views: { [view]: got } } } };
    const report = [...diff(good, now, true, [v], [view]), ...got.problems.filter((p) => !good.variants[v.id].views[view].problems.includes(p))];
    if (fine) { const bad = report.filter((x) => want.test(x)); if (bad.length) wrong.push(`${name}（报了：${bad.slice(0, 3).join('；')}）`); }
    else if (!report.some((x) => want.test(x))) missed.push(`${name}（报出来的是：${report.slice(0, 3).join('；') || '什么都没报'}）`);
    await a.ev("(() => { const s = document.getElementById('snap-break'); if (s) s.remove(); document.querySelectorAll('[data-snap-break]').forEach((x) => x.remove()); return 1; })()");
    await a.ev("(() => { for (const [el, st] of window.__snapStyles || []) { if (st == null) el.removeAttribute('style'); else el.setAttribute('style', st); } window.__snapStyles = null; return 1; })()");
  }
  check('界面快照', `自检：故意弄坏 ${BREAKS.length} 处（空出一大块、错位、字和图标没居中、叠在一起、入口没了、字看不见、伸到窗口外、撑出页面），每一处都报得出来`, missed.length === 0, missed);
  check('界面快照', `自检：故意这么做的 ${FINE.length} 处（贴在底部、比内容宽一点的条）不当成毛病`, wrong.length === 0, wrong);
}

(async () => {
  const a = await start('ui-snapshot', { prepare, config: CONFIG, javas: JAVAS, foreign: FOREIGN });
  if (a.startError) throw new Error(`启动器起不来：${a.startError}`);
  await ready(a.ev);
  const snap = await capture(a);
  check('界面快照', '每个页面都进得去，没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  for (const v of VARIANTS) {
    const bad = [];
    for (const view of KEYS) for (const p of (snap.variants[v.id].views[view] || { problems: [] }).problems) bad.push(`${VIEW_NAME[view] || view}：${p}`);
    check('界面快照', `${v.name}：没有溢出、截断、叠在一起、没居中、看不见的字`, bad.length === 0, bad.slice(0, 12));
  }
  await selfTest(a, snap);
  await a.stop();
  // 要联网的弹窗：第二个窗口，网络用固定的数据顶替
  const b = await start('ui-snapshot-online', { prepare, config: CONFIG, javas: JAVAS, foreign: FOREIGN, badnet: 'fixture' });
  if (b.startError) throw new Error(`第二个窗口（有网的）起不来：${b.startError}`);
  await calm(b.ev);
  await captureOnline(b, snap);
  check('界面快照', '要联网的弹窗（新建配置、安装版本、怀旧版本）也打得开，没有页面错误', b.errors.length === 0, b.errors.slice(0, 5));
  await b.stop();
  const pretty = () => `${JSON.stringify(snap, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)(?:,\n\s+(-?[\d.]+),\n\s+(-?[\d.]+))?\n\s+\]/g, (m, x, y, w, h, dx, dy) => `[${[x, y, w, h].concat(dx === undefined ? [] : [dx, dy]).join(', ')}]`)}\n`;
  if (!fs.existsSync(FILE)) {
    if (UPDATE) { fs.writeFileSync(FILE, pretty(), 'utf8'); check('界面快照', '第一次：存下基线', true, FILE); } else check('界面快照', '还没有基线（先跑一次 --update）', false, FILE);
  } else {
    const base = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const sameEnv = base.env === snap.env;
    const d = diff(base, snap, sameEnv);
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(path.join(BASE, 'ui-snapshot-diff.txt'), `${d.join('\n')}\n`, 'utf8');
    // 这一次量到的整份也留着（rc13）：有差别时拿它和基线逐项对，才查得出是哪个元素先变的
    fs.writeFileSync(path.join(BASE, 'ui-snapshot-last.json'), pretty(), 'utf8');
    if (UPDATE) {
      fs.writeFileSync(FILE, pretty(), 'utf8');
      check('界面快照', `基线已更新（和上一份比有 ${d.length} 处不同，都要在发版汇报里交代）`, true, d.slice(0, 40).join('；'));
      console.log(d.map((x) => `  ${x}`).join('\n'));
    } else {
      if (!sameEnv) console.log(`  文字的量法和基线不一样：基线 ${base.env}，这次 ${snap.env}`);
      check('界面快照', `入口、位置、大小跟上次确认过的一样${sameEnv ? '' : '（文字的量法和基线不一样——换了电脑、显示器、缩放，或者连着远程桌面：只比了入口，没比位置大小）'}`, d.length === 0, d.length ? `${d.length} 处不同（完整清单在 ${path.join(BASE, 'ui-snapshot-diff.txt')}；是有意改的就跑 --update）：${d.slice(0, 14).join('；')}` : '');
      if (d.length) console.log(d.slice(0, 80).map((x) => `  ${x}`).join('\n'));
    }
  }
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
