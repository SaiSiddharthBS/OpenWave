// Motion audit: scrolls, flings and opens things the way a thumb does, on a phone-sized window with
// the processor slowed down, and records what the page's main thread had to do. A finger only stays
// smooth if the page stays out of its way, so this counts the work that can make a scroll stutter:
// layouts, repaints and long tasks, and fails if the bars at the bottom of the screen animate anything
// that needs them. It can't measure the graphics chip: that needs a real phone.
//
//   node tests/ui/motion_audit.mjs            # needs Chrome and the engine's Python
//
// Environment: as for layout_audit.mjs, plus MOTION_CPU (how many times slower; default 4) and
// MOTION_JSON (write the numbers to this file).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, cdp, DATASETS, fake, seed, sleep, startChrome, startEngine, vid } from './harness.mjs';

const CPU = Number(process.env.MOTION_CPU || 4);
const SONGS = 300;           // a long playlist, far past what fits on screen

const CATEGORIES = ['devtools.timeline', 'blink.animations', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'toplevel', '__metadata',
  ...(process.env.MOTION_WHY ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : [])].join(',');

/** Ten minutes of silence, so that the song doesn't change in the middle of a measurement. */
function silence(seconds) {
  const rate = 2000, n = rate * seconds, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}

async function record(page, act) {
  const events = [];
  page.on('Tracing.dataCollected', ({ value }) => events.push(...value));
  const done = new Promise((ok) => page.on('Tracing.tracingComplete', ok));
  await page.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: CATEGORIES.split(',') } });
  await act();
  await page.send('Tracing.end');
  await done;
  return events;
}

/** What the page's main thread did, from a trace. */
function summarise(events) {
  const mains = new Map();
  for (const e of events) if (e.name === 'thread_name' && e.args?.name === 'CrRendererMain') mains.set(`${e.pid}:${e.tid}`, 0);
  for (const e of events) { const k = `${e.pid}:${e.tid}`; if (mains.has(k) && e.name === 'FunctionCall') mains.set(k, mains.get(k) + 1); }
  const main = [...mains].sort((a, b) => b[1] - a[1])[0]?.[0];
  const on = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X');
  const sum = (names) => {
    const hits = on.filter((e) => names.includes(e.name));
    return { n: hits.length, ms: Math.round(hits.reduce((t, e) => t + (e.dur || 0), 0) / 1000) };
  };
  const tasks = on.filter((e) => e.name === 'RunTask');
  const longest = Math.round(Math.max(0, ...tasks.map((e) => e.dur || 0)) / 1000);
  return {
    busyMs: Math.round(tasks.reduce((t, e) => t + (e.dur || 0), 0) / 1000),
    longestMs: longest,
    over16: tasks.filter((e) => e.dur > 16000).length,
    layout: sum(['Layout']),
    style: sum(['UpdateLayoutTree']),
    paint: sum(['Paint', 'PrePaint', 'Layerize']),
    commit: sum(['Commit']),
    script: sum(['FunctionCall', 'FireAnimationFrame']),
  };
}

/** What asked for that work, most often first (MOTION_WHY=1). */
function why(events) {
  const tally = new Map();
  const add = (k, n = 1) => tally.set(k, (tally.get(k) || 0) + n);
  for (const e of events) {
    const d = e.args?.data || e.args?.beginData || {};
    if (e.name === 'FunctionCall') add(`script ${d.functionName || '?'} ${(d.url || '').split('/').pop()}:${d.lineNumber}`);
    else if (e.name === 'EventDispatch') add(`event ${d.type}`);
    else if (e.name === 'FireAnimationFrame') add('requestAnimationFrame');
    else if (e.name === 'TimerFire') add('timer');
    else if (e.name === 'ScheduleStyleRecalculation') add(`style asked for`);
    else if (e.name === 'InvalidateLayout') add('layout asked for');
    else if (e.name === 'UpdateLayoutTree' && e.ph === 'X') add('style: elements', e.args?.elementCount || 0);
    else if (e.name === 'Layout' && e.ph === 'X') add('layout: dirty objects', e.args?.beginData?.dirtyObjects || 0);
    else if (e.name === 'IntersectionObserverController::computeIntersections') add('intersection checks');
    else if (e.name === 'ResourceReceiveResponse' || e.name === 'ResourceFinish') add('image or file arrived');
    else if (e.name === 'Decode Image' || e.name === 'ImageDecodeTask') add('image decoded');
    else if (e.name === 'Animation' && e.ph === 'b') add(`animation ${d.name || ''} ${d.compositeFailed ? `NOT composited (${d.compositeFailed} ${d.unsupportedProperties || ''})` : ''}`);
  }
  const stacks = new Map();
  for (const e of events) {
    if (!['InvalidateLayout', 'ScheduleStyleRecalculation'].includes(e.name)) continue;
    const f = (e.args?.data?.stackTrace || e.args?.data?.stack || [])[0];
    const k = `${e.name === 'InvalidateLayout' ? 'layout' : 'style'} from ${f ? `${f.functionName} ${(f.url || '').split('/').pop()}:${f.lineNumber}` : 'the browser itself'}`;
    stacks.set(k, (stacks.get(k) || 0) + 1);
  }
  for (const [k, n] of stacks) add(k, n);
  const names = new Map();
  for (const e of events) if (e.ph === 'X' && e.dur > 200) names.set(e.name, (names.get(e.name) || 0) + e.dur / 1000);
  add(`TIME ${[...names].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, ms]) => `${k}=${Math.round(ms)}`).join('  ')}`, 1e6);
  return [...tally].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `      ${String(n).padStart(5)}  ${k.slice(0, 420)}`).join('\n');
}

const fling = (page, distance, speed = 3000) => page.send('Input.synthesizeScrollGesture',
  { x: 180, y: 420, yDistance: distance, speed, gestureSourceType: 'touch' });
const open = async (page, hash, ready) => {
  await page.ev(`location.hash = ${JSON.stringify(hash)}; true`);
  for (let i = 0; i < 40 && !await page.ev(`!!document.querySelector(${JSON.stringify(ready)}) && !document.querySelector('#view .skeleton')`); i++) await sleep(100);
  await sleep(1300);       // whatever arrives with the page has finished
  await page.ev(`document.querySelector('#main').scrollTop = 0; document.body.classList.remove('tabs-min'); true`);
  await sleep(300);
};

// Only these can animate beside the page, without redoing its layout or repainting on every frame.
const CHEAP = ['transform', 'opacity', 'translate', 'scale', 'rotate', 'offset', 'easing', 'composite', 'computedOffset'];
const EXPENSIVE = `document.getAnimations().flatMap((a) => {
  const who = a.effect.target?.className?.baseVal ?? a.effect.target?.className ?? a.effect.target?.tagName;
  const props = a.transitionProperty ? [a.transitionProperty] : a.effect.getKeyframes().flatMap(Object.keys);
  return props.filter((p) => !${JSON.stringify(CHEAP)}.includes(p)).map((p) => who + ' animates ' + p);
})`;

const SCENES = [
  { name: 'home: slow scroll', setup: (p) => open(p, '#/home', '.view .quick .row'),
    act: async (p) => { await fling(p, -1500, 800); await sleep(300); } },
  { name: 'home: fling down and back', setup: (p) => open(p, '#/home', '.view .quick .row'),
    act: async (p) => { await fling(p, -2500); await fling(p, 2500); await sleep(300); } },
  { name: 'long playlist: fling', setup: (p) => open(p, '#/playlist/PLaudit', '.view .row'),
    act: async (p) => { await fling(p, -6000, 5000); await fling(p, 4000, 5000); await sleep(300); } },
  { name: 'open a long playlist', setup: (p) => open(p, '#/home', '.view .quick .row'),
    act: async (p) => { await p.ev(`location.hash = '#/playlist/PLaudit'; true`); await sleep(1500); } },
  { name: 'tab bar tucks away', setup: (p) => open(p, '#/home', '.view .quick .row'),
    act: async (p) => { await fling(p, -500, 1000); await sleep(100); await fling(p, 300, 1000); await sleep(700); },
    check: async (p) => {
      await p.ev(`document.body.classList.toggle('tabs-min'); document.body.offsetHeight; true`);
      problems.push(...await p.ev(EXPENSIVE));
      await sleep(800);
    } },
  { name: 'tap to another page', setup: (p) => open(p, '#/home', '.view .quick .row'),
    act: async (p) => { await p.ev(`document.querySelector('.tabbar a[href="#/library"]').click(); true`); await sleep(1400); } },
  { name: 'open and close the player', setup: (p) => open(p, '#/home', '.view .quick .row'),
    act: async (p) => {
      await p.ev(`document.querySelector('[data-act=open-np]').click(); true`); await sleep(900);
      await p.ev(`document.querySelector('[data-act=close-np]').click(); true`); await sleep(700);
    } },
  { name: 'idle, song playing', setup: (p) => open(p, '#/home', '.view .quick .row'),
    act: async () => { await sleep(3000); } },
];

const problems = [];
const dir = mkdtempSync(join(tmpdir(), 'openwave-motion-'));
const engine = await startEngine(dir);
const chrome = await startChrome(dir);
const results = {};
try {
  const d = DATASETS.realistic, cat = catalogue(d);
  cat.playlist = { ...cat.playlist, trackCount: SONGS, tracks: cat.songs(1000, SONGS) };
  const session = await seed(engine.base, d, cat);
  const page = await cdp(chrome.ws);
  await page.send('Page.enable');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/*` }, { urlPattern: `${engine.base}/sw.js` }] });
  page.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const ans = request.url.endsWith('/sw.js') ? { status: 404, type: 'text/plain', body: Buffer.from('') }
      : request.url.includes('/api/stream/') ? { type: 'audio/wav', body: silence(600) } : fake(cat, request.url);
    if (!ans) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    page.send('Fetch.fulfillRequest', { requestId, responseCode: ans.status || 200,
      responseHeaders: [{ name: 'Content-Type', value: ans.type }, { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Cache-Control', value: 'max-age=3600' }],
      body: ans.body.toString('base64') }).catch(() => {});
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify(session))});` });
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 OpenWaveAndroid/0.5.0' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Page.navigate', { url: `${engine.base}/?motion#/play/${vid(1)}` });
  await sleep(3000);
  await page.send('Emulation.setCPUThrottlingRate', { rate: CPU });

  const line = (name, r) => `${name.padEnd(28)} ${String(r.busyMs).padStart(6)} ${String(r.longestMs).padStart(6)} ${String(r.over16).padStart(5)} `
    + `${`${r.layout.n}/${r.layout.ms}`.padStart(10)} ${`${r.style.n}/${r.style.ms}`.padStart(10)} ${`${r.paint.n}/${r.paint.ms}`.padStart(10)} ${String(r.commit.n).padStart(7)} ${`${r.script.n}/${r.script.ms}`.padStart(10)}`;
  console.log(`Main thread, processor ${CPU}x slower. n/ms = how many times / total milliseconds.\n`);
  console.log(`${'scene'.padEnd(28)} ${'busy'.padStart(6)} ${'worst'.padStart(6)} ${'>16ms'.padStart(5)} ${'layout'.padStart(10)} ${'style'.padStart(10)} ${'paint'.padStart(10)} ${'commits'.padStart(7)} ${'script'.padStart(10)}`);
  for (const s of SCENES) {
    await s.setup(page);
    const events = await record(page, () => s.act(page));
    results[s.name] = summarise(events);
    console.log(line(s.name, results[s.name]));
    if (process.env.MOTION_WHY) console.log(why(events));
    await s.check?.(page);
  }
  page.close();
} finally {
  chrome.proc.kill();
  engine.proc.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
for (const p of new Set(problems)) console.log(`Not smooth: ${p}`);
if (problems.length) process.exitCode = 1;
else console.log('\nThe bars move with transforms and opacity only.');
if (process.env.MOTION_JSON) writeFileSync(process.env.MOTION_JSON, JSON.stringify(results, null, 1));
