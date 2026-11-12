// Smart mix in the Mac app, played by macOS's own audio engine and recorded as it leaves the mixer.
// Mac only (needs the Swift toolchain and ffmpeg). Not in CI: it opens a test copy of the app.
//
//   (cd macos && swift build) && node tests/mac/native_mix.mjs
//
// The test copy has its own app identity and data, is silent (OPENWAVE_AUDIO_MUTE), records the
// mixer's output (OPENWAVE_AUDIO_RECORD) and runs tests/mac/native_mix.js in its page, against a
// throwaway engine. The songs are made up (tests/ui/mixsongs.mjs) and tick on every beat at their
// own pitch, so the recording shows where each one's beats were heard.

import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startEngine } from '../ui/harness.mjs';
import { song, wav } from '../ui/mixsongs.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const failures = [];
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };
const dir = mkdtempSync(join(tmpdir(), 'openwave-native-mix-'));

// ------------------------------------------------------------------ the songs, as AAC
const SONGS = {
  a: song({ bpm: 124, tonic: 9, minor: true, intro: 8, main: 22, outro: 4, rate: 44100, click: 2000, seed: 3 }),
  b: song({ bpm: 127, tonic: 0, intro: 8, main: 22, outro: 4, lead: 0.5, rate: 44100, click: 5000, seed: 5 }),
  c: song({ bpm: 100, tonic: 9, minor: true, intro: 4, main: 18, outro: 4, lead: 0.3, rate: 44100, click: 3500, seed: 7 }),
};
const FILES = {};
for (const [id, s] of Object.entries(SONGS)) {
  writeFileSync(join(dir, `${id}.wav`), wav(s));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, `${id}.wav`), '-c:a', 'aac', '-b:a', '192k', join(dir, `${id}.m4a`)]);
  FILES[id] = readFileSync(join(dir, `${id}.m4a`));
}

// ------------------------------------------------------------------ the test's server
const reports = [];
let finished;
const allDone = new Promise((r) => { finished = r; });
const server = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  r.setHeader('Access-Control-Allow-Origin', '*');
  if (u.pathname === '/pairs') return r.end(JSON.stringify([['a', 'b'], ['a', 'c']]));
  if (u.pathname === '/mark') return r.end('{}');
  if (u.pathname === '/report') {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => {
      const m = JSON.parse(body || '{}');
      reports.push(m);
      console.log(`  · ${m.step}${m.style ? ` (${m.style})` : ''}${m.step !== 'mixed' ? ` ${JSON.stringify(m).slice(0, 400)}` : ''}`);
      if (m.step === 'done' || m.step === 'error') finished();
      r.end('{}');
    });
    return;
  }
  const id = u.pathname.match(/^\/songs\/(\w+)\.m4a$/)?.[1];
  if (!id || !FILES[id]) { r.statusCode = 404; return r.end(); }
  const all = FILES[id], m = /bytes=(\d+)-(\d*)/.exec(q.headers.range || '');
  r.setHeader('Content-Type', 'audio/mp4');
  r.setHeader('Accept-Ranges', 'bytes');
  if (m) {
    const a = +m[1], b = m[2] ? Math.min(+m[2], all.length - 1) : all.length - 1;
    r.statusCode = 206;
    r.setHeader('Content-Range', `bytes ${a}-${b}/${all.length}`);
    return r.end(all.subarray(a, b + 1));
  }
  r.end(all);
});
await new Promise((ok) => server.listen(47141, '127.0.0.1', ok));

// ------------------------------------------------------------------ a test copy of the app
const binary = join(ROOT, 'macos/.build/debug/OpenWave');
if (!existsSync(binary)) throw new Error('Build the app first: (cd macos && swift build)');
const app = join(dir, 'OpenWave Mix Test.app');
mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
cpSync(binary, join(app, 'Contents/MacOS/OpenWave'));
if (existsSync(join(ROOT, 'macos/Resources'))) cpSync(join(ROOT, 'macos/Resources'), join(app, 'Contents/Resources'), { recursive: true });
const plist = readFileSync(join(ROOT, 'macos/Info.plist'), 'utf8')
  .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*/, '$1io.github.saisiddharthbs.openwave.mixtest')
  .replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*/, '$1OpenWave Mix Test');
writeFileSync(join(app, 'Contents/Info.plist'), plist);

const engine = await startEngine(dir);
const record = join(dir, 'mix.caf');
console.log('The Mac app, mixing through macOS’s audio engine');
// Opened the way a person opens an app (so it has the Mac's sound, which a terminal's child may not).
const env = { OPENWAVE_DEV_URL: engine.base, OPENWAVE_AUDIO_MUTE: '1', OPENWAVE_AUDIO_RECORD: record, ...(process.env.MAC_OFFLINE ? { OPENWAVE_AUDIO_OFFLINE: '1' } : {}), OPENWAVE_TEST_SCRIPT: join(ROOT, 'tests/mac/native_mix.js') };
execFileSync('open', ['-n', '--stderr', join(dir, 'app.log'), ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), app]);
const proc = { kill: () => { try { execFileSync('pkill', ['-f', join(app, 'Contents/MacOS/OpenWave')]); } catch { /* gone */ } } };
const timeout = setTimeout(() => finished(), (+process.env.MAC_MINUTES || 8) * 60 * 1000);
await allDone;
clearTimeout(timeout);
proc.kill();
engine.proc.kill();
server.close();
await new Promise((r) => setTimeout(r, 1500));

// ------------------------------------------------------------------ what was heard
if (process.env.MAC_LOG) console.log(readFileSync(join(dir, 'app.log'), 'utf8').split('\n').filter((l) => /OpenWave audio|error|Error/.test(l)).slice(0, 12).join('\n'));
const started = reports.find((r) => r.step === 'started');
check(started?.native === true, 'the page plays through macOS’s audio engine');
const err = reports.find((r) => r.step === 'error' || r.step === 'no plan');
check(!err, `no errors${err ? `: ${JSON.stringify(err).slice(0, 400)}` : ''}`);
const blend = reports.find((r) => r.step === 'mixed' && r.b === 'b');
const echo = reports.find((r) => r.step === 'mixed' && r.b === 'c');
check(blend?.plan?.style === 'blend' && blend?.style === 'blend', `124 into 127 BPM blends (${blend?.plan?.reason})${blend?.style !== 'blend' ? `: ${JSON.stringify(blend?.log)}` : ''}`);
check(blend?.stats && blend.stats.median < 3, `the decks held the beats together (${blend?.stats?.median?.toFixed(1)} ms typical, ${blend?.stats?.max?.toFixed(1)} ms worst)`);
check(blend?.current === 'b', 'the next song took over');
check(echo?.plan?.style === 'echo' && echo?.current === 'c', `124 into 100 BPM echoes out (${echo?.plan?.reason})`);

if (!existsSync(record)) { console.log('\nnothing was recorded'); process.exit(1); }
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', record, '-ac', '1', '-ar', '44100', '-f', 'f32le', join(dir, 'mix.f32')]);
const buf = readFileSync(join(dir, 'mix.f32'));
const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const RATE = 44100, hop = Math.round(RATE * 0.002), win = Math.round(RATE * 0.016);
const band = (hz) => {
  const out = new Float64Array(Math.floor((x.length - win) / hop));
  const w = 2 * Math.cos((2 * Math.PI * hz) / RATE);
  for (let k = 0; k < out.length; k++) {
    let a = 0, b = 0;
    for (let i = 0, s = k * hop; i < win; i++) { const v = x[s + i] + w * a - b; b = a; a = v; }
    out[k] = a * a + b * b - w * a * b;
  }
  return out;
};
const onsets = (e) => {
  const top = Float64Array.from(e).sort()[Math.floor(e.length * 0.995)] || 1;
  const out = [];
  let armed = true;
  for (let i = 1; i < e.length; i++) {
    if (armed && e[i] > 0.25 * top) { out.push((i * hop) / RATE); armed = false; } else if (!armed && e[i] < 0.075 * top) armed = true;
  }
  return out;
};
const A = onsets(band(2000)), B = onsets(band(5000)), C = onsets(band(3500));
// A tick of the next song is counted as one beat if there's another a beat later (a detector can
// see one tick twice).
const steady = (ts) => ts.filter((t) => ts.some((u) => u - t > 0.44 && u - t < 0.52));
const pairs = steady(B).map((t) => {
  const m = A.reduce((p, v) => (Math.abs(v - t) < Math.abs(p - t) ? v : p), Infinity);
  return (t - m) * 1000;
}).filter((d) => Math.abs(d) < 150);
const abs = pairs.map(Math.abs).sort((p, q) => p - q);
const med = abs[abs.length >> 1], p90 = abs[Math.floor(abs.length * 0.9)];
check(pairs.length >= 12, `both songs heard together for ${pairs.length} beats`);
check(med < 4 && p90 < 8, `heard beat for beat: ${med?.toFixed(1)} ms apart typically, ${p90?.toFixed(1)} ms at worst (of 9 in 10)`);
const firstC = C.find((t) => C.some((u) => Math.abs(u - t - 0.6) < 0.02));
const lastA = A.filter((t) => t < firstC - 0.02).at(-1);
const off = (firstC - lastA - 60 / 124) * 1000;
check(firstC != null && lastA != null && Math.abs(off) < 10, `after the echo, the next song lands on the downbeat (${off.toFixed(1)} ms off)`);

console.log(failures.length ? `\n${failures.length} failed` : '\nThe Mac app mixes beat for beat.');
process.exit(failures.length ? 1 : 0);
