// Tells people when a newer OpenWave is out. While the app is open it looks every few hours and shows
// a one-tap card; the engine picks the right file for this device (Windows, Linux, Mac app or Android),
// and Docker and source installs update their own way. It also tells the system, so the news reaches
// you when the window isn't in front. The Android app does that by itself, even when it's closed
// (UpdateCheck.kt). A phone on the iPhone web app updates itself, and is told once it has.
import { onTheComputer } from './phones.js';
import { esc, toast } from './ui.js';

const LATER = 'openwave.updateLater';     // { version, until }: "Later" was pressed
const TOLD = 'openwave.updateTold';       // the version the system was last told about
const SEEN = 'openwave.versionSeen';      // the version of the web app last opened
const LOOK_EVERY = 6 * 3600e3;
const REMIND_AFTER = 3 * 86400e3;

const mac = window.webkit?.messageHandlers?.openwave;
const android = window.OpenWaveAndroid;
const mine = (key, fallback = null) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } };

const HOW = {
  android: 'Tap Update, then open the download and tap Update. Your library stays as it is.',
  windows: 'Run the downloaded installer. Your library and settings stay as they are.',
  linux: 'Use the downloaded AppImage instead of your current one. Your library stays as it is.',
  'mac-arm64': 'OpenWave will download the update, install it and restart. Your library stays as it is.',
  'mac-x86_64': 'OpenWave will download the update, install it and restart. Your library stays as it is.',
};

export async function checkForUpdate(timeout = 8000) {
  const android = window.OpenWaveAndroid;
  // A phone using a computer's OpenWave: updates are for the computer, except the Android app's own,
  // compared with the app's version rather than the computer's.
  if (!onTheComputer() && !android) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    let version = '';
    try { version = android?.appVersion?.() || ''; } catch { /* an older app */ }
    const query = android ? `?client=android${version ? `&current=${encodeURIComponent(version)}` : ''}` : '';
    const r = await fetch(`/api/app-update${query}`, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The Mac app installs the update itself; the others hand the link to the system browser, which downloads the file.
export const startUpdate = (info) => {
  if (mac) mac.postMessage({ type: 'installUpdate' });
  else location.href = info.download;
};

export const updateHint = (info) => HOW[info.device] || '';

/** A system notification, once for each version. Android's come from the app itself. */
function tellTheSystem(info) {
  if (android || mine(TOLD) === info.latest) return;
  const title = `OpenWave ${info.latest} is available`;
  if (mac) mac.postMessage({ type: 'updateAvailable', title });
  else if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body: 'Open OpenWave to update.', icon: 'icons/logo-mark-128.png' });
    n.onclick = () => { window.focus(); n.close(); };
  } else return;
  keep(TOLD, info.latest);
}

function showCard(info) {
  const el = document.getElementById('update-card');
  el.innerHTML = `<div><b>OpenWave ${esc(info.latest)} is available</b><p>${esc(updateHint(info))}</p></div>
    <div class="btn-row"><button class="btn" data-update="later">Later</button><button class="btn primary" data-update="go">Update</button></div>`;
  el.hidden = false;
  el.onclick = (e) => {
    const b = e.target.closest('[data-update]');
    if (!b) return;
    el.hidden = true;
    if (b.dataset.update === 'go') startUpdate(info);
    else keep(LATER, { version: info.latest, until: Date.now() + REMIND_AFTER });
    // Pressing a button here is the moment to ask, so the next update can reach you outside the app.
    if (!mac && !android && window.Notification?.permission === 'default') Notification.requestPermission().catch(() => {});
  };
}

let lastLook = 0;
async function look() {
  lastLook = Date.now();
  const info = await checkForUpdate();
  if (!info?.available) return;
  tellTheSystem(info);
  const later = mine(LATER);
  if (later?.version === info.latest && Date.now() < later.until) return;
  showCard(info);
}

/** The iPhone web app is simply newer the next time it's opened, so say so. */
function welcomeNewVersion() {
  const version = document.querySelector('meta[name="openwave-version"]')?.content;
  if (!version) return;
  const seen = mine(SEEN);
  keep(SEEN, version);
  if (seen && seen !== version) setTimeout(() => toast(`OpenWave updated to ${version}`, 4000), 1500);
}

export function initUpdates() {
  welcomeNewVersion();
  setTimeout(look, 8000);
  setInterval(look, LOOK_EVERY);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastLook > LOOK_EVERY) look();
  });
}
