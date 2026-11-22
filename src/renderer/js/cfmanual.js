'use strict';
/*
 * CurseForge 手动下载：作者关闭了第三方下载的文件由玩家在浏览器里下载，
 * 对话框开着的时候每 3 秒看一次「下载」文件夹，下载好的文件自动放进配置；
 * 放进去之后「下载」文件夹里的原文件按设置处理，设置是「每次询问」时问玩家
 */
(function () {
  const { h, icon, api, state, t } = A;

  const POLL = 3000;
  const opened = new Map(); // 配置 id → 打开着的对话框（同一个配置只开一个，新来的文件合并进去）

  const nameOf = (versionId) => A.displayName(state.installed.find((v) => v.id === versionId) || { id: versionId });

  /** 需要手动下载的文件列表对话框 */
  function dialog(versionId, items) {
    const cur = opened.get(versionId);
    if (cur) { cur.merge(items || []); return; }
    let list = [];
    const originals = [];
    let timer = null;
    let busy = false;
    let m = null;
    const listEl = h('div.cfm-list');
    const statusEl = h('div.cfm-status', { role: 'status' });

    const left = () => list.filter((x) => !x.done);
    const merge = (more) => {
      for (const y of more) if (!list.some((x) => x.fileId === y.fileId)) list.push({ ...y, done: false });
      paint();
      if (left().length && !timer) timer = setInterval(check, POLL);
    };

    const row = (x) => h('div', { class: `cfm-row ${x.done ? 'done' : ''}` },
      h('div.cfm-ico', x.done ? A.levelIcon('ok', 18) : icon('download', 18)),
      h('div.cfm-body',
        h('div.cfm-title', A.nm(x.title) || A.nm(x.fileName)),
        h('div.cfm-sub', `${A.nm(x.fileName)}${x.size ? ` · ${A.fmtBytes(x.size)}` : ''} · ${t('cf.manualFolder', { folder: x.folder || 'mods' })}`)),
      x.done
        ? h('span.badge.ok', icon('check', 12), t('cf.manualDone'))
        : h('div.cfm-actions',
          h('button.btn.sm.ghost', { 'data-tip': t('cf.manualSkipTip'), onclick: () => skip(x) }, t('cf.manualSkip')),
          h('button.btn.sm.primary', { onclick: () => api('shell:external', x.page) }, icon('external', 14), t('cf.manualOpen'))));

    const actions = () => (left().length
      ? [
        { label: t('cf.manualPick'), kind: 'ghost', left: true, icon: 'folder', onClick: () => { pick(); return false; } },
        { label: t('cf.manualLater'), kind: '' },
      ]
      : [{ label: t('common.done'), kind: 'primary' }]);

    function paint() {
      A.mount(statusEl, left().length
        ? h('span.row.gap-s', h('span.spinner'), t('cf.manualWatching', { n: left().length }))
        : A.alert({ level: 'ok', compact: true, text: t('cf.manualAllDone') }));
      A.mount(listEl, list.map(row));
      if (m) m.setActions(actions());
    }

    /** 看一次「下载」文件夹（files：玩家自己选的文件） */
    async function check(files) {
      if (busy) return;
      busy = true;
      try {
        const r = await api('curseforge:importManual', versionId, files ? { files } : {});
        originals.push(...(r.originals || []));
        const still = new Set(r.remaining.map((x) => String(x.fileId)));
        for (const x of list) if (!x.done && !still.has(String(x.fileId))) x.done = true;
        // 别的安装在这期间又加了文件
        for (const y of r.remaining) if (!list.some((x) => String(x.fileId) === String(y.fileId))) list.push({ ...y, done: false });
        if (files && !r.imported.length) A.toast({ level: 'warn', text: t('cf.manualNoMatch') });
        if (!left().length) stop();
        paint();
      } catch (e) {
        if (files) A.errorToast(t('cf.manualFailed'), e);
      } finally { busy = false; }
    }

    async function pick() {
      const files = await api('dialog:file', t('cf.manualPickTitle'), [{ name: 'Mod / 资源', extensions: ['jar', 'zip'] }], true);
      if (files && files.length) check(files);
    }

    async function skip(x) {
      try {
        await api('curseforge:dismissManual', versionId, x.fileId);
        list = list.filter((y) => y !== x);
        if (!list.length) { m.close(); return; }
        if (!left().length) stop();
        paint();
      } catch (e) { A.errorToast(t('cf.manualFailed'), e); }
    }

    const stop = () => { clearInterval(timer); timer = null; };

    m = A.modal({
      title: t('cf.manualTitle'),
      subtitle: A.nm(nameOf(versionId)),
      icon: 'download',
      size: 'lg',
      body: h('div.cfm', h('p.confirm-text', t('cf.manualIntro')), statusEl, listEl),
      actions: [],
      onClose: () => {
        stop();
        opened.delete(versionId);
        if (originals.length) askOriginals(originals);
      },
    });
    opened.set(versionId, { merge });
    merge(items || []);
    check();
  }

  /** 原文件怎么处理：移到回收站 / 保留，可以记住选择 */
  function askOriginals(files) {
    let remember = false;
    const box = h('input', { type: 'checkbox', onchange: (e) => { remember = e.target.checked; } });
    const decide = async (mode) => {
      if (remember) A.setConfig({ cfDownloads: mode }).catch(() => {});
      if (mode !== 'trash') return;
      const n = await api('curseforge:trashOriginals', files);
      if (n) A.toast({ level: 'ok', text: t('cf.trashed', { n }) });
      if (n < files.length) A.toast({ level: 'warn', text: t('cf.trashPartial', { n: files.length - n }) });
    };
    A.modal({
      title: t('cf.downloadsTitle'),
      level: 'info',
      size: 'md',
      body: h('div.cfm-ask',
        h('p.confirm-text', t('cf.downloadsText', { n: files.length })),
        h('div.cfm-files', files.map((f) => h('code', { title: A.nm(f) }, A.nm(f.split(/[\\/]/).pop())))),
        h('label.row.gap-s.cfm-check', box, h('span', t('cf.remember')))),
      actions: [
        { label: t('cf.downloadsKeep'), kind: '', onClick: () => decide('keep') },
        { label: t('cf.downloadsTrash'), kind: 'primary', icon: 'trash', onClick: () => decide('trash') },
      ],
    });
  }

  /** Mod 管理页的提醒：还有文件没下载 */
  function notice(versionId, items) {
    return A.alert({
      level: 'warn',
      title: t('cf.manualNotice', { n: items.length }),
      text: t('cf.manualNoticeText'),
      actions: [h('button.btn.sm.primary', { onclick: () => dialog(versionId, items) }, icon('download', 14), t('cf.manualContinue'))],
    });
  }

  // 安装 Mod / 整合包时遇到需要手动下载的文件：主进程在任务结束时通知
  A.listen('curseforge:manual', (d) => { if (d && d.versionId && d.items && d.items.length) dialog(d.versionId, d.items); });

  A.cfManual = { dialog, askOriginals, notice };
})();
