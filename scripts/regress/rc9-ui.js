'use strict';
/**
 * rc9 这一轮（2026-11-12 ~ 13）：
 *   node scripts/regress/rc9-ui.js
 * 一、主页场景：雪原结冰的湖在画面左边（列号是负的奇数）时每帧报错、背景卡死；
 *     每个场景把视角挪到左边、右边、地下各画几帧都不能出错；万一画某一帧出错，动画循环不能停。
 * 二、日志中心：离开再回来、从日志抽屉带着某一局过去，右边不能是空白；导出的是整份；
 *     看正在玩的那一局，页面上的行数有上限；界面这边结束了的游戏只记最近 10 局。
 * 三、rc7 当时没写测试的两处：默认视角地面放高一截（下界、末地不变）；平原的山比森林少。
 * 界面的错位、居中、入口这些由 ui-snapshot.js 管。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG } = require('./robust-ui');
const { sleep, guard, ready, until, calm, FIX_WORLD } = require('./cdp');

const results = [];
guard(results, 'rc9-ui'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const BG = { type: 'scene', scene: 'plains', time: 'day', fx: 'high', fps: 30, mobs: 8, animals: true, monsters: true, aquatic: true, players: true, buildings: true, pan: true, eggs: false };

function prepareLogs(data) {
  const dir = path.join(data, 'logs', 'games');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const big = [];
  for (let i = 0; i < 25000; i++) big.push(`[12:00:00] [Render thread/INFO]: line ${i}`);
  fs.writeFileSync(path.join(dir, 'big.log'), `${big.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'small.log'), '[09:00:00] [main/INFO]: hello\n[09:00:01] [main/INFO]: world\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items: [
    { id: 'big', file: 'big.log', versionId: 'Plain', startedAt: now - 3600000, endedAt: now - 1800000, state: 'exited', exitCode: 0, test: false },
    { id: 'small', file: 'small.log', versionId: 'Plain', startedAt: now - 7200000, endedAt: now - 7000000, state: 'exited', exitCode: 0, test: false },
  ] }), 'utf8');
}

(async () => {
  let root = null;
  const a = await start('rc9-ui', { stats: true, prepare: (ctx) => { root = ctx.root; prepareLogs(ctx.data); }, config: (game) => ({ ...BASE_CONFIG(game), background: BG, logs: { keepDays: 0 } }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  await ready(a.ev);
  await a.ev(FIX_WORLD); // 世界不跟着日期、窗口高度变（cdp.js）
  const ev = (code, t = 60000) => a.ev(code, t);

  // ── 一、场景 ──
  let o = await ev(`(() => { const s = A.homeScene(); const keep = s.seed; const out = [];
    const W0 = s.W0; const H0 = s.H0;
    s.setOptions({ scene: 'snowy', time: 'day' });
    // 有没有湖看地形起伏，起伏按窗口高度算：有的高度下雪原一个湖都没有，所以换几种窗口高度找
    for (const hgt of [H0, 196, 232, 268, 160]) {
      for (let k = 0; k < 40 && out.length < 3; k++) {
        s.seed = 41000 + k * 13; s.applySize(W0, hgt);
        let col = null; for (let c = -1; c > -500; c -= 2) { const h = s.heights[c]; if (h > s.sea && h < 900) { col = c; break; } }
        if (col == null) continue;
        const x = col * s.B - s.W / 2; Object.assign(s.cam, { x, tx: x }); s.ensureChunks(true);
        s.drawErrors = 0; for (let i = 0; i < 3; i++) s.draw(33);
        out.push({ seed: s.seed, hgt, col, err: s.drawErrors });
      }
    }
    s.seed = keep; s.applySize(W0, H0); return out; })()`, 300000);
  check('场景', '雪原：结冰的湖在画面左边（负的奇数列）时画得出来，不报错', o.length === 3 && o.every((x) => x.err === 0), o);

  o = await ev(`(() => { const s = A.homeScene(); const out = [];
    for (const id of Object.keys(A.sceneKit.SCENES)) {
      for (const time of ['day', 'night']) {
        s.setOptions({ scene: id, time }); s.drawErrors = 0;
        const deep = s.BOT != null ? Math.max(0, (s.BOT - 20) * s.B - s.H) : s.H * 0.3;
        for (const [x, y] of [[0, 0], [-320 * s.B, 0], [320 * s.B, 0], [-150 * s.B, deep / 2], [0, deep], [-320 * s.B, deep]]) {
          Object.assign(s.cam, { x, tx: x, y, ty: y }); s.ensureChunks(true);
          for (let i = 0; i < 3; i++) s.draw(33);
        }
        if (s.drawErrors) out.push(id + ' ' + time + '：' + s.drawErrors + ' 帧出错');
      }
    }
    const n = Object.keys(A.sceneKit.SCENES).length;
    s.setOptions({ scene: 'plains', time: 'day' }); s.camHome(); Object.assign(s.cam, { x: 0, tx: 0, y: 0, ty: 0 });
    return { n, bad: out }; })()`, 300000);
  check('场景', `全部 ${o.n} 个场景、白天和夜晚：视角挪到左边、右边、半深、最深处各画几帧，没有一帧出错`, o.n >= 11 && o.bad.length === 0, o.bad);

  // 画某一帧出错：记一次、循环照常继续（以前循环就此停住，背景不动了）
  await ev("(() => { const s = A.homeScene(); A.go('home'); s.drawErrors = 0; window.__bad = function () { throw new Error('rc9 测试：故意出错'); }; A.sceneKit.overlay.push(window.__bad); window.__t0 = s.t; return 1; })()");
  await sleep(1500); // pitfall-ok：让出错的那一层画上一阵子（看的是出错时循环停不停）
  o = await ev("(() => { const s = A.homeScene(); const i = A.sceneKit.overlay.indexOf(window.__bad); if (i >= 0) A.sceneKit.overlay.splice(i, 1); return { errs: s.drawErrors, running: s.running, moved: s.t - window.__t0 }; })()");
  await sleep(600); // pitfall-ok：去掉出错的那层以后，循环要从出错时的退避里恢复过来
  const after = await ev('(() => { const s = A.homeScene(); const t1 = s.t; return new Promise((r) => setTimeout(() => r({ more: s.t - t1, errs: s.drawErrors }), 500)); })()');
  check('场景', '画某一帧出错：动画循环不停，错误去掉以后照常画', o.errs >= 5 && o.running && o.moved > 500 && after.more > 150 && after.errs === o.errs, { during: o, after });

  // ── 三、rc7：默认视角、平原的山 ──
  o = await ev(`(() => { const s = A.homeScene(); const S = A.sceneKit.SCENES; const view = {};
    for (const id of ['plains', 'forest', 'ocean', 'nether', 'end']) { s.setOptions({ scene: id, time: 'day' }); view[id] = { got: +(s.baseRow / s.rows).toFixed(3), base: S[id].base }; }
    const frac = (id) => { let hit = 0; let n = 0; for (let k = 0; k < 8; k++) { s.seed = 30100 + k * 17; s.setOptions({ scene: id }); s.build(); for (let c = -4000; c <= 4000; c += 8) { const [m, f] = s.mountParts(c); if (f > 0.99) { n++; if (m > 0.05) hit++; } } } return +(hit / n).toFixed(3); };
    const keep = s.seed; const plains = frac('plains'); const forest = frac('forest'); const dark = frac('darkforest');
    s.seed = keep; s.setOptions({ scene: 'plains', time: 'day' }); s.build();
    return { view, plains, forest, dark }; })()`, 300000);
  const near = (x, y) => Math.abs(x - y) < 0.02;
  check('rc7', '默认视角：主世界的地面比场景表里写的放高一成（天空少一些），下界和末地不变', ['plains', 'forest', 'ocean'].every((id) => near(o.view[id].got, o.view[id].base - 0.1)) && ['nether', 'end'].every((id) => near(o.view[id].got, o.view[id].base)), o.view);
  check('rc7', '平原长山的地方比森林、黑森林都少（8 个世界各量 8000 列）', o.plains < o.forest - 0.06 && o.plains < o.dark - 0.06 && o.plains > 0.05, { plains: o.plains, forest: o.forest, dark: o.dark });

  // ── 二、日志中心 ──
  const lines = () => ev("document.querySelectorAll('.lc-log .log-line').length");
  const hasLines = "document.querySelectorAll('.lc-log .log-line').length > 0";
  await ev("A.go('logs')");
  const n1 = await until(ev, hasLines, 6000) ? await lines() : 0;
  const first = await ev("(() => ({ on: [...document.querySelectorAll('.lc-item.on')].map((x) => x.dataset.log) }))()");
  check('日志中心', '第一次进：自动选最新的一局（25000 行的那份），先显示最后 3000 行', n1 === 3000 && first.on[0] === 'big', { n1, first });
  await ev("A.go('home')"); await calm(ev);
  await ev("A.go('logs')");
  const n2 = await until(ev, hasLines, 6000) ? await lines() : 0;
  check('日志中心', '去别的页面再回来：选中的那一局内容还在（以前右边是空白）', n2 === 3000, { n2 });
  await ev("A.go('home')"); await calm(ev);
  await ev("A.go('logs', { open: 'small' })");
  await until(ev, "document.querySelectorAll('.lc-log .log-line').length === 2", 6000);
  o = await ev("(() => ({ n: document.querySelectorAll('.lc-log .log-line').length, on: [...document.querySelectorAll('.lc-item.on')].map((x) => x.dataset.log), text: document.querySelector('.lc-log').innerText.slice(0, 40) }))()");
  check('日志中心', '从日志抽屉「在日志中心查看」带着某一局过来：选中它，内容显示出来（以前是空白）', o.n === 2 && o.on[0] === 'small' && /hello/.test(o.text), o);

  // 导出整份：点按钮，另存为选到测试目录里
  const outFile = path.join(root, 'exported.log');
  await ev("A.go('logs', { open: 'big' })");
  await until(ev, "document.querySelectorAll('.lc-log .log-line').length === 3000", 8000);
  await ev(`aurora.invoke('debug:__saveTo', ${JSON.stringify(outFile)})`);
  await ev("(() => { const b = document.querySelector('.lc-tools [data-tip=\"导出整份日志\"]'); if (b) b.click(); return !!b; })()");
  await until(ev, "[...document.querySelectorAll('.toast')].some((t) => /已导出/.test(t.innerText))", 8000);
  const exported = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean) : [];
  check('日志中心', '「导出整份日志」导出的是整份：25000 行一行不少（以前只有最后 20000 行）', exported.length === 25000 && / line 0$/.test(exported[0]), { n: exported.length, first: exported[0] });
  await ev("document.querySelectorAll('.toast').forEach((t) => t.remove()); 1");

  // 看正在玩的那一局：新行一直进来，页面上的行数有上限
  await ev("A.go('logs', { open: 'small' })");
  await until(ev, "document.querySelectorAll('.lc-log .log-line').length === 2", 6000);
  await ev("(() => { A.state.games.set('gLive', { id: 'gLive', versionId: 'Plain', state: 'running', startedAt: Date.now(), logId: 'small' }); return 1; })()");
  const batch = Array.from({ length: 3000 }, (_, i) => ({ text: `[12:00:00] [Render thread/INFO]: live ${i} ${'x'.repeat(60)}`, level: 'INFO' }));
  for (let i = 0; i < 10; i++) await ev(`aurora.invoke('debug:__gameLog', 'gLive', ${JSON.stringify(batch)})`, 30000);
  await calm(ev);
  o = await ev("(() => { const b = document.querySelector('.lc-log'); const all = b.querySelectorAll('.log-line'); return { n: all.length, more: (b.querySelector('.lc-more') || {}).innerText || '', last: all[all.length - 1].innerText.slice(0, 50), atBottom: b.scrollHeight - b.scrollTop - b.clientHeight < 40 }; })()");
  check('日志中心', '实时追加 3 万行：页面上最多留 7000 行，最新的在最下面，更早的收进「显示更早的」', o.n <= 7000 && o.n >= 5000 && /live 2999/.test(o.last) && /显示更早的/.test(o.more) && o.atBottom, o);
  await ev("A.state.games.delete('gLive'); 1");

  // 界面这边结束了的游戏只记最近 10 局
  for (let i = 0; i < 15; i++) await ev(`aurora.invoke('debug:__send', 'game:exit', ${JSON.stringify({ id: `old${i}`, versionId: 'Plain', state: 'exited', startedAt: 1000 + i, endedAt: 2000 + i, exitCode: 0, test: true, crash: null })})`);
  await calm(ev);
  o = await ev("(() => { const ids = [...A.state.games.values()].filter((g) => g.state === 'exited').map((g) => g.id); return { n: ids.length, hasNewest: ids.includes('old14'), hasOldest: ids.includes('old0') }; })()");
  check('日志抽屉', '结束了的游戏在界面这边只记最近 10 局（以前一直记着）', o.n <= 10 && o.hasNewest && !o.hasOldest, o);

  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 3));
  await a.stop();
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  void os;
  process.exit(bad ? 1 : 0);
})();
