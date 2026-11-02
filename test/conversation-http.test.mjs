import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'conversation-http-test-'));
  const apps = [];
  t.after(async () => {
    for (const app of apps) if (app.server.listening) await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const open = async mode => { const app = await startServer({ dataDir, port: 0, mode, ...options }); apps.push(app); return app; };
  return { open };
}
async function post(app, body, headers = {}, path = '/api/conversation') {
  const response = await fetch(app.url + path, { method: 'POST',
    headers: { Origin: app.url, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('conversation development fixture requires explicit demo mode and persists across clients/restart', async t => {
  const f = await fixture(t), demo = await f.open('demo');
  const created = await post(demo, { action: 'createThread', requestId: 'synthetic-new-thread', title: 'Synthetic conversation' });
  assert.equal(created.status, 200); assert.equal(created.body.synthetic, true); assert.equal(created.body.version, 1);
  const threadId = created.body.thread.id;
  const request = { action: 'submit', threadId, requestId: 'synthetic-send-once', text: 'A synthetic pasted link: https://example.invalid/release' };
  const accepted = await post(demo, request);
  assert.equal(accepted.status, 200); assert.equal(accepted.body.cursor, undefined);
  assert.deepEqual((await post(demo, request)).body, accepted.body);
  const first = await post(demo, { action: 'events', threadId, cursor: '0' });
  assert.equal(first.status, 200); assert.equal(first.body.events.length, 3); assert.equal(first.body.hasMore, true);
  assert.deepEqual((await post(demo, { action: 'events', threadId, cursor: '0' })).body, first.body);
  const second = await post(demo, { action: 'events', threadId, cursor: first.body.cursor });
  assert.equal(second.body.hasMore, false); assert.equal(second.body.events.length, 2);
  const snapshot = await post(demo, { action: 'snapshot', threadId });
  assert.equal(snapshot.body.messages.length, 2); assert.equal(snapshot.body.cursor, '5');
  assert.equal(snapshot.body.runtime.state, 'development-double');
  assert.equal(snapshot.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(demo.url + '/api/status').then(r => r.json())).adapters.provider.state, 'unavailable');
  await demo.close();
  const resumed = await f.open('demo');
  assert.deepEqual((await post(resumed, { action: 'snapshot', threadId })).body, snapshot.body);
  await resumed.close();
  const closed = await f.open('unavailable');
  const denied = await post(closed, { action: 'snapshot', mode: 'demo' }, { 'x-mode': 'demo' });
  assert.equal(denied.status, 503); assert.equal(denied.body.error.code, 'CONVERSATION_UNAVAILABLE');
  assert.ok(!JSON.stringify(denied.body).includes(request.text));
});

test('account conversation freshly checks admission and never exposes fixtures or forged runtimes', async t => {
  const principal = { issuer: 'https://synthetic.invalid', subject: 'synthetic-owner' };
  let admitted = true, validations = 0;
  const f = await fixture(t, { pilotSubjects: [principal], validateAccount: async () => { validations++; return admitted ? principal : null; } });
  const app = await f.open('account');
  const cookie = { Cookie: '__Secure-blackout_session=' + 'a'.repeat(43) };
  assert.equal((await post(app, { action: 'snapshot' })).status, 401);
  assert.equal(validations, 0);
  for (let index = 0; index < 2; index++) {
    const result = await post(app, { action: 'submit', runtimeId: 'forged-other-owner', mode: 'demo' }, cookie);
    assert.equal(result.status, 400); assert.equal(result.body.error.code, 'INVALID_REQUEST');
    assert.equal(result.body.synthetic, undefined);
  }
  assert.equal(validations, 2);
  const snapshot = await post(app, { action: 'snapshot' }, cookie);
  assert.equal(snapshot.status, 200); assert.notEqual(snapshot.body.synthetic, true);
  assert.notEqual(snapshot.body.runtime.state, 'development-double');
  assert.equal(validations, 3);
  admitted = false;
  const expired = await post(app, { action: 'snapshot' }, cookie);
  assert.equal(expired.status, 401); assert.equal(validations, 4);
  assert.equal(expired.headers.get('cache-control'), 'no-store');
  assert.equal(app.store.db.prepare("SELECT count(*) total FROM bootstrap_record WHERE namespace='development-conversation-v1'").get().total, 0);
});

test('conversation endpoint preserves origin/body/method/static boundaries and sanitizes errors', async t => {
  const app = await (await fixture(t)).open('demo');
  assert.equal((await post(app, { action: 'snapshot' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post(app, { action: 'snapshot' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(app, { action: 'snapshot' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(app, 'x'.repeat(16385))).status, 413);
  const invalid = await post(app, { action: 'launch-runtime', token: 'synthetic-never-echo' });
  assert.equal(invalid.status, 400); assert.ok(!JSON.stringify(invalid.body).includes('synthetic-never-echo'));
  assert.equal((await fetch(app.url + '/api/conversation')).status, 405);
  assert.equal((await fetch(app.url + '/api/conversation?mode=demo')).status, 404);
  assert.equal((await fetch(app.url + '/src/conversation-demo.mjs')).status, 404);
  for (const path of ['/conversation.html', '/companion.css', '/companion-app.mjs', '/conversation-client.mjs']) {
    const response = await fetch(app.url + path); assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-security-policy').includes("default-src 'self'"));
  }
});
