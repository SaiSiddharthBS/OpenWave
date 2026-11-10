// Explore: what the world is playing. A dotted world map where every country with a chart today
// glows, each country's chart, genres and moods from everywhere, today's country (on Home and in
// Search), "Take me somewhere" for when you can't decide, and a passport of the countries you've
// played. The engine side is openwave/explore.py; the map is js/world-map.js.

import { go } from './nav.js';
import { api, img, enc } from './api.js';
import { player } from './player.js';
import { store } from './store.js';
import { esc, icon, trackList, trackCards, cards, section, empty, toast } from './ui.js';
import { actions } from './views.js';
import { calm } from './glass.js';
import { MAP, CODES, RUNS, COUNTRY } from './world-map.js';

export const GLOBAL = 'ZZ';
const HEX = Math.sqrt(3) / 2;
const TAU = Math.PI * 2;
const MAP_W = MAP.cols + 0.5;
const MAP_H = MAP.rows * HEX;

// ------------------------------------------------------------------ data
const SAVED = 'openwave:explore';

/** Countries, genres, moods and today's country. The last answer shows at once (if under 12 hours
 * old) while a fresh one loads for next time, like Home. */
export async function world() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVED) || 'null'); } catch { /* storage blocked */ }
  const fresh = api('/api/explore', { ttl: 1800 }).then((value) => {
    try { localStorage.setItem(SAVED, JSON.stringify({ at: Date.now(), value })); } catch { /* full */ }
    return value;
  });
  if (saved?.value?.countries?.length && Date.now() - saved.at < 12 * 3600e3) { fresh.catch(() => {}); return saved.value; }
  return fresh;
}

export const countryData = (code) => api(`/api/explore/country/${code}`, { ttl: 1800 });
const genreData = (params) => api(`/api/explore/genre/${enc(params)}`, { ttl: 3600 });

let regionNames = null;
try { regionNames = new Intl.DisplayNames([navigator.language, 'en'], { type: 'region' }); } catch { /* old browser */ }
/** "Nigeria", in the language of the device. */
export const nameOf = (code) => (code === GLOBAL ? 'Worldwide' : regionNames?.of(code) || code);

// Where each chart country's clock is (its capital's time zone, or its biggest city's).
const ZONES = {
  AE: 'Asia/Dubai', AR: 'America/Argentina/Buenos_Aires', AT: 'Europe/Vienna', AU: 'Australia/Sydney', BE: 'Europe/Brussels', BO: 'America/La_Paz',
  BR: 'America/Sao_Paulo', CA: 'America/Toronto', CH: 'Europe/Zurich', CL: 'America/Santiago', CO: 'America/Bogota', CR: 'America/Costa_Rica',
  CZ: 'Europe/Prague', DE: 'Europe/Berlin', DK: 'Europe/Copenhagen', DO: 'America/Santo_Domingo', EC: 'America/Guayaquil', EE: 'Europe/Tallinn',
  EG: 'Africa/Cairo', ES: 'Europe/Madrid', FI: 'Europe/Helsinki', FR: 'Europe/Paris', GB: 'Europe/London', GT: 'America/Guatemala',
  HK: 'Asia/Hong_Kong', HN: 'America/Tegucigalpa', HU: 'Europe/Budapest', ID: 'Asia/Jakarta', IE: 'Europe/Dublin', IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata', IS: 'Atlantic/Reykjavik', IT: 'Europe/Rome', JP: 'Asia/Tokyo', KE: 'Africa/Nairobi', KR: 'Asia/Seoul',
  LU: 'Europe/Luxembourg', MX: 'America/Mexico_City', MY: 'Asia/Kuala_Lumpur', NG: 'Africa/Lagos', NI: 'America/Managua', NL: 'Europe/Amsterdam',
  NO: 'Europe/Oslo', NZ: 'Pacific/Auckland', PA: 'America/Panama', PE: 'America/Lima', PH: 'Asia/Manila', PL: 'Europe/Warsaw',
  PT: 'Europe/Lisbon', PY: 'America/Asuncion', RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RU: 'Europe/Moscow', SA: 'Asia/Riyadh',
  SE: 'Europe/Stockholm', SG: 'Asia/Singapore', SV: 'America/El_Salvador', TH: 'Asia/Bangkok', TR: 'Europe/Istanbul', TW: 'Asia/Taipei',
  TZ: 'Africa/Dar_es_Salaam', UA: 'Europe/Kyiv', UG: 'Africa/Kampala', US: 'America/New_York', UY: 'America/Montevideo', VN: 'Asia/Ho_Chi_Minh',
  ZA: 'Africa/Johannesburg', ZW: 'Africa/Harare',
};
const OLD_ZONES = { 'Europe/Kyiv': 'Europe/Kiev', 'Asia/Kolkata': 'Asia/Calcutta', 'Asia/Ho_Chi_Minh': 'Asia/Saigon' };

function clock(code) {
  const zone = ZONES[code];
  if (!zone) return '';
  for (const timeZone of [zone, OLD_ZONES[zone]].filter(Boolean)) {
    try { return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date()); } catch { /* unknown zone */ }
  }
  return '';
}
const capitalOf = (code) => COUNTRY[code]?.[1] || '';
/** "9:41 PM in Abuja" */
function localTime(code) {
  const t = clock(code);
  return t ? `${t}${capitalOf(code) ? ` in ${capitalOf(code)}` : ''}` : '';
}

/** The country this device is in: from its time zone, else from its language ("en-IN"). */
function homeCountry() {
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* no Intl */ }
  const byZone = Object.keys(ZONES).find((c) => ZONES[c] === zone || OLD_ZONES[ZONES[c]] === zone);
  if (byZone) return byZone;
  const region = (navigator.language || '').split('-')[1]?.toUpperCase();
  return COUNTRY[region] ? region : null;
}

// Each country has the map's colour where it sits: the Americas cyan, Europe and Africa blue to
// violet, Asia violet to pink, as in the app's own gradient.
const STOPS = [[47, 200, 255], [79, 107, 255], [196, 92, 255], [255, 111, 174]];
function hueAt(t) {
  const x = Math.min(0.999, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.floor(x), f = x - i;
  return STOPS[i].map((v, k) => Math.round(v + (STOPS[i + 1][k] - v) * f));
}
/** "r, g, b" for a country. */
export const colourOf = (code) => (code === GLOBAL ? '123, 123, 255' : hueAt(((COUNTRY[code]?.[2] ?? 84) + 0.5) / MAP_W).join(', '));

/** "#rrggbb" for a country, for the car's pictures. */
export const hexOf = (code) => `#${colourOf(code).split(', ').map((v) => (+v).toString(16).padStart(2, '0')).join('')}`;
/** A country's dotted shape as "columns,rows,bits" (js/world-map.js), for the car to draw. */
export const shapeOf = (code) => (COUNTRY[code] ? COUNTRY[code].slice(4, 7).join(',') : '');
/** The whole world as a small dotted shape in the same form, for the car's "Worldwide" and "Every country". */
export function worldShape(cols = 46) {
  const d = load();
  const rows = Math.round((cols * (MAP_H / MAP_W)) / HEX);
  const bits = new Uint8Array(Math.ceil((cols * rows) / 8));
  for (let i = 0; i < d.n; i++) {
    const x = Math.min(cols - 1, Math.floor((d.x[i] / MAP_W) * cols)), y = Math.min(rows - 1, Math.floor((d.y[i] / MAP_H) * rows));
    bits[(y * cols + x) >> 3] |= 1 << ((y * cols + x) & 7);
  }
  return `${cols},${rows},${btoa(String.fromCharCode(...bits))}`;
}

/** The country a spoken name means ("Mexico", "the United Kingdom"), among `codes`. */
export function countryNamed(words, codes) {
  const said = words.toLowerCase().replace(/^the\s+/, '').trim();
  const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return codes.find((c) => plain(nameOf(c)) === plain(said)) || null;
}

const REGIONS = [['af', 'Africa'], ['as', 'Asia'], ['eu', 'Europe'], ['la', 'Latin America'], ['me', 'Middle East'], ['na', 'North America'], ['oc', 'Oceania']];
const regionOf = (code) => COUNTRY[code]?.[0] || '';

// ------------------------------------------------------------------ passport
// Every country you play gets a stamp. Kept on this device, for this profile; nothing leaves it.
const passKey = () => `openwave:passport:${store.profile?.id || 'me'}`;
export function passport() {
  try { return JSON.parse(localStorage.getItem(passKey()) || '{}') || {}; } catch { return {}; }
}
function stamp(code) {
  if (!COUNTRY[code]) return;
  const p = passport();
  if (p[code]) return;
  p[code] = Date.now();
  try { localStorage.setItem(passKey(), JSON.stringify(p)); } catch { /* storage blocked */ }
  toast(`${nameOf(code)} is in your passport`);
}
player.addEventListener('track', () => {
  const m = player.context?.href?.match(/^#\/explore\/([A-Z]{2})$/);
  if (m && m[1] !== GLOBAL) stamp(m[1]);
});

// ------------------------------------------------------------------ the map
let dots = null;
/** Every dot of the map: where it is (in map units: one column = 1) and whose it is. */
function load() {
  if (dots) return dots;
  let n = 0;
  for (let i = 0; i < RUNS.length; i += 4) n += RUNS[i + 2];
  const x = new Float32Array(n), y = new Float32Array(n), c = new Int16Array(n);
  const grid = new Int16Array(MAP.cols * MAP.rows).fill(-1);
  let k = 0;
  for (let i = 0; i < RUNS.length; i += 4) {
    const row = RUNS[i], col = RUNS[i + 1], len = RUNS[i + 2], who = RUNS[i + 3];
    for (let j = 0; j < len; j++, k++) {
      x[k] = col + j + 0.5 + (row % 2) * 0.5;
      y[k] = (row + 0.5) * HEX;
      c[k] = who;
      grid[row * MAP.cols + col + j] = who;
    }
  }
  const codes = [];
  for (let i = 0; i < CODES.length; i += 2) codes.push(CODES.slice(i, i + 2));
  dots = { x, y, c, n, grid, codes, index: new Map(codes.map((code, i) => [code, i])), boxes: new Map() };
  return dots;
}

/** A country's middle, in map units. */
function middle(code) {
  const c = COUNTRY[code];
  return c ? [c[2] + 0.5, (c[3] + 0.5) * HEX] : [MAP_W / 2, MAP_H / 2];
}

/** The box around a country's dots on the map (its main land, near its middle). */
function box(code) {
  const d = load();
  if (d.boxes.has(code)) return d.boxes.get(code);
  const who = d.index.get(code);
  const [mx, my] = middle(code);
  let x0 = mx, y0 = my, x1 = mx, y1 = my;
  for (let i = 0; i < d.n; i++) {
    if (d.c[i] !== who || Math.abs(d.x[i] - mx) > 30 || Math.abs(d.y[i] - my) > 22) continue;
    x0 = Math.min(x0, d.x[i]); y0 = Math.min(y0, d.y[i]); x1 = Math.max(x1, d.x[i]); y1 = Math.max(y1, d.y[i]);
  }
  const b = [x0, y0, x1, y1];
  d.boxes.set(code, b);
  return b;
}

/** The whole map fitted to (or, with `cover`, filling) w x h, nudged up or down by `shift` map units. */
function fitView(w, h, cover = false, shift = 0) {
  const s = cover ? Math.max(w / MAP_W, h / MAP_H) : Math.min(w / MAP_W, h / MAP_H);
  return { x: (MAP_W - w / s) / 2, y: Math.min(MAP_H - h / s, Math.max(0, (MAP_H - h / s) / 2 + shift)), s };
}

/** Close in on a country, placed at (fx, fy) of the way across and down. */
function focusView(code, w, h, fx = 0.5, fy = 0.5) {
  if (code === GLOBAL || !COUNTRY[code]) return fitView(w, h, true, -2);
  const [x0, y0, x1, y1] = box(code);
  const bw = Math.max(7, x1 - x0 + 2), bh = Math.max(6, y1 - y0 + 2);
  const s = Math.max(w / MAP_W, Math.min((w * 0.2) / bw, (h * 0.34) / bh, 17));
  const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
  return { x: mx - (w * fx) / s, y: my - (h * fy) / s, s };
}

function fitCanvas(canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const BANDS = 20;
/**
 * Draws the dotted map on `canvas`. Countries in `lit` glow in their colour, `hot` (under the
 * pointer, or the page's own country) is white, `you` (this device's country) is white too.
 * Dots are drawn in a few batches, one per colour, so a whole map costs a millisecond or two.
 */
function paint(canvas, { lit = new Set(), hot = null, you = null, view = null, cover = false, shift = 0, size = 0.3, dim = 0.12, glow = 0.9, halo = null } = {}) {
  const d = load();
  const box2 = fitCanvas(canvas);
  if (!box2) return null;
  const { ctx, w, h } = box2;
  const v = view || fitView(w, h, cover, shift);
  const r = Math.max(0.55, v.s * size);
  if (halo) {
    const [mx, my] = middle(halo);
    const px = (mx - v.x) * v.s, py = (my - v.y) * v.s;
    const g = ctx.createRadialGradient(px, py, 0, px, py, Math.max(w, h) * 0.42);
    g.addColorStop(0, `rgba(${colourOf(halo)}, .55)`);
    g.addColorStop(1, `rgba(${colourOf(halo)}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const litIdx = new Set([...lit].map((code) => d.index.get(code)).filter((i) => i != null));
  const hotIdx = hot != null ? d.index.get(hot) : -1;
  const youIdx = you != null ? d.index.get(you) : -1;
  const paths = [];
  const add = (slot, px, py) => { const p = paths[slot] || (paths[slot] = new Path2D()); p.moveTo(px + r, py); p.arc(px, py, r, 0, TAU); };
  for (let i = 0; i < d.n; i++) {
    const px = (d.x[i] - v.x) * v.s, py = (d.y[i] - v.y) * v.s;
    if (px < -r || py < -r || px > w + r || py > h + r) continue;
    const who = d.c[i];
    if (who === hotIdx) add(BANDS, px, py);
    else if (who === youIdx) add(BANDS + 1, px, py);
    else if (litIdx.has(who)) add(Math.min(BANDS - 1, Math.floor((d.x[i] / MAP_W) * BANDS)), px, py);
    else add(BANDS + 2, px, py);
  }
  if (paths[BANDS + 2]) { ctx.fillStyle = `rgba(255, 255, 255, ${dim})`; ctx.fill(paths[BANDS + 2]); }
  for (let b = 0; b < BANDS; b++) {
    if (!paths[b]) continue;
    ctx.fillStyle = `rgba(${hueAt((b + 0.5) / BANDS).join(', ')}, ${glow})`;
    ctx.fill(paths[b]);
  }
  if (paths[BANDS + 1]) { ctx.fillStyle = 'rgba(255, 255, 255, .85)'; ctx.fill(paths[BANDS + 1]); }
  if (paths[BANDS]) { ctx.fillStyle = '#fff'; ctx.fill(paths[BANDS]); }
  return v;
}

/** The country under a point of a painted map (canvas pixels), or null for the sea. */
function hit(v, px, py) {
  const d = load();
  const mx = px / v.s + v.x, my = py / v.s + v.y;
  const row = Math.round(my / HEX - 0.5);
  let best = null, bestD = 1.5;
  for (let r = row - 1; r <= row + 1; r++) {
    if (r < 0 || r >= MAP.rows) continue;
    const col = Math.round(mx - 0.5 - (r % 2) * 0.5);
    for (let c = col - 1; c <= col + 1; c++) {
      if (c < 0 || c >= MAP.cols) continue;
      const who = d.grid[r * MAP.cols + c];
      if (who < 0) continue;
      const dist = Math.hypot(c + 0.5 + (r % 2) * 0.5 - mx, (r + 0.5) * HEX - my);
      if (dist < bestD) { bestD = dist; best = d.codes[who]; }
    }
  }
  return best;
}

/** A country's own dotted shape, filling `canvas`, in its colour (or `colour`). */
function paintShape(canvas, code, colour = null) {
  const box2 = fitCanvas(canvas);
  if (!box2) return;
  const { ctx, w, h } = box2;
  if (code === GLOBAL || !COUNTRY[code]) {
    paint(canvas, { lit: new Set(Object.keys(COUNTRY)), size: 0.34, glow: 0.95 });
    return;
  }
  const [, , , , cols, rows, b64] = COUNTRY[code];
  const bits = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const step = Math.min((w * 0.84) / (cols + 0.5), (h * 0.84) / (rows * HEX + 0.2));
  const ox = (w - (cols + 0.5) * step) / 2, oy = (h - rows * HEX * step) / 2;
  const r = step * 0.36;
  const p = new Path2D();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!(bits[i >> 3] >> (i & 7) & 1)) continue;
      const px = ox + (x + 0.5 + (y % 2) * 0.5) * step, py = oy + (y + 0.5) * HEX * step;
      p.moveTo(px + r, py);
      p.arc(px, py, r, 0, TAU);
    }
  }
  const c = colour || colourOf(code);
  // A soft light behind the shape, drawn once with the picture: a blur (or a CSS filter, redrawn on
  // every frame of a scroll) costs a phone far more for the same look.
  const halo = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.5);
  halo.addColorStop(0, `rgba(${c}, .28)`);
  halo.addColorStop(1, `rgba(${c}, 0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#fff');
  g.addColorStop(0.55, `rgb(${c})`);
  g.addColorStop(1, `rgba(${c}, .75)`);
  ctx.fillStyle = g;
  ctx.fill(p);
}

/** Draws each [data-shape] canvas under `root` as it comes near the screen (a page can have 70 of
 * them), and again if its size changes. */
function drawShapes(root) {
  const canvases = [...root.querySelectorAll('canvas[data-shape]')];
  if (!canvases.length) return;
  const draw = (c) => {
    const size = `${c.clientWidth}x${c.clientHeight}`;
    if (c.dataset.drawn === size) return;
    c.dataset.drawn = size;
    paintShape(c, c.dataset.shape);
  };
  if (!('IntersectionObserver' in window)) { canvases.forEach(draw); return; }
  const resized = 'ResizeObserver' in window
    ? new ResizeObserver((entries) => entries.forEach((e) => (e.target.isConnected ? draw(e.target) : resized.unobserve(e.target)))) : null;
  const near = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    near.unobserve(e.target);
    draw(e.target);
    resized?.observe(e.target);
  }), { rootMargin: '400px' });
  canvases.forEach((c) => near.observe(c));
}

/** Calls `fn` whenever `el` changes size, until it leaves the page. */
function onResize(el, fn) {
  if (!('ResizeObserver' in window)) { fn(); window.addEventListener('resize', fn); return; }
  let last = '';
  const ro = new ResizeObserver(() => {
    if (!el.isConnected) { ro.disconnect(); return; }
    const size = `${el.clientWidth}x${el.clientHeight}`;
    if (size !== last) { last = size; fn(); }
  });
  ro.observe(el);
}

// ------------------------------------------------------------------ playing
const contextOf = (code) => ({ label: code === GLOBAL ? 'Top songs worldwide' : `Trending in ${nameOf(code)}`, href: `#/explore/${code}` });

/** Plays a country's chart from the top. */
export async function playCountry(code) {
  let c;
  try { c = await countryData(code); } catch (e) { toast(`Couldn’t reach ${nameOf(code)}: ${e.message}`); return null; }
  if (!c.tracks.length) { toast(`${nameOf(code)} has no chart today`); return null; }
  if (player.shuffle) player.toggleShuffle();
  player.playList(c.tracks, 0, contextOf(code));
  return c;
}

/** A country you haven't been to (and aren't in), at random. */
function somewhere(countries, not = null) {
  const been = passport();
  const fresh = countries.filter((c) => c !== not && !been[c]);
  const pool = fresh.length ? fresh : countries.filter((c) => c !== not);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ------------------------------------------------------------------ pieces
const GRADIENTS = [
  ['#ff5f6d', '#ffc371'], ['#4f6bff', '#2fc8ff'], ['#c45cff', '#ff6fae'], ['#0fb38a', '#7ff0b4'], ['#f7971e', '#ffd200'], ['#7f3cff', '#4a2bd6'],
  ['#00a6d6', '#4f6bff'], ['#ee0979', '#ff6a00'], ['#ff4e50', '#f9a03f'], ['#8f6bff', '#eaafc8'], ['#11998e', '#2fc8ff'], ['#e94057', '#8a2387'],
];
function gradientOf(title) {
  let h = 0;
  for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

function countryTile(code, been) {
  const sub = code === GLOBAL ? 'Top songs worldwide' : localTime(code);
  return `<a class="cty" href="#/explore/${code}" data-region="${code === GLOBAL ? '' : regionOf(code)}" style="--c:${colourOf(code)}">
    <canvas class="cty-shape" data-shape="${code}" aria-hidden="true"></canvas>
    <div class="cty-name">${esc(nameOf(code))}</div><div class="cty-sub">${esc(sub)}</div>
    ${been ? `<span class="cty-been" title="In your passport">${icon('check')}</span>` : ''}
    <button class="hover-play" data-play-country="${code}" aria-label="Play ${esc(nameOf(code))}">${icon('play')}</button></a>`;
}

function genreTile(g, small = false) {
  const [a, b] = gradientOf(g.title);
  return `<a class="gtile${small ? ' sm' : ''}" href="#/genre/${enc(g.params)}" style="--g1:${a};--g2:${b}"><span>${esc(g.title)}</span></a>`;
}

function covers(urls, n = 3) {
  return (urls || []).slice(0, n).map((u, i) => `<img class="fan f${i}" src="${img(u, 240)}" alt="" decoding="async">`).join('');
}

function todayCard(t) {
  if (!t?.code) return '';
  return `<a class="today" href="#/explore/${t.code}" style="--c:${colourOf(t.code)}">
    <canvas class="today-shape" data-shape="${t.code}" aria-hidden="true"></canvas>
    <div class="today-text"><div class="ex-kicker">${icon('sparkle')}Today’s stop</div><h2>${esc(nameOf(t.code))}</h2>
      <p>${esc([localTime(t.code), 'Trending 20'].filter(Boolean).join(' · '))}</p></div>
    <div class="today-covers">${covers(t.covers)}</div>
    <button class="big-play" data-play-country="${t.code}">${icon('play')}<span>Play</span></button></a>`;
}

function passportBlock(countries) {
  const been = passport();
  const codes = Object.keys(been).filter((c) => COUNTRY[c]).sort((a, b) => been[b] - been[a]);
  const total = countries.length;
  const stamps = codes.slice(0, 24).map((c, i) => `<a class="stamp" href="#/explore/${c}" style="--c:${colourOf(c)};--tilt:${((i * 37) % 17) - 8}deg" title="${esc(nameOf(c))}">
      <canvas data-shape="${c}" aria-hidden="true"></canvas><b>${c}</b></a>`).join('');
  const ghosts = codes.length ? '' : '<span class="stamp ghost"></span>'.repeat(4);
  const line = codes.length
    ? `You’ve played music from <b>${codes.length}</b> of ${total} countries.${codes.length >= total ? ' Every one of them.' : ''}`
    : 'Every country you play gets a stamp. How many can you collect?';
  return `<section class="section passport"><div class="section-head"><h2>Your passport</h2></div>
    <div class="pass-card"><div class="pass-ring" style="--p:${Math.min(1, codes.length / Math.max(1, total))}"><b>${codes.length}</b><small>of ${total}</small></div>
      <div class="pass-body"><p>${line}</p><div class="stamps">${stamps}${ghosts}</div></div></div></section>`;
}

// ------------------------------------------------------------------ the map on a page
/**
 * Makes `stage` (a .ex-map holding a canvas) a live map: glowing countries, beacons pulsing on a
 * few of them, the pointer lighting up the country under it (with its name and time), and a tap
 * opening that country. Returns {fly(code)} for "Take me somewhere".
 */
function liveMap(stage, { lit, today, you, beacons = 6, interactive = true, cover = false, shift = 0 }) {
  const canvas = stage.querySelector('canvas');
  const marks = stage.querySelector('.ex-beacons');
  const tip = stage.parentElement.parentElement.querySelector('.ex-tip');
  let view = null;
  let hot = null;
  let queued = false;
  const chosen = [today, ...[...lit].filter((c) => c !== today).sort(() => Math.random() - 0.5)].filter(Boolean).slice(0, beacons);
  const draw = () => {
    queued = false;
    view = paint(canvas, { lit, hot, you, cover, shift });
    if (!view || !marks) return;
    marks.innerHTML = chosen.map((c, i) => {
      const [mx, my] = middle(c);
      return `<i style="left:${((mx - view.x) * view.s).toFixed(1)}px;top:${((my - view.y) * view.s).toFixed(1)}px;--c:${colourOf(c)};--d:${(i * 0.7).toFixed(1)}s"></i>`;
    }).join('') + (you ? (() => { const [mx, my] = middle(you); return `<i class="you" style="left:${((mx - view.x) * view.s).toFixed(1)}px;top:${((my - view.y) * view.s).toFixed(1)}px"></i>`; })() : '');
  };
  const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
  onResize(canvas, draw);
  if (!interactive) return { draw };

  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !view) return;
    const [x, y] = at(e);
    const c = hit(view, x, y);
    const over = c && lit.has(c) ? c : null;
    canvas.style.cursor = over ? 'pointer' : '';
    if (over !== hot) { hot = over; redraw(); }
    if (!tip) return;
    if (!over) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${esc(nameOf(over))}</b><span>${esc(localTime(over) || 'Trending now')}</span>`;
    tip.hidden = false;
    const sr = stage.parentElement.parentElement.getBoundingClientRect();
    tip.style.transform = `translate(${Math.round(e.clientX - sr.left)}px, ${Math.round(e.clientY - sr.top)}px)`;
  });
  canvas.addEventListener('pointerleave', () => { if (hot) { hot = null; redraw(); } if (tip) tip.hidden = true; canvas.style.cursor = ''; });
  canvas.addEventListener('click', (e) => {
    if (!view) return;
    const c = hit(view, ...at(e));
    if (c && lit.has(c)) go(`#/explore/${c}`);
  });

  /** A line flies from your country to `code`, then lands with a ripple. Resolves when it lands. */
  const fly = (code) => new Promise((resolve) => {
    const svg = stage.querySelector('.ex-flight');
    if (!svg || !view || calm()) { resolve(); return; }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const [ax, ay] = middle(you || today || code), [bx, by] = middle(code);
    const p = (mx, my) => [(mx - view.x) * view.s, (my - view.y) * view.s];
    const [x1, y1] = p(ax, ay), [x2, y2] = p(bx, by);
    const lift = Math.max(40, Math.hypot(x2 - x1, y2 - y1) * 0.38);
    const cx = (x1 + x2) / 2, cy = Math.max(8, Math.min(y1, y2) - lift);
    const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<defs><linearGradient id="exfl" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="rgb(${colourOf(code)})"/></linearGradient></defs>
      <path d="${d}" fill="none" stroke="url(#exfl)" stroke-width="2.4" stroke-linecap="round"/>`;
    const path = svg.querySelector('path');
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    const flight = path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1150, easing: 'cubic-bezier(.5, 0, .2, 1)', fill: 'forwards' });
    const plane = document.createElement('span');
    plane.className = 'ex-plane';
    plane.style.offsetPath = `path('${d}')`;
    stage.appendChild(plane);
    plane.animate([{ offsetDistance: '0%' }, { offsetDistance: '100%' }], { duration: 1150, easing: 'cubic-bezier(.5, 0, .2, 1)', fill: 'forwards' });
    flight.onfinish = () => {
      plane.remove();
      const land = document.createElement('i');
      land.className = 'land';
      land.style.cssText = `left:${x2.toFixed(1)}px;top:${y2.toFixed(1)}px;--c:${colourOf(code)}`;
      marks?.appendChild(land);
      hot = code;
      draw();
      setTimeout(resolve, 380);
    };
  });
  return { draw, fly };
}

// ------------------------------------------------------------------ Explore
export async function explorePage() {
  const w = await world();
  const lit = new Set(w.countries);
  const been = passport();
  const you = homeCountry();
  const sorted = [...w.countries].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const html = `<div class="explore">
    <div class="ex-head"><div><div class="ex-kicker">${icon('globe')}Explore</div><h1>What the world is playing</h1>
      <p>Today’s charts from ${w.countries.length} countries. Tap anywhere on the map, or let OpenWave choose.</p></div>
      <button class="ex-go" data-ex-go>${icon('plane')}<span>Take me somewhere</span></button></div>
    <div class="ex-stage"><div class="ex-scroll"><div class="ex-map" role="img" aria-label="World map: countries with a chart today glow">
      <canvas></canvas><div class="ex-beacons" data-decor aria-hidden="true"></div><svg class="ex-flight" data-decor aria-hidden="true"></svg></div></div>
      <div class="ex-tip" hidden></div></div>
    ${todayCard(w.today)}
    ${passportBlock(w.countries)}
    <section class="section"><div class="section-head"><h2>Every country</h2></div>
      <div class="chips ex-regions"><button class="chip on" data-region-pick="">All</button>${REGIONS.filter(([r]) => w.countries.some((c) => regionOf(c) === r))
    .map(([r, label]) => `<button class="chip" data-region-pick="${r}">${label}</button>`).join('')}</div>
      <div class="cty-grid">${countryTile(GLOBAL, false)}${sorted.map((c) => countryTile(c, !!been[c])).join('')}</div></section>
    ${w.genres.length ? `<section class="section"><div class="section-head"><h2>Genres</h2></div><div class="gtile-grid">${w.genres.map((g) => genreTile(g)).join('')}</div></section>` : ''}
    ${w.moods.length ? `<section class="section"><div class="section-head"><h2>Moods and moments</h2></div><div class="gtile-grid moods">${w.moods.map((g) => genreTile(g, true)).join('')}</div></section>` : ''}
  </div>`;
  return { html, mount: (view) => mountExplore(view, w, lit, you) };
}

function mountExplore(view, w, lit, you) {
  const stage = view.querySelector('.ex-map');
  const map = liveMap(stage, { lit, today: w.today?.code, you });
  // On a phone the map is wider than the screen: start with your part of the world in view.
  const scroller = view.querySelector('.ex-scroll');
  requestAnimationFrame(() => {
    if (scroller.scrollWidth <= scroller.clientWidth + 2) return;
    const [mx] = middle(you || w.today?.code || 'IN');
    scroller.scrollLeft = (mx / MAP_W) * scroller.scrollWidth - scroller.clientWidth / 2;
  });
  drawShapes(view);
  wirePlay(view);
  view.querySelector('.ex-regions')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-region-pick]');
    if (!b) return;
    const r = b.dataset.regionPick;
    view.querySelectorAll('[data-region-pick]').forEach((x) => x.classList.toggle('on', x === b));
    view.querySelectorAll('.cty').forEach((t) => { t.hidden = !!r && t.dataset.region !== r; });
  });
  const goBtn = view.querySelector('[data-ex-go]');
  goBtn?.addEventListener('click', async () => {
    if (goBtn.disabled) return;
    goBtn.disabled = true;
    const code = somewhere(w.countries);
    goBtn.querySelector('span').textContent = `Flying to ${nameOf(code)}…`;
    if (scroller.scrollWidth > scroller.clientWidth + 2) {
      const [a] = middle(you || code), [b] = middle(code);
      scroller.scrollTo({ left: (((a + b) / 2) / MAP_W) * scroller.scrollWidth - scroller.clientWidth / 2, behavior: calm() ? 'auto' : 'smooth' });
    }
    const playing = playCountry(code);
    await map.fly(code);
    if (await playing) go(`#/explore/${code}`);
    else { goBtn.disabled = false; goBtn.querySelector('span').textContent = 'Take me somewhere'; }
  });
}

/** The play buttons on country tiles and today's card play that country without opening it. */
function wirePlay(view) {
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-play-country]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    playCountry(b.dataset.playCountry);
  });
}

// ------------------------------------------------------------------ a country
export async function countryPage({ code }) {
  if (code !== GLOBAL && !COUNTRY[code]) throw new Error('OpenWave doesn’t know that country');
  const [c, w] = await Promise.all([countryData(code), world().catch(() => null)]);
  const name = nameOf(code);
  const context = contextOf(code);
  const time = code === GLOBAL ? '' : localTime(code);
  const meta = [time && `It’s ${esc(time)}`, `${c.tracks.length} songs`, 'New every day'].filter(Boolean).join(' • ');
  const next = `<button class="pill-btn" data-ex-next>${icon('plane')}<span>Next stop</span></button>`;
  let html = `<div class="hero place" style="--c:${colourOf(code)}"><canvas class="place-map" data-decor aria-hidden="true"></canvas><div class="place-ping" data-decor aria-hidden="true"></div>
      <div class="info"><div class="kind">${code === GLOBAL ? 'The world’s top songs' : 'Trending in'}</div><h1>${esc(name)}</h1><div class="meta">${meta}</div></div></div>`
    + actions({ play: 'play-collection', tracks: c.tracks, extra: next })
    + (c.tracks.length ? trackList(c.tracks, { album: true, context }) : empty('globe', 'No chart today', 'YouTube hasn’t published this country’s chart today. Try another stop.'));
  if (c.artists.length) {
    html += section(code === GLOBAL ? 'Top artists worldwide' : `Top artists in ${name}`, c.artists.map((a, i) => `<a class="card artist ranked" href="#/artist/${enc(a.id)}">
        <div class="art"><img loading="lazy" decoding="async" src="${img(a.thumbnail, 300)}" alt=""><span class="rank">${esc(a.rank || i + 1)}</span></div>
        <div class="title">${esc(a.title)}</div><div class="sub">${a.trend === 'up' ? '<i class="trend up"></i>' : a.trend === 'down' ? '<i class="trend down"></i>' : ''}${esc(a.subtitle)}</div></a>`).join(''));
  }
  if (c.charts.length) html += section('More charts', cards(c.charts));
  const others = (w?.countries || []).filter((x) => x !== code);
  if (others.length) {
    const near = others.filter((x) => regionOf(x) === regionOf(code)).sort(() => Math.random() - 0.5);
    const far = others.filter((x) => regionOf(x) !== regionOf(code)).sort(() => Math.random() - 0.5);
    const been = passport();
    html += section('Keep exploring', [...near.slice(0, 5), ...far].slice(0, 10).map((x) => countryTile(x, !!been[x])).join(''), { cls: 'shelf cty-shelf' });
  }
  return {
    tintColor: colourOf(code),
    collection: { tracks: c.tracks, context, kind: 'playlist', card: c.playlistId ? { id: c.playlistId, title: context.label, subtitle: 'Chart', thumbnail: c.thumbnail } : null },
    html,
    mount: (view) => {
      const hero = view.querySelector('.hero.place');
      const canvas = hero.querySelector('.place-map');
      const ping = hero.querySelector('.place-ping');
      onResize(hero, () => {
        const wide = hero.clientWidth > 720;
        const v = paint(canvas, {
          lit: w ? new Set(w.countries) : new Set(), hot: code === GLOBAL ? null : code, halo: code === GLOBAL ? null : code,
          view: focusView(code, canvas.clientWidth, canvas.clientHeight, wide ? 0.7 : 0.5, wide ? 0.46 : 0.34), dim: 0.16, glow: 0.42,
        });
        if (v && code !== GLOBAL) {
          const [mx, my] = middle(code);
          ping.style.transform = `translate(${((mx - v.x) * v.s).toFixed(1)}px, ${((my - v.y) * v.s).toFixed(1)}px)`;
        }
      });
      drawShapes(view);
      wirePlay(view);
      view.querySelector('[data-ex-next]')?.addEventListener('click', async (e) => {
        const b = e.currentTarget;
        if (b.disabled || !others.length) return;
        b.disabled = true;
        const to = somewhere(others, code);
        b.querySelector('span').textContent = `Flying to ${nameOf(to)}…`;
        if (await playCountry(to)) go(`#/explore/${to}`);
        else { b.disabled = false; b.querySelector('span').textContent = 'Next stop'; }
      });
    },
  };
}

// ------------------------------------------------------------------ a genre or mood
export async function genrePage({ params }) {
  const g = await genreData(params);
  const title = g.title || 'Genre';
  const [a, b] = gradientOf(title);
  const songs = g.sections.find((s) => s.kind === 'songs')?.items || [];
  const context = { label: title, href: `#/genre/${enc(params)}` };
  const count = g.sections.reduce((n, s) => n + s.items.length, 0);
  let html = `<div class="hero genre-hero" style="--g1:${a};--g2:${b}"><div class="cover gcover"><span>${esc(title)}</span></div>
      <div class="info"><div class="kind">Explore</div><h1>${esc(title)}</h1><div class="meta">${songs.length ? `${songs.length} songs • ` : ''}${count - songs.length} playlists and albums</div></div></div>`;
  if (songs.length) html += actions({ play: 'play-collection', tracks: songs });
  for (const s of g.sections) {
    if (s.kind === 'songs') html += section(s.title || 'Songs', trackList(s.items.slice(0, 20), { album: true, context: { ...context, label: `${title}: ${s.title || 'Songs'}` } }), { cls: '' });
    else html += section(s.title || 'Playlists', cards(s.items));
  }
  if (!g.sections.length) html += empty('globe', 'Nothing here right now', 'YouTube didn’t send anything for this one. Try another genre.');
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
  return { tintColor: hex(a), collection: { tracks: songs, context, kind: 'genre' }, html };
}

// ------------------------------------------------------------------ Search: the way in
const ROTATE_EVERY = 2600;

/** The Explore card at the top of Search: a live world map, today's covers, and a line naming the
 * countries with charts, one after another. */
export function searchCard(w) {
  const n = w?.countries?.length || 0;
  const first = w?.today?.code || w?.countries?.[0];
  return `<a class="ex-card" href="#/explore" aria-label="Explore world music">
    <div class="ex-map ex-card-map"><canvas></canvas><div class="ex-beacons" data-decor aria-hidden="true"></div></div>
    <div class="ex-card-text"><div class="ex-kicker">${icon('globe')}Explore</div><h2>Explore world music</h2>
      <p>${first ? `Trending now in <b class="ex-rot">${esc(nameOf(first))}</b>${n > 1 ? `, and ${n - 1} more countries` : ''}` : 'What every country is playing today'}</p></div>
    <div class="ex-card-covers" aria-hidden="true">${covers(w?.today?.covers)}</div>
    <span class="ex-card-go" aria-hidden="true">${icon('forward')}</span></a>`;
}

export function moodPills(w) {
  if (!w?.moods?.length) return '';
  return `<div class="section-head"><h2>Moods and moments</h2><a href="#/explore">Explore</a></div>
    <div class="mood-pills">${w.moods.map((m) => { const [a, b] = gradientOf(m.title); return `<a class="mood-pill" href="#/genre/${enc(m.params)}" style="--g1:${a};--g2:${b}">${esc(m.title)}</a>`; }).join('')}</div>`;
}

export function mountSearchCard(view, w) {
  const card = view.querySelector('.ex-card');
  if (!card) return;
  const lit = new Set(w?.countries || []);
  liveMap(card.querySelector('.ex-map'), { lit, today: w?.today?.code, you: null, beacons: 4, interactive: false, cover: true, shift: 6 });
  const rot = card.querySelector('.ex-rot');
  if (!rot || lit.size < 2) return;
  const names = [w.today?.code, ...[...lit].filter((c) => c !== w.today?.code).sort(() => Math.random() - 0.5)].filter(Boolean);
  let i = 0;
  let turns = 0;
  const timer = setInterval(() => {
    // It names countries for a minute or so, then rests, like the beacons.
    if (!rot.isConnected || ++turns > 24) { clearInterval(timer); return; }
    if (document.hidden) return;
    i = (i + 1) % names.length;
    if (calm()) { rot.textContent = nameOf(names[i]); return; }
    rot.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 220, easing: 'ease-in' }).onfinish = () => {
      rot.textContent = nameOf(names[i]);
      rot.style.setProperty('--c', colourOf(names[i]));
      rot.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    };
  }, ROTATE_EVERY);
}

// ------------------------------------------------------------------ Home: today's country
export function todayShelf(w) {
  const t = w?.today;
  if (!t?.code || !t.tracks?.length) return '';
  const name = nameOf(t.code);
  const lead = `<a class="card cty-card" href="#/explore/${t.code}" style="--c:${colourOf(t.code)}"><div class="art"><canvas data-shape="${t.code}" aria-hidden="true"></canvas>
      <span class="cty-card-label">${esc(name)}</span><button class="hover-play" data-play-country="${t.code}" aria-label="Play ${esc(name)}">${icon('play')}</button></div>
      <div class="title">Trending in ${esc(name)}</div><div class="sub">${esc(localTime(t.code) || 'Today’s stop')}</div></a>`;
  return section(`Today in ${name}`, lead + trackCards(t.tracks, { context: contextOf(t.code) }), { more: '<a href="#/explore">Explore</a>' });
}

export function mountToday(view) {
  const shelf = view.querySelector('.cty-card')?.closest('.section');
  if (!shelf) return;
  drawShapes(shelf);
  wirePlay(shelf);
}
