// #94: Manager mode runs unattended. On the companion's own wakes (proactive, heartbeat, follow-up), an agent owner with
// an active standing approval gets the manager tools (launch, merge, stop, decide) and the Board tools; those turns use an
// unattended scheduler token, and the runner takes their agent calls only for tickets of approved projects. Hard limits,
// mail, the calendars, contact wakes and approvals (owner chat only) stay as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { Conversations, wakeToolFilter, MANAGER_WAKES } from '../src/conversations.mjs';
import { CompanionRunner } from '../src/runner.mjs';
import { READ_ONLY_BOARD_TOOLS, narrowToolPolicy } from '../src/tool-policy.mjs';
import { Manager } from '../src/agent-manager.mjs';
import { AgentRunner } from '../src/agent-runner.mjs';
import { createRunnerApi } from '../src/agent-runner-api.mjs';
import { agentsOperation } from '../src/agent-runner-client.mjs';
import { schedulerOperation } from '../src/scheduler-http.mjs';
import { instructions, managerSection } from '../src/companion.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APPROVED = 'proj-approved', OTHER = 'proj-other';
const tmp = t => { const dir = mkdtempSync(join(tmpdir(), 'manager-wakes-94-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const S = name => 'mcp__scheduler__' + name, B = name => 'mcp__board__' + name;
const MANAGER = ['agents_launch', 'agents_merge', 'agents_stop', 'agents_decide'].map(S);
const BOARD_WRITES = ['create_ticket', 'update_ticket', 'post_message', 'release_managed_agent_claim', 'resolve_human_request'].map(B);
// Personal ask-first rules: the manager flag changes nothing for mail, the personal and Studio calendars, companion
// contacts, approvals, repo creation or the web, on any wake kind.
const PERSONAL = [S('mail_send'), S('create_event'), S('update_event'), S('delete_event'), S('studio_calendar_create'), S('studio_calendar_delete'),
  'mcp__contacts__message_companion', S('agents_approve_project'), S('agents_revoke_project'), S('github_create_repo'), 'WebSearch', 'WebFetch'];
// Refused on every own wake, with or without an approval.
const STILL_REFUSED = [S('create_event'), S('update_event'), S('delete_event'), S('agents_approve_project'), S('agents_revoke_project'),
  S('github_create_repo'), 'WebSearch', 'WebFetch'];

test('own wakes get the manager tools and Board writes only with an active approval; contact wakes and ask-first rules are unchanged (#94)', () => {
  assert.deepEqual([...MANAGER_WAKES], ['proactive', 'followup', 'heartbeat']);
  for (const kind of MANAGER_WAKES) {
    const approved = wakeToolFilter(kind, { manager: true }), plain = wakeToolFilter(kind), off = wakeToolFilter(kind, { manager: false });
    for (const name of [...MANAGER, ...BOARD_WRITES]) assert.equal(approved(name), true, `${kind} ${name}`);
    for (const name of BOARD_WRITES) { assert.equal(plain(name), false, `${kind} ${name}`); assert.equal(off(name), false, `${kind} ${name}`); }
    for (const name of STILL_REFUSED) assert.equal(approved(name), false, `${kind} ${name}`);
    for (const name of PERSONAL) assert.equal(approved(name), plain(name), `${kind} ${name}`);
    for (const name of [S('list_schedules'), S('agents_manager'), B('get_ticket')]) assert.equal(approved(name), true, `${kind} ${name}`);
  }
  for (const kind of ['proactive', 'followup']) {
    for (const name of MANAGER) assert.equal(wakeToolFilter(kind)(name), false, `${kind} ${name}`);
    for (const name of [S('mail_send'), S('studio_calendar_create')]) assert.equal(wakeToolFilter(kind, { manager: true })(name), false, `${kind} ${name}`);
  }
  // A contact wake is another companion writing: no manager tools, no Board writes, even for an agent owner.
  const contact = wakeToolFilter('contact', { manager: true });
  for (const name of [...MANAGER, ...BOARD_WRITES, S('mail_send'), S('studio_calendar_create')]) assert.equal(contact(name), false, name);
  // Other wakes (reminder, mail, calendar, Board) are unchanged by the flag.
  for (const kind of ['reminder', 'connector', 'calendar', 'board']) {
    for (const name of [...MANAGER, ...BOARD_WRITES, ...PERSONAL]) assert.equal(wakeToolFilter(kind, { manager: true })(name), wakeToolFilter(kind)(name), `${kind} ${name}`);
  }
});

// A conversation fixture with a fake native runner that records each turn's effective tools.
function fixture(t, managerWake) {
  const dir = tmp(t), store = new BootstrapStore(dir, ROOT), calls = [];
  const companionId = store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'manager-94' }), { companionId: randomUUID() }).companionId;
  const owner = { label: 'blackout', provider: 'claude', tools: ['Read', 'WebSearch'], board: { configDir: join(dir, 'board'), pythonPath: join(dir, 'python'),
    connectPath: join(dir, 'connect.py'), allowedTools: [...READ_ONLY_BOARD_TOOLS, 'create_ticket', 'update_ticket', 'release_managed_agent_claim'] } };
  const apps = [{ name: 'scheduler', command: join(dir, 'scheduler'), allowedTools: ['list_schedules', 'mail_send', 'create_event', 'agents_manager',
    'agents_launch', 'agents_merge', 'agents_stop', 'agents_decide', 'agents_approve_project'] }];
  const conv = new Conversations({ store, flushMs: 1, managerWake, systemPrompt: () => 'persona',
    runner: { turn(id, turn) {
      const policy = narrowToolPolicy({ tools: owner.tools, board: owner.board }, turn.allowedTools, apps, turn.toolFilter);
      calls.push({ ...turn, tools: [...policy.tools, ...policy.mcpServers.flatMap(server => server.allowedTools.map(name => `mcp__${server.name}__${name}`))] });
      return { text: JSON.stringify({ action: 'silent' }), sessionId: 's' };
    } } });
  t.after(async () => { await conv.shutdown(); store.close(); });
  return { conv, companionId, calls };
}

for (const kind of ['proactive', 'heartbeat', 'followup']) {
  test(`a ${kind} wake runs unattended with the manager tools when a project is approved, without them otherwise (#94)`, async t => {
    let approved = true;
    const f = fixture(t, async () => approved);
    await f.conv.enqueueProactive(f.companionId, { id: randomUUID(), kind, prompt: 'check in' }); await f.conv.idle();
    approved = false;
    await f.conv.enqueueProactive(f.companionId, { id: randomUUID(), kind, prompt: 'check in' }); await f.conv.idle();
    const [on, off] = f.calls;
    assert.equal(on.unattended, true); assert.equal(off.unattended, true);
    for (const name of [...MANAGER, B('create_ticket'), B('update_ticket'), B('release_managed_agent_claim')]) {
      assert.ok(on.tools.includes(name), name);
      if (kind !== 'heartbeat' || name.startsWith('mcp__board__')) assert.ok(!off.tools.includes(name), name);
    }
    // Mail and the calendar: the same on both turns (heartbeats could already send mail; proactive and follow-ups never).
    assert.equal(on.tools.includes(S('mail_send')), kind === 'heartbeat'); assert.equal(off.tools.includes(S('mail_send')), kind === 'heartbeat');
    for (const turn of [on, off]) {
      for (const name of [S('create_event'), S('agents_approve_project'), 'WebSearch']) assert.ok(!turn.tools.includes(name), name);
      assert.ok(turn.tools.includes(S('agents_manager')) && turn.tools.includes(B('get_ticket')));
    }
  });
}

test('a failing approval check counts as no approval; contact and Board wakes are not unattended-gated by it (#94)', async t => {
  const f = fixture(t, async () => { throw new Error('runner down'); });
  await f.conv.enqueueProactive(f.companionId, { id: randomUUID(), kind: 'proactive', prompt: 'check in' }); await f.conv.idle();
  for (const name of [...MANAGER, B('create_ticket')]) assert.ok(!f.calls[0].tools.includes(name), name);
  await f.conv.enqueueProactive(f.companionId, { id: randomUUID(), kind: 'board', prompt: 'runner events' }); await f.conv.idle();
  assert.equal(f.calls[1].unattended, undefined);
  assert.ok(f.calls[1].tools.includes(S('agents_launch')) && f.calls[1].tools.includes(B('create_ticket')));
});

test('the runner hands an unattended turn its own MCP credentials (#94)', async t => {
  const dir = tmp(t), store = new BootstrapStore(join(dir, 'data'), ROOT); t.after(() => store.close());
  const seen = [];
  const owners = [{ issuer: 'https://synthetic.invalid', subject: 'runner-94', label: 'blackout', provider: 'claude', tools: [] }];
  const runner = new CompanionRunner({ store, owners, runtimeDir: join(dir, 'rt'), binaries: { claude: join(dir, 'missing'), codex: join(dir, 'missing') },
    mcpServersFor: (owner, context) => { seen.push(context); return []; }, spawnImpl() { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  const id = store.getOrInsert('companion-identity-v1', principalKey({ issuer: owners[0].issuer, subject: owners[0].subject }), { companionId: randomUUID() }).companionId;
  await runner.turn(id, { prompt: 'chat' }).catch(() => {});
  await runner.turn(id, { prompt: 'wake', unattended: true }).catch(() => {});
  assert.deepEqual(seen, [undefined, { unattended: true }]);
});

// The runner side: a real Manager and runner API; the Board watch snapshot says which project each ticket is in.
function runnerApi(t, { realRunner = false } = {}) {
  const manager = new Manager({ projects: [APPROVED, OTHER] });
  manager.approve({ projectId: APPROVED, direction: 'Build the manager wakes.' });
  const launched = [], stopped = [];
  const tickets = [{ id: 'TA', number: 1, projectId: APPROVED }, { id: 'TB', number: 2, projectId: OTHER }];
  let runner;
  if (realRunner) {
    const ops = { async createWorktree() { return { path: '/w', branch: 'agent/x/t1' }; }, async removeWorktree() { return { removed: true }; },
      async unitActive() { return false; }, async stopUnit() {}, async branchInfo() { return { head: 'h', commits: 1 }; },
      spawn() { throw new Error('not in this test'); } };
    const hardLimits = [];
    runner = new AgentRunner({ file: join(tmp(t), 'runs.json'), ops, manager,
      reporter: { async begin() { return null; }, async started() {}, async heartbeat() {}, async finish() {}, async hardLimit(input) { hardLimits.push(input); } } });
    runner.hardLimits = hardLimits;
    t.after(() => runner.close());
  } else {
    const runs = [{ id: 'run-a', ticketId: 'TA' }, { id: 'run-b', ticketId: 'TB' }];
    runner = { on() {}, list: () => [], events: () => [], limits: {}, get: id => runs.find(run => run.id === id) ?? null,
      launch: body => { launched.push(body); return { id: `run-${launched.length}`, ...body }; },
      stop: id => { stopped.push(id); return { id }; } };
  }
  const api = createRunnerApi({ runner, roster: { summary: () => ({}) }, manager, projects: [APPROVED, OTHER], tickets: () => tickets });
  const agents = { client: { call: (method, path, body) => api(method, path, body ?? {}) }, allowed: id => id === 'cchan' };
  const wake = input => agentsOperation(agents, 'cchan', input, { unattended: true });
  const chat = input => agentsOperation(agents, 'cchan', input);
  return { agents, wake, chat, launched, stopped, runner, manager };
}

test('from an own wake the runner takes launches, merges, stops and decisions only for an approved project (#94)', async t => {
  const r = runnerApi(t);
  const launch = ticketId => ({ op: 'launch', launch: { requestId: `l-${ticketId}`, agent: 'coder-1', ticketId, repo: 'personal-agent' } });
  const ok = await r.wake(launch('TA'));
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(Object.hasOwn(r.launched[0], 'unattended'), false, 'the flag never reaches the runner itself');
  for (const input of [launch('TB'), launch('T-unknown'),
    { op: 'merge', merge: { requestId: 'm', agent: 'merger', ticketId: 'TB', repo: 'personal-agent', branch: 'agent/coder-1/t2' } },
    { op: 'stop', runId: 'run-b' }, { op: 'stop', runId: 'run-missing' },
    { op: 'decide', decision: { requestId: 'd1', kind: 'dispatch', ticketId: 'TB', reason: 'go' } },
    { op: 'decide', decision: { requestId: 'd2', kind: 'plan', projectId: OTHER, reason: 'plan' } },
    // A ticket of another project cannot borrow the approved project's id.
    { op: 'decide', decision: { requestId: 'd3', kind: 'dispatch', ticketId: 'TB', projectId: APPROVED, reason: 'go' } }]) {
    const refused = await r.wake(input);
    assert.equal(refused.status, 403, JSON.stringify(input));
    assert.equal(refused.body.error.code, 'NOT_APPROVED', JSON.stringify(input));
  }
  assert.equal(r.launched.length, 1); assert.deepEqual(r.stopped, []);
  assert.equal((await r.wake({ op: 'merge', merge: { requestId: 'm2', agent: 'merger', ticketId: 'TA', repo: 'personal-agent', branch: 'agent/coder-1/t1' } })).status, 202);
  assert.equal(r.launched[1].mode, 'merge');
  assert.equal((await r.wake({ op: 'stop', runId: 'run-a' })).status, 200);
  assert.equal((await r.wake({ op: 'decide', decision: { requestId: 'd4', kind: 'dispatch', ticketId: 'TA', reason: 'go' } })).status, 201);
  assert.equal((await r.wake({ op: 'decide', decision: { requestId: 'd5', kind: 'plan', projectId: APPROVED, reason: 'plan' } })).status, 201);
  // Owner chat turns keep today's rules: an unapproved project is still theirs to direct.
  assert.equal((await r.chat(launch('TB'))).status, 202);
  assert.equal((await r.chat({ op: 'decide', decision: { requestId: 'd6', kind: 'dispatch', ticketId: 'TB', reason: 'go' } })).status, 201);
  // An own wake never records or withdraws an approval, even if a tool slipped through.
  for (const input of [{ op: 'approveProject', approval: { requestId: 'a', projectId: OTHER, direction: 'x' } }, { op: 'revokeProject', projectId: APPROVED }]) {
    const refused = await r.wake(input);
    assert.equal(refused.status, 403); assert.equal(refused.body.error.code, 'OWNER_CHAT_ONLY');
  }
  assert.equal(r.manager.approved(OTHER), null); assert.ok(r.manager.approved(APPROVED));
});

test('the scheduler tool path passes the unattended token through to the agent tools (#94)', async t => {
  const r = runnerApi(t);
  const payload = { action: 'agents', input: { op: 'launch', launch: { requestId: 'p1', agent: 'coder-1', ticketId: 'TB', repo: 'personal-agent' } } };
  assert.equal((await schedulerOperation(null, 'cchan', payload, { agents: r.agents, unattended: true })).status, 403);
  assert.equal((await schedulerOperation(null, 'cchan', payload, { agents: r.agents })).status, 202);
});

test('the hard-limit check still applies to a launch from an own wake in an approved project (#94)', async t => {
  const r = runnerApi(t, { realRunner: true });
  const refused = await r.wake({ op: 'launch', launch: { requestId: 'hl', agent: 'coder-1', ticketId: 'TA', repo: 'personal-agent', model: 'sonnet',
    instructions: 'Deploy the new build to production.' } });
  assert.equal(refused.status, 403); assert.equal(refused.body.error.code, 'HARD_LIMIT');
  assert.equal(r.runner.list().length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.runner.hardLimits.length, 1);
});

test('wake prompt text: own wakes may act in approved projects; personal ask-first rules stay (#94)', t => {
  const dir = tmp(t);
  const owner = { label: 'blackout', name: 'Blackout', provider: 'claude' };
  const managed = instructions({ owner, profile: { name: 'C-chan' }, dir, files: false, manager: true });
  const section = managerSection('Blackout');
  assert.match(section, /your own wakes \(check-ins, heartbeats, follow-ups\) may act/);
  assert.match(section, /release\s+claims and write to the Board there without waiting/);
  assert.match(managed, /Board writes from\s+them follow Manager mode/);
  assert.match(managed, /in Manager mode, when you have it, they may write to the Board for a project\s+Blackout approved there/);
  assert.match(section, /the app refuses agent launches, merges,\s+stops, decisions and Board writes outside approved projects/);
  // The old blanket rules are gone; "no Board writes" only appears scoped to unapproved projects.
  for (const rule of ['no Board writes, mail or spending from them', 'never write to the Board during them', 'for Board writes the rule is yours to keep']) {
    assert.equal(managed.includes(rule), false, rule);
  }
  for (const at of [...managed.matchAll(/no Board writes/g)].map(match => match.index)) {
    assert.match(managed.slice(Math.max(0, at - 200), at + 50), /outside approved projects/);
  }
  assert.match(managed, /never a yes for mail or spending/);
  assert.match(managed, /Mail, Blackout's calendar and your contacts' rules stay as above/);
});
