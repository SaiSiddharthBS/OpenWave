// OpenWave on the website (remote mode): the same app, playing from a computer at home through
// OpenWave Connect (see connect.js). Engine-served copies of the app never run any of this.
//
// boot() runs before the app: it pairs this phone (from the QR code's link, or a pasted one),
// offers "Add to Home Screen" on iPhone, and then routes every /api/ request over the connection,
// so the rest of the app works unchanged. Songs are fetched whole and played from memory (the next
// one is fetched while the current one plays), which keeps playback going with the screen locked.
// Artwork goes through the connection too (the service worker asks this page for it), so the
// phone never contacts Google directly, just as at home.

export const REMOTE = document.querySelector('meta[name="openwave-mode"]')?.content === 'connect';

const KEY = 'openwave:connect';
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

let mod = null;         // connect.js, loaded only in remote mode
let device = null;
let link = null;
let opening = null;
let hiddenAt = 0;
let state = { status: 'idle', message: '' };
const listeners = new Set();
const realFetch = window.fetch.bind(window);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

function save(d) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* private browsing: works until closed */ }
}

/** The computer this phone plays from, e.g. for Settings. */
export function computer() {
  return device && { name: device.name, paired: !!device.paired };
}

export function status() { return state; }

export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setStatus(status, message = '') {
  state = { status, message };
  for (const fn of listeners) fn(state);
  renderStatus();
}

/** Unpair this phone and start over (the computer can also remove it in Settings → Phones). */
export async function forget() {
  if (link?.open) {
    try { await Promise.race([connectFetch('/api/connect/me/remove', { method: 'POST' }), sleep(3000)]); } catch { /* offline: the computer keeps it until removed there */ }
  }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('openwave:')) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
  link?.close();
  location.replace(location.pathname);
}

// ------------------------------------------------------------------ connection

function ensure() {
  if (link?.open) return Promise.resolve(link);
  opening ??= open().finally(() => { opening = null; });
  return opening;
}

async function open() {
  setStatus('connecting');
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const l = await mod.connect(device, { onPaired: save, log: (m) => console.debug('[connect]', m) });
      save(device);
      link = l;
      l.onclose = lost;
      if (l.api < 1) {
        setStatus('outdated', `Update OpenWave on ${device.name} to use it from this phone.`);
      } else {
        setStatus('online');
      }
      return l;
    } catch (e) {
      last = e;
      if (e.code !== 'no-path') break;          // no answer or no internet: retrying now won't help
      await sleep(1500 * attempt);
    }
  }
  setStatus('offline', last?.message || 'Couldn’t connect.');
  throw last;
}

function lost() {
  link = null;
  if (document.visibilityState === 'visible') {
    setStatus('connecting');
    setTimeout(() => ensure().catch(() => {}), 300);
  }
}

/** After the phone wakes up or changes networks the old connection may be dead: check, then
 * reconnect, before the app's next request has to wait for a timeout. */
async function revive() {
  if (!device?.paired && !device?.ticket) return;
  if (link?.open && (await link.ping(2500))) return;
  link?.close();
  link = null;
  ensure().catch(() => {});
}

function apiPath(url) {
  if (url.origin !== location.origin) return null;
  if (url.pathname.startsWith('/api/')) return url.pathname + url.search;
  const base = new URL('.', location.href).pathname;
  if (url.pathname.startsWith(base + 'api/')) return '/' + url.pathname.slice(base.length) + url.search;
  return null;
}

/** fetch() for /api/ goes over the connection; it fails like a network error when there's none. */
async function connectFetch(input, init = {}) {
  const req = input instanceof Request ? input : null;
  const path = apiPath(new URL(req ? req.url : String(input), location.href));
  if (!path) return realFetch(input, init);
  const method = (init.method || req?.method || 'GET').toUpperCase();
  const headers = Object.fromEntries(new Headers(init.headers || req?.headers || {}));
  headers['user-agent'] ??= navigator.userAgent;
  let body = init.body ?? null;
  if (body != null && typeof body !== 'string') body = await new Response(body).text();
  for (let attempt = 0; ; attempt++) {
    let l;
    try {
      l = await ensure();
    } catch (e) {
      throw new TypeError(e.message || 'Not connected');
    }
    try {
      return await l.fetch(path, { method, headers, body, signal: init.signal || req?.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e.code === 'lost' && attempt === 0) continue;      // the connection dropped: once more on a new one
      throw new TypeError(e.message || 'Network error');
    }
  }
}

// ------------------------------------------------------------------ songs

const songs = new Map();     // "videoId?query" -> Promise<Blob>, the last few

function songBlob(videoId, query) {
  const key = `${videoId}?${query}`;
  if (!songs.has(key)) {
    const p = (async () => {
      const r = await window.fetch(`/api/download/${encodeURIComponent(videoId)}?${query}`);
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      return new Blob([await r.arrayBuffer()], { type: r.headers.get('content-type') || 'audio/mp4' });
    })();
    p.catch(() => songs.delete(key));
    songs.set(key, p);
    while (songs.size > 4) songs.delete(songs.keys().next().value);
  }
  return songs.get(key);
}

/** An object URL for the whole song (the player revokes it when it's done with it). */
export async function songUrl(videoId, query) {
  return URL.createObjectURL(await songBlob(videoId, query));
}

/** Start fetching a song that's about to play. */
export function preloadSong(videoId, query) {
  songBlob(videoId, query).catch(() => {});
}

// ------------------------------------------------------------------ screens

function screen(html) {
  let el = document.getElementById('connect-screen');
  if (!el) {
    el = document.createElement('section');
    el.id = 'connect-screen';
    el.className = 'connect-screen';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="connect-card"><img class="connect-logo" src="icons/logo-mark-128.png" alt=""><div>${html}</div></div>`;
  el.hidden = false;
  return el;
}

function closeScreen() {
  document.getElementById('connect-screen')?.remove();
}

/** No pairing yet: explain where the code comes from, or take a pasted link. */
function pairScreen(error = '') {
  return new Promise((resolve) => {
    const el = screen(`
      <h1>Play from your computer</h1>
      <p>OpenWave on this phone plays from OpenWave on a computer at home, with the same profiles and playlists, wherever you are.</p>
      <ol class="connect-steps">
        <li>On the computer, open <b>OpenWave → Settings → Phones</b> and choose <b>Add a phone</b>.</li>
        <li>${window.OpenWaveAndroid ? 'Point this phone’s camera at the code, then share the link to OpenWave, or copy it.' : 'Point this phone’s camera at the code and open the link.'}</li>
      </ol>
      <form class="connect-paste">
        <label for="connect-link">Or paste the link here</label>
        <textarea id="connect-link" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…#connect=…"></textarea>
        <p class="connect-error" ${error ? '' : 'hidden'}>${esc(error)}</p>
        <button class="btn primary" type="submit">Connect</button>
      </form>
      ${window.OpenWaveAndroid ? '<button class="btn connect-local" type="button" data-local>Use this phone instead</button>' : ''}`);
    el.querySelector('[data-local]')?.addEventListener('click', () => window.OpenWaveAndroid.setServer(''));
    el.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const err = el.querySelector('.connect-error');
      try {
        const p = mod.parsePairing(el.querySelector('textarea').value);
        device = mod.newDevice(p);
        save(device);
        resolve();
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
    };
  });
}

/** Opened from the QR code in Safari: suggest adding OpenWave to the Home Screen first. The
 * address still holds the pairing code here, so the Home Screen copy is paired too. */
function homeScreenStep() {
  return new Promise((resolve) => {
    const el = screen(`
      <h1>Add OpenWave to your Home Screen</h1>
      <p>It opens like an app, keeps playing with the screen locked, and shows controls on the Lock Screen.</p>
      <ol class="connect-steps">
        <li>Tap <b>Share</b> <svg class="connect-share" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-share"/></svg> in Safari’s toolbar.</li>
        <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open <b>OpenWave</b> from your Home Screen.</li>
      </ol>
      <p class="connect-note">The code works for 15 minutes, so do this now.</p>
      <div class="btn-row"><button class="btn" data-continue>Use it in Safari instead</button></div>`);
    el.querySelector('[data-continue]').onclick = resolve;
  });
}

function renderStatus() {
  let el = document.getElementById('connect-status');
  const show = ['connecting', 'offline', 'outdated'].includes(state.status) && !document.getElementById('connect-screen');
  if (!show) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'connect-status';
    el.className = 'connect-status';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  const name = esc(device?.name || 'your computer');
  el.dataset.state = state.status;
  el.innerHTML = state.status === 'connecting'
    ? `<span class="connect-spin" aria-hidden="true"></span><span class="ellipsis">Connecting to ${name}…</span>`
    : `<span class="connect-msg">${esc(state.message)}</span>${state.status === 'offline' ? '<button class="btn" data-retry>Try again</button>' : ''}`;
  el.querySelector('[data-retry]')?.addEventListener('click', () => ensure().catch(() => {}));
}

// ------------------------------------------------------------------ service worker bridge

function bridge() {
  navigator.serviceWorker?.addEventListener('message', async (e) => {
    if (e.data?.type !== 'openwave:fetch' || !e.ports[0]) return;
    const port = e.ports[0];
    try {
      const r = await window.fetch(e.data.path);
      const body = await r.arrayBuffer();
      port.postMessage({ status: r.status, headers: Object.fromEntries(r.headers), body }, [body]);
    } catch (err) {
      port.postMessage({ error: String(err?.message || err) });
    }
  });
}

async function serviceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register('sw.js?mode=connect');
    if (navigator.serviceWorker.controller) return;
    // First visit: wait (briefly) for the worker to take over, so artwork comes through it.
    await Promise.race([new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })), sleep(4000)]);
  } catch (e) {
    console.warn('service worker', e);
  }
}

// ------------------------------------------------------------------ start

/** Use the pairing code in a link's #connect=…; throws if the link is incomplete. */
function adopt(hash) {
  const p = mod.parsePairing(hash);
  if (device?.host === p.host && device.paired) {
    Object.assign(device, { ticket: p.ticket, relays: p.relays });   // re-pair if this phone was removed
  } else {
    device = mod.newDevice(p);
  }
  save(device);
}

export async function boot() {
  document.documentElement.classList.add('remote-mode');
  mod = await import('./connect.js');
  // A pairing link opened while OpenWave is already open (shared to the Android app, or a browser
  // tab that has it) only changes the part after the #, which doesn't load the page again: take
  // the code from it, then start over with it.
  window.addEventListener('hashchange', (e) => {
    const next = new URL(e.newURL).hash;
    if (!next.includes('connect=')) return;
    try { adopt(next); } catch { return; }
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  });
  device = load();
  const hash = location.hash;
  let fresh = false;
  if (hash.includes('connect=')) {
    try {
      adopt(hash);
      fresh = true;
    } catch {
      await pairScreen('That link isn’t complete. Scan the code again, or paste the whole link.');
    }
  }
  if (!device) await pairScreen();
  if (fresh && IOS && !STANDALONE) await homeScreenStep();
  if (hash.includes('connect=')) history.replaceState(null, '', location.pathname + location.search + '#/home');
  closeScreen();

  window.fetch = connectFetch;
  bridge();
  await serviceWorker();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (Date.now() - hiddenAt > 15000 || !link?.open) revive();
  });
  window.addEventListener('online', () => revive());
  ensure().catch(() => {});
}
