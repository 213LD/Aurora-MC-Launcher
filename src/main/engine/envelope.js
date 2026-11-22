'use strict';
/**
 * Aurora 自己导出的文件共用的外壳（1.5.1 起：Mod 配置器清单；以后的迁移 / 导出包也用它）
 *   { magic, kind, format, app, edition, exportedAt, sha256, data }
 * - edition：'internal' / 'public'（没有就是内部版：公开以前导出的都是）。两版的版本号差一个主版本（内部 2.x = 公开 1.x，
 *   shared/edition.js），比较「是不是更新的启动器导出的」时先换成同一种写法。edition 不算进校验值：老版本的启动器不认识这一项，
 *   算进去的话它们打开新文件会以为被改过
 * - 版本校验分级：format 比当前支持的新 → 不能导入，提示先更新启动器；
 *   只是导出的启动器版本更新、格式没变 → 警告后可以继续
 * - 篡改校验 = 结构检查 + 内容校验值（sha256 算在 magic..data 的规范化 JSON 上）：能发现损坏、不完整、被手动改过，
 *   发现时说明哪里不对，玩家可以自担风险继续。启动器开源、程序里藏不住密钥，防不了有意伪造
 * open() 返回的 problems：level 'block' 不能导入 / 'risk' 要玩家确认才能导入 / 'warn' 只提醒
 */
const crypto = require('crypto');
const { comparable } = require('../../shared/edition');
const EDITION = require('./edition');

const MAGIC = 'aurora-launcher';
const FORMATS = { 'mod-list': 1, 'aurora-data': 1 };
const KIND_NAME = { 'mod-list': 'Mod 清单', 'aurora-data': '数据导出包' };

const appVersion = () => { try { return require('electron').app.getVersion(); } catch { return '0.0.0'; } };

/** 键排序、去掉 undefined 的 JSON，保证同样的内容算出同样的校验值 */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

const headOf = (f) => ({ magic: f.magic, kind: f.kind, format: f.format, app: f.app, exportedAt: f.exportedAt });
const digest = (head, data) => crypto.createHash('sha256').update(canonical({ ...head, data })).digest('hex');

// 预发布的先后：别的后缀 < pre < rc < 正式版
const STAGES = { pre: 1, rc: 2 };
function parseVer(v) {
  const [core, ...rest] = String(v || '').split('+')[0].split('-');
  const tag = rest.join('-');
  const m = tag.match(/^([a-z]*)\.?(\d*)$/i);
  return {
    nums: core.split('.').map((x) => parseInt(x, 10) || 0),
    stage: !tag ? 3 : (m && STAGES[m[1].toLowerCase()]) || 0,
    tag: m ? m[1].toLowerCase() : tag,
    n: m ? parseInt(m[2], 10) || 0 : 0,
  };
}

/** 1.5.0 > 1.4.29 > 1.4.3；同一个版本号：2.0.0 > 2.0.0-rc1 > 2.0.0-pre10 > 2.0.0-pre9（2.0.0-pre1：以前后缀都当 0，全算相等）；不认识的部分按 0 */
function cmpVer(a, b) {
  const x = parseVer(a); const y = parseVer(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.stage !== y.stage) return x.stage > y.stage ? 1 : -1;
  if (x.tag !== y.tag) return x.tag > y.tag ? 1 : -1;
  if (x.n !== y.n) return x.n > y.n ? 1 : -1;
  return 0;
}

function seal(kind, data) {
  if (!FORMATS[kind]) throw new Error(`未知的文件类型：${kind}`);
  const head = { magic: MAGIC, kind, format: FORMATS[kind], app: appVersion(), exportedAt: new Date().toISOString() };
  return `${JSON.stringify({ ...head, edition: EDITION.name, sha256: digest(head, data), data }, null, 2)}\n`;
}

function open(text, kind) {
  const block = (code, msg) => ({ ok: false, problems: [{ level: 'block', code, text: msg }] });
  let f;
  try { f = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch {
    return block('parse', '文件内容无法读取：可能已经损坏，或者不是 Aurora 导出的文件');
  }
  if (!f || typeof f !== 'object' || f.magic !== MAGIC) return block('notAurora', '这不是 Aurora 启动器导出的文件（缺少 Aurora 文件标记）');
  if (f.kind !== kind) return block('kind', `这是 Aurora 的「${KIND_NAME[f.kind] || f.kind || '未知'}」文件，不是${KIND_NAME[kind] || kind}`);
  const cur = appVersion();
  if (!Number.isInteger(f.format) || f.format < 1) return block('format', '文件缺少格式版本，不符合 Aurora 的文件规范');
  if (f.format > FORMATS[kind]) {
    return block('newerFormat', `这个文件由更新的启动器（${f.app || '未知版本'}）导出，用了当前启动器（${cur}）还看不懂的新格式。请先把启动器更新到 ${f.app || '最新版'} 或更高版本再导入`);
  }
  const problems = [];
  if (f.app && cmpVer(comparable(f.app, f.edition), comparable(cur, EDITION.name)) > 0) {
    problems.push({ level: 'warn', code: 'newerApp', text: `这个文件由更新的启动器（${f.app}）导出，当前是 ${cur}。文件格式相同，可以导入，但新版本才有的内容可能会被忽略` });
  }
  if (typeof f.sha256 !== 'string' || !f.sha256) problems.push({ level: 'risk', code: 'noHash', text: '文件缺少校验值，无法确认内容是否完整、有没有被改过' });
  else if (digest(headOf(f), f.data) !== f.sha256) problems.push({ level: 'risk', code: 'hash', text: '校验值对不上：文件在导出之后被修改过，或者在传输中损坏了' });
  if (f.data === undefined || f.data === null || typeof f.data !== 'object') return { ok: false, problems: [...problems, { level: 'block', code: 'noData', text: '文件里没有内容，不完整' }] };
  return { ok: true, data: f.data, meta: { app: f.app || '', format: f.format, exportedAt: f.exportedAt || '' }, problems };
}

module.exports = { seal, open, cmpVer, canonical, FORMATS, MAGIC };
