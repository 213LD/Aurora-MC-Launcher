'use strict';
/**
 * rc11 这一轮（2026-11-14）：
 *   node scripts/regress/rc11-ui.js
 * 一、名字改成 Aurora MC Launcher：窗口标题、侧边栏、设置「关于」都是新名字，界面上不再出现「Aurora Minecraft Launcher」。
 *     数据目录的名字不跟着变（老数据还在原处）。
 * 二、调试菜单的密码哈希只在内部版（debugkey.js，公开版是空的替身）：
 *     内部版连点版本号 7 次出密码框，密码不对进不去；密码对了菜单里有「安全限制」一节（危险操作不用等、MC 百科跳过确认和改限速）。
 *     公开版没有密码，连点直接进菜单，但没有「安全限制」一节，A.dbgUnsafe 也置不上。
 * 三、海里的鱼：快进模拟，没有想游却不动的；跟着鱼群的鱼「正在游」的标记跟带头的一样。
 * 内部版和公开版里都能跑：按 editions.js 的差别表分开查（页面里的替身标记要和表对得上）。
 */
const fs = require('fs');
const { start, BASE_CONFIG } = require('./robust-ui');
const { guard, until, FIX_WORLD } = require('./cdp');
const ED = require('./editions');

const results = [];
guard(results, 'rc11-ui'); // 中途出错也把已有结果写进汇总（cdp.js）
function check(id, name, ok, detail = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ id, name, ok: !!ok, detail: d });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${d ? ` — ${d.slice(0, 700)}` : ''}`);
}
const BG = { type: 'scene', scene: 'ocean', time: 'day', fx: 'low', fps: 30, mobs: 12, animals: true, monsters: false, aquatic: true, players: false, buildings: true, pan: true, eggs: false };
const CLEAN = "document.querySelectorAll('.modal-back').forEach((m) => m.remove()); document.querySelectorAll('.toast').forEach((t) => t.remove());";
const CLICK7 = "for (let i = 0; i < 7; i++) document.getElementById('aboutVersion').click();";
const MODAL = "[...document.querySelectorAll('.modal-back')].find((m) => /调试模式/.test(m.textContent))";

(async () => {
  const a = await start('rc11-ui', { stats: true, config: (game) => ({ ...BASE_CONFIG(game), background: BG }) });
  if (a.startError) { check('启动', '能打开', false, a.startError); process.exit(1); }
  const ev = (code, t = 60000) => a.ev(code, t);
  await until(ev, "!!(window.A && A.state && A.state.info && document.getElementById('brandSub'))", 30000);

  // ── 一、名字 ──
  let o = await ev("({ title: document.title, edition: A.state.info.edition, brand: A.BRAND.name, sub: document.getElementById('brandSub').textContent, dir: A.BRAND.dataDirName, abbr: A.BRAND.abbr, zh: A.BRAND.zh })");
  // 内部版的窗口标题标「内部版」（和公开版装在一起时分得清），公开版就是名字（editions.js 的差别表）
  check('名字', '窗口标题是 Aurora MC Launcher（内部版标「内部版」），品牌名是 Aurora MC Launcher，侧边栏副标题是 MC LAUNCHER', o.title === ED.title && o.edition === ED.name && o.brand === 'Aurora MC Launcher' && o.sub === 'MC LAUNCHER', { ...o, want: ED.title });
  check('名字', `缩写、中文名、内部版的数据目录名不变（AML、极光启动器、${ED.TABLE.internal.dataDirName}）`, o.abbr === 'AML' && o.zh === '极光启动器' && o.dir === ED.TABLE.internal.dataDirName, o);
  await ev(`(async () => { ${CLEAN} await A.go('settings', { focus: 'about' }); })()`);
  await until(ev, "!!document.getElementById('aboutVersion')", 15000);
  o = await ev("({ about: document.getElementById('aboutVersion').textContent.slice(0, 60), old: document.body.innerText.includes('Aurora Minecraft Launcher') })");
  check('名字', '设置「关于」是新名字，页面上没有旧名字', /^Aurora MC Launcher/.test(o.about) && !o.old, o);
  o = await ev("(async () => { const d = await A.api('app:disclaimer').catch((e) => ({ error: String(e && e.message || e) })); const s = JSON.stringify(d); return { has: s.includes('Aurora MC Launcher'), old: s.includes('Aurora Minecraft Launcher'), error: d && d.error }; })()");
  check('名字', '免责声明里是新名字', o.has && !o.old, o);

  // ── 二、调试菜单 ──
  // MENU：打开了的调试菜单；UNSAFE：菜单里「安全限制」那一节；TRY_UNSAFE：不经过菜单直接去置 A.dbgUnsafe
  const MENU = "document.querySelector('.modal-back .dbg-modal, .modal-back .dbg')";
  const UNSAFE = "[...document.querySelectorAll('.modal-back .dbg-title')].some((x) => /安全限制/.test(x.textContent))";
  const TRY_UNSAFE = 'A.dbgUnsafe = true; const forced = A.dbgUnsafe; A.dbgUnsafe = false;';
  const pub = !ED.debugPassword;
  check('调试菜单', `调试菜单的密码哈希和这个版本对得上（${ED.name}：${pub ? '空的替身' : '有哈希'}）`, (await ev('!!(A.debugKey && A.debugKey.PUBLIC_STANDIN)')) === pub);
  // 没有密码的菜单（公开版就是这样）：连点版本号直接进；里面没有「安全限制」，A.dbgUnsafe 也置不上
  const noPass = `(async () => { ${CLEAN} ${CLICK7} await new Promise((r) => setTimeout(r, 600)); ${TRY_UNSAFE}
    const titles = [...document.querySelectorAll('.modal-back .dbg-title')].map((x) => x.textContent);
    return { needPass: A.debugMenu.needPass(), trusted: A.debugMenu.trusted(), ask: !!(${MODAL}), menu: !!(${MENU}), unsafe: ${UNSAFE}, forced, sections: titles.length, hasCfg: titles.some((t) => /配置/.test(t)), hasBg: titles.some((t) => /主页动态背景/.test(t)) }; })()`;
  if (!pub) {
    check('调试菜单', '内部版带着密码哈希，进菜单要密码', await ev('A.debugMenu.needPass() && !A.debugMenu.trusted() && /^[0-9a-f]{64}$/.test(A.debugKey.hash)'));
    await ev(`${CLEAN} ${CLICK7} 1`);
    const shown = await until(ev, `!!(${MODAL})`, 5000);
    check('调试菜单', '连点版本号 7 次出密码框', shown);
    await ev(`(() => { const m = ${MODAL}; const i = m.querySelector('input'); i.value = 'not-the-password'; [...m.querySelectorAll('.modal-foot .btn')].find((b) => /进入/.test(b.textContent)).click(); })()`);
    const wrong = await until(ev, `(() => { const m = ${MODAL}; return !!m && /密码不对/.test(m.textContent); })()`, 5000);
    o = await ev(`(() => { ${TRY_UNSAFE} return { menu: !!document.querySelector('.dbg-sec'), trusted: A.debugMenu.trusted(), forced }; })()`);
    check('调试菜单', '密码不对：提示「密码不对」，菜单没有打开，安全限制解除不了', wrong && !o.menu && !o.trusted && !o.forced, o);
    // 换成这次测试临时算的哈希（密码是测试里现编的），输对了：菜单打开，有「安全限制」一节，能解除、能恢复
    o = await ev(`(async () => { ${CLEAN} const keep = A.debugKey.hash; const pass = 'regress-' + Math.random().toString(36).slice(2);
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(A.debugKey.salt + pass));
      A.debugKey.hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      try { ${CLICK7} await new Promise((r) => setTimeout(r, 400)); const m = ${MODAL}; if (!m) return { ask: false };
        m.querySelector('input').value = pass; [...m.querySelectorAll('.modal-foot .btn')].find((b) => /进入/.test(b.textContent)).click();
        await new Promise((r) => setTimeout(r, 800));
        const r1 = { ask: true, menu: !!(${MENU}), trusted: A.debugMenu.trusted(), unsafe: ${UNSAFE} };
        A.dbgUnsafe = true; r1.on = A.dbgUnsafe; A.dbgUnsafe = false; r1.off = A.dbgUnsafe; return r1;
      } finally { A.debugKey.hash = keep; } })()`);
    check('调试菜单', '密码对了：菜单打开，有「安全限制」一节，能解除也能恢复', o.ask && o.menu && o.trusted && o.unsafe && o.on === true && o.off === false, o);
    // 这次运行里已经输对过密码了；把哈希拿掉，就是公开版的样子
    o = await ev(`(async () => { const keep = A.debugKey.hash; A.debugKey.hash = ''; try { return await ${noPass}; } finally { A.debugKey.hash = keep; ${CLEAN} } })()`);
    check('调试菜单', '没有密码哈希时（公开版的样子）：连点版本号直接进菜单，不问密码', !o.needPass && !o.ask && o.menu && o.sections >= 5 && o.hasCfg && o.hasBg, o);
    check('调试菜单', '没有密码的菜单里没有「安全限制」一节，直接去置也解除不了（危险操作照样要等，MC 百科的确认和限速不能跳过）', !o.trusted && !o.unsafe && !o.forced, o);
  } else {
    o = await ev(noPass);
    check('调试菜单', '公开版没有密码哈希：连点版本号直接进菜单，不问密码', !o.needPass && !o.ask && o.menu && o.sections >= 5 && o.hasCfg && o.hasBg, o);
    check('调试菜单', '公开版的菜单里没有「安全限制」一节，直接去置也解除不了', !o.trusted && !o.unsafe && !o.forced, o);
    await ev(`${CLEAN} 1`);
  }
  // 危险操作的确认框：没解除安全限制时主按钮要等几秒才能点
  o = await ev(`(async () => { ${CLEAN} A.dangerConfirm({ level: 2, title: '测试危险确认', text: '不会真的删除任何东西', items: ['示例文件 A'] }); await new Promise((r) => setTimeout(r, 500));
    const m = [...document.querySelectorAll('.modal-back .modal')].pop(); const b = m && [...m.querySelectorAll('.modal-foot .btn')].pop(); const r1 = { shown: !!m, text: b ? b.textContent : '', disabled: b ? b.disabled : null, hook: !!(A.hooks.noDangerWait && A.hooks.noDangerWait()) }; ${CLEAN} return r1; })()`);
  check('调试菜单', '危险操作确认框的等待没有被调试菜单关掉（跳过等待的开关是关着的）', o.shown && !o.hook, o);

  // ── 三、海里的鱼 ──
  // 以前的测试报过一次「热带鱼想游却不动」，没重现。查下来是跟着鱼群的鱼：带头的停下来它跟着停，但它身上「正在游」的标记是旧值。
  // 这里把时间快进（不等真的时间）：海洋、蘑菇岛各三个世界，每个 60 秒，看有没有鱼自己想游却一直不动；跟着的鱼的标记要跟带头的一样
  await ev(`(async () => { ${CLEAN} await A.go('home'); })()`);
  await until(ev, '!!(A.homeScene() && A.homeScene().ents)', 15000);
  await ev(FIX_WORLD);
  o = await ev(`(async () => {
    const s = A.homeScene(); const P = Object.getPrototypeOf(s); const keep = { seed: s.seed, frozen: s.frozen };
    s.frozen = true; await new Promise((r) => setTimeout(r, 200));
    let now = performance.now() + 5000; let swimmers = 0; let followers = 0; let stale = 0; const stuck = [];
    for (const scene of ['ocean', 'mushroom']) for (const seed of [5000, 5776, 6067]) {
      s.seed = seed; s.setOptions({ scene: scene === 'ocean' ? 'mushroom' : 'ocean' }); s.setOptions({ scene, time: 'day' }); s.frozen = true; s.ents = []; s.ensureChunks(true);
      const track = new Map(); const up = P.updateEnt; const sw = P.swimTick; let inSwim = null;
      s.swimTick = function (e, sec, t, spd) { inSwim = e; return sw.call(this, e, sec, t, spd); };
      s.updateEnt = function (e, sec, t) { const x0 = e.x; const y0 = e.y; const st0 = e.state; inSwim = null; up.call(this, e, sec, t); if (!e.spr.swims || inSwim !== e) return;
        let tr = track.get(e); if (!tr) { tr = { k: e.kind, run: 0, max: 0, f: 0 }; track.set(e, tr); }
        if (e.leader) { tr.f = 1; if (!!e.moving !== !!e.leader.moving) stale++; return; }
        if (st0 === 'walk' && e.state === 'walk' && Math.abs(e.x - x0) < 0.001 && Math.abs(e.y - y0) < 0.001) { tr.run++; tr.max = Math.max(tr.max, tr.run); } else tr.run = 0; };
      for (let i = 0; i < 1800; i++) { now += 33; s.update(33, now); }
      delete s.updateEnt; delete s.swimTick;
      for (const t of track.values()) { swimmers++; if (t.f) followers++; if (t.max > 90) stuck.push(scene + ':' + seed + ' ' + t.k + ' ' + (t.max * 0.033).toFixed(1) + ' 秒'); }
    }
    s.seed = keep.seed; s.setOptions({ scene: 'plains', time: 'day' }); s.frozen = keep.frozen;
    return { swimmers, followers, stale, stuck };
  })()`, 300000);
  check('鱼', '海洋、蘑菇岛六个世界各快进 60 秒：没有自己想游却连着 3 秒不动的鱼', o.swimmers > 40 && o.stuck.length === 0, o);
  check('鱼', '跟着鱼群的鱼「正在游」的标记跟带头的一样（以前是它自己的旧值）', o.followers > 5 && o.stale === 0, o);

  check('页面', '没有页面错误', a.errors.length === 0, a.errors.slice(0, 3));
  await a.stop();
  if (process.env.AURORA_REGRESS_OUT) fs.appendFileSync(process.env.AURORA_REGRESS_OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
  process.exit(bad ? 1 : 0);
})();
