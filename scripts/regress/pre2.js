'use strict';
/**
 * 文件和路径引擎的回归（2.0.0-pre2）。编号是修这些问题时用的条目号。修之前修之后都能跑，方便对比。
 * 单独跑：electron scripts/regress/pre2.js <场景>
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const H = require('./harness');
const { connect, waitExit, freePort, NO_THROTTLE } = require('./cdp');

const { sleep, waitFor, setup, core, ipc, lockFile, fakeVersion, tree, check, finish, REPO } = H;
const rules = require(path.join(REPO, 'src', 'shared', 'pathrules.js'));
const refused = (r) => !r.ok;
const OPTIONS = 'version:3465\nrenderDistance:12\ngraphicsMode:1\nkey_key.jump:key.keyboard.space\nkey_key.sneak:key.keyboard.left.shift\nonboardAccessibility:false\n';

/** 模拟写到一半断电：writeFile 写一半就报错，写的是 target 本身还是临时文件都一样对待 */
function breakWrites(match) {
  const orig = fsp.writeFile;
  fsp.writeFile = async (p, data, opts) => {
    if (match.test(String(p))) {
      const text = Buffer.from(data);
      await orig.call(fsp, p, text.subarray(0, Math.floor(text.length / 3)));
      throw Object.assign(new Error('磁盘满了（模拟）'), { code: 'ENOSPC' });
    }
    return orig.call(fsp, p, data, opts);
  };
  return () => { fsp.writeFile = orig; };
}

const SCENARIOS = {
  // ── 12-5 玩家文件直接覆盖写 ──
  async 'write-atomic'() {
    const { game } = setup('pre2-write');
    const file = path.join(game, 'options.txt');
    const cases = [
      ['hardware.lowerGraphics', () => core('hardware').lowerGraphics(game, { renderDistance: 6, graphicsMode: 0 })],
      ['hardware.restoreOptions', () => core('hardware').restoreOptions(game, { renderDistance: '12' })],
      ['integrity.unbindConflicts', () => core('integrity').unbindConflicts(game, ['key.jump'])],
      ['integrity.restoreKeys', () => core('integrity').restoreKeys(game, { 'key_key.jump': 'key.keyboard.space' })],
    ];
    for (const [name, run] of cases) {
      await fsp.writeFile(file, OPTIONS);
      const fix = breakWrites(/options\.txt/);
      const err = await run().then(() => null, (e) => e.message);
      fix();
      const after = await fsp.readFile(file, 'utf8');
      check('12-5', `${name}：写到一半失败，options.txt 还是完整的`, after === OPTIONS, { err, keptBytes: after.length, fullBytes: OPTIONS.length });
      const left = (await fsp.readdir(game)).filter((n) => n.includes('tmp'));
      check('12-5', `${name}：没留下临时文件`, !left.length, left);
    }
    // 成功时内容对
    await fsp.writeFile(file, OPTIONS);
    await core('hardware').lowerGraphics(game, { renderDistance: 6, graphicsMode: 0 });
    check('12-5', '正常写入：内容改了', /renderDistance:6/.test(await fsp.readFile(file, 'utf8')));
  },

  // level.dat 这种写坏了世界就进不去的
  async 'write-atomic-nbt'() {
    const { game } = setup('pre2-nbt');
    const nbt = core('nbt');
    const file = path.join(game, 'level.dat');
    const zlib = require('zlib');
    const root = { name: '', value: { Data: { type: nbt.T.COMPOUND, value: { LevelName: { type: nbt.T.STRING, value: '原来的名字' } } } } };
    await fsp.writeFile(file, zlib.gzipSync(nbt.serialize(root)));
    const before = await fsp.readFile(file);
    const fix = breakWrites(/level\.dat/);
    const err = await nbt.setLevelName(file, '新名字').then(() => null, (e) => e.message);
    fix();
    const after = await fsp.readFile(file);
    check('12-5', '改世界名字：写到一半失败，level.dat 还是完整的（世界还能进）', Buffer.compare(before, after) === 0, { err, before: before.length, after: after.length });
    await nbt.setLevelName(file, '新名字');
    const info = await nbt.levelInfo(file).catch(() => null);
    check('12-5', '改世界名字：正常写入有效', !!info, info);
    check('12-5', '没留下临时文件', !(await fsp.readdir(game)).some((n) => n.includes('tmp')), await fsp.readdir(game));
  },

  // ── 10-3 退出时没有 flush ──
  async 'quit-flush'() {
    const { root } = setup('pre2-quit');
    const data = path.join(root, 'app-data');
    const game = path.join(root, 'app-game');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, tips: { noJava: true, panHint: { runs: 3 } }, language: 'zh-CN', gameDir: game }));
    const port = await freePort();
    const child = spawn(process.execPath, [`--remote-debugging-port=${port}`, ...NO_THROTTLE, '.'], { cwd: REPO, stdio: 'ignore', windowsHide: true, env: { ...process.env, AURORA_DATA_DIR: data, AURORA_GAME_DIR: game, AURORA_SHOT_DIR: path.join(root, 's'), AURORA_SHOT_PAGES: '-#start', AURORA_SHOT_KEEP: '1', AURORA_TEST_TRASH: path.join(root, 'trash') } });
    const c = await connect(port);
    await c.send('Runtime.enable');
    const t0 = Date.now();
    // 改完马上关，防抖的 200 毫秒还没到
    await c.ev("A.setConfig({ pre2QuitMark: 'written-before-quit' }); 1");
    await c.quit();
    const exited = await waitExit(child, 15000);
    const took = Date.now() - t0;
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check('10-3', '改完设置马上退出：改动写下去了', cfg.pre2QuitMark === 'written-before-quit', { mark: cfg.pre2QuitMark, took });
    check('10-3', '程序能正常退出，不会卡住', exited && took < 8000, { took });
  },

  // ── 7-8 flush 失败不告诉任何人 ──
  async 'flush-retry'() {
    const { data } = setup('pre2-flush');
    const config = core('config');
    const store = core('jsonstore');
    const seen = [];
    store.drain((n) => seen.push(n));
    config.get();
    config.set({ pre2Mark: 'one' });
    await config.flush();
    const file = path.join(data, 'config.json');
    const release = await lockFile(file, 'None', 30);
    config.set({ pre2Mark: 'locked-while-saving' });
    await config.flush();
    await waitFor(() => seen.some((n) => /保存不了/.test(n.title)), 10000);
    check('7-8', '写不进去：告诉玩家了', seen.some((n) => /保存不了/.test(n.title)), seen.map((n) => n.title));
    await release();
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).pre2Mark === 'locked-while-saving'; } catch { return false; } }, 30000);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('7-8', '占用解除后：自动重试写进去了，不用等下一次改设置', after.pre2Mark === 'locked-while-saving', { mark: after.pre2Mark });
    check('7-8', '写进去以后：告诉玩家好了', seen.some((n) => /已经保存好了/.test(n.title)), seen.map((n) => n.title));
    // 乱序：连着改很多次，最后一次的内容留下
    for (let i = 0; i < 30; i++) { config.set({ pre2Order: i }); config.flush(); }
    await config.flush();
    check('7-8', '连续保存 30 次：磁盘上是最后一次', JSON.parse(fs.readFileSync(file, 'utf8')).pre2Order === 29);
  },

  // ── 5-2 路径防护 ──
  async 'path-scope'() {
    const { game } = setup('pre2-scope');
    const bus = ipc();
    const backup = core('backup');
    const vs = core('versions').versionsDir();
    fs.mkdirSync(vs, { recursive: true });
    const sibling = `${vs}2`;
    fs.mkdirSync(sibling, { recursive: true });
    const outside = path.join(sibling, 'x.log');
    fs.writeFileSync(outside, 'x');
    const r = await bus.call('profiles:openLog', outside);
    check('5-2', 'versions2 里的文件不能当成 versions 里的打开', refused(r), r);
    const inside = path.join(vs, 'x.log');
    fs.writeFileSync(inside, 'x');
    const shell = require('electron').shell;
    const orig = shell.openPath;
    let opened = null;
    shell.openPath = async (p) => { opened = p; return ''; };
    const r2 = await bus.call('profiles:openLog', inside);
    shell.openPath = orig;
    check('5-2', 'versions 里面的文件照常能打开', r2.ok && opened === inside, r2);
    const bak = backup.root();
    fs.mkdirSync(`${bak}2`, { recursive: true });
    const victim = path.join(`${bak}2`, 'keep.zip');
    fs.writeFileSync(victim, 'x');
    const del = await backup.remove(victim).then(() => 'deleted', (e) => e.message);
    check('5-2', 'backups2 里的文件不能当成备份删掉', fs.existsSync(victim), del);
    const dir = await bus.call('backup:dir');
    check('walk', '还没做过备份时，「打开备份文件夹」也打得开', dir.ok && fs.existsSync(dir.data), dir);
    void game;
  },

  // ── 10-4、8-3 名字 ──
  async 'names'() {
    setup('pre2-names');
    const versions = core('versions');
    const ok = (n) => { try { versions.validateName(n); return true; } catch { return false; } };
    for (const n of ['a;b', 'CON', 'con', 'NUL', 'nul.txt', 'COM1', 'LPT9.foo', 'x.', 'x ', 'a/b', 'a\\b', 'a:b', '', '   ', 'x'.repeat(81)]) {
      check('10-4', `拒绝名字「${n.slice(0, 20)}」`, !ok(n));
    }
    for (const n of ['1.20.1', '我的 整合包', 'Fabric 1.20.1 (副本)', 'console', 'nullable', 'com10', 'A.B', '世界🌍']) {
      check('10-4', `接受名字「${n}」`, ok(n));
    }
    const { uniqueName } = core('modpack');
    const emoji = `${'字'.repeat(59)}🌍后面`; // 第 60 个字符正好是 emoji
    const dot = `${'a'.repeat(59)}.b`; // 截断后结尾是点
    const shout = async (input) => { const n = await uniqueName(input); return n; };
    const n1 = await shout(emoji);
    check('8-3', '整合包名字截断不切开 emoji', !/[\ud800-\udbff]$/.test(n1) && !/^[\udc00-\udfff]/.test(n1) && ok(n1), { tail: n1.slice(-3), ok: ok(n1) });
    const n2 = await shout(dot);
    check('8-3', '整合包名字截断后结尾不是点，能通过校验', ok(n2), { tail: n2.slice(-3) });
    const n3 = await shout('CON');
    check('8-3', '整合包叫 CON：换一个能用的名字', ok(n3), n3);
    const n4 = await shout('a;b');
    check('8-3', '整合包名字带分号：换掉', ok(n4), n4);
    const n5 = await shout('...');
    check('8-3', '整合包名字全是点：用默认名字', ok(n5), n5);
    // 共用规则本身
    check('8-3', 'cutChars 不切开组合字符', rules.cutChars('e\u0301e\u0301e\u0301', 2) === 'e\u0301e\u0301');
    check('8-3', 'cutChars 不切开 emoji 家庭', rules.cutChars('👨‍👩‍👧‍👦👍', 1) === '👨‍👩‍👧‍👦');
    check('8-3', 'cutChars 结尾加省略号，总长不超', rules.cutChars('一二三四五六', 4, '…') === '一二三…');
    check('8-3', 'cutChars 够短不动', rules.cutChars('一二三', 3, '…') === '一二三');
    check('8-3', '渲染进程也用这份规则', fs.readFileSync(path.join(REPO, 'src/renderer/index.html'), 'utf8').includes('../shared/pathrules.js'));
  },

  // ── 10-5 导入包路径 ──
  async 'pack-traversal'() {
    const { root, data, game } = setup('pre2-pack');
    const migrate = core('migrate');
    const tasks = core('tasks');
    const { ZipWriter } = core('zip');
    const pack = path.join(data, `evil.${migrate.EXT}`);
    // 先导出一个合法的包，拿到真实的清单格式
    const t1 = new tasks.Task('导出');
    await core('planner').savePlan({ id: 'p1', name: '方案' });
    await migrate.exportData({ ...migrate.DEFAULT_OPTS, plans: true, settings: false, accounts: false, skins: false }, [], pack, t1);
    const { withZip } = core('zip');
    const manifestName = 'aurora-export.json';
    const manifest = await withZip(pack, (z) => z.readText(manifestName));
    const m = JSON.parse(manifest).data;
    const evil = ['game/root/..\\..\\..\\pre2-evil-1.txt', 'game\\root\\..\\..\\pre2-evil-2.txt', 'game/root/saves/x/../../../../pre2-evil-3.txt', 'game/root/C:\\pre2-evil-4.txt', 'game/root/.. /pre2-evil-5.txt', 'game/root/NUL', 'game/root/a.txt:stream'];
    const body = Buffer.from('evil');
    const crc = crc32(body);
    m.files = [...(m.files || []), ...evil.map((p) => ({ path: p, size: body.length, crc }))];
    const out = path.join(data, `evil2.${migrate.EXT}`);
    const zw = await ZipWriter.create(out);
    // 清单外面还包了一层信封（带校验），改完 files 要重新封一次
    await zw.addBuffer(manifestName, Buffer.from(core('envelope').seal(migrate.KIND, m)));
    for (const p of evil) await zw.addBuffer(p, body);
    await zw.close();
    const info = await migrate.inspect({ file: out }).catch((e) => ({ err: e.message }));
    const unsafeProblem = (info.problems || []).find((x) => x.code === 'unsafe');
    check('10-5', '检查导入包时：说得出路径不正常', !!unsafeProblem && new RegExp(`${evil.length} 个`).test(unsafeProblem.text), info.problems || info);
    const t2 = new tasks.Task('导入');
    await migrate.importData({ file: out }, { plans: true, settings: false, accounts: false, skins: false, profiles: {}, root: true, rootItems: true }, t2).catch((e) => console.log(`  导入：${e.message}`));
    const found = [];
    const look = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) { const p = path.join(d, e.name); if (/pre2-evil-d/.test(e.name)) found.push(path.relative(root, p)); else if (e.isDirectory()) await look(p); } };
    await look(path.dirname(root)); // 隔离目录
    // 再往上三层只看文件名（恶意路径最多跑到这里），测完删掉
    let up = path.dirname(root);
    for (let i = 0; i < 3; i++) { up = path.dirname(up); for (const n of await fsp.readdir(up).catch(() => [])) if (/pre2-evil-d/.test(n)) found.push(path.relative(root, path.join(up, n))); }
    check('10-5', '恶意路径的文件一个都没写到外面', !found.length, found);
    for (const f of found) await fsp.rm(path.resolve(root, f), { force: true });
    const safeJoin = (() => { try { return core('fileops').safeJoin; } catch { return null; } })();
    if (safeJoin) {
      for (const p of ['..\\x', '../x', 'a/../../x', 'a\\..\\..\\x', 'C:\\x', 'C:x', '/x', '\\x', '\\\\srv\\x', '.. /x', '../', 'NUL', 'a/con.txt', 'a:b', '']) {
        let threw = false;
        try { safeJoin(game, p); } catch { threw = true; }
        check('10-5', `safeJoin 拒绝「${p}」`, threw);
      }
      for (const p of ['a.txt', 'a/b.txt', 'a\\b.txt', './a.txt', 'a/./b.txt', '中文 目录/文件.txt', '..a/b', 'a..b/c']) {
        let got = null;
        try { got = safeJoin(game, p); } catch { /* 不该抛 */ }
        check('10-5', `safeJoin 接受「${p}」`, !!got && got.startsWith(game + path.sep), got);
      }
    } else check('10-5', 'safeJoin 还没有', false);
  },

  // ── 10-6 网络接口的文件名 ──
  async 'net-names'() {
    const { root, game } = setup('pre2-netname');
    const cf = core('curseforge');
    const profiles = core('profiles');
    await fakeVersion('NetP');
    const mapped = cf.mapFile({ id: 1, modId: 2, displayName: 'x', fileName: '..\\..\\..\\pre2-evil.jar', fileLength: 1, downloadUrl: 'https://example.invalid/a.jar', gameVersions: ['1.20.1', 'Fabric'], dependencies: [], hashes: [] });
    const name = mapped.files[0].filename;
    check('10-6', 'CurseForge 给的文件名：只留最后一段', !/[\\/]/.test(name), name);
    check('10-6', 'CurseForge 给的文件名：不含 ..', !name.includes('..'), name);
    const mapped2 = cf.mapFile({ id: 1, modId: 2, displayName: 'x', fileName: 'normal-1.2.3+mc1.20.jar', fileLength: 1, downloadUrl: 'https://example.invalid/a.jar', gameVersions: [], dependencies: [], hashes: [] });
    check('10-6', '正常的文件名不变', mapped2.files[0].filename === 'normal-1.2.3+mc1.20.jar', mapped2.files[0].filename);
    // 存在配置档案里的手动下载清单（可能来自别人的导入包）
    // 跑出去的话会落在隔离目录（AURORA_REGRESS_DIR）里，不会碰到别处
    await profiles.writeMeta('NetP', { cfManual: [{ projectId: 1, fileId: 2, fileName: '..\\pre2-evil2.jar', folder: '..', title: 'x' }] });
    const srcDir = path.join(root, '来源');
    fs.mkdirSync(srcDir, { recursive: true });
    const src = path.join(srcDir, 'pre2-evil2.jar');
    fs.writeFileSync(src, 'x');
    const r = await cf.importManual('NetP', { files: [src] }).catch((e) => ({ err: e.message }));
    const landed = [path.join(game, '..', '..', 'pre2-evil2.jar'), path.join(game, '..', 'pre2-evil2.jar'), path.join(game, 'pre2-evil2.jar'), path.join(game, 'versions', 'pre2-evil2.jar')].filter((f) => fs.existsSync(f));
    check('10-6', '手动下载清单的路径不会跑到游戏目录外面', !landed.length, { r, landed });
    for (const f of landed) await fsp.rm(f, { force: true }).catch(() => {});
    void tree;
  },

  // ── 复制规则：跳过 session.lock 和联接 ──
  async 'copy-rules'() {
    await fsp.rm(path.join(H.BASE, 'pre2-copy'), { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); // 上次留下的联接，setup 的 rmSync 删不掉
    const { root } = setup('pre2-copy');
    const src = path.join(root, '来源 世界');
    const outside = path.join(root, '外面的目录');
    fs.mkdirSync(path.join(src, 'region'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, '原件.txt'), '原件');
    fs.writeFileSync(path.join(src, 'level.dat'), 'x');
    fs.writeFileSync(path.join(src, 'session.lock'), 'x');
    fs.writeFileSync(path.join(src, 'region', 'r.0.0.mca'), 'x');
    fs.symlinkSync(outside, path.join(src, 'link'), 'junction');
    const check1 = async (label, run, dest) => {
      const err = await run().then(() => null, (e) => e.message);
      if (err) { check('pre2', `${label}：带联接的目录能复制`, false, err.slice(0, 120)); return; }
      const list = await fsp.readdir(dest);
      check('pre2', `${label}：世界内容复制了`, list.includes('level.dat') && fs.existsSync(path.join(dest, 'region', 'r.0.0.mca')), list);
      check('pre2', `${label}：没带 session.lock`, !list.includes('session.lock'), list);
      check('pre2', `${label}：没带联接（写副本不会写到原件）`, !list.includes('link'), list);
    };
    const { copyWorld } = core('worldimport');
    await check1('导入世界', () => copyWorld(src, path.join(root, 'to1')), path.join(root, 'to1'));
    // 复制配置
    const profiles = core('profiles');
    const pdir = await fakeVersion('CopyP');
    fs.mkdirSync(path.join(pdir, 'saves', 'W'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'saves', 'W', 'level.dat'), 'x');
    fs.writeFileSync(path.join(pdir, 'saves', 'W', 'session.lock'), 'x');
    fs.symlinkSync(outside, path.join(pdir, 'saves', 'W', 'link'), 'junction');
    const derr = await profiles.duplicate('CopyP', 'CopyP2', {}).then(() => null, (e) => e.message);
    const dup = path.join(core('versions').versionDir('CopyP2'), 'saves', 'W');
    const list = derr ? [derr.slice(0, 100)] : await fsp.readdir(dup);
    check('pre2', '复制配置：世界复制了，没带 session.lock 和联接', list.includes('level.dat') && !list.includes('session.lock') && !list.includes('link'), list);
    // 取消
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await copyWorld(src, path.join(root, 'to2'), ctrl.signal).then(() => null, (e) => e);
    check('pre2', '取消：不留半个世界', !!err && !fs.existsSync(path.join(root, 'to2')), err && err.message);
    // 读不了的文件夹要报错（复制完可能要删原件）
    const location = require(path.join(REPO, 'src', 'main', 'engine', 'location.js'));
    const missing = await location.copyTree(path.join(root, '不存在的目录'), path.join(root, 'to3'), () => {}).then(() => 'no-error', (e) => e.code || e.message);
    check('pre2', '换存储位置时来源读不了：报错，不是悄悄跳过', missing !== 'no-error', missing);
    // 删除带联接的目录：只删联接，联接指向的原件不能动
    await core('util').rmrf(src);
    check('pre2', '删除带联接的目录：目录没了，联接指向的原件还在', !fs.existsSync(src) && fs.existsSync(path.join(outside, '原件.txt')), { srcGone: !fs.existsSync(src) });
  },

  // ── 以前人工测的：慢网、中途断开、一直失败、磁盘满 ──
  async 'net-flaky'() {
    const { root } = setup('pre2-net');
    const http = require('http');
    const crypto = require('crypto');
    const { downloadFile } = core('downloader');
    const tasks = core('tasks');
    const body = crypto.randomBytes(4 * 1024 * 1024);
    const sha1 = crypto.createHash('sha1').update(body).digest('hex');
    let hits = {};
    const server = http.createServer((req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1;
      if (req.url === '/ok') { res.end(body); return; }
      if (req.url === '/drop-once') {
        if (hits[req.url] === 1) { res.writeHead(200, { 'Content-Length': body.length }); res.write(body.subarray(0, 1024 * 1024)); setTimeout(() => req.socket.destroy(), 200); return; }
        res.end(body); return;
      }
      if (req.url === '/always-drop') { res.writeHead(200, { 'Content-Length': body.length }); res.write(body.subarray(0, 1024)); setTimeout(() => req.socket.destroy(), 50); return; }
      if (req.url === '/500') { res.writeHead(500); res.end('x'); return; }
      if (req.url === '/wrong') { res.end(Buffer.alloc(body.length)); return; }
      if (req.url === '/slow') {
        let i = 0; const chunk = 256 * 1024;
        res.writeHead(200, { 'Content-Length': body.length });
        const t = setInterval(() => { res.write(body.subarray(i, i + chunk)); i += chunk; if (i >= body.length) { clearInterval(t); res.end(); } }, 150);
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (url, name) => {
      const dest = path.join(root, 'dl', name);
      const task = new tasks.Task(name);
      const t0 = Date.now();
      const err = await downloadFile({ urls: [`${base}${url}`], path: dest, sha1, size: body.length }, { task, label: name }).then(() => null, (e) => e);
      return { err, ms: Date.now() - t0, exists: fs.existsSync(dest), ok: fs.existsSync(dest) && crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex') === sha1, left: fs.existsSync(path.join(root, 'dl')) ? fs.readdirSync(path.join(root, 'dl')).filter((n) => n.startsWith(name) && n !== name) : [] };
    };
    let r = await get('/ok', 'ok.bin');
    check('net', '正常下载', r.ok && !r.err, { ms: r.ms });
    r = await get('/slow', 'slow.bin');
    check('net', '慢网（约 1.7 MB/s）：下完，内容对', r.ok && !r.err, { ms: r.ms, err: r.err && r.err.message });
    r = await get('/drop-once', 'drop.bin');
    check('net', '下载中途断开一次：自动重试，内容对', r.ok && !r.err, { ms: r.ms, hits: hits['/drop-once'], err: r.err && r.err.message });
    r = await get('/always-drop', 'always.bin');
    check('net', '一直断开：最后报错，不留半个文件', !!r.err && !r.exists && !r.left.length, { ms: r.ms, err: r.err && r.err.message, left: r.left, hits: hits['/always-drop'] });
    r = await get('/500', 'e500.bin');
    check('net', '服务器 500：报错说得清', !!r.err && !r.exists, r.err && r.err.message);
    r = await get('/wrong', 'wrong.bin');
    check('net', '内容不对（校验失败）：报错，不留坏文件', !!r.err && !r.exists, { err: r.err && r.err.message });
    await new Promise((res) => server.close(res));
  },

  // ── 8-4 编码 ──
  async 'encoding'() {
    setup('pre2-enc');
    const { execFile } = require('child_process');
    const run = (cmd) => new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8', timeout: 20000 }, (e, o) => res(String(o || ''))));
    const plain = await run("'中文设备 测试' | ConvertTo-Json");
    console.log(`  不设编码读到：${plain.trim()}`);
    const hw = fs.readFileSync(path.join(REPO, 'src/main/core/hardware.js'), 'utf8');
    check('8-4', '硬件信息：PowerShell 输出设成 UTF-8', /PS_UTF8 \+ command|OutputEncoding/.test(hw));
    const procenc = (() => { try { return core('procenc'); } catch { return null; } })();
    if (!procenc) { check('8-4', '按行解码还没有', false); return; }
    const withPrefix = await run(`${procenc.PS_UTF8}'中文设备 测试' | ConvertTo-Json`);
    check('8-4', '设了编码：中文读得对', withPrefix.includes('中文设备 测试'), withPrefix.trim());
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 「中文」的 GBK
    const lines = [];
    const dec = procenc.lineDecoder((t) => lines.push(t));
    dec.write(Buffer.concat([gbk, Buffer.from(' 系统编码的报错\n'.replace(/[^\x00-\x7f]/g, '')), Buffer.from('UTF-8 的日志：世界\n')]));
    const utf = Buffer.from('切开的字\n');
    dec.write(utf.subarray(0, 2));
    dec.write(utf.subarray(2));
    dec.write(Buffer.from('没有换行的结尾'));
    dec.end();
    const all = lines.join('');
    check('8-4', '系统编码和 UTF-8 混着：都读得对', all.includes('中文') && all.includes('世界'), all);
    check('8-4', '多字节字符被切开：能接上', all.includes('切开的字'), all);
    check('8-4', '结束时没换行的部分也拿到', all.includes('没有换行的结尾'), all);
  },
};

// 和 zip.js 用的算法一样
function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}

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
