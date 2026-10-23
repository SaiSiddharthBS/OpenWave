// Your library lives only in this browser (localStorage). No accounts, nothing leaves the device.

const KEY = 'openwave:library:v1';
const SESSION_KEY = 'openwave:session:v1';

const defaults = () => ({
  liked: [],          // tracks, newest first
  playlists: [],      // {id, name, tracks, created, updated}
  albums: [],         // saved album cards
  artists: [],        // followed artist cards
  ytPlaylists: [],    // saved YouTube playlist cards
  history: [],        // recently played tracks, newest first
  searches: [],       // recent search strings
  settings: { quality: 'normal', autoplay: true, volume: 0.8 },
});

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

let data = { ...defaults(), ...read(KEY, {}) };
data.settings = { ...defaults().settings, ...data.settings };

const events = new EventTarget();
let saveTimer = null;

function changed(what) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { console.warn('save failed', e); }
  }, 150);
  events.dispatchEvent(new CustomEvent('change', { detail: what }));
}

export const slim = (t) => ({
  type: t.type, videoId: t.videoId, title: t.title, artists: t.artists || [], album: t.album || null,
  duration: t.duration || null, thumbnail: t.thumbnail, explicit: !!t.explicit,
});

const uid = () => Math.random().toString(36).slice(2, 10);

export const store = {
  on: (fn) => events.addEventListener('change', (e) => fn(e.detail)),
  get settings() { return data.settings; },
  setting(key, value) { data.settings[key] = value; changed('settings'); },

  // liked
  get liked() { return data.liked; },
  isLiked: (id) => data.liked.some((t) => t.videoId === id),
  toggleLike(track) {
    const i = data.liked.findIndex((t) => t.videoId === track.videoId);
    if (i >= 0) data.liked.splice(i, 1); else data.liked.unshift(slim(track));
    changed('liked');
    return i < 0;
  },

  // history
  get history() { return data.history; },
  pushHistory(track) {
    data.history = [slim(track), ...data.history.filter((t) => t.videoId !== track.videoId)].slice(0, 200);
    changed('history');
  },
  clearHistory() { data.history = []; changed('history'); },

  // searches
  get searches() { return data.searches; },
  pushSearch(q) {
    q = q.trim();
    if (!q) return;
    data.searches = [q, ...data.searches.filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, 12);
    changed('searches');
  },
  removeSearch(q) { data.searches = data.searches.filter((s) => s !== q); changed('searches'); },

  // playlists
  get playlists() { return data.playlists; },
  playlist: (id) => data.playlists.find((p) => p.id === id),
  createPlaylist(name, tracks = []) {
    const p = { id: uid(), name: name.trim() || 'My playlist', tracks: tracks.map(slim), created: Date.now(), updated: Date.now() };
    data.playlists.unshift(p);
    changed('playlists');
    return p;
  },
  addToPlaylist(id, tracks) {
    const p = store.playlist(id);
    if (!p) return 0;
    const have = new Set(p.tracks.map((t) => t.videoId));
    const fresh = tracks.filter((t) => !have.has(t.videoId)).map(slim);
    p.tracks.push(...fresh);
    p.updated = Date.now();
    changed('playlists');
    return fresh.length;
  },
  removeFromPlaylist(id, index) {
    const p = store.playlist(id);
    if (!p) return;
    p.tracks.splice(index, 1);
    p.updated = Date.now();
    changed('playlists');
  },
  renamePlaylist(id, name) {
    const p = store.playlist(id);
    if (p && name.trim()) { p.name = name.trim(); changed('playlists'); }
  },
  deletePlaylist(id) { data.playlists = data.playlists.filter((p) => p.id !== id); changed('playlists'); },

  // saved albums / artists / youtube playlists
  savedList: (kind) => data[{ album: 'albums', artist: 'artists', playlist: 'ytPlaylists' }[kind]],
  isSaved: (kind, id) => store.savedList(kind).some((c) => c.id === id),
  toggleSaved(kind, card) {
    const list = store.savedList(kind);
    const i = list.findIndex((c) => c.id === card.id);
    if (i >= 0) list.splice(i, 1);
    else list.unshift({ type: kind, id: card.id, title: card.title, subtitle: card.subtitle || '', thumbnail: card.thumbnail });
    changed(kind);
    return i < 0;
  },

  // backup
  exportJSON: () => JSON.stringify({ app: 'openwave', version: 1, exported: new Date().toISOString(), ...data }, null, 2),
  importJSON(text) {
    const incoming = JSON.parse(text);
    if (incoming.app !== 'openwave') throw new Error('Not an OpenWave backup file');
    const base = defaults();
    for (const key of Object.keys(base)) {
      if (key === 'settings') data.settings = { ...base.settings, ...incoming.settings };
      else if (Array.isArray(incoming[key])) data[key] = incoming[key];
    }
    changed('all');
  },
  reset() { data = defaults(); changed('all'); },

  // playback session (queue survives reloads)
  loadSession: () => read(SESSION_KEY, null),
  saveSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* quota */ }
  },
};
