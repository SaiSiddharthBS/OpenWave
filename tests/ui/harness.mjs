// What the UI checks share: made-up YouTube answers, a real engine with a throwaway data folder,
// headless Chrome and a small DevTools client. No network is needed.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ made-up catalogue data

export const DATASETS = {
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

export const vid = (n) => `vid${String(n).padStart(8, '0')}`;           // 11 characters, like a real video id
export const THUMB = 'https://lh3.googleusercontent.com/audit=w544-h544';

export function catalogue(d) {
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
    phones: { available: true, via: false, name: d.artist, relays: 6, tickets: [{ id: 'audit', expires: 0, devices: [] }],
      devices: [{ id: 'a1', label: 'iPhone', added: 1, seen: Math.floor(Date.now() / 1000), online: true, profiles: [d.artist] },
        { id: 'a2', label: 'Android phone', added: 2, seen: 1700000000, online: false }, { id: 'a3', label: 'iPad', added: 3, seen: null, online: false }] },
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
export function fake(cat, url) {
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
  if (p.startsWith('/api/length/')) return json({ seconds: cat.song(Number(p.slice(-8)) || 1).duration });
  if (p === '/api/img') return { type: 'image/png', body: PNG };
  if (p.startsWith('/api/stream/')) return { type: 'audio/wav', body: WAV };
  if (p === '/api/app-update') return json({});
  // OpenWave Connect (Settings → Phones), with as many paired phones as names allow.
  if (p === '/api/connect') return json(cat.phones);
  if (p === '/api/connect/tailscale') return json({ state: 'sharing', url: 'https://the-living-room-mac-mini-of-the-family.tail1234abcd.ts.net:8443/' });
  if (p === '/api/connect/startup') return json({ available: true, on: true, system: 'Windows' });
  if (p === '/api/connect/pair') return json({ id: 'audit', link: `https://saisiddharthbs.github.io/OpenWave/app/#connect=${'eyJ2IjoxLCJoIjoi'.repeat(14)}`, expires: 0 });
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

export async function waitFor(url, what) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`${what} did not start`);
}

export async function startEngine(dir) {
  const port = free();
  const py = process.env.OPENWAVE_PYTHON || (existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3');
  const proc = spawn(py, ['-m', 'openwave', '--host', '127.0.0.1', '--port', String(port), '--no-browser'],
    { cwd: ROOT, env: { ...process.env, OPENWAVE_DATA: join(dir, 'data'), OPENWAVE_LINK: '0', OPENWAVE_RELAYS: 'off' }, stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${port}/api/health`, 'The engine');
  return { proc, base: `http://127.0.0.1:${port}` };
}

export async function startChrome(dir) {
  const port = free();
  const proc = spawn(chromePath(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${port}/json/version`, 'Chrome');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  return { proc, ws: tabs.find((t) => t.type === 'page').webSocketDebuggerUrl };
}

/** A minimal Chrome DevTools Protocol client (Node's built-in WebSocket). */
export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const pending = new Map(), handlers = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { const { ok, fail } = pending.get(m.id); pending.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); }
    else if (m.method) handlers.get(m.method)?.(m.params);
  };
  // A reply that never comes would leave a check waiting forever: after 30 s it's an error instead,
  // which says which command it was.
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`no reply to ${method} after 30 s`)); }, 30000);
    pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    for (let tries = 1; ; tries++) {
      let r;
      try {
        r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      } catch (e) {
        // A page that's just reloading or navigating has no context to run in for a moment, which a
        // slow machine catches more often. That's the test's timing, not the app: wait and ask again.
        if (tries < 4 && /context|navigated|Target closed/i.test(e.message)) { await sleep(400); continue; }
        throw e;
      }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    }
  };
  return { send, ev, on: (m, f) => handlers.set(m, f), close: () => ws.close() };
}

// ------------------------------------------------------------------ a signed-in profile with a library

export async function seed(base, d, cat) {
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
