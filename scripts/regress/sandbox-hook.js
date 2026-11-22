'use strict';
/**
 * 危险测试的隔离层（2.0.0-pre8，全面测试的安全、坏输入）。这些测试会把乱七八糟的参数真的传给每个接口，
 * 所以不能只靠「数据目录指到临时目录」，要保证代码就算有路径穿越的 bug，也碰不到真实文件：
 *
 * - 写屏障：fs 和 fs.promises 所有会改文件的调用，目标不在 root 里就报错并记下来
 * - 网络屏障：net.fetch、http、https 只放行本机地址，其他的报错并记下来
 * - 进程屏障：child_process 全部不真的启动，记下命令
 * - 外部调用：打开文件夹、外部网页、文件对话框、回收站、重启、退出都变成记录
 * - 环境变量和 app.getPath 的用户目录都指到 root 里，代码退回默认路径时也出不去
 *
 * 要在加载任何核心模块之前调用 seal(root)。结束前调用 release() 才能真正退出。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const cp = require('child_process');
const electron = require('electron');

function seal(root) {
  const { app, shell, dialog, net, session } = electron;
  const base = path.resolve(root);
  const log = { writes: [], net: [], spawns: [], shell: [], reads: [], quit: [] };
  const isUnder = (p) => {
    const rel = path.relative(base, p);
    return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
  };
  const toPath = (p) => {
    if (typeof p === 'string') return p;
    if (Buffer.isBuffer(p)) return p.toString('utf8');
    if (p instanceof URL) return require('url').fileURLToPath(p);
    return null;
  };
  let released = false;
  const allowed = (p) => {
    const s = toPath(p);
    if (released || s == null) return true; // 测试结束 / 文件句柄
    // Windows 会悄悄去掉每一段结尾的点和空格，要按真正落到的位置算
    const norm = path.resolve(s.split(/[\\/]/).map((seg) => (/^\.+$/.test(seg) ? seg : seg.replace(/[. ]+$/, ''))).join(path.sep));
    return isUnder(path.resolve(s)) && isUnder(norm);
  };
  const denied = (name, p) => {
    log.writes.push({ op: name, path: String(toPath(p)).slice(0, 300) });
    return Object.assign(new Error(`隔离层拦下了写操作：${name}`), { code: 'EACCES', sandboxDenied: true });
  };

  const WRITE_FLAG = /[wa+]/;
  // 名字 → 哪几个参数是要写的路径
  const OPS = {
    writeFile: [0], appendFile: [0], rename: [0, 1], rm: [0], rmdir: [0], unlink: [0], mkdir: [0], copyFile: [1], cp: [1], symlink: [0, 1], link: [1],
    truncate: [0], chmod: [0], chown: [0], utimes: [0], mkdtemp: [0], lchown: [0], lutimes: [0],
  };
  const targets = (name, args) => (name === 'symlink'
    // symlink(目标, 链接位置)：目标可以是相对路径，按链接所在目录算
    ? [path.resolve(path.dirname(String(toPath(args[1]))), String(toPath(args[0]))), args[1]]
    : OPS[name].map((i) => args[i]));
  const rejectFor = (name, args) => {
    for (const t of targets(name, args)) if (typeof t !== 'undefined' && !allowed(t)) return denied(name, t);
    return null;
  };
  for (const name of Object.keys(OPS)) {
    if (typeof fs.promises[name] === 'function') {
      const orig = fs.promises[name];
      fs.promises[name] = function (...args) {
        const e = rejectFor(name, args);
        return e ? Promise.reject(e) : orig.apply(this, args);
      };
    }
    if (typeof fs[name] === 'function') {
      const orig = fs[name];
      fs[name] = function (...args) {
        const e = rejectFor(name, args);
        if (!e) return orig.apply(this, args);
        const cb = args[args.length - 1];
        if (typeof cb === 'function') { setImmediate(cb, e); return undefined; }
        throw e;
      };
    }
    const sync = `${name}Sync`;
    if (typeof fs[sync] === 'function') {
      const orig = fs[sync];
      fs[sync] = function (...args) {
        const e = rejectFor(name, args);
        if (e) throw e;
        return orig.apply(this, args);
      };
    }
  }
  const openFlagged = (flags) => WRITE_FLAG.test(String(flags == null ? 'r' : flags));
  const fspOpen = fs.promises.open;
  fs.promises.open = function (p, flags, ...rest) {
    if (openFlagged(flags) && !allowed(p)) return Promise.reject(denied('open', p));
    return fspOpen.call(this, p, flags, ...rest);
  };
  const fsOpen = fs.open;
  fs.open = function (p, flags, ...rest) {
    if (openFlagged(typeof flags === 'function' ? 'r' : flags) && !allowed(p)) {
      const cb = rest[rest.length - 1];
      const e = denied('open', p);
      if (typeof cb === 'function') { setImmediate(cb, e); return undefined; }
      throw e;
    }
    return fsOpen.call(this, p, flags, ...rest);
  };
  const fsOpenSync = fs.openSync;
  fs.openSync = function (p, flags, ...rest) {
    if (openFlagged(flags) && !allowed(p)) throw denied('openSync', p);
    return fsOpenSync.call(this, p, flags, ...rest);
  };
  const cws = fs.createWriteStream;
  fs.createWriteStream = function (p, ...rest) {
    if (!allowed(p)) {
      const s = new (require('stream').PassThrough)();
      setImmediate(() => s.destroy(denied('createWriteStream', p)));
      return s;
    }
    return cws.call(this, p, ...rest);
  };

  // 记下读了哪些诱饵（log.reads），判断接口能不能被用来读任意文件。读本身不拦
  const noteRead = (p) => { const s = toPath(p); if (s && /aurora-canary/i.test(s)) log.reads.push(String(s).slice(0, 300)); };
  const fspRead = fs.promises.readFile;
  fs.promises.readFile = function (p, ...rest) { noteRead(p); return fspRead.call(this, p, ...rest); };
  const fsReadSync = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { noteRead(p); return fsReadSync.call(this, p, ...rest); };

  // ── 网络 ──
  // AURORA_SANDBOX_NET_ALLOW：只给要真下载的测试用（2026-11-07 从真的 Prism 导入要联网重装），写的是一组主机名的正则，其余照样拦
  const netAllow = process.env.AURORA_SANDBOX_NET_ALLOW ? new RegExp(process.env.AURORA_SANDBOX_NET_ALLOW, 'i') : null;
  const local = (u) => { try { const host = new URL(String(u)).hostname; return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host) || !!(netAllow && netAllow.test(host)); } catch { return false; } };
  const blockNet = (u) => {
    log.net.push(String(u).slice(0, 200));
    return Object.assign(new Error('getaddrinfo ENOTFOUND（隔离层拦下了网络请求）'), { code: 'ENOTFOUND' });
  };
  const fetchGuard = (orig) => function (u, ...rest) {
    const url = u && u.url ? u.url : u;
    return local(url) ? orig.call(this, u, ...rest) : Promise.reject(blockNet(url));
  };
  try { net.fetch = fetchGuard(net.fetch); } catch { /* 下面的 session 兜底 */ }
  try { global.fetch = fetchGuard(global.fetch); } catch { /* 没有全局 fetch */ }
  const requestGuard = (mod, proto) => {
    for (const name of ['request', 'get']) {
      const orig = mod[name];
      mod[name] = function (a, ...rest) {
        const url = typeof a === 'string' || a instanceof URL ? String(a) : `${proto}://${(a && (a.hostname || a.host)) || 'localhost'}/`;
        if (local(url)) return orig.call(this, a, ...rest);
        const req = new EventEmitter();
        req.end = req.write = req.setTimeout = req.setHeader = () => req;
        req.destroy = req.abort = () => req;
        const e = blockNet(url);
        setImmediate(() => req.emit('error', e));
        return req;
      };
    }
  };
  requestGuard(http, 'http');
  requestGuard(https, 'https');
  // net.fetch 内部也走 net.request，本机地址要放行
  try {
    const netRequest = net.request;
    net.request = function (o, ...rest) {
      const url = typeof o === 'string' ? o : o && o.url;
      if (local(url)) return netRequest.call(this, o, ...rest);
      throw blockNet(url);
    };
  } catch { /* 只读 */ }
  app.whenReady().then(() => { try { session.defaultSession.fetch = fetchGuard(session.defaultSession.fetch); } catch { /* 只读 */ } }).catch(() => {});

  // ── 进程 ──
  const fakeChild = (cmd, args) => {
    log.spawns.push({ cmd: String(cmd).slice(0, 300), args: (args || []).slice(0, 8).map((a) => String(a).slice(0, 120)) });
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { write() {}, end() {} };
    c.stdout.setEncoding = c.stderr.setEncoding = () => {};
    c.stdout.pipe = c.stderr.pipe = () => {};
    c.pid = 0; c.kill = () => true; c.unref = () => {}; c.ref = () => {};
    setImmediate(() => { c.emit('error', Object.assign(new Error('隔离层没有启动这个进程'), { code: 'ENOENT' })); c.emit('close', 1); });
    return c;
  };
  // AURORA_SANDBOX_SPAWN_ALLOW：真进游戏的场景放行测试用的 Java 和只读的查询命令（正则）。默认什么都不放行
  const allowSpawn = process.env.AURORA_SANDBOX_SPAWN_ALLOW ? new RegExp(process.env.AURORA_SANDBOX_SPAWN_ALLOW, 'i') : null;
  const real = { spawn: cp.spawn, execFile: cp.execFile };
  cp.spawn = (cmd, args, ...rest) => (allowSpawn && allowSpawn.test(String(cmd)) ? real.spawn(cmd, args, ...rest) : fakeChild(cmd, Array.isArray(args) ? args : []));
  cp.fork = (cmd, args) => fakeChild(cmd, Array.isArray(args) ? args : []);
  cp.execFile = (cmd, args, o, cb) => {
    if (allowSpawn && allowSpawn.test(String(cmd))) return real.execFile(cmd, args, o, cb);
    const done = [args, o, cb].find((x) => typeof x === 'function');
    const c = fakeChild(cmd, Array.isArray(args) ? args : []);
    c.removeAllListeners('error');
    c.on('error', () => {});
    if (done) setImmediate(done, Object.assign(new Error('隔离层没有启动这个进程'), { code: 'ENOENT' }), '', '');
    return c;
  };
  cp.exec = (cmd, o, cb) => cp.execFile(cmd, [], o, cb);
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    cp[name] = (cmd, args) => {
      log.spawns.push({ cmd: String(cmd).slice(0, 300), args: Array.isArray(args) ? args.slice(0, 8).map(String) : [] });
      if (name === 'spawnSync') return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: new Error('隔离层没有启动这个进程') };
      throw new Error('隔离层没有启动这个进程');
    };
  }

  // ── 外部调用 ──
  const note = (kind) => (...args) => { log.shell.push({ kind, arg: String(args[0]).slice(0, 300) }); return undefined; };
  shell.openExternal = async (...a) => { note('openExternal')(...a); };
  shell.openPath = async (...a) => { note('openPath')(...a); return ''; };
  shell.showItemInFolder = note('showItemInFolder');
  shell.beep = () => {};
  shell.writeShortcutLink = (...a) => { note('writeShortcutLink')(...a); return false; };
  shell.trashItem = async (p) => { note('trashItem')(p); throw new Error('隔离层没有用真实回收站'); };
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  dialog.showMessageBoxSync = () => 0;
  dialog.showOpenDialogSync = () => undefined;
  dialog.showSaveDialogSync = () => undefined;
  dialog.showErrorBox = () => {};
  const realExit = app.exit.bind(app);
  const realQuit = app.quit.bind(app);
  app.relaunch = (...a) => { log.quit.push({ kind: 'relaunch', arg: a[0] }); };
  app.quit = () => { log.quit.push({ kind: 'quit' }); };
  app.exit = (c) => { log.quit.push({ kind: 'exit', code: c }); };
  for (const name of ['setLoginItemSettings', 'setAsDefaultProtocolClient', 'removeAsDefaultProtocolClient', 'setUserTasks', 'setJumpList']) {
    if (typeof app[name] === 'function') app[name] = () => { log.shell.push({ kind: name }); return false; };
  }

  // ── 用户目录 ──
  // Chromium 自己的缓存、Local State 不走 Node 的 fs，写屏障管不到，必须在启动前就把 userData 指进来
  const userData = process.env.AURORA_DATA_DIR || path.join(base, 'data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  const home = path.join(base, 'fakehome');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localData = path.join(home, 'AppData', 'Local');
  const temp = path.join(localData, 'Temp');
  for (const d of [appData, localData, temp, path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, 'Documents')]) fs.mkdirSync(d, { recursive: true });
  Object.assign(process.env, { APPDATA: appData, LOCALAPPDATA: localData, USERPROFILE: home, HOME: home, HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2), TEMP: temp, TMP: temp, AURORA_TEST_TRASH: path.join(base, 'trash') });
  for (const [k, v] of Object.entries({ home, appData, temp, desktop: path.join(home, 'Desktop'), downloads: path.join(home, 'Downloads'), documents: path.join(home, 'Documents') })) {
    try { app.setPath(k, v); } catch { /* 个别名字不让改 */ }
  }

  return {
    log, base,
    /** 把日志清空，返回这段时间记下来的 */
    drain() {
      const out = {};
      for (const k of Object.keys(log)) { out[k] = log[k]; log[k] = []; }
      return out;
    },
    /** 测试结束：恢复真正的退出，结果文件也能写到测试目录外面了（harness.finish 要用） */
    release() { released = true; app.exit = realExit; },
    /** 真实窗口的测试要能正常退出（before-quit 里的收尾也是要测的） */
    allowQuit() { app.quit = realQuit; },
  };
}

module.exports = { seal };
