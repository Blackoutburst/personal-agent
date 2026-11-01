import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { startServer } from '../server.mjs';

// Synthetic owners, sessions and content only; no deployed account or runtime.
const ISSUER = 'https://blackoutburst.com';
const A1 = 'A'.repeat(43), A2 = 'D'.repeat(43), B = 'B'.repeat(43), C = 'C'.repeat(43);
const PA = { issuer: ISSUER, subject: 'synthetic-private-owner-a' };
const PB = { issuer: ISSUER, subject: 'synthetic-private-owner-b' };
const PRIVATE_ERROR = 'synthetic-private-error-must-not-escape';
const COOKIE = proof => `__Secure-blackout_session=${proof}`;
const create = (requestId, kind, value, extra = {}) => ({ action: 'mutate',
  mutation: { requestId, op: 'create', kind, expectedVersion: 0, value, ...extra } });
const mutate = mutation => ({ action: 'mutate', mutation });

async function fixture(t) {
  const tempRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(tempRoot, 'private-state-http-synthetic-'));
  const apps = [];
  const active = new Map([[A1, PA], [A2, PA], [B, PB], [C, { issuer: ISSUER, subject: 'synthetic-uninvited' }]]);
  const validations = [];
  let app, failure = false;
  async function open(mode = 'account') {
    app = await startServer({ dataDir: directory, port: 0, mode, pilotSubjects: [PA, PB],
      validateAccount: async proof => {
        validations.push(proof);
        await new Promise(resolve => setImmediate(resolve));
        if (failure) throw new Error(PRIVATE_ERROR);
        return active.get(proof) || null;
      } });
    apps.push(app);
    return app;
  }
  function send(payload, options = {}) {
    const target = options.app || app;
    const proof = Object.hasOwn(options, 'proof') ? options.proof : A1;
    const cookie = Object.hasOwn(options, 'cookie') ? options.cookie : proof === null ? null : COOKIE(proof);
    const body = Object.hasOwn(options, 'body') ? options.body : JSON.stringify(payload);
    const headers = options.rawHeaders ? ['Host', new URL(target.url).host, ...options.rawHeaders] : {
      Origin: target.url, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...options.headers,
    };
    return new Promise((resolve, reject) => {
      const req = request(target.url + (options.path || '/api/private/state'), {
        method: options.method || 'POST', headers, agent: false,
      }, res => {
        let text = '';
        res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try {
            assert.equal(res.headers['cache-control'], 'no-store');
            resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(6000, () => req.destroy(new Error('Synthetic private HTTP request timed out')));
      req.end(body);
    });
  }
  async function ok(payload, options) {
    const response = await send(payload, options);
    assert.equal(response.status, 200, response.text);
    return response.json;
  }
  t.after(async () => {
    for (const item of apps.reverse()) {
      if (item.server.listening) { item.server.closeAllConnections(); await item.close(); }
    }
    const actual = realpathSync(directory);
    assert.equal(dirname(actual), tempRoot);
    assert.ok(basename(actual).startsWith('private-state-http-synthetic-'));
    rmSync(actual, { recursive: true, force: true });
  });
  await open();
  return { open, send, ok, active, validations, get app() { return app; }, setFailure(value) { failure = value; } };
}

function metadataOnly(value) {
  assert.deepEqual(Object.keys(value).sort(), ['checkpoint', 'deleted', 'id', 'kind', 'sequence', 'threadId', 'version']);
  assert.equal(value.value, undefined);
}

test('every private HTTP request revalidates authority across two devices, owners and revocation', async t => {
  const f = await fixture(t);
  const content = { title: 'synthetic A private thread' };
  const thread = await f.ok(create('auth-thread', 'thread', content));
  assert.equal(f.validations.length, 1);
  const secondDevice = await f.send({ action: 'read', id: thread.id }, { proof: A2 });
  assert.equal(secondDevice.status, 200);
  assert.deepEqual(secondDevice.json.record.value, content);
  assert.equal(secondDevice.headers['set-cookie'], undefined);
  assert.equal(secondDevice.headers['access-control-allow-origin'], undefined);
  const foreign = await f.send({ action: 'read', id: thread.id }, { proof: B });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error.code, 'PRIVATE_STATE_NOT_FOUND');
  assert.ok(!foreign.text.includes(content.title));
  assert.deepEqual((await f.ok({ action: 'list', kind: 'thread' }, { proof: B })).records, []);
  assert.deepEqual((await f.ok({ action: 'changes' }, { proof: B })).events, []);
  assert.equal((await f.send({ action: 'read', id: thread.id }, { proof: C })).status, 403);
  f.active.delete(A1);
  assert.equal((await f.send({ action: 'read', id: thread.id })).status, 401);
  assert.equal((await f.ok({ action: 'read', id: thread.id }, { proof: A2 })).record.id, thread.id);
  f.setFailure(true);
  const unavailable = await f.send({ action: 'read', id: thread.id }, { proof: A2 });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.error.code, 'ACCOUNT_VALIDATION_UNAVAILABLE');
  assert.deepEqual(Object.keys(unavailable.json), ['error']);
  assert.ok(!unavailable.text.includes(PRIVATE_ERROR) && !unavailable.text.includes(content.title));
  assert.equal(f.validations.length, 9, 'Each well-formed request obtains fresh authority, including denials');
});

test('thread/message commits and identical retries survive a server restart and second device', async t => {
  const f = await fixture(t);
  const identity = await f.ok({}, { path: '/api/session' });
  const threadInput = create('durable-thread', 'thread', { title: 'synthetic durable thread' });
  const first = await Promise.all([f.ok(threadInput), f.ok(threadInput, { proof: A2 })]);
  assert.deepEqual(first[0], first[1]); metadataOnly(first[0]);
  const messageInput = create('durable-message', 'message', { text: 'synthetic durable message', tags: { one: 1, two: 2 } }, { threadId: first[0].id });
  const messages = await Promise.all([f.ok(messageInput), f.ok(messageInput, { proof: A2 })]);
  assert.deepEqual(messages[0], messages[1]); metadataOnly(messages[0]);
  const before = await f.ok({ action: 'changes' });
  assert.deepEqual(before.events.map(event => event.sequence), [1, 2]);
  await f.app.close();
  await f.open();
  assert.equal((await f.ok({}, { path: '/api/session', proof: A2 })).companionId, identity.companionId);
  assert.deepEqual((await f.ok({ action: 'read', id: messages[0].id }, { proof: A2 })).record.value, messageInput.mutation.value);
  assert.deepEqual(await f.ok(threadInput, { proof: A2 }), first[0]);
  const reordered = create('durable-message', 'message', { tags: { two: 2, one: 1 }, text: 'synthetic durable message' }, { threadId: first[0].id });
  assert.deepEqual(await f.ok(reordered), messages[0]);
  assert.equal((await f.ok({ action: 'list', kind: 'message', threadId: first[0].id })).records.length, 1);
  assert.deepEqual((await f.ok({ action: 'changes', cursor: before.checkpoint })).events, []);
  assert.equal((await f.ok({ action: 'changes' })).events.length, 2, 'Retries do not allocate extra commits');
});

test('concurrent compare-and-swap updates commit one winner and keep owner-specific sequences', async t => {
  const f = await fixture(t);
  const created = await f.ok(create('cas-thread', 'thread', { title: 'base' }));
  for (const operation of [
    { requestId: 'foreign-update', op: 'update', id: created.id, expectedVersion: 1, value: { title: 'forged replacement' } },
    { requestId: 'foreign-remove', op: 'remove', id: created.id, expectedVersion: 1 },
  ]) {
    const denied = await f.send(mutate(operation), { proof: B });
    assert.equal(denied.status, 404);
    assert.equal(denied.json.error.code, 'PRIVATE_STATE_NOT_FOUND');
  }
  const operations = ['one', 'two'].map(label => ({ requestId: 'cas-' + label, op: 'update', id: created.id, expectedVersion: 1, value: { title: label } }));
  const responses = await Promise.all(operations.map((operation, index) => f.send(mutate(operation), { proof: index ? A2 : A1 })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const index = responses.findIndex(response => response.status === 200);
  assert.equal(responses[index].json.version, 2);
  assert.equal(responses[1 - index].json.error.code, 'PRIVATE_STATE_CONFLICT');
  assert.deepEqual((await f.ok({ action: 'read', id: created.id })).record.value, operations[index].value);
  assert.deepEqual(await f.ok(mutate(operations[index]), { proof: A2 }), responses[index].json);
  const reused = await f.send(mutate({ ...operations[index], value: { title: 'different retry' } }));
  assert.equal(reused.status, 409);
  const stale = await f.send(mutate({ ...operations[index], requestId: 'cas-stale' }));
  assert.equal(stale.status, 409);
  assert.deepEqual((await f.ok({ action: 'changes' })).events.map(event => event.sequence), [1, 2]);
  const other = await f.ok(create('cas-thread', 'thread', { title: 'B independent sequence' }), { proof: B });
  assert.equal(other.sequence, 1);
  assert.notEqual(other.id, created.id);
});

test('HTTP cursors bind owner, purpose, kind and thread while snapshots catch later changes', async t => {
  const f = await fixture(t);
  const threads = [];
  for (const label of ['alpha', 'beta', 'gamma']) threads.push(await f.ok(create('cursor-' + label, 'thread', { title: label })));
  await f.ok(create('cursor-goal', 'goal', { title: 'synthetic goal' }));
  for (const label of ['one', 'two']) await f.ok(create('cursor-message-' + label, 'message', { text: label }, { threadId: threads[0].id }));
  await f.ok(create('cursor-other-message', 'message', { text: 'other thread' }, { threadId: threads[1].id }));
  const first = await f.ok({ action: 'list', kind: 'thread', limit: 1 });
  assert.equal(first.records.length, 1); assert.equal(typeof first.nextCursor, 'string');
  const messagePage = await f.ok({ action: 'list', kind: 'message', threadId: threads[0].id, limit: 1 });
  assert.equal(typeof messagePage.nextCursor, 'string');
  const changes = await f.ok({ action: 'changes', limit: 1 });
  assert.equal(changes.events.length, 1); assert.equal(typeof changes.nextCursor, 'string');
  const invalid = [
    [{ action: 'list', kind: 'thread', cursor: first.nextCursor, limit: 1 }, B],
    [{ action: 'changes', cursor: first.nextCursor }, A1],
    [{ action: 'list', kind: 'goal', cursor: first.nextCursor }, A1],
    [{ action: 'list', kind: 'message', threadId: threads[1].id, cursor: messagePage.nextCursor }, A1],
    [{ action: 'list', kind: 'thread', cursor: changes.nextCursor }, A1],
    [{ action: 'changes', cursor: changes.nextCursor }, B],
    [{ action: 'changes', cursor: changes.nextCursor + '!' }, A1],
    [{ action: 'changes', cursor: '999999999' }, A1],
    [{ action: 'changes', cursor: Buffer.from('{"sequence":999999999}').toString('base64url') }, A1],
  ];
  for (const [payload, proof] of invalid) {
    const denied = await f.send(payload, { proof });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error.code, 'PRIVATE_STATE_INVALID_CURSOR');
  }
  const remaining = await f.ok({ action: 'changes', cursor: changes.checkpoint });
  assert.equal(remaining.events.length, 6, 'Checkpoint follows the returned page, without skipping unread changes');
  assert.equal(remaining.events[0].sequence, 2);
  const late = await f.ok(create('cursor-late', 'thread', { title: 'late create' }));
  const listed = [...first.records];
  let cursor = first.nextCursor;
  for (let count = 0; cursor && count < 5; count++) {
    const page = await f.ok({ action: 'list', kind: 'thread', cursor, limit: 1 });
    listed.push(...page.records); cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
  assert.deepEqual(new Set(listed.map(record => record.id)), new Set(threads.map(thread => thread.id)));
  assert.ok((await f.ok({ action: 'changes', cursor: first.checkpoint })).events.some(event => event.id === late.id));
  const otherThread = await f.ok(create('cursor-b-thread', 'thread', { title: 'B thread' }), { proof: B });
  assert.equal((await f.send({ action: 'list', kind: 'message', threadId: otherThread.id })).status, 404);
  assert.equal((await f.send(create('cross-owner-message', 'message', { text: 'rejected' }, { threadId: otherThread.id }))).status, 404);
});

test('thread deletion removes HTTP content from reads, lists, changes and cached retries without resurrection', async t => {
  const f = await fixture(t);
  const title = 'synthetic-private-deleted-thread-content';
  const text = 'synthetic-private-deleted-message-content';
  const threadInput = create('delete-thread', 'thread', { title });
  const thread = await f.ok(threadInput);
  const messageInput = create('delete-message', 'message', { text }, { threadId: thread.id });
  const message = await f.ok(messageInput);
  const updated = await f.ok(mutate({ requestId: 'delete-update', op: 'update', id: message.id, expectedVersion: 1, value: { text: text + '-updated' } }));
  const removal = mutate({ requestId: 'delete-remove', op: 'remove', id: thread.id, expectedVersion: 1 });
  const removed = await f.ok(removal); metadataOnly(removed);
  assert.equal(removed.deleted, true);
  for (const id of [thread.id, message.id]) assert.equal((await f.send({ action: 'read', id })).status, 404);
  assert.deepEqual((await f.ok({ action: 'list', kind: 'thread' })).records, []);
  const messages = await f.send({ action: 'list', kind: 'message', threadId: thread.id });
  assert.equal(messages.status, 404);
  const changes = await f.send({ action: 'changes' });
  assert.equal(changes.status, 200);
  assert.ok(changes.json.events.some(event => event.id === thread.id && event.deleted));
  for (const event of changes.json.events) {
    assert.deepEqual(Object.keys(event).sort(), ['deleted', 'id', 'kind', 'sequence', 'threadId', 'version']);
  }
  assert.deepEqual(await f.ok(threadInput, { proof: A2 }), thread);
  assert.deepEqual(await f.ok(messageInput, { proof: A2 }), message);
  assert.deepEqual(await f.ok(removal), removed);
  assert.equal((await f.send({ action: 'read', id: message.id })).status, 404);
  assert.equal((await f.send(create('after-deletion-message', 'message', { text }, { threadId: thread.id }))).status, 404);
  for (const result of [removed, updated, changes.json, messages.json]) {
    assert.ok(!JSON.stringify(result).includes(title));
    assert.ok(!JSON.stringify(result).includes(text));
  }
});

test('exact schemas reject client-selected authority and leave runtime/tool routes unavailable', async t => {
  const f = await fixture(t);
  const invalid = [null, [], {}, { action: 'unknown' }, { action: 'changes', companionId: 'forged' },
    { action: 'list', kind: 'thread', owner: 'forged' }, { action: 'read', id: 'forged', subject: PA.subject },
    create('bad-runtime', 'runtime', {}), create('bad-credentials', 'credentials', {}),
    create('extra-runtime', 'thread', {}, { runtimeId: 'forged' }),
    { ...create('extra-owner', 'thread', {}), ownerId: 'forged' }];
  for (const payload of invalid) {
    const result = await f.send(payload);
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, 'PRIVATE_STATE_INVALID_REQUEST');
    assert.deepEqual(Object.keys(result.json), ['error']);
  }
  assert.deepEqual((await f.ok({ action: 'changes' })).events, []);
  await f.ok(create('passive-work', 'work', { instruction: 'synthetic data only; do not execute' }));
  await f.ok(create('passive-watch', 'watch', { source: 'https://synthetic.invalid/release' }));
  for (const path of ['/api/runtime/register', '/api/runtime/start', '/api/tools/execute', '/api/private/export']) {
    assert.ok([404, 405].includes((await f.send({}, { path })).status));
  }
  const status = await f.send(undefined, { path: '/api/status', method: 'GET', body: undefined });
  assert.equal(status.json.adapters.provider.state, 'unavailable');
  assert.equal(status.json.adapters.runtime.state, 'unavailable');
});

test('private transport rejects malformed/oversized bodies, cross-origin requests and duplicate cookies', async t => {
  const f = await fixture(t);
  const payload = { action: 'changes' };
  for (const body of ['', 'not JSON', 'null', '[]', Buffer.from([0xff])]) {
    assert.equal((await f.send(payload, { body })).status, 400);
  }
  assert.equal((await f.send(payload, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.send(payload, { body: JSON.stringify({ padding: 'x'.repeat(65537) }) })).status, 413);
  assert.equal((await f.send(create('oversized-value', 'memory', { text: 'x'.repeat(17 * 1024) }))).status, 400);
  assert.equal((await f.send(payload, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.send(payload, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.send(payload, { cookie: COOKIE(A1) + '; ' + COOKIE(B) })).status, 401);
  const origin = f.app.url;
  const base = ['Origin', origin, 'Content-Type', 'application/json'];
  assert.equal((await f.send(payload, { rawHeaders: [...base, 'Cookie', COOKIE(A1), 'Cookie', COOKIE(B)] })).status, 401);
  assert.equal((await f.send(payload, { rawHeaders: [...base, 'Origin', origin, 'Cookie', COOKIE(A1)] })).status, 403);
  assert.deepEqual((await f.ok(payload)).events, []);
});

test('default/demo modes cannot expose retained private state or enable it through headers and queries', async t => {
  const f = await fixture(t);
  const thread = await f.ok(create('closed-mode-thread', 'thread', { title: 'synthetic retained private marker' }));
  await f.app.close();
  const before = f.validations.length;
  for (const mode of ['unavailable', 'demo']) {
    await f.open(mode);
    const result = await f.send({ action: 'read', id: thread.id }, { headers: { 'X-Mode': 'account' } });
    assert.ok([404, 405].includes(result.status));
    assert.ok(!result.text.includes('synthetic retained private marker'));
    assert.ok([404, 405].includes((await f.send({ action: 'read', id: thread.id }, { path: '/api/private/state?mode=account' })).status));
    await f.app.close();
  }
  assert.equal(f.validations.length, before, 'Closed modes never call the account validator');
});
