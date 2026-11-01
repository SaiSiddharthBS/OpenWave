// OpenWave Connect, end to end, in a real browser: the website copy of the app on a "phone" plays
// from an engine it reaches only through a relay and a WebRTC data channel, as it would over the
// internet. Covers what a person does:
//
//   on the computer   Settings → Phones → Add a phone (QR code), seeing the phone connect, Remove
//   on the phone      opening the link, the Add to Home Screen step, choosing a profile, the
//                     library, coming back later (reconnects with its own key), Forget, pairing
//                     again, and being told when the computer stops answering
//
// and checks the new screens at phone and desktop sizes for anything past the edge of the screen.
//
//   node tests/ui/connect_e2e.mjs        # needs Chrome and the engine's Python (with websockets)
//
// Environment: OPENWAVE_PYTHON, CHROME (as for layout_audit.mjs), E2E_OUT (screenshots; default: a
// temp folder), E2E_YOUTUBE=1 to also search and play a real song through the connection (needs
// the internet; off in CI, where YouTube may refuse cloud servers), E2E_ENGINE to test a packaged
// engine instead of the source, e.g. macos/dist/OpenWave.app/Contents/Resources/server/openwave-server.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve, normalize } from 'node:path';
import { CHECK } from './overflow.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PY = process.env.OPENWAVE_PYTHON || (existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 OpenWaveAndroid/0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let failures = 0;

function ok(cond, what) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${what}`);
  if (!cond) failures++;
  return cond;
}

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(p)) return p;
  }
  throw new Error('Chrome not found: set CHROME=/path/to/chrome');
}

async function freePort() {
  return new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

async function waitFor(url, what, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`${what} did not start`);
}

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: ROOT, ...opts });
  procs.push(p);
  return p;
}

/** The website, served like GitHub Pages serves it. */
function serveSite(dir, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const server = createServer((req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(dir, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

/** A minimal Chrome DevTools Protocol client (Node's built-in WebSocket). */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { const { ok, fail } = pending.get(m.id); pending.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); }
  };
  const send = (method, params = {}) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, ev };
}

async function until(page, expr, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await page.ev(expr)) return true; } catch { /* page navigating */ }
    await sleep(250);
  }
  return false;
}

const SIZES = [
  { name: 'phone-320', width: 320, height: 568, mobile: true },
  { name: 'phone-390', width: 390, height: 844, mobile: true },
  { name: 'desktop-1280', width: 1280, height: 800, mobile: false },
];

async function shot(page, out, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
}

/** Check the screen that's open now at every size (without reloading it). */
async function layout(page, out, name, restore) {
  for (const vp of SIZES) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: vp.mobile });
    await sleep(400);
    const found = await page.ev(CHECK);
    if (!ok(!found.length, `${name} fits at ${vp.name}`)) {
      for (const f of found.slice(0, 5)) console.log(`      ${f.what} ${f.at} [${f.left}…${f.right}] ${f.text}`);
      await shot(page, out, `${name}-${vp.name}`);
    }
  }
  await page.send('Emulation.setDeviceMetricsOverride', restore);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'openwave-connect-e2e-'));
  const out = process.env.E2E_OUT || join(tmp, 'shots');
  mkdirSync(out, { recursive: true });
  try {
    // A private relay, the website, an engine, and Chrome.
    const relayProc = run(PY, ['tests/fake_relay.py', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const relay = await new Promise((ok, fail) => {
      relayProc.stdout.on('data', (b) => { const m = String(b).match(/relay on (ws:\S+)/); if (m) ok(m[1]); });
      relayProc.on('exit', () => fail(new Error('the relay did not start (is the websockets package installed?)')));
    });
    const build = run('python3', ['scripts/build-site.py', join(tmp, 'site')], { stdio: 'ignore' });
    await new Promise((ok, fail) => build.on('exit', (c) => (c ? fail(new Error('site build failed')) : ok())));
    const sitePort = await freePort();
    const site = await serveSite(join(tmp, 'site'), sitePort);
    const enginePort = await freePort();
    const engineCmd = process.env.E2E_ENGINE ? [process.env.E2E_ENGINE, []] : [PY, ['-m', 'openwave', '--no-browser']];
    run(engineCmd[0], [...engineCmd[1], '--host', '127.0.0.1', '--port', String(enginePort)], {
      env: { ...process.env, OPENWAVE_DATA: join(tmp, 'data'), OPENWAVE_LINK: '0', OPENWAVE_RELAYS: relay,
        OPENWAVE_CONNECT_APP: `http://127.0.0.1:${sitePort}/app-next/` },
      stdio: 'ignore' });
    const engine = `http://127.0.0.1:${enginePort}`;
    await waitFor(`${engine}/api/health`, 'The engine');
    const chromePort = await freePort();
    run(chromePath(), ['--headless=new', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${join(tmp, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
    await waitFor(`http://127.0.0.1:${chromePort}/json/version`, 'Chrome');
    const tab = async () => cdp((await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })).json()).webSocketDebuggerUrl);

    const api = async (path, method = 'GET', body) => {
      const r = await fetch(engine + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return r.json();
    };
    const maya = await api('/api/profiles', 'POST', { name: 'Maya' });
    await fetch(`${engine}/api/me/ops`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${maya.token}` },
      body: JSON.stringify({ ops: [{ op: 'like', track: { videoId: 'dQw4w9WgXcQ', title: 'A Liked Song', artists: [{ name: 'Someone' }], thumbnail: '' } }] }) });

    // ---------------------------------------------------------------- the computer
    console.log('On the computer');
    const desk = await tab();
    const DESK = { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false };
    await desk.send('Page.enable');
    await desk.send('Emulation.setDeviceMetricsOverride', DESK);
    await desk.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify({ token: maya.token, profile: maya.profile }))});` });
    await desk.send('Page.navigate', { url: `${engine}/#/settings` });
    ok(await until(desk, `!!document.querySelector('[data-act=connect-pair]')`), 'Settings shows Phones → Add a phone');
    await layout(desk, out, 'settings-phones', DESK);
    await desk.ev(`document.querySelector('[data-act=connect-pair]').click(); true`);
    ok(await until(desk, `!!document.querySelector('#dialog .pair-qr svg')`), 'Add a phone shows a QR code');
    const link = await desk.ev(`document.querySelector('#dialog .share-link input').value`);
    ok(link.startsWith(`http://127.0.0.1:${sitePort}/app-next/#connect=`), 'the code opens the OpenWave web app');
    await desk.ev(`document.querySelector('#dialog details').open = true; true`);
    await layout(desk, out, 'pair-dialog', DESK);
    await shot(desk, out, 'pair-dialog');

    // ---------------------------------------------------------------- the phone
    console.log('On the phone');
    const phone = await tab();
    const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
    await phone.send('Page.enable');
    await phone.send('Network.enable');
    await phone.send('Network.setUserAgentOverride', { userAgent: IPHONE, platform: 'iPhone' });
    await phone.send('Emulation.setDeviceMetricsOverride', PHONE);
    await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await phone.send('Page.bringToFront');
    await phone.send('Page.navigate', { url: link });
    ok(await until(phone, `document.querySelector('#connect-screen h1')?.textContent.includes('Home Screen')`), 'opened in Safari, it suggests adding OpenWave to the Home Screen');
    ok(await phone.ev(`location.hash.includes('connect=')`), '…while the address still holds the code (so the Home Screen copy is paired too)');
    await layout(phone, out, 'home-screen-step', PHONE);
    await shot(phone, out, 'home-screen-step');
    await phone.ev(`document.querySelector('[data-continue]').click(); true`);
    ok(await until(phone, `!!document.querySelector('.profile-tile[data-pid]')`, 30000), 'it connects and shows the computer’s profiles');
    ok(await phone.ev(`!location.hash.includes('connect=')`), 'the code is gone from the address afterwards');
    await desk.send('Page.bringToFront');
    ok(await until(desk, `!!document.querySelector('#dialog [data-state][data-ok]')`, 10000), 'the computer shows “iPhone is connected”');
    ok((await desk.ev(`document.querySelector('#dialog [data-state]').textContent`)).includes('iPhone'), '…naming it an iPhone');
    await desk.ev(`document.querySelector('#dialog [data-done]').click(); true`);
    await phone.send('Page.bringToFront');
    await phone.ev(`document.querySelector('.profile-tile[data-pid]').click(); true`);
    ok(await until(phone, `document.querySelector('.profiles-screen')?.hidden !== false && !!document.querySelector('#view')`, 15000), 'signs in to Maya');
    await phone.ev(`location.hash = '#/liked'; true`);
    ok(await until(phone, `document.querySelectorAll('#view .row').length === 1`, 15000), 'Maya’s liked songs arrive through the connection');
    const stored = await phone.ev(`JSON.parse(localStorage.getItem('openwave:connect'))`);
    ok(stored.paired && !stored.ticket && /^[0-9a-f]{64}$/.test(stored.secret), 'the phone keeps its own key, not the code');
    let st = await api('/api/connect');
    ok(st.devices.length === 1 && st.devices[0].label === 'iPhone' && st.devices[0].online, 'the computer lists one iPhone, connected now');

    if (process.env.E2E_YOUTUBE === '1') {
      await phone.ev(`location.hash = '#/search?q=' + encodeURIComponent('Coldplay Yellow'); true`);
      ok(await until(phone, `document.querySelectorAll('#view [data-act=play-track], #view .row').length > 0`, 30000), 'search works through the connection');
      await phone.ev(`(document.querySelector('#view .row') || document.querySelector('#view [data-act=play-track]')).click(); true`);
      ok(await until(phone, `(() => { const a = [...document.querySelectorAll('audio')].find((x) => !x.paused); return a && a.currentTime > 1 && a.src.startsWith('blob:'); })()`, 45000), 'a song plays (fetched whole over the connection)');
      ok(await until(phone, `[...document.images].some((i) => i.src.includes('api/img') && i.complete && i.naturalWidth > 0)`, 20000), 'artwork loads through the connection');
      await phone.ev(`(async () => { const { offline } = await import(new URL('js/offline.js', location.href).href);
        const { player } = await import(new URL('js/player.js', location.href).href); player.el.pause(); offline.download([player.current]); return true; })()`);
      ok(await until(phone, `(async () => { const { offline } = await import(new URL('js/offline.js', location.href).href); return offline.count === 1 && offline.queued === 0; })()`, 60000), 'a song downloads to the phone through the connection');
    }

    await phone.ev(`location.hash = '#/settings'; true`);
    ok(await until(phone, `!!document.querySelector('[data-act=connect-forget]')`), 'Settings on the phone shows which computer it plays from');
    ok(await phone.ev(`!document.querySelector('[data-act=connect-pair]') && !document.querySelector('[data-act=link-visible]')`), '…and not the computer’s own settings');
    await layout(phone, out, 'phone-settings', PHONE);

    // Coming back later: a reload reconnects with the phone's own key; nothing new is paired.
    await phone.send('Page.reload');
    ok(await until(phone, `!!document.querySelector('#view') && document.querySelector('.profiles-screen')?.hidden !== false && !document.querySelector('#connect-screen')`, 30000), 'coming back later, it reconnects and stays signed in');
    await phone.ev(`location.hash = '#/liked'; true`);
    ok(await until(phone, `document.querySelectorAll('#view .row').length === 1`, 15000), '…with the library there');
    st = await api('/api/connect');
    ok(st.devices.length === 1, '…as the same paired phone');

    // Only on this phone: Maya keeps her profile to herself; the computer can't list or open it.
    await phone.ev(`location.hash = '#/settings'; true`);
    ok(await until(phone, `!!document.querySelector('[data-act=profile-private][data-on]')`), 'Settings on the phone offers Only on this phone');
    await phone.ev(`document.querySelector('[data-act=profile-private]').click(); true`);
    await until(phone, `!!document.querySelector('#dialog [value=ok]')`);
    await phone.ev(`document.querySelector('#dialog [value=ok]').click(); true`);
    ok(await until(phone, `document.querySelector('[data-act=profile-private]')?.dataset.on === ''`, 10000), '…and turns it on');
    await layout(phone, out, 'phone-settings-private', PHONE);
    ok((await api('/api/profiles')).length === 0, 'the computer no longer lists Maya');
    ok((await fetch(`${engine}/api/me/library`, { headers: { authorization: `Bearer ${maya.token}` } })).status === 401, '…and its sign-in there stops working');
    st = await api('/api/connect');
    ok(JSON.stringify(st.devices[0].profiles) === '["Maya"]', 'Settings → Phones on the computer says the iPhone keeps Maya’s profile');
    await phone.send('Page.reload');
    ok(await until(phone, `!!document.querySelector('#view') && document.querySelector('.profiles-screen')?.hidden !== false && !document.querySelector('#connect-screen')`, 30000), 'the phone stays signed in to Maya');
    await phone.ev(`location.hash = '#/liked'; true`);
    ok(await until(phone, `document.querySelectorAll('#view .row').length === 1`, 15000), '…with her library');

    // Forget: the phone unpairs itself, everywhere.
    await phone.ev(`location.hash = '#/settings'; true`);
    await until(phone, `!!document.querySelector('[data-act=connect-forget]')`);
    await phone.ev(`document.querySelector('[data-act=connect-forget]').click(); true`);
    await until(phone, `!!document.querySelector('#dialog [value=ok]')`);
    ok((await phone.ev(`document.querySelector('#dialog p').textContent`)).includes('stops being kept on this phone'), 'Forget warns that Maya’s profile opens up again');
    await phone.ev(`document.querySelector('#dialog [value=ok]').click(); true`);
    ok(await until(phone, `document.querySelector('#connect-screen h1')?.textContent.includes('Play from your computer')`, 15000), 'Forget returns the phone to the pairing screen');
    await layout(phone, out, 'pair-screen', PHONE);
    await shot(phone, out, 'pair-screen');
    st = await api('/api/connect');
    ok(st.devices.length === 0, 'and the computer no longer lists it');
    ok((await api('/api/profiles')).some((p) => p.name === 'Maya' && !p.private), 'Maya’s profile can be opened on the computer again');
    const back = await api(`/api/profiles/${maya.profile.id}/login`, 'POST', {});
    await desk.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify({ token: back.token, profile: back.profile }))});` });

    // Pairing again by pasting a link, then the computer removes it.
    const fresh = (await api('/api/connect/pair', 'POST')).link;
    await phone.ev(`document.querySelector('#connect-link').value = ${JSON.stringify(fresh)}; document.querySelector('.connect-paste button').click(); true`);
    ok(await until(phone, `!!document.querySelector('.profile-tile[data-pid]')`, 30000), 'a pasted link pairs it again');
    await phone.ev(`document.querySelector('.profile-tile.add').click(); true`);
    ok(await until(phone, `!!document.querySelector('.new-profile [name=onlyhere]')`), 'a new profile made on the phone can be kept on it');
    await phone.ev(`document.querySelector('.new-profile [name=onlyhere]').click(); true`);
    ok(await phone.ev(`!document.querySelector('.only-here-hint').hidden`), '…explaining what that means');
    await layout(phone, out, 'new-profile-on-phone', PHONE);
    await shot(phone, out, 'new-profile-on-phone');
    await phone.ev(`document.querySelector('.new-profile [data-p=back]').click(); true`);
    await until(phone, `!!document.querySelector('.profile-tile[data-pid]')`);
    await phone.ev(`document.querySelector('.profile-tile[data-pid]').click(); true`);
    ok(await until(phone, `document.querySelector('.profiles-screen')?.hidden !== false && !!document.querySelector('#view')`, 15000), '…and Maya signs in again');
    st = await api('/api/connect');
    ok(st.devices.length === 1, 'the computer lists it again');
    await desk.send('Page.bringToFront');
    await desk.send('Page.reload');
    ok(await until(desk, `!!document.querySelector('[data-act=connect-remove]')`), 'the computer’s Settings lists the phone with Remove');
    await desk.ev(`document.querySelector('[data-act=connect-remove]').click(); true`);
    await until(desk, `!!document.querySelector('#dialog [value=ok]')`);
    await desk.ev(`document.querySelector('#dialog [value=ok]').click(); true`);
    ok(await until(desk, `!document.querySelector('[data-act=connect-remove]')`, 10000), 'Remove takes it off the list');
    await phone.send('Page.bringToFront');
    ok(await until(phone, `document.querySelector('#connect-status')?.dataset.state === 'offline'`, 60000), 'the removed phone says the computer didn’t answer, with Try again');
    ok(await phone.ev(`(() => { const r = document.querySelector('#connect-status [data-retry]').getBoundingClientRect();
      return document.querySelector('#connect-status').contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`), '…on top of everything else, where it can be tapped');
    await layout(phone, out, 'status-offline', PHONE);
    await shot(phone, out, 'status-offline');
    if (process.env.E2E_YOUTUBE === '1') {
      // The computer no longer answers this phone, but what it downloaded still plays.
      await phone.ev(`location.hash = '#/downloads'; true`);
      ok(await until(phone, `document.querySelectorAll('#view .row').length === 1`, 15000), 'Downloads lists the song while the computer is unreachable');
      await phone.ev(`document.querySelector('#view .row').click(); true`);
      ok(await until(phone, `(() => { const a = [...document.querySelectorAll('audio')].find((x) => !x.paused); return a && a.currentTime > 1; })()`, 20000), '…and it plays');
    }

    // ---------------------------------------------------------------- the Android app
    // The app loads the same phone app in its WebView, with window.OpenWaveAndroid (a stand-in here).
    console.log('In the Android app');
    // Its own storage, like the app's WebView (not the iPhone tab's, which is still open and retrying).
    const browser = await cdp((await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json()).webSocketDebuggerUrl);
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const droid = await cdp(`ws://127.0.0.1:${chromePort}/devtools/page/${targetId}`);
    await droid.send('Page.enable');
    await droid.send('Network.setUserAgentOverride', { userAgent: ANDROID, platform: 'Linux armv8l' });
    await droid.send('Emulation.setDeviceMetricsOverride', PHONE);
    await droid.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.OpenWaveAndroid = {
      calls: [], postMessage(j) { this.calls.push(['post', j]); }, getServer() { return ''; }, setServer(u) { this.calls.push(['setServer', u]); return ''; },
      appVersion() { return '0.0.1'; }, pairedComputer() { return true; }, useComputer() { this.calls.push(['useComputer']); return ''; },
      deviceName() { return 'Pixel'; }, haptic() {}, shareText() {}, shareFile() {}, addWidget() { return false; } };` });
    await droid.send('Page.bringToFront');
    await droid.send('Page.navigate', { url: (await api('/api/connect/pair', 'POST')).link });
    ok(await until(droid, `!!document.querySelector('.profile-tile[data-pid]')`, 30000), 'a pairing link pairs it straight away (no Home Screen step)');
    await droid.ev(`document.querySelector('.profile-tile[data-pid]').click(); true`);
    ok(await until(droid, `document.querySelector('.profiles-screen')?.hidden !== false && !!document.querySelector('#view')`, 15000), '…and Maya signs in');
    await droid.ev(`location.hash = '#/settings'; true`);
    ok(await until(droid, `!!document.querySelector('[data-act=connect-forget]')`), 'Settings shows which computer it plays from');
    ok(await droid.ev(`!!document.querySelector('[data-act=android-use-phone]') && !document.querySelector('[data-act=android-set-server]')`), '…with Use this phone, instead of the address setting');
    await layout(droid, out, 'android-settings', PHONE);
    await droid.ev(`document.querySelector('[data-act=android-use-phone]').click(); true`);
    ok(await droid.ev(`JSON.stringify(window.OpenWaveAndroid.calls.filter((c) => c[0] === 'setServer'))`) === '[["setServer",""]]', 'Use this phone hands back to the app’s own library');
    await droid.ev(`document.querySelector('[data-act=connect-forget]').click(); true`);
    await until(droid, `!!document.querySelector('#dialog [value=ok]')`);
    await droid.ev(`document.querySelector('#dialog [value=ok]').click(); true`);
    ok(await until(droid, `!!document.querySelector('#connect-screen [data-local]')`, 15000), 'the pairing screen offers Use this phone instead, so nobody gets stuck there');
    await layout(droid, out, 'android-pair-screen', PHONE);
    await shot(droid, out, 'android-pair-screen');
    ok((await api('/api/connect')).devices.length === 0, 'Forget unpaired it on the computer too');
    // A link shared to the app while it's open changes only the part after the #: it still pairs.
    const shared = (await api('/api/connect/pair', 'POST')).link;
    await droid.ev(`location.hash = ${JSON.stringify(new URL(shared).hash)}; true`);
    ok(await until(droid, `!!document.querySelector('.profile-tile[data-pid]')`, 30000), 'a link that arrives while the app is open pairs it too');
    ok((await api('/api/connect')).devices.length === 1, '…and the computer lists it');

    site.close();
  } finally {
    for (const p of procs) try { p.kill(); } catch { /* gone */ }
    await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode ? null : new Promise((r) => { p.once('exit', r); setTimeout(r, 5000); }))));
    if (!process.env.E2E_OUT && !failures) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  if (failures) {
    console.log(`\n${failures} check(s) failed. Screenshots: ${out}`);
    process.exitCode = 1;
  } else {
    console.log('\nOpenWave Connect works end to end.');
  }
}

main().catch((e) => {
  console.error(e);
  for (const p of procs) try { p.kill(); } catch { /* gone */ }
  process.exit(1);
});
