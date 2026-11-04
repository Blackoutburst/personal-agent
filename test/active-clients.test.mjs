import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { ActiveClients, PushHold, ACTIVE_TTL_MS } from '../src/active-clients.mjs';
import { PushDevices, PushNotifier } from '../src/push.mjs';
import { WebPushSubscriptions, WebPushNotifier } from '../src/web-push.mjs';
import { createActiveClient, INPUT_MS, BEAT_MS } from '../public/active-client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const A = randomUUID(), B = randomUUID(), THREAD = randomUUID(), OTHER = randomUUID();
const HOLD = 40;
const PC = 'pc-tab-0001', PHONE = 'android-0001';

function browser() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: 'https://web.push.apple.com/' + randomUUID(), p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

// The real Android and Web Push notifiers with fake senders, and a Discord bridge stand-in, behind the hold.
function fixture(t, { dir = mkdtempSync(join(tmpdir(), 'active-clients-')), keep = false } = {}) {
  const store = new BootstrapStore(dir, ROOT);
  const f = { clock: 1_000_000, dir, store, fcm: [], web: [], discord: [], groupsDelivered: [], read: new Set(), logs: [] };
  const now = () => f.clock;
  f.clients = new ActiveClients({ now });
  const devices = new PushDevices({ store, now });
  devices.register(A, 'fcm_phone:' + 'x'.repeat(40));
  const subscriptions = new WebPushSubscriptions({ store, now });
  subscriptions.subscribe(A, browser());
  const push = new PushNotifier({ devices, sender: { send: async (token, data) => { f.fcm.push(data.messageId); return 'sent'; } } });
  const web = new WebPushNotifier({ subscriptions, sender: { send: async (subscription, payload) => { f.web.push(payload.messageId); return 'sent'; } } });
  f.hold = new PushHold({ store, clients: f.clients, holdMs: HOLD, now, log: message => f.logs.push(message),
    deliver: event => { f.discord.push(event.messageId ?? event.requestId); push.settled(event); web.settled(event); },
    deliverGroup: event => { f.groupsDelivered.push(event.messageId); push.group(event); web.group(event); },
    groupRead: (companionId, groupId, messageId) => f.read.has(messageId) });
  f.reply = (extra = {}) => {
    const messageId = randomUUID();
    f.hold.settled({ companionId: A, threadId: THREAD, requestId: 'r-' + messageId, state: 'complete', text: 'Hi there', messageId, ...extra });
    return messageId;
  };
  f.settle = () => sleep(5);
  f.wait = () => sleep(HOLD + 30);
  f.close = () => { f.hold.stop(); store.close(); };
  t.after(() => { f.hold.stop(); try { store.close(); } catch { /* closed already */ } if (!keep) rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const everywhere = (f, id) => f.fcm.includes(id) && f.web.includes(id) && f.discord.includes(id);
const nowhere = (f, id) => !f.fcm.includes(id) && !f.web.includes(id) && !f.discord.includes(id);

test('presence: reports are validated, expire on their own and belong to their owner', () => {
  let clock = 0;
  const clients = new ActiveClients({ now: () => clock });
  for (const bad of [{ client: 'short', active: true }, { client: PC, active: 'yes' }, { client: PC, active: true, threadId: 'not-a-uuid' },
    { client: 'bad id with spaces', active: true }]) assert.throws(() => clients.report(A, bad), { code: 'INVALID_REQUEST' });
  assert.deepEqual(clients.report(A, { client: PC, active: true, threadId: THREAD }), { active: true });
  assert.equal(clients.isActive(A), true);
  assert.equal(clients.isActive(B), false, 'Another owner is not affected');
  clock += ACTIVE_TTL_MS - 1;
  assert.equal(clients.isActive(A), true);
  clock += 1;
  assert.equal(clients.isActive(A), false, 'A tab that stops reporting (closed laptop) stops counting');
  assert.equal(clients.viewedSince(A, THREAD, 0), true);
  assert.equal(clients.viewedSince(A, THREAD, 1), false);
  // A never-active client reporting inactive does not count its thread as seen; a client that was active does.
  clients.report(A, { client: PHONE, active: false, threadId: OTHER });
  assert.equal(clients.viewedSince(A, OTHER, 0), false);
  clients.report(A, { client: PHONE, active: true });
  clock += 10;
  clients.report(A, { client: PHONE, active: false, threadId: OTHER });
  assert.equal(clients.viewedSince(A, OTHER, clock), true);
  assert.equal(clients.isActive(A), false);
});

test('no active client: every device and the Discord mirror get the message at once, as before', async t => {
  const f = fixture(t);
  const id = f.reply({ proactive: true });
  await f.settle();
  assert.ok(everywhere(f, id));
  assert.equal(f.hold.held, 0);
});

test('an active client holds FCM, Web Push and the Discord mirror; read there within the delay drops them', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true, threadId: OTHER });
  const id = f.reply({ proactive: true });
  await f.settle();
  assert.ok(nowhere(f, id), 'Nothing is pushed or mirrored while the owner is at the PC');
  assert.equal(f.hold.held, 1);
  f.clock += 5_000;
  f.clients.report(A, { client: PC, active: true, threadId: THREAD });
  await f.wait();
  assert.ok(nowhere(f, id), 'Shown on the active client: the push is dropped');
  assert.equal(f.hold.held, 0);
  assert.ok(f.logs.some(line => /dropped/.test(line)));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM push_holds').get().n, 0);
});

test('an active client elsewhere in the app: still unread after the delay, so it is pushed as usual', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true, threadId: OTHER });
  const before = f.reply();
  f.clock += 1;
  f.clients.report(A, { client: PC, active: true });
  const id = f.reply({ proactive: true });
  await f.settle();
  assert.ok(nowhere(f, id));
  await f.wait();
  assert.ok(everywhere(f, id), 'Unread: Android, Web Push and the Discord mirror all go out');
  assert.ok(f.fcm.includes(before) && f.web.includes(before));
});

test('a view from before the message does not count as reading it', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true, threadId: THREAD });
  f.clock += 1;
  const id = f.reply();
  await f.wait();
  assert.ok(f.fcm.includes(id) && f.web.includes(id));
});

test('an idle or expired client does not hold anything', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true });
  f.clients.report(A, { client: PC, active: false });
  const idle = f.reply();
  f.clients.report(A, { client: PHONE, active: true });
  f.clock += ACTIVE_TTL_MS;
  const expired = f.reply();
  await f.settle();
  assert.ok(f.fcm.includes(idle) && f.web.includes(idle), 'Tab open but idle: pushed at once');
  assert.ok(f.fcm.includes(expired) && f.web.includes(expired), 'Presence expired: pushed at once');
});

test('the last active client going inactive decides held messages at once', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true, threadId: OTHER });
  const unread = f.reply();
  await f.settle();
  assert.ok(nowhere(f, unread));
  f.clients.report(A, { client: PC, active: false });
  await f.settle();
  assert.ok(f.fcm.includes(unread) && f.web.includes(unread), 'Left the PC without reading it: pushed now, not after the delay');
  f.clients.report(A, { client: PC, active: true, threadId: THREAD });
  const seen = f.reply();
  f.clock += 1;
  f.clients.report(A, { client: PC, active: false, threadId: THREAD });
  await f.wait();
  assert.ok(nowhere(f, seen), 'It was on screen until the tab went inactive: dropped');
});

test('Discord-originated replies, failed and merged turns are never held', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true });
  const messageId = randomUUID();
  f.hold.settled({ companionId: A, threadId: THREAD, requestId: 'discord-123456', state: 'complete', text: 'Reply', messageId });
  f.hold.settled({ companionId: A, threadId: THREAD, requestId: 'r-failed', state: 'failed', text: '' });
  f.hold.settled({ companionId: A, threadId: THREAD, requestId: 'r-merged', state: 'merged', text: '' });
  await f.settle();
  assert.deepEqual(f.discord, [messageId, 'r-failed', 'r-merged'], 'The Discord bridge answers in the DM at once');
  assert.deepEqual(f.fcm, [], 'Pushes still skip Discord turns, as before');
  assert.equal(f.hold.held, 0);
});

test('Board sub-conversations follow the same rule (their thread on screen counts as read)', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true });
  const board = f.reply({ board: { label: '#15 · Fix login' } });
  f.clock += 1;
  f.clients.report(A, { client: PC, active: true, threadId: THREAD });
  await f.wait();
  assert.ok(nowhere(f, board));
});

test('group messages: held while active elsewhere, dropped once read in the group, pushed if not', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, active: true });
  const groupId = randomUUID(), read = randomUUID(), unread = randomUUID();
  f.hold.group({ companionId: A, groupId, groupName: 'Friends', messageId: read, author: 'Cirno', text: 'hey' });
  f.hold.group({ companionId: A, groupId, groupName: 'Friends', messageId: unread, author: 'Cirno', text: 'hey again' });
  await f.settle();
  assert.deepEqual(f.groupsDelivered, []);
  f.read.add(read);
  await f.wait();
  assert.deepEqual(f.groupsDelivered, [unread]);
  assert.deepEqual(f.fcm, [unread]);
  f.clients.report(A, { client: PC, active: false });
  const direct = randomUUID();
  f.hold.group({ companionId: A, groupId, groupName: 'Friends', messageId: direct, author: 'Cirno', text: 'hi' });
  assert.deepEqual(f.groupsDelivered, [unread, direct], 'No active client: at once');
});

test('fail open: a restart delivers what the previous run still held', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'active-clients-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = fixture(t, { dir, keep: true });
  first.clients.report(A, { client: PC, active: true });
  const id = first.reply({ proactive: true });
  await first.settle();
  assert.ok(nowhere(first, id));
  first.close();
  await first.wait();
  assert.ok(nowhere(first, id), 'The stopped run sends nothing');
  const second = fixture(t, { dir, keep: true });
  assert.equal(second.clients.isActive(A), false, 'Presence does not survive a restart');
  second.hold.recover();
  await second.settle();
  assert.ok(everywhere(second, id), 'Delivered on start instead of lost');
  second.hold.recover();
  await second.settle();
  assert.equal(second.fcm.filter(value => value === id).length, 1, 'Only once');
});

test('the HTTP action reports for the signed-in owner only and refuses bad input', async t => {
  const { createCompanionHttp } = await import('../src/companion-http.mjs');
  const clients = new ActiveClients();
  const identities = new Map([['session-a', A], ['session-b', B]]);
  const http = createCompanionHttp({
    access: { read: async request => ({ value: request.body }), authorize: async request => ({ companionId: identities.get(request.session) }) },
    profiles: { get: () => null }, workspaceFor: () => null, runtimeStatus: async () => ({ state: 'ready' }), activeClients: clients });
  const call = (session, body) => http({ session, body });
  assert.deepEqual((await call('session-a', { action: 'clientActive', client: PC, active: true, threadId: THREAD })).body, { active: true });
  assert.equal(clients.isActive(A), true);
  assert.equal(clients.isActive(B), false);
  assert.equal((await call('session-b', { action: 'clientActive', client: PC, active: true, companionId: A })).status, 400, 'No owner selector');
  assert.equal((await call('session-b', { action: 'clientActive', client: PC, active: 1 })).status, 400);
  assert.equal((await call('session-b', { action: 'clientActive', client: PC, active: true, threadId: '../x' })).status, 400);
  assert.deepEqual((await call('session-a', { action: 'clientActive', client: PC, active: false })).body, { active: false });
  assert.equal(clients.isActive(A), false);
  const older = createCompanionHttp({ access: { read: async request => ({ value: request.body }), authorize: async () => ({ companionId: A }) },
    profiles: { get: () => null }, workspaceFor: () => null, runtimeStatus: async () => ({ state: 'ready' }) });
  assert.equal((await older({ body: { action: 'clientActive', client: PC, active: true } })).status, 400, 'Without the hold the action is unknown');
});

// The web client: a fake document and window.
function page(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const listeners = new Map(), on = (name, run) => listeners.set(name, [...(listeners.get(name) ?? []), run]);
  const p = { clock: 0, focused: true, sent: [], kept: [], thread: THREAD, fail: null };
  p.doc = { visibilityState: 'visible', hasFocus: () => p.focused, addEventListener: on };
  p.win = { addEventListener: on };
  p.fire = name => { for (const run of listeners.get(name) ?? []) run({}); };
  p.client = createActiveClient({ doc: p.doc, win: p.win, now: () => p.clock, client: 'tab-12345678', threadOnScreen: () => p.thread,
    api: async body => { if (p.fail) throw p.fail; p.sent.push(body); return { active: body.active }; }, keepalive: body => p.kept.push(body) });
  p.flush = () => new Promise(resolve => setImmediate(resolve));
  return p;
}

test('web client: reports active with the thread on screen, beats while used and goes inactive on blur or idleness', async t => {
  const p = page(t);
  await p.flush();
  assert.deepEqual(p.sent, [{ action: 'clientActive', client: 'tab-12345678', active: true, threadId: THREAD }], 'Opening the app is use');
  p.clock += BEAT_MS; t.mock.timers.tick(BEAT_MS); await p.flush();
  assert.equal(p.sent.length, 2);
  p.thread = OTHER; p.client.update(); await p.flush();
  assert.equal(p.sent.at(-1).threadId, OTHER, 'Another conversation on screen is reported at once');
  p.client.update(); await p.flush();
  assert.equal(p.sent.length, 3, 'No repeat without a change');
  p.focused = false; p.fire('blur'); await p.flush();
  assert.deepEqual(p.kept, [{ action: 'clientActive', client: 'tab-12345678', active: false, threadId: OTHER }]);
  p.focused = true; p.fire('focus'); await p.flush();
  assert.equal(p.sent.at(-1).active, true);
  p.clock += INPUT_MS; t.mock.timers.tick(BEAT_MS); await p.flush();
  assert.equal(p.kept.length, 2, 'No input for 2 minutes: inactive, the push goes out as usual');
  const count = p.sent.length;
  t.mock.timers.tick(BEAT_MS * 3); await p.flush();
  assert.equal(p.sent.length, count, 'Idle: nothing is sent');
  p.fire('keydown'); await p.flush();
  assert.equal(p.sent.at(-1).active, true, 'Typing again makes it active');
  p.doc.visibilityState = 'hidden'; p.fire('visibilitychange'); await p.flush();
  assert.equal(p.kept.at(-1).active, false);
});

test('web client: an older server without the action is asked once, then left alone', async t => {
  const p = page(t);
  await p.flush();
  p.fail = Object.assign(new Error('INVALID_REQUEST'), { status: 400 });
  p.clock += BEAT_MS; t.mock.timers.tick(BEAT_MS); await p.flush();
  p.fail = null;
  p.clock += BEAT_MS; t.mock.timers.tick(BEAT_MS); p.fire('keydown'); p.client.update(); await p.flush();
  assert.equal(p.sent.length, 1);
  p.fire('blur'); await p.flush();
  assert.deepEqual(p.kept, [], 'No inactive report either');
});
