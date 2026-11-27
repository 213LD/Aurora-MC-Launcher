'use strict';
/**
 * 游戏启动：组装参数、解压 natives、启动进程、解析日志、崩溃分析
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const config = require('../engine/config');
const gamelogs = require('./gamelogs');
const { tagged } = require('./loglevel');
const versions = require('./versions');
const javaMgr = require('./java');
const BRAND = require('../../shared/brand');
const i18n = require('../../shared/i18n');
const accounts = require('./auth/accounts');
const isolation = require('./isolation');
const { withZip } = require('../engine/zip');
const { exists, splitArgs, osName, totalMemMB, freeMemMB, rmrf, throwIfAborted, clipLog } = require('../engine/util');
const { writeFileSafe } = require('../engine/fileops');
const { lineDecoder } = require('../engine/procenc');
const { withReason } = require('../engine/errors');
const { nm } = require('../../shared/i18n');

let seq = 0;
const games = new Map();
let emit = () => {};
function setEmitter(fn) { emit = fn; }

// ───────────────────────── 内存 ─────────────────────────
function autoMemory(modded) {
  const total = totalMemMB();
  const free = freeMemMB();
  let target = modded ? 6144 : 4096;
  target = Math.min(target, Math.floor(total * 0.5));
  // 可用内存紧张时适当降低
  target = Math.min(target, Math.max(free + 1024, 2048));
  target = Math.max(target, Math.min(2048, Math.floor(total * 0.6)));
  return Math.max(1024, Math.round(target / 256) * 256);
}

function memoryFor(id, info) {
  const vs = config.getVersionSettings(id);
  const g = config.get().memory;
  const modded = !!(info && info.loader);
  if (vs.memoryMode === 'custom' && vs.memoryMax) return { max: vs.memoryMax, min: Math.min(g.min || 256, vs.memoryMax) };
  if (vs.memoryMode === 'auto' || g.auto) return { max: autoMemory(modded), min: Math.min(g.min || 256, 1024) };
  return { max: g.max, min: Math.min(g.min || 256, g.max) };
}

// ───────────────────────── natives ─────────────────────────
async function extractNatives(natives, baseDir) {
  let dir = baseDir;
  try {
    await rmrf(dir);
  } catch {
    // 同一版本已有实例在运行时 dll 被占用，改用新的目录
    dir = `${baseDir}-${Date.now().toString(36)}`;
  }
  await fsp.mkdir(dir, { recursive: true });
  for (const n of natives) {
    if (!(await exists(n.path))) continue;
    await withZip(n.path, (z) => z.extractAll(dir, {
      filter: (e) => {
        if (e.isDirectory) return false;
        if ((n.exclude || []).some((ex) => e.name.startsWith(ex))) return false;
        if (n.flatten) return /\.(dll|so|dylib|jnilib)$/i.test(e.name);
        return !e.name.endsWith('.sha1') && !e.name.endsWith('.git');
      },
      map: (e) => (n.flatten ? path.basename(e.name) : e.name),
    }));
  }
  return dir;
}

// ───────────────────────── 参数 ─────────────────────────
function expandArgs(list, vars, features) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') out.push(a);
    else if (a && versions.ruleAllows(a.rules, features, vars.__arch)) {
      if (Array.isArray(a.value)) out.push(...a.value);
      else if (a.value != null) out.push(a.value);
    }
  }
  return out.map((s) => s.replace(/\$\{([^}]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
}

/** 新游戏目录的游戏语言跟着启动器语言：简中 zh_cn；英文不改（返回 null） */
function langOption(mc) {
  const l = i18n.LANGS.find((x) => x.id === i18n.getLang());
  let code = l ? l.game : 'zh_cn';
  if (!code) return null;
  const m = String(mc).match(/^1\.(\d+)/);
  const minor = m ? parseInt(m[1], 10) : 99;
  if (code === 'zh_hk' && minor < 13) code = 'zh_tw'; // 香港繁中 1.13 才有，更老的版本用台湾繁中
  // 1.11 以前语言代码后半截大写
  return minor < 11 ? code.replace(/_(\w+)$/, (x, c) => `_${c.toUpperCase()}`) : code;
}

/** 字幕 1.9 起才有；新的版本号（26.x）和快照都算有 */
function hasSubtitles(mc) {
  const m = String(mc || '').match(/^(\d+)\.(\d+)/);
  if (!m) return true;
  return Number(m[1]) > 1 || Number(m[2]) >= 9;
}

/** 新的游戏目录第一次启动（还没有 options.txt）时写入初始选项：简体中文、无障碍里的「默认打开游戏字幕」 */
async function ensureFirstOptions(gameDir, mc) {
  const cfg = config.get();
  const lines = [];
  const lang = cfg.autoChinese && langOption(mc);
  if (lang) lines.push(`lang:${lang}`);
  if (cfg.a11y && cfg.a11y.subtitles && hasSubtitles(mc)) lines.push('showSubtitles:true');
  if (!lines.length) return;
  const p = path.join(gameDir, 'options.txt');
  if (await exists(p)) return;
  await fsp.mkdir(gameDir, { recursive: true });
  await writeFileSafe(p, `${lines.join('\n')}\n`, 'utf8');
}

const DEFAULT_GC = ['-XX:+UseG1GC', '-XX:+UnlockExperimentalVMOptions', '-XX:G1NewSizePercent=20', '-XX:G1ReservePercent=20', '-XX:MaxGCPauseMillis=50', '-XX:G1HeapRegionSize=32M'];

async function buildLaunch(id, auth, java, task, bo = {}) {
  const cfg = config.get();
  const vs = config.getVersionSettings(id);
  const info = await versions.versionInfo(id);
  const v = await versions.resolveVersion(id);
  const gameDir = versions.gameDirFor(id, info);
  await fsp.mkdir(gameDir, { recursive: true });
  // 存档 / 配置隔离策略（共享、测试副本）。这个配置已经有游戏开着时（再启动一个实例）不动目录
  const isolationNotes = await isolation.prepare(id, gameDir, { task, inUse: !!(await require('./gamelock').forVersion(id)) });
  // 旧版 Forge Mod 在运行时下载的库（原地址已失效）
  const mcv = info ? info.mcVersion : v._mcVersion;
  let legacy = { notes: [], problems: [] };
  if (info && info.loader && info.loader.type === 'forge' && /^1\.[4-7](\.|$)/.test(mcv || '')) {
    legacy = await require('./legacydeps').prepare(gameDir, mcv, task);
  }

  const win = { ...cfg.window, ...(vs.window || {}) };
  const server = vs.server && vs.server.enabled ? vs.server : cfg.server;
  const autoJoin = server && server.enabled && server.address ? server.address.trim() : '';
  const hasQuickPlay = JSON.stringify((v.arguments && v.arguments.game) || []).includes('is_quick_play_multiplayer');

  const features = {
    has_custom_resolution: !win.fullscreen,
    is_demo_user: false,
    is_quick_play_multiplayer: !!(autoJoin && hasQuickPlay),
  };

  const libs = versions.collectLibraries(v, { arch: java.arch, features });
  task.update({ detail: '解压本地库…', progress: -1 });
  // 分号会把 -cp 和 java.library.path 切开，Java 找不到主类，一启动就退出（实测「游戏启动后立即退出（代码 1）」）。
  // 现在起不了这种名字，老配置和带分号的游戏目录在这里说清楚
  if (versions.versionDir(id).includes(';') || versions.librariesDir().includes(';')) {
    const inName = id.includes(';');
    throw withReason(inName ? `配置名「${nm(id)}」里有分号，Java 认不出这样的路径，游戏进不去。先把配置改个名字再启动。` : `游戏目录的路径里有分号，Java 认不出这样的路径，游戏进不去：${versions.gameRoot()}`,
      { code: 'PATH_SEMICOLON', message: '路径里有分号', hint: inName ? '重命名这个配置，去掉分号' : '把游戏目录换到路径里没有分号的地方' });
  }
  const nativesDir = await extractNatives(libs.natives, path.join(versions.versionDir(id), `natives-${osName()}-${java.arch}`));

  const legacyAssets = await versions.prepareLegacyAssets(v, gameDir);
  const sep = process.platform === 'win32' ? ';' : ':';
  const jar = versions.versionJarPath(v._jarId);
  const cp = [...libs.classpath.filter((p) => fs.existsSync(p)), jar];

  const vars = {
    __arch: java.arch,
    auth_player_name: auth.name,
    version_name: id,
    game_directory: gameDir,
    assets_root: versions.assetsDir(),
    game_assets: legacyAssets || versions.assetsDir(),
    assets_index_name: (v.assetIndex && v.assetIndex.id) || v.assets || 'legacy',
    auth_uuid: auth.uuid,
    auth_access_token: auth.accessToken,
    auth_session: auth.type === 'microsoft' || auth.type === 'yggdrasil' ? `token:${auth.accessToken}:${auth.uuid}` : auth.accessToken,
    auth_xuid: auth.xuid || '0',
    clientid: cfg.clientToken,
    user_type: auth.userType,
    user_properties: '{}',
    version_type: (vs.versionType || cfg.versionType || v.type || 'release'),
    natives_directory: nativesDir,
    launcher_name: BRAND.short,
    launcher_version: app.getVersion(),
    classpath: cp.join(sep),
    classpath_separator: sep,
    library_directory: versions.librariesDir(),
    primary_jar: jar,
    resolution_width: win.width || 854,
    resolution_height: win.height || 480,
    quickPlayMultiplayer: autoJoin,
    quickPlayPath: path.join(gameDir, 'quickPlay', 'log.json'),
  };

  const mem = memoryFor(id, info);
  if (java.arch === 'x86') mem.max = Math.min(mem.max, 1024);
  const userJvm = splitArgs(vs.jvmArgs || cfg.jvmArgs || '');
  const jvm = [`-Xmx${mem.max}m`, `-Xms${Math.min(mem.min, mem.max)}m`];
  if (!userJvm.some((a) => /^-XX:\+Use\w+GC$/.test(a))) jvm.push(...DEFAULT_GC);
  jvm.push(
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-Djava.rmi.server.useCodebaseOnly=true',
    '-Dcom.sun.jndi.rmi.object.trustURLCodebase=false',
    '-Dcom.sun.jndi.cosnaming.object.trustURLCodebase=false',
    '-Dlog4j2.formatMsgNoLookups=true',
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    '-Dfml.ignorePatchDiscrepancies=true',
  );

  // 日志配置（官方修补过 Log4Shell 的配置，输出为 XML 事件）
  const logCfg = v.logging && v.logging.client;
  let xmlLog = false;
  if (logCfg && logCfg.file) {
    const p = path.join(versions.assetsDir(), 'log_configs', logCfg.file.id);
    if (await exists(p)) {
      jvm.push(logCfg.argument.replace('${path}', p));
      xmlLog = true;
    }
  }

  if (v.arguments && v.arguments.jvm) {
    // 1.17+ 的 Forge / NeoForge 不带自己的 jar，用的是原版的 1.20.1.jar；它的 ignoreList 只写了「版本名.jar」，
    // 原版 jar 会被当成第二个 minecraft 模块加载，启动即崩（官方启动器是把 jar 复制成「版本名.jar」）。这里把实际用的 jar 也加进去
    const jarName = path.basename(jar);
    jvm.push(...expandArgs(v.arguments.jvm, vars, features).map((a) => (a.startsWith('-DignoreList=') && !a.split(/[=,]/).includes(jarName) ? `${a},${jarName}` : a)));
  } else {
    if (process.platform === 'win32') jvm.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
    if (process.platform === 'darwin') jvm.push('-XstartOnFirstThread');
    jvm.push(
      `-Djava.library.path=${nativesDir}`,
      `-Dminecraft.launcher.brand=${vars.launcher_name}`,
      `-Dminecraft.launcher.version=${vars.launcher_version}`,
      '-cp', vars.classpath,
    );
  }
  // 本地皮肤服务的 authlib-injector 参数：要在主类之前
  if (auth.jvmPre && auth.jvmPre.length) jvm.push(...auth.jvmPre);
  jvm.push(...userJvm);

  let game = [];
  if (v.arguments && v.arguments.game) {
    game = expandArgs(v.arguments.game, vars, features);
  } else if (v.minecraftArguments) {
    game = expandArgs(v.minecraftArguments.split(/\s+/).filter(Boolean), vars, features);
    if (!win.fullscreen) game.push('--width', String(vars.resolution_width), '--height', String(vars.resolution_height));
  }
  if (win.fullscreen) game.push('--fullscreen');
  if (autoJoin && !hasQuickPlay) {
    const { host, port } = hostPort(autoJoin);
    game.push('--server', host, '--port', port || '25565');
  }
  game.push(...splitArgs(vs.gameArgs || cfg.gameArgs || ''));

  await ensureFirstOptions(gameDir, info ? info.mcVersion : v._mcVersion);
  // 游戏设置同步（1.5.6）：主档的值盖在初始选项上面；失败不挡启动
  let sync = null;
  try { sync = await require('./gamesettings').beforeLaunch(id, gameDir, { test: bo.test }); } catch (e) { sync = { error: e.message }; }

  // 测试启动先跳过原版第一次启动的辅助功能欢迎页（1.5.8）：它挡在最前面，后面的 Mod 提示、主菜单都看不到。
  // 游戏关掉后由 troubleshoot.testLaunch 调 restoreOnboard 改回来，玩家自己第一次玩时照样会看到
  const onboard = bo.test ? await skipOnboard(gameDir, info ? info.mcVersion : v._mcVersion).catch(() => false) : false;

  return { args: [...jvm, v.mainClass, ...game], gameDir, v, info, mem, xmlLog, isolationNotes, legacy, sync, onboard };
}

const ONBOARD_RE = /^onboardAccessibility:.*$/m;
const withOnboard = (text, value) => (text == null ? `onboardAccessibility:${value}\n`
  : ONBOARD_RE.test(text) ? text.replace(ONBOARD_RE, `onboardAccessibility:${value}`) : `${text.replace(/\s*$/, '')}\nonboardAccessibility:${value}\n`);

/** 欢迎页还没看过（options.txt 里不是 false）就先改成 false，返回 true 表示改了、之后要改回来。1.19 之前没有这个页 */
async function skipOnboard(gameDir, mc) {
  if (!mc || require('./infer').cmpMc(mc, '1.19') < 0) return false;
  const p = path.join(gameDir, 'options.txt');
  const text = await fsp.readFile(p, 'utf8').catch(() => null);
  if (text && /^onboardAccessibility:false\s*$/m.test(text)) return false;
  await writeFileSafe(p, withOnboard(text, false), 'utf8');
  return true;
}

/** 测试启动结束后把欢迎页改回「没看过」 */
async function restoreOnboard(gameDir) {
  const p = path.join(gameDir, 'options.txt');
  const text = await fsp.readFile(p, 'utf8').catch(() => null);
  if (text != null) await writeFileSafe(p, withOnboard(text, true), 'utf8');
}

// ───────────────────────── 日志解析 ─────────────────────────
function createLogParser(onLine) {
  let buf = '';
  let event = null;
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const fmtTime = (ts) => {
    const d = ts ? new Date(Number(ts)) : new Date();
    return d.toTimeString().slice(0, 8);
  };
  const flushEvent = (xml) => {
    const attr = (k) => { const m = xml.match(new RegExp(`${k}="([^"]*)"`)); return m ? unxml(m[1]) : ''; };
    const cdata = (tag) => {
      const m = xml.match(new RegExp(`<log4j:${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></log4j:${tag}>`));
      if (m) return m[1];
      const m2 = xml.match(new RegExp(`<log4j:${tag}>([\\s\\S]*?)</log4j:${tag}>`));
      return m2 ? unxml(m2[1]) : '';
    };
    const level = (attr('level') || 'INFO').toUpperCase();
    const msg = cdata('Message');
    const thr = cdata('Throwable');
    const prefix = `[${fmtTime(attr('timestamp'))}] [${attr('thread')}/${level}]`;
    const lines = `${msg}${thr ? `\n${thr}` : ''}`.replace(/\r/g, '').split('\n');
    lines.forEach((l, i) => onLine(i === 0 ? `${prefix}: ${l}` : l, level));
  };
  const guessLevel = (line) => {
    const tag = tagged(line); // 和日志中心共用一份（loglevel.js）
    if (tag) return tag;
    if (/^\s+at |Exception|Error:|^Caused by:/.test(line)) return 'ERROR';
    return 'INFO';
  };
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (event !== null) {
        event += `\n${line}`;
        if (line.includes('</log4j:Event>')) { flushEvent(event); event = null; }
        continue;
      }
      const t = line.trimStart();
      if (t.startsWith('<log4j:Event')) {
        if (t.includes('</log4j:Event>')) flushEvent(t);
        else event = t;
        continue;
      }
      if (!t) continue;
      onLine(line, guessLevel(line));
    }
  };
}

// ───────────────────────── 崩溃分析 ─────────────────────────
const CRASH_RULES = [
  [/UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime|class file version (\d+)/, 'Java 版本过低：当前 Java 无法运行该游戏或某个 Mod，请在版本设置中更换为更高版本的 Java'],
  [/java\.lang\.OutOfMemoryError|Could not reserve enough space|Invalid maximum heap size|There is insufficient memory/, '内存不足：请适当调整内存分配（32 位 Java 最多只能分配约 1GB）'],
  [/Pixel format not accelerated|WGL: The driver does not appear to support OpenGL|GLFW error 65542|OpenGL 2\.0 is not supported|Couldn't set pixel format/, '显卡驱动不支持 OpenGL：请更新显卡驱动，或确认没有使用基础显示适配器；如果正在用远程控制或串流软件，游戏窗口可能开在了它的虚拟显示器上，把主显示器换回电脑自己的屏幕再试'],
  [/MixinApplyError|InvalidMixinException|Mixin apply failed|mixin.*failed/i, 'Mod 的 Mixin 注入失败：通常是 Mod 之间冲突或 Mod 与游戏版本不匹配'],
  [/Could not find required mod|requires .{1,80} which is missing|Missing or unsupported mandatory dependencies|Unmet dependency listing|depends on .{1,60}, which is missing/i, '缺少前置 Mod：请根据日志安装缺失的依赖'],
  [/DuplicateModsFoundException|Found duplicate mods|Duplicate mods found|Mod ID .{1,60} is duplicated/i, '存在重复的 Mod：请删除重复的 Mod 文件'],
  [/Incompatible mods found|is incompatible with|Incompatible mod set/i, 'Mod 不兼容：存在版本不兼容的 Mod'],
  [/java\.lang\.module\.ResolutionException|reads more than one module named|Modules .{1,80} export package/, 'Mod 模块冲突：可能安装了重复或冲突的 Mod / 依赖库'],
  [/Unrecognized VM option|Unrecognized option|Could not create the Java Virtual Machine/, 'JVM 参数错误：请检查自定义 JVM 参数是否与当前 Java 版本兼容'],
  [/UnsatisfiedLinkError|no lwjgl in java\.library\.path|Failed to locate library/, '本地库加载失败：可能是 Java 架构与系统不匹配，或 natives 文件损坏'],
  [/codechicken[./]lib[./]/, '缺少 CodeChickenLib：CodeChickenCore / NEI 需要它，但它的原下载站已关闭。1.7.x 启动器会自动补全；1.6.x 已无公开下载源，请手动放入 mods/<游戏版本>/ 或改用其他合成表 Mod'],
  [/ClassNotFoundException|NoClassDefFoundError|NoSuchMethodError|NoSuchFieldError/, '缺少类或方法：可能有 Mod 版本不匹配，或游戏文件不完整（可尝试“补全文件”）'],
  [/Manually triggered debug crash/, '手动触发的调试崩溃（F3 + C）'],
  [/Failed to verify username|Invalid session|Not authenticated with/, '账户验证失败：请重新登录账户'],
];

async function analyzeCrash(game) {
  const reasons = [];
  let report = null;
  let reportPath = null;
  try {
    const dir = path.join(game.gameDir, 'crash-reports');
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.txt'));
    let newest = null;
    for (const f of files) {
      const st = await fsp.stat(path.join(dir, f));
      if (st.mtimeMs >= game.startedAt - 1000 && (!newest || st.mtimeMs > newest.t)) newest = { f, t: st.mtimeMs };
    }
    if (newest) {
      reportPath = path.join(dir, newest.f);
      report = (await fsp.readFile(reportPath, 'utf8')).slice(0, 200000);
    }
  } catch { /* 没有崩溃报告 */ }
  if (!reportPath) {
    try {
      const files = (await fsp.readdir(game.gameDir)).filter((f) => /^hs_err_pid\d+\.log$/.test(f));
      for (const f of files) {
        const p = path.join(game.gameDir, f);
        const st = await fsp.stat(p);
        if (st.mtimeMs >= game.startedAt - 1000) { reportPath = p; report = (await fsp.readFile(p, 'utf8')).slice(0, 100000); break; }
      }
    } catch { /* ignore */ }
  }
  const text = clipLog(`${game.lines.map((l) => l.text).join('\n')}\n${report || ''}`);
  // 加载器写明了是哪几个 Mod（缺前置、前置版本不对、互不兼容）就直接说出来，不只给「Mod 不兼容」（1.5.10）
  let specific = [];
  try {
    specific = require('./troubleshoot').analyzeLog(text, [])
      .filter((i) => ['dep-version', 'missing-dep', 'incompatible', 'remove'].includes(i.type))
      .map((i) => (i.detail && i.type !== 'remove' ? `${i.title}：${i.detail}` : i.title));
  } catch { /* 分析失败就用下面的通用规则 */ }
  reasons.push(...specific.slice(0, 3));
  for (const [re, msg] of CRASH_RULES) {
    if (specific.length && /^(Mod 不兼容|缺少前置 Mod)/.test(msg)) continue;
    if (re.test(text) && !reasons.includes(msg)) reasons.push(msg);
    if (reasons.length >= 3) break;
  }
  const modMatch = text.match(/Suspected Mods?:\s*([^\n]+)/i);
  if (modMatch && !/Unknown/i.test(modMatch[1])) reasons.unshift(`可疑 Mod：${modMatch[1].trim()}`);
  return { reasons, reportPath, report: report ? report.slice(0, 20000) : null };
}

// 测试启动时用来判断结果的日志特征
const SUCCESS_RE = /Sound engine started|Forge Mod Loader has successfully loaded|textures\/atlas\/blocks\.png-atlas|OpenAL initialized/;
const FAIL_RE = /Incompatible mods found|Missing or unsupported mandatory dependencies|Mod loading has failed|Mod loading failed|Loading errors encountered|ModLoadingException|Failed to load mods|Some of your mods are incompatible|has failed to load correctly|---- Minecraft Crash Report ----|A potential solution has been determined|MixinApplyError|Mixin apply failed|LoadingFailedException|MissingModsException|DuplicateModsFoundException|Currently, [\w.-]+ is not installed/;

// ───────────────────────── 启动 ─────────────────────────
async function launch(id, task, opts = {}) {
  if (!id) throw new Error('请先选择一个游戏版本');
  const info = await versions.versionInfo(id);
  if (!info) throw new Error(`版本 ${nm(id)} 不存在`);

  task.update({ detail: '检查账户…', progress: -1 });
  const auth = await accounts.getLaunchAuth(null, (s) => task.update({ detail: s }));

  // 每个阶段之间都看一眼取消（1.10.8）：以前只有下载阶段响应，过了下载点取消，游戏照样启动
  throwIfAborted(task.signal);
  task.update({ detail: '解析版本…' });
  await versions.ensureParents(id, task);
  const v = await versions.resolveVersion(id);

  task.update({ detail: '选择 Java…' });
  const req = versions.requiredJava(v);
  // opts.java：临时指定这次用的 Java（「用 Java N 再测一次」，不改配置）
  const { java, mismatch } = opts.java ? { java: opts.java, mismatch: false } : await javaMgr.resolveForVersion(req, config.getVersionSettings(id), task);

  throwIfAborted(task.signal);
  task.update({ detail: '检查游戏文件…' });
  await versions.completeVersion(id, task, { verify: 'size', arch: java.arch });
  throwIfAborted(task.signal);

  // 离线账户的自定义皮肤：本地皮肤服务 / CustomSkinLoader
  const skin = await require('./skins').prepareLaunch(accounts.find(), versions.gameDirFor(id, info), task);
  if (skin.service) Object.assign(auth, { jvmPre: skin.jvm, accessToken: skin.accessToken, userType: skin.userType });

  throwIfAborted(task.signal);
  const built = await buildLaunch(id, auth, java, task, { test: opts.test });
  throwIfAborted(task.signal);
  // 启动前备份存档（设置里打开才做；测试启动不备份）。失败不挡启动
  if (!opts.test) {
    const b = await require('./backup').auto(id, 'launch', task);
    if (b.error) emit('notify', { level: 'warn', title: '启动前备份存档失败', text: b.error });
  }
  throwIfAborted(task.signal);
  task.update({ detail: '正在启动游戏…', progress: -1, speed: 0 });

  const gameId = `g${++seq}`;
  const exe = java.javaw || java.path;
  const child = spawn(exe, built.args, {
    cwd: built.gameDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const game = {
    id: gameId, versionId: id, pid: child.pid, child, startedAt: Date.now(), gameDir: built.gameDir, lines: [],
    state: 'starting', java: { path: exe, version: java.version, major: java.major }, killed: false,
    memory: built.mem, account: auth.name, test: !!opts.test, onboardSkipped: !!built.onboard, skinService: skin.service, skinClose: opts.skinClose || '', successAt: 0, failAt: 0, failLine: '', finalized: false, crash: null,
  };
  games.set(gameId, game);
  pruneExited();
  gamelogs.begin(game); // 日志中心：这一局的日志写进数据目录（rc4）

  let pendingLines = [];
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!pendingLines.length) return;
    emit('game:log', { id: gameId, lines: pendingLines });
    pendingLines = [];
  };
  const onLine = (text, level) => {
    const line = { text, level };
    gamelogs.write(game, text);
    game.lines.push(line);
    if (game.lines.length > 8000) game.lines.splice(0, game.lines.length - 8000);
    pendingLines.push(line);
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
    if (!game.successAt && SUCCESS_RE.test(text)) game.successAt = Date.now();
    // Mixin 相关的报错只有在 ERROR 级别时才视为致命
    // 1.7.10 Forge 的加载画面会打印一份「THIS IS NOT A ERROR」的假崩溃报告
    const fakeCrash = /Loading screen debug info|THIS IS NOT A ERROR/.test(text);
    if (!game.failAt && FAIL_RE.test(text) && !fakeCrash && !(/Mixin/.test(text) && level !== 'ERROR' && level !== 'FATAL')) {
      game.failAt = Date.now();
      game.failLine = text;
    } else if (game.failAt && fakeCrash && /Minecraft Crash Report/.test(game.failLine || '')) {
      game.failAt = 0;
      game.failLine = '';
    }
    if (game.state === 'starting' && /Setting user:|LWJGL Version|Backend library: LWJGL|OpenAL initialized|Sound engine started|Created: \d+x\d+x\d+|Reloading ResourceManager/.test(text)) {
      game.state = 'running';
      emit('game:state', publicGame(game));
    }
  };
  const parser = createLogParser(onLine);
  // JVM 启动前自己的报错是系统编码，后面的日志是 UTF-8，要按行分开解码
  // 两条输出都读完了（rc9）：进程退出的事件可能比最后一段输出先到，收尾太早的话存下来的日志会少最后几行。
  // 游戏自己再开的子进程可能一直占着管道，所以收尾最多等 1 秒
  const drained = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const decoder = lineDecoder(parser);
    stream.on('data', (b) => decoder.write(b));
    stream.on('end', () => decoder.end());
    drained.push(new Promise((r) => { stream.once('end', r); stream.once('close', r); stream.once('error', r); }));
  }

  onLine(`[Aurora] 启动 ${id} · Java ${java.version} (${java.arch}) · 内存 ${built.mem.max} MB · 账户 ${auth.name}`, 'INFO');
  onLine(`[Aurora] 游戏目录：${built.gameDir}`, 'INFO');
  if (built.isolationNotes && built.isolationNotes.length) onLine(`[Aurora] 隔离策略：${built.isolationNotes.join('，')}`, 'INFO');
  if (built.sync && built.sync.error) onLine(`[Aurora] 警告：游戏设置同步失败：${built.sync.error}`, 'WARN');
  else if (built.sync) onLine(`[Aurora] 游戏设置同步：写入 ${Object.values(built.sync.written).reduce((a, b) => a + b, 0)} 项${built.sync.conflicts.length ? `，${built.sync.conflicts.length} 处按键冲突` : ''}${built.sync.backup ? `（备份 ${built.sync.backup}）` : ''}`, 'INFO');
  for (const n of skin.notes) onLine(`[Aurora] 皮肤：${n}`, /没有|失败/.test(n) ? 'WARN' : 'INFO');
  for (const n of built.legacy.notes) onLine(`[Aurora] ${n}`, 'INFO');
  for (const p of built.legacy.problems) onLine(`[Aurora] 警告：${p}`, 'WARN');
  if (mismatch) onLine(`[Aurora] 警告：未找到 Java ${req.major}，使用 Java ${java.major} 启动，可能无法正常运行`, 'WARN');

  const exited = new Promise((resolve) => {
    child.on('error', (e) => {
      onLine(`[Aurora] 无法启动进程：${e.message}`, 'ERROR');
      resolve(-1);
    });
    child.on('exit', (code) => { Promise.race([Promise.all(drained), new Promise((r) => setTimeout(r, 1000))]).then(() => resolve(code)); });
  });

  let analysis = null; // 崩溃分析只做一遍：下面「启动后立即退出」也用这次的结果
  exited.then(async (code) => {
    parser('\n');
    flush();
    game.state = 'exited';
    game.exitCode = code;
    game.endedAt = Date.now();
    let crash = null;
    if ((code !== 0 && !game.killed) || (game.test && game.failAt)) { analysis = analyzeCrash(game).catch(() => null); crash = await analysis; }
    game.crash = crash;
    game.finalized = true;
    await gamelogs.finish(game).catch(() => {});
    emit('game:exit', { ...publicGame(game), crash: game.killed && !game.test ? null : crash });
  });

  // 日志里始终没有识别到窗口创建时的兜底
  setTimeout(() => {
    if (game.state === 'starting') { game.state = 'running'; emit('game:state', publicGame(game)); }
  }, 30000).unref(); // 只是兜底：不为它拖住退出

  // 给出 3 秒观察期，快速失败的情况直接报错
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (game.state === 'exited' && game.exitCode !== 0) {
    const crash = (analysis && await analysis) || await analyzeCrash(game);
    const tail = game.lines.slice(-8).map((l) => l.text).join('\n');
    const e = new Error(`游戏启动后立即退出（代码 ${game.exitCode}）${crash.reasons.length ? `\n可能原因：${crash.reasons[0]}` : ''}\n${tail}`);
    e.gameId = gameId;
    throw e;
  }
  emit('game:state', publicGame(game));
  return publicGame(game);
}

function publicGame(g) {
  return {
    id: g.id, versionId: g.versionId, pid: g.pid, startedAt: g.startedAt, state: g.state, exitCode: g.exitCode,
    gameDir: g.gameDir, java: g.java, memory: g.memory, account: g.account, endedAt: g.endedAt, test: g.test, logId: g.logId || null,
    skinService: !!g.skinService, skinClose: g.skinClose || '',
  };
}

/**
 * 等待测试启动的结果：
 *  成功 = 日志出现进入主菜单前的特征并且之后持续运行 survive 毫秒
 *  失败 = 进程退出 / 日志出现加载错误（Forge 的错误界面、Fabric 的错误窗口不会退出进程）
 *  中断 = 进入主菜单前玩家自己关掉了窗口（正常退出、没有报错），不算失败，reason 为 'interrupted'
 * onTick(game) 每 0.5 秒调用一次，用来显示「等待主菜单 / 几秒后关闭」
 */
function waitOutcome(id, { timeout = 240000, survive = 12000, signal, onTick } = {}) {
  return new Promise((resolve) => {
    const g = games.get(id);
    if (!g) { resolve({ ok: false, reason: 'missing', state: 'exited' }); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      if (signal && signal.aborted) return finish({ ok: false, reason: 'cancelled' });
      if (g.state === 'exited') {
        if (!g.finalized) return undefined;
        const ok = g.exitCode === 0 && !g.failAt && !!g.successAt;
        const interrupted = !ok && !g.killed && !g.successAt && !g.failAt && !g.crash && g.exitCode === 0;
        return finish({ ok, reason: interrupted ? 'interrupted' : g.failAt ? 'error' : 'exited', exitCode: g.exitCode });
      }
      if (onTick) onTick(g);
      if (g.failAt && Date.now() - g.failAt > 1500) return finish({ ok: false, reason: 'error' });
      if (g.successAt && !g.failAt && Date.now() - g.successAt >= survive) return finish({ ok: true, reason: 'success' });
      if (Date.now() - start > timeout) return finish({ ok: false, reason: 'timeout' });
      return undefined;
    }, 500);
    function finish(r) { clearInterval(timer); resolve({ ...r, state: g.state, successAt: g.successAt, failLine: g.failLine }); }
  });
}

/** 「服务器地址[:端口]」拆开：IPv6 要写成 [::1]:25565（不带方括号、冒号又不止一个的，整个当地址） */
function hostPort(addr) {
  const a = String(addr || '').trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: v6[1], port: v6[2] || '' };
  if ((a.match(/:/g) || []).length > 1) return { host: a, port: '' };
  const [host, port = ''] = a.split(':');
  return { host, port };
}

async function waitExit(id, ms = 15000) {
  const g = games.get(id);
  const end = Date.now() + ms;
  while (g && !(g.state === 'exited' && g.finalized) && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
}

/** 结束的游戏只留最近几局（2.0.0-pre8）：每局带着最多 8000 行日志，界面又没有清除的入口，开着启动器玩很多局会一直涨 */
const KEEP_EXITED = 10;
function pruneExited() {
  const exited = [...games.values()].filter((g) => g.state === 'exited');
  for (const g of exited.slice(0, Math.max(0, exited.length - KEEP_EXITED))) games.delete(g.id);
}

function getGame(id) { return games.get(id) || null; }

function listGames() { return [...games.values()].map(publicGame); }
function getLog(id) { const g = games.get(id); return g ? g.lines : []; }
function kill(id) {
  const g = games.get(id);
  if (!g || g.state === 'exited') return;
  g.killed = true;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(g.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {}); // 起不来也不能让主进程报未捕获的错
    else g.child.kill('SIGKILL');
  } catch { /* ignore */ }
}
function running() { return [...games.values()].filter((g) => g.state !== 'exited').length; }
// 退出启动器：玩家自己开的游戏照常玩下去；一键修复「试启动」开的那一局是启动器替玩家开的，跟着一起关掉，不留在后台
require('../engine/shutdown').onQuit(() => { for (const g of games.values()) if (g.test && g.state !== 'exited') kill(g.id); });
function clearExited() { for (const [id, g] of games) if (g.state === 'exited') games.delete(id); }

module.exports = { hostPort, launch, restoreOnboard, listGames, getLog, kill, running, clearExited, setEmitter, autoMemory, memoryFor, waitOutcome, waitExit, getGame, ensureFirstOptions, CRASH_RULES };
