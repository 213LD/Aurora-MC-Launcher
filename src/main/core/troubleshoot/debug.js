'use strict';
/** 一键 Debug：静态检查并自动修复 → 测试启动并按日志修复 → 仍然失败时二分排查 */
const versions = require('../versions');
const mods = require('../mods');
const screens = require('../screens');
const javaMgr = require('../java');
const path = require('path');
const fsp = require('fs').promises;
const { abortError } = require('../../engine/util');
const { t, nm } = require('../../../shared/i18n');
const { staticCheck } = require('./static');
const { installDep } = require('./deps');
const { interruptedError, testLaunch } = require('./test');
const { bisect } = require('./bisect');


/**
 * 一键 Debug：静态检查并自动修复 → 测试启动并按日志修复 → 仍然失败时二分排查
 * 所有改动都会记录下来，可以一键撤销。
 * 冲突时优先禁用“最近加入”的 Mod（通常就是玩家后来自行添加、引发问题的那个）。
 */
async function autoDebug(versionId, task, onStep = () => {}, { ask = null } = {}) {
  const changes = [];
  const unresolved = [];
  const steps = [];
  const step = (s) => { steps.push({ at: Date.now(), ...s }); onStep(s); task.update({ detail: s.text }); };

  const disable = async (files, why) => {
    for (const f of files || []) {
      if (!f || f.endsWith('.disabled')) continue;
      try { await fsp.access(f); } catch { continue; }
      const to = await mods.toggleMod(f, false);
      changes.push({ type: 'disable', file: path.basename(f), path: to, why });
      step({ phase: 'fix', text: `禁用 ${path.basename(f)}：${why}` });
    }
  };
  const newest = (files, list) => {
    const byPath = new Map(list.map((m) => [m.path, m]));
    return [...files].sort((a, b) => ((byPath.get(b) || {}).mtime || 0) - ((byPath.get(a) || {}).mtime || 0))[0];
  };
  const install = async (modId, why, opts) => {
    try {
      const r = await installDep(versionId, modId, task, opts);
      changes.push({ type: 'install', title: nm(r.title), files: r.files, why });
      for (const d of r.disabled) changes.push({ type: 'disable', file: d.file, path: d.to, why: `换成 ${nm(r.title)} ${nm(r.version)}` });
      step({ phase: 'fix', text: r.disabled.length ? `${r.title} 换成 ${nm(r.version)}（${why}）` : `安装前置 ${r.title}（${why}）` });
      return true;
    } catch (e) {
      if (e.cancelled) throw e;
      if (!unresolved.includes(modId)) unresolved.push(modId);
      step({ phase: 'warn', text: `无法自动安装 ${modId}：${e.message}` });
      return false;
    }
  };

  // ① 静态检查与修复
  step({ phase: 'static', text: '分析 Mod 元数据（前置、加载器、版本、冲突声明）…' });
  for (let pass = 0; pass < 3; pass++) {
    const { mods: list } = await mods.listMods(versionId);
    const sc = await staticCheck(versionId);
    let did = false;
    for (const i of sc.issues) {
      if (task.signal.aborted) throw abortError();
      if (i.type === 'missing-dep' && !unresolved.includes(i.modId)) did = (await install(i.modId, i.detail)) || did;
      else if (i.type === 'dep-version' && i.modId && !unresolved.includes(i.modId)) did = (await install(i.modId, i.detail, { ranges: i.ranges, rangeKind: i.rangeKind, update: true })) || did;
      else if ((i.type === 'duplicate' || i.type === 'loader' || i.type === 'mc-version') && i.fix && i.fix.files && i.fix.files.length) {
        await disable(i.fix.files, i.title);
        did = true;
      } else if ((i.type === 'breaks' || i.type === 'known') && i.files && i.files.length > 1) {
        await disable([newest(i.files, list)], `${i.title}（保留较早安装的那个）`);
        did = true;
      }
    }
    if (!did) break;
  }
  const after = await staticCheck(versionId);
  if (!after.issues.some((i) => i.type === 'java-version')) step({ phase: 'static', text: after.issues.some((i) => i.severity === 'crit') ? `兼容性检查仍有 ${after.issues.filter((i) => i.severity === 'crit').length} 个问题，继续测试启动` : '兼容性检查通过' });

  let ok = false;
  let last = null;
  let bisectResult = null;
  let interrupted = false;
  let javaNeed = null;
  try {
    // 兼容性检查已经看出要更高版本的 Java：测试启动注定崩溃，直接给「用 Java N 再测一次」
    const sj = after.issues.find((i) => i.type === 'java-version');
    if (sj) { javaNeed = sj; step({ phase: 'fail', text: t('java.stepNeed', { n: sj.javaMajor, cur: sj.javaCur || '?' }) }); }
    // ② 测试启动，根据日志修复
    for (let round = 1; round <= 3 && !ok && !javaNeed; round++) {
      step({ phase: 'test', text: `第 ${round} 次测试启动…` });
      last = await testLaunch(versionId, task, { ask });
      if (last.reason === 'interrupted') throw interruptedError();
      ok = last.ok;
      if (ok) {
        // 通过但有提示：加载不了的文件（加载器警告画面上的）自动禁用后再测一次，其余的列给玩家
        const warns = last.notices.filter((n) => n.severity === 'warn');
        step(warns.length ? { phase: 'warn', text: t('notice.stepWarn', { n: warns.length, title: warns[0].title }) } : { phase: 'ok', text: `测试启动通过（${Math.round(last.duration / 1000)} 秒进入主菜单）` });
        // 能自动处理的：加载不了的文件禁用；认识的提示要补的 Mod（比如 Indium）去装
        const tweaked = new Set(changes.filter((c) => c.type === 'tweak').map((c) => c.tweak));
        const autoFix = last.notices.filter((n) => (n.auto && n.files && n.files.length) || (n.autoInstall && !unresolved.includes(n.autoInstall)) || (n.autoTweak && !tweaked.has(n.autoTweak)));
        if (autoFix.length && round < 3) {
          let did = false;
          for (const n of autoFix) {
            if (n.autoInstall) did = (await install(n.autoInstall, n.title)) || did;
            else if (n.autoTweak) {
              // 关掉 Mod 的提示画面（改它自己的配置开关，可以撤销）
              const info = await versions.versionInfo(versionId);
              const r = await screens.applyTweak(versions.gameDirFor(versionId, info), n.autoTweak, true);
              changes.push({ type: 'tweak', tweak: n.autoTweak, title: r.label, why: n.title });
              step({ phase: 'fix', text: `${r.label}（${n.title}）` });
              did = true;
            } else { await disable(n.files, n.title); did = true; }
          }
          if (did) { ok = false; continue; }
        }
        break;
      }
      step({ phase: 'fail', text: `测试启动失败：${(last.issues[0] && last.issues[0].title) || last.reason}` });
      // Java 版本不够：换 Mod 解决不了，二分排查只会把需要新 Java 的 Mod 当成「问题 Mod」禁用掉
      const jv = last.issues.find((i) => i.type === 'java-version');
      if (jv) { javaNeed = jv; step({ phase: 'fail', text: t('java.stepNeed', { n: jv.javaMajor, cur: jv.javaCur || '?' }) }); break; }
      const { mods: list } = await mods.listMods(versionId);
      let did = false;
      for (const i of last.issues) {
        if (i.type === 'missing-dep' && i.modId && !unresolved.includes(i.modId)) did = (await install(i.modId, i.title)) || did;
        else if (i.type === 'dep-version' && i.modId && !unresolved.includes(i.modId)) did = (await install(i.modId, i.title, { ranges: i.ranges, update: true })) || did;
        else if ((i.type === 'remove' || i.type === 'duplicate') && i.files && i.files.length) { await disable(i.type === 'duplicate' ? i.files.slice(1) : i.files, i.title); did = true; }
        else if (i.type === 'incompatible' && i.files && i.files.length > 1) { await disable([newest(i.files, list)], `${i.title}（保留较早安装的那个）`); did = true; }
      }
      if (!did) break;
    }

    // ③ 二分排查
    if (!ok && !javaNeed) {
      step({ phase: 'bisect', text: '日志中没有可以自动修复的问题，开始二分排查…' });
      bisectResult = await bisect(versionId, task, (r) => { if (r.done) step({ phase: 'bisect', text: `第 ${r.round} 轮：${r.label} → ${r.ok ? '正常' : '崩溃'}` }); });
      if (bisectResult.status === 'found' || bisectResult.status === 'inconclusive') {
        await disable((bisectResult.culprits || []).map((c) => c.path), '二分排查定位到的问题 Mod');
        step({ phase: 'test', text: '禁用问题 Mod 后再次测试…' });
        last = await testLaunch(versionId, task, { ask });
        if (last.reason === 'interrupted') throw interruptedError();
        ok = last.ok;
        step({ phase: ok ? 'ok' : 'fail', text: ok ? '修复成功，游戏可以正常进入主菜单' : '仍然无法启动，可能是前置库、配置文件或 Java 的问题' });
      } else if (bisectResult.status === 'no-crash') {
        ok = true;
        step({ phase: 'ok', text: '再次测试时可以正常启动（之前的失败可能是偶发的）' });
      } else {
        step({ phase: 'fail', text: bisectResult.note || '问题不在普通 Mod 中' });
      }
    }
  } catch (e) {
    if (!e.reason || e.reason.code !== 'TEST_INTERRUPTED') throw e;
    interrupted = true;
    ok = false;
    last = null;
    step({ phase: 'warn', text: t('test.interrupted') });
  }

  return {
    ok,
    interrupted,
    changes,
    unresolved,
    steps,
    lastIssues: last && !last.ok ? last.issues.slice(0, 8) : javaNeed ? [javaNeed] : [],
    javaNeed: javaNeed ? javaNeed.javaMajor : 0,
    // 通过了但还有提示：整理好的提示和画面截图，界面显示「通过但有提示」
    warn: !!(ok && last && last.warn),
    notices: ok && last ? last.notices : [],
    screen: ok && last ? last.screen : null,
    gameId: last ? last.gameId : null,
    bisect: bisectResult ? { status: bisectResult.status, culprits: bisectResult.culprits || [], rounds: bisectResult.rounds.length } : null,
  };
}

/**
 * 临时用 Java N 测试启动一次：不改配置，没装就先下载。结果和 testLaunch 一样，多了 java（这次用的 Java）
 */
async function javaRetest(versionId, major, task, { ask = null } = {}) {
  task.update({ detail: t('java.preparing', { n: major }), progress: -1 });
  const { java, downloaded } = await javaMgr.forMajor(major, task);
  task.update({ detail: t('java.using', { java: `Java ${java.version}` }) });
  const r = await testLaunch(versionId, task, { ask, java });
  return { ...r, java: { major: java.major, version: java.version, path: java.path, downloaded } };
}

/** 撤销一键 Debug 做出的改动 */
async function undoDebug(versionId, changes) {
  let n = 0;
  for (const c of [...(changes || [])].reverse()) {
    try {
      if (c.type === 'disable' && c.path) { await mods.toggleMod(c.path, true); n++; }
      if (c.type === 'tweak') { const info = await versions.versionInfo(versionId); await screens.applyTweak(versions.gameDirFor(versionId, info), c.tweak, false); n++; }
      if (c.type === 'install') {
        const { dir } = await mods.targetDir(versionId, 'mod');
        // 这些文件是一键 Debug 自己装的，回收站不可用时可以直接删除
        for (const f of c.files || []) await mods.removeMod(path.join(dir, f), versionId).catch(() => mods.removeMod(path.join(dir, f), versionId, { permanent: true })).catch(() => {});
        n++;
      }
    } catch { /* 文件可能已被玩家手动处理 */ }
  }
  return n;
}

module.exports = { autoDebug, javaRetest, undoDebug };
