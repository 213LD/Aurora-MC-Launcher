'use strict';
/**
 * 测试启动认不出游戏画面时，请玩家确认（1.4.7 改成面向新手的三步）：
 * ① 确认：顶上先说日志的判断（游戏已经进了主菜单、稳定跑了几秒），玩家选「是主菜单」或「被提示挡住了」
 * ② 说明：被挡住了 → 讲清楚游戏其实启动成功了，列出常见的提示和处理办法；可选抄几个关键词
 * ③ 去游戏里处理：游戏一直开着，处理好后点「处理好了」，主进程再看一眼画面（回答 handled）
 * 回答用 troubleshoot:answer 发回去；去处理时 troubleshoot:askHold 把等待延长到 10 分钟。
 * 主进程等不到回答或测试被取消时发 troubleshoot:askClosed，对话框自己关掉。
 */
(function () {
  const { h, icon, api, t } = A;
  const open = new Map(); // askId → modal

  function ask(p) {
    const name = A.displayName(A.state.installed.find((v) => v.id === p.versionId) || { id: p.versionId });
    const text = h('textarea.input', { rows: 3, placeholder: t('ask.typePh'), style: { width: '100%', resize: 'vertical' } });
    let answered = false;
    const reply = (ans) => { answered = true; api('troubleshoot:answer', p.askId, ans).catch(() => {}); return true; };
    const shot = () => (p.image ? h('img.ask-shot', { src: p.image, alt: t('notice.shot') }) : A.alert({ level: 'info', compact: true, text: t('ask.noShot') }));
    const logLine = () => (p.log && p.log.ok ? A.alert({ level: 'ok', compact: true, title: t('ask.logOk'), text: t('ask.logOkText', { s: p.log.seconds }) }) : null);
    // 可选的关键词框：默认收起，不让新手以为必须填
    const typeBox = () => h('details.ask-type', h('summary', t('ask.typeOptional')), text,
      p.lines && p.lines.length ? h('details.issue-raw', h('summary', t('ask.ocr')), h('pre', { 'data-no-tr': '' }, p.lines.join('\n'))) : null);

    const m = A.modal({
      title: t('ask.title'), subtitle: A.nm(name), icon: 'monitor', size: 'lg', dismissable: false, className: 'ask-modal',
      body: h('div'),
      onClose: () => { open.delete(p.askId); if (!answered) api('troubleshoot:answer', p.askId, null).catch(() => {}); },
    });
    const head = m.el.querySelector('.modal-head h2');
    const page = (title, body, actions) => {
      if (head) head.textContent = title;
      A.mount(m.body, body);
      m.setActions(actions);
    };

    // ① 确认画面
    const confirmPage = () => page(t('ask.title'), h('div.ask-body',
      logLine(),
      h('p', { style: { margin: '10px 0' } }, t('ask.lead')),
      shot(),
      h('div.faint', { style: { fontSize: '12px', marginTop: '8px' } }, icon('clock', 12), ' ', t('ask.timeout'))), [
      { label: t('ask.prompt'), kind: '', icon: 'alert', onClick: () => { guidePage(); return false; } },
      { label: t('ask.menu'), kind: 'primary', icon: 'check', onClick: () => reply({ answer: 'menu' }) },
    ]);

    // ② 被挡住了：说明 + 常见情况
    const guidePage = () => {
      api('troubleshoot:askHold', p.askId).catch(() => {});
      page(t('ask.guideTitle'), h('div.ask-body',
        A.alert({ level: 'ok', title: t('ask.guideOk'), text: t('ask.guideOkText') }),
        h('ol.ask-cases', ['ask.case1', 'ask.case2', 'ask.case3', 'ask.case4', 'ask.case5'].map((k) => h('li', t(k)))),
        p.image ? h('details.issue-raw', h('summary', t('notice.shot')), shot()) : null,
        typeBox()), [
        { label: t('ask.back'), kind: 'ghost', left: true, onClick: () => { confirmPage(); return false; } },
        { label: t('ask.skip'), kind: '', onClick: () => reply({ answer: 'prompt', text: text.value }) },
        { label: t('ask.handle'), kind: 'primary', icon: 'monitor', onClick: () => { handlingPage(); return false; } },
      ]);
    };

    // ③ 去游戏里处理，处理好了回来
    const handlingPage = () => {
      api('troubleshoot:askHold', p.askId).catch(() => {});
      page(t('ask.handlingTitle'), h('div.ask-body',
        A.alert({ level: 'info', text: t('ask.handlingText') }),
        h('ol.ask-cases', ['ask.case1', 'ask.case2', 'ask.case3', 'ask.case5'].map((k) => h('li', t(k)))),
        h('div.faint', { style: { fontSize: '12px', marginTop: '8px' } }, icon('clock', 12), ' ', t('ask.holdNote')),
        typeBox()), [
        { label: t('ask.back'), kind: 'ghost', left: true, onClick: () => { guidePage(); return false; } },
        { label: t('ask.cant'), kind: '', onClick: () => reply({ answer: 'prompt', text: text.value }) },
        { label: t('ask.handled'), kind: 'primary', icon: 'check', onClick: () => reply({ answer: 'handled', text: text.value }) },
      ]);
    };

    confirmPage();
    open.set(p.askId, m);
  }

  A.listen('troubleshoot:ask', ask);
  A.listen('troubleshoot:askClosed', ({ askId }) => { const m = open.get(askId); if (m) { open.delete(askId); m.close(); } });
  A.testAsk = { ask }; // 截图测试用
})();
