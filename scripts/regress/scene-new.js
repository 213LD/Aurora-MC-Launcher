'use strict';
/**
 * 主页场景新加的三样（2026-11-07，rc1 之前补上的）：远古城市和深暗之域、繁茂洞穴的水塘和美西螈、雪山上的山羊。
 *   node scripts/regress/scene-new.js        关在隔离层里，真实窗口
 * 把视角挪过去、让它们生成，查位置合不合理（生物不能生成在岩浆、积水里），截图存到 AURORA_REGRESS_DIR/scene-new
 */
const fs = require('fs');
const path = require('path');
const { start, BASE_CONFIG } = require('./robust-ui');
const { sleep, guard, ready, until, calm, FIX_WORLD } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'scene-new');
const results = [];
guard(results, 'scene-new'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 500)}` : ''}`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // 截图时只看场景：画布提到最上面，挡着的弹窗、提示都去掉
  const shot = async (a, name) => {
    await a.ev("(() => { document.querySelectorAll('.modal-back, .toast, .toasts').forEach((m) => m.remove()); const c = A.homeScene().canvas || document.querySelector('canvas'); Object.assign(c.style, { position: 'fixed', inset: '0', zIndex: '99999' }); return 1; })()");
    await calm(a.ev);
    const r = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const bg = { type: 'scene', scene: 'plains', fx: 'high', fps: 30, mobs: 12, animals: true, monsters: true, aquatic: true, players: false, buildings: false, pan: true, eggs: false };
  const a = await start('scene-new', { config: (game) => ({ ...BASE_CONFIG(game), migrateAsk: false, background: bg }) });
  if (a.startError) { check('场景', '能打开', false, a.startError); process.exit(1); }
  await ready(a.ev);
  await a.ev(FIX_WORLD); // 主页的世界不跟着日期、窗口高度变（cdp.js）
  // 视角挪到某处：x、y 是方块的列、行
  const go = (c, r) => a.ev(`(() => { const s = A.homeScene(); const B = s.B; const x = ${c} * B - s.W / 2; const y = ${r} * B - s.H / 2; Object.assign(s.cam, { x, tx: x, y, ty: y }); s.ensureChunks && s.ensureChunks(true); return 1; })()`);
  // 挪了镜头：等场景在新位置真的往前画了 0.6 秒（场景时间，机器忙的时候自然等得久）
  const drawn = async () => { const t0 = await a.ev('A.homeScene().t'); return until(a.ev, `A.homeScene().t - ${t0} > 600`, 15000); };

  // ── 远古城市 ──
  const city = await a.ev(`(() => { const s = A.homeScene(); for (let k = 0; k < 120; k++) { const reg = k % 2 ? -((k + 1) >> 1) : k >> 1; const x = s.structsOf(reg).find((t) => t.ancient); if (x) return { c0: x.c0, c1: x.c1, fr: x.fr, r0: x.r0, reg }; } return null; })()`);
  check('远古城市', '平原底下找得到远古城市', !!city, city);
  if (city) {
    await go((city.c0 + city.c1) / 2, city.fr - 6);
    await drawn();
    await shot(a, 'ancient-city');
    // 让洞穴生物多刷几次：城市里只能有监守者
    const inCity = await a.ev(`(() => { const s = A.homeScene(); const now = performance.now(); for (let i = 0; i < 300; i++) s.caveSpawn(now); const B = s.B;
      return s.ents.filter((e) => e.cave && e.x / B >= ${city.c0} && e.x / B <= ${city.c1} && e.y / B >= ${city.r0} && e.y / B <= ${city.fr + 1}).map((e) => e.kind); })()`);
    check('远古城市', '原版深暗之域不刷生物：城市里最多只有一个监守者', inCity.filter((k) => k !== 'warden').length === 0 && inCity.filter((k) => k === 'warden').length <= 1, inCity);
    const cells = await a.ev(`(() => { const s = A.homeScene(); const out = {}; for (let c = ${city.c0}; c <= ${city.c1}; c++) for (let r = ${city.r0}; r <= ${city.fr + 1}; r++) { const cell = s.structCell(s.structsIn(c, c), c, r, null); const k = cell ? (cell.deco || (cell.cave ? 'air' : Object.keys(A.sceneKit.M).find((m) => A.sceneKit.M[m] === cell.mat))) : 'none'; out[k] = (out[k] || 0) + 1; } return out; })()`);
    check('远古城市', '有灵魂灯笼、幽匿感测体、尖啸体、地毯、箱子', ['soulLantern', 'sensor', 'shrieker', 'carpet', 'chest'].every((k) => cells[k] > 0), cells);
  }

  // ── 繁茂洞穴的水塘和美西螈 ──
  const pool = await a.ev(`(() => { const s = A.homeScene(); for (let c = -600; c < 600; c += 1) { for (let r = s.baseRow + 8; r < s.BOT - 14; r++) { if (s.caveBiome(c, r) === 'lush' && s.lushPoolAt(c, r, null) && !s.lushPoolAt(c, r - 1, null)) return { c, r }; } } return null; })()`);
  check('繁茂洞穴', '找得到繁茂洞穴里的水塘', !!pool, pool);
  if (pool) {
    await go(pool.c, pool.r - 3);
    await drawn();
    const ax = await a.ev(`(() => { const s = A.homeScene(); const now = performance.now(); const B = s.B; const c0 = Math.floor(s.cam.x / B); const c1 = Math.floor((s.cam.x + s.W) / B); const r0 = Math.floor(s.cam.y / B); const r1 = Math.floor((s.cam.y + s.H) / B);
      for (let i = 0; i < 40; i++) s.axolotlSpawn(now, c0, c1, r0, r1);
      return s.ents.filter((e) => e.spr.axolotl).map((e) => ({ k: e.kind, inWater: s.fluidAt(Math.floor((e.x + e.spr.w / 2) / B), Math.floor((e.y - 1) / B)) === 'water' })); })()`);
    check('繁茂洞穴', '美西螈生成了，全在水里', ax.length > 0 && ax.every((x) => x.inWater), ax);
    await sleep(6000); // pitfall-ok：看美西螈 6 秒里会不会游出水
    const still = await a.ev(`(() => { const s = A.homeScene(); const B = s.B; return s.ents.filter((e) => e.spr.axolotl).map((e) => s.fluidAt(Math.floor((e.x + e.spr.w / 2) / B), Math.floor((e.y - 1) / B)) === 'water'); })()`);
    check('繁茂洞穴', '游了 6 秒还在水里，不上岸', still.length > 0 && still.every(Boolean), still);
    const clay = await a.ev(`(() => { const s = A.homeScene(); let r = ${pool.r}; while (s.lushPoolAt(${pool.c}, r, null)) r++; const top = s.colHeight(${pool.c}); const cell = s.cellAt(${pool.c}, r, top, 0);
      return { r, key: cell && Object.keys(A.sceneKit.M).find((k) => A.sceneKit.M[k] === cell.mat), bio: s.caveBiome(${pool.c}, r), solid: s.rawSolid(${pool.c}, r, null) }; })()`);
    check('繁茂洞穴', '水塘底下是黏土', clay.key === 'clay', clay);
    await shot(a, 'lush-pool');
    // 洞里其他生物不生成在水塘里
    const wet = await a.ev(`(() => { const s = A.homeScene(); const now = performance.now(); for (let i = 0; i < 200; i++) s.caveSpawn(now); const B = s.B; return s.ents.filter((e) => e.cave && !e.spr.axolotl && !e.spr.fly && s.fluidAt(Math.floor((e.x + 1) / B), Math.floor((e.y - 1) / B))).map((e) => e.kind); })()`);
    check('繁茂洞穴', '僵尸、骷髅这些不生成在水塘里', wet.length === 0, wet);
  }

  // ── 雪山上的山羊 ──
  const peak = await a.ev(`(() => { const s = A.homeScene(); for (let k = 0; k < 4000; k += 2) { for (const x of [k * s.B, -k * s.B]) if (s.alpineAt(x)) return { x, c: Math.floor(x / s.B), top: s.colHeight(Math.floor(x / s.B)) }; } return null; })()`);
  check('山羊', '平原两边找得到雪山的高处', !!peak, peak);
  if (peak) {
    await go(peak.c, peak.top - 4);
    await drawn();
    const goats = await a.ev(`(() => { const s = A.homeScene(); const now = performance.now(); for (let i = 0; i < 30; i++) s.spawnMob('goat', now); return s.ents.filter((e) => e.kind === 'goat').map((e) => s.alpineAt(e.x)); })()`);
    check('山羊', '生成了，全在雪山的高处', goats.length > 0 && goats.every(Boolean), goats);
    await sleep(8000); // pitfall-ok：看山羊 8 秒里会不会走下山
    const after = await a.ev(`(() => { const s = A.homeScene(); return s.ents.filter((e) => e.kind === 'goat' && !e.dead).map((e) => s.alpineAt(e.x) && Math.abs(e.y - s.groundY(e.x)) < s.B * 3); })()`);
    check('山羊', '走了 8 秒：还在高处，脚踩在地上', after.length > 0 && after.every(Boolean), after);
    await shot(a, 'goats');
    const flat = await a.ev(`(() => { const s = A.homeScene(); let n = 0; for (let x = s.cam.x - 2000; x < s.cam.x + 2000; x += 8) if (!s.mountK || s.colHeight(Math.floor(x / s.B)) >= s.baseRow - 12) n += s.alpineAt(x) ? 1 : 0; return n; })()`);
    check('山羊', '平地上不算雪山高处（不会生成在平原上）', flat === 0, flat);
  }
  const snowy = await a.ev("(() => { const s = A.homeScene(); return s.sceneId; })()");
  check('场景', '页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
  void snowy;
  await a.stop();
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}；截图在 ${SHOTS}`);
  process.exit(bad ? 1 : 0);
})();
