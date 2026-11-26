# Meu Player

Player de Spotify em página estática (sem servidor, sem build): toca-fitas 3D de verdade em WebGL, fitas em estante de
lombadas, modo controle remoto e PWA. Exige Spotify Premium.

- Publicado em: https://guilhermesimoni6.github.io/meu-player/ (GitHub Pages, branch `main`)
- Repositório: https://github.com/guilhermesimoni6/meu-player

## Rodar no computador

```powershell
git clone https://github.com/guilhermesimoni6/meu-player.git
cd meu-player
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Abra http://127.0.0.1:5173/ (precisa ser `127.0.0.1`, não `localhost`, por causa do login do Spotify).

## Spotify (já configurado)

- Client ID em `config.js` (login por PKCE, não usa Client Secret).
- Redirect URIs cadastrados no painel do Spotify: `http://127.0.0.1:5173/callback` e
  `https://guilhermesimoni6.github.io/meu-player/`.
- App em modo de desenvolvimento: só entram as contas listadas em *User Management* (limite de 25).
- Neste modo não dá para listar as faixas de playlists de outras pessoas, mas tocar a playlist inteira funciona.

## Arquivos

| Arquivo | Para que serve |
| --- | --- |
| `index.html` | Página, cabeçalho, estante, janela de personalizar. Os controles reais ficam escondidos em `.legacy`. |
| `app.js` | Login (PKCE), API do Spotify, player (SDK ou controle remoto), estante de fitas, personalizar fitas. |
| `deck3d.js` | Toca-fitas em Three.js: modelo, câmera, zoom, giro, cliques, fita e cabeçote animados, medidores VU de ponteiro, acabamentos (cor e madeira). |
| `sound.js` | Sons mecânicos gerados com Web Audio (`window.Sfx`). |
| `style.css` | Visual da página, estante e janelas. O toca-fitas em si é desenhado no WebGL. |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA (instalar no iPhone). |
| `serve.ps1` | Servidor local mínimo. |

## Como as peças conversam

- O `deck3d.js` **lê o estado** dos elementos escondidos (`#title`, `#t-cur`, `#btn-play[data-state]`, classes de `.tape`…)
  e **aciona os controles** com `.click()` ou eventos `input`/`change` em `#vol` e `#seek`. O `app.js` não conhece o 3D,
  só chama `window.Deck3D.facingFront()` e `rotateFront()`.
- `.door` e `.tape` (dentro de `.boombox`) são só marcadores de posição: o `deck3d.js` os move para onde o compartimento
  aparece na tela, para o arrastar-e-soltar das fitas e a animação de voo funcionarem.
- A tela 3D cobre a janela inteira (`position: fixed`) e os gestos são ouvidos na página toda, mas só valem quando
  começam no fundo (`isStage`).
- Guardado no navegador (localStorage): `finish` (cor do toca-fitas), `sfx` (sons), `tapes` (nome, cor e fixadas das fitas),
  e os tokens do Spotify.

## Publicar uma mudança (importante)

```powershell
git add -A
git commit -m "o que mudou"
git push origin main
```

O GitHub Pages leva cerca de 1 minuto. Para o navegador não usar arquivos antigos em cache, **sempre que mudar
`style.css`, `app.js`, `deck3d.js`, `sound.js` ou `config.js`**, suba o número `?v=N` deles no `index.html`
(e o `CACHE` no `sw.js` se mudar a lista de arquivos). Depois, Ctrl+Shift+R.

## Ideias que ficaram para depois

- Zoom com dois dedos no celular (hoje só roda do mouse e pinça do trackpad).
- Modo quiosque para Raspberry Pi (tela cheia, cursor escondido, tela sempre acesa).
- Campo para colar link de playlist e tocar.
- Fila de próximas músicas como pilha de fitas.
- Ligar o 3D direto às funções do `app.js`, sem os controles escondidos.
