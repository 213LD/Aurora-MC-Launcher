'use strict';
/**
 * 覆盖率（2.0.0-pre8 之后，全面测试中优先级）：npm test 跑到了主进程代码的多少，列出没跑到的地方。只报告，不当关卡。
 *   node scripts/regress/coverage.js [输出文件] [--include-robust]
 * 用 NODE_V8_COVERAGE，只算主进程（src/main、src/shared）。界面代码靠界面回归和走查，这里不算。
 * 算法：V8 给的是字节范围，内层覆盖外层，一个字节在任何一个进程里跑到过就算跑到。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const dir = path.join(BASE, 'v8-coverage');
const outFile = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(BASE, 'coverage.txt');

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const args = [path.join(__dirname, 'run.js')];
const r = spawnSync(process.execPath, args, { env: { ...process.env, NODE_V8_COVERAGE: dir, AURORA_REGRESS_DIR: BASE }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const tail = `${r.stdout || ''}`.split(/\r?\n/).filter((l) => /^共 /.test(l)).pop();
console.log(`  npm test：${tail || '没有结果'}`);

const roots = [path.join(REPO, 'src', 'main'), path.join(REPO, 'src', 'shared')];
const files = new Map();
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !/tr-(zh|en)/.test(e.name)) files.set(pathToFileURL(p).href.toLowerCase(), { p, text: fs.readFileSync(p, 'utf8'), covered: null });
  }
};
roots.forEach(walk);

let reports = 0;
for (const f of fs.readdirSync(dir)) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  reports++;
  for (const s of data.result || []) {
    const entry = files.get(String(s.url).toLowerCase());
    if (!entry) continue;
    const here = new Uint8Array(entry.text.length + 256);
    // 函数和块是嵌套给的：先大后小，小的盖住大的
    const ranges = [];
    for (const fn of s.functions) for (const g of fn.ranges) ranges.push(g);
    ranges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
    for (const g of ranges) here.fill(g.count > 0 ? 1 : 0, g.startOffset, Math.min(g.endOffset, here.length));
    if (!entry.covered) entry.covered = new Uint8Array(here.length);
    for (let i = 0; i < here.length; i++) entry.covered[i] |= here[i];
  }
}

const rows = [];
let allBytes = 0;
let allHit = 0;
for (const e of files.values()) {
  const lines = e.text.split('\n');
  let pos = 0;
  let total = 0;
  let hit = 0;
  const missed = [];
  lines.forEach((l, i) => {
    const code = l.trim();
    const isCode = code && !/^(\/\/|\*|\/\*|\}|\{|\);?$|\]\;?$)/.test(code);
    if (isCode) {
      total++;
      const at = pos + l.search(/\S/);
      if (e.covered && e.covered[at]) hit++;
      else missed.push(i + 1);
    }
    pos += l.length + 1;
  });
  allBytes += total;
  allHit += hit;
  rows.push({ file: path.relative(REPO, e.p).split(path.sep).join('/'), total, hit, pct: total ? Math.round((hit / total) * 100) : 100, loaded: !!e.covered, missed });
}
rows.sort((a, b) => a.pct - b.pct || b.total - a.total);
const text = [
  `主进程代码行覆盖（npm test，${reports} 个进程）：${Math.round((allHit / allBytes) * 100)}%（${allHit}/${allBytes} 行）`,
  '',
  '文件 | 行 | 跑到 | %',
  ...rows.map((x) => `${x.file} | ${x.total} | ${x.hit} | ${x.pct}%${x.loaded ? '' : '（没加载过）'}`),
].join('\n');
fs.writeFileSync(outFile, text, 'utf8');
fs.writeFileSync(`${outFile}.json`, JSON.stringify(rows.map((x) => ({ ...x, missed: x.missed.slice(0, 200) })), null, 1), 'utf8');
console.log(text.split('\n').slice(0, 30).join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
void fileURLToPath;
