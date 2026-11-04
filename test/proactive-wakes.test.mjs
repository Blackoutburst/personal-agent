import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { SchedulerStore, SchedulerService, SchedulerError } from '../src/scheduler.mjs';

// #54: the companion's own wakes and self-scheduled follow-ups (synthetic owners, no provider).
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const iso = value => new Date(value).toISOString();

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-proactive-'));
  const f = { clock: Date.UTC(2026, 10, 2, 12), randoms: [], services: new Set() };
  f.now = () => f.clock;
  f.random = () => f.randoms.length ? f.randoms.shift() : 0.5;
  f.store = new BootstrapStore(dir, ROOT);
  f.scheduler = new SchedulerStore({ store: f.store, now: f.now, random: f.random, timezoneFor: () => 'UTC', ...options });
  t.after(async () => {
    await Promise.all([...f.services].map(service => service.stop()));
    f.store.close(); rmSync(dir, { recursive: true, force: true });
  });
  for (const label of ['a', 'b']) {
    const key = principalKey({ issuer: 'https://synthetic.invalid', subject: `proactive-owner-${label}` });
    f[label] = f.store.getOrInsert('companion-identity-v1', key, { companionId: randomUUID() }).companionId;
  }
  f.admit = (owner, id) => {
    f.store.db.exec('BEGIN IMMEDIATE');
    try { const admitted = f.scheduler.startInTransaction(owner, id); f.store.db.exec('COMMIT'); return admitted; }
    catch (error) { f.store.db.exec('ROLLBACK'); throw error; }
  };
  f.own = (owner = f.a) => f.scheduler.prepareDue(owner).filter(wake => ['proactive', 'followup'].includes(wake.kind));
  f.nextAt = (owner = f.a) => f.store.db.prepare('SELECT next_at FROM scheduler_proactive_settings WHERE companion_id=?').get(owner)?.next_at;
  f.generation = (owner = f.a) => f.store.db.prepare('SELECT generation FROM scheduler_proactive_settings WHERE companion_id=?').get(owner)?.generation;
  f.followup = (requestId, { at = iso(f.clock + HOUR), note = `Follow up ${requestId}`, owner = f.a } = {}) =>
    f.scheduler.createFollowup(owner, { requestId, at, note }).createdFollowup;
  return f;
}
function denied(run, code) { assert.throws(run, error => error instanceof SchedulerError && error.code === `SCHEDULER_${code}`); }
function fakeConversations(f) {
  const records = new Map(), cancels = [];
  return { cancels,
    async enqueueProactive(owner, wake) {
      const admitted = f.admit(owner, wake.id), result = { id: wake.id, state: admitted ? 'running' : 'queued' };
      records.set(wake.id, result); return { ...result };
    },
    proactiveResult(owner, id) { return records.has(id) ? { ...records.get(id) } : null; },
    cancelProactive(owner, id) { cancels.push(id); const result = records.get(id); if (result) result.state = 'cancelled'; return result ?? null; },
    finish(id, state) { records.get(id).state = state; } };
}
function serviceFor(f, conversations) {
  const service = new SchedulerService({ scheduler: f.scheduler, conversations, companions: () => [f.a], ready: () => true, pollMs: 1000 });
  f.services.add(service); return service;
}

test('owners are on by default at four a day, and every next wake is jittered within half to one and a half spacings', t => {
  const f = fixture(t);
  assert.deepEqual(f.scheduler.list(f.a).settings.proactive, { enabled: true, perDay: 4 });
  f.randoms.push(0); f.scheduler.prepareDue(f.a);
  assert.equal(f.nextAt(), f.clock + 3 * HOUR, 'The lowest factor is half of the six-hour spacing');
  for (const perDay of [2, 4, 6, 8]) for (const random of [0, 0.25, 0.5, 0.999999]) {
    f.scheduler.configure(f.a, { proactive: { perDay: perDay === 4 ? 2 : 4 } });
    f.randoms.push(random); f.scheduler.configure(f.a, { proactive: { perDay } });
    const spacing = DAY / perDay, delta = f.nextAt() - f.clock;
    assert.ok(delta >= spacing * 0.5 && delta < spacing * 1.5, `${perDay}/day factor ${random}`);
    assert.equal(delta, Math.round(spacing * (0.5 + random)));
  }
  // An invalid random source falls back to the average spacing instead of a broken schedule.
  for (const bad of [NaN, -1, 1, '0.3']) {
    f.scheduler.configure(f.a, { proactive: { perDay: 4 } }); f.randoms.push(bad); f.scheduler.configure(f.a, { proactive: { perDay: 2 } });
    assert.equal(f.nextAt() - f.clock, 12 * HOUR);
  }
  // With jitter, a day still holds about the chosen number of wakes.
  const g = fixture(t, { minSpacingMs: 0 }); let count = 0;
  g.scheduler.configure(g.a, { proactive: { perDay: 8 } });
  for (let step = 0; step < 7 * 24 * 12; step++) {
    g.randoms.push((step * 0.6180339) % 1); g.clock += 5 * MINUTE;
    for (const wake of g.own()) { assert.equal(g.admit(g.a, wake.id), true); g.scheduler.finishOccurrence(g.a, wake.id, 'silent'); count++; }
  }
  assert.ok(count >= 7 * 6 && count <= 7 * 10, `about eight a day over a week (${count})`);
});

test('a wake becomes one pending proactive occurrence; downtime coalesces to one and draws the next from now', t => {
  const f = fixture(t); f.scheduler.prepareDue(f.a);
  f.clock = f.nextAt() - MINUTE; assert.deepEqual(f.own(), []);
  f.clock += MINUTE; const [wake] = f.own();
  assert.equal(wake.kind, 'proactive'); assert.match(wake.prompt, /one of your own wakes/); assert.match(wake.prompt, /Silent is a normal, good outcome/);
  assert.match(wake.prompt, /Monday,? 2 November 2026 at 18:00 \(UTC\)/); assert.doesNotMatch(wake.prompt, /quiet hours/);
  assert.equal(f.nextAt(), f.clock + 6 * HOUR);
  f.clock += 3 * DAY; const after = f.own();
  assert.deepEqual(after.map(item => item.id), [wake.id], 'No backlog after three days down: the waiting wake is still the only one');
  assert.equal(f.nextAt(), f.clock + 6 * HOUR, 'The next wake counts from now');
  assert.equal(f.admit(f.a, wake.id), true); f.scheduler.finishOccurrence(f.a, wake.id, 'silent');
  f.clock = f.nextAt(); assert.equal(f.own().length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM scheduler_occurrences WHERE kind IN ('proactive','followup')").get().n, 0,
    'New kinds never enter the legacy occurrence table older releases would admit');
  assert.deepEqual(f.scheduler.prepareDue(f.b).filter(item => item.kind === 'proactive'), [], 'Owners are scheduled independently');
});

test('the off switch and frequency changes bump the generation, cancel queued own wakes and keep the other value', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  f.scheduler.prepareDue(f.a); const first = f.generation();
  f.clock = f.nextAt(); const [wake] = f.own();
  const faster = service.configure(f.a, { proactive: { perDay: 8 } });
  assert.deepEqual(faster.settings.proactive, { enabled: true, perDay: 8 });
  assert.equal(f.generation(), first + 1);
  assert.deepEqual(f.scheduler.pending(f.a), []); assert.ok(conversations.cancels.includes(wake.id), 'The conversation wake is cancelled too');
  assert.equal(f.scheduler.canDeliver(f.a, wake.id), false);
  const unchanged = f.generation(); service.configure(f.a, { proactive: { perDay: 8 } }); service.configure(f.a, { quietStart: '23:00' });
  assert.equal(f.generation(), unchanged, 'Saving the same values or other settings does not reshuffle');
  f.clock = f.nextAt(); const [second] = f.own();
  const off = service.configure(f.a, { proactive: { enabled: false } });
  assert.deepEqual(off.settings.proactive, { enabled: false, perDay: 8 }, 'A partial group keeps the stored frequency');
  assert.ok(conversations.cancels.includes(second.id)); assert.equal(f.nextAt(), null);
  f.clock += 10 * DAY; assert.deepEqual(f.own(), [], 'Off means no own wakes at all');
  const on = service.configure(f.a, { proactive: { enabled: true } });
  assert.deepEqual(on.settings.proactive, { enabled: true, perDay: 8 }); assert.ok(f.nextAt() > f.clock);
  // Older clients that never send the group keep the owner's choice.
  assert.deepEqual(service.configure(f.a, { heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00' }).settings.proactive, { enabled: true, perDay: 8 });
  for (const bad of [{ perDay: 3 }, { perDay: '4' }, { enabled: 'yes' }, { enabled: true, every: 2 }, null, []])
    denied(() => f.scheduler.configure(f.a, { proactive: bad }), 'INVALID_REQUEST');
  assert.deepEqual(f.scheduler.list(f.b).settings.proactive, { enabled: true, perDay: 4 }, 'Another owner keeps the default');
});

test('own wakes and follow-ups may start in quiet hours, but their delivery waits until quiet hours end', t => {
  const f = fixture(t); f.clock = Date.UTC(2026, 10, 2, 20); f.scheduler.prepareDue(f.a);
  f.followup('night-note', { at: iso(Date.UTC(2026, 10, 2, 23)) });
  f.scheduler.create(f.a, { requestId: 'night-reminder', text: 'A reminder', dueAt: iso(Date.UTC(2026, 10, 2, 23)) });
  f.clock = Date.UTC(2026, 10, 3, 2);
  const pending = f.scheduler.prepareDue(f.a), own = pending.find(item => item.kind === 'proactive');
  const followup = pending.find(item => item.kind === 'followup'), reminder = pending.find(item => item.kind === 'reminder');
  assert.match(own.prompt, /inside their quiet hours: prefer quiet work, and any message waits until their quiet hours end/);
  assert.match(followup.prompt, /Follow up night-note/); assert.match(followup.prompt, /scheduled for yourself on 2026-11-02/);
  assert.equal(f.admit(f.a, reminder.id), false, 'Ordinary reminders still wait for the morning to start');
  assert.equal(f.admit(f.a, own.id), true, 'A night wake can do quiet work');
  assert.equal(f.scheduler.canDeliver(f.a, own.id), false, 'Its message is held at night');
  f.clock += 5 * MINUTE; assert.equal(f.admit(f.a, followup.id), true);
  assert.equal(f.scheduler.canDeliver(f.a, followup.id), false);
  f.clock = Date.UTC(2026, 10, 3, 8);
  assert.equal(f.scheduler.canDeliver(f.a, own.id), true); assert.equal(f.scheduler.canDeliver(f.a, followup.id), true);
  // Turning own wakes off at night drops the held message instead of delivering it later.
  f.clock = Date.UTC(2026, 10, 3, 7); f.scheduler.configure(f.a, { proactive: { enabled: false } });
  f.clock = Date.UTC(2026, 10, 3, 8); assert.equal(f.scheduler.canDeliver(f.a, own.id), false);
});

test('own wakes share the five-minute spacing and the daily cap with other wakes', t => {
  const f = fixture(t, { maxTurnsPerDay: 2 });
  f.scheduler.create(f.a, { requestId: 'r1', text: 'One', dueAt: iso(f.clock + MINUTE) });
  f.scheduler.prepareDue(f.a); f.clock = f.nextAt();
  f.scheduler.create(f.a, { requestId: 'r2', text: 'Two', dueAt: iso(f.clock) });
  const pending = f.scheduler.prepareDue(f.a), reminder = pending.find(item => item.kind === 'reminder' && item.prompt === 'One');
  const own = pending.find(item => item.kind === 'proactive'), second = pending.find(item => item.prompt === 'Two');
  assert.equal(f.admit(f.a, reminder.id), true);
  assert.equal(f.admit(f.a, own.id), false, 'Spacing holds it');
  f.clock += 5 * MINUTE; assert.equal(f.admit(f.a, own.id), true);
  f.clock += 5 * MINUTE; assert.equal(f.admit(f.a, second.id), false, 'The own wake used the last turn of the day');
});

test('follow-ups are idempotent, conflict on a changed payload, are bounded, cancellable and owner-private', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  const input = { requestId: 'trip', at: '2026-11-14T18:00:00+01:00', note: '  Ask how the vacation went.  ' };
  const created = service.createFollowup(f.a, input);
  assert.deepEqual(created.createdFollowup, { id: created.createdFollowup.id, note: 'Ask how the vacation went.', dueAt: '2026-11-14T17:00:00.000Z',
    state: 'active', createdAt: iso(f.clock), canCancel: true });
  assert.deepEqual(created.followups, [created.createdFollowup]);
  assert.deepEqual(service.createFollowup(f.a, input).createdFollowup, created.createdFollowup, 'An exact retry returns the same follow-up');
  denied(() => service.createFollowup(f.a, { ...input, note: 'Something else' }), 'CONFLICT');
  denied(() => service.createFollowup(f.a, { ...input, at: '2026-11-15T18:00:00+01:00' }), 'CONFLICT');
  for (const bad of [{ ...input, requestId: 'past', at: iso(f.clock - MINUTE) }, { ...input, requestId: 'far', at: iso(f.clock + 61 * DAY) },
    { ...input, requestId: 'long', note: 'x'.repeat(501) }, { ...input, requestId: 'empty', note: '  ' }, { ...input, requestId: 'local', at: '2026-11-14T18:00:00' },
    { ...input, requestId: 'bad key!' }, { ...input, requestId: 'owner', owner: f.b }]) denied(() => service.createFollowup(f.a, bad), 'INVALID_REQUEST');
  assert.equal(service.createFollowup(f.a, { ...input, requestId: 'edge', at: iso(f.clock + 60 * DAY) }).createdFollowup.dueAt, iso(f.clock + 60 * DAY));
  assert.deepEqual(f.scheduler.list(f.b).followups, []);
  denied(() => service.cancelFollowup(f.b, { id: created.createdFollowup.id }), 'NOT_FOUND');
  for (let index = 0; index < 18; index++) f.followup(`cap-${index}`, { at: iso(f.clock + DAY + index * MINUTE) });
  denied(() => f.followup('one-too-many'), 'CAPACITY');
  assert.equal(f.followup('cap-0', { at: iso(f.clock + DAY) }).id, f.scheduler.list(f.a).followups.find(item => item.note === 'Follow up cap-0').id, 'Retries still work at the cap');
  const cancelled = service.cancelFollowup(f.a, { id: created.createdFollowup.id });
  assert.equal(cancelled.followups.some(item => item.id === created.createdFollowup.id), false);
  assert.ok(f.followup('after-cancel'), 'Cancelling frees a slot');
  service.cancelFollowup(f.a, { id: created.createdFollowup.id }); // Cancelling again is harmless.
  denied(() => service.cancelFollowup(f.a, { id: 'nope' }), 'INVALID_REQUEST');
  denied(() => service.cancelFollowup(f.a, { id: randomUUID() }), 'NOT_FOUND');
  assert.deepEqual(service.createFollowup(f.a, input).createdFollowup.state, 'cancelled', 'An old retry reports the current state without reviving it');
});

test('a due follow-up wakes once with its note; cancel stops a queued one; off holds them and a day late is missed', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  f.scheduler.prepareDue(f.a); service.configure(f.a, { proactive: { perDay: 2 } }); // own wakes far away
  const note = f.followup('soon', { at: iso(f.clock + HOUR), note: 'Ask whether the interview went well' });
  f.clock += HOUR; await service.tick();
  const [wake] = f.scheduler.pending(f.a);
  assert.equal(wake.kind, 'followup'); assert.match(wake.prompt, /"Ask whether the interview went well"/);
  assert.equal(conversations.proactiveResult(f.a, wake.id).state, 'running');
  conversations.finish(wake.id, 'message'); await service.tick();
  assert.deepEqual(f.scheduler.pending(f.a), []); assert.deepEqual(f.scheduler.list(f.a).followups, [], 'It ran once and is done');
  assert.equal(f.store.db.prepare('SELECT state FROM scheduler_followups WHERE id=?').get(note.id).state, 'done');
  f.clock += 2 * HOUR; await service.tick(); assert.deepEqual(f.scheduler.pending(f.a), []);

  const queued = f.followup('queued', { at: iso(f.clock + HOUR) });
  f.clock += HOUR; f.scheduler.prepareDue(f.a);
  const [pending] = f.scheduler.pending(f.a);
  service.cancelFollowup(f.a, { id: queued.id });
  assert.deepEqual(f.scheduler.pending(f.a), []); assert.ok(conversations.cancels.includes(pending.id));

  const held = f.followup('held', { at: iso(f.clock + HOUR) });
  service.configure(f.a, { proactive: { enabled: false } });
  f.clock += 2 * HOUR; await service.tick(); assert.deepEqual(f.scheduler.pending(f.a), [], 'Off holds follow-ups');
  assert.deepEqual(f.scheduler.list(f.a).followups.map(item => item.id), [held.id], 'and keeps them saved');
  service.configure(f.a, { proactive: { enabled: true } }); f.scheduler.prepareDue(f.a);
  assert.deepEqual(f.scheduler.pending(f.a).map(item => item.kind), ['followup'], 'It resumes when switched back on');
  service.configure(f.a, { proactive: { enabled: false } });
  const missed = f.followup('missed', { at: iso(f.clock + HOUR) });
  f.clock += 2 * DAY; service.configure(f.a, { proactive: { enabled: true } }); f.scheduler.prepareDue(f.a);
  assert.deepEqual(f.scheduler.pending(f.a), [], 'More than a day late is missed, not replayed');
  assert.equal(f.store.db.prepare('SELECT state FROM scheduler_followups WHERE id=?').get(missed.id).state, 'missed');
});

test('a follow-up stopped while running is complete, while one cancelled by the off switch stays saved', async t => {
  const f = fixture(t), conversations = fakeConversations(f), service = serviceFor(f, conversations);
  f.scheduler.prepareDue(f.a); service.configure(f.a, { proactive: { perDay: 2 } });
  const stopped = f.followup('stopped', { at: iso(f.clock + HOUR) });
  f.clock += HOUR; await service.tick();
  const [wake] = f.scheduler.pending(f.a); conversations.finish(wake.id, 'cancelled'); await service.tick();
  assert.equal(f.store.db.prepare('SELECT state FROM scheduler_followups WHERE id=?').get(stopped.id).state, 'done', 'The owner stopped it: it does not come back');
  const kept = f.followup('kept', { at: iso(f.clock + HOUR) });
  f.clock += HOUR; await service.tick(); assert.equal(f.scheduler.pending(f.a).length, 1);
  service.configure(f.a, { proactive: { enabled: false } }); service.configure(f.a, { proactive: { enabled: true } }); await service.tick();
  assert.equal(f.store.db.prepare('SELECT state FROM scheduler_followups WHERE id=?').get(kept.id).state, 'active');
  assert.deepEqual(f.scheduler.pending(f.a).map(item => item.kind), ['followup'], 'Back on, it runs again once');
});
