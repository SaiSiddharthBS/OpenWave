// Rendering helpers shared by all views.

import { img } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;

export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtTotal(tracks) {
  const s = tracks.reduce((n, t) => n + (t.duration || 0), 0);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

export const artistNames = (t) => (t.artists || []).map((a) => a.name).join(', ');

export function artistLinks(artists = []) {
  return artists
    .map((a) => (a.id ? `<a href="#/artist/${esc(a.id)}" data-stop>${esc(a.name)}</a>` : esc(a.name)))
    .join(', ');
}

// Track lists are registered so delegated click handlers can find the data behind a row.
const lists = new Map();
let listSeq = 0;
export function registerList(tracks, opts = {}) {
  const key = `l${++listSeq}`;
  lists.set(key, { tracks, ...opts });
  if (lists.size > 200) lists.delete(lists.keys().next().value);
  return key;
}
export const getList = (key) => lists.get(key);

export function trackRow(t, i, key, { numbered = false, album = false, playing = false } = {}) {
  const lead = numbered
    ? `<span class="lead num">${i + 1}</span>`
    : `<span class="lead"><img class="thumb" loading="lazy" src="${img(t.thumbnail, 120)}" alt=""></span>`;
  const badges = (t.explicit ? '<span class="badge-e" title="Explicit">E</span>' : '') +
    (t.type === 'video' && !numbered ? '<span class="badge-v">VIDEO</span>' : '');
  const cls = ['row', numbered && 'numbered', album && 'with-album', playing && 'playing'].filter(Boolean).join(' ');
  return `<div class="${cls}" data-list="${key}" data-i="${i}" data-vid="${esc(t.videoId)}" role="button" tabindex="0">
    ${lead}
    <div class="ellipsis"><div class="t ellipsis">${esc(t.title)}</div><div class="a ellipsis">${badges}${artistLinks(t.artists) || (t.type === 'video' ? 'Video' : 'Song')}</div></div>
    ${album ? `<div class="alb ellipsis">${t.album?.id ? `<a href="#/album/${esc(t.album.id)}" data-stop>${esc(t.album.name)}</a>` : esc(t.album?.name || '')}</div>` : ''}
    <span class="d">${t.duration ? fmtTime(t.duration) : ''}</span>
    <button class="icon-btn more" data-menu aria-label="More options">${icon('more')}</button>
  </div>`;
}

export function trackList(tracks, opts = {}) {
  const key = registerList(tracks, opts);
  return `<div class="tracks">${tracks.map((t, i) => trackRow(t, i, key, opts)).join('')}</div>`;
}

export function trackCard(t, i, key) {
  const video = t.type === 'video';
  return `<div class="card ${video ? 'video' : ''}" data-list="${key}" data-i="${i}" data-vid="${esc(t.videoId)}" role="button" tabindex="0">
    <div class="art"><img loading="lazy" src="${img(t.thumbnail, 300)}" alt="">
      ${video && t.duration ? `<span class="dur-badge">${fmtTime(t.duration)}</span>` : ''}
      <span class="hover-play">${icon('play')}</span></div>
    <div class="title">${esc(t.title)}</div>
    <div class="sub">${t.explicit ? '<span class="badge-e">E</span>' : ''}${esc(artistNames(t))}</div>
  </div>`;
}

export function trackCards(tracks, opts = {}) {
  const key = registerList(tracks, opts);
  return tracks.map((t, i) => trackCard(t, i, key)).join('');
}

const HREF = { album: 'album', playlist: 'playlist', artist: 'artist', local: 'my' };

export function card(c) {
  const href = `#/${HREF[c.type]}/${encodeURIComponent(c.id)}`;
  const canPlay = c.type !== 'artist';
  return `<a class="card ${c.type}" href="${href}">
    <div class="art"><img loading="lazy" src="${img(c.thumbnail, 300)}" alt="">
      ${canPlay ? `<button class="hover-play" data-play-card="${c.type}:${esc(c.id)}" aria-label="Play">${icon('play')}</button>` : ''}</div>
    <div class="title">${esc(c.title)}</div>
    <div class="sub">${esc(c.subtitle || '')}</div>
  </a>`;
}

export const cards = (items) => items.map(card).join('');

export function section(title, body, { more = '', cls = 'shelf' } = {}) {
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${more}</div><div class="${cls}">${body}</div></section>`;
}

export function skeleton(kind = 'home') {
  if (kind === 'detail') {
    return `<div class="hero"><div class="cover skeleton"></div><div class="info" style="flex:1"><div class="skeleton" style="height:14px;width:90px"></div><div class="skeleton" style="height:48px;width:60%;margin:14px 0"></div><div class="skeleton" style="height:14px;width:40%"></div></div></div>
      <div style="margin-top:28px">${'<div class="skeleton" style="height:48px;margin:8px 0"></div>'.repeat(8)}</div>`;
  }
  const shelf = `<div class="section"><div class="skeleton" style="height:24px;width:200px;margin-bottom:16px"></div><div class="sk-shelf">${'<div class="skeleton"></div>'.repeat(8)}</div></div>`;
  return shelf.repeat(3);
}

export function errorBox(err, retry = true) {
  return `<div class="error-box"><h3>Something went wrong</h3><p>${esc(err?.message || err)}</p>
    ${retry ? '<button class="btn" data-act="reload-view">Try again</button>' : ''}</div>`;
}

export function empty(iconName, title, text, extra = '') {
  return `<div class="empty">${icon(iconName)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;
}

// ------------------------------------------------------------------ toast
let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ menu
let menuCleanup = null;
export function closeMenu() {
  const m = $('#menu');
  m.hidden = true;
  m.innerHTML = '';
  menuCleanup?.();
  menuCleanup = null;
}

/** items: [{icon, label, run}] | 'sep'; head: optional html */
export function openMenu(anchor, items, head = '') {
  closeMenu();
  const m = $('#menu');
  m.innerHTML = head + items.map((it, i) =>
    it === 'sep' ? '<hr>' : `<button data-mi="${i}" role="menuitem">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  m.hidden = false;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = `${Math.max(8, left)}px`;
  m.style.top = `${top}px`;
  const onClick = (e) => {
    const b = e.target.closest('[data-mi]');
    if (b) {
      e.stopPropagation();
      const it = items[+b.dataset.mi];
      const keepOpen = it.run() === 'keep';
      if (!keepOpen) closeMenu();
    }
  };
  const outside = (e) => { if (!m.contains(e.target)) closeMenu(); };
  const key = (e) => { if (e.key === 'Escape') closeMenu(); };
  m.addEventListener('click', onClick);
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', closeMenu, { once: true });
    $('#main').addEventListener('scroll', closeMenu, { once: true });
  });
  menuCleanup = () => {
    m.removeEventListener('click', onClick);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key);
  };
  m.querySelector('button')?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ dialogs
export function askText(title, { value = '', placeholder = '', ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>
      <input type="text" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="100" autocomplete="off">
      <div class="row-btns"><button class="btn" value="cancel" type="submit">Cancel</button><button class="btn primary" value="ok" type="submit">${esc(ok)}</button></div></form>`;
    const input = d.querySelector('input');
    d.onclose = () => resolve(d.returnValue === 'ok' ? input.value.trim() || null : null);
    d.returnValue = '';
    d.showModal();
    input.select();
  });
}

export function confirmDialog(title, text, ok = 'Delete') {
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="row-btns"><button class="btn" value="cancel">Cancel</button><button class="btn danger" value="ok">${esc(ok)}</button></div></form>`;
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.returnValue = '';
    d.showModal();
  });
}

// ------------------------------------------------------------------ colour sampling
const tintCache = new Map();
/** Average, saturation-weighted colour of an image as "r, g, b" (same-origin via /api/img). */
export function sampleTint(src) {
  if (tintCache.has(src)) return Promise.resolve(tintCache.get(src));
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(im, 0, 0, 24, 24);
        const px = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < px.length; i += 4) {
          const max = Math.max(px[i], px[i + 1], px[i + 2]);
          const min = Math.min(px[i], px[i + 1], px[i + 2]);
          const weight = 0.15 + (max - min) / 255 + (max > 40 && max < 235 ? 0.3 : 0);
          r += px[i] * weight; g += px[i + 1] * weight; b += px[i + 2] * weight; w += weight;
        }
        // Darken so white text always reads on top of it.
        const scale = Math.min(1, 150 / Math.max(r / w, g / w, b / w, 1));
        const tint = [r, g, b].map((v) => Math.round((v / w) * scale)).join(', ');
        tintCache.set(src, tint);
        resolve(tint);
      } catch { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

/** Show arbitrary content in the shared <dialog>; resolves when it closes. */
export function openDialog(html, { wide = false, onMount } = {}) {
  const d = $('#dialog');
  d.classList.toggle('wide', wide);
  d.innerHTML = html;
  d.returnValue = '';
  return new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue);
    d.showModal();
    onMount?.(d);
  });
}

export function avatar(profile, size = 32) {
  const initial = esc((profile?.name || '?').trim()[0]?.toUpperCase() || '?');
  return `<span class="avatar" style="--av:${esc(profile?.color || '#7b7bff')};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${initial}</span>`;
}
