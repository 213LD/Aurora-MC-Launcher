'use strict';
/** IPC：测试启动、一键 Debug、二分排查、一键修复 */

const config = require('../engine/config');
const tasks = require('../engine/tasks');
const versions = require('../core/versions');
const screens = require('../core/screens');
const launcher = require('../core/launcher');
const mods = require('../core/mods');
const profiles = require('../core/profiles');
const troubleshoot = require('../core/troubleshoot');
const repair = require('../core/repair');
const backup = require('../core/backup');
const { t } = require('../../shared/i18n');
const { handle, send } = require('./bus');

function register() {
  // 测试启动认不出画面时请玩家确认：游戏先开着，发 troubleshoot:ask 给界面，等 troubleshoot:answer；3 分钟没回答按自动判断
  const pendingAsks = new Map();
  const askUser = (payload) => new Promise((resolve) => {
    const askId = `ask${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const { signal, ...rest } = payload;
    const done = (ans) => { clearTimeout(timer); pendingAsks.delete(askId); if (signal) signal.removeEventListener('abort', onAbort); send('troubleshoot:askClosed', { askId }); resolve(ans); };
    const onAbort = () => done(null);
    let timer = setTimeout(() => done(null), 180000);
    done.hold = () => { clearTimeout(timer); timer = setTimeout(() => done(null), 600000); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pendingAsks.set(askId, done);
    send('troubleshoot:ask', { askId, ...rest });
  });
  handle('troubleshoot:answer', (askId, ans) => { const f = pendingAsks.get(askId); if (f) f(ans || null); return !!f; });
  // 记住的画面回答说错了：忘掉这一条（at），不给 at 就全忘掉；下次测试会再问（2026-11-07）
  handle('troubleshoot:forgetScreen', async (id, at) => {
    if (typeof id !== 'string' || (at != null && typeof at !== 'number')) throw new Error('参数不对');
    if (!(await versions.versionInfo(id).catch(() => null))) throw new Error('配置不存在'); // 不给不存在的配置建资料文件
    return require('../core/troubleshoot/memory').forget(id, at);
  });
  // 玩家去游戏里处理提示：把等待时间延长到 10 分钟（1.4.7）
  handle('troubleshoot:askHold', (askId) => { const f = pendingAsks.get(askId); if (f && f.hold) f.hold(); return !!f; });
  handle('troubleshoot:tweak', async (id, tweak) => {
    const r = await screens.applyTweak(versions.gameDirFor(id, await versions.versionInfo(id)), tweak, true);
    return r.label;
  });
  handle('troubleshoot:debug', async (id) => {
    let r;
    try {
      r = await tasks.run({ title: `${t('term.debug')} ${id}`, kind: 'test', meta: { name: id }, doneText: (x) => (x.ok ? '修复完成' : x.interrupted ? '测试被中断' : '未能完全修复') }, async (task) => {
        const b = await backup.auto(id, 'debug', task);
        if (b.error) send('notify', { level: 'warn', title: `${t('term.debug')}前备份 Mod 失败`, text: `${b.error}。继续排查` });
        return troubleshoot.autoDebug(id, task, (s) => send('debug:step', { versionId: id, ...s }), { ask: askUser });
      });
    } catch (e) { send('mods:changed', id); throw e; }
    const verdict = r.warn ? '能进游戏，但有提示' : r.ok ? '已可以正常启动' : r.interrupted ? '测试被中断' : '未能完全修复';
    send('mods:changed', id);
    send('versions:changed');
    await profiles.recordTroubleshoot(id, {
      kind: 'debug', ok: r.ok,
      summary: `${t('term.debug')}：${verdict}，改动 ${r.changes.length} 处${r.unresolved.length ? `，未找到 ${r.unresolved.join('、')}` : ''}`,
      changes: r.changes.map((c) => ({ type: c.type, name: c.file || c.title, why: c.why })),
    }).catch(() => {});
    return r;
  });
  handle('troubleshoot:undo', async (id, changes) => { const n = await troubleshoot.undoDebug(id, changes); send('mods:changed', id); send('versions:changed'); return n; });
  // ── 兼容性排查 ──
  handle('troubleshoot:test', async (id) => {
    const r = await tasks.run({ title: `${t('term.test')} ${id}`, kind: 'test', meta: { name: id }, doneText: (x) => (x.warn ? t('test.passWarn') : x.ok ? '测试通过' : x.reason === 'interrupted' ? '测试被中断' : '发现问题') }, (task) => troubleshoot.testLaunch(id, task, { ask: askUser }));
    await profiles.recordTroubleshoot(id, {
      kind: 'test', ok: r.ok, reason: r.reason, duration: r.duration,
      summary: r.warn ? `测试启动通过，但有提示：${r.notices.find((n) => n.severity === 'warn').title}` : r.ok ? `测试启动通过（${Math.round(r.duration / 1000)} 秒）` : r.reason === 'interrupted' ? t('test.interrupted') : `测试启动失败：${(r.issues[0] && r.issues[0].title) || r.reason}`,
      issues: r.issues.slice(0, 8).map((i) => ({ severity: i.severity, title: i.title })),
    }).catch(() => {});
    return r;
  });
  // 临时用 Java N 再测一次：不改配置；通过后界面问要不要以后都用它（troubleshoot:useJava）
  handle('troubleshoot:javaRetest', async (id, major) => {
    const r = await tasks.run({ title: `${t('java.retestTitle', { n: major })} ${id}`, kind: 'test', meta: { name: id }, doneText: (x) => (x.warn ? t('java.retestWarn', { n: major }) : x.ok ? t('java.retestOk', { n: major }) : x.reason === 'interrupted' ? '测试被中断' : t('java.retestFail', { n: major })) }, (task) => troubleshoot.javaRetest(id, Number(major), task, { ask: askUser }));
    await profiles.recordTroubleshoot(id, {
      kind: 'test', ok: r.ok, reason: r.reason, duration: r.duration,
      summary: `${t('java.retestTitle', { n: major })}：${r.ok ? `通过（${Math.round(r.duration / 1000)} 秒）` : (r.issues[0] && r.issues[0].title) || r.reason}`,
      issues: r.issues.slice(0, 8).map((i) => ({ severity: i.severity, title: i.title })),
    }).catch(() => {});
    return r;
  });
  handle('troubleshoot:useJava', (id, javaPath) => { config.setVersionSettings(id, { java: javaPath }); send('versions:changed'); return true; });
  handle('troubleshoot:bisect', async (id) => {
    let r;
    try {
      r = await tasks.run({ title: `${t('term.bisect')} ${id}`, kind: 'test', meta: { name: id }, doneText: '排查完成' }, (task) => troubleshoot.bisect(id, task, (round) => send('troubleshoot:round', { versionId: id, ...round })));
    } catch (e) { send('mods:changed', id); throw e; }
    send('mods:changed', id);
    const names = (r.culprits || []).map((c) => c.name).join('、');
    await profiles.recordTroubleshoot(id, {
      kind: 'bisect', ok: r.status === 'found' || r.status === 'no-crash', rounds: r.rounds.length,
      summary: { found: `二分排查找到问题 Mod：${names}`, inconclusive: `二分排查：最可疑的是 ${names}`, 'not-in-mods': '二分排查：问题不在普通 Mod 中', 'no-crash': '二分排查：配置可以正常启动' }[r.status] || r.status,
    }).catch(() => {});
    return r;
  });
  // ── 一键修复页 ──
  handle('repair:overview', () => repair.overview());
  handle('repair:env', (id) => repair.envCheck(id));
  handle('repair:fix', async (id, fix) => { const r = await repair.fixEnv(id, fix); send('versions:changed'); return r; });
  handle('repair:undo', async (id, before) => { await repair.undoEnv(id, before); send('versions:changed'); return true; });
  handle('troubleshoot:analyze', async (versionId, gameId) => {
    const g = launcher.getGame(gameId);
    if (!g) return [];
    const { mods: list } = await mods.listMods(versionId).catch(() => ({ mods: [] }));
    return troubleshoot.analyzeLog(`${g.lines.map((l) => l.text).join('\n')}\n${(g.crash && g.crash.report) || ''}`, list.filter((m) => m.enabled));
  });
}

module.exports = register;
