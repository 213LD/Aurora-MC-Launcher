'use strict';
/**
 * 程序图标：把标志 docs/brand/aml-mark.svg 按每个大小分别画一张（小图不是从 256 缩下来的），打包成 src/main/brand/icon.ico。
 * exe、窗口、任务栏、托盘都用这个 ico。改了标志以后跑一次：npm run icons（要用 Electron 来画 SVG）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'docs', 'brand', 'aml-mark.svg');
const OUT = path.join(ROOT, 'src', 'main', 'brand', 'icon.ico');
// Windows 用到的大小：标题栏和托盘 16（125%、150% 缩放时 20、24），任务栏 24 ~ 48，桌面 32 ~ 64，大图标 256
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

/** ICO 文件：文件头 + 每张图一条目录 + PNG 数据（Windows Vista 起认 PNG 压缩的图标） */
function packIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const svg = fs.readFileSync(SVG, 'utf8');
  const images = [];
  for (const size of SIZES) {
    // 在画布上按目标大小画 SVG：矢量直接按这个大小栅格化，背景透明
    const url = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image(${size}, ${size});
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size};
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${size}, ${size}); resolve(c.toDataURL('image/png')); };
      img.onerror = () => reject(new Error('SVG 读不出来'));
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    images.push({ size, png: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') });
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, packIco(images));
  // 记下这个 ico 是按哪一版标志画的：测试拿它和现在的 SVG 比，改了标志忘了重画就报出来
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(SVG)).digest('hex');
  fs.writeFileSync(path.join(path.dirname(OUT), 'icon.json'), `${JSON.stringify({ from: 'docs/brand/aml-mark.svg', sha256: sha, sizes: SIZES }, null, 2)}\n`);
  console.log(`写好了 ${path.relative(ROOT, OUT)}：${SIZES.join('、')}（${fs.statSync(OUT).size} 字节）`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
