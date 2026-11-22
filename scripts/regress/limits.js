'use strict';
/**
 * 大数据量和边界条件（2.0.0-pre8 之后，全面测试中优先级）。真实窗口，关在隔离层里。
 *   node scripts/regress/limits.js [场景,场景]
 * - scale     300 个配置、一个配置 3000 个 Mod、500 个世界、20 万行日志：页面开得出来，不报错，时间记下来
 * - bad-dirs  游戏目录没了、是文件、在不存在的盘上；mods、saves、versions 是文件；只读目录
 * - names     配置和世界的名字带 emoji、特殊符号、很长，路径接近 260 个字符
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { start, visitAll, fakeVersion, BASE_CONFIG } = require('./robust-ui');
const { sleep, ready } = require('./cdp');

const BASE = require('./editions').BASE;
const OUT = process.env.AURORA_REGRESS_OUT;
const results = [];
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}

const timePage = (a, id) => a.ev(`(async () => { const t = performance.now(); await A.go(${JSON.stringify(id)}); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); return Math.round(performance.now() - t); })()`, 90000);
const problems = (a) => [...a.errors.slice(0, 4), ...a.log().crashes.slice(0, 3).map((c) => c.text)];

const SCENARIOS = {
  async scale() {
    const a = await start('scale', {
      stats: true,
      config: (game) => {
        const versionSettings = {};
        for (let i = 0; i < 300; i++) versionSettings[`P${i}`] = { isolation: 'on' };
        return { ...BASE_CONFIG(game), selectedVersion: 'Big', versionSettings: { ...versionSettings, Big: { isolation: 'on' } } };
      },
      prepare: ({ game }) => {
        for (let i = 0; i < 300; i++) {
          const d = fakeVersion(game, `P${i}`, { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] });
          fs.mkdirSync(path.join(d, 'saves', 'W'), { recursive: true });
          fs.writeFileSync(path.join(d, 'saves', 'W', 'level.dat'), 'x');
        }
        const big = fakeVersion(game, 'Big', { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] });
        for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(big, 'mods', `mod-${i}.jar`), 'x');
        for (let i = 0; i < 500; i++) { const w = path.join(big, 'saves', `世界${i}`); fs.mkdirSync(w, { recursive: true }); fs.writeFileSync(path.join(w, 'level.dat'), 'x'); }
      },
    });
    if (a.startError) { check('大数据', '能打开', false, a.startError); return; }
    await ready(a.ev);
    const times = {};
    for (const id of ['versions', 'mods', 'home', 'versions', 'mods', 'download', 'repair', 'settings']) times[`${id}${times[id] != null ? '2' : ''}`] = await timePage(a, id).catch((e) => `出错：${e.message}`);
    console.log(`  各页打开用时（毫秒）：${JSON.stringify(times)}`);
    const n = await a.ev("aurora.invoke('versions:installed').then((r) => r.data.length)");
    check('大数据', '300 个配置都在列表里', n >= 301, String(n));
    const list = await a.ev("(async () => { const t = performance.now(); const r = await aurora.invoke('mods:list', 'Big'); return { ms: Math.round(performance.now() - t), n: r.data.mods.length }; })()", 120000);
    console.log(`  读 3000 个 Mod：${list.ms} ms`);
    check('大数据', '3000 个 Mod 都读出来', list.n === 3000, list);
    const worlds = await a.ev("(async () => { const t = performance.now(); const r = await aurora.invoke('backup:worlds', 'Big'); return { ms: Math.round(performance.now() - t), ok: r.ok }; })()", 120000);
    console.log(`  读 500 个世界：${worlds.ms} ms`);
    check('大数据', '500 个世界能读出来', worlds.ok, worlds);
    // 20 万行日志：窗口开着，一批一批来
    const batch = Array.from({ length: 2000 }, (_, i) => ({ text: `[12:00:00] [Render thread/INFO]: 第 ${i} 行`, level: 'info', t: i }));
    await a.ev('A.state.games.set("big-log", { id: "big-log", versionId: "Big", state: "running", startedAt: Date.now() }); A.logs.open("big-log"); 1');
    const lag = await a.ev(`(async () => {
      const lines = ${JSON.stringify(batch)};
      let worst = 0;
      let last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 20); last = now; }, 20);
      for (let i = 0; i < 100; i++) await aurora.invoke('debug:__gameLog', 'big-log', lines);
      await new Promise((r) => setTimeout(r, 500));
      clearInterval(timer);
      return { 最长卡顿毫秒: Math.round(worst), 日志节点: document.querySelectorAll('.log-line, .log-body > *').length };
    })()`, 180000).catch((e) => ({ err: e.message }));
    check('大数据', '20 万行日志：窗口开着不会卡死（最长卡顿 2 秒以内）', !lag.err && lag.最长卡顿毫秒 < 2000, lag);
    console.log(`  日志窗口：${JSON.stringify(lag)}`);
    const slow = Object.entries(times).filter(([, v]) => typeof v !== 'number' || v > 5000);
    check('大数据', '每页都能在 5 秒内打开', slow.length === 0, slow);
    check('大数据', '读 3000 个 Mod 不超过 20 秒', list.ms < 20000, `${list.ms} ms`);
    check('大数据', '页面和主进程都没有未捕获的异常', problems(a).length === 0, problems(a));
    await a.stop();
  },

  async 'bad-dirs'() {
    const cases = {
      '游戏目录不存在': { config: (game) => ({ ...BASE_CONFIG(game), gameDir: path.join(game, 'gone', 'deeper') }) },
      '游戏目录在不存在的盘上': { config: (game) => ({ ...BASE_CONFIG(game), gameDir: 'Q:\\aurora-no-such-drive\\mc' }) },
      '游戏目录是个文件': { config: (game) => ({ ...BASE_CONFIG(game), gameDir: path.join(game, 'afile') }), prepare: ({ game }) => fs.writeFileSync(path.join(game, 'afile'), 'x') },
      'versions 是个文件': { prepare: ({ game }) => { fs.rmSync(path.join(game, 'versions'), { recursive: true, force: true }); fs.writeFileSync(path.join(game, 'versions'), 'x'); } },
      'saves 是个文件': { prepare: ({ game }) => fs.writeFileSync(path.join(game, 'saves'), 'x') },
      'mods 是个文件': { prepare: ({ game }) => { const d = path.join(game, 'versions', 'Plain'); fs.rmSync(path.join(d, 'mods'), { recursive: true, force: true }); fs.writeFileSync(path.join(d, 'mods'), 'x'); } },
      '配置文件夹是空的': { prepare: ({ game }) => fs.mkdirSync(path.join(game, 'versions', 'Empty'), { recursive: true }) },
      '版本文件是 0 字节': { prepare: ({ game }) => { fs.mkdirSync(path.join(game, 'versions', 'Zero'), { recursive: true }); fs.writeFileSync(path.join(game, 'versions', 'Zero', 'Zero.json'), ''); } },
    };
    const bad = [];
    let i = 0;
    for (const [label, opts] of Object.entries(cases)) {
      const a = await start(`dirs-${i++}`, opts);
      if (a.startError) { bad.push(`${label}：打不开 ${a.startError}`); await a.stop(); continue; }
      const blank = await visitAll(a);
      const p = [...blank, ...problems(a)];
      if (p.length) bad.push(`${label}：${p[0]}`);
      await a.stop();
    }
    check('边界', `目录不对劲的 ${Object.keys(cases).length} 种情况：能打开，各页不报错`, bad.length === 0, bad.map((b) => b.replace(/file:\/\/\/\S+\/renderer\/js\//g, '').replace(/\s+/g, ' ').slice(0, 220)));

    // 只读：游戏目录和数据目录都只读，操作要报错，不能崩
    const a = await start('dirs-ro', { config: (game) => ({ ...BASE_CONFIG(game), versionSettings: { Plain: { isolation: 'on' } } }) });
    const verDir = path.join(a.game, 'versions', 'Plain');
    fs.writeFileSync(path.join(verDir, 'mods', 'r.jar'), 'x');
    const roFile = path.join(verDir, 'mods', 'r.jar');
    fs.chmodSync(roFile, 0o444);
    const toggled = await a.ev(`aurora.invoke('mods:toggle', ${JSON.stringify(roFile)}, false)`);
    const removed = await a.ev(`aurora.invoke('mods:remove', ${JSON.stringify(roFile.endsWith('.disabled') ? roFile : (toggled.ok ? toggled.data : roFile))}, 'Plain', { permanent: true })`);
    console.log(`  只读的 Mod：开关 ${toggled.ok ? '成功' : toggled.error}；删除 ${removed.ok ? '成功' : removed.error}`);
    // 整个文件夹用系统权限设成不能写（只动测试目录，测完还原）
    const who = process.env.USERNAME;
    const deny = path.join(a.game, 'versions', 'Plain', 'saves');
    fs.mkdirSync(deny, { recursive: true });
    let denied = false;
    try { execFileSync('icacls', [deny, '/deny', `${who}:(WD,AD)`], { windowsHide: true, stdio: 'ignore' }); denied = true; } catch { /* 改不了就跳过 */ }
    const made = await a.ev("aurora.invoke('backup:worlds', 'Plain').then((r) => r.ok)");
    const dir = await a.ev("aurora.invoke('versions:dir', 'Plain', 'saves/sub').then((r) => ({ ok: r.ok, error: r.error }))");
    if (denied) execFileSync('icacls', [deny, '/remove:d', who], { windowsHide: true, stdio: 'ignore' });
    console.log(`  不能写的文件夹：${JSON.stringify(dir)}`);
    check('边界', '不能写的文件夹：报错，不崩，错误说得清楚', made === true && (denied ? !dir.ok && !/^E[A-Z]+:/.test(dir.error || '') : true), { denied, dir });
    check('边界', '只读的时候页面和主进程都没有未捕获的异常', problems(a).length === 0, problems(a));
    await a.stop();
  },

  async names() {
    const NAMES = ['世界 😀', "It's #1 & 100%", 'a b  c', '[括号](x){y}', '^~`!@$=+,', 'Ünï-çødé', '\u202Eevil', 'x'.repeat(80)];
    const a = await start('names', {
      config: (game) => {
        const versionSettings = {};
        for (const n of NAMES) versionSettings[n] = { isolation: 'on' };
        return { ...BASE_CONFIG(game), versionSettings };
      },
      prepare: ({ game }) => {
        for (const n of NAMES) {
          const d = fakeVersion(game, n, { libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] });
          fs.writeFileSync(path.join(d, 'mods', `${n.slice(0, 40)}.jar`), 'x');
          const w = path.join(d, 'saves', n);
          fs.mkdirSync(w, { recursive: true });
          fs.writeFileSync(path.join(w, 'level.dat'), 'x');
        }
      },
    });
    if (a.startError) { check('边界', '能打开', false, a.startError); return; }
    const blank = await visitAll(a);
    const seen = await a.ev('aurora.invoke("versions:installed").then((r) => r.data.map((v) => v.id))');
    check('边界', '名字带 emoji、特殊符号、方向控制符、80 个字：都在列表里', NAMES.every((n) => seen.includes(n)), NAMES.filter((n) => !seen.includes(n)));
    const bad = [];
    for (const n of NAMES) {
      const j = JSON.stringify(n);
      const steps = [
        [`mods:list`, `aurora.invoke('mods:list', ${j}).then((r) => r.ok && r.data.mods.length === 1)`],
        [`backup:worlds`, `aurora.invoke('backup:worlds', ${j}).then((r) => r.ok)`],
        [`backup:create`, `aurora.invoke('backup:create', ${j}, { type: 'saves' }).then((r) => r.ok || r.error)`],
        [`duplicate`, `aurora.invoke('profiles:duplicate', ${j}, ${JSON.stringify(`${n.slice(0, 70)} 副本`)}, {}).then((r) => r.ok || r.error)`],
        [`rename`, `aurora.invoke('versions:rename', ${JSON.stringify(`${n.slice(0, 70)} 副本`)}, ${JSON.stringify(`${n.slice(0, 70)} 改`)}).then((r) => r.ok || r.error)`],
        [`remove`, `aurora.invoke('versions:remove', ${JSON.stringify(`${n.slice(0, 70)} 改`)}, {}).then((r) => r.ok || r.error)`],
      ];
      for (const [label, js] of steps) {
        const r = await a.ev(js, 60000).catch((e) => e.message);
        if (r !== true) bad.push(`${n.slice(0, 14)} ${label}：${r}`);
      }
    }
    check('边界', '这些名字的配置能读 Mod、读世界、备份、复制、改名、删除', bad.length === 0, bad.slice(0, 8));
    // 路径接近 260：深的目录里放配置
    check('边界', '各页不报错', blank.length === 0 && problems(a).length === 0, [...blank, ...problems(a)].slice(0, 4));
    const deep = path.join(a.game, 'versions', 'd'.repeat(80), 'saves', 'w'.repeat(80), 'region');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(a.game, 'versions', 'd'.repeat(80), `${'d'.repeat(80)}.json`), JSON.stringify({ id: 'd'.repeat(80), type: 'release', mainClass: 'x', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] }));
    fs.writeFileSync(path.join(deep, 'r.0.0.mca'), 'x');
    fs.writeFileSync(path.join(deep, '..', 'level.dat'), 'x');
    const longOk = await a.ev(`aurora.invoke('backup:create', ${JSON.stringify('d'.repeat(80))}, { type: 'saves' }).then((r) => r.ok || r.error)`);
    const dupLong = await a.ev(`aurora.invoke('profiles:duplicate', ${JSON.stringify('d'.repeat(80))}, ${JSON.stringify('e'.repeat(80))}, {}).then((r) => r.ok || r.error)`);
    console.log(`  路径 ${deep.length + 10} 个字符：备份 ${longOk}；复制 ${dupLong}`);
    check('边界', '路径很长时备份和复制：成功或者报出能看懂的错', (longOk === true || !/^E[A-Z]+:/.test(String(longOk))) && (dupLong === true || !/^E[A-Z]+:/.test(String(dupLong))), { longOk, dupLong });
    await a.stop();
  },
};

(async () => {
  const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENARIOS);
  fs.mkdirSync(BASE, { recursive: true });
  for (const name of pick) {
    console.log(`\n=== limits ${name} ===`);
    const t0 = Date.now();
    try { await SCENARIOS[name](); } catch (e) { check(name, '脚本运行出错', false, e.stack || String(e)); }
    console.log(`  用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  }
  if (OUT) fs.appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
