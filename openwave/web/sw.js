// Caches the app shell and artwork so OpenWave opens and shows your library with no connection.
// Downloaded songs live in IndexedDB (see js/offline.js); live streams are never cached here.
const VERSION = 'openwave-v15';
const IMAGES = 'openwave-img-v1';
const MAX_IMAGES = 600;
const SHELL = [
  '/', '/index.html', '/css/app.css', '/js/app.js', '/js/api.js', '/js/player.js', '/js/store.js', '/js/ui.js',
  '/js/views.js', '/js/offline.js', '/js/profiles.js', '/js/importer.js', '/js/insights.js', '/js/native.js', '/js/update.js', '/js/gestures.js', '/js/link.js',
  '/icons/logo-mark-64.png', '/icons/logo-mark-128.png', '/icons/favicon-64.png', '/icons/icon-192.png', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so an update never re-caches old files.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMAGES).map((k) => caches.delete(k))))
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
    return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('/index.html')) || Response.error();
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

async function cacheFirstImage(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
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
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api/img') return e.respondWith(cacheFirstImage(e.request));
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(networkFirst(e.request));
});
