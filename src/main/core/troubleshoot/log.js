'use strict';
/** 解析崩溃日志和崩溃报告，定位问题 Mod */
const launcher = require('../launcher');
const javafit = require('../javafit');
const { clipLog } = require('../../engine/util');
const { nm } = require('../../../shared/i18n');
const { modLabel, rangeText } = require('./compat');

function findByModId(list, id) {
  const k = String(id).toLowerCase();
  return list.filter((m) => [...(m.ids || []), ...(m.provides || [])].some((x) => String(x).toLowerCase() === k));
}

function analyzeLog(rawText, list) {
  const text = clipLog(rawText);
  const issues = [];
  const seen = new Set();
  const add = (key, i) => { if (seen.has(key)) return; seen.add(key); issues.push({ id: key, ...i }); };
  let m;

  const missingRes = [
    /Mod '([^']+)' \(([\w.-]+)\) \S+ requires .*? of (?:mod )?'?[^'(\n]*'? ?\(([\w.-]+)\),? which is missing/g,
    /Mod ([\w.-]+) requires ([\w.-]+) [^\n]*\n\s*Currently, \2 is not installed/g,
    /Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '[^']*', Actual version: '\[MISSING\]'/g,
  ];
  while ((m = missingRes[0].exec(text))) add(`missing:${m[3]}`, { severity: 'crit', type: 'missing-dep', title: `缺少前置 Mod：${m[3]}`, detail: `${m[1]} 需要它`, modId: m[3], fix: { kind: 'install-dep', modId: m[3] } });
  while ((m = missingRes[1].exec(text))) add(`missing:${m[2]}`, { severity: 'crit', type: 'missing-dep', title: `缺少前置 Mod：${m[2]}`, detail: `${m[1]} 需要它`, modId: m[2], fix: { kind: 'install-dep', modId: m[2] } });
  while ((m = missingRes[2].exec(text))) add(`missing:${m[1]}`, { severity: 'crit', type: 'missing-dep', title: `缺少前置 Mod：${m[1]}`, detail: `${m[2]} 需要它`, modId: m[1], fix: { kind: 'install-dep', modId: m[1] } });
  const inst = /- Install ([\w.-]+), (?:any version|version [^\n]+)/g;
  while ((m = inst.exec(text))) add(`missing:${m[1]}`, { severity: 'crit', type: 'missing-dep', title: `缺少前置 Mod：${m[1]}`, detail: '加载器给出的解决方案：安装该 Mod', modId: m[1], fix: { kind: 'install-dep', modId: m[1] } });
  const legacy = /MissingModsException: Mod ([\w.-]+) \(([^)]+)\) requires \[([\w.-]+)@/g;
  while ((m = legacy.exec(text))) add(`missing:${m[3]}`, { severity: 'crit', type: 'missing-dep', title: `缺少前置 Mod：${m[3]}`, detail: `${m[2]} 需要它`, modId: m[3], fix: { kind: 'install-dep', modId: m[3] } });

  // 需要更高版本的 Java：给「用 Java N 再测一次」
  const javaNeed = javafit.fromLog(text, list || []);
  if (javaNeed) add('java-version', javaNeed);

  // 版本不匹配的前置
  const wrongVer = /Mod ([\w.-]+) requires ([\w.-]+) ([^\n]+?)\s*\n\s*Currently, \2 is (?!not installed)([^\n]+)/g;
  while ((m = wrongVer.exec(text))) {
    if (m[2] === 'java') continue;
    const files = findByModId(list, m[2]).map((x) => x.path);
    add(`ver:${m[2]}`, { severity: 'crit', type: 'dep-version', title: `${m[2]} 版本不符合要求`, detail: `${m[1]} 需要 ${m[2]} ${m[3].trim()}，当前为 ${m[4].trim()}`, modId: m[2], files, fix: { kind: 'install-dep', modId: m[2], update: true } });
  }

  // Fabric 0.15 起的写法（1.5.10）：Mod 'Indium' (indium) 1.0.36 requires any version between 0.5.11 (inclusive) and 0.6- (exclusive)
  // of mod 'Sodium' (sodium), but only the wrong version is present: 0.5.7+mc1.20.1!  原始范围在「{depends sodium @ [~0.5.11]}」里
  const wrongVer2 = /Mod '([^']+)' \(([\w.-]+)\) \S+ requires (.+?) of (?:mod )?'([^']+)' \(([\w.-]+)\), but only the wrong version is present: ([^\n!]+)/g;
  const rawDeps = [...text.matchAll(/\{depends ([\w.-]+) @ \[([^\]]*)\]\}/g)];
  while ((m = wrongVer2.exec(text))) {
    if (/^(java|minecraft|fabricloader|quilt_loader)$/.test(m[5])) continue;
    const raw = rawDeps.find((r) => r[1] === m[5]);
    const ranges = raw ? raw[2].split(/,\s*/).filter(Boolean) : null;
    const files = findByModId(list, m[5]).map((x) => x.path);
    const want = ranges ? rangeText(ranges) : m[3].replace(/any version between (\S+) \(inclusive\) and (\S+) \(exclusive\)/, '$1 及以上、低于 $2').replace(/version (\S+) or later/, '$1 或更高').replace(/(\d)-(?=\s|$|、)/g, '$1');
    add(`ver:${m[5]}`, {
      severity: 'crit', type: 'dep-version', title: `${m[1]} 需要的 ${m[4]} 版本不对`,
      detail: `${m[1]} 需要 ${m[4]} ${want}，装的是 ${m[6].trim()}`, raw: m[0], modId: m[5], ranges, files: [...files, ...findByModId(list, m[2]).map((x) => x.path)],
      fix: { kind: 'install-dep', modId: m[5], ranges, update: true },
    });
  }

  // 可选前置装了但版本不对（Forge 红色错误画面：「Mod xaeroworldmap only supports xaerominimap 26.4.0 or above / Currently, xaerominimap is 23.4.4」）
  const optVer = /Mod (?:§e)?([\w.-]+)(?:§r)? only supports (?:§3)?([\w.-]+)(?:§r)? (?:§o)?([^\n§]+?)(?:§r)?\s*\n[^\n]*?Currently, (?:§3)?\2(?:§r)?(?:§7)? is (?:§o)?([^\n§]+)/g;
  while ((m = optVer.exec(text))) {
    const files = findByModId(list, m[2]).map((x) => x.path);
    add(`ver:${m[2]}`, { severity: 'crit', type: 'dep-version', title: `${m[2]} 版本不符合要求`, detail: `${m[1]} 需要 ${m[2]} ${m[3].trim().replace(/ or above$/, ' 或更高')}，当前为 ${m[4].trim()}`, modId: m[2], files, fix: { kind: 'install-dep', modId: m[2], update: true } });
  }
  // Fabric Loader 本身太旧（「Replace mod 'Fabric Loader' (fabricloader) 0.15.10 with version 0.16.10 or later」）
  const oldLoader = /Replace mod '([^']+)' \((fabricloader|quilt_loader)\) (\S+) with version (\S+)/.exec(text);
  if (oldLoader) add('loader-old', { severity: 'crit', type: 'loader-version', title: `${oldLoader[1]} 版本太旧`, detail: `有 Mod 需要 ${oldLoader[1]} ${oldLoader[4]} 或更高，当前是 ${oldLoader[3]}。请重新安装这个版本的加载器，或换用旧一点的 Mod` });
  // 损坏的文件：不是完整的 zip（下载到一半），或 mods.toml 写坏了，Forge 一开始就退出
  if (/zip END header not found|ZipException: (?:zip file is empty|invalid CEN header)/.test(text)) add('corrupt', { severity: 'crit', type: 'general', title: 'mods 文件夹里有损坏的文件', detail: '有文件不是完整的 jar（可能只下载了一半），请在 Mod 管理里找到大小异常的文件，删除后重新下载' });
  // Fabric 第一次启动要在游戏目录里写重新映射的 jar：网络共享路径（\\服务器\共享）上写不进去（2026-11-07 在群晖上实测）
  if (/remappedJars[^\n]*can't be written|error remapping game jars/.test(text)) add('remap-write', { severity: 'crit', type: 'general', title: 'Fabric 没法在游戏文件夹里写文件', detail: '游戏文件夹在网络路径（比如群晖、NAS 的共享文件夹）上，或者没有写入权限时会这样。把游戏文件夹放在本机硬盘上再试（设置 → 游戏目录）' });
  if (/nightconfig\.core\.io\.ParsingException/.test(text)) add('badtoml', { severity: 'crit', type: 'general', title: '有 Mod 的描述文件（mods.toml）写坏了', detail: 'Forge 读不懂某个 Mod 的描述文件，请把最近加入的 Mod 逐个禁用试试' });

  // 不兼容
  const incompat = /Mod '([^']+)' \(([\w.-]+)\) [^\n]*? is incompatible with [^\n]*?'([^']+)' \(([\w.-]+)\)/g;
  while ((m = incompat.exec(text))) {
    const files = [...findByModId(list, m[2]), ...findByModId(list, m[4])].map((x) => x.path);
    add(`incompat:${m[2]}:${m[4]}`, { severity: 'crit', type: 'incompatible', title: `${m[1]} 与 ${m[3]} 不兼容`, detail: '加载器报告这两个 Mod 不能同时使用', files, fix: { kind: 'choose', files } });
  }
  const remove = /- Remove mod '([^']+)' \(([\w.-]+)\)/g;
  while ((m = remove.exec(text))) {
    const files = findByModId(list, m[2]).map((x) => x.path);
    add(`remove:${m[2]}`, { severity: 'crit', type: 'remove', title: `建议移除 ${m[1]}`, detail: '加载器给出的解决方案', files, fix: { kind: 'disable', files } });
  }

  // 重复
  const dup = /Mod ID: '([\w.-]+)' from mod files: ([^\n]+)/g;
  while ((m = dup.exec(text))) {
    const files = findByModId(list, m[1]).map((x) => x.path);
    add(`dup:${m[1]}`, { severity: 'crit', type: 'duplicate', title: `重复的 Mod：${m[1]}`, detail: m[2].trim(), files, fix: { kind: 'disable', files: files.slice(1) } });
  }
  if (/DuplicateModsFoundException|Found duplicate mods|Duplicate mods found/.test(text) && !issues.some((i) => i.type === 'duplicate')) {
    add('dup', { severity: 'crit', type: 'duplicate', title: '存在重复的 Mod', detail: '请在 Mod 列表中删除重复的文件' });
  }

  // 加载失败 / Mixin / 可疑 Mod
  const suspects = new Map();
  const suspect = (id, why) => { const k = String(id).toLowerCase(); if (['minecraft', 'java', 'fabricloader', 'forge', 'neoforge', 'mixin', 'mixins'].includes(k)) return; if (!suspects.has(k)) suspects.set(k, why); };
  const failRes = [
    /ModLoadingException: (.+?) \(([\w.-]+)\) has failed to load correctly/g,
    /Failure message: (.+?) \(([\w.-]+)\) (?:has failed|encountered)/g,
    /Mixin apply for mod ([\w.-]+) failed/g,
    /Mixin \[([\w.-]+?)\.mixins\.json[^\]]*\][^\n]*FAILED/g,
    /from mod ([\w.-]+)/g,
  ];
  while ((m = failRes[0].exec(text))) suspect(m[2], `${m[1]} 加载失败`);
  while ((m = failRes[1].exec(text))) suspect(m[2], `${m[1]} 加载失败`);
  while ((m = failRes[2].exec(text))) suspect(m[1], 'Mixin 注入失败');
  while ((m = failRes[3].exec(text))) suspect(m[1], 'Mixin 注入失败');
  while ((m = failRes[4].exec(text))) suspect(m[1], '崩溃堆栈中出现了该 Mod');
  const sus = text.match(/Suspected Mods?:([\s\S]{0,600}?)(?:\n\s*\n|\nStacktrace|\n--)/);
  if (sus) {
    const re = /([^\n\t]+?) \(([\w.-]+)\)/g;
    let s;
    while ((s = re.exec(sus[1]))) suspect(s[2], '崩溃报告中的可疑 Mod');
  }
  for (const [id, why] of suspects) {
    const files = findByModId(list, id);
    if (!files.length) continue;
    add(`suspect:${id}`, { severity: 'warn', type: 'suspect', title: `可疑 Mod：${nm(modLabel(files[0]))}`, detail: why, files: files.map((x) => x.path), fix: { kind: 'disable', files: files.map((x) => x.path) } });
  }

  // 通用原因（已经认出具体是哪些 Mod 不兼容时，不再加笼统的「Mod 不兼容」，1.5.10）
  const specific = issues.some((i) => ['dep-version', 'missing-dep', 'incompatible', 'remove', 'breaks'].includes(i.type));
  for (const [re, msg] of launcher.CRASH_RULES) {
    if (javaNeed && msg.startsWith('Java 版本过低')) continue;
    if (specific && msg.startsWith('Mod 不兼容')) continue;
    if (re.test(text)) add(`rule:${msg}`, { severity: 'warn', type: 'general', title: msg.split('：')[0], detail: msg });
    if (issues.length > 12) break;
  }
  return issues;
}

module.exports = { analyzeLog, findByModId };
