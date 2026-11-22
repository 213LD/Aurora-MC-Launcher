'use strict';
// 对比两个文件夹里同名的截图，列出变化的像素比例（在 Electron 里跑，用 nativeImage 解码 PNG）：electron baseline-compare.js <基线> <新的>
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--') && !x.endsWith('.js'));
  const names = fs.readdirSync(a).filter((n) => n.endsWith('.png') && !n.startsWith('sheet'));
  const rows = [];
  for (const n of names) {
    if (!fs.existsSync(path.join(b, n))) { rows.push([n, null]); continue; }
    const x = nativeImage.createFromPath(path.join(a, n));
    const y = nativeImage.createFromPath(path.join(b, n));
    const sx = x.getSize(); const sy = y.getSize();
    if (sx.width !== sy.width || sx.height !== sy.height) { rows.push([n, 100]); continue; }
    const p = x.toBitmap(); const q = y.toBitmap();
    let diff = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) diff++;
    rows.push([n, Math.round((diff / (p.length / 4)) * 10000) / 100]);
  }
  const changed = rows.filter((r) => r[1] == null || r[1] > 0.5).sort((m, o) => (o[1] || 0) - (m[1] || 0));
  console.log(`对比 ${rows.length} 张：变化超过 0.5% 的 ${changed.length} 张`);
  for (const [n, v] of changed) console.log(`  ${n}：${v == null ? '新的里没有' : `${v}%`}`);
  app.exit(0);
});
