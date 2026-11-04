import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations } from '../src/conversations.mjs';
import { createConversationClient } from '../public/conversation-client.mjs';

// Real-conversation account mode with synthetic accounts and fake provider programs:
// no platform login, provider account or model usage is involved.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUER = 'https://synthetic.invalid';
const PA = { issuer: ISSUER, subject: 'synthetic-owner-a' }, PB = { issuer: ISSUER, subject: 'synthetic-owner-b' };
const A = 'A'.repeat(43), B = 'B'.repeat(43);
const COOKIE = value => `__Secure-blackout_session=${value}`;

function setup(t, { signedIn = ['blackout', 'screamer'], timeoutMs, ownerSettings = {}, wakeReply } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conversation-account-')));
  const binaries = {};
  for (const name of ['claude', 'codex']) {
    const file = join(dir, `fake-${name}.cjs`);
    let source = readFileSync(join(ROOT, 'test/fixtures', `fake-${name}.cjs.txt`), 'utf8');
    if (name === 'claude' && wakeReply !== undefined) {
      const seam = "  if (prompt.includes('LIMIT')) {";
      assert.ok(source.includes(seam));
      source = source.replace(seam, `  if (prompt.includes('private background')) {
    const result = ${JSON.stringify(wakeReply)};
    for (const part of [result.slice(0, 5), result.slice(5, 18), result.slice(18)]) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
    }
    out({ type: 'result', subtype: 'success', is_error: false, result, session_id: session }); return;
  }
` + seam);
    }
    writeFileSync(file, source); chmodSync(file, 0o755); binaries[name] = file;
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

test('recovery: fresh devices retain partial interruption context without replaying events or provider work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-recovery-direct-')), store = new BootstrapStore(dir, ROOT), owner = randomUUID(), other = randomUUID();
  let finish, calls = 0;
  const result = new Promise(resolve => { finish = resolve; });
  const original = new Conversations({ store, flushMs: 1, runner: { async turn(_owner, input) {
    calls++; input.onEvent({ type: 'delta', text: 'A partial answer' }); return result;
  } } });
  const recovered = new Conversations({ store, runner: { async turn() { calls++; return { text: 'A new complete answer' }; } } });
  t.after(async () => { finish({ text: 'Late original answer' }); await original.shutdown(); await recovered.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const runtime = async () => ({ state: 'ready', provider: 'claude' });
  const threadId = (await original.handle(owner, { action: 'createThread', requestId: 'recovery-thread', title: 'Own chat' })).thread.id;
  await original.handle(owner, { action: 'submit', requestId: 'interrupted-request', threadId, text: 'Original owner question' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const running = await original.handle(owner, { action: 'snapshot', threadId }, { runtime });
  assert.equal(running.turn.state, 'streaming'); assert.equal(running.messages.at(-1).text, 'A partial answer');
  assert.equal(recovered.recover(), 1);
  const snapshot = await recovered.handle(owner, { action: 'snapshot', threadId }, { runtime });
  assert.equal(snapshot.turn.state, 'error'); assert.equal(snapshot.turn.error.code, 'INTERRUPTED');
  assert.equal(snapshot.messages.at(-1).text, 'A partial answer');
  const clientFor = () => createConversationClient({ transport: (action, payload) => recovered.handle(owner, { action, ...payload }, { runtime }) });
  const device = clientFor(), second = clientFor(); await device.open({ threadId }); await second.open({ threadId });
  assert.deepEqual(device.getState().turn, snapshot.turn); assert.deepEqual(second.getState().turn, snapshot.turn);
  await device.poll(); assert.deepEqual(device.getState().turn, snapshot.turn); assert.equal(device.getState().cursor, snapshot.cursor);
  assert.deepEqual((await recovered.handle(owner, { action: 'events', threadId, cursor: snapshot.cursor })).events, []);
  await assert.rejects(() => recovered.handle(other, { action: 'snapshot', threadId }, { runtime }), { code: 'NOT_FOUND' });
  assert.equal((await recovered.handle(other, { action: 'snapshot' }, { runtime })).turn, undefined);
  finish({ text: 'Late original answer' }); await original.idle(); assert.equal(calls, 1);
  assert.deepEqual((await recovered.handle(owner, { action: 'snapshot', threadId }, { runtime })).turn, snapshot.turn);
  const accepted = await device.send('A new owner question'); assert.equal(accepted.status, 'accepted'); await recovered.idle();
  await device.refresh(); await second.refresh();
  assert.equal(device.getState().turn, null); assert.equal(second.getState().turn, null);
  assert.equal(device.getState().messages.at(-1).text, 'A new complete answer'); assert.equal(calls, 2);
});

test('recovery: fresh snapshots show cancellation only until a newer own turn supersedes it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-cancel-context-')), store = new BootstrapStore(dir, ROOT), owner = randomUUID();
  let finish, finishLater, first = true;
  const wait = new Promise(resolve => { finish = resolve; }), later = new Promise(resolve => { finishLater = resolve; });
  const conversations = new Conversations({ store, flushMs: 1, runner: { async turn(_owner, input) {
    if (first) { first = false; input.onEvent({ type: 'delta', text: 'Partial stopped answer' }); return wait; }
    return later;
  } } });
  t.after(async () => { finish({ text: 'Ignored stopped answer' }); finishLater({ text: 'Completed later answer' }); await conversations.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const runtime = async () => ({ state: 'ready', provider: 'codex' });
  const threadId = (await conversations.handle(owner, { action: 'createThread', requestId: 'cancel-context-thread', title: 'Own chat' })).thread.id;
  await conversations.handle(owner, { action: 'submit', requestId: 'cancel-context-request', threadId, text: 'Stop this reply' });
  await new Promise(resolve => setTimeout(resolve, 10));
  await conversations.handle(owner, { action: 'cancel', requestId: 'cancel-context-request', threadId }); finish({ text: 'Ignored stopped answer' }); await conversations.idle();
  const stopped = await conversations.handle(owner, { action: 'snapshot', threadId }, { runtime });
  assert.deepEqual(stopped.turn, { requestId: 'cancel-context-request', state: 'cancelled' });
  assert.equal(stopped.messages.at(-1).text, 'Partial stopped answer');
  await conversations.handle(owner, { action: 'submit', requestId: 'newer-context-request', threadId, text: 'Continue later' });
  const active = await conversations.handle(owner, { action: 'snapshot', threadId }, { runtime });
  assert.equal(active.turn.requestId, 'newer-context-request'); assert.equal(active.turn.state, 'streaming');
  finishLater({ text: 'Completed later answer' });
  await conversations.idle(); assert.equal((await conversations.handle(owner, { action: 'snapshot', threadId }, { runtime })).turn, undefined);
});

test('personality HTTP controls are private, complete, revision-bound and preserve other owner sessions and memory', async t => {
  const f=setup(t), app=await f.open(); await ready(f,app);
  const api=async(body,proof=A)=>{
    const response=await fetch(app.url+'/api/companion',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json',...(proof?{Cookie:COOKIE(proof)}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  assert.equal((await api({action:'personality'},null)).status,401);
  assert.equal((await fetch(app.url+'/SOUL.md')).status,404); assert.equal((await fetch(app.url+'/personality_versions')).status,404);
  assert.equal((await fetch(app.url+'/personality-ui.mjs')).status,200);
  assert.equal((await api({action:'personality'})).status,200,'first use initializes only the normal native workspace');
  await api({action:'memory'}); await api({action:'memory'},B);
  const workspace=join(dirname(f.home('blackout')),'workspace'), other=join(dirname(f.home('screamer')),'workspace');
  writeFileSync(join(workspace,'SOUL.md'),'\uFEFF# Voice\r\nOriginal raw prose.\r\n'); writeFileSync(join(other,'SOUL.md'),'OTHER-OWNER-PERSONALITY');
  const initial=(await api({action:'personality'})).body;
  assert.equal(initial.content,'\uFEFF# Voice\r\nOriginal raw prose.\r\n'); assert.deepEqual(initial.history,[]);
  assert.equal((await api({action:'personalityVersion',revision:initial.revision},B)).status,404);
  const threadId=await newThread(app,A,'personality-owner-a'), otherThread=await newThread(app,B,'personality-owner-b');
  await post(app,{action:'submit',threadId,requestId:'personality-a',text:'Hello'});
  await post(app,{action:'submit',threadId:otherThread,requestId:'personality-b',text:'Hello'},B); await app.conversations.idle();
  const otherSession=app.store.db.prepare('SELECT provider_session FROM conv_threads WHERE id=?').get(otherThread).provider_session;
  const observed=(await api({action:'personality'})).body; assert.equal(observed.history[0].revision,initial.revision);
  const content='\uFEFF# Voice\r\n'+('Full prose beyond old request limit.\t\r\n'.repeat(2400));
  const changed=await api({action:'editPersonality',content,expectedRevision:initial.revision}); assert.equal(changed.status,200); assert.equal(changed.body.content,content);
  assert.equal(app.store.db.prepare('SELECT provider_session FROM conv_threads WHERE id=?').get(threadId).provider_session,null);
  assert.equal(app.store.db.prepare('SELECT provider_session FROM conv_threads WHERE id=?').get(otherThread).provider_session,otherSession);
  assert.equal((await api({action:'editPersonality',content:'stale',expectedRevision:initial.revision})).status,409);
  assert.equal((await api({action:'restorePersonality',revision:initial.revision,expectedRevision:changed.body.revision,confirm:true},B)).status,404);
  const restored=await api({action:'restorePersonality',revision:initial.revision,expectedRevision:changed.body.revision,confirm:true});
  assert.equal(restored.status,200); assert.equal(restored.body.content,initial.content); assert.equal(restored.body.history[0].source,'owner_restore');
  const notes=(await api({action:'memory'})).body;
  assert.equal((await api({action:'forgetAll',confirm:true,expectedRevision:notes.revision})).status,200);
  assert.equal((await api({action:'personality'})).body.content,initial.content);
  assert.ok(!JSON.stringify((await api({action:'exportMemory'})).body).includes('Original raw prose'));
  assert.equal((await api({action:'personality',companionId:'foreign'})).status,400);
  assert.equal((await api({action:'editPersonality',content:'x'.repeat(2*1024*1024+1),expectedRevision:initial.revision})).status,413);
  await app.close();
  const restarted=await f.open(); await ready(f,restarted);
  const response=await fetch(restarted.url+'/api/companion',{method:'POST',headers:{Origin:restarted.url,'Content-Type':'application/json',Cookie:COOKIE(A)},body:JSON.stringify({action:'personality'})});
  assert.equal(response.status,200); const retained=await response.json();
  assert.equal(retained.content,initial.content); assert.equal(retained.history.length,2);
  assert.equal(retained.history[0].revision,initial.revision,'private history survives a closed connection and server restart');
});

test('complete private memory controls use current file CAS and export only the signed-in owner notes and diary', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const module = await fetch(app.url + '/memory-ui.mjs');
  assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /javascript/);
  assert.match(await module.text(), /export function createMemoryUI/);
  assert.equal((await fetch(app.url + '/USER.md')).status, 404);
  assert.equal((await fetch(app.url + '/memory/2026-11-02.md')).status, 404);
  const api = async (body, proof = A) => {
    const response = await fetch(app.url + '/api/companion', { method: 'POST', headers: { Origin: app.url,
      'Content-Type': 'application/json', ...(proof ? { Cookie: COOKIE(proof) } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await api({ action: 'memory' }); await api({ action: 'memory' }, B);
  const workspace = join(dirname(f.home('blackout')), 'workspace'), other = join(dirname(f.home('screamer')), 'workspace');
  const soul = readFileSync(join(workspace, 'SOUL.md'), 'utf8');
  writeFileSync(join(workspace, 'USER.md'), '# About\nNon-bullet prose stays intact.\n- Same note\n- Same note\n');
  writeFileSync(join(workspace, 'memory', '2026-11-02.md'), 'PRIVATE-DIARY-CANARY\nDiary prose.\n');
  writeFileSync(join(other, 'USER.md'), '# Other owner\n- OTHER-OWNER-CANARY\n');
  const initial = (await api({ action: 'memory' })).body, user = initial.files.find(file => file.file === 'USER.md');
  assert.match(user.content, /Non-bullet prose stays intact/); assert.match(user.modifiedAtISO, /^2026|^20\d\d/);
  const items = user.sections.flatMap(section => section.items); assert.notEqual(items[0].id, items[1].id);
  const diary = initial.files.find(file => file.file === 'memory/2026-11-02.md'); assert.equal(diary.readOnly, true);
  assert.equal((await api({ action: 'editMemory', file: user.file, id: items[0].id, text: 'Corrected note', expectedRevision: user.revision })).status, 200);
  assert.equal((await api({ action: 'forget', file: user.file, id: items[1].id, expectedRevision: user.revision })).status, 409);
  assert.equal((await api({ action: 'forget', file: user.file, id: items[0].id, expectedRevision: user.revision }, B)).status, 409);
  assert.equal((await api({ action: 'exportMemory' }, null)).status, 401);
  const exported = (await api({ action: 'exportMemory' })).body.export;
  assert.equal(exported.format, 'companion-memory-v1');
  assert.match(exported.files.find(file => file.file === 'USER.md').content, /Corrected note\n- Same note/);
  assert.match(exported.files.find(file => file.file.startsWith('memory/')).content, /PRIVATE-DIARY-CANARY/);
  assert.ok(!JSON.stringify(exported).includes('OTHER-OWNER-CANARY')); assert.ok(!exported.files.some(file => file.file === 'SOUL.md'));
  assert.ok(!JSON.stringify((await api({ action: 'exportMemory' }, B)).body).includes('PRIVATE-DIARY-CANARY'));
  assert.equal((await api({ action: 'editMemory', file: diary.file, id: items[0].id, text: 'no', expectedRevision: diary.revision })).status, 403);
  const threadId = await newThread(app); await post(app, { action: 'submit', requestId: 'memory-chat', threadId, text: 'Keep this conversation.' }); await app.conversations.idle();
  const current = (await api({ action: 'memory' })).body, currentUser = current.files.find(file => file.file === 'USER.md');
  const corrected = currentUser.sections.flatMap(section => section.items).find(item => item.text === 'Corrected note');
  assert.equal((await api({ action: 'forget', file: user.file, id: corrected.id, expectedRevision: currentUser.revision })).body.removed, true);
  assert.ok(existsSync(join(workspace, diary.file)), 'single bullet forget leaves diary');
  assert.ok((await post(app, { action: 'snapshot', threadId })).body.messages.some(message => message.text === 'Keep this conversation.'));
  assert.equal((await api({ action: 'forgetAll', expectedRevision: initial.revision, confirm: true })).status, 409);
  const all = (await api({ action: 'memory' })).body;
  assert.equal((await api({ action: 'forgetAll', expectedRevision: all.revision, confirm: false })).status, 400);
  assert.equal((await api({ action: 'forgetAll', expectedRevision: all.revision, confirm: true })).body.cleared, true);
  assert.equal(readFileSync(join(workspace, 'USER.md'), 'utf8'), ''); assert.equal(readFileSync(join(workspace, 'MEMORY.md'), 'utf8'), '');
  assert.equal(existsSync(join(workspace, diary.file)), false); assert.equal(readFileSync(join(workspace, 'SOUL.md'), 'utf8'), soul);
  assert.match(readFileSync(join(other, 'USER.md'), 'utf8'), /OTHER-OWNER-CANARY/);
  assert.ok((await post(app, { action: 'snapshot', threadId })).body.messages.some(message => message.text === 'Keep this conversation.'));
});

test('owner API refuses memory writes during normal and wake lanes and resets durably before publishing bytes', async t => {
  const f = setup(t), app = await f.open({ conversationOptions: { wakePolicy: { beforeStart: () => true, canDeliver: () => true } } }); await ready(f, app);
  const api = async body => {
    const response = await fetch(app.url + '/api/companion', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(A) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await api({ action: 'memory' }); const workspace = join(dirname(f.home('blackout')), 'workspace');
  writeFileSync(join(workspace, 'USER.md'), '## Facts\n- Original note\n');
  const current = (await api({ action: 'memory' })).body, user = current.files.find(file => file.file === 'USER.md');
  const edit = { action: 'editMemory', file: user.file, id: user.sections[0].items[0].id, text: 'Corrected note', expectedRevision: user.revision };
  const threadId = await newThread(app); await post(app, { action: 'submit', requestId: 'memory-slow', threadId, text: 'SLOW synthetic reply' });
  const busy = await api(edit); assert.equal(busy.status, 409); assert.equal(busy.body.error.code, 'MEMORY_BUSY');
  assert.equal((await api({ action: 'forgetAll', expectedRevision: current.revision, confirm: true })).body.error.code, 'MEMORY_BUSY');
  await post(app, { action: 'cancel', threadId, requestId: 'memory-slow' }); await app.conversations.idle();
  assert.equal(readFileSync(join(workspace, 'USER.md'), 'utf8'), user.content);
  const reset = app.conversations.resetSessions.bind(app.conversations);
  app.conversations.resetSessions = () => { throw new Error('PRIVATE-SYNTHETIC-DB-FAILURE'); };
  const failed = await api(edit); assert.equal(failed.status, 503); assert.ok(!JSON.stringify(failed.body).includes('PRIVATE-SYNTHETIC'));
  assert.equal(readFileSync(join(workspace, 'USER.md'), 'utf8'), user.content); app.conversations.resetSessions = reset;
  assert.equal((await api(edit)).body.changed, true);
  const session = await fetch(app.url + '/api/session', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(A) }, body: '{}' }).then(response => response.json());
  const admitted = app.conversations.enqueueProactive(session.companionId, { id: randomUUID(), kind: 'reminder', prompt: 'SLOW private wake' });
  const latest = (await api({ action: 'memory' })).body;
  assert.equal((await api({ action: 'forgetAll', expectedRevision: latest.revision, confirm: true })).body.error.code, 'MEMORY_BUSY');
  await post(app, { action: 'cancel', threadId: admitted.threadId, requestId: admitted.requestId }); await app.conversations.idle();
  assert.equal((await api({ action: 'forgetAll', expectedRevision: latest.revision, confirm: true })).body.cleared, true);
});

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
    assert.ok(native.includes('WebSearch') && native.includes('WebFetch'), 'Both owners can look things up in chat (#42 default)');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    const servers = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers;
    assert.deepEqual(Object.keys(servers), label === 'blackout' ? ['board', 'appdocs', 'scheduler', 'files'] : ['appdocs', 'scheduler', 'files']);
    assert.ok(args.includes('mcp__scheduler__create_schedule'));
    assert.match(servers.scheduler.env.COMPANION_SCHEDULER_TOKEN, /^[a-f0-9]{64}$/);
    assert.equal(servers.scheduler.env.COMPANION_SCHEDULER_URL, app.url + '/internal/scheduler');
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

test('the application wrapper consumes a rejected async tool factory and refuses before provider launch', async t => {
  const f = setup(t), app = await f.open({ runnerOptions: { statusTtlMs: 0,
    mcpServersFor: async () => { throw new Error('PRIVATE-APP-FACTORY-CANARY'); } } });
  await ready(f, app);
  const threadId = await newThread(app);
  await post(app, { action: 'submit', requestId: 'async-app-refused', threadId, text: 'hello' });
  const result = await settle(app, A, threadId);
  assert.equal(result.events.at(-1).state, 'error');
  assert.equal(result.events.at(-1).error.code, 'TOOL_POLICY_REFUSED');
  assert.equal(f.calls('blackout').length, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-APP-FACTORY-CANARY'));
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
  assert.ok(calls[0].args.includes('--system-prompt') && calls[0].args[calls[0].args.indexOf('--system-prompt') + 1].includes("Blackout's personal companion"));
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

test('retries are idempotent, conflicting reuse is refused and a message sent during a reply gets its own turn after it', async t => {
  const f = setup(t), app = await f.open(); await ready(f, app);
  const threadId = await newThread(app);
  const request = { action: 'submit', requestId: 'once', threadId, text: 'STREAM' };
  const first = await post(app, request);
  assert.deepEqual((await post(app, request)).body, first.body);
  assert.equal((await post(app, { ...request, text: 'different' })).status, 409);
  const queued = await post(app, { action: 'submit', requestId: 'twice', threadId, text: 'again' });
  assert.equal(queued.status, 200);
  await settle(app, A, threadId);
  for (let i = 0; i < 200 && f.calls('blackout').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.calls('blackout').length, 2);
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
  assert.equal(await client.typing(true), true, 'the typing hint reaches the server'); assert.equal(await client.typing(false), true);
  await client.send('STREAM');
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
  assert.equal(reopened.messages.length, 4);
  assert.deepEqual(reopened.turn, { requestId: state.turn.requestId, state: 'cancelled' });
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
  const forgotten = await api({ action: 'forget', file: 'USER.md', id: memory.sections[0].items[1].id, expectedRevision: memory.revision });
  assert.equal(forgotten.body.removed, true);
  assert.equal((await api({ action: 'forget', file: 'USER.md', id: memory.sections[0].items[1].id, expectedRevision: memory.revision }, B)).status, 404); // B's own notes do not exist yet; A is never selected.
  await turn('t3', 'third');

  const calls = f.calls('blackout'), system = call => call.args[call.args.indexOf('--system-prompt') + 1];
  assert.equal(calls.length, 3);
  assert.ok(!calls[0].args.includes('--resume') && calls[1].args.includes('--resume') && !calls[2].args.includes('--resume'));
  for (const call of calls) {
    assert.ok(call.args.includes('--permission-mode') && call.args.includes('acceptEdits'));
    assert.deepEqual(call.args.slice(call.args.indexOf('--allowedTools') + 1, call.args.indexOf('--allowedTools') + 8), ['WebSearch', 'WebFetch', 'Read', 'Edit', 'Write', 'Glob', 'Grep']);
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
  const prompt = f.calls('blackout')[0].args[f.calls('blackout')[0].args.indexOf('--system-prompt') + 1];
  assert.match(prompt, /Follow AGENTS\.md/);
  const agents = readFileSync(join(f.home('blackout'), '..', 'workspace', 'AGENTS.md'), 'utf8');
  assert.match(agents, /\[feeling:laugh\]/);
  assert.match(agents, /version 22/);
  assert.match(agents, /## Board work/);
  assert.match(agents, /## Following Board work/);
});

test('account user and tagged wake turns share native continuity while outfit and forget reset fresh instructions', async t => {
  const wakeText = 'A kind reminder from your companion.';
  const f = setup(t, { wakeReply: '[feeling:tender] ' + JSON.stringify({ action: 'message', text: wakeText }) });
  const app = await f.open({ conversationOptions: { flushMs: 1,
    wakePolicy: { beforeStart: () => true, canDeliver: () => true } } });
  await ready(f, app);
  const companion = async body => {
    const response = await fetch(app.url + '/api/companion', { method: 'POST',
      headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(A) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await companion({ action: 'setProfile', profile: { name: 'Nova', character: 'claude', color: 'peach', outfit: 'base' } })).status, 200);
  const session = await fetch(app.url + '/api/session', { method: 'POST',
    headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(A) }, body: '{}' }).then(response => response.json());
  const threadId = await newThread(app), wakeIds = [];
  const userTurn = async (requestId, text) => {
    assert.equal((await post(app, { action: 'submit', requestId, threadId, text })).status, 200);
    await app.conversations.idle();
  };
  const wakeTurn = async () => {
    const id = randomUUID(); wakeIds.push(id);
    const accepted = app.conversations.enqueueProactive(session.companionId, {
      id, kind: 'reminder', prompt: 'PRIVATE-NATIVE-WAKE-PROMPT-CANARY'
    });
    assert.equal(accepted.threadId, threadId);
    await app.conversations.idle();
    assert.equal(app.conversations.proactiveResult(session.companionId, id).state, 'message');
  };
  await userTurn('before-wake', 'Hello.'); await wakeTurn(); await userTurn('after-wake', 'FEELING joke');
  assert.equal((await companion({ action: 'setProfile', profile: { outfit: 'christmas' } })).body.wearing, 'christmas');
  await wakeTurn();
  const workspace = join(dirname(f.home('blackout')), 'workspace');
  writeFileSync(join(workspace, 'USER.md'), '# Blackout\n\n## Preferences\n- Keeps the release notes\n- PRIVATE-FORGOTTEN-NATIVE-MEMORY\n');
  await userTurn('after-outfit-wake', 'Thanks for the new outfit.');
  const memory = (await companion({ action: 'memory' })).body.files.find(file => file.file === 'USER.md');
  const forgotten = memory.sections.flatMap(section => section.items).find(item => item.text === 'PRIVATE-FORGOTTEN-NATIVE-MEMORY');
  assert.ok(forgotten);
  assert.equal((await companion({ action: 'forget', file: 'USER.md', id: forgotten.id, expectedRevision: memory.revision })).body.removed, true);
  await wakeTurn(); await userTurn('after-forget-wake', 'Thank you again.');

  const calls = f.calls('blackout'), system = call => call.args[call.args.indexOf('--system-prompt') + 1];
  assert.equal(calls.length, 7);
  for (const index of [1, 2, 4, 6]) assert.ok(calls[index].args.includes('--resume'));
  for (const index of [0, 3, 5]) assert.ok(!calls[index].args.includes('--resume'));
  assert.match(system(calls[0]), /signature cream ruffled blouse/);
  assert.match(system(calls[3]), /red Santa dress/);
  assert.match(system(calls[3]), /<recent_chat[\s\S]*A kind reminder from your companion\./);
  assert.ok(system(calls[4]).includes('PRIVATE-FORGOTTEN-NATIVE-MEMORY'));
  assert.ok(!system(calls[5]).includes('PRIVATE-FORGOTTEN-NATIVE-MEMORY'));
  assert.match(system(calls[5]), /Keeps the release notes/);
  for (const index of [1, 3, 5]) {
    assert.match(system(calls[index]), /^You are Nova, Blackout's personal companion\./);
    assert.match(calls[index].prompt, /private background reminder/);
    const recent = system(calls[index]).split('<recent_chat')[1] ?? '';
    assert.ok(!recent.includes('PRIVATE-NATIVE-WAKE-PROMPT-CANARY'));
    assert.ok(!recent.includes('[feeling:') && !recent.includes('"action":"message"'));
  }
  const view = (await post(app, { action: 'snapshot', threadId })).body;
  assert.equal(view.messages.filter(row => row.role === 'user').length, 4);
  for (const id of wakeIds) {
    const row = view.messages.find(item => item.requestId === 'wake-' + id);
    assert.deepEqual([row.role, row.text, row.feeling], ['assistant', wakeText, 'tender']);
  }
  assert.deepEqual(view.messages.filter(row => row.requestId === 'after-wake' && row.role === 'assistant').map(row => [row.text, row.feeling]), [['Ha, yes!', 'laugh']]);
  const history = (await post(app, { action: 'events', threadId, cursor: '0' })).body;
  for (const value of [view, history]) {
    assert.ok(!JSON.stringify(value).includes('PRIVATE-NATIVE-WAKE-PROMPT-CANARY'));
    assert.ok(!JSON.stringify(value).includes('[feeling:'));
    assert.ok(!JSON.stringify(value).includes('"action":"message"'));
  }
});
