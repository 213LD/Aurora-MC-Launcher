'use strict';
/**
 * 子进程输出的编码（2.0.0-pre2）。在中文 Windows 上实测：
 * - PowerShell 写管道默认用系统编码（GBK），按 UTF-8 读就是乱码。命令前面加 PS_UTF8
 * - 游戏的 Java 加了 -Dfile.encoding=UTF-8，日志是 UTF-8；但 JVM 启动前自己的报错（找不到 jar、-Xlog 路径）还是系统编码
 * 所以 Java 的输出按行解码：是合法的 UTF-8 就按 UTF-8，不是就按系统编码。
 */
const PS_UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';

// 系统的「非 Unicode 程序语言」决定 JVM 报错用什么编码。不能看显示语言：英文界面的系统也可能是 936（这台测试机就是）
const BY_ACP = { 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258' };
function legacyName() {
  try {
    const out = require('child_process').execFileSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/ACP\s+REG_SZ\s+(\d+)/);
    if (m && BY_ACP[m[1]]) return BY_ACP[m[1]];
  } catch { /* 查不到就用系统区域猜 */ }
  let loc = '';
  try { loc = require('electron').app.getSystemLocale(); } catch { /* 不在 Electron 里 */ }
  return /^zh-(tw|hk|mo|hant)/i.test(loc) ? 'big5' : /^zh/i.test(loc) ? 'gbk' : /^ja/i.test(loc) ? 'shift_jis' : /^ko/i.test(loc) ? 'euc-kr' : 'windows-1252';
}

const strict = new TextDecoder('utf-8', { fatal: true });
let legacy = null;

/** 一段完整的字节：能按 UTF-8 读就按 UTF-8，不能就按系统编码 */
function decodeBytes(buf) {
  try { return strict.decode(buf); } catch { /* 不是 UTF-8 */ }
  if (!legacy) legacy = new TextDecoder(legacyName());
  return legacy.decode(buf);
}

const MAX_PARTIAL = 1 << 20;

/**
 * 按行解码一个输出流：onText 收到的总是完整的行（带换行符），多字节字符不会被切开。
 * 流结束时调 end()，取走最后没换行的部分。
 */
function lineDecoder(onText) {
  let rest = null;
  const emit = (b) => {
    // 大多数时候整块都是 UTF-8，不用逐行
    try { onText(strict.decode(b)); return; } catch { /* 有系统编码的行 */ }
    let from = 0;
    for (let i = b.indexOf(0x0a); i >= 0; i = b.indexOf(0x0a, from)) {
      onText(decodeBytes(b.subarray(from, i + 1)));
      from = i + 1;
    }
    if (from < b.length) onText(decodeBytes(b.subarray(from)));
  };
  return {
    write(chunk) {
      const b = rest ? Buffer.concat([rest, chunk]) : chunk;
      const i = b.lastIndexOf(0x0a);
      if (i < 0) {
        if (b.length > MAX_PARTIAL) { rest = null; emit(b); } else rest = b;
        return;
      }
      rest = i + 1 < b.length ? b.subarray(i + 1) : null;
      emit(b.subarray(0, i + 1));
    },
    end() {
      if (rest) { const b = rest; rest = null; emit(b); }
    },
  };
}

module.exports = { PS_UTF8, decodeBytes, lineDecoder };
