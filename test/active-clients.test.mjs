import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { ActiveClients, PushHold, ACTIVE_TTL_MS, OPEN_TTL_MS } from '../src/active-clients.mjs';
import { PushDevices, PushNotifier } from '../src/push.mjs';
import { WebPushSubscriptions, WebPushNotifier } from '../src/web-push.mjs';
import { createActiveClient, INPUT_MS, BEAT_MS, OPEN_BEAT_MS, CHECK_MS } from '../public/active-client.mjs';

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
    { client: 'bad id with spaces', active: true }, { client: PC }, { client: PC, state: 'away' }, { client: PC, state: true }]) assert.throws(() => clients.report(A, bad), { code: 'INVALID_REQUEST' });
  assert.deepEqual(clients.report(A, { client: PC, active: true, threadId: THREAD }), { active: true, state: 'active' });
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
  assert.deepEqual((await call('session-a', { action: 'clientActive', client: PC, active: true, threadId: THREAD })).body, { active: true, state: 'active' });
  assert.equal(clients.isActive(A), true);
  assert.equal(clients.isActive(B), false);
  assert.equal((await call('session-b', { action: 'clientActive', client: PC, active: true, companionId: A })).status, 400, 'No owner selector');
  assert.equal((await call('session-b', { action: 'clientActive', client: PC, active: 1 })).status, 400);
  assert.equal((await call('session-b', { action: 'clientActive', client: PC, active: true, threadId: '../x' })).status, 400);
  assert.deepEqual((await call('session-a', { action: 'clientActive', client: PC, active: false })).body, { active: false, state: 'closed' });
  assert.equal(clients.isActive(A), false);
  assert.deepEqual((await call('session-a', { action: 'clientActive', client: PC, state: 'open', active: false })).body, { active: false, state: 'open' });
  assert.equal(clients.isPresent(A), true);
  assert.equal((await call('session-a', { action: 'clientActive', client: PC, state: 'away' })).status, 400);
  assert.deepEqual((await call('session-a', { action: 'clientActive', client: PC, state: 'closed' })).body, { active: false, state: 'closed' });
  assert.equal(clients.isPresent(A), false);
  const older = createCompanionHttp({ access: { read: async request => ({ value: request.body }), authorize: async () => ({ companionId: A }) },
    profiles: { get: () => null }, workspaceFor: () => null, runtimeStatus: async () => ({ state: 'ready' }) });
  assert.equal((await older({ body: { action: 'clientActive', client: PC, active: true } })).status, 400, 'Without the hold the action is unknown');
});

test('presence levels: open tabs are present for 150 s, active ones active for 50 s; closed and the old boolean false end both', () => {
  let clock = 0;
  const clients = new ActiveClients({ now: () => clock });
  const away = [];
  clients.onAway(id => away.push(id));
  assert.deepEqual(clients.report(A, { client: PC, state: 'open' }), { active: false, state: 'open' });
  assert.equal(clients.isPresent(A), true);
  assert.equal(clients.isActive(A), false, 'An open background tab is not in active use');
  clock += OPEN_TTL_MS - 1;
  assert.equal(clients.isPresent(A), true, 'A throttled background tab may be a minute late');
  clock += 1;
  assert.equal(clients.isPresent(A), false, 'A tab that stops reporting stops counting');
  assert.deepEqual(away, [], 'Silent expiry is not an explicit leave');
  // The state wins over the boolean; an active report is present and active.
  assert.deepEqual(clients.report(A, { client: PC, state: 'active', active: false }), { active: true, state: 'active' });
  assert.equal(clients.isActive(A) && clients.isPresent(A), true);
  // Active reports do not stretch presence: an active client that vanishes is gone after 50 s, as before.
  clock += ACTIVE_TTL_MS;
  assert.equal(clients.isPresent(A), false);
  // Active, then open (hidden or unfocused): still present for 150 s, no longer active.
  clients.report(A, { client: PC, state: 'active' });
  clients.report(A, { client: PC, state: 'open' });
  assert.equal(clients.isActive(A), false);
  clock += OPEN_TTL_MS - 1;
  assert.equal(clients.isPresent(A), true);
  // The older boolean protocol: Android 0.25.x sends active:false when the app goes to the background → closed.
  clients.report(A, { client: PHONE, active: true });
  clients.report(A, { client: PHONE, active: false });
  assert.deepEqual(away, [], 'The PC tab is still open');
  clients.report(A, { client: PC, state: 'closed' });
  assert.equal(clients.isPresent(A), false);
  assert.deepEqual(away, [A], 'The last present client leaving is announced once');
  clients.report(A, { client: PC, state: 'closed' });
  assert.deepEqual(away, [A]);
  // At most 16 clients per owner (memory only, oldest report dropped first).
  for (let n = 0; n < 20; n++) clients.report(B, { client: 'tab-' + String(n).padStart(8, '0'), state: 'open' });
  for (let n = 0; n < 20; n++) clients.report(B, { client: 'tab-' + String(n).padStart(8, '0'), state: 'closed' });
  assert.equal(clients.isPresent(B), false);
  clients.report(B, { client: 'tab-00000000', state: 'open' });
  for (let n = 1; n <= 16; n++) clients.report(B, { client: 'tab-' + String(n).padStart(8, '0'), state: 'open' });
  for (let n = 1; n <= 16; n++) clients.report(B, { client: 'tab-' + String(n).padStart(8, '0'), state: 'closed' });
  assert.equal(clients.isPresent(B), false, 'The 17th client pushed out the oldest one');
});

test('presence levels: only an active client sees a conversation', () => {
  let clock = 0;
  const clients = new ActiveClients({ now: () => clock });
  clients.report(A, { client: PC, state: 'open', threadId: THREAD });
  assert.equal(clients.viewedSince(A, THREAD, 0), false, 'An open background tab showing the chat did not show it to anyone');
  clients.report(A, { client: PC, state: 'active', threadId: OTHER });
  clock += 10;
  clients.report(A, { client: PC, state: 'open', threadId: OTHER });
  assert.equal(clients.viewedSince(A, OTHER, clock), true, 'On screen until the tab went to the background');
  clock += 10;
  clients.report(A, { client: PC, state: 'open', threadId: OTHER });
  assert.equal(clients.viewedSince(A, OTHER, clock), false, 'Once in the background, later open reports do not count');
});

test('a background tab holds pushes 90 s and then delivers them, unless an active client showed the message', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, state: 'open' });
  const unread = f.reply({ proactive: true });
  await f.settle();
  assert.ok(nowhere(f, unread), 'Held while a tab is open in the background');
  assert.equal(f.hold.held, 1);
  await f.wait();
  assert.ok(everywhere(f, unread), 'Nobody looked: delivered after the delay, not swallowed');
  const seen = f.reply();
  f.clock += 1;
  f.clients.report(A, { client: PC, state: 'active', threadId: THREAD });
  f.clients.report(A, { client: PC, state: 'open' });
  await f.wait();
  assert.ok(nowhere(f, seen), 'The owner came back to the tab and saw it: dropped');
  const group = randomUUID();
  f.hold.group({ companionId: A, groupId: randomUUID(), groupName: 'Friends', messageId: group, author: 'Cirno', text: 'hey' });
  await f.settle();
  assert.deepEqual(f.groupsDelivered, [], 'Group pushes are held for a background tab too');
  await f.wait();
  assert.deepEqual(f.groupsDelivered, [group]);
});

test('going to the background keeps holds waiting; the last present client closing decides them at once', async t => {
  const f = fixture(t);
  f.clients.report(A, { client: PC, state: 'active', threadId: OTHER });
  const id = f.reply();
  await f.settle();
  f.clients.report(A, { client: PC, state: 'open' });
  await f.settle();
  assert.ok(nowhere(f, id), 'Switched to another window: still held, the owner may come back within the delay');
  f.clients.report(A, { client: PHONE, active: true });
  f.clients.report(A, { client: PHONE, active: false });
  await f.settle();
  assert.ok(nowhere(f, id), 'Another client leaving while the tab is still open decides nothing');
  f.clients.report(A, { client: PC, state: 'closed' });
  await f.settle();
  assert.ok(f.fcm.includes(id) && f.web.includes(id), 'The tab closed: pushed now, not after the delay');
  assert.equal(f.hold.held, 0);
});

test('fail open with a background tab: a restart delivers what was held for it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'active-clients-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = fixture(t, { dir, keep: true });
  first.clients.report(A, { client: PC, state: 'open' });
  const id = first.reply();
  await first.settle();
  assert.ok(nowhere(first, id));
  first.close();
  const second = fixture(t, { dir, keep: true });
  assert.equal(second.clients.isPresent(A), false, 'Presence does not survive a restart');
  second.hold.recover();
  await second.settle();
  assert.ok(second.fcm.includes(id) && second.web.includes(id));
});

// The web client: a fake document and window.
function page(t, { signedIn = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const listeners = new Map(), on = (name, run) => listeners.set(name, [...(listeners.get(name) ?? []), run]);
  const p = { clock: 0, focused: true, sent: [], kept: [], thread: THREAD, fail: null, signedIn };
  p.doc = { visibilityState: 'visible', hasFocus: () => p.focused, addEventListener: on };
  p.win = { addEventListener: on };
  p.fire = (name, event = {}) => { for (const run of listeners.get(name) ?? []) run(event); };
  p.client = createActiveClient({ doc: p.doc, win: p.win, now: () => p.clock, client: 'tab-12345678', threadOnScreen: () => p.thread,
    signedIn: () => p.signedIn,
    api: async body => { if (p.fail) throw p.fail; p.sent.push(body); return { active: body.active }; }, keepalive: body => p.kept.push(body) });
  p.flush = () => new Promise(resolve => setImmediate(resolve));
  p.tick = async ms => { for (let done = 0; done < ms; done += CHECK_MS) { p.clock += CHECK_MS; t.mock.timers.tick(CHECK_MS); await p.flush(); } };
  return p;
}
const msg = (state, threadId) => ({ action: 'clientActive', client: 'tab-12345678', state, active: state === 'active', ...(threadId ? { threadId } : {}) });

test('web client: reports active with the thread on screen, beats while used, and drops to open on blur or idleness', async t => {
  const p = page(t);
  await p.flush();
  assert.deepEqual(p.sent, [msg('active', THREAD)], 'Opening the app is use');
  await p.tick(BEAT_MS);
  assert.equal(p.sent.length, 2);
  p.thread = OTHER; p.client.update(); await p.flush();
  assert.equal(p.sent.at(-1).threadId, OTHER, 'Another conversation on screen is reported at once');
  p.client.update(); await p.flush();
  assert.equal(p.sent.length, 3, 'No repeat without a change');
  p.focused = false; p.fire('blur'); await p.flush();
  assert.deepEqual(p.kept, [msg('open', OTHER)], 'Blur: still open, and what was on screen until now counts as seen');
  p.focused = true; p.fire('focus'); await p.flush();
  assert.equal(p.sent.at(-1).state, 'active');
  p.clock += INPUT_MS; t.mock.timers.tick(CHECK_MS); await p.flush();
  assert.equal(p.kept.length, 2, 'No input for 2 minutes: open, no longer active');
  assert.deepEqual(p.kept.at(-1), msg('open'), 'Walked away: the conversation on screen does not count as seen');
  p.fire('keydown'); await p.flush();
  assert.equal(p.sent.at(-1).state, 'active', 'Typing again makes it active');
});

test('web client: a hidden or unfocused tab keeps reporting open every 30 s (throttled timers too) and closes on pagehide', async t => {
  const p = page(t);
  await p.flush();
  p.doc.visibilityState = 'hidden'; p.fire('visibilitychange'); await p.flush();
  assert.deepEqual(p.kept, [msg('open', THREAD)]);
  const count = p.sent.length;
  await p.tick(OPEN_BEAT_MS - CHECK_MS);
  assert.equal(p.sent.length, count, 'Not before 30 s');
  await p.tick(CHECK_MS);
  assert.deepEqual(p.sent.slice(count), [msg('open')], 'Open again after 30 s, with no thread: a background tab sees nothing');
  await p.tick(OPEN_BEAT_MS * 2);
  assert.equal(p.sent.length, count + 3, 'Every 30 s while hidden');
  // A throttled tab whose check runs once a minute still reports at every run.
  p.clock += 60_000; t.mock.timers.tick(CHECK_MS); await p.flush();
  assert.equal(p.sent.length, count + 4);
  p.fire('pagehide'); await p.flush();
  assert.deepEqual(p.kept.at(-1), msg('closed'), 'Closing the tab is told with keepalive');
  await p.tick(OPEN_BEAT_MS * 2);
  assert.equal(p.sent.length, count + 4, 'Nothing after pagehide');
  p.fire('pageshow', { persisted: true }); await p.flush();
  assert.deepEqual(p.sent.at(-1), msg('open'), 'Back from the back/forward cache: open again');
});

test('web client: nothing is reported while signed out; signing out closes', async t => {
  const p = page(t, { signedIn: false });
  await p.flush(); await p.tick(OPEN_BEAT_MS * 2);
  assert.deepEqual(p.sent, []);
  p.signedIn = true; p.client.update(); await p.flush();
  assert.deepEqual(p.sent, [msg('active', THREAD)]);
  p.focused = false; p.fire('blur'); await p.flush();
  p.signedIn = false; p.client.update(); await p.flush();
  assert.deepEqual(p.kept, [msg('open', THREAD), msg('closed')]);
  await p.tick(OPEN_BEAT_MS * 2);
  assert.equal(p.sent.length, 1);
});

test('web client: an older server without the action (or the state field) is asked once, then left alone', async t => {
  const p = page(t);
  await p.flush();
  p.fail = Object.assign(new Error('INVALID_REQUEST'), { status: 400 });
  await p.tick(BEAT_MS);
  p.fail = null;
  await p.tick(BEAT_MS); p.fire('keydown'); p.client.update(); await p.flush();
  assert.equal(p.sent.length, 1);
  p.fire('blur'); p.fire('pagehide'); await p.flush();
  assert.deepEqual(p.kept, [], 'No open or closed report either');
});
