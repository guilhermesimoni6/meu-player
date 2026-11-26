/* Sons mecânicos do toca-fitas, gerados na hora (sem arquivos de áudio).
   Só tocam depois de um toque ou clique, como os navegadores exigem. */
(() => {
  'use strict';
  let ctx = null, master = null, on = true, wind = null, hiss = null;
  try { on = localStorage.getItem('sfx') !== 'off'; } catch { /* sem armazenamento */ }

  const audio = () => {
    if (!on) return null;
    if (!ctx) {
      const A = window.AudioContext || window.webkitAudioContext;
      if (!A) return null;
      try { ctx = new A(); } catch { return null; }
      master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };
  const noiseBuf = (c, dur) => {
    const n = Math.max(1, Math.floor(c.sampleRate * dur)), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  };
  function noise(c, { t = 0, dur = 0.02, type = 'highpass', f = 2000, f2, q = 0.7, gain = 0.4 }) {
    const t0 = c.currentTime + t;
    const s = c.createBufferSource(); s.buffer = noiseBuf(c, dur + 0.05);
    const fl = c.createBiquadFilter(); fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f, t0);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(fl); fl.connect(g); g.connect(master);
    s.start(t0); s.stop(t0 + dur + 0.05);
  }
  function tone(c, { t = 0, f = 150, f2, dur = 0.08, gain = 0.4, type = 'sine' }) {
    const t0 = c.currentTime + t;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  const play = (fn) => { const c = audio(); if (c) fn(c); };

  const Sfx = {
    key: () => play((c) => { tone(c, { f: 170, f2: 55, dur: 0.07, gain: 0.55, type: 'triangle' }); noise(c, { dur: 0.018, f: 1500, gain: 0.35 }); }),
    keyUp: () => play((c) => { noise(c, { dur: 0.012, f: 2600, gain: 0.18 }); tone(c, { f: 130, f2: 90, dur: 0.03, gain: 0.14 }); }),
    sw: () => play((c) => { noise(c, { dur: 0.012, f: 2200, gain: 0.3 }); tone(c, { f: 240, f2: 120, dur: 0.05, gain: 0.3, type: 'square' }); }),
    tick: () => play((c) => { tone(c, { f: 1200, f2: 480, dur: 0.028, gain: 0.3, type: 'square' }); noise(c, { dur: 0.014, f: 2600, gain: 0.4 }); }),
    whirr: () => play((c) => noise(c, { dur: 0.55, type: 'bandpass', f: 500, f2: 1900, q: 2.2, gain: 0.18 })),
    // tempos combinados com a animação do deck3d.js: entrada 0,5 s chegando + 0,32 s deslizando + 0,3 s assentando
    tapeIn: () => play((c) => {
      noise(c, { dur: 0.5, type: 'bandpass', f: 1400, f2: 500, q: 1.1, gain: 0.16 });                      // fita no ar
      noise(c, { t: 0.5, dur: 0.32, type: 'bandpass', f: 700, f2: 1100, q: 2.4, gain: 0.14 });             // desliza no compartimento
      noise(c, { t: 0.82, dur: 0.02, f: 1200, gain: 0.5 }); tone(c, { t: 0.82, f: 130, f2: 52, dur: 0.12, gain: 0.6, type: 'triangle' }); // trava
      noise(c, { t: 0.9, dur: 0.012, f: 2600, gain: 0.22 }); tone(c, { t: 0.9, f: 90, f2: 60, dur: 0.05, gain: 0.2, type: 'triangle' });     // batidinha
    }),
    // saída: o tranco da mola, uma pausa e a fita sendo puxada
    tapeOut: () => play((c) => {
      noise(c, { dur: 0.02, f: 1500, gain: 0.5 }); tone(c, { f: 150, f2: 50, dur: 0.12, gain: 0.6, type: 'triangle' });
      tone(c, { t: 0.01, f: 520, f2: 220, dur: 0.1, gain: 0.07, type: 'square' });
      noise(c, { t: 0.26, dur: 0.5, type: 'bandpass', f: 500, f2: 1800, q: 1.3, gain: 0.15 });
    }),
    // som contínuo de fita correndo (avançar ou voltar) enquanto o botão fica apertado
    windStart: (dir) => play((c) => {
      if (wind) return;
      const t = c.currentTime, src = c.createBufferSource(); src.buffer = noiseBuf(c, 1.4); src.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.8;
      const f0 = dir > 0 ? 900 : 1700, f1 = dir > 0 ? 2300 : 2600;
      bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + 2.5);
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.26, t + 0.14);
      const motor = c.createOscillator(); motor.type = 'sawtooth'; motor.frequency.setValueAtTime(dir > 0 ? 110 : 140, t);
      motor.frequency.exponentialRampToValueAtTime(dir > 0 ? 190 : 230, t + 2);
      const mg = c.createGain(); mg.gain.value = 0.05;
      const lfo = c.createOscillator(); lfo.frequency.value = 11; const lg = c.createGain(); lg.gain.value = 260; lfo.connect(lg); lg.connect(bp.frequency);
      src.connect(bp); bp.connect(g); g.connect(master); motor.connect(mg); mg.connect(g);
      src.start(t); motor.start(t); lfo.start(t);
      wind = { g, stop: () => { src.stop(c.currentTime + 0.2); motor.stop(c.currentTime + 0.2); lfo.stop(c.currentTime + 0.2); } };
    }),
    windStop: () => {
      if (!wind || !ctx) { wind = null; return; }
      const w = wind; wind = null; const t = ctx.currentTime;
      w.g.gain.cancelScheduledValues(t); w.g.gain.setValueAtTime(Math.max(0.0001, w.g.gain.value), t); w.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      w.stop();
      noise(ctx, { t: 0.14, dur: 0.012, f: 1800, gain: 0.3 }); tone(ctx, { t: 0.14, f: 130, f2: 70, dur: 0.06, gain: 0.35, type: 'triangle' });
    },
    // chiado de rádio de fundo (a antena recolhida deixa o chiado mais alto)
    hiss: (level) => {
      const c = audio();
      if (!c) { if (hiss) hiss.g.gain.value = 0; return; }
      if (!hiss) {
        if (level < 0.002) return;
        const src = c.createBufferSource(); src.buffer = noiseBuf(c, 2); src.loop = true;
        const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
        const g = ctx.createGain(); g.gain.value = 0; src.connect(hp); hp.connect(g); g.connect(master); src.start();
        hiss = { g };
      }
      hiss.g.gain.setTargetAtTime(on ? Math.max(0, level) : 0, ctx.currentTime, 0.25);
    },
    enabled: () => on,
    setEnabled(v) {
      on = Boolean(v);
      try { localStorage.setItem('sfx', on ? 'on' : 'off'); } catch { /* sem armazenamento */ }
      const b = document.getElementById('btn-sfx');
      if (b) { b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Sons ligados: clique para silenciar' : 'Sons desligados: clique para ligar'; }
      if (on) Sfx.key();
    },
  };
  window.Sfx = Sfx;

  const btn = document.getElementById('btn-sfx');
  if (btn) {
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Sons ligados: clique para silenciar' : 'Sons desligados: clique para ligar';
    btn.onclick = () => Sfx.setEnabled(!on);
  }
})();
