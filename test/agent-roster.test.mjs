import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Roster } from '../src/agent-roster.mjs';
import { AgentRunner, parseReport, agentPrompt } from '../src/agent-runner.mjs';
import { claude, READ_ONLY_DENY } from '../src/agent-providers.mjs';
import { BoardReporter, BoardRosterMirror } from '../src/agent-runner-board.mjs';
import { eventsPrompt, agentsOperation } from '../src/agent-runner-client.mjs';

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); }
}
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'roster-73-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('roster: agents with role, model, actions and limits; versions; teams; archive (#73)', t => {
  const dir = temp(t);
  const roster = new Roster({ file: join(dir, 'roster.json') });
  const coder = roster.create({ name: 'coder-1', model: 'haiku', skills: ['Write small commits.'], repos: ['personal-agent'] });
  assert.deepEqual([coder.role, coder.kind, coder.actions, coder.version, coder.status], ['coder', 'standing', ['work', 'commit'], 1, 'active']);
  const reviewer = roster.create({ name: 'rev-1', role: 'reviewer', model: 'opus' });
  assert.deepEqual(reviewer.actions, ['review']);
  assert.throws(() => roster.create({ name: 'coder-1', model: 'haiku' }), e => e.code === 'EXISTS');
  assert.throws(() => roster.create({ name: 'Bad Name', model: 'haiku' }), e => e.code === 'INVALID');
  assert.throws(() => roster.create({ name: 'x', model: 'gpt-5' }), e => e.code === 'INVALID');
  assert.throws(() => roster.create({ name: 'x', model: 'haiku', role: 'admin' }), e => e.code === 'INVALID');
  assert.throws(() => roster.create({ name: 'x', model: 'haiku', actions: ['commit'] }), e => e.code === 'INVALID', 'commit needs work');
  assert.throws(() => roster.create({ name: 'x', model: 'haiku', kind: 'task' }), e => e.code === 'INVALID', 'a task agent needs its ticket');
  assert.throws(() => roster.create({ name: 'x', model: 'haiku', provider: 'codex' }), e => e.code === 'PROVIDER_UNAVAILABLE');
  assert.throws(() => roster.create({ name: 'x', model: 'haiku', shell: 'rm -rf' }), e => e.code === 'INVALID');
  assert.throws(() => roster.create({ name: 'x', model: 'haiku', instructions: 'Deploy it to production when done.' }), e => e.code === 'HARD_LIMIT');

  assert.throws(() => roster.update('coder-1', { model: 'sonnet' }), e => e.code === 'INVALID', 'needs expectedVersion');
  assert.throws(() => roster.update('coder-1', { expectedVersion: 9, model: 'sonnet' }), e => e.code === 'CONFLICT');
  const escalated = roster.update('coder-1', { expectedVersion: 1, model: 'sonnet', maxTurns: 40 });
  assert.deepEqual([escalated.model, escalated.maxTurns, escalated.version], ['sonnet', 40, 2]);
  assert.throws(() => roster.update('coder-1', { expectedVersion: 2, name: 'coder-9' }), e => e.code === 'INVALID');

  roster.create({ name: 'coder-2', model: 'haiku' });
  const team = roster.saveTeam({ name: 'web-team', purpose: 'Web app work', members: ['coder-1', 'coder-2', 'rev-1'] });
  assert.deepEqual([team.version, team.members], [1, ['coder-1', 'coder-2', 'rev-1']]);
  assert.equal(roster.get('coder-1').team, 'web-team');
  assert.throws(() => roster.saveTeam({ name: 'web-team', members: [] }), e => e.code === 'INVALID', 'update needs expectedVersion');
  assert.throws(() => roster.saveTeam({ name: 'other', members: ['coder-1'] }), e => e.code === 'INVALID', 'one team per agent');
  assert.throws(() => roster.saveTeam({ name: 'other', members: ['ghost'] }), e => e.code === 'NOT_FOUND');

  const archived = roster.archive('coder-2', { expectedVersion: 1 });
  assert.equal(archived.status, 'archived');
  assert.deepEqual(roster.list().teams[0].members, ['coder-1', 'rev-1'], 'an archived agent leaves its team');
  assert.equal(roster.list().agents.length, 2);
  assert.equal(roster.list({ includeArchived: true }).agents.length, 3);
  assert.equal(roster.create({ name: 'coder-2', model: 'haiku' }).version, 1, 'an archived name can be reused');

  const kept = roster.archiveTeam('web-team', { expectedVersion: 2 });
  assert.equal(kept.status, 'archived');
  assert.equal(roster.get('coder-1').status, 'active', 'members stay without archiveMembers');
  assert.equal(roster.get('coder-1').team, null);

  // The roster survives a restart.
  const again = new Roster({ file: join(dir, 'roster.json') });
  assert.equal(again.get('coder-1').model, 'sonnet');
  assert.equal(JSON.parse(readFileSync(join(dir, 'roster.json'), 'utf8')).agents.length, 3);
});

test('roster: launches are authorized by the agent\'s policy; task agents are archived when their ticket is done (#73)', () => {
  const roster = new Roster();
  roster.create({ name: 'coder-1', model: 'haiku', repos: ['personal-agent'], maxMinutes: 20 });
  roster.create({ name: 'rev-1', role: 'reviewer', model: 'opus' });
  roster.create({ name: 'task-7', kind: 'task', ticketId: 'T7', model: 'sonnet' });
  const policy = roster.authorize({ agent: 'coder-1', mode: 'work', repo: 'personal-agent', ticketId: 'T1' });
  assert.deepEqual([policy.model, policy.canCommit, policy.maxSeconds], ['haiku', true, 1200]);
  assert.throws(() => roster.authorize({ agent: 'coder-1', mode: 'work', repo: 'agent-board', ticketId: 'T1' }), e => e.code === 'FORBIDDEN');
  assert.throws(() => roster.authorize({ agent: 'coder-1', mode: 'review', repo: 'personal-agent', ticketId: 'T1' }), e => e.code === 'FORBIDDEN');
  assert.throws(() => roster.authorize({ agent: 'rev-1', mode: 'work', repo: 'personal-agent', ticketId: 'T1' }), e => e.code === 'FORBIDDEN');
  assert.equal(roster.authorize({ agent: 'rev-1', mode: 'review', repo: 'agent-board', ticketId: 'T1' }).canCommit, false);
  assert.throws(() => roster.authorize({ agent: 'coder-1', repo: 'personal-agent', ticketId: 'T1', model: 'opus' }), e => e.code === 'INVALID', 'model is the agent\'s');
  assert.throws(() => roster.authorize({ agent: 'task-7', repo: 'personal-agent', ticketId: 'T8' }), e => e.code === 'FORBIDDEN');
  assert.throws(() => roster.authorize({ agent: 'ghost', repo: 'personal-agent', ticketId: 'T1' }), e => e.code === 'NOT_FOUND');
  roster.update('coder-1', { expectedVersion: 1, status: 'paused' });
  assert.throws(() => roster.authorize({ agent: 'coder-1', repo: 'personal-agent', ticketId: 'T1' }), e => e.code === 'PAUSED');
  assert.deepEqual(roster.archiveTaskAgents('T7'), ['task-7']);
  assert.equal(roster.get('task-7').status, 'archived');
  assert.deepEqual(roster.archiveTaskAgents('T7'), []);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.prompt = ''; child.stdin.on('data', chunk => { child.prompt += chunk; });
  child.say = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.exit = (code = 0) => { child.stdout.end(); setImmediate(() => child.emit('close', code)); };
  return child;
}

function rig(t) {
  const children = [], active = new Set(), calls = [], board = [];
  const heads = { value: 'feed000000001' };
  const ops = {
    async createWorktree({ repo, agent, ticket }) { calls.push(['create', agent]); return { path: `/var/lib/cchan-agents/worktrees/${repo}/${agent}-t${ticket}`, branch: `agent/${agent}/t${ticket}`, resumed: false }; },
    async removeWorktree() { return { removed: true }; },
    async checkout({ worktree, ref }) { calls.push(['checkout', worktree, ref]); return { head: 'feed000000001' }; },
    spawn({ unit, spec }) { const child = fakeChild(); Object.assign(child, { unit, spec }); children.push(child); active.add(unit); child.on('close', () => active.delete(unit)); return child; },
    async unitActive(unit) { return active.has(unit); },
    async stopUnit(unit) { active.delete(unit); },
    async branchInfo() { return { head: heads.value, commits: 3 }; }
  };
  const reporter = {
    async begin(run) { board.push(['begin', run.agent]); return { number: 7, title: 'Seven', description: 'd', acceptanceCriteria: 'it works' }; },
    async beginReview(run) { board.push(['beginReview', run.agent]); return { number: 7, title: 'Seven', description: 'd', acceptanceCriteria: 'it works' }; },
    async started() {}, async heartbeat() { return null; },
    async finish(run) { board.push(['finish', run.agent, run.state]); }
  };
  const roster = new Roster();
  const r = new AgentRunner({ file: join(temp(t), 'runs.json'), ops, reporter, roster });
  t.after(() => r.close());
  return { r, roster, children, calls, board, heads };
}

test('runner + roster: a team codes, then an independent reviewer reviews the branch read-only (#73)', async t => {
  const { r, roster, children, calls, board, heads } = rig(t);
  roster.create({ name: 'coder-1', model: 'haiku', skills: ['Keep functions short.'], instructions: 'You work on the web app.' });
  roster.create({ name: 'rev-1', role: 'reviewer', model: 'opus' });
  roster.saveTeam({ name: 'web-team', members: ['coder-1', 'rev-1'] });

  assert.throws(() => r.launch({ agent: 'rev-1', ticketId: 'T7', repo: 'personal-agent' }), e => e.code === 'FORBIDDEN', 'a reviewer does not work tickets');
  assert.throws(() => r.launch({ agent: 'coder-1', ticketId: 'T7', repo: 'personal-agent', model: 'opus' }), e => e.code === 'INVALID');
  assert.throws(() => r.launch({ agent: 'rev-1', ticketId: 'T7', repo: 'personal-agent', mode: 'review' }), e => e.code === 'INVALID', 'nothing to review yet');

  const work = r.launch({ requestId: 'w1', agent: 'coder-1', ticketId: 'T7', repo: 'personal-agent' });
  assert.deepEqual([work.model, work.role, work.team, work.canCommit], ['claude-haiku-5-5', 'coder', 'web-team', true]);
  await until(() => children.length === 1);
  const coder = children[0];
  assert.ok(!coder.spec.args.includes('--disallowedTools'));
  await until(() => coder.prompt.includes('BLOCKED:'));
  assert.match(coder.prompt, /Your role: coder in team web-team/);
  assert.match(coder.prompt, /Keep functions short\./); assert.match(coder.prompt, /You work on the web app\./);
  coder.say({ type: 'result', is_error: false, result: 'OUTCOME: Built it.\nEVIDENCE: tests pass' });
  coder.exit(0);
  await until(() => r.get(work.id).state === 'succeeded');

  const review = r.launch({ requestId: 'v1', agent: 'rev-1', ticketId: 'T7', repo: 'personal-agent', mode: 'review' });
  assert.equal(review.reviewBranch, 'agent/coder-1/t7');
  await until(() => children.length === 2);
  const reviewer = children[1];
  assert.deepEqual(calls.find(call => call[0] === 'checkout'), ['checkout', '/var/lib/cchan-agents/worktrees/personal-agent/rev-1-t7', 'agent/coder-1/t7']);
  assert.equal(reviewer.spec.args[reviewer.spec.args.indexOf('--disallowedTools') + 1], READ_ONLY_DENY);
  await until(() => reviewer.prompt.includes('VERDICT:'));
  assert.match(reviewer.prompt, /review another agent's work/); assert.match(reviewer.prompt, /agent\/coder-1\/t7, is checked out at\nfeed000000001/);
  assert.match(reviewer.prompt, /Do not edit files and do not commit/);
  reviewer.say({ type: 'result', is_error: false, result: 'VERDICT: changes_requested\nFINDINGS: criterion 1 not met: no test.\nEVIDENCE: node --test 10/10' });
  reviewer.exit(0);
  await until(() => r.get(review.id).state === 'succeeded');
  assert.deepEqual(r.get(review.id).result, { kind: 'review', verdict: 'changes_requested', findings: 'criterion 1 not met: no test.', evidence: 'node --test 10/10' });
  assert.deepEqual(board.map(item => item.slice(0, 2)), [['begin', 'coder-1'], ['finish', 'coder-1'], ['beginReview', 'rev-1'], ['finish', 'rev-1']]);
  const ended = r.events(0).filter(event => event.type === 'run.ended').at(-1);
  assert.deepEqual([ended.mode, ended.verdict], ['review', 'changes_requested']);
  assert.match(eventsPrompt([ended]), /Review run .* ended: succeeded, verdict changes_requested\. The report is on the ticket's thread\./);

  // A reviewer whose branch moved broke its policy: the run fails, whatever it claims.
  heads.value = 'bad0000000002';
  const sneaky = r.launch({ requestId: 'v2', agent: 'rev-1', ticketId: 'T7', repo: 'personal-agent', mode: 'review' });
  await until(() => children.length === 3);
  children[2].say({ type: 'result', is_error: false, result: 'VERDICT: approve\nFINDINGS: fine\nEVIDENCE: ok' });
  children[2].exit(0);
  await until(() => r.get(sneaky.id).state === 'failed');
  assert.equal(r.get(sneaky.id).errorCode, 'POLICY');

  // A reviewer that forgets the verdict has not reviewed.
  heads.value = 'feed000000001';
  const silent = r.launch({ requestId: 'v3', agent: 'rev-1', ticketId: 'T7', repo: 'personal-agent', mode: 'review' });
  await until(() => children.length === 4);
  children[3].say({ type: 'result', is_error: false, result: 'OUTCOME: looked at it' });
  children[3].exit(0);
  await until(() => r.get(silent.id).state === 'failed');
  assert.equal(r.get(silent.id).errorCode, 'NO_VERDICT');
});

test('runner + roster: an unknown name with a model becomes a per-task coder; paused agents and coders without commit are enforced (#73)', async t => {
  const { r, roster, children, heads } = rig(t);
  const run = r.launch({ agent: 'quick-fix', ticketId: 'T9', repo: 'personal-agent', model: 'sonnet' });
  assert.deepEqual([roster.get('quick-fix').kind, roster.get('quick-fix').ticketId, roster.get('quick-fix').createdBy], ['task', 'T9', 'launch']);
  assert.equal(run.model, 'claude-sonnet-5-5');
  assert.throws(() => r.launch({ agent: 'nobody', ticketId: 'T9', repo: 'personal-agent' }), e => e.code === 'NOT_FOUND');
  await until(() => children.length === 1);
  children[0].say({ type: 'result', is_error: false, result: 'OUTCOME: ok\nEVIDENCE: ok' }); children[0].exit(0);
  await until(() => r.get(run.id).state === 'succeeded');
  r.note({ type: 'board.done', ticketId: 'T9', ticketNumber: 9 });
  assert.equal(roster.get('quick-fix').status, 'archived');

  roster.create({ name: 'scout', model: 'haiku', actions: ['work'] });
  const scout = r.launch({ agent: 'scout', ticketId: 'T10', repo: 'personal-agent' });
  assert.equal(scout.canCommit, false);
  await until(() => children.length === 2);
  assert.ok(children[1].spec.args.includes('--disallowedTools'));
  await until(() => children[1].prompt.includes('BLOCKED:'));
  assert.match(children[1].prompt, /You may not edit files or commit/);
  heads.value = 'x'; // branchInfo reports 3 commits: a no-commit agent left commits
  children[1].say({ type: 'result', is_error: false, result: 'OUTCOME: investigated\nEVIDENCE: notes' }); children[1].exit(0);
  await until(() => r.get(scout.id).state === 'failed');
  assert.equal(r.get(scout.id).errorCode, 'POLICY');

  roster.update('scout', { expectedVersion: 1, status: 'paused' });
  assert.throws(() => r.launch({ agent: 'scout', ticketId: 'T11', repo: 'personal-agent' }), e => e.code === 'PAUSED');
});

test('report parsing reads reviewer verdicts; provider read-only mode denies the edit tools (#73)', () => {
  assert.deepEqual(parseReport('VERDICT: Approve.\nFINDINGS: all met\nEVIDENCE: tests'), { kind: 'review', verdict: 'approve', findings: 'all met', evidence: 'tests' });
  assert.equal(parseReport('VERDICT: request changes\nFINDINGS: x').verdict, 'changes_requested');
  assert.equal(parseReport('VERDICT: maybe').kind, 'unreported');
  const args = claude.command({ model: 'm', maxTurns: 5, readOnly: true }).args;
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Edit,MultiEdit,Write,NotebookEdit');
  assert.ok(!claude.command({ model: 'm', maxTurns: 5 }).args.includes('--disallowedTools'));
  assert.match(agentPrompt({ agent: 'a', repo: 'r', branch: 'b', base: 'main', mode: 'review', reviewBranch: 'agent/c/t1', reviewHead: 'h' },
    { number: 1, title: 't' }), /VERDICT: approve \| changes_requested/);
});

function fakeBoard(handlers = {}) {
  const calls = [];
  return { calls, async call(name, args) { calls.push([name, args]); const handler = handlers[name]; if (handler instanceof Error) throw handler; return typeof handler === 'function' ? handler(args) : handler ?? {}; } };
}

test('Board reporter: a review run reads the ticket without claiming it and posts the verdict on its thread (#73)', async () => {
  const client = fakeBoard({ get_ticket: { ticket: { id: 'T', project_id: 'P', thread_id: 'TH', number: 7, title: 'Seven', status: 'review', version: 5 } },
    reserve_execution: new Error('no runtime grant') });
  const reporter = new BoardReporter({ client, projects: ['P'], ownerId: 'o' });
  const run = { id: 'v1', agent: 'rev-1', role: 'reviewer', ticketId: 'T', provider: 'claude', modelAlias: 'opus', model: 'claude-opus-5-5', maxTurns: 10,
    maxSeconds: 600, branch: 'agent/rev-1/t7', repo: 'personal-agent', turns: 0, mode: 'review', reviewBranch: 'agent/coder-1/t7', reviewHead: 'feed000000001' };
  await reporter.beginReview(run);
  await reporter.started(run);
  Object.assign(run, { state: 'succeeded', turns: 3, startedAt: 0, endedAt: 60000, cleanup: { unitGone: true, worktreeRemoved: true },
    result: { kind: 'review', verdict: 'approve', findings: 'All criteria met.', evidence: 'node --test: 40 pass' } });
  await reporter.finish(run);
  const names = client.calls.map(call => call[0]);
  assert.ok(!names.includes('claim_ticket')); assert.ok(!names.includes('update_ticket'));
  const posts = client.calls.filter(call => call[0] === 'post_message').map(call => call[1].body);
  assert.match(posts[0], /rev-1 \(reviewer\) started reviewing agent\/coder-1\/t7 @ feed000000/);
  assert.match(posts[1], /Review by rev-1 of agent\/coder-1\/t7 @ feed000000: VERDICT approve\./);
  assert.match(posts[1], /All criteria met\./); assert.match(posts[1], /The ticket was not changed/);
});

test('Board mirror: roster agents become managed agent profiles, updated and archived with them; refusals are retried (#73)', async () => {
  let version = 0;
  const client = fakeBoard({
    create_managed_agent_profile: () => ({ id: 'PR1', version: (version = 1) }),
    get_managed_agent_profile: () => ({ id: 'PR1', version, status: 'active' }),
    update_managed_agent_profile: () => ({ id: 'PR1', version: ++version }),
    archive_managed_agent_profile: () => ({ id: 'PR1', version: ++version, status: 'archived' })
  });
  let now = 1000;
  const roster = new Roster({ mirror: new BoardRosterMirror({ client, projects: ['P'] }), now: () => now });
  roster.create({ name: 'coder-1', model: 'haiku', skills: ['Small commits.'] });
  roster.update('coder-1', { expectedVersion: 1, model: 'sonnet' });
  // A quick create + update coalesce: the Board gets one create with the latest fields.
  await until(() => roster.get('coder-1').board.profileId === 'PR1');
  const create = client.calls.find(call => call[0] === 'create_managed_agent_profile')[1].profile;
  assert.equal(create.name, 'C-chan · coder-1'); assert.equal(create.preferred_model, 'sonnet'); assert.deepEqual(create.project_ids, ['P']);
  assert.equal(client.calls.filter(call => call[0] === 'create_managed_agent_profile').length, 1);
  roster.update('coder-1', { expectedVersion: 2, model: 'opus' });
  await until(() => roster.get('coder-1').board.version === 2);
  assert.deepEqual(create.policy, { allow_read: false, allow_messages: false, allow_requests: false, actions: [], resources: [], autonomy: 'responses' });
  assert.match(create.instructions, /Skill: Small commits\./); assert.match(create.idempotency_key, /^cchan-roster-coder-1-1000$/);
  assert.equal(client.calls.find(call => call[0] === 'update_managed_agent_profile')[1].changes.preferred_model, 'opus');
  roster.archive('coder-1', { expectedVersion: 3 });
  await until(() => client.calls.some(call => call[0] === 'archive_managed_agent_profile'));

  // Without the owner's management grant the Board refuses; the roster keeps working and retries later.
  const refusing = fakeBoard({ create_managed_agent_profile: new Error('Human-delegated agent profile management is required') });
  const offline = new Roster({ mirror: new BoardRosterMirror({ client: refusing, projects: ['P'] }), now: () => now });
  offline.create({ name: 'coder-2', model: 'haiku' });
  await until(() => offline.get('coder-2').board.error);
  assert.match(offline.get('coder-2').board.error, /management is required/);
  assert.equal(await offline.resync(), 0, 'not retried before the interval');
  now += 11 * 60_000;
  assert.equal(await offline.resync(), 1);
  assert.equal(refusing.calls.filter(call => call[0] === 'create_managed_agent_profile').length, 2);
});

test('companion tools reach the roster endpoints (#73)', async () => {
  const calls = [];
  const agents = { allowed: () => true, client: { async call(method, path, body) { calls.push([method, path, body]); return { status: 200, body: { ok: true } }; } } };
  await agentsOperation(agents, 'c', { op: 'roster', includeArchived: true });
  await agentsOperation(agents, 'c', { op: 'saveAgent', agent: { name: 'coder-1', model: 'haiku' } });
  await agentsOperation(agents, 'c', { op: 'saveAgent', agent: { name: 'coder-1', expectedVersion: 1, model: 'opus' } });
  await agentsOperation(agents, 'c', { op: 'archiveAgent', name: 'coder-1', expectedVersion: 2 });
  await agentsOperation(agents, 'c', { op: 'saveTeam', team: { name: 'web', members: ['coder-1'] } });
  await agentsOperation(agents, 'c', { op: 'archiveTeam', name: 'web', expectedVersion: 1, archiveMembers: true });
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['GET', '/roster?archived=1'], ['POST', '/roster/agents'], ['POST', '/roster/agents/coder-1'],
    ['POST', '/roster/agents/coder-1/archive'], ['POST', '/roster/teams'], ['POST', '/roster/teams/web/archive']]);
  assert.deepEqual(calls[2][2], { name: 'coder-1', model: 'opus', expectedVersion: 1 });
  assert.equal((await agentsOperation(agents, 'c', { op: 'archiveAgent', name: '../x', expectedVersion: 1 })).status, 400);
});

test('roster summary: counts by status and role, active teams, Board mirror state (#81)', async () => {
  const empty = new Roster();
  assert.deepEqual(empty.summary(), { agents: { active: { total: 0, coder: 0, reviewer: 0 }, paused: { total: 0, coder: 0, reviewer: 0 },
    archived: { total: 0, coder: 0, reviewer: 0 } }, teams: 0, board: { mirrored: 0, pending: 0, error: null } });

  let now = 1000, refuse = true;
  const mirror = { sync: async view => { if (refuse && view.name === 'rev-1') throw Object.assign(new Error('no grant'), { code: 'FORBIDDEN' }); return { profileId: `p-${view.name}`, version: 1 }; } };
  const roster = new Roster({ mirror, now: () => now });
  roster.create({ name: 'coder-1', model: 'haiku' });
  roster.create({ name: 'coder-2', model: 'haiku' });
  roster.create({ name: 'rev-1', role: 'reviewer', model: 'opus' });
  roster.create({ name: 'old', model: 'haiku' });
  await roster.resync({ minIntervalMs: 0 });
  roster.update('coder-2', { expectedVersion: 1, status: 'paused' });
  roster.archive('old', { expectedVersion: 1 });
  roster.saveTeam({ name: 'a', members: ['coder-1'] });
  roster.saveTeam({ name: 'b', members: ['rev-1'] });
  roster.archiveTeam('b', { expectedVersion: 1 });
  await new Promise(r => setTimeout(r, 20));

  const summary = roster.summary();
  assert.deepEqual(summary.agents.active, { total: 2, coder: 1, reviewer: 1 });
  assert.deepEqual(summary.agents.paused, { total: 1, coder: 1, reviewer: 0 });
  assert.deepEqual(summary.agents.archived, { total: 1, coder: 1, reviewer: 0 });
  assert.equal(summary.teams, 1);
  assert.equal(summary.board.error, 'FORBIDDEN: no grant');
  assert.equal(summary.board.mirrored + summary.board.pending, 3, 'archived agents count in neither');
  assert.ok(summary.board.pending >= 1);

  refuse = false; now += 60_000;
  await roster.resync({ minIntervalMs: 0 });
  await roster.resync({ minIntervalMs: 0 });
  assert.deepEqual(roster.summary().board, { mirrored: 3, pending: 0, error: null });
});
