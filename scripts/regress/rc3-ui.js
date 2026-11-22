'use strict';
/**
 * rc3 这一轮的界面改动（试用 rc2 后提的一批）：
 *   node scripts/regress/rc3-ui.js
 * 主页胶囊（只留场景和骰子，没 Java 时多一个红色的）、取消双击回原位、下边平移感应区、启动栏变窄、天气、音效开关、
 * 设置分类（声音在常规、缓存在数据）和别处跳到设置的位置、删除确认不用打字、任务中心里没做完的 Mod 配置、
 * 旧版 64×32 皮肤（帽子层整块不透明时去掉）、生物放大一圈、侧边栏「下载中心」。
 * 3 种风格、明暗、1.5 倍、高对比度都截图（AURORA_REGRESS_DIR/rc3-ui）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG, fakeVersion } = require('./robust-ui');
const { sleep, guard, ready, until, WORLD_SEED } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'rc3-ui');
const results = [];
guard(results, 'rc3-ui'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 600)}` : ''}`);
}

const BG = { type: 'scene', scene: 'plains', time: 'day', fx: 'high', fps: 30, mobs: 10, animals: true, monsters: true, aquatic: true, players: false, buildings: false, pan: true, eggs: false };
const prepare = ({ game }) => {
  fakeVersion(game, 'Plain', { clientVersion: '1.20.1' });
  fakeVersion(game, 'Fab', { clientVersion: '1.20.1', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] });
};
const clean = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove()); A.closePopover && A.closePopover();";

async function shot(a, name) {
  const r = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}

async function functional() {
  const a = await start('rc3-ui', { prepare, config: (game) => ({ ...BASE_CONFIG(game), selectedVersion: 'Fab', background: BG }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); return; }
  await ready(a.ev);
  const ev = (code, t = 15000) => a.ev(code, t);

  // ── 主页胶囊 ──
  await ev(`(async () => { ${clean} await A.go('home'); A.state.javas = [{ path: 'C:/j/java.exe', version: '17' }]; A.emit('javas', A.state.javas); await new Promise((r) => setTimeout(r, 400)); })()`);
  let o = await ev("(() => { const s = document.querySelector('.home-stats'); return { kids: [...s.children].map((c) => c.className), text: s.textContent }; })()");
  check('胶囊', '有 Java 时问候下面只有场景胶囊和骰子', o.kids.length === 1 && /scene-pill-wrap/.test(o.kids[0]) && !/个游戏配置|下载源|背景音乐/.test(o.text), o);
  o = await ev("(async () => { A.state.javas = []; A.emit('javas', []); await new Promise((r) => setTimeout(r, 400)); const b = document.querySelector('.home-stats .java-missing'); if (!b) return { found: false }; const anim = getComputedStyle(b, '::after').animationName; b.click(); await new Promise((r) => setTimeout(r, 500)); return { found: true, text: b.textContent, anim, page: A.state.page }; })()");
  check('胶囊', '没检测到 Java 时多一个红色光圈的按钮，点了去 Java 页面', o.found && /未检测到 Java/.test(o.text) && o.anim === 'java-ring' && o.page === 'java', o);
  await ev("(async () => { A.state.javas = [{ path: 'C:/j/java.exe', version: '17' }]; A.emit('javas', A.state.javas); await A.go('home'); await new Promise((r) => setTimeout(r, 400)); })()");
  o = await ev("document.querySelectorAll('.home-stats .java-missing').length");
  check('胶囊', '有 Java 以后红色按钮消失', o === 0, o);
  await shot(a, '主页-胶囊');

  // ── 双击不再回到原位 ──
  o = await ev(`(async () => { const s = A.homeScene(); s.zoomBy(1.8); await new Promise((r) => setTimeout(r, 600)); const r0 = s.zoomT;
    const c = document.querySelector('.home-bg canvas'); const rect = c.getBoundingClientRect();
    const t = document.elementFromPoint(rect.left + rect.width * 0.5, rect.top + rect.height * 0.45);
    t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.45 }));
    await new Promise((r) => setTimeout(r, 600)); const after = s.zoomT; s.camHome(); return { r0, after, target: t.className }; })()`);
  check('双击', '双击空白处不再把视角和缩放拉回原位', o.r0 > 1.5 && Math.abs(o.after - o.r0) < 0.01, o);
  o = await ev("document.querySelector('.cam-home').dataset.tip");
  check('双击', '「回到地面」按钮的提示不再说双击', !/双击/.test(o || ''), o);

  // ── 下边的平移感应区 ──
  o = await ev(`(() => { const s = A.homeScene(); const z = s.edgeZones(); const dock = document.querySelector('.dock').getBoundingClientRect();
    const band = z.hgt * z.zy; const res = {};
    const at = (y) => { s.panEdge(window.innerWidth / 2, y); const e = s.edge; s.panStop(); return e ? Math.round(e.dy * 100) / 100 : 0; };
    res.bot = Math.round(z.bot); res.dockTop = Math.round(dock.top); res.band = Math.round(band);
    res.aboveBand = at(z.bot - 6); res.inBand = at(z.bot + band / 2); res.atDockTop = at(dock.top - 1);
    const cam = document.querySelector('.cam-home'); cam.classList.remove('hidden');
    res.dockBlank = A.homeBlankAt(document.querySelector('.dock .launch-btn')); res.camBlank = A.homeBlankAt(cam); cam.classList.add('hidden');
    return res; })()`);
  check('平移', '下边感应区从启动栏顶边往上一条开始', Math.abs(o.dockTop - o.bot - o.band) <= 2 && o.aboveBand === 0 && o.inBand > 0.3 && o.atDockTop > 0.9, o);
  check('平移', '鼠标在启动栏、「回到地面」按钮上不算背景（不平移）', o.dockBlank === false && o.camBlank === false, o);

  // ── 启动栏变窄 ──
  const fits = [];
  for (const w of [1100, 820, 700, 560]) {
    o = await ev(`(async () => { const d = document.querySelector('.dock'); d.style.maxWidth = '${w}px'; await new Promise((r) => setTimeout(r, 450));
      const iso = d.querySelector('.d-iso svg'); const r = iso && iso.getBoundingClientRect(); const label = d.querySelector('.d-label').getBoundingClientRect();
      const tool = d.querySelector('.dock-tool span'); const lt = d.querySelector('.launch-btn .l-text'); const lb = d.querySelector('.launch-btn');
      const over = [...d.querySelectorAll('.dock-pick, .dock-tool, .launch-btn')].filter((x) => x.getBoundingClientRect().right > d.getBoundingClientRect().right + 1).length;
      return { w: d.clientWidth, fit: d.dataset.fit, iso: r ? [Math.round(r.width), Math.round(r.height), r.right <= label.right + 0.5] : null, toolText: tool ? getComputedStyle(tool).display : null, launchText: lt ? getComputedStyle(lt).display : null, launchW: Math.round(lb.getBoundingClientRect().width), tip: lb.dataset.tip || null, over }; })()`);
    fits.push(o);
    await shot(a, `启动栏-${w}`);
  }
  check('启动栏', '越窄越省：完整 → 工具只剩图标 → 启动按钮变窄 → 只剩播放图标', fits.map((f) => f.fit).join(',') === 'full,tools,small,icon', fits.map((f) => `${f.w}:${f.fit}`));
  check('启动栏', '独立存档的盾牌图标一直是 12 像素、不出界', fits.every((f) => f.iso && f.iso[0] === 12 && f.iso[1] === 12 && f.iso[2]), fits.map((f) => f.iso));
  check('启动栏', '工具按钮的字在窄的时候藏起来，只剩图标', fits[0].toolText !== 'none' && fits.slice(1).every((f) => f.toolText === 'none'), fits.map((f) => f.toolText));
  check('启动栏', '启动按钮最窄时只剩图标，鼠标停上去有原来按钮上的字', fits[3].launchText === 'none' && fits[3].launchW <= 80 && /启动游戏|添加账户/.test(fits[3].tip || '') && !fits[0].tip, fits.map((f) => [f.launchW, f.tip]));
  check('启动栏', '每一档按钮都不超出启动栏', fits.every((f) => f.over === 0), fits.map((f) => f.over));
  await ev("document.querySelector('.dock').style.maxWidth = ''");

  // ── 天气 ──
  o = await ev(`(async () => { const s = A.homeScene(); const w0 = s.weatherInfo(); s.setWeather('rain'); await new Promise((r) => setTimeout(r, 2500));
    const rain = s.parts.filter((p) => p.rain).length; const pill = document.querySelector('.scene-pill').textContent;
    return { w0, now: s.weatherInfo(), rain, pill, level: s.wx.level }; })()`);
  check('天气', '平原能下雨，强制下雨后开始下（有雨点、天色渐暗），胶囊上写着「下雨」', o.w0.can && o.now.kind === 'rain' && o.now.forced && o.rain > 20 && o.level > 0.3 && /下雨/.test(o.pill), o);
  await shot(a, '天气-下雨');
  o = await ev(`(async () => { const s = A.homeScene(); s.setWeather('thunder'); await new Promise((r) => setTimeout(r, 3000));
    for (let i = 0; i < 12 && !s.wx.struck; i++) { s.wx.nextBolt = performance.now(); await new Promise((r) => setTimeout(r, 120)); } // 四分之一是远处的雷（只有闪光没有闪电），多试几次
    return { kind: s.wx.kind, storm: s.wx.storm, struck: s.wx.struck || 0, dark: s.stormDark(), pill: document.querySelector('.scene-pill').textContent }; })()`);
  check('天气', '雷雨：天更暗、打闪电，白天也算能刷怪，胶囊上写着「雷雨」', o.kind === 'thunder' && o.storm > 0.5 && o.struck >= 1 && o.dark && /雷雨/.test(o.pill), o);
  await ev("(() => { const s = A.homeScene(); s.wx.nextBolt = performance.now(); })()");
  await sleep(90); // pitfall-ok：闪电只亮一下，要在那一瞬间截图
  await shot(a, '天气-雷雨');
  o = await ev(`(async () => { const s = A.homeScene(); document.querySelector('.scene-pill').click(); await new Promise((r) => setTimeout(r, 400));
    const pop = document.querySelector('.scene-pop'); const wx = pop && pop.querySelector('.scene-weather'); const opts = wx ? [...wx.querySelectorAll('button')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')) : null;
    const auto = wx && wx.querySelector('button'); if (auto) auto.click(); await new Promise((r) => setTimeout(r, 300)); const after = s.weatherInfo(); A.closePopover(); return { opts, after }; })()`);
  check('天气', '场景胶囊里能选天气（自动 / 晴天 / 下雨 / 雷雨），选回自动后不再强制', o.opts && o.opts.join('|') === '自动|晴天|下雨|雷雨*' && !o.after.forced, o);
  o = await ev(`(async () => { await A.setConfig({ background: { scene: 'snowy' } }); await new Promise((r) => setTimeout(r, 1200)); const s = A.homeScene(); const fresh = s.weatherInfo(); s.setWeather('rain'); await new Promise((r) => setTimeout(r, 2500));
    const snow = s.parts.filter((p) => p.weather && !p.rain).length; const rain = s.parts.filter((p) => p.rain).length;
    document.querySelector('.scene-pill').click(); await new Promise((r) => setTimeout(r, 400)); const opts = [...document.querySelectorAll('.scene-pop .scene-weather button')].map((b) => b.textContent); A.closePopover();
    return { fresh, precip: fresh.precip, snow, rain, opts, pill: document.querySelector('.scene-pill').textContent }; })()`);
  check('天气', '换场景后强制的天气不留着，重新按概率算', o.fresh && o.fresh.forced === false, o.fresh);
  check('天气', '雪原「下雨」下的是雪（菜单和胶囊上都叫「下雪」），不下雨点', o.precip === 'snow' && o.snow > 5 && o.rain === 0 && o.opts.includes('下雪') && /下雪/.test(o.pill), o);
  await shot(a, '天气-雪原下雪');
  o = await ev(`(async () => { await A.setConfig({ background: { scene: 'desert' } }); await new Promise((r) => setTimeout(r, 1200)); const s = A.homeScene(); s.setWeather('rain'); await new Promise((r) => setTimeout(r, 800));
    document.querySelector('.scene-pill').click(); await new Promise((r) => setTimeout(r, 400)); const pop = document.querySelector('.scene-pop'); const txt = pop ? pop.textContent : ''; const seg = pop ? pop.querySelectorAll('.scene-weather').length : -1; A.closePopover();
    return { w: s.weatherInfo(), txt: /这里不下雨/.test(txt), seg }; })()`);
  check('天气', '沙漠不下雨：强制也不变，菜单里只写「这里不下雨」', !o.w.can && o.w.kind === 'clear' && o.txt && o.seg === 0, o);
  o = await ev(`(async () => { await A.setConfig({ background: { scene: 'nether' } }); await new Promise((r) => setTimeout(r, 1200)); const s = A.homeScene(); return s.weatherInfo(); })()`);
  check('天气', '下界没有天气', !o.can && o.kind === 'clear', o);
  // 概率：按规则模拟很多次打开
  o = await ev(`(() => { const s = A.homeScene(); const keep = { scene: s.sceneId, S: s.S, dim: s.dim, wx: s.wx };
    s.S = A.sceneKit.SCENES.plains; s.dim = 'over'; const n = { clear: 0, rain: 0, thunder: 0 }; const dur = { rain: [], clear: [] };
    for (let i = 0; i < 4000; i++) { s.weatherInit(); n[s.wx.kind]++; if (s.wx.kind !== 'thunder') dur[s.wx.kind].push((s.wx.until - Date.now()) / 60000); }
    Object.assign(s, keep);
    const range = (a) => [Math.min(...a).toFixed(1), Math.max(...a).toFixed(1)];
    return { rain: n.rain / 4000, thunder: n.thunder / 4000, rainMin: range(dur.rain), clearMin: range(dur.clear) }; })()`);
  check('天气', '打开时约 20% 下雨、8% 雷雨；雨 3~6 分钟，晴天 15~25 分钟', Math.abs(o.rain - 0.2) < 0.03 && Math.abs(o.thunder - 0.08) < 0.02 && +o.rainMin[0] >= 3 && +o.rainMin[1] <= 6 && +o.clearMin[0] >= 15 && +o.clearMin[1] <= 25, o);
  await ev("A.setConfig({ background: { scene: 'plains' } })");
  await until(ev, "(() => { const s = A.homeScene(); return !!(s && s.opts && s.opts.scene === 'plains' && s.heights); })()", 10000);

  // ── 水碰岩浆：瀑布落到岩浆湖上变黑曜石（rc3） ──
  o = await ev(`(async () => {
    const s = A.homeScene(); const M = A.sceneKit.M; const out = { worlds: 0, falls: 0, quenched: 0, leak: [], spot: null };
    for (let k = 0; k < 10; k++) {
      s.seed = 20400 + k * 13; s.opts = { ...s.opts, scene: 'plains' }; s.build(); out.worlds++;
      const surf = s.BOT - 12;
      for (let c = -1500; c < 1500; c++) {
        if (!s.fallInto(c)) continue;
        out.falls++;
        if (s.rawSolid(c, surf, null)) continue; // 落在石头上，没有岩浆
        if (!s.quenchedAt(c, surf)) { out.leak.push([s.seed, c]); continue; }
        out.quenched++;
        if (!out.spot) {
          const cell = s.cellAtWorld(c, surf); const side = [s.cellAtWorld(c - 1, surf), s.cellAtWorld(c + 1, surf)];
          out.spot = { seed: s.seed, c, obsidian: !!cell && cell.mat === M.obsidian, steam: cell && cell.fx, lava: s.lavaAt(c, surf), fluid: s.fluidAt(c, surf), below: s.lavaAt(c, surf + 1) };
        }
      }
      if (out.spot && out.worlds >= 3) break;
    }
    return out; })()`, 120000);
  check('水碰岩浆', '瀑布落到岩浆湖上的地方都变成了黑曜石（没有一道瀑布直接落进岩浆）', o.quenched > 0 && o.leak.length === 0, o);
  check('水碰岩浆', '黑曜石那格不再算岩浆（生物照样躲开下面的岩浆），上面冒蒸汽', o.spot && o.spot.obsidian && !o.spot.lava && o.spot.fluid !== 'lava' && o.spot.below && o.spot.steam === 'steam', o.spot);
  if (o.spot) {
    await ev(`(async () => { const s = A.homeScene(); s.seed = ${o.spot ? o.spot.seed : 0}; s.build(); const B = s.B; s.cam.tx = ${o.spot ? o.spot.c : 0} * B - s.W / 2; s.cam.ty = (s.BOT - 12) * B - s.H * 0.7; s.cam.x = s.cam.tx; s.cam.y = s.cam.ty; s.ensureChunks(true); await new Promise((r) => setTimeout(r, 1500)); })()`, 30000);
    await shot(a, '水碰岩浆-黑曜石');
    await ev(`(() => { const s = A.homeScene(); s.seed = ${WORLD_SEED}; s.camHome(); s.build(); })()`); // 换回固定的世界（以前换回「今天的」，后面的检查就跟着日期变）
  }

  // ── 音效开关 ──
  o = await ev(`(async () => { const b = document.getElementById('btnSound'); const music = document.getElementById('btnMusic'); const r = {};
    r.exists = !!b; r.nextToMusic = b && music && b.previousElementSibling === music; r.on0 = A.state.config.sound.enabled; b.click(); await new Promise((x) => setTimeout(x, 400));
    r.on1 = A.state.config.sound.enabled; r.cls = b.className; r.tip = b.dataset.tip; r.played = await A.gameSound.play('block.amethyst_block.chime'); b.click(); await new Promise((x) => setTimeout(x, 400)); r.on2 = A.state.config.sound.enabled; return r; })()`);
  check('音效', '顶栏音乐旁边有音效开关，点一下关、再点一下开；关着时不出声', o.exists && o.nextToMusic && o.on0 === true && o.on1 === false && /off/.test(o.cls) && o.tip === '打开音效' && o.played === null && o.on2 === true, o);

  // ── 设置：分类 ──
  o = await ev(`(async () => { await A.go('settings'); await new Promise((r) => setTimeout(r, 500)); const panes = {};
    for (const p of document.querySelectorAll('.set-pane')) panes[p.dataset.cat] = [...p.querySelectorAll('.set-group')].map((g) => g.dataset.k || (g.querySelector('h3') || {}).textContent);
    const general = document.querySelector('.set-pane[data-cat="general"]'); const rows = general ? [...general.querySelectorAll('.set-row .s-text')].map((x) => x.textContent) : [];
    return { panes, sound: rows.some((t) => /^音效/.test(t)), music: rows.some((t) => /^播放背景音乐/.test(t)) }; })()`);
  const has = (cat, word) => (o.panes[cat] || []).some((g) => String(g).includes(word));
  check('设置', '「常规」里有声音（背景音乐和音效的开关）', has('general', '声音') && o.sound && o.music, o);
  check('设置', '缓存在「数据」里，不在「下载」里', has('data', '缓存') && !has('download', '缓存'), o.panes);
  check('设置', '「外观」里不再有背景音乐', !has('look', '音乐') && !has('look', '声音'), o.panes.look);
  // 别处跳到设置
  const jumps = [];
  for (const focus of ['background', 'gamesync', 'gameDir', 'curseforge', 'sound', 'perf', 'a11y', 'cache']) {
    o = await ev(`(async () => { await A.go('home'); await new Promise((r) => setTimeout(r, 200)); await A.go('settings', { focus: '${focus}' }); await new Promise((r) => setTimeout(r, 900));
      const el = document.getElementById('set-${focus}'); if (!el) return { focus: '${focus}', missing: true };
      const pane = el.closest('.set-pane'); const active = document.querySelector('.set-cat.active'); const r = el.getBoundingClientRect(); const sc = el.closest('.page').getBoundingClientRect();
      return { focus: '${focus}', visible: el.offsetParent !== null, cat: pane.dataset.cat, active: active && active.dataset.cat, inView: r.top >= sc.top - 2 && r.top < sc.bottom - 20 }; })()`);
    jumps.push(o);
  }
  check('设置', '从别处跳到设置时切到对应的分类、滚到那一项', jumps.every((j) => !j.missing && j.visible && j.cat === j.active && j.inView), jumps);
  o = await ev(`(async () => { await A.go('home'); await new Promise((r) => setTimeout(r, 300)); document.querySelector('.scene-pill').click(); await new Promise((r) => setTimeout(r, 300));
    const more = [...document.querySelectorAll('.scene-pop .menu-item')].find((x) => /更多背景设置/.test(x.textContent)); more.click(); await new Promise((r) => setTimeout(r, 900));
    return { page: A.state.page, active: (document.querySelector('.set-cat.active') || {}).dataset.cat }; })()`);
  check('设置', '主页「更多背景设置…」点了到设置的「外观」', o.page === 'settings' && o.active === 'look', o);

  // ── 删除确认：二次弹窗 + 5 秒 ──
  o = await ev(`(async () => { ${clean} const p = A.dangerConfirm({ level: 3, title: '删除测试', text: '测试', confirmName: 'Foo', okText: '删除' });
    await new Promise((r) => setTimeout(r, 400)); const m = document.querySelector('.modal-back:last-child'); [...m.querySelectorAll('.modal-foot .btn')].pop().click(); await new Promise((r) => setTimeout(r, 400));
    const ok = [...m.querySelectorAll('.modal-foot .btn')].pop(); const r = { inputs: m.querySelectorAll('.modal-body input').length, title: m.querySelector('.modal-head h2').textContent, d0: ok.disabled, t0: ok.textContent, focus: document.activeElement && document.activeElement.textContent, body: m.querySelector('.modal-body').textContent };
    await new Promise((x) => setTimeout(x, 3000)); r.d3 = ok.disabled; await new Promise((x) => setTimeout(x, 2600)); r.d6 = ok.disabled; r.t6 = ok.textContent; ok.click(); r.res = await p; return r; })()`, 20000);
  check('删除确认', '第二步不用打字也不用勾选，再弹一次、写清楚是哪一个', o.inputs === 0 && o.title === '再次确认' && /Foo/.test(o.body), o);
  check('删除确认', '确认按钮 5 秒后才能点（3 秒时还不行），焦点在「取消」上', o.d0 && /5 秒/.test(o.t0) && o.d3 && !o.d6 && o.t6 === '删除' && o.focus === '取消', o);
  check('删除确认', '等完 5 秒点确认，返回确认结果', o.res && typeof o.res === 'object', o.res);

  // ── 任务中心里没做完的 Mod 配置 ──
  o = await ev(`(async () => { ${clean} await A.api('planner:save', { name: '测试清单', mc: '1.20.1', loader: 'fabric', styles: [], items: [{ projectId: 'AANobbMI', title: 'Sodium', selected: true }], step: 2 });
    await A.go('home'); await new Promise((r) => setTimeout(r, 900)); const badge = document.querySelector('.nav-item[aria-label="任务中心"] .nav-badge');
    await A.go('tasks'); await new Promise((r) => setTimeout(r, 900)); const row = document.querySelector('.tc-plan');
    return { badge: badge ? [badge.textContent, badge.className] : null, row: row ? row.textContent : null, n: document.querySelectorAll('.tc-plan').length }; })()`);
  check('任务中心', '有没做完的 Mod 配置时侧边栏「任务中心」上是灰色的数字', o.badge && o.badge[0] === '1' && /idle/.test(o.badge[1]), o.badge);
  check('任务中心', '任务中心最上面列出没做完的配置（停在第几步、几个 Mod）', o.n === 1 && /测试清单/.test(o.row) && /第 2 步/.test(o.row) && /1 个 Mod/.test(o.row), o);
  await shot(a, '任务中心-没做完的配置');
  o = await ev(`(() => { const b = [...document.querySelectorAll('.tc-plan .btn')].find((x) => /接着做/.test(x.textContent)); return { net: b.hasAttribute('data-net'), offline: A.offline.on() }; })()`);
  check('任务中心', '「接着做」「删除重来」标成要联网（断网时和别的联网入口一样变灰）', o.net, o);
  // 隔离层里没有网，启动器会切到离线模式：联网的入口点了只提示、不进配置器
  if (o.offline) {
    o = await ev(`(async () => { [...document.querySelectorAll('.tc-plan .btn')].find((b) => /接着做/.test(b.textContent)).click(); await new Promise((r) => setTimeout(r, 600)); return { page: A.state.page, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' ') }; })()`);
    check('任务中心', '断网时点「接着做」只提示没有网络，不跳走', o.page === 'tasks' && /没有网络/.test(o.toast), o);
  }
  // 下面假装有网，测接着做的流程（去掉联网标记、放行页面）
  const online = 'A.offline.allows = () => true; document.documentElement.classList.remove("offline"); document.querySelectorAll("[data-net]").forEach((b) => b.removeAttribute("data-net"));';
  await ev(online);
  o = await ev(`(async () => { [...document.querySelectorAll('.tc-plan .btn')].find((b) => /接着做/.test(b.textContent)).click(); await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 40 && !(A.plannerKit.P.plan && A.plannerKit.P.plan.name); i++) await new Promise((r) => setTimeout(r, 250)); // 第一次进配置器要先初始化
    const asked = !!document.querySelector('.modal-back .modal-head h2') && /还没完成/.test(document.querySelector('.modal-back .modal-head h2').textContent);
    const P = A.plannerKit.P; return { page: A.state.page, step: P.step, name: P.plan && P.plan.name, asked }; })()`, 20000);
  check('任务中心', '点「接着做」回到配置器停下的那一步，不再弹「还没完成」的提示', o.page === 'planner' && o.step === 2 && o.name === '测试清单' && !o.asked, o);
  o = await ev(`(async () => { ${clean} await A.go('tasks'); await new Promise((r) => setTimeout(r, 900)); ${online} const b = [...document.querySelectorAll('.tc-plan .btn')].find((x) => /删除重来/.test(x.textContent)); b.click(); await new Promise((r) => setTimeout(r, 400));
    const m = document.querySelector('.modal-back:last-child'); const txt = m.textContent; [...m.querySelectorAll('.modal-foot .btn')].pop().click(); await new Promise((r) => setTimeout(r, 1500));
    const plans = await A.api('planner:list'); await A.go('home'); await new Promise((r) => setTimeout(r, 800)); const badge = document.querySelector('.nav-item[aria-label="任务中心"] .nav-badge');
    return { txt, page: A.state.page, left: plans.filter((p) => !p.done).length, badge: badge ? badge.textContent : null }; })()`);
  check('任务中心', '「删除重来」先问一下，删掉后回到配置器第一步、数字消失', /删除/.test(o.txt) && o.left === 0 && !o.badge, o);

  // ── 旧版 64×32 皮肤 ──
  o = await ev(`(async () => {
    const make = (hatHole) => { const c = document.createElement('canvas'); c.width = 64; c.height = 32; const g = c.getContext('2d');
      g.fillStyle = '#c89a7a'; g.fillRect(8, 8, 8, 8); g.fillStyle = '#3366aa'; g.fillRect(20, 20, 8, 12); g.fillStyle = '#334455'; g.fillRect(44, 20, 4, 12); g.fillRect(4, 20, 4, 12);
      g.fillStyle = '#000'; g.fillRect(32, 0, 32, 16); if (hatHole) g.clearRect(40, 8, 8, 8); return c.toDataURL('image/png').split(',')[1]; };
    const read = async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g; };
    const a1 = await A.skinTools.normalize(make(false)); const g1 = await read(a1.png);
    const a2 = await A.skinTools.normalize(make(true)); const g2 = await read(a2.png);
    const alpha = (g, x, y) => g.getImageData(x, y, 1, 1).data[3];
    return { legacy: a1.legacy, hat1: alpha(g1, 33, 1), hatFront1: alpha(g1, 40, 9), hat2: alpha(g2, 33, 1), leftArm: alpha(g1, 36, 52), leftLeg: alpha(g1, 20, 52), head: alpha(g1, 10, 10) }; })()`);
  check('皮肤', '旧版皮肤帽子层整块不透明（像 Notch 的纯黑）时去掉，不会变成大黑头', o.legacy && o.hat1 === 0 && o.hatFront1 === 0, o);
  check('皮肤', '帽子层本来有透明的地方（真的帽子）就留着；左手左腿照旧补上', o.hat2 === 255 && o.leftArm === 255 && o.leftLeg === 255 && o.head === 255, o);

  // ── 生物放大一圈、侧边栏 ──
  o = await ev("(() => { const S = A.sceneKit.SPRITES; const sz = (k) => S[k].w + 'x' + S[k].h; return { zombie: sz('zombie'), skeleton: sz('skeleton'), creeper: sz('creeper'), pig: sz('pig'), cow: sz('cow'), spider: sz('spider'), enderman: sz('enderman'), steve: sz('steve'), zh: S.zombie.hostile && S.zombie.burns, dr: S.drowned.swims && S.drowned.emissive, ax: S.axolotl.axolotl && S.axolotl.swims, walk: !!S.zombie.walk, magmaMouth: S.magma.rows.some((r) => /mOOOm/.test(r)), slime: S.slime ? [sz('slime'), S.slime.hostile, S.slime.hops] : null, slimeAt: ['plains', 'forest', 'darkforest'].filter((k) => A.sceneKit.SCENES[k].hostile.includes('slime')), spiderLegs: S.spider.rows[S.spider.rows.length - 1].split('l').length - 1, spiderRows: S.spider.rows.join('|') }; })()");
  check('生物', '人形怪物和玩家一样 10 格高，动物也大一圈；原来的属性（会烧、会游泳、发光）都还在', o.zombie === '5x10' && o.skeleton === '5x10' && o.steve === '4x10' && o.pig === '9x5' && o.zh && o.dr && o.ax && o.walk, o);
  check('生物', '苦力怕是 6 格宽的正脸；蜘蛛只画前后两对腿；岩浆怪不画嘴；有普通史莱姆（平原、森林、黑森林夜里和洞里）', o.creeper === '6x10' && o.spiderLegs === 2 && o.spiderRows === '..l....l..|.l.kkkk.l.|l.kkkkkkRR|l.kkkkkkk.|l.......l.' && !o.magmaMouth && o.slime && o.slime[1] && o.slime[2] && o.slimeAt.length === 3, o);
  o = await ev("(() => { const b = document.querySelector('.nav-item[aria-label=\"下载中心\"]'); return { found: !!b, text: b && b.textContent }; })()");
  check('侧边栏', '「下载」改叫「下载中心」', o.found && /下载中心/.test(o.text), o);

  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  await a.stop();
}

// 各种外观下截图看一眼：主页（下雨、窄启动栏、红色 Java 按钮）、任务中心、设置常规
const LOOKS = [
  ['极光-深', {}], ['像素-深', { ui: { style: 'pixel' }, theme: 'dark' }], ['紧凑-深', { ui: { style: 'compact' }, theme: 'dark' }],
  ['极光-浅', { theme: 'light' }], ['像素-浅', { ui: { style: 'pixel' }, theme: 'light' }], ['紧凑-浅', { ui: { style: 'compact' }, theme: 'light' }],
  ['极光-1.5倍', { a11y: { zoom: 1.5 } }], ['极光-高对比', { a11y: { contrast: 'high' } }], ['极光-英文', { language: 'en' }],
];
async function looks() {
  let n = 0;
  for (const [name, cfg] of LOOKS) {
    const a = await start(`rc3-look-${n++}`, { prepare, config: (game) => ({ ...BASE_CONFIG(game), selectedVersion: 'Fab', background: BG, ...cfg }) });
    if (a.startError) { check('外观', `${name}：能打开`, false, a.startError); continue; }
    await ready(a.ev);
    const o = await a.ev(`(async () => { ${clean} A.state.javas = []; A.emit('javas', []); await A.go('home'); const s = A.homeScene(); if (s) { s.setWeather('rain'); } await new Promise((r) => setTimeout(r, 2500));
      const d = document.querySelector('.dock'); const over = [...d.querySelectorAll('.dock-pick, .dock-tool, .launch-btn')].filter((x) => x.getBoundingClientRect().right > d.getBoundingClientRect().right + 1).length;
      const iso = d.querySelector('.d-iso svg'); const sound = document.getElementById('btnSound'); const sr = sound.getBoundingClientRect();
      return { fit: d.dataset.fit, over, iso: iso ? Math.round(iso.getBoundingClientRect().width) : null, sound: sr.width > 0 && sr.height > 0, java: !!document.querySelector('.java-missing') }; })()`, 20000);
    await shot(a, `${name}-主页`);
    check('外观', `${name}：启动栏不超出、盾牌图标不缩小、音效开关和红色 Java 按钮都在`, o.over === 0 && (o.iso == null || o.iso >= 12) && o.sound && o.java, o);
    await a.ev(`(async () => { await A.api('planner:save', { name: 'Demo', mc: '1.20.1', loader: 'fabric', styles: [], items: [{ projectId: 'x', title: 'Sodium', selected: true }], step: 2 }); await A.go('tasks'); await new Promise((r) => setTimeout(r, 900)); })()`);
    await shot(a, `${name}-任务中心`);
    await a.ev("(async () => { await A.go('settings'); await new Promise((r) => setTimeout(r, 600)); })()");
    await shot(a, `${name}-设置常规`);
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
