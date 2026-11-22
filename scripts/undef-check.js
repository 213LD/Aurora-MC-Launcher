'use strict';
/**
 * 查「用了没定义的名字」和「从模块解构出不存在的导出」（2.0.0-pre7）。不加依赖，自己切词。
 *
 * 起因：core/promote.js 拆文件时漏了一个 throwIfAborted 导入，语法检查查不出来，一跑到那一行就报错。
 *
 * 规则是按文件算的，不看作用域：一个名字在这个文件里哪儿都没声明、也不是全局对象，才算没定义。
 * 所以「别的函数里声明过同名变量」查不出来，换来的是没有误报。
 *
 *   node scripts/undef-check.js            查 src 和 scripts，有问题退出码 1
 *   node scripts/undef-check.js a.js b.js  只查这几个文件
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null of return super switch this throw true try typeof var void while with yield async await static get set arguments undefined NaN Infinity').split(' '));
const BROWSER = ('window self document navigator location history localStorage sessionStorage screen performance requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle matchMedia alert confirm prompt open close '
  + 'Node NodeFilter Element HTMLElement HTMLCanvasElement HTMLImageElement Image Audio AudioContext OfflineAudioContext BaseAudioContext AudioBuffer MutationObserver ResizeObserver IntersectionObserver PerformanceObserver '
  + 'FileReader File FileList Blob DOMParser XMLSerializer CSS CSSStyleSheet Event CustomEvent KeyboardEvent MouseEvent PointerEvent WheelEvent DragEvent ClipboardEvent InputEvent DocumentFragment Range Selection getSelection '
  + 'OffscreenCanvas ImageData ImageBitmap createImageBitmap Path2D DOMRect DOMMatrix WebGLRenderingContext WebGL2RenderingContext WebSocket Worker XMLHttpRequest IDBKeyRange indexedDB speechSynthesis SpeechSynthesisUtterance devicePixelRatio innerWidth innerHeight scrollX scrollY Notification').split(' ');
// 渲染进程约定的全局对象（core.js 和 shared 脚本放到 window 上的）
const PROJECT = ['A', 'I18N', 'BRAND', 'PATHRULES'];
const NODE = ['require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global', 'setImmediate', 'clearImmediate'];
const GLOBALS = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER, ...PROJECT, ...NODE]);

/** 切词：去掉注释和字符串，模板字符串里的 ${} 照样切。返回 [{ t: 'id'|'p', v, line }] */
function tokenize(src) {
  const out = [];
  let i = 0; let line = 1;
  const stack = []; // 模板字符串嵌套：记 ${ 那一层的花括号深度
  let depth = 0;
  const canRegex = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.t === 'id') return ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof'].includes(p.v);
    if (p.t === 'str') return false;
    return !([')', ']', '}'].includes(p.v));
  };
  const readTemplate = () => { // i 在 ` 之后，或 ${} 结束的 } 之后
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { i++; out.push({ t: 'str', v: '`', line }); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; stack.push(depth); depth = 0; out.push({ t: 'p', v: '${', line }); return; }
      i++;
    }
  };
  const ID = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; for (let k = i; k < end; k++) if (src[k] === '\n') line++; i = end; continue; }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; out.push({ t: 'str', v: c, line }); continue; }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/' && canRegex()) {
      i++; let cls = false;
      while (i < src.length && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; else if (src[i] === '\n') break; i++; }
      i++; while (/[a-z]/.test(src[i] || '')) i++;
      out.push({ t: 'str', v: '/', line });
      continue;
    }
    if (c === '{') { depth++; out.push({ t: 'p', v: c, line }); i++; continue; }
    if (c === '}') {
      if (depth === 0 && stack.length) { depth = stack.pop(); out.push({ t: 'p', v: '}$', line }); i++; readTemplate(); continue; }
      depth--; out.push({ t: 'p', v: c, line }); i++; continue;
    }
    ID.lastIndex = i;
    const m = ID.exec(src);
    if (m) { out.push({ t: 'id', v: m[0], line }); i += m[0].length; continue; }
    if (/[0-9]/.test(c)) { i++; while (/[0-9a-zA-Z_.]/.test(src[i] || '')) i++; out.push({ t: 'str', v: '0', line }); continue; }
    if (src.startsWith('=>', i)) { out.push({ t: 'p', v: '=>', line }); i += 2; continue; }
    if (src.startsWith('...', i)) { out.push({ t: 'p', v: '...', line }); i += 3; continue; }
    if (src.startsWith('?.', i) && !/[0-9]/.test(src[i + 2] || '')) { out.push({ t: 'p', v: '.', line }); i += 2; continue; }
    out.push({ t: 'p', v: c, line }); i++;
  }
  return out;
}

const OPEN = { '(': ')', '[': ']', '{': '}', '${': '}$' };
const isOpen = (x) => x.t === 'p' && OPEN[x.v];
/** 从开括号找到配对的闭括号的下标 */
function closeOf(toks, i) {
  let d = 0;
  for (let k = i; k < toks.length; k++) {
    const x = toks[k];
    if (x.t !== 'p') continue;
    if (OPEN[x.v]) d++;
    else if (x.v === ')' || x.v === ']' || x.v === '}' || x.v === '}$') { d--; if (d === 0) return k; }
  }
  return toks.length - 1;
}
function openOf(toks, i) {
  let d = 0;
  for (let k = i; k >= 0; k--) {
    const x = toks[k];
    if (x.t !== 'p') continue;
    if (x.v === ')' || x.v === ']' || x.v === '}' || x.v === '}$') d++;
    else if (OPEN[x.v]) { d--; if (d === 0) return k; }
  }
  return 0;
}

/** 这个文件里声明过的所有名字（从宽：解构、参数列表里的名字都算） */
function declared(toks) {
  const names = new Set();
  const addRange = (a, b) => { for (let k = a; k <= b; k++) if (toks[k].t === 'id') names.add(toks[k].v); };
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i];
    const n = toks[i + 1];
    if (x.t === 'id' && ['const', 'let', 'var'].includes(x.v)) {
      // 一条语句可以声明好几个：const a = 1, b = 2
      let k = i + 1;
      for (;;) {
        const y = toks[k];
        if (!y) break;
        if (y.t === 'id') names.add(y.v);
        else if (isOpen(y)) { const e = closeOf(toks, k); addRange(k, e); k = e; } else break;
        // 跳到这个声明的下一个逗号
        let j = k + 1; let found = false;
        for (; j < toks.length; j++) {
          const z = toks[j];
          if (isOpen(z)) { j = closeOf(toks, j); continue; }
          if (z.t === 'p' && z.v === ',') { found = true; break; }
          if (z.t === 'p' && (z.v === ';' || z.v === ')' || z.v === '}' || z.v === ']' || z.v === '}$')) break;
          if (z.t === 'id' && (z.v === 'of' || z.v === 'in') && j === k + 1) break;
          if (z.line > toks[j - 1].line && z.t === 'id' && ['const', 'let', 'var', 'function', 'if', 'for', 'return', 'class', 'try', 'while', 'switch', 'throw', 'await', 'async'].includes(z.v)) break;
        }
        if (!found) break;
        k = j + 1;
      }
    } else if (x.t === 'id' && x.v === 'function') {
      let k = i + 1;
      if (toks[k] && toks[k].v === '*') k++;
      if (toks[k] && toks[k].t === 'id') { names.add(toks[k].v); k++; }
      if (toks[k] && toks[k].v === '(') addRange(k, closeOf(toks, k));
    } else if (x.t === 'id' && x.v === 'class' && n && n.t === 'id' && n.v !== 'extends') {
      names.add(n.v);
    } else if (x.t === 'id' && x.v === 'catch' && n && n.v === '(') {
      addRange(i + 1, closeOf(toks, i + 1));
    } else if (x.t === 'p' && x.v === '=>') {
      const p = toks[i - 1];
      if (p && p.t === 'id') names.add(p.v);
      else if (p && p.v === ')') addRange(openOf(toks, i - 1), i - 1);
    } else if (x.t === 'p' && x.v === '(' && i > 0 && toks[i - 1].t === 'id' && !['if', 'for', 'while', 'switch', 'catch', 'function', 'with', 'return', 'typeof', 'await', 'new', 'of', 'in', 'yield', 'void', 'delete'].includes(toks[i - 1].v)) {
      // 对象和类的方法：name(a, b) { … }
      const e = closeOf(toks, i);
      if (toks[e + 1] && toks[e + 1].v === '{') addRange(i, e);
    }
  }
  return names;
}

/** 用到的、没声明的名字 */
function undefinedNames(src) {
  const toks = tokenize(src);
  const names = declared(toks);
  const bad = new Map();
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i];
    if (x.t !== 'id' || KEYWORDS.has(x.v) || GLOBALS.has(x.v) || names.has(x.v)) continue;
    const p = toks[i - 1]; const n = toks[i + 1];
    if (p && p.t === 'p' && p.v === '.') continue; // a.b
    // 对象的键、标签：{ b: 1 }、, b: 1、label:
    if (n && n.t === 'p' && n.v === ':' && (!p || p.t !== 'p' || ['{', ',', ';', '}'].includes(p.v))) continue;
    // 对象和类的方法名：name(a) { … }、get name() { … }
    if (n && n.v === '(' && p && (p.t === 'id' ? ['async', 'get', 'set', 'static'].includes(p.v) : ['{', ',', '}', ';', '*'].includes(p.v))) {
      const e = closeOf(toks, i + 1);
      if (toks[e + 1] && toks[e + 1].v === '{') continue;
    }
    if (!bad.has(x.v)) bad.set(x.v, x.line);
  }
  return [...bad.entries()].map(([name, line]) => ({ name, line }));
}

/** const { a, b: c } = require('./x')：x 导出里没有 a。只看 module.exports = { … } 写法的模块 */
function badImports(file, src) {
  const out = [];
  const re = /const \{([^}]+)\} = require\('(\.[^']+)'\);?/g;
  for (const m of src.matchAll(re)) {
    let target = path.resolve(path.dirname(file), m[2]);
    if (fs.existsSync(`${target}.js`)) target = `${target}.js`;
    else if (fs.existsSync(path.join(target, 'index.js'))) target = path.join(target, 'index.js');
    else continue;
    const text = fs.readFileSync(target, 'utf8');
    const ex = text.match(/module\.exports = \{([\s\S]*?)\n?\};?\s*$/);
    if (!ex || /module\.exports\.|exports\.\w+ =|\.\.\./.test(text.slice(0, ex.index) + ex[1])) continue; // 不是一次写完的，不判断
    const keys = new Set();
    let d = 0; let at = true;
    const toks = tokenize(`{${ex[1]}}`);
    for (let i = 0; i < toks.length; i++) {
      const x = toks[i];
      if (isOpen(x)) { d++; if (d === 1) at = true; continue; }
      if (x.t === 'p' && [')', ']', '}', '}$'].includes(x.v)) { d--; continue; }
      if (d !== 1) continue;
      if (x.t === 'p' && x.v === ',') { at = true; continue; }
      if (at && x.t === 'id') { if (x.v === 'get' || x.v === 'async' || x.v === 'set') { const n = toks[i + 1]; if (n && n.t === 'id') continue; } keys.add(x.v); at = false; } else if (at && x.t === 'str') at = false;
    }
    if (!keys.size) continue;
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim();
      if (name && !keys.has(name)) out.push({ name, from: m[2], line: src.slice(0, m.index).split('\n').length });
    }
  }
  return out;
}

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
  return [
    ...undefinedNames(src).map((x) => `${path.relative(REPO, file).replace(/\\/g, '/')}:${x.line} 没定义：${x.name}`),
    ...badImports(file, src).map((x) => `${path.relative(REPO, file).replace(/\\/g, '/')}:${x.line} ${x.from} 没有导出：${x.name}`),
  ];
}

function allFiles() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', 'i18n', 'vendor'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  return [...walk(path.join(REPO, 'src')), ...walk(path.join(REPO, 'scripts'))].filter((f) => f.endsWith('.js'));
}

if (require.main === module) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => path.resolve(f)) : allFiles();
  const bad = files.flatMap(checkFile);
  for (const b of bad) console.log(b);
  console.log(`查了 ${files.length} 个文件，${bad.length} 个问题`);
  process.exitCode = bad.length ? 1 : 0;
}

module.exports = { undefinedNames, badImports, tokenize };
