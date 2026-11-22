'use strict';
/* 在线资源的来源：Modrinth / CurseForge。下载页的资源浏览器和 Mod 管理的「在线添加」共用 */
(function () {
  const { h, icon, api, state, t } = A;

  const SOURCES = {
    modrinth: {
      id: 'modrinth', name: 'Modrinth',
      search: (q) => api('mods:search', q),
      project: (id) => api('mods:project', id),
      versions: (id, opts) => api('mods:versions', id, opts),
      install: (params) => api('mods:install', params),
      page: (p, type) => `https://modrinth.com/${p.type || type}/${p.slug}`,
    },
    curseforge: {
      id: 'curseforge', name: 'CurseForge',
      search: (q) => api('curseforge:search', q),
      project: (id) => api('curseforge:project', id),
      versions: (id, opts) => api('curseforge:files', id, opts),
      install: (params) => api('curseforge:install', params),
      page: (p) => p.url,
    },
  };
  const CF_SETUP = ['CF_NO_ENDPOINT', 'CF_KEY', 'CF_NETWORK'];

  const get = (id) => SOURCES[id] || SOURCES.modrinth;
  const current = () => get(state.config.resSource).id;
  /** 记住选的来源；先改本地状态，界面马上按新来源刷新 */
  const set = (id) => { state.config.resSource = id; A.setConfig({ resSource: id }).catch(() => {}); };

  /** 来源切换按钮 */
  const seg = (value, onChange) => A.seg(Object.values(SOURCES).map((s) => ({ value: s.id, label: s.name })), value, onChange);

  /** 正式版优先，其次 Beta，最后 Alpha */
  const best = (list) => list.find((v) => v.type === 'release') || list.find((v) => v.type === 'beta') || list[0];

  /** 作者关闭了第三方下载的 CurseForge 项目：小标签（安装时要玩家自己在浏览器里下载） */
  const manualBadge = (tip = t('res.manualTip')) => h('span.badge.warn', { 'data-tip': tip }, icon('external', 12), t('res.manualBadge'));

  /** 连不上 CurseForge 时，错误提示旁边给一个去设置的按钮 */
  const setupAction = (e) => (e && CF_SETUP.includes(e.reason)
    ? h('button.btn', { onclick: () => A.go('settings', { focus: 'curseforge' }) }, icon('settings', 16), t('cf.settings'))
    : null);

  A.sources = { get, current, set, seg, best, manualBadge, setupAction, list: Object.values(SOURCES) };
})();
