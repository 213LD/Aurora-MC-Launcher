'use strict';
/**
 * 踩过的坑不再踩（rc10）。
 *   node scripts/pitfall-check.js            和基线比，哪条规则在哪个文件里比基线多了就失败，列出那几行
 *   node scripts/pitfall-check.js --list     每条规则现在命中的全部位置
 *   node scripts/pitfall-check.js --update   确认这些新出现的都没问题：存成新基线（scripts/pitfall-baseline.json）
 *
 * 每条规则是一个以前真的出过问题的写法。回归测试只能守住「那一次出问题的那个地方」，
 * 同样的写法换个文件再写一遍，测试不知道；这里按写法查，新写的代码一出现就拦住。
 * 查的是「比基线多了没有」（只许减少，不许增加）：以前留下的、看过没问题的记在基线里；
 * 新出现的要么改掉，要么确认没问题以后 --update，基线文件的变化跟着提交，等于留了一条「我看过了」的记录。
 * 写法查不出语义，会有误报，所以才有基线；规则宁可宽一点，多看一眼比漏掉便宜。
 *
 * 加规则：以后每踩一个能按写法认出来的坑，就在 RULES 里加一条（why 写清是哪一版的什么问题，fix 写该怎么写）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'pitfall-baseline.json');
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])) : []);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const FILES = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))].map(rel).filter((f) => /\.(js|css|html)$/.test(f) && !/i18n\/tr-/.test(f) && f !== 'scripts/pitfall-check.js');

const MAIN = /^src\/main\//;
const UI = /^src\/renderer\/js\//;
const TESTS = /^scripts\/regress\//;

// zero: true 的规则不设基线，一处都不许有
const RULES = [
  // ── 文件和存档 ──
  { id: '直接写文件', where: MAIN, skip: /devshot\.js$|engine\/(util|fileops|jsonstore)\.js$/, re: /\bfsp?\.(writeFile|writeFileSync|appendFile|appendFileSync)\(/,
    why: '2.0.0-pre2 修的：直接写，写到一半崩溃或断电会留下半个文件，玩家的存档名、设置就坏了',
    fix: '玩家的文件用 fileops.writeFileSafe；JSON 用 jsonstore（玩家数据）或 util.writeJson（缓存）。只是标记、缓存、临时文件可以直接写' },
  { id: '用 fs.cp 复制目录', where: MAIN, re: /\bfsp?\.cp(Sync)?\(/, zero: true,
    why: '2.0.0-pre2：fs.cp 碰到目录联接直接报 EPERM，共享存档的配置复制不了；还会把 session.lock 一起复制走',
    fix: '用 fileops.copyDir / copyDirNew（跳过 session.lock 和联接，能取消）' },
  { id: '整个目录删除', where: MAIN, re: /\brmrf\(|\brm\([^)\n]*recursive:\s*true/,
    why: '1.10.7 修的：删错目录、游戏开着时删目录，玩家的世界就没了；丢数据的问题大半和它有关',
    fix: '删玩家的东西走 safeTrash（进回收站）并先 gamelock.assert…；多步操作「先做在旁边，全好了再换」。清自己的临时目录可以直接删' },
  { id: '写配置档案', where: MAIN, skip: /core\/profiles\.js$/, re: /\bwriteMeta\(/,
    why: '1.10.7 的 meta-race：先 readMeta 算出新值再 writeMeta，中间别的操作写进去的东西被盖掉',
    fix: 'writeMeta(id, 补丁) 只能写和旧值无关的补丁；新值是从旧值算出来的（加一、往列表里加一项）用 profiles.updateMeta(id, (meta) => …)' },
  { id: '不走统一入口的接口', where: MAIN, skip: /ipc\/bus\.js$/, re: /\bipcMain\.handle\(/, zero: true,
    why: '2.0.0-pre8：直接 ipcMain.handle 的接口不查是不是启动器自己的页面在调，出错也不带原因',
    fix: '用 ipc/bus.js 的 handle()；新命名空间加进 preload.js 的 NAMESPACES 和 scripts/regress/ipc-channels.json' },
  { id: '吞掉的错误', where: MAIN, re: /\.catch\(\(\)\s*=>\s*\{\s*\}\)|\.catch\(\(\)\s*=>\s*(null|false|undefined|\[\]|0)\)/,
    why: '1.10.8 的 swallowed-errors：出了错不说，玩家看到的是「什么都没发生」或者数据悄悄不对',
    fix: '确实可以不管的（清缓存、删临时文件）才吞；会影响玩家看到的结果的，报出来或者记进任务' },
  { id: '打开外部程序', where: MAIN, skip: /ipc\/app\.js$|\/main\.js$/, re: /\bshell\.(openExternal|openPath|showItemInFolder)\(/,
    why: '2.0.0-pre8：shell:open 以前什么都开，包括能运行的文件；界面被钻了空子就能运行任意程序',
    fix: '走 ipc/app.js 里查过的入口（只开文件夹和不能运行的文件，网址只认 http(s)）' },

  // ── 界面 ──
  { id: '类名叫 drag', where: UI, re: /h\(\s*['`][^'`]*\.drag(?![\w-])|class(Name)?:\s*['`][^'`]*(?<![\w-])drag(?![\w-])/, zero: true,
    why: '1.5.9：全局的 .drag 是「拖动窗口的区域」，元素叫这个名字就收不到鼠标事件',
    fix: '换个类名（cam-dragging、drop-zone……）' },
  { id: '直接写 innerHTML', where: UI, re: /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(/,
    why: '2.0.0-pre8：Mod、整合包、世界的名字和介绍是别人写的，直接当 HTML 放进页面就能跑脚本',
    fix: '用 h() 建元素、textContent 放文字；要显示富文本走 ui.js 里净化过的入口' },
  { id: '界面里的定时器', where: UI, re: /\bsetInterval\(/,
    why: '全面测试计划「内存泄漏」：弹窗、抽屉里开的定时器没关，开一次多一个',
    fix: '开在一直存在的模块里可以；开在弹窗、页面里的，关掉时 clearInterval，或者定时器里先看元素还在不在（isConnected）' },
  { id: '全局事件监听', where: UI, re: /\b(window|document)\.addEventListener\(/,
    why: '同上：在会反复执行的函数里给 window / document 加监听，每执行一次多一个，还拖着整棵旧界面不放',
    fix: '只在模块初始化时加一次；临时的（拖动）在结束时 removeEventListener' },
  { id: '负数取余当下标', where: /^src\/renderer\/js\/scene\//, re: /\[[^[\]\n]*\b(c|ci|col|cx|x|i|r|row|reg|seed|t\.col|e\.x)\s*%\s*\d+\s*\]/,
    why: 'rc9：M.ice[c % 2]，列号是负的奇数时取余是 -1，取不到颜色，画这一帧就报错，背景卡死',
    fix: '列号、行号、区域号可能是负的：用 & 1，或者 ((x % n) + n) % n' },
  { id: '源码里看不见的字符', where: /^(src|scripts)\//, re: /[\uFEFF\u200B\u00A0\u2028\u2029]/, zero: true, // 零宽连接符（U+200D）不算：emoji 里本来就有
    why: 'rc10：去 BOM 的正则里直接写着一个看不见的 BOM 字符（11 处），编辑器、格式化工具一清理，功能就悄悄没了',
    fix: '写成转义：\\uFEFF、\\u00A0……' },
  { id: '注释里的内部记录', where: /^(src|scripts)\//, skip: /scripts\/export-public\.js$|home\/changelog\.js$/, zero: true,
    re: /用户\s?20\d\d-\d\d|20\d\d-\d\d(-\d\d)?\s?用户|用户(定的?|决定|要求|提的|问的)[，。；：）]|PROJECT_NOTES|旧文档|代码审查\s*\d+-\d+|第[一二三四五]轮(代码)?审查|审查清单|(?<![A-Za-z0-9_'"`$.])R\d{1,3}(?![A-Za-z0-9_])\s*[，）：、/]|[（，、；]\s*(8|9|10|11|12)\.\d{1,2}(\s?[AB])?[）；，]|第\s?\d{1,2}(\.\d{1,2})?\s?节/,
    why: 'rc11：注释里写着「谁在哪天定的」、内部文档的章节号、需求和审查清单的编号，一共五百来处。这些文档不公开，代码公开以后读的人查不到，读着也奇怪',
    fix: '注释只写技术上的原因和版本号（「1.10.7：以前并发写会撞上临时文件」）。谁定的、哪天定的、对应文档哪一节，写进不公开的项目文档' },

  // ── 测试脚本 ──
  { id: '写死的调试端口', where: TESTS, re: /remote-debugging-port=\d/, zero: true,
    why: '2.0.0-pre2：这台电脑的临时端口范围从 1024 开始，写死的端口随时可能被别的程序占着，测试看起来像程序起不来',
    fix: '用 cdp.freePort()；开窗口的测试尽量用 robust-ui.start（带重试）' },
  { id: '用当天日期当种子', where: TESTS, re: /Date\.now\(\)\s*\/\s*86400000/, zero: true,
    why: 'rc3、rc9：主页的世界每天换，用到「今天的世界」的测试今天过明天不过',
    fix: '用 cdp.js 的 WORLD_SEED / FIX_SEED / FIX_WORLD' },
  // 写在一行里的轮询（for (…; 条件; …) { …; await sleep(250); }）不算：它有条件，sleep 只是两次查看之间的间隔；
  // Promise.race([…, sleep(30000)]) 也不算：那是超时，不是等待（rc11 起不计）
  // 「sleep(条件 ? 1500 : 800)」这种两个死数字挑一个的也算（rc13）
  { id: '等固定的毫秒数', where: TESTS, re: /^(?!\s*(for|while)\s*\()(?!.*Promise\.race\().*\bsleep\(\s*(\d+|[^()]*\?\s*\d+\s*:\s*\d+)\s*\)/,
    why: 'rc9：机器忙的时候等不够就偶发失败，平时又白等',
    fix: '等某件事：cdp.js 的 until(ev, 条件, 超时)；切页面、点按钮以后等界面画完：calm(ev)。只有「就是要过这么久」的地方才 sleep' },
  // 「标上了」和「做到了」是两回事（rc15）：rc4 的「卡住的生物会消失」、rc14 的卡住检测都只看 e.fade 被标上，
  // 而淡入淡出从 v1.2.2 起就写反了，标上了永远消失不掉；测试全过，挂机五分钟所有生物定住
  { id: '测试只看「要消失」的标记', where: TESTS, re: /!!\w+(\.\w+)*\.fade\b|\bdead\s*=\s*[^;\n]*\|\|\s*\w+(\.\w+)*\.fade\b/, zero: true,
    why: 'rc15：e.fade 只是「开始消失」，测试拿它当结果，消失本身坏了也照样通过（淡入淡出写反，存在了快一个月）',
    fix: '看结果：让场景接着跑（或者接着调 updateEnt）一两秒，查 e.dead、它不在 s.ents 里了；只测「判断对不对」的单元测试在行末写 pitfall-ok 并说明结果由哪个测试看' },
  { id: '测试里同步删改目录', where: TESTS, re: /\bfs\.(rmSync|cpSync)\(/,
    why: '2.0.0-pre2：系统 Node 24 的 fs.rmSync 删中文目录时崩过（0xC0000409），fs.cpSync 写中文路径会写到乱码目录',
    fix: '用 fs.promises.rm / fs.promises.cp' },
  // 两个版本（2.0.0 公开前）：测试会进公开仓库，要在内部版、公开版里都查得对
  { id: '测试里写死版本的差别', where: TESTS, skip: /scripts\/regress\/editions\.js$/,
    // 整行是注释的不算（注释里说「内部版」「公开版」是正常的）
    re: /^(?!\s*(\/\/|\/?\*)).*('Aurora Launcher'|（内部版）|（公开版）|dev\.aurora\.m?c?launcher|disclaimerAccepted:\s*'\d|os\.tmpdir\(\),\s*'aurora-regress'|existsSync\([^)\n]*'edition\.js'\))/,
    why: '2.0.0：测试写死了内部版的数据目录、窗口标题、免责声明的版本，又各自用不同的办法猜「现在是哪个版本」；公开版里一跑就错（数据位置测试只认内部版的文件夹），免责声明改一次版本要改 29 处',
    fix: '从 scripts/regress/editions.js 取：dataDirName、title、aboutTag、shownVersion、DISCLAIMER、BASE、privateRepo、oldTags……；以前用过的名字（老数据的对照表）在行末写 pitfall-ok 说明' },
];

// 必须一直在的写法（rc13）：上面的规则管「不许再这样写」，这里管「这几处不许改掉」。少了就失败，没有基线
const MUST = [
  { id: '公开版数据文件夹的名字', file: 'src/shared/brand.js', re: /publicEdition:\s*\{\s*dataDirName:\s*'Aurora MC Launcher'/,
    why: '公开版从 1.0.0 起把数据放在 %APPDATA%\\Aurora MC Launcher。改了这个名字，公开版的玩家打开新版本就是一个全新的启动器',
    fix: '公开版改名也只改 name / short，publicEdition.dataDirName 永远不动（scripts/regress/editions.js 的差别表也写着它）' },
  { id: '老数据文件夹的名字', file: 'src/shared/brand.js', re: /dataDirName:\s*'Aurora Launcher'/,
    why: '从 1.0.0 起，所有版本的默认数据都在 %APPDATA%\\Aurora Launcher（1.0 ~ 1.2 是 Electron 按当时的程序名给的）。改了这个名字，老玩家打开新版本就是一个全新的启动器，配置、账户都「没了」',
    fix: '启动器改名只改 name / short / abbr，dataDirName 永远不动；新名字加进 formerNames' },
  { id: '老数据文件夹的名字', file: 'src/main/engine/location.js', re: /path\.join\(a\.getPath\('appData'\),\s*EDITION\.dataDirName\)/,
    why: '默认位置要按写死的文件夹名算。getPath(\'userData\') 跟着程序名变，改名以后就指到另一个空文件夹',
    fix: '默认位置用 path.join(getPath(\'appData\'), EDITION.dataDirName)' },
  { id: '老数据文件夹的名字', file: 'src/main/engine/edition.js', re: /dataDirName:\s*PUBLIC \? BRAND\.publicEdition\.dataDirName : BRAND\.dataDirName/,
    why: '内部版的默认数据目录必须是 BRAND.dataDirName（老玩家的数据都在那里）；只有公开版用自己的目录',
    fix: '内部版用 BRAND.dataDirName，公开版用 BRAND.publicEdition.dataDirName' },
  ...[["MARKER", 'aurora-portable\\.json'], ['PORTABLE_DIR', 'AuroraData'], ['POINTER', 'location\\.json'], ['TOKEN', '@aurora-data']].map(([k, v]) => ({
    id: '老数据文件夹的名字', file: 'src/main/engine/location.js', re: new RegExp(`^const ${k} = '${v}';`, 'm'),
    why: `便携模式的标记、数据文件夹，自定义位置的指针，配置里的路径记号（${k}）：老版本按这个名字写在玩家电脑上，改了就找不到`,
    fix: '这几个常量永远不动' })),
  { id: '老数据文件夹的名字', file: 'src/shared/brand.js', re: /formerNames:\s*\[[^\]]*'Aurora Minecraft Launcher'[^\]]*'Aurora Launcher'/,
    why: '「移动便携版」推荐的文件夹、桌面快捷方式要认得以前的名字，不然另起一份，玩家以为数据没了',
    fix: '以前用过的名字只加不删' },
  { id: '正在消失的先淡出', file: 'src/renderer/js/scene/sceneents.js', re: /if \(e\.fade\) \{ e\.alpha -= [^\n]*return; \}\n\s*e\.alpha = Math\.min\(1, e\.alpha \+/,
    why: 'v1.2.2 ~ rc14：updateEnt 先「淡入」+1.5×秒、再「淡出」−1.2×秒，一帧下来反而变浓，正在消失的停在 96% 永远消失不掉、也不再动，占满数量上限不再刷新；挂机几分钟所有生物定住',
    fix: '正在消失的（e.fade）先处理、直接 return；淡入写在它后面' },
  { id: '防双开跟着数据目录', file: 'src/main/main.js', re: /require\('\.\/engine\/location'\)\.init\(\);[\s\S]*app\.requestSingleInstanceLock\(\)/,
    why: '防双开的锁跟着 userData 走：先定数据位置再拿锁，老名字和新名字的启动器才会互相让，不会两边同时写同一份配置',
    fix: 'location.init() 一定在 requestSingleInstanceLock() 之前' },
];

function scan() {
  const hits = {};
  for (const rule of RULES) hits[rule.id] = {};
  for (const f of FILES) {
    const rules = RULES.filter((r) => r.where.test(f) && !(r.skip && r.skip.test(f)));
    if (!rules.length) continue;
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/pitfall-ok/.test(line)) return;
      for (const r of rules) if (r.re.test(line)) (hits[r.id][f] || (hits[r.id][f] = [])).push(i + 1);
    });
  }
  return hits;
}

const hits = scan();
const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const r of RULES) {
    const n = Object.values(hits[r.id]).reduce((a, b) => a + b.length, 0);
    console.log(`\n【${r.id}】${n} 处${r.zero ? '（一处都不许有）' : ''}\n  为什么：${r.why}\n  该怎么写：${r.fix}`);
    for (const [f, ls] of Object.entries(hits[r.id])) console.log(`  ${f}:${ls.join(',')}`);
  }
  process.exit(0);
}
const counts = {};
for (const r of RULES) if (!r.zero) counts[r.id] = Object.fromEntries(Object.entries(hits[r.id]).map(([f, ls]) => [f, ls.length]).sort());
if (args.includes('--update')) {
  fs.writeFileSync(BASELINE, `${JSON.stringify(counts, null, 1)}\n`, 'utf8');
  console.log(`基线已更新：${BASELINE}`);
  for (const r of RULES) console.log(`  ${r.id}：${r.zero ? '一处都不许有' : `${Object.values(counts[r.id]).reduce((a, b) => a + b, 0)} 处`}`);
}
const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const problems = [];
for (const r of RULES) {
  for (const [f, ls] of Object.entries(hits[r.id])) {
    const allowed = r.zero ? 0 : ((base[r.id] || {})[f] || 0);
    if (ls.length > allowed) problems.push(`【${r.id}】${f} 第 ${ls.join('、')} 行（现在 ${ls.length} 处，基线 ${allowed} 处）\n    为什么：${r.why}\n    该怎么写：${r.fix}`);
  }
}
// 基线比现在多（修掉了几处、基线没跟着改）：空出来的名额以后能悄悄再踩回去，也算没过，要 --update 收紧（--update 的时候不报）
if (!args.includes('--update')) {
  for (const r of RULES) {
    if (r.zero) continue;
    for (const [f, n] of Object.entries(base[r.id] || {})) {
      // 公开版里换成了替身的文件（MC 百科、调试菜单的密码）：基线是按内部版记的，替身里少了是应该的
      const fp = path.join(ROOT, f);
      if (fs.existsSync(fp) && /CONCEPT: true|PUBLIC_STANDIN: true/.test(fs.readFileSync(fp, 'utf8'))) continue;
      const now = (hits[r.id][f] || []).length;
      if (now < n) problems.push(`【${r.id}】${f} 现在 ${now} 处，基线还记着 ${n} 处：修掉了的要从基线里去掉（node scripts/pitfall-check.js --update），不然空出来的 ${n - now} 处以后再踩也查不出来`);
    }
  }
}
for (const m of MUST) {
  const p = path.join(ROOT, m.file);
  if (!fs.existsSync(p) || !m.re.test(fs.readFileSync(p, 'utf8'))) problems.push(`【${m.id}】${m.file} 里少了必须一直在的写法 ${m.re}\n    为什么：${m.why}\n    该怎么写：${m.fix}`);
}
const total = RULES.reduce((s, r) => s + Object.values(hits[r.id]).reduce((a, b) => a + b.length, 0), 0);
if (problems.length) {
  console.log(`踩坑检查：${problems.length} 处比基线多（共 ${RULES.length} 条规则）`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('  确实没问题的：那一行末尾写 // pitfall-ok：原因，或者 node scripts/pitfall-check.js --update');
} else console.log(`踩坑检查：${RULES.length} 条规则，没有比基线多的（现有 ${total} 处都在基线里）；必须一直在的写法 ${MUST.length} 处都在`);
process.exitCode = problems.length ? 1 : 0;
module.exports = { RULES, MUST };
