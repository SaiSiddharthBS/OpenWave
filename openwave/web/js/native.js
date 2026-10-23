// Bridge to the native OpenWave macOS app. Inside the app, WKWebView exposes
// window.webkit.messageHandlers.openwave; the app calls back into window.openwaveNative.

import { img } from './api.js';
import { store } from './store.js';
import { player } from './player.js';

const bridge = window.webkit?.messageHandlers?.openwave;
export const isNative = !!bridge;

export function initNative(commands) {
  if (!bridge) return;
  document.documentElement.classList.add('native-app');
  const send = (msg) => { try { bridge.postMessage(msg); } catch { /* app closing */ } };

  const state = () => {
    const t = player.current;
    return t ? {
      videoId: t.videoId,
      title: t.title,
      artist: t.artists.map((a) => a.name).join(', '),
      album: t.album?.name || '',
      artwork: new URL(img(t.thumbnail, 600), location.href).href,
      duration: player.duration || 0,
      position: player.time || 0,
      playing: player.loaded && !player.paused,
      liked: store.isLiked(t.videoId),
      shuffle: player.shuffle,
      repeat: player.repeat,
    } : null;
  };
  const nowPlaying = () => send({ type: 'nowPlaying', track: state() });

  let lastTime = 0;
  player.addEventListener('track', () => { nowPlaying(); const s = state(); if (s) send({ type: 'trackChanged', track: s }); });
  player.addEventListener('state', nowPlaying);
  player.addEventListener('time', () => {
    if (Date.now() - lastTime > 5000) { lastTime = Date.now(); nowPlaying(); }
  });
  store.on((what) => { if (what === 'liked' || what === 'all') nowPlaying(); if (what === 'settings') send({ type: 'settings', settings: store.settings }); });

  window.openwaveNative = {
    command(name, arg) {
      const fn = commands[name];
      if (fn) fn(arg);
      nowPlaying();
    },
    state,
  };
  send({ type: 'ready', settings: store.settings });
  nowPlaying();
}
