'use strict';
/**
 * 主页问候区的场景胶囊：「图标 场景名 · 时段 ▾」，点开选场景和时间（写进设置）；
 * 旁边的骰子随机换一个场景，只在这次打开启动器时有效、不改设置。背景不是像素场景时不显示。
 * 调用方负责真正切换场景：onPick(场景值) 保存设置，onReroll() 临时换一个。
 * 天气（rc3）：菜单里可以强制成晴天 / 下雨（雪原是下雪）/ 雷雨，onWeather(值) 交给场景；强制的天气不写进设置，换场景后重新按概率算
 */
(function () {
  const { h, icon, state, t } = A;
  const PERIOD_ICON = { dawn: 'sunrise', day: 'sun', sunset: 'sunset', night: 'moon', nether: 'flame', end: 'sparkles' };
  const DIMS = ['over', 'nether', 'end'];
  const TIMES = ['auto', 'dawn', 'day', 'sunset', 'night'];
  const WEATHER_ICON = { rain: 'cloudRain', snow: 'snowflake', thunder: 'cloudLightning' };
  /** 天气的名字：雪原里的「下雨」叫「下雪」 */
  const wxName = (kind, precip) => t(`scene.weather.${kind === 'rain' && precip === 'snow' ? 'snow' : kind}`);

  function create({ onPick, onTime, onReroll, onWeather, isTemp }) {
    let info = null;
    const main = h('button.stat-pill.scene-pill', { type: 'button', 'aria-haspopup': 'dialog', onclick: (e) => openMenu(e.currentTarget) });
    const dice = h('button.stat-pill.scene-dice', {
      type: 'button', 'data-tip': t('scene.reroll'), 'aria-label': t('scene.reroll'),
      onclick: () => { dice.classList.remove('roll'); void dice.offsetWidth; dice.classList.add('roll'); onReroll(); },
    }, icon('dice', 14));
    const el = h('div.scene-pill-wrap.hidden', main, dice);

    function render() {
      el.classList.toggle('hidden', !info);
      if (!info) return;
      const overworld = !['nether', 'end'].includes(info.period);
      const wx = info.weather && info.weather.kind !== 'clear' ? info.weather : null;
      const text = [info.name, overworld ? t(`scene.period.${info.period}`) : null, wx ? wxName(wx.kind, wx.precip) : null].filter(Boolean).join(' · ');
      const ico = wx ? WEATHER_ICON[wx.kind === 'rain' && wx.precip === 'snow' ? 'snow' : wx.kind] : PERIOD_ICON[info.period];
      A.mount(main,
        icon(ico || 'image', 14),
        text,
        isTemp() ? h('span.sp-temp', t('scene.temp')) : null,
        icon('chevronDown', 13));
      main.setAttribute('aria-label', `${t('scene.pick')}：${text}${isTemp() ? ` · ${t('scene.temp')}` : ''}`);
    }

    function openMenu(anchor) {
      const b = { ...A.SCENE_DEFAULTS, ...(state.config.background || {}) };
      const cur = isTemp() ? null : b.scene;
      let pop = null;
      const choose = (v) => { pop.close(); onPick(v); };
      const opt = (value, label) => h('button', {
        type: 'button', class: `scene-opt ${cur === value ? 'on' : ''} ${isTemp() && info && info.scene === value ? 'temp' : ''}`,
        'aria-pressed': String(cur === value), onclick: () => choose(value),
      }, label);
      const overworld = !info || !['nether', 'end'].includes(info.period);
      const body = h('div.scene-menu',
        h('div.menu-head', t('scene.title')),
        h('div.scene-opts.wide', opt('auto', t('scene.autoDaily')), opt('random', t('scene.autoRandom'))),
        ...DIMS.map((dim) => h('div.scene-group',
          h('div.sg-label', t(`scene.dim.${dim}`)),
          h('div.scene-opts', Object.keys(A.SCENES).filter((id) => A.SCENES[id].dim === dim).map((id) => opt(id, A.SCENES[id].name))))),
        h('div.menu-sep'),
        h('div.menu-head', t('scene.time'), overworld ? null : h('span.sg-note', t('scene.timeOnlyOver'))),
        h('div.scene-time', A.seg(TIMES.map((v) => ({ value: v, label: t(`scene.period.${v}`) })), b.time || 'auto', (v) => onTime(v))),
        weatherPart(),
        h('div.menu-sep'),
        h('div.menu-item', { onclick: () => { pop.close(); A.go('settings', { focus: 'background' }); } },
          icon('settings', 16), h('div.m-body', h('div.m-title', t('scene.more')))));
      pop = A.popover(anchor, body, { className: 'scene-pop', width: 318 });

      /** 天气：自动 / 晴天 / 下雨（下雪）/ 雷雨。不下雨的地方（沙漠、下界、末地）只写一句说明 */
      function weatherPart() {
        const w = (info && info.weather) || { kind: 'clear', can: false };
        const head = h('div.menu-head', t('scene.weather'),
          !w.can ? h('span.sg-note', t(overworld ? 'scene.weather.never' : 'scene.timeOnlyOver'))
            : !w.forced ? h('span.sg-note', t('scene.weather.now', { w: wxName(w.kind, w.precip) })) : h('span.sg-note', t('scene.weather.kept')));
        if (!w.can) return h('div', h('div.menu-sep'), head);
        const opts = ['auto', 'clear', 'rain', 'thunder'].map((v) => ({ value: v, label: v === 'auto' ? t('scene.weather.auto') : wxName(v, w.precip) }));
        return h('div', h('div.menu-sep'), head,
          h('div.scene-time.scene-weather', A.seg(opts, w.forced ? w.kind : 'auto', (v) => { if (onWeather) onWeather(v); })));
      }
    }

    return {
      el,
      /** scene 事件传来的信息；null = 背景不是像素场景 */
      setInfo(i) { info = i; render(); },
      render,
    };
  }

  A.scenePill = create;
})();
