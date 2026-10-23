// Playback engine: queue, shuffle/repeat, autoplay radio, audio <-> video switching, media session.

import { get, img } from './api.js';
import { store, slim } from './store.js';
import { offline } from './offline.js';

const audio = document.getElementById('audio');
const video = document.getElementById('video');

let seq = 0;
const tag = (t) => ({ ...slim(t), _k: ++seq }); // _k remembers insertion order so shuffle can be undone

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let hlsLib = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/hls.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsLib = null; reject(new Error('Could not load the video player')); };
    document.head.appendChild(s);
  });
  return hlsLib;
}

class Player extends EventTarget {
  queue = [];
  index = -1;
  shuffle = false;
  repeat = 'off'; // off | all | one
  mode = 'audio'; // audio | video
  context = null; // {label, href}
  loading = false;
  loaded = false; // has the current track been attached to a media element?
  resumeAt = 0;
  hls = null;
  token = 0;
  errors = 0;
  extending = null;
  lastSave = 0;
  blobUrl = null; // object URL of a downloaded track currently attached to <audio>

  get current() { return this.queue[this.index] || null; }
  get el() { return this.mode === 'video' ? video : audio; }
  get paused() { return this.el.paused; }
  get time() { return this.loaded ? this.el.currentTime : this.resumeAt; }
  get duration() { return (this.loaded && Number.isFinite(this.el.duration) && this.el.duration) || this.current?.duration || 0; }
  get upcoming() { return this.queue.slice(this.index + 1); }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  init() {
    for (const el of [audio, video]) {
      const mine = (fn) => (e) => { if (el === this.el) fn(e); };
      el.addEventListener('timeupdate', mine(() => this.onTime()));
      el.addEventListener('play', mine(() => this.emit('state')));
      el.addEventListener('pause', mine(() => { this.emit('state'); this.saveSession(); }));
      el.addEventListener('waiting', mine(() => this.setLoading(true)));
      el.addEventListener('playing', mine(() => { this.setLoading(false); this.errors = 0; this.prefetchNext(); }));
      el.addEventListener('canplay', mine(() => this.setLoading(false)));
      el.addEventListener('loadedmetadata', mine(() => { this.emit('time'); this.positionState(); }));
      el.addEventListener('ended', mine(() => this.onEnded()));
      el.addEventListener('error', mine(() => { if (el.getAttribute('src') && !this.hls) this.onError(); }));
    }
    this.setVolume(store.settings.volume ?? 0.8);
    this.restore();
    this.mediaSession();
    window.addEventListener('pagehide', () => this.saveSession(true));
  }

  setLoading(on) {
    if (this.loading === on) return;
    this.loading = on;
    this.emit('state');
  }

  // ---------------------------------------------------------------- loading
  streamUrl(id) {
    let q = store.settings.quality;
    if (q === 'high' && !audio.canPlayType('audio/webm; codecs="opus"')) q = 'normal';
    return `/api/stream/${id}?q=${q}`;
  }

  stopMedia() {
    audio.pause();
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    video.pause();
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
  }

  async load({ autoplay = true, at = 0, fresh = true } = {}) {
    let t = this.current;
    if (!t) return;
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
    if (this.mode === 'video' && !navigator.onLine) { this.mode = 'audio'; this.emit('mode', 'audio'); }
    const token = ++this.token;
    this.loaded = true;
    this.resumeAt = 0;
    this.stopMedia();
    this.setLoading(true);
    if (fresh) {
      this.errors = 0;
      this.emit('track', t);
      store.pushHistory(t);
      this.saveSession(true);
      this.maybeExtend();
    }
    this.updateMetadata();
    try {
      if (this.mode === 'video') {
        await this.attachVideo(t.videoId, at, token);
      } else {
        const local = offline.has(t.videoId) ? await offline.audioUrl(t.videoId) : null;
        if (token !== this.token) { if (local) URL.revokeObjectURL(local); return; }
        this.blobUrl = local;
        audio.src = local || this.streamUrl(t.videoId);
        if (at) audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
      }
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

  async attachVideo(id, at, token) {
    const src = await get.video(id);
    if (token !== this.token) return;
    const Hls = src.hls ? await loadHls().catch(() => null) : null;
    if (token !== this.token) return;
    if (src.hls && Hls?.isSupported()) {
      const hls = new Hls({ startPosition: at || -1, maxBufferLength: 30, backBufferLength: 30 });
      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || this.hls !== hls) return;
        hls.destroy();
        this.hls = null;
        if (src.mp4) { video.src = src.mp4; video.play().catch(() => {}); } else this.onError('Video stream failed');
      });
      hls.loadSource(src.hls);
      hls.attachMedia(video);
      return;
    }
    const url = (src.hls && video.canPlayType('application/vnd.apple.mpegurl')) ? src.hls : src.mp4;
    if (!url) throw new Error('No video available for this track');
    video.src = url;
    if (at) video.addEventListener('loadedmetadata', () => { video.currentTime = at; }, { once: true });
  }

  async setMode(mode) {
    if (mode === this.mode) return;
    const at = this.time;
    const resume = this.loaded && !this.el.paused;
    this.stopMedia();
    this.mode = mode;
    this.emit('mode', mode);
    if (this.current && this.loaded) await this.load({ autoplay: resume, at, fresh: false });
  }

  // ---------------------------------------------------------------- queue
  playList(tracks, i = 0, context = null) {
    if (!tracks.length) return;
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
    this.queue = [tag(track)];
    this.index = 0;
    this.context = context || { label: `${track.title} radio` };
    this.emit('queue');
    this.load();
    this.extend(track.videoId);
  }

  async playPlaylistRadio(seedId, playlistId, label) {
    const data = await get.next(seedId, playlistId);
    this.playList(data.tracks, 0, { label });
  }

  playNext(tracks) {
    if (!this.current) return this.playList(tracks);
    this.queue.splice(this.index + 1, 0, ...tracks.map(tag));
    this.emit('queue');
    this.saveSession(true);
  }

  addToQueue(tracks) {
    if (!this.current) return this.playList(tracks);
    this.queue.push(...tracks.map(tag));
    this.emit('queue');
    this.saveSession(true);
  }

  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    const wasCurrent = i === this.index;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this.emit('queue');
    if (wasCurrent) {
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      if (this.current) this.load({ autoplay: !this.el.paused });
      else { this.stopMedia(); this.loaded = false; this.emit('track', null); }
    }
    this.saveSession(true);
  }

  jump(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.emit('queue');
    this.load();
  }

  async extend(seed = this.queue.at(-1)?.videoId) {
    if (!seed || this.extending) return this.extending;
    this.extending = (async () => {
      try {
        const data = await get.next(seed);
        const have = new Set(this.queue.map((t) => t.videoId));
        const fresh = data.tracks.filter((t) => !have.has(t.videoId));
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
    if (navigator.onLine && store.settings.autoplay && this.repeat === 'off' && this.queue.length - this.index <= 2) this.extend();
  }

  prefetchNext() {
    const n = this.queue[this.index + 1];
    if (n && navigator.onLine && !offline.has(n.videoId)) get.prefetch(n.videoId);
  }

  // ---------------------------------------------------------------- transport
  toggle() {
    if (!this.current) return;
    if (!this.loaded) return this.load({ at: this.resumeAt, fresh: false });
    if (this.el.paused) this.el.play().catch(() => {});
    else this.el.pause();
  }

  play() { if (this.el.paused) this.toggle(); }
  pause() { if (!this.el.paused) this.el.pause(); }

  async next() {
    if (this.index < this.queue.length - 1) { this.index++; this.emit('queue'); return this.load(); }
    if (this.repeat === 'all' && this.queue.length) { this.index = 0; this.emit('queue'); return this.load(); }
    if (store.settings.autoplay && this.current) {
      await this.extend(this.current.videoId);
      if (this.index < this.queue.length - 1) { this.index++; this.emit('queue'); return this.load(); }
    }
    this.pause();
  }

  prev() {
    if (this.time > 3 || this.index <= 0) return this.seek(0);
    this.index--;
    this.emit('queue');
    this.load();
  }

  seek(seconds) {
    if (!this.loaded) { this.resumeAt = seconds; this.emit('time'); return; }
    this.el.currentTime = Math.max(0, Math.min(seconds, this.duration || seconds));
  }

  setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    audio.volume = video.volume = v;
    audio.muted = video.muted = false;
    if (store.settings.volume !== v) store.setting('volume', v);
    this.emit('volume');
  }

  toggleMute() {
    const m = !audio.muted;
    audio.muted = video.muted = m;
    this.emit('volume');
  }

  get muted() { return audio.muted; }
  get volume() { return audio.volume; }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const head = this.queue.slice(0, this.index + 1);
    const rest = this.upcoming;
    if (this.shuffle) shuffleInPlace(rest); else rest.sort((a, b) => a._k - b._k);
    this.queue = [...head, ...rest];
    this.emit('queue');
    this.emit('state');
    this.saveSession(true);
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit('state');
    this.saveSession(true);
  }

  onEnded() {
    if (this.repeat === 'one') { this.el.currentTime = 0; this.el.play().catch(() => {}); return; }
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
    if (this.index < this.queue.length - 1) setTimeout(() => this.current === t && this.next(), 1500);
  }

  onTime() {
    this.emit('time');
    if (Date.now() - this.lastSave > 10000) this.saveSession();
  }

  // ---------------------------------------------------------------- persistence
  saveSession(force = false) {
    if (!force && Date.now() - this.lastSave < 3000) return;
    this.lastSave = Date.now();
    const start = Math.max(0, this.index - 50);
    store.saveSession({
      queue: this.queue.slice(start, this.index + 200).map(slim),
      index: this.index - start,
      time: this.time,
      context: this.context,
      shuffle: this.shuffle,
      repeat: this.repeat,
    });
  }

  restore() {
    const s = store.loadSession();
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
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artists.map((a) => a.name).join(', '),
      album: t.album?.name || '',
      artwork: [{ src: art, sizes: '512x512', type: 'image/jpeg' }],
    });
  }

  positionState() {
    try {
      if (this.duration) navigator.mediaSession?.setPositionState?.({ duration: this.duration, position: Math.min(this.time, this.duration), playbackRate: 1 });
    } catch { /* ignore */ }
  }
}

export const player = new Player();
