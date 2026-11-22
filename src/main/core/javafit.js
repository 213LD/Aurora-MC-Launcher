'use strict';
/**
 * Mod 需要更高版本的 Java：
 * - fromLog：崩溃日志里的 UnsupportedClassVersionError（class 版本 - 44 = Java 版本）和 Fabric 的「requires ... (java)」
 * - fromMeta：fabric.mod.json / quilt.mod.json 的 depends.java 和 jar 里 class 文件实际的版本（mods.js 的 classJava），
 *   和这个配置启动时会用的 Java 比，启动前提醒
 * 给出的问题带 fix { kind: 'java-retest', major }，界面上是「用 Java N 再测一次」（troubleshoot.javaRetest）
 */
const { t } = require('../../shared/i18n');
const { nm, nmJoin } = require('../../shared/i18n');

const modLabel = (m) => m.name || m.file;
const idsOf = (m) => [m.id, ...(m.ids || []), ...(m.provides || [])].filter(Boolean).map((x) => String(x).toLowerCase());

/** 「21」「>=21」「>=17 <22」「^17」里的最低版本；「*」或看不懂返回 0 */
function minMajor(ranges) {
  let min = 0;
  for (const r of ranges || []) {
    const s = String(r).trim();
    if (!s || s === '*') return 0;
    const m = s.match(/^(?:>=|=|\^|~)?\s*(?:1\.)?(\d+)/);
    if (!m) return 0;
    const n = +m[1];
    if (!min || n < min) min = n;
  }
  return min;
}

function issue({ need, cur, mods: list = [], modId }) {
  const name = list[0] ? modLabel(list[0]) : modId || '';
  return {
    severity: 'crit', type: 'java-version', title: t('java.modNeedTitle', { n: need }),
    detail: name ? t('java.needDetailMod', { mod: nm(name), n: need, cur: cur || '?' }) : t('java.needDetail', { n: need, cur: cur || '?' }),
    javaMajor: need, javaCur: cur || 0, files: list.map((m) => m.path), fix: { kind: 'java-retest', major: need },
  };
}

/** 从日志里认出「需要 Java N」；认不出返回 null */
function fromLog(text, list = []) {
  let need = 0;
  let cur = 0;
  let modId = '';
  let cls = '';
  // Veinminer 2.0.7（Java 21 编译）在 Java 17 上：「... has been compiled by a more recent version of the Java Runtime (class file version 65.0),
  // this version of the Java Runtime only recognizes class file versions up to 61.0」
  const cv = /(?:([\w/$.-]+) has been compiled by a more recent version of the Java Runtime \()?class file version (\d+)(?:\.\d+)?\)?, this version of the Java Runtime only recognizes class file versions up to (\d+)/.exec(text);
  if (cv) { cls = cv[1] || ''; need = +cv[2] - 44; cur = +cv[3] - 44; }
  // Java 8 以前的写法：「Unsupported major.minor version 52.0」
  const old = !cv && /([\w/$.-]+) : Unsupported major\.minor version (\d+)/.exec(text);
  if (old) { cls = old[1]; need = +old[2] - 44; }
  // Fabric 解析依赖时就发现：「Mod 'X' (x) 1.0 requires version 21 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 17.0.8!」
  const fab = /Mod '[^']+' \(([\w.-]+)\) \S+ requires (?:version |any version )?(?:>=)?\s*(?:1\.)?(\d+)[^\n]*?\(java\)(?:[^\n]*?present: (?:1\.)?(\d+))?/.exec(text);
  if (fab && !need) { modId = fab[1]; need = +fab[2]; cur = fab[3] ? +fab[3] : 0; }
  if (!need || need < 8) return null;
  if (!cur) { const r = /Java(?: version)?[: ]+(?:1\.)?(\d+)\.\d/.exec(text); if (r) cur = +r[1]; }
  // 是哪个 Mod：Fabric 入口报错会写「provided by 'veinminer'」；否则按类名里的包名对 Mod id
  if (!modId) { const by = /provided by '([\w.-]+)'/.exec(text); if (by) modId = by[1]; }
  let hit = modId ? list.filter((m) => idsOf(m).includes(modId.toLowerCase())) : [];
  if (!hit.length && cls) {
    const parts = cls.toLowerCase().split(/[/.$]/);
    hit = list.filter((m) => idsOf(m).some((id) => id.length > 3 && parts.includes(id.replace(/-/g, ''))));
  }
  return issue({ need, cur, mods: hit.slice(0, 1), modId });
}

/** 启动前：Mod 元数据声明的 Java 版本比这个配置会用的高。java 为这次会用的 Java（可能为 null：还没有，会自动下载 req.major） */
function fromMeta(enabled, loader, java, req) {
  const cur = java ? java.major : req.major;
  const byNeed = new Map();
  for (const m of enabled) {
    const sec = (m.byLoader && (m.byLoader[loader] || m.byLoader.fabric || m.byLoader.quilt)) || null;
    // 声明的（depends.java）和实际编译的（classJava，读 class 文件头）取大的
    const need = Math.max(sec && sec.deps ? minMajor(sec.deps.java) : 0, m.classJava || 0);
    if (need > cur) byNeed.set(need, [...(byNeed.get(need) || []), m]);
  }
  if (!byNeed.size) return [];
  const need = Math.max(...byNeed.keys());
  const list = [...byNeed.values()].flat();
  const names = nmJoin(list.slice(0, 3).map(modLabel)) + (list.length > 3 ? ` 等 ${list.length} 个` : '');
  return [{
    ...issue({ need, cur, mods: list }),
    detail: java ? t('java.staticDetail', { mods: names, n: need, cur }) : t('java.staticDetailNone', { mods: names, n: need }),
  }];
}

module.exports = { fromLog, fromMeta, minMajor };
