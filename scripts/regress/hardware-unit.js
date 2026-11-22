'use strict';
/**
 * 一键修复「显卡与硬件」检查的对照表测试（rc12）。electron scripts/regress/hardware-unit.js all（npm test 里跑）
 *
 * core/hardware.js 的 check 一个函数一百多个分支（虚拟机、远程桌面、虚拟显示器、双显卡、老显卡、驱动、国产、ARM……），
 * 以前只有调试菜单里的模拟器给人手动看，没有自动的测试：改了一条判断，别的电脑上报出来的结果变了也不知道。
 * 这里把 21 台典型的电脑（hardware-cases.js）喂进去，查每一台该报的报了、不该报的没报、结论对。
 * 再查几组显卡、处理器的档次排得对不对（只比先后，不比具体分数：以后调分数不用改测试）。不联网、不开窗口，几秒钟。
 */
const path = require('path');
const { app } = require('electron');
const H = require('./harness');
const { cases } = require('./hardware-cases');

const { setup, core, check, finish } = H;
const ago = (months) => new Date(Date.now() - months * 30.44 * 86400000).toISOString().slice(0, 10);

app.whenReady().then(async () => {
  const { game } = setup('hardware-unit');
  const hw = core('hardware');
  try {
    for (const c of cases(ago)) {
      const built = hw.simulate(c.spec);
      const items = await hw.check({ gameDir: game, mc: c.mc || '1.20.1', modCount: c.mods == null ? 20 : c.mods, hw: built });
      const types = items.map((i) => i.type).filter(Boolean);
      const ok = items.some((i) => i.severity === 'ok');
      const miss = (c.want || []).filter((t) => !types.includes(t));
      const extra = (c.not || []).filter((t) => types.includes(t));
      const okItem = items.find((i) => i.severity === 'ok');
      const okRight = (c.ok === undefined || c.ok === ok) && (!c.okTitle || (okItem && c.okTitle.test(okItem.title)));
      const crashFree = items.every((i) => i.title && typeof i.title === 'string' && !/undefined|NaN|\[object/.test(`${i.title} ${i.detail || ''}`));
      check('硬件', c.name, !miss.length && !extra.length && okRight && crashFree, { 少报: miss, 多报: extra, 结论: c.ok === undefined ? '不看' : `应该${c.ok ? '' : '不'}说硬件够用，实际${ok ? '' : '没'}说`, 报了: items.map((i) => `${i.severity} ${i.type || '结论'}`), 结论那一条: okItem ? okItem.title : null });
    }
  } finally { hw.simulate(null); }

  // 档次的先后：越好的显卡、处理器档次不能更低
  const gpuTier = (name, vendor) => hw.classify(name, vendor).tier;
  const orders = [
    ['NVIDIA 独显', [['NVIDIA GeForce RTX 4090', '10DE'], ['NVIDIA GeForce RTX 3060', '10DE'], ['NVIDIA GeForce GTX 1060 6GB', '10DE'], ['NVIDIA GeForce GT 1030', '10DE'], ['NVIDIA GeForce 210', '10DE']]],
    ['AMD 独显', [['AMD Radeon RX 7900 XTX', '1002'], ['AMD Radeon RX 6600', '1002'], ['Radeon RX 580 2048SP', '1002'], ['AMD Radeon HD 6850', '1002']]],
    ['Intel 核显', [['Intel(R) Arc(TM) A770 Graphics', '8086'], ['Intel(R) Iris(R) Xe Graphics', '8086'], ['Intel(R) UHD Graphics 630', '8086'], ['Intel(R) HD Graphics 3000', '8086'], ['Intel(R) 82945G Express Chipset Family', '8086']]],
    ['跨厂商', [['NVIDIA GeForce RTX 4060 Laptop GPU', '10DE'], ['AMD Radeon 780M Graphics', '1002'], ['Intel(R) HD Graphics 3000', '8086']]],
  ];
  for (const [what, list] of orders) {
    const tiers = list.map(([n, v]) => gpuTier(n, v));
    const bad = tiers.some((t, i) => i > 0 && t > tiers[i - 1]);
    check('硬件', `显卡档次的先后：${what}（从好到差排，后面的不能比前面高）`, !bad && tiers.every(Number.isFinite), list.map(([n], i) => `${n}=${tiers[i]}`));
  }
  const infer = core('infer');
  const cpuTier = (name, threads) => infer.cpu(name, threads).tier;
  const cpus = [['Intel(R) Core(TM) i9-14900K', 32], ['Intel(R) Core(TM) i5-12400F', 12], ['Intel(R) Core(TM) i5-8400 CPU', 6], ['Intel(R) Core(TM) i5-2400 CPU @ 3.10GHz', 4], ['Intel(R) Pentium(R) 4 CPU 3.00GHz', 2]];
  const ct = cpus.map(([n, t]) => cpuTier(n, t));
  check('硬件', '处理器档次的先后：i9-14900K ≥ i5-12400F ≥ i5-8400 ≥ i5-2400 ≥ 奔腾 4', ct.every((t, i) => Number.isFinite(t) && (i === 0 || t <= ct[i - 1])), cpus.map(([n], i) => `${n}=${ct[i]}`));
  // 还不存在的型号按命名规则推算：不能当成认不出，也不能比上一代差
  const g6090 = hw.classify('NVIDIA GeForce RTX 6090', '10DE');
  check('硬件', '还不存在的显卡（RTX 6090）按命名规则推算：标成推算的，档次不比 RTX 4090 低', g6090.conf === 'inferred' && g6090.tier >= gpuTier('NVIDIA GeForce RTX 4090', '10DE'), g6090);
  finish();
});
app.on('window-all-closed', () => {});
