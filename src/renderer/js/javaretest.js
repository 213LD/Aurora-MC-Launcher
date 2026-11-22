'use strict';
/**
 * 「用 Java N 再测一次」：Mod 需要更高版本的 Java 时，问题旁边的按钮打开这个对话框。
 * 只在这次测试里用 Java N（troubleshoot:javaRetest，没装会先下载），不改配置；通过后再问要不要以后都用它（troubleshoot:useJava）。
 * 一键 Debug、Mod 配置器、兼容性检查、崩溃对话框里的问题列表（modkit.issueList）都走这里。
 */
(function () {
  const { h, api, t } = A;

  function retest(versionId, major, { onDone } = {}) {
    const v = A.state.installed.find((x) => x.id === versionId) || { id: versionId };
    const name = A.displayName(v);
    const status = h('div.faint', { style: { fontSize: '12.5px', whiteSpace: 'pre-line' } }, t('java.preparing', { n: major }));
    const bar = h('div', { class: 'progress indeterminate', style: { margin: '12px 0 8px' } }, h('i'));
    const result = h('div');
    let done = false;
    const running = () => [...A.state.tasks.values()].reverse().find((x) => x.kind === 'test' && x.meta && x.meta.name === versionId && x.status === 'running');
    const m = A.modal({
      title: t('java.retestTitle', { n: major }), subtitle: A.nm(name), icon: 'coffee', size: 'lg', dismissable: false,
      body: h('div',
        h('p', { style: { margin: '0 0 10px' } }, t('java.retestLead', { n: major, name: A.nm(name) })),
        A.alert({ level: 'info', compact: true, text: `${t('test.how')}\n${t('test.dont')}` }),
        bar, status, result),
      actions: [{ label: t('common.cancel'), onClick: async () => { const tk = running(); if (tk) await api('tasks:cancel', tk.id); return false; } }],
      onClose: () => { done = true; clearInterval(iv); },
    });
    // 进度：下载 Java、等待主菜单、倒计时都在任务的 detail 里
    const iv = setInterval(() => {
      const tk = running();
      if (!tk) return;
      status.textContent = tk.detail || '';
      const pct = tk.progress >= 0 ? Math.round(tk.progress * 100) : -1;
      bar.classList.toggle('indeterminate', pct < 0);
      bar.firstChild.style.width = `${Math.max(0, pct)}%`;
    }, 400);

    const finish = (body, actions) => {
      clearInterval(iv);
      if (done) return;
      bar.remove(); status.remove();
      A.mount(result, body);
      m.setActions(actions);
      m.setDismissable(true);
    };
    const closeBtn = { label: t('common.close'), kind: 'primary' };
    api('troubleshoot:javaRetest', versionId, major).then((r) => {
      if (r.reason === 'interrupted') {
        finish(A.alert({ level: 'warn', title: t('test.interrupted'), text: t('test.interruptedHint') }),
          [{ label: t('common.close') }, { label: t('test.retry'), kind: 'primary', icon: 'refresh', onClick: () => { setTimeout(() => retest(versionId, major, { onDone }), 200); } }]);
        return;
      }
      if (r.ok) {
        const n = r.java.major;
        finish(h('div',
          A.alert({ level: r.warn ? 'warn' : 'ok', title: t(r.warn ? 'java.retestWarn' : 'java.retestOk', { n }), text: `Java ${r.java.version}\n${t('java.retestOkText', { n, name })}` }),
          r.warn || (r.screen && r.screen.remembered) ? A.notices.block(r, { versionId, mc: v.mcVersion }) : null),
        [{ label: t('java.notNow') },
          { label: t('java.keep', { n }), kind: 'primary', icon: 'check', onClick: async () => {
            await api('troubleshoot:useJava', versionId, r.java.path);
            A.toast({ level: 'ok', text: t('java.keepDone', { n, name: A.nm(name) }) });
            if (onDone) onDone();
          } }]);
        return;
      }
      finish(h('div',
        A.alert({ level: 'crit', title: t('java.retestFail', { n: major }), text: t('java.retestFailText') }),
        r.issues && r.issues.length ? A.modkit.issueList(r.issues, { versionId, mc: v.mcVersion, onFixed: onDone }) : null),
      [closeBtn]);
    }).catch((e) => {
      if (e.cancelled) { m.close(); return; }
      finish(A.alert({ level: 'crit', title: t('java.retestFail', { n: major }), text: e.message }), [closeBtn]);
    });
    return m;
  }

  A.javaRetest = retest;
})();
