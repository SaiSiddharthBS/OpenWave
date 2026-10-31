// Layout audit: opens every screen of the web UI at phone, tablet and desktop sizes, with
// realistic and deliberately long song, artist and playlist names, and fails if anything is
// pushed past the edge of the screen (text, artwork, times, buttons).
//
//   node tests/ui/layout_audit.mjs            # needs Chrome and the engine's Python
//
// Environment: OPENWAVE_PYTHON (default: .venv/bin/python, else python3), CHROME (path to
// Chrome/Chromium), AUDIT_OUT (folder for screenshots of failures; default: a temp folder),
// AUDIT_ALL=1 (save a screenshot of every screen, to look over by eye), AUDIT_ONLY (comma-separated
// sizes and/or data sets to run, e.g. "phone-360,realistic").
// No network is needed: YouTube answers are replaced with made-up data, and the library
// (profiles, likes, playlists, history) runs on a real engine with a throwaway data folder.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ made-up catalogue data

const DATASETS = {
  // Lengths and shapes seen on YouTube Music: soundtrack tags, four credited artists, Devanagari.
  realistic: {
    titles: ['Gehra Hua (From "Dhurandhar")', 'Sheila Ki Jawani (From "Tees Maar Khan")', 'आईने के सौ टुकड़े करके हमने देखे हैं',
      'Tum Hi Ho (From "Aashiqui 2") [Full Song]', 'Kesariya (From "Brahmastra") - Arijit Singh Version', 'Chaleya'],
    artists: ['Shashwat Sachdev', 'Arijit Singh', 'Armaan Khan', 'Irshad Kamil', 'Vishal & Shekhar', 'Sunidhi Chauhan'],
    album: 'Dhurandhar (Original Motion Picture Soundtrack)',
    playlist: 'Bollywood Romance: 90s, 2000s and Today’s Biggest Love Songs',
    artist: 'Shankar-Ehsaan-Loy',
    profile: 'Maya',
  },
  // Far past anything common, including a long unbroken word, to find the breaking point.
  extreme: {
    titles: ['The Longest Song Title You Will Ever See On A Phone Screen (Extended Club Remix) [Official Lyric Video HD 4K]',
      'Supercalifragilisticexpialidocious_Remastered2026', 'आईने के सौ टुकड़े करके हमने देखे हैं, तुम्हारे बिना ये दिल कहीं नहीं लगता (Unplugged Version)'],
    artists: ['An Artist With A Remarkably Long Stage Name', 'The Philharmonic Orchestra of Somewhere Far Away', 'DJ Featuring Everybody'],
    album: 'An Album Title That Goes On And On Because The Deluxe Edition Added Seven Bonus Tracks (Remastered)',
    playlist: 'A Playlist Name That Is Exactly One Hundred Characters Long, Which Is The Longest Name OpenWave Keeps',
    artist: 'The Artist Formerly Known As An Extremely Long Name',
    profile: 'Maximilian Alexander',
  },
};

const vid = (n) => `vid${String(n).padStart(8, '0')}`;           // 11 characters, like a real video id
const THUMB = 'https://lh3.googleusercontent.com/audit=w544-h544';

function catalogue(d) {
  const artists = (n) => Array.from({ length: 1 + (n % 4) }, (_, k) => ({ name: d.artists[(n + k) % d.artists.length], id: `UCaudit${(n + k) % d.artists.length}` }));
  const song = (n) => ({ type: 'song', videoId: vid(n), title: d.titles[n % d.titles.length], artists: artists(n),
    album: { name: d.album, id: 'MPREb_audit' }, duration: 200 + n * 17, thumbnail: THUMB, explicit: n % 3 === 0 });
  const songs = (from, k) => Array.from({ length: k }, (_, i) => song(from + i));
  const card = (type, n, title, subtitle) => ({ type, id: type === 'artist' ? `UCaudit${n}` : type === 'album' ? 'MPREb_audit' : 'PLaudit', title, subtitle, thumbnail: THUMB });
  const cards = (type) => Array.from({ length: 8 }, (_, i) => card(type, i, i % 2 ? d.playlist : d.titles[i % d.titles.length], d.artists.join(', ')));
  const lines = d.titles.flatMap((t, i) => [t, `${d.artists[i % d.artists.length]} — ${t}`]).map((text, i) => ({ text, start: i * 4000, end: i * 4000 + 4000 }));
  return {
    song, songs,
    home: [
      { title: 'Quick picks', items: songs(1, 20) },
      { title: d.playlist, items: cards('playlist') },
      { title: 'New releases', items: [...cards('album').slice(0, 4), ...cards('playlist').slice(0, 4)] },
      { title: 'Songs', items: songs(30, 8) },
    ],
    search: (q) => ({ query: q, kind: 'all', top: song(1), results: [...songs(2, 6), card('album', 1, d.album, `Album • ${d.artists[0]} • 2026`),
      card('artist', 2, d.artist, 'Artist'), card('playlist', 3, d.playlist, d.artists.join(', ')), ...songs(8, 6)] }),
    album: { type: 'album', id: 'MPREb_audit', title: d.album, kind: 'Album', year: '2026', artists: artists(3), thumbnail: THUMB,
      description: d.titles.join(' ').repeat(3), trackCount: 14, duration: '58 minutes', playlistId: 'OLAKaudit', tracks: songs(40, 14) },
    playlist: { type: 'playlist', id: 'PLaudit', title: d.playlist, author: d.artists[0], thumbnail: THUMB, description: d.titles.join(' · '),
      trackCount: 24, duration: '1 hour 32 minutes', tracks: songs(60, 24) },
    artist: { type: 'artist', id: 'UCaudit0', name: d.artist, description: d.titles.join(' ').repeat(4), thumbnail: THUMB, subscribers: '41.2M',
      monthlyListeners: '98.7M', radioId: 'RDaudit', shuffleId: 'RDshuffle', songsPlaylistId: 'PLaudit', songs: songs(90, 5),
      albums: cards('album'), singles: cards('album'), related: cards('artist') },
    next: { tracks: songs(1, 30), lyricsId: 'MPLYaudit', relatedId: 'MPTRaudit' },
    lyrics: { found: true, synced: true, lines, source: 'Source: LRCLIB' },
  };
}

// A plain purple square for every thumbnail, and two seconds of silence for every stream.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGklEQVR42mOM8VjAQApgYiARjGoY1TB0NAAAEcABZLKhlJYAAAAASUVORK5CYII=', 'base64');
const WAV = (() => {
  const rate = 8000, n = rate * 2, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
})();

/** The answer for a YouTube-backed endpoint, or null to let the real engine answer. */
function fake(cat, url) {
  const u = new URL(url), p = u.pathname;
  const json = (v) => ({ type: 'application/json', body: Buffer.from(JSON.stringify(v)) });
  if (p === '/api/home') return json(cat.home);
  if (p === '/api/search') return json(cat.search(u.searchParams.get('q') || ''));
  if (p === '/api/suggest') return json({ queries: [], items: [] });
  if (p.startsWith('/api/album/')) return json(cat.album);
  if (p.startsWith('/api/playlist/')) return json(cat.playlist);
  if (p.startsWith('/api/artist/')) return json(cat.artist);
  if (p.startsWith('/api/next/') || p.startsWith('/api/me/radio/')) return json(cat.next);
  if (p.startsWith('/api/lyrics/')) return json(cat.lyrics);
  if (p.startsWith('/api/audio/') || p.startsWith('/api/track/')) return json(cat.song(Number(p.slice(-8)) || 1));
  if (p.startsWith('/api/prefetch/')) return json({ ok: true });
  if (p === '/api/img') return { type: 'image/png', body: PNG };
  if (p.startsWith('/api/stream/')) return { type: 'audio/wav', body: WAV };
  if (p === '/api/app-update') return json({});
  return null;
}

// ------------------------------------------------------------------ processes

const free = () => 47000 + Math.floor(Math.random() * 900);

function chromePath() {
  const options = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const hit = options.find((p) => p && existsSync(p));
  if (!hit) throw new Error('Chrome not found: set CHROME to its path');
  return hit;
}

async function waitFor(url, what) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`${what} did not start`);
}

async function startEngine(dir) {
  const port = free();
  const py = process.env.OPENWAVE_PYTHON || (existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3');
  const proc = spawn(py, ['-m', 'openwave', '--host', '127.0.0.1', '--port', String(port), '--no-browser'],
    { cwd: ROOT, env: { ...process.env, OPENWAVE_DATA: join(dir, 'data'), OPENWAVE_LINK: '0', OPENWAVE_RELAYS: 'off' }, stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${port}/api/health`, 'The engine');
  return { proc, base: `http://127.0.0.1:${port}` };
}

async function startChrome(dir) {
  const port = free();
  const proc = spawn(chromePath(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${port}/json/version`, 'Chrome');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  return { proc, ws: tabs.find((t) => t.type === 'page').webSocketDebuggerUrl };
}

/** A minimal Chrome DevTools Protocol client (Node's built-in WebSocket). */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const pending = new Map(), handlers = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { const { ok, fail } = pending.get(m.id); pending.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); }
    else if (m.method) handlers.get(m.method)?.(m.params);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, ev, on: (m, f) => handlers.set(m, f), close: () => ws.close() };
}

// ------------------------------------------------------------------ the check

// Everything laid out past the left or right edge of the window. Being cut off by an
// overflow-hidden frame still counts (that is how the bug looks: the end time is clipped
// at the edge). Only two kinds of clipping are fine: a container the user can scroll
// sideways (shelves), and text that ends in "…" on purpose.
const CHECK = `(() => {
  const W = innerWidth, found = [];
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const path = (el) => { const p = []; for (let e = el; e && e !== document.body && p.length < 5; e = e.parentElement) p.unshift(name(e)); return p.join(' > '); };
  const shown = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; if (e.hidden) return false; } return true; };
  // A text run is clipped by its own element too; a box only by its ancestors.
  const visible = (el, r, text) => {
    let left = r.left, right = r.right;
    for (let e = text ? el : el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      const scrolls = /(auto|scroll)/.test(s.overflowX);
      const dots = s.textOverflow === 'ellipsis' && /(hidden|clip)/.test(s.overflowX);
      if (scrolls || dots) { const c = e.getBoundingClientRect(); left = Math.max(left, c.left); right = Math.min(right, c.right); }
      if (s.position === 'fixed') break;
    }
    return { left, right };
  };
  const seen = new Set();
  const report = (el, r, what) => {
    if (r.width < 1 || r.height < 1) return;
    const v = visible(el, r, what === 'text');
    if (v.right - v.left < 1) return;
    if (v.right > W + 1 || v.left < -1) {
      if ([...seen].some((s) => s.contains(el))) return;
      seen.add(el);
      found.push({ what, at: path(el), left: Math.round(v.left), right: Math.round(v.right), text: (el.textContent || '').trim().slice(0, 60) });
    }
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (!el.getClientRects().length || !shown(el)) continue;
    report(el, el.getBoundingClientRect(), 'box');
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    if (!t.textContent.trim() || !shown(t.parentElement)) continue;
    const range = document.createRange(); range.selectNodeContents(t);
    for (const r of range.getClientRects()) report(t.parentElement, r, 'text');
  }
  const doc = document.scrollingElement;
  if (doc.scrollWidth > W + 1) found.unshift({ what: 'page', at: 'the whole page scrolls sideways', left: 0, right: doc.scrollWidth, text: '' });
  return found;
})()`;

const ONLY = (process.env.AUDIT_ONLY || '').split(',').filter(Boolean);
const wanted = (x) => { const name = x.name || x; const pool = name in DATASETS ? Object.keys(DATASETS) : VIEWPORTS.map((v) => v.name);
  return !ONLY.some((o) => pool.includes(o)) || ONLY.includes(name); };

const VIEWPORTS = [
  { name: 'phone-320', width: 320, height: 568, mobile: true },
  { name: 'phone-360', width: 360, height: 780, mobile: true },
  { name: 'phone-375', width: 375, height: 667, mobile: true },
  { name: 'phone-390', width: 390, height: 844, mobile: true },
  { name: 'phone-412', width: 412, height: 915, mobile: true },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true },
  { name: 'desktop-1024', width: 1024, height: 700, mobile: false },
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false },
];

// Each screen: a page to open, optional steps (clicks), and what must be on screen afterwards,
// so a screen that never opened fails instead of passing by accident.
const OPEN_NP = `document.querySelector('[data-act=open-np]').click()`;
const NP_TAB = (tab) => `(getComputedStyle(document.querySelector('.np-controls')).display !== 'none'
  ? document.querySelector('[data-act=sheet-${tab}]') : document.querySelector('.np [data-tab=${tab}]')).click()`;
const SCREENS = [
  { name: 'home', hash: '#/home', route: 'home', expect: '.view .quick .row' },
  { name: 'search', hash: (d) => `#/search?q=${encodeURIComponent(d.titles[0])}`, route: 'search', expect: '.view .top-card' },
  { name: 'album', hash: '#/album/MPREb_audit', route: 'album', expect: '.view .row' },
  { name: 'playlist', hash: '#/playlist/PLaudit', route: 'playlist', expect: '.view .row' },
  { name: 'artist', hash: '#/artist/UCaudit0', route: 'artist', expect: '.view .row' },
  { name: 'library', hash: '#/library', route: 'library', expect: '.view a[href="#/my/auditlist"]' },
  { name: 'liked', hash: '#/liked', route: 'library', expect: '.view .row' },
  { name: 'history', hash: '#/history', route: 'library', expect: '.view .row' },
  { name: 'my-playlist', hash: '#/my/auditlist', route: 'library', expect: '.view .row' },
  { name: 'on-repeat', hash: '#/smart/on-repeat', route: 'library', expect: '.view .row' },
  { name: 'insights', hash: '#/insights', route: 'insights', expect: '.view h1' },
  { name: 'settings', hash: '#/settings', route: 'settings', expect: '.view .setting' },
  { name: 'track-menu', hash: '#/album/MPREb_audit', route: 'album', steps: [`document.querySelector('.view .row [data-menu]').click()`], expect: '#menu .menu-head' },
  { name: 'shared-playlist', hash: '#/my/auditshared', route: 'library', expect: '.view .row .added-by' },
  { name: 'shared-with', hash: '#/my/auditshared', route: 'library', steps: [`document.querySelector('[data-act=sharing]').click()`], expect: '#dialog .share-link input' },
  { name: 'join-dialog', hash: '#/library', route: 'library', steps: [`document.querySelector('[data-act=join-shared]').click()`], expect: '#dialog textarea' },
  { name: 'now-playing', hash: '#/home', steps: [OPEN_NP], expect: '#np .np-art' },
  { name: 'now-playing-queue', hash: '#/home', steps: [OPEN_NP, NP_TAB('queue')], expect: '#np-queue .row' },
  { name: 'now-playing-lyrics', hash: '#/home', steps: [OPEN_NP, NP_TAB('lyrics')], expect: '#np-lyrics .lyrics p' },
];

/** Why the screen is not the one we meant to check, or '' if it is. */
const opened = (sc) => `(() => {
  const on = (sel) => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && getComputedStyle(el).visibility !== 'hidden'; };
  const picker = document.getElementById('profiles');
  if (picker && !picker.hidden) return 'the profile picker is covering the app (not signed in)';
  if (document.getElementById('playerbar').hasAttribute('data-empty')) return 'no song loaded in the player';
  ${sc.route ? `if (!document.body.classList.contains('route-${sc.route}')) return 'not on the ${sc.route} page';` : ''}
  if (!on(${JSON.stringify(sc.expect)})) return 'nothing matching ${sc.expect.replace(/'/g, '"')} is on screen';
  return '';
})()`;

// ------------------------------------------------------------------ run

async function seed(base, d, cat) {
  const call = async (path, body, token) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const made = await call('/api/profiles', { name: d.profile, pin: null, color: '#7b7bff' });
  const token = made.token;
  const songs = cat.songs(1, 24), now = Date.now();
  const ops = [
    ...songs.slice(0, 12).map((t, i) => ({ op: 'like', track: t, at: now - i * 1000 })),
    { op: 'playlist.create', id: 'auditlist', name: d.playlist, tracks: songs, at: now },
    { op: 'save', kind: 'album', card: { id: 'MPREb_audit', title: d.album, subtitle: d.artists.join(', '), thumbnail: THUMB } },
    { op: 'save', kind: 'playlist', card: { id: 'PLaudit', title: d.playlist, subtitle: d.artists[0], thumbnail: THUMB } },
    { op: 'save', kind: 'artist', card: { id: 'UCaudit0', title: d.artist, subtitle: 'Artist', thumbnail: THUMB } },
    ...songs.flatMap((t, i) => Array.from({ length: 1 + (i % 4) }, (_, k) => ({ op: 'play', track: t, seconds: 180, at: now - (i * 5 + k) * 3600e3 }))),
    { op: 'search', q: d.titles[0] },
    { op: 'playlist.create', id: 'auditshared', name: d.playlist, tracks: songs.slice(0, 10), at: now },
  ];
  await call('/api/me/ops', { ops }, token);
  await call('/api/me/shares/auditshared', {}, token);     // a shared playlist (local only: relays are off)
  return { token, profile: made.profile };
}

async function audit(dataset, out) {
  const dir = mkdtempSync(join(tmpdir(), 'openwave-audit-'));
  const engine = await startEngine(dir);
  const chrome = await startChrome(dir);
  const failures = [];
  try {
    const d = DATASETS[dataset], cat = catalogue(d);
    const session = await seed(engine.base, d, cat);
    const page = await cdp(chrome.ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    // Every request goes through the fakes below: no browser cache, and no service worker (it would
    // fetch artwork itself, out of reach of this page's interception, and could serve cached files).
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.send('Network.setBypassServiceWorker', { bypass: true });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/*` }, { urlPattern: `${engine.base}/sw.js` }] });
    page.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const ans = request.url.endsWith('/sw.js') ? { status: 404, type: 'text/plain', body: Buffer.from('') } : fake(cat, request.url);
      if (!ans) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
      page.send('Fetch.fulfillRequest', { requestId, responseCode: ans.status || 200,
        responseHeaders: [{ name: 'Content-Type', value: ans.type }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: ans.body.toString('base64') }).catch(() => {});
    });

    // Signed in before the app's own scripts run, on every load.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify(session))});` });

    for (const vp of VIEWPORTS.filter(wanted)) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: vp.mobile });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile, maxTouchPoints: 5 });
      await page.send('Emulation.setEmitTouchEventsForMouse', { enabled: vp.mobile });
      // A fresh load per size (media queries for pointer type are read at load), then start a song.
      // The query string differs per size, so this is a real page load and not just a hash change.
      await page.send('Page.navigate', { url: `${engine.base}/?size=${vp.name}#/play/${vid(1)}` });
      await sleep(2500);
      for (const sc of SCREENS) {
        await page.ev(`document.querySelector('.np')?.hidden === false && document.querySelector('[data-act=close-np]')?.click(); document.getElementById('menu')?.setAttribute('hidden', ''); document.getElementById('dialog').open && document.getElementById('dialog').close(); true`);
        await sleep(300);
        await page.ev(`location.hash = ${JSON.stringify(typeof sc.hash === 'function' ? sc.hash(d) : sc.hash)}; true`);
        await sleep(600);
        // Check the finished screen, not its loading placeholders.
        for (let i = 0; i < 30 && await page.ev(`!!document.querySelector('#view .skeleton')`); i++) await sleep(200);
        await sleep(500);
        let stepError = null;
        for (const step of sc.steps || []) {
          try { await page.ev(step); } catch (e) { stepError = e.message.split('\n')[0]; }
          await sleep(700);
        }
        const missing = stepError || await page.ev(opened(sc));
        const found = missing ? [{ what: 'open', at: `the screen did not open: ${missing}`, left: 0, right: 0, text: '' }] : await page.ev(CHECK);
        if (found.length || process.env.AUDIT_ALL) {
          const shot = join(out, `${dataset}-${vp.name}-${sc.name}.png`);
          const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(shot, Buffer.from(data, 'base64'));
          if (found.length) failures.push({ dataset, viewport: vp.name, screen: sc.name, found, shot });
        }
        process.stdout.write(found.length ? 'x' : '.');
      }
    }
    page.close();
  } finally {
    chrome.proc.kill();
    engine.proc.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
  return failures;
}

const out = process.env.AUDIT_OUT || mkdtempSync(join(tmpdir(), 'openwave-audit-shots-'));
mkdirSync(out, { recursive: true });
const failures = [];
for (const dataset of Object.keys(DATASETS).filter(wanted)) {
  process.stdout.write(`${dataset}: `);
  failures.push(...await audit(dataset, out));
  process.stdout.write('\n');
}
const total = Object.keys(DATASETS).filter(wanted).length * VIEWPORTS.filter(wanted).length * SCREENS.length;
if (!failures.length) {
  console.log(`\nAll ${total} screen checks passed: nothing goes past the edge of the screen.`);
} else {
  console.log(`\n${failures.length} of ${total} screen checks failed. Screenshots: ${out}\n`);
  for (const f of failures) {
    console.log(`${f.dataset} · ${f.viewport} · ${f.screen}`);
    for (const x of f.found.slice(0, 6)) console.log(`   ${x.what.padEnd(4)} ${x.at}  [${x.left}…${x.right}px]${x.text ? `  "${x.text}"` : ''}`);
    if (f.found.length > 6) console.log(`   … and ${f.found.length - 6} more`);
  }
  process.exitCode = 1;
}
