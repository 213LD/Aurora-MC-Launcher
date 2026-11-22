'use strict';
/**
 * 标志：程序图标和侧边栏左上角按场景换的标志
 *   node scripts/regress/brand-ui.js
 * 一、文件：每个背景场景都有 3D 和 2D 两张；README 用的主标志和平原那张一模一样；程序图标的 ico 是按现在的标志画的、该有的大小都有
 * 二、真的换：在启动器里一个一个换场景，左上角跟着换、而且图真的读出来了；性能模式开了换 2D、关了换回来；背景不是场景时是橡树
 * 三、三种界面风格下大小对、看得见
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { start, BASE_CONFIG } = require('./robust-ui');
const { guard, until, ready } = require('./cdp');

const REPO = path.join(__dirname, '..', '..');
const results = [];
guard(results, 'brand-ui');
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const IMG = path.join(REPO, 'src', 'renderer', 'img', 'brand');

// ── 一、文件 ──
{
  const ico = fs.readFileSync(path.join(REPO, 'src', 'main', 'brand', 'icon.ico'));
  const n = ico.readUInt16LE(4); const sizes = []; const bad = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i; const w = ico[e] || 256; const len = ico.readUInt32LE(e + 8); const off = ico.readUInt32LE(e + 12);
    const png = ico.subarray(off, off + len);
    sizes.push(w);
    if (png.subarray(1, 4).toString() !== 'PNG' || png.readUInt32BE(16) !== w || png.readUInt32BE(20) !== w) bad.push(w);
  }
  check('程序图标', 'icon.ico 里 16、24、32、48、256 都有，每张都是那个大小的 PNG（Windows 标题栏、托盘、任务栏、桌面、大图标）', [16, 24, 32, 48, 256].every((s) => sizes.includes(s)) && !bad.length, { sizes, bad });
  const meta = JSON.parse(fs.readFileSync(path.join(REPO, 'src', 'main', 'brand', 'icon.json'), 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'docs', 'brand', 'aml-mark.svg'))).digest('hex');
  check('程序图标', 'icon.ico 是按现在的标志画的（改了 docs/brand/aml-mark.svg 要跑 npm run icons 重画）', meta.sha256 === sha, { recorded: meta.sha256.slice(0, 12), now: sha.slice(0, 12) });
  const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));
  check('主标志', 'README 用的 docs/brand/aml-mark.svg、aml-mark-2d.svg 和侧边栏平原那两张一模一样', same(path.join(REPO, 'docs', 'brand', 'aml-mark.svg'), path.join(IMG, 'scene-plains.svg')) && same(path.join(REPO, 'docs', 'brand', 'aml-mark-2d.svg'), path.join(IMG, 'scene-plains-2d.svg')));
}

(async () => {
  const a = await start('brand-ui', { config: (game) => ({ ...BASE_CONFIG(game), background: { type: 'scene', scene: 'plains', time: 'day', fx: 'high', fps: 30, mobs: 6, eggs: false } }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  const ev = (code, t = 60000) => a.ev(code, t);
  await ready(ev);
  await ev("document.querySelectorAll('.modal-back').forEach((m) => m.remove()); A.go('home'); 1");

  const scenes = await ev('Object.keys(A.sceneKit.SCENES)');
  const listed = await ev('A.brandLogo.SCENES');
  const missing = scenes.filter((s) => !listed.includes(s) || !fs.existsSync(path.join(IMG, `scene-${s}.svg`)) || !fs.existsSync(path.join(IMG, `scene-${s}-2d.svg`)));
  check('场景标志', `每个背景场景（${scenes.length} 个）都登记了、3D 和 2D 两张图都在（新加场景要先画标志）`, scenes.length >= 11 && !missing.length && listed.length === scenes.length, { missing, scenes: scenes.length, listed: listed.length });

  // 左上角现在显示的是哪张、读出来了没有
  const logo = '(() => { const i = document.getElementById(\'brandLogo\'); const r = i.getBoundingClientRect(); return { src: i.getAttribute(\'src\'), ok: i.complete && i.naturalWidth > 0, w: Math.round(r.width), h: Math.round(r.height), vis: getComputedStyle(i).visibility !== \'hidden\' && r.width > 0 }; })()';
  const waitLogo = async (want) => {
    try { await until(ev, `(() => { const i = document.getElementById('brandLogo'); return i.getAttribute('src') === ${JSON.stringify(want)} && i.complete && i.naturalWidth > 0; })()`, 15000, 100); } catch { /* 下面按结果报 */ }
    return ev(logo);
  };

  // 二、一个一个换场景
  const wrong = [];
  for (const s of scenes) {
    await ev(`A.setConfig({ background: { type: 'scene', scene: ${JSON.stringify(s)} } }).then(() => 1)`);
    const o = await waitLogo(`img/brand/scene-${s}.svg`);
    const built = await ev('A.homeScene() ? A.homeScene().sceneId : null');
    if (o.src !== `img/brand/scene-${s}.svg` || !o.ok || built !== s) wrong.push({ s, built, ...o });
  }
  check('场景标志', `换到每个场景（${scenes.length} 个），左上角都换成这个场景的标志，而且图真的读出来了`, !wrong.length, wrong.slice(0, 4));

  // 随机：标志跟着真正建出来的那个场景
  await ev("A.setConfig({ background: { type: 'scene', scene: 'random' } }).then(() => 1)");
  await until(ev, "A.homeScene() && A.homeScene().sceneId && A.homeScene().sceneId !== 'random'", 15000, 100).catch(() => {});
  const rnd = await ev('A.homeScene().sceneId');
  let o = await waitLogo(`img/brand/scene-${rnd}.svg`);
  check('场景标志', '背景选「随机」时，标志跟着真正建出来的那个场景', o.src === `img/brand/scene-${rnd}.svg` && o.ok, { scene: rnd, ...o });

  // 性能模式：换 2D，关了换回来
  await ev("A.setConfig({ background: { type: 'scene', scene: 'desert' } }).then(() => 1)");
  await waitLogo('img/brand/scene-desert.svg');
  await ev('A.setConfig({ perfMode: true }).then(() => 1)');
  const on = await waitLogo('img/brand/scene-desert-2d.svg');
  await ev('A.setConfig({ perfMode: false }).then(() => 1)');
  const off = await waitLogo('img/brand/scene-desert.svg');
  check('性能模式', '打开性能模式换成同一场景的 2D 版，关掉换回 3D', on.src === 'img/brand/scene-desert-2d.svg' && on.ok && off.src === 'img/brand/scene-desert.svg' && off.ok, { on, off });

  // 背景不是场景：橡树（和程序图标一样）
  await ev("A.setConfig({ background: { type: 'gradient' } }).then(() => 1)");
  const grad = await waitLogo('img/brand/scene-plains.svg');
  await ev('A.setConfig({ perfMode: true }).then(() => 1)');
  const grad2d = await waitLogo('img/brand/scene-plains-2d.svg');
  await ev('A.setConfig({ perfMode: false }).then(() => 1)');
  check('场景标志', '背景是纯色或图片时是橡树；性能模式下是橡树的 2D 版', grad.src === 'img/brand/scene-plains.svg' && grad.ok && grad2d.src === 'img/brand/scene-plains-2d.svg' && grad2d.ok, { grad, grad2d });

  // 三、三种界面风格下的大小（极光 34、经典紧凑 26、像素原版 24）
  await ev("A.setConfig({ background: { type: 'scene', scene: 'plains' } }).then(() => 1)");
  const sizes = {};
  for (const [style, want] of [['aurora', 34], ['compact', 26], ['pixel', 24]]) {
    await ev(`A.setConfig({ ui: { style: ${JSON.stringify(style)} } }).then(() => 1)`);
    await until(ev, `document.documentElement.dataset.style === ${JSON.stringify(style)} || ${JSON.stringify(style)} === 'aurora'`, 10000, 100).catch(() => {});
    o = await waitLogo('img/brand/scene-plains.svg');
    sizes[style] = { want, w: o.w, h: o.h, ok: o.ok && o.vis };
  }
  await ev("A.setConfig({ ui: { style: 'aurora' } }).then(() => 1)");
  check('界面风格', '三种界面风格下标志大小对（34 / 26 / 24）、读出来了、看得见', Object.values(sizes).every((x) => x.w === x.want && x.h === x.want && x.ok), sizes);

  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  await a.stop();

  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
