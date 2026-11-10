// Android Auto (and cars that run Android). The car draws its own screens from what the phone
// app hands it, so this module answers the car's questions: what's in a tab or a folder, what a
// search finds, and what to play. The page answers rather than the Android app because the page
// already knows the library and reaches the music, whether it comes from this phone's engine or
// from the user's computer (connect.js).
//
// Every item is { id, title, subtitle, art, play, group, style, children, tile, label, tint,
// downloaded, explicit }. `id` says what it is:
//   folders   home, mixes, library, recent, album/ID, playlist/ID, artist/ID, my/ID, liked,
//             downloads, daily/N, smart/on-repeat, smart/rediscover, world (every country with a
//             chart), world/CODE (a country's chart, ZZ for the world's)
//   songs     play|FOLDER|VIDEO_ID  plays the folder from that song
//             radio|VIDEO_ID        starts a radio from that song
//             shuffle|FOLDER        plays the folder shuffled

import { get, img, sized } from './api.js';
import { store } from './store.js';
import { offline } from './offline.js';
import { player } from './player.js';
import { REMOTE } from './remote.js';

// Explore (js/explore.js) brings the world map with it: loaded only once the car wants a country.
const exploring = () => import('./explore.js');

const GRID = 'grid';
const LIST = 'list';
// The same colours as the mix cards on Home (views.js).
const TINTS = ['#2fc8ff', '#7b7bff', '#c45cff', '#ff6fae', '#ffb648', '#3ddc97'];
const SMART = {
  'on-repeat': ['onRepeat', 'On Repeat', 'Songs you can’t stop playing', '#ff6b6b'],
  rediscover: ['rediscover', 'Rediscover', 'Favourites you haven’t played lately', '#3ddc97'],
};

/** The picture's full address, so the Android app can fetch it for the car. */
export function artUrl(u, size = 600) {
  if (!u) return '';
  return REMOTE ? sized(u, size) : new URL(img(u, size), location.href).href;
}

// The car asks for Home, then a mix, then its songs, often within seconds: one fetch answers them all,
// so every screen after the first appears at once.
const recentAnswers = new Map();
function mine(path) {
  const hit = recentAnswers.get(path);
  if (hit && Date.now() - hit.at < 120e3) return hit.value;
  const value = store.api(path);
  recentAnswers.set(path, { at: Date.now(), value });
  value.catch(() => recentAnswers.delete(path));
  return value;
}

const artists = (t) => (t.artists || []).map((a) => a.name).join(', ');
const seen = new Map(); // videoId → track, for songs the car shows and may ask to play
const remember = (t) => { if (t?.videoId) seen.set(t.videoId, t); return t; };

function song(t, id, extra = {}) {
  remember(t);
  return {
    id, title: t.title, subtitle: [artists(t), t.album?.name].filter(Boolean).join(' • '), art: artUrl(t.thumbnail, 300),
    play: true, downloaded: offline.has(t.videoId), explicit: !!t.explicit, ...extra,
  };
}
const inFolder = (folder) => (t) => song(t, `play|${folder}|${t.videoId}`);
const radio = (group) => (t) => song(t, `radio|${t.videoId}`, group ? { group } : {});
const shuffleRow = (folder, tracks) => (tracks.length > 1
  ? [{ id: `shuffle|${folder}`, title: 'Shuffle play', subtitle: `${tracks.length} songs`, tile: 'shuffle', play: true }] : []);

/** A card from YouTube (album, playlist, artist) as a folder. */
function card(c, group) {
  const kind = c.type === 'local' ? 'my' : c.type;
  if (!['album', 'playlist', 'artist', 'my'].includes(kind) || !c.id) return null;
  return { id: `${kind}/${c.id}`, title: c.title, subtitle: c.subtitle || '', art: artUrl(c.thumbnail), group, style: GRID, children: LIST, round: kind === 'artist' };
}

const mixCover = (m, i, extra = {}) => ({
  art: artUrl(m.thumbnail || m.seed?.thumbnail), label: m.title, tint: TINTS[i % TINTS.length], style: GRID, ...extra,
});

async function madeForYou() {
  if (!store.history.length) return { daily: [], smart: {}, personal: null };
  const [today, smart, personal] = await Promise.all([
    mine('/api/me/daily').catch(() => null), mine('/api/me/smart').catch(() => null), mine('/api/me/mixes').catch(() => null)]);
  return { daily: today?.mixes || [], smart: smart || {}, personal };
}

function madeItems({ daily, smart, personal }, group) {
  const items = daily.map((m, i) => ({ id: `daily/${m.id}`, title: m.title, subtitle: m.subtitle, children: LIST, group, ...mixCover(m, i) }));
  for (const [slug, [key, title, sub, tint]] of Object.entries(SMART)) {
    const tracks = smart[key] || [];
    if (tracks.length >= 5) items.push({ id: `smart/${slug}`, title, subtitle: sub, children: LIST, group, art: artUrl(tracks[0].thumbnail), label: title, tint, style: GRID });
  }
  (personal?.mixes || []).forEach((m, i) => {
    remember(m.seed);
    items.push({ id: `radio|${m.seed.videoId}`, title: m.title, subtitle: m.subtitle, play: true, group, ...mixCover(m, daily.length + i) });
  });
  return items;
}

// ---------------------------------------------------------------- the four tabs
async function home() {
  const items = [];
  const name = store.profile?.name;
  const [made, sections] = await Promise.all([madeForYou(), get.home().catch(() => [])]);
  items.push(...madeItems(made, name ? `Made for ${name}` : 'Made for you'));
  items.push(...store.history.slice(0, 8).map(radio('Jump back in')));
  items.push(...await aroundTheWorld().catch(() => []));
  for (const sec of sections.slice(0, 8)) {
    const tracks = sec.items.filter((x) => x.videoId);
    const others = sec.items.filter((x) => !x.videoId);
    if (tracks.length >= others.length) items.push(...tracks.slice(0, 10).map(radio(sec.title)));
    else items.push(...others.slice(0, 10).map((c) => card(c, sec.title)).filter(Boolean));
  }
  if (!items.length && !navigator.onLine) return downloads();
  return items;
}

/** A country as a folder: its dotted shape in its colour, with its name. */
function place(ex, code, group, title = ex.nameOf(code)) {
  return { id: `world/${code}`, title, subtitle: code === ex.GLOBAL ? 'Top songs worldwide' : 'Trending now', group, style: GRID, children: LIST,
    label: ex.nameOf(code), tint: ex.hexOf(code), shape: code === ex.GLOBAL ? ex.worldShape() : ex.shapeOf(code) };
}

/** Home's Explore row: today's country, the world's top songs, and every country. */
async function aroundTheWorld() {
  const ex = await exploring();
  const w = await ex.world();
  if (!w.countries?.length) return [];
  const g = 'Around the world';
  const items = [];
  if (w.today?.code) items.push(place(ex, w.today.code, g, `Today: ${ex.nameOf(w.today.code)}`));
  items.push(place(ex, ex.GLOBAL, g));
  items.push({ id: 'world', title: 'Every country', subtitle: `${w.countries.length} charts`, group: g, style: GRID, children: GRID, shape: ex.worldShape(), label: 'Every country', tint: '#c45cff' });
  return items;
}

async function everyCountry() {
  const ex = await exploring();
  const w = await ex.world();
  return [place(ex, ex.GLOBAL, undefined), ...[...w.countries].sort((a, b) => ex.nameOf(a).localeCompare(ex.nameOf(b))).map((c) => place(ex, c))];
}

async function mixes() {
  const made = await madeForYou();
  const items = madeItems(made, 'Your mixes');
  if (!items.length) {
    return [{ id: 'radio-hint', title: 'Your mixes are on their way', subtitle: 'Listen for a while and OpenWave makes Daily Mixes for you', tile: 'mixes' }];
  }
  return items;
}

async function library() {
  const items = [];
  const g = 'Your music';
  if (store.liked.length) items.push({ id: 'liked', title: 'Liked songs', subtitle: `${store.liked.length} songs`, tile: 'liked', group: g, style: GRID, children: LIST });
  if (offline.count) items.push({ id: 'downloads', title: 'Downloads', subtitle: `${offline.count} songs`, tile: 'downloads', group: g, style: GRID, children: LIST });
  for (const p of store.playlists) {
    items.push({ id: `my/${p.id}`, title: p.name, subtitle: `${p.tracks.length} songs`, art: artUrl(p.tracks[0]?.thumbnail), tile: p.tracks[0] ? '' : 'playlist', group: g, style: GRID, children: LIST });
  }
  for (const [kind, group] of [['playlist', 'Saved playlists'], ['album', 'Albums'], ['artist', 'Artists']]) {
    items.push(...store.savedList(kind).map((c) => card({ ...c, type: kind }, group)).filter(Boolean));
  }
  if (!items.length) return [{ id: 'library-hint', title: 'Nothing saved yet', subtitle: 'Like songs and save albums on your phone to see them here', tile: 'liked' }];
  return items;
}

const recent = () => {
  const items = store.history.slice(0, 60).map(radio());
  return items.length ? items : [{ id: 'recent-hint', title: 'Nothing played yet', subtitle: 'Songs you play show up here', tile: 'recent' }];
};

// ---------------------------------------------------------------- folders
const cache = new Map(); // folder → { at, tracks, extra }

/** The songs in a folder (and, for an artist, its albums). */
async function folder(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit;
  const [kind, ...rest] = id.split('/');
  const key = rest.join('/');
  let tracks = [];
  let extra = [];
  let label = '';
  let href;
  if (kind === 'album') { const a = await get.album(key); tracks = a.tracks; label = a.title; }
  else if (kind === 'playlist') { const p = await get.playlist(key); tracks = p.tracks; label = p.title; }
  else if (kind === 'artist') {
    const a = await get.artist(key);
    tracks = a.songs;
    label = a.name;
    extra = [...a.albums.map((c) => card({ ...c, type: c.type || 'album' }, 'Albums')), ...a.singles.map((c) => card({ ...c, type: c.type || 'album' }, 'Singles & EPs'))].filter(Boolean);
  } else if (kind === 'my') { const p = store.playlist(key); tracks = p?.tracks || []; label = p?.name || ''; }
  else if (kind === 'liked') { tracks = store.liked; label = 'Liked songs'; }
  else if (kind === 'downloads') { tracks = await offline.list(); label = 'Downloads'; }
  else if (kind === 'daily') { const m = (await mine('/api/me/daily')).mixes.find((x) => x.id === key); tracks = m?.tracks || []; label = m?.title || ''; }
  else if (kind === 'smart') { const [k, title] = SMART[key] || []; tracks = k ? (await mine('/api/me/smart'))[k] || [] : []; label = title || ''; }
  else if (kind === 'world' && /^[A-Z]{2}$/.test(key)) {
    const ex = await exploring();
    tracks = (await ex.countryData(key)).tracks;
    label = key === ex.GLOBAL ? 'Top songs worldwide' : `Trending in ${ex.nameOf(key)}`;
    href = `#/explore/${key}`;   // a song played from here stamps the passport, as in the app
  } else throw new Error(`unknown folder ${id}`);
  const entry = { at: Date.now(), tracks: tracks.filter((t) => t.videoId), extra, label, href };
  // Your own lists change as you use them: always read them fresh.
  if (!['my', 'liked', 'downloads'].includes(kind)) cache.set(id, entry);
  return entry;
}

async function folderItems(id) {
  const { tracks, extra } = await folder(id);
  const group = extra.length ? 'Popular' : undefined;
  return [...shuffleRow(id, tracks), ...tracks.slice(0, 200).map((t) => ({ ...inFolder(id)(t), ...(group ? { group } : {}) })), ...extra];
}

// ---------------------------------------------------------------- search
async function search(q) {
  const data = await get.search(q, 'all');
  const results = data.results || [];
  const items = [];
  if (data.top) items.push(data.top.videoId ? radio('Top result')(data.top) : card(data.top, 'Top result'));
  items.push(...results.filter((r) => r.videoId && r.videoId !== data.top?.videoId).slice(0, 10).map(radio('Songs')));
  for (const [kind, group] of [['artist', 'Artists'], ['album', 'Albums'], ['playlist', 'Playlists']]) {
    items.push(...results.filter((r) => r.type === kind && r.id !== data.top?.id).slice(0, 8).map((c) => card(c, group)));
  }
  return items.filter(Boolean);
}

// ---------------------------------------------------------------- playing
async function track(videoId) {
  if (seen.has(videoId)) return seen.get(videoId);
  const any = [...store.history, ...store.liked].find((t) => t.videoId === videoId);
  return any || (await get.next(videoId)).tracks.find((t) => t.videoId === videoId) || null;
}

async function playFolder(id, videoId = null, shuffled = false) {
  const { tracks, label, href } = await folder(id);
  if (!tracks.length) return;
  if (shuffled && !player.shuffle) player.toggleShuffle();
  const i = videoId ? Math.max(0, tracks.findIndex((t) => t.videoId === videoId)) : shuffled ? Math.floor(Math.random() * tracks.length) : 0;
  player.playList(tracks, i, href ? { label, href } : { label });
}

/** "Hey Google, play … on OpenWave": your own lists first, then the best match on YouTube Music. */
async function playSpoken(q) {
  const words = q.trim().toLowerCase();
  if (!words) {
    if (player.current) return player.play();
    if (store.liked.length) return playFolder('liked', null, true);
    return;
  }
  if (/^(my )?(liked|favou?rite)( songs| music)?$/.test(words)) return playFolder('liked', null, true);
  if (/^(my )?downloads?$/.test(words) && offline.count) return playFolder('downloads', null, true);
  const own = store.playlists.find((p) => p.name.toLowerCase() === words);
  if (own) return playFolder(`my/${own.id}`);
  if (/daily mix/.test(words)) {
    const n = +(words.match(/\d+/)?.[0] || 1);
    const m = (await mine('/api/me/daily').catch(() => ({ mixes: [] }))).mixes[n - 1];
    if (m) return playFolder(`daily/${m.id}`);
  }
  // "Top songs in Mexico", "music from Nigeria", "what's trending in Japan", "take me somewhere".
  const where = words.match(/(?:music|songs|hits|charts?|trending|playing)\s+(?:from|in)\s+(.+)$/)?.[1]
    || words.match(/^(?:trending|top songs|top hits|hits|charts?)\s+(?:in\s+|from\s+)?(.+)$/)?.[1];
  if (where || /^(take me somewhere|surprise me|world music|around the world)$/.test(words)) {
    const ex = await exploring();
    const w = await ex.world().catch(() => null);
    const codes = w?.countries || [];
    const code = where ? (/^(the )?world(wide)?$/.test(where) ? ex.GLOBAL : ex.countryNamed(where, codes)) : codes[Math.floor(Math.random() * codes.length)];
    if (code) return playFolder(`world/${code}`);
  }
  const data = await get.search(q, 'all');
  const top = data.top || (data.results || [])[0];
  if (!top) return;
  if (top.videoId) return player.playRadio(remember(top), { label: top.title });
  if (top.type === 'artist') return playFolder(`artist/${top.id}`, null, true);
  if (['album', 'playlist'].includes(top.type)) return playFolder(`${top.type}/${top.id}`);
}

async function play(id) {
  const [what, a, b] = id.split('|');
  if (what === 'play') return playFolder(a, b);
  if (what === 'shuffle') return playFolder(a, null, true);
  if (what === 'radio') { const t = await track(a); if (t) player.playRadio(t, { label: `${t.title} radio` }); return; }
  if (what === 'voice') return playSpoken(id.slice(6));
  if (what === 'resume') return player.play();
  return playFolder(id);
}

// ---------------------------------------------------------------- the questions
const TABS = { home, mixes, library, recent };

/** Answers one question from the car; `reply` gets { items } or { error }. */
export async function answer({ op, id = '', q = '' }, reply) {
  try {
    if (!store.session) {
      reply({ error: 'profile', items: [] });
      return;
    }
    if (op === 'browse' && id.endsWith('-hint')) reply({ items: [] });
    else if (op === 'browse') reply({ items: await (TABS[id] ? TABS[id]() : id === 'world' ? everyCountry() : folderItems(id)) });
    else if (op === 'search') reply({ items: await search(q) });
    else if (op === 'play') { await play(id); reply({ items: [] }); }
    else reply({ error: `unknown ${op}`, items: [] });
  } catch (e) {
    console.warn('car', op, id, e);
    reply({ error: navigator.onLine ? (e.message || 'failed') : 'offline', items: [] });
  }
}

/** What's coming up, for the car's queue screen. */
export function queueWindow() {
  const from = Math.max(0, player.index - 2);
  return {
    title: player.context?.label || 'Up next',
    index: player.index,
    items: player.queue.slice(from, player.index + 40).map((t, n) => ({
      i: from + n, title: t.title, subtitle: artists(t), art: artUrl(t.thumbnail, 300),
    })),
  };
}
