// "Who's listening?" — pick or create a profile. Each profile has its own library, synced by the server.

import { store } from './store.js';
import { $, esc, icon, toast, avatar } from './ui.js';

const COLORS = ['#7b7bff', '#2fc8ff', '#c45cff', '#ff6fae', '#ffb648', '#3ddc97', '#ff6b6b', '#8f7cff'];

let pending = null;

/** Resolves once a profile is signed in (immediately if one already is). */
export function ensureProfile(message = '') {
  if (store.session) return Promise.resolve(store.profile);
  pending ??= new Promise((resolve) => show(message, (p) => { pending = null; resolve(p); }));
  return pending;
}

function show(message, done) {
  let el = $('#profiles');
  if (!el) {
    el = document.createElement('div');
    el.id = 'profiles';
    el.className = 'profiles-screen';
    document.body.appendChild(el);
  }
  el.hidden = false;
  const finish = (profile, migrated) => {
    el.hidden = true;
    el.innerHTML = '';
    toast(migrated ? `Welcome, ${profile.name}! Moved ${migrated} items from this browser into your profile.` : `Welcome, ${profile.name}!`, 3500);
    done(profile);
  };
  const frame = (inner) => {
    el.innerHTML = `<div class="profiles-inner"><img class="profiles-logo" src="/icons/logo-mark-128.png" alt="OpenWave">${inner}</div>`;
  };

  async function pick() {
    frame('<h1>Who’s listening?</h1><p class="muted">Loading profiles…</p>');
    let list;
    try {
      list = await store.listProfiles();
    } catch {
      frame(`<h1>Can’t reach OpenWave</h1><p class="muted">The OpenWave server isn’t responding. Check that it’s running, then try again.</p>
        <button class="btn primary" data-p="retry">Try again</button>`);
      el.querySelector('[data-p=retry]').onclick = pick;
      return;
    }
    if (!list.length) return create(true);
    frame(`<h1>Who’s listening?</h1>${message ? `<p class="profiles-msg">${esc(message)}</p>` : ''}
      <div class="profile-grid">
        ${list.map((p) => `<button class="profile-tile" data-pid="${esc(p.id)}">${avatar(p, 96)}<b>${esc(p.name)}</b>${p.hasPin ? `<small>${icon('lock')} PIN</small>` : '<small>&nbsp;</small>'}</button>`).join('')}
        <button class="profile-tile add" data-p="add"><span class="avatar add">${icon('plus')}</span><b>Add profile</b><small>&nbsp;</small></button>
      </div>
      <p class="profiles-hint">Each profile has its own likes, playlists, history and insights. They sync to every device using this OpenWave server.</p>`);
    el.querySelector('[data-p=add]').onclick = () => create(false);
    el.querySelectorAll('[data-pid]').forEach((b) => {
      const p = list.find((x) => x.id === b.dataset.pid);
      b.onclick = () => (p.hasPin ? askPin(p) : signIn(p));
    });
  }

  async function signIn(p, pin) {
    try {
      const r = await store.signIn(p.id, pin);
      finish(p, r.migrated);
    } catch (e) {
      if (p.hasPin) askPin(p, e.message); else { toast(e.message); pick(); }
    }
  }

  function askPin(p, error = '') {
    frame(`${avatar(p, 96)}<h1>${esc(p.name)}</h1><p class="muted">Enter your PIN</p>
      <form class="pin-form"><input class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" autofocus>
      ${error ? `<p class="profiles-msg">${esc(error)}</p>` : ''}
      <div class="row-btns"><button type="button" class="btn" data-p="back">Back</button><button class="btn primary">Unlock</button></div></form>`);
    const form = el.querySelector('form');
    form.querySelector('input').focus();
    el.querySelector('[data-p=back]').onclick = pick;
    form.onsubmit = (e) => { e.preventDefault(); signIn(p, form.querySelector('input').value); };
  }

  function create(first) {
    let color = COLORS[Math.floor(Math.random() * COLORS.length)];
    frame(`<h1>${first ? 'Welcome to OpenWave' : 'New profile'}</h1>
      <p class="muted">${first ? 'Create a profile to keep your likes, playlists and history. It’s free, forever — no email, no account.' : 'Everyone gets their own library.'}</p>
      <form class="new-profile">
        <div class="avatar-preview">${avatar({ name: '?', color }, 96)}</div>
        <input name="name" type="text" placeholder="Your name" maxlength="40" required autocomplete="off">
        <div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === color ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Colour"></button>`).join('')}</div>
        <label class="pin-toggle"><input type="checkbox" name="usepin"> Protect with a PIN</label>
        <input name="pin" class="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" placeholder="4–8 digits" hidden>
        <div class="row-btns">${first ? '' : '<button type="button" class="btn" data-p="back">Back</button>'}<button class="btn primary">Start listening</button></div>
      </form>`);
    const form = el.querySelector('form');
    const name = form.elements.name;
    const preview = () => { el.querySelector('.avatar-preview').innerHTML = avatar({ name: name.value || '?', color }, 96); };
    name.oninput = preview;
    name.focus();
    form.querySelectorAll('.swatch').forEach((s) => { s.onclick = () => { color = s.dataset.c; form.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === s)); preview(); }; });
    form.elements.usepin.onchange = () => { form.elements.pin.hidden = !form.elements.usepin.checked; form.elements.pin.required = form.elements.usepin.checked; };
    el.querySelector('[data-p=back]')?.addEventListener('click', pick);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const pin = form.elements.usepin.checked ? form.elements.pin.value : null;
        const r = await store.createProfile(name.value.trim(), pin, color);
        finish(store.profile, r.migrated);
      } catch (err) {
        toast(err.message);
      }
    };
  }

  pick();
}

export async function switchProfile() {
  await store.signOut();
  return ensureProfile();
}
