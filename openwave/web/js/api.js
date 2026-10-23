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

export const get = {
  home: () => api('/api/home', { ttl: 600 }),
  search: (q, type = 'all') => api(`/api/search?q=${enc(q)}&type=${type}`, { ttl: 300 }),
  suggest: (q) => api(`/api/suggest?q=${enc(q)}`, { ttl: 600 }),
  album: (id) => api(`/api/album/${enc(id)}`, { ttl: 1800 }),
  playlist: (id) => api(`/api/playlist/${enc(id)}`, { ttl: 900 }),
  artist: (id) => api(`/api/artist/${enc(id)}`, { ttl: 1800 }),
  next: (id, playlistId) => api(`/api/next/${id}${playlistId ? `?playlistId=${enc(playlistId)}` : ''}`, { ttl: 600 }),
  lyrics: (id) => api(`/api/lyrics/${id}`, { ttl: 3600 }),
  audio: (id) => api(`/api/audio/${id}`, { ttl: 86400 }),
  prefetch: (id) => fetch(`/api/prefetch/${id}`, { method: 'POST' }).catch(() => {}),
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
