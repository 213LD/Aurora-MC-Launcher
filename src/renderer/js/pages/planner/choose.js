'use strict';
/* Mod 配置器：第 1 步：版本与玩法 */
(function () {
  const { h, icon, api, state } = A;
  const K = A.plannerKit;
  const { LOADER_INFO, P, save } = K;

  async function loadLoaderAvail(mc) {
    if (P.loaderAvail[mc]) return;
    P.loaderAvail[mc] = 'loading';
    const out = {};
    await Promise.all(['fabric', 'forge', 'neoforge', 'quilt'].map(async (l) => {
      try { out[l] = (await api('loaders:list', l, mc)).length; } catch { out[l] = -1; }
    }));
    P.loaderAvail[mc] = out;
    if (P.step === 1 && P.plan.mc === mc) {
      if (out[P.plan.loader] === 0) {
        const first = ['fabric', 'neoforge', 'forge', 'quilt'].find((l) => out[l] > 0);
        if (first) P.plan.loader = first;
      }
      renderChoose();
    }
  }

  function renderChoose() {
    const p = P.plan;
    const meta = P.meta || { styles: [], versions: [] };
    if (p.mode === 'edit') {
      // 修改已有配置：版本与加载器已锁定，只需选择想新增的玩法
      A.mount(K.body,
        h('div.pl-section',
          h('div.pl-label', h('b', '+'), '想给这个配置再加点什么？', h('span.faint', { style: { fontWeight: 400, fontSize: '12.5px' } }, '选择后会推荐适用于该版本的 Mod，已安装的不会重复添加')),
          h('div.style-grid', meta.styles.map((s) => {
            const onSel = p.styles.includes(s.id);
            return h('div', { class: `style-card ${onSel ? 'on' : ''}`, onclick: () => { p.styles = onSel ? p.styles.filter((x) => x !== s.id) : [...p.styles, s.id]; renderChoose(); } },
              h('div.sc-ico', icon(s.icon, 20)), h('div.sc-name', s.name), h('div.sc-desc', s.desc), h('div.sc-check', icon('check', 13, 3)));
          }))),
        h('div.pl-foot', h('div.spacer'),
          h('button.btn', { onclick: () => K.goStep(2) }, '直接调整清单'),
          h('button.btn.primary.lg', { disabled: !p.styles.length, onclick: generate }, icon('sparkles', 18), '推荐并加入清单')));
      return;
    }
    const latest = state.manifest && state.manifest.latest && state.manifest.latest.release;
    const vcards = [...meta.versions];
    if (latest && !vcards.some((v) => v.mc === latest)) vcards.unshift({ mc: latest, tag: '最新版本', loaders: ['fabric', 'neoforge'] });
    const inList = vcards.some((v) => v.mc === p.mc);
    const releases = state.manifest ? state.manifest.versions.filter((v) => v.type === 'release') : [];
    const avail = P.loaderAvail[p.mc];
    if (!avail) loadLoaderAvail(p.mc);
    const rec = (vcards.find((v) => v.mc === p.mc) || {}).loaders || [];
    const nameIn = h('input.input', { value: p.name, placeholder: defaultName(), oninput: (e) => { p.name = e.target.value; save(); } });

    A.mount(K.body,
      h('div.pl-section',
        h('div.pl-label', h('b', '1'), '选择游戏版本'),
        h('div.vchips',
          vcards.map((v) => h('div', { class: `vchip ${p.mc === v.mc ? 'on' : ''}`, onclick: () => { p.mc = v.mc; P.resolved = null; nameIn.placeholder = defaultName(); renderChoose(); save(); } },
            h('img', { src: A.blockImage('grass', 48) }), h('div', h('div.vc-mc', v.mc), h('div.vc-tag', v.tag)))),
          h('div', { class: `vchip other ${!inList ? 'on' : ''}` },
            A.select({ options: releases.map((r) => ({ value: r.id, label: r.id, sub: A.fmtDate(r.releaseTime) })), value: inList ? null : p.mc, placeholder: '其他版本…', searchable: true, width: 150, small: true, onChange: (v) => { p.mc = v; P.resolved = null; renderChoose(); save(); } })))),

      h('div.pl-section',
        h('div.pl-label', h('b', '2'), '选择 Mod 加载器', avail === 'loading' || !avail ? h('span.spinner', { style: { width: '14px', height: '14px', borderWidth: '2px' } }) : null),
        h('div.lcards', ['fabric', 'neoforge', 'forge', 'quilt'].map((l) => {
          const n = avail && avail !== 'loading' ? avail[l] : null;
          const unavailable = n === 0;
          return h('div', { class: `lcard ${p.loader === l ? 'on' : ''} ${unavailable ? 'unavailable' : ''}`, onclick: () => { if (unavailable) return; p.loader = l; P.resolved = null; renderChoose(); save(); } },
            h('img', { src: A.blockImage(LOADER_INFO[l].kind, 64) }),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div.row.gap-s', h('b', A.LOADERS[l].name), rec[0] === l ? h('span.badge.accent', '推荐') : rec.includes(l) ? h('span.badge', '常用') : null, unavailable ? h('span.badge.crit', '不支持') : null),
              h('div.lc-desc', LOADER_INFO[l].desc)));
        }))),

      h('div.pl-section',
        h('div.pl-label', h('b', '3'), '想玩什么类型？', h('span.faint', { style: { fontWeight: 400, fontSize: '12.5px' } }, '可多选，配置器会按类型推荐精选与热门 Mod')),
        h('div.style-grid', meta.styles.map((s) => {
          const onSel = p.styles.includes(s.id);
          return h('div', { class: `style-card ${onSel ? 'on' : ''}`, onclick: () => { p.styles = onSel ? p.styles.filter((x) => x !== s.id) : [...p.styles, s.id]; renderChoose(); save(); } },
            h('div.sc-ico', icon(s.icon, 20)), h('div.sc-name', s.name), h('div.sc-desc', s.desc), h('div.sc-check', icon('check', 13, 3)));
        }))),

      h('div.pl-section',
        h('div.pl-label', h('b', '4'), `给${A.t('term.plan')}起个名字`),
        h('div', { style: { maxWidth: '420px' } }, nameIn)),

      h('div.pl-foot',
        h('button.btn.ghost', { onclick: () => K.importDialog() }, icon('import', 16), '已有 Mod 列表？导入'),
        h('div.spacer'),
        p.items.length ? h('button.btn', { onclick: () => K.goStep(2) }, '查看当前清单') : null,
        h('button.btn.primary.lg', { onclick: generate }, icon('sparkles', 18), p.styles.length ? '生成 Mod 清单' : '下一步（手动挑选）')));
  }

  /**
   * 没起名字时的默认名字。名字存下来以后算玩家的内容、不再翻译，所以按现在的界面语言生成
   * （rc3：英文界面以前用中文的玩法名拼出「1.20.1 Fabric 性能优化+实用增强」，任务中心里显示出来才发现）
   */
  function defaultName() {
    const p = P.plan;
    const tr = (x) => (window.I18N_TRANSLATE ? window.I18N_TRANSLATE.tr(x) : x);
    const st = (P.meta ? P.meta.styles : []).filter((s) => p.styles.includes(s.id)).map((s) => tr(s.name)).slice(0, 2).join('+');
    return `${p.mc} ${A.LOADERS[p.loader] ? A.LOADERS[p.loader].name : ''}${st ? ` ${st}` : ''}`;
  }

  async function generate() {
    const p = P.plan;
    if (!p.name) p.name = defaultName();
    const avail = P.loaderAvail[p.mc];
    if (avail && avail !== 'loading' && avail[p.loader] === 0) { A.toast({ level: 'warn', text: `${A.LOADERS[p.loader].name} 不支持 Minecraft ${p.mc}` }); return; }
    if (!p.styles.length) { K.goStep(2); return; }
    A.mount(K.body, h('div.pl-loading', h('span.spinner.lg'), h('div', '正在根据你的喜好在 Modrinth 上挑选 Mod…'), h('div.faint', `Minecraft ${p.mc} · ${A.LOADERS[p.loader].name}`)));
    try {
      const r = await api('planner:recommend', { mc: p.mc, loader: p.loader, styles: p.styles });
      const keep = p.items.filter((i) => !['pick', 'popular'].includes(i.source));
      const keepIds = new Set(keep.map((i) => i.projectId));
      p.items = [...keep, ...r.items.filter((i) => !keepIds.has(i.projectId))];
      P.resolved = null;
      K.goStep(2);
    } catch (e) {
      A.errorToast('生成清单失败', e);
      renderChoose();
    }
  }

  Object.assign(K, { defaultName, renderChoose });
})();
