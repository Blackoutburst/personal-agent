import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { SchedulerStore, SchedulerService, SchedulerError } from '../src/scheduler.mjs';
import { latestRoutineSlot } from '../src/routines.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), DAY = 86400000;
const defaults = { dailyDigest: { enabled: false, localTime: '09:00' }, weeklyCheckin: { enabled: false, localTime: '09:00', weekday: 1 } };
function fixture(t, { deferNew = false, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-routines-')), stores = new Set();
  const f = { dir, clock: Date.parse('2026-11-02T08:00:00Z'), zones: new Map() };
  f.at = value => { f.clock = Date.parse(value); };
  f.open = () => { const store = new BootstrapStore(join(dir, 'data'), ROOT); stores.add(store); return store; };
  f.make = store => new SchedulerStore({ store, now: () => f.clock, timezoneFor: owner => f.zones.get(owner) ?? 'UTC', minSpacingMs: 0, proactiveByDefault: false, ...options });
  f.store = f.open(); if (!deferNew) f.scheduler = f.make(f.store);
  for (const label of ['a', 'b', 'c']) f[label] = f.store.getOrInsert('companion-identity-v1',
    principalKey({ issuer: 'https://synthetic.invalid', subject: 'routine-owner-' + label }), { companionId: randomUUID() }).companionId;
  f.rows = (owner = f.a) => f.store.db.prepare('SELECT * FROM scheduler_routine_occurrences WHERE companion_id=? ORDER BY due_at,id').all(owner);
  f.admit = (id, owner = f.a, scheduler = f.scheduler, store = f.store) => {
    store.db.exec('BEGIN IMMEDIATE');
    try { const result = scheduler.startInTransaction(owner, id); store.db.exec('COMMIT'); return result; }
    catch (error) { store.db.exec('ROLLBACK'); throw error; }
  };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
function denied(run, code = 'INVALID_REQUEST') { assert.throws(run, error => error instanceof SchedulerError && error.code === 'SCHEDULER_' + code); }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function oldScheduler(f) {
  const baseline = readFileSync(join(ROOT, 'test/fixtures/scheduler-v1.mjs.txt'));
  assert.equal(createHash('sha256').update(baseline).digest('hex'), '43e38ca38fe0c1f81a247f8a735c9685befda415f0e94b6d60300c848daf908b');
  const file = join(f.dir, 'old-scheduler.mjs'); writeFileSync(file, baseline);
  const { SchedulerStore: OldScheduler } = await import(pathToFileURL(file).href), store = f.open();
  return { store, scheduler: new OldScheduler({ store, now: () => f.clock, minSpacingMs: 0 }) };
}
function fakeConversations(f) {
  const records = new Map(), calls = [], cancels = [], key = (owner, id) => owner + ':' + id;
  return { records, calls, cancels, beforeEnqueue: null,
    proactiveResult(owner, id) { return records.get(key(owner, id)) ?? null; },
    async enqueueProactive(owner, input) {
      calls.push({ owner, ...input }); if (this.beforeEnqueue) await this.beforeEnqueue(owner, input);
      const prior = records.get(key(owner, input.id)); if (prior) return prior;
      const value = { id: input.id, state: f.admit(input.id, owner) ? 'running' : 'queued' }; records.set(key(owner, input.id), value); return value;
    },
    cancelProactive(owner, id) { cancels.push({ owner, id }); const value = records.get(key(owner, id)); if (value) value.state = 'cancelled'; return value ?? null; }
  };
}

test('routine defaults are off; exact nested patches preserve legacy and other-owner settings', t => {
  const f = fixture(t), before = f.scheduler.list(f.a);
  assert.deepEqual({ dailyDigest: before.settings.dailyDigest, weeklyCheckin: before.settings.weeklyCheckin }, defaults);
  f.scheduler.configure(f.a, { dailyDigest: { enabled: true }, weeklyCheckin: { localTime: '14:15', weekday: 3 } });
  f.scheduler.configure(f.a, { quietStart: '21:00' });
  const current = f.scheduler.configure(f.a, { dailyDigest: { localTime: '10:30' }, weeklyCheckin: {} }).settings;
  assert.deepEqual(current.dailyDigest, { enabled: true, localTime: '10:30' });
  assert.deepEqual(current.weeklyCheckin, { enabled: false, localTime: '14:15', weekday: 3 });
  assert.equal(current.quietStart, '21:00'); assert.equal(current.heartbeatEnabled, false);
  assert.deepEqual(f.scheduler.list(f.b).settings.dailyDigest, defaults.dailyDigest);
  for (const patch of [{ dailyDigest: null }, { dailyDigest: [] }, { dailyDigest: { enabled: 1 } },
    { dailyDigest: { localTime: '9:00' } }, { dailyDigest: { weekday: 1 } }, { weeklyCheckin: { weekday: 0 } },
    { weeklyCheckin: { weekday: 8 } }, { weeklyCheckin: { timezone: 'UTC' } }, { dailyDigest: { ownerId: f.b } }]) denied(() => f.scheduler.configure(f.a, patch));
  assert.deepEqual(f.scheduler.list(f.a).settings, current);
  f.clock += 30 * DAY; assert.deepEqual(f.scheduler.prepareDue(f.b), []); assert.deepEqual(f.rows(f.b), []);
});

test('local daily and editable weekly slots are future-only on activation and independently due', t => {
  const f = fixture(t);
  f.scheduler.configure(f.a, { dailyDigest: { enabled: true }, weeklyCheckin: { enabled: true, weekday: 3, localTime: '14:15' } });
  f.at('2026-11-02T08:59:59Z'); assert.deepEqual(f.scheduler.prepareDue(f.a), []);
  f.at('2026-11-02T09:00:00Z'); const [daily] = f.scheduler.prepareDue(f.a);
  assert.equal(daily.kind, 'watch'); assert.equal(daily.jobId, null); assert.equal(f.rows()[0].routine, 'dailyDigest');
  assert.equal(f.admit(daily.id), true); f.scheduler.finishOccurrence(f.a, daily.id, 'silent');
  f.at('2026-11-04T14:14:59Z'); f.scheduler.prepareDue(f.a); assert.ok(!f.rows().some(row => row.routine === 'weeklyCheckin'));
  f.at('2026-11-04T14:15:00Z'); f.scheduler.prepareDue(f.a);
  const weekly = f.rows().find(row => row.routine === 'weeklyCheckin');
  assert.equal(weekly.period, '2026-11-02'); assert.equal(weekly.due_at, f.clock);
  f.scheduler.configure(f.b, { dailyDigest: { enabled: true } });
  assert.deepEqual(f.scheduler.prepareDue(f.b), [], 'An afternoon activation does not backfill that morning');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM scheduler_occurrences').get().n, 0, 'Routines never pollute legacy occurrences');
});

for (const [name, timeZone, now, localTime, expected] of [
  ['winter local09', 'Europe/Paris', '2026-01-05T08:00:00Z', '09:00', '2026-01-05T08:00:00Z'],
  ['summer local09', 'Europe/Paris', '2026-07-06T07:00:00Z', '09:00', '2026-07-06T07:00:00Z'],
  ['spring gap first valid minute', 'Europe/Paris', '2026-03-29T01:00:00Z', '02:30', '2026-03-29T01:00:00Z'],
  ['autumn fold earlier occurrence', 'Europe/Paris', '2026-10-25T01:30:00Z', '02:30', '2026-10-25T00:30:00Z'],
  ['nonhour offset', 'Asia/Kathmandu', '2026-11-02T03:15:00Z', '09:00', '2026-11-02T03:15:00Z'],
  ['halfhour DST gap', 'Australia/Lord_Howe', '2026-10-03T15:30:00Z', '02:15', '2026-10-03T15:30:00Z']
]) test('calendar resolver: ' + name, () => {
  const slot = latestRoutineSlot({ now: Date.parse(now), timeZone, routine: 'dailyDigest', localTime });
  assert.equal(new Date(slot.dueAt).toISOString(), expected.replace('Z', '.000Z'));
});

test('fold restart, backward clock and attempted-period history never create a second attempt', t => {
  const f = fixture(t); f.zones.set(f.a, 'Europe/Paris'); f.at('2026-10-24T12:00:00Z');
  f.scheduler.configure(f.a, { quietStart: '00:00', quietEnd: '00:00', dailyDigest: { enabled: true, localTime: '02:30' } });
  f.at('2026-10-25T00:30:00Z'); const [first] = f.scheduler.prepareDue(f.a); assert.equal(f.admit(first.id), true);
  f.scheduler.finishOccurrence(f.a, first.id, 'interrupted');
  const reopenedStore = f.open(), reopened = f.make(reopenedStore);
  f.at('2026-10-25T00:00:00Z'); reopened.prepareDue(f.a);
  f.at('2026-10-25T01:30:00Z'); assert.deepEqual(reopened.prepareDue(f.a), []);
  reopened.configure(f.a, { dailyDigest: { enabled: false } }); reopened.configure(f.a, { dailyDigest: { enabled: true, localTime: '04:00' } });
  f.at('2026-10-25T03:00:00Z'); assert.deepEqual(reopened.prepareDue(f.a), []); assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].admitted_at, Date.parse('2026-10-25T00:30:00Z'));
});

test('clock rollback holds unattempted future work; downtime coalesces old pending/deferred slots', t => {
  const f = fixture(t); f.scheduler.configure(f.a, { dailyDigest: { enabled: true }, weeklyCheckin: { enabled: true } });
  f.at('2026-11-02T09:00:00Z'); const first = f.scheduler.prepareDue(f.a), firstIds = first.map(row => row.id);
  f.at('2026-11-02T08:30:00Z'); f.scheduler.prepareDue(f.a);
  assert.equal(f.rows().filter(row => row.state === 'queued').length, 2);
  f.at('2026-11-02T09:00:00Z'); assert.deepEqual(f.scheduler.prepareDue(f.a).map(row => row.id), firstIds);
  f.at('2026-11-23T12:00:00Z'); const latest = f.scheduler.prepareDue(f.a);
  assert.equal(latest.length, 2); assert.ok(f.rows().filter(row => row.state === 'queued').every(row => row.period === '2026-11-23'));
  assert.ok(f.rows().filter(row => firstIds.includes(row.id)).every(row => row.state === 'cancelled'));
  assert.equal(f.rows().length, 4, 'No intervening daily/weekly backlog is materialized');
});

test('routine prepare/admission across two connections retain one identity and roll back period and budget together', t => {
  const f = fixture(t); f.scheduler.configure(f.a, { dailyDigest: { enabled: true } }); f.at('2026-11-02T09:00:00Z');
  const [first] = f.scheduler.prepareDue(f.a), otherStore = f.open(), other = f.make(otherStore);
  assert.equal(other.prepareDue(f.a)[0].id, first.id);
  f.store.db.exec('BEGIN IMMEDIATE'); assert.equal(f.scheduler.startInTransaction(f.a, first.id), true); f.store.db.exec('ROLLBACK');
  assert.equal(f.rows()[0].admitted_at, null); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM scheduler_days').get().n, 0);
  assert.equal(f.admit(first.id, f.a, other, otherStore), true); assert.equal(f.admit(first.id), true);
  assert.equal(f.store.db.prepare('SELECT turns FROM scheduler_days WHERE companion_id=?').get(f.a).turns, 1);
  other.configure(f.a, { dailyDigest: { localTime: '10:00' } }); f.at('2026-11-02T10:00:00Z');
  assert.deepEqual(other.prepareDue(f.a), []); assert.equal(f.rows().length, 1, 'A new generation cannot retry an admitted local period');
});

test('quiet hours, daily caps, cooldown and admitted replay retain existing accounting', t => {
  const f = fixture(t, { maxTurnsPerDay: 1 });
  f.scheduler.configure(f.a, { quietEnd: '10:00', dailyDigest: { enabled: true }, weeklyCheckin: { enabled: true } });
  f.at('2026-11-02T09:00:00Z'); const due = f.scheduler.prepareDue(f.a);
  assert.equal(f.admit(due[0].id), false);
  f.at('2026-11-02T10:00:00Z'); assert.equal(f.admit(due[0].id), true); assert.equal(f.admit(due[0].id), true);
  assert.equal(f.admit(due[1].id), false); assert.equal(f.store.db.prepare('SELECT turns FROM scheduler_days WHERE companion_id=?').get(f.a).turns, 1);
  f.scheduler.finishOccurrence(f.a, due[0].id, 'error', { resetsAt: f.clock + DAY });
  const job = f.scheduler.create(f.a, { requestId: 'ordinary', text: 'Unrelated reminder', dueAt: new Date(f.clock).toISOString() }).created;
  const ordinary = f.scheduler.prepareDue(f.a).find(row => row.jobId === job.id); assert.equal(f.admit(ordinary.id), false);
  f.at('2026-11-03T10:00:00Z'); assert.equal(f.admit(ordinary.id), true, 'Existing cooldown and next local-day capacity apply to all work');
});

test('timezone edits cancel stale work, future same-period reschedule is allowed only before an attempt', t => {
  const f = fixture(t); f.scheduler.configure(f.a, { dailyDigest: { enabled: true } });
  f.at('2026-11-02T09:00:00Z'); const [old] = f.scheduler.prepareDue(f.a);
  f.zones.set(f.a, 'Europe/Paris'); assert.equal(f.scheduler.canDeliver(f.a, old.id), false);
  assert.deepEqual(f.scheduler.prepareDue(f.a), []); assert.equal(f.rows()[0].state, 'cancelled');
  f.at('2026-11-02T09:30:00Z'); f.scheduler.configure(f.a, { dailyDigest: { localTime: '11:00' } });
  f.at('2026-11-02T10:00:00Z'); const [fresh] = f.scheduler.prepareDue(f.a); assert.notEqual(fresh.id, old.id); assert.equal(f.admit(fresh.id), true);
  f.scheduler.finishOccurrence(f.a, fresh.id, 'silent'); f.zones.set(f.a, 'America/New_York'); f.scheduler.prepareDue(f.a);
  f.at('2026-11-02T16:00:00Z'); assert.deepEqual(f.scheduler.prepareDue(f.a), [], 'Same local day cannot be attempted again in another zone');
  f.zones.set(f.a, 'PRIVATE-INVALID-ZONE'); denied(() => f.scheduler.prepareDue(f.a), 'UNAVAILABLE');
});

test('service cancellation/supersession clear obsolete routines and fence a pre-conversation enqueue race', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = new SchedulerService({ scheduler: f.scheduler, conversations, companions: () => [f.a, f.b] });
  service.configure(f.a, { dailyDigest: { enabled: true }, weeklyCheckin: { enabled: true } });
  service.create(f.b, { requestId: 'other-owner', text: 'Other owner', dueAt: '2026-11-02T09:00:00Z' });
  f.at('2026-11-02T09:00:00Z'); await service.tick();
  const daily = f.rows().find(row => row.routine === 'dailyDigest'), weekly = f.rows().find(row => row.routine === 'weeklyCheckin');
  conversations.proactiveResult(f.a, daily.id).state = 'waiting_delivery'; service.configure(f.a, { dailyDigest: { enabled: false } });
  assert.equal(conversations.proactiveResult(f.a, daily.id).state, 'cancelled'); assert.equal(conversations.proactiveResult(f.a, weekly.id).state, 'running');
  assert.ok([...conversations.records.entries()].some(([key, value]) => key.startsWith(f.b) && value.state === 'running'));
  service.configure(f.a, { dailyDigest: { enabled: true, localTime: '10:00' } });
  f.at('2026-11-03T10:00:00Z'); const entered = deferred(), release = deferred();
  conversations.beforeEnqueue = async (owner, input) => { if (owner === f.a && input.prompt.includes('daily digest')) { entered.resolve(); await release.promise; } };
  const ticking = service.tick(); await entered.promise; service.configure(f.a, { dailyDigest: { enabled: false } }); release.resolve(); await ticking;
  const last = f.rows().filter(row => row.routine === 'dailyDigest').at(-1);
  assert.equal(last.state, 'cancelled'); assert.equal(last.admitted_at, null);
  assert.equal(conversations.proactiveResult(f.a, last.id).state, 'cancelled');
  conversations.proactiveResult(f.a, weekly.id).state = 'waiting_delivery'; conversations.beforeEnqueue = null;
  f.at('2026-11-09T09:00:00Z'); await service.tick();
  assert.equal(conversations.proactiveResult(f.a, weekly.id).state, 'cancelled', 'A newer week suppresses stale deferred private output');
  const newest = f.rows().find(row => row.routine === 'weeklyCheckin' && row.period === '2026-11-09');
  assert.equal(conversations.proactiveResult(f.a, newest.id).state, 'running');
});

test('actual old reader/writer ignores routine work on rollback and preserves its receipts for upgrade', async t => {
  const f = fixture(t), { store: oldStore, scheduler: old } = await oldScheduler(f);
  const columns = table => f.store.db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name);
  assert.deepEqual(columns('scheduler_settings'), ['companion_id', 'identity_key', 'enabled', 'quiet_start', 'quiet_end', 'heartbeat_enabled', 'heartbeat_generation', 'heartbeat_next_at', 'last_started_at', 'cooldown_until']);
  assert.equal(columns('scheduler_jobs').length, 9); assert.equal(columns('scheduler_occurrences').length, 11); assert.equal(columns('scheduler_days').length, 3);
  f.scheduler.configure(f.a, { dailyDigest: { enabled: true } });
  old.configure(f.a, { quietStart: '20:00' }); assert.equal(f.scheduler.list(f.a).settings.dailyDigest.enabled, true);
  old.list(f.c); const legacyJob = old.create(f.c, { requestId: 'old-new-owner', text: 'Legacy continues', dueAt: '2026-11-02T09:00:00Z' }).created;
  f.at('2026-11-02T09:00:00Z'); const [routine] = f.scheduler.prepareDue(f.a), [legacy] = old.prepareDue(f.c);
  assert.deepEqual(old.pending(f.a), []); assert.equal(old.canDeliver(f.a, routine.id), false);
  assert.equal(f.admit(routine.id, f.a, old, oldStore), false);
  assert.equal(f.admit(legacy.id, f.c, old, oldStore), true); old.finishOccurrence(f.c, legacy.id, 'message');
  assert.equal(old.list(f.c).items.find(row => row.id === legacyJob.id).state, 'complete');
  const resumedStore = f.open(), resumed = f.make(resumedStore);
  assert.equal(resumed.prepareDue(f.a)[0].id, routine.id); assert.equal(f.admit(routine.id, f.a, resumed, resumedStore), true);
  resumed.finishOccurrence(f.a, routine.id, 'interrupted');
  assert.deepEqual(resumed.prepareDue(f.a), []); assert.equal(f.rows()[0].state, 'interrupted');
});

test('forward expansion of an actual old database preserves every legacy row and starts routines disabled', async t => {
  const f = fixture(t, { deferNew: true }), { store, scheduler: old } = await oldScheduler(f);
  old.configure(f.a, { heartbeatEnabled: true });
  old.create(f.a, { requestId: 'before-upgrade', text: 'Existing reminder', dueAt: '2026-11-02T09:00:00Z' });
  f.at('2026-11-02T09:00:00Z'); const [due] = old.prepareDue(f.a);
  assert.equal(f.admit(due.id, f.a, old, store), true); old.finishOccurrence(f.a, due.id, 'message');
  const dump = () => Object.fromEntries(['scheduler_settings', 'scheduler_jobs', 'scheduler_occurrences', 'scheduler_days']
    .map(table => [table, f.store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  const retained = dump(); f.scheduler = f.make(f.store);
  const current = f.scheduler.list(f.a);
  assert.deepEqual(dump(), retained); assert.equal(current.settings.heartbeatEnabled, true);
  assert.deepEqual(current.settings.dailyDigest, defaults.dailyDigest); assert.deepEqual(current.settings.weeklyCheckin, defaults.weeklyCheckin);
  assert.deepEqual(f.rows(), []); assert.equal(current.items[0].state, 'complete');
});
