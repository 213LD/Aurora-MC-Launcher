'use strict';
/**
 * 按钮走查（2.0.0-pre1）：每个页面的每个按钮都点一遍，报错就记下来。node scripts/regress/walk.js [页面,页面]
 * - 每个页面重新启动一次隔离的启动器（点开关会改设置，互不影响）
 * - 外面的东西都换掉了（walk-hook.js）；点完马上取消跑起来的任务，不会真的下载
 * - 点出来的每一层（弹窗、菜单、抽屉）里能点的也挨个点（数据是隔离的，确认删除也真的点）；点出更深的一层、或者同一个弹窗换了内容
 *   （向导的下一步），就接着往里走，一直走到没有新东西为止（rc12；以前只走到第二层弹窗）。每一种内容只走一遍，最深 MAX_DEPTH 层
 * - 每点一步都做一遍界面检查（rc12，和界面快照用同一套，snapshot-collect.js）：最上面那一层和页面本身有没有伸到窗口外面、横向溢出、
 *   字被截断、没居中、两块叠在一起、字和底色一个颜色。不截图，全靠量。查出来的和 walk-ui-known.json（看过、确认没问题的）比，
 *   多出来的就算失败；--update 把现在的存成「看过的」
 * - 走到的每一层有哪些能点的，记在 walk-layers.json；下次少了哪一层、哪个按钮，报告里列出来（只报告：下载页的内容跟着网络变）
 * - 点了筛选或开关，有的按钮会看不见：走完一轮重新启动，把没点到的补上
 * - 记录：脚本异常、console.error、主进程 [ipc:xxx] 报错、crit 级提示；结果写进 AURORA_REGRESS_DIR/walk-report.json
 * 点了以后报的错只报告（很多是空输入被拒绝这类正常的）；走不完（页面崩了）和新出现的界面毛病算失败
 */
const { freePort, NO_THROTTLE, calm } = require('./cdp');
const { COLLECT, collectAt } = require('./snapshot-collect');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 设置页分了类（rc2），一次只显示一类：每类单独走一遍（settings:look 这样写）
const ALL = require('./pages'); // 页面清单只有一份（pages.js）
const SETTINGS = ALL.SETTINGS.map((c) => `settings:${c}`);
const PAGES = [...ALL.PAGES.filter((p) => p !== 'settings'), ...SETTINGS];
const MAX_PER_PAGE = 260;
const PAGE_LIMIT_MS = Number(process.env.AURORA_WALK_LIMIT_MS) || 900000; // 每个页面最多走多久（rc12 走到底以后游戏配置页要十来分钟）
const MAX_IN_MODAL = 25; // 一个弹窗里最多点几个按钮
const MAX_IN_DEEP = 14; // 更深的层里最多点几个
const MAX_SAME_LAYER = 4; // 同一层（同一个弹窗的同一步）里，点选项换出来的不同内容最多往里走几种：选项多了是成倍的，每种都点一遍没有必要，
// 换出来的样子在点的那一步已经查过界面了
const MAX_DEPTH = 12; // 最多往里走几层（向导六步、每步里展开的选项、再点开的弹窗都算一层）
const UPDATE = process.argv.includes('--update');
/**
 * --selftest：确认「每一步都做界面检查」真的在查，而且查到了深处（rc12）。走查报 0 个界面毛病，得先知道它不是没在看。
 * 做法：只让弹窗底部的主按钮往右挪出窗口（页面本身不受影响），走设置「关于」，
 * 要求报出「伸到窗口外面」，而且至少有一处是在点了四下以上才到的那一层（首次启动向导的后几步、还原的再次确认）
 */
const SELFTEST = process.argv.includes('--selftest');
const SELFTEST_CSS = SELFTEST ? '.modal .modal-foot .btn.primary { position: relative; left: 3000px; }' : '';
/**
 * --net=fixture（rc13）：网络都由 net-fixture.js 回答。下载页的内容每次都一样，还故意放了极端情况（超长名字、emoji、没图标、
 * 空结果、服务器出错、限流、慢回答）。不加就是真的联网：真实数据的样子、网慢网断只有真联网才碰得到，两种都要走。
 * 两种的记录分开（页面名后面加 @fixture）
 */
const NET = (process.argv.find((x) => x.startsWith('--net=')) || '').slice(6);
const keyOf = (page) => (NET ? `${page}@${NET}` : page);
const KNOWN_FILE = path.join(__dirname, 'walk-ui-known.json');
const LAYERS_FILE = path.join(__dirname, 'walk-layers.json');
const SAME_LABEL_MAX = 3; // 列表里一样的按钮（每行一个的「打开」「禁用」）点几个就够了

function seed(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data'); const game = path.join(root, 'game');
  fs.mkdirSync(data, { recursive: true });
  const mk = (f, d = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
  const profile = (id, libs) => {
    mk(path.join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: libs }));
  };
  profile('ModP', [{ name: 'net.fabricmc:fabric-loader:0.15.0' }]);
  profile('Vanilla', []);
  for (const j of ['a.jar', 'b.jar', 'c.jar.disabled']) mk(path.join(game, 'versions', 'ModP', 'mods', j));
  mk(path.join(game, 'versions', 'ModP', 'saves', 'World', 'level.dat'));
  mk(path.join(game, 'saves', 'Shared', 'level.dat'));
  mk(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: 'ModP', versionSettings: { ModP: { isolation: 'on' } } }));
  mk(path.join(data, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'a1', type: 'offline', name: 'WalkPlayer', uuid: '00000000000000000000000000000001' }], selected: 'a1' }));
  return { data, game };
}


async function open(name) {
  const port = await freePort();
  let root = path.join(BASE, 'walk', `${name.replace(/:/g, '-')}-${port}`);
  // 端口可能和上一次一样（上一次的文件夹还被没退完的子进程占着）：多等几次，还是删不掉就换个名字（rc16：以前直接 EPERM，走查中途退出）
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => { root = `${root}-${Date.now()}`; });
  const { data, game } = seed(root);
  const child = spawn(ELECTRON, ['-r', path.join(__dirname, 'walk-hook.js'), `--remote-debugging-port=${port}`, ...NO_THROTTLE, '.'], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, AURORA_DATA_DIR: data, AURORA_GAME_DIR: game, AURORA_TEST_TRASH: path.join(root, 'fake-trash'), AURORA_SHOT_DIR: path.join(root, 'shots'), AURORA_SHOT_PAGES: '-#start', AURORA_SHOT_KEEP: '1', AURORA_SHOT_DELAY: '1500', AURORA_WALK_NET: NET },
  });
  const mainLog = [];
  const onLog = (buf) => { for (const line of String(buf).split(/\r?\n/)) if (/^\[ipc:/.test(line)) mainLog.push(line.slice(0, 240)); };
  child.stdout.on('data', onLog); child.stderr.on('data', onLog);
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = l.find((t) => t.type === 'page' && !/devtools/.test(t.url)); } catch { /* 还没起来 */ }
    await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
  }
  if (!page) { child.kill(); throw new Error('连不上调试端口'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  const errors = [];
  let crashed = false;
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') { const e = d.params.exceptionDetails; errors.push(`异常：${((e.exception && e.exception.description) || e.text || '').slice(0, 300)}`); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(`console.error：${d.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300)}`);
    if (d.method === 'Inspector.targetCrashed') crashed = true;
  };
  ws.onclose = () => { for (const fn of wait.values()) fn({ error: { message: '调试连接断了' } }); wait.clear(); };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const k = ++id;
    const timer = setTimeout(() => { wait.delete(k); rej(new Error(`${method} 没有响应`)); }, 30000);
    wait.set(k, (d) => { clearTimeout(timer); if (d.error) rej(new Error(d.error.message)); else res(d.result); });
    try { ws.send(JSON.stringify({ id: k, method, params })); } catch (e) { clearTimeout(timer); wait.delete(k); rej(e); }
  });
  await send('Runtime.enable');
  await send('Inspector.enable').catch(() => {});
  const ev = async (js) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }), sleep(15000).then(() => ({ timeout: true }))]);
    if (r.timeout) return { __timeout: true };
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  };
  for (let i = 0; i < 80; i++) { if ((await ev('!!(window.A && A.state && A.state.config && A.pages.home && A.go)')) === true) break; await sleep(500); }
  await calm(ev);
  // 自检用（--selftest）：往页面里塞一段样式，故意把界面弄坏
  if (SELFTEST_CSS) await ev(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(SELFTEST_CSS)}; document.head.appendChild(s); return 1; })()`);
  return { ev, errors, mainLog, isCrashed: () => crashed, stop: async () => {
    try { ws.close(); } catch { /* */ }
    const gone = new Promise((res) => { if (child.exitCode != null) res(); else child.once('exit', res); });
    child.kill();
    await Promise.race([gone, sleep(10000)]);
    // 主进程退了，渲染、显卡那几个子进程还要一会儿才放开数据目录里的文件：多等几次；还是删不掉也不算走查失败（rc16：
    // 以前只重试 1 秒，删不掉就抛错，整个走查中途退出，后面的页面都没走）
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
      .catch((e) => console.log(`    （临时目录没删掉，不影响结果：${e.code || e.message}）`));
  } };
}

// 可以点的东西：页面内可见、没禁用
const LIST = (page) => `(() => {
  const root = document.getElementById('page-${page}');
  if (!root) return [];
  const els = [...root.querySelectorAll('button, [role=button], a[href], input[type=checkbox], input[type=radio], label.toggle, .choice, .menu-item, .vchip')];
  return els.filter((e) => e.offsetParent !== null && !e.disabled && !e.closest('.modal-back') && !e.closest('.set-nav')).map((e, i) => { // 设置页的分类和搜索不点：分类切换另有测试（settings-layout.js），点了会换到别的分类
    e.setAttribute('data-walk', String(i));
    const label = (e.innerText || e.getAttribute('aria-label') || e.getAttribute('data-tip') || e.title || e.placeholder || e.type || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 50);
    return { i, label, tag: e.tagName.toLowerCase() };
  });
})()`;
// 最上面那一层：菜单 / 浮层盖在最上面；弹窗和抽屉看谁后建（后建的在上面）；都没有就是 null
const TOP_EL = `(() => {
  const vis = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const last = (sel) => [...document.querySelectorAll(sel)].filter(vis).pop() || null;
  const menu = last('.popover'); if (menu) return menu;
  const modal = last('.modal-back:not(.closing) .modal'); const drawer = last('.drawer, #logDrawer.open');
  if (modal && drawer) return (modal.compareDocumentPosition(drawer) & 4) ? drawer : modal;
  return modal || drawer;
})()`;
// 这一层是什么、里面有哪些能点的。id：哪一层（种类 + 标题 + 向导走到第几步）；sig：连里面能点的东西一起算，内容换了就是新的
const LAYER = `(() => {
  const top = ${TOP_EL};
  document.querySelectorAll('[data-walk-top]').forEach((e) => e.removeAttribute('data-walk-top'));
  if (!top) return null;
  const vis = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const norm = (x) => String(x || '').replace(/[A-Za-z]:[\\\\/][^「」]*?(?=$|[「」，。；、）])/g, '〈路径〉').replace(/\\s+/g, ' ').trim();
  const els = [...top.querySelectorAll('button, [role=button], a[href], input[type=checkbox], input[type=radio], label.toggle, .choice, .menu-item, .vchip, .tab, [role=tab]')].filter((e) => vis(e) && !e.disabled);
  // 套在一起的只留外面那个（开关里的勾选框、选择卡片里的按钮）
  const items = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
  items.forEach((e, i) => e.setAttribute('data-walk-top', String(i)));
  const kind = top.classList.contains('popover') ? '菜单' : top.classList.contains('modal') ? '弹窗' : '抽屉';
  const h = top.querySelector('h1, h2, h3, .modal-title, .drawer-head, .menu-head');
  const title = norm(h ? h.innerText : '').slice(0, 40);
  const ms = top.querySelector('.msteps'); // 向导的步骤条：aria-label 是「2 / 6」
  const step = ms ? norm(ms.getAttribute('aria-label')) : '';
  const labels = items.map((e) => norm(e.innerText || e.getAttribute('aria-label') || e.getAttribute('data-tip') || e.title || (e.closest('label, .set-row, .field, .row') || {}).innerText || e.type || e.tagName).replace(/\\d+(?:[.,:]\\d+)*/g, '#').slice(0, 30) || '（没有文字）');
  // 这一层现在显示的字（数字抹掉）：向导每一步的按钮都是「上一步 / 下一步」，只看按钮分不出是哪一步
  const text = norm(top.innerText).replace(/\\d+(?:[.,:]\\d+)*/g, '#');
  const id = kind + '|' + title + '|' + step;
  return { kind, title: title + (step ? ' · ' + step : ''), id, sig: id + '|' + labels.join('¦') + '|' + text.length + ':' + text.slice(0, 160), items: labels };
})()`;
const CLICK_TOP = (n) => `(() => { const L = ${LAYER}; if (!L) return false; const e = document.querySelector('[data-walk-top="${n}"]'); if (!e) return false; e.click(); return true; })()`;
// 最上面那一层是首次启动向导吗：向导防连点（setup.js 的 GUARD_MS），新的一页出来 0.45 秒之内的点击不算
const IN_WIZARD = `(() => { const m = [...document.querySelectorAll('.modal-back .modal')].pop(); return !!(m && m.querySelector('.setup')); })()`;
// 界面检查：最上面那一层、页面本身
const UI_TOP = collectAt(TOP_EL);
const UI_PAGE = COLLECT;
const RESET = `(() => {
  try { if (A.closeDrawers) A.closeDrawers(); if (A.logs && A.logs.close) A.logs.close(); } catch (e) { /* 没开着 */ }
  document.querySelectorAll('.modal-back, .drawer-back, .toast, .popover, .menu-pop').forEach((m) => m.remove());
  document.body.click();
  for (const t of A.state.tasks.values()) if (t.status === 'running') A.api('tasks:cancel', t.id);
  return 1;
})()`;
const OUTCOME = `(() => {
  const modals = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].map((m) => { const h = m.querySelector('h2'); return h ? h.innerText.trim().slice(0, 60) : '(没有标题)'; });
  const menus = document.querySelectorAll('.menu .menu-item').length;
  const crit = [...document.querySelectorAll('.toast')].filter((t) => /crit|err/.test(t.className)).map((t) => t.innerText.replace(/\\s+/g, ' ').slice(0, 200));
  const active = (document.querySelector('.page.active') || {}).id || '';
  return { modals, menus, crit, active };
})()`;

async function walkPage(page) {
  const [pid, cat] = page.split(':');
  let app = await open(page);
  const rec = { page, clicked: 0, deepClicks: 0, layers: 0, maxDepth: 0, skippedSame: 0, opened: [], layerList: {}, problems: [], ui: [], uiChecks: 0, total: 0 };
  const uiSeen = new Map(); // 界面毛病 → 记在 rec.ui 里的那一条
  const visitedSig = new Set(); // 走过的层（连内容一起算）
  const perLayer = new Map(); // 层 id → 往里走过几种内容
  const startedAt = Date.now();
  const go = async () => {
    await app.ev(`A.go(${JSON.stringify(pid)})`); await calm(app.ev, pid === 'download' ? 15000 : 8000);
    if (cat) { await app.ev(`(() => { const b = document.querySelector('#page-settings .set-cat[data-cat=${cat}]'); if (b) b.click(); return !!b; })()`); await calm(app.ev); }
  };
  // 同样文字的第几个，用来认「点过没有」（点了筛选以后下标会变）
  const keyed = (list) => { const n = new Map(); return list.map((x) => { const k = n.get(x.label) || 0; n.set(x.label, k + 1); return { ...x, key: `${x.label}#${k}`, nth: k }; }); };
  const seen = async (label, before) => {
    await calm(app.ev);
    const out = await app.ev(OUTCOME);
    const errs = [...app.errors, ...app.mainLog];
    if (errs.length || (out && out.crit && out.crit.length)) rec.problems.push({ label, errors: errs.slice(0, 4), crit: out && out.crit });
    // 界面检查：这一步之后，最上面那一层和页面本身
    for (const [where, js] of [['最上面那一层', UI_TOP], ['页面', UI_PAGE]]) {
      const ui = await app.ev(js);
      if (!ui || !Array.isArray(ui.problems)) continue;
      rec.uiChecks++;
      for (const text of ui.problems) {
        const had = uiSeen.get(text);
        if (had) { had.times++; continue; }
        const item = { problem: text, where, after: label, times: 1 };
        uiSeen.set(text, item);
        rec.ui.push(item);
      }
    }
    return out || {};
  };
  const restart = async () => { await app.stop(); app = await open(page); await go(); };
  /**
   * 从页面重新走到某一层：点页面上的那个按钮，再按顺序点每一层里写着那几个字的（同样的字第几个）。
   * 按字找、不按下标：前面点过的开关会被记住，再走一遍时那一层可能多出或少了几样，下标就对不上了（rc12 试跑时向导第 2 步以后走不进去就是这样）
   */
  // 向导一页出来 0.45 秒之内点「下一步」会被当成连点忽略（rc16 加的防熊孩子）：走查点得比人快，以前一直卡在第一页，
  // 自检报不出深处的问题。在向导里每次点之前等 0.6 秒，和人看一眼再点一样
  const humanPause = async () => { if ((await app.ev(IN_WIZARD)) === true) await sleep(600); }; // pitfall-ok：向导防连点是按时间算的，只能等够时间
  const replay = async (it, steps) => {
    await app.ev(RESET);
    if ((await app.ev("(document.querySelector('.page.active') || {}).id")) !== `page-${pid}`) await go();
    const again = keyed(await app.ev(LIST(pid))).find((x) => x.key === it.key);
    if (!again) return false;
    await clickAt(again.i);
    await calm(app.ev);
    for (const st of steps) {
      const L = await app.ev(LAYER);
      if (!L || L.id !== st.id) return false;
      const at = L.items.map((x, i) => [x, i]).filter(([x]) => x === st.label).map(([, i]) => i)[st.nth];
      if (at == null) return false;
      await humanPause();
      if ((await app.ev(CLICK_TOP(at))) !== true) return false;
      await calm(app.ev);
    }
    return true;
  };
  const stepOf = (layer, n) => ({ id: layer.id, label: layer.items[n], nth: layer.items.slice(0, n).filter((x) => x === layer.items[n]).length });
  /**
   * 一层里能点的挨个点。点出新的一层（另一个弹窗、菜单、向导的下一步）就接着往里走；
   * 还在同一层、只是内容变了（点了选项）：多出了新的能点的东西（「逐项调整…」展开的那些）才往里走，最多 MAX_SAME_LAYER 种——
   * 只是勾选状态变了的，这一步的界面检查已经做过了，不用再把整层点一遍
   */
  const explore = async (it, steps, label, layer, depth) => {
    if (visitedSig.has(layer.sig)) return;
    visitedSig.add(layer.sig);
    const kinds = (perLayer.get(layer.id) || 0) + 1;
    perLayer.set(layer.id, kinds);
    if (kinds > MAX_SAME_LAYER) return;
    rec.layers++;
    rec.maxDepth = Math.max(rec.maxDepth, depth);
    const name = `${label} → ${layer.kind}「${layer.title}」`;
    const line = `${name}：${layer.items.join('、')}`;
    rec.opened.push(line.length > 260 ? `${line.slice(0, 90)} … ${line.slice(-160)}` : line);
    rec.layerList[name] = layer.items;
    // 东西太多时只点一部分：前面的若干个，加上最后四个（「下一步」「确定」这些主按钮都在最后）
    const max = depth === 1 ? MAX_IN_MODAL : MAX_IN_DEEP;
    const order = layer.items.length <= max ? layer.items.map((_, i) => i) : [...Array(max - 4).keys(), ...[4, 3, 2, 1].map((k) => layer.items.length - k)];
    for (const n of order) {
      if (Date.now() - startedAt > PAGE_LIMIT_MS) { rec.timedOut = true; return; }
      const here = `${name} → ${layer.items[n]}`;
      try {
        if (!(await replay(it, steps))) return;
        const now = await app.ev(LAYER);
        if (!now || now.id !== layer.id) return; // 走不回这一层了（上一次点的把数据改了）：不硬点
        // 这一层的内容和刚才列的不完全一样（上一次点的选项被记住了，多出几样）：按文字找，找不到就不点
        const at = now.sig === layer.sig ? n : now.items.indexOf(layer.items[n]);
        if (at < 0) continue;
        const before = await app.ev('A.state.installed.length');
        fresh();
        await humanPause();
        if ((await app.ev(CLICK_TOP(at))) !== true) continue;
        rec.deepClicks++;
        await seen(here);
        await calm(app.ev);
        const next = await app.ev(LAYER);
        const deeper = next && next.sig && next.sig !== now.sig && depth < MAX_DEPTH
          && (next.id !== layer.id || next.items.some((x) => !now.items.includes(x)));
        if (deeper) await explore(it, [...steps, stepOf(now, at)], here, next, depth + 1);
        const after = await app.ev('A.refreshInstalled().then(() => A.state.installed.length)');
        if (after !== before) await restart();
      } catch (e) {
        // 有的按钮本来就会退出或重启程序：记下来，重启接着走
        rec.opened.push(`${here} → 程序关了（${String(e.message).slice(0, 40)}）`);
        await restart();
      }
    }
  };
  const fresh = () => { app.errors.length = 0; app.mainLog.length = 0; };
  const clickAt = (i) => app.ev(`(() => { const e = document.querySelector('[data-walk="${i}"]'); if (!e) return false; e.click(); return true; })()`);
  try {
    await go();
    await calm(app.ev);
    const first = await app.ev(LIST(pid));
    rec.total = Array.isArray(first) ? first.length : 0;
    const visited = new Set();
    // 点了筛选或开关，有的按钮就看不见了：走完一轮重新启动，把没点到的补上
    for (let pass = 0; pass < 5; pass++) {
      let progressed = false;
      while (rec.clicked < MAX_PER_PAGE) {
        if (app.isCrashed()) throw new Error('渲染进程崩溃');
        if (Date.now() - startedAt > PAGE_LIMIT_MS) { rec.timedOut = true; break; }
        await app.ev(RESET);
        const active = await app.ev("(document.querySelector('.page.active') || {}).id");
        if (active !== `page-${pid}`) await go();
        const list = await app.ev(LIST(pid));
        if (!Array.isArray(list)) break;
        const items = keyed(list);
        const it = items.find((x) => !visited.has(x.key) && x.nth < SAME_LABEL_MAX);
        rec.skippedSame = Math.max(rec.skippedSame, items.filter((x) => x.nth >= SAME_LABEL_MAX).length);
        if (!it) break;
        visited.add(it.key);
        progressed = true;
        if (process.env.AURORA_WALK_LOG) fs.appendFileSync(process.env.AURORA_WALK_LOG, `${new Date().toISOString().slice(11, 19)} ${page} 第 ${pass + 1} 轮 ${it.label}\n`, 'utf8');
        fresh();
        const r = await clickAt(it.i);
        if (r && r.__timeout) { rec.problems.push({ label: it.label, errors: ['点了以后页面 15 秒没有响应'] }); throw new Error(`「${it.label}」点了以后没有响应`); }
        rec.clicked++;
        await seen(it.label);
        // 点出来了新的一层（弹窗、菜单、抽屉）：往里走到底
        const layer = await app.ev(LAYER);
        if (layer && layer.sig) await explore(it, [], it.label, layer, 1);
      }
      if (!progressed || rec.clicked >= MAX_PER_PAGE || rec.timedOut) break;
      // 从头再来一次（点过的开关会藏起别的按钮，配置要回到一开始的样子），只点上一轮没点到的
      await app.stop();
      app = await open(page);
      await go();
    }
  } catch (e) {
    rec.problems.push({ label: '(走查脚本)', errors: [e.message] });
    rec.crashed = true;
  } finally { await app.stop(); }
  return rec;
}

(async () => {
  if (SELFTEST) {
    const rec = await walkPage('settings:about');
    const off = rec.ui.filter((u) => /伸到窗口外面/.test(u.problem) && u.where === '最上面那一层');
    const deep = off.filter((u) => u.after.split(' → ').length >= 5);
    const r = { id: 'walk', name: `走查自检：弹窗里的主按钮故意挪出窗口，每一层都报得出来（报了 ${off.length} 处，其中点了四下以上才到的 ${deep.length} 处；走了 ${rec.layers} 层、最深第 ${rec.maxDepth} 层）`, ok: off.length >= 3 && deep.length >= 1 && !rec.crashed, detail: off.slice(0, 6).map((u) => `${u.problem}（${u.after.slice(-80)}）`).join('；') };
    console.log(`${r.ok ? 'PASS' : 'FAIL'} [walk] ${r.name}${r.detail ? ` — ${r.detail.slice(0, 800)}` : ''}`);
    if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${JSON.stringify(r)}\n`, 'utf8');
    process.exit(0);
  }
  const arg = process.argv.slice(2).find((x) => !x.startsWith('--'));
  const pages = arg ? arg.split(',').flatMap((x) => (x === 'settings' ? SETTINGS : [x])) : PAGES;
  const known = fs.existsSync(KNOWN_FILE) ? JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')) : {};
  const oldLayers = fs.existsSync(LAYERS_FILE) ? JSON.parse(fs.readFileSync(LAYERS_FILE, 'utf8')) : {};
  const report = [];
  const results = [];
  let added = false;
  for (const page of pages) {
    const rec = await walkPage(page);
    const key = keyOf(page); // 固定数据走的那一遍，记录分开
    const shown = NET ? `${page}（${NET === 'fixture' ? '固定数据' : NET}）` : page;
    report.push(rec);
    console.log(`  ${shown.padEnd(9)} 刚打开可点 ${String(rec.total).padStart(3)}，点了 ${String(rec.clicked).padStart(3)}；往里走了 ${rec.layers} 层内容（最深第 ${rec.maxDepth} 层），里面点了 ${rec.deepClicks} 个；界面检查 ${rec.uiChecks} 次；一样的跳过 ${rec.skippedSame}，点了报错 ${rec.problems.length}`);
    for (const p of rec.problems) console.log(`    「${p.label}」${(p.crit || []).concat(p.errors || []).join(' | ').slice(0, 260)}`);
    if (rec.timedOut) console.log(`    到了时限没走完（${Math.round(PAGE_LIMIT_MS / 1000)} 秒）`);
    const ok = !rec.crashed;
    results.push({ id: 'walk', name: `按钮走查：${shown} 走完了（页面上点了 ${rec.clicked} 个；往里走了 ${rec.layers} 层内容、最深第 ${rec.maxDepth} 层、点了 ${rec.deepClicks} 个；点了报错 ${rec.problems.length} 个，只报告）`, ok, detail: rec.crashed ? JSON.stringify(rec.problems.slice(-1)) : '' });
    console.log(`${ok ? 'PASS' : 'FAIL'} [walk] ${results[results.length - 1].name}`);
    // 界面毛病：和看过的比，多出来的算失败
    const had = new Set(known[key] || []);
    const fresh = rec.ui.filter((u) => !had.has(u.problem));
    for (const u of rec.ui) console.log(`    界面${had.has(u.problem) ? '（看过的）' : ''}：${u.problem} —— ${u.where}，点了「${u.after.slice(0, 120)}」之后，出现 ${u.times} 次`);
    const gone = [...had].filter((x) => !rec.ui.some((u) => u.problem === x));
    if (gone.length) console.log(`    以前记着、这次没再出现的 ${gone.length} 处（修好了，或者这次没走到）：${gone.slice(0, 5).join('；').slice(0, 300)}`);
    if (UPDATE) known[key] = rec.ui.map((u) => u.problem).sort();
    results.push({ id: 'walk', name: `界面检查：${shown} 走到的每一步（${rec.uiChecks} 次）都没有新的溢出、截断、叠在一起、没居中、看不见的字${had.size ? `（看过的 ${had.size} 处不算）` : ''}`, ok: UPDATE || fresh.length === 0, detail: fresh.slice(0, 8).map((u) => `${u.problem}（点了「${u.after.slice(0, 80)}」之后）`).join('；') });
    console.log(`${results[results.length - 1].ok ? 'PASS' : 'FAIL'} [walk] ${results[results.length - 1].name}${fresh.length && !UPDATE ? ` — ${results[results.length - 1].detail.slice(0, 600)}` : ''}`);
    // 走到的层：和上次比，少了哪一层、哪个能点的（只报告）
    const before = oldLayers[key] || {};
    const lost = [];
    for (const [name, items] of Object.entries(before)) {
      if (!rec.layerList[name]) { lost.push(`走不到了：${name}`); continue; }
      const miss = items.filter((x) => !rec.layerList[name].includes(x));
      if (miss.length) lost.push(`${name} 里少了：${miss.join('、')}`);
    }
    if (lost.length) console.log(`    和上次比少了 ${lost.length} 处（只报告）：\n      ${lost.slice(0, 12).join('\n      ').slice(0, 1500)}`);
    if (UPDATE || !oldLayers[key]) { oldLayers[key] = rec.layerList; added = true; }
  }
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(path.join(BASE, 'walk-report.json'), JSON.stringify(report, null, 2), 'utf8');
  if (UPDATE) fs.writeFileSync(KNOWN_FILE, `${JSON.stringify(known, null, 1)}\n`, 'utf8');
  // 第一次走的页面（或第一次用固定数据走）也记下来，下次才比得出少了什么
  if (UPDATE || added) fs.writeFileSync(LAYERS_FILE, `${JSON.stringify(oldLayers, null, 1)}\n`, 'utf8');
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
