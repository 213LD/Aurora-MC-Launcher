'use strict';
/**
 * 分层检查（2.0.0-pre1，重构方案）：2.0.0-pre9 起拦截（npm test 里跑 --strict）。引擎在 src/main/engine，功能在 src/main/core，界面底层在 src/renderer/js/base。
 * 三层：引擎（不依赖任何功能和界面）→ 功能 → 界面。查这些越层：
 *   1. 引擎 require 了功能
 *   2. 主进程的功能 require 了 ipc.js（只能 ipc 调功能）
 *   3. src/shared require 了 src/main 或 src/renderer
 *   4. 界面底层（core.js、ui.js、translate*.js）用了别的文件才定义的 A.xxx
 *   5. 一个页面直接用了另一个页面（A.pages.xxx）
 * 用法：node scripts/layer-check.js [--json] [--strict（有越层就返回 1）]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => f.endsWith('.js'));

// 主进程的引擎：不知道任何功能。config 和 paths 是存储，net、downloader、mirrors 是下载，tasks 是任务，gamelock 是占用判断
const isEngine = (f) => f.startsWith('src/main/engine/');
// 界面底层：所有页面都依赖它们，它们不能反过来依赖页面
const UI_BASE = ['src/renderer/js/base/core.js', 'src/renderer/js/base/ui.js', 'src/renderer/js/base/translate.js', 'src/renderer/js/base/translate-load.js'];

function requiresOf(file) {
  const src = read(file);
  const out = [];
  for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    let to = path.resolve(path.dirname(file), m[1]);
    if (!to.endsWith('.js')) to = fs.existsSync(`${to}.js`) ? `${to}.js` : path.join(to, 'index.js');
    out.push(rel(to));
  }
  return out;
}

const problems = [];
const add = (kind, from, to) => problems.push({ kind, from, to });

// 主进程
const main = walk(path.join(ROOT, 'src', 'main')).filter((f) => !rel(f).startsWith('src/main/devshot'));
let featureToFeature = 0;
for (const f of main) {
  const from = rel(f);
  const inCore = from.startsWith('src/main/core/');
  for (const to of requiresOf(f)) {
    if (isEngine(from) && to.startsWith('src/main/') && !isEngine(to)) add('引擎依赖功能', from, to);
    if (inCore && (to === 'src/main/ipc.js' || to.startsWith('src/main/ipc/'))) add('功能依赖 ipc', from, to);
    if (inCore && to.startsWith('src/main/core/')) featureToFeature++;
  }
}
// 共享代码
for (const f of walk(path.join(ROOT, 'src', 'shared'))) {
  for (const to of requiresOf(f)) if (to.startsWith('src/main/') || to.startsWith('src/renderer/')) add('共享代码依赖主进程或界面', rel(f), to);
}
// 渲染进程：谁定义了 A.xxx
const renderer = walk(path.join(ROOT, 'src', 'renderer', 'js'));
const definedIn = new Map();
const define = (name, file) => { if (!definedIn.has(name)) definedIn.set(name, new Set()); definedIn.get(name).add(file); };
for (const f of renderer) {
  const src = read(f);
  const file = rel(f);
  for (const m of src.matchAll(/\bA\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) define(m[1], file);
  for (const m of src.matchAll(/Object\.assign\(A,\s*\{([\s\S]*?)\}\s*\)/g)) for (const k of m[1].matchAll(/(?:^|[,\s])([A-Za-z_$][\w$]*)\s*(?=[,:(]|\s*$)/gm)) define(k[1], file);
}
// core.js 把一批东西直接放进 A（window.A = { ... }）
const coreSrc = read(path.join(ROOT, 'src', 'renderer', 'js', 'base', 'core.js'));
for (const m of coreSrc.matchAll(/^\s{4}([A-Za-z_$][\w$, :.]*),?\s*$/gm)) for (const k of m[1].split(',')) { const n = k.split(':')[0].trim(); if (n) define(n, 'src/renderer/js/base/core.js'); }
for (const b of UI_BASE) {
  const p = path.join(ROOT, b);
  if (!fs.existsSync(p)) continue;
  const used = new Set([...read(p).matchAll(/\bA\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const n of used) {
    const where = definedIn.get(n);
    if (where && !where.has(b) && ![...where].some((w) => UI_BASE.includes(w))) add('界面底层依赖上层', b, `A.${n}（${[...where][0]}）`);
  }
  // 直接点名某个页面（A.pages.home）也算依赖上层。pages 这个名字是 core.js 自己定义的，上面那条查不出来（rc9，变异实验发现）
  for (const m of read(p).matchAll(/\bA\.pages\.([A-Za-z_$][\w$]*)/g)) add('界面底层依赖上层', b, `A.pages.${m[1]}`);
}
// 页面拆成多个文件时（pages/planner/*.js）算同一个页面
const pageOf = (file) => {
  if (!file.startsWith('src/renderer/js/pages/')) return null;
  const parts = file.slice('src/renderer/js/pages/'.length).split('/');
  return parts.length > 1 ? parts[0] : path.basename(file, '.js');
};
for (const f of renderer) {
  const file = rel(f);
  const me = pageOf(file);
  if (!me) continue;
  for (const m of read(f).matchAll(/\bA\.pages\.([A-Za-z_$][\w$]*)/g)) if (m[1] !== me) add('页面直接用另一个页面', file, `A.pages.${m[1]}`);
}

const seen = new Set();
const unique = problems.filter((p) => { const k = `${p.kind}|${p.from}|${p.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
const kinds = {};
for (const p of unique) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
const report = { total: unique.length, kinds, featureToFeature, problems: unique };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`分层检查：越层 ${unique.length} 处`);
  for (const [k, n] of Object.entries(kinds)) console.log(`  ${k}：${n}`);
  console.log(`  （功能之间直接 require ${featureToFeature} 处：允许，功能之间通过函数接口调用）`);
  if (process.argv.includes('--list')) for (const p of unique) console.log(`  [${p.kind}] ${p.from} → ${p.to}`);
}
process.exitCode = process.argv.includes('--strict') && unique.length ? 1 : 0;
