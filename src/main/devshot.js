'use strict';
/**
 * 开发用：自动切换页面并截图（仅在设置 AURORA_SHOT_DIR 环境变量时启用）
 * AURORA_SHOT_PAGES=home;;versions;;download  每项可写成 page|js 以在截图前执行脚本
 * page 可写成 page#名字 指定截图文件名；page 为 - 时不切换页面（接着上一步的界面截图）
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function attach(win) {
  const dir = process.env.AURORA_SHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  // 换掉「下载」文件夹（测试 CurseForge 手动下载，不碰真实的「下载」）
  if (process.env.AURORA_SHOT_DOWNLOADS) app.setPath('downloads', process.env.AURORA_SHOT_DOWNLOADS);
  // 模拟回收站不可用（测试「再确认一次才永久删除」）
  if (process.env.AURORA_SHOT_NOTRASH) require('electron').shell.trashItem = async () => { throw new Error('Failed to move item to trash'); };
  // 「选择文件」对话框依次返回这些路径（用 | 分隔），测试导入流程用
  if (process.env.AURORA_SHOT_PICK) {
    const picks = process.env.AURORA_SHOT_PICK.split('|');
    require('electron').dialog.showOpenDialog = async () => { const f = picks.shift(); return f ? { canceled: false, filePaths: [f] } : { canceled: true, filePaths: [] }; };
  }
  // 用 ";;" 分隔各步骤，避免与脚本中的逗号冲突
  const specs = (process.env.AURORA_SHOT_PAGES || 'home').split(';;').filter(Boolean);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) fs.appendFileSync(path.join(dir, 'console.log'), `[${level}] ${message}\n`);
  });
  // 性能基线：AURORA_PERF=秒数 时只测启动时间、空闲 CPU 和内存，写进 perf.json
  if (process.env.AURORA_PERF) {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const out = { procUptimeAtAttach: Math.round(process.uptime() * 1000) };
    win.once('ready-to-show', () => { out.readyToShow = Math.round(ms()); });
    win.webContents.once('did-finish-load', async () => {
      out.didFinishLoad = Math.round(ms());
      await wait(Number(process.env.AURORA_SHOT_DELAY || 5000));
      if (process.env.AURORA_PERF_SCRIPT) await win.webContents.executeJavaScript(process.env.AURORA_PERF_SCRIPT).catch(() => {});
      await wait(1000);
      if (process.env.AURORA_PERF_BLUR) win.blur();
      app.getAppMetrics();
      const secs = Number(process.env.AURORA_PERF) || 20;
      await wait(secs * 1000);
      const m = app.getAppMetrics();
      out.cpu = Object.fromEntries(m.map((p) => [`${p.type}${p.name ? `:${p.name}` : ''}#${p.pid}`, +p.cpu.percentCPUUsage.toFixed(2)]));
      out.cpuTotal = +m.reduce((a, p) => a + p.cpu.percentCPUUsage, 0).toFixed(2);
      out.memMB = Object.fromEntries(m.map((p) => [`${p.type}#${p.pid}`, Math.round(p.memory.workingSetSize / 1024)]));
      out.memTotalMB = Math.round(m.reduce((a, p) => a + p.memory.workingSetSize, 0) / 1024);
      out.processes = m.length;
      out.gpuCompositing = app.getGPUFeatureStatus().gpu_compositing;
      fs.writeFileSync(path.join(dir, 'perf.json'), JSON.stringify(out, null, 2));
      app.quit();
    });
    return;
  }
  win.webContents.once('did-finish-load', async () => {
    await wait(Number(process.env.AURORA_SHOT_DELAY || 3000));
    for (const spec of specs) {
      const [head, ...rest] = spec.split('|');
      const [page, label] = head.split('#');
      const script = rest.join('|');
      try {
        if (page !== '-') await win.webContents.executeJavaScript(`A.go(${JSON.stringify(page)})`);
        if (script) { await wait(600); await win.webContents.executeJavaScript(script); }
      } catch (e) {
        fs.appendFileSync(path.join(dir, 'console.log'), `[shot] ${spec}: ${e.message}\n`);
      }
      await wait(Number(process.env.AURORA_SHOT_WAIT || 2200));
      const img = await win.webContents.capturePage();
      const name = label ? `${label}.png` : `${page}${script ? `-${specs.indexOf(spec)}` : ''}.png`;
      fs.writeFileSync(path.join(dir, name), img.toPNG());
    }
    if (!process.env.AURORA_SHOT_KEEP) app.quit();
  });
}

module.exports = { attach };
