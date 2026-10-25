// Bridge to the native apps. The macOS app (WKWebView) exposes window.webkit.messageHandlers.openwave;
// the Android app exposes window.OpenWaveAndroid. Both call back into window.openwaveNative.

import { img } from './api.js';
import { store } from './store.js';
import { player } from './player.js';

const mac = window.webkit?.messageHandlers?.openwave;
const android = window.OpenWaveAndroid;
export const isNative = !!(mac || android);
export const isAndroid = !!android;

/** A short buzz of the phone's vibration motor for likes, long-presses and swipes (Android app). */
export function haptic(kind = 'light') {
  try { android?.haptic?.(kind); } catch { /* an older app without haptics */ }
}

/** Bring the app's window forward when something needs an answer (the Mac app). */
export function attention() {
  try { mac?.postMessage({ type: 'attention' }); } catch { /* app closing */ }
}

/** The system share sheet for a link or text: Android app, or browsers that support it. */
export async function shareText(title, text, url = '') {
  if (android?.shareText) { android.shareText(title, url ? `${text}\n${url}` : text); return true; }
  if (navigator.share && !mac) {
    try { await navigator.share(url ? { title, text, url } : { title, text }); return true; } catch (e) { return e.name === 'AbortError'; }
  }
  return false;
}

/** Hand a file to the Android share sheet (WebView can't download blobs). Returns false elsewhere. */
export async function shareFile(name, blob) {
  if (!android) return false;
  const base64 = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(blob);
  });
  android.shareFile(name, blob.type || 'application/octet-stream', base64);
  return true;
}

export function initNative(commands) {
  if (!isNative) return;
  document.documentElement.classList.add('native-app', mac ? 'native-mac-app' : 'native-android');
  const send = (msg) => {
    try { if (mac) mac.postMessage(msg); else android.postMessage(JSON.stringify(msg)); } catch { /* app closing */ }
  };

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
    back: () => !!commands.back?.(), // Android back button: true when the app handled it
    state,
  };
  send({ type: 'ready', settings: store.settings });
  nowPlaying();
}
