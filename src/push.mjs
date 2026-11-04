// Android push notifications (docs/PUSH.md). The app registers its Firebase Cloud Messaging token for the signed-in
// owner. When a companion message is delivered (a reply or a proactive message), each of that owner's devices gets a
// data-only FCM message carrying ids, never message text: the app fetches the text from this server itself and shows
// the notification, or stays quiet if that chat is already open. Turns that came in through Discord are not pushed;
// Discord notifies for those itself.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN = /^[A-Za-z0-9_:-]{20,4096}$/;
const MAX_DEVICES = 10;
const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const RECENT = 500;

export class PushError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'PushError'; this.code = code; this.status = status; }
}

export class PushDevices {
  #db; #now;
  constructor({ store, now = Date.now }) {
    this.#db = store.db; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS push_devices(token TEXT PRIMARY KEY, companion_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS push_devices_companion ON push_devices(companion_id)`);
  }

  // A token belongs to whoever registered it last: the same phone signing in to another account moves it.
  register(companionId, token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new PushError('INVALID_REQUEST');
    const now = this.#now();
    this.#db.prepare(`INSERT INTO push_devices(token, companion_id, created_at, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET companion_id=excluded.companion_id, updated_at=excluded.updated_at`).run(token, companionId, now, now);
    // Keep the newest few per owner; stale installs drop off.
    this.#db.prepare(`DELETE FROM push_devices WHERE companion_id=? AND token NOT IN (
      SELECT token FROM push_devices WHERE companion_id=? ORDER BY updated_at DESC LIMIT ?)`).run(companionId, companionId, MAX_DEVICES);
    return { registered: true };
  }

  // Only the owner's own registration can be removed this way.
  unregister(companionId, token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new PushError('INVALID_REQUEST');
    this.#db.prepare('DELETE FROM push_devices WHERE token=? AND companion_id=?').run(token, companionId);
    return { registered: false };
  }

  tokens(companionId) {
    return this.#db.prepare('SELECT token FROM push_devices WHERE companion_id=? ORDER BY updated_at DESC').all(companionId).map(row => row.token);
  }

  forget(token) { this.#db.prepare('DELETE FROM push_devices WHERE token=?').run(token); }
}

// FCM HTTP v1 with a service-account key. The key file is read when first needed and never logged.
export class FcmSender {
  #keyFile; #fetch; #now; #key = null; #access = null;
  constructor({ keyFile, fetchImpl = fetch, now = Date.now }) { this.#keyFile = keyFile; this.#fetch = fetchImpl; this.#now = now; }

  #loadKey() {
    if (this.#key) return this.#key;
    const key = JSON.parse(readFileSync(this.#keyFile, 'utf8'));
    if (key?.type !== 'service_account' || typeof key.private_key !== 'string' || typeof key.client_email !== 'string'
        || typeof key.project_id !== 'string') throw new PushError('PUSH_UNCONFIGURED', 503);
    return (this.#key = key);
  }

  async #token() {
    if (this.#access && this.#access.expires > this.#now() + 60_000) return this.#access.value;
    const key = this.#loadKey(), issued = Math.floor(this.#now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iss: key.client_email, scope: SCOPE,
      aud: OAUTH_URL, iat: issued, exp: issued + 3600 });
    const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
    const response = await this.#fetch(OAUTH_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') throw new PushError('PUSH_AUTH_FAILED', 502);
    this.#access = { value: body.access_token, expires: this.#now() + (Number(body.expires_in) || 3600) * 1000 };
    return this.#access.value;
  }

  // Returns 'sent', 'gone' (the token is no longer valid) or 'failed'.
  async send(token, data) {
    const key = this.#loadKey(), access = await this.#token();
    const response = await this.#fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(key.project_id)}/messages:send`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '86400s' } } }) });
    if (response.ok) return 'sent';
    if (response.status === 401) this.#access = null;
    const body = await response.json().catch(() => ({}));
    const codes = (body?.error?.details ?? []).map(detail => detail?.errorCode);
    if (response.status === 404 || codes.includes('UNREGISTERED') || (response.status === 400 && codes.includes('INVALID_ARGUMENT'))) return 'gone';
    return 'failed';
  }
}

export class PushNotifier {
  #devices; #sender; #nameFor; #log; #recent = new Set();
  constructor({ devices, sender, nameFor = () => null, log = () => {} }) {
    this.#devices = devices; this.#sender = sender; this.#nameFor = nameFor; this.#log = log;
  }

  // Conversations' settle hook: a finished reply or a delivered proactive message.
  settled({ companionId, threadId, requestId, state, text, messageId, board }) {
    if (state !== 'complete' || typeof messageId !== 'string' || typeof threadId !== 'string') return;
    if (typeof requestId === 'string' && requestId.startsWith('discord-')) return;
    if (this.#recent.has(messageId)) return;
    this.#recent.add(messageId);
    if (this.#recent.size > RECENT) this.#recent.delete(this.#recent.values().next().value);
    const tokens = this.#devices.tokens(companionId);
    if (!tokens.length) return;
    const name = String(this.#nameFor(companionId) ?? '').slice(0, 60);
    // board: a Board sub-conversation's message (#55), so tapping it opens the Board tab on that thread. Flag only, no text.
    const data = { type: 'message', threadId, messageId, ...(name ? { name } : {}), ...(board ? { board: '1' } : {}) };
    this.#deliver(tokens, data).catch(error => this.#log(`Push failed: ${error.code ?? error.message}`));
  }

  async #deliver(tokens, data) {
    const counts = { sent: 0, gone: 0, failed: 0 };
    for (const token of tokens) {
      let result = 'failed';
      try { result = await this.#sender.send(token, data); }
      catch (error) { this.#log(`Push failed: ${error.code ?? error.message}`); }
      counts[result] = (counts[result] ?? 0) + 1;
      if (result === 'gone') this.#devices.forget(token);
    }
    // Counts only (no ids, tokens or text), so delivery latency can be measured from the journal.
    this.#log(`Push handed to FCM: sent ${counts.sent}, gone ${counts.gone}, failed ${counts.failed}`);
  }
}
