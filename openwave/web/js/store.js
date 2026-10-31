// Your library, synced to the OpenWave server per profile.
//
// Every change is applied locally first (instant UI, works offline), recorded as an operation in
// an outbox, and pushed to the server. Other devices notice the profile's version change and pull.

const SESSION_KEY = 'openwave:session:v2';   // {token, profile}
const DEVICE_KEY = 'openwave:device:v1';     // per-device prefs (volume)
const QUEUE_KEY = 'openwave:queue:v1';       // playback queue survives reloads
const LEGACY_KEY = 'openwave:library:v1';    // pre-profiles browser-only library
const LEGACY_QUEUE_KEY = 'openwave:session:v1';
const cacheKey = (pid) => `openwave:lib:${pid}`;
const outboxKey = (pid) => `openwave:outbox:${pid}`;

export const DEFAULT_SETTINGS = { quality: 'normal', autoplay: true, crossfade: 0, gapless: true, notifications: true };

const emptyLibrary = () => ({
  version: 0, profile: null, liked: [], playlists: [], albums: [], artists: [], ytPlaylists: [],
  history: [], searches: [], settings: {},
});

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('storage full?', e); }
}

export const slim = (t) => ({
  type: t.type, videoId: t.videoId, title: t.title, artists: t.artists || [], album: t.album || null,
  duration: t.duration || null, thumbnail: t.thumbnail, explicit: !!t.explicit,
});
const card = (kind, c) => ({ type: kind, id: c.id, title: c.title, subtitle: c.subtitle || '', thumbnail: c.thumbnail });
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const SAVED = { album: 'albums', artist: 'artists', playlist: 'ytPlaylists' };

const events = new EventTarget();
let session = read(SESSION_KEY, null);
let data = session ? { ...emptyLibrary(), ...read(cacheKey(session.profile.id), {}) } : emptyLibrary();
let outbox = session ? read(outboxKey(session.profile.id), []) : [];
let device = read(DEVICE_KEY, { volume: 0.8 });
let flushing = null;
let saveTimer = null;

const emit = (what) => events.dispatchEvent(new CustomEvent('change', { detail: what }));
const authHeaders = () => ({ 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) });

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!session) return;
    write(cacheKey(session.profile.id), data);
    write(outboxKey(session.profile.id), outbox);
  }, 120);
}

class AuthError extends Error {}

async function call(path, { method = 'GET', body, keepalive = false } = {}) {
  const res = await fetch(path, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined, keepalive });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (res.status === 401) throw new AuthError(json?.error || 'Please pick your profile again');
  if (!res.ok) {
    const detail = Array.isArray(json?.detail) ? json.detail.map((d) => d.msg).join('; ') : json?.detail;
    const err = new Error(json?.error || detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ------------------------------------------------------------------ local op application (mirrors the server)
function applyLocal(op) {
  const pl = op.id && data.playlists.find((p) => p.id === op.id);
  switch (op.op) {
    case 'like':
      data.liked = [slim(op.track), ...data.liked.filter((t) => t.videoId !== op.track.videoId)];
      break;
    case 'unlike':
      data.liked = data.liked.filter((t) => t.videoId !== op.videoId);
      break;
    case 'playlist.create':
      if (!pl) data.playlists.unshift({ id: op.id, name: op.name, description: '', tracks: [], created: op.at, updated: op.at });
      if (op.tracks?.length) applyLocal({ op: 'playlist.add', id: op.id, tracks: op.tracks });
      break;
    case 'playlist.update':
      if (pl) { if (op.name) pl.name = op.name; if ('description' in op) pl.description = op.description; pl.updated = Date.now(); }
      break;
    case 'playlist.add':
      if (pl) {
        const have = new Set(pl.tracks.map((t) => t.videoId));
        pl.tracks.push(...op.tracks.filter((t) => !have.has(t.videoId) && have.add(t.videoId)).map(slim));
        pl.updated = Date.now();
      }
      break;
    case 'playlist.remove':
      if (pl) pl.tracks = pl.tracks.filter((t) => t.videoId !== op.videoId);
      break;
    case 'playlist.reorder':
      if (pl) {
        const byId = new Map(pl.tracks.map((t) => [t.videoId, t]));
        const ordered = op.videoIds.map((v) => byId.get(v)).filter(Boolean);
        pl.tracks = [...ordered, ...pl.tracks.filter((t) => !op.videoIds.includes(t.videoId))];
      }
      break;
    case 'playlist.delete':
      data.playlists = data.playlists.filter((p) => p.id !== op.id);
      break;
    case 'save':
      data[SAVED[op.kind]] = [op.card, ...data[SAVED[op.kind]].filter((c) => c.id !== op.card.id)];
      break;
    case 'unsave':
      data[SAVED[op.kind]] = data[SAVED[op.kind]].filter((c) => c.id !== op.id);
      break;
    case 'play':
      data.history = [slim(op.track), ...data.history.filter((t) => t.videoId !== op.track.videoId)].slice(0, 200);
      break;
    case 'history.clear':
      data.history = [];
      break;
    case 'search':
      data.searches = [op.q, ...data.searches.filter((s) => s.toLowerCase() !== op.q.toLowerCase())].slice(0, 12);
      break;
    case 'search.remove':
      data.searches = data.searches.filter((s) => s !== op.q);
      break;
    case 'settings':
      data.settings = { ...data.settings, ...op.patch };
      break;
    case 'notices.clear':
      data.notices = [];
      break;
    case 'reset':
      Object.assign(data, { liked: [], playlists: [], albums: [], artists: [], ytPlaylists: [], history: [], searches: [], settings: {} });
      break;
    default:
  }
}

function commit(op, what) {
  op.at = op.at || Date.now();
  applyLocal(op);
  outbox.push(op);
  persist();
  emit(what);
  scheduleFlush();
}

let flushTimer = null;
function scheduleFlush(delay = 400) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => store.flush(), delay);
}

// ------------------------------------------------------------------ legacy (browser-only) library migration
function legacyOps() {
  const old = read(LEGACY_KEY, null);
  if (!old || read('openwave:migrated', false)) return [];
  const ops = [];
  const t0 = Date.now();
  (old.liked || []).slice().reverse().forEach((t, i) => ops.push({ op: 'like', track: t, at: t0 - (old.liked.length - i) * 1000 }));
  (old.playlists || []).forEach((p) => ops.push({ op: 'playlist.create', id: p.id + uid().slice(0, 4), name: p.name, tracks: p.tracks, at: p.created }));
  for (const [kind, key] of Object.entries(SAVED)) (old[key] || []).forEach((c) => ops.push({ op: 'save', kind, card: card(kind, c) }));
  (old.history || []).slice(0, 100).reverse().forEach((t, i) => ops.push({ op: 'play', track: t, seconds: 0, at: t0 - (100 - i) * 60000 }));
  (old.searches || []).slice().reverse().forEach((q) => ops.push({ op: 'search', q }));
  if (old.settings) ops.push({ op: 'settings', patch: { quality: old.settings.quality, autoplay: old.settings.autoplay } });
  return ops;
}

// ------------------------------------------------------------------ public API
export const store = {
  on: (fn) => events.addEventListener('change', (e) => fn(e.detail)),
  AuthError,

  // session & profiles
  get session() { return session; },
  get profile() { return session?.profile || null; },
  listProfiles: () => call('/api/profiles'),
  async createProfile(name, pin, color) {
    return store.adopt(await call('/api/profiles', { method: 'POST', body: { name, pin: pin || null, color } }), true);
  },
  async signIn(profileId, pin) {
    return store.adopt(await call(`/api/profiles/${profileId}/login`, { method: 'POST', body: { pin: pin || null } }), false);
  },
  async adopt({ token, profile }, fresh) {
    session = { token, profile };
    write(SESSION_KEY, session);
    data = { ...emptyLibrary(), ...read(cacheKey(profile.id), {}) };
    outbox = read(outboxKey(profile.id), []);
    const migrate = fresh ? legacyOps() : [];
    if (migrate.length) {
      migrate.forEach((op) => { op.at ||= Date.now(); applyLocal(op); outbox.push(op); });
      write('openwave:migrated', true);
    }
    emit('all');
    await store.flush();
    await store.pull();
    return { migrated: migrate.length };
  },
  async signOut() {
    try { await call('/api/me/logout', { method: 'POST' }); } catch { /* offline */ }
    session = null;
    localStorage.removeItem(SESSION_KEY);
    data = emptyLibrary();
    outbox = [];
    emit('signout');
  },
  async updateProfile(patch) {
    const profile = await call('/api/me', { method: 'PATCH', body: patch });
    session = { ...session, profile };
    write(SESSION_KEY, session);
    emit('profile');
    return profile;
  },
  async deleteProfile() {
    await call('/api/me', { method: 'DELETE' });
    localStorage.removeItem(cacheKey(session.profile.id));
    localStorage.removeItem(outboxKey(session.profile.id));
    session = null;
    localStorage.removeItem(SESSION_KEY);
    data = emptyLibrary();
    emit('signout');
  },

  // sync
  get pending() { return outbox.length; },
  async flush({ keepalive = false } = {}) {
    if (!session || !outbox.length) return;
    if (flushing) return flushing;
    const batch = outbox.slice(0, 500);
    flushing = (async () => {
      try {
        const res = await call('/api/me/ops', { method: 'POST', body: { ops: batch }, keepalive });
        outbox = outbox.slice(batch.length);
        data.version = res.version;
        persist();
      } catch (e) {
        if (e instanceof AuthError) { emit('auth'); return; }
        // The server will never accept a batch it refused (bad or forbidden ops): drop it rather than retry forever.
        const refused = e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status);
        if (refused || /malformed|unknown op|invalid/.test(e.message)) { outbox = outbox.slice(batch.length); persist(); store.pull(); }
        else setTimeout(() => scheduleFlush(0), 15000);
      } finally {
        flushing = null;
      }
      if (outbox.length) scheduleFlush(0);
    })();
    return flushing;
  },
  async pull() {
    if (!session) return;
    try {
      const snap = await call('/api/me/library');
      data = { ...emptyLibrary(), ...snap };
      outbox.forEach(applyLocal); // keep unsynced local changes visible
      session.profile = snap.profile;
      write(SESSION_KEY, session);
      persist();
      emit('all');
    } catch (e) {
      if (e instanceof AuthError) emit('auth');
    }
  },
  async checkRemote() {
    if (!session || outbox.length || !navigator.onLine) return;
    try {
      const { version } = await call('/api/me/version');
      if (version !== data.version) await store.pull();
    } catch (e) {
      if (e instanceof AuthError) emit('auth');
    }
  },
  api: call,

  // settings
  get settings() { return { ...DEFAULT_SETTINGS, ...data.settings, volume: device.volume }; },
  setting(key, value) {
    if (key === 'volume') { device.volume = value; write(DEVICE_KEY, device); return; }
    commit({ op: 'settings', patch: { [key]: value } }, 'settings');
  },

  // liked
  get liked() { return data.liked; },
  isLiked: (id) => data.liked.some((t) => t.videoId === id),
  toggleLike(track) {
    const on = !store.isLiked(track.videoId);
    commit(on ? { op: 'like', track: slim(track) } : { op: 'unlike', videoId: track.videoId }, 'liked');
    return on;
  },

  // history & plays
  get history() { return data.history; },
  recordPlay(track, seconds, { keepalive = false } = {}) {
    commit({ op: 'play', track: slim(track), seconds: Math.round(seconds) }, 'history');
    if (keepalive) store.flush({ keepalive: true });
  },
  clearHistory() { commit({ op: 'history.clear' }, 'history'); },

  // searches
  get searches() { return data.searches; },
  pushSearch(q) { q = q.trim(); if (q) commit({ op: 'search', q }, 'searches'); },
  removeSearch(q) { commit({ op: 'search.remove', q }, 'searches'); },

  // playlists
  get playlists() { return data.playlists; },
  playlist: (id) => data.playlists.find((p) => p.id === id),
  createPlaylist(name, tracks = []) {
    const id = uid();
    commit({ op: 'playlist.create', id, name: name.trim() || 'My playlist', tracks: tracks.map(slim) }, 'playlists');
    return store.playlist(id);
  },
  addToPlaylist(id, tracks) {
    const p = store.playlist(id);
    if (!p) return 0;
    const have = new Set(p.tracks.map((t) => t.videoId));
    const fresh = tracks.filter((t) => !have.has(t.videoId));
    if (fresh.length) commit({ op: 'playlist.add', id, tracks: fresh.map(slim) }, 'playlists');
    return fresh.length;
  },
  removeFromPlaylist(id, videoId) { commit({ op: 'playlist.remove', id, videoId }, 'playlists'); },
  reorderPlaylist(id, videoIds) { commit({ op: 'playlist.reorder', id, videoIds }, 'playlists'); },
  renamePlaylist(id, name) { if (name.trim()) commit({ op: 'playlist.update', id, name: name.trim() }, 'playlists'); },
  deletePlaylist(id) { commit({ op: 'playlist.delete', id }, 'playlists'); },

  // messages from the engine (e.g. a shared playlist stopped being shared)
  get notices() { return data.notices || []; },
  clearNotices() { if (data.notices?.length) commit({ op: 'notices.clear' }, 'notices'); },

  // saved albums / artists / youtube playlists
  savedList: (kind) => data[SAVED[kind]],
  isSaved: (kind, id) => store.savedList(kind).some((c) => c.id === id),
  toggleSaved(kind, c) {
    const on = !store.isSaved(kind, c.id);
    commit(on ? { op: 'save', kind, card: card(kind, c) } : { op: 'unsave', kind, id: c.id }, kind);
    return on;
  },

  // backup
  exportJSON: () => JSON.stringify({ app: 'openwave', version: 2, exported: new Date().toISOString(), profile: data.profile?.name, ...data }, null, 2),
  importJSON(text) {
    const incoming = JSON.parse(text);
    if (incoming.app !== 'openwave') throw new Error('Not an OpenWave backup file');
    const ops = [];
    (incoming.liked || []).slice().reverse().forEach((t) => ops.push({ op: 'like', track: t }));
    (incoming.playlists || []).forEach((p) => ops.push({ op: 'playlist.create', id: uid(), name: p.name, tracks: p.tracks }));
    for (const [kind, key] of Object.entries(SAVED)) (incoming[key] || []).forEach((c) => ops.push({ op: 'save', kind, card: card(kind, c) }));
    ops.forEach((op) => commit(op, 'all'));
    return ops.length;
  },
  reset() { commit({ op: 'reset' }, 'all'); },

  // device-local playback queue
  loadQueue: () => read(QUEUE_KEY, null) || read(LEGACY_QUEUE_KEY, null),
  saveQueue: (q) => write(QUEUE_KEY, q),
};

// Keep devices in step: push on reconnect, look for changes from other devices periodically.
window.addEventListener('online', () => { store.flush(); store.checkRemote(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') store.checkRemote(); });
setInterval(() => store.checkRemote(), 30000);
window.addEventListener('pagehide', () => { if (outbox.length) store.flush({ keepalive: true }); });
