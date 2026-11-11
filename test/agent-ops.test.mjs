import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOps, decisionLog, usageSummary, pipelineOf, normalizeStatus, OpsBoard } from '../src/agent-ops.mjs';
import { createStudioHttp, StudioError } from '../src/studio.mjs';

const NOW = 1_000_000_000_000;
const run = (over = {}) => ({ id: 'coder-1', agent: 'coder-ops', ticketId: 't1', ticketNumber: 75, ticketTitle: 'Ops', provider: 'claude', modelAlias: 'sonnet',
  state: 'running', turns: 4, maxTurns: 80, startedAt: NOW - 120_000, endedAt: null, heartbeatAt: NOW - 30_000, createdAt: NOW - 130_000, cleanup: null, instructions: 'SECRET', ...over });

test('agents show role, model, ticket and heartbeat age; instructions never appear', () => {
  const ops = buildOps({ runs: [run()], events: [], tickets: [], now: NOW });
  assert.deepEqual([ops.agents[0].name, ops.agents[0].role, ops.agents[0].model, ops.agents[0].ticketNumber, ops.agents[0].heartbeatAgeSeconds, ops.agents[0].live],
    ['coder-ops', 'coder', 'sonnet', 75, 30, true]);
  assert.equal(JSON.stringify(ops).includes('SECRET'), false);
});

test('decision log reads launches, escalations, returns and results from the events, newest first', () => {
  const runs = [run({ id: 'a-1', modelAlias: 'sonnet', state: 'failed' }), run({ id: 'a-2', modelAlias: 'opus', state: 'succeeded' }), run({ id: 'a-3', modelAlias: 'opus', state: 'queued' })];
  const ev = (seq, type, runId, extra = {}) => ({ seq, at: NOW + seq, type, runId, agent: 'coder-ops', ticketId: 't1', ticketNumber: 75, ...extra });
  const log = decisionLog(runs, [ev(1, 'run.queued', 'a-1'), ev(2, 'run.ended', 'a-1', { state: 'failed' }), ev(3, 'run.queued', 'a-2'),
    ev(4, 'run.queued', 'a-3'), { seq: 5, at: NOW, type: 'board.done', ticketNumber: 75 }]);
  assert.deepEqual(log.map(item => item.kind), ['accept', 'return', 'escalate', 'result', 'launch']);
  assert.match(log[2].text, /escalated #75 to opus/);
});

test('usage sums turns and run time per model inside each window and counts plan-limit stops', () => {
  const runs = [run({ state: 'succeeded', endedAt: NOW - 60_000, turns: 10 }), run({ id: 'old', modelAlias: 'opus', state: 'failed', errorCode: 'USAGE_LIMIT',
    startedAt: NOW - 3 * 86_400_000, endedAt: NOW - 3 * 86_400_000 + 60_000, turns: 2 })];
  const usage = usageSummary(runs, NOW);
  assert.deepEqual(usage.windows.last24h.total, { runs: 1, turns: 10, seconds: 60 });
  assert.equal(usage.windows.last7d.total.runs, 2); assert.equal(usage.windows.last7d.models.opus.turns, 2); assert.equal(usage.limitHits, 1);
});

test('pipeline groups tickets by status and unknown statuses fall back to todo', () => {
  assert.equal(normalizeStatus('In Progress'), 'in_progress');
  const p = pipelineOf([{ id: 'a', number: 1, title: 'x', status: 'review' }, { id: 'b', number: 2, title: 'y', status: 'weird' }, { id: 'c', number: 3, title: 'z', status: 'done' }]);
  assert.deepEqual([p.todo.length, p.review.length, p.done.length, p.blocked.length], [1, 1, 1, 0]);
  assert.equal(buildOps({ runs: [], events: [], tickets: null, now: NOW }).pipeline, null);
});

test('OpsBoard caches the ticket list and only reads threads of tickets in the allowed projects', async () => {
  const calls = [];
  const client = { call: async (tool, args) => { calls.push(tool);
    if (tool === 'list_tickets') return { items: [{ id: 't1', number: 75, title: 'Ops', status: 'todo' }] };
    if (tool === 'get_ticket') return { ticket: { thread_id: 'th1' } };
    // The real get_thread shape (Board MCP): messages next to the thread, author objects, created_at in seconds.
    return { thread: { id: 'th' }, messages: [{ id: 'm1', created_at: 1794396819.5, author: { agent_name: 'C-chan', display_name: 'Blackoutburst', kind: 'agent' }, body: 'hello\u0000' },
      { id: 'm2', created_at: 1794396900, author: { display_name: 'Blackoutburst', kind: 'human' }, body: 'ok' }] }; } };
  const board = new OpsBoard({ client, projects: ['p'], now: () => 1 });
  await board.tickets(); await board.tickets();
  assert.equal(calls.filter(tool => tool === 'list_tickets').length, 1);
  assert.equal(await board.messages('other'), null);
  const history = await board.messages('t1');
  assert.deepEqual([history.ticketNumber, history.messages[0].author, history.messages[0].text, history.messages[0].at], [75, 'C-chan', 'hello ', 1794396819500]);
  assert.deepEqual([history.messages[1].author, history.messages[1].at], ['Blackoutburst', 1794396900000]);
});

test('the Studio HTTP ops action is for members only, read-only and validates the ticket id', async () => {
  const seen = [];
  const runner = { call: async (method, path) => { seen.push([method, path]); return { status: 200, body: { agents: [] } }; } };
  const access = { read: async request => ({ value: request.body }), authorize: async () => ({ companionId: 'me' }) };
  const make = { studio: { scope: () => { throw new StudioError('STUDIO_FORBIDDEN', 403); } }, calendar: { member: id => id === 'me' } };
  const http = createStudioHttp({ access, ops: () => runner, ...make });
  assert.deepEqual((await http({ body: { action: 'access' } })).body.apps, { mail: false, calendar: true, ops: true });
  assert.equal((await http({ body: { action: 'ops' } })).status, 200);
  assert.equal((await http({ body: { action: 'opsMessages', ticketId: 'abc-1' } })).status, 200);
  assert.equal((await http({ body: { action: 'opsMessages', ticketId: '../x' } })).status, 400);
  assert.deepEqual(seen, [['GET', '/ops'], ['GET', '/tickets/abc-1/messages']]);
  const stranger = createStudioHttp({ access, ops: () => runner, studio: make.studio, calendar: { member: () => false } });
  assert.equal((await stranger({ body: { action: 'ops' } })).status, 403);
  const none = createStudioHttp({ access, ops: () => null, ...make });
  assert.equal((await none({ body: { action: 'ops' } })).status, 403);
  assert.equal((await none({ body: { action: 'access' } })).body.apps.ops, false);
  const down = createStudioHttp({ access, ops: () => ({ call: async () => { throw new Error('x'); } }), ...make });
  assert.equal((await down({ body: { action: 'ops' } })).status, 503);
});
