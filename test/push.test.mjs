import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { PushDevices, FcmSender, PushNotifier, PushError } from '../src/push.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const A = randomUUID(), B = randomUUID();
const token = name => 'fcm_' + name + ':' + 'x'.repeat(40);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'push-')), store = new BootstrapStore(dir, ROOT);
  let clock = 1_000;
  const devices = new PushDevices({ store, now: () => ++clock });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, devices };
}

test('registrations belong to the owner who made them, move with a re-sign-in and cannot be removed by the other owner', t => {
  const { devices } = fixture(t);
  devices.register(A, token('phone'));
  devices.register(B, token('tablet'));
  assert.deepEqual(devices.tokens(A), [token('phone')]);
  assert.deepEqual(devices.tokens(B), [token('tablet')]);
  devices.unregister(B, token('phone'));
  assert.deepEqual(devices.tokens(A), [token('phone')], 'B cannot remove A\'s device');
  devices.register(B, token('phone'));
  assert.deepEqual(devices.tokens(A), [], 'The same phone signing in as B stops A\'s notifications');
  assert.deepEqual(devices.tokens(B).sort(), [token('phone'), token('tablet')].sort());
  devices.unregister(B, token('phone'));
  assert.deepEqual(devices.tokens(B), [token('tablet')]);
  for (const bad of ['', 'short', 'has space ' + 'x'.repeat(30), 42]) assert.throws(() => devices.register(A, bad), PushError);
  for (let index = 0; index < 12; index++) devices.register(A, token('n' + index));
  assert.equal(devices.tokens(A).length, 10, 'Only the newest ten installs are kept');
  assert.equal(devices.tokens(A)[0], token('n11'));
});

function fakeGoogle(t) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'push-key-')), keyFile = join(dir, 'key.json');
  writeFileSync(keyFile, JSON.stringify({ type: 'service_account', project_id: 'demo-project', client_email: 'push@demo.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = { auth: [], sends: [] }, gone = new Set();
  const fetchImpl = async (url, spec) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const assertion = new URLSearchParams(spec.body.toString()).get('assertion');
      const [header, claims, signature] = assertion.split('.');
      assert.ok(createVerify('RSA-SHA256').update(header + '.' + claims).verify(publicKey, Buffer.from(signature, 'base64url')));
      calls.auth.push(JSON.parse(Buffer.from(claims, 'base64url')));
      return Response.json({ access_token: 'access-1', expires_in: 3600 });
    }
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/demo-project/messages:send');
    assert.equal(spec.headers.Authorization, 'Bearer access-1');
    const message = JSON.parse(spec.body).message;
    calls.sends.push(message);
    if (gone.has(message.token)) return Response.json({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 });
    return Response.json({ name: 'projects/demo-project/messages/1' });
  };
  return { keyFile, fetchImpl, calls, gone };
}

test('the FCM sender signs a service-account token once and sends data-only, high-priority messages', async t => {
  const google = fakeGoogle(t);
  const sender = new FcmSender({ keyFile: google.keyFile, fetchImpl: google.fetchImpl });
  assert.equal(await sender.send(token('a'), { type: 'message', threadId: 't', messageId: 'm' }), 'sent');
  assert.equal(await sender.send(token('a'), { type: 'message', threadId: 't', messageId: 'm2' }), 'sent');
  assert.equal(google.calls.auth.length, 1, 'The access token is reused until it nears expiry');
  assert.equal(google.calls.auth[0].scope, 'https://www.googleapis.com/auth/firebase.messaging');
  const [message] = google.calls.sends;
  assert.equal(message.notification, undefined, 'No visible notification payload: the app builds it');
  assert.deepEqual(message.android, { priority: 'HIGH', ttl: '86400s' });
  google.gone.add(token('b'));
  assert.equal(await sender.send(token('b'), { type: 'message' }), 'gone');
});

test('a delivered message is pushed once, as ids only, to its own owner\'s devices; Discord turns and failures are not', async t => {
  const { devices } = fixture(t), google = fakeGoogle(t);
  const notifier = new PushNotifier({ devices, sender: new FcmSender({ keyFile: google.keyFile, fetchImpl: google.fetchImpl }),
    nameFor: id => id === A ? 'C-chan' : 'Pip' });
  devices.register(A, token('a-phone'));
  devices.register(B, token('b-phone'));
  google.gone.add(token('a-old')); devices.register(A, token('a-old'));
  const event = { companionId: A, threadId: 'thread-a', requestId: 'r1', state: 'complete', text: 'PRIVATE_REPLY_TEXT', messageId: 'msg-1' };
  notifier.settled(event);
  notifier.settled(event);
  notifier.settled({ ...event, requestId: 'discord-123', messageId: 'msg-2' });
  notifier.settled({ ...event, state: 'error', messageId: 'msg-3' });
  notifier.settled({ ...event, messageId: undefined });
  await sleep(50);
  assert.deepEqual(google.calls.sends.map(message => message.token).sort(), [token('a-old'), token('a-phone')].sort());
  for (const message of google.calls.sends) {
    assert.deepEqual(message.data, { type: 'message', threadId: 'thread-a', messageId: 'msg-1', name: 'C-chan' });
    assert.ok(!JSON.stringify(message).includes('PRIVATE_REPLY_TEXT'), 'Message text never goes through Google');
  }
  assert.deepEqual(devices.tokens(A), [token('a-phone')], 'A token Google reports as gone is forgotten');
  assert.deepEqual(devices.tokens(B), [token('b-phone')]);
  notifier.settled({ companionId: B, threadId: 'thread-b', requestId: 'wake-1', state: 'complete', text: 'Reminder', messageId: 'msg-b', proactive: true });
  await sleep(50);
  assert.equal(google.calls.sends.at(-1).token, token('b-phone'));
  assert.equal(google.calls.sends.at(-1).data.name, 'Pip');
});

test('the HTTP actions register for the signed-in owner only and refuse owner selectors or bad tokens', async t => {
  const { createCompanionHttp } = await import('../src/companion-http.mjs');
  const { devices } = fixture(t);
  const identities = new Map([['session-a', A], ['session-b', B]]);
  const http = createCompanionHttp({
    access: { read: async request => ({ value: request.body }), authorize: async request => ({ companionId: identities.get(request.session) }) },
    profiles: { get: () => null }, workspaceFor: () => null, runtimeStatus: async () => ({ state: 'ready' }), push: devices });
  const call = (session, body) => http({ session, body });
  assert.deepEqual((await call('session-a', { action: 'pushRegister', token: token('a') })).body, { registered: true });
  assert.equal((await call('session-b', { action: 'pushRegister', token: token('b'), companionId: A })).status, 400, 'No owner selector');
  assert.equal((await call('session-b', { action: 'pushRegister', token: 'bad token' })).status, 400);
  assert.equal((await call('session-b', { action: 'pushUnregister', token: token('a') })).status, 200);
  assert.deepEqual(devices.tokens(A), [token('a')], 'Unregistering someone else\'s token does nothing');
  assert.deepEqual(devices.tokens(B), []);
  assert.deepEqual((await call('session-a', { action: 'pushUnregister', token: token('a') })).body, { registered: false });
  assert.deepEqual(devices.tokens(A), []);
});
