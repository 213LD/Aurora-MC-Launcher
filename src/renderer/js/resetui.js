'use strict';
/* 一键还原启动器：设置 → 还原启动器。
 * 默认只还原启动器设置；「完全清理」要单独勾选，列出会删的东西、提示先备份，再弹一次、等 5 秒才能确认，游戏文件和存档进回收站 */
(function () {
  const { h, icon, api } = A;

  async function open() {
    let p;
    try { p = await api('reset:preview'); } catch (e) { A.errorToast('读取失败', e); return; }
    const st = { full: false, accounts: false, java: false };

    const body = h('div.rs');
    const render = () => {
      const tier = (full, title, desc) => h('label', { class: `rs-tier ${st.full === full ? 'on' : ''} ${full ? 'rs-danger' : ''}` },
        h('input', { type: 'radio', name: 'rs-tier', checked: st.full === full, onchange: () => { st.full = full; render(); } }),
        h('div', h('b', title), h('div.faint', desc)));
      const check = (key, label, sub) => h('label.check-row', h('input', { type: 'checkbox', checked: st[key], onchange: (e) => { st[key] = e.target.checked; } }), h('span', label, sub ? h('span.faint', ` ${sub}`) : null));
      A.mount(body,
        p.running ? A.alert({ level: 'crit', compact: true, title: '有游戏正在运行', text: '先关掉游戏再还原' }) : null,
        tier(false, '还原启动器设置（推荐）', '所有设置回到默认，重新走一遍首次启动；清掉启动器自己的记录和缓存（Mod 清单、通知、调试备份等）。游戏、存档、Mod 都不动'),
        tier(true, '完全清理', '在上面的基础上，把游戏配置、存档、Mod、资源包等全部移到回收站，回到刚安装的样子'),
        h('div.rs-opts',
          check('accounts', '同时删除账户', '（正版账户要重新登录）'),
          check('java', '同时删除启动器下载的 Java', p.java ? `（${p.java} 个）` : '（没有）')),
        st.full ? h('div.rs-full',
          A.alert({
            level: 'crit', title: '这些会移到回收站',
            text: `游戏目录：${p.gameDir}\n${p.game.map((g) => `· ${g.label}${g.count ? `（${g.count} 项）` : ''}`).join('\n') || '（没有找到游戏文件）'}\n如果其他启动器也在用这个游戏目录，它们的版本和存档也会一起被删`,
          }),
          A.alert({
            level: 'warn', title: '先备份存档',
            text: '存档是你玩出来的，删了只能从回收站找回。想留的世界先复制到别的地方（打开游戏目录，把 saves 文件夹或 versions 里各配置的 saves 复制走）',
            actions: [h('button.btn.sm', { onclick: () => api('shell:open', p.gameDir) }, icon('folder', 14), '打开游戏目录')],
          })) : null);
    };
    render();

    A.modal({
      title: '还原启动器', subtitle: '做完会自动重启启动器', icon: 'history', size: 'md', body,
      actions: [
        { label: A.t('common.cancel'), kind: 'ghost' },
        { label: '继续', kind: 'danger', onClick: () => { setTimeout(() => confirmRun(p, { ...st }), 150); return true; } },
      ],
    });
  }

  async function confirmRun(p, st) {
    const items = [
      { icon: 'settings', label: '启动器设置', sub: '回到默认，重新走首次启动' },
      { icon: 'file', label: '启动器的记录和缓存', sub: 'Mod 清单、通知、调试备份、游戏日志、网页缓存' },
      st.accounts ? { icon: 'users', label: '账户' } : { icon: 'users', label: '账户', sub: '保留', keep: true },
      st.java ? { icon: 'coffee', label: '启动器下载的 Java' } : { icon: 'coffee', label: '启动器下载的 Java', sub: '保留', keep: true },
      ...(st.full ? p.game.map((g) => ({ icon: g.name === 'versions' || g.name === 'saves' || g.name === 'backups' ? 'save' : 'folder', label: g.label, sub: `${g.path}（移到回收站）` }))
        : [{ icon: 'save', label: '游戏配置、存档、Mod', sub: '不动', keep: true }]),
    ];
    const ok = await A.dangerConfirm(st.full
      ? { level: 3, title: '完全清理', text: '游戏配置、存档、Mod 会全部移到回收站，启动器回到刚安装的样子。', items, note: '回收站不可用的文件会跳过，不会被永久删除。存档请先备份', noteLevel: 'crit', okText: '删除并还原', confirmName: '删除' }
      : { level: 2, title: '还原启动器设置', text: '启动器设置回到默认，做完自动重启并重新走一遍首次启动。', items, okText: '还原' });
    if (!ok) return;
    let r;
    try { r = await api('reset:run', { full: st.full, accounts: st.accounts, java: st.java }); } catch (e) { A.errorToast('还原失败', e); return; }
    // 本地存储：通知中心、没翻译的标签记录、记住的界面状态
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    const failed = r.failed || [];
    A.modal({
      title: failed.length ? '还原完成，但有文件没能移到回收站' : '还原完成',
      level: failed.length ? 'warn' : 'ok', size: 'md', dismissable: false,
      body: h('div',
        h('p.confirm-text', st.full ? `已把 ${r.trashed.length} 项移到回收站，启动器设置已恢复默认。` : '启动器设置已恢复默认。'),
        failed.length ? A.alert({ level: 'warn', title: '这些没有删除（回收站不可用）', text: `${failed.map((f) => f.path).join('\n')}\n可能在 U 盘或网络盘上。需要的话手动删除` }) : null,
        h('p.faint', { style: { marginTop: '10px' } }, '点「重启」后会重新走一遍首次启动。')),
      actions: [{ label: '重启启动器', kind: 'primary', icon: 'refresh', onClick: () => { api('reset:relaunch'); return false; } }],
    });
  }

  A.resetLauncher = open;
})();
