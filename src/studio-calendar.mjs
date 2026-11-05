// Shared Studio calendar (#65, docs/STUDIO.md): one calendar per Studio, for its human members and their companions.
//
// A Studio is a shared mailbox that has Studio viewers (mail.studioViewers in owners.json). Its key is the mailbox
// address, so one Studio = one calendar. Members are the owners listed in studioViewers plus the owners whose own
// mail.address is that mailbox (their companions handle it). Each member's human (Studio tab › Calendar) and companion
// (studio_calendar_* tools) read and edit the same events.
//
// Timed events are stored as UTC instants, so members in different timezones each see them in their own local time;
// all-day events are stored as dates. Each event records who added it and who changed it last (the human owner's
// display name or the companion's name, with its kind). Edits are compare-and-swap on a version, like the personal
// calendar (src/calendar.mjs, whose date helpers and text checks are reused here). No repeat, no reminders.
// All text is member-entered data, never instructions.
import { randomUUID, createHash } from 'node:crypto';
import { companionIdFor } from './runtime-config.mjs';
import { CalendarError, plain, only, text, parseDate, parseDateTime, wall, zonedTime, addDays } from './calendar.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const STUDIO_CALENDAR_LIMITS = Object.freeze({ events: 1000, days: 400, defaultDays: 42, upcoming: 20, span: 366,
  title: 200, location: 200, notes: 2000, company: 200, contact: 254 });
const FIELDS = ['title', 'allDay', 'start', 'end', 'location', 'notes', 'company', 'contact'];
const DAY = 86400000;
const KINDS = ['human', 'companion'];

export class StudioCalendarError extends Error {
  constructor(code = 'INVALID_REQUEST', status = 400) {
    super(code); this.name = 'StudioCalendarError'; this.code = code === 'FORBIDDEN' ? 'STUDIO_FORBIDDEN' : 'STUDIO_CALENDAR_' + code; this.status = status;
  }
}
const invalid = () => new StudioCalendarError('INVALID_REQUEST');
// The personal calendar's checks throw CalendarError; here they are the Studio calendar's own invalid request.
const checked = run => { try { return run(); } catch (error) { if (error instanceof CalendarError) throw invalid(); throw error; } };

// The Studio (its mailbox address) an owner belongs to, or null.
export function studioKeyFor(owners, owner) {
  if (!owner) return null;
  const viewed = owners.find(value => value.mail?.studioViewers?.includes(owner.label));
  if (viewed) return viewed.mail.address;
  const address = owner.mail?.address;
  return address && owners.some(value => value.mail?.address === address && value.mail.studioViewers?.length) ? address : null;
}

const clean = (value, fallback) => {
  let out = '';
  for (const char of String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()) { if (out.length + char.length > 80) break; out += char; }
  return out.trim() || fallback;
};
const durationOk = (from, to) => to - from <= STUDIO_CALENDAR_LIMITS.span * DAY;

export class StudioCalendar {
  #db; #owners; #store; #timezone; #nameFor; #now;
  // timezoneFor(companionId): the owner's timezone; times in and out are local wall time there.
  // nameFor(companionId, kind): the display name of the owner (kind "human") or of their companion (kind "companion").
  constructor({ store, owners, timezoneFor = () => 'UTC', nameFor = () => null, now = Date.now }) {
    this.#store = store; this.#db = store.db; this.#owners = owners; this.#timezone = timezoneFor; this.#nameFor = nameFor; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS studio_calendar_events(studio TEXT NOT NULL, id TEXT NOT NULL, request_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, title TEXT NOT NULL, all_day INTEGER NOT NULL, start TEXT NOT NULL, end_at TEXT, location TEXT,
      notes TEXT, company TEXT, contact TEXT, created_kind TEXT NOT NULL, created_name TEXT NOT NULL, created_companion TEXT NOT NULL,
      updated_kind TEXT NOT NULL, updated_name TEXT NOT NULL, updated_companion TEXT NOT NULL, version INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(studio, id), UNIQUE(studio, request_key));
      CREATE INDEX IF NOT EXISTS studio_calendar_events_start ON studio_calendar_events(studio, start)`);
  }

  // The Studio key for this owner's companion id, or a 403.
  scope(companionId) {
    if (typeof companionId !== 'string' || !UUID.test(companionId)) throw new StudioCalendarError('FORBIDDEN', 403);
    const owner = this.#owners.find(value => companionIdFor(this.#store, value) === companionId);
    const key = studioKeyFor(this.#owners, owner);
    if (!key) throw new StudioCalendarError('FORBIDDEN', 403);
    return key;
  }
  member(companionId) { try { this.scope(companionId); return true; } catch { return false; } }

  #zone(companionId) {
    try { const zone = this.#timezone(companionId) || 'UTC'; new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); return zone; }
    catch { return 'UTC'; }
  }
  #actor(companionId, kind) {
    if (!KINDS.includes(kind)) throw invalid();
    let name = null;
    try { name = this.#nameFor(companionId, kind); } catch { /* fallback below */ }
    return { kind, name: clean(name, kind === 'human' ? 'Owner' : 'Companion'), companionId };
  }
  #tx(run) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* keep the first error */ } throw error; }
  }
  #row(studio, id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
    const row = this.#db.prepare('SELECT * FROM studio_calendar_events WHERE studio=? AND id=?').get(studio, id);
    if (!row) throw new StudioCalendarError('NOT_FOUND', 404);
    return row;
  }

  // Validates an event and resolves its local times (the actor's timezone) to instants.
  #input(value, zone) {
    return checked(() => {
      only(value, ['title', 'start'], FIELDS);
      const allDay = value.allDay ?? !DATETIME.test(String(value.start));
      if (typeof allDay !== 'boolean') throw invalid();
      let end = value.end ?? null;
      if (end === '') end = null;
      const out = { title: text(value.title, STUDIO_CALENDAR_LIMITS.title, { required: true }), allDay,
        location: text(value.location, STUDIO_CALENDAR_LIMITS.location), notes: text(value.notes, STUDIO_CALENDAR_LIMITS.notes),
        company: text(value.company, STUDIO_CALENDAR_LIMITS.company), contact: text(value.contact, STUDIO_CALENDAR_LIMITS.contact) };
      if (allDay) {
        if (!parseDate(value.start) || (end !== null && (!parseDate(end) || end < value.start))) throw invalid();
        if (end !== null && !durationOk(Date.parse(value.start), Date.parse(end))) throw invalid();
        return { ...out, start: value.start, end: end === value.start ? null : end };
      }
      if (!parseDateTime(value.start) || (end !== null && !parseDateTime(end))) throw invalid();
      const at = local => new Date(zonedTime(local.slice(0, 10), local.slice(11), zone)).toISOString();
      const start = at(value.start), stop = end === null ? null : at(end);
      if (stop !== null && (stop < start || !durationOk(Date.parse(start), Date.parse(stop)))) throw invalid();
      return { ...out, start, end: stop === start ? null : stop };
    });
  }
  // An event as one member sees it: local times in their timezone, plus the stored instants.
  #public(row, zone) {
    const local = iso => { const shown = wall(Date.parse(iso), zone); return `${shown.date}T${shown.time}`; };
    const allDay = Boolean(row.all_day);
    return { id: row.id, version: row.version, title: row.title, allDay,
      start: allDay ? row.start : local(row.start), end: row.end_at === null ? null : allDay ? row.end_at : local(row.end_at),
      startsAt: allDay ? null : row.start, endsAt: allDay ? null : row.end_at, location: row.location, notes: row.notes,
      company: row.company, contact: row.contact, repeat: 'none', reminderMinutes: null,
      createdBy: { kind: row.created_kind, name: row.created_name }, updatedBy: { kind: row.updated_kind, name: row.updated_name },
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  }

  // Events overlapping the local days [from, from + days) of the viewer, in date and time order, plus the next upcoming ones.
  view(companionId, input = {}) {
    const studio = this.scope(companionId);
    const { from: wanted, days: count } = checked(() => only(input ?? {}, [], ['from', 'days']));
    const zone = this.#zone(companionId), now = this.#now(), today = wall(now, zone).date;
    const from = wanted ?? today, days = count ?? STUDIO_CALENDAR_LIMITS.defaultDays;
    if (!parseDate(from) || !Number.isSafeInteger(days) || days < 1 || days > STUDIO_CALENDAR_LIMITS.days) throw invalid();
    const to = addDays(from, days);
    const events = this.#db.prepare('SELECT * FROM studio_calendar_events WHERE studio=? ORDER BY start, id').all(studio).map(row => this.#public(row, zone));
    const lastDay = event => (event.end ?? event.start).slice(0, 10);
    const shown = events.filter(event => event.start.slice(0, 10) < to && lastDay(event) >= from);
    const occurrences = shown.map(event => ({ eventId: event.id, title: event.title, date: event.start.slice(0, 10), allDay: event.allDay,
      start: event.start, end: event.end, location: event.location, company: event.company, createdBy: event.createdBy, repeat: 'none' }))
      .sort((a, b) => a.date.localeCompare(b.date) || Number(!a.allDay) - Number(!b.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    const instant = event => event.allDay ? zonedTime(event.start, '00:00', zone) : Date.parse(event.startsAt);
    const upcoming = events.filter(event => event.allDay ? lastDay(event) >= today : Date.parse(event.endsAt ?? event.startsAt) >= now)
      .sort((a, b) => instant(a) - instant(b) || a.id.localeCompare(b.id)).slice(0, STUDIO_CALENDAR_LIMITS.upcoming);
    return { studio, timezone: zone, today, from, days, holidaysFr: false, occurrences, events: shown, upcoming, total: events.length };
  }

  create(companionId, input, kind) {
    const studio = this.scope(companionId), actor = this.#actor(companionId, kind);
    const { requestId, event } = checked(() => only(input, ['requestId', 'event']));
    if (typeof requestId !== 'string' || !REQUEST.test(requestId)) throw invalid();
    const zone = this.#zone(companionId), value = this.#input(event, zone);
    const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    // Retries are per member and per kind: an owner and their companion never share a request key.
    const key = `${companionId}:${kind}:${requestId}`;
    return this.#tx(() => {
      const prior = this.#db.prepare('SELECT * FROM studio_calendar_events WHERE studio=? AND request_key=?').get(studio, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new StudioCalendarError('CONFLICT', 409);
        return { event: this.#public(prior, zone), created: false };
      }
      if (this.#db.prepare('SELECT COUNT(*) AS n FROM studio_calendar_events WHERE studio=?').get(studio).n >= STUDIO_CALENDAR_LIMITS.events) {
        throw new StudioCalendarError('CAPACITY', 409);
      }
      const id = randomUUID(), now = this.#now();
      this.#db.prepare(`INSERT INTO studio_calendar_events(studio,id,request_key,fingerprint,title,all_day,start,end_at,location,notes,company,contact,
        created_kind,created_name,created_companion,updated_kind,updated_name,updated_companion,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(studio, id, key, fingerprint, value.title, Number(value.allDay), value.start,
        value.end, value.location, value.notes, value.company, value.contact, actor.kind, actor.name, actor.companionId,
        actor.kind, actor.name, actor.companionId, now, now);
      return { event: this.#public(this.#row(studio, id), zone), created: true };
    });
  }

  // A full replacement guarded by the version the editor saw. Resending the same change after it applied is accepted.
  update(companionId, input, kind) {
    const studio = this.scope(companionId), actor = this.#actor(companionId, kind);
    const { id, expectedVersion, event } = checked(() => only(input, ['id', 'expectedVersion', 'event']));
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw invalid();
    const zone = this.#zone(companionId), value = this.#input(event, zone);
    return this.#tx(() => {
      const row = this.#row(studio, id);
      const stored = { title: row.title, allDay: Boolean(row.all_day), start: row.start, end: row.end_at, location: row.location,
        notes: row.notes, company: row.company, contact: row.contact };
      const same = FIELDS.every(field => stored[field] === value[field]);
      if (row.version !== expectedVersion) {
        if (row.version === expectedVersion + 1 && same) return { event: this.#public(row, zone) };
        throw new StudioCalendarError('CONFLICT', 409);
      }
      if (same) return { event: this.#public(row, zone) };
      this.#db.prepare(`UPDATE studio_calendar_events SET title=?,all_day=?,start=?,end_at=?,location=?,notes=?,company=?,contact=?,
        updated_kind=?,updated_name=?,updated_companion=?,version=version+1,updated_at=? WHERE studio=? AND id=?`).run(value.title,
        Number(value.allDay), value.start, value.end, value.location, value.notes, value.company, value.contact,
        actor.kind, actor.name, actor.companionId, this.#now(), studio, id);
      return { event: this.#public(this.#row(studio, id), zone) };
    });
  }

  remove(companionId, input) {
    const studio = this.scope(companionId);
    const { id } = checked(() => only(input, ['id']));
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
    return { deleted: this.#db.prepare('DELETE FROM studio_calendar_events WHERE studio=? AND id=?').run(studio, id).changes > 0, id };
  }
}

const MESSAGES = {
  en: { forbidden: 'Only Studio members can use the Studio calendar.', conflict: 'This event changed meanwhile. Reload and try again.',
    capacity: `The Studio calendar is full (${STUDIO_CALENDAR_LIMITS.events} events).`, missing: 'This event no longer exists.',
    invalid: 'Invalid Studio calendar request.', unavailable: 'The Studio calendar is unavailable right now.' },
  fr: { forbidden: 'Le calendrier est réservé aux membres du Studio.', conflict: 'Cet événement a changé entre-temps. Rechargez et réessayez.',
    capacity: `Le calendrier du Studio est plein (${STUDIO_CALENDAR_LIMITS.events} événements).`, missing: 'Cet événement n’existe plus.',
    invalid: 'Demande invalide pour le calendrier du Studio.', unavailable: 'Le calendrier du Studio n’est pas disponible pour le moment.' }
};
const ACTIONS = new Set(['calendar', 'createEvent', 'updateEvent', 'deleteEvent']);
export const isStudioCalendarAction = action => ACTIONS.has(action);

// The Studio tab (/api/studio, kind "human", French) and the companion's tools (/internal/scheduler action "studioCalendar",
// kind "companion", English) share these actions.
export function studioCalendarOperation(calendar, companionId, payload, { kind = 'human', lang = 'en' } = {}) {
  const text = MESSAGES[lang] ?? MESSAGES.en;
  const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
  if (!calendar) return fail(503, 'STUDIO_CALENDAR_UNAVAILABLE', text.unavailable);
  try {
    if (!plain(payload) || Object.keys(payload).some(key => !['action', 'input'].includes(key))) throw invalid();
    const input = payload.input;
    let body;
    switch (payload.action) {
      case 'calendar': body = calendar.view(companionId, input ?? {}); break;
      case 'createEvent': body = calendar.create(companionId, input, kind); break;
      case 'updateEvent': body = calendar.update(companionId, input, kind); break;
      case 'deleteEvent': body = calendar.remove(companionId, input); break;
      default: throw invalid();
    }
    return { status: 200, body };
  } catch (error) {
    if (!(error instanceof StudioCalendarError)) return fail(503, 'STUDIO_CALENDAR_UNAVAILABLE', text.unavailable);
    return fail(error.status, error.code, error.status === 403 ? text.forbidden : error.code.endsWith('CONFLICT') ? text.conflict
      : error.code.endsWith('CAPACITY') ? text.capacity : error.status === 404 ? text.missing : text.invalid);
  }
}
