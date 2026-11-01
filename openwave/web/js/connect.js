// OpenWave Connect, phone side: reach a paired OpenWave engine from anywhere. The pairing link
// (from the engine's QR code) holds the engine's public key and a short-lived ticket. The first time,
// this device makes its own key pair and pairs with the ticket; after that it connects with a key
// it shares with the engine without either ever sending it (ECDH). We post an encrypted WebRTC
// offer to public relays, the engine answers, and from then on requests travel over a direct data
// channel. See openwave/connect.py for the engine side and the wire format.
import { getSharedSecret, schnorr, utils } from './vendor/secp256k1.js';

const KIND = 21078;
export const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.snort.social',
  'wss://nostr.oxtr.dev', 'wss://relay.damus.io'];
const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const room = async (prefix, s) => hex(await sha256(enc.encode(prefix + s))).slice(0, 40);
const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class ConnectError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** The pairing in a link like https://…/app/#connect=… (or just the part after "connect="). */
export function parsePairing(text) {
  const m = String(text || '').match(/connect=([A-Za-z0-9_-]+)/);
  try {
    const p = JSON.parse(dec.decode(unb64url(m ? m[1] : String(text).trim())));
    const relays = Array.isArray(p.r) ? p.r.filter((u) => typeof u === 'string' && /^wss?:\/\//.test(u)) : RELAYS;
    if (p.v === 1 && /^[0-9a-f]{64}$/.test(p.h) && unb64url(p.k).length === 32) {
      return { host: p.h, ticket: p.k, name: String(p.n || 'your computer').slice(0, 60), relays: relays.length ? relays : RELAYS };
    }
  } catch { /* fall through */ }
  throw new ConnectError('That isn’t an OpenWave pairing link.', 'invalid');
}

/** A new device for a pairing: its own key pair, not yet paired. Stored by the caller. */
export function newDevice(pairing) {
  return { v: 1, host: pairing.host, name: pairing.name, relays: pairing.relays, ticket: pairing.ticket, secret: hex(utils.randomSecretKey()), paired: false };
}

/** The key this device and the engine share without ever sending it (see connect.device_key). */
async function deviceKey(device) {
  const point = getSharedSecret(unhex(device.secret), unhex('02' + device.host));
  const shared = await sha256(concat(enc.encode('openwave-ecdh'), point.slice(1, 33)));
  return sha256(concat(enc.encode('openwave-connect-device'), shared));
}

async function aesKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(raw, obj, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(raw), enc.encode(JSON.stringify(obj))));
  return b64(concat(iv, ct));
}

async function unseal(raw, blob, aad) {
  try {
    const bytes = unb64(blob);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, await aesKey(raw), bytes.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch { return null; }
}

/** A relay event signed by a throwaway key, so offers can't be linked to each other or to us. */
async function event(content, tags) {
  const sk = utils.randomSecretKey();
  const pubkey = hex(schnorr.getPublicKey(sk));
  const created_at = Math.floor(Date.now() / 1000);
  const id = await sha256(enc.encode(JSON.stringify([0, pubkey, created_at, KIND, tags, content])));
  return { id: hex(id), pubkey, created_at, kind: KIND, tags, content, sig: hex(await schnorr.signAsync(id, sk)) };
}

/** Post the offer to every relay and resolve with the engine's answer (whichever relay brings it first). */
async function exchange(device, key, body, { timeout, log }) {
  const session = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hostRoom = await room('openwave-connect:', device.host);
  const reply = await room('openwave-connect-reply:', session);
  const ev = await event(await seal(key, { ...body, s: session, ts: Date.now(), ua: navigator.userAgent }, 'offer:' + hostRoom), [['t', hostRoom]]);
  const sockets = [];
  try {
    return await new Promise((resolve, reject) => {
      let failed = 0;
      const timer = setTimeout(() => reject(new ConnectError('no answer', 'no-answer')), timeout);
      for (const url of device.relays) {
        let ws;
        try { ws = new WebSocket(url); } catch { failed++; continue; }
        sockets.push(ws);
        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', 'a', { kinds: [KIND], '#t': [reply] }]));
          ws.send(JSON.stringify(['EVENT', ev]));
          log(`sent via ${url}`);
        };
        ws.onmessage = async ({ data }) => {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          if (msg[0] !== 'EVENT' || msg[2]?.kind !== KIND) return;
          const answer = await unseal(key, msg[2].content, 'answer:' + reply);
          if (answer?.t === 'answer' && answer.s === session && typeof answer.sdp === 'string') {
            log(`answer via ${url}`);
            clearTimeout(timer);
            resolve(answer);
          }
        };
        ws.onerror = () => {
          if (++failed === device.relays.length) { clearTimeout(timer); reject(new ConnectError('offline', 'offline')); }
        };
      }
      if (failed === device.relays.length) { clearTimeout(timer); reject(new ConnectError('offline', 'offline')); }
    });
  } finally {
    for (const ws of sockets) try { ws.close(); } catch { /* already closed */ }
  }
}

/** Wait until the offer has this device's public address (from STUN), then a moment more for the
 * rest; never wait on a STUN server or network interface that doesn't answer. */
function gathered(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((done) => {
    let soon = null;
    const finish = () => { clearTimeout(cap); clearTimeout(soon); done(); };
    const cap = setTimeout(finish, ms);
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (!candidate) finish();
      else if (/ typ srflx/.test(candidate.candidate) && !soon) soon = setTimeout(finish, 300);
    });
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') finish(); });
  });
}

/**
 * Connect to the paired engine. `device` comes from newDevice(); when the first connection pairs
 * it, `device.paired` becomes true and onPaired(device) is called so the caller can save it.
 * Resolves with a Link once the data channel is open.
 */
export async function connect(device, { log = () => {}, onPaired = () => {}, timeout = 15000 } = {}) {
  if (!navigator.onLine) throw new ConnectError('This phone is offline.', 'offline');
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
  const ch = pc.createDataChannel('openwave', { ordered: true });
  ch.binaryType = 'arraybuffer';
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 2500);
    const sdp = pc.localDescription.sdp;
    const pair = () => exchange(device, unb64url(device.ticket), { t: 'enroll', pub: hex(schnorr.getPublicKey(unhex(device.secret))), sdp }, { timeout, log });
    const own = async (t) => exchange(device, await deviceKey(device), { t: 'offer', sdp }, { timeout: t, log });
    // A paired device uses its own key. A new one pairs with the code, then (if that answer was
    // lost) tries its own key, which the engine already knows. A paired device that was given a
    // new code (it was removed and scanned again) pairs again if its own key gets no answer.
    const attempts = device.paired
      ? [() => own(device.ticket ? 8000 : timeout), device.ticket && pair]
      : [device.ticket && pair, () => own(8000)];
    let answer = null;
    for (const attempt of attempts.filter(Boolean)) {
      try {
        answer = await attempt();
        break;
      } catch (e) {
        if (e.code !== 'no-answer') throw new ConnectError('Couldn’t reach the internet.', 'offline');
        log('no answer');
      }
    }
    if (!answer) {
      throw new ConnectError(device.paired
        ? `${device.name} didn’t answer. Make sure OpenWave is open on it and it’s online.`
        : `${device.name} didn’t answer. Make sure OpenWave is open on it, or scan a new code: each one works for 15 minutes.`, 'no-answer');
    }
    if (!device.paired || device.ticket || device.id !== answer.d) {
      device.paired = true;
      device.id = answer.d;
      delete device.ticket;              // the device key replaces it; the code expires anyway
      onPaired(device);
    }
    if (answer.n) device.name = String(answer.n).slice(0, 60);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await new Promise((resolve, reject) => {
      const fail = () => reject(new ConnectError(`Found ${device.name}, but couldn’t connect from this network.`, 'no-path'));
      const t = setTimeout(fail, 15000);
      ch.onopen = () => { clearTimeout(t); resolve(); };
      pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed') { clearTimeout(t); fail(); } });
    });
    return new Link(pc, ch, device, answer.api || 0);
  } catch (e) {
    pc.close();
    throw e;
  }
}

/** An open connection: fetch() works like the browser's, for the engine's /api/ paths. */
export class Link {
  constructor(pc, ch, device, api) {
    this.pc = pc;
    this.ch = ch;
    this.device = device;
    this.api = api;
    this.seq = 0;
    this.pending = new Map();
    this.onclose = null;
    this.closed = false;
    ch.onmessage = ({ data }) => this._message(data);
    const closed = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of [...this.pending.values()]) p.fail(new ConnectError('Connection lost.', 'lost'));
      this.pending.clear();
      this.onclose?.();
    };
    this._closed = closed;
    ch.onclose = closed;
    pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed'].includes(pc.connectionState)) closed(); });
  }

  get open() { return !this.closed && this.ch.readyState === 'open'; }

  close() {
    try { this.pc.close(); } catch { /* already closed */ }
    this._closed();
  }

  /** Which way the connection went (candidate types) and its round-trip time. */
  async route() {
    const stats = await this.pc.getStats();
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
        return { local: stats.get(s.localCandidateId)?.candidateType, remote: stats.get(s.remoteCandidateId)?.candidateType, rtt: s.currentRoundTripTime };
      }
    }
    return null;
  }

  /** Resolves true if the engine answers within `ms`. */
  ping(ms = 3000) {
    if (!this.open) return Promise.resolve(false);
    const i = ++this.seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(i); resolve(false); }, ms);
      this.pending.set(i, { pong: () => { clearTimeout(t); this.pending.delete(i); resolve(true); }, fail: () => { clearTimeout(t); resolve(false); } });
      this.ch.send(JSON.stringify({ i, ping: 1 }));
    });
  }

  fetch(path, { method = 'GET', headers = {}, body = null, signal } = {}) {
    if (!this.open) return Promise.reject(new ConnectError('Not connected.', 'lost'));
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const i = ++this.seq;
    return new Promise((resolve, reject) => {
      let controller;
      let settled = false;
      const stream = new ReadableStream({ start: (c) => { controller = c; }, cancel: () => this._cancel(i) });
      this.pending.set(i, {
        head: (status, hdrs) => {
          settled = true;
          resolve(new Response([101, 204, 205, 304].includes(status) || method === 'HEAD' ? null : stream, { status, headers: hdrs }));
        },
        data: (bytes) => { try { controller.enqueue(bytes); } catch { /* reader went away */ } },
        end: () => { this.pending.delete(i); try { controller.close(); } catch { /* cancelled */ } },
        fail: (err) => {
          this.pending.delete(i);
          if (!settled) reject(err);
          try { controller.error(err); } catch { /* cancelled */ }
        },
      });
      signal?.addEventListener('abort', () => { const p = this.pending.get(i); this._cancel(i); p?.fail(new DOMException('Aborted', 'AbortError')); });
      this.ch.send(JSON.stringify({ i, m: method, p: path, h: headers, b: body == null ? null : String(body) }));
    });
  }

  _cancel(i) {
    if (this.pending.delete(i) && this.open) this.ch.send(JSON.stringify({ i, x: 1 }));
  }

  _message(data) {
    if (typeof data === 'string') {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const p = this.pending.get(m.i);
      if (!p) return;
      if (m.pong) p.pong?.();
      else if (m.s) p.head(m.s, m.h || {});
      else if (m.end) p.end();
      else if (m.err) p.fail(new ConnectError(m.err, 'remote'));
      return;
    }
    const p = this.pending.get(new DataView(data).getUint32(0));
    if (p?.data) p.data(new Uint8Array(data, 4));
  }
}
