'use strict';
/**
 * rc12 这一轮（2026-11-15）：按钮走查走到底以后查出来的界面问题。
 *   node scripts/regress/rc12-ui.js
 * 一、下载记录的「打开文件夹」：取消了的任务不给这个按钮（装了一半的东西已经清掉，以前点了报「路径不存在」）；
 *     完成或失败的任务文件夹不在了，提示说清楚是什么情况，不只说「路径不存在」。
 * 二、存档与备份的「打开存档文件夹」：还没玩过的配置也打得开（接口那一半在 pre3.js 的 ipc-split，这里点真的按钮）。
 * 内部版和公开版里都能跑。
 */
const fs = require('fs');
const path = require('path');
const { start, BASE_CONFIG, fakeVersion } = require('./robust-ui');
const { guard, until, ready, calm } = require('./cdp');

const results = [];
guard(results, 'rc12-ui'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const CLEAN = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove());";

(async () => {
  let root = null;
  const a = await start('rc12-ui', { prepare: (ctx) => { root = ctx.root; fakeVersion(ctx.game, 'Fresh'); }, config: (game) => ({ ...BASE_CONFIG(game), background: { type: 'gradient' }, versionSettings: { Fresh: { isolation: 'on' } } }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  const ev = (code, t = 60000) => a.ev(code, t);
  await ready(ev);

  // ── 一、下载记录 ──
  const gone = path.join(root, 'gone-folder').split(path.sep).join('/');
  const here = path.join(root, 'game').split(path.sep).join('/');
  const o = await ev(`(async () => { ${CLEAN}
    const box = document.createElement('div'); document.body.appendChild(box);
    const mgr = A.tasks.mountManager(box, { group: 'download' });
    const t = (id, status, dir, extra = {}) => ({ id, kind: 'install', status, title: '安装 ' + id, detail: '', progress: 1, meta: {}, createdAt: Date.now(), dir, files: { done: 1, total: 1, active: 0, failed: 0 }, bytes: { done: 1, total: 1 }, ...extra });
    A.state.tasks.set('c1', t('c1', 'cancelled', ${JSON.stringify(gone)}));
    A.state.tasks.set('d1', t('d1', 'done', ${JSON.stringify(gone)}));
    A.state.tasks.set('f1', t('f1', 'failed', ${JSON.stringify(gone)}, { retryable: true }));
    A.state.tasks.set('ok1', t('ok1', 'done', ${JSON.stringify(here)}));
    mgr.render(); await new Promise((r) => setTimeout(r, 300));
    const item = (id) => [...box.querySelectorAll('.task-item')].find((x) => (x.querySelector('.ti-title') || {}).textContent === '安装 ' + id) || null;
    const btn = (id) => { const r = item(id); return r ? r.querySelector('.ti-actions [data-tip="打开文件夹"]') : null; };
    const has = { rows: box.querySelectorAll('.task-item').length, c1: !!btn('c1'), d1: !!btn('d1'), f1: !!btn('f1'), ok1: !!btn('ok1') };
    const toastAfter = async (id) => { document.querySelectorAll('.toast').forEach((x) => x.remove()); const b = btn(id); if (!b) return null; b.click(); await new Promise((r) => setTimeout(r, 600)); return [...document.querySelectorAll('.toast')].map((x) => x.className.replace('toast ', '') + '：' + x.innerText.replace(/\\s+/g, ' ')).join(' | '); };
    const d1 = await toastAfter('d1'); const f1 = await toastAfter('f1'); const ok1 = await toastAfter('ok1');
    for (const id of ['c1', 'd1', 'f1', 'ok1']) A.state.tasks.delete(id);
    box.remove();
    return { has, d1, f1, ok1 };
  })()`);
  check('下载记录', '取消了的任务不给「打开文件夹」；完成、失败的给', o.has && !o.has.c1 && o.has.d1 && o.has.f1 && o.has.ok1, o.has);
  check('下载记录', '完成了的任务文件夹不在了：提示「这个文件夹已经不在了」，不是「路径不存在」的报错', /文件夹已经不在了/.test(o.d1 || '') && /删掉或者挪走/.test(o.d1 || '') && !/路径不存在/.test(o.d1 || ''), o.d1);
  check('下载记录', '失败了的任务文件夹不在了：提示清理掉了、可以重试', /文件夹已经不在了/.test(o.f1 || '') && /重试/.test(o.f1 || ''), o.f1);
  check('下载记录', '文件夹在的时候正常打开，不弹提示', o.ok1 === '', o.ok1);

  // ── 二、存档与备份：还没玩过的配置 ──
  const savesDir = path.join(root, 'game', 'versions', 'Fresh', 'saves');
  const before = fs.existsSync(savesDir);
  await ev(`(async () => { ${CLEAN} await A.go('versions'); A.savesManager(A.state.installed.find((x) => x.id === 'Fresh')); return 1; })()`);
  await until(ev, "[...document.querySelectorAll('.modal-back .modal button')].some((b) => /打开存档文件夹/.test(b.textContent))", 15000);
  await calm(ev);
  const s = await ev(`(async () => { document.querySelectorAll('.toast').forEach((x) => x.remove());
    const b = [...document.querySelectorAll('.modal-back .modal button')].find((x) => /打开存档文件夹/.test(x.textContent)); if (!b) return { found: false };
    b.click(); await new Promise((r) => setTimeout(r, 1200));
    return { found: true, toasts: [...document.querySelectorAll('.toast')].map((x) => x.innerText.replace(/\\s+/g, ' ')).join(' | ') }; })()`);
  check('存档', '还没玩过的配置点「打开存档文件夹」：不报错，存档文件夹建好了', s.found && !before && !/路径不存在|无法打开/.test(s.toasts) && fs.existsSync(savesDir), { before, ...s, after: fs.existsSync(savesDir) });

  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 3));
  await a.stop();
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
