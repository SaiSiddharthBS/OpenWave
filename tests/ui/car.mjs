// Android Auto: asks the page what the car asks (js/car.js), as the Android app would, and checks
// the answers: the four tabs, folders, search, playing, voice and the queue. Runs like behaviour.mjs.
//
//   node tests/ui/car.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, cdp, DATASETS, fake, seed, sleep, startChrome, startEngine, vid } from './harness.mjs';

const failures = [];
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };

// The Android app's window.OpenWaveAndroid, keeping what the page tells it.
const ANDROID = `window.__sent = [];
window.OpenWaveAndroid = { postMessage: (m) => window.__sent.push(JSON.parse(m)), getServer: () => '', appVersion: () => '9.9.9',
  deviceName: () => 'Test phone', pairedComputer: () => false, haptic() {}, shareText() {}, shareFile() {}, addWidget: () => false };`;

const dir = mkdtempSync(join(tmpdir(), 'openwave-car-'));
const engine = await startEngine(dir);
const chrome = await startChrome(dir);
try {
  const d = DATASETS.realistic, cat = catalogue(d);
  const session = await seed(engine.base, d, cat);
  const page = await cdp(chrome.ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/*` }, { urlPattern: `${engine.base}/sw.js` }] });
  page.on('Fetch.requestPaused', ({ requestId, request }) => {
    const ans = request.url.endsWith('/sw.js') ? { status: 404, type: 'text/plain', body: Buffer.from('') } : fake(cat, request.url);
    if (!ans) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    page.send('Fetch.fulfillRequest', { requestId, responseCode: ans.status || 200, responseHeaders: [{ name: 'Content-Type', value: ans.type }], body: ans.body.toString('base64') }).catch(() => {});
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: ANDROID });
  const signedIn = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify(session))});` });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
  await page.send('Page.bringToFront');
  await page.send('Page.navigate', { url: `${engine.base}/#/home` });
  await sleep(3000);

  let n = 0;
  /** One question from the car, answered as the Android app receives it. */
  const ask = async (op, id = '', q = '') => {
    const req = ++n;
    await page.ev(`window.openwaveNative.command('car', ${JSON.stringify(JSON.stringify({ req, op, id, q }))}); true`);
    for (let i = 0; i < 60; i++) {
      const got = await page.ev(`JSON.stringify(window.__sent.find((m) => m.type === 'car' && m.req === ${req}) || null)`);
      if (got !== 'null') return JSON.parse(got);
      await sleep(100);
    }
    return null;
  };
  const absolute = (items) => items.filter((x) => x.art).every((x) => /^https?:\/\//.test(x.art));

  console.log('Tabs');
  const home = await ask('browse', 'home');
  const groups = [...new Set(home.items.map((x) => x.group))];
  check(home.items.length >= 20, `Home has plenty to choose from (${home.items.length} items)`);
  check(groups.includes('Jump back in') && groups.includes('Quick picks'), `in sections (${groups.join(' / ')})`);
  check(home.items.some((x) => x.group === d.playlist && !x.play && x.style === 'grid' && x.id.startsWith('playlist/')), 'playlists and albums are big tiles you open');
  check(home.items.filter((x) => x.group === 'Quick picks').every((x) => x.play && x.id.startsWith('radio|')), 'songs play straight away, as a radio');
  check(absolute(home.items), 'every picture has a full address the phone can fetch');
  const mixes = await ask('browse', 'mixes');
  check(mixes.items.length >= 1 && mixes.items.every((x) => x.style === 'grid' && (x.label || x.tile)), `Mixes are mix covers with their names (${mixes.items.map((x) => x.title).join(', ')})`);
  const library = await ask('browse', 'library');
  const ids = library.items.map((x) => x.id);
  check(ids[0] === 'liked' && library.items[0].tile === 'liked', 'Library starts with Liked songs, on its own tile');
  check(ids.includes('my/auditlist') && ids.includes('album/MPREb_audit') && ids.includes('playlist/PLaudit') && ids.includes('artist/UCaudit0'),
    'and has your playlists, saved albums, playlists and artists');
  check(library.items.filter((x) => x.id.startsWith('artist/')).every((x) => x.round) && !library.items.some((x) => x.round && !x.id.startsWith('artist/')),
    'artists are round, like in the app, and nothing else is');
  const t0 = Date.now();
  await ask('browse', 'mixes');
  check(Date.now() - t0 < 600, `opening Mixes again is instant (${Date.now() - t0} ms)`);
  const recent = await ask('browse', 'recent');
  check(recent.items.length >= 20 && recent.items.every((x) => x.play), `Recent lists what you played (${recent.items.length} songs)`);

  console.log('Folders');
  const album = await ask('browse', 'album/MPREb_audit');
  check(album.items[0]?.id === 'shuffle|album/MPREb_audit' && album.items[0].tile === 'shuffle', 'an album starts with Shuffle play');
  check(album.items.length === 15 && album.items.slice(1).every((x) => x.id.startsWith('play|album/MPREb_audit|')), 'then its 14 songs');
  check(album.items.some((x) => x.explicit) && album.items.some((x) => !x.explicit), 'explicit songs are marked');
  const artist = await ask('browse', 'artist/UCaudit0');
  check(artist.items.some((x) => x.group === 'Popular' && x.play) && artist.items.some((x) => x.group === 'Albums' && !x.play), 'an artist has Popular songs and Albums');
  const liked = await ask('browse', 'liked');
  check(liked.items.length === 13, `Liked songs has Shuffle play and the 12 liked songs (${liked.items.length})`);
  const daily = mixes.items.find((x) => x.id.startsWith('daily/'));
  if (daily) {
    const inside = await ask('browse', daily.id);
    check(inside.items.length > 1, `${daily.title} opens with its songs (${inside.items.length - 1})`);
  }

  console.log('Around the world');
  const world = home.items.filter((x) => x.group === 'Around the world');
  check(world.length === 3 && world[0].id === 'world/NG' && world[0].shape && /^#[0-9a-f]{6}$/.test(world[0].tint) && world[1].id === 'world/ZZ' && world[2].id === 'world',
    `Home has today's country, the world's top songs and every country (${world.map((x) => x.title).join(', ')})`);
  const every = await ask('browse', 'world');
  check(every.items.length === 20 && every.items.every((x) => /^world\/[A-Z]{2}$/.test(x.id) && /^\d+,\d+,/.test(x.shape) && x.label),
    `every country is a folder with its own dotted shape (${every.items.length})`);
  const ng = await ask('browse', 'world/NG');
  check(ng.items[0]?.id === 'shuffle|world/NG' && ng.items.length === 21, `a country opens with its chart (${ng.items.length - 1} songs)`);

  console.log('Search');
  const found = await ask('search', '', 'arijit');
  const fg = [...new Set(found.items.map((x) => x.group))];
  check(fg[0] === 'Top result' && fg.includes('Songs') && fg.includes('Albums') && fg.includes('Artists'), `results come in sections (${fg.join(' / ')})`);

  console.log('Playing');
  await ask('play', `play|album/MPREb_audit|${vid(45)}`);
  await sleep(500);
  let st = await page.ev(`(async () => ({ id: window.openwaveNative.state()?.videoId, n: (await import('./js/player.js')).player.queue.length }))()`);
  check(st.id === vid(45) && st.n === 14, `a song in an album plays, with the album after it (${st.id}, ${st.n} in the queue)`);
  await sleep(600);
  const queue = await page.ev(`JSON.stringify(window.__sent.filter((m) => m.type === 'queue').at(-1) || null)`);
  const q = JSON.parse(queue)?.queue;
  check(q && q.title === d.album && q.items.some((x) => x.i === q.index && x.title), `the car gets the queue to show (${q?.items.length} songs, "${q?.title}")`);
  await ask('play', 'shuffle|liked');
  await sleep(500);
  st = await page.ev(`(async () => { const { player } = await import('./js/player.js'); return { shuffle: player.shuffle, n: player.queue.length, label: player.context?.label }; })()`);
  check(st.shuffle && st.n === 12 && st.label === 'Liked songs', 'Shuffle play shuffles the folder');
  await ask('play', 'voice|road trip');
  await ask('play', `voice|${d.playlist.toLowerCase()}`);
  await sleep(500);
  st = await page.ev(`(async () => (await import('./js/player.js')).player.context?.label)()`);
  check(st === d.playlist, `"Hey Google, play <your playlist> on OpenWave" plays your own playlist (${st})`);
  await ask('play', 'voice|tum hi ho');
  await sleep(500);
  st = await page.ev(`window.openwaveNative.state()?.videoId`);
  check(st === vid(1), `anything else plays the best match from search (${st})`);
  await ask('play', 'voice|top songs in mexico');
  await sleep(500);
  st = await page.ev(`(async () => (await import('./js/player.js')).player.context)()`);
  check(st?.href === '#/explore/MX' && st.label === 'Trending in Mexico', `"Hey Google, play top songs in Mexico on OpenWave" plays Mexico's chart (${st?.label})`);
  await ask('play', 'world/KE');
  await ask('play', 'play|world/NG|' + vid(103));
  await sleep(500);
  st = await page.ev(`(async () => { const { player } = await import('./js/player.js'); return [player.context?.href, player.current?.videoId]; })()`);
  check(st[0] === '#/explore/NG' && st[1] === vid(103), 'a song chosen in a country plays from there, as part of its chart');
  if (daily) {
    await ask('play', 'voice|daily mix 1');
    await sleep(500);
    st = await page.ev(`(async () => (await import('./js/player.js')).player.context?.label)()`);
    check(st === daily.title, `"play daily mix 1" plays it (${st})`);
  }
  await page.ev(`window.openwaveNative.command('jump', '3'); true`);
  await sleep(300);
  st = await page.ev(`(async () => (await import('./js/player.js')).player.index)()`);
  check(st === 3, 'choosing a song in the car\'s queue jumps to it');

  console.log('Nobody signed in');
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: signedIn.identifier });
  await page.ev(`localStorage.removeItem('openwave:session:v2'); location.reload(); true`);
  await sleep(2500);
  const none = await ask('browse', 'home');
  check(none?.error === 'profile', 'the car is told to pick a profile on the phone');
  page.close();
} finally {
  chrome.proc.kill();
  engine.proc.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exitCode = 1; } else console.log('\nThe car gets everything it asks for.');
