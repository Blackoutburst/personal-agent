// #105: C-chan's wakes, heartbeats and watches stopped on 14 Nov 2026. One board event wake longer than
// Conversations accepts (4000 characters, while the scheduler took 8000 since 5322a44) threw on every tick and the
// per-owner catch abandoned everything queued after it. Synthetic owners, real Conversations, fake provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { Conversations, LIMITS } from '../src/conversations.mjs';
import { SchedulerStore, SchedulerService, EVENT_TEXT } from '../src/scheduler.mjs';
import { eventsPrompt } from '../src/agent-runner-client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const iso = value => new Date(value).toISOString();
const silent = { text: JSON.stringify({ action: 'silent' }), sessionId: 'native' };

function fixture(t, { conversations: wrap = conv => conv, schedulerOptions = {}, ready = () => true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-outage-')), store = new BootstrapStore(dir, ROOT);
  const f = { clock: Date.UTC(2026, 10, 14, 19), turns: [], logs: [], settled: [] };
  f.now = () => f.clock;
  f.A = store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'outage-A' }), { companionId: randomUUID() }).companionId;
  f.store = store; f.db = store.db;
  f.scheduler = new SchedulerStore({ store, now: f.now, random: () => 0.5, timezoneFor: () => 'UTC', minSpacingMs: 0, boardSpacingMs: 0,
    log: message => f.logs.push(message), ...schedulerOptions });
  f.conv = new Conversations({ store, now: f.now, flushMs: 1, systemPrompt: () => 'persona',
    runner: { turn: async (companionId, turn) => { f.turns.push(turn.prompt); return silent; },
      releaseCheck: async (companionId, turn) => { f.turns.push(turn.prompt); return { text: JSON.stringify({ action: 'not_yet' }) }; } },
    wakePolicy: { beforeStart: (companionId, id) => f.scheduler.startInTransaction(companionId, id), canDeliver: (companionId, id) => f.scheduler.canDeliver(companionId, id),
      recordReleaseCheck: (companionId, id, check, text) => f.scheduler.recordReleaseCheck(companionId, id, check, text),
      releaseDelivered: (companionId, id) => f.scheduler.releaseDelivered(companionId, id) },
    onSettled: event => f.settled.push(event) });
  f.service = new SchedulerService({ scheduler: f.scheduler, conversations: wrap(f.conv), companions: () => [f.A], ready: () => ready(),
    pollMs: 60000, now: f.now, log: message => f.logs.push(message), notice: (companionId, text) => f.conv.notice(companionId, text) });
  f.drain = async (rounds = 4) => { for (let i = 0; i < rounds; i++) { await f.service.tick(); await f.conv.idle(); f.clock += 1000; } };
  f.messages = async () => (await f.conv.handle(f.A, { action: 'snapshot' })).messages;
  t.after(async () => { await f.service.stop(); await f.conv.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
test('every wake the scheduler stores fits what Conversations admits', () => {
  assert.ok(LIMITS.wakeChars >= EVENT_TEXT, 'a stored but refused wake was queued forever and blocked the owner (#105)');
  assert.ok(LIMITS.wakeBytes >= EVENT_TEXT * 4);
});

const longEvents = () => eventsPrompt(Array.from({ length: 30 }, (_, i) => ({ type: 'manager.attention', ticketNumber: i + 1, suggestion: 'x'.repeat(600) })));

test('a runner event wake past 4000 characters runs instead of blocking every later wake (#105 root cause)', async t => {
  const f = fixture(t);
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00', heartbeatEnabled: true, proactive: { enabled: true, perDay: 16 } });
  const prompt = longEvents();
  assert.ok(prompt.length > 4000, `the 14 Nov runner prompt shape is longer than the old 4000-character wake limit (${prompt.length})`);
  f.scheduler.enqueueEvent(f.A, { requestId: 'runner-258', kind: 'board', prompt });
  f.scheduler.create(f.A, { requestId: 'after', text: 'Reminder after the long event', dueAt: iso(f.clock + MINUTE) });
  f.clock += 2 * MINUTE;
  await f.drain();
  assert.ok(f.turns.some(text => text.includes('Reminder after the long event')), 'the reminder queued after it ran');
  assert.ok(f.turns.some(text => text.includes('Agent runner events')), 'the long event wake itself ran');
  const stuck = f.db.prepare("SELECT COUNT(*) AS n FROM scheduler_occurrences WHERE companion_id=? AND state IN ('queued','admitted')").get(f.A).n;
  assert.equal(stuck, 0, 'nothing stays queued behind it');
});

test('one wake that keeps failing is logged, retired after three tries, and never stops the wakes behind it', async t => {
  const f = fixture(t, { conversations: conv => ({
    enqueueProactive: (companionId, wake) => {
      if (wake.prompt.includes('POISON')) throw Object.assign(new Error('CONVERSATION_INVALID_REQUEST'), { code: 'INVALID_REQUEST' });
      return conv.enqueueProactive(companionId, wake);
    },
    proactiveResult: (...args) => conv.proactiveResult(...args), cancelProactive: (...args) => conv.cancelProactive(...args),
    reconcileReleaseFailure: (...args) => conv.reconcileReleaseFailure(...args) }) });
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00' });
  f.scheduler.enqueueEvent(f.A, { requestId: 'poison', kind: 'board', prompt: 'POISON event' });
  f.clock += 1000;
  f.scheduler.enqueueEvent(f.A, { requestId: 'fine', kind: 'board', prompt: 'A fine event' });
  await f.drain(1);
  assert.ok(f.turns.some(text => text.includes('A fine event')), 'the wake after the failing one ran on the first tick');
  assert.equal(f.logs.filter(line => /wake .* failed/.test(line)).length, 1, 'the failure is logged once, not every poll');
  assert.doesNotMatch(f.logs.join('\n'), /POISON/, 'logs carry no private wake text');
  await f.drain(3);
  const poison = f.db.prepare("SELECT state FROM scheduler_occurrences WHERE slot_key='event:poison'").get();
  assert.equal(poison.state, 'error', 'after three failed tries the wake is retired instead of retried forever');
  assert.ok(f.logs.some(line => /gave up/.test(line)));
});

test('after nine days down, a restart catches up once: one own wake, one heartbeat, one watch check, stale events missed', async t => {
  const f = fixture(t);
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00', heartbeatEnabled: true, proactive: { enabled: true, perDay: 16 } });
  f.scheduler.createWatch(f.A, { requestId: 'qwen', condition: 'Qwen4 is officially released' });
  await f.drain(2);
  f.turns.length = 0;
  for (let i = 0; i < 20; i++) f.scheduler.enqueueEvent(f.A, { requestId: 'old-' + i, kind: 'board', prompt: 'Old runner event ' + i });
  f.clock += 9 * DAY;
  f.scheduler.enqueueEvent(f.A, { requestId: 'fresh', kind: 'board', prompt: 'Fresh runner event' });
  await f.drain(6);
  const count = pattern => f.turns.filter(text => pattern.test(text)).length;
  assert.equal(count(/Old runner event/), 0, 'events queued more than a day ago are marked missed, not replayed');
  assert.equal(count(/Fresh runner event/), 1);
  assert.equal(count(/Quietly review what needs attention/), 1, 'one heartbeat, not 36');
  assert.equal(count(/Qwen4/), 1, 'one release check, not 36');
  assert.ok(count(/nobody asked/i) <= 1, 'at most one own wake');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM scheduler_occurrences WHERE slot_key LIKE 'event:old-%' AND state='missed'").get().n, 20);
});

test('liveness: when no scheduled wake has run for far longer than expected, the owner gets one plain message', async t => {
  const f = fixture(t, { conversations: conv => ({
    // Every wake fails to start: the outage this ticket describes, whatever its cause.
    enqueueProactive: () => { throw Object.assign(new Error('boom'), { code: 'UNAVAILABLE' }); },
    proactiveResult: (...args) => conv.proactiveResult(...args), cancelProactive: (...args) => conv.cancelProactive(...args) }) });
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00', heartbeatEnabled: true, proactive: { enabled: true, perDay: 16 } });
  await f.drain(1);
  assert.equal((await f.messages()).length, 0, 'no notice right after start');
  f.clock += 6 * HOUR; await f.drain(1);
  assert.equal((await f.messages()).length, 0, 'six hours is within what 16 wakes a day and heartbeats allow');
  f.clock += 20 * HOUR; await f.drain(2);
  let messages = await f.messages();
  assert.equal(messages.length, 1, 'one notice after a day without any scheduled wake');
  assert.equal(messages[0].role, 'assistant');
  assert.match(messages[0].text, /background wakes/i);
  assert.match(messages[0].text, /journalctl/);
  assert.ok(f.settled.some(event => event.messageId === messages[0].id), 'the notice goes out through push/Discord like other messages');
  f.clock += 3 * DAY; await f.drain(3);
  assert.equal((await f.messages()).length, 1, 'still one: no flood while the outage lasts');
  assert.ok(f.logs.some(line => /liveness/.test(line)), 'the server log says it too');
});

test('liveness: no notice when wakes run normally or when everything is switched off', async t => {
  const f = fixture(t);
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00', heartbeatEnabled: true, proactive: { enabled: true, perDay: 16 } });
  for (let hour = 0; hour < 72; hour++) { f.clock += HOUR; await f.drain(1); }
  assert.ok(f.turns.length > 10, 'wakes ran');
  assert.equal((await f.messages()).length, 0, 'healthy: silent wakes publish nothing and no liveness notice is sent');
  f.scheduler.configure(f.A, { heartbeatEnabled: false, proactive: { enabled: false, perDay: 16 } });
  f.clock += 10 * DAY; await f.drain(2);
  assert.equal((await f.messages()).length, 0, 'nothing is expected to run, so nothing is overdue');
});

test('the liveness check survives a broken wake path for one owner (a throwing prepareDue)', async t => {
  const f = fixture(t);
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00', heartbeatEnabled: true, proactive: { enabled: true, perDay: 16 } });
  await f.drain(1);
  const real = f.scheduler.prepareDue.bind(f.scheduler);
  f.scheduler.prepareDue = () => { throw new Error('migration problem'); };
  f.clock += 2 * DAY; await f.drain(2);
  assert.equal((await f.messages()).length, 1, 'the notice still goes out');
  assert.ok(f.logs.some(line => /tick failed/.test(line)), 'the per-owner failure is logged, not swallowed');
  f.scheduler.prepareDue = real;
});

const failingWakes = conv => ({
  enqueueProactive: () => { throw Object.assign(new Error('boom'), { code: 'UNAVAILABLE' }); },
  proactiveResult: (...args) => conv.proactiveResult(...args), cancelProactive: (...args) => conv.cancelProactive(...args) });

test('liveness: an overdue notice inside quiet hours waits until they end (no message or push at 23:00)', async t => {
  const f = fixture(t, { conversations: failingWakes });
  f.scheduler.configure(f.A, { quietStart: '22:00', quietEnd: '08:00', heartbeatEnabled: true, proactive: { enabled: true, perDay: 16 } });
  await f.drain(1); // 14 Nov 19:00 UTC
  f.clock = Date.UTC(2026, 10, 15, 23); await f.drain(3);
  assert.equal((await f.messages()).length, 0, 'overdue at 23:00, inside 22:00-08:00: no message yet');
  assert.equal(f.settled.length, 0, 'and nothing pushed');
  assert.ok(f.logs.some(line => /liveness: .*waits for quiet hours/.test(line)), 'the log says it is held');
  f.clock = Date.UTC(2026, 10, 16, 7, 59); await f.drain(2);
  assert.equal((await f.messages()).length, 0, 'still quiet at 07:59');
  f.clock = Date.UTC(2026, 10, 16, 8, 0); await f.drain(2);
  const messages = await f.messages();
  assert.equal(messages.length, 1, 'one notice on the first tick after quiet hours end');
  assert.equal(f.settled.length, 1);
  f.clock += 2 * DAY; await f.drain(2);
  assert.equal((await f.messages()).length, 1, 'not repeated');
});

test('an event wake held more than a day while the scheduler keeps ticking (runner down) still runs, it is not missed', async t => {
  let up = false;
  const f = fixture(t, { ready: () => up });
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00' });
  f.scheduler.enqueueEvent(f.A, { requestId: 'held-runner', kind: 'board', prompt: 'Held while the runner was down' });
  for (let hour = 0; hour < 30; hour++) { await f.drain(1); f.clock += HOUR; }
  assert.equal(f.db.prepare("SELECT state FROM scheduler_occurrences WHERE slot_key='event:held-runner'").get().state, 'queued');
  up = true; await f.drain(2);
  assert.ok(f.turns.some(text => text.includes('Held while the runner was down')), 'it ran once the runner was back');
  assert.doesNotMatch(f.logs.join('\n'), /catch-up after an outage/);
});

test('an event wake held more than a day by a provider cooldown still runs when the cooldown ends', async t => {
  const f = fixture(t);
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00' });
  await f.drain(1);
  f.db.prepare('UPDATE scheduler_settings SET cooldown_until=? WHERE companion_id=?').run(f.clock + 30 * HOUR, f.A);
  f.scheduler.enqueueEvent(f.A, { requestId: 'held-cooldown', kind: 'board', prompt: 'Held by the cooldown' });
  for (let hour = 0; hour < 31; hour++) { await f.drain(1); f.clock += HOUR; }
  await f.drain(2);
  assert.ok(f.turns.some(text => text.includes('Held by the cooldown')), 'it ran after the cooldown, not marked missed');
});

test('catch-up on the first start after the 14 Nov release: no tick recorded yet, last wake started days ago', async t => {
  const f = fixture(t);
  f.scheduler.configure(f.A, { quietStart: '08:00', quietEnd: '08:00' });
  f.scheduler.enqueueEvent(f.A, { requestId: 'before', kind: 'board', prompt: 'Ran before the outage' });
  await f.drain(1);
  f.db.exec('DELETE FROM scheduler_ticks'); // older releases never wrote ticks
  f.scheduler.enqueueEvent(f.A, { requestId: 'stuck', kind: 'board', prompt: 'Queued during the outage' });
  f.clock += 9 * DAY;
  const fresh = new SchedulerStore({ store: f.store, now: f.now, random: () => 0.5, timezoneFor: () => 'UTC', minSpacingMs: 0, boardSpacingMs: 0, log: line => f.logs.push(line) });
  fresh.prepareDue(f.A);
  assert.equal(f.db.prepare("SELECT state FROM scheduler_occurrences WHERE slot_key='event:stuck'").get().state, 'missed');
  assert.ok(f.logs.some(line => /catch-up after an outage: 1 event/.test(line)));
});
