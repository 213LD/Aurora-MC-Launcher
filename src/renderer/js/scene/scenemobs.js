'use strict';
/**
 * 主页背景生物重画大一圈（rc3，试用：生物有些认不出来，像 1.7.0 放大玩家那样放大一圈）。
 * 玩家是 4 × 10：头 4 格宽，身子、腿 2 格宽在头的正中间。人形的怪物和村民也照这个比例画（以前是 3 × 8），
 * 动物、鱼、飞的按各自的样子多给一两格，把最好认的地方画出来：猪鼻子、牛角、苦力怕的脸、蜘蛛的腿、末影人的紫眼睛……
 * 这里只换样子：原来在各个模块里给的属性（敌对、会烧、会游泳、会飞、发光的颜色）照旧留着。
 * 要放在所有定义生物的模块后面加载（index.html）
 */
(function () {
  const { SPRITES, H } = A.sceneKit;

  /** 换掉一个生物的样子，属性（hostile、swims、emissive……）留着；extra 里可以改属性 */
  function redo(kind, rows, colors, extra = {}) {
    const old = SPRITES[kind] || {};
    const keep = Object.fromEntries(Object.entries(old).filter(([k]) => !['rows', 'w', 'h', 'colors', 'walk', 'swing'].includes(k)));
    for (const r of rows) if (r.length !== rows[0].length) throw new Error(`${kind}：每行要一样宽`);
    SPRITES[kind] = H(rows, colors, { ...keep, ...extra });
  }
  /** 人形的走路那一帧：最后三行换成两腿前后分开（和玩家一样） */
  const stride = (rows, legs) => [...rows.slice(0, rows.length - legs.length), ...legs];

  // ───────────── 人形：僵尸一类（两只手往前伸） ─────────────
  const ZOMBIE = ['HHHH.', 'HHSS.', 'HSSK.', 'HSSN.', '.TTAA', '.TT..', '.tT..', '.PP..', '.Pp..', '.BB..'];
  const ZOMBIE_WALK = stride(ZOMBIE, ['.Pp..', 'P..p.', 'B..b.']);
  const zombie = (kind, c, extra) => redo(kind, ZOMBIE, c, { walk: ZOMBIE_WALK, ...extra });
  zombie('zombie', { H: '#2e5e2e', S: '#5a8f4a', K: '#14200f', N: '#3f6a35', T: '#2f8f9a', t: '#24707a', A: '#5a8f4a', P: '#3a3a8f', p: '#2c2c70', B: '#3a3a3a', b: '#2a2a2a' });
  zombie('husk', { H: '#6b5a3a', S: '#a8946a', K: '#2a2010', N: '#86744e', T: '#8a7a50', t: '#6e6040', A: '#a8946a', P: '#5a4a30', p: '#463a24', B: '#3a3a3a', b: '#2a2a2a' });
  zombie('drowned', { H: '#2a6a6a', S: '#4a9a8a', K: '#7fe0ff', N: '#357a6e', T: '#3a7a8a', t: '#2a5e6c', A: '#4a9a8a', P: '#2a4a6a', p: '#203a54', B: '#2a3a3a', b: '#1e2c2c' }, { emissive: 'K' });

  // ───────────── 骷髅一类（拿弓 / 剑，腿是两根骨头） ─────────────
  const SKEL = ['HHHH.', 'HSSS.', 'HSKS.', 'HSSK.', '.TT..', '.tTAb', '.TtAb', '.T.T.', '.T.T.', '.T.T.'];
  const SKEL_WALK = stride(SKEL, ['.T.T.', 'T..T.', 'T...T']);
  redo('skeleton', SKEL, { H: '#c8c8c8', S: '#d8d8d8', K: '#2e2e2e', T: '#b4b4b4', t: '#8c8c8c', A: '#c8c8c8', b: '#6b4f2a' }, { walk: SKEL_WALK });
  redo('stray', SKEL.map((r, i) => (i >= 4 && i <= 6 ? r.replace(/T/g, 'C').replace(/t/g, 'c') : r)), { H: '#b8c8c8', S: '#c8d6d6', K: '#2e3434', C: '#6a8a8f', c: '#506e72', T: '#b0bebe', A: '#c8d4d4', b: '#6b4f2a' }, { walk: SKEL_WALK.map((r, i) => (i >= 4 && i <= 6 ? r.replace(/T/g, 'C').replace(/t/g, 'c') : r)) });
  const WSKEL = ['HHHH.', 'HSSS.', 'HSKS.', 'HSSKs', '.TT.s', '.tTAs', '.TtA.', '.TT..', '.T.T.', '.T.T.', '.T.T.'];
  redo('witherSkeleton', WSKEL, { H: '#2a2a2a', S: '#343434', K: '#060606', T: '#262626', t: '#1a1a1a', A: '#303030', s: '#a0a0a0' }, { walk: stride(WSKEL, ['.T.T.', 'T..T.', 'T...T']) });

  // ───────────── 苦力怕：正脸（最好认）——两只方眼睛，下面那张往下撇的嘴；身子在中间，四只脚 ─────────────
  // （rc3 试用：头 4 格宽时脸挤成一团、呆呆的，看不出是苦力怕，改成 6 格宽，原版的脸能完整画出来）
  redo('creeper', ['GgGGgG', 'GKKGKK', 'gKKGKK', 'GGGKGG', 'GGKKKG', 'gGKGKG', '.GGgG.', '.GgGG.', 'GG..GG', 'gG..Gg'], { G: '#5fb54a', g: '#3f8a32', K: '#111111' });

  // ───────────── 蜘蛛：身子压得低，前后各一对腿高高拱起来，头上红眼睛 ─────────────
  // （rc3 试用：八条腿一排全画出来像在地上蠕动的毛毛虫，只画前后两对拱起来的腿）
  // （rc3 在几种画法里挑的这一版）
  redo('spider', ['..l....l..', '.l.kkkk.l.', 'l.kkkkkkRR', 'l.kkkkkkk.', 'l.......l.'], { k: '#3a3330', R: '#d02020', l: '#2a2420' });
  redo('caveSpider', ['..l...l.', '.l.kkk.l', 'l.kkkkRR', 'l.....l.'], { k: '#1d3a48', R: '#d02020', l: '#16303c' });

  // ───────────── 末影人：黑、细长，紫眼睛 ─────────────
  const ENDER = ['KKKK', 'KKKK', 'KKPP', 'KKKK', '.KK.', '.KKK', '.KKK', '.KKK', '.KK.', '.K.K', '.K.K', '.K.K', '.K.K', '.K.K'];
  redo('enderman', ENDER, { K: '#151515', P: '#d78cff' }, { walk: stride(ENDER, ['.K.K', 'K..K', 'K..K']) });
  redo('endermite', ['.mmm.', 'mmmmm', 'l.l.l'], { m: '#5a3a7a', l: '#3e2856' });

  // ───────────── 村民、灾厄村民、女巫：大鼻子 ─────────────
  const VILL = ['SSSS.', 'SSbb.', 'SSSE.', 'SSSNN', '.RRR.', '.RAA.', '.RRR.', '.RRR.', '.RRR.', '.FF..'];
  redo('villager', VILL, { S: '#c09070', b: '#3a2414', E: '#2f6f3a', N: '#a87858', R: '#6e4b2e', A: '#c09070', F: '#3a2a20' });
  const ILL = (item) => ['SSSS.', 'SSbb.', 'SSSE.', 'SSSNN', '.CCC.', `.CA${item}${item}`, '.CCC.', '.PP..', '.Pp..', '.BB..'];
  const ILL_WALK = (item) => stride(ILL(item), ['.Pp..', 'P..p.', 'B..b.']);
  const illC = { S: '#9aa39b', b: '#2c3030', E: '#2a2a2a', N: '#7f8a82', A: '#9aa39b', B: '#2a2628', p: '#2c282e' };
  redo('pillager', ILL('x'), { ...illC, C: '#4a4248', P: '#3a3540', x: '#6b4a2a' }, { walk: ILL_WALK('x') });
  redo('vindicator', ILL('x'), { ...illC, C: '#2f3a40', P: '#2a2f36', x: '#c8c8c8' }, { walk: ILL_WALK('x') });
  redo('evoker', ['SSSS.', 'SSbb.', 'SSSE.', 'SSSNN', '.RRR.', '.RGAA', '.RGR.', '.RGR.', '.RRR.', '.RRR.'], { ...illC, R: '#2a2a2e', G: '#d8b030' });
  redo('witch', ['..h..', '.hhh.', 'hhhhh', 'SSSE.', 'SSSNN', '.SSw.', '.PPP.', '.PAA.', '.PPP.', '.PPP.', '.BB..'], { h: '#3a2a4a', S: '#9a8a7a', E: '#7a3a9a', N: '#7a6a5a', w: '#4a8a3a', P: '#4a2a5a', A: '#9a8a7a', B: '#2a1e2a' });

  // ───────────── 猪灵一类：猪鼻子、獠牙 ─────────────
  const PIG = ['HHHH.', 'HSSE.', 'HSSNN', '.SSNn', '.GG..', '.LGA.', '.LL..', '.PP..', '.Pp..', '.BB..'];
  const PIG_WALK = stride(PIG, ['.Pp..', 'P..p.', 'B..b.']);
  const pigC = { H: '#e2a98f', S: '#e8b49c', E: '#222222', N: '#d6907a', n: '#f0e6c8', A: '#e8b49c', p: '#47301a', B: '#3a2a20', b: '#2a1e16' };
  redo('piglin', PIG, { ...pigC, G: '#e0b030', L: '#6a4a2a', P: '#5a3a20' }, { walk: PIG_WALK });
  redo('zpiglin', PIG, { ...pigC, H: '#d79a86', S: '#7fa06a', N: '#e0a090', A: '#7fa06a', G: '#c0a050', L: '#5a4a30', P: '#5a3a20' }, { walk: PIG_WALK });
  redo('piglinBrute', ['HHHH.', 'HSSE.', 'HSSNN', '.SSNn', '.KK.a', '.KKAa', '.KK..', '.PP..', '.Pp..', '.BB..'], { ...pigC, K: '#3a3a3a', a: '#e0b030', P: '#2a2a2a', B: '#1a1a1a' }, { walk: stride(['HHHH.', 'HSSE.', 'HSSNN', '.SSNn', '.KK.a', '.KKAa', '.KK..', '.PP..', '.Pp..', '.BB..'], ['.Pp..', 'P..p.', 'B..b.']) });

  // ───────────── 农场动物 ─────────────
  redo('pig', ['......pp.', 'ppppppppe', 'ppppppppS', 'pppppppSS', '.ll...ll.'], { p: '#f2a7a4', S: '#d4807f', e: '#2a1a1a', l: '#d48a87' });
  const COW = ['.......h.h', '.bbwwbbbbb', 'bwwbbwwbbe', 'bbwwwbbwnn', '.bwwbbww..', '.l.l..l.l.'];
  redo('cow', COW, { b: '#3b2a20', w: '#e8e4dc', h: '#d8d0b8', e: '#111111', n: '#d9a0a0', l: '#2a1e18' });
  redo('mooshroom', ['.rR...rR..', ...COW], { r: '#d23a32', R: '#f0e8dc', b: '#a82a24', w: '#d8d0c4', h: '#d8d0b8', e: '#111111', n: '#e0a0a0', l: '#5a2420' });
  redo('sheep', ['..wwwww..', '.wwwwwwww', 'wwwwwwwfe', 'wwwwwwwff', '.wwwwww..', '.l..l.l..'], { w: '#e8e8e8', f: '#c8b49a', e: '#222222', l: '#c8b49a' });
  redo('chicken', ['...ww.', '...wey', 'w..wwr', 'wwwww.', '.www..', '..l.l.'], { w: '#f2f2f2', e: '#111111', y: '#e8a82a', r: '#d83030', l: '#e8a82a' });
  redo('rabbit', ['..b.b', '..bbb', 'bbbbe', 'bb.b.'], { b: '#a8835a', e: '#111111' });
  redo('rabbitW', ['..b.b', '..bbb', 'bbbbe', 'bb.b.'], { b: '#eeeeee', e: '#111111' });
  redo('wolf', ['......ww.', 'w.....wew', 'wwwwwwwwn', '.wwwwww..', '.l.l..l.l'], { w: '#d8d4cc', e: '#222222', n: '#2a2a2a', l: '#b8b2a8' });
  const FOX = ['......o.o', 'o.....ooe', 'oooooooow', '.wooooo..', '.l.l..l.l'];
  redo('fox', FOX, { o: '#e07a2a', w: '#f2f2f2', e: '#222222', l: '#3a2a20' });
  redo('foxW', FOX, { o: '#f0f0f0', w: '#ffffff', e: '#222222', l: '#9a9a9a' });
  redo('polar', ['......ww.', '.wwwwwwww', 'wwwwwwwwe', 'wwwwwwwwn', '.wwwwwww.', '.ll..ll..'], { w: '#f4f4f0', e: '#222222', n: '#333333', l: '#dddddd' });
  redo('camel', ['.......hh', '......hhe', '..cc..hh.', '.cccccch.', 'cccccccc.', '.cccccc..', '.l....l..', '.l....l..', '.l....l..'], { c: '#d6a95f', h: '#c99a52', e: '#222222', l: '#b88a48' });
  redo('goat', ['......H..', '.....www.', 'wwwwwwwwe', 'wwwwwwwwb', '.wwwwww..', '.l.l..l.l'], { w: '#e8e2d6', H: '#b8ab94', e: '#222222', b: '#d0c8b8', l: '#a89e8c' });
  redo('bee', ['.WW.', 'ykyE', 'ykyy'], { W: '#d8eefc', y: '#f2c22a', k: '#222222', E: '#222222' });

  // ───────────── 丛林 ─────────────
  const PARROT = ['..bb.', '.bbbY', '.bbw.', '..ww.', '..t..'];
  for (const [k, body, wing] of [['parrot', '#d8302a', '#2a6ad8'], ['parrotBlue', '#3a6ae0', '#e8c040'], ['parrotGreen', '#4ab82a', '#d8302a']]) redo(k, PARROT, { b: body, Y: '#f0c040', w: wing, t: body });
  redo('ocelot', ['.......y.', 'y.....yye', 'yySyySyyy', '.yyyyyy..', '.l.l..l.l'], { y: '#e0b850', S: '#7a5a28', e: '#3a8a3a', l: '#c89a40' });
  redo('panda', ['......k.k', '.....wwww', 'wwwwwwkew', 'wwwwwwwwk', 'kkkwkkkk.', 'k.k..k.k.'], { w: '#eeeeea', k: '#262626', e: '#ffffff' });

  // ───────────── 下界 ─────────────
  redo('strider', ['.rrrr', 'rrrre', 'rrrrr', 'r.r.r', '.l.l.', '.l.l.', '.l.l.'], { r: '#b0353a', e: '#222222', l: '#7a3a3a' });
  redo('magma', ['mmmmm', 'mOmOm', 'mmmmm', 'mmmmm'], { m: '#4a1a10', O: '#ff9a2a' }); // 不画嘴（rc3 试用：看着更舒服）
  redo('blaze', ['.yyy.', 'yyEyE', '.yyy.', 'r...r', '.r.r.', 'r...r', '.r.r.', 'r...r', '..r..'], { y: '#f2c23a', E: '#ffffff', r: '#e88a1a' });
  redo('hoglin', ['.....t.t.', '..hhhhhh.', 'hhhhhhhhe', 'hhhhhhhnn', '.hhhhhh..', '.l.l..l.l'], { h: '#c08060', t: '#e8d8c0', e: '#222222', n: '#a06848', l: '#8a5a40' });

  // ───────────── 天上、水里 ─────────────
  redo('bat', ['w.....w', 'ww.b.ww', 'wwwbwww', '...b...'], { w: '#2e2620', b: '#4a3a2e' });
  redo('phantom', ['p.......p', 'pp.....pp', 'pppGpGppp'], { p: '#4a5a8a', G: '#a8ff6a' });
  redo('squid', ['.sss.', 'sssss', 'ssEss', 'sssss', 's.s.s', 's.s.s'], { s: '#2a3a6a', E: '#dddddd' });
  redo('glowSquid', ['.ggg.', 'gGgGg', 'ggEgg', 'gGgGg', 'g.g.g', 'g.g.g'], { g: '#1d6a72', G: '#7ff0e0', E: '#e0fff8' });
  redo('cod', ['C.cc.', '.ccce', 'C.cc.'], { c: '#b8a07a', C: '#8a7a5a', e: '#222222' });
  redo('salmon', ['..rr..', 'Srrrre', '.rrrr.'], { r: '#a84a3a', S: '#8a3a2a', e: '#222222' });
  redo('tropical', ['.oo.', 'owoe', '.ow.'], { o: '#f07a2a', w: '#ffffff', e: '#222222' });
  redo('pufferfish', ['.y.y.', 'yyyyy', 'yyyyE', '.yyy.'], { y: '#e8c840', E: '#222222' });
  redo('dolphin', ['...d....', 'dddddddd', '.ddddddw', 'd.......'], { d: '#7a9ab8', w: '#d8e4f0' });
  redo('turtle', ['..ggg.', '.ggggg', 'gGgGgg', '.l..l.'], { g: '#3f8a4a', G: '#2f6a38', l: '#5aa05a' });
  redo('guardian', ['.s.s.s', 'gggggs', 'sggggE', 'gggggs', '.s.s.s', '..g...'], { g: '#5f9e8e', s: '#d07a3a', E: '#f0e0a0' });
  redo('elderGuardian', ['.s.s.s.s', 'sgggggg.', 'ggggggEs', 'ggggggg.', 'sgggggs.', '.s.s.s.s', '..g.....'], { g: '#bcbca8', s: '#8a7a6a', E: '#a060c0' });
  // 美西螈：头上两边的鳃、四只小脚、长尾巴
  const AXO = { axolotl: ['#f4a6c8', '#e07aa8', '#c8507a'], axolotlWild: ['#7a5a40', '#5e4430', '#a07a5a'], axolotlGold: ['#f0c850', '#d8a830', '#f08a3a'], axolotlCyan: ['#d8eef4', '#b8d8e0', '#e86aa0'], axolotlBlue: ['#5a6ae0', '#4250c0', '#e8d040'] };
  for (const [k, [b, d, g]] of Object.entries(AXO)) redo(k, ['......G.G', 'tt..bbbbG', '.tbbbbbbe', '..d.d.d..'], { b, d, t: d, G: g, e: '#222222' });
  // 史莱姆（rc3 加的，以前没有普通史莱姆）：外面一层浅绿，里面深绿的核和两只眼睛，一跳一跳地走
  SPRITES.slime = H(['sssss', 'sSSSs', 'sKSKs', 'sSSSs', 'sssss'], { s: '#8ad870', S: '#5aa846', K: '#1e3a18' }, { hostile: true, hops: true });
  redo('shulker', ['.ppp.', 'ppppp', 'pYYYp', 'ppppp', 'ppppp'], { p: '#9a6a9a', Y: '#e8d870' });
})();
