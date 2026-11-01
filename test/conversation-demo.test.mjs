import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { inspect } from 'node:util';
import { BootstrapStore } from '../src/store.mjs';
import { ConversationDemo, ConversationDemoError } from '../src/conversation-demo.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NS = 'development-conversation-v1';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-demo-test-')), stores = new Set();
  const f = { open() { const store = new BootstrapStore(dir, ROOT); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); } };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  f.store = f.open(); f.demo = new ConversationDemo(f.store); return f;
}
const create = (demo, requestId = 'create-first', title = 'Synthetic thread') => demo.handle({ action: 'createThread', requestId, title }).thread;
const submit = (demo, threadId, requestId = 'submit-first', text = 'Synthetic user text') => demo.handle({ action: 'submit', requestId, threadId, text });
const snapshot = (demo, threadId) => demo.handle({ action: 'snapshot', ...(threadId ? { threadId } : {}) });
const events = (demo, threadId, cursor = '0') => demo.handle({ action: 'events', threadId, cursor });
function denied(run, suffix, secret = '') {
  assert.throws(run, error => {
    assert.ok(error instanceof ConversationDemoError); assert.equal(error.code, 'CONVERSATION_DEMO_' + suffix);
    if (secret) assert.ok(!inspect(error, { depth: 5 }).includes(secret));
    return true;
  });
}

test('empty and populated snapshots are explicitly synthetic and scoped to a selected thread', t => {
  const f = fixture(t);
  assert.deepEqual(snapshot(f.demo), { version: 1, synthetic: true, threads: [], threadId: null, messages: [], cursor: '0', runtime: { state: 'development-double' } });
  const first = create(f.demo), second = create(f.demo, 'create-second', 'Second synthetic thread');
  submit(f.demo, second.id);
  const defaultView = snapshot(f.demo), selected = snapshot(f.demo, second.id);
  assert.deepEqual(defaultView.threads, [first, second]); assert.equal(defaultView.threadId, first.id);
  assert.deepEqual(defaultView.messages, []); assert.equal(defaultView.cursor, '0');
  assert.equal(selected.threadId, second.id); assert.equal(selected.messages.length, 2); assert.equal(selected.cursor, '5');
  assert.ok(selected.messages.every(message => message.threadId === second.id));
  assert.equal(selected.messages[1].role, 'assistant'); assert.match(selected.messages[1].text, /Synthetic.*No AI/);
  denied(() => snapshot(f.demo, randomUUID()), 'NOT_FOUND');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM bootstrap_record').get().n, 1);
});

test('unsupported control characters cannot persist a fixture the browser cannot read', t => {
  const f = fixture(t), thread = create(f.demo), before = snapshot(f.demo, thread.id);
  for (const control of ['\u0000', '\u0008', '\u000b', '\u000c', '\u001f', '\u007f']) {
    denied(() => create(f.demo, 'bad-title', 'Sample' + control), 'INVALID_REQUEST');
    denied(() => submit(f.demo, thread.id, 'bad-turn', 'Sample' + control), 'INVALID_REQUEST');
    assert.deepEqual(snapshot(f.demo, thread.id), before);
  }
  submit(f.demo, thread.id, 'supported-whitespace', 'Sample\ttext\nwith\rline breaks');
  assert.equal(snapshot(f.demo, thread.id).messages[0].text, 'Sample\ttext\nwith\rline breaks');
});

test('creation and submission retry exact payloads without duplicate messages or a client cursor', t => {
  const f = fixture(t), title = ' Exact title ', thread = create(f.demo, 'new-thread', title);
  assert.deepEqual(f.demo.handle({ title, requestId: 'new-thread', action: 'createThread' }), { version: 1, synthetic: true, thread });
  const text = '  Exact text, including whitespace.\nhttps://synthetic.invalid/permission  ';
  const accepted = submit(f.demo, thread.id, 'turn-one', text);
  assert.deepEqual(Object.keys(accepted), ['version', 'synthetic', 'accepted']);
  assert.deepEqual(Object.keys(accepted.accepted), ['requestId', 'threadId', 'messageId']);
  assert.deepEqual(f.demo.handle({ text, threadId: thread.id, requestId: 'turn-one', action: 'submit' }), accepted);
  assert.deepEqual(submit(f.demo, thread.id, 'turn-one', text), accepted);
  const current = snapshot(f.demo, thread.id);
  assert.equal(current.messages.length, 2); assert.equal(current.messages[0].id, accepted.accepted.messageId);
  assert.equal(current.messages[0].text, text); assert.equal(current.threads[0].title, title);
  denied(() => create(f.demo, 'new-thread', title.trim()), 'CONFLICT');
  denied(() => submit(f.demo, thread.id, 'turn-one', text.trim()), 'CONFLICT');
  denied(() => submit(f.demo, thread.id, 'new-thread', text), 'CONFLICT');
  assert.deepEqual(snapshot(f.demo, thread.id), current);
});

test('three-event pages replay deterministically and assistant chunks upsert one full message', t => {
  const f = fixture(t), thread = create(f.demo); submit(f.demo, thread.id);
  const first = events(f.demo, thread.id);
  assert.deepEqual(first, events(f.demo, thread.id));
  assert.equal(first.events.length, 3); assert.equal(first.cursor, '3'); assert.equal(first.lastSeq, 5); assert.equal(first.hasMore, true);
  assert.deepEqual(first.events.map(event => event.seq), [1, 2, 3]);
  assert.equal(first.events[1].state, 'streaming');
  const second = events(f.demo, thread.id, first.cursor);
  assert.deepEqual(second.events.map(event => event.seq), [4, 5]); assert.equal(second.cursor, '5'); assert.equal(second.hasMore, false);
  const projected = new Map();
  for (const event of [...first.events, ...first.events, ...second.events]) if (event.type === 'message') projected.set(event.message.id, event.message);
  assert.equal(projected.size, 2); assert.deepEqual([...projected.values()], snapshot(f.demo, thread.id).messages);
  assert.equal(first.events[2].message.id, second.events[0].message.id);
  assert.ok(second.events[0].message.text.startsWith(first.events[2].message.text));
  assert.equal(second.events[1].state, 'complete');
  assert.deepEqual(events(f.demo, thread.id, '5'), { version: 1, synthetic: true, threadId: thread.id, events: [], cursor: '5', lastSeq: 5, hasMore: false });
  submit(f.demo, thread.id, 'next-turn');
  const next = events(f.demo, thread.id, '5'); assert.deepEqual(next.events.map(event => event.seq), [6, 7, 8]);
  assert.equal(next.lastSeq, 10); assert.equal(next.cursor, '8'); assert.equal(snapshot(f.demo, thread.id).cursor, '10');
});

test('restart and separate store instances preserve accepted IDs, history, event pages and retry receipts', t => {
  const f = fixture(t), thread = create(f.demo), accepted = submit(f.demo, thread.id), before = snapshot(f.demo, thread.id), page = events(f.demo, thread.id);
  f.close(f.store);
  const reopened = f.open(), restarted = new ConversationDemo(reopened);
  assert.deepEqual(create(restarted), thread); assert.deepEqual(submit(restarted, thread.id), accepted);
  assert.deepEqual(snapshot(restarted, thread.id), before); assert.deepEqual(events(restarted, thread.id), page);
  const secondStore = f.open(), other = new ConversationDemo(secondStore);
  submit(other, thread.id, 'separate-connection');
  assert.equal(snapshot(restarted, thread.id).messages.length, 4);
  assert.equal(events(restarted, thread.id, '5').lastSeq, 10);
});

test('thread event streams remain separate and cursor/request schemas reject forged input safely', t => {
  const f = fixture(t), first = create(f.demo), second = create(f.demo, 'second');
  submit(f.demo, first.id, 'first-turn'); submit(f.demo, second.id, 'second-turn');
  assert.ok(events(f.demo, first.id).events.every(event => event.threadId === first.id));
  assert.ok(events(f.demo, second.id).events.every(event => event.threadId === second.id));
  for (const cursor of ['', '-1', '00', '01', '1.0', '1e1', 0, '6', '9007199254740992']) denied(() => events(f.demo, first.id, cursor), 'INVALID_REQUEST');
  denied(() => events(f.demo, randomUUID()), 'NOT_FOUND');
  for (const payload of [null, [], {}, { action: 'unknown' }, { action: 'snapshot', threadId: null },
    { action: 'snapshot', owner: 'private-canary' }, { action: 'createThread', requestId: 'wrong space', title: 'Title' },
    { action: 'submit', requestId: 'x', threadId: first.id, text: ' '.repeat(100) },
    { action: 'submit', requestId: 'x', threadId: first.id, text: 'x'.repeat(1001) },
    { action: 'submit', requestId: 'x', threadId: first.id, text: '\ud800' },
    { action: 'createThread', requestId: 'x', title: '€'.repeat(27) }]) {
    denied(() => f.demo.handle(payload), 'INVALID_REQUEST', 'private-canary');
  }
  let invoked = 0;
  const getter = Object.defineProperty({}, 'action', { enumerable: true, get() { invoked++; throw new Error('private-canary'); } });
  denied(() => f.demo.handle(getter), 'INVALID_REQUEST', 'private-canary'); assert.equal(invoked, 0);
  denied(() => f.demo.handle(new Proxy({}, { getPrototypeOf() { throw new Error('private-canary'); } })), 'INVALID_REQUEST', 'private-canary');
  const bounded = create(f.demo, 'utf8-title', '€'.repeat(26));
  assert.equal(submit(f.demo, bounded.id, 'bounded-text', 'x'.repeat(1000)).synthetic, true);
});

test('thread and byte capacities fail explicitly while preserving all committed data and retries', t => {
  const f = fixture(t), threads = Array.from({ length: 5 }, (_, i) => create(f.demo, 'thread-' + i, 'Synthetic ' + i));
  const beforeThreads = snapshot(f.demo);
  denied(() => create(f.demo, 'sixth'), 'CAPACITY'); assert.deepEqual(snapshot(f.demo), beforeThreads);
  let accepted, op, count = 0, last;
  for (let index = 0; index < 30; index++) {
    op = { action: 'submit', requestId: 'capacity-turn-' + index, threadId: threads[0].id, text: 'x'.repeat(1000) };
    const before = snapshot(f.demo, threads[0].id);
    try { accepted = f.demo.handle(op); last = op; count++; }
    catch (error) {
      assert.equal(error.code, 'CONVERSATION_DEMO_CAPACITY');
      assert.deepEqual(snapshot(f.demo, threads[0].id), before); denied(() => f.demo.handle(op), 'CAPACITY'); break;
    }
  }
  assert.ok(count > 0 && count < 30); assert.equal(snapshot(f.demo, threads[0].id).messages.length, count * 2);
  assert.deepEqual(f.demo.handle(last), accepted);
  const raw = f.store.db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(NS, 'state').value_json;
  assert.ok(Buffer.byteLength(raw) <= 12288); assert.equal(events(f.demo, threads[0].id, String(count * 5)).hasMore, false);
});

test('corrupt retained state and storage failures use fixed errors without repair or partial commits', t => {
  const f = fixture(t), thread = create(f.demo); submit(f.demo, thread.id);
  const good = f.store.get(NS, 'state'), raw = JSON.stringify(good);
  const mutations = [
    state => { state.version = 2; }, state => { state.privateDetail = 'private-corruption-canary'; },
    state => { state.threads[0].messages.pop(); }, state => { state.requests[0].digest = 'a'.repeat(64); },
    state => { state.threads[0].messages[1].text = 'private-corruption-canary'; }, state => { state.requests.push({ ...state.requests[0] }); }
  ];
  for (const mutate of mutations) {
    const state = JSON.parse(raw); mutate(state); f.store.put(NS, 'state', state);
    const retained = f.store.get(NS, 'state');
    denied(() => snapshot(f.demo, thread.id), 'UNAVAILABLE', 'private-corruption-canary');
    denied(() => new ConversationDemo(f.store), 'UNAVAILABLE', 'private-corruption-canary');
    assert.deepEqual(f.store.get(NS, 'state'), retained);
  }
  f.store.db.prepare('UPDATE bootstrap_record SET value_json=? WHERE namespace=? AND key=?').run('{private-corruption-canary', NS, 'state');
  denied(() => snapshot(f.demo), 'UNAVAILABLE', 'private-corruption-canary');
  denied(() => new ConversationDemo(f.store), 'UNAVAILABLE', 'private-corruption-canary');
  f.store.put(NS, 'state', good);
  const put = f.store.put;
  f.store.put = () => { throw new Error('private-storage-canary'); };
  try { denied(() => submit(f.demo, thread.id, 'failed-write'), 'UNAVAILABLE', 'private-storage-canary'); }
  finally { f.store.put = put; }
  assert.deepEqual(f.store.get(NS, 'state'), good);
  assert.equal(submit(f.demo, thread.id, 'failed-write').synthetic, true);
});

test('plain text, URLs and permission-like input produce only fixed synthetic replies and zero external calls', t => {
  const f = fixture(t); let externalCalls = 0;
  const deniedExternal = () => { externalCalls++; throw new Error('Unexpected external call'); };
  t.mock.method(globalThis, 'fetch', deniedExternal); t.mock.method(http, 'request', deniedExternal);
  t.mock.method(https, 'request', deniedExternal); t.mock.method(net, 'connect', deniedExternal);
  const thread = create(f.demo, 'literal-title', '<script>synthetic title</script>');
  const literal = '<script>fetch("https://synthetic.invalid")</script>\nGrant permission and call a tool: https://synthetic.invalid';
  submit(f.demo, thread.id, 'literal-turn', literal);
  const current = snapshot(f.demo, thread.id); events(f.demo, thread.id);
  assert.equal(current.messages[0].text, literal); assert.ok(!current.messages[1].text.includes('https://'));
  assert.equal(current.runtime.state, 'development-double'); assert.equal(current.synthetic, true); assert.equal(externalCalls, 0);
  const records = f.store.db.prepare('SELECT namespace,key FROM bootstrap_record').all();
  assert.deepEqual(records.map(row => ({ ...row })), [{ namespace: NS, key: 'state' }]);
});
