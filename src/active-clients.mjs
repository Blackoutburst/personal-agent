// Active clients and held pushes (#59, docs/PUSH.md). Two presence levels per client:
// - present: a signed-in web or PWA tab that is open, whatever its visibility or focus (#59 follow-up: a background
//   tab counts), or an active client;
// - active: a tab that is visible, focused and had input in the last 2 minutes, or the Android app in the foreground
//   and touched recently. Only an active client showing a conversation counts as the owner seeing it.
// While the owner has a present client, a companion message is not pushed to their devices at once: it is held for
// HOLD_MS; if by then an active client showed its conversation, the push (and the Discord mirror of a proactive
// message) is dropped, otherwise it goes out as usual. A background tab therefore delays pushes, never swallows them
// unless the owner looked. With no present client, everything is delivered at once, exactly as before.
// Presence is memory only and expires on its own; held messages are also written to the store so a restart delivers
// them (fail open: a restart can make a push late, never lost).
import { PushError } from './push.mjs';

// Active clients report every 20 s; one that stops reporting (closed laptop, killed app) stops counting after this.
export const ACTIVE_TTL_MS = 50_000;
// Open tabs report every 30 s, but a hidden tab's timers are throttled by the browser (to once a minute after a few
// minutes), so an open report lasts long enough to survive one late or missed beat.
export const OPEN_TTL_MS = 150_000;
// How long a message waits for an active client to show it before the push goes out anyway.
export const HOLD_MS = 90_000;
export const STATES = Object.freeze(['active', 'open', 'closed']);
const CLIENT = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CLIENTS = 16, MAX_VIEWED = 32, VIEWED_KEEP_MS = 15 * 60_000;

export class ActiveClients {
  #now; #owners = new Map(); #away = [];
  constructor({ now = Date.now } = {}) { this.#now = now; }

  // Called when an owner's last present client reports closed (not on silent expiry; held messages then wait out the
  // delay). An active client going to the background is still present, so its holds keep waiting for a look.
  onAway(listener) { this.#away.push(listener); }

  #owner(companionId) {
    let owner = this.#owners.get(companionId);
    if (!owner) this.#owners.set(companionId, owner = { clients: new Map(), viewed: new Map() });
    return owner;
  }

  // client: a random id per tab or app run. state: 'active', 'open' or 'closed'; older clients (Android 0.25.x, web
  // tabs loaded before this change) send only the boolean `active`: true is 'active', false is 'closed' (the app went
  // to the background, the old tab lost focus), so they behave exactly as before. threadId: the companion conversation
  // on screen, if any. A report from a client that was active until now still counts its thread as seen: it was on
  // screen until this moment.
  report(companionId, { client, active, state, threadId = null } = {}) {
    if (typeof client !== 'string' || !CLIENT.test(client)
      || (state !== undefined && !STATES.includes(state)) || (active !== undefined && typeof active !== 'boolean')
      || (state === undefined && active === undefined)
      || (threadId !== null && (typeof threadId !== 'string' || !UUID.test(threadId)))) throw new PushError('INVALID_REQUEST');
    const level = state ?? (active ? 'active' : 'closed');
    const now = this.#now(), owner = this.#owner(companionId), was = this.isPresent(companionId);
    const wasActive = (owner.clients.get(client)?.activeUntil ?? 0) > now;
    if (threadId && (level === 'active' || wasActive)) {
      owner.viewed.delete(threadId); owner.viewed.set(threadId, now);
      for (const [id, at] of owner.viewed) if (owner.viewed.size > MAX_VIEWED || now - at > VIEWED_KEEP_MS) owner.viewed.delete(id);
    }
    const previous = owner.clients.get(client);
    owner.clients.delete(client);
    if (level !== 'closed') {
      // An active report does not extend the open time: an active client that vanishes stops counting after 50 s.
      owner.clients.set(client, level === 'active'
        ? { activeUntil: now + ACTIVE_TTL_MS, openUntil: previous?.openUntil ?? 0 }
        : { activeUntil: 0, openUntil: now + OPEN_TTL_MS });
      while (owner.clients.size > MAX_CLIENTS) owner.clients.delete(owner.clients.keys().next().value);
    }
    if (was && !this.isPresent(companionId)) for (const listener of this.#away) { try { listener(companionId); } catch { /* push problems only */ } }
    return { active: level === 'active', state: level };
  }

  #live(companionId) {
    const owner = this.#owners.get(companionId);
    if (!owner) return [];
    const now = this.#now();
    for (const [client, entry] of owner.clients) if (Math.max(entry.activeUntil, entry.openUntil) <= now) owner.clients.delete(client);
    return [...owner.clients.values()];
  }

  // Any client in active use.
  isActive(companionId) { const now = this.#now(); return this.#live(companionId).some(entry => entry.activeUntil > now); }

  // Any client open at all (active ones included): pushes are held.
  isPresent(companionId) { return this.#live(companionId).length > 0; }

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
    clients.onAway(companionId => this.#owner(companionId));
  }

  // Conversations' onSettled event.
  settled(event) {
    const holdable = event?.state === 'complete' && typeof event.messageId === 'string' && typeof event.threadId === 'string'
      && !(typeof event.requestId === 'string' && event.requestId.startsWith('discord-')) && this.#clients.isPresent(event.companionId);
    if (!holdable) return this.#send('message', event);
    this.#hold('message', event.messageId, event);
  }

  // Group chat's per-member message event (#53): held the same way while the member has a present client.
  group(event) {
    if (typeof event?.messageId !== 'string' || typeof event.groupId !== 'string' || !this.#clients.isPresent(event.companionId)) return this.#send('group', event);
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

  // The owner's last present client closed: decide their held messages now instead of waiting out the delay.
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
