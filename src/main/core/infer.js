'use strict';
/**
 * 一键修复面向未来（1.5.2）：启动器以后不更新了，遇到新的显卡、处理器、Java、Minecraft、Mod 加载器也要能基本判断。
 * - 硬件按命名规则推算档次，不列型号：代数比启动器认识的最新的还大，就按「至少和最新同档」算，并标「推算」
 * - conf：known 认得 / inferred 按规律推算 / unknown 认不出（认不出的自动修复不进「全部修复」，repair.js）
 * - 只用本机信息，不联网
 * 档次和 hardware.js 原来的一样：3 高、2 中、1.5 较好的核显、1 普通核显、0.5 很老
 */

// 发布这一版时认识的最新值；更大的数字按推算处理，所以以后不改也能用
const KNOWN = {
  nvidia: 50, // GeForce RTX 50 系
  amd: 9, // Radeon RX 9000 系
  amdIgpu: 890, // Radeon 890M
  amdApu: 8060, // Radeon 8060S
  arc: 'b', // Intel Arc B 系列
  arcIgpu: 140, // Arc 140V
  intelCore: 14, // Core i 14 代
  intelUltra: 2, // Core Ultra 200 系
  ryzen: 9, // Ryzen 9000
  ryzenAi: 3, // Ryzen AI 300
  java: 25,
  mc: '26.3',
};

const norm = (s) => String(s || '').toLowerCase().replace(/\(r\)|\(tm\)|®|™/g, '').replace(/\s+/g, ' ').trim();
const r = (discrete, tier, conf, basis, extra) => ({ discrete, tier, conf, basis, ...extra });

/** 显卡：{ discrete, tier, conf, basis, oldGl? } */
function gpu(name, vendor) {
  const n = norm(name);
  // ARM 平台、国产、开发板的显卡（1.5.8）
  if (/rtx\s*spark|\bn1x?\b/.test(n)) return r(false, 2.5, 'inferred', 'NVIDIA ARM 平台的集成显卡（按中高端估计）');
  // 国产独显（1.5.8）：摩尔线程 MTT S80 / S70、砺算 7G100 系列已经有面向玩家的游戏卡。型号新、OpenGL 驱动还在完善，档次按推算
  let dm = n.match(/\bmtt\s*([sx])\s*(\d{2,4})/);
  if (dm || /moore\s*threads|摩尔线程/.test(n)) {
    const num = dm ? Number(dm[2]) : 0;
    return r(true, num >= 70 ? 2 : num >= 50 ? 1.5 : 1, 'inferred', `摩尔线程 ${dm ? `MTT ${dm[1].toUpperCase()}${dm[2]}` : ''} 国产独显`, { domestic: 'mthreads' });
  }
  if (/lisuan|砺算|\b7g\d{3}\b/.test(n)) {
    dm = n.match(/\b(\d)g(\d)(\d{2})\b/);
    return r(true, dm && dm[1] === '7' ? 2.5 : 2, 'inferred', `砺算 ${dm ? `${dm[1]}G${dm[2]}${dm[3]}` : ''} 国产独显`, { domestic: 'lisuan' });
  }
  if (/innosilicon|芯动|fantasy|风华/.test(n)) return r(true, 1.5, 'inferred', '芯动「风华」国产独显', { domestic: 'innosilicon' });
  if (/zhaoxin|兆芯|glenfly|格芯|\barise\b/.test(n)) return r(/arise|glenfly|格芯/.test(n), 0.5, 'known', /arise|glenfly|格芯/.test(n) ? '格芯 Arise 国产独显（OpenGL 支持有限）' : '兆芯核显（OpenGL 支持有限）', { domestic: 'zhaoxin' });
  if (/\bmali\b|videocore|powervr|imagination|\bimg\b.*gpu|vivante/.test(n)) return r(false, 0.5, 'known', '开发板 / 手机的嵌入式显卡（Windows 下基本没有 OpenGL 驱动）', { oldGl: true });
  if (vendor === 'nvidia' || /geforce|nvidia|quadro|titan/.test(n)) {
    let m = n.match(/rtx\s*(\d{2})(\d{2})\b/);
    if (m) {
      const gen = Number(m[1]); const cls = Number(m[2]);
      return r(true, cls >= 60 ? 3 : 2.5, gen > KNOWN.nvidia ? 'inferred' : 'known', `RTX ${gen} 系 · ${cls} 档${gen > KNOWN.nvidia ? '（比启动器认识的 RTX 50 系新，按同档推算）' : ''}`);
    }
    if (/titan/.test(n)) return r(true, 3, 'known', 'TITAN');
    if ((m = n.match(/rtx\s*(?:pro\s*)?a?(\d{3,4})/))) return r(true, Number(m[1]) >= 4000 ? 3 : 2.5, 'known', '专业卡 RTX');
    if ((m = n.match(/gtx\s*(\d{3,4})/))) {
      const num = Number(m[1]);
      const gen = Math.floor(num / 100); // 1650 → 16，1060 → 10，970 → 9
      const cls = num % 100;
      if (gen >= 9) return r(true, cls >= 60 || gen >= 16 ? 2 : 1.5, 'known', `GTX ${num}`);
      // GTX 700 及更早：官方已停止更新驱动（1.5.8）
      return r(true, 0.5, 'known', `GTX ${num}（比较老）`, { legacy: true });
    }
    if (/\bmx\s*\d{3}/.test(n)) return r(true, 1, 'known', 'MX 入门独显（接近核显）');
    if (/quadro/.test(n)) return r(true, 2, 'known', 'Quadro');
    if ((m = n.match(/\bgt\s*(\d{3,4})/))) return r(true, 0.5, 'known', 'GT 入门独显（比较老）', { legacy: Number(m[1]) < 1000 });
    if (/geforce\s*\d{3}\b|geforce\s*[89]\d{3}\b/.test(n)) return r(true, 0.5, 'known', '很老的 GeForce 入门显卡', { legacy: true });
    return r(true, 2, 'unknown', '认不出的 NVIDIA 型号，按中档独显估计');
  }
  if (vendor === 'amd' || /radeon|\bamd\b/.test(n)) {
    let m = n.match(/radeon\s*(\d{3})m\b/);
    if (m) {
      const num = Number(m[1]);
      return r(false, num >= 680 ? 1.5 : 1, num > KNOWN.amdIgpu ? 'inferred' : 'known', `Radeon ${num}M 核显`);
    }
    if ((m = n.match(/radeon\s*(\d{4})s\b/))) {
      const num = Number(m[1]);
      return r(false, 2, num > KNOWN.amdApu ? 'inferred' : 'known', `Radeon ${num}S 高性能核显`);
    }
    if ((m = n.match(/\brx\s*(\d{4,5})\b/))) {
      const num = Number(m[1]);
      const gen = Math.floor(num / 1000);
      // RX 9070 起是「代数 + 两位档位」（9070 = 9 代 70 档），之前是千位代数 + 百位档位（7600 = 7 代 60 档）
      const cls = gen >= 9 ? num % 100 : Math.floor((num % 1000) / 100) * 10;
      const conf = gen > KNOWN.amd ? 'inferred' : 'known';
      const later = conf === 'inferred' ? '（比启动器认识的 RX 9000 系新，按同档推算）' : '';
      if (gen >= 6) return r(true, cls >= 60 ? 3 : 2, conf, `RX ${num}${later}`);
      if (gen === 5) return r(true, 2, conf, `RX ${num}`);
      return r(true, 0.5, conf, `RX ${num}`);
    }
    if ((m = n.match(/\brx\s*(\d{3})\b/))) return r(true, Number(m[1]) >= 570 ? 2 : 1.5, 'known', `RX ${m[1]}`);
    if (/vega\s*(56|64)|radeon vii/.test(n)) return r(true, 2, 'known', 'Vega 独显');
    if (/\b(r9|r7|r5)\b|hd\s*\d{4}/.test(n) && !/graphics/.test(n)) return r(true, 0.5, 'known', '老 Radeon 独显', { legacy: /hd\s*\d{4}/.test(n) });
    if (/radeon( \w+)? graphics|vega\s*\d\b/.test(n)) return r(false, 1, 'known', 'Radeon 核显');
    return r(false, 1, 'unknown', '认不出的 AMD 型号，按普通核显估计');
  }
  if (vendor === 'intel' || /intel/.test(n)) {
    let m = n.match(/arc\D*\b([a-z])(\d{3})\b/);
    if (m) {
      const conf = m[1] > KNOWN.arc ? 'inferred' : 'known';
      return r(true, m[2][0] >= '5' ? 3 : 2, conf, `Arc ${m[1].toUpperCase()}${m[2]} 独显${conf === 'inferred' ? '（比启动器认识的 B 系列新，按同档推算）' : ''}`);
    }
    if ((m = n.match(/arc\D*(\d{3})v\b/))) return r(false, 1.5, Number(m[1]) > KNOWN.arcIgpu ? 'inferred' : 'known', `Arc ${m[1]}V 核显`);
    if (/arc/.test(n)) return r(false, 1.5, 'known', 'Arc 核显');
    if (/iris xe/.test(n)) return r(false, 1.5, 'known', 'Iris Xe 核显');
    // Sandy Bridge 的 HD 2000 / 3000 和更早的 GMA：Windows 上只有 OpenGL 3.1，1.17+ 打不开
    if (/hd graphics (2000|3000)|graphics media accelerator|\bgma\b|express chipset|\b4 series\b/.test(n)) return r(false, 0.5, 'known', '很老的核显', { oldGl: true, legacy: true });
    if (/uhd|hd graphics|iris/.test(n)) return r(false, 1, 'known', 'Intel 核显');
    return r(false, 1, 'unknown', '认不出的 Intel 型号，按普通核显估计');
  }
  if (/adreno/.test(n)) return r(false, 1.5, 'inferred', '高通 Adreno（ARM 电脑）');
  return r(false, 1, 'unknown', '认不出的显卡，按普通核显估计');
}

/** 处理器：{ tier, gen, mobile, conf, basis }，tier 同样 0.5–3 */
const WORD_CORES = { dual: 2, two: 2, triple: 3, quad: 4, four: 4, six: 6, hexa: 6, eight: 8, octa: 8, ten: 10, twelve: 12, sixteen: 16 };
/** 型号名里写的核心数：「64-Core」「Eight-Core」「16 核」，没写返回 0 */
function coresIn(n) {
  const m = n.match(/(\d{1,3})\s*-?\s*(?:cores?|核)/) || n.match(/\b(dual|two|triple|quad|four|six|hexa|eight|octa|ten|twelve|sixteen)\s*-?\s*core/);
  return m ? Number(m[1]) || WORD_CORES[m[1]] || 0 : 0;
}

/** 架构：按型号猜（hardware.build 优先用系统报的架构）。arm64 / riscv64 / loong64 / x64 */
function cpuArch(name) {
  const n = norm(name);
  if (/risc-?v|sifive|\bth1520\b|\bsg20\d\d\b|spacemit|\bjh71\d0\b|xuantie|玄铁/.test(n)) return 'riscv64';
  if (/loongson|龙芯|loongarch|\b3a[56]000\b/.test(n)) return 'loong64';
  if (/snapdragon|qualcomm|骁龙|\bsq[1-3]\b|\bx1[ep]\d|\bx2e\d|apple|cortex|\barmv\d|\barm64\b|broadcom|\bbcm2\d{3}\b|rockchip|\brk3\d{3}\b|allwinner|amlogic|mediatek|kompanio|ampere|altra|graviton|kunpeng|鲲鹏|phytium|飞腾|nvidia|rtx\s*spark/.test(n)) return 'arm64';
  return 'x64';
}

function cpu(name, threads = 0) {
  const n = norm(name);
  const named = coresIn(n);
  const byThreads = () => (threads >= 12 ? 2.5 : threads >= 8 ? 2 : threads >= 4 ? 1.5 : 1);
  let m;
  // ── 非 x86（1.5.8）：ARM（骁龙、NVIDIA、苹果、树莓派这类开发板）、RISC-V、龙芯 ──
  const arch = cpuArch(name);
  if (arch === 'riscv64') return { tier: 0.5, gen: 0, mobile: false, conf: 'known', basis: 'RISC-V 处理器', arch, embedded: true };
  if (arch === 'loong64') return { tier: 1, gen: 0, mobile: false, conf: 'known', basis: '龙芯处理器（LoongArch）', arch };
  if (arch === 'arm64') {
    if (/snapdragon.*\bx2\b|\bx2e\d/.test(n)) return { tier: 3, gen: 2, mobile: true, conf: 'known', basis: '骁龙 X2 系列（ARM）', arch };
    if (/snapdragon.*\bx\b|x elite|x plus|\bx1[ep]\d/.test(n)) return { tier: 2.5, gen: 1, mobile: true, conf: 'known', basis: `骁龙 X ${/plus|x1p/.test(n) ? 'Plus' : 'Elite'}（ARM）`, arch };
    if (/8cx|\bsq[1-3]\b|\b8c\b|\b7c\b|\b850\b|snapdragon|qualcomm/.test(n)) return { tier: /\b7c\b|\b850\b/.test(n) ? 0.5 : 1, gen: 0, mobile: true, conf: 'known', basis: '早期 Windows ARM 处理器（骁龙 8cx / 7c、Surface SQ）', arch };
    if (/nvidia|rtx\s*spark/.test(n)) return { tier: 3, gen: 1, mobile: /\bn1\b|spark/.test(n), conf: 'inferred', basis: 'NVIDIA ARM 处理器（N1X / RTX Spark 一类，按高端估计）', arch };
    if (/apple/.test(n)) {
      m = n.match(/apple\s*(m|a)(\d+)/);
      return { tier: m && m[1] === 'a' ? 2 : 2.5, gen: m ? Number(m[2]) : 0, mobile: true, conf: m ? 'known' : 'inferred', basis: `苹果 ${m ? `${m[1].toUpperCase()}${m[2]}` : 'M 系列'} 芯片（在 Mac 的虚拟机里运行 Windows）`, arch, apple: true };
    }
    if (/ampere|altra|graviton|kunpeng|鲲鹏|phytium|飞腾/.test(n)) return { tier: 1, gen: 0, mobile: false, conf: 'known', basis: 'ARM 服务器处理器', arch, server: true };
    // 树莓派、香橙派这类开发板：Cortex-A7x，单核远比电脑处理器慢
    return { tier: 0.5, gen: 0, mobile: false, conf: 'inferred', basis: /bcm2|broadcom|raspberry/.test(n) ? '树莓派一类的开发板处理器（ARM）' : /rk3|rockchip|allwinner|amlogic/.test(n) ? '香橙派一类的开发板处理器（ARM）' : 'ARM 处理器', arch, embedded: true };
  }
  // ── 国产 x86 ──
  if (/zhaoxin|兆芯|kaixian|\bk[xh]-/.test(n)) {
    const series = Number((n.match(/\bk[xh]-?u?(\d)/) || [])[1] || 6);
    return { tier: series >= 7 ? 1.5 : 1, gen: series, mobile: /\bkx-u/.test(n), conf: 'known', basis: `兆芯 ${series >= 7 ? 'KX-7000' : 'KX-6000 或更早的'} 系列（国产 x86）`, arch: 'x64', zhaoxin: true };
  }
  if (/hygon|海光/.test(n)) return { tier: 1.5, gen: 1, mobile: false, conf: 'known', basis: '海光处理器（国产 x86，接近 AMD Zen 1）', arch: 'x64', server: named >= 16 };
  // ── 服务器 / 工作站：核多、频率低，Minecraft 主要看单核，按单核估计 ──
  if ((m = n.match(/epyc\s*(\d)(\d{2})(\d)/))) {
    const series = Number(m[1]); const gen = Number(m[3]);
    const tier = series === 4 ? 3 : gen >= 3 ? 2 : 1.5;
    return { tier, gen, mobile: false, conf: 'known', basis: `AMD EPYC ${m[1]}${m[2]}${m[3]}（服务器处理器${named ? `，${named} 核` : ''}）`, arch: 'x64', server: series !== 4 };
  }
  if ((m = n.match(/threadripper\s*(?:pro\s*)?(\d)\d{3}/))) {
    const gen = Number(m[1]);
    return { tier: gen >= 5 ? 3 : gen >= 3 ? 2.5 : 2, gen, mobile: false, conf: 'known', basis: `Threadripper ${gen} 代（工作站处理器${named ? `，${named} 核` : ''}）`, arch: 'x64' };
  }
  if ((m = n.match(/xeon.*?\b(platinum|gold|silver|bronze|max)\b/))) {
    return { tier: m[1] === 'bronze' ? 1 : 1.5, gen: 0, mobile: false, conf: 'known', basis: `Xeon ${m[1][0].toUpperCase()}${m[1].slice(1)}（服务器处理器）`, arch: 'x64', server: true };
  }
  if (/xeon.*\bw-\d{4}/.test(n)) return { tier: 2.5, gen: 0, mobile: false, conf: 'known', basis: 'Xeon W（工作站处理器）', arch: 'x64' };
  if (/xeon.*\be-2\d{3}/.test(n)) return { tier: 2.5, gen: 0, mobile: false, conf: 'known', basis: 'Xeon E-2000（入门服务器，同代台式机规格）', arch: 'x64' };
  m = n.match(/core\s*ultra\s*(\d)\s*(?:processor\s*)?(\d)(\d{2})([a-z]*)/);
  if (m) {
    const gen = Number(m[2]);
    return { tier: Number(m[1]) >= 5 ? 3 : 2.5, gen, mobile: /[uhv]/.test(m[4]), conf: gen > KNOWN.intelUltra ? 'inferred' : 'known', basis: `Core Ultra ${m[1]} 第 ${gen} 代` };
  }
  if ((m = n.match(/\bi([3579])-(\d{4,5})([a-z]*)/))) {
    const num = m[2];
    const gen = num.length === 5 ? Number(num.slice(0, 2)) : Number(num[0]);
    const fam = Number(m[1]);
    const low = /[uy]/.test(m[3]) && !/h/.test(m[3]);
    let tier = gen >= 12 ? (fam === 3 ? 2 : 3) : gen >= 8 ? (fam === 3 ? 1.5 : 2.5) : gen >= 6 ? (fam === 3 ? 1 : 2) : (fam === 3 ? 0.5 : 1.5);
    if (low) tier = Math.max(0.5, tier - 0.5);
    return { tier, gen, mobile: /[uyhp]/.test(m[3]), conf: gen > KNOWN.intelCore ? 'inferred' : 'known', basis: `Core i${fam} 第 ${gen} 代${low ? '低功耗版' : ''}` };
  }
  // 老处理器和退役服务器处理器（1.5.8）：Minecraft 主要吃单核，核多也帮不上，按单核性能算档次
  if (/core\s*2\s*(?:duo|quad|extreme)|pentium\s*(?:4|d\b|dual|e\d{4}|t\d{4})|celeron\s*(?:cpu|d\b|m\b|e\d{4}|\d{3}\b)|\bphenom|athlon\s*(?:64|ii|x2)|turion|sempron|\batom\b/.test(n)) {
    const netbook = /\batom\b|\b[njz]\d{4}\b/.test(n);
    return { tier: 0.5, gen: 0, mobile: netbook || /mobile|turion|\bt\d{4}/.test(n), conf: 'known', basis: netbook ? '上网本级别的低功耗处理器' : '十多年前的老处理器', old: !netbook };
  }
  if ((m = n.match(/\bi([357])(?:\s*cpu)?[\s-]+(\d{3})([a-z]*)\b/))) {
    // 第一代酷睿：i7-920 / i5-750 / i3-530
    return { tier: m[1] === '3' ? 0.5 : 1, gen: 1, mobile: /[mu]/.test(m[3]), conf: 'known', basis: `Core i${m[1]} 第 1 代（2009 年前后）`, old: true };
  }
  if ((m = n.match(/xeon.*?\b([xlwe])(\d)(\d{3})\b/))) {
    // X5670、L5640、E5450、W3550 这一代（2008–2010 年）的服务器处理器
    return { tier: 0.5, gen: 0, mobile: false, conf: 'known', basis: `Xeon ${m[1].toUpperCase()}${m[2]}${m[3]}（2008–2010 年的服务器处理器）`, old: true, server: true };
  }
  if ((m = n.match(/xeon.*?\be([357])-\s*(\d{4})[a-z]*\s*(?:v(\d))?/))) {
    const v = Number(m[3] || 1);
    // E3 是同代台式机的规格；E5 / E7 核多但频率低，单核大约相当于同代 i5 的低频版
    const tier = m[1] === '3' ? (v >= 3 ? 2 : 1.5) : (v >= 3 ? 1.5 : 1);
    return { tier, gen: v, mobile: false, conf: 'known', basis: `Xeon E${m[1]}-${m[2]}${m[3] ? ` v${v}` : ''}（退役服务器处理器）`, server: m[1] !== '3', old: v <= 2 };
  }
  if ((m = n.match(/\bcore\s*([3579])\s*(\d)(\d{2})([a-z]*)/))) return { tier: 2.5, gen: Number(m[2]), mobile: /[uh]/.test(m[4]), conf: 'known', basis: `Core ${m[1]}` };
  if ((m = n.match(/ryzen\s*ai\s*(?:max\+?\s*)?(\d)?\s*(?:pro\s*)?(?:hx\s*)?(\d)(\d{2})/))) {
    const gen = Number(m[2]);
    return { tier: 3, gen, mobile: true, conf: gen > KNOWN.ryzenAi ? 'inferred' : 'known', basis: `Ryzen AI ${gen}00 系` };
  }
  if ((m = n.match(/ryzen\s*([3579])\s*(?:pro\s*)?(\d{4,5})([a-z]*)/))) {
    // 四位数千位是代数（5800 = 5 代）；以后出五位数就是前两位（11950 = 11 代）
    const gen = m[2].length === 5 ? Number(m[2].slice(0, 2)) : Number(m[2][0]);
    const fam = Number(m[1]);
    const low = /u/.test(m[3]) && gen < 5;
    let tier = gen >= 5 ? (fam === 3 ? 2 : 3) : gen >= 3 ? (fam === 3 ? 1.5 : 2.5) : (fam === 3 ? 1 : 2);
    if (low) tier -= 0.5;
    return { tier, gen, mobile: /[uh]/.test(m[3]), conf: gen > KNOWN.ryzen ? 'inferred' : 'known', basis: `Ryzen ${fam} 第 ${gen} 代` };
  }
  if (/celeron|pentium|atom|athlon|\ba\d+-\d{4}|\bfx-\d{4}|\bintel\s*(?:processor\s*)?n\d{2,3}\b/.test(n)) return { tier: 1, gen: 0, mobile: false, conf: 'known', basis: '入门级处理器' };
  // 认不出的型号：型号名里写了核心数就参考它；核特别多（24 核以上）一般是服务器处理器，频率低，单核按中等估计
  if (named >= 24 || threads >= 48) return { tier: 1.5, gen: 0, mobile: false, conf: 'inferred', basis: `认不出的型号，${named ? `${named} 核` : `${threads} 线程`}，按服务器处理器估计（核多但单核慢）`, arch: 'x64', server: true };
  if (named) return { tier: named >= 8 ? 2 : named >= 4 ? 1.5 : 1, gen: 0, mobile: false, conf: 'inferred', basis: `认不出的型号，按型号里写的 ${named} 核估计`, arch: 'x64' };
  return { tier: byThreads(), gen: 0, mobile: false, conf: 'inferred', basis: `认不出的型号，按 ${threads || '?'} 线程估计` };
}

const { cmpMc } = require('../../shared/mcver');

const VANILLA_MAIN = ['net.minecraft.client.main.Main', 'net.minecraft.launchwrapper.Launch', 'com.mojang.rubydung.RubyDung', 'net.minecraft.client.Minecraft'];
const KNOWN_GROUPS = /^(com\.mojang|net\.minecraft|org\.lwjgl|net\.java|org\.apache|com\.google|io\.netty|it\.unimi|org\.slf4j|com\.ibm|net\.sf|org\.ow2|ca\.weblite|com\.github\.oshi|com\.paulscode|tv\.twitch|oshi-project|org\.jcraft|commons-|org\.joml|com\.fasterxml|net\.jodah|org\.tukaani|lzma|java3d|com\.ibm\.icu|org\.yaml|com\.typesafe|org\.ow2\.asm|org\.jline|com\.electronwill|net\.minidev|org\.openjdk|org\.checkerframework|com\.machinezoo|com\.mojang\.authlib|jna|net\.java\.dev\.jna|org\.spongepowered|net\.fabricmc|org\.quiltmc|net\.minecraftforge|net\.neoforged|cpw\.mods|de\.oceanlabs|optifine|com\.mumfrey|net\.legacyfabric|org\.ow2|org\.antlr|org\.codehaus|codechicken|cn\.hutool|io\.github\.zekerzhayard)\b/;

/**
 * 认不出的 Mod 加载器：versions.detectLoader 认不出，但版本 JSON 的入口类不是原版的、或者带了不认识的库（组名里有 loader / launcher）。
 * 返回 { name, mainClass } 或 null（看起来就是原版）
 */
function unknownLoader(json) {
  if (!json) return null;
  const main = json.mainClass || '';
  const libs = (json.libraries || []).map((l) => (l && l.name) || '').filter(Boolean);
  const odd = libs.filter((x) => !KNOWN_GROUPS.test(x));
  const loaderLib = odd.find((x) => /loader|launcher|modlauncher|bootstrap/i.test(x)) || null;
  const nonVanillaMain = main && !VANILLA_MAIN.includes(main);
  if (!nonVanillaMain && !loaderLib) return null;
  const pick = loaderLib || (nonVanillaMain ? main : odd[0]);
  const name = pick.includes(':') ? pick.split(':').slice(0, 2).join(':') : pick;
  return { name, mainClass: main };
}

module.exports = { KNOWN, gpu, cpu, cpuArch, coresIn, cmpMc, unknownLoader };
