'use strict';
/* 游戏日志抽屉与崩溃分析 */
(function () {
  const { h, icon, api, state, $, emit } = A;

  const MAX_LINES = 4000;
  const logs = new Map(); // gameId → lines[]
  let current = null;
  let filter = 'all';
  let query = '';
  let autoScroll = true;
  let els = null;

  function gameLabel(g) {
    const t = new Date(g.startedAt).toTimeString().slice(0, 5);
    return `${g.versionId} · ${t}${g.state === 'exited' ? '（已退出）' : ''}`;
  }

  /** 一行日志；q：要高亮的搜索词（日志中心也用，rc4） */
  function lineEl(l, q = query) {
    const cls = `log-line ${l.level}${l.text.startsWith('[Aurora]') ? ' aurora' : ''}`;
    if (q && l.text.toLowerCase().includes(q)) {
      const el = h('div', { class: cls });
      const lower = l.text.toLowerCase();
      let i = 0;
      let idx;
      while ((idx = lower.indexOf(q, i)) >= 0) {
        el.append(l.text.slice(i, idx), h('mark', l.text.slice(idx, idx + q.length)));
        i = idx + q.length;
      }
      el.append(l.text.slice(i));
      return el;
    }
    return h('div', { class: cls }, l.text);
  }

  const visible = (l) => {
    if (filter === 'warn' && !['WARN', 'ERROR', 'FATAL'].includes(l.level)) return false;
    if (filter === 'error' && !['ERROR', 'FATAL'].includes(l.level)) return false;
    if (query && !l.text.toLowerCase().includes(query)) return false;
    return true;
  };

  function renderBody() {
    if (!els) return;
    const lines = (current && logs.get(current)) || [];
    A.clear(els.body);
    const shown = lines.filter(visible);
    if (!shown.length) {
      els.body.appendChild(h('div.log-empty', current ? '没有匹配的日志' : '还没有游戏日志，启动游戏后会显示在这里'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const l of shown.slice(-2500)) frag.appendChild(lineEl(l));
    els.body.appendChild(frag);
    if (autoScroll) els.body.scrollTop = els.body.scrollHeight;
  }

  function renderHead() {
    if (!els) return;
    const games = [...state.games.values()].sort((a, b) => b.startedAt - a.startedAt);
    const g = state.games.get(current);
    els.select.setOptions(games.map((x) => ({ value: x.id, label: gameLabel(x) })), current);
    els.kill.classList.toggle('hidden', !g || g.state === 'exited');
    els.status.textContent = g ? (g.state === 'exited' ? `已退出 · 代码 ${g.exitCode}` : g.state === 'running' ? `运行中 · PID ${g.pid}` : '启动中…') : '';
  }

  function build() {
    const drawer = $('#logDrawer');
    const body = h('div.log-body', { 'data-no-tr': '' }); // 游戏日志是原文，不翻译
    const select = A.select({ options: [], value: null, placeholder: '选择游戏进程', small: true, onChange: (v) => { current = v; ensureLoaded(v); renderHead(); } });
    const kill = h('button.btn.sm.danger', { onclick: async () => { if (current && await A.confirm('确定要强制结束游戏进程吗？未保存的进度可能丢失。', { danger: true, okText: '结束进程' })) api('games:kill', current); } }, icon('stop', 14), '结束进程');
    const status = h('span.faint.lh-status', { style: { fontSize: '12px' } });
    const search = h('input.input.sm.lh-search', { placeholder: '搜索日志…', oninput: A.debounce((e) => { query = e.target.value.trim().toLowerCase(); renderBody(); }, 200) });
    const autoBtn = h('button.btn.ghost.sm.icon', { 'data-tip': '自动滚动', onclick: () => { autoScroll = !autoScroll; autoBtn.style.color = autoScroll ? 'var(--accent)' : ''; if (autoScroll) body.scrollTop = body.scrollHeight; } }, icon('arrowDown', 16));
    autoBtn.style.color = 'var(--accent)';
    const text = () => ((current && logs.get(current)) || []).map((l) => l.text).join('\n');
    A.mount(drawer,
      h('div.log-head',
        h('div.lh-title', icon('terminal', 16), '游戏日志'),
        select, status,
        h('div.spacer'),
        A.seg([{ value: 'all', label: '全部' }, { value: 'warn', label: '警告' }, { value: 'error', label: '错误' }], filter, (v) => { filter = v; renderBody(); }),
        search, autoBtn,
        h('button.btn.ghost.sm.icon', { 'data-tip': '在日志中心查看（以前的日志也在那里）', onclick: () => { const g = state.games.get(current); close(); A.go('logs', g && g.logId ? { open: g.logId } : undefined); } }, icon('list', 16)),
        h('button.btn.ghost.sm.icon', { 'data-tip': '复制全部', onclick: () => A.copy(text()) }, icon('copy', 16)),
        h('button.btn.ghost.sm.icon', { 'data-tip': '导出日志', onclick: async () => { const p = await api('dialog:save', '导出日志', `aurora-log-${Date.now()}.txt`, text()); if (p) A.toast({ level: 'ok', text: `已保存到 ${p}` }); } }, icon('save', 16)),
        h('button.btn.ghost.sm.icon', { 'data-tip': '打开日志文件夹', onclick: () => { const g = state.games.get(current); if (g) api('shell:open', `${g.gameDir}\\logs`).catch((e) => A.errorToast('无法打开', e)); } }, icon('folder', 16)),
        kill,
        h('button.btn.ghost.sm.icon', { 'data-tip': '关闭', onclick: close }, icon('chevronDown', 18))),
      body);
    body.addEventListener('scroll', () => {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
      if (!atBottom && autoScroll) { autoScroll = false; autoBtn.style.color = ''; }
    });
    els = { drawer, body, select, kill, status };
  }

  async function ensureLoaded(id) {
    if (!id || logs.has(id)) { renderBody(); return; }
    const lines = await api('games:log', id).catch(() => []);
    logs.set(id, lines.slice(-MAX_LINES));
    renderBody();
  }

  function open(id) {
    if (!els) build();
    if (id) current = id;
    if (!current) {
      const latest = [...state.games.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
      current = latest ? latest.id : null;
    }
    els.drawer.classList.add('open');
    renderHead();
    ensureLoaded(current);
  }
  function close() { if (els) els.drawer.classList.remove('open'); }
  function toggle() { if (els && els.drawer.classList.contains('open')) close(); else open(); }

  /** 旧的几局不一直留在内存里（2.0.0-pre8）。要看的时候 ensureLoaded 再找主进程要 */
  function dropOldLogs() {
    if (logs.size <= 10) return;
    for (const id of logs.keys()) {
      if (logs.size <= 10) break;
      const g = state.games.get(id);
      if (id !== current && !(g && g.state !== 'exited')) logs.delete(id);
    }
  }

  /**
   * 结束了的游戏在界面这边也只记最近 10 局（rc9）：主进程只留 10 局的日志，这边以前一直记着，
   * 每局带一份崩溃报告预览，下拉框里更早的几局点了是空的
   */
  function dropOldGames() {
    const exited = [...state.games.values()].filter((g) => g.state === 'exited').sort((a, b) => a.startedAt - b.startedAt);
    for (const g of exited.slice(0, Math.max(0, exited.length - 10))) {
      if (g.id === current) continue;
      state.games.delete(g.id);
      logs.delete(g.id);
    }
  }

  function appendLines(id, lines) {
    let arr = logs.get(id);
    if (!arr) { arr = []; logs.set(id, arr); dropOldLogs(); }
    arr.push(...lines);
    if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
    if (!els || id !== current || !els.drawer.classList.contains('open')) return;
    const empty = els.body.querySelector('.log-empty');
    if (empty) empty.remove();
    const frag = document.createDocumentFragment();
    for (const l of lines) if (visible(l)) frag.appendChild(lineEl(l));
    els.body.appendChild(frag);
    while (els.body.childElementCount > 2500) els.body.firstChild.remove();
    if (autoScroll) els.body.scrollTop = els.body.scrollHeight;
  }

  function showCrash(g) {
    const crash = g.crash || {};
    const reasons = crash.reasons && crash.reasons.length ? crash.reasons : ['未能自动识别崩溃原因，请查看日志或崩溃报告'];
    const modIssues = h('div');
    api('troubleshoot:analyze', g.versionId, g.id).then((issues) => {
      const specific = (issues || []).filter((i) => i.type !== 'general');
      if (!specific.length) return;
      A.mount(modIssues, h('div.faint', { style: { fontSize: '12.5px', margin: '4px 0 8px' } }, 'Mod 相关的问题（可一键处理）：'), A.modkit.issueList(specific, { versionId: g.versionId }));
    }).catch(() => {});
    const body = h('div',
      h('p.muted', { style: { marginTop: 0 } }, `${A.nm(g.versionId)} 以退出代码 ${g.exitCode} 结束，运行了 ${Math.max(1, Math.round((g.endedAt - g.startedAt) / 1000))} 秒。`),
      h('div', reasons.map((r) => A.alert({ level: 'crit', compact: true, text: r }))),
      modIssues,
      crash.report ? h('details', { style: { marginTop: '12px' } }, h('summary', { style: { cursor: 'pointer', color: 'var(--text-2)', fontSize: '13px', marginBottom: '8px' } }, '崩溃报告预览'), h('pre.crash-pre', crash.report.slice(0, 6000))) : null);
    const ver = state.installed.find((x) => x.id === g.versionId);
    A.modal({
      title: '游戏意外退出',
      subtitle: '以下是启动器的初步分析',
      size: 'lg',
      level: 'crit',
      body,
      actions: [
        crash.reportPath ? { label: '打开崩溃报告', kind: 'ghost', left: true, icon: 'file', onClick: () => { api('shell:open', crash.reportPath); return false; } } : null,
        ver && ver.loader ? { label: A.t('term.debug'), kind: '', icon: 'wrench', onClick: () => { A.debugDialog(ver); } } : null,
        { label: '查看日志', kind: '', icon: 'terminal', onClick: () => { open(g.id); } },
        { label: '知道了', kind: 'primary' },
      ].filter(Boolean),
    });
  }

  async function init() {
    for (const g of await api('games:list')) state.games.set(g.id, g);
    $('#btnLogs').append(icon('terminal', 18));
    $('#btnLogs').addEventListener('click', toggle);
    A.listen('game:log', ({ id, lines }) => appendLines(id, lines));
    A.listen('game:state', (g) => { state.games.set(g.id, { ...state.games.get(g.id), ...g }); if (!current) current = g.id; renderHead(); emit('games'); });
    A.listen('game:exit', (g) => {
      state.games.set(g.id, g);
      dropOldGames();
      renderHead();
      emit('games');
      if (g.test) return;
      if (g.crash) showCrash(g);
      else A.toast({ level: 'info', title: '游戏已退出', text: g.exitCode === 0 ? `${A.nm(g.versionId)} 正常退出` : `${A.nm(g.versionId)} 的进程已结束（代码 ${g.exitCode}）` });
    });
    A.listen('ui:showLog', (id) => open(id));
  }

  A.logs = { init, open, close, toggle, lineEl, showCrash };
})();
