'use strict';
/* 隐藏的启动器调试菜单（1.4.11）：设置 → 关于里连点版本号 7 次，内部版再输入密码，公开版直接进（rc11）。
 * 给测试人员还原「首次启动、默认设置、看过的提示、主页背景」这些不好手动还原的状态。
 * 密码只存加盐的 SHA-256，只是挡一下好奇的小朋友，不是安全措施 */
(function () {
  const { h, icon, api, state } = A;

  // 密码的哈希在 debugkey.js：内部版有，进菜单要输密码；公开版的替身里是空的，连点版本号直接进（rc11）
  const KEY = A.debugKey || {};
  const needPass = () => /^[0-9a-f]{64}$/.test(KEY.hash || '');
  // 输对过密码的测试人员。「安全限制」那一节（危险操作不用等、MC 百科跳过风险确认和改限速）只给他们：
  // 没有密码的菜单（公开版）里没有这一节，A.dbgUnsafe 也打不开。别的几节最多改设置（都先备份、能还原），碰不到存档和游戏文件
  const trusted = () => needPass() && unlocked;
  let unlocked = false; // 这次运行里输对过就不再问

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 设置页「关于」的版本号：2 秒内连点 7 次
  let clicks = [];
  function versionClick() {
    const now = Date.now();
    clicks = clicks.filter((t) => now - t < 2000);
    clicks.push(now);
    if (clicks.length >= 7) { clicks = []; unlock(); }
  }

  function unlock() {
    if (!needPass() || unlocked) return open();
    const input = h('input.input', { type: 'password', placeholder: '密码', autocomplete: 'off', style: { width: '100%' } });
    const err = h('div.faint', { style: { fontSize: '12px', marginTop: '8px', minHeight: '16px', color: 'var(--danger)' } });
    const check = async () => {
      if (await sha256(KEY.salt + input.value) === KEY.hash) { unlocked = true; m.close(); open(); return true; }
      err.textContent = '密码不对';
      input.select();
      return false;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
    const m = A.modal({
      title: '调试模式', icon: 'lock', size: 'sm',
      body: h('div', h('p', { style: { marginBottom: '10px' } }, '给测试人员用的，输入密码进入'), input, err),
      actions: [{ label: '取消', kind: 'ghost' }, { label: '进入', kind: 'primary', onClick: check }],
    });
    setTimeout(() => input.focus(), 50);
  }

  // ───────── 菜单 ─────────
  const section = (title, desc, ...rows) => h('div.dbg-sec', h('div.dbg-title', title), desc ? h('div.dbg-desc', desc) : null, h('div.dbg-row', ...rows));
  const btn = (label, onClick, ic, kind = '') => h('button', { class: `btn sm ${kind}`, onclick: onClick }, ic ? icon(ic, 14) : null, label);

  async function cfgAction(action, done) {
    try {
      const r = await api('config:debug', action);
      state.config = r.config;
      A.emit('config', state.config);
      if (done) done();
    } catch (e) { A.toast({ level: 'crit', title: '调试操作失败', text: e.message || String(e) }); }
  }

  function showTagMisses() {
    const list = A.tagMisses.list();
    const text = list.map(([tag, n]) => `${tag}\t${n}`).join('\n');
    A.modal({
      title: '没翻译的资源标签', subtitle: list.length ? `共 ${list.length} 个` : '', icon: 'file',
      body: list.length
        ? h('div.dbg-misses', list.slice(0, 200).map(([tag, n]) => h('div.dbg-miss', h('span.mono', tag), h('span.faint', `${n} 次`))))
        : h('div.faint', '还没有记录。去下载页翻几页 Modrinth / CurseForge 再来看'),
      actions: [
        ...(list.length ? [{ label: '复制全部', kind: 'ghost', onClick: () => { navigator.clipboard.writeText(text); A.toast({ level: 'ok', text: '已复制' }); return false; } }] : []),
        { label: '关闭', kind: 'primary' },
      ],
    });
  }

  // ───────── 主页背景调试的浮动面板（1.5.7）：菜单是对话框，会挡住主页；面板不挡，可以边看边点背景里的生物 ─────────
  let floatEl = null;
  let floatTimer = 0;
  function closeFloat() { if (floatEl) floatEl.remove(); floatEl = null; clearInterval(floatTimer); edgeOverlay(false); }

  // ───────── 边缘平移范围（1.7.2）：在主页上画出上下左右的感应带，实时显示鼠标下面是什么、背景有没有收到 ─────────
  let edgeEl = null;
  let edgeTimer = 0;
  let lastMove = null;
  const onMove = (e) => { lastMove = { x: e.clientX, y: e.clientY, el: e.target, t: performance.now() }; drawEdges(); };
  const descEl = (el) => {
    if (!el || !el.tagName) return '（无）';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
  };
  function drawEdges() {
    if (!edgeEl) return;
    const s = A.homeScene && A.homeScene();
    if (!s || state.page !== 'home') { A.mount(edgeEl, h('div.dbg-edge-info', '回到主页、背景是动态像素场景时才显示')); return; }
    const { r, top, hgt, bot, floor, cover, zx, zy } = s.edgeZones();
    const box = (x, y, w, hh, cls, label) => h(`div.dbg-edge.${cls}`, { style: { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, hh)}px` } }, label ? h('span', label) : null);
    const m = lastMove;
    const blank = m && A.homeBlankAt ? A.homeBlankAt(m.el) : false;
    const e = s.edge;
    const lines = [
      `画布 ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}（比窗口大一圈）· 顶栏盖住 ${Math.round(cover)}px，上边感应带从 y=${Math.round(top)} 开始`,
      `左右感应带各占画布宽 ${Math.round(zx * 100)}%（${Math.round(r.width * zx)}px），上下各占 ${Math.round(zy * 100)}%（${Math.round(hgt * zy)}px）`,
      m ? `鼠标 ${Math.round(m.x)},${Math.round(m.y)} · 下面是 ${descEl(m.el)} · ${blank ? '算背景，会平移' : '是界面元素，不平移'} · ${Math.round(performance.now() - m.t)}ms 前收到` : '还没收到鼠标移动',
      `平移：${e ? `dx ${e.dx.toFixed(2)}  dy ${e.dy.toFixed(2)}${performance.now() - e.since < 450 ? '（停 0.45 秒后才开始动）' : ''}` : '没有'} · 移动视角设置：${s.opts.pan ? '开' : '关'}${s.frozen ? ' · 画面定格中，不会平移' : ''}`,
    ];
    A.mount(edgeEl,
      box(r.left, Math.max(0, r.top), r.width, top - Math.max(0, r.top), 'dead', '顶栏：鼠标在这里时网页收不到移动（这块是拖动窗口用的）'),
      box(r.left, top, r.width * zx, hgt, 'zone', '左'),
      box(r.right - r.width * zx, top, r.width * zx, hgt, 'zone', '右'),
      box(r.left, top, r.width, hgt * zy, 'zone', '上（越靠上越快）'),
      box(r.left, bot, r.width, floor - bot, 'zone', '下（从启动栏上面一条到窗口底部；启动栏、按钮上不算）'),
      m ? h('div.dbg-edge-dot', { style: { left: `${m.x}px`, top: `${m.y}px` } }) : null,
      h('div.dbg-edge-info.mono', lines.map((l) => h('div', l))));
  }
  function edgeOverlay(on) {
    if (on === undefined) on = !edgeEl;
    if (!on) {
      if (edgeEl) edgeEl.remove();
      edgeEl = null; clearInterval(edgeTimer);
      document.removeEventListener('mousemove', onMove, true);
      return false;
    }
    if (edgeEl) return true;
    edgeEl = h('div.dbg-edges', { 'aria-hidden': 'true' });
    document.body.append(edgeEl);
    document.addEventListener('mousemove', onMove, true);
    edgeTimer = setInterval(drawEdges, 250);
    drawEdges();
    return true;
  }
  function sceneControls() {
    const info = h('div.dbg-info.mono');
    const showInfo = () => {
      const s = A.homeScene && A.homeScene();
      info.textContent = s ? (() => { const i = s.info(); return `场景 ${i.scene}（${i.name}）· 时段 ${i.period} · 实体 ${i.mobs}${s.running ? '' : s.frozen ? ' · 定格（性能模式 / 减少动态效果）' : ' · 已暂停'}${i.festival ? ` · 节日 ${i.festival}` : ''}`; })() : '主页背景不是动态场景（设置 → 外观里换成动态像素背景）';
    };
    const withScene = (fn) => () => {
      const s = A.homeScene && A.homeScene();
      if (!s) return A.toast({ level: 'warn', text: '主页背景不是动态场景' });
      fn(s, performance.now());
      showInfo();
    };
    const scene = A.homeScene && A.homeScene();
    const sceneSel = h('select.input.sm', { onchange: (e) => withScene((s) => s.setOptions({ scene: e.target.value }))() },
      h('option', { value: 'auto' }, '自动'), Object.entries(A.SCENES || {}).map(([k, v]) => h('option', { value: k }, v.name)));
    const timeSel = h('select.input.sm', { onchange: (e) => withScene((s) => s.setOptions({ time: e.target.value }))() },
      [['auto', '跟随真实时间'], ['dawn', '黎明'], ['day', '白天'], ['sunset', '黄昏'], ['night', '夜晚']].map(([v, l]) => h('option', { value: v }, l)));
    if (scene) { sceneSel.value = scene.opts.scene; timeSel.value = scene.opts.time; }
    const spawn = (kind) => withScene((s, now) => s.spawnMob(kind, now));
    showInfo();
    return {
      showInfo,
      el: h('div.dbg',
        h('div.dbg-row', h('label.dbg-field', '场景', sceneSel), h('label.dbg-field', '时段', timeSel),
          // 定格的画面（性能模式、减少动态效果）也能临时动起来
          btn('暂停 / 继续', withScene((s) => { if (s.running) s.stop(); else { s.frozen = false; s.start(); } }), 'clock'),
          btn('重新生成', withScene((s) => { s.ents = []; s.parts = []; s.build(); if (!s.running) s.draw(16); }), 'dice')),
        h('div.dbg-row',
          ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'pig', 'cow'].map((k) => btn(`刷 ${k}`, spawn(k))),
          btn('烟花', withScene((s) => s.fireworks(8)), 'sparkles'),
          btn('流星', withScene((s) => s.shootingStar())),
          btn('Herobrine', withScene((s, now) => s.herobrine(now))),
          btn('末影龙', withScene((s, now) => s.dragon(now))),
          btn('苦力怕全炸', withScene((s, now) => { for (const e of s.ents.filter((x) => x.kind === 'creeper')) s.explode(e, now); }), 'flame'),
          btn('显示 / 隐藏边缘平移范围', () => edgeOverlay(), 'eye')),
        info),
    };
  }
  function openFloat() {
    closeFloat();
    if (A.closeTopModal) A.closeTopModal();
    A.go('home');
    const c = sceneControls();
    const head = h('div.dbg-float-head', icon('wrench', 14), h('b', '主页背景调试'), h('span.faint', '拖这里移动'), h('div.spacer'),
      h('button.btn.icon.ghost.sm', { 'data-tip': '关闭', onclick: closeFloat }, icon('x', 14)));
    floatEl = h('div.dbg-float', { role: 'dialog', 'aria-label': '主页背景调试' }, head, c.el);
    // 拖动标题栏移动面板
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = floatEl.getBoundingClientRect();
      const dx = e.clientX - r.left; const dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        floatEl.style.left = `${Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx))}px`;
        floatEl.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
        floatEl.style.right = 'auto'; floatEl.style.bottom = 'auto';
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    floatEl.querySelectorAll('select').forEach((s) => s.addEventListener('click', (e) => e.stopPropagation()));
    document.body.append(floatEl);
    floatTimer = setInterval(c.showInfo, 1000);
  }

  // ───────── 安全限制（1.5.7）：只在这次运行里有效，重启就恢复 ─────────
  // A.dbgUnsafe 为真时：MC 百科跳过风险确认和倒计时、「查一次」不再问；危险操作确认框不用等 3 秒（仍要勾选 / 输入名字）；可以改 MC 百科的请求间隔和并发
  function unsafeSection() {
    const wrap = h('div');
    // MC 百科那几项在 mcmodui.js 里（公开版的概念演示替身没有）
    const mc = !A.mcmodUi.CONCEPT;
    const draw = async () => {
      const limits = mc && A.dbgUnsafe ? await A.mcmodUi.debugLimits(btn, draw) : null;
      A.mount(wrap, section('安全限制', `解除后只在这次运行里有效，重启启动器就恢复：${mc ? 'MC 百科跳过风险确认和倒计时、「查一次」不再询问、可以改请求间隔和并发；' : ''}删除等危险操作的确认框不用等 3 秒（仍要勾选或输入名字）`,
        h('label.dbg-field', A.toggle(!!A.dbgUnsafe, async (v) => {
          A.dbgUnsafe = v;
          A.hooks.noDangerWait = A.dbgUnsafe ? () => A.dbgUnsafe : null;
          if (!v && mc) await A.mcmodUi.resetLimits();
          draw();
        }), A.dbgUnsafe ? '已解除' : '解除安全限制')),
      limits);
    };
    draw();
    return wrap;
  }

  // ───────── 显卡 / 处理器模拟器（1.5.7）：模拟别的电脑跑一键修复的硬件检查，可以填还不存在的型号 ─────────
  const ago = (months) => new Date(Date.now() - months * 30.44 * 86400000).toISOString().slice(0, 10);
  const HW_PRESETS = [
    { label: '高配台式：RTX 4090 + i9-14900K + 64 GB', spec: { gpus: [{ name: 'NVIDIA GeForce RTX 4090', driverDate: ago(2) }], cpu: { name: 'Intel(R) Core(TM) i9-14900K', threads: 32 }, ramGB: 64 } },
    { label: '游戏本双显卡：Iris Xe + RTX 4060 Laptop', spec: { gpus: [{ name: 'Intel(R) Iris(R) Xe Graphics', driverDate: ago(8) }, { name: 'NVIDIA GeForce RTX 4060 Laptop GPU', driverDate: ago(5) }], cpu: { name: 'Intel(R) Core(TM) i7-13700H', threads: 20 }, ramGB: 16 } },
    { label: '老电脑：HD Graphics 3000 + i5-2400 + 4 GB', spec: { gpus: [{ name: 'Intel(R) HD Graphics 3000', driverDate: '2015-06-01' }], cpu: { name: 'Intel(R) Core(TM) i5-2400 CPU @ 3.10GHz', threads: 4 }, ramGB: 4 } },
    // 低配 / 老电脑 / 退役服务器处理器（1.5.8）
    { label: '上古电脑：Core 2 Duo E8400 + GT 210 + 4 GB', spec: { gpus: [{ name: 'NVIDIA GeForce 210', driverDate: '2016-12-01' }], cpu: { name: 'Intel(R) Core(TM)2 Duo CPU E8400 @ 3.00GHz', threads: 2 }, ramGB: 4 } },
    { label: '上古电脑：Pentium 4 + 集成显卡 + 2 GB', spec: { gpus: [{ name: 'Intel(R) 82945G Express Chipset Family', driverDate: '2009-03-01' }], cpu: { name: 'Intel(R) Pentium(R) 4 CPU 3.00GHz', threads: 2 }, ramGB: 2 } },
    { label: '一代酷睿：i7-920 + GTX 460 + 6 GB', spec: { gpus: [{ name: 'NVIDIA GeForce GTX 460', driverDate: '2018-01-01' }], cpu: { name: 'Intel(R) Core(TM) i7 CPU 920 @ 2.67GHz', threads: 8 }, ramGB: 6 } },
    { label: 'AMD 老平台：Phenom II X4 965 + HD 6850', spec: { gpus: [{ name: 'AMD Radeon HD 6850', driverDate: '2015-11-01' }], cpu: { name: 'AMD Phenom(tm) II X4 965 Processor', threads: 4 }, ramGB: 8 } },
    { label: 'AMD 推土机：FX-8350 + GTX 750 Ti', spec: { gpus: [{ name: 'NVIDIA GeForce GTX 750 Ti', driverDate: ago(30) }], cpu: { name: 'AMD FX(tm)-8350 Eight-Core Processor', threads: 8 }, ramGB: 8 } },
    { label: '洋垃圾：Xeon X5670 + GTX 750 Ti + 8 GB', spec: { gpus: [{ name: 'NVIDIA GeForce GTX 750 Ti', driverDate: ago(30) }], cpu: { name: 'Intel(R) Xeon(R) CPU X5670 @ 2.93GHz', threads: 12 }, ramGB: 8 } },
    { label: '洋垃圾：Xeon E5-2650 v2 + GTX 960 + 16 GB', spec: { gpus: [{ name: 'NVIDIA GeForce GTX 960', driverDate: ago(20) }], cpu: { name: 'Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz', threads: 16 }, ramGB: 16 } },
    { label: '洋垃圾双路：2 × E5-2680 v4 + RX 580 2048SP', spec: { gpus: [{ name: 'Radeon RX 580 2048SP', driverDate: ago(12) }], cpu: { name: 'Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz', threads: 56 }, ramGB: 64 } },
    { label: '亮机卡：奔腾 G4560 + GT 1030 + 8 GB', spec: { gpus: [{ name: 'NVIDIA GeForce GT 1030', driverDate: ago(10) }], cpu: { name: 'Intel(R) Pentium(R) CPU G4560 @ 3.50GHz', threads: 4 }, ramGB: 8 } },
    { label: '上网本 / 平板：Atom x5-Z8350 + HD 400 + 2 GB', spec: { gpus: [{ name: 'Intel(R) HD Graphics 400', driverDate: '2017-05-01' }], cpu: { name: 'Intel(R) Atom(TM) x5-Z8350 CPU @ 1.44GHz', threads: 4 }, ramGB: 2 } },
    // 其他架构和国产处理器（1.5.8）
    { label: 'ARM 笔记本：骁龙 X Elite + Adreno X1-85', spec: { gpus: [{ name: 'Qualcomm(R) Adreno(TM) X1-85 GPU', pnp: 'ACPI\\QCOM0C36\\0', driverDate: ago(3) }], cpu: { name: 'Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Oryon(TM) CPU', threads: 12 }, ramGB: 16 } },
    { label: 'Surface Pro X（SQ2）+ Windows 10 ARM', spec: { gpus: [{ name: 'Qualcomm(R) Adreno(TM) 690 GPU', pnp: 'ACPI\\QCOM0C26\\0', driverDate: ago(30) }], cpu: { name: 'Microsoft SQ2 @ 3.15 GHz', threads: 8 }, ramGB: 16, osBuild: 19045 } },
    { label: 'NVIDIA ARM 笔记本：N1X（RTX Spark）', spec: { gpus: [{ name: 'NVIDIA GeForce RTX Spark', pnp: 'ACPI\\NVDA0001\\0', driverDate: ago(1) }], cpu: { name: 'NVIDIA N1X', threads: 20 }, ramGB: 32 } },
    { label: 'Mac（M2）上的 Parallels 虚拟机', spec: { gpus: [{ name: 'Parallels Display Adapter (WDDM)', pnp: 'PCI\\VEN_1AB8&DEV_4005' }], cpu: { name: 'Apple M2', threads: 8 }, ramGB: 8, system: { manufacturer: 'Parallels International GmbH.', model: 'Parallels ARM Virtual Machine' } } },
    { label: '树莓派 5 跑 Windows（没有显卡驱动）', spec: { gpus: [{ name: 'Microsoft Basic Display Adapter', pnp: 'ACPI\\BCM2850\\0' }], cpu: { name: 'Broadcom BCM2712 Cortex-A76', threads: 4 }, ramGB: 8 } },
    { label: '香橙派 5（RK3588 + Mali-G610）', spec: { gpus: [{ name: 'ARM Mali-G610 MP4', pnp: 'ACPI\\RKCP0001\\0', driverDate: ago(6) }], cpu: { name: 'Rockchip RK3588', threads: 8 }, ramGB: 16 } },
    { label: 'RISC-V 开发板（假设能跑 Windows）', spec: { gpus: [{ name: 'Microsoft Basic Display Adapter', pnp: 'ACPI\\THEAD01\\0' }], cpu: { name: 'SiFive P550 RISC-V', threads: 4, arch: 'riscv64' }, ramGB: 16 } },
    { label: '国产：兆芯 KX-6640MA + 兆芯核显', spec: { gpus: [{ name: 'Zhaoxin C-960 Graphics', driverDate: ago(14) }], cpu: { name: 'ZHAOXIN KaiXian KX-6640MA@2.2GHz', threads: 4 }, ramGB: 8 } },
    { label: '国产显卡：摩尔线程 MTT S80 + i5-12400F', spec: { gpus: [{ name: 'Moore Threads MTT S80', driverDate: ago(2) }], cpu: { name: 'Intel(R) Core(TM) i5-12400F', threads: 12 }, ramGB: 16 } },
    { label: '国产显卡：砺算 7G106 + Ryzen 5 7500F', spec: { gpus: [{ name: 'Lisuan 7G106', driverDate: ago(1) }], cpu: { name: 'AMD Ryzen 5 7500F 6-Core Processor', threads: 12 }, ramGB: 32 } },
    { label: '全国产：兆芯 KX-7000 + 摩尔线程 MTT S70', spec: { gpus: [{ name: 'Moore Threads MTT S70', driverDate: ago(3) }], cpu: { name: 'ZHAOXIN KaiXian KX-7000/8@3.0GHz', threads: 8 }, ramGB: 16 } },
    { label: '国产：兆芯 KX-7000 + GTX 1650', spec: { gpus: [{ name: 'NVIDIA GeForce GTX 1650', driverDate: ago(4) }], cpu: { name: 'ZHAOXIN KaiXian KX-7000/8@3.0GHz', threads: 8 }, ramGB: 16 } },
    { label: '国产：海光 C86 3250 + RX 6600', spec: { gpus: [{ name: 'AMD Radeon RX 6600', driverDate: ago(4) }], cpu: { name: 'Hygon C86 3250  8-core Processor', threads: 16 }, ramGB: 16 } },
    { label: '服务器：EPYC 7763（64 核）+ A10 云主机', spec: { gpus: [{ name: 'NVIDIA A10', driverDate: ago(4) }], cpu: { name: 'AMD EPYC 7763 64-Core Processor', threads: 16 }, ramGB: 32, system: { manufacturer: 'Alibaba Cloud', model: 'Alibaba Cloud ECS' } } },
    { label: '没装显卡驱动（基本显示适配器）', spec: { gpus: [{ name: 'Microsoft Basic Display Adapter', pnp: 'PCI\\VEN_10DE&DEV_2684' }], cpu: { name: 'Intel(R) Core(TM) i5-12400F', threads: 12 }, ramGB: 16 } },
    { label: 'SLI：2 × RTX 3080', spec: { gpus: [{ name: 'NVIDIA GeForce RTX 3080', driverDate: ago(6) }, { name: 'NVIDIA GeForce RTX 3080', driverDate: ago(6) }], cpu: { name: 'AMD Ryzen 9 5950X 16-Core Processor', threads: 32 }, ramGB: 32 } },
    { label: '交火：2 × RX 6800 XT', spec: { gpus: [{ name: 'AMD Radeon RX 6800 XT', driverDate: ago(6) }, { name: 'AMD Radeon RX 6800 XT', driverDate: ago(6) }], cpu: { name: 'AMD Ryzen 7 5800X 8-Core Processor', threads: 16 }, ramGB: 32 } },
    { label: '虚拟机：VMware SVGA 3D', spec: { gpus: [{ name: 'VMware SVGA 3D', pnp: 'PCI\\VEN_15AD&DEV_0405' }], cpu: { name: 'Intel(R) Core(TM) i7-12700K', threads: 4 }, ramGB: 8, system: { manufacturer: 'VMware, Inc.', model: 'VMware20,1' } } },
    { label: '虚拟机：VMware 还没装 VMware Tools', spec: { gpus: [{ name: 'Microsoft Basic Display Adapter', pnp: 'PCI\\VEN_15AD&DEV_0405' }], cpu: { name: 'Intel(R) Core(TM) i7-12700K', threads: 4 }, ramGB: 8, system: { manufacturer: 'VMware, Inc.', model: 'VMware20,1' } } },
    { label: '虚拟机：VirtualBox', spec: { gpus: [{ name: 'VirtualBox Graphics Adapter (WDDM)', pnp: 'PCI\\VEN_80EE&DEV_BEEF' }], cpu: { name: 'AMD Ryzen 5 5600X 6-Core Processor', threads: 4 }, ramGB: 8, system: { manufacturer: 'innotek GmbH', model: 'VirtualBox' } } },
    { label: '云桌面 / Hyper-V：Microsoft Hyper-V Video', spec: { gpus: [{ name: 'Microsoft Hyper-V Video', pnp: 'VMBUS\\{02780ADA-77E3-4B0F}' }], cpu: { name: 'AMD EPYC 7763 64-Core Processor', threads: 8 }, ramGB: 16, system: { manufacturer: 'Microsoft Corporation', model: 'Virtual Machine' } } },
    { label: 'QEMU / KVM：Red Hat QXL', spec: { gpus: [{ name: 'Red Hat QXL controller', pnp: 'PCI\\VEN_1B36&DEV_0100' }], cpu: { name: 'QEMU Virtual CPU version 2.5+', threads: 4 }, ramGB: 8, system: { manufacturer: 'QEMU', model: 'Standard PC (Q35 + ICH9, 2009)' } } },
    { label: '带显卡的云电脑：NVIDIA A10G', spec: { gpus: [{ name: 'NVIDIA A10G', driverDate: ago(4) }], cpu: { name: 'AMD EPYC 7R32', threads: 8 }, ramGB: 32, system: { manufacturer: 'Amazon EC2', model: 'g5.2xlarge' } } },
    { label: '远程桌面：RTX 3070 + 远程显示适配器', spec: { gpus: [{ name: 'NVIDIA GeForce RTX 3070', driverDate: ago(3) }, { name: 'Microsoft Remote Display Adapter', pnp: 'SWD\\REMOTEDISPLAYENUM\\RDPIDD' }], cpu: { name: 'Intel(R) Core(TM) i7-10700 CPU', threads: 16 }, ramGB: 32, remote: true } },
    { label: '远程控制软件：ToDesk 虚拟显示器 + 向日葵、RustDesk 在运行', spec: { gpus: [{ name: 'NVIDIA GeForce RTX 3060', driverDate: ago(3) }, { name: 'ToDesk Virtual Display Adapter', pnp: 'ROOT\\DISPLAY\\0001' }], cpu: { name: 'Intel(R) Core(TM) i5-12400F', threads: 12 }, ramGB: 16, processes: ['SunloginClient', 'rustdesk'] } },
    { label: '只有串流软件的虚拟显示器（Parsec）', spec: { gpus: [{ name: 'Parsec Virtual Display Adapter', pnp: 'ROOT\\DISPLAY\\0000' }], cpu: { name: 'Intel(R) Core(TM) i5-8400 CPU', threads: 6 }, ramGB: 8 } },
    { label: '未来型号：RTX 6090 + Core Ultra 9 485K + 128 GB', spec: { gpus: [{ name: 'NVIDIA GeForce RTX 6090', driverDate: ago(1) }], cpu: { name: 'Intel(R) Core(TM) Ultra 9 485K', threads: 24 }, ramGB: 128 } },
  ];
  function hardwareSection(closeMenu) {
    const gpuIn = h('textarea.textarea.mono', { rows: 3, spellcheck: 'false', placeholder: '每行一块显卡：名字 | 驱动日期（可选）| 设备 ID（可选，例如 PCI\\VEN_15AD）\nNVIDIA GeForce RTX 6090 | 2027-01-01', style: { width: '100%', fontSize: '12px' } });
    const cpuIn = h('input.input.sm', { placeholder: '处理器型号，例如 AMD Ryzen 9 11950X', style: { width: '260px' } });
    const thrIn = h('input.input.sm', { type: 'number', min: 1, max: 256, value: 8, style: { width: '70px' } });
    const ramIn = h('input.input.sm', { type: 'number', min: 1, max: 4096, value: 16, style: { width: '70px' } });
    const vmIn = h('input.input.sm', { placeholder: '虚拟机 / 云主机型号（不填 = 真机）', style: { width: '240px' } });
    const rdpIn = h('input', { type: 'checkbox' });
    // 架构和 Windows 版本号（1.5.8）：ARM、RISC-V、Windows 10 ARM 的预设要用
    const archIn = h('select.input.sm', {}, [['', '按型号猜'], ['x64', 'x64'], ['arm64', 'ARM64'], ['riscv64', 'RISC-V'], ['loong64', '龙芯 LoongArch'], ['x86', 'x86（32 位）']].map(([v, l]) => h('option', { value: v }, l)));
    const buildIn = h('input.input.sm', { type: 'number', min: 10000, max: 99999, placeholder: '26100', style: { width: '90px' } });
    const procIn = h('input.input.sm', { placeholder: '正在运行的程序，逗号分隔，例如 ToDesk, SunloginClient', style: { width: '320px' } });
    const out = h('div.dbg-info.mono', { style: { whiteSpace: 'pre-wrap', marginTop: '6px' } });
    const fill = (spec) => {
      gpuIn.value = spec.gpus.map((g) => [g.name, g.driverDate || '', g.pnp || ''].join(' | ').replace(/( \| )+$/, '')).join('\n');
      cpuIn.value = spec.cpu.name; thrIn.value = spec.cpu.threads; ramIn.value = spec.ramGB;
      vmIn.value = spec.system ? `${spec.system.manufacturer} ${spec.system.model}`.trim() : ''; rdpIn.checked = !!spec.remote;
      procIn.value = (spec.processes || []).join(', ');
      archIn.value = spec.cpu.arch || ''; buildIn.value = spec.osBuild || '';
    };
    const presetSel = h('select.input.sm', { onchange: (e) => { const p = HW_PRESETS[Number(e.target.value)]; if (p) fill(p.spec); } },
      h('option', { value: '' }, '选一个预设（会填进下面，可以再改）…'), HW_PRESETS.map((p, i) => h('option', { value: i }, p.label)));
    const show = (r) => {
      out.textContent = r ? [
        `显卡：${r.gpus.map((g) => `${g.name}（${g.vm ? `虚拟显卡 ${g.vm}` : g.basic ? '基本显示适配器' : `${g.basis || ''} · 档次 ${g.tier} · ${g.conf}`}）`).join('；') || '无'}`,
        r.virtualDisplays.length ? `虚拟显示器（不算显卡）：${r.virtualDisplays.join('、')}` : '',
        `处理器：${r.cpu.name}（${r.cpu.basis} · ${r.cpu.arch || 'x64'} · 档次 ${r.cpu.tier} · ${r.cpu.conf}）· ${r.cpu.threads} 线程 · 内存 ${Math.round(r.ramMB / 1024)} GB${r.osBuild ? ` · Windows 版本号 ${r.osBuild}` : ''}`,
        r.vm ? `虚拟机 / 云电脑：${r.vm.name}` : '', r.remote ? '远程桌面会话' : '',
        r.remoteApps && r.remoteApps.length ? `远程控制软件：${r.remoteApps.map((a) => `${a.name}${a.running ? '（在运行）' : ''}${a.display ? `（虚拟显示器 ${a.display}）` : ''}`).join('、')}` : '',
      ].filter(Boolean).join('\n') : '没有在模拟，一键修复用的是这台电脑的真实硬件';
    };
    api('debug:hardware').then(show).catch(() => {});
    return section('显卡 / 处理器模拟器', '只在这次运行里有效：一键修复的「显卡与硬件」检查会改用这里的配置。可以选预设，也可以手动填还不存在的型号，看推算对不对（面向未来测试）',
      h('div', { style: { width: '100%' } },
        h('div.dbg-row', presetSel),
        h('div.dbg-row', gpuIn),
        h('div.dbg-row', h('label.dbg-field', '处理器', cpuIn), h('label.dbg-field', '线程', thrIn), h('label.dbg-field', '内存 GB', ramIn)),
        h('div.dbg-row', h('label.dbg-field', '架构', archIn), h('label.dbg-field', { 'data-tip': '22000 以下是 Windows 10，不填当成 Windows 11' }, 'Windows 版本号', buildIn)),
        h('div.dbg-row', h('label.dbg-field', '虚拟机', vmIn), h('label.dbg-field', rdpIn, '远程桌面会话')),
        h('div.dbg-row', h('label.dbg-field', '程序', procIn)),
        h('div.dbg-row',
          btn('开始模拟', async () => {
            const gpus = gpuIn.value.split(/\r?\n/).map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0]).map(([name, driverDate, pnp]) => ({ name, driverDate: /^\d{4}-\d{2}-\d{2}$/.test(driverDate || '') ? driverDate : '', pnp: pnp || undefined }));
            const vm = vmIn.value.trim();
            try {
              A.shaderUi.forget();
              show(await api('debug:hardware', { gpus, cpu: { name: cpuIn.value.trim(), threads: Number(thrIn.value) || 8, arch: archIn.value || undefined }, osBuild: Number(buildIn.value) || undefined, ramGB: Number(ramIn.value) || 16, system: vm ? { manufacturer: vm, model: vm } : null, remote: rdpIn.checked, processes: procIn.value.split(/[,，\s]+/).filter(Boolean) }));
              A.toast({ level: 'warn', text: '已开始模拟硬件，去一键修复页重新检查就能看到结果', actions: [{ label: '去一键修复', onClick: () => { closeMenu(); A.go('repair'); } }] });
            } catch (e) { A.errorToast('模拟失败', e); }
          }, 'play', 'primary'),
          btn('取消模拟', async () => { A.shaderUi.forget(); show(await api('debug:hardware', null).catch(() => null)); }, 'x'),
          btn('去一键修复', () => { closeMenu(); A.go('repair'); }, 'wrench')),
        out));
  }

  /** 终极彩蛋「Minecraft doesn't need you」（1.5.16，ultimate.js）：看计时、跳阶段、直接触发结局、播放终末之诗、清掉龙蛋 */
  function ultimateSection(closeMenu) {
    const U = A.ultimate && A.ultimate.debug;
    if (!U) return null;
    const info = h('div.dbg-info.mono', { style: { whiteSpace: 'pre-wrap', width: '100%' } });
    const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    const refresh = () => {
      const i = U.info();
      info.textContent = `累计挂机 ${fmt(i.counted)} / ${fmt(U.GOAL)} · 阶段 ${i.stage} / 5 · 多出来的末影人 ${i.extra}\n`
        + `现在${i.counting ? '在' : '不在'}计时（彩蛋开关${i.eggs ? '开' : '关'}、性能模式${i.perf ? '开' : '关'}、游戏${i.game ? '在运行' : '没运行'}、${i.done ? '已完成（有龙蛋）' : '还没完成'}${i.running ? '、结局进行中' : ''}）`;
    };
    refresh();
    const timer = setInterval(() => { if (!info.isConnected) { clearInterval(timer); return; } refresh(); }, 1000);
    const act = (fn) => () => { fn(); refresh(); };
    return section("终极彩蛋「Minecraft doesn't need you」", `挂机累计 4 小时触发（只算这次打开启动器；动鼠标的那几秒、游戏运行时、性能模式下不算）。阶段 1 / 2 / 3 / 3.5 小时多出 ${U.STAGES.map(([, n]) => n).join(' / ')} 只末影人。下面的按钮不受「彩蛋」开关、性能模式和「已完成」限制；只有「清除完成记录」会写进设置`,
      info,
      btn('+30 分钟', act(() => U.add(30 * 60 * 1000)), 'plus'),
      btn('跳到下一阶段', act(() => U.nextStage()), 'chevronRight'),
      btn('计时清零', act(() => U.reset()), 'refresh'),
      btn('立即触发结局', () => { closeMenu(); U.trigger(); }, 'sparkles', 'primary'),
      btn('播放终末之诗', () => { closeMenu(); U.poem(false); }, 'file'),
      btn('翻页模式播放（减弱动态效果）', () => { closeMenu(); U.poem(true); }, 'file'),
      btn('清除完成记录（去掉龙蛋）', () => U.clearDone().then(() => { refresh(); A.toast({ level: 'ok', text: '已清掉，可以再触发一次' }); }), 'trash'));
  }

  function open() {
    let m = null;
    const closeMenu = () => { if (m) m.close(); };
    m = A.modal({
      title: '启动器调试菜单', subtitle: '只给测试用；改动会写进真实配置，大多数可以一键还原', icon: 'wrench', size: 'lg', className: 'dbg-modal',
      body: h('div.dbg',
        section('首次启动', '重新显示免责声明和首次启动向导（向导里的选择会真的生效）。操作前会自动备份配置，可以在「配置」里还原',
          btn('模拟首次启动', () => cfgAction('firstRun', () => location.reload()), 'sparkles', 'primary'),
          btn('只看免责声明', () => A.disclaimer({ force: true }), 'file'),
          btn('只看向导', () => { m.close(); A.setup.open(); }, 'sparkles')),
        section('配置', '恢复默认会保留游戏目录、各配置的设置、选中的配置、账户相关和 CurseForge Key；会先备份',
          btn('恢复默认设置', () => cfgAction('reset', () => A.toast({ level: 'ok', title: '已恢复默认设置', text: '想回去点「还原备份」' })), 'refresh'),
          btn('清掉「看过」的状态', () => cfgAction('clearSeen', () => {
            try { localStorage.removeItem('aurora.notifications'); } catch { /* ignore */ }
            A.toast({ level: 'ok', title: '已清掉', text: '更新日志红点、各种「不再提醒」、记住的选择、通知中心' });
          }), 'eyeOff'),
          btn('还原备份', () => cfgAction('restore', () => A.toast({ level: 'ok', text: '已还原调试前的配置' })), 'history')),
        trusted() ? unsafeSection() : null,
        section('主页动态背景', '只改这次运行里的样子，不写进设置；重启或改背景设置后恢复。这个菜单会挡住主页，点「在主页上调试」会关掉菜单、回到主页，打开一个可以拖动的小面板：边看边点，面板外面照常能点背景里的生物',
          btn('在主页上调试', openFloat, 'eye', 'primary')),
        hardwareSection(closeMenu),
        ultimateSection(closeMenu),
        section('没翻译的资源标签', '下载页里查不到中文、整条显示英文的标签，按出现次数排（只记在这台电脑上）。可以复制下来补进词库',
          btn('查看', () => showTagMisses(), 'file'),
          btn('清空记录', () => { A.tagMisses.clear(); A.toast({ level: 'ok', text: '已清空' }); }, 'trash')),
        section('通知和对话框', '看各种样式',
          ['info', 'ok', 'warn', 'crit'].map((lv) => btn(`${lv} 通知`, () => A.toast({ level: lv, title: `测试通知（${lv}）`, text: '这是一条测试通知' }))),
          btn('带按钮的通知', () => A.toast({ level: 'ok', title: '安装完成', text: '测试：带按钮的通知不会自动消失', actions: [{ label: '知道了', onClick: () => {} }] })),
          btn('确认框', () => A.confirm('这是一个测试确认框', { title: '测试' })),
          btn('危险确认', () => A.dangerConfirm({ level: 2, title: '测试危险确认', text: '不会真的删除任何东西', items: ['示例文件 A', '示例文件 B'] })))),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
    m.el.querySelectorAll('select').forEach((s) => s.addEventListener('click', (e) => e.stopPropagation()));
  }

  // A.dbgUnsafe：只有输对过密码才置得上；别处（mcmodui.js、危险确认框）读它时不用再判断一遍
  let unsafe = false;
  Object.defineProperty(A, 'dbgUnsafe', { get: () => unsafe && trusted(), set: (v) => { unsafe = !!v && trusted(); }, enumerable: true });
  A.debugMenu = { versionClick, open: unlock, openFloat, closeFloat, needPass, trusted };
})();
