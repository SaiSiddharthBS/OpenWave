// The README's screenshots, taken the same way every time: a throwaway engine with a demo profile
// ("Maya") that has real songs, playlists and a month of listening, opened in headless Chrome at
// desktop, tablet and phone sizes. Needs the internet (the songs and artwork are real).
//
//   node scripts/screenshots.mjs [only,these]     # writes docs/screenshots/*.png
//
// Environment: as for tests/ui/layout_audit.mjs (OPENWAVE_PYTHON, CHROME); SHOTS_OUT to write
// somewhere else. Composites (the hero image, the Mac window) are made by scripts/compose_shots.py.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cdp, fake, sleep, startChrome, startEngine } from '../tests/ui/harness.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.SHOTS_OUT || join(ROOT, 'docs', 'screenshots');
const ONLY = (process.argv[2] || '').split(',').filter(Boolean);
const NOW = Date.now();
const DAY = 86400e3;

// Songs most people know, grouped the way someone listens: artists in one group are played in the
// same sittings, which is what Daily Mixes are made from.
const SITTINGS = [
  ['Blinding Lights The Weeknd', 'Save Your Tears The Weeknd', 'Starboy The Weeknd', 'Levitating Dua Lipa', 'Houdini Dua Lipa', "Don't Start Now Dua Lipa"],
  ['The Less I Know The Better Tame Impala', 'Let It Happen Tame Impala', 'Borderline Tame Impala', 'Pink + White Frank Ocean', 'Nights Frank Ocean', 'Thinkin Bout You Frank Ocean'],
  ['Yellow Coldplay', 'The Scientist Coldplay', 'Viva La Vida Coldplay', 'As It Was Harry Styles', 'Watermelon Sugar Harry Styles'],
  ['Kesariya Arijit Singh', 'Tum Hi Ho Arijit Singh', 'Apna Bana Le Arijit Singh', 'Raataan Lambiyan Jubin Nautiyal'],
  ['vampire Olivia Rodrigo', 'good 4 u Olivia Rodrigo', 'Espresso Sabrina Carpenter', 'Birds of a Feather Billie Eilish', 'Anti-Hero Taylor Swift'],
];
const PLAYLISTS = [
  ['Road Trip', [0, 1, 2, 3, 4], ['Blinding Lights', 'Levitating', 'As It Was', 'Viva La Vida', 'Espresso', 'Let It Happen', 'good 4 u', 'Watermelon Sugar', 'Starboy', 'Houdini']],
  ['Late Night Drive', [0, 1], ['Nights', 'Save Your Tears', 'Borderline', 'Pink + White', 'Starboy', 'The Less I Know The Better']],
  ['Sunday Morning', [1, 2], ['Pink + White', 'Yellow', 'The Scientist', 'Thinkin Bout You', 'Watermelon Sugar']],
  ['Pop Rotation', [0, 4], ['Espresso', 'Houdini', 'vampire', 'Anti-Hero', 'Birds of a Feather', "Don't Start Now"]],
  ['Desi Heartbreak', [3], ['Kesariya', 'Tum Hi Ho', 'Apna Bana Le', 'Raataan Lambiyan']],
];
const ALBUMS = ['After Hours The Weeknd', 'Blonde Frank Ocean', 'Currents Tame Impala'];
const ARTISTS = ['The Weeknd', 'Frank Ocean', 'Tame Impala', 'Dua Lipa', 'Coldplay'];
const PLAYING = 'Blinding Lights The Weeknd';
// Settings → Phones, as in a home with two paired phones (the engine has none; this is shown instead).
const PHONES = {
  phones: {
    available: true, via: false, name: "Maya's MacBook Pro", relays: 6, tickets: [{ id: 'demo', expires: Math.floor(NOW / 1000) + 900, devices: [] }],
    devices: [
      { id: 'p1', label: "Maya's iPhone", added: 1, seen: Math.floor(NOW / 1000), online: true, profiles: ['Maya'] },
      { id: 'p2', label: "Arjun's Pixel", added: 2, seen: Math.floor(NOW / 1000) - 7200, online: false, profiles: ['Arjun'] },
    ],
  },
};

async function api(base, path, { token, body } = {}) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function first(base, q, type) {
  const d = await api(base, `/api/search?q=${encodeURIComponent(q)}&type=${type}`);
  const hit = type === 'songs' ? (d.results || []).find((t) => t.videoId) : (d.results || []).find((c) => c.id);
  if (!hit) throw new Error(`nothing found for ${q}`);
  return hit;
}

/** Maya: a month of listening, likes, playlists, saved albums and artists. */
async function seed(base) {
  const made = await api(base, '/api/profiles', { body: { name: 'Maya', pin: null, color: '#7b7bff' } });
  const token = made.token;
  const groups = [];
  for (const qs of SITTINGS) {
    const songs = [];
    for (const q of qs) songs.push(await first(base, q, 'songs'));
    groups.push(songs);
  }
  const all = groups.flat();
  const byTitle = (name) => all.find((t) => t.title.toLowerCase().startsWith(name.toLowerCase())) || all.find((t) => t.title.toLowerCase().includes(name.toLowerCase()));
  const ops = [];
  // Sittings over thirty days: favourites more often, so On Repeat, Insights and Daily Mixes fill up.
  for (let day = 1; day <= 30; day++) {
    const group = groups[day % groups.length];
    let at = NOW - day * DAY + 19 * 3600e3;
    for (const [i, t] of group.entries()) {
      if ((day + i) % 3 === 2) continue;
      ops.push({ op: 'play', track: t, seconds: Math.max(150, (t.duration || 200) - 5), at });
      at += ((t.duration || 200) + 5) * 1000;
    }
  }
  for (const t of groups[0].slice(0, 3)) for (let k = 0; k < 4; k++) ops.push({ op: 'play', track: t, seconds: 190, at: NOW - (k + 1) * 3 * 3600e3 });
  for (const [i, t] of all.slice(0, 16).entries()) ops.push({ op: 'like', track: t, at: NOW - i * 60e3 });
  for (const [i, [name, , titles]] of PLAYLISTS.entries()) {
    ops.push({ op: 'playlist.create', id: `demo${i}`, name, tracks: titles.map(byTitle).filter(Boolean), at: NOW - i * 1000 });
  }
  for (const q of ALBUMS) {
    const c = await first(base, q, 'albums');
    ops.push({ op: 'save', kind: 'album', card: { id: c.id, title: c.title, subtitle: c.subtitle, thumbnail: c.thumbnail } });
  }
  for (const q of ARTISTS) {
    const c = await first(base, q, 'artists');
    ops.push({ op: 'save', kind: 'artist', card: { id: c.id, title: c.title, subtitle: 'Artist', thumbnail: c.thumbnail } });
  }
  for (const q of ['Tame Impala', 'Arijit Singh', 'Dua Lipa', 'lofi beats']) ops.push({ op: 'search', q });
  await api(base, '/api/me/ops', { token, body: { ops } });
  // Daily Mixes fill in their new songs in the background: ask until they have them.
  for (let i = 0; i < 20; i++) {
    const d = await api(base, '/api/me/daily', { token });
    if (d.mixes.length && d.mixes[0].tracks.length > 14) break;
    await sleep(1500);
  }
  return { session: { token, profile: made.profile }, playing: await first(base, PLAYING, 'songs'), album: (await first(base, ALBUMS[0], 'albums')).id,
    artist: (await first(base, ARTISTS[0], 'artists')).id };
}

const DESKTOP = { width: 1440, height: 900, scale: 1.5, mobile: false };
const TABLET = { width: 834, height: 1194, scale: 2, mobile: true };
const PHONE = { width: 393, height: 852, scale: 2, mobile: true, insets: { top: 54, bottom: 34 } };
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const dir = mkdtempSync(join(tmpdir(), 'openwave-shots-'));
mkdirSync(OUT, { recursive: true });
const engine = await startEngine(dir);
const chrome = await startChrome(dir);
try {
  console.log('Making Maya…');
  const demo = await seed(engine.base);
  const page = await cdp(chrome.ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/connect*` }] });
  const json = (v) => ({ type: 'application/json', body: Buffer.from(JSON.stringify(v)) });
  page.on('Fetch.requestPaused', ({ requestId, request }) => {
    const path = new URL(request.url).pathname;
    const ans = path === '/api/connect/pair' ? json({ id: 'demo', link: 'https://saisiddharthbs.github.io/OpenWave/app/#connect=eyJ2IjoxLCJoIjoiZGVtbyJ9eyJ2IjoxLCJoIjoiZGVtbyJ9', expires: Math.floor(NOW / 1000) + 900 })
      : path === '/api/connect/tailscale' ? json({ state: 'sharing', url: 'https://mayas-macbook.tail1234.ts.net/' })
        : path === '/api/connect/startup' ? json({ available: false })
          : fake(PHONES, request.url);
    if (!ans) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    page.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: ans.type }], body: ans.body.toString('base64') }).catch(() => {});
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify(demo.session))});` });

  let size = null;
  const use = async (s, ua = '') => {
    size = s;
    await page.send('Emulation.setUserAgentOverride', { userAgent: ua || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' });
    await page.send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: s.scale, mobile: s.mobile });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: s.mobile, maxTouchPoints: 5 });
    // iPhone-like edges for the phone shots: room for the clock and the home bar.
    await page.send('Emulation.setSafeAreaInsetsOverride', { insets: s.insets || {} }).catch(() => console.log('  (this Chrome cannot add safe areas)'));
    await page.send('Page.navigate', { url: `${engine.base}/?shots=${s.width}#/play/${demo.playing.videoId}` });
    await sleep(6000);
    await page.ev(`(() => { const a = [...document.querySelectorAll('audio')].find((x) => x.src); if (a) a.currentTime = 74; })(); true`);
    await sleep(800);
  };
  const go = async (hash, wait = 3500) => {
    await page.ev(`document.querySelector('#np')?.hidden === false && document.querySelector('[data-act=close-np]').click(); document.querySelector('#menu').hidden = true;
      document.activeElement?.blur(); if (!${JSON.stringify(hash)}.startsWith('#/search')) { document.querySelector('#search-input').value = ''; document.querySelector('#search-clear').hidden = true; }
      location.hash = ${JSON.stringify(hash)}; true`);
    await sleep(wait);
    await page.ev(`document.querySelector('#main').scrollTop = 0; true`);
    await sleep(1600);   // everything that arrives with the page has arrived
  };
  const shot = async (name) => {
    if (ONLY.length && !ONLY.includes(name)) return;
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  ${name}.png`);
  };
  const openPlayer = async (tab) => {
    await page.ev(`document.querySelector('[data-act=open-np]').click(); true`);
    await sleep(1500);
    if (tab) {
      await page.ev(`(getComputedStyle(document.querySelector('.np-controls')).display !== 'none' ? document.querySelector('[data-act=sheet-${tab}]') : document.querySelector('.np [data-tab=${tab}]')).click(); true`);
      await sleep(2500);
    }
  };

  console.log('Computer');
  await use(DESKTOP);
  await go('#/home', 5000); await shot('home');
  await go('#/daily/1'); await shot('daily-mix');
  await go(`#/artist/${demo.artist}`); await shot('artist');
  await go(`#/album/${demo.album}`); await shot('album');
  await go('#/my/demo0'); await shot('playlist');
  await go('#/library'); await shot('library');
  await go('#/insights'); await shot('insights');
  await go('#/smart/on-repeat'); await shot('on-repeat');
  await go('#/search?q=Tame%20Impala'); await shot('search');
  await go('#/settings');
  await page.ev(`document.querySelector('[data-select=quality]').click(); true`); await sleep(800); await shot('settings');
  await page.ev(`document.querySelector('#menu').hidden = true; document.querySelector('[data-act=connect-remove]')?.closest('.setting, section, .settings-group')?.scrollIntoView({ block: 'center' }); true`);
  await sleep(1200); await shot('connect-phones');
  await page.ev(`document.querySelector('[data-act=connect-pair]').click(); true`); await sleep(2500); await shot('connect-pair');
  await go('#/library');
  await page.ev(`document.querySelector('[data-act=import-playlists]').click(); true`); await sleep(1500);
  await page.ev(`(() => { const t = document.querySelector('#dialog textarea, #dialog input[type=text]'); if (t) { t.value = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'; t.dispatchEvent(new Event('input', { bubbles: true })); } })(); true`);
  await sleep(800); await shot('import');
  await page.ev(`document.querySelector('#dialog')?.close?.(); true`); await sleep(500);
  await go('#/home');
  await page.ev(`document.querySelector('.side-me').click(); true`); await sleep(800); await shot('profile-menu');
  await go('#/home');
  await openPlayer('lyrics'); await shot('now-playing');
  await go('#/home');
  await page.ev(`document.documentElement.classList.add('native-app', 'native-mac-app', 'native-mac'); true`);
  await sleep(1200); await shot('mac-window');

  console.log('Tablet');
  await use(TABLET, IPAD);
  await go('#/home', 5000); await shot('tablet-home');
  await go(`#/album/${demo.album}`); await shot('tablet-album');

  console.log('Phone');
  await use(PHONE, IPHONE);
  await go('#/home', 5000); await shot('mobile-home');
  await go('#/my/demo1'); await shot('mobile-playlist');
  await go('#/library'); await shot('mobile-library');
  await go('#/search?q=Coldplay'); await shot('mobile-search');
  await go('#/insights'); await shot('mobile-insights');
  await go('#/daily/1'); await shot('mobile-daily-mix');
  await go('#/home');
  await openPlayer(); await shot('mobile-now-playing');
  await page.ev(`document.querySelector('[data-act=sheet-lyrics]').click(); true`); await sleep(2500); await shot('mobile-lyrics');
  page.close();
} finally {
  chrome.proc.kill();
  engine.proc.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
