// Run in the Windows app's window by the build's check (desktop.yml, OPENWAVE_SELFTEST): it plays a
// tone with a title, so Windows' media controls can be checked for OpenWave, and reports back.
(async () => {
  for (let i = 0; i < 100 && !window.pywebview?.api?.selftest_report; i++) await new Promise((r) => setTimeout(r, 200));
  const report = (m) => window.pywebview.api.selftest_report(String(m));
  try {
    report('bridge: open ' + typeof window.pywebview.api.open);
    const rate = 8000, n = rate * 30, b = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    text(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); text(36, 'data'); b.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / rate)), true);
    const a = new Audio(URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' })));
    a.loop = true;
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'OpenWave media test', artist: 'OpenWave' });
    navigator.mediaSession.setActionHandler('pause', () => { a.pause(); report('pause key reached the page'); });
    await a.play();
    report('playing: ' + !a.paused);
  } catch (e) { report('error: ' + e); }
})();
