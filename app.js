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

  // ---------- Girar a caixa em 3D (o desenho e o giro ficam no deck3d.js) ----------
  const facingFront = () => window.Deck3D?.facingFront() ?? true;
  const rotateFront = (ms) => window.Deck3D?.rotateFront(ms);

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
    else if (!s.paused && Date.now() - ejectedAt > 4000) reinsertTape(); // voltou a tocar (por exemplo em outro aparelho): a fita volta
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
      box.innerHTML = ''; box.classList.remove('stack', 'rack');
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
          img: p.images?.[0]?.url, name: p.name, key: p.uri,
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

  // ---------- Personalizar fitas (nome, cor e fixar), guardado neste navegador ----------
  const getTapes = () => { try { return JSON.parse(LS.get('tapes') || '{}') || {}; } catch { return {}; } };
  const saveTapes = (o) => { try { localStorage.setItem('tapes', JSON.stringify(o)); return true; } catch { return false; } };
  // quantas vezes cada fita foi colocada no aparelho (define o desgaste)
  const getPlays = () => { try { return JSON.parse(LS.get('plays') || '{}') || {}; } catch { return {}; } };
  const TAPE_STYLES = [['classico', 'Clássico'], ['listras', 'Listras'], ['minimal', 'Minimal'], ['retro', 'Retrô'], ['neon', 'Neon'], ['foto', 'Foto']];
  window.TapeStore = { get: (k) => ({ ...(getTapes()[k] || {}), plays: getPlays()[k] || 0 }) };
  const TAPE_COLORS = [['', 'Automática'], ['#ff3d81', 'Rosa'], ['#7a3dff', 'Roxo'], ['#00d2ff', 'Ciano'], ['#2fd48a', 'Verde'], ['#ffc23d', 'Amarelo'], ['#ff7a3d', 'Laranja']];
  function applyTapeStyles(box) {
    const tapes = getTapes();
    const cards = [...box.querySelectorAll(':scope > .cas')];
    cards.forEach((c) => {
      const t = tapes[c.dataset.key] || {};
      const nm = t.name || c.dataset.name;
      const b = c.querySelector('b'); if (b) b.textContent = nm;
      c.title = nm + ' — arraste até o toca-fitas';
      if (t.color) {
        c.style.setProperty('--k1', t.color);
        c.style.setProperty('--k2', `color-mix(in srgb, ${t.color} 55%, #000)`);
        c.style.setProperty('--k3', `color-mix(in srgb, ${t.color} 50%, #fff)`);
      } else { ['--k1', '--k2', '--k3'].forEach((p) => c.style.removeProperty(p)); }
      c.classList.toggle('pinned', Boolean(t.pin));
    });
    [...cards.filter((c) => c.classList.contains('pinned')), ...cards.filter((c) => !c.classList.contains('pinned'))].forEach((c) => box.append(c));
  }
  const TAPE_PENS = [['marcador', 'Marcador'], ['esfero', 'Esferográfica'], ['lapis', 'Lápis']];
  const ed = { card: null, color: '', style: 'classico', pen: 'marcador', img: '', fresh: false };
  function drawPens() {
    const wrap = $('td-pens'); wrap.innerHTML = '';
    TAPE_PENS.forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(ed.pen === id));
      b.onclick = () => { ed.pen = id; drawPens(); };
      wrap.append(b);
    });
  }
  function drawStyles() {
    const wrap = $('td-styles'); wrap.innerHTML = '';
    TAPE_STYLES.forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(ed.style === id));
      b.onclick = () => { ed.style = id; drawStyles(); };
      wrap.append(b);
    });
  }
  function drawImgPrev() {
    const p = $('td-prev');
    p.style.backgroundImage = ed.img ? `url("${ed.img}")` : '';
    p.textContent = ed.img ? '' : 'sem imagem';
    $('td-img-del').hidden = !ed.img;
  }
  function drawWear() {
    const n = (getPlays()[ed.card?.dataset.key] || 0) * (ed.fresh ? 0 : 1);
    $('td-wear').firstChild.textContent = n ? `Usada ${n} ${n === 1 ? 'vez' : 'vezes'}. ` : 'Fita nova. ';
    $('td-fresh').hidden = !n;
  }
  // reduz a imagem (lado maior 480 px) e guarda como JPEG pequeno
  function loadImageBlob(blob) {
    if (!blob || !blob.type.startsWith('image/')) return;
    const url = URL.createObjectURL(blob), im = new Image();
    im.onload = () => {
      const k = Math.min(1, 480 / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ed.img = c.toDataURL('image/jpeg', 0.82); drawImgPrev();
      if (ed.style === 'classico') { ed.style = 'foto'; drawStyles(); }
    };
    im.onerror = () => URL.revokeObjectURL(url);
    im.src = url;
  }
  function drawSwatches() {
    const wrap = $('td-colors'); wrap.innerHTML = '';
    TAPE_COLORS.forEach(([hex, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.title = label; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', label);
      b.setAttribute('aria-checked', String(ed.color === hex));
      if (hex) b.style.background = hex; else b.className = 'auto';
      b.onclick = () => { ed.color = hex; drawSwatches(); };
      wrap.append(b);
    });
  }
  function openEditor(card) {
    const key = card.dataset.key; if (!key) return;
    const t = getTapes()[key] || {};
    ed.card = card; ed.color = t.color || ''; ed.style = t.style || 'classico'; ed.pen = t.pen || 'marcador'; ed.img = t.img || ''; ed.fresh = false;
    $('td-name').value = t.name || card.dataset.name; $('td-pin').checked = Boolean(t.pin);
    drawSwatches(); drawStyles(); drawPens(); drawImgPrev(); drawWear();
    const dlg = $('tape-dialog');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    $('td-name').focus();
  }
  function saveEditor(reset) {
    const card = ed.card; if (!card) return;
    const key = card.dataset.key, all = getTapes();
    if (reset) delete all[key];
    else {
      const name = $('td-name').value.trim();
      const t = {};
      if (name && name !== card.dataset.name) t.name = name;
      if (ed.color) t.color = ed.color;
      if (ed.style && ed.style !== 'classico') t.style = ed.style;
      if (ed.pen && ed.pen !== 'marcador') t.pen = ed.pen;
      if (ed.img) t.img = ed.img;
      if ($('td-pin').checked) t.pin = true;
      if (Object.keys(t).length) all[key] = t; else delete all[key];
    }
    if (!saveTapes(all)) { alert('Não coube no armazenamento do navegador. Use uma imagem menor ou remova a de outra fita.'); return; }
    if (ed.fresh) { const pl = getPlays(); delete pl[key]; LS.set('plays', JSON.stringify(pl)); }
    // se esta fita está no aparelho agora, atualiza o rótulo na hora
    if ($('tape-name').dataset.key === key) { $('tape-name').dataset.k = all[key]?.color || ''; $('tape-name').dataset.v = String(Date.now()); }
    const box = card.parentElement; if (box) arrangeStack(box);
    $('tape-dialog').close();
  }

  // ---------- Estante de lombadas ----------
  // As fitas ficam em pé, lado a lado, mostrando só a lombada. Passar o mouse levanta a fita
  // e mostra a capa e o nome na barra de baixo.
  function arrangeStack(box) {
    box.querySelector(':scope > .rack-info')?.remove();
    applyTapeStyles(box);
    const cards = [...box.querySelectorAll(':scope > .cas')];
    box._cards = cards;
    if (!cards.length) { box.classList.remove('rack'); return; }
    box.classList.add('rack');
    const info = document.createElement('div'); info.className = 'rack-info'; box.append(info);
    const hint = () => {
      info.innerHTML = '';
      const p = document.createElement('p'); p.className = 'rack-hint';
      p.textContent = box.classList.contains('editing') ? 'Modo personalizar: clique numa fita para mudar o nome, a cor ou fixar no começo.' : matchMedia('(hover: none)').matches
        ? 'Toque numa fita para abrir. Segure e arraste até o toca-fitas.'
        : 'Passe o mouse numa fita para ver o nome. Clique para abrir ou arraste até o toca-fitas.';
      info.append(p);
    };
    const show = (c) => {
      info.innerHTML = '';
      const src = c.querySelector('img')?.getAttribute('src');
      if (src) { const i = document.createElement('img'); i.src = src; i.alt = ''; info.append(i); }
      const t = document.createElement('div');
      const b = document.createElement('b'); b.textContent = c.querySelector('b')?.textContent || '';
      const s = document.createElement('small'); s.textContent = c.querySelector('small')?.textContent || '';
      t.append(b, s); info.append(t);
    };
    const rest = () => { const p = box.querySelector('.cas.playing'); if (p) show(p); else hint(); };
    cards.forEach((c) => {
      c.addEventListener('pointerenter', () => show(c));
      c.addEventListener('focus', () => show(c));
    });
    box.onpointerleave = rest;
    rest();
  }
  // Arrastar uma fita até o toca-fitas (mouse, caneta ou toque com o dedo pressionado)
  function makeDraggable(card, onDrop) {
    card.addEventListener('dragstart', (e) => e.preventDefault());
    card.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || card.closest('.editing')) return;
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
        const spine = Boolean(card.closest('.rack')); // da estante, a fita sai da lombada e vira um cassete inteiro
        const cw = spine ? 200 : card.offsetWidth, ch = spine ? 127 : card.offsetHeight;
        s.dx = cw / 2; s.dy = ch / 2;
        const c = card.cloneNode(true); c.classList.add('flying', 'carried');
        c.style.cssText = '';
        Object.assign(c.style, { position: 'fixed', width: cw + 'px', height: ch + 'px', margin: 0, fontSize: spine ? '13px' : '' });
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

  // ---------- Caixinha de plástico ----------
  function closeCase(now) {
    const p = $('jewel-pop'); if (!p) return;
    if (now) { p.remove(); return; }
    p.classList.add('leaving'); setTimeout(() => p.remove(), 450);
  }
  function openCase(card, go) {
    closeCase(true);
    const name = card.querySelector('b').textContent, sub = card.querySelector('small')?.textContent || '';
    const t = getTapes()[card.dataset.key] || {};
    const img = t.img || card.querySelector('img')?.getAttribute('src') || '';
    const pop = document.createElement('div'); pop.id = 'jewel-pop'; pop.className = 'jewel-pop';
    const box = document.createElement('div'); box.className = 'jewel'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Caixinha da fita ' + name);
    box.style.cssText = card.style.cssText;
    const cs = document.createElement('div'); cs.className = 'jw-case';
    // fita dentro da caixa (a mesma cartela, com as cores personalizadas)
    const tp = card.cloneNode(true); tp.classList.remove('playing', 'lifted', 'carried', 'flying'); tp.classList.add('jw-tape');
    tp.removeAttribute('style'); tp.style.cssText = card.style.cssText; tp.title = 'Colocar no toca-fitas';
    tp.onclick = () => { go(tp); closeCase(); };
    // tampa transparente com o encarte (capa e nome) preso nela
    const lid = document.createElement('div'); lid.className = 'jw-lid';
    const face = document.createElement('div'); face.className = 'jw-face';
    if (img) face.style.backgroundImage = 'url(' + JSON.stringify(img) + ')'; else face.classList.add('ph');
    const ttl = document.createElement('div'); ttl.className = 'jw-ttl';
    const b = document.createElement('b'); b.textContent = name; const s = document.createElement('small'); s.textContent = sub;
    ttl.append(b, s); face.append(ttl);
    const back = document.createElement('div'); back.className = 'jw-back';
    lid.append(face, back);
    lid.onclick = () => lid.classList.toggle('open');
    cs.append(tp, lid);
    const hint = document.createElement('p'); hint.className = 'jw-hint'; hint.textContent = 'Clique na fita para colocar no toca-fitas. Clique na tampa para abrir ou fechar.';
    const x = document.createElement('button'); x.type = 'button'; x.className = 'jw-close'; x.setAttribute('aria-label', 'Fechar'); x.textContent = '×'; x.onclick = () => closeCase();
    box.append(cs, hint); pop.append(box, x);
    pop.addEventListener('pointerdown', (e) => { if (e.target === pop) closeCase(); });
    document.body.append(pop);
    setTimeout(() => lid.classList.add('open'), 140);
    tp.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCase(); });

  function casCard({ img, name, sub, uri, key, onclick, onDrop }) {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'cas'; c.title = name + ' — arraste até o toca-fitas';
    if (uri) c.dataset.uri = uri;
    c.dataset.key = key || uri || ''; c.dataset.name = name;
    const cl = document.createElement('span'); cl.className = 'cl';
    if (img) { const i = document.createElement('img'); i.src = img; i.alt = ''; cl.append(i); }
    else { const ph = document.createElement('span'); ph.className = 'ph'; ph.innerHTML = '<svg aria-hidden="true"><use href="#i-note"/></svg>'; cl.append(ph); }
    const t = document.createElement('span'); t.className = 'ct';
    const b = document.createElement('b'); b.textContent = name;
    const s = document.createElement('small'); s.textContent = sub || '';
    t.append(b, s); cl.append(t);
    const w = document.createElement('span'); w.className = 'cw'; w.setAttribute('aria-hidden', 'true');
    w.innerHTML = '<i></i><i></i>';
    c.append(cl, w);
    c.onclick = () => {
      if (c._dragged) return;
      if (c.closest('.editing')) { openEditor(c); return; } // modo personalizar: abre o editor em vez de tocar
      // na estante, clicar na lombada abre a caixinha com a fita dentro; clicar na fita é que coloca no aparelho
      if (c.closest('.rack')) { openCase(c, (from) => { insertTape(c.querySelector('b').textContent, from, c.dataset.key); onclick(); }); return; }
      insertTape(c.querySelector('b').textContent, c, c.dataset.key); onclick();
    };
    // Soltar no toca-fitas toca a fita (a playlist inteira, ou só a música)
    makeDraggable(c, () => { insertTape(c.querySelector('b').textContent, null, c.dataset.key); (onDrop || onclick)(); });
    return c;
  }

  // Coloca a fita no toca-fitas: voa da prateleira até o compartimento e desliza para dentro
  let lastTape = null, ejectedAt = 0;
  function insertTape(name, from, key, colorOverride, again) {
    const tape = document.querySelector('.tape');
    ejected = false;
    $('tape-name').textContent = name;
    $('tape-name').dataset.k = colorOverride ?? ((key && getTapes()[key]?.color) || '');
    $('tape-name').dataset.key = key || ''; $('tape-name').dataset.v = String(Date.now());
    if (key && !again) { const pl = getPlays(); pl[key] = (pl[key] || 0) + 1; LS.set('plays', JSON.stringify(pl)); }
    lastTape = { name, color: $('tape-name').dataset.k, key: key || '' };
    tape.classList.remove('empty', 'ejecting');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const slideIn = () => { tape.classList.remove('inserting'); void tape.offsetWidth; tape.classList.add('inserting'); };
    if (reduce) return;
    const fly = () => {
      if (!from) { slideIn(); return; }
      let a = from.getBoundingClientRect(); const b = tape.getBoundingClientRect();
      const spine = Boolean(from.closest('.rack'));
      if (spine) a = { left: a.left + a.width / 2 - 100, top: a.top + a.height / 2 - 63, width: 200, height: 127 };
      const visible = b.top >= 0 && b.bottom <= innerHeight && b.width > 0;
      if (!from || !visible || a.width === 0) {
        tape.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(slideIn, 400);
        return;
      }
      const c = from.cloneNode(true); c.classList.add('flying'); c.style.cssText = '';
      Object.assign(c.style, { position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: 0, fontSize: spine ? '13px' : '', transition: 'all .5s cubic-bezier(.4,.1,.2,1)' });
      document.body.append(c);
      tape.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        Object.assign(c.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px', opacity: '.2' });
      }));
      setTimeout(() => { c.remove(); tape.style.opacity = ''; slideIn(); }, 500);
    };
    // A fita só entra se a frente do toca-fitas estiver virada para você
    if (!facingFront()) { rotateFront(500); setTimeout(fly, 540); } else fly();
  }

  // Tocar de novo depois de ejetar: a mesma fita volta para o compartimento
  function reinsertTape() {
    if (!ejected) return;
    const t = lastTape || { name: $('title').textContent, color: '' };
    insertTape(t.name, null, t.key, t.color, true);
  }

  // Pausa de verdade: pede ao player, depois confere no Spotify e repete se o aparelho ativo ainda estiver tocando
  // (o comando do player só alcança este navegador; a música pode estar em outro aparelho).
  async function pauseHard() {
    try { await player?.pause(); } catch { /* segue para a API */ }
    let target = deviceId;
    for (let i = 0; i < 3; i++) {
      try { await api('/me/player/pause' + (target ? '?device_id=' + target : ''), { method: 'PUT' }); } catch { /* tenta de novo */ }
      await new Promise((r) => setTimeout(r, 700));
      try {
        const d = await api('/me/player');
        if (!d || !d.is_playing) break;
        if (d.device?.id) target = d.device.id; // o aparelho que está tocando de fato
      } catch { break; }
    }
    if (remote) pollRemote();
  }

  // Ejetar: a fita sai do compartimento e a prateleira volta
  function ejectTape() {
    const tape = document.querySelector('.tape');
    // guarda a fita que está no aparelho, para colocar de volta quando o play for apertado
    const cur = $('tape-name').textContent;
    lastTape = { name: cur && cur !== 'Sem fita' ? cur : $('title').textContent, color: $('tape-name').dataset.k || '', key: $('tape-name').dataset.key || '' };
    ejected = true; ejectedAt = Date.now();
    pauseHard();
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
    list.innerHTML = ''; list.classList.remove('stack', 'rack');
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
      const list = $('lib-list'); list.innerHTML = ''; list.classList.remove('stack', 'rack');
      list.append(casCard({ name: 'Músicas curtidas', sub: 'Sua biblioteca', key: 'liked', onclick: openLiked, onDrop: playLiked }));
      items.forEach((p) => {
        const total = p.tracks?.total ?? p.items?.total;
        list.append(casCard({
          img: p.images?.[0]?.url, name: p.name, key: p.uri,
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
    const list = $('lib-list'); list.innerHTML = ''; list.classList.remove('stack', 'rack');
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
      if (blocked) setLibHeader(p.name, { back: true, play: () => { insertTape(p.name, null, p.uri); playTrack(null, { context: p.uri }); } });
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
    $('lib-edit').onclick = () => {
      const on = $('lib-edit').getAttribute('aria-pressed') !== 'true';
      $('lib-edit').setAttribute('aria-pressed', String(on)); $('lib-edit').textContent = on ? 'Concluir' : 'Personalizar';
      [$('lib-list'), $('results')].forEach((b) => { b.classList.toggle('editing', on); if (b._cards?.length) arrangeStack(b); });
    };
    $('tape-form').onsubmit = (e) => { e.preventDefault(); saveEditor(false); };
    $('td-cancel').onclick = () => $('tape-dialog').close();
    $('td-reset').onclick = () => saveEditor(true);
    $('td-file').onchange = (e) => { loadImageBlob(e.target.files[0]); e.target.value = ''; };
    $('td-img-del').onclick = () => { ed.img = ''; drawImgPrev(); };
    $('td-fresh').onclick = () => { ed.fresh = true; drawWear(); };
    $('tape-dialog').addEventListener('paste', (e) => {
      const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (it) { e.preventDefault(); loadImageBlob(it.getAsFile()); }
    });

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
    $('btn-play').onclick = () => { reinsertTape(); player?.resume(); };
    $('btn-pause').onclick = () => player?.pause();
    $('btn-eject').onclick = ejectTape;
    $('btn-prev').onclick = () => player?.previousTrack();
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
      if (e.key === ' ' && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); reinsertTape(); player.togglePlay(); }
      else if (e.key === 'ArrowRight' && state) { e.preventDefault(); player.seek(Math.min(state.duration, state.position + (Date.now() - state.updateTime) * (state.paused ? 0 : 1) + 5000)); }
      else if (e.key === 'ArrowLeft' && state) { e.preventDefault(); player.seek(Math.max(0, state.position + (Date.now() - state.updateTime) * (state.paused ? 0 : 1) - 5000)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setVolumeUi(Math.min(100, Number($('vol').value) + 5)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setVolumeUi(Math.max(0, Number($('vol').value) - 5)); }
    });
  }
  init();
})();
