// Guarda a casca do app para abrir rápido e funcionar como app instalado.
// A API e o login do Spotify nunca passam pelo cache.
const CACHE = 'meu-player-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'deck3d.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // Spotify, fontes e SDK vão direto à rede
  if (url.searchParams.has('code')) return; // volta do login
  // Rede primeiro (sempre pega a versão nova); sem rede, usa o que está guardado
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('index.html'))),
  );
});
