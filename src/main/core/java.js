'use strict';
/**
 * Java：找电脑上已有的（JAVA_HOME、注册表、常见目录、官方启动器和其他启动器带的）、按游戏版本挑合适的、
 * 下载安装（Mojang 官方运行时、Temurin、Microsoft OpenJDK）、卸载自己装的。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const config = require('../engine/config');
const paths = require('../engine/paths');
const mirrors = require('../engine/mirrors');
const { getJson, getText } = require('../engine/net');
const { downloadAll, downloadFile } = require('../engine/downloader');
const { withZip } = require('../engine/zip');
const { exists, isWin, normArch, systemArch, writeJson, rmrf, abortError, renameRetry } = require('../engine/util');
const { decodeBytes } = require('../engine/procenc');

const EXE = isWin ? 'java.exe' : 'java';
const EXEW = isWin ? 'javaw.exe' : 'java';
const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const COMPONENT_NAMES = {
  'jre-legacy': 'Java 8',
  'java-runtime-alpha': 'Java 16',
  'java-runtime-beta': 'Java 17',
  'java-runtime-gamma': 'Java 17',
  'java-runtime-gamma-snapshot': 'Java 17',
  'java-runtime-delta': 'Java 21',
  'java-runtime-epsilon': 'Java 25',
  'minecraft-java-exe': 'Minecraft 启动器 Java',
};
const COMPONENT_BY_MAJOR = { 8: 'jre-legacy', 16: 'java-runtime-alpha', 17: 'java-runtime-gamma', 21: 'java-runtime-delta', 25: 'java-runtime-epsilon' };

function parseMajor(version) {
  if (!version) return 0;
  const v = String(version).trim();
  const m = v.match(/^1\.(\d+)/);
  if (m) return parseInt(m[1], 10);
  const n = v.match(/^(\d+)/);
  return n ? parseInt(n[1], 10) : 0;
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout ? decodeBytes(stdout) : '', stderr: stderr ? decodeBytes(stderr) : '' });
    });
  });
}

/** 探测一个 Java 目录（JAVA_HOME）的信息 */
async function probe(home, source = '') {
  const exe = path.join(home, 'bin', EXE);
  if (!(await exists(exe))) return null;
  let version = '';
  let vendor = '';
  let arch = '';
  try {
    const rel = await fsp.readFile(path.join(home, 'release'), 'utf8');
    const get = (k) => { const m = rel.match(new RegExp(`^${k}="?([^"\\r\\n]*)"?`, 'm')); return m ? m[1] : ''; };
    version = get('JAVA_VERSION');
    vendor = get('IMPLEMENTOR');
    arch = get('OS_ARCH');
  } catch { /* 没有 release 文件 */ }
  if (!version || !arch) {
    const { stderr, stdout } = await run(exe, ['-XshowSettings:properties', '-version']);
    const text = stderr + stdout;
    const g = (k) => { const m = text.match(new RegExp(`\\s${k.replace(/\./g, '\\.')} = (.*)`)); return m ? m[1].trim() : ''; };
    version = version || g('java.version');
    vendor = vendor || g('java.vendor');
    arch = arch || g('os.arch');
    if (!version) {
      const m = text.match(/version "([^"]+)"/);
      if (m) version = m[1];
    }
  }
  if (!version) return null;
  const javaw = path.join(home, 'bin', EXEW);
  return {
    home,
    path: exe,
    javaw: (await exists(javaw)) ? javaw : exe,
    version,
    major: parseMajor(version),
    arch: normArch(arch || 'x64'),
    vendor: vendor || '未知',
    isJdk: await exists(path.join(home, 'bin', isWin ? 'javac.exe' : 'javac')),
    source,
  };
}

async function listDirs(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => path.join(dir, d.name));
  } catch { return []; }
}

// 官方运行时是边下载边放进最终目录的：开始时放这个标记，装完才删。有标记就是还没装完（或者装到一半取消了、失败了）。
// 和整合包没装完的 .aurora-installing（recover.js）不是一回事，名字分开
const INSTALLING = '.aurora-runtime-installing';

/**
 * 在目录中有限深度地查找包含 bin/java 的目录。
 * 没装完的不算：*.tmp 是 Temurin / 微软 JDK 正在解压的临时文件夹，带 INSTALLING 标记的是正在下载的官方运行时。
 * 以前检测正好撞上解压到一半（java.exe 已经解出来、release 还没有），会去运行这个不完整的 Java，它当场崩溃，在启动器的工作目录留下 hs_err_pid*.log；
 * release 已经解出来的话，还会把临时文件夹里的 Java 列出来，改名以后路径就不在了
 */
async function findHomes(root, depth, out, source) {
  if (depth < 0) return;
  if (await exists(path.join(root, 'bin', EXE))) {
    if (!(await exists(path.join(root, INSTALLING)))) out.push({ home: root, source });
    return;
  }
  for (const d of await listDirs(root)) {
    const base = path.basename(d).toLowerCase();
    if (['bin', 'lib', 'legal', 'include', 'jmods', 'conf', 'man'].includes(base) || base.endsWith('.tmp')) continue;
    await findHomes(d, depth - 1, out, source);
  }
}

async function registryHomes() {
  if (!isWin) return [];
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft',
    'HKLM\\SOFTWARE\\Eclipse Adoptium',
    'HKLM\\SOFTWARE\\Eclipse Foundation',
    'HKLM\\SOFTWARE\\AdoptOpenJDK',
    'HKLM\\SOFTWARE\\Azul Systems',
    'HKLM\\SOFTWARE\\Microsoft\\JDK',
    'HKLM\\SOFTWARE\\BellSoft',
    'HKLM\\SOFTWARE\\Amazon Corretto',
  ];
  const homes = [];
  await Promise.all(keys.map(async (k) => {
    const { stdout } = await run('reg', ['query', k, '/s'], 6000);
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s+(JavaHome|InstallationPath|Path)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
      if (m) homes.push({ home: m[2].trim().replace(/[\\/]+$/, ''), source: '注册表' });
    }
  }));
  return homes;
}

let cache = null;
// 装好了新的 Java 时通知界面：启动游戏、装加载器时顺带下载的 Java 不走 Java 页面的任务（ipc.js 接上，1.10.5）
let changed = () => {};
const onChanged = (fn) => { changed = fn; };
let scanning = null;

async function detect(force = false) {
  if (cache && !force) return cache;
  if (scanning) return scanning;
  scanning = (async () => {
    const cands = [];
    const add = (home, source) => home && cands.push({ home, source });

    if (process.env.JAVA_HOME) add(process.env.JAVA_HOME, 'JAVA_HOME');
    if (process.env.JDK_HOME) add(process.env.JDK_HOME, 'JDK_HOME');

    // PATH
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const exe = path.join(dir, EXE);
      if (await exists(exe)) {
        try {
          const real = await fsp.realpath(exe);
          add(path.dirname(path.dirname(real)), 'PATH');
        } catch { /* ignore */ }
      }
    }

    cands.push(...(await registryHomes()));

    const scanRoots = [];
    if (isWin) {
      const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean);
      const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Zulu', 'Microsoft', 'BellSoft',
        'Amazon Corretto', 'Semeru', 'IBM', 'RedHat', 'Liberica', 'GraalVM', 'OpenJDK', 'ojdkbuild', 'Huawei', 'Tencent',
        'Alibaba', 'Dragonwell', 'Oracle', 'Common Files\\Oracle\\Java', 'Zulu\\zulu'];
      for (const root of new Set(pf)) {
        for (const v of vendors) scanRoots.push([path.join(root, v), 2, '系统安装']);
        for (const d of await listDirs(root)) {
          if (/jdk|jre|java|openjdk|zulu|corretto|temurin|graal/i.test(path.basename(d))) scanRoots.push([d, 1, '系统安装']);
        }
      }
      const appData = process.env.APPDATA || '';
      const local = process.env.LOCALAPPDATA || '';
      scanRoots.push([path.join(appData, '.minecraft', 'runtime'), 4, 'Minecraft 官方启动器']);
      scanRoots.push([path.join(local, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'), 4, 'Minecraft 官方启动器']);
      scanRoots.push([path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Minecraft Launcher', 'runtime'), 4, 'Minecraft 官方启动器']);
      scanRoots.push([path.join(local, 'Programs'), 2, '用户安装']);
      scanRoots.push([path.join(os.homedir(), 'scoop', 'apps'), 3, 'Scoop']);
    } else if (process.platform === 'darwin') {
      scanRoots.push(['/Library/Java/JavaVirtualMachines', 3, '系统安装']);
      scanRoots.push([path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'), 3, '用户安装']);
      scanRoots.push(['/opt/homebrew/opt', 4, 'Homebrew']);
    } else {
      scanRoots.push(['/usr/lib/jvm', 2, '系统安装']);
      scanRoots.push(['/usr/java', 2, '系统安装']);
      scanRoots.push(['/opt', 2, '系统安装']);
    }
    scanRoots.push([path.join(os.homedir(), '.jdks'), 2, 'IntelliJ IDEA']);
    scanRoots.push([path.join(os.homedir(), '.sdkman', 'candidates', 'java'), 2, 'SDKMAN']);
    scanRoots.push([path.join(config.get().gameDir, 'runtime'), 4, '游戏目录']);
    scanRoots.push([paths.runtimeDir(), 3, 'Aurora 下载']);

    for (const [root, depth, source] of scanRoots) {
      if (await exists(root)) await findHomes(root, depth, cands, source);
    }

    for (const p of config.get().java.extra || []) {
      add(path.dirname(path.dirname(p)), '手动添加');
    }

    // 去重
    const seen = new Map();
    for (const c of cands) {
      let real = c.home;
      try { real = await fsp.realpath(c.home); } catch { continue; }
      const key = isWin ? real.toLowerCase() : real;
      if (!seen.has(key)) seen.set(key, { home: real, source: c.source });
      else if (c.source === 'Aurora 下载' || c.source === '手动添加') seen.get(key).source = c.source;
    }
    const results = (await Promise.all([...seen.values()].map((c) => probe(c.home, c.source).catch(() => null)))).filter(Boolean);
    results.sort((a, b) => b.major - a.major || b.version.localeCompare(a.version, undefined, { numeric: true }));
    cache = results;
    return results;
  })().finally(() => { scanning = null; }); // 中途出错也要放开：以前出错后 scanning 一直留着这个失败的结果，之后每次检测都直接失败
  return scanning;
}

async function addManual(exePath) {
  let p = exePath;
  if (/javaw?\.exe$/i.test(p) || /\/java$/.test(p)) p = path.dirname(path.dirname(p));
  const info = await probe(p, '手动添加');
  if (!info) throw new Error('所选文件不是有效的 Java');
  const extra = new Set(config.get().java.extra || []);
  extra.add(info.path);
  config.set({ java: { extra: [...extra] } });
  cache = null;
  return info;
}

function removeManual(exePath) {
  const extra = (config.get().java.extra || []).filter((p) => p !== exePath);
  config.set({ java: { extra } });
  if (config.get().java.selected === exePath) config.set({ java: { selected: 'auto' } });
  cache = null;
}

/** 为版本挑选最合适的 Java */
function pick(javas, req, { strict = false } = {}) {
  const prefArch = systemArch() === 'arm64' ? 'arm64' : 'x64';
  const score = (j) => (j.arch === prefArch ? 2 : j.arch === 'x64' ? 1 : 0);
  const sorted = (arr) => arr.sort((a, b) => score(b) - score(a) || b.version.localeCompare(a.version, undefined, { numeric: true }));
  const exact = sorted(javas.filter((j) => j.major === req.major));
  if (exact.length) return exact[0];
  // Java 8 时代的版本（尤其是 Forge / LaunchWrapper）在高版本 Java 上大多无法运行
  if (req.major <= 8 && strict) return null;
  const higher = javas.filter((j) => j.major > req.major);
  higher.sort((a, b) => a.major - b.major || score(b) - score(a));
  return higher[0] || null;
}

// ───────────────────────── Mojang 官方 Java 运行时 ─────────────────────────
function platformKey() {
  const a = systemArch();
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : a === 'x86' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'x86' ? 'linux-i386' : 'linux';
}

async function listMojangRuntimes() {
  const idx = await getJson(mirrors.candidates(RUNTIME_INDEX));
  const plat = idx[platformKey()] || {};
  const out = [];
  for (const [component, arr] of Object.entries(plat)) {
    if (!arr || !arr.length || component === 'minecraft-java-exe') continue;
    const r = arr[0];
    out.push({
      component,
      name: COMPONENT_NAMES[component] || component,
      version: r.version && r.version.name,
      major: parseMajor(r.version && r.version.name),
      released: r.version && r.version.released,
      manifest: r.manifest,
      installed: await exists(path.join(paths.runtimeDir(), component, 'bin', EXE)) && !(await exists(path.join(paths.runtimeDir(), component, INSTALLING))),
    });
  }
  out.sort((a, b) => a.major - b.major || a.component.localeCompare(b.component));
  return out;
}

// 同一个运行时同时只装一份：启动时自动下载和玩家点「立即下载」可能撞上，两边写同一个目录会写坏（1.10.5）。
// 1.10.8：Temurin、微软 JDK 也一样；几个任务共用一次安装时进度都看得到，
// 取消只让自己退出，全部取消才真的停（以前进度只在第一个任务上，取消第一个，大家一起失败）
const installing = new Map();
function sharedInstall(key, task, run) {
  let job = installing.get(key);
  if (!job) {
    const ctrl = new AbortController();
    job = { tasks: new Set(), ctrl };
    const tasksOf = job.tasks;
    if (task) tasksOf.add(task);
    const relay = { get signal() { return ctrl.signal; }, update(patch) { for (const t of tasksOf) t.update(patch); } };
    installing.set(key, job);
    job.promise = run(relay).finally(() => installing.delete(key));
  }
  if (!task) return job.promise;
  const { tasks: joined, ctrl, promise } = job;
  joined.add(task);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      joined.delete(task);
      reject(abortError());
      if (!joined.size) ctrl.abort();
    };
    if (task.signal.aborted) { onAbort(); return; }
    task.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => task.signal.removeEventListener('abort', onAbort));
  });
}

function installMojangRuntime(component, task) {
  return sharedInstall(component, task, (relay) => runMojangInstall(component, relay));
}

async function runMojangInstall(component, task) {
  const list = await listMojangRuntimes();
  const rt = list.find((r) => r.component === component);
  if (!rt) throw new Error(`当前平台（${platformKey()}）没有可用的官方运行时 ${component}`);
  if (task) task.update({ detail: '获取运行时文件清单', progress: -1 });
  const manifest = await getJson(mirrors.candidates(rt.manifest.url));
  const dir = path.join(paths.runtimeDir(), component);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, INSTALLING), ''); // pitfall-ok：没装完的标记，空文件
  const files = [];
  const links = [];
  for (const [rel, f] of Object.entries(manifest.files || {})) {
    const dest = path.join(dir, rel);
    if (f.type === 'directory') await fsp.mkdir(dest, { recursive: true });
    else if (f.type === 'file') {
      const raw = f.downloads && f.downloads.raw;
      if (raw) files.push({ urls: mirrors.candidates(raw.url), path: dest, sha1: raw.sha1, size: raw.size, executable: f.executable });
    } else if (f.type === 'link') links.push([dest, f.target]);
  }
  await downloadAll(files, { task, label: `下载 ${rt.name}` });
  if (!isWin) {
    for (const [dest, target] of links) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      await fsp.symlink(target, dest).catch(() => {});
    }
  }
  await writeJson(path.join(dir, '.aurora-runtime.json'), { component, version: rt.version, installedAt: Date.now() });
  await fsp.rm(path.join(dir, INSTALLING), { force: true });
  cache = null;
  const info = await probe(dir, 'Aurora 下载');
  if (!info) throw new Error('运行时安装完成，但无法识别 Java');
  changed();
  return info;
}

// ───────────────────────── Eclipse Temurin（Adoptium）─────────────────────────
function installTemurin(major, imageType = 'jdk', task) {
  return sharedInstall(`temurin-${major}-${imageType}`, task, (relay) => runTemurinInstall(major, imageType, relay));
}

async function runTemurinInstall(major, imageType, task) {
  const arch = { x64: 'x64', arm64: 'aarch64', x86: 'x86-32' }[systemArch()] || 'x64';
  const osn = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  if (task) task.update({ detail: '查询 Temurin 版本', progress: -1 });
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=${imageType}&os=${osn}&vendor=eclipse`;
  const arr = await getJson(api, { timeout: 20000 });
  const item = arr && arr[0];
  if (!item || !item.binary || !item.binary.package) throw new Error(`没有找到 Temurin ${major} ${imageType.toUpperCase()}（${osn}/${arch}）`);
  const pkg = item.binary.package;
  const tuna = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/${imageType}/${arch}/${osn}/${pkg.name}`;
  const urls = mirrors.preferMirror() ? [tuna, pkg.link] : [pkg.link, tuna];
  const archive = path.join(paths.cacheDir(), 'java', pkg.name);
  await downloadFile({ urls, path: archive, sha256: pkg.checksum, size: pkg.size }, { task, label: `下载 Temurin ${major}` });
  return unpackRuntime(archive, `temurin-${major}-${imageType}`, { vendor: 'Temurin', major, imageType, release: item.release_name }, task);
}

// ───────────────────────── Microsoft Build of OpenJDK ─────────────────────────
// aka.ms 的固定链接总是指向这个大版本的最新一版，旁边有 .sha256sum.txt。只有 JDK，从 Java 11 开始（没有 Java 8）
const MICROSOFT_MAJORS = [11, 17, 21, 25];
function installMicrosoft(major, task) {
  return sharedInstall(`microsoft-${major}`, task, (relay) => runMicrosoftInstall(major, relay));
}

async function runMicrosoftInstall(major, task) {
  const arch = { x64: 'x64', arm64: 'aarch64' }[systemArch()];
  const osn = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  if (!arch || !osn) throw new Error(`Microsoft Build of OpenJDK 不支持当前系统（${process.platform}/${systemArch()}）`);
  const file = `microsoft-jdk-${major}-${osn}-${arch}.${isWin ? 'zip' : 'tar.gz'}`;
  const url = `https://aka.ms/download-jdk/${file}`;
  if (task) task.update({ detail: '查询 Microsoft OpenJDK 版本', progress: -1 });
  // 校验文件：「<sha256>  microsoft-jdk-21.0.12.1-windows-x64.zip」，顺便拿到具体版本号
  const sum = String(await getText(`${url}.sha256sum.txt`, { timeout: 20000 })).trim().split(/\s+/);
  if (!/^[0-9a-f]{64}$/i.test(sum[0] || '')) throw new Error(`没有找到 Microsoft OpenJDK ${major}（${osn}/${arch}）`);
  const release = (sum[1] || '').replace(/^microsoft-jdk-|-(?:windows|macos|linux)-.*$/g, '');
  const archive = path.join(paths.cacheDir(), 'java', sum[1] || file);
  await downloadFile({ urls: [url], path: archive, sha256: sum[0].toLowerCase() }, { task, label: `下载 Microsoft OpenJDK ${major}` });
  return unpackRuntime(archive, `microsoft-${major}-jdk`, { vendor: 'Microsoft', major, imageType: 'jdk', release }, task);
}

/** 解压下载好的 JDK / JRE 压缩包到 runtime/<name>，记下来源，返回 probe 结果 */
async function unpackRuntime(archive, name, meta, task) {
  if (task) task.update({ detail: '解压中…', progress: -1, speed: 0 });
  const target = path.join(paths.runtimeDir(), name);
  const tmp = path.join(paths.runtimeDir(), `${name}.tmp`);
  await rmrf(tmp);
  await fsp.mkdir(tmp, { recursive: true });
  if (archive.endsWith('.zip')) {
    // 解压也能取消；取消了不留临时文件夹（1.10.8）
    await withZip(archive, (z) => z.extractAll(tmp, { signal: task && task.signal })).catch(async (e) => { await rmrf(tmp).catch(() => {}); throw e; });
  } else {
    const { err } = await run('tar', ['-xzf', archive, '-C', tmp], 5 * 60 * 1000);
    if (err) throw new Error(`解压失败：${err.message}`);
  }
  const found = [];
  await findHomes(tmp, 4, found, '');
  if (!found.length) throw new Error('压缩包中没有找到 Java');
  await rmrf(target);
  await renameRetry(found[0].home, target);
  await rmrf(tmp);
  await fsp.rm(archive, { force: true }).catch(() => {});
  await writeJson(path.join(target, '.aurora-runtime.json'), { ...meta, installedAt: Date.now() });
  cache = null;
  const info = await probe(target, 'Aurora 下载');
  if (!info) throw new Error('安装完成，但无法识别 Java');
  changed();
  return info;
}

async function uninstallRuntime(home) {
  const root = path.resolve(paths.runtimeDir());
  const h = path.resolve(String(home || ''));
  // Windows 的路径不分大小写：界面传来的 c:\... 和 C:\... 是同一个地方（以前 startsWith 区分大小写，会误判成「不是 Aurora 下载的」）
  const same = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
  const rel = path.relative(root, h);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !same(path.join(root, rel), h)) throw new Error('只能删除由 Aurora 下载的 Java');
  const top = path.join(root, path.relative(root, h).split(path.sep)[0]);
  await rmrf(top);
  // 比较时带上分隔符：java-runtime-gamma 不能算进 java-runtime-gamma-snapshot（1.10.8）
  const sel = config.get().java.selected;
  if (sel && path.resolve(sel).toLowerCase().startsWith(`${top.toLowerCase()}${path.sep}`)) config.set({ java: { selected: 'auto' } });
  cache = null;
}

/**
 * 为指定版本解析出要使用的 Java（必要时自动下载）
 * @returns {Promise<object>} java info
 */
async function resolveForVersion(req, versionSettings, task) {
  const javas = await detect();
  const vsJava = versionSettings && versionSettings.java;
  const manual = vsJava && vsJava !== 'global' && vsJava !== 'auto' ? vsJava : null;
  const globalSel = config.get().java.selected;
  const chosen = manual || (vsJava === 'auto' ? null : globalSel !== 'auto' ? globalSel : null);
  if (chosen) {
    const found = javas.find((j) => j.path === chosen || j.javaw === chosen);
    if (found) return { java: found, auto: false };
    const info = await probe(path.dirname(path.dirname(chosen)), '手动');
    if (info) return { java: info, auto: false };
    throw new Error(`指定的 Java 不存在：${chosen}`);
  }
  let j = pick(javas, req, { strict: true });
  if (j) return { java: j, auto: true };
  if (config.get().java.autoDownload) {
    const comp = req.component || COMPONENT_BY_MAJOR[req.major] || COMPONENT_BY_MAJOR[req.major >= 21 ? 21 : 17];
    if (task) task.update({ detail: `未找到 Java ${req.major}，正在自动下载官方运行时…` });
    try {
      const info = await installMojangRuntime(comp, task);
      return { java: info, auto: true, downloaded: true };
    } catch (e) {
      if (e.cancelled) throw e;
      try {
        const info = await installTemurin(req.major, 'jre', task);
        return { java: info, auto: true, downloaded: true };
      } catch (e2) {
        if (e2.cancelled) throw e2;
        console.warn('[java] 自动下载失败', e.message, e2.message);
      }
    }
  }
  j = pick(javas, req) || javas.find((x) => x.major >= req.major);
  if (j) return { java: j, auto: true, mismatch: true };
  throw new Error(`没有找到可用的 Java ${req.major}，请在「Java 管理」中安装`);
}

/** 不下载：这个版本启动时会用哪个 Java（兼容性检查用）。指定的 Java 不存在、或一个合适的都没有时 java 为 null */
async function peekForVersion(req, versionSettings) {
  const javas = await detect();
  const vsJava = versionSettings && versionSettings.java;
  const manual = vsJava && vsJava !== 'global' && vsJava !== 'auto' ? vsJava : null;
  const globalSel = config.get().java.selected;
  const chosen = manual || (vsJava === 'auto' ? null : globalSel !== 'auto' ? globalSel : null);
  if (chosen) return { java: javas.find((j) => j.path === chosen || j.javaw === chosen) || (await probe(path.dirname(path.dirname(chosen)), '手动')) || null, auto: false };
  return { java: pick(javas, req, { strict: true }) || (config.get().java.autoDownload ? null : pick(javas, req)), auto: true };
}

/** 拿到一个 Java N：装了就用（同版本里挑最合适的），没装先下载官方运行时，没有官方的就下载 Temurin */
async function forMajor(major, task) {
  const javas = await detect();
  const have = pick(javas.filter((j) => j.major === major), { major });
  if (have) return { java: have, downloaded: false };
  const comp = COMPONENT_BY_MAJOR[major];
  if (comp) {
    try { return { java: await installMojangRuntime(comp, task), downloaded: true }; } catch (e) { if (e.cancelled) throw e; }
  }
  return { java: await installTemurin(major, 'jre', task), downloaded: true };
}

module.exports = {
  onChanged,
  detect, probe, addManual, removeManual, pick, listMojangRuntimes, installMojangRuntime, installTemurin, installMicrosoft, MICROSOFT_MAJORS,
  uninstallRuntime, resolveForVersion, peekForVersion, forMajor, parseMajor, COMPONENT_BY_MAJOR, COMPONENT_NAMES,
};
