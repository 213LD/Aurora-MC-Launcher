'use strict';
/** 测试启动：自动判断是否成功进入游戏 */
const versions = require('../versions');
const mods = require('../mods');
const launcher = require('../launcher');
const screens = require('../screens');
const memory = require('./memory');
const { abortError } = require('../../engine/util');
const { t } = require('../../../shared/i18n');
const { analyzeLog } = require('./log');

const SURVIVE_MS = 12000; // 进入主菜单后再稳定运行这么久才算通过（界面文案写的是「十几秒」）

/** 玩家在进入主菜单前关掉了测试窗口：一键 Debug 和二分排查遇到它就停下，不把它当成崩溃 */
function interruptedError() {
  const err = new Error(t('test.interrupted'));
  err.reason = { code: 'TEST_INTERRUPTED', message: t('test.interrupted'), hint: t('test.interruptedHint') };
  return err;
}

/**
 * 测试启动一次：成功 / 失败 / 中断（reason 为 'interrupted'）都正常返回，不抛错；
 * 任务的 detail 会实时显示「等待主菜单」和关闭倒计时，配置器和 Debug 对话框都读它
 */
async function testLaunch(versionId, task, { timeout = 240000, look = true, ask = null, java = null } = {}) {
  const started = Date.now();
  let gameId;
  try {
    const g = await launcher.launch(versionId, task, { test: true, java });
    gameId = g.id;
  } catch (e) {
    if (e.cancelled || !e.gameId) throw e;
    gameId = e.gameId;
  }
  const onAbort = () => launcher.kill(gameId);
  task.signal.addEventListener('abort', onAbort, { once: true });
  try {
    task.update({ detail: t('test.waiting'), progress: -1 });
    const onTick = (g) => {
      const detail = g.successAt && !g.failAt ? t('test.menu', { n: Math.max(1, Math.ceil((SURVIVE_MS - (Date.now() - g.successAt)) / 1000)) }) : t('test.waiting');
      if (task.detail !== detail) task.update({ detail });
    };
    const outcome = await launcher.waitOutcome(gameId, { timeout, survive: SURVIVE_MS, signal: task.signal, onTick });
    if (task.signal.aborted) throw abortError();
    // 进入了主菜单：关游戏之前看一眼画面，有没有加载器警告或 Mod 的提示挡在前面
    let screen = null;
    let answer = null;
    let remembered = null;
    if (outcome.ok && look) {
      const g = launcher.getGame(gameId);
      const info = await versions.versionInfo(versionId).catch(() => null);
      screen = await screens.look(g, { mc: info && info.mcVersion, isAlive: () => g.state !== 'exited' && !task.signal.aborted, onLook: () => task.update({ detail: t('test.looking') }) }).catch(() => null);
      if (task.signal.aborted) throw abortError();
      const unknown = !screen || (screen.kind === 'unknown' && !screens.knownScreen(screen));
      // 以前回答过这个画面：照上次的回答处理，不再问（memory.js，2026-11-07）
      remembered = unknown && screen ? await memory.find(versionId, screen).catch(() => null) : null;
      if (remembered) answer = { answer: remembered.answer, text: remembered.typed || '' };
      // 认不出画面（或没截到图）时，游戏先不关，请玩家看一眼确认：是主菜单，还是被提示挡住了
      else if (ask && g.state !== 'exited' && unknown) {
        task.update({ detail: t('test.asking') });
        // log：日志的判断（已经进了主菜单、稳定跑了多久），对话框顶上告诉玩家「游戏其实启动成功了」（1.4.7）
        const log = { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
        answer = await ask({ versionId, image: screen && screen.image, lines: (screen && screen.items) || [], captured: !!screen, log, signal: task.signal }).catch(() => null);
        if (task.signal.aborted) throw abortError();
        // 记下来，下次同一个画面不再问。「我去游戏里处理」不记：处理过的提示一般下次不会再出现
        if (answer && (answer.answer === 'menu' || answer.answer === 'prompt')) await memory.remember(versionId, screen, answer).catch(() => {});
        // 玩家选「我去游戏里处理」并处理好了：游戏一直开着，再看一眼画面，回到主菜单就算通过（Mod 的「看过了」也能存下来）
        if (answer && answer.answer === 'handled' && g.state !== 'exited') {
          task.update({ detail: t('test.relook') });
          const again = await screens.look(g, { mc: info && info.mcVersion, budget: 15000, isAlive: () => g.state !== 'exited' && !task.signal.aborted }).catch(() => null);
          if (task.signal.aborted) throw abortError();
          if (again) screen = again;
          answer = again && again.kind === 'menu' ? { answer: 'menu', handled: true } : { answer: 'prompt', text: answer.text || '' };
        }
      }
    }
    const g0 = launcher.getGame(gameId);
    if (g0 && g0.state !== 'exited') {
      launcher.kill(gameId);
      await launcher.waitExit(gameId, 20000);
    }
    const game = launcher.getGame(gameId);
    const text = game ? game.lines.map((l) => l.text).join('\n') : '';
    let issues = [];
    let notices = [];
    const { mods: list } = await mods.listMods(versionId);
    const enabled = list.filter((m) => m.enabled);
    if (!outcome.ok) {
      const crash = game && game.crash;
      issues = analyzeLog(`${text}\n${(crash && crash.report) || ''}`, enabled);
    } else {
      const fromLog = screens.fromLog(text, enabled);
      notices = [...fromLog, ...screens.fromScreen(screen, enabled, fromLog)];
      // 玩家的回答优先：说是主菜单就去掉画面上的提示；说被挡住了，用玩家抄下来的字（没写就用识别的字）整理成一条提示
      if (answer && answer.answer === 'menu') {
        notices = notices.filter((n) => n.type !== 'screen');
        if (answer.handled) notices.push({ id: 'screen:handled', severity: 'info', type: 'handled', title: t('notice.handled'), detail: t('notice.handledDetail') });
        if (screen) screen = { ...screen, kind: 'menu', confirmed: true };
      } else if (answer && answer.answer === 'prompt') {
        const typed = String(answer.text || '').trim();
        const lines = typed ? typed.split(/\r?\n/).filter(Boolean) : (screen && screen.items) || [];
        const said = screens.fromScreen({ kind: 'unknown', items: lines.length ? lines : [t('notice.userSaw')], text: lines.join('\n') }, enabled, fromLog)
          .map((n) => ({ ...n, severity: n.severity === 'info' ? 'info' : 'warn', confirmed: true, raw: typed ? `${t('notice.userTyped')}\n${typed}` : n.raw }))
          // 没认出是什么提示：说清楚游戏已经启动成功了，再给面向新手的处理办法（1.4.7）
          .map((n) => (n.id === 'screen:unknown' ? { ...n, title: n.title === t('notice.unknownScreen') ? t('notice.blockedTitle') : n.title, detail: `${n.detail}\n${t('notice.blockedGuide')}` } : n));
        notices = [...notices.filter((n) => n.type !== 'screen'), ...said];
        screen = { ...(screen || {}), kind: 'unknown', confirmed: true };
      }
    }
    // 结果分三种：通过 / 通过但有提示（warn）/ 失败。screen.image 是画面截图，没截到时 screen 为 null
    const warn = outcome.ok && notices.some((n) => n.severity === 'warn');
    return { ok: outcome.ok, warn, reason: outcome.reason, exitCode: outcome.exitCode, duration: Date.now() - started, gameId, issues, notices, screen: screen && { kind: screen.kind, image: screen.image, confirmed: !!screen.confirmed, remembered: remembered ? { answer: remembered.answer, at: remembered.at } : null } };
  } finally {
    task.signal.removeEventListener('abort', onAbort);
    // 测试时跳过了原版辅助功能欢迎页：等游戏关掉再改回来（1.5.8）
    const g = launcher.getGame(gameId);
    if (g && g.onboardSkipped) {
      if (g.state !== 'exited') await launcher.waitExit(gameId, 20000).catch(() => {});
      await launcher.restoreOnboard(g.gameDir).catch(() => {});
    }
  }
}

module.exports = { interruptedError, testLaunch };
