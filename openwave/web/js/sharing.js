// Shared playlists: invite friends and family to one playlist that everyone edits from their own
// OpenWave, wherever they are. The engine does the syncing (see openwave/shared.py); this is the UI.

import { store } from './store.js';
import { shareText } from './native.js';
import { esc, icon, toast, avatar, confirmDialog, openDialog } from './ui.js';

const JOIN_PREFIX = 'https://saisiddharthbs.github.io/OpenWave/join/#';
export const isInvite = (text) => (text || '').includes('/OpenWave/join/#');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Close the dialog and wait until it has really closed. The browser reports "closed" a moment
 * later, so opening the next dialog straight away would receive that stale event as a Cancel. */
const closeDialog = (d) => new Promise((resolve) => {
  if (!d.open) { resolve(); return; }
  d.addEventListener('close', () => setTimeout(resolve), { once: true });
  d.close();
});

/** "Maya", "Maya and Arjun", "Maya, Arjun and 2 others". */
export function peopleLine(shared) {
  const names = shared.people.map((p) => (p.you ? 'You' : p.name));
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${plural(names.length - 2, 'other')}`;
}

/** One short line on how syncing is going, for the playlist header. */
export function syncLine(shared) {
  if (shared.error) return `<span class="share-state warn">${icon('offline')}${esc(shared.error)}</span>`;
  if (shared.pending) return `<span class="share-state">${icon('people')}Saving changes…</span>`;
  return `<span class="share-state">${icon('people')}Shared · changes sync to everyone</span>`;
}

/** Start sharing one of your playlists, then show the invite. */
export async function startSharing(playlist) {
  const ok = await confirmDialog(`Share “${playlist.name}”?`,
    'Friends and family join with a link and can add, remove and reorder songs from their own OpenWave, wherever they are. '
    + 'Changes sync over the internet, encrypted so only people with the link can read them.', 'Share', { danger: false });
  if (!ok) return;
  try {
    await store.api(`/api/me/shares/${encodeURIComponent(playlist.id)}`, { method: 'POST' });
    await store.pull();
    openSharing(playlist.id);
  } catch (e) {
    toast(`Couldn’t share it: ${e.message}`, 4000);
  }
}

/** The "Shared with" panel: who's in it, the invite link, and leaving or removing people. */
export async function openSharing(playlistId) {
  let info;
  try {
    info = await store.api(`/api/me/shares/${encodeURIComponent(playlistId)}`);
  } catch (e) {
    toast(e.message, 4000);
    return;
  }
  const p = store.playlist(playlistId);
  const name = p?.name || 'this playlist';
  const people = info.people.map((x) => `
    <div class="share-person">${avatar({ name: x.name }, 34)}
      <span><b>${esc(x.name)}${x.you ? ' (you)' : ''}</b><small>${x.owner ? 'Owner' : 'Can add and remove songs'}</small></span>
      ${info.owner && !x.you ? `<button type="button" class="btn small" data-remove="${esc(x.id)}" data-name="${esc(x.name)}">Remove</button>` : ''}
    </div>`).join('');
  const connected = info.sync?.connected ?? 0;
  const status = info.error ? esc(info.error)
    : connected ? 'Connected. Changes reach everyone within seconds.'
      : 'Connecting… Changes are saved here and sync as soon as you’re online.';
  openDialog(`<form method="dialog" class="share-dialog">
      <h3>Shared with</h3>
      <div class="share-people">${people}</div>
      <h4>Invite people</h4>
      <p>Anyone with this link can join from their own OpenWave and change the songs. Send it only to people you trust.</p>
      <div class="share-link"><input type="text" readonly value="${esc(info.invite)}" aria-label="Invite link">
        <button type="button" class="btn" data-copy>${icon('link')} Copy</button></div>
      <p class="share-sync">${status}</p>
      <div class="row-btns">
        <button type="button" class="btn danger-text" data-leave>${info.owner ? 'Delete for everyone' : 'Leave playlist'}</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-send>${icon('share')} Send invite</button>
        <button class="btn primary" value="ok" data-done>Done</button>
      </div></form>`, {
    wide: true,
    onMount: (d) => {
      d.querySelector('[data-done]').focus({ preventScroll: true });    // never start on a Remove button
      const input = d.querySelector('.share-link input');
      d.querySelector('[data-copy]').onclick = () => copy(info.invite, input);
      d.querySelector('[data-send]').onclick = async () => {
        const text = `Join my playlist “${name}” on OpenWave: open the link, then paste it in OpenWave → Library → Join.`;
        if (!(await shareText(`Join “${name}” on OpenWave`, text, info.invite))) copy(info.invite, input);
      };
      d.querySelector('[data-leave]').onclick = async () => {
        await closeDialog(d);
        await leave(playlistId, name, info.owner);
      };
      d.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = async () => {
          await closeDialog(d);
          if (!await confirmDialog(`Remove ${b.dataset.name}?`,
            `${b.dataset.name} will keep a copy of the songs but won’t see or make changes any more. The invite link changes, so send the new one to anyone who hasn’t joined yet.`, 'Remove')) {
            openSharing(playlistId);
            return;
          }
          try {
            await store.api(`/api/me/shares/${encodeURIComponent(playlistId)}/remove`, { method: 'POST', body: { person: b.dataset.remove } });
            await store.pull();
            toast(`Removed ${b.dataset.name}`);
          } catch (e) { toast(e.message, 4000); }
          openSharing(playlistId);
        };
      });
    },
  });
}

async function leave(playlistId, name, owner) {
  const ok = owner
    ? await confirmDialog(`Delete “${name}” for everyone?`, 'It’s removed from your library. Everyone else keeps a copy of the songs, but it stops being shared.', 'Delete for everyone')
    : await confirmDialog(`Leave “${name}”?`, 'It’s removed from your library. Everyone else keeps it.', 'Leave');
  if (!ok) return;
  store.deletePlaylist(playlistId);
  location.hash = '#/library';
  toast(owner ? 'Deleted for everyone' : `You left “${name}”`);
}

function copy(text, input) {
  const done = () => toast('Invite link copied');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => { input.select(); toast('Press Copy on your keyboard to copy the link'); });
  } else {
    input.focus();
    input.select();
    try { document.execCommand('copy'); done(); } catch { toast('Select the link and copy it'); }
  }
}

/** Paste an invite to join a friend's shared playlist. */
export function openJoin(prefill = '') {
  openDialog(`<form method="dialog" class="share-dialog join">
      <h3>Join a shared playlist</h3>
      <p>Paste the invite link a friend sent you. You’ll be able to add, remove and reorder songs, and everyone sees the changes.</p>
      <textarea name="invite" rows="3" placeholder="${JOIN_PREFIX}…" aria-label="Invite link" autocomplete="off" spellcheck="false">${esc(prefill)}</textarea>
      <p class="share-error" hidden></p>
      <div class="row-btns"><button class="btn" value="cancel">Cancel</button><button type="button" class="btn primary" data-join>Join</button></div>
    </form>`, {
    onMount: (d) => {
      const area = d.querySelector('textarea');
      const err = d.querySelector('.share-error');
      const btn = d.querySelector('[data-join]');
      area.focus();
      btn.onclick = async () => {
        if (!area.value.trim()) { area.focus(); return; }
        btn.disabled = true;
        btn.textContent = 'Joining…';
        err.hidden = true;
        try {
          const { playlistId } = await store.api('/api/me/shares/join', { method: 'POST', body: { invite: area.value } });
          await store.pull();
          await closeDialog(d);
          location.hash = `#/my/${encodeURIComponent(playlistId)}`;
          toast('Joined. The songs appear as soon as they sync.', 3500);
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Join';
        }
      };
    },
  });
}

/** Messages the engine left for this profile (e.g. "you were removed from …"), shown once. */
export function showNotices() {
  const list = store.notices;
  if (!list.length) return;
  list.forEach((text, i) => setTimeout(() => toast(text, 6000), i * 6200));
  store.clearNotices();
}

// While a shared playlist is on screen, check for other people's changes every few seconds.
setInterval(() => {
  if (document.visibilityState === 'visible' && document.body.dataset.sharedView) store.checkRemote();
}, 4000);
