(() => {
  const CFG = window.PLAYER_CONFIG;
  const SCOPES = [
    'streaming', 'user-read-email', 'user-read-private',
    'user-read-playback-state', 'user-modify-playback-state',
    'playlist-read-private', 'playlist-read-collaborative', 'user-library-read',
  ].join(' ');
  const $ = (id) => document.getElementById(id);
  const LS = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- PKCE ----------
  const rand = (n) => {
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, n);
  };
  const sha256b64 = async (s) => {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return btoa(String.fromCharCode(...new Uint8Array(h)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  async function login() {
    const verifier = rand(64);
    LS.set('pkce_verifier', verifier);
    const params = new URLSearchParams({
      client_id: CFG.clientId, response_type: 'code', redirect_uri: CFG.redirectUri,
      scope: SCOPES, code_challenge_method: 'S256',
      code_challenge: await sha256b64(verifier),
    });
    location.href = 'https://accounts.spotify.com/authorize?' + params;
  }

  async function tokenRequest(body) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CFG.clientId, ...body }),
    });
    if (!r.ok) throw new Error('Falha no token: ' + r.status);
    const t = await r.json();
    LS.set('access_token', t.access_token);
    LS.set('expires_at', String(Date.now() + t.expires_in * 1000 - 60000));
    if (t.refresh_token) LS.set('refresh_token', t.refresh_token);
    return t.access_token;
  }

  async function getToken() {
    if (LS.get('access_token') && Date.now() < Number(LS.get('expires_at'))) {
      return LS.get('access_token');
    }
    const rt = LS.get('refresh_token');
    if (!rt) throw new Error('Sem sessão');
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
  }

  function logout() {
    ['access_token', 'expires_at', 'refresh_token', 'pkce_verifier'].forEach(LS.del);
    location.href = location.hostname === '127.0.0.1' ? '/' : location.pathname;
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    const token = await getToken();
    const r = await fetch('https://api.spotify.com/v1' + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    if (r.status === 204) return null;
    if (!r.ok) { const err = new Error(path + ' -> ' + r.status); err.status = r.status; throw err; }
    return r.status === 200 ? r.json().catch(() => null) : null;
  }

  // ---------- Cores da capa ----------
  function applyColors(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 24;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        const pts = [[4, 4], [19, 8], [12, 20]].map(([px, py]) => {
          const i = (py * 24 + px) * 4;
          return boost(d[i], d[i + 1], d[i + 2]);
        });
        const s = document.documentElement.style;
        s.setProperty('--c1', pts[0]); s.setProperty('--c2', pts[1]); s.setProperty('--c3', pts[2]);
      } catch { /* mantem cores atuais */ }
    };
    img.src = url;
  }
  // Deixa a cor mais viva (satura e garante brilho minimo)
  function boost(r, g, b) {
    const m = (r + g + b) / 3, k = 1.5;
    const f = (v) => Math.max(40, Math.min(255, Math.round(m + (v - m) * k)));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }

  // ---------- Player ----------
  let player, deviceId, state = null, tick = null;
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const setStatus = (t, isError = false) => {
    const el = $('status');
    el.textContent = t || '';
    el.classList.toggle('error', Boolean(isError && t));
  };
  // Preenchimento das barras (CSS usa --pct)
  const setPct = (input) => {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  };
  let currentUri = null, lastVolume = 60;
  let volKnob = null, tuneKnob = null, ejected = false;

  // ---------- Botões giratórios (arraste, use a roda do mouse ou as setas) ----------
  function makeKnob(el, { value = 0, onInput, onEnd, step = 0.05 } = {}) {
    let v = value, drag = null;
    const set = (x) => {
      v = Math.max(0, Math.min(1, x));
      el.style.setProperty('--a', (-135 + 270 * v) + 'deg');
      el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    };
    set(v);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true });
      drag = { x: e.clientX, y: e.clientY, v, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = ((drag.y - e.clientY) + (e.clientX - drag.x)) / 170;
      if (Math.abs(d) > 0.004) drag.moved = true;
      set(drag.v + d); onInput?.(v);
    });
    const end = () => { if (drag) { const m = drag.moved; drag = null; if (m) onEnd?.(v); } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault(); set(v - Math.sign(e.deltaY) * step); onInput?.(v); onEnd?.(v);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      set(v + k * step); onInput?.(v); onEnd?.(v);
    });
    return { set, get: () => v };
  }

  // ---------- Girar a caixa em 3D ----------
  // No celular a caixa começa quase de frente, para caber inteira na tela
  const rot = innerWidth < 760 ? { ry: -6, rx: 3 } : { ry: -18, rx: 6 };
  let spinAnim = 0;
  const applyRot = () => {
    const r = $('rig'); if (!r) return;
    r.style.transform = `rotateX(${rot.rx}deg) rotateY(${rot.ry}deg)`;
    // De perfil, o relevo das peças vai se achatando no painel (sem sumir), para não virar riscos
    const c = Math.abs(Math.cos(rot.ry * Math.PI / 180));
    r.parentElement.style.setProperty('--lift', Math.min(1, c * 2.2).toFixed(3));
  };
  const facingFront = () => { const n = ((rot.ry % 360) + 360) % 360; return (n < 40 || n > 320) && Math.abs(rot.rx) < 30; };
  function rotateTo(ry, rx, ms = 600) {
    cancelAnimationFrame(spinAnim);
    const a = { ry: rot.ry, rx: rot.rx }, t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms), k = ease(t);
      rot.ry = a.ry + (ry - a.ry) * k; rot.rx = a.rx + (rx - a.rx) * k; applyRot();
      if (t < 1) spinAnim = requestAnimationFrame(step);
    };
    spinAnim = requestAnimationFrame(step);
  }
  const frontTarget = () => Math.round(rot.ry / 360) * 360;
  function setupSpin() {
    const box = $('boombox');
    if (!box) return;
    // Alça em 3D: várias fatias empilhadas dão espessura
    const h = $('handle3d');
    for (let i = -14; i <= 14; i++) {
      const s = document.createElement('div'); s.className = 'hs';
      s.style.transform = `translateZ(${i * 0.115}em)`;
      s.innerHTML = '<i></i><i></i><i></i>';
      h.append(s);
    }
    // Botões giratórios: camadas empilhadas formam a lateral do cilindro
    document.querySelectorAll('.knob').forEach((k) => {
      for (let i = 1; i <= 7; i++) {
        const s = document.createElement('s'); s.style.transform = `translateZ(calc(${-i * 0.24}em * var(--lift)))`; k.append(s);
      }
    });
    applyRot();
    let drag = null, vy = 0, vx = 0, raf = 0;
    const inertia = () => {
      if (drag) return;
      rot.ry += vy; rot.rx = Math.max(-70, Math.min(70, rot.rx + vx));
      vy *= 0.94; vx *= 0.9; applyRot();
      if (Math.abs(vy) > 0.03 || Math.abs(vx) > 0.03) raf = requestAnimationFrame(inertia);
    };
    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, .knob, input, a')) return;
      cancelAnimationFrame(spinAnim); cancelAnimationFrame(raf);
      drag = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
      vy = vx = 0; box.setPointerCapture(e.pointerId); box.classList.add('dragging');
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      vy = dx * 0.45; rot.ry += vy;
      if (!drag.touch) { vx = -dy * 0.3; rot.rx = Math.max(-70, Math.min(70, rot.rx + vx)); }
      applyRot();
    });
    const up = () => { if (!drag) return; drag = null; box.classList.remove('dragging'); raf = requestAnimationFrame(inertia); };
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    box.addEventListener('dblclick', (e) => { if (!e.target.closest('button, .knob')) rotateTo(frontTarget(), 0); });
    document.querySelectorAll('[data-spin]').forEach((b) => {
      b.onclick = () => {
        cancelAnimationFrame(raf);
        const v = b.dataset.spin;
        if (v === 'front') rotateTo(frontTarget(), 0); else rotateTo(rot.ry + Number(v), rot.rx);
      };
    });
  }

  function markPlaying() {
    document.querySelectorAll('#results .cas, #lib-list .cas').forEach((r) => {
      r.classList.toggle('playing', r.dataset.uri === currentUri);
    });
  }

  function render(s) {
    state = s;
    if (!s) return;
    const t = s.track_window.current_track;
    currentUri = t.uri;
    $('title').textContent = t.name;
    $('artist').textContent = t.artists.map((a) => a.name).join(', ');
    document.title = t.name + ' · ' + t.artists[0].name;
    const cover = t.album.images[0]?.url || '';
    if ($('cover').getAttribute('src') !== cover) {
      $('cover').src = cover;
      if (cover) applyColors(cover);
    }
    const btn = $('btn-play');
    btn.dataset.state = s.paused ? 'paused' : 'playing';
    $('now').dataset.playing = String(!s.paused);
    $('btn-pause').dataset.state = s.paused ? 'on' : 'off';
    if (!ejected) document.querySelector('.tape').classList.remove('empty');
    $('btn-shuffle').setAttribute('aria-pressed', String(Boolean(s.shuffle)));
    const modes = ['off', 'context', 'track'];
    const mode = modes[s.repeat_mode] || 'off';
    $('btn-repeat').dataset.mode = mode;
    $('btn-repeat').setAttribute('aria-pressed', String(mode !== 'off'));
    $('t-dur').textContent = fmt(s.duration);
    markPlaying();
    updateMediaSession(t);
    updateProgress();
  }
  function updateProgress() {
    if (!state) return;
    const pos = state.paused ? state.position
      : state.position + (Date.now() - state.updateTime);
    const p = Math.min(pos, state.duration);
    $('t-cur').textContent = fmt(p);
    // A fita passa de um carretel para o outro conforme a música avança
    const ratio = state.duration ? p / state.duration : 0;
    $('now').style.setProperty('--p', ratio.toFixed(4));
    if (!seeking) { $('seek').value = ratio * 1000; setPct($('seek')); tuneKnob?.set(ratio); }
  }
  let seeking = false;

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.name, artist: t.artists.map((a) => a.name).join(', '), album: t.album.name,
        artwork: t.album.images.map((i) => ({ src: i.url, sizes: `${i.width}x${i.height}` })),
      });
      navigator.mediaSession.setActionHandler('play', () => player?.resume());
      navigator.mediaSession.setActionHandler('pause', () => player?.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => player?.previousTrack());
      navigator.mediaSession.setActionHandler('nexttrack', () => player?.nextTrack());
    } catch { /* navegador sem suporte completo */ }
  }

  // ---------- Modo controle remoto ----------
  // iPhone (e navegadores sem áudio protegido) não tocam música aqui: o player vira controle
  // do aparelho que estiver tocando no Spotify (computador, Raspberry Pi, caixa de som…).
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let remote = false, remoteBusy = false, remoteVolHold = 0, volTimer = 0;

  async function remoteCmd(path, method = 'PUT') {
    try { await api(path, { method }); }
    catch (e) {
      setStatus(e.status === 404 ? 'Nenhum aparelho ativo. Abra o Spotify no aparelho que vai tocar.' : 'Não foi possível enviar o comando.', true);
    }
    setTimeout(pollRemote, 350);
  }
  const remotePlayer = {
    resume: () => remoteCmd('/me/player/play'),
    pause: () => remoteCmd('/me/player/pause'),
    togglePlay: () => (state && !state.paused ? remotePlayer.pause() : remotePlayer.resume()),
    previousTrack: () => remoteCmd('/me/player/previous', 'POST'),
    nextTrack: () => remoteCmd('/me/player/next', 'POST'),
    seek: (ms) => remoteCmd('/me/player/seek?position_ms=' + Math.round(ms)),
    setVolume: (v) => {
      remoteVolHold = Date.now() + 3000; clearTimeout(volTimer);
      volTimer = setTimeout(() => api('/me/player/volume?volume_percent=' + Math.round(v * 100), { method: 'PUT' }).catch(() => {}), 180);
    },
    activateElement: async () => {},
  };

  async function pollRemote() {
    if (!remote || remoteBusy || document.hidden) return;
    remoteBusy = true;
    try {
      const d = await api('/me/player');
      if (d?.device) deviceId = d.device.id;
      if (!d || !d.item) {
        if (d) { setStatus(''); return; } // aparelho ativo, nada tocando: nada a avisar
        // Nenhum aparelho ativo: usa o primeiro que estiver disponível (o play já o ativa)
        const dv = await api('/me/player/devices').catch(() => null);
        const pick = dv?.devices?.[0];
        if (pick) { deviceId = pick.id; setStatus(''); }
        else { deviceId = null; setStatus('Abra o Spotify em um aparelho para ouvir.', true); }
        return;
      }
      const t = d.item;
      render({
        paused: !d.is_playing, position: d.progress_ms || 0, duration: t.duration_ms, updateTime: Date.now(),
        shuffle: d.shuffle_state, repeat_mode: Math.max(0, ['off', 'context', 'track'].indexOf(d.repeat_state)),
        track_window: { current_track: {
          uri: t.uri, name: t.name,
          artists: t.artists || [{ name: t.show?.name || '' }],
          album: t.album || { name: t.show?.name || '', images: t.images || [] },
        } },
      });
      if (Date.now() > remoteVolHold && d.device.volume_percent != null) setVolumeUi(d.device.volume_percent, true);
      setStatus('Controlando: ' + d.device.name);
    } catch (e) {
      if (e.status === 401 || e.status === 403) setStatus('Sessão expirada. Saia e entre de novo.', true);
    } finally { remoteBusy = false; }
  }

  function startRemote() {
    if (remote) return;
    remote = true; player = remotePlayer;
    setStatus('Modo controle remoto: o som sai do aparelho ativo no Spotify.');
    pollRemote();
    setInterval(pollRemote, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRemote(); });
    if (!tick) tick = setInterval(updateProgress, 500);
  }

  window.onSpotifyWebPlaybackSDKReady = () => {
    if (!LS.get('refresh_token') && !LS.get('access_token')) return;
    if (remote) return;
    if (IOS) { startRemote(); return; }
    player = new Spotify.Player({
      name: CFG.deviceName,
      getOAuthToken: (cb) => getToken().then(cb).catch(() => logout()),
      volume: Number($('vol').value) / 100,
    });
    player.addListener('ready', ({ device_id }) => {
      deviceId = device_id;
      // Passa a reproducao para este navegador sem iniciar nada
      api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [device_id], play: false }) })
        .catch(() => {});
    });
    player.addListener('not_ready', () => setStatus('Player desconectado. Recarregue a página.', true));
    player.addListener('player_state_changed', (s) => {
      if (s) { s.updateTime = Date.now(); }
      render(s);
    });
    player.addListener('initialization_error', () => startRemote()); // sem áudio protegido: vira controle remoto
    player.addListener('authentication_error', () => setStatus('Não foi possível entrar. Saia e entre de novo.', true));
    player.addListener('account_error', () => setStatus('O player precisa de uma conta Spotify Premium.', true));
    player.addListener('playback_error', () => setStatus('Não foi possível tocar esta faixa. Tente outra.', true));
    player.connect();
    tick = setInterval(updateProgress, 500);
  };

  // ---------- Busca ----------
  let searchTimer;
  async function search(q) {
    const box = $('results');
    if (!q.trim()) { box.classList.add('hidden'); box.innerHTML = ''; showLibrary(true); return; }
    showLibrary(false);
    setShelf(true);
    try {
      const data = await api('/search?type=track,playlist&limit=10&q=' + encodeURIComponent(q));
      const items = (data?.tracks?.items || []).filter(Boolean);
      const lists = (data?.playlists?.items || []).filter(Boolean);
      box.innerHTML = ''; box.classList.remove('stack');
      box.classList.add('shelf');
      if (!items.length && !lists.length) {
        const p = document.createElement('p');
        p.className = 'no-results';
        p.textContent = 'Nenhum resultado para "' + q.trim() + '". Tente outro nome.';
        box.append(p);
        box.classList.remove('hidden');
        return;
      }
      // Playlists primeiro: clicar abre as faixas, soltar no toca-fitas toca a playlist inteira
      lists.forEach((p) => {
        const total = p.tracks?.total ?? p.items?.total;
        box.append(casCard({
          img: p.images?.[0]?.url, name: p.name,
          sub: 'Playlist' + (total != null ? ' · ' + total + (total === 1 ? ' faixa' : ' faixas') : '') + (p.owner?.display_name ? ' · ' + p.owner.display_name : ''),
          onclick: () => { box.classList.add('hidden'); showLibrary(true); openPlaylist(p); },
          onDrop: () => playTrack(null, { context: p.uri }),
        }));
      });
      items.forEach((t) => {
        box.append(casCard({
          img: t.album.images.at(-1)?.url, name: t.name, uri: t.uri,
          sub: t.artists.map((a) => a.name).join(', ') + ' · ' + fmt(t.duration_ms),
          onclick: () => playTrack(t.uri),
        }));
      });
      markPlaying();
      box.classList.remove('hidden');
      arrangeStack(box, 0);
    } catch (e) { setStatus('A busca falhou. Verifique a conexão e tente de novo.', true); }
  }
  // Toca uma faixa avulsa, ou uma faixa dentro de uma playlist/lista de faixas
  async function playTrack(uri, ctx = {}) {
    if (remote && !deviceId) {
      const dv = await api('/me/player/devices').catch(() => null);
      const pick = dv?.devices?.find((x) => x.is_active) || dv?.devices?.[0];
      if (pick) deviceId = pick.id;
    }
    if (!deviceId) {
      setStatus(remote ? 'Nenhum aparelho do Spotify encontrado. Abra o Spotify no aparelho que vai tocar.' : 'O player ainda está iniciando. Tente de novo em instantes.', true);
      return;
    }
    ejected = false;
    const body = ctx.context ? { context_uri: ctx.context } : { uris: ctx.uris || [uri] };
    if (uri && (ctx.context || ctx.uris)) body.offset = { uri };
    try {
      await player.activateElement(); // libera audio no navegador
      await api('/me/player/play?device_id=' + deviceId, { method: 'PUT', body: JSON.stringify(body) });
      setStatus('');
      if (remote) setTimeout(pollRemote, 700);
      $('results').classList.add('hidden');
      setShelf(false); // a fita entrou no toca-fitas: guarda a estante
    } catch (e) { setStatus('Não foi possível tocar esta faixa. Tente outra.', true); }
  }

  // ---------- Biblioteca: playlists e músicas curtidas ----------
  const lib = { view: 'list' };
  function showLibrary(on) { $('library').classList.toggle('hidden', !on); }

  // As fitas ficam guardadas: o botão "Fitas" abre e fecha a estante
  function setShelf(on, { scroll = false } = {}) {
    const shelf = $('shelf'), btn = $('btn-shelf');
    if (!shelf) return;
    shelf.classList.toggle('hidden', !on);
    btn.setAttribute('aria-expanded', String(on));
    btn.title = on ? 'Guardar as fitas' : 'Abrir as fitas';
    if (!on) return;
    // as fitas foram posicionadas com a estante escondida: reajusta o leque
    [$('lib-list'), $('results')].forEach((b) => { if (b._cards) setIdx(b, b._idx); });
    if (scroll) shelf.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function libRow({ img, name, sub, dur, uri, onclick }) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'row';
    if (uri) row.dataset.uri = uri;
    if (img) {
      const i = document.createElement('img'); i.src = img; i.alt = ''; row.append(i);
    } else {
      const ph = document.createElement('span'); ph.className = 'ph';
      ph.innerHTML = '<svg aria-hidden="true"><use href="#i-note"/></svg>'; row.append(ph);
    }
    const info = document.createElement('span'); info.className = 'txt';
    const b = document.createElement('b'); b.textContent = name;
    const sm = document.createElement('small'); sm.textContent = sub || '';
    info.append(b, sm); row.append(info);
    if (dur) { const d = document.createElement('span'); d.className = 'dur'; d.textContent = dur; row.append(d); }
    row.onclick = onclick;
    return row;
  }

  // Fita da prateleira (uma por playlist)
  // ---------- Pilha de fitas em perspectiva (estilo "coverflow") ----------
  function setIdx(box, i) {
    const cards = box._cards || [];
    if (!cards.length) return;
    i = Math.max(0, Math.min(cards.length - 1, i));
    box._idx = i;
    const w = cards[0].offsetWidth || 220;
    cards.forEach((c, k) => {
      const o = k - i, a = Math.abs(o), sg = Math.sign(o);
      c.dataset.i = k;
      if (a > 5) { c.style.visibility = 'hidden'; c.style.pointerEvents = 'none'; c.style.opacity = '0'; return; }
      c.style.visibility = ''; c.style.pointerEvents = '';
      c.style.opacity = String(1 - a * 0.13);
      c.style.zIndex = String(100 - a);
      c.style.transform = `translateX(${o === 0 ? 0 : sg * (w * 0.68 + (a - 1) * w * 0.24)}px) translateZ(${-a * 80}px) rotateY(${-sg * 50}deg)`;
    });
    const n = box.querySelector('.stack-count');
    if (n) n.textContent = (i + 1) + ' / ' + cards.length;
  }
  function arrangeStack(box, idx = 0) {
    const cards = [...box.querySelectorAll(':scope > .cas')];
    if (!cards.length) { box.classList.remove('stack'); return; }
    box.classList.add('stack'); box._cards = cards;
    if (!box.querySelector('.stack-nav')) {
      [['prev', '‹', -1, 'Fita anterior'], ['next', '›', 1, 'Próxima fita']].forEach(([cls, txt, d, label]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'stack-nav ' + cls; b.textContent = txt; b.setAttribute('aria-label', label);
        b.onclick = () => setIdx(box, box._idx + d); box.append(b);
      });
      const n = document.createElement('span'); n.className = 'stack-count'; box.append(n);
    }
    if (!box._wired) {
      box._wired = true; box.tabIndex = 0; box.setAttribute('aria-label', 'Pilha de fitas. Use as setas para folhear.');
      box.addEventListener('pointerdown', (e) => {
        if (e.button > 0 || e.target.closest('.stack-nav')) return;
        const st = { x: e.clientX, i: box._idx, moved: false };
        const mv = (ev) => {
          if (document.body.classList.contains('is-dragging')) return;
          const dx = ev.clientX - st.x;
          if (Math.abs(dx) > 8) st.moved = true;
          if (st.moved) setIdx(box, st.i - Math.round(dx / 60));
        };
        const up = () => {
          document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
          if (st.moved) { box._moved = true; setTimeout(() => { box._moved = false; }, 80); }
        };
        document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
      });
      let lastWheel = 0;
      box.addEventListener('wheel', (e) => {
        if (!(Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) return; // rolagem vertical continua rolando a página
        e.preventDefault();
        if (Date.now() - lastWheel < 110) return;
        lastWheel = Date.now(); setIdx(box, box._idx + Math.sign(e.deltaX || e.deltaY));
      }, { passive: false });
      box.addEventListener('keydown', (e) => {
        const k = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
        if (k) { e.preventDefault(); e.stopPropagation(); setIdx(box, box._idx + k); }
        else if (e.key === 'Home') { e.preventDefault(); setIdx(box, 0); }
        else if (e.key === 'End') { e.preventDefault(); setIdx(box, 1e9); }
      });
    }
    setIdx(box, idx);
  }

  // Arrastar uma fita até o toca-fitas (mouse, caneta ou toque com o dedo pressionado)
  function makeDraggable(card, onDrop) {
    card.addEventListener('dragstart', (e) => e.preventDefault());
    card.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const s = { x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, touch: e.pointerType === 'touch', drag: false, clone: null, timer: 0, raf: 0, hit: null };
      const door = () => document.querySelector('.door');
      const noScroll = (ev) => ev.preventDefault();
      const place = () => {
        s.clone.style.left = (s.lx - s.dx) + 'px'; s.clone.style.top = (s.ly - s.dy) + 'px';
        const hit = document.elementFromPoint(s.lx, s.ly)?.closest('.door');
        s.hit = hit; door().classList.toggle('drop-ready', Boolean(hit));
      };
      const begin = () => {
        s.drag = true;
        s.dx = card.offsetWidth / 2; s.dy = card.offsetHeight / 2;
        const c = card.cloneNode(true); c.classList.add('flying', 'carried');
        c.style.cssText = '';
        Object.assign(c.style, { position: 'fixed', width: card.offsetWidth + 'px', height: card.offsetHeight + 'px', margin: 0 });
        document.body.append(c); s.clone = c; card.classList.add('lifted');
        document.body.classList.add('is-dragging');
        document.addEventListener('touchmove', noScroll, { passive: false });
        place();
        const scroller = () => { // rola a página quando a fita chega perto da borda
          if (!s.drag) return;
          if (s.ly < 70) scrollBy(0, -14); else if (s.ly > innerHeight - 70) scrollBy(0, 14);
          place(); s.raf = requestAnimationFrame(scroller);
        };
        s.raf = requestAnimationFrame(scroller);
      };
      const move = (ev) => {
        s.lx = ev.clientX; s.ly = ev.clientY;
        if (!s.drag) {
          if (s.nav) return;
          const far = Math.hypot(s.lx - s.x0, s.ly - s.y0);
          if (s.touch) { if (far > 10) cleanup(); return; } // o dedo andou antes: é rolagem
          if (far > 8) {
            // Na pilha, arrastar para os lados folheia as fitas; para cima/baixo, pega a fita
            const adx = Math.abs(s.lx - s.x0), ady = Math.abs(s.ly - s.y0);
            if (card.parentElement?.classList.contains('stack') && adx > ady * 1.2) { s.nav = true; return; }
            begin();
          }
        } else place();
      };
      const cleanup = () => {
        clearTimeout(s.timer); cancelAnimationFrame(s.raf);
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', cancel); document.removeEventListener('touchmove', noScroll);
        document.body.classList.remove('is-dragging'); card.classList.remove('lifted');
        const d = door(); if (d) d.classList.remove('drop-ready');
      };
      const finish = (dropped) => {
        const clone = s.clone;
        card._dragged = true; setTimeout(() => { card._dragged = false; }, 60);
        cleanup();
        if (!clone) return;
        if (dropped) { clone.remove(); onDrop(); return; }
        const r = card.getBoundingClientRect(); // volta para a prateleira
        Object.assign(clone.style, { transition: 'all .3s cubic-bezier(.4,.1,.2,1)', left: r.left + 'px', top: r.top + 'px', transform: 'none' });
        setTimeout(() => clone.remove(), 320);
      };
      const up = () => { if (!s.drag) { cleanup(); return; } finish(Boolean(s.hit)); };
      const cancel = () => { if (s.drag) finish(false); else cleanup(); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
      if (s.touch) s.timer = setTimeout(begin, 260);
    });
  }

  function casCard({ img, name, sub, uri, onclick, onDrop }) {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'cas'; c.title = name + ' — arraste até o toca-fitas';
    if (uri) c.dataset.uri = uri;
    const cl = document.createElement('span'); cl.className = 'cl';
    if (img) { const i = document.createElement('img'); i.src = img; i.alt = ''; cl.append(i); }
    const t = document.createElement('span');
    const b = document.createElement('b'); b.textContent = name;
    const s = document.createElement('small'); s.textContent = sub || '';
    t.append(b, s); cl.append(t);
    const w = document.createElement('span'); w.className = 'cw'; w.setAttribute('aria-hidden', 'true');
    c.append(cl, w);
    c.onclick = () => {
      if (c._dragged) return;
      const st = c.parentElement;
      if (st?.classList.contains('stack')) {
        if (st._moved) return;
        if (Number(c.dataset.i) !== st._idx) { setIdx(st, Number(c.dataset.i)); return; } // fita do lado vem para a frente
      }
      insertTape(name, c); onclick();
    };
    // Soltar no toca-fitas toca a fita (a playlist inteira, ou só a música)
    makeDraggable(c, () => { insertTape(name, null); (onDrop || onclick)(); });
    return c;
  }

  // Coloca a fita no toca-fitas: voa da prateleira até o compartimento e desliza para dentro
  function insertTape(name, from) {
    const tape = document.querySelector('.tape');
    ejected = false;
    $('tape-name').textContent = name;
    tape.classList.remove('empty', 'ejecting');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const slideIn = () => { tape.classList.remove('inserting'); void tape.offsetWidth; tape.classList.add('inserting'); };
    if (reduce) return;
    const fly = () => {
      if (!from) { slideIn(); return; }
      const a = from.getBoundingClientRect(), b = tape.getBoundingClientRect();
      const visible = b.top >= 0 && b.bottom <= innerHeight && b.width > 0;
      if (!from || !visible || a.width === 0) {
        tape.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(slideIn, 400);
        return;
      }
      const c = from.cloneNode(true); c.classList.add('flying'); c.style.cssText = '';
      Object.assign(c.style, { position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: 0, transition: 'all .5s cubic-bezier(.4,.1,.2,1)' });
      document.body.append(c);
      tape.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        Object.assign(c.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px', opacity: '.2' });
      }));
      setTimeout(() => { c.remove(); tape.style.opacity = ''; slideIn(); }, 500);
    };
    // A fita só entra se a frente do toca-fitas estiver virada para você
    if (!facingFront()) { rotateTo(frontTarget(), 0, 500); setTimeout(fly, 540); } else fly();
  }

  // Ejetar: a fita sai do compartimento e a prateleira volta
  function ejectTape() {
    const tape = document.querySelector('.tape');
    ejected = true;
    player?.pause();
    tape.classList.remove('inserting'); tape.classList.add('ejecting');
    setTimeout(() => { tape.classList.remove('ejecting'); tape.classList.add('empty'); $('tape-name').textContent = 'Sem fita'; }, 480);
    $('results').classList.add('hidden');
    loadPlaylists();
    $('library').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setLibHeader(title, { back = false, play = null } = {}) {
    $('lib-list').classList.add('shelf');
    $('lib-title').textContent = title;
    $('lib-back').classList.toggle('hidden', !back);
    const p = $('lib-play');
    p.classList.toggle('hidden', !play);
    p.onclick = play;
  }

  function libMessage(text, withAuth) {
    const list = $('lib-list');
    list.innerHTML = ''; list.classList.remove('stack');
    const p = document.createElement('p'); p.className = 'no-results'; p.textContent = text;
    list.append(p);
    if (withAuth) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lib-action'; b.textContent = 'Autorizar acesso às playlists';
      b.onclick = login; list.append(b);
    }
  }

  async function loadPlaylists() {
    lib.view = 'list';
    setLibHeader('Suas fitas');
    libMessage('Carregando…');
    showLibrary(true);
    try {
      const data = await api('/me/playlists?limit=50');
      const items = (data?.items || []).filter(Boolean);
      const list = $('lib-list'); list.innerHTML = ''; list.classList.remove('stack');
      list.append(casCard({ name: 'Músicas curtidas', sub: 'Sua biblioteca', onclick: openLiked, onDrop: playLiked }));
      items.forEach((p) => {
        const total = p.tracks?.total ?? p.items?.total;
        list.append(casCard({
          img: p.images?.[0]?.url, name: p.name,
          sub: total != null ? total + (total === 1 ? ' faixa' : ' faixas') : 'Playlist',
          onclick: () => openPlaylist(p),
          onDrop: () => playTrack(null, { context: p.uri }),
        }));
      });
      arrangeStack(list, 0);
      if (!items.length) {
        const p = document.createElement('p'); p.className = 'no-results';
        p.textContent = 'Você ainda não tem playlists. Crie uma no Spotify e ela aparece aqui.';
        list.append(p);
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        libMessage('Falta a permissão para ler suas playlists. Autorize de novo para liberar o acesso.', true);
      } else {
        libMessage('Não foi possível carregar suas playlists. Verifique a conexão e tente de novo.');
      }
    }
  }

  const asTracks = (arr) => (arr || []).map((i) => i?.track || i?.item || i)
    .filter((t) => t && t.uri && t.type !== 'episode');

  function renderTracks(tracks, ctx) {
    const list = $('lib-list'); list.innerHTML = ''; list.classList.remove('stack');
    if (!tracks.length) { libMessage('Esta lista não tem faixas para tocar.'); return; }
    const uris = tracks.map((t) => t.uri).slice(0, 100);
    tracks.forEach((t) => {
      list.append(casCard({
        img: t.album?.images?.at(-1)?.url, name: t.name,
        sub: (t.artists || []).map((a) => a.name).join(', ') + ' · ' + fmt(t.duration_ms), uri: t.uri,
        onclick: () => playTrack(t.uri, ctx.context ? { context: ctx.context } : { uris }),
      }));
    });
    markPlaying();
    arrangeStack(list, Math.max(0, tracks.findIndex((t) => t.uri === currentUri)));
    setLibHeader($('lib-title').textContent, {
      back: true,
      play: () => playTrack(ctx.context ? null : uris[0], ctx.context ? { context: ctx.context } : { uris }),
    });
  }

  async function openPlaylist(p) {
    lib.view = 'tracks';
    setLibHeader(p.name, { back: true });
    libMessage('Carregando faixas…');
    try {
      let data;
      try { data = await api(`/playlists/${p.id}/tracks?limit=100`); }
      catch (e) { if (e.status === 403 || e.status === 404) data = await api(`/playlists/${p.id}/items?limit=100`); else throw e; }
      renderTracks(asTracks(data?.items), { context: p.uri });
    } catch (e) {
      // Apps em modo de desenvolvimento só leem as faixas das playlists da própria conta;
      // tocar a playlist inteira continua liberado.
      const blocked = e.status === 403 || e.status === 404;
      libMessage(blocked
        ? 'O Spotify não deixa este app listar as faixas de playlists de outras pessoas, mas você pode tocar a playlist inteira.'
        : 'Não foi possível carregar as faixas. Tente de novo.');
      if (blocked) setLibHeader(p.name, { back: true, play: () => { insertTape(p.name, null); playTrack(null, { context: p.uri }); } });
    }
  }

  async function playLiked() {
    try {
      const data = await api('/me/tracks?limit=50');
      const uris = asTracks(data?.items).map((t) => t.uri);
      if (uris.length) await playTrack(uris[0], { uris });
      else setStatus('Você ainda não curtiu nenhuma música.', true);
    } catch { setStatus('Não foi possível tocar suas músicas curtidas.', true); }
  }

  async function openLiked() {
    lib.view = 'tracks';
    setLibHeader('Músicas curtidas', { back: true });
    libMessage('Carregando faixas…');
    try {
      const data = await api('/me/tracks?limit=50');
      renderTracks(asTracks(data?.items), {});
    } catch (e) {
      libMessage(e.status === 401 || e.status === 403
        ? 'Falta a permissão para ler suas músicas curtidas. Autorize de novo para liberar o acesso.'
        : 'Não foi possível carregar suas músicas curtidas. Tente de novo.', e.status === 401 || e.status === 403);
    }
  }

  async function setMode(path, value) {
    if (!deviceId) return;
    try { await api(`${path}?state=${value}&device_id=${deviceId}`, { method: 'PUT' }); if (remote) setTimeout(pollRemote, 350); }
    catch { setStatus('Não foi possível mudar o modo de reprodução.', true); }
  }
  function setVolumeUi(v, silent = false) {
    $('vol').value = v; setPct($('vol')); volKnob?.set(v / 100);
    $('btn-mute').classList.toggle('is-muted', v === 0);
    $('btn-mute').setAttribute('aria-label', v === 0 ? 'Reativar som' : 'Silenciar');
    if (!silent) player?.setVolume(v / 100);
  }

  // ---------- Init ----------
  async function init() {
    if (CFG.clientId.startsWith('COLE_')) {
      $('login-msg').textContent = 'Falta o Client ID: edite config.js.';
      $('btn-login').disabled = true;
      return;
    }
    $('btn-login').onclick = login;
    $('btn-logout').onclick = logout;
    $('btn-shelf').onclick = () => setShelf($('shelf').classList.contains('hidden'), { scroll: true });

    const qs = new URLSearchParams(location.search);
    if (qs.get('error')) { $('login-msg').textContent = 'Login cancelado: ' + qs.get('error'); }
    if (qs.get('code')) {
      try {
        await tokenRequest({
          grant_type: 'authorization_code', code: qs.get('code'),
          redirect_uri: CFG.redirectUri, code_verifier: LS.get('pkce_verifier') || '',
        });
        history.replaceState({}, '', location.hostname === '127.0.0.1' ? '/' : location.pathname);
        location.reload(); return;
      } catch (e) { $('login-msg').textContent = e.message; return; }
    }
    if (LS.get('refresh_token') || LS.get('access_token')) {
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      $('lib-back').onclick = loadPlaylists;
      loadPlaylists();
      if (IOS) startRemote();
    }
    // Instalável como app (PWA): só registra onde o navegador permite (HTTPS ou localhost)
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    $('q').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => search(e.target.value), 300);
    });
    $('btn-play').onclick = () => player?.resume();
    $('btn-pause').onclick = () => player?.pause();
    $('btn-eject').onclick = ejectTape;
    $('btn-prev').onclick = () => player?.previousTrack();
    setupSpin();
    volKnob = makeKnob($('knob-vol'), {
      value: Number($('vol').value) / 100,
      onInput: (v) => { const n = Math.round(v * 100); if (n > 0) lastVolume = n; setVolumeUi(n); },
    });
    tuneKnob = makeKnob($('knob-tune'), {
      onInput: (v) => {
        if (!state) return;
        seeking = true;
        $('t-cur').textContent = fmt(v * state.duration);
        $('now').style.setProperty('--p', v.toFixed(4));
      },
      onEnd: (v) => {
        seeking = false;
        if (!state || !player) return;
        player.seek(v * state.duration);
        state.position = v * state.duration; state.updateTime = Date.now();
      },
    });
    document.querySelectorAll('[data-deco]').forEach((k) => makeKnob(k, { value: 0.5 }));
    // Carretéis: tocar no da esquerda volta 10 s, no da direita avança 10 s
    const wind = (btn, delta) => {
      btn.onclick = () => {
        if (!state || !player) return;
        const now = state.position + (state.paused ? 0 : Date.now() - state.updateTime);
        player.seek(Math.max(0, Math.min(state.duration, now + delta)));
        btn.classList.add('fast'); setTimeout(() => btn.classList.remove('fast'), 700);
      };
    };
    wind($('reel-l'), -10000); wind($('reel-r'), 10000);
    $('btn-next').onclick = () => player?.nextTrack();
    $('vol').oninput = (e) => {
      const v = Number(e.target.value);
      if (v > 0) lastVolume = v;
      setVolumeUi(v);
    };
    setPct($('vol'));
    $('btn-mute').onclick = () => setVolumeUi(Number($('vol').value) === 0 ? lastVolume : 0);
    $('btn-shuffle').onclick = () =>
      setMode('/me/player/shuffle', $('btn-shuffle').getAttribute('aria-pressed') !== 'true');
    $('btn-repeat').onclick = () => {
      const next = { off: 'context', context: 'track', track: 'off' }[$('btn-repeat').dataset.mode] || 'off';
      setMode('/me/player/repeat', next);
    };
    $('seek').addEventListener('input', (e) => { seeking = true; setPct(e.target); });
    $('seek').addEventListener('change', (e) => {
      seeking = false;
      if (state) player?.seek((Number(e.target.value) / 1000) * state.duration);
    });

    // Atalhos de teclado
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) &&
        document.activeElement.type !== 'range';
      if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus(); return; }
      if (e.key === 'Escape' && document.activeElement === $('q')) {
        $('q').value = ''; $('q').blur(); search(''); return;
      }
      if (typing || !player) return;
      if (e.key === ' ' && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); player.togglePlay(); }
      else if (e.key === 'ArrowRight' && state) { e.preventDefault(); player.seek(Math.min(state.duration, state.position + (Date.now() - state.updateTime) * (state.paused ? 0 : 1) + 5000)); }
      else if (e.key === 'ArrowLeft' && state) { e.preventDefault(); player.seek(Math.max(0, state.position + (Date.now() - state.updateTime) * (state.paused ? 0 : 1) - 5000)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setVolumeUi(Math.min(100, Number($('vol').value) + 5)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setVolumeUi(Math.max(0, Number($('vol').value) - 5)); }
    });
  }
  init();
})();
