// Smart mix, without a browser: the analysis (js/mix-analysis.js) against made-up songs whose every
// beat is known (mixsongs.mjs), and the plans (js/mix-plan.js) it leads to. smartmix.mjs plays real
// transitions in Chrome and measures them.
//
//   node tests/ui/mix.mjs

import { analyse } from '../../openwave/web/js/mix-analysis.js';
import { plan, keyDistance } from '../../openwave/web/js/mix-plan.js';
import { song } from './mixsongs.mjs';

const failures = [];
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };

/** How far `t` is from the nearest true beat, in ms. */
const offBeat = (s, t) => Math.min(...s.beats.map((b) => Math.abs(b - t))) * 1000;
/** Which beat of its bar `t` is (0 = the downbeat), or -1 if it isn't on a beat. */
const beatOfBar = (s, t) => { const k = s.beats.findIndex((b) => Math.abs(b - t) < 0.02); return k < 0 ? -1 : k % 4; };

console.log('Tempo, beats and bars');
const tempos = [
  { bpm: 124, tonic: 9, minor: true }, { bpm: 128, tonic: 0 }, { bpm: 100, tonic: 7, intro: 4 },
  { bpm: 92, tonic: 2, minor: true, intro: 16, outro: 8 }, { bpm: 140, tonic: 5 }, { bpm: 118, lead: 2.3 },
];
for (const c of tempos) {
  const s = song(c), a = analyse(s.samples, s.rate);
  const name = `${c.bpm} BPM`;
  check(Math.abs(a.bpm / c.bpm - 1) < 0.0005, `${name}: tempo read as ${a.bpm.toFixed(3)}`);
  check(a.steady && a.intro.steady && a.outro.steady, `${name}: steady all the way through`);
  check(offBeat(s, a.grid.t0) < 4, `${name}: the beat grid sits on the beats (${offBeat(s, a.grid.t0).toFixed(1)} ms)`);
  // Over the whole song, not just where the grid starts: the period is right to a fraction of a ms.
  const last = a.grid.t0 + Math.round((s.beats.at(-1) - a.grid.t0) / a.grid.period) * a.grid.period;
  check(offBeat(s, last) < 5, `${name}: still on the beat at the end (${offBeat(s, last).toFixed(1)} ms)`);
  check(beatOfBar(s, a.intro.first) === 0 && beatOfBar(s, a.outro.first) === 0, `${name}: downbeats found at both ends`);
  check(Math.abs(a.intro.build - s.intro) <= 0, `${name}: intro builds for ${a.intro.build} bars (made with ${s.intro})`);
  check(Math.abs(a.outro.tail - s.outro) <= 0, `${name}: outro winds down for ${a.outro.tail} bars (made with ${s.outro})`);
  check(Math.abs(a.start - s.lead) < 0.2 && Math.abs(a.end - s.end) < 0.2, `${name}: music from ${a.start.toFixed(2)} s to ${a.end.toFixed(2)} s (made ${s.lead}–${s.end.toFixed(2)})`);
}

console.log('Fast songs, drifting songs, songs without a beat');
{
  const s = song({ bpm: 174, tonic: 4, minor: true }), a = analyse(s.samples, s.rate);
  check(Math.abs(a.bpm - 87) < 0.05, `174 BPM is mixed on every other beat, as ${a.bpm.toFixed(2)}`);
  check(beatOfBar(s, a.intro.first) === 0 && beatOfBar(s, a.outro.first) === 0, '…with its bars still starting on the 1');
}
{
  const s = song({ bpm: 124, drift: 0.04 }), a = analyse(s.samples, s.rate);
  check(!a.steady && !a.intro.steady && !a.outro.steady, 'a band drifting 4% either way is never beat-matched');
}
{
  const s = song({ bpm: 120, beatless: true }), a = analyse(s.samples, s.rate);
  check(!a.steady, 'chords alone, with no beat, are not a beat');
}
{
  const s = song({ bpm: 126, fadeOut: true, outro: 8 }), a = analyse(s.samples, s.rate);
  check(a.outro.fades, 'a song that fades out is seen to fade');
}

console.log('Keys');
for (const [tonic, minor, wheel] of [[9, true, '8A'], [0, false, '8B'], [7, false, '9B'], [5, false, '7B']]) {
  const s = song({ bpm: 120, tonic, minor }), a = analyse(s.samples, s.rate);
  // A relative major and minor share their notes (and their number on the wheel): either is right.
  check(a.key.wheel === parseInt(wheel, 10), `${['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][tonic]}${minor ? 'm' : ''} is ${a.key.camelot} on the key wheel`);
}
check(keyDistance({ wheel: 8, camelot: '8A' }, { wheel: 9, camelot: '9A' }) === 0, 'neighbours on the wheel go together');
check(keyDistance({ wheel: 8, camelot: '8A' }, { wheel: 2, camelot: '2B' }) === 2, 'far sides of the wheel clash');

console.log('Plans');
const A = analyse(song({ bpm: 124, tonic: 9, minor: true, intro: 8, main: 24, outro: 4 }).samples);
const sB = song({ bpm: 126, tonic: 0, intro: 8, lead: 0.6 }), B = analyse(sB.samples);
{
  const p = plan(A, B);
  check(p.style === 'blend', `124 into 126 BPM, keys that go together: a blend (${p.reason})`);
  check(p.bars === 8, `as long as the next song's intro: ${p.bars} bars`);
  check(Math.abs(p.rateA * A.outro.period - p.rateB * B.intro.period) < 1e-9 || Math.abs(A.outro.period / p.rateA - B.intro.period / p.rateB) < 1e-6, 'both beats the same length once nudged');
  check(Math.abs(p.rateA - 1) < 0.01 && Math.abs(p.rateB - 1) < 0.01 && (p.rateA - 1) * (p.rateB - 1) < 0, 'each moves halfway, in opposite directions');
  const k = (p.outAt - A.outro.first) / A.outro.bar;
  check(Math.abs(k - Math.round(k)) < 1e-6, 'it starts on a downbeat of this song');
  const j = (p.inAt - B.intro.first) / B.intro.bar;
  check(Math.abs(j - Math.round(j)) < 1e-6 && p.inAt >= 2 && p.inAt - B.intro.bar < 2, `…on a downbeat of the next song: its first one at least 2 s in, to lock first (${p.inAt.toFixed(2)} s)`);
  check(p.outEnd <= A.end + 0.5 * A.outro.bar && p.outEnd > A.end - A.outro.bar, `and ends as this song’s music does (${p.outEnd.toFixed(2)} s, music to ${A.end.toFixed(2)} s)`);
  check(Math.abs(p.swap - (p.outAt + 4 * A.outro.bar)) < 1e-6, 'the bass swaps halfway, on a downbeat');
  check(p.inFrom < p.inAt && p.inAt - p.inFrom <= 3, 'the next song starts early, silently, to lock its beat');
}
{
  const p = plan(A, B, { graph: false });
  check(p.style === 'fade' && p.rateA === 1 && p.rateB === 1 && Math.abs(p.outEnd - p.outAt - 2) < 1e-6,
    'without the audio graph (WebKit), two songs with beats hand over in a quick two-second fade');
  check(Math.abs(p.outEnd - A.end) < 1e-6 && Math.abs(p.inAt - (B.start - 0.05)) < 0.06, '…as this song’s music ends, into the next one’s first sound');
}
{
  const C = analyse(song({ bpm: 100, tonic: 9, minor: true }).samples);
  const p = plan(A, C);
  check(p.style === 'echo', `124 into 100 BPM is too far to blend: echo out on the downbeat (${p.reason})`);
  const k = (p.outAt - A.outro.first) / A.outro.bar;
  check(Math.abs(k - Math.round(k)) < 1e-6 && p.outAt < A.end - A.outro.bar + 0.01, '…on a downbeat at least a bar before the end');
  check(plan(A, C, { graph: false }).style === 'fade', 'without the audio graph: a quick handover instead');
}
{
  const D = analyse(song({ bpm: 124, drift: 0.04 }).samples);
  const p = plan(D, B);
  check(p.style === 'fade' && Math.abs(p.outEnd - D.end) < 0.01 && Math.abs(p.outEnd - p.outAt - 6) < 0.01, 'a drifting song fades over six seconds, ending with its music');
  check(Math.abs(p.inAt - (B.start - 0.05)) < 0.06, '…into the next song’s first sound, not its silence');
}
{
  const E = analyse(song({ bpm: 125, tonic: 6, intro: 8 }).samples); // F♯ major: far round the wheel from A minor
  const p = plan(A, E);
  check(p.style === 'blend' && p.bars <= 4, `keys that clash get a short blend (${p.bars} bars)`);
}
{
  const F = analyse(song({ bpm: 126, tonic: 0, intro: 2 }).samples);
  check(plan(A, F).bars === 2, 'a song that starts at full tilt comes in over two bars');
  const G = analyse(song({ bpm: 126, tonic: 0, intro: 24, outro: 4 }).samples);
  const p = plan(A, G);
  check(p.inAt > G.intro.first && p.inAt <= G.intro.first + 8 * G.intro.bar + 1e-6, 'a very long intro is joined a few bars in, so its drop lands as this song goes');
}
check(plan(null, B).style === 'fade' && plan(A, null).style === 'fade', 'a song that wasn’t analysed gets a plain fade');

console.log(failures.length ? `\n${failures.length} failed` : '\nAll Smart mix analysis checks passed');
process.exit(failures.length ? 1 : 0);
