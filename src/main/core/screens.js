'use strict';
/**
 * 测试启动时认出「挡在主菜单前面的提示画面」
 *  - look      进入主菜单后截游戏窗口，用 Windows 自带的文字识别（Windows.Media.Ocr）读出画面上的字，
 *              分成：主菜单 / 原版第一次启动的辅助功能欢迎画面 / 加载器警告画面 / 没见过的提示 / 还在加载
 *  - notices   从日志和画面文字里整理出提示，配中文说明和处理办法（形状和 analyzeLog 的 issue 一样，界面共用 issueList）
 * Forge 47 的黄色警告画面、Fabric 的「Warnings were found!」都是真实启动收集的原话。
 * 截图或识别不可用（不是 Windows、窗口被最小化、系统没有识别语言）时只用日志，结果照常返回。
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { desktopCapturer } = require('electron');
const paths = require('../engine/paths');
const { sleep } = require('../engine/util');
const { writeFileSafe } = require('../engine/fileops');
const { t } = require('../../shared/i18n');
const { nm, nmJoin } = require('../../shared/i18n');

// ───────────────────────── 截图与文字识别 ─────────────────────────
const OCR_PS1 = `param([string]$Path, [string]$Langs)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$have = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }
foreach ($l in $Langs.Split(',')) {
  if (-not ($have | Where-Object { $_ -like "$l*" })) { continue }
  $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($l))
  if (-not $eng) { continue }
  $res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  Write-Output "##LANG $l"
  $res.Lines | ForEach-Object { $_.Text }
}
`;

async function ocrScript() {
  const p = path.join(paths.cacheDir(), 'ocr', 'ocr.ps1');
  try { if ((await fsp.readFile(p, 'utf8')) === OCR_PS1) return p; } catch { /* 第一次用 */ }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, OCR_PS1, 'utf8');
  return p;
}

/** 识别图片里的文字，返回 { 'en-US': [行…], 'zh-Hans-CN': [行…] }；不可用时返回 null */
async function ocr(png, langs) {
  if (process.platform !== 'win32') return null;
  const script = await ocrScript();
  const out = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', png, '-Langs', langs.join(',')],
      { windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (!out) return null;
  const res = {};
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^##LANG (\S+)/);
    if (m) { cur = m[1]; res[cur] = []; } else if (cur && line.trim()) res[cur].push(line.trim());
  }
  return Object.keys(res).length ? res : null;
}

/** 截游戏窗口（标题以 Minecraft 开头，有多个时优先标题里带这个 MC 版本的） */
async function capture(mc) {
  try {
    const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 720 } });
    const games = srcs.filter((s) => /^Minecraft/i.test(s.name) && !s.thumbnail.isEmpty());
    const w = games.find((s) => mc && s.name.includes(mc)) || games[0];
    return w ? w.thumbnail : null;
  } catch { return null; }
}

// ───────────────────────── 画面分类 ─────────────────────────
// 识别结果会有错字（Quit → auit、Realms → fiealms；中文按字拆开还会认错：单人蝣戏、退出渫戏），
// 所以先去掉空白再比，只用不容易认错的词；主菜单要同时认出两个按钮才算
const MENU_MARKS = [/单人/, /多人/, /退出/, /Singleplayer/i, /Multiplayer/i, /Realms/i];
const ONBOARD_RE = /WelcometoMinecraft|enabletheNarrator|欢迎来到Minecraft|讲述者/i;
const LOADING_RE = /MOJANG|Loading|正在加载/i;
// Forge 黄色警告画面（中文画面的原文是「Mod 加载警告 / 加载时发生了 1 个警告 / 打开 Mod 文件夹 / 继续返回主菜单」）
const FORGE_WARN_RE = /Warnings?whileloadingmods|warnings?ha(?:s|ve)occurredduringloading|加载时发生了|Mod加载.?告/i;
const FORGE_BUTTONS_RE = /OpenModsFolder|Openlatest|Proceedtomainmenu|打开Mod文件夹|返回主菜单|打开.{0,3}log/i;
const flat = (s) => String(s || '').replace(/\s+/g, '');

function classify(lines) {
  // 第一行是窗口标题（「Minecraft* Forge 1.20.1」，中文识别会认成「M 飩 Forge L20」这样）
  const body = lines.filter((l, i) => !(i === 0 && /^M\S*\s/.test(l) && l.length < 32));
  const text = body.join('\n');
  const f = flat(text);
  if (MENU_MARKS.filter((re) => re.test(f)).length >= 2) return { kind: 'menu' };
  if (ONBOARD_RE.test(f)) return { kind: 'onboarding' };
  if (FORGE_WARN_RE.test(f) || (FORGE_BUTTONS_RE.test(f) && /告|warn/i.test(f))) {
    const items = body.filter((l) => !FORGE_WARN_RE.test(flat(l)) && !FORGE_BUTTONS_RE.test(flat(l)) && flat(l).length > 8);
    return { kind: 'loader-warning', items, text };
  }
  if (!text.trim() || (LOADING_RE.test(text) && body.length <= 4)) return { kind: 'loading' };
  return { kind: 'unknown', items: body.filter((l) => l.length > 2), text };
}

function gameLangs(gameDir) {
  let lang = '';
  try { lang = (fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8').match(/^lang:(\S+)/m) || [])[1] || ''; } catch { /* 没有 options.txt */ }
  return /^zh/i.test(lang) ? ['zh-Hans-CN', 'en-US'] : ['en-US', 'zh-Hans-CN'];
}

/**
 * 进入主菜单后看一眼游戏画面。还在加载时每隔几秒再看，没见过的提示要连续两次一样才算（提示画面是静止的）
 * @returns {Promise<null|{kind, items?, text?, image?:string}>} image 是 JPEG 的 data URL，界面上给玩家看
 */
async function look(game, { mc, isAlive, budget = 45000, onLook = () => {} } = {}) {
  const end = Date.now() + budget;
  const langs = gameLangs(game.gameDir);
  const tmp = path.join(paths.cacheDir(), 'ocr', `shot-${game.id}.png`);
  let last = null;
  let unknownSeen = 0;
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
  try {
    while (Date.now() < end && isAlive()) {
      onLook();
      const img = await capture(mc);
      if (!img) return null;
      await fsp.writeFile(tmp, img.toPNG());
      const res = await ocr(tmp, langs);
      if (!res) return null;
      // 各语言分别分类，取最确定的一种（主菜单 > 欢迎画面 > 加载器警告 > 没见过的提示 > 加载中）
      const ranked = Object.values(res).map(classify).sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind));
      const best = ranked[0];
      const shot = { ...best, image: `data:image/jpeg;base64,${img.toJPEG(78).toString('base64')}` };
      if (best.kind === 'menu' || best.kind === 'onboarding' || best.kind === 'loader-warning') return shot;
      // 认识的提示（欢迎页、缺 Indium…）看一次就够；没见过的看到第二次（或连看三次还在变，比如背景会动的欢迎页）就定下来，
      // 不再等满 45 秒（1.4.7：玩家反馈「卡在正在查看游戏画面，过好久才让我填」）
      if (best.kind === 'unknown' && (matchKnown(best.text) || (last && last.kind === 'unknown' && (same(last.text, best.text) || ++unknownSeen >= 2)))) return shot;
      last = shot;
      await sleep(best.kind === 'loading' ? 4000 : 1500);
    }
    return last && last.kind === 'unknown' ? last : null;
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
}
const RANK = ['menu', 'onboarding', 'loader-warning', 'unknown', 'loading'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
/** 两次识别是不是同一个画面：识别会有零星错字，按两个字一组的重合度比（超过 6 成算同一个） */
function same(a, b) {
  const pairs = (s) => { const x = norm(s); const out = new Set(); for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2)); return out; };
  const x = pairs(a);
  const y = pairs(b);
  if (!x.size || !y.size) return false;
  let n = 0;
  for (const p of x) if (y.has(p)) n++;
  return n / Math.max(x.size, y.size) > 0.6;
}

// ───────────────────────── 提示整理与中文说明 ─────────────────────────
const stem = (f) => norm(path.basename(String(f || '')).replace(/\.disabled$/, '').replace(/\.jar$/i, ''));
/** 一行文字里提到了哪些已装的 Mod（文件名、Mod ID、名称；识别出来的文件名常有错字，比较时只看字母数字） */
function modsIn(line, list) {
  const s = norm(line);
  if (!s) return [];
  return list.filter((m) => {
    const keys = [stem(m.file), norm(m.name), ...(m.ids || []).map(norm)].filter((k) => k && k.length >= 4);
    return keys.some((k) => s.includes(k));
  });
}

// Forge 的 brokenfile 警告（fml.modloading.brokenfile.*，Forge 语言文件里的原文）
// 中文画面按字识别会认错（「是无法加载的旧版本 Forge」认成「是元法加的旧版本orge」），去掉空白后用短词比
const BROKEN = [
  [/isaFabricmod|是.{0,4}Fabric/i, 'notice.brokenFabric'],
  [/olderversionofForge|旧版本?.{0,3}orge/i, 'notice.brokenOldForge'],
  [/LiteLoader/i, 'notice.brokenLiteLoader'],
  [/OptiFine/i, 'notice.brokenOptifine'],
  [/Bukkit|Spigot|插件/i, 'notice.brokenBukkit'],
  [/notajarfile|不是.{0,4}jar/i, 'notice.brokenZip'],
  [/notavalidmodfile|不是.{0,6}有效|无效的?Mod/i, 'notice.brokenInvalid'],
];
// 认识的 Mod 提示画面（真实截到的）：给具体的说明和处理办法
//  - 「警告：客户端未找到 Indium」：内嵌 noindium 的 Mod（Modern Industrialization 等）+ Sodium 0.5 没装 Indium（中文识别常把 Indium 认成 lndium / lndiun）
const KNOWN_SCREENS = [
  { re: /[il1|]ndiu[mn]/i, also: /Sodium/i, not: /no longer|not needed|不再需要/i, make: () => notice('screen:indium', { type: 'screen', title: t('notice.indiumTitle'), detail: t('notice.indiumScreen'), modId: 'indium', fix: { kind: 'install-dep', modId: 'indium' }, autoInstall: 'indium' }) },
  //  - Mod 第一次启动的欢迎页（BCLib：「欢迎来到 BetterX…非常感谢您下载并使用我们的模组…在开始之前，我们需要设置一些东西」，页面还能滚动）。
  //    测试启动会自动关游戏，「看过了」存不下来，每次测试都会再弹；BCLib 有开关可以关掉（TWEAKS）
  //    1.4.7：玩家实测的画面写的是「欢迎游玩本模组」，原来要求「欢迎来到」+「感谢 / 设置」太严，认不出来就去问玩家了。
  //    放宽成「欢迎」+ 任一常见词；画面上直接写着 BetterX / BCLib 的也算
  { re: /欢迎|Welcome|BetterX|Better ?End|Better ?Nether|BCLib/i, also: /感谢|谢谢|thank|开始之前|before (?:you|we)|设置|setup|set up|游玩|使用|模组|\bmods?\b|继续|continue|proceed|完成|done|BetterX|BCLib/i,
    make: (list) => {
      const bclib = list.some((m) => [...(m.ids || []), ...(m.provides || [])].includes('bclib'));
      return notice('screen:welcome', { severity: bclib ? 'warn' : 'info', type: 'screen', title: t(bclib ? 'notice.bclibWelcome' : 'notice.welcomeTitle'), detail: t(bclib ? 'notice.bclibWelcomeDetail' : 'notice.welcomeDetail'), fix: bclib ? { kind: 'tweak', tweak: 'bclib-welcome' } : null, autoTweak: bclib ? 'bclib-welcome' : null });
    } },
];

// 能替玩家关掉的提示画面：改 Mod 自己的配置开关（一键 Debug 自动做，记进改动，可以撤销）
const TWEAKS = {
  'bclib-welcome': { file: 'config/bclib/client.json', section: 'version', key: 'didShowWelcome', label: 'notice.tweakBclib' },
};
/** 打开（on=true）或恢复一个开关；配置文件还不存在时新建一份只含这个键的 */
async function applyTweak(gameDir, id, on = true) {
  const tw = TWEAKS[id];
  if (!tw) throw new Error(`未知的处理：${nm(id)}`);
  const file = path.join(gameDir, tw.file);
  let j = {};
  try { j = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* 没有就新建 */ }
  const sec = (j[tw.section] = j[tw.section] || {});
  const k = Object.keys(sec).find((x) => x === tw.key || x.startsWith(`${tw.key} [`)) || `${tw.key} [default: false]`;
  sec[k] = !!on;
  await writeFileSafe(file, JSON.stringify(j, null, 2), 'utf8');
  return { file, label: t(tw.label) };
}
/** 画面是不是「认识的提示」（认识的就不用再问玩家）。中文识别把字拆开了，原文和去掉空白的都比 */
function matchKnown(text) {
  const s = `${text || ''}\n${flat(text)}`;
  return KNOWN_SCREENS.find((k) => k.re.test(s) && (!k.also || k.also.test(s)) && !(k.not && k.not.test(s)));
}
const knownScreen = (screen) => !!screen && !!matchKnown(screen.text);
// 没见过的提示：按关键词猜大意（只用来写中文概括，原文照样给玩家看）。中文识别会把字拆开，比之前先去掉空白
const GIST = [
  [/no longer (?:needed|required)|not (?:needed|required) any ?more|is (?:now )?(?:obsolete|redundant|unnecessary)|不再需要/i, 'notice.gistObsolete'],
  [/optifine/i, 'notice.gistOptifine'],
  [/incompatible|not compatible|conflicts?\b|不兼容|冲突/i, 'notice.gistIncompatible'],
  [/outdated|out of date|newer version|update (?:is )?available|please update|过时|更新/i, 'notice.gistOutdated'],
  [/requires|missing|please install|not installed|not found|缺少|未找到|找不到|没有安装/i, 'notice.gistMissing'],
  [/please (?:remove|delete|uninstall)|should be removed|删除/i, 'notice.gistRemove'],
];

function notice(id, o) { return { id, severity: 'warn', ...o }; }

/** 只看日志就能认出的提示 */
function fromLog(text, list) {
  const out = [];
  const seen = new Set();
  const add = (n) => { if (!seen.has(n.id)) { seen.add(n.id); out.push(n); } };
  let m;
  // Forge：放进 mods 却加载不了的文件（黄色警告画面上的条目，日志里只有这一行）
  const invalid = /InvalidModFileException: ([^\n]*?) in file \(([^)\n]+)\)/g;
  while ((m = invalid.exec(text))) {
    const files = list.filter((x) => stem(x.file) === stem(m[2])).map((x) => x.path);
    add(notice(`broken:${m[2]}`, { type: 'broken-file', file: m[2], title: t('notice.brokenInvalid', { file: nm(m[2]) }), detail: t('notice.brokenDetail'), raw: m[0], files, fix: { kind: 'disable', files }, auto: files.length > 0 }));
  }
  // Fabric：「Warnings were found!」下面的冲突和建议
  const conflict = /Mod '([^'\n]+)' \(([\w.-]+)\) \S+ conflicts with (?:any version of |version [^\n]*? of )?mod '([^'\n]+)' \(([\w.-]+)\)[^\n]*/g;
  while ((m = conflict.exec(text))) {
    const files = [...list.filter((x) => (x.ids || []).includes(m[2])), ...list.filter((x) => (x.ids || []).includes(m[4]))].map((x) => x.path);
    add(notice(`conflict:${m[2]}:${m[4]}`, { type: 'conflict', title: t('notice.conflict', { a: nm(m[1]), b: nm(m[3]) }), detail: t('notice.conflictDetail', { a: nm(m[1]) }), raw: m[0], files, fix: { kind: 'choose', files } }));
  }
  const recMissing = /Mod '([^'\n]+)' \(([\w.-]+)\) \S+ recommends (?:any version|version (\S+) or later|version [^\n]*?) of (?:mod '([^'\n]+)' \()?([\w.-]+)\)?, which is missing[^\n]*/g;
  while ((m = recMissing.exec(text))) {
    add(notice(`recommend:${m[5]}`, { severity: 'info', type: 'recommend', title: t('notice.recommend', { a: nm(m[1]), b: nm(m[4] || m[5]) }), detail: t('notice.recommendDetail'), raw: m[0], modId: m[5], fix: { kind: 'install-dep', modId: m[5] } }));
  }
  const recWrong = /Mod '([^'\n]+)' \(([\w.-]+)\) \S+ recommends (version [^\n]*?|any version) of (?:mod '([^'\n]+)' \()?([\w.-]+)\)?, but only the wrong version is present: ([^\n!]+)[^\n]*/g;
  while ((m = recWrong.exec(text))) {
    add(notice(`recommend:${m[5]}`, { severity: 'info', type: 'recommend', title: t('notice.recommendVer', { a: nm(m[1]), b: nm(m[4] || m[5]) }), detail: t('notice.recommendVerDetail', { want: m[3].replace(/^version /, ''), have: m[6].trim() }), raw: m[0], modId: m[5], fix: { kind: 'install-dep', modId: m[5], update: true } }));
  }
  // Mod 自己在日志里说的话：只认「不再需要 / 请删除」这类，提到了哪个 Mod 就给禁用按钮，不自动处理
  for (const line of text.split('\n')) {
    if (!/\b(WARN|ERROR)\b/.test(line) || /mixin|ForgeConfigSpec|Reference map/i.test(line)) continue;
    if (!/no longer (?:needed|required)|not (?:needed|required) any ?more|please (?:remove|delete|uninstall)|should be removed/i.test(line)) continue;
    const hit = modsIn(line.replace(/^.*?\]: /, ''), list);
    const raw = line.replace(/^\[\w+\]\s*/, '').trim();
    add(notice(`obsolete:${norm(raw).slice(0, 60)}`, { type: 'mod-says', title: hit.length ? t('notice.obsoleteMod', { name: nm(hit[0].name || hit[0].file) }) : t('notice.gistObsolete'), detail: t('notice.modSaysDetail'), raw, files: hit.map((x) => x.path), fix: hit.length ? { kind: 'disable', files: hit.map((x) => x.path) } : null }));
    if (out.length > 10) break;
  }
  return out;
}

/** 把画面上的提示整理成 notices（日志已经认出的同一个文件不再重复） */
function fromScreen(screen, list, logNotices) {
  if (!screen || (screen.kind !== 'loader-warning' && screen.kind !== 'unknown')) return [];
  const out = [];
  if (screen.kind === 'loader-warning') {
    for (const line of screen.items) {
      const rule = BROKEN.find(([re]) => re.test(flat(line)));
      const fileM = line.match(/^File\s+(.+?)\s+(?:is|was)\b/i);
      const hit = modsIn(fileM ? fileM[1] : line, list);
      // 日志里认出的同一个文件：文件名对得上就合并；识别得太乱对不上时，按顺序认领日志里还没合并的那条
      const known = logNotices.find((n) => n.type === 'broken-file' && !n.merged && hit.some((x) => n.files.includes(x.path)))
        || (!hit.length && rule ? logNotices.find((n) => n.type === 'broken-file' && !n.merged) : null);
      if (known) {
        known.merged = true;
        if (rule) known.title = t(rule[1], { file: known.file });
        known.raw = `${line}\n${known.raw}`;
        continue;
      }
      const file = hit[0] ? hit[0].file : fileM ? fileM[1] : '';
      const files = hit.map((x) => x.path);
      out.push(notice(`screen:${norm(line).slice(0, 60)}`, {
        type: rule ? 'broken-file' : 'loader-warning',
        title: rule ? t(rule[1], { file }) : t('notice.loaderWarning'),
        detail: rule ? t('notice.brokenDetail') : t('notice.loaderWarningDetail'),
        raw: line, files, fix: files.length ? { kind: 'disable', files } : null, auto: !!rule && files.length > 0,
      }));
    }
    return out;
  }
  const known = matchKnown(screen.text);
  if (known) return [{ ...known.make(list), raw: screen.items.join('\n') }];
  // 没见过的提示：整屏是一条，按关键词写中文大意，提到的 Mod 给禁用按钮
  const gist = GIST.find(([re]) => re.test(screen.text) || re.test(flat(screen.text)));
  const hit = modsIn(screen.text, list);
  out.push(notice('screen:unknown', {
    type: 'screen', title: gist ? t(gist[1]) : t('notice.unknownScreen'),
    detail: hit.length ? t('notice.screenMods', { names: nmJoin(hit.slice(0, 4).map((x) => x.name || x.file)) }) : t('notice.unknownScreenDetail'),
    raw: screen.items.join('\n'), files: hit.map((x) => x.path), fix: hit.length === 1 ? { kind: 'disable', files: [hit[0].path] } : hit.length > 1 ? { kind: 'choose', files: hit.map((x) => x.path) } : null,
  }));
  return out;
}

module.exports = { look, fromLog, fromScreen, classify, ocr, knownScreen, applyTweak, TWEAKS, same };
