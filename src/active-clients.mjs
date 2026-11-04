// Active clients and held pushes (#59, docs/PUSH.md). While the owner is actively using any client (a web or PWA tab
// that is visible, focused and had input in the last 2 minutes, or the Android app in the foreground and touched
// recently), a companion message is not pushed to their other devices at once. It is held for HOLD_MS; if by then a
// client showed its conversation while active, the push (and the Discord mirror of a proactive message) is dropped,
// otherwise it goes out as usual. With no active client, everything is delivered at once, exactly as before.
// Presence is memory only and expires on its own; held messages are also written to the store so a restart delivers
// them (fail open: a restart can make a push late, never lost).
import { PushError } from './push.mjs';

// Clients report every 20 s while active; one that stops reporting (closed laptop, killed app) stops counting after this.
export const ACTIVE_TTL_MS = 50_000;
// How long a message waits for the active client to show it before the push goes out anyway.
export const HOLD_MS = 90_000;
const CLIENT = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CLIENTS = 16, MAX_VIEWED = 32, VIEWED_KEEP_MS = 15 * 60_000;

export class ActiveClients {
  #now; #owners = new Map(); #idle = [];
  constructor({ now = Date.now } = {}) { this.#now = now; }

  // Called when an owner's last active client reports inactive (not on silent expiry; held messages then wait out the delay).
  onIdle(listener) { this.#idle.push(listener); }

  #owner(companionId) {
    let owner = this.#owners.get(companionId);
    if (!owner) this.#owners.set(companionId, owner = { clients: new Map(), viewed: new Map() });
    return owner;
  }

  // client: a random id per tab or app run. threadId: the companion conversation on screen, if any. An inactive report
  // from a client that was active still counts its thread as seen: it was on screen until now.
  report(companionId, { client, active, threadId = null } = {}) {
    if (typeof client !== 'string' || !CLIENT.test(client) || typeof active !== 'boolean'
      || (threadId !== null && (typeof threadId !== 'string' || !UUID.test(threadId)))) throw new PushError('INVALID_REQUEST');
    const now = this.#now(), owner = this.#owner(companionId), was = this.isActive(companionId);
    const counted = owner.clients.has(client);
    if (threadId && (active || counted)) {
      owner.viewed.delete(threadId); owner.viewed.set(threadId, now);
      for (const [id, at] of owner.viewed) if (owner.viewed.size > MAX_VIEWED || now - at > VIEWED_KEEP_MS) owner.viewed.delete(id);
    }
    owner.clients.delete(client);
    if (active) {
      owner.clients.set(client, now + ACTIVE_TTL_MS);
      while (owner.clients.size > MAX_CLIENTS) owner.clients.delete(owner.clients.keys().next().value);
    }
    if (was && !this.isActive(companionId)) for (const listener of this.#idle) { try { listener(companionId); } catch { /* push problems only */ } }
    return { active };
  }

  isActive(companionId) {
    const owner = this.#owners.get(companionId);
    if (!owner) return false;
    const now = this.#now();
    for (const [client, until] of owner.clients) if (until <= now) owner.clients.delete(client);
    return owner.clients.size > 0;
  }

  // Whether an active client had this conversation on screen at or after `since`.
  viewedSince(companionId, threadId, since) {
    const at = this.#owners.get(companionId)?.viewed.get(threadId);
    return at !== undefined && at >= since;
  }
}

// Sits between Conversations' settle hook (and group chat's message hook) and the notifiers: Android push, Web Push
// and the Discord bridge. Only finished companion messages that did not come in through Discord are ever held.
export class PushHold {
  #db; #clients; #deliver; #deliverGroup; #groupRead; #holdMs; #now; #log; #timers = new Map();
  constructor({ store, clients, deliver, deliverGroup = () => {}, groupRead = () => false, holdMs = HOLD_MS, now = Date.now, log = () => {} }) {
    this.#db = store.db; this.#clients = clients; this.#deliver = deliver; this.#deliverGroup = deliverGroup; this.#groupRead = groupRead;
    this.#holdMs = holdMs; this.#now = now; this.#log = log;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS push_holds(id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, kind TEXT NOT NULL,
      event_json TEXT NOT NULL, held_at INTEGER NOT NULL)`);
    clients.onIdle(companionId => this.#owner(companionId));
  }

  // Conversations' onSettled event.
  settled(event) {
    const holdable = event?.state === 'complete' && typeof event.messageId === 'string' && typeof event.threadId === 'string'
      && !(typeof event.requestId === 'string' && event.requestId.startsWith('discord-')) && this.#clients.isActive(event.companionId);
    if (!holdable) return this.#send('message', event);
    this.#hold('message', event.messageId, event);
  }

  // Group chat's per-member message event (#53).
  group(event) {
    if (typeof event?.messageId !== 'string' || typeof event.groupId !== 'string' || !this.#clients.isActive(event.companionId)) return this.#send('group', event);
    this.#hold('group', event.companionId + ':' + event.messageId, event);
  }

  #send(kind, event) {
    try { if (kind === 'group') this.#deliverGroup(event); else this.#deliver(event); }
    catch (error) { this.#log(`Push delivery failed: ${error.code ?? error.message}`); }
  }

  #hold(kind, id, event) {
    if (this.#timers.has(id)) return;
    try {
      const changed = this.#db.prepare('INSERT INTO push_holds(id, companion_id, kind, event_json, held_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(id, event.companionId, kind, JSON.stringify(event), this.#now()).changes;
      if (!changed) return;
    } catch { return this.#send(kind, event); }
    const timer = setTimeout(() => this.#decide(id), this.#holdMs);
    timer.unref?.();
    this.#timers.set(id, timer);
  }

  // Read by now: dropped. Otherwise delivered as usual.
  #decide(id) {
    clearTimeout(this.#timers.get(id)); this.#timers.delete(id);
    let row;
    try {
      row = this.#db.prepare('SELECT * FROM push_holds WHERE id=?').get(id);
      if (!row) return;
      this.#db.prepare('DELETE FROM push_holds WHERE id=?').run(id);
    } catch { return; }
    const event = JSON.parse(row.event_json);
    let read = false;
    try {
      read = row.kind === 'group' ? this.#groupRead(event.companionId, event.groupId, event.messageId) === true
        : this.#clients.viewedSince(event.companionId, event.threadId, row.held_at);
    } catch { read = false; }
    if (read) { this.#log('Held push dropped: read on an active client'); return; }
    this.#send(row.kind, event);
  }

  // The owner's last active client went inactive: decide their held messages now instead of waiting out the delay.
  #owner(companionId) {
    for (const row of this.#db.prepare('SELECT id FROM push_holds WHERE companion_id=?').all(companionId)) if (this.#timers.has(row.id)) this.#decide(row.id);
  }

  // At start: what a previous run still held is delivered now (presence did not survive the restart).
  recover() {
    for (const row of this.#db.prepare('SELECT id FROM push_holds ORDER BY held_at').all()) {
      if (this.#timers.has(row.id)) continue;
      const held = this.#db.prepare('SELECT * FROM push_holds WHERE id=?').get(row.id);
      this.#db.prepare('DELETE FROM push_holds WHERE id=?').run(row.id);
      try { this.#send(held.kind, JSON.parse(held.event_json)); } catch { /* unreadable row: nothing to send */ }
    }
  }

  // Shutdown: timers stop; the rows stay for recover() on the next start.
  stop() { for (const timer of this.#timers.values()) clearTimeout(timer); this.#timers.clear(); }

  get held() { return this.#timers.size; }
}
