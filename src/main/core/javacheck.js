'use strict';
/**
 * 某个配置启动时会用哪个 Java、合不合适
 * - 指定了 Java（配置里或全局）：检查版本是否够用；Java 8 时代的版本用了 Java 9 以上也提醒
 * - 自动选择：看已安装的 Java 里有没有合适的（和 java.resolveForVersion 的 strict 规则一致）
 */
const path = require('path');
const config = require('../engine/config');
const versions = require('./versions');
const javaMgr = require('./java');

/** 推荐安装的官方运行时：Java 21 能运行 1.17 ~ 1.21.x */
const RECOMMENDED = 'java-runtime-delta';

const componentFor = (req) => req.component || javaMgr.COMPONENT_BY_MAJOR[req.major] || javaMgr.COMPONENT_BY_MAJOR[req.major >= 21 ? 21 : 17];

/**
 * 判断一个 Java 能不能运行需要 req.major 的版本
 * @returns {'' | 'tooOld' | 'tooNew'}
 */
function fit(major, reqMajor) {
  if (major < reqMajor) return 'tooOld';
  if (reqMajor <= 8 && major > 8) return 'tooNew';
  return '';
}

/**
 * @returns {Promise<{req, component, from: 'profile'|'global'|'auto', java, problem: ''|'tooOld'|'tooNew'|'missing'|'none'}>}
 *   problem：tooOld / tooNew 指定的 Java 不合适，missing 指定的 Java 不存在，none 自动选择时没有合适的
 */
async function status(id) {
  const v = await versions.resolveVersion(id);
  const req = versions.requiredJava(v);
  const component = componentFor(req);
  const javas = await javaMgr.detect();
  const vs = config.getVersionSettings(id).java;
  const globalSel = config.get().java.selected;
  const manual = vs && vs !== 'global' && vs !== 'auto' ? vs : null;
  const chosen = manual || (vs === 'auto' || globalSel === 'auto' ? null : globalSel);
  if (chosen) {
    const java = javas.find((j) => j.path === chosen || j.javaw === chosen) || await javaMgr.probe(path.dirname(path.dirname(chosen)), '手动');
    return { req, component, from: manual ? 'profile' : 'global', path: chosen, java, problem: java ? fit(java.major, req.major) : 'missing' };
  }
  const java = javaMgr.pick(javas, req, { strict: true });
  return { req, component, from: 'auto', java, problem: java ? '' : 'none' };
}

module.exports = { status, fit, componentFor, RECOMMENDED };
