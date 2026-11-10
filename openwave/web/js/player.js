// Playback engine.
//
// Two <audio> "decks" alternate: while one plays, the next song buffers on the other, so the
// change-over is gapless (crossfaded, if enabled, or mixed by Smart mix: mix.js) and skipping is
// instant. OpenWave plays audio
// tracks only: a music video in the queue is swapped for its song version before it plays.
// Listening time is tracked per song for history and insights.
//
// While this device plays on another one, or listens together with one (see link.js), `remote` is
// set: the controls are sent to that device instead, and in "remote" mode the getters show what it
// is playing rather than anything local.

import { get, img } from './api.js';
import { store, slim } from './store.js';
import { offline } from './offline.js';
import { REMOTE, songUrl, preloadSong } from './remote.js';
import { Mix, analysis, knownAnalysis, audioGraph, graphPossible, routed } from './mix.js';
import { plan as planMix } from './mix-plan.js';

const decks = [document.getElementById('audio'), Object.assign(document.createElement('audio'), { preload: 'auto' })];
document.body.appendChild(decks[1]);
const deckBlobs = [null, null];

// iOS only lets one element play in the background and ignores element.volume: use a single deck there.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PRELOAD_AT = 30; // seconds before the end to start buffering the next song
const SMART_PRELOAD_AT = 110; // with Smart mix: the next song is fetched whole and analysed first

/** Opus wherever it plays (sounds better, and WebKit misreads AAC lengths); AAC otherwise. */
export const audioCodec = () => (decks[0].canPlayType('audio/webm; codecs="opus"') ? 'opus' : 'aac');

let seq = 0;
const tag = (t) => ({ ...slim(t), _k: ++seq }); // _k remembers insertion order so shuffle can be undone

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Player extends EventTarget {
  queue = [];
  index = -1;
  shuffle = false;
  repeat = 'off'; // off | all | one
  context = null; // {label, href}
  loading = false;
  loaded = false; // has the current track been attached to a media element?
  resumeAt = 0;
  token = 0;
  errors = 0;
  extending = null;
  lastSave = 0;
  deck = 0;
  vol = 0.8;
  preloaded = null; // {videoId, index, ready}
  fade = null;
  mix = null; // the Smart mix transition playing now (mix.js), or 'starting'
  sleep = null; // {at} | {endOfTrack: true}
  listenTrack = null;
  listened = 0;
  lastPos = null;
  remote = null; // {mode: 'remote' | 'follow', send(cmd), state, position()} while linked to another device
  heldAt = -1e9; // when this app last paused the music itself
  navAt = -1e9;  // when the app last changed screens
  events = [];   // recent playback events, for Settings → About → Copy the playback log

  get current() { return this.queue[this.index] || null; }
  get audioEl() { return decks[this.deck]; }
  get spare() { return decks[1 - this.deck]; }
  get el() { return this.audioEl; }
  get mirror() { return this.remote?.mode === 'remote'; }
  get paused() { return this.mirror ? !this.remote.state?.playing : this.el.paused; }
  get time() {
    if (this.mirror) return this.remote.position();
    return this.loaded ? this.el.currentTime : this.resumeAt;
  }
  get duration() {
    if (this.mirror) return this.remote.state?.duration || this.current?.duration || 0;
    const media = this.loaded && Number.isFinite(this.el.duration) ? this.el.duration : 0;
    const known = this.current?.duration || 0;
    return this.misreadLength() ? known : media || known;
  }

  /**
   * WebKit reports exactly double the real length for some of YouTube's files, then plays silence:
   * AAC, and in Safari 18 (the Mac app on macOS 15) Opus too. A genuinely longer file, such as a music
   * video's audio, is not about twice the song's real length, which comes from the engine (checkLength).
   */
  misreadLength() {
    const known = this.current?.duration || 0;
    if (!known || !this.loaded || !Number.isFinite(this.el.duration)) return false;
    const ratio = this.el.duration / known;
    return ratio > 1.9 && ratio < 2.1;
  }
  get upcoming() { return this.queue.slice(this.index + 1); }
  get dualDeck() { return !IOS; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  init() {
    for (const el of decks) {
      const mine = (fn) => (e) => { if (el === this.el) fn(e); };
      for (const type of ['play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'emptied', 'abort']) {
        el.addEventListener(type, () => this.note(`${el === this.el ? '' : 'spare '}${type} at ${el.currentTime.toFixed(1)}s`));
      }
      el.addEventListener('error', () => this.note(`error ${el.error?.code || ''} ${el.error?.message || ''}`));
      el.addEventListener('pause', mine(() => this.unexpectedPause()));
      el.addEventListener('timeupdate', mine(() => this.onTime()));
      el.addEventListener('play', mine(() => this.emit('state')));
      el.addEventListener('pause', mine(() => { this.emit('state'); this.saveQueue(); }));
      el.addEventListener('waiting', mine(() => this.setLoading(true)));
      el.addEventListener('playing', mine(() => { this.setLoading(false); this.errors = 0; this.prefetchNext(); }));
      el.addEventListener('canplay', mine(() => this.setLoading(false)));
      el.addEventListener('loadedmetadata', mine(() => { this.emit('time'); this.positionState(); }));
      el.addEventListener('seeking', mine(() => { this.cancelFade(); this.lastPos = null; }));
      el.addEventListener('ended', mine(() => this.onEnded()));
      el.addEventListener('error', mine(() => { if (el.getAttribute('src')) this.onError(); }));
    }
    this.setVolume(store.settings.volume ?? 0.8);
    this.restore();
    this.mediaSession();
    window.addEventListener('pagehide', () => { this.saveQueue(true); this.commitListen(true); });
    window.addEventListener('hashchange', () => { this.navAt = performance.now(); this.note(`screen ${location.hash}`); });
    document.addEventListener('visibilitychange', () => this.note(`app ${document.visibilityState}`));
  }

  setLoading(on) {
    if (this.loading === on) return;
    this.loading = on;
    this.emit('state');
  }

  // ---------------------------------------------------------------- sources
  streamUrl(id) {
    return `/api/stream/${id}?${this.quality()}`;
  }

  quality() {
    return `q=${store.settings.quality}&codec=${audioCodec()}`;
  }

  async sourceFor(t) {
    if (offline.has(t.videoId)) {
      const url = await offline.audioUrl(t.videoId);
      if (url) return { url, blob: true };
    }
    // Away from home (remote.js), each song arrives whole over the connection and plays from memory.
    if (REMOTE) return { url: await songUrl(t.videoId, this.quality()), blob: true };
    return { url: this.streamUrl(t.videoId), blob: false };
  }

  setSrc(i, src) {
    if (deckBlobs[i]) URL.revokeObjectURL(deckBlobs[i]);
    deckBlobs[i] = src.blob ? src.url : null;
    decks[i].src = src.url;
  }

  stopMedia() {
    this.heldAt = performance.now();
    decks.forEach((d) => d.pause());
  }

  /** Swap a music video in the queue for its audio track (no film dialogue, intros or skits). */
  async ensureAudio(i) {
    const t = this.queue[i];
    if (!t || t.type !== 'video' || t._checked || offline.has(t.videoId) || !navigator.onLine) return t;
    t._checked = true;
    try {
      const song = await get.audio(t.videoId, t.title, t.artists?.[0]?.name || '');
      if (song?.videoId && this.queue[i] === t) {
        this.queue[i] = { ...tag(song), _k: t._k, _checked: true };
        this.emit('queue');
      }
    } catch { /* no audio version: play what we have */ }
    return this.queue[i];
  }

  // ---------------------------------------------------------------- listening accounting
  /**
   * The song's real length, from the engine. The audio's own length can't be trusted: WebKit reports
   * twice the length of some AAC files and then plays silence (misreadLength), which can only be
   * caught when the real length is known, and some lists don't say it.
   */
  async checkLength(t) {
    try {
      const { seconds } = await get.length(t.videoId);
      if (!(seconds > 0) || t !== this.current || Math.abs((t.duration || 0) - seconds) < 2) return;
      t.duration = Math.round(seconds);
      this.saveQueue(true);
      this.emit('time');
      this.positionState();
    } catch { /* offline, or an older engine: keep what the list said */ }
  }

  beginTrack(t) {
    this.checkLength(t);
    this.analyseSoon(t);
    this.forcedEnd = false;
    this.resumes = 0;
    this.listenTrack = t;
    this.listened = 0;
    this.lastPos = null;
    this.emit('track', t);
    this.saveQueue(true);
    this.maybeExtend();
  }

  commitListen(keepalive = false) {
    if (this.listenTrack && this.listened >= 1 && store.session) store.recordPlay(this.listenTrack, this.listened, { keepalive });
    this.listenTrack = null;
    this.listened = 0;
  }

  // ---------------------------------------------------------------- loading
  async load({ autoplay = true, at = 0, fresh = true } = {}) {
    let t = this.current;
    if (!t) return;
    const token = ++this.token;
    if (t.type === 'video') {
      // Silence the previous song right away while we look up this one's audio version.
      this.cancelFade();
      this.stopMedia();
      this.setLoading(true);
      t = await this.ensureAudio(this.index);
      if (token !== this.token) return;
    }
    if (!navigator.onLine && !offline.has(t.videoId)) {
      // No connection: jump to the next track that is saved on this device.
      const i = this.queue.findIndex((x, n) => n > this.index && offline.has(x.videoId));
      if (i < 0) {
        this.emit('error', 'You’re offline and this song isn’t downloaded');
        this.emit('track', t);
        return;
      }
      this.index = i;
      this.emit('queue');
      t = this.current;
    }
    if (fresh) this.commitListen();
    this.cancelFade();
    this.clearPreload();
    this.loaded = true;
    this.resumeAt = 0;
    this.stopMedia();
    this.setLoading(true);
    if (fresh) { this.errors = 0; this.beginTrack(t); }
    this.updateMetadata();
    try {
      const src = await this.sourceFor(t);
      if (token !== this.token) { if (src.blob) URL.revokeObjectURL(src.url); return; }
      this.setSrc(this.deck, src);
      this.audioEl.volume = this.vol;
      this.audioEl.addEventListener('playing', () => this.routeForMix(), { once: true });
      if (at) this.audioEl.addEventListener('loadedmetadata', () => { this.audioEl.currentTime = at; }, { once: true });
      if (token !== this.token) return;
      if (autoplay) await this.el.play();
      else this.setLoading(false);
    } catch (e) {
      if (token !== this.token || e.name === 'AbortError') return;
      this.setLoading(false);
      if (e.name === 'NotAllowedError') { this.emit('state'); return; } // browser blocked autoplay; user can press play
      this.onError(e.message);
    }
  }

  // ---------------------------------------------------------------- gapless / crossfade
  nextIndex() {
    if (this.index < this.queue.length - 1) return this.index + 1;
    if (this.repeat === 'all' && this.queue.length > 1) return 0;
    return -1;
  }

  preloadValid() {
    const p = this.preloaded;
    return !!p?.ready && p.index === this.nextIndex() && this.queue[p.index]?.videoId === p.videoId;
  }

  async preloadNext() {
    const i = this.nextIndex();
    if (i < 0 || !this.dualDeck || this.remote || this.mix) return;
    const token = this.token;
    const p = { videoId: this.queue[i].videoId, index: i, ready: false };
    this.preloaded = p;
    const t = await this.ensureAudio(i);
    if (token !== this.token || this.preloaded !== p) return;
    p.videoId = t.videoId;
    if (!navigator.onLine && !offline.has(t.videoId)) { this.preloaded = null; return; }
    let src = await this.sourceFor(t);
    if (token !== this.token || this.preloaded !== p) { if (src.blob) URL.revokeObjectURL(src.url); return; }
    if (this.smartFor(i)) {
      src = await this.wholeSong(t, src);
      if (token !== this.token || this.preloaded !== p) { if (src.blob) URL.revokeObjectURL(src.url); return; }
    }
    const spare = 1 - this.deck;
    decks[spare].volume = 0;
    this.setSrc(spare, src);
    decks[spare].load();
    decks[spare].addEventListener('canplaythrough', () => { if (this.preloaded === p) { p.ready = true; this.planMix(); } }, { once: true });
    decks[spare].addEventListener('error', () => { if (this.preloaded === p) this.preloaded = null; }, { once: true });
  }

  // ---------------------------------------------------------------- Smart mix (mix.js)
  /** Is the change from the current song to queue[i] one for Smart mix? */
  smartFor(i = this.nextIndex()) {
    if (store.settings.smartMix === false || !this.dualDeck || this.remote || this.repeat === 'one' || this.sleep?.endOfTrack) return false;
    const a = this.current, b = this.queue[i];
    if (!a || !b || i !== this.nextIndex()) return false;
    // An album plays as it was made: its songs run into each other where the artist meant them to.
    if (this.context?.href?.startsWith('#/album/') || (a.album?.id && a.album.id === b.album?.id)) return false;
    return true;
  }

  /**
   * The next song, fetched whole, so what's analysed is exactly what the deck plays. Falls back to
   * streaming it (and a plain change-over) if it can't be fetched.
   */
  async wholeSong(t, src) {
    const codec = audioCodec();
    try {
      let url = src.url, blob = null;
      if (!src.blob) {
        const r = await fetch(src.url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        blob = await r.blob();
        url = URL.createObjectURL(blob);
      }
      analysis(t.videoId, codec, async () => (blob || (await (await fetch(url)).blob())).arrayBuffer())
        .then(() => this.planMix());
      return { url, blob: true };
    } catch (e) {
      this.note(`smart mix: next song not fetched whole (${e.message}), streaming it`);
      return src;
    }
  }

  /**
   * Put both decks through Smart mix's mixer as a song starts, rather than in the middle of one when
   * the first mix comes (moving a playing deck there can click). Only once a song really plays: the
   * mixer holds an audio stream open while it runs, which a song that never loads shouldn't.
   */
  routeForMix() {
    if (store.settings.smartMix === false || !this.dualDeck || !graphPossible() || routed(decks[0])) return;
    audioGraph().then((g) => {
      if (!g) return;
      decks.forEach((d) => g.chain(d));
      if (decks.some((d) => !d.paused)) g.wake();
    });
  }

  /** Analyse the song now playing, unless that's known already (it usually is: it was the next song). */
  analyseSoon(t) {
    clearTimeout(this.analyseTimer);
    if (store.settings.smartMix === false || !this.dualDeck || this.remote || !t) return;
    const codec = audioCodec();
    if (knownAnalysis(t.videoId, codec)) return;
    // A song that's streaming is fetched again for this, so not until the deck has all of it (or the
    // end is coming up): two downloads of one song at once can starve the one being played on a slow
    // phone or connection. A song playing from memory (downloaded, or away from home) goes at once.
    const go = () => {
      if (this.current !== t || knownAnalysis(t.videoId, codec)) return;
      const blob = deckBlobs[this.deck], el = this.el;
      const ends = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0;
      const whole = this.duration > 0 && ends >= this.duration - 1;
      if (!blob && !whole && this.duration - this.time > SMART_PRELOAD_AT + 30) { this.analyseTimer = setTimeout(go, 3000); return; }
      const url = blob || this.streamUrl(t.videoId);
      analysis(t.videoId, codec, async () => { const r = await fetch(url); return r.ok ? r.arrayBuffer() : null; })
        .then(() => this.planMix());
    };
    // After it's started, so the first seconds of a song never wait on this.
    this.analyseTimer = setTimeout(go, 4000);
  }

  /** With both songs analysed and the next one ready: work out how they'll meet. */
  planMix() {
    const p = this.preloaded, t = this.current;
    if (!p?.ready || p.plan || !t || !this.smartFor(p.index)) return;
    const codec = audioCodec();
    const a = knownAnalysis(t.videoId, codec), b = knownAnalysis(p.videoId, codec);
    if (!a || !b) return;
    p.plan = planMix(a, b, { graph: graphPossible() });
    p.analyses = [a, b];
    this.note(`smart mix planned: ${p.plan.style} at ${p.plan.outAt?.toFixed(1)}s (${p.plan.reason})`);
    this.emit('mix', { phase: 'planned', style: p.plan.style, next: this.queue[p.index] });
  }

  /** Start the transition planned for the next song. */
  async startMix() {
    const p = this.preloaded, out = this.audioEl, inc = this.spare;
    if (!p?.plan || this.mix) return;
    this.mix = 'starting';
    const graph = await audioGraph();
    if (this.mix !== 'starting' || this.preloaded !== p || this.audioEl !== out || out.paused) {
      if (this.mix === 'starting') this.mix = null;
      return;
    }
    // Planned for the audio graph but it isn't running (yet): mix on volume alone this time.
    const plan = !graph && graphPossible() ? planMix(...p.analyses, { graph: false }) : p.plan;
    const mix = new Mix({
      plan, out, inc, graph, volume: () => this.vol, note: (s) => this.note(s),
      onAdvance: () => {
        if (this.preloaded !== p) return;
        this.advanceTo(p.index);
        this.emit('mix', { phase: 'advanced', style: mix.style, next: this.current });
      },
      onDone: () => {
        if (this.mix === mix) this.mix = null;
        if (mix.failed && this.preloaded === p) p.plan = null; // don't try that one again
        this.lastMix = mix;
        this.emit('mix', null);
        this.prefetchNext();
      },
    });
    this.mix = mix;
    mix.start();
    this.emit('mix', { phase: 'starting', style: mix.style, next: this.queue[p.index] });
  }

  /** Whatever the transition was doing: be in a plain state now (the next song if it had taken over). */
  settleMix(why = 'stopped') {
    const m = this.mix;
    if (!m || m === 'starting') { this.mix = null; return; }
    if (m.advanced) m.finish(); else m.abort(why);
  }

  clearPreload() {
    if (!this.preloaded) return;
    if (this.mix && !this.mix.advanced) this.settleMix('the queue changed');
    this.preloaded = null;
    const s = this.spare;
    s.pause();
    if (deckBlobs[1 - this.deck]) { URL.revokeObjectURL(deckBlobs[1 - this.deck]); deckBlobs[1 - this.deck] = null; }
    s.removeAttribute('src');
    s.load();
  }

  /** Switch to the preloaded deck: the queue moves on without reloading anything. */
  advanceTo(i) {
    this.commitListen();
    this.index = i;
    this.deck = 1 - this.deck;
    this.preloaded = null;
    this.loaded = true;
    this.errors = 0;
    this.beginTrack(this.current);
    this.updateMetadata();
    this.emit('queue');
    this.emit('state');
  }

  startCrossfade(seconds) {
    const incoming = this.spare;
    const outgoing = this.audioEl;
    const ms = Math.max(1, seconds) * 1000;
    const started = performance.now();
    // The buffered deck is already at 0; seeking it would fire 'seeking' and cancel the fade.
    if (incoming.currentTime > 0) incoming.currentTime = 0;
    incoming.volume = 0;
    incoming.muted = outgoing.muted;
    incoming.play().catch(() => {});
    this.fade = {
      incoming, outgoing,
      timer: setInterval(() => {
        const p = Math.min(1, (performance.now() - started) / ms);
        outgoing.volume = this.vol * Math.cos((p * Math.PI) / 2); // equal-power curve
        incoming.volume = this.vol * Math.sin((p * Math.PI) / 2);
        if (p >= 1) this.cancelFade();
      }, 50),
    };
    this.advanceTo(this.preloaded.index);
  }

  cancelFade() {
    this.settleMix('the song changed');
    if (!this.fade) return;
    clearInterval(this.fade.timer);
    this.fade.outgoing.pause();
    this.fade.incoming.volume = this.vol;
    this.fade = null;
  }

  // ---------------------------------------------------------------- queue
  playList(tracks, i = 0, context = null) {
    if (!tracks.length) return;
    if (this.remote) {
      const from = Math.max(0, i - 100); // a sensible slice of a huge list
      return this.remote.send({ cmd: 'playList', tracks: tracks.slice(from, from + 500).map(slim), i: i - from, context });
    }
    const list = tracks.map(tag);
    if (this.shuffle) {
      const [first] = list.splice(i, 1);
      this.queue = [first, ...shuffleInPlace(list)];
      this.index = 0;
    } else {
      this.queue = list;
      this.index = i;
    }
    this.context = context;
    this.emit('queue');
    this.load();
  }

  playRadio(track, context = null) {
    if (this.remote) return this.remote.send({ cmd: 'playRadio', track: slim(track), context });
    this.queue = [tag(track)];
    this.index = 0;
    this.context = context || { label: `${track.title} radio` };
    this.emit('queue');
    this.load();
    this.extend(track.videoId);
  }

  async playPlaylistRadio(seedId, playlistId, label) {
    if (this.remote) return this.remote.send({ cmd: 'playPlaylistRadio', seed: seedId, playlistId, label });
    const data = await get.next(seedId, playlistId);
    this.playList(data.tracks, 0, { label });
  }

  playNext(tracks) {
    if (this.remote) return this.remote.send({ cmd: 'playNext', tracks: tracks.slice(0, 500).map(slim) });
    if (!this.current) return this.playList(tracks);
    this.queue.splice(this.index + 1, 0, ...tracks.map(tag));
    this.queueChanged();
  }

  addToQueue(tracks) {
    if (this.remote) return this.remote.send({ cmd: 'addToQueue', tracks: tracks.slice(0, 500).map(slim) });
    if (!this.current) return this.playList(tracks);
    this.queue.push(...tracks.map(tag));
    this.queueChanged();
  }

  move(from, to) {
    if (this.remote) return this.remote.send({ cmd: 'move', ...this.remote.at(from), to: this.remote.at(to).i });
    if (from === to || from <= this.index || to <= this.index || from >= this.queue.length) return;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(Math.min(to, this.queue.length), 0, t);
    this.queueChanged();
  }

  queueChanged() {
    const p = this.preloaded;
    if (p && (p.index !== this.nextIndex() || this.queue[p.index]?.videoId !== p.videoId)) this.clearPreload();
    this.emit('queue');
    this.saveQueue(true);
  }

  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    if (this.remote) return this.remote.send({ cmd: 'removeAt', ...this.remote.at(i) });
    const wasCurrent = i === this.index;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    if (wasCurrent) {
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      this.emit('queue');
      if (this.current) this.load({ autoplay: !this.el.paused });
      else { this.stopMedia(); this.loaded = false; this.emit('track', null); }
      return;
    }
    this.queueChanged();
  }

  jump(i) {
    if (i < 0 || i >= this.queue.length) return;
    if (this.remote) return this.remote.send({ cmd: 'jump', ...this.remote.at(i) });
    if (this.mix?.phase === 'mix' && !this.mix.advanced && i === this.nextIndex()) { this.mix.finish(); return; }
    this.settleMix('another song was chosen');
    if (i === this.nextIndex() && this.preloadValid()) return this.skipToPreloaded();
    this.index = i;
    this.emit('queue');
    this.load();
  }

  async extend(seed = this.queue.at(-1)?.videoId) {
    if (!seed || this.extending || this.remote) return this.extending;
    this.extending = (async () => {
      try {
        let tracks;
        try {
          // Personal radio skips what this profile played recently.
          tracks = store.session ? (await store.api(`/api/me/radio/${seed}`)).tracks : null;
        } catch { tracks = null; }
        tracks ||= (await get.next(seed)).tracks;
        const have = new Set(this.queue.map((t) => t.videoId));
        const fresh = tracks.filter((t) => !have.has(t.videoId));
        if (fresh.length) {
          this.queue.push(...fresh.map(tag));
          this.emit('queue');
          this.prefetchNext();
        }
      } catch (e) {
        console.warn('autoplay failed', e);
      } finally {
        this.extending = null;
      }
    })();
    return this.extending;
  }

  maybeExtend() {
    if (navigator.onLine && store.settings.autoplay && this.repeat === 'off' && this.queue.length - this.index <= 3) this.extend();
  }

  prefetchNext() {
    const n = this.queue[this.index + 1];
    if (!n || !navigator.onLine || offline.has(n.videoId)) return;
    if (!REMOTE) { get.prefetch(n.videoId); return; }
    // Fetch the whole next song now, so it starts instantly, even with the screen locked.
    const i = this.index + 1;
    this.ensureAudio(i).then((t) => { if (t && !offline.has(t.videoId)) preloadSong(t.videoId, this.quality()); });
  }

  // ---------------------------------------------------------------- transport
  toggle() {
    if (this.remote) return this.remote.send({ cmd: 'toggle' });
    if (!this.current) return;
    if (!this.loaded) return this.load({ at: this.resumeAt, fresh: true });
    if (this.el.paused) this.el.play().catch(() => {});
    else { this.settleMix('paused'); this.heldAt = performance.now(); this.el.pause(); }
  }

  play() {
    if (this.remote) return this.remote.send({ cmd: 'play' });
    if (!this.current) return;
    if (!this.loaded || this.el.paused) this.toggle();
  }

  pause() {
    if (this.remote) return this.remote.send({ cmd: 'pause' });
    if (this.loaded && !this.el.paused) { this.settleMix('paused'); this.heldAt = performance.now(); this.el.pause(); }
  }

  /**
   * Safari can pause the music when a Home Screen app changes screens (see nav.js). A pause that
   * neither the person nor this app asked for, right after a screen change, is undone at once.
   */
  unexpectedPause() {
    const now = performance.now();
    // Only Safari does this; elsewhere a pause the app didn't make is the system's (headphones out).
    if (!IOS || this.remote || this.el.ended || !this.loaded || now - this.heldAt < 1500 || now - this.navAt > 3000) return;
    this.note('resuming: paused right after a screen change');
    this.el.play().catch((e) => this.note(`resume refused: ${e.name}`));
  }

  /** One line in the playback log (the last 300 are kept). */
  note(what) {
    this.events.push(`${new Date().toISOString().slice(11, 23)} ${what}`);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
  }

  /** The playback log, with what's needed to make sense of it. */
  playbackLog() {
    const t = this.current;
    return [`OpenWave playback log · ${navigator.userAgent}`,
      `standalone: ${navigator.standalone === true || matchMedia('(display-mode: standalone)').matches} · track: ${t ? `${t.videoId} ${t.title}` : 'none'} · src: ${(this.el.currentSrc || '').slice(0, 80)}`,
      ...this.events].join('\n');
  }

  skipToPreloaded() {
    const incoming = this.spare;
    this.heldAt = performance.now();
    this.audioEl.pause();
    if (incoming.currentTime > 0) incoming.currentTime = 0;
    incoming.volume = this.vol;
    incoming.muted = this.audioEl.muted;
    this.advanceTo(this.preloaded.index);
    incoming.play().catch(() => this.load({ fresh: false }));
  }

  async next() {
    if (this.remote) return this.remote.send({ cmd: 'next' });
    // In the middle of a mix the next song is already playing: Next lets it take over at once.
    if (this.mix?.phase === 'mix' && !this.mix.advanced) { this.mix.finish(); return; }
    this.cancelFade();
    if (this.loaded && this.preloadValid()) return this.skipToPreloaded();
    if (this.index < this.queue.length - 1) { this.index++; this.emit('queue'); return this.load(); }
    if (this.repeat === 'all' && this.queue.length) { this.index = 0; this.emit('queue'); return this.load(); }
    if (store.settings.autoplay && this.current && navigator.onLine) {
      await this.extend(this.current.videoId);
      if (this.index < this.queue.length - 1) { this.index++; this.emit('queue'); return this.load(); }
    }
    this.pause();
  }

  prev() {
    if (this.remote) return this.remote.send({ cmd: 'prev' });
    this.cancelFade();
    if (this.time > 3 || this.index <= 0) return this.seek(0);
    this.index--;
    this.emit('queue');
    this.load();
  }

  seek(seconds) {
    if (this.remote) return this.remote.send({ cmd: 'seek', t: Math.max(0, seconds) });
    if (!this.loaded) { this.resumeAt = seconds; this.emit('time'); return; }
    this.el.currentTime = Math.max(0, Math.min(seconds, this.duration || seconds));
  }

  setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    if (this.mirror) { this.remote.send({ cmd: 'volume', v }); this.emit('volume'); return; }
    this.vol = v;
    if (this.mix?.setVolume) this.mix.setVolume(v);
    else if (!this.fade) decks.forEach((d) => { d.volume = d === this.audioEl ? v : d.volume && v; });
    decks.forEach((d) => { d.muted = false; });
    if (store.settings.volume !== v) store.setting('volume', v);
    this.emit('volume');
  }

  toggleMute() {
    if (this.mirror) return this.remote.send({ cmd: 'mute' });
    const m = !this.audioEl.muted;
    decks.forEach((d) => { d.muted = m; });
    this.emit('volume');
  }

  get muted() { return this.mirror ? false : this.audioEl.muted; }
  get volume() { return this.mirror ? this.remote.state?.volume ?? this.vol : this.vol; }

  toggleShuffle() {
    if (this.remote) { this.shuffle = !this.shuffle; this.emit('state'); return this.remote.send({ cmd: 'shuffle', on: this.shuffle }); }
    this.shuffle = !this.shuffle;
    const head = this.queue.slice(0, this.index + 1);
    const rest = this.upcoming;
    if (this.shuffle) shuffleInPlace(rest); else rest.sort((a, b) => a._k - b._k);
    this.queue = [...head, ...rest];
    this.queueChanged();
    this.emit('state');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    if (this.remote) { this.emit('state'); return this.remote.send({ cmd: 'repeat', mode: this.repeat }); }
    if (this.preloaded && !this.preloadValid()) this.clearPreload();
    this.emit('state');
    this.saveQueue(true);
  }

  // ---------------------------------------------------------------- sleep timer
  setSleep(value) {
    this.sleep = value === 'track' ? { endOfTrack: true } : value ? { at: Date.now() + value * 60000, minutes: value } : null;
    this.emit('sleep');
  }

  checkSleep() {
    if (!this.sleep?.at || Date.now() < this.sleep.at) return;
    this.sleep = null;
    this.emit('sleep');
    const el = this.el;
    const start = el.volume;
    let n = 0;
    const t = setInterval(() => {
      n++;
      el.volume = Math.max(0, start * (1 - n / 60));
      if (n >= 60) { clearInterval(t); this.heldAt = performance.now(); el.pause(); el.volume = this.vol; this.emit('slept'); }
    }, 100);
  }

  // ---------------------------------------------------------------- events
  onTime() {
    const pos = this.el.currentTime;
    if (this.lastPos != null && !this.el.paused) {
      const d = pos - this.lastPos;
      if (d > 0 && d < 2) this.listened += d;
    }
    this.lastPos = pos;
    this.emit('time');
    if (Date.now() - this.lastSave > 10000) this.saveQueue();
    this.checkSleep();
    if (!this.forcedEnd && this.misreadLength() && pos >= this.duration - 0.3) {
      this.forcedEnd = true; // the real audio has ended; don't sit through the phantom second half
      return this.onEnded();
    }
    if (!this.dualDeck || !this.loaded || this.repeat === 'one' || this.mix) return;
    const remaining = this.duration - pos;
    const smart = this.smartFor();
    if (smart) {
      // Smart mix: fetch and analyse the next song well before the end, then start the transition
      // a few bars ahead of where it's planned (a blend locks its beat first).
      if (!this.preloaded && remaining > 0 && remaining < SMART_PRELOAD_AT) this.preloadNext();
      const plan = this.preloadValid() ? this.preloaded.plan : null;
      if (plan?.outAt != null) {
        const lead = plan.style === 'blend' ? 4 * plan.barA + 5 : 6;
        if (pos >= plan.outAt - lead && pos < plan.outAt - 1 && !this.el.paused) this.startMix();
      }
      return;
    }
    const xfade = +store.settings.crossfade || 0;
    if (!this.preloaded && remaining > 0 && remaining < Math.max(PRELOAD_AT, xfade + 15)) this.preloadNext();
    if (xfade > 0 && !this.fade && this.preloadValid() && remaining <= xfade && !this.sleep?.endOfTrack) this.startCrossfade(remaining);
  }

  onEnded() {
    if (this.mix) return; // the transition moves on to the next song itself
    // A stream that broke off can look like the end of the song (WebKit even shortens the reported
    // length to match), so compare with the catalog length too, and pick up where it stopped.
    const pos = this.el.currentTime;
    const full = Math.max(this.duration, this.current?.duration || 0);
    if (!this.forcedEnd && !deckBlobs[this.deck] && full - pos > 5 && this.resumes < 3) {
      this.resumes++;
      return this.load({ at: pos, fresh: false });
    }
    if (this.sleep?.endOfTrack) {
      this.sleep = null;
      this.commitListen();
      this.emit('sleep');
      this.emit('slept');
      return;
    }
    if (this.remote) return; // listening together: the host moves everyone on to the next song
    if (this.repeat === 'one') { this.el.currentTime = 0; this.el.play().catch(() => {}); return; }
    if (store.settings.gapless !== false && this.preloadValid()) return this.skipToPreloaded();
    this.next();
  }

  async onError(message) {
    const t = this.current;
    if (!t) return;
    this.setLoading(false);
    this.errors++;
    if (this.errors === 1) {
      // Stream URLs expire; one silent retry usually fixes it.
      setTimeout(() => this.current === t && this.load({ at: this.el.currentTime || 0, fresh: false }), 800);
      return;
    }
    if (!message) {
      try {
        const r = await fetch(this.streamUrl(t.videoId), { headers: { Range: 'bytes=0-1' } });
        if (!r.ok) message = (await r.json()).error;
      } catch { /* ignore */ }
    }
    this.emit('error', `Can't play “${t.title}”${message ? ` — ${message}` : ''}`);
    this.errors = 0;
    if (this.index < this.queue.length - 1 && !this.remote) setTimeout(() => this.current === t && this.next(), 1500);
  }

  // ---------------------------------------------------------------- other devices (link.js)
  /** Play another device's queue here: listening together, or moving its music to this device. */
  adopt(s, { position = 0, playing = true } = {}) {
    if (!s?.track) return;
    const same = this.loaded && this.current?.videoId === s.track.videoId;
    this.queue = s.queue.map(tag);
    this.index = Math.min(Math.max(0, s.index), this.queue.length - 1);
    if (this.current?.videoId !== s.track.videoId) { this.queue = [tag(s.track)]; this.index = 0; }
    this.context = s.context || null;
    this.shuffle = !!s.shuffle;
    this.repeat = s.repeat || 'off';
    this.emit('queue');
    this.emit('state');
    if (!same) return this.load({ at: position, autoplay: playing });
    if (Math.abs(this.el.currentTime - position) > 1.5) this.el.currentTime = position;
    if (playing && this.el.paused) this.el.play().catch(() => {});
    if (!playing && !this.el.paused) { this.heldAt = performance.now(); this.el.pause(); }
  }

  /** Start or stop mirroring another device (remote.mode 'remote') or following it ('follow'). */
  link(remote) {
    const was = this.remote;
    if (was?.mode === 'remote' || remote?.mode === 'remote') {
      this.token++; // abandon any load in flight
      this.commitListen();
      this.cancelFade();
      this.clearPreload();
      this.stopMedia();
      this.setLoading(false);
    }
    if (remote?.mode === 'follow') this.clearPreload();
    this.remote = remote;
    if (was?.mode === 'remote' && !remote) {
      // Keep showing what was playing there, ready to carry on here with one tap.
      this.resumeAt = was.position();
      this.loaded = false;
    }
    decks.forEach((d) => { d.playbackRate = 1; });
    this.emit('track', this.current);
    this.emit('queue');
    this.emit('state');
    this.emit('time');
    this.emit('volume');
  }

  /** Remote mode: show the other device's queue and state. */
  mirrorState(s) {
    const before = this.current?.videoId;
    this.queue = s?.track ? s.queue.map(tag) : [];
    this.index = s?.track ? Math.min(Math.max(0, s.index), this.queue.length - 1) : -1;
    if (s?.track && this.current?.videoId !== s.track.videoId) { this.queue = [tag(s.track)]; this.index = 0; }
    this.context = s?.context || null;
    this.shuffle = !!s?.shuffle;
    this.repeat = s?.repeat || 'off';
    this.loaded = !!s?.track;
    this.loading = !!s?.loading;
    if (before !== this.current?.videoId) this.emit('track', this.current);
    this.emit('queue');
    this.emit('state');
    this.emit('time');
    this.emit('volume');
  }

  /** Listening together: nudge the speed (or jump) so this device stays in step with the host. */
  setRate(rate) {
    if (this.el.playbackRate !== rate) this.el.playbackRate = rate;
  }

  // ---------------------------------------------------------------- persistence
  saveQueue(force = false) {
    if (!force && Date.now() - this.lastSave < 3000) return;
    this.lastSave = Date.now();
    const start = Math.max(0, this.index - 50);
    store.saveQueue({
      queue: this.queue.slice(start, this.index + 200).map(slim),
      index: this.index - start,
      time: this.time,
      context: this.context,
      shuffle: this.shuffle,
      repeat: this.repeat,
    });
  }

  restore() {
    const s = store.loadQueue();
    if (!s?.queue?.length) return;
    this.queue = s.queue.map(tag);
    this.index = Math.min(Math.max(0, s.index), this.queue.length - 1);
    this.resumeAt = s.time || 0;
    this.context = s.context;
    this.shuffle = !!s.shuffle;
    this.repeat = s.repeat || 'off';
    this.loaded = false;
    queueMicrotask(() => {
      this.emit('track', this.current);
      this.emit('queue');
      this.emit('state');
      this.emit('time');
      this.updateMetadata();
    });
    // Pressing play to carry on is the most likely first tap, so get that song ready now.
    const t = this.current;
    if (t && navigator.onLine && !offline.has(t.videoId)) get.prefetch(t.videoId, t.type === 'video', t.title, t.artists?.[0]?.name || '');
  }

  // ---------------------------------------------------------------- OS integration
  mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* unsupported */ } };
    on('play', () => this.play());
    on('pause', () => this.pause());
    on('previoustrack', () => this.prev());
    on('nexttrack', () => this.next());
    on('seekto', (d) => this.seek(d.seekTime));
    on('seekbackward', (d) => this.seek(this.time - (d.seekOffset || 10)));
    on('seekforward', (d) => this.seek(this.time + (d.seekOffset || 10)));
    this.addEventListener('state', () => { ms.playbackState = this.current ? (this.paused ? 'paused' : 'playing') : 'none'; });
  }

  updateMetadata() {
    const t = this.current;
    if (!t) return;
    document.title = `${t.title} • ${t.artists.map((a) => a.name).join(', ')}`;
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const art = new URL(img(t.thumbnail, 512), location.href).href;
    const show = (src) => {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artists.map((a) => a.name).join(', '),
        album: t.album?.name || '',
        artwork: [{ src, sizes: '512x512', type: 'image/jpeg' }],
      });
    };
    show(art);
    // Away from home the Lock Screen can't load artwork by address; hand it the picture itself.
    if (REMOTE && t.thumbnail) {
      fetch(art).then((r) => (r.ok ? r.blob() : null)).then((b) => {
        if (!b || this.current !== t) return;
        if (this.artUrl) URL.revokeObjectURL(this.artUrl);
        this.artUrl = URL.createObjectURL(b);
        show(this.artUrl);
      }).catch(() => {});
    }
  }

  positionState() {
    try {
      if (this.duration) navigator.mediaSession?.setPositionState?.({ duration: this.duration, position: Math.min(this.time, this.duration), playbackRate: 1 });
    } catch { /* ignore */ }
  }
}

export const player = new Player();
