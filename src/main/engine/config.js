'use strict';
/**
 * 启动器设置：读写 config.json（深合并、200 毫秒防抖、退出前写完），默认值在 DEFAULTS（新设置项先加在那里），
 * 每个配置单独的设置（versionSettings），改动通知（onChange）。
 */
const path = require('path');
const crypto = require('crypto');
const { readJsonSync } = require('./util');
const store = require('./jsonstore');
const paths = require('./paths');
const location = require('./location');
const BRAND = require('../../shared/brand');

const DEFAULTS = {
  gameDir: '',
  downloadSource: 'auto', // auto | official | bmclapi
  concurrency: 48,
  java: {
    selected: 'auto', // 'auto' 或 java 可执行文件路径
    autoDownload: true,
    extra: [], // 手动添加的 Java 路径
  },
  memory: { auto: true, max: 4096, min: 256 },
  jvmArgs: '',
  gameArgs: '',
  window: { width: 1280, height: 720, fullscreen: false },
  isolation: 'modded', // none | modded | all
  autoChinese: true,
  versionType: BRAND.short,
  server: { enabled: false, address: '' },
  afterLaunch: 'minimize', // keep | minimize | hide | close
  restoreOnExit: true,
  showLogOnLaunch: false,
  msClientId: '',
  theme: 'dark',
  // 性能模式（1.7.0 起不藏任何功能）：关掉动画、毛玻璃、3D 皮肤预览和硬件加速（要重启才生效），主页背景静止
  perfMode: false,
  // 简洁模式（1.7.0，和性能模式互相独立）：只留启动、存档、Mod 启用禁用、账户切换和设置，其余入口变灰
  simpleMode: false,
  sidebarCollapsed: false, // 侧边栏手动收起，只显示图标（1.4.8）
  // 无障碍（1.5.2）：zoom 界面缩放 1–2；largeText 最小字号 13px（窗口创建时的 minimumFontSize，要重启）；
  // contrast / motion：auto 跟随 Windows 设置；cvd 色弱友好配色（红绿换成橙蓝）；subtitles 新游戏目录第一次启动时打开游戏字幕
  // 界面风格（1.5.4）：aurora 极光（默认）/ pixel 像素原版 / compact 经典紧凑；pixelFont 像素风用不用像素字体
  ui: { style: 'aurora', pixelFont: true },
  // motion：auto / full 完整 / soft 减弱（1.5.5）/ reduce 全部关闭；noFlash 减少闪烁（1.5.5，和 motion 独立）
  a11y: { zoom: 1, largeText: false, contrast: 'auto', motion: 'auto', noFlash: false, cvd: false, subtitles: false },
  // 游戏设置同步（1.5.6）：mode once 只在新配置第一次启动前 / follow 每次启动保持一致；cats 同步哪些类别（optionsfmt.CATEGORIES）
  gameSync: { enabled: false, mode: 'once', cats: ['keys', 'modKeys', 'controls', 'video', 'sound', 'lang', 'skin'] },
  accent: 'aurora',
  background: {
    type: 'scene', image: '', time: 'auto',
    // 像素场景：场景、生物数量与种类、和平模式、建筑、彩蛋、移动视角
    scene: 'auto', mobs: 8, animals: true, monsters: true, players: true, aquatic: true, peaceful: false, buildings: true, eggs: true, pan: true, mySkins: false,
    // 性能（性能打磨）：range 世界生成范围 large / medium / small、fps 帧率上限 30 / 20 / 10 / 0（0 = 静态）、fx 特效 high / medium / low；
    // perfTier 最后一次选的档位（high / medium / low / static / custom）、hwKey 那时的硬件指纹（变了就提示重新推荐）
    range: 'large', fps: 30, fx: 'high', perfTier: '', hwKey: '',
  },
  // 主页更新日志（1.4.2）：enabled 总开关（关掉后哪里都不显示）、open 展开 / 收起、tab 当前标签（mc / launcher）、
  // seenLauncher 看过哪个启动器版本的更新日志（不同就显示红点）
  news: { enabled: true, open: false, tab: 'mc', seenLauncher: '' },
  // Mod 管理页的排序：name / nameDesc / added / type
  modSort: 'name',
  selectedVersion: '',
  versionSettings: {},
  clientToken: '',
  mcmod: { enabled: false }, // MC 百科中文信息（实验性，默认关）
  music: { enabled: false, volume: 0.45, track: 'all', pauseInGame: true },
  // 主页背景的音效（rc3）：有自己的开关和音量，默认开着（以前没有开关，音量跟着背景音乐）
  sound: { enabled: true, volume: 0.45 },
  // 日志中心（rc4）：每局游戏日志保存几天，0 = 一直保存
  logs: { keepDays: 30 },
  // CurseForge：自己的 API Key（可选）；没有 Key 时是否使用社区代理
  curseforge: { apiKey: '', proxy: true },
  // 下载页资源浏览器和「在线添加」用的来源：modrinth / curseforge
  resSource: 'modrinth',
  // CurseForge 手动下载导入后，「下载」文件夹里的原文件：ask 每次询问 / trash 移到回收站 / keep 保留
  cfDownloads: 'ask',
  // 界面语言：auto 跟随系统，或 zh-CN / en（未翻译完的语言会回落到简体中文）
  language: 'auto',
  // 新建游戏配置时默认的存档方式：isolated 独立 / shared 共享公共 .minecraft 的存档
  newProfileIsolation: 'isolated',
  // 首次启动向导（数据位置 + 游戏目录 + 存档方式 + Java）是否已完成
  setupDone: false,
  // 向导里选了「安装推荐的 Java」又换了数据位置：重启后再下载（官方运行时的组件名）
  pendingJava: '',
  // 运行位置检测里玩家选了「这个位置不再提示」的项（规则|文件夹）
  placeIgnore: [],
  disclaimerAccepted: '',
  tips: {},
  // 终极彩蛋「Minecraft doesn't need you」（1.5.16）：done 是打败末影龙的时间；只触发一次，一键还原 / 恢复默认后清掉
  ultimate: { done: '' },
  // 存档与设置备份：启动前备份存档（默认关）、改 Mod 前备份 Mod 和配置（默认开）、每个配置每种自动备份保留几份、自动备份总大小上限（GB）
  backup: { beforeLaunch: false, beforeModChange: true, keepAuto: 5, maxTotalGB: 20 },
  // 皮肤：「启动后关闭启动器」遇到本地皮肤服务时怎么办 ask | keep | close
  skin: { closeChoice: 'ask' },
  configVersion: 5,
};

let data = null;
const appVersion = () => { try { return require('electron').app.getVersion(); } catch { return ''; } };
let saveTimer = null;
const listeners = new Set();
// 设置文件读不了（被占着）时这次运行不写回，免得用默认值盖掉玩家原来的设置（1.10.7）
let writeBlocked = false;
const LABEL = '设置';

function file() { return path.join(paths.dataDir(), 'config.json'); }

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// 设置文件和导入包都可能被改过，这几个名字不能当成设置项（2.0.0-pre8，全面测试：原型污染）
const NOT_A_KEY = new Set(['__proto__', 'constructor', 'prototype']);

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (NOT_A_KEY.has(k)) continue;
    if (isObj(v) && isObj(base[k]) && k !== 'versionSettings') out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * 设置文件可能被手改过、被老版本或别的工具写过：默认是对象或列表的项，换成了别的类型就当没写（2.0.0-pre8，全面测试：坏输入）。
 * 以前 java 写成 null，Java 页和设置页一打开就崩。这里只管形状，不认识的项照常留着
 */
function keepShape(defaults, saved) {
  const out = { ...saved };
  for (const [k, d] of Object.entries(defaults)) {
    if (!(k in out)) continue;
    if (Array.isArray(d)) { if (!Array.isArray(out[k])) delete out[k]; } else if (isObj(d)) {
      if (!isObj(out[k])) delete out[k];
      else if (k !== 'versionSettings') out[k] = keepShape(d, out[k]);
    }
  }
  return out;
}

function load() {
  // 便携模式下配置里的路径按数据文件夹的相对位置保存。读坏了：坏文件改名留着，有备份就用备份（jsonstore）
  const r = store.loadSync(file(), { label: LABEL });
  writeBlocked = r.status === 'busy';
  const raw = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
  const saved = keepShape(DEFAULTS, location.unpack(raw));
  const fresh = !Object.keys(saved).length;
  data = merge(DEFAULTS, saved);
  // rc3 以前音效没有单独的音量，跟着背景音乐的音量：老用户第一次读到时沿用那个音量，听起来不变
  if (!fresh && !saved.sound && saved.music && typeof saved.music.volume === 'number') data.sound = { ...data.sound, volume: saved.music.volume };
  if (!fresh && (saved.configVersion || 1) < 2) {
    // 1.3.0：已经在用的启动器不再弹首次启动向导；背景音乐改为默认关闭
    if (saved.setupDone === undefined) data.setupDone = true;
    data.music = { ...data.music, enabled: false };
    data.configVersion = 2;
  }
  if (!fresh && data.configVersion < 3) {
    // 1.4.0：首页更新日志默认折叠，老用户也折叠一次，之后玩家展开就一直展开
    data.showNews = false;
    data.configVersion = 3;
  }
  if (!fresh && data.configVersion < 4) {
    // 1.4.2：以前的 showNews 只表示展开 / 收起，现在拆成总开关 news.enabled 和 news.open
    data.news = { ...data.news, enabled: true, open: !!data.showNews };
    data.configVersion = 4;
  }
  if (!fresh && data.configVersion < 5) {
    // 1.4.3：首次启动向导这一版才有界面；1.3.0 ~ 1.4.2 新装的用户已经在用了，不再弹向导
    data.setupDone = true;
    data.configVersion = 5;
  }
  delete data.showNews;
  // 新安装的不提示「启动器有更新」
  if (fresh) data.news.seenLauncher = appVersion();
  if (!data.gameDir) data.gameDir = process.env.AURORA_GAME_DIR || paths.defaultGameDir();
  if (!data.clientToken) data.clientToken = crypto.randomUUID().replace(/-/g, '');
  // 读出来补齐、升级以后和文件里的一样就不写：以前每次启动（还读了两遍）都重写一次，.bak 也跟着被换成同一份
  if (r.status !== 'ok' || JSON.stringify(location.pack(data)) !== JSON.stringify(raw)) save();
  return data;
}

function get() {
  if (!data) load();
  return data;
}

function set(patch) {
  get();
  data = merge(data, patch);
  save();
  for (const l of listeners) { try { l(data, patch); } catch { /* ignore */ } }
  return data;
}

// 隐藏调试菜单（1.4.11）用：config:set 是深合并，清不掉对象里的键，这里直接整体改写。
// 改之前把当前配置备份到 config.debug-backup.json，「还原」从备份回来
const KEEP_ON_RESET = ['gameDir', 'versionSettings', 'selectedVersion', 'clientToken', 'configVersion', 'setupDone', 'disclaimerAccepted', 'msClientId', 'curseforge', 'pendingJava'];
function backupFile() { return path.join(paths.dataDir(), 'config.debug-backup.json'); }
async function debugAction(action) {
  get();
  const fs = require('fs');
  if (action === 'restore') {
    const b = readJsonSync(backupFile(), null);
    if (!b) throw new Error('没有备份可以还原');
    data = merge(DEFAULTS, location.unpack(b));
  } else {
    const tmp = `${backupFile()}.aurora-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(location.pack(data), null, 2));
    fs.renameSync(tmp, backupFile());
    if (action === 'reset') {
      const keep = Object.fromEntries(KEEP_ON_RESET.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
      data = merge(JSON.parse(JSON.stringify(DEFAULTS)), keep);
    } else if (action === 'clearSeen') {
      data = { ...data, tips: {}, placeIgnore: [], cfDownloads: 'ask', news: { ...data.news, seenLauncher: '' } };
    } else if (action === 'firstRun') {
      data = { ...data, setupDone: false, disclaimerAccepted: '' };
    } else throw new Error(`未知操作 ${action}`);
  }
  await flush(); // 马上写盘：「模拟首次启动」接着就重新加载界面
  for (const l of listeners) { try { l(data, {}); } catch { /* ignore */ } }
  return { config: data, hasBackup: fs.existsSync(backupFile()) };
}
/** 一键还原：全部设置回到默认，只保留游戏目录（首次启动向导里还能改），并且重新走首次启动 */
async function factoryReset() {
  const gameDir = get().gameDir;
  data = merge(JSON.parse(JSON.stringify(DEFAULTS)), { gameDir });
  data.setupDone = false;
  data.disclaimerAccepted = '';
  await flush();
  // 保存前的那份会留成 .bak：还原了就不该再能从备份「恢复」回去
  await require('fs').promises.rm(`${file()}.bak`, { force: true }).catch(() => {});
  return data;
}
function hasDebugBackup() { return require('fs').existsSync(backupFile()); }

function getVersionSettings(id) {
  return { ...(get().versionSettings[id] || {}) };
}

function setVersionSettings(id, s) {
  // 界面传来的：配置名要是正常的字符串，设置要是对象（null 是删掉），里面不能有 __proto__ 这种名字
  if (typeof id !== 'string' || !id || NOT_A_KEY.has(id)) throw new Error('配置名不对');
  if (s !== null && (!s || typeof s !== 'object' || Array.isArray(s))) throw new Error('配置的单独设置不对');
  const all = { ...get().versionSettings };
  if (s === null) delete all[id];
  else all[id] = { ...(all[id] || {}), ...Object.fromEntries(Object.entries(s).filter(([k]) => !NOT_A_KEY.has(k))) };
  data.versionSettings = all;
  save();
  return all[id] || {};
}

function renameVersionSettings(oldId, newId) {
  const all = { ...get().versionSettings };
  if (all[oldId]) { all[newId] = all[oldId]; delete all[oldId]; }
  data.versionSettings = all;
  if (data.selectedVersion === oldId) data.selectedVersion = newId;
  save();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

/**
 * 立即写入（切换存储位置前、退出前调用）。写入按调用顺序排队，后面的内容不会被前面的盖掉（jsonstore.write）。
 * 写失败（一般是杀毒软件占着）过一会儿重试，内容还在内存里；连着失败才告诉玩家，之后写成功了再说一声（2.0.0-pre2）
 */
const RETRY_MS = [500, 1500, 4000, 10000, 30000];
require('./shutdown').onQuit(flush);
let failures = 0;
async function flush() {
  clearTimeout(saveTimer);
  if (writeBlocked) return false;
  try {
    await store.write(file(), location.pack(data), { label: LABEL });
    if (failures) store.writeRecovered(LABEL, file());
    failures = 0;
    return true;
  } catch (e) {
    console.error('[config] save failed', e);
    failures++;
    if (failures === 2) store.writeFailed(LABEL, file());
    saveTimer = setTimeout(flush, RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
    return false;
  }
}

function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { load, get, set, debugAction, hasDebugBackup, factoryReset, flush, getVersionSettings, setVersionSettings, renameVersionSettings, onChange, DEFAULTS };
