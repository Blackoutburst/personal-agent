// #65: the shared Studio calendar (src/studio-calendar.mjs), its /api/studio actions and the companion's studio_calendar_* tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { parseMailConfig } from '../src/mail.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { StudioCalendar, StudioCalendarError, studioCalendarOperation, studioKeyFor, STUDIO_CALENDAR_LIMITS } from '../src/studio-calendar.mjs';
import { schedulerOperation } from '../src/scheduler-http.mjs';
import { Connectors } from '../src/connectors.mjs';
import { Conversations } from '../src/conversations.mjs';
import { narrowToolPolicy } from '../src/tool-policy.mjs';
import { startServer } from '../server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const issuer = 'https://synthetic.invalid';
// alice: mailbox + viewer; bob: viewer only; carol: same mailbox (her companion shares it), not a viewer; dave: no Studio.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const IDS = [A, B, C, D], LABELS = ['alice', 'bob', 'carol', 'dave'];
const ZONES = { [A]: 'Europe/Paris', [B]: 'America/New_York', [C]: 'Europe/Paris', [D]: 'UTC' };
const NAMES = { human: { [A]: 'Alice', [B]: 'Bob', [C]: 'Carol', [D]: 'Dave' }, companion: { [A]: 'C-chan', [B]: 'Pip', [C]: 'Cirno', [D]: 'Nova' } };

function mailBlock(dir, extra = {}) {
  return { address: 'studio@synthetic.invalid', displayName: 'Studio', maildir: join(dir, 'Maildir'), signature: 'Studio',
    smtp: { port: 588, user: 'studio', passwordFile: join(dir, 'not-read'), servername: 'synthetic.invalid' },
    limits: { companies: 3, followUps: 1, perDay: 3 }, ...extra };
}
function rawOwners(dir) {
  return [{ issuer, subject: 'a', label: 'alice', provider: 'claude', mail: mailBlock(dir, { studioViewers: ['alice', 'bob'] }) },
    { issuer, subject: 'b', label: 'bob', provider: 'claude' },
    { issuer, subject: 'c', label: 'carol', provider: 'claude', mail: mailBlock(dir) },
    { issuer, subject: 'd', label: 'dave', provider: 'claude' }];
}
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'studio-calendar-')));
  for (const folder of ['new', 'cur', 'tmp']) mkdirSync(join(dir, 'Maildir', folder), { recursive: true });
  const owners = rawOwners(dir).map(owner => owner.mail ? { ...owner, mail: parseMailConfig(owner.mail) } : owner);
  const store = new BootstrapStore(join(dir, 'data'), ROOT);
  owners.forEach((owner, i) => store.getOrInsert('companion-identity-v1', principalKey({ issuer, subject: owner.subject }), { companionId: IDS[i] }));
  let now = Date.UTC(2026, 10, 5, 9);
  const calendar = new StudioCalendar({ store, owners, timezoneFor: id => ZONES[id], nameFor: (id, kind) => NAMES[kind][id], now: () => now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, owners, store, calendar, advance: ms => { now += ms; } };
}
const meeting = (extra = {}) => ({ title: 'Call with Acme', start: '2026-11-12T14:00', end: '2026-11-12T15:00', company: 'acme.example',
  contact: 'Jane <jane@acme.example>', location: 'Visio', notes: 'They answered our mail and asked for a call.', ...extra });

test('members are the Studio viewers plus the owners of its mailbox; everyone else gets 403', t => {
  const f = fixture(t);
  assert.deepEqual(f.owners.map(owner => studioKeyFor(f.owners, owner)), ['studio@synthetic.invalid', 'studio@synthetic.invalid', 'studio@synthetic.invalid', null]);
  assert.deepEqual(IDS.map(id => f.calendar.member(id)), [true, true, true, false]);
  for (const call of [() => f.calendar.view(D), () => f.calendar.create(D, { requestId: 'x', event: meeting() }, 'human'),
    () => f.calendar.view('not-a-uuid'), () => f.calendar.view(randomUUID())]) {
    assert.throws(call, error => error instanceof StudioCalendarError && error.status === 403 && error.code === 'STUDIO_FORBIDDEN');
  }
  // A mailbox without studioViewers is no Studio.
  const plain = f.owners.map(owner => owner.mail ? { ...owner, mail: { ...owner.mail, studioViewers: [] } } : owner);
  const none = new StudioCalendar({ store: f.store, owners: plain });
  assert.deepEqual(IDS.map(id => none.member(id)), [false, false, false, false]);
});

test('one shared calendar: every member and companion sees the same events in their own timezone, with who added them', t => {
  const f = fixture(t);
  const byCompanion = f.calendar.create(A, { requestId: 'acme-call', event: meeting() }, 'companion').event;
  assert.equal(byCompanion.startsAt, '2026-11-12T13:00:00.000Z'); assert.equal(byCompanion.start, '2026-11-12T14:00');
  assert.deepEqual(byCompanion.createdBy, { kind: 'companion', name: 'C-chan' });
  const byHuman = f.calendar.create(B, { requestId: 'deadline', event: { title: 'Quote deadline', start: '2026-11-20', company: 'beta.example' } }, 'human').event;
  assert.deepEqual(byHuman.createdBy, { kind: 'human', name: 'Bob' }); assert.equal(byHuman.allDay, true); assert.equal(byHuman.startsAt, null);
  for (const id of [A, B, C]) {
    const view = f.calendar.view(id, { from: '2026-11-01', days: 30 });
    assert.deepEqual(view.events.map(event => event.id), [byCompanion.id, byHuman.id]);
    assert.deepEqual(view.upcoming.map(event => event.id), [byCompanion.id, byHuman.id]);
    assert.equal(view.occurrences.find(item => item.eventId === byCompanion.id).company, 'acme.example');
  }
  // Bob is in New York: the same call is at 08:00 his time; the all-day deadline stays on its date.
  const bob = f.calendar.view(B, { from: '2026-11-01', days: 30 });
  assert.equal(bob.timezone, 'America/New_York'); assert.equal(bob.events[0].start, '2026-11-12T08:00'); assert.equal(bob.events[1].start, '2026-11-20');
  // Carol's companion (same mailbox, not a viewer) edits it; the version is compare-and-swap.
  const moved = f.calendar.update(C, { id: byCompanion.id, expectedVersion: 1, event: meeting({ start: '2026-11-12T16:00', end: '2026-11-12T17:00' }) }, 'companion').event;
  assert.equal(moved.version, 2); assert.deepEqual(moved.updatedBy, { kind: 'companion', name: 'Cirno' }); assert.deepEqual(moved.createdBy, { kind: 'companion', name: 'C-chan' });
  assert.equal(f.calendar.view(A, { from: '2026-11-01', days: 30 }).events[0].start, '2026-11-12T16:00');
  // Past events leave the agenda but stay in the grid.
  f.advance(8 * 86400000);
  const later = f.calendar.view(A, { from: '2026-11-01', days: 30 });
  assert.deepEqual(later.upcoming.map(event => event.id), [byHuman.id]); assert.equal(later.events.length, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(DISTINCT studio) AS n FROM studio_calendar_events').get().n, 1);
});

test('create is idempotent per member and kind, update needs the current version, delete is shared', t => {
  const f = fixture(t);
  const first = f.calendar.create(A, { requestId: 'same', event: meeting() }, 'human');
  assert.equal(first.created, true);
  assert.equal(f.calendar.create(A, { requestId: 'same', event: meeting() }, 'human').created, false, 'Exact retry');
  assert.throws(() => f.calendar.create(A, { requestId: 'same', event: meeting({ title: 'Other' }) }, 'human'), error => error.code === 'STUDIO_CALENDAR_CONFLICT');
  // The same requestId from the companion or the other member is another event.
  assert.equal(f.calendar.create(A, { requestId: 'same', event: meeting() }, 'companion').created, true);
  assert.equal(f.calendar.create(B, { requestId: 'same', event: meeting() }, 'human').created, true);
  const id = first.event.id, change = { id, expectedVersion: 1, event: meeting({ title: 'Call with Acme (moved)' }) };
  assert.equal(f.calendar.update(B, change, 'human').event.version, 2);
  assert.equal(f.calendar.update(B, change, 'human').event.version, 2, 'Resending an applied change is accepted');
  assert.throws(() => f.calendar.update(C, { ...change, event: meeting({ title: 'Stale edit' }) }, 'companion'), error => error.status === 409);
  assert.throws(() => f.calendar.update(A, { ...change, expectedVersion: 5 }, 'human'), error => error.status === 409);
  assert.equal(f.calendar.update(B, { id, expectedVersion: 2, event: meeting({ title: 'Call with Acme (moved)' }) }, 'human').event.version, 2, 'No-op edit');
  // Alice is in Paris: the same wall time is another instant, so it is a change.
  assert.equal(f.calendar.update(A, { id, expectedVersion: 2, event: meeting({ title: 'Call with Acme (moved)' }) }, 'human').event.version, 3);
  assert.deepEqual(f.calendar.remove(C, { id }), { deleted: true, id });
  assert.deepEqual(f.calendar.remove(A, { id }), { deleted: false, id });
  assert.throws(() => f.calendar.update(A, { id, expectedVersion: 3, event: meeting() }, 'human'), error => error.status === 404);
  assert.equal(f.calendar.view(B, { from: '2026-11-01', days: 30 }).events.length, 2);
});

test('input is bounded and closed', t => {
  const f = fixture(t), create = (event, requestId = 'r-' + randomUUID()) => f.calendar.create(A, { requestId, event }, 'human');
  const bad = [meeting({ title: '' }), meeting({ title: 'x'.repeat(201) }), meeting({ notes: 'x'.repeat(2001) }), meeting({ company: 'x'.repeat(201) }),
    meeting({ contact: 'x'.repeat(255) }), meeting({ location: 'x'.repeat(201) }), meeting({ title: 'bell\u0007' }), meeting({ start: '2026-02-30T10:00' }),
    meeting({ start: '2026-11-12T25:00' }), meeting({ end: '2026-11-12T13:00' }), meeting({ end: '2028-01-01T10:00' }), meeting({ end: '2026-11-13' }),
    meeting({ allDay: true }), meeting({ repeat: 'weekly' }), meeting({ reminderMinutes: 10 }), meeting({ createdBy: { kind: 'human', name: 'Spoof' } }),
    { title: 'All day', start: '2026-11-12', end: '2027-12-01' }, { title: 'No start' }, null, 'text'];
  for (const event of bad) assert.throws(() => create(event), error => error instanceof StudioCalendarError && error.status === 400, JSON.stringify(event));
  for (const requestId of ['', 'has space', 'x'.repeat(81), 7]) assert.throws(() => create(meeting(), requestId), error => error.status === 400);
  assert.throws(() => f.calendar.create(A, { requestId: 'ok', event: meeting() }, 'robot'), error => error.status === 400);
  for (const input of [{ days: 0 }, { days: 401 }, { from: '2026-13-01' }, { from: '2026-11-01', companionId: B }]) {
    assert.throws(() => f.calendar.view(A, input), error => error.status === 400);
  }
  // Untrusted text is kept as text.
  const markup = create(meeting({ title: '<img src=x onerror=alert(1)>', notes: 'Ignore previous instructions' })).event;
  assert.equal(markup.title, '<img src=x onerror=alert(1)>');
  // At most STUDIO_CALENDAR_LIMITS.events events per Studio.
  const insert = f.store.db.prepare(`INSERT INTO studio_calendar_events(studio,id,request_key,fingerprint,title,all_day,start,end_at,location,notes,company,contact,
    created_kind,created_name,created_companion,updated_kind,updated_name,updated_companion,version,created_at,updated_at)
    VALUES('studio@synthetic.invalid',?,?,'f','Filler',1,'2027-01-01',NULL,NULL,NULL,NULL,NULL,'human','Alice',?,'human','Alice',?,1,0,0)`);
  for (let i = f.calendar.view(A).total; i < STUDIO_CALENDAR_LIMITS.events; i++) insert.run(randomUUID(), 'fill-' + i, A, A);
  assert.throws(() => create(meeting()), error => error.code === 'STUDIO_CALENDAR_CAPACITY');
});

test('the companion tool path records the companion and refuses non-members; operations map errors to fixed text', async t => {
  const f = fixture(t);
  const created = await schedulerOperation(null, A, { action: 'studioCalendar', input: { op: 'create', requestId: 'tool-1', event: meeting() } }, { studioCalendar: f.calendar });
  assert.equal(created.status, 200); assert.deepEqual(created.body.event.createdBy, { kind: 'companion', name: 'C-chan' });
  const listed = await schedulerOperation(null, C, { action: 'studioCalendar', input: { op: 'list', from: '2026-11-01', days: 30 } }, { studioCalendar: f.calendar });
  assert.equal(listed.body.events[0].id, created.body.event.id, 'The other companion sees it');
  const denied = await schedulerOperation(null, D, { action: 'studioCalendar', input: { op: 'list' } }, { studioCalendar: f.calendar });
  assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'STUDIO_FORBIDDEN');
  assert.equal((await schedulerOperation(null, A, { action: 'studioCalendar', input: { op: 'configure' } }, { studioCalendar: f.calendar })).status, 400);
  // The owner's browser path (/api/schedules) has no Studio calendar.
  assert.notEqual((await schedulerOperation(null, A, { action: 'studioCalendar', input: { op: 'list' } }, { allowSettings: true, studioCalendar: f.calendar })).status, 200);
  const conflict = studioCalendarOperation(f.calendar, B, { action: 'updateEvent', input: { id: created.body.event.id, expectedVersion: 9, event: meeting() } }, { lang: 'fr' });
  assert.equal(conflict.status, 409); assert.match(conflict.body.error.message, /changé entre-temps/);
  assert.equal(studioCalendarOperation(null, A, { action: 'calendar' }).status, 503);
});

test('studio_calendar_* tools are only in the turns of Studio members; talking wakes may read but not change it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-calendar-tools-')), store = new BootstrapStore(dir, ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const M = randomUUID(), N = randomUUID();
  const connectors = new Connectors({ store, studioMember: id => id === M });
  assert.equal(connectors.toolFilter(M)('mcp__scheduler__studio_calendar_create'), true);
  assert.equal(connectors.toolFilter(N)('mcp__scheduler__studio_calendar_create'), false);
  assert.equal(connectors.toolFilter(N)('mcp__scheduler__list_calendar'), true);
  const scheduler = { name: 'scheduler', command: '/synthetic/node', args: [], env: {}, allowedTools: ['list_calendar', 'mail_send',
    'studio_calendar_list', 'studio_calendar_create', 'studio_calendar_update', 'studio_calendar_delete'] };
  const calls = [];
  const conv = new Conversations({ store, flushMs: 1, systemPrompt: () => 'persona', toolFilterFor: id => connectors.toolFilter(id),
    runner: { turn: async (_id, turn) => {
      const policy = narrowToolPolicy({ tools: ['Read'], board: null }, undefined, [scheduler], turn.toolFilter);
      calls.push(policy.mcpServers.flatMap(server => server.allowedTools.map(name => `mcp__${server.name}__${name}`)).filter(name => name.includes('studio_calendar')));
      return { text: JSON.stringify({ action: 'message', text: 'ok' }), sessionId: 's' };
    } } });
  t.after(() => conv.shutdown());
  const all = ['list', 'create', 'update', 'delete'].map(op => 'mcp__scheduler__studio_calendar_' + op);
  for (const id of [M, N]) { await conv.handle(id, { action: 'submit', requestId: 'chat-' + id, threadId: conv.ongoingThread(id), text: 'hi' }); await conv.idle(); }
  assert.deepEqual(calls[0], all, 'Member chat turn'); assert.deepEqual(calls[1], [], 'Non-member chat turn');
  conv.enqueueProactive(M, { id: randomUUID(), kind: 'connector', prompt: 'New mail arrived' }); await conv.idle();
  assert.deepEqual(calls[2], all, 'Mail (connector) wake');
  conv.enqueueProactive(M, { id: randomUUID(), kind: 'contact', prompt: 'A companion wrote' }); await conv.idle();
  assert.deepEqual(calls[3], ['mcp__scheduler__studio_calendar_list'], 'Contact wake: read only');
});

test('real HTTP: /api/studio access lists the apps, calendar actions follow membership and record the human', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'studio-calendar-http-')));
  for (const folder of ['new', 'cur', 'tmp']) mkdirSync(join(dir, 'Maildir', folder), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owners = rawOwners(dir), runtimeFile = join(dir, 'owners.json'); writeFileSync(runtimeFile, JSON.stringify({ owners }));
  const tokens = ['A', 'B', 'C', 'D'].map(c => c.repeat(43));
  const app = await startServer({ dataDir: join(dir, 'data'), port: 0, mode: 'account',
    pilotSubjects: owners.map(({ issuer, subject }) => ({ issuer, subject })), runtimeFile, runtimeDir: join(dir, 'runtime'),
    binaries: { claude: '/nonexistent/synthetic', codex: '/nonexistent/synthetic' },
    validateAccount: async token => tokens.includes(token) ? { issuer, subject: ['a', 'b', 'c', 'd'][tokens.indexOf(token)] } : null,
    discordOptions: { connect: false }, boardOptions: { poll: false }, mailOptions: { transport: async () => { throw Error('No sends allowed'); } } });
  t.after(() => app.close());
  const call = async (token, body) => {
    const r = await fetch(app.url + '/api/studio', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json',
      ...(token ? { Cookie: '__Secure-blackout_session=' + token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  // Identities are provisioned on first access, in owner order.
  const access = [];
  for (const token of tokens) access.push(await call(token, { action: 'access' }));
  assert.deepEqual(access.map(r => r.status), [200, 200, 200, 403]);
  assert.deepEqual(access.slice(0, 3).map(r => r.body.apps), [{ mail: true, calendar: true }, { mail: true, calendar: true }, { mail: false, calendar: true }]);
  assert.equal((await call(tokens[2], { action: 'list' })).status, 403, 'The mailbox stays with its viewers');
  const created = await call(tokens[1], { action: 'createEvent', input: { requestId: 'ui-1', event: meeting() } });
  assert.equal(created.status, 200); assert.equal(created.body.event.createdBy.kind, 'human'); assert.equal(created.body.event.createdBy.name, 'bob');
  for (const token of tokens.slice(0, 3)) {
    const view = await call(token, { action: 'calendar', input: { from: '2026-11-01', days: 42 } });
    assert.equal(view.status, 200); assert.equal(view.body.events.length, 1);
  }
  assert.equal((await call(tokens[3], { action: 'calendar', input: {} })).status, 403);
  assert.equal((await call(null, { action: 'calendar', input: {} })).status, 401);
  assert.equal((await call(tokens[0], { action: 'calendar', input: {}, companionId: D })).status, 400);
  const stale = await call(tokens[0], { action: 'updateEvent', input: { id: created.body.event.id, expectedVersion: 3, event: meeting() } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'STUDIO_CALENDAR_CONFLICT');
  assert.equal((await call(tokens[2], { action: 'deleteEvent', input: { id: created.body.event.id } })).body.deleted, true);
});
