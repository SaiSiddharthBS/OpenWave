// Smart mix, part 1: listening to a song. Pure arithmetic on samples, with no page or audio objects,
// so it runs in a worker (mix-worker.js) and in Node for the tests.
//
//   analyse(samples, rate) -> { tempo, beat grid, downbeats, intro, outro, key, ... }
//
// The song arrives as mono samples at a low rate (RATE, 11025 Hz is plenty for drums and chords).
// From them:
//   1. an onset curve: how much new sound starts in each 11.6 ms frame (spectral flux), and the same
//      for the bass alone, which is where kick drums live;
//   2. candidate tempos, from how the onset curve repeats (autocorrelation), each credited with how
//      well it repeats a bar later too, so a rhythm's 3-3-2 pattern isn't mistaken for the beat;
//   3. the beat grid: a song made to a click has its beats exactly a period apart, so folding the
//      onset curve at the right period stacks every beat in one sharp peak. The sharpest fold gives
//      the period to a hundredth of a per cent and where the beat falls to a millisecond or two.
//      Tempos are read between 78 and 156 BPM (a song at 174 is mixed on every other beat, as 87);
//   4. whether the grid holds: the beat must sit in the same place in every stretch that has one. A
//      band without a click drifts, so its intro and outro get grids of their own, and a song that
//      doesn't hold even there is marked unsteady and never beat-matched;
//   5. downbeats (the 1 of each bar): where kicks land, chords change and sections start;
//   6. the shape of the song in bars: how long its intro builds before the song is fully in, how long
//      its outro winds down, whether it fades, and where it really starts and ends;
//   7. its key, from the notes it uses, against the classic major and minor key profiles.
//
// Checked against made-up songs whose every beat is known (tests/ui/mixsongs.mjs) and against
// real songs of known tempo.

export const RATE = 11025;
export const VERSION = 3; // bump when the analysis changes, so stored results are redone

const N = 512;              // samples per onset frame (46 ms)
const HOP = 128;            // 11.6 ms between frames
const FPS = RATE / HOP;     // frames per second
const CN = 2048;            // samples per chroma frame (5.4 Hz per bin: enough to tell notes apart)
const CHOP = 1024;
const MIN_BPM = 60, MAX_BPM = 200;

// ------------------------------------------------------------------ FFT
const ffts = new Map();
function fftOf(n) {
  if (ffts.has(n)) return ffts.get(n);
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const f = { n, rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) };
  ffts.set(n, f);
  return f;
}

/** Magnitudes of bins 0..n/2 of the windowed frame starting at sample `at` (zeros outside the song). */
function spectrum(f, x, at, mags) {
  const { n, rev, cos, sin, win, re, im } = f;
  for (let i = 0; i < n; i++) {
    const j = rev[i], k = at + i;
    re[j] = k >= 0 && k < x.length ? x[k] * win[i] : 0;
    im[j] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step], si = sin[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c + im[b] * si, ti = im[b] * c - re[b] * si;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let i = 0; i <= n / 2; i++) mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
}

// ------------------------------------------------------------------ 1. onset curves
function onsets(x) {
  const f = fftOf(N);
  // Frame t is centred on sample t * HOP, so frame t is the sound at t / FPS seconds.
  const frames = Math.max(1, Math.floor(x.length / HOP) + 1);
  const all = new Float32Array(frames), bass = new Float32Array(frames), loud = new Float32Array(frames), low = new Float32Array(frames);
  const bins = N / 2 + 1;
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  const mags = new Float64Array(bins);
  const BASS = Math.round((150 * N) / RATE); // bins up to 150 Hz
  for (let t = 0; t < frames; t++) {
    spectrum(f, x, t * HOP - N / 2, mags);
    let flux = 0, bflux = 0, energy = 0, benergy = 0;
    for (let i = 1; i < bins; i++) {
      const m = mags[i];
      energy += m * m;
      if (i <= BASS) benergy += m * m;
      const v = Math.log1p(1000 * m);
      cur[i] = v;
      const d = v - prev[i];
      if (d > 0) { flux += d; if (i <= BASS) bflux += d; }
    }
    all[t] = flux; bass[t] = bflux;
    loud[t] = energy; low[t] = benergy;
    [prev, cur] = [cur, prev];
  }
  all[0] = 0; bass[0] = 0;
  return { all, bass, loud, low, frames };
}

/** Each value less the average around it (a second either side), never below zero. */
function detrend(v, radius = Math.round(FPS)) {
  const out = new Float32Array(v.length);
  let sum = 0, lo = 0, hi = -1;
  for (let i = 0; i < v.length; i++) {
    while (hi < Math.min(v.length - 1, i + radius)) sum += v[++hi];
    while (lo < i - radius) sum -= v[lo++];
    out[i] = Math.max(0, v[i] - sum / (hi - lo + 1));
  }
  return out;
}

const mean = (v, a = 0, b = v.length) => { let s = 0; for (let i = a; i < b; i++) s += v[i]; return b > a ? s / (b - a) : 0; };
function std(v) { const m = mean(v); let s = 0; for (const x of v) s += (x - m) ** 2; return Math.sqrt(s / Math.max(1, v.length)); }
const median = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : 0; };
const quantile = (a, q) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const db = (p) => 10 * Math.log10(p + 1e-12);

// ------------------------------------------------------------------ 2. tempo
/** Autocorrelation of the onset curve over [a, b), for lags up to `hi` frames. */
function autocorrelation(env, a, b, hi) {
  const acf = new Float64Array(hi + 2);
  for (let lag = 1; lag <= hi + 1; lag++) {
    let s = 0;
    for (let i = a + lag; i < b; i++) s += env[i] * env[i - lag];
    acf[lag] = s / Math.max(1, b - a - lag);
  }
  return acf;
}

/** Candidate beat lengths in frames: the strongest repeats, each credited with its bar's repeat. */
function candidates(env, a, b) {
  const lo = Math.floor((FPS * 60) / MAX_BPM), hi = Math.ceil((FPS * 60) / MIN_BPM);
  const acf = autocorrelation(env, a, b, 4 * hi + 4);
  const at = (x) => { const i = Math.floor(x), f = x - i; return acf[i] * (1 - f) + acf[i + 1] * f; };
  const peaks = [];
  for (let lag = lo; lag <= hi; lag++) {
    if (!(acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1])) continue;
    const y0 = acf[lag - 1], y1 = acf[lag], y2 = acf[lag + 1];
    const d = y0 - 2 * y1 + y2 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2))) : 0;
    const L = lag + d;
    // A true beat repeats at 2 and 4 beats too (the bar); a part of a rhythm (3 of 4 eighths in a
    // reggaeton or afrobeats pattern) doesn't.
    peaks.push({ lag: L, score: at(L) + 0.5 * at(2 * L) + 0.5 * at(4 * L) });
  }
  peaks.sort((x, y) => y.score - x.score);
  return peaks.slice(0, 6).map((p) => p.lag);
}

// ------------------------------------------------------------------ 3-4. beat grid
// A song made to a click has its beats at t0 + k * period exactly. Folding the onset curve at the
// right period stacks every beat on the same spot, which makes one sharp peak; a period even 0.1 %
// off smears it. So the grid is found by trying periods and keeping the sharpest fold.
const BINS = 96;
function fold(env, period, fa, fb, hist = new Float64Array(BINS)) {
  hist.fill(0);
  const pf = period * FPS; // frames per beat
  for (let f = fa; f < fb; f++) {
    const x = ((f % pf) / pf) * BINS, i = Math.floor(x), fr = x - i;
    hist[i % BINS] += env[f] * (1 - fr);
    hist[(i + 1) % BINS] += env[f] * fr;
  }
  return hist;
}
/** The fold's peak: where in the beat (seconds after a multiple of the period) and how sharp. */
function peakOf(hist, period) {
  const sm = new Float64Array(BINS);
  for (let i = 0; i < BINS; i++) sm[i] = 0.25 * hist[(i + BINS - 1) % BINS] + 0.5 * hist[i] + 0.25 * hist[(i + 1) % BINS];
  let k = 0;
  for (let i = 1; i < BINS; i++) if (sm[i] > sm[k]) k = i;
  const y0 = sm[(k + BINS - 1) % BINS], y1 = sm[k], y2 = sm[(k + 1) % BINS];
  const d = y0 - 2 * y1 + y2 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2))) : 0;
  const m = mean(sm) || 1;
  return { offset: (((k + d) / BINS) * period) % period, sharp: y1 / m };
}
/** The best period near `period` (seconds) over frames [fa, fb), searching ±range. */
function search(env, period, fa, fb, range = 0.02) {
  const hist = new Float64Array(BINS);
  let best = { period, sharp: 0, offset: 0 };
  // Coarse, then finer around the best: the fold over a few minutes tells periods 0.01 % apart.
  for (const [span, steps] of [[range, 80], [range / 20, 40], [range / 400, 40]]) {
    const centre = best.sharp ? best.period : period;
    for (let i = -steps; i <= steps; i++) {
      const p = centre * (1 + (span * i) / steps);
      const pk = peakOf(fold(env, p, fa, fb, hist), p);
      if (pk.sharp > best.sharp) best = { period: p, ...pk };
    }
  }
  return best;
}
/**
 * Within [a, b): does the grid hold in each stretch of `len` seconds that has a clear beat? A song
 * that drifts (a band without a click) shows its beat at a wandering place; a breakdown with no
 * drums shows no beat at all and doesn't count either way. A beat exactly half a beat off is the
 * same grid at double time (a song at 170 read as 85, whose kick and snare swap in strength).
 */
function holds(env, grid, a, b, len = 12) {
  let ok = 0, clear = 0, n = 0;
  const hist = new Float64Array(BINS);
  for (let t = a; t + len <= b + 0.01; t += len) {
    n++;
    const pk = peakOf(fold(env, grid.period, Math.floor(t * FPS), Math.ceil((t + len) * FPS), hist), grid.period);
    if (pk.sharp < 1.8) continue;
    clear++;
    let off = pk.offset + ONSET_LEAD - grid.offset;
    off -= Math.round(off / grid.period) * grid.period;
    const half = Math.abs(Math.abs(off) - grid.period / 2);
    if (Math.abs(off) < 0.015 || half < 0.015) ok++;
  }
  return clear >= Math.max(1, 0.5 * n) ? ok / clear : 0;
}
// The onset curve peaks a little before a drum's attack (the frame sees it coming): measured on
// songs whose beats are known exactly (mixsongs.mjs), it is this much early.
const ONSET_LEAD = 0.011;

/** A grid for [a, b) seconds: {t0, period, sharp, holds, density}. */
function gridFor(env, a, b, lags, bass) {
  const fa = Math.max(0, Math.floor(a * FPS)), fb = Math.min(env.length, Math.ceil(b * FPS));
  let best = null;
  for (const lag of lags) {
    // Fold every candidate into 78-156 BPM: a song at 171 is mixed on every other beat, as 85.5.
    let p = lag / FPS;
    while (60 / p > 156) p *= 2;
    while (60 / p < 78) p /= 2;
    const g = search(env, p, fa, fb);
    // Prefer tempos near the middle of the range a little, so a tie goes to the likelier reading.
    const prior = Math.exp(-0.5 * (Math.log2(60 / g.period / 112) / 0.7) ** 2);
    const score = g.sharp * (0.8 + 0.2 * prior);
    if (!best || score > best.score) best = { ...g, score };
  }
  if (!best) return null;
  // A fast song read at half its tempo could have its grid on either of its beats: the one with
  // the stronger kick is the one bars start on.
  let { offset } = best;
  const P = best.period, bin = (o) => Math.round((o / P) * BINS) % BINS;
  const alt = (offset + P / 2) % P;
  const hc = fold(env, P, fa, fb), hb = bass ? fold(bass, P, fa, fb) : null;
  if (hb && hc[bin(alt)] > 0.5 * hc[bin(offset)] && hb[bin(alt)] > 1.15 * hb[bin(offset)]) offset = alt;
  // Kicks halfway between the grid's beats as well as on them: the song really goes twice as fast
  // (174 read as 87), and its bars can start on either.
  const folded = !!hb && hc[bin(alt)] > 0.6 * hc[bin(offset)] && hb[bin(alt)] > 0.6 * hb[bin(offset)];
  offset = (offset + ONSET_LEAD) % P;
  // How many beats actually have something on them: chords changing every few seconds make a
  // steady pulse too, but nothing to mix beat for beat.
  const t0 = offset + Math.ceil((a - offset) / P) * P;
  const strength = [];
  for (let t = t0; t < b; t += P) {
    const f = Math.round((t - ONSET_LEAD) * FPS);
    let m = 0;
    for (let i = f - 2; i <= f + 2; i++) if (i >= 0 && i < env.length) m = Math.max(m, env[i]);
    strength.push(m);
  }
  const strong = quantile(strength, 0.9);
  const density = strength.filter((v) => v > 0.3 * strong).length / Math.max(1, strength.length);
  const grid = { t0, period: P, offset, sharp: best.sharp, folded };
  return { ...grid, holds: holds(env, grid, a, b), density };
}

/** Where the grid's beats land, in seconds, from a to b. */
function beatsOf(grid, a, b) {
  const out = [];
  let k = Math.ceil((a - grid.t0) / grid.period);
  for (let t = grid.t0 + k * grid.period; t <= b; k++, t = grid.t0 + k * grid.period) out.push(t);
  return out;
}

// ------------------------------------------------------------------ 5. downbeats
/**
 * Which beat of four is the 1, over [a, b): kicks land there, chords change there and sections start
 * there. Scores are per beat of the bar, numbered from the grid's t0 (beat k is k mod 4), and averaged
 * per bar so a stretch's evidence and the whole song's can be added up.
 */
function barScores(grid, curves, chroma, a, b, cycle = 4) {
  const k0 = Math.ceil((a - grid.t0) / grid.period);
  const beats = beatsOf(grid, a, b);
  const score = new Array(cycle).fill(0);
  if (beats.length < 16) return score;
  const at = (v, t) => {
    const f = Math.round(t * FPS);
    let m = 0;
    for (let i = f - 2; i <= f + 2; i++) if (i >= 0 && i < v.length) m = Math.max(m, v[i]);
    return m;
  };
  const kick = beats.map((t) => at(curves.bass, t));
  // How much the harmony changes across each beat: the two beats before against the two after.
  const chordAt = (t0, t1) => {
    const c = new Float64Array(12);
    const f0 = Math.max(0, Math.floor((t0 * RATE) / CHOP)), f1 = Math.min(chroma.frames, Math.ceil((t1 * RATE) / CHOP));
    for (let f = f0; f < f1; f++) for (let k = 0; k < 12; k++) c[k] += chroma.data[f * 12 + k];
    let n = 0;
    for (let k = 0; k < 12; k++) n += c[k] * c[k];
    n = Math.sqrt(n) || 1;
    return c.map((v) => v / n);
  };
  const p = (grid.period * cycle) / 4; // a beat of the bar
  const change = beats.map((t) => {
    const before = chordAt(t - 2 * p, t), after = chordAt(t, t + 2 * p);
    let dot = 0;
    for (let k = 0; k < 12; k++) dot += before[k] * after[k];
    return 1 - dot;
  });
  // Sections start on a 1: how much louder or quieter the next bar is than the last.
  const level = (t0, t1) => db(mean(curves.loud, Math.max(0, Math.floor(t0 * FPS)), Math.min(curves.loud.length, Math.ceil(t1 * FPS))));
  const jump = beats.map((t) => Math.abs(level(t, t + 4 * p) - level(t - 4 * p, t)));
  const z = (v) => { const m = mean(v), s = std(v) || 1; return v.map((x) => (x - m) / s); };
  const zk = z(kick), zc = z(change), zj = z(jump);
  for (let i = 0; i < beats.length; i++) score[(((k0 + i) % cycle) + cycle) % cycle] += 0.6 * zk[i] + 1.0 * zc[i] + 0.4 * zj[i];
  return score.map((v) => v / (beats.length / cycle));
}
/** The first downbeat at or after `a`, given which beat of four is the 1, and how sure that is. */
function firstDownbeat(grid, score, a) {
  const cycle = score.length;
  let best = 0;
  for (let q = 1; q < cycle; q++) if (score[q] > score[best]) best = q;
  const sorted = score.slice().sort((x, y) => y - x);
  let k = Math.ceil((a - grid.t0) / grid.period - 0.02);
  while ((((k % cycle) + cycle) % cycle) !== best) k++;
  return { first: grid.t0 + k * grid.period, confidence: Math.max(0, sorted[0] - sorted[1]) };
}

// ------------------------------------------------------------------ chroma and key
function chromagram(x) {
  const f = fftOf(CN);
  const frames = Math.max(1, Math.floor(x.length / CHOP) + 1);
  const data = new Float32Array(frames * 12);
  const mags = new Float64Array(CN / 2 + 1);
  // Each bin's pitch class, for notes from about 100 Hz to 2 kHz. Low notes have fewer bins each
  // than high ones, so every note is the average of its bins, not the sum.
  const pc = new Int8Array(CN / 2 + 1).fill(-1), weight = new Float64Array(CN / 2 + 1);
  const perNote = new Map();
  for (let i = 1; i <= CN / 2; i++) {
    const hz = (i * RATE) / CN;
    if (hz < 100 || hz > 2000) continue;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    pc[i] = ((midi % 12) + 12) % 12;
    perNote.set(midi, (perNote.get(midi) || 0) + 1);
    weight[i] = midi;
  }
  for (let i = 1; i <= CN / 2; i++) if (pc[i] >= 0) weight[i] = 1 / perNote.get(weight[i]);
  for (let t = 0; t < frames; t++) {
    spectrum(f, x, t * CHOP - CN / 2, mags);
    for (let i = 1; i <= CN / 2; i++) if (pc[i] >= 0) data[t * 12 + pc[i]] += Math.sqrt(mags[i]) * weight[i];
  }
  return { data, frames };
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return s / (Math.sqrt(sa * sb) || 1);
}
/** Camelot wheel number for a key: neighbours on the wheel mix well. */
export function camelot(tonic, minor) {
  // C major is 8B, A minor is 8A; each fifth up is one step round the wheel.
  const n = (((tonic * 7) % 12) + (minor ? 3 * 7 : 0)) % 12; // fifths from C (for minor: from its relative major)
  return { n: ((n + 7) % 12) + 1, letter: minor ? 'A' : 'B' };
}
function keyOf(chroma, a, b) {
  const total = new Float64Array(12);
  const f0 = Math.max(0, Math.floor((a * RATE) / CHOP)), f1 = Math.min(chroma.frames, Math.ceil((b * RATE) / CHOP));
  for (let f = f0; f < f1; f++) for (let k = 0; k < 12; k++) total[k] += chroma.data[f * 12 + k];
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = Array.from({ length: 12 }, (_, k) => total[(k + tonic) % 12]);
    scores.push({ tonic, minor: false, r: pearson(rot, MAJOR) }, { tonic, minor: true, r: pearson(rot, MINOR) });
  }
  scores.sort((x, y) => y.r - x.r);
  const best = scores[0];
  // A relative major or minor is the same notes: only a different, unrelated key counts against.
  const cb = camelot(best.tonic, best.minor);
  const rival = scores.find((s) => camelot(s.tonic, s.minor).n !== cb.n) || scores[1];
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  return { tonic: best.tonic, minor: best.minor, name: `${NAMES[best.tonic]}${best.minor ? 'm' : ''}`, camelot: `${cb.n}${cb.letter}`, wheel: cb.n,
    confidence: Math.max(0, best.r - rival.r) };
}

// ------------------------------------------------------------------ 6. the song's shape
/** Loudness per stretch of `len` seconds, in dB, from the frame energies. */
function levels(energy, a, len, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const f0 = Math.max(0, Math.floor((a + i * len) * FPS)), f1 = Math.min(energy.length, Math.ceil((a + (i + 1) * len) * FPS));
    out.push(f1 > f0 ? db(mean(energy, f0, f1)) : -120);
  }
  return out;
}

// ------------------------------------------------------------------ the whole analysis
export function analyse(samples, rate = RATE) {
  if (rate !== RATE) throw new Error(`analyse wants samples at ${RATE} Hz`);
  const duration = samples.length / RATE;
  const curves = onsets(samples);
  const env = detrend(curves.all), benv = detrend(curves.bass);
  curves.bass = benv;

  // Where the song really starts and ends: 40 dB under its loud parts counts as silence.
  const shortLevel = [];
  const W = Math.round(FPS / 10), WS = W / FPS; // windows of about 0.1 s
  for (let f = 0; f < curves.loud.length; f += W) shortLevel.push(db(mean(curves.loud, f, Math.min(curves.loud.length, f + W))));
  const top = quantile(shortLevel, 0.95);
  const firstLoud = shortLevel.findIndex((l) => l > top - 40);
  let lastLoud = shortLevel.length - 1;
  while (lastLoud > 0 && shortLevel[lastLoud] <= top - 40) lastLoud--;
  const start = Math.max(0, Math.max(0, firstLoud) * WS - WS / 2), end = Math.min(duration, (lastLoud + 1) * WS);

  const result = { v: VERSION, duration, start, end, bpm: 0, steady: false, grid: null, intro: null, outro: null, key: null, loud: top };
  if (end - start < 20) return result;
  // How loud the song is when it's fully in: most of a song is, so a high share of its two-second
  // stretches are at least this loud.
  result.level = quantile(levels(curves.loud, start, 2, Math.floor((end - start) / 2)), 0.7);

  // The beat is heard in the whole sound and in the kick drum: follow both.
  const sa = std(env) || 1, sb = std(benv) || 1;
  const beat = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) beat[i] = env[i] / sa + benv[i] / sb;
  const fs = Math.floor(start * FPS), fe = Math.ceil(end * FPS);
  const lags = candidates(beat, fs, fe);

  const chroma = chromagram(samples);
  result.key = keyOf(chroma, start, end);

  // One grid for the whole song if it holds (music made to a click), else one for each end.
  const steadyOf = (g) => !!g && g.holds >= 0.85 && g.sharp > 2 && g.density >= 0.38;
  const whole = gridFor(beat, start, end, lags, benv);
  const steadyWhole = steadyOf(whole);
  if (whole) { result.bpm = 60 / whole.period; result.grid = { t0: whole.t0, period: whole.period, sharp: whole.sharp, holds: whole.holds, density: whole.density }; }
  result.steady = steadyWhole;
  const windowed = (a, b) => {
    if (steadyWhole) return { ...whole, steady: true };
    const g = gridFor(beat, a, b, whole ? [whole.period * FPS, ...lags] : lags, benv);
    return g && { ...g, steady: steadyOf(g) };
  };

  const SPAN = 75; // seconds at each end a mix can use
  // A song on one grid mostly keeps its bars all the way through, so the whole song's evidence for
  // where the 1 is helps each end; a stretch that clearly disagrees (a bar of two beats somewhere)
  // still wins at its own end.
  // A fast song read at half tempo (folded) has a real beat halfway between grid beats too, and its
  // bars may start on either: look for the 1 every half beat, and move the grid onto it.
  const half = (g) => (g.folded ? { ...g, period: g.period / 2 } : g);
  const cycleOf = (g) => (g.folded ? 8 : 4);
  const overall = steadyWhole ? barScores(half(whole), curves, chroma, start, end, cycleOf(whole)) : null;
  const ends = [['intro', start, Math.min(end, start + SPAN)], ['outro', Math.max(start, end - SPAN), end]];
  for (const [name, a, b] of ends) {
    const g = windowed(a, b);
    if (!g) { result[name] = { steady: false, from: a, to: b }; continue; }
    const local = barScores(half(g), curves, chroma, a, b, cycleOf(g));
    const db1 = firstDownbeat(half(g), local.map((v, q) => v + 0.7 * (overall?.[q] || 0)), a);
    if (g.folded) g.t0 = db1.first; // the grid now sits on the bars' beats
    const bar = 4 * g.period;
    // Bars from the first downbeat at or after `a`.
    let first = db1.first;
    while (first - bar >= a - 0.02) first -= bar;
    const bars = Math.max(1, Math.floor((b - first) / bar));
    const loudness = levels(curves.loud, first, bar, bars);
    const bassness = levels(curves.low, first, bar, bars);
    result[name] = {
      steady: g.steady, period: g.period, bpm: 60 / g.period, t0: g.t0, sharp: g.sharp, holds: g.holds,
      first, bar, bars, confidence: db1.confidence, loudness, bassness,
    };
  }
  shape(result);
  return result;
}

/**
 * From the bar levels: how many bars the intro has before the song is fully in (`intro.build`), how
 * many the outro has after the song's last full bar (`outro.tail`), and whether it fades out.
 */
function shape(r) {
  const full = r.level - 4; // a bar this loud is the song fully in
  const { intro, outro } = r;
  if (intro?.loudness) {
    const L = intro.loudness, B = intro.bassness;
    const bassTop = quantile(B, 0.8);
    let k = 0;
    // The song is fully in at the first bar that's loud with its bass in, and stays so for two bars.
    while (k < L.length - 1 && !(L[k] > full && B[k] > bassTop - 8 && L[k + 1] > full - 2)) k++;
    intro.build = k;
    intro.mainAt = intro.first + k * intro.bar;
  }
  if (outro?.loudness) {
    const L = outro.loudness, B = outro.bassness;
    const bassTop = quantile(B, 0.8);
    let k = L.length - 1;
    while (k > 0 && !(L[k] > full && B[k] > bassTop - 8)) k--;
    outro.lastFull = outro.first + (k + 1) * outro.bar;  // the end of the last bar with everything in
    outro.tail = L.length - 1 - k;
    // Fading out: the last bars each a little quieter than the one before.
    let fall = 0;
    for (let i = L.length - 1; i > 0 && L[i] < L[i - 1] - 0.5; i--) fall++;
    outro.fades = fall >= 3;
    // Where the music has dropped well under its loud level (in a fade, that's where to be gone by).
    let q = L.length - 1;
    while (q > 0 && L[q] < full - 12) q--;
    outro.quietAt = Math.min(r.end, outro.first + (q + 1) * outro.bar);
  }
}
