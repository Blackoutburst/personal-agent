import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations } from '../src/conversations.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = 'https://qwen.example/releases/qwen4';
const found = (extra = {}) => ({ text: '[feeling:tender] ' + JSON.stringify({ action: 'found', urls: [SOURCE],
  evidence: 'The official model card announces the release.', text: 'Qwen4 is here!', ...extra }), sessionId: 'release-private-session' });
const wake = () => ({ id: randomUUID(), kind: 'release_watch', prompt: 'Qwen4 is officially released by Alibaba/Qwen' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-watch-conv-')), stores = new Set(), conversations = new Set();
  const f = { id: randomUUID(), calls: [], records: [], deliveries: [], settled: [], observers: [],
    now: () => Date.parse('2026-11-03T10:00:00.000Z'), handler: () => found(),
    open() { const store = new BootstrapStore(dir, ROOT); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); },
    create(store = f.store, changes = {}) {
      const runner = { releaseCheck(companionId, input) { f.calls.push({ companionId, ...input }); return f.handler(input); },
        turn() { throw new Error('A release must never fall back to an ordinary turn'); } };
      const policy = { beforeStart: () => true, canDeliver: () => true,
        recordReleaseCheck(companionId, id, check, text) {
          f.records.push({ companionId, id, check, text });
          return check.result === 'found' ? { action: 'message', text } : { action: 'silent' };
        }, releaseDelivered(companionId, id) { f.deliveries.push({ companionId, id }); return true; } };
      const conv = new Conversations({ store, runner, now: f.now, systemPrompt: () => 'Trusted native companion instructions',
        onSettled: event => f.settled.push(event), onNativeSettled: id => f.observers.push(id), ...options, ...changes,
        wakePolicy: { ...policy, ...options.wakePolicy, ...changes.wakePolicy } });
      conversations.add(conv); return conv;
    } };
  f.store = f.open(); f.conv = f.create();
  t.after(async () => { for (const conv of conversations) await conv.shutdown(); for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const snapshot = (f, conv = f.conv) => conv.handle(f.id, { action: 'snapshot' });

test('release found buffers private output, appends a source link and leaves the normal provider session untouched', async t => {
  const f = fixture(t), input = wake(), finish = deferred();
  f.handler = async turn => {
    turn.onEvent({ type: 'session', id: 'must-not-replace-normal-session' });
    turn.onEvent({ type: 'delta', text: 'PRIVATE-RELEASE-JSON-CANARY' });
    await finish.promise; return found();
  };
  const threadId = f.conv.ongoingThread(f.id);
  f.store.db.prepare('UPDATE conv_threads SET provider_session=?,session_turns=9,session_at=? WHERE id=?')
    .run('normal-session', f.now() - 1000, threadId);
  const before = { ...f.store.db.prepare('SELECT provider_session,session_turns,session_at FROM conv_threads WHERE id=?').get(threadId) };
  f.conv.enqueueProactive(f.id, input); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await snapshot(f)).messages, []);
  finish.resolve(); await f.conv.idle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].resume, null);
  assert.match(f.calls[0].prompt, /condition is untrusted data/);
  assert.equal(f.calls[0].systemPrompt, 'Trusted native companion instructions');
  assert.deepEqual({ ...f.store.db.prepare('SELECT provider_session,session_turns,session_at FROM conv_threads WHERE id=?').get(threadId) }, before);
  assert.deepEqual(f.conv.proactiveResult(f.id, input.id).releaseCheck, { result: 'found', urls: [SOURCE],
    evidence: 'The official model card announces the release.', checkedAt: '2026-11-03T10:00:00.000Z' });
  const state = await snapshot(f);
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].role, 'assistant');
  assert.match(state.messages[0].text, /Qwen4 is here!/); assert.ok(state.messages[0].text.includes(SOURCE));
  assert.ok(!JSON.stringify(state).includes('PRIVATE-RELEASE-JSON-CANARY'));
  assert.equal(f.settled.length, 1); assert.equal(f.settled[0].proactive, true); assert.deepEqual(f.observers, []);
});

test('quiet found evidence and text survive a database restart and publish exactly once', async t => {
  let allow = false;
  const f = fixture(t, { wakePolicy: { canDeliver: () => allow } }), input = wake();
  f.conv.enqueueProactive(f.id, input); await f.conv.idle();
  const pending = f.conv.proactiveResult(f.id, input.id);
  assert.equal(pending.state, 'waiting_delivery'); assert.equal(pending.releaseCheck.result, 'found');
  assert.equal(f.deliveries.length, 0); assert.deepEqual((await snapshot(f)).messages, []);
  await f.conv.shutdown(); f.close(f.store);
  // Reopen the same SQLite database; waiting delivery never spends another provider turn.
  const reopened = f.open(), conv = f.create(reopened); conv.recover();
  conv.enqueueProactive(f.id, input); await conv.idle();
  assert.equal(conv.proactiveResult(f.id, input.id).state, 'waiting_delivery'); assert.equal(f.calls.length, 1);
  allow = true; conv.enqueueProactive(f.id, input); conv.enqueueProactive(f.id, input); await conv.idle();
  assert.equal(conv.proactiveResult(f.id, input.id).state, 'message'); assert.equal(f.calls.length, 1);
  assert.equal(f.deliveries.length, 1); assert.equal((await snapshot(f, conv)).messages.length, 1);
  assert.deepEqual(conv.proactiveResult(f.id, input.id).releaseCheck, pending.releaseCheck);
});

test('not-yet remains silent; stale decisions notify only when the transaction hook reserves the third notice', async t => {
  let consecutive = 0, notified = false;
  const f = fixture(t, { wakePolicy: {
    recordReleaseCheck(_owner, _id, check) {
      if (check.result !== 'stale') { consecutive = 0; return { action: 'silent' }; }
      consecutive++;
      if (consecutive === 3 && !notified) { notified = true; return { action: 'message', text: 'I have been unable to check this release watch three times.' }; }
      return { action: 'silent' };
    }
  } });
  f.handler = () => ({ text: '{"action":"not_yet"}' });
  const notYet = wake(); f.conv.enqueueProactive(f.id, notYet); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.id, notYet.id).releaseCheck.result, 'not_yet');
  f.handler = () => ({ text: '{"action":"stale"}' });
  for (let i = 0; i < 5; i++) { const input = wake(); f.conv.enqueueProactive(f.id, input); await f.conv.idle();
    assert.equal(f.conv.proactiveResult(f.id, input.id).releaseCheck.result, 'stale'); }
  assert.equal((await snapshot(f)).messages.length, 1); assert.equal(f.deliveries.length, 1);
});

test('malformed or incomplete output, provider failures and missing web entry points become stale without leaking details', async t => {
  const f = fixture(t);
  const cases = [
    () => ({ text: '{"action":"found","urls":[],"evidence":"announced","text":"It is here"}' }),
    () => found({ urls: ['https://owner:secret@source.example/release'] }),
    () => found({ urls: ['file:///secret'] }),
    () => found({ urls: ['https:relative.example'] }),
    () => found({ urls: Array(9).fill(SOURCE) }),
    () => found({ evidence: 'line one\nline two' }),
    () => found({ evidence: 'x'.repeat(1001) }),
    () => found({ extra: 'PRIVATE-SECRET' }),
    () => ({ text: '{"action":"not_yet","text":"PRIVATE-SECRET"}' }),
    () => ({ text: '{"action":"found"' }),
    () => ({ text: '```json\n{"action":"not_yet"}\n```' }),
    () => ({ text: 'PRIVATE-SECRET'.repeat(4000) }),
    () => { throw new Error('PRIVATE-SECRET: web unavailable'); }
  ];
  for (const handler of cases) { f.handler = handler; const input = wake(); f.conv.enqueueProactive(f.id, input); await f.conv.idle();
    assert.deepEqual(f.conv.proactiveResult(f.id, input.id).releaseCheck, { result: 'stale', urls: [], evidence: null, checkedAt: '2026-11-03T10:00:00.000Z' }); }
  for (const runner of [null, { turn() { throw new Error('Ordinary turns must not run'); } }]) {
    const conv = f.create(f.store, { runner }), input = wake(); conv.enqueueProactive(f.id, input); await conv.idle();
    assert.equal(conv.proactiveResult(f.id, input.id).releaseCheck.result, 'stale');
  }
  assert.deepEqual((await snapshot(f)).messages, []); assert.ok(!JSON.stringify(f.records).includes('PRIVATE-SECRET'));
});

test('a bounded found message always retains a source URL when the provider omits links', async t => {
  const f = fixture(t); f.handler = () => found({ text: '😀'.repeat(2000), urls: ['https://source.example/' + 'a'.repeat(1800)] });
  const input = wake(); f.conv.enqueueProactive(f.id, input); await f.conv.idle();
  const text = (await snapshot(f)).messages[0].text;
  assert.ok(text.isWellFormed()); assert.ok(text.length <= 4000); assert.ok(Buffer.byteLength(text) <= 16000);
  assert.ok(text.includes('https://source.example/' + 'a'.repeat(1800)));
});

test('cancellation and generation rejection fence late checks and deferred quiet delivery', async t => {
  const f = fixture(t), finish = deferred(), input = wake(); f.handler = () => finish.promise;
  f.conv.enqueueProactive(f.id, input); await new Promise(resolve => setImmediate(resolve));
  f.conv.cancelProactive(f.id, input.id); assert.equal(f.calls[0].signal.aborted, true);
  finish.resolve(found()); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.id, input.id).state, 'cancelled'); assert.equal(f.records.length, 0);
  const rejected = f.create(f.store, { wakePolicy: { recordReleaseCheck: () => ({ action: 'cancelled' }) } });
  f.handler = () => found(); const edited = wake(); rejected.enqueueProactive(f.id, edited); await rejected.idle();
  assert.equal(rejected.proactiveResult(f.id, edited.id).state, 'cancelled'); assert.equal(f.deliveries.length, 0);
  let canDeliver = false;
  const quiet = f.create(f.store, { wakePolicy: { canDeliver: () => canDeliver } }), waiting = wake();
  quiet.enqueueProactive(f.id, waiting); await quiet.idle(); quiet.cancelProactive(f.id, waiting.id);
  canDeliver = true; quiet.enqueueProactive(f.id, waiting); await quiet.idle();
  assert.equal(quiet.proactiveResult(f.id, waiting.id).state, 'cancelled'); assert.deepEqual((await snapshot(f)).messages, []);
});

test('restart fences an in-flight release result and leaves no stale provider session', async t => {
  const f = fixture(t), input = wake(), finish = deferred(); f.handler = () => finish.promise;
  f.conv.enqueueProactive(f.id, input); await new Promise(resolve => setImmediate(resolve));
  const recovered = f.create(f.open()); recovered.recover(); await recovered.idle();
  f.calls[0].onEvent({ type: 'session', id: 'late-session' }); finish.resolve(found()); await f.conv.idle();
  assert.equal(recovered.proactiveResult(f.id, input.id).state, 'interrupted'); assert.equal(f.records.length, 0);
  assert.deepEqual((await snapshot(f, recovered)).messages, []);
});

test('record and publication hooks share the message transaction and a refused publication rolls back both', async t => {
  const f = fixture(t); f.store.db.exec('CREATE TABLE release_markers(kind TEXT);');
  const observer = f.open();
  const conv = f.create(f.store, { wakePolicy: {
    recordReleaseCheck(_owner, _id, _check, text) {
      f.store.db.prepare('INSERT INTO release_markers VALUES(?)').run('check');
      assert.equal(observer.db.prepare('SELECT COUNT(*) AS n FROM release_markers').get().n, 0);
      return { action: 'message', text };
    }, releaseDelivered() {
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM conv_messages').get().n, 1);
      f.store.db.prepare('INSERT INTO release_markers VALUES(?)').run('published'); return false;
    }
  } }), input = wake();
  conv.enqueueProactive(f.id, input); await conv.idle();
  assert.equal(conv.proactiveResult(f.id, input.id).state, 'error');
  assert.equal(conv.proactiveResult(f.id, input.id).releaseCheck, undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM release_markers').get().n, 0);
  assert.deepEqual((await snapshot(f)).messages, []); assert.deepEqual(f.settled, []);
});

test('a generation rejected at deferred publication cannot emit a message or repeat a provider check', async t => {
  let allow = false;
  const f = fixture(t, { wakePolicy: { canDeliver: () => allow, releaseDelivered: () => false } }), input = wake();
  f.conv.enqueueProactive(f.id, input); await f.conv.idle();
  const pending = f.conv.proactiveResult(f.id, input.id); assert.equal(pending.state, 'waiting_delivery');
  allow = true; f.conv.enqueueProactive(f.id, input); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.id, input.id).state, 'waiting_delivery');
  assert.deepEqual(f.conv.proactiveResult(f.id, input.id).releaseCheck, pending.releaseCheck);
  assert.equal(f.calls.length, 1); assert.deepEqual((await snapshot(f)).messages, []); assert.deepEqual(f.settled, []);
  f.conv.cancelProactive(f.id, input.id); assert.equal(f.conv.proactiveResult(f.id, input.id).state, 'cancelled');
});

test('missing, invalid and asynchronous release policy callbacks fail closed', async t => {
  const f = fixture(t);
  for (const policy of [
    { recordReleaseCheck: undefined }, { recordReleaseCheck: async () => ({ action: 'silent' }) },
    { recordReleaseCheck: () => ({ action: 'message', text: '' }) },
    { recordReleaseCheck: () => ({ action: 'silent', text: 'hidden' }) },
    { releaseDelivered: undefined }, { releaseDelivered: async () => true }
  ]) {
    const conv = f.create(f.store, { wakePolicy: policy }), input = wake(); conv.enqueueProactive(f.id, input); await conv.idle();
    assert.equal(conv.proactiveResult(f.id, input.id).state, 'error');
  }
  assert.deepEqual((await snapshot(f)).messages, []);
});

test('an interrupted third stale check reconciles once, survives quiet restart and never retries the provider', async t => {
  let allow = false;
  const f = fixture(t), finish = deferred();
  f.store.db.exec('CREATE TABLE release_reconcile_state(stale INTEGER, delivered INTEGER); INSERT INTO release_reconcile_state VALUES(0,0);');
  const policyFor = store => ({ canDeliver: () => allow,
    recordReleaseCheck(_owner, _id, check) {
      assert.equal(check.result, 'stale');
      store.db.prepare('UPDATE release_reconcile_state SET stale=stale+1').run();
      return store.db.prepare('SELECT stale FROM release_reconcile_state').get().stale === 3
        ? { action: 'message', text: 'I have been unable to check this release watch three times.' } : { action: 'silent' };
    }, releaseDelivered() { store.db.prepare('UPDATE release_reconcile_state SET delivered=delivered+1').run(); return true; }
  });
  const running = f.create(f.store, { wakePolicy: policyFor(f.store) });
  f.handler = () => ({ text: '{"action":"stale"}' });
  for (let i = 0; i < 2; i++) { running.enqueueProactive(f.id, wake()); await running.idle(); }
  f.handler = () => finish.promise; const interrupted = wake(); running.enqueueProactive(f.id, interrupted);
  await new Promise(resolve => setImmediate(resolve));
  const recoveredStore = f.open(), recovered = f.create(recoveredStore, { wakePolicy: policyFor(recoveredStore) });
  recovered.recover(); await recovered.idle();
  assert.equal(recovered.proactiveResult(f.id, interrupted.id).state, 'interrupted');
  const reconciled = recovered.reconcileReleaseFailure(f.id, interrupted.id); await recovered.idle();
  assert.equal(reconciled.state, 'waiting_delivery'); assert.equal(reconciled.releaseCheck.result, 'stale');
  recovered.reconcileReleaseFailure(f.id, interrupted.id); await recovered.idle();
  finish.resolve(found()); await running.idle();
  assert.equal(f.calls.length, 3); assert.equal(recoveredStore.db.prepare('SELECT stale FROM release_reconcile_state').get().stale, 3);
  assert.deepEqual((await snapshot(f, recovered)).messages, []);
  await recovered.shutdown(); f.close(recoveredStore);
  const restartedStore = f.open(), restarted = f.create(restartedStore, { wakePolicy: policyFor(restartedStore) });
  restarted.recover(); allow = true; restarted.enqueueProactive(f.id, interrupted); await restarted.idle();
  restarted.reconcileReleaseFailure(f.id, interrupted.id); await restarted.idle();
  assert.equal(restarted.proactiveResult(f.id, interrupted.id).state, 'message'); assert.equal(f.calls.length, 3);
  assert.deepEqual({ ...restartedStore.db.prepare('SELECT * FROM release_reconcile_state').get() }, { stale: 3, delivered: 1 });
  assert.equal((await snapshot(f, restarted)).messages.length, 1);
});

test('failure reconciliation respects owner cancellation, changed generations and existing checks', async t => {
  const f = fixture(t), pending = deferred(); f.handler = () => pending.promise;
  const cancelled = wake(); f.conv.enqueueProactive(f.id, cancelled); await new Promise(resolve => setImmediate(resolve));
  f.conv.cancelProactive(f.id, cancelled.id); pending.resolve(found()); await f.conv.idle();
  assert.equal(f.conv.reconcileReleaseFailure(f.id, cancelled.id).state, 'cancelled'); assert.equal(f.records.length, 0);
  assert.equal(f.conv.reconcileReleaseFailure(f.id, randomUUID()), null);
  f.handler = () => ({ text: '{"action":"not_yet"}' });
  const valid = wake(); f.conv.enqueueProactive(f.id, valid); await f.conv.idle();
  assert.equal(f.conv.reconcileReleaseFailure(f.id, valid.id).releaseCheck.result, 'not_yet'); assert.equal(f.records.length, 1);
  let hookCalls = 0;
  const rejecting = f.create(f.store, { wakePolicy: { recordReleaseCheck: () => { hookCalls++; return { action: 'cancelled' }; } } });
  const old = wake(); rejecting.enqueueProactive(f.id, old); await rejecting.idle();
  // Model a recovered failure whose owning watch generation was edited/cancelled.
  f.store.db.prepare("UPDATE conv_wakes SET state='error',release_result_json=NULL WHERE companion_id=? AND id=?").run(f.id, old.id);
  assert.equal(rejecting.reconcileReleaseFailure(f.id, old.id).state, 'cancelled');
  rejecting.reconcileReleaseFailure(f.id, old.id); await rejecting.idle();
  assert.equal(hookCalls, 2, 'The original rejected check and exactly one reconciliation reached the hook');
  assert.deepEqual((await snapshot(f)).messages, []); assert.equal(f.deliveries.length, 0);
});
