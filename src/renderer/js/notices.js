'use strict';
/**
 * 「通过但有提示」的显示：配置器的测试启动和一键 Debug 共用。
 * 测试结果里的 notices 和 analyzeLog 的 issue 形状一样，用 modkit.issueList 显示（含处理按钮和折叠的原文），
 * 再加上进入主菜单后的游戏画面截图，点开看大图。
 */
(function () {
  const { h, icon, api, t } = A;

  function shot(image, caption) {
    const open = () => A.modal({ title: caption, icon: 'image', width: 900, body: h('img.notice-shot-big', { src: image, alt: caption }), actions: [{ label: t('common.close'), kind: 'primary' }] });
    return h('button.notice-shot', { type: 'button', title: caption, 'aria-label': caption, onclick: open },
      h('img', { src: image, alt: caption }), h('span.notice-shot-cap', icon('search', 12), caption));
  }

  /**
   * 这次的画面照玩家上次的回答处理了，没有再问（main/core/troubleshoot/memory.js）：说一句，给「重新问我」
   */
  function rememberedNote(m, ctx) {
    const btn = h('button.btn.sm', {
      onclick: async () => {
        btn.disabled = true;
        try {
          await api('troubleshoot:forgetScreen', ctx.versionId, m.at);
          A.toast({ level: 'ok', text: '好的，下次测试再遇到这个画面会重新问你' });
        } catch (e) { btn.disabled = false; A.errorToast('没能忘掉这个回答', e); }
      },
    }, icon('refresh', 14), '说错了，下次重新问我');
    return A.alert({
      level: 'info', compact: true,
      text: m.answer === 'menu' ? '这个画面你以前说过是主菜单，这次就照这个算，没再问你' : '这个画面你以前说过被提示挡住了，这次照上次的回答处理，没再问你',
      actions: [btn],
    });
  }

  /**
   * @param {{ok:boolean, warn?:boolean, notices?:Array, screen?:{kind:string,image?:string}, gameId?:string}} r 测试启动或一键 Debug 的结果
   * @param {{versionId:string, mc?:string, onFixed?:Function, showLog?:boolean}} ctx showLog：外面没有「查看日志」按钮时（一键 Debug）在这里给一个
   * @returns {HTMLElement|null} 没有提示也不需要显示截图时返回 null
   */
  function block(r, ctx = {}) {
    const notices = (r && r.notices) || [];
    const screen = r && r.screen;
    const onboarding = screen && screen.kind === 'onboarding';
    const remembered = screen && screen.remembered;
    if (!notices.length && !onboarding && !remembered) return null;
    const raw = notices.map((n) => n.raw).filter(Boolean).join('\n\n');
    return h('div.notice-block',
      h('div.notice-main',
        notices.length ? A.modkit.issueList(notices, ctx) : null,
        onboarding ? A.alert({ level: 'info', compact: true, text: t('notice.onboarding') }) : null,
        remembered ? rememberedNote(remembered, ctx) : null,
        h('div.row.gap-s', { style: { marginTop: '8px', flexWrap: 'wrap' } },
          raw ? h('button.btn.sm', { onclick: () => A.copy(raw) }, icon('copy', 14), t('notice.copyRaw')) : null,
          ctx.showLog && r.gameId ? h('button.btn.sm', { onclick: () => A.logs.open(r.gameId) }, icon('terminal', 14), '查看日志') : null)),
      screen && screen.image ? shot(screen.image, t('notice.shot')) : null);
  }

  A.notices = { block };
})();
