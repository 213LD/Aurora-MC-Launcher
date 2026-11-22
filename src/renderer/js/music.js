'use strict';
/**
 * 启动器背景音乐：10 首原创的 Minecraft 风格氛围循环（4 首通用 + 6 首配合背景场景的主题曲）
 * 乐谱以类 MIDI 的音符序列记录，用 Web Audio 实时合成（钢琴、FM 钟声、卡林巴、长笛、温暖铺底、贝斯、拨弦、冰晶、持续低音 + 混响），
 * 也可以导出为标准 MIDI 文件。
 *
 * 记谱：空格分隔，"C5" 一拍，"C5:1.5" 指定拍数，"r:2" 休止，"F3+A3+C4:4" 和弦，"|" 仅用于标记小节
 */
(function () {
  const { h, icon, api, state, on, $ } = A;

  // ───────────────────────── 乐谱 ─────────────────────────
  const TRACKS = [
    {
      id: 'dawn', name: '晨光', en: 'Dawn', mood: '温柔 · 清晨', bpm: 72, beats: 48, color: '#fbbf24',
      voices: [
        { inst: 'pad', vol: 0.9, seq: 'F3+A3+C4+E4:4 A3+C4+E4+G4:4 Bb3+D4+F4+A4:4 C4+E4+G4+A4:4 F3+A3+C4+E4:4 D3+F3+A3+C4:4 G3+Bb3+D4+F4:4 C4+F4+G4+Bb4:4 Bb3+D4+F4+A4:4 A3+C4+E4+G4:4 G3+Bb3+D4+F4:4 C4+F4+G4+C5:4' },
        { inst: 'bass', vol: 0.9, seq: 'F2:4 A2:4 Bb1:4 C2:4 F2:4 D2:4 G1:4 C2:4 Bb1:4 A1:4 G1:4 C2:4' },
        { inst: 'piano', vol: 1, seq: 'r:1 C5 A4:.5 C5:.5 F5 | E5:2 r C5:.5 D5:.5 | F5:1.5 E5:.5 D5 A4 | G4:3 r | r:1 A5 G5:.5 F5:.5 C5 | D5:2 F5 A5 | G5:1.5 F5:.5 D5 Bb4 | C5:3 r | D5:.5 F5:.5 A5 G5 F5 | E5:2 C5 E5 | D5:1.5 C5:.5 Bb4 G4 | A4:2 G4:2' },
        { inst: 'pluck', vol: 0.45, arp: { pattern: [0, 2, 1, 3, 2, 1, 3, 2], step: 0.5, oct: 0 }, seq: 'F3+A3+C4+E4:4 A3+C4+E4+G4:4 Bb3+D4+F4+A4:4 C4+E4+G4+A4:4 F3+A3+C4+E4:4 D3+F3+A3+C4:4 G3+Bb3+D4+F4:4 C4+F4+G4+Bb4:4 Bb3+D4+F4+A4:4 A3+C4+E4+G4:4 G3+Bb3+D4+F4:4 C4+F4+G4+C5:4' },
      ],
    },
    {
      id: 'cavern', name: '幽洞', en: 'Cavern', mood: '神秘 · 深处', bpm: 60, beats: 40, color: '#818cf8',
      voices: [
        { inst: 'pad', vol: 1, dark: true, seq: 'A2+E3+C4+G4:4 F2+C3+A3+E4:4 D3+A3+C4+F#4:4 E2+B2+G3+D4:4 A2+E3+C4+G4:4 C3+G3+E4+B4:4 F2+C3+A3+E4:4 D3+F#3+A3+C4:4 E2+B2+E3+G#3:4 A2+E3+A3+C4:4' },
        { inst: 'bass', vol: 1, seq: 'A1:4 F1:4 D2:4 E1:4 A1:4 C2:4 F1:4 D2:4 E1:4 A1:4' },
        { inst: 'bell', vol: 0.9, seq: 'r:2 E5:2 | r:1 C5 B4:2 | A4:3 r | r:2 G4 B4 | C5:2 E5:1.5 D5:.5 | B4:4 | r:1 A4 C5 E5 | F#5:3 r | E5:2 G#4:2 | A4:4' },
        { inst: 'pluck', vol: 0.5, seq: 'r:3 E6:1 | r:4 | r:2 A6:1 r | r:4 | r:1 B5 r:2 | r:4 | r:3 E6 | r:4 | r:2.5 G#5:.5 r | r:4' },
      ],
    },
    {
      id: 'grove', name: '林间', en: 'Grove', mood: '轻快 · 阳光', bpm: 88, beats: 64, color: '#34d399',
      voices: [
        { inst: 'pad', vol: 0.75, seq: 'D3+A3+D4+F#4:8 B2+F#3+B3+D4:8 G2+D3+B3+D4:8 A2+E3+C#4+E4:8 D3+A3+D4+F#4:8 F#2+C#3+A3+C#4:8 G2+D3+G3+B3:8 A2+E3+A3+C#4:8' },
        { inst: 'bass', vol: 0.85, seq: 'D2:4 A1:4 B1:4 F#1:4 G1:4 D2:4 A1:4 E2:4 D2:4 A1:4 F#1:4 C#2:4 G1:4 D2:4 A1:8' },
        { inst: 'pluck', vol: 0.85, arp: { pattern: [0, 1, 2, 3, 1, 2, 3, 2], step: 0.5, oct: 12 }, seq: 'D3+A3+D4+F#4:8 B2+F#3+B3+D4:8 G2+D3+B3+D4:8 A2+E3+C#4+E4:8 D3+A3+D4+F#4:8 F#2+C#3+A3+C#4:8 G2+D3+G3+B3:8 A2+E3+A3+C#4:8' },
        { inst: 'flute', vol: 0.9, seq: 'r:32 F#5:2 A5:2 B5:3 A5:1 F#5:2 E5:2 C#5:4 D5:2 E5:1 F#5:1 B4:4 C#5:2 E5:2 A4:4' },
      ],
    },
    {
      id: 'starfall', name: '星落', en: 'Starfall', mood: '宁静 · 夜晚', bpm: 64, beats: 48, color: '#38bdf8',
      voices: [
        { inst: 'pad', vol: 0.95, seq: 'Eb3+G3+Bb3+D4:4 C3+Eb3+G3+Bb3:4 Ab2+C3+Eb3+G3:4 Bb2+D3+F3+A3:4 Eb3+G3+Bb3+D4:4 G2+D3+F3+Bb3:4 Ab2+Eb3+G3+C4:4 Bb2+F3+Ab3+C4:4 C3+G3+Bb3+D4:4 Ab2+Eb3+G3+C4:4 F2+C3+Eb3+A3:4 Bb2+F3+Ab3+D4:4' },
        { inst: 'bass', vol: 0.85, seq: 'Eb2:4 C2:4 Ab1:4 Bb1:4 Eb2:4 G1:4 Ab1:4 Bb1:4 C2:4 Ab1:4 F1:4 Bb1:4' },
        { inst: 'bell', vol: 1, seq: 'G5:1.5 Bb5:.5 D6:2 | C6:3 Bb5 | Ab5:2 G5 Eb5 | F5:4 | G5:1 Bb5:1 Eb6:2 | D6:2 Bb5:2 | C6:1.5 Bb5:.5 G5:2 | F5:2 Ab5:2 | G5:2 Bb5:1 D6:1 | C6:4 | A5:2 C6:1 Eb6:1 | D6:2 Bb5:2' },
        { inst: 'piano', vol: 0.55, seq: 'r:4 | r:2 G4:2 | r:4 | r:2 D4:2 | r:4 | r:2 F4:2 | r:4 | r:2 Eb4:2 | r:4 | r:2 Eb4:2 | r:4 | r:2 F4:2' },
      ],
    },
    // ── 以下为配合背景场景的主题曲 ──
    {
      id: 'sakura', name: '樱语', en: 'Sakura', mood: '恬静 · 花影', scene: '樱花林', bpm: 66, beats: 48, color: '#f9a8d4',
      voices: [
        { inst: 'pad', vol: 0.7, seq: 'D3+A3+E4+F#4:4 B2+F#3+A3+D4:4 G2+D3+A3+B3:4 A2+E3+G3+B3:4 D3+A3+E4+F#4:4 F#2+C#3+E3+A3:4 G2+D3+F#3+B3:4 A2+E3+A3+C#4:4 B2+F#3+A3+D4:4 G2+D3+A3+B3:4 E2+B2+D3+G3:4 A2+E3+G3+C#4:4' },
        { inst: 'bass', vol: 0.75, seq: 'D2:4 B1:4 G1:4 A1:4 D2:4 F#1:4 G1:4 A1:4 B1:4 G1:4 E1:4 A1:4' },
        { inst: 'koto', vol: 1, seq: 'A4:.5 B4:.5 D5 E5:1.5 D5:.5 | B4:2 A4 F#4 | A4:.5 B4:.5 D5 B4 A4 | E4:3 r | F#5:.5 E5:.5 D5 E5 A5 | F#5:2 E5 C#5 | D5:1.5 B4:.5 A4 F#4 | E4:2 A4:2 | B4:.5 D5:.5 F#5 E5:.5 D5:.5 B4 | D5 B4 A4:2 | G4 B4 D5 E5 | A4:3 r' },
        { inst: 'pluck', vol: 0.35, arp: { pattern: [0, 1, 2, 3, 2, 1, 3, 2], step: 0.5, oct: 12 }, seq: 'D3+A3+E4+F#4:4 B2+F#3+A3+D4:4 G2+D3+A3+B3:4 A2+E3+G3+B3:4 D3+A3+E4+F#4:4 F#2+C#3+E3+A3:4 G2+D3+F#3+B3:4 A2+E3+A3+C#4:4 B2+F#3+A3+D4:4 G2+D3+A3+B3:4 E2+B2+D3+G3:4 A2+E3+G3+C#4:4' },
      ],
    },
    {
      id: 'frost', name: '霜雪', en: 'Frost', mood: '清冷 · 雪原', scene: '雪原', bpm: 66, beats: 48, color: '#bae6fd',
      voices: [
        { inst: 'pad', vol: 0.85, seq: 'E3+B3+D4+G4:4 C3+G3+B3+E4:4 A2+E3+G3+C4:4 B2+F#3+A3+D#4:4 E3+B3+D4+G4:4 G2+D3+F#3+B3:4 C3+G3+B3+D4:4 D3+A3+C4+F#4:4 C3+G3+B3+E4:4 A2+E3+G3+C4:4 B2+F#3+A3+D#4:4 E3+B3+E4+G4:4' },
        { inst: 'bass', vol: 0.75, seq: 'E2:4 C2:4 A1:4 B1:4 E2:4 G1:4 C2:4 D2:4 C2:4 A1:4 B1:4 E2:4' },
        { inst: 'glass', vol: 1, seq: 'B5:2 G5 E5 | G5:1.5 B5:.5 E6:2 | C6:2 B5 G5 | F#5:3 r | E5 G5 B5 E6 | D6:2 B5 F#5 | G5:1.5 B5:.5 D6:2 | C6:2 A5:2 | B5 G5 E5:2 | C6:1.5 B5:.5 G5:2 | F#5 A5 D#6:2 | E6:4' },
        { inst: 'pluck', vol: 0.4, seq: 'r:3 E6 | r:4 | r:2 B6 r | r:4 | r:1 G6 r:2 | r:4 | r:3 D6 | r:4 | r:2 E6 r | r:4 | r:1 F#6 r:2 | r:4' },
      ],
    },
    {
      id: 'tide', name: '潮汐', en: 'Tide', mood: '舒展 · 海浪', scene: '海洋', bpm: 64, beats: 48, color: '#22d3ee',
      voices: [
        { inst: 'pad', vol: 0.8, seq: 'F3+C4+E4+A4:4 G3+B3+D4+A4:4 A3+C4+E4+G4:4 D3+A3+C4+F4:4 Bb2+F3+A3+D4:4 C3+G3+Bb3+E4:4 F3+A3+C4+E4:4 D3+F3+A3+C4:4 Bb2+D3+F3+A3:4 G2+D3+F3+Bb3:4 C3+E3+G3+Bb3:4 F3+C4+E4+G4:4' },
        { inst: 'bass', vol: 0.75, seq: 'F2:4 G2:4 A1:4 D2:4 Bb1:4 C2:4 F2:4 D2:4 Bb1:4 G1:4 C2:4 F2:4' },
        { inst: 'pluck', vol: 0.6, arp: { pattern: [0, 1, 2, 3, 2, 1, 2, 3], step: 0.5, oct: 12 }, seq: 'F3+C4+E4+A4:4 G3+B3+D4+A4:4 A3+C4+E4+G4:4 D3+A3+C4+F4:4 Bb2+F3+A3+D4:4 C3+G3+Bb3+E4:4 F3+A3+C4+E4:4 D3+F3+A3+C4:4 Bb2+D3+F3+A3:4 G2+D3+F3+Bb3:4 C3+E3+G3+Bb3:4 F3+C4+E4+G4:4' },
        { inst: 'flute', vol: 0.85, seq: 'r:4 | r:2 A5 B5 | C6:2 G5 E5 | F5:3 r | D5 F5 A5:2 | G5:2 E5 C5 | A5:3 r | r:2 C6:.5 A5:.5 F5 | D6:2 C6 A5 | Bb5:2 G5 D5 | E5 G5 Bb5 C6 | A5:4' },
      ],
    },
    {
      id: 'dune', name: '沙丘', en: 'Dune', mood: '辽阔 · 热风', scene: '沙漠', bpm: 84, beats: 64, color: '#f59e0b',
      voices: [
        { inst: 'drone', vol: 0.8, seq: 'D2+A2:16 D2+A2:16 G2+D3:8 D2+A2:8 D2+A2:16' },
        { inst: 'bass', vol: 0.7, seq: 'D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | G1:1.5 G1:.5 r D2 | G1:1.5 G1:.5 r D2 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:1.5 D2:.5 r A1 | D2:4' },
        { inst: 'koto', vol: 1, seq: 'D5 Eb5:.5 D5:.5 C5 D5 | F#4 G4 A4:2 | Bb4:.5 A4:.5 G4 F#4 Eb4 | D4:3 r | A4 Bb4:.5 A4:.5 G4 A4 | C5:1.5 Bb4:.5 A4:2 | G4:.5 A4:.5 Bb4 A4 F#4 | G4:2 F#4 Eb4 | G4 Bb4 D5 Eb5 | D5:2 C5 Bb4 | A4 Bb4:.5 C5:.5 D5 Eb5 | F#5:3 r | G5:.5 F#5:.5 Eb5 D5 C5 | Bb4:1.5 A4:.5 G4:2 | F#4 G4:.5 F#4:.5 Eb4 F#4 | D4:4' },
        { inst: 'flute', vol: 0.7, seq: 'r:32 D5:4 Eb5:2 D5:2 C5:4 Bb4:4 A4:4 G4:2 F#4:2 G4:4 D5:4' },
      ],
    },
    {
      id: 'ember', name: '余烬', en: 'Ember', mood: '压抑 · 下界', scene: '下界', bpm: 56, beats: 44, color: '#ef4444',
      voices: [
        { inst: 'drone', vol: 1.6, seq: 'C2+G2:12 Db2+Ab2:8 C2+G2:12 B1+F#2:4 C2+G2:8' },
        { inst: 'pad', vol: 1.3, dark: true, seq: 'C3+Eb3+G3+Bb3:4 C3+Eb3+G3+Bb3:4 Ab2+C3+Eb3+G3:4 Db3+F3+Ab3+C4:4 Db3+F3+Ab3+C4:4 C3+Eb3+G3+Bb3:4 Ab2+C3+Eb3+G3:4 F2+Ab2+C3+Eb3:4 B2+D3+F3+Ab3:4 C3+Eb3+G3+C4:4 C3+Eb3+G3+C4:4' },
        { inst: 'bass', vol: 1.4, seq: 'C2:.5 r:.5 C2:.5 r:2.5 | C2:.5 r:.5 C2:.5 r:2.5 | Ab1:.5 r:.5 Ab1:.5 r:2.5 | Db2:.5 r:.5 Db2:.5 r:2.5 | Db2:.5 r:.5 Db2:.5 r:2.5 | C2:.5 r:.5 C2:.5 r:2.5 | Ab1:.5 r:.5 Ab1:.5 r:2.5 | F1:.5 r:.5 F1:.5 r:2.5 | B1:.5 r:.5 B1:.5 r:2.5 | C2:.5 r:.5 C2:.5 r:2.5 | C2:.5 r:.5 C2:.5 r:2.5' },
        { inst: 'bell', vol: 1.2, seq: 'r:2 G5:2 | Eb5:3 r | r D5 Eb5 C5 | Db5:4 | r:2 F5 Ab5 | G5:3 r | r Eb5 D5 C5 | B4:4 | r:2 D5 F5 | Eb5:2 D5:2 | C5:4' },
      ],
    },
    {
      id: 'void', name: '虚空', en: 'Void', mood: '空灵 · 末地', scene: '末地', bpm: 54, beats: 40, color: '#c084fc',
      voices: [
        { inst: 'drone', vol: 1.4, seq: 'E2+B2:16 C2+G2:8 E2+B2:16' },
        { inst: 'pad', vol: 1.7, dark: true, seq: 'E3+G#3+B3+D#4:4 F#3+A#3+C#4+E4:4 E3+G#3+B3+D#4:4 D3+F#3+A3+C#4:4 C3+E3+G3+B3:4 D3+F#3+A3+C#4:4 E3+G#3+B3+D#4:4 F#3+A#3+C#4+E4:4 G#3+C4+D#4+F#4:4 E3+G#3+B3+E4:4' },
        { inst: 'glass', vol: 2, seq: 'B5:2 D#6:2 | C#6:1.5 A#5:.5 F#5:2 | G#5 B5 D#6 F#6 | E6:3 r | D6:2 B5 G5 | A5:2 C#6:2 | B5 G#5 E5:2 | A#5:2 F#5:2 | C6 D#6 F#6:2 | G#6:4' },
        { inst: 'pluck', vol: 0.8, seq: 'r:3 B6 | r:4 | r:2 F#6 r | r:4 | r:1 E6 r:2 | r:4 | r:3 G#6 | r:4 | r:2 D#6 r | r:4' },
      ],
    },
  ];

  /** 每个场景搭配的主题曲（没有专属主题曲的场景按时间挑选） */
  const SCENE_THEME = { desert: 'dune', snowy: 'frost', ocean: 'tide', cherry: 'sakura', mushroom: 'cavern', darkforest: 'cavern', nether: 'ember', end: 'void' };
  const TIME_TRACKS = { dawn: ['dawn', 'grove'], day: ['grove', 'dawn'], sunset: ['dawn', 'starfall'], night: ['starfall', 'cavern'] };

  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midiOf(n) {
    const m = String(n).match(/^([A-G])([#b]?)(-?\d)$/);
    if (!m) throw new Error(`无法识别的音符：${n}`);
    return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }

  /** 解析一条声部 → [{t, d, notes}] */
  function parseSeq(seq) {
    const out = [];
    let t = 0;
    for (const tok of seq.split(/\s+/)) {
      if (!tok || tok === '|') continue;
      const [body, dur] = tok.split(':');
      const d = dur ? Number(dur) : 1;
      if (body !== 'r') out.push({ t, d, notes: body.split('+').map(midiOf) });
      t += d;
    }
    return { events: out, length: t };
  }

  /** 编译整首曲子：展开琶音，得到每个声部的音符事件 */
  const compiled = new Map();
  function compile(track) {
    if (compiled.has(track.id)) return compiled.get(track.id);
    const voices = track.voices.map((v) => {
      const { events, length } = parseSeq(v.seq);
      if (Math.abs(length - track.beats) > 0.001) console.warn(`[music] ${track.id}/${v.inst} 长度 ${length} ≠ ${track.beats}`);
      let ev = events;
      if (v.arp) {
        ev = [];
        for (const c of events) {
          const n = Math.round(c.d / v.arp.step);
          for (let k = 0; k < n; k++) {
            const note = c.notes[v.arp.pattern[k % v.arp.pattern.length] % c.notes.length] + (v.arp.oct || 0);
            ev.push({ t: c.t + k * v.arp.step, d: v.arp.step * 1.8, notes: [note] });
          }
        }
      }
      return { ...v, events: ev };
    });
    const c = { ...track, voices, seconds: (track.beats * 60) / track.bpm };
    compiled.set(track.id, c);
    return c;
  }

  // ───────────────────────── 合成器 ─────────────────────────
  const freq = (m) => 440 * 2 ** ((m - 69) / 12);

  function envelope(g, when, peak, attack, decayTo, decayTime, end) {
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, decayTo), when + attack + decayTime);
    if (end) g.gain.exponentialRampToValueAtTime(0.0001, end);
  }

  const INST = {
    piano(ctx, out, f, when, dur, vel) {
      const g = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3600, when);
      lp.frequency.exponentialRampToValueAtTime(1100, when + 1.6);
      const len = Math.max(1.6, dur * 1.3 + 1.4);
      envelope(g, when, 0.22 * vel, 0.008, 0.0006, len);
      const parts = [['triangle', 1, 1], ['sine', 2, 0.28], ['sine', 3, 0.07]];
      for (const [type, mul, amp] of parts) {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = type;
        o.frequency.value = f * mul;
        og.gain.value = amp;
        o.connect(og).connect(lp);
        o.start(when);
        o.stop(when + len + 0.1);
      }
      lp.connect(g).connect(out);
    },
    bell(ctx, out, f, when, dur, vel) {
      const len = Math.max(2.6, dur + 2.2);
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const g = ctx.createGain();
      car.type = 'sine';
      mod.type = 'sine';
      car.frequency.value = f;
      mod.frequency.value = f * 3.01;
      modGain.gain.setValueAtTime(f * 2.4, when);
      modGain.gain.exponentialRampToValueAtTime(f * 0.05, when + 1.4);
      mod.connect(modGain).connect(car.frequency);
      envelope(g, when, 0.13 * vel, 0.004, 0.0004, len);
      car.connect(g).connect(out);
      car.start(when); mod.start(when);
      car.stop(when + len + 0.1); mod.stop(when + len + 0.1);
    },
    pluck(ctx, out, f, when, dur, vel) {
      const len = 1.15;
      const g = ctx.createGain();
      envelope(g, when, 0.15 * vel, 0.003, 0.0005, len);
      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = f;
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.type = 'sine';
      o2.frequency.value = f * 4.07;
      g2.gain.setValueAtTime(0.35, when);
      g2.gain.exponentialRampToValueAtTime(0.001, when + 0.12);
      o1.connect(g);
      o2.connect(g2).connect(g);
      g.connect(out);
      for (const o of [o1, o2]) { o.start(when); o.stop(when + len + 0.05); }
    },
    flute(ctx, out, f, when, dur, vel) {
      const end = when + dur * 0.95;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.085 * vel, when + 0.14);
      g.gain.setValueAtTime(0.085 * vel, Math.max(when + 0.15, end - 0.05));
      g.gain.exponentialRampToValueAtTime(0.0001, end + 0.45);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 5.1;
      lg.gain.setValueAtTime(0, when);
      lg.gain.linearRampToValueAtTime(f * 0.005, when + 0.5);
      lfo.connect(lg).connect(o.frequency);
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.type = 'sine';
      o2.frequency.value = f * 2;
      g2.gain.value = 0.12;
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(out);
      for (const x of [o, o2, lfo]) { x.start(when); x.stop(end + 0.5); }
    },
    pad(ctx, out, f, when, dur, vel, opts = {}) {
      const end = when + dur;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.035 * vel, when + 1.4);
      g.gain.setValueAtTime(0.035 * vel, Math.max(when + 1.45, end));
      g.gain.exponentialRampToValueAtTime(0.0001, end + 2.4);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = opts.dark ? 520 : 820;
      lp.Q.value = 0.6;
      for (const [type, mul, detune, amp] of [['sawtooth', 1, -8, 0.5], ['sawtooth', 1, 7, 0.5], ['triangle', 0.5, 0, 0.7]]) {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = type;
        o.frequency.value = f * mul;
        o.detune.value = detune;
        og.gain.value = amp;
        o.connect(og).connect(lp);
        o.start(when);
        o.stop(end + 2.5);
      }
      lp.connect(g).connect(out);
    },
    // 拨弦（古筝 / 乌德琴风格）：起音略高再落回音高，滤波器快速收拢
    koto(ctx, out, f, when, dur, vel) {
      const len = Math.max(1.4, Math.min(3, dur + 1.2));
      const g = ctx.createGain();
      envelope(g, when, 0.13 * vel, 0.003, 0.0004, len);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2.2;
      lp.frequency.setValueAtTime(Math.min(16000, f * 9), when);
      lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.6), when + 0.5);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 1.014, when);
      o.frequency.exponentialRampToValueAtTime(f, when + 0.07);
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.type = 'triangle';
      o2.frequency.value = f * 2;
      g2.gain.value = 0.3;
      o.connect(lp);
      o2.connect(g2).connect(lp);
      lp.connect(g).connect(out);
      for (const x of [o, o2]) { x.start(when); x.stop(when + len + 0.05); }
    },
    // 冰晶 / 玻璃：非整数倍泛音，清脆而悠长
    glass(ctx, out, f, when, dur, vel) {
      const len = Math.max(2.8, dur + 2.4);
      const g = ctx.createGain();
      envelope(g, when, 0.1 * vel, 0.006, 0.0003, len);
      for (const [mul, amp, decay] of [[1, 1, len], [2.76, 0.32, 0.9], [5.4, 0.12, 0.35], [8.93, 0.05, 0.18]]) {
        if (f * mul > ctx.sampleRate * 0.45) continue; // 超出可还原的频率范围
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f * mul;
        og.gain.setValueAtTime(amp, when);
        og.gain.exponentialRampToValueAtTime(0.0001, when + decay);
        o.connect(og).connect(g);
        o.start(when);
        o.stop(when + len + 0.05);
      }
      g.connect(out);
    },
    // 持续低音：缓慢呼吸的滤波器
    drone(ctx, out, f, when, dur, vel) {
      const end = when + dur;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.045 * vel, when + 2);
      g.gain.setValueAtTime(0.045 * vel, Math.max(when + 2.05, end - 0.5));
      g.gain.exponentialRampToValueAtTime(0.0001, end + 2.5);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 3;
      lp.frequency.value = 340;
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 0.12;
      lg.gain.value = 160;
      lfo.connect(lg).connect(lp.frequency);
      const oscs = [lfo];
      for (const [type, detune] of [['sawtooth', -6], ['sawtooth', 5], ['square', 0]]) {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = detune;
        og.gain.value = type === 'square' ? 0.25 : 0.5;
        o.connect(og).connect(lp);
        oscs.push(o);
      }
      lp.connect(g).connect(out);
      for (const x of oscs) { x.start(when); x.stop(end + 2.6); }
    },
    bass(ctx, out, f, when, dur, vel) {
      const end = when + dur;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.16 * vel, when + 0.04);
      g.gain.exponentialRampToValueAtTime(0.09 * vel, when + 1.2);
      g.gain.setValueAtTime(0.09 * vel, Math.max(when + 1.25, end - 0.1));
      g.gain.exponentialRampToValueAtTime(0.0001, end + 0.6);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.type = 'triangle';
      o2.frequency.value = f;
      g2.gain.value = 0.35;
      o.connect(lp);
      o2.connect(g2).connect(lp);
      lp.connect(g).connect(out);
      for (const x of [o, o2]) { x.start(when); x.stop(end + 0.7); }
    },
  };

  function impulse(ctx, seconds = 3.4, decay = 2.6) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
    return buf;
  }

  /** 搭建输出链路：每首曲子的总线 → 干声 + 混响 → 主音量 → 压缩 → 输出 */
  function buildChain(ctx) {
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.42;
    const dry = ctx.createGain();
    dry.gain.value = 0.78;
    const input = ctx.createGain();
    input.connect(dry).connect(master);
    input.connect(verb).connect(wet).connect(master);
    master.connect(comp).connect(ctx.destination);
    return { input, master };
  }

  /** 把一遍完整的曲子排进时间线 */
  function scheduleLoop(ctx, bus, track, start) {
    const spb = 60 / track.bpm;
    for (const v of track.voices) {
      const play = INST[v.inst];
      for (const e of v.events) {
        const when = start + e.t * spb;
        for (const n of e.notes) play(ctx, bus, freq(n), when, e.d * spb, v.vol, v);
      }
    }
    return start + track.seconds;
  }

  // ───────────────────────── 播放器 ─────────────────────────
  const P = { ctx: null, chain: null, session: null, fading: [], pending: null, timer: null, playing: false, track: null, loops: 0, suspendedForGame: false, listeners: new Set() };

  function notify() { for (const fn of P.listeners) fn(); }

  function ensure() {
    if (P.ctx) return;
    P.ctx = new (window.AudioContext || window.webkitAudioContext)();
    P.chain = buildChain(P.ctx);
    setVolume(state.config.music.volume);
  }

  function setVolume(v) {
    if (!P.chain) return;
    P.chain.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * 0.9, P.ctx.currentTime, 0.08);
  }

  const byId = (id) => TRACKS.find((t) => t.id === id);
  const isAuto = (sel) => !sel || sel === 'all' || sel === 'cycle';

  /** 「跟随场景」的播放列表：先放场景主题曲，再放符合当前时间的曲子 */
  function playlist() {
    const sc = A.homeScene && A.homeScene();
    const info = sc && sc.sceneId ? sc.info() : null;
    const period = info && TIME_TRACKS[info.period] ? info.period : A.scenePeriod('auto');
    const theme = info ? SCENE_THEME[info.scene] : null;
    if (info && (info.scene === 'nether' || info.scene === 'end')) return [theme, 'cavern'];
    return [...new Set([theme, ...TIME_TRACKS[period]].filter(Boolean))];
  }

  function pickNext() {
    const sel = state.config.music.track;
    if (!isAuto(sel)) return byId(sel) || TRACKS[0];
    const list = sel === 'cycle' ? TRACKS.map((t) => t.id) : playlist();
    const i = P.track ? list.indexOf(P.track.id) : -1;
    return byId(list[(i + 1) % list.length]) || TRACKS[0];
  }

  /** 开始播放（打开开关、游戏结束后恢复）时：从当前场景的主题曲开始，而不是接着放列表里的下一首 */
  function pickStart() {
    const sel = state.config.music.track;
    if (!isAuto(sel)) return byId(sel) || TRACKS[0];
    return byId(playlist()[0]) || TRACKS[0];
  }

  /** 跟随场景模式下，场景（或昼夜时段）变化时淡入新场景的主题曲，之后一直单曲循环它 */
  function onScene() {
    const sel = state.config.music.track;
    if (!P.playing || !P.track || !(sel === 'all' || !sel)) return;
    const theme = byId(playlist()[0]) || TRACKS[0];
    if (theme.id !== P.track.id) startSession(theme, 3.5);
  }

  /**
   * 让一首曲子淡出后断开。每首曲子开始时整遍的音符都已经排进音频线程，淡出期间它们还在跑；
   * 1.5.17：快速连续换歌时十几首同时在淡出，音频线程忙不过来会爆音——所以最多只留一首在淡出，更早的直接断开；
   * 手动换歌（quick）淡出得快（约 0.3 秒），场景自动换歌照旧慢慢交叉淡化
   */
  function fadeOut(s, quick) {
    const ctx = P.ctx;
    for (const old of P.fading) { try { old.bus.disconnect(); } catch { /* ignore */ } clearTimeout(old.kill); }
    P.fading = [];
    const g = s.bus.gain;
    const t = ctx.currentTime;
    // 淡入的斜坡可能还没走完：先停在当前值，否则新的淡出和旧的淡入打架
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.setTargetAtTime(0.0001, t, quick ? 0.1 : 0.8);
    s.kill = setTimeout(() => { try { s.bus.disconnect(); } catch { /* ignore */ } P.fading = P.fading.filter((x) => x !== s); }, quick ? 700 : 5000);
    P.fading.push(s);
  }

  function startSession(track, fadeIn = 2.5, quick = false) {
    ensure();
    const ctx = P.ctx;
    const prev = P.session;
    if (prev) fadeOut(prev, quick);
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    bus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + fadeIn);
    bus.connect(P.chain.input);
    const c = compile(track);
    const start = ctx.currentTime + 0.15;
    const end = scheduleLoop(ctx, bus, c, start);
    P.session = { bus, track: c, start, end };
    P.track = c;
    P.loops = 1;
    P.playing = true;
    notify();
    A.emit('music', { playing: true, track: c.id });
  }

  function tick() {
    if (!P.playing || !P.session || !P.ctx) return;
    const s = P.session;
    if (P.ctx.currentTime > s.end - 3) {
      const sel = state.config.music.track;
      // 只有「轮播全部」每首播放两遍后切换；「跟随场景」一直循环当前主题曲，换曲交给 onScene()
      if (sel === 'cycle' && P.loops >= 2) {
        startSession(pickNext(), 3.5);
        return;
      }
      s.end = scheduleLoop(P.ctx, s.bus, s.track, s.end);
      P.loops++;
    }
    notify();
  }

  async function play(trackId, { quick = false } = {}) {
    ensure();
    if (P.ctx.state === 'suspended') await P.ctx.resume().catch(() => {});
    const t = trackId ? TRACKS.find((x) => x.id === trackId) : pickStart();
    startSession(t || TRACKS[0], quick ? 0.6 : 2.5, quick);
    clearInterval(P.timer);
    P.timer = setInterval(tick, 500);
  }

  function stop() {
    P.playing = false;
    clearInterval(P.timer);
    if (P.session && P.ctx) {
      fadeOut(P.session, false);
      P.session = null;
    }
    notify();
    A.emit('music', { playing: false });
  }

  // 点击缓冲（1.5.17）：开关、换歌连点时界面马上变，真正开始播放等手停下来 0.25 秒后再做，只做最后一次
  let enableTimer = 0;
  let switchTimer = 0;
  async function setEnabled(v) {
    markTouched();
    clearTimeout(enableTimer);
    clearTimeout(switchTimer);
    P.pending = null;
    await A.setConfig({ music: { enabled: !!v } });
    if (!v) { stop(); return; }
    enableTimer = setTimeout(() => { if (state.config.music.enabled && !P.playing) play().catch(() => {}); }, 250);
  }

  /** 音乐面板里点了某首歌：马上高亮它，停手 0.28 秒后才真的切过去；点的就是正在放的那首则什么都不做 */
  function requestTrack(id, after) {
    P.pending = id;
    clearTimeout(switchTimer);
    clearTimeout(enableTimer);
    switchTimer = setTimeout(async () => {
      const want = P.pending;
      P.pending = null;
      const sel = state.config.music.track;
      await A.setConfig({ music: { enabled: true, track: isAuto(sel) ? sel : want } });
      if (!(P.playing && P.track && P.track.id === want)) await play(want, { quick: true });
      if (after) after();
    }, 280);
    if (after) after();
  }

  function position() {
    if (!P.session || !P.ctx) return 0;
    const s = P.session;
    const len = s.track.seconds;
    return ((P.ctx.currentTime - s.start) % len + len) % len / len;
  }

  // 游戏运行时自动暂停：任何实例（含测试启动、一键 Debug）在跑，或启动 / 测试任务还在准备文件，都算
  // 下载、安装、建 MC 百科缓存不算（1.5.7：以前建缓存也会暂停）
  function syncWithGames() {
    const m = state.config.music;
    const running = !!A.tasks && A.tasks.gameActive();
    if (running && m.pauseInGame && P.playing) {
      P.suspendedForGame = true;
      stop();
    } else if (!running && P.suspendedForGame) {
      P.suspendedForGame = false;
      if (m.enabled) play();
    }
  }

  // ───────────────────────── 导出 MIDI ─────────────────────────
  const GM = { piano: 0, bell: 14, pluck: 108, flute: 73, pad: 89, bass: 32, koto: 107, glass: 98, drone: 95 };
  function toMidi(track) {
    const c = compile(track);
    const TPB = 480;
    const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
    const str = (s) => [...s].map((ch) => ch.charCodeAt(0));
    const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const chunk = (type, data) => [...str(type), ...u32(data.length), ...data];
    const tempo = Math.round(60000000 / c.bpm);
    const meta = [0, 0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255,
      0, 0xff, 0x58, 0x04, 4, 2, 24, 8, ...[0, 0xff, 0x03, ...vlq(track.en.length), ...str(track.en)], 0, 0xff, 0x2f, 0];
    const tracks = [chunk('MTrk', meta)];
    c.voices.forEach((v, i) => {
      const ch = i >= 9 ? i + 1 : i;
      const evs = [];
      for (const e of v.events) {
        for (const n of e.notes) {
          const vel = Math.round(Math.min(1, v.vol) * 90);
          evs.push({ t: Math.round(e.t * TPB), on: true, n, vel });
          evs.push({ t: Math.round((e.t + Math.min(e.d, track.beats - e.t)) * TPB), on: false, n });
        }
      }
      evs.sort((a, b) => a.t - b.t || (a.on - b.on));
      const data = [0, 0xc0 | ch, GM[v.inst] || 0];
      let last = 0;
      for (const e of evs) {
        data.push(...vlq(e.t - last), (e.on ? 0x90 : 0x80) | ch, e.n, e.on ? e.vel : 0);
        last = e.t;
      }
      data.push(0, 0xff, 0x2f, 0);
      tracks.push(chunk('MTrk', data));
    });
    const head = chunk('MThd', [0, 1, 0, tracks.length, (TPB >> 8) & 255, TPB & 255]);
    return new Uint8Array([...head, ...tracks.flat()]);
  }

  async function exportMidi(id) {
    const t = TRACKS.find((x) => x.id === id) || TRACKS[0];
    const bytes = toMidi(t);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const p = await api('dialog:saveBinary', '导出 MIDI', `Aurora - ${t.en}.mid`, btoa(bin), [{ name: 'MIDI 文件', extensions: ['mid'] }]);
    if (p) A.toast({ level: 'ok', text: `已导出 ${p}` });
  }

  // ───────────────────────── 界面 ─────────────────────────
  // 顶栏胶囊：左边点开播放器面板，右边的小拨钮直接开关音乐；两个是并排的按钮，不嵌套
  const btn = () => $('#btnMusic');
  let eq = null;
  let label = null;
  let main = null;
  let sw = null;

  /** 第一次碰音乐（开关或打开面板）后不再显示呼吸光圈 */
  function markTouched() {
    if (!(state.config.tips || {}).music) A.setConfig({ tips: { music: true } }).catch(() => {});
  }

  function renderButton() {
    const b = btn();
    if (!b) return;
    if (!eq) {
      eq = h('span.eq', h('i'), h('i'), h('i'), h('i'));
      label = h('span.mb-label');
      main = h('button.mb-main', { type: 'button', onclick: () => { markTouched(); panel(); } }, icon('music', 16), label, eq);
      sw = h('button.mb-switch', { type: 'button', role: 'switch', onclick: () => setEnabled(!state.config.music.enabled) }, h('i'));
      A.mount(b, main, sw);
    }
    const on = !!state.config.music.enabled;
    label.textContent = P.playing && P.track ? P.track.name : on ? '音乐' : '音乐 · 关';
    b.classList.toggle('playing', P.playing);
    b.classList.toggle('muted', !on);
    b.classList.toggle('hint', !on && !(state.config.tips || {}).music);
    main.title = P.playing ? `正在播放：${trackLabel(P.track)}` : A.t('music.openPanel');
    sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', A.t(on ? 'music.turnOff' : 'music.turnOn'));
    sw.dataset.tip = A.t(on ? 'music.turnOff' : 'music.turnOn');
  }

  function panel() {
    const m = state.config.music;
    const body = h('div.music-panel');
    const render = () => {
      const cur = P.track;
      A.mount(body,
        h('div.mp-head',
          h('div', h('b', '背景音乐'), h('div.faint', { style: { fontSize: '11.5px' } }, '原创曲目 · 由启动器实时合成')),
          A.toggle(state.config.music.enabled, (v) => setEnabled(v).then(render))),
        h('div', { class: `mp-now ${P.playing ? 'on' : ''}`, style: { '--c': cur ? cur.color : 'var(--accent)' } },
          h('div.mp-disc', icon('music', 18)),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div.mp-title', P.playing && cur ? trackLabel(cur) : '未在播放'),
            h('div.faint', { style: { fontSize: '11.5px' } }, P.playing && cur ? `${cur.mood} · ${cur.bpm} BPM · ${Math.round(cur.seconds)} 秒循环` : P.suspendedForGame ? '游戏运行中，已自动暂停' : '打开开关即可播放'),
            h('div.progress.mini', { style: { marginTop: '8px' } }, h('i.mp-pos', { style: { width: `${position() * 100}%`, transition: 'none' } })))),
        h('div.mp-list', TRACKS.map((t) => h('div', {
          class: `mp-track ${(P.pending ? P.pending === t.id : P.playing && cur && cur.id === t.id) ? 'on' : ''}`,
          onclick: () => requestTrack(t.id, render),
        }, h('span.mp-dot', { style: { background: t.color } }), h('div', { style: { flex: 1 } }, h('div', trackLabel(t)), h('div.faint', { style: { fontSize: '11px' } }, `${t.mood} · ${Math.round(compile(t).seconds)} 秒`)),
        t.scene ? h('span.mp-tag', t.scene) : null,
        h('button.btn.ghost.sm.icon', { 'data-tip': '导出 MIDI', onclick: (e) => { e.stopPropagation(); exportMidi(t.id); } }, icon('save', 14))))),
        h('div.mp-row', h('span.faint', '播放方式'), (() => {
          const sel = state.config.music.track;
          const one = cur ? cur.id : 'dawn';
          return A.seg([{ value: 'all', label: '跟随场景' }, { value: 'cycle', label: '轮播全部' }, { value: one, label: '单曲循环' }], isAuto(sel) ? (sel || 'all') : one, async (v) => { await A.setConfig({ music: { track: v } }); if (v === 'all') onScene(); render(); });
        })()),
        h('div.mp-row', icon('volume', 16), A.range({ min: 0, max: 100, step: 1, value: Math.round(m.volume * 100), onInput: (v) => setVolume(v / 100), onChange: (v) => A.setConfig({ music: { volume: v / 100 } }) })),
        h('label.mp-row', { style: { cursor: 'pointer' } }, A.toggle(state.config.music.pauseInGame, (v) => A.setConfig({ music: { pauseInGame: v } })), h('span', { style: { fontSize: '12.5px' } }, '启动、测试或运行游戏时自动暂停')));
    };
    render();
    const pop = A.popover(btn(), body, { align: 'right', className: 'music-pop', onClose: () => { P.listeners.delete(onTick); } });
    const onTick = () => { const pos = body.querySelector('.mp-pos'); if (pos) pos.style.width = `${position() * 100}%`; };
    P.listeners.add(onTick);
    pop.reposition();
  }

  async function init() {
    const b = btn();
    if (!b || P.inited) return;
    P.inited = true;
    P.listeners.add(renderButton);
    renderButton();
    on('games', syncWithGames);
    on('task', (t) => { if (t.kind === 'cleared' || (A.tasks && A.tasks.isGame(t))) syncWithGames(); });
    on('config', renderButton);
    on('scene', onScene);
    if (state.config.music.enabled) {
      // 稍等界面加载完成后再淡入
      setTimeout(() => { if (state.config.music.enabled) play().catch(() => {}); }, 1200);
    }
  }

  /** 曲名：中文界面「林间 · Grove」；英文界面两边一样，只显示一个（以前是「Grove · Grove」） */
  function trackLabel(x) { return window.I18N && window.I18N.getLang() === 'en' ? x.en : `${x.name} · ${x.en}`; }

  A.music = { trackLabel, init, play, stop, setEnabled, setVolume, TRACKS, compile, toMidi, INST, buildChain, scheduleLoop, state: P };
})();
