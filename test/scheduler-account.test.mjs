import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUER = 'https://synthetic.invalid';
const PA = { issuer: ISSUER, subject: 'scheduler-account-a' }, PB = { issuer: ISSUER, subject: 'scheduler-account-b' };
const A = 'A'.repeat(43), B = 'B'.repeat(43), MINUTE = 60000, HOUR = 60 * MINUTE;
const cookie = proof => `__Secure-blackout_session=${proof}`;
const iso = value => new Date(value).toISOString();

// Only this local fake provider can be launched by the application's Runner.
// The real scheduler stdio child is exercised separately below, against loopback only.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.CLAUDE_CONFIG_DIR, args = process.argv.slice(2);
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({loggedIn:true,subscriptionType:'synthetic'})); process.exit(0); }
let prompt = ''; process.stdin.on('data', value => prompt += value); process.stdin.on('end', async () => {
  const label = path.basename(path.dirname(home));
  fs.appendFileSync(path.join(home,'calls.jsonl'), JSON.stringify({args,prompt,home,cwd:process.cwd()})+'\\n');
  const out = value => process.stdout.write(JSON.stringify(value)+'\\n');
  const session = args.includes('--resume') ? args[args.indexOf('--resume')+1] : 'synthetic-'+label;
  out({type:'system',subtype:'init',session_id:session});
  const wake = prompt.startsWith('This is a private background ');
  const result = wake ? JSON.stringify(prompt.includes('background heartbeat wake') || fs.existsSync(path.join(home,'silent')) ? {action:'silent'} :
    {action:'message',text:'Scheduled hello for '+label}) : 'Natural reply for '+label;
  out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:result.slice(0,12)}}});
  while (fs.existsSync(path.join(home,'hold')) && !fs.existsSync(path.join(home,'release'))) {
    await new Promise(resolve => setTimeout(resolve,10));
  }
  out({type:'result',subtype:'success',is_error:false,result,session_id:session});
});
`;

function fixture(t, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scheduler-account-'))), apps = new Set(), children = new Set();
  const fake = join(dir, 'fake-claude.cjs'), runtimeFile = join(dir, 'owners.json');
  writeFileSync(fake, FAKE.replaceAll('\r\n', '\n'));
  writeFileSync(runtimeFile, JSON.stringify({ owners: [
    { subject: PA.subject, issuer: ISSUER, label: 'blackout', provider: 'claude' },
    { subject: PB.subject, issuer: ISSUER, label: 'screamer', provider: 'claude' }
  ] }));
  const f = { dir, proofs: new Map([[A, PA], [B, PB]]), validations: [], clock: Date.UTC(2026, 10, 2, 12), ids: {} };
  f.home = label => join(dir, 'runtimes', label, 'claude-home');
  f.calls = label => {
    const path = join(f.home(label), 'calls.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  f.hold = label => { writeFileSync(join(f.home(label), 'hold'), ''); rmSync(join(f.home(label), 'release'), { force: true }); };
  f.release = label => writeFileSync(join(f.home(label), 'release'), '');
  f.open = async () => {
    const app = await startServer({ dataDir: join(dir, 'data'), mode: 'account', port: 0,
      pilotSubjects: [PA, PB], validateAccount: async proof => { f.validations.push(proof); return f.proofs.get(proof) ?? null; },
      runtimeFile, runtimeDir: join(dir, 'runtimes'), binaries: { claude: fake },
      runnerOptions: { statusTtlMs: 0, spawnImpl(binary, args, options) {
        assert.equal(binary, fake, 'The application may execute only this synthetic provider');
        return spawn(process.execPath, [fake, ...args], options);
      } },
      conversationOptions: { now: () => f.clock, flushMs: 1, ...options.conversation }, schedulerOptions: { now: () => f.clock, pollMs: HOUR, proactiveByDefault: false, ...options.scheduler } });
    apps.add(app); return app;
  };
  f.close = async app => { await app.close(); apps.delete(app); };
  f.track = child => { children.add(child); child.once('close', () => children.delete(child)); return child; };
  t.after(async () => {
    for (const child of children) child.kill();
    for (const app of apps) await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return f;
}

async function post(app, path, body, proof = A, extra = {}) {
  const response = await fetch(app.url + path, { method: 'POST', headers: {
    Origin: app.url, 'Content-Type': 'application/json', ...(proof ? { Cookie: cookie(proof) } : {}), ...extra
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const schedules = (app, body, proof = A, extra) => post(app, '/api/schedules', body, proof, extra);
const chat = (app, body, proof = A) => post(app, '/api/conversation', body, proof);
async function ready(f, app) {
  for (const [proof, label] of [[A, 'blackout'], [B, 'screamer']]) {
    const session = await post(app, '/api/session', {}, proof); assert.equal(session.status, 200);
    assert.equal(session.body.runtime.state, 'ready'); f.ids[proof] = session.body.companionId;
    const profile = await post(app, '/api/companion', { action: 'setProfile', profile: {
      name: label, character: 'pip', color: 'mint', timezone: 'UTC'
    } }, proof);
    assert.equal(profile.status, 200);
  }
  await app.scheduler.tick();
}
async function settle(app) { await app.scheduler.tick(); await app.conversations.idle(); await app.scheduler.tick(); }
async function until(predicate) {
  for (let count = 0; count < 300; count++) { if (predicate()) return; await delay(10); }
  throw new Error('Synthetic provider did not reach the expected boundary');
}
function descriptor(call) {
  const index = call.args.indexOf('--mcp-config'); assert.notEqual(index, -1);
  const config = JSON.parse(call.args[index + 1]);
  assert.ok(call.args.includes('mcp__scheduler__create_schedule'));
  return config.mcpServers.scheduler;
}

async function mcpChild(f, config) {
  assert.equal(config.command, process.execPath);
  assert.deepEqual(config.args, [join(ROOT, 'src', 'scheduler-mcp.mjs')]);
  const child = f.track(spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] }));
  let buffer = '', nextId = 0; const pending = new Map();
  child.stdout.setEncoding('utf8').on('data', value => {
    buffer += value; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const result = JSON.parse(line), waiter = pending.get(result.id);
      if (waiter) { pending.delete(result.id); clearTimeout(waiter.timer); waiter.resolve(result); }
    }
  });
  child.on('error', error => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear(); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic MCP response timed out')); }, 5000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'companion-scheduler');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  return { request, call: (name, args) => request('tools/call', { name, arguments: args }), child };
}
function toolValue(response) {
  assert.equal(response.result?.isError, false);
  return JSON.parse(response.result.content[0].text);
}

test('authenticated reminders run with clients closed, remain owner-private and never replay after reopening', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  const input = { requestId: 'offline-reminder', text: 'Owner A private reminder', dueAt: iso(f.clock + MINUTE) };
  const before = f.validations.length;
  const created = await schedules(app, { action: 'create', input });
  assert.equal(created.status, 200); assert.ok(f.validations.length > before, 'The write revalidates the platform session');
  const id = created.body.items[0].id;
  assert.equal((await schedules(app, { action: 'create', input })).body.items[0].id, id);
  assert.deepEqual((await schedules(app, { action: 'list' }, B)).body.items, []);
  assert.equal((await schedules(app, { action: 'cancel', input: { id } }, B)).status, 404);
  assert.equal((await schedules(app, { action: 'list' }, null)).status, 401);
  assert.equal((await schedules(app, { action: 'list' }, A, { Origin: 'https://foreign.invalid' })).status, 403);
  f.proofs.delete(A);
  assert.equal((await schedules(app, { action: 'create', input: { ...input, requestId: 'revoked-session' } })).status, 401);
  f.proofs.set(A, PA);
  // No client polling or user chat submission occurs between scheduling and delivery.
  f.clock += MINUTE; await settle(app);
  assert.equal(f.calls('blackout').length, 1); assert.equal(f.calls('screamer').length, 0);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_messages WHERE role='user'").get().n, 0);
  const own = await chat(app, { action: 'snapshot' });
  assert.equal(own.body.messages.length, 1); assert.equal(own.body.messages[0].role, 'assistant');
  assert.equal(own.body.messages[0].text, 'Scheduled hello for blackout');
  assert.deepEqual((await chat(app, { action: 'snapshot' }, B)).body.messages, []);
  await f.close(app);
  const reopened = await f.open(); await settle(reopened);
  assert.equal(f.calls('blackout').length, 1);
  assert.deepEqual((await chat(reopened, { action: 'snapshot' })).body.messages, own.body.messages);
  assert.equal((await schedules(reopened, { action: 'list' })).body.items[0].state, 'complete');
});

test('quiet hours defer admission and buffer an already-running result until delivery is allowed', async t => {
  const f = fixture(t); f.clock = Date.UTC(2026, 10, 2, 21, 59);
  const app = await f.open(); await ready(f, app);
  await schedules(app, { action: 'create', input: { requestId: 'quiet-queued', text: 'Morning reminder', dueAt: iso(f.clock + MINUTE) } });
  f.clock += MINUTE; await settle(app); assert.equal(f.calls('blackout').length, 0);
  f.clock = Date.UTC(2026, 10, 3, 8); await settle(app); assert.equal(f.calls('blackout').length, 1);
  assert.equal((await chat(app, { action: 'snapshot' })).body.messages.length, 1);
  f.clock = Date.UTC(2026, 10, 3, 21, 50); f.hold('blackout');
  await schedules(app, { action: 'create', input: { requestId: 'quiet-delivery', text: 'Buffered reminder', dueAt: iso(f.clock + MINUTE) } });
  f.clock += MINUTE; await app.scheduler.tick(); await until(() => f.calls('blackout').length === 2);
  assert.equal((await chat(app, { action: 'snapshot' })).body.messages.length, 1, 'Partial provider deltas remain private');
  f.clock = Date.UTC(2026, 10, 3, 22); f.release('blackout'); await app.conversations.idle(); await app.scheduler.tick();
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE state='waiting_delivery'").get().n, 1);
  assert.equal((await chat(app, { action: 'snapshot' })).body.messages.length, 1);
  f.clock = Date.UTC(2026, 10, 4, 8); await settle(app);
  assert.equal(f.calls('blackout').length, 2, 'Delivery retries do not start another provider turn');
  assert.equal((await chat(app, { action: 'snapshot' })).body.messages.length, 2);
});

test('heartbeat requires owner opt-in and a valid silent result publishes no chat message', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  f.clock += 24 * HOUR; await settle(app); assert.equal(f.calls('blackout').length, 0);
  const enabled = await schedules(app, { action: 'configure', input: { heartbeatEnabled: true } });
  assert.equal(enabled.status, 200); assert.equal(enabled.body.settings.heartbeatEnabled, true);
  f.clock += 6 * HOUR; await settle(app);
  assert.equal(f.calls('blackout').length, 1); assert.equal(f.calls('screamer').length, 0);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE state='silent'").get().n, 1);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM conv_messages').get().n, 0);
  assert.deepEqual((await chat(app, { action: 'snapshot' })).body.messages, []);
});

test('generated owner MCP bindings run the actual scheduler child and permit only owned reminder operations', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  for (const [proof, label] of [[A, 'blackout'], [B, 'screamer']]) {
    const thread = await chat(app, { action: 'createThread', requestId: 'thread-' + label, title: 'Conversation' }, proof);
    assert.equal(thread.status, 200);
    assert.equal((await chat(app, { action: 'submit', requestId: 'hello-' + label, threadId: thread.body.thread.id, text: 'hello' }, proof)).status, 200);
    await app.conversations.idle();
    assert.equal((await chat(app, { action: 'snapshot' }, proof)).body.messages.at(-1).text, 'Natural reply for ' + label);
  }
  const configA = descriptor(f.calls('blackout')[0]), configB = descriptor(f.calls('screamer')[0]);
  assert.notEqual(configA.env.COMPANION_SCHEDULER_TOKEN, configB.env.COMPANION_SCHEDULER_TOKEN);
  assert.equal(configA.env.COMPANION_SCHEDULER_URL, app.url + '/internal/scheduler');
  const ownerA = await mcpChild(f, configA), ownerB = await mcpChild(f, configB);
  const tools = await ownerA.request('tools/list', {});
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ['create_schedule', 'list_schedules', 'cancel_schedule', 'schedule_followup', 'cancel_followup', 'create_release_watch', 'create_topic_watch', 'update_release_watch',
    'list_calendar', 'create_event', 'update_event', 'delete_event', 'github_list_repos', 'github_repo', 'github_pulls', 'github_pull', 'github_create_repo',
    'mail_status', 'mail_inbox', 'mail_read', 'mail_send', 'mail_mark_handled', 'mail_opt_out',
    'studio_calendar_list', 'studio_calendar_create', 'studio_calendar_update', 'studio_calendar_delete', 'read_x_post', 'watch_x_video',
    'agents_launch', 'agents_roster', 'agents_save_agent', 'agents_archive_agent', 'agents_save_team', 'agents_archive_team', 'agents_list', 'agents_status', 'agents_stop']);
  const input = { requestId: 'from-real-mcp-child', text: 'Created through the owned scheduler tool', dueAt: iso(f.clock + 10 * MINUTE) };
  const created = toolValue(await ownerA.call('create_schedule', input));
  assert.equal(created.items.length, 1); const id = created.items[0].id;
  assert.equal(toolValue(await ownerA.call('create_schedule', input)).items[0].id, id);
  assert.equal(toolValue(await ownerA.call('list_schedules', {})).items[0].id, id);
  assert.deepEqual(toolValue(await ownerB.call('list_schedules', {})).items, []);
  assert.equal((await ownerB.call('cancel_schedule', { id })).result.isError, true);
  assert.equal((await ownerA.call('create_schedule', { ...input, companionId: f.ids[B] })).error.code, -32602);
  assert.equal((await ownerA.call('configure_schedule', { enabled: false })).error.code, -32602);
  assert.equal((await post(app, '/internal/scheduler', { action: 'list' }, null,
    { Authorization: 'Bearer ' + '0'.repeat(64) })).status, 401);
  const token = { Authorization: 'Bearer ' + configA.env.COMPANION_SCHEDULER_TOKEN };
  assert.equal((await post(app, '/internal/scheduler', { action: 'configure', input: { enabled: false } }, null, token)).status, 400);
  assert.equal((await post(app, '/internal/scheduler', { action: 'list', companionId: f.ids[B] }, null, token)).status, 400);
  assert.equal((await schedules(app, { action: 'configure', input: { enabled: false } })).status, 200);
  const cancelled = toolValue(await ownerA.call('cancel_schedule', { id }));
  assert.equal(cancelled.items[0].state, 'cancelled');
  assert.equal((await schedules(app, { action: 'list' })).body.items[0].state, 'cancelled');
  ownerA.child.stdin.end(); ownerB.child.stdin.end();
});

test('owner-bound release management uses the real MCP child, web CAS and native web-only stale checks', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  const thread = await chat(app, { action: 'createThread', requestId: 'release-tools-thread', title: 'Release watches' });
  await chat(app, { action: 'submit', requestId: 'release-tools-hello', threadId: thread.body.thread.id, text: 'hello' });
  await app.conversations.idle();
  const child = await mcpChild(f, descriptor(f.calls('blackout')[0]));
  const input = { requestId: 'real-child-watch', condition: 'Synthetic official stable release exists' };
  const created = toolValue(await child.call('create_release_watch', input));
  assert.equal(created.releaseWatches.length, 1); const id = created.releaseWatches[0].id;
  await settle(app);
  const listed = (await schedules(app, { action: 'list' })).body.releaseWatches[0];
  assert.equal(listed.id, id); assert.equal(listed.lastResult, 'stale', 'The fake provider has no valid release result');
  assert.equal(listed.consecutiveStale, 1);
  assert.equal(toolValue(await child.call('create_release_watch', input)).releaseWatches[0].id, id);
  assert.deepEqual((await schedules(app, { action: 'list' }, B)).body.releaseWatches, []);
  assert.equal((await schedules(app, { action: 'createWatch', input })).status, 400, 'Creation remains a chat tool');
  assert.equal((await schedules(app, { action: 'list' }, null)).status, 401);
  const pause = { requestId: 'web-pause-watch', id, expectedVersion: listed.version, operation: 'pause' };
  assert.equal((await schedules(app, { action: 'updateWatch', input: pause }, B)).status, 404);
  const paused = await schedules(app, { action: 'updateWatch', input: pause });
  assert.equal(paused.status, 200); assert.equal(paused.body.releaseWatches[0].state, 'paused');
  assert.equal((await schedules(app, { action: 'updateWatch', input: pause })).status, 200, 'Exact acknowledgement retry');
  assert.equal((await schedules(app, { action: 'updateWatch', input: { ...pause, requestId: 'stale-cas' } })).status, 409);
  const calls = f.calls('blackout').filter(call => call.args.includes('WebSearch,WebFetch'));
  assert.equal(calls.length, 1); assert.ok(!calls[0].args.some(value => value.startsWith('mcp__')));
  assert.equal(f.calls('screamer').length, 0);
  child.child.stdin.end();
});

test('closing during a synthetic wake stops its process and reopening never replays the handed-off occurrence', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app); f.hold('blackout');
  await schedules(app, { action: 'create', input: { requestId: 'shutdown-wake', text: 'Held fake wake', dueAt: iso(f.clock + MINUTE) } });
  f.clock += MINUTE; await app.scheduler.tick(); await until(() => f.calls('blackout').length === 1);
  await f.close(app); f.clock += HOUR; await delay(35);
  assert.equal(f.calls('blackout').length, 1);
  const reopened = await f.open(); await settle(reopened);
  assert.equal(f.calls('blackout').length, 1);
  assert.equal(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE state='interrupted'").get().n, 1);
  assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS n FROM conv_messages').get().n, 0);
});

test('routine preferences are opt-in, owner scoped, partial and retained across legacy saves and restart', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  const disabled = { dailyDigest: { enabled: false, localTime: '09:00' },
    weeklyCheckin: { enabled: false, localTime: '09:00', weekday: 1 } };
  const current = async (target, proof = A) => {
    const reply = await schedules(target, { action: 'list' }, proof); assert.equal(reply.status, 200);
    return { dailyDigest: reply.body.settings.dailyDigest, weeklyCheckin: reply.body.settings.weeklyCheckin };
  };
  assert.deepEqual(await current(app), disabled); assert.deepEqual(await current(app, B), disabled);
  const selected = { dailyDigest: { enabled: true, localTime: '13:00' },
    weeklyCheckin: { enabled: true, localTime: '13:05', weekday: 1 } };
  assert.equal((await schedules(app, { action: 'configure', input: selected })).status, 200);
  assert.deepEqual(await current(app), selected); assert.deepEqual(await current(app, B), disabled);
  assert.equal((await schedules(app, { action: 'configure', input: {
    heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00'
  } })).status, 200, 'An unchanged old client sends only the original fields');
  assert.deepEqual(await current(app), selected);
  assert.equal((await schedules(app, { action: 'configure', input: { dailyDigest: { localTime: '14:00' } } })).status, 200);
  const patched = { ...selected, dailyDigest: { enabled: true, localTime: '14:00' } };
  assert.deepEqual(await current(app), patched);
  assert.equal((await schedules(app, { action: 'configure', input: { weeklyCheckin: { localTime: '15:00' } } }, B)).status, 200);
  assert.deepEqual(await current(app), patched, 'The other account changes only its own routine');
  assert.deepEqual((await current(app, B)).weeklyCheckin, { enabled: false, localTime: '15:00', weekday: 1 });
  await settle(app); assert.equal(f.calls('blackout').length, 0); assert.equal(f.calls('screamer').length, 0);
  await f.close(app); const reopened = await f.open();
  assert.deepEqual(await current(reopened), patched);
  assert.deepEqual((await current(reopened, B)).weeklyCheckin, { enabled: false, localTime: '15:00', weekday: 1 });
});

test('routine configuration requires a fresh account and closed same-origin input without side effects', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  const before = (await schedules(app, { action: 'list' })).body.settings;
  for (const input of [
    { dailyDigest: null }, { dailyDigest: [] }, { dailyDigest: { enabled: 'true' } },
    { dailyDigest: { localTime: '24:00' } }, { dailyDigest: { force: true } },
    { weeklyCheckin: { weekday: 0 } }, { weeklyCheckin: { weekday: 8 } },
    { weeklyCheckin: { weekday: 1.5 } }, { weeklyCheckin: { localTime: '9:00' } },
    { weeklyCheckin: { enabled: true, owner: 'another-owner' } }
  ]) {
    const reply = await schedules(app, { action: 'configure', input });
    assert.equal(reply.status, 400); assert.equal(reply.body.error.code, 'SCHEDULER_INVALID_REQUEST');
  }
  const body = { action: 'configure', input: { dailyDigest: { enabled: true } } };
  assert.equal((await schedules(app, body, null)).status, 401);
  assert.equal((await schedules(app, body, A, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await schedules(app, { ...body, companionId: f.ids[A] }, B)).status, 400);
  f.proofs.delete(A); assert.equal((await schedules(app, body)).status, 401); f.proofs.set(A, PA);
  assert.deepEqual((await schedules(app, { action: 'list' })).body.settings, before);
  await settle(app); assert.equal(f.calls('blackout').length, 0); assert.equal(f.calls('screamer').length, 0);
});

test('daily and weekly routines privately deliver with closed clients once and the model broker cannot enable them', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  const configured = await schedules(app, { action: 'configure', input: {
    dailyDigest: { enabled: true, localTime: '13:00' },
    weeklyCheckin: { enabled: true, localTime: '13:05', weekday: 1 }
  } });
  assert.equal(configured.status, 200); await settle(app); assert.equal(f.calls('blackout').length, 0);
  f.clock += HOUR; await settle(app);
  assert.equal(f.calls('blackout').length, 1); assert.equal(f.calls('screamer').length, 0);
  assert.match(f.calls('blackout')[0].prompt, /daily|digest/i);
  const tool = descriptor(f.calls('blackout')[0]);
  const refused = await fetch(tool.env.COMPANION_SCHEDULER_URL, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer ' + tool.env.COMPANION_SCHEDULER_TOKEN
  }, body: JSON.stringify({ action: 'configure', input: { weeklyCheckin: { enabled: false } } }) });
  assert.equal(refused.status, 400, 'The valid model token cannot mutate any browser-owned preference');
  assert.equal((await schedules(app, { action: 'list' })).body.settings.weeklyCheckin.enabled, true);
  f.clock += 5 * MINUTE; await settle(app);
  assert.equal(f.calls('blackout').length, 2); assert.match(f.calls('blackout')[1].prompt, /weekly|check.in/i);
  const view = (await chat(app, { action: 'snapshot' })).body;
  assert.equal(view.messages.length, 2); assert.ok(view.messages.every(item => item.role === 'assistant'));
  assert.ok(view.messages.every(item => !item.text.includes('action') && !item.text.includes('PRIVATE')));
  await settle(app); assert.equal(f.calls('blackout').length, 2);
  await f.close(app); const reopened = await f.open(); await settle(reopened);
  assert.equal(f.calls('blackout').length, 2, 'Neither admitted local period is replayed after restart');
  assert.equal(f.calls('screamer').length, 0);
});

test('calendar events (#44): owner UI and the real MCP child share one owner-bound calendar, and reminders arrive as wakes', async t => {
  const f = fixture(t), app = await f.open(); await ready(f, app);
  const thread = await chat(app, { action: 'createThread', requestId: 'calendar-thread', title: 'Calendar' });
  await chat(app, { action: 'submit', requestId: 'calendar-hello', threadId: thread.body.thread.id, text: 'hello' });
  await app.conversations.idle();
  const child = await mcpChild(f, descriptor(f.calls('blackout')[0]));
  // f.clock is 2026-11-02 12:00 UTC; the dentist is at 14:00 with a reminder 60 minutes before.
  const event = { title: 'Dentist', start: '2026-11-02T14:00', location: 'Rue de la Paix', reminderMinutes: 60 };
  const created = toolValue(await child.call('create_event', { requestId: 'cal-tool-1', event }));
  assert.equal(created.event.title, 'Dentist'); assert.equal(created.event.allDay, false);
  assert.equal(toolValue(await child.call('create_event', { requestId: 'cal-tool-1', event })).event.id, created.event.id, 'Exact retry');
  const conflict = await child.call('create_event', { requestId: 'cal-tool-1', event: { ...event, title: 'Other' } });
  assert.equal(conflict.result.isError, true); assert.match(conflict.result.content[0].text, /^CALENDAR_CONFLICT/);
  const bad = await child.call('create_event', { requestId: 'cal-tool-2', event: { title: 'x', start: '2026-02-30' } });
  assert.match(bad.result.content[0].text, /^CALENDAR_INVALID_REQUEST/);

  const view = await schedules(app, { action: 'calendar', input: { from: '2026-11-01', days: 7 } });
  assert.equal(view.status, 200); assert.deepEqual(view.body.occurrences.map(item => item.title), ['Dentist']);
  assert.deepEqual((await schedules(app, { action: 'calendar' }, B)).body.occurrences, [], 'The other owner sees nothing');
  assert.equal((await schedules(app, { action: 'deleteEvent', input: { id: created.event.id } }, B)).body.deleted, false);
  const token = { Authorization: 'Bearer ' + descriptor(f.calls('blackout')[0]).env.COMPANION_SCHEDULER_TOKEN };
  assert.equal((await post(app, '/internal/scheduler', { action: 'calendarSettings', input: { holidaysFr: true } }, null, token)).status, 400,
    'Only the owner UI changes calendar settings');
  assert.equal((await schedules(app, { action: 'calendarSettings', input: { holidaysFr: true } })).status, 200);
  const holidays = toolValue(await child.call('list_calendar', { from: '2026-11-01', days: 14 }));
  assert.deepEqual(holidays.occurrences.map(item => item.title), ['Toussaint', 'Dentist', 'Armistice 1918']);

  // Not yet due: nothing is queued. At 13:00 the reminder becomes a calendar wake with the event details.
  await settle(app);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE kind='calendar'").get().n, 0);
  f.clock += HOUR; await settle(app);
  const wake = app.store.db.prepare("SELECT * FROM conv_wakes WHERE kind='calendar'").all();
  assert.equal(wake.length, 1); assert.match(wake[0].prompt, /"Dentist" on Monday 2 November at 14:00/);
  assert.equal(wake[0].state, 'message');
  f.clock += 5 * MINUTE; await settle(app);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE kind='calendar'").get().n, 1, 'Reminded once');
  const wakeCall = f.calls('blackout').find(call => call.prompt.includes('background calendar wake'));
  assert.ok(wakeCall && !wakeCall.args.join(',').includes('mcp__scheduler__create_event'), 'Calendar wakes cannot edit the calendar');

  const updated = toolValue(await child.call('update_event', { id: created.event.id, expectedVersion: 1, event: { ...event, title: 'Dentist (moved)' } }));
  assert.equal(updated.event.version, 2);
  assert.match((await child.call('update_event', { id: created.event.id, expectedVersion: 1, event: { ...event, title: 'Again' } })).result.content[0].text, /CONFLICT/);
  assert.equal(toolValue(await child.call('delete_event', { id: created.event.id })).deleted, true);
  child.child.stdin.end();
});

// #54: the companion's own wakes, end to end with the synthetic provider and the real scheduler MCP child.
test('own wakes start at night for quiet work, hold their message without notifying until quiet hours end', async t => {
  const settled = [];
  const f = fixture(t, { scheduler: { proactiveByDefault: true, random: () => 0.5 }, conversation: { onSettled: event => settled.push(event) } });
  f.clock = Date.UTC(2026, 10, 2, 18);
  const app = await f.open(); await ready(f, app);
  const listed = await schedules(app, { action: 'list' });
  assert.deepEqual(listed.body.settings.proactive, { enabled: true, perDay: 4 }, 'Owners who never chose are on, four a day');
  // Owner B turns them off from the browser; owner A keeps the default.
  const off = await schedules(app, { action: 'configure', input: { proactive: { enabled: false } } }, B);
  assert.equal(off.status, 200); assert.deepEqual(off.body.settings.proactive, { enabled: false, perDay: 4 });
  // Four a day with a middle random factor: the first own wake is six hours later, at midnight, inside quiet hours.
  f.clock = Date.UTC(2026, 10, 3, 0); await settle(app);
  assert.equal(f.calls('blackout').length, 1, 'A night wake may start for quiet work'); assert.equal(f.calls('screamer').length, 0);
  const prompt = f.calls('blackout')[0].prompt;
  assert.match(prompt, /^This is a private background proactive wake/); assert.match(prompt, /one of your own wakes/);
  assert.match(prompt, /inside their quiet hours/); assert.match(prompt, /00:00 \(UTC\)/);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE kind='proactive' AND state='waiting_delivery'").get().n, 1);
  assert.deepEqual((await chat(app, { action: 'snapshot' })).body.messages, [], 'Its message waits for the morning');
  assert.equal(settled.filter(event => event.proactive).length, 0, 'Nothing is pushed at night');
  f.clock = Date.UTC(2026, 10, 3, 8); await settle(app);
  assert.equal(f.calls('blackout').length, 1, 'Delivery does not start another provider turn');
  assert.equal((await chat(app, { action: 'snapshot' })).body.messages.at(-1).text, 'Scheduled hello for blackout');
  assert.equal(settled.filter(event => event.proactive).length, 1);
  // Older clients that only save legacy preferences keep the owner's choice.
  const legacy = await schedules(app, { action: 'configure', input: { heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00' } }, B);
  assert.deepEqual(legacy.body.settings.proactive, { enabled: false, perDay: 4 });
  // The browser cannot schedule the companion's follow-ups.
  assert.equal((await schedules(app, { action: 'createFollowup', input: { requestId: 'browser', at: iso(f.clock + HOUR), note: 'x' } })).status, 400);
});

test('the companion schedules its own follow-up through the real MCP child; it wakes once with the note', async t => {
  // Own wakes on (follow-ups need them), the next one about nine hours away.
  const f = fixture(t, { scheduler: { proactiveByDefault: true, random: () => 0.99 } }), app = await f.open(); await ready(f, app);
  const thread = await chat(app, { action: 'createThread', requestId: 'thread-followup', title: 'Conversation' });
  await chat(app, { action: 'submit', requestId: 'hello-followup', threadId: thread.body.thread.id, text: 'I leave for Lisbon tomorrow' });
  await app.conversations.idle();
  const owner = await mcpChild(f, descriptor(f.calls('blackout')[0]));
  const input = { requestId: 'lisbon-trip', at: iso(f.clock + 2 * HOUR), note: 'Ask how the Lisbon trip went.' };
  const created = toolValue(await owner.call('schedule_followup', input));
  assert.equal(created.createdFollowup.note, input.note); assert.equal(created.followups.length, 1);
  assert.equal(toolValue(await owner.call('schedule_followup', input)).createdFollowup.id, created.createdFollowup.id, 'Exact retries return the same follow-up');
  assert.equal((await owner.call('schedule_followup', { ...input, note: 'Something else' })).result.isError, true);
  assert.deepEqual((await schedules(app, { action: 'list' }, B)).body.followups, [], 'Follow-ups are owner-private');
  assert.deepEqual((await schedules(app, { action: 'list' })).body.followups.map(item => item.id), [created.createdFollowup.id], 'The owner sees it');
  f.clock += 2 * HOUR; await settle(app);
  const wake = f.calls('blackout').at(-1).prompt;
  assert.match(wake, /^This is a private background followup wake/); assert.match(wake, /Ask how the Lisbon trip went\./);
  assert.equal((await chat(app, { action: 'snapshot' })).body.messages.at(-1).text, 'Scheduled hello for blackout');
  assert.deepEqual((await schedules(app, { action: 'list' })).body.followups, [], 'A follow-up runs once');
  const calls = f.calls('blackout').length; f.clock += 6 * HOUR; await settle(app);
  assert.equal(f.calls('blackout').length, calls);
  // The owner can cancel one from the browser.
  const later = toolValue(await owner.call('schedule_followup', { ...input, requestId: 'later', at: iso(f.clock + 24 * HOUR) })).createdFollowup;
  const cancelled = await schedules(app, { action: 'cancelFollowup', input: { id: later.id } });
  assert.equal(cancelled.status, 200); assert.deepEqual(cancelled.body.followups, []);
  assert.equal((await schedules(app, { action: 'cancelFollowup', input: { id: later.id } }, B)).status, 404);
});

test('a silent own wake publishes nothing and notifies nobody', async t => {
  const settled = [];
  const f = fixture(t, { scheduler: { proactiveByDefault: true, random: () => 0 }, conversation: { onSettled: event => settled.push(event) } });
  const app = await f.open(); await ready(f, app);
  writeFileSync(join(f.home('blackout'), 'silent'), '');
  f.clock += 3 * HOUR; await settle(app);
  assert.match(f.calls('blackout')[0].prompt, /background proactive wake/);
  assert.deepEqual(app.store.db.prepare("SELECT state FROM conv_wakes WHERE companion_id=? AND kind='proactive'").all(f.ids[A]).map(row => row.state), ['silent']);
  assert.equal(app.store.db.prepare("SELECT state FROM scheduler_proactive_occurrences WHERE companion_id=?").get(f.ids[A]).state, 'silent');
  assert.deepEqual((await chat(app, { action: 'snapshot' })).body.messages, []);
  assert.equal(settled.filter(event => event.proactive && event.companionId === f.ids[A]).length, 0);
});
