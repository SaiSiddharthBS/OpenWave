// Offline downloads: whole audio files + artwork stored in IndexedDB on this device.
// Downloaded tracks play from local storage, so they work with no connection at all.

import { img } from './api.js';
import { store, slim } from './store.js';

const DB_NAME = 'openwave-offline';
const TRACKS = 'tracks';
const CONCURRENCY = 2;

const events = new EventTarget();
const ids = new Set();
const pending = [];           // tracks waiting to download
const active = new Map();     // videoId -> progress 0..1
const artUrls = new Map();    // videoId -> object URL for stored artwork
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TRACKS, { keyPath: 'videoId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(TRACKS, mode);
    const req = fn(t.objectStore(TRACKS));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage is full'));
  });
}

const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));

function quality() {
  let q = store.settings.quality;
  if (q === 'high' && !document.createElement('audio').canPlayType('audio/webm; codecs="opus"')) q = 'normal';
  return q;
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const total = +res.headers.get('content-length') || 0;
  const type = res.headers.get('content-type') || 'audio/mp4';
  if (!res.body || !total) return new Blob([await res.arrayBuffer()], { type });
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got / total);
  }
  return new Blob(parts, { type });
}

async function downloadOne(track) {
  const id = track.videoId;
  active.set(id, 0);
  emit('progress', { id, progress: 0 });
  try {
    const audio = await fetchWithProgress(`/api/download/${id}?q=${quality()}`, (p) => {
      active.set(id, p);
      emit('progress', { id, progress: p });
    });
    let art = null;
    try {
      const r = await fetch(img(track.thumbnail, 544));
      if (r.ok) art = await r.blob();
    } catch { /* artwork is optional */ }
    await tx('readwrite', (s) => s.put({ videoId: id, track: slim(track), audio, art, size: audio.size, savedAt: Date.now() }));
    ids.add(id);
    emit('change', { id, added: true });
  } catch (e) {
    emit('error', { id, track, message: e.message });
  } finally {
    active.delete(id);
    emit('progress', { id, progress: null });
  }
}

function pump() {
  while (active.size < CONCURRENCY && pending.length) {
    const t = pending.shift();
    downloadOne(t).then(pump);
  }
  if (!active.size && !pending.length) emit('idle');
}

export const offline = {
  on: (type, fn) => events.addEventListener(type, (e) => fn(e.detail)),

  async init() {
    try {
      const keys = await tx('readonly', (s) => s.getAllKeys());
      keys.forEach((k) => ids.add(k));
    } catch (e) {
      console.warn('offline storage unavailable', e);
    }
    emit('change', {});
  },

  has: (id) => ids.has(id),
  get count() { return ids.size; },
  isBusy: (id) => active.has(id) || pending.some((t) => t.videoId === id),
  progress: (id) => active.get(id),
  get queued() { return pending.length + active.size; },

  /** Queue tracks for download; returns how many were newly queued. */
  download(tracks) {
    navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict downloads
    let n = 0;
    for (const t of tracks) {
      if (!t?.videoId || ids.has(t.videoId) || offline.isBusy(t.videoId)) continue;
      pending.push(slim(t));
      n++;
    }
    if (n) emit('queued', { count: n });
    pump();
    return n;
  },

  async remove(id) {
    await tx('readwrite', (s) => s.delete(id));
    ids.delete(id);
    const url = artUrls.get(id);
    if (url) { URL.revokeObjectURL(url); artUrls.delete(id); }
    emit('change', { id, removed: true });
  },

  async clear() {
    pending.length = 0;
    await tx('readwrite', (s) => s.clear());
    ids.clear();
    artUrls.forEach((u) => URL.revokeObjectURL(u));
    artUrls.clear();
    emit('change', { cleared: true });
  },

  /** Track metadata for every download, newest first (blobs stay on disk). */
  async list() {
    const rows = await tx('readonly', (s) => s.getAll());
    return rows.sort((a, b) => b.savedAt - a.savedAt).map((r) => ({ ...r.track, size: r.size }));
  },

  async usage() {
    const rows = await tx('readonly', (s) => s.getAll());
    return rows.reduce((n, r) => n + (r.size || 0), 0);
  },

  /** Object URL for a downloaded track's audio; the caller revokes it. */
  async audioUrl(id) {
    const r = await tx('readonly', (s) => s.get(id));
    return r?.audio ? URL.createObjectURL(r.audio) : null;
  },

  async artUrl(id) {
    if (artUrls.has(id)) return artUrls.get(id);
    const r = await tx('readonly', (s) => s.get(id));
    if (!r?.art) return null;
    const url = URL.createObjectURL(r.art);
    artUrls.set(id, url);
    return url;
  },
};

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
