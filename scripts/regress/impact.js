'use strict';
/**
 * 改了哪些文件 → 除了快速回归，还要跑哪些界面测试（rc9：小改动总是带出别处的新问题）。
 *   npm run test:changed        看从上一次发版到现在改了什么（含还没提交的），照下面的表加跑对应的测试
 *   npm run test:changed -- --since=<提交>   从指定的提交算起
 *
 * 以前「跑这一版改动相关的场景」是每次凭印象挑的，rc5、rc7 干脆没跑，rc3 改设置行的样式时也没人想到要回头量别的行。
 * 现在挑测试的规则写在这一处：新写了测试脚本，在这里登记它守着哪些文件；发版前跑 test:changed 就不会漏。
 */
const { spawnSync } = require('child_process');

// [匹配改动文件的正则, 要加跑的脚本（可以带参数）, 为什么]
const RULES = [
  [/^src\/renderer\/css\//, ['settings-layout.js', 'issue-layout.js', 'rc8-ui.js --quick', 'rc3-ui.js --quick', 'rc4-ui.js --quick'], '样式表是所有页面共用的，改一条规则别的页面可能跟着变'],
  [/^src\/renderer\/js\/base\//, ['settings-layout.js', 'issue-layout.js', 'rc3-ui.js --quick', 'rc8-ui.js --quick', 'ui.js'], '界面底层（组件、翻译）每个页面都在用'],
  [/^src\/renderer\/js\/(scene\/|home\/|pages\/home\.js|gamesound\.js|bgperf\.js)/, ['scene-new.js', 'rc3-ui.js --quick', 'rc4-ui.js --quick', 'rc6-ui.js', 'rc9-ui.js', 'rc14-ui.js', 'rc15-ui.js'], '主页和像素场景'],
  [/^src\/renderer\/js\/(art|fontwarm|app)\.js/, ['rc14-ui.js'], '方块图标、字体预热、切页面'],
  [/^(src\/renderer\/(js\/(brandlogo|app|perfmode)\.js|js\/scene\/scenekit\.js|img\/brand\/|index\.html)|src\/main\/(brand\/|main\.js)|docs\/brand\/|scripts\/(brand-icons|build-icon)\.js)/, ['brand-ui.js'], '标志：程序图标、侧边栏跟着场景和性能模式换的标志'],
  [/^src\/renderer\/js\/pages\/(settings|settingsnav)\.js/, ['settings-layout.js', 'rc8-ui.js --quick', 'rc3-ui.js --quick'], '设置页'],
  [/^src\/(renderer\/js\/(pages\/logs|logs)\.js|main\/core\/(gamelogs|loglevel|launcher)\.js)/, ['rc4-ui.js --quick', 'rc9-ui.js'], '日志中心、日志抽屉、启动和收尾'],
  [/^src\/(shared\/brand\.js|renderer\/js\/debug(menu|key)\.js|edition\/public\/renderer\/js\/debugkey\.js|main\/disclaimer\.js)/, ['rc11-ui.js'], '启动器名字、调试菜单'],
  [/^src\/(renderer\/js\/migrateui\.js|main\/core\/(migrate|foreign)\.js|renderer\/js\/setup\.js)/, ['foreign-ui.js', 'rc8-ui.js --quick', 'rc16-ui.js'], '迁移、从其他启动器导入、首次启动向导'],
  [/^src\/renderer\/js\/(base\/ui|pages\/settings|mcmodui|gamesyncui)\.js/, ['rc16-ui.js'], '对话框关上后设置页重画、开关先看真实状态、向导里的 MC 百科'],
  [/^src\/renderer\/js\/(tasks|pages\/tasks|pages\/planner)/, ['rc3-ui.js --quick', 'rc12-ui.js'], '任务中心、Mod 配置器'],
  [/^src\/(renderer\/js\/savesui\.js|main\/ipc\/backup\.js)/, ['rc12-ui.js'], '存档与备份'],
  [/^src\/renderer\/js\/(skin|pages\/skins|pages\/accounts)/, ['rc3-ui.js --quick', 'rc4-ui.js --quick'], '皮肤、账户'],
  [/^src\/renderer\/js\/(modkit|pages\/repair|pages\/mods)/, ['issue-layout.js'], '问题卡片'],
  [/^src\/main\/(ipc|preload|engine\/(fileops|zip|nbt|net|downloader))/, ['robust-ui.js'], '接口、文件和网络引擎：真实窗口里的坏数据和坏接口'],
  // 测试脚本自己改了：跑它自己
  [/^scripts\/regress\/(scene-new|issue-layout|settings-layout|rc3-ui|rc4-ui|rc6-ui|rc8-ui|rc9-ui|rc11-ui|rc12-ui|rc14-ui|rc15-ui|rc16-ui|foreign-ui|brand-ui|ui)\.js$/, null, '改了这个测试脚本'],
  [/^scripts\/regress\/(robust-ui|cdp|sandbox-hook|sandbox-run|pages)\.js$/, ['settings-layout.js', 'issue-layout.js', 'rc8-ui.js --quick'], '测试的公共部分改了，挑几个用到它的跑一遍'],
];

const git = (args) => { const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? `${r.stdout || ''}`.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : []; };

/** 从上一次发版（或 --since=提交）到现在改过的文件，含没提交的和新建的 */
function changedFiles(since) {
  // 上一次发版的那个提交（「版本号: changelog and version」）。版本标签是发 Release 时在 GitHub 上打的，本地不一定有
  const base = since || git(['log', '-1', '--format=%H', '--grep=: changelog and version'])[0] || git(['describe', '--tags', '--abbrev=0'])[0] || 'HEAD';
  const files = new Set([...git(['diff', '--name-only', base]), ...git(['ls-files', '--others', '--exclude-standard'])]);
  return { base, files: [...files].map((f) => f.replace(/\\/g, '/')).sort() };
}

// 改到这些地方，两个版本的样子可能不一样：发版前再导出一份公开版，在里面跑一遍（run.js --changed 调 public-copy.js）。
// 公开版的替身、按版本分开的代码、两版界面上有差别的页面、导出规则、测试脚本（测试会进公开仓库，要在两个版本里都能跑）
const EDITION_SENSITIVE = [
  /^src\/edition\//,
  /^src\/shared\/(brand|edition)\.js$/,
  /^src\/shared\/i18n\/tr-en\.js$/,
  /^src\/main\/(main|disclaimer)\.js$/,
  /^src\/main\/engine\/(edition|envelope|location)\.js$/,
  /^src\/main\/core\/mcmod\.js$/,
  /^src\/main\/ipc\/app\.js$/,
  /^src\/renderer\/js\/(app|setup|credits|mcmodui|mcmodcn|debugmenu|debugkey|home\/newspanel|pages\/settings)\.js$/,
  /^scripts\/(edition|export-public)\.js$/,
  /^scripts\/regress\//,
  /^package\.json$/,
];
/** 要不要在公开版里再跑一遍：{ run, files: 碰到的文件 } */
function publicCopyFor(files) {
  const hit = files.filter((f) => EDITION_SENSITIVE.some((re) => re.test(f)));
  return { run: hit.length > 0, files: hit };
}

/** 这些文件要加跑哪些脚本：[{ script, args, why: [原因…] }] */
function scriptsFor(files) {
  const out = new Map();
  const add = (spec, why) => {
    const [script, ...args] = spec.split(' ');
    const cur = out.get(script) || { script, args, why: new Set() };
    if (!args.length) cur.args = []; // 有一处要求跑全的（不带 --quick）就跑全的
    cur.why.add(why);
    out.set(script, cur);
  };
  for (const f of files) {
    for (const [re, list, why] of RULES) {
      const m = f.match(re);
      if (!m) continue;
      if (list) for (const s of list) add(s, why); else add(`${m[1]}.js`, why);
    }
  }
  const list = [...out.values()].map((x) => ({ ...x, why: [...x.why] }));
  const walk = walkPagesFor(files);
  if (walk.pages.length) list.push({ script: 'walk.js', args: [walk.pages.join(',')], why: walk.why });
  // 下载页走两遍（rc13）：上面那遍是真联网（真实数据的样子、网慢网断），这遍用固定数据（每次一样，还有超长名字、空结果、出错、慢回答）
  if (walk.pages.includes('download')) list.push({ script: 'walk.js', args: ['download', '--net=fixture'], why: ['下载页再用固定数据走一遍：内容不跟着网络变，故意放了真实数据里不一定碰得到的极端情况'] });
  if (files.some((f) => /^scripts\/regress\/(walk|snapshot-collect)\.js$/.test(f))) list.unshift({ script: 'walk.js', args: ['--selftest'], why: ['走查或界面检查改了：先确认它真的查得出来'] });
  return list;
}

/**
 * 按钮走查（rc12 起点出来的每一层都走到底，每一步做界面检查）要走哪些页面。
 * 界面快照只量打开时的样子和固定的几个弹窗；点进去第三层、第五层的样子只有走查看得到，
 * 所以改了哪个页面（或者它用到的弹窗模块），就把那个页面走一遍。界面底层、样式表、走查自己改了：全部走一遍
 */
const WALK_BY_FILE = [
  [/^src\/renderer\/js\/pages\/(settings|settingsnav)\.js$/, ['settings']],
  [/^src\/renderer\/js\/pages\/(planner\/|planner-conflicts)/, ['planner']],
  [/^src\/renderer\/js\/(profileui|isoworlds|savesui|compui|gamesyncui|javacheck|javaretest|placecheck)\.js$/, ['versions']],
  [/^src\/renderer\/js\/(skinui|skinview)\.js$/, ['accounts', 'skins']],
  [/^src\/renderer\/js\/(setup|resetui|credits|debugmenu|debugkey|migrateui|langui|a11y|uistyle|bgperf|mcmodui)\.js$/, ['settings']],
  [/^src\/renderer\/js\/(modkit|modnames|modsort|resources|sources|cfmanual|tags)\.js$/, ['mods', 'download']],
  [/^src\/renderer\/js\/(logs|tasks|notices)\.js$/, ['logs', 'tasks', 'download']], // 下载页的下载记录也是 tasks.js 画的
  // 下载页的资源几栏背后的接口、固定数据（rc13）
  [/^(src\/main\/core\/(modrinth|curseforge)\.js|scripts\/regress\/net-fixture\.js)$/, ['download']],
];
function walkPagesFor(files) {
  const { PAGES } = require('./pages');
  const pages = new Set();
  const why = new Set();
  for (const f of files) {
    if (/^src\/renderer\/(css\/|js\/base\/|index\.html)|^scripts\/regress\/(walk|walk-hook|snapshot-collect)\.js$/.test(f)) { PAGES.forEach((p) => pages.add(p)); why.add('界面底层、样式表或走查自己改了：每个页面都走到底'); continue; }
    const m = f.match(/^src\/renderer\/js\/pages\/(\w+)\.js$/);
    if (m && PAGES.includes(m[1])) { pages.add(m[1]); why.add('改了页面：把它点出来的每一层走到底'); continue; }
    for (const [re, list] of WALK_BY_FILE) if (re.test(f)) { list.forEach((p) => pages.add(p)); why.add('改了弹窗、抽屉模块：把用到它的页面走到底'); }
  }
  return { pages: PAGES.filter((p) => pages.has(p)), why: [...why] };
}

module.exports = { changedFiles, scriptsFor, walkPagesFor, publicCopyFor, RULES };
