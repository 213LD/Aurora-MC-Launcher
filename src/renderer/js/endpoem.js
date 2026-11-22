'use strict';
/**
 * 终末之诗播放（1.5.16，终极彩蛋）：A.endPoem.play() → Promise（播完或跳过后 resolve）
 * - 盖住整个启动器窗口（侧边栏、顶栏都不见了），黑底星空，诗从下往上滚，两个说话者两种颜色（和原版一样 §3 青色 / §2 绿色）
 * - 原文从游戏里读（sys:endPoem），读不到用自带的英文原文（endpoemtext.js）；中文界面每段下面附中文翻译（中英对照）
 * - 按住空格或鼠标加速，Esc 或右下角「跳过」结束
 * - 减弱动态效果：不滚动，一段一段换（自动翻页，点一下或按空格下一段），乱码不闪
 * - 音乐：音乐开着时放游戏里的通关音乐（music.credits），没有就放启动器的「虚空」；播完恢复原来的音乐
 */
(function () {
  const { h, api, state } = A;
  const OBF = '§f§k§a§b';
  const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&@?';

  const norm = (s) => String(s).split(OBF).join(' ').replace(/§./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  // 界面文字（跳过、提示）中文界面写中文（繁中由 translate.js 转）；中英对照只在简中界面，别的语言只显示英文原文
  const isZh = () => /^zh/i.test((window.I18N && window.I18N.getLang()) || 'zh-CN');
  const withZh = () => ((window.I18N && window.I18N.getLang()) || 'zh-CN') === 'zh-CN';

  async function loadText() {
    const r = await api('sys:endPoem').catch(() => null);
    const raw = r && r.text ? r.text : A.endPoemText.EN.join('\n\n');
    return { lines: raw.split(/\r?\n/).filter((l) => l.trim()), fromGame: !!(r && r.text), version: r && r.version };
  }

  /** 一段文字 → DOM：§3 / §2 换颜色，乱码段落变成会闪的 span */
  function renderLine(line, name, obfs) {
    const speaker = /^§2/.test(line) ? 'b' : 'a';
    const parts = line.replace(/PLAYERNAME/g, name).split(OBF);
    const out = [];
    parts.forEach((p, i) => {
      if (i > 0) {
        const n = 3 + Math.floor(Math.random() * 4);
        const sp = h('span.ep-obf', 'x'.repeat(n));
        sp.dataset.n = n;
        obfs.push(sp);
        out.push(sp);
      }
      const text = p.replace(/§./g, '');
      if (text) out.push(text);
    });
    return { speaker, nodes: out };
  }

  function renderZh(zh, name, obfs) {
    return zh.replace(/PLAYERNAME/g, name).split('{?}').flatMap((p, i) => {
      if (!i) return [p];
      const sp = h('span.ep-obf', 'xxxx');
      sp.dataset.n = 4;
      obfs.push(sp);
      return [sp, p];
    });
  }

  /** 播放；opts.reduce：减弱动态效果（翻页） */
  async function play(opts = {}) {
    const reduce = opts.reduce ?? (A.a11y && A.a11y.reduceMotion());
    const { lines } = await loadText();
    const zhMap = new Map();
    if (withZh()) A.endPoemText.EN.forEach((en, i) => zhMap.set(norm(en), A.endPoemText.ZH[i]));
    const acc = A.currentAccount && A.currentAccount();
    const name = (acc && acc.name) || 'Player';
    const obfs = [];
    const paras = lines.map((line) => {
      const { speaker, nodes } = renderLine(line, name, obfs);
      let zh = zhMap.get(norm(line));
      // 译文和原文一样（只有玩家名那行）就不重复
      const bare = (x) => x.replace(/PLAYERNAME/g, '').replace(/§./g, '').replace(/[\s?？.。!！]/g, '');
      if (zh && !bare(zh)) zh = null;
      return h(`div.ep-p.${speaker}`, h('div.ep-en', nodes), zh ? h('div.ep-zh', renderZh(zh, name, obfs)) : null);
    });

    const zh = isZh();
    const body = h('div.ep-body', paras);
    const skip = h('button.ep-skip', { type: 'button' }, zh ? '跳过' : 'Skip', h('kbd', 'Esc'));
    const hint = h('div.ep-hint', reduce ? (zh ? '点一下或按空格：下一段' : 'Click or press Space for the next part') : (zh ? '按住空格或鼠标：加速' : 'Hold Space or the mouse button to speed up'));
    const stars = h('canvas.ep-stars');
    const root = h('div.endpoem', { role: 'dialog', 'aria-label': zh ? '终末之诗' : 'The End Poem', class: reduce ? 'endpoem reduce' : 'endpoem' }, stars, h('div.ep-view', { 'data-no-tr': '' }, body), skip, hint);
    document.body.appendChild(root);
    document.documentElement.classList.add('endpoem-on');
    requestAnimationFrame(() => root.classList.add('in'));

    // 音乐
    const music = (state.config && state.config.music) || {};
    const wasPlaying = !!(A.music && A.music.state.playing);
    if (wasPlaying) A.music.stop();
    let credits = null;
    if (music.enabled && A.gameSound) {
      credits = await A.gameSound.play('music.credits', { volume: 0.55, music: true }).catch(() => null);
      if (!credits && A.music) A.music.play('void').catch(() => {});
    }

    return new Promise((resolve) => {
      let done = false;
      let fast = false;
      let y = 0;
      let idx = 0;
      let raf = 0;
      let pageTimer = 0;
      let next = () => {};
      const view = root.querySelector('.ep-view');
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf); clearTimeout(pageTimer); clearInterval(obfTimer);
        window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true);
        if (credits) credits.stop(2);
        if (A.music) { if (wasPlaying || (music.enabled && !credits)) A.music.stop(); if (wasPlaying) setTimeout(() => A.music.play().catch(() => {}), 600); }
        root.classList.remove('in');
        setTimeout(() => { root.remove(); document.documentElement.classList.remove('endpoem-on'); resolve(); }, 900);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); return; }
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (reduce) next(); else fast = true; }
      };
      const onKeyUp = (e) => { if (e.key === ' ' || e.key === 'Enter') fast = false; };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKeyUp, true);
      skip.onclick = (e) => { e.stopPropagation(); finish(); };
      root.addEventListener('mousedown', (e) => { if (e.target === skip) return; if (reduce) next(); else fast = true; });
      root.addEventListener('mouseup', () => { fast = false; });

      // 乱码：每 80ms 换一次字（减弱动态效果时固定）
      const scramble = () => { for (const sp of obfs) { let s = ''; for (let i = 0; i < Number(sp.dataset.n); i++) s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)]; sp.textContent = s; } };
      scramble();
      const obfTimer = reduce ? 0 : setInterval(scramble, 80);

      // 背景星空（减弱动态效果时不闪）
      const sc = stars.getContext('2d');
      const sizeStars = () => { stars.width = Math.ceil(root.clientWidth / 3); stars.height = Math.ceil(root.clientHeight / 3); };
      sizeStars();
      const dots = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), p: Math.random() * 6, c: Math.random() < 0.2 ? [140, 220, 210] : Math.random() < 0.3 ? [190, 150, 255] : [255, 255, 255] }));
      const drawStars = (t) => {
        sc.clearRect(0, 0, stars.width, stars.height);
        for (const d of dots) {
          const a = reduce ? 0.5 : 0.25 + 0.5 * Math.abs(Math.sin(t / 1400 + d.p));
          sc.fillStyle = `rgba(${d.c[0]},${d.c[1]},${d.c[2]},${a})`;
          sc.fillRect(Math.floor(d.x * stars.width), Math.floor(d.y * stars.height), 1, 1);
        }
      };

      if (reduce) {
        // 翻页：一次一段
        body.classList.add('paged');
        const show = () => {
          paras.forEach((p, i) => p.classList.toggle('on', i === idx));
          drawStars(0);
          const len = paras[idx].textContent.length;
          clearTimeout(pageTimer);
          pageTimer = setTimeout(next, Math.max(3500, len * (zh ? 90 : 55)));
        };
        next = () => { if (done) return; idx++; if (idx >= paras.length) { setTimeout(finish, 1500); return; } show(); };
        show();
        return;
      }

      // 滚动：从窗口底下开始往上走，最后一段离开中间后结束
      y = view.clientHeight;
      let last = performance.now();
      const step = (t) => {
        if (done) return;
        const dt = Math.min(100, t - last); last = t;
        y -= (dt / 1000) * (fast ? 160 : 30);
        body.style.transform = `translateY(${Math.round(y)}px)`;
        drawStars(t);
        if (y < -body.offsetHeight + view.clientHeight * 0.35) { finish(); return; }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
  }

  A.endPoem = { play, loadText };
})();
