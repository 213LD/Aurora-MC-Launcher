'use strict';
/**
 * 回归测试入口。每个场景一个独立进程（配置、账户这些模块是单例），隔离目录，不碰真实数据。
 *
 *   npm test（node scripts/regress/run.js）    快速：语法、翻译字典、分层报告，加上不需要游戏和联网的场景
 *   npm run test:full（加 --full）             全量：下面的 --game --flow --ui --real-trash --walk 全跑。重构做完时整体跑一次；
 *                                              在那之前的 pre 版本发版前只跑 npm test 和相关场景。
 *                                              缺环境变量就直接报错，不会悄悄跳过
 *   node scripts/regress/run.js --game         再跑真实启动游戏的（要设 AURORA_REGRESS_GAME_SRC、AURORA_REGRESS_JAVA_HOME，见 game-locks.js）
 *   node scripts/regress/run.js --flow         再跑真实安装流程（要联网，环境变量同上，见 install-flow.js）
 *   node scripts/regress/run.js --ui           再跑界面回归（Chrome 调试协议，见 ui.js；--ui-only=场景 只跑部分）
 *   node scripts/regress/run.js --real-trash   6-3 用真实回收站（只动 aurora-regress-trash-* 测试文件，测完还原再删掉）
 *   node scripts/regress/run.js --real         真的进游戏：Fabric、Forge、NeoForge、OptiFine、光影、老版本、整合包（要联网，见 game-real.js）
 *   node scripts/regress/run.js --walk         每个页面的按钮点一遍，点出来的每一层走到底，每一步都做界面检查（见 walk.js；新的界面毛病算失败）
 *   node scripts/regress/run.js --robust       全面测试：每个接口的坏参数、真实窗口的坏数据和坏接口、每个写入步骤杀进程、
 *                                              老版本数据升级和降级、内存泄漏循环（npm run test:robust，约 40 分钟）
 *   node scripts/regress/run.js --changed      发版前跑这个（npm run test:changed）：快速回归，再按这次改了哪些文件加跑对应的界面测试（对照表在 impact.js）
 *   node scripts/regress/run.js --only=meta-race,stash-merge
 *   node scripts/regress/run.js --label=before 结果另存一份 results-before.json，方便修前修后对比
 *
 * AURORA_REGRESS_DIR 指定工作目录（默认系统临时目录下的 aurora-regress，公开版是 aurora-regress-public：两个版本可以同时跑，见 editions.js）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const BASE = require('./editions').BASE;
const args = process.argv.slice(2);
const FULL = args.includes('--full');
const flag = (n) => (FULL && ['game', 'flow', 'ui', 'real-trash', 'walk', 'robust'].includes(n)) || args.includes(`--${n}`);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

const DATA = ['config-nobak', 'config-bak-1', 'config-bak-2', 'config-locked', 'accounts-bak-1', 'accounts-bak-2', 'accounts-nobak', 'meta-corrupt', 'old-data', 'stores-corrupt', 'migrate-import', 'meta-race', 'stash-merge', 'sandbox-midway', 'rename-rollback', 'trash-unavailable', 'trash-inuse'];
const FUNC = ['lang-list', 'export-public', 'promote-real', 'mark-plain', 'bring-items', 'bring-global', 'bring-worlds', 'mc-compare', 'iso-policy', 'cancel-copy', 'duplicate-fail', 'swallowed-errors', 'java-prefix', 'downloader-lock', 'zip-names', 'nbt-mutf8'];
const PRE2 = ['write-atomic', 'write-atomic-nbt', 'quit-flush', 'flush-retry', 'path-scope', 'names', 'pack-traversal', 'net-names', 'copy-rules', 'encoding', 'net-flaky'];
const PRE3 = ['dl-report', 'task-engine', 'ipc-split', 'launch-guard'];
const PRE5 = ['fs-errors', 'error-names', 'hardware-text'];
// 全面测试里快的部分（2.0.0-pre8）：恶意压缩包、NBT、令牌、下载地址、最危险的几个接口、崩溃后的恢复规则
const ROBUST_FAST = ['zip-crafted', 'zip-mutate', 'nbt-crafted', 'content-mutate', 'token-storage', 'download-urls', 'ipc-paths', 'recover-rules', 'concurrent'];
const GAME = ['own', 'sandbox', 'root'];
// 真的进游戏（game-real.js）：--full 只跑不下载加载器的，--real 全跑（要联网，每个几分钟）
const REAL_CORE = ['save', 'modes', 'sync', 'crash', 'ygg', 'ms', 'external', 'jvm-encoding', 'semicolon', 'screenmem', 'logs'];
const REAL_ALL = [...REAL_CORE, 'fabric', 'forge', 'neoforge', 'optifine', 'forgecn', 'shader', 'old', 'pack', 'planner'];
const FLOW = ['launch-cancel', 'install-retry', 'vanillaplus-iso', 'pack-cancel', 'pack-fail', 'profile-lock', 'java-shared'];
if (FULL) {
  const missing = ['AURORA_REGRESS_GAME_SRC', 'AURORA_REGRESS_JAVA_HOME'].filter((k) => !process.env[k]);
  if (missing.length) { console.error(`全量回归要真实游戏，缺环境变量：${missing.join('、')}（说明见 game-locks.js）`); process.exit(2); }
}
const only = val('only') ? val('only').split(',') : null;
const label = val('label') || 'last';

fs.mkdirSync(BASE, { recursive: true });
const out = path.join(BASE, `results-${label}.jsonl`);
fs.rmSync(out, { force: true });

const readRows = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { ok: false, name: '汇总里有一行读不出来' }; } }) : []);
const note = (id, name, detail) => {
  console.log(`FAIL [${id}] ${name}${detail ? ` — ${detail}` : ''}`);
  fs.appendFileSync(out, `${JSON.stringify({ id, name, ok: false, detail })}\n`, 'utf8');
};

/**
 * 一个测试脚本跑完以后看它交了什么（rc9）。以前只看「超时、起不来」，不看退出码：
 * 脚本中途出错退出、一条结果都没写，汇总里它就是 0 项、0 失败，最后一行照样是「失败 0」（实测过 rc6-ui.js）。
 * 现在：没写出任何结果算失败；退出码不是 0 却没有报过失败也算失败
 */
function settle(id, r, before) {
  if (r.error) { note(id, '进程出错', r.error.message); return; }
  const mine = readRows().slice(before);
  const tail = `${r.stderr || ''}`.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 500);
  if (!mine.length) note(id, '脚本没有写出任何结果（没跑完就退出了）', `退出码 ${r.status}${tail ? `；${tail}` : ''}`);
  else if (r.status !== 0 && mine.every((x) => x.ok)) note(id, `脚本的退出码是 ${r.status}，却没有报过失败（中途出错了）`, tail);
}

function run(script, name, timeout) {
  console.log(`\n=== ${script} ${name} ===`);
  const env = { ...process.env, AURORA_REGRESS_OUT: out, AURORA_REGRESS_DIR: BASE, ELECTRON_ENABLE_LOGGING: '' };
  if (flag('real-trash')) env.AURORA_REGRESS_REAL_TRASH = '1';
  const before = readRows().length;
  const r = spawnSync(ELECTRON, [path.join(__dirname, script), name], { env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const lines = `${r.stdout || ''}`.split(/\r?\n/).filter((l) => /^(PASS|FAIL|\s{2}\S)/.test(l));
  console.log(lines.join('\n'));
  settle(`${script} ${name}`, r, before);
}

function runUi() {
  console.log('\n=== ui.js ===');
  const uiOnly = val('ui-only');
  const before = readRows().length;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'ui.js'), ...(uiOnly ? [uiOnly] : [])], { env: { ...process.env, AURORA_REGRESS_OUT: out, AURORA_REGRESS_DIR: BASE }, encoding: 'utf8', timeout: 1800000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  console.log(`${r.stdout || ''}`.split(/\r?\n/).filter((l) => /^(PASS|FAIL|\s{2}\S)/.test(l)).join('\n'));
  settle('ui.js', r, before);
}

/** 不用启动程序的检查：所有 js 语法、翻译字典、分层报告 */
function preflight() {
  console.log('=== 语法、字典、分层 ===');
  const vm = require('vm');
  const bad = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const files = [...walk(path.join(REPO, 'src')), ...walk(path.join(REPO, 'scripts'))].filter((f) => f.endsWith('.js'));
  for (const f of files) {
    try { new vm.Script(`(function (require, module, exports, __dirname, __filename) {${fs.readFileSync(f, 'utf8').replace(/^#!.*/, '')}\n})`, { filename: f }); } catch (e) { bad.push(`${path.relative(REPO, f)}：${e.message}`); }
  }
  const results = [{ id: 'check', name: `${files.length} 个 js 语法都对`, ok: bad.length === 0, detail: bad.join('; ') }];
  // 字典脚本只在私人仓库有（带繁体转换表，不进公开仓库）；没装 Python 就跳过
  if (require('./editions').privateRepo && fs.existsSync(path.join(REPO, 'scripts', 'i18n.py'))) {
    const py = spawnSync('python', [path.join(REPO, 'scripts', 'i18n.py'), 'check'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (py.error) console.log('  跳过字典检查：没找到 Python');
    else { const m = `${py.stderr || ''}`.match(/缺 (\d+) 条/); results.push({ id: 'check', name: '界面文字都有英文译文', ok: !!m && m[1] === '0', detail: `${py.stdout || ''}`.slice(0, 300) }); }
  }
  // 没定义的名字、不存在的导出（2.0.0-pre7：promote.js 少了一个导入，语法检查查不出来）
  const undef = require('../undef-check');
  const und = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'undef-check.js')], { encoding: 'utf8', windowsHide: true });
  results.push({ id: 'check', name: '没有用到没定义的名字、不存在的导出', ok: und.status === 0, detail: und.status === 0 ? '' : `${und.stdout || ''}`.trim().split(/\r?\n/).slice(0, 8).join('; ') });
  const canFind = undef.undefinedNames("const a = 1; const f = (x) => `${x}${b}`; foo(a, f); ({ k: 1, m() {} }); a.c();").map((x) => x.name).join(',');
  results.push({ id: 'check', name: '这个检查自己能查出问题（确认场景成立）', ok: canFind === 'b,foo', detail: canFind });
  // 名字标记（A.nm）不能进接口参数、输入框的值、保存的数据
  const markBad = [];
  const MARK_BAD = [/\bapi\([^)\n]*\bnm\(/, /\bvalue: (A\.)?nm\(/, /\.value = [^;\n]*\bnm\(/, /\bpath\.join\([^)\n]*\bnm\(/, /\b(writeFile|writeFileSync|mkdir|rename)\([^)\n]*\bnm\(/, /\b(plan|P\.plan|meta|settings|config)\.\w+ = [^;\n]*\bnm\(/];
  for (const f of files.filter((x) => x.includes(`${path.sep}src${path.sep}`) && !/i18n/.test(x))) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => { if (MARK_BAD.some((re) => re.test(l))) markBad.push(`${path.relative(REPO, f)}:${i + 1}`); });
  }
  results.push({ id: 'check', name: '名字标记没有写进接口参数、输入框的值和保存的数据（按写法查）', ok: markBad.length === 0, detail: markBad.slice(0, 8).join('; ') });
  const layers = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'layer-check.js'), '--strict', '--list'], { encoding: 'utf8', windowsHide: true });
  console.log((layers.stdout || '').trimEnd());
  results.push({ id: 'check', name: '分层：引擎不依赖功能，界面底层不依赖上层，页面不直接用别的页面', ok: layers.status === 0, detail: layers.status === 0 ? '' : `${layers.stdout || ''}`.trim().split(/\r?\n/).slice(0, 8).join('; ') });
  // 踩过的坑按写法查一遍（rc10）：直接写文件、整个目录删除、吞掉的错误、负数取余当下标、测试里等固定毫秒……比基线多了就失败
  const pit = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'pitfall-check.js')], { encoding: 'utf8', windowsHide: true });
  results.push({ id: 'check', name: '踩过的坑没有再踩（按写法查，比基线多了就失败；scripts/pitfall-check.js）', ok: pit.status === 0, detail: pit.status === 0 ? '' : `${pit.stdout || ''}`.trim().split(/\r?\n/).slice(0, 12).join('; ') });
  // 测试自己有没有漏（rc9）：新页面要登记进页面清单；开测试窗口的脚本都要带不降速的开关
  const pages = require('./pages');
  const defined = pages.definedPages(REPO);
  const unlisted = defined.filter((p) => !pages.PAGES.includes(p));
  const stale = pages.PAGES.filter((p) => !defined.includes(p));
  results.push({ id: 'check', name: '代码里的每个页面都登记在测试的页面清单里（scripts/regress/pages.js）', ok: !unlisted.length && !stale.length, detail: `${unlisted.length ? `没登记：${unlisted.join('、')}` : ''}${stale.length ? ` 清单里多了：${stale.join('、')}` : ''}` });
  const noFlags = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== 'cdp.js').filter((f) => { const s = fs.readFileSync(path.join(__dirname, f), 'utf8'); return /--remote-debugging-port/.test(s) && !/NO_THROTTLE/.test(s); });
  results.push({ id: 'check', name: '开测试窗口的脚本都用了不降速的开关（cdp.js 的 NO_THROTTLE）', ok: noFlags.length === 0, detail: noFlags.join('、') });
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} [${r.id}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  fs.appendFileSync(out, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/** 自己跑 Electron 的回归脚本（node 启动） */
function runNode(script, scriptArgs = [], timeout = 1800000, extraEnv = {}) {
  console.log(`\n=== ${script} ${scriptArgs.join(' ')} ===`);
  const before = readRows().length;
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...scriptArgs], { env: { ...process.env, AURORA_REGRESS_OUT: out, AURORA_REGRESS_DIR: BASE, ...extraEnv }, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  console.log(`${r.stdout || ''}`.split(/\r?\n/).filter((l) => /^(PASS|FAIL|\s{2}\S)/.test(l)).join('\n'));
  settle(script, r, before);
}

function runRobust() {
  for (let i = 0; i < 4; i++) {
    process.env.AURORA_FUZZ_SHARD = `${i}/4`;
    run('robust.js', 'ipc-fuzz', 1800000);
  }
  delete process.env.AURORA_FUZZ_SHARD;
  runNode('robust-ui.js');
  runNode('limits.js');
  runNode('foreign-ui.js');
  runNode('scene-new.js'); // 远古城市、繁茂洞穴的水塘和美西螈、雪山上的山羊（2026-11-07）
  runNode('issue-layout.js'); // 问题卡片在窄的栏里按钮不压标题（rc1 试用发现）
  runNode('settings-layout.js'); // 设置页分类、搜索、改设置后位置不跳（rc2）
  runNode('rc3-ui.js'); // rc3：主页胶囊、启动栏变窄、天气、音效开关、删除确认、任务中心的未完成配置、旧版皮肤、生物放大
  runNode('rc4-ui.js'); // rc4：日志中心、水和岩浆的流动与生成、生物卡住、胶囊按钮居中、骰子天气、披风
  runNode('rc6-ui.js'); // rc6：往下落的水连成整段、流动和区块生成顺序无关、拉窗口世界不变（每个场景都比）
  runNode('rc8-ui.js'); // rc8：设置页上下排的行不空一大块、从其他启动器迁移的入口
  runNode('rc12-ui.js'); // rc12：下载记录和存档的「打开文件夹」（按钮走查走到底以后查出来的）
  runNode('rc16-ui.js'); // rc16：对话框关上后设置页重画、开关先看真实状态、向导最后一页 MC 百科、向导防连点
  runNode('rc15-ui.js'); // rc15：要消失的生物真的消失、活到寿命后会刷新新的（以前挂机几分钟所有生物定住）
  runNode('rc14-ui.js'); // rc14：拉窗口后生物跟着世界挪、不追已经不在的目标、原地迈步算卡住、一个出错不连累别的；图标和字体预热
  runNode('rc11-ui.js'); // rc11：名字改成 Aurora MC Launcher、调试菜单没有密码哈希时打不开
  runNode('rc9-ui.js'); // rc9：每个场景四处画几帧不报错、画错一帧循环不停、日志中心离开再回来 / 带着一局打开 / 导出 / 实时追加、默认视角和平原的山
  runNode('crash.js');
  runNode('upgrade.js');
  runNode('leak.js');
  if (process.env.AURORA_REGRESS_GAME_SRC) runNode('crash-game.js');
  runNode('contract.js'); // 要联网：真实接口的格式变了没有
}

function runWalk() {
  runNode('walk.js', ['--selftest'], 1200000); // 先确认走查的界面检查真的在查（rc12）
  console.log('\n=== walk.js ===');
  const before = readRows().length;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'walk.js')], { env: { ...process.env, AURORA_REGRESS_OUT: out, AURORA_REGRESS_DIR: BASE }, encoding: 'utf8', timeout: 7200000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  console.log(`${r.stdout || ''}`.split(/\r?\n/).filter((l) => /^(PASS|FAIL|\s{2}\S)/.test(l)).join('\n'));
  settle('walk.js', r, before);
  runNode('walk.js', ['download', '--net=fixture'], 1800000); // 下载页再用固定数据走一遍（rc13）：上面是真联网，这遍内容固定、带极端情况
}

if (!only) preflight();
for (const s of DATA) if (!only || only.includes(s)) run('data-safety.js', s, 180000);
for (const s of FUNC) if (!only || only.includes(s)) run('func-errors.js', s, 180000);
for (const s of PRE2) if (!only || only.includes(s)) run('pre2.js', s, 180000);
for (const s of PRE3) if (!only || only.includes(s)) run('pre3.js', s, 180000);
for (const s of PRE5) if (!only || only.includes(s)) run('pre5.js', s, 180000);
for (const s of ROBUST_FAST) if (!only || only.includes(s)) run('robust.js', s, 180000);
if (flag('game')) for (const s of GAME) if (!only || only.includes(s)) run('game-locks.js', s, 600000);
if (flag('real') || FULL) for (const s of (flag('real') ? REAL_ALL : REAL_CORE)) if (!only || only.includes(s)) run('game-real.js', s, 1200000);
if (flag('flow')) for (const s of FLOW) if (!only || only.includes(s)) run('install-flow.js', s, 900000);
if (flag('ui')) runUi();
if (!only || only.includes('unit')) run('unit.js', 'all', 60000);
// 只在内部仓库有（公开仓库没有这个文件，跳过）
if ((!only || only.includes('unit')) && fs.existsSync(path.join(__dirname, 'mcmod-unit.js'))) run('mcmod-unit.js', 'all', 60000);
// 对照表（rc12）：读 Mod 信息（四种格式，照真实 Mod 的写法打 jar）、一键修复的硬件检查（21 台典型的电脑）
if (!only || only.includes('unit') || only.includes('modmeta')) run('modmeta-unit.js', 'all', 60000);
if (!only || only.includes('unit') || only.includes('hardware')) run('hardware-unit.js', 'all', 60000);
// 老数据文件夹（rc13 起一直跑）：每个时期的老版本把数据放在默认 / 便携 / 自定义位置，新版本都要找得到；老名字新名字不同时开；快捷方式
if (!only || only.includes('legacy')) runNode('legacy-location.js', [], 600000);
// 两个版本的每一处差别（editions.js 的差别表）：数据目录、标题、显示的版本号、MC 百科、向导、致谢、调试菜单。内部版、公开版都跑
if (!only || only.includes('edition')) runNode('edition-ui.js', [], 600000);
if (!only || only.includes('foreign')) run('foreign.js', 'layouts', 120000);
if (!only || only.includes('logs')) run('logs-unit.js', 'all', 120000); // 日志中心的主进程部分（rc9：以前快速回归里完全没有日志中心）
// 存档的随机操作序列（rc10）：切独立 / 切共享 / 改名 / 复制 / 删进回收站 / 开新世界随机排几百步，每一步之后世界一个都不能少
if (!only || only.includes('saves-fuzz')) run('saves-fuzz.js', 'all', 300000);
// 界面快照（rc9）：每个页面的入口、位置、大小、居中和上次确认过的一样（ui-snapshot.js）。在快速回归里，每次都跑
if (!only || only.includes('snapshot')) runNode('ui-snapshot.js', [], 900000);
if (flag('walk')) runWalk();
if (flag('robust')) runRobust();
// 按这次的改动加跑（rc9）：已经在 --robust 里跑过的不重复
if (args.includes('--changed')) {
  const impact = require('./impact');
  const { base, files } = impact.changedFiles(val('since'));
  const extra = impact.scriptsFor(files).filter((x) => fs.existsSync(path.join(__dirname, x.script)));
  console.log(`
=== 按改动加跑：从 ${base.slice(0, 10)} 到现在改了 ${files.length} 个文件，加跑 ${extra.length} 个界面测试 ===`);
  for (const x of extra) console.log(`  ${x.script}${x.args.length ? ` ${x.args.join(' ')}` : ''} ← ${x.why.join('；')}`);
  // 走查一个页面要几分钟，全部走一遍要一个多小时：给它两个小时
  if (!flag('robust')) for (const x of extra) runNode(x.script, x.args, x.script === 'walk.js' ? 7200000 : undefined);
  // 改到了两个版本可能不一样的地方（替身、按版本分开的代码、测试脚本……）：导出一份公开版，在里面再跑快速回归和上面这些（public-copy.js）。
  // 公开仓库里没有导出脚本，本来就是公开版，不用再跑
  const pc = impact.publicCopyFor(files);
  if (pc.run && require('./editions').privateRepo) {
    console.log(`
=== 在公开版里再跑一遍：改到了 ${pc.files.slice(0, 6).join('、')}${pc.files.length > 6 ? ` 等 ${pc.files.length} 个` : ''} ===`);
    const scripts = extra.filter((x) => x.script !== 'walk.js').map((x) => (x.args.length ? `${x.script}:${x.args.join('+')}` : x.script));
    runNode('public-copy.js', scripts.length ? [`--scripts=${scripts.join(';')}`] : [], 10800000);
  }
}

const rows = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const fails = rows.filter((r) => !r.ok);
console.log(`\n共 ${rows.length} 项，通过 ${rows.length - fails.length}，失败 ${fails.length}`);
for (const f of fails) console.log(`  FAIL [${f.id}] ${f.name}`);
fs.writeFileSync(path.join(BASE, `results-${label}.json`), JSON.stringify(rows, null, 2), 'utf8');
console.log(`结果：${path.join(BASE, `results-${label}.json`)}`);
process.exitCode = fails.length ? 1 : 0;
