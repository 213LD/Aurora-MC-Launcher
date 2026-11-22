'use strict';
/**
 * 一键修复页：列出全部配置和上次游玩的情况，选一个做全面检测。
 * 全面检测 = 运行环境（Java、内存、磁盘）+ Mod 兼容性（troubleshoot.staticCheck）+ 真的测试启动一次（ipc 里调 troubleshoot:test）。
 * 一键 Debug 是其中「自动修 Mod 问题」这一支，原来的入口都保留。
 */
const fsp = require('fs/promises');
const path = require('path');
const config = require('../engine/config');
const versions = require('./versions');
const profiles = require('./profiles');
const javacheck = require('./javacheck');
const troubleshoot = require('./troubleshoot');
const launcher = require('./launcher');
const hardware = require('./hardware');
const integrity = require('./integrity');
const infer = require('./infer');
const { totalMemMB } = require('../engine/util');
const { nm } = require('../../shared/i18n');

/** 游戏自己的 crash-reports 里最新一份的时间（玩家在别的启动器里玩崩的也算） */
async function newestCrashReport(gameDir) {
  try {
    const dir = path.join(gameDir, 'crash-reports');
    let best = null;
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith('.txt')) continue;
      const st = await fsp.stat(path.join(dir, f));
      if (!best || st.mtimeMs > best.at) best = { at: st.mtimeMs, file: path.join(dir, f) };
    }
    return best;
  } catch { return null; }
}

/**
 * 每个配置上次游玩的情况。recommend：上次正式游玩崩溃了、或者 crash-reports 里有比上次正常启动更新的崩溃报告，
 * 而且之后没有通过的检测 / 一键 Debug
 */
async function overview() {
  const list = await profiles.list();
  const out = [];
  for (const v of list) {
    const meta = await profiles.readMeta(v.id);
    const h = meta.history || {};
    const play = (h.launches || []).find((l) => !l.test) || null;
    const lastOkFix = (h.troubleshoot || []).find((x) => x.ok) || null;
    const report = await newestCrashReport(versions.gameDirFor(v.id, v));
    const lastCrash = (h.crashes || [])[0] || null;
    let crashAt = 0;
    let reason = '';
    if (play && play.crashed) { crashAt = play.at; reason = (lastCrash && lastCrash.reasons && lastCrash.reasons[0]) || `退出代码 ${play.exitCode}`; }
    if (report && report.at > crashAt && (!play || report.at > play.at)) { crashAt = report.at; reason = reason || '游戏留下了崩溃报告'; }
    const fixedAfter = lastOkFix && lastOkFix.at > crashAt;
    out.push({
      id: v.id,
      lastPlayed: v.lastPlayed,
      launchCount: v.launchCount,
      crashCount: v.crashCount,
      lastPlay: play ? { at: play.at, crashed: !!play.crashed, exitCode: play.exitCode } : null,
      crashAt, reason,
      lastCheck: (h.troubleshoot || [])[0] || null,
      recommend: !!crashAt && !fixedAfter,
    });
  }
  return out;
}

/** 运行环境检查：Java、内存、磁盘。问题的格式和 staticCheck 一样：{ severity, type, title, detail, fix } */
async function envCheck(id) {
  const info = await versions.versionInfo(id);
  if (!info) throw new Error(`找不到配置 ${nm(id)}`);
  const items = [];

  // Java
  try {
    const s = await javacheck.status(id);
    const cur = s.java ? `Java ${s.java.major}` : '';
    if (s.problem === 'none') items.push({ severity: 'crit', type: 'java-none', area: 'java', title: `没有能运行这个版本的 Java（需要 Java ${s.req.major}）`, detail: '下载推荐的 Java 后就能启动', fix: { kind: 'java-install', component: s.component, major: s.req.major, label: `下载 Java ${s.req.major}` } });
    else if (s.problem === 'missing') items.push({ severity: 'crit', type: 'java-missing', area: 'java', title: '指定的 Java 已经不存在了', detail: s.path || '', fix: { kind: 'java-auto', label: '改成自动选择' } });
    else if (s.problem === 'tooOld') items.push({ severity: 'crit', type: 'java-old', area: 'java', title: `指定的 ${cur} 太旧，这个版本需要 Java ${s.req.major}`, detail: s.from === 'profile' ? '这个配置单独指定了 Java' : '设置里全局指定了 Java', fix: { kind: 'java-auto', label: '改成自动选择' } });
    else if (s.problem === 'tooNew') items.push({ severity: 'warn', type: 'java-new', area: 'java', title: `指定的 ${cur} 对这个老版本来说太新`, detail: `Minecraft ${nm(info.mcVersion)} 用 Java 8 最稳`, fix: { kind: 'java-auto', label: '改成自动选择' } });
    else items.push({ severity: 'ok', area: 'java', title: `Java 合适：${cur || '自动选择'}${s.from === 'auto' ? '（自动选择）' : ''}` });
    // 比启动器认识的更新的 Java，按版本号规律判断（Java 主版本号越大越新）
    const newest = Math.max(s.req.major || 0, (s.java && s.java.major) || 0);
    if (newest > infer.KNOWN.java) {
      const last = items[items.length - 1];
      last.conf = 'inferred';
      last.detail = `${last.detail ? `${last.detail}；` : ''}Java ${newest} 比这个启动器认识的最新版（Java ${infer.KNOWN.java}）还新，是按版本号规律判断的`;
    }
  } catch (e) { items.push({ severity: 'warn', area: 'java', title: '没能检查 Java', detail: e.message }); }

  // 比启动器认识的更新的 Minecraft、认不出的 Mod 加载器
  if (infer.cmpMc(info.mcVersion, infer.KNOWN.mc) > 0) {
    items.push({ severity: 'info', type: 'mc-newer', area: 'future', conf: 'inferred', title: `Minecraft ${nm(info.mcVersion)} 比这个启动器认识的版本（${infer.KNOWN.mc}）还新`, detail: '需要的 Java、文件结构等按以往的规律推算；如果检测结果和实际不符，以游戏实际表现为准' });
  }
  if (!info.loader) {
    const odd = infer.unknownLoader(await versions.readVersionJson(id).catch(() => null));
    if (odd) {
      items.push({
        severity: 'warn', type: 'loader-unknown', area: 'future', conf: 'unknown',
        title: '认不出这个配置用的 Mod 加载器',
        detail: `看起来是「${nm(odd.name)}」。Mod 兼容性检查和一键 Debug 只认识 Fabric、Forge、NeoForge、Quilt 等已知的加载器，这个配置的 Mod 问题需要你自己排查（可以先看看日志）`,
      });
    }
  }

  // 内存：分配超过电脑内存的 75% 会拖慢系统甚至启动失败；有 Mod 却只给不到 2GB 容易卡顿和崩溃
  const total = totalMemMB();
  const mem = launcher.memoryFor(id, info);
  const vs = config.getVersionSettings(id);
  const modded = !!info.loader;
  const gb = (mb) => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;
  if (mem.max > total * 0.75) items.push({ severity: 'crit', type: 'mem-high', area: 'memory', title: `分配的内存（${gb(mem.max)}）太多了`, detail: `电脑一共 ${gb(total)}，给游戏太多会让系统和游戏都变卡，甚至启动失败`, fix: { kind: 'mem-auto', label: '改成自动分配' } });
  else if (modded && mem.max < 2048 && total >= 4096) items.push({ severity: 'warn', type: 'mem-low', area: 'memory', title: `分配的内存（${gb(mem.max)}）偏少`, detail: '装了 Mod 的配置建议至少 2–4 GB，太少容易卡顿或内存不足崩溃', fix: { kind: 'mem-auto', label: '改成自动分配' } });
  else items.push({ severity: 'ok', area: 'memory', title: `内存分配合适：${gb(mem.max)}${vs.memoryMode === 'custom' ? '' : '（自动）'}`, detail: `电脑共 ${gb(total)}` });

  // 磁盘：游戏目录所在的盘剩余空间
  try {
    const st = await fsp.statfs(versions.gameDirFor(id, info));
    const free = (st.bavail * st.bsize) / 1048576;
    if (free < 1024) items.push({ severity: 'warn', type: 'disk-low', area: 'disk', title: `游戏所在的磁盘只剩 ${gb(free)}`, detail: '空间不够时存档和日志可能写不进去，建议清理到 2 GB 以上' });
    else items.push({ severity: 'ok', area: 'disk', title: `磁盘空间充足：剩余 ${gb(free)}` });
  } catch { /* 拿不到就不显示 */ }

  // 硬件与显卡：驱动、老显卡、双显卡、按画质和 Mod 数量估算负载
  let modCount = 0;
  if (info.loader) {
    try { modCount = (await require('./mods').listMods(id)).mods.filter((m) => m.enabled).length; } catch { /* 拿不到按 0 算 */ }
  }
  try { items.push(...await hardware.check({ gameDir: versions.gameDirFor(id, info), mc: info.mcVersion, modCount })); } catch (e) { items.push({ severity: 'warn', area: 'hardware', title: '没能检查硬件', detail: e.message }); }

  // 文件完整性、设置与按键
  try { items.push(...await integrity.check(id)); } catch (e) { items.push({ severity: 'warn', area: 'files', title: '没能检查文件', detail: e.message }); }

  // Mod 兼容性
  if (info.loader) {
    try {
      const sc = await troubleshoot.staticCheck(id);
      for (const i of sc.issues) items.push({ ...i, area: 'mods' });
      if (!sc.issues.length) items.push({ severity: 'ok', area: 'mods', title: `Mod 兼容性检查通过（${sc.count} 个 Mod）` });
    } catch (e) { items.push({ severity: 'warn', area: 'mods', title: '没能检查 Mod', detail: e.message }); }
  }
  // 哪些是推算的、哪些认不出，认不出的自动修复不进「全部修复」
  const inferred = items.filter((i) => i.conf === 'inferred');
  const unknown = items.filter((i) => i.conf === 'unknown');
  for (const i of unknown) if (i.fix) i.fix.auto = false;
  if (inferred.length || unknown.length) {
    items.push({
      severity: 'info', type: 'conf-summary', area: 'future',
      title: unknown.length ? `有 ${unknown.length} 项检测认不出这台电脑或这个配置的情况` : `有 ${inferred.length} 项是按规律推算的`,
      detail: [
        inferred.length ? `推算的：${inferred.map((i) => i.title).join('；')}` : '',
        unknown.length ? `认不出的：${unknown.map((i) => i.title).join('；')}。${unknown.some((i) => i.fix)
          ? '这些项目的自动修复可能修不好，甚至带来新问题，所以不放进「全部修复」，确认后自己点'
          : '这些项目的检测结果只是估计，以游戏实际表现为准'}` : '',
      ].filter(Boolean).join('。'),
    });
  }
  return { items, mc: info.mcVersion, loader: info.loader ? info.loader.type : null };
}

/** 修运行环境的问题（Mod 问题交给 modkit / 一键 Debug）。返回撤销用的旧值 */
async function fixEnv(id, fix) {
  if (['gfx-lower', 'unbind-keys', 'quarantine'].includes(fix.kind)) {
    const info = await versions.versionInfo(id);
    const gameDir = versions.gameDirFor(id, info);
    if (fix.kind === 'gfx-lower') return { options: await hardware.lowerGraphics(gameDir, fix) };
    if (fix.kind === 'unbind-keys') return { keys: await integrity.unbindConflicts(gameDir) };
    return { moved: await integrity.quarantine(gameDir, fix.files || []) };
  }
  const before = config.getVersionSettings(id);
  if (fix.kind === 'java-auto') config.setVersionSettings(id, { java: 'auto' });
  else if (fix.kind === 'mem-auto') config.setVersionSettings(id, { memoryMode: 'auto' });
  else throw new Error(`不支持的修复：${fix.kind}`);
  return { java: before.java || null, memoryMode: before.memoryMode || null, memoryMax: before.memoryMax || null };
}

async function undoEnv(id, before) {
  if (before.options || before.keys || before.moved) {
    const info = await versions.versionInfo(id);
    const gameDir = versions.gameDirFor(id, info);
    if (before.options) await hardware.restoreOptions(gameDir, before.options);
    if (before.keys) await integrity.restoreKeys(gameDir, before.keys);
    if (before.moved) await integrity.unquarantine(before.moved);
    return;
  }
  config.setVersionSettings(id, { java: before.java || undefined, memoryMode: before.memoryMode || undefined, memoryMax: before.memoryMax || undefined });
}

module.exports = { overview, envCheck, fixEnv, undoEnv };
