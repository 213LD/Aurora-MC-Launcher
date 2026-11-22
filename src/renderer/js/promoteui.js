'use strict';
/**
 * 测试副本 / 共享 →「转为正式配置」，以及「从其他配置导入存档」（1.5.8）
 * 后端在 core/promote.js、core/worldimport.js
 */
(function () {
  const { h, icon, api, t, cmpMc } = A;
  const state = A.state;
  const MODE_TEXT = { copy: '留下测试副本里的', link: '从来源复制一份，成为自己的' };
  const ITEM_TIP = {
    saves: '你在测试里玩的进度都在',
    config: 'Mod 的设置都在，BetterX 欢迎页这类「已经看过」的记录也在，不会再弹',
    options: '画质、按键、语言都在，原版的辅助功能欢迎页也不会再弹',
    shaderpacks: '光影 Mod 选的光影还能找到',
    resourcepacks: '',
    screenshots: '',
  };

  const nameOf = (id) => A.iso.sourceName(id);
  /** 隔离策略里有共享或副本 */
  const isMixed = (v) => !!(v && v.isolation && v.isolation.items && Object.values(v.isolation.items).some((m) => m !== 'own'));

  async function promote(v) {
    let info;
    try { info = await api('isolation:promoteInfo', v.id); } catch (e) { A.errorToast('读取隔离策略失败', e); return; }
    if (!info.items.length) { A.toast({ level: 'info', title: '已经是完全独立的配置' }); return; }
    const src = state.installed.find((x) => x.id === info.source);
    let saves = 'keep';
    const body = h('div');
    const savesItem = info.items.find((i) => i.kind === 'saves');
    const render = () => A.mount(body,
      h('p', { style: { margin: '0 0 12px' } }, `以后这个配置的存档、Mod 配置、游戏选项、光影包都只属于它自己，和「${A.nm(nameOf(info.source))}」互不影响。现在用的内容会留下来：`),
      h('div.issues', info.items.map((i) => h('div.issue',
        h('div.issue-ico', icon(i.mode === 'link' ? 'link' : 'flask', 16)),
        h('div.issue-body',
          h('div.issue-title', `${i.label}：${i.kind === 'saves' && saves === 'fresh' ? `从「${A.nm(nameOf(info.source))}」重新复制一份最新的` : MODE_TEXT[i.mode]}`),
          h('div.issue-detail', [i.kind === 'saves' && saves === 'fresh' ? '' : ITEM_TIP[i.kind], i.kind === 'saves' && info.copyWorlds.length && saves === 'keep' ? `世界：${A.nmJoin(info.copyWorlds)}` : ''].filter(Boolean).join('\n')))))),
      savesItem && savesItem.mode === 'copy' ? h('div.field', { style: { marginTop: '14px' } }, h('label', '存档用哪一份'),
        A.seg([{ value: 'keep', label: '测试副本里的（含测试进度）' }, { value: 'fresh', label: `重新从「${A.nm(nameOf(info.source))}」复制` }], saves, (val) => { saves = val; render(); })) : null,
      savesItem && savesItem.mode === 'copy' && info.sourceNewer && saves === 'keep' ? A.alert({ level: 'warn', compact: true, text: `「${A.nm(nameOf(info.source))}」里的存档在复制之后又玩过，测试副本里没有后来的进度。要后来的进度就选「重新复制」` }) : null,
      savesItem && saves === 'fresh' ? A.alert({ level: 'info', compact: true, text: '测试副本里的存档不会删，会改名成 saves.aurora-sandbox-last-… 留在配置文件夹里' }) : null,
      src && src.mcVersion !== v.mcVersion ? A.alert({ level: 'info', compact: true, text: `来源是 Minecraft ${A.nm(src.mcVersion)}，这个配置是 ${A.nm(v.mcVersion)}。存档是复制出来的，在这里玩会升级成 ${A.nm(v.mcVersion)} 的格式，「${A.nm(nameOf(info.source))}」里原来的存档不受影响` }) : null,
      info.items.some((i) => i.stash) ? h('p.faint', { style: { fontSize: '12px', margin: '12px 0 0' } }, '切到测试副本之前这个配置自己的内容也会并进来；有重名的，原来那份留在「名称.aurora-before-promote」里，不会删') : null);
    render();
    A.modal({
      title: '转为正式配置',
      subtitle: `${A.nm(A.displayName(v))} · ${A.versionSub(v)}`,
      icon: 'shield',
      body,
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: '转为正式配置', kind: 'primary', icon: 'check', onClick: async () => {
            try {
              const r = await api('isolation:promote', v.id, { saves });
              A.toast({ level: 'ok', title: `「${A.nm(A.displayName(v))}」已转为正式配置`, text: r.lines.join('，') });
              await A.refreshInstalled();
              return true;
            } catch (e) { A.errorToast('转为正式配置失败', e); return false; }
          },
        },
      ],
    });
  }

  /** 从其他配置（或公共 .minecraft）把世界复制进来 */
  async function importWorlds(v, onDone) {
    if (isMixed(v) && v.isolation.items.saves !== 'own') {
      const ok = await A.confirm(`这个配置的存档是${v.isolation.items.saves === 'link' ? '和别的配置共享的' : '测试副本（每次启动会重新复制）'}，导进来的世界留不住。要先把它转为正式配置吗？`, { okText: '先转为正式配置' });
      if (ok) promote(v);
      return;
    }
    const others = state.installed.filter((x) => x.id !== v.id && x.isolated);
    let source = (others.find((x) => x.worlds) || {}).id || '@root';
    let worlds = null;
    let picked = new Set();
    const body = h('div');
    const load = () => {
      worlds = null;
      render();
      const s = source;
      api('isolation:worlds', s, v.id).then((w) => { if (s === source) { worlds = w; picked = new Set(w.length === 1 ? [w[0].name] : []); render(); } }).catch(() => { worlds = []; render(); });
    };
    const render = () => {
      const src = state.installed.find((x) => x.id === source);
      const srcMc = src ? src.mcVersion : null;
      A.mount(body,
        h('div.field', h('label', '从哪个配置导入'),
          A.select({
            options: [...others.map((x) => ({ value: x.id, label: A.nm(A.displayName(x)), sub: `${A.versionSub(x)} · ${x.worlds || 0} 个世界`, img: A.versionIcon(x, 48) })), { value: '@root', label: '公共 .minecraft 目录', sub: '官方启动器与未隔离版本使用的目录' }],
            value: source, block: true, searchable: true, onChange: (val) => { source = val; load(); },
          })),
        h('div.field', h('label', '要导入的世界'),
          worlds === null ? h('div.row', h('span.spinner'), h('span.muted', '读取存档…'))
            : worlds.length ? h('div.world-list', worlds.map((w) => h('label.world-row',
              h('input', { type: 'checkbox', checked: picked.has(w.name), onchange: (e) => { if (e.target.checked) picked.add(w.name); else picked.delete(w.name); } }),
              h('span', { style: { flex: 1 }, 'data-no-tr': '' }, w.name), h('span.faint', A.fmtRelative(w.lastPlayed)))))
              : h('div.faint', { style: { fontSize: '12.5px' } }, '这里还没有存档')),
        srcMc && srcMc !== v.mcVersion ? A.alert({
          level: cmpMc(srcMc, v.mcVersion) > 0 ? 'warn' : 'info', compact: true,
          text: cmpMc(srcMc, v.mcVersion) > 0
            ? `这些世界来自更新的 Minecraft ${srcMc}，用 ${A.nm(v.mcVersion)} 打开可能出错或丢失新版本的方块`
            : `这些世界来自 Minecraft ${srcMc}，在这里玩会升级成 ${A.nm(v.mcVersion)} 的格式。导入的是复制品，原来的存档不受影响`,
        }) : null,
        h('p.faint', { style: { fontSize: '12px', margin: '10px 0 0' } }, '只复制，不动原来的存档；这里已经有同名世界时，导入的会改名成「名字 (来自 …)」'));
    };
    load();
    A.modal({
      title: '从其他配置导入存档',
      subtitle: `导入到 ${A.nm(A.displayName(v))} · ${A.versionSub(v)}`,
      icon: 'import',
      body,
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: '导入', kind: 'primary', icon: 'import', onClick: async () => {
            if (!picked.size) { A.toast({ level: 'warn', title: '先勾选要导入的世界' }); return false; }
            try {
              const r = await api('backup:importWorlds', v.id, source, [...picked]);
              const renamed = r.copied.filter((c) => c.as !== c.name);
              A.toast({ level: 'ok', title: `导入了 ${r.copied.length} 个世界`, text: renamed.length ? `重名改成了：${renamed.map((c) => c.as).join('、')}` : '' });
              await A.refreshInstalled();
              if (onDone) onDone();
              return true;
            } catch (e) { A.errorToast('导入存档失败', e); return false; }
          },
        },
      ],
    });
  }

  A.iso.promote = promote;
  A.iso.isMixed = isMixed;
  A.importWorlds = importWorlds;
})();
