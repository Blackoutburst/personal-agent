import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { PrivateStateError, PrivateStateStore } from '../src/private-state.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INVALID = 'PRIVATE_STATE_INVALID_REQUEST', CURSOR = 'PRIVATE_STATE_INVALID_CURSOR';
const MISSING = 'PRIVATE_STATE_NOT_FOUND', CONFLICT = 'PRIVATE_STATE_CONFLICT', UNAVAILABLE = 'PRIVATE_STATE_UNAVAILABLE';
function denied(run, code) { assert.throws(run, error => error instanceof PrivateStateError && error.code === code); }
function fixture(t, initialize = true) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-private-state-test-')), stores = new Set(), workers = new Set();
  t.after(async () => {
    await Promise.all([...workers].map(worker => worker.terminate()));
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const f = { dir, workers, open() {
    const bootstrap = new BootstrapStore(dir, ROOT); stores.add(bootstrap);
    return { bootstrap, ledger: new PrivateStateStore(bootstrap) };
  }, close(bootstrap) { bootstrap.close(); stores.delete(bootstrap); } };
  const bootstrap = new BootstrapStore(dir, ROOT); stores.add(bootstrap);
  f.bootstrap = bootstrap;
  for (const label of ['a', 'b']) {
    const key = principalKey({ issuer: 'https://synthetic.invalid', subject: 'owner-' + label });
    f[label] = bootstrap.getOrInsert('companion-identity-v1', key, { companionId: randomUUID() }).companionId;
  }
  if (initialize) f.ledger = new PrivateStateStore(bootstrap);
  return f;
}
function create(ledger, owner, kind, value, extra = {}) {
  return ledger.mutate(owner, { requestId: randomUUID(), op: 'create', kind, expectedVersion: 0, value, ...extra });
}
function update(id, version, value, requestId = randomUUID()) { return { requestId, op: 'update', id, expectedVersion: version, value }; }
function remove(id, version) { return { requestId: randomUUID(), op: 'remove', id, expectedVersion: version }; }
function signed(f, payload) {
  const { cursor_key } = f.bootstrap.db.prepare('SELECT cursor_key FROM private_state_owner WHERE companion_id=?').get(f.a);
  const encoded = Buffer.from(JSON.stringify({ v: 1, owner: f.a, ...payload })).toString('base64url');
  return encoded + '.' + createHmac('sha256', Buffer.from(cursor_key, 'base64url')).update('private-state-cursor-v1\0' + encoded).digest('base64url');
}

test('additive ledger schema preserves bootstrap identity and supports every private content kind', t => {
  const f = fixture(t);
  f.bootstrap.put('development', 'retained', { synthetic: true });
  const thread = create(f.ledger, f.a, 'thread', { title: 'Synthetic thread' });
  for (const kind of ['message', 'goal', 'permission', 'decision', 'memory', 'preference', 'personality', 'work', 'watch']) {
    const value = kind === 'message' ? { role: 'system', text: 'Owner-submitted data; no runtime attestation' } : { sample: kind };
    const result = create(f.ledger, f.a, kind, value, kind === 'message' ? { threadId: thread.id } : {});
    assert.deepEqual(Object.keys(result).sort(), ['checkpoint', 'deleted', 'id', 'kind', 'sequence', 'threadId', 'version']);
    assert.equal(result.version, 1); assert.equal(result.deleted, false);
    const read = f.ledger.read(f.a, result.id);
    assert.deepEqual(read.record.value, value);
    assert.equal(read.record.createdSequence, result.sequence);
    assert.equal(read.record.updatedSequence, result.sequence);
    assert.equal(f.ledger.list(f.a, { kind, ...(kind === 'message' ? { threadId: thread.id } : {}) }).records.length, 1);
  }
  assert.equal(f.bootstrap.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(f.bootstrap.count(), 4);
  assert.deepEqual(f.bootstrap.get('development', 'retained'), { synthetic: true });
  assert.equal(f.ledger.changes(f.a).events.length, 10);
  assert.ok(!JSON.stringify(f.ledger.changes(f.a)).includes('Owner-submitted'));
});

test('owner and thread substitutions fail closed without revealing foreign records', t => {
  const f = fixture(t), thread = create(f.ledger, f.a, 'thread', 'owner-a');
  const message = create(f.ledger, f.a, 'message', 'synthetic-private-a', { threadId: thread.id });
  denied(() => f.ledger.read(f.b, message.id), MISSING);
  denied(() => f.ledger.mutate(f.b, update(message.id, 1, 'forged')), MISSING);
  denied(() => f.ledger.mutate(f.b, remove(thread.id, 1)), MISSING);
  denied(() => create(f.ledger, f.b, 'message', 'forged', { threadId: thread.id }), MISSING);
  denied(() => f.ledger.list(f.b, { kind: 'message', threadId: thread.id }), MISSING);
  denied(() => f.ledger.read(randomUUID(), message.id), UNAVAILABLE);
  assert.deepEqual(f.ledger.list(f.b, { kind: 'thread' }).records, []);
  assert.deepEqual(f.ledger.changes(f.b).events, []);
  const independent = create(f.ledger, f.b, 'memory', 'owner-b');
  assert.equal(independent.sequence, 1);
  assert.equal(f.ledger.read(f.a, message.id).record.value, 'synthetic-private-a');
});

test('canonical replay and compare-and-swap preserve one event and metadata-only retry results', t => {
  const f = fixture(t), requestId = 'synthetic-retry';
  const operation = { requestId, op: 'create', kind: 'memory', expectedVersion: 0, value: { z: 'private-old-canary', a: [1, true, null] } };
  const first = f.ledger.mutate(f.a, operation);
  assert.deepEqual(f.ledger.mutate(f.a, { ...operation, value: { a: [1, true, null], z: 'private-old-canary' } }), first);
  denied(() => f.ledger.mutate(f.a, { ...operation, value: 'different' }), CONFLICT);
  const changed = f.ledger.mutate(f.a, update(first.id, 1, { current: true }));
  assert.equal(changed.version, 2); assert.equal(changed.sequence, 2);
  denied(() => f.ledger.mutate(f.a, update(first.id, 1, 'stale')), CONFLICT);
  const deletion = remove(first.id, 2), gone = f.ledger.mutate(f.a, deletion);
  assert.equal(gone.version, 3); assert.equal(gone.sequence, 3); assert.equal(gone.deleted, true);
  assert.deepEqual(f.ledger.mutate(f.a, deletion), gone);
  assert.deepEqual(f.ledger.mutate(f.a, operation), first, 'An old retry cannot resurrect removed content');
  denied(() => f.ledger.read(f.a, first.id), MISSING);
  assert.deepEqual(f.ledger.list(f.a, { kind: 'memory' }).records, []);
  const row = f.bootstrap.db.prepare('SELECT value_json FROM private_state_record WHERE id=?').get(first.id);
  assert.equal(row.value_json, null);
  assert.equal(f.ledger.changes(f.a).events.length, 3);
  for (const table of ['private_state_request', 'private_state_event']) {
    assert.ok(!JSON.stringify(f.bootstrap.db.prepare('SELECT * FROM ' + table).all()).includes('private-old-canary'));
  }
});

test('list watermark survives restart and catches edits to already-read pages without later creates leaking in', t => {
  const f = fixture(t), records = Array.from({ length: 3 }, (_, index) => create(f.ledger, f.a, 'memory', { index }));
  const first = f.ledger.list(f.a, { kind: 'memory', limit: 1 });
  const edit = f.ledger.mutate(f.a, update(records[0].id, 1, { updated: true }));
  const later = create(f.ledger, f.a, 'memory', { later: true });
  f.close(f.bootstrap);
  const reopened = f.open();
  const second = reopened.ledger.list(f.a, { kind: 'memory', cursor: first.nextCursor, limit: 1 });
  const third = reopened.ledger.list(f.a, { kind: 'memory', cursor: second.nextCursor });
  assert.deepEqual([...first.records, ...second.records, ...third.records].map(row => row.id), records.map(row => row.id));
  assert.equal(third.nextCursor, null);
  assert.equal(second.checkpoint, first.checkpoint); assert.equal(third.checkpoint, first.checkpoint);
  const catchup = reopened.ledger.changes(f.a, { cursor: third.checkpoint });
  assert.deepEqual(catchup.events.map(event => event.id), [edit.id, later.id]);
  assert.deepEqual(reopened.ledger.read(f.a, records[0].id).record.value, { updated: true });
  assert.deepEqual(reopened.ledger.mutate(f.a, { requestId: 'new-after-restart', op: 'create', kind: 'watch', expectedVersion: 0, value: null }).sequence, 6);
});

test('changes checkpoints advance through each returned page and never skip unread invalidations', t => {
  const f = fixture(t);
  for (let index = 0; index < 55; index++) create(f.ledger, f.a, 'goal', index);
  const first = f.ledger.changes(f.a);
  assert.equal(first.events.length, 50); assert.equal(first.events.at(-1).sequence, 50);
  assert.equal(first.checkpoint, first.nextCursor);
  const last = f.ledger.changes(f.a, { cursor: first.checkpoint });
  assert.deepEqual(last.events.map(event => event.sequence), [51, 52, 53, 54, 55]);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(f.ledger.changes(f.a, { cursor: last.checkpoint }).events, []);
  assert.equal(f.ledger.list(f.a, { kind: 'goal' }).records.length, 50);
});

test('cursors reject owner, purpose, kind, thread, tamper and ahead-of-watermark substitutions', t => {
  const f = fixture(t), ta = create(f.ledger, f.a, 'thread', 'a'), tb = create(f.ledger, f.a, 'thread', 'b');
  for (const thread of [ta, tb]) for (let i = 0; i < 2; i++) create(f.ledger, f.a, 'message', i, { threadId: thread.id });
  for (let i = 0; i < 2; i++) create(f.ledger, f.a, 'memory', i);
  const page = f.ledger.list(f.a, { kind: 'memory', limit: 1 });
  const messagePage = f.ledger.list(f.a, { kind: 'message', threadId: ta.id, limit: 1 });
  const changes = f.ledger.changes(f.a, { limit: 1 });
  denied(() => f.ledger.list(f.b, { kind: 'memory', cursor: page.nextCursor }), CURSOR);
  denied(() => f.ledger.list(f.a, { kind: 'goal', cursor: page.nextCursor }), CURSOR);
  denied(() => f.ledger.list(f.a, { kind: 'message', threadId: tb.id, cursor: messagePage.nextCursor }), CURSOR);
  denied(() => f.ledger.list(f.a, { kind: 'memory', cursor: changes.nextCursor }), CURSOR);
  denied(() => f.ledger.changes(f.a, { cursor: page.nextCursor }), CURSOR);
  for (const cursor of [null, 1, '0', '', page.checkpoint + 'x', 'x'.repeat(2049)]) denied(() => f.ledger.changes(f.a, { cursor }), CURSOR);
  denied(() => f.ledger.changes(f.a, { cursor: signed(f, { purpose: 'changes', after: 100 }) }), CURSOR);
  denied(() => f.ledger.list(f.a, { kind: 'memory', cursor: signed(f, { purpose: 'list', kind: 'memory', threadId: null, watermark: 100, after: 0 }) }), CURSOR);
  denied(() => f.ledger.list(f.a, { kind: 'memory', cursor: signed(f, { purpose: 'list', kind: 'memory', threadId: null, watermark: 1, after: 2 }) }), CURSOR);
  for (const limit of [0, 51, -1, 1.5, null]) {
    denied(() => f.ledger.list(f.a, { kind: 'memory', limit }), INVALID);
    denied(() => f.ledger.changes(f.a, { limit }), INVALID);
  }
});

test('thread removal atomically clears more than one page of children with one parent invalidation', t => {
  const f = fixture(t), thread = create(f.ledger, f.a, 'thread', 'thread-canary');
  const other = create(f.ledger, f.a, 'thread', 'keep-thread');
  const childOperations = Array.from({ length: 55 }, (_, index) => ({ requestId: 'message-' + index, op: 'create', kind: 'message',
    expectedVersion: 0, threadId: thread.id, value: 'child-canary-' + index }));
  const children = childOperations.map(operation => f.ledger.mutate(f.a, operation));
  const retained = create(f.ledger, f.a, 'message', 'retained', { threadId: other.id });
  const checkpoint = f.ledger.changes(f.a, { cursor: retained.checkpoint }).checkpoint;
  const removed = f.ledger.mutate(f.a, remove(thread.id, 1));
  for (const child of children) denied(() => f.ledger.read(f.a, child.id), MISSING);
  denied(() => f.ledger.list(f.a, { kind: 'message', threadId: thread.id }), MISSING);
  denied(() => create(f.ledger, f.a, 'message', 'late', { threadId: thread.id }), MISSING);
  assert.equal(f.ledger.read(f.a, retained.id).record.value, 'retained');
  assert.deepEqual(f.ledger.changes(f.a, { cursor: checkpoint }).events, [{ sequence: removed.sequence, id: thread.id,
    kind: 'thread', threadId: null, version: 2, deleted: true }]);
  const rows = f.bootstrap.db.prepare('SELECT version,updated_sequence,deleted,value_json FROM private_state_record WHERE thread_id=?').all(thread.id);
  assert.equal(rows.length, 55);
  assert.ok(rows.every(row => row.deleted === 1 && row.value_json === null && row.version === 2 && row.updated_sequence === removed.sequence));
  assert.deepEqual(f.ledger.mutate(f.a, childOperations[0]), children[0]);
  denied(() => f.ledger.read(f.a, children[0].id), MISSING);
});

test('plain JSON validation rejects exotic values and accessors without executing them', t => {
  const f = fixture(t); let calls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; return 'not-read'; } });
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const cycle = {}; cycle.self = cycle;
  const extraArray = []; extraArray.extra = true;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), () => {}, Object.create({ inherited: true }),
    getter, { nested: getter }, hidden, cycle, [, 1], extraArray, { [Symbol('key')]: true }]) {
    denied(() => create(f.ledger, f.a, 'memory', value), INVALID);
  }
  assert.equal(calls, 0);
  denied(() => create(f.ledger, f.a, 'memory', '🙂'.repeat(4096)), INVALID);
  const boundary = create(f.ledger, f.a, 'memory', 'x'.repeat(16382));
  assert.equal(f.ledger.read(f.a, boundary.id).record.value.length, 16382);
  let nested = null; for (let i = 0; i < 64; i++) nested = [nested];
  assert.equal(create(f.ledger, f.a, 'memory', nested).version, 1);
  denied(() => create(f.ledger, f.a, 'memory', [nested]), INVALID);
  assert.equal(f.ledger.changes(f.a).events.length, 2);
});

test('exact mutation shapes forbid owner/runtime/credential selection and malformed versions', t => {
  const f = fixture(t), first = create(f.ledger, f.a, 'memory', null);
  const base = { requestId: 'valid', op: 'create', kind: 'memory', expectedVersion: 0, value: null };
  for (const field of ['companionId', 'owner', 'subject', 'runtimeId', 'credentials', 'id', 'threadId']) {
    denied(() => f.ledger.mutate(f.a, { ...base, [field]: first.id }), INVALID);
  }
  for (const requestId of ['', 'spaces forbidden', 'ü', 'x'.repeat(81), 1]) denied(() => f.ledger.mutate(f.a, { ...base, requestId }), INVALID);
  for (const expectedVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) denied(() => f.ledger.mutate(f.a, update(first.id, expectedVersion, null)), INVALID);
  denied(() => f.ledger.mutate(f.a, { ...update(first.id, 1, null), kind: 'thread' }), INVALID);
  denied(() => f.ledger.mutate(f.a, { ...remove(first.id, 1), value: 'extra' }), INVALID);
  denied(() => f.ledger.list(f.a, { kind: 'message' }), INVALID);
  denied(() => f.ledger.list(f.a, { kind: 'memory', threadId: first.id }), INVALID);
  denied(() => f.ledger.changes(f.a, { owner: f.b }), INVALID);
  assert.equal(f.ledger.changes(f.a).events.length, 1);
});

test('ledger initialization is atomic and unsupported schema leaves identities untouched', t => {
  const f = fixture(t, false), actual = f.bootstrap.db.exec.bind(f.bootstrap.db); let creates = 0;
  f.bootstrap.db.exec = sql => { if (sql.startsWith('CREATE TABLE') && ++creates === 2) throw new Error('private-synthetic-init-detail'); return actual(sql); };
  denied(() => new PrivateStateStore(f.bootstrap), UNAVAILABLE);
  f.bootstrap.db.exec = actual;
  assert.equal(f.bootstrap.db.prepare("SELECT count(*) count FROM sqlite_master WHERE name GLOB 'private_state_*'").get().count, 0);
  new PrivateStateStore(f.bootstrap);
  f.bootstrap.db.exec('ALTER TABLE private_state_schema ADD COLUMN unsupported TEXT');
  denied(() => new PrivateStateStore(f.bootstrap), UNAVAILABLE);
  assert.equal(f.bootstrap.count(), 3);
});

test('over-depth JSON is refused before commit and corrupt deep stored content fails closed', t => {
  const f = fixture(t);
  let value = null; for (let i = 0; i < 8000; i++) value = [value];
  denied(() => create(f.ledger, f.a, 'memory', value), INVALID);
  assert.equal(f.ledger.changes(f.a).events.length, 0);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM private_state_record').get().count, 0);
  const first = create(f.ledger, f.a, 'memory', 'serializable');
  const deepJson = '['.repeat(8000) + 'null' + ']'.repeat(8000);
  assert.equal(Buffer.byteLength(deepJson), 16004);
  f.bootstrap.db.prepare('UPDATE private_state_record SET value_json=? WHERE id=?').run(deepJson, first.id);
  denied(() => f.ledger.read(f.a, first.id), UNAVAILABLE);
  denied(() => f.ledger.list(f.a, { kind: 'memory' }), UNAVAILABLE);
});

test('inconsistent owner head refuses reads, checkpoints and writes without advancing state', t => {
  const f = fixture(t), first = create(f.ledger, f.a, 'memory', 'unchanged');
  for (const sequence of [0, 5]) {
    f.bootstrap.db.prepare('UPDATE private_state_owner SET sequence=? WHERE companion_id=?').run(sequence, f.a);
    denied(() => f.ledger.read(f.a, first.id), UNAVAILABLE);
    denied(() => f.ledger.list(f.a, { kind: 'watch' }), UNAVAILABLE);
    denied(() => f.ledger.changes(f.a), UNAVAILABLE);
    denied(() => create(f.ledger, f.a, 'memory', 'must not commit'), UNAVAILABLE);
    assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM private_state_record').get().count, 1);
    assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM private_state_event').get().count, 1);
    assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM private_state_request').get().count, 1);
  }
  f.bootstrap.db.prepare('UPDATE private_state_owner SET sequence=1 WHERE companion_id=?').run(f.a);
  create(f.ledger, f.a, 'memory', 'second'); create(f.ledger, f.a, 'memory', 'third');
  f.bootstrap.db.prepare('UPDATE private_state_event SET sequence=1.5 WHERE companion_id=? AND sequence=2').run(f.a);
  denied(() => f.ledger.list(f.a, { kind: 'memory' }), UNAVAILABLE);
});

test('unexpected persistent and temporary ledger triggers and indexes refuse before execution', t => {
  for (const sql of [
    'CREATE TRIGGER reset_head AFTER INSERT ON private_state_event BEGIN UPDATE private_state_owner SET sequence=0; END',
    'CREATE INDEX unreviewed_index ON private_state_record(kind)',
    'CREATE TEMP TRIGGER temporary_reset AFTER INSERT ON main.private_state_event BEGIN UPDATE private_state_owner SET sequence=0; END'
  ]) {
    const f = fixture(t); f.ledger.changes(f.a);
    f.bootstrap.db.exec(sql);
    denied(() => new PrivateStateStore(f.bootstrap), UNAVAILABLE);
    denied(() => create(f.ledger, f.a, 'memory', 'must not commit'), UNAVAILABLE);
    assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM private_state_event').get().count, 0);
    assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM private_state_record').get().count, 0);
  }
});

test('temporary ledger shadowing is refused before first initialization writes', t => {
  const f = fixture(t, false);
  f.bootstrap.db.exec('CREATE TEMP TABLE private_state_schema(version INTEGER)');
  denied(() => new PrivateStateStore(f.bootstrap), UNAVAILABLE);
  assert.equal(f.bootstrap.db.prepare("SELECT count(*) count FROM sqlite_master WHERE name GLOB 'private_state_*'").get().count, 0);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM temp.private_state_schema').get().count, 0);
  assert.equal(f.bootstrap.count(), 2);
});

test('durable bootstrap marker permits first upgrade and refuses a wholesale ledger reset', t => {
  const f = fixture(t, false);
  assert.equal(f.bootstrap.count(), 2);
  const ledger = new PrivateStateStore(f.bootstrap);
  const retained = create(ledger, f.a, 'memory', 'retained synthetic state');
  assert.equal(f.bootstrap.count(), 3);
  for (const name of ['schema', 'owner', 'record', 'event', 'request']) f.bootstrap.db.exec('DROP TABLE private_state_' + name);
  denied(() => new PrivateStateStore(f.bootstrap), UNAVAILABLE);
  assert.equal(f.bootstrap.db.prepare("SELECT count(*) count FROM sqlite_master WHERE name GLOB 'private_state_*'").get().count, 0);
  assert.equal(f.bootstrap.count(), 3);
  assert.match(retained.id, /^[a-f0-9-]+$/);
});

test('cached retry metadata is bound to its committed event and request MAC', t => {
  const f = fixture(t), firstOp = { requestId: 'cached-first', op: 'create', kind: 'memory', expectedVersion: 0, value: 'first' };
  const first = f.ledger.mutate(f.a, firstOp);
  const original = f.bootstrap.db.prepare('SELECT * FROM private_state_request WHERE request_id=?').get(firstOp.requestId);
  const replaced = { ...JSON.parse(original.result_json), id: randomUUID() };
  f.bootstrap.db.prepare('UPDATE private_state_request SET result_json=? WHERE request_id=?').run(JSON.stringify(replaced), firstOp.requestId);
  denied(() => f.ledger.mutate(f.a, firstOp), UNAVAILABLE);
  create(f.ledger, f.a, 'memory', 'second', { requestId: 'cached-second' });
  const second = f.bootstrap.db.prepare("SELECT result_json,result_digest FROM private_state_request WHERE request_id='cached-second'").get();
  f.bootstrap.db.prepare('UPDATE private_state_request SET result_json=?,result_digest=? WHERE request_id=?').run(second.result_json, second.result_digest, firstOp.requestId);
  denied(() => f.ledger.mutate(f.a, firstOp), UNAVAILABLE);
  f.bootstrap.db.prepare('UPDATE private_state_request SET result_json=?,result_digest=? WHERE request_id=?').run(original.result_json, original.result_digest, firstOp.requestId);
  assert.deepEqual(f.ledger.mutate(f.a, firstOp), first);
  f.bootstrap.db.prepare('UPDATE private_state_event SET id=? WHERE companion_id=? AND sequence=?').run(randomUUID(), f.a, first.sequence);
  denied(() => f.ledger.mutate(f.a, firstOp), UNAVAILABLE);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM private_state_event').get().count, 2);
});

test('a failed event commit rolls back record, sequence and replay ledger together', t => {
  const f = fixture(t), first = create(f.ledger, f.a, 'memory', 'before');
  const operation = update(first.id, 1, 'after', 'retry-after-failure');
  const actual = f.bootstrap.db.prepare.bind(f.bootstrap.db);
  f.bootstrap.db.prepare = sql => sql.startsWith('INSERT INTO private_state_event') ?
    { run() { throw new Error('private-synthetic-sqlite-detail'); } } : actual(sql);
  try {
    assert.throws(() => f.ledger.mutate(f.a, operation), error => error.code === UNAVAILABLE && !String(error).includes('sqlite-detail'));
  } finally { f.bootstrap.db.prepare = actual; }
  const retained = f.ledger.read(f.a, first.id).record;
  assert.equal(retained.value, 'before'); assert.equal(retained.version, 1);
  assert.equal(f.ledger.changes(f.a).events.length, 1);
  assert.equal(f.bootstrap.db.prepare('SELECT 1 FROM private_state_request WHERE request_id=?').get(operation.requestId), undefined);
  const retry = f.ledger.mutate(f.a, operation);
  assert.equal(retry.version, 2); assert.equal(retry.sequence, 2);
});

test('corrupt identities, records and cached results fail with fixed errors', t => {
  const f = fixture(t), operation = { requestId: 'corrupt-cache', op: 'create', kind: 'memory', expectedVersion: 0, value: 'private-canary' };
  const first = f.ledger.mutate(f.a, operation);
  f.bootstrap.getOrInsert('companion-identity-v1', 'duplicate-synthetic', { companionId: f.a });
  denied(() => f.ledger.read(f.a, first.id), UNAVAILABLE);
  f.bootstrap.db.prepare("DELETE FROM bootstrap_record WHERE key='duplicate-synthetic'").run();
  f.bootstrap.db.prepare('UPDATE private_state_record SET value_json=? WHERE id=?').run('private-invalid-json-canary', first.id);
  assert.throws(() => f.ledger.read(f.a, first.id), error => error.code === UNAVAILABLE && !String(error).includes('canary'));
  const cached = JSON.parse(f.bootstrap.db.prepare('SELECT result_json FROM private_state_request WHERE request_id=?').get(operation.requestId).result_json);
  cached.checkpoint = 'private-corrupt-cursor-canary';
  f.bootstrap.db.prepare('UPDATE private_state_request SET result_json=? WHERE request_id=?').run(JSON.stringify(cached), operation.requestId);
  denied(() => f.ledger.mutate(f.a, operation), UNAVAILABLE);
});

test('retained private data cannot silently replace a missing owner cursor key', t => {
  const f = fixture(t);
  create(f.ledger, f.a, 'memory', 'synthetic retained state');
  f.bootstrap.db.prepare('DELETE FROM private_state_owner WHERE companion_id=?').run(f.a);
  denied(() => f.ledger.list(f.a, { kind: 'watch' }), UNAVAILABLE);
  assert.equal(f.bootstrap.db.prepare('SELECT 1 FROM private_state_owner WHERE companion_id=?').get(f.a), undefined);
});

async function race(f, operations) {
  const script = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {BootstrapStore}=await import(workerData.storeUrl);const {PrivateStateStore}=await import(workerData.ledgerUrl);
      const bootstrap=new BootstrapStore(workerData.dir,workerData.root);let ledger;
      try {ledger=new PrivateStateStore(bootstrap);parentPort.postMessage({ready:true});await new Promise(resolve=>parentPort.once('message',resolve));
        let outcome;try{outcome={result:ledger.mutate(workerData.owner,workerData.operation)}}catch(error){outcome={code:error.code}}
        bootstrap.close();parentPort.postMessage(outcome);parentPort.close();
      }catch(error){try{bootstrap.close()}catch{}parentPort.postMessage({failed:true,code:error.code});parentPort.close()}
    })().catch(()=>{parentPort.postMessage({failed:true});parentPort.close()});`;
  const participants = operations.map(operation => {
    const worker = new Worker(script, { eval: true, workerData: { operation, dir: f.dir, root: ROOT, owner: f.a,
      storeUrl: new URL('../src/store.mjs', import.meta.url).href, ledgerUrl: new URL('../src/private-state.mjs', import.meta.url).href } });
    f.workers.add(worker);
    let readyResolve, resultResolve, rejectBoth;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; rejectBoth = reject; });
    const result = new Promise((resolve, reject) => {
      resultResolve = resolve;
      const rejectReady = rejectBoth; rejectBoth = error => { rejectReady(error); reject(error); };
    });
    worker.on('message', message => { if (message.ready) readyResolve(); else if (message.failed) rejectBoth(new Error('Synthetic worker initialization failed')); else resultResolve(message); });
    worker.on('error', rejectBoth);
    return { worker, ready, result };
  });
  // Suppress a premature unhandled rejection while the all-ready barrier is pending.
  for (const participant of participants) participant.result.catch(() => {});
  await Promise.all(participants.map(participant => participant.ready));
  for (const participant of participants) participant.worker.postMessage('go');
  return Promise.all(participants.map(participant => participant.result));
}
test('independent SQLite connections serialize schema initialization, duplicate creates and CAS writers', { timeout: 20000 }, async t => {
  const f = fixture(t, false); f.close(f.bootstrap);
  const operation = { requestId: 'simultaneous-create', op: 'create', kind: 'memory', expectedVersion: 0, value: { synthetic: true } };
  const first = await race(f, [operation, operation, operation]);
  assert.ok(first.every(outcome => outcome.result));
  assert.deepEqual(first[0].result, first[1].result); assert.deepEqual(first[1].result, first[2].result);
  const reopened = f.open(), id = first[0].result.id;
  assert.equal(reopened.ledger.changes(f.a).events.length, 1);
  const next = await race(f, [update(id, 1, 'writer-a'), update(id, 1, 'writer-b'), update(id, 1, 'writer-c')]);
  assert.equal(next.filter(outcome => outcome.result).length, 1);
  assert.deepEqual(next.filter(outcome => outcome.code).map(outcome => outcome.code), [CONFLICT, CONFLICT]);
  assert.equal(reopened.ledger.changes(f.a).events.length, 2);
  assert.equal(reopened.ledger.read(f.a, id).record.version, 2);
});
