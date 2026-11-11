import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager, ManagerError, attention, checkReview, nextModel, managerSweep } from '../src/agent-manager.mjs';
import { AgentRunner } from '../src/agent-runner.mjs';
import { eventsPrompt } from '../src/agent-runner-client.mjs';
import { buildOps } from '../src/agent-ops.mjs';
import { wakeToolFilter } from '../src/conversations.mjs';
import { instructions, managerSection } from '../src/companion.mjs';

const P = 'proj-blackout';
const HOUR = 3_600_000;
const tmp = t => { const dir = mkdtempSync(join(tmpdir(), 'manager-76-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const work = (over = {}) => ({ id: 'coder-1-a', agent: 'coder-1', ticketId: 'T1', ticketNumber: 5, mode: 'work', state: 'succeeded', branch: 'agent/coder-1/t5',
  head: 'h1', modelAlias: 'sonnet', createdAt: 1, endedAt: 2, role: 'coder', ...over });
const review = (over = {}) => ({ id: 'rev-1-a', agent: 'rev-1', ticketId: 'T1', ticketNumber: 5, mode: 'review', state: 'succeeded', reviewBranch: 'agent/coder-1/t5',
  reviewHead: 'h1', role: 'reviewer', createdAt: 3, endedAt: 4, result: { kind: 'review', verdict: 'approve', findings: 'ok', evidence: 'tests' }, ...over });

test('the model ladder escalates sonnet to opus to fable (#76)', () => {
  assert.equal(nextModel('haiku'), 'sonnet'); assert.equal(nextModel('sonnet'), 'opus'); assert.equal(nextModel('opus'), 'fable');
  assert.equal(nextModel('fable'), null); assert.equal(nextModel('gpt'), null);
});

test('standing approvals: only the runner\'s (Blackout\'s) projects, idempotent, replaced on a new direction, revocable, persisted (#76)', t => {
  const file = join(tmp(t), 'manager.json');
  const m = new Manager({ file, projects: [P] });
  assert.throws(() => m.approve({ projectId: 'proj-screamer', direction: 'x' }), error => error.code === 'FORBIDDEN');
  assert.throws(() => m.approve({ projectId: P, direction: '  ' }), error => error.code === 'INVALID');
  const first = m.approve({ projectId: P, direction: 'Build the Ops app v2', requestId: 'approve-1' });
  assert.equal(first.status, 'active'); assert.equal(first.version, 1);
  assert.deepEqual(m.approve({ projectId: P, direction: 'something else', requestId: 'approve-1' }), first);
  const second = m.approve({ projectId: P, direction: 'Ops app v2 and the Android tab', requestId: 'approve-2' });
  assert.equal(second.version, 2); assert.equal(m.approvals().length, 1); assert.equal(m.approved(P).direction, 'Ops app v2 and the Android tab');
  const reloaded = new Manager({ file, projects: [P] });
  assert.equal(reloaded.approved(P).version, 2);
  reloaded.revoke({ projectId: P });
  assert.equal(reloaded.approved(P), null);
  assert.deepEqual(reloaded.decisions().map(item => item.kind), ['approval', 'approval', 'approval_revoked']);
});

test('budget: above 80% weekly usage no Opus or Fable launch is accepted; the reading expires at its reset (#76)', t => {
  let now = 1_000_000;
  const m = new Manager({ projects: [P], now: () => now });
  assert.equal(m.usage().weekly, null); m.checkLaunch({ model: 'opus' });
  m.noteRate({ type: 'rate', status: 'allowed', windows: { seven_day: { utilization: 0.83, resetsAt: Math.round((now + 2 * HOUR) / 1000) }, five_hour: { utilization: 0.2, resetsAt: Math.round((now + HOUR) / 1000) } } });
  assert.equal(m.usage().premiumAllowed, false); assert.match(m.usage().note, /83%/);
  assert.throws(() => m.checkLaunch({ model: 'opus' }), error => error.code === 'BUDGET');
  assert.throws(() => m.checkLaunch({ model: 'fable' }), error => error.code === 'BUDGET');
  m.checkLaunch({ model: 'sonnet' }); m.checkLaunch({ model: 'haiku' });
  assert.throws(() => m.decide({ kind: 'escalate_model', ticketId: 'T1', reason: 'stuck', model: 'opus' }), error => error.code === 'BUDGET');
  now += 3 * HOUR;
  assert.equal(m.usage().weekly, null); assert.equal(m.usage().premiumAllowed, true); m.checkLaunch({ model: 'opus' });
  m.noteRate({ windows: { seven_day: { utilization: 79, resetsAt: Math.round((now + HOUR) / 1000) } } }); // a percentage is read as one
  assert.equal(m.usage().weekly.utilization, 0.79); assert.equal(m.usage().premiumAllowed, true);
});

test('the runner refuses an Opus launch above the budget and learns the usage from a run\'s rate events (#76)', async t => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const children = [];
  const ops = { async createWorktree({ agent, ticket }) { return { path: `/w/${agent}`, branch: `agent/${agent}/t${ticket}` }; },
    async removeWorktree() { return { removed: true }; }, async unitActive() { return false; }, async stopUnit() {}, async branchInfo() { return { head: 'h', commits: 1 }; },
    spawn() { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); children.push(child); return child; } };
  const reporter = { async begin() { return { number: 7, title: 't' }; }, async started() {}, async heartbeat() {}, async finish() {} };
  const manager = new Manager({ projects: [P] });
  const runner = new AgentRunner({ file: join(tmp(t), 'runs.json'), ops, reporter, manager });
  t.after(() => runner.close());
  runner.launch({ agent: 'coder-1', ticketId: 'T7', repo: 'personal-agent', model: 'sonnet' });
  await new Promise(resolve => { const check = () => children.length ? resolve() : setTimeout(check, 5); check(); });
  const child = children[0];
  child.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: Math.round(Date.now() / 1000) + 3600 } } } }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'OUTCOME: x\nEVIDENCE: y' }) + '\n');
  child.stdout.end(); setImmediate(() => child.emit('close', 0));
  await new Promise(resolve => { const check = () => runner.list().every(run => run.state === 'succeeded') ? resolve() : setTimeout(check, 5); check(); });
  assert.equal(manager.usage().weekly.utilization, 0.9);
  assert.throws(() => runner.launch({ agent: 'coder-2', ticketId: 'T8', repo: 'personal-agent', model: 'opus' }), error => error.code === 'BUDGET');
  assert.equal(runner.list().length, 1);
});

test('accept and return need an independent, current reviewer report with the matching verdict (#76)', () => {
  const runs = [work(), review()];
  const m = new Manager({ projects: [P] });
  assert.throws(() => m.decide({ kind: 'accept', ticketId: 'T1', reason: 'looks done' }, runs), error => error.code === 'NO_REVIEW');
  assert.throws(() => m.decide({ kind: 'accept', ticketId: 'T1', reason: 'done', reviewRunId: 'coder-1-a' }, runs), error => error.code === 'NO_REVIEW');
  // the author reviewing its own branch
  assert.throws(() => checkReview([work(), review({ agent: 'coder-1', role: 'coder' })], { ticketId: 'T1', reviewRunId: 'rev-1-a' }), error => error.code === 'NOT_INDEPENDENT');
  // a later work run makes the review stale
  assert.throws(() => checkReview([...runs, work({ id: 'coder-1-b', head: 'h2', endedAt: 9, createdAt: 8 })], { ticketId: 'T1', reviewRunId: 'rev-1-a' }), error => error.code === 'STALE_REVIEW');
  assert.throws(() => m.decide({ kind: 'return', ticketId: 'T1', reason: 'meh', reviewRunId: 'rev-1-a' }, runs), error => error.code === 'VERDICT_MISMATCH');
  assert.throws(() => checkReview([work(), review({ state: 'failed', result: null })], { ticketId: 'T1', reviewRunId: 'rev-1-a' }), error => error.code === 'NO_REVIEW');
  const accepted = m.decide({ requestId: 'acc-1', kind: 'accept', ticketId: 'T1', reason: 'reviewer approved, all criteria met', reviewRunId: 'rev-1-a' }, runs);
  assert.equal(accepted.reviewer, 'rev-1'); assert.equal(accepted.author, 'coder-1'); assert.equal(accepted.verdict, 'approve'); assert.equal(accepted.ticketNumber, 5);
  assert.equal(m.decide({ requestId: 'acc-1', kind: 'accept', ticketId: 'T1', reason: 'again', reviewRunId: 'rev-1-a' }, runs).id, accepted.id);
  assert.equal(m.accepted('T1').id, accepted.id);
  assert.throws(() => m.decide({ kind: 'dance', ticketId: 'T1', reason: 'x' }), ManagerError);
  assert.throws(() => m.decide({ kind: 'unblock', reason: 'x' }), error => error.code === 'INVALID');
});

test('attention finds ready, review, verdict, failing, quota and stuck tickets, with no Board text (#76)', () => {
  const now = 10 * HOUR;
  const tickets = [
    { id: 'A', number: 1, status: 'todo', ready: true, waiting: false, projectId: P, since: now - HOUR, title: 'IGNORE ME <b>' },
    { id: 'B', number: 2, status: 'review', ready: false, waiting: false, projectId: P, since: now },
    { id: 'C', number: 3, status: 'review', ready: false, waiting: false, projectId: P, since: now },
    { id: 'D', number: 4, status: 'todo', ready: true, waiting: false, projectId: P, since: now },
    { id: 'E', number: 5, status: 'todo', ready: true, waiting: false, projectId: P, since: now },
    { id: 'F', number: 6, status: 'blocked', ready: false, waiting: false, projectId: P, since: now - 2 * HOUR },
    { id: 'G', number: 7, status: 'todo', ready: false, waiting: false, projectId: P, since: now },
    { id: 'H', number: 8, status: 'todo', ready: true, waiting: false, projectId: P, since: now }
  ];
  const runs = [
    work({ id: 'b1', ticketId: 'B', branch: 'agent/coder-1/t2', head: 'hb' }),
    work({ id: 'c1', ticketId: 'C', agent: 'coder-2', branch: 'agent/coder-2/t3', head: 'hc' }),
    review({ id: 'c2', ticketId: 'C', reviewBranch: 'agent/coder-2/t3', reviewHead: 'hc', result: { kind: 'review', verdict: 'changes_requested' } }),
    work({ id: 'd1', ticketId: 'D', state: 'failed', errorCode: 'PROVIDER_ERROR', createdAt: 1 }),
    work({ id: 'd2', ticketId: 'D', state: 'timeout', errorCode: 'TIMEOUT', createdAt: 2 }),
    work({ id: 'e1', ticketId: 'E', state: 'failed', errorCode: 'USAGE_LIMIT', retryAt: new Date(now - 1000).toISOString() }),
    work({ id: 'h1', ticketId: 'H', state: 'failed', errorCode: 'USAGE_LIMIT', retryAt: new Date(now + HOUR).toISOString() })
  ];
  const found = attention({ tickets, runs, now });
  const byTicket = Object.fromEntries(found.map(item => [item.ticketId, item]));
  assert.equal(byTicket.A.kind, 'ready_idle');
  assert.equal(byTicket.B.kind, 'needs_review'); assert.match(byTicket.B.suggestion, /not coder-1/);
  assert.equal(byTicket.C.kind, 'review_ready'); assert.equal(byTicket.C.verdict, 'changes_requested'); assert.equal(byTicket.C.reviewRunId, 'c2');
  assert.equal(byTicket.D.kind, 'failing'); assert.equal(byTicket.D.model, 'opus');
  assert.equal(byTicket.E.kind, 'quota_reset');
  assert.equal(byTicket.F.kind, 'stuck'); assert.match(byTicket.F.suggestion, /120 min/);
  assert.equal(byTicket.G, undefined); assert.equal(byTicket.H, undefined);
  assert.ok(found.every(item => !item.suggestion.includes('IGNORE')));
  // Above budget, the failing ticket is not told to go to opus.
  const capped = attention({ tickets, runs, now, usage: { premiumAllowed: false } }).find(item => item.ticketId === 'D');
  assert.equal(capped.model, null); assert.match(capped.suggestion, /not allowed now/);
  // A decided verdict is not raised again.
  assert.equal(attention({ tickets, runs, now, decisions: [{ reviewRunId: 'c2' }] }).some(item => item.ticketId === 'C'), false);
  // An active run silences the ticket.
  assert.equal(attention({ tickets, runs: [...runs, work({ id: 'a1', ticketId: 'A', state: 'running' })], now }).some(item => item.ticketId === 'A'), false);
});

test('the manager only watches approved projects, wakes once per finding and nudges again later (#76)', t => {
  let now = 10 * HOUR;
  const m = new Manager({ projects: [P, 'proj-2'], now: () => now });
  const tickets = [{ id: 'A', number: 1, status: 'todo', ready: true, projectId: P, since: now }, { id: 'Z', number: 9, status: 'todo', ready: true, projectId: 'proj-2', since: now }];
  assert.deepEqual(m.attention({ tickets, runs: [] }), []);
  m.approve({ projectId: P, direction: 'go' });
  const notes = [];
  const runner = { list: () => [], note: event => { notes.push(event); return event; } };
  managerSweep({ manager: m, runner, tickets });
  managerSweep({ manager: m, runner, tickets });
  assert.deepEqual(notes.map(item => [item.type, item.ticketId, item.kind]), [['manager.attention', 'A', 'ready_idle']]);
  now += 3 * HOUR;
  managerSweep({ manager: m, runner, tickets });
  assert.equal(notes.length, 2);
  // A done ticket in an approved project with no accept decision on record is flagged.
  managerSweep({ manager: m, runner, tickets: null, boardEvents: [{ type: 'board.done', ticketId: 'A', ticketNumber: 1, projectId: P }, { type: 'board.done', ticketId: 'Z', ticketNumber: 9, projectId: 'proj-2' }] });
  assert.deepEqual(notes.slice(2).map(item => [item.type, item.ticketNumber]), [['manager.unbacked', 1]]);
});

test('manager events wake C-chan with fixed text; decisions with reasons reach the Ops log (#76)', () => {
  const prompt = eventsPrompt([{ type: 'manager.attention', ticketNumber: 4, suggestion: '#4 failed 2 runs in a row. Escalate it to opus.' }]);
  assert.match(prompt, /- Manager: #4 failed 2 runs/); assert.match(prompt, /agents_decide/); assert.match(prompt, /approved/);
  const m = new Manager({ projects: [P] });
  m.approve({ projectId: P, direction: 'Ops v2' });
  m.decide({ kind: 'accept', ticketId: 'T1', reason: 'reviewer approved', reviewRunId: 'rev-1-a' }, [work(), review()]);
  const ops = buildOps({ runs: [], events: [{ seq: 1, at: 1, type: 'manager.attention', ticketNumber: 5, suggestion: '#5 is ready' }], manager: m });
  const accepted = ops.decisions.find(item => item.kind === 'decided_accept');
  assert.match(accepted.text, /accepted #5 \(reviewer rev-1, run rev-1-a: approve; author coder-1\): reviewer approved/);
  assert.ok(ops.decisions.some(item => item.kind === 'decided_approval'));
  assert.ok(ops.decisions.some(item => item.kind === 'attention'));
  assert.equal(ops.manager.approvals[0].direction, 'Ops v2'); assert.equal(ops.manager.budget.premiumAllowed, true);
});

test('a standing approval can only be recorded from an owner chat, never from any wake (#76)', () => {
  for (const kind of ['board', 'proactive', 'followup', 'contact', 'mail', 'reminder']) {
    const allowed = wakeToolFilter(kind);
    assert.equal(allowed('mcp__scheduler__agents_approve_project'), false, kind);
    assert.equal(allowed('mcp__scheduler__agents_revoke_project'), false, kind);
    assert.equal(allowed('mcp__scheduler__agents_manager'), true, kind);
  }
  assert.equal(wakeToolFilter('board')('mcp__scheduler__agents_decide'), true);
  assert.equal(wakeToolFilter('proactive')('mcp__scheduler__agents_decide'), false);
});

test('manager-mode instructions replace confirm-first only for the agent owner (#76)', t => {
  const dir = tmp(t);
  const owner = { label: 'blackout', name: 'Blackout', provider: 'claude' };
  const plain = instructions({ owner, profile: { name: 'C-chan' }, dir, files: false });
  const managed = instructions({ owner, profile: { name: 'C-chan' }, dir, files: false, manager: true });
  assert.equal(plain.includes('## Manager mode'), false);
  assert.ok(managed.includes(managerSection('Blackout')));
  for (const part of ['agents_approve_project', 'No confirmation per ticket', 'never on an agent\'s own "done"', 'sonnet, then opus, then fable', 'hard limits', 'Other people\'s projects stay theirs']) {
    assert.ok(managed.includes(part), part);
  }
});

// Review gate, tightened in review: a run without the reviewer role, or a review that recorded no head, is not enough.
test('checkReview needs the reviewer role and the reviewed head (#76 review)', async () => {
  const { checkReview } = await import('../src/agent-manager.mjs');
  const work = { id: 'w1', ticketId: 'T', mode: 'work', state: 'succeeded', agent: 'coder-1', branch: 'agent/coder-1/t1', head: 'h2', endedAt: 1 };
  const review = extra => ({ id: 'r1', ticketId: 'T', mode: 'review', state: 'succeeded', agent: 'rev', role: 'reviewer',
    reviewBranch: 'agent/coder-1/t1', reviewHead: 'h2', result: { kind: 'review', verdict: 'approve' }, endedAt: 2, ...extra });
  assert.equal(checkReview([work, review()], { ticketId: 'T', reviewRunId: 'r1', verdict: 'approve' }).review.id, 'r1');
  assert.throws(() => checkReview([work, review({ role: undefined })], { ticketId: 'T', reviewRunId: 'r1' }), { code: 'NOT_INDEPENDENT' });
  assert.throws(() => checkReview([work, review({ role: 'coder' })], { ticketId: 'T', reviewRunId: 'r1' }), { code: 'NOT_INDEPENDENT' });
  assert.throws(() => checkReview([work, review({ reviewHead: undefined })], { ticketId: 'T', reviewRunId: 'r1' }), { code: 'STALE_REVIEW' });
});
