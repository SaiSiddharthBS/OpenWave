// Your other devices on the same Wi-Fi: play music on one of them from here (like a remote), or
// listen together, with every device playing the same song at the same moment.
//
// This page only talks to its own engine (/api/link/...); the engines find each other and pass
// commands and "what's playing" between devices. No audio is sent between devices: each one
// streams the song itself.

import { slim } from './store.js';
import { player } from './player.js';
import { isNative, isAndroid, attention, haptic } from './native.js';
import { $, esc, icon, toast, openDialog, askText } from './ui.js';

const ID_KEY = 'openwave:player-id';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (o) => new URLSearchParams(o).toString();
const ID = (() => {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63]).join('');
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) { id = make(); localStorage.setItem(ID_KEY, id); }
    return id;
  } catch { return make(); }
})();

const UA = navigator.userAgent;
const KIND = isAndroid || /iPhone|iPod|Android.*Mobile/.test(UA) ? 'phone' : 'computer';
const THIS = KIND === 'phone' ? 'phone' : isNative ? 'Mac' : 'device';

/** The phone's own name in the Android app (its engine may be on a computer); "Chrome on Windows"
 * for a browser; the Mac app's engine knows the Mac's name. */
function browserName() {
  if (isAndroid) { try { return window.OpenWaveAndroid.deviceName?.() || ''; } catch { return ''; } }
  if (isNative) return '';
  const browser = /Edg\//.test(UA) ? 'Edge' : /Firefox\//.test(UA) ? 'Firefox' : /Chrome\//.test(UA) ? 'Chrome' : /Safari\//.test(UA) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(UA) ? 'iPhone' : /iPad/.test(UA) ? 'iPad' : /Android/.test(UA) ? 'Android' : /Mac/.test(UA) ? 'Mac' : /Windows/.test(UA) ? 'Windows' : /Linux/.test(UA) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

async function call(path, body) {
  const res = await fetch(`/api/link/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
    e.status = res.status;
    e.pair = !!data?.pair;
    throw e;
  }
  return data;
}

let me = null; // this device as the engine knows it: {engine, name, visible, address, allowed, paired}
let linked = null; // the Link while playing on, or listening with, another device
let hosting = null; // {members} while this device hosts a listening session
export const linkEvents = new EventTarget();
const changed = () => linkEvents.dispatchEvent(new Event('change'));

// ================================================================== what's playing here
function snapshot() {
  const t = player.current;
  if (!t) return null;
  const base = Math.max(0, player.index - 20);
  return {
    track: slim(t),
    queue: player.queue.slice(base, player.index + 100).map(slim),
    index: player.index - base,
    base,
    position: player.time,
    duration: player.duration,
    playing: player.loaded && !player.paused,
    loading: !!(player.loading && player.loaded),
    shuffle: player.shuffle,
    repeat: player.repeat,
    volume: player.volume,
    context: player.context,
  };
}

let pubTimer = null;
let lastPub = null;
function publishSoon() {
  if (me && !pubTimer) pubTimer = setTimeout(publish, 150);
}
async function publish() {
  pubTimer = null;
  const state = player.remote ? null : snapshot(); // a remote or a guest isn't playing its own music
  lastPub = state && { position: state.position, moving: state.playing && !state.loading, at: performance.now() };
  try { await call('state', { player: ID, state }); } catch { /* the poll loop re-introduces us */ }
}

// ================================================================== commands from other devices
const clean = {
  track(t) {
    if (!t || typeof t !== 'object' || !/^[\w-]{11}$/.test(t.videoId)) return null;
    const id = (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null);
    return slim({
      type: t.type === 'video' ? 'video' : 'song',
      videoId: t.videoId,
      title: String(t.title || '').slice(0, 300),
      artists: (Array.isArray(t.artists) ? t.artists : []).filter((a) => typeof a?.name === 'string').slice(0, 10).map((a) => ({ name: a.name.slice(0, 120), id: id(a.id) })),
      album: typeof t.album?.name === 'string' ? { name: t.album.name.slice(0, 200), id: id(t.album.id) } : null,
      duration: +t.duration || null,
      thumbnail: typeof t.thumbnail === 'string' ? t.thumbnail : null,
      explicit: !!t.explicit,
    });
  },
  tracks: (list) => (Array.isArray(list) ? list : []).slice(0, 500).map(clean.track).filter(Boolean),
  context: (c) => (typeof c?.label === 'string' ? { label: c.label.slice(0, 120) } : null),
  state(s) {
    const track = clean.track(s?.track);
    if (!track) return null;
    const queue = clean.tracks(s.queue);
    return {
      track, queue: queue.length ? queue : [track], index: Math.max(0, +s.index || 0), base: Math.max(0, +s.base || 0),
      position: Math.max(0, +s.position || 0), duration: +s.duration || 0, playing: !!s.playing, loading: !!s.loading,
      shuffle: !!s.shuffle, repeat: ['off', 'all', 'one'].includes(s.repeat) ? s.repeat : 'off',
      volume: Number.isFinite(+s.volume) ? Math.max(0, Math.min(1, +s.volume)) : 0.8, context: clean.context(s.context),
    };
  },
};

/** A queue position from another device: it names the song too, in case the queue moved since. */
function find(c) {
  const i = +c.i;
  if (player.queue[i]?.videoId === c.videoId) return i;
  return player.queue.findIndex((t) => t.videoId === c.videoId);
}

const RUN = {
  toggle: () => player.toggle(),
  play: () => player.play(),
  pause: () => player.pause(),
  next: () => player.next(),
  prev: () => player.prev(),
  seek: (c) => player.seek(+c.t || 0),
  jump: (c) => { const i = find(c); if (i >= 0) player.jump(i); },
  removeAt: (c) => { const i = find(c); if (i >= 0) player.removeAt(i); },
  move: (c) => { const i = find(c); if (i >= 0) player.move(i, +c.to); },
  playList: (c) => { const t = clean.tracks(c.tracks); if (t.length) player.playList(t, Math.min(+c.i || 0, t.length - 1), clean.context(c.context)); },
  playRadio: (c) => { const t = clean.track(c.track); if (t) player.playRadio(t, clean.context(c.context)); },
  playPlaylistRadio: (c) => { if (/^[\w-]{11}$/.test(c.seed)) player.playPlaylistRadio(c.seed, String(c.playlistId || '') || null, String(c.label || '').slice(0, 120)).catch(() => {}); },
  playNext: (c) => player.playNext(clean.tracks(c.tracks)),
  addToQueue: (c) => player.addToQueue(clean.tracks(c.tracks)),
  volume: (c) => player.setVolume(+c.v),
  mute: () => player.toggleMute(),
  shuffle: (c) => { if (player.shuffle !== !!c.on) player.toggleShuffle(); },
  repeat: (c) => { for (let n = 0; n < 3 && player.repeat !== c.mode; n++) player.cycleRepeat(); },
  take: (c, from) => {
    const s = clean.state(c.state);
    if (!s) return;
    if (linked) stop('replaced');
    player.adopt(s, { position: s.position, playing: s.playing });
    toast(`Playing from ${from.name || 'another device'}`);
  },
};

const told = new Map(); // remote control: say who's in control now and then, not on every tap
function run(cmd, from = {}) {
  const fn = RUN[cmd?.cmd];
  if (!fn) return;
  if (cmd.cmd !== 'take' && !(hosting && from.key) && Date.now() - (told.get(from.key) || 0) > 10 * 60000) {
    told.set(from.key, Date.now());
    toast(`${from.name || 'Another device'} is controlling the music here`);
  }
  try { fn(cmd, from); } catch (e) { console.warn('link command', cmd.cmd, e); }
}

// ================================================================== allowing other devices
let asking = null;
async function askPair(e) {
  attention();
  haptic('long');
  asking = e.request;
  const answer = await openDialog(`<form method="dialog"><h3>Let “${esc(e.name)}” connect?</h3>
    <p>It will be able to play music on this ${THIS} and join your listening sessions. Only allow devices you know.</p>
    <div class="row-btns"><button class="btn" value="no">Don’t allow</button><button class="btn primary" value="yes">Allow</button></div></form>`);
  if (asking !== e.request) return; // answered on another screen
  asking = null;
  try { await call('answer', { request: e.request, allow: answer === 'yes' }); } catch { /* it gave up waiting */ }
}

function handle(e) {
  if (e.type === 'command') return run(e.cmd, e.from);
  if (e.type === 'pair') return askPair(e);
  if (e.type === 'pair-done' && asking === e.request) { asking = null; $('#dialog').close(); return; }
  if (e.type === 'members' && hosting) {
    hosting.members = e.members || [];
    if (e.joined) toast(`${e.joined} joined your listening session`);
    if (e.left) toast(`${e.left} left your listening session`);
    changed();
  }
}

async function hello() {
  me = await call('hello', { player: ID, name: browserName(), kind: KIND });
  hosting = me.hosting ? { members: me.members || [] } : null; // still hosting after a reload
  publishSoon();
  changed();
  return me;
}

async function pollLoop() {
  let cursor = -1;
  for (;;) {
    try {
      const r = await call(`poll?${qs({ player: ID, cursor })}`);
      cursor = r.cursor;
      r.events.forEach(handle);
    } catch (e) {
      cursor = -1;
      if (e.status === 404) await hello().catch(() => sleep(3000));
      else await sleep(3000);
    }
  }
}

// ================================================================== playing on / listening with another device
const LOAD_LEAD = 0.4; // seconds a new song takes to start, roughly; the sync loop fixes the rest

class Link {
  constructor(dev, mode, state = null) {
    this.dev = dev;
    this.mode = mode; // 'remote': control it; 'follow': listen together, in step with it
    this.state = state;
    this.age = 0;
    this.got = performance.now();
    this.active = true;
    this.chain = Promise.resolve();
    this.lead = 0.3;
    this.jumped = false;
  }

  /** Where the other device is in the song right now. */
  position() {
    const s = this.state;
    if (!s) return 0;
    const moving = s.playing && !s.loading ? this.age + (performance.now() - this.got) / 1000 : 0;
    return Math.min(s.duration || Infinity, (s.position || 0) + moving);
  }

  /** A queue position on the other device (the mirrored queue starts at its `base`). */
  at(i) { return { i: i + (this.state?.base || 0), videoId: player.queue[i]?.videoId }; }

  send(cmd) {
    const s = this.state;
    if (this.mode === 'remote' && s) {
      // Show the change straight away; the other device's next update confirms it.
      if (['toggle', 'play', 'pause'].includes(cmd.cmd)) {
        s.position = this.position(); this.age = 0; this.got = performance.now();
        s.playing = cmd.cmd === 'toggle' ? !s.playing : cmd.cmd === 'play';
        player.emit('state');
      } else if (cmd.cmd === 'seek') {
        s.position = cmd.t; this.age = 0; this.got = performance.now();
        player.emit('time');
      } else if (cmd.cmd === 'volume' && !cmd.now) {
        s.volume = cmd.v;
        clearTimeout(this.volTimer); // a dragged slider sends dozens of these: only the last matters
        this.volTimer = setTimeout(() => this.send({ cmd: 'volume', v: cmd.v, now: true }), 120);
        return this.chain;
      }
    }
    this.chain = this.chain
      .then(() => call('send', { player: ID, target: this.dev.key, cmd }))
      .catch((e) => toast(e.message));
    return this.chain;
  }

  async loop() {
    let version = -1;
    let fails = 0;
    while (this.active) {
      try {
        const r = await call(`watch?${qs({ player: ID, target: this.dev.key, version, follow: this.mode === 'follow' ? 1 : 0 })}`);
        if (!this.active) return;
        if (r.ended || r.gone) return stop(r.ended ? 'ended' : 'gone');
        fails = 0;
        if (r.version === version) continue;
        version = r.version;
        this.state = clean.state(r.state);
        this.age = +r.age || 0;
        this.got = performance.now();
        if (r.name) this.dev.name = r.name;
        this.apply();
      } catch (e) {
        if (!this.active) return;
        if (e.pair) return stop('unpaired');
        if (++fails >= 4) return stop('lost');
        await sleep(1500);
      }
    }
  }

  apply() {
    const s = this.state;
    if (this.mode === 'remote') return player.mirrorState(s);
    if (!s) { player.el.pause(); return; }
    const fresh = player.current?.videoId !== s.track.videoId || !player.loaded;
    player.adopt(s, { position: this.position() + (fresh && s.playing ? LOAD_LEAD : 0), playing: s.playing });
  }

  /** Listening together: stay within a few hundredths of a second of the host. */
  sync() {
    const s = this.state;
    const el = player.el;
    if (this.mode !== 'follow' || !s?.playing || s.loading || el.paused || player.loading || player.current?.videoId !== s.track.videoId) {
      player.setRate(1);
      return;
    }
    const off = el.currentTime - this.position();
    if (Math.abs(off) > 0.6) { // too far to catch up smoothly: jump, aiming a little ahead
      el.currentTime = this.position() + this.lead;
      this.jumped = true;
      player.setRate(1);
      return;
    }
    if (this.jumped) { this.jumped = false; this.lead = Math.max(0, Math.min(2, this.lead - off)); }
    // Otherwise play a touch faster or slower (at most 8%, pitch unchanged) until back in step.
    if (Math.abs(off) < 0.03) player.setRate(1);
    else if (Math.abs(off) > 0.06 || el.playbackRate !== 1) player.setRate(+(1 - Math.sign(off) * Math.min(0.08, 0.01 + Math.abs(off) * 0.15)).toFixed(2));
  }
}

function start(dev, mode, state = null) {
  if (linked) stop('replaced');
  if (hosting) host(false);
  const l = new Link(dev, mode, state);
  linked = l;
  player.link(l);
  if (mode === 'remote' && state) player.mirrorState(state);
  l.timer = setInterval(() => (l.mode === 'follow' ? l.sync() : player.emit('time')), 500);
  l.loop();
  publish();
  changed();
}

function stop(reason) {
  const l = linked;
  if (!l) return;
  l.active = false;
  linked = null;
  clearInterval(l.timer);
  if (l.mode === 'follow') call('leave', { player: ID, target: l.dev.key }).catch(() => {});
  player.link(null);
  if (l.mode === 'follow' && reason !== 'left' && reason !== 'replaced') player.el.pause();
  const name = l.dev.name;
  const why = {
    ended: `${name} ended the listening session`,
    gone: `${name} closed OpenWave`,
    lost: `Lost connection to ${name}`,
    unpaired: `${name} no longer allows this device`,
  }[reason];
  if (why) toast(why, 4000);
  publishSoon();
  changed();
}

/** Run `fn`; if the other device hasn't allowed this one yet, ask it first and try again. */
async function withPairing(dev, fn, onWait) {
  try {
    return await fn();
  } catch (e) {
    if (!e.pair) throw e;
  }
  onWait?.();
  await call('pair', { player: ID, target: dev.key });
  return fn();
}

/** Use this device as a remote for another one, moving the music there if it's playing here
 * (a paused song here shouldn't interrupt whatever is playing there). */
export async function playOn(dev, onWait) {
  if (linked?.dev.key === dev.key && linked.mode === 'remote') return;
  const s = !player.remote && player.loaded && !player.paused ? snapshot() : null;
  let state = s;
  await withPairing(dev, async () => {
    if (s) await call('send', { player: ID, target: dev.key, cmd: { cmd: 'take', state: { ...s, position: player.time } } });
    else state = clean.state((await call(`watch?${qs({ player: ID, target: dev.key, version: -1 })}`)).state);
  }, onWait);
  start(dev, 'remote', state && { ...state, position: s ? player.time : state.position });
  toast(`Playing on ${dev.name}`);
}

/** Bring the music back from the device this one is controlling. */
export function playHere() {
  const l = linked;
  if (!l || l.mode !== 'remote') return;
  const s = l.state && { ...l.state };
  const at = l.position();
  l.send({ cmd: 'pause' });
  stop('here');
  if (s) player.adopt(s, { position: at, playing: s.playing });
}

export async function join(dev, onWait) {
  await withPairing(dev, () => call('join', { player: ID, target: dev.key }), onWait);
  start(dev, 'follow');
  toast(`Listening together with ${dev.name}`);
}

export function leave() { stop('left'); }

export async function host(on) {
  if (on && linked) stop('replaced');
  const r = await call('host', { player: ID, on });
  hosting = on ? { members: r.members || [] } : null;
  if (on) me = { ...me, visible: true };
  changed();
}

/** A one-line description of the current link, for the player bar. */
export function linkLabel() {
  if (linked?.mode === 'remote') return { icon: 'speaker', text: `Playing on ${linked.dev.name}` };
  if (linked?.mode === 'follow') return { icon: 'people', text: `Listening with ${linked.dev.name}` };
  if (hosting) {
    const n = hosting.members.length;
    return { icon: 'people', text: n ? `Listening together · ${n} joined` : 'Listening together · waiting for others' };
  }
  return null;
}

// ================================================================== the Devices sheet
const kindIcon = (kind) => (kind === 'phone' ? 'phone' : 'computer');

export async function openDevices() {
  if (!me) { toast('This OpenWave can’t see other devices. Update it to the latest version.'); return; }
  const sheet = { open: true, data: null, waiting: null, error: '' };
  const draw = () => {
    const box = $('#dialog .dev-body');
    if (box) box.innerHTML = devicesBody(sheet);
  };
  const off = () => draw();
  linkEvents.addEventListener('change', off);
  const act = async (fn, key) => {
    sheet.error = '';
    try {
      await fn(() => { sheet.waiting = key; draw(); });
    } catch (e) {
      sheet.error = e.message;
    }
    sheet.waiting = null;
    draw();
  };
  const onClick = async (e) => {
    const row = e.target.closest('[data-dev]');
    const btn = e.target.closest('[data-dev-act]');
    if (row) {
      const dev = sheet.data?.devices.find((d) => d.key === row.dataset.dev);
      if (!dev || sheet.waiting || linked?.dev.key === dev.key) return;
      haptic('tick');
      await act((wait) => (dev.hosting ? join(dev, wait) : playOn(dev, wait)), dev.key);
      if (!sheet.error) $('#dialog').close();
      return;
    }
    if (!btn) return;
    const what = btn.dataset.devAct;
    if (what === 'here') { playHere(); $('#dialog').close(); }
    else if (what === 'leave') { leave(); draw(); }
    else if (what === 'host') await act(() => host(true));
    else if (what === 'end') await act(() => host(false));
    else if (what === 'visible') await act(async () => { me = await call('settings', { player: ID, visible: !me.visible }); refresh(); });
    else if (what === 'add') {
      $('#dialog').close();
      const address = await askText('Add a device by address', { placeholder: '192.168.1.20', ok: 'Add' });
      if (address) {
        try { await call('settings', { player: ID, address }); } catch (err) { toast(err.message, 5000); }
      }
      openDevices();
    }
  };
  const refresh = async () => {
    try { sheet.data = await call(`devices?${qs({ player: ID })}`); me = { ...me, visible: sheet.data.visible, address: sheet.data.address }; } catch (e) { sheet.error ||= e.message; }
    if (sheet.open) draw();
  };
  const closed = openDialog(`<form method="dialog" class="devices">
      <div class="dev-head"><h3>Devices</h3><button class="icon-btn" value="close" aria-label="Close">${icon('close')}</button></div>
      <div class="dev-body">${devicesBody(sheet)}</div></form>`, {
    onMount: (d) => d.addEventListener('click', onClick),
  });
  const d = $('#dialog');
  (async () => {
    while (sheet.open) {
      await refresh();
      await sleep(4000);
    }
  })();
  await closed;
  sheet.open = false;
  d.removeEventListener('click', onClick);
  linkEvents.removeEventListener('change', off);
}

function devicesBody(sheet) {
  const l = linked;
  const devs = sheet.data?.devices || [];
  const status = l?.mode === 'remote'
    ? statusCard('speaker', `Playing on ${l.dev.name}`, `Everything you play here plays there.`, `<button type="button" class="btn primary" data-dev-act="here">Play on this ${THIS}</button>`)
    : l?.mode === 'follow'
      ? statusCard('people', `Listening together with ${l.dev.name}`, 'You hear the same song at the same moment. Anyone can pause, skip or add songs.', '<button type="button" class="btn" data-dev-act="leave">Leave</button>')
      : hosting
        ? statusCard('people', 'You’re hosting a listening session', hosting.members.length ? `Listening with you: ${hosting.members.map(esc).join(', ')}` : 'Others on your Wi-Fi can join from their Devices list.', '<button type="button" class="btn" data-dev-act="end">End session</button>')
        : '';
  const here = `<button type="button" class="dev-row ${!l || l.mode === 'follow' ? 'on' : ''}" ${l?.mode === 'remote' ? 'data-dev-act="here"' : ''}>
      ${icon(kindIcon(KIND))}<span><b>This ${THIS}</b><small>${esc(me?.name || '')}</small></span>${!l ? icon('check') : ''}</button>`;
  const rows = devs.map((d) => {
    const on = l?.dev.key === d.key;
    const note = sheet.waiting === d.key ? 'Waiting… tap Allow on that device'
      : on ? (l.mode === 'remote' ? 'Playing here' : 'Listening together')
        : d.hosting ? 'Listening session · tap to join' : d.paired ? 'Tap to play here' : 'Tap to connect';
    return `<button type="button" class="dev-row ${on ? 'on' : ''} ${sheet.waiting === d.key ? 'waiting' : ''}" data-dev="${esc(d.key)}">
      ${icon(d.hosting ? 'people' : kindIcon(d.kind))}<span><b>${esc(d.name)}</b><small>${esc(note)}</small></span>${on ? icon('check') : ''}</button>`;
  }).join('');
  const searching = !sheet.data ? '<p class="dev-note"><span class="dev-spin"></span>Looking for devices on your Wi-Fi…</p>'
    : !devs.length ? '<p class="dev-note">No other devices found. Open OpenWave on another phone or computer on this Wi-Fi.</p>' : '';
  const hostBtn = !l && !hosting ? `<div class="dev-host"><button type="button" class="btn" data-dev-act="host">${icon('people')} Start a listening session</button>
      <p>Friends on your Wi-Fi join from their own Devices list and hear the same song at the same moment.</p></div>` : '';
  return `${status}${sheet.error ? `<p class="dev-error">${esc(sheet.error)}</p>` : ''}
    <div class="dev-list">${here}${rows}</div>${searching}${hostBtn}
    <details class="dev-help"><summary>Don’t see a device?</summary>
      <p>Both need OpenWave open on the same Wi-Fi, and the other one needs <b>Settings → Devices → Show this device on Wi-Fi</b> turned on. Some guest and office networks stop devices seeing each other.</p>
      <p>This ${THIS} is ${me?.visible ? `visible as “${esc(me.name)}”${me.address ? ` at ${esc(me.address)}` : ''}` : 'hidden from other devices'}.
        <button type="button" class="btn small" data-dev-act="visible">${me?.visible ? 'Hide it' : 'Show it'}</button></p>
      <p><button type="button" class="btn small" data-dev-act="add">Add a device by address…</button></p>
    </details>`;
}

const statusCard = (ic, title, text, action) => `<div class="dev-status">${icon(ic)}<div><b>${esc(title)}</b><p>${text}</p></div>${action}</div>`;

// ================================================================== settings
export async function linkSettings() {
  if (!me) return null;
  try { me = await call(`settings?${qs({ player: ID })}`); } catch { /* keep what we had */ }
  return me;
}

export async function setVisible(on) { me = await call('settings', { player: ID, visible: on }); return me; }
export async function rename(name) { me = await call('settings', { player: ID, name }); publishSoon(); return me; }
export async function forget(engine) { me = await call('settings', { player: ID, forget: engine }); return me; }

// ================================================================== start
export async function initLink() {
  try { await hello(); } catch { return; } // an engine from before device links
  document.documentElement.classList.add('has-link');
  ['track', 'state', 'queue', 'volume'].forEach((ev) => player.addEventListener(ev, publishSoon));
  player.addEventListener('time', () => {
    if (!lastPub || player.remote) return;
    const expect = lastPub.position + (lastPub.moving ? (performance.now() - lastPub.at) / 1000 : 0);
    if (Math.abs(player.time - expect) > 1) publishSoon(); // a seek, or a stall
  });
  player.addEventListener('slept', () => { if (linked?.mode === 'follow') stop('left'); });
  let beat = 0;
  setInterval(() => { // guests measure against the host's position, so a host refreshes it more often
    if (hosting || ++beat % 3 === 0) publishSoon();
  }, 5000);
  pollLoop();
  changed();
}
