'use strict';
/** IPC：Mod 配置器、纯净版+ */

const versions = require('../core/versions');
const profiles = require('../core/profiles');
const planner = require('../core/planner');
const isolation = require('../core/isolation');
const vanillaplus = require('../core/vanillaplus');
const { t } = require('../../shared/i18n');
const { handle, send, startTask, assertModsFree, installGuard } = require('./bus');
const { nm, msg, join } = require('../../shared/i18n');

function register() {
  // ── Mod 配置器 ──
  handle('planner:styles', () => planner.styles());
  handle('planner:recommend', (p) => planner.recommend(p || {}));
  handle('planner:resolve', (p) => planner.resolve(p || {}));
  handle('planner:install', async (params) => {
    const name = params.target.mode === 'existing' ? params.target.versionId : params.target.name;
    // 装进已有的配置：和「修改配置」一样，它的游戏开着时不动它的 Mod
    if (params.target.mode === 'existing') await assertModsFree(name, '安装方案');
    return startTask(`安装${t('term.plan')} ${nm(params.plan.name) || nm(name)}`, { kind: 'install', lock: name, meta: { name, planId: params.plan.id }, doneText: '安装完成', failTitle: `安装${t('term.plan')}失败` },
      async (task) => {
        const r = await planner.install(params, task);
        if (params.extras) {
          const x = await planner.addExtras(r.versionId, params.extras, task);
          r.copied = (r.copied || 0) + x.copied;
          r.autoDeps = [...(r.autoDeps || []), ...x.autoDeps];
          r.unresolved = [...new Set([...(r.unresolved || []), ...x.unresolved])];
        }
        return r;
      }, (err, r) => {
        send('versions:changed');
        if (!err) {
          const extra = [
            r.copied ? msg('复制了 {n} 个本地文件', { n: r.copied }) : '',
            r.autoDeps && r.autoDeps.length ? msg('自动补齐前置：{list}', { list: r.autoDeps.map(nm) }) : '',
            r.unresolved && r.unresolved.length ? msg('未能找到：{list}', { list: r.unresolved.map(nm) }) : '',
          ];
          send('notify', { level: r.unresolved && r.unresolved.length ? 'warn' : 'ok', title: `${t('term.plan')}已安装`, text: join([join([nm(r.versionId), msg('下载了 {n} 个 Mod', { n: r.downloaded })], 'colon'), ...extra], 'clause'), version: r.versionId });
        }
      });
  });
  handle('planner:fromProfile', (id) => planner.fromProfile(id));
  handle('planner:applyEdit', async (params) => { await assertModsFree(params.versionId, '修改配置'); return startTask(`修改配置 ${nm(params.versionId)}`, { kind: 'install', lock: params.versionId, meta: { name: params.versionId }, dir: versions.versionDir(params.versionId), doneText: '修改完成', failTitle: '修改失败' },
    (task) => planner.applyEdit(params, task), (err, r) => {
      send('versions:changed');
      send('mods:changed', params.versionId);
      if (!err) {
        const parts = [msg('新增 {n} 个', { n: r.added.length }), r.removeMode === 'trash' ? msg('删除 {n} 个', { n: r.removed.length }) : msg('禁用 {n} 个', { n: r.removed.length })];
        if (r.enabled.length) parts.push(msg('重新启用 {n} 个', { n: r.enabled.length }));
        if (r.autoDeps.length) parts.push(msg('自动补齐前置：{list}', { list: r.autoDeps.map(nm) }));
        send('notify', { level: r.unresolved.length ? 'warn' : 'ok', title: '配置已修改', text: join([join([nm(params.versionId), join(parts, 'comma')], 'colon'), r.unresolved.length ? msg('未能找到：{list}', { list: r.unresolved.map(nm) }) : ''], 'clause') });
      }
    }); });
  handle('vanillaplus:catalog', (mc, loader) => vanillaplus.catalog(mc, loader));
  handle('vanillaplus:shaders', (mc) => vanillaplus.shaders(mc));
  handle('vanillaplus:loader', async (mc) => { const b = await vanillaplus.bestLoader(mc); return b ? b.type : null; });
  handle('vanillaplus:install', (opts) => {
    const name = (opts.name || `${opts.mc} 纯净版+`).trim();
    versions.validateName(name);
    return startTask(`安装 ${nm(name)}`, { kind: 'install', lock: name, meta: { name, label: `${opts.mc} · 纯净版+` }, dir: versions.versionDir(name), doneText: '安装完成', failTitle: `安装 ${nm(name)} 失败` }, async (task) => {
      const undo = await installGuard(name);
      try {
        const r = await vanillaplus.install({ ...opts, name }, task);
        if (opts.nostalgia) await profiles.writeMeta(name, { nostalgia: opts.nostalgia });
        if (opts.isolation) await isolation.setPolicy(name, opts.isolation);
        return r;
      } catch (e) {
        await undo();
        throw e;
      }
    }, (err, r) => {
      send('versions:changed');
      if (!err) send('notify', { level: r.unresolved && r.unresolved.length ? 'warn' : 'ok', title: '纯净版+ 安装完成', text: `${nm(name)}：${r.downloaded} 个 Mod${r.shaders.length ? `、${r.shaders.length} 个光影包` : ''}${r.autoDeps && r.autoDeps.length ? `（自动补齐 ${r.autoDeps.length} 个前置）` : ''}`, version: name });
    });
  });
  handle('planner:importText', (text, opts) => planner.importText(text, opts || {}));
  handle('planner:importFolder', (dir) => planner.importFolder(dir));
  handle('planner:importProfile', (id) => planner.importProfile(id));
  handle('planner:importMrpack', (file) => planner.importMrpack(file));
  handle('planner:importModrinthPack', (pid) => planner.importModrinthPack(pid));
  handle('planner:exportList', (plan) => planner.exportList(plan || {}));
  handle('planner:importList', (file) => planner.importList(file));
  handle('planner:list', () => planner.listPlans());
  handle('planner:save', (p) => planner.savePlan(p));
  handle('planner:delete', (id) => planner.deletePlan(id));
}

module.exports = register;
