import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { WebPushSubscriptions, WebPushSender, WebPushNotifier, encryptPayload, loadVapidKeys, previewText, pushEndpoint, PRESENCE_MS } from '../src/web-push.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const A = randomUUID(), B = randomUUID();
const APPLE = 'https://web.push.apple.com/QGuQyavXutnMH';

// A browser: its own ECDH key and auth secret, and the RFC 8291 decryption written independently with hkdfSync.
function browser(endpoint = APPLE + randomUUID()) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url'),
    decrypt(body) {
      const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], server = body.subarray(21, 21 + idlen);
      assert.equal(rs, 4096); assert.equal(idlen, 65);
      const shared = ecdh.computeSecret(server);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), server]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
      const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const sealed = body.subarray(21 + idlen), decipher = createDecipheriv('aes-128-gcm', key, nonce);
      decipher.setAuthTag(sealed.subarray(-16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
      assert.equal(plain.at(-1), 2, 'Last-record delimiter');
      return JSON.parse(plain.subarray(0, -1).toString());
    }
  };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'web-push-')), store = new BootstrapStore(dir, ROOT);
  let clock = 1_000;
  const subscriptions = new WebPushSubscriptions({ store, now: () => ++clock });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, subscriptions };
}

test('only https endpoints of the browsers\' push services are accepted', () => {
  for (const ok of [APPLE, 'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://jmt17.google.com/fcm/send/x']) assert.equal(pushEndpoint(ok), ok);
  for (const bad of ['http://web.push.apple.com/x', 'https://web.push.apple.com.evil.example/x', 'https://127.0.0.1/x',
    'https://localhost/x', 'https://evil.google.com/x', 'https://web.push.apple.com:8443/x', 'https://user:pw@web.push.apple.com/x', 'not a url', 42, null])
    assert.equal(pushEndpoint(bad), null, String(bad));
});

test('subscriptions belong to the owner who saved them, move on re-subscribe and cannot be removed by the other owner', t => {
  const { subscriptions } = fixture(t);
  const phone = browser(), laptop = browser('https://fcm.googleapis.com/fcm/send/' + randomUUID());
  assert.deepEqual(subscriptions.subscribe(A, phone), { subscribed: true, preview: true });
  subscriptions.subscribe(B, { ...laptop, preview: false });
  assert.deepEqual(subscriptions.list(A).map(row => row.endpoint), [phone.endpoint]);
  assert.deepEqual(subscriptions.status(B, laptop.endpoint), { subscribed: true, preview: false });
  assert.deepEqual(subscriptions.status(B, phone.endpoint), { subscribed: false });
  subscriptions.unsubscribe(B, phone.endpoint);
  assert.equal(subscriptions.list(A).length, 1, 'Not B\'s to remove');
  subscriptions.subscribe(B, phone);
  assert.deepEqual(subscriptions.list(A), []);
  assert.equal(subscriptions.list(B).length, 2);
  for (const bad of [{ ...phone, p256dh: 'AAAA' }, { ...phone, auth: randomBytes(8).toString('base64url') }, { ...phone, endpoint: 'https://evil.example/x' },
    { ...phone, preview: 'yes' }, { ...phone, p256dh: Buffer.alloc(65, 1).toString('base64url') }])
    assert.throws(() => subscriptions.subscribe(A, bad), { code: 'INVALID_REQUEST' });
  for (let i = 0; i < 12; i++) subscriptions.subscribe(A, browser());
  assert.equal(subscriptions.list(A).length, 10, 'Newest 10 per owner');
});

test('the VAPID key is created once with mode 600 and the payload decrypts only for its browser', t => {
  const { dir } = fixture(t);
  const file = join(dir, 'config', 'vapid.json');
  const keys = loadVapidKeys(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadVapidKeys(file).publicKey, keys.publicKey, 'Reused, not replaced');
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  assert.ok(!readFileSync(file, 'utf8').includes(keys.publicKey), 'Stored as a JWK');
  const phone = browser(), other = browser();
  const body = encryptPayload(JSON.stringify({ hello: 'there' }), phone);
  assert.deepEqual(phone.decrypt(body), { hello: 'there' });
  assert.throws(() => other.decrypt(body));
  assert.notDeepEqual(encryptPayload('x', phone), encryptPayload('x', phone), 'Fresh salt and key every time');
});

test('the sender signs a VAPID token for the push service and posts the encrypted payload', async t => {
  const { dir } = fixture(t);
  const keys = loadVapidKeys(join(dir, 'vapid.json')), phone = browser(), calls = [];
  let status = 201;
  const sender = new WebPushSender({ keys, now: () => 1_800_000_000_000, fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status }; } });
  assert.equal(await sender.send(phone, { title: 'Mochi', body: 'Hi' }), 'sent');
  const { url, init } = calls[0];
  assert.equal(url, phone.endpoint);
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.TTL, '86400');
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
  assert.equal(key, keys.publicKey);
  const [header, claims, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(payload.aud, 'https://web.push.apple.com');
  assert.equal(payload.exp, 1_800_000_000 + 12 * 3600);
  assert.match(payload.sub, /^https:|^mailto:/);
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(createVerify('SHA256').update(header + '.' + claims).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.deepEqual(phone.decrypt(init.body), { title: 'Mochi', body: 'Hi' });
  status = 410; assert.equal(await sender.send(phone, {}), 'gone');
  status = 404; assert.equal(await sender.send(phone, {}), 'gone');
  status = 500; assert.equal(await sender.send(phone, {}), 'failed');
});

test('a delivered message is pushed once to its owner\'s browsers, with or without the text; Discord turns are not', async t => {
  const { subscriptions } = fixture(t);
  const shown = browser(), hidden = browser(), others = browser(), sent = [], logs = [];
  subscriptions.subscribe(A, shown); subscriptions.subscribe(A, { ...hidden, preview: false }); subscriptions.subscribe(B, others);
  const gone = new Set([hidden.endpoint]);
  const notifier = new WebPushNotifier({ subscriptions, nameFor: id => id === A ? 'Mochi' : null, log: line => logs.push(line),
    sender: { send: async (subscription, payload) => { sent.push({ endpoint: subscription.endpoint, payload }); return gone.has(subscription.endpoint) ? 'gone' : 'sent'; } } });
  const event = { companionId: A, threadId: 't1', requestId: 'r1', state: 'complete', messageId: 'm1',
    text: '## Rent\nDon\'t forget to **pay rent** today — [details](https://example.com) ' + 'x'.repeat(300) };
  notifier.settled(event); notifier.settled(event);
  notifier.settled({ ...event, messageId: 'm2', requestId: 'discord-1' });
  notifier.settled({ ...event, messageId: 'm3', state: 'failed' });
  await sleep(10);
  assert.equal(sent.length, 2, 'Once per browser, only for A');
  const byEndpoint = Object.fromEntries(sent.map(item => [item.endpoint, item.payload]));
  assert.equal(byEndpoint[hidden.endpoint].body, 'New message');
  const body = byEndpoint[shown.endpoint].body;
  assert.ok(body.startsWith('Rent Don\'t forget to pay rent today — details x'), body);
  assert.ok(body.length <= 180 && body.endsWith('…'));
  assert.deepEqual({ ...byEndpoint[shown.endpoint], body: undefined }, { type: 'message', threadId: 't1', messageId: 'm1', title: 'Mochi', body: undefined });
  assert.deepEqual(subscriptions.list(A).map(row => row.endpoint), [shown.endpoint], 'Gone subscriptions are dropped');
  assert.ok(logs.every(line => !line.includes('rent') && !line.includes('push.apple')), 'Logs carry counts only');
  assert.equal(previewText('```js\ncode\n```'), 'code');
});

test('the HTTP actions act for the signed-in owner only', async t => {
  const { createCompanionHttp } = await import('../src/companion-http.mjs');
  const { subscriptions } = fixture(t);
  const identities = new Map([['session-a', A], ['session-b', B]]);
  const http = createCompanionHttp({
    access: { read: async request => ({ value: request.body }), authorize: async request => ({ companionId: identities.get(request.session) }) },
    profiles: { get: () => null }, workspaceFor: () => null, runtimeStatus: async () => ({ state: 'ready' }),
    webPush: { subscriptions, publicKey: () => 'BPUBLIC' } });
  const call = (session, body) => http({ session, body });
  const wire = ({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth });
  const phone = browser();
  assert.deepEqual((await call('session-a', { action: 'webPushKey' })).body, { publicKey: 'BPUBLIC' });
  assert.deepEqual((await call('session-a', { action: 'webPushSubscribe', ...wire(phone), preview: false })).body, { subscribed: true, preview: false });
  assert.equal((await call('session-b', { action: 'webPushSubscribe', ...wire(browser()), companionId: A })).status, 400, 'No owner selector');
  assert.equal((await call('session-b', { action: 'webPushSubscribe', ...wire(browser()), endpoint: 'https://127.0.0.1/x' })).status, 400);
  assert.deepEqual((await call('session-b', { action: 'webPushStatus', endpoint: phone.endpoint })).body, { subscribed: false });
  await call('session-b', { action: 'webPushUnsubscribe', endpoint: phone.endpoint });
  assert.deepEqual((await call('session-a', { action: 'webPushStatus', endpoint: phone.endpoint })).body, { subscribed: true, preview: false });
  assert.deepEqual((await call('session-a', { action: 'webPushPresence', endpoint: phone.endpoint, present: true })).body, { present: true });
  assert.deepEqual((await call('session-b', { action: 'webPushPresence', endpoint: phone.endpoint, present: true })).body, { present: false });
  assert.deepEqual((await call('session-a', { action: 'webPushUnsubscribe', endpoint: phone.endpoint })).body, { subscribed: false });
  assert.deepEqual(subscriptions.list(A), []);
});

test('#49: a device open on the chat gets no push until it leaves or stops reporting; other devices still do', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'web-push-')), store = new BootstrapStore(dir, ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let clock = 1_000_000;
  const subscriptions = new WebPushSubscriptions({ store, now: () => clock });
  const phone = browser(), laptop = browser(), sent = [];
  subscriptions.subscribe(A, phone); subscriptions.subscribe(A, laptop);
  const notifier = new WebPushNotifier({ subscriptions, sender: { send: async subscription => { sent.push(subscription.endpoint); return 'sent'; } } });
  let n = 0;
  const reply = async () => { sent.length = 0; notifier.settled({ companionId: A, threadId: 't', requestId: 'r', state: 'complete', messageId: 'm' + n++, text: 'Hi' }); await sleep(5); return [...sent]; };
  assert.deepEqual(subscriptions.presence(A, phone.endpoint, true), { present: true });
  assert.deepEqual(await reply(), [laptop.endpoint], 'The open phone is skipped, the laptop still notified');
  clock += PRESENCE_MS - 1;
  assert.deepEqual(await reply(), [laptop.endpoint]);
  clock += 2;
  assert.deepEqual((await reply()).sort(), [phone.endpoint, laptop.endpoint].sort(), 'Stopped reporting (app suspended): notified again');
  subscriptions.presence(A, phone.endpoint, true);
  subscriptions.presence(A, phone.endpoint, false);
  assert.deepEqual((await reply()).sort(), [phone.endpoint, laptop.endpoint].sort(), 'Left the chat: notified at once');
  assert.deepEqual(subscriptions.presence(B, phone.endpoint, true), { present: false }, 'Only the owner of the subscription');
  assert.equal((await reply()).length, 2);
  assert.throws(() => subscriptions.presence(A, phone.endpoint, 'yes'), { code: 'INVALID_REQUEST' });
  assert.throws(() => subscriptions.presence(A, 'https://evil.example/x', true), { code: 'INVALID_REQUEST' });
});
