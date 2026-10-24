// App shell: routing, event delegation, player UI bindings, now-playing panel.

import { api, get, img, enc } from './api.js';
import { store } from './store.js';
import { player } from './player.js';
import { offline } from './offline.js';
import * as views from './views.js';
import { insights, shareInsights } from './insights.js';
import { openImport } from './importer.js';
import { ensureProfile, switchProfile } from './profiles.js';
import { initNative, shareFile } from './native.js';
import { initUpdates, checkForUpdate, startUpdate } from './update.js';
import {
  $, $$, esc, icon, fmtTime, getList, registerList, trackRow, toast, openMenu, closeMenu, askText,
  confirmDialog, sampleTint, artistLinks, errorBox, skeleton, empty, avatar,
} from './ui.js';

const view = $('#view');
const main = $('#main');
const np = $('#np');
const searchInput = $('#search-input');

// ================================================================== router
const id = (m) => decodeURIComponent(m[1]);
const ROUTES = [
  [/^\/?(home)?$/, 'home', () => views.home(), 'home'],
  [/^\/search$/, 'search', (m, q) => views.search({ q: q.get('q') || '', type: q.get('type') || 'all' }), 'home'],
  [/^\/album\/(.+)$/, 'album', (m) => views.album({ id: id(m) }), 'detail'],
  [/^\/playlist\/(.+)$/, 'playlist', (m) => views.playlist({ id: id(m) }), 'detail'],
  [/^\/artist\/(.+)$/, 'artist', (m) => views.artist({ id: id(m) }), 'detail'],
  [/^\/library$/, 'library', (m, q) => views.library({ tab: q.get('tab') || 'playlists' }), 'home'],
  [/^\/liked$/, 'library', () => views.liked(), 'detail'],
  [/^\/history$/, 'library', () => views.history(), 'detail'],
  [/^\/downloads$/, 'downloads', () => views.downloads(), 'detail'],
  [/^\/my\/(.+)$/, 'library', (m) => views.myPlaylist({ id: id(m) }), 'detail'],
  [/^\/settings$/, 'settings', () => views.settings(), 'home'],
  [/^\/insights$/, 'insights', (m, q) => insights({ days: q.get('days') || 30 }), 'home'],
  [/^\/play\/([A-Za-z0-9_-]{11})$/, 'home', (m) => playLink(m[1]), 'home'],
];

let page = {};
let renderToken = 0;

/** Shared song links (#/play/<videoId>): start that song's radio, then show Home. */
async function playLink(videoId) {
  try {
    const track = await api(`/api/track/${videoId}`);
    player.playRadio(track);
  } catch (e) {
    toast(`Couldn’t open that song — ${e.message}`);
  }
  setTimeout(() => location.replace('#/home'));
  return { html: '' };
}

async function render({ keepScroll = false } = {}) {
  const [path, qs] = (location.hash.slice(1) || '/home').split('?');
  const params = new URLSearchParams(qs || '');
  let match = null;
  const route = ROUTES.find((r) => (match = path.match(r[0])));
  if (!route) { location.replace('#/home'); return; }
  const token = ++renderToken;
  const [, name, load, sk] = route;

  document.body.classList.forEach((c) => c.startsWith('route-') && document.body.classList.remove(c));
  document.body.classList.add(`route-${name}`);
  $$('[data-route]').forEach((a) => a.classList.toggle('on', a.dataset.route === name));
  $$('.side-item').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === location.hash));
  closeMenu();
  hideSuggest();
  if (name === 'search' && document.activeElement !== searchInput) searchInput.value = params.get('q') || '';

  const scroll = main.scrollTop;
  const slow = setTimeout(() => { if (token === renderToken) { view.innerHTML = skeleton(sk); main.scrollTop = 0; } }, 150);
  try {
    const out = await load(match, params);
    if (token !== renderToken) return;
    clearTimeout(slow);
    page = { ...out, name };
    view.innerHTML = out.html;
    main.scrollTop = keepScroll ? scroll : 0;
    out.mount?.(view);
    markDownloads();
    enableDrag();
    view.style.removeProperty('--tint');
    if (out.tintColor) view.style.setProperty('--tint', out.tintColor);
    else if (out.tint) sampleTint(img(out.tint, 120)).then((c) => c && token === renderToken && view.style.setProperty('--tint', c));
    markPlaying();
  } catch (e) {
    if (token !== renderToken) return;
    clearTimeout(slow);
    console.error(e);
    view.innerHTML = errorBox(e);
  }
}

window.addEventListener('hashchange', () => { closeNP(); render(); });

// Library-backed pages refresh themselves when the library changes (here or on another device).
store.on(async (what) => {
  if (what === 'auth' || what === 'signout') {
    await ensureProfile(what === 'auth' ? 'Your session ended. Pick your profile to continue.' : '');
    renderProfileChip();
    render();
    return;
  }
  renderSidebar();
  renderProfileChip();
  bindLike();
  if (dragging) return;
  const live = { library: true, settings: what === 'settings' || what === 'all' || what === 'profile', home: what === 'all' };
  if (what === 'history' && !location.hash.startsWith('#/history')) return;
  if (live[page.name] || (page.collection && ['liked', 'local', 'history'].includes(page.collection.kind) && what !== 'history')
    || (what === 'all' && page.collection?.kind === 'history')) render({ keepScroll: true });
});

function renderProfileChip() {
  const chip = $('#profile-chip');
  if (chip) chip.innerHTML = store.profile ? avatar(store.profile, 30) : icon('person');
}

function profileMenu(anchor) {
  const p = store.profile;
  openMenu(anchor, [
    { icon: 'chart', label: 'Your insights', run: () => { location.hash = '#/insights'; } },
    { icon: 'download', label: 'Import playlists…', run: () => openImport() },
    { icon: 'settings', label: 'Settings', run: () => { location.hash = '#/settings'; } },
    'sep',
    { icon: 'person', label: 'Switch profile', run: async () => { await switchProfile(); renderProfileChip(); render(); } },
  ], p ? `<div class="menu-head">${avatar(p, 40)}<div class="ellipsis"><b class="ellipsis">${esc(p.name)}</b><small>${store.pending ? 'Syncing…' : 'Synced'}</small></div></div>` : '');
}

// ================================================================== sidebar
function renderSidebar() {
  const item = (href, art, title, sub) => `<a class="side-item" href="${href}">${art}<div class="ellipsis"><b class="ellipsis">${esc(title)}</b><small>${esc(sub)}</small></div></a>`;
  const pic = (url, round) => `<img class="${round ? 'round' : ''}" loading="lazy" src="${img(url, 120)}" alt="">`;
  const html = [
    item('#/liked', `<span class="tile liked-tile">${icon('heart-fill')}</span>`, 'Liked songs', `Playlist • ${store.liked.length} songs`),
    ...store.playlists.map((p) => item(`#/my/${p.id}`, p.tracks[0] ? pic(p.tracks[0].thumbnail) : `<span class="tile liked-tile" style="background:var(--surface-3)">${icon('queue')}</span>`, p.name, `Playlist • ${p.tracks.length} songs`)),
    ...store.savedList('playlist').map((c) => item(`#/playlist/${enc(c.id)}`, pic(c.thumbnail), c.title, 'Playlist')),
    ...store.savedList('album').map((c) => item(`#/album/${enc(c.id)}`, pic(c.thumbnail), c.title, c.subtitle || 'Album')),
    ...store.savedList('artist').map((c) => item(`#/artist/${enc(c.id)}`, pic(c.thumbnail, true), c.title, 'Artist')),
  ].join('');
  $('#side-list').innerHTML = html;
  $$('.side-item').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === location.hash));
}

// ================================================================== search box
let suggestTimer;
let liveTimer;
let suggestIndex = -1;

let suggestSeq = 0;
function hideSuggest() { $('#suggest').hidden = true; suggestIndex = -1; suggestSeq++; }

function submitSearch(q) {
  q = q.trim();
  if (!q) return;
  clearTimeout(suggestTimer);
  hideSuggest();
  store.pushSearch(q);
  const target = `#/search?q=${enc(q)}`;
  if (location.hash === target) render(); else location.hash = target;
  if (matchMedia('(max-width: 860px)').matches) searchInput.blur();
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  clearTimeout(suggestTimer);
  clearTimeout(liveTimer);
  if (!q) { hideSuggest(); return; }
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(async () => {
    try {
      const list = await get.suggest(q);
      if (seq !== suggestSeq || searchInput.value.trim() !== q || document.activeElement !== searchInput) return;
      const box = $('#suggest');
      box.innerHTML = list.map((s) => `<button type="button" data-suggest="${esc(s)}">${icon('search')}<span>${esc(s)}</span></button>`).join('');
      box.hidden = !list.length;
      suggestIndex = -1;
    } catch { /* suggestions are optional */ }
  }, 160);
  // Live results while typing on the search page.
  if (document.body.classList.contains('route-search') && q.length > 1 && !/^https?:/.test(q)) {
    liveTimer = setTimeout(() => location.replace(`#/search?q=${enc(q)}`), 650);
  }
});

searchInput.addEventListener('keydown', (e) => {
  const items = $$('#suggest button');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if ($('#suggest').hidden || !items.length) return;
    e.preventDefault();
    suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('on', i === suggestIndex));
    searchInput.value = items[suggestIndex].dataset.suggest;
  } else if (e.key === 'Escape') {
    hideSuggest();
  }
});

searchInput.addEventListener('focus', () => { if (!document.body.classList.contains('route-search')) location.hash = '#/search'; });
searchInput.addEventListener('blur', () => setTimeout(hideSuggest, 150));
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(liveTimer); submitSearch(searchInput.value); });

// ================================================================== track menus
function rowData(el) {
  const row = el.closest('[data-list][data-i]');
  if (!row) return null;
  const list = getList(row.dataset.list);
  if (!list) return null;
  const i = +row.dataset.i;
  return { list, i, track: list.tracks[i] };
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast('Link copied'), () => askText('Copy link', { value: text, ok: 'Done' }));
  } else {
    askText('Copy link', { value: text, ok: 'Done' });
  }
}

const watchUrl = (t) => `https://music.youtube.com/watch?v=${t.videoId}`;

function playlistPicker(anchor, tracks) {
  const items = [
    { icon: 'plus', label: 'New playlist…', run: async () => {
      const name = await askText('New playlist', { placeholder: 'My playlist', ok: 'Create' });
      if (!name) return;
      const p = store.createPlaylist(name, tracks);
      toast(`Added to ${p.name}`);
    } },
    ...(store.playlists.length ? ['sep'] : []),
    ...store.playlists.map((p) => ({ icon: 'queue', label: p.name, run: () => {
      const n = store.addToPlaylist(p.id, tracks);
      toast(n ? `Added to ${p.name}` : `Already in ${p.name}`);
    } })),
  ];
  openMenu(anchor, items, '<div class="menu-head"><div><b>Add to playlist</b></div></div>');
}

function trackMenu(anchor, track, { list, i } = {}) {
  const liked = store.isLiked(track.videoId);
  const artist = track.artists?.find((a) => a.id);
  const items = [
    { icon: 'next-up', label: 'Play next', run: () => { player.playNext([track]); toast('Playing next'); } },
    { icon: 'queue', label: 'Add to queue', run: () => { player.addToQueue([track]); toast('Added to queue'); } },
    { icon: 'radio', label: 'Start radio', run: () => player.playRadio(track) },
    'sep',
    { icon: liked ? 'heart-fill' : 'heart', label: liked ? 'Remove from Liked songs' : 'Add to Liked songs', run: () => toast(store.toggleLike(track) ? 'Added to Liked songs' : 'Removed from Liked songs') },
    { icon: 'plus', label: 'Add to playlist…', run: () => { setTimeout(() => playlistPicker(anchor, [track])); } },
    offline.has(track.videoId)
      ? { icon: 'trash', label: 'Remove download', run: () => offline.remove(track.videoId).then(() => toast('Download removed')) }
      : { icon: 'download', label: 'Download', run: () => { if (!offline.isBusy(track.videoId)) offline.download([track]); } },
  ];
  if (list?.localId) items.push({ icon: 'trash', label: 'Remove from this playlist', run: () => store.removeFromPlaylist(list.localId, track.videoId) });
  if (list?.queue) items.push({ icon: 'trash', label: 'Remove from queue', run: () => player.removeAt(i) });
  items.push('sep');
  if (artist) items.push({ icon: 'person', label: 'Go to artist', run: () => { location.hash = `#/artist/${enc(artist.id)}`; } });
  if (track.album?.id) items.push({ icon: 'album', label: 'Go to album', run: () => { location.hash = `#/album/${enc(track.album.id)}`; } });
  items.push({ icon: 'link', label: 'Copy link', run: () => copyText(watchUrl(track)) });
  const head = `<div class="menu-head"><img src="${img(track.thumbnail, 120)}" alt=""><div class="ellipsis"><b class="ellipsis">${esc(track.title)}</b><small class="ellipsis">${esc(track.artists.map((a) => a.name).join(', '))}</small></div></div>`;
  openMenu(anchor, items, head);
}

// ================================================================== collections
async function loadCollection(kind, cid) {
  if (kind === 'album') { const a = await get.album(cid); return { tracks: a.tracks, context: { label: a.title, href: `#/album/${cid}` } }; }
  if (kind === 'playlist') { const p = await get.playlist(cid); return { tracks: p.tracks, context: { label: p.title, href: `#/playlist/${cid}` } }; }
  if (kind === 'local') { const p = store.playlist(cid); return { tracks: p?.tracks || [], context: { label: p?.name, href: `#/my/${cid}` } }; }
  return { tracks: [] };
}

async function playCollection(c, shuffle = false) {
  if (!c) return;
  if (!c.tracks.length) {
    if (c.radioId) return startArtistRadio(c);
    toast('Nothing to play here');
    return;
  }
  if (shuffle !== player.shuffle) player.toggleShuffle();
  player.playList(c.tracks, shuffle ? Math.floor(Math.random() * c.tracks.length) : 0, c.context);
}

async function startArtistRadio(c) {
  const seed = c.tracks[0]?.videoId;
  if (!seed) return toast('No radio available');
  try { await player.playPlaylistRadio(seed, c.radioId, `${c.context.label} radio`); } catch (e) { toast(e.message); }
}

function collectionMenu(anchor) {
  const c = page.collection;
  if (!c) return;
  const items = [
    { icon: 'next-up', label: 'Play next', run: () => { player.playNext(c.tracks); toast('Playing next'); } },
    { icon: 'queue', label: 'Add to queue', run: () => { player.addToQueue(c.tracks); toast(`Added ${c.tracks.length} songs to queue`); } },
    { icon: 'plus', label: 'Add to playlist…', run: () => { setTimeout(() => playlistPicker(anchor, c.tracks)); } },
    { icon: 'download', label: 'Download all', run: () => downloadCollection(c, false) },
  ];
  if (c.tracks[0]) items.push({ icon: 'radio', label: 'Start radio', run: () => player.playRadio(c.tracks[0], { label: `${c.context.label} radio` }) });
  if (['album', 'playlist', 'artist', 'insights', 'downloads'].includes(c.kind) && c.tracks.length) {
    items.push({ icon: 'queue', label: 'Save as my playlist', run: () => {
      const p = store.createPlaylist(c.context.label || 'My playlist', c.tracks);
      toast(`Created “${p.name}”`);
    } });
  }
  if (c.kind === 'album' || c.kind === 'playlist') {
    const url = c.kind === 'album' ? `https://music.youtube.com/browse/${c.card.id}` : `https://music.youtube.com/playlist?list=${c.card.id}`;
    items.push('sep', { icon: 'link', label: 'Copy link', run: () => copyText(url) });
  }
  openMenu(anchor, items);
}

// ================================================================== actions
const ACTIONS = {
  back: () => history.back(),
  forward: () => history.forward(),
  'reload-view': () => render(),
  toggle: () => player.toggle(),
  next: () => player.next(),
  prev: () => player.prev(),
  shuffle: () => player.toggleShuffle(),
  repeat: () => player.cycleRepeat(),
  mute: () => player.toggleMute(),
  'like-current': () => { if (player.current) toast(store.toggleLike(player.current) ? 'Added to Liked songs' : 'Removed from Liked songs'); },
  'open-np': () => openNP(),
  'close-np': () => closeNP(),
  'np-queue': () => toggleNP('queue'),
  'np-lyrics': () => toggleNP('lyrics'),
  'sheet-queue': () => toggleSheet('queue'),
  'sheet-lyrics': () => toggleSheet('lyrics'),
  'play-collection': () => playCollection(page.collection, false),
  'play-collection-shuffle': () => playCollection(page.collection, true),
  'collection-menu': (el) => collectionMenu(el),
  'artist-radio': () => startArtistRadio(page.collection),
  'save-collection': () => {
    const c = page.collection;
    const on = store.toggleSaved(c.kind, c.card);
    toast(c.kind === 'artist' ? (on ? `Following ${c.card.title}` : `Unfollowed ${c.card.title}`) : (on ? 'Saved to Your Library' : 'Removed from Your Library'));
    render({ keepScroll: true });
  },
  'new-playlist': async () => {
    const name = await askText('New playlist', { placeholder: 'My playlist', ok: 'Create' });
    if (name) location.hash = `#/my/${store.createPlaylist(name).id}`;
  },
  'rename-playlist': async () => {
    const p = store.playlist(page.collection.localId);
    const name = await askText('Rename playlist', { value: p.name });
    if (name) store.renamePlaylist(p.id, name);
  },
  'delete-playlist': async () => {
    const p = store.playlist(page.collection.localId);
    if (await confirmDialog('Delete playlist?', `“${p.name}” will be deleted from your library on every device.`)) {
      store.deletePlaylist(p.id);
      location.hash = '#/library';
    }
  },
  'clear-history': () => store.clearHistory(),
  'app-update': async () => {
    const info = await checkForUpdate();
    if (info?.available) startUpdate(info);
    else toast(info ? 'You have the latest version' : 'Couldn’t check for updates. Are you online?');
  },
  'android-set-server': async () => {
    const url = await askText('OpenWave on your computer', { value: window.OpenWaveAndroid.getServer() || 'http://', placeholder: 'http://192.168.1.20:47878', ok: 'Connect' });
    if (!url) return;
    toast('Connecting…');
    const error = window.OpenWaveAndroid.setServer(url);
    if (error) toast(error, 5000);
  },
  'android-use-phone': () => window.OpenWaveAndroid.setServer(''),
  'import-playlists': () => openImport(),
  'share-insights': () => shareInsights(),
  'profile-menu': (el) => profileMenu(el),
  sleep: (el) => sleepMenu(el),
  'edit-profile': async () => {
    const name = await askText('Your name', { value: store.profile.name });
    if (name) { await store.updateProfile({ name }); toast('Profile updated'); }
  },
  'profile-color': (el) => store.updateProfile({ color: el.dataset.color }),
  'set-pin': async () => {
    const pin = await askText('Set a 4–8 digit PIN', { placeholder: '••••', ok: 'Save PIN' });
    if (!pin) return;
    try { await store.updateProfile({ pin }); toast('PIN set'); } catch (e) { toast(e.message); }
  },
  'remove-pin': async () => { await store.updateProfile({ removePin: true }); toast('PIN removed'); },
  'switch-profile': async () => { await switchProfile(); renderProfileChip(); render(); },
  'delete-profile': async () => {
    if (await confirmDialog('Delete this profile?', `“${store.profile.name}” and all its likes, playlists and history will be permanently deleted from the server.`, 'Delete profile')) {
      await store.deleteProfile();
    }
  },
  'download-collection': () => downloadCollection(page.collection, true),
  'clear-downloads': async () => {
    if (await confirmDialog('Delete all downloads?', 'Downloaded songs will be removed from this device. Your playlists and likes stay.', 'Delete')) {
      await offline.clear();
      toast('Downloads deleted');
    }
  },
  export: async () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    if (await shareFile(`openwave-library-${new Date().toISOString().slice(0, 10)}.json`, blob)) return;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `openwave-library-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  import: () => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
    input.onchange = async () => {
      try { store.importJSON(await input.files[0].text()); toast('Library imported'); } catch (e) { toast(`Import failed: ${e.message}`); }
    };
    input.click();
  },
  reset: async () => {
    if (await confirmDialog('Clear your library?', 'This removes your liked songs, playlists, follows, history and settings from this profile on every device.', 'Clear library')) {
      store.reset();
      toast('Library cleared');
    }
  },
};

function activateRow(row) {
  const d = rowData(row);
  if (!d) return;
  const { list, i, track } = d;
  if (player.current?.videoId === track.videoId && player.loaded && (list.queue ? i === player.index : true)) return player.toggle();
  if (list.queue) return player.jump(i);
  if (list.mode === 'radio') return player.playRadio(track, list.context);
  player.playList(list.tracks, i, list.context);
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-stop]')) return; // plain links inside clickable rows
  const menuBtn = t.closest('[data-menu]');
  if (menuBtn) {
    e.preventDefault();
    e.stopPropagation();
    const d = rowData(menuBtn);
    if (d) trackMenu(menuBtn, d.track, d);
    return;
  }
  const playCard = t.closest('[data-play-card]');
  if (playCard) {
    e.preventDefault();
    e.stopPropagation();
    const [kind, ...rest] = playCard.dataset.playCard.split(':');
    try { playCollection(await loadCollection(kind, rest.join(':'))); } catch (err) { toast(err.message); }
    return;
  }
  const sug = t.closest('[data-suggest]');
  if (sug) { searchInput.value = sug.dataset.suggest; submitSearch(sug.dataset.suggest); return; }
  const forget = t.closest('[data-forget-search]');
  if (forget) { e.preventDefault(); store.removeSearch(forget.dataset.forgetSearch); render({ keepScroll: true }); return; }
  const act = t.closest('[data-act]');
  if (act && ACTIONS[act.dataset.act]) { e.preventDefault(); ACTIONS[act.dataset.act](act, e); return; }
  const row = t.closest('[data-list][data-i]');
  if (row) { activateRow(row); return; }
  const tab = t.closest('[data-tab]');
  if (tab) { showTab(tab.dataset.tab); return; }
  const sw = t.closest('[data-setting-toggle]');
  if (sw) { store.setting(sw.dataset.settingToggle, !store.settings[sw.dataset.settingToggle]); }
});

// ================================================================== sleep timer
function sleepMenu(anchor) {
  const set = (v, label) => () => { player.setSleep(v); toast(v ? `Sleep timer: ${label}` : 'Sleep timer off'); };
  openMenu(anchor, [
    ...[5, 15, 30, 45, 60, 90].map((m) => ({ icon: 'moon', label: `${m} minutes`, run: set(m, `${m} minutes`) })),
    { icon: 'moon', label: 'End of this song', run: set('track', 'end of this song') },
    ...(player.sleep ? ['sep', { icon: 'close', label: 'Turn off timer', run: set(null) }] : []),
  ], `<div class="menu-head"><div><b>Sleep timer</b><small>${player.sleep ? sleepLabel() : 'Music fades out and stops'}</small></div></div>`);
}

function sleepLabel() {
  if (!player.sleep) return '';
  if (player.sleep.endOfTrack) return 'Stops after this song';
  return `Stops in ${Math.max(1, Math.round((player.sleep.at - Date.now()) / 60000))} min`;
}

function bindSleep() {
  $$('[data-act="sleep"]').forEach((b) => { b.classList.toggle('on', !!player.sleep); b.title = player.sleep ? sleepLabel() : 'Sleep timer'; });
}
player.addEventListener('sleep', bindSleep);
player.addEventListener('slept', () => toast('Sleep timer: music stopped. Good night 🌙', 4000));
setInterval(() => { if (player.sleep) bindSleep(); }, 30000);

// ================================================================== drag to reorder (queue & your playlists)
let dragging = null;

function enableDrag() {
  const local = page.collection?.kind === 'local';
  if (local) $$('#view .tracks .row').forEach((r) => { r.draggable = true; });
}

document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.row[draggable="true"]');
  if (!row) return;
  dragging = { row, list: row.dataset.list, from: +row.dataset.i };
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.vid);
});
document.addEventListener('dragover', (e) => {
  const row = dragging && e.target.closest?.(`.row[data-list="${dragging.list}"]`);
  if (!row || row === dragging.row) return;
  e.preventDefault();
  $$('.row.drop-above, .row.drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  const below = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
  row.classList.add(below ? 'drop-below' : 'drop-above');
});
document.addEventListener('drop', (e) => {
  const row = dragging && e.target.closest?.(`.row[data-list="${dragging.list}"]`);
  if (!row) return;
  e.preventDefault();
  let to = +row.dataset.i + (row.classList.contains('drop-below') ? 1 : 0);
  const { from } = dragging;
  if (to > from) to--;
  const list = getList(dragging.list);
  if (list?.queue) player.move(from, to);
  else if (list?.localId) {
    const ids = list.tracks.map((t) => t.videoId);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    dragging = null;
    store.reorderPlaylist(list.localId, ids);
  }
});
document.addEventListener('dragend', () => {
  $$('.row.dragging, .row.drop-above, .row.drop-below').forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below'));
  dragging = null;
});

document.addEventListener('contextmenu', (e) => {
  const d = rowData(e.target);
  if (!d || e.target.closest('a')) return;
  e.preventDefault();
  trackMenu({ x: e.clientX, y: e.clientY }, d.track, d);
});

document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-setting]');
  if (sel) {
    store.setting(sel.dataset.setting, sel.dataset.type === 'number' ? +sel.value : sel.value);
    if (sel.dataset.setting === 'quality') toast('Applies from the next track');
  }
});

// ================================================================== offline downloads
async function downloadCollection(c, toggle) {
  if (!c?.tracks.length) return;
  const missing = c.tracks.filter((t) => !offline.has(t.videoId));
  if (!missing.length && toggle) {
    if (await confirmDialog('Remove downloads?', `${c.tracks.length} songs from “${c.context.label}” will be removed from this device.`, 'Remove')) {
      for (const t of c.tracks) await offline.remove(t.videoId);
      toast('Downloads removed');
    }
    return;
  }
  if (!navigator.onLine) { toast('Connect to the internet to download'); return; }
  const n = offline.download(missing);
  if (!n) toast('Already downloading');
}

function markDownloads() {
  $$('.row[data-vid]').forEach((r) => {
    const id = r.dataset.vid;
    r.classList.toggle('downloaded', offline.has(id));
    r.classList.toggle('downloading', !offline.has(id) && offline.isBusy(id));
  });
  const btn = $('#view [data-act="download-collection"]');
  if (btn && page.collection) {
    const all = page.collection.tracks.length && page.collection.tracks.every((t) => offline.has(t.videoId));
    btn.classList.toggle('on', !!all);
    btn.innerHTML = icon(all ? 'downloaded' : 'download');
    btn.title = all ? 'Downloaded' : 'Download';
  }
  const prog = $('#dl-progress');
  if (prog) {
    prog.hidden = !offline.queued;
    $('#dl-progress-text').textContent = `Downloading ${offline.queued} song${offline.queued === 1 ? '' : 's'}…`;
  }
}

let downloadedThisBatch = 0;
offline.on('queued', ({ count }) => toast(`Downloading ${count} song${count === 1 ? '' : 's'}…`));
offline.on('progress', () => markDownloads());
offline.on('change', (d) => {
  if (d.added) downloadedThisBatch++;
  markDownloads();
  if (page.name === 'downloads' || page.name === 'settings' || page.name === 'library') render({ keepScroll: true });
});
offline.on('error', ({ track, message }) => toast(`Couldn’t download “${track.title}” — ${message}`, 4500));
offline.on('idle', () => {
  if (downloadedThisBatch) toast(`${downloadedThisBatch} song${downloadedThisBatch === 1 ? '' : 's'} saved for offline listening`);
  downloadedThisBatch = 0;
});

function onConnectivity() {
  const off = !navigator.onLine;
  document.body.classList.toggle('offline', off);
  if (off) toast('You’re offline — downloads still play', 3500);
  if (page.name === 'home') render({ keepScroll: true });
}
window.addEventListener('online', onConnectivity);
window.addEventListener('offline', onConnectivity);
document.body.classList.toggle('offline', !navigator.onLine);

// Resolve a stream as soon as the pointer rests on a track, so the click starts playback faster.
let hoverTimer;
const prefetched = new Set();
document.addEventListener('pointerover', (e) => {
  const vid = e.target.closest?.('[data-vid]')?.dataset.vid;
  if (!vid || !navigator.onLine || offline.has(vid) || prefetched.has(vid) || vid === player.current?.videoId) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (prefetched.size > 300) prefetched.clear();
    prefetched.add(vid);
    get.prefetch(vid);
  }, e.pointerType === 'mouse' ? 150 : 0);
});

// ================================================================== keyboard
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-list][data-i]')) { e.preventDefault(); activateRow(e.target); return; }
  if (e.target.closest('input, textarea, select, [contenteditable]') || $('#dialog').open || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === ' ' || k === 'k') { e.preventDefault(); player.toggle(); }
  else if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? player.next() : player.seek(player.time + 5); }
  else if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? player.prev() : player.seek(player.time - 5); }
  else if (k === 'n') player.next();
  else if (k === 'p') player.prev();
  else if (k === 'm') player.toggleMute();
  else if (k === 'l') ACTIONS['like-current']();
  else if (k === 's') player.toggleShuffle();
  else if (k === 'r') player.cycleRepeat();
  else if (k === '/') { e.preventDefault(); searchInput.focus(); }
  else if (k === 'Escape' && !np.hidden) closeNP();
});

// ================================================================== player bindings
const bind = (name) => $$(`[data-bind="${name}"]`);

function markPlaying() {
  const vid = player.current?.videoId;
  $$('.row.playing').forEach((r) => r.classList.remove('playing'));
  if (!vid) return;
  $$(`#view .row[data-vid="${CSS.escape(vid)}"]`).forEach((r) => r.classList.add('playing'));
  $(`#np-queue .row[data-i="${player.index}"]`)?.classList.add('playing');
}

function bindLike() {
  const on = !!player.current && store.isLiked(player.current.videoId);
  $$('[data-act="like-current"]').forEach((b) => {
    b.classList.toggle('on', on);
    b.innerHTML = icon(on ? 'heart-fill' : 'heart');
    b.setAttribute('aria-label', on ? 'Remove from Liked songs' : 'Add to Liked songs');
  });
}

function bindTrack(t) {
  const bar = $('#playerbar');
  if (t) delete bar.dataset.empty; else bar.dataset.empty = '';
  bind('title').forEach((el) => { el.textContent = t?.title || 'Nothing playing'; });
  bind('artists').forEach((el) => { el.innerHTML = t ? artistLinks(t.artists) : 'Search for something to play'; });
  $$('[data-bind="artists"] a').forEach((a) => a.setAttribute('data-stop', ''));
  bind('art-sm').forEach((el) => { el.src = t ? img(t.thumbnail, 120) : ''; });
  bind('art').forEach((el) => { el.src = t ? img(t.thumbnail, 720) : ''; });
  if (t && offline.has(t.videoId) && !navigator.onLine) {
    offline.artUrl(t.videoId).then((u) => u && player.current?.videoId === t.videoId && bind('art').concat(bind('art-sm')).forEach((el) => { el.src = u; }));
  }
  bind('context').forEach((el) => { el.textContent = player.context?.label || 'Queue'; });
  bindLike();
  markPlaying();
  if (t) sampleTint(img(t.thumbnail, 120)).then((c) => c && document.documentElement.style.setProperty('--np-tint', c));
  else document.title = 'OpenWave';
  lyricsFor = null;
  if (!np.hidden && !$('#np-lyrics').hidden) loadLyrics();
}

function bindState() {
  const playing = player.loaded && !player.paused;
  bind('play').forEach((b) => {
    b.innerHTML = icon(playing ? 'pause' : 'play');
    b.classList.toggle('loading', player.loading && player.loaded);
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
  bind('spinner').forEach((s) => s.classList.toggle('on', player.loading && player.loaded));
  bind('shuffle').forEach((b) => b.classList.toggle('on', player.shuffle));
  bind('repeat').forEach((b) => {
    b.classList.toggle('on', player.repeat !== 'off');
    b.innerHTML = icon(player.repeat === 'one' ? 'repeat-one' : 'repeat');
  });
}

let seeking = false;
function bindTime() {
  const dur = player.duration;
  const cur = Math.min(player.time, dur || Infinity);
  bind('cur').forEach((el) => { if (!seeking) el.textContent = fmtTime(cur); });
  bind('dur').forEach((el) => { el.textContent = fmtTime(dur); });
  const pct = dur ? (cur / dur) * 100 : 0;
  if (!seeking) bind('seek').forEach((r) => { r.value = Math.round(pct * 10); r.style.setProperty('--p', `${pct}%`); });
  bind('progress').forEach((el) => { el.style.width = `${pct}%`; });
  syncLyrics();
}

bind('seek').forEach((r) => {
  r.addEventListener('input', () => {
    seeking = true;
    r.style.setProperty('--p', `${r.value / 10}%`);
    bind('cur').forEach((el) => { el.textContent = fmtTime((r.value / 1000) * player.duration); });
  });
  r.addEventListener('change', () => { seeking = false; player.seek((r.value / 1000) * player.duration); });
});

const vol = $('#volume');
function bindVolume() {
  const v = player.muted ? 0 : player.volume;
  vol.value = Math.round(v * 100);
  vol.style.setProperty('--p', `${v * 100}%`);
  bind('mute').forEach((b) => { b.innerHTML = icon(v === 0 ? 'mute' : 'volume'); });
}
vol.addEventListener('input', () => player.setVolume(vol.value / 100));
vol.addEventListener('wheel', (e) => { e.preventDefault(); player.setVolume(player.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });

player.addEventListener('track', (e) => bindTrack(e.detail));
player.addEventListener('state', bindState);
player.addEventListener('time', bindTime);
player.addEventListener('volume', bindVolume);
player.addEventListener('queue', () => { bind('context').forEach((el) => { el.textContent = player.context?.label || 'Queue'; }); if (!np.hidden) renderQueue(); markPlaying(); });
player.addEventListener('error', (e) => toast(e.detail, 4500));

// ================================================================== now playing
function openNP(tab) {
  np.hidden = false;
  document.body.classList.add('np-open');
  if (tab) showTab(tab);
  else if ($('#np-lyrics').hidden) renderQueue(); else loadLyrics();
}

function closeNP() {
  if (np.hidden) return;
  np.hidden = true;
  np.classList.remove('show-panel');
  document.body.classList.remove('np-open');
}

function toggleNP(tab) {
  const showing = tab === 'lyrics' ? !$('#np-lyrics').hidden : !$('#np-queue').hidden;
  if (!np.hidden && showing) closeNP(); else openNP(tab);
}

function toggleSheet(tab) {
  const showing = np.classList.contains('show-panel') && (tab === 'lyrics' ? !$('#np-lyrics').hidden : !$('#np-queue').hidden);
  np.classList.toggle('show-panel', !showing);
  if (!showing) showTab(tab);
  $$('.np-sheet-btns button').forEach((b) => b.classList.toggle('on', !showing && b.dataset.act === `sheet-${tab}`));
}

function showTab(tab) {
  $$('#np [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#np-queue').hidden = tab !== 'queue';
  $('#np-lyrics').hidden = tab !== 'lyrics';
  if (tab === 'queue') renderQueue(); else loadLyrics();
}

function renderQueue() {
  const box = $('#np-queue');
  const t = player.current;
  if (!t) { box.innerHTML = empty('queue', 'Your queue is empty', 'Play something to get started.'); return; }
  const key = registerList(player.queue, { queue: true });
  const upcoming = player.queue.slice(player.index + 1, player.index + 151);
  box.innerHTML = `<div class="queue-label">Now playing</div>${trackRow(t, player.index, key, { playing: true })}
    <div class="queue-label">Next${player.context?.label ? ` from ${esc(player.context.label)}` : ''}</div>
    ${upcoming.map((u, n) => trackRow(u, player.index + 1 + n, key)).join('') || `<p class="muted" style="padding:0 10px">${store.settings.autoplay && navigator.onLine ? 'Finding similar songs…' : 'Nothing queued.'}</p>`}`;
  box.querySelectorAll('.row').forEach((r) => { if (+r.dataset.i > player.index) r.draggable = true; });
  markDownloads();
}

// ------------------------------------------------------------------ lyrics
let lyricsFor = null;
let lyrics = null;
let activeLine = -1;
let userScrolledAt = 0;

async function loadLyrics() {
  const box = $('#np-lyrics');
  const t = player.current;
  if (!t) { box.innerHTML = empty('lyrics', 'No song playing', ''); return; }
  if (lyricsFor === t.videoId) return;
  lyricsFor = t.videoId;
  lyrics = null;
  activeLine = -1;
  box.innerHTML = '<div class="lyrics plain muted">Loading lyrics…</div>';
  try {
    const data = await get.lyrics(t.videoId);
    if (lyricsFor !== t.videoId) return;
    lyrics = data;
    if (!data.found) { box.innerHTML = empty('lyrics', 'No lyrics for this one', 'Lyrics aren’t available for every song.'); return; }
    const src = data.source ? `<div class="src">${esc(data.source)}</div>` : '';
    box.innerHTML = data.synced
      ? `<div class="lyrics">${data.lines.map((l) => `<p data-ms="${l.start}">${esc(l.text) || '♪'}</p>`).join('')}${src}</div>`
      : `<div class="lyrics plain">${esc(data.text)}${src}</div>`;
    box.scrollTop = 0;
    syncLyrics();
  } catch (e) {
    if (lyricsFor === t.videoId) { box.innerHTML = errorBox(e, false); lyricsFor = null; }
  }
}

function syncLyrics() {
  if (!lyrics?.synced || np.hidden || $('#np-lyrics').hidden) return;
  const ms = player.time * 1000 + 250;
  const lines = lyrics.lines;
  let i = lines.findIndex((l) => l.start > ms) - 1;
  if (i === -2) i = lines.length - 1;
  if (i === activeLine) return;
  activeLine = i;
  const ps = $$('#np-lyrics p');
  ps.forEach((p, n) => { p.classList.toggle('on', n === i); p.classList.toggle('past', n < i); });
  if (ps[i] && Date.now() - userScrolledAt > 3000) ps[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

const lyricsBox = $('#np-lyrics');
['wheel', 'touchmove'].forEach((ev) => lyricsBox.addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true }));
lyricsBox.addEventListener('click', (e) => {
  const p = e.target.closest('p[data-ms]');
  if (p) { userScrolledAt = 0; player.seek(+p.dataset.ms / 1000); if (player.paused) player.play(); }
});

// ================================================================== boot
initNative({
  toggle: () => player.toggle(),
  play: () => player.play(),
  pause: () => player.pause(),
  next: () => player.next(),
  prev: () => player.prev(),
  seek: (s) => player.seek(+s),
  like: () => ACTIONS['like-current'](),
  shuffle: () => player.toggleShuffle(),
  repeat: () => player.cycleRepeat(),
  volumeUp: () => player.setVolume(player.volume + 0.1),
  volumeDown: () => player.setVolume(player.volume - 0.1),
  navigate: (hash) => { location.hash = hash; },
  search: () => { searchInput.focus(); },
  nowPlaying: () => openNP(),
  importPlaylists: () => openImport(),
  sleep: (m) => player.setSleep(m === 'off' ? null : m === 'track' ? 'track' : +m),
});
renderSidebar();
renderProfileChip();
player.init();
bindState();
bindVolume();
bindTrack(player.current);
bindSleep();
initUpdates();
Promise.all([offline.init(), ensureProfile()]).finally(() => {
  renderProfileChip();
  renderSidebar();
  render();
  store.pull();
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker', e));
}
