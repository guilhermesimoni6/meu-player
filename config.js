// Client ID do app em developer.spotify.com/dashboard
// (nao use o Client Secret: o login usa PKCE e nao precisa dele)
const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname);
window.PLAYER_CONFIG = {
  clientId: 'a09315089cf54f3380e522e128f205dd',
  // No computador: http://127.0.0.1:5173/callback. Publicado: o proprio endereco do player
  // (ex.: https://usuario.github.io/meu-player/). Cada um precisa estar cadastrado no painel do Spotify.
  redirectUri: LOCAL ? 'http://127.0.0.1:5173/callback' : location.origin + location.pathname,
  deviceName: 'Meu Player',
};
