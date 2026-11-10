// Smart mix in Chrome: real transitions between made-up songs (mixsongs.mjs), recorded as they
// leave the audio graph and measured. Each song ticks on every beat at its own pitch (this one at
// 2 kHz, the next at 5 kHz), so the recording shows exactly where each song's beats were heard.
//
//   node tests/ui/smartmix.mjs
//
// It plays in real time, about two minutes.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, cdp, DATASETS, fake, seed, sleep, startChrome, startEngine, vid } from './harness.mjs';
import { song, wav } from './mixsongs.mjs';

const failures = [];
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };

// The songs. A and B blend (124 and 127 BPM, A minor into C major); C is too slow to blend (100);
// D is a band that drifts.
const RATE = 22050;
const SONGS = {
  [vid(901)]: song({ bpm: 124, tonic: 9, minor: true, intro: 8, main: 22, outro: 4, rate: RATE, click: 2000, seed: 3 }),
  [vid(902)]: song({ bpm: +(process.env.MIX_B_BPM || 127), tonic: 0, intro: 8, main: 22, outro: 4, lead: 0.5, rate: RATE, click: 5000, seed: 5 }),
  [vid(903)]: song({ bpm: 100, tonic: 9, minor: true, intro: 4, main: 18, outro: 4, lead: 0.3, rate: RATE, click: 5000, seed: 7 }),
  [vid(904)]: song({ bpm: 124, drift: 0.04, intro: 4, main: 22, outro: 4, rate: RATE, click: 2000, seed: 11 }),
};
const FILES = Object.fromEntries(Object.entries(SONGS).map(([id, s]) => [id, wav(s)]));
const track = (n, title) => ({ type: 'song', videoId: vid(n), title, artists: [{ name: 'Smart Mix Test', id: 'UCmix' }],
  album: { name: `Album ${n}`, id: `MPREb_mix${n}` }, duration: Math.round(SONGS[vid(n)].length), thumbnail: '', explicit: false });

const dir = mkdtempSync(join(tmpdir(), 'openwave-smartmix-'));
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
  page.on('Runtime.consoleAPICalled', (e) => {
    if (e.type === 'error') errors.push(e.args.map((a) => a.value || a.description).join(' '));
    if (process.env.MIX_LOG && e.type === 'warning') console.log('warn:', e.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
  });
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${engine.base}/api/*` }, { urlPattern: `${engine.base}/sw.js` }] });
  page.on('Fetch.requestPaused', ({ requestId, request }) => {
    const u = new URL(request.url);
    const id = u.pathname.split('/').pop();
    let ans;
    if (u.pathname.startsWith('/api/stream/') && FILES[id]) {
      // Ranges, as the engine serves them, so the player can jump about in a song.
      const all = FILES[id], m = /bytes=(\d+)-(\d*)/.exec(request.headers.Range || request.headers.range || '');
      if (m) {
        const from = +m[1], to = m[2] ? Math.min(+m[2], all.length - 1) : all.length - 1;
        ans = { status: 206, type: 'audio/wav', body: all.subarray(from, to + 1), headers: [{ name: 'Content-Range', value: `bytes ${from}-${to}/${all.length}` }, { name: 'Accept-Ranges', value: 'bytes' }] };
      } else ans = { type: 'audio/wav', body: all, headers: [{ name: 'Accept-Ranges', value: 'bytes' }] };
    }
    else if (u.pathname.startsWith('/api/length/') && SONGS[id]) ans = { type: 'application/json', body: Buffer.from(JSON.stringify({ seconds: SONGS[id].length })) };
    else ans = request.url.endsWith('/sw.js') ? { status: 404, type: 'text/plain', body: Buffer.from('') } : fake(cat, request.url);
    if (!ans) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    page.send('Fetch.fulfillRequest', { requestId, responseCode: ans.status || 200, responseHeaders: [{ name: 'Content-Type', value: ans.type }, ...(ans.headers || [])], body: Buffer.from(ans.body).toString('base64') }).catch(() => {});
  });
  // Listen to what leaves the mixer (the app calls this when it makes its audio graph).
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('openwave:session:v2', ${JSON.stringify(JSON.stringify(session))});
    window.__rec = { chunks: [], rate: 0, on: false };
    window.__mixDebug = ${process.env.MIX_LOG ? 'true' : 'false'};

    window.__openwaveMixTap = (ctx, master) => {
      const sp = ctx.createScriptProcessor(4096, 1, 1), z = ctx.createGain();
      z.gain.value = 0; master.connect(sp); sp.connect(z); z.connect(ctx.destination);
      __rec.rate = ctx.sampleRate;
      sp.onaudioprocess = (e) => { if (__rec.on) __rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    };` });
  await page.send('Page.navigate', { url: `${engine.base}/#/home` });
  await sleep(3000);

  const P = `(await import('./js/player.js')).player`;
  const ev = (body) => page.ev(`(async () => { const player = ${P}; ${body} })()`);
  /** Play two songs; once the mix is planned, jump to just before it; wait for it to finish. */
  async function transition(a, b, { before = null } = {}) {
    await ev(`window.__rec.chunks = []; player.playList([${JSON.stringify(track(a, 'This song'))}, ${JSON.stringify(track(b, 'The next song'))}], 0, { label: 'Smart mix test' }); return true;`);
    let plan = null;
    for (let i = 0; i < 80 && !plan; i++) { await sleep(250); plan = await ev('return player.preloaded?.plan || null;'); }
    if (!plan) return { plan: null };
    // Jump only once the song is really playing (a jump while it loads is lost).
    for (let i = 0; i < 40 && !(await ev('return !player.el.paused && player.el.currentTime > 0.5;')); i++) await sleep(250);
    const lead = plan.style === 'blend' ? 4 * plan.barA + 5 : 6;
    await ev(`player.seek(${plan.outAt - lead - 2.5}); window.__rec.on = true; return true;`);
    if (before) return { plan, ...(await before()) };
    let done = null;
    for (let i = 0; i < 240 && !done; i++) {
      await sleep(250);
      if (process.env.MIX_LOG && i % 8 === 0) console.log('state', JSON.stringify(await ev(`const m = player.mix; return { phase: m?.phase, adv: m?.advanced, a: m?.out?.currentTime, b: m?.inc?.currentTime, endAt: m?.endAt, advanceAt: m?.advanceAt, last: !!player.lastMix, cur: player.current?.videoId };`)));
      done = await ev(`const m = player.lastMix; return m && !player.mix && m.plan.outAt === ${plan.outAt} ? { style: m.style, stats: m.stats || null, current: player.current?.videoId,
        decks: [...document.querySelectorAll('audio')].map((d) => ({ paused: d.paused, rate: d.playbackRate, t: d.currentTime })) } : null;`);
    }
    await sleep(2500); // the tail: an echo rings on after the mix is over
    await ev('window.__rec.on = false; return true;');
    if (process.env.MIX_LOG) console.log((await ev('return player.events.filter((e) => /mix|spare|seek|lock/.test(e)).slice(-90).join("\\n");')));
    return { plan, done };
  }
  /** Where each song's ticks were heard in the recording (seconds from its start). */
  const ticks = () => page.ev(`(() => {
    const { chunks, rate } = window.__rec;
    const n = chunks.reduce((s, c) => s + c.length, 0), x = new Float32Array(n);
    let o = 0; for (const c of chunks) { x.set(c, o); o += c.length; }
    const hop = Math.round(rate * 0.002), win = Math.round(rate * 0.016);
    const band = (hz) => { const out = []; const w = 2 * Math.cos(2 * Math.PI * hz / rate);
      for (let s = 0; s + win < n; s += hop) { let a = 0, b = 0; for (let i = 0; i < win; i++) { const v = x[s + i] + w * a - b; b = a; a = v; } out.push(a * a + b * b - w * a * b); }
      return out; };
    const onsets = (e, at = 0.25) => { const top = [...e].sort((p, q) => p - q)[Math.floor(e.length * 0.995)] || 1; const out = []; let armed = true;
      for (let i = 1; i < e.length; i++) { if (armed && e[i] > at * top) { out.push(i * hop / rate); armed = false; } else if (!armed && e[i] < 0.3 * at * top) armed = true; }
      return out; };
    const a = band(2000), b = band(5000);
    return { a: onsets(a), b: onsets(b), bandA: a, hop: hop / rate, length: n / rate };
  })()`);

  console.log('A blend (124 into 127 BPM)');
  if (process.env.MIX_ONLY !== 'echo') {
    const { plan, done } = await transition(901, 902);
    check(plan?.style === 'blend', `planned as a blend (${plan?.reason})`);
    check(done?.style === 'blend', 'played as a blend, not fallen back to a fade');
    check(done?.current === vid(902), 'the next song took over');
    check(done?.stats && done.stats.median < 6, `the decks held the beats together (${done?.stats?.median.toFixed(1)} ms typical, ${done?.stats?.max.toFixed(1)} ms worst)`);
    const t = await ticks();
    // Pair every tick of the next song with this song's nearest while both were heard.
    const pairs = t.b.map((tb) => { const ta = t.a.reduce((m, v) => (Math.abs(v - tb) < Math.abs(m - tb) ? v : m), Infinity); return tb - ta; })
      .filter((dt) => Math.abs(dt) < 0.15);
    const abs = pairs.map(Math.abs).sort((p, q) => p - q);
    const med = abs[abs.length >> 1] * 1000, p90 = abs[Math.floor(abs.length * 0.9)] * 1000;
    if (process.env.MIX_LOG) console.log('signed offsets (ms):', pairs.map((x) => (x * 1000).toFixed(0)).join(' '));
    check(pairs.length >= 12, `both songs heard together for ${pairs.length} beats`);
    check(med < 8 && p90 < 15, `heard beat for beat: ${med.toFixed(1)} ms apart typically, ${p90.toFixed(1)} ms at worst (of 9 in 10)`);
    check(done?.decks.filter((x) => !x.paused).length === 1, 'and afterwards only one deck plays');
    check(done?.decks.every((x) => x.rate === 1), 'at its own tempo again');
    if (process.env.MIX_ONLY === 'blend') throw new Error('stopping after the blend');
  }

  console.log('An echo out (124 into 100 BPM)');
  {
    const { plan, done } = await transition(901, 903);
    check(plan?.style === 'echo', `planned as an echo out (${plan?.reason})`);
    check(done?.current === vid(903), 'the next song took over');
    const t = await ticks();
    const beat = 60 / 124;
    // This song's ticks: on the beat until the cut, then the echo repeating the last one, fainter.
    // The next song's first beat: the first of its ticks that carries on at its own tempo.
    const beatB = 60 / 100, on = (x) => t.b.some((y) => Math.abs(y - x) < 0.02);
    const firstB = t.b.find((x) => on(x + beatB) && on(x + 2 * beatB));
    if (process.env.MIX_LOG) console.log('echo ticks a:', t.a.map((x) => x.toFixed(3)).join(' '), '\nb:', t.b.map((x) => x.toFixed(3)).join(' '));
    const lastOn = t.a.filter((x) => x < firstB - 0.02).at(-1);
    check(firstB != null && lastOn != null && Math.abs(firstB - lastOn - beat) < 0.03, `the next song lands on this one’s downbeat (${((firstB - lastOn - beat) * 1000).toFixed(0)} ms off)`);
    // The repeats: this song's tick sound, a beat apart after the cut, each standing well clear of
    // what's between them, and each quieter than the one before.
    const at = (x) => Math.max(...t.bandA.slice(Math.max(0, Math.round((x - 0.015) / t.hop)), Math.round((x + 0.015) / t.hop) + 1));
    const between = (x) => { const v = t.bandA.slice(Math.round((x + 0.12) / t.hop), Math.round((x + beat - 0.12) / t.hop)).sort((p, q) => p - q); return v[v.length >> 1] || 1e-12; };
    const repeats = [1, 2, 3].map((k) => ({ peak: at(lastOn + k * beat), floor: between(lastOn + k * beat) }));
    const clear = repeats.filter((r) => r.peak > 5 * r.floor).length;
    if (process.env.MIX_LOG) {
      console.log('repeats', repeats.map((r) => `${r.peak.toExponential(2)}/${r.floor.toExponential(2)}`).join(' '), 'tick', at(lastOn).toExponential(2));
      for (let k = 0; k <= 3; k++) { const x0 = lastOn + k * beat; const seg = []; for (let d = -0.03; d <= 0.06; d += 0.006) seg.push(t.bandA[Math.round((x0 + d) / t.hop)]?.toExponential(1)); console.log(k, seg.join(' ')); }
    }
    check(clear >= 2 && repeats[0].peak > repeats[1].peak && repeats[1].peak > repeats[2].peak,
      `and its last beat echoes away under it (${clear} of 3 repeats clear, each fainter)`);
  }

  console.log('A fade (a band that drifts, into the next song)');
  {
    const { plan, done } = await transition(904, 902);
    check(plan?.style === 'fade' && Math.abs(plan.outEnd - plan.outAt - 6) < 0.01, `planned as a six-second fade (${plan?.reason})`);
    check(done?.style === 'fade' && done?.current === vid(902), 'played as one, and the next song took over');
    const t = await ticks();
    const lastA = t.a.at(-1), firstB = t.b[0];
    // Ticks are counted while over half their full level: on equal-power curves over six seconds,
    // that's the middle two, when both are.
    check(firstB != null && lastA != null && lastA - firstB > 1.5 && lastA - firstB < 3.5, `the two cross over in the middle of the fade (${(lastA - firstB).toFixed(1)} s both clearly heard)`);
    check(done?.decks.filter((x) => !x.paused).length === 1, 'and then only the next song plays');
  }

  console.log('Stopping and skipping in the middle');
  {
    const r = await transition(901, 902, { before: async () => {
      for (let i = 0; i < 120; i++) { await sleep(250); if (await ev('return player.mix?.phase === "mix";')) break; }
      await sleep(1500);
      await ev('player.pause(); return true;');
      await sleep(400);
      return ev(`return { mix: !!player.mix, current: player.current?.videoId, decks: [...document.querySelectorAll('audio')].map((d) => ({ paused: d.paused, rate: d.playbackRate, vol: d.volume })) };`);
    } });
    check(r.mix === false && r.current === vid(901), 'pausing mid-mix stops the mix and stays on this song');
    check(r.decks?.every((x) => x.paused && x.rate === 1), 'with both decks stopped at their own tempo');
  }
  {
    const r = await transition(901, 902, { before: async () => {
      for (let i = 0; i < 120; i++) { await sleep(250); if (await ev('return player.mix?.phase === "mix";')) break; }
      await sleep(1000);
      await ev('player.next(); return true;');
      await sleep(400);
      return ev(`return { mix: !!player.mix, current: player.current?.videoId, playing: [...document.querySelectorAll('audio')].filter((d) => !d.paused).length, rate: player.el.playbackRate };`);
    } });
    check(r.mix === false && r.current === vid(902) && r.playing === 1, 'Next mid-mix lets the next song take over at once');
    check(r.rate === 1, '…at its own tempo');
  }

  console.log('When it stays out of the way');
  {
    await ev(`player.playList([${JSON.stringify({ ...track(901, 'A'), album: { name: 'One album', id: 'MPREb_same' } })}, ${JSON.stringify({ ...track(902, 'B'), album: { name: 'One album', id: 'MPREb_same' } })}], 0, { label: 'One album', href: '#/album/MPREb_same' }); return true;`);
    await sleep(7000);
    check(await ev('return !player.smartFor() && !player.preloaded?.plan;'), 'an album plays as it was made, with no mix');
    await ev(`(await import('./js/store.js')).store.setting('smartMix', false); player.playList([${JSON.stringify(track(901, 'A'))}, ${JSON.stringify(track(902, 'B'))}], 0, { label: 'Off' }); return true;`);
    await sleep(7000);
    check(await ev('return !player.smartFor() && !player.preloaded?.plan;'), 'and with Smart mix off in Settings, nothing is mixed');
    await ev(`(await import('./js/store.js')).store.setting('smartMix', true); player.pause(); return true;`);
  }

  check(!errors.length, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  chrome.proc.kill();
  engine.proc.kill();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll Smart mix checks passed');
process.exit(failures.length ? 1 : 0);
