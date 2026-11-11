import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { SchedulerStore, SchedulerService, SchedulerError } from '../src/scheduler.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const iso = value => new Date(value).toISOString();

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-scheduler-')), stores = new Set();
  const f = { clock: Date.UTC(2026, 10, 2, 12), zones: new Map(), services: new Set() };
  f.now = () => f.clock;
  f.advance = amount => { f.clock += amount; };
  f.open = () => {
    const store = new BootstrapStore(dir, ROOT); stores.add(store);
    return { store, scheduler: new SchedulerStore({ store, now: f.now,
      timezoneFor: owner => f.zones.get(owner) ?? 'UTC', proactiveByDefault: false, ...options }) };
  };
  t.after(async () => {
    await Promise.all([...f.services].map(service => service.stop()));
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = f.open(); f.store = first.store; f.scheduler = first.scheduler;
  for (const label of ['a', 'b']) {
    const key = principalKey({ issuer: 'https://synthetic.invalid', subject: `scheduler-owner-${label}` });
    f[label] = f.store.getOrInsert('companion-identity-v1', key, { companionId: randomUUID() }).companionId;
  }
  f.create = (requestId, { owner = f.a, text = `Reminder ${requestId}`, dueAt = iso(f.now() + MINUTE) } = {}) => {
    f.scheduler.create(owner, { requestId, text, dueAt });
    return f.scheduler.list(owner).items.find(item => item.text === text);
  };
  f.admit = (owner, id, connection = first) => {
    connection.store.db.exec('BEGIN IMMEDIATE');
    try {
      const admitted = connection.scheduler.startInTransaction(owner, id);
      connection.store.db.exec('COMMIT'); return admitted;
    } catch (error) { connection.store.db.exec('ROLLBACK'); throw error; }
  };
  return f;
}

function denied(run, code) {
  assert.throws(run, error => error instanceof SchedulerError && error.code === `SCHEDULER_${code}`
    && !error.message.includes('PRIVATE-ERROR-CANARY'));
}

function fakeConversations(f) {
  const records = new Map(), calls = [], cancels = [], cancelled = new Set();
  const key = (owner, id) => `${owner}:${id}`;
  const fake = { records, calls, cancels, beforeEnqueue: null,
    async enqueueProactive(owner, occurrence) {
      calls.push({ owner, occurrence: structuredClone(occurrence) });
      await fake.beforeEnqueue?.(owner, occurrence);
      const identity = key(owner, occurrence.id), existing = records.get(identity);
      if (existing) return structuredClone(existing);
      const admitted = !cancelled.has(identity) && f.admit(owner, occurrence.id);
      const result = { id: occurrence.id, requestId: `proactive-${occurrence.id}`, threadId: randomUUID(),
        state: cancelled.has(identity) ? 'cancelled' : admitted ? 'running' : 'queued' };
      records.set(identity, result); return structuredClone(result);
    },
    proactiveResult(owner, id) { return structuredClone(records.get(key(owner, id)) ?? null); },
    cancelProactive(owner, id) {
      cancels.push({ owner, id }); cancelled.add(key(owner, id));
      const result = records.get(key(owner, id)); if (result) result.state = 'cancelled';
      return structuredClone(result ?? null);
    },
    state(owner, id, state) { records.get(key(owner, id)).state = state; }
  };
  return fake;
}

function serviceFor(f, conversations, extra = {}) {
  const service = new SchedulerService({ scheduler: f.scheduler, conversations,
    companions: () => [f.a, f.b], ready: () => true, pollMs: 1000, ...extra });
  f.services.add(service); return service;
}

test('defaults create no spontaneous work and reminder writes are owner-scoped and idempotent', t => {
  const f = fixture(t), before = f.scheduler.list(f.a);
  assert.equal(before.timezone, 'UTC'); assert.equal(before.now, iso(f.now()));
  assert.deepEqual(before.settings, { enabled: true, quietStart: '22:00', quietEnd: '08:00', heartbeatEnabled: false, boardWakeCap: 200,
    dailyDigest: { enabled: false, localTime: '09:00' }, weeklyCheckin: { enabled: false, localTime: '09:00', weekday: 1 }, proactive: { enabled: false, perDay: 4 } });
  assert.deepEqual(before.items, []); assert.deepEqual(before.followups, []); assert.deepEqual(f.scheduler.prepareDue(f.a), []);
  const input = { requestId: 'same-create', text: 'PRIVATE-REMINDER-A', dueAt: '2026-11-02T13:01:00+01:00' };
  const created = f.scheduler.create(f.a, input);
  assert.equal(created.items.length, 1); assert.equal(created.items[0].dueAt, '2026-11-02T12:01:00.000Z');
  assert.equal(created.items[0].canCancel, true);
  assert.deepEqual(f.scheduler.create(f.a, input), created);
  denied(() => f.scheduler.create(f.a, { ...input, text: 'changed' }), 'CONFLICT');
  assert.deepEqual(f.scheduler.list(f.b).items, []);
  f.scheduler.create(f.b, { ...input, text: 'PRIVATE-REMINDER-B' });
  assert.notEqual(f.scheduler.list(f.b).items[0].id, created.items[0].id);
  denied(() => f.scheduler.cancel(f.b, { id: created.items[0].id }), 'NOT_FOUND');
  assert.equal(f.scheduler.list(f.a).items[0].canCancel, true);
});

test('snapshots retain every active reminder and ten latest history rows without deleting durable replay records', t => {
  const f = fixture(t), active = f.create('old-active', { dueAt: iso(f.now() + DAY) });
  const history = []; let firstInput;
  for (let index = 0; index < 15; index++) {
    const input = { requestId: `historical-${index}`, text: `Historical reminder ${index}`, dueAt: iso(f.now() + MINUTE) };
    if (index === 0) firstInput = input;
    const response = f.scheduler.create(f.a, input);
    assert.deepEqual(response.created, response.items.find(item => item.id === response.created.id));
    history.push(response.created); f.advance(MINUTE); f.scheduler.prepareDue(f.a);
    f.scheduler.cancel(f.a, { id: response.created.id });
  }
  const visible = f.scheduler.list(f.a);
  assert.equal(visible.items.length, 11);
  assert.equal(visible.items.find(item => item.id === active.id).canCancel, true);
  assert.deepEqual(new Set(visible.items.filter(item => !item.canCancel).map(item => item.id)), new Set(history.slice(-10).map(item => item.id)));
  assert.equal(visible.items.some(item => item.id === history[0].id), false);
  const counts = () => ({ jobs: f.store.db.prepare('SELECT COUNT(*) AS n FROM scheduler_jobs').get().n,
    occurrences: f.store.db.prepare('SELECT COUNT(*) AS n FROM scheduler_occurrences').get().n });
  assert.deepEqual(counts(), { jobs: 16, occurrences: 15 });
  const replay = f.scheduler.create(f.a, firstInput);
  assert.deepEqual(replay.created, { ...history[0], version: 2, state: 'cancelled', canCancel: false });
  assert.equal(replay.items.some(item => item.id === replay.created.id), false, 'The off-page canonical receipt does not expand history');
  assert.deepEqual(counts(), { jobs: 16, occurrences: 15 });
});

test('maximum Unicode reminders keep all fifty active rows visible and the complete create response below 512 KiB', t => {
  const f = fixture(t), value = '界'.repeat(2000), activeIds = new Set();
  for (let index = 0; index < 10; index++) {
    const response = f.scheduler.create(f.a, { requestId: `unicode-history-${index}`, text: value, dueAt: iso(f.now() + MINUTE) });
    f.scheduler.cancel(f.a, { id: response.created.id });
  }
  let response;
  for (let index = 0; index < 50; index++) {
    response = f.scheduler.create(f.a, { requestId: `unicode-active-${index}`, text: value, dueAt: iso(f.now() + MINUTE) });
    activeIds.add(response.created.id);
  }
  assert.equal(response.items.length, 60);
  assert.deepEqual(new Set(response.items.filter(item => item.canCancel).map(item => item.id)), activeIds);
  assert.equal(response.created.text, value);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 512 * 1024);
  denied(() => f.scheduler.create(f.a, { requestId: 'unicode-over-cap', text: value, dueAt: iso(f.now() + MINUTE) }), 'CAPACITY');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM scheduler_jobs').get().n, 60);
  assert.equal(f.scheduler.cancel(f.a, { id: response.created.id }).items.find(item => item.id === response.created.id).canCancel, false);
});

test('due occurrence identities survive repeated scans and a new SQLite connection', t => {
  const f = fixture(t), job = f.create('one-due');
  assert.deepEqual(f.scheduler.prepareDue(f.a), []);
  f.advance(MINUTE);
  const [occurrence] = f.scheduler.prepareDue(f.a);
  assert.equal(occurrence.kind, 'reminder'); assert.equal(occurrence.jobId, job.id);
  assert.equal(occurrence.dueAt, job.dueAt); assert.match(occurrence.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(occurrence).sort(), ['dueAt', 'generation', 'id', 'jobId', 'kind', 'prompt']);
  assert.deepEqual(f.scheduler.prepareDue(f.a), [occurrence]);
  const other = f.open();
  assert.deepEqual(other.scheduler.prepareDue(f.a), [occurrence]);
  assert.deepEqual(other.scheduler.pending(f.a), [occurrence]);
  assert.deepEqual(other.scheduler.pending(f.b), []);
});

test('admission participates in its caller transaction and rollback does not consume daily capacity', t => {
  const f = fixture(t, { minSpacingMs: 0, maxTurnsPerDay: 1 });
  f.create('rollback-first'); f.create('rollback-second'); f.advance(MINUTE);
  const occurrences = f.scheduler.prepareDue(f.a);
  f.store.db.exec('BEGIN IMMEDIATE');
  assert.equal(f.scheduler.startInTransaction(f.a, occurrences[0].id), true);
  f.store.db.exec('ROLLBACK');
  assert.equal(f.admit(f.a, occurrences[1].id), true);
  assert.equal(f.admit(f.a, occurrences[1].id), true, 'An admitted occurrence replay does not consume capacity');
  assert.equal(f.admit(f.a, occurrences[0].id), false);
});

test('minimum spacing and local-day caps persist across connections without charging admitted replays', t => {
  const f = fixture(t, { maxTurnsPerDay: 2 });
  for (const id of ['first', 'second', 'third']) f.create(id);
  f.create('other-owner', { owner: f.b }); f.advance(MINUTE);
  const [first, second, third] = f.scheduler.prepareDue(f.a), other = f.open();
  assert.equal(f.admit(f.a, first.id), true);
  assert.equal(f.admit(f.a, first.id, other), true);
  f.scheduler.finishOccurrence(f.a, first.id, 'complete');
  assert.equal(f.admit(f.a, second.id, other), false);
  f.advance(5 * MINUTE - 1);
  assert.equal(f.admit(f.a, second.id, other), false);
  f.advance(1); assert.equal(f.admit(f.a, second.id, other), true);
  other.scheduler.finishOccurrence(f.a, second.id, 'silent');
  f.advance(5 * MINUTE); assert.equal(f.admit(f.a, third.id), false, 'Daily capacity remains exhausted after spacing');
  const [otherOccurrence] = f.scheduler.prepareDue(f.b);
  assert.equal(f.admit(f.b, otherOccurrence.id), true, 'Another owner has a separate admission budget');
  f.clock = Date.UTC(2026, 10, 3, 9);
  assert.equal(f.admit(f.a, third.id, other), true, 'A new local day grants fresh capacity');
});

test('the daily admission counter resets at owner-local midnight while the UTC date stays unchanged', t => {
  const f = fixture(t, { minSpacingMs: 0, maxTurnsPerDay: 1 });
  f.zones.set(f.a, 'Asia/Tokyo'); f.clock = Date.UTC(2026, 10, 2, 14, 58);
  f.scheduler.configure(f.a, { quietStart: '08:00', quietEnd: '08:00' });
  f.create('local-day-first'); f.create('local-day-second'); f.advance(MINUTE);
  const [first, second] = f.scheduler.prepareDue(f.a);
  assert.equal(f.admit(f.a, first.id), true);
  f.scheduler.finishOccurrence(f.a, first.id, 'complete');
  assert.equal(f.admit(f.a, second.id), false);
  f.advance(MINUTE);
  assert.equal(iso(f.now()).slice(0, 10), '2026-11-02');
  assert.equal(f.admit(f.a, second.id, f.open()), true);
});

for (const [name, before, release] of [
  ['spring DST', '2026-03-28T21:29:00Z', '2026-03-29T06:00:00Z'],
  ['autumn DST', '2026-10-24T20:29:00Z', '2026-10-25T07:00:00Z']
]) {
  test(`${name}: quiet hours follow the owner's IANA timezone and release at local 08:00`, t => {
    const f = fixture(t, { maxTurnsPerDay: 1 }); f.zones.set(f.a, 'Europe/Paris'); f.clock = Date.parse(before);
    f.create(`quiet-${name.replaceAll(' ', '-')}`); f.advance(MINUTE);
    const [occurrence] = f.scheduler.prepareDue(f.a);
    assert.equal(f.scheduler.list(f.a).timezone, 'Europe/Paris');
    assert.equal(f.admit(f.a, occurrence.id), false); assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), false);
    f.clock = Date.parse(release) - 1;
    assert.equal(f.admit(f.a, occurrence.id), false); assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), false);
    f.advance(1); assert.equal(f.admit(f.a, occurrence.id), true);
    assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), true);
  });
}

test('quiet intervals can cross midnight, equal endpoints disable quiet, and disabled settings fence existing work', t => {
  const f = fixture(t); f.clock = Date.UTC(2026, 10, 2, 23);
  f.create('config-fence'); f.advance(MINUTE);
  const [occurrence] = f.scheduler.prepareDue(f.a);
  assert.equal(f.admit(f.a, occurrence.id), false);
  f.scheduler.configure(f.a, { quietStart: '08:00', quietEnd: '08:00' });
  assert.equal(f.admit(f.a, occurrence.id), true); assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), true);
  f.scheduler.configure(f.a, { enabled: false });
  assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), false);
  assert.equal(f.scheduler.list(f.b).settings.enabled, true);
  f.scheduler.configure(f.a, { enabled: true });
  assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), true);
});

test('late reminders are visible as missed instead of generating an old catch-up message', t => {
  const f = fixture(t); f.create('missed'); f.advance(MINUTE + DAY + 1);
  assert.deepEqual(f.scheduler.prepareDue(f.a), []);
  const [missed] = f.scheduler.list(f.a).items;
  assert.equal(missed.state, 'missed'); assert.equal(missed.canCancel, false);
  assert.deepEqual(f.scheduler.pending(f.a), []);
  f.advance(DAY); assert.deepEqual(f.scheduler.prepareDue(f.a), []);
});

test('prepared but unstarted reminders expire after the grace window while admitted work keeps its receipt', t => {
  const f = fixture(t), queuedJob = f.create('prepared-then-late'), admittedJob = f.create('already-admitted');
  f.advance(MINUTE);
  const due = f.scheduler.prepareDue(f.a), queued = due.find(wake => wake.jobId === queuedJob.id);
  const admitted = due.find(wake => wake.jobId === admittedJob.id);
  assert.equal(f.admit(f.a, admitted.id), true);
  f.advance(DAY + 1);
  assert.deepEqual(f.scheduler.prepareDue(f.a), [admitted]);
  assert.equal(f.scheduler.list(f.a).items.find(item => item.id === queuedJob.id).state, 'missed');
  assert.equal(f.scheduler.canDeliver(f.a, queued.id), false);
  assert.equal(f.scheduler.canDeliver(f.a, admitted.id), true);
  f.scheduler.finishOccurrence(f.a, admitted.id, 'complete');
  assert.equal(f.scheduler.list(f.a).items.find(item => item.id === admittedJob.id).state, 'complete');
  assert.deepEqual(f.scheduler.pending(f.a), []);
});

test('heartbeat is opt-in and a long outage coalesces into one six-hour occurrence', t => {
  const f = fixture(t); f.clock = Date.UTC(2026, 10, 2, 9);
  f.advance(3 * DAY); assert.deepEqual(f.scheduler.prepareDue(f.a), []);
  f.scheduler.configure(f.a, { heartbeatEnabled: true });
  assert.deepEqual(f.scheduler.prepareDue(f.a), []);
  f.advance(3 * DAY + 6 * HOUR);
  const [catchup] = f.scheduler.prepareDue(f.a);
  assert.equal(catchup.kind, 'heartbeat');
  assert.deepEqual(f.scheduler.prepareDue(f.a), [catchup]);
  assert.deepEqual(f.scheduler.list(f.a).items, [], 'Heartbeat does not create a reminder row in the UI');
  assert.equal(f.admit(f.a, catchup.id), true);
  f.scheduler.finishOccurrence(f.a, catchup.id, 'silent');
  assert.deepEqual(f.scheduler.prepareDue(f.a), []);
  f.advance(6 * HOUR);
  const [next] = f.scheduler.prepareDue(f.a);
  assert.equal(next.kind, 'heartbeat'); assert.notEqual(next.id, catchup.id);
  f.scheduler.configure(f.a, { heartbeatEnabled: false });
  assert.equal(f.scheduler.canDeliver(f.a, next.id), false);
});

test('watch and Board events deduplicate independently per owner and terminal receipts never resurrect', t => {
  const f = fixture(t);
  const input = { requestId: 'source-event', kind: 'watch', prompt: 'A source condition changed.' };
  const event = f.scheduler.enqueueEvent(f.a, input);
  assert.equal(event.kind, 'watch'); assert.deepEqual(f.scheduler.enqueueEvent(f.a, input), event);
  denied(() => f.scheduler.enqueueEvent(f.a, { ...input, kind: 'board' }), 'CONFLICT');
  const other = f.scheduler.enqueueEvent(f.b, input); assert.notEqual(other.id, event.id);
  assert.equal(f.admit(f.a, event.id), true);
  f.scheduler.finishOccurrence(f.a, event.id, 'complete');
  f.scheduler.finishOccurrence(f.a, event.id, 'complete');
  f.scheduler.enqueueEvent(f.a, input);
  assert.deepEqual(f.scheduler.pending(f.a), []);
  assert.equal(f.scheduler.canDeliver(f.a, event.id), false);
  assert.deepEqual(f.scheduler.pending(f.b), [other]);
});

test('cancel tombstones a job and its generation so queued or admitted delivery cannot survive it', t => {
  const f = fixture(t), job = f.create('cancel-me'), queuedJob = f.create('cancel-before-start'); f.advance(MINUTE);
  const due = f.scheduler.prepareDue(f.a), occurrence = due.find(wake => wake.jobId === job.id);
  const queued = due.find(wake => wake.jobId === queuedJob.id);
  assert.equal(f.admit(f.a, occurrence.id), true);
  f.scheduler.cancel(f.a, { id: queuedJob.id });
  assert.equal(f.scheduler.canDeliver(f.a, queued.id), false);
  const result = f.scheduler.cancel(f.a, { id: job.id });
  assert.equal(result.items.find(item => item.id === job.id).state, 'cancelled');
  assert.equal(result.items.find(item => item.id === job.id).canCancel, false);
  assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), false);
  assert.deepEqual(f.scheduler.pending(f.a), [occurrence], 'Admitted work remains observable until its terminal callback');
  assert.deepEqual(f.scheduler.cancel(f.a, { id: job.id }), result);
  f.scheduler.finishOccurrence(f.a, occurrence.id, 'complete');
  assert.equal(f.scheduler.list(f.a).items.find(item => item.id === job.id).state, 'cancelled');
  assert.deepEqual(f.scheduler.pending(f.a), []);
  f.advance(HOUR); assert.deepEqual(f.scheduler.prepareDue(f.a), []);
});

test('invalid inputs cannot inject owner selectors, unbounded jobs, unsupported events or malformed quiet times', t => {
  const f = fixture(t), valid = { requestId: 'invalid-create', text: 'A reminder', dueAt: iso(f.now() + MINUTE) };
  for (const input of [
    { ...valid, companionId: f.b }, { ...valid, dueAt: 'tomorrow' }, { ...valid, dueAt: '2026-11-02T13:00:00' },
    { ...valid, text: '' }, { ...valid, text: 'x'.repeat(2001) }, { ...valid, requestId: '../other' }
  ]) denied(() => f.scheduler.create(f.a, input), 'INVALID_REQUEST');
  for (const settings of [{ quietStart: '25:00' }, { quietEnd: '8:00' }, { enabled: 'yes' }, { ownerId: f.b }]) {
    denied(() => f.scheduler.configure(f.a, settings), 'INVALID_REQUEST');
  }
  denied(() => f.scheduler.enqueueEvent(f.a, { requestId: 'invalid-event', kind: 'shell', prompt: 'PRIVATE-ERROR-CANARY' }), 'INVALID_REQUEST');
  assert.deepEqual(f.scheduler.list(f.a).items, []); assert.deepEqual(f.scheduler.pending(f.a), []);
});

test('service hands durable occurrences to Conversations and observes completion without duplicating work', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  service.create(f.a, { requestId: 'service-a', text: 'A reminder', dueAt: iso(f.now() + MINUTE) });
  service.create(f.b, { requestId: 'service-b', text: 'B reminder', dueAt: iso(f.now() + MINUTE) });
  f.advance(MINUTE); await service.tick();
  assert.equal(conversations.records.size, 2);
  for (const owner of [f.a, f.b]) {
    const [occurrence] = f.scheduler.pending(owner);
    assert.equal(conversations.proactiveResult(owner, occurrence.id).state, 'running');
    conversations.state(owner, occurrence.id, 'message');
  }
  await service.tick(); await service.tick();
  assert.deepEqual(f.scheduler.pending(f.a), []); assert.deepEqual(f.scheduler.pending(f.b), []);
  assert.equal(conversations.records.size, 2);
  assert.equal(service.list(f.a).items[0].state, 'complete');
});

test('a waiting result retries private delivery while the provider is unavailable without creating another turn', async t => {
  const f = fixture(t), conversations = fakeConversations(f); let ready = true;
  const service = serviceFor(f, conversations, { ready: () => ready });
  f.create('waiting-result'); f.advance(MINUTE); await service.tick();
  const [occurrence] = f.scheduler.pending(f.a);
  conversations.state(f.a, occurrence.id, 'waiting_delivery'); ready = false;
  conversations.beforeEnqueue = (owner, wake) => conversations.state(owner, wake.id, 'message');
  await service.tick();
  assert.equal(conversations.calls.length, 2);
  assert.equal(conversations.records.size, 1);
  assert.equal(conversations.calls[1].occurrence.id, occurrence.id);
  assert.deepEqual(f.scheduler.pending(f.a), []);
  assert.equal(service.list(f.a).items[0].state, 'complete');
});

test('service readiness defers work and cancellation targets only the owned occurrence', async t => {
  const f = fixture(t), conversations = fakeConversations(f); let ready = false;
  const service = serviceFor(f, conversations, { ready: () => ready });
  const job = f.create('ready-cancel'); f.create('unrelated', { owner: f.b }); f.advance(MINUTE);
  await service.tick(); assert.equal(conversations.calls.length, 0);
  ready = true; await service.tick();
  const [occurrence] = f.scheduler.pending(f.a), [other] = f.scheduler.pending(f.b);
  await service.cancel(f.a, { id: job.id });
  assert.deepEqual(conversations.cancels, [{ owner: f.a, id: occurrence.id }]);
  assert.equal(f.scheduler.canDeliver(f.a, occurrence.id), false);
  assert.equal(conversations.proactiveResult(f.b, other.id).state, 'running');
  await service.tick(); assert.deepEqual(f.scheduler.pending(f.a), []);
});

test('turning heartbeat off aborts its admitted conversation and preserves the generation fence', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  service.configure(f.a, { heartbeatEnabled: true });
  f.advance(6 * HOUR); await service.tick();
  const [wake] = f.scheduler.pending(f.a);
  assert.equal(wake.kind, 'heartbeat');
  assert.equal(conversations.proactiveResult(f.a, wake.id).state, 'running');
  const configured = service.configure(f.a, { heartbeatEnabled: false });
  assert.equal(configured.settings.heartbeatEnabled, false);
  assert.deepEqual(conversations.cancels, [{ owner: f.a, id: wake.id }]);
  assert.equal(f.scheduler.canDeliver(f.a, wake.id), false);
  await service.tick();
  assert.deepEqual(f.scheduler.pending(f.a), []);
});

test('overlapping ticks and cancellation during enqueue cannot create a second occurrence or allow late delivery', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  const job = f.create('cancel-race'); f.advance(MINUTE);
  const entered = deferred(), release = deferred();
  conversations.beforeEnqueue = async () => { entered.resolve(); await release.promise; };
  const first = service.tick();
  await Promise.race([entered.promise, first.then(() => { throw new Error('The scheduler did not enqueue due work'); })]);
  const second = service.tick();
  await service.cancel(f.a, { id: job.id });
  const [call] = conversations.calls;
  assert.equal(f.scheduler.canDeliver(f.a, call.occurrence.id), false);
  release.resolve(); await Promise.all([first, second]);
  assert.equal(conversations.calls.length, 1);
  assert.equal(conversations.proactiveResult(f.a, call.occurrence.id).state, 'cancelled');
  assert.deepEqual(f.scheduler.pending(f.a), []);
});

test('cancellation before the conversation row exists also cancels its later queued admission', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  const job = f.create('cancel-before-conversation'); f.advance(MINUTE);
  const entered = deferred(), release = deferred();
  conversations.beforeEnqueue = async () => { entered.resolve(); await release.promise; };
  const originalCancel = conversations.cancelProactive;
  conversations.cancelProactive = (owner, id) => conversations.proactiveResult(owner, id) ? originalCancel(owner, id) : null;
  const ticking = service.tick(); await entered.promise;
  await service.cancel(f.a, { id: job.id }); release.resolve(); await ticking;
  const [{ owner, occurrence }] = conversations.calls;
  assert.equal(conversations.proactiveResult(owner, occurrence.id).state, 'cancelled');
  assert.equal(f.scheduler.canDeliver(owner, occurrence.id), false);
  assert.deepEqual(f.scheduler.pending(owner), []);
});

test('service stop joins an active tick and prevents timer callbacks from admitting later work', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations, { pollMs: 10 });
  f.create('shutdown-first'); f.advance(MINUTE);
  const entered = deferred(), release = deferred();
  conversations.beforeEnqueue = async () => { entered.resolve(); await release.promise; };
  const ticking = service.tick();
  await Promise.race([entered.promise, ticking.then(() => { throw new Error('The scheduler did not enqueue due work'); })]);
  service.start();
  let stopped = false;
  const stopping = Promise.resolve(service.stop()).then(() => { stopped = true; });
  await nextTurn(); assert.equal(stopped, false, 'Shutdown waits for its active pass before the store can close');
  release.resolve(); await Promise.all([ticking, stopping]);
  const count = conversations.calls.length;
  f.create('shutdown-later'); f.advance(MINUTE);
  await delay(25);
  assert.equal(conversations.calls.length, count);
});

// #51: once the proactive daily budget was spent, every later Board mention stayed queued until midnight.
test('Board wakes never spend or wait on the proactive daily budget, and held wakes log why once', t => {
  const lines = [];
  const f = fixture(t, { minSpacingMs: 0, maxTurnsPerDay: 1, log: line => lines.push(line) });
  f.create('budget-reminder'); f.create('budget-second'); f.advance(MINUTE);
  const [reminder, second] = f.scheduler.prepareDue(f.a);
  assert.equal(f.admit(f.a, reminder.id), true);
  f.scheduler.finishOccurrence(f.a, reminder.id, 'complete');
  assert.equal(f.admit(f.a, second.id), false, 'The proactive budget is spent');
  assert.equal(f.admit(f.a, second.id), false);
  assert.deepEqual(lines.filter(line => line.endsWith(': daily_cap')).length, 1, 'A held wake logs its reason once');
  f.scheduler.enqueueEvent(f.a, { requestId: 'board-mention-after-cap', kind: 'board', prompt: 'Mentioned on the Board.' });
  const board = f.scheduler.pending(f.a).find(wake => wake.kind === 'board');
  assert.equal(f.admit(f.a, board.id), true, 'A Board mention is admitted after the proactive cap');
  f.scheduler.finishOccurrence(f.a, board.id, 'silent');
  assert.equal(f.admit(f.a, second.id), false, 'The Board wake did not refill or reset the proactive budget');
  assert.ok(lines.every(line => !line.includes('Mentioned on the Board')), 'Logs never carry prompts');
});

test('Board wakes keep their own spacing and rolling cap so reply loops stay bounded', t => {
  const lines = [];
  const f = fixture(t, { boardSpacingMs: 30000, log: line => lines.push(line) });
  assert.equal(f.scheduler.list(f.a).settings.boardWakeCap, 200, 'The default Board cap is 200 per 24 h');
  f.scheduler.configure(f.a, { boardWakeCap: 2 });
  const enqueue = requestId => {
    f.scheduler.enqueueEvent(f.a, { requestId, kind: 'board', prompt: `Board ${requestId}` });
    return f.scheduler.pending(f.a).find(wake => wake.prompt === `Board ${requestId}`);
  };
  const first = enqueue('board-first'), second = enqueue('board-second');
  assert.equal(f.admit(f.a, first.id), true);
  f.scheduler.finishOccurrence(f.a, first.id, 'message');
  assert.equal(f.admit(f.a, second.id), false, 'Board spacing holds a burst');
  assert.ok(lines.some(line => line.startsWith('Scheduler held board wake') && line.endsWith(': board_spacing')));
  f.advance(30000); assert.equal(f.admit(f.a, second.id), true);
  f.scheduler.finishOccurrence(f.a, second.id, 'message');
  f.advance(MINUTE); const third = enqueue('board-third');
  assert.equal(f.admit(f.a, third.id), false, 'The rolling Board cap holds further wakes');
  assert.ok(lines.some(line => line.endsWith(': board_daily_cap')));
  f.advance(DAY); assert.equal(f.admit(f.a, third.id), true, 'The rolling window frees capacity again');
  f.create('proactive-still-free'); f.advance(MINUTE);
  const reminder = f.scheduler.prepareDue(f.a).find(wake => wake.kind !== 'board');
  assert.equal(f.admit(f.a, reminder.id), true, 'Board wakes did not consume proactive spacing or budget');
});

test('the owner can change or remove the Board wake cap, and invalid caps are refused', t => {
  const f = fixture(t, { boardSpacingMs: 0 });
  for (const bad of [0, -1, 1.5, '10', 10001, true]) denied(() => f.scheduler.configure(f.a, { boardWakeCap: bad }), 'INVALID_REQUEST');
  assert.equal(f.scheduler.configure(f.a, { boardWakeCap: 1 }).settings.boardWakeCap, 1);
  const wake = requestId => { f.scheduler.enqueueEvent(f.a, { requestId, kind: 'board', prompt: `Board ${requestId}` });
    return f.scheduler.pending(f.a).find(item => item.prompt === `Board ${requestId}`); };
  const first = wake('cap-one'); assert.equal(f.admit(f.a, first.id), true); f.scheduler.finishOccurrence(f.a, first.id, 'silent');
  const second = wake('cap-two'); assert.equal(f.admit(f.a, second.id), false);
  const removed = f.scheduler.configure(f.a, { boardWakeCap: null });
  assert.equal(removed.settings.boardWakeCap, null, 'null removes the cap');
  assert.equal(removed.settings.quietStart, '22:00', 'Changing the cap leaves other settings alone');
  assert.equal(f.admit(f.a, second.id), true);
  assert.equal(f.scheduler.list(f.b).settings.boardWakeCap, 200, 'Another owner keeps the default');
  assert.equal(f.open().scheduler.list(f.a).settings.boardWakeCap, null, 'The choice persists across connections');
});

test('agent runner wakes start in quiet hours; their message still waits, and other Board wakes stay held (#72)', t => {
  const f = fixture(t); f.clock = Date.UTC(2026, 10, 2, 23);
  const agents = f.scheduler.enqueueEvent(f.a, { requestId: 'agents-0123456789abcdef', kind: 'board', prompt: 'Agent run r ended.' });
  const mention = f.scheduler.enqueueEvent(f.a, { requestId: 'board-mention-0123456789abcdef', kind: 'board', prompt: 'Mention.' });
  assert.equal(f.admit(f.a, agents.id), true);
  assert.equal(f.scheduler.canDeliver(f.a, agents.id), false, 'a message to the owner waits for quiet hours to end');
  f.advance(MINUTE);
  assert.equal(f.admit(f.a, mention.id), false);
  f.clock = Date.UTC(2026, 10, 3, 8, 1);
  assert.equal(f.scheduler.canDeliver(f.a, agents.id), true);
});
