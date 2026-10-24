// Touch gestures that make the phone app feel native: swipe the player down to close it, swipe the
// artwork or the mini player sideways to change songs, long-press a song for its menu. Also fades
// images in as they load.

import { player } from './player.js';
import { haptic } from './native.js';

const touchy = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

// A swipe or long-press shouldn't also count as a tap on whatever is under the finger. Only the
// click from the same touch is swallowed: browsers don't always send one, so a lingering
// "ignore the next click" would eat the user's next real tap.
let swallowUntil = 0;
let swallowOnLift = false;
document.addEventListener('click', (e) => {
  if (performance.now() < swallowUntil) { e.stopPropagation(); e.preventDefault(); }
}, true);
document.addEventListener('pointerup', () => {
  if (swallowOnLift) { swallowOnLift = false; swallowUntil = performance.now() + 350; }
}, true);

/**
 * Tracks one finger on `el`. `onMove(dx, dy)` runs while it moves; `onEnd(dx, dy, vx, vy)` when it
 * lifts. The gesture locks to the first clear direction, so vertical scrolling still works.
 */
function drag(el, { axis, onStart, onMove, onEnd }) {
  let start = null;
  let locked = null;
  el.addEventListener('pointerdown', (e) => {
    if (!touchy(e) || e.target.closest('input, button, .range, [data-no-swipe]')) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
    locked = null;
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!locked) {
      if (Math.hypot(dx, dy) < 8) return;
      locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (locked !== axis) { start = null; return; }
      try { el.setPointerCapture(e.pointerId); } catch { /* the finger already lifted */ }
      onStart?.();
    }
    onMove(dx, dy);
  });
  const finish = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = Math.max(1, performance.now() - start.t);
    const was = locked;
    start = null;
    locked = null;
    if (was === axis) {
      swallowUntil = performance.now() + 350;
      onEnd(dx, dy, dx / dt, dy / dt);
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', (e) => { if (locked === axis) finish(e); start = null; locked = null; });
}

/** Swipe the full-screen player down to close it. */
function swipeDownToClose(np, close) {
  const body = np.querySelector('.np-head');
  const stage = np.querySelector('.np-stage');
  for (const el of [body, stage]) {
    drag(el, {
      axis: 'y',
      onStart: () => { np.style.transition = 'none'; },
      onMove: (dx, dy) => { np.style.transform = `translateY(${Math.max(0, dy)}px)`; },
      onEnd: (dx, dy, vx, vy) => {
        np.style.transition = '';
        if (dy > 120 || vy > 0.6) { haptic('light'); close({ from: Math.max(0, dy) }); } else np.style.transform = '';
      },
    });
  }
}

/** Swipe sideways on an element to skip songs; `target` follows the finger. */
function swipeToSkip(el, target) {
  drag(el, {
    axis: 'x',
    onStart: () => { target.style.transition = 'none'; },
    onMove: (dx) => { target.style.transform = `translateX(${dx}px)`; target.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 400)); },
    onEnd: (dx, dy, vx) => {
      const go = Math.abs(dx) > 80 || Math.abs(vx) > 0.5;
      target.style.transition = 'transform .22s var(--ease), opacity .22s';
      if (!go) { target.style.transform = ''; target.style.opacity = ''; return; }
      haptic('light');
      const out = dx < 0 ? -1 : 1;
      target.style.transform = `translateX(${out * 110}%)`;
      target.style.opacity = '0';
      setTimeout(() => {
        if (out < 0) player.next(); else player.prev();
        target.style.transition = 'none';
        target.style.transform = `translateX(${-out * 40}px)`;
        requestAnimationFrame(() => {
          target.style.transition = 'transform .28s var(--ease), opacity .28s';
          target.style.transform = '';
          target.style.opacity = '';
        });
      }, 180);
    },
  });
}

/** Long-press a song (or card) to open its menu, like other music apps. */
function longPressMenus() {
  let timer = null;
  let origin = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener('pointerdown', (e) => {
    if (!touchy(e)) return;
    const row = e.target.closest('[data-list][data-i]');
    const menuBtn = row?.querySelector('[data-menu]');
    if (!menuBtn) return;
    origin = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      haptic('long');
      row.classList.add('pressed');
      setTimeout(() => row.classList.remove('pressed'), 250);
      menuBtn.click();
      swallowOnLift = true; // the finger lifting shouldn't then play the song
    }, 480);
  });
  document.addEventListener('pointermove', (e) => { if (timer && origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 10) cancel(); });
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-list][data-i]')) e.preventDefault(); });
}

/** Images fade in when they arrive instead of popping in. */
function fadeInImages() {
  const done = (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); };
  document.addEventListener('load', done, true);
  document.addEventListener('error', done, true);
}

export function initGestures({ np, closeNP }) {
  fadeInImages();
  if (!matchMedia('(pointer: coarse)').matches) return;
  swipeDownToClose(np, closeNP);
  swipeToSkip(np.querySelector('.np-stage'), np.querySelector('.np-art'));
  const bar = document.getElementById('playerbar');
  swipeToSkip(bar.querySelector('.pb-left'), bar.querySelector('.pb-left'));
  longPressMenus();
}
