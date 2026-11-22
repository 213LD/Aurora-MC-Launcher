'use strict';
/** 二分排查：找出导致崩溃的 Mod */
const mods = require('../mods');
const { sleep, abortError } = require('../../engine/util');
const { BUILTIN, modLabel, section } = require('./compat');
const { buildIndex } = require('./static');
const { interruptedError, testLaunch } = require('./test');
const { nmJoin } = require('../../../shared/i18n');

async function bisect(versionId, task, onRound = () => {}) {
  const { mods: all, info } = await mods.listMods(versionId);
  const loader = info.loader && info.loader.type;
  const original = new Map(all.map((m) => [m.base, m.enabled]));
  const enabled = all.filter((m) => m.enabled);
  if (!enabled.length) throw new Error('没有启用的 Mod');
  const providers = buildIndex(enabled, loader);

  // 被其他 Mod 依赖的视为“前置库”，不参与二分
  const depOf = (m) => Object.keys(section(m, loader, info.mcVersion).deps).map((d) => d.toLowerCase()).filter((d) => !(BUILTIN[loader] || []).includes(d));
  const libs = new Set();
  for (const m of enabled) for (const d of depOf(m)) for (const p of providers.get(d) || []) if (p && p !== m) libs.add(p.base);
  const suspects = enabled.filter((m) => !libs.has(m.base));
  const byBase = new Map(enabled.map((m) => [m.base, m]));

  const closure = (set) => {
    const d = new Set(set);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of enabled) {
        if (d.has(m.base)) continue;
        const broken = depOf(m).some((dep) => {
          const ps = (providers.get(dep) || []).filter(Boolean);
          return ps.length && ps.every((p) => d.has(p.base));
        });
        if (broken) { d.add(m.base); changed = true; }
      }
    }
    return d;
  };

  const rounds = [];
  const total = Math.ceil(Math.log2(Math.max(2, suspects.length))) + 4;
  const test = async (disableBases, label) => {
    const d = closure(disableBases);
    const map = {};
    for (const m of enabled) map[m.base] = !d.has(m.base);
    await mods.setEnabledMany(versionId, map);
    const n = rounds.length + 1;
    task.update({ title: `二分排查 · 第 ${n} 轮`, detail: `${label}（禁用 ${d.size} 个 Mod）`, progress: Math.min(0.95, rounds.length / total) });
    onRound({ round: n, label, disabled: d.size, total });
    const r = await testLaunch(versionId, task, { timeout: 300000, look: false });
    if (r.reason === 'interrupted') throw interruptedError();
    rounds.push({ round: n, label, disabled: [...d].map((b) => modLabel(byBase.get(b))), ok: r.ok, duration: r.duration });
    onRound({ round: n, label, disabled: d.size, ok: r.ok, total, done: true });
    return r.ok;
  };

  const view = (b) => { const m = byBase.get(b); return { name: modLabel(m), file: m.file, path: m.path, id: m.id, modrinth: m.modrinth }; };

  try {
    if (await test([], '原始配置')) return { status: 'no-crash', rounds };
    const all = suspects.map((m) => m.base);
    if (!all.length || !(await test(all, '禁用所有非前置 Mod'))) {
      return { status: 'not-in-mods', rounds, note: '禁用所有普通 Mod 后仍然崩溃，问题可能出在前置库、加载器版本、配置文件或 Java 上' };
    }
    // 寻找“最短的崩溃前缀”：只启用前 k 个嫌疑 Mod 时开始崩溃，则第 k 个就是一个问题 Mod。
    // 找到后将其禁用并继续，可以定位多个同时存在的问题 Mod（也能处理两个 Mod 互相冲突的情况）。
    const culprits = [];
    let poolList = all;
    for (let iter = 0; iter < 3 && poolList.length; iter++) {
      if (iter > 0 && (await test(culprits, `禁用已找到的 ${culprits.length} 个问题 Mod 后复查`))) break;
      let lo = 1;
      let hi = poolList.length;
      while (lo < hi) {
        if (task.signal.aborted) throw abortError();
        const mid = Math.floor((lo + hi) / 2);
        const ok = await test([...poolList.slice(mid), ...culprits], `只启用 ${mid} / ${poolList.length} 个嫌疑 Mod`);
        if (ok) lo = mid + 1; else hi = mid;
      }
      const found = poolList[lo - 1];
      culprits.push(found);
      poolList = poolList.filter((b) => b !== found);
    }
    const confirmed = await test(culprits, `验证：禁用 ${nmJoin(culprits.map((b) => modLabel(byBase.get(b))))}`);
    const list = culprits.map(view);
    return {
      status: confirmed ? 'found' : 'inconclusive',
      culprit: list[0],
      culprits: list,
      rounds,
      note: confirmed ? null : '禁用这些 Mod 后仍然崩溃，可能还有其他问题（例如配置文件或前置库）',
    };
  } finally {
    // 恢复原始启用状态
    const restore = {};
    for (const [b, en] of original) restore[b] = en;
    await sleep(500);
    await mods.setEnabledMany(versionId, restore).catch((e) => console.error('[bisect] 恢复失败', e));
  }
}

module.exports = { bisect };
