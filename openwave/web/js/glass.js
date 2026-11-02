// The glass design's moving parts: the artwork glowing behind the app, the highlights that slide
// between tabs, pages arriving piece by piece and reacting to the scroll, the tab bar tucking away,
// and the artwork flying between the mini player and the full-screen player. The look itself is in
// css/app.css; everything here is decoration, so the app works the same without it.

import { $, $$ } from './ui.js';

const STORE = 'openwave:glass';           // "reduced" or "full"; unset decides by the device
const MOTION = 'openwave:motion';         // "full": every animation, even if the device asks for less
const systemCalm = matchMedia('(prefers-reduced-motion: reduce)');
const narrowScreen = matchMedia('(max-width: 860px)');
const touchScreen = matchMedia('(pointer: coarse)');
const SPRING = CSS.supports('animation-timing-function', 'linear(0, 1)')
  ? getComputedStyle(document.documentElement).getPropertyValue('--spring-soft').trim()
  : 'cubic-bezier(.2, .8, .2, 1)';

// ------------------------------------------------------------------ reduced motion
/** Does this device ask apps to reduce motion? */
export const motionReduced = () => systemCalm.matches;

export function fullMotion() {
  try { return localStorage.getItem(MOTION) === 'full'; } catch { return false; }
}

/** Fades instead of movement: the device asked for that, and the person hasn't chosen otherwise. */
export const calm = () => systemCalm.matches && !fullMotion();

const applyMotion = () => document.documentElement.classList.toggle('calm', calm());

export function setFullMotion(on) {
  try { if (on) localStorage.setItem(MOTION, 'full'); else localStorage.removeItem(MOTION); } catch { /* storage blocked */ }
  applyMotion();
}

applyMotion();
systemCalm.addEventListener('change', applyMotion);

// ------------------------------------------------------------------ reduced glass
function slowDevice() {
  return (navigator.deviceMemory || 8) <= 2 || (navigator.hardwareConcurrency || 8) <= 3;
}

function choice() {
  try { return localStorage.getItem(STORE); } catch { return null; }
}

export function glassReduced() {
  const c = choice();
  return c ? c === 'reduced' : slowDevice();
}

export function setGlassReduced(on) {
  try { localStorage.setItem(STORE, on ? 'reduced' : 'full'); } catch { /* storage blocked: this session only */ }
  document.documentElement.classList.toggle('lite-glass', on);
}

document.documentElement.classList.toggle('lite-glass', glassReduced());
document.documentElement.classList.toggle('android', /Android/.test(navigator.userAgent));   // see "Android" in css/app.css
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('page-hidden', document.hidden));

// ------------------------------------------------------------------ the colour behind the glass
let front = 0;
let wanted = '';

/** A tiny, heavily blurred, richer copy of a picture, to scale up behind the app. Doing the blur
 * once here, instead of asking the browser to redo it every frame, is what keeps scrolling smooth. */
function glow(picture) {
  const size = 40;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(picture, 0, 0, size, size);
  const image = ctx.getImageData(0, 0, size, size);
  const px = image.data;
  const blur = (from, step, count, radius) => {   // one pass of a box blur along a row or a column
    const line = [];
    for (let i = 0; i < count; i++) line.push(px[from + i * step]);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += line[Math.max(0, Math.min(count - 1, i + k))];
      px[from + i * step] = sum / (radius * 2 + 1);
    }
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < size; y++) blur((y * size) * 4 + c, 4, size, 4);
      for (let x = 0; x < size; x++) blur(x * 4 + c, size * 4, size, 4);
    }
  }
  for (let i = 0; i < px.length; i += 4) {        // more saturated, a little darker
    const grey = (px[i] + px[i + 1] + px[i + 2]) / 3;
    for (let c = 0; c < 3; c++) px[i + c] = Math.max(0, Math.min(255, (grey + (px[i + c] - grey) * 1.8) * .78));
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** How far the small glow layers have to be scaled to cover the window while they turn. */
function fitGlow() {
  const scale = (Math.hypot(innerWidth, innerHeight) / 100) * 1.08;
  $('#ambient').style.setProperty('--amb-s', scale.toFixed(2));
  $('#np').style.setProperty('--amb-s', scale.toFixed(2));
}

/** Glow with this picture behind the app and the full-screen player, or the brand colours without one. */
export function setAmbient(src) {
  const layers = $$('.amb');
  const url = src ? new URL(src, location.href).href : '';
  wanted = url;
  if (!url) {
    layers.forEach((l) => l.classList.remove('on'));
    $('#np').style.removeProperty('--np-art');
    return;
  }
  const paint = (picture) => {
    if (wanted !== url) return;
    let glowing;
    try { glowing = glow(picture); } catch { return; }   // a picture it isn't allowed to read: stay on the brand colours
    const next = layers[1 - front];
    next.style.backgroundImage = `url("${glowing}")`;
    next.classList.add('on');
    layers[front].classList.remove('on');
    front = 1 - front;
    $('#np').style.setProperty('--np-art', `url("${glowing}")`);
  };
  const picture = new Image();
  // Blurring takes a moment, so it waits for one with nothing on the move, like a skip's animation.
  picture.onload = () => (window.requestIdleCallback ? requestIdleCallback(() => paint(picture), { timeout: 600 }) : setTimeout(() => paint(picture), 200));
  picture.src = url;
}

// ------------------------------------------------------------------ sliding highlights
/** Slide the highlights onto the current page; call whenever the page changes. */
export function moveLenses() {
  const nav = $('.side-nav a.on');
  const navLens = $('.nav-lens');
  navLens.classList.toggle('on', !!nav);
  if (nav) navLens.style.setProperty('--y', `${nav.offsetTop}px`);
  const tabs = $$('.tabbar a');
  const i = tabs.findIndex((a) => a.classList.contains('on'));
  const tabLens = $('.tab-lens');
  tabLens.classList.toggle('on', i >= 0);
  if (i >= 0) tabLens.style.setProperty('--i', i);
  document.body.classList.remove('tabs-min');
}

// ------------------------------------------------------------------ the tab bar tucks away
function tuckTabsOnScroll(main) {
  let last = 0;
  main.addEventListener('scroll', () => {
    const y = main.scrollTop;
    const moved = y - last;
    if (Math.abs(moved) < 8) return;
    last = y;
    if (!narrowScreen.matches) return;
    const tuck = moved > 0 && y > 90 && !!$('.tabbar a.on') && !('empty' in $('#playerbar').dataset);
    document.body.classList.toggle('tabs-min', tuck);
  }, { passive: true });
  const toTop = (e) => { if (e.target.closest('a.on')) main.scrollTo({ top: 0, behavior: calm() ? 'auto' : 'smooth' }); };
  $('.tabbar').addEventListener('click', toTop);    // the tab you're on goes back to the top
  $('.side-nav').addEventListener('click', toTop);
}

// ------------------------------------------------------------------ pages arrive piece by piece
const PIECES = ['.greeting', '.lib-head', '.settings h1', '.settings h2', '.setting', '.section-head', '.shortcut', '.card', '.row', '.top-card', '.genre',
  '.stat', '.chips', '.recent', '.actions', '.hero .cover', '.hero .mosaic', '.hero .info', '.list-head', '.hours', '.empty', '.about'].join(', ');
const RISE = [{ opacity: 0, transform: 'translateY(26px) scale(.965)' }, {}];
const SLIDE = [{ opacity: 0, transform: 'translateY(16px)' }, {}];   // no scaling: text would be redrawn at the end
const FADE = [{ opacity: 0 }, {}];
const MOST_PIECES = 80;     // a long list's other songs are simply there when you reach them
const MOST_TOGETHER = 6;    // more than this, at one moment of a scroll, would hold the scroll up
const FLING = 0.9;          // pixels a millisecond: too fast to see anything arrive
let watcher = null;

function byPlace(a, b) {
  const r = a.boundingClientRect;
  const s = b.boundingClientRect;
  return Math.abs(r.top - s.top) > 8 ? r.top - s.top : r.left - s.left;
}

/** Hold back what's on a new page, then bring each piece in as it comes into view, top to bottom
 * and left to right, a moment apart. What comes into view during a scroll has to cost that scroll
 * nothing: it arrives more simply, and not at all in a fling. */
function arriveOnScroll(view) {
  watcher?.disconnect();
  watcher = null;
  if (!('IntersectionObserver' in window)) return;
  const main = $('#main');
  const still = calm();
  const pieces = $$(PIECES, view).slice(0, MOST_PIECES);
  pieces.forEach((el) => el.classList.add('rv'));
  let first = true;
  let lastY = main.scrollTop;
  let lastAt = performance.now();
  const seen = new IntersectionObserver((entries) => {
    const y = main.scrollTop;
    const now = performance.now();
    const speed = Math.abs(y - lastY) / Math.max(1, now - lastAt);
    lastY = y;
    lastAt = now;
    entries.filter((e) => e.isIntersecting).sort(byPlace).map((e) => e.target).forEach((el, i) => {
      seen.unobserve(el);
      el.classList.remove('rv');
      if (still) el.animate(FADE, { duration: 320, delay: Math.min(i, 12) * 14, easing: 'ease', fill: 'backwards' });
      else if (first && !touchScreen.matches) el.animate(RISE, { duration: 720, delay: Math.min(i, 12) * 36, easing: SPRING, fill: 'backwards' });
      else if (first) el.animate(SLIDE, { duration: 560, delay: Math.min(i, 8) * 28, easing: SPRING, fill: 'backwards' });
      else if (speed < FLING && i < MOST_TOGETHER) el.animate(SLIDE, { duration: 420, delay: i * 24, easing: SPRING, fill: 'backwards' });
    });
    if (entries.some((e) => e.isIntersecting)) first = false;
  }, { rootMargin: '0px 0px -7% 0px', threshold: 0 });
  pieces.forEach((el) => seen.observe(el));
  watcher = seen;
}

// ------------------------------------------------------------------ the page follows the scroll
// css/app.css ties these to the scroll so that they run beside it, with no work for the page. This
// is for browsers that can't do that yet.
let drawScroll = () => {};

function scrollEffects(main) {
  if (CSS.supports('animation-timeline', 'scroll()')) return;
  let frame = 0;
  let art = null;       // what moves on this page, found once for each page
  let artHeight = 1;
  let info = null;
  let title = null;
  const draw = () => {
    frame = 0;
    const y = Math.max(0, main.scrollTop);
    const still = calm();    // fade with the scroll, without moving
    if (art) {
      // The cover drifts up more slowly than the page, shrinks and fades, as if left behind.
      const gone = Math.min(1, y / (artHeight * 0.95));
      art.style.transform = gone && !still ? `translateY(${(y * 0.32).toFixed(1)}px) scale(${(1 - gone * 0.16).toFixed(3)})` : '';
      art.style.opacity = gone ? (1 - gone * gone).toFixed(3) : '';
    }
    if (info) {
      const gone = Math.min(1, y / 320);
      info.style.transform = gone && !still ? `translateY(${(y * 0.12).toFixed(1)}px)` : '';
      info.style.opacity = gone ? (1 - gone).toFixed(3) : '';
    }
    if (title) {
      // The big title sinks into the top bar.
      const gone = Math.min(1, y / 64);
      title.style.transform = gone && !still ? `scale(${(1 - gone * 0.1).toFixed(3)})` : '';
      title.style.opacity = gone ? (1 - gone).toFixed(3) : '';
    }
  };
  main.addEventListener('scroll', () => { frame ||= requestAnimationFrame(draw); }, { passive: true });
  drawScroll = (view) => {
    art = $('.hero .cover, .hero .mosaic', view);
    artHeight = art?.offsetHeight || 1;
    info = $('.hero .info', view);
    title = $('.greeting, .lib-head h1, .settings h1', view);
    draw();
  };
}

/** A new page is on screen. `fresh`: it's a page opened now, not the same one redrawn. */
export function pageShown(view, fresh) {
  if (fresh) {
    arriveOnScroll(view);
    stopGlide();
  }
  drawScroll(view);
}

// ------------------------------------------------------------------ a mouse wheel glides
// Trackpads and touch screens already scroll smoothly by themselves, and so does the Mac: this is
// for the steps of a mouse wheel on Windows and Linux, which would otherwise jump.
let stopGlide = () => {};

function glidingWheel(main) {
  if (/Mac/.test(navigator.platform) || !matchMedia('(hover: hover)').matches) return;
  let target = null;
  let frame = 0;
  stopGlide = () => { target = null; };
  const step = () => {
    frame = 0;
    if (target === null) return;
    const left = target - main.scrollTop;
    if (Math.abs(left) < 1) { main.scrollTop = target; target = null; return; }
    main.scrollTop += left > 0 ? Math.max(1, left * 0.15) : Math.min(-1, left * 0.15);
    frame = requestAnimationFrame(step);
  };
  main.addEventListener('wheel', (e) => {
    const notch = e.deltaMode === 1 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 80);
    if (!notch || e.ctrlKey || e.shiftKey || e.deltaX || calm()) { target = null; return; }
    e.preventDefault();
    const most = main.scrollHeight - main.clientHeight;
    const by = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    target = Math.max(0, Math.min(most, (target ?? main.scrollTop) + by * 1.1));
    if (!frame) frame = requestAnimationFrame(step);
  }, { passive: false });
}

// ------------------------------------------------------------------ the artwork takes flight
function miniArt() {
  const art = $('.pb-art');
  const r = art.getBoundingClientRect();
  return !('empty' in $('#playerbar').dataset) && r.width > 0 ? r : null;
}

/** Where the big artwork has to be drawn to sit exactly over the small one. */
function overMini(big, small) {
  const r = big.getBoundingClientRect();
  const dx = small.left + small.width / 2 - (r.left + r.width / 2);
  const dy = small.top + small.height / 2 - (r.top + r.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${small.width / big.offsetWidth})`;
}

let flying = [];
const land = () => { flying.forEach((a) => a.cancel()); flying = []; };

const uncover = () => document.body.classList.remove('np-cover');

/** The full-screen player has just been shown: grow it out of the mini player. */
export function npOpened(np) {
  land();
  if (calm()) { flying = [np.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease' })]; return; }
  const art = $('.np-art');
  const small = miniArt();
  const rise = { duration: 420, easing: 'cubic-bezier(.2, .8, .2, 1)' };
  flying = [np.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease' })];
  if (small) flying.push(art.animate([{ transform: overMini(art, small), borderRadius: '40px' }, {}], { duration: 640, easing: SPRING }));
  else flying.push(art.animate([{ transform: 'scale(.9)' }, {}], { duration: 520, easing: SPRING }));
  for (const el of $$('.np-head, .np-controls, .np-panel', np)) {
    flying.push(el.animate([{ opacity: 0, transform: 'translateY(16px)' }, {}], rise));
  }
  // Once it has landed, nothing has to draw the glass and the page hidden underneath it.
  const now = flying;
  Promise.all(now.map((a) => a.finished)).then(() => { if (now === flying && !np.hidden) document.body.classList.add('np-cover'); }).catch(() => {});
}

/** Shrink the full-screen player back into the mini player. Resolves when it's out of sight. */
export function npClosing(np) {
  land();
  uncover();
  if (calm()) {
    flying = [np.animate([{}, { opacity: 0 }], { duration: 200, easing: 'ease', fill: 'forwards' })];
    return Promise.race([flying[0].finished, new Promise((r) => { setTimeout(r, 300); })]).catch(() => {});
  }
  const art = $('.np-art');
  const small = miniArt();
  const time = { duration: 340, easing: 'cubic-bezier(.3, .7, .2, 1)', fill: 'forwards' };
  flying = small
    ? [art.animate([{}, { transform: overMini(art, small), borderRadius: '40px' }], time),
      np.animate([{ opacity: 1 }, { opacity: 1, offset: .55 }, { opacity: 0 }], time)]
    : [np.animate([{}, { transform: 'translateY(100%)' }], time)];
  for (const el of $$('.np-head, .np-controls, .np-panel', np)) flying.push(el.animate([{}, { opacity: 0 }], { duration: 160, fill: 'forwards' }));
  return Promise.race([flying[0].finished, new Promise((r) => { setTimeout(r, 420); })]).catch(() => {});
}

/** Done with the closing animation: put everything back for next time. */
export const npClosed = land;

export function initGlass({ main }) {
  tuckTabsOnScroll(main);
  scrollEffects(main);
  glidingWheel(main);
  fitGlow();
  window.addEventListener('resize', fitGlow);
  moveLenses();
}
