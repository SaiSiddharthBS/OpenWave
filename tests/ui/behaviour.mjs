// Behaviour checks: things a person does in the app that have broken before and that a layout check
// can't see, such as a list disappearing a moment after it appears. Runs like layout_audit.mjs.
//
//   node tests/ui/behaviour.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, cdp, DATASETS, fake, seed, sleep, startChrome, startEngine, vid } from './harness.mjs';

const failures = [];
const annotate = (title, msg) => { if (process.env.GITHUB_ACTIONS) console.log(`::error title=${title}::${msg.replace(/\n/g, ' | ').slice(0, 900)}`); };
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };

const dir = mkdtempSync(join(tmpdir(), 'openwave-behaviour-'));
const engine = await startEngine(dir);
const chrome = await startChrome(dir);
try {
  const d = DATASETS.realistic, cat = catalogue(d);
  const answers = { suggest: ['arijit singh songs', 'arijit singh live', 'arijit singh new'], image: null };
  cat.search = ((search) => (q) => { answers.searched = q; return search(q); })(cat.search);
  const session = await seed(engine.base, d, cat);
  const page = await cdp(chrome.ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/*` }, { urlPattern: `${engine.base}/sw.js` }, { urlPattern: `${engine.base}/?webapp*` }] });
  page.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/app-update' && answers.update) {
      const body = Buffer.from(JSON.stringify(answers.update)).toString('base64');
      return page.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body }).catch(() => {});
    }
    if (url.searchParams.has('webapp')) {   // the page as the iPhone web app gets it, at the version being tested
      const html = (await (await fetch(`${engine.base}/`)).text()).replace('<head>', `<head><meta name="openwave-version" content="${answers.webVersion}">`);
      return page.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(html).toString('base64') }).catch(() => {});
    }
    if (url.pathname === '/api/suggest') {
      const body = Buffer.from(JSON.stringify(answers.suggest)).toString('base64');
      return page.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body }).catch(() => {});
    }
    const ans = request.url.endsWith('/sw.js') ? { status: 404, type: 'text/plain', body: Buffer.from('') } : fake(cat, request.url);
    if (!ans) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    page.send('Fetch.fulfillRequest', { requestId, responseCode: ans.status || 200, responseHeaders: [{ name: 'Content-Type', value: ans.type }], body: ans.body.toString('base64') }).catch(() => {});
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify(session))});` });
  const size = async (width, height, mobile) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
  };
  const type = async (text) => { for (const c of text) { await page.send('Input.insertText', { text: c }); await sleep(60); } };
  const key = (k) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 0, text: k === 'Enter' ? '\r' : undefined });
  const shown = `(() => { const s = document.querySelector('#suggest'); return !s.hidden && s.querySelectorAll('button').length; })()`;

  await size(1280, 820, false);
  await page.send('Page.navigate', { url: `${engine.base}/?behaviour#/play/${vid(1)}` });
  await sleep(3000);

  console.log('Search');
  await page.ev(`location.hash = '#/home'; true`);
  await sleep(900);
  await page.ev(`document.querySelector('#search-input').focus(); true`);
  await sleep(500);
  await type('arijit');
  await sleep(450);
  check(await page.ev(shown) > 0, 'suggestions appear while typing');
  await sleep(1500);
  check(await page.ev(shown) > 0, 'they stay on screen after the results below have updated');
  check(await page.ev(`document.querySelector('#search-input').value`) === 'arijit', 'what was typed stays in the box');
  check(await page.ev(`!!document.querySelector('#view .top-card, #view .row') && !document.querySelector('#view .skeleton')`), 'the results are there behind them');
  await sleep(1200);
  check(await page.ev(`![...document.querySelectorAll('#view .rv')].some((e) => { const r = e.getBoundingClientRect(); return r.height && r.bottom > 0 && r.top < innerHeight * .9; })`), 'and nothing in view is waiting to appear');
  await page.ev(`(() => { const b = document.querySelector('#suggest button'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); document.querySelector('#search-input').matches(':focus') || document.querySelector('#search-input').focus(); })(); true`);
  await sleep(400);
  check(await page.ev(shown) > 0, 'a slow press on a suggestion doesn\'t close the list');
  await page.ev(`document.querySelector('#suggest button').click(); true`);
  await sleep(1000);
  check(await page.ev(`location.hash`) === '#/search?q=arijit%20singh%20songs', 'choosing a suggestion searches for it');
  check(!(await page.ev(shown)), 'and closes the list');
  check(await page.ev(`!!document.querySelector('#view .top-card, #view .row')`), 'with the results showing');
  await page.ev(`document.querySelector('#search-input').focus(); document.querySelector('#search-input').select(); true`);
  await type('kesariya');
  await key('Enter');
  await sleep(1500);
  check(await page.ev(`location.hash`) === '#/search?q=kesariya', 'pressing Enter searches for what was typed');
  check(await page.ev(`!!document.querySelector('#view .top-card, #view .row') && !document.querySelector('#view .skeleton')`), 'and the results stay');
  await page.ev(`document.activeElement.blur(); location.hash = '#/home'; true`);
  await sleep(900);

  console.log('The top bar, the sidebar and Settings');
  await size(1280, 820, false);
  await page.ev(`location.hash = '#/home'; true`);
  await sleep(1200);
  check(!(await page.ev(`!!document.querySelector('.side-nav a[href="#/search"]')`)), 'the sidebar has no Search: the box at the top is search');
  const centred = await page.ev(`(() => { const b = document.querySelector('.searchbar').getBoundingClientRect(), m = document.querySelector('#main').getBoundingClientRect();
    return { off: Math.round(b.left + b.width / 2 - (m.left + m.width / 2)), width: Math.round(b.width) }; })()`);
  check(Math.abs(centred.off) <= 2 && centred.width >= 400, `the search box is in the middle of the page and wide (${centred.off}px off, ${centred.width}px)`);
  check(await page.ev(`getComputedStyle(document.querySelector('.top-actions')).display === 'none' && !!document.querySelector('.side-foot .side-me') && document.querySelector('[data-bind=me-name]').textContent.length > 0`),
    'you and Settings are at the foot of the sidebar, not in the top bar');
  const menuText = async (sel) => {
    await page.ev(`document.querySelector('${sel}').click(); true`);
    await sleep(500);
    const items = await page.ev(`[...document.querySelectorAll('#menu [data-mi]')].map((b) => b.textContent.trim())`);
    await page.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('#menu').hidden = true; true`);
    await sleep(200);
    return items;
  };
  const computerMenu = await menuText('.side-me');
  check(JSON.stringify(computerMenu) === JSON.stringify(['Import playlists…', 'Switch profile']), `the profile menu repeats nothing (${computerMenu.join(', ')})`);
  await page.ev(`document.querySelector('#search-input').focus(); true`);
  await type('abc');
  check(await page.ev(`!document.querySelector('#search-clear').hidden`), 'a clear button shows once something is typed');
  await page.ev(`document.querySelector('#search-clear').click(); true`);
  await sleep(300);
  check(await page.ev(`document.querySelector('#search-input').value === '' && document.activeElement === document.querySelector('#search-input') && document.querySelector('#search-clear').hidden`),
    'and clears the box, keeping it ready to type');
  await page.ev(`document.activeElement.blur(); location.hash = '#/settings'; true`);
  await sleep(1500);
  check(!(await page.ev(`!!document.querySelector('.settings select')`)), 'Settings has no browser dropdowns');
  await page.ev(`document.querySelector('[data-select=quality]').click(); true`);
  await sleep(500);
  const choices = await page.ev(`[...document.querySelectorAll('#menu [data-mi]')].map((b) => b.textContent.trim() + (b.classList.contains('pick-on') ? ' ✓' : ''))`);
  check(choices.length === 3 && choices.filter((c) => c.endsWith('✓')).length === 1, `Audio quality opens our own menu, with a tick on the one in use (${choices.join(', ')})`);
  await page.ev(`[...document.querySelectorAll('#menu [data-mi]')].find((b) => b.textContent.trim() === 'High').click(); true`);
  await sleep(400);
  check((await page.ev(`document.querySelector('[data-select=quality]').textContent.trim()`)) === 'High', 'choosing High shows it');
  await page.send('Page.reload');
  await sleep(3000);
  await page.ev(`location.hash = '#/settings'; true`);
  await sleep(1500);
  check((await page.ev(`document.querySelector('[data-select=quality]').textContent.trim()`)) === 'High', 'and it\'s kept after a restart');
  await page.ev(`document.querySelector('[data-select=crossfade]').click(); true`);
  await sleep(400);
  await page.ev(`[...document.querySelectorAll('#menu [data-mi]')].find((b) => b.textContent.trim() === '4 seconds').click(); true`);
  await sleep(300);
  check((await page.ev(`document.querySelector('[data-select=crossfade]').textContent.trim()`)) === '4 seconds', 'Crossfade works the same way');
  await size(390, 844, true);
  await sleep(500);
  await page.ev(`location.hash = '#/home'; true`);
  await sleep(1000);
  const phoneMenu = await menuText('#profile-chip');
  check(JSON.stringify(phoneMenu) === JSON.stringify(['Your insights', 'Import playlists…', 'Switch profile']), `on a phone it also has Insights, which a phone has no sidebar for (${phoneMenu.join(', ')})`);
  check(await page.ev(`document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]').content === 'default'`), 'the iPhone app asks for a solid status bar (see app.css)');
  await size(1280, 820, false);
  await page.ev(`location.hash = '#/home'; true`);
  await sleep(800);

  console.log('The player\'s title');
  for (const [name, w, h, mobile] of [['a phone', 390, 844, true], ['a small phone', 320, 568, true], ['an upright tablet', 768, 1024, true], ['a window', 1280, 820, false]]) {
    await size(w, h, mobile);
    await sleep(300);
    await page.ev(`document.querySelector('[data-act=open-np]').click(); true`);
    await sleep(1100);
    for (const linked of [false, true]) {
      await page.ev(`document.documentElement.classList.toggle('has-link', ${linked}); true`);
      await sleep(100);
      const off = await page.ev(`(() => { const r = document.querySelector('.np-from small').getBoundingClientRect(); return Math.round(r.left + r.width / 2 - innerWidth / 2); })()`);
      check(Math.abs(off) <= 1, `on ${name}${linked ? ', with the devices button,' : ''} "Playing from" is centred (${off}px off)`);
      const room = await page.ev(`Math.round(document.querySelector('.np-from').getBoundingClientRect().width)`);
      check(room >= 110, `  with room for the name of what's playing (${room}px)`);
      if (mobile) {
        const mid = await page.ev(`(() => { const r = document.querySelector('.np-sheet-mid').getBoundingClientRect(); return Math.round(r.left + r.width / 2 - innerWidth / 2); })()`);
        check(Math.abs(mid) <= 1, `  and Up next and Lyrics are centred below (${mid}px off)`);
        const lines = await page.ev(`[...document.querySelectorAll('.np-sheet-mid button')].map((b) => Math.round(b.getBoundingClientRect().height))`);
        check(lines.every((h) => h < 44), `  each on one line (${lines.join(', ')}px tall)`);
      }
    }
    await page.ev(`document.documentElement.classList.remove('has-link'); document.querySelector('[data-act=close-np]').click(); true`);
    await sleep(900);
  }
  await size(1280, 820, false);

  console.log('Closing the player');
  for (const [name, w, h, mobile] of [['a window', 1280, 820, false], ['a wide window', 1600, 1000, false], ['a phone', 390, 844, true]]) {
    await size(w, h, mobile);
    await sleep(400);
    await page.ev(`document.querySelector('[data-act=open-np]').click(); true`);
    await sleep(1100);
    // Where the artwork is sent, read from the animation itself, against where the mini player ends up.
    const flight = await page.ev(`(async () => {
      document.querySelector('[data-act=close-np]').click();
      await new Promise((r) => requestAnimationFrame(r));
      const art = document.querySelector('.np-art');
      const to = art.getAnimations().flatMap((a) => a.effect.getKeyframes()).map((k) => k.transform).find((t) => t?.startsWith('translate'));
      const r = art.getBoundingClientRect();
      const [, x, y] = to.match(/translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\)/);
      return { x: r.left + r.width / 2 + Number(x), y: r.top + r.height / 2 + Number(y) };
    })()`);
    await sleep(1100);
    const end = await page.ev(`(() => { const r = document.querySelector('.pb-art').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const miss = Math.round(Math.hypot(flight.x - end.x, flight.y - end.y));
    check(miss <= 3, `in ${name}, the artwork lands on the mini player (${miss}px away)`);
    check(await page.ev(`document.querySelector('#np').hidden && !document.querySelector('#playerbar').getAttribute('style')`), 'and the player bar is left as it was');
  }
  await size(1280, 820, false);

  console.log('A song restored at start-up');
  // As if the song had come from a list without lengths.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `for (const k of Object.keys(localStorage)) {
    if (!/queue/i.test(k)) continue;
    const s = JSON.parse(localStorage.getItem(k)); s.queue.forEach((t) => { delete t.duration; }); localStorage.setItem(k, JSON.stringify(s));
  }` });
  await page.send('Page.reload');
  await sleep(2500);
  const times = await page.ev(`[...document.querySelectorAll('[data-bind=dur]')].map((e) => e.textContent)`);
  check(times.length && times.every((t) => t !== '0:00'), `an unknown length doesn't show as 0:00 (${times[0]})`);


  console.log('Updates');
  const release = (latest) => ({ current: '0.5.0', latest, newer: true, available: true, device: 'windows', download: `${engine.base}/?downloaded`, page: 'https://example.com' });
  const card = `!document.querySelector('#update-card').hidden`;
  const told = `JSON.parse(sessionStorage.getItem('told') || '[]')`;
  await page.send('Browser.grantPermissions', { origin: engine.base, permissions: ['notifications'] });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.Notification = class { static permission = 'granted'; constructor(t) {
    sessionStorage.setItem('told', JSON.stringify([...JSON.parse(sessionStorage.getItem('told') || '[]'), t])); } };` });
  const restart = async () => { await page.send('Page.reload'); await sleep(9200); };
  answers.update = release('9.9.9');
  await restart();
  check(await page.ev(card), 'a new version brings up the card');
  check((await page.ev(`document.querySelector('#update-card').textContent`)).includes('9.9.9'), 'naming the version');
  check((await page.ev(told)).length === 1, 'and a system notification');
  await page.ev(`document.querySelector('[data-update=later]').click(); true`);
  check(!(await page.ev(card)), 'Later puts it away');
  await restart();
  check(!(await page.ev(card)), 'and it stays away after a restart');
  check((await page.ev(told)).length === 1, 'with no second notification for the same version');
  await page.ev(`(() => { const l = JSON.parse(localStorage.getItem('openwave.updateLater')); l.until = Date.now() - 1; localStorage.setItem('openwave.updateLater', JSON.stringify(l)); })(); true`);
  await restart();
  check(await page.ev(card), 'it comes back after a few days');
  answers.update = release('9.9.10');
  await page.ev(`document.querySelector('[data-update=later]').click(); true`);
  await restart();
  check(await page.ev(card), 'a newer version doesn\'t wait for Later');
  check((await page.ev(told)).length === 2, 'and gets its own notification');
  answers.update = { current: '9.9.10', latest: '9.9.10', newer: false, available: false, device: 'windows' };
  await restart();
  check(!(await page.ev(card)), 'nothing shows when you\'re up to date');
  answers.webVersion = '1.0.0';
  await page.send('Page.navigate', { url: `${engine.base}/?webapp=1` });
  await sleep(3000);
  const greeted = `document.querySelector('#toast')?.textContent || ''`;
  check(!(await page.ev(greeted)).includes('updated'), 'the web app says nothing the first time');
  answers.webVersion = '1.0.1';
  await page.send('Page.navigate', { url: `${engine.base}/?webapp=2` });
  await sleep(2000);
  check((await page.ev(greeted)).includes('updated to 1.0.1'), 'and says so when it has updated itself');

  page.close();
} finally {
  chrome.proc.kill();
  engine.proc.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); annotate('Behaviour', failures.join('; ')); process.exitCode = 1; } else console.log('\nEverything behaves.');
