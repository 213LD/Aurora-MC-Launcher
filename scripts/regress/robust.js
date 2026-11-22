'use strict';
/**
 * 安全和坏输入（2.0.0-pre8，全面测试高优先级第 2、3 项）。全部在 sandbox-hook 的隔离层里跑：
 * 写不出测试目录、连不了外网、起不了进程。单独跑：electron scripts/regress/robust.js <场景>
 *
 * - ipc-fuzz：每个接口的每个位置传错类型、超长、路径穿越，看诱饵文件动没动、有没有未捕获的异常
 * 结果明细写到 <工作目录>/<场景>-report.json
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const H = require('./harness');
const { seal } = require('./sandbox-hook');

const { setup, core, ipc, check, finish, sleep } = H;

/** 只让 PASS / FAIL 行出现在输出里（几万次调用的错误日志会把输出缓冲区撑爆） */
function quietConsole() {
  const log = console.log.bind(console);
  console.error = () => {};
  console.warn = () => {};
  console.info = () => {};
  console.log = (...a) => { if (typeof a[0] === 'string' && /^(PASS|FAIL|\s{2}\S)/.test(a[0])) log(...a); };
}

/** 监听未捕获的异常：在真实程序里这就是弹一个「主进程出错」的窗口 */
function watchCrash() {
  const seen = new Map();
  const add = (kind, e) => {
    const text = String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400);
    seen.set(text, { kind, text, count: (seen.get(text) ? seen.get(text).count : 0) + 1 });
  };
  process.on('uncaughtException', (e) => add('uncaught', e));
  process.on('unhandledRejection', (e) => add('rejection', e));
  return seen;
}

function snapshotTree(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return `${dir}:整个目录没了`;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push(`${p}/`); walk(p); } else {
        const st = fs.statSync(p);
        out.push(`${p}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

/** 诱饵：看起来像配置、Mod、Java、备份的文件都放一点，路径穿越落到这里就看得出来 */
function buildCanary(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'aurora canary');
  fs.writeFileSync(path.join(dir, 'mod.jar'), 'aurora canary jar');
  fs.writeFileSync(path.join(dir, 'x.jar.disabled'), 'aurora canary disabled');
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'aurora canary sub');
  fs.writeFileSync(path.join(dir, 'mods', 'real.jar'), 'aurora canary mods');
  fs.writeFileSync(path.join(dir, 'tool.exe'), 'aurora canary exe');
  fs.writeFileSync(path.join(dir, 'aurora-canary.json'), JSON.stringify({ id: 'aurora-canary', type: 'release', mainClass: 'x', libraries: [] }));
}

/** 不是每个接口都该传路径：这些接口的参数本来就是玩家选的文件或文件夹，诱饵动了要单独看，不算穿越 */
const USER_PICKED = new Set(['location:switch', 'place:move', 'place:probe', 'config:set']);

function payloads(canary) {
  const up = '..\\..\\aurora-canary'; // 从 game/versions 上去两层正好到诱饵，不多走一层
  const big = 'x'.repeat(70000);
  const cyc = {}; cyc.self = cyc;
  let deep = {}; for (let i = 0; i < 2000; i++) deep = { a: deep };
  return [
    ['没传', undefined], ['null', null], ['true', true], ['0', 0], ['-1', -1], ['NaN', NaN], ['1e308', 1e308], ['BigInt', 12n],
    ['空字符串', ''], ['空格', ' '], ['点', '.'], ['两点', '..'], ['三点', '...'], ['斜杠', '/'], ['反斜杠', '\\'], ['CON', 'CON'], ['NUL', 'nul.txt'], ['冒号', 'a:b'], ['换行', 'a\nb'], ['空字符', 'a\0b'], ['不存在', 'no-such-thing'],
    ['很长', big], ['特别长', 'y'.repeat(1 << 20)],
    ['穿越-反斜杠', up], ['穿越-正斜杠', '../../aurora-canary'], ['穿越-点空格', '.. \\.. \\aurora-canary'], ['穿越-文件', `${up}\\secret.txt`], ['穿越-子目录', `fuzz-ok\\..\\..\\..\\aurora-canary`],
    ['绝对-目录', canary], ['绝对-文件', path.join(canary, 'secret.txt')], ['绝对-jar', path.join(canary, 'mod.jar')], ['绝对-disabled', path.join(canary, 'x.jar.disabled')], ['绝对-mods', path.join(canary, 'mods', 'real.jar')], ['绝对-exe', path.join(canary, 'tool.exe')],
    ['数组-空', []], ['数组-null', [null]], ['数组-诱饵', [path.join(canary, 'mod.jar')]], ['数组-穿越', [up]], ['数组-大', new Array(5000).fill('z')],
    ['对象-空', {}], ['对象-杂', { a: 1 }],
    ['对象-路径', { file: path.join(canary, 'mod.jar'), dir: canary, path: path.join(canary, 'mod.jar'), root: canary }],
    ['对象-名字', { id: up, name: up, versionId: up, target: up, title: up, mc: up }],
    ['原型', JSON.parse('{"__proto__":{"auroraPolluted":1},"a":{"__proto__":{"auroraPolluted":1}}}')],
    ['构造器', JSON.parse('{"constructor":{"prototype":{"auroraPolluted":1}}}')],
    ['循环', cyc], ['很深', deep],
    ['日期', new Date(NaN)], ['正则', /x/], ['Map', new Map([['a', 1]])], ['Set', new Set([1])], ['二进制', Buffer.alloc(8)],
  ];
}

// ── 造坏数据的工具 ──
/** 固定种子的随机数：失败能复现 */
function seeded(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/** 随机改一点：翻字节、改成特殊值、截断、删一段、复制一段 */
function mutate(buf, rng) {
  let b = Buffer.from(buf);
  const n = 1 + Math.floor(rng() * 6);
  const SPECIAL = [0, 1, 0x7f, 0x80, 0xff];
  for (let i = 0; i < n; i++) {
    const k = rng();
    const at = Math.floor(rng() * b.length);
    if (k < 0.5) b[at] = Math.floor(rng() * 256);
    else if (k < 0.8) { const w = Math.min(4, b.length - at); for (let j = 0; j < w; j++) b[at + j] = SPECIAL[Math.floor(rng() * SPECIAL.length)]; }
    else if (k < 0.9) b = b.subarray(0, Math.max(1, at));
    else if (k < 0.95) b = Buffer.concat([b.subarray(0, at), b.subarray(Math.min(b.length, at + Math.floor(rng() * 64)))]);
    else b = Buffer.concat([b.subarray(0, at), b.subarray(at, Math.min(b.length, at + Math.floor(rng() * 64))), b.subarray(at)]);
    if (!b.length) b = Buffer.from([0]);
  }
  return b;
}

/** 手工写 zip：文件名和声明的大小都可以是假的（ZipWriter 不允许这样） */
function buildZip(items) {
  const zlib = require('zlib');
  const { crc32 } = core('zip');
  const locals = [];
  const central = [];
  let off = 0;
  for (const it of items) {
    const nameBuf = Buffer.from(it.name, 'utf8');
    const comp = it.data.length ? zlib.deflateRawSync(it.data, { level: 1 }) : Buffer.alloc(0);
    const size = it.lieSize != null ? it.lieSize : it.data.length;
    const crc = crc32(it.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(nameBuf.length, 26);
    locals.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nameBuf);
    off += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(items.length, 8); e.writeUInt16LE(items.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

const SCENARIOS = {
  async 'ipc-fuzz'() {
    // AURORA_FUZZ_SHARD=i/n：分几个进程一起跑，每个只管一部分接口
    const [shard, shards] = (process.env.AURORA_FUZZ_SHARD || '0/1').split('/').map(Number);
    const { root, data, game } = setup(`robust-ipc-${shard}`);
    const box = seal(root);
    quietConsole();
    const crashes = watchCrash();
    const canary = path.join(root, 'aurora-canary');
    buildCanary(canary);
    const vdir = path.join(game, 'versions', 'fuzz-ok');
    const fixture = () => {
      fs.mkdirSync(path.join(vdir, 'mods'), { recursive: true });
      const j = path.join(vdir, 'fuzz-ok.json');
      if (!fs.existsSync(j)) fs.writeFileSync(j, JSON.stringify({ id: 'fuzz-ok', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [] }));
    };
    fixture();
    const config = core('config');
    config.load();
    const bus = ipc();
    const tasks = core('tasks');
    const only = process.env.AURORA_FUZZ_CHANNELS ? new RegExp(process.env.AURORA_FUZZ_CHANNELS) : null;
    const channels = require('./ipc-channels.json').filter((ch, i) => i % shards === shard && (!only || only.test(ch)));
    const list = payloads(canary);
    // 第三个参数很少有接口用到，只试最要紧的几种，省时间
    const KEY = new Set(['没传', 'null', '空字符串', '两点', '很长', '穿越-反斜杠', '绝对-文件', '绝对-jar', '数组-诱饵', '对象-路径', '原型', '循环']);
    let baseCanary = snapshotTree(canary);
    const baseCfg = JSON.stringify(config.get());
    const findings = { canary: [], writes: [], spawnedCanary: [], opened: [], read: new Map(), hangs: [], pollution: [], moved: [] };
    let calls = 0;
    const pending = new Set();
    const hangCount = new Map();
    const started = Date.now();
    const TIME_LIMIT = Number(process.env.AURORA_ROBUST_LIMIT || 0);
    const positions = [0, 1, 2];
    const benign = ['fuzz-ok', undefined, undefined];
    const writeReport = () => {
      const report = {
        calls, seconds: Math.round((Date.now() - started) / 1000), channels: channels.length,
        canary: findings.canary, writes: findings.writes, spawnedCanary: findings.spawnedCanary, opened: findings.opened,
        read: [...findings.read.entries()], hangs: findings.hangs, pollution: findings.pollution, crashes: [...crashes.values()],
      };
      fs.writeFileSync(path.join(root, 'ipc-fuzz-report.json'), JSON.stringify(report, null, 1));
      return report;
    };
    const resetCfg = async () => {
      const t = path.join(data, 'config.json');
      try { await config.flush(); } catch { /* 配置里有循环对象时存不了，下面直接覆盖 */ }
      fs.writeFileSync(t, baseCfg);
      config.load();
    };
    const timeUp = () => TIME_LIMIT && Date.now() - started > TIME_LIMIT;
    for (const ch of channels) {
      if (timeUp()) break;
      for (const pos of positions) {
        for (const [label, value] of list) {
          if (timeUp()) break;
          if (pos === 2 && !KEY.has(label)) continue;
          const args = benign.slice(0, Math.max(pos + 1, 1));
          args[pos] = value;
          calls++;
          let settled = false;
          const tagNow = `${ch} #${pos} ${label}`;
          const p = bus.call(ch, ...args).catch((e) => ({ thrown: String(e && e.message) })).finally(() => { settled = true; pending.delete(tagNow); });
          pending.add(tagNow);
          // 一直不回答的接口（比如等玩家在浏览器里登录）只多等前几次
          await Promise.race([p, sleep((hangCount.get(ch) || 0) >= 3 ? 60 : 800)]);
          if (!settled) { if ((hangCount.get(ch) || 0) < 6) findings.hangs.push(`${ch} #${pos} ${label}`); hangCount.set(ch, (hangCount.get(ch) || 0) + 1); }
          // 后台任务（下载之类）被网络屏障拦下来很快结束；没结束的取消掉，免得算到下一个头上
          for (let i = 0; i < 6 && tasks.list().some((t) => t.status === 'running'); i++) await sleep(25);
          for (const t of tasks.list()) { if (t.status === 'running') { try { tasks.cancel(t.id); } catch { /* 取消不了 */ } } }
          tasks.clearFinished();
          const got = box.drain();
          const tag = `${ch} #${pos} ${label}`;
          // 同一个接口只记前几条，够定位就行
          const room = (arr) => arr.filter((x) => (x.tag || x).split(' ')[0] === ch).length < 6;
          for (const w of got.writes) if (room(findings.writes)) findings.writes.push({ tag, ...w });
          for (const s of got.spawns) if ((/aurora-canary/i.test(s.cmd) || s.args.some((a) => /aurora-canary/i.test(a))) && room(findings.spawnedCanary)) findings.spawnedCanary.push({ tag, cmd: s.cmd });
          for (const s of got.shell) if (s.kind === 'openPath' && /aurora-canary.*\.(exe|jar)$/i.test(String(s.arg)) && room(findings.opened)) findings.opened.push({ tag, ...s });
          if (got.reads.length && !findings.read.has(ch)) findings.read.set(ch, `${label} → ${path.basename(got.reads[0])}`);
          const now = snapshotTree(canary);
          if (now !== baseCanary) {
            const before = new Set(baseCanary.split('\n'));
            const after = new Set(now.split('\n'));
            const diff = [...before].filter((x) => !after.has(x)).map((x) => `-${path.relative(canary, x)}`).concat([...after].filter((x) => !before.has(x)).map((x) => `+${path.relative(canary, x)}`));
            if (room(findings.canary)) findings.canary.push({ tag, diff: diff.slice(0, 6) });
            buildCanary(canary);
            baseCanary = snapshotTree(canary); // 重建之后时间戳变了，基线也要跟着变
          }
          if (({}).auroraPolluted !== undefined) { findings.pollution.push(tag); delete Object.prototype.auroraPolluted; }
          if (/^(config|app|location|reset|versions:setSettings|place|debug|isolation:global)/.test(ch)) await resetCfg();
          fixture();
        }
      }
      writeReport(); // 中途被杀也留得下已经跑完的结果
    }
    await sleep(500); // 让延迟的定时器（设置防抖、setTimeout 重启）也跑完，异常才算得全 // pitfall-ok：让延迟的定时器也跑完，异常才算得全
    // 慢不算问题（网络被隔离时有重试），一直不回答才算。等玩家操作的接口除外（微软登录等浏览器、测试启动等玩家确认）
    for (let i = 0; i < 90 && pending.size; i++) await sleep(1000);
    const report = writeReport();
    const stuck = [...pending].filter((t) => !/^(accounts:msWait|troubleshoot:)/.test(t));
    check('坏输入', '没有哪个接口一直不回答（等了 90 秒）', stuck.length === 0, [...new Set(stuck.map((t) => t.split(' ')[0]))].join(','));
    box.release();
    console.log(`  ${calls} 次调用，${report.seconds} 秒`);
    const traversal = findings.canary.filter((f) => !USER_PICKED.has(f.tag.split(' ')[0]));
    check('安全', '路径穿越和任意路径：诱饵文件没有被改动或删除', traversal.length === 0, [...new Set(traversal.map((f) => f.tag.split(' ')[0]))].join(','));
    const outside = findings.writes.filter((w) => !USER_PICKED.has(w.tag.split(' ')[0]));
    check('安全', '隔离层没有拦下写到测试目录外面的操作（玩家自己选文件夹的接口除外）', outside.length === 0, outside.slice(0, 5));
    check('安全', '没有打开能运行的诱饵（exe、jar）', findings.opened.length === 0, [...new Set(findings.opened.map((f) => f.tag.split(' ')[0]))].join(','));
    check('安全', '没有运行诱饵程序', findings.spawnedCanary.length === 0, [...new Set(findings.spawnedCanary.map((f) => f.tag.split(' ')[0]))].join(','));
    check('安全', '没有原型污染', findings.pollution.length === 0, findings.pollution.slice(0, 5));
    check('坏输入', '没有未捕获的异常', crashes.size === 0, [...crashes.values()].slice(0, 5).map((c) => c.text));
    finish();
  },

  /** npm test 里跑的精简版：最危险的几个接口 */
  async 'ipc-paths'() {
    process.env.AURORA_FUZZ_CHANNELS = '^(mods:(toggle|remove|disableFiles)|versions:(remove|dir|rename)|shell:open|profiles:(setMeta|openLog)|backup:(remove|deleteWorld)|java:uninstall|config:set)$';
    return SCENARIOS['ipc-fuzz']();
  },

  /** 崩溃留下的各种半成品，启动时收拾：不看进程死在哪，只看磁盘上的样子 */
  async 'recover-rules'() {
    const { root, game } = setup('robust-recover');
    const box = seal(root);
    quietConsole();
    const config = core('config');
    config.load();
    config.set({ gameDir: game, marker: 1 });
    const v = path.join(game, 'versions');
    const mk = (f, text = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    const stamp = Date.now() - 3600000;
    const J = (id, extra = {}) => JSON.stringify({ id, type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], ...extra });
    const s = path.join(v, 'P', 'saves');
    mk(path.join(v, 'P', 'P.json'), J('P'));
    // 换到一半：目录不在，旧的在、新的也在 → 放回旧的
    mk(path.join(s, `A.aurora-old-${stamp}`, 'level.dat'), 'old-A'); mk(path.join(s, `A.aurora-new-${stamp}`, 'level.dat'), 'new-A');
    // 换好了：目录在，旧的还没删完 → 删旧的
    mk(path.join(s, 'B', 'level.dat'), 'new-B'); mk(path.join(s, `B.aurora-old-${stamp}`, 'level.dat'), 'old-B');
    // 还没换：只有半截新的 → 删掉
    mk(path.join(s, 'C', 'level.dat'), 'keep-C'); mk(path.join(s, `C.aurora-new-${stamp}`, 'x'), 'half');
    // 太新的半截：可能是别的启动器正在做，不动
    const young = Date.now();
    mk(path.join(s, `D.aurora-new-${young}`, 'x'), 'in-progress');
    // 老版本留下的：目录没了才放回去
    mk(path.join(s, `E.aurora-restore-${stamp}`, 'level.dat'), 'old-E');
    mk(path.join(s, 'F', 'level.dat'), 'half-F'); mk(path.join(s, `F.aurora-restore-${stamp}`, 'level.dat'), 'old-F');
    // 改名改到一半：文件夹换了，版本文件没换；依赖它的配置、设置也接着改
    mk(path.join(v, 'New1', 'Old1.json'), J('Old1')); mk(path.join(v, 'New1', 'Old1.jar'), 'jar');
    mk(path.join(v, 'Child', 'Child.json'), J('Child', { inheritsFrom: 'Old1' }));
    config.setVersionSettings('Old1', { jvmArgs: '-Dkeep=1' });
    // 版本文件改了，里面的 id 没改
    mk(path.join(v, 'New2', 'New2.json'), J('Old2'));
    // 复制到一半的配置
    mk(path.join(v, `Dup.aurora-new-${stamp}`, 'Dup.json'), J('Dup'));
    // 整合包没装完
    mk(path.join(v, 'Half', 'Half.json'), J('Half')); mk(path.join(v, 'Half', '.aurora-installing'), 'modpack');
    fs.utimesSync(path.join(v, 'Half', '.aurora-installing'), new Date(stamp), new Date(stamp));
    mk(path.join(v, 'Half2', 'Half2.json'), J('Half2')); mk(path.join(v, 'Half2', '.aurora-installing'), 'modpack');
    fs.utimesSync(path.join(v, 'Half2', '.aurora-installing'), new Date(stamp), new Date(stamp));
    mk(path.join(v, 'Fresh', 'Fresh.json'), J('Fresh')); mk(path.join(v, 'Fresh', '.aurora-installing'), 'modpack');
    // 不认识的东西一概不碰
    mk(path.join(v, 'Weird', 'notes.json'), '{"hello":1}');
    mk(path.join(v, 'Keep', 'Keep.json'), J('Keep')); mk(path.join(v, 'Keep', 'world.aurora-backup', 'x'), 'x');
    const old = new Date(stamp);
    mk(path.join(v, 'P', 'P.json.123.1794000000000.1.tmp'), 'tmp'); fs.utimesSync(path.join(v, 'P', 'P.json.123.1794000000000.1.tmp'), old, old);
    mk(path.join(v, 'P', 'youngfile.json.123.1794000000000.2.tmp'), 'tmp');
    const r = await core('recover').run();
    await core('util').queuedDone();
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
    check('恢复', '换到一半：旧的放回去，新的删掉', read(path.join(s, 'A', 'level.dat')) === 'old-A' && !fs.readdirSync(s).some((n) => n.startsWith('A.aurora')));
    check('恢复', '换好了：新的留着，旧的删掉', read(path.join(s, 'B', 'level.dat')) === 'new-B' && !fs.readdirSync(s).some((n) => n.startsWith('B.aurora')));
    check('恢复', '还没换：世界不动，半截的删掉', read(path.join(s, 'C', 'level.dat')) === 'keep-C' && !fs.readdirSync(s).some((n) => n.startsWith('C.aurora')));
    check('恢复', '太新的半截不动（可能是别的启动器在做）', fs.existsSync(path.join(s, `D.aurora-new-${young}`, 'x')));
    check('恢复', '老版本留下的：目录没了放回去', read(path.join(s, 'E', 'level.dat')) === 'old-E');
    check('恢复', '老版本留下的：目录还在就都留着，不猜', read(path.join(s, 'F', 'level.dat')) === 'half-F' && fs.existsSync(path.join(s, `F.aurora-restore-${stamp}`, 'level.dat')));
    const new1 = JSON.parse(read(path.join(v, 'New1', 'New1.json')) || '{}');
    check('恢复', '改名改到一半：版本文件和 jar 改完', new1.id === 'New1' && new1.clientVersion === 'Old1' && fs.existsSync(path.join(v, 'New1', 'New1.jar')) && !fs.existsSync(path.join(v, 'New1', 'Old1.json')), new1);
    check('恢复', '改名改到一半：依赖它的配置跟着改', JSON.parse(read(path.join(v, 'Child', 'Child.json'))).inheritsFrom === 'New1');
    check('恢复', '改名改到一半：配置的设置跟着改', config.getVersionSettings('New1').jvmArgs === '-Dkeep=1');
    check('恢复', '版本文件里的 id 改完', JSON.parse(read(path.join(v, 'New2', 'New2.json'))).id === 'New2');
    check('恢复', '复制到一半的配置清掉', !fs.readdirSync(v).some((n) => n.startsWith('Dup')));
    // 没装完的整合包不再自动删，先问玩家
    const rec = core('recover');
    const half = await rec.halfPacks();
    check('恢复', '没装完的整合包：启动时不删，列出来问玩家（刚写的标记不算，可能是别的启动器正在装）', fs.existsSync(path.join(v, 'Half', 'Half.json')) && half.includes('Half') && half.includes('Half2') && !half.includes('Fresh'), half);
    await rec.resolveHalfPack('Half', 'remove');
    await rec.resolveHalfPack('Half2', 'keep');
    const bogus = await rec.resolveHalfPack('Keep', 'remove');
    check('恢复', '玩家选删掉：删了；选留着：标记去掉、配置还在、以后不再问；不是没装完的不能借这个接口删', !fs.existsSync(path.join(v, 'Half')) && fs.existsSync(path.join(v, 'Half2', 'Half2.json')) && !fs.existsSync(path.join(v, 'Half2', '.aurora-installing')) && !(await rec.halfPacks()).includes('Half2') && bogus === false && fs.existsSync(path.join(v, 'Keep', 'Keep.json')));
    check('恢复', '不认识的文件夹不碰', read(path.join(v, 'Weird', 'notes.json')) === '{"hello":1}');
    check('恢复', '别的 .aurora- 名字不碰', fs.existsSync(path.join(v, 'Keep', 'world.aurora-backup', 'x')));
    check('恢复', '旧的临时文件清掉，刚写的不动', !fs.existsSync(path.join(v, 'P', 'P.json.123.1794000000000.1.tmp')) && fs.existsSync(path.join(v, 'P', 'youngfile.json.123.1794000000000.2.tmp')));
    const twice = await core('recover').run();
    check('恢复', '再跑一遍什么都不做', !twice.restored.length && !twice.renamed.length, twice);
    box.release();
    finish();
  },

  // ── 坏输入：压缩包 ──
  /** 手工做的恶意压缩包：路径穿越、炸弹、谎报大小。真的解压，看文件落在哪、进程撑不撑得住 */
  async 'zip-crafted'() {
    const { root, game } = setup('robust-zip');
    const box = seal(root);
    quietConsole();
    const crashes = watchCrash();
    const { ZipReader, withZip } = core('zip');
    const dest = path.join(game, 'deep', 'dest');
    fs.mkdirSync(dest, { recursive: true });
    const zipFile = path.join(root, 't.zip');
    const outside = ['evil.txt', 'evil2.txt', 'evil3.txt', 'evil4.txt'];
    const names = ['../evil.txt', '..\\evil2.txt', '.. /evil3.txt', '.. \\.. \\evil4.txt', 'ok/normal.txt', 'CON', 'x:y.txt', 'NUL.txt', 'ok/. /dot.txt', `${'a'.repeat(300)}/long.txt`];
    fs.writeFileSync(zipFile, buildZip(names.map((n) => ({ name: n, data: Buffer.from('aurora') }))));
    const errors = [];
    await withZip(zipFile, (z) => z.extractAll(dest)).catch((e) => errors.push(e.message));
    const escaped = [];
    for (const f of await H.tree(root)) if (outside.some((o) => f.endsWith(o)) && !f.startsWith('game/deep/dest/')) escaped.push(f);
    check('安全', '解压：结尾带点和空格的 .. 也跑不出目标目录', escaped.length === 0, escaped);
    check('安全', '解压：普通条目照常解出来，坏名字不影响后面的', fs.existsSync(path.join(dest, 'ok', 'normal.txt')), errors);

    // 炸弹：256 MB 的 0 压到几百 KB，却声称只有 10 字节（谎报大小）
    const bomb = path.join(root, 'bomb.zip');
    fs.writeFileSync(bomb, buildZip([{ name: 'fabric.mod.json', data: Buffer.alloc(1 << 28), lieSize: 10 }, { name: 'a.txt', data: Buffer.from('fine') }]));
    const z = await ZipReader.open(bomb);
    const r = await z.read('fabric.mod.json').then((b) => ({ size: b.length })).catch((e) => ({ err: e.message }));
    await z.close();
    check('坏输入', '压缩炸弹（谎报解压后大小）：不会真的解压到内存里', !!r.err, r.err || `解出来 ${r.size} 字节`);

    // 老老实实声明 3 GB 的条目：读进内存的接口要拒绝
    const honest = path.join(root, 'honest.zip');
    fs.writeFileSync(honest, buildZip([{ name: 'huge.bin', data: Buffer.alloc(1 << 28), lieSize: 3221225472 }]));
    const z2 = await ZipReader.open(honest);
    const r2 = await z2.read('huge.bin').then((b) => ({ size: b.length })).catch((e) => ({ err: e.message }));
    await z2.close();
    check('坏输入', '声明 3 GB 的条目：不读进内存', !!r2.err, r2.err || `解出来 ${r2.size} 字节`);

    // 大文件解压到磁盘要走流式：真实的 300 MB 文件照常解出来
    const realBig = path.join(root, 'realbig.zip');
    const bigData = Buffer.alloc(300 * 1048576, 7);
    fs.writeFileSync(realBig, buildZip([{ name: 'big.bin', data: bigData }]));
    const m0 = process.memoryUsage().rss;
    const bigOut = path.join(root, 'big.out');
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const ok = await withZip(realBig, (zz) => zz.extractTo(zz.getEntry('big.bin'), bigOut)).then(() => true).catch((e) => e.message);
    clearInterval(timer);
    check('坏输入', '300 MB 的文件照常解压到磁盘', ok === true && fs.statSync(bigOut).size === bigData.length, String(ok));
    console.log(`  解压 300 MB 时内存多用了 ${Math.round((peak - m0) / 1048576)} MB`);

    // 目录指向 4 GB：不能真的申请 4 GB 内存
    const hugeDir = Buffer.alloc(22);
    hugeDir.writeUInt32LE(0x06054b50, 0);
    hugeDir.writeUInt16LE(1, 8); hugeDir.writeUInt16LE(1, 10);
    hugeDir.writeUInt32LE(0xfffffff0, 12); hugeDir.writeUInt32LE(0, 16);
    const hd = path.join(root, 'hugedir.zip');
    fs.writeFileSync(hd, hugeDir);
    const before = Date.now();
    const hr = await ZipReader.open(hd).then((x) => x.close().then(() => 'opened')).catch((e) => `err:${e.message}`);
    check('坏输入', '压缩包目录声称有 4 GB：很快报错，不申请那么多内存', Date.now() - before < 3000, `${hr} ${Date.now() - before}ms`);

    check('坏输入', '没有未捕获的异常', crashes.size === 0, [...crashes.values()].slice(0, 5).map((c) => c.text));
    check('安全', '隔离层没有拦下写到测试目录外面的操作', box.log.writes.length === 0, box.log.writes.slice(0, 5));
    box.release();
    finish();
  },

  /** 随机变异：好的压缩包改几个字节、截断。每种读法都不能让进程崩、卡住 */
  async 'zip-mutate'() {
    const { root, game } = setup('robust-zipm');
    const box = seal(root);
    quietConsole();
    const crashes = watchCrash();
    const { withZip } = core('zip');
    const rng = seeded(Number(process.env.AURORA_FUZZ_SEED || 20261106));
    const good = buildZip([
      { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ id: 'a', version: '1', name: 'A', depends: { minecraft: '1.20.1' } })) },
      { name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="b"\nversion="1"\n') },
      { name: 'dir/', data: Buffer.alloc(0) },
      { name: 'overrides/config/x.txt', data: Buffer.alloc(4096, 65) },
      { name: 'modrinth.index.json', data: Buffer.from(JSON.stringify({ name: 'p', versionId: '1', dependencies: { minecraft: '1.20.1' }, files: [] })) },
    ]);
    const N = Number(process.env.AURORA_FUZZ_N || 1500);
    const work = path.join(root, 'w');
    fs.mkdirSync(work, { recursive: true });
    const f = path.join(work, 'm.zip');
    const out = path.join(game, 'x');
    const mods = core('mods');
    let okCount = 0;
    let errCount = 0;
    let slow = '';
    const started = Date.now();
    const once = async () => {
      const t0 = Date.now();
      let ok = true;
      try {
        await withZip(f, async (z) => {
          for (const e of z.entries.slice(0, 50)) await z.read(e).catch(() => {});
          await z.extractAll(out).catch(() => {});
        });
      } catch { ok = false; }
      await mods.readModMeta(f).catch(() => null);
      return { ok, ms: Date.now() - t0 };
    };
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(f, mutate(good, rng));
      const r = await once();
      if (r.ok) okCount++; else errCount++;
      // 真卡住每次都卡；U 盘、网络盘偶尔慢一下不算（2026-11-07 在 U 盘上第一个用了 1.4 秒）：超时的再跑一次，两次都慢才算
      if (r.ms > 1000 && !slow) { const again = await once(); if (again.ms > 1000) slow = `第 ${i} 个用了 ${r.ms} / ${again.ms} ms`; }
    }
    console.log(`  ${N} 个变异，能打开 ${okCount}，报错 ${errCount}，${Math.round((Date.now() - started) / 1000)} 秒`);
    check('坏输入', `${N} 个变异的压缩包：进程没崩`, true);
    check('坏输入', '没有哪个变异让读取卡住超过 1 秒', !slow, slow);
    check('坏输入', '没有未捕获的异常', crashes.size === 0, [...crashes.values()].slice(0, 5).map((c) => c.text));
    check('安全', '隔离层没有拦下写到测试目录外面的操作', box.log.writes.length === 0, box.log.writes.slice(0, 5));
    box.release();
    finish();
  },

  // ── 并发 ──
  /** 同一个配置的各种操作同时做：做不成可以报错，但数据不能乱。固定种子，失败能复现 */
  async concurrent() {
    const { root, game } = setup('robust-concurrent');
    const box = seal(root);
    quietConsole();
    const crashes = watchCrash();
    const config = core('config');
    config.load();
    config.set({ disclaimerAccepted: require('./editions').DISCLAIMER, setupDone: true, gameDir: game });
    const versions = core('versions');
    const mk = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
    const J = (id) => JSON.stringify({ id, type: 'release', clientVersion: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] });
    const region = 'r'.repeat(40000);
    for (const id of ['CA', 'CB']) {
      const d = path.join(game, 'versions', id);
      mk(path.join(d, `${id}.json`), J(id));
      mk(path.join(d, 'saves', 'W1', 'level.dat'), 'level-W1');
      mk(path.join(d, 'saves', 'W1', 'region', 'r.0.0.mca'), region);
      mk(path.join(d, 'mods', 'a.jar'), 'jar-a');
      mk(path.join(d, 'mods', 'b.jar'), 'jar-b');
      config.setVersionSettings(id, { isolation: 'on' });
    }
    const bus = ipc();
    const rng = seeded(Number(process.env.AURORA_FUZZ_SEED || 20261108));
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    let cur = 'CA'; // 改名之后 id 会变
    let dupN = 0;
    const dirOf = () => versions.versionDir(cur);
    const modPath = (n, off) => path.join(dirOf(), 'mods', `${n}.jar${off ? '.disabled' : ''}`);
    const ops = {
      setMeta: () => bus.call('profiles:setMeta', cur, { description: `d${rng()}` }),
      setName: () => bus.call('profiles:setMeta', cur, { name: `n${Math.floor(rng() * 9)}` }),
      settings: () => bus.call('versions:setSettings', cur, { jvmArgs: `-Dx=${Math.floor(rng() * 9)}` }),
      config: () => bus.call('config:set', { jvmArgs: `-Dy=${Math.floor(rng() * 9)}` }),
      toggleOff: () => bus.call('mods:toggle', modPath('a', false), false),
      toggleOn: () => bus.call('mods:toggle', modPath('a', true), true),
      disableAll: () => bus.call('mods:disableAll', cur),
      restoreAll: () => bus.call('mods:restoreAll', cur),
      presetSave: () => bus.call('mods:presetSave', cur, 'p1'),
      presetApply: () => bus.call('mods:presetApply', cur, 'p1'),
      list: () => bus.call('mods:list', cur),
      detail: () => bus.call('profiles:detail', cur),
      backup: () => bus.call('backup:create', cur, { type: 'saves' }),
      restore: async () => {
        const l = await bus.call('backup:list', cur);
        const own = l.ok && l.data.own;
        return own && own.length ? bus.call('backup:restore', cur, own[0].file, { mode: 'overwrite', noAuto: true }) : null;
      },
      duplicate: () => bus.call('profiles:duplicate', cur, `Dup${++dupN}`, {}),
      removeDup: () => bus.call('versions:remove', `Dup${dupN}`, {}),
      rename: async () => {
        const next = cur === 'CA' ? 'CA2' : 'CA';
        const r = await bus.call('versions:rename', cur, next);
        if (r.ok) cur = next;
        return r;
      },
      setShared: () => bus.call('isolation:set', 'CB', { preset: 'shared', source: '@root' }),
      setOwn: () => bus.call('isolation:set', 'CB', { preset: 'isolated' }),
      plan: () => bus.call('planner:save', { id: `c${Math.floor(rng() * 3)}`, name: 'x', mc: '1.20.1', items: [] }),
      account: () => bus.call('accounts:addOffline', `Player${Math.floor(rng() * 5)}`),
    };
    const names = Object.keys(ops);
    const problems = [];
    const rounds = Number(process.env.AURORA_FUZZ_N || 120);
    let refused = 0;
    for (let i = 0; i < rounds; i++) {
      const chosen = Array.from({ length: 2 + Math.floor(rng() * 5) }, () => pick(names));
      const results = await Promise.all(chosen.map((n) => Promise.resolve().then(ops[n]).catch((e) => ({ ok: false, error: e.message }))));
      for (const r of results) if (r && r.ok === false) refused++;
      await core('tasks').list();
      await core('util').queuedDone();
      await config.flush();
      const tag = `第 ${i} 轮 ${chosen.join('+')}`;
      const ids = (await versions.listInstalled()).map((v) => v.id);
      const both = ['CA', 'CA2'].filter((x) => ids.includes(x));
      if (both.length !== 1) problems.push(`${tag}：配置应该正好一个，现在 ${both.join(',') || '没有'}`);
      const d = dirOf();
      for (const f of ['a', 'b']) {
        const on = fs.existsSync(path.join(d, 'mods', `${f}.jar`));
        const off = fs.existsSync(path.join(d, 'mods', `${f}.jar.disabled`));
        if (on === off) problems.push(`${tag}：${f}.jar 启用和禁用的文件${on ? '都在' : '都没了'}`);
      }
      const mca = path.join(d, 'saves', 'W1', 'region', 'r.0.0.mca');
      const got = fs.existsSync(mca) ? fs.readFileSync(mca, 'utf8') : null;
      if (got !== region) problems.push(`${tag}：世界的区域文件${got == null ? '没了' : `变了（${got.length}）`}`);
      for (const f of [path.join(d, 'aurora-profile.json'), path.join(root, 'data', 'config.json'), path.join(root, 'data', 'accounts.json')]) {
        if (!fs.existsSync(f)) continue;
        try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch { problems.push(`${tag}：${path.basename(f)} 读不出来`); }
      }
      if (problems.length >= 8) break;
    }
    console.log(`  ${rounds} 轮，被拒绝或报错的操作 ${refused} 个（做不成可以）`);
    check('并发', '同一个配置各种操作同时做：数据不乱', problems.length === 0, problems.slice(0, 6));
    check('并发', '没有未捕获的异常', crashes.size === 0, [...crashes.values()].slice(0, 4).map((c) => c.text));
    check('安全', '隔离层没有拦下写到测试目录外面的操作', box.log.writes.length === 0, box.log.writes.slice(0, 4));
    box.release();
    finish();
  },

  // ── 安全：令牌和下载 ──
  /** 用本机的假认证服务器登录：令牌不能以明文落盘、不能给界面、不能进导出包和日志。密码不保存 */
  async 'token-storage'() {
    const { root, data } = setup('robust-token');
    const box = seal(root);
    const SECRET_TOKEN = 'AURORA-TEST-ACCESS-TOKEN-0123456789';
    const SECRET_PASS = 'AURORA-TEST-PASSWORD-9876543210';
    const seen = [];
    for (const k of ['log', 'warn', 'error', 'info']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => { seen.push(a.join(' ')); if (typeof a[0] === 'string' && /^(PASS|FAIL|\s{2}\S)/.test(a[0])) orig(...a); };
    }
    const http = require('http');
    const server = http.createServer((q, r) => {
      let body = '';
      q.on('data', (c) => { body += c; });
      q.on('end', () => {
        r.setHeader('content-type', 'application/json');
        r.setHeader('X-Authlib-Injector-API-Location', '/api/yggdrasil/');
        if (q.url.endsWith('/authenticate')) r.end(JSON.stringify({ accessToken: SECRET_TOKEN, clientToken: 'c', selectedProfile: { id: '00000000000000000000000000000abc', name: 'MockPlayer' }, availableProfiles: [{ id: '00000000000000000000000000000abc', name: 'MockPlayer' }] }));
        else r.end(JSON.stringify({ meta: { serverName: 'Mock' }, skinDomains: [], signaturePublickey: '-----BEGIN PUBLIC KEY-----' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const accounts = core('auth/accounts');
    const res = await accounts.yggLogin({ server: `http://127.0.0.1:${server.address().port}/api/yggdrasil`, username: 'mock@example.invalid', password: SECRET_PASS });
    await core('util').queuedDone();
    server.close();
    check('安全', '确认场景成立：模拟服务器登录成功', !!(res && res.account), JSON.stringify(res).slice(0, 200).replace(SECRET_TOKEN, '<令牌>'));
    const onDisk = fs.readFileSync(path.join(data, 'accounts.json'), 'utf8');
    const stored = JSON.parse(onDisk).accounts[0];
    check('安全', '账户文件里没有明文令牌', !onDisk.includes(SECRET_TOKEN), Object.keys(stored).join());
    check('安全', '账户文件里令牌是系统加密的', /^enc:/.test(stored.accessToken || ''), String(stored.accessToken).slice(0, 8));
    check('安全', '账户文件里没有密码', !onDisk.includes(SECRET_PASS));
    check('安全', '给界面的账户列表没有令牌', !JSON.stringify(accounts.list()).includes(SECRET_TOKEN) && !/enc:/.test(JSON.stringify(accounts.list())));
    check('安全', '导出的账户没有令牌', !/enc:|accessToken|mcAccessToken|msRefreshToken/.test(JSON.stringify(accounts.exportList())));
    check('安全', '日志里没有令牌和密码', !seen.some((l) => l.includes(SECRET_TOKEN) || l.includes(SECRET_PASS)));
    let found = 0;
    for (const f of await H.tree(root)) {
      const t = await fsp.readFile(path.join(root, f)).catch(() => null);
      if (t && (t.includes(SECRET_TOKEN) || t.includes(SECRET_PASS))) { found++; console.log(`  明文在 ${f}`); }
    }
    check('安全', '测试目录里任何文件都没有明文令牌和密码', found === 0, `${found} 个文件`);
    box.release();
    finish();
  },

  /** 整合包里的下载地址是别人写的：只能是网页地址 */
  async 'download-urls'() {
    const { root, game } = setup('robust-dl');
    const box = seal(root);
    quietConsole();
    const canary = path.join(root, 'aurora-canary', 'secret.txt');
    fs.mkdirSync(path.dirname(canary), { recursive: true });
    fs.writeFileSync(canary, 'aurora canary');
    // 这里要用真的 net.fetch 才看得出能不能读本地文件，隔离层的网络屏障只拦外网，file:// 要单独放行
    const { downloadAll } = core('downloader');
    const out = path.join(game, 'mods', 'x.jar');
    const fileUrl = require('url').pathToFileURL(canary).href;
    const r = await downloadAll([{ urls: [fileUrl], path: out }], {}).then(() => 'ok', (e) => e.message);
    // 要看到是启动器自己拒绝的（「不支持的下载地址」）。以前只看「文件没出现」「报了错」：隔离层自己就会把这些请求拦下，
    // 把 net.js 里只认 http(s) 的那句删掉，这几项照样全过（rc9，变异实验发现）
    const refused = (x) => /不支持的下载地址/.test(String(x));
    check('安全', '下载地址是 file://：启动器自己拒绝，不会把本地文件复制过去', !fs.existsSync(out) && refused(r), String(r).slice(0, 160));
    for (const bad of ['javascript:1', 'ftp://127.0.0.1/x', 'data:text/plain,x', 'about:blank']) {
      const rr = await downloadAll([{ urls: [bad], path: out }], {}).then(() => 'ok', (e) => e.message);
      check('安全', `下载地址是 ${bad.slice(0, 12)}：启动器自己拒绝`, refused(rr), String(rr).slice(0, 120));
    }
    box.release();
    finish();
  },

  /** 压缩包是好的，里面的声明文件是坏的：Mod 元数据、整合包清单、导入包清单、游戏选项、崩溃日志 */
  async 'content-mutate'() {
    const { root, game } = setup('robust-content');
    const box = seal(root);
    quietConsole();
    const crashes = watchCrash();
    const { ZipWriter } = core('zip');
    const mods = core('mods');
    const modpack = core('modpack');
    const migrate = core('migrate');
    const rng = seeded(Number(process.env.AURORA_FUZZ_SEED || 20261107));
    const N = Number(process.env.AURORA_FUZZ_N || 150);
    const seeds = {
      'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'a', version: '1.0.0', name: 'A', description: 'd', authors: ['x', { name: 'y' }], icon: 'i.png', depends: { minecraft: '>=1.20', fabricloader: '*' }, breaks: { b: '*' }, jars: [{ file: 'META-INF/jars/x.jar' }] }),
      'quilt.mod.json': JSON.stringify({ schema_version: 1, quilt_loader: { group: 'g', id: 'q', version: '1', metadata: { name: 'Q', contributors: { x: 'Owner' } }, depends: [{ id: 'minecraft', versions: '>=1.20' }] } }),
      'META-INF/mods.toml': 'modLoader="javafml"\nloaderVersion="[47,)"\nlicense="MIT"\n[[mods]]\nmodId="b"\nversion="1.0"\ndisplayName="B"\nlogoFile="b.png"\n[[dependencies.b]]\nmodId="forge"\nmandatory=true\nversionRange="[47,)"\nordering="NONE"\nside="BOTH"\n',
      'META-INF/neoforge.mods.toml': 'modLoader="javafml"\nloaderVersion="[1,)"\n[[mods]]\nmodId="c"\nversion="1"\n',
      'mcmod.info': JSON.stringify([{ modid: 'd', name: 'D', version: '1', mcversion: '1.7.10', authorList: ['x'], dependencies: ['e'] }]),
    };
    const work = path.join(root, 'w');
    fs.mkdirSync(work, { recursive: true });
    const f = path.join(work, 'm.jar');
    const started = Date.now();
    let slow = '';
    const timed = async (label, fn) => {
      const t0 = Date.now();
      fs.writeFileSync(path.join(root, 'progress.txt'), label); // 卡死时看得出卡在哪
      await fn().catch(() => null);
      if (Date.now() - t0 > 1500 && !slow) slow = `${label} 用了 ${Date.now() - t0} ms`;
    };
    for (const [name, text] of Object.entries(seeds)) {
      for (let i = 0; i < N; i++) {
        const z = await ZipWriter.create(f);
        await z.addBuffer(name, mutate(Buffer.from(text), rng));
        await z.close();
        await timed(`Mod 元数据 ${name} 第 ${i} 个`, () => mods.readModMeta(f));
      }
      // 特别长的一行：看正则会不会卡死
      const z = await ZipWriter.create(f);
      await z.addBuffer(name, Buffer.from(`${text}\n${'a="'.repeat(40000)}\n${' '.repeat(200000)}x`));
      await z.close();
      await timed(`Mod 元数据 ${name} 超长行`, () => mods.readModMeta(f));
    }
    // 整合包清单
    const index = JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'P', summary: 's', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' }, files: [{ path: 'mods/a.jar', hashes: { sha1: 'a'.repeat(40) }, downloads: ['https://cdn.modrinth.com/a.jar'], fileSize: 1 }] });
    const cfManifest = JSON.stringify({ minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] }, manifestType: 'minecraftModpack', name: 'C', version: '1', files: [{ projectID: 1, fileID: 2, required: true }], overrides: 'overrides' });
    const pack = path.join(work, 'p.mrpack');
    for (let i = 0; i < N; i++) {
      for (const [entry, text] of [['modrinth.index.json', index], ['manifest.json', cfManifest]]) {
        const z = await ZipWriter.create(pack);
        await z.addBuffer(entry, mutate(Buffer.from(text), rng));
        await z.close();
        await timed(`整合包清单 ${entry} 第 ${i} 个`, () => modpack.readMrpack(pack));
      }
    }
    // 导入包清单
    const aur = path.join(work, 'a.aurora');
    const manifest = JSON.stringify({ kind: 'aurora-data', format: 1, app: 'x', exportedAt: Date.now(), profiles: [{ id: 'P', name: 'P', isolated: true }], files: [{ path: 'game/versions/P/P.json', size: 1, crc: 0 }], versionSettings: {} });
    for (let i = 0; i < N; i++) {
      const z = await ZipWriter.create(aur);
      await z.addBuffer('aurora-export.json', mutate(Buffer.from(manifest), rng));
      await z.addBuffer('manifest.json', mutate(Buffer.from(manifest), rng));
      await z.close();
      await timed(`导入包第 ${i} 个`, () => migrate.inspect({ file: aur }));
    }
    // 游戏选项和崩溃日志
    const fmt = core('optionsfmt');
    const parse = fmt.parse || fmt.parseOptions || fmt.read;
    const opts = 'version:3465\nfov:0.5\nlang:en_us\nkey_key.jump:key.keyboard.space\nresourcePacks:["vanilla"]\nsoundCategory_master:1.0\n';
    if (parse) {
      for (let i = 0; i < N; i++) await timed(`options.txt 第 ${i} 个`, async () => parse(mutate(Buffer.from(opts), rng).toString('utf8')));
    }
    const ts = core('troubleshoot');
    const hugeLog = Array.from({ length: 60000 }, (_, i) => `[12:00:${String(i % 60).padStart(2, '0')}] [main/ERROR]: java.lang.NoClassDefFoundError: a/b/C${i} at x.y.Z(${'A'.repeat(50)}.java:1)`).join('\n');
    await timed('崩溃分析 6 万行', async () => ts.analyzeLog(hugeLog, []));
    await timed('崩溃分析 一行 2 MB', async () => ts.analyzeLog(`${'('.repeat(1 << 20)}${'a'.repeat(1 << 20)}`, []));
    for (let i = 0; i < N; i++) await timed(`崩溃分析第 ${i} 个`, async () => ts.analyzeLog(mutate(Buffer.from(hugeLog.slice(0, 4000)), rng).toString('utf8'), [{ id: null, name: 5, file: 7, enabled: true }, null].filter(Boolean)));
    console.log(`  用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
    check('坏输入', 'Mod 元数据、整合包清单、导入包清单、游戏选项、崩溃日志：都很快返回', !slow, slow);
    check('坏输入', '没有未捕获的异常', crashes.size === 0, [...crashes.values()].slice(0, 5).map((c) => c.text));
    check('安全', '隔离层没有拦下写到测试目录外面的操作', box.log.writes.length === 0, box.log.writes.slice(0, 5));
    void game;
    box.release();
    finish();
  },

  // ── 坏输入：NBT ──
  async 'nbt-crafted'() {
    const { root } = setup('robust-nbt');
    const box = seal(root);
    quietConsole();
    const crashes = watchCrash();
    const nbt = core('nbt');
    const zlib = require('zlib');
    const file = path.join(root, 'level.dat');
    const name = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
    const race = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);
    // 嵌套很深：栈溢出要变成普通错误
    const parts = [Buffer.from([10]), name('')];
    for (let i = 0; i < 200000; i++) parts.push(Buffer.from([10, 0, 0]));
    fs.writeFileSync(file, Buffer.concat(parts));
    const d = await race(nbt.levelInfo(file), 5000);
    check('坏输入', '嵌套二十万层：不崩，当成读不出来', d === null, String(d));
    // gzip 炸弹：几 MB 解开是 1 GB。这里只是要显示世界名，不该撑爆内存
    fs.writeFileSync(file, zlib.gzipSync(Buffer.alloc(1 << 30)));
    const m0 = process.memoryUsage().rss;
    let peak = m0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const b = await race(nbt.levelInfo(file), 20000);
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    const grew = Math.round((peak - m0) / 1048576);
    check('坏输入', 'gzip 炸弹：不解到 1 GB', grew < 400, `内存涨 ${grew} MB，结果 ${b}`);
    // __proto__ 当作键名
    const proto = Buffer.concat([Buffer.from([10]), name(''), Buffer.from([8]), name('__proto__'), name('x'), Buffer.from([0])]);
    fs.writeFileSync(file, proto);
    await nbt.levelInfo(file);
    check('安全', 'NBT 键名叫 __proto__：不污染原型', ({}).x === undefined);
    // 随机变异
    const T = nbt.T;
    const good = nbt.serialize({ name: '', value: { Data: { type: T.COMPOUND, value: { LevelName: { type: T.STRING, value: '世界' }, GameType: { type: T.INT, value: 0 }, Arr: { type: T.BYTE_ARRAY, value: Buffer.alloc(8) }, L: { type: T.LIST, value: { type: T.INT, items: [1, 2, 3] } } } } } });
    const rng = seeded(Number(process.env.AURORA_FUZZ_SEED || 20261106));
    const N = Number(process.env.AURORA_FUZZ_N || 3000);
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(file, mutate(good, rng));
      fs.writeFileSync(`${file}.seed`, String(i)); // 卡死时父进程靠这个知道是第几个
      await nbt.levelInfo(file);
    }
    check('坏输入', `${N} 个变异的 level.dat：都能很快返回`, true);
    // 负长度的字节数组：读指针往回走，会一直循环。放最后，修之前这一步会把进程卡死
    const neg = Buffer.alloc(4); neg.writeInt32BE(-8); // 正好退回这个标签开头：标签 1 + 名字 3 + 长度 4
    fs.writeFileSync(file, Buffer.concat([Buffer.from([10]), name(''), Buffer.from([7]), name('a'), neg, Buffer.from([0])]));
    fs.writeFileSync(`${file}.seed`, 'neg');
    const r = await nbt.levelInfo(file);
    check('坏输入', '负长度的字节数组：很快返回，不会死循环', r === null, String(r));
    check('坏输入', '没有未捕获的异常', crashes.size === 0, [...crashes.values()].slice(0, 5).map((c) => c.text));
    box.release();
    finish();
  },
};

const name = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
  const fn = SCENARIOS[name];
  if (!fn) { console.error(`没有这个场景：${name}`); app.exit(2); return; }
  try { await fn(); } catch (e) {
    console.log(`FAIL [脚本] ${name} 出错 — ${e && e.stack}`);
    finish(1);
  }
}).catch((e) => { console.log(`FAIL [脚本] ${e}`); app.exit(1); });
app.on('window-all-closed', () => {});
