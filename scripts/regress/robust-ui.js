'use strict';
/**
 * 真实窗口的安全和坏输入（2.0.0-pre8，全面测试高优先级第 2、3 项）。启动器关在 sandbox-run.js 的隔离层里：
 * 写不出测试目录、连不了外网、起不了进程。
 *   node scripts/regress/robust-ui.js [场景,场景]
 * - renderer-security  渲染进程的安全设置：Node 能力、CSP、接口白名单、跳转、权限、HTML 净化
 * - hostile-names      名字和描述里带 HTML：页面上不能变成元素
 * - config-poison      设置文件里每一项都是错的类型：能打开、各页不报错，退出后不丢别的数据
 * - stores-poison      账户、方案、配置档案、版本 JSON、皮肤库类型全错
 * - bad-net            接口返回各种坏内容：错误页、类型全错、半截、不回答、带脚本
 * - recover-start      上次没有正常退出时，窗口打开之前就收拾好
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { connect, waitExit, freePort, sleep, NO_THROTTLE, track, until, waitFor } = require('./cdp');

const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const OUT = process.env.AURORA_REGRESS_OUT;

const results = [];
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 900)}` : ''}`);
}

const BASE_CONFIG = (game) => ({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game, selectedVersion: 'Plain', migrateAsk: true });
const { PAGES } = require('./pages'); // 页面清单只有一份（pages.js）

function fakeVersion(game, id, extra = {}) {
  const dir = path.join(game, 'versions', id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], ...extra }));
  return dir;
}

/** 起一个关在隔离层里的启动器。prepare(ctx) 在启动前写数据 */
async function start(name, { prepare, config, badnet, keepData, root: rootDir, appDir, stats, javas, foreign, args = [] } = {}) {
  const root = rootDir || path.join(BASE, 'robust-ui', name);
  if (!keepData) await fs.promises.rm(root, { recursive: true, force: true });
  const data = path.join(root, 'data');
  const game = path.join(root, 'game');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(game, { recursive: true });
  const ctx = { root, data, game };
  if (!keepData) {
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config ? config(game) : BASE_CONFIG(game)));
    fakeVersion(game, 'Plain');
    if (prepare) prepare(ctx);
  }
  await fs.promises.rm(path.join(root, 'sandbox-log.json'), { force: true }); // 系统 Node 的 fs.rmSync 碰到中文路径会崩
  // 窗口被挡住、显示器休眠时 Chromium 会把定时器限到每分钟一次、停掉动画（rc4 测试跑到一半碰到过）：测试窗口一律不降速
  // 偶尔会连不上调试端口（挑好的空闲端口被别的程序抢先占了；rc9 跑关卡时三遍里碰到三次，每次都让一整个脚本白跑）：换个端口重来，最多三次
  let child = null;
  let c = null;
  let dead = null;
  let startError = '';
  for (let attempt = 0; attempt < 3 && !c; attempt++) {
    const port = await freePort();
    const me = track(spawn(ELECTRON, ['-r', path.join(__dirname, 'sandbox-run.js'), `--remote-debugging-port=${port}`, ...NO_THROTTLE, ...args, '.'], {
      cwd: appDir || process.env.AURORA_REGRESS_APP || REPO, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AURORA_SANDBOX_ROOT: root, AURORA_DATA_DIR: data, AURORA_GAME_DIR: game, AURORA_BADNET: badnet || '', AURORA_SANDBOX_STATS: stats ? '1' : '', AURORA_SANDBOX_JAVAS: javas ? JSON.stringify(javas) : '', AURORA_SANDBOX_FOREIGN: foreign ? JSON.stringify(foreign) : '', ELECTRON_ENABLE_LOGGING: '' }, // javas：检测 Java 的结果固定成这一份（见 sandbox-run.js）
    }));
    child = me;
    dead = null;
    me.once('exit', (code) => { if (child === me) dead = code; });
    try { c = await connect(port, { tries: 60 }); } catch (e) {
      startError = `${e.message}${dead != null ? `（进程已退出 ${dead}）` : ''}`;
      try { me.kill(); } catch { /* 已退出 */ }
      await waitExit(me, 10000);
    }
  }
  if (!c) return { ...ctx, startError: `${startError}（试了 3 次）`, child, stop: async () => { try { child.kill(); } catch { /* 已退出 */ } } };
  const errors = [];
  await c.send('Runtime.enable');
  c.on((d) => {
    if (d.method === 'Runtime.exceptionThrown') {
      const x = d.params.exceptionDetails;
      errors.push(`${x.text} ${(x.exception && (x.exception.description || x.exception.value)) || ''}`.slice(0, 300));
    }
  });
  const log = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'sandbox-log.json'), 'utf8')); } catch { return { crashes: [], writes: [], spawns: [], shell: [], net: [], quit: [] }; } };
  return {
    ...ctx, ...c, child, errors, log, alive: () => dead == null,
    stop: async () => {
      try { await c.quit(); } catch { /* 已断开 */ }
      await waitExit(child, 8000);
    },
  };
}

/** 进到每个页面，页面崩了 errors 里会有东西 */
async function visitAll(a) {
  const blank = [];
  for (const id of PAGES) {
    const r = await a.ev(`(async () => { try { await A.go(${JSON.stringify(id)}); } catch (e) { return 'throw:' + e.message; } await new Promise((r) => setTimeout(r, 120)); const el = document.querySelector('.main'); return el ? el.innerText.trim().length : -1; })()`, 15000).catch((e) => `ev:${e.message}`);
    if (typeof r === 'string' || r <= 0) blank.push(`${id}=${r}`);
  }
  return blank;
}

const SCENARIOS = {
  /** 渲染进程被恶意内容钻了空子时，能做的事要尽量少 */
  async 'renderer-security'() {
    const a = await start('sec', {
      prepare: ({ root }) => {
        const dir = path.join(root, 'aurora-canary');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'evil.html'), '<!doctype html><title>EVIL</title><script>document.title = "EVIL-RAN:" + (typeof aurora)</script>');
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'aurora canary');
      },
    });
    const J = (x) => JSON.stringify(x);
    const nodeCaps = await a.ev("JSON.stringify({ require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer, global: typeof global, ipc: typeof ipcRenderer })");
    check('安全', '渲染进程拿不到 Node 能力', !/"(function|object)"/.test(nodeCaps), nodeCaps);
    const keys = await a.ev('Object.keys(window.aurora).sort().join()');
    check('安全', '暴露给页面的只有这几个接口', keys === 'call,invoke,on,pathForFile,platform', keys);
    const css = await a.ev("(() => { const m = document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]'); return m ? m.content : ''; })()");
    check('安全', 'CSP：脚本只能来自自己，不能内联', /script-src 'self'(;|$)/.test(css) && !/unsafe-inline[^;]*;\s*font/.test(css.replace(/style-src[^;]*;/, '')), css);
    // 调试协议默认替这次调用绕过 CSP 的 eval 限制，要关掉才测得出来
    const evalRaw = async (js) => {
      const r = await a.send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false });
      return r.result.value;
    };
    const inline = await evalRaw(`(async () => {
      window.__xss = 0;
      const s = document.createElement('script'); s.textContent = 'window.__xss = 1'; document.body.appendChild(s);
      const i = document.createElement('img'); i.setAttribute('src', 'data:,x'); i.setAttribute('onerror', 'window.__xss = 2'); document.body.appendChild(i);
      const d = document.createElement('div'); d.innerHTML = '<img src=x onerror="window.__xss = 3"><a href="javascript:window.__xss=4" id="__xa">x</a>'; document.body.appendChild(d);
      d.querySelector('#__xa').click();
      let ev = 'blocked'; try { eval('window.__xss = 5'); ev = 'ran'; } catch { /* CSP */ }
      let fn = 'blocked'; try { new Function('window.__xss = 6')(); fn = 'ran'; } catch { /* CSP */ }
      const ext = document.createElement('script'); ext.src = 'https://127.0.0.1:1/x.js'; document.body.appendChild(ext);
      await new Promise((r) => setTimeout(r, 400));
      s.remove(); i.remove(); d.remove(); ext.remove();
      return { xss: window.__xss, ev, fn };
    })()`);
    check('安全', '内联脚本、事件属性、javascript: 链接、eval、new Function 都不会运行', inline.xss === 0 && inline.ev === 'blocked' && inline.fn === 'blocked', inline);
    const bad = await a.ev("(async () => { const r = await aurora.invoke('evil:channel'); let threw = false; try { aurora.on('evil:event', () => {}); } catch { threw = true; } let c = ''; try { await aurora.call('fs:read', 'x'); } catch (e) { c = e.message; } return { r, threw, c }; })()");
    check('安全', '白名单外的接口和事件被拒绝', bad.r && bad.r.ok === false && bad.threw && !!bad.c, bad);

    // 窗口和跳转
    const before = await a.ev('location.href');
    // https 的放在最后开：主进程按顺序处理，等到它记上了，前面两个要是被交出去也早记上了
    const opened = await a.ev("(() => { const w1 = window.open('file:///C:/Windows/win.ini'); const w2 = window.open('javascript:1'); const w3 = window.open('https://example.com/a'); return [w1 === null, w2 === null, w3 === null]; })()");
    await sleep(400); // pitfall-ok：要证明没有开新窗口，只能等一会儿看
    check('安全', 'window.open 不开新窗口', opened.every(Boolean), opened);
    const tg = await (await fetch(`http://127.0.0.1:${a.ws.url.match(/:(\d+)\//)[1]}/json`)).json();
    check('安全', '没有多出页面', tg.filter((t) => t.type === 'page').length === 1, tg.map((t) => t.url));
    // 交给系统浏览器是主进程异步记下来的：等到 https 那个记上了再看（以前只等 0.4 秒，机器忙时还没记上）
    const opens = () => a.log().shell.filter((s) => s.kind === 'openExternal').map((s) => s.arg);
    const ext = (await waitFor(() => { const v = opens(); return v.includes('https://example.com/a') && v; }, 8000)) || opens();
    check('安全', '外部网页只把 http(s) 交给系统浏览器', ext.includes('https://example.com/a') && !ext.some((u) => /^(file|javascript):/.test(u)), ext);

    const evilUrl = require('url').pathToFileURL(path.join(a.root, 'aurora-canary', 'evil.html')).href;
    await a.ev(`location.href = ${J(evilUrl)}; 1`).catch(() => {});
    await sleep(1500); // pitfall-ok：要证明页面没有跳走，只能等一会儿看
    const afterFile = await a.ev('location.href + " | " + document.title').catch((e) => e.message);
    check('安全', '页面跳不到磁盘上别的 HTML（那边也有 aurora 接口）', afterFile.startsWith(before.split('?')[0]) && !/EVIL/.test(afterFile), afterFile.slice(-80));
    if (/EVIL/.test(afterFile)) { await a.ev(`location.href = ${J(before)}; 1`).catch(() => {}); await until(a.ev, '!!(window.A && A.state)', 20000); }
    await a.ev("location.href = 'https://example.com/b'; 1").catch(() => {});
    await sleep(800); // pitfall-ok：要证明页面没有跳走，只能等一会儿看
    const afterHttp = await a.ev('location.href').catch((e) => e.message);
    check('安全', '页面跳不到网页', afterHttp.startsWith('file:'), afterHttp.slice(0, 80));

    // 权限默认全拒
    const perm = await a.ev(`(async () => {
      const out = {};
      out.notification = await Notification.requestPermission();
      try { await navigator.mediaDevices.getUserMedia({ audio: true }); out.mic = 'granted'; } catch (e) { out.mic = e.name; }
      out.geo = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r('denied:' + e.code), { timeout: 2000 }));
      return out;
    })()`, 20000);
    check('安全', '通知、麦克风、定位的权限请求都被拒绝', perm.notification !== 'granted' && perm.mic !== 'granted' && perm.geo !== 'granted', perm);
    const copy = await a.ev("(async () => { await A.copy('aurora-copy-test'); return 1; })()").catch((e) => e.message);
    check('功能', '复制到剪贴板照常工作', copy === 1, String(copy));

    // HTML 净化：Modrinth 介绍是别人写的
    const payloads = [
      '<img src=x onerror=window.__xss=1>', '<svg onload=window.__xss=1>', '<svg><script>window.__xss=1</script></svg>', '<a href="javascript:window.__xss=1">x</a>', '<a href="JaVaScRiPt:window.__xss=1">x</a>', '<a href=" javascript:window.__xss=1">x</a>',
      '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>', '<object data="javascript:1"></object>', '<embed src="javascript:1">', '<form action="javascript:1"><input type=submit></form>', '<math><mtext><img src=x onerror=window.__xss=1></mtext></math>',
      '<style>@import "https://x/y.css"; body{display:none}</style>', '<link rel=stylesheet href=https://x/y.css>', '<meta http-equiv=refresh content="0;url=https://x">', '<base href="https://x/">', '<img src="https://x/y.png" onload="window.__xss=1" style="position:fixed;inset:0">', '<div style="position:fixed;inset:0;background:red">x</div>',
      '![a"onerror="window.__xss=1](https://x/y.png)', '[x](javascript:window.__xss=1)', '[x](https://x"onclick="window.__xss=1)', '<p onclick=window.__xss=1>x</p>', '<table background="javascript:1"><tr><td colspan="99999">x</td></tr></table>', '<noscript><img src=x onerror=window.__xss=1></noscript>', '<template><img src=x onerror=window.__xss=1></template>', '<!--<img src=x onerror=window.__xss=1>-->', '<img src=file:///C:/Windows/win.ini>', '<img src=http://127.0.0.1:1/tracker.png>',
    ];
    const san = await a.ev(`(async () => {
      window.__xss = 0;
      const out = [];
      for (const p of ${J(payloads)}) {
        for (const fn of ['markdown', 'sanitize']) {
          const host = document.createElement('div');
          host.append(A[fn](p));
          document.body.append(host);
          const bad = [...host.querySelectorAll('*')].filter((e) => [...e.attributes].some((at) => /^on/i.test(at.name) || at.name === 'style' || (at.value && /^\\s*javascript:/i.test(at.value)) || (e.tagName === 'IMG' && at.name === 'src' && !/^https:/i.test(at.value)) || (e.tagName === 'A' && at.name === 'href' && !/^https?:/i.test(at.value))) || !['P','BR','B','STRONG','I','EM','U','A','UL','OL','LI','H1','H2','H3','H4','H5','H6','CODE','PRE','BLOCKQUOTE','IMG','HR','SPAN','DIV','TABLE','THEAD','TBODY','TR','TD','TH','DEL','S','SUB','SUP'].includes(e.tagName));
          if (bad.length) out.push(fn + ': ' + p + ' => ' + bad[0].outerHTML.slice(0, 80));
          host.remove();
        }
      }
      await new Promise((r) => setTimeout(r, 300));
      return { out, xss: window.__xss };
    })()`, 30000);
    check('安全', `HTML 净化：${payloads.length} 种写法都不留下脚本、事件、样式和危险链接`, san.out.length === 0 && san.xss === 0, san);

    const lg = a.log();
    check('安全', '主进程没有未捕获的异常', lg.crashes.length === 0, lg.crashes.slice(0, 4));
    check('安全', '隔离层没有拦下写到测试目录外面的操作', lg.writes.length === 0, lg.writes.slice(0, 4));
    await a.stop();
  },

  /** 玩家的名字和别人写的描述里带 HTML：只能是文字 */
  async 'hostile-names'() {
    const X = '<img src=x onerror=window.__xss=1>';
    const a = await start('names', {
      prepare: ({ game, data }) => {
        const { ZipWriter } = requireZip();
        const dir = fakeVersion(game, 'Hostile', { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] });
        fs.writeFileSync(path.join(dir, 'aurora-profile.json'), JSON.stringify({ name: X, description: `<script>window.__xss=1</script>${X}`, type: 'custom', isolation: { saves: 'own' } }));
        fs.mkdirSync(path.join(dir, 'saves', 'World1'), { recursive: true });
        fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({ selected: 'a1', accounts: [{ id: 'a1', type: 'offline', name: X, uuid: '00000000000000000000000000000001' }] }));
        fs.writeFileSync(path.join(data, 'plans.json'), JSON.stringify({ plans: [{ id: 'p1', name: X, mc: '1.20.1', loader: { type: 'fabric' }, items: [{ title: X, slug: X, source: 'modrinth' }] }] }));
        // Mod 的名字和描述来自 jar 里的 fabric.mod.json
        void ZipWriter;
      },
      config: (game) => ({ ...BASE_CONFIG(game), selectedVersion: 'Hostile', versionSettings: { Hostile: { isolation: 'on' } } }),
    });
    await a.ev('window.__xss = 0; 1');
    const blank = await visitAll(a);
    const r = await a.ev(`(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { xss: window.__xss, x: document.querySelectorAll('img[src="x"]').length, scripts: [...document.querySelectorAll('.main script, .modal script')].length };
    })()`);
    check('安全', '名字和描述里的 HTML 只显示成文字', r.xss === 0 && r.x === 0 && r.scripts === 0, r);
    check('坏输入', '每个页面都能打开', blank.length === 0, blank);
    check('坏输入', '页面没有未捕获的异常', a.errors.length === 0, a.errors.slice(0, 6));
    check('坏输入', '主进程没有未捕获的异常', a.log().crashes.length === 0, a.log().crashes.slice(0, 4));
    await a.stop();
  },

  /** config.json 被改坏、老版本写的、手改的：每一项的类型都不对 */
  async 'config-poison'() {
    const defaults = readDefaults();
    const keys = Object.keys(defaults).filter((k) => !['disclaimerAccepted', 'setupDone', 'gameDir', 'language'].includes(k));
    const bad = { null: null, 数字: 5, 字符串: 'x', 数组: [], 对象: {}, 布尔: true };
    const failures = [];
    let cfgRun = 0;
    const tryConfig = async (label, patch) => {
      const a = await start(`cfg-${cfgRun++}`, { config: (game) => ({ ...BASE_CONFIG(game), ...patch }) });
      if (a.startError) { await a.stop(); return { label, fail: [`起不来：${a.startError}`] }; }
      const blank = await visitAll(a);
      // 看结果：主页背景真的画出来了（有天空的配色、没有画画出错）。只看「有没有报错」不够：
      // 启动时就建场景，那时测试还没连上，出错了也收不到（时段被改成数字时就是这样，背景一片空）
      const sky = await a.ev(`(() => { const s = A.homeScene && A.homeScene(); if (!s) return null;
        return s.P && s.S && !s.drawErrors ? null : '主页背景没画出来：' + JSON.stringify({ scene: s.sceneId, period: s.period, drawErrors: s.drawErrors || 0 }); })()`).catch((e) => `查主页背景出错：${e.message}`);
      const lg = a.log();
      const fail = [...blank, ...(sky ? [sky] : []), ...a.errors.slice(0, 3), ...lg.crashes.slice(0, 2).map((c) => c.text)];
      await a.stop();
      return { label, fail };
    };
    for (const [label, value] of Object.entries(bad)) {
      const patch = {};
      for (const k of keys) patch[k] = value;
      const all = await tryConfig(`全部-${label}`, patch);
      console.log(`  全部设成${label}：${all.fail.length ? `${all.fail.length} 个问题：${all.fail.slice(0, 2).join(' | ').replace(/\s+/g, ' ').slice(0, 400)}` : '没问题'}`);
      if (!all.fail.length) continue;
      // 哪一项的问题：一项一项试
      for (const k of keys) {
        const one = await tryConfig(`${k}-${label}`, { [k]: value });
        if (one.fail.length) { failures.push({ key: k, type: label, fail: one.fail[0] }); console.log(`  ${k}=${label}：${one.fail[0].replace(/\s+/g, ' ').slice(0, 300)}`); }
      }
    }
    // 每个对象里面的每一项也都错
    for (const [label, value] of Object.entries(bad)) {
      const patch = {};
      for (const k of keys) {
        if (!defaults[k] || typeof defaults[k] !== 'object' || Array.isArray(defaults[k])) continue;
        patch[k] = {};
        for (const c of Object.keys(defaults[k])) patch[k][c] = value;
      }
      const all = await tryConfig(`里层-${label}`, patch);
      console.log(`  对象里面全部设成${label}：${all.fail.length ? `${all.fail.length} 个问题：${all.fail.slice(0, 2).join(' | ').replace(/\s+/g, ' ').slice(0, 400)}` : '没问题'}`);
      if (all.fail.length) failures.push({ key: '里层', type: label, fail: all.fail[0] });
    }
    fs.writeFileSync(path.join(BASE, 'config-poison-report.json'), JSON.stringify(failures, null, 1));
    check('坏输入', '设置文件每一项类型都错：启动器能打开，各页不报错', failures.length === 0, failures.slice(0, 12));
  },

  /** 别的数据文件类型全错 */
  async 'stores-poison'() {
    const bads = [null, 5, 'x', [], {}, [null, 5, 'x', {}], { accounts: 5, plans: 5, selected: 5, items: 5, skins: 5, groups: 5 }, { accounts: [null, 5, {}, { id: 5, type: 5, name: 5 }], plans: [null, 5, {}, { id: 5, name: 5, items: 5 }], items: [null, 5, {}, { hash: 5, name: 5 }] }];
    const targets = {
      账户: (c, v) => fs.writeFileSync(path.join(c.data, 'accounts.json'), JSON.stringify(v)),
      方案: (c, v) => fs.writeFileSync(path.join(c.data, 'plans.json'), JSON.stringify(v)),
      皮肤库: (c, v) => { fs.mkdirSync(path.join(c.data, 'skins', 'library'), { recursive: true }); fs.writeFileSync(path.join(c.data, 'skins', 'library', 'library.json'), JSON.stringify(v)); },
      配置档案: (c, v) => { const d = fakeVersion(c.game, 'Poison'); fs.writeFileSync(path.join(d, 'aurora-profile.json'), JSON.stringify(v)); },
      版本JSON: (c, v) => { const d = fakeVersion(c.game, 'Poison'); fs.writeFileSync(path.join(d, 'Poison.json'), JSON.stringify(v)); },
      版本字段: (c, v) => { fakeVersion(c.game, 'Poison', { libraries: v, arguments: v, mainClass: v, inheritsFrom: typeof v === 'string' ? 'nope' : v, javaVersion: v, type: v, downloads: v, assetIndex: v, id: v }); },
      游戏设置主档: (c, v) => fs.writeFileSync(path.join(c.data, 'game-settings.json'), JSON.stringify(v)),
    };
    const failures = [];
    const only = process.env.AURORA_STORES ? process.env.AURORA_STORES.split(',') : null;
    let nth = 0;
    for (const [label, write] of Object.entries(targets)) {
      nth++;
      if (only && !only.includes(label)) continue;
      for (let i = 0; i < bads.length; i++) {
        const a = await start(`store-${nth}-${i}`, { prepare: (c) => write(c, bads[i]) });
        if (a.startError) { failures.push({ label, i, fail: a.startError }); await a.stop(); continue; }
        const blank = await visitAll(a);
        const lg = a.log();
        const fail = [...blank, ...a.errors.slice(0, 2), ...lg.crashes.slice(0, 2).map((c) => c.text)];
        if (fail.length) failures.push({ label, i, fail: fail[0] });
        await a.stop();
      }
      console.log(`  ${label}：跑完`);
      fs.writeFileSync(path.join(BASE, 'stores-poison-report.json'), JSON.stringify(failures, null, 1));
    }
    check('坏输入', '账户、方案、皮肤库、配置档案、版本 JSON 类型全错：能打开，各页不报错', failures.length === 0, failures.slice(0, 12));
  },

  /** 上次没有正常退出：窗口打开之前就要收拾好；正常退出后下次不用等 */
  async 'recover-start'() {
    const flag = (r) => path.join(r, 'data', '.aurora-running');
    const world = (r, n) => path.join(r, 'game', 'versions', 'Prof', 'saves', n);
    const mk = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
    const J = (id, extra = {}) => JSON.stringify({ id, type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], ...extra });
    const stamp = Date.now() - 3600000;
    let a = await start('recover', {
      config: (game) => ({ ...BASE_CONFIG(game), versionSettings: { Prof: { isolation: 'on' } } }),
      prepare: ({ game }) => { fakeVersion(game, 'Prof'); void game; },
    });
    check('恢复', '运行时有标记', fs.existsSync(flag(a.root)));
    const root = a.root;
    await a.stop();
    check('恢复', '正常退出后标记擦掉了', !fs.existsSync(flag(root)));

    // 正常退出之后留下的半成品：不挡启动，窗口打开时还没动
    mk(path.join(world(root, 'NormalStart'), '..', `NormalStart.aurora-old-${stamp}`, 'level.dat'), 'x');
    a = await start('recover', { root, keepData: true });
    check('恢复', '上次正常退出：开窗前不扫描', fs.existsSync(path.join(world(root, 'NormalStart'), '..', `NormalStart.aurora-old-${stamp}`, 'level.dat')));
    a.child.kill(); // 硬杀，不给收尾的机会
    await new Promise((r) => { setTimeout(r, 1500); });
    check('恢复', '硬杀之后标记还在', fs.existsSync(flag(root)));

    // 崩溃留下的：世界只在 .aurora-old 里，改名改到一半
    mk(path.join(world(root, 'W1'), '..', `W1.aurora-old-${stamp}`, 'level.dat'), 'old-W1');
    mk(path.join(world(root, 'W1'), '..', `W1.aurora-new-${stamp}`, 'level.dat'), 'half');
    mk(path.join(root, 'game', 'versions', 'After', 'Before.json'), J('Before'));
    a = await start('recover', { root, keepData: true });
    if (a.startError) { check('恢复', '崩溃后能打开', false, a.startError); return; }
    const ids = await a.ev('A.state.installed.map((v) => v.id).join()');
    check('恢复', '崩溃后：世界放回去了，界面一打开就能看到', fs.readFileSync(path.join(world(root, 'W1'), 'level.dat'), 'utf8') === 'old-W1');
    check('恢复', '崩溃后：改名改到一半的配置，界面一打开就在列表里', ids.split(',').includes('After'), ids);
    check('恢复', '崩溃后：页面和主进程都没有未捕获的异常', a.errors.length === 0 && a.log().crashes.length === 0, [...a.errors, ...a.log().crashes.map((c) => c.text)].slice(0, 3));
    await a.stop();
  },

  /** 接口返回坏内容：不能崩，不能卡死，不能把内容当 HTML */
  async 'bad-net'() {
    const modes = ['html', 'error500', 'empty', 'nulljson', 'arrayjson', 'numberjson', 'truncated', 'wrongtypes', 'wrongitems', 'xss', 'huge', 'hang'];
    const failures = [];
    for (const mode of modes) {
      const a = await start(`net-${mode}`, { badnet: mode });
      if (a.startError) { failures.push({ mode, fail: a.startError }); await a.stop(); continue; }
      await a.ev('window.__xss = 0; 1');
      const blank = await visitAll(a);
      // 把用得到网络的入口都走一遍
      const calls = ["versions:manifest", "news:list", "mods:search", "curseforge:search", "curseforge:categories", "loaders:list", "java:runtimes", "planner:styles", "vanillaplus:catalog", "components:optifineList", "mods:project", "mods:versions", "curseforge:project", "curseforge:files", "mirror:label", "sys:netProbe"];
      const argv = { 'mods:search': [{ query: 'x' }], 'curseforge:search': [{ query: 'x' }], 'loaders:list': ['fabric', '1.20.1'], 'vanillaplus:catalog': ['1.20.1', 'fabric'], 'components:optifineList': ['1.20.1'], 'mods:project': ['p1'], 'mods:versions': ['p1', {}], 'curseforge:project': [1], 'curseforge:files': [1, {}], 'curseforge:categories': ['mod'] };
      const stuck = [];
      for (const ch of calls) {
        const r = await a.ev(`Promise.race([aurora.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(argv[ch] || [])}).then((x) => 'done:' + (x && x.ok)), new Promise((r) => setTimeout(() => r('slow'), ${mode === 'hang' ? 300 : 8000}))])`, 20000).catch((e) => `ev:${e.message}`);
        if (r === 'slow' && mode !== 'hang') stuck.push(ch);
      }
      // 搜索结果真的渲染出来，再点进第一个
      await a.ev(`(async () => { await A.go('download'); await new Promise((r) => setTimeout(r, 1200)); const c = document.querySelector('.main .card, .main .res-card, .main .list-item'); if (c) c.click(); await new Promise((r) => setTimeout(r, 800)); document.querySelectorAll('.modal-back').forEach((m) => m.remove()); return 1; })()`, 15000).catch(() => {});
      const x = await a.ev("({ xss: window.__xss, x: document.querySelectorAll('img[src=\"x\"]').length })").catch(() => ({ xss: -1, x: -1 }));
      const lg = a.log();
      const fail = [...blank.map((b) => `空白页 ${b}`), ...stuck.map((s) => `卡住 ${s}`), ...a.errors.slice(0, 3), ...lg.crashes.slice(0, 2).map((c) => c.text)];
      if (x.xss || x.x) fail.push(`内容变成了 HTML：${JSON.stringify(x)}`);
      if (!a.alive()) fail.push('进程退出了');
      if (fail.length) failures.push({ mode, fail });
      console.log(`  ${mode}：${fail.length ? `${fail.length} 个问题` : '没问题'}（请求 ${lg.net.length} 个）`);
      await a.stop();
    }
    fs.writeFileSync(path.join(BASE, 'bad-net-report.json'), JSON.stringify(failures, null, 1));
    check('坏输入', '接口返回坏内容：不崩、不卡、不空白、不当 HTML', failures.length === 0, failures.slice(0, 8));
  },
};

function requireZip() { return {}; }

/** 读 config.js 的默认值（文件里是字面量，不用真的加载 electron） */
function readDefaults() {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'engine', 'config.js'), 'utf8');
  const m = src.match(/const DEFAULTS = (\{[\s\S]*?\n\});/);
  // eslint-disable-next-line no-new-func
  return new Function('BRAND', `return (${m[1]});`)({});
}

module.exports = { start, visitAll, fakeVersion, BASE_CONFIG };

if (require.main === module) (async () => {
  const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENARIOS);
  fs.mkdirSync(BASE, { recursive: true });
  for (const name of pick) {
    console.log(`\n=== robust-ui ${name} ===`);
    const t0 = Date.now();
    try { await SCENARIOS[name](); } catch (e) { check(name, '脚本运行出错', false, e.stack || String(e)); }
    console.log(`  用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  }
  if (OUT) fs.appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
