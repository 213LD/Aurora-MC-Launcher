'use strict';
/**
 * rc6 这一轮（试用 rc5 时发现，2026-11-12）：主页背景流动的水和岩浆
 *   node scripts/regress/rc6-ui.js
 * 一、往下落的水一格一格地画，看着像切开的：地下水竖着一整面断开时，每一行都各流出去一次，同一列叠了一摞薄水。
 *     现在只从最上面那一行流，落下的按列连成一整段画（截图放大看）
 * 二、源头在画面外时拉窗口大小，流动会变：算的时候要看旁边的区块，区块生成的多少、先后不同，结果就不同。
 *     现在只看世界本身：换区块生成顺序、换窗口宽度，流动完全一样。
 *     窗口高度变了以前地表、海平面也跟着变（起伏按窗口高度算）：现在地形尺度在打开场景时定下来，拉窗口只整体上下挪，
 *     每个场景都比一遍地表、每一格方块、结构、流动、开局的房子
 * 截图在 AURORA_REGRESS_DIR/rc6-ui
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG } = require('./robust-ui');
const { sleep, guard, ready } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'rc6-ui');
const results = [];
guard(results, 'rc6-ui'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 600)}` : ''}`);
}
async function shot(a, name) {
  const r = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}
const BG = { type: 'scene', scene: 'plains', time: 'day', fx: 'high', fps: 30, mobs: 0, animals: false, monsters: false, aquatic: false, players: false, buildings: true, pan: true, eggs: false };

// 页面里用的小工具：流动的「指纹」（行号按基准地面算，窗口高度变了也能比）、按指定顺序重新生成区块
const KIT = `
  const s = A.homeScene();
  const sig = () => { const out = new Map(); for (const [k, f] of s._flows || []) {
    const m = k.match(/^([fo])(-?\\d+),(-?\\d+)(?:,(-?\\d+))?$/); const src = m[1] + m[2] + ',' + (m[3] - s.baseRow) + (m[4] ? ',' + m[4] : '');
    const cells = [...f.cells.values()].map((x) => x.c + ',' + (x.r - s.baseRow) + x.t[0] + x.lvl).sort().join(';');
    const t = [...f.touch.values()].map((x) => x.c + ',' + (x.r - s.baseRow) + x.mat[0]).sort().join(';');
    out.set(src, cells + '|' + t); } return out; };
  const regen = (order) => { s.chunks = new Map(); s._flows = null; s._flowCells = null; s._flowDraw = null; for (const ci of order) if (!s.chunks.has(ci)) s.genChunk(ci); };
  const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
  const shuffle = (arr, seed) => { const o = arr.slice(); let x = seed; for (let i = o.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  const diff = (m1, m2) => { let same = 0; const bad = []; for (const [k, v] of m1) { if (!m2.has(k)) continue; if (m2.get(k) === v) same++; else bad.push(k); } return { same, bad: bad.length, ex: bad.slice(0, 3), only1: [...m1.keys()].filter((k) => !m2.has(k)).length, only2: [...m2.keys()].filter((k) => !m1.has(k)).length }; };
`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const a = await start('rc6-ui', { config: (game) => ({ ...BASE_CONFIG(game), background: BG }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  await ready(a.ev);
  const ev = (code, t = 30000) => a.ev(code, t);

  // ── 一、换区块生成的先后顺序：流动完全一样 ──
  let o = await ev(`(async () => { ${KIT}
    const keep = s.seed; const out = [];
    for (let k = 0; k < 6; k++) {
      s.seed = 30100 + k * 17; s.build();
      regen(range(-30, 30)); const a1 = sig();
      regen(range(-30, 30).reverse()); const a2 = sig();
      regen(shuffle(range(-30, 30), 7 + k)); const a3 = sig();
      out.push({ seed: s.seed, n: a1.size, rev: diff(a1, a2), mix: diff(a1, a3) });
    }
    s.seed = keep; s.build(); return out; })()`, 600000);
  const orderOk = o.every((x) => x.n > 5 && x.rev.bad === 0 && x.rev.only1 === 0 && x.rev.only2 === 0 && x.mix.bad === 0 && x.mix.only1 === 0 && x.mix.only2 === 0);
  check('流动', '区块从左往右、从右往左、打乱顺序生成，算出来的流动完全一样（6 个世界）', orderOk, o.map((x) => ({ seed: x.seed, n: x.n, rev: x.rev.bad + x.rev.only1 + x.rev.only2, mix: x.mix.bad + x.mix.only1 + x.mix.only2, ex: x.rev.ex.concat(x.mix.ex) })));

  // ── 一（续）、拉窗口：宽度变了流动不变；高度变了地下跟着上下挪，流动按基准地面算也不变 ──
  o = await ev(`(async () => { ${KIT}
    const keep = s.seed; const W0 = s.W0; const H0 = s.H0; const out = [];
    for (let k = 0; k < 4; k++) {
      const seed = 30100 + k * 17;
      s.seed = seed; s.applySize(W0, H0); regen(range(-30, 30)); const a1 = sig(); const b1 = s.baseRow;
      s.seed = seed; s.applySize(Math.round(W0 * 0.55), H0); regen(range(-30, 30)); const a2 = sig();
      s.seed = seed; s.applySize(Math.round(W0 * 1.3), Math.round(H0 * 0.7)); regen(range(-30, 30)); const a3 = sig(); const b3 = s.baseRow;
      out.push({ seed, n: a1.size, narrow: diff(a1, a2), short: diff(a1, a3), base: [b1, b3] });
    }
    s.seed = keep; s.applySize(W0, H0); return out; })()`, 600000);
  check('流动', '窗口变窄：流动完全一样', o.every((x) => x.n > 5 && x.narrow.bad === 0 && x.narrow.only1 === 0 && x.narrow.only2 === 0), o.map((x) => ({ seed: x.seed, n: x.n, d: x.narrow })));
  check('流动', '窗口变宽变矮（地下整体上移）：按基准地面算，流动完全一样', o.every((x) => x.n > 5 && x.short.bad === 0 && x.short.only1 === 0 && x.short.only2 === 0), o.map((x) => ({ seed: x.seed, n: x.n, d: x.short, base: x.base })));

  // ── 一（续）、真的在画面里拉窗口：画面外的源头流进画面的，前后一样 ──
  o = await ev(`(async () => { ${KIT}
    const keep = s.seed; let spot = null;
    for (let k = 0; k < 20 && !spot; k++) { s.seed = 30100 + k * 17; s.build(); regen(range(-30, 30)); for (const [key, f] of s._flows) { if (f.cells.size > 10 && f.c1 - f.c0 >= 6) { spot = { seed: s.seed, c: f.c0, r: f.r0, key }; break; } } }
    if (!spot) return { found: false };
    const B = s.B; const W0 = s.W0; const H0 = s.H0;
    // 源头在画面左边外面一点：画面左边缘对着流动的右半边
    const place = () => { s.cam.tx = s.cam.x = (spot.c + 6) * B; s.cam.ty = s.cam.y = (spot.r - 10) * B; s.ensureChunks(true); };
    s.seed = spot.seed; s.applySize(W0, H0); place(); const f1 = s._flows.get(spot.key); const v1 = f1 && [...f1.cells.keys()].sort().join(',');
    s.seed = spot.seed; s.applySize(Math.round(W0 * 0.5), H0); place(); const f2 = s._flows.get(spot.key); const v2 = f2 && [...f2.cells.keys()].sort().join(',');
    s.seed = spot.seed; s.applySize(Math.round(W0 * 0.3), H0); place(); const f3 = s._flows.get(spot.key); const v3 = f3 && [...f3.cells.keys()].sort().join(',');
    s.seed = keep; s.applySize(W0, H0);
    return { found: true, spot, has: [!!f1, !!f2, !!f3], same: v1 === v2 && v1 === v3 }; })()`, 300000);
  check('流动', '源头在画面外：窗口拉宽拉窄（原来的 50%、30%），流进画面的那段都算好了而且一样', o.found && o.has.every(Boolean) && o.same, o);

  // ── 一（续）、每个场景拉窗口（变矮、变窄变高）：按基准地面对齐，地表、每一格方块、结构、流动都一样 ──
  o = await ev(`(async () => {
    const s = A.homeScene(); const W0 = s.W0; const H0 = s.H0; const out = [];
    const cellSig = (cell) => { if (!cell) return '-'; const o = {}; for (const [k, v] of Object.entries(cell)) { if (typeof v === 'function') continue; o[k] = Array.isArray(v) ? v.length + ':' + v[0] : v; } return JSON.stringify(o); };
    const snap = () => {
      const top = []; const cells = []; const st = []; const fl = [];
      for (let ci = -12; ci <= 12; ci++) if (!s.chunks.has(ci)) s.genChunk(ci);
      for (let c = -180; c <= 180; c += 3) { const t = s.colHeight(c); top.push(t > 900 ? 'v' : t - s.baseRow); for (let d = -30; d < 100; d += 2) cells.push(cellSig(s.cellAtWorld(c, s.baseRow + d))); }
      for (let reg = -3; reg <= 3; reg++) for (const x of s.structsOf(reg)) st.push(x.type + '@' + x.c0 + ',' + (x.r0 - s.baseRow));
      for (const [k, f] of s._flows || []) fl.push(k.replace(/^([fo]-?\\d+),(-?\\d+)/, (m, p, r) => p + ',' + (r - s.baseRow)) + ':' + f.cells.size);
      return { top: top.join(), cells, st: st.sort().join(' '), fl: fl.sort().join(' '), houses: JSON.stringify((s.houses || []).map((h) => [h.col, h.ground - s.baseRow, h.kind])) };
    };
    const keep = [s.opts.scene, s.seed];
    for (const id of Object.keys(A.sceneKit.SCENES)) {
      s.opts.scene = id;
      s.seed = 30100; s.camKey = null; s.applySize(W0, H0); const p = snap();
      s.seed = 30100; s.applySize(W0, Math.round(H0 * 0.7)); const q = snap();
      s.seed = 30100; s.applySize(Math.round(W0 * 0.6), Math.round(H0 * 1.25)); const r = snap();
      const bad = [];
      for (const [name, x] of [['矮', q], ['窄高', r]]) {
        if (x.top !== p.top) bad.push(name + '地表'); if (x.st !== p.st) bad.push(name + '结构'); if (x.fl !== p.fl) bad.push(name + '流动'); if (x.houses !== p.houses) bad.push(name + '房子');
        const diff = x.cells.filter((v, i) => v !== p.cells[i]).length; if (diff) bad.push(name + '方块' + diff);
      }
      out.push({ id, bad });
    }
    s.opts.scene = keep[0]; s.seed = keep[1]; s.camKey = null; s.applySize(W0, H0); return out; })()`, 900000);
  check('世界', '每个场景拉窗口（变矮、变窄变高）：按基准地面对齐，地表、每一格方块、结构、流动、开局的房子都一样', o.length >= 10 && o.every((x) => x.bad.length === 0), o.filter((x) => x.bad.length));

  // 拉窗口时镜头：平移到地下时跟着世界一起挪（看着的还是同一块）；在地面视角时不动
  o = await ev(`(async () => { const s = A.homeScene(); const W0 = s.W0; const H0 = s.H0; const B = s.B;
    s.opts.scene = 'plains'; s.seed = 30100; s.camKey = null; s.applySize(W0, H0);
    const home0 = [s.cam.x, s.cam.y]; s.applySize(W0, Math.round(H0 * 0.7)); const home1 = [s.cam.x, s.cam.y];
    s.applySize(W0, H0); s.cam.tx = s.cam.x = 40 * B; s.cam.ty = s.cam.y = (s.baseRow + 30) * B;
    const row0 = s.cam.y / B - s.lift; const cell0 = JSON.stringify(s.cellAtWorld(50, Math.floor(s.cam.y / B) + 5));
    s.applySize(W0, Math.round(H0 * 0.7)); const row1 = s.cam.y / B - s.lift; const cell1 = JSON.stringify(s.cellAtWorld(50, Math.floor(s.cam.y / B) + 5));
    s.applySize(Math.round(W0 * 1.2), Math.round(H0 * 1.3)); const row2 = s.cam.y / B - s.lift;
    s.camHome(); s.applySize(W0, H0); return { home0, home1, rows: [row0, row1, row2], same: cell0 === cell1 }; })()`, 120000);
  check('世界', '拉窗口时：在地面视角镜头不动；平移到地下时镜头跟着世界挪，看着的还是同一块', o.home0[1] === 0 && o.home1[1] === 0 && o.rows[0] === o.rows[1] && o.rows[0] === o.rows[2] && o.same, o);

  // ── 二、竖着一整面的开口只流一次；同一格不叠两层；落下的连成整段 ──
  o = await ev(`(async () => { ${KIT}
    const keep = s.seed; const out = { flows: 0, stacked: 0, layerOnFall: 0, runs: 0, longRuns: 0, edges: 0, edgeOutlets: 0, spot: null };
    for (let k = 0; k < 6; k++) {
      s.seed = 30100 + k * 17; s.build(); regen(range(-30, 30));
      out.flows += s._flows.size;
      s._flowDraw = null; s.drawFlows(0, 0); const d = s._flowDraw;
      const K = (c, r) => c * 16384 + r;
      for (const x of d.layers.values()) { if (d.layers.has(K(x.c, x.r + 1))) out.stacked++; if (d.falls[x.kind].has(K(x.c, x.r))) out.layerOnFall++; }
      for (const r of d.runs) { out.runs++; if (r.r1 - r.r0 >= 6) out.longRuns++; }
      // 竖着一整面的开口（同一列连着 3 行以上都朝同一边敞开）：只有最上面那行是出水口
      for (const key of s._flows.keys()) {
        const m = key.match(/^o(-?\\d+),(-?\\d+),(-?\\d+)$/); if (!m) continue;
        const c = +m[1]; const r = +m[2]; const dd = +m[3];
        if (s._flows.has('o' + c + ',' + (r - 1) + ',' + dd)) out.edgeOutlets++;
        if (s._flows.has('o' + c + ',' + (r + 1) + ',' + dd)) continue;
        const fl = (cc, rr) => s.fluidAt(cc, rr); let n = 0; while (n < 12 && fl(c, r + n + 1) && !s.solidAt(c + dd, r + n + 1)) n++;
        if (n >= 3) { out.edges++; if (!out.spot) { const run = d.runs.find((x) => x.c === c + dd && x.r0 <= r + 2 && x.r1 >= r + 4); if (run) out.spot = { seed: s.seed, c, r }; } }
      }
    }
    s.seed = keep; s.build(); return out; })()`, 600000);
  check('流动', '同一格只画一层：落着的格子不画淌开的薄层，淌开的薄层不上下叠', o.layerOnFall === 0 && o.stacked === 0 && o.runs > 20, o);
  check('流动', '竖着一整面的开口只从最上面一行流出去（上下相邻的出水口没有了）', o.edgeOutlets === 0 && o.edges > 0, o);

  // 截图：竖着一整面的开口、普通瀑布落地往两边淌（放大 2.5 倍，看水流是不是一整道）
  // 只取场景画布（不带界面、弹窗），放大 4 倍（像素不糊）
  const look = async (spot, name) => {
    const url = await ev(`(async () => { const s = A.homeScene(); s.seed = ${spot.seed}; s.build(); s.zoomAt = [0.5, 0.5]; s.zoomT = 2.5; s.applyZoom(2.5); const B = s.B;
      s.cam.tx = s.cam.x = ${spot.c} * B - s.W / 2; s.cam.ty = s.cam.y = ${spot.r} * B - s.H / 3; s.ensureChunks(true); await new Promise((r) => setTimeout(r, 1500));
      const src = s.canvas; const big = document.createElement('canvas'); big.width = src.width * 4; big.height = src.height * 4;
      const g = big.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, big.width, big.height); return big.toDataURL('image/png'); })()`, 60000);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(String(url).split(',')[1], 'base64'));
  };
  if (o.spot) await look(o.spot, '竖着的开口流下来');
  else check('截图', '找到竖着一整面开口的地方', false, o);
  const fall = await ev(`(async () => { ${KIT} for (let k = 0; k < 6; k++) { s.seed = 30100 + k * 17; s.build(); regen(range(-30, 30)); for (const [key, f] of s._flows) if (key[0] === 'f' && f.cells.size > 12 && f.r1 - f.r0 >= 4) return { seed: s.seed, c: Math.round((f.c0 + f.c1) / 2), r: f.r0 }; } return null; })()`, 300000);
  if (fall) await look(fall, '瀑布落地往两边淌');

  // 每帧画流动花多少时间（画面里有流动的时候）
  o = await ev(`(async () => { const s = A.homeScene(); const t0 = performance.now(); for (let i = 0; i < 300; i++) s.drawFlows(-s.cam.x, -s.cam.y); return { ms: (performance.now() - t0) / 300, n: s._flowDraw ? s._flowDraw.runs.length : 0 }; })()`, 60000);
  check('性能', '每帧画流动不到 1 毫秒', o.ms < 1, o);
  await ev('(async () => { const s = A.homeScene(); s.camHome(); })()');
  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  await a.stop();

  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}；截图在 ${SHOTS}`);
  process.exit(bad ? 1 : 0);
})();
