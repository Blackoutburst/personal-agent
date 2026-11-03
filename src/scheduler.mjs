import { createHash, randomUUID } from 'node:crypto';
import { latestRoutineSlot } from './routines.mjs';
import { ReleaseWatches } from './release-watches.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/, HASH = /^[a-f0-9]{64}$/, CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const PERIOD = 6 * 3600000, GRACE = 24 * 3600000;
const TERMINAL = new Set(['message', 'silent', 'cancelled', 'interrupted', 'error', 'missed']);
const ROUTINES = ['dailyDigest', 'weeklyCheckin'];
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
 PRIMARY KEY(companion_id,local_day));
CREATE TABLE IF NOT EXISTS scheduler_routine_preferences(companion_id TEXT NOT NULL,routine TEXT NOT NULL,
 identity_key TEXT NOT NULL,enabled INTEGER NOT NULL,local_time TEXT NOT NULL,weekday INTEGER NOT NULL,
 generation INTEGER NOT NULL,timezone TEXT NOT NULL,boundary_at INTEGER NOT NULL,PRIMARY KEY(companion_id,routine));
CREATE TABLE IF NOT EXISTS scheduler_routine_occurrences(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,
 routine TEXT NOT NULL,period TEXT NOT NULL,generation INTEGER NOT NULL,timezone TEXT NOT NULL,fingerprint TEXT NOT NULL,
 prompt TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL,admitted_at INTEGER,cancel_pending INTEGER NOT NULL,
 UNIQUE(companion_id,routine,generation,period));
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_routine_attempt ON scheduler_routine_occurrences(companion_id,routine,period)
 WHERE admitted_at IS NOT NULL;`;

export class SchedulerStore {
  #db; #timezone; #now; #spacing; #cap; #release;
  constructor({ store, timezoneFor = () => 'UTC', now = Date.now, minSpacingMs = 300000, maxTurnsPerDay = 24 }) {
    requireSchedule(store?.db && typeof timezoneFor === 'function' && typeof now === 'function'
      && integer(minSpacingMs) && integer(maxTurnsPerDay, 1, 1000));
    this.#db = store.db; this.#timezone = timezoneFor; this.#now = now; this.#spacing = minSpacingMs; this.#cap = maxTurnsPerDay;
    this.#tx(() => { this.#db.exec(SCHEMA); this.#release = new ReleaseWatches(this.#db, code => new SchedulerError(code)); });
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
  #routines(companionId, settings) {
    const rows = this.#db.prepare('SELECT * FROM scheduler_routine_preferences WHERE companion_id=?').all(companionId);
    const result = new Map();
    for (const row of rows) {
      requireSchedule(settings && row.identity_key === settings.identity_key && ROUTINES.includes(row.routine) &&
        [0, 1].includes(row.enabled) && CLOCK.test(row.local_time) && integer(row.weekday, 1, 7) &&
        (row.routine !== 'dailyDigest' || row.weekday === 1) && integer(row.generation, 1) && integer(row.boundary_at)
        && typeof row.timezone === 'string', 'UNAVAILABLE');
      try { new Intl.DateTimeFormat('en', { timeZone: row.timezone }).format(0); } catch { throw new SchedulerError('UNAVAILABLE'); }
      result.set(row.routine, row);
    }
    return result;
  }
  #cancelRoutine(companionId, routine) {
    this.#db.prepare("UPDATE scheduler_routine_occurrences SET state='cancelled',cancel_pending=1 WHERE companion_id=? AND routine=? AND state IN ('queued','admitted')")
      .run(companionId, routine);
  }
  #configureRoutines(companionId, settings, patch, now) {
    const current = this.#routines(companionId, settings), zone = this.#zone(companionId);
    for (const routine of ROUTINES) {
      const prior = current.get(routine), value = patch[routine] ?? {};
      const enabled = value.enabled ?? !!prior?.enabled, localTime = value.localTime ?? prior?.local_time ?? '09:00';
      const weekday = value.weekday ?? prior?.weekday ?? 1;
      const changed = prior ? enabled !== !!prior.enabled || localTime !== prior.local_time || weekday !== prior.weekday || zone !== prior.timezone
        : enabled || localTime !== '09:00' || weekday !== 1;
      if (!changed) continue;
      const generation = (prior?.generation ?? 0) + 1; requireSchedule(integer(generation, 1), 'UNAVAILABLE');
      this.#cancelRoutine(companionId, routine);
      this.#db.prepare(`INSERT INTO scheduler_routine_preferences
        (companion_id,routine,identity_key,enabled,local_time,weekday,generation,timezone,boundary_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(companion_id,routine) DO UPDATE SET enabled=excluded.enabled,local_time=excluded.local_time,
        weekday=excluded.weekday,generation=excluded.generation,timezone=excluded.timezone,boundary_at=excluded.boundary_at`)
        .run(companionId, routine, settings.identity_key, Number(enabled), localTime, weekday, generation, zone, now);
    }
  }
  #routineRow(row) {
    if (!row) return null;
    requireSchedule(UUID.test(row.id) && ROUTINES.includes(row.routine) && /^\d{4}-\d{2}-\d{2}$/.test(row.period)
      && integer(row.generation, 1) && typeof row.timezone === 'string' && integer(row.due_at)
      && ['queued', 'admitted', ...TERMINAL].includes(row.state) && (row.admitted_at === null || integer(row.admitted_at))
      && [0, 1].includes(row.cancel_pending) && text(row.prompt) === row.prompt
      && row.fingerprint === digest({ routine: row.routine, period: row.period, generation: row.generation,
        timezone: row.timezone, dueAt: row.due_at, prompt: row.prompt }), 'UNAVAILABLE');
    return { ...row, kind: 'watch', job_id: null };
  }
  #lookup(companionId, id) {
    const prior = this.#db.prepare('SELECT * FROM scheduler_occurrences WHERE id=? AND companion_id=?').get(id, companionId);
    const routine = this.#routineRow(this.#db.prepare('SELECT * FROM scheduler_routine_occurrences WHERE id=? AND companion_id=?').get(id, companionId));
    const release = this.#release.lookup(companionId, id);
    requireSchedule([prior, routine, release].filter(Boolean).length <= 1, 'UNAVAILABLE'); return prior ?? routine ?? release;
  }
  #prepareRoutines(companionId, settings, now) {
    this.#configureRoutines(companionId, settings, {}, now);
    for (const [routine, preference] of this.#routines(companionId, settings)) {
      if (!preference.enabled) continue;
      const slot = latestRoutineSlot({ now, timeZone: preference.timezone, routine,
        localTime: preference.local_time, weekday: preference.weekday });
      this.#db.prepare("UPDATE scheduler_routine_occurrences SET state='cancelled',cancel_pending=1 WHERE companion_id=? AND routine=? AND state IN ('queued','admitted') AND (generation!=? OR timezone!=? OR period<?)")
        .run(companionId, routine, preference.generation, preference.timezone, slot.period);
      if (this.#db.prepare("SELECT 1 FROM scheduler_routine_occurrences WHERE companion_id=? AND routine=? AND state IN ('queued','admitted') AND period>? LIMIT 1")
        .get(companionId, routine, slot.period)) continue;
      if (slot.dueAt < preference.boundary_at || this.#db.prepare('SELECT 1 FROM scheduler_routine_occurrences WHERE companion_id=? AND routine=? AND period=? AND admitted_at IS NOT NULL')
        .get(companionId, routine, slot.period)) continue;
      const prompt = routine === 'dailyDigest'
        ? `Prepare a concise private daily digest for ${slot.localDate} from current context: useful updates, pending questions and next steps. Remain silent if there is nothing useful. Never invent progress or write to the Board.`
        : `Prepare a concise private weekly check-in for the local week of ${slot.period} from current context. Reflect gently on progress and next steps; a clearly dated neglected goal may be mentioned kindly. Do not invent seven-day milestone history. Remain silent if there is nothing useful. Never write to the Board.`;
      const fingerprint = digest({ routine, period: slot.period, generation: preference.generation, timezone: preference.timezone, dueAt: slot.dueAt, prompt });
      const prior = this.#db.prepare('SELECT * FROM scheduler_routine_occurrences WHERE companion_id=? AND routine=? AND generation=? AND period=?')
        .get(companionId, routine, preference.generation, slot.period);
      if (prior) { requireSchedule(this.#routineRow(prior).fingerprint === fingerprint, 'CONFLICT'); continue; }
      this.#db.prepare(`INSERT INTO scheduler_routine_occurrences
        (id,companion_id,routine,period,generation,timezone,fingerprint,prompt,due_at,state,admitted_at,cancel_pending)
        VALUES(?,?,?,?,?,?,?,?,?,'queued',NULL,0)`)
        .run(randomUUID(), companionId, routine, slot.period, preference.generation, preference.timezone, fingerprint, prompt, slot.dueAt);
    }
  }
  #snapshot(companionId) {
    const settings = this.#owner(companionId), time = this.#time();
    const routines = this.#routines(companionId, settings);
    const jobs = this.#db.prepare(`SELECT * FROM scheduler_jobs WHERE companion_id=? AND (state='active' OR id IN (
      SELECT id FROM scheduler_jobs WHERE companion_id=? AND state!='active' ORDER BY rowid DESC LIMIT 10))
      ORDER BY due_at,id`).all(companionId, companionId);
    return { now: iso(time), timezone: this.#zone(companionId), settings: { enabled: !!settings.enabled,
      quietStart: settings.quiet_start, quietEnd: settings.quiet_end, heartbeatEnabled: !!settings.heartbeat_enabled,
      dailyDigest: { enabled: !!routines.get('dailyDigest')?.enabled, localTime: routines.get('dailyDigest')?.local_time ?? '09:00' },
      weeklyCheckin: { enabled: !!routines.get('weeklyCheckin')?.enabled, localTime: routines.get('weeklyCheckin')?.local_time ?? '09:00', weekday: routines.get('weeklyCheckin')?.weekday ?? 1 } },
    items: jobs.map(reminder), releaseWatches: this.#release.list(companionId, settings.identity_key) };
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
  createWatch(companionId, input) {
    return this.#tx(() => {
      const settings = this.#owner(companionId);
      this.#release.create(companionId, settings.identity_key, input, this.#time());
      return this.#snapshot(companionId);
    });
  }
  updateWatch(companionId, input) {
    return this.#tx(() => {
      const settings = this.#owner(companionId);
      this.#release.update(companionId, settings.identity_key, input, this.#time());
      return this.#snapshot(companionId);
    });
  }
  isReleaseOccurrence(companionId, id) { return !!this.#release.lookup(companionId, id); }
  releaseCompanions() { return this.#db.prepare("SELECT DISTINCT companion_id FROM scheduler_release_watches WHERE state='active'").all().map(row => row.companion_id); }
  // Both callbacks run inside Conversations' publication transaction, never nested.
  recordReleaseCheck(companionId, id, check, messageText) {
    const settings = this.#owner(companionId, false);
    if (!settings?.enabled) return { action: 'cancelled' };
    return this.#release.record(companionId, settings.identity_key, id, check, messageText, this.#time());
  }
  releaseDelivered(companionId, id) {
    const settings = this.#owner(companionId, false), row = this.#lookup(companionId, id);
    if (!this.#eligible(companionId, row, settings, this.#time())) return false;
    return this.#release.delivered(companionId, settings.identity_key, id, this.#time());
  }
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
    const value = shape(input, [], ['enabled', 'quietStart', 'quietEnd', 'heartbeatEnabled', ...ROUTINES]);
    for (const key of ['enabled', 'heartbeatEnabled']) if (Object.hasOwn(value, key)) requireSchedule(typeof value[key] === 'boolean');
    for (const key of ['quietStart', 'quietEnd']) if (Object.hasOwn(value, key)) requireSchedule(typeof value[key] === 'string' && CLOCK.test(value[key]));
    for (const routine of ROUTINES) if (Object.hasOwn(value, routine)) {
      const selected = shape(value[routine], [], routine === 'dailyDigest' ? ['enabled', 'localTime'] : ['enabled', 'localTime', 'weekday']);
      if (Object.hasOwn(selected, 'enabled')) requireSchedule(typeof selected.enabled === 'boolean');
      if (Object.hasOwn(selected, 'localTime')) requireSchedule(typeof selected.localTime === 'string' && CLOCK.test(selected.localTime));
      if (Object.hasOwn(selected, 'weekday')) requireSchedule(integer(selected.weekday, 1, 7));
      value[routine] = selected;
    }
    return this.#tx(() => {
      const settings = this.#owner(companionId), changed = value.heartbeatEnabled !== undefined && value.heartbeatEnabled !== !!settings.heartbeat_enabled;
      this.#configureRoutines(companionId, settings, value, this.#time());
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
      this.#prepareRoutines(companionId, settings, now);
      this.#release.prepare(companionId, settings.identity_key, now);
      return this.#pending(companionId);
    });
  }
  #pending(companionId) {
    const legacy = this.#db.prepare("SELECT * FROM scheduler_occurrences WHERE companion_id=? AND state IN ('queued','admitted') ORDER BY due_at,id LIMIT 250").all(companionId);
    const routines = this.#db.prepare("SELECT * FROM scheduler_routine_occurrences WHERE companion_id=? AND state IN ('queued','admitted') ORDER BY due_at,id LIMIT 250")
      .all(companionId).map(row => this.#routineRow(row));
    return [...legacy, ...routines, ...this.#release.pending(companionId)].sort((a, b) => a.due_at - b.due_at || a.id.localeCompare(b.id)).slice(0, 250).map(occurrence);
  }
  pending(companionId) { return this.#tx(() => { this.#owner(companionId); return this.#pending(companionId); }); }
  #eligible(companionId, row, settings, time, starting = false) {
    if (!row || !settings?.enabled || TERMINAL.has(row.state)
      || !(starting && row.release_watch) && this.#quiet(companionId, settings, time)) return false;
    if (row.release_watch) return this.#release.eligible(companionId, settings.identity_key, row, time);
    if (row.routine) {
      const preference = this.#routines(companionId, settings).get(row.routine), zone = this.#zone(companionId);
      if (!preference?.enabled || preference.generation !== row.generation || preference.timezone !== zone || row.timezone !== zone
        || row.due_at < preference.boundary_at || row.due_at > time) return false;
      const slot = latestRoutineSlot({ now: time, timeZone: zone, routine: row.routine, localTime: preference.local_time, weekday: preference.weekday });
      if (slot.period !== row.period || slot.dueAt !== row.due_at) return false;
      return row.admitted_at !== null || !this.#db.prepare('SELECT 1 FROM scheduler_routine_occurrences WHERE companion_id=? AND routine=? AND period=? AND admitted_at IS NOT NULL')
        .get(companionId, row.routine, row.period);
    }
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
    const row = this.#lookup(companionId, id);
    if (!this.#eligible(companionId, row, settings, now, true)) return false;
    if (row.admitted_at !== null) return true;
    if (row.release_watch) {
      if (now < settings.cooldown_until) return false;
      this.#db.prepare("UPDATE scheduler_release_occurrences SET state='admitted',admitted_at=? WHERE id=?").run(now, id);
      return true;
    }
    if (now < settings.cooldown_until || settings.last_started_at !== null && now - settings.last_started_at < this.#spacing) return false;
    const day = this.#local(companionId, now).day;
    const count = this.#db.prepare('SELECT turns FROM scheduler_days WHERE companion_id=? AND local_day=?').get(companionId, day)?.turns ?? 0;
    if (count >= this.#cap) return false;
    this.#db.prepare(`INSERT INTO scheduler_days VALUES(?,?,1) ON CONFLICT(companion_id,local_day) DO UPDATE SET turns=turns+1`).run(companionId, day);
    this.#db.prepare('UPDATE scheduler_settings SET last_started_at=? WHERE companion_id=?').run(now, companionId);
    this.#db.prepare("UPDATE " + (row.routine ? 'scheduler_routine_occurrences' : 'scheduler_occurrences') + " SET state='admitted',admitted_at=? WHERE id=?").run(now, id);
    return true;
  }
  canDeliver(companionId, id) {
    const settings = this.#owner(companionId, false), row = this.#lookup(companionId, id);
    return this.#eligible(companionId, row, settings, this.#time());
  }
  finishOccurrence(companionId, id, state, metadata = {}) {
    if (state === 'complete') state = 'message';
    requireSchedule(TERMINAL.has(state));
    const extra = shape(metadata, [], ['resetsAt']);
    return this.#tx(() => {
      this.#owner(companionId);
      const row = this.#lookup(companionId, id);
      requireSchedule(row, 'NOT_FOUND');
      if (row.release_watch) this.#release.finish(companionId, this.#owner(companionId).identity_key, id, state, this.#time());
      else if (!TERMINAL.has(row.state)) {
        this.#db.prepare('UPDATE ' + (row.routine ? 'scheduler_routine_occurrences' : 'scheduler_occurrences') + ' SET state=? WHERE id=?').run(state, id);
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
  releaseCancellations(companionId) { this.#owner(companionId, false); return this.#release.cancellations(companionId); }
  acknowledgeReleaseCancellation(companionId, id) { this.#owner(companionId, false); this.#release.acknowledgeCancellation(companionId, id); }
  routineCancellations(companionId) {
    this.#owner(companionId, false);
    return this.#db.prepare("SELECT id FROM scheduler_routine_occurrences WHERE companion_id=? AND state='cancelled' AND cancel_pending=1 ORDER BY due_at,id LIMIT 250")
      .all(companionId).map(row => row.id);
  }
  acknowledgeRoutineCancellation(companionId, id) {
    this.#owner(companionId, false);
    this.#db.prepare("UPDATE scheduler_routine_occurrences SET cancel_pending=0 WHERE companion_id=? AND id=? AND state='cancelled'").run(companionId, id);
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
        this.#cancelRoutineWakes(companionId);
        this.#cancelReleaseWakes(companionId);
        for (const wake of this.#scheduler.pending(companionId)) {
          if (this.#stopped) break;
          let result = await this.#conversations.proactiveResult(companionId, wake.id);
          if (wake.kind === 'release_watch' && ['error', 'interrupted'].includes(result?.state) && !result.releaseCheck) {
            this.#conversations.reconcileReleaseFailure?.(companionId, wake.id);
            result = await this.#conversations.proactiveResult(companionId, wake.id);
          }
          if (!result || result.state === 'queued' || result.state === 'waiting_delivery') {
            if (wake.kind !== 'release_watch' && result?.state !== 'waiting_delivery' && !await this.#ready(companionId)) continue;
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
  #cancelReleaseWakes(companionId) {
    for (const id of this.#scheduler.releaseCancellations?.(companionId) ?? []) {
      try {
        const result = this.#conversations.cancelProactive(companionId, id);
        if (result && typeof result.then === 'function') Promise.resolve(result)
          .then(() => this.#scheduler.acknowledgeReleaseCancellation(companionId, id)).catch(() => {});
        else this.#scheduler.acknowledgeReleaseCancellation(companionId, id);
      } catch { /* Keep the durable flag until cancellation is acknowledged. */ }
    }
  }
  #cancelRoutineWakes(companionId) {
    for (const id of this.#scheduler.routineCancellations(companionId)) {
      try {
        const result = this.#conversations.cancelProactive(companionId, id);
        if (result && typeof result.then === 'function') Promise.resolve(result)
          .then(() => this.#scheduler.acknowledgeRoutineCancellation(companionId, id)).catch(() => {});
        else this.#scheduler.acknowledgeRoutineCancellation(companionId, id);
      } catch { /* The durable cancellation flag remains for the next tick. */ }
    }
  }
  #kick() { if (this.#timer && !this.#stopped) void this.tick().catch(() => {}); }
  create(companionId, input) { const result = this.#scheduler.create(companionId, input); this.#kick(); return result; }
  list(companionId) { return this.#scheduler.list(companionId); }
  createWatch(companionId, input) { const result = this.#scheduler.createWatch(companionId, input); this.#kick(); return result; }
  updateWatch(companionId, input) {
    const result = this.#scheduler.updateWatch(companionId, input);
    this.#cancelReleaseWakes(companionId); this.#kick(); return result;
  }
  configure(companionId, input) {
    const value = shape(input, [], ['enabled', 'quietStart', 'quietEnd', 'heartbeatEnabled', ...ROUTINES]);
    const prior = value.heartbeatEnabled === false ? this.#scheduler.pending(companionId).filter(wake => wake.kind === 'heartbeat') : [];
    const result = this.#scheduler.configure(companionId, value);
    this.#cancelRoutineWakes(companionId);
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
