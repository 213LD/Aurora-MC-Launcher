'use strict';
/**
 * 主页动态背景的性能推荐（性能打磨 + 首次启动向导）：
 * 只看硬件（hardware.info 的显卡档次、处理器档次、内存），给出 high / medium / low / static 四档里的一档和一句原因。
 * 背景是 2D 小画布，主要吃处理器；显卡只要不是基本显示适配器 / 很老的集显都带得动。
 * hwKey：推荐时的硬件指纹（显卡 + 处理器 + 内存），以后启动发现变了就提示重新推荐
 */
const hardware = require('./hardware');

const gb = (mb) => `${Math.round(mb / 1024)} GB`;

/**
 * 显卡加速用不了（驱动被拉黑、远程桌面、关了硬件加速……），画面全靠处理器画。
 * 2026-11-07 实测（--disable-gpu）：主页动画只有二十几帧、时不时卡七十多毫秒，调到「低」档也一样，只有定格才不卡
 */
function softwareRender() {
  try {
    const st = require('electron').app.getGPUFeatureStatus();
    return /^(disabled|unavailable)/.test(st.gpu_compositing || '') || /software/.test(st['2d_canvas'] || '');
  } catch { return false; }
}

function hwKeyOf(hw) {
  return [hw.gpus.map((g) => g.name).sort().join('+'), hw.cpu.name, Math.round(hw.ramMB / 1024)].join('|');
}

/** { tier, reason, perfHint, hwKey }；hw 可以传入（测试 / 模拟） */
async function advice(given) {
  const hw = given || await hardware.info();
  const real = hw.gpus.filter((g) => !g.basic && !g.vm);
  const best = real.slice().sort((a, b) => (b.discrete - a.discrete) || (b.tier - a.tier))[0] || null;
  const gt = best ? (best.oldGl ? 0.25 : best.tier) : 0;
  const ct = hw.cpu.tier != null ? hw.cpu.tier : 1.5;
  const ram = hw.ramMB || 8192;
  const gpuText = best ? `${best.discrete ? '独立显卡' : '集成显卡'} ${best.name}` : '';
  const cpuText = hw.cpu.basis || hw.cpu.name || '处理器';
  const out = (tier, reason, perfHint = false) => ({ tier, reason, perfHint, hwKey: hwKeyOf(hw), simulated: !!hw.simulated });

  if (given ? given.softwareRender : softwareRender()) {
    return { ...out('static', '显卡加速现在用不了（画面全靠处理器来画），动画会一卡一卡的，背景先定格成一张画面', true), hwKey: `${hwKeyOf(hw)}|soft` };
  }
  if (!best) {
    const why = hw.vm || hw.gpus.some((g) => g.vm) ? '在虚拟机或云电脑里运行，没有真正的显卡' : '显卡驱动没装好（只有「基本显示适配器」）';
    return out('static', `${why}，动画会很卡，背景先定格成一张画面`, true);
  }
  if (ram < 4096) return out('static', `电脑内存只有 ${gb(ram)}，留给游戏用更合适，背景定格成一张画面`, true);
  if (gt < 0.5) return out('static', `${gpuText} 比较老，背景定格成一张画面更流畅`, true);
  if (ct <= 0.5 && ram < 6144) return out('static', `处理器（${cpuText}）比较弱、内存 ${gb(ram)}，背景定格成一张画面更流畅`, true);
  if (gt < 1 || ct < 0.75 || ram < 6144) { // 很弱的处理器但内存够，也只到「低」
    const why = gt < 1 ? `${gpuText} 性能一般` : ct < 0.75 ? `处理器（${cpuText}）比较旧` : `电脑内存 ${gb(ram)}`;
    return out('low', `${why}，背景少放点生物和特效、帧率降一些`);
  }
  if (gt < 1.5 || ct < 1.25 || ram < 8192) {
    const why = gt < 1.5 ? `检测到${gpuText}` : ct < 1.25 ? `处理器是 ${cpuText}` : `电脑内存 ${gb(ram)}`;
    return out('medium', `${why}，背景用中等设置就很流畅`);
  }
  return out('high', `${gpuText}、${cpuText}，背景可以全开`);
}

module.exports = { advice, hwKeyOf };
