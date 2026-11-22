'use strict';
/** IPC：Java 的查找、安装、卸载 */

const versions = require('../core/versions');
const javaMgr = require('../core/java');
const gamelock = require('../core/gamelock');
const { handle, send, startTask } = require('./bus');

function register() {
  // ── Java ──
  javaMgr.onChanged(() => send('java:changed'));
  handle('java:detect', (force) => javaMgr.detect(!!force));
  handle('java:runtimes', () => javaMgr.listMojangRuntimes());
  handle('java:installMojang', (component) => startTask(`安装 ${javaMgr.COMPONENT_NAMES[component] || component}（官方运行时）`, { kind: 'java', doneText: '安装完成', failTitle: 'Java 安装失败' },
    (task) => javaMgr.installMojangRuntime(component, task), (err) => javaDone(err)));
  handle('java:installTemurin', (major, type) => startTask(`安装 Temurin ${major} ${String(type || 'jdk').toUpperCase()}`, { kind: 'java', doneText: '安装完成', failTitle: 'Java 安装失败' },
    (task) => javaMgr.installTemurin(major, type || 'jdk', task), (err) => javaDone(err)));
  handle('java:installMicrosoft', (major) => startTask(`安装 Microsoft OpenJDK ${major}`, { kind: 'java', doneText: '安装完成', failTitle: 'Java 安装失败' },
    (task) => javaMgr.installMicrosoft(Number(major), task), (err) => javaDone(err)));
  handle('java:add', async (p) => { const j = await javaMgr.addManual(p); send('java:changed'); return j; });
  handle('java:remove', (p) => { javaMgr.removeManual(p); send('java:changed'); });
  handle('java:uninstall', async (home) => { await gamelock.assertJava(home, '卸载这个 Java'); await javaMgr.uninstallRuntime(home); send('java:changed'); });
  handle('java:required', async (id) => {
    const v = await versions.resolveVersion(id);
    const req = versions.requiredJava(v);
    const list = await javaMgr.detect();
    return { req, pick: javaMgr.pick(list, req, { strict: true }) };
  });
  // 启动前、装完后、配置抽屉里检查这个配置的 Java 合不合适
  handle('java:status', (id) => require('../core/javacheck').status(id));
}

function javaDone(err) {
  send('java:changed');
  if (!err) send('notify', { level: 'ok', title: 'Java 安装完成', text: '已自动加入 Java 列表' });
}

module.exports = register;
