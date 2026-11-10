// Explore (js/explore.js): the way in from Search, the world map, Take me somewhere, a country's
// page, the passport, genres and moods, and today's country on Home. YouTube is replaced with
// made-up data (harness.mjs), so it runs without a network, like behaviour.mjs.
//
//   node tests/ui/explore.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, cdp, DATASETS, fake, seed, sleep, startChrome, startEngine } from './harness.mjs';

const failures = [];
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };

const dir = mkdtempSync(join(tmpdir(), 'openwave-explore-'));
const engine = await startEngine(dir);
const chrome = await startChrome(dir);
const errors = [];
try {
  const d = DATASETS.realistic, cat = catalogue(d);
  const session = await seed(engine.base, d, cat);
  const page = await cdp(chrome.ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  page.on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  page.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push(e.args.map((a) => a.value || a.description).join(' ')); });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // "Your part of the world" comes from the time zone: the same one on every machine that runs this.
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Kolkata' });
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/*` }, { urlPattern: `${engine.base}/sw.js` }] });
  page.on('Fetch.requestPaused', ({ requestId, request }) => {
    const ans = request.url.endsWith('/sw.js') ? { status: 404, type: 'text/plain', body: Buffer.from('') } : fake(cat, request.url);
    if (!ans) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    page.send('Fetch.fulfillRequest', { requestId, responseCode: ans.status || 200, responseHeaders: [{ name: 'Content-Type', value: ans.type }], body: ans.body.toString('base64') }).catch(() => {});
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify(session))});` });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.bringToFront');
  await page.send('Page.navigate', { url: `${engine.base}/#/home` });
  await sleep(3000);

  const go = async (hash, wait = 1500) => { await page.ev(`location.hash = ${JSON.stringify(hash)}; true`); await sleep(wait); };
  const playing = () => page.ev(`(async () => { const { player } = await import('./js/player.js'); return { href: player.context?.href, label: player.context?.label, n: player.queue.length, vid: player.current?.videoId }; })()`);
  // How much of a canvas is drawn on (0-1): a map that never drew is blank.
  const inked = (sel) => page.ev(`(() => { const c = document.querySelector(${JSON.stringify(sel)}); if (!c || !c.width) return 0;
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < px.length; i += 16) if (px[i]) n++; return n / (px.length / 16); })()`);

  console.log('Search');
  await go('#/search');
  check(await page.ev(`!!document.querySelector('.view .ex-card[href="#/explore"]')`), 'Search starts with the way into Explore');
  check(await inked('.ex-card canvas') > 0.03, 'with the world map drawn behind it');
  check(await page.ev(`document.querySelector('.ex-rot')?.textContent`) === 'Nigeria', 'naming today’s country first');
  check(await page.ev(`document.querySelectorAll('.ex-card .fan').length`) === 3, 'with today’s covers fanned out');
  check(await page.ev(`document.querySelectorAll('.mood-pill').length`) === 6, 'and moods underneath');

  console.log('Explore');
  await page.ev(`document.querySelector('.ex-card').click(); true`);
  await sleep(1500);
  check(await page.ev('location.hash') === '#/explore', 'the card opens Explore');
  check(await page.ev(`document.querySelector('.side-nav [data-route=explore]').classList.contains('on')`), 'which has its own place in the sidebar');
  check(await inked('.ex-map canvas') > 0.05, 'the world map is drawn');
  check(await page.ev(`document.querySelectorAll('.ex-beacons i:not(.you)').length`) === 6, 'with beacons pulsing on six countries');
  check(await page.ev(`document.querySelectorAll('.cty').length`) === cat.explore.countries.length + 1, 'every country has a tile, and the world one too');
  await page.ev(`document.querySelector('.cty-grid').scrollIntoView(); true`);
  await sleep(600);
  check(await page.ev(`[...document.querySelectorAll('.cty canvas')].slice(0, 8).every((c) => c.width > 0 && c.dataset.drawn)`), 'each tile has its country’s dotted shape, drawn as it comes into view');
  await page.ev(`document.getElementById('main').scrollTop = 0; true`);
  await page.ev(`document.querySelector('[data-region-pick="af"]').click(); true`);
  const africa = await page.ev(`[...document.querySelectorAll('.cty')].filter((t) => !t.hidden).map((t) => t.getAttribute('href').slice(-2)).sort().join(',')`);
  check(africa === 'EG,KE,NG,ZA', `Africa shows only African countries (${africa})`);
  await page.ev(`document.querySelector('[data-region-pick=""]').click(); true`);
  check(await page.ev(`document.querySelectorAll('.gtile').length`) === cat.explore.genres.length + cat.explore.moods.length, 'genres and moods are tiles');

  // The pointer over a country lights it up and names it; a click opens it.
  // Where Nigeria's middle is drawn: the map is fitted to its canvas as js/explore.js does.
  const at2 = await page.ev(`(async () => {
    const { MAP, COUNTRY } = await import('./js/world-map.js');
    const c = document.querySelector('.ex-map canvas'); c.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 400));
    const r = c.getBoundingClientRect(), HEX = Math.sqrt(3) / 2, W = MAP.cols + 0.5, H = MAP.rows * HEX;
    const s = Math.min(r.width / W, r.height / H), x0 = (W - r.width / s) / 2, y0 = Math.max(0, (H - r.height / s) / 2);
    const [, , cx, cy] = COUNTRY.NG;
    return { x: r.left + (cx + 0.5 - x0) * s, y: r.top + ((cy + 0.5) * HEX - y0) * s };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at2.x, y: at2.y });
  await sleep(300);
  const tip = await page.ev(`document.querySelector('.ex-tip').hidden ? '' : document.querySelector('.ex-tip b').textContent`);
  check(tip === 'Nigeria', `pointing at Nigeria names it (${tip || 'nothing'})`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at2.x, y: at2.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at2.x, y: at2.y, button: 'left', clickCount: 1 });
  await sleep(1500);
  check(await page.ev('location.hash') === '#/explore/NG', 'and clicking it opens Nigeria');

  console.log('A country');
  check(await page.ev(`document.querySelector('.hero.place h1')?.textContent`) === 'Nigeria', 'its name heads the page');
  check(await inked('.place-map') > 0.05, 'over the map, closed in on it');
  check(await page.ev(`document.querySelectorAll('.view .tracks .row').length`) === 20, 'its chart is listed');
  check(await page.ev(`document.querySelectorAll('.card.ranked .rank').length`) === 8, 'its top artists come with their rank');
  check(await page.ev(`document.querySelectorAll('.cty-shelf .cty').length`) >= 5, 'and more countries to go to next');
  await page.ev(`document.querySelector('[data-act=play-collection]').click(); true`);
  await sleep(800);
  let p = await playing();
  check(p.href === '#/explore/NG' && p.label === 'Trending in Nigeria' && p.n === 20, `Play plays the chart (${p.label}, ${p.n} songs)`);
  await sleep(500);
  check(await page.ev(`!!JSON.parse(localStorage.getItem('openwave:passport:${session.profile.id}') || '{}').NG`), 'and Nigeria goes in the passport');

  console.log('Take me somewhere');
  await go('#/explore');
  await page.ev(`document.querySelector('[data-ex-go]').click(); true`);
  await sleep(500);
  check(await page.ev(`!!document.querySelector('.ex-flight path') && !!document.querySelector('.ex-plane')`), 'a line flies across the map');
  check(/^Flying to /.test(await page.ev(`document.querySelector('[data-ex-go] span').textContent`)), 'and the button says where to');
  await sleep(2500);
  const landed = await page.ev('location.hash');
  p = await playing();
  check(/^#\/explore\/[A-Z]{2}$/.test(landed) && landed !== '#/explore/NG' && p.href === landed, `it lands somewhere new and plays it (${landed})`);
  await page.ev(`document.querySelector('[data-ex-next]').click(); true`);
  await sleep(1500);
  const next = await page.ev('location.hash');
  check(next !== landed && /^#\/explore\/[A-Z]{2}$/.test(next) && (await playing()).href === next, `Next stop moves on (${next})`);
  await go('#/explore');
  check(await page.ev(`document.querySelectorAll('.stamp:not(.ghost)').length`) === 3, 'the passport has the three countries');
  check(await page.ev(`document.querySelector('.pass-ring b').textContent`) === '3', 'and counts them');

  // Calm (Reduce Motion): no flight, it just goes.
  await page.ev(`(async () => { (await import('./js/glass.js')).setFullMotion(false); })(); true`);
  await page.ev(`document.querySelector('[data-ex-go]').click(); true`);
  await sleep(200);
  check(!(await page.ev(`!!document.querySelector('.ex-plane')`)), 'with less motion, nothing flies');
  await sleep(1500);
  check(/^#\/explore\/[A-Z]{2}$/.test(await page.ev('location.hash')), 'but it still takes you somewhere');
  await page.ev(`(async () => { (await import('./js/glass.js')).setFullMotion(true); })(); true`);

  console.log('Playing from a tile');
  await go('#/explore');
  await page.ev(`document.querySelector('.cty [data-play-country="JP"]').click(); true`);
  await sleep(800);
  p = await playing();
  check(await page.ev('location.hash') === '#/explore' && p.href === '#/explore/JP', 'a tile’s play button plays Japan and stays on Explore');

  console.log('Genres and moods');
  await page.ev(`document.querySelector('.gtile').click(); true`);
  await sleep(1500);
  check(await page.ev(`document.querySelector('.hero.genre-hero h1')?.textContent`) === 'African', 'a genre opens its page');
  check(await page.ev(`document.querySelectorAll('.view .tracks .row').length`) === 20 && await page.ev(`document.querySelectorAll('.view .card').length`) >= 16, 'with its songs, playlists and albums');
  await page.ev(`document.querySelector('[data-act=play-collection-shuffle]').click(); true`);
  await sleep(600);
  p = await playing();
  check(p.n === 30 && p.label === 'African', `Shuffle plays all its songs (${p.n})`);
  await go('#/search');
  await page.ev(`document.querySelector('.mood-pill').click(); true`);
  await sleep(1500);
  check(await page.ev(`document.querySelector('.hero h1')?.textContent`) === 'Chill', 'a mood from Search opens too');

  console.log('Home');
  await go('#/home', 2500);
  check(await page.ev(`[...document.querySelectorAll('.section-head h2')].some((h) => h.textContent === 'Today in Nigeria')`), 'Home has today’s country');
  check(await page.ev(`(() => { const c = document.querySelector('.cty-card canvas'); return !!c && c.width > 0; })()`), 'led by its dotted shape');
  await page.ev(`document.querySelector('.cty-card').closest('.section').querySelector('.card[data-list]').click(); true`);
  await sleep(800);
  p = await playing();
  check(p.href === '#/explore/NG' && p.n === 12, `its songs play as Nigeria’s chart (${p.label})`);

  console.log('Phone');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
  await go('#/explore', 1800);
  const sc = await page.ev(`(() => { const s = document.querySelector('.ex-scroll'); return { wide: s.scrollWidth > s.clientWidth, left: s.scrollLeft }; })()`);
  check(sc.wide && sc.left > 0, `the map is wider than the phone and starts on your part of the world (scrolled ${Math.round(sc.left)}px)`);
  check(await page.ev(`document.querySelector('.tabbar [data-route~=explore]').classList.contains('on')`), 'Search stays lit in the tab bar');
  page.close();
} finally {
  chrome.proc.kill();
  engine.proc.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
if (errors.length) { console.log(`\nPage errors:\n${[...new Set(errors)].join('\n')}`); failures.push('page errors'); }
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exitCode = 1; } else console.log('\nThe world is one tap away.');
