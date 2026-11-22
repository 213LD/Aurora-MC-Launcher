'use strict';
/**
 * 硬件与显卡检查：显卡驱动太旧 / 没装、老核显不支持新版本、双显卡笔记本，
 * 以及按游戏内画质设置（options.txt、光影）和 Mod 数量粗略估算这台电脑带不带得动，给出推荐操作。
 * 只是估算：不跑分，只看型号、驱动日期、内存、线程数。
 */
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const infer = require('./infer');
const { writeFileSafe } = require('../engine/fileops');
const { PS_UTF8 } = require('../engine/procenc');
const { nm, nmJoin } = require('../../shared/i18n');

let cache = null;

function ps(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + command], { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

const VENDORS = { '10DE': 'nvidia', 1002: 'amd', 8086: 'intel', 5143: 'qualcomm', QCOM: 'qualcomm', '1D17': 'zhaoxin', '6766': 'zhaoxin', '1ED5': 'mthreads' };
// Win32_Processor.Architecture（1.5.8）
const ARCH_CODES = { 0: 'x86', 5: 'arm', 9: 'x64', 12: 'arm64' };
const ARCH_NAMES = { x64: 'x64', x86: 'x86（32 位）', arm64: 'ARM64', arm: 'ARM（32 位）', riscv64: 'RISC-V', loong64: '龙芯 LoongArch' };
// 虚拟机 / 云桌面模拟出来的显卡（PCI 厂商 ID）：VMware、VirtualBox、Red Hat（virtio-gpu / QXL）、QEMU 标准 VGA、Hyper-V、Parallels、Xen、Cirrus
const VM_VENDORS = { '15AD': 'VMware', '80EE': 'VirtualBox', '1AF4': 'Red Hat VirtIO', '1B36': 'Red Hat QXL', 1234: 'QEMU', 1414: 'Hyper-V', '1AB8': 'Parallels', 5853: 'Xen', 1013: 'Cirrus' };
const VM_GPU_NAME = /vmware svga|virtualbox|vbox|\bqxl\b|virtio|hyper-v video|parallels display|\bxen\b|bochs|cirrus/i;
// 虚拟机 / 云主机的「型号」（Win32_ComputerSystem）。只开了 Hyper-V / 内存完整性的普通电脑型号还是真实的，不会误判
const VM_SYSTEM = /vmware|virtualbox|innotek|qemu|\bkvm\b|\bxen\b|parallels|virtual machine|bochs|amazon ec2|google compute|alibaba cloud|aliyun|tencent cloud|huawei cloud|openstack|nutanix|cloud pc/i;
const DRIVER_PAGES = {
  nvidia: 'https://www.nvidia.cn/geforce/drivers/',
  amd: 'https://www.amd.com/zh-cn/support/download/drivers.html',
  intel: 'https://www.intel.cn/content/www/cn/zh/support/detect.html',
  qualcomm: 'https://www.qualcomm.com/products/mobile/snapdragon/pcs-and-tablets/snapdragon-x-elite/drivers',
  zhaoxin: 'https://www.zhaoxin.com/qd.aspx',
  mthreads: 'https://www.mthreads.com/',
};
const VENDOR_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', qualcomm: '高通', zhaoxin: '兆芯', mthreads: '摩尔线程' };

/**
 * 显卡档次：3 高、2 中、1.5 较好的核显、1 普通核显、0.5 很老的显卡。
 * 1.5.2 起按命名规则推算（infer.js），比启动器认识的更新的型号也能估计，并带 conf（known / inferred / unknown）
 */
function classify(name, vendor) {
  return infer.gpu(name, vendor);
}

let simulated = null; // 调试模式的显卡 / 处理器模拟（只在这次运行里有效）

/**
 * 常见远程控制 / 串流软件（1.5.7，国内常用的几款）：按进程名或它们装的虚拟显示器认。
 * 这类软件是截取屏幕画面再传过去，游戏照常用显卡；常见问题是虚拟显示器被当成主屏、全屏时远程画面黑屏、鼠标视角乱转
 */
const REMOTE_APPS = [
  { name: 'UU 远程', proc: /^(gameviewer|uuremote|uu远程)/i, display: /gameviewer|uu ?remote/i },
  { name: 'ToDesk', proc: /^todesk/i, display: /todesk/i },
  { name: '向日葵', proc: /^(sunlogin|awesun)/i, display: /sunlogin|oray|awesun/i },
  { name: 'RustDesk', proc: /^rustdesk/i, display: /rustdesk/i },
  { name: 'Parsec', proc: /^parsecd$/i, display: /parsec/i },
  { name: 'Sunshine', proc: /^sunshine$/i, display: /sunshine|sudovda/i },
  { name: 'AnyDesk', proc: /^anydesk$/i, display: /anydesk/i },
  { name: 'TeamViewer', proc: /^teamviewer$/i, display: /teamviewer/i },
];
function remoteApps(raw, virtualDisplays) {
  const procs = (raw.processes || []).map(String);
  return REMOTE_APPS.map((a) => ({
    name: a.name,
    running: procs.some((p) => a.proc.test(p)),
    display: virtualDisplays.find((d) => a.display.test(d)) || null,
  })).filter((a) => a.running || a.display);
}

/** 读系统信息（原始数据，和 PowerShell 输出的格式一样；模拟器也给这个格式） */
async function readRaw() {
  const [gpus, cpu, system, processes] = await Promise.all([
    ps("Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,@{n='DriverDate';e={if($_.DriverDate){$_.DriverDate.ToString('yyyy-MM-dd')}}},PNPDeviceID | ConvertTo-Json -Compress"),
    ps('Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,Architecture | ConvertTo-Json -Compress'),
    ps('Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model | ConvertTo-Json -Compress'),
    ps('Get-Process | Select-Object -ExpandProperty ProcessName -Unique | ConvertTo-Json -Compress'),
  ]);
  return {
    gpus: Array.isArray(gpus) ? gpus : gpus ? [gpus] : [], cpu, system,
    processes: Array.isArray(processes) ? processes : [],
    ramMB: Math.round(os.totalmem() / 1048576),
    // 远程桌面会话：SESSIONNAME 是 RDP-Tcp#0 这样的（本机登录是 Console）
    remote: /^rdp-/i.test(process.env.SESSIONNAME || ''),
    // 32 位 / 转译运行的程序里 PROCESSOR_ARCHITECTURE 不准，PROCESSOR_ARCHITEW6432 才是真的
    arch: String(process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || '').toLowerCase(),
    osBuild: Number(String(os.release()).split('.')[2]) || 0,
  };
}

/** 处理器架构：系统报的优先（WMI 的代号、环境变量），再按型号猜 */
function archOf(raw, cpuName) {
  const code = raw.cpu && raw.cpu.Architecture;
  if (raw.archSim) return raw.archSim;
  if (code != null && ARCH_CODES[code]) return ARCH_CODES[code];
  const env = raw.arch || '';
  if (/arm64|aarch64/.test(env)) return 'arm64';
  if (/riscv/.test(env)) return 'riscv64';
  if (/loong/.test(env)) return 'loong64';
  if (/amd64|x64/.test(env) && infer.cpuArch(cpuName) === 'x64') return 'x64';
  return infer.cpuArch(cpuName);
}

/**
 * 原始数据 → 检查用的格式。1.5.7 起：
 * - gpus：真的显卡（PCI 设备）+ 基本显示适配器 + 虚拟机模拟的显卡（vm: true）
 * - virtualDisplays：远程桌面、串流、扩展屏软件装的虚拟显示器（ROOT\ / SWD\ 开头，不是显卡），只用来说明
 * - vm：{ name } 在虚拟机 / 云桌面里；remote：远程桌面会话
 */
function build(raw) {
  const gpus = [];
  const virtualDisplays = [];
  for (const g of raw.gpus || []) {
    if (!g || !g.Name) continue;
    const name = String(g.Name).trim();
    const pnp = String(g.PNPDeviceID || '');
    const ven = ((pnp.match(/VEN_([0-9A-F]{4})/i) || pnp.match(/^ACPI\\([A-Z]{4})/i) || [])[1] || '').toUpperCase();
    const basic = /basic display|基本显示/i.test(name);
    const vmGpu = VM_VENDORS[ven] || VM_VENDORS[Number(ven)] || (/^VMBUS\\/i.test(pnp) ? 'Hyper-V' : null) || (VM_GPU_NAME.test(name) ? 'virtual' : null);
    // ACPI\：骁龙、开发板这类 SoC 的显卡（1.5.8）
    if (!/^(PCI|VMBUS|ACPI)\\/i.test(pnp) && !basic && !vmGpu) { virtualDisplays.push(name); continue; }
    const vendor = vmGpu ? null : VENDORS[ven] || VENDORS[Number(ven)] || null;
    gpus.push({ name, vendor, driver: g.DriverVersion || '', driverDate: g.DriverDate || '', basic, vm: vmGpu || null, ...classify(name, vendor) });
  }
  const sys = raw.system || {};
  const sysText = `${sys.Manufacturer || ''} ${sys.Model || ''}`.trim();
  const vmGpu = gpus.find((g) => g.vm);
  const vm = VM_SYSTEM.test(sysText) || vmGpu ? { name: VM_SYSTEM.test(sysText) ? sysText : vmGpu.vm } : null;
  const cpu = raw.cpu || {};
  const cpuName = String(cpu.Name || (os.cpus()[0] || {}).model || '').trim();
  const threads = cpu.NumberOfLogicalProcessors || os.cpus().length;
  const cpuInfo = infer.cpu(cpuName, threads);
  return {
    gpus, virtualDisplays, vm, remote: !!raw.remote, remoteApps: remoteApps(raw, virtualDisplays),
    cpu: { name: cpuName, cores: cpu.NumberOfCores || 0, threads, ...cpuInfo, arch: archOf(raw, cpuName) },
    osBuild: raw.osBuild || 0,
    ramMB: raw.ramMB || Math.round(os.totalmem() / 1048576),
    simulated: !!raw.simulated,
  };
}

async function info() {
  if (simulated) return build(simulated);
  if (cache) return cache;
  cache = build(await readRaw());
  return cache;
}

/**
 * 调试模式的硬件模拟器（1.5.7）：spec = { gpus: [{ name, pnp?, driverDate?, driver? }], cpu: { name, cores?, threads }, ramGB, system?: { manufacturer, model }, remote? }；
 * null 取消。显卡没给 pnp 时按名字猜厂商（认不出的当成 PCI 显卡），可以填还不存在的型号测推算
 */
function simulate(spec) {
  if (!spec) { simulated = null; return null; }
  const guess = (n) => (/nvidia|geforce|rtx|gtx|quadro|tesla|grid/i.test(n) ? '10DE' : /amd|radeon|\brx\b|firepro/i.test(n) ? '1002' : /intel|iris|uhd|\barc\b|hd graphics/i.test(n) ? '8086'
    : /parallels/i.test(n) ? '1AB8' : /moore|\bmtt\b|摩尔/i.test(n) ? '1ED5' : /zhaoxin|glenfly|arise/i.test(n) ? '1D17' : /vmware/i.test(n) ? '15AD' : /virtualbox/i.test(n) ? '80EE' : /qxl/i.test(n) ? '1B36' : /virtio|red hat/i.test(n) ? '1AF4' : /hyper-v/i.test(n) ? '1414' : '0000');
  simulated = {
    simulated: true,
    gpus: (spec.gpus || []).filter((g) => g && g.name).map((g) => ({ Name: g.name, PNPDeviceID: g.pnp || (/adreno|qualcomm|mali|videocore/i.test(g.name) ? 'ACPI\\QCOM0C36\\0' : `PCI\\VEN_${guess(g.name)}&DEV_0000`), DriverDate: g.driverDate || '', DriverVersion: g.driver || '' })),
    cpu: { Name: (spec.cpu && spec.cpu.name) || '', NumberOfCores: Number(spec.cpu && spec.cpu.cores) || 0, NumberOfLogicalProcessors: Number(spec.cpu && spec.cpu.threads) || 8 },
    system: spec.system ? { Manufacturer: spec.system.manufacturer || '', Model: spec.system.model || '' } : { Manufacturer: '', Model: '' },
    ramMB: Math.round((Number(spec.ramGB) || 16) * 1024),
    remote: !!spec.remote,
    processes: Array.isArray(spec.processes) ? spec.processes : [],
    // 架构不填就按处理器型号猜；osBuild 不填当成 Windows 11
    archSim: (spec.cpu && spec.cpu.arch) || null,
    osBuild: Number(spec.osBuild) || 26100,
  };
  return build(simulated);
}
const simulation = () => (simulated ? build(simulated) : null);

// ───────── 游戏内画质设置 ─────────
async function readOptions(gameDir) {
  try {
    const out = {};
    for (const line of (await fsp.readFile(path.join(gameDir, 'options.txt'), 'utf8')).split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  } catch { return null; }
}

async function shadersOn(gameDir) {
  try {
    const t = await fsp.readFile(path.join(gameDir, 'config', 'iris.properties'), 'utf8');
    if (/^enableShaders\s*=\s*true/m.test(t) && /^shaderPack\s*=\s*\S+/m.test(t)) return (t.match(/^shaderPack\s*=\s*(.+)$/m) || [])[1].trim();
  } catch { /* 没装 Iris */ }
  try {
    const t = await fsp.readFile(path.join(gameDir, 'optionsshaders.txt'), 'utf8');
    const m = t.match(/^shaderPack\s*=\s*(.+)$/m);
    if (m && !/^(OFF|\(internal\))$/i.test(m[1].trim())) return m[1].trim();
  } catch { /* 没装 OptiFine */ }
  return null;
}

/** 虚拟机里没有真显卡时的办法：按虚拟化软件说（1.5.7） */
function vmAdvice(hw) {
  const text = `${hw.vm.name} ${hw.gpus.map((g) => `${g.name} ${g.vm || ''}`).join(' ')}`;
  const basic = hw.gpus.some((g) => g.basic);
  const tips = [];
  if (/vmware/i.test(text)) tips.push(`VMware：虚拟机设置 → 显示器里勾选「加速 3D 图形」，${basic ? '并在虚拟机里装 VMware Tools（现在显示的是「基本显示适配器」，就是还没装）' : '并装好 VMware Tools'}。它的虚拟显卡性能有限，大型整合包和光影基本带不动`);
  else if (/parallels/i.test(text)) tips.push('Parallels（Mac）：3D 加速默认是开的，Minecraft 能跑但虚拟显卡性能有限；在 macOS 上直接用官方启动器玩 Minecraft 会流畅得多（原生支持苹果芯片）');
  else if (/virtualbox|innotek|vbox/i.test(text)) tips.push('VirtualBox：3D 加速对 Minecraft 支持很差，1.17 以后的版本基本打不开；建议换 VMware，或者在真机上玩');
  else if (/hyper-v|microsoft corporation virtual|virtual machine/i.test(text)) tips.push('Hyper-V / Azure：虚拟机默认没有 3D 显卡。可以用 GPU 分区（GPU-P）把显卡分给虚拟机，云电脑要选带显卡的规格');
  else if (/qemu|kvm|red hat|qxl|virtio|bochs/i.test(text)) tips.push('QEMU / KVM：QXL、virtio-gpu 默认没有 OpenGL 3.2，Minecraft 1.17 起打不开；可以用显卡直通（VFIO），或者试试 virgl（virtio-gpu-gl）');
  else if (/amazon|google|alibaba|aliyun|tencent|huawei|openstack|cloud/i.test(text)) tips.push('云电脑 / 云主机：要选带显卡的规格（GPU 实例 / vGPU），并装云厂商提供的显卡驱动；没有显卡的规格只能用处理器软件渲染，非常卡');
  else tips.push('在虚拟化软件里打开 3D 加速、装好增强工具（VMware Tools、VirtualBox 增强功能、virtio-win 等），或者把显卡直通给虚拟机');
  return `Minecraft 需要支持 OpenGL 的显卡，虚拟显卡一般很卡甚至打不开。${tips.join('；')}。条件允许的话，直接在真机上玩最省事`;
}

const monthsAgo = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? (Date.now() - t) / (30.44 * 86400000) : null; };
const gb = (mb) => `${Math.round(mb / 1024)} GB`;

/** 检查结果：和 repair.envCheck 的条目同格式，area = 'hardware' */
async function check({ gameDir, mc, modCount, hw: given }) {
  const hw = given || await info(); // given：测试时传入模拟的硬件
  const items = [];
  const push = (i) => items.push({ area: 'hardware', ...i });
  const mcMinor = Number((String(mc).match(/^1\.(\d+)/) || [])[1] || 99);

  // 真的显卡：不算基本显示适配器、虚拟机模拟的显卡（1.5.7）；远程 / 串流的虚拟显示器在 info() 里就分出去了
  const real = hw.gpus.filter((g) => !g.basic && !g.vm);
  const best = [...real].sort((a, b) => b.tier - a.tier)[0] || null;
  const virtualDisplays = hw.virtualDisplays || [];

  if (hw.simulated) push({ severity: 'info', type: 'hw-simulated', title: '正在用调试模式模拟的硬件检查', detail: `显卡：${nmJoin(hw.gpus.map((g) => g.name)) || '无'}；处理器：${nm(hw.cpu.name) || '未填'}；内存 ${gb(hw.ramMB)}。在调试菜单里可以取消模拟` });
  // 虚拟机 / 云桌面（1.5.7）：没有真显卡时不再叫人去装显卡驱动，按虚拟化软件给办法
  if (hw.vm) {
    if (!real.length) push({ severity: 'crit', type: 'gpu-vm', title: `在虚拟机或云电脑里运行（${nm(hw.vm.name)}），没有真正的显卡`, detail: vmAdvice(hw) });
    else push({ severity: 'info', type: 'gpu-vm-gpu', title: `在虚拟机或云电脑里运行，显卡是 ${nm(best.name)}`, detail: '显卡直通或带显卡的云电脑可以正常玩。画面很卡时，确认虚拟机里装的是显卡厂商的驱动（云电脑一般是云厂商提供的 NVIDIA GRID / vGPU 驱动）' });
  }
  if (!real.length) {
    if (hw.vm) { /* 上面说过了 */ } else if (hw.gpus.some((g) => g.basic)) {
      // 开发板、RISC-V 这类基本没有 Windows 显卡驱动，叫人去官网下没用（1.5.8）
      push(hw.cpu.embedded
        ? { severity: 'crit', type: 'gpu-nodriver', title: '没有显卡驱动', detail: '现在用的是 Windows 自带的「基本显示适配器」。这类开发板的显卡一般没有 Windows 驱动，Minecraft 打不开或只能用处理器软件渲染，非常卡' }
        : { severity: 'crit', type: 'gpu-nodriver', title: '显卡驱动没有装', detail: '现在用的是 Windows 自带的「基本显示适配器」，Minecraft 很可能打不开或者非常卡。到电脑或显卡厂商官网下载显卡驱动' });
    }
    else if (virtualDisplays.length) {
      push({
        severity: 'warn', type: 'gpu-only-virtual', title: '没找到真正的显卡，只看到虚拟显示器',
        detail: `「${virtualDisplays.join('」「')}」是远程桌面、串流或扩展屏软件装的虚拟显示器，不是显卡。这台电脑有显卡的话：到设备管理器 → 显示适配器看看它是不是被禁用了、驱动有没有装好；云电脑 / 远程主机要选带显卡的规格`,
      });
    } else push({ severity: 'info', type: 'gpu-unknown', conf: 'unknown', title: '没能读到显卡信息', detail: '可能是 Windows 的系统信息服务（WMI）出了问题；下面的负载估算按普通核显算' });
  } else {
    // 驱动日期
    for (const g of real) {
      const age = monthsAgo(g.driverDate);
      // 官方已停止更新驱动的老显卡（1.5.8）：叫人去下最新驱动没用，装官网上最后一版就行
      if (age != null && age > 24 && g.vendor && g.legacy) {
        push({
          severity: 'info', type: 'gpu-driver-legacy', title: `${nm(g.name)} 的驱动官方已经不再更新`,
          detail: `显卡厂商已经停止给这块显卡出新驱动，现在的驱动（${g.driverDate.slice(0, 7)}）旧是正常的。没装驱动或画面有问题时，到官网装它的最后一版驱动就行；它能跑的版本和画质都有限，见下面的负载估算`,
          fix: { kind: 'open-url', url: DRIVER_PAGES[g.vendor], label: `${VENDOR_NAMES[g.vendor]} 驱动下载` },
        });
      } else if (age != null && age > 24 && g.vendor) {
        push({
          severity: age > 48 ? 'crit' : 'warn', type: 'gpu-driver-old',
          title: `${nm(g.name)} 的驱动是 ${g.driverDate.slice(0, 7)} 的，已经比较旧`,
          detail: '旧驱动常导致崩溃、黑屏、画面错乱和光影出错。建议到官网下载最新驱动（装好后重启电脑）',
          fix: { kind: 'open-url', url: DRIVER_PAGES[g.vendor], label: `${VENDOR_NAMES[g.vendor]} 驱动下载` },
        });
      }
    }
    // 老核显：OpenGL 3.2 以下，1.17 起打不开
    if (best && best.oldGl && mcMinor >= 17) push({ severity: 'crit', type: 'gpu-old-gl', conf: best.conf, title: `${nm(best.name)} 太老，运行不了 Minecraft ${mc}`, detail: 'Minecraft 1.17 起需要 OpenGL 3.2，这块显卡不支持。可以玩 1.16.5 及更早的版本' });
    // 国产显卡（1.5.8）：Minecraft Java 版用 OpenGL，国产显卡的 OpenGL 驱动还在完善
    const dom = real.filter((g) => g.domestic);
    if (dom.length) {
      push({
        severity: 'info', type: 'gpu-domestic', conf: 'inferred', title: `国产显卡：${nmJoin(dom.map((g) => g.name))}`,
        detail: 'Minecraft Java 版用的是 OpenGL，国产显卡的 OpenGL 驱动还在快速完善，档次是按型号推算的。遇到花屏、黑屏、打不开或光影出错：先到官网更新到最新驱动；还不行可以先关掉光影、用 Sodium 这类优化 Mod，或者换旧一点的游戏版本试试',
        fix: dom[0].vendor && DRIVER_PAGES[dom[0].vendor] ? { kind: 'open-url', url: DRIVER_PAGES[dom[0].vendor], label: `${VENDOR_NAMES[dom[0].vendor]}官网` } : undefined,
      });
    }
    // 双显卡：确认用的是独显
    const dgpus = real.filter((g) => g.discrete);
    const dgpu = [...dgpus].sort((a, b) => b.tier - a.tier)[0];
    if (dgpu && real.some((g) => !g.discrete)) push({ severity: 'info', type: 'gpu-hybrid', title: `有独立显卡 ${nm(dgpu.name)}，确保游戏用的是它`, detail: 'Windows 设置 → 系统 → 屏幕 → 显示卡：添加 Java（javaw.exe），选「高性能」；NVIDIA 也可以在控制面板里指定。台式机的显示器要插在独立显卡的接口上，不是主板上的。用核显玩会卡很多' });
    // 多块独立显卡（SLI / 交火 / 不同厂商混插，1.5.7）：Minecraft 只用一块
    if (dgpus.length >= 2) {
      const vendors = new Set(dgpus.map((g) => g.vendor));
      const names = nmJoin(dgpus.map((g) => g.name));
      const one = vendors.size === 1 ? [...vendors][0] : null;
      push({
        severity: 'info', type: one === 'nvidia' ? 'gpu-sli' : one === 'amd' ? 'gpu-crossfire' : 'gpu-multi',
        title: one === 'nvidia' ? `有 ${dgpus.length} 块 NVIDIA 独立显卡（可能组了 SLI）` : one === 'amd' ? `有 ${dgpus.length} 块 AMD 独立显卡（可能组了交火）` : `有多块独立显卡：${names}`,
        detail: one === 'nvidia' ? 'Minecraft（OpenGL）只用一块显卡，SLI 对它没有帮助，有时还会闪烁、黑屏。画面异常时在 NVIDIA 控制面板 → 管理 3D 设置 → 程序设置里给 javaw.exe 把 SLI 渲染模式设成「单 GPU」'
          : one === 'amd' ? 'Minecraft（OpenGL）只用一块显卡，交火（CrossFire / AMD MGPU）对它没有帮助，有时还会闪烁、黑屏。画面异常时在 AMD 软件里给 javaw.exe 关掉交火'
            : `Minecraft 只用一块显卡。确认用的是最好的 ${nm(dgpu.name)}：Windows 设置 → 系统 → 屏幕 → 显示卡里给 javaw.exe 指定它，显示器也接在它上面`,
      });
    }
  }
  // UU 远程、ToDesk、向日葵、RustDesk 等（1.5.7）：截屏串流，游戏照常用显卡，一般能玩；说明它们常见的三个问题
  const apps = hw.remoteApps || [];
  if (apps.length) {
    const running = apps.filter((a) => a.running);
    const vds = apps.filter((a) => a.display);
    push({
      severity: 'info', type: 'remote-apps',
      title: running.length ? `正在运行远程控制软件：${nmJoin(apps.map((a) => a.name))}` : `装了远程控制软件：${nmJoin(apps.map((a) => a.name))}`,
      detail: [
        '这类软件是把屏幕画面传过去，游戏照常用这台电脑的显卡，一般可以正常玩（和 Windows 远程桌面不一样）。遇到问题时：',
        vds.length ? `① 游戏窗口跑到看不见的屏幕上：${vds.map((a) => `${nm(a.display)}（${nm(a.name)}）`).join('、')}是虚拟显示器，可能被当成了主屏。在 Windows 设置 → 系统 → 屏幕里把真实显示器设为主显示器，或者在软件里关掉虚拟显示器 / 无显示器模式` : '① 游戏窗口跑到看不见的屏幕上：有的软件会装虚拟显示器，被当成主屏时会这样。在 Windows 设置 → 系统 → 屏幕里把真实显示器设为主显示器',
        '② 远程画面黑屏或卡住：游戏改成窗口化（F11 退出全屏），或者在软件里换一种画面采集方式 / 打开硬件编码',
        '③ 远程操作时视角乱转、鼠标不跟手：在软件里打开游戏模式 / 锁定鼠标，或者在游戏「选项 → 控制 → 鼠标设置」里关掉「原始输入」',
      ].join('\n'),
    });
  }
  // 远程桌面（1.5.7）：默认不让程序用显卡，Minecraft 常报不支持 OpenGL
  if (hw.remote) {
    push({
      severity: 'warn', type: 'remote-desktop', title: '正在通过 Windows 远程桌面使用这台电脑',
      detail: '远程桌面默认不让程序用显卡，Minecraft 会报「不支持 OpenGL」之类的错误打不开，或者非常卡。可以在这台电脑本机上玩；或者改用 Parsec、Moonlight + Sunshine、向日葵、ToDesk 这类串流软件；或者在这台电脑的组策略里打开「对所有远程桌面服务会话使用硬件图形适配器」（gpedit.msc → 计算机配置 → 管理模板 → Windows 组件 → 远程桌面服务 → 远程桌面会话主机 → 远程会话环境）',
    });
  }

  // 处理器架构（1.5.8）：ARM（骁龙、NVIDIA、Mac 虚拟机、开发板）、RISC-V、龙芯；国产 x86（兆芯）
  const arch = hw.cpu.arch || 'x64';
  if (arch === 'riscv64' || arch === 'loong64') {
    push({
      severity: 'crit', type: 'arch-unsupported', title: `${ARCH_NAMES[arch]} 架构的 Windows 上还跑不了 Minecraft Java 版`,
      detail: `Minecraft 要的 Java 和游戏库（LWJGL）没有 ${ARCH_NAMES[arch]} 版的 Windows 程序，这个架构的 Windows 也没有 x64 转译，启动器没法让游戏跑起来。${arch === 'riscv64' ? 'RISC-V' : '龙芯'} 的 Linux 上有社区移植的版本可以试试`,
    });
  } else if (arch === 'arm64' || arch === 'arm') {
    const win10 = hw.osBuild && hw.osBuild < 22000;
    const lines = [
      `这台电脑是 ${ARCH_NAMES[arch]} 架构（${hw.cpu.basis || hw.cpu.name}）。启动器用的是 x64 版 Java，由 Windows 11 自动转译运行，能玩，但比同档次的 x64 电脑慢一些。`,
      hw.cpu.apple ? '在 Mac 上：直接用 macOS 版的 Minecraft（官方启动器原生支持苹果芯片）会流畅得多；虚拟机里的显卡是模拟的，大型整合包和光影基本带不动' : '',
      hw.cpu.embedded ? '树莓派、香橙派这类开发板跑的 Windows 一般没有显卡驱动（只有「基本显示适配器」），Minecraft 打不开或只能用处理器软件渲染，非常卡；这类板子更适合在 Linux 上跑社区移植版' : '',
      !hw.cpu.apple && !hw.cpu.embedded ? '游戏打不开或报 OpenGL 错误时：在 Microsoft Store 装「OpenCL、OpenGL 和 Vulkan 兼容包」，并更新显卡驱动' : '',
      '少数带原生库的 Mod（语音聊天、录屏、内置浏览器这类）没有 ARM 版，可能加载失败',
    ].filter(Boolean);
    push({
      severity: win10 ? 'crit' : 'info', type: 'cpu-arm',
      title: win10 ? 'Windows 10 ARM 版不能运行 x64 程序，Minecraft Java 版打不开' : `ARM 处理器的电脑（${hw.cpu.basis || nm(hw.cpu.name)}）`,
      detail: win10 ? `Windows 10 的 ARM 版只能转译 32 位程序，Minecraft 要的 64 位 Java 跑不了。升级到 Windows 11 就能玩。\n${lines.join('\n')}` : lines.join('\n'),
      fix: !hw.cpu.apple && !hw.cpu.embedded ? { kind: 'open-url', url: 'https://apps.microsoft.com/detail/9nqpsl29bfff', label: '打开 OpenGL 兼容包' } : undefined,
    });
  } else if (hw.cpu.zhaoxin) {
    push({
      severity: 'info', type: 'cpu-zhaoxin', title: `国产兆芯处理器（${hw.cpu.basis}）`,
      detail: '兆芯是 x86 兼容的，Java 和游戏都能正常运行，单核性能大约相当于 Intel 4–8 代酷睿。兆芯核显的 OpenGL 支持有限，1.17 以后的版本建议配一块独立显卡，并到兆芯官网装最新驱动',
    });
  }

  // 负载估算：画质 + 光影 + Mod 数量 对比 显卡档次、内存、线程数
  const opts = (gameDir && await readOptions(gameDir)) || {};
  const rd = Number(opts.renderDistance) || 12;
  const gfx = opts.graphicsMode != null ? Number(opts.graphicsMode) : (opts.fancyGraphics === 'false' ? 0 : 1);
  const shader = gameDir ? await shadersOn(gameDir) : null;
  const mods = modCount || 0;
  const demand = (rd > 16 ? 1.5 : rd > 12 ? 1 : rd > 8 ? 0.5 : 0) + (gfx >= 2 ? 0.5 : 0) + (shader ? 2 : 0) + (mods > 300 ? 1 : mods > 150 ? 0.6 : mods > 50 ? 0.3 : 0);
  const gpuTier = best ? best.tier : 1;
  const gpuConf = best ? best.conf : 'unknown';
  const factors = [`视距 ${rd}`, ['流畅', '高品质', '极佳'][gfx] ? `画质「${['流畅', '高品质', '极佳'][gfx]}」` : '', shader ? `光影 ${shader}` : '', mods ? `${mods} 个 Mod` : ''].filter(Boolean);
  if (demand > gpuTier + 0.25) {
    const recRd = gpuTier >= 2 ? 12 : gpuTier >= 1.5 ? 10 : 8;
    const recGfx = gpuTier >= 1.5 ? 1 : 0;
    const tips = [];
    if (rd > recRd) tips.push(`视距降到 ${recRd}`);
    if (gfx > recGfx) tips.push(`画质改成「${['流畅', '高品质'][recGfx]}」`);
    if (shader) tips.push('关掉光影，或换成轻量光影（如 Complementary 的低配置预设）');
    if (mods > 150) tips.push('装 Sodium / Embeddium 之类的优化 Mod');
    push({
      severity: 'warn', type: 'load-high', conf: gpuConf,
      title: '按现在的画质设置，这台电脑可能会比较卡',
      detail: `当前：${factors.join('、')}；显卡：${best ? `${nm(best.name)}（${best.basis}）` : '未知'}。建议：${tips.join('；') || '适当降低画质'}`,
      // 认不出显卡时档次是猜的：降画质不进「全部修复」，要玩家自己点
      fix: rd > recRd || gfx > recGfx ? { kind: 'gfx-lower', renderDistance: Math.min(rd, recRd), graphicsMode: Math.min(gfx, recGfx), label: '降低画质设置', auto: gpuConf !== 'unknown' } : undefined,
    });
  }
  if (mods > 150 && hw.ramMB < 8192) push({ severity: 'warn', type: 'ram-low', title: `电脑内存只有 ${gb(hw.ramMB)}，${mods} 个 Mod 偏多`, detail: '大型整合包一般要 8 GB 以上的电脑内存；可以关掉浏览器等其他程序再玩，或者换个轻一点的整合包' });
  // 处理器（1.5.8）：Minecraft 主要吃单核，世界生成、区块加载、Mod 加载都看它；1.18 起世界变高、生成更复杂，对处理器要求明显变高。
  // 档次按单核算（infer.cpu），老服务器处理器核再多也帮不上
  const cpuTier = hw.cpu.tier != null ? hw.cpu.tier : 1.5;
  const newWorld = mcMinor >= 18 && mcMinor < 99;
  const cpuName = hw.cpu.basis || `${hw.cpu.threads} 线程`;
  // 需求：新版本 0.5、Mod 多 0.5–1、不到 4 线程 0.5；档次比需求低（或者是很老的处理器）就提醒
  const cpuNeed = (newWorld ? 0.5 : 0) + (mods > 150 ? 1 : mods > 50 ? 0.5 : 0) + (hw.cpu.threads && hw.cpu.threads < 4 ? 0.5 : 0);
  if (cpuTier <= 0.5 || cpuTier < cpuNeed + 0.25) {
    const why = [newWorld ? `${mc} 是 1.18 以后的版本，世界更高、地形生成更复杂，比旧版本吃处理器得多` : '', mods > 50 ? `${mods} 个 Mod 启动和运行都要处理器算` : ''].filter(Boolean);
    const tips = [];
    if (rd > 8) tips.push('视距降到 8 以下（模拟距离也一起降），处理器要加载的区块少很多');
    tips.push(mods ? '装 Lithium、FerriteCore、ModernFix 这类优化 Mod（Mod 配置器的「性能优化」里有）' : '用「纯净版+」装上 Sodium、Lithium 这类优化 Mod，原版玩法不变');
    if (newWorld) tips.push('实在太卡可以玩 1.12.2 或 1.16.5 这类旧版本，对处理器要求低很多');
    if (mods > 50) tips.push('减少 Mod 数量，或者换轻量整合包');
    tips.push('关掉浏览器、直播软件等后台程序；笔记本插上电源并切到高性能模式');
    push({
      severity: 'warn', type: 'cpu-low', conf: hw.cpu.conf,
      title: cpuTier <= 0.5 ? `处理器（${nm(cpuName)}）性能比较弱，玩${newWorld ? '新版本' : mods > 50 ? '这么多 Mod' : ' Minecraft'}可能会很卡` : `处理器（${nm(cpuName)}）可能带不动${why.length ? (newWorld && mods > 50 ? '新版本加这么多 Mod' : newWorld ? '新版本' : '这么多 Mod') : '这个配置'}`,
      detail: [
        `Minecraft 主要靠处理器的单核性能，${hw.cpu.server ? '服务器处理器核多但单核慢，核多帮不上；' : ''}${why.length ? `${why.join('；')}。` : ''}可能出现：启动和进存档很慢、走快了地形加载不出来、TPS 低（方块和生物卡顿，但画面帧数不一定低）。`,
        `建议：${tips.map((x, i) => `${'①②③④⑤'[i]} ${x}`).join('；')}`,
      ].join('\n'),
      // 档次是按型号估计的：只给玩家自己点的按钮，不进「全部修复」
      fix: rd > 8 && !items.some((i) => i.fix && i.fix.kind === 'gfx-lower') ? { kind: 'gfx-lower', renderDistance: 8, label: '视距降到 8', auto: false } : undefined,
    });
  }

  const gpuText = best ? `${best.name}${best.driverDate ? `（驱动 ${best.driverDate.slice(0, 7)}）` : ''}` : '未识别显卡';
  if (!items.some((i) => i.severity === 'crit' || i.severity === 'warn')) {
    // 没读到显卡时不说「硬件够用：未识别显卡」（rc12 对照表测试看出来的：前后矛盾，新手看不懂）
    push({ severity: 'ok', conf: gpuConf, title: best ? `硬件够用：${gpuText}` : '处理器和内存够用；没读到显卡，按普通核显估计', detail: `${best ? `显卡 ${best.basis} · ` : ''}处理器 ${hw.cpu.basis || ''} ${hw.cpu.threads} 线程 · 内存 ${gb(hw.ramMB)}${factors.length ? ` · 当前 ${factors.join('、')}` : ''}` });
  }
  return items;
}

/** 降低画质：改 options.txt，返回原值用于撤销 */
async function lowerGraphics(gameDir, { renderDistance, graphicsMode }) {
  const file = path.join(gameDir, 'options.txt');
  const text = await fsp.readFile(file, 'utf8');
  const before = {};
  const set = { renderDistance, graphicsMode };
  if (renderDistance != null) set.simulationDistance = Math.min(renderDistance, 10);
  const lines = text.split(/\r?\n/).map((line) => {
    const i = line.indexOf(':');
    const k = i > 0 ? line.slice(0, i) : null;
    if (k && set[k] != null) {
      const cur = line.slice(i + 1);
      // 只往低改
      if (Number(cur) > Number(set[k])) { before[k] = cur; return `${k}:${set[k]}`; }
    }
    return line;
  });
  await writeFileSafe(file, lines.join(text.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
  return before;
}

async function restoreOptions(gameDir, before) {
  const file = path.join(gameDir, 'options.txt');
  const text = await fsp.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => {
    const i = line.indexOf(':');
    const k = i > 0 ? line.slice(0, i) : null;
    return k && before[k] != null ? `${k}:${before[k]}` : line;
  });
  await writeFileSafe(file, lines.join(text.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
}

module.exports = { info, check, lowerGraphics, restoreOptions, classify, build, simulate, simulation };
