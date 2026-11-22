'use strict';
// 打包前准备：把程序图标 src/main/brand/icon.ico（由 scripts/brand-icons.js 画好）放进 build/，再写随包附带的免责声明
const fs = require('fs');
const path = require('path');
const disclaimer = require('../src/main/disclaimer');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'main', 'brand', 'icon.ico'), path.join(buildDir, 'icon.ico'));
fs.writeFileSync(path.join(buildDir, disclaimer.FILE_NAME), `\uFEFF${disclaimer.text()}\r\n`, 'utf8');
console.log('build resources written:', buildDir);
