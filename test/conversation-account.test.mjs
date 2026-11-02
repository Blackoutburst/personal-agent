import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

// Real-conversation account mode with synthetic accounts and fake provider programs:
// no platform login, provider account or model usage is involved.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUER = 'https://synthetic.invalid';
const PA = { issuer: ISSUER, subject: 'synthetic-owner-a' }, PB = { issuer: ISSUER, subject: 'synthetic-owner-b' };
const A = 'A'.repeat(43), B = 'B'.repeat(43);
const COOKIE = value => `__Secure-blackout_session=${value}`;

function setup(t, { signedIn = ['blackout', 'screamer'], timeoutMs, ownerSettings = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conversation-account-')));
  const binaries = {};
  for (const name of ['claude', 'codex']) {
    const file = join(dir, `fake-${name}.cjs`);
    writeFileSync(file, readFileSync(join(ROOT, 'test/fixtures', `fake-${name}.cjs.txt`))); chmodSync(file, 0o755); binaries[name] = file;
  }
  const runtimeFile = join(dir, 'owners.json');
  writeFileSync(runtimeFile, JSON.stringify({ owners: [
    { subject: PA.subject, issuer: ISSUER, label: 'blackout', provider: 'claude', ...ownerSettings.blackout },
    { subject: PB.subject, issuer: ISSUER, label: 'screamer', provider: 'claude', ...ownerSettings.screamer }] }));
  const runtimeDir = join(dir, 'runtimes'), dataDir = join(dir, 'data');
  const apps = [];
  t.after(async () => { for (const app of apps) if (app.server.listening) await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const open = async (options = {}) => {
    const app = await startServer({ dataDir, port: 0, mode: 'account', pilotSubjects: [PA, PB],
      validateAccount: async proof => ({ [A]: PA, [B]: PB })[proof] ?? null, runtimeFile, runtimeDir, binaries,
      runnerOptions: { statusTtlMs: 0, ...(timeoutMs ? { timeoutMs } : {}) }, conversationOptions: { flushMs: 20 }, ...options });
    apps.push(app);
    return app;
  };
  const home = label => join(runtimeDir, label, 'claude-home');
  const signIn = label => writeFileSync(join(home(label), 'signed-in'), '');
  const calls = label => existsSync(join(home(label), 'calls.jsonl'))
    ? readFileSync(join(home(label), 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { open, signIn, signedIn, calls, home };
}

async function post(app, body, proof = A) {
  const response = await fetch(app.url + '/api/conversation', { method: 'POST',
    headers: { Origin: app.url, 'Content-Type': 'application/json', ...(proof ? { Cookie: COOKIE(proof) } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
// Owners sign in to the web app first (provisions their companion ID), then to their provider.
async function ready(f, app) {
  for (const proof of [A, B]) {
    const response = await fetch(app.url + '/api/session', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(proof) }, body: '{}' });
    assert.equal(response.status, 200);
  }
  for (const label of f.signedIn) f.signIn(label);
}
async function settle(app, proof, threadId, from = '0') {
  const events = [];
  for (let cursor = from, i = 0; i < 200; i++) {
    const page = (await post(app, { action: 'events', threadId, cursor }, proof)).body;
    events.push(...page.events); cursor = page.cursor;
    if (events.some(e => e.type === 'turn' && e.state !== 'streaming')) return { events, cursor };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('turn did not settle');
}
const newThread = async (app, proof = A, requestId = 'new-1') =>
  (await post(app, { action: 'createThread', requestId, title: 'New conversation' }, proof)).body.thread.id;

test('authenticated conversations inherit owner file/web/Board and app MCP policy', async t => {
  const f = setup(t, { ownerSettings: { blackout: {
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    board: { configDir: '/synthetic/blackout/board', connectPath: '/synthetic/connect.py', pythonPath: '/synthetic/python3' }
  } } });
  const app = await f.open({ runnerOptions: { statusTtlMs: 0, mcpServersFor: owner => [{
    name: 'appdocs', command: '/synthetic/app', args: ['--owner', owner.label],
    env: { OWNER_LABEL: owner.label }, allowedTools: ['lookup']
  }] } });
  await ready(f, app);
  for (const [proof, label] of [[A, 'blackout'], [B, 'screamer']]) {
    const threadId = await newThread(app, proof, label);
    assert.equal((await post(app, { action: 'submit', requestId: 'configured', threadId, text: 'hello' }, proof)).status, 200);
    assert.equal((await settle(app, proof, threadId)).events.at(-1).state, 'complete');
    const args = f.calls(label)[0].args;
    const native = args[args.indexOf('--tools') + 1].split(',');
    assert.ok(['Read', 'Edit', 'Write', 'Glob', 'Grep'].every(tool => native.includes(tool)));
    assert.equal(native.includes('WebSearch'), label === 'blackout');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    const servers = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers;
    assert.deepEqual(Object.keys(servers), label === 'blackout' ? ['board', 'appdocs'] : ['appdocs']);
    assert.deepEqual(servers.appdocs.args, ['--owner', label]);
    assert.equal(servers.appdocs.env.OWNER_LABEL, label);
    assert.ok(args.includes('mcp__appdocs__lookup'));
    if (label === 'screamer') assert.ok(!JSON.stringify(args).includes('/synthetic/blackout/board'));
    const before = f.calls(label).length;
    assert.equal((await post(app, { action: 'submit', requestId: 'injected', threadId, text: 'hello',
      allowedTools: ['Bash'], mcpServersFor: 'caller replacement' }, proof)).status, 400);
    assert.equal(f.calls(label).length, before);
  }
});

test('a real reply streams from the owner\'s own agent and persists across reopen', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const session = await fetch(app.url + '/api/session', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(A) }, body: '{}' }).then(r => r.json());
  assert.deepEqual([session.runtime.state, session.provider.state], ['ready', 'claude']);
  const threadId = await newThread(app);
  const accepted = await post(app, { action: 'submit', requestId: 'send-1', threadId, text: 'STREAM please' });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.synthetic, false);
  const { events } = await settle(app, A, threadId);
  const replies = events.filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => e.message.text);
  assert.ok(replies.length >= 1 && replies.at(-1) === 'one two three four five');
  assert.equal(events.at(-1).state, 'complete');
  // Seqs are contiguous; repeated message updates in one page become noop events.
  events.forEach((e, i) => assert.equal(e.seq, i + 1));
  const snapshot = (await post(app, { action: 'snapshot', threadId })).body;
  assert.deepEqual(snapshot.messages.map(m => [m.role, m.text]), [['user', 'STREAM please'], ['assistant', 'one two three four five']]);
  assert.equal(snapshot.threads[0].title, 'STREAM please', 'the first message names a new conversation');
  assert.deepEqual(snapshot.runtime, { state: 'ready', provider: 'claude' });
  await app.close();
  const reopened = await f.open();
  assert.deepEqual((await post(reopened, { action: 'snapshot', threadId })).body.messages, snapshot.messages);
});

test('the provider session is resumed for later turns of the same thread only', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const first = await newThread(app, A, 't1'), second = await newThread(app, A, 't2');
  for (const [threadId, requestId] of [[first, 'a'], [first, 'b'], [second, 'c']]) {
    await post(app, { action: 'submit', requestId, threadId, text: 'hello' }); await settle(app, A, threadId);
  }
  const calls = f.calls('blackout');
  assert.equal(calls.length, 3);
  assert.ok(!calls[0].args.includes('--resume') && !calls[2].args.includes('--resume'));
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--resume'), calls[1].args.indexOf('--resume') + 2), ['--resume', 'sess-blackout']);
  assert.ok(calls[0].args.includes('--append-system-prompt') && calls[0].args[calls[0].args.indexOf('--append-system-prompt') + 1].includes("Blackout's personal companion"));
});

test('each owner only ever sees and reaches their own conversations and agent', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const mine = await newThread(app, A, 'mine');
  await post(app, { action: 'submit', requestId: 's', threadId: mine, text: 'private to A' }, A); await settle(app, A, mine);
  for (const body of [{ action: 'snapshot', threadId: mine }, { action: 'events', threadId: mine, cursor: '0' },
    { action: 'submit', requestId: 'x', threadId: mine, text: 'hi' }, { action: 'cancel', requestId: 's', threadId: mine }]) {
    assert.equal((await post(app, body, B)).status, 404, `B cannot use A's thread via ${body.action}`);
  }
  const theirs = (await post(app, { action: 'snapshot' }, B)).body;
  assert.deepEqual([theirs.threads, theirs.messages], [[], []]);
  assert.equal(f.calls('screamer').length, 0);
  assert.equal((await post(app, { action: 'snapshot' }, null)).status, 401);
  // The same request id from another owner is independent.
  const other = await newThread(app, B, 'mine');
  assert.notEqual(other, mine);
});

test('retries are idempotent, conflicting reuse and a second concurrent turn are refused', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  const request = { action: 'submit', requestId: 'once', threadId, text: 'STREAM' };
  const first = await post(app, request);
  assert.deepEqual((await post(app, request)).body, first.body);
  assert.equal((await post(app, { ...request, text: 'different' })).status, 409);
  const busy = await post(app, { action: 'submit', requestId: 'twice', threadId, text: 'again' });
  assert.deepEqual([busy.status, busy.body.error.code], [409, 'BUSY']);
  await settle(app, A, threadId);
  assert.equal(f.calls('blackout').length, 1);
});

test('stop cancels a running reply and keeps what was written', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  await post(app, { action: 'submit', requestId: 'slow', threadId, text: 'SLOW' });
  for (let i = 0; i < 100 && !(await post(app, { action: 'snapshot', threadId })).body.messages.some(m => m.role === 'assistant'); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const cancel = await post(app, { action: 'cancel', requestId: 'slow', threadId });
  assert.equal(cancel.body.cancel.state, 'stopping');
  const { events } = await settle(app, A, threadId);
  assert.equal(events.at(-1).state, 'cancelled');
  assert.equal((await post(app, { action: 'snapshot', threadId })).body.messages.at(-1).text, 'Thinking');
});

test('signed-out, usage limit and missing runtime are reported as clear turn errors', async t => {
  const f = setup(t, { signedIn: [] }), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  assert.equal((await post(app, { action: 'snapshot', threadId })).body.runtime.state, 'signed-out');
  await post(app, { action: 'submit', requestId: 'r1', threadId, text: 'hi' });
  let { events, cursor } = await settle(app, A, threadId);
  assert.equal(events.at(-1).error.code, 'NOT_SIGNED_IN');
  f.signIn('blackout');
  await post(app, { action: 'submit', requestId: 'r2', threadId, text: 'LIMIT' });
  ({ events } = await settle(app, A, threadId, cursor));
  assert.deepEqual([events.at(-1).state, events.at(-1).error.code, events.at(-1).error.resetsAt], ['error', 'USAGE_LIMIT', '2027-01-15T08:00:00.000Z']);
  await app.close();
  const bare = await f.open({ runtimeFile: undefined });
  const fresh = (await post(bare, { action: 'createThread', requestId: 'n2', title: 'New conversation' })).body.thread.id;
  await post(bare, { action: 'submit', requestId: 'r3', threadId: fresh, text: 'hi' });
  assert.equal((await settle(bare, A, fresh)).events.at(-1).error.code, 'NO_RUNTIME');
});

test('a restart marks an interrupted running turn, never repeats it, and runs a queued one', async t => {
  const f = setup(t, { timeoutMs: 60_000 }), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  await post(app, { action: 'submit', requestId: 'slow', threadId, text: 'SLOW' });
  for (let i = 0; i < 100 && f.calls('blackout').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  // Simulate a crash: drop the server without letting the turn settle.
  const other = await newThread(app, A, 'other');
  const { store } = app;
  store.db.exec("INSERT INTO conv_messages (id, thread_id, role, text, request_id, created_at) VALUES ('11111111-1111-4111-8111-111111111111','" + other + "','user','queued while down','q1',0)");
  store.db.exec("INSERT INTO conv_turns VALUES ('" + other + "','q1','" + store.db.prepare('SELECT companion_id FROM conv_threads WHERE id=?').get(other).companion_id +
    "','11111111-1111-4111-8111-111111111111',NULL,'queued',NULL,0,0)");
  app.server.close(); app.server.closeAllConnections();
  const calls = f.calls('blackout').length;
  const restarted = await f.open();
  const interrupted = (await settle(restarted, A, threadId)).events.findLast(e => e.type === 'turn');
  assert.deepEqual([interrupted.state, interrupted.error.code], ['error', 'INTERRUPTED']);
  const queued = await settle(restarted, A, other);
  assert.equal(queued.events.at(-1).state, 'complete');
  assert.equal(f.calls('blackout').length, calls + 1, 'only the queued turn ran; the interrupted one was not repeated');
  // Clean up the "crashed" instance: its leftover provider process is stopped, its turn already settled.
  await app.conversations.shutdown(); app.store.close();
});

test('a graceful stop records running replies as interrupted and keeps queued ones', async t => {
  const f = setup(t, { timeoutMs: 60_000 }), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  await post(app, { action: 'submit', requestId: 'slow', threadId, text: 'SLOW' });
  for (let i = 0; i < 100 && f.calls('blackout').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 10_000, 'shutdown does not wait for the reply timeout');
  const reopened = await f.open();
  const { events } = await settle(reopened, A, threadId);
  assert.deepEqual([events.at(-1).state, events.at(-1).error.code], ['error', 'INTERRUPTED']);
});

test('requests are validated', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  for (const body of [{ action: 'submit', requestId: 'x', threadId, text: '' }, { action: 'submit', requestId: 'x', threadId, text: 'a'.repeat(8001) },
    { action: 'submit', requestId: 'bad id', threadId, text: 'hi' }, { action: 'events', threadId, cursor: '-1' },
    { action: 'snapshot', threadId: 'nope' }, { action: 'delete', threadId }, { action: 'snapshot', extra: 1 }]) {
    assert.equal((await post(app, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post(app, { action: 'events', threadId, cursor: '99' })).status, 400);
});

test('the browser client drives a real conversation: stream, stop, error and reopen', async t => {
  const { createConversationClient, createConversationTransport } = await import('../public/conversation-client.mjs');
  const f = setup(t, { signedIn: ['blackout'] }), app = await f.open(); await ready(f, app);
  const fetchImpl = (url, options) => fetch(`${app.url}/${url}`, { ...options, mode: undefined,
    headers: { ...options.headers, Origin: app.url, Cookie: COOKIE(A) } });
  let next = 0;
  const client = createConversationClient({ transport: createConversationTransport({ fetchImpl }), requestId: () => `browser-${++next}` });
  const until = async (predicate, label) => {
    for (let i = 0; i < 300; i++) { const state = await client.poll(); if (predicate(state)) return state; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`client did not reach: ${label}`);
  };
  let state = await client.open();
  assert.equal(state.synthetic, false); assert.equal(state.opened, true);
  assert.deepEqual(state.runtime, { state: 'ready', provider: 'claude' });
  state = await client.create('New conversation');
  assert.equal(state.threads.length, 1);
  await client.send('STREAM');
  await assert.rejects(() => client.send('again'), error => error.code === 'BUSY');
  state = await until(s => s.turn?.state === 'complete', 'stream complete');
  assert.equal(state.pending, null);
  assert.deepEqual(state.messages.map(m => [m.role, m.text]), [['user', 'STREAM'], ['assistant', 'one two three four five']]);
  state = await client.refresh();
  assert.equal(state.threads[0].title, 'STREAM'); assert.equal(state.messages.length, 2);

  await client.send('SLOW');
  await until(s => s.messages.at(-1).role === 'assistant' && s.messages.at(-1).text === 'Thinking', 'slow reply started');
  state = await client.cancel();
  assert.equal(state.turn.stopping, true);
  state = await until(s => s.turn?.state === 'cancelled', 'cancelled');
  assert.equal(state.messages.at(-1).text, 'Thinking');

  // A reopened client resumes from the snapshot.
  const other = createConversationClient({ transport: createConversationTransport({ fetchImpl }), requestId: () => 'other-1' });
  const reopened = await other.open();
  assert.equal(reopened.messages.length, 4); assert.equal(reopened.turn, null);
  assert.deepEqual(reopened.messages.map(m => m.text), state.messages.map(m => m.text));

  // An agent error reaches the client with its code and message.
  rmSync(join(f.home('blackout'), 'signed-in'));
  await client.send('hello');
  state = await until(s => s.turn?.state === 'error', 'error');
  assert.equal(state.turn.error.code, 'NOT_SIGNED_IN'); assert.ok(state.turn.error.message.length > 0);
});

test('the companion: profile, memory view and forget, file-based instructions and session rotation', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const api = async (body, proof = A) => {
    const response = await fetch(app.url + '/api/companion', { method: 'POST',
      headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(proof) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const workspace = join(dirname(f.home('blackout')), 'workspace');
  const empty = (await api({ action: 'get' })).body;
  assert.deepEqual({ ...empty, wearing: undefined }, { profile: null, runtime: { state: 'ready', provider: 'claude' }, wearing: undefined });
  assert.equal(typeof empty.wearing, 'string');
  assert.equal((await api({ action: 'setProfile', profile: { name: 'Nova', character: 'pip', color: 'peach', timezone: 'Europe/Paris' } })).status, 200);
  const pinned = (await api({ action: 'setProfile', profile: { character: 'claude', outfit: 'christmas' } })).body;
  assert.deepEqual([pinned.profile.outfit, pinned.wearing], ['christmas', 'christmas']);
  assert.equal((await api({ action: 'get' })).body.wearing, 'christmas');
  assert.equal((await api({ action: 'setProfile', profile: { character: 'pip', outfit: 'auto' } })).status, 200);
  assert.equal((await api({ action: 'setProfile', profile: { name: 'Nova', character: 'robot', color: 'peach' } })).status, 400);
  assert.equal((await api({ action: 'get' }, B)).body.profile, null); // each owner has their own companion
  assert.equal((await api({ action: 'get' }, null)).status, 401);
  assert.deepEqual((await api({ action: 'memory' })).body.files.map(file => [file.file, file.sections.length]), [['USER.md', 0], ['MEMORY.md', 0]]);

  const threadId = await newThread(app);
  let cursor = '0';
  const turn = async (requestId, text) => {
    await post(app, { action: 'submit', requestId, threadId, text });
    ({ cursor } = await settle(app, A, threadId, cursor));
  };
  await turn('t1', 'hello');
  await turn('t2', 'again');
  writeFileSync(join(workspace, 'USER.md'), '# Blackout\n\n## About Blackout\n- Lives in Lyon\n- Secret crush on Mochi\n');
  const memory = (await api({ action: 'memory' })).body.files[0];
  assert.deepEqual(memory.sections[0].items.map(item => item.text), ['Lives in Lyon', 'Secret crush on Mochi']);
  const forgotten = await api({ action: 'forget', file: 'USER.md', id: memory.sections[0].items[1].id });
  assert.equal(forgotten.body.removed, true);
  assert.equal((await api({ action: 'forget', file: 'USER.md', id: memory.sections[0].items[1].id }, B)).body.removed, false); // B's own workspace
  await turn('t3', 'third');

  const calls = f.calls('blackout'), system = call => call.args[call.args.indexOf('--append-system-prompt') + 1];
  assert.equal(calls.length, 3);
  assert.ok(!calls[0].args.includes('--resume') && calls[1].args.includes('--resume') && !calls[2].args.includes('--resume'));
  for (const call of calls) {
    assert.ok(call.args.includes('--permission-mode') && call.args.includes('acceptEdits'));
    assert.deepEqual(call.args.slice(call.args.indexOf('--allowedTools') + 1, call.args.indexOf('--allowedTools') + 6), ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    assert.match(system(call), /^You are Nova, Blackout's personal companion\./);
    assert.match(system(call), /<SOUL\.md>[\s\S]*You're becoming someone/);
  }
  assert.ok(!system(calls[0]).includes('<recent_chat'));
  assert.match(system(calls[2]), /<recent_chat[^>]*>\nBlackout: hello\nNova: [^\n]+\nBlackout: again\nNova: /);
  assert.match(system(calls[2]), /- Lives in Lyon/);
  assert.ok(!system(calls[2]).includes('Secret crush'));
  assert.ok(!system(calls[2]).split('<recent_chat')[1].includes('third')); // the new message is the prompt, not context
  assert.ok(existsSync(join(workspace, 'AGENTS.md')) && existsSync(join(workspace, 'CLAUDE.md')));
});

test('the feeling tag picks the face and never shows in the reply', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  await post(app, { action: 'submit', requestId: 'feel', threadId, text: 'FEELING joke' });
  const { events } = await settle(app, A, threadId);
  const replies = events.filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => e.message);
  assert.ok(replies.length >= 1);
  for (const reply of replies) assert.doesNotMatch(reply.text, /feel|\[/, 'no part of the tag is ever shown');
  assert.deepEqual([replies.at(-1).text, replies.at(-1).feeling], ['Ha, yes!', 'laugh']);
  const snapshot = (await post(app, { action: 'snapshot', threadId })).body;
  assert.deepEqual(snapshot.messages.at(-1), { id: replies.at(-1).id, threadId, role: 'assistant', text: 'Ha, yes!', requestId: 'feel', feeling: 'laugh' });
  assert.equal(snapshot.messages[0].feeling, undefined, 'user messages have no feeling');
  // The instructions ask for the tag and tell the companion how it looks.
  const prompt = f.calls('blackout')[0].args[f.calls('blackout')[0].args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /Follow AGENTS\.md/);
  const agents = readFileSync(join(f.home('blackout'), '..', 'workspace', 'AGENTS.md'), 'utf8');
  assert.match(agents, /\[feeling:laugh\]/);
  assert.match(agents, /version 2/);
});
