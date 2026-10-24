// Offers a one-tap update when a newer OpenWave is out. The engine picks the right file for this
// device (Windows, Linux, Mac app or Android); Docker and source installs update their own way.
// The Mac app also asks natively, so it gets no banner, only the line in Settings → About.
import { esc } from './ui.js';

const DISMISSED = 'openwave.updateDismissed';

const HOW = {
  android: 'Tap Update, then open the download and tap Update. Your library stays as it is.',
  windows: 'Run the downloaded installer. Your library and settings stay as they are.',
  linux: 'Use the downloaded AppImage instead of your current one. Your library stays as it is.',
  'mac-arm64': 'Open the download and drag OpenWave into Applications. Your library stays as it is.',
  'mac-x86_64': 'Open the download and drag OpenWave into Applications. Your library stays as it is.',
};

export async function checkForUpdate(timeout = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`/api/app-update${window.OpenWaveAndroid ? '?client=android' : ''}`, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Every OpenWave app hands outside links to the system browser, which downloads the file.
export const startUpdate = (info) => { location.href = info.download; };

export const updateHint = (info) => HOW[info.device] || '';

export function initUpdates() {
  if (document.documentElement.classList.contains('native-mac-app')) return;
  setTimeout(async () => {
    const info = await checkForUpdate();
    if (!info?.available) return;
    try { if (localStorage.getItem(DISMISSED) === info.latest) return; } catch { /* storage blocked */ }
    const el = document.getElementById('update-card');
    el.innerHTML = `<div><b>OpenWave ${esc(info.latest)} is available</b><p>${esc(updateHint(info))}</p></div>
      <div class="btn-row"><button class="btn" data-update="later">Later</button><button class="btn primary" data-update="go">Update</button></div>`;
    el.hidden = false;
    el.onclick = (e) => {
      const b = e.target.closest('[data-update]');
      if (!b) return;
      if (b.dataset.update === 'go') startUpdate(info);
      try { localStorage.setItem(DISMISSED, info.latest); } catch { /* storage blocked */ }
      el.hidden = true;
    };
  }, 8000);
}
