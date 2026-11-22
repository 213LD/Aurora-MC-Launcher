'use strict';
/** 静态检查：不启动游戏，看缺前置、加载器不对、重复、声明的不兼容、MC 版本不符 */
const versions = require('../versions');
const mods = require('../mods');
const javafit = require('../javafit');
const javaMgr = require('../java');
const config = require('../../engine/config');
const { t, nm, nmJoin, join } = require('../../../shared/i18n');
const { BUILTIN, KNOWN_CONFLICTS, LOADER_NAMES, compatibleLoaders, mcMatches, modLabel, parseVer, rangeText, section, versionInRanges } = require('./compat');

function buildIndex(list, loader) {
  const providers = new Map();
  const add = (id, m) => {
    const k = String(id).toLowerCase();
    if (!providers.has(k)) providers.set(k, []);
    providers.get(k).push(m);
  };
  for (const id of BUILTIN[loader] || []) add(id, null);
  for (const m of list) for (const id of [...(m.ids || []), ...(m.provides || [])]) add(id, m);
  return providers;
}

async function staticCheck(versionId) {
  const { mods: all, info } = await mods.listMods(versionId);
  const loader = info.loader && info.loader.type;
  const mc = info.mcVersion;
  const enabled = all.filter((m) => m.enabled);
  const issues = [];
  const push = (i) => issues.push({ id: `${i.type}:${issues.length}`, ...i });

  if (!loader) {
    if (enabled.length) push({ severity: 'crit', type: 'no-loader', title: '该版本没有安装 Mod 加载器', detail: `mods 文件夹中有 ${enabled.length} 个 Mod，但原版游戏不会加载它们`, fix: { kind: 'install-loader' } });
    return { loader, mc, issues, count: enabled.length };
  }

  const providers = buildIndex(enabled, loader);
  const okLoaders = compatibleLoaders(loader, mc);

  // 加载器不匹配
  const wrongLoader = enabled.filter((m) => m.loaders && m.loaders.length && !m.loaders.some((l) => okLoaders.includes(l)));
  for (const m of wrongLoader) {
    push({
      severity: 'crit', type: 'loader', title: `${nm(modLabel(m))} 不适用于 ${LOADER_NAMES[loader]}`,
      detail: `这是一个 ${m.loaders.map((l) => LOADER_NAMES[l] || l).join(' / ')} Mod，在当前加载器上无法运行`,
      files: [m.path], fix: { kind: 'disable', files: [m.path] },
    });
  }
  const valid = enabled.filter((m) => !wrongLoader.includes(m));

  // 重复 Mod
  const byId = new Map();
  for (const m of valid) {
    if (!m.id) continue;
    const k = m.id.toLowerCase();
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(m);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => b.mtime - a.mtime);
    push({
      severity: 'crit', type: 'duplicate', title: `重复的 Mod：${nm(modLabel(list[0]))}`,
      detail: `${join(list.map((m) => `${nm(m.file)}${m.version ? `（${nm(m.version)}）` : ''}`))} 都是 ${nm(id)}，只能保留一个`,
      files: list.map((m) => m.path), fix: { kind: 'disable', files: sorted.slice(1).map((m) => m.path), label: '只保留最新的' },
    });
  }

  const sec = new Map(valid.map((m) => [m, section(m, loader, mc)]));

  // 缺少前置
  const missing = new Map();
  for (const m of valid) {
    for (const dep of Object.keys(sec.get(m).deps)) {
      const k = dep.toLowerCase();
      if (providers.has(k)) continue;
      if (!missing.has(k)) missing.set(k, { dep, by: [] });
      missing.get(k).by.push(m);
    }
  }
  for (const { dep, by } of missing.values()) {
    push({
      severity: 'crit', type: 'missing-dep', title: `缺少前置 Mod：${nm(dep)}`,
      detail: `${nmJoin(by.map(modLabel).slice(0, 4))}${by.length > 4 ? ` 等 ${by.length} 个 Mod` : ''} 需要它`,
      modId: dep, fix: { kind: 'install-dep', modId: dep },
    });
  }

  // 前置在、但版本不在要求的范围里（1.5.10：以前只查有没有，Indium 要 Sodium ~0.5.11、装的是 0.5.7 也算通过）
  for (const m of valid) {
    for (const [dep, ranges] of Object.entries(sec.get(m).deps)) {
      const have = (providers.get(dep.toLowerCase()) || []).filter((x) => x && x !== m && (x.ids || []).some((i) => i.toLowerCase() === dep.toLowerCase()));
      // 认不出版本号的不报（避免误报）；有一个满足就行
      if (!have.length || have.some((x) => !parseVer(x.version || '') || versionInRanges(ranges, x.version, sec.get(m).kind))) continue;
      const x = have[0];
      push({
        severity: 'crit', type: 'dep-version', title: `${nm(modLabel(m))} 需要的 ${nm(modLabel(x))} 版本不对`,
        detail: `${nm(modLabel(m))} 需要 ${nm(modLabel(x))} ${rangeText(ranges)}，装的是 ${nm(x.version)}。可以换成符合要求的版本，或者禁用 ${nm(modLabel(m))}`,
        files: [x.path, m.path], modId: dep, ranges, rangeKind: sec.get(m).kind, fix: { kind: 'install-dep', modId: dep, ranges, rangeKind: sec.get(m).kind, update: true },
      });
    }
  }

  // 声明的不兼容（结合对方的实际版本判断）
  const hitBy = (m, dep, ranges) => (providers.get(dep.toLowerCase()) || []).filter((x) => x && x !== m
    && versionInRanges(ranges, (x.ids || []).some((i) => i.toLowerCase() === dep.toLowerCase()) ? x.version : null, sec.get(m).kind));
  for (const m of valid) {
    for (const [dep, ranges] of Object.entries(sec.get(m).breaks)) {
      const others = hitBy(m, dep, ranges);
      if (!others.length) continue;
      push({
        severity: 'crit', type: 'breaks', title: `${nm(modLabel(m))} 与 ${nm(modLabel(others[0]))} 不兼容`,
        detail: `${nm(modLabel(m))} 声明了与 ${nm(dep)}${ranges[0] && ranges[0] !== '*' ? `（${ranges.join(' / ')}）` : ''} 不兼容`,
        files: [m.path, others[0].path], fix: { kind: 'choose', files: [m.path, others[0].path] },
      });
    }
    for (const [dep, ranges] of Object.entries(sec.get(m).conflicts)) {
      const others = hitBy(m, dep, ranges);
      if (!others.length) continue;
      push({
        severity: 'warn', type: 'conflicts', title: `${nm(modLabel(m))} 可能与 ${nm(modLabel(others[0]))} 冲突`,
        detail: '作者标注两者同时使用可能出现问题', files: [m.path, others[0].path], fix: { kind: 'choose', files: [m.path, others[0].path] },
      });
    }
  }

  // 已知冲突
  for (const [a, b, reason] of KNOWN_CONFLICTS) {
    const ma = a.flatMap((id) => (providers.get(id) || []).filter(Boolean));
    const mb = b.flatMap((id) => (providers.get(id) || []).filter(Boolean));
    if (ma.length && mb.length && ma[0] !== mb[0]) {
      push({ severity: 'crit', type: 'known', title: `${nm(modLabel(ma[0]))} 与 ${nm(modLabel(mb[0]))} 冲突`, detail: reason, files: [ma[0].path, mb[0].path], fix: { kind: 'choose', files: [ma[0].path, mb[0].path] } });
    }
  }

  // 没写进元数据的前置：Sodium 0.5 及更早要配 Indium，内嵌了 noindium 的 Mod（例如 Modern Industrialization）进游戏会弹全屏警告
  // 「客户端未找到 Indium」（玩家导出的整合包实测）。Sodium 0.6 起自带渲染 API，不需要 Indium
  const sodium = (providers.get('sodium') || []).filter(Boolean)[0];
  const needIndium = enabled.filter((m) => m !== sodium && [...(m.ids || []), ...(m.provides || [])].includes('noindium'));
  const sodiumVer = sodium && String(sodium.version || sodium.file).match(/(?:^|[^\d.])0\.(\d+)\.\d+/);
  if (sodium && needIndium.length && !(providers.get('indium') || []).filter(Boolean).length && !(sodiumVer && +sodiumVer[1] >= 6)) {
    push({ severity: 'warn', type: 'missing-dep', title: t('notice.indiumTitle'), detail: t('notice.indiumStatic', { names: nmJoin(needIndium.slice(0, 3).map(modLabel)) }), modId: 'indium', fix: { kind: 'install-dep', modId: 'indium' } });
  }

  // Mod 声明要的 Java 比这个配置会用的高：启动时一定崩溃，提前给「用 Java N 再测一次」
  try {
    const req = versions.requiredJava(await versions.resolveVersion(versionId));
    const { java } = await javaMgr.peekForVersion(req, config.getVersionSettings(versionId));
    for (const i of javafit.fromMeta(valid, loader, java, req)) push(i);
  } catch { /* 版本文件不完整时跳过 */ }

  // Minecraft 版本不符
  for (const m of valid) {
    const s = sec.get(m);
    const spec = [s.mc, ...(s.nestedMc || [])].filter(Boolean).find((x) => !mcMatches(x, mc));
    if (spec) {
      push({
        severity: 'warn', type: 'mc-version', title: `${nm(modLabel(m))} 可能不支持 Minecraft ${mc}`,
        detail: `该 Mod 声明支持的版本为 ${spec.ranges.join(' / ')}`, files: [m.path], fix: { kind: 'disable', files: [m.path] },
      });
    }
  }

  const order = { crit: 0, warn: 1, info: 2 };
  issues.sort((x, y) => order[x.severity] - order[y.severity]);
  return { loader, mc, issues, count: enabled.length };
}

module.exports = { buildIndex, staticCheck };
