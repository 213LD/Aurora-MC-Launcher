'use strict';
/* 从 src/renderer/js/credits.js 生成仓库根目录的 ACKNOWLEDGEMENTS.md（和设置 → 关于 →「参考与致谢」是同一份数据）
 * 用法：node scripts/build-credits.js [--public] [--out 目录]
 * --public：公开版（导出公开仓库时用）：带 concept 的服务挪到「概念演示（公开版未包含）」 */
const fs = require('fs');
const path = require('path');
const C = require('../src/renderer/js/credits.js');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const pub = process.argv.includes('--public');
const root = arg('--out') || path.join(__dirname, '..');
const cell = (s) => String(s || '').replace(/\|/g, '\\|');
const out = [
  '# 参考与致谢',
  '',
  '> 这个文件由 `scripts/build-credits.js` 从 `src/renderer/js/credits.js` 生成，启动器里「设置 → 关于 → 参考与致谢」显示的是同一份内容。',
  '',
  '和其他启动器相似的功能，下面写清楚了是沿用代码、参考实现、受启发，还是独立实现但功能相似。感谢这些项目和服务。',
  '',
  '## 相似功能和参考关系',
  '',
  '| 功能 | 相似的启动器 | 关系 | 说明 |',
  '| --- | --- | --- | --- |',
  ...C.FEATURES.map((f) => `| ${cell(f.name)} | ${cell(f.like)} | ${C.REL[f.rel]} | ${cell(f.note)} |`),
  '',
  '## 用到的在线服务',
  '',
  '| 服务 | 用途 |',
  '| --- | --- |',
  ...C.SERVICES.filter((s) => !(pub && s.concept)).map((s) => `| ${cell(s.name)} | ${cell(s.use)} |`),
  '',
  ...(pub ? ['## 概念演示（公开版未包含）', '', '| 服务 | 说明 |', '| --- | --- |', ...C.SERVICES.filter((s) => s.concept).map((s) => `| ${cell(s.name)} | ${cell(s.concept)} |`), ''] : []),
  '## 第三方作品和许可证',
  '',
  '| 作品 | 许可证 | 用途 |',
  '| --- | --- | --- |',
  ...C.WORKS.map((w) => `| ${cell(w.name)} | ${cell(w.license)}${w.file ? `（全文见 \`src/renderer/${w.file}\`）` : ''} | ${cell(w.use)} |`),
  '',
  C.ORIGINAL,
  '',
  '## 许可证全文',
  '',
  ...Object.entries(C.LICENSES).flatMap(([id, text]) => [`### ${C.WORKS.find((w) => w.text === id).name}`, '', '```', text, '```', '']),
];
fs.writeFileSync(path.join(root, 'ACKNOWLEDGEMENTS.md'), out.join('\n'), 'utf8');
console.log('ACKNOWLEDGEMENTS.md 已生成');
