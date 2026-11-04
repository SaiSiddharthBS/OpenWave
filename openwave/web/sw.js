// Caches the app shell and artwork so OpenWave opens and shows your library with no connection.
// Downloaded songs live in IndexedDB (see js/offline.js); live streams are never cached here.
// Paths are relative to this file: an engine serves it at /, the OpenWave website below /app/.
const BASE = new URL('./', self.location.href).pathname;
// Copies of the app at different paths of one site (the website's /app/ and /app-next/) keep
// separate caches, so updating one never empties the other's.
const SCOPE = BASE === '/' ? '' : `@${BASE}`;
const VERSION = `openwave-v25${SCOPE}`;
const IMAGES = `openwave-img-v1${SCOPE}`;
const MAX_IMAGES = 600;
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/boot.js', 'js/remote.js', 'js/app.js', 'js/api.js', 'js/player.js', 'js/store.js', 'js/ui.js',
  'js/views.js', 'js/offline.js', 'js/profiles.js', 'js/importer.js', 'js/insights.js', 'js/native.js', 'js/update.js', 'js/gestures.js', 'js/link.js', 'js/sharing.js',
  'js/phones.js', 'js/nav.js', 'js/glass.js', 'js/connect.js', 'js/vendor/secp256k1.js', 'js/vendor/qrcode.js',
  'icons/logo-mark-64.png', 'icons/logo-mark-128.png', 'icons/favicon-64.png', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];
const INDEX = new URL('index.html', self.location.href).href;
// The website copy of the app (?mode=connect) gets artwork through the page's connection to the
// computer at home (js/remote.js), since there's no engine at this address.
const REMOTE = new URL(self.location.href).searchParams.get('mode') === 'connect';

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so an update never re-caches old files.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMAGES && (SCOPE ? k.endsWith(SCOPE) : !k.includes('@')))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Give up on the network quickly when the server is unreachable (e.g. phone away from home Wi-Fi).
function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

// The engine on this same device (the Android and desktop apps) is always reachable, just slow
// while it starts; timing out there would show old cached screens right after an update.
const LOCAL = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

async function networkFirst(req) {
  try {
    const fresh = fetch(req, { cache: 'no-cache' });
    const res = await (LOCAL ? fresh : Promise.race([fresh, timeout(4000)]));
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || (await caches.match(INDEX)) || Response.error();
  }
}

async function trimImages() {
  const cache = await caches.open(IMAGES);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_IMAGES))) await cache.delete(k);
}

// The same artwork is requested at several sizes; offline, any cached size will do.
const baseImage = (u) => (new URL(u).searchParams.get('u') || '').replace(/=w\d+-h\d+/, '');

async function anySizeOf(req) {
  const want = baseImage(req.url);
  const cache = await caches.open(IMAGES);
  for (const key of await cache.keys()) {
    if (baseImage(key.url) === want) return cache.match(key);
  }
  return null;
}

/** Ask the page that wants this to fetch it over its connection to the computer at home. */
async function viaPage(e, path) {
  const client = (e.clientId && await self.clients.get(e.clientId)) || (await self.clients.matchAll({ type: 'window' }))[0];
  if (!client) throw new Error('no page to ask');
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new Error('timeout')), 30000);
    ch.port1.onmessage = ({ data }) => {
      clearTimeout(t);
      if (data.error) reject(new Error(data.error));
      else resolve(new Response(data.body, { status: data.status, headers: data.headers }));
    };
    client.postMessage({ type: 'openwave:fetch', path }, [ch.port2]);
  });
}

async function cacheFirstImage(e, path) {
  const req = e.request;
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await (REMOTE ? viaPage(e, path) : fetch(req));
    if (res.ok) {
      const copy = res.clone();
      caches.open(IMAGES).then((c) => c.put(req, copy)).then(trimImages);
    }
    return res;
  } catch {
    return (await anySizeOf(req)) || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);
  if (rel === 'api/img') return e.respondWith(cacheFirstImage(e, '/api/img' + url.search));
  if (rel.startsWith('api/')) return;
  e.respondWith(networkFirst(e.request));
});
