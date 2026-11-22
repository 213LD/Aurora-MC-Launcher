'use strict';
/**
 * rc8 这一轮（试用 rc7 时发现，2026-11-13）：
 *   node scripts/regress/rc8-ui.js            [--quick 只跑功能，不截各种外观]
 * 一、设置页上下排的行（JVM 参数、游戏参数、同步哪些）空出一大块：rc3 给 .s-text 加了 flex-basis 240px，竖排时变成了高度；
 *     控件区的 margin-left: auto 让「同步哪些」的勾选框缩成右边一条。
 *     量每个上下排的行：文字区的高度和内容差不多，控件区撑满整行、左边对齐（6 种外观都量）
 * 二、从其他启动器迁移找不到入口：设置「数据」那一行改名、加「从其他启动器导入…」；游戏配置页加按钮；
 *     从「关于」重新打开首次启动向导，做完也问要不要导入。都只打开对话框看一眼，不真的导入（不碰真实的游戏目录）
 * 截图在 AURORA_REGRESS_DIR/rc8-ui
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, BASE_CONFIG } = require('./robust-ui');
const { sleep, guard, ready } = require('./cdp');

const BASE = require('./editions').BASE;
const SHOTS = path.join(BASE, 'rc8-ui');
const results = [];
guard(results, 'rc8-ui'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 600)}` : ''}`);
}
const shot = async (a, name) => { const r = await a.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64')); };
const clean = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove()); A.closePopover && A.closePopover();";
const SYNC = { gameSync: { enabled: true, mode: 'once', cats: ['keys', 'video', 'sound'] } };

// 页面里：打开设置「游戏」分类，量每个看得到的上下排行
const MEASURE = `(async () => { ${clean} await A.go('settings', { focus: 'gamesync' }); await new Promise((r) => setTimeout(r, 1500));
  const rows = [...document.querySelectorAll('.set-row.col')].filter((r) => r.offsetParent).map((r) => { const t = r.querySelector('.s-text'); const inner = [...t.children].reduce((s, c) => s + c.getBoundingClientRect().height, 0);
    const tb = t.getBoundingClientRect(); const c = r.querySelector('.s-ctrl'); const cb = c && c.getBoundingClientRect();
    // 控件区（有的话）和文字区一样宽、左边对齐：撑满整行，不缩到右边
    // 控件区的高度和里面的东西差不多，文字和控件之间不空一大段（rc8 第二处：竖排能换行时控件区按一列算高）
    const kids = c ? [...c.children].map((k) => k.getBoundingClientRect()) : [];
    const kidsH = kids.length ? Math.max(...kids.map((k) => k.bottom)) - Math.min(...kids.map((k) => k.top)) : 0;
    const gapTop = kids.length ? Math.min(...kids.map((k) => k.top)) - tb.bottom : 0;
    const ctrlOk = !c || (Math.abs(cb.left - tb.left) <= 2 && Math.abs(cb.width - tb.width) <= 2 && cb.height <= kidsH + 4 && gapTop <= 20); // 要防的是空出几百像素；紧凑浅色下量出来 16 点几，上限写 16 时过不过看小数（rc9 跑关卡时碰到）
    return { title: (r.querySelector('.s-title') || {}).textContent, textH: Math.round(tb.height), contentH: Math.round(inner), ctrlOk, ctrl: c ? [Math.round(cb.left - tb.left), Math.round(cb.width), Math.round(tb.width), Math.round(cb.height), Math.round(kidsH), Math.round(gapTop)] : null }; });
  // 「最大内存」：文字区嵌在横排小容器里，右边的数值要贴着最右（rc8 第一版的规则误伤过它）
  const mem = [...document.querySelectorAll('.set-row.col')].find((r) => r.offsetParent && /最大内存|Maximum memory/.test(r.textContent));
  const mr = mem && mem.querySelector(':scope > .row'); const last = mr && mr.lastElementChild;
  const memRight = mr && last ? Math.round(mr.getBoundingClientRect().right - last.getBoundingClientRect().right) : null;
  return { rows, memRight, cat: (document.querySelector('.set-cat.active') || { dataset: {} }).dataset.cat }; })()`;

async function functional() {
  const a = await start('rc8-ui', { config: (game) => ({ ...BASE_CONFIG(game), ...SYNC }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); return; }
  await ready(a.ev);
  const ev = (code, t = 30000) => a.ev(code, t);

  // ── 一、上下排的行 ──
  let o = await ev(MEASURE);
  const titles = o.rows.map((r) => r.title);
  check('设置布局', '「游戏」分类里上下排的行（同步哪些、JVM 参数、游戏参数）文字区按内容高，标题下面不空一大块',
    ['同步哪些', 'JVM 参数', '游戏参数'].every((t) => titles.includes(t)) && o.rows.every((r) => r.textH <= r.contentH + 6), o);
  check('设置布局', '「最大内存」右边的数值贴着最右（文字区嵌在横排里的还会伸展）', o.memRight != null && o.memRight <= 2, o.memRight);
  check('设置布局', '上下排的行里控件区撑满整行、从左边排，高度和内容一样（「同步哪些」的勾选框不挤在右边，上下不空一大段）', o.rows.some((r) => r.ctrl) && o.rows.every((r) => r.ctrlOk), o.rows.filter((r) => r.ctrl));
  await shot(a, '设置-游戏');

  // ── 二、迁移入口 ──
  o = await ev(`(async () => { ${clean} await A.go('settings', { focus: 'migrate' }); await new Promise((r) => setTimeout(r, 1200));
    const row = document.getElementById('set-migrate'); const btn = row && [...row.querySelectorAll('.btn')].find((b) => /从其他启动器导入/.test(b.textContent));
    const text = row ? row.textContent : ''; if (btn) btn.click();
    let m = null; for (let i = 0; i < 60 && !(m = document.querySelector('.modal-back:last-child')); i++) await new Promise((r) => setTimeout(r, 100));
    let ready = false; for (let i = 0; i < 150 && m && !ready; i++) { ready = !!m.querySelector('.mg-cand') || /常见位置没有找到/.test(m.textContent); if (!ready) await new Promise((r) => setTimeout(r, 100)); }
    const back = m && [...m.querySelectorAll('.btn')].find((b) => /换一个来源/.test(b.textContent));
    const step = { title: m && (m.querySelector('.modal-title, h2') || {}).textContent, ready, back: !!back, pickDir: !!(m && /选一个文件夹/.test(m.textContent)) };
    if (back) { back.click(); await new Promise((r) => setTimeout(r, 1500)); }
    step.sources = m ? [...m.querySelectorAll('.mg-card b')].map((b) => b.textContent) : [];
    return { found: !!row, text, btn: !!btn, step }; })()`, 60000);
  check('迁移入口', '设置「数据」里那一行说明写着其他启动器，有「从其他启动器导入…」按钮',
    o.found && /官方启动器/.test(o.text) && /HMCL/.test(o.text) && o.btn, { text: o.text, btn: o.btn });
  check('迁移入口', '点了直接到「其他启动器」那一步（列出找到的或让自己选文件夹），「换一个来源」能回到选来源',
    o.step.ready && o.step.back && o.step.pickDir && o.step.sources.includes('其他启动器') && o.step.sources.includes('导出包文件'), o.step);
  await shot(a, '迁移-选来源');

  o = await ev(`(async () => { ${clean} await A.go('versions'); await new Promise((r) => setTimeout(r, 1200));
    const btn = [...document.querySelectorAll('.page-head .btn')].find((b) => /从其他启动器导入/.test(b.textContent)); const vis = !!(btn && btn.offsetParent);
    if (btn) btn.click(); let m = null; for (let i = 0; i < 60 && !(m = document.querySelector('.modal-back:last-child')); i++) await new Promise((r) => setTimeout(r, 100));
    let ready = false; for (let i = 0; i < 150 && m && !ready; i++) { ready = !!m.querySelector('.mg-cand') || /常见位置没有找到/.test(m.textContent); if (!ready) await new Promise((r) => setTimeout(r, 100)); }
    const head = document.querySelector('.page-head'); const over = [...head.querySelectorAll('.btn')].filter((b) => b.getBoundingClientRect().right > head.getBoundingClientRect().right + 1).length;
    return { btn: !!btn, vis, ready, over }; })()`, 60000);
  check('迁移入口', '游戏配置页顶上有「从其他启动器导入」，点了到其他启动器那一步；按钮不出界', o.btn && o.vis && o.ready && o.over === 0, o);
  await ev(`(async () => { ${clean} })()`);
  await shot(a, '游戏配置页');

  // 从「关于」重新打开首次启动向导：一路「下一步」做完，关掉以后问要不要导入
  o = await ev(`(async () => { ${clean} const p = A.setup.open(); await new Promise((r) => setTimeout(r, 800));
    const steps = []; let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      const m = document.querySelector('.setup-modal'); if (!m) { done = true; break; }
      const btn = m.querySelector('.modal-foot .btn.primary'); if (!btn) break;
      if (btn.disabled) { const opt = m.querySelector('.choice:not(.on), .check-row:not(.on), [role=radio]'); if (opt) opt.click(); await new Promise((r) => setTimeout(r, 300)); }
      steps.push(btn.textContent); btn.click(); await new Promise((r) => setTimeout(r, 900));
    }
    await Promise.race([p, new Promise((r) => setTimeout(r, 3000))]);
    let m = null; for (let i = 0; i < 40; i++) { m = [...document.querySelectorAll('.modal-back')].find((x) => /要导入以前的数据吗/.test(x.textContent)); if (m) break; await new Promise((r) => setTimeout(r, 100)); }
    const ask = !!m; const cfg = await A.api('config:get');
    if (m) [...m.querySelectorAll('.modal-foot .btn')].find((b) => /跳过/.test(b.textContent)).click();
    return { steps, closed: !document.querySelector('.setup-modal'), ask, migrateAsk: cfg.migrateAsk }; })()`, 90000);
  check('迁移入口', '从「关于」重新打开首次启动向导，做完以后问「要导入以前的数据吗？」（问过就不再问）', o.closed && o.ask && o.migrateAsk === false, o);
  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 5));
  await a.stop();
}

const LOOKS = [
  ['极光-深', {}], ['像素-深', { ui: { style: 'pixel' }, theme: 'dark' }], ['紧凑-浅', { ui: { style: 'compact' }, theme: 'light' }],
  ['极光-1.5倍', { a11y: { zoom: 1.5 } }], ['极光-高对比', { a11y: { contrast: 'high' } }], ['极光-英文', { language: 'en' }],
];
async function looks() {
  let n = 0;
  for (const [name, cfg] of LOOKS) {
    const a = await start(`rc8-look-${n++}`, { config: (game) => ({ ...BASE_CONFIG(game), ...SYNC, ...cfg }) });
    if (a.startError) { check('外观', `${name}：能打开`, false, a.startError); continue; }
    await ready(a.ev);
    const o = await a.ev(MEASURE, 30000);
    await shot(a, `${name}-设置游戏`);
    check('外观', `${name}：上下排的行文字区按内容高，控件区撑满整行；「最大内存」的数值贴着最右`, o.rows.length >= 3 && o.rows.every((r) => r.textH <= r.contentH + 6 && r.ctrlOk) && o.memRight != null && o.memRight <= 2, { memRight: o.memRight, rows: o.rows });
    check('外观', `${name}：没有页面错误`, a.errors.length === 0, a.errors.slice(0, 3));
    await a.stop();
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await functional();
  if (!process.argv.includes('--quick')) await looks();
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}；截图在 ${SHOTS}`);
  process.exit(bad ? 1 : 0);
})();
