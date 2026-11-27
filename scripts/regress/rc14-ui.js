'use strict';
/**
 * rc14 这一轮（用户试用 rc13 时提的两件事）：
 *   node scripts/regress/rc14-ui.js
 * 一、主页生物原地卡住（频繁拉窗口以后，迈着步子却不动）：
 *   - 拉窗口时生物跟着世界一起上下挪：鱼还在水里、洞里的生物还在洞里（以前留在旧的高度，鱼被清掉、洞里的全去掉）
 *   - 被去掉的生物，别的生物不再盯着、跟着它（以前怪会一直追一个已经不在的玩家）
 *   - 「迈着步子」20 秒没挪地方的，打架、盯着猎物的也算卡住，慢慢消失
 *   - 一个生物更新出错只去掉它自己，别的照常动（以前一个出错，整个背景每帧都在同一处出错）
 * 二、第一次切到游戏配置页慢：方块图标生成改快（逐像素和以前一样）、启动后空闲时预热字体
 * 截图在 AURORA_REGRESS_DIR/rc14-ui
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG } = require('./robust-ui');
const { guard, until, ready, sleep } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'rc14-ui');
const results = [];
guard(results, 'rc14-ui');
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const BG = { type: 'scene', scene: 'ocean', time: 'day', fx: 'high', fps: 30, mobs: 0, animals: false, monsters: false, aquatic: false, players: false, buildings: true, pan: true, eggs: false };

// 方块图标的指纹（rc14 改写生成方法以前的结果；改写后逐像素一样）
const ICON_HASH = process.env.AURORA_PRINT_ICON_HASH ? null : require('./rc14-icons.json');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const a = await start('rc14-ui', { config: (game) => ({ ...BASE_CONFIG(game), background: BG }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  const ev = (code, t = 60000) => a.ev(code, t);
  await ready(ev);
  await ev("document.querySelectorAll('.modal-back').forEach((m) => m.remove()); 1");

  // 改窗口大小：等场景按新大小重建完（防抖 250 毫秒以后）
  const resizeTo = async (w, h) => {
    const before = await ev('JSON.stringify([A.homeScene().W0, A.homeScene().H0])');
    await a.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await until(ev, `JSON.stringify([A.homeScene().W0, A.homeScene().H0]) !== ${JSON.stringify(before)}`, 8000);
    await sleep(100); // pitfall-ok：重建是在防抖的定时器里做的，W0 变了以后同一个任务里还要放回生物，等它跑完
  };

  // ── 一、拉窗口：鱼还在水里，跟着世界挪 ──
  await resizeTo(1200, 760);
  let o = await ev(`(() => { const s = A.homeScene(); const B = s.B; const now = performance.now();
    s.stop(); s.ents = []; const fish = [];
    for (let c = Math.floor(s.cam.x / B) + 6; c < Math.floor((s.cam.x + s.W) / B) - 6 && fish.length < 6; c += 4) {
      const top = s.colHeight(c); if (!(top > s.sea + 6 && top < 900)) continue;
      const e = s.mkEnt('cod', c * B + 1, Math.round((s.sea + (top - s.sea) / 2) * B), now, { alpha: 1, life: 1e9, state: 'idle', until: now + 1e9 }); fish.push(e);
    }
    window.__fish = fish; return { n: fish.length, rel: fish.map((e) => e.y - s.lift * B), lift: s.lift }; })()`);
  const fish0 = o;
  await resizeTo(1200, 540); // 变矮：世界往上挪
  await resizeTo(1200, 900); // 变高：世界往下挪
  o = await ev(`(() => { const s = A.homeScene(); const B = s.B; const set = new Set(s.ents);
    return { kept: window.__fish.filter((e) => set.has(e)).length, rel: window.__fish.map((e) => e.y - s.lift * B), lift: s.lift,
      inWater: window.__fish.filter((e) => s.isWaterCol(e.x) && e.y > s.sea * B && e.y <= s.colHeight(Math.floor((e.x + e.spr.w / 2) / B)) * B).length }; })()`);
  check('拉窗口', '窗口变矮再变高：鱼一条都没被清掉，还在水里，在世界里的高度没变', fish0.n >= 3 && o.kept === fish0.n && o.inWater === fish0.n && o.rel.every((v, i) => Math.abs(v - fish0.rel[i]) < 0.01) && o.lift !== fish0.lift, { before: fish0, after: o });

  // 洞里的生物：拉窗口以后还在，在世界里的位置没变
  await ev(`(() => { const s = A.homeScene(); s.setOptions({ scene: 'plains', monsters: true }); return 1; })()`);
  await resizeTo(1200, 760);
  o = await ev(`(() => { const s = A.homeScene(); const B = s.B; const now = performance.now(); s.stop(); s.ents = [];
    let spot = null;
    for (let c = 0; c < 200 && !spot; c++) for (let r = s.baseRow + 12; r < s.BOT - 14 && !spot; r++) {
      if (!s.rawSolid(c, r) && s.rawSolid(c, r + 1) && !s.rawSolid(c + 1, r) && s.rawSolid(c + 1, r + 1) && !s.fluidAt(c, r) && !s.rawSolid(c, r - 1)) spot = [c, r];
    }
    if (!spot) return { found: false };
    const e = s.mkEnt('zombie', spot[0] * B, (spot[1] + 1) * B, now, { cave: true, alpha: 1, life: 1e9, state: 'idle', until: now + 1e9 });
    s.cam.tx = s.cam.x = (spot[0] - 20) * B; s.cam.ty = s.cam.y = (spot[1] - 15) * B; s.ensureChunks(true);
    window.__caveMob = e; return { found: true, rel: [e.x, e.y - s.lift * B], lift: s.lift }; })()`);
  const cave0 = o;
  await resizeTo(1200, 560);
  o = await ev(`(() => { const s = A.homeScene(); const e = window.__caveMob; return { kept: s.ents.includes(e), rel: [e.x, e.y - s.lift * s.B], lift: s.lift, floor: s.rawSolid(Math.floor((e.x + 1) / s.B), Math.floor(e.y / s.B)) }; })()`);
  check('拉窗口', '洞里的生物拉窗口以后还在，还站在原来那块洞底上', cave0.found && o.kept && Math.abs(o.rel[0] - cave0.rel[0]) < 0.01 && Math.abs(o.rel[1] - cave0.rel[1]) < 0.01 && o.floor && o.lift !== cave0.lift, { before: cave0, after: o });

  // ── 一、被去掉的生物：别人不再盯着它 ──
  o = await ev(`(() => { const s = A.homeScene(); const B = s.B; const now = performance.now(); s.ents = [];
    s.cam.tx = s.cam.x = 0; s.cam.ty = s.cam.y = 0; s.ensureChunks(true);
    let c = 20; while (c < 200 && (s.isWaterCol(c * B) || s.colHeight(c) !== s.colHeight(c + 6))) c++;
    const gy = s.groundY(c * B);
    const p = s.mkEnt('player', (c + 3) * B, gy, now, { alpha: 1, life: 1e9 });
    const z = s.mkEnt('zombie', c * B, gy, now, { alpha: 1, life: 1e9 });
    z.prey = p;
    p.y += s.H * 3; // 玩家「走远了」：同一列但离视野很远，这一帧被去掉（和拉窗口时被去掉一样，不是死了）
    for (let i = 0; i < 3; i++) s.update(33, now + 33 * (i + 1));
    return { playerGone: !s.ents.includes(p), prey: z.prey ? (s.ents.includes(z.prey) ? 'in' : 'ghost') : null }; })()`);
  check('不在的目标', '玩家被去掉以后，怪不再盯着这个已经不在场景里的玩家', o.playerGone && o.prey !== 'ghost', o);

  // ── 一、迈着步子却不动：打架、盯着猎物的也算卡住 ──
  o = await ev(`(() => { const s = A.homeScene(); const now = performance.now(); const p = { kind: 'player', x: 0, y: 0, spr: {}, dead: false };
    const z = { kind: 'zombie', x: 100, y: 0, state: 'fight', moving: true, prey: p, spr: {} };
    s.stuckCheck(z, z.x, now); s.stuckCheck(z, z.x, now + 10000); const at10 = !!z.fade; s.stuckCheck(z, z.x, now + 21000); // pitfall-ok：同上，只测判断
    const w = { kind: 'zombie', x: 100, y: 0, state: 'fight', moving: false, prey: p, spr: {} };  // 站着打的不算
    s.stuckCheck(w, w.x, now); s.stuckCheck(w, w.x, now + 21000);
    return { at10, walking: !!z.fade, standing: !!w.fade }; })()`); // pitfall-ok：这里只测「算不算卡住」的判断（假的生物不在场景里）；标上以后真的消失由 rc15-ui 看
  check('卡住', '盯着猎物「迈着步子」20 秒没挪地方的会消失；站着打的不算卡住', !o.at10 && o.walking && !o.standing, o);

  // ── 一、一个生物出错，别的照常动 ──
  o = await ev(`(() => { const s = A.homeScene(); const B = s.B; const now = performance.now(); s.ents = [];
    let c = 20; while (c < 200 && (s.isWaterCol(c * B) || s.colHeight(c) !== s.colHeight(c + 8))) c++;
    const bad = s.mkEnt('cow', c * B, s.groundY(c * B), now, { alpha: 1, life: 1e9 }); bad.spr = null; // 画不出来、更新必定出错
    const cow = s.mkEnt('cow', (c + 2) * B, s.groundY((c + 2) * B), now, { alpha: 1, life: 1e9, state: 'walk', dir: 1, until: now + 1e9 });
    const x0 = cow.x; const errs0 = s.entErrors || 0; let threw = null;
    try { for (let i = 0; i < 10; i++) s.update(33, now + 33 * (i + 1)); } catch (e) { threw = e.message; }
    return { threw, moved: +(cow.x - x0).toFixed(2), badGone: !s.ents.includes(bad), newErrors: (s.entErrors || 0) - errs0 }; })()`);
  check('出错', '一个生物更新出错：只去掉它自己，别的生物照常走', !o.threw && o.moved > 0.3 && o.badGone && o.newErrors === 1, o);

  // ── 二、游戏配置页：图标和以前一样，字体预热做完 ──
  // 比的是解码以后的像素（RGBA），不是 toDataURL 的字符串：同样的像素，换了显卡 / 软件渲染，PNG 编出来的字节就不一样，以前在别的电脑上一直报变了
  const icons = await ev(`(async () => { const out = {}; const fnv = (bytes) => { let h = 2166136261; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
    const pixels = (url, n) => new Promise((res, rej) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = n; c.height = n; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); res(g.getImageData(0, 0, n, n).data); }; img.onerror = () => rej(new Error('图标解码失败')); img.src = url; });
    // 半透明的边缘像素：画布按预乘存，显卡和软件渲染取整不一样（同一台电脑换了渲染方式也会变）。只比不透明像素的颜色和粗分的透明度
    const stable = (d) => { const o = []; for (let i = 0; i < d.length; i += 4) { o.push(d[i + 3] >> 4); if (d[i + 3] === 255) o.push(d[i], d[i + 1], d[i + 2]); } return o; };
    for (const k of ['grass', 'snapshot', 'old', 'fabric', 'quilt', 'forge', 'neoforge', 'optifine', 'liteloader', 'diamond', 'unknown']) for (const n of [32, 48, 64, 96]) out[k + ':' + n] = fnv(stable(await pixels(A.blockImage(k, n), n)));
    return out; })()`, 30000);
  if (!ICON_HASH) { fs.writeFileSync(path.join(__dirname, 'rc14-icons.json'), `${JSON.stringify(icons, null, 1)}\n`); console.log('  已写下图标指纹 rc14-icons.json'); }
  else {
    const diff = Object.keys(ICON_HASH).filter((k) => ICON_HASH[k] !== icons[k]);
    check('图标', '方块图标（11 种 × 4 个大小）和改写生成方法以前逐像素一样', diff.length === 0 && Object.keys(ICON_HASH).length === 44, diff.slice(0, 6));
  }
  const warmed = await until(ev, 'A.fontWarm && A.fontWarm.done', 20000);
  const left = await ev("document.querySelectorAll('.font-warm').length");
  check('字体', '启动后空闲时把字体预热完（20 秒内），临时元素删掉了', !!warmed && left === 0, { warmed, left });
  await a.send('Emulation.clearDeviceMetricsOverride');
  await ev('(() => { A.homeScene().start(); return 1; })()');
  check('页面', '没有页面错误（出错测试里故意弄坏的那一个除外）', a.errors.filter((x) => !/生物 cow（idle）更新出错/.test(x)).length === 0, a.errors.slice(0, 5));
  await a.stop();

  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
