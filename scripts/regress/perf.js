'use strict';
/**
 * 性能基线（2.0.0-pre1）：启动时间、空闲 CPU、内存（用 AURORA_PERF，见 src/main/devshot.js）。
 *   node scripts/regress/perf.js                    跑一遍，打印中位数
 *   node scripts/regress/perf.js --save=<文件>       结果存成基线
 *   node scripts/regress/perf.js --compare=<文件>    和基线对比
 *   node scripts/regress/perf.js --runs=3 --secs=20
 * 隔离目录，不碰真实数据。空闲 CPU 受机器上别的程序影响，变化不大时不要太当真
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { NO_THROTTLE } = require('./cdp');

const REPO = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const RUNS = Number(val('runs')) || 3;
const SECS = Number(val('secs')) || 20;
const BASE = path.join(process.env.AURORA_REGRESS_DIR || os.tmpdir(), 'perf');

const SCENES = [
  { name: '主页（前台）', env: {} },
  { name: '主页（失去焦点）', env: { AURORA_PERF_BLUR: '1' } },
  { name: '设置页（前台）', env: { AURORA_PERF_SCRIPT: "A.go('settings')" } },
];

function seed(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data'); const game = path.join(root, 'game');
  const mk = (f, d = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
  for (let i = 0; i < 5; i++) mk(path.join(game, 'versions', `P${i}`, `P${i}.json`), JSON.stringify({ id: `P${i}`, clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [] }));
  mk(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: 'P0' }));
  return { data, game };
}

const median = (l) => { const s = [...l].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const results = {};
for (const sc of SCENES) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const root = path.join(BASE, `run-${SCENES.indexOf(sc)}-${i}`);
    const { data, game } = seed(root);
    const shots = path.join(root, 'shots');
    fs.mkdirSync(shots, { recursive: true });
    // 窗口被别的窗口挡住时 Chromium 会降速，量出来的空闲 CPU 就看当时桌面上摆着什么：一律不降速（rc9；和这之前记的基线数字不能直接比，要新旧同时跑）
    spawnSync(ELECTRON, [...NO_THROTTLE, '.'], { cwd: process.env.AURORA_REGRESS_APP || REPO, windowsHide: true, timeout: (SECS + 60) * 1000, env: { ...process.env, ...sc.env, AURORA_DATA_DIR: data, AURORA_GAME_DIR: game, AURORA_TEST_TRASH: path.join(root, 'trash'), AURORA_SHOT_DIR: shots, AURORA_PERF: String(SECS), AURORA_SHOT_DELAY: '5000' } });
    const f = path.join(shots, 'perf.json');
    if (fs.existsSync(f)) runs.push(JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  if (!runs.length) { console.log(`${sc.name}：没有拿到结果`); continue; }
  results[sc.name] = {
    runs: runs.length,
    startMs: median(runs.map((r) => r.procUptimeAtAttach + r.didFinishLoad)),
    readyToShowMs: median(runs.map((r) => r.procUptimeAtAttach + (r.readyToShow || 0))),
    cpuPct: median(runs.map((r) => r.cpuTotal)),
    memMB: median(runs.map((r) => r.memTotalMB)),
    processes: median(runs.map((r) => r.processes)),
    gpu: runs[0].gpuCompositing,
    cpuAll: runs.map((r) => r.cpuTotal),
  };
  const x = results[sc.name];
  console.log(`${sc.name.padEnd(10)} 启动到页面加载完 ${x.startMs} ms，窗口可显示 ${x.readyToShowMs} ms，空闲 CPU ${x.cpuPct}%（每次 ${x.cpuAll.join(' / ')}），内存 ${x.memMB} MB，${x.processes} 个进程，GPU 合成 ${x.gpu}`);
}
const save = val('save');
if (save) { fs.mkdirSync(path.dirname(path.resolve(save)), { recursive: true }); fs.writeFileSync(save, JSON.stringify({ at: new Date().toISOString(), runs: RUNS, secs: SECS, results }, null, 2)); console.log(`存到 ${save}`); }
const cmp = val('compare');
if (cmp) {
  const old = JSON.parse(fs.readFileSync(cmp, 'utf8')).results;
  for (const [k, x] of Object.entries(results)) {
    const o = old[k];
    if (o) console.log(`对比 ${k}：启动 ${o.startMs} → ${x.startMs} ms，CPU ${o.cpuPct} → ${x.cpuPct}%，内存 ${o.memMB} → ${x.memMB} MB`);
  }
}
