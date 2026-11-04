// Web Push for the installed web app (docs/PUSH.md), mainly for iPhones, which get no native app: Safari on iOS 16.4+
// delivers Web Push to a web app added to the Home Screen. The browser subscribes with this server's VAPID public key
// and gives its push endpoint and keys to the signed-in owner (web_push_subscriptions). When a companion message is
// delivered, each subscription gets a notification payload encrypted for that browser alone (RFC 8291, aes128gcm), so
// the push service (Apple, Google or Mozilla) only relays ciphertext. No dependencies: Node's crypto does ECDH, HKDF,
// AES-GCM and the ES256 VAPID signature (RFC 8292).
import { createCipheriv, createECDH, createHmac, createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PushError } from './push.mjs';

const MAX_SUBSCRIPTIONS = 10;
const RECENT = 500;
const PREVIEW = 180;
// While the app is open on the chat it reports itself present every 15 s; that device gets no push for 40 s after.
export const PRESENCE_MS = 40_000;
// Only the browsers' own push services: an endpoint is a URL this server will POST to, so it must not point anywhere else.
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^jmt[0-9]{1,3}\.google\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const b64 = value => Buffer.from(value).toString('base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function pushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return PUSH_HOSTS.some(host => host.test(url.hostname)) ? url.href : null;
}

function decodeKey(value, length) {
  if (typeof value !== 'string' || !B64URL.test(value) || value.length > 200) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length ? bytes : null;
}

export class WebPushSubscriptions {
  #db; #now; #present = new Map();
  constructor({ store, now = Date.now }) {
    this.#db = store.db; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS web_push_subscriptions(endpoint TEXT PRIMARY KEY, companion_id TEXT NOT NULL,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, preview INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS web_push_subscriptions_companion ON web_push_subscriptions(companion_id)`);
  }

  // A subscription belongs to whoever saved it last, like an Android token.
  subscribe(companionId, { endpoint, p256dh, auth, preview = true }) {
    const url = pushEndpoint(endpoint), key = decodeKey(p256dh, 65), secret = decodeKey(auth, 16);
    if (!url || !key || key[0] !== 4 || !secret || typeof preview !== 'boolean') throw new PushError('INVALID_REQUEST');
    const now = this.#now();
    this.#db.prepare(`INSERT INTO web_push_subscriptions(endpoint, companion_id, p256dh, auth, preview, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET companion_id=excluded.companion_id, p256dh=excluded.p256dh,
      auth=excluded.auth, preview=excluded.preview, updated_at=excluded.updated_at`).run(url, companionId, b64(key), b64(secret), preview ? 1 : 0, now, now);
    this.#db.prepare(`DELETE FROM web_push_subscriptions WHERE companion_id=? AND endpoint NOT IN (
      SELECT endpoint FROM web_push_subscriptions WHERE companion_id=? ORDER BY updated_at DESC LIMIT ?)`).run(companionId, companionId, MAX_SUBSCRIPTIONS);
    return { subscribed: true, preview };
  }

  unsubscribe(companionId, endpoint) {
    const url = pushEndpoint(endpoint);
    if (!url) throw new PushError('INVALID_REQUEST');
    this.#db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint=? AND companion_id=?').run(url, companionId);
    return { subscribed: false };
  }

  // Whether this browser's endpoint is saved for this owner, so the switch shows the server's truth.
  status(companionId, endpoint) {
    const url = pushEndpoint(endpoint);
    if (!url) return { subscribed: false };
    const row = this.#db.prepare('SELECT preview FROM web_push_subscriptions WHERE endpoint=? AND companion_id=?').get(url, companionId);
    return row ? { subscribed: true, preview: row.preview === 1 } : { subscribed: false };
  }

  list(companionId) {
    return this.#db.prepare('SELECT endpoint, p256dh, auth, preview FROM web_push_subscriptions WHERE companion_id=? ORDER BY updated_at DESC')
      .all(companionId).map(row => ({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, preview: row.preview === 1 }));
  }

  forget(endpoint) { this.#db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint=?').run(endpoint); this.#present.delete(endpoint); }

  // The app is open and in front on the chat (present) or just left it. Decided here rather than in the service worker
  // because Safari may revoke a subscription whose pushes show nothing: the push is simply not sent. Memory only.
  presence(companionId, endpoint, present) {
    const url = pushEndpoint(endpoint);
    if (!url || typeof present !== 'boolean') throw new PushError('INVALID_REQUEST');
    const owned = this.#db.prepare('SELECT 1 FROM web_push_subscriptions WHERE endpoint=? AND companion_id=?').get(url, companionId);
    if (owned && present) this.#present.set(url, this.#now() + PRESENCE_MS); else this.#present.delete(url);
    return { present: Boolean(owned && present) };
  }

  isPresent(endpoint) {
    const until = this.#present.get(endpoint);
    if (until === undefined) return false;
    if (until > this.#now()) return true;
    this.#present.delete(endpoint);
    return false;
  }
}

// This server's VAPID key pair, created on first use (chmod 600). Replacing it invalidates every subscription.
export function loadVapidKeys(file) {
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(privateKey.export({ format: 'jwk' })) + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
  }
  const jwk = JSON.parse(readFileSync(file, 'utf8'));
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new PushError('PUSH_UNCONFIGURED', 503);
  return { privateKey: createPrivateKey({ key: jwk, format: 'jwk' }),
    publicKey: b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])) };
}

// RFC 8291 message encryption with one aes128gcm record.
export function encryptPayload(payload, { p256dh, auth }, { salt = randomBytes(16), ecdh = null } = {}) {
  const client = Buffer.from(p256dh, 'base64url'), secret = Buffer.from(auth, 'base64url');
  const local = ecdh ?? createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const server = local.getPublicKey(), shared = local.computeSecret(client);
  const ikm = hmac(hmac(secret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), client, server, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const key = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = server.length;
  return Buffer.concat([header, server, body]);
}

export class WebPushSender {
  #keys; #loaded = null; #fetch; #now; #subject;
  // keys: the pair, or a function returning it, so the key file is only read (or created) once Web Push is used.
  constructor({ keys, fetchImpl = fetch, now = Date.now, subject = 'https://blackoutburst.com/' }) {
    this.#keys = keys; this.#fetch = fetchImpl; this.#now = now; this.#subject = subject;
  }

  get #pair() { return (this.#loaded ??= typeof this.#keys === 'function' ? this.#keys() : this.#keys); }
  get publicKey() { return this.#pair.publicKey; }

  #vapid(endpoint) {
    const unsigned = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64(JSON.stringify({ aud: new URL(endpoint).origin,
      exp: Math.floor(this.#now() / 1000) + 12 * 3600, sub: this.#subject }));
    const signature = createSign('SHA256').update(unsigned).sign({ key: this.#pair.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${unsigned}.${b64(signature)}, k=${this.#pair.publicKey}`;
  }

  // Returns 'sent', 'gone' (the browser dropped the subscription) or 'failed'.
  async send(subscription, payload) {
    const response = await this.#fetch(subscription.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: this.#vapid(subscription.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: '86400', Urgency: 'high' }, body: encryptPayload(JSON.stringify(payload), subscription) });
    if (response.ok) return 'sent';
    return [404, 410].includes(response.status) ? 'gone' : 'failed';
  }
}

// A short plain-text preview of a companion message: markdown marks out, whitespace collapsed.
export function previewText(text) {
  return String(text ?? '').replace(/```[^\n]*\n?/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+)/gm, '').replace(/[*_~`]+/g, '').replace(/\s+/g, ' ').trim();
}

export class WebPushNotifier {
  #subscriptions; #sender; #nameFor; #log; #recent = new Set();
  constructor({ subscriptions, sender, nameFor = () => null, log = () => {} }) {
    this.#subscriptions = subscriptions; this.#sender = sender; this.#nameFor = nameFor; this.#log = log;
  }

  // Conversations' settle hook, the same events as Android push.
  settled({ companionId, threadId, requestId, state, text, messageId, board }) {
    if (state !== 'complete' || typeof messageId !== 'string' || typeof threadId !== 'string') return;
    if (typeof requestId === 'string' && requestId.startsWith('discord-')) return;
    if (this.#recent.has(messageId)) return;
    this.#recent.add(messageId);
    if (this.#recent.size > RECENT) this.#recent.delete(this.#recent.values().next().value);
    const subscriptions = this.#subscriptions.list(companionId).filter(row => !this.#subscriptions.isPresent(row.endpoint));
    if (!subscriptions.length) return;
    const title = String(this.#nameFor(companionId) ?? '').slice(0, 60) || 'Your companion';
    let preview = previewText(text);
    if (preview.length > PREVIEW) preview = preview.slice(0, PREVIEW - 1).trimEnd() + '…';
    this.#deliver(subscriptions, { type: 'message', threadId, messageId, title, ...(board ? { board: true } : {}) }, preview || 'New message')
      .catch(error => this.#log(`Web push failed: ${error.code ?? error.message}`));
  }

  async #deliver(subscriptions, base, preview) {
    const counts = { sent: 0, gone: 0, failed: 0 };
    for (const subscription of subscriptions) {
      let result = 'failed';
      try { result = await this.#sender.send(subscription, { ...base, body: subscription.preview ? preview : 'New message' }); }
      catch (error) { this.#log(`Web push failed: ${error.code ?? error.message}`); }
      counts[result] = (counts[result] ?? 0) + 1;
      if (result === 'gone') this.#subscriptions.forget(subscription.endpoint);
    }
    this.#log(`Web push sent ${counts.sent}, gone ${counts.gone}, failed ${counts.failed}`);
  }
}
