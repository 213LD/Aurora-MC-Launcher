'use strict';
/**
 * rc15（用户试用 rc14：来回切页面、拉窗口、切到后台，回来所有生物都不动，一批在原地迈步）：
 *   node scripts/regress/rc15-ui.js
 * 连上用户正开着的启动器查到：20 个生物全都「正在消失」好几分钟了。updateEnt 每帧先淡入 +1.5×秒、再淡出 −1.2×秒，
 * 一帧下来反而变浓，停在 96% 永远消失不掉，而且正在消失的不再动；活到寿命的生物全卡在原地、占满数量上限不再刷新。
 * 以前的测试只看「标上了要消失」（fade），没看它真的没了。这里看真的没了、而且会刷新新的
 */
const fs = require('fs');
const path = require('path');
const { start, BASE_CONFIG } = require('./robust-ui');
const { guard, until, ready } = require('./cdp');

const results = [];
guard(results, 'rc15-ui');
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const BG = { type: 'scene', scene: 'plains', time: 'day', fx: 'high', fps: 30, mobs: 12, animals: true, monsters: true, aquatic: true, players: true, buildings: true, pan: true, eggs: false };

(async () => {
  const a = await start('rc15-ui', { config: (game) => ({ ...BASE_CONFIG(game), background: BG }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  const ev = (code, t = 60000) => a.ev(code, t);
  await ready(ev);
  await ev("document.querySelectorAll('.modal-back').forEach((m) => m.remove()); 1");
  await until(ev, 'A.homeScene().ents.length >= 6', 30000);

  // 一、标上「要消失」的生物：场景照常跑，两秒内真的没了
  let o = await ev(`(async () => { const s = A.homeScene(); const list = s.ents.slice(0, 4); for (const e of list) e.fade = true;
    await new Promise((r) => setTimeout(r, 2500));
    return { n: list.length, gone: list.filter((e) => e.dead && !s.ents.includes(e)).length, alpha: list.map((e) => +e.alpha.toFixed(2)) }; })()`);
  check('消失', '标上「要消失」的生物 2.5 秒内真的消失了（以前停在 96% 永远不消失）', o.n >= 4 && o.gone === o.n, o);

  // 二、所有生物都活到寿命：都消失，然后刷新新的，新的会走动（先等数量补回来）。
  // 快进（场景停下，按 33 毫秒一帧调 update）：用真实时间等的话，机器一忙帧就慢，结果跟着负载变。
  // 正在干活的（砍树 8 下约 3.6 秒，盖房子一块 0.7 秒）干完手上的活才走，所以它们单独算：干完以后也得没了（最多等模拟的 2 分钟）
  await until(ev, '(() => { const s = A.homeScene(); if (s.nextSpawn > performance.now() + 500) s.nextSpawn = performance.now(); return s.ents.length >= 6; })()', 60000, 500);
  o = await ev(`(() => { const s = A.homeScene(); s.stop(); let now = performance.now(); const old = new Set(s.ents);
    const step = (ms) => { for (let t = 0; t < ms; t += 33) { now += 33; s.update(33, now); } };
    const desc = (e) => \`\${e.kind}/\${e.state}\${e.fade ? '/fade' : ''}\`;
    for (const e of s.ents) e.born = now - e.life - 1000;
    const working = new Set(s.ents.filter((e) => e.state === 'work'));
    step(3000);
    const left = s.ents.filter((e) => old.has(e) && !working.has(e)).map(desc);
    let lateMs = 3000; while (lateMs < 120000 && s.ents.some((e) => old.has(e))) { step(1000); lateMs += 1000; }
    const leftLate = s.ents.filter((e) => old.has(e)).map(desc);
    s.nextSpawn = 0; // 刷新间隔是 2.5 ~ 6 秒，这里让它马上开始
    for (let t = 0; t < 30000 && s.ents.filter((e) => !old.has(e)).length < 3; t += 33) step(33);
    const fresh = s.ents.filter((e) => !old.has(e)); const x0 = fresh.map((e) => e.x);
    step(6000);
    const moved = fresh.filter((e, i) => s.ents.includes(e) && Math.abs(e.x - x0[i]) > 1).length;
    s.start();
    return { old: old.size, working: working.size, left, lateMs, leftLate, fresh: fresh.length, moved }; })()`, 90000);
  check('刷新', '所有生物都活到寿命：3 秒内全部消失（正在干活的干完这一下也没了），接着刷出新的，新的会走动', o.old >= 6 && !o.left.length && !o.leftLate.length && o.fresh >= 3 && o.moved >= 1, o);

  // 三、卡住的生物：标上要消失以后真的没了（rc4 的卡住检测以前只标了 fade）。
  // 也快进：真实时间里机器一卡，一帧走得多（蜘蛛每秒 6 像素，卡 100 毫秒就超过 0.5 像素），测试自己造的「卡住」就被当成挪过地方了
  o = await ev(`(() => { const s = A.homeScene(); const e = s.ents.find((x) => !x.spr.fly && !x.spr.swims && !x.cave && !x.event && !x.boat); if (!e) return { found: false };
    s.stop(); let now = performance.now();
    e.movedAt = now - 21000; e.movedX = e.x; e.state = 'walk'; e.moving = true; e.until = now + 1e9;
    now += 33; s.update(33, now); const marked = !!e.fade; // pitfall-ok：只是中间一步，结果看下面的 gone（真的没了、不在 s.ents 里）
    for (let t = 0; t < 2500; t += 33) { now += 33; s.update(33, now); }
    const gone = !!e.dead && !s.ents.includes(e);
    s.start();
    return { found: true, kind: e.kind, marked, gone }; })()`);
  check('卡住', '卡住 20 秒的生物标上要消失以后，真的消失了', o.found && o.marked && o.gone, o);

  // 四、像用户那样：切页面、拉窗口、切到后台再回来，场景还在动（没有超过 3 秒还在「正在消失」的）
  for (const p of ['versions', 'settings', 'home']) { await ev(`A.go(${JSON.stringify(p)})`); await new Promise((r) => setTimeout(r, 600)); } // pitfall-ok：模拟用户在页面之间切，每页停一会儿
  for (const [w, h] of [[1100, 640], [1280, 820], [1000, 600]]) { await a.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await new Promise((r) => setTimeout(r, 500)); } // pitfall-ok：模拟拖窗口，每次停一会儿
  await a.send('Emulation.clearDeviceMetricsOverride');
  await a.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  o = await ev(`(async () => { const s = A.homeScene(); const seen = new Map(); let stale = 0; let moving = 0; const t0 = performance.now();
    while (performance.now() - t0 < 12000) {
      const now = performance.now();
      for (const e of s.ents) { if (e.fade) { if (!seen.has(e)) seen.set(e, now); else if (now - seen.get(e) > 3000) stale++; } }
      await new Promise((r) => setTimeout(r, 250));
    }
    const x0 = s.ents.map((e) => e.x); await new Promise((r) => setTimeout(r, 3000)); moving = s.ents.filter((e, i) => Math.abs(e.x - x0[i]) > 1).length;
    return { ents: s.ents.length, stale, moving, drawErrors: s.drawErrors || 0, entErrors: s.entErrors || 0, lifeFixes: s.lifeFixes || 0 }; })()`, 60000);
  check('来回操作', '切页面、拉窗口以后：没有「正在消失」超过 3 秒的生物，有生物在走', o.stale === 0 && o.moving >= 1 && o.drawErrors === 0 && o.lifeFixes === 0, o);

  // 五、快进 30 分钟（场景停下，直接按 33 毫秒一帧调 update，几秒钟跑完）：用真实时间要挂机很久才出事的毛病在这里查。
  // 白天、晚上各一遍。每过模拟的一秒看一次：「正在消失」最长多久、有没有活过寿命还赖着的、每分钟有没有生物在走、有没有新生物刷出来
  for (const time of ['day', 'night']) {
    o = await ev(`(async () => { const s = A.homeScene(); s.setOptions({ time: ${JSON.stringify(time)} }); s.stop();
      let now = performance.now(); const fadeAt = new Map(); const known = new Set(s.ents); const fix0 = s.lifeFixes || 0; const err0 = s.entErrors || 0;
      let maxFade = 0; let overstay = 0; let spawned = 0; let minEnts = Infinity; const deadMinutes = []; let lastX = new Map(s.ents.map((e) => [e, e.x])); let movedThisMin = 0;
      for (let i = 1; i <= 30 * 60 * 30; i++) {
        now += 33; s.update(33, now);
        if (i % 30) continue; // 每模拟一秒看一次
        for (const e of s.ents) {
          if (!known.has(e)) { known.add(e); spawned++; }
          if (e.fade) { if (!fadeAt.has(e)) fadeAt.set(e, now); maxFade = Math.max(maxFade, now - fadeAt.get(e)); }
          if (!e.fade && !e.ending && !e.boat && !e.extra && e.state !== 'work' && e.life && now - e.born > e.life + 10000) overstay++;
          if (lastX.has(e) && Math.abs(lastX.get(e) - e.x) > 1) movedThisMin++;
        }
        lastX = new Map(s.ents.map((e) => [e, e.x]));
        if (i % (30 * 60) === 0) { minEnts = Math.min(minEnts, s.ents.length); if (!movedThisMin) deadMinutes.push(i / 1800); movedThisMin = 0; }
      }
      s.start();
      return { maxFadeMs: Math.round(maxFade), overstay, spawned, minEnts, deadMinutes, lifeFixes: (s.lifeFixes || 0) - fix0, entErrors: (s.entErrors || 0) - err0 }; })()`, 300000);
    check('快进 30 分钟', `${time === 'day' ? '白天' : '晚上'}：没有「正在消失」超过 2 秒的、没有活过寿命还赖着的、每分钟都有生物在走、一直有新生物刷出来、兜底一次都没用上`,
      o.maxFadeMs <= 2000 && o.overstay === 0 && !o.deadMinutes.length && o.spawned >= 20 && o.minEnts >= 3 && o.lifeFixes === 0 && o.entErrors === 0, o);
  }
  // 六、彩虹羊同一时间最多一只（以前每只羊 15%，平原的羊多、生物数量调高时常常一次出来好几只，30 个生物时最多 5 只）：
  // 让随机数一直抽中，在画面里排着生一排羊，看几只是彩虹的；那只没了以后下一只又能是。再白天 30 个生物快进 20 分钟，每秒数一次
  o = await ev(`(() => { const s = A.homeScene(); s.setOptions({ time: 'day' }); s.stop(); const eggs0 = s.opts.eggs; const mobs0 = s.opts.mobs; s.opts.eggs = true; s.ents = [];
    const rnd0 = s.rnd; s.rnd = () => 0.01; let now = performance.now() + 4e6;
    for (let i = 0; i < 16; i++) s.spawnMob('sheep', now, s.cam.x + 30 + i * Math.max(8, (s.W - 60) / 16));
    const sheep = s.ents.filter((e) => e.kind === 'sheep').length; const first = s.ents.filter((e) => e.jeb).length;
    for (const e of s.ents) if (e.jeb) e.dead = true;
    s.ents = s.ents.filter((e) => !e.dead);
    s.spawnMob('sheep', now, s.ents.length ? s.ents[0].x : s.cam.x + 40); const again = s.ents.filter((e) => e.jeb).length;
    s.rnd = rnd0; s.opts.mobs = 30; s.ents = []; s.nextSpawn = 0; let max = 0; let seen = 0;
    for (let sec = 0; sec < 20 * 60; sec++) { for (let i = 0; i < 30; i++) { now += 33; s.update(33, now); } const j = s.ents.filter((e) => e.jeb && !e.dead).length; max = Math.max(max, j); if (j) seen++; }
    s.opts.eggs = eggs0; s.opts.mobs = mobs0; s.start();
    return { sheep, first, again, max, secondsWithRainbow: seen }; })()`, 300000);
  check('彩虹羊', '同一时间最多一只彩虹羊：随机数一直抽中时一排羊里只有 1 只是彩虹的，它没了以后下一只又能是；30 个生物快进 20 分钟最多 1 只，也确实出现过', o.sheep >= 6 && o.first === 1 && o.again === 1 && o.max === 1 && o.secondsWithRainbow > 0, o);

  // 七、设置里的时段不认识（手改坏了的 config.json）：按现在的时间算。以前原样返回，天空配色查不到，主页背景建到一半出错、什么都不画
  o = await ev(`(() => { const K = A.sceneKit; const ok = ['dawn', 'day', 'sunset', 'night'];
    const bad = [5, 'x', null, {}, [], true, 'noon', 'auto', undefined, ''].map((v) => K.periodFor(v));
    const same = ok.map((v) => K.periodFor(v));
    return { bad, badOk: bad.every((p) => ok.includes(p)), same: same.join() === ok.join() }; })()`);
  check('时段', '不认识的时段（数字、空的、拼错的）按现在的时间算，认识的四个照原样', o.badOk && o.same, o);

  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  await a.stop();

  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
