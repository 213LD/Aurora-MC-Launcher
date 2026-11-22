'use strict';
/*
 * 配置从公共目录搬到自己的文件夹时，先问带不带世界和其他内容。后端在 core/isoworlds.js
 * 单个配置的「存档与隔离」（1.10.9）；全局设置「独立游戏目录」（1.10.10）
 */
(function () {
  const { h, icon, api, t } = A;

  const ITEM_NAME = { mods: 'Mod 和配置文件', resourcepacks: '资源包', shaderpacks: '光影', options: '游戏选项' };
  const gap = (px, ...children) => h('div', { style: { marginTop: `${px}px` } }, ...children);
  const hint = (text) => h('p.faint', { style: { fontSize: '12px', margin: '10px 0 0' } }, text);
  const heading = (text) => h('p', { style: { margin: '12px 0 6px' } }, h('b', text));
  const worldList = (info) => h('div.world-list', { style: { maxHeight: '96px' } }, info.worlds.map((w) => h('div.world-row', { style: { cursor: 'default', padding: '4px 10px' } },
    h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' }, 'data-no-tr': '' }, w.name),
    h('span.faint', A.fmtBytes(w.size)))));

  /**
   * 选了哪些、放不放得下。只管状态，不发请求
   * @param {object} info free、margin、busy、total
   */
  function selection(info, wantWorlds) {
    const fits = (bytes) => info.free == null || bytes + info.margin <= info.free;
    const s = {
      worlds: false,
      picked: new Set(),
      items: [],
      fits,
      worldsFit: () => !info.busy && fits(info.total),
      itemFit: (it) => !info.busy && fits(it.size),
      bytes: () => (s.worlds ? info.total : 0) + s.items.filter((x) => s.picked.has(x.key)).reduce((n, x) => n + x.size, 0),
      any: () => s.worlds || s.picked.size > 0,
      ok: () => fits(s.bytes()),
      /** 换一批可选内容时重新按默认值选：放得下的才勾上 */
      reset(items, worlds = wantWorlds) {
        s.items = items;
        s.worlds = worlds && s.worldsFit();
        s.picked = new Set();
        for (const it of items) if (it.def && s.itemFit(it) && fits(s.bytes() + it.size)) s.picked.add(it.key);
      },
    };
    return s;
  }

  /** 世界以外的内容：两列的勾选框，Mod 带提醒 */
  function itemsBlock(s, onChange) {
    if (!s.items.length) return null;
    const label = (it) => {
      if (!s.itemFit(it)) return it.key === 'options' ? '' : `${A.fmtBytes(it.size)} · 放不下`;
      if (it.key === 'options') return '';
      return it.key === 'mods' ? `${it.count} 个 Mod · ${A.fmtBytes(it.size)}` : A.fmtBytes(it.size);
    };
    return [
      heading('其他内容'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' } }, s.items.map((it) => {
        const off = !s.itemFit(it);
        return h('label.check-row', { 'data-item': it.key, style: { padding: '7px 10px', cursor: off ? 'not-allowed' : 'pointer', opacity: off ? '.55' : '1' } },
          h('input', { type: 'checkbox', checked: s.picked.has(it.key), disabled: off, onchange: (e) => { if (e.target.checked) s.picked.add(it.key); else s.picked.delete(it.key); onChange(); } }),
          h('span', { style: { flex: 1, minWidth: 0 } }, ITEM_NAME[it.key]),
          h('span.faint', { style: { fontSize: '12px', whiteSpace: 'nowrap' } }, label(it)));
      })),
      s.picked.has('mods') ? gap(8, A.alert({ level: 'info', compact: true, text: `公共目录的 Mod 不一定适合这个版本，启动报错可以用「${t('term.debug')}」排查。` })) : null,
    ];
  }

  /** 为什么现在不能复制：游戏开着、磁盘放不下 */
  function warnings(info, s) {
    const out = [];
    if (info.busy) out.push(A.alert({ level: 'warn', compact: true, title: '公共目录的世界正开着', text: `「${info.busy}」的游戏正在用它们，现在复制可能得到写到一半的存档。关掉游戏后再来，或者先不带` }));
    else if (info.worlds.length && !s.fits(info.total)) out.push(A.alert({ level: 'warn', compact: true, title: '磁盘空间不够，世界复制不了', text: `复制世界需要约 ${A.fmtBytes(info.total + info.margin)}，${info.drive} 只剩 ${A.fmtBytes(info.free)}。清理磁盘后再来，或者先不带` }));
    else if (!s.ok()) out.push(A.alert({ level: 'warn', compact: true, title: '选的内容放不下', text: `需要约 ${A.fmtBytes(s.bytes() + info.margin)}，${info.drive} 只剩 ${A.fmtBytes(info.free)}。少选一些，或者清理磁盘后再来` }));
    return out.map((x) => gap(10, x));
  }

  /** 复制中的画面：进度、取消。结束后 resolve 结果，取消或失败时抛错 */
  async function copying(m, body, id, run) {
    const mine = (x) => x.status === 'running' && x.meta && x.meta.bring && x.meta.name === id;
    const box = A.progressBar({ style: { margin: '10px 0 8px' } });
    const detail = h('div.faint', { style: { fontSize: '12.5px' } }, '准备中…');
    m.setDismissable(false);
    A.mount(body,
      h('b', '正在复制…'),
      box,
      detail,
      hint('全部复制好才会切换。现在取消的话什么都不会改，原来的内容也不动。'));
    m.setActions([{ label: '取消复制', onClick: async () => { const x = [...A.state.tasks.values()].find(mine); if (x) await api('tasks:cancel', x.id); return false; } }]);
    const off = A.on('task', (x) => {
      if (!mine(x)) return;
      if (x.detail) detail.textContent = x.detail;
      box.set(x.progress >= 0 ? Math.round(x.progress * 100) : null);
    });
    try { return await run(); } finally { off(); m.setDismissable(true); }
  }

  /**
   * 单个配置改成独立时要不要问。
   * 返回 null：不用问，照常保存；false：玩家取消了，什么都没改；对象：已经切换好了 { policy, applied, copied, items, failed, kept }
   */
  async function switchToOwn(v, policy) {
    const info = await api('isolation:bringInfo', v.id, policy);
    return info.ask ? ask(v, policy, info) : null;
  }

  function ask(v, policy, first) {
    return new Promise((resolve) => {
      let info = first;
      let settled = false;
      let note = null;
      const body = h('div');
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      const m = A.modal({
        title: '要把公共目录的内容带过去吗？',
        subtitle: `${A.nm(A.displayName(v))} · ${A.versionSub(v)}`,
        icon: 'globe',
        size: 'lg',
        body,
        onClose: () => finish(false),
      });
      let s = selection(info, true);
      s.reset(info.items);

      const render = () => {
        A.mount(body,
          note ? h('div', { style: { marginBottom: '10px' } }, note) : null,
          h('p', { style: { margin: '0' } }, '这个配置以后用自己的存档和文件，不再和公共目录共用。'),
          info.worlds.length ? [
            heading(`公共目录里有 ${info.worlds.length} 个世界，一共 ${A.fmtBytes(info.total)}`),
            worldList(info),
            h('div.choices.cols-2', { style: { marginTop: '8px' } },
              A.choice({
                iconName: 'copy', title: '复制过来', badge: s.worldsFit() ? h('span.badge.accent', { style: { marginLeft: '6px' } }, '推荐') : null,
                desc: '在这个配置里放一份，可以接着玩。原来的世界不动，还在公共目录。之后两边各玩各的，进度不互通',
                on: s.worlds, disabled: !s.worldsFit(), onClick: () => { s.worlds = true; render(); },
              }),
              A.choice({
                iconName: 'shield', title: '不复制',
                desc: `这个配置从空的存档开始。世界留在公共目录，以后可以在「${t('backup.title')}」里点「从其他配置导入」复制过来`,
                on: !s.worlds, onClick: () => { s.worlds = false; render(); },
              })),
          ] : null,
          itemsBlock(s, render),
          warnings(info, s),
          info.conflicts.length ? hint('这个配置自己已有同名的世界，复制来的会改名，两份都留着。') : null,
          hint('复制不会动公共目录里原来的内容。自己已有的同名文件不会被覆盖。'));
        m.setActions([
          { label: t('common.cancel'), kind: 'ghost' },
          s.any()
            ? { label: '复制并改成独立', kind: 'primary', icon: 'copy', ref: (b) => { b.disabled = !s.ok(); }, onClick: () => { copy(); return false; } }
            : { label: '改成独立，不复制', kind: 'primary', icon: 'shield', onClick: async () => { finish({ ...(await api('isolation:set', v.id, policy)), copied: [], items: [], failed: [], kept: 0 }); return true; } },
        ]);
      };

      async function copy() {
        try {
          const r = await copying(m, body, v.id, () => api('isolation:bringWorlds', v.id, policy, { worlds: s.worlds ? info.worlds.map((w) => w.name) : [], items: [...s.picked] }));
          finish(r);
          m.close();
        } catch (e) {
          // 复制和切换任何一步没成功，都已经退回原样（core/isoworlds.js）
          note = e.cancelled
            ? A.alert({ level: 'info', compact: true, title: '已取消复制，什么都没改', text: '这个配置还在公共目录，原来的内容也没动。可以重新选。' })
            : A.alert({ level: 'crit', compact: true, title: '复制没成功，什么都没改', text: `${e.message}\n这个配置还在公共目录，原来的内容也没动，复制了一半的已经清理。` });
          const again = await api('isolation:bringInfo', v.id, policy).catch(() => null);
          if (again && again.ask) { info = again; s = selection(info, s.worlds); s.reset(info.items); }
          render();
        }
      }

      render();
    });
  }

  /** 切换完给玩家看的一句话 */
  function resultText(r) {
    const parts = [];
    if (r.copied.length) parts.push(`${r.copied.length} 个世界`);
    for (const k of r.items || []) parts.push(ITEM_NAME[k]);
    const failed = r.failed.map((x) => ITEM_NAME[x] || x);
    const renamed = r.copied.filter((c) => c.as !== c.name).map((c) => c.as);
    const lines = [];
    if (failed.length) lines.push(parts.length ? `复制了 ${parts.join('、')}，${A.nmJoin(failed)} 没带过去。原来的都还在公共目录，可以再导入` : `${A.nmJoin(failed)} 没带过去。原来的都还在公共目录，可以再导入`);
    else if (parts.length) lines.push(`复制了 ${parts.join('、')}，原来的还在公共目录`);
    else lines.push('内容都留在公共目录，世界以后可以导入');
    if (renamed.length) lines.push(`重名改成了：${A.nmJoin(renamed)}`);
    if (r.kept) lines.push(`自己已有的 ${r.kept} 项没有覆盖`);
    return lines.join('\n');
  }

  // ═════════════ 全局设置「独立游戏目录」 ═════════════
  const nameOf = (id) => { const v = A.state.installed.find((x) => x.id === id); return v ? A.displayName(v) : id; };
  const subOf = (id) => { const v = A.state.installed.find((x) => x.id === id); return v ? A.versionSub(v) : ''; };

  /** 返回 true：设置改了；false：取消了，什么都没改 */
  async function changeGlobal(next, label) {
    const g = await api('isolation:globalInfo', next);
    if (!g.outgoing.length && !g.incoming.length) { await A.setConfig({ isolation: next }); return true; }
    const ok = await (g.outgoing.length ? askOutgoing(next, label, g) : askIncoming(next, label, g));
    if (ok) await A.refreshInstalled();
    return ok;
  }

  function globalDone(r) {
    A.toast({ level: r.failed.length ? 'warn' : 'ok', title: '设置已保存', text: resultText(r) });
  }

  /** 配置搬到自己的文件夹 */
  function askOutgoing(next, label, first) {
    return new Promise((resolve) => {
      let g = first;
      let settled = false;
      let note = null;
      const body = h('div');
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      const m = A.modal({
        title: `改成「${label}」之前看一下`,
        icon: 'globe',
        size: 'lg',
        body,
        onClose: () => finish(false),
      });
      let s = selection(g, true);
      const fitsDefault = g.defaultTarget && s.worldsFit();
      let target = fitsDefault || (g.defaultTarget && !g.worlds.length) ? g.defaultTarget : '';
      const itemsOf = (id) => { const o = g.outgoing.find((x) => x.id === id); return o ? o.items : []; };
      s.reset(itemsOf(target), !!target && g.worlds.length > 0);

      const render = () => {
        const bringable = g.outgoing.filter((o) => o.canBring);
        const cur = g.outgoing.find((o) => o.id === target);
        A.mount(body,
          note ? h('div', { style: { marginBottom: '10px' } }, note) : null,
          h('p', { style: { margin: '0 0 6px' } }, `改成「${label}」后，这些配置会用自己的文件夹，不再和公共目录共用：`),
          h('div.world-list', { style: { maxHeight: '96px' } }, g.outgoing.map((o) => h('div.world-row', { style: { cursor: 'default', padding: '4px 10px' } },
            h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' }, 'data-no-tr': '' }, nameOf(o.id)),
            h('span.faint', { 'data-no-tr': '' }, subOf(o.id))))),
          g.hasContent ? [
            g.worlds.length ? heading(`公共目录里有 ${g.worlds.length} 个世界，一共 ${A.fmtBytes(g.total)}`) : null,
            h('div.field', { style: { marginTop: '10px', marginBottom: '0' } },
              h('label', g.worlds.length ? '把世界带给哪个配置' : '把这些内容带给哪个配置'),
              A.select({
                options: [...bringable.map((o) => ({ value: o.id, label: A.nm(nameOf(o.id)), sub: subOf(o.id) })), { value: '', label: '都不带', sub: '都留在公共目录' }],
                value: target, block: true, searchable: true,
                onChange: (val) => { target = val; s.reset(itemsOf(target), !!target && g.worlds.length > 0); render(); },
              })),
            g.worlds.length
              ? hint(`其他配置的存档从空开始。世界留在公共目录，以后可以在「${t('backup.title')}」里点「从其他配置导入」复制过来。复制不会动原来的世界，自己已有的同名文件不会被覆盖。`)
              : hint('其他配置从空的开始。内容留在公共目录。复制不会动原来的内容，自己已有的同名文件不会被覆盖。'),
            target ? itemsBlock(s, render) : null,
            target ? warnings(g, s) : (g.busy ? warnings(g, s) : null),
            cur && cur.conflicts.length ? hint('这个配置自己已有同名的世界，复制来的会改名，两份都留着。') : null,
          ] : hint('公共目录里没有要带过去的内容，这些配置从空的开始。'));
        m.setActions([
          { label: t('common.cancel'), kind: 'ghost' },
          target && s.any()
            ? { label: '复制并改设置', kind: 'primary', icon: 'copy', ref: (b) => { b.disabled = !s.ok(); }, onClick: () => { copy(); return false; } }
            : { label: '改设置', kind: 'primary', onClick: async () => { const r = await api('isolation:globalApply', next, {}); globalDone(r); finish(true); return true; } },
        ]);
      };

      async function copy() {
        try {
          const r = await copying(m, body, target, () => api('isolation:globalApply', next, { target, worlds: s.worlds ? g.worlds.map((w) => w.name) : [], items: [...s.picked] }));
          globalDone(r);
          finish(true);
          m.close();
        } catch (e) {
          note = e.cancelled
            ? A.alert({ level: 'info', compact: true, title: '已取消复制，设置没改', text: '原来的内容也没动。可以重新选。' })
            : A.alert({ level: 'crit', compact: true, title: '复制没成功，设置没改', text: `${e.message}\n原来的内容也没动，复制了一半的已经清理。` });
          const again = await api('isolation:globalInfo', next).catch(() => null);
          if (again) { const keep = s.worlds; g = again; s = selection(g, true); s.reset(itemsOf(target), keep); }
          render();
        }
      }

      render();
    });
  }

  /** 配置回到公共目录：自己文件夹里的内容还在，但用不到了 */
  function askIncoming(next, label, g) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      const body = h('div',
        h('p', { style: { margin: '0 0 6px' } }, `改成「${label}」后，这些配置会回到公共目录，和其他配置共用存档和 Mod：`),
        h('div.world-list', { style: { maxHeight: '160px' } }, g.incoming.map((x) => h('div.world-row', { style: { cursor: 'default', padding: '4px 10px' } },
          h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' }, 'data-no-tr': '' }, nameOf(x.id)),
          h('span.faint', x.worlds || x.mods ? [x.worlds ? `${x.worlds} 个世界` : '', x.mods ? `${x.mods} 个 Mod` : ''].filter(Boolean).join(' · ') : '自己的文件夹是空的'),
          h('button.btn.ghost.sm.icon', { 'data-tip': '打开文件夹', onclick: () => api('shell:open', x.dir).catch((e) => A.errorToast('无法打开', e)) }, icon('folder', 15))))),
        gap(10, A.alert({
          level: 'info', compact: true, title: '它们自己文件夹里的内容不会删除',
          text: `只是启动时用不到了，世界在游戏里会看不见。要拿回来：把这个设置改回去；或者在配置的「${t('term.isolation')}」里选「完全独立」。`,
        })));
      A.modal({
        title: `改成「${label}」之前看一下`,
        icon: 'globe',
        size: 'md',
        body,
        onClose: () => finish(false),
        actions: [
          { label: t('common.cancel'), kind: 'ghost' },
          { label: '改设置', kind: 'primary', onClick: async () => { await api('isolation:globalApply', next, {}); A.toast({ level: 'ok', title: '设置已保存', text: '这些配置现在用公共目录' }); finish(true); return true; } },
        ],
      });
    });
  }

  A.isoWorlds = { switchToOwn, ask, resultText, changeGlobal, askOutgoing, askIncoming };
})();
