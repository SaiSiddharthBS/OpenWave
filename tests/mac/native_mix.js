// Smart mix in the Mac app, through macOS's own audio engine (NativeAudio.swift): run by
// tests/mac/native_mix.mjs, which starts a throwaway engine and a test copy of the app with
// OPENWAVE_TEST_SCRIPT pointing here. It signs in, plays two made-up songs (tests/ui/mixsongs.mjs)
// from the test's own server into each other, and reports what happened there.
(async () => {
  const HOME = window.__mixTestServer || 'http://127.0.0.1:47141';
  window.__mixTestTrace = false;
  window.__mixDebug = true;
  const report = (o) => fetch(`${HOME}/report`, { method: 'POST', body: JSON.stringify(o) }).catch(() => {});
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!location.port || !window.OpenWaveNativeAudio) return;
  try {
    if (!localStorage.getItem('openwave:session:v2')) {
      const r = await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mix test', pin: null, color: '#7b7bff' }) });
      const made = await r.json();
      localStorage.setItem('openwave:session:v2', JSON.stringify({ token: made.token, profile: made.profile }));
      location.reload();
      return;
    }
    await wait(3000);
    const { player } = await import(new URL('/js/player.js', location.href).href);
    const { NATIVE } = await import(new URL('/js/native-deck.js', location.href).href);
    report({ step: 'started', native: NATIVE });
    const mixjs = await import(new URL('/js/mix.js', location.href).href);
    if (window.__mixTestTrace) setInterval(() => report({ step: 'trace', cur: player.current?.videoId, t: player.el.currentTime, spare: player.spare.s, spareSrc: player.spare.getAttribute('src'),
      pre: player.preloaded && { ready: player.preloaded.ready, index: player.preloaded.index, plan: player.preloaded.plan?.style },
      known: { a: !!mixjs.knownAnalysis('a', 'native'), b: !!mixjs.knownAnalysis('b', 'native') }, smart: player.smartFor(), ev: player.events.slice(-4) }), 5000);
    const song = (id, title) => ({ type: 'song', videoId: id, title, artists: [{ name: 'Mix test', id: 'UCmix' }], album: { name: id, id: `MPREb_${id}` },
      duration: 67, thumbnail: '', explicit: false });
    player.streamUrl = (id) => `${HOME}/songs/${id}.m4a`;
    const pairs = (await (await fetch(`${HOME}/pairs`)).json());
    for (const [a, b] of pairs) {
      player.playList([song(a, 'This song'), song(b, 'The next song')], 0, { label: 'Smart mix test' });
      let plan = null;
      for (let i = 0; i < 160 && !plan; i++) { await wait(250); plan = player.preloaded?.plan || null; }
      if (!plan) { report({ step: 'no plan', a, b, log: player.events.slice(-30) }); continue; }
      for (let i = 0; i < 40 && !(!player.el.paused && player.el.currentTime > 0.5); i++) await wait(250);
      const lead = plan.style === 'blend' ? 4 * plan.barA + 5 : 6;
      await fetch(`${HOME}/mark?a=${a}&b=${b}`);
      player.seek(plan.outAt - lead - 2.5);
      let done = null;
      for (let i = 0; i < 240 && !done; i++) {
        await wait(250);
        const m = player.lastMix;
        if (m && !player.mix && m.plan.outAt === plan.outAt) done = m;
      }
      await wait(2500);
      report({ step: 'mixed', a, b, plan: { style: plan.style, reason: plan.reason, outAt: plan.outAt }, style: done?.style, stats: done?.stats || null,
        current: player.current?.videoId,
        log: player.events.filter((e) => /mix|lock|error/.test(e)).slice(-20) });
      player.pause();
      await wait(1000);
    }
    report({ step: 'done' });
  } catch (e) {
    report({ step: 'error', error: String(e?.stack || e) });
  }
})();
