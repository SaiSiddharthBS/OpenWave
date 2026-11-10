// Made-up songs for the Smart mix checks: every beat, downbeat, key, intro and outro is known
// exactly, so the analysis can be checked against the truth, and two of them can be mixed and the
// result measured. Nothing here is a recording.
//
// A song: `lead` seconds of silence, an intro of hi-hats and chords (`intro` bars), the full song
// (kick on every beat, snare on 2 and 4, bass on the chord's root), then an outro like the intro.
// Chords change on every downbeat, through I-V-vi-IV (major) or i-VI-III-VII (minor) in the key.

export function song({ bpm = 124, tonic = 0, minor = false, intro = 8, main = 24, outro = 4, lead = 0.4, rate = 11025,
  tail = 1.5, drift = 0, beatless = false, seed = 1, click = 0, fadeOut = false } = {}) {
  const beat = 60 / bpm, bar = 4 * beat;
  const bars = intro + main + outro;
  const length = lead + bars * bar + tail;
  const x = new Float32Array(Math.ceil(length * rate));
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  // Beat times: straight, or wandering by up to `drift` of the tempo (a band without a click).
  const beats = [];
  let t = lead;
  for (let k = 0; k < bars * 4; k++) {
    beats.push(t);
    t += beat * (1 + drift * Math.sin((2 * Math.PI * k) / 37));
  }
  const add = (at, len, fn, gain = 1) => {
    const i0 = Math.round(at * rate), n = Math.round(len * rate);
    for (let i = 0; i < n && i0 + i < x.length; i++) x[i0 + i] += gain * fn(i / rate);
  };
  const kick = (tt) => Math.sin(2 * Math.PI * (45 * tt + 60 * (1 - Math.exp(-tt * 30)) / 30)) * Math.exp(-tt * 18);
  const snare = (tt) => rand() * 2 * Math.exp(-tt * 28) + 0.4 * Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt * 30);
  let hp = 0, prev = 0;
  const hat = (tt) => { const n = rand(); hp = 0.6 * (hp + n - prev); prev = n; return hp * Math.exp(-tt * 90); };
  const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
  const steps = minor ? [0, 8, 3, 10] : [0, 7, 9, 5];        // chord roots, in semitones above the tonic
  const third = (root) => (minor ? [3, 4, 4, 4] : [4, 4, 3, 4])[steps.indexOf(root)] ?? 4;
  // A short tone in a band of its own on each beat, to tell the two songs apart in a recording.
  // Faded in over 2 ms, so it has no click of its own that would spill into the other song's band.
  const tick = (tt) => Math.sin(2 * Math.PI * click * tt) * Math.min(1, tt / 0.002) * Math.exp(-tt * 60);

  for (let b = 0; b < bars; b++) {
    const full = !beatless && b >= intro && b < intro + main;
    const fadeGain = fadeOut && b >= intro + main ? 1 - (b - intro - main) / outro : 1;
    const root = steps[b % 4], at = beats[4 * b];
    const barLen = (beats[4 * b + 4] ?? at + bar) - at;
    // The chord: root, third and fifth, an octave above middle C's octave, held for the bar.
    for (const iv of [0, third(root), 7]) {
      const f = hz(60 + tonic + root + iv - (tonic + root + iv >= 12 ? 12 : 0));
      add(at, barLen, (tt) => Math.sin(2 * Math.PI * f * tt) * Math.min(1, tt * 20) * Math.min(1, (barLen - tt) * 20), 0.05 * fadeGain);
    }
    for (let q = 0; q < 4; q++) {
      const bt = beats[4 * b + q], next = beats[4 * b + q + 1] ?? bt + beat;
      if (!beatless) {
        add(bt, 0.04, hat, 0.12 * fadeGain);
        add((bt + next) / 2, 0.04, hat, 0.08 * fadeGain);
      }
      if (click) add(bt, 0.06, tick, 0.4);
      if (!full) continue;
      add(bt, 0.25, kick, 0.6);
      if (q % 2 === 1) add(bt, 0.15, snare, 0.25);
      const f = hz(36 + tonic + root);
      add(bt, (next - bt) * 0.9, (tt) => Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 4), 0.3);
    }
  }
  return { samples: x, rate, beats, beat, bar, lead, bars, intro, main, outro, end: lead + bars * bar, length };
}

/** 16-bit mono WAV of a song's samples. */
export function wav({ samples, rate }) {
  const n = samples.length, b = Buffer.alloc(44 + 2 * n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + 2 * n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(2 * rate, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + 2 * i);
  return b;
}
