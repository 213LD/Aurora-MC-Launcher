'use strict';
/**
 * 启动器运行位置检测
 * 检查三个位置：便携版 exe 所在的文件夹、启动器数据文件夹（便携 / 自定义时）、游戏目录。
 * 每个文件夹只报最要紧的一条「位置」问题；路径过长单独报。同一条规则命中多个文件夹时合并成一条。
 *   temp       crit  在压缩包里直接运行，或在临时文件夹里（exe 也检查）
 *   unwritable crit  数据文件夹无法写入（例如 Program Files 下的便携版），启动器已临时改用系统默认位置
 *   onedrive   warn  OneDrive 等同步文件夹
 *   downloads  warn  下载文件夹
 *   desktop    warn  桌面
 *   network    warn  网络盘：\\服务器\共享 或映射成盘符的网络盘（2026-11-07 在群晖上实测：慢很多、Fabric 打不开；删除的东西不进电脑的回收站，NAS 自己开了回收站才找得回）
 *   removable  info  U 盘等可移动磁盘（没有回收站）
 *   longpath   warn  路径超过 200 个字符
 * exe 本身只检查 temp：数据不在 exe 旁边时，exe 放在桌面或下载文件夹并不会丢数据。
 */
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { execFile } = require('child_process');
const config = require('../engine/config');
const location = require('../engine/location');
const { under } = require('../engine/fileops');
const { PS_UTF8 } = require('../engine/procenc');
const BRAND = require('../../shared/brand');
const { nm } = require('../../shared/i18n');

const LEVEL = { temp: 'crit', unwritable: 'crit', onedrive: 'warn', downloads: 'warn', desktop: 'warn', longpath: 'warn', network: 'warn', removable: 'info' };
const ORDER = Object.keys(LEVEL);
const LONG = 200;
const ARCHIVE = [/\\Temp\d+_[^\\]+\.zip(\\|$)/i, /\\Rar\$EX/i, /\\7zO[0-9A-F]+\.tmp/i, /\\Bandizip\\/i, /\\360zip\$Temp/i];

const app = () => require('electron').app;
const norm = (p) => path.resolve(p).toLowerCase();

/** 当前系统里各个特殊文件夹的位置（测试时可以整个替换） */
function env() {
  const e = process.env;
  const get = (n) => { try { return app().getPath(n); } catch { return ''; } };
  return {
    temp: [...new Set([os.tmpdir(), e.TEMP, e.TMP].filter(Boolean))],
    downloads: get('downloads'),
    desktop: get('desktop'),
    sync: [...new Set([e.OneDrive, e.OneDriveConsumer, e.OneDriveCommercial].filter(Boolean))],
  };
}

/** 一个文件夹命中的「位置」规则（只取最要紧的一条） */
function placeRule(dir, ev) {
  if (ev.temp.some((t) => under(dir, t)) || ARCHIVE.some((re) => re.test(dir))) return 'temp';
  if (ev.sync.some((s) => under(dir, s))) return 'onedrive';
  if (under(dir, ev.downloads)) return 'downloads';
  if (under(dir, ev.desktop)) return 'desktop';
  return '';
}

/**
 * 纯函数：检查一组文件夹
 * @param {{kind: 'exe'|'data'|'game', dir: string}[]} targets
 * @returns {{rule, level, kinds: string[], dirs: string[]}[]} 按严重程度排序
 */
function inspect(targets, ev = env()) {
  const found = new Map();
  const add = (rule, t) => {
    const it = found.get(rule) || { rule, level: LEVEL[rule], kinds: [], dirs: [] };
    if (!it.kinds.includes(t.kind)) it.kinds.push(t.kind);
    if (!it.dirs.some((d) => norm(d) === norm(t.dir))) it.dirs.push(t.dir);
    found.set(rule, it);
  };
  for (const t of targets) {
    if (!t.dir || !path.isAbsolute(t.dir)) continue;
    const rule = placeRule(t.dir, ev);
    if (rule && (t.kind !== 'exe' || rule === 'temp')) add(rule, t);
    if (t.kind !== 'exe' && t.dir.length > LONG) add('longpath', t);
  }
  return sort([...found.values()]);
}

const sort = (list) => list.sort((a, b) => ORDER.indexOf(a.rule) - ORDER.indexOf(b.rule));

// ───────────── 可移动磁盘：用 .NET 的 DriveInfo 查驱动器类型，结果缓存 ─────────────
let drives = null;
function driveTypes() {
  if (drives) return drives;
  drives = new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({}); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + "[IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name + '|' + $_.DriveType }"],
      { timeout: 10000, windowsHide: true }, (err, out) => {
        const map = {};
        for (const line of String(out || '').split(/\r?\n/)) {
          const m = line.match(/^([A-Z]):\\\|(\w+)/i);
          if (m) map[m[1].toUpperCase()] = m[2];
        }
        resolve(map);
      });
  });
  return drives;
}
const driveOf = (dir) => { const m = /^([a-z]):/i.exec(dir || ''); return m ? m[1].toUpperCase() : ''; };

async function addRemovable(issues, targets) {
  // \\服务器\共享（不算 \\?\ 和 \\.\ 这两种本机长路径写法）
  const unc = targets.filter((t) => t.kind !== 'exe' && /^[\\/]{2}(?![?.][\\/])/.test(t.dir || ''));
  if (unc.length) issues.push({ rule: 'network', level: LEVEL.network, kinds: [...new Set(unc.map((t) => t.kind))], dirs: [...new Set(unc.map((t) => t.dir))] });
  const sys = driveOf(process.env.SystemDrive || 'C:');
  const others = targets.filter((t) => t.kind !== 'exe' && driveOf(t.dir) && driveOf(t.dir) !== sys);
  if (!others.length) return issues;
  const types = await driveTypes();
  const hit = others.filter((t) => types[driveOf(t.dir)] === 'Removable');
  if (hit.length) issues.push({ rule: 'removable', level: LEVEL.removable, kinds: [...new Set(hit.map((t) => t.kind))], dirs: [...new Set(hit.map((t) => t.dir))] });
  const net = others.filter((t) => types[driveOf(t.dir)] === 'Network');
  if (net.length) {
    const it = issues.find((x) => x.rule === 'network') || (issues.push({ rule: 'network', level: LEVEL.network, kinds: [], dirs: [] }), issues[issues.length - 1]);
    for (const t of net) { if (!it.kinds.includes(t.kind)) it.kinds.push(t.kind); if (!it.dirs.includes(t.dir)) it.dirs.push(t.dir); }
  }
  return sort(issues);
}

/** 忽略记录的键：规则 + 文件夹 */
const keyOf = (rule, dir) => `${rule}|${norm(dir)}`;

/** 启动器当前要检查的文件夹 */
function currentTargets() {
  const loc = location.get();
  const targets = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) targets.push({ kind: 'exe', dir: process.env.PORTABLE_EXECUTABLE_DIR });
  // 用环境变量指定数据目录时是测试 / 开发环境，不检查数据和游戏目录
  if (loc.mode !== 'env') {
    if (loc.base) targets.push({ kind: 'data', dir: loc.base });
    if (config.get().gameDir) targets.push({ kind: 'game', dir: config.get().gameDir });
  }
  return targets;
}

/**
 * 启动时的检查
 * @returns {{issues: object[], portableExe: boolean, mode: string}} issues 带 ignored（玩家选了「这个位置不再提示」）
 */
async function check() {
  const loc = location.get();
  const targets = currentTargets();
  let issues = await addRemovable(inspect(targets), targets);
  if (loc.failedBase) issues.unshift({ rule: 'unwritable', level: LEVEL.unwritable, kinds: ['data'], dirs: [loc.failedBase], mode: loc.failedMode });
  const ignored = new Set(config.get().placeIgnore || []);
  issues = issues.map((it) => ({ ...it, ignored: it.dirs.every((d) => ignored.has(keyOf(it.rule, d))) }));
  return { issues, portableExe: !!process.env.PORTABLE_EXECUTABLE_FILE, mode: loc.mode };
}

/** 「这个位置不再提示」 */
function ignore(issues) {
  const set = new Set(config.get().placeIgnore || []);
  for (const it of issues || []) for (const d of it.dirs || []) set.add(keyOf(it.rule, d));
  config.set({ placeIgnore: [...set] });
  return true;
}

/** 能不能在这个文件夹里写文件：文件夹还不存在时试最近的上级文件夹，不会提前把它建出来 */
async function canWrite(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    const st = await fsp.stat(d).catch(() => null);
    if (st && st.isDirectory()) break;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
  const f = path.join(d, `.aurora-write-test-${process.pid}`);
  try { await fsp.writeFile(f, 'ok'); await fsp.rm(f, { force: true }); return true; } catch { return false; }
}

/** 向导和「移动」对话框用：某个候选文件夹会不会有问题，能不能写入 */
async function probe(dir, kind = 'data') {
  const targets = [{ kind, dir }];
  const issues = await addRemovable(inspect(targets), targets);
  const writable = await canWrite(dir);
  if (!writable) issues.unshift({ rule: 'unwritable', level: LEVEL.unwritable, kinds: [kind], dirs: [dir] });
  return { dir, issues, writable };
}

/** 推荐的存放位置：有第二块固定硬盘时放在它的 Games 文件夹，否则放在用户文件夹的 Games 里 */
async function suggest() {
  const sys = driveOf(process.env.SystemDrive || 'C:');
  const types = await driveTypes();
  const other = Object.keys(types).sort().find((d) => d !== sys && types[d] === 'Fixed');
  return folderIn(path.join(other ? `${other}:\\` : os.homedir(), 'Games'));
}

/**
 * base 里启动器该放的文件夹。启动器改过名字（rc12）：以前按旧名字建过文件夹就接着用它，不另起一个——
 * 那里面可能有便携模式的标记和数据，新版放进同一个文件夹才接得上；另起一个的话数据还在旧文件夹里，玩家会以为东西没了
 */
async function folderIn(base) {
  for (const name of [BRAND.name, ...(BRAND.formerNames || [])]) {
    try { if ((await fsp.stat(path.join(base, name))).isDirectory()) return path.join(base, name); } catch { /* 没有这个文件夹 */ }
  }
  return path.join(base, BRAND.name);
}

/**
 * 把便携版 exe（便携模式时连同 AuroraData 和标记文件）复制到新文件夹，可选在桌面创建快捷方式。
 * 原位置的文件不删除（exe 正在运行，也方便玩家确认新位置正常后自己删）。
 * @returns {{exe: string, dir: string}} 新 exe 的路径，随后调用 relaunchMoved()
 */
async function moveTo(dir, { shortcut = true } = {}, task) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!exe) throw new Error('只有便携版可以移动，安装版请在「设置 → 数据存储位置」里换文件夹');
  if (!dir || !path.isAbsolute(dir)) throw new Error('请选择一个文件夹');
  dir = path.resolve(dir);
  if (norm(dir) === norm(path.dirname(exe))) throw new Error('新位置和现在的位置相同');
  if (under(dir, path.join(path.dirname(exe), location.PORTABLE_DIR))) throw new Error('不能放进启动器自己的数据文件夹里');
  try { await location.writable(dir); } catch (e) { throw new Error(`这个文件夹无法写入：${e.code || e.message}`); }
  const target = path.join(dir, path.basename(exe));
  if (task) task.update({ detail: '复制启动器…', progress: -1 });
  await fsp.copyFile(exe, target);
  // 便携模式（包括数据文件夹写不进去、临时退回默认位置的情况）：标记文件和 AuroraData 一起复制
  const loc = location.get();
  const marker = path.join(path.dirname(exe), location.MARKER);
  if (loc.mode === 'portable' || loc.failedMode === 'portable') await fsp.copyFile(marker, path.join(dir, location.MARKER)).catch(() => {});
  if (loc.mode === 'portable') {
    await config.flush();
    const from = path.join(path.dirname(exe), location.PORTABLE_DIR);
    const to = path.join(dir, location.PORTABLE_DIR);
    const total = (await location.dirSize(from, 15000)).files || 1;
    let done = 0;
    const onFile = (name) => {
      done++;
      if (task && (done % 25 === 0 || done === total)) task.update({ detail: `复制数据：${done}/${total} · ${nm(name)}`, progress: Math.min(0.99, done / total) });
    };
    for (const e of await fsp.readdir(from, { withFileTypes: true }).catch(() => [])) {
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.name === 'launcher' && e.isDirectory()) {
        // 启动器数据只复制配置和下载的 Java；Electron 的浏览器缓存正被占用，也不需要
        await fsp.mkdir(d, { recursive: true });
        for (const n of await location.launcherEntries(s)) {
          if ((await fsp.stat(path.join(s, n))).isDirectory()) await location.copyTree(path.join(s, n), path.join(d, n), onFile);
          else { await fsp.copyFile(path.join(s, n), path.join(d, n)); onFile(n); }
        }
      } else if (e.isDirectory()) await location.copyTree(s, d, onFile);
      else if (e.isFile()) { await fsp.mkdir(to, { recursive: true }); await fsp.copyFile(s, d); onFile(e.name); }
    }
  }
  if (shortcut) placeShortcut(target, dir, exe);
  moved = target;
  return { exe: target, dir };
}

/**
 * 桌面快捷方式指到新位置。桌面上已有指着原来那个 exe 的快捷方式（包括改名以前按旧名字建的），就把它改成指新位置，
 * 不另建一个：不然桌面上两个图标，旧的那个打开的是原位置那一份数据，玩家会以为改过的东西没了。
 * 一个都没有才按现在的名字新建。创建失败不影响移动
 */
function placeShortcut(target, dir, fromExe) {
  const { shell } = require('electron');
  const desk = app().getPath('desktop');
  const opts = { target, cwd: dir, description: BRAND.name };
  let updated = 0;
  for (const name of [BRAND.name, ...(BRAND.formerNames || [])]) {
    const lnk = path.join(desk, `${name}.lnk`);
    let cur = null;
    try { cur = shell.readShortcutLink(lnk); } catch { continue; } // 没有这个快捷方式
    if (cur && cur.target && norm(cur.target) === norm(fromExe)) {
      try { if (shell.writeShortcutLink(lnk, 'update', opts)) updated++; } catch { /* 改不了就当没有 */ }
    }
  }
  if (!updated) {
    try { shell.writeShortcutLink(path.join(desk, `${BRAND.name}.lnk`), 'create', opts); } catch { /* 创建失败不影响移动 */ }
  }
  return updated;
}

/** 从刚移动到的新位置重启（只接受 moveTo 复制出来的 exe） */
let moved = '';
function relaunchMoved() {
  if (!moved) return false;
  const a = app();
  a.relaunch({ execPath: moved, args: [] });
  a.exit(0);
  return true;
}

module.exports = { check, inspect, probe, ignore, suggest, folderIn, moveTo, placeShortcut, relaunchMoved, env, keyOf, LEVEL, addDriveKinds: addRemovable, _resetDrives: () => { drives = null; } };
