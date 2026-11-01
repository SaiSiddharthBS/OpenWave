// Settings → Phones: pair phones with this computer through OpenWave Connect (openwave/connect.py),
// see which are paired and remove them. On a paired phone (remote.js) the same place shows which
// computer it plays from, with a way to forget it.

import { esc, icon, toast, confirmDialog, openDialog } from './ui.js';
import { shareText } from './native.js';
import qrcode from './vendor/qrcode.js';
import { REMOTE, computer, forget } from './remote.js';

async function call(path, method = 'GET') {
  const r = await fetch(path, { method });
  let body = null;
  try { body = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(body?.error || body?.detail || `Request failed (${r.status})`);
  return body;
}

const MOBILE = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Is this a computer, rather than a phone or tablet that opened OpenWave on a computer by its
 * address (through Tailscale or the home Wi-Fi)? A laptop browser using a home server counts as a
 * computer: that's where people manage it. */
export function onTheComputer() {
  return !REMOTE && (!MOBILE || ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname) || !!window.OpenWaveAndroid);
}

/** A phone using OpenWave on a computer by its address: how it's connected, and where it works. */
function viaAddressSetting() {
  const host = location.hostname;
  if (host.endsWith('.ts.net')) {
    const name = esc(host.split('.')[0]);
    return `<h2>Connection</h2>
      <div class="setting"><div><b>Playing from ${name} through Tailscale</b><p>Works anywhere, at home, at work or on mobile data, while Tailscale is on on this phone. Keep ${name} on, with OpenWave open, while you listen.</p></div></div>`;
  }
  return `<h2>Connection</h2>
    <div class="setting"><div><b>Playing from your computer over your Wi-Fi</b><p>This address works at home only. To listen anywhere, including on mobile data, open OpenWave on the computer, go to Settings → Phones and choose Add a phone.</p></div></div>`;
}

/** What Settings needs to know, or null where there's nothing to show (e.g. the Android app). */
export async function phonesStatus() {
  if (REMOTE || window.OpenWaveAndroid || !onTheComputer()) return null;
  const [connect, tailscale] = await Promise.all([
    call('/api/connect').catch(() => null),
    Promise.race([call('/api/connect/tailscale'), new Promise((r) => setTimeout(r, 5000))]).catch(() => null),
  ]);
  return connect && { ...connect, tailscale: tailscale || null };
}

/** The Tailscale row: private HTTPS for your own devices, for networks that block direct connections. */
function tailscaleSetting(ts) {
  if (!ts) return '';
  const what = 'A private address for this computer that only devices signed in to your own Tailscale account can open. Works on every network, including ones that block direct connections.';
  const rows = {
    missing: [`${what} Tailscale is free: install it on this computer and on the phone.`,
      `<a class="btn" href="${esc(ts.download || 'https://tailscale.com/download')}" target="_blank" rel="noopener">Get Tailscale</a><button class="btn" data-act="tailscale-check">Check again</button>`],
    signedOut: ['Open Tailscale on this computer and sign in, then check again.', '<button class="btn" data-act="tailscale-check">Check again</button>'],
    ready: [what, '<button class="btn" data-act="tailscale-on">Turn on</button>'],
    sharing: [`On at <b>${esc(ts.url)}</b>. Phones signed in to your Tailscale account can open it from anywhere, and downloads play offline.`,
      `<button class="btn" data-act="tailscale-code">${icon('phone')} Show code</button><button class="btn" data-act="tailscale-off">Turn off</button>`],
  }[ts.state];
  if (!rows) return '';
  return `<div class="setting"><div><b>With Tailscale</b><p>${rows[0]}</p></div><div class="btn-row">${rows[1]}</div></div>`;
}

function when(seconds) {
  const d = new Date(seconds * 1000);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

/** The Settings section: on a computer, its paired phones; on a paired phone, its computer. */
export function phonesSetting(st) {
  if (!REMOTE && !onTheComputer()) return viaAddressSetting();
  if (REMOTE) {
    const c = computer();
    const name = esc(c?.name || 'your computer');
    return `<h2>Connection</h2>
      <div class="setting"><div><b>Playing from ${name}</b><p>This phone uses OpenWave on ${name}, at home or away. Keep it on, with OpenWave open, while you listen.</p></div>
        <button class="btn" data-act="connect-forget">Forget</button></div>`;
  }
  if (!st) return '';
  const intro = '<b>Use OpenWave on your phone, anywhere</b><p>Your iPhone (or any phone) plays from this computer at home, at work or on mobile data, with the same profiles and playlists. No accounts, nothing to install.</p>';
  if (!st.available) return `<h2>Phones</h2><div class="setting"><div>${intro}<p>${esc(st.reason)}</p></div></div>${tailscaleSetting(st.tailscale)}`;
  const rows = st.devices.map((d) => `<div class="setting sub"><div><b>${esc(d.label)}</b><p>${d.online ? 'Connected now' : d.seen ? `Last used ${esc(when(d.seen))}` : 'Paired'}</p></div>
      <button class="btn" data-act="connect-remove" data-id="${esc(d.id)}" data-label="${esc(d.label)}">Remove</button></div>`).join('');
  return `<h2>Phones</h2>
    <div class="setting"><div>${intro}</div><button class="btn primary" data-act="connect-pair">${icon('phone')} Add a phone</button></div>
    ${rows}
    ${tailscaleSetting(st.tailscale)}`;
}

/** Turn Tailscale sharing on or off; on success, show the code for the phone. */
export async function switchTailscale(on) {
  try {
    const r = await fetch('/api/connect/tailscale', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || body.detail || `Request failed (${r.status})`);
    if (on && body.url) await showTailscaleCode(body.url);
    else toast(on ? 'Tailscale is on' : 'Tailscale sharing is off');
  } catch (e) {
    toast(e.message, 6000);
  }
}

/** The QR code for the Tailscale address, with what to do on the phone. */
export async function showTailscaleCode(url) {
  if (!url) {
    try { url = (await call('/api/connect/tailscale')).url; } catch (e) { toast(e.message, 4000); return; }
    if (!url) return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  await openDialog(`<form method="dialog" class="pair-dialog">
      <h3>Open OpenWave through Tailscale</h3>
      <div class="pair-body">
        <div class="pair-qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'QR code for OpenWave’s Tailscale address' })}</div>
        <ol class="pair-steps">
          <li>On the phone, install <b>Tailscale</b> from the App Store and sign in with the same account as this computer.</li>
          <li>Open the <b>Camera</b>, point it at this code and tap the link.</li>
          <li>In Safari, tap <b>Share → Add to Home Screen</b>.</li>
        </ol>
      </div>
      <div class="share-link"><input type="text" readonly value="${esc(url)}" aria-label="Tailscale address">
        <button type="button" class="btn" data-copy>${icon('link')} Copy</button></div>
      <p class="pair-note">Only devices signed in to your Tailscale account can open this address. Keep this computer on, with OpenWave open, while you listen.</p>
      <div class="row-btns"><span class="spacer"></span><button class="btn primary" value="ok" data-done>Done</button></div>
    </form>`, {
    wide: true,
    onMount: (d) => {
      d.querySelector('[data-done]').focus({ preventScroll: true });
      d.querySelector('[data-copy]').onclick = () => copy(url, d.querySelector('.share-link input'));
    },
  });
}

function copy(text, input) {
  const done = () => toast('Link copied');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => { input.select(); toast('Press Copy on your keyboard to copy the link'); });
  } else {
    input.focus();
    input.select();
    try { document.execCommand('copy'); done(); } catch { toast('Select the link and copy it'); }
  }
}

/** "Add a phone": a QR code that pairs phones for 15 minutes, and news when one connects. */
export async function openPairing() {
  let p;
  try {
    p = await call('/api/connect/pair', 'POST');
  } catch (e) {
    toast(e.message, 4000);
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(p.link);
  qr.make();
  let timer = null;
  await openDialog(`<form method="dialog" class="pair-dialog">
      <h3>Add a phone</h3>
      <div class="pair-body">
        <div class="pair-qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'QR code for pairing a phone' })}</div>
        <ol class="pair-steps">
          <li>Open the <b>Camera</b> on the phone and point it at this code.</li>
          <li>Tap the link that appears.</li>
          <li>On an iPhone, add OpenWave to the Home Screen when it asks.</li>
        </ol>
      </div>
      <p class="pair-state" data-state role="status">Waiting for the phone…</p>
      <p class="pair-note">The code works for 15 minutes. Anyone who scans it can use OpenWave on this computer, so only show it to people you trust.</p>
      <details class="pair-send"><summary>Send the link instead</summary>
        <p>For a phone that isn’t here: send it by message. It works for 15 minutes.</p>
        <div class="share-link"><input type="text" readonly value="${esc(p.link)}" aria-label="Pairing link">
          <button type="button" class="btn" data-copy>${icon('link')} Copy</button>
          <button type="button" class="btn" data-send>${icon('share')} Send</button></div>
      </details>
      <div class="row-btns"><span class="spacer"></span><button class="btn primary" value="ok" data-done>Done</button></div>
    </form>`, {
    wide: true,
    onMount: (d) => {
      d.querySelector('[data-done]').focus({ preventScroll: true });
      const input = d.querySelector('.share-link input');
      d.querySelector('[data-copy]').onclick = () => copy(p.link, input);
      d.querySelector('[data-send]').onclick = async () => {
        if (!(await shareText('OpenWave', 'Open this on your phone to listen with OpenWave:', p.link))) copy(p.link, input);
      };
      const state = d.querySelector('[data-state]');
      const tick = async () => {
        if (!d.open) return;
        try {
          const st = await call('/api/connect');
          const ticket = st.tickets?.find((t) => t.id === p.id);
          const added = (st.devices || []).filter((x) => ticket?.devices.includes(x.id));
          if (added.length) {
            state.dataset.ok = '';
            state.innerHTML = `${icon('check')} ${esc(added.map((x) => x.label).join(', '))} ${added.length === 1 ? 'is' : 'are'} connected.`;
          } else if (!ticket) {
            state.textContent = 'This code has expired. Close this and choose Add a phone again.';
          }
        } catch { /* try again shortly */ }
        timer = setTimeout(tick, 2000);
      };
      timer = setTimeout(tick, 1500);
    },
  });
  clearTimeout(timer);
}

export async function removePhone(id, label) {
  if (!await confirmDialog(`Remove this ${label}?`, `It won’t be able to use OpenWave on this computer any more. To use it again, add it again.`, 'Remove')) return false;
  try {
    await call(`/api/connect/devices/${encodeURIComponent(id)}/remove`, 'POST');
    toast(`Removed the ${label}`);
    return true;
  } catch (e) {
    toast(e.message, 4000);
    return false;
  }
}

export async function forgetComputer() {
  const name = computer()?.name || 'your computer';
  if (!await confirmDialog(`Forget ${name}?`, `This phone stops playing from ${name}. Songs you downloaded stay on this phone. To use it again, scan a new code from ${name}.`, 'Forget')) return;
  await forget();
}
