'use strict';
/**
 * 消息和翻译的回归（2.0.0-pre5），编号是修这些问题时用的条目号。修之前修之后都能跑，方便对比。
 * 界面部分在 ui.js 的 tr-names、tr-writes。单独跑：electron scripts/regress/pre5.js <场景>
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const H = require('./harness');

const { setup, core, ipc, lockFile, fakeVersion, check, finish, sleep } = H;
const RAW = /^E[A-Z]+:|\bno such file\b|operation not permitted|resource busy|ENOENT|EPERM|EBUSY/;

const SCENARIOS = {
  // ── 10-8 主进程错误提示的英文错误码 ──
  /** 名字里有关键词不能给错建议，真的技术错误还要认得出来（2.0.0-pre7） */
  async 'error-names'() {
    const { describe } = require(path.join(H.REPO || path.resolve(__dirname, '..', '..'), 'src', 'main', 'engine', 'errors'));
    const { run } = require('./error-cases');
    const { bad, total } = run(describe);
    check('10-8', `错误原因对照表 ${total} 条：名字不误判，真错误都认得出来`, bad.length === 0, bad.slice(0, 8));
    finish();
  },

  async 'fs-errors'() {
    const { root } = setup('pre5-err');
    const bus = ipc();
    const seen = (label, r, re) => {
      console.log(`  ${label}：${String(r.error).replace(/[A-Z]:\\\S+/g, '<路径>').slice(0, 110)}`);
      check('10-8', `${label}：看不到英文错误码`, !r.ok && !RAW.test(r.error), r.error);
      check('10-8', `${label}：说得出原因`, !r.ok && re.test(r.error), r.error);
      check('10-8', `${label}：原因和错误码还留着（reason）`, !r.ok && !!(r.reason && r.reason.code && r.reason.code !== 'UNKNOWN'), r.reason);
    };
    seen('开关不存在的 Mod', await bus.call('mods:toggle', path.join(root, 'game', '不存在.jar'), false), /找不到/);
    const dir = await fakeVersion('ErrP');
    const held = path.join(dir, 'pre5-held.bin');
    fs.writeFileSync(held, 'x');
    const release = await lockFile(held, 'None', 40);
    seen('改名时文件被占着', await bus.call('versions:rename', 'ErrP', 'ErrQ'), /占用|占着|权限/);
    await release();
    // 任务失败：任务上的文字、主进程的提示都是人话
    const notes = [];
    const tasks = core('tasks');
    tasks.setNotifier((n) => notes.push(n));
    const r = await bus.call('migrate:import', { file: path.join(root, '不存在.aurora') }, {});
    if (!r.ok) { check('10-8', '任务失败：导入任务开始得了', false, r.error); return; } // 以前直接 TypeError，看不到原因（2026-11-07 在 SMB 上碰到）
    for (let i = 0; i < 100 && tasks.get(r.data).status === 'running'; i++) await sleep(20);
    const t = tasks.get(r.data);
    check('10-8', '任务失败：任务上的文字没有英文错误码', t.status === 'failed' && !RAW.test(t.error), t.error);
    check('10-8', '任务失败：提示没有英文错误码', notes.length === 1 && !RAW.test(notes[0].text), notes.map((n) => n.text));
    // 业务上写好的话不动
    const biz = await bus.call('versions:rename', fs.existsSync(dir) ? 'ErrP' : 'ErrQ', 'a;b');
    check('10-8', '已经是人话的错误不改', !biz.ok && /分号|;/.test(biz.error), biz.error);
    void fs;
  },

  // ── 9-4 条件拼接少空格 ──
  async 'hardware-text'() {
    setup('pre5-hw');
    const { build } = core('hardware');
    const base = { gpus: [], virtualDisplays: [], vm: null, remote: false, cpu: { name: 'x', cores: 8 }, ram: { total: 16384, free: 8000 }, os: { release: '10.0.26100' } };
    const src = fs.readFileSync(path.join(H.REPO, 'src/main/core/hardware.js'), 'utf8');
    check('9-4', '不再用条件拼半句话', !/\$\{running\.length \? '正在运行' : '装了'\}/.test(src));
    void build; void base;
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
