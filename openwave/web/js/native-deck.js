// The Mac app plays music with macOS's own audio engine (macos/Sources/OpenWave/NativeAudio.swift).
// Here is what the page sees of it:
//
//   NativeDeck   stands in for an <audio> element (the properties, methods and events player.js,
//                mix.js and link.js use), and asks the Mac app to load, play, pause, seek and change
//                speed. Where it is in its song comes from the app twenty times a second, measured on
//                the engine's own clock, so both decks' positions compare exactly.
//   nativeGraph  stands in for mix.js's Web Audio graph: each deck's volume, bass, filters and echo
//                send are parameters that move on the engine's clock, scheduled the same way as Web
//                Audio's, and played out by the Mac app to the sample.
//
// A song macOS can't decode (an Opus download made by an older OpenWave) plays through a plain
// <audio> element inside the deck instead, as before, with a plain fade for its mixes.

export const NATIVE = !!window.OpenWaveNativeAudio && !!window.webkit?.messageHandlers?.audio;
const post = (msg) => window.webkit.messageHandlers.audio.postMessage(msg);

// ------------------------------------------------------------------ the engine's clock
let clock = { engine: 0, at: performance.now() };
const engineNow = () => clock.engine + (performance.now() - clock.at) / 1000;

const decks = [];
const waiting = new Map(); // samples asked for, by id
let askId = 0;

window.__openwaveAudio = (msg) => {
  clock = { engine: msg.engine, at: performance.now() };
  for (const s of msg.decks) decks[s.deck]?.state(s);
  if (msg.event) decks[msg.event.deck]?.event(msg.event.type, msg.event.message);
};
window.__openwaveAudioSamples = (deck, id, b64) => {
  const done = waiting.get(id);
  if (!done) return;
  waiting.delete(id);
  if (!b64) return done(null);
  const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v > 32767) v -= 65536;
    out[i] = v / 32767;
  }
  done(out);
};

// ------------------------------------------------------------------ parameters
/** A Web Audio-style parameter whose moves are played out by the Mac app, on the engine's clock. */
class NativeParam {
  constructor(decksOf, name, initial) {
    Object.assign(this, { decksOf, name, initial });
    this.events = [];
  }

  /** The value at time t, as the Mac app works it out (Automation in NativeAudio.swift). */
  at(t) {
    let v = this.initial, vt = -Infinity;
    for (const e of this.events) {
      if (e.kind === 'curve') {
        if (t < e.time) return v;
        if (t <= e.end && e.curve.length) {
          const p = ((t - e.time) / Math.max(1e-9, e.end - e.time)) * (e.curve.length - 1);
          const i = Math.min(e.curve.length - 2, Math.floor(p)), f = p - i;
          return e.curve.length === 1 ? e.curve[0] : e.curve[i] * (1 - f) + e.curve[i + 1] * f;
        }
        v = e.curve.at(-1) ?? v;
        vt = e.end;
      } else if (e.kind === 'linear' || e.kind === 'exp') {
        if (t < e.time) {
          const span = e.time - vt, p = Number.isFinite(span) && span > 0 ? (t - vt) / span : 1;
          if (e.kind === 'exp' && v > 0 && e.value > 0) return v * (e.value / v) ** p;
          return v + (e.value - v) * p;
        }
        v = e.value;
        vt = e.time;
      } else {
        if (t < e.time) return v;
        v = e.value;
        vt = e.time;
      }
    }
    return v;
  }

  get value() { return this.at(engineNow()); }
  set value(v) { this.setValueAtTime(v, engineNow()); }

  add(e) {
    this.events.push(e);
    this.events.sort((a, b) => a.time - b.time);
    this.sync();
    return this;
  }

  sync() {
    // Moves long past only matter for where the value ended up: keep that, drop the rest.
    const now = engineNow(), old = this.events.filter((e) => e.end < now - 2);
    if (old.length > 1) {
      const v = this.at(now - 2);
      this.events = [{ kind: 'set', time: now - 2, value: v, end: now - 2, curve: [] }, ...this.events.filter((e) => e.end >= now - 2)];
    }
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const d of this.decksOf()) post({ op: 'param', deck: d.i, param: this.name, events: this.events });
    });
  }

  setValueAtTime(value, time) { return this.add({ kind: 'set', time, value, end: time, curve: [] }); }
  linearRampToValueAtTime(value, time) { return this.add({ kind: 'linear', time, value, end: time, curve: [] }); }
  exponentialRampToValueAtTime(value, time) { return this.add({ kind: 'exp', time, value, end: time, curve: [] }); }
  setValueCurveAtTime(values, time, duration) {
    return this.add({ kind: 'curve', time, value: values.at(-1), end: time + duration, curve: Array.from(values) });
  }
  cancelScheduledValues(time) {
    this.events = this.events.filter((e) => e.time < time);
    this.sync();
    return this;
  }
  cancelAndHoldAtTime(time) {
    const v = this.at(time);
    this.events = this.events.filter((e) => (e.kind === 'curve' ? e.end : e.time) < time);
    return this.setValueAtTime(v, time);
  }
}

// ------------------------------------------------------------------ a deck
export class NativeDeck extends EventTarget {
  constructor(i) {
    super();
    this.i = i;
    this._src = '';
    this.token = 0;
    this._paused = true;
    this.s = { time: 0, playing: false, ended: false, duration: 0, ready: false, loading: false };
    this.at = performance.now();
    this._volume = 1;
    this._muted = false;
    this._rate = 1;
    this._keepPitch = true;
    this.error = null;
    this.preload = 'auto';
    this.web = null; // a plain <audio> for a song macOS can't decode
    this.lastUpdate = 0;
    const own = () => [this];
    this.mixer = {
      el: this,
      bass: [{ gain: new NativeParam(own, 'bass0', 0) }, { gain: new NativeParam(own, 'bass1', 0) }],
      hp: { frequency: new NativeParam(own, 'hp', 10) },
      lp: { frequency: new NativeParam(own, 'lp', 20000) },
      gain: { gain: new NativeParam(own, 'gain', 1) },
      send: { gain: new NativeParam(own, 'send', 0) },
    };
    decks[i] = this;
    post({ op: 'unload', deck: i, token: 0 }); // a page that's just (re)loaded starts from silence
  }

  /** Does this deck play through the Mac app (and so mix beat for beat)? */
  get native() { return !this.web; }

  fire(type) { this.dispatchEvent(new Event(type)); }

  // -------------------------------------------------------------- from the Mac app
  state(s) {
    if (s.token !== this.token) return;
    this.s = s;
    this.at = performance.now();
    if (s.playing && !this._paused && performance.now() - this.lastUpdate > 240) {
      this.lastUpdate = performance.now();
      this.fire('timeupdate');
    }
  }

  event(type, message) {
    if (this.web) return;
    if (type === 'loaded') {
      this.fire('durationchange');
      this.fire('loadedmetadata');
      this.fire('loadeddata');
      this.fire('canplay');
      this.fire('canplaythrough');
      if (!this._paused) post({ op: 'play', deck: this.i });
    } else if (type === 'playing') {
      if (!this._paused) this.fire('playing');
    } else if (type === 'ended') {
      this._paused = true;
      this.fire('timeupdate');
      this.fire('pause');
      this.fire('ended');
    } else if (type === 'error') {
      this.error = { code: 4, message: message || 'The song couldn’t be played' };
      this.fire('error');
    } else if (type === 'seeked') {
      this.fire('seeked');
      this.fire('timeupdate');
    }
  }

  // -------------------------------------------------------------- source
  get src() { return this.web ? this.web.src : this._src; }
  set src(url) {
    this._src = url ? new URL(url, location.href).href : '';
    this.load();
  }
  get currentSrc() { return this.src; }
  getAttribute(name) { return name === 'src' ? this._src || null : null; }
  removeAttribute(name) { if (name === 'src') { this._src = ''; this.load(); } }

  load() {
    const token = ++this.token;
    this.error = null;
    this.dropWeb();
    this.s = { time: 0, playing: false, ended: false, duration: 0, ready: false, loading: !!this._src, token };
    this.fire('emptied');
    if (!this._src) { post({ op: 'unload', deck: this.i, token }); return; }
    this.fire('loadstart');
    if (!this._src.startsWith('blob:')) { post({ op: 'load', deck: this.i, url: this._src, token }); return; }
    // A song from memory (a download, or one fetched whole): send the Mac app the song itself,
    // unless it's in a format macOS can't decode, which plays here instead.
    fetch(this._src).then((r) => r.blob()).then(async (blob) => {
      if (token !== this.token) return;
      if (/webm|ogg|opus/i.test(blob.type)) return this.useWeb(this._src);
      const data = await new Promise((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] || '');
        r.onerror = () => fail(r.error);
        r.readAsDataURL(blob);
      });
      if (token === this.token) post({ op: 'load', deck: this.i, data, token });
    }).catch((e) => {
      if (token !== this.token) return;
      this.error = { code: 4, message: String(e?.message || e) };
      this.fire('error');
    });
  }

  /** Play this song through a plain <audio> element (no beat matching for it). */
  useWeb(url) {
    const el = (this.web = new Audio());
    el.preload = 'auto';
    for (const type of ['play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'emptied', 'abort', 'error', 'timeupdate', 'canplay',
      'canplaythrough', 'loadedmetadata', 'seeking', 'seeked', 'durationchange', 'volumechange']) {
      el.addEventListener(type, () => { if (this.web === el) this.fire(type); });
    }
    el.volume = this._volume;
    el.muted = this._muted;
    el.playbackRate = this._rate;
    el.src = url;
    if (!this._paused) el.play().catch(() => {});
  }

  dropWeb() {
    if (!this.web) return;
    const el = this.web;
    this.web = null;
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  // -------------------------------------------------------------- transport
  play() {
    if (this.web) return this.web.play();
    if (!this._src) return Promise.reject(new DOMException('No song', 'NotSupportedError'));
    const was = this._paused;
    this._paused = false;
    if (was) this.fire('play');
    if (this.s.ready) post({ op: 'play', deck: this.i });
    else this.fire('waiting');
    return Promise.resolve();
  }

  pause() {
    if (this.web) return this.web.pause();
    if (this._paused) return;
    this._paused = true;
    post({ op: 'pause', deck: this.i });
    this.s = { ...this.s, time: this.currentTime, playing: false };
    this.at = performance.now();
    this.fire('pause');
  }

  get paused() { return this.web ? this.web.paused : this._paused; }
  get ended() { return this.web ? this.web.ended : !!this.s.ended; }
  get seeking() { return this.web ? this.web.seeking : false; }
  get readyState() { return this.web ? this.web.readyState : this.s.ready ? 4 : 0; }
  get duration() { return this.web ? this.web.duration : this.s.ready ? this.s.duration : NaN; }
  get buffered() {
    if (this.web) return this.web.buffered;
    const end = this.s.ready ? this.s.duration : 0;
    return { length: end ? 1 : 0, start: () => 0, end: () => end };
  }

  get currentTime() {
    if (this.web) return this.web.currentTime;
    const { time, playing } = this.s;
    if (!playing || this._paused) return time;
    return Math.min(this.s.duration || Infinity, time + ((performance.now() - this.at) / 1000) * this._rate);
  }
  set currentTime(t) {
    if (this.web) { this.web.currentTime = t; return; }
    const at = Math.max(0, Number(t) || 0);
    this.s = { ...this.s, time: at, ended: false };
    this.at = performance.now();
    post({ op: 'seek', deck: this.i, time: at });
    this.fire('seeking');
  }

  get volume() { return this._volume; }
  set volume(v) { this._volume = Math.max(0, Math.min(1, v)); this.sendVolume(); }
  get muted() { return this._muted; }
  set muted(m) { this._muted = !!m; this.sendVolume(); }
  sendVolume() {
    if (this.web) { this.web.volume = this._volume; this.web.muted = this._muted; return; }
    post({ op: 'volume', deck: this.i, volume: this._volume, muted: this._muted });
  }

  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._rate = r; this.sendRate(); }
  get preservesPitch() { return this._keepPitch; }
  set preservesPitch(k) { this._keepPitch = !!k; this.sendRate(); }
  sendRate() {
    if (this.web) { this.web.playbackRate = this._rate; this.web.preservesPitch = this._keepPitch; return; }
    // Where the deck is now, at the old speed, before the new one counts.
    this.s = { ...this.s, time: this.currentTime };
    this.at = performance.now();
    post({ op: 'rate', deck: this.i, rate: this._rate, keepPitch: this._keepPitch });
  }

  canPlayType(type) { return /webm|ogg|opus/i.test(type) ? '' : 'probably'; }

  /** The song as Smart mix listens to it: mono, 11025 Hz, exactly as the Mac app decoded it. */
  samples() {
    if (this.web || !this.s.ready) return Promise.resolve(null);
    const id = ++askId;
    return new Promise((ok) => {
      waiting.set(id, ok);
      post({ op: 'samples', deck: this.i, id });
      setTimeout(() => { if (waiting.delete(id)) ok(null); }, 20000);
    });
  }
}

// ------------------------------------------------------------------ Smart mix's graph
const FLAT = [['bass0', 0], ['bass1', 0], ['hp', 10], ['lp', 20000], ['gain', 1], ['send', 0]];
const paramOf = (c, name) => ({ bass0: c.bass[0].gain, bass1: c.bass[1].gain, hp: c.hp.frequency, lp: c.lp.frequency, gain: c.gain.gain, send: c.send.gain })[name];

/** What mix.js needs of an audio graph, for the Mac app's two decks. */
export const nativeGraph = {
  native: true,
  ctx: { get currentTime() { return engineNow(); }, sampleRate: 44100, state: 'running' },
  chains: new Map(),
  delay: { delayTime: new NativeParam(() => decks, 'delay', 0.5) },
  chain(el) {
    this.chains.set(el, el.mixer);
    return el.mixer;
  },
  flat(c, len = 0.03) {
    const t = engineNow();
    for (const [name, v] of FLAT) paramOf(c, name).cancelAndHoldAtTime(t).linearRampToValueAtTime(v, t + len);
  },
  async running() { return true; },
  wake() {},
  rest() {},
};
