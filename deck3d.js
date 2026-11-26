/* Toca-fitas em 3D de verdade (WebGL / Three.js).
   Lê o estado do player pelos elementos escondidos do app.js e responde aos cliques
   acionando esses mesmos elementos. API para o app.js: window.Deck3D. */
(() => {
  'use strict';
  const boombox = document.getElementById('boombox');
  const T = window.THREE;
  if (!boombox) return;
  if (!T) { document.body.classList.add('no-gl'); return; }

  const $ = (id) => document.getElementById(id);
  let inited = false;
  const api = { facingFront: () => true, rotateFront: () => {} };
  window.Deck3D = api;

  // ---------------------------------------------------------------- acabamentos (cor ou madeira)
  const FINISHES = {
    ameixa:   { color: 0x7c2252, css: '#7c2252', ink: '#e8dcc4', vent: '#240c26' },
    madeira:  { wood: true, css: '#7a4a28', ink: '#f3e2c4', vent: '#24110a' },
    preto:    { color: 0x1d1c24, css: '#1d1c24', ink: '#d9d4e6', vent: '#08070b' },
    creme:    { color: 0xe4d8bf, css: '#e4d8bf', ink: '#4a3524', vent: '#6d5a42' },
    petroleo: { color: 0x1f6f78, css: '#1f6f78', ink: '#e4f6f4', vent: '#0a2c31' },
    vermelho: { color: 0xb3202a, css: '#b3202a', ink: '#ffe9dc', vent: '#3a080c' },
  };
  let curFinish = 'ameixa', finishHook = null;
  try { const s = localStorage.getItem('finish'); if (s && FINISHES[s]) curFinish = s; } catch { /* sem armazenamento */ }
  const finishMenu = $('finish-menu'), finishBtn = $('btn-finish');
  const markFinish = () => finishMenu && finishMenu.querySelectorAll('[data-finish]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.finish === curFinish)));
  api.setFinish = (k) => {
    if (!FINISHES[k]) return;
    curFinish = k;
    try { localStorage.setItem('finish', k); } catch { /* sem armazenamento */ }
    if (finishHook) finishHook(k);
    markFinish();
  };
  if (finishBtn && finishMenu) {
    const close = () => { finishMenu.classList.add('hidden'); finishBtn.setAttribute('aria-expanded', 'false'); };
    finishBtn.onclick = () => { const open = finishMenu.classList.toggle('hidden') === false; finishBtn.setAttribute('aria-expanded', String(open)); };
    finishMenu.querySelectorAll('[data-finish]').forEach((b) => { b.onclick = () => { api.setFinish(b.dataset.finish); close(); }; });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.finish')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    markFinish();
  }

  // ---------------------------------------------------------------- andamento real (ReccoBeats)
  // O Spotify bloqueou os dados de ritmo para este app. O ReccoBeats devolve o BPM e a energia pelo ID da faixa,
  // sem chave. Só o ID público da música é enviado. Resultado guardado no navegador; 0 = sem dados para a faixa.
  let tempoCache = {};
  try { tempoCache = JSON.parse(localStorage.getItem('tempo') || '{}') || {}; } catch { tempoCache = {}; }
  const tempoPending = new Set();
  function fetchTempo(id) {
    if (!id || id in tempoCache || tempoPending.has(id) || !/^[A-Za-z0-9]{22}$/.test(id)) return;
    tempoPending.add(id);
    fetch('https://api.reccobeats.com/v1/audio-features?ids=' + id)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('status ' + r.status))))
      .then((j) => {
        const f = j && j.content && j.content[0];
        tempoCache[id] = f && f.tempo > 0 ? { b: Math.round(f.tempo * 10) / 10, e: typeof f.energy === 'number' ? f.energy : null } : 0;
        const keys = Object.keys(tempoCache); if (keys.length > 1500) keys.slice(0, 300).forEach((k) => delete tempoCache[k]);
        try { localStorage.setItem('tempo', JSON.stringify(tempoCache)); } catch { /* sem armazenamento */ }
      })
      .catch(() => { /* sem rede ou serviço fora do ar: segue com o ritmo simulado e tenta de novo na próxima vez */ })
      .finally(() => tempoPending.delete(id));
  }

  // ---------------------------------------------------------------- modo noite
  const night = { tgt: 0, cur: 0 };
  const nightBtn = $('btn-night');
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  api.setNight = (on, save = true) => {
    night.tgt = on ? 1 : 0;
    document.body.classList.toggle('night', on);
    if (metaTheme) metaTheme.setAttribute('content', on ? '#0c0912' : '#d8d8dc');
    if (nightBtn) { nightBtn.setAttribute('aria-pressed', String(on)); nightBtn.title = on ? 'Modo noite ligado: clique para voltar ao dia' : 'Modo noite: as luzes do aparelho iluminam o corpo'; }
    if (save) { try { localStorage.setItem('night', on ? 'on' : 'off'); } catch { /* sem armazenamento */ } }
    if (api.wake) api.wake();
  };
  { let on = false; try { on = localStorage.getItem('night') === 'on'; } catch { /* sem armazenamento */ } night.cur = on ? 1 : 0; api.setNight(on, false); }
  if (nightBtn) nightBtn.onclick = () => api.setNight(night.tgt === 0);

  const ro = new ResizeObserver(() => {
    if (!inited && boombox.clientWidth > 0) {
      inited = true;
      try { init(); } catch (e) { console.error('Deck3D:', e); document.body.classList.add('no-gl'); }
    } else if (inited && api.resize) api.resize();
  });
  ro.observe(boombox);

  // ---------------------------------------------------------------- medidas (unidades do modelo)
  const W = 62, H = 36, D = 14, R = 2.6, ZF = D / 2, TOP = H / 2, FLOOR = -H / 2 - 1;
  const DOOR_Y = -3.5, KEY_Y = -12.9, DIAL_Y = 11.4;
  const PINK = '#ff3d81', PURPLE = '#7a3dff', CYAN = '#00d2ff';
  const DEG = Math.PI / 180;

  // ---------------------------------------------------------------- utilidades de geometria
  // Caixa de cantos arredondados com normais suaves (como um modelo 3D de verdade)
  function roundedBox(w, h, d, r, seg) {
    const hs = [w / 2, h / 2, d / 2];
    r = Math.min(r, hs[0], hs[1], hs[2]);
    const L = hs.map((hh) => {
      const a = [], ii = hh - r;
      for (let k = 0; k <= seg; k++) a.push(-hh + (r * k) / seg);
      for (let k = 0; k <= seg; k++) a.push(ii + (r * k) / seg);
      return a;
    });
    const P = [], N = [], U = [], I = [];
    let base = 0;
    for (let a = 0; a < 3; a++) {
      for (const s of [1, -1]) {
        const b = (a + 1) % 3, c = (a + 2) % 3, nb = L[b].length, nc = L[c].length;
        for (let i = 0; i < nb; i++) {
          for (let j = 0; j < nc; j++) {
            const p = [0, 0, 0];
            p[a] = s * hs[a]; p[b] = L[b][i]; p[c] = L[c][j];
            const q = p.map((v, k) => Math.max(-(hs[k] - r), Math.min(hs[k] - r, v)));
            const n = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
            const len = Math.hypot(n[0], n[1], n[2]) || 1;
            n[0] /= len; n[1] /= len; n[2] /= len;
            P.push(q[0] + n[0] * r, q[1] + n[1] * r, q[2] + n[2] * r);
            N.push(n[0], n[1], n[2]);
            U.push(p[b] * 0.08 + 0.5, p[c] * 0.08 + 0.5);
          }
        }
        for (let i = 0; i < nb - 1; i++) {
          for (let j = 0; j < nc - 1; j++) {
            const a0 = base + i * nc + j, a1 = base + (i + 1) * nc + j, a2 = a1 + 1, a3 = a0 + 1;
            if (s > 0) I.push(a0, a1, a2, a0, a2, a3); else I.push(a0, a2, a1, a0, a3, a2);
          }
        }
        base += nb * nc;
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    return g;
  }

  function rrShape(w, h, r) {
    const s = new T.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y);
    s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    s.lineTo(x + w, y + h - r);
    s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    s.lineTo(x + r, y + h);
    s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(x, y + r);
    s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    return s;
  }
  // Placa lisa (base em z = 0, frente em z = depth)
  function plateGeo(w, h, r, depth, bevel = 0.18) {
    const g = new T.ExtrudeGeometry(rrShape(w - 2 * bevel, h - 2 * bevel, Math.max(0.05, r - bevel)), {
      depth: Math.max(0.01, depth - 2 * bevel), bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 12,
    });
    g.translate(0, 0, bevel);
    return g;
  }
  // Moldura (placa com vazado)
  function frameGeo(w, h, r, bw, depth, bevel = 0.2) {
    const s = rrShape(w - 2 * bevel, h - 2 * bevel, Math.max(0.05, r - bevel));
    s.holes.push(rrShape(w - 2 * bw + 2 * bevel, h - 2 * bw + 2 * bevel, Math.max(0.05, r - bw)));
    const g = new T.ExtrudeGeometry(s, {
      depth: Math.max(0.01, depth - 2 * bevel), bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 12,
    });
    g.translate(0, 0, bevel);
    return g;
  }

  // ---------------------------------------------------------------- texturas desenhadas em canvas
  function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(canvas, { srgb = true, repeat = false, aniso = 4 } = {}) {
    const t = new T.CanvasTexture(canvas);
    if (srgb) t.colorSpace = T.SRGBColorSpace;
    t.anisotropy = aniso;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; }
    return t;
  }
  const rr2d = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); };
  const ellipsize = (g, text, max) => {
    if (g.measureText(text).width <= max) return text;
    while (text.length > 1 && g.measureText(text + '…').width > max) text = text.slice(0, -1);
    return text + '…';
  };
  const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const parseTime = (t) => { const m = /^(\d+):(\d\d)$/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };

  function init() {
    // ------------------------------------------------------------ renderizador, cena e câmera
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Toca-fitas em 3D. Arraste para girar. Teclas, botões e carretéis respondem ao clique.');
    boombox.prepend(canvas);

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(26, 1.7, 1, 600);
    const FOV = 26 * DEG;
    const target = new T.Vector3(0, 1.6, 0);

    // Ambiente de estúdio (softboxes) para dar reflexos no cromado e brilho no plástico
    {
      const env = new T.Scene();
      const gc = canvasOf(16, 256), gg = gc.getContext('2d');
      const grad = gg.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, '#2a1850'); grad.addColorStop(0.45, '#6a3a86'); grad.addColorStop(0.55, '#c27aa8'); grad.addColorStop(0.62, '#3a1d52'); grad.addColorStop(1, '#0c0616');
      gg.fillStyle = grad; gg.fillRect(0, 0, 16, 256);
      const sky = new T.Mesh(new T.SphereGeometry(60, 32, 16), new T.MeshBasicMaterial({ map: tex(gc), side: T.BackSide }));
      env.add(sky);
      const box = (w, h, x, y, z, col, k) => {
        const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(col).multiplyScalar(k), side: T.DoubleSide }));
        m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
      };
      box(50, 22, 0, 36, 24, '#ffffff', 5);
      box(14, 40, -42, 6, 14, '#ff8fc0', 4);
      box(14, 40, 42, 6, 14, '#8fe8ff', 4);
      box(40, 10, 0, 6, -44, '#ffffff', 3);
      box(30, 6, 0, -8, 40, '#ffe2f0', 1.6);
      const pm = new T.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(env, 0.03).texture;
      pm.dispose();
    }
    scene.environmentIntensity = 1;

    const key = new T.DirectionalLight(0xfff1e6, 2.6);
    key.position.set(-12, 60, 44);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -55; key.shadow.camera.right = 55; key.shadow.camera.top = 55; key.shadow.camera.bottom = -55;
    key.shadow.camera.near = 10; key.shadow.camera.far = 160;
    key.shadow.radius = 7; key.shadow.bias = -0.0006;
    scene.add(key);
    const rimC = new T.DirectionalLight(0x58dcff, 1.5); rimC.position.set(46, 12, -30); scene.add(rimC);
    const rimP = new T.DirectionalLight(0xff5a9c, 1.2); rimP.position.set(-46, 8, -20); scene.add(rimP);
    const hemi = new T.HemisphereLight(0xffd0ea, 0x2a1250, 0.55); scene.add(hemi);
    // luzes do próprio aparelho (só acendem no modo noite): o dial âmbar e os dois medidores
    const dialLight = new T.PointLight(0xffa23a, 0, 0, 2); dialLight.position.set(0, DIAL_Y - 2.5, ZF + 6); scene.add(dialLight);
    const vuLights = [-1, 1].map((sx) => { const l = new T.PointLight(0xffd59a, 0, 0, 2); l.position.set(sx * 19.4, 4.4, ZF + 4); scene.add(l); return l; });
    const lerpN = (a, b, k) => a + (b - a) * k;
    function applyNight(k, pulse) {
      key.intensity = lerpN(2.6, 0.3, k); rimC.intensity = lerpN(1.5, 0.22, k); rimP.intensity = lerpN(1.2, 0.2, k); hemi.intensity = lerpN(0.55, 0.05, k);
      renderer.toneMappingExposure = lerpN(1.15, 1.3, k);
      scene.environmentIntensity = 1 - 0.9 * k;
      scene.traverse((o) => {
        const m = o.material;
        if (m && !Array.isArray(m) && m.envMapIntensity !== undefined && !m.isMeshBasicMaterial) {
          if (m.userData.env0 === undefined) m.userData.env0 = m.envMapIntensity;
          m.envMapIntensity = m.userData.env0 * (1 - 0.9 * k);
        }
      });
      dialLight.intensity = k * 420 * pulse; vuLights.forEach((l) => { l.intensity = k * 150 * pulse; });
    }

    // ------------------------------------------------------------ materiais
    const noiseTex = (() => {
      const c = canvasOf(256, 256), g = c.getContext('2d'), d = g.createImageData(256, 256);
      for (let i = 0; i < d.data.length; i += 4) { const v = 110 + Math.random() * 90; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0);
      const t = tex(c, { srgb: false, repeat: true }); t.repeat.set(1.6, 1.6); return t;
    })();
    const brushed = (base, rep) => {
      const c = canvasOf(512, 512), g = c.getContext('2d');
      g.fillStyle = base; g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 1400; i++) {
        g.strokeStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + Math.random() * 0.06})`;
        g.lineWidth = 1; const y = Math.random() * 512;
        g.beginPath(); g.moveTo(0, y); g.lineTo(512, y + (Math.random() - 0.5) * 2); g.stroke();
      }
      const t = tex(c, { repeat: true }); t.repeat.set(rep, rep); return t;
    };
    const M = {
      body: new T.MeshPhysicalMaterial({ color: 0x7c2252, roughness: 0.46, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.3, bumpMap: noiseTex, bumpScale: 0.35 }),
      chrome: new T.MeshStandardMaterial({ color: 0xe6e3ee, metalness: 1, roughness: 0.16 }),
      steel: new T.MeshStandardMaterial({ color: 0xb9b5c4, metalness: 1, roughness: 0.32 }),
      dark: new T.MeshStandardMaterial({ color: 0x2a2633, metalness: 0.85, roughness: 0.38 }),
      rubber: new T.MeshStandardMaterial({ color: 0x17121d, metalness: 0, roughness: 0.85 }),
      plate: new T.MeshStandardMaterial({ color: 0xffffff, map: brushed('#33203f', 0.05), metalness: 0.75, roughness: 0.42 }),
      cream: new T.MeshPhysicalMaterial({ color: 0xeedfba, roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
      black: new T.MeshStandardMaterial({ color: 0x0b0710, roughness: 0.6, metalness: 0.2 }),
      glass: new T.MeshPhysicalMaterial({ color: 0xc8d8ff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.13, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6, depthWrite: false }),
      smoke: new T.MeshPhysicalMaterial({ color: 0x2c1d52, roughness: 0.32, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    };

    // ------------------------------------------------------------ montagem
    const deck = new T.Group(); scene.add(deck);
    const pickables = [];       // objetos que respondem ao clique ou bloqueiam o raio
    const tag = (obj, act) => { obj.traverse((o) => { if (o.isMesh) { o.userData.act = act; pickables.push(o); } }); };
    const block = (m) => { m.userData.act = null; pickables.push(m); };
    const mesh = (geo, mat, x = 0, y = 0, z = 0, parent = deck) => {
      const m = new T.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m);
      if (mat !== M.glass) { m.castShadow = true; m.receiveShadow = true; }
      return m;
    };

    // Corpo
    const body = mesh(roundedBox(W, H, D, R, 9), M.body); block(body);

    // Alça de cima
    {
      const pts = [[-13.6, TOP - 0.4], [-14, TOP + 2.2], [-12.6, TOP + 4.6], [-9.4, TOP + 5.6], [9.4, TOP + 5.6], [12.6, TOP + 4.6], [14, TOP + 2.2], [13.6, TOP - 0.4]]
        .map(([x, y]) => new T.Vector3(x, y, 0));
      const curve = new T.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
      const tube = mesh(new T.TubeGeometry(curve, 60, 0.95, 14, false), M.steel); block(tube);
      const grip = mesh(new T.CylinderGeometry(1.25, 1.25, 13, 28), M.rubber, 0, TOP + 5.6, 0); grip.rotation.z = Math.PI / 2; block(grip);
      for (const sx of [-1, 1]) {
        const foot = mesh(roundedBox(3.6, 1.2, 3.8, 0.45, 4), M.dark, sx * 13.8, TOP + 0.05, 0); block(foot);
      }
    }

    // Pés de borracha
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const f = mesh(new T.CylinderGeometry(1.6, 1.9, 1.1, 24), M.rubber, sx * 24, -H / 2 - 0.55, sz * 4.2); f.receiveShadow = false;
    }

    // Placa escura do painel de cima
    mesh(plateGeo(58, 11, 1.6, 0.5), M.plate, 0, DIAL_Y, ZF - 0.02);
    // Placa das teclas
    mesh(plateGeo(28.4, 5.2, 1.0, 0.5), M.black, 0, KEY_Y, ZF - 0.02);

    // ---------- Painel de sintonia (vidro âmbar iluminado)
    const dialCanvas = canvasOf(1040, 256);
    const dialTex = tex(dialCanvas, { aniso: 8 });
    const dial = mesh(new T.PlaneGeometry(25, 6.2), new T.MeshBasicMaterial({ map: dialTex, toneMapped: false }), 0, DIAL_Y, ZF + 0.5);
    mesh(frameGeo(26.8, 7.8, 1.0, 0.9, 1.1), M.chrome, 0, DIAL_Y, ZF + 0.28);
    mesh(new T.PlaneGeometry(25, 6.2), M.glass, 0, DIAL_Y, ZF + 1.05);
    dial.castShadow = false;

    // ---------- Botões giratórios
    const knobs = {};
    const tickTex = (() => {
      const c = canvasOf(256, 256), g = c.getContext('2d');
      g.translate(128, 128); g.strokeStyle = '#f0e2c8'; g.lineCap = 'round';
      for (let i = 0; i <= 10; i++) {
        const a = (-135 + 27 * i) * DEG, big = i % 5 === 0;
        g.lineWidth = big ? 6 : 4; const r0 = big ? 100 : 106, r1 = 120;
        g.beginPath(); g.moveTo(Math.sin(a) * r0, -Math.cos(a) * r0); g.lineTo(Math.sin(a) * r1, -Math.cos(a) * r1); g.stroke();
      }
      return tex(c);
    })();
    const capTex = (() => {
      const c = canvasOf(256, 256), g = c.getContext('2d');
      g.fillStyle = '#9d99a8'; g.fillRect(0, 0, 256, 256);
      for (let i = 1; i < 60; i++) { g.strokeStyle = `rgba(${i % 2 ? '255,255,255' : '0,0,0'},.07)`; g.lineWidth = 1; g.beginPath(); g.arc(128, 128, i * 2.1, 0, 7); g.stroke(); }
      const rg = g.createRadialGradient(100, 90, 4, 128, 128, 140); rg.addColorStop(0, 'rgba(255,255,255,.35)'); rg.addColorStop(1, 'rgba(0,0,0,.25)');
      g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
      return tex(c);
    })();
    function makeKnob(name, x, r, h, deco) {
      const g = new T.Group(); g.position.set(x, DIAL_Y, ZF + 0.46);
      // decalque de marcas na placa
      const tk = new T.Mesh(new T.PlaneGeometry((r + 1.2) * 2, (r + 1.2) * 2), new T.MeshBasicMaterial({ map: tickTex, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }));
      tk.position.set(x, DIAL_Y, ZF + 0.485); deck.add(tk);
      // base com sombra
      const rot = new T.Group(); g.add(rot);
      const bodyG = new T.CylinderGeometry(r, r, h, 96, 1, true);
      const pos = bodyG.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), pz = pos.getZ(i), ang = Math.atan2(pz, px);
        const f = 1 - 0.045 * (0.5 + 0.5 * Math.cos(ang * 24));
        pos.setX(i, px * f); pos.setZ(i, pz * f);
      }
      bodyG.computeVertexNormals(); bodyG.rotateX(Math.PI / 2); bodyG.translate(0, 0, h / 2);
      const side = new T.Mesh(bodyG, M.dark); side.castShadow = true; side.receiveShadow = true; rot.add(side);
      const cone = new T.Mesh(new T.CylinderGeometry(r * 0.86, r * 0.98, 0.45, 64).rotateX(Math.PI / 2).translate(0, 0, h + 0.1), M.steel); cone.castShadow = true; rot.add(cone);
      const capM = new T.MeshStandardMaterial({ map: capTex, metalness: 1, roughness: 0.26 });
      const cap = new T.Mesh(new T.CircleGeometry(r * 0.86, 64).translate(0, 0, h + 0.33), capM); rot.add(cap);
      const ind = new T.Mesh(roundedBox(0.34, r * 0.62, 0.2, 0.08, 2), new T.MeshStandardMaterial({ color: 0xff3d81, emissive: 0xff3d81, emissiveIntensity: 0.6, roughness: 0.4 }));
      ind.position.set(0, r * 0.5, h + 0.38); rot.add(ind);
      deck.add(g);
      const k = { name, group: g, rot, v: 0.5, shown: 0.5, deco };
      knobs[name] = k;
      tag(g, { type: 'knob', name });
      return k;
    }
    makeKnob('vol', -24.2, 2.9, 2.2, false);
    makeKnob('bal', -16.9, 2.1, 1.7, true);
    makeKnob('tone', 16.9, 2.1, 1.7, true);
    makeKnob('tune', 24.2, 3.3, 2.4, false);

    // ---------- Alto-falantes
    const grilleTex = (() => {
      const c = canvasOf(512, 512), g = c.getContext('2d');
      g.fillStyle = '#8c88a0'; g.fillRect(0, 0, 512, 512);
      const step = 15;
      for (let y = 0, row = 0; y < 512 + step; y += step * 0.866, row++) {
        for (let x = (row % 2) * step / 2; x < 512 + step; x += step) {
          g.fillStyle = '#06040a'; g.beginPath(); g.arc(x, y, 4.6, 0, 7); g.fill();
          g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(x - 1, y - 1.4, 1.1, 0, 7); g.fill();
        }
      }
      return tex(c, { aniso: 8 });
    })();
    const speakers = [];
    for (const sx of [-1, 1]) {
      const g = new T.Group(); g.position.set(sx * 22.6, -5.2, ZF + 0.02); deck.add(g);
      const SR = 8.0;
      const prof = [[SR, 0], [SR, 0.45], [SR - 0.25, 1.05], [SR - 0.7, 1.4], [SR - 1.15, 1.35], [SR - 1.45, 0.95], [SR - 1.5, 0.2]].map(([x, y]) => new T.Vector2(x, y));
      const ring = new T.Mesh(new T.LatheGeometry(prof, 72).rotateX(Math.PI / 2), M.chrome); ring.castShadow = true; ring.receiveShadow = true; g.add(ring);
      const grille = new T.Mesh(new T.CircleGeometry(SR - 1.4, 72), new T.MeshStandardMaterial({ map: grilleTex, metalness: 0.7, roughness: 0.45 }));
      grille.position.z = 0.3; grille.receiveShadow = true; g.add(grille);
      const dome = new T.Mesh(new T.SphereGeometry(2.7, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), M.dark);
      dome.scale.z = 0.55; dome.position.z = 0.3; dome.castShadow = true; g.add(dome);
      const dring = new T.Mesh(new T.TorusGeometry(2.8, 0.22, 12, 48), M.steel); dring.position.z = 0.34; g.add(dring);
      speakers.push(g);
      block(grille);
    }

    // ---------- Compartimento da fita
    const DOOR_W = 26.4, DOOR_H = 12.8;
    mesh(frameGeo(DOOR_W, DOOR_H, 1.2, 1.0, 1.6), M.chrome, 0, DOOR_Y, ZF - 0.02);
    mesh(new T.PlaneGeometry(DOOR_W - 2, DOOR_H - 2), M.black, 0, DOOR_Y, ZF + 0.08).castShadow = false;
    // brilho de "solte aqui"
    const glowCanvas = canvasOf(256, 160), gg = glowCanvas.getContext('2d');
    gg.shadowColor = CYAN; gg.shadowBlur = 26; gg.strokeStyle = '#bff6ff'; gg.lineWidth = 8; rr2d(gg, 34, 30, 188, 100, 18); gg.stroke(); gg.stroke();
    const glow = new T.Mesh(new T.PlaneGeometry(DOOR_W + 7, DOOR_H + 5), new T.MeshBasicMaterial({ map: tex(glowCanvas), transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    glow.position.set(0, DOOR_Y, ZF + 0.06); deck.add(glow);
    mesh(new T.PlaneGeometry(DOOR_W - 2, DOOR_H - 2), M.glass, 0, DOOR_Y, ZF + 1.72);

    // ---------- Fita (cassete)
    const CW = 17.2, CH = 10.6, CT = 1.0;
    const tape = new T.Group(); deck.add(tape);
    const TAPE_Z = ZF + 1.0;
    tape.position.set(0, DOOR_Y, TAPE_Z);
    mesh(roundedBox(CW, CH, CT, 0.55, 4), M.smoke, 0, 0, 0, tape);
    const labelCanvas = canvasOf(640, 248), labelTex = tex(labelCanvas, { aniso: 8 });
    const labelMat = new T.MeshStandardMaterial({ map: labelTex, roughness: 0.6 });
    const label = mesh(new T.PlaneGeometry(14.4, 5.58), labelMat, 0, 2.35, CT / 2 + 0.012, tape); label.castShadow = false;
    // desgaste: riscos, poeira e arranhões numa película por cima da fita; some quando a fita é nova
    const wearCanvas = canvasOf(512, 320), wearTex = tex(wearCanvas);
    const wearMat = new T.MeshBasicMaterial({ map: wearTex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    const wearMesh = new T.Mesh(new T.PlaneGeometry(CW, CH), wearMat); wearMesh.position.set(0, 0, CT / 2 + 0.05); wearMesh.renderOrder = 1; wearMesh.visible = false; tape.add(wearMesh);
    let wearSeed = null;
    function paintWear(seed) {
      const g = wearCanvas.getContext('2d'); g.clearRect(0, 0, 512, 320);
      let s = 2166136261; for (let i = 0; i < seed.length; i++) s = Math.imul(s ^ seed.charCodeAt(i), 16777619); s = (s >>> 0) || 1;
      const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
      g.lineCap = 'round';
      for (let i = 0; i < 52; i++) {                       // riscos finos
        const x = rnd() * 512, y = rnd() * 320, len = 18 + rnd() * 120, a = rnd() < 0.55 ? (rnd() - 0.5) * 0.6 : rnd() * Math.PI;
        g.strokeStyle = `rgba(255,255,255,${0.16 + rnd() * 0.42})`; g.lineWidth = 0.7 + rnd() * 1.1;
        g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 8, y + Math.sin(a) * len * 0.5 + (rnd() - 0.5) * 8, x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
      }
      for (let i = 0; i < 190; i++) {                      // poeira
        g.fillStyle = `rgba(${220 + (rnd() * 30 | 0)},${215 + (rnd() * 30 | 0)},205,${0.12 + rnd() * 0.4})`;
        g.beginPath(); g.arc(rnd() * 512, rnd() * 320, 0.5 + rnd() * 1.5, 0, 7); g.fill();
      }
      for (let i = 0; i < 4; i++) {                        // marcas de dedo, bem suaves
        const x = rnd() * 512, y = rnd() * 320, rg = g.createRadialGradient(x, y, 2, x, y, 40 + rnd() * 30);
        rg.addColorStop(0, 'rgba(255,255,255,.09)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(x - 80, y - 80, 160, 160);
      }
      for (const [cx, cy] of [[0, 0], [512, 0], [0, 320], [512, 320]]) {   // cantos esbranquiçados
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, 70); rg.addColorStop(0, 'rgba(255,255,255,.3)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(cx - 70, cy - 70, 140, 140);
      }
      wearTex.needsUpdate = true;
    }
    const paper = new T.Color(0xffffff), aged = new T.Color(0xe6d6aa);
    function applyWear(w, seed) {
      if (seed !== wearSeed) { wearSeed = seed; paintWear(seed || 'novo'); }
      wearMat.opacity = Math.min(1, w * 1.15); wearMesh.visible = w > 0.01;
      M.smoke.clearcoat = 0.8 - 0.6 * w; M.smoke.roughness = 0.32 + 0.3 * w;
      labelMat.color.copy(paper).lerp(aged, w * 0.85);
    }
    // janela com os carretéis
    const winShape = rrShape(12.6, 3.8, 1.8);
    mesh(new T.ShapeGeometry(winShape, 16), M.black, 0, -2.2, CT / 2 + 0.014, tape).castShadow = false;
    const baseShape = new T.Shape(); baseShape.moveTo(-6.8, 0); baseShape.lineTo(6.8, 0); baseShape.lineTo(5.6, -1.9); baseShape.lineTo(-5.6, -1.9); baseShape.closePath();
    mesh(new T.ShapeGeometry(baseShape), new T.MeshStandardMaterial({ color: 0x120a24, roughness: 0.5 }), 0, -3.35, CT / 2 + 0.014, tape).castShadow = false;
    for (const sx of [-1, 1]) mesh(new T.CircleGeometry(0.32, 20), M.black, sx * 4.6, -4.5, CT / 2 + 0.02, tape).castShadow = false;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) mesh(new T.CylinderGeometry(0.34, 0.34, 0.14, 16).rotateX(Math.PI / 2), M.steel, sx * 8.0, sy * 4.6, CT / 2 + 0.05, tape);
    const spoolTex = (() => {
      const c = canvasOf(128, 128), g = c.getContext('2d');
      g.fillStyle = '#3b2312'; g.fillRect(0, 0, 128, 128);
      // camadas de fita enrolada: dezenas de voltas finas, cada uma com um tom um pouco diferente
      let rs = 7; const rn = () => (rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296;
      for (let r = 63; r > 16; r -= 0.9) {
        const l = 17 + rn() * 9 + (r % 2 ? 2 : 0);
        g.strokeStyle = `hsl(${22 + rn() * 6}, ${36 + rn() * 10}%, ${l}%)`; g.lineWidth = 1.1; g.beginPath(); g.arc(64, 64, r, 0, 7); g.stroke();
      }
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 2; g.beginPath(); g.arc(64, 64, 62, 0, 7); g.stroke();   // borda da última volta
      const rg = g.createRadialGradient(44, 40, 4, 64, 64, 70); rg.addColorStop(0, 'rgba(255,220,170,.35)'); rg.addColorStop(1, 'rgba(0,0,0,.2)'); g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
      return tex(c);
    })();
    const hubTex = (() => {
      const c = canvasOf(128, 128), g = c.getContext('2d');
      g.clearRect(0, 0, 128, 128);
      g.fillStyle = '#f3eeff'; g.beginPath(); g.arc(64, 64, 62, 0, 7); g.fill();
      g.fillStyle = '#0b0618'; g.beginPath(); g.arc(64, 64, 40, 0, 7); g.fill();
      g.fillStyle = '#f3eeff';
      for (let i = 0; i < 6; i++) { g.save(); g.translate(64, 64); g.rotate(i * Math.PI / 3); g.fillRect(-5, -42, 10, 18); g.restore(); }
      g.fillStyle = '#0b0618'; g.beginPath(); g.arc(64, 64, 15, 0, 7); g.fill();
      return tex(c);
    })();
    const reels = [];
    for (const sx of [-1, 1]) {
      const rg = new T.Group(); rg.position.set(sx * 4.4, -2.2, CT / 2 + 0.02); tape.add(rg);
      const spool = new T.Mesh(new T.CircleGeometry(1, 40), new T.MeshStandardMaterial({ map: spoolTex, roughness: 0.7 })); rg.add(spool);
      const hubG = new T.Group(); hubG.position.z = 0.02; rg.add(hubG);
      const hub = new T.Mesh(new T.CircleGeometry(1.02, 40), new T.MeshStandardMaterial({ map: hubTex, transparent: true, roughness: 0.5 })); hubG.add(hub);
      reels.push({ spool, hub: hubG, r: 1.4, side: sx });
      tag(hubG, { type: 'reel', id: sx < 0 ? 'reel-l' : 'reel-r' });
      tag(spool, { type: 'reel', id: sx < 0 ? 'reel-l' : 'reel-r' });
    }
    tape.visible = false;

    // ---------- Fita de verdade: sai dos rolos, passa pelos guias e pelo cabeçote
    const TZ = CT / 2 + 0.09, GX = 6.4, GY = -4.4, HEAD_X = 0, RIB_N = 64;
    const ribPos = new Float32Array(RIB_N * 6), ribNor = new Float32Array(RIB_N * 6);
    for (let i = 0; i < RIB_N * 2; i++) ribNor[i * 3 + 2] = 1;
    const ribGeo = new T.BufferGeometry();
    ribGeo.setAttribute('position', new T.BufferAttribute(ribPos, 3));
    ribGeo.setAttribute('normal', new T.BufferAttribute(ribNor, 3));
    const ribIdx = []; for (let i = 0; i < RIB_N - 1; i++) { const a = i * 2; ribIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    ribGeo.setIndex(ribIdx);
    const ribbon = new T.Mesh(ribGeo, new T.MeshStandardMaterial({ color: 0x8a5632, emissive: 0x2a1408, roughness: 0.3, metalness: 0.2, side: T.DoubleSide }));
    ribbon.frustumCulled = false; tape.add(ribbon);
    for (const sx of [-1, 1]) {
      const post = mesh(new T.CylinderGeometry(0.27, 0.27, 0.55, 16).rotateX(Math.PI / 2), M.steel, sx * GX, GY, CT / 2 + 0.27, tape); post.castShadow = false;
    }
    // ponto de tangência inferior entre um rolo e um guia
    const tangent = (cx, cy, r, px, py) => {
      const th = Math.atan2(py - cy, px - cx), b = Math.acos(Math.min(1, r / Math.hypot(px - cx, py - cy)));
      const a = (cy + r * Math.sin(th + b)) < (cy + r * Math.sin(th - b)) ? th + b : th - b;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    const ribPts = new Array(7).fill(0).map(() => [0, 0]), ribLen = new Float32Array(7);
    let ribPhase = 0;
    function updateRibbon(bump, flutter, dtp) {
      ribPhase += dtp;
      const rl = reels[0].r, rr = reels[1].r;
      ribPts[0] = tangent(-4.4, -2.2, rl, -GX, GY);
      ribPts[1] = [-GX, GY]; ribPts[2] = [HEAD_X - 1.3, GY]; ribPts[3] = [HEAD_X, GY + bump]; ribPts[4] = [HEAD_X + 1.3, GY]; ribPts[5] = [GX, GY];
      ribPts[6] = tangent(4.4, -2.2, rr, GX, GY);
      let total = 0; ribLen[0] = 0;
      for (let i = 1; i < 7; i++) { total += Math.hypot(ribPts[i][0] - ribPts[i - 1][0], ribPts[i][1] - ribPts[i - 1][1]); ribLen[i] = total; }
      let seg = 0;
      for (let i = 0; i < RIB_N; i++) {
        const s = (i / (RIB_N - 1)) * total;
        while (seg < 5 && s > ribLen[seg + 1]) seg++;
        const a = ribPts[seg], b = ribPts[seg + 1], sl = ribLen[seg + 1] - ribLen[seg] || 1, u = (s - ribLen[seg]) / sl;
        let dx = b[0] - a[0], dy = b[1] - a[1]; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        const nx = -dy, ny = dx, env = Math.sin(Math.PI * (s / total));
        const off = flutter * env * Math.sin(s * 2.3 - ribPhase) + flutter * 0.5 * env * Math.sin(s * 5.1 + ribPhase * 1.7);
        const x = a[0] + (b[0] - a[0]) * u + nx * off, y = a[1] + (b[1] - a[1]) * u + ny * off, hw = 0.09;
        ribPos.set([x + nx * hw, y + ny * hw, TZ, x - nx * hw, y - ny * hw, TZ], i * 6);
      }
      ribGeo.attributes.position.needsUpdate = true;
    }
    updateRibbon(0, 0, 0);

    // ---------- Mecanismo: cabeçote, capstan e rolete de borracha (ficam no compartimento)
    const mech = new T.Group(); mech.position.set(0, DOOR_Y, ZF + 0.08); deck.add(mech);
    const CAP_X = 2.38, REST = { hx: 0, hy: -5.25, rx: 4.55, ry: -5.0 }, ENG = { hx: 0, hy: -4.5, rx: 3.4, ry: GY };
    const capstan = new T.Group(); capstan.position.set(CAP_X, GY, 0); mech.add(capstan);
    capstan.add(Object.assign(new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 1.46, 32).rotateX(Math.PI / 2).translate(0, 0, 0.73), M.chrome), { castShadow: false }));
    { const mk = new T.Mesh(new T.BoxGeometry(0.09, 0.3, 0.02), M.black); mk.position.set(0, 0.2, 1.465); capstan.add(mk); }
    const roller = new T.Group(); roller.position.set(REST.rx, REST.ry, 0); mech.add(roller);
    roller.add(Object.assign(new T.Mesh(new T.CylinderGeometry(0.6, 0.6, 1.1, 40).rotateX(Math.PI / 2).translate(0, 0, 1.07), M.rubber), { castShadow: false }));
    roller.add(Object.assign(new T.Mesh(new T.CircleGeometry(0.3, 24).translate(0, 0, 1.63), M.steel)));
    { const mk = new T.Mesh(new T.BoxGeometry(0.08, 0.22, 0.02), M.black); mk.position.set(0, 0.14, 1.635); roller.add(mk); }
    const head = new T.Group(); head.position.set(REST.hx, REST.hy, 0); mech.add(head);
    head.add(Object.assign(new T.Mesh(roundedBox(2.3, 0.9, 1.46, 0.22, 3).translate(0, 0, 0.73), M.steel), { castShadow: false }));
    { const gap = new T.Mesh(new T.BoxGeometry(1.0, 0.1, 0.03), M.black); gap.position.set(0, 0.18, 1.475); head.add(gap);
      for (const sx of [-1, 1]) { const sc = new T.Mesh(new T.CylinderGeometry(0.17, 0.17, 0.05, 16).rotateX(Math.PI / 2), M.dark); sc.position.set(sx * 0.82, -0.12, 1.47); head.add(sc); } }
    const mechSt = { eng: 0, capA: 0 };

    // ---------- Chaves de aleatório e repetir
    const switches = {};
    for (const [id, x] of [['btn-shuffle', -7.2], ['btn-repeat', 7.2]]) {
      const g = new T.Group(); g.position.set(x, 4.35, ZF - 0.02); deck.add(g);
      const b = new T.Mesh(roundedBox(4.8, 1.7, 1.5, 0.55, 4), M.dark); b.position.z = 0.1; b.castShadow = true; g.add(b);
      const ledMat = new T.MeshStandardMaterial({ color: 0x2a1a30, emissive: 0x000000, roughness: 0.3 });
      const led = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.2, 20).rotateX(Math.PI / 2), ledMat); led.position.set(0, 0, 0.9); g.add(led);
      switches[id] = { g, ledMat, press: 0 };
      tag(g, { type: 'switch', id });
    }

    // ---------- Medidores de nível
    // Medidores de nível (VU) de ponteiro, um por canal, com mola e amortecimento
    const VU_W = 9.6, VU_H = 2.7, VU_Y = 4.4, VU_PIV = -2.4, VU_SWEEP = 40 * DEG;
    const vuFace = (() => {
      const PX = 1024 / VU_W, c = canvasOf(1024, Math.round(VU_H * PX)), g = c.getContext('2d');
      const px = 512, py = (VU_H / 2 - VU_PIV) * PX;
      const bg = g.createLinearGradient(0, 0, 0, c.height); bg.addColorStop(0, '#f8edc9'); bg.addColorStop(1, '#e3c98c');
      g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
      const vg = g.createRadialGradient(px, 60, 40, px, 120, 620); vg.addColorStop(0, 'rgba(255,255,230,.35)'); vg.addColorStop(1, 'rgba(120,70,10,.28)');
      g.fillStyle = vg; g.fillRect(0, 0, c.width, c.height);
      const at = (f, r) => { const a = -VU_SWEEP + 2 * VU_SWEEP * f; return [px + Math.sin(a) * r, py - Math.cos(a) * r]; };
      g.lineCap = 'butt';
      // faixa vermelha (acima de 0 dB)
      g.strokeStyle = '#c4281c'; g.lineWidth = 15; g.beginPath();
      g.arc(px, py, 3.12 * PX, -Math.PI / 2 - VU_SWEEP + 2 * VU_SWEEP * 0.76, -Math.PI / 2 + VU_SWEEP); g.stroke();
      g.strokeStyle = '#2a1608'; g.lineWidth = 4; g.beginPath();
      g.arc(px, py, 3.0 * PX, -Math.PI / 2 - VU_SWEEP, -Math.PI / 2 + VU_SWEEP); g.stroke();
      for (let i = 0; i <= 40; i++) {
        const f = i / 40, big = i % 4 === 0, a = at(f, 3.0 * PX), b = at(f, (big ? 3.3 : 3.15) * PX);
        g.strokeStyle = f >= 0.76 ? '#b01e14' : '#2a1608'; g.lineWidth = big ? 5 : 3;
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
      g.fillStyle = '#2a1608'; g.font = 'bold 38px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      [['20', 0], ['10', 0.22], ['7', 0.38], ['5', 0.5], ['3', 0.62], ['0', 0.76], ['+3', 1]].forEach(([t, f]) => {
        const p = at(f, 2.62 * PX); g.fillStyle = f >= 0.76 ? '#b01e14' : '#2a1608'; g.fillText(t, p[0], p[1] + 8);
      });
      g.fillStyle = '#2a1608'; g.font = 'bold 66px Georgia, serif'; g.fillText('VU', px, 168);
      g.fillStyle = '#16100a'; g.fillRect(0, c.height - 0.42 * PX, c.width, 0.42 * PX);
      return tex(c, { aniso: 8 });
    })();
    const vu = {};
    const needleMat = new T.MeshBasicMaterial({ color: 0x9d1b12, toneMapped: false });
    for (const ch of ['L', 'R']) {
      const cx = (ch === 'L' ? -1 : 1) * 19.4;
      mesh(plateGeo(VU_W + 0.7, VU_H + 0.4, 0.5, 0.4, 0.1), M.black, cx, VU_Y, ZF - 0.02);
      const face = new T.Mesh(new T.PlaneGeometry(VU_W, VU_H), new T.MeshBasicMaterial({ map: vuFace, toneMapped: false })); face.position.set(cx, VU_Y, ZF + 0.42); deck.add(face);
      const piv = new T.Group(); piv.position.set(cx, VU_Y + VU_PIV, ZF + 0.5); deck.add(piv);
      const needle = new T.Mesh(new T.BoxGeometry(0.075, 2.05, 0.03), needleMat); needle.position.y = 1.5 + 1.025; piv.add(needle);
      const skirt = new T.Mesh(new T.PlaneGeometry(VU_W, 0.42), M.black); skirt.position.set(cx, VU_Y - VU_H / 2 + 0.21, ZF + 0.58); deck.add(skirt);
      const gl = new T.Mesh(new T.PlaneGeometry(VU_W + 0.7, VU_H + 0.4), M.glass); gl.position.set(cx, VU_Y, ZF + 0.72); deck.add(gl);
      vu[ch] = { piv, x: 0, v: 0, tgt: 0, shown: 99 };
    }



    // ---------- Antena telescópica: puxar para cima estica, arrastar de lado inclina
    const ANT_X = 25.5, ANT_Z = -3.2, SEG = 3.6, STEP = 2.0;
    const ant = new T.Group(); ant.position.set(ANT_X, TOP, ANT_Z); deck.add(ant);
    const antSt = { e: 0.45, tilt: 0.3, w: 0, v: 0, hiss: -1 };
    try { const a = JSON.parse(localStorage.getItem('antenna') || 'null'); if (a) { antSt.e = Math.max(0, Math.min(1, a.e)); antSt.tilt = Math.max(-0.9, Math.min(0.9, a.tilt)); } } catch { /* sem armazenamento */ }
    const antPivot = new T.Group(); ant.add(antPivot);
    mesh(new T.CylinderGeometry(1.1, 1.4, 0.9, 28), M.dark, ANT_X, TOP + 0.35, ANT_Z);
    mesh(new T.SphereGeometry(0.75, 20, 14), M.steel, 0, 0.35, 0, ant);
    const antSegs = [0.36, 0.3, 0.24, 0.18].map((r, i) => {
      const g = new T.Mesh(new T.CylinderGeometry(r, r, SEG, 16).translate(0, SEG / 2, 0), i === 0 ? M.chrome : M.steel); g.castShadow = true; antPivot.add(g); return g;
    });
    const antTip = new T.Mesh(new T.SphereGeometry(0.34, 16, 12), M.chrome); antPivot.add(antTip);
    const antHit = new T.Mesh(new T.CylinderGeometry(1.3, 1.3, 13, 8).translate(0, 6.5, 0), new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); antPivot.add(antHit);
    tag(antHit, { type: 'antenna' });
    function poseAntenna() {
      antSegs.forEach((g, i) => { g.position.y = i * STEP * antSt.e + (i ? 0.3 : 0.5); });
      antTip.position.y = 3 * STEP * antSt.e + 0.3 + SEG + 0.1;
      antPivot.rotation.z = -(antSt.tilt + antSt.w); antPivot.rotation.x = -0.12;
    }
    poseAntenna();

    // ---------- Teclas (teclado de piano, cor de creme)
    const iconCanvases = {};
    const keyDefs = [['btn-prev', 'prev'], ['btn-next', 'next'], ['btn-eject', 'eject'], ['btn-play', 'play'], ['btn-pause', 'pause'], ['btn-mute', 'mute']];
    const keys = {};
    const KEY_REST = ZF + 0.5 + 1.5, KEY_DOWN = 0.85;
    keyDefs.forEach(([id, icon], i) => {
      const x = (i - 2.5) * 4.5;
      const g = new T.Group(); g.position.set(x, KEY_Y, KEY_REST); deck.add(g);
      const b = new T.Mesh(roundedBox(3.9, 3.3, 3.6, 0.55, 5), M.cream); b.position.z = -1.8; b.castShadow = true; b.receiveShadow = true; g.add(b);
      const ic = canvasOf(128, 128), itex = tex(ic, { aniso: 8 });
      const im = new T.Mesh(new T.PlaneGeometry(2.3, 2.3), new T.MeshBasicMaterial({ map: itex, transparent: true, depthWrite: false, toneMapped: false })); im.position.z = 0.02; g.add(im);
      keys[id] = { g, icon, ic, itex, press: 0, held: false, drawn: '' };
      iconCanvases[id] = ic;
      tag(g, { type: 'key', id });
    });
    function drawIcon(k, color, extra) {
      const key = color + extra;
      if (k.drawn === key) return; k.drawn = key;
      const g = k.ic.getContext('2d'); g.clearRect(0, 0, 128, 128);
      g.fillStyle = g.strokeStyle = color; g.lineJoin = g.lineCap = 'round';
      const tri = (x, y, w, h, dir) => { g.beginPath(); g.moveTo(x + (dir > 0 ? 0 : w), y); g.lineTo(x + (dir > 0 ? w : 0), y + h / 2); g.lineTo(x + (dir > 0 ? 0 : w), y + h); g.closePath(); g.fill(); g.stroke(); };
      g.lineWidth = 8;
      switch (k.icon) {
        case 'play': tri(34, 22, 66, 84, 1); break;
        case 'pause': g.fillRect(30, 24, 24, 80); g.fillRect(74, 24, 24, 80); break;
        case 'prev': tri(14, 30, 50, 68, -1); tri(60, 30, 50, 68, -1); break;
        case 'next': tri(18, 30, 50, 68, 1); tri(64, 30, 50, 68, 1); break;
        case 'eject': g.beginPath(); g.moveTo(64, 20); g.lineTo(112, 74); g.lineTo(16, 74); g.closePath(); g.fill(); g.stroke(); g.fillRect(16, 88, 96, 18); break;
        case 'mute': {
          g.beginPath(); g.moveTo(14, 48); g.lineTo(40, 48); g.lineTo(68, 24); g.lineTo(68, 104); g.lineTo(40, 80); g.lineTo(14, 80); g.closePath(); g.fill(); g.stroke();
          g.lineWidth = 9;
          if (extra === 'x') { g.beginPath(); g.moveTo(82, 50); g.lineTo(116, 78); g.moveTo(116, 50); g.lineTo(82, 78); g.stroke(); }
          else { g.beginPath(); g.arc(70, 64, 22, -0.9, 0.9); g.stroke(); g.beginPath(); g.arc(70, 64, 40, -0.9, 0.9); g.stroke(); }
        } break;
      }
      k.itex.needsUpdate = true;
    }

    // ---------- Madeira (desenhada na hora) e costas/laterais que acompanham o acabamento
    const woodCanvas = (() => {
      const c = canvasOf(1024, 1024), g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, 0, 1024);
      ['#7b4a27', '#8c5731', '#6f4123', '#86532d', '#7b4a27'].forEach((col, i, a) => bg.addColorStop(i / (a.length - 1), col));
      g.fillStyle = bg; g.fillRect(0, 0, 1024, 1024);
      for (let i = 0; i < 340; i++) {
        const y0 = Math.random() * 1024, amp = 2 + Math.random() * 12, k = 1 + Math.floor(Math.random() * 5), ph = Math.random() * 6.28;
        const dark = Math.random() < 0.55;
        g.strokeStyle = dark ? `rgba(38,18,6,${0.05 + Math.random() * 0.16})` : `rgba(205,148,92,${0.04 + Math.random() * 0.12})`;
        g.lineWidth = 0.6 + Math.random() * (dark ? 2.6 : 1.6);
        for (const off of [-1024, 0, 1024]) {
          g.beginPath();
          for (let x = 0; x <= 1024; x += 16) {
            const y = y0 + off + Math.sin((x / 1024) * 6.2832 * k + ph) * amp;
            if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
      for (let i = 0; i < 5; i++) { // faixas mais escuras, como nas tábuas
        const y = Math.random() * 1024, h = 20 + Math.random() * 60;
        const bgrad = g.createLinearGradient(0, y, 0, y + h);
        bgrad.addColorStop(0, 'rgba(30,14,4,0)'); bgrad.addColorStop(0.5, 'rgba(30,14,4,.18)'); bgrad.addColorStop(1, 'rgba(30,14,4,0)');
        g.fillStyle = bgrad; g.fillRect(0, y, 1024, h);
      }
      return c;
    })();
    const woodTex = tex(woodCanvas, { repeat: true, aniso: 8 }); woodTex.repeat.set(0.2, 0.28);
    const woodBump = tex(woodCanvas, { srgb: false, repeat: true }); woodBump.repeat.set(0.2, 0.28);
    const skins = [];
    const fillBase = (g, w, h, f) => { if (f.wood) g.drawImage(woodCanvas, 0, 0, w, h); else { g.fillStyle = f.css; g.fillRect(0, 0, w, h); } };
    {
      const bc = canvasOf(1024, 564), bt = tex(bc, { aniso: 8 });
      skins.push((f) => {
        const g = bc.getContext('2d');
        fillBase(g, 1024, 564, f);
        g.fillStyle = f.vent;
        for (const x0 of [60, 640]) for (let i = 0; i < 9; i++) { rr2d(g, x0, 90 + i * 40, 320, 18, 9); g.fill(); }
        g.fillStyle = '#14081a'; rr2d(g, 392, 330, 240, 170, 14); g.fill();
        g.fillStyle = '#22102b'; rr2d(g, 402, 340, 220, 150, 10); g.fill();
        g.fillStyle = f.ink; g.font = '700 44px "Permanent Marker", "Segoe Print", cursive'; g.textAlign = 'center';
        g.fillText('Meu Player', 512, 100);
        g.font = '700 22px "Space Mono", monospace'; g.fillText('ESTÉREO · CASSETE', 512, 140);
        bt.needsUpdate = true;
      });
      const back = new T.Mesh(new T.PlaneGeometry(W - 2 * R + 1, H - 2 * R + 1), new T.MeshStandardMaterial({ map: bt, roughness: 0.62, metalness: 0, envMapIntensity: 0.55, bumpMap: bt, bumpScale: 0.6 }));
      back.position.z = -ZF - 0.01; back.rotation.y = Math.PI; deck.add(back);
      // laterais com furos e gravação
      for (const sx of [-1, 1]) {
        const sc = canvasOf(512, 1024), st = tex(sc, { aniso: 8 });
        skins.push((f) => {
          const sg = sc.getContext('2d');
          fillBase(sg, 512, 1024, f);
          sg.fillStyle = f.vent; for (let i = 0; i < 12; i++) { rr2d(sg, 150, 250 + i * 34, 212, 16, 8); sg.fill(); }
          sg.fillStyle = f.ink; sg.font = '700 30px "Space Mono", monospace'; sg.textAlign = 'center';
          sg.fillText(sx < 0 ? 'FONES' : 'ESTÉREO', 256, 130);
          st.needsUpdate = true;
        });
        const side = new T.Mesh(new T.PlaneGeometry(D - 2 * R + 1, H - 2 * R + 1), new T.MeshStandardMaterial({ map: st, roughness: 0.62, envMapIntensity: 0.55, bumpMap: st, bumpScale: 0.5 }));
        side.position.x = sx * (W / 2 + 0.01); side.rotation.y = sx * Math.PI / 2; deck.add(side);
        for (const [dz, rr] of [[-1.6, 0.9], [1.6, 0.6]]) {
          const jack = new T.Mesh(new T.CylinderGeometry(rr, rr, 0.8, 24).rotateZ(Math.PI / 2), M.chrome);
          jack.position.set(sx * (W / 2 + 0.3), 3.5, dz); deck.add(jack);
        }
      }
    }
    function applyFinish(key) {
      const f = FINISHES[key] || FINISHES.ameixa;
      if (f.wood) {
        M.body.color.set(0xffffff); M.body.map = woodTex; M.body.bumpMap = woodBump; M.body.bumpScale = 0.5;
        M.body.roughness = 0.5; M.body.clearcoat = 0.75; M.body.clearcoatRoughness = 0.25;
      } else {
        M.body.color.setHex(f.color); M.body.map = null; M.body.bumpMap = noiseTex; M.body.bumpScale = 0.35;
        M.body.roughness = 0.46; M.body.clearcoat = 0.6; M.body.clearcoatRoughness = 0.3;
      }
      M.body.needsUpdate = true;
      skins.forEach((paint) => paint(f));
    }
    finishHook = (k) => { applyFinish(k); dirty = true; st.sig = ''; };
    applyFinish(curFinish);
    api.wake = () => { dirty = true; };
    // ---------- Chão: sombra projetada e sombra de contato
    {
      const floor = new T.Mesh(new T.PlaneGeometry(220, 220), new T.ShadowMaterial({ opacity: 0.42 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR; floor.receiveShadow = true; scene.add(floor);
      const c = canvasOf(256, 256), g = c.getContext('2d');
      const rg = g.createRadialGradient(128, 128, 20, 128, 128, 128); rg.addColorStop(0, 'rgba(0,0,0,.65)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
      const blob = new T.Mesh(new T.PlaneGeometry(W * 1.25, D * 2.6), new T.MeshBasicMaterial({ map: tex(c), transparent: true, depthWrite: false, toneMapped: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = FLOOR + 0.02; scene.add(blob);
    }

    // ------------------------------------------------------------ desenho dos textos (painel e etiqueta)
    const dialG = dialCanvas.getContext('2d');
    function drawDial(s, curText, ratio) {
      const w = 1040, h = 256, g = dialG;
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#ffd488'); gr.addColorStop(0.5, '#ffac40'); gr.addColorStop(1, '#d4730f');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      const rg = g.createRadialGradient(w / 2, h * 0.4, 10, w / 2, h * 0.4, w * 0.55);
      rg.addColorStop(0, 'rgba(255,244,200,.8)'); rg.addColorStop(1, 'rgba(255,244,200,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
      g.fillStyle = '#2a1204'; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
      g.font = '700 46px "Space Mono", ui-monospace, monospace';
      g.fillText(ellipsize(g, s.title, w - 120), w / 2, 78);
      g.font = '400 28px "Space Mono", ui-monospace, monospace'; g.fillStyle = 'rgba(42,18,4,.82)';
      g.fillText(ellipsize(g, s.artist, w - 160), w / 2, 118);
      // régua
      g.strokeStyle = '#2a1204'; g.lineWidth = 3;
      for (let i = 0; i <= 40; i++) {
        const x = 48 + ((w - 96) * i) / 40, big = i % 5 === 0;
        g.beginPath(); g.moveTo(x, 150); g.lineTo(x, big ? 182 : 169); g.stroke();
      }
      g.font = '700 26px "Space Mono", ui-monospace, monospace';
      g.textAlign = 'left'; g.fillStyle = '#2a1204'; g.fillText(curText, 48, 226);
      g.textAlign = 'right'; g.fillText(s.dur, w - 48, 226);
      // agulha
      const nx = 48 + (w - 96) * ratio;
      g.shadowColor = 'rgba(255,40,60,.9)'; g.shadowBlur = 14; g.strokeStyle = '#e0123a'; g.lineWidth = 7;
      g.beginPath(); g.moveTo(nx, 138); g.lineTo(nx, 196); g.stroke(); g.shadowBlur = 0;
      // bordas escuras
      const eg = g.createLinearGradient(0, 0, w, 0);
      eg.addColorStop(0, 'rgba(60,20,0,.55)'); eg.addColorStop(0.08, 'rgba(60,20,0,0)'); eg.addColorStop(0.92, 'rgba(60,20,0,0)'); eg.addColorStop(1, 'rgba(60,20,0,.55)');
      g.fillStyle = eg; g.fillRect(0, 0, w, h);
      dialTex.needsUpdate = true;
    }
    const labelG = labelCanvas.getContext('2d');
    let coverImg = null, coverSrc = '', customImg = null, customSrc = '';
    function wrapText(g, text, x, y, maxW, lh, maxLines) {
      const words = text.split(/\s+/); let line = '', n = 0;
      for (let i = 0; i < words.length; i++) {
        const t = line ? line + ' ' + words[i] : words[i];
        if (g.measureText(t).width > maxW && line) {
          if (++n >= maxLines) { g.fillText(ellipsize(g, line + ' ' + words.slice(i).join(' '), maxW), x, y); return; }
          g.fillText(line, x, y); y += lh; line = words[i];
        } else line = t;
      }
      g.fillText(ellipsize(g, line, maxW), x, y);
    }
    const hexMix = (hex, to, t) => { const a = new T.Color(hex), b = new T.Color(to); return '#' + a.lerp(b, t).getHexString(); };
    // desenha uma imagem preenchendo o retângulo (recorta o excesso, como object-fit: cover)
    function drawCover(g, im, x, y, w, h) {
      const k = Math.max(w / im.width, h / im.height), sw = w / k, sh = h / k;
      try { g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, x, y, w, h); } catch { /* sem imagem */ }
    }
    const artImg = () => customImg || coverImg;
    // canetas: cada fita pode ser escrita com marcador, esferográfica ou lápis (com leve borrão)
    const PENS = {
      marcador: (s) => `400 ${s}px "Permanent Marker", "Segoe Print", cursive`,
      esfero: (s) => `600 ${Math.round(s * 1.28)}px Caveat, "Segoe Print", cursive`,
      lapis: (s) => `400 ${Math.round(s * 1.5)}px "Reenie Beanie", "Segoe Print", cursive`,
    };
    const PEN_INK = { esfero: '#1c3fb0', lapis: '#4b4b55' };
    const penFont = (s) => (PENS[tapeMeta.pen] || PENS.marcador)(s);
    const penCanvas = canvasOf(640, 248);
    function penText(g, size, color, draw) {
      const pen = tapeMeta.pen || 'marcador', tg = penCanvas.getContext('2d');
      tg.setTransform(1, 0, 0, 1, 0, 0); tg.clearRect(0, 0, 640, 248);
      tg.save(); tg.font = penFont(size); tg.textBaseline = 'alphabetic'; tg.textAlign = 'left'; tg.fillStyle = PEN_INK[pen] || color;
      draw(tg); tg.restore();
      if (pen === 'lapis') {           // grafite falhado
        tg.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 900; i++) { tg.fillStyle = `rgba(0,0,0,${0.25 + Math.random() * 0.5})`; tg.fillRect(Math.random() * 640, Math.random() * 248, 1 + Math.random() * 2, 1 + Math.random()); }
        tg.globalCompositeOperation = 'source-over';
      }
      g.save();
      g.globalAlpha = pen === 'lapis' ? 0.2 : 0.3; g.shadowColor = PEN_INK[pen] || color; g.shadowBlur = 5; g.drawImage(penCanvas, 1.4, 1.2);   // borrão
      g.shadowBlur = 0; g.globalAlpha = pen === 'lapis' ? 0.82 : 1; g.drawImage(penCanvas, 0, 0);
      g.restore();
    }
    function placeholderArt(g, ax, ay, as) {
      const lg = g.createLinearGradient(ax, ay, ax + as, ay + as); lg.addColorStop(0, PINK); lg.addColorStop(1, PURPLE);
      g.fillStyle = lg; g.fillRect(ax, ay, as, as);
      g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 7; g.lineJoin = 'round';
      rr2d(g, ax + as * 0.21, ay + as * 0.3, as * 0.58, as * 0.56 - 6, 10); g.stroke();
      g.beginPath(); g.arc(ax + as * 0.39, ay + as * 0.51, as * 0.08, 0, 7); g.arc(ax + as * 0.61, ay + as * 0.51, as * 0.08, 0, 7); g.stroke();
    }
    function drawLabel(name, color, style) {
      const g = labelG, w = 640, h = 248, c1 = color || PINK, im = artImg();
      g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.shadowBlur = 0;
      if (style === 'listras') {
        g.fillStyle = c1; g.fillRect(0, 0, w, h);
        g.fillStyle = hexMix(c1, '#ffffff', 0.35);
        for (let x = -h; x < w; x += 64) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 32, h); g.lineTo(x + 32 + h, 0); g.lineTo(x + h, 0); g.closePath(); g.fill(); }
        g.fillStyle = '#fffdf6'; rr2d(g, 22, 40, w - 44, 168, 16); g.fill();
        g.fillStyle = hexMix(c1, '#000000', 0.45); g.fillRect(22, 40, w - 44, 14);
        if (im) drawCover(g, im, 40, 66, 128, 128); else placeholderArt(g, 40, 66, 128);
        penText(g, 52, '#1a1033', (t) => wrapText(t, name, 190, 112, 410, 58, 3));
      } else if (style === 'minimal') {
        g.fillStyle = '#f7f3ea'; g.fillRect(0, 0, w, h);
        g.fillStyle = c1; g.beginPath(); g.arc(46, 44, 14, 0, 7); g.fill();
        g.strokeStyle = '#1a1033'; g.lineWidth = 2; g.beginPath(); g.moveTo(30, 78); g.lineTo(w - 30, 78); g.stroke();
        g.fillStyle = '#1a1033'; g.font = 'italic 400 54px Georgia, "Times New Roman", serif';
        wrapText(g, name, 34, 134, 380, 58, 2);
        g.save(); g.beginPath(); g.arc(520, 132, 82, 0, 7); g.clip();
        if (im) drawCover(g, im, 438, 50, 164, 164); else placeholderArt(g, 438, 50, 164);
        g.restore(); g.strokeStyle = '#1a1033'; g.lineWidth = 3; g.beginPath(); g.arc(520, 132, 82, 0, 7); g.stroke();
        g.fillStyle = '#f7f3ea'; g.beginPath(); g.arc(520, 132, 11, 0, 7); g.fill();
      } else if (style === 'retro') {
        g.fillStyle = '#ecdcb2'; g.fillRect(0, 0, w, h);
        [color || '#d8642a', hexMix(color || '#d8642a', '#000000', 0.45), '#f2b13a'].forEach((c, i) => { g.fillStyle = c; g.fillRect(0, 150 + i * 14, w, 14); });
        g.fillStyle = '#fffaf0'; g.fillRect(28, 30, 118, 118); g.fillStyle = '#3b2a18'; g.fillRect(34, 36, 106, 90);
        if (im) drawCover(g, im, 34, 36, 106, 90); else placeholderArt(g, 34, 36, 106);
        g.fillStyle = '#3b2a18'; g.font = 'bold 46px "Courier New", monospace';
        wrapText(g, name.toUpperCase(), 170, 78, 440, 52, 2);
        g.font = 'bold 22px "Courier New", monospace'; g.fillStyle = '#7a5a30'; g.fillText('SIDE A  ·  STEREO', 170, 128);
      } else if (style === 'neon') {
        g.fillStyle = '#0d0820'; g.fillRect(0, 0, w, h);
        g.strokeStyle = c1; g.lineWidth = 4; g.shadowColor = c1; g.shadowBlur = 16; rr2d(g, 14, 14, w - 28, h - 28, 20); g.stroke();
        if (im) { g.save(); g.shadowBlur = 0; g.beginPath(); g.rect(36, 52, 150, 150); g.clip(); drawCover(g, im, 36, 52, 150, 150); g.restore(); }
        else { g.shadowBlur = 0; placeholderArt(g, 36, 52, 150); }
        g.shadowColor = c1; g.shadowBlur = 18; g.strokeStyle = c1; g.lineWidth = 4; g.strokeRect(36, 52, 150, 150);
        g.fillStyle = hexMix(c1, '#ffffff', 0.7); g.font = penFont(54);
        wrapText(g, name, 214, 112, 390, 60, 3); g.shadowBlur = 0;
      } else if (style === 'foto' && im) {
        drawCover(g, im, 0, 0, w, h);
        const vg = g.createLinearGradient(0, 40, 0, h); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.78)');
        g.fillStyle = vg; g.fillRect(0, 0, w, h);
        g.fillStyle = c1; g.fillRect(0, 0, w, 10);
        g.fillStyle = '#fff'; g.font = penFont(54); g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 8;
        wrapText(g, name, 28, 180, 584, 58, 2); g.shadowBlur = 0;
      } else drawClassic(name, color);
      labelTex.needsUpdate = true;
    }
    function drawClassic(name, color) {
      const g = labelG, w = 640, h = 248;
      g.fillStyle = '#f3eeff'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(26,16,51,.1)'; g.lineWidth = 2;
      for (let y = 96; y < h; y += 36) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      (color ? [color, hexMix(color, '#000000', 0.4), hexMix(color, '#ffffff', 0.5)] : [PINK, PURPLE, CYAN]).forEach((c, i) => { g.fillStyle = c; g.fillRect(0, i * 11, w, 11); });
      const ax = 26, ay = 56, as = 160;
      g.fillStyle = '#1a1033'; g.fillRect(ax - 5, ay - 5, as + 10, as + 10);
      if (artImg()) drawCover(g, artImg(), ax, ay, as, as); else placeholderArt(g, ax, ay, as);
      penText(g, 56, '#2a1466', (t) => { t.translate(224, 0); t.rotate(-0.025); wrapText(t, name, 0, 110, 396, 62, 3); });
    }
    function loadCustom(src) {
      customSrc = src; customImg = null;
      if (!src) { st.labelDirty = true; dirty = true; return; }
      const im = new Image();
      im.onload = () => { if (customSrc === src) { customImg = im; st.labelDirty = true; dirty = true; } };
      im.src = src;
    }
    function loadCover(src) {
      coverSrc = src; coverImg = null;
      if (!src) return;
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { if (coverSrc === src) { coverImg = im; st.labelDirty = true; dirty = true; } };
      im.src = src;
    }

    // ------------------------------------------------------------ estado lido do player
    const tapeEl = document.querySelector('.tape'), doorEl = document.querySelector('.door');
    const st = { sig: '', labelDirty: true, dialKey: '' };
    var tapeMeta = { key: null, ver: null, style: '', pen: '', img: '', wear: 0 };
    let S = null;
    function readState() {
      const now = $('now');
      const title = $('title').textContent, hasTrack = title !== 'Nada tocando';
      return {
        title, artist: $('artist').textContent, cur: $('t-cur').textContent, dur: $('t-dur').textContent, hasTrack,
        p: parseFloat(now.style.getPropertyValue('--p')) || 0,
        playing: now.dataset.playing === 'true',
        pausedOn: $('btn-pause').dataset.state === 'on',
        vol: Number($('vol').value) / 100, muted: $('btn-mute').classList.contains('is-muted'),
        shuffle: $('btn-shuffle').getAttribute('aria-pressed') === 'true', repeat: $('btn-repeat').dataset.mode || 'off',
        cover: $('cover').getAttribute('src') || '', tapeName: $('tape-name').textContent, tapeColor: $('tape-name').dataset.k || '', tapeKey: $('tape-name').dataset.key || '', tid: $('now').dataset.tid || '', tapeVer: $('tape-name').dataset.v || '',
        empty: tapeEl.classList.contains('empty'), hide: tapeEl.style.opacity === '0',
        drop: doorEl.classList.contains('drop-ready'),
        fastL: $('reel-l').classList.contains('fast'), fastR: $('reel-r').classList.contains('fast'),
        seek: Number($('seek').value) / 1000,
      };
    }

    // animação da fita entrando e saindo (acompanha as classes que o app.js coloca)
    const tapeAnim = { mode: null, t: 0 };
    // Só dispara quando a classe é ADICIONADA de verdade. O app.js mexe nas classes da fita a cada
    // atualização do player; se bastasse a classe estar presente, a animação repetiria sem parar.
    const has = (v, k) => (v || '').split(/\s+/).includes(k);
    const mo = new MutationObserver((list) => {
      const cls = list.filter((m) => m.attributeName === 'class');
      cls.forEach((m, i) => {
        const after = i < cls.length - 1 ? cls[i + 1].oldValue : tapeEl.getAttribute('class');
        if (!has(m.oldValue, 'inserting') && has(after, 'inserting')) { tapeAnim.mode = 'in'; tapeAnim.t = 0; window.Sfx?.tapeIn(); }
        else if (!has(m.oldValue, 'ejecting') && has(after, 'ejecting')) { tapeAnim.mode = 'out'; tapeAnim.t = 0; window.Sfx?.tapeOut(); }
      });
      dirty = true;
    });
    mo.observe(tapeEl, { attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style'] });
    api.tapeAnimating = () => tapeAnim.mode;

    // ------------------------------------------------------------ câmera e giro
    const view = { ry: innerWidth < 760 ? 6 : 18, rx: innerWidth < 760 ? 3 : 8 }; // graus
    const FRONT_RY = view.ry, FRONT_RX = view.rx;
    let dirty = true, interacting = false, spinAnim = 0;
    // A tela 3D cobre a janela inteira (o zoom não é cortado); o toca-fitas é enquadrado na caixa .boombox
    const win = { w: 1, h: 1 }, bx = { cx: 0, cy: 0, hw: 1, hh: 1, left: 0, top: 0 };
    function applyOffset() {
      const r = boombox.getBoundingClientRect();
      bx.cx = r.left + r.width / 2; bx.cy = r.top + r.height / 2; bx.hw = r.width / 2; bx.hh = r.height / 2; bx.left = r.left; bx.top = r.top;
      camera.setViewOffset(win.w, win.h, -(bx.cx - win.w / 2), -(bx.cy - win.h / 2), win.w, win.h);
      camera.updateProjectionMatrix();
    }
    function fit() {
      const bw = boombox.clientWidth, bh = boombox.clientHeight;
      if (!bw || !bh) return;
      const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
      win.w = w; win.h = h;
      const dpr = Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : 2);
      renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
      const tan = Math.tan(FOV / 2);
      camera.aspect = w / h; camera.fov = (2 * Math.atan(tan * h / bh)) / DEG;
      dist = 0;
      camDist = Math.max((W * 1.1 / 2) / (tan * (bw / bh)), (51 / 2) / tan);
      applyOffset();
      dirty = true;
    }
    let camDist = 100, quality = 'high';
    // Afasta a câmera quando a caixa girada ou inclinada passaria da borda do quadro
    const fitPts = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [FLOOR, TOP + 9.8]) fitPts.push(new T.Vector3(sx * (W / 2), y, sz * (D / 2)));
    const tmp = new T.Vector3();
    let dist = 0;
    const zoom = { v: 1, shown: 1 };
    function placeCamera() {
      const p = view.rx * DEG;
      deck.rotation.y = view.ry * DEG; deck.updateMatrixWorld(true);
      const pos = (d) => { camera.position.set(0, target.y + Math.sin(p) * d, Math.cos(p) * d); camera.lookAt(target); camera.updateMatrixWorld(true); };
      let want = camDist;
      for (let i = 0; i < 3; i++) {
        pos(want);
        let m = 0;
        for (const v of fitPts) { tmp.copy(v); deck.localToWorld(tmp); tmp.project(camera); m = Math.max(m, Math.abs((tmp.x + 1) / 2 * win.w - bx.cx) / bx.hw, Math.abs((1 - tmp.y) / 2 * win.h - bx.cy) / bx.hh); }
        if (m > 0.97) want *= m / 0.97; else break;
      }
      if (!dist) dist = want;
      if (Math.abs(want - dist) > 0.05) { dist += (want - dist) * 0.3; dirty = true; } else dist = want;
      if (Math.abs(zoom.v - zoom.shown) > 0.002) { zoom.shown += (zoom.v - zoom.shown) * 0.25; dirty = true; } else zoom.shown = zoom.v;
      pos(dist / zoom.shown);
    }
    api.resize = fit;
    api.facingFront = () => { const n = ((view.ry % 360) + 360) % 360; return (n < 40 || n > 320); };
    function rotateTo(ry, rx, ms = 600) {
      cancelAnimationFrame(spinAnim);
      const a = { ry: view.ry, rx: view.rx }, t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms), k = 1 - Math.pow(1 - t, 3);
        view.ry = a.ry + (ry - a.ry) * k; view.rx = a.rx + (rx - a.rx) * k; dirty = true;
        if (t < 1) spinAnim = requestAnimationFrame(step);
      };
      spinAnim = requestAnimationFrame(step);
    }
    const frontTarget = () => Math.round(view.ry / 360) * 360 + FRONT_RY;
    api.rotateFront = (ms = 500) => rotateTo(frontTarget(), FRONT_RX, ms);

    // ------------------------------------------------------------ interação
    const ray = new T.Raycaster(), ndc = new T.Vector2();
    const visibleChain = (o) => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
    function hitAt(e) {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      for (const h of ray.intersectObjects(pickables, false)) if (visibleChain(h.object)) return h.object.userData.act || null;
      return null;
    }
    const sameAct = (a, b) => a && b && a.type === b.type && (a.id || a.name) === (b.id || b.name);
    const fire = (id) => { const el = $(id); if (el) el.click(); };
    const setVol = (v) => { const el = $('vol'); el.value = Math.round(Math.max(0, Math.min(1, v)) * 100); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const setSeek = (v, end) => {
      const el = $('seek'); el.value = Math.round(Math.max(0, Math.min(1, v)) * 1000);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (end) el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Com zoom, o toca-fitas passa dos limites da caixa .boombox: por isso os gestos são ouvidos na página toda,
    // mas só valem quando começam no fundo (não no cabeçalho, na estante ou em janelas).
    const isStage = (t) => t === document.body || t === document.documentElement || t.id === 'app' || t.id === 'now' || t.id === 'bg' || t.id === 'status' || boombox.contains(t);
    let ctl = null, drag = null, vy = 0, vx = 0, inertiaRaf = 0, tuneDrag = false, scrub = null;
    // Avançar/voltar de verdade: o ponteiro da fita corre cada vez mais rápido e a posição é enviada ao Spotify
    // em saltos (o áudio do Spotify não pode ser acelerado, então a música "pula" como numa fita).
    function startScrub(dir) {
      const dur = parseTime($('t-dur').textContent);
      if (!ctl || !dur || !S || !S.hasTrack) return;
      ctl.scrub = true;
      scrub = { dir, dur, pos: Number($('seek').value) / 1000, t0: performance.now(), sent: 0, iv: 0, reel: $(dir < 0 ? 'reel-l' : 'reel-r') };
      scrub.reel.classList.add('fast'); window.Sfx?.windStart(dir);
      let prev = performance.now();
      scrub.iv = setInterval(() => {
        const n = performance.now(), el = (n - scrub.t0) / 1000, speed = Math.min(90, 28 + el * 14); // segundos de música por segundo
        scrub.pos = Math.max(0, Math.min(0.995, scrub.pos + scrub.dir * speed * ((n - prev) / 1000) / scrub.dur)); prev = n;
        const commit = n - scrub.sent > 520;
        setSeek(scrub.pos, commit);
        if (commit) { scrub.sent = n; setSeek(scrub.pos, false); }
        dirty = true;
      }, 80);
    }
    function stopScrub() {
      if (!scrub) return;
      clearInterval(scrub.iv); scrub.reel.classList.remove('fast');
      setSeek(scrub.pos, true); window.Sfx?.windStop(); scrub = null; dirty = true;
    }
    document.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || !isStage(e.target)) return;
      const act = hitAt(e);
      try { e.target.setPointerCapture(e.pointerId); } catch { /* sem captura */ }
      cancelAnimationFrame(spinAnim); cancelAnimationFrame(inertiaRaf);
      if (act) {
        ctl = { act, x: e.clientX, y: e.clientY, moved: false, v0: act.type === 'knob' ? knobs[act.name].v : 0 };
        if (act.type === 'key') {
          keys[act.id].held = true; window.Sfx?.key();
          // segurar avançar/voltar: a fita corre em vez de trocar de faixa
          if (act.id === 'btn-prev' || act.id === 'btn-next') ctl.holdT = setTimeout(() => startScrub(act.id === 'btn-next' ? 1 : -1), 420);
        }
        if (act.type === 'switch') { switches[act.id].held = true; window.Sfx?.sw(); }
        if (act.type === 'antenna') { ctl.e0 = antSt.e; ctl.t0 = antSt.tilt; ctl.tickAt = antSt.e; }
        if (act.type === 'knob' && act.name === 'tune') tuneDrag = true;
        if (act.type === 'knob') window.Sfx?.tick();
        interacting = true; dirty = true; return;
      }
      drag = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
      vy = vx = 0; interacting = true; document.body.classList.add('deck-grab');
    });
    document.addEventListener('pointermove', (e) => {
      if (ctl) {
        if (ctl.act.type === 'antenna') {
          antSt.e = Math.max(0, Math.min(1, ctl.e0 + (ctl.y - e.clientY) / 150));
          antSt.tilt = Math.max(-0.9, Math.min(0.9, ctl.t0 + (e.clientX - ctl.x) / 220));
          dirty = true;
        }
        if (ctl.act.type === 'knob') {
          const k = knobs[ctl.act.name];
          const d = ((ctl.y - e.clientY) + (e.clientX - ctl.x)) / 170;
          if (Math.abs(d) > 0.004) ctl.moved = true;
          k.v = Math.max(0, Math.min(1, ctl.v0 + d));
          if (Math.abs(k.v - (k.tickAt ?? -1)) > 0.035) { k.tickAt = k.v; window.Sfx?.tick(); }
          if (ctl.act.name === 'vol') setVol(k.v);
          else if (ctl.act.name === 'tune') setSeek(k.v, false);
          dirty = true;
        }
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        vy = dx * 0.45; view.ry += vy;
        if (!drag.touch) { vx = dy * 0.3; view.rx = Math.max(-8, Math.min(65, view.rx + vx)); }
        dirty = true; return;
      }
      if (!isStage(e.target)) { document.body.classList.remove('deck-pointer'); return; }
      if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; document.body.classList.toggle('deck-pointer', Boolean(hitAt(e))); });
    });
    let hoverRaf = 0;
    const inertia = () => {
      if (drag) return;
      view.ry += vy; view.rx = Math.max(-8, Math.min(65, view.rx + vx));
      vy *= 0.94; vx *= 0.9; dirty = true;
      if (Math.abs(vy) > 0.03 || Math.abs(vx) > 0.03) inertiaRaf = requestAnimationFrame(inertia);
    };
    const release = (e, cancel) => {
      if (ctl) {
        const c = ctl; ctl = null; interacting = false;
        clearTimeout(c.holdT);
        if (c.act.type === 'antenna') { try { localStorage.setItem('antenna', JSON.stringify({ e: antSt.e, tilt: antSt.tilt })); } catch { /* sem armazenamento */ } }
        if (c.scrub) stopScrub();
        if (c.act.type === 'key') { keys[c.act.id].held = false; window.Sfx?.keyUp(); }
        if (c.act.type === 'switch') switches[c.act.id].held = false;
        if (!cancel && c.act.type === 'reel') window.Sfx?.whirr();
        if (c.act.type === 'knob' && c.act.name === 'tune') { tuneDrag = false; if (c.moved) setSeek(knobs.tune.v, true); }
        if (!cancel && !c.scrub && c.act.type !== 'knob' && sameAct(c.act, hitAt(e))) fire(c.act.id);
        dirty = true; return;
      }
      if (drag) { drag = null; interacting = false; document.body.classList.remove('deck-grab'); inertiaRaf = requestAnimationFrame(inertia); }
    };
    document.addEventListener('pointerup', (e) => release(e, false));
    document.addEventListener('pointercancel', (e) => release(e, true));
    document.addEventListener('dblclick', (e) => { if (isStage(e.target) && !hitAt(e)) { rotateTo(frontTarget(), FRONT_RX); zoom.v = 1; dirty = true; } });
    document.addEventListener('wheel', (e) => {
      if (!isStage(e.target)) return;
      const act = hitAt(e);
      if (!act || act.type !== 'knob' || knobs[act.name].deco) {
        // roda do mouse (ou pinça no trackpad) em qualquer outro lugar: zoom
        e.preventDefault();
        const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
        zoom.v = Math.max(0.6, Math.min(2.6, zoom.v * f)); dirty = true;
        return;
      }
      e.preventDefault();
      const k = knobs[act.name], v = Math.max(0, Math.min(1, k.v - Math.sign(e.deltaY) * 0.05));
      k.v = v; window.Sfx?.tick();
      if (act.name === 'vol') setVol(v); else if (act.name === 'tune') setSeek(v, true);
      dirty = true;
    }, { passive: false });
    knobs.bal.v = knobs.tone.v = 0.5;
    for (const n of ['bal', 'tone']) { // botões de enfeite giram livremente
      const k = knobs[n]; k.deco = true;
    }
    document.addEventListener('pointermove', (e) => {
      if (ctl && ctl.act.type === 'knob' && knobs[ctl.act.name].deco) { dirty = true; }
    });

    // ------------------------------------------------------------ laço de animação
    const proxyBox = [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()];
    let lastProxy = '';
    function syncDoorProxy() {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
        const v = proxyBox[i].set(sx * DOOR_W / 2, DOOR_Y + sy * DOOR_H / 2, ZF + 1.6);
        deck.localToWorld(v); v.project(camera);
        const px = (v.x + 1) / 2 * win.w - bx.left, py = (1 - v.y) / 2 * win.h - bx.top;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      });
      const sig = [x0, y0, x1, y1].map((n) => Math.round(n)).join(',');
      if (sig === lastProxy) return; lastProxy = sig;
      Object.assign(doorEl.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
    }

    const lerp = (a, b, k) => a + (b - a) * k;
    let tempoNow = null;
    let last = performance.now(), lastRender = 0, slowFrames = 0, sampled = 0, dropGlow = 0, thump = 0, reelAngle = 0, posClock = 0, lastSweep = 0, ribFlut = 0, ribShown = "", trackKey = '', bpm = 110;
    function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (document.hidden || !boombox.clientWidth) return;

      // 1) estado do player
      const s = readState(); S = s;
      const sig = [s.title, s.artist, s.cur, s.dur, s.cover, s.tapeName, s.tapeColor, s.empty, s.hide, s.playing, s.pausedOn, s.vol, s.muted, s.shuffle, s.repeat, s.drop, s.fastL, s.fastR, s.seek.toFixed(3), s.p.toFixed(3)].join('|');
      if (sig !== st.sig) { st.sig = sig; dirty = true; }
      if (s.cover !== coverSrc) loadCover(s.cover);
      // dados da fita colocada: estilo do rótulo, imagem própria e desgaste (guardados no navegador pelo app.js)
      if (s.tapeKey !== tapeMeta.key || s.tapeVer !== tapeMeta.ver) {
        const m = (window.TapeStore && s.tapeKey && window.TapeStore.get(s.tapeKey)) || {};
        tapeMeta = { key: s.tapeKey, ver: s.tapeVer, style: m.style || '', pen: m.pen || '', img: m.img || '', wear: Math.min(1, (m.plays || 0) / 25) };
        if (tapeMeta.img !== customSrc) loadCustom(tapeMeta.img);
        applyWear(tapeMeta.wear, s.tapeKey); st.labelDirty = true; dirty = true;
      }

      // 2) painel e etiqueta
      const tuning = tuneDrag || scrub, tuneV = scrub ? scrub.pos : knobs.tune.v;
      const ratio = tuning ? tuneV : s.p;
      const curText = tuning ? fmtTime(tuneV * parseTime(s.dur)) : s.cur;
      const dialKey = [s.title, s.artist, curText, s.dur, ratio.toFixed(3)].join('|');
      if (dialKey !== st.dialKey) { st.dialKey = dialKey; drawDial(s, curText, ratio); }
      const lk = (s.tapeName !== 'Sem fita' ? s.tapeName : s.title) + '|' + (coverImg ? 1 : 0) + '|' + (customImg ? 1 : 0) + '|' + tapeMeta.style + '|' + tapeMeta.pen + '|' + s.tapeColor;
      if (lk !== st.labelKey || st.labelDirty) { st.labelKey = lk; st.labelDirty = false; drawLabel(s.tapeName !== 'Sem fita' ? s.tapeName : s.title, s.tapeColor, tapeMeta.style); }

      // 3) animações
      let moving = false;
      if (!tuneDrag) {
        knobs.vol.v = s.vol; knobs.tune.v = s.seek;
      }
      for (const k of Object.values(knobs)) {
        const dv = k.v - k.shown;
        if (Math.abs(dv) > 0.0005) { k.shown = lerp(k.shown, k.v, Math.min(1, dt * 22)); moving = true; } else k.shown = k.v;
        k.rot.rotation.z = -(-135 + 270 * k.shown) * DEG;
      }
      for (const [id, k] of Object.entries(keys)) {
        const want = k.held || (id === 'btn-play' && s.playing) || (id === 'btn-pause' && s.pausedOn && s.hasTrack) || (id === 'btn-mute' && s.muted) ? 1 : 0;
        const dp = want - k.press;
        if (Math.abs(dp) > 0.01) { k.press = lerp(k.press, want, Math.min(1, dt * 26)); moving = true; } else k.press = want;
        k.g.position.z = KEY_REST - KEY_DOWN * k.press;
        const col = id === 'btn-play' && s.playing ? '#b0124f' : '#3a2a20';
        drawIcon(k, col, id === 'btn-mute' ? (s.muted ? 'x' : 'v') : '');
      }
      for (const [id, sw] of Object.entries(switches)) {
        const on = id === 'btn-shuffle' ? s.shuffle : s.repeat !== 'off';
        const want = sw.held || on ? 1 : 0;
        if (Math.abs(want - sw.press) > 0.01) { sw.press = lerp(sw.press, want, Math.min(1, dt * 24)); moving = true; } else sw.press = want;
        sw.g.position.z = ZF - 0.02 - 0.28 * sw.press;
        const col = id === 'btn-repeat' && s.repeat === 'track' ? 0xffb14a : 0xff3d81;
        sw.ledMat.color.setHex(on ? col : 0x2a1a30); sw.ledMat.emissive.setHex(on ? col : 0x000000); sw.ledMat.emissiveIntensity = on ? 1.4 : 0;
      }
      // fita: entra e sai do compartimento
      const showTape = !s.empty && !s.hide;
      if (tapeAnim.mode) {
        tapeAnim.t += dt; moving = true;
        // pose = [altura, profundidade, inclinação para trás, giro de lado, escala] (relativas à fita assentada)
        const POSE_FAR = [3.8, 12.5, -0.55, 0.16, 1.14], POSE_NEAR = [0.9, 3.4, -0.12, 0.03, 1.04], POSE_SEAT = [0, 0, 0, 0, 1];
        const mixP = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
        const ts = tapeAnim.t; let pose, done = false;
        if (tapeAnim.mode === 'in') {
          // 1) chega em arco até a frente do compartimento  2) desliza para dentro  3) assenta com uma batidinha
          const D1 = 0.5, D2 = 0.32, D3 = 0.3;
          if (ts < D1) { const u = ts / D1; pose = mixP(POSE_FAR, POSE_NEAR, 1 - Math.pow(1 - u, 3)); }
          else if (ts < D1 + D2) { const u = (ts - D1) / D2; pose = mixP(POSE_NEAR, POSE_SEAT, u * u * (3 - 2 * u)); }
          else { const u = Math.min(1, (ts - D1 - D2) / D3); pose = [0, -0.5 * Math.sin(Math.PI * u) * Math.pow(1 - u, 1.5), 0, 0, 1]; if (u >= 1) done = true; }
        } else {
          // 1) a mola empurra a fita para fora (com um tranco)  2) pausa  3) a fita é puxada para longe
          const D1 = 0.16, D2 = 0.1, D3 = 0.5, POP = [0.4, 2.4, -0.05, 0, 1];
          if (ts < D1) { const u = ts / D1, s = 1.70158, e = 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2); pose = mixP(POSE_SEAT, POP, e); }
          else if (ts < D1 + D2) pose = POP;
          else { const u = Math.min(1, (ts - D1 - D2) / D3); pose = mixP(POP, [3.4, 13, -0.5, -0.15, 1.12], u * u * u); if (u >= 1) done = true; }
        }
        tape.position.set(0, DOOR_Y + pose[0], TAPE_Z + pose[1]);
        tape.rotation.x = pose[2]; tape.rotation.z = pose[3]; tape.scale.setScalar(pose[4]);
        if (done) { tapeAnim.mode = null; tape.position.set(0, DOOR_Y, TAPE_Z); tape.rotation.set(0, 0, 0); tape.scale.setScalar(1); }
      } else if (tape.position.z !== TAPE_Z || tape.scale.x !== 1) { tape.position.set(0, DOOR_Y, TAPE_Z); tape.rotation.set(0, 0, 0); tape.scale.setScalar(1); }
      tape.visible = showTape || tapeAnim.mode === 'out';
      // carretéis: giram ao tocar, e a fita passa de um para o outro
      // relógio suave da faixa (o texto só muda a cada segundo) e andamento próprio de cada música
      const tp = parseTime(s.cur);
      if (!s.playing || tp < Math.floor(posClock) || tp > posClock + 1.3) posClock = tp; else posClock += dt;
      const tkey = s.title + '|' + s.artist;
      if (tkey !== trackKey) { trackKey = tkey; tempoNow = null; let h = 2166136261; for (let i = 0; i < tkey.length; i++) h = Math.imul(h ^ tkey.charCodeAt(i), 16777619); bpm = 78 + ((h >>> 0) % 65); fetchTempo(s.tid); }
      // andamento e energia reais (ReccoBeats), quando existirem para esta faixa
      if (!tempoNow && s.tid && tempoCache[s.tid]) { tempoNow = tempoCache[s.tid]; let b = tempoNow.b; while (b > 170) b /= 2; while (b < 70) b *= 2; bpm = b; }
      const enMul = tempoNow && tempoNow.e != null ? 0.65 + 0.7 * tempoNow.e : 1;
      const beat = posClock * bpm / 60, bf = beat - Math.floor(beat);
      const kick = Math.exp(-7 * bf) * (Math.floor(beat) % 4 === 2 ? 0.8 : 1), hat = Math.exp(-12 * ((beat * 2) % 1));
      const swell = 0.8 + 0.2 * Math.sin(posClock * 0.31) * Math.sin(posClock * 0.113 + 1);
      reels.forEach((r) => {
        const fast = r.side < 0 ? s.fastL : s.fastR;
        // avançando/voltando: os dois rolos correm no mesmo sentido, para o lado oposto ao de tocar quando volta
        const sp = (s.fastL || s.fastR) ? (s.fastL ? -16 : 16) : (s.playing ? 3.7 / r.r : 0);
        if (sp) { r.hub.rotation.z -= sp * dt * (r.side < 0 ? 1 : 1); moving = true; }
        const wantR = r.side < 0 ? 1.05 + (1 - s.p) * 0.7 : 1.05 + s.p * 0.7;
        if (Math.abs(wantR - r.r) > 0.002) { r.r = lerp(r.r, wantR, Math.min(1, dt * 4)); moving = true; }
        r.spool.scale.setScalar(r.r);
      });
      // cabeçote e rolete encostam na fita ao tocar e se afastam ao pausar; a fita balança de leve
      const wantEng = s.playing && !s.fastL && !s.fastR && !tapeAnim.mode ? 1 : 0;
      if (Math.abs(wantEng - mechSt.eng) > 0.002) { mechSt.eng = lerp(mechSt.eng, wantEng, Math.min(1, dt * 7)); moving = true; } else mechSt.eng = wantEng;
      const ge = mechSt.eng * mechSt.eng * (3 - 2 * mechSt.eng);
      head.position.set(lerp(REST.hx, ENG.hx, ge), lerp(REST.hy, ENG.hy, ge), 0);
      roller.position.set(lerp(REST.rx, ENG.rx, ge), lerp(REST.ry, ENG.ry, ge), 0);
      const wind = s.fastL || s.fastR ? 30 : (s.playing ? 12 : 0);
      if (wind) { capstan.rotation.z -= wind * dt; roller.rotation.z += wind * dt * 0.7; moving = true; }
      const flut = s.playing ? 0.022 + (s.fastL || s.fastR ? 0.03 : 0) : 0;
      const ribSig = ge.toFixed(3) + '|' + reels[0].r.toFixed(3) + '|' + reels[1].r.toFixed(3);
      if (tape.visible && (flut || ribFlut || ribSig !== ribShown)) { updateRibbon(0.3 * ge, flut, dt * (wind ? 9 : 0)); ribShown = ribSig; moving = true; }
      ribFlut = flut;
      // alto-falantes pulsam com a música
      if (s.playing) {
        thump = 1; moving = true;
        // amplitude proporcional ao volume: baixo = quase parado, alto = cone bem solto
        const amp = s.muted ? 0 : (0.004 + 0.12 * Math.pow(s.vol, 1.4)) * enMul;
        const z = 1 + kick * amp * swell;
        speakers.forEach((g) => { g.children[2].scale.set(z, z, 0.55 * z); });
      } else if (thump) { thump = 0; speakers.forEach((g) => g.children[2].scale.set(1, 1, 0.55)); dirty = true; }
      // brilho do compartimento ao arrastar uma fita
      const wantGlow = s.drop ? 0.95 : 0;
      if (Math.abs(wantGlow - dropGlow) > 0.01) { dropGlow = lerp(dropGlow, wantGlow, Math.min(1, dt * 14)); glow.material.opacity = dropGlow; moving = true; }
      // modo noite: transição suave e as luzes do aparelho pulsam de leve com a batida
      if (!night.init) { night.init = true; applyNight(night.cur, 1); dirty = true; }
      if (Math.abs(night.tgt - night.cur) > 0.003) { night.cur = lerp(night.cur, night.tgt, Math.min(1, dt * 3.2)); applyNight(night.cur, 1); moving = true; }
      else if (night.cur !== night.tgt) { night.cur = night.tgt; applyNight(night.cur, 1); moving = true; }
      {
        const np = 1 + (s.playing && !s.muted ? 0.16 * kick * Math.max(0.25, s.vol) : 0), nk = night.cur;
        dialLight.intensity = (nk * 420) * np; vuLights.forEach((l) => { l.intensity = (nk * 150) * np; });
        if (nk > 0 && s.playing) moving = true;
      }
      // antena: parada (não balança com o grave); o chiado de rádio cai com ela esticada
      {
        const beatSign = Math.floor(beat) % 2 ? 1 : -1, drive = 0;
        let rem = Math.min(dt, 0.1);
        while (rem > 0) { const h = Math.min(rem, 1 / 120); rem -= h; antSt.v += (120 * (drive - antSt.w) - 6 * antSt.v) * h; antSt.w += antSt.v * h; }
        if (Math.abs(antSt.w) < 0.0004 && Math.abs(antSt.v) < 0.004 && !drive) { antSt.w = 0; antSt.v = 0; } else moving = true;
        poseAntenna();
        const q = 1 - Math.min(1, Math.abs(antSt.tilt - 0.35) / 0.9);
        const hiss = s.playing && !s.muted ? 0.035 * (1 - 0.92 * antSt.e * q) : 0;
        if (Math.abs(hiss - antSt.hiss) > 0.0015) { antSt.hiss = hiss; window.Sfx?.hiss(hiss); }
      }
      // medidores de nível: dançam no ritmo enquanto toca (simulados, o Spotify não entrega o áudio)
      const live = s.playing && !s.muted && s.vol > 0;
      if (live) {
        const lvl = (0.2 + 0.5 * kick + 0.2 * hat) * enMul;
        for (const [ch, ph] of [['L', 0], ['R', 1.3]]) {
          const j = 0.9 + 0.1 * Math.sin(posClock * (ch === 'L' ? 7.3 : 6.1) + ph);
          vu[ch].tgt = Math.min(1, lvl * swell * j * 1.3 * (0.55 + 0.45 * s.vol));
        }
      } else { vu.L.tgt = 0; vu.R.tgt = 0; }
      for (const ch of ['L', 'R']) {
        // ponteiro preso a uma mola: sobe rápido, passa um pouco do ponto e assenta (subamortecido)
        const u = vu[ch];
        let rem = Math.min(dt, 0.1);
        while (rem > 0) {
          const h = Math.min(rem, 1 / 120); rem -= h;
          u.v += (250 * (u.tgt - u.x) - 20 * u.v) * h;
          u.x += u.v * h;
          if (u.x < 0) { u.x = 0; if (u.v < 0) u.v *= -0.25; }   // batente no zero
          if (u.x > 1.04) { u.x = 1.04; if (u.v > 0) u.v *= -0.25; } // batente no fim da escala
        }
        if (Math.abs(u.x - u.shown) > 0.0004) { u.shown = u.x; u.piv.rotation.z = -(-VU_SWEEP + 2 * VU_SWEEP * u.x); }
        if (Math.abs(u.x - u.tgt) > 0.001 || Math.abs(u.v) > 0.01) moving = true; else { u.x = u.tgt; u.v = 0; }
      }
      if (moving || tapeAnim.mode) dirty = true;

      // 4) desenhar (no máximo ~30 fps quando só os carretéis giram, para poupar bateria)
      if (!dirty) return;
      if (s.playing && !interacting && !tapeAnim.mode && now - lastRender < 30) return;
      dirty = false; lastRender = now;
      applyOffset(); placeCamera();
      syncDoorProxy();
      const t0 = performance.now();
      renderer.render(scene, camera);
      // aparelho fraco (Raspberry Pi, celular antigo): reduz a qualidade sozinho
      if (quality === 'high' && ++sampled > 20 && sampled < 140) {
        if (performance.now() - t0 > 28) slowFrames++;
        if (slowFrames > 14) {
          quality = 'low'; renderer.shadowMap.enabled = false; key.castShadow = false; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
          fit();
        }
      }
    }

    fit();
    // Tela cheia (F11), girar o celular, barra do navegador que some e volta: reenquadra sempre.
    // Só o ResizeObserver da caixa não basta, porque a tela 3D cobre a janela inteira.
    let refitTimer = 0, refitRaf = 0;
    const refit = () => {
      cancelAnimationFrame(refitRaf);
      refitRaf = requestAnimationFrame(fit);
      clearTimeout(refitTimer); refitTimer = setTimeout(fit, 300); // o iPhone atualiza as medidas com atraso
    };
    addEventListener('resize', refit);
    addEventListener('orientationchange', refit);
    document.addEventListener('fullscreenchange', refit);
    window.visualViewport?.addEventListener('resize', refit);
    new ResizeObserver(refit).observe(canvas);
    ['600 40px Caveat', '40px "Reenie Beanie"', '40px "Permanent Marker"'].forEach((f) => document.fonts?.load(f).then(() => { st.labelKey = ''; dirty = true; }).catch(() => {}));
    document.fonts?.ready.then(() => { st.sig = ''; st.dialKey = ''; st.labelKey = ''; dirty = true; });
    document.addEventListener('visibilitychange', () => { dirty = true; });
    addEventListener('scroll', () => { dirty = true; }, { passive: true });
    requestAnimationFrame(frame);
  }
})();
