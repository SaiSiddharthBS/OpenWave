// OpenWave Connect, phone side: reach a paired OpenWave engine from anywhere. The pairing link
// (from the engine's QR code) holds the engine's id and this device's key. We post an encrypted
// WebRTC offer to public relays, the engine answers, and from then on requests travel over a
// direct data channel. See openwave/connect.py for the engine side and the wire format.
import { schnorr, utils } from './vendor/secp256k1.js';

const KIND = 21078;
export const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.snort.social',
  'wss://nostr.oxtr.dev', 'wss://relay.damus.io'];
const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const room = async (prefix, s) => hex(await sha256(enc.encode(prefix + s))).slice(0, 40);
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
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
    const key = unb64url(p.k);
    if (p.v === 1 && /^[0-9a-f]{64}$/.test(p.h) && key.length === 32) return { host: p.h, key, name: String(p.n || 'OpenWave') };
  } catch { /* fall through */ }
  throw new ConnectError('That isn’t an OpenWave pairing link.', 'invalid');
}

async function aesKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(raw, obj, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(raw), enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

async function unseal(raw, blob, aad) {
  try {
    const bytes = unb64(blob);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, await aesKey(raw), bytes.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch { return null; }
}

/** A relay event signed by a throwaway key: who sent it is never linkable. */
async function event(content, tags) {
  const sk = utils.randomSecretKey();
  const pubkey = hex(schnorr.getPublicKey(sk));
  const created_at = Math.floor(Date.now() / 1000);
  const id = await sha256(enc.encode(JSON.stringify([0, pubkey, created_at, KIND, tags, content])));
  return { id: hex(id), pubkey, created_at, kind: KIND, tags, content, sig: hex(await schnorr.signAsync(id, sk)) };
}

/** Post the offer to every relay and resolve with the engine's answer (whichever relay brings it first). */
async function exchange(pair, sdp, { relays = RELAYS, timeout = 20000, log = () => {} } = {}) {
  const session = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hostRoom = await room('openwave-connect:', pair.host);
  const reply = await room('openwave-connect-reply:', session);
  const ev = await event(await seal(pair.key, { t: 'offer', s: session, sdp, ts: Date.now() }, 'offer:' + hostRoom), [['t', hostRoom]]);
  const sockets = [];
  try {
    return await new Promise((resolve, reject) => {
      let failed = 0;
      const timer = setTimeout(() => reject(new ConnectError(`${pair.name} didn’t answer. Is OpenWave open on it?`, 'no-answer')), timeout);
      for (const url of relays) {
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
          const body = await unseal(pair.key, msg[2].content, 'answer:' + reply);
          if (body?.t === 'answer' && body.s === session && typeof body.sdp === 'string') {
            log(`answer via ${url}`);
            clearTimeout(timer);
            resolve(body.sdp);
          }
        };
        ws.onerror = () => {
          if (++failed === relays.length) { clearTimeout(timer); reject(new ConnectError('Couldn’t reach the internet.', 'offline')); }
        };
      }
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

/** Connect to the paired engine. Resolves with a Link once the data channel is open. */
export async function connect(pairing, opts = {}) {
  const log = opts.log || (() => {});
  const pair = typeof pairing === 'string' ? parsePairing(pairing) : pairing;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
  const ch = pc.createDataChannel('openwave', { ordered: true });
  ch.binaryType = 'arraybuffer';
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 2500);
    log('offer ready');
    const answer = await exchange(pair, pc.localDescription.sdp, opts);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ConnectError(`Found ${pair.name}, but couldn’t connect from this network.`, 'no-path')), 15000);
      ch.onopen = () => { clearTimeout(t); resolve(); };
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') { clearTimeout(t); reject(new ConnectError(`Found ${pair.name}, but couldn’t connect from this network.`, 'no-path')); }
      });
    });
    return new Link(pc, ch, pair);
  } catch (e) {
    pc.close();
    throw e;
  }
}

/** An open connection: fetch() works like the browser's, for the engine's /api/ paths. */
export class Link {
  constructor(pc, ch, pair) {
    this.pc = pc;
    this.ch = ch;
    this.pair = pair;
    this.seq = 0;
    this.pending = new Map();
    this.onclose = null;
    ch.onmessage = ({ data }) => this._message(data);
    const closed = () => {
      for (const p of this.pending.values()) p.fail(new ConnectError('Connection lost.', 'lost'));
      this.pending.clear();
      this.onclose?.();
    };
    ch.onclose = closed;
    pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed'].includes(pc.connectionState)) closed(); });
  }

  get open() { return this.ch.readyState === 'open'; }

  close() { this.pc.close(); }

  /** Which way the connection went: "direct" (same network or through the routers) or "relay". */
  async route() {
    const stats = await this.pc.getStats();
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
        const local = stats.get(s.localCandidateId);
        const remote = stats.get(s.remoteCandidateId);
        return { local: local?.candidateType, remote: remote?.candidateType, rtt: s.currentRoundTripTime };
      }
    }
    return null;
  }

  fetch(path, { method = 'GET', headers = {}, body = null, signal } = {}) {
    if (!this.open) return Promise.reject(new ConnectError('Not connected.', 'lost'));
    const i = ++this.seq;
    const h = headers instanceof Headers ? Object.fromEntries(headers) : { ...headers };
    return new Promise((resolve, reject) => {
      let controller;
      const stream = new ReadableStream({ start: (c) => { controller = c; }, cancel: () => this._cancel(i) });
      this.pending.set(i, {
        head: (status, hdrs) => resolve(new Response([101, 204, 205, 304].includes(status) ? null : stream, { status, headers: hdrs })),
        data: (bytes) => controller.enqueue(bytes),
        end: () => { this.pending.delete(i); try { controller.close(); } catch { /* cancelled */ } },
        fail: (err) => { this.pending.delete(i); reject(err); try { controller.error(err); } catch { /* cancelled */ } },
      });
      signal?.addEventListener('abort', () => { this._cancel(i); this.pending.get(i)?.fail(new DOMException('Aborted', 'AbortError')); });
      this.ch.send(JSON.stringify({ i, m: method, p: path, h, b: body == null ? null : String(body) }));
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
      if (m.s) p.head(m.s, m.h || {});
      else if (m.end) p.end();
      else if (m.err) p.fail(new ConnectError(m.err, 'remote'));
      return;
    }
    const view = new DataView(data);
    const p = this.pending.get(view.getUint32(0));
    if (p) p.data(new Uint8Array(data, 4));
  }
}
