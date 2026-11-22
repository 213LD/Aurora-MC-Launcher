'use strict';
/**
 * 任务引擎和拆 ipc.js 的回归（2.0.0-pre3）。编号是修这些问题时用的条目号。修之前修之后都能跑，方便对比。
 * 单独跑：electron scripts/regress/pre3.js <场景>
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { app } = require('electron');
const H = require('./harness');

const { sleep, waitFor, setup, core, ipc, check, finish, REPO } = H;

const SCENARIOS = {
  // ── 1-8 下载进度每个数据块都排序一次 ──
  async 'dl-report'() {
    const { root } = setup('pre3-dl');
    const { downloadAll } = core('downloader');
    const tasks = core('tasks');
    const body = crypto.randomBytes(48 * 1024 * 1024);
    const sha1 = crypto.createHash('sha1').update(body).digest('hex');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/f`;
    const files = Array.from({ length: 6 }, (_, i) => ({ urls: [`${url}${i}`], path: path.join(root, 'dl', `f${i}.bin`), sha1, size: body.length }));
    const task = new tasks.Task('下载测试');
    let updates = 0;
    const orig = task.update.bind(task);
    task.update = (p) => { updates++; orig(p); };
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    await downloadAll(files, { task, label: '下载' });
    const ms = Date.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuSec = ((cpu.user + cpu.system) / 1e6).toFixed(2);
    const perSec = Math.round(updates / (ms / 1000));
    console.log(`  288 MB 下载 ${ms} ms，算了 ${updates} 次进度（每秒 ${perSec} 次），主进程 CPU ${cpuSec} 秒`);
    check('1-8', '进度每秒最多算 25 次，不是每个数据块一次', perSec <= 25, { updates, ms, perSec, cpuSec });
    check('1-8', '进度最后是 100%，文件数对', task.progress === 1 && task.files.done === 6 && task.bytes.done === body.length * 6, { progress: task.progress, files: task.files, bytes: task.bytes });
    check('1-8', '文件都下载对了', files.every((f) => fs.statSync(f.path).size === body.length));
    await new Promise((r) => server.close(r));
  },

  // ── 任务引擎 ──
  async 'task-engine'() {
    setup('pre3-engine');
    const tasks = core('tasks');
    if (!tasks.start) { check('engine', '任务引擎还没有', false); return; }
    const events = [];
    tasks.setBroadcaster((ch, p) => { if (ch === 'task:update') events.push(p); });
    const last = (id) => events.filter((e) => e.id === id).pop();
    const waitDone = async (id) => { for (let i = 0; i < 200 && tasks.get(id).status === 'running'; i++) await sleep(10); return tasks.get(id); }; // pitfall-ok：轮询里两次查看之间的间隔

    // 成功
    const seen = [];
    let id = tasks.start({ title: '成功的任务', kind: 'mod', doneText: '好了' }, async () => 42, (err, r) => seen.push({ err, r }));
    let t = await waitDone(id);
    check('engine', '成功：状态、文字、回调结果', t.status === 'done' && t.detail === '好了' && seen[0].r === 42 && !seen[0].err, seen);

    // 失败：谁来提示写在任务上
    const notes = [];
    tasks.setNotifier((n) => notes.push(n));
    id = tasks.start({ title: '会失败', kind: 'mod', failTitle: '下载失败' }, async () => { throw new Error('网络坏了'); });
    t = await waitDone(id);
    check('engine', '失败：主进程发一条提示', notes.length === 1 && notes[0].level === 'crit' && notes[0].title === '下载失败' && /网络坏了/.test(notes[0].text), notes);
    check('engine', '失败：任务上标了「已经提示过」，界面不再提示', last(id).notice === 'main', last(id).notice);
    id = tasks.start({ title: '界面提示', kind: 'mcmod' }, async () => { throw new Error('x'); });
    await waitDone(id);
    check('engine', '没有写 failTitle：交给界面提示', last(id).notice === 'task', last(id).notice);
    const r = await tasks.run({ title: '调用方自己处理', kind: 'backup' }, async () => { throw new Error('y'); }).then(() => null, (e) => e.message);
    const ranId = events[events.length - 1].id;
    check('engine', 'run：错误抛给调用方，界面不提示', r === 'y' && last(ranId).notice === 'caller', { r, notice: last(ranId).notice });

    // 取消不提示
    notes.length = 0;
    id = tasks.start({ title: '取消', kind: 'mod', failTitle: '失败了' }, async (task) => { await sleep(30); if (task.signal.aborted) throw Object.assign(new Error('已取消'), { cancelled: true }); }); // pitfall-ok：任务里模拟干一会儿活（好在中途取消）
    tasks.cancel(id);
    t = await waitDone(id);
    check('engine', '取消：不提示失败', t.status === 'cancelled' && notes.length === 0, { status: t.status, notes });

    // 重试：参数一样
    let runs = 0;
    id = tasks.start({ title: '第一次失败', kind: 'mod', failTitle: '失败' }, async () => { runs++; if (runs === 1) throw new Error('第一次'); return 'ok'; });
    t = await waitDone(id);
    check('engine', '失败后可以重试', t.retryable === true, t.retryable);
    const nid = t._retry();
    t = await waitDone(nid);
    check('engine', '重试成功，新任务记着来自哪个', t.status === 'done' && t.retryOf === id && runs === 2, { status: t.status, retryOf: t.retryOf, runs });

    // 按配置互斥
    let release;
    const hold = new Promise((res) => { release = res; });
    id = tasks.start({ title: '占着 A', kind: 'install', lock: 'A' }, () => hold);
    const blocked = (() => { try { tasks.start({ title: '也要 A', kind: 'install', lock: 'A' }, async () => 1); return null; } catch (e) { return e.message; } })();
    check('engine', '同一个配置：第二个任务被拦下，说得清是什么在占着', /占着 A/.test(blocked || ''), blocked);
    let other = null;
    try { other = tasks.start({ title: '要 B', kind: 'install', lock: 'B' }, async () => 1); } catch { /* 不该抛 */ }
    check('engine', '别的配置不受影响', !!other);
    await waitDone(other);
    check('engine', 'assertFree 也认得占用', (() => { try { tasks.assertFree('A'); return false; } catch { return true; } })());
    release();
    await waitDone(id);
    check('engine', '任务结束后解除占用', (() => { try { tasks.assertFree('A'); return true; } catch { return false; } })());
    // 失败也要解除
    id = tasks.start({ title: '失败解锁', kind: 'install', lock: 'C' }, async () => { throw new Error('x'); });
    await waitDone(id);
    check('engine', '失败后也解除占用', (() => { try { tasks.assertFree('C'); return true; } catch { return false; } })());
    // 多个配置一起占
    const hold2 = new Promise((res) => { release = res; });
    const p = tasks.run({ title: '占两个', kind: 'backup', lock: ['D', 'E'] }, () => hold2);
    await waitFor(() => ['D', 'E'].every((x) => { try { tasks.assertFree(x); return false; } catch { return true; } }), 3000);
    check('engine', '一个任务可以占多个配置', ['D', 'E'].every((x) => { try { tasks.assertFree(x); return false; } catch { return true; } }));
    release();
    await p;
    check('engine', '都解除', ['D', 'E'].every((x) => { try { tasks.assertFree(x); return true; } catch { return false; } }));
  },

  // ── 7-9 启动中再点：主进程报专门的错误码，界面按普通提示显示 ──
  async 'launch-guard'() {
    const { game, data } = setup('pre3-launch');
    await H.fakeVersion('GuardP');
    await core('auth/accounts').addOffline('GuardPlayer');
    // 假配置要 Java 8：放一个假的，不然启动器先上网下载（fake-java.js）
    require('./fake-java').fakeJava(game, 8);
    const found = await core('java').detect(true);
    check('7-9', '确认场景成立：测试目录里有一个 Java 8，启动时不用上网下载', found.some((j) => j.major === 8 && /fake-java-8/.test(j.home)), found.map((j) => `${j.major}:${j.source}`).join(' '));
    void data;
    const bus = ipc();
    const [a, b] = await Promise.all([bus.call('launch:start', 'GuardP', {}), bus.call('launch:start', 'GuardP', {})]);
    check('7-9', '同时启动两次：第二次报 ALREADY_LAUNCHING', !b.ok && b.reason && b.reason.code === 'ALREADY_LAUNCHING', b);
    check('7-9', '第一次走正常流程（假配置没有 jar，报缺文件）', !a.ok && !(a.reason && a.reason.code === 'ALREADY_LAUNCHING'), String(a.error).slice(0, 80));
    const c = await bus.call('launch:start', 'GuardP', {});
    check('7-9', '结束后可以再启动，没有一直占着', !(c.reason && c.reason.code === 'ALREADY_LAUNCHING'), String(c.error).slice(0, 80));
  },

  // ── 拆 ipc.js：接口一个都不能少，preload 白名单都放行 ──
  async 'ipc-split'() {
    setup('pre3-ipc');
    const bus = ipc();
    const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'ipc-channels.json'), 'utf8'));
    const missing = expected.filter((c) => !bus.has(c));
    check('ipc', `拆完以后 ${expected.length} 个接口都还在`, !missing.length, missing.slice(0, 20));
    const main = fs.readFileSync(path.join(REPO, 'src', 'main', 'ipc.js'), 'utf8');
    const lines = main.split(/\r?\n/).length;
    check('ipc', 'ipc.js 只留转发（200 行以内，没有具体的 handle）', lines <= 200 && !/\bhandle\('/.test(main), { lines });
    const preload = fs.readFileSync(path.join(REPO, 'src', 'main', 'preload.js'), 'utf8');
    const nsMatch = preload.match(/NAMESPACES\s*=\s*(?:new Set\()?\[([^\]]*)\]/);
    const namespaces = nsMatch ? nsMatch[1].match(/'([^']+)'/g).map((x) => x.replace(/'/g, '')) : [];
    const blocked = expected.filter((c) => !namespaces.includes(c.split(':')[0]));
    check('ipc', '所有接口的命名空间都在 preload 白名单里', namespaces.length > 0 && !blocked.length, blocked.slice(0, 10));
    // 几个代表性接口真的能调
    const a = await bus.call('config:get');
    check('ipc', 'config:get 能调', a.ok && !!a.data, a.error || '');
    const b = await bus.call('tasks:list');
    check('ipc', 'tasks:list 能调', b.ok && Array.isArray(b.data), b.error || '');
    const c = await bus.call('versions:installed');
    check('ipc', 'versions:installed 能调', c.ok && Array.isArray(c.data), c.error || '');
    const d = await bus.call('nope:nope');
    check('ipc', '不存在的接口报错', !d.ok, d);
    // rc11 按钮走查发现的两个「打开文件夹」：点了报错
    const e = await bus.call('versions:dir', '', 'version');
    check('ipc', '游戏配置页的「打开版本文件夹」：不带配置名时给 versions 文件夹（2.0.0-pre2 起一直报「不安全的路径」）', e.ok && /versions$/.test(String(e.data)) && fs.existsSync(e.data), e.ok ? e.data : e.error);
    const e2 = await bus.call('versions:dir', '../x', 'version');
    check('ipc', '带了不安全的配置名照样拒绝', !e2.ok && /不安全/.test(e2.error || ''), e2.error || e2.data);
    const logsDir = path.join(core('paths').dataDir(), 'logs', 'games');
    const before = fs.existsSync(logsDir);
    const f = await bus.call('logs:dir');
    check('ipc', '日志中心的「打开文件夹」：还没玩过游戏、文件夹不存在时先建出来（以前报「路径不存在」）', !before && f.ok && fs.existsSync(f.data), { before, f });
    // rc12 按钮走查（走到第二层）发现的：存档与备份 → 打开存档文件夹，没玩过的配置报「路径不存在」
    await H.fakeVersion('NoSaves');
    const savesDir = path.join(core('versions').versionDir('NoSaves'), 'saves');
    const sBefore = fs.existsSync(savesDir);
    const g = await bus.call('backup:savesDir', 'NoSaves');
    check('ipc', '存档与备份的「打开存档文件夹」：还没玩过的配置，存档文件夹不存在时先建出来', g.ok && fs.existsSync(g.data), { sBefore, g });
    void sleep;
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
