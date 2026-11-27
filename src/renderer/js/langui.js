'use strict';
/* 界面语言（1.10.0）：顶栏语言按钮和设置里的语言选择。切换后主进程写设置、整个窗口按新语言重新加载。
 * 有任务在跑（下载、测试启动、一键 Debug 等）时按钮变灰，等任务完成再切；只有游戏在运行不影响（8.5-6） */
(function () {
  const { h, api, state } = A;
  const LANGS = () => window.I18N.LANGS.filter((l) => l.ready);
  const cur = () => window.I18N.getLang();
  // 配置里存着已经禁用的语言时，按现在实际显示的语言算（配置不改写）
  const prefNow = () => { const p = (state.config && state.config.language) || 'auto'; return p === 'auto' || LANGS().some((l) => l.id === p) ? p : cur(); };
  const nameOf = (id) => (LANGS().find((l) => l.id === id) || {}).name || id;
  // 会被重新加载打断的任务：除了游戏本身（launch）以外正在跑的
  const busy = () => [...state.tasks.values()].some((t) => t.status === 'running' && t.kind !== 'launch');

  async function change(id) {
    if (busy()) { A.toast({ level: 'warn', title: '有任务正在进行', text: '等任务完成后再切换语言' }); return; }
    if (id === prefNow()) return;
    try { await api('app:setLanguage', id); } catch (e) { A.errorToast('切换失败', e); }
  }

  function items() {
    const pref = prefNow();
    const sys = state.info && state.info.systemLanguage;
    return [
      { label: '跟随系统', sub: sys ? nameOf(sys) : null, on: pref === 'auto', onClick: () => change('auto') },
      '-',
      ...LANGS().map((l) => ({ label: h('span', { 'data-no-tr': '' }, l.name), on: pref === l.id, onClick: () => change(l.id) })),
    ];
  }

  /** 设置页里的一行 */
  function settingsRow(row) {
    const pref = prefNow();
    const sys = state.info && state.info.systemLanguage;
    const sel = A.select({
      width: 200, value: pref,
      options: [{ value: 'auto', label: `跟随系统（${nameOf(sys || 'zh-CN')}）` }, ...LANGS().map((l) => ({ value: l.id, label: l.name }))],
      onChange: (v) => change(v),
    });
    return row('界面语言', '切换后启动器会重新加载界面', sel);
  }

  let lastKey = null;
  function renderBtn() {
    const b = document.getElementById('btnLang');
    if (!b) return;
    const l = LANGS().find((x) => x.id === cur());
    const off = busy();
    // 每次任务更新都会走到这里：有没有任务、语言变了才写
    const key = `${l ? l.id : ''}|${off}`;
    if (key === lastKey) return;
    lastKey = key;
    b.textContent = l ? l.short : '简';
    b.classList.toggle('is-off', off);
    b.setAttribute('aria-label', 'Language / 语言');
    // 按钮标了 data-no-tr（语言简称不翻），提示文字自己翻
    const tr = (x) => (window.I18N_TRANSLATE ? window.I18N_TRANSLATE.tr(x) : x);
    b.setAttribute('data-tip', tr(off ? '有任务正在进行，等完成后再切换语言' : `${nameOf(cur())} · Language`));
  }

  function init() {
    const b = document.getElementById('btnLang');
    lastKey = null;
    if (!b) return;
    // 有任务在跑时点了：说一声为什么不能换（以前什么都不发生，像是按钮坏了）
    b.addEventListener('click', () => { if (busy()) { renderBtn(); A.toast({ level: 'info', text: '有任务正在进行，等完成后再切换语言', duration: 3000 }); return; } A.menu(b, items(), { align: 'right' }); });
    A.on('task', renderBtn);
    renderBtn();
  }

  A.langUi = { init, settingsRow };
})();
