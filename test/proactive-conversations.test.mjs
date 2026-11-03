import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { Conversations, ConversationError } from '../src/conversations.mjs';
import { CompanionRunner } from '../src/runner.mjs';
import { READ_ONLY_BOARD_TOOLS, narrowToolPolicy } from '../src/tool-policy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRIVATE = 'PRIVATE-WAKE-PROMPT-CANARY';
const message = text => ({ text: JSON.stringify({ action: 'message', text }), sessionId: 'private-provider-session' });
const wake = (extra = {}) => ({ id: randomUUID(), kind: 'reminder', prompt: PRIVATE, ...extra });
const toolNames = policy => [...policy.tools, ...policy.mcpServers.flatMap(server => server.allowedTools.map(name => `mcp__${server.name}__${name}`))];
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proactive-conversations-')), stores = new Set(), conversations = new Set();
  let now = 1000000;
  const f = { calls: [], prompts: [], factoryCalls: [], now: () => now, advance(ms = 1) { now += ms; },
    handler: options.handler ?? (() => message('A gentle reminder.')),
    open() { const store = new BootstrapStore(dir, ROOT); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); },
    create(store = f.store, changes = {}) {
      const conv = new Conversations({ store, now: f.now, flushMs: 1,
        runner: { turn(companionId, turn) {
          const owner = f.owners.find(value => f[value.label] === companionId);
          f.factoryCalls.push(owner.label);
          const policy = narrowToolPolicy({ tools: owner.tools, board: owner.board }, turn.allowedTools, f.apps[owner.label], turn.toolFilter);
          const resolved = { ...turn, allowedTools: toolNames(policy) };
          f.calls.push({ companionId, ...resolved }); return f.handler(companionId, resolved);
        } },
        systemPrompt(companionId, context) { f.prompts.push({ companionId, context }); return 'Native file persona'; },
        ...options, ...changes });
      conversations.add(conv); return conv;
    } };
  f.store = f.open();
  for (const label of ['a', 'b']) {
    const key = principalKey({ issuer: 'https://synthetic.invalid', subject: 'proactive-owner-' + label });
    f[label] = f.store.getOrInsert('companion-identity-v1', key, { companionId: randomUUID() }).companionId;
  }
  f.owners = ['a', 'b'].map(label => ({ issuer: 'https://synthetic.invalid', subject: 'proactive-owner-' + label, label,
    provider: 'claude', tools: ['Read', 'Write', 'WebSearch', 'WebFetch'], board: { configDir: join(dir, label, 'board'),
      pythonPath: join(dir, 'python'), connectPath: join(dir, 'connect.py'),
      allowedTools: [...READ_ONLY_BOARD_TOOLS, 'create_ticket', 'post_message', 'list_activity', 'unknown_operation'] } }));
  f.apps = Object.fromEntries(['a', 'b'].map(label => [label, [
    { name: 'scheduler', command: join(dir, 'scheduler'), env: { OWNER: label }, allowedTools: ['create_schedule', 'list_schedules', 'cancel_schedule'] },
    { name: 'board_docs', command: join(dir, 'docs'), allowedTools: ['post_message', 'read'] }
  ]]));
  options.beforeCreate?.(f);
  f.conv = f.create();
  t.after(async () => { for (const conv of conversations) await conv.shutdown(); for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
test('generic wakes cannot create or update release watches, while owner turns retain those app tools', async t => {
  const f = fixture(t, { beforeCreate(f) {
    f.apps.a[0].allowedTools.push('create_release_watch', 'update_release_watch');
  } });
  await f.conv.enqueueProactive(f.a, wake()); await f.conv.idle();
  for (const name of ['create_release_watch', 'update_release_watch'])
    assert.ok(!f.calls[0].allowedTools.includes('mcp__scheduler__' + name));
  assert.ok(f.calls[0].allowedTools.includes('mcp__scheduler__list_schedules'));
  const threadId = (await f.conv.handle(f.a, { action: 'createThread', requestId: 'release-owner-thread', title: 'Watch' })).thread.id;
  await f.conv.handle(f.a, { action: 'submit', requestId: 'release-owner-turn', threadId, text: 'Manage my watch' });
  await f.conv.idle();
  for (const name of ['create_release_watch', 'update_release_watch'])
    assert.ok(f.calls.at(-1).allowedTools.includes('mcp__scheduler__' + name));
});

const snapshot = (f, owner = f.a, conv = f.conv) => conv.handle(owner, { action: 'snapshot' });
const events = (f, threadId, conv = f.conv) => conv.handle(f.a, { action: 'events', threadId, cursor: '0' });
async function createThread(f, name = 'Existing chat', owner = f.a) {
  return (await f.conv.handle(owner, { action: 'createThread', requestId: randomUUID(), title: name })).thread.id;
}
function privateTranscript(snapshotValue) {
  assert.ok(!JSON.stringify(snapshotValue).includes(PRIVATE));
  assert.ok(!JSON.stringify(snapshotValue).includes('"action":"silent"'));
}

test('memory changes wait for the owner lane and late normal callbacks cannot restore a reset session', async t => {
  const started = deferred(), finish = deferred(); let live;
  const f = fixture(t, { handler: (_owner, turn) => { live = turn; turn.onEvent({ type: 'session', id: 'old-session' }); started.resolve(); return finish.promise; } });
  const threadId = await createThread(f);
  await f.conv.handle(f.a, { action: 'submit', threadId, requestId: 'memory-race', text: 'RETAINED-RECENT-CHAT' }); await started.promise;
  assert.throws(() => f.conv.assertMemoryIdle(f.a), { code: 'MEMORY_BUSY', status: 409 });
  assert.doesNotThrow(() => f.conv.assertMemoryIdle(f.b));
  f.conv.resetSessions(f.a); live.onEvent({ type: 'session', id: 'late-old-session' });
  assert.equal(f.store.db.prepare('SELECT provider_session FROM conv_threads WHERE id=?').get(threadId).provider_session, null);
  await f.conv.handle(f.a, { action: 'cancel', threadId, requestId: 'memory-race' });
  assert.throws(() => f.conv.assertMemoryIdle(f.a), { code: 'MEMORY_BUSY' }, 'cancel has not yet joined the native lane');
  finish.resolve({ text: 'old reply', sessionId: 'final-old-session' }); await f.conv.idle();
  const row = f.store.db.prepare('SELECT provider_session,session_turns FROM conv_threads WHERE id=?').get(threadId);
  assert.equal(row.provider_session, null); assert.equal(row.session_turns, 0); assert.doesNotThrow(() => f.conv.assertMemoryIdle(f.a));
  f.handler = () => ({ text: 'new reply', sessionId: 'fresh-session' });
  await f.conv.handle(f.a, { action: 'submit', threadId, requestId: 'after-memory', text: 'hello again' }); await f.conv.idle();
  assert.equal(f.calls.at(-1).resume, null);
  assert.ok(f.prompts.at(-1).context.recent.some(message => message.text === 'RETAINED-RECENT-CHAT'), 'approved recent chat replay stays unchanged');
});

test('late wake session events and final session IDs cannot undo a durable memory reset', async t => {
  const started = deferred(), finish = deferred(); let live;
  const f = fixture(t, { handler: (_owner, turn) => { live = turn; turn.onEvent({ type: 'session', id: 'old-wake-session' }); started.resolve(); return finish.promise; } });
  const admitted = f.conv.enqueueProactive(f.a, wake()); await started.promise;
  assert.throws(() => f.conv.assertMemoryIdle(f.a), { code: 'MEMORY_BUSY' });
  f.conv.resetSessions(f.a); live.onEvent({ type: 'session', id: 'late-wake-session' });
  finish.resolve(message('Existing reminder output.')); await f.conv.idle();
  const row = f.store.db.prepare('SELECT provider_session,session_turns FROM conv_threads WHERE id=?').get(admitted.threadId);
  assert.equal(row.provider_session, null); assert.equal(row.session_turns, 0); assert.doesNotThrow(() => f.conv.assertMemoryIdle(f.a));
});

test('a quiet queued DB wake does not indefinitely block memory edits, but a recovery running row does', async t => {
  const f = fixture(t, { wakePolicy: { beforeStart: () => false, canDeliver: () => true } });
  const input = wake(); f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.a, input.id).state, 'queued');
  assert.doesNotThrow(() => f.conv.assertMemoryIdle(f.a));
  f.store.db.prepare("UPDATE conv_wakes SET state='running' WHERE companion_id=? AND id=?").run(f.a, input.id);
  assert.throws(() => f.conv.assertMemoryIdle(f.a), { code: 'MEMORY_BUSY' });
  assert.doesNotThrow(() => f.conv.assertMemoryIdle(f.b));
});

test('a genuine wake buffers deltas and publishes one assistant message without a synthetic user row', async t => {
  const started = deferred(), finish = deferred();
  const f = fixture(t, { handler: (_owner, turn) => {
    turn.onEvent({ type: 'delta', text: '{"action":"message","text":"PRIVATE-PROVISIONAL-CANARY"}' });
    started.resolve(); return finish.promise;
  } });
  const input = wake(), admitted = f.conv.enqueueProactive(f.a, input);
  assert.equal(admitted.state, 'queued');
  await started.promise;
  const running = await snapshot(f);
  assert.deepEqual(running.messages, []); assert.equal(running.turn.requestId, admitted.requestId);
  assert.equal(running.turn.state, 'streaming'); privateTranscript(running);
  assert.ok(!JSON.stringify(await events(f, admitted.threadId)).includes('PRIVATE-PROVISIONAL-CANARY'));
  finish.resolve(message('Time to stretch.')); await f.conv.idle();
  const result = f.conv.proactiveResult(f.a, input.id), view = await snapshot(f);
  assert.equal(result.state, 'message');
  assert.deepEqual(view.messages.map(item => [item.role, item.text]), [['assistant', 'Time to stretch.']]);
  assert.equal(view.messages[0].id, result.messageId);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM conv_messages WHERE role='user'").get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM conv_turns').get().n, 0);
  assert.equal((await events(f, admitted.threadId)).events.at(-1).state, 'complete'); privateTranscript(view);
});

test('pre-feeling history and old wake records migrate while user, ordinary and proactive writes retain their metadata', async t => {
  const threadId = randomUUID(), oldWake = randomUUID(), oldUser = randomUUID(), oldReply = randomUUID();
  const f = fixture(t, {
    beforeCreate(f) {
      f.store.db.exec(`CREATE TABLE conv_threads(id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, title TEXT NOT NULL,
        provider_session TEXT, last_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE conv_messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, request_id TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE conv_wakes(companion_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,prompt TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,attempt_token TEXT,
        result_text TEXT,message_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(companion_id,id),UNIQUE(companion_id,request_id));`);
      f.store.db.prepare('INSERT INTO conv_threads(id,companion_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(threadId, f.a, 'Existing history', 1, 1);
      const insert = f.store.db.prepare('INSERT INTO conv_messages(id,thread_id,role,text,request_id,created_at) VALUES(?,?,?,?,?,?)');
      insert.run(oldUser, threadId, 'user', 'Old user text', 'old-request', 1);
      insert.run(oldReply, threadId, 'assistant', 'Old assistant text', 'old-request', 2);
      f.store.db.prepare('INSERT INTO conv_wakes(companion_id,id,request_id,thread_id,kind,prompt,fingerprint,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(f.a, oldWake, 'wake-' + oldWake, threadId, 'heartbeat', PRIVATE, 'a'.repeat(64), 'silent', 3, 3);
    },
    handler: (_owner, turn) => turn.prompt.includes('private background')
      ? { text: '[feeling:tender] ' + JSON.stringify({ action: 'message', text: 'Upgraded wake.' }) }
      : { text: '[feeling:happy] Upgraded ordinary reply.' }
  });
  assert.deepEqual(f.store.db.prepare('PRAGMA table_info(conv_messages)').all().map(column => column.name),
    ['id', 'thread_id', 'role', 'text', 'request_id', 'created_at', 'feeling', 'peer_json']);
  assert.ok(f.store.db.prepare('SELECT peer_json FROM conv_messages').all().every(row=>row.peer_json===null),'legacy rows gain no invented peer attribution');
  const legacy = await f.conv.handle(f.a, { action: 'snapshot', threadId });
  assert.deepEqual(legacy.messages.map(row => [row.id, row.role, row.text, row.feeling]),
    [[oldUser, 'user', 'Old user text', undefined], [oldReply, 'assistant', 'Old assistant text', undefined]]);
  const migratedWake = f.store.db.prepare('SELECT state,prompt,result_text,result_feeling FROM conv_wakes WHERE id=?').get(oldWake);
  assert.deepEqual({ ...migratedWake }, { state: 'silent', prompt: PRIVATE, result_text: null, result_feeling: null });
  await f.conv.handle(f.a, { action: 'submit', threadId, requestId: 'after-upgrade', text: 'New user text' });
  await f.conv.idle();
  const input = wake(); f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  const view = await f.conv.handle(f.a, { action: 'snapshot', threadId });
  assert.deepEqual(view.messages.map(row => [row.role, row.text, row.feeling]), [
    ['user', 'Old user text', undefined], ['assistant', 'Old assistant text', undefined],
    ['user', 'New user text', undefined], ['assistant', 'Upgraded ordinary reply.', 'happy'], ['assistant', 'Upgraded wake.', 'tender']
  ]);
  assert.equal(f.calls.length, 2); privateTranscript(view);
});

test('a feeling prefix split across private deltas stays buffered until one tagged wake message is complete', async t => {
  const started = deferred(), finish = deferred();
  const f = fixture(t, { handler: (_owner, turn) => {
    for (const text of ['[feel', 'ing:tender] ', '{"action":"message",', '"text":"A kind reminder."}']) turn.onEvent({ type: 'delta', text });
    started.resolve(); return finish.promise;
  } });
  const input = wake(), accepted = f.conv.enqueueProactive(f.a, input); await started.promise;
  const running = await snapshot(f), pendingEvents = await events(f, accepted.threadId);
  assert.deepEqual(running.messages, []); assert.ok(!JSON.stringify(pendingEvents).includes('feeling:'));
  assert.ok(!JSON.stringify(pendingEvents).includes('A kind reminder.'));
  finish.resolve({}); await f.conv.idle();
  const view = await snapshot(f), completed = await events(f, accepted.threadId);
  assert.deepEqual(view.messages.map(row => [row.role, row.text, row.feeling]), [['assistant', 'A kind reminder.', 'tender']]);
  const messageEvents = completed.events.filter(event => event.type === 'message');
  assert.equal(messageEvents.length, 1); assert.equal(messageEvents[0].message.feeling, 'tender');
  for (const value of [view, completed]) {
    assert.ok(!JSON.stringify(value).includes('[feel'));
    assert.ok(!JSON.stringify(value).includes('"action":"message"')); privateTranscript(value);
  }
});

test('tagged silence and invalid final wake envelopes never expose feeling or control metadata', async t => {
  const cases = [
    ['[feeling:sleepy] {"action":"silent"}', 'silent'],
    ['[feeling:happy', 'error'], ['[feel', 'error'],
    ['[feeling:laugh] {"action":"message","text":"Hello","feeling":"laugh"}', 'error'],
    ['[feeling:happy] {"action":"silent","text":"PRIVATE-WAKE-RESULT-CANARY"}', 'error'],
    ['[feeling:tender] not JSON', 'error']
  ];
  for (const [raw, state] of cases) {
    const f = fixture(t, { handler: () => ({ text: raw }) }), input = wake();
    const accepted = f.conv.enqueueProactive(f.a, input); await f.conv.idle();
    assert.equal(f.conv.proactiveResult(f.a, input.id).state, state);
    const view = await snapshot(f), history = await events(f, accepted.threadId);
    assert.deepEqual(view.messages, []);
    for (const value of [view, history]) {
      assert.ok(!JSON.stringify(value).includes('[feel'));
      assert.ok(!JSON.stringify(value).includes('PRIVATE-WAKE-RESULT-CANARY')); privateTranscript(value);
    }
    const cached = f.store.db.prepare('SELECT result_text,result_feeling FROM conv_wakes WHERE id=?').get(input.id);
    assert.deepEqual({ ...cached }, { result_text: null, result_feeling: null });
  }
});

test('an unknown native feeling follows ordinary split semantics without leaking its tag', async t => {
  const f = fixture(t, { handler: () => ({ text: '[feeling:unknown] {"action":"message","text":"An untagged message."}' }) });
  const input = wake(); f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  const view = await snapshot(f);
  assert.deepEqual(view.messages.map(row => [row.text, row.feeling]), [['An untagged message.', undefined]]);
  assert.ok(!JSON.stringify(view).includes('feeling:unknown'));
});

test('silent decisions and malformed final output never leak prompts, deltas or control tokens into chat', async t => {
  const responses = ['{"action":"silent"}', 'HEARTBEAT_OK', 'not JSON', '{"action":"message","text":""}',
    '{"action":"silent","text":"PRIVATE-CANARY"}', JSON.stringify({ action: 'message', text: 'x'.repeat(4001) })];
  for (const [index, raw] of responses.entries()) {
    const f = fixture(t, { handler: (_owner, turn) => {
      turn.onEvent({ type: 'delta', text: 'PRIVATE-PROVISIONAL-CANARY' }); return { text: raw };
    } });
    const input = wake({ kind: 'heartbeat' }), result = f.conv.enqueueProactive(f.a, input);
    await f.conv.idle();
    assert.equal(f.conv.proactiveResult(f.a, input.id).state, index === 0 ? 'silent' : 'error');
    const view = await snapshot(f); assert.deepEqual(view.messages, []); assert.equal(view.turn, undefined);
    privateTranscript(view); assert.ok(!JSON.stringify(await events(f, result.threadId)).includes('PRIVATE-PROVISIONAL-CANARY'));
  }
});

test('admission is exact and idempotent; occurrence IDs and transcripts remain owner-scoped', async t => {
  const f = fixture(t), input = wake();
  const first = f.conv.enqueueProactive(f.a, input), second = f.conv.enqueueProactive(f.a, { ...input });
  assert.deepEqual(first, second);
  for (const change of [{ prompt: 'different' }, { kind: 'watch' }]) {
    assert.throws(() => f.conv.enqueueProactive(f.a, { ...input, ...change }), error => error.code === 'CONFLICT');
  }
  assert.equal(f.conv.proactiveResult(f.b, input.id), null);
  assert.equal(f.conv.cancelProactive(f.b, input.id), null);
  const other = f.conv.enqueueProactive(f.b, input);
  assert.notEqual(other.threadId, first.threadId);
  await f.conv.idle(); assert.equal(f.calls.length, 2);
  assert.equal(f.conv.enqueueProactive(f.a, input).messageId, f.conv.proactiveResult(f.a, input.id).messageId);
  await f.conv.idle(); assert.equal(f.calls.length, 2);
  await assert.rejects(f.conv.handle(f.b, { action: 'events', threadId: first.threadId, cursor: '0' }), error => error.code === 'NOT_FOUND');
});

test('canonical ongoing mapping adopts the latest existing chat and remains stable for default snapshots', async t => {
  const f = fixture(t, { wakePolicy: { beforeStart: () => false } });
  await createThread(f, 'Older'); f.advance(); const latest = await createThread(f, 'Current');
  const first = f.conv.enqueueProactive(f.a, wake()); await f.conv.idle();
  assert.equal(first.threadId, latest);
  f.advance(); await createThread(f, 'Later legacy thread');
  const second = f.conv.enqueueProactive(f.a, wake()); await f.conv.idle();
  assert.equal(second.threadId, latest); assert.equal((await snapshot(f)).threadId, latest);
});

test('beforeStart defers quietly and both policy hooks use the conversation write transaction', async t => {
  let allowed = false, beforeCalls = 0, delivered = 0;
  const f = fixture(t), other = f.open();
  f.store.db.exec('CREATE TABLE policy_marker(value INTEGER); INSERT INTO policy_marker VALUES(0);');
  const conv = f.create(f.store, { wakePolicy: {
    beforeStart: () => {
      beforeCalls++; f.store.db.prepare('UPDATE policy_marker SET value=value+1').run();
      assert.equal(other.db.prepare('SELECT value FROM policy_marker').get().value, beforeCalls - 1);
      return allowed;
    },
    canDeliver: () => {
      delivered++; f.store.db.prepare('UPDATE policy_marker SET value=value+1').run();
      assert.equal(other.db.prepare('SELECT value FROM policy_marker').get().value, beforeCalls);
      return true;
    }
  } });
  const input = wake(); conv.enqueueProactive(f.a, input); await conv.idle();
  assert.equal(conv.proactiveResult(f.a, input.id).state, 'queued'); assert.equal(f.calls.length, 0);
  assert.equal((await snapshot(f, f.a, conv)).turn, undefined);
  allowed = true; conv.enqueueProactive(f.a, input); await conv.idle();
  assert.equal(conv.proactiveResult(f.a, input.id).state, 'message'); assert.equal(f.calls.length, 1);
  assert.equal(beforeCalls, 2); assert.equal(delivered, 1);
});

test('quiet delivery buffers final text and a repeated enqueue only delivers once without another model turn', async t => {
  let deliver = false, starts = 0;
  const f = fixture(t, { wakePolicy: { beforeStart: () => { starts++; return true; }, canDeliver: () => deliver } });
  const input = wake(); f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.a, input.id).state, 'waiting_delivery');
  assert.deepEqual((await snapshot(f)).messages, []); assert.equal((await snapshot(f)).turn, undefined);
  const second = f.create(f.open(), { wakePolicy: { canDeliver: () => deliver } });
  second.recover(); await second.idle();
  assert.equal(second.proactiveResult(f.a, input.id).state, 'waiting_delivery'); assert.equal(f.calls.length, 1);
  deliver = true; f.conv.enqueueProactive(f.a, input); second.enqueueProactive(f.a, input);
  await Promise.all([f.conv.idle(), second.idle()]);
  assert.equal(f.calls.length, 1); assert.equal(starts, 1);
  assert.equal((await snapshot(f)).messages.length, 1);
  assert.equal(second.proactiveResult(f.a, input.id).state, 'message');
});

test('a quiet tagged wake survives a closed database and delivers the same feeling once without another model turn', async t => {
  let deliver = false;
  const f = fixture(t, { handler: () => ({ text: '[feeling:proud] {"action":"message","text":"The saved reminder."}' }),
    wakePolicy: { canDeliver: () => deliver } });
  const input = wake(); f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.a, input.id).state, 'waiting_delivery');
  assert.deepEqual({ ...f.store.db.prepare('SELECT result_text,result_feeling FROM conv_wakes WHERE id=?').get(input.id) },
    { result_text: 'The saved reminder.', result_feeling: 'proud' });
  await f.conv.shutdown(); f.close(f.store);
  const store = f.open(), reopened = f.create(store, { wakePolicy: { canDeliver: () => deliver } });
  reopened.recover(); reopened.enqueueProactive(f.a, input); await reopened.idle();
  assert.equal(reopened.proactiveResult(f.a, input.id).state, 'waiting_delivery');
  assert.deepEqual((await snapshot(f, f.a, reopened)).messages, []); assert.equal(f.calls.length, 1);
  deliver = true;
  reopened.enqueueProactive(f.a, input); reopened.enqueueProactive(f.a, input); await reopened.idle();
  const receipt = reopened.proactiveResult(f.a, input.id), view = await snapshot(f, f.a, reopened);
  assert.equal(receipt.state, 'message'); assert.equal(f.calls.length, 1);
  assert.deepEqual(view.messages.map(row => [row.id, row.text, row.feeling]), [[receipt.messageId, 'The saved reminder.', 'proud']]);
  assert.deepEqual({ ...store.db.prepare('SELECT result_text,result_feeling FROM conv_wakes WHERE id=?').get(input.id) },
    { result_text: null, result_feeling: null });
  await reopened.shutdown(); f.close(store);
  const offline = f.create(f.open()); offline.recover(); offline.enqueueProactive(f.a, input); await offline.idle();
  assert.deepEqual(offline.proactiveResult(f.a, input.id), receipt);
  assert.deepEqual((await snapshot(f, f.a, offline)).messages, view.messages); assert.equal(f.calls.length, 1);
});

test('queued and waiting delivery cancellation persist and cannot re-run the same occurrence', async t => {
  for (const kind of ['queued', 'waiting_delivery']) {
    const f = fixture(t, { handler: () => ({ text: '[feeling:worried] {"action":"message","text":"PRIVATE-WAITING-CANARY"}' }),
      wakePolicy: { beforeStart: () => kind !== 'queued', canDeliver: () => false } });
    const input = wake(); f.conv.enqueueProactive(f.a, input); await f.conv.idle();
    assert.equal(f.conv.proactiveResult(f.a, input.id).state, kind);
    if (kind === 'waiting_delivery') assert.equal(f.store.db.prepare('SELECT result_feeling FROM conv_wakes WHERE id=?').get(input.id).result_feeling, 'worried');
    const cancelled = f.conv.cancelProactive(f.a, input.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual({ ...f.store.db.prepare('SELECT result_text,result_feeling FROM conv_wakes WHERE id=?').get(input.id) },
      { result_text: null, result_feeling: null });
    assert.ok(!JSON.stringify(cancelled).includes('feeling') && !JSON.stringify(cancelled).includes('PRIVATE-WAITING-CANARY'));
    f.conv.enqueueProactive(f.a, input); await f.conv.idle();
    assert.equal(f.calls.length, kind === 'queued' ? 0 : 1);
    assert.deepEqual((await snapshot(f)).messages, []);
    assert.ok(!JSON.stringify(await snapshot(f)).includes('PRIVATE-WAITING-CANARY'));
  }
});

test('public Stop finds a running wake, aborts its signal and fences a late successful provider result', async t => {
  const started = deferred(), finish = deferred();
  const f = fixture(t, { handler: () => { started.resolve(); return finish.promise; } });
  const input = wake(), admission = f.conv.enqueueProactive(f.a, input); await started.promise;
  const cancelled = await f.conv.handle(f.a, { action: 'cancel', threadId: admission.threadId, requestId: admission.requestId });
  assert.equal(cancelled.cancel.state, 'cancelled'); assert.equal(f.calls[0].signal.aborted, true);
  finish.resolve({ text: '[feeling:tender] {"action":"message","text":"Too late."}' }); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.a, input.id).state, 'cancelled');
  assert.deepEqual((await snapshot(f)).messages, []);
  assert.deepEqual({ ...f.store.db.prepare('SELECT result_text,result_feeling FROM conv_wakes WHERE id=?').get(input.id) },
    { result_text: null, result_feeling: null });
});

test('restart interrupts a started wake and fences its stale callbacks and final response', async t => {
  const started = deferred(), finish = deferred();
  const f = fixture(t, { handler: () => { started.resolve(); return finish.promise; } });
  const input = wake(); f.conv.enqueueProactive(f.a, input); await started.promise;
  const restarted = f.create(f.open()); assert.equal(restarted.recover(), 1); await restarted.idle();
  assert.equal(restarted.proactiveResult(f.a, input.id).state, 'interrupted');
  f.calls[0].onEvent({ type: 'session', id: 'stale-session' });
  finish.resolve(message('A stale result.')); await f.conv.idle();
  restarted.enqueueProactive(f.a, input); await restarted.idle();
  assert.equal(f.calls.length, 1); assert.deepEqual((await snapshot(f, f.a, restarted)).messages, []);
  assert.notEqual(f.store.db.prepare('SELECT provider_session FROM conv_threads').get().provider_session, 'stale-session');
});

test('queued wakes recover and completed messages survive offline reopening without duplicates', async t => {
  const f = fixture(t, { wakePolicy: { beforeStart: () => false } }), input = wake();
  f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  const resumed = f.create(f.open(), { wakePolicy: {} }); resumed.recover(); await resumed.idle();
  const completed = resumed.proactiveResult(f.a, input.id); assert.equal(completed.state, 'message');
  const offline = f.create(f.open()); offline.recover(); offline.enqueueProactive(f.a, input); await offline.idle();
  assert.deepEqual(offline.proactiveResult(f.a, input.id), completed);
  assert.equal((await snapshot(f, f.a, offline)).messages.length, 1); assert.equal(f.calls.length, 1);
});

test('shutdown interrupts a running wake and leaves later queued wakes for a new service', async t => {
  const started = deferred();
  const f = fixture(t, { handler: (_owner, turn) => new Promise((_resolve, reject) => {
    started.resolve(); turn.signal.addEventListener('abort', () => reject(new Error('PRIVATE-CANARY')), { once: true });
  }) });
  const one = wake(), two = wake(); f.conv.enqueueProactive(f.a, one); f.conv.enqueueProactive(f.a, two);
  await started.promise; await f.conv.shutdown();
  assert.equal(f.conv.proactiveResult(f.a, one.id).state, 'interrupted');
  assert.equal(f.conv.proactiveResult(f.a, two.id).state, 'queued');
  f.handler = () => message('Recovered queued wake.');
  const resumed = f.create(f.open()); resumed.recover(); await resumed.idle();
  assert.equal(f.calls.length, 2); assert.equal(resumed.proactiveResult(f.a, two.id).state, 'message');
});

test('two SQLite connections admit and CAS-start the same occurrence exactly once', async t => {
  const started = deferred(), finish = deferred(); let starts = 0;
  const f = fixture(t, { handler: () => { started.resolve(); return finish.promise; },
    wakePolicy: { beforeStart: () => { starts++; return true; } } });
  const other = f.create(f.open()), input = wake();
  f.conv.enqueueProactive(f.a, input); other.enqueueProactive(f.a, input);
  await started.promise; await other.idle(); assert.equal(f.calls.length, 1); assert.equal(starts, 1);
  finish.resolve(message('Exactly one.')); await f.conv.idle();
  assert.equal((await snapshot(f)).messages.length, 1);
});

test('ordinary queued turn recovery uses CAS before provider start on two connections', async t => {
  const started = deferred(), finish = deferred();
  const f = fixture(t, { handler: () => { started.resolve(); return finish.promise; } }), threadId = await createThread(f);
  const accepted = f.conv.handle(f.a, { action: 'submit', threadId, requestId: 'ordinary-request', text: 'User input' });
  const other = f.create(f.open()); other.recover();
  await accepted; await started.promise; await other.idle(); assert.equal(f.calls.length, 1);
  finish.resolve({ text: 'An ordinary reply.' }); await f.conv.idle();
  assert.deepEqual((await snapshot(f)).messages.map(item => item.role), ['user', 'assistant']);
});

test('wake and user turns share the owner queue, native persona and provider-session continuity', async t => {
  const f = fixture(t, { handler: (_owner, turn) => turn.prompt.includes('private background')
    ? message('A wake message.') : { text: 'User reply.', sessionId: 'user-session' } });
  const threadId = await createThread(f);
  await f.conv.handle(f.a, { action: 'submit', threadId, requestId: 'user-first', text: 'Hello.' }); await f.conv.idle();
  const input = wake(); f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  assert.equal(f.calls[1].resume, 'user-session'); assert.equal(f.calls[1].systemPrompt, 'Native file persona');
  assert.deepEqual(f.calls[1].allowedTools.filter(name => name.startsWith('mcp__board__')),
    READ_ONLY_BOARD_TOOLS.map(name => 'mcp__board__' + name));
  assert.ok(f.calls[1].allowedTools.includes('Write') && f.calls[1].allowedTools.includes('mcp__scheduler__create_schedule'));
  assert.equal(f.prompts[1].context.fresh, false);
  await f.conv.handle(f.a, { action: 'submit', threadId, requestId: 'user-after', text: 'Thank you.' }); await f.conv.idle();
  assert.equal(f.calls[2].resume, 'private-provider-session');
  for (const index of [0, 2]) assert.ok(f.calls[index].allowedTools.includes('mcp__board__post_message'), 'Normal turns retain configured writes');
  assert.deepEqual((await snapshot(f)).messages.map(item => item.role), ['user', 'assistant', 'assistant', 'user', 'assistant']);
});

test('every wake kind keeps inherited native/app tools but only the exact configured Board read names', async t => {
  const f = fixture(t), before = structuredClone(f.owners[0]);
  for (const kind of ['reminder', 'heartbeat', 'watch', 'board']) {
    f.conv.enqueueProactive(f.a, wake({ kind })); await f.conv.idle();
    const selected = f.calls.at(-1).allowedTools;
    const expected = kind === 'board' ? [...READ_ONLY_BOARD_TOOLS, 'create_ticket', 'post_message', 'list_activity', 'unknown_operation'] : READ_ONLY_BOARD_TOOLS;
    assert.deepEqual(selected.filter(name => name.startsWith('mcp__board__')), expected.map(name => 'mcp__board__' + name),
      kind === 'board' ? 'Board-triggered wakes keep every configured Board tool' : 'Other wakes read the Board only');
    for (const name of ['Read', 'Write', 'WebSearch', 'WebFetch', 'mcp__scheduler__create_schedule', 'mcp__scheduler__list_schedules',
      'mcp__scheduler__cancel_schedule', 'mcp__board_docs__post_message']) assert.ok(selected.includes(name), name);
  }
  assert.deepEqual(f.owners[0], before); assert.equal(f.factoryCalls.length, 4);
  f.owners[0].board.allowedTools = ['get_ticket', 'post_message', 'list_activity'];
  f.conv.enqueueProactive(f.a, wake()); await f.conv.idle();
  assert.deepEqual(f.calls.at(-1).allowedTools.filter(name => name.startsWith('mcp__board__')), ['mcp__board__get_ticket'],
    'The guard never adds unconfigured members of the read-only default');
});

test('only a board wake retains its own configured Board writes, and never another owner\'s', async t => {
  const resolver = 'mcp__board__resolve_human_request';
  const f = fixture(t, { beforeCreate(f) {
    f.owners[0].board.allowedTools.push('resolve_human_request');
  } });
  for (const kind of ['reminder', 'heartbeat', 'watch', 'board']) {
    f.conv.enqueueProactive(f.a, wake({ kind })); await f.conv.idle();
    const call = f.calls.at(-1);
    assert.equal(call.companionId, f.a);
    // Needs-you and mention wakes (kind board) answer on the Board, so they keep A's configured writes.
    for (const write of [resolver, 'mcp__board__post_message', 'mcp__board__create_ticket'])
      assert.equal(call.allowedTools.includes(write), kind === 'board', `${kind}: ${write}`);
  }
  f.conv.enqueueProactive(f.b, wake({ kind: 'board' })); await f.conv.idle();
  assert.equal(f.calls.at(-1).companionId, f.b);
  assert.ok(!f.calls.at(-1).allowedTools.includes(resolver), 'B cannot borrow A\'s configured resolver');
  const threadId = await createThread(f);
  await f.conv.handle(f.a, { action: 'submit', threadId, requestId: 'owner-resolver', text: 'Handle my request' });
  await f.conv.idle();
  assert.ok(f.calls.at(-1).allowedTools.includes(resolver), 'The configured normal-owner tool remains available');
});

test('wake filtering preserves explicit subsets and empty selections while invalid requests still refuse', async t => {
  const f = fixture(t), subset = ['Read', 'mcp__board__get_ticket', 'mcp__board__post_message',
    'mcp__scheduler__list_schedules', 'mcp__board_docs__post_message'];
  const narrowed = f.create(f.store, { allowedTools: subset });
  narrowed.enqueueProactive(f.a, wake()); await narrowed.idle();
  assert.deepEqual(f.calls.at(-1).allowedTools, ['Read', 'mcp__board__get_ticket', 'mcp__scheduler__list_schedules', 'mcp__board_docs__post_message']);
  assert.ok(subset.includes('mcp__board__post_message'), 'Caller selection was not mutated');
  const empty = f.create(f.store, { allowedTools: [] }); empty.enqueueProactive(f.a, wake()); await empty.idle();
  assert.deepEqual(f.calls.at(-1).allowedTools, []);
  const invalid = f.create(f.store, { allowedTools: ['mcp__board__not_configured'] }), input = wake(), calls = f.calls.length;
  invalid.enqueueProactive(f.a, input); await invalid.idle();
  assert.equal(invalid.proactiveResult(f.a, input.id).state, 'error'); assert.equal(f.calls.length, calls);
});

test('the second narrowing uses frozen target descriptors and rejects invalid filters', async t => {
  const f = fixture(t); f.conv.enqueueProactive(f.a, wake()); await f.conv.idle();
  const predicate = f.calls[0].toolFilter, owner = f.owners[0], apps = f.apps.a; let changed = false;
  const policy = narrowToolPolicy({ tools: owner.tools, board: owner.board }, undefined, apps, name => {
    if (!changed) {
      changed = true; apps[0].env.OWNER = 'other-owner'; apps[0].command = join(tmpdir(), 'changed-command');
      apps[0].allowedTools.push('delete_schedule'); owner.board.configDir = join(tmpdir(), 'changed-board');
    }
    return predicate(name);
  });
  assert.equal(policy.mcpServers.find(server => server.name === 'scheduler').env.OWNER, 'a');
  assert.notEqual(policy.mcpServers.find(server => server.name === 'scheduler').command, apps[0].command);
  assert.notEqual(policy.board.configDir, owner.board.configDir);
  assert.ok(!toolNames(policy).includes('mcp__scheduler__delete_schedule'));
  for (const filter of [null, true, () => undefined, async () => { throw new Error('private filter failure'); }]) {
    assert.throws(() => narrowToolPolicy({ tools: ['Read'] }, undefined, [], filter), TypeError);
  }
});

function fakeProviderChild(provider) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true; let prompt = '';
  child.stdin.on('data', chunk => { prompt += chunk; });
  child.stdin.on('finish', () => queueMicrotask(() => {
    const text = prompt.includes('private background') ? '{"action":"silent"}' : 'Normal reply.';
    const records = provider === 'claude' ? [{ type: 'result', is_error: false, result: text, session_id: 'synthetic-session' }]
      : [{ type: 'thread.started', thread_id: 'synthetic-session' }, { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' }];
    child.stdout.end(records.map(value => JSON.stringify(value)).join('\n') + '\n'); child.emit('close', 0);
  }));
  return child;
}
function overrides(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index++) if (args[index] === '-c') {
    const entry = args[++index], equals = entry.indexOf('='); values.set(entry.slice(0, equals), JSON.parse(entry.slice(equals + 1)));
  }
  return values;
}
for (const provider of ['claude', 'codex']) test(`${provider}: real runner resolves one factory snapshot per turn and exposes read-only Board tools only on wakes`, async t => {
  const f = fixture(t), owner = { ...f.owners[0], provider,
    tools: provider === 'codex' ? ['WebSearch', 'WebFetch'] : f.owners[0].tools }, launches = []; let factories = 0;
  const runner = new CompanionRunner({ store: f.store, owners: [owner], runtimeDir: join(tmpdir(), 'unused-synthetic-runtime'),
    mcpServersFor() { factories++; return f.apps.a; },
    spawnImpl(_binary, args) { launches.push([...args]); return fakeProviderChild(provider); } });
  runner.paths = () => ({ home: join(tmpdir(), 'synthetic-home'), workspace: join(tmpdir(), 'synthetic-workspace') });
  const conv = f.create(f.store, { runner }), threadId = (await conv.handle(f.a, { action: 'createThread', requestId: 'real-runner-thread', title: 'Chat' })).thread.id;
  await conv.handle(f.a, { action: 'submit', threadId, requestId: 'before-wake', text: 'Normal turn before.' }); await conv.idle();
  conv.enqueueProactive(f.a, wake()); await conv.idle();
  await conv.handle(f.a, { action: 'submit', threadId, requestId: 'after-wake', text: 'Normal turn after.' }); await conv.idle();
  assert.equal(factories, 3); assert.equal(launches.length, 3);
  const board = args => provider === 'claude' ? args.filter(name => name.startsWith('mcp__board__')).map(name => name.slice(12))
    : overrides(args).get('mcp_servers.board.enabled_tools');
  assert.deepEqual(board(launches[1]), READ_ONLY_BOARD_TOOLS);
  for (const index of [0, 2]) assert.deepEqual(board(launches[index]), owner.board.allowedTools);
  if (provider === 'claude') {
    assert.equal(launches[1][launches[1].indexOf('--tools') + 1], owner.tools.join(','));
    assert.ok(launches[1].includes('mcp__scheduler__create_schedule') && launches[1].includes('mcp__board_docs__post_message'));
  } else {
    assert.equal(overrides(launches[1]).get('web_search'), 'live');
    assert.deepEqual(overrides(launches[1]).get('mcp_servers.scheduler.enabled_tools'), f.apps.a[0].allowedTools);
    assert.deepEqual(overrides(launches[1]).get('mcp_servers.board_docs.enabled_tools'), f.apps.a[1].allowedTools);
  }
});

test('invalid admissions and asynchronous hooks fail closed without user rows or hidden spends', async t => {
  const f = fixture(t); let invoked = 0;
  const getter = Object.defineProperty({ id: randomUUID(), kind: 'watch' }, 'prompt', { enumerable: true, get() { invoked++; return PRIVATE; } });
  for (const input of [null, [], wake({ id: 'bad' }), wake({ kind: 'user' }), wake({ prompt: '' }),
    wake({ prompt: 'x'.repeat(4001) }), wake({ extra: true }), getter]) {
    assert.throws(() => f.conv.enqueueProactive(f.a, input), ConversationError);
  }
  assert.equal(invoked, 0); assert.equal(f.calls.length, 0);
  f.store.db.exec('CREATE TABLE hook_spend(value INTEGER); INSERT INTO hook_spend VALUES(0);');
  const asyncGate = f.create(f.store, { wakePolicy: { beforeStart: () => {
    f.store.db.exec('UPDATE hook_spend SET value=1'); return Promise.resolve(true);
  } } }), input = wake();
  asyncGate.enqueueProactive(f.a, input); await asyncGate.idle();
  assert.equal(asyncGate.proactiveResult(f.a, input.id).state, 'queued');
  assert.equal(f.store.db.prepare('SELECT value FROM hook_spend').get().value, 0);
  assert.equal(f.calls.length, 0);
});

test('message insertion and terminal wake state roll back together on a final commit failure', async t => {
  const f = fixture(t), input = wake();
  f.store.db.exec("CREATE TRIGGER fail_wake_message BEFORE UPDATE ON conv_wakes WHEN NEW.state='message' BEGIN SELECT RAISE(ABORT,'PRIVATE-CANARY'); END;");
  f.conv.enqueueProactive(f.a, input); await f.conv.idle();
  assert.equal(f.conv.proactiveResult(f.a, input.id).state, 'error');
  assert.deepEqual((await snapshot(f)).messages, []);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM conv_events WHERE body LIKE '%messageId%'").get().n, 0);
  assert.equal(f.calls.length, 1);
});
