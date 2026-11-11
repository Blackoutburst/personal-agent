import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner, parseReport, agentPrompt, normalizeLimits } from '../src/agent-runner.mjs';
import { claude, codex, resolveModel } from '../src/agent-providers.mjs';
import { BoardReporter, BoardWatch, runSummary } from '../src/agent-runner-board.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.prompt = ''; child.stdin.on('data', chunk => { child.prompt += chunk; });
  child.say = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.exit = (code = 0) => { child.stdout.end(); setImmediate(() => child.emit('close', code)); };
  return child;
}

function fakes() {
  const children = [], active = new Set(), calls = [];
  const ops = {
    async createWorktree({ repo, agent, ticket }) { calls.push(['create', repo, agent, ticket]); return { path: `/w/${repo}/${agent}-t${ticket}`, branch: `agent/${agent}/t${ticket}`, resumed: false }; },
    async removeWorktree(target) { calls.push(['remove', target.agent]); return { removed: true }; },
    spawn({ unit, cwd, maxSeconds, spec }) { const child = fakeChild(); Object.assign(child, { unit, cwd, maxSeconds, spec }); children.push(child); active.add(unit); child.on('close', () => active.delete(unit)); return child; },
    async unitActive(unit) { return active.has(unit); },
    async stopUnit(unit) { calls.push(['stop', unit]); const child = children.find(item => item.unit === unit); if (child && active.has(unit)) child.exit(143); active.delete(unit); },
    async branchInfo() { return { head: 'abcdef1234567', commits: 2 }; }
  };
  const board = [];
  const reporter = {
    async begin(run) { board.push(['begin', run.id]); return { number: 90 + board.filter(item => item[0] === 'begin').length, title: 'Do it', description: 'desc', acceptanceCriteria: 'works' }; },
    async started(run) { board.push(['started', run.id]); },
    async heartbeat(run) { board.push(['heartbeat', run.id]); return reporter.stopNext ? { stop: true } : null; },
    async finish(run) { board.push(['finish', run.id, run.state, run.cleanup.unitGone && run.cleanup.worktreeRemoved]); }
  };
  return { ops, reporter, children, calls, board, active };
}

function runner(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-72-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fakes();
  const r = new AgentRunner({ file: join(dir, 'runs.json'), ops: f.ops, reporter: f.reporter, ...extra });
  t.after(() => r.close());
  return { r, ...f, file: join(dir, 'runs.json'), dir };
}

const launch = (r, over = {}) => r.launch({ agent: 'coder-1', ticketId: 'ticket-a', repo: 'personal-agent', model: 'sonnet', ...over });

test('a launch runs headless Claude in its worktree, reports the result and confirms cleanup (#72)', async t => {
  const { r, children, calls, board, active } = runner(t);
  const run = launch(r, { instructions: 'Keep it small.' });
  assert.equal(run.state, 'queued');
  await until(() => children.length === 1);
  const child = children[0];
  assert.equal(child.cwd, '/w/personal-agent/coder-1-t91');
  assert.equal(child.spec.binary, '/var/lib/cchan-agents/bin/claude');
  assert.deepEqual(child.spec.args.slice(child.spec.args.indexOf('--model'), child.spec.args.indexOf('--model') + 4), ['--model', 'claude-sonnet-5-5', '--max-turns', '80']);
  assert.ok(child.spec.args.includes('--strict-mcp-config'));
  assert.equal(child.maxSeconds, 3600);
  await until(() => child.prompt.includes('BLOCKED:'));
  assert.match(child.prompt, /Ticket #91: Do it/); assert.match(child.prompt, /Keep it small\./); assert.match(child.prompt, /agent\/coder-1\/t91/);
  assert.equal(r.get(run.id).state, 'running');
  child.say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
  child.say({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
  child.say({ type: 'result', is_error: false, result: 'All good.\nOUTCOME: Added the thing.\nEVIDENCE: npm test 12/12 pass\ncommit abc', session_id: 's' });
  child.exit(0);
  await until(() => r.get(run.id).state === 'succeeded');
  const done = r.get(run.id);
  assert.equal(done.turns, 2);
  assert.deepEqual(done.result, { kind: 'done', outcome: 'Added the thing.', evidence: 'npm test 12/12 pass\ncommit abc' });
  assert.deepEqual(done.cleanup, { unitGone: true, worktreeRemoved: true });
  assert.equal(done.head, 'abcdef1234567'); assert.equal(done.commits, 2);
  assert.equal(active.size, 0);
  assert.deepEqual(calls.filter(call => call[0] === 'remove'), [['remove', 'coder-1']]);
  assert.deepEqual(board.map(item => item[0]), ['begin', 'started', 'finish']);
  assert.deepEqual(board.at(-1).slice(2), ['succeeded', true]);
  assert.equal(done.instructions, undefined, 'instructions stay out of the public view');
  assert.deepEqual(r.events(0).map(event => event.type), ['run.queued', 'run.started', 'run.ended']);
  assert.equal(r.events(0).at(-1).cleanupConfirmed, true);
});

test('concurrency is capped: extra launches wait and start as soon as a slot frees (#72)', async t => {
  const { r, children } = runner(t, { limits: { maxConcurrent: 1 } });
  const a = launch(r, { agent: 'a', ticketId: 't1' }), b = launch(r, { agent: 'b', ticketId: 't2' });
  await until(() => children.length === 1); await tick(); await tick();
  assert.equal(children.length, 1); assert.equal(r.get(b.id).state, 'queued');
  children[0].say({ type: 'result', is_error: false, result: 'OUTCOME: ok' }); children[0].exit(0);
  await until(() => children.length === 2);
  assert.equal(r.get(a.id).state, 'succeeded'); assert.equal(r.get(b.id).state, 'running');
});

test('limits are validated and capped; one run per ticket and per agent; requestId is idempotent (#72)', async t => {
  const { r } = runner(t, { limits: { maxTurns: 10, maxSeconds: 600 } });
  assert.throws(() => launch(r, { maxTurns: 11 }), e => e.code === 'INVALID');
  assert.throws(() => launch(r, { maxSeconds: 601 }), e => e.code === 'INVALID');
  assert.throws(() => launch(r, { model: 'gpt' }), e => e.code === 'INVALID');
  assert.throws(() => launch(r, { provider: 'codex', model: 'gpt-5' }), e => e.code === 'PROVIDER_UNAVAILABLE');
  assert.throws(() => launch(r, { agent: '../x' }), e => e.code === 'INVALID');
  assert.throws(() => launch(r, { repo: 'a/b' }), e => e.code === 'INVALID');
  const first = launch(r, { requestId: 'k1', maxTurns: 5 });
  assert.equal(launch(r, { requestId: 'k1', maxTurns: 5 }).id, first.id);
  assert.throws(() => launch(r, { agent: 'other' }), e => e.code === 'BUSY');
  assert.throws(() => launch(r, { ticketId: 'other' }), e => e.code === 'BUSY');
  assert.deepEqual(normalizeLimits({ maxConcurrent: 99, maxTurns: 9999 }).maxConcurrent, 4);
  assert.equal(normalizeLimits({ maxTurns: 9999 }).maxTurns, 400);
});

test('stop kills the unit, a Board stop request stops the run, and both still clean up (#72)', async t => {
  const { r, children, reporter, calls } = runner(t, { limits: { heartbeatSeconds: 1 } });
  const a = launch(r);
  await until(() => children.length === 1 && r.get(a.id).state === 'running');
  r.stop(a.id);
  await until(() => r.get(a.id).state === 'stopped');
  assert.deepEqual(r.get(a.id).cleanup, { unitGone: true, worktreeRemoved: true });
  assert.ok(calls.some(call => call[0] === 'stop' && call[1] === a.unit));

  reporter.stopNext = true;
  const b = launch(r, { agent: 'coder-2', ticketId: 'ticket-b' });
  await until(() => r.get(b.id).state === 'stopped', 4000);
  assert.equal(r.get(b.id).error, 'stop_requested');
});

test('failures are classified: max turns, usage limit, no result, deadline (#72)', async t => {
  const { r, children } = runner(t);
  const cases = [
    [child => { child.say({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }); child.exit(1); }, 'MAX_TURNS'],
    [child => { child.say({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }); child.exit(1); }, 'USAGE_LIMIT'],
    [child => child.exit(1), 'PROVIDER_ERROR']
  ];
  let n = 0;
  for (const [act, code] of cases) {
    n++;
    const run = launch(r, { agent: `c${n}`, ticketId: `t${n}` });
    await until(() => children.length === n);
    act(children[n - 1]);
    await until(() => r.get(run.id).state === 'failed');
    assert.equal(r.get(run.id).errorCode, code);
    assert.deepEqual(r.get(run.id).cleanup, { unitGone: true, worktreeRemoved: true });
  }
});

test('a blocked report becomes a question; a run left mid-flight by a restart is stopped and cleaned up (#72)', async t => {
  const { r, children, file, ops, reporter, board } = runner(t);
  const a = launch(r);
  await until(() => children.length === 1);
  children[0].say({ type: 'result', is_error: false, result: 'Tried.\nBLOCKED: Which port should it use?' }); children[0].exit(0);
  await until(() => r.get(a.id).state === 'blocked');
  assert.deepEqual(r.get(a.id).result, { kind: 'blocked', question: 'Which port should it use?' });

  const b = launch(r, { agent: 'coder-2', ticketId: 'ticket-b' });
  await until(() => r.get(b.id).state === 'running');
  r.close();
  const stopped = [];
  const again = new AgentRunner({ file, ops: { ...ops, stopUnit: async unit => { stopped.push(unit); }, unitActive: async () => false }, reporter });
  t.after(() => again.close());
  await again.recover();
  assert.equal(again.get(b.id).state, 'interrupted');
  assert.deepEqual(stopped, [b.unit]);
  assert.deepEqual(again.get(b.id).cleanup, { unitGone: true, worktreeRemoved: true });
  assert.ok(board.some(item => item[0] === 'finish' && item[1] === b.id && item[2] === 'interrupted'));
});

test('a worktree that cannot be removed or a unit that will not stop is reported as unconfirmed cleanup (#72)', async t => {
  const { r, children, ops } = runner(t);
  ops.removeWorktree = async () => { throw new Error('busy'); };
  const run = launch(r);
  await until(() => children.length === 1);
  children[0].say({ type: 'result', is_error: false, result: 'OUTCOME: ok' }); children[0].exit(0);
  await until(() => r.get(run.id).state === 'succeeded');
  assert.deepEqual(r.get(run.id).cleanup, { unitGone: true, worktreeRemoved: false });
  assert.equal(r.events(0).at(-1).cleanupConfirmed, false);
});

test('report parsing and the prompt (#72)', () => {
  assert.deepEqual(parseReport('x\nOUTCOME: did a\nmore\nEVIDENCE: tests\n'), { kind: 'done', outcome: 'did a\nmore', evidence: 'tests' });
  assert.deepEqual(parseReport('BLOCKED: why?'), { kind: 'blocked', question: 'why?' });
  assert.equal(parseReport('no block').kind, 'unreported');
  const prompt = agentPrompt({ agent: 'a', repo: 'r', branch: 'agent/a/t1', base: 'main', instructions: '' }, { number: 1, title: 'T', description: '', acceptanceCriteria: '' });
  assert.match(prompt, /never look for or use credentials/);
});

test('provider interface: Claude is enabled with fixed model aliases, Codex is a reserved slot (#72)', () => {
  assert.deepEqual(Object.keys(claude.models), ['haiku', 'sonnet', 'opus', 'fable']);
  assert.equal(resolveModel('claude', 'opus').model, 'claude-opus-5-5');
  assert.equal(codex.available, false);
  assert.throws(() => resolveModel('codex', 'x'), e => e.code === 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(claude.parseLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } })),
    [{ type: 'turn' }, { type: 'tool', name: 'Edit' }]);
  assert.deepEqual(claude.parseLine('not json'), []);
});

function fakeBoard(handlers = {}) {
  const calls = [];
  return { calls, async call(name, args) { calls.push([name, args]); const handler = handlers[name]; if (handler instanceof Error) throw handler; return typeof handler === 'function' ? handler(args) : handler ?? {}; } };
}

test('Board reporter: claim, Runtime execution with cleanup proof, review with evidence (#72)', async () => {
  const client = fakeBoard({
    get_ticket: { ticket: { id: 'T', project_id: 'P', thread_id: 'TH', number: 7, title: 'Seven', description: 'd', acceptance_criteria: 'a', status: 'todo', version: 3 } },
    claim_ticket: { version: 4 }, reserve_execution: { execution: { id: 'E1', revision: 1 } }, start_execution: { execution: { revision: 2 } },
    heartbeat_execution: { execution: { revision: 3 }, should_stop: false }, update_ticket: { version: 6 }
  });
  const reporter = new BoardReporter({ client, projects: ['P'], ownerId: 'blackoutburst' });
  const run = { id: 'r1', agent: 'coder', ticketId: 'T', provider: 'claude', modelAlias: 'sonnet', model: 'claude-sonnet-5-5', maxTurns: 10, maxSeconds: 600, branch: 'agent/coder/t7', repo: 'personal-agent', turns: 0 };
  assert.deepEqual(await reporter.begin(run), { number: 7, title: 'Seven', description: 'd', acceptanceCriteria: 'a' });
  await reporter.started(run);
  assert.equal(run.board.execution, 'E1'); assert.equal(run.board.revision, 2);
  assert.equal(await reporter.heartbeat(run), null);
  Object.assign(run, { state: 'succeeded', turns: 4, startedAt: 0, endedAt: 120000, head: 'abc1234567', commits: 1,
    cleanup: { unitGone: true, worktreeRemoved: true }, result: { kind: 'done', outcome: 'Did it.', evidence: 'tests pass' } });
  await reporter.finish(run);
  const finish = client.calls.find(call => call[0] === 'finish_execution')[1];
  assert.deepEqual([finish.status, finish.cleanup_confirmed, finish.reason, finish.expected_revision], ['completed', true, 'completed', 3]);
  const update = client.calls.find(call => call[0] === 'update_ticket')[1];
  assert.equal(update.expected_version, 4); assert.equal(update.changes.status, 'review'); assert.equal(update.changes.outcome, 'Did it.');
  assert.match(update.changes.evidence, /tests pass/); assert.match(update.changes.evidence, /cleanup confirmed/);
  assert.match(update.changes.evidence, /git fetch \/var\/lib\/cchan-agents\/repos\/personal-agent\.git agent\/coder\/t7/);
  assert.ok(client.calls.filter(call => call[0] === 'post_message').length >= 2);
});

test('Board reporter: other projects are refused; no Runtime grant still works; failures release the ticket (#72)', async () => {
  const refused = new BoardReporter({ client: fakeBoard({ get_ticket: { ticket: { id: 'T', project_id: 'X', status: 'todo', version: 1 } } }), projects: ['P'], ownerId: 'o' });
  await assert.rejects(refused.begin({ id: 'r' }), e => e.code === 'FORBIDDEN');

  const client = fakeBoard({ get_ticket: { ticket: { id: 'T', project_id: 'P', thread_id: 'TH', number: 1, status: 'todo', version: 1 } },
    claim_ticket: { version: 2 }, reserve_execution: new Error('runtime not granted') });
  const reporter = new BoardReporter({ client, projects: ['P'], ownerId: 'o' });
  const run = { id: 'r2', agent: 'a', ticketId: 'T', provider: 'claude', modelAlias: 'haiku', model: 'm', maxTurns: 1, maxSeconds: 60, turns: 0 };
  await reporter.begin(run); await reporter.started(run);
  assert.equal(run.board.execution, null); assert.match(run.board.executionError, /runtime not granted/);
  Object.assign(run, { state: 'timeout', error: 'Deadline of 60s reached.', cleanup: { unitGone: true, worktreeRemoved: true } });
  await reporter.finish(run);
  assert.equal(client.calls.some(call => call[0] === 'finish_execution'), false);
  const update = client.calls.find(call => call[0] === 'update_ticket')[1];
  assert.deepEqual([update.changes.status, update.changes.release_claim], ['todo', true]);
  assert.match(runSummary(run), /cleanup confirmed/);

  const blocked = fakeBoard({ get_ticket: { ticket: { id: 'T', project_id: 'P', status: 'todo', version: 1 } }, claim_ticket: { version: 2 } });
  const asking = new BoardReporter({ client: blocked, projects: ['P'], ownerId: 'owner-1' });
  const run3 = { id: 'r3', agent: 'a', ticketId: 'T', turns: 0 };
  await asking.begin(run3);
  Object.assign(run3, { state: 'blocked', result: { kind: 'blocked', question: 'Port?' }, cleanup: { unitGone: true, worktreeRemoved: true } });
  await asking.finish(run3);
  const question = blocked.calls.find(call => call[0] === 'request_human_input')[1];
  assert.deepEqual([question.owner_id, question.question, question.expected_version], ['owner-1', 'Port?', 2]);
});

test('Board watch reports tickets becoming ready, entering review or done, after a silent first pass (#72)', async () => {
  let items = [{ id: 'a', number: 1, title: 'A', status: 'todo', ready: false }, { id: 'b', number: 2, title: 'B', status: 'in_progress', ready: false }];
  const watch = new BoardWatch({ client: { async call() { return { items }; } }, projects: ['P'] });
  assert.deepEqual(await watch.poll(), []);
  items = [{ id: 'a', number: 1, title: 'A', status: 'todo', ready: true }, { id: 'b', number: 2, title: 'B', status: 'review', ready: false }];
  assert.deepEqual((await watch.poll()).map(event => [event.type, event.ticketNumber]), [['board.ready', 1], ['board.review', 2]]);
  assert.deepEqual(await watch.poll(), []);
});
