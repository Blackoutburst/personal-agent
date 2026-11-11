// End to end for manager mode (#76): an idea from Blackout becomes tickets, gets built, reviewed and accepted with no
// human step except a hard limit. Real pieces: AgentRunner, BoardReporter, BoardWatch, Roster, Manager, the runner API
// (createRunnerApi), C-chan's tool path (agentsOperation) and the manager sweep. Faked: the Board (in memory), the sandbox
// (no units, no git: agents answer from a script), and C-chan's model, whose choices are scripted from the manager rules
// (managerSection) and the wake lines. The model's own judgment is NOT covered here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from '../src/agent-runner.mjs';
import { BoardReporter, BoardWatch } from '../src/agent-runner-board.mjs';
import { Roster } from '../src/agent-roster.mjs';
import { Manager, managerSweep } from '../src/agent-manager.mjs';
import { createRunnerApi } from '../src/agent-runner-api.mjs';
import { agentsOperation, eventsPrompt } from '../src/agent-runner-client.mjs';
import { buildOps } from '../src/agent-ops.mjs';

const PROJECT = 'proj-blackout';

// An in-memory Board with the tools the runner and C-chan use. Every call is recorded with who made it.
function fakeBoard() {
  const tickets = new Map(), calls = [], requests = [], posts = [];
  let number = 100, version = 0;
  const view = ticket => ({ ...ticket, ready: ticket.status === 'todo' && ticket.deps.every(id => tickets.get(id)?.status === 'done'),
    waiting_on_human: requests.some(request => request.ticket_id === ticket.id && !request.resolved) });
  const as = who => ({
    async call(tool, args) {
      calls.push({ who, tool, args });
      if (tool === 'create_ticket') {
        const id = `t-${++number}`;
        tickets.set(id, { id, number, project_id: args.project_id, title: args.title, description: args.description ?? '', acceptance_criteria: args.acceptance_criteria ?? '',
          status: 'todo', deps: args.depends_on ?? [], thread_id: `th-${number}`, version: ++version });
        return { ticket: view(tickets.get(id)) };
      }
      if (tool === 'list_tickets') return { items: [...tickets.values()].filter(ticket => ticket.project_id === args.project_id).map(view), next_cursor: null };
      const ticket = tickets.get(args.ticket_id);
      if (tool === 'get_ticket') return { ticket: view(ticket) };
      if (tool === 'claim_ticket') { ticket.status = 'in_progress'; ticket.claimedBy = who; ticket.version = ++version; return { ticket: view(ticket) }; }
      if (tool === 'reserve_execution') throw Object.assign(new Error('This profile has no Runtime grant.'), { code: 'FORBIDDEN' });
      if (tool === 'post_message') { posts.push({ who, thread: args.thread_id, body: args.body }); return { message: { id: `m${posts.length}` } }; }
      if (tool === 'renew_ticket' || tool === 'finish_execution') return {};
      if (tool === 'update_ticket') {
        if (args.changes.status) ticket.status = args.changes.status;
        if (args.changes.release_claim) ticket.claimedBy = null;
        if (args.changes.outcome) ticket.outcome = args.changes.outcome;
        ticket.version = ++version; return { ticket: view(ticket) };
      }
      if (tool === 'request_human_input') { requests.push({ ...args, who }); return { request: { id: `r${requests.length}` } }; }
      throw new Error(`fake Board: no tool ${tool}`);
    }
  });
  return { tickets, calls, requests, posts, as };
}

// The sandbox: worktrees, units and git, faked. An agent's answer comes from script(kind, ticketNumber, attempt).
function fakeSandbox(script) {
  const heads = new Map(), branchOf = new Map(), attempts = new Map(), active = new Set(), log = [];
  let commit = 0;
  const ops = {
    async createWorktree({ agent, ticket }) { const path = `/w/${agent}-t${ticket}`, branch = `agent/${agent}/t${ticket}`; branchOf.set(path, branch); return { path, branch }; },
    async checkout({ worktree, ref }) { heads.set(branchOf.get(worktree), heads.get(ref)); return { head: heads.get(ref) }; },
    async removeWorktree() { return { removed: true }; },
    async unitActive(unit) { return active.has(unit); },
    async stopUnit(unit) { active.delete(unit); },
    async branchInfo({ branch }) { return { head: heads.get(branch) ?? null, commits: heads.has(branch) ? 1 : 0 }; },
    spawn({ unit, cwd, spec }) {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      active.add(unit);
      let prompt = '';
      child.stdin.on('data', chunk => { prompt += chunk; });
      child.stdin.on('end', () => setImmediate(() => {
        const reviewing = prompt.includes('VERDICT: approve | changes_requested');
        const ticket = Number(prompt.match(/Ticket #(\d+):/)[1]);
        const key = `${reviewing ? 'review' : 'work'}:${ticket}`;
        const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
        const model = spec.args[spec.args.indexOf('--model') + 1];
        const answer = script(reviewing ? 'review' : 'work', ticket, attempt, { prompt, model });
        log.push({ kind: reviewing ? 'review' : 'work', ticket, attempt, model, agent: prompt.match(/^You are ([a-z0-9-]+),/)[1] });
        child.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.42, resetsAt: Math.round(Date.now() / 1000) + 86400 } } } }) + '\n');
        child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n');
        if (answer !== null) {
          if (!reviewing) heads.set(branchOf.get(cwd), `c${++commit}`);
          child.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: answer }) + '\n');
        }
        child.stdout.end();
        setImmediate(() => { active.delete(unit); child.emit('close', answer === null ? 1 : 0); });
      }));
      return child;
    }
  };
  return { ops, log };
}

// C-chan, scripted. She acts only through her tools: agentsOperation (runner) and her own Board identity.
function scriptedCchan({ agents, board, companionId = 'cchan' }) {
  const tool = async input => {
    const answer = await agentsOperation(agents, companionId, input);
    return answer;
  };
  const decisions = [], refused = [];
  const ticketBy = number => [...board.tickets.values()].find(ticket => ticket.number === number);
  async function decide(decision) {
    const answer = await tool({ op: 'decide', decision: { requestId: `d-${decisions.length + refused.length}-${decision.kind}-${decision.ticketId}`, ...decision } });
    (answer.status === 201 ? decisions : refused).push(answer.body.decision ?? answer.body.error);
    return answer;
  }
  async function onEvent(event) {
    if (event.type !== 'manager.attention') return;
    const ticket = board.tickets.get(event.ticketId);
    const n = ticket.number;
    if (event.kind === 'ready_idle') {
      const agent = event.agent ?? `coder-t${n}`;
      const roster = (await tool({ op: 'roster' })).body.agents;
      const instructions = ticket.instructions ?? '';
      const launched = await tool({ op: 'launch', launch: { requestId: `launch-${n}-${event.key.split(':').at(-1)}`, agent, ticketId: ticket.id, repo: 'personal-agent',
        ...(roster.some(item => item.name === agent) ? {} : { model: 'sonnet' }), ...(instructions ? { instructions } : {}) } });
      if (launched.status !== 202) { refused.push(launched.body.error); if (launched.body.error.code !== 'HARD_LIMIT') throw new Error(JSON.stringify(launched.body)); return; }
      await decide({ kind: 'dispatch', ticketId: ticket.id, ticketNumber: n, agent, reason: `#${n} is ready; ${agent} takes it.` });
    } else if (event.kind === 'needs_review') {
      const roster = (await tool({ op: 'roster' })).body.agents;
      if (!roster.some(item => item.name === 'rev-1')) {
        const saved = await tool({ op: 'saveAgent', agent: { name: 'rev-1', role: 'reviewer', kind: 'standing', model: 'opus' } });
        assert.equal(saved.status, 201, JSON.stringify(saved.body));
      }
      const launched = await tool({ op: 'launch', launch: { requestId: `review-${n}-${event.key.split(':').slice(2).join('-')}`, agent: 'rev-1', ticketId: ticket.id, repo: 'personal-agent', mode: 'review' } });
      assert.equal(launched.status, 202, JSON.stringify(launched.body));
    } else if (event.kind === 'review_ready') {
      // First she tries to accept on the author's word alone: refused. Then she follows the reviewer's verdict.
      const bare = await decide({ kind: 'accept', ticketId: ticket.id, reason: 'the coder said done' });
      assert.equal(bare.status, 409);
      if (event.verdict === 'approve') {
        const logged = await decide({ kind: 'accept', ticketId: ticket.id, reviewRunId: event.reviewRunId, reason: 'independent review approved every criterion' });
        assert.equal(logged.status, 201, JSON.stringify(logged.body));
        await board.as('cchan').call('update_ticket', { ticket_id: ticket.id, changes: { status: 'done' } });
      } else {
        const logged = await decide({ kind: 'return', ticketId: ticket.id, reviewRunId: event.reviewRunId, reason: 'reviewer requested changes' });
        assert.equal(logged.status, 201, JSON.stringify(logged.body));
        ticket.instructions = 'The reviewer requested changes: see the review on the thread.';
        await board.as('cchan').call('update_ticket', { ticket_id: ticket.id, changes: { status: 'todo' } });
      }
    } else if (event.kind === 'failing') {
      const roster = (await tool({ op: 'roster' })).body.agents;
      const agent = roster.find(item => item.name === event.agent);
      const saved = await tool({ op: 'saveAgent', agent: { name: agent.name, model: event.model, expectedVersion: agent.version } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      await decide({ kind: 'escalate_model', ticketId: ticket.id, ticketNumber: n, model: event.model, agent: agent.name, reason: `failed twice on ${agent.model}` });
      const launched = await tool({ op: 'launch', launch: { requestId: `launch-${n}-escalated`, agent: agent.name, ticketId: ticket.id, repo: 'personal-agent' } });
      assert.equal(launched.status, 202, JSON.stringify(launched.body));
    }
  }
  return { tool, decide, onEvent, decisions, refused, ticketBy };
}

test('an idea from Blackout becomes tickets, gets built, reviewed and accepted with no human step except a hard limit (#76)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-e2e-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const board = fakeBoard();
  // #101 API: first delivery is sent back by the reviewer, the fix is approved. #102 UI: fails twice on sonnet, then
  // delivers on opus. #103 deploy: the instructions ask for a deployment, a hard limit.
  const sandbox = fakeSandbox((kind, ticket, attempt) => {
    if (kind === 'review') return ticket === 101 && attempt === 1 ? 'VERDICT: changes_requested\nFINDINGS: criterion 2 not met\nEVIDENCE: npm test'
      : 'VERDICT: approve\nFINDINGS: all criteria met\nEVIDENCE: npm test 40/40';
    if (ticket === 102 && attempt <= 2) return null; // exits without a result
    return `OUTCOME: built #${ticket} (attempt ${attempt})\nEVIDENCE: npm test passes`;
  });
  const runnerBoard = board.as('runner');
  const roster = new Roster({ file: join(dir, 'roster.json') });
  const manager = new Manager({ file: join(dir, 'manager.json'), projects: [PROJECT] });
  const runner = new AgentRunner({ file: join(dir, 'runs.json'), ops: sandbox.ops, roster, manager, limits: { maxConcurrent: 3 },
    reporter: new BoardReporter({ client: runnerBoard, projects: [PROJECT], ownerId: 'blackoutburst' }) });
  t.after(() => runner.close());
  const watch = new BoardWatch({ client: runnerBoard, projects: [PROJECT] });
  const api = createRunnerApi({ runner, roster, manager, projects: [PROJECT], tickets: () => watch.tickets() });
  const agents = { client: { call: (method, path, body) => api(method, path, body ?? {}) }, allowed: id => id === 'cchan' };
  const cchan = scriptedCchan({ agents, board });

  // 1. Blackout, in chat: "build an API and a UI on top of it; and deploy it". C-chan records the standing approval.
  //    This is the one approval; nothing below asks him again.
  const approval = await cchan.tool({ op: 'approveProject', approval: { requestId: 'approve-ops-v2', projectId: PROJECT, direction: 'Ops v2: an API, a UI on top of it, then deploy.' } });
  assert.equal(approval.status, 200, JSON.stringify(approval.body));
  // TheScreamer's projects are not C-chan's to manage.
  assert.equal((await cchan.tool({ op: 'approveProject', approval: { requestId: 'a2', projectId: 'proj-screamer', direction: 'x' } })).status, 403);
  // 2. She turns the idea into tickets with dependencies, on her own Board identity, without listing them first.
  await watch.poll(); // the watch primes silently
  const cc = board.as('cchan');
  const api1 = (await cc.call('create_ticket', { project_id: PROJECT, title: 'API', acceptance_criteria: '1. endpoint 2. tests' })).ticket;
  const ui = (await cc.call('create_ticket', { project_id: PROJECT, title: 'UI', depends_on: [api1.id], acceptance_criteria: 'renders' })).ticket;
  const deploy = (await cc.call('create_ticket', { project_id: PROJECT, title: 'Deploy', acceptance_criteria: 'live' })).ticket;
  board.tickets.get(deploy.id).instructions = 'Deploy the new Ops app to production.';
  assert.equal((await cchan.decide({ kind: 'plan', projectId: PROJECT, reason: 'API, then UI (depends on API), then deploy' })).status, 201);

  // 3. Unattended: the runner's Board poll + manager sweep produce events; C-chan reacts to each wake.
  let cursor = 0;
  const wakes = [];
  for (let round = 0; round < 200; round++) {
    const boardEvents = await watch.poll();
    for (const event of boardEvents) runner.note(event);
    managerSweep({ manager, runner, tickets: watch.tickets(), boardEvents });
    const events = runner.events(cursor);
    if (events.length) cursor = events.at(-1).seq;
    const wake = events.filter(event => ['run.ended', 'board.ready', 'board.review', 'board.done', 'manager.attention', 'manager.unbacked'].includes(event.type));
    if (wake.length) wakes.push(eventsPrompt(wake));
    for (const event of events) await cchan.onEvent(event);
    const done = [api1.id, ui.id].every(id => board.tickets.get(id).status === 'done');
    if (done && !runner.list({ active: true }).length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  // Built, reviewed and accepted.
  assert.equal(board.tickets.get(api1.id).status, 'done');
  assert.equal(board.tickets.get(ui.id).status, 'done');
  // The only human step: the hard limit on the deploy ticket, raised by the runner as a Needs-you for Blackout.
  assert.deepEqual(board.requests.map(request => [request.ticket_id, request.owner_id, /deployment is a hard limit/.test(request.question)]),
    [[deploy.id, 'blackoutburst', true]]);
  assert.equal(cchan.refused.filter(error => error.code === 'HARD_LIMIT').length >= 1, true);
  assert.equal(board.tickets.get(deploy.id).status, 'todo');
  // Every review decision is backed by an independent reviewer's report; "done" alone was refused.
  const accepts = cchan.decisions.filter(item => item.kind === 'accept'), returns = cchan.decisions.filter(item => item.kind === 'return');
  assert.equal(accepts.length, 2); assert.equal(returns.length, 1);
  for (const item of [...accepts, ...returns]) { assert.equal(item.reviewer, 'rev-1'); assert.notEqual(item.author, 'rev-1'); assert.ok(item.reviewRunId); }
  assert.ok(cchan.refused.some(error => error.code === 'NO_REVIEW'));
  // The stuck ticket was escalated one model up, and delivered there.
  assert.ok(cchan.decisions.some(item => item.kind === 'escalate_model' && item.ticketNumber === ui.number && item.model === 'opus'));
  assert.deepEqual(sandbox.log.filter(item => item.ticket === ui.number && item.kind === 'work').map(item => item.model),
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  // The return went back to the same coder, whose fix was reviewed again on the new head.
  assert.deepEqual(sandbox.log.filter(item => item.ticket === api1.number).map(item => `${item.kind}:${item.agent}`),
    ['work:coder-t101', 'review:rev-1', 'work:coder-t101', 'review:rev-1']);
  // C-chan never did ticket work: every claim and every review/todo move by an agent was the runner's.
  assert.ok(board.calls.filter(call => call.tool === 'claim_ticket').every(call => call.who === 'runner'));
  // Decisions are logged with reasons and reach the Ops app; no accept is flagged as unbacked.
  const ops = buildOps({ runs: runner.list(), events: runner.events(0), manager });
  for (const kind of ['decided_plan', 'decided_dispatch', 'decided_return', 'decided_accept', 'decided_escalate_model', 'decided_approval']) {
    assert.ok(ops.decisions.some(item => item.kind === kind), kind);
  }
  assert.equal(runner.events(0).some(event => event.type === 'manager.unbacked'), false);
  // Task agents are archived once their ticket is done; the standing reviewer stays.
  const list = roster.list({ includeArchived: true }).agents;
  assert.equal(list.find(item => item.name === 'coder-t101').status, 'archived');
  assert.equal(list.find(item => item.name === 'rev-1').status, 'active');
  // The weekly usage was read from the runs.
  assert.equal(manager.usage().weekly.utilization, 0.42);
  // Wakes carried the manager lines (ids and numbers only).
  assert.ok(wakes.some(prompt => /- Manager: #101 is ready and nobody is on it/.test(prompt)));
  assert.ok(wakes.every(prompt => !prompt.includes('Deploy the new Ops app')));
});

test('a ticket marked done in an approved project without a backed accept is flagged in the log (#76)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-e2e-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const board = fakeBoard();
  const manager = new Manager({ projects: [PROJECT] });
  manager.approve({ projectId: PROJECT, direction: 'go' });
  const runner = new AgentRunner({ file: join(dir, 'runs.json'), ops: fakeSandbox(() => '').ops, manager, reporter: {} });
  t.after(() => runner.close());
  const watch = new BoardWatch({ client: board.as('runner'), projects: [PROJECT] });
  const ticket = (await board.as('cchan').call('create_ticket', { project_id: PROJECT, title: 'x' })).ticket;
  await watch.poll();
  await board.as('cchan').call('update_ticket', { ticket_id: ticket.id, changes: { status: 'done' } });
  const events = await watch.poll();
  for (const event of events) runner.note(event);
  managerSweep({ manager, runner, tickets: watch.tickets(), boardEvents: events });
  assert.deepEqual(runner.events(0).map(event => event.type), ['board.done', 'manager.unbacked']);
  assert.ok(buildOps({ runs: [], events: runner.events(0), manager }).decisions.some(item => item.kind === 'unbacked'));
});
