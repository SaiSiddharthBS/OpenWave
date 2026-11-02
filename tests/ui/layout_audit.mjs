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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, cdp, DATASETS, fake, seed, sleep, startChrome, startEngine, vid } from './harness.mjs';
import { CHECK, STUCK } from './overflow.mjs';

// ------------------------------------------------------------------ the check

// Everything laid out past the left or right edge of the window. Being cut off by an
// overflow-hidden frame still counts (that is how the bug looks: the end time is clipped
// at the edge). Only two kinds of clipping are fine: a container the user can scroll
// sideways (shelves), and text that ends in "…" on purpose.

const ONLY = (process.env.AUDIT_ONLY || '').split(',').filter(Boolean);
const wanted = (x) => { const name = x.name || x; const pool = name in DATASETS ? Object.keys(DATASETS) : VIEWPORTS.map((v) => v.name);
  return !ONLY.some((o) => pool.includes(o)) || ONLY.includes(name); };

const VIEWPORTS = [
  { name: 'phone-320', width: 320, height: 568, mobile: true },
  { name: 'phone-360', width: 360, height: 780, mobile: true },
  { name: 'phone-375', width: 375, height: 667, mobile: true },
  { name: 'phone-390', width: 390, height: 844, mobile: true },
  { name: 'phone-412', width: 412, height: 915, mobile: true },
  { name: 'tablet-600', width: 600, height: 960, mobile: true },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true },
  { name: 'tablet-834', width: 834, height: 1194, mobile: true },
  { name: 'tablet-1024', width: 1024, height: 768, mobile: true },
  { name: 'tablet-1180', width: 1180, height: 820, mobile: true },
  { name: 'phone-sideways', width: 844, height: 390, mobile: true },
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
  { name: 'daily-mix', hash: '#/daily/1', route: 'library', expect: '.view .row' },
  { name: 'insights', hash: '#/insights', route: 'insights', expect: '.view h1' },
  { name: 'settings', hash: '#/settings', route: 'settings', expect: '.view [data-act=connect-remove]' },
  { name: 'tailscale-code', hash: '#/settings', route: 'settings', steps: [`document.querySelector('[data-act=tailscale-code]').click()`], expect: '#dialog .pair-qr svg' },
  { name: 'add-a-phone', hash: '#/settings', route: 'settings', steps: [`document.querySelector('[data-act=connect-pair]').click()`, `document.querySelector('#dialog details').open = true`], expect: '#dialog .pair-qr svg' },
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
    // As on most devices, whatever this computer's own Reduce Motion setting says.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
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
        // Give slower screens (e.g. lyrics loading) up to 5 s to finish before judging them.
        let missing = stepError || await page.ev(opened(sc));
        for (let i = 0; missing && !stepError && i < 20; i++) { await sleep(250); missing = await page.ev(opened(sc)); }
        const found = missing ? [{ what: 'open', at: `the screen did not open: ${missing}`, left: 0, right: 0, text: '' }] : await page.ev(CHECK);
        // Nothing may stay faded out waiting to animate in, here or at the bottom of the page.
        for (const y of ['0', '1e6']) {
          if (missing) break;
          await page.ev(`document.querySelector('#main').scrollTop = ${y}; true`);
          await sleep(350);
          const stuck = await page.ev(STUCK);
          if (stuck) found.push({ what: 'hidden', at: `${stuck} piece(s) of the page never animated in (scrolled to ${y})`, left: 0, right: 0, text: '' });
        }
        await page.ev(`document.querySelector('#main').scrollTop = 0; true`);
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
