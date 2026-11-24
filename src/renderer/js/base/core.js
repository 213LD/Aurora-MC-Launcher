'use strict';
/* 渲染进程基础：IPC、DOM 构建、图标、格式化、全局状态 */
(function () {
  const bridge = window.aurora;

  // 还在等主进程回答的请求有几个。界面测试点了按钮以后等它回到 0 再看：很多弹窗要先问主进程拿数据才出来
  let pending = 0;
  // Error 在这边生成：从 preload 抛过来的 Error 会丢掉 reason / cancelled（contextBridge 只复制 message）
  const api = async (channel, ...args) => {
    let r;
    pending++;
    try { r = await bridge.invoke(channel, ...args); } finally { pending--; }
    if (r && r.ok) return r.data;
    const e = new Error((r && r.error) || '未知错误');
    // 请求报网络错误 / 超时：可能刚断网，让离线模式（offline.js）去确认一下
    if (/^(网络错误|请求超时)/.test(e.message) && A.hooks.netError) A.hooks.netError();
    if (r && r.cancelled) e.cancelled = true;
    if (r && r.reason) e.reason = r.reason;
    throw e;
  };
  const listen = (event, cb) => bridge.on(event, cb);
  // 多语言与品牌（src/shared，index.html 里先于本文件加载）
  const { t } = window.I18N;
  const BRAND = window.BRAND;

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false || c === true) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** h('div.card.big', {onclick}, ...children) */
  function h(tag, props, ...children) {
    if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
      if (props != null) children.unshift(props);
      props = null;
    }
    const parts = tag.split('.');
    const el = document.createElement(parts[0] || 'div');
    if (parts.length > 1) el.className = parts.slice(1).join(' ');
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = el.className ? `${el.className} ${v}` : v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    // 无障碍：纯图标按钮用悬浮提示当名字，有文字的把提示当补充说明
    if (props && props['data-tip'] && !props['aria-label']) {
      el.setAttribute(el.textContent.trim() ? 'aria-description' : 'aria-label', props['data-tip']);
    }
    return el;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const mount = (el, ...children) => append(clear(el), children);

  // ── 图标（Lucide 风格线条图标）──
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    puzzle: '<path d="M4.15 6.5H8.3A2.4 2.4 0 1 1 11.5 6.5H15.65A1.5 1.5 0 0 1 17.15 8V12.15A2.4 2.4 0 1 1 17.15 15.35V19.5A1.5 1.5 0 0 1 15.65 21H11.5A2.4 2.4 0 1 0 8.3 21H4.15A1.5 1.5 0 0 1 2.65 19.5V15.35A2.4 2.4 0 1 0 2.65 12.15V8A1.5 1.5 0 0 1 4.15 6.5Z"/>',
    coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2"/><path d="M10 2v2"/><path d="M14 2v2"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    minus: '<path d="M5 12h14"/>',
    square: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
    restore: '<rect x="4" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/>',
    search: '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    chevronUp: '<path d="m18 15-6-6-6 6"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    alertCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    memory: '<path d="M6 19v-3"/><path d="M10 19v-3"/><path d="M14 19v-3"/><path d="M18 19v-3"/><path d="M8 11V9"/><path d="M16 11V9"/><path d="M12 11V9"/><path d="M2 15h20"/><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sunrise: '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    sunset: '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" stroke-width="2.6"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    more: '<circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/><circle cx="5" cy="12" r="1.2" fill="currentColor"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1" fill="currentColor"/><circle cx="17.5" cy="10.5" r="1" fill="currentColor"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor"/><circle cx="6.5" cy="12.5" r="1" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.53 0 8.4 2.9 9.94 6.65a1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
    shrink: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    // 导入（箭头进入方框）；导出用 upload
    import: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    sparkles: '<path d="M9.94 14.06A2 2 0 0 0 8.5 12.6l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 8.5a2 2 0 0 0 1.44-1.44l1.58-6.13a.5.5 0 0 1 .96 0L14.06 7.06A2 2 0 0 0 15.5 8.5l6.13 1.58a.5.5 0 0 1 0 .96L15.5 12.6a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    volume: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/>',
    volumeX: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
    scroll: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    cloudRain: '<path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
    cloudLightning: '<path d="M6 16.33A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.97"/><path d="m13 12-3 5h4l-3 5"/>',
    snowflake: '<path d="M12 2v20"/><path d="m4.93 7 14.14 10"/><path d="m4.93 17 14.14-10"/><path d="m9 4 3 3 3-3"/><path d="m9 20 3-3 3 3"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    flask: '<path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    gamepad: '<path d="M6 12h4"/><path d="M8 10v4"/><path d="M15 13h.01"/><path d="M18 11h.01"/><rect x="2" y="6" width="20" height="12" rx="2"/>',
  };

  function icon(name, size = 18, stroke = 2) {
    const t = document.createElement('template');
    t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
    return t.content.firstChild;
  }

  // ── 格式化 ──
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  const fmtSpeed = (n) => (n > 0 ? `${fmtBytes(n)}/s` : '');
  function fmtDate(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmtRelative(t) {
    if (!t) return '';
    const s = (Date.now() - new Date(t).getTime()) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
    if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)} 个月前`;
    return `${Math.floor(s / 86400 / 365)} 年前`;
  }
  function fmtNum(n) {
    if (n == null) return '';
    // 英文按千、百万写：万、亿在英文里没有对应的单位（1.10.6：以前靠字典换字，1.2 万显示成 1.20K，数字是错的）
    if (window.I18N && window.I18N.getLang() === 'en') {
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(n);
    }
    if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
    return String(n);
  }
  function fmtEta(s) {
    if (!s || s <= 0) return '';
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  }
  function fmtMem(mb) {
    return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
  }
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const LOADERS = {
    fabric: { name: 'Fabric', color: '#dbb98a' },
    legacyfabric: { name: 'Legacy Fabric', color: '#c9a66b' },
    quilt: { name: 'Quilt', color: '#b583ff' },
    forge: { name: 'Forge', color: '#9ca3af' },
    neoforge: { name: 'NeoForge', color: '#f08a24' },
    optifine: { name: 'OptiFine', color: '#e14b4b' },
    liteloader: { name: 'LiteLoader', color: '#60a5fa' },
  };
  const TYPE_NAMES = { release: '正式版', snapshot: '快照版', old_beta: '远古 Beta', old_alpha: '远古 Alpha', pending: '预览' };

  /**
   * 功能开关
   * msLogin：微软正版登录。已内置通过审核的 Azure 应用 Client ID（auth/microsoft.js，设备代码流）。
   */
  const FEATURES = { msLogin: true };
  const MS_PENDING = '微软要求第三方启动器先在 Azure 注册应用、通过审核，才能用微软账户登录 Minecraft。申请正在进行，通过后会在更新里开放；在那之前可以先用离线账户或外置登录。';
  const msPendingNotice = () => A.toast({ level: 'info', title: '微软正版登录正在申请', text: MS_PENDING, duration: 9000 });

  const PROFILE_TYPES = {
    vanilla: { name: t('term.vanilla'), cls: 'ok' },
    vanillaplus: { name: t('term.vanillaPlus'), cls: 'ok' },
    custom: { name: t('term.customMod'), cls: 'info' },
    modpack: { name: t('term.modpack'), cls: 'accent' },
    planner: { name: t('term.planner'), cls: 'accent' },
  };

  /**
   * 提醒与警告等级，全启动器唯一来源：
   * info 一般提醒（蓝、圆圈 i）· warn 一般警告（黄、三角叹号）· crit 严重警告 / 错误（红、圆圈叉）· ok 操作成功（绿、对勾）
   * 旧写法 success / error / danger 会被换算过来
   */
  const LEVELS = {
    info: { icon: 'info', label: t('level.info') },
    warn: { icon: 'alert', label: t('level.warn') },
    crit: { icon: 'xCircle', label: t('level.crit') },
    ok: { icon: 'checkCircle', label: t('level.ok') },
  };
  const LEVEL_ALIAS = { success: 'ok', error: 'crit', danger: 'crit', fatal: 'crit', warning: 'warn' };
  const level = (x) => (LEVELS[x] ? x : LEVEL_ALIAS[x] || 'info');
  /** 等级图标：形状本身就能区分等级，不只靠颜色 */
  const levelIcon = (x, size = 17) => {
    const el = icon(LEVELS[level(x)].icon, size);
    el.classList.add('lv-ico', level(x));
    return el;
  };
  const displayName = (v) => (v && (v.displayName || v.id)) || '';
  /** 玩家自己起的名字（配置、账户、皮肤、存档）：界面翻译不要动它，比如配置叫「测试」不能显示成 Test */
  const noTr = (s) => h('span', { 'data-no-tr': '' }, s);
  function fmtDuration(ms) {
    const m = Math.round((ms || 0) / 60000);
    if (m < 1) return '不到 1 分钟';
    if (m < 60) return `${m} 分钟`;
    const hh = Math.floor(m / 60);
    return `${hh} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
  }

  function versionSub(v) {
    const parts = [];
    if (v.loader) parts.push(`${(LOADERS[v.loader.type] || {}).name || v.loader.type}${v.loader.version ? ` ${v.loader.version}` : ''}`);
    parts.unshift(`Minecraft ${A.nm(v.mcVersion)}`);
    return parts.join(' · ');
  }

  // ── 全局状态与事件 ──
  const bus = new EventTarget();
  const emit = (name, detail, extra) => { const e = new CustomEvent(name, { detail }); e.extra = extra; return bus.dispatchEvent(e); };
  const on = (name, fn) => { const h2 = (e) => fn(e.detail, e.extra); bus.addEventListener(name, h2); return () => bus.removeEventListener(name, h2); };

  const state = {
    config: null,
    info: null,
    installed: [],
    accounts: { accounts: [], selected: '' },
    javas: null,
    tasks: new Map(),
    games: new Map(),
    manifest: null,
    page: 'home',
  };

  /**
   * 全局刷新（2.0.0-pre7）：同一时间只跑一个，所以旧结果不会盖掉新的。
   * 跑着的时候又要刷新：等它跑完再跑一次，这期间再多的请求也只算一次（profiles:list 每次都读全部配置的 JSON 和世界列表）
   */
  function coalesced(load) {
    let current = null;
    let next = null;
    const start = (...args) => { current = load(...args).finally(() => { current = null; }); return current; };
    return (...args) => {
      if (!current) return start(...args);
      if (!next) next = current.catch(() => {}).then(() => { next = null; return start(...args); });
      return next;
    };
  }
  const refreshInstalled = coalesced(async () => {
    try { state.installed = await api('profiles:list'); } catch {
      try { state.installed = await api('versions:installed'); } catch { state.installed = []; }
    }
    emit('installed', state.installed);
    return state.installed;
  });
  async function refreshAccounts() {
    state.accounts = await api('accounts:list');
    emit('accounts', state.accounts);
    return state.accounts;
  }
  const refreshJavas = coalesced(async (force) => {
    state.javas = await api('java:detect', !!force);
    emit('javas', state.javas);
    return state.javas;
  });
  // config 事件的第二个参数是改了哪些键：记个 tips 不用重画界面
  const QUIET_KEYS = new Set(['tips']);
  function changedKeys(a, b) {
    if (!a) return Object.keys(b || {});
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  }
  const configMatters = (changed) => !changed || changed.some((k) => !QUIET_KEYS.has(k));
  function adoptConfig(c) {
    const changed = changedKeys(state.config, c);
    state.config = c;
    emit('config', c, changed);
    return c;
  }
  async function setConfig(patch) {
    return adoptConfig(await api('config:set', patch));
  }
  /** 页面刷新约定（2.0.0-pre7）：数据变了，这一页在前台就画，不在前台只记一下，切回来再画。返回「要刷新了」的函数 */
  function pageRefresher(page, draw) {
    let dirty = false;
    on('page', (p) => { if (p === page && dirty) { dirty = false; draw(); } });
    return () => { if (state.page === page) { dirty = false; draw(); } else dirty = true; };
  }
  function currentAccount() {
    return state.accounts.accounts.find((a) => a.id === state.accounts.selected) || state.accounts.accounts[0] || null;
  }
  function currentVersion() {
    const id = state.config && state.config.selectedVersion;
    return state.installed.find((v) => v.id === id) || state.installed[0] || null;
  }

  window.A = {
    // 底层要用上层的功能时，上层在这里登记，底层不直接认识它们（2.0.0-pre9，分层检查）
    hooks: { netError: null, recorder: null, goBack: null, noDangerWait: null, tipBlocks: [] },
    api, apiPending: () => pending, listen, h, $, $$, clear, mount, append, icon, ICONS, t, BRAND, cmpMc: window.MCVER.cmpMc,
    fmtBytes, fmtSpeed, fmtDate, fmtRelative, fmtNum, noTr, fmtEta, fmtMem, debounce,
    nm: window.I18N.nm, nmJoin: window.I18N.nmJoin, safeName: window.PATHRULES.safeName, cutChars: window.PATHRULES.cutChars, nameProblem: window.PATHRULES.problemText,
    LOADERS, TYPE_NAMES, PROFILE_TYPES, LEVELS, level, levelIcon, FEATURES, MS_PENDING, msPendingNotice, displayName, fmtDuration, versionSub,
    bus, emit, on, state, refreshInstalled, refreshAccounts, refreshJavas, setConfig, adoptConfig, configMatters, pageRefresher, currentAccount, currentVersion,
    pages: {},
  };
})();
