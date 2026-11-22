'use strict';
/**
 * 纯逻辑的单元测试（2.0.0-pre8 之后，全面测试中优先级）。比端到端快得多，边界也容易覆盖。
 * electron scripts/regress/unit.js all（npm test 里跑）
 */
const path = require('path');
const { app } = require('electron');
const H = require('./harness');

const { setup, core, check, finish } = H;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 一张表：[输入, 期望]，全对才算过，错了列出来 */
function table(id, name, fn, rows) {
  const bad = [];
  for (const [input, want] of rows) {
    let got;
    try { got = fn(...(Array.isArray(input) ? input : [input])); } catch (e) { got = `抛错：${e.message}`; }
    if (!same(got, want)) bad.push({ input, want, got });
  }
  check(id, `${name}（${rows.length} 条）`, bad.length === 0, bad.slice(0, 4));
}
const throws = (fn) => (...a) => { try { fn(...a); return false; } catch { return true; } };

app.whenReady().then(async () => {
  const { root } = setup('unit');
  const base = path.join(root, 'r');
  const { cmpMc } = require(path.join(H.REPO, 'src', 'shared', 'mcver'));
  const rules = require(path.join(H.REPO, 'src', 'shared', 'pathrules'));
  const util = core('util');
  const fo = core('fileops');
  const envelope = core('envelope');
  const versions = core('versions');
  const javafit = core('javafit');
  const fmt = core('optionsfmt');
  const ts = core('troubleshoot');

  table('版本比较', 'Minecraft 版本比较', cmpMc, [
    [['1.20.1', '1.20.1'], 0], [['1.20.1', '1.20'], 1], [['1.20', '1.20.1'], -1], [['1.9', '1.10'], -1], [['1.8.9', '1.12.2'], -1], [['1.21-pre1', '1.21'], 0],
    [['26.3', '1.21.5'], 1], [['1.21.5', '26.3'], -1], [['24w14a', '1.20.4'], 1], [['b1.7.3', '1.0'], -1], [['rd-132211', '1.0'], -1],
  ]);
  table('版本比较', '启动器版本比较（pre、rc、正式）', envelope.cmpVer, [
    [['2.0.0-pre1', '2.0.0-pre2'], -1], [['2.0.0-pre10', '2.0.0-pre9'], 1], [['2.0.0-rc1', '2.0.0-pre9'], 1], [['2.0.0', '2.0.0-rc9'], 1], [['1.10.10', '1.9.9'], 1], [['1.10.10', '2.0.0-pre1'], -1], [['2.0.0', '2.0.0'], 0],
  ]);

  // ── 两个版本（内部 2.x ↔ 公开 1.x，shared/edition.js；导出文件里的版本比较，engine/envelope.js）──
  // 按这份代码是哪个版本（editions.js）来造「自己」和「另一个版本」导出的文件，两个版本里都跑
  {
    const ED = require('./editions');
    const EV = require(path.join(H.REPO, 'src', 'shared', 'edition'));
    table('两个版本', '版本号换算：内部 → 公开', EV.toPublic, [['2.0.0', '1.0.0'], ['2.0.1', '1.0.1'], ['2.3.0-rc1', '1.3.0-rc1'], ['10.2.3', '9.2.3'], ['', ''], ['abc', 'abc']]);
    table('两个版本', '版本号换算：公开 → 内部，换回去不变', (v) => [EV.toInternal(v), EV.toPublic(EV.toInternal(v))], [['1.0.0', ['2.0.0', '1.0.0']], ['1.4.2-pre3', ['2.4.2-pre3', '1.4.2-pre3']], ['9.0.0', ['10.0.0', '9.0.0']]]);
    table('两个版本', '放在一起比之前换成内部写法（没写版本的文件是公开以前的内部版）', (v, e) => EV.comparable(v, e), [[['1.0.0', 'public'], '2.0.0'], [['2.0.0', 'internal'], '2.0.0'], [['2.0.0-rc16', undefined], '2.0.0-rc16']]);
    const pkgVer = JSON.parse(require('fs').readFileSync(path.join(H.REPO, 'package.json'), 'utf8')).version;
    const keepVer = app.getVersion;
    app.getVersion = () => pkgVer; // 打包后 getVersion 就是 package.json 的版本；直接用 electron 跑脚本时不是
    try {
      const me = ED.name; const other = ED.PUBLIC ? 'internal' : 'public';
      const internalNow = EV.comparable(pkgVer, me); // 这份代码换成内部写法
      const as = (edition, internalVer) => (edition === 'public' ? EV.toPublic(internalVer) : internalVer);
      const bump = (v) => v.replace(/^(\d+)\.(\d+)\..*$/, (m, a, b) => `${a}.${+b + 1}.0`);
      const fileOf = (edition, app) => { const f = JSON.parse(envelope.seal('mod-list', { x: 1 })); f.app = app; if (edition) f.edition = edition; else delete f.edition; return JSON.stringify(f); };
      const warned = (txt) => (envelope.open(txt, 'mod-list').problems || []).map((p) => p.code);
      const sealed = JSON.parse(envelope.seal('mod-list', { x: 1 }));
      check('两个版本', `导出的文件写着是哪个版本（${me}），版本号是这份代码自己的`, sealed.edition === me && sealed.app === pkgVer, { edition: sealed.edition, app: sealed.app });
      const rows = [
        ['同一个版本、同一个号', fileOf(me, pkgVer), []],
        [`另一个版本（${other}）的同一份代码`, fileOf(other, as(other, internalNow)), []],
        [`另一个版本（${other}）更新的代码`, fileOf(other, as(other, bump(internalNow))), ['newerApp']],
        ['公开以前的内部版文件（没写 edition）、比现在旧', fileOf(null, '2.0.0-rc16'), []],
        ['公开以前的内部版文件（没写 edition）、比现在新', fileOf(null, bump(internalNow)), ['newerApp']],
      ];
      const bad = rows.filter(([, txt, want]) => JSON.stringify(warned(txt).filter((c) => c === 'newerApp')) !== JSON.stringify(want)).map(([n, txt]) => ({ n, got: warned(txt) }));
      check('两个版本', `导入另一个版本导出的文件：按同一种写法比版本，同一份代码不提示「更新的启动器」，真的更新才提示（${rows.length} 条）`, !bad.length, bad);
      const t = JSON.parse(fileOf(me, pkgVer)); t.edition = other;
      check('两个版本', '「哪个版本」不算进校验值：老版本的启动器不认识这一项，打开新文件不会说被改过', !warned(JSON.stringify(t)).includes('hash'), warned(JSON.stringify(t)));
    } finally { app.getVersion = keepVer; }
  }

  table('路径', '配置 id 只能是一层名字：能过的', (x) => fo.oneSegment(x), [['1.20.1', '1.20.1'], ['My Profile', 'My Profile'], ['我的配置', '我的配置'], ['a.b-c_d', 'a.b-c_d'], ['😀', '😀']]);
  table('路径', '配置 id 只能是一层名字：要拦的', throws((x) => fo.oneSegment(x)), [
    ['', true], ['.', true], ['..', true], ['...', true], ['.. ', true], [' ', true], ['a/b', true], ['a\\b', true], ['C:', true], ['a:b', true], ['a\0b', true], ['x'.repeat(256), true], [null, true], [undefined, true], [5, true], [{}, true], [[['a']], true],
  ]);
  table('路径', '别人给的相对路径：能过的', (x) => path.relative(base, fo.safeJoin(base, x)).split(path.sep).join('/'), [['a', 'a'], ['a/b/c.txt', 'a/b/c.txt'], ['a\\b', 'a/b'], ['./a', 'a'], ['a/./b', 'a/b'], ['世界/level.dat', '世界/level.dat']]);
  table('路径', '别人给的相对路径：要拦的', throws((x) => fo.safeJoin(base, x)), [
    ['', true], ['.', true], ['..', true], ['../x', true], ['..\\x', true], ['a/../../x', true], ['.. /x', true], ['.../x', true], ['C:\\x', true], ['C:x', true], ['/x', true], ['\\x', true], ['\\\\srv\\share', true], ['CON', true], ['a/NUL.txt', true], ['a\0b', true], [`${'x'.repeat(256)}/y`, true],
  ]);
  table('路径', 'under：在不在里面', (p, b) => fo.under(path.join(base, p), path.join(base, b)), [
    [['backups/a', 'backups'], true], [['backups', 'backups'], true], [['backups2/a', 'backups'], false], [['a', 'a/b'], false], [['BACKUPS/a', 'backups'], true],
  ]);
  // 崩溃原因：显卡不支持 OpenGL 的几种日志原话（rc11：真实启动 Forge 时碰到，游戏窗口开在远程控制软件的虚拟显示器上，
  // 以前的提示只说更新驱动）。提示里要提到远程控制这种情况
  const crashHint = (line) => { const r = core('launcher').CRASH_RULES.find(([re]) => re.test(line)); return r ? r[1] : ''; };
  table('崩溃原因', '显卡驱动不支持 OpenGL：认得出，而且提到远程控制软件的虚拟显示器', (x) => { const m = crashHint(x); return /不支持 OpenGL/.test(m) && /远程控制/.test(m) && /虚拟显示器/.test(m); }, [
    ['Trying 4.6: GLFW error: [0x10006]WGL: The driver does not appear to support OpenGL', true],
    ['GLFW error 65542: WGL: The driver does not appear to support OpenGL.', true],
    ['Pixel format not accelerated', true],
    ['[Render thread/INFO]: Backend library: LWJGL version 3.3.1 build 7', false],
  ]);
  table('路径', '网络给的文件名只留最后一段', (x) => fo.fileNameOnly(x), [['a.jar', 'a.jar'], ['../../a.jar', 'a.jar'], ['a\\b\\c.jar', 'c.jar'], ['a:b?.jar', 'a_b_.jar']]);
  table('名字', '不能用的配置名', (x) => !!rules.problemText(x, { max: 80 }), [['正常', false], ['a b', false], ['CON', true], ['nul.txt', true], ['a;b', true], ['a/b', true], ['x.', true], ['x ', true], ['x'.repeat(81), true]]);
  table('名字', 'safeName 不留非法字符', (x) => rules.nameProblem(rules.safeName(x, {}), {}) === null || !rules.nameProblem(rules.safeName(x, {}), {}), [['a/b', true], ['a:b*c?', true], ['CON', true], ['..', true], ['x.', true], ['', true]]);
  table('名字', '按字符截断不切坏 emoji', (s, n) => rules.cutChars(s, n), [[['😀😀😀', 2], '😀😀'], [['abc', 5], 'abc']]);

  table('参数', '拆 JVM 参数', util.splitArgs, [
    ['', []], ['-Xmx1G', ['-Xmx1G']], ['-Xmx1G -Xms1G', ['-Xmx1G', '-Xms1G']], ['  -a   -b  ', ['-a', '-b']], ['"-Dx=a b" -c', ['-Dx=a b', '-c']], ["-D'a b'", ['-Da b']],
  ]);
  table('库', 'Maven 坐标', util.mavenPath, [
    ['a.b:c:1', 'a/b/c/1/c-1.jar'], ['a.b:c:1:natives', 'a/b/c/1/c-1-natives.jar'], ['a.b:c:1@zip', 'a/b/c/1/c-1.zip'],
  ]);
  table('规则', '版本文件的系统规则', (r, f, arch) => versions.ruleAllows(r, f, arch), [
    [[undefined], true], [[[]], true],
    [[[{ action: 'allow' }]], true], [[[{ action: 'disallow' }]], false],
    [[[{ action: 'allow', os: { name: 'windows' } }]], true], [[[{ action: 'allow', os: { name: 'osx' } }]], false],
    [[[{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }]], false],
    [[[{ action: 'allow', features: { is_demo_user: true } }], {}], false], [[[{ action: 'allow', features: { has_custom_resolution: true } }], { has_custom_resolution: true }], true],
    [[[{ action: 'allow', os: { arch: 'x86' } }], {}, 'x64'], false],
  ]);
  table('Java', '从版本范围算最低 Java', javafit.minMajor, [
    [[['>=17']], 17], [[['>=1.8']], 8], [[['8']], 8], [[['17', '21']], 17], [[['*']], 0], [[[]], 0], [[undefined], 0], [[['abc']], 0],
  ]);
  check('Java', '崩溃日志认得出要更高的 Java', (javafit.fromLog('net/x/Y has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0', []) || {}).type !== undefined);

  table('游戏选项', 'options.txt 读写来回不变', (text) => fmt.serialize(fmt.parse(text)).replace(/\r?\n$/, ''), [
    ['version:3465\nfov:0.5', 'version:3465\nfov:0.5'], ['lang:zh_cn\nkey_key.jump:key.keyboard.space', 'lang:zh_cn\nkey_key.jump:key.keyboard.space'], ['resourcePacks:["vanilla","file/x:y.zip"]', 'resourcePacks:["vanilla","file/x:y.zip"]'],
  ]);

  table('日志', '裁日志：长行截断，总量只留末尾', (s, o) => util.clipLog(s, o), [
    [['abc', {}], 'abc'], [['abcdef\nxy', { line: 3 }], 'abc\nxy'], [['123456', { total: 3 }], '456'], [[null, {}], ''],
  ]);
  const m = new Map(Array.from({ length: 12 }, (_, i) => [i, i]));
  util.capMap(m, 10);
  check('缓存', 'capMap：超过上限丢最早的，留下的是新的', m.size <= 10 && m.has(11) && !m.has(0), [...m.keys()]);
  const m2 = new Map([[1, 1]]);
  util.capMap(m2, 10);
  check('缓存', 'capMap：没超过不动', m2.size === 1);

  const ids = (t) => ts.analyzeLog(t, []).map((i) => i.id).filter((x) => x.startsWith('missing:'));
  table('崩溃分析', '认得出缺前置', ids, [
    ["Mod 'A' (a) 1.0 requires version 1.0 or later of 'Fabric API' (fabric-api), which is missing!", ['missing:fabric-api']],
    ['- Install fabric-api, any version.', ['missing:fabric-api']],
    ["Mod ID: 'geckolib', Requested by: 'x', Expected range: '[1,)', Actual version: '[MISSING]'", ['missing:geckolib']],
    ['MissingModsException: Mod a (A) requires [b@[1,)]', ['missing:b']],
    ['普通的日志，没有问题', []],
  ]);

  // 网络盘、exFAT 的 U 盘建不了文件夹联接（2026-11-07 在群晖上实测 EISDIR）：选「共享存档」时世界不能消失，设置退回原来的
  {
    const fs2 = require('fs');
    const { game } = { game: process.env.AURORA_GAME_DIR };
    await H.fakeVersion('LinkSrc');
    await H.fakeVersion('LinkFail');
    const iso = core('isolation');
    const prof = core('profiles');
    await iso.setPolicy('LinkFail', { preset: 'isolated' });
    const dir = versions.gameDirFor('LinkFail', await versions.versionInfo('LinkFail'));
    fs2.mkdirSync(path.join(dir, 'saves', 'MyWorld'), { recursive: true });
    fs2.writeFileSync(path.join(dir, 'saves', 'MyWorld', 'level.dat'), 'mine');
    const real = fs2.promises.symlink;
    fs2.promises.symlink = async () => { throw Object.assign(new Error('EISDIR: illegal operation on a directory, symlink'), { code: 'EISDIR' }); };
    let err = null;
    try { await iso.setPolicy('LinkFail', { preset: 'shared', source: 'LinkSrc' }); } catch (e) { err = e; } finally { fs2.promises.symlink = real; }
    const meta = await prof.readMeta('LinkFail');
    check('隔离', '建不了联接：报清楚原因（LINK_UNSUPPORTED），世界还在原处，设置退回「独立」', !!err && err.reason && err.reason.code === 'LINK_UNSUPPORTED'
      && fs2.readFileSync(path.join(dir, 'saves', 'MyWorld', 'level.dat'), 'utf8') === 'mine' && (!meta.isolation || meta.isolation.preset === 'isolated'), [err && err.message, meta.isolation]);
    void game;
  }

  // 带加载器的配置和游戏版本同名：加载器的版本文件会盖掉原版、自己继承自己（2026-11-07 从真的 Prism 导入时发现）
  {
    let msgText = '';
    try { await core('loaders').install({ mc: '1.20.1', name: '1.20.1', loader: { type: 'fabric', version: '0.20.1' } }, { update() {} }); } catch (e) { msgText = e.message; }
    check('加载器', '带加载器的配置不能和游戏版本同名：装之前就说清楚，不去下载', /重名/.test(msgText), msgText);
  }

  // 游戏目录在网络盘上：提醒（2026-11-07 在群晖上实测：慢很多、Fabric 打不开、没有回收站）
  {
    const pc = core('placecheck');
    const issues = await pc.addDriveKinds([], [{ kind: 'game', dir: '\\\\MYNAS\\home\\game' }, { kind: 'data', dir: '//NAS/share/data' }, { kind: 'game', dir: '\\\\?\\C:\\very\\long' }, { kind: 'exe', dir: '\\\\NAS\\apps' }]);
    const net = issues.find((x) => x.rule === 'network');
    check('运行位置', '网络路径（\\\\服务器\\共享）提醒；本机长路径写法和 exe 不算', !!net && net.dirs.length === 2 && net.kinds.includes('game') && net.kinds.includes('data') && !net.dirs.some((d) => d.startsWith('\\\\?')), net);
    // 启动器改过名字：推荐的存放位置接着用以前按旧名字建的文件夹（rc12）
    const gamesBase = path.join(root, 'Games');
    const BR = require(path.join(H.REPO, 'src', 'shared', 'brand'));
    const pick = async () => path.basename(await pc.folderIn(gamesBase));
    const p0 = await pick();
    await require('fs').promises.mkdir(path.join(gamesBase, 'Aurora Launcher'), { recursive: true }); // pitfall-ok：以前用过的名字，测的就是它
    const p1 = await pick();
    await require('fs').promises.mkdir(path.join(gamesBase, 'Aurora Minecraft Launcher'), { recursive: true });
    const p2 = await pick();
    await require('fs').promises.mkdir(path.join(gamesBase, BR.name), { recursive: true });
    const p3 = await pick();
    check('运行位置', '推荐的文件夹：没有旧文件夹用现在的名字；有旧名字的文件夹接着用（新的旧名字优先）；现在名字的文件夹有了就用它', p0 === BR.name && p1 === 'Aurora Launcher' && p2 === 'Aurora Minecraft Launcher' && p3 === BR.name, [p0, p1, p2, p3]); // pitfall-ok：以前用过的名字
    const la = ts.analyzeLog("java.lang.RuntimeException: error remapping game jars [x]\nCaused by: java.io.IOException: the jar file \\\\NAS\\g\\.fabric\\remappedJars\\m\\client-intermediary.jar.tmp can't be written", []);
    check('崩溃分析', 'Fabric 在网络路径上写不了重新映射的 jar：说清楚原因', la.some((i) => i.id === 'remap-write'), la.map((i) => i.id));
  }

  // 一键 Debug 记住玩家回答过的画面（2026-11-07）：同一个画面（识别有错字也算）照上次的回答，「重新问我」能忘掉
  {
    await H.fakeVersion('MemProf');
    const mem = core('troubleshoot/memory');
    const s1 = { kind: 'unknown', text: 'Welcome to BetterX!\nThis mod adds new biomes\nContinue', items: [] };
    const s2 = { kind: 'unknown', text: 'Welcome to BetterX!\nThis rnod adds new biornes\nContinue', items: [] }; // 识别错了几个字
    const s3 = { kind: 'unknown', text: 'Indium is missing, Sodium needs it', items: [] };
    const before = await mem.find('MemProf', s1);
    await mem.remember('MemProf', s1, { answer: 'menu' });
    await mem.remember('MemProf', s3, { answer: 'prompt', text: '缺 Indium' });
    await mem.remember('MemProf', s1, { answer: 'menu', handled: true }); // 去游戏里处理过的不记
    const a = await mem.find('MemProf', s2);
    const b = await mem.find('MemProf', s3);
    check('一键 Debug', '回答过的画面记下了：识别有错字也认得出，「被挡住了」连抄的字一起记', !before && a && a.answer === 'menu' && b && b.answer === 'prompt' && b.typed === '缺 Indium', [a && a.answer, b && b.answer]);
    const left = await mem.forget('MemProf', a.at);
    check('一键 Debug', '「重新问我」：只忘掉这一条，别的还在', left === 1 && !(await mem.find('MemProf', s1)) && !!(await mem.find('MemProf', s3)));
    // 每条文字都不一样（相近的会被当成同一个画面合并）
    const distinct = (i) => Array.from({ length: 10 }, (_, k) => (((i + 1) * 104729 + k * 7919) ** 2 % 2176782336).toString(36)).join(' ');
    for (let i = 0; i < 25; i++) await mem.remember('MemProf', { text: `#${i} ${distinct(i)}` }, { answer: 'menu' });
    const meta = await core('profiles').readMeta('MemProf');
    check('一键 Debug', '最多记 20 条（新的在前）', meta.screenAnswers.length === mem.MAX && meta.screenAnswers[0].text.startsWith('#24 '), meta.screenAnswers.length);
  }

  // 从 2.0.0-rc1 起封存繁体语言包：内部版也不打包，只留在私人仓库
  // 这一项只在内部仓库有意义：公开仓库里没有 scripts/edition.js，也没有那两个语言包（rc10：以前这里直接 require，公开仓库里一跑就报错）
  if (require('./editions').privateRepo) {
    const pkg = JSON.parse(require('fs').readFileSync(path.join(H.REPO, 'package.json'), 'utf8'));
    const hant = require(path.join(H.REPO, 'scripts', 'edition')).HANT_FILES.filter((f) => f.startsWith('src/'));
    check('封存繁体', '内部版打包也不带繁体语言包', hant.length === 2 && hant.every((f) => pkg.build.files.includes(`!${f}`)), hant);
  } else {
    const fsx = require('fs');
    const left = ['tr-zh-TW.js', 'tr-zh-HK.js'].filter((f) => fsx.existsSync(path.join(H.REPO, 'src', 'shared', 'i18n', f)));
    check('封存繁体', '公开仓库里没有繁体语言包', left.length === 0, left);
  }

  // 显卡加速用不了时背景定格（2026-11-07 用核显 / 软件渲染实测后加的）
  const bgfit = core('bgfit');
  const hw = (soft) => ({ gpus: [{ name: 'AMD Radeon 780M Graphics', tier: 2, discrete: false }], cpu: { tier: 2, name: 'Ryzen 7' }, ramMB: 16384, softwareRender: soft });
  const [hard, soft] = [await bgfit.advice(hw(false)), await bgfit.advice(hw(true))];
  check('背景档位', '显卡加速用不了（软件渲染）：推荐定格，硬件指纹也不同；能用时照常推荐', soft.tier === 'static' && soft.perfHint && hard.tier !== 'static' && soft.hwKey !== hard.hwKey, [hard.tier, soft.tier]);

  // MC 百科简介的测试在 mcmod-unit.js（只在内部仓库，公开版没有 MC 百科的读取实现）

  // 结构化消息（2026-11-07）：主进程按语言出句子，列表、名字、单复数都对；src/main 里用到的每个模板英文字典都有
  const fs = require('fs');
  const i18n = require(path.join(H.REPO, 'src', 'shared', 'i18n'));
  const was = i18n.getLang();
  i18n.setLang('zh-CN');
  table('结构化消息', '简中：模板原样填，列表用「、」「；」「：」', (f) => f(), [
    [[() => i18n.msg('导入了{what}。{notes}', { what: ['1 个游戏配置', '2 个账户'], notes: i18n.join(['甲', '乙'], 'clause') })], '导入了1 个游戏配置、2 个账户。甲；乙'],
    [[() => i18n.join([i18n.nm('配置'), i18n.join(['新增 1 个', ''], 'comma')], 'colon')], '配置：新增 1 个'],
  ]);
  const box = { window: {} };
  require('vm').runInNewContext(fs.readFileSync(path.join(H.REPO, 'src', 'shared', 'i18n', 'tr-en.js'), 'utf8'), box);
  const dict = box.window.I18N_TR.en;
  globalThis.I18N_TR = { ...(globalThis.I18N_TR || {}), en: dict };
  i18n.setLang('en');
  const plain = (s) => s.replace(/[⁨⁩]/g, '|');
  table('结构化消息', '英文：查字典的译文，名字原样带标记，列表用逗号，1 个改单数', (f) => plain(f()), [
    [[() => i18n.msg('{n} 个游戏配置', { n: 1 })], '1 game profile'],
    [[() => i18n.msg('同名的世界改名导入：{list}', { list: [i18n.nm('新世界'), i18n.nm('World')] })], 'Worlds with the same name were imported under new names: |新世界|, |World|'],
    [[() => i18n.join([i18n.nm('我的配置'), i18n.join([i18n.msg('新增 {n} 个', { n: 2 })], 'comma')], 'colon')], '|我的配置|: added 2'],
  ]);
  const missing = [];
  const walkSrc = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walkSrc(f); else if (/\.js$/.test(e.name)) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bmsg\('((?:[^'\\]|\\.)+)'/g)) if (dict[m[1]] == null) missing.push(`${path.relative(H.REPO, f)}: ${m[1]}`); } };
  walkSrc(path.join(H.REPO, 'src', 'main'));
  check('结构化消息', '主进程用到的每个消息模板英文字典里都有', missing.length === 0, missing.slice(0, 6));
  i18n.setLang(was);
  finish();
});
app.on('window-all-closed', () => {});
