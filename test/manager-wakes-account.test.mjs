// #94, end to end through the server: an own wake (heartbeat) of the agent owner gets the manager tools and runs with
// the unattended scheduler token; over that token the runner takes agent calls only for an approved project's ticket,
// while the owner-chat token keeps today's rules. The runner is the real API (createRunnerApi) over a fake runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { Manager } from '../src/agent-manager.mjs';
import { createRunnerApi } from '../src/agent-runner-api.mjs';

const ISSUER = 'https://synthetic.invalid', PA = { issuer: ISSUER, subject: 'manager-wakes-account-a' }, A = 'A'.repeat(43);
const HOUR = 3_600_000, APPROVED = 'proj-approved', OTHER = 'proj-other';

// Only this local fake provider can be launched (the same script as test/scheduler-account.test.mjs).
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

async function setup(t, { approve = true, gate = true, kind = 'heartbeat' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'manager-wakes-account-')));
  const fake = join(dir, 'fake-claude.cjs'), runtimeFile = join(dir, 'owners.json');
  writeFileSync(fake, FAKE);
  writeFileSync(runtimeFile, JSON.stringify({ owners: [{ subject: PA.subject, issuer: ISSUER, label: 'blackout', provider: 'claude' }] }));
  const manager = new Manager({ projects: [APPROVED, OTHER] });
  if (approve) manager.approve({ projectId: APPROVED, direction: 'Run it unattended.' });
  const launched = [];
  const runner = { on() {}, list: () => [], events: () => [], limits: {}, get: () => null,
    launch: body => { launched.push(body); return { id: `run-${launched.length}` }; }, stop: id => ({ id }) };
  runner.launchWithApproval = async body => runner.launch(body); // the real runner's path with no owner approval
  const api = createRunnerApi({ runner, roster: { summary: () => ({}) }, manager, projects: [APPROVED, OTHER],
    tickets: () => [{ id: 'TA', projectId: APPROVED }, { id: 'TB', projectId: OTHER }] });
  const client = { call: async (method, path, body) => {
    const answer = await api(method, path, body ?? {});
    // An older runner (before #94) does not advertise the gate.
    if (!gate && path === '/status') delete answer.body.manager.unattendedGate;
    return answer;
  } };
  let clock = Date.UTC(2026, 10, 12, 12);
  const app = await startServer({ dataDir: join(dir, 'data'), mode: 'account', port: 0, pilotSubjects: [PA],
    validateAccount: async proof => proof === A ? PA : null, runtimeFile, runtimeDir: join(dir, 'runtimes'), binaries: { claude: fake },
    runnerOptions: { statusTtlMs: 0, spawnImpl: (binary, args, options) => spawn(process.execPath, [fake, ...args], options) },
    conversationOptions: { now: () => clock, flushMs: 1 }, schedulerOptions: { now: () => clock, pollMs: HOUR, proactiveByDefault: kind === 'proactive', random: () => 0.5 },
    agentRunnerOptions: { client, owners: ['blackout'], poll: false } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = async (path, body, headers = { Cookie: `__Secure-blackout_session=${A}` }) => {
    const response = await fetch(app.url + path, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post('/api/session', {})).status, 200);
  assert.equal((await post('/api/companion', { action: 'setProfile', profile: { name: 'C-chan', character: 'pip', color: 'mint', timezone: 'UTC' } })).status, 200);
  const home = join(dir, 'runtimes', 'blackout', 'claude-home');
  const calls = () => existsSync(join(home, 'calls.jsonl')) ? readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const settle = async () => { await app.scheduler.tick(); await app.conversations.idle(); await app.scheduler.tick(); };
  // A heartbeat (the owner opts in) or an own proactive wake (on by default here, six hours later), then an owner chat turn.
  if (kind === 'heartbeat') assert.equal((await post('/api/schedules', { action: 'configure', input: { heartbeatEnabled: true } })).status, 200);
  await app.scheduler.tick(); clock += 6 * HOUR; await settle();
  const thread = await post('/api/conversation', { action: 'createThread', requestId: 'chat-94', title: 'Chat' });
  await post('/api/conversation', { action: 'submit', requestId: 'chat-94-1', threadId: thread.body.thread.id, text: 'hello' });
  await app.conversations.idle();
  const [wake, chat] = calls();
  assert.match(wake.prompt, new RegExp(`background ${kind} wake`)); assert.doesNotMatch(chat.prompt, /background/);
  const config = call => JSON.parse(call.args[call.args.indexOf('--mcp-config') + 1]).mcpServers.scheduler;
  const tools = call => call.args.slice(call.args.indexOf('--allowedTools') + 1).join(',');
  const as = call => ({ Authorization: 'Bearer ' + config(call).env.COMPANION_SCHEDULER_TOKEN });
  const launch = ticketId => ({ action: 'agents', input: { op: 'launch', launch: { requestId: `l-${ticketId}-${Math.random()}`, agent: 'coder-1', ticketId, repo: 'personal-agent' } } });
  return { wake, chat, config, tools, as, launch, post, launched };
}

test('a heartbeat wake runs with the unattended token: approved project yes, other project no; owner chat unchanged (#94)', async t => {
  const s = await setup(t);
  assert.notEqual(s.config(s.wake).env.COMPANION_SCHEDULER_TOKEN, s.config(s.chat).env.COMPANION_SCHEDULER_TOKEN);
  assert.match(s.tools(s.wake), /mcp__scheduler__agents_launch/); assert.match(s.tools(s.wake), /mcp__scheduler__agents_decide/);
  assert.doesNotMatch(s.tools(s.wake), /agents_approve_project/);
  const ok = await s.post('/internal/scheduler', s.launch('TA'), s.as(s.wake));
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const refused = await s.post('/internal/scheduler', s.launch('TB'), s.as(s.wake));
  assert.equal(refused.status, 403); assert.equal(refused.body.error.code, 'NOT_APPROVED');
  const approve = { action: 'agents', input: { op: 'approveProject', approval: { requestId: 'a', projectId: OTHER, direction: 'x' } } };
  assert.equal((await s.post('/internal/scheduler', approve, s.as(s.wake))).body.error.code, 'OWNER_CHAT_ONLY');
  assert.equal((await s.post('/internal/scheduler', s.launch('TB'), s.as(s.chat))).status, 202, 'owner chat keeps its rules');
  assert.equal(s.launched.length, 2);
});

test('a proactive wake gets the manager tools only with an approval and a runner that checks it (#94)', async t => {
  const on = await setup(t, { kind: 'proactive' });
  assert.match(on.tools(on.wake), /mcp__scheduler__agents_launch/); assert.match(on.tools(on.wake), /mcp__scheduler__agents_merge/);
  assert.doesNotMatch(on.tools(on.wake), /mail_send|agents_approve_project/);
  for (const options of [{ approve: false }, { gate: false }]) {
    const s = await setup(t, { kind: 'proactive', ...options });
    for (const name of ['agents_launch', 'agents_merge', 'agents_stop', 'agents_decide']) {
      assert.doesNotMatch(s.tools(s.wake), new RegExp(`mcp__scheduler__${name}\\b`), JSON.stringify(options));
    }
    assert.match(s.tools(s.wake), /mcp__scheduler__agents_manager/);
  }
});

test('a heartbeat wake without any approval: the runner refuses its launches (#94)', async t => {
  const s = await setup(t, { approve: false });
  const refused = await s.post('/internal/scheduler', s.launch('TB'), s.as(s.wake));
  assert.equal(refused.status, 403); assert.equal(refused.body.error.code, 'NOT_APPROVED');
  assert.equal((await s.post('/internal/scheduler', s.launch('TB'), s.as(s.chat))).status, 202);
});
