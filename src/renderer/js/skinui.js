'use strict';
/* 皮肤管理抽屉：大预览、导入（文件 / 拖入 / 正版玩家名 / LittleSkin / 网址）、模型切换、披风、
 * 在游戏里怎么生效、皮肤库、游戏自带的默认皮肤。入口：账户页每张卡片的「皮肤」按钮 */
(function () {
  const { h, icon, api, state } = A;

  const METHODS = [
    { value: 'auto', label: '自动（推荐）', sub: '用启动器自带的本地皮肤服务；配置里装了 CustomSkinLoader 时也把皮肤写给它' },
    { value: 'service', label: '只用本地皮肤服务', sub: '不需要装 Mod。游戏运行期间启动器要保持开着' },
    { value: 'csl', label: '只用 CustomSkinLoader', sub: '只对装了 CustomSkinLoader 的配置有效，不改启动参数' },
    { value: 'none', label: '不在游戏里使用', sub: '只当作启动器里的头像' },
  ];
  const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
  const MODEL = [{ value: 'classic', label: '经典（Steve）' }, { value: 'slim', label: '纤细（Alex）' }];

  function open(account) {
    const texUrl = window.WEBURL.toHttps;
    const acc = () => state.accounts.accounts.find((a) => a.id === account.id) || account;
    const offline = account.type === 'offline';
    const st = { library: null, defaults: null, layer: true, walk: true, busy: false };
    const a0 = acc();
    const view = A.skinView({ ...shown(a0), cape: texUrl(a0.cape && a0.cape.url), size: 300 });
    const body = h('div.sk-drawer');
    const d = A.drawer({ title: `${A.nm(account.name)} 的皮肤`, subtitle: offline ? '离线账户 · 皮肤只保存在这台电脑上' : account.type === 'yggdrasil' ? `外置登录 · ${A.nm((account.server || {}).name) || ''}` : '微软正版账户', body, width: 560, onClose: () => off() });
    const off = A.on('accounts', () => { if (document.body.contains(d.el)) render(); });

    function variant(a) { return a.skin && a.skin.variant === 'SLIM' ? 'slim' : 'classic'; }
    /** 预览里显示的皮肤：没有皮肤时显示默认皮肤（1.5.7 之前是空白）——装了原版游戏就用游戏自带的 Steve / Alex，没有就用启动器画的 */
    function shown(a) {
      if (a.skin && a.skin.url) return { url: texUrl(a.skin.url), model: variant(a) };
      const kind = A.defaultSkinKind(a.uuid);
      const own = (st.defaults || []).find((x) => x.name === kind);
      return { url: own ? A.skinTools.dataUrl(own.png) : A.defaultSkin(kind), model: kind === 'alex' ? 'slim' : 'classic' };
    }

    async function set(patch, okText) {
      if (st.busy) return;
      st.busy = true;
      try {
        await api('skins:set', account.id, patch);
        await A.refreshAccounts();
        if (okText) A.toast({ level: 'ok', text: okText });
      } catch (e) { A.errorToast('设置皮肤失败', e); } finally { st.busy = false; render(); }
    }

    /** 导入一张皮肤图片（base64）：整理成 64×64、识别模型，再保存 */
    async function useSkin(b64, { model, cape, name, keepModel, noCape } = {}) {
      let n;
      try { n = await A.skinTools.normalize(b64); } catch (e) { A.errorToast('不能用这张图片', e); return; }
      const patch = { skin: n.png, model: keepModel ? variant(acc()) : model || n.model };
      if (cape !== undefined) {
        try { patch.cape = cape ? await A.skinTools.normalizeCape(cape) : null; } catch { /* 披风不对就不要了 */ }
      }
      // 勾了「有披风的话也一起用」但对方没有披风时说一声（rc4：Notch 现在就没有披风，以前什么都不说，像是披风没显示出来）
      await set(patch, `已换上${name ? `「${A.nm(name)}」的` : '新的'}皮肤${n.legacy ? '（旧版 64×32 已自动转换）' : ''}${noCape ? '；这位玩家现在没有戴披风' : ''}${patch.cape ? '；披风在背后，点「看披风」转过去看' : ''}`);
    }

    function pickFile(kind) {
      const input = h('input', { type: 'file', accept: '.png,image/png', style: { display: 'none' } });
      input.addEventListener('change', async () => {
        const f = input.files[0];
        input.remove();
        if (!f) return;
        try {
          const b64 = await A.skinTools.readFile(f);
          if (kind === 'cape') await set({ cape: await A.skinTools.normalizeCape(b64) }, '已换上披风');
          else await useSkin(b64, { name: f.name.replace(/\.png$/i, '') });
        } catch (e) { A.errorToast('导入失败', e); }
      });
      document.body.append(input);
      input.click();
    }

    function fetchDialog() {
      const st2 = { source: 'mojang' };
      const input = h('input.input', { spellcheck: 'false' });
      const withCape = h('input', { type: 'checkbox', checked: true });
      const hint = h('div.hint');
      const seg = A.seg([{ value: 'mojang', label: '正版玩家名' }, { value: 'littleskin', label: 'LittleSkin' }, { value: 'url', label: '图片网址' }], st2.source, (v) => { st2.source = v; sync(); });
      function sync() {
        input.placeholder = st2.source === 'url' ? 'https://…/skin.png' : st2.source === 'mojang' ? '例如 Notch' : 'LittleSkin 上的角色名';
        hint.textContent = st2.source === 'mojang' ? '复制这位正版玩家现在用的皮肤（会联网查询 Mojang）'
          : st2.source === 'littleskin' ? '从 LittleSkin 皮肤站下载这个角色的皮肤' : '直接下载一张 PNG 皮肤图片';
        withCape.closest('label') && withCape.closest('label').classList.toggle('hidden', st2.source === 'url');
      }
      const m = A.modal({
        title: '从网上获取皮肤', icon: 'download', size: 'sm',
        body: h('div', h('div', { style: { marginBottom: '12px' } }, seg), h('div.field', input, hint), h('label.row', { style: { cursor: 'pointer', fontSize: '13px' } }, withCape, '有披风的话也一起用')),
        actions: [
          { label: '取消', kind: 'ghost' },
          {
            label: '获取并使用', kind: 'primary', errorTitle: '获取失败',
            onClick: async () => {
              const value = input.value.trim();
              if (!value) { A.toast({ level: 'warn', text: '请先填写内容' }); return false; }
              if (!A.offline.check()) return false; // 断网：对话框留着（填的内容还在），联网后再点
              const r = await api('skins:fetch', { source: st2.source, value });
              await useSkin(r.skin, { model: r.model, cape: st2.source !== 'url' && withCape.checked ? r.cape : undefined, name: r.name, noCape: st2.source !== 'url' && withCape.checked && !r.cape });
              return true;
            },
          },
        ],
      });
      sync();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelector('.btn.primary').click(); });
      setTimeout(() => input.focus(), 50);
    }

    async function loadLists() {
      try { st.library = await api('skins:library'); } catch { st.library = []; }
      render();
      try { st.defaults = await api('skins:defaults'); } catch { st.defaults = []; }
      render();
    }

    async function saveToLibrary() {
      try {
        st.library = await api('skins:collect', account.id);
        A.toast({ level: 'ok', text: '已收藏到皮肤库' });
        render();
      } catch (e) { A.errorToast('收藏失败', e); }
    }

    function thumb(url, model, onClick, extra) {
      const mini = A.skinView({ url, model, size: 92 });
      mini.set({ walk: false });
      mini.el.classList.add('sk-mini');
      return h('div.sk-tile', { onclick: onClick }, mini.el, extra || null);
    }

    function render() {
      const a = acc();
      view.set({ ...shown(a), cape: texUrl(a.cape && a.cape.url), layer: st.layer, walk: st.walk });
      const custom = !!(a.skin && a.skin.custom);
      const method = a.skinMethod || 'auto';
      const drop = h('div.sk-stage', view.el,
        !a.skin ? h('div.sk-empty', '还在用默认皮肤') : null,
        h('div.sk-stage-tools',
          h('label.row', A.toggle(st.layer, (v) => { st.layer = v; render(); }), '外层'),
          view.flat ? null : h('label.row', A.toggle(st.walk, (v) => { st.walk = v; render(); }), '走动'),
          A.skinTools.turnButton(view, { hasCape: !!a.cape }),
          h('span.faint', view.flat ? '性能模式下是平面预览，点人物看背面' : '拖动可以旋转')));
      if (offline) {
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drop-hover'); });
        drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('drop-hover'); });
        drop.addEventListener('drop', async (e) => {
          e.preventDefault(); drop.classList.remove('drop-hover');
          const f = e.dataTransfer.files[0];
          if (!f) return;
          try { await useSkin(await A.skinTools.readFile(f), { name: f.name.replace(/\.png$/i, '') }); } catch (err) { A.errorToast('导入失败', err); }
        });
      }

      // 外置登录（1.8.0）：皮肤在认证服务器的网站上改
      if (account.type === 'yggdrasil') {
        const srv = account.server || {};
        A.mount(body, drop,
          A.alert({ level: 'info', text: `外置登录账户的皮肤保存在 ${A.nm(srv.name) || '认证服务器'} 上，进它的服务器时大家都能看到。要换皮肤，请到它的网站上修改，改完回来点账户卡片上的「刷新」。` }),
          srv.homepage ? h('div.row', { style: { marginTop: '12px' } },
            h('button.btn', { onclick: () => api('shell:external', srv.homepage) }, icon('external', 15), `打开 ${A.nm(srv.name)} 网站`)) : null);
        return;
      }
      if (!offline) {
        A.mount(body, drop,
          A.alert({ level: 'info', text: '正版账户的皮肤保存在 Mojang 的服务器上，所有启动器和服务器都会看到。要换皮肤，请到 Minecraft 官网的个人资料页修改，改完回来点账户卡片上的「刷新」。' }),
          h('div.row', { style: { marginTop: '12px' } },
            h('button.btn', { onclick: () => api('shell:external', 'https://www.minecraft.net/msaprofile/mygames/editskin') }, icon('external', 15), '打开官网换皮肤')));
        return;
      }

      A.mount(body,
        drop,
        h('div.sk-actions',
          h('button.btn.primary', { onclick: () => pickFile('skin') }, icon('import', 15), '导入图片'),
          h('button.btn', { onclick: fetchDialog }, icon('download', 15), '从网上获取'),
          custom ? h('button.btn.ghost', { onclick: saveToLibrary }, icon('star', 15), '收藏') : null,
          custom ? h('button.btn.ghost', { onclick: () => set({ skin: null }, '已恢复默认皮肤') }, icon('refresh', 15), '恢复默认') : null),
        h('div.hint', { style: { marginTop: '6px' } }, '也可以把 PNG 皮肤直接拖到上面的人物上。旧版 64×32 的皮肤会自动转换'),

        custom ? h('div.sk-sec',
          h('h4', '模型'),
          A.seg(MODEL, variant(a), (v) => set({ model: v })),
          h('div.hint', '导入时会自动识别；手臂看起来有缝或者太粗时可以手动切换')) : null,

        custom ? h('div.sk-sec',
          h('h4', '披风'),
          h('div.row.gap-s',
            h('button.btn.sm', { onclick: () => pickFile('cape') }, icon('import', 14), a.cape ? '更换披风' : '导入披风'),
            a.cape ? h('button.btn.sm.ghost', { onclick: () => set({ cape: null }, '已去掉披风') }, icon('x', 14), '去掉') : null),
          h('div.hint', '披风只有你自己在这台电脑上看得到（64×32 的 PNG）')) : null,

        custom ? h('div.sk-sec',
          h('h4', '在游戏里怎么生效'),
          A.select({ options: METHODS, value: method, width: 300, menuWidth: 380, onChange: (v) => set({ method: v }) }),
          h('div.hint', (METHODS.find((m) => m.value === method) || METHODS[0]).sub),
          method === 'auto' || method === 'service' ? h('div.hint', '本地皮肤服务只在这台电脑上提供皮肤：单人游戏、你自己开的局域网里能看到；别人要看到你的皮肤，需要他们也装 CustomSkinLoader 之类的 Mod 并能读到你的皮肤') : null) : null,

        h('div.sk-sec',
          h('h4', '皮肤库', h('span.faint', st.library ? ` · ${st.library.length}` : '')),
          st.library === null ? h('div.row', h('span.spinner'))
            : !st.library.length ? h('div.hint', '点上面的「收藏」把当前皮肤存进来，以后可以一键换回去')
              : h('div.sk-grid', st.library.map((it) => thumb(it.url, it.model, async () => {
                try { await useSkin(await api('skins:libraryRead', it.hash), { model: it.model, name: it.name }); } catch (e) { A.errorToast('读取失败', e); }
              }, h('button.btn.icon.ghost.sm.sk-del', {
                'data-tip': '从皮肤库删除',
                onclick: async (e) => { e.stopPropagation(); st.library = await api('skins:libraryRemove', it.hash); render(); },
              }, icon('x', 13)))))),

        h('div.sk-sec',
          h('h4', '游戏自带的皮肤'),
          st.defaults === null ? h('div.row', h('span.spinner'), h('span.muted', '从已安装的游戏里查找…'))
            : !st.defaults.length ? h('div.hint', '先安装一个原版游戏，这里就会列出它自带的默认皮肤（1.19.3 以上有 9 种）')
              : h('div.sk-grid', st.defaults.map((it) => thumb(A.skinTools.dataUrl(it.png), it.model, () => useSkin(it.png, { model: it.model, name: cap(it.name) }),
                h('div.sk-cap', `${A.nm(cap(it.name))}${it.model === 'slim' ? ' · 纤细' : ''}`))))));
    }

    render();
    loadLists();
    return d;
  }

  /** 「启动后关闭启动器」遇到本地皮肤服务：问玩家怎么办；返回 'keep' | 'close' | null（取消启动） */
  function closeChoice(account) {
    const cfg = state.config;
    if (cfg.afterLaunch !== 'close' || !account || account.type !== 'offline' || !account.skin || !account.skin.custom) return Promise.resolve('');
    if (!['auto', 'service'].includes(account.skinMethod || 'auto')) return Promise.resolve('');
    const saved = (cfg.skin || {}).closeChoice;
    if (saved === 'keep' || saved === 'close') return Promise.resolve(saved);
    return new Promise((resolve) => {
      const remember = h('input', { type: 'checkbox' });
      let done = false;
      const pick = async (v) => {
        done = true;
        if (remember.checked) await A.setConfig({ skin: { ...(cfg.skin || {}), closeChoice: v } });
        resolve(v);
      };
      A.modal({
        title: '游戏启动后要关闭启动器吗？', icon: 'user', size: 'sm',
        body: h('div',
          h('p', { style: { marginTop: 0 } }, '你设置了「启动游戏后关闭启动器」，但这个账户的皮肤要靠启动器里的本地皮肤服务提供。启动器关掉以后，游戏里就看不到你的皮肤了。'),
          h('label.row', { style: { cursor: 'pointer', fontSize: '13px' } }, remember, '记住我的选择'),
          h('div.hint', '记住以后可以随时在「设置 → 启动器」里修改')),
        actions: [
          { label: '取消启动', kind: 'ghost', onClick: () => { done = true; resolve(null); } },
          { label: '照常关闭（看不到皮肤）', kind: '', onClick: () => pick('close') },
          { label: '游戏结束后再关', kind: 'primary', onClick: () => pick('keep') },
        ],
        onClose: () => { if (!done) resolve(null); },
      });
    });
  }

  A.skinDrawer = open;
  A.skinCloseChoice = closeChoice;
})();
