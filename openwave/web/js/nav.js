// Moving between the app's screens (#/home, #/library, …). Everywhere else that's a change to the
// address after "#". In iPhone and iPad Home Screen apps, Safari treats that change as leaving the
// page and can stop the music, so there the address is updated with the History API instead (not
// a navigation) and the app hears about it the same way, through "hashchange".

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Show the screen at `hash`; `replace` swaps the current entry instead of adding one. */
export function go(hash, { replace = false } = {}) {
  if (!IOS) {
    if (replace) location.replace(hash); else location.hash = hash;
    return;
  }
  if (location.hash === hash) return;
  const oldURL = location.href;
  history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
}

// Links to screens go the same way. This runs after the app's own click handlers (on the window,
// after the document), so a click they handled or swallowed (e.preventDefault) is left alone.
if (IOS) {
  window.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || a.target) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });
}
