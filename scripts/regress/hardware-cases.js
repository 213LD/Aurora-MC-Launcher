'use strict';
/**
 * 硬件检查对照表用的电脑配置（rc12，hardware-unit.js）。
 * 每一台是「显卡 + 处理器 + 内存 + 别的情况」，后面是一键修复的硬件检查应该报出来的条目类型（want，不分先后）和不该报的（not）。
 * 结论那一条（硬件够用 / 负载偏高）单独看：ok 为真表示应该说「硬件够用」。
 * ago(n)：n 个月前的日期（显卡驱动日期用，驱动太旧的判断跟着今天走）。
 */
const gpu = (name, driverDate, pnp) => ({ name, driverDate, pnp });

function cases(ago) {
  return [
    { name: '高配台式：RTX 4090 + i9-14900K + 64 GB', spec: { gpus: [gpu('NVIDIA GeForce RTX 4090', ago(2))], cpu: { name: 'Intel(R) Core(TM) i9-14900K', threads: 32 }, ramGB: 64 }, want: [], ok: true },
    { name: '游戏本双显卡：Iris Xe + RTX 4060 Laptop', spec: { gpus: [gpu('Intel(R) Iris(R) Xe Graphics', ago(8)), gpu('NVIDIA GeForce RTX 4060 Laptop GPU', ago(5))], cpu: { name: 'Intel(R) Core(TM) i7-13700H', threads: 20 }, ramGB: 16 }, want: ['gpu-hybrid'], ok: true },
    { name: '老电脑：HD Graphics 3000 + i5-2400 + 4 GB，玩 1.20.1', spec: { gpus: [gpu('Intel(R) HD Graphics 3000', '2015-06-01')], cpu: { name: 'Intel(R) Core(TM) i5-2400 CPU @ 3.10GHz', threads: 4 }, ramGB: 4 }, want: ['gpu-old-gl'], ok: false },
    { name: '同一台老电脑玩 1.12.2：显卡够用，不该说「太老运行不了」', mc: '1.12.2', spec: { gpus: [gpu('Intel(R) HD Graphics 3000', '2015-06-01')], cpu: { name: 'Intel(R) Core(TM) i5-2400 CPU @ 3.10GHz', threads: 4 }, ramGB: 4 }, not: ['gpu-old-gl'] },
    { name: '没装显卡驱动：基本显示适配器（独显的设备号）', spec: { gpus: [gpu('Microsoft Basic Display Adapter', '', 'PCI\\VEN_10DE&DEV_2684')], cpu: { name: 'Intel(R) Core(TM) i5-12400F', threads: 12 }, ramGB: 16 }, want: ['gpu-nodriver'], ok: false },
    { name: '驱动很旧的独显：GTX 1060，驱动 4 年前', spec: { gpus: [gpu('NVIDIA GeForce GTX 1060 6GB', ago(48))], cpu: { name: 'Intel(R) Core(TM) i5-8400 CPU', threads: 6 }, ramGB: 16 }, want: ['gpu-driver-old'] },
    { name: '虚拟机没有真显卡：VMware SVGA 3D', spec: { gpus: [gpu('VMware SVGA 3D', '', 'PCI\\VEN_15AD&DEV_0405')], cpu: { name: 'Intel(R) Core(TM) i7-12700K', threads: 4 }, ramGB: 8, system: { manufacturer: 'VMware, Inc.', model: 'VMware20,1' } }, want: ['gpu-vm'], ok: false },
    { name: '带显卡的云电脑：NVIDIA A10G', spec: { gpus: [gpu('NVIDIA A10G', ago(4))], cpu: { name: 'AMD EPYC 7R32', threads: 8 }, ramGB: 32, system: { manufacturer: 'Amazon EC2', model: 'g5.2xlarge' } }, want: ['gpu-vm-gpu'], not: ['gpu-vm'] },
    { name: '远程桌面会话：RTX 3070 + 远程显示适配器', spec: { gpus: [gpu('NVIDIA GeForce RTX 3070', ago(3)), gpu('Microsoft Remote Display Adapter', '', 'SWD\\REMOTEDISPLAYENUM\\RDPIDD')], cpu: { name: 'Intel(R) Core(TM) i7-10700 CPU', threads: 16 }, ramGB: 32, remote: true }, want: ['remote-desktop'], not: ['gpu-hybrid', 'gpu-nodriver'] },
    { name: '远程控制软件：RTX 3060 + ToDesk 虚拟显示器，向日葵在运行', spec: { gpus: [gpu('NVIDIA GeForce RTX 3060', ago(3)), gpu('ToDesk Virtual Display Adapter', '', 'ROOT\\DISPLAY\\0001')], cpu: { name: 'Intel(R) Core(TM) i5-12400F', threads: 12 }, ramGB: 16, processes: ['SunloginClient'] }, want: ['remote-apps'], not: ['gpu-hybrid', 'gpu-only-virtual'], ok: true },
    { name: '只有串流软件的虚拟显示器（Parsec），读不到真显卡', spec: { gpus: [gpu('Parsec Virtual Display Adapter', '', 'ROOT\\DISPLAY\\0000')], cpu: { name: 'Intel(R) Core(TM) i5-8400 CPU', threads: 6 }, ramGB: 8 }, want: ['gpu-only-virtual'] },
    { name: '这台电脑现在的样子：RTX 4060 Laptop + Radeon 780M + 三个虚拟显示器', spec: { gpus: [gpu('GameViewer Virtual Display Adapter', '', 'ROOT\\DISPLAY\\0000'), gpu('Parsec Virtual Display Adapter', '', 'ROOT\\DISPLAY\\0001'), gpu('USB Mobile Monitor Virtual Display', '', 'ROOT\\DISPLAY\\0002'), gpu('NVIDIA GeForce RTX 4060 Laptop GPU', ago(3)), gpu('AMD Radeon 780M Graphics', ago(3))], cpu: { name: 'AMD Ryzen 7 7840HS', threads: 16 }, ramGB: 32 }, want: ['gpu-hybrid', 'remote-apps'], not: ['gpu-only-virtual', 'gpu-nodriver'], ok: true },
    { name: 'ARM 笔记本：骁龙 X Elite + Adreno', spec: { gpus: [gpu('Qualcomm(R) Adreno(TM) X1-85 GPU', ago(3), 'ACPI\\QCOM0C36\\0')], cpu: { name: 'Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Oryon(TM) CPU', threads: 12 }, ramGB: 16 }, want: ['cpu-arm'] },
    { name: '国产：兆芯 KX-6640MA + 兆芯核显', spec: { gpus: [gpu('Zhaoxin C-960 Graphics', ago(14))], cpu: { name: 'ZHAOXIN KaiXian KX-6640MA@2.2GHz', threads: 4 }, ramGB: 8 }, want: ['cpu-zhaoxin'] },
    { name: '国产显卡：摩尔线程 MTT S80 + i5-12400F', spec: { gpus: [gpu('Moore Threads MTT S80', ago(2))], cpu: { name: 'Intel(R) Core(TM) i5-12400F', threads: 12 }, ramGB: 16 }, want: ['gpu-domestic'] },
    { name: 'RISC-V 开发板：这个架构没有能用的 Java 和游戏本体', spec: { gpus: [gpu('Microsoft Basic Display Adapter', '', 'ACPI\\THEAD01\\0')], cpu: { name: 'SiFive P550 RISC-V', threads: 4, arch: 'riscv64' }, ramGB: 16 }, want: ['arch-unsupported'] },
    { name: '上古电脑：Pentium 4 + 集成显卡 + 2 GB', spec: { gpus: [gpu('Intel(R) 82945G Express Chipset Family', '2009-03-01')], cpu: { name: 'Intel(R) Pentium(R) 4 CPU 3.00GHz', threads: 2 }, ramGB: 2 }, want: ['gpu-old-gl', 'cpu-low'], ok: false },
    { name: '内存小、Mod 多：8 GB 以下 + 200 个 Mod', mods: 200, spec: { gpus: [gpu('NVIDIA GeForce GTX 1650', ago(4))], cpu: { name: 'Intel(R) Core(TM) i5-9400F', threads: 6 }, ramGB: 6 }, want: ['ram-low'] },
    { name: '同一台电脑只有 20 个 Mod：不该说内存不够', mods: 20, spec: { gpus: [gpu('NVIDIA GeForce GTX 1650', ago(4))], cpu: { name: 'Intel(R) Core(TM) i5-9400F', threads: 6 }, ramGB: 6 }, not: ['ram-low'] },
    { name: '还不存在的型号：RTX 6090 + Core Ultra 9 485K（按命名规则推算，不该当成认不出）', spec: { gpus: [gpu('NVIDIA GeForce RTX 6090', ago(1))], cpu: { name: 'Intel(R) Core(TM) Ultra 9 485K', threads: 24 }, ramGB: 128 }, want: [], not: ['gpu-unknown', 'cpu-low', 'gpu-old-gl'], ok: true },
    { name: '读不到显卡（系统信息服务出问题）：结论不能说「硬件够用：未识别显卡」', spec: { gpus: [], cpu: { name: 'Intel(R) Core(TM) i5-12400F', threads: 12 }, ramGB: 16 }, want: ['gpu-unknown'], okTitle: /没读到显卡/ },
  ];
}

module.exports = { cases };
