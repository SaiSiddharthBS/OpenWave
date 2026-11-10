// Smart mix, part 3: playing it. player.js hands over its two decks (audio elements) and a plan
// (mix-plan.js); this module plays the transition and hands back the next song.
//
// Two ways to play, chosen by what the browser allows:
//
//   graph  (Chrome, Android, Edge, Firefox) Each deck runs through its own small mixer in Web Audio:
//          two bass shelves (the bass swap), a high-pass and a low-pass (sweeps), a volume and a send
//          to an echo. Volumes and filters move on the audio clock, to the sample, scheduled ahead.
//   volume (WebKit: Safari and the Mac app) WebKit gives Web Audio silence for Opus, which OpenWave
//          plays there, so the decks can't be routed. Its clock can't line two songs up either: the
//          position it reports for a deck that has just started is off from what's heard by up to
//          half a second, and a change of speed can be heard. So there each song hands over to the
//          next with a fade, by volume, as its music ends (mix-plan.js).
//
// Beat matching: the next song starts a few seconds early and silently, at the speed that makes its
// beat as long as this one's. Both decks' positions are read every 20 ms and the next song's speed is
// nudged until its beats sit on this song's (a few milliseconds), or it's moved while still silent.
// Only then is it heard. If it hasn't locked by then, the blend becomes a short fade instead, so two
// beats are never heard out of step.
//
// Analysis (mix-analysis.js) runs in a worker (mix-worker.js) on a low-rate copy of the song's audio
// decoded from the same bytes the deck plays, and is kept per song in localStorage.

import { RATE, VERSION } from './mix-analysis.js';

const UA = navigator.userAgent;
/** Safari and the Mac app: Web Audio hears nothing from an Opus <audio>, so no graph there. */
export const WEBKIT = /AppleWebKit/.test(UA) && !/Chrome|Chromium|CriOS|Edg\/|Android/.test(UA);
const CAN_GRAPH = !WEBKIT && typeof window.AudioContext === 'function';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ analysis, kept per song
const PREFIX = `openwave:mix:${VERSION}:`;
const INDEX = 'openwave:mix:index';
const MAX_STORED = 400;
const memo = new Map();

function remember(key, a) {
  // The bar-by-bar levels are only needed to work out the intro and outro; the rest is small.
  const text = JSON.stringify(a, (k, v) => (k === 'loudness' || k === 'bassness' ? undefined
    : typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
  try {
    localStorage.setItem(key, text);
    const index = JSON.parse(localStorage.getItem(INDEX) || '[]').filter((k) => k !== key);
    index.push(key);
    while (index.length > MAX_STORED) localStorage.removeItem(index.shift());
    localStorage.setItem(INDEX, JSON.stringify(index));
  } catch { /* storage full or off: it's analysed again next time */ }
  return JSON.parse(text);
}
function recall(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
}

let worker = null, workerBroken = false, seq = 0;
const asked = new Map();
async function work(samples) {
  if (!worker && !workerBroken) {
    try {
      worker = new Worker(new URL('./mix-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const p = asked.get(data.id);
        if (!p) return;
        asked.delete(data.id);
        if (data.error) p.fail(new Error(data.error)); else p.ok(data.result);
      };
      worker.onerror = () => {
        workerBroken = true;
        worker = null;
        for (const p of asked.values()) p.fail(new Error('the analysis worker stopped'));
        asked.clear();
      };
    } catch { workerBroken = true; }
  }
  if (workerBroken) return (await import('./mix-analysis.js')).analyse(samples);
  return new Promise((ok, fail) => {
    const id = ++seq;
    asked.set(id, { ok, fail });
    worker.postMessage({ id, samples }, [samples.buffer]);
  });
}

/** The song's audio as mono samples at the analysis rate. */
async function decode(bytes) {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const buf = await ctx.decodeAudioData(bytes);
  const n = buf.length, ch = buf.numberOfChannels, out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

let queue = Promise.resolve();
const keyOf = (id, codec) => `${PREFIX}${codec}:${id}`;

/** What's already known about a song, without fetching anything (null if nothing yet). */
export function knownAnalysis(id, codec) {
  return recall(keyOf(id, codec));
}

/**
 * A song's analysis: from memory, from storage, or worked out from `bytes()` (an ArrayBuffer of
 * the audio). One song at a time; null if it can't be done (it then mixes with a plain fade).
 */
export function analysis(id, codec, bytes) {
  const key = keyOf(id, codec);
  if (memo.has(key)) return memo.get(key);
  const stored = recall(key);
  if (stored) { const p = Promise.resolve(stored); memo.set(key, p); return p; }
  const p = (queue = queue.then(async () => {
    const data = await bytes();
    if (!data || !data.byteLength || data.byteLength > 40e6) return null;
    const samples = await decode(data);
    if (samples.length > RATE * 60 * 15) return null; // a DJ set or an album in one: not a song to mix
    return remember(key, await work(samples));
  }).catch((e) => { console.warn('Smart mix could not analyse a song', e); memo.delete(key); return null; }));
  memo.set(key, p);
  return p;
}

// ------------------------------------------------------------------ the audio graph
let graph = null;
const FLAT = { bass: 0, hp: 10, lp: 20000, gain: 1, send: 0 };

class Graph {
  constructor() {
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'playback' }));
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    // The echo: a delay that feeds back through a high-pass, so each repeat is quieter and thinner.
    this.echoIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.55;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 6000;
    const thin = ctx.createBiquadFilter();
    thin.type = 'highpass';
    thin.frequency.value = 300;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.8;
    this.echoIn.connect(this.delay);
    this.delay.connect(dark);
    dark.connect(thin);
    thin.connect(this.feedback);
    this.feedback.connect(this.delay);
    thin.connect(this.wet);
    this.wet.connect(this.master);
    this.chains = new Map();
    // A context that stops would silence every routed deck: start it again whenever music plays.
    ctx.addEventListener('statechange', () => this.keepRunning());
    window.__openwaveMixTap?.(ctx, this.master); // the tests listen to what comes out
  }

  keepRunning() {
    if (this.ctx.state !== 'running' && [...this.chains.keys()].some((el) => !el.paused)) this.ctx.resume().catch(() => {});
  }

  async running() {
    if (this.ctx.state !== 'running') await Promise.race([this.ctx.resume().catch(() => {}), sleep(1500)]);
    const ok = this.ctx.state === 'running';
    this.rest(); // back to sleep if nothing goes on to play (a song that fails to load, say)
    return ok;
  }

  /** The deck's mixer, made the first time (an element, once routed, always plays through here). */
  chain(el) {
    let c = this.chains.get(el);
    if (c) return c;
    const ctx = this.ctx;
    const src = ctx.createMediaElementSource(el);
    const shelf = () => { const f = ctx.createBiquadFilter(); f.type = 'lowshelf'; f.frequency.value = 220; f.gain.value = 0; return f; };
    const bass = [shelf(), shelf()];
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = FLAT.hp;
    hp.Q.value = 0.707;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(FLAT.lp, ctx.sampleRate / 2 - 100);
    lp.Q.value = 0.707;
    const gain = ctx.createGain();
    const send = ctx.createGain();
    send.gain.value = 0;
    src.connect(bass[0]);
    bass[0].connect(bass[1]);
    bass[1].connect(hp);
    hp.connect(lp);
    lp.connect(gain);
    gain.connect(this.master);
    lp.connect(send);
    send.connect(this.echoIn);
    c = { el, bass, hp, lp, gain, send };
    this.chains.set(el, c);
    el.addEventListener('play', () => this.wake());
    for (const type of ['pause', 'ended', 'emptied']) el.addEventListener(type, () => this.rest());
    return c;
  }

  /**
   * A running context keeps an audio stream open even in silence, so Android would count OpenWave
   * as playing while it's paused (the battery, headsets and media keys all go by that). So it
   * sleeps a moment after every deck has stopped, and wakes as soon as one plays.
   */
  wake() {
    clearTimeout(this.resting);
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  rest() {
    clearTimeout(this.resting);
    this.resting = setTimeout(() => {
      if ([...this.chains.keys()].every((el) => el.paused) && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    }, 2000);
  }

  params(c) {
    return [[c.bass[0].gain, FLAT.bass], [c.bass[1].gain, FLAT.bass], [c.hp.frequency, FLAT.hp],
      [c.lp.frequency, Math.min(FLAT.lp, this.ctx.sampleRate / 2 - 100)], [c.gain.gain, FLAT.gain], [c.send.gain, FLAT.send]];
  }

  /** Stop everything scheduled on a deck and glide it back to plain (in `len` seconds). */
  flat(c, len = 0.03) {
    const t = this.ctx.currentTime;
    for (const [p, v] of this.params(c)) hold(p, t).linearRampToValueAtTime(v, t + len);
  }
}

/** Keep a parameter where it is now, dropping whatever was scheduled after. */
function hold(p, t) {
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v, t); }
  return p;
}

/** The audio graph, if this browser can have one and it's running (made on first use). */
export async function audioGraph() {
  if (!CAN_GRAPH) return null;
  try {
    graph ||= new Graph();
    return (await graph.running()) ? graph : null;
  } catch (e) {
    console.warn('Smart mix: no audio graph', e);
    return null;
  }
}
/** Whether the graph is (or can be) used: decides how plans are made. */
export const graphPossible = () => CAN_GRAPH;
/** Has this deck been put through the mixer? */
export const routed = (el) => !!graph?.chains.has(el);
/** Put a deck back to plain sound, if it was ever routed. */
export function plain(el) {
  const c = graph?.chains.get(el);
  if (c) graph.flat(c);
}

// ------------------------------------------------------------------ a steady tick
// A worker's timer keeps going when the page is in the background, where the page's own are slowed.
let ticker = null;
const tickers = new Set();
function onTick(fn) {
  tickers.add(fn);
  if (!ticker) {
    const run = () => tickers.forEach((f) => { try { f(); } catch (e) { console.warn(e); } });
    try {
      const src = 'const t = setInterval(() => postMessage(0), 20); onmessage = () => { clearInterval(t); close(); };';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = run;
      ticker = { stop: () => w.postMessage(0) };
    } catch {
      const t = setInterval(run, 20);
      ticker = { stop: () => clearInterval(t) };
    }
  }
  return () => {
    tickers.delete(fn);
    if (!tickers.size && ticker) { ticker.stop(); ticker = null; }
  };
}

// ------------------------------------------------------------------ where a deck is
/**
 * A deck's position now. currentTime moves in steps: about 10 ms in Chrome (each deck on its own),
 * a quarter of a second in WebKit away from normal speed. So each time it changes, the moment and
 * value are noted, and the position now is a straight line through the last few of those: within a
 * millisecond or so in Chrome, much better than any one reading.
 */
class Position {
  constructor(el) { this.el = el; this.reset(); }
  reset() { this.points = []; this.value = null; }
  sample(now) {
    const v = this.el.currentTime;
    if (v === this.value) return;
    this.value = v;
    this.points.push([now, v]);
    while (this.points.length > 14 || (this.points.length > 3 && this.points[0][0] < now - 1500)) this.points.shift();
  }
  at(now) {
    const pts = this.points, n = pts.length, rate = this.el.paused ? 0 : this.el.playbackRate;
    if (n < 4) return n ? pts[n - 1][1] + ((now - pts[n - 1][0]) / 1000) * rate : this.el.currentTime;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [t, v] of pts) { const x = (t - now) / 1000; sx += x; sy += v; sxx += x * x; sxy += x * v; }
    const den = n * sxx - sx * sx;
    if (!den) return pts[n - 1][1];
    const slope = (n * sxy - sx * sy) / den;
    return (sy - slope * sx) / n; // the line at x = 0, which is now
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Equal-power curves: as one goes down the other comes up, and together they sound as loud. */
const up = (p) => Math.sin((clamp(p, 0, 1) * Math.PI) / 2);
const down = (p) => Math.cos((clamp(p, 0, 1) * Math.PI) / 2);
const curve = (fn, n = 64) => Float32Array.from({ length: n }, (_, i) => fn(i / (n - 1)));

// ------------------------------------------------------------------ playing a transition
/**
 * One transition from `out` (the deck playing) to `inc` (the deck with the next song loaded).
 *   plan       from mix-plan.js
 *   graph      the audio graph, or null to mix on volume alone
 *   volume()   the listener's volume (0-1), read as it changes
 *   onAdvance  called once the next song has taken over (the player moves its queue on)
 *   onDone     called when the transition is over (the outgoing deck is stopped and plain again)
 *   note       a line for the playback log
 */
export class Mix {
  constructor({ plan, out, inc, graph = null, volume, onAdvance, onDone, note = () => {} }) {
    // Beat matching and echoes need the graph; without it, every change is a fade (mix-plan.js).
    if (!graph && plan.style !== 'fade') plan = { ...plan, style: 'fade', outEnd: plan.outEnd ?? plan.outAt + 2, rateA: 1, rateB: 1, inFrom: plan.inAt, reason: `${plan.reason}; a fade instead` };
    Object.assign(this, { plan, out, inc, graph, volume, onAdvance, onDone, note });
    this.phase = 'wait';     // wait -> lock -> mix -> glide -> done
    this.advanced = false;
    this.errors = [];        // recent beat errors (seconds of the next song), for the lock
    this.heard = [];         // beat errors while both are heard, for the log and the tests
    this.rateAt = 0;
    this.seekedAt = -1e9;
    this.posA = new Position(out);
    this.posB = new Position(inc);
    this.startLead = graph ? 0.012 : 0.03; // how far behind a deck is once it's got going, about
    // Lined up beat for beat before it's heard.
    this.lines = plan.style === 'blend';
    this.style = plan.style;
    const p = plan;
    // The outgoing song eases to the common tempo over two bars ending a bar before the blend.
    this.glide = p.style === 'blend' && Math.abs(p.rateA - 1) > 5e-4 ? { from: p.outAt - 3 * p.barA, to: p.outAt - p.barA } : null;
    // The next song starts (silently, for a blend) when this one reaches `bStart`.
    const lead = (p.inAt - p.inFrom) / (p.rateB || 1) * (p.rateA || 1);
    this.bStart = p.outAt - lead;
    this.advanceAt = p.style === 'blend' ? p.swap : p.style === 'fade' ? (p.outAt + p.outEnd) / 2 : p.outAt;
    this.endAt = p.style === 'echo' ? p.outAt + 0.05 : p.outEnd;
  }

  start() {
    this.stopTicking = onTick(() => this.tick());
    this.varispeed(true);
    if (this.graph) {
      this.a = this.graph.chain(this.out);
      this.b = this.graph.chain(this.inc);
      this.graph.flat(this.b, 0);
      hold(this.b.gain.gain, this.graph.ctx.currentTime).setValueAtTime(0, this.graph.ctx.currentTime);
    }
    this.inc.volume = this.graph ? this.volume() : 0;
    this.inc.muted = this.out.muted;
    this.note(`smart mix: ${this.plan.reason}`);
    this.tick();
    return this;
  }

  /** The next song's position that keeps its beats on this one's, for this one at `pa`. */
  target(pa) {
    const p = this.plan;
    return p.inAt + (pa - p.outAt) * ((p.rateB || 1) / (p.rateA || 1));
  }

  tick() {
    if (this.phase === 'done') return;
    const now = performance.now();
    const p = this.plan;
    this.posA.sample(now);
    const pa = this.posA.at(now);
    if (this.out.paused && !this.advanced && this.phase !== 'wait') return this.abort('the music was paused');
    if (this.advanced && this.inc.paused && this.phase === 'mix') { this.out.pause(); return this.finish(); }

    // This song eases to the common tempo, in a step every beat.
    if (this.glide && (this.phase === 'wait' || this.phase === 'lock') && !this.glided) {
      const k = clamp((pa - this.glide.from) / (this.glide.to - this.glide.from), 0, 1);
      const steps = 8, rate = 1 + (p.rateA - 1) * (Math.floor(k * steps) / steps);
      if (pa >= this.glide.from && Math.abs(this.out.playbackRate - rate) > 1e-5) this.out.playbackRate = rate;
      if (k >= 1) this.glided = true;
    }

    if (this.phase === 'wait' && pa >= this.bStart) this.begin(pa);
    if (this.phase === 'lock' || this.phase === 'mix') this.follow(now);
    // A blend is scheduled once its beat is locked, just before it's heard; an echo four beats
    // ahead, for the sweep up to the cut.
    const openAt = this.lines || this.style !== 'echo' ? p.outAt - 0.3 : p.outAt - 4 * (p.beatA || 0.5) - 0.3;
    if (!this.scheduled && pa >= openAt && (!this.lines || this.phase === 'lock')) this.open(pa);
    if (this.phase === 'lock' && this.scheduled && pa >= p.outAt - 0.3) this.phase = 'mix';
    if (!this.graph && (this.phase === 'mix' || (this.phase === 'lock' && this.style !== 'blend'))) this.levels(pa);
    if (this.phase === 'mix') {
      if (!this.advanced && pa >= this.advanceAt) this.advance();
      if (pa >= this.endAt || this.out.ended) this.release();
    }
    if (this.phase === 'glide') this.settle();
  }

  /** The next song starts: on its position for now, at its tempo, silent if it's a blend. */
  begin(pa) {
    const p = this.plan;
    this.phase = 'lock';
    this.inc.playbackRate = p.rateB || 1;
    const at = this.lines ? this.target(pa) + this.startLead : p.inFrom + Math.max(0, pa - this.bStart);
    this.inc.currentTime = Math.max(0, at);
    this.posB.reset();
    this.seekedAt = performance.now();
    this.inc.play().catch((e) => { this.failed = true; this.abort(`the next song would not start (${e.name})`); });
  }

  /**
   * Turntable speed (pitch moves with tempo, by a quarter of a semitone or so) while the beats are
   * matched, instead of the browser's time-stretch: that keeps the pitch but smears each drum hit by
   * up to 10 ms either way, which is heard as two kicks instead of one. Off again at the end.
   */
  varispeed(on) {
    const keep = !on;
    for (const el of [this.out, this.inc]) if ('preservesPitch' in el) el.preservesPitch = keep;
  }

  /** Beat matching: keep the next song's beats on this one's. */
  follow(now) {
    const p = this.plan;
    if (!this.lines || this.inc.paused || this.inc.seeking) return;
    this.posA.sample(now);
    this.posB.sample(now);
    if (now - this.seekedAt < 150 || now - this.rateAt < 250) return;
    const pa = this.posA.at(now), pb = this.posB.at(now);
    const e = this.target(pa) - pb; // seconds of the next song: positive, it's behind
    this.rateAt = now;
    this.errors.push(e);
    if (this.errors.length > 6) this.errors.shift();
    if (this.phase === 'mix') this.heard.push(e);
    if (window.__mixDebug) this.note(`lock ${this.phase} ${(e * 1000).toFixed(1)} ms, rate ${this.inc.playbackRate.toFixed(4)}`);
    if (this.phase === 'lock' && Math.abs(e) > 0.04) {
      // Way off and still silent: jump there.
      this.inc.currentTime = Math.max(0, this.inc.currentTime + e + this.startLead);
      this.posB.reset();
      this.errors = [];
      this.seekedAt = now;
      return;
    }
    // Close the gap over about a second while silent; gently, over two or three, once it's heard.
    const [span, most] = this.phase === 'lock' ? [1, 0.025] : [2.5, 0.008];
    // The next song's speed for this one's speed now (it may still be easing to the common tempo).
    const base = (p.rateB || 1) * ((this.out.playbackRate || 1) / (p.rateA || 1));
    const rate = base * (1 + clamp(e / span, -most, most));
    if (Math.abs(this.inc.playbackRate - rate) > 5e-5) this.inc.playbackRate = rate;
  }

  get locked() {
    return this.errors.length >= 3 && this.errors.slice(-3).every((e) => Math.abs(e) < 0.008);
  }

  /** The moment the next song is heard: schedule how the two move from here to the end. */
  open(pa) {
    const p = this.plan;
    this.scheduled = true;
    if (this.lines && !this.locked) {
      this.note(`smart mix: beats not locked (${((this.errors.at(-1) || 0) * 1000).toFixed(0)} ms off), fading instead`);
      this.style = 'fade';
      this.plan = { ...p, style: 'fade', outEnd: Math.min(p.outEnd, p.outAt + 4 * p.beatA) };
      this.endAt = this.plan.outEnd;
      this.advanceAt = (p.outAt + this.plan.outEnd) / 2;
    }
    if (!this.graph) return;
    try {
      this.schedule(pa);
    } catch (e) {
      // Shouldn't happen; if it does, a plain equal-power fade over two beats is still a good change.
      this.note(`smart mix: couldn't schedule the mix (${e.message}), fading`);
      const ctx = this.graph.ctx, t = ctx.currentTime, len = 2 * (this.plan.beatA || 0.5);
      hold(this.a.gain.gain, t).linearRampToValueAtTime(0, t + len);
      hold(this.b.gain.gain, t).linearRampToValueAtTime(1, t + len);
      this.style = 'fade';
      this.endAt = pa + len;
      this.advanceAt = pa + len / 2;
    }
  }

  /** The graph's moves, from this moment (the outgoing song at `pa`) to the end of the mix. */
  schedule(pa) {
    const g = this.graph, ctx = g.ctx;
    // Song seconds of the outgoing deck to audio-clock seconds, at its current speed.
    const rateA = this.out.playbackRate || 1;
    const t = (pos) => ctx.currentTime + Math.max(0, (pos - pa) / rateA);
    const a = this.a, b = this.b, q = this.plan;
    const beat = (q.beatA || 0.5) / rateA;
    if (this.style === 'blend') {
      const t0 = t(q.outAt), ts = t(q.swap), t1 = t(q.outEnd);
      const half = ts - t0;
      // In: rises over the first half with its bass held right down; the bass swaps on the downbeat.
      for (const f of b.bass) { hold(f.gain, ctx.currentTime).setValueAtTime(-26, ctx.currentTime); f.gain.setValueAtTime(-26, ts - beat); f.gain.linearRampToValueAtTime(0, ts); }
      hold(b.gain.gain, ctx.currentTime).setValueAtTime(0, ctx.currentTime);
      b.gain.gain.setValueCurveAtTime(curve(up), t0, Math.max(0.05, half * 0.75));
      // Out: full until the swap, then its bass goes and it fades over the second half, opening a
      // gentle high-pass on the way out.
      for (const f of a.bass) { hold(f.gain, ctx.currentTime).setValueAtTime(0, ts - beat); f.gain.linearRampToValueAtTime(-26, ts); }
      hold(a.gain.gain, ctx.currentTime);
      a.gain.gain.setValueCurveAtTime(curve(down), ts, Math.max(0.05, t1 - ts));
      hold(a.hp.frequency, ctx.currentTime).setValueAtTime(FLAT.hp, ts);
      a.hp.frequency.exponentialRampToValueAtTime(180, t1);
    } else if (this.style === 'echo') {
      // The last bar sweeps up, its last beat feeds the echo, and the song stops dead on the downbeat.
      const tc = t(q.outAt);
      g.delay.delayTime.setValueAtTime(clamp(beat, 0.05, 3.9), ctx.currentTime);
      hold(a.hp.frequency, ctx.currentTime).setValueAtTime(FLAT.hp, Math.max(ctx.currentTime, tc - 4 * beat));
      a.hp.frequency.exponentialRampToValueAtTime(500, tc);
      hold(a.send.gain, ctx.currentTime).setValueAtTime(0, Math.max(ctx.currentTime, tc - beat));
      a.send.gain.linearRampToValueAtTime(1, Math.max(ctx.currentTime, tc - beat) + 0.01);
      a.send.gain.setValueAtTime(1, tc);
      a.send.gain.linearRampToValueAtTime(0, tc + 0.015);
      hold(a.gain.gain, ctx.currentTime).setValueAtTime(1, tc);
      a.gain.gain.linearRampToValueAtTime(0, tc + 0.015);
      // The next song: anything before its first downbeat (a pickup) rises under the last beat; it
      // comes in a little under full for its first bar, so the echo is heard over it.
      const tb = t(this.bStart);
      hold(b.gain.gain, ctx.currentTime).setValueAtTime(tc - tb > 0.05 ? 0.35 : 0.7, Math.max(ctx.currentTime, Math.min(tb, tc - 0.005)));
      b.gain.gain.linearRampToValueAtTime(0.7, tc);
      b.gain.gain.linearRampToValueAtTime(1, tc + 4 * beat);
    } else {
      // A fade: equal power, this song's top end closing as it goes.
      const t0 = Math.max(ctx.currentTime, t(q.outAt)), t1 = Math.max(t0 + 0.1, t(q.outEnd));
      hold(a.gain.gain, ctx.currentTime).setValueCurveAtTime(curve(down), t0, t1 - t0);
      hold(a.lp.frequency, ctx.currentTime).setValueAtTime(a.lp.frequency.value, t0);
      a.lp.frequency.exponentialRampToValueAtTime(700, t1);
      hold(b.gain.gain, ctx.currentTime).setValueAtTime(0, ctx.currentTime);
      b.gain.gain.setValueCurveAtTime(curve(up), t0, t1 - t0);
    }
  }

  /** Without the graph (only ever a fade there): the volumes, by where the outgoing song is. */
  levels(pa) {
    const p = this.plan, v = this.volume();
    const k = (pa - p.outAt) / Math.max(0.1, p.outEnd - p.outAt);
    this.out.volume = clamp(v * down(k), 0, 1);
    this.inc.volume = clamp(v * up(k), 0, 1);
  }

  /** The next song has taken over: the player moves its queue on. */
  advance() {
    this.advanced = true;
    try { this.onAdvance?.(); } catch (e) { console.warn(e); }
  }

  /** The outgoing song has gone: stop it, put its deck back to plain, then let the tempo settle. */
  release() {
    if (!this.advanced) this.advance();
    this.out.pause();
    this.out.playbackRate = 1;
    this.out.volume = this.volume();
    if (this.graph) this.graph.flat(this.a, 0.02);
    if (!this.graph) this.inc.volume = this.volume();
    if (this.heard.length) {
      const ms = this.heard.map((e) => Math.abs(e) * 1000);
      this.stats = { median: median(ms), max: Math.max(...ms), n: ms.length };
      this.note(`smart mix: beats held to ${this.stats.median.toFixed(1)} ms (worst ${this.stats.max.toFixed(1)} ms)`);
    }
    this.phase = 'glide';
    this.glideFrom = this.inc.currentTime;
    this.glideRate = this.inc.playbackRate;
    this.settle();
  }

  /** The next song eases back to its own tempo over 16 of its beats, a step a beat. */
  settle() {
    const p = this.plan, from = this.glideRate;
    if (Math.abs(from - 1) < 5e-4 || this.inc.paused) return this.done();
    const beats = (this.inc.currentTime - this.glideFrom) / (p.beatB || 0.5);
    const k = clamp(Math.floor(beats) / 16, 0, 1);
    const rate = from + (1 - from) * k;
    if (Math.abs(this.inc.playbackRate - rate) > 1e-5) this.inc.playbackRate = rate;
    if (k >= 1) this.done();
  }

  done() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.inc.playbackRate = 1;
    this.varispeed(false);
    this.stopTicking?.();
    if (this.graph) this.graph.flat(this.b, 0.05);
    this.inc.volume = this.volume();
    try { this.onDone?.(this); } catch (e) { console.warn(e); }
  }

  /**
   * Stop where things are. Before the next song took over, the outgoing one carries on alone (as if
   * no mix had started); after, the next one carries on alone.
   */
  abort(why) {
    if (this.phase === 'done') return;
    this.note(`smart mix stopped: ${why}`);
    const keep = this.advanced ? this.inc : this.out, drop = this.advanced ? this.out : this.inc;
    if (this.advanced || this.phase !== 'wait') { drop.pause(); }
    drop.playbackRate = 1;
    keep.playbackRate = 1;
    this.varispeed(false);
    if (this.graph) { this.graph.flat(this.a, 0.05); this.graph.flat(this.b, 0.05); }
    keep.volume = this.volume();
    drop.volume = this.advanced ? this.volume() : 0;
    if (!this.advanced) { try { this.inc.currentTime = 0; } catch { /* not loaded */ } }
    this.phase = 'done';
    this.stopTicking?.();
    try { this.onDone?.(this); } catch (e) { console.warn(e); }
  }

  /** Jump to the end: only the next song, at its own tempo. */
  finish() {
    if (this.phase === 'done') return;
    if (this.phase === 'wait' || this.phase === 'lock') return this.abort('skipped');
    if (!this.advanced) this.advance();
    this.out.pause();
    this.out.playbackRate = 1;
    if (this.graph) this.graph.flat(this.a, 0.05);
    this.glideRate = 1;
    this.done();
  }

  setVolume(v) {
    this.out.volume = this.phase === 'mix' && !this.graph ? this.out.volume : v;
    this.inc.volume = this.phase === 'wait' && !this.graph ? 0 : v;
  }
}
