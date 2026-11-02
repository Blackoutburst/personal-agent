import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { ConversationDemo } from '../src/conversation-demo.mjs';
import { ConversationError, createConversationClient, createConversationTransport } from '../public/conversation-client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const clone = value => structuredClone(value);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-client-synthetic-')), stores = new Set(), calls = [];
  const f = { calls, openStore() { const store = new BootstrapStore(dir, ROOT); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); }, intercept: null };
  f.store = f.openStore(); f.demo = new ConversationDemo(f.store);
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  f.transport = async (action, payload, options) => {
    calls.push({ action, payload: clone(payload), signal: options.signal });
    const normal = () => clone(f.demo.handle({ action, ...payload }));
    return f.intercept ? f.intercept(action, payload, options, normal) : normal();
  };
  f.client = createConversationClient({ transport: f.transport });
  f.thread = title => f.demo.handle({ action: 'createThread', requestId: randomUUID(), title }).thread;
  return f;
}
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function ready(f, title = 'Synthetic thread') { await f.client.open(); await f.client.create(title); return f.client.getState().threadId; }
async function denied(run, code) { await assert.rejects(run, error => error instanceof ConversationError && error.code === code); }

test('explicit synthetic conversation streams accumulated text without advancing the cursor from submit ACK', async t => {
  const f = fixture(t);
  assert.equal(f.client.getState().connection, 'disconnected'); assert.equal(f.calls.length, 0);
  await f.client.open();
  assert.equal(f.client.getState().synthetic, true); assert.equal(f.client.getState().threadId, null);
  await f.client.create('Synthetic thread'); f.client.setDraft('  Exact text retained  ');
  await f.client.send();
  let state = f.client.getState();
  assert.equal(state.cursor, '0'); assert.equal(state.pending.status, 'accepted'); assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text, '  Exact text retained  '); assert.equal(state.draft, '');
  await f.client.poll(); state = f.client.getState();
  assert.equal(state.cursor, '3'); assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].text, 'Synthetic reply.'); assert.equal(state.turn.state, 'streaming');
  await f.client.poll(); state = f.client.getState();
  assert.equal(state.cursor, '5'); assert.equal(state.messages.length, 2); assert.equal(state.pending, null);
  assert.equal(state.turn.state, 'complete'); assert.equal(state.hasMore, false);
  assert.equal(state.messages[1].text, 'Synthetic reply. No AI, tool, permission or external action was used.');
  await f.client.poll(); assert.equal(f.client.getState().cursor, '5');
});

test('replayed older event pages cannot duplicate messages or replace full text with a partial', async t => {
  const f = fixture(t), threadId = await ready(f); await f.client.send('test');
  const old = clone(f.demo.handle({ action: 'events', threadId, cursor: '0' }));
  await f.client.poll(); await f.client.poll();
  const complete = f.client.getState();
  f.intercept = action => { assert.equal(action, 'events'); return old; };
  await f.client.poll();
  assert.deepEqual(f.client.getState().messages, complete.messages);
  assert.equal(f.client.getState().cursor, '5'); assert.equal(f.client.getState().turn.state, 'complete');
});

test('failed-after-commit submit retains exactly one request ID and exact text until explicit retry', async t => {
  const f = fixture(t); await ready(f);
  let fail = true;
  f.intercept = (action, payload, options, normal) => {
    const result = normal();
    if (action === 'submit' && fail) { fail = false; throw new Error('private-transport-canary'); }
    return result;
  };
  await f.client.send('  same exact text  ');
  const pending = f.client.getState().pending;
  assert.equal(pending.status, 'uncertain'); assert.equal(f.client.getState().error, 'NETWORK_ERROR');
  assert.equal(f.client.getState().cursor, '0');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.action === 'submit').length, 1, 'No automatic retry');
  await f.client.retry();
  const writes = f.calls.filter(call => call.action === 'submit');
  assert.deepEqual(writes[0].payload, writes[1].payload);
  assert.equal(writes[1].payload.requestId, pending.requestId); assert.equal(writes[1].payload.text, '  same exact text  ');
  assert.equal(f.demo.handle({ action: 'snapshot' }).messages.length, 2);
  await f.client.poll(); await f.client.poll(); assert.equal(f.client.getState().messages.length, 2);
  assert.ok(!JSON.stringify(f.client.getState()).includes('private-transport-canary'));
});

test('uncertain thread creation retries its original title and ID without creating a duplicate', async t => {
  const f = fixture(t); await f.client.open(); let fail = true;
  f.intercept = (action, payload, options, normal) => { const result = normal();
    if (action === 'createThread' && fail) { fail = false; throw new Error('lost acknowledgement'); } return result; };
  await f.client.create('  Exact title  ');
  assert.equal(f.client.getState().pending.action, 'createThread'); assert.equal(f.client.getState().pending.status, 'uncertain');
  await f.client.retry();
  const writes = f.calls.filter(call => call.action === 'createThread');
  assert.deepEqual(writes[0].payload, writes[1].payload);
  assert.equal(f.client.getState().threads.length, 1); assert.equal(f.client.getState().threads[0].title, '  Exact title  ');
  assert.equal(f.client.getState().pending, null); assert.equal(f.client.getState().connection, 'ready');
});

test('fresh clients and database restart resume committed synthetic history without drafts or automatic submissions', async t => {
  const f = fixture(t), threadId = await ready(f); await f.client.send('persisted synthetic input');
  const second = createConversationClient({ transport: f.transport }); await second.open({ threadId });
  assert.equal(second.getState().messages.length, 2); assert.equal(second.getState().cursor, '5');
  f.client.setDraft('memory-only draft'); f.client.disconnect(); f.close(f.store);
  f.store = f.openStore(); f.demo = new ConversationDemo(f.store);
  const restarted = createConversationClient({ transport: f.transport }); await restarted.open({ threadId });
  assert.equal(restarted.getState().messages.length, 2); assert.equal(restarted.getState().draft, ''); assert.equal(restarted.getState().pending, null);
  assert.equal(f.calls.filter(call => call.action === 'submit').length, 1);
});

test('event gaps and wrong-thread pages trigger only a fresh selected-thread snapshot', async t => {
  for (const corrupt of ['gap', 'thread']) {
    const f = fixture(t), threadId = await ready(f); await f.client.send('committed'); let once = true;
    f.intercept = (action, payload, options, normal) => {
      const result = normal();
      if (action === 'events' && once) { once = false;
        if (corrupt === 'gap') result.events.shift(); else result.threadId = randomUUID();
      }
      return result;
    };
    await f.client.poll();
    assert.equal(f.client.getState().threadId, threadId); assert.equal(f.client.getState().cursor, '5');
    assert.equal(f.client.getState().messages.length, 2); assert.equal(f.client.getState().pending, null);
    assert.equal(f.calls.at(-1).action, 'snapshot'); assert.equal(f.calls.at(-1).payload.threadId, threadId);
    assert.equal(f.calls.filter(call => call.action === 'submit').length, 1);
  }
});

test('clear aborts a pending snapshot and late callbacks cannot restore private display', async t => {
  const f = fixture(t); f.thread('Synthetic private title'); const wait = deferred(); let signal;
  f.intercept = (action, payload, options, normal) => { signal = options.signal; const result = normal(); return wait.promise.then(() => result); };
  const opening = f.client.open(); f.client.setDraft('private draft');
  f.client.clear(); assert.ok(signal.aborted); wait.resolve(); await opening;
  assert.deepEqual(f.client.getState(), { opened: false, synthetic: false, runtime: null, threads: [], threadId: null, messages: [], cursor: null,
    lastSeq: 0, hasMore: false, turn: null, connection: 'disconnected', pending: null, draft: '', error: null });
  assert.equal(f.calls.length, 1);
});

test('thread switching fences old event and submission callbacks even if transport ignores abort', async t => {
  const f = fixture(t), a = f.thread('A'), b = f.thread('B'); await f.client.open({ threadId: a.id });
  const wait = deferred(); let oldSignal;
  f.intercept = (action, payload, options, normal) => {
    const result = normal(); if (action === 'submit') { oldSignal = options.signal; return wait.promise.then(() => result); } return result;
  };
  const sending = f.client.send('A private text'); await f.client.select(b.id);
  assert.ok(oldSignal.aborted); wait.resolve(); await sending;
  assert.equal(f.client.getState().threadId, b.id); assert.deepEqual(f.client.getState().messages, []); assert.equal(f.client.getState().pending, null);
  await f.client.select(a.id);
  const pageWait = deferred();
  f.intercept = (action, payload, options, normal) => { const result = normal(); return action === 'events' ? pageWait.promise.then(() => result) : result; };
  const polling = f.client.poll(); await f.client.select(b.id); pageWait.resolve(); await polling;
  assert.equal(f.client.getState().threadId, b.id); assert.deepEqual(f.client.getState().messages, []);
});

test('401/403 denial wipes state and invalidates another pending same-epoch callback', async t => {
  for (const status of [401, 403]) {
    const f = fixture(t); await ready(f); f.client.setDraft('private draft'); const wait = deferred();
    f.intercept = (action, payload, options, normal) => {
      if (action === 'events') throw new ConversationError('ACCESS_DENIED', status);
      const result = normal(); return action === 'submit' ? wait.promise.then(() => result) : result;
    };
    const sending = f.client.send('private draft'); await f.client.poll(); wait.resolve(); await sending;
    const state = f.client.getState();
    assert.equal(state.connection, 'denied'); assert.equal(state.error, 'ACCESS_DENIED'); assert.equal(state.synthetic, false);
    assert.deepEqual(state.messages, []); assert.deepEqual(state.threads, []); assert.equal(state.draft, ''); assert.equal(state.pending, null);
  }
});

test('completed events beat a late failed submit ACK and polling failure does not make an accepted write uncertain', async t => {
  const f = fixture(t); await ready(f); const wait = deferred();
  f.intercept = (action, payload, options, normal) => { const result = normal(); return action === 'submit' ? wait.promise.then(() => result) : result; };
  f.client.setDraft('confirmed by events'); const sending = f.client.send();
  await f.client.poll(); await f.client.poll(); wait.reject(new Error('late lost acknowledgement')); await sending;
  assert.equal(f.client.getState().pending, null); assert.equal(f.client.getState().error, null); assert.equal(f.client.getState().draft, '');
  f.intercept = null; await f.client.send('second');
  f.intercept = action => { assert.equal(action, 'events'); throw new Error('temporary poll failure'); };
  await f.client.poll(); assert.equal(f.client.getState().pending.status, 'accepted');
  await denied(() => f.client.retry(), 'NOT_READY');
  assert.equal(f.calls.filter(call => call.action === 'submit').length, 2);
});

test('same-epoch 401/403 after completed events still clears every private display field', async t => {
  for (const status of [401, 403]) {
    const f = fixture(t); await ready(f); const wait = deferred();
    f.intercept = (action, payload, options, normal) => { const result = normal();
      return action === 'submit' ? wait.promise.then(() => result) : result; };
    f.client.setDraft('completed private text'); const sending = f.client.send();
    await f.client.poll(); await f.client.poll();
    assert.equal(f.client.getState().pending, null); assert.equal(f.client.getState().messages.length, 2);
    f.client.setDraft('another private draft');
    wait.reject(new ConversationError('ACCESS_DENIED', status)); await sending;
    assert.deepEqual(f.client.getState(), { opened: false, synthetic: false, runtime: null, threads: [], threadId: null, messages: [], cursor: null,
      lastSeq: 0, hasMore: false, turn: null, connection: 'denied', pending: null, draft: '', error: 'ACCESS_DENIED' });
  }
});

test('malformed markers, roles, unsafe arrays and unexpected owner data never enter subscribed state', async t => {
  const f = fixture(t), selected = f.thread('Synthetic');
  f.demo.handle({ action: 'submit', requestId: 'seed', threadId: selected.id, text: 'synthetic' });
  const good = f.demo.handle({ action: 'snapshot', threadId: selected.id }); let getters = 0;
  const variants = [value => { value.synthetic = false; }, value => { value.version = 2; },
    value => { value.runtime.state = 'connected'; }, value => { value.owner = 'foreign'; },
    value => { value.messages[0].role = 'system'; }, value => { value.messages[0].threadId = randomUUID(); },
    value => { value.threads.push(clone(value.threads[0])); },
    value => { Object.defineProperty(value.messages, '0', { enumerable: true, get() { getters++; return good.messages[0]; } }); }];
  for (const mutate of variants) {
    const bad = clone(good); mutate(bad);
    const client = createConversationClient({ transport: async () => bad }); await client.open({ threadId: selected.id });
    assert.equal(client.getState().synthetic, false); assert.equal(client.getState().connection, 'unavailable');
    assert.deepEqual(client.getState().messages, []); assert.deepEqual(client.getState().threads, []);
    assert.equal(client.getState().error, 'INVALID_RESPONSE');
  }
  assert.equal(getters, 0);
});

test('malformed ACK and event payloads fail closed without partial page application', async t => {
  const f = fixture(t); await ready(f);
  f.intercept = (action, payload, options, normal) => { const value = normal(); if (action === 'submit') value.accepted.threadId = randomUUID(); return value; };
  await f.client.send('test'); assert.equal(f.client.getState().connection, 'unavailable'); assert.deepEqual(f.client.getState().messages, []);
  f.intercept = null; await f.client.open();
  f.intercept = (action, payload, options, normal) => {
    if (action !== 'events') return normal();
    const value = normal(); value.events = [{ seq: 6, threadId: payload.threadId, type: 'message',
      message: { id: randomUUID(), threadId: payload.threadId, role: 'user', text: 'never apply' } },
    { seq: 7, threadId: payload.threadId, type: 'message', message: { id: randomUUID(), threadId: payload.threadId, role: 'system', text: 'invalid' } }];
    value.cursor = '7'; value.lastSeq = 7; value.hasMore = false; return value;
  };
  await f.client.poll(); assert.deepEqual(f.client.getState().messages, []); assert.equal(f.client.getState().error, 'INVALID_RESPONSE');
});

test('subscribers receive independent copies and drafts stay bounded and in memory only', async t => {
  const f = fixture(t); let calls = 0;
  const unsubscribe = f.client.subscribe(state => { calls++; state.threads.push({ id: 'untrusted', title: 'mutation' }); });
  assert.equal(f.client.getState().threads.length, 0); await ready(f);
  const copy = f.client.getState(); copy.messages.push({ text: 'injected' }); assert.equal(f.client.getState().messages.length, 0);
  f.client.setDraft('memory-only');
  for (const bad of ['x'.repeat(8001), '\ud800', '\u0000']) assert.throws(() => f.client.setDraft(bad), error => error.code === 'INVALID_REQUEST');
  await denied(() => f.client.send(' '.repeat(3)), 'INVALID_REQUEST');
  await denied(() => f.client.send('x'.repeat(8001)), 'INVALID_REQUEST');
  const before = calls; unsubscribe(); f.client.clear(); assert.equal(calls, before); assert.equal(f.client.getState().draft, '');
  assert.equal(f.calls.filter(call => call.action === 'submit').length, 0);
});

test('transport uses only the fixed same-origin route and never reflects server error strings', async () => {
  const calls = [], transport = createConversationTransport({ fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response('{"version":1,"synthetic":true}', { headers: { 'content-type': 'application/json' } });
  } });
  await transport('snapshot', {});
  assert.equal(calls[0].url, 'api/conversation');
  assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.mode, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'snapshot' });
  await denied(() => transport('snapshot', { runtimeId: 'foreign' }), 'INVALID_REQUEST'); assert.equal(calls.length, 1);
  for (const status of [401, 403, 503]) {
    const rejected = createConversationTransport({ fetchImpl: async () => new Response('private-server-error-canary', { status }) });
    await assert.rejects(() => rejected('snapshot', {}), error => error.code === (status === 503 ? 'UNAVAILABLE' : 'ACCESS_DENIED') && !String(error).includes('canary'));
  }
});

test('transport rejects oversized, malformed and redirected responses and propagates cancellation safely', async () => {
  const variants = [
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '16777217' } }),
    () => new Response('x'.repeat(16777217), { headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    () => new Response('not-json', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => ({ ok: true, status: 200, redirected: true, headers: new Headers({ 'content-type': 'application/json' }) })
  ];
  for (const response of variants) await denied(() => createConversationTransport({ fetchImpl: async () => response() })('snapshot', {}), 'INVALID_RESPONSE');
  const controller = new AbortController(); let internal;
  const transport = createConversationTransport({ fetchImpl: (url, options) => new Promise((resolve, reject) => {
    internal = options.signal; internal.addEventListener('abort', () => reject(new Error('private-abort-detail')), { once: true });
  }) });
  const pending = transport('snapshot', {}, { signal: controller.signal }); controller.abort();
  await denied(() => pending, 'NETWORK_ERROR'); assert.ok(internal.aborted);
});
