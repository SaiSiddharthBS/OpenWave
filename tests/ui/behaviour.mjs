// Behaviour checks: things a person does in the app that have broken before and that a layout check
// can't see, such as a list disappearing a moment after it appears. Runs like layout_audit.mjs.
//
//   node tests/ui/behaviour.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, cdp, DATASETS, fake, seed, sleep, startChrome, startEngine, vid } from './harness.mjs';

const failures = [];
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
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/*` }, { urlPattern: `${engine.base}/sw.js` }] });
  page.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const url = new URL(request.url);
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
      const a = art.getAnimations()[0];
      const to = a.effect.getKeyframes().at(-1).transform;
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

  page.close();
} finally {
  chrome.proc.kill();
  engine.proc.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exitCode = 1; } else console.log('\nEverything behaves.');
