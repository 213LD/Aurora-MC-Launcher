'use strict';
/**
 * 「功能错」这批问题的回归（不需要真实启动游戏，用 run.js 跑；单独跑：electron scripts/regress/func-errors.js <场景>）。
 * 编号是修这些问题时用的条目号。修之前修之后都能跑，方便对比。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { app } = require('electron');
const H = require('./harness');

const { sleep, waitFor, setup, core, ipc, lockFile, fakeVersion, tree, check, finish } = H;
const refuse = (r) => !r.ok;

/** 手工做一个 zip（可以指定文件名的原始字节和标记位，ZipWriter 总是写 UTF-8 标记） */
function makeZip(names) {
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = []; const cd = []; let off = 0;
  for (const { raw, flags } of names) {
    const body = Buffer.from('hello');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt32LE(crc(body), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(raw.length, 26);
    parts.push(lh, raw, body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt32LE(crc(body), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(body.length, 24); c.writeUInt16LE(raw.length, 28); c.writeUInt32LE(off, 42);
    cd.push(c, raw);
    off += lh.length + raw.length + body.length;
  }
  const cdb = Buffer.concat(cd);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(names.length, 8); e.writeUInt16LE(names.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, e]);
}

/** 造一个文件很多的世界：复制要花点时间，才来得及取消 */
async function bigWorld(dir, files = 1500) {
  await fsp.mkdir(path.join(dir, 'region'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'level.dat'), 'world');
  const blob = crypto.randomBytes(16 * 1024);
  await Promise.all(Array.from({ length: files }, (_, i) => fsp.writeFile(path.join(dir, 'region', `r.${i}.0.mca`), blob)));
}

/** 等一个运行中的任务出现，取消它，返回结果和用时 */
async function cancelSoon(promise, match, tasks, delay = 40) {
  const t0 = Date.now();
  let cancelled = false;
  for (let i = 0; i < 200 && !cancelled; i++) {
    const t = tasks.list().find((x) => x.status === 'running' && match(x));
    if (t) { await sleep(delay); tasks.cancel(t.id); cancelled = true; break; }
    await sleep(10); // pitfall-ok：轮询里两次查看之间的间隔
  }
  const res = await promise;
  return { res, ms: Date.now() - t0, sent: cancelled };
}

const SCENARIOS = {
  // ── 两个繁体暂时禁用（2.0.0-pre1）──
  async 'lang-list'() {
    setup('lang-list');
    const i18n = require(path.join(H.REPO, 'src', 'shared', 'i18n'));
    const ids = i18n.LANGS.map((l) => l.id);
    check('lang', '语言列表只有简体中文和英语', ids.join() === 'zh-CN,en', ids);
    const table = [
      ['auto', 'zh-TW', 'zh-CN'], ['auto', 'zh-HK', 'zh-CN'], ['auto', 'zh-MO', 'zh-CN'], ['auto', 'zh-Hant', 'zh-CN'], ['auto', 'zh-Hant-TW', 'zh-CN'],
      ['auto', 'zh-CN', 'zh-CN'], ['auto', 'zh-SG', 'zh-CN'], ['auto', 'zh', 'zh-CN'], ['auto', 'en-US', 'en'], ['auto', 'ja-JP', 'en'], ['auto', '', 'en'],
      ['zh-TW', 'en-US', 'zh-CN'], ['zh-HK', 'zh-HK', 'zh-CN'], ['zh-CN', 'en-US', 'zh-CN'], ['en', 'zh-CN', 'en'],
    ];
    const wrong = table.filter(([pref, sys, want]) => i18n.resolve(pref, sys) !== want).map(([pref, sys, want]) => `${pref}/${sys}: ${i18n.resolve(pref, sys)}，应该 ${want}`);
    check('lang', '系统语言是繁体、配置里存着繁体：都按简体中文', wrong.length === 0, wrong);
    check('lang', '直接设成繁体也回到简体中文', i18n.setLang('zh-TW') === 'zh-CN' && i18n.setLang('zh-HK') === 'zh-CN');
    i18n.setLang('zh-CN');
    if (require('./editions').privateRepo) check('lang', '语言文件这个阶段还留在原处', fs.existsSync(path.join(H.REPO, 'src', 'shared', 'i18n', 'tr-zh-TW.js')) && fs.existsSync(path.join(H.REPO, 'src', 'shared', 'i18n', 'tr-zh-HK.js')));
  },

  // ── 打开文件、文件夹、网页的接口：系统打开能运行的文件就是运行它 ──
  async 'shell-guard'() {
    const { root } = setup('shell-guard');
    const { shell } = require('electron');
    const calls = [];
    shell.openPath = async (p) => { calls.push(['open', p]); return ''; };
    shell.showItemInFolder = (p) => { calls.push(['show', p]); };
    shell.openExternal = async (u) => { calls.push(['url', u]); };
    const bus = ipc();
    const mk = (n) => { const f = path.join(root, n); fs.writeFileSync(f, 'x'); return f; };
    const runnable = ['a.vbs', 'a.VBS', 'a.chm', 'a.scf', 'a.exe', 'a.exe. ', 'a.settingcontent-ms'].map(mk);
    const ads = `${mk('note.txt')}:evil.exe`;
    const refused = [];
    for (const p of [...runnable, ads, 42, '']) if ((await bus.call('shell:open', p)).ok) refused.push(String(p));
    const okOpen = await bus.call('shell:open', root);
    check('shell', '打开文件：能直接运行的（.vbs .chm .scf .exe…）和带备用数据流的（a.txt:b.exe）都不打开；普通文件夹照常打开', refused.length === 0 && okOpen.ok && calls.filter((c) => c[0] === 'open').length === 1, { opened: refused, calls });
    const badShow = [];
    for (const p of [42, 'relative/x', '']) if ((await bus.call('shell:showItem', p)).ok) badShow.push(String(p));
    const okShow = await bus.call('shell:showItem', path.join(root, 'note.txt'));
    check('shell', '在文件夹里显示：不是绝对路径的不收', badShow.length === 0 && okShow.ok, { accepted: badShow });
    const badUrl = [];
    for (const u of ['javascript:alert(1)', 'file:///C:/Windows/system32/calc.exe', 'ms-settings:', 'https//x', 42]) if ((await bus.call('shell:external', u)).ok) badUrl.push(String(u));
    const okUrl = await bus.call('shell:external', 'https://example.com/a b');
    const sent = calls.filter((c) => c[0] === 'url').map((c) => c[1]);
    check('shell', '打开网页：只收 http / https，交给系统的是规范化以后的网址', badUrl.length === 0 && okUrl.ok && sent.length === 1 && sent[0] === 'https://example.com/a%20b', { accepted: badUrl, sent });
    // 同意免责声明：只认现在这一版；扫描皮肤文件夹：只收绝对路径
    const ver = require(path.join(H.REPO, 'src', 'main', 'disclaimer')).VERSION;
    const oldVer = await bus.call('app:acceptDisclaimer', '0.1');
    const cur = await bus.call('app:acceptDisclaimer', ver);
    check('shell', '同意免责声明：传来的不是现在这一版就不记', !oldVer.ok && cur.ok && core('config').get().disclaimerAccepted === ver, { oldVer, cur });
    const rel = await bus.call('skins:scanFolder', 'relative/dir');
    const abs = await bus.call('skins:scanFolder', root);
    check('shell', '扫描皮肤文件夹：相对路径不收，绝对路径照常扫', !rel.ok && abs.ok, { rel, abs: abs.ok });
  },

  // ── 加载器安装器（Java 进程）卡住：一直不出声就结束它，不让安装任务永远转圈；一直在打印的照常等它装完 ──
  async 'installer-stall'() {
    setup('installer-stall');
    const loaders = core('loaders');
    const node = process.env.AURORA_NODE || 'node';
    const task = () => ({ update() {}, signal: new AbortController().signal });
    const t0 = Date.now();
    const quiet = await loaders.runJava(node, ['-e', 'setTimeout(() => {}, 60000)'], process.cwd(), task(), { idleMs: 1500 }).then(() => 'resolved', (e) => e.message);
    const secs = (Date.now() - t0) / 1000;
    check('installer', `一直不出声的安装器：到时间就结束，说清楚是卡住了（${secs.toFixed(1)} 秒）`, /没有任何动静/.test(quiet) && secs < 10, quiet);
    const chatty = await loaders.runJava(node, ['-e', 'let n = 0; const t = setInterval(() => { console.log("step " + n); if (++n > 5) { clearInterval(t); } }, 500);'], process.cwd(), task(), { idleMs: 1500 }).then((tail) => tail, (e) => `出错：${e.message}`);
    check('installer', '一直在打印的安装器：比卡死的时限跑得久也照常装完', Array.isArray(chatty) && chatty.includes('step 5'), chatty);
  },

  // ── Mod 配置器按方案新建配置：装到一半失败就整个删掉，不留半个配置；装进已有配置失败时不删它 ──
  async 'planner-fail'() {
    setup('planner-fail');
    const loaders = core('loaders');
    const planner = core('planner');
    const versions = core('versions');
    const real = { list: loaders.list, install: loaders.install };
    loaders.list = async () => [{ version: '0.15.0', recommended: true }];
    loaders.install = async ({ name }) => { await fakeVersion(name, { extra: { clientVersion: '1.20.1' } }); };
    const bad = { status: 'ok', projectId: 'p', title: 'X', version: { id: 'v', file: { url: 'https://127.0.0.1:1/x.jar', filename: '..\\..\\escape.jar', sha1: '0'.repeat(40), size: 1 } } };
    const plan = { id: 'pl', name: 'Plan', mc: '1.20.1', loader: 'fabric', items: [] };
    const task = { update() {}, signal: new AbortController().signal };
    try {
      const e1 = await planner.install({ plan, resolved: { items: [bad] }, target: { mode: 'new', name: 'HalfPlan' } }, task).then(() => null, (e) => e.message);
      check('planner', '按方案新建配置，下载失败：报错，半个配置删掉了', !!e1 && !fs.existsSync(versions.versionDir('HalfPlan')), { e1: e1 && e1.slice(0, 80), left: fs.existsSync(versions.versionDir('HalfPlan')) });
      await fakeVersion('Keep', { extra: { clientVersion: '1.20.1' }, loader: { type: 'fabric' } });
      const info = await versions.versionInfo('Keep');
      const e2 = info && info.loader ? await planner.install({ plan, resolved: { items: [bad] }, target: { mode: 'existing', versionId: 'Keep' } }, task).then(() => null, (e) => e.message) : 'skip';
      check('planner', '装进已有的配置失败：这个配置不删', fs.existsSync(versions.versionDir('Keep')), { e2: e2 && String(e2).slice(0, 80) });
    } finally { Object.assign(loaders, real); }
  },

  // ── 网络：限了大小的下载边读边数，超了就停；已经取消的请求不再发 ──
  async 'net-caps'() {
    setup('net-caps');
    const net = core('net');
    const skins = core('skins');
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 7);
    const srv = http.createServer((req, res) => {
      if (req.url === '/small') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': 100 }); res.end(Buffer.alloc(100, 1)); return; }
      if (req.url === '/declared') { res.writeHead(200, { 'content-length': 50 * 1024 * 1024 }); res.write(chunk); return; } // 说了 50 MB，只发一块就不动了
      // 不报长度、一直往下发（最多 40 MB）
      res.writeHead(200, { 'content-type': 'image/png' });
      let i = 0;
      const pump = () => { if (res.destroyed || i++ > 640) { res.end(); return; } sent += chunk.length; res.write(chunk, () => setImmediate(pump)); };
      pump();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = (p) => `http://127.0.0.1:${srv.address().port}${p}`;
    try {
      const small = await net.getBuffer(url('/small'), { maxBytes: 2 * 1024 * 1024 }).then((b) => b.length, (e) => e.message);
      const t0 = Date.now();
      const declared = await net.getBuffer(url('/declared'), { maxBytes: 2 * 1024 * 1024, timeout: 15000 }).then(() => '读完了', (e) => e.message);
      const declaredSecs = (Date.now() - t0) / 1000;
      const stream = await net.getBuffer(url('/stream'), { maxBytes: 2 * 1024 * 1024 }).then(() => '读完了', (e) => e.message);
      await sleep(300); // pitfall-ok：等服务器那边把已经发出去的数一数，再看它一共发了多少
      check('net', '限了大小的下载：小的照常读完；报了超大长度的马上停；不报长度一直发的，读过上限就停', small === 100 && /太大/.test(declared) && declaredSecs < 5 && /太大/.test(stream) && sent < 20 * 1024 * 1024, { small, declared, declaredSecs, stream, sentMB: +(sent / 1048576).toFixed(1) });
      const skin = await skins.fetchSkin({ source: 'url', value: url('/stream') }).then(() => '收下了', (e) => e.message);
      check('net', '按网址导入皮肤：超过 2 MB 的「图片」不收，说「图片太大了」', /图片太大了/.test(skin), skin);
      const ctrl = new AbortController(); ctrl.abort();
      const t1 = Date.now();
      const ab = await net.request(url('/small'), { signal: ctrl.signal }).then(() => '发出去了', (e) => (e.cancelled ? '取消' : e.message));
      check('net', '已经取消的请求：马上报取消，不发出去', ab === '取消' && Date.now() - t1 < 500, ab);
      // 外置登录的认证服务器：外网的明文 http 不收（密码会明文传出去）；本机、局域网的照常
      const ygg = core('auth/yggdrasil');
      const plain = await ygg.resolve('http://example.com/api/yggdrasil').then(() => '收下了', (e) => e.message);
      const local = await ygg.resolve(url('/small')).then(() => '收下了', (e) => e.message);
      check('net', '外置登录：外网的明文 http 认证服务器不收、说清楚原因；本机的 http 照常去连', /不加密的 http/.test(plain) && !/不加密的 http/.test(local), { plain, local });
    } finally { srv.close(); }
  },

  // ── 公开导出（只导出到隔离目录，不建仓库、不推送）──
  async 'export-public'() {
    const { root } = setup('export-public');
    // 公开仓库里没有导出脚本：这一项只在内部仓库跑。也交一条结果，run.js 把「一条结果都没写」当成脚本没跑完
    if (!require('./editions').privateRepo) { check('export', '公开仓库里没有导出脚本（这一项只在内部仓库跑）', !fs.existsSync(path.join(H.REPO, 'scripts', 'export-public.js'))); return; }
    const target = path.join(root, 'public-export');
    const { spawnSync } = require('child_process');
    const node = process.env.AURORA_NODE || 'node';
    // 测试时工作区一般有没提交的改动：要推送的导出会拒绝，这里加 --allow-dirty 照样查公开仓库、照样导出
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: H.REPO, encoding: 'utf8', windowsHide: true }).stdout.trim();
    if (dirty) {
      const no = spawnSync(node, [path.join(H.REPO, 'scripts', 'export-public.js'), path.join(root, 'refused')], { cwd: H.REPO, encoding: 'utf8', windowsHide: true, timeout: 120000 });
      check('export', '工作区有没提交的改动时，要推送的导出停下、什么都不导出', no.status === 1 && /没提交的改动/.test(no.stderr || '') && !fs.existsSync(path.join(root, 'refused')), `${no.status} ${`${no.stderr || ''}`.slice(0, 200)}`);
    }
    const r = spawnSync(node, [path.join(H.REPO, 'scripts', 'export-public.js'), target, '--allow-dirty'], { cwd: H.REPO, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    check('export', '公开导出的检查通过', r.status === 0, `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-600));
    const has = (f) => fs.existsSync(path.join(target, f));
    const hant = ['src/shared/i18n/tr-zh-TW.js', 'src/shared/i18n/tr-zh-HK.js', 'scripts/i18n-hant-overrides.json', 'scripts/i18n.py'];
    check('export', '导出结果里没有繁体语言包和生成它们的脚本', hant.every((f) => !has(f)), hant.filter(has));
    const idx = has('src/shared/i18n/index.js') ? fs.readFileSync(path.join(target, 'src/shared/i18n/index.js'), 'utf8') : '';
    check('export', '导出结果的语言列表没有繁体', !!idx && !/zh-TW|zh-HK|繁體/.test(idx) && /zh-CN/.test(idx) && !/zh-TW|zh-HK/.test(fs.readFileSync(path.join(target, 'package.json'), 'utf8')));
    const stub = has('src/renderer/js/mcmodcn.js') ? fs.readFileSync(path.join(target, 'src/renderer/js/mcmodcn.js'), 'utf8') : '';
    check('export', '国创 Mod 浏览换成了公开版替身', stub.includes('CONCEPT: true'));
    // 调试菜单的密码哈希只在内部版（rc11）：导出的是空的替身（公开版的调试菜单不用密码），整个导出结果里都找不到那串哈希
    const realKey = fs.readFileSync(path.join(H.REPO, 'src/renderer/js/debugkey.js'), 'utf8');
    const hash = (realKey.match(/[0-9a-f]{64}/) || [''])[0];
    const keyStub = has('src/renderer/js/debugkey.js') ? fs.readFileSync(path.join(target, 'src/renderer/js/debugkey.js'), 'utf8') : '';
    const walkAll = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(path.join(d, e.name)) : [path.join(d, e.name)]));
    const leaked = hash ? walkAll(target).filter((f) => /\.(js|json|html|css|md|txt)$/.test(f) && fs.readFileSync(f, 'utf8').includes(hash)).map((f) => path.relative(target, f)) : ['内部版的 debugkey.js 里没找到哈希'];
    check('export', '调试菜单的密码哈希没有带出去，换成了空的替身', keyStub.includes('PUBLIC_STANDIN: true') && !/[0-9a-f]{64}/.test(keyStub) && !leaked.length, leaked);
    check('export', '只在内部用的脚本没有带出去', !has('scripts/edition.js') && !has('scripts/export-public.js') && !has('src/edition'));
  },

  // ── Mod、资源包、光影、游戏选项也能带过去（1.10.10）──
  async 'bring-items'() {
    setup('bring-items');
    const bus = ipc();
    const versions = core('versions'); const config = core('config'); const profiles = core('profiles');
    const tasks = core('tasks'); const gamesettings = core('gamesettings');
    const root = versions.gameRoot();
    const POL = { preset: 'isolated' };
    const TMP = 'saves.aurora-bring-tmp';
    const pub = async (id, loader = true) => { await H.fakeVersion(id, { loader }); config.setVersionSettings(id, { isolation: 'none' }); };
    const ver = (id, ...x) => path.join(versions.versionDir(id), ...x);
    const put = async (f, data) => { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, data); };
    const has = (f) => fs.existsSync(f);
    const digest = async (d) => {
      const out = {};
      const walk = async (x, rel) => {
        for (const e of await fsp.readdir(x, { withFileTypes: true }).catch(() => [])) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) { if (e.name !== 'versions' && e.name !== 'assets' && e.name !== 'libraries') await walk(path.join(x, e.name), r); } else out[r] = crypto.createHash('md5').update(await fsp.readFile(path.join(x, e.name))).digest('hex');
        }
      };
      await walk(d, '');
      return out;
    };
    const unchanged = async (id) => {
      const v = await versions.versionInfo(id);
      return path.resolve(versions.gameDirFor(id, v)) === path.resolve(root) && !(await profiles.readMeta(id)).isolation && config.getVersionSettings(id).isolation === 'none' && !has(ver(id, TMP)) && !has(ver(id, 'mods', 'a.jar'));
    };
    const keys = (r) => (r.ok && r.data.items ? r.data.items.map((x) => x.key).join() : `(${r.ok ? '没有 items' : r.error})`);

    await pub('LoaderP');
    await pub('VanillaP', false);
    // 只有不算内容的东西：不问
    await put(path.join(root, 'options.txt'), 'version:3465\nfov:0.5\n');
    await put(path.join(root, 'shaderpacks', 'Old.zip.txt'), 'x');
    let r = await bus.call('isolation:bringInfo', 'LoaderP', POL);
    check('4-1', '公共目录只有游戏选项和光影的设置文件：不问', r.ok && r.data.ask === false, r.ok ? r.data : r);
    // 真有内容
    await put(path.join(root, 'mods', 'a.jar'), crypto.randomBytes(20000));
    await put(path.join(root, 'mods', 'b.jar.disabled'), 'b');
    await put(path.join(root, 'config', 'a.toml'), 'k=1');
    await put(path.join(root, 'resourcepacks', 'p.zip'), crypto.randomBytes(5000));
    await put(path.join(root, 'shaderpacks', 's.zip'), crypto.randomBytes(5000));
    const before = await digest(root);
    r = await bus.call('isolation:bringInfo', 'LoaderP', POL);
    check('4-1', '没有世界但有 Mod 等内容：也要问，列出真有的内容', r.ok && r.data.ask === true && keys(r) === 'mods,resourcepacks,shaderpacks,options', keys(r));
    const modItem = r.ok && r.data.items ? r.data.items.find((x) => x.key === 'mods') : null;
    check('4-1', 'Mod 的大小把 config 文件夹算上，数得出几个 Mod', !!modItem && modItem.size >= 20000 + 1 + 3 && modItem.count === 2, modItem);
    check('4-1', '有加载器的配置：四项都默认勾选', r.ok && r.data.items && r.data.items.every((x) => x.def === true), r.ok ? r.data.items : r);
    r = await bus.call('isolation:bringInfo', 'VanillaP', POL);
    check('4-1', '纯原版：不显示 Mod', keys(r) === 'resourcepacks,shaderpacks,options', keys(r));
    r = await bus.call('isolation:bringInfo', 'LoaderP', { preset: 'custom', source: '@root', items: { saves: 'own', resourcepacks: 'link', options: 'copy' } });
    check('4-1', '自定义里资源包选共享、选项选副本：这两项不显示', keys(r) === 'mods,shaderpacks', keys(r));

    // 全部勾选
    await pub('AllP');
    r = await bus.call('isolation:bringWorlds', 'AllP', POL, { worlds: [], items: ['mods', 'resourcepacks', 'shaderpacks', 'options'] });
    check('4-1', '全部勾选：Mod、config、资源包、光影、游戏选项都带过去了', r.ok && has(ver('AllP', 'mods', 'a.jar')) && has(ver('AllP', 'mods', 'b.jar.disabled')) && has(ver('AllP', 'config', 'a.toml')) && has(ver('AllP', 'resourcepacks', 'p.zip')) && has(ver('AllP', 'shaderpacks', 's.zip')) && has(ver('AllP', 'options.txt')), r);
    check('4-1', '全部勾选：配置变成独立，临时文件夹清理了', !path.resolve(versions.gameDirFor('AllP', await versions.versionInfo('AllP'))).startsWith(path.resolve(root) + path.sep + 'x') && config.getVersionSettings('AllP').isolation === 'on' && !has(ver('AllP', TMP)));
    const modsSame = await digest(ver('AllP', 'mods'));
    const modsOrig = await digest(path.join(root, 'mods'));
    check('4-1', '全部勾选：Mod 内容一模一样', JSON.stringify(modsSame) === JSON.stringify(modsOrig));
    const optText = fs.existsSync(ver('AllP', 'options.txt')) ? fs.readFileSync(ver('AllP', 'options.txt'), 'utf8') : '';
    check('4-1', '游戏选项走按版本转换，设置还在', /fov:0\.5/.test(optText), optText.slice(0, 120));
    check('4-1', '全部勾选：公共目录的内容一点没动', JSON.stringify(await digest(root)) === JSON.stringify(before));

    // 部分勾选
    await pub('PartP');
    r = await bus.call('isolation:bringWorlds', 'PartP', POL, { worlds: [], items: ['shaderpacks'] });
    check('4-1', '只勾光影：只带光影', r.ok && has(ver('PartP', 'shaderpacks', 's.zip')) && !has(ver('PartP', 'mods')) && !has(ver('PartP', 'resourcepacks')) && !has(ver('PartP', 'options.txt')), r);
    await pub('NoneP');
    r = await bus.call('isolation:bringWorlds', 'NoneP', POL, { worlds: [], items: [] });
    check('4-1', '什么都不勾：配置照样切过去，什么都不带', r.ok && config.getVersionSettings('NoneP').isolation === 'on' && !has(ver('NoneP', 'mods')) && !has(ver('NoneP', 'shaderpacks')), r);
    await pub('EvilP');
    r = await bus.call('isolation:bringWorlds', 'EvilP', POL, { worlds: [], items: ['mods', '..\\..\\x', 'versions'] });
    check('4-1', '不认识的项目不会被复制', r.ok && has(ver('EvilP', 'mods', 'a.jar')) && !has(ver('EvilP', 'versions')), r);
    await pub('VanCopyP', false);
    r = await bus.call('isolation:bringWorlds', 'VanCopyP', POL, { worlds: [], items: ['mods', 'options'] });
    check('4-1', '纯原版硬传 Mod：也不复制', r.ok && !has(ver('VanCopyP', 'mods')) && has(ver('VanCopyP', 'options.txt')), r);

    // 配置自己已有的不覆盖
    await pub('OwnP');
    await put(ver('OwnP', 'mods', 'a.jar'), 'mine');
    await put(ver('OwnP', 'options.txt'), 'fov:0.9\n');
    r = await bus.call('isolation:bringInfo', 'OwnP', POL);
    check('4-1', '配置自己有游戏选项：这项不显示，不覆盖', keys(r) === 'mods,resourcepacks,shaderpacks', keys(r));
    r = await bus.call('isolation:bringWorlds', 'OwnP', POL, { worlds: [], items: ['mods', 'options'] });
    check('4-1', '配置自己有同名 Mod：留着自己的，别的带过来，说清楚留了几个', r.ok && fs.readFileSync(ver('OwnP', 'mods', 'a.jar'), 'utf8') === 'mine' && has(ver('OwnP', 'mods', 'b.jar.disabled')) && fs.readFileSync(ver('OwnP', 'options.txt'), 'utf8') === 'fov:0.9\n' && r.data.kept === 1, r);

    // 游戏选项转换失败：不退回整份复制（版本对不上可能让游戏读坏）
    await pub('OptFailP');
    const realTranslate = gamesettings.translateCopy;
    gamesettings.translateCopy = async () => { throw new Error('模拟转换失败'); };
    r = await bus.call('isolation:bringWorlds', 'OptFailP', POL, { worlds: [], items: ['options', 'shaderpacks'] });
    gamesettings.translateCopy = realTranslate;
    check('4-1', '游戏选项转换失败：不硬复制，说清楚没带过去，别的照常', r.ok && !has(ver('OptFailP', 'options.txt')) && has(ver('OptFailP', 'shaderpacks', 's.zip')) && r.data.failed.join() === 'options', r);

    // 空间不够：把 Mod 算进去。世界放得下，加上 Mod 放不下
    await fsp.mkdir(path.join(root, 'saves', 'W'), { recursive: true });
    await fsp.writeFile(path.join(root, 'saves', 'W', 'level.dat'), 'x');
    await pub('SpaceP');
    const realStatfs = fsp.statfs;
    const margin = 64 * 1024 * 1024;
    fsp.statfs = async () => ({ bavail: margin + 8192, bsize: 1 });
    const si = await bus.call('isolation:bringInfo', 'SpaceP', POL);
    const sr = await bus.call('isolation:bringWorlds', 'SpaceP', POL, { worlds: ['W'], items: ['mods'] });
    fsp.statfs = realStatfs;
    check('4-1', '空间不够：世界放得下，加上 Mod 放不下时开始前就拒绝，什么都不改', si.ok && si.data.enough === true && !sr.ok && /磁盘空间不足/.test(sr.error || '') && (await unchanged('SpaceP')), { enough: si.ok && si.data.enough, err: sr.error });
    check('4-1', '询问时给出每一项的大小和剩余空间，界面能自己算', si.ok && si.data.free === margin + 8192 && si.data.margin === margin && si.data.items.every((x) => x.size >= 0), si.ok ? { free: si.data.free, margin: si.data.margin } : si);
    fsp.statfs = async () => ({ bavail: margin + 8192, bsize: 1 });
    const so = await bus.call('isolation:bringWorlds', 'SpaceP', POL, { worlds: ['W'], items: [] });
    fsp.statfs = realStatfs;
    check('4-1', '同样的空间只带世界：放得下，能成功', so.ok && has(ver('SpaceP', 'saves', 'W', 'level.dat')), so);
    await fsp.rm(path.join(root, 'saves'), { recursive: true, force: true });

    // 中途取消和失败：Mod 文件很多
    await Promise.all(Array.from({ length: 1500 }, (_, i) => fsp.writeFile(path.join(root, 'mods', `big-${i}.jar`), crypto.randomBytes(16 * 1024))));
    const withBig = await digest(root);
    await pub('StopP');
    const c1 = await cancelSoon(bus.call('isolation:bringWorlds', 'StopP', POL, { worlds: [], items: ['mods', 'resourcepacks'] }), (t) => t.meta && t.meta.name === 'StopP', tasks, 30);
    check('4-1', '复制 Mod 时取消：报已取消，不留半成品，隔离状态没变', c1.sent && !c1.res.ok && c1.res.cancelled && (await unchanged('StopP')) && !has(ver('StopP', 'mods')), c1.res);
    await pub('FailP');
    const release = await lockFile(path.join(root, 'mods', 'big-700.jar'));
    r = await bus.call('isolation:bringWorlds', 'FailP', POL, { worlds: [], items: ['resourcepacks', 'mods'] });
    await release();
    check('4-1', '复制 Mod 时失败：报错，不留半成品，隔离状态没变', !r.ok && (await unchanged('FailP')) && !has(ver('FailP', 'mods')) && !has(ver('FailP', 'resourcepacks')), r.error);
    check('4-1', '取消和失败之后：公共目录的内容一点没动', JSON.stringify(await digest(root)) === JSON.stringify(withBig));

    // 切换之后放不进去：配置已经独立，说清楚哪项没放进去
    await pub('MoveP');
    const realRename = fsp.rename;
    fsp.rename = async (from, to) => { if (String(from).includes(TMP) && /resourcepacks/.test(String(from))) { const e = new Error('模拟改名失败'); e.code = 'EIO'; throw e; } return realRename(from, to); };
    r = await bus.call('isolation:bringWorlds', 'MoveP', POL, { worlds: [], items: ['resourcepacks', 'shaderpacks'] });
    fsp.rename = realRename;
    check('4-1', '放不进去：配置已经独立，报告哪项，别的照常，临时文件清理了', r.ok && config.getVersionSettings('MoveP').isolation === 'on' && has(ver('MoveP', 'shaderpacks', 's.zip')) && r.data.failed.includes('resourcepacks') && !has(ver('MoveP', TMP)), r);
  },

  // ── 全局设置「独立游戏目录」（1.10.10）──
  async 'bring-global'() {
    setup('bring-global');
    const bus = ipc();
    const versions = core('versions'); const config = core('config'); const tasks = core('tasks'); const isolation = core('isolation');
    const root = versions.gameRoot();
    const saves = path.join(root, 'saves');
    const TMP = 'saves.aurora-bring-tmp';
    const ver = (id, ...x) => path.join(versions.versionDir(id), ...x);
    const has = (f) => fs.existsSync(f);
    const names = async (d) => (await fsp.readdir(d).catch(() => [])).sort();
    const put = async (f, data) => { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, data); };
    if (!bus.has('isolation:globalInfo')) { check('4-1', '有全局切换用的后端接口', false, '没有 isolation:globalInfo（还没做）'); return; }
    config.set({ isolation: 'none', selectedVersion: 'ModA' });
    for (const id of ['ModA', 'ModB', 'ModC']) await H.fakeVersion(id);
    await H.fakeVersion('Van', { loader: false });
    await H.fakeVersion('Pinned');
    config.setVersionSettings('Pinned', { isolation: 'on' });
    await put(path.join(saves, 'W1', 'level.dat'), 'a');
    await put(path.join(saves, 'W2', 'level.dat'), 'b');
    await put(path.join(root, 'mods', 'a.jar'), 'jar');
    const rootBefore = JSON.stringify(await names(saves));
    const ids = (l) => l.map((x) => x.id).sort().join();

    let r = await bus.call('isolation:globalInfo', 'modded');
    check('4-1', '不使用 → Mod 版：列出会搬走的配置（有加载器的），固定了的和纯原版不算', r.ok && ids(r.data.outgoing) === 'ModA,ModB,ModC' && !r.data.incoming.length, r.ok ? { out: ids(r.data.outgoing) } : r);
    check('4-1', '询问时有世界数量、大小，默认带给当前选中的配置', r.ok && r.data.worlds.length === 2 && r.data.defaultTarget === 'ModA', r.ok ? { worlds: r.data.worlds, target: r.data.defaultTarget } : r);
    const outA = r.ok ? r.data.outgoing.find((x) => x.id === 'ModA') : null;
    check('4-1', '每个配置能带哪些内容都算好了', !!outA && outA.items.some((x) => x.key === 'mods'), outA);
    r = await bus.call('isolation:globalInfo', 'all');
    check('4-1', '不使用 → 全部版本：纯原版也算', r.ok && ids(r.data.outgoing) === 'ModA,ModB,ModC,Van', r.ok ? ids(r.data.outgoing) : r);
    r = await bus.call('isolation:globalInfo', 'none');
    check('4-1', '改成一样的值：没有配置受影响', r.ok && !r.data.outgoing.length && !r.data.incoming.length, r.ok ? r.data : r);

    // 空间不够
    const realStatfs = fsp.statfs;
    fsp.statfs = async () => ({ bavail: 1, bsize: 4096 });
    r = await bus.call('isolation:globalApply', 'modded', { target: 'ModA', worlds: ['W1'], items: [] });
    fsp.statfs = realStatfs;
    check('4-1', '空间不够：开始前拒绝，设置没改', !r.ok && /磁盘空间不足/.test(r.error || '') && config.get().isolation === 'none' && !has(ver('ModA', TMP)), r.error);

    // 中途取消
    await bigWorld(path.join(saves, 'Big'));
    const c1 = await cancelSoon(bus.call('isolation:globalApply', 'modded', { target: 'ModB', worlds: ['W1', 'Big'], items: [] }), (t) => t.meta && t.meta.name === 'ModB', tasks, 30);
    check('4-1', '全局：中途取消，设置没改，不留半个世界', c1.sent && !c1.res.ok && c1.res.cancelled && config.get().isolation === 'none' && !has(ver('ModB', TMP)) && !(await names(ver('ModB', 'saves'))).length, c1.res);
    // 复制失败
    const release = await lockFile(path.join(saves, 'Big', 'region', 'r.700.0.mca'));
    r = await bus.call('isolation:globalApply', 'modded', { target: 'ModB', worlds: ['W1', 'Big'], items: [] });
    await release();
    check('4-1', '全局：复制失败，设置没改，不留半个世界', !r.ok && config.get().isolation === 'none' && !has(ver('ModB', TMP)) && !(await names(ver('ModB', 'saves'))).length, r.error);
    await fsp.rm(path.join(saves, 'Big'), { recursive: true, force: true });
    // 切换这一步失败
    const realPrepare = isolation.prepare;
    isolation.prepare = async () => { throw new Error('模拟切换失败'); };
    r = await bus.call('isolation:globalApply', 'modded', { target: 'ModB', worlds: ['W1'], items: [] });
    isolation.prepare = realPrepare;
    check('4-1', '全局：切换失败，设置退回去，不留半个世界', !r.ok && config.get().isolation === 'none' && !has(ver('ModB', TMP)) && !(await names(ver('ModB', 'saves'))).length, r.error);
    // 有任务在跑的配置不能被搬走
    await bigWorld(path.join(saves, 'Big'));
    const busy = bus.call('isolation:bringWorlds', 'ModC', { preset: 'isolated' }, ['Big']);
    await waitFor(() => { try { tasks.assertFree('ModC'); return false; } catch { return true; } }, 5000);
    r = await bus.call('isolation:globalApply', 'modded', {});
    check('4-1', '会被搬走的配置还有任务在跑：拒绝改设置', !r.ok && config.get().isolation === 'none', r.error);
    for (const t of tasks.list()) if (t.status === 'running' && t.meta && t.meta.name === 'ModC') tasks.cancel(t.id);
    await busy;
    await fsp.rm(path.join(saves, 'Big'), { recursive: true, force: true });

    // 选一个配置带上
    r = await bus.call('isolation:globalApply', 'modded', { target: 'ModA', worlds: ['W1', 'W2'], items: ['mods'] });
    check('4-1', '全局选配置带：设置改了，世界和 Mod 只进这一个配置', r.ok && config.get().isolation === 'modded' && (await names(ver('ModA', 'saves'))).join() === 'W1,W2' && has(ver('ModA', 'mods', 'a.jar')) && !(await names(ver('ModB', 'saves'))).length && !has(ver('ModB', 'mods', 'a.jar')), r);
    check('4-1', '全局选配置带：搬走的配置不用固定，还跟着全局设置', !config.getVersionSettings('ModA').isolation && JSON.stringify(await names(saves)) === rootBefore && !has(ver('ModA', TMP)), config.getVersionSettings('ModA'));
    const infoA = await versions.versionInfo('ModA');
    check('4-1', '全局选配置带：配置确实用自己的目录了', path.resolve(versions.gameDirFor('ModA', infoA)) === path.resolve(versions.versionDir('ModA')));

    // 反方向
    await put(ver('ModA', 'mods', 'c.jar'), 'jar');
    r = await bus.call('isolation:globalInfo', 'none');
    const backA = r.ok ? r.data.incoming.find((x) => x.id === 'ModA') : null;
    check('4-1', '反方向：列出回到公共目录的配置和它们自己的世界', r.ok && !r.data.outgoing.length && ids(r.data.incoming) === 'ModA,ModB,ModC' && backA && backA.worlds === 2 && backA.mods === 2 && backA.dir === versions.versionDir('ModA'), backA);
    r = await bus.call('isolation:globalApply', 'none', {});
    check('4-1', '反方向：设置改了，配置回到公共目录，自己文件夹里的世界一个没少', r.ok && config.get().isolation === 'none' && (await names(ver('ModA', 'saves'))).join() === 'W1,W2' && path.resolve(versions.gameDirFor('ModA', await versions.versionInfo('ModA'))) === path.resolve(root), r);
    // 都不带
    r = await bus.call('isolation:globalApply', 'modded', { target: null });
    check('4-1', '全局都不带：设置改了，别的配置什么都没多', r.ok && config.get().isolation === 'modded' && !(await names(ver('ModB', 'saves'))).length, r);
    r = await bus.call('isolation:globalApply', 'none', {});
    // 没有世界也没有内容
    await fsp.rm(saves, { recursive: true, force: true });
    await fsp.rm(path.join(root, 'mods'), { recursive: true, force: true });
    r = await bus.call('isolation:globalInfo', 'modded');
    check('4-1', '公共目录什么都没有：配置照样列出来，没有世界和内容要问', r.ok && r.data.outgoing.length === 3 && !r.data.worlds.length && r.data.hasContent === false, r.ok ? { hasContent: r.data.hasContent } : r);
    r = await bus.call('isolation:globalApply', 'modded', {});
    check('4-1', '公共目录什么都没有：直接改设置', r.ok && config.get().isolation === 'modded', r);
  },

  // ── 公共目录的配置改成独立时带上世界（1.10.9）──
  async 'bring-worlds'() {
    setup('bring-worlds');
    const bus = ipc();
    const versions = core('versions'); const config = core('config'); const profiles = core('profiles');
    const tasks = core('tasks'); const isolation = core('isolation'); const launcher = core('launcher');
    const root = versions.gameRoot();
    const saves = path.join(root, 'saves');
    const POL = { preset: 'isolated' };
    const TMP = 'saves.aurora-bring-tmp';
    const pub = async (id) => { await H.fakeVersion(id, { loader: false }); config.setVersionSettings(id, { isolation: 'none' }); };
    const ownDir = (id) => path.join(versions.versionDir(id), 'saves');
    const names = async (d) => (await fsp.readdir(d).catch(() => [])).sort();
    const digest = async (d) => {
      const out = {};
      const walk = async (x, rel) => {
        for (const e of await fsp.readdir(x, { withFileTypes: true }).catch(() => [])) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(x, e.name), r);
          else out[r] = crypto.createHash('md5').update(await fsp.readFile(path.join(x, e.name))).digest('hex');
        }
      };
      await walk(d, '');
      return out;
    };
    const world = async (name) => {
      const d = path.join(saves, name);
      await fsp.mkdir(path.join(d, 'region'), { recursive: true });
      await fsp.writeFile(path.join(d, 'level.dat'), `level-${name}`);
      await fsp.writeFile(path.join(d, 'region', 'r.0.0.mca'), crypto.randomBytes(4096));
      await fsp.writeFile(path.join(d, 'session.lock'), 'lock');
    };
    const state = async (id) => {
      const v = await versions.versionInfo(id);
      return {
        inRoot: path.resolve(versions.gameDirFor(id, v)) === path.resolve(root),
        policy: (await profiles.readMeta(id)).isolation || null,
        vs: config.getVersionSettings(id).isolation,
        own: await names(ownDir(id)),
        tmp: fs.existsSync(path.join(versions.versionDir(id), TMP)),
      };
    };
    const unchanged = (st) => st.inRoot && !st.policy && st.vs === 'none' && !st.own.length && !st.tmp;
    if (!bus.has('isolation:bringInfo')) { check('4-1', '有询问用的后端接口', false, '没有 isolation:bringInfo（还没做）'); return; }

    // 什么时候问
    await pub('AskP');
    let r = await bus.call('isolation:bringInfo', 'AskP', POL);
    check('4-1', '公共目录没有 saves 文件夹：不问', r.ok && r.data.ask === false, r);
    await fsp.mkdir(path.join(saves, '不是世界'), { recursive: true });
    r = await bus.call('isolation:bringInfo', 'AskP', POL);
    check('4-1', '公共目录只有不是世界的文件夹：不问', r.ok && r.data.ask === false, r);
    await world('Alpha');
    await world('Beta 世界');
    r = await bus.call('isolation:bringInfo', 'AskP', POL);
    const expect = Object.values(await digest(saves)).length;
    check('4-1', '公共目录有世界：要问，带世界名、大小、空间', r.ok && r.data.ask === true && r.data.worlds.length === 2 && r.data.total > 8000 && r.data.free > 0 && r.data.enough === true && !r.data.busy, r.ok ? { worlds: r.data.worlds, total: r.data.total, enough: r.data.enough, files: expect } : r);
    for (const [why, pol, want] of [
      ['改成共享（共享公共目录，世界还看得到）：不问', { preset: 'shared', source: '@root' }, false],
      ['改成测试副本：不问', { preset: 'sandbox', source: '@root' }, false],
      ['自定义里存档选共享：不问', { preset: 'custom', source: '@root', items: { saves: 'link' } }, false],
      ['自定义里存档选独立：一样要问', { preset: 'custom', items: { saves: 'own' } }, true],
    ]) {
      r = await bus.call('isolation:bringInfo', 'AskP', pol);
      check('4-1', why, r.ok && r.data.ask === want, r.ok ? r.data.ask : r);
    }
    await H.fakeVersion('OwnP', { loader: false });
    config.setVersionSettings('OwnP', { isolation: 'on' });
    r = await bus.call('isolation:bringInfo', 'OwnP', POL);
    check('4-1', '配置本来就是独立的：不问', r.ok && r.data.ask === false, r);

    const before = await digest(saves);
    // 选复制
    await pub('CopyP');
    r = await bus.call('isolation:bringWorlds', 'CopyP', POL, ['Alpha', 'Beta 世界', '..\\..\\evil']);
    let st = await state('CopyP');
    check('4-1', '选复制：切到自己的目录，两个世界都在', r.ok && !st.inRoot && st.own.join() === 'Alpha,Beta 世界' && st.policy && st.policy.preset === 'isolated' && !st.tmp, { r, st });
    const copy = await digest(path.join(ownDir('CopyP'), 'Alpha'));
    const orig = await digest(path.join(saves, 'Alpha'));
    check('4-1', '选复制：内容一模一样，不带 session.lock', !copy['session.lock'] && Object.keys(copy).length === Object.keys(orig).length - 1 && Object.keys(copy).every((k) => copy[k] === orig[k]), copy);
    check('4-1', '选复制：原来的世界一点没动', JSON.stringify(await digest(saves)) === JSON.stringify(before));
    check('4-1', '选复制：不认识的名字不会被复制', !fs.existsSync(path.join(root, 'evil')) && !st.own.includes('evil'), st.own);

    // 选不复制
    await pub('NoP');
    r = await bus.call('isolation:set', 'NoP', POL);
    st = await state('NoP');
    check('4-1', '选不复制：切到自己的目录，存档是空的', r.ok && !st.inRoot && !st.own.length, { r, st });
    check('4-1', '选不复制：原来的世界一点没动', JSON.stringify(await digest(saves)) === JSON.stringify(before));

    // 自己已经有同名世界
    await pub('SameP');
    await fsp.mkdir(path.join(ownDir('SameP'), 'Alpha'), { recursive: true });
    await fsp.writeFile(path.join(ownDir('SameP'), 'Alpha', 'level.dat'), 'mine');
    r = await bus.call('isolation:bringInfo', 'SameP', POL);
    check('4-1', '自己有同名世界：询问时说明', r.ok && r.data.conflicts && r.data.conflicts.includes('Alpha'), r.ok ? r.data.conflicts : r);
    r = await bus.call('isolation:bringWorlds', 'SameP', POL, ['Alpha']);
    st = await state('SameP');
    check('4-1', '自己有同名世界：复制来的改名，自己的不动', r.ok && st.own.includes('Alpha') && st.own.includes('Alpha (来自 公共目录)') && fs.readFileSync(path.join(ownDir('SameP'), 'Alpha', 'level.dat'), 'utf8') === 'mine', { r, st });

    // 以前暂存过的存档，切回独立时要放回来（prepare 的 unstash），不能被复制来的世界挡住
    await pub('StashP');
    await fsp.mkdir(path.join(`${ownDir('StashP')}.aurora-own`, 'Old'), { recursive: true });
    await fsp.writeFile(path.join(`${ownDir('StashP')}.aurora-own`, 'Old', 'level.dat'), 'old');
    r = await bus.call('isolation:bringWorlds', 'StashP', POL, ['Alpha']);
    st = await state('StashP');
    check('4-1', '以前暂存的存档：放回来，世界也带过来', r.ok && st.own.join() === 'Alpha,Old', { r, st });

    // 中途取消：一个文件很多的世界
    await bigWorld(path.join(saves, 'Big'));
    const withBig = await digest(saves);
    await pub('StopP');
    const c1 = await cancelSoon(bus.call('isolation:bringWorlds', 'StopP', POL, ['Alpha', 'Big']), (t) => t.meta && t.meta.name === 'StopP', tasks, 30);
    st = await state('StopP');
    check('4-1', '中途取消：报已取消', c1.sent && !c1.res.ok && c1.res.cancelled, c1.res);
    check('4-1', '中途取消：不留半个世界，隔离状态没变，还在公共目录', unchanged(st), st);
    check('4-1', '中途取消：原来的世界一点没动', JSON.stringify(await digest(saves)) === JSON.stringify(withBig));
    r = await bus.call('isolation:bringWorlds', 'StopP', POL, ['Alpha']);
    st = await state('StopP');
    check('4-1', '取消之后再做一次：能成功', r.ok && !st.inRoot && st.own.join() === 'Alpha', { r, st });

    // 同一个配置不能同时做
    await pub('TwiceP');
    const p1 = bus.call('isolation:bringWorlds', 'TwiceP', POL, ['Big']);
    await waitFor(() => { try { tasks.assertFree('TwiceP'); return false; } catch { return true; } }, 5000);
    const r2 = await bus.call('isolation:bringWorlds', 'TwiceP', POL, ['Alpha']);
    const r3 = await bus.call('isolation:set', 'TwiceP', POL);
    check('4-1', '正在复制时再切换同一个配置：被拒绝', !r2.ok && !r3.ok, { r2: r2.error, r3: r3.error });
    for (const t of tasks.list()) if (t.status === 'running' && t.meta && t.meta.name === 'TwiceP') tasks.cancel(t.id);
    await p1;

    // 复制途中失败：有文件被占着
    await pub('FailP');
    const release = await lockFile(path.join(saves, 'Big', 'region', 'r.700.0.mca'));
    r = await bus.call('isolation:bringWorlds', 'FailP', POL, ['Alpha', 'Big']);
    await release();
    st = await state('FailP');
    check('4-1', '复制途中失败：报错，不留半个世界，隔离状态没变', !r.ok && unchanged(st), { r: r.error, st });

    // 复制途中公共目录的游戏开了：世界可能写到一半，不切换
    await pub('LateP');
    const realGames = launcher.listGames;
    const pLate = bus.call('isolation:bringWorlds', 'LateP', POL, ['Big']);
    await waitFor(() => { try { tasks.assertFree('LateP'); return false; } catch { return true; } }, 5000);
    launcher.listGames = () => [{ versionId: 'Someone', gameDir: root, state: 'running' }];
    r = await pLate;
    launcher.listGames = realGames;
    st = await state('LateP');
    check('4-1', '复制途中公共目录开了游戏：不切换，不留半个世界', !r.ok && /游戏|运行/.test(r.error || '') && unchanged(st), { r: r.error, st });
    await fsp.rm(path.join(saves, 'Big'), { recursive: true, force: true });

    // 空间不够
    await pub('SpaceP');
    const realStatfs = fsp.statfs;
    fsp.statfs = async () => ({ bavail: 1, bsize: 4096 });
    const si = await bus.call('isolation:bringInfo', 'SpaceP', POL);
    const sr = await bus.call('isolation:bringWorlds', 'SpaceP', POL, ['Alpha']);
    fsp.statfs = realStatfs;
    st = await state('SpaceP');
    check('4-1', '空间不够：询问时就说', si.ok && si.data.ask && si.data.enough === false && si.data.need > 0, si.ok ? { enough: si.data.enough, need: si.data.need, free: si.data.free } : si);
    check('4-1', '空间不够：直接复制也在开始前拒绝，什么都不改', !sr.ok && /磁盘空间不足/.test(sr.error || '') && unchanged(st), { r: sr.error, st });

    // 切换这一步失败：退回去
    await pub('RollP');
    const realSet = isolation.setPolicy;
    isolation.setPolicy = async (id) => { config.setVersionSettings(id, { isolation: 'on' }); await profiles.writeMeta(id, { isolation: POL }); throw new Error('模拟切换失败'); };
    r = await bus.call('isolation:bringWorlds', 'RollP', POL, ['Alpha']);
    isolation.setPolicy = realSet;
    st = await state('RollP');
    check('4-1', '切换这一步失败：隔离状态退回去，不留半个世界', !r.ok && /模拟切换失败/.test(r.error || '') && unchanged(st), { r: r.error, st });

    // 世界放进 saves 这一步失败：已经切了，要说清楚哪个没放进去
    await pub('MoveP');
    const realRename = fsp.rename;
    fsp.rename = async (from, to) => { if (String(from).includes(TMP) && String(from).includes('Beta')) { const e = new Error('模拟改名失败'); e.code = 'EIO'; throw e; } return realRename(from, to); };
    r = await bus.call('isolation:bringWorlds', 'MoveP', POL, ['Alpha', 'Beta 世界']);
    fsp.rename = realRename;
    st = await state('MoveP');
    check('4-1', '放进存档失败：配置已经是独立的，说清楚哪个世界没放进去', r.ok && !st.inRoot && st.own.join() === 'Alpha' && r.data.failed && r.data.failed.join() === 'Beta 世界' && !st.tmp, { r, st });
    check('4-1', '全部做完：原来的世界还是一点没动', JSON.stringify(await digest(saves)) === JSON.stringify(before));
  },

  // ── 5-4：Minecraft 版本比较有三份，规则不一样 ──
  async 'mc-compare'() {
    setup('mc-compare');
    const root = path.join(__dirname, '..', '..');
    const shared = path.join(root, 'src', 'shared', 'mcver.js');
    // 界面那两份在闭包里：还有自己的定义就从源码抠出来跑，统一以后跑公共那一份。这样修前修后是同一个脚本
    const pick = (file, re) => {
      const m = fs.readFileSync(path.join(root, file), 'utf8').match(re);
      if (m) return new Function(`${m[0]}\nreturn cmpMc;`)();
      return fs.existsSync(shared) ? require(shared).cmpMc : null;
    };
    const copies = {
      '主进程 infer.js': require(path.join(root, 'src', 'main', 'core', 'infer.js')).cmpMc,
      '恢复备份 savesui.js': pick('src/renderer/js/savesui.js', /function cmpMc\(a, b\) \{[\s\S]*?\n  \}/),
      '导入世界 promoteui.js': pick('src/renderer/js/promoteui.js', /const cmpMc = \(a, b\) => \{[\s\S]*?\n  \};/),
    };
    const table = [
      ['24w14a', '1.20.1', 1, '快照备份恢复到正式版：要警告版本更新'],
      ['1.20.1', '24w14a', -1, '正式版恢复到快照配置'],
      ['1.21-pre1', '1.20.1', 1, '预发布版比旧正式版新'],
      ['1.21.1', '1.21-pre1', 1, '正式版的小版本比预发布新'],
      ['26.3', '1.21.1', 1, '年份版本号比 1.x 新'],
      ['24w14a', '26.1', -1, '旧式快照比年份版本号旧'],
      ['25w01a', '24w14a', 1, '两个快照按时间比'],
      ['1.20.1', '1.20.1', 0, '相同'],
      ['1.20', '1.20.0', 0, '省略的小版本号当 0'],
      [undefined, '1.20.1', 0, '来源不知道版本：不警告'],
      ['1.20.1', '', 0, '目标不知道版本：不警告'],
      ['b1.7.3', '1.20.1', -1, 'Beta 比现代版本旧（统一以后不能误报成更新）'],
      ['rd-132211', '1.20.1', -1, '最早的版本比现代版本旧'],
    ];
    for (const [where, fn] of Object.entries(copies)) {
      const wrong = table.filter(([a, b, want]) => Math.sign(fn(a, b)) !== want).map(([a, b, want, why]) => `${a} vs ${b}: 得到 ${Math.sign(fn(a, b))}，应该 ${want}（${why}）`);
      check('5-4', `${where}：比较结果都对`, wrong.length === 0, wrong);
    }
    const results = table.map(([a, b]) => Object.values(copies).map((fn) => Math.sign(fn(a, b))).join(','));
    const { cmpVer } = core('envelope');
    check('升级', '启动器版本比较：第三位是两位数也按数字比', cmpVer('1.10.10', '1.10.9') === 1 && cmpVer('1.10.9', '1.10.10') === -1 && cmpVer('1.10.10', '1.10.10') === 0 && cmpVer('2.0.0-pre1', '1.10.10') === 1);
    // 5-3：预发布版本号（以前后缀都当 0，全算相等）
    const order = ['1.10.10', '2.0.0-pre1', '2.0.0-pre2', '2.0.0-pre10', '2.0.0-rc1', '2.0.0-rc2', '2.0.0', '2.0.1-pre1', '2.0.1'];
    const wrong = [];
    for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) {
      const want = Math.sign(i - j);
      if (cmpVer(order[i], order[j]) !== want) wrong.push(`${order[i]} vs ${order[j]}: 得到 ${cmpVer(order[i], order[j])}，应该 ${want}`);
    }
    check('5-3', '版本比较：pre 比 rc 旧，rc 比正式版旧，pre10 比 pre9 新', wrong.length === 0, wrong.slice(0, 6));
    check('5-3', '版本比较：不认识的版本号不出错，当最旧', cmpVer('', '1.0.0') === -1 && cmpVer(null, null) === 0 && cmpVer('2.0.0-beta3', '2.0.0-pre1') === -1 && cmpVer('2.0.0-beta3', '2.0.0-beta2') === 1);
    check('5-4', '三处的结果完全一样', results.every((r) => new Set(r.split(',')).size === 1), results);
  },

  // ── 4-1、4-2：选「独立」没真的独立 ──
  async 'iso-policy'() {
    setup('iso-policy');
    const bus = ipc();
    const config = core('config');
    const versions = core('versions');
    const profiles = core('profiles');
    const root = versions.gameRoot();
    const where = async (id) => (versions.gameDirFor(id, await versions.versionInfo(id)) === root ? '公共目录' : '自己的目录');
    await fakeVersion('V1', { loader: false });
    await profiles.writeMeta('V1', { type: 'vanilla' });
    check('4-1', '确认场景成立：纯原版配置在公共目录', (await where('V1')) === '公共目录', await where('V1'));
    let r = await bus.call('isolation:set', 'V1', { preset: 'isolated' });
    check('4-1', '「存档与隔离」里选独立：真的用自己的目录', r.ok && (await where('V1')) === '自己的目录', { ok: r.ok, where: await where('V1') });

    config.set({ isolation: 'none' });
    await fakeVersion('VP1');
    await profiles.writeMeta('VP1', { type: 'vanillaplus' });
    r = await bus.call('isolation:set', 'VP1', { preset: 'isolated' });
    check('4-2', '全局不隔离时带加载器的配置选独立：真的用自己的目录', r.ok && (await where('VP1')) === '自己的目录', await where('VP1'));
    config.set({ isolation: 'modded' });

    // 不能改坏的：复制配置不应该把「没选过隔离」的配置变成独立
    await fakeVersion('Plain', { loader: false });
    await profiles.writeMeta('Plain', { type: 'vanilla' });
    r = await bus.call('profiles:duplicate', 'Plain', 'PlainCopy', {});
    check('4-1', '复制一个没选过隔离的纯原版配置：副本还在公共目录（行为不变）', r.ok && (await where('PlainCopy')) === '公共目录', { ok: r.ok, err: r.error, where: r.ok ? await where('PlainCopy') : null });
    // 选了独立的配置复制后也是独立
    r = await bus.call('profiles:duplicate', 'V1', 'V1Copy', {});
    check('4-1', '复制一个选了独立的配置：副本也是独立', r.ok && (await where('V1Copy')) === '自己的目录', { ok: r.ok, err: r.error, where: r.ok ? await where('V1Copy') : null });
  },

  // ── 4-4：这些阶段的取消按钮 ──
  /** 名字的翻译标记不写进文件：排查记录的句子里有名字（2.0.0-pre7） */
  async 'mark-plain'() {
    setup('mark-plain');
    const profiles = core('profiles');
    const versions = core('versions');
    const i18n = require(path.join(H.REPO || path.resolve(__dirname, '..', '..'), 'src', 'shared', 'i18n'));
    await fakeVersion('Rec');
    await profiles.writeMeta('Rec', { type: 'custom' });
    i18n.setLang('en');
    const marked = i18n.nm('设置');
    check('mark', '确认场景成立：英文界面 nm 加了标记', marked !== '设置', marked.length);
    await profiles.recordTroubleshoot('Rec', { kind: 'fix', ok: true, summary: `自动安装前置 ${marked}` });
    i18n.setLang('zh-CN');
    const text = await fsp.readFile(path.join(versions.versionDir('Rec'), 'aurora-profile.json'), 'utf8');
    check('mark', '排查记录写进文件：名字在，标记不在', text.includes('自动安装前置 设置') && !/[\u2068\u2069]/.test(text), text.slice(0, 120));
    finish();
  },

  /**
   * 转为正式配置真的转成功（2.0.0-pre7）：7cfcb44 起 promote.js 少一个导入，走到最后一步一定报错。
   * 以前的场景都碰不到那一行：取消场景在复制途中就停了，game-locks 在开头就被拒绝。
   */
  async 'promote-real'() {
    setup('promote-real');
    const bus = ipc();
    const config = core('config');
    const versions = core('versions');
    const profiles = core('profiles');
    const tasks = core('tasks');
    const isolation = core('isolation');
    const promote = core('promote');
    const root = versions.gameRoot();
    const w = path.join(root, 'saves', 'W1');
    await fsp.mkdir(w, { recursive: true });
    await fsp.writeFile(path.join(w, 'level.dat'), 'from-source');
    const read = (id) => fsp.readFile(path.join(versions.versionDir(id), 'saves', 'W1', 'level.dat'), 'utf8').catch(() => null);
    const make = async (id, preset) => {
      await fakeVersion(id);
      config.setVersionSettings(id, { isolation: 'on' });
      await profiles.writeMeta(id, { type: 'custom', isolation: { preset, source: '@root' } });
      return versions.versionDir(id);
    };
    const junk = async (gd) => (await fsp.readdir(gd)).filter((n) => /aurora-promote|\.tmp$/.test(n));
    const ok = (res) => res.ok && !res.cancelled;

    // 共享 → 正式：联接换成真文件夹，来源不动
    let gd = await make('ProShared', 'shared');
    await isolation.prepare('ProShared', gd, { allowCopy: true });
    check('promote', '确认场景成立：共享配置的 saves 是联接', await isolation.isLink(path.join(gd, 'saves')));
    let res = await bus.call('isolation:promote', 'ProShared', {});
    check('promote', '共享转正：成功', ok(res), res.error || '');
    check('promote', '共享转正：saves 成了真文件夹，世界带过来了', !(await isolation.isLink(path.join(gd, 'saves'))) && (await read('ProShared')) === 'from-source', await read('ProShared'));
    check('promote', '共享转正：来源的世界还在', fs.existsSync(path.join(w, 'level.dat')));
    let policy = await isolation.getPolicy('ProShared');
    check('promote', '共享转正：策略改成独立', policy.preset === 'isolated', policy.preset);
    check('promote', '共享转正：不留临时文件夹', !(await junk(gd)).length, await junk(gd));
    check('promote', '共享转正：结果说明了做了什么', ok(res) && Array.isArray(res.data.lines) && res.data.lines.some((x) => /saves|存档|世界/.test(x)), ok(res) ? res.data.lines : '');

    // 测试副本 → 正式，留下测试进度
    gd = await make('ProKeep', 'sandbox');
    await isolation.prepare('ProKeep', gd, { allowCopy: true });
    check('promote', '确认场景成立：测试副本复制了世界', (await read('ProKeep')) === 'from-source', await read('ProKeep'));
    await fsp.writeFile(path.join(gd, 'saves', 'W1', 'level.dat'), 'played-in-copy');
    res = await bus.call('isolation:promote', 'ProKeep', { saves: 'keep' });
    check('promote', '副本转正（留下进度）：成功，进度还在', ok(res) && (await read('ProKeep')) === 'played-in-copy', res.error || await read('ProKeep'));
    check('promote', '副本转正（留下进度）：来源没变', (await fsp.readFile(path.join(w, 'level.dat'), 'utf8')) === 'from-source');
    check('promote', '副本转正（留下进度）：副本标记去掉了', !fs.existsSync(path.join(gd, 'saves', '.aurora-sandbox')));
    policy = await isolation.getPolicy('ProKeep');
    check('promote', '副本转正（留下进度）：策略改成独立', policy.preset === 'isolated', policy.preset);

    // 测试副本 → 正式，从来源重新复制，旧副本留一份
    gd = await make('ProFresh', 'sandbox');
    await isolation.prepare('ProFresh', gd, { allowCopy: true });
    await fsp.writeFile(path.join(gd, 'saves', 'W1', 'level.dat'), 'played-in-copy');
    res = await bus.call('isolation:promote', 'ProFresh', { saves: 'fresh' });
    check('promote', '副本转正（重新复制）：成功，是来源的内容', ok(res) && (await read('ProFresh')) === 'from-source', res.error || await read('ProFresh'));
    const keptDir = ok(res) ? res.data.kept[0] : null;
    const keptText = keptDir ? await fsp.readFile(path.join(keptDir, 'W1', 'level.dat'), 'utf8').catch(() => null) : null;
    check('promote', '副本转正（重新复制）：旧副本留了一份，里面是测试时的进度', keptText === 'played-in-copy', { keptDir, keptText });

    // 已经完全独立：不做事也不报错
    res = await bus.call('isolation:promote', 'ProKeep', {});
    check('promote', '已经独立的配置再转一次：不报错', ok(res), res.error || '');

    // 任务已经取消了再开始：算取消，不算别的错误
    gd = await make('ProLate', 'shared');
    await isolation.prepare('ProLate', gd, { allowCopy: true });
    const t = new tasks.Task('转正', { kind: 'install' });
    tasks.cancel(t.id);
    const late = await promote.promote('ProLate', {}, t).then(() => ({ ok: true }), (e) => ({ ok: false, cancelled: !!e.cancelled, err: e.message }));
    check('promote', '已经取消的任务：算取消，不是别的错误', !late.ok && late.cancelled, late);
    check('promote', '已经取消的任务：还是共享状态', await isolation.isLink(path.join(gd, 'saves')) && (await isolation.getPolicy('ProLate')).preset === 'shared' && !(await junk(gd)).length);
    finish();
  },

  async 'cancel-copy'() {
    setup('cancel-copy');
    const bus = ipc();
    const config = core('config');
    const versions = core('versions');
    const profiles = core('profiles');
    const tasks = core('tasks');
    const isolation = core('isolation');
    const root = versions.gameRoot();
    await bigWorld(path.join(root, 'saves', 'Big'));

    // 导入存档
    await fakeVersion('Imp');
    config.setVersionSettings('Imp', { isolation: 'on' });
    await profiles.writeMeta('Imp', { type: 'custom' });
    let c = await cancelSoon(bus.call('backup:importWorlds', 'Imp', '@root', ['Big']), (t) => /导入/.test(t.title), tasks);
    const impDir = path.join(versions.versionDir('Imp'), 'saves');
    const left = await tree(impDir);
    check('4-4', '导入存档中途取消：真的停下', c.sent && c.res.cancelled === true, { sent: c.sent, cancelled: c.res.cancelled, ok: c.res.ok, ms: c.ms });
    check('4-4', '导入存档中途取消：不留半个世界', !left.length, { files: left.length });

    // 转为正式配置（共享 → 复制一份）
    await fakeVersion('Pro');
    config.setVersionSettings('Pro', { isolation: 'on' });
    await profiles.writeMeta('Pro', { type: 'custom' });
    await bus.call('isolation:set', 'Pro', { preset: 'shared', source: '@root' });
    const proGd = versions.versionDir('Pro');
    c = await cancelSoon(bus.call('isolation:promote', 'Pro', {}), (t) => /转为正式配置/.test(t.title), tasks);
    check('4-4', '转正中途取消：真的停下', c.sent && c.res.cancelled === true, { sent: c.sent, cancelled: c.res.cancelled, ok: c.res.ok, ms: c.ms });
    const stillLink = await isolation.isLink(path.join(proGd, 'saves'));
    const junk = (await fsp.readdir(proGd)).filter((n) => /aurora-promote|\.tmp$/.test(n));
    const policy = await isolation.getPolicy('Pro');
    check('4-4', '转正中途取消：还是原来的共享状态，不留半成品', stillLink && !junk.length && policy.preset === 'shared', { stillLink, junk, preset: policy.preset });

    // 启动前复制测试副本的那一步（launcher 外面单独测 copyDir 的取消）
    await fakeVersion('SB');
    config.setVersionSettings('SB', { isolation: 'on' });
    await profiles.writeMeta('SB', { type: 'custom', isolation: { preset: 'sandbox', source: '@root' } });
    const sbGd = versions.versionDir('SB');
    const t = new tasks.Task('复制副本', { kind: 'launch' });
    const p = isolation.prepare('SB', sbGd, { allowCopy: true, task: t }).then(() => ({ ok: true }), (e) => ({ ok: false, cancelled: !!e.cancelled, err: e.message }));
    await waitFor(() => t.detail !== '准备中…', 5000);
    t.cancel();
    const res = await p;
    t.fail(Object.assign(new Error('x'), { cancelled: true }));
    check('4-4', '复制测试副本中途取消：真的停下', res.cancelled === true, res);
    const again = await isolation.prepare('SB', sbGd, { allowCopy: true }).then(() => 'ok', (e) => e.message);
    const copied = await tree(path.join(sbGd, 'saves', 'Big'));
    check('4-4', '复制测试副本取消后再启动：重新复制完整', again === 'ok' && copied.length === 1501, { again, files: copied.length });
  },

  // ── 12-3：复制配置失败不清理 ──
  async 'duplicate-fail'() {
    setup('duplicate-fail');
    const bus = ipc();
    const versions = core('versions');
    const config = core('config');
    await fakeVersion('Src');
    config.setVersionSettings('Src', { isolation: 'on' });
    const dir = versions.versionDir('Src');
    await fsp.mkdir(path.join(dir, 'mods'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'mods', 'a.jar'), 'a');
    await fsp.writeFile(path.join(dir, 'mods', 'locked.jar'), 'b');
    const release = await lockFile(path.join(dir, 'mods', 'locked.jar'), 'None', 15);
    let r = await bus.call('profiles:duplicate', 'Src', 'Dup', {});
    await release();
    check('12-3', '确认场景成立：文件被占用时复制失败', !r.ok, r.ok ? '没有失败' : String(r.error).slice(0, 50));
    check('12-3', '复制失败：不留半成品文件夹', !fs.existsSync(versions.versionDir('Dup')), { left: fs.existsSync(versions.versionDir('Dup')) });
    r = await bus.call('profiles:duplicate', 'Src', 'Dup', {});
    check('12-3', '占用解除后再复制：能成功（修之前报「已存在」）', r.ok, r.ok ? '' : r.error);
    check('12-3', '复制出来的内容完整', r.ok && fs.existsSync(path.join(versions.versionDir('Dup'), 'mods', 'locked.jar')) && fs.existsSync(versions.versionJsonPath('Dup')), '');
  },

  // ── 12-4：失败也说成功 ──
  async 'swallowed-errors'() {
    setup('swallowed-errors');
    const bus = ipc();
    const versions = core('versions');
    const config = core('config');
    await fakeVersion('M');
    config.setVersionSettings('M', { isolation: 'on' });
    const mods = path.join(versions.versionDir('M'), 'mods');
    await fsp.mkdir(mods, { recursive: true });
    await fsp.writeFile(path.join(mods, 'ok.jar'), 'a');
    await fsp.writeFile(path.join(mods, 'locked.jar'), 'b');
    let release = await lockFile(path.join(mods, 'locked.jar'), 'None', 15);
    let r = await bus.call('mods:disableFiles', [path.join(mods, 'ok.jar'), path.join(mods, 'locked.jar')], 'M');
    await release();
    const failed = r.ok && r.data && r.data.failed;
    check('12-4', '批量禁用：没禁用成的要报告出来', Array.isArray(failed) && failed.length === 1 && /locked\.jar/.test(failed[0].file || failed[0]), { ok: r.ok, data: r.data });
    check('12-4', '批量禁用：能禁用的照常禁用', fs.existsSync(path.join(mods, 'ok.jar.disabled')) && fs.existsSync(path.join(mods, 'locked.jar')), await tree(mods));

    // 撤销组件修改：手工放一份记录（没有依赖库的假版本，补全那一步不联网）
    await fakeVersion('U', { loader: false, extra: { mainClass: 'x' } });
    config.setVersionSettings('U', { isolation: 'on' });
    await fsp.writeFile(path.join(versions.versionDir('U'), 'U.jar'), 'jar');
    const uMods = path.join(versions.versionDir('U'), 'mods');
    await fsp.mkdir(uMods, { recursive: true });
    const compDir = path.join(versions.versionDir('U'), '.aurora-components', '123');
    await fsp.mkdir(compDir, { recursive: true });
    await fsp.copyFile(versions.versionJsonPath('U'), path.join(compDir, 'version.json'));
    await fsp.writeFile(path.join(uMods, 'added.jar'), 'new');
    await fsp.writeFile(path.join(uMods, 'was-disabled.jar.disabled'), 'c');
    await fsp.writeFile(path.join(compDir, 'record.json'), JSON.stringify({ added: ['added.jar'], disabled: ['was-disabled.jar.disabled'], moved: [] }));
    await fsp.writeFile(path.join(versions.versionDir('U'), '.aurora-components', 'history.json'), JSON.stringify([{ ts: 123, from: {}, to: {}, label: 'x' }]));
    release = await lockFile(path.join(uMods, 'was-disabled.jar.disabled'), 'None', 15);
    const tasks = core('tasks');
    const task = new tasks.Task('撤销');
    const comps = core('components');
    const res = await comps.undo('U', 123, task).then((x) => ({ ok: true, data: x }), (e) => ({ ok: false, err: e.message }));
    await release();
    task.finish();
    const list = res.data && res.data.undoFailed;
    check('12-4', '撤销组件修改：没还原成的要报告出来（修之前一律说已撤销）', Array.isArray(list) && list.some((x) => /was-disabled/.test(x)), res);
  },

  // ── 5-1：同前缀的 Java ──
  async 'java-prefix'() {
    const { data } = setup('java-prefix');
    const config = core('config');
    const java = core('java');
    const rt = path.join(data, 'runtime');
    await fsp.mkdir(path.join(rt, 'java-runtime-gamma'), { recursive: true });
    await fsp.mkdir(path.join(rt, 'java-runtime-gamma-snapshot', 'bin'), { recursive: true });
    const snap = path.join(rt, 'java-runtime-gamma-snapshot', 'bin', 'java.exe');
    config.set({ java: { selected: snap } });
    await java.uninstallRuntime(path.join(rt, 'java-runtime-gamma'));
    check('5-1', '卸载 gamma：全局选的 gamma-snapshot 不受影响', config.get().java.selected === snap, path.basename(path.dirname(path.dirname(config.get().java.selected))) || config.get().java.selected);
    await fsp.mkdir(path.join(rt, 'java-runtime-gamma'), { recursive: true });
    const inGamma = path.join(rt, 'java-runtime-gamma', 'bin', 'java.exe');
    config.set({ java: { selected: inGamma } });
    await java.uninstallRuntime(path.join(rt, 'java-runtime-gamma'));
    check('5-1', '卸载的正是全局选的那个：改回自动（行为不变）', config.get().java.selected === 'auto', config.get().java.selected);
    // 路径大小写不一样（盘符小写、文件夹名大写）也认得是 Aurora 下载的；运行时文件夹外面的、就是运行时文件夹本身的都不删
    await fsp.mkdir(path.join(rt, 'java-runtime-delta', 'bin'), { recursive: true });
    const odd = path.join(rt, 'JAVA-RUNTIME-DELTA').replace(/^[A-Z]:/, (d) => d.toLowerCase());
    const okOdd = await java.uninstallRuntime(odd).then(() => true, (e) => e.message);
    const outside = await java.uninstallRuntime(data).then(() => '删了', (e) => e.message);
    const self = await java.uninstallRuntime(rt).then(() => '删了', (e) => e.message);
    check('5-1', '卸载 Java：路径大小写不同也认得出；运行时文件夹外面的、运行时文件夹本身都不删', okOdd === true && !fs.existsSync(path.join(rt, 'java-runtime-delta')) && /只能删除/.test(outside) && /只能删除/.test(self) && fs.existsSync(rt), { okOdd, outside, self });
  },

  // ── 检测 Java 时不算没装完的：解压到一半的 *.tmp、正在下载的官方运行时 ──
  async 'java-inprogress'() {
    const { data } = setup('java-inprogress');
    const java = core('java');
    const rt = path.join(data, 'runtime');
    // 有 release 文件（版本号、架构都在）就不会真的去运行 java.exe，空文件就够
    const fake = async (home, version) => {
      await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(home, 'release'), `JAVA_VERSION="${version}"\nOS_ARCH="x86_64"\nIMPLEMENTOR="Regress Fake"\n`, 'utf8');
      for (const exe of process.platform === 'win32' ? ['java.exe', 'javaw.exe'] : ['java']) await fsp.writeFile(path.join(home, 'bin', exe), '');
      return home;
    };
    const done = await fake(path.join(rt, 'java-runtime-delta'), '21.0.7');
    const unpacking = await fake(path.join(rt, 'temurin-25-jre.tmp', 'jdk-25.0.5+8-jre'), '25.0.5');
    const downloading = await fake(path.join(rt, 'java-runtime-gamma'), '17.0.15');
    await fsp.writeFile(path.join(downloading, '.aurora-runtime-installing'), '');
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const has = (list, home) => list.some((j) => same(j.home, home));
    let found = await java.detect(true);
    check('Java', '确认场景成立：装好的 Aurora 下载的 Java 认得出来', has(found, done), found.map((j) => `${j.major}:${path.basename(j.home)}`).join(' '));
    check('Java', '正在解压的临时文件夹（*.tmp）里的 Java 不算（以前会被运行、当场崩溃留下 hs_err_pid*.log）', !has(found, unpacking), found.filter((j) => /\.tmp/i.test(j.home)).map((j) => j.home));
    check('Java', '正在下载的官方运行时（有没装完的标记）不算', !has(found, downloading), found.filter((j) => /gamma/.test(j.home)).map((j) => j.home));
    await fsp.rm(path.join(downloading, '.aurora-runtime-installing'));
    found = await java.detect(true);
    check('Java', '标记去掉（装完了）就认得出来', has(found, downloading), found.map((j) => `${j.major}:${path.basename(j.home)}`).join(' '));
  },

  // ── 7-1：两个任务同时下载同一个文件 ──
  async 'downloader-lock'() {
    const { root } = setup('downloader-lock');
    const { downloadAll } = core('downloader');
    const blob = crypto.randomBytes(8 * 1024 * 1024);
    const sha1 = crypto.createHash('sha1').update(blob).digest('hex');
    let conns = 0;
    const srv = http.createServer((req, res) => {
      conns++;
      const slow = req.url.includes('slow');
      res.writeHead(200, { 'content-length': blob.length });
      let i = 0; const step = slow ? 32 * 1024 : 256 * 1024;
      const pump = () => { if (i >= blob.length) { res.end(); return; } res.write(blob.subarray(i, i + step)); i += step; setTimeout(pump, 16); };
      pump();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const file = path.join(root, 'dl', 'client.jar');
    const hash = () => { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') === sha1 ? 'ok' : 'BAD'; } catch { return 'MISSING'; } };
    const entry = (u) => [{ urls: [`http://127.0.0.1:${port}/${u}`], path: file, sha1, size: blob.length }];

    // B 比 A 慢很多（比如走不同的镜像）
    let a = downloadAll(entry('fast'), { concurrency: 1 });
    await waitFor(() => conns >= 1, 5000);
    let bDone = false;
    let b = downloadAll(entry('slow'), { concurrency: 1 }).then(() => 'ok', (e) => `失败:${e.message.slice(0, 60)}`).finally(() => { bDone = true; });
    await a;
    const atDone = hash();
    const seen = { ok: 0, BAD: 0, MISSING: 0 };
    for (let i = 0; i < 400 && !bDone; i++) { seen[hash()]++; await sleep(40); }
    const br = await Promise.race([b, sleep(30000).then(() => '超时')]);
    check('7-1', 'A 报告成功那一刻文件是对的', atDone === 'ok', atDone);
    check('7-1', '之后到 B 结束这段时间文件一直是对的（没有损坏、没有消失）', !seen.BAD && !seen.MISSING, seen);
    check('7-1', 'B 也成功，最后文件是对的', br === 'ok' && hash() === 'ok', { b: br, final: hash() });
    const connsBoth = conns;
    check('7-1', '同一个文件只下载一次（修之前两边各下，失败了还重下）', connsBoth === 1, { connections: connsBoth });

    // A 被取消：B 不能跟着失败，要自己接着下
    await fsp.rm(path.dirname(file), { recursive: true, force: true });
    const ctrl = new AbortController();
    a = downloadAll(entry('fast'), { concurrency: 1, signal: ctrl.signal }).then(() => 'ok', (e) => (e.cancelled ? 'cancelled' : e.message));
    await waitFor(() => conns > connsBoth, 5000);
    b = downloadAll(entry('fast'), { concurrency: 1 }).then(() => 'ok', (e) => `失败:${e.message.slice(0, 60)}`);
    await sleep(100); // pitfall-ok：B 要先挂到 A 正在进行的那次下载上（外面看不出挂没挂上），等一下再取消 A
    ctrl.abort();
    const ar = await a;
    const br2 = await Promise.race([b, sleep(30000).then(() => '超时')]);
    check('7-1', 'A 取消后 B 自己下完（不跟着失败）', ar === 'cancelled' && br2 === 'ok' && hash() === 'ok', { a: ar, b: br2, final: hash() });

    // B 被取消：不影响 A，B 马上返回
    await fsp.rm(path.dirname(file), { recursive: true, force: true });
    const n2 = conns; a = downloadAll(entry('slow'), { concurrency: 1 }).then(() => 'ok', (e) => `失败:${e.message.slice(0, 60)}`);
    await waitFor(() => conns > n2, 5000);
    const c2 = new AbortController();
    const t0 = Date.now();
    b = downloadAll(entry('slow'), { concurrency: 1, signal: c2.signal }).then(() => 'ok', (e) => (e.cancelled ? 'cancelled' : e.message));
    await sleep(100); // pitfall-ok：B 要先挂到 A 正在进行的那次下载上（外面看不出挂没挂上），等一下再取消 B
    c2.abort();
    const br3 = await Promise.race([b, sleep(3000).then(() => '等了 3 秒还没返回')]);
    const waited = Date.now() - t0;
    const ar3 = await a;
    check('7-1', '等别人下载时自己取消：马上返回，不影响别人', br3 === 'cancelled' && ar3 === 'ok' && hash() === 'ok', { b: br3, a: ar3, waited, final: hash() });
    srv.close();
  },

  // ── 8-1：压缩包文件名 ──
  async 'zip-names'() {
    const { root } = setup('zip-names');
    const { ZipReader } = core('zip');
    const f = path.join(root, 'names.zip');
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x6a, 0x61, 0x72]); // 「中文.jar」的 GBK 字节
    await fsp.writeFile(f, makeZip([
      { raw: Buffer.from('带标记的中文.jar', 'utf8'), flags: 0x800 },
      { raw: Buffer.from('没标记的UTF8中文.jar', 'utf8'), flags: 0 },
      { raw: gbk, flags: 0 },
      { raw: Buffer.from('plain-ascii.txt'), flags: 0 },
    ]));
    const z = await ZipReader.open(f);
    const names = z.entries.map((e) => e.name);
    check('8-1', '带 UTF-8 标记的正常', names[0] === '带标记的中文.jar', names[0]);
    check('8-1', '没标记的 UTF-8 不乱码', names[1] === '没标记的UTF8中文.jar', names[1]);
    check('8-1', 'GBK（Windows 自带压缩、老压缩工具）不乱码', names[2] === '中文.jar', names[2]);
    check('8-1', '纯英文不受影响', names[3] === 'plain-ascii.txt', names[3]);
    const dest = path.join(root, 'out');
    await z.extractAll(dest);
    await z.close();
    const out = await tree(dest);
    check('8-1', '解压出来的文件名也是对的', out.includes('中文.jar') && out.includes('没标记的UTF8中文.jar'), out);
  },

  // ── 8-2：NBT 字符串 ──
  async 'nbt-mutf8'() {
    setup('nbt-mutf8');
    const nbt = core('nbt');
    const name = Buffer.concat([Buffer.from('我的服', 'utf8'), Buffer.from([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80])]); // Java writeUTF 写的 😀
    const nul = Buffer.from([0x61, 0xc0, 0x80, 0x62]); // Java writeUTF 写的 NUL
    const len = (b) => { const x = Buffer.alloc(2); x.writeUInt16BE(b.length); return x; };
    const raw = Buffer.concat([Buffer.from([10, 0, 0]), Buffer.from([8, 0, 4]), Buffer.from('name'), len(name), name, Buffer.from([8, 0, 3]), Buffer.from('nul'), len(nul), nul, Buffer.from([0])]);
    const root = nbt.parse(raw);
    check('8-2', '读：Java 写的 emoji 服务器名不乱码', root.value.name.value === '我的服😀', root.value.name.value);
    check('8-2', '读：Java 写的 NUL', root.value.nul.value === 'a\u0000b', JSON.stringify(root.value.nul.value));
    const again = nbt.serialize(root);
    check('8-2', '写回和原来一字节不差', Buffer.compare(raw, again) === 0, { before: raw.length, after: again.length });
    // 普通中文、英文读写不变；别的工具直接写的标准 UTF-8 也能读
    const utf = Buffer.from('普通中文abc😀', 'utf8');
    const raw2 = Buffer.concat([Buffer.from([10, 0, 0]), Buffer.from([8, 0, 1]), Buffer.from('a'), len(utf), utf, Buffer.from([0])]);
    check('8-2', '别的工具写的标准 UTF-8 也能读', nbt.parse(raw2).value.a.value === '普通中文abc😀', nbt.parse(raw2).value.a.value);
  },
};

(async () => {
  await app.whenReady();
  const name = process.argv[process.argv.length - 1];
  if (!SCENARIOS[name]) { console.log(`场景：${Object.keys(SCENARIOS).join(' ')}`); finish(2); return; }
  try {
    await SCENARIOS[name]();
  } catch (e) {
    check(name, '脚本运行出错', false, e.stack || String(e));
  }
  finish();
})();
