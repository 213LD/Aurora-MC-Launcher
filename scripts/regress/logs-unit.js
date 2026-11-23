'use strict';
/**
 * 日志中心主进程部分的快速测试（rc9）：不开窗口，放在 npm test 里。
 * 以前日志中心只在 40 分钟的全面测试（rc4-ui.js）里有，快速回归完全碰不到它；
 * 变异实验里「正在运行的日志不能删」「一局最多 20 MB」「导出整份」这几条改坏了也没有测试会失败。
 *   electron scripts/regress/logs-unit.js all
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const H = require('./harness');

const { setup, core, ipc, check, finish, sleep, waitFor } = H;

app.whenReady().then(async () => {
  try {
    const { data, root } = setup('logs-unit');
    const config = core('config');
    config.load();
    config.set({ logs: { keepDays: 30 } });
    const gamelogs = core('gamelogs');
    const dir = gamelogs.dir();
    const idx = () => JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).items;
    let n = 0;
    const game = (extra = {}) => ({ id: `g${++n}`, versionId: 'Fab', startedAt: Date.now(), test: false, account: 'Steve', ...extra });
    // 这一局记进索引是 begin() 在后台写的：等它写好再往下。不等的话机器忙时文件建好了、索引还没写，列表是空的，后面几项跟着全错
    const begin = async (g) => { gamelogs.begin(g); await waitFor(async () => (await gamelogs.list()).some((x) => x.id === g.logId), 10000); };

    // ── 写、收尾、列表 ──
    const g1 = game();
    await begin(g1);
    gamelogs.write(g1, '[12:00:00] [main/INFO]: Setting user: Steve');
    gamelogs.write(g1, '[12:00:01] [Render thread/WARN]: careful');
    gamelogs.write(g1, 'java.lang.RuntimeException: boom');
    gamelogs.write(g1, '\tat com.example.Mod.init(Mod.java:10)');
    await waitFor(() => { try { return fs.readFileSync(path.join(gamelogs.dir(), `${g1.logId}.log`), 'utf8').includes('Mod.java:10'); } catch { return false; } }, 5000);
    let list = await gamelogs.list();
    check('写', '游戏开着时：列表里这一局是「正在运行」', list.length === 1 && list[0].id === g1.logId && list[0].state === 'running', list.map((x) => `${x.id}:${x.state}`));
    const delRunning = await gamelogs.remove(g1.logId).then(() => 'deleted', (e) => e.message);
    check('删除', '正在运行的这一局不能删，文件还在', /不能删除/.test(delRunning) && fs.existsSync(path.join(dir, `${g1.logId}.log`)), delRunning);
    const cleared = await gamelogs.clear();
    check('删除', '「清除全部」跳过正在运行的', cleared === 0 && (await gamelogs.list()).length === 1, { cleared });
    Object.assign(g1, { endedAt: Date.now() + 1000, exitCode: 1, killed: false, crash: { reasons: ['Mod 加载失败'], reportPath: null } });
    await gamelogs.finish(g1);
    list = await gamelogs.list();
    const it = list[0];
    check('收尾', '结束后：记下退出代码、结束时间、崩溃原因、大小', it.state === 'exited' && it.exitCode === 1 && it.endedAt > it.startedAt && it.crash && it.crash.reasons[0] === 'Mod 加载失败' && it.bytes > 50, it);
    const text = fs.readFileSync(path.join(dir, `${g1.logId}.log`), 'utf8');
    check('写', '文件里就是游戏的原文，一行不少', text.split('\n').filter(Boolean).length === 4 && text.includes('Setting user: Steve') && text.includes('Mod.java:10'), text.slice(0, 200));

    // ── 等级 ──
    const r1 = await gamelogs.read(g1.logId);
    check('等级', '带标记的按标记；报错和堆栈是 ERROR', r1.lines.map((l) => l.level).join(',') === 'INFO,WARN,ERROR,ERROR', r1.lines.map((l) => l.level));
    const lv = gamelogs.levels(['[INFO] [thread/WARN]: both', '[SEVERE] old', '[WARNING] old', '[Aurora] 警告：没找到 Java', '[Aurora] 启动 Fab', 'plain line']).map((l) => l.level);
    check('等级', '两种标记都有时按 [线程/等级]；老写法的 SEVERE、WARNING；启动器自己的说明', lv.join(',') === 'WARN,ERROR,WARN,WARN,INFO,INFO', lv);
    // 实时日志（launcher.js）和这里认标记用的是同一份规则
    const { tagged } = core('loglevel');
    const sample = ['[12:00:00] [main/INFO]: x', '[12:00:00] [main/FATAL]: x', '[INFO] [a/ERROR]: x', '[WARNING] x', '[SEVERE] x', 'no tag'];
    check('等级', '认标记的规则只有一份（loglevel.js），日志中心和它结果一样', sample.every((s) => (tagged(s) || 'INFO') === gamelogs.levels([s])[0].level), sample.map((s) => `${tagged(s)}/${gamelogs.levels([s])[0].level}`));

    // ── 分页读、导出整份 ──
    const g2 = game({ startedAt: Date.now() + 10 });
    await begin(g2);
    for (let i = 0; i < 25000; i++) gamelogs.write(g2, `[12:00:00] [Render thread/INFO]: line ${i}`);
    Object.assign(g2, { endedAt: Date.now() + 2000, exitCode: 0 });
    await gamelogs.finish(g2);
    const tail = await gamelogs.read(g2.logId, { tail: 3000 });
    check('读', '默认只读最后 3000 行，知道一共多少行', tail.lines.length === 3000 && tail.total === 25000 && tail.start === 22000 && / line 24999$/.test(tail.lines[2999].text), { n: tail.lines.length, total: tail.total, start: tail.start });
    const more = await gamelogs.read(g2.logId, { tail: 5000, before: tail.total - tail.start });
    check('读', '「显示更早的」接着往前读，不重不漏', more.lines.length === 5000 && more.start === 17000 && / line 17000$/.test(more.lines[0].text) && / line 21999$/.test(more.lines[4999].text), { n: more.lines.length, start: more.start, first: more.lines[0].text, last: more.lines[4999].text });
    const out = path.join(root, 'exported.log');
    await gamelogs.exportTo(g2.logId, out);
    const exported = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
    check('导出', '导出的是整份：25000 行一行不少（以前只有最后 20000 行）', exported.length === 25000 && / line 0$/.test(exported[0]) && / line 24999$/.test(exported[24999]), { n: exported.length, first: exported[0] });
    const bus = ipc();
    check('导出', '有导出接口；不认识的日志报清楚', bus.has('logs:export') && /不在了/.test((await bus.call('logs:export', 'nope')).error || ''), await bus.call('logs:export', 'nope'));

    // ── 一局最多 20 MB ──
    const g3 = game({ startedAt: Date.now() + 20 });
    await begin(g3);
    const big = 'x'.repeat(1024 * 1024 - 1);
    for (let i = 0; i < 23; i++) gamelogs.write(g3, big);
    gamelogs.write(g3, 'after the cap');
    Object.assign(g3, { endedAt: Date.now() + 3000, exitCode: 0 });
    await gamelogs.finish(g3);
    const size = fs.statSync(path.join(dir, `${g3.logId}.log`)).size;
    const end = fs.readFileSync(path.join(dir, `${g3.logId}.log`), 'utf8').slice(-80);
    check('上限', '一局写到 20 MB 就不再写，文件末尾说明一句', size <= gamelogs.MAX_BYTES + 200 && size > 19 * 1024 * 1024 && /不再保存/.test(end) && !/after the cap/.test(end), { mb: (size / 1048576).toFixed(2), end });

    // ── 按天清理、索引 ──
    const old = { id: 'old-1', file: 'old-1.log', versionId: 'Plain', startedAt: Date.now() - 40 * 86400000, endedAt: Date.now() - 40 * 86400000 + 60000, state: 'exited', exitCode: 0 };
    const ghost = { id: 'ghost-1', file: 'ghost-1.log', versionId: 'Plain', startedAt: Date.now() - 3600000, endedAt: Date.now() - 3000000, state: 'exited', exitCode: 0 };
    fs.writeFileSync(path.join(dir, 'old-1.log'), 'old\n');
    const store = core('jsonstore');
    await store.update(path.join(dir, 'index.json'), (x) => { x.items.push(old, ghost); return x; }, { label: '日志索引', fallback: { items: [] } });
    const before = idx().map((x) => x.id);
    const pruned = await gamelogs.prune();
    const after = idx().map((x) => x.id);
    check('清理', '保存 30 天：40 天前的那份删了，文件也没了，别的都在', pruned === 1 && !fs.existsSync(path.join(dir, 'old-1.log')) && !after.includes('old-1') && [g1, g2, g3].every((g) => after.includes(g.logId)), { before, after, pruned });
    check('清理', '文件已经不在的那一条也从索引里去掉（玩家自己在文件夹里删的）', before.includes('ghost-1') && !after.includes('ghost-1'), { before, after });
    config.set({ logs: { keepDays: 0 } });
    fs.writeFileSync(path.join(dir, 'old-2.log'), 'old\n');
    await store.update(path.join(dir, 'index.json'), (x) => { x.items.push({ ...old, id: 'old-2', file: 'old-2.log' }); return x; }, { label: '日志索引', fallback: { items: [] } });
    const kept = await gamelogs.prune();
    check('清理', '「一直保存」时什么都不删', kept === 0 && fs.existsSync(path.join(dir, 'old-2.log')), { kept });

    // ── 索引被改坏：文件名只当文件名用 ──
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'do not read');
    await store.update(path.join(dir, 'index.json'), (x) => { x.items.push({ ...ghost, id: 'evil', file: path.relative(dir, secret) }); return x; }, { label: '日志索引', fallback: { items: [] } });
    const evil = await gamelogs.read('evil').then((r) => r.lines.map((l) => l.text).join('|'), (e) => `ERR ${e.message}`);
    const evilDel = await gamelogs.remove('evil').then(() => 'ok', (e) => `ERR ${e.message}`);
    check('安全', '索引里的文件名指到日志文件夹外面：读不到、删不到', !/do not read/.test(evil) && fs.existsSync(secret), { evil, evilDel });
    void data;
  } catch (e) {
    check('脚本', '脚本运行出错', false, e.stack || String(e));
  }
  finish();
});
app.on('window-all-closed', () => {});
