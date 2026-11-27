'use strict';
/* 账户管理：离线账户 + 外置登录（LittleSkin 等 Yggdrasil 服务器，1.8.0）+ 微软正版（设备代码登录） */
(function () {
  const { h, icon, api, state, on, $ } = A;

  let root;
  let gridEl;

  const msReady = () => A.FEATURES.msLogin;

  /** 账户类型的说法（侧边栏、主页、账户页共用） */
  A.accountLabel = (a) => (!a ? '' : a.type === 'microsoft' ? '微软正版' : a.type === 'yggdrasil' ? `外置登录 · ${A.nm((a.server || {}).name) || ''}` : '离线账户');

  function build() {
    root = $('#page-accounts');
    gridEl = h('div.acc-grid.fade-list');
    A.mount(root, h('div.page-inner',
      h('div.page-head',
        h('div', h('h1', '账户'), h('p', msReady() ? '使用微软账户登录正版、用皮肤站账号外置登录，或创建离线账户进行单人游戏' : '创建离线账户进行游戏，或用 LittleSkin 等皮肤站的账号外置登录；微软正版登录正在申请')),
        h('div.actions',
          h('button', { class: `btn ${msReady() ? '' : 'primary'}`, onclick: addOffline }, icon('user', 16), '离线账户'),
          h('button.btn', { onclick: () => addYgg(), 'data-net': '' }, icon('globe', 16), '外置登录'),
          msReady()
            ? h('button.btn.primary', { onclick: addMicrosoft, 'data-net': '' }, A.msLogo(15), '微软登录')
            : h('button.btn.dev-soon', { onclick: A.msPendingNotice, 'data-tip': A.MS_PENDING }, A.msLogo(15), '微软登录', h('span.soon-tag', '正在申请')))),
      gridEl));
  }

  function render() {
    if (!gridEl) return;
    const { accounts, selected } = state.accounts;
    const cards = accounts.map((a) => {
      const cur = a.id === selected;
      const ms = a.type === 'microsoft';
      const ygg = a.type === 'yggdrasil';
      return h('div', { class: `acc-card ${cur ? 'current' : ''}` },
        cur ? h('span.badge.accent.current-tag', icon('check', 12), '当前') : null,
        A.avatar(a, 76),
        h('div.a-name', A.noTr(a.name)),
        h('div.row.gap-s', { style: { position: 'relative' } },
          ms ? h('span.badge.ok', A.msLogo(10), '微软正版') : ygg ? h('span.badge.info', icon('globe', 12), A.nm((a.server || {}).name) || '外置登录') : h('span.badge', icon('key', 12), '离线'),
          a.needRelogin ? h('span.badge.danger', '需要重新登录') : null),
        h('div.a-uuid.selectable', a.uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')),
        h('div.a-actions',
          cur ? null : h('button.btn.sm.primary', { onclick: () => api('accounts:select', a.id) }, '使用'),
          h('button.btn.sm', { onclick: () => A.skinDrawer(a) }, icon('palette', 14), '皮肤'),
          ms || ygg ? h('button.btn.sm', { onclick: (e) => refresh(a, e.currentTarget), 'data-net': '' }, icon('refresh', 14), '刷新') : null,
          ms && a.needRelogin ? h('button.btn.sm', { onclick: addMicrosoft, 'data-net': '' }, '重新登录') : null,
          ygg && a.needRelogin ? h('button.btn.sm', { onclick: () => addYgg(a), 'data-net': '' }, '重新登录') : null,
          h('button.btn.sm.icon.ghost', { 'data-tip': '复制 UUID', onclick: () => A.copy(a.uuid) }, icon('copy', 14)),
          h('button.btn.sm.icon.ghost', { 'data-tip': '删除账户', onclick: () => remove(a) }, icon('trash', 14))));
    });
    const add = h('div.acc-card.acc-add', { onclick: chooseAdd },
      h('div.plus', icon('plus', 26)), h('div', { style: { fontWeight: 650, color: 'var(--text)' } }, '添加账户'), h('div', { style: { fontSize: '12.5px' } }, msReady() ? '微软正版、外置登录 或 离线' : '离线账户 或 外置登录'));
    A.mount(gridEl, ...cards, add);
  }

  function chooseAdd(e) {
    A.menu(e.currentTarget, [
      msReady() ? { label: '微软账户', sub: '正版登录，可进入正版服务器', icon: 'shield', onClick: addMicrosoft, net: true }
        : { label: '微软账户', sub: '正在申请，暂时还不能用', icon: 'shield', disabled: true, tip: A.MS_PENDING, onClick: A.msPendingNotice },
      { label: '外置登录', sub: 'LittleSkin 或其他皮肤站 / 认证服务器的账号', icon: 'globe', onClick: () => addYgg(), net: true },
      { label: '离线账户', sub: '只需输入玩家名', icon: 'user', onClick: addOffline },
    ]);
  }

  async function refresh(a, btn) {
    btn.disabled = true;
    try { await api('accounts:refresh', a.id); A.toast({ level: 'ok', text: `${A.nm(a.name)} 的登录信息已刷新` }); } catch (e) { A.errorToast('刷新失败', e); } finally { btn.disabled = false; }
  }

  async function remove(a) {
    if (!(await A.confirm(`确定要删除账户「${A.nm(a.name)}」吗？`, { danger: true, okText: '删除' }))) return;
    await api('accounts:remove', a.id);
  }

  // ── 离线账户 ──
  function addOffline() {
    const preview = h('div', { style: { display: 'flex', justifyContent: 'center', margin: '4px 0 18px' } });
    const name = h('input.input', { placeholder: '例如 Steve', maxlength: 16, spellcheck: 'false' });
    const uuidLine = h('div.hint.mono');
    const err = h('div.err.hidden');
    const custom = h('input.input.mono.hidden', { placeholder: '自定义 UUID（32 位十六进制，可带连字符）', spellcheck: 'false', style: { marginTop: '8px' } });
    const update = async () => {
      const n = name.value.trim();
      const uuid = n ? await api('accounts:offlineUUID', n) : '';
      A.mount(preview, A.avatar(n ? { uuid } : null, 72));
      uuidLine.textContent = n ? `UUID：${uuid}` : '与原版服务器一致的离线 UUID';
      const ok = !n || /^[A-Za-z0-9_]{3,16}$/.test(n);
      err.textContent = ok ? '' : '玩家名需为 3~16 位英文字母、数字或下划线';
      err.classList.toggle('hidden', ok);
    };
    name.addEventListener('input', update);
    update();
    const m = A.modal({
      title: '添加离线账户',
      subtitle: '离线账户只能进入关闭了正版验证的服务器',
      icon: 'user',
      size: 'sm',
      body: h('div', preview,
        h('div.field', h('label', '玩家名'), name, err, uuidLine),
        h('label.row', { style: { cursor: 'pointer', fontSize: '13px' } }, A.toggle(false, (v) => custom.classList.toggle('hidden', !v)), '使用自定义 UUID'),
        custom),
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '添加', kind: 'primary', errorTitle: '添加失败',
          onClick: async () => {
            await api('accounts:addOffline', name.value.trim(), custom.classList.contains('hidden') ? '' : custom.value.trim());
            A.toast({ level: 'ok', text: `已添加离线账户 ${name.value.trim()}` });
          },
        },
      ],
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelector('.btn.primary').click(); });
  }

  // ── 外置登录（1.8.0） ──
  // 选服务器（LittleSkin 预设 / 自己填地址）→ 用户名（多数是邮箱）+ 密码 → 账号下有几个角色就让玩家选一个。
  // 密码只在这个对话框里、只发给认证服务器这一次，不保存；again 是要重新登录的那个账户（服务器和用户名不变）
  async function addYgg(again) {
    const presets = await api('accounts:yggPresets').catch(() => []);
    const st = { server: again && again.server ? again.server.root : (presets[0] ? presets[0].url : ''), custom: !!(again && again.server && !presets.some((p) => p.url === again.server.root)), pick: null };
    const serverSel = A.seg([...presets.map((p) => ({ value: p.url, label: A.nm(p.name) })), { value: '', label: '其他服务器' }], st.custom ? '' : st.server, (v) => {
      st.custom = !v; if (v) st.server = v; urlField.classList.toggle('hidden', !st.custom); if (st.custom) url.focus();
    });
    const url = h('input.input.mono', { placeholder: '认证服务器地址，例如 https://example.com/api/yggdrasil', spellcheck: 'false', value: st.custom ? st.server : '' });
    // http 地址：轻轻提一句，不吓人（大部分玩家不懂这些，别弄得像出了大问题）
    const httpHint = h('div.hint', '小提示：这是 http 地址，登录时密码在网上传输不加密。自己或朋友在家里搭的服务器一般没关系；皮肤站有 https 地址的话，换成 https 更好。');
    const checkHttp = () => httpHint.classList.toggle('hidden', !/^http:\/\//i.test(url.value.trim()));
    url.addEventListener('input', checkHttp);
    checkHttp();
    const urlField = h('div.field', { class: st.custom ? '' : 'hidden' }, h('label', '认证服务器地址'), url, h('div.hint', '填皮肤站给的 Yggdrasil 地址，或者皮肤站首页的地址也行（会自动找到真正的接口）'), httpHint);
    const user = h('input.input', { placeholder: '一般是注册用的邮箱', spellcheck: 'false', autocomplete: 'username' });
    const pass = h('input.input', { type: 'password', placeholder: '密码', autocomplete: 'current-password' });
    const pickBox = h('div');
    const m = A.modal({
      title: again ? `重新登录 ${A.nm(again.name)}` : '外置登录',
      subtitle: '用皮肤站 / 认证服务器的账号进它的服务器，别人也能看到你在那里设的皮肤',
      icon: 'globe',
      size: 'md',
      body: h('div',
        h('div.field', h('label', '认证服务器'), serverSel),
        urlField,
        h('div.field', h('label', '用户名'), user),
        h('div.field', h('label', '密码'), pass, h('div.hint', '密码只发给这个认证服务器用来登录，启动器不保存；以后启动时用它给的登录凭证，过期了会请你重新登录')),
        pickBox),
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '登录', kind: 'primary', errorTitle: '登录失败',
          onClick: async () => {
            const server = st.custom ? url.value.trim() : st.server;
            const r = await api('accounts:yggLogin', { server, username: user.value.trim(), password: pass.value, profileId: st.pick });
            if (r.pick) {
              // 一个账号下有好几个角色：列出来选一个，再点一次「登录」
              st.pick = r.pick[0].id;
              A.mount(pickBox, h('div.field', h('label', `这个账号在 ${A.nm(r.server)} 上有 ${r.pick.length} 个角色，选一个用`),
                A.select({ options: r.pick.map((p) => ({ value: p.id, label: A.nm(p.name) })), value: st.pick, onChange: (v) => { st.pick = v; }, block: true })));
              return false;
            }
            pass.value = '';
            A.toast({ level: 'ok', text: `已登录 ${A.nm(r.account.name)}（${A.nm((r.account.server || {}).name) || '外置登录'}）` });
            return true;
          },
        },
      ],
    });
    (st.custom ? url : user).focus();
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelector('.btn.primary').click(); });
  }

  // ── 微软账户 ──
  async function addMicrosoft() {
    if (!msReady()) return A.msPendingNotice();
    if (A.offline && !A.offline.check()) return;
    const body = h('div', h('div.row', { style: { justifyContent: 'center', padding: '30px' } }, h('span.spinner.lg')));
    let cancelled = false;
    let active = true;
    let off = null;
    const m = A.modal({
      title: '使用微软账户登录',
      icon: h('div.modal-ico', { style: { background: 'var(--surface-2)' } }, A.msLogo(20)),
      size: 'md',
      body,
      actions: [{ label: '取消', kind: 'ghost' }],
      onClose: () => {
        cancelled = true;
        if (off) { off(); off = null; }
        if (active) { active = false; api('accounts:msCancel').catch(() => {}); }
      },
    });
    let dc;
    try {
      dc = await api('accounts:msStart');
    } catch (e) {
      active = false;
      if (cancelled) return;
      A.mount(body, A.alert({ level: 'crit', text: e.message }),
        h('p.faint', { style: { fontSize: '12.5px' } }, '请检查网络连接；如果设置了自定义 Client ID，请确认它正确且已开启「允许公共客户端流」。'));
      m.setActions([
        { label: '修改 Client ID', kind: 'ghost', onClick: () => { setTimeout(() => clientIdDialog(addMicrosoft), 50); } },
        { label: '重试', kind: 'primary', onClick: () => { setTimeout(addMicrosoft, 50); } },
        { label: '关闭', kind: '' },
      ]);
      return;
    }
    if (cancelled) { active = false; api('accounts:msCancel').catch(() => {}); return; }
    const step = h('div.row', { style: { justifyContent: 'center', marginTop: '16px', color: 'var(--text-2)', fontSize: '13px' } }, h('span.spinner'), h('span', '等待你在浏览器中完成登录…'));
    // 自动把设备码放进剪贴板：复制成了才说「已自动复制」（窗口没有焦点时会失败），失败不打断登录流程
    const first = h('li', '点击下方按钮打开微软登录页面');
    A.copy(dc.userCode, { quiet: true }).then((ok) => { first.textContent = ok ? '点击下方按钮打开微软登录页面（代码已自动复制）' : '点击下方按钮复制代码并打开微软登录页面'; });
    A.mount(body,
      h('ol.steps',
        first,
        h('li', '粘贴下面的代码，并使用拥有 Minecraft 的微软账户登录'),
        h('li', '授权完成后回到这里，启动器会自动完成登录')),
      h('div.ms-code', dc.userCode),
      h('div.row', { style: { justifyContent: 'center', marginTop: '14px' } },
        // 先复制完再打开浏览器：浏览器一抢走焦点，剪贴板就写不进去了
        h('button.btn.primary', { onclick: async () => { await A.copy(dc.userCode); api('shell:external', dc.verificationUri); } }, icon('external', 16), '复制代码并打开登录页'),
        h('button.btn.ghost', { onclick: () => A.copy(dc.userCode) }, icon('copy', 16), '仅复制')),
      step);
    off = A.listen('accounts:msStep', (s) => { if (step.lastChild) step.lastChild.textContent = s; });
    try {
      const acc = await api('accounts:msWait');
      active = false;
      if (off) { off(); off = null; }
      if (cancelled) return;
      m.close();
      A.toast({ level: 'ok', title: '登录成功', text: `欢迎回来，${A.nm(acc.name)}！` });
    } catch (e) {
      active = false;
      if (off) { off(); off = null; }
      if (cancelled || e.cancelled) return;
      A.mount(body, A.alert({ level: 'crit', text: e.message }));
      m.setActions([
        { label: '修改 Client ID', kind: 'ghost', onClick: () => { setTimeout(() => clientIdDialog(addMicrosoft), 50); } },
        { label: '重试', kind: 'primary', onClick: () => { setTimeout(addMicrosoft, 50); } },
        { label: '关闭', kind: '' },
      ]);
    }
  }

  const CLIENT_ID_BAD = 'Client ID 格式不正确：应该是「应用程序(客户端) ID」那一串，形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
  function clientIdDialog(after) {
    const input = h('input.input.mono', { value: state.config.msClientId || '', placeholder: '留空使用内置默认', spellcheck: 'false' });
    A.modal({
      title: '配置微软登录',
      subtitle: '启动器已内置通过审核的 Azure 应用，留空即使用内置默认；也可以填写自定义 Client ID',
      icon: 'key',
      size: 'md',
      body: h('div',
        h('p.muted', { style: { marginTop: 0, fontSize: '13px' } }, '一般玩家无需修改这里。如需使用自己的 Azure 应用，只需配置一次：'),
        h('ol.steps',
          h('li', h('span', '打开 ', h('a', { onclick: () => api('shell:external', 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade') }, 'Azure 门户 → 应用注册'), '，新建注册，账户类型选择「仅个人 Microsoft 账户」')),
          h('li', '在「身份验证」中开启「允许公共客户端流」'),
          h('li', h('span', '复制「应用程序(客户端) ID」，并在 ', h('a', { onclick: () => api('shell:external', 'https://aka.ms/mce-reviewappid') }, 'aka.ms/mce-reviewappid'), ' 提交申请 Minecraft API 权限（审核通过后即可正常登录）'))),
        h('div.field', { style: { marginTop: '16px' } }, h('label', 'Client ID'), input, h('div.hint', '留空即恢复内置默认；也可以随时在「设置 → 常规 → 微软登录」中修改'))),
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          // 从登录流程里打开的（after）：保存完接着登录；从设置里打开的：只是保存
          label: after ? '保存并继续' : '保存', kind: 'primary',
          onClick: async () => {
            const v = input.value.trim();
            if (v && !window.WEBURL.isClientId(v)) { A.toast({ level: 'warn', text: CLIENT_ID_BAD }); return false; }
            await A.setConfig({ msClientId: v });
            if (after) setTimeout(after, 50);
            return true;
          },
        },
      ],
    });
  }

  function init() {
    build();
    on('accounts', A.pageRefresher('accounts', render));
    render();
  }

  A.pages.accounts = { init, show: (p) => { render(); if (p && p.add) chooseAddDefault(); }, title: '账户' };
  function chooseAddDefault() {
    setTimeout(() => {
      const card = root.querySelector('.acc-add');
      if (card) chooseAdd({ currentTarget: card });
    }, 80);
  }
  A.clientIdDialog = clientIdDialog;
})();
