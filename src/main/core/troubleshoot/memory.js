'use strict';
/**
 * 一键 Debug / 测试启动记住玩家回答过的画面（1.4.5 留下的「以后」，rc1 之前做完）。
 * 认不出的游戏画面会问玩家「是主菜单」还是「被提示挡住了」。以前不记，同一个画面（比如 Mod 每次都弹的欢迎页）每次排查都要再答一遍。
 * 现在按画面上识别出的文字记在这个配置的资料里（profile 的 screenAnswers），下次文字对得上（识别有零星错字，按 screens.same 比）就照上次的回答处理，不再问。
 * 「我去游戏里处理好了」不记：处理过的提示一般下次不会再出现。每次用到记忆，结果里都会说明，给「重新问我」（forget）
 */
const profiles = require('../profiles');
const screens = require('../screens');

const MAX = 20;
const clip = (s, n) => String(s || '').slice(0, n);

/** 这个配置里记过这个画面吗：返回 { answer: 'menu' | 'prompt', typed, at } 或 null */
async function find(versionId, screen) {
  if (!screen || !screen.text) return null;
  const meta = await profiles.readMeta(versionId).catch(() => null);
  const list = (meta && Array.isArray(meta.screenAnswers)) ? meta.screenAnswers : [];
  return list.find((x) => x && typeof x.text === 'string' && (x.answer === 'menu' || x.answer === 'prompt') && screens.same(x.text, screen.text)) || null;
}

/** 记下玩家的回答（同一个画面以前记过就换成这次的） */
async function remember(versionId, screen, answer) {
  if (!screen || !screen.text || !answer || (answer.answer !== 'menu' && answer.answer !== 'prompt') || answer.handled) return null;
  const entry = { text: clip(screen.text, 2000), answer: answer.answer, typed: clip(answer.text, 2000), at: Date.now() };
  await profiles.updateMeta(versionId, (cur) => {
    const old = Array.isArray(cur.screenAnswers) ? cur.screenAnswers.filter((x) => x && typeof x.text === 'string' && !screens.same(x.text, entry.text)) : [];
    return { screenAnswers: [entry, ...old].slice(0, MAX) };
  });
  return entry;
}

/** 忘掉一条（at 是记下时的时间）；不给 at 就全忘掉。返回还剩几条 */
async function forget(versionId, at) {
  let left = 0;
  await profiles.updateMeta(versionId, (cur) => {
    const list = Array.isArray(cur.screenAnswers) ? cur.screenAnswers : [];
    const next = at == null ? [] : list.filter((x) => x && x.at !== at);
    left = next.length;
    return { screenAnswers: next };
  });
  return left;
}

module.exports = { find, remember, forget, MAX };
