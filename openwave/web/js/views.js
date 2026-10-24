// Page views. Each returns {html, tint?, mount?} for the router in app.js.

import { get, img, enc } from './api.js';
import { store } from './store.js';
import { offline, fmtBytes } from './offline.js';
import { checkForUpdate, updateHint } from './update.js';
import {
  esc, icon, fmtTotal, trackList, trackCards, cards, section, registerList, trackRow, artistLinks, empty, avatar,
} from './ui.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night vibes' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ------------------------------------------------------------------ home
/** Quick tiles to your own music at the top of Home: liked songs, downloads, playlists, albums. */
function shortcuts() {
  const tiles = [];
  if (store.liked.length) tiles.push(['#/liked', `<div class="art liked-tile">${icon('heart-fill')}</div>`, 'Liked songs']);
  if (offline.count) tiles.push(['#/downloads', `<div class="art download-tile">${icon('download')}</div>`, 'Downloads']);
  store.playlists.slice(0, 6).forEach((p) => tiles.push([`#/my/${encodeURIComponent(p.id)}`,
    p.tracks[0]?.thumbnail ? `<img class="art" loading="lazy" src="${img(p.tracks[0].thumbnail, 120)}" alt="">` : `<div class="art">${icon('library')}</div>`, p.name]));
  for (const kind of ['playlist', 'album']) {
    store.savedList(kind).slice(0, 4).forEach((c) => tiles.push([`#/${kind}/${encodeURIComponent(c.id)}`, `<img class="art" loading="lazy" src="${img(c.thumbnail, 120)}" alt="">`, c.title]));
  }
  if (tiles.length < 2) return '';
  return `<div class="shortcuts">${tiles.slice(0, 8).map(([href, art, name]) => `<a class="shortcut" href="${href}">${art}<span>${esc(name)}</span></a>`).join('')}</div>`;
}

export async function home() {
  if (!navigator.onLine) {
    const saved = await offline.list();
    return {
      html: `<h1 class="greeting">${greeting()}</h1><div class="offline-banner">${icon('offline')}<div><b>You’re offline.</b> Your downloads still play.</div></div>`
        + (saved.length ? section('Downloads', trackCards(saved, { context: { label: 'Downloads', href: '#/downloads' } }))
          : empty('download', 'No downloads yet', 'Next time you’re online, tap the download button on any song, album or playlist.')),
    };
  }
  const recent = store.history.slice(0, 16);
  let sections = [];
  let failed = null;
  try { sections = await get.home(); } catch (e) { failed = e; }

  let personal = null;
  let mine = null;
  if (store.session && store.history.length) {
    // Recommendations still load if either of these fails.
    [personal, mine] = await Promise.all([store.api('/api/me/mixes').catch(() => null), store.api('/api/me/smart').catch(() => null)]);
  }
  let html = `<h1 class="greeting">${greeting()}${store.profile ? `, ${esc(store.profile.name)}` : ''}</h1>`;
  html += shortcuts();
  const made = smartCards(mine) + (personal?.mixes || []).map(mixCard).join('');
  if (made) html += section(`Made for ${store.profile.name}`, made);
  if (recent.length) html += section('Jump back in', trackCards(recent, { mode: 'radio', context: { label: 'Recently played' } }));
  if (personal?.topArtists.length >= 3) {
    html += section('Your top artists', personal.topArtists.filter((a) => a.id).map((a) => cards([{ type: 'artist', id: a.id, title: a.name, subtitle: `${a.plays} plays`, thumbnail: a.thumbnail }])).join(''));
  }
  sections.forEach((sec, n) => {
    const tracks = sec.items.filter((x) => x.videoId);
    const others = sec.items.filter((x) => !x.videoId);
    if (tracks.length >= others.length) {
      const opts = { mode: 'radio', context: { label: sec.title } };
      html += n === 0 || tracks.length > 10
        ? section(sec.title, trackListRows(tracks, opts), { cls: 'quick' })
        : section(sec.title, trackCards(tracks, opts));
    } else {
      html += section(sec.title, cards(others));
    }
  });
  if (failed && !recent.length) {
    html += empty('radio', "Couldn't load recommendations", failed.message, '<p><a class="btn" href="#/search">Search instead</a></p>');
  }
  return { html };
}

const MIX_TINTS = ['#2fc8ff', '#7b7bff', '#c45cff', '#ff6fae', '#ffb648', '#3ddc97'];
let mixN = 0;
// Playlists made only from your own listening (see /api/me/smart).
const SMART = {
  'on-repeat': ['onRepeat', 'On Repeat', 'Songs you can’t stop playing', '#ff6b6b'],
  rediscover: ['rediscover', 'Rediscover', 'Favourites you haven’t played lately', '#3ddc97'],
};

function smartCards(lists) {
  return Object.entries(SMART).filter(([, [key]]) => lists?.[key]?.length >= 5).map(([slug, [key, title, sub, tint]]) =>
    `<a class="card mix" href="#/smart/${slug}" style="--mix:${tint}"><div class="art"><img loading="lazy" src="${img(lists[key][0].thumbnail, 300)}" alt="">
      <span class="mix-label">${title}</span></div><div class="title">${title}</div><div class="sub">${sub}</div></a>`).join('');
}

export async function smart({ which }) {
  const [key, title, sub] = SMART[which];
  const tracks = (await store.api('/api/me/smart'))[key] || [];
  const context = { label: title, href: `#/smart/${which}` };
  return {
    tint: tracks[0]?.thumbnail,
    collection: { tracks, context, kind: 'smart' },
    html: collectionHeader({ kind: 'Made for you', title, cover: tracks[0]?.thumbnail, meta: `${sub} • ${plural(tracks.length, 'song')}` })
      + (tracks.length ? actions({ play: 'play-collection', tracks }) + trackList(tracks, { album: true, context })
        : empty('repeat', 'Nothing here yet', 'Keep listening. This fills up with the songs you play most.')),
  };
}

function mixCard(m) {
  const key = registerList([m.seed], { mode: 'radio', context: { label: m.title } });
  const tint = MIX_TINTS[mixN++ % MIX_TINTS.length];
  return `<div class="card mix" data-list="${key}" data-i="0" data-vid="${esc(m.seed.videoId)}" role="button" tabindex="0" style="--mix:${tint}">
    <div class="art"><img loading="lazy" src="${img(m.seed.thumbnail, 300)}" alt=""><span class="mix-label">${esc(m.title)}</span>
      <span class="hover-play">${icon('play')}</span></div>
    <div class="title">${esc(m.title)}</div><div class="sub">${esc(m.subtitle)}</div></div>`;
}

function trackListRows(tracks, opts) {
  const key = registerList(tracks, opts);
  return tracks.map((t, i) => trackRow(t, i, key)).join('');
}

// ------------------------------------------------------------------ search
const TYPES = [['all', 'All'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists']];

const GENRES = [
  ['Pop', '#e13300'], ['Hip-Hop', '#bc5900'], ['Bollywood', '#d84000'], ['Lo-fi beats', '#477d95'],
  ['Workout', '#777777'], ['Chill', '#8d67ab'], ['Rock', '#e91429'], ['Indie', '#608108'],
  ['K-Pop', '#e8115b'], ['Jazz', '#1e3264'], ['Classical', '#7d4b32'], ['EDM', '#0d73ec'],
  ['Romance', '#dc148c'], ['Party', '#af2896'], ['Focus', '#503750'], ['Sleep', '#1e3264'],
];

export async function search({ q = '', type = 'all' }) {
  if (!q) {
    const recent = store.searches;
    return {
      html: `${recent.length ? `<div class="section-head"><h2>Recent searches</h2></div>
        <div class="recent">${recent.map((s) => `<span class="chip"><a href="#/search?q=${enc(s)}">${esc(s)}</a>
          <button class="icon-btn sm" data-forget-search="${esc(s)}" aria-label="Remove">${icon('close')}</button></span>`).join('')}</div>` : ''}
        <div class="section-head"><h2>Browse all</h2></div>
        <div class="browse">${GENRES.map(([g, c]) => `<a class="genre" style="background:${c}" href="#/search?q=${enc(g + ' playlists')}&type=playlists">${esc(g)}</a>`).join('')}</div>`,
    };
  }

  const data = await get.search(q, type);
  if (data.redirect) { location.replace(data.redirect); return { html: '' }; }
  const first = data.top?.videoId ? data.top : (data.results || []).find((r) => r.videoId);
  if (first) get.prefetch(first.videoId, first.type === 'video', first.title, first.artists?.[0]?.name || ''); // the top hit is the most likely click

  const chips = `<div class="chips">${TYPES.map(([k, label]) =>
    `<a class="chip ${k === type ? 'on' : ''}" href="#/search?q=${enc(q)}&type=${k}">${label}</a>`).join('')}</div>`;
  const results = data.results || [];
  if (!results.length && !data.top) {
    return { html: chips + empty('search', `No results for “${q}”`, 'Check the spelling, or try fewer words.') };
  }

  if (type !== 'all') {
    const tracks = results.filter((r) => r.videoId);
    const opts = { mode: 'radio', context: { label: `Search: ${q}` } };
    if (tracks.length) return { html: chips + trackList(tracks, { ...opts, album: type === 'songs' }) };
    return { html: chips + `<div class="grid">${cards(results)}</div>` };
  }

  const songs = results.filter((r) => r.type === 'song');
  const by = (k) => results.filter((r) => r.type === k);
  const ctx = { mode: 'radio', context: { label: `Search: ${q}` } };
  let html = chips;
  if (data.top) {
    html += `<div class="top-grid"><section><div class="section-head"><h2>Top result</h2></div>${topCard(data.top)}</section>
      ${songs.length ? `<section><div class="section-head"><h2>Songs</h2><a href="#/search?q=${enc(q)}&type=songs">Show all</a></div>
      ${trackList(songs.slice(0, 4), ctx)}</section>` : ''}</div>`;
  } else if (songs.length) {
    html += section('Songs', trackList(songs.slice(0, 6), ctx), { cls: '', more: `<a href="#/search?q=${enc(q)}&type=songs">Show all</a>` });
  }
  if (by('artist').length) html += section('Artists', cards(by('artist')), { more: `<a href="#/search?q=${enc(q)}&type=artists">Show all</a>` });
  if (by('album').length) html += section('Albums', cards(by('album')), { more: `<a href="#/search?q=${enc(q)}&type=albums">Show all</a>` });
  if (by('playlist').length) html += section('Playlists', cards(by('playlist')), { more: `<a href="#/search?q=${enc(q)}&type=playlists">Show all</a>` });
  return { html };
}

function topCard(item) {
  if (item.videoId) {
    const key = registerList([item], { mode: 'radio', context: { label: item.title } });
    return `<div class="top-card ${item.type}" data-list="${key}" data-i="0" data-vid="${esc(item.videoId)}" role="button" tabindex="0">
      <img src="${img(item.thumbnail, 300)}" alt="">
      <h3>${esc(item.title)}</h3>
      <div class="muted">${artistLinks(item.artists)}<span class="pill">Song</span></div>
      <span class="hover-play">${icon('play')}</span></div>`;
  }
  const href = `#/${item.type}/${enc(item.id)}`;
  return `<a class="top-card ${item.type}" href="${href}">
    <img src="${img(item.thumbnail, 300)}" alt="">
    <h3>${esc(item.title)}</h3>
    <div class="muted">${esc(item.subtitle || '')}<span class="pill">${item.type[0].toUpperCase() + item.type.slice(1)}</span></div>
    ${item.type !== 'artist' ? `<button class="hover-play" data-play-card="${item.type}:${esc(item.id)}" aria-label="Play">${icon('play')}</button>` : ''}</a>`;
}

// ------------------------------------------------------------------ collections
function collectionHeader({ kind, title, cover, meta, desc = '', mosaic = null, tile = null }) {
  const art = tile || (mosaic ? `<div class="mosaic">${mosaic.map((u) => `<img src="${img(u, 240)}" alt="">`).join('')}</div>`
    : `<img class="cover" src="${img(cover, 544)}" alt="">`);
  return `<div class="hero">${art}<div class="info"><div class="kind">${esc(kind)}</div><h1>${esc(title)}</h1>
    ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}<div class="meta">${meta}</div></div></div>`;
}

function downloadButton(tracks) {
  if (!tracks?.length) return '';
  const all = tracks.every((t) => offline.has(t.videoId));
  return `<button class="icon-btn lg dl-btn ${all ? 'on' : ''}" data-act="download-collection" title="${all ? 'Downloaded' : 'Download'}" aria-label="${all ? 'Remove downloads' : 'Download'}">${icon(all ? 'downloaded' : 'download')}</button>`;
}

function actions({ play, shuffle = true, save = null, edit = false, del = false, more = true, tracks = null }) {
  return `<div class="actions">
    <button class="big-play" data-act="${play}" aria-label="Play">${icon('play')}</button>
    ${shuffle ? `<button class="icon-btn lg" data-act="${play}-shuffle" title="Shuffle play" aria-label="Shuffle play">${icon('shuffle')}</button>` : ''}
    ${downloadButton(tracks)}
    ${save ? `<button class="icon-btn lg like-btn ${save.on ? 'on' : ''}" data-act="save-collection" title="${save.on ? 'Remove from library' : 'Save to library'}" aria-label="Save">${icon(save.on ? 'heart-fill' : 'heart')}</button>` : ''}
    ${edit ? `<button class="icon-btn lg" data-act="rename-playlist" title="Rename" aria-label="Rename">${icon('edit')}</button>` : ''}
    ${del ? `<button class="icon-btn lg" data-act="delete-playlist" title="Delete" aria-label="Delete playlist">${icon('trash')}</button>` : ''}
    ${more ? `<button class="icon-btn lg" data-act="collection-menu" aria-label="More">${icon('more')}</button>` : ''}
  </div>`;
}

const listHead = '<div class="list-head"><span>#</span><span>Title</span><span>⏱</span><span></span></div>';

export async function album({ id }) {
  const a = await get.album(id);
  const context = { label: a.title, href: `#/album/${id}` };
  const card = { id, title: a.title, subtitle: `Album • ${a.artists.map((x) => x.name).join(', ')}`, thumbnail: a.thumbnail };
  const meta = [artistLinks(a.artists), a.year, plural(a.tracks.length, 'song'), a.duration || fmtTotal(a.tracks)].filter(Boolean).join(' • ');
  return {
    tint: a.thumbnail,
    collection: { tracks: a.tracks, context, kind: 'album', card },
    html: collectionHeader({ kind: a.kind || 'Album', title: a.title, cover: a.thumbnail, meta })
      + actions({ play: 'play-collection', save: { on: store.isSaved('album', id) }, tracks: a.tracks })
      + listHead + trackList(a.tracks, { numbered: true, context })
      + (a.description ? `<section class="section"><div class="section-head"><h2>About</h2></div><p class="about">${esc(a.description)}</p></section>` : ''),
  };
}

export async function playlist({ id }) {
  const p = await get.playlist(id);
  const context = { label: p.title, href: `#/playlist/${id}` };
  const card = { id, title: p.title, subtitle: p.author || 'Playlist', thumbnail: p.thumbnail };
  const meta = [p.author && `<b>${esc(p.author)}</b>`, plural(p.tracks.length, 'song'), p.duration || fmtTotal(p.tracks)].filter(Boolean).join(' • ');
  return {
    tint: p.thumbnail,
    collection: { tracks: p.tracks, context, kind: 'playlist', card },
    html: collectionHeader({ kind: 'Playlist', title: p.title, cover: p.thumbnail, meta, desc: p.description })
      + actions({ play: 'play-collection', save: { on: store.isSaved('playlist', id) }, tracks: p.tracks })
      + (p.tracks.length ? trackList(p.tracks, { album: true, context }) : empty('queue', 'This playlist is empty', '')),
  };
}

export async function artist({ id }) {
  const a = await get.artist(id);
  const context = { label: a.name, href: `#/artist/${id}` };
  const followed = store.isSaved('artist', id);
  const card = { id, title: a.name, subtitle: 'Artist', thumbnail: a.thumbnail };
  const stats = [a.monthlyListeners && `${a.monthlyListeners} monthly audience`, a.subscribers && `${a.subscribers} subscribers`].filter(Boolean).join(' • ');
  let html = `<div class="hero artist" style="background-image:url('${img(a.thumbnail, 1200)}')"><div class="info">
      <div class="kind">Artist</div><h1>${esc(a.name)}</h1><div class="meta">${esc(stats)}</div></div></div>
    <div class="actions">
      <button class="big-play" data-act="play-collection" aria-label="Play">${icon('play')}</button>
      <button class="icon-btn lg" data-act="play-collection-shuffle" title="Shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
      <button class="btn" data-act="artist-radio">${icon('radio')} Radio</button>
      <button class="btn" data-act="save-collection">${followed ? 'Following' : 'Follow'}</button>
    </div>`;
  if (a.songs.length) {
    html += section('Popular', trackList(a.songs, { album: true, context }), {
      cls: '', more: a.songsPlaylistId ? `<a href="#/playlist/${enc(a.songsPlaylistId)}">Show all</a>` : '',
    });
  }
  if (a.albums.length) html += section('Albums', cards(a.albums));
  if (a.singles.length) html += section('Singles & EPs', cards(a.singles));
  if (a.related.length) html += section('Fans also like', cards(a.related));
  if (a.description) html += `<section class="section"><div class="section-head"><h2>About</h2></div><p class="about">${esc(a.description)}</p></section>`;
  return {
    tint: a.thumbnail,
    collection: { tracks: a.songs, context, kind: 'artist', card, radioId: a.radioId },
    html,
  };
}

// ------------------------------------------------------------------ local library
export function liked() {
  const tracks = store.liked;
  const context = { label: 'Liked songs', href: '#/liked' };
  return {
    tintColor: '91, 61, 245',
    collection: { tracks, context, kind: 'liked' },
    html: collectionHeader({ kind: 'Playlist', title: 'Liked songs', tile: `<div class="cover liked-tile">${icon('heart-fill')}</div>`, meta: `${plural(tracks.length, 'song')}${tracks.length ? ' • ' + fmtTotal(tracks) : ''}` })
      + (tracks.length ? actions({ play: 'play-collection', tracks }) + trackList(tracks, { album: true, context })
        : empty('heart', 'Songs you like will appear here', 'Tap the heart on any song to save it.')),
  };
}

export async function downloads() {
  const tracks = await offline.list();
  const size = tracks.reduce((n, t) => n + (t.size || 0), 0);
  const context = { label: 'Downloads', href: '#/downloads' };
  const busy = offline.queued;
  return {
    tintColor: '27, 79, 214',
    collection: { tracks, context, kind: 'downloads' },
    html: collectionHeader({ kind: 'On this device', title: 'Downloads', tile: `<div class="cover download-tile">${icon('download')}</div>`,
      meta: `${plural(tracks.length, 'song')}${tracks.length ? ` • ${fmtTotal(tracks)} • ${fmtBytes(size)}` : ''}` })
      + `<div class="dl-progress" id="dl-progress" ${busy ? '' : 'hidden'}>${icon('download')}<span id="dl-progress-text">Downloading ${plural(busy, 'song')}…</span></div>`
      + (tracks.length ? actions({ play: 'play-collection', more: false }) + trackList(tracks, { album: true, context })
        : empty('download', 'Nothing downloaded yet', 'Downloaded songs play without an internet connection. Use the download button on any song, album or playlist.')),
  };
}

export function history() {
  const tracks = store.history;
  const context = { label: 'Recently played', href: '#/history' };
  return {
    tintColor: '18, 101, 107',
    collection: { tracks, context, kind: 'history' },
    html: collectionHeader({ kind: 'History', title: 'Recently played', tile: `<div class="cover history-tile">${icon('repeat')}</div>`, meta: plural(tracks.length, 'song') })
      + (tracks.length ? actions({ play: 'play-collection', more: false }) + `<button class="btn" data-act="clear-history" style="margin-bottom:12px">Clear history</button>` + trackList(tracks, { album: true, context })
        : empty('repeat', 'Nothing played yet', 'Songs you play show up here.')),
  };
}

export function myPlaylist({ id }) {
  const p = store.playlist(id);
  if (!p) return { html: empty('library', 'Playlist not found', 'It may have been deleted.') };
  const context = { label: p.name, href: `#/my/${id}` };
  const covers = [...new Set(p.tracks.map((t) => t.thumbnail))].slice(0, 4);
  const art = covers.length >= 4 ? { mosaic: covers } : covers.length ? { cover: covers[0] } : { tile: `<div class="cover liked-tile" style="background:var(--surface-3)">${icon('queue')}</div>` };
  return {
    tint: covers[0],
    collection: { tracks: p.tracks, context, kind: 'local', localId: id },
    html: collectionHeader({ kind: 'Your playlist', title: p.name, meta: `${plural(p.tracks.length, 'song')}${p.tracks.length ? ' • ' + fmtTotal(p.tracks) : ''}`, ...art })
      + actions({ play: 'play-collection', edit: true, del: true, more: !!p.tracks.length, tracks: p.tracks })
      + (p.tracks.length ? trackList(p.tracks, { album: true, context, localId: id })
        : empty('search', "Let's find something for your playlist", 'Use “Add to playlist” from any song’s menu.', '<p><a class="btn" href="#/search">Search</a></p>')),
  };
}

export function library({ tab = 'playlists' }) {
  const tabs = [['playlists', 'Playlists'], ['albums', 'Albums'], ['artists', 'Artists']];
  let body = '';
  if (tab === 'playlists') {
    const tiles = [
      `<a class="card" href="#/liked"><div class="art liked-tile">${icon('heart-fill')}</div><div class="title">Liked songs</div><div class="sub">${plural(store.liked.length, 'song')}</div></a>`,
      `<a class="card" href="#/downloads"><div class="art download-tile">${icon('download')}</div><div class="title">Downloads</div><div class="sub">${plural(offline.count, 'song')} on this device</div></a>`,
      `<a class="card" href="#/history"><div class="art history-tile">${icon('repeat')}</div><div class="title">Recently played</div><div class="sub">${plural(store.history.length, 'song')}</div></a>`,
      ...store.playlists.map((p) => cards([{ type: 'local', id: p.id, title: p.name, subtitle: `Your playlist • ${plural(p.tracks.length, 'song')}`, thumbnail: p.tracks[0]?.thumbnail }])),
      cards(store.savedList('playlist')),
    ];
    body = `<div class="grid">${tiles.join('')}</div>`;
  } else {
    const saved = store.savedList(tab === 'albums' ? 'album' : 'artist');
    body = saved.length ? `<div class="grid">${cards(saved)}</div>`
      : empty(tab === 'albums' ? 'album' : 'person', tab === 'albums' ? 'No saved albums yet' : 'You’re not following anyone yet',
        tab === 'albums' ? 'Tap the heart on an album to save it.' : 'Tap Follow on an artist page.');
  }
  return {
    html: `<div class="lib-head"><h1>Your Library</h1><div class="lib-actions"><button class="btn" data-act="import-playlists">${icon('download')} Import</button><button class="btn" data-act="new-playlist">${icon('plus')} New playlist</button></div></div>
      <div class="chips">${tabs.map(([k, l]) => `<a class="chip ${k === tab ? 'on' : ''}" href="#/library?tab=${k}">${l}</a>`).join('')}</div>${body}`,
  };
}

// ------------------------------------------------------------------ settings
function androidServerSetting() {
  const current = window.OpenWaveAndroid.getServer();
  return `<h2>Library</h2>
    <div class="setting"><div><b>Where your library lives</b><p>${current
      ? `Using OpenWave on your computer at <b>${esc(current)}</b>, so you get the same profiles and playlists everywhere.`
      : 'On this phone. To share one library with your computer, open OpenWave on the computer, turn on Settings → Phone, and enter its address here.'}</p></div>
      <div class="btn-row">${current ? '<button class="btn" data-act="android-use-phone">Use this phone</button>' : ''}<button class="btn" data-act="android-set-server">${current ? 'Change' : 'Connect to computer'}</button></div></div>`;
}

function updateLine(u) {
  if (!u?.latest) return '';
  if (u.available) return `<div class="setting"><div><b>OpenWave ${esc(u.latest)} is available</b><p>${esc(updateHint(u))}</p></div><button class="btn primary" data-act="app-update">Update</button></div>`;
  if (u.newer) return `<p>OpenWave ${esc(u.latest)} is out. <a href="${esc(u.page)}" target="_blank" rel="noopener">See what’s new</a> (Docker: <code>docker compose pull &amp;&amp; docker compose up -d</code>).</p>`;
  return '<p>You have the latest version.</p>';
}

const PROFILE_COLORS = ['#7b7bff', '#2fc8ff', '#c45cff', '#ff6fae', '#ffb648', '#3ddc97', '#ff6b6b', '#8f7cff'];

export async function settings() {
  const s = store.settings;
  const p = store.profile;
  let health = null;
  try { health = await (await fetch('/api/health')).json(); } catch { /* offline */ }
  const update = await checkForUpdate(3000);
  const sw = (key) => `<button class="switch ${s[key] ? 'on' : ''}" data-setting-toggle="${key}" role="switch" aria-checked="${!!s[key]}" aria-label="${key}"></button>`;
  const select = (key, options, type = '') => `<select class="select" data-setting="${key}" ${type ? `data-type="${type}"` : ''}>
    ${options.map(([v, l]) => `<option value="${v}" ${String(s[key]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return {
    html: `<div class="settings"><h1>Settings</h1>
      ${p ? `<h2>Profile</h2>
      <div class="setting profile-setting"><div class="profile-row">${avatar(p, 56)}<div><b>${esc(p.name)}</b><p>Your likes, playlists, history and insights sync to every device using this server.</p></div></div>
        <div class="btn-row"><button class="btn" data-act="edit-profile">${icon('edit')} Rename</button><button class="btn" data-act="switch-profile">Switch profile</button></div></div>
      <div class="setting"><div><b>Colour</b></div><div class="swatches">${PROFILE_COLORS.map((c) => `<button class="swatch ${c === p.color ? 'on' : ''}" data-act="profile-color" data-color="${c}" style="background:${c}" aria-label="Colour"></button>`).join('')}</div></div>
      <div class="setting"><div><b>PIN</b><p>${p.hasPin ? 'This profile is protected with a PIN.' : 'Stop others on your server from opening your profile.'}</p></div>
        ${p.hasPin ? '<div class="btn-row"><button class="btn" data-act="set-pin">Change PIN</button><button class="btn" data-act="remove-pin">Remove</button></div>' : '<button class="btn" data-act="set-pin">Set a PIN</button>'}</div>` : ''}
      <h2>Playback</h2>
      <div class="setting"><div><b>Audio quality</b><p>OpenWave picks the best format your device plays (Opus or AAC, up to ~160 kbps). Data saver uses about a third of the data.</p></div>
        ${select('quality', [['high', 'High'], ['normal', 'Normal'], ['low', 'Data saver']])}</div>
      <div class="setting"><div><b>Crossfade</b><p>Blend the end of one song into the start of the next.</p></div>
        ${select('crossfade', [[0, 'Off'], [2, '2 seconds'], [4, '4 seconds'], [6, '6 seconds'], [8, '8 seconds'], [10, '10 seconds'], [12, '12 seconds']], 'number')}</div>
      <div class="setting"><div><b>Gapless playback</b><p>The next song is buffered ahead of time, so albums play without silence between tracks.</p></div>${sw('gapless')}</div>
      <div class="setting"><div><b>Autoplay</b><p>When your queue ends, keep playing similar songs, skipping ones you heard recently.</p></div>${sw('autoplay')}</div>
      ${document.documentElement.classList.contains('native-mac-app') ? `<div class="setting"><div><b>Song notifications</b><p>Show a notification when the song changes while OpenWave is in the background.</p></div>${sw('notifications')}</div>` : ''}
      ${window.OpenWaveAndroid ? androidServerSetting() : ''}
      ${window.OpenWaveAndroid?.addWidget ? '<div class="setting"><div><b>Home-screen widget</b><p>See what’s playing and skip songs right from your home screen.</p></div><button class="btn" data-act="android-add-widget">Add widget</button></div>' : ''}
      <h2>Downloads</h2>
      <div class="setting"><div><b>Saved on this device</b><p id="dl-usage">${plural(offline.count, 'song')} • ${fmtBytes(await offline.usage().catch(() => 0))}. Downloads use the audio quality above.</p></div>
        <button class="btn danger" data-act="clear-downloads" ${offline.count ? '' : 'disabled'}>Delete all</button></div>
      <h2>Your data</h2>
      <div class="setting"><div><b>Import playlists</b><p>From Spotify links, Exportify CSV files, YouTube playlists or plain song lists.</p></div><button class="btn" data-act="import-playlists">${icon('download')} Import</button></div>
      <div class="setting"><div><b>Back up library</b><p>Download your library as a file, or restore one.</p></div>
        <div class="btn-row"><button class="btn" data-act="export">Export</button><button class="btn" data-act="import">Restore</button></div></div>
      ${p ? `<div class="setting"><div><b>Clear library</b><p>Remove likes, playlists, follows and history from this profile.</p></div><button class="btn danger" data-act="reset">Clear</button></div>
      <div class="setting"><div><b>Delete profile</b><p>Permanently delete “${esc(p.name)}” from this server.</p></div><button class="btn danger" data-act="delete-profile">Delete</button></div>` : ''}
      <h2>About</h2>
      <div class="prose">
        <p><b>OpenWave ${esc(health?.version || '')}</b> — free and open-source software under the GNU GPL v3. No ads, no subscriptions, no tracking, no premium tier. Ever.</p>
        ${updateLine(update)}
        <p>Catalog and streams come from YouTube's public endpoints via <a href="https://github.com/sigma67/ytmusicapi" target="_blank" rel="noopener">ytmusicapi</a> and <a href="https://github.com/yt-dlp/yt-dlp" target="_blank" rel="noopener">yt-dlp</a>. OpenWave is not affiliated with or endorsed by YouTube or Google.</p>
        <p>Server: ${health ? `online • yt-dlp ${esc(health.ytDlp)} • JS runtime: ${esc(health.jsRuntimes.join(', ') || 'none found (install Deno or Node)')}${Object.keys(health.extractorUpdates || {}).length ? ' • update downloaded, restart OpenWave to apply' : ''}` : 'unreachable'}</p>
        <p>Keyboard: <b>Space</b> play/pause • <b>←/→</b> seek • <b>Shift+←/→</b> previous/next • <b>L</b> like • <b>M</b> mute • <b>S</b> shuffle • <b>R</b> repeat • <b>/</b> search</p>
        <p><a href="https://github.com/SaiSiddharthBS/OpenWave" target="_blank" rel="noopener">Source code on GitHub</a> · <a href="https://github.com/SaiSiddharthBS/OpenWave/issues" target="_blank" rel="noopener">Report a problem</a></p>
      </div></div>`,
  };
}
