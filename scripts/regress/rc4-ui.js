'use strict';
/**
 * rc4 这一轮（试用 rc3 后提的一批，2026-11-12）：
 *   node scripts/regress/rc4-ui.js            [--quick 只跑功能，不截各种外观]
 * 日志中心（存下来的每局日志、筛选、删除、保存天数、清除）、水和岩浆的流动与生成规则、主页生物卡在原地、
 * 场景胶囊按钮文字居中、骰子摇到下雨的地方天气说明对不对、皮肤预览的披风。
 * 截图在 AURORA_REGRESS_DIR/rc4-ui
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG, lookShown } = require('./robust-ui');
const { sleep, guard, ready, FIX_WORLD } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'rc4-ui');
const results = [];
guard(results, 'rc4-ui'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 600)}` : ''}`);
}
async function shot(a, name) {
  const r = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}
const clean = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove()); A.closePopover && A.closePopover();";
const BG = { type: 'scene', scene: 'plains', time: 'day', fx: 'high', fps: 30, mobs: 12, animals: true, monsters: true, aquatic: true, players: true, buildings: true, pan: true, eggs: false };

/** 事先放好的日志：一局崩溃的（5000 行，带报错）、一局正常的、一局测试启动的、一局 40 天前的 */
function prepareLogs(data) {
  const dir = path.join(data, 'logs', 'games');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const items = [];
  const put = (id, versionId, startedAt, lines, extra) => {
    fs.writeFileSync(path.join(dir, `${id}.log`), `${lines.join('\n')}\n`, 'utf8');
    items.push({ id, file: `${id}.log`, versionId, startedAt, endedAt: startedAt + 25 * 60000, state: 'exited', test: false, ...extra });
  };
  const crash = [];
  for (let i = 0; i < 5000; i++) crash.push(`[12:00:${String(i % 60).padStart(2, '0')}] [Render thread/INFO]: line ${i}`);
  crash.push('[12:01:00] [Render thread/ERROR]: Unable to load mod: bad.jar', 'java.lang.RuntimeException: boom', '\tat com.example.Mod.init(Mod.java:10)', '[12:01:01] [Render thread/WARN]: careful');
  put('20261110-120000-g1-aaaa', 'Fab', now - 2 * 3600000, crash, { exitCode: 1, crash: { reasons: ['Mod「bad」加载失败'], reportPath: null } });
  put('20261111-090000-g2-bbbb', 'Plain', now - 3600000, ['[09:00:00] [main/INFO]: Setting user: Steve', '[09:30:00] [main/INFO]: Stopping!'], { exitCode: 0 });
  put('20261111-100000-g3-cccc', 'Fab', now - 1800000, ['[10:00:00] [main/INFO]: test'], { exitCode: 0, test: true });
  put('20261001-100000-g4-dddd', 'Plain', now - 40 * 86400000, ['old'], { exitCode: 0 });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items }), 'utf8');
  return dir;
}

async function functional() {
  let logDir = null;
  const a = await start('rc4-ui', {
    prepare: ({ data, game }) => {
      logDir = prepareLogs(data);
      const v = path.join(game, 'versions', 'Fab'); fs.mkdirSync(v, { recursive: true });
      fs.writeFileSync(path.join(v, 'Fab.json'), JSON.stringify({ id: 'Fab', type: 'release', mainClass: 'x', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] }));
    },
    config: (game) => ({ ...BASE_CONFIG(game), selectedVersion: 'Fab', background: BG, logs: { keepDays: 0 } }),
  });
  if (a.startError) { check('启动', '能打开', false, a.startError); return; }
  await ready(a.ev);
  await a.ev(FIX_WORLD); // 世界不跟着日期、窗口高度变（cdp.js）：窗口高一个像素，有没有地表岩浆湖就不一样
  const ev = (code, t = 30000) => a.ev(code, t);

  // ── 日志中心 ──
  let o = await ev(`(async () => { ${clean} const nav = document.querySelector('.nav-item[aria-label="日志中心"]'); if (!nav) return { nav: false }; nav.click(); await new Promise((r) => setTimeout(r, 1500));
    const items = [...document.querySelectorAll('.lc-item')].map((x) => x.textContent);
    const on = document.querySelector('.lc-item.on'); const lines = document.querySelectorAll('.lc-log .log-line').length;
    return { nav: true, page: A.state.page, items, on: on && on.dataset.log, lines, more: !!document.querySelector('.lc-more') }; })()`);
  check('日志中心', '侧边栏有「日志中心」，打开就列出存着的每一局（新的在前，保存天数是「一直保存」时 40 天前的也在）', o.nav && o.page === 'logs' && o.items.length === 4 && /测试启动/.test(o.items[0]) && /Plain/.test(o.items[1]) && /崩溃/.test(o.items[2]), o);
  o = await ev(`(async () => { document.querySelector('.lc-item[data-log="20261110-120000-g1-aaaa"]').click(); await new Promise((r) => setTimeout(r, 1200));
    const lines = [...document.querySelectorAll('.lc-log .log-line')]; const err = lines.filter((l) => l.classList.contains('ERROR')).length;
    const more = document.querySelector('.lc-more'); const head = document.querySelector('.lc-head').textContent;
    return { n: lines.length, err, more: more && more.textContent, head, crashBtn: [...document.querySelectorAll('.lc-head .btn')].some((b) => /崩溃分析/.test(b.textContent)) }; })()`);
  check('日志中心', '崩溃的那一局：只先读最后 3000 行，报错和堆栈是红色的，有「崩溃分析」', o.n === 3000 && o.err >= 3 && /前面还有 2004 行/.test(o.more || '') && o.crashBtn && /退出代码 1/.test(o.head), o);
  o = await ev(`(async () => { document.querySelector('.lc-more .btn').click(); await new Promise((r) => setTimeout(r, 1200)); return { n: document.querySelectorAll('.lc-log .log-line').length, more: !!document.querySelector('.lc-more') }; })()`);
  check('日志中心', '「显示更早的」把前面的也读出来', o.n === 5004 && !o.more, o);
  o = await ev(`(async () => { const seg = [...document.querySelectorAll('.lc-head .seg button')].find((b) => b.textContent === '错误'); seg.click(); await new Promise((r) => setTimeout(r, 400));
    const n = document.querySelectorAll('.lc-log .log-line').length; const all = [...document.querySelectorAll('.lc-log .log-line')].every((l) => l.classList.contains('ERROR') || l.classList.contains('FATAL'));
    const inp = document.querySelector('.lc-search'); inp.value = 'careful'; inp.dispatchEvent(new Event('input')); [...document.querySelectorAll('.lc-head .seg button')].find((b) => b.textContent === '全部').click(); await new Promise((r) => setTimeout(r, 600));
    const hits = [...document.querySelectorAll('.lc-log .log-line')].map((l) => l.textContent); const mark = document.querySelectorAll('.lc-log mark').length;
    return { n, all, hits, mark }; })()`);
  check('日志中心', '筛「错误」只剩报错；搜索只剩匹配的行并高亮', o.n >= 3 && o.all && o.hits.length === 1 && /careful/.test(o.hits[0]) && o.mark === 1, o);
  await shot(a, '日志中心');
  o = await ev(`(async () => { ${clean} document.querySelector('.lc-item[data-log="20261111-090000-g2-bbbb"]').click(); await new Promise((r) => setTimeout(r, 800));
    [...document.querySelectorAll('.lc-head .btn')].find((b) => b.dataset.tip === '删除这份日志').click(); await new Promise((r) => setTimeout(r, 400));
    const m = document.querySelector('.modal-back:last-child'); [...m.querySelectorAll('.modal-foot .btn')].pop().click(); await new Promise((r) => setTimeout(r, 1200));
    return { items: document.querySelectorAll('.lc-item').length, list: (await A.api('logs:list')).map((x) => x.id) }; })()`);
  check('日志中心', '删除一份：列表少一条，文件也删了', o.items === 3 && !o.list.includes('20261111-090000-g2-bbbb') && !fs.existsSync(path.join(logDir, '20261111-090000-g2-bbbb.log')), o);
  o = await ev(`(async () => { ${clean} await A.go('settings', { focus: 'logs' }); await new Promise((r) => setTimeout(r, 1200));
    const g = document.getElementById('set-logs'); const act = document.querySelector('.set-cat.active');
    return { found: !!g, cat: act && act.dataset.cat, text: g && g.textContent.replace(/\\s+/g, ' ') }; })()`);
  check('日志设置', '设置「数据」里有日志：保存多久、现在存着几份多大、日志中心和清除按钮', o.found && o.cat === 'data' && /保存多久/.test(o.text) && /现在存着 3 份/.test(o.text) && /清除全部/.test(o.text), o);
  o = await ev(`(async () => { await A.setConfig({ logs: { keepDays: 30 } }); const n = await A.api('logs:prune'); const list = (await A.api('logs:list')).map((x) => x.id); return { n, list }; })()`);
  check('日志设置', '保存时间改成 30 天：40 天前的那份被清掉', o.n === 1 && !o.list.includes('20261001-100000-g4-dddd') && !fs.existsSync(path.join(logDir, '20261001-100000-g4-dddd.log')), o);
  o = await ev(`(async () => { ${clean} await A.go('home'); await new Promise((r) => setTimeout(r, 200)); await A.go('settings', { focus: 'logs' }); await new Promise((r) => setTimeout(r, 1000));
    [...document.querySelectorAll('#set-logs .btn')].find((b) => /清除全部/.test(b.textContent)).click(); await new Promise((r) => setTimeout(r, 500));
    const m = document.querySelector('.modal-back:last-child'); [...m.querySelectorAll('.modal-foot .btn')].pop().click(); await new Promise((r) => setTimeout(r, 1500));
    return { list: await A.api('logs:list'), toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|') }; })()`);
  check('日志设置', '清除全部：确认以后全删了，提示清了几份', o.list.length === 0 && /已清除 2 份日志/.test(o.toast) && fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).length === 0, o);

  // ── 场景胶囊：按钮文字居中、骰子摇到下雨的地方 ──
  o = await ev(`(async () => { ${clean} await A.go('home'); await new Promise((r) => setTimeout(r, 600)); document.querySelector('.scene-pill').click(); await new Promise((r) => setTimeout(r, 500));
    const off = [...document.querySelectorAll('.scene-pop .scene-time .seg button')].map((b) => { const r = b.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(b); const t = range.getBoundingClientRect(); return Math.round(Math.abs((t.left + t.right) / 2 - (r.left + r.right) / 2)); });
    A.closePopover(); return { off, n: off.length }; })()`);
  check('胶囊', '时间、天气的按钮文字在按钮中间', o.n >= 8 && o.off.every((d) => d <= 2), o);
  o = await ev(`(async () => { const P = A.Scene.prototype; const init0 = P.weatherInit;
    P.weatherInit = function () { init0.call(this); if (this.weatherInfo && this.precip && this.precip()) { this.wx.kind = 'rain'; this.wx.level = 1; } };
    let res = null;
    for (let i = 0; i < 12 && !res; i++) { document.querySelector('.scene-dice').click(); await new Promise((r) => setTimeout(r, 700)); const s = A.homeScene(); if (s.precip && s.precip() === 'rain') {
      const pill = document.querySelector('.scene-pill').textContent; document.querySelector('.scene-pill').click(); await new Promise((r) => setTimeout(r, 400));
      const note = [...document.querySelectorAll('.scene-pop .menu-head')].map((x) => x.textContent).join('|'); A.closePopover(); res = { scene: s.sceneId, pill, note }; } }
    P.weatherInit = init0; return res; })()`, 60000);
  check('胶囊', '骰子摇到正在下雨的地方：胶囊和菜单里都说在下雨（以前说晴天）', o && /下雨/.test(o.pill) && /现在：下雨/.test(o.note), o);

  // ── 主页生物不卡在原地 ──
  o = await ev(`(async () => { ${clean} await A.setConfig({ background: { scene: 'plains' } }); await new Promise((r) => setTimeout(r, 1500)); const s = A.homeScene(); s.setOptions({ scene: 'plains' }); /* 骰子摇的临时场景改设置换不回来，这里明确换回平原（rc9） */ await new Promise((r) => setTimeout(r, 800)); s.setWeather('thunder');
    const track = new Map(); const up = Object.getPrototypeOf(s).updateEnt;
    s.updateEnt = function (e, sec, now) { const x0 = e.x; const d0 = e.dir; up.call(this, e, sec, now); let t = track.get(e); if (!t) { t = { k: e.kind, mv: 0, still: 0, flips: 0 }; track.set(e, t); } if (e.moving) { t.mv++; if (Math.abs(e.x - x0) < 0.001) t.still++; } if (e.dir !== d0) t.flips++; t.dead = e.dead; }; /* 正在消失的不排除（rc15）：消失不掉、原地迈步的正是要抓的 */
    await new Promise((r) => setTimeout(r, 4000)); await A.go('settings', { focus: 'background' }); await new Promise((r) => setTimeout(r, 6000)); await A.go('home'); await new Promise((r) => setTimeout(r, 400)); await A.go('settings'); await new Promise((r) => setTimeout(r, 400)); await A.go('home');
    await new Promise((r) => setTimeout(r, 30000)); delete s.updateEnt;
    const all = [...track.values()]; return { n: all.length, stuck: all.filter((t) => t.mv > 60 && t.still / t.mv > 0.6).map((t) => t.k), jitter: all.filter((t) => t.flips > 40).map((t) => t.k) }; })()`, 90000);
  check('生物', '雷雨天切去设置再回来以后，没有想走却一直不动、在原地来回抖的生物', o.n > 3 && !o.stuck.length && !o.jitter.length, o);
  o = await ev(`(() => { const s = A.homeScene(); const now = performance.now(); const e = { kind: 'sheep', spr: A.sceneKit.SPRITES.sheep, x: s.cam.x + 40, y: 0, dir: 1, state: 'walk', until: now + 1e9, born: now, life: 1e9, alpha: 1 }; s.ents.push(e);
    const P = Object.getPrototypeOf(s); e.movedAt = now - 21000; e.movedX = e.x; P.stuckCheck.call(s, e, e.x, now);
    // 看它真的没了，不只看「标上了要消失」（rc15：淡入淡出写反，标上了也消失不掉，这一项照样通过了）
    for (let i = 1; i <= 60; i++) P.updateEnt.call(s, e, 0.033, now + 33 * i);
    return { gone: e.dead === true, alpha: +e.alpha.toFixed(2) }; })()`);
  check('生物', '想走却 20 秒没挪过地方的生物会慢慢消失（2 秒内真的没了）', o.gone, o);

  // ── 皮肤预览的披风 ──
  o = await ev(`(async () => { ${clean} const mk = (w, h, f) => { const c = document.createElement('canvas'); c.width = w; c.height = h; f(c.getContext('2d')); return c.toDataURL('image/png'); };
    const skin = mk(64, 64, (g) => { g.fillStyle = '#c89a7a'; g.fillRect(0, 0, 64, 64); }); const cape = mk(64, 32, (g) => { g.fillStyle = '#d02020'; g.fillRect(0, 0, 64, 32); });
    const v = A.skinView({ url: skin, cape, size: 200 }); const btn = A.skinTools.turnButton(v, { hasCape: true }); document.body.append(v.el, btn);
    const label0 = btn.textContent; btn.click(); await new Promise((r) => setTimeout(r, 800)); const yaw = v.state.yaw; const label1 = btn.textContent; btn.click(); const yaw2 = v.state.yaw;
    v.el.remove(); btn.remove(); return { label0, label1, yaw, yaw2 }; })()`);
  check('披风', '有披风时预览下面是「看披风」，点了转到背后，再点回到正面', o.label0 === '看披风' && o.label1 === '看正面' && o.yaw === 152 && o.yaw2 === -28, o);

  // ── 水和岩浆 ──
  o = await ev(`(async () => {
    const s = A.homeScene(); const M = A.sceneKit.M; const out = { flows: 0, water: 0, lava: 0, falls: 0, outlets: 0, touch: 0, obsidian: 0, lavaStone: 0, touchBad: [], bad: [], lavaPoolDeep: 0, lavaPool: 0, lavaAq: 0, lavaAqShallow: 0, lavafallShallow: 0, lavafall: 0, surf: 0, spot: null };
    const keep = s.seed;
    // 明确用平原：前面骰子那一项把场景摇成了随机的一个（临时场景，改设置换不回来），摇到海洋时一个地表岩浆湖都没有，这两项就看运气（rc9 跑关卡时碰到）
    s.setOptions({ scene: 'plains', time: 'day' });
    for (let k = 0; k < 5; k++) {
      s.seed = 30100 + k * 17; s.build();
      for (let ci = -40; ci <= 40; ci++) if (!s.chunks.has(ci)) s.genChunk(ci);
      for (const [key, f] of s._flows || []) {
        out.flows++; out[f.kind]++; if (key[0] === 'f') out.falls++; else out.outlets++; out.touch += f.touch.size;
        // 水碰到岩浆只能是黑曜石；岩浆碰到水只能是石头（落进去）或圆石（从旁边流进去）
        for (const t of f.touch.values()) { if (f.kind === 'water') { if (t.mat === 'obsidian') out.obsidian++; else out.touchBad.push('水碰岩浆成了 ' + t.mat + ' ' + key); } else if (t.mat === 'stone' || t.mat === 'cobble') out.lavaStone++; else out.touchBad.push('岩浆碰水成了 ' + t.mat + ' ' + key); }
        const run = f.kind === 'water' ? 4 : 3;
        for (const x of f.cells.values()) {
          if (s.solidAt(x.c, x.r)) out.bad.push('在实心里 ' + key);
          if (x.t === 'flow' && x.lvl > run + 1) out.bad.push('太长 ' + key);
        }
        // 每一段横着淌的最多 run 格（加上落点那一格）
        const rows = new Map(); for (const x of f.cells.values()) if (x.t === 'flow') { const k2 = x.r; rows.set(k2, (rows.get(k2) || []).concat(x.c)); }
        for (const [r, cs] of rows) { cs.sort((p, q) => p - q); let seg = 1; for (let i = 1; i < cs.length; i++) { seg = cs[i] === cs[i - 1] + 1 ? seg + 1 : 1; if (seg > run * 2 + 1) out.bad.push('一段太长 ' + key + ' r' + r); } }
        if (!out.spot && f.kind === 'water' && key[0] === 'f' && f.cells.size > 8) out.spot = { seed: s.seed, c: f.c0, r: f.r0 };
      }
      const deep = s.baseRow + 52;
      for (const ch of s.chunks.values()) {
        for (const [c, r] of ch.lava) { const cell = s.cellAtWorld(c, r); if (!cell) continue; if (cell.surfLava) out.surf++; else if (cell.lavaPool) { if (s.caveWaterAt(c, r)) { out.lavaAq++; if (r < deep) out.lavaAqShallow++; } else { out.lavaPool++; if (r >= deep) out.lavaPoolDeep++; } } }
        for (const [c, r, n] of ch.fx) if (n === 'lavafall') { out.lavafall++; if (r - s.baseRow < 20) out.lavafallShallow++; }
      }
    }
    s.seed = keep; s.build();
    return out; })()`, 300000);
  check('流动', '瀑布落地会往两边淌、积水从开口流出去；水和岩浆都有', o.falls > 20 && o.outlets > 20 && o.water > 20 && o.lava > 5, o);
  check('流动', '流动不穿过石头，每段淌的格数不超过规则（水 4、岩浆 3）', o.bad.length === 0, o.bad.slice(0, 5));
  // rc9：以前写的是「有黑曜石或者石头就算过」，把水碰岩浆改成变石头也查不出来
  check('流动', '水碰岩浆变黑曜石，岩浆碰水变石头或圆石，没有别的', o.touch > 5 && o.obsidian > 0 && o.touchBad.length === 0, { touch: o.touch, obsidian: o.obsidian, lavaStone: o.lavaStone, bad: o.touchBad.slice(0, 5) });
  check('岩浆生成', '浅层有小岩浆湖、深板岩层有岩浆含水层（浅层没有）、深处有岩浆瀑布（离地面 20 格内没有）、地表偶尔有岩浆湖', o.lavaPool > 20 && o.lavaPoolDeep === 0 && o.lavaAq > 20 && o.lavaAqShallow === 0 && o.lavafall > 5 && o.lavafallShallow === 0 && o.surf > 0, o);
  if (o.spot) {
    await ev(`(async () => { const s = A.homeScene(); s.seed = ${o.spot.seed}; s.build(); const B = s.B; s.cam.tx = s.cam.x = ${o.spot.c} * B - s.W / 2; s.cam.ty = s.cam.y = ${o.spot.r} * B - s.H / 2; s.ensureChunks(true); await new Promise((r) => setTimeout(r, 1500)); })()`, 60000);
    await shot(a, '瀑布落地往两边淌');
  }
  o = await ev(`(async () => {
    const s = A.homeScene(); let lake = null;
    s.setOptions({ scene: 'plains', time: 'day' });
    for (let k = 0; k < 30 && !lake; k++) { s.seed = 40000 + k * 7; s.build(); for (let reg = -12; reg <= 12 && !lake; reg++) for (const x of s.structsOf(reg)) if (x.type === 'lavaLake') { lake = { seed: s.seed, c0: x.c0, c1: x.c1 }; break; } }
    if (!lake) return { found: false };
    const B = s.B; s.cam.tx = s.cam.x = (lake.c0 - 20) * B; s.ensureChunks(true);
    const now = performance.now(); const kinds = ['cow', 'pig', 'sheep', 'chicken'];
    let onLava = 0; for (let i = 0; i < 200; i++) { const e = s.spawnMob(kinds[i % 4], now, (lake.c0 + (i % (lake.c1 - lake.c0 + 1))) * B + 1); if (e && s.surfLavaAt(e.x)) onLava++; }
    const walker = { kind: 'cow', spr: A.sceneKit.SPRITES.cow, x: (lake.c0 - 1) * B - A.sceneKit.SPRITES.cow.w - 1, y: s.groundY((lake.c0 - 3) * B), dir: 1, state: 'walk', moving: true, until: now + 1e9, born: now, life: 1e9, alpha: 1 };
    s.ents.push(walker); for (let i = 0; i < 120; i++) Object.getPrototypeOf(s).updateEnt.call(s, walker, 0.05, now + i * 50);
    return { found: true, lake, onLava, walkerIn: s.surfLavaAt(walker.x + 1) || s.surfLavaAt(walker.x + walker.spr.w - 1) }; })()`, 120000);
  check('岩浆生成', '地表岩浆湖上不生成生物，走过去的生物会掉头', o.found && o.onLava === 0 && !o.walkerIn, o);
  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  await a.stop();
}

const LOOKS = [
  ['极光-深', {}], ['像素-深', { ui: { style: 'pixel' }, theme: 'dark' }], ['紧凑-浅', { ui: { style: 'compact' }, theme: 'light' }],
  ['极光-1.5倍', { a11y: { zoom: 1.5 } }], ['极光-高对比', { a11y: { contrast: 'on' } }], ['极光-英文', { language: 'en' }],
];
async function looks() {
  let n = 0;
  for (const [name, cfg] of LOOKS) {
    const a = await start(`rc4-look-${n++}`, { prepare: ({ data }) => prepareLogs(data), config: (game) => ({ ...BASE_CONFIG(game), background: BG, logs: { keepDays: 0 }, ...cfg }) });
    if (a.startError) { check('外观', `${name}：能打开`, false, a.startError); continue; }
    await ready(a.ev);
    { const lk = await lookShown(a, cfg); check('外观', `${name}：外观真的换上了`, !lk, lk); }
    const o = await a.ev(`(async () => { ${clean} await A.go('logs'); await new Promise((r) => setTimeout(r, 1500)); document.querySelector('.lc-item[data-log="20261110-120000-g1-aaaa"]').click(); await new Promise((r) => setTimeout(r, 1200));
      const main = document.querySelector('.lc-main').getBoundingClientRect(); const page = document.querySelector('#page-logs').getBoundingClientRect(); const over = [...document.querySelectorAll('.lc-head .btn, .lc-head input')].filter((b) => b.getBoundingClientRect().right > main.right + 1).length;
      return { over, inside: main.right <= page.right + 1, lines: document.querySelectorAll('.lc-log .log-line').length }; })()`, 30000);
    await a.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(SHOTS, `${name}-日志中心.png`), Buffer.from(r.data, 'base64')));
    check('外观', `${name}：日志中心的按钮不出界、内容显示出来`, o.over === 0 && o.inside && o.lines > 100, o);
    await a.ev(`(async () => { await A.go('settings', { focus: 'logs' }); await new Promise((r) => setTimeout(r, 1000)); })()`);
    await a.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(SHOTS, `${name}-日志设置.png`), Buffer.from(r.data, 'base64')));
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
