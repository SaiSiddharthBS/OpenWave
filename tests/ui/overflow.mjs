// The check both UI tests run on every screen: does anything (a box or a run of text) reach past the
// left or right edge of the window, where nobody can see it? Content inside a scrolling area, or cut
// off with an ellipsis, is fine. Evaluate it in the page; it returns what it found.
export const CHECK = `(() => {
  const W = innerWidth, found = [];
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const path = (el) => { const p = []; for (let e = el; e && e !== document.body && p.length < 5; e = e.parentElement) p.unshift(name(e)); return p.join(' > '); };
  // .rv: a piece of the page waiting to animate in as it's scrolled to; it counts, it's just not faded in yet.
  // [data-decor]: colour behind the app, drawn past the window's edge on purpose.
  const shown = (el) => { if (el.closest('[data-decor]')) return false; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || (+s.opacity === 0 && !e.classList.contains('rv'))) return false; if (e.hidden) return false; } return true; };
  // A text run is clipped by its own element too; a box only by its ancestors.
  const visible = (el, r, text) => {
    let left = r.left, right = r.right;
    for (let e = text ? el : el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      const scrolls = /(auto|scroll)/.test(s.overflowX);
      const dots = s.textOverflow === 'ellipsis' && /(hidden|clip)/.test(s.overflowX);
      if (scrolls || dots) { const c = e.getBoundingClientRect(); left = Math.max(left, c.left); right = Math.min(right, c.right); }
      if (s.position === 'fixed') break;
    }
    return { left, right };
  };
  const seen = new Set();
  const report = (el, r, what) => {
    if (r.width < 1 || r.height < 1) return;
    const v = visible(el, r, what === 'text');
    if (v.right - v.left < 1) return;
    if (v.right > W + 1 || v.left < -1) {
      if ([...seen].some((s) => s.contains(el))) return;
      seen.add(el);
      found.push({ what, at: path(el), left: Math.round(v.left), right: Math.round(v.right), text: (el.textContent || '').trim().slice(0, 60) });
    }
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (!el.getClientRects().length || !shown(el)) continue;
    report(el, el.getBoundingClientRect(), 'box');
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    if (!t.textContent.trim() || !shown(t.parentElement)) continue;
    const range = document.createRange(); range.selectNodeContents(t);
    for (const r of range.getClientRects()) report(t.parentElement, r, 'text');
  }
  const doc = document.scrollingElement;
  if (doc.scrollWidth > W + 1) found.unshift({ what: 'page', at: 'the whole page scrolls sideways', left: 0, right: doc.scrollWidth, text: '' });
  return found;
})()`;

// Pieces of a page wait (.rv) until they scroll into view, then animate in. None may be left waiting
// on screen. Returns how many are.
export const STUCK = `[...document.querySelectorAll('#view .rv')].filter((el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight * 0.85;
}).length`;
