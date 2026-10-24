// Thin client for the OpenWave server API.

const memo = new Map();

export async function api(path, { ttl = 0, method = 'GET' } = {}) {
  const hit = ttl && memo.get(path);
  if (hit && hit.until > Date.now()) return hit.value;
  const res = await fetch(path, { method });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = body?.error || body?.detail || `Request failed (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : 'Request failed');
  }
  if (ttl) memo.set(path, { value: body, until: Date.now() + ttl * 1000 });
  return body;
}

export const enc = encodeURIComponent;

/** Shows the last answer straight away (if under 12 hours old) and refreshes it quietly for next
 * time, so Home appears instantly when the app opens instead of waiting on YouTube. */
function instant(path, key, ttl) {
  return async () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* storage blocked */ }
    const fresh = api(path, { ttl }).then((value) => {
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch { /* full */ }
      return value;
    });
    if (saved && Date.now() - saved.at < 12 * 3600e3) { fresh.catch(() => {}); return saved.value; }
    return fresh;
  };
}

export const get = {
  home: instant('/api/home', 'openwave:home', 600),
  search: (q, type = 'all') => api(`/api/search?q=${enc(q)}&type=${type}`, { ttl: 300 }),
  suggest: (q) => api(`/api/suggest?q=${enc(q)}`, { ttl: 600 }),
  album: (id) => api(`/api/album/${enc(id)}`, { ttl: 1800 }),
  playlist: (id) => api(`/api/playlist/${enc(id)}`, { ttl: 900 }),
  artist: (id) => api(`/api/artist/${enc(id)}`, { ttl: 1800 }),
  next: (id, playlistId) => api(`/api/next/${id}${playlistId ? `?playlistId=${enc(playlistId)}` : ''}`, { ttl: 600 }),
  lyrics: (id) => api(`/api/lyrics/${id}`, { ttl: 3600 }),
  audio: (id, title = '', artist = '') => api(`/api/audio/${id}${title ? `?title=${enc(title)}&artist=${enc(artist)}` : ''}`, { ttl: 86400 }),
  prefetch: (id, mv = false, title = '', artist = '') => fetch(`/api/prefetch/${id}${mv ? `?mv=1&title=${enc(title)}&artist=${enc(artist)}` : ''}`, { method: 'POST' }).catch(() => {}),
};

// Thumbnails are proxied so viewers never contact Google directly, and so the UI can sample colours.
export function img(url, size) {
  if (!url) return PLACEHOLDER;
  if (size && /googleusercontent\.com|ggpht\.com/.test(url)) url = url.replace(/=w\d+-h\d+/, `=w${size}-h${size}`);
  return `/api/img?u=${enc(url)}`;
}

export const PLACEHOLDER = 'data:image/svg+xml,' + enc(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#20202a"/>' +
  '<path d="M42 30v32a9 9 0 1 0 6 8.5V42h16v-12z" fill="#4a4a5a"/></svg>');
