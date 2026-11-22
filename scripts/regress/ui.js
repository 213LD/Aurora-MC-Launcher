'use strict';
/**
 * 界面回归：启动隔离的开发版启动器，用 Chrome 调试协议操作（node scripts/regress/ui.js [场景,场景]）。
 * 配置器真实安装那一项（1-1）要 AURORA_REGRESS_GAME_SRC（装好 1.20.1 的游戏目录）和联网，没设就跳过。
 */
const { freePort, NO_THROTTLE, FIX_SEED, WORLD_SEED, calm, until, waitFor, waitExit } = require('./cdp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const BASE = require('./editions').BASE;
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const SRC = process.env.AURORA_REGRESS_GAME_SRC;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d}` : ''}`);
}

function fakeVersion(game, id, jars = []) {
  const dir = path.join(game, 'versions', id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, type: 'release', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] }));
  for (const j of jars) fs.writeFileSync(path.join(dir, 'mods', j), 'x');
}

/** 放一个假的 Java 8 并让启动器重新检测：启动假配置时不用先上网下载 Java（fake-java.js）。返回启动器认出来没有 */
async function useFakeJava(c) {
  require('./fake-java').fakeJava(c.game, 8);
  return c.ev("A.api('java:detect', true).then((l) => { A.state.javas = l; A.emit('javas', l); return l.some((j) => j.major === 8 && /fake-java-8/.test(j.home)); }, () => false)");
}

// 在公共目录的配置（改成独立时要问带不带世界）
const PUB = ['PubCopy', 'PubNo', 'PubCancel', 'PubStop', 'PubEmpty', 'PubSpace', 'PubAll', 'PubPart', 'PubBare', 'PubVan', 'PubHuge'];

function setMc(game, id, mc) {
  const f = path.join(game, 'versions', id, `${id}.json`);
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), clientVersion: mc }));
}

async function startApp(name, { language = 'zh-CN', withGame = false, config: extra = {}, setup: prepare, locale, safe } = {}) {
  const port = await freePort();
  const root = path.join(BASE, `ui-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data');
  const game = path.join(root, 'game');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(game, { recursive: true });
  const vs = {};
  for (const id of ['ModP', 'Slow', 'Empty', 'ToDelete', 'SnapP', 'RelP']) vs[id] = { isolation: 'on' };
  for (const id of PUB) vs[id] = { isolation: 'none' };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language, gameDir: game, selectedVersion: 'ModP', versionSettings: vs, ...extra }));
  if (prepare) prepare(game);
  fakeVersion(game, 'ModP', ['a.jar', 'b.jar', 'c.jar']);
  fakeVersion(game, 'Slow', Array.from({ length: 800 }, (_, i) => `slow-${i}.jar`));
  fakeVersion(game, 'Empty');
  fakeVersion(game, 'ToDelete');
  for (const id of PUB) fakeVersion(game, id);
  // 纯原版：不显示 Mod
  fs.writeFileSync(path.join(game, 'versions', 'PubVan', 'PubVan.json'), JSON.stringify({ id: 'PubVan', clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [] }));
  for (const n of ['公共世界一', 'PublicTwo']) {
    fs.mkdirSync(path.join(game, 'saves', n, 'region'), { recursive: true });
    fs.writeFileSync(path.join(game, 'saves', n, 'level.dat'), `level-${n}`);
    fs.writeFileSync(path.join(game, 'saves', n, 'region', 'r.0.0.mca'), Buffer.alloc(200 * 1024, 7));
    fs.writeFileSync(path.join(game, 'saves', n, 'session.lock'), 'lock');
  }
  for (const [id, mc] of [['SnapP', '24w14a'], ['RelP', '1.20.1']]) {
    fakeVersion(game, id);
    setMc(game, id, mc);
    fs.mkdirSync(path.join(game, 'versions', id, 'saves', `${id}World`), { recursive: true });
    fs.writeFileSync(path.join(game, 'versions', id, 'saves', `${id}World`, 'level.dat'), 'world');
  }
  if (withGame && SRC) {
    for (const d of ['libraries', 'assets']) fs.cpSync(path.join(SRC, d), path.join(game, d), { recursive: true });
    fs.cpSync(path.join(SRC, 'versions', '1.20.1'), path.join(game, 'versions', '1.20.1'), { recursive: true });
  }
  const child = spawn(ELECTRON, [...(locale ? ['-r', path.join(__dirname, 'locale-hook.js')] : []), ...(safe ? ['-r', path.join(__dirname, 'safe-hook.js')] : []), `--remote-debugging-port=${port}`, ...NO_THROTTLE, '.'], { // 后台也不降速（见 cdp.js）
    cwd: process.env.AURORA_REGRESS_APP || REPO, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, AURORA_TEST_LOCALE: locale || '', AURORA_DATA_DIR: data, AURORA_GAME_DIR: game, AURORA_TEST_LEAK_LOG: safe ? path.join(root, 'leak.log') : '', AURORA_TEST_TRASH: path.join(root, 'fake-trash'), AURORA_SHOT_DIR: path.join(root, 'shots'), AURORA_SHOT_PAGES: '-#start', AURORA_SHOT_KEEP: '1', AURORA_SHOT_DELAY: '1500' },
  });
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = l.find((t) => t.type === 'page' && !/devtools/.test(t.url)); } catch { /* 还没起来 */ }
    await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
  }
  if (!page) throw new Error('连不上调试端口');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const k = ++id; wait.set(k, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: k, method, params })); });
  const ev = async (js) => {
    const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  };
  for (let i = 0; i < 80; i++) { if (await ev('!!(window.A && A.state && A.state.config && A.pages.home && A.launch)')) break; await sleep(500); }
  await calm(ev);
  await ev(FIX_SEED); // 主页的世界不跟着日期变（cdp.js）
  const stop = async () => { try { ws.close(); } catch { /* ignore */ } child.kill(); await waitExit(child, 10000); };
  return { ev, send, stop, root, data, game };
}

const clearToasts = "document.querySelectorAll('.toast').forEach((t) => t.remove()); 1";
const closeModals = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); 1";

// 数真正发出来的声音：所有音效最后都要 createBufferSource 或 createOscillator
const SOUND_SPY = "(() => { if (!window.__snd) { window.__snd = { n: 0 }; for (const m of ['createBufferSource', 'createOscillator']) { const o = BaseAudioContext.prototype[m]; BaseAudioContext.prototype[m] = function (...a) { window.__snd.n++; return o.apply(this, a); }; } } return 1; })()";

const SCENARIOS = {
  /** 游戏运行时主页背景暂停，打斗的受击、死亡声音都不响（2.0.0-pre4） */
  async 'game-pause'(c) {
    await c.ev(`${closeModals}; ${clearToasts}; A.go('home'); 1`);
    await c.ev(SOUND_SPY);
    await calm(c.ev);
    const running = () => c.ev('!!(A.homeScene() && A.homeScene().running)');
    // aurora.friendly 是启动器自己合成的声音，假配置没有游戏资源时也能真的发声；entity.zombie.hurt 是打斗走的入口，这里用它的 alt
    const hit = async () => { const n0 = await c.ev('window.__snd.n'); await c.ev("A.gameSound.play('entity.zombie.hurt', { alt: 'aurora.friendly', volume: 1 }).then(() => 1)"); await sleep(80); return (await c.ev('window.__snd.n')) - n0; }; // pitfall-ok：声音是异步放出来的，等一小会儿再数响了几下
    check('pause', '确认场景成立：平时背景在动', await running());
    check('pause', '确认场景成立：平时受击声音发得出来', (await hit()) > 0);
    await c.ev("A.state.games.set('gp', { id: 'gp', versionId: 'ModP', state: 'running', startedAt: Date.now(), java: {}, memory: {} }); A.emit('games'); 1");
    await sleep(300); // pitfall-ok：要在 1 秒之内看（测的就是「不到 1 秒还没停」）
    check('pause', '游戏刚开始：不到 1 秒，背景还没停', await running());
    check('pause', '游戏刚开始：声音马上就没了', (await hit()) === 0);
    await until(c.ev, '!(A.homeScene() && A.homeScene().running)', 4000);
    check('pause', '1 秒后背景暂停', !(await running()));
    check('pause', '暂停时打斗的受击声音不响', (await hit()) === 0);
    await c.ev("A.go('versions'); 1"); await calm(c.ev);
    await c.ev("A.go('home'); 1"); await calm(c.ev);
    check('pause', '切到别的页面再回来：还是暂停着', !(await running()));
    await c.ev("A.emit('a11y'); A.setConfig({ background: { ...A.state.config.background, fps: 20 } }); 1"); await calm(c.ev);
    check('pause', '背景重建以后：还是暂停着', !(await running()));
    await c.ev("A.state.games.get('gp').state = 'exited'; A.emit('games'); 1");
    await until(c.ev, '!!(A.homeScene() && A.homeScene().running)', 3000);
    check('pause', '游戏退出：背景马上接着动', await running());
    check('pause', '游戏退出：声音恢复', (await hit()) > 0);
    await c.ev("A.state.games.delete('gp'); A.emit('games'); 1");
    // 不到 1 秒就退出了：不应该停
    await c.ev("A.state.games.set('gq', { id: 'gq', versionId: 'ModP', state: 'running', startedAt: Date.now(), java: {}, memory: {} }); A.emit('games'); 1");
    await sleep(300); // pitfall-ok：测的就是「不到 1 秒游戏就没了」
    await c.ev("A.state.games.delete('gq'); A.emit('games'); 1");
    await sleep(1200); // pitfall-ok：要等过 1 秒的门槛，才知道背景确实没停
    check('pause', '不到 1 秒游戏就没了：背景一直在动', await running());
    // 启动失败：任务结束后恢复
    await c.ev("A.api('accounts:addOffline', 'PausePlayer').then(() => A.refreshAccounts())");
    await c.ev(clearToasts);
    await useFakeJava(c);
    await c.ev("A.launch('ModP'); 1");
    // 启动要先找 Java，失败可能要等一会儿：等任务结束，等不到就取消，看的是任务结束之后恢复没有
    for (let i = 0; i < 240 && !(await c.ev("!!document.querySelector('.toast.crit') || ![...A.state.tasks.values()].some((t) => t.status === 'running')")); i++) await sleep(250);
    await c.ev("Promise.all([...A.state.tasks.values()].filter((t) => t.status === 'running').map((t) => A.api('tasks:cancel', t.id))).then(() => 1)");
    for (let i = 0; i < 40 && (await c.ev("[...A.state.tasks.values()].some((t) => t.status === 'running')")); i++) await sleep(250);
    await until(c.ev, '!!(A.homeScene() && A.homeScene().running)', 5000);
    const afterFail = { running: await running(), hit: await hit(), toast: await c.ev("[...document.querySelectorAll('.toast.crit')].map((x) => x.innerText.slice(0, 40)).join('|')"), tasks: await c.ev("[...A.state.tasks.values()].filter((t) => t.kind === 'launch').map((t) => t.status).join(',')"), games: await c.ev('A.state.games.size') };
    check('pause', '启动失败以后：背景在动，声音能响', afterFail.running && afterFail.hit > 0, afterFail);
    await c.ev(clearToasts);
    await c.ev("A.setConfig({ background: { ...A.state.config.background, fps: 30 } }); 1");
  },

  /** 点地下的水（积水洞、地下湖、裂谷底）、洞穴瀑布：是水的声音，不是后面石头的声音（2.0.0-pre4） */
  async 'cave-water-click'(c) {
    await c.ev(`${closeModals}; ${clearToasts}; A.go('home'); 1`);
    await calm(c.ev);
    const r = await c.ev(`(() => {
      const s = A.homeScene();
      s.opts = { ...s.opts, scene: 'plains', time: 'day' };
      s.build();
      const B = s.B;
      const heard = [];
      const orig = A.gameSound.play;
      A.gameSound.play = (ev, o) => { heard.push(ev); return Promise.resolve(null); };
      const click = (cc, rr) => { heard.length = 0; const before = s.parts.length; const ok = s.clickEnv((cc + 0.5) * B, (rr + 0.5) * B, performance.now()); return { ev: heard[0] || null, ok, parts: s.parts.length - before }; };
      const out = { surf: null, deepStone: null, deepSlate: null, wall: null, fall: null, fallBelow: null, sea: null, found: {} };
      for (let cc = -1500; cc < 1500; cc++) {
        const top = s.colHeight(cc);
        if (top > 900) continue;
        let surface = null;
        for (let rr = top + 5; rr < s.BOT; rr++) {
          const x = s.cellAtWorld(cc, rr);
          if (!x) continue;
          if (x.cwater && surface == null) surface = rr;
          if (!x.cwater) surface = null;
          if (x.cwater && x.surf && !out.surf) { out.surf = click(cc, rr); out.found.surf = x.mat === A.sceneKit.M.deepslate ? 'deepslate' : 'stone'; }
          if (x.cwater && surface != null && rr - surface > 3) {
            if (x.mat === A.sceneKit.M.deepslate && !out.deepSlate) out.deepSlate = click(cc, rr);
            if (x.mat === A.sceneKit.M.stone && !out.deepStone) out.deepStone = click(cc, rr);
          }
          if (x.fx === 'fall') {
            if (!out.fall) out.fall = click(cc, rr);
            if (!out.fallBelow && !s.rawSolid(cc, rr + 1, null) && !s.rawSolid(cc, rr + 2, null) && !s.caveWaterAt(cc, rr + 2) && !s.fluidAt(cc, rr + 2)) out.fallBelow = click(cc, rr + 2); // 世界每天不一样：落进岩浆池的那种不算（rc3 那天点到了岩浆）
          }
          if (x.cave && !x.cwater && !x.fx && !x.deco && !x.lava && x.mat === A.sceneKit.M.stone && !out.wall && !s.rawSolid(cc, rr, null) && !s.fluidAt(cc, rr)) {
            let under = false;
            for (let u = 1; u < 48; u++) { const y = s.cellAtWorld(cc, rr - u); if (y && y.fx === 'fall') under = true; if (s.rawSolid(cc, rr - u, null)) break; }
            if (!under) out.wall = click(cc, rr);
          }
        }
        if (out.surf && out.deepSlate && out.deepStone && out.fall && out.fallBelow && out.wall) break;
      }
      s.opts = { ...s.opts, scene: 'ocean', time: 'day' };
      s.build();
      for (let cc = 0; cc < 300 && !out.sea; cc++) { if (s.sea < 900 && s.sea + 1 < s.colHeight(cc)) out.sea = click(cc, s.sea + 1); }
      A.gameSound.play = orig;
      s.opts = { ...s.opts, scene: 'plains' };
      s.build();
      return out;
    })()`);
    if (r && r.__err) { check('water', '脚本出错', false, r.__err); return; }
    console.log(`  ${JSON.stringify(r).slice(0, 420)}`);
    const water = (x) => !!x && /splash|bubble/.test(String(x.ev)) && x.parts > 0;
    check('water', '水面：溅水声，有水花', water(r.surf), r.surf);
    check('water', '石头前面的水：水声，不是石头声', water(r.deepStone), r.deepStone);
    check('water', '深层板岩前面的水：水声，不是深层板岩声', water(r.deepSlate), r.deepSlate);
    check('water', '洞穴瀑布：水声', water(r.fall), r.fall);
    check('water', '瀑布往下落的那一段：也是水声', water(r.fallBelow), r.fallBelow);
    check('water', '旁边没有水的洞壁：还是石头声', !!r.wall && /stone/.test(String(r.wall.ev)), r.wall);
    check('water', '海里：还是水声', water(r.sea), r.sea);
  },

  /** 9-5 玩家起的名字不翻译；9-4 远程控制软件那句；1-9 任务行不重复写（英文界面，2.0.0-pre5） */
  async 'tr-names'() {
    const en = await startApp('en-names', { language: 'en', setup: (game) => { fakeVersion(game, '设置'); fakeVersion(game, '账户'); } });
    try {
      await en.ev("A.api('accounts:addOffline', 'PlayerX').then(() => A.refreshAccounts())");
      const tr = (s) => en.ev(`window.I18N_TRANSLATE.tr(${JSON.stringify(s)})`);
      const marked = (src, name) => en.ev(`window.I18N_TRANSLATE.tr(${JSON.stringify(src)}.split('@').join(window.I18N.nm(${JSON.stringify(name)})))`);
      const has = async (label, src, name, also) => {
        const got = await marked(src, name);
        check('9-5', `${label}：名字不翻`, got.includes(name) && !/\bSettings\b|\bAccounts?\b/.test(got), got);
        if (also) check('9-5', `${label}：其他部分翻了`, also.test(got), got);
      };
      await has('任务标题', '启动 @', '设置', /Launch|Start/i);
      await has('通知里的名字', '「@」的游戏正在运行，先关掉游戏再删除', '设置', /running|close/i);
      await has('列表里的名字', '已安装 @、@', '设置', /Installed/i);
      check('9-5', '没人起这个名字的词照常翻', /Java/.test(await tr('安装 Java')) && /Install/.test(await tr('安装 Java')), await tr('安装 Java'));
      // 真实界面：配置卡片上的名字；侧边栏的「设置」还是要翻
      await en.ev("A.go('versions'); 1");
      await calm(en.ev);
      const r = await en.ev("(() => { const page = document.getElementById('page-versions').innerText; const nav = [...document.querySelectorAll('.nav-item')].map((x) => x.innerText.trim()); return { cardZh: page.includes('设置'), cardZh2: page.includes('账户'), nav }; })()");
      check('9-5', '配置页：配置叫「设置」「账户」，卡片上还是这两个词', r.cardZh && r.cardZh2, r);
      check('9-5', '侧边栏：导航照常是英文', r.nav.some((x) => /Settings/.test(x)) && !r.nav.some((x) => /设置|账户/.test(x)), r.nav);
      // 9-4
      for (const [src, want] of [['正在运行远程控制软件：UU 远程、ToDesk', 'Running remote control software'], ['装了远程控制软件：UU 远程、ToDesk', 'emote control software']]) {
        const got = await tr(src);
        check('9-4', `${src.slice(0, 8)}：句子通顺`, got.includes(want) && !/Runningremote|Installedremote/i.test(got), got);
      }
      // 1-9 同样的文字不重复写
      const m = await en.ev(`(async () => {
        A.state.tasks.set('w1', { id: 'w1', kind: 'install', status: 'running', title: '安装 测试', detail: '下载文件 1/2', progress: 0.5, meta: {}, files: { done: 1, total: 2, active: 1, failed: 0 }, bytes: { done: 1, total: 2 }, current: [], failures: [], speed: 1000, eta: 3, createdAt: Date.now() });
        const box = document.createElement('div');
        document.body.appendChild(box);
        const mgr = A.tasks.mountManager(box, { group: 'download' });
        mgr.render();
        await new Promise((res) => setTimeout(res, 300));
        let writes = 0;
        const ob = new MutationObserver((l) => { writes += l.length; });
        ob.observe(box, { subtree: true, childList: true, characterData: true });
        for (let i = 0; i < 20; i++) { mgr.render(); await new Promise((res) => setTimeout(res, 30)); }
        await new Promise((res) => setTimeout(res, 200));
        ob.disconnect();
        const text = box.innerText.replace(/\\s+/g, ' ').slice(0, 80);
        box.remove(); mgr.destroy(); A.state.tasks.delete('w1');
        return { writes, text };
      })()`);
      check('1-9', '英文界面：内容没变的任务行不重复写', m.writes <= 2, m);
      check('1-9', '英文界面：任务行是英文', !/[\u4e00-\u9fff]/.test(String(m.text).replace(/测试/g, '')), m.text);
    } finally { await en.stop(); }
  },

  /**
   * 名字矩阵（2.0.0-pre6）：所有玩家起的、来自内容的名字，用常见字典词和各种写法，
   * 英文界面把页面、弹窗、提示走一遍：名字原样，界面文字没漏翻。结果写明每种名字在哪里被翻了。
   */
  async 'tr-matrix'() {
    // 名字的写法：整段是字典词、含字典词、带翻译器的分隔符（文件夹名不能有 : 和换行，那两种放显示名和方案名）
    const WORDS = ['设置', '启动', '下载'];
    const FORMS = ['设置', '启动', '下载', '我的设置', '设置 · 下载', '设置，下载', '设置+下载', '设置。下载', '设置；下载', '设置、下载', '启动 下载'];
    const FREE = ['设置：下载', '设置\n下载'];
    const en = await startApp('en-matrix', {
      language: 'en',
      setup: (game) => {
        FORMS.forEach((n) => fakeVersion(game, n));
        fakeVersion(game, 'DispA');
        fs.writeFileSync(path.join(game, 'versions', 'DispA', 'aurora-profile.json'), JSON.stringify({ name: FREE[0], type: 'custom' }));
        fakeVersion(game, 'DispB');
        fs.writeFileSync(path.join(game, 'versions', 'DispB', 'aurora-profile.json'), JSON.stringify({ name: FREE[1], type: 'custom' }));
        const d = path.join(game, 'versions', '设置');
        fs.mkdirSync(path.join(d, 'mods'), { recursive: true });
        for (const n of ['下载.jar', '启动 · 设置.jar']) fs.writeFileSync(path.join(d, 'mods', n), 'x');
        for (const [sub, n] of [['resourcepacks', '设置.zip'], ['shaderpacks', '下载.zip']]) { fs.mkdirSync(path.join(d, sub), { recursive: true }); fs.writeFileSync(path.join(d, sub, n), 'x'); }
        for (const w of ['启动', '设置，下载']) { fs.mkdirSync(path.join(d, 'saves', w), { recursive: true }); fs.writeFileSync(path.join(d, 'saves', w, 'level.dat'), 'x'); }
      },
    });
    const problems = {};
    const note = (where, kind, detail) => { (problems[where] = problems[where] || []).push(`${kind}：${detail}`); };
    try {
      await en.ev(closeModals);
      await en.ev("A.api('planner:save', { id: 'pm1', name: '设置', mc: '1.20.1', loader: 'fabric', styles: [], items: [] }).then(() => 1, () => 0)");
      await en.ev("A.api('planner:save', { id: 'pm2', name: '设置，下载', mc: '1.20.1', loader: 'fabric', styles: [], items: [] }).then(() => 1, () => 0)");
      await en.ev("A.api('skins:libraryGroup', { op: 'add', name: '启动' }).then(() => 1, () => 0)");
      await en.ev("A.refreshInstalled().then(() => A.setConfig({ selectedVersion: '设置' })).then(() => 1)");
      await calm(en.ev);
      // 一段文字里的中文：一定要落在某个名字里面，否则就是漏翻
      const NAMES = [...new Set([...FORMS, ...FREE, ...WORDS, '下载.jar', '启动 · 设置.jar', '设置.zip', '下载.zip'])];
      const collect = `(() => {
        const texts = [];
        const add = (t) => { if (t && /[\\u4e00-\\u9fff]/.test(t)) texts.push(t.replace(/[\\u2068\\u2069]/g, '')); };
        const roots = [...document.querySelectorAll('.page.active, .modal-back:not(.closing), .toast, .menu, .popover, nav, .sidebar')];
        for (const r of roots) {
          const tw = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
          for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.parentElement && n.parentElement.closest('script,style')) continue; add(n.nodeValue); }
          for (const el of [r, ...r.querySelectorAll('[title],[aria-label],[placeholder],[data-tip],[alt]')]) for (const a of ['title', 'aria-label', 'placeholder', 'data-tip', 'alt']) if (el.getAttribute && el.getAttribute(a)) add(el.getAttribute(a));
        }
        return texts;
      })()`;
      const stripNames = (t) => { let o = t; for (const n of [...NAMES].sort((a, b) => b.length - a.length)) o = o.split(n).join(''); return o; };
      const leftover = (texts) => [...new Set(texts.map(stripNames).filter((t) => /[\u4e00-\u9fff]/.test(t)).map((t) => t.trim().slice(0, 40)))];
      const body = () => en.ev("(() => [...document.querySelectorAll('.page.active, .modal-back:not(.closing), .toast, .menu, .popover')].map((x) => x.innerText).join('\\n'))()");
      // 列表是异步读出来的，机器忙时 0.9 秒还没画完（rc1 之后的界面回归碰到过 Mod 页）：最多等 4 秒再判断
      const expectNames = async (where, names) => {
        let b = await body();
        for (let i = 0; i < 16 && names.some((n) => !b.includes(n)); i++) { await sleep(250); b = await body(); }
        for (const n of names) if (!b.includes(n)) note(where, '名字被翻或没显示', n.replace(/\n/g, '\\n'));
      };
      const checkLeft = async (where) => { const l = leftover(await en.ev(collect)); if (l.length) note(where, '界面漏翻', l.slice(0, 6).join(' | ')); };

      // ── 页面 ──
      for (const [page, names] of [['versions', FORMS], ['home', []], ['mods', []], ['planner', []], ['repair', []], ['tasks', []], ['java', []], ['accounts', []], ['skins', []], ['settings', []]]) {
        await en.ev(`A.go(${JSON.stringify(page)}); 1`);
        await calm(en.ev);
        if (names.length) await until(en.ev, `(() => { const t = document.querySelector('.page.active').innerText; return ${JSON.stringify(names)}.some((n) => t.includes(n)); })()`, 10000);
        await expectNames(`页面 ${page}`, names);
        await checkLeft(`页面 ${page}`);
      }
      // 显示名（可以有冒号和换行）
      await en.ev("A.go('versions'); 1"); await calm(en.ev);
      const page = await body();
      if (!page.includes('设置：下载') && !page.includes('设置: 下载')) note('页面 versions', '显示名被翻', '设置：下载');
      // 下拉、菜单：Mod 页的配置选择
      await en.ev("A.go('mods'); 1"); await calm(en.ev);
      await expectNames('Mod 页', ['下载.jar', '启动 · 设置.jar']);
      await checkLeft('Mod 页');
      const trig = await en.ev("(() => { const b = [...document.querySelectorAll('#page-mods button')].find((x) => /设置|Settings/.test(x.innerText)); if (b) { const t = b.innerText; b.click(); return t; } return null; })()");
      await calm(en.ev);
      if (trig != null && !/设置/.test(trig)) note('Mod 页按钮', '名字被翻', trig.slice(0, 40));
      await expectNames('Mod 页下拉', ['设置', '启动', '我的设置', '设置，下载']);
      await en.ev("document.querySelectorAll('.menu').forEach((m) => m.remove()); 1");
      // 主页：底部当前配置
      await en.ev("A.go('home'); 1"); await calm(en.ev);
      const home = await en.ev("document.getElementById('page-home').innerText");
      if (!home.includes('设置')) note('主页底部', '名字被翻', '设置');
      // 弹窗标题和句子：删除确认、重命名、详情
      for (const name of ['设置', '设置，下载', '启动 下载']) {
        await en.ev(`${closeModals}; ${clearToasts}; A.go('versions'); 1`); await calm(en.ev);
        const clicked = await en.ev(`(() => { const c = A.confirm(${JSON.stringify(`确定要删除「${name}」吗？`)}, { title: ${JSON.stringify(name)}, okText: '删除' }); return 1; })()`);
        void clicked;
      }
      await en.ev(closeModals);
      // 提示和任务列表：真实的失败路径，句子里带名字
      for (const name of ['设置', '设置，下载', '设置 · 下载', '启动 下载']) {
        await en.ev(`${clearToasts}; A.api('versions:complete', ${JSON.stringify(name)}).then(() => 1, () => 0)`);
        await until(en.ev, "!!document.querySelector('.toast')", 6000);
        const t = await en.ev("[...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' | ')");
        if (!t.includes(name)) note('提示：补全失败', '名字被翻', `${name} → ${t.replace(/\s+/g, ' ').slice(0, 70)}`);
        await checkLeft(`提示：补全失败（${name}）`);
      }
      // 下载管理器里的任务行（补全任务的分组是 download）
      const tt = await en.ev(`(async () => {
        const box = document.createElement('div'); document.body.appendChild(box);
        const mgr = A.tasks.mountManager(box, { group: 'download' }); mgr.render();
        await new Promise((res) => setTimeout(res, 300));
        const text = box.innerText; box.remove(); mgr.destroy(); return text;
      })()`);
      for (const name of ['设置', '设置，下载', '设置 · 下载']) if (!tt.includes(name)) note('任务列表', '名字被翻', name);
      await en.ev(`${clearToasts}; A.api('versions:rename', '设置', 'a;b').then(() => 1, () => 0); 1`);
      // 主进程的错误句子
      const msg = await en.ev("A.api('backup:create', '设置，下载', { type: 'saves' }).then(() => 'ok', (e) => e.message)");
      void msg;
      // 悬停提示：data-tip 翻好以后还要显示一次，不能再翻一遍
      const tip = await en.ev(`(async () => {
        const b = A.h('button', { 'data-tip': window.I18N.nm('设置，下载') + ' · ' + window.I18N.nm('启动') }, 'x');
        document.body.appendChild(b);
        await new Promise((res) => setTimeout(res, 100));
        b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 900));
        const el = document.querySelector('.tooltip');
        const text = el ? el.innerText : '';
        b.remove(); if (el) el.remove();
        return text;
      })()`);
      if (!tip.includes('设置，下载') || !tip.includes('启动')) note('悬停提示', '名字被翻', String(tip).slice(0, 60));
      // 界面文字不能受影响：配置叫「设置」「启动」「下载」，导航还是英文
      const nav = await en.ev("[...document.querySelectorAll('.nav-item')].map((x) => x.innerText.trim())");
      const navBad = nav.filter((x) => /[\u4e00-\u9fff]/.test(x));
      check('name-matrix', '配置叫「设置」「启动」「下载」：导航全是英文', navBad.length === 0 && nav.some((x) => /Settings/.test(x)), navBad);
      // 改名、删除之后：旧名字不再影响界面文字
      await en.ev(`${closeModals}; ${clearToasts}; A.api('versions:rename', '下载', 'Renamed').then(() => A.refreshInstalled()).then(() => 1, (e) => e.message)`);
      await calm(en.ev);
      const after = await en.ev("window.I18N_TRANSLATE.tr('下载')");
      check('name-matrix', '改名以后：「下载」这个界面文字照常翻', !/[\u4e00-\u9fff]/.test(after), after);
      const words = Object.keys(problems);
      for (const w of words) console.log(`  ${w}：${problems[w].slice(0, 5).join('；').slice(0, 260)}`);
      const kinds = (re) => words.filter((w) => problems[w].some((x) => re.test(x)));
      check('name-matrix', '所有页面、下拉、弹窗、提示、任务列表：名字原样', kinds(/名字被翻|显示名被翻|没显示/).length === 0, kinds(/名字被翻|显示名被翻|没显示/));
      check('name-matrix', '所有页面、弹窗、提示：界面文字没漏翻', kinds(/界面漏翻/).length === 0, kinds(/界面漏翻/));
    } finally { await en.stop(); }
    // 句子层面：每种写法进每种模板
    const en2 = await startApp('en-matrix2', { language: 'en' });
    try {
      const nm = (n) => `(window.I18N && window.I18N.nm ? window.I18N.nm(${JSON.stringify(n)}) : ${JSON.stringify(n)})`;
      const bad = [];
      for (const name of [...FORMS, ...FREE]) {
        for (const [tpl, re] of [['启动 @', /Launch|Start/], ['「@」的游戏正在运行，先关掉游戏再删除', /running/], ['安装 @ 失败', /Install|fail/i], ['已安装 @、@', /Installed/]]) {
          const out = await en2.ev(`window.I18N_TRANSLATE.tr(${JSON.stringify(tpl).replace(/@/g, '" + NM + "').replace(/^/, `(() => { const NM = ${nm(name)}; return `).replace(/$/, '; })()')})`);
          if (!String(out).includes(name) || !re.test(out)) bad.push(`${tpl} × ${name.replace(/\n/g, '\\n')} → ${String(out).replace(/\n/g, '\\n').slice(0, 50)}`);
        }
      }
      if (bad.length) console.log(`  句子：${bad.slice(0, 6).join('；')}`);
      check('name-matrix', `每种写法进每种句子（${(FORMS.length + FREE.length) * 4} 种）：名字原样，其他部分翻了`, bad.length === 0, `${bad.length} 种不对`);
      const ui = await en2.ev("['设置', '启动', '下载', '下载完成', '打开设置'].map((s) => window.I18N_TRANSLATE.tr(s))");
      check('name-matrix', '没加标记的界面文字照常翻', ui.slice(0, 3).every((x) => !/[\u4e00-\u9fff]/.test(x)), ui);
    } finally { await en2.stop(); }
  },

  /**
   * 名字爬遍界面（2.0.0-pre6）：名字都用「翻译很特别、界面上本来不会出现」的字典词，英文界面自动点遍每页的按钮、菜单和弹窗，
   * 每一步查所有文字和 title、aria-label、placeholder、data-tip、alt：① 不出现名字的译文 ② 没有留下标记 ③ 除了名字没有中文。
   * 打开文件夹、文件选择框这些外部动作由 safe-hook 拦掉，回收站是测试目录。
   */
  async 'tr-crawl'() {
    const W = { p1: '社交屏幕', p2: '鼠标中键', p3: '与副手交换', p4: '保存的快捷栏', world: '按键设置搜索', mod: '丢弃物品', pack: '未识别显卡', shader: '名称太长了', plan: '你拒绝了授权', skin: '刷新登录失败', group: '回收站不可用', acc: '无法应用修改', srv: '请输入角色名', mfile: '文件校验失败', disp: '没能检查硬件' };
    const PROFILES = [W.p1, `${W.p2} · ${W.p3}`, `${W.p3}，${W.p4}`, `${W.p4}+${W.p2}`, `${W.p1} ${W.p3}`];
    const NAMES = [...new Set(['UU 远程', '向日葵', '网易', 'MC百科', ...Object.values(W), ...PROFILES, `${W.disp}：${W.p1}`, `${W.mod}.jar`, `${W.mfile}.jar`, `${W.pack}.zip`, `${W.shader}.zip`])];
    const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png); png.writeUInt32BE(64, 16); png.writeUInt32BE(64, 20);
    const en = await startApp('en-crawl', {
      language: 'en', safe: true,
      setup: (game) => {
        PROFILES.forEach((n) => fakeVersion(game, n));
        fakeVersion(game, 'DispC');
        fs.writeFileSync(path.join(game, 'versions', 'DispC', 'aurora-profile.json'), JSON.stringify({ name: `${W.disp}：${W.p1}`, type: 'custom' }));
        const d = path.join(game, 'versions', W.p1);
        for (const n of [`${W.mod}.jar`, `${W.mfile}.jar`]) fs.writeFileSync(path.join(d, 'mods', n), 'x');
        for (const [sub, n] of [['resourcepacks', `${W.pack}.zip`], ['shaderpacks', `${W.shader}.zip`]]) { fs.mkdirSync(path.join(d, sub), { recursive: true }); fs.writeFileSync(path.join(d, sub, n), 'x'); }
        fs.mkdirSync(path.join(d, 'saves', W.world), { recursive: true }); fs.writeFileSync(path.join(d, 'saves', W.world, 'level.dat'), 'x');
        fs.writeFileSync(path.join(path.dirname(game), 'data', 'accounts.json'), JSON.stringify({ selected: 'ygg1', accounts: [{ id: 'ygg1', type: 'yggdrasil', name: W.acc, uuid: '00000000000000000000000000000001', server: { name: W.srv, root: 'http://127.0.0.1:9/', homepage: 'http://127.0.0.1:9/' }, addedAt: 1 }] }));
      },
    });
    try {
      await en.ev(closeModals);
      await en.ev(`A.api('planner:save', { id: 'pc1', name: ${JSON.stringify(W.plan)}, mc: '1.20.1', loader: 'fabric', styles: [], items: [] }).then(() => 1, () => 0)`);
      await en.ev(`A.api('skins:libraryAdd', { png: ${JSON.stringify(png.toString('base64'))}, model: 'classic', name: ${JSON.stringify(W.skin)}, group: ${JSON.stringify(W.group)} }).then(() => 1, (e) => e.message)`);
      await en.ev(`A.api('skins:libraryGroup', { op: 'add', name: ${JSON.stringify(W.group)} }).then(() => 1, () => 0)`);
      await en.ev(`A.api('backup:create', ${JSON.stringify(W.p1)}, { type: 'saves' }).then(() => 1, () => 0)`);
      await en.ev(`A.refreshInstalled().then(() => A.setConfig({ selectedVersion: ${JSON.stringify(W.p1)} })).then(() => 1)`);
      await calm(en.ev);
      const pages = await en.ev('Object.keys(A.pages)');
      const budget = Number(process.env.AURORA_CRAWL_MS || 25000);
      const script = `(() => {
        const NAMES = ${JSON.stringify([...NAMES].sort((a, b) => b.length - a.length))};
        const WORDS = ${JSON.stringify(Object.values(W))};
        const TR = {}; for (const w of WORDS) TR[w] = window.I18N_TRANSLATE.tr(w);
        const BAD = Object.values(TR).filter((x) => !/[\\u4e00-\\u9fff]/.test(x)).map((x) => x.toLowerCase());
        const F = window.__found = { marker: {}, translated: {}, leftover: {}, clicks: 0, words: Object.keys(TR).length, bad: BAD.length, names: {} };
        const CJK = /[\\u4e00-\\u9fff]/;
        const add = (k, where, t) => { const key = t.replace(/\\s+/g, ' ').slice(0, 900); if (!F[k][key]) F[k][key] = where; };
        const strip = (t) => { let o = t; for (const n of NAMES) o = o.split(n).join(''); return o; };
        const look = (t, where) => {
          if (!t) return;
          if (/[\\u2068\\u2069]/.test(t)) add('marker', where, t);
          const low = t.toLowerCase();
          if (BAD.some((b) => low.includes(b))) add('translated', where, t);
          for (const n of NAMES) if (t.includes(n)) F.names[n] = (F.names[n] || 0) + 1;
          if (CJK.test(strip(t))) add('leftover', where, strip(t));
        };
        const ATTRS = ['title', 'aria-label', 'aria-description', 'placeholder', 'data-tip', 'alt'];
        const scan = (where) => {
          const skip = (el) => !el || el.closest('script, style, canvas, .page:not(.active), [data-no-tr], textarea, .nav-rail-x');
          const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!skip(n.parentElement)) look(n.nodeValue, where + ' <' + (n.parentElement.className || n.parentElement.tagName) + '> ' + ((n.parentElement.parentElement || {}).className || ''));
          for (const el of document.body.querySelectorAll('*')) {
            if (el.closest('script, style, .page:not(.active)')) continue;
            for (const a of ATTRS) { const v = el.getAttribute(a); if (v && !el.closest('[data-no-tr]')) look(v, where + ' @' + a); }
            if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && /[\\u2068\\u2069]/.test(el.value)) add('marker', where + ' @value', el.value);
          }
          if (/[\\u2068\\u2069]/.test(document.title)) add('marker', where + ' @title', document.title);
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const settled = async (min, max) => { const t = Date.now(); let sig = ''; let same = 0; for (;;) { await sleep(150); const r = document.querySelector('.page.active') || document.body; const s = r.querySelectorAll('*').length + ':' + r.innerText.length; same = s === sig ? same + 1 : 0; sig = s; const gone = Date.now() - t; if ((gone >= min && same >= 3 && !r.querySelector('.spinner')) || gone >= max) return; } }; // pitfall-ok：轮询里两次查看之间的间隔
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('data-tip') || el.getAttribute('title') || el.innerText || el.className || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 36);
        const cleanup =() => { document.querySelectorAll('.modal-back, .toast, .menu, .popover').forEach((m) => m.remove()); try { A.closePopover(); A.closeDrawers(); } catch { /* 没开着 */ } };
        let allowPrimary = false;
        const danger = (el) => (allowPrimary ? /(^|\\s)danger(\\s|$)/ : /(^|\\s)(danger|primary)(\\s|$)/).test(el.className || '');
        window.__allowPrimary = (v) => { allowPrimary = v; return v; };
        const sels = '.page.active button, .page.active [role="button"], .page.active [tabindex="0"], .page.active .clickable, .page.active .chip, .page.active .tab, .page.active .sugg, .page.active .vchip, .page.active .sc-card';
        const skipEl = (el) => { const row = el.closest('.set-row'); if (row && /language|首次启动/i.test(row.innerText)) return true; return /(download|install).*java|java.*(download|install)/i.test(labelOf(el)); }; // Java 真的会下载几十 MB，不点
        window.__crawl = async (page, budget) => {
          const t0 = Date.now(); const done = new Set();
          // 至少等以前那么久，然后等到这一页不再变、没有转圈（最多 15 秒）。以前 Mod 页固定等 2 秒，
          // 机器忙的时候 Mod 列表还没出来就开始扫，「Mod 文件」的名字一次都没见到（rc11 第二遍关卡碰到）
          A.go(page); await settled(page === 'mods' ? 2000 : 900, 15000);
          // Mod 列表是一个一个文件读出来的，中间可能停一下又接着画（rc13 关卡又碰到一次没扫到）：等到真的有 .jar 的名字，最多再等 10 秒
          const t1 = Date.now();
          while (page === 'mods' && Date.now() - t1 < 10000 && !/\\.jar\\b/.test((document.querySelector('#page-mods') || document.body).innerText)) await sleep(150);
          scan(page);
          while (Date.now() - t0 < budget) {
            if (A.state.page !== page) { cleanup(); A.go(page); await settled(300, 5000); }
            const el = [...document.querySelectorAll(sels)].filter(vis).find((x) => !done.has(labelOf(x)) && !x.disabled && !skipEl(x));
            if (!el) break;
            const lab = labelOf(el); done.add(lab);
            const where = page + ' > ' + lab;
            try { el.click(); } catch { continue; }
            F.clicks++;
            await settled(200, 3000);
            scan(where);
            const subs = [...document.querySelectorAll('.menu .menu-item, .modal-back:last-of-type .tab, .modal-back:last-of-type .seg button, .modal-back:last-of-type button, .drawer button')].filter(vis).filter((x) => !x.disabled && (x.classList.contains('menu-item') || !danger(x))).slice(0, 14);
            for (let i = 0; i < subs.length && Date.now() - t0 < budget; i++) {
              const cur = [...document.querySelectorAll('.menu .menu-item, .modal-back:last-of-type .tab, .modal-back:last-of-type .seg button, .modal-back:last-of-type button, .drawer button')].filter(vis).filter((x) => !x.disabled && (x.classList.contains('menu-item') || !danger(x)))[i];
              if (!cur) break;
              const sub = labelOf(cur);
              if (/close|cancel|back$|^x$/i.test(sub)) continue;
              try { cur.click(); } catch { continue; }
              F.clicks++;
              await settled(200, 3000);
              scan(where + ' > ' + sub);
              if (A.state.page !== page) { cleanup(); A.go(page); await settled(300, 5000); break; }
              if (!document.querySelector('.menu, .modal-back, .drawer')) { break; }
            }
            cleanup();
          }
          return { page, labels: done.size, ms: Date.now() - t0 };
        };
        window.__scan = (where) => { scan(where); return F.names; };
        // 直接打开的入口：点卡片走不到的弹窗。里面的按钮再点一层
        window.__open = async (where, fn) => {
          cleanup();
          try { const p = fn(); if (p && p.catch) p.catch(() => {}); } catch (e) { return String(e.message || e); }
          await settled(600, 8000);
          scan(where);
          const list = () => [...document.querySelectorAll('.menu .menu-item, .modal-back:last-of-type .tab, .modal-back:last-of-type .seg button, .modal-back:last-of-type button, .modal-back:last-of-type [tabindex="0"], .drawer button')].filter(vis).filter((x) => !x.disabled && (x.classList.contains('menu-item') || !danger(x)));
          const done = new Set();
          for (let i = 0; i < 14; i++) {
            const cur = list().find((x) => !done.has(labelOf(x)));
            if (!cur) break;
            const sub = labelOf(cur); done.add(sub);
            if (/close|cancel|back$|^x$/i.test(sub)) continue;
            try { cur.click(); } catch { continue; }
            F.clicks++;
            await settled(200, 3000);
            scan(where + ' > ' + sub);
            if (!document.querySelector('.modal-back, .drawer')) break;
          }
          cleanup();
          return 'ok';
        };
        return BAD.length;
      })()`;
      const bad = await en.ev(script);
      check('name-crawl', '确认场景成立：名字用的都是字典词', bad === Object.keys(W).length, bad);
      for (const page of pages) {
        const r = await en.ev(`window.__crawl(${JSON.stringify(page)}, ${budget})`);
        console.log(`  爬 ${page}：${r && r.labels} 个按钮，${r && Math.round(r.ms / 1000)} 秒`);
      }
      // 机器忙的时候，Mod 页那一圈的时间用完了 Mod 列表还没读到那个文件（rc11、rc13、2.0.0 公开版走查各碰到一次）。
      // 不靠时间预算：没扫到就专门回 Mod 页，等到这个文件名真的出现（最多 30 秒）再扫一次；界面上真没有，照样报。
      // 直接打开放了这个文件的那个配置的 Mod 页（爬的时候下拉框可能点到了别的配置，Mod 页会一直显示那一个）
      const MOD = JSON.stringify(`${W.mod}.jar`);
      const re = await en.ev(`(async () => { if ((window.__found.names[${MOD}] || 0) > 0) return '一圈里就扫到了';
        document.querySelectorAll('.modal-back').forEach((m) => m.remove());
        A.go('mods', { versionId: ${JSON.stringify(W.p1)} }); const t = Date.now();
        while (Date.now() - t < 30000 && !(document.querySelector('#page-mods') || document.body).innerText.includes(${MOD})) await new Promise((r) => setTimeout(r, 200));
        window.__scan('mods（补扫）'); return (window.__found.names[${MOD}] || 0) > 0 ? '补扫到了' : '补扫也没有'; })()`);
      console.log(`  Mod 文件：${re}`);
      await en.ev("A.go('versions'); 1"); await calm(en.ev);
      const P1 = JSON.stringify(W.p1);
      const P2 = JSON.stringify(PROFILES[1]);
      const V = (id) => `A.state.installed.find((x) => x.id === ${id})`;
      for (const [where, js] of [
        ['存档和备份', `A.savesManager(${V(P1)})`],
        ['导出', 'A.migrateUi.exportDialog()'],
        ['换版本', `A.components.changeDialog(${V(P1)}, 'mc')`],
        ['换加载器', `A.components.changeDialog(${V(P1)}, 'loader')`],
        ['测试新版本', `A.iso.testNewVersion(${V(P1)})`],
        ['Mod 更新测试', `A.iso.modUpdateCopy(${V(P1)})`],
        ['转为正式配置', `A.iso.promote(${V(P1)})`],
        ['查看设置主档', `A.gameSyncUi.viewDialog(${V(P1)})`],
        ['改独立', `A.isoWorlds.switchToOwn(${V(P2)})`],
        ['确认里的名字', `A.confirm(\`确定要删除「\${A.nm(${P2})}」吗？\`, { title: A.nm(${P2}), okText: '删除' })`],
      ]) {
        const r = await en.ev(`window.__open(${JSON.stringify(where)}, () => ${js})`);
        if (r !== 'ok') console.log(`  打不开 ${where}：${String(r).slice(0, 80)}`);
      }
      const f = await en.ev('window.__found');
      // 标记泄漏：第二遍连主按钮也点（真的改名、保存、复制），标记不能进接口参数和文件
      // 先确认监听真的抓得到：故意传一个带标记的参数，然后清掉这条
      await en.ev("A.api('planner:list', window.I18N.nm('探针')).then(() => 1, () => 0)");
      await waitFor(() => { try { return fs.readFileSync(path.join(en.root, 'leak.log'), 'utf8').includes('planner:list'); } catch { return false; } }, 5000);
      const probeFile = path.join(en.root, 'leak.log');
      const probe = fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf8') : '';
      check('name-crawl', '确认场景成立：带标记的接口参数监听得到', probe.includes('planner:list'), probe.slice(0, 80));
      fs.writeFileSync(probeFile, '');
      await en.ev('window.__allowPrimary(true)');
      for (const page of ['versions', 'skins', 'planner', 'accounts', 'mods']) {
        await en.ev(`window.__crawl(${JSON.stringify(page)}, ${Math.min(budget, 15000)})`);
      }
      for (const [where, js] of [['存档和备份', `A.savesManager(${V(P1)})`], ['改独立', `A.isoWorlds.switchToOwn(${V(P2)})`], ['转为正式配置', `A.iso.promote(${V(P1)})`]]) await en.ev(`window.__open(${JSON.stringify(where)}, () => ${js})`);
      await calm(en.ev);
      const leakFile = path.join(en.root, 'leak.log');
      const leak = fs.existsSync(leakFile) ? fs.readFileSync(leakFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
      const onDisk = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (/[\u2068\u2069]/.test(e.name)) onDisk.push(`文件名 ${p}`);
          if (e.isDirectory()) { if (!/^(Cache|Code Cache|GPUCache|blob_storage|Local Storage|Session Storage|Network|DawnCache|DawnGraphiteCache|Shared Dictionary|shots)$/.test(e.name)) walk(p); } else if (/\.(json|txt|toml|properties|bak)$/i.test(e.name)) {
            try { const st = fs.statSync(p); if (st.size < 3000000 && /[\u2068\u2069]/.test(fs.readFileSync(p, 'utf8'))) onDisk.push(`文件内容 ${path.relative(en.root, p)}`); } catch { /* 正在写 */ }
          }
        }
      };
      walk(en.data); walk(en.game);
      for (const l of [...leak.slice(0, 20), ...onDisk.slice(0, 20)]) console.log(`  标记泄漏：${l.slice(0, 260)}`);
      check('name-crawl', '标记没有进接口参数和写入的文件名、内容（监听到的）', leak.length === 0, leak.slice(0, 3));
      check('name-crawl', '游戏目录和数据目录里没有带标记的文件名、配置和存档信息', onDisk.length === 0, onDisk.slice(0, 3));
      const left = Object.keys(f.leftover);
      // 剩下的中文：字典里有的是被当成名字加了标记（错），字典里没有的是之前就漏的词条
      const verdict = await en.ev(`(${JSON.stringify(left)}).map((t) => [t, window.I18N_TRANSLATE.tr(t) !== t])`);
      const wrong = verdict.filter((x) => x[1]).map((x) => `${x[0]} ← ${f.leftover[x[0]]}`);
      const gap = verdict.filter((x) => !x[1]).map((x) => `${x[0]} ← ${f.leftover[x[0]]}`);
      console.log(`  点了 ${f.clicks} 次；名字出现次数：${Object.entries(f.names).map(([k, v]) => `${k}×${v}`).join('，').slice(0, 300)}`);
      for (const [k, list] of [['名字被翻', Object.entries(f.translated).map(([t, w]) => `${t} ← ${w}`)], ['标记没去掉', Object.entries(f.marker).map(([t, w]) => `${t} ← ${w}`)], ['界面文字没翻（字典里有）', wrong], ['字典缺词', gap]]) {
        if (list.length) console.log(`  ${k}（${list.length}）：\n    ${list.slice(0, 40).join('\n    ').slice(0, 5000)}`);
      }
      check('name-crawl', `点遍 ${pages.length} 页（${f.clicks} 次点击）：名字的译文一次也没出现`, Object.keys(f.translated).length === 0, Object.keys(f.translated).slice(0, 5));
      check('name-crawl', '所有文字和属性里都没留下标记', Object.keys(f.marker).length === 0, Object.keys(f.marker).slice(0, 5));
      check('name-crawl', '界面文字没有被当成名字（字典里有的都翻了）', wrong.length === 0, wrong.slice(0, 5));
      check('name-crawl', '界面上没有字典缺的中文', gap.length === 0, gap.slice(0, 5));
      const shown = (n) => (f.names[n] || 0) > 0;
      for (const [k, n] of [['配置', W.p1], ['配置（带分隔符）', PROFILES[1]], ['配置显示名', `${W.disp}：${W.p1}`], ['Mod 文件', `${W.mod}.jar`], ['世界', W.world], ['方案', W.plan], ['皮肤', W.skin], ['账户', W.acc], ['认证服务器', W.srv]]) {
        check('name-crawl', `确认覆盖到了：${k}`, shown(n), n);
      }
    } finally { await en.stop(); }
  },

  /**
   * 中文界面：配置、皮肤、世界等名字和英文字典、英文 Mod 重名。
   * 翻译器在中文界面不运行；Mod 中文名对照表（modnames.js）只用在真的 Mod 上，别的名字不能被它改。
   */
  async 'zh-mod-names'() {
    const MODS = ['Sodium', 'Create', 'Just Enough Items', 'Lithium', 'Settings', 'Launch'];
    const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png); png.writeUInt32BE(64, 16); png.writeUInt32BE(64, 20);
    const zh = await startApp('zh-modnames', {
      language: 'zh-CN', safe: true,
      config: { selectedVersion: 'Sodium' },
      setup: (game) => {
        MODS.forEach((n) => fakeVersion(game, n));
        fakeVersion(game, 'Host', ['Sodium.jar']);
        const d = path.join(game, 'versions', 'Sodium');
        for (const w of ['Create', 'Lithium']) { fs.mkdirSync(path.join(d, 'saves', w), { recursive: true }); fs.writeFileSync(path.join(d, 'saves', w, 'level.dat'), 'x'); }
        fs.mkdirSync(path.join(d, 'resourcepacks'), { recursive: true }); fs.writeFileSync(path.join(d, 'resourcepacks', 'Sodium.zip'), 'x');
        fs.writeFileSync(path.join(path.dirname(game), 'data', 'accounts.json'), JSON.stringify({ selected: 'y1', accounts: [{ id: 'y1', type: 'yggdrasil', name: 'Sodium', uuid: '00000000000000000000000000000001', server: { name: 'Create', root: 'http://127.0.0.1:9/', homepage: 'http://127.0.0.1:9/' }, addedAt: 1 }] }));
      },
    });
    try {
      await zh.ev(closeModals);
      await zh.ev(`A.api('skins:libraryAdd', { png: ${JSON.stringify(png.toString('base64'))}, model: 'classic', name: 'Sodium', group: 'Create' }).then(() => 1, (e) => e.message)`);
      await zh.ev("A.api('planner:save', { id: 'pz1', name: 'Sodium', mc: '1.20.1', loader: 'fabric', styles: [], items: [] }).then(() => 1, () => 0)");
      await zh.ev('A.refreshInstalled().then(() => 1)');
      const map = await zh.ev(`Object.fromEntries(${JSON.stringify(MODS)}.map((n) => [n, A.modNames.zhOf({ title: n })]))`);
      const zhs = Object.values(map).filter(Boolean);
      check('zh-names', '确认场景成立：对照表里有这些 Mod 的中文名', zhs.length >= 3, map);
      check('zh-names', '翻译器在中文界面原样返回', await zh.ev("['Settings', 'Launch'].every((s) => window.I18N_TRANSLATE.tr(s) === s) && A.nm('Settings') === 'Settings'"));
      const scan = `(() => { const zhs = ${JSON.stringify(zhs)}; const hits = [];
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.parentElement.closest('script,style,.page:not(.active)')) continue; for (const z of zhs) if (n.nodeValue.includes(z)) hits.push(n.nodeValue.slice(0, 40)); }
        for (const el of document.body.querySelectorAll('[title],[aria-label],[data-tip]')) { if (el.closest('.page:not(.active)')) continue; for (const a of ['title', 'aria-label', 'data-tip']) { const v = el.getAttribute(a); for (const z of zhs) if (v && v.includes(z)) hits.push(v.slice(0, 40)); } }
        return hits; })()`;
      const look = async (where, names) => {
        const text = await zh.ev("[...document.querySelectorAll('.page.active, .modal-back, .drawer')].map((x) => x.innerText).join('\\n')");
        const missing = names.filter((n) => !String(text).includes(n));
        const hits = await zh.ev(scan);
        check('zh-names', `${where}：名字原样，没有多出 Mod 的中文名`, !missing.length && !hits.length, { missing, hits: hits.slice(0, 3) });
      };
      for (const [p, names] of [['versions', MODS], ['home', ['Sodium']], ['skins', ['Sodium', 'Create']], ['accounts', ['Sodium', 'Create']]]) {
        await zh.ev(`A.go(${JSON.stringify(p)}); 1`);
        await calm(zh.ev);
        await until(zh.ev, `(() => { const t = [...document.querySelectorAll('.page.active, .modal-back, .drawer')].map((x) => x.innerText).join('\\n'); return ${JSON.stringify(names)}.every((n) => t.includes(n)); })()`, 10000);
        await look(`页面 ${p}`, names);
      }
      await zh.ev("A.go('planner'); 1"); await calm(zh.ev);
      await zh.ev("(() => { const b = [...document.querySelectorAll('.page.active button')].find((x) => x.innerText.includes(A.t('term.myPlans'))); if (b) b.click(); return !!b; })()"); await calm(zh.ev);
      await look('我的方案（方案名 Sodium）', ['Sodium']);
      await zh.ev(closeModals);
      // 世界列表是窗口画出来以后才读到的（中间没有转圈）：等两个世界名真的出现，最多 10 秒
      await zh.ev("A.savesManager(A.state.installed.find((x) => x.id === 'Sodium')); 1");
      await until(zh.ev, "(() => { const m = [...document.querySelectorAll('.modal-back .modal')].pop(); return !!m && m.innerText.includes('Create') && m.innerText.includes('Lithium'); })()", 10000);
      await look('存档窗口（世界名 Create、Lithium）', ['Create', 'Lithium']);
      await zh.ev(closeModals);
      // 真的 Mod：对照表是给它用的，中文名加在前面，原名还在
      await zh.ev("A.setConfig({ selectedVersion: 'Host' }).then(() => 1)");
      await zh.ev("A.go('mods'); 1"); await calm(zh.ev);
      // Mod 列表读文件要一会儿，全量回归时机器忙，1.2 秒还没画出来过一次（rc1 全量）：最多等 6 秒
      let row = '';
      for (let i = 0; i < 24 && !row; i++) {
        row = await zh.ev("(() => { const el = [...document.querySelectorAll('.page.active .title')].find((x) => /Sodium/.test(x.innerText)); return el ? el.innerText : ''; })()");
        if (!row) await sleep(250); // pitfall-ok：轮询里两次查看之间的间隔
      }
      check('zh-names', 'Mod 页的 Sodium.jar：中文名加在前面，原名还在', row.includes('Sodium') && (!map.Sodium || row.includes(map.Sodium)), row);
    } finally { await zh.stop(); }
  },

  /** 转为正式配置：真的从界面点一遍（2.0.0-pre7，7cfcb44 起这条路一直是坏的，没有场景走到过） */
  async 'promote-ui'() {
    const app = await startApp('promote-ui', {
      safe: true,
      setup: (game) => {
        fakeVersion(game, 'SandUi');
        fs.writeFileSync(path.join(game, 'versions', 'SandUi', 'aurora-profile.json'), JSON.stringify({ type: 'custom', isolation: { preset: 'sandbox', source: '@root' } }));
        fs.mkdirSync(path.join(game, 'saves', 'UiWorld'), { recursive: true });
        fs.writeFileSync(path.join(game, 'saves', 'UiWorld', 'level.dat'), 'source');
      },
    });
    try {
      await app.ev(closeModals);
      const before = await app.ev("A.api('isolation:get', 'SandUi')");
      check('promote-ui', '确认场景成立：现在是测试副本', before && before.preset === 'sandbox', before && before.preset);
      await app.ev("A.iso.promote(A.state.installed.find((x) => x.id === 'SandUi')); 1");
      await calm(app.ev);
      const title = await app.ev("(document.querySelector('.modal-back') || {}).innerText || ''");
      check('promote-ui', '弹出了转正的确认窗口', /转为正式配置/.test(title), String(title).slice(0, 60));
      const clicked = await app.ev("(() => { const b = [...document.querySelectorAll('.modal-back .btn.primary, .modal-back button.primary')].find((x) => /转为正式配置/.test(x.innerText)); if (b) b.click(); return !!b; })()");
      check('promote-ui', '点了「转为正式配置」', clicked);
      let policy = before;
      for (let i = 0; i < 30 && policy.preset !== 'isolated'; i++) { await sleep(300); policy = await app.ev("A.api('isolation:get', 'SandUi')"); }
      let toast = '';
      for (let i = 0; i < 20 && !/已转为正式配置/.test(toast); i++) { await sleep(150); toast = await app.ev("[...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' | ')"); }
      check('promote-ui', '转成功：策略是独立', policy.preset === 'isolated', { preset: policy.preset, toast });
      check('promote-ui', '提示是成功，没有错误', /已转为正式配置/.test(toast) && !/not defined|失败/.test(toast), toast);
      check('promote-ui', '世界带过来了', fs.existsSync(path.join(app.game, 'versions', 'SandUi', 'saves', 'UiWorld', 'level.dat')));
    } finally { await app.stop(); }
  },

  /**
   * 界面底层（2.0.0-pre7）：进度只改文字和宽度、提示规则、页面刷新约定、监听顺序、快捷键、合并刷新。
   * 用 AURORA_REGRESS_APP 指向旧代码可以跑修前结果（旧代码没有的函数按「不通过」算）。
   */
  async 'ui-floor'() {
    const app = await startApp('floor', { language: 'zh-CN', safe: true });
    const toasts = (re) => app.ev(`[...document.querySelectorAll('.toast:not(.out)')].filter((x) => ${re}.test(x.innerText)).length`);
    try {
      await app.ev(closeModals); await app.ev(clearToasts);
      await app.ev("A.api('accounts:addOffline', 'FloorPlayer').then(() => A.refreshAccounts()).then(() => 1, () => 0)");

      // 1-2、1-3 下载管理：文件行和统计不重建
      await app.ev("A.go('download', { tab: 'tasks' }); 1"); await calm(app.ev);
      const dl = await app.ev(`(async () => {
        const task = (i) => ({ id: 'fl1', kind: 'install', status: 'running', title: '安装 测试', detail: 'x', progress: 0.1 + i / 100, meta: {}, createdAt: Date.now(), files: { done: i, total: 50, active: 2, failed: 0 }, bytes: { done: i * 1000, total: 500000 }, speed: 1000 + i,
          current: [{ name: 'a.jar', size: 1000, received: i * 10, attempt: 1 }, { name: 'b.jar', size: 1000, received: i * 20, attempt: i > 3 ? 2 : 1 }] });
        const box = document.createElement('div'); document.body.appendChild(box);
        const mgr = A.tasks.mountManager(box, { group: 'download' });
        A.state.tasks.set('fl1', task(0)); mgr.render();
        await new Promise((res) => setTimeout(res, 150));
        const firstRow = box.querySelector('.cur-row');
        let added = 0;
        const ob = new MutationObserver((l) => { for (const m of l) added += [...m.addedNodes].filter((n) => n.nodeType === 1).length; });
        ob.observe(box, { subtree: true, childList: true });
        for (let i = 1; i <= 10; i++) { A.state.tasks.set('fl1', task(i)); mgr.render(); await new Promise((res) => setTimeout(res, 20)); }
        await new Promise((res) => setTimeout(res, 100));
        ob.disconnect();
        const sameRow = firstRow && firstRow.isConnected;
        const bar = box.querySelector('.cur-row .progress i');
        const width = bar ? bar.style.width : '';
        const badge = [...box.querySelectorAll('.cur-row .badge')].filter((x) => !x.classList.contains('hidden')).map((x) => x.innerText).join(',');
        box.remove(); mgr.destroy(); A.state.tasks.delete('fl1');
        return { added, sameRow, width, badge };
      })()`);
      check('1-2', '下载中的文件行：10 次更新不重建（没有新增元素）', dl.sameRow && dl.added === 0, dl);
      check('1-2', '下载中的文件行：小进度条和重试标记跟着变', dl.width === '10%' && /重试 1/.test(dl.badge), dl);
      const stats = await app.ev(`(async () => {
        const el = document.querySelector('.dm-head');
        if (!el) return { none: true };
        const firstB = el.querySelector('.dm-stat b');
        let added = 0;
        const ob = new MutationObserver((l) => { for (const m of l) added += [...m.addedNodes].filter((n) => n.nodeType === 1).length; });
        ob.observe(el, { subtree: true, childList: true });
        for (let i = 0; i < 10; i++) A.emit('task', { id: 'x', kind: 'install', status: 'running', meta: {} });
        await new Promise((res) => setTimeout(res, 100));
        ob.disconnect();
        return { added, same: firstB && firstB.isConnected };
      })()`);
      check('1-3', '下载页统计：10 次任务更新不重建', stats.added === 0 && stats.same, stats);

      // 1-5 语言按钮
      const lang = await app.ev(`(async () => {
        const b = document.getElementById('btnLang');
        if (!b) return { none: true };
        let n = 0;
        const ob = new MutationObserver((l) => { n += l.length; });
        ob.observe(b, { subtree: true, childList: true, attributes: true, characterData: true });
        for (let i = 0; i < 20; i++) A.emit('task', { id: 'x', kind: 'install', status: 'running', meta: {} });
        await new Promise((res) => setTimeout(res, 100));
        ob.disconnect();
        return { n };
      })()`);
      check('1-5', '语言按钮：20 次任务更新一次都不写', lang.n === 0, lang);

      // 1-6 改设置：记 tips 不重建；不在当前页不画，切回来才画
      await app.ev("A.go('versions'); 1"); await calm(app.ev);
      const noise = await app.ev(`(async () => {
        const nav = document.querySelector('.nav-item'); const card = document.querySelector('#page-versions .page-inner > *');
        const log = [];
        const off1 = A.on('task', (t) => log.push('task:' + t.kind + ':' + t.status));
        const off2 = A.on('config', (c, ch) => log.push('config:' + JSON.stringify(ch)));
        await A.setConfig({ tips: { floorProbe: Date.now() } });
        await new Promise((res) => setTimeout(res, 150));
        if (typeof off1 === 'function') off1();
        if (typeof off2 === 'function') off2();
        return { nav: nav && nav.isConnected, card: card && card.isConnected, log };
      })()`);
      check('1-6', '记一个 tips：侧边栏不重建', noise.nav, noise);
      check('1-6', '记一个 tips：配置列表不重建', noise.card, noise);
      const hidden = await app.ev(`(async () => {
        A.go('home'); await new Promise((res) => setTimeout(res, 300));
        const root = document.getElementById('page-versions');
        let n = 0;
        const ob = new MutationObserver((l) => { n += l.length; });
        ob.observe(root, { subtree: true, childList: true });
        A.emit('installed', A.state.installed); A.emit('javas', A.state.javas);
        await new Promise((res) => setTimeout(res, 150));
        ob.disconnect();
        return { n };
      })()`);
      check('1-6', '不在配置页：配置页不画', hidden.n === 0, hidden);
      const back = await app.ev(`(async () => {
        const root = document.getElementById('page-versions');
        const old = root.firstChild;
        A.state.installed = [...A.state.installed];
        A.emit('installed', A.state.installed);
        A.go('versions'); await new Promise((res) => setTimeout(res, 400));
        return root.innerText.length > 0;
      })()`);
      check('1-6', '切回配置页：内容是新的', back);

      // 1-7 设置页打字时 Java 扫描结束，输入的内容还在
      await app.ev("A.go('settings'); 1"); await calm(app.ev);
      const typing = await app.ev(`(async () => {
        const input = [...document.querySelectorAll('#page-settings input.input:not([readonly]):not([disabled])')].find((x) => x.type !== 'number');
        if (!input) return { none: true };
        input.focus(); input.value = '打到一半';
        A.emit('javas', A.state.javas);
        await new Promise((res) => setTimeout(res, 200));
        const ok = { connected: input.isConnected, value: input.value, focus: document.activeElement === input };
        input.value = ''; input.blur();
        return ok;
      })()`);
      check('1-7', 'Java 扫描结束：正在输入的内容和光标都在', typing.connected && typing.value === '打到一半' && typing.focus, typing);

      // 13-2 同时发出的刷新合并；旧结果不盖新的
      const merge = await app.ev(`(async () => {
        let n = 0;
        const off = A.on('installed', () => { n++; });
        await Promise.all([A.refreshInstalled(), A.refreshInstalled(), A.refreshInstalled(), A.refreshInstalled(), A.refreshInstalled()]);
        off && off();
        return { n };
      })()`);
      check('13-2', '同时刷新 5 次：只读 1 ~ 2 次', merge.n <= 2 && merge.n >= 1, merge);
      fakeVersion(app.game, 'FreshAfter');
      const fresh = await app.ev(`(async () => {
        const first = A.refreshInstalled();
        await A.refreshInstalled();
        await first;
        return A.state.installed.some((x) => x.id === 'FreshAfter');
      })()`);
      check('13-2', '刷新的时候又要刷新：拿到的是最新的', fresh);

      // 10-1 弹窗开着时快捷键不切页、不启动
      await app.ev("A.go('home'); 1"); await calm(app.ev);
      const key = await app.ev(`(async () => {
        A.confirm('测试弹窗', { title: '测试' });
        await new Promise((res) => setTimeout(res, 200));
        const before = A.state.page;
        const press = (o) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, ...o }));
        press({ key: '3' }); press({ key: 'Enter' });
        await new Promise((res) => setTimeout(res, 200));
        const launching = [...A.state.tasks.values()].some((t) => t.kind === 'launch' && t.status === 'running');
        return { same: A.state.page === before, launching };
      })()`);
      check('10-1', '确认框开着：Ctrl+3 不切页', key.same, key);
      check('10-1', '确认框开着：Ctrl+Enter 不启动', !key.launching, key);
      await app.ev(closeModals);
      const keyFree = await app.ev(`(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: '2' })); await new Promise((res) => setTimeout(res, 300)); return A.state.page; })()`);
      check('10-1', '没有弹窗：Ctrl+2 照常切页', keyFree !== 'home', keyFree);

      // 提示规则
      await app.ev(clearToasts);
      const rule = await app.ev(`(() => {
        A.toast({ level: 'ok', title: '规则一', text: '带按钮的成功提示', actions: [{ label: '看看', onClick() {} }] });
        A.toast({ level: 'info', title: '规则二', text: '带按钮的普通提示', actions: [{ label: '看看', onClick() {} }] });
        A.toast({ level: 'info', title: '规则三', text: '明确要常驻', sticky: true, actions: [{ label: '看看', onClick() {} }] });
        A.toast({ level: 'crit', title: '规则四', text: '错误' });
        const sticky = (re) => { const t = [...document.querySelectorAll('.toast')].find((x) => re.test(x.innerText)); return t ? t.classList.contains('sticky') : null; };
        return { ok: sticky(/规则一/), info: sticky(/规则二/), want: sticky(/规则三/), crit: sticky(/规则四/) };
      })()`);
      check('3-8', '成功和普通提示带按钮：定时消失', rule.ok === false && rule.info === false, rule);
      check('3-8', '明确写 sticky、错误：常驻', rule.want === true && rule.crit === true, rule);
      await app.ev(clearToasts);
      // 同样的提示不叠
      await app.ev("for (let i = 0; i < 6; i++) A.toast({ level: 'info', title: '重复', text: '一样的提示' }); 1");
      await calm(app.ev);
      check('3-1', '同样的提示连发 6 次：只有 1 条', (await toasts('/重复/')) === 1, await toasts('/重复/'));
      await app.ev(clearToasts);

      // 3-1 简洁模式的提示
      await app.ev("A.setConfig({ simpleMode: true }).then(() => { A.simple.apply && A.simple.apply(); return 1; })");
      await app.ev("for (let i = 0; i < 4; i++) A.simple.check(); 1");
      await calm(app.ev);
      check('3-1', '简洁模式连点 4 次灰色入口：只有 1 条', (await toasts('/简洁模式下不可用/')) === 1, await toasts('/简洁模式下不可用/'));
      // 6-8 简洁模式下任务中心能打开
      await app.ev("A.go('tasks'); 1"); await calm(app.ev);
      check('6-8', '简洁模式：任务中心能打开', (await app.ev('A.state.page')) === 'tasks', await app.ev('A.state.page'));
      const dlOff = await app.ev(`(async () => { if (!A.tasks.openDownloads) return { none: true }; A.tasks.openDownloads(); await new Promise((res) => setTimeout(res, 300)); const t = (document.querySelector('.modal-back') || {}).innerText || ''; return { modal: /下载管理/.test(t), page: A.state.page }; })()`);
      check('6-8', '简洁模式：下载记录能看（只读）', dlOff.modal === true, dlOff);
      await app.ev(closeModals);
      await until(app.ev, "![...document.querySelectorAll('.toast:not(.out)')].some((x) => /简洁模式下不可用/.test(x.innerText))", 9000);
      check('3-1', '5 秒后自己消失', (await toasts('/简洁模式下不可用/')) === 0, await toasts('/简洁模式下不可用/'));
      await app.ev("A.setConfig({ simpleMode: false }).then(() => { A.simple.apply && A.simple.apply(); return 1; })");
      await app.ev(clearToasts);

      // 3-3 启动失败：下一次启动时收起
      const fail = await app.ev(`(async () => {
        const wait = async (fn) => { for (let i = 0; i < 80; i++) { const v = fn(); if (v) return v; await new Promise((res) => setTimeout(res, 150)); } return null; };
        const find = () => [...document.querySelectorAll('.toast:not(.out)')].find((x) => /启动失败/.test(x.innerText));
        A.launch('NoSuchProfile');
        const first = await wait(find);
        await new Promise((res) => setTimeout(res, 900));
        A.launch('NoSuchProfile');
        await new Promise((res) => setTimeout(res, 60));
        const gone = !first || first.classList.contains('out') || !first.isConnected;
        const second = await wait(() => { const t = find(); return t && t !== first ? t : null; });
        return { had: !!first, gone, second: !!second, count: [...document.querySelectorAll('.toast:not(.out)')].filter((x) => /启动失败/.test(x.innerText)).length };
      })()`);
      check('3-3', '启动失败：再启动一次时旧提示收起，只留新的', fail.had && fail.gone && fail.second && fail.count === 1, fail);
      await app.ev(clearToasts);

      // 3-4 任务失败提示：重试时收起
      const retry = await app.ev(`(async () => {
        const wait = async (fn) => { for (let i = 0; i < 60; i++) { const v = fn(); if (v) return v; await new Promise((res) => setTimeout(res, 100)); } return null; };
        const find = () => [...document.querySelectorAll('.toast:not(.out)')].find((x) => /补全.*失败/.test(x.innerText));
        const id = await A.api('versions:complete', 'NoSuchRetry');
        const first = await wait(find);
        const t = await wait(() => { const x = [...A.state.tasks.values()].find((y) => y.status === 'failed' && y.title.includes('NoSuchRetry')); return x; });
        const before = first;
        await A.api('tasks:retry', t.id);
        const second = await wait(() => { const x = find(); return x && x !== before ? x : null; });
        return { had: !!first, firstGone: !first || !first.isConnected || first.classList.contains('out'), second: !!second, count: [...document.querySelectorAll('.toast:not(.out)')].filter((x) => /补全.*失败/.test(x.innerText)).length, id: typeof id };
      })()`);
      check('3-4', '任务失败提示：重试时旧的收起，只留一条', retry.had && retry.firstGone && retry.count === 1, retry);
      await app.ev(clearToasts);

      // 名字里有关键词：提示不能给证书、写入权限的建议（真实走一遍失败提示）
      for (const [name, wrong] of [['certificate-x', /证书|系统时间|HTTPS/], ['EPERM-x', /写入权限|Program Files|受保护/], ['socket hang up', /连接被中断/]]) {
        await app.ev(clearToasts);
        await app.ev(`A.api('versions:complete', ${JSON.stringify(name)}).then(() => 1, () => 0)`);
        await until(app.ev, "!!document.querySelector('.toast:not(.out)')", 6000);
        const said = await app.ev(`[...document.querySelectorAll('.toast:not(.out)')].map((x) => x.innerText).join(' | ')`);
        const reason = await app.ev(`(() => { const t = [...A.state.tasks.values()].filter((x) => (x.title || '').includes(${JSON.stringify(name)})).pop(); return t && t.reason ? t.reason.message : ''; })()`);
        check('10-8', `配置叫 ${name}：提示说的是找不到版本，没有给错建议`, said.includes(name) && !wrong.test(said) && !wrong.test(reason), { said: said.slice(0, 120), reason: reason.slice(0, 60) });
      }
      await app.ev(clearToasts);

      // 3-6 Java 不合适的提示：改回自动以后收起
      const mismatch = await app.ev(`(async () => {
        await A.setConfig({ java: { selected: 'C:/no/such/java.exe' } });
        await A.javaCheck.afterInstall('ModP');
        await new Promise((res) => setTimeout(res, 200));
        const find = () => [...document.querySelectorAll('.toast:not(.out)')].find((x) => x.innerText.includes(A.t('java.mismatchTitle')));
        const had = !!find();
        await A.setConfig({ java: { selected: 'auto' } });
        await new Promise((res) => setTimeout(res, 1200));
        return { had, gone: !find() };
      })()`);
      check('3-6', 'Java 不合适的提示：改回自动后收起', mismatch.had && mismatch.gone, mismatch);
      await app.ev(clearToasts);

      // 2-3 启动失败后账户状态要刷新
      const acc = await app.ev(`(async () => {
        let n = 0;
        const off = A.listen('accounts:changed', () => { n++; });
        await A.api('launch:start', 'NoSuchAcc', {}).catch(() => {});
        await new Promise((res) => setTimeout(res, 200));
        if (typeof off === 'function') off();
        return { n };
      })()`);
      check('2-3', '启动结束（失败也算）：账户状态刷新一次', acc.n >= 1, acc);
      await app.ev(clearToasts);
    } finally { await app.stop(); }

    // 2-5 向导开着时：事件不丢
    // 免责声明没同意：启动流程停在第一个对话框，和向导开着是同一个位置
    const wiz = await startApp('floor-wiz', { language: 'zh-CN', safe: true, config: { setupDone: false, disclaimerAccepted: '0' } }); // pitfall-ok：故意没同意过，要看到免责声明
    try {
      await calm(wiz.ev);
      const open = await wiz.ev("!!document.querySelector('.modal-back')");
      check('2-5', '确认场景成立：启动流程停在对话框上', open, open);
      await wiz.ev("A.setConfig({ theme: 'light' }).then(() => 1)");
      await calm(wiz.ev);
      const theme = await wiz.ev('document.documentElement.dataset.theme || document.documentElement.getAttribute("data-theme") || document.body.className');
      check('2-5', '向导里改设置：主题马上生效', /light/.test(String(theme)), theme);
      await wiz.ev("A.api('versions:complete', 'NoSuchWizard').then(() => 1, () => 0)");
      await until(wiz.ev, "[...document.querySelectorAll('.toast:not(.out)')].some((x) => /NoSuchWizard/.test(x.innerText))", 6000);
      const n = await wiz.ev("[...document.querySelectorAll('.toast:not(.out)')].filter((x) => /NoSuchWizard/.test(x.innerText)).length");
      check('2-5', '向导开着时主进程发的通知：能看到', n >= 1, n);
    } finally { await wiz.stop(); }
  },

  /** 新的任务行和提示在 3 种风格、明暗、1.5 倍、高对比度下的样子，存图给人看（AURORA_SHOT_OUT） */
  async 'ui-floor-shots'() {
    const out = process.env.AURORA_SHOT_OUT;
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    const CASES = [
      ['aurora-dark', {}], ['aurora-light', { theme: 'light' }], ['pixel-dark', { ui: { style: 'pixel' } }], ['pixel-light', { ui: { style: 'pixel' }, theme: 'light' }],
      ['compact-dark', { ui: { style: 'compact' } }], ['compact-light', { ui: { style: 'compact' }, theme: 'light' }], ['aurora-zoom', { a11y: { zoom: 1.5 } }], ['aurora-contrast', { a11y: { contrast: 'on' } }],
    ];
    for (const [name, cfg] of CASES) {
      const app = await startApp(`shot-${name}`, { language: 'zh-CN', safe: true, config: cfg });
      try {
        await app.ev(closeModals); await app.ev(clearToasts);
        await app.ev("A.go('download', { tab: 'tasks' }); 1"); await calm(app.ev);
        await app.ev(`(async () => {
          const task = (id, p) => ({ id, kind: 'install', status: 'running', title: '安装 Fabric 1.20.1', detail: '下载文件', progress: p, meta: {}, createdAt: Date.now(), files: { done: 12, total: 50, active: 3, failed: 0 }, bytes: { done: 1200000, total: 5000000 }, speed: 300000,
            current: [{ name: 'fabric-api-0.92.0.jar', size: 1000, received: 300, attempt: 1 }, { name: 'sodium-fabric-0.5.jar', size: 1000, received: 700, attempt: 2 }, { name: 'iris-1.7.jar', size: 0, received: 900, attempt: 1 }] });
          A.state.tasks.set('s1', task('s1', 0.4));
          const box = document.querySelector('#page-download .dm-list');
          const mgr = A.tasks.mountManager(box, { group: 'download' }); mgr.render();
          A.toast({ level: 'ok', title: '安装完成', text: '成功提示带按钮，定时消失', actions: [{ label: '立即启动', onClick() {} }], duration: 60000 });
          A.toast({ level: 'crit', title: '启动失败', text: '错误提示要点 × 关', actions: [{ label: '查看日志', onClick() {} }] });
          return 1;
        })()`);
        await calm(app.ev);
        const r = await app.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.data, 'base64'));
        check('shots', `${name}：截图`, r.data.length > 1000);
      } finally { await app.stop(); }
    }
  },

  /** 同样的负载，新旧代码各跑一遍（AURORA_REGRESS_APP 指向旧代码）。结果写到 AURORA_LOAD_OUT */
  async 'ui-load'() {
    const app = await startApp('load', { language: 'en', safe: true, setup: (game) => { for (let i = 0; i < 30; i++) fakeVersion(game, `L${i}`, ['a.jar', 'b.jar']); } });
    try {
      await app.ev(closeModals); await app.ev(clearToasts);
      await app.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await app.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      const run = async (label, js) => {
        const a = await metrics();
        const r = await app.ev(js);
        const b = await metrics();
        return { label, mutations: r.n, added: r.added, ms: Math.round(r.ms), scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000), layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000), recalcMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000), layouts: b.LayoutCount - a.LayoutCount, nodes: b.Nodes };
      };
      const watch = (body) => `(async () => {
        let n = 0; let added = 0;
        const ob = new MutationObserver((l) => { n += l.length; for (const m of l) added += m.addedNodes.length; });
        ob.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const t0 = performance.now();
        ${body}
        await new Promise((res) => setTimeout(res, 300));
        ob.disconnect();
        return { n, added, ms: performance.now() - t0 - 300 };
      })()`;
      await app.ev("A.go('download', { tab: 'tasks' }); 1"); await calm(app.ev);
      const results = [];
      results.push(await run('下载管理：6 个任务 × 8 个文件，更新 300 次', watch(`
        const box = document.createElement('div'); document.body.appendChild(box);
        const mgr = A.tasks.mountManager(box, { group: 'download' });
        const task = (id, i) => ({ id, kind: 'install', status: 'running', title: 'Install ' + id, detail: 'file ' + i, progress: (i % 100) / 100, meta: {}, createdAt: 1, files: { done: i, total: 500, active: 8, failed: 0 }, bytes: { done: i * 1000, total: 500000 }, speed: 1000 + i, current: Array.from({ length: 8 }, (_, k) => ({ name: 'f' + k + '.jar', size: 1000, received: (i * 7 + k) % 1000, attempt: 1 })) });
        for (let i = 0; i < 300; i++) {
          for (let k = 0; k < 6; k++) { const t = task('lt' + k, i); A.state.tasks.set(t.id, t); if (k === 0) A.emit('task', t); }
          mgr.render();
          if (i % 3 === 0) await new Promise((res) => setTimeout(res, 0));
        }
        for (let k = 0; k < 6; k++) A.state.tasks.delete('lt' + k);
        box.remove(); mgr.destroy();`)));
      await app.ev("A.go('versions'); 1"); await calm(app.ev);
      results.push(await run('配置页开着：连记 30 次 tips', watch(`for (let i = 0; i < 30; i++) await A.setConfig({ tips: { loadProbe: i } });`)));
      await app.ev("A.go('home'); 1"); await calm(app.ev);
      results.push(await run('在主页：配置列表刷新事件 30 次（其他页面不该画）', watch(`for (let i = 0; i < 30; i++) A.emit('installed', A.state.installed);`)));
      results.push(await run('同时刷新配置列表 20 次', watch(`await Promise.all(Array.from({ length: 20 }, () => A.refreshInstalled()));`)));
      for (const r of results) console.log(`  ${JSON.stringify(r)}`);
      if (process.env.AURORA_LOAD_OUT) fs.writeFileSync(process.env.AURORA_LOAD_OUT, JSON.stringify(results, null, 1));
      check('ui-load', '负载跑完了', results.length === 4);
    } finally { await app.stop(); }
  },

  /** 真实游戏、真实音效：要 --ui-only=game-pause-real，并设好 AURORA_REGRESS_GAME_SRC、AURORA_REGRESS_JAVA_HOME */
  async 'game-pause-real'(c) {
    if (!fs.existsSync(path.join(c.game, 'versions', '1.20.1', '1.20.1.json'))) return; // 全量里没有准备游戏，只在单独跑时测
    const JAVA = path.join(process.env.AURORA_REGRESS_JAVA_HOME, 'bin', 'java.exe');
    await c.ev(`${closeModals}; ${clearToasts}; A.go('home'); A.setConfig({ java: { selected: ${JSON.stringify(JAVA)}, extra: [${JSON.stringify(JAVA)}] }, afterLaunch: 'minimize' }); 1`);
    await c.ev(SOUND_SPY);
    await c.ev("A.api('accounts:addOffline', 'PausePlayer').then(() => A.refreshAccounts())");
    await calm(c.ev);
    const running = () => c.ev('!!(A.homeScene() && A.homeScene().running)');
    const hurt = "A.gameSound.play('entity.zombie.hurt', { volume: 1 }).then(() => 1)";
    const n0 = await c.ev('window.__snd.n');
    await c.ev(hurt);
    await sleep(100); // pitfall-ok：声音是异步放出来的，等一小会儿再数响了几下
    const usable = (await c.ev('window.__snd.n')) - n0;
    check('pause-real', '确认场景成立：从真实游戏资源读到了僵尸受击声音，平时响', usable > 0, usable);
    check('pause-real', '确认场景成立：启动前背景在动', await running());
    const clickedAt = Date.now();
    await c.ev("A.launch('1.20.1'); 1");
    // 启动前要查 Java 再建任务，任务出现 1 秒后才暂停。1.6 秒的写法在全部场景连着跑时总差一点（查 Java 慢）：改成量实际用了多久
    let pausedAfter = null;
    for (let i = 0; i < 60 && pausedAfter == null; i++) {
      await sleep(100); // pitfall-ok：轮询里两次查看之间的间隔
      if (!(await running())) pausedAfter = Date.now() - clickedAt;
    }
    const started = await c.ev("[...A.state.tasks.values()].some((t) => t.kind === 'launch') || A.state.games.size > 0");
    const launchesBefore = await c.ev("(A.state.installed.find((x) => x.id === '1.20.1') || {}).launchCount || 0");
    check('pause-real', '真的在启动', started);
    check('pause-real', '点启动后 5 秒内背景暂停', pausedAfter != null && pausedAfter < 5000, `${pausedAfter} ms`);
    // 等到游戏真的跑起来
    let inGame = false;
    for (let i = 0; i < 240 && !inGame; i++) { inGame = await c.ev("[...A.state.games.values()].some((g) => g.state === 'running')"); await sleep(500); }
    check('pause-real', '游戏真的跑起来了', inGame);
    await until(c.ev, '!(A.homeScene() && A.homeScene().running)', 5000);
    check('pause-real', '游戏运行中：背景暂停', !(await running()));
    const n1 = await c.ev('window.__snd.n');
    await c.ev(hurt); await c.ev("A.gameSound.play('entity.zombie.death', { volume: 1 }).then(() => 1)");
    await sleep(100); // pitfall-ok：声音是异步放出来的，等一小会儿再数响了几下
    check('pause-real', '游戏运行中：受击和死亡声音都不响', (await c.ev('window.__snd.n')) === n1, (await c.ev('window.__snd.n')) - n1);
    const id = await c.ev("([...A.state.games.values()].find((g) => g.state !== 'exited') || {}).id");
    await c.ev(`A.api('games:kill', ${JSON.stringify(id)}).then(() => 1, () => 0)`);
    let over = false;
    for (let i = 0; i < 60 && !over; i++) { over = await c.ev("![...A.state.games.values()].some((g) => g.state !== 'exited')"); await sleep(500); }
    // 2-4：游戏退出后配置卡片的启动次数、游玩时间要更新，不用等别的操作
    let launchesAfter = launchesBefore;
    for (let i = 0; i < 20 && launchesAfter <= launchesBefore; i++) { await sleep(300); launchesAfter = await c.ev("(A.state.installed.find((x) => x.id === '1.20.1') || {}).launchCount || 0"); }
    check('2-4', '游戏退出后配置列表自己更新了', launchesAfter > launchesBefore, { launchesBefore, launchesAfter });
    check('pause-real', '游戏关了', over);
    await until(c.ev, '!!(A.homeScene() && A.homeScene().running)', 5000);
    check('pause-real', '游戏关了：背景接着动', await running());
    const n2 = await c.ev('window.__snd.n');
    await c.ev(hurt);
    await sleep(100); // pitfall-ok：声音是异步放出来的，等一小会儿再数响了几下
    check('pause-real', '游戏关了：声音恢复', (await c.ev('window.__snd.n')) > n2);
    await c.ev(clearToasts);
    // 还原：后面的场景用假配置，选了真 Java 会先问「Java 不合适」，停在确认框上
    await c.ev("A.setConfig({ java: { selected: 'auto' }, afterLaunch: 'keep' }).then(() => 1)");
  },

  /** 7-9：连点两下启动，不弹红色的「正在启动中」（2.0.0-pre3） */
  async 'launch-twice'(c) {
    await c.ev(closeModals);
    await c.ev(clearToasts);
    await c.ev("A.api('accounts:addOffline', 'TwicePlayer').then(() => A.api('accounts:list')).then((l) => { A.state.accounts = l; return 1; }, () => 0)");
    check('7-9', '确认场景成立：测试目录里有一个 Java 8，启动时不用上网下载', await useFakeJava(c));
    const r = await c.ev(`(async () => {
      const id = 'ModP';
      A.launch(id);
      A.launch(id);
      // 第一次启动前要找 Java，可能要等一会儿；等到结果出来
      // 第一次启动前要找 Java（查注册表、查正在运行的 Java），全量回归时机器很忙会超过 30 秒（rc1 全量碰到过一次）：等 60 秒，记下用了多久
      const t0 = Date.now();
      // 这个假配置要 Java 8。rc9 以前测试目录里没有，启动器会先从网上下载约 190 个文件，网慢就超时；
      // rc11 起放一个假的 Java 8（fake-java.js），不碰网络，很快就走到「缺文件」。等 90 秒是给机器很忙的时候留的
      for (let i = 0; i < 360 && !document.querySelector('.toast.crit'); i++) await new Promise((res) => setTimeout(res, 250));
      await new Promise((res) => setTimeout(res, 500));
      // 没等到：把现场带回来（当时有哪些提示、弹窗、任务、游戏记录），不然只知道「等了 60 秒」
      if (!document.querySelector('.toast.crit')) return { waited: Date.now() - t0, page: A.state.page, tasks: [...A.state.tasks.values()].map((t) => t.title + ':' + t.status + ':' + (t.detail || '').slice(0, 40)), toasts: [...document.querySelectorAll('.toast')].map((t) => t.className.replace('toast ', '') + '：' + t.innerText.replace(/\\s+/g, ' ').slice(0, 60)), modals: [...document.querySelectorAll('.modal-back')].map((m) => m.innerText.replace(/\\s+/g, ' ').slice(0, 80)), games: [...A.state.games.values()].map((g) => g.id + ':' + g.versionId + ':' + g.state), accounts: A.state.accounts.accounts.map((x) => x.name) };
      return [...document.querySelectorAll('.toast')].map((t) => t.className.replace('toast ', '') + '：' + t.innerText.replace(/\\s+/g, ' ').slice(0, 80));
    })()`);
    check('7-9', '连点两下启动：不弹红色的「正在启动中」', Array.isArray(r) && !r.some((t) => /正在启动中/.test(t)), r);
    check('7-9', '连点两下启动：第一次的结果照常有提示（这个假配置没有 jar，应该说缺文件）', Array.isArray(r) && r.some((t) => /启动失败.*(缺少|客户端)/.test(t)), r);
    await c.ev(closeModals);
    await c.ev(clearToasts);
    // 弹窗没走正常流程就没了（比如整页重建）：之后还要能启动，不能一直卡着
    await c.ev("A.state.games.set('gy', { id: 'gy', versionId: 'ModP', state: 'running', startedAt: Date.now(), java: {}, memory: {} }); A.launch('ModP'); 1");
    await calm(c.ev);
    await c.ev(closeModals);
    await c.ev("A.state.games.delete('gy'); 1");
    await sleep(1000); // pitfall-ok：启动按钮 0.8 秒内的第二下算连点，要等过去
    await c.ev("A.launch('ModP'); 1");
    let again = [];
    for (let i = 0; i < 120 && !again.length; i++) { await sleep(250); again = await c.ev("[...document.querySelectorAll('.toast.crit')].map((t) => t.innerText.replace(/\\s+/g, ' ').slice(0, 60))"); }
    check('7-9', '确认框被直接拿掉以后：这个配置还能启动', again.some((t) => /启动失败/.test(t)) && !again.some((t) => /正在启动中/.test(t)), again);
    await c.ev(closeModals);
    await c.ev(clearToasts);
  },

  /** 10-2：任务失败只提示一次（2.0.0-pre3）。走的是真实的失败路径，数红色提示 */
  async 'one-notice'(c) {
    await c.ev(closeModals);
    const count = async (label, js, want = 1) => {
      await c.ev(clearToasts);
      const started = await c.ev(`${js}.then((x) => 'ok:' + x, (e) => 'err:' + e.message)`);
      const id = String(started).replace('ok:', '');
      for (let i = 0; i < 60 && await c.ev(`(A.state.tasks.get(${JSON.stringify(id)}) || {}).status === 'running'`); i++) await sleep(500);
      await (want ? until(c.ev, `document.querySelectorAll('.toast.crit').length >= ${want}`, 6000) : sleep(1500)); // pitfall-ok：要 0 条时只能等一会儿，看有没有冒出来
      const list = await c.ev("[...document.querySelectorAll('.toast.crit')].map((t) => t.innerText.replace(/\\s+/g, ' ').slice(0, 70))");
      check('10-2', `${label}：红色提示 ${want} 条`, list.length === want, { list, started: String(started).slice(0, 80) });
    };
    await count('数据导入失败', "A.api('migrate:import', { file: 'C:\\\\不存在的文件.aurora' }, {})");
    await count('组件修改失败', "A.api('components:undo', 'ModP', 123456)");
    await count('安装失败', "A.api('versions:install', { mc: '不存在的版本', name: 'BadInstall' })");
    await count('补全失败', "A.api('versions:complete', '不存在的配置')");
    await count('下载 Mod 失败', "A.api('mods:install', { title: 'BadMod', versionId: 'ModP', projectVersion: { files: [{ filename: 'x.jar', url: 'http://127.0.0.1:1/x.jar', primary: true }] } })");
    await count('整合包失败', "A.api('modpack:installFile', 'C:\\\\不存在的整合包.mrpack', 'BadPack', null)");
    await c.ev(clearToasts);
  },

  /** 主页有房子的场景：四种房子的实际比例，房子不悬空、不埋进地里、旁边没有树（2.0.0-pre1） */
  async 'house-ratio'(c) {
    const SCENE_LIST = ['plains', 'forest', 'desert', 'snowy', 'cherry', 'jungle'];
    const TODAY = WORLD_SEED; // 以前用当天的日期，哪几个种子「地形放不下大房子」跟着日期变（rc9 改成固定）
    const SEEDS = Array.from({ length: 8 }, (_, i) => TODAY + i * 37);
    // 窗口大小（CSS 像素）：最小、默认、1080p、2K、4K
    const SIZES = [[1000, 660], [1200, 762], [1920, 1080], [2560, 1440], [3840, 2160]];
    const N = 200;
    const stats = await c.ev(`(() => {
      const cv = document.createElement('canvas');
      const sc = new A.Scene(cv);
      sc._ro && sc._ro.disconnect();
      const PX = sc.PX;
      const realEmit = A.emit;
      A.emit = () => {};
      sc.paint = () => {}; sc.draw = () => {};
      const realEnsure = A.Scene.prototype.ensureChunks;
      sc.ensureChunks = () => {};
      const out = { PX, B: sc.B, cells: [] };
      for (const scene of ${JSON.stringify(SCENE_LIST)}) {
        for (const seed of ${JSON.stringify(SEEDS)}) {
          for (const [cw, ch] of ${JSON.stringify(SIZES)}) {
            const W = Math.ceil(cw / PX); const H = Math.ceil(ch / PX);
            sc.W = W; sc.H = H; sc.W0 = W; sc.H0 = H;
            sc.seed = seed;
            sc.opts = { ...sc.opts, scene, buildings: true };
            const n = { hut: 0, cottage: 0, twostory: 0, base: 0, none: 0 };
            for (let i = 0; i < ${N}; i++) {
              sc.cam = null;
              sc._houseKind = null; // rc6 起房子样式按世界记住，重建不再重抽；这里要量的是抽的比例，每次都当成新的一局（rc9：rc6 之后这一项一直是坏的，没人跑过）
              sc.build();
              const h = sc.houses && sc.houses[0];
              if (h) n[h.kind]++; else n.none++;
            }
            out.cells.push({ scene, seed, size: cw + 'x' + ch, rows: sc.rows, cols: sc.cols, ...n });
          }
        }
      }
      A.emit = realEmit;
      sc.stop && sc.stop();
      return out;
    })()`);
    if (stats.__err) { check('house', '统计脚本出错', false, stats.__err); return; }
    const pct = (a, b) => Math.round((a / b) * 1000) / 10;
    const sumBy = (cells) => { const t = { hut: 0, cottage: 0, twostory: 0, base: 0, none: 0 }; for (const x of cells) for (const k of Object.keys(t)) t[k] += x[k]; return t; };
    const show = (t) => { const all = Object.values(t).reduce((a, b) => a + b, 0); return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, pct(v, all)])); };
    for (const scene of SCENE_LIST) {
      const cells = stats.cells.filter((x) => x.scene === scene);
      const t = show(sumBy(cells));
      const onlyHut = cells.filter((x) => x.hut === N).length;
      console.log(`  ${scene.padEnd(8)} 小木屋 ${t.hut}% 农舍 ${t.cottage}% 两层 ${t.twostory}% 基地 ${t.base}% 没房子 ${t.none}%；${cells.length} 种组合里 ${onlyHut} 种全是小木屋`);
      for (const [cw, ch] of SIZES) {
        const size = `${cw}x${ch}`;
        const sc = cells.filter((x) => x.size === size);
        const st = show(sumBy(sc));
        console.log(`    ${size.padEnd(10)} 行数 ${String(sc[0].rows).padStart(3)} 小木屋 ${st.hut}% 其他 ${Math.round((100 - st.hut - st.none) * 10) / 10}% 全是小木屋 ${sc.filter((x) => x.hut === N).length}/${sc.length}`);
      }
      // 约定比例：小木屋约一半（50%），其余 50% 是更大的。统计误差 + 少数地形实在放不下，放宽到 40~60%
      check('house', `${scene}：小木屋接近一半`, t.hut >= 40 && t.hut <= 60, t);
      check('house', `${scene}：更大的房子三种都有，比例接近约定`, t.cottage >= 12 && t.twostory >= 10 && t.base >= 10, t);
      check('house', `${scene}：没有哪个种子和窗口大小只出小木屋`, onlyHut === 0, cells.filter((x) => x.hut === N).map((x) => `${x.seed}/${x.size}`));
    }
    // 真实生成（带块、树、洞穴）：房子站得住，旁边没有树
    const land = await c.ev(`(() => {
      const cv = document.createElement('canvas');
      const sc = new A.Scene(cv);
      sc._ro && sc._ro.disconnect();
      const PX = sc.PX;
      const realEmit = A.emit;
      A.emit = () => {};
      sc.paint = () => {}; sc.draw = () => {};
      sc.renderChunk = () => {};
      const bad = { total: 0, none: 0, notFlat: [], floating: [], buried: [], steep: [], tree: [], water: [], kinds: {}, ramps: 0 };
      for (const scene of ${JSON.stringify(SCENE_LIST)}) {
        for (const seed of ${JSON.stringify(SEEDS)}) {
          for (const [cw, ch] of ${JSON.stringify(SIZES)}) {
            const W = Math.ceil(cw / PX); const H = Math.ceil(ch / PX);
            sc.W = W; sc.H = H; sc.W0 = W; sc.H0 = H;
            sc.seed = seed;
            sc.opts = { ...sc.opts, scene, buildings: true };
            for (let i = 0; i < 6; i++) {
              sc.cam = null;
              sc.build();
              const h = sc.houses && sc.houses[0];
              bad.total++;
              if (!h) { bad.none++; continue; }
              bad.kinds[h.kind] = (bad.kinds[h.kind] || 0) + 1;
              const tag = scene + '/' + seed + '/' + cw + '/' + h.kind + '@' + h.col;
              for (let k = 0; k < h.w; k++) {
                const col = h.col + k;
                if (sc.colHeight(col) !== h.ground) { bad.notFlat.push(tag); break; }
              }
              // 悬空：房子脚下要是实心的。埋住：房子占的格子里不能有地（墙两边一格之内也不能比地面高太多）
              for (let k = 0; k < h.w; k++) {
                const col = h.col + k;
                if (!sc.solidAt(col, h.ground) || !sc.solidAt(col, h.ground + 1)) { bad.floating.push(tag); break; }
                let buried = false;
                for (let r = h.ground - 1; r >= h.ground - h.hgt; r--) if (sc.solidAt(col, r)) buried = true;
                if (buried) { bad.buried.push(tag); break; }
              }
              // 房子两边的地面不能是一堵墙，也不能是悬崖：一格之内高差不超过 1
              const left = sc.colHeight(h.col - 1); const right = sc.colHeight(h.col + h.w);
              if (Math.abs(left - h.ground) > 1 || Math.abs(right - h.ground) > 1) bad.steep.push(tag + ':' + (left - h.ground) + ',' + (right - h.ground));
              if (h.ground >= sc.sea - 1) bad.water.push(tag);
              if (sc.trees.some((t) => t.col >= h.col - 3 && t.col <= h.col + h.w + 2)) bad.tree.push(tag);
            }
          }
        }
      }
      A.emit = realEmit;
      return bad;
    })()`);
    if (land.__err) { check('house', '落地检查脚本出错', false, land.__err); return; }
    console.log(`  落地检查 ${land.total} 次：${JSON.stringify(land.kinds)}`);
    check('house', '有房子的场景每次都有房子', land.none === 0, land.none);
    check('house', '房子脚下整排是平的', land.notFlat.length === 0, land.notFlat.slice(0, 5));
    check('house', '房子不悬空（脚下是实心的）', land.floating.length === 0, { n: land.floating.length, eg: land.floating.slice(0, 5) });
    check('house', '房子不埋进地里', land.buried.length === 0, { n: land.buried.length, eg: land.buried.slice(0, 5) });
    check('house', '房子两边没有陡坎', land.steep.length === 0, { n: land.steep.length, eg: land.steep.slice(0, 5) });
    check('house', '房子不在水里', land.water.length === 0, land.water.slice(0, 5));
    check('house', '房子旁边没有树', land.tree.length === 0, { n: land.tree.length, eg: land.tree.slice(0, 5) });
  },

  /** 两个繁体暂时禁用（2.0.0-pre1）：配置里存着繁体的玩家看到简体中文，配置不被改写，选择里没有繁体 */
  async 'lang-disabled'() {
    for (const saved of ['zh-TW', 'zh-HK']) {
      const app = await startApp(`lang-${saved}`, { language: saved });
      try {
        const cfgFile = path.join(app.data, 'config.json');
        const lang = await app.ev('window.I18N.getLang()');
        const loaded = await app.ev('Object.keys(window.I18N_TR || {})');
        check('lang', `配置里存着 ${saved}：按简体中文显示，没有加载繁体语言包`, lang === 'zh-CN' && !loaded.length, { lang, loaded });
        const nav = await app.ev("document.querySelector('#btnLang').textContent");
        check('lang', `配置里存着 ${saved}：顶栏语言按钮显示「简」`, nav === '简', nav);
        await app.ev("document.querySelector('#btnLang').click(); 1");
        await calm(app.ev);
        const menu = await app.ev("[...document.querySelectorAll('.menu .menu-item')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim())");
        check('lang', '顶栏语言菜单只有跟随系统、简体中文、English', menu.length === 3 && menu[0].includes('跟随系统') && menu[1] === '简体中文' && menu[2] === 'English', menu);
        await app.ev("document.body.click(); 1");
        await calm(app.ev);
        await app.ev("A.go('settings')");
        await calm(app.ev);
        const row = await app.ev("(() => { const r = [...document.querySelectorAll('#page-settings .select-btn')].find((b) => /简体中文|English|跟随系统|请选择/.test(b.innerText)); return r ? r.innerText.trim() : ''; })()");
        check('lang', '设置里的语言选择显示简体中文（不是空的）', row === '简体中文', row);
        // 别的设置写盘之后，语言那一项还是原来的
        await app.ev('A.setConfig({ sidebarCollapsed: true }).then(() => 1)');
        await waitFor(() => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')).sidebarCollapsed === true; } catch { return false; } }, 5000);
        const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        check('lang', '没有改写玩家配置里的语言', onDisk.language === saved && onDisk.sidebarCollapsed === true, { language: onDisk.language });
      } finally { await app.stop(); }
    }
  },

  /** 系统语言是繁体（跟随系统）：真实启动，走启动器自己的判断（模拟系统语言，见 locale-hook.js） */
  async 'lang-system'() {
    for (const [locale, want] of [['zh-TW', 'zh-CN'], ['zh-HK', 'zh-CN'], ['zh-MO', 'zh-CN'], ['zh-Hant-TW', 'zh-CN'], ['zh-CN', 'zh-CN'], ['en-US', 'en'], ['ja-JP', 'en']]) {
      const app = await startApp(`sys-${locale}`, { language: 'auto', locale });
      try {
        const r = await app.ev("(async () => ({ lang: window.I18N.getLang(), sys: A.state.info.systemLanguage, tr: Object.keys(window.I18N_TR || {}), nav: document.querySelector('#btnLang').textContent, pref: (await A.api('config:get')).language }))()");
        check('lang', `系统语言 ${locale}：显示 ${want}`, r.lang === want && r.sys === want && !r.tr.some((x) => /zh-(TW|HK)/.test(x)), r);
        check('lang', `系统语言 ${locale}：配置还是跟随系统`, r.pref === 'auto', r.pref);
      } finally { await app.stop(); }
    }
  },

  /** 单个配置的弹窗：Mod、资源包、光影、游戏选项也能带过去（1.10.10）。全程真实点击 */
  async 'bring-items'(c) {
    const J = JSON.stringify;
    const R = c.game;
    const own = (id, ...x) => path.join(c.game, 'versions', id, ...x);
    const has = (f) => fs.existsSync(f);
    const mk = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
    mk(path.join(R, 'mods', 'sodium.jar'), Buffer.alloc(300 * 1024, 1));
    mk(path.join(R, 'config', 'sodium.toml'), 'k=1');
    mk(path.join(R, 'resourcepacks', 'faithful.zip'), Buffer.alloc(100 * 1024, 2));
    mk(path.join(R, 'shaderpacks', 'bsl.zip'), Buffer.alloc(100 * 1024, 3));
    mk(path.join(R, 'options.txt'), 'version:3465\nfov:0.5\n');
    const topText = "(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); return m ? m.innerText.replace(/\\s+/g, ' ') : ''; })()";
    const click = (text) => c.ev(`(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); if (!m) return false; const b = [...m.querySelectorAll('.modal-foot button, .choice')].find((x) => x.innerText.includes(${J(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
    const waitText = async (text, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await c.ev(topText)).includes(text)) return true; await sleep(100); } return false; }; // pitfall-ok：轮询里两次查看之间的间隔
    const isolated = (id) => c.ev(`A.refreshInstalled().then(() => { const v = A.state.installed.find((x) => x.id === ${J(id)}); return !!v.isolated; })`);
    const openEditor = async (id) => { await c.ev(`A.iso.editor(A.state.installed.find((x) => x.id === ${J(id)})); 1`); await calm(c.ev); };
    const closeAll = async () => { await c.ev(closeModals); await c.ev(clearToasts); await calm(c.ev); };
    const rows = "(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); return Object.fromEntries([...m.querySelectorAll('[data-item]')].map((x) => { const i = x.querySelector('input'); return [x.dataset.item, { checked: i.checked, disabled: i.disabled, text: x.innerText.replace(/\\s+/g, ' ') }]; })); })()";
    const toggle = (k) => c.ev(`(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); m.querySelector('[data-item=${k}] input').click(); })()`);
    const ASK = '要把公共目录的内容带过去吗';
    await c.ev('A.refreshInstalled().then(() => 1)');

    // 全部默认
    await openEditor('PubAll');
    await click('保存');
    const asked = await waitText(ASK, 3000);
    const r0 = asked ? await c.ev(rows) : {};
    check('4-1', '公共目录有 Mod 等内容：弹窗里能选，只有真有的项目', asked && J(Object.keys(r0)) === J(['mods', 'resourcepacks', 'shaderpacks', 'options']), asked ? r0 : { 实际: '弹窗没有这些选项', text: (await c.ev(topText)).slice(0, 80), isolated: await isolated('PubAll') });
    if (!asked || !r0.mods) { await closeAll(); for (const n of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt']) fs.rmSync(path.join(R, n), { recursive: true, force: true }); return; }
    check('4-1', '有加载器的配置：四项都默认勾选，写着大小', Object.values(r0).every((x) => x.checked) && /KB|MB/.test(r0.mods.text), r0);
    const t0 = await c.ev(topText);
    check('4-1', 'Mod 有提醒：不一定适合这个版本，可以用一键 Debug', t0.includes('不一定适合') && t0.includes('一键 Debug'), t0.slice(0, 300));
    await click('复制并改成独立');
    let end = Date.now() + 8000;
    while (Date.now() < end && !(await isolated('PubAll'))) await sleep(150);
    await calm(c.ev);
    check('4-1', '全部勾选：都带过去了，公共目录的还在', (await isolated('PubAll')) && has(own('PubAll', 'mods', 'sodium.jar')) && has(own('PubAll', 'config', 'sodium.toml')) && has(own('PubAll', 'resourcepacks', 'faithful.zip')) && has(own('PubAll', 'shaderpacks', 'bsl.zip')) && has(own('PubAll', 'options.txt')) && has(path.join(R, 'mods', 'sodium.jar')) && has(own('PubAll', 'saves', 'PublicTwo')), '');
    const toast = await c.ev("[...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\\s+/g, ' ')).join(' | ')");
    check('4-1', '提示里说带了什么', /Mod/.test(toast) && toast.includes('公共目录'), toast);
    await closeAll();

    // 取消勾选
    await openEditor('PubPart');
    await click('保存');
    await waitText(ASK);
    await toggle('mods');
    await toggle('resourcepacks');
    await calm(c.ev);
    const t1 = await c.ev(topText);
    check('4-1', '不勾 Mod：提醒跟着消失', !t1.includes('不一定适合'), t1.slice(0, 200));
    await click('复制并改成独立');
    end = Date.now() + 8000;
    while (Date.now() < end && !(await isolated('PubPart'))) await sleep(150);
    check('4-1', '不勾的不带：只有光影和游戏选项', (await isolated('PubPart')) && !has(own('PubPart', 'mods', 'sodium.jar')) && !has(own('PubPart', 'resourcepacks')) && has(own('PubPart', 'shaderpacks', 'bsl.zip')) && has(own('PubPart', 'options.txt')), '');
    await closeAll();

    // 世界和内容都不带
    await openEditor('PubBare');
    await click('保存');
    await waitText(ASK);
    await click('不复制');
    for (const k of ['mods', 'resourcepacks', 'shaderpacks', 'options']) await toggle(k);
    await calm(c.ev);
    const t2 = await c.ev(topText);
    check('4-1', '全都不选：按钮变成「改成独立，不复制」', t2.includes('改成独立，不复制'), t2.slice(-40));
    await click('改成独立，不复制');
    end = Date.now() + 5000;
    while (Date.now() < end && !(await isolated('PubBare'))) await sleep(150);
    check('4-1', '全都不选：配置变独立，什么都没带', (await isolated('PubBare')) && !has(own('PubBare', 'mods', 'sodium.jar')) && !has(own('PubBare', 'shaderpacks')), '');
    await closeAll();

    // 纯原版
    await openEditor('PubVan');
    await click('保存');
    await waitText(ASK);
    const r3 = await c.ev(rows);
    check('4-1', '纯原版：不显示 Mod，其他三项默认勾选', !r3.mods && r3.resourcepacks && r3.resourcepacks.checked && r3.shaderpacks.checked && r3.options.checked, r3);
    await closeAll();

    // 空间不够：Mod 里有个比磁盘还大的稀疏文件
    const huge = path.join(R, 'mods', 'huge.jar');
    fs.writeFileSync(huge, '');
    const sp = spawnSync('fsutil', ['sparse', 'setflag', huge], { encoding: 'utf8', windowsHide: true });
    const st = fs.statfsSync(c.game);
    let made = sp.status === 0;
    if (made) { try { fs.truncateSync(huge, Number(st.bavail) * Number(st.bsize) + 5 * 1024 ** 3); } catch { made = false; } }
    if (!made) console.log('  跳过：做不出稀疏文件');
    else {
      await openEditor('PubHuge');
      await click('保存');
      await waitText(ASK);
      const r4 = await c.ev(rows);
      const t4 = await c.ev(topText);
      check('4-1', '空间不够把 Mod 算进去：Mod 不能勾，写明放不下；其他照常', r4.mods && r4.mods.disabled && !r4.mods.checked && r4.shaderpacks.checked && t4.includes('复制并改成独立') && /放不下|不够/.test(r4.mods.text + t4), { r4, t4: t4.slice(0, 200) });
      await click('取消');
      await calm(c.ev);
      check('4-1', '空间不够时取消：什么都没改', !(await isolated('PubHuge')) && !has(own('PubHuge', 'mods', 'sodium.jar')) && !has(own('PubHuge', 'saves.aurora-bring-tmp')), '');
      await closeAll();
    }
    for (const n of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt']) fs.rmSync(path.join(R, n), { recursive: true, force: true });
  },

  /** 全局设置「独立游戏目录」：两个方向都要说清楚（1.10.10）。全程真实点击 */
  async 'bring-global'() {
    const J = JSON.stringify;
    const g = await startApp('global', {
      config: { isolation: 'none', selectedVersion: 'GB' },
      setup: (game) => {
        for (const id of ['GA', 'GB']) fakeVersion(game, id);
        fs.mkdirSync(path.join(game, 'versions', 'GVan'), { recursive: true });
        fs.writeFileSync(path.join(game, 'versions', 'GVan', 'GVan.json'), JSON.stringify({ id: 'GVan', clientVersion: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [] }));
      },
    });
    try {
      const rootSaves = path.join(g.game, 'saves');
      const own = (id, ...x) => path.join(g.game, 'versions', id, ...x);
      const list = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
      const worldsBefore = J(list(rootSaves));
      const topText = "(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); return m ? m.innerText.replace(/\\s+/g, ' ') : ''; })()";
      const foot = (text) => g.ev(`(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); if (!m) return false; const b = [...m.querySelectorAll('.modal-foot button')].find((x) => x.innerText.includes(${J(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
      const seg = (text) => g.ev(`(() => { const b = [...document.querySelectorAll('#page-settings .seg button')].find((x) => x.innerText.trim() === ${J(text)}); if (!b) return false; b.click(); return true; })()`);
      const segOn = "(() => { const b = [...document.querySelectorAll('#page-settings .seg button')].find((x) => x.innerText.trim() === 'Mod 版与快照'); return b ? [...b.parentElement.children].find((x) => x.classList.contains('on')).innerText.trim() : ''; })()";
      const mode = () => g.ev('A.state.config.isolation');
      const waitText = async (text, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await g.ev(topText)).includes(text)) return true; await sleep(100); } return false; }; // pitfall-ok：轮询里两次查看之间的间隔
      const waitMode = async (m, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await mode()) === m) return true; await sleep(100); } return false; }; // pitfall-ok：轮询里两次查看之间的间隔
      const closeAll = async () => { await g.ev(closeModals); await g.ev(clearToasts); await calm(g.ev); };
      const setMode = async (m) => { await g.ev(`A.setConfig({ isolation: ${J(m)} }).then(() => A.refreshInstalled()).then(() => { A.go('home'); A.go('settings'); })`); await calm(g.ev); };
      await g.ev('A.refreshInstalled().then(() => 1)');
      await g.ev("A.go('settings')");
      await calm(g.ev);

      // 不使用 → Mod 版
      await seg('Mod 版与快照');
      const asked = await waitText('这些配置', 2500);
      check('4-1', '改成「Mod 版与快照」：先弹窗列出会搬走的配置', asked, asked ? '' : { 实际: '没有问，直接改了', mode: await mode(), GB自己的存档: list(own('GB', 'saves')) });
      if (!asked) return;
      const t1 = await g.ev(topText);
      check('4-1', '弹窗列出配置和世界数量，纯原版不在里面', t1.includes('GA') && t1.includes('GB') && !t1.includes('GVan') && t1.includes('2 个世界'), t1.slice(0, 260));
      check('4-1', '默认带给当前选中的配置，写清楚其他配置从空开始、世界还能导入', (await g.ev("(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); return m.querySelector('.select-btn').innerText.trim(); })()")) === 'GB' && t1.includes('存档从空开始') && t1.includes('从其他配置导入'), t1);
      // 取消
      await foot('取消');
      await calm(g.ev);
      check('4-1', '取消：设置没改，按钮回到原来的选项', (await mode()) === 'none' && (await g.ev(segOn)) === '不使用' && !list(own('GB', 'saves')).length, { mode: await mode(), on: await g.ev(segOn) });
      // 关闭
      await seg('Mod 版与快照');
      await waitText('这些配置');
      await g.ev("(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); m.querySelector('.modal-head .x').click(); })()");
      await calm(g.ev);
      check('4-1', '右上角关闭：一样设置没改', (await mode()) === 'none' && (await g.ev(segOn)) === '不使用', '');
      // 选配置带
      await seg('Mod 版与快照');
      await waitText('这些配置');
      await foot('复制并改设置');
      const changed = await waitMode('modded');
      await calm(g.ev);
      check('4-1', '选配置带：设置改了，世界只进这一个配置', changed && list(own('GB', 'saves')).join() === list(rootSaves).join() && !list(own('GA', 'saves')).length, { GB: list(own('GB', 'saves')), GA: list(own('GA', 'saves')) });
      check('4-1', '选配置带：公共目录的世界还在，按钮显示新选项，有提示', J(list(rootSaves)) === worldsBefore && (await g.ev(segOn)) === 'Mod 版与快照' && (await g.ev(topText)) === '', await g.ev("[...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\\s+/g, ' ')).join(' | ')"));
      await closeAll();

      // 反方向
      await seg('不使用');
      const back = await waitText('不会删除', 2500);
      const t2 = await g.ev(topText);
      check('4-1', '改回「不使用」：说明配置回公共目录、自己的世界不会删、怎么拿回来', back && t2.includes('GB') && t2.includes('2 个世界') && t2.includes('改回去') && t2.includes('完全独立'), t2);
      await foot('取消');
      await calm(g.ev);
      check('4-1', '反方向取消：设置没改', (await mode()) === 'modded' && (await g.ev(segOn)) === 'Mod 版与快照', '');
      await seg('不使用');
      await waitText('不会删除');
      await foot('改设置');
      const toNone = await waitMode('none');
      check('4-1', '反方向确认：设置改了，自己文件夹里的世界还在', toNone && list(own('GB', 'saves')).length === 2, list(own('GB', 'saves')));
      await closeAll();

      // 都不带
      await seg('Mod 版与快照');
      await waitText('这些配置');
      await g.ev("(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); m.querySelector('.select-btn').click(); })()");
      await calm(g.ev);
      const picked = await g.ev("(() => { const i = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.innerText.includes('都不带')); if (!i) return false; i.click(); return true; })()");
      await calm(g.ev);
      const t3 = await g.ev(topText);
      check('4-1', '选「都不带」：按钮变成「改设置」', picked && !t3.includes('复制并改设置') && t3.includes('改设置'), t3.slice(-40));
      await foot('改设置');
      const toMod = await waitMode('modded');
      check('4-1', '都不带：设置改了，没有配置多出世界', toMod && !list(own('GA', 'saves')).length, list(own('GA', 'saves')));
      await closeAll();

      // 公共目录没有世界
      await setMode('none');
      fs.renameSync(rootSaves, `${rootSaves}.off`);
      await seg('Mod 版与快照');
      const noWorld = await waitText('这些配置');
      const t4 = await g.ev(topText);
      check('4-1', '公共目录没有世界：还是列出配置，但不问带不带', noWorld && !t4.includes('个世界') && (await g.ev("!document.querySelector('.modal-back:not(.closing) .modal .select-btn')")), t4);
      await foot('改设置');
      check('4-1', '公共目录没有世界：确认后设置改了', await waitMode('modded'), '');
      fs.renameSync(`${rootSaves}.off`, rootSaves);
      await closeAll();
    } finally { await g.stop(); }
  },

  /** 4-1 公共目录的配置改成独立：先问带不带世界。全程真实点击 */
  async 'bring-dialog'(c) {
    const J = JSON.stringify;
    const rootSaves = path.join(c.game, 'saves');
    const ownSaves = (id) => path.join(c.game, 'versions', id, 'saves');
    const list = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
    const tmpLeft = (id) => fs.existsSync(path.join(c.game, 'versions', id, 'saves.aurora-bring-tmp'));
    const topText = "(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); return m ? m.innerText.replace(/\\s+/g, ' ') : ''; })()";
    const click = (text) => c.ev(`(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); if (!m) return false; const b = [...m.querySelectorAll('.modal-foot button, .choice')].find((x) => x.innerText.includes(${J(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
    const pressed = "(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); const b = m && m.querySelector('.choice[aria-pressed=true]'); return b ? b.innerText.replace(/\\s+/g, ' ') : ''; })()";
    const waitText = async (text, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await c.ev(topText)).includes(text)) return true; await sleep(100); } return false; }; // pitfall-ok：轮询里两次查看之间的间隔
    const isolated = (id) => c.ev(`A.refreshInstalled().then(() => { const v = A.state.installed.find((x) => x.id === ${J(id)}); return !!v.isolated; })`);
    const openEditor = async (id) => { await c.ev(`A.iso.editor(A.state.installed.find((x) => x.id === ${J(id)})); 1`); await calm(c.ev); };
    const closeAll = async () => { await c.ev(closeModals); await c.ev(clearToasts); await calm(c.ev); };
    const ASK = '公共目录里有';
    const before = J(list(rootSaves));
    await c.ev('A.refreshInstalled().then(() => 1)');

    // 有世界，选复制
    await openEditor('PubCopy');
    await click('保存');
    const asked = await waitText(ASK, 3000);
    check('4-1', '公共目录有世界，点保存：先问带不带世界', asked, asked ? '' : { 实际: '没有问，直接切换了', isolated: await isolated('PubCopy'), 自己的存档: list(ownSaves('PubCopy')), 公共目录: list(rootSaves) });
    if (!asked) { await closeAll(); return; }
    const t1 = await c.ev(topText);
    check('4-1', '弹窗写清楚：世界数量、大小、原来的世界不动', t1.includes('公共目录里有 2 个世界') && /\d+(\.\d+)? (KB|MB)/.test(t1) && t1.includes('原来的世界不动'), t1);
    check('4-1', '弹窗列出世界的名字', t1.includes('公共世界一') && t1.includes('PublicTwo'), t1);
    check('4-1', '默认选「复制过来」', (await c.ev(pressed)).includes('复制过来'), await c.ev(pressed));
    await click('复制并改成独立');
    let end = Date.now() + 8000;
    while (Date.now() < end && !(await isolated('PubCopy'))) await sleep(150);
    await until(c.ev, "!!document.querySelector('.toast')", 5000);
    const toast1 = await c.ev("[...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\\s+/g, ' ')).join(' | ')");
    check('4-1', '选复制：配置变成独立，世界复制过来了，没有 session.lock', (await isolated('PubCopy')) && list(ownSaves('PubCopy')).join() === list(rootSaves).join() && !fs.existsSync(path.join(ownSaves('PubCopy'), 'PublicTwo', 'session.lock')), list(ownSaves('PubCopy')));
    check('4-1', '选复制：公共目录的世界还在，对话框关了，提示复制了几个', J(list(rootSaves)) === before && fs.existsSync(path.join(rootSaves, 'PublicTwo', 'session.lock')) && (await c.ev(topText)) === '' && toast1.includes('复制了 2 个世界'), toast1);
    await closeAll();

    // 有世界，选不复制
    await openEditor('PubNo');
    await click('保存');
    await waitText(ASK);
    await click('不复制');
    await calm(c.ev);
    check('4-1', '选「不复制」：按钮跟着变', (await c.ev(pressed)).includes('不复制') && (await c.ev(topText)).includes('改成独立，不复制'), await c.ev(pressed));
    await click('改成独立，不复制');
    end = Date.now() + 5000;
    while (Date.now() < end && !(await isolated('PubNo'))) await sleep(150);
    check('4-1', '选不复制：配置变成独立，存档是空的，公共目录的世界还在', (await isolated('PubNo')) && !list(ownSaves('PubNo')).length && J(list(rootSaves)) === before, list(ownSaves('PubNo')));
    await closeAll();

    // 取消和关闭
    await openEditor('PubCancel');
    await click('保存');
    await waitText(ASK);
    await click('取消');
    await calm(c.ev);
    const afterCancel = await c.ev(topText);
    check('4-1', '点取消：回到上一个对话框，什么都没改', afterCancel.includes('完全独立') && !afterCancel.includes(ASK) && !(await isolated('PubCancel')) && !list(ownSaves('PubCancel')).length && !tmpLeft('PubCancel'), afterCancel.slice(0, 80));
    await click('保存');
    await waitText(ASK);
    await c.ev("(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); m.querySelector('.modal-head .x').click(); })()");
    await calm(c.ev);
    check('4-1', '点右上角关闭：一样什么都没改', !(await c.ev(topText)).includes(ASK) && !(await isolated('PubCancel')), '');
    await closeAll();

    // 公共目录没有世界
    fs.renameSync(rootSaves, `${rootSaves}.off`);
    await openEditor('PubEmpty');
    await click('保存');
    end = Date.now() + 5000;
    while (Date.now() < end && !(await isolated('PubEmpty'))) await sleep(150);
    check('4-1', '公共目录没有世界：不问，直接切换', (await isolated('PubEmpty')) && (await c.ev(topText)) === '', await c.ev(topText));
    fs.renameSync(`${rootSaves}.off`, rootSaves);
    await closeAll();

    // 复制途中取消
    const big = path.join(rootSaves, 'BigWorld');
    fs.mkdirSync(path.join(big, 'region'), { recursive: true });
    fs.writeFileSync(path.join(big, 'level.dat'), 'x');
    const blob = Buffer.alloc(32 * 1024, 3);
    for (let i = 0; i < 4000; i++) fs.writeFileSync(path.join(big, 'region', `r.${i}.0.mca`), blob);
    await openEditor('PubStop');
    await click('保存');
    await waitText(ASK);
    await click('复制并改成独立');
    const showing = await waitText('正在复制', 3000);
    const during = await c.ev(topText);
    check('4-1', '复制时对话框写清楚取消的后果', showing && during.includes('什么都不会改'), during);
    const moving = await waitText('复制世界：', 5000);
    const progress = await c.ev("(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); const b = m && m.querySelector('.progress'); return b ? { indeterminate: b.classList.contains('indeterminate'), width: b.firstChild.style.width } : null; })()");
    check('4-1', '复制时显示在复制哪个世界，进度条在走', moving && progress && !progress.indeterminate, { progress, text: (await c.ev(topText)).slice(40, 120) });
    const stopped = await click('取消复制');
    const backAsk = await waitText('已取消', 15000);
    const afterStop = await c.ev(topText);
    check('4-1', '复制途中取消：告诉玩家什么都没改，还在公共目录', stopped && backAsk && afterStop.includes('还在公共目录'), afterStop.slice(0, 120));
    check('4-1', '复制途中取消：不留半个世界，隔离状态没变', !(await isolated('PubStop')) && !list(ownSaves('PubStop')).length && !tmpLeft('PubStop'), { own: list(ownSaves('PubStop')), tmp: tmpLeft('PubStop') });
    await closeAll();
    fs.rmSync(big, { recursive: true, force: true });

    // 空间不够：真的做一个比磁盘剩余空间还大的稀疏文件（只占名义大小）
    const huge = path.join(rootSaves, 'HugeWorld');
    fs.mkdirSync(huge, { recursive: true });
    fs.writeFileSync(path.join(huge, 'level.dat'), 'x');
    const hugeFile = path.join(huge, 'huge.bin');
    fs.writeFileSync(hugeFile, '');
    const sp = spawnSync('fsutil', ['sparse', 'setflag', hugeFile], { encoding: 'utf8', windowsHide: true });
    const free = fs.statfsSync(c.game); const freeBytes = Number(free.bavail) * Number(free.bsize);
    let madeHuge = sp.status === 0;
    if (madeHuge) { try { fs.truncateSync(hugeFile, freeBytes + 5 * 1024 ** 3); } catch { madeHuge = false; } }
    if (!madeHuge) console.log('  跳过：做不出稀疏文件，空间不够只在后端场景验证');
    else {
      await openEditor('PubSpace');
      await click('保存');
      await waitText(ASK);
      const t2 = await c.ev(topText);
      const copyDisabled = await c.ev("(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); const b = [...m.querySelectorAll('.choice')].find((x) => x.innerText.includes('复制过来')); return !!(b && b.disabled); })()");
      check('4-1', '空间不够：提前说，不能选复制，默认「不复制」', t2.includes('磁盘空间不够') && copyDisabled && (await c.ev(pressed)).includes('不复制'), t2.slice(0, 200));
      await click('取消');
      await calm(c.ev);
      check('4-1', '空间不够时取消：什么都没改', !(await isolated('PubSpace')) && !list(ownSaves('PubSpace')).length && !tmpLeft('PubSpace'), '');
      await closeAll();
    }
    fs.rmSync(huge, { recursive: true, force: true });
  },

  /** 5-4 真实打开两个对话框：快照和正式版之间恢复备份、导入世界，版本警告要对 */
  async 'mc-dialogs'(c) {
    const modalText = "(() => { const m = [...document.querySelectorAll('.modal-back:not(.closing) .modal')].pop(); return m ? m.innerText.replace(/\\s+/g, ' ') : ''; })()";
    const closeAll = async () => { await c.ev(closeModals); await calm(c.ev); };
    const refresh = () => c.ev('A.refreshInstalled().then(() => 1)');
    const openRestore = async (id) => {
      await c.ev(`A.savesManager(A.state.installed.find((v) => v.id === ${JSON.stringify(id)}), { tab: 'backups' }); 1`);
      for (let i = 0; i < 40; i++) { if (await c.ev("!!document.querySelector('.sv-acts button')")) break; await sleep(150); }
      await c.ev("document.querySelector('.sv-acts button').click(); 1");
      await calm(c.ev);
      return c.ev(modalText);
    };
    await refresh();
    // 导入世界：来源是快照，目标是正式版
    await c.ev("A.importWorlds(A.state.installed.find((v) => v.id === 'RelP')); 1");
    await calm(c.ev);
    const imp = await c.ev(modalText);
    check('5-4', '从快照配置导入世界到正式版：提示来自更新的版本', imp.includes('这些世界来自更新的 Minecraft 24w14a'), imp.slice(0, 160));
    await closeAll();
    // 导入世界：来源是正式版，目标是快照
    await c.ev("A.importWorlds(A.state.installed.find((v) => v.id === 'SnapP')); 1");
    await calm(c.ev);
    const imp2 = await c.ev(modalText);
    check('5-4', '从正式版导入世界到快照配置：提示会升级格式', imp2.includes('在这里玩会升级成 24w14a'), imp2.slice(0, 160));
    await closeAll();
    // 恢复备份：备份来自快照，配置现在是正式版
    const b1 = await c.ev("A.api('backup:create', 'SnapP', { type: 'saves' }).then(() => 'ok', (e) => e.message)");
    setMc(c.game, 'SnapP', '1.20.1');
    await refresh();
    const r1 = await openRestore('SnapP');
    check('5-4', '快照的备份恢复到正式版：警告备份来自更新的版本', b1 === 'ok' && r1.includes('备份来自更新的 Minecraft 版本'), { backup: b1, text: r1.slice(0, 160) });
    await closeAll();
    // 恢复备份：备份来自正式版，配置现在是快照
    const b2 = await c.ev("A.api('backup:create', 'SnapP', { type: 'saves' }).then(() => 'ok', (e) => e.message)");
    setMc(c.game, 'SnapP', '24w14a');
    await refresh();
    const r2 = await openRestore('SnapP');
    check('5-4', '正式版的备份恢复到快照：提示存档会被升级', b2 === 'ok' && r2.includes('存档会被升级'), { backup: b2, text: r2.slice(0, 160) });
    await closeAll();
  },

  /** 2-1 状态刷新：Mod 数量 */
  async counts(c) {
    const mods = () => c.ev("(A.state.installed.find((v) => v.id === 'ModP') || {}).mods");
    const before = await mods();
    check('2-1', '确认场景成立：一开始 3 个启用', before && before.enabled === 3, before);
    const p = await c.ev("A.api('mods:list', 'ModP').then((r) => r.mods[0].path)");
    // 刷新是防抖后再读所有配置，磁盘忙的时候要久一点：等到变了为止，记下用了多久
    const waitFor = async (n) => { const t0 = Date.now(); let m = await mods(); while (!(m && m.enabled === n) && Date.now() - t0 < 5000) { await sleep(100); m = await mods(); } return { ...m, ms: Date.now() - t0 }; }; // pitfall-ok：轮询里两次查看之间的间隔
    await c.ev(`A.api('mods:toggle', ${JSON.stringify(p)}, false)`);
    let now = await waitFor(2);
    check('2-1', '禁用一个 Mod：配置卡片的数字跟着变', now && now.enabled === 2, now);
    await c.ev(`A.api('mods:toggle', ${JSON.stringify(`${p}.disabled`)}, true)`);
    now = await waitFor(3);
    check('2-1', '再启用回来：数字跟着变', now && now.enabled === 3, now);
  },

  /** 2-2 主进程改了设置，界面要知道 */
  async config(c) {
    const fake = 'C:\\nope\\bin\\java.exe';
    await c.ev(`A.setConfig({ java: { selected: ${JSON.stringify(fake)}, extra: [${JSON.stringify(fake)}] } })`);
    await c.ev(`A.api('java:remove', ${JSON.stringify(fake)})`);
    await calm(c.ev);
    const main = await c.ev("A.api('config:get').then((x) => x.java.selected)");
    const ui = await c.ev('A.state.config.java.selected');
    check('2-2', '移除默认的 Java：界面的状态跟主进程一致', main === 'auto' && ui === 'auto', { main, ui });
    await c.ev("A.go('java')");
    await calm(c.ev);
    check('2-2', 'Java 页标着「当前默认」', await c.ev("!!document.querySelector('#page-java .java-card.default')"));
    await c.ev("A.go('home')");
  },

  /** 13-1 快速切换配置，慢的结果不能盖掉 */
  async 'mods-race'(c) {
    await c.ev("A.go('mods')");
    await calm(c.ev);
    await c.ev("A.pages.mods.show({ versionId: 'Slow' }); A.pages.mods.show({ versionId: 'Empty' }); 1");
    await sleep(6000); // pitfall-ok：等故意慢的那个配置的列表读完（它慢 5 秒），看它会不会回头盖掉现在这个
    await c.ev(`(() => { const i = document.querySelector('#page-mods input.input'); i.value = ' '; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await calm(c.ev);
    await c.ev(`(() => { const i = document.querySelector('#page-mods input.input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await calm(c.ev);
    const text = await c.ev("document.querySelector('#page-mods').innerText.includes('slow-1.jar') || document.querySelector('#page-mods').innerText.includes('slow-1')");
    check('13-1', '切到空配置后再筛选：不会显示另一个配置的 Mod', text === false, { showsSlow: text });
    await c.ev("A.go('home')");
  },

  /** 6-5 游戏开着时，别的启动入口也要问 */
  async 'launch-again'(c) {
    await sleep(900); // 上一个场景刚点过启动，0.8 秒内的第二下会被当成连点 // pitfall-ok：0.8 秒内的第二下算连点，要等过去
    await c.ev("A.api('accounts:addOffline', 'UiPlayer').then(() => A.refreshAccounts())");
    await calm(c.ev);
    await c.ev(`${clearToasts}; ${closeModals}; A.state.games.set('gx', { id: 'gx', versionId: 'ModP', state: 'running', startedAt: Date.now(), java: {}, memory: {} }); A.launch('ModP'); 1`);
    await calm(c.ev);
    const asked = await c.ev("(() => { const m = document.querySelector('.modal-back:not(.closing)'); return m ? m.innerText : ''; })()");
    check('6-5', '游戏开着再点启动：先问要不要再开一个', /再启动|已经开着/.test(asked), String(asked).slice(0, 60));
    await c.ev("(() => { const m = document.querySelector('.modal-back:not(.closing)'); if (!m) return; const b = [...m.querySelectorAll('button')].find((x) => /取消/.test(x.innerText)); if (b) b.click(); })()");
    await sleep(900); // pitfall-ok：要证明没有弹出「启动失败」，只能等一会儿看
    const failed = await c.ev("[...document.querySelectorAll('.toast')].some((t) => /启动失败/.test(t.innerText))");
    check('6-5', '选取消：不会启动', !failed, { startedAndFailed: failed });
    await c.ev(`${clearToasts}; ${closeModals}; A.launch('ModP', { again: true }); 1`);
    await sleep(900); // pitfall-ok：要证明没有再问一次，只能等一会儿看
    const asked2 = await c.ev("!!document.querySelector('.modal-back:not(.closing)')");
    check('6-5', '主页菜单里选了「再启动一个实例」：不再多问一次', !asked2, { asked: asked2 });
    await until(c.ev, "![...A.state.tasks.values()].some((t) => t.status === 'running')", 15000);
    await c.ev(`${clearToasts}; ${closeModals}; A.state.games.delete('gx'); A.emit('games'); 1`);
  },

  /** 3-7 安装完成的提示 */
  async 'installed-toast'(c) {
    const count = (t) => c.ev(`[...document.querySelectorAll('.toast:not(.out)')].filter((x) => x.innerText.includes(${JSON.stringify(t)})).length`);
    const has = await c.ev('typeof A.installedNotice');
    if (has !== 'function') { check('3-7', '测试入口 A.installedNotice 存在', false, has); return; }
    await c.ev(clearToasts);
    // 没有账户时启动会先跳去账户页，走不到收起提示那一步；前面的场景刚点过启动时要等过防连点的 0.8 秒
    await c.ev("A.api('accounts:addOffline', 'ToastPlayer').then(() => A.refreshAccounts()).then(() => 1, () => 0)");
    await calm(c.ev);
    // 文字要不一样：一模一样的提示现在不叠了（2.0.0-pre7）
    await c.ev("A.installedNotice({ version: 'ModP', level: 'ok', title: '测试通知甲', text: 'x' })");
    await c.ev("A.installedNotice({ version: 'ModP', level: 'ok', title: '测试通知甲', text: 'y' })");
    check('3-7', '确认场景成立：同一个配置两条提示', (await count('测试通知甲')) === 2, await count('测试通知甲'));
    await c.ev("A.launch('ModP'); 1");
    await until(c.ev, "![...document.querySelectorAll('.toast:not(.out)')].some((x) => x.innerText.includes('测试通知甲'))", 6000);
    check('3-7', '开始启动：两条都收起（修之前只收得掉最后一条）', (await count('测试通知甲')) === 0, await count('测试通知甲'));
    await c.ev(`${clearToasts}; ${closeModals}`);
    await c.ev("A.installedNotice({ version: 'ToDelete', level: 'ok', title: '测试通知乙', text: 'x' })");
    await c.ev("A.api('versions:remove', 'ToDelete', { permanent: true })");
    await until(c.ev, "![...document.querySelectorAll('.toast:not(.out)')].some((x) => x.innerText.includes('测试通知乙'))", 6000);
    check('3-7', '配置删掉了：「立即启动」的提示跟着收起', (await count('测试通知乙')) === 0, await count('测试通知乙'));
    await c.ev("A.installedNotice({ version: 'Empty', level: 'ok', title: '测试通知丙', text: 'x', component: { id: 'Empty', ts: 1 } })");
    await c.ev("A.installedNotice({ version: 'Empty', level: 'ok', title: '测试通知丁', text: 'x', component: { id: 'Empty', ts: 2 } })");
    check('3-7', '又改了一次组件：旧提示上的「撤销」不再留着', (await count('测试通知丙')) === 0 && (await count('测试通知丁')) === 1, { old: await count('测试通知丙'), now: await count('测试通知丁') });
    await c.ev(clearToasts);
  },

  /** 9-1、9-2、9-3 运行时拼出来的句子：英文界面不残留中文；5-4 界面用的是统一的版本比较 */
  async translate(c) {
    const r54 = await c.ev("A.cmpMc ? [A.cmpMc('24w14a', '1.20.1'), A.cmpMc('1.20.1', '24w14a'), A.cmpMc('1.21-pre1', '1.20.1'), A.cmpMc('1.20.1', '1.20.1')] : null");
    check('5-4', '界面上的版本比较可用，快照比正式版新', JSON.stringify(r54) === '[1,-1,1,0]', r54);
    const samples = require('./tr-samples');
    const en = await startApp('en', { language: 'en' });
    try {
      const out = await en.ev(`(${JSON.stringify(samples.map((x) => x[1]))}).map((s) => window.I18N_TRANSLATE.tr(s))`);
      let bad = 0;
      samples.forEach(([id, src, ...want], i) => {
        const got = out[i];
        const miss = want.filter((w) => !got.includes(w));
        const ok = !/[一-鿿]/.test(got) && !/[、；：（）]/.test(got) && !miss.length;
        if (!ok) bad++;
        check(id, `英文：${src.replace(/\n/g, ' ').slice(0, 40)}`, ok, got);
      });
      console.log(`  英文 ${samples.length} 句，有问题 ${bad} 句`);
      // 真实的通知：字典和 DOM 翻译连起来也是对的（不是只调函数）
      await en.ev("A.toast({ level: 'ok', title: '配置已修改', text: '1.20.1 Fabric：新增 2 个，禁用 1 个，重新启用 1 个，自动补齐前置：Fabric API、Mod Menu；未能找到：C、D' })");
      await calm(en.ev);
      const toast = await en.ev("(() => { const t = [...document.querySelectorAll('#toastRoot *')].map((x) => x.innerText).find((x) => x && x.includes('Fabric API')); return t || ''; })()");
      check('9-2', '英文界面弹出的通知：整句都是英文', toast.includes('2 added') && !/[一-鿿]/.test(toast), toast);
    } finally { await en.stop(); }
  },

  /** 1-1 配置器真实安装：进度更新时取消按钮不能一直被换掉 */
  async 'planner-progress'(c) {
    if (!SRC) { console.log('  跳过：没设 AURORA_REGRESS_GAME_SRC'); return; }
    await c.ev("A.go('planner')");
    await calm(c.ev);
    const click = (text) => c.ev(`(() => { const b = [...document.querySelectorAll('#page-planner button, #page-planner .vchip')].find((x) => x.offsetParent && x.innerText.includes(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
    // 等按钮出现再点（生成清单要联网），texts 里哪个先出现点哪个
    const waitClick = async (texts, ms = 90000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        for (const x of texts) if (await click(x)) return x;
        await sleep(300); // pitfall-ok：轮询里两次查看之间的间隔
      }
      return false;
    };
    const chip = await waitClick(['1.20.1'], 15000);
    await calm(c.ev);
    const next1 = await waitClick(['下一步（手动挑选）', '生成 Mod 清单'], 15000);
    await calm(c.ev);
    const next2 = await waitClick(['下一步：下载安装']);
    await calm(c.ev);
    check('1-1', '确认场景成立：走到了安装那一步', chip && next1 && next2, { chip, next1, next2 });
    await c.ev(`(() => { window.__btns = new Set(); window.__bars = new Set(); window.__texts = new Set(); window.__n = 0; window.__t = setInterval(() => { const b = document.querySelector('.install-progress button'); const i = document.querySelector('.install-progress .progress'); const p = document.querySelector('.install-progress'); if (b) { window.__btns.add(b); window.__n++; } if (i) window.__bars.add(i); if (p) window.__texts.add(p.innerText); }, 40); })()`);
    const started = await click('跳过启动测试');
    check('1-1', '开始安装', started, '');
    let status = '';
    for (let i = 0; i < 300; i++) {
      status = await c.ev("(() => { const t = [...A.state.tasks.values()].filter((x) => x.kind === 'install').pop(); return t ? t.status : ''; })()");
      if (status && status !== 'running') break;
      await sleep(500); // pitfall-ok：轮询里两次查看之间的间隔
    }
    const r = await c.ev("({ buttons: window.__btns.size, bars: window.__bars.size, samples: window.__n, texts: window.__texts.size })");
    await c.ev('clearInterval(window.__t)');
    await c.ev("(() => { for (const t of A.state.tasks.values()) if (t.kind === 'install' && t.status === 'running') A.api('tasks:cancel', t.id); })()").catch(() => {});
    // 真实安装可能比这里等的时间长，窗口在后台时采样也会降到每秒一次：只看进度文字确实变过
    check('1-1', '确认场景成立：采样期间进度确实刷新过', r.texts >= 3, { status, samples: r.samples, texts: r.texts });
    check('1-1', '安装过程中取消按钮和进度条一直是同一个元素', r.samples > 3 && r.buttons === 1 && r.bars === 1, r);
  },
};

(async () => {
  const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENARIOS);
  const needGame = only.includes('planner-progress') || only.includes('game-pause-real');
  const app = await startApp('main', { withGame: needGame });
  try {
    for (const name of only) {
      if (!SCENARIOS[name]) continue;
      try { await SCENARIOS[name](app); } catch (e) { check(name, '脚本运行出错', false, e.stack || String(e)); }
    }
  } finally { await app.stop(); }
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
