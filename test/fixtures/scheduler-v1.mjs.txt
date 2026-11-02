import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/, HASH = /^[a-f0-9]{64}$/, CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const PERIOD = 6 * 3600000, GRACE = 24 * 3600000;
const TERMINAL = new Set(['message', 'silent', 'cancelled', 'interrupted', 'error', 'missed']);
const CODES = new Set(['INVALID_REQUEST', 'NOT_FOUND', 'CONFLICT', 'CAPACITY', 'UNAVAILABLE', 'IDENTITY_CHANGED']);
export class SchedulerError extends Error {
  constructor(code = 'UNAVAILABLE') {
    const value = typeof code === 'string' ? code.replace(/^SCHEDULER_/, '') : '';
    super('The reminder request could not proceed.');
    this.name = 'SchedulerError'; this.code = 'SCHEDULER_' + (CODES.has(value) ? value : 'UNAVAILABLE');
  }
}
function requireSchedule(value, code = 'INVALID_REQUEST') { if (!value) throw new SchedulerError(code); }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function shape(value, required, optional = []) {
  try {
    requireSchedule(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    requireSchedule(required.every(key => keys.includes(key)) && keys.every(key => typeof key === 'string'
      && [...required, ...optional].includes(key) && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')));
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  } catch { throw new SchedulerError('INVALID_REQUEST'); }
}
function text(value) {
  requireSchedule(typeof value === 'string' && value.isWellFormed() && value.trim() && value.length <= 2000
    && Buffer.byteLength(value) <= 8000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
  return value.trim();
}
function instant(value) {
  requireSchedule(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value));
  const result = Date.parse(value); requireSchedule(integer(result) && result <= 8640000000000000);
  const [year, month, day, hour, minute] = value.match(/\d+/g).slice(0, 5).map(Number);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, 0, 0);
  requireSchedule(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && hour < 24 && minute < 60);
  return result;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => new Date(value).toISOString();
const occurrence = row => ({ id: row.id, kind: row.kind, prompt: row.prompt, jobId: row.job_id,
  generation: row.generation, dueAt: iso(row.due_at) });
const reminder = row => ({ id: row.id, version: row.version, text: row.text, dueAt: iso(row.due_at), state: row.state,
  canCancel: row.state === 'active' });
const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_settings(companion_id TEXT PRIMARY KEY,identity_key TEXT NOT NULL,
 enabled INTEGER NOT NULL,quiet_start TEXT NOT NULL,quiet_end TEXT NOT NULL,heartbeat_enabled INTEGER NOT NULL,
 heartbeat_generation INTEGER NOT NULL,heartbeat_next_at INTEGER,last_started_at INTEGER,cooldown_until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduler_jobs(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,text TEXT NOT NULL,due_at INTEGER NOT NULL,version INTEGER NOT NULL,generation INTEGER NOT NULL,
 state TEXT NOT NULL,UNIQUE(companion_id,request_id));
CREATE TABLE IF NOT EXISTS scheduler_occurrences(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,slot_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,kind TEXT NOT NULL,prompt TEXT NOT NULL,job_id TEXT,generation INTEGER NOT NULL,due_at INTEGER NOT NULL,
 state TEXT NOT NULL,admitted_at INTEGER,UNIQUE(companion_id,slot_key));
CREATE TABLE IF NOT EXISTS scheduler_days(companion_id TEXT NOT NULL,local_day TEXT NOT NULL,turns INTEGER NOT NULL,
 PRIMARY KEY(companion_id,local_day));`;

export class SchedulerStore {
  #db; #timezone; #now; #spacing; #cap;
  constructor({ store, timezoneFor = () => 'UTC', now = Date.now, minSpacingMs = 300000, maxTurnsPerDay = 24 }) {
    requireSchedule(store?.db && typeof timezoneFor === 'function' && typeof now === 'function'
      && integer(minSpacingMs) && integer(maxTurnsPerDay, 1, 1000));
    this.#db = store.db; this.#timezone = timezoneFor; this.#now = now; this.#spacing = minSpacingMs; this.#cap = maxTurnsPerDay;
    this.#tx(() => this.#db.exec(SCHEMA));
  }
  #tx(run) {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try { const result = run(); this.#db.exec('COMMIT'); return result; }
      catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* Keep fixed errors. */ } throw error; }
    } catch (error) { throw error instanceof SchedulerError ? error : new SchedulerError(); }
  }
  #time() { const time = this.#now(); requireSchedule(integer(time) && time <= 8640000000000000, 'UNAVAILABLE'); return time; }
  #owner(companionId, create = true) {
    requireSchedule(typeof companionId === 'string' && UUID.test(companionId));
    let identity = null;
    for (const row of this.#db.prepare("SELECT key,value_json FROM bootstrap_record WHERE namespace='companion-identity-v1'").all()) {
      let value; try { value = shape(JSON.parse(row.value_json), ['companionId']); } catch { throw new SchedulerError('IDENTITY_CHANGED'); }
      requireSchedule(HASH.test(row.key) && typeof value.companionId === 'string' && UUID.test(value.companionId), 'IDENTITY_CHANGED');
      if (value.companionId === companionId) { requireSchedule(identity === null, 'IDENTITY_CHANGED'); identity = row.key; }
    }
    requireSchedule(identity, 'NOT_FOUND');
    let settings = this.#db.prepare('SELECT * FROM scheduler_settings WHERE companion_id=?').get(companionId);
    if (!settings && create) {
      this.#db.prepare("INSERT INTO scheduler_settings VALUES(?,?,1,'22:00','08:00',0,1,NULL,NULL,0)").run(companionId, identity);
      settings = this.#db.prepare('SELECT * FROM scheduler_settings WHERE companion_id=?').get(companionId);
    }
    requireSchedule(!settings || settings.identity_key === identity, 'IDENTITY_CHANGED');
    return settings;
  }
  #zone(companionId) {
    try {
      const value = this.#timezone(companionId); requireSchedule(typeof value === 'string' && value.length <= 100);
      new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return value;
    } catch { throw new SchedulerError('UNAVAILABLE'); }
  }
  #local(companionId, time) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: this.#zone(companionId),
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(time).map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
  }
  #quiet(companionId, settings, time) {
    const minute = this.#local(companionId, time).minute;
    const number = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const start = number(settings.quiet_start), end = number(settings.quiet_end);
    return start === end ? false : start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }
  #snapshot(companionId) {
    const settings = this.#owner(companionId), time = this.#time();
    const jobs = this.#db.prepare(`SELECT * FROM scheduler_jobs WHERE companion_id=? AND (state='active' OR id IN (
      SELECT id FROM scheduler_jobs WHERE companion_id=? AND state!='active' ORDER BY rowid DESC LIMIT 10))
      ORDER BY due_at,id`).all(companionId, companionId);
    return { now: iso(time), timezone: this.#zone(companionId), settings: { enabled: !!settings.enabled,
      quietStart: settings.quiet_start, quietEnd: settings.quiet_end, heartbeatEnabled: !!settings.heartbeat_enabled },
    items: jobs.map(reminder) };
  }
  create(companionId, input) {
    const value = shape(input, ['requestId', 'text', 'dueAt']); requireSchedule(typeof value.requestId === 'string' && REQUEST.test(value.requestId));
    const selected = { text: text(value.text), dueAt: instant(value.dueAt) }, fingerprint = digest(selected);
    return this.#tx(() => {
      this.#owner(companionId);
      const prior = this.#db.prepare('SELECT * FROM scheduler_jobs WHERE companion_id=? AND request_id=?').get(companionId, value.requestId);
      if (prior) requireSchedule(prior.fingerprint === fingerprint, 'CONFLICT');
      else {
        requireSchedule(this.#db.prepare("SELECT COUNT(*) AS n FROM scheduler_jobs WHERE companion_id=? AND state='active'").get(companionId).n < 50, 'CAPACITY');
        this.#db.prepare("INSERT INTO scheduler_jobs VALUES(?,?,?,?,?,?,1,1,'active')")
          .run(randomUUID(), companionId, value.requestId, fingerprint, selected.text, selected.dueAt);
      }
      const created = this.#db.prepare('SELECT * FROM scheduler_jobs WHERE companion_id=? AND request_id=?').get(companionId, value.requestId);
      return { ...this.#snapshot(companionId), created: reminder(created) };
    });
  }
  list(companionId) { return this.#tx(() => this.#snapshot(companionId)); }
  cancel(companionId, input) {
    const { id } = shape(input, ['id']); requireSchedule(typeof id === 'string' && UUID.test(id));
    return this.#tx(() => {
      this.#owner(companionId);
      const job = this.#db.prepare('SELECT * FROM scheduler_jobs WHERE id=? AND companion_id=?').get(id, companionId);
      requireSchedule(job, 'NOT_FOUND');
      if (job.state === 'active') {
        this.#db.prepare("UPDATE scheduler_jobs SET state='cancelled',generation=generation+1,version=version+1 WHERE id=?").run(id);
        this.#db.prepare("UPDATE scheduler_occurrences SET state='cancelled' WHERE companion_id=? AND job_id=? AND state='queued'").run(companionId, id);
      }
      return this.#snapshot(companionId);
    });
  }
  configure(companionId, input) {
    const value = shape(input, [], ['enabled', 'quietStart', 'quietEnd', 'heartbeatEnabled']);
    for (const key of ['enabled', 'heartbeatEnabled']) if (Object.hasOwn(value, key)) requireSchedule(typeof value[key] === 'boolean');
    for (const key of ['quietStart', 'quietEnd']) if (Object.hasOwn(value, key)) requireSchedule(typeof value[key] === 'string' && CLOCK.test(value[key]));
    return this.#tx(() => {
      const settings = this.#owner(companionId), changed = value.heartbeatEnabled !== undefined && value.heartbeatEnabled !== !!settings.heartbeat_enabled;
      if (changed) this.#db.prepare("UPDATE scheduler_occurrences SET state='cancelled' WHERE companion_id=? AND kind='heartbeat' AND state='queued'").run(companionId);
      this.#db.prepare(`UPDATE scheduler_settings SET enabled=?,quiet_start=?,quiet_end=?,heartbeat_enabled=?,
        heartbeat_generation=?,heartbeat_next_at=? WHERE companion_id=?`).run(
        Number(value.enabled ?? !!settings.enabled), value.quietStart ?? settings.quiet_start, value.quietEnd ?? settings.quiet_end,
        Number(value.heartbeatEnabled ?? !!settings.heartbeat_enabled), settings.heartbeat_generation + Number(changed),
        changed ? value.heartbeatEnabled ? this.#time() + PERIOD : null : settings.heartbeat_next_at, companionId);
      return this.#snapshot(companionId);
    });
  }
  #insert(companionId, { slot, fingerprint, kind, prompt, jobId = null, generation = 1, dueAt, state = 'queued' }) {
    const prior = this.#db.prepare('SELECT * FROM scheduler_occurrences WHERE companion_id=? AND slot_key=?').get(companionId, slot);
    if (prior) { requireSchedule(prior.fingerprint === fingerprint, 'CONFLICT'); return prior; }
    const id = randomUUID();
    this.#db.prepare('INSERT INTO scheduler_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,NULL)')
      .run(id, companionId, slot, fingerprint, kind, prompt, jobId, generation, dueAt, state);
    return this.#db.prepare('SELECT * FROM scheduler_occurrences WHERE id=?').get(id);
  }
  enqueueEvent(companionId, input) {
    const value = shape(input, ['requestId', 'kind', 'prompt']);
    requireSchedule(typeof value.requestId === 'string' && REQUEST.test(value.requestId) && ['watch', 'board'].includes(value.kind));
    const prompt = text(value.prompt), fingerprint = digest({ kind: value.kind, prompt });
    return this.#tx(() => {
      this.#owner(companionId);
      const prior = this.#db.prepare('SELECT * FROM scheduler_occurrences WHERE companion_id=? AND slot_key=?').get(companionId, 'event:' + value.requestId);
      requireSchedule(prior || this.#db.prepare("SELECT COUNT(*) AS n FROM scheduler_occurrences WHERE companion_id=? AND state IN ('queued','admitted')").get(companionId).n < 200, 'CAPACITY');
      return occurrence(this.#insert(companionId, { slot: 'event:' + value.requestId, fingerprint, kind: value.kind, prompt, dueAt: this.#time() }));
    });
  }
  prepareDue(companionId) {
    return this.#tx(() => {
      const settings = this.#owner(companionId), now = this.#time();
      for (const job of this.#db.prepare("SELECT * FROM scheduler_jobs WHERE companion_id=? AND state='active' AND due_at<=?").all(companionId, now)) {
        const slot = `job:${job.id}:${job.generation}:${job.due_at}`;
        const prior = this.#db.prepare('SELECT admitted_at FROM scheduler_occurrences WHERE companion_id=? AND slot_key=?').get(companionId, slot);
        const missed = now - job.due_at > GRACE && prior?.admitted_at == null;
        this.#insert(companionId, { slot, fingerprint: job.fingerprint,
          kind: 'reminder', prompt: job.text, jobId: job.id, generation: job.generation, dueAt: job.due_at, state: missed ? 'missed' : 'queued' });
        if (missed) {
          this.#db.prepare("UPDATE scheduler_jobs SET state='missed',version=version+1 WHERE id=?").run(job.id);
          this.#db.prepare("UPDATE scheduler_occurrences SET state='missed' WHERE companion_id=? AND slot_key=? AND state='queued'").run(companionId, slot);
        }
      }
      if (settings.heartbeat_enabled && settings.heartbeat_next_at <= now) {
        const count = Math.floor((now - settings.heartbeat_next_at) / PERIOD) + 1;
        const dueAt = settings.heartbeat_next_at + (count - 1) * PERIOD;
        if (!this.#db.prepare("SELECT 1 FROM scheduler_occurrences WHERE companion_id=? AND kind='heartbeat' AND state IN ('queued','admitted')").get(companionId)) {
          this.#insert(companionId, { slot: `heartbeat:${settings.heartbeat_generation}:${dueAt}`, fingerprint: digest({ generation: settings.heartbeat_generation, dueAt }),
            kind: 'heartbeat', prompt: 'Quietly review what needs attention. Remain silent unless there is a useful, timely update for your owner.',
            generation: settings.heartbeat_generation, dueAt });
        }
        this.#db.prepare('UPDATE scheduler_settings SET heartbeat_next_at=? WHERE companion_id=?').run(settings.heartbeat_next_at + count * PERIOD, companionId);
      }
      return this.#pending(companionId);
    });
  }
  #pending(companionId) {
    return this.#db.prepare("SELECT * FROM scheduler_occurrences WHERE companion_id=? AND state IN ('queued','admitted') ORDER BY due_at,id LIMIT 250")
      .all(companionId).map(occurrence);
  }
  pending(companionId) { return this.#tx(() => { this.#owner(companionId); return this.#pending(companionId); }); }
  #eligible(companionId, row, settings, time) {
    if (!row || !settings?.enabled || TERMINAL.has(row.state) || this.#quiet(companionId, settings, time)) return false;
    if (row.kind === 'heartbeat') return !!settings.heartbeat_enabled && row.generation === settings.heartbeat_generation;
    if (row.job_id) {
      const job = this.#db.prepare('SELECT * FROM scheduler_jobs WHERE id=? AND companion_id=?').get(row.job_id, companionId);
      return job?.state === 'active' && job.generation === row.generation && (row.admitted_at !== null || time - row.due_at <= GRACE);
    }
    return true;
  }
  // Called inside Conversations' transaction. These methods must never open a nested transaction.
  startInTransaction(companionId, id) {
    const settings = this.#owner(companionId, false), now = this.#time();
    const row = this.#db.prepare('SELECT * FROM scheduler_occurrences WHERE id=? AND companion_id=?').get(id, companionId);
    if (!this.#eligible(companionId, row, settings, now)) return false;
    if (row.admitted_at !== null) return true;
    if (now < settings.cooldown_until || settings.last_started_at !== null && now - settings.last_started_at < this.#spacing) return false;
    const day = this.#local(companionId, now).day;
    const count = this.#db.prepare('SELECT turns FROM scheduler_days WHERE companion_id=? AND local_day=?').get(companionId, day)?.turns ?? 0;
    if (count >= this.#cap) return false;
    this.#db.prepare(`INSERT INTO scheduler_days VALUES(?,?,1) ON CONFLICT(companion_id,local_day) DO UPDATE SET turns=turns+1`).run(companionId, day);
    this.#db.prepare('UPDATE scheduler_settings SET last_started_at=? WHERE companion_id=?').run(now, companionId);
    this.#db.prepare("UPDATE scheduler_occurrences SET state='admitted',admitted_at=? WHERE id=?").run(now, id);
    return true;
  }
  canDeliver(companionId, id) {
    const settings = this.#owner(companionId, false), row = this.#db.prepare('SELECT * FROM scheduler_occurrences WHERE id=? AND companion_id=?').get(id, companionId);
    return this.#eligible(companionId, row, settings, this.#time());
  }
  finishOccurrence(companionId, id, state, metadata = {}) {
    if (state === 'complete') state = 'message';
    requireSchedule(TERMINAL.has(state));
    const extra = shape(metadata, [], ['resetsAt']);
    return this.#tx(() => {
      this.#owner(companionId);
      const row = this.#db.prepare('SELECT * FROM scheduler_occurrences WHERE id=? AND companion_id=?').get(id, companionId);
      requireSchedule(row, 'NOT_FOUND');
      if (!TERMINAL.has(row.state)) {
        this.#db.prepare('UPDATE scheduler_occurrences SET state=? WHERE id=?').run(state, id);
        if (row.job_id) this.#db.prepare("UPDATE scheduler_jobs SET state=?,version=version+1 WHERE id=? AND state='active' AND generation=?")
          .run(state === 'message' || state === 'silent' ? 'complete' : state, row.job_id, row.generation);
      }
      if (extra.resetsAt !== undefined) {
        const until = typeof extra.resetsAt === 'string' ? Date.parse(extra.resetsAt) : extra.resetsAt;
        if (integer(until) && until > this.#time()) this.#db.prepare('UPDATE scheduler_settings SET cooldown_until=MAX(cooldown_until,?) WHERE companion_id=?').run(until, companionId);
      }
      return occurrence(row);
    });
  }
}

export class SchedulerService {
  #scheduler; #conversations; #companions; #ready; #poll; #timer = null; #running = null; #stopped = false;
  constructor({ scheduler, conversations, companions = () => [], ready = () => true, pollMs = 30000 }) {
    requireSchedule(scheduler && conversations && typeof companions === 'function' && typeof ready === 'function' && integer(pollMs, 1, 3600000));
    this.#scheduler = scheduler; this.#conversations = conversations; this.#companions = companions; this.#ready = ready; this.#poll = pollMs;
  }
  start() {
    if (this.#timer) return;
    this.#stopped = false; this.#timer = setInterval(() => { void this.tick().catch(() => {}); }, this.#poll); this.#timer.unref?.();
    void this.tick().catch(() => {});
  }
  async stop() { this.#stopped = true; clearInterval(this.#timer); this.#timer = null; await this.#running?.catch(() => {}); }
  tick() {
    if (this.#stopped) return Promise.resolve();
    if (!this.#running) this.#running = this.#tick().finally(() => { this.#running = null; });
    return this.#running;
  }
  async #tick() {
    const owners = this.#companions(); requireSchedule(Array.isArray(owners) && owners.length <= 100, 'UNAVAILABLE');
    for (const companionId of new Set(owners)) {
      if (this.#stopped) break;
      try {
        this.#scheduler.prepareDue(companionId);
        for (const wake of this.#scheduler.pending(companionId)) {
          if (this.#stopped) break;
          let result = await this.#conversations.proactiveResult(companionId, wake.id);
          if (!result || result.state === 'queued' || result.state === 'waiting_delivery') {
            if (result?.state !== 'waiting_delivery' && !await this.#ready(companionId)) continue;
            if (this.#stopped) break;
            result = await this.#conversations.enqueueProactive(companionId, { id: wake.id, kind: wake.kind, prompt: wake.prompt });
            if (!this.#scheduler.pending(companionId).some(current => current.id === wake.id)) {
              await this.#conversations.cancelProactive(companionId, wake.id);
              continue;
            }
          }
          if (TERMINAL.has(result?.state) || result?.state === 'complete') {
            const resetsAt = result.error?.resetsAt ?? result.resetsAt;
            this.#scheduler.finishOccurrence(companionId, wake.id, result.state, resetsAt === undefined ? {} : { resetsAt });
          }
        }
      } catch { /* One unavailable owner never blocks the other owner or leaks private errors. */ }
    }
  }
  #kick() { if (this.#timer && !this.#stopped) void this.tick().catch(() => {}); }
  create(companionId, input) { const result = this.#scheduler.create(companionId, input); this.#kick(); return result; }
  list(companionId) { return this.#scheduler.list(companionId); }
  configure(companionId, input) {
    const value = shape(input, [], ['enabled', 'quietStart', 'quietEnd', 'heartbeatEnabled']);
    const prior = value.heartbeatEnabled === false ? this.#scheduler.pending(companionId).filter(wake => wake.kind === 'heartbeat') : [];
    const result = this.#scheduler.configure(companionId, value);
    for (const wake of prior) {
      try { Promise.resolve(this.#conversations.cancelProactive(companionId, wake.id)).catch(() => {}); }
      catch { /* The generation fence already prevents delivery; a later tick observes completion. */ }
    }
    this.#kick(); return result;
  }
  enqueueEvent(companionId, input) { const result = this.#scheduler.enqueueEvent(companionId, input); this.#kick(); return result; }
  async cancel(companionId, input) {
    const value = shape(input, ['id']);
    const pending = this.#scheduler.pending(companionId).filter(wake => wake.jobId === value.id);
    const result = this.#scheduler.cancel(companionId, value);
    await Promise.allSettled(pending.map(wake => this.#conversations.cancelProactive(companionId, wake.id)));
    return result;
  }
}
