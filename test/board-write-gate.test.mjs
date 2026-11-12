// #94 rework: on C-chan's unattended wakes a Board write passes only when every project it targets (resolved on the
// Board from the ticket, thread, request or message, never trusted from the call) has an active standing approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateBoardWrite, askApproval, toolValue } from '../src/board-write-gate.mjs';
import { bindBoardSession, GATE_TOKEN_ENV, GATE_URL_ENV } from '../src/board-session-bridge.mjs';
import { Manager } from '../src/agent-manager.mjs';
import { createRunnerApi } from '../src/agent-runner-api.mjs';
import { schedulerOperation } from '../src/scheduler-http.mjs';
import { CompanionRunner } from '../src/runner.mjs';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = join(ROOT, 'src', 'board-session-bridge.mjs');
const APPROVED = 'proj-approved', OTHER = 'proj-other';
const tmp = t => { const dir = mkdtempSync(join(tmpdir(), 'board-gate-94-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

// A synthetic Board: what the read tools answer.
const BOARD = {
  tickets: { TA: { id: 'TA', project_id: APPROVED, thread_id: 'THA' }, TB: { id: 'TB', project_id: OTHER, thread_id: 'THB' } },
  threads: { THA: { id: 'THA', ticket: { id: 'TA' } }, THB: { id: 'THB', ticket_id: 'TB' }, GEN: { id: 'GEN', project_id: APPROVED }, LOOSE: { id: 'LOOSE' } },
  requests: [{ id: 'RQA', ticket_id: 'TA', status: 'open' }, { id: 'RQB', ticket_id: 'TB', status: 'open' }],
  messages: { MA: { id: 'MA', thread_id: 'THA' }, MB: { id: 'MB', thread_id: 'THB' } }
};
async function read(tool, args) {
  if (tool === 'get_ticket') { const ticket = BOARD.tickets[args.ticket_id]; if (!ticket) throw new Error('not found'); return { ticket }; }
  if (tool === 'get_thread') { const thread = BOARD.threads[args.thread_id]; if (!thread) throw new Error('not found'); return { thread, messages: [] }; }
  if (tool === 'list_human_requests') return { items: BOARD.requests };
  if (tool === 'get_message') { const message = BOARD.messages[args.message_id]; if (!message) throw new Error('not found'); return { message }; }
  throw new Error('unexpected read ' + tool);
}

// The app side: the real runner API and Manager behind agentsOperation (op boardGate), as the scheduler endpoint runs it.
function app({ allowed = id => id === 'cchan' } = {}) {
  const manager = new Manager({ projects: [APPROVED, OTHER] });
  manager.approve({ projectId: APPROVED, direction: 'Build the manager wakes.' });
  const runner = { on() {}, list: () => [], events: () => [], limits: {}, get: () => null };
  const api = createRunnerApi({ runner, roster: { summary: () => ({}) }, manager, projects: [APPROVED, OTHER], tickets: () => [] });
  const agents = { client: { call: (method, path, body) => api(method, path, body ?? {}) }, allowed };
  const ask = (companionId, projectId) => schedulerOperation(null, companionId, { action: 'agents', input: { op: 'boardGate', projectId } }, { agents, unattended: true });
  const approved = companionId => async projectId => { const answer = await ask(companionId, projectId); return answer.status === 200 && answer.body.approved === true; };
  return { manager, agents, ask, approved };
}

test('Board writes on an own wake: approved project passes, resolved on the Board from ticket, thread, request or project (#94)', async () => {
  const { approved } = app();
  for (const [tool, args] of [['create_ticket', { project_id: APPROVED, title: 'x' }], ['update_ticket', { ticket_id: 'TA', status: 'done' }],
    ['post_message', { thread_id: 'THA', body: 'hi' }], ['post_message', { thread_id: 'GEN', body: 'hi', reply_to: 'MA' }],
    ['release_managed_agent_claim', { ticket_id: 'TA' }], ['resolve_human_request', { request_id: 'RQA', answer: 'yes' }],
    ['update_ticket', { ticket_id: 'TA', depends_on_ticket_ids: ['TA'] }]]) {
    const verdict = await gateBoardWrite({ tool, args, read, approved: approved('cchan') });
    assert.equal(verdict.ok, true, `${tool} ${JSON.stringify(args)}: ${verdict.reason}`);
    assert.deepEqual(verdict.projects, [APPROVED]);
  }
  // Reads never need a target or an approval.
  assert.equal((await gateBoardWrite({ tool: 'get_ticket', args: { ticket_id: 'TB' }, read, approved: async () => false })).ok, true);
});

test('Board writes on an own wake: unapproved project, foreign owner and unknown targets are refused (#94)', async () => {
  const { approved } = app();
  const cases = [
    ['update_ticket', { ticket_id: 'TB', status: 'done' }, /Project proj-other has no active standing approval/],
    ['post_message', { thread_id: 'THB', body: 'hi' }, /proj-other/],
    ['resolve_human_request', { request_id: 'RQB', answer: 'yes' }, /proj-other/],
    ['create_ticket', { project_id: OTHER, title: 'x' }, /proj-other/],
    ['release_managed_agent_claim', { ticket_id: 'TB' }, /proj-other/],
    // The call cannot borrow the approved project's id for another project's ticket, thread or reply.
    ['update_ticket', { ticket_id: 'TB', project_id: APPROVED }, /proj-other/],
    ['update_ticket', { ticket_id: 'TA', project_id: OTHER }, /proj-other/],
    ['post_message', { thread_id: 'THA', reply_to: 'MB', body: 'hi' }, /proj-other/],
    ['update_ticket', { ticket_id: 'TA', depends_on_ticket_ids: ['TB'] }, /proj-other/],
    // Unknown targets.
    ['update_ticket', { ticket_id: 'T-missing' }, /could not be found/],
    ['post_message', { thread_id: 'TH-missing', body: 'hi' }, /could not be found/],
    ['post_message', { thread_id: 'LOOSE', body: 'hi' }, /belongs to no project ticket/],
    ['resolve_human_request', { request_id: 'RQ-missing' }, /could not be found/],
    ['update_companion_profile', { name: 'C-chan' }, /names no ticket, thread, request or project/],
    ['update_ticket', {}, /update_ticket needs ticket_id/],
    ['post_message', { body: 'hi', project_id: APPROVED }, /post_message needs thread_id/],
    ['update_ticket', { ticket_id: '../TA' }, /not a valid id/],
    ['update_ticket', { ticket_id: 42 }, /not a valid id/]
  ];
  for (const [tool, args, reason] of cases) {
    const verdict = await gateBoardWrite({ tool, args, read, approved: approved('cchan') });
    assert.equal(verdict.ok, false, `${tool} ${JSON.stringify(args)}`);
    assert.match(verdict.reason, /^Refused on your own wake: /);
    assert.match(verdict.reason, reason, `${tool} ${JSON.stringify(args)}`);
  }
  // Another owner's companion (not allowed to manage agents) gets no approval, even for the approved project.
  const foreign = await gateBoardWrite({ tool: 'update_ticket', args: { ticket_id: 'TA' }, read, approved: approved('someone-else') });
  assert.equal(foreign.ok, false); assert.match(foreign.reason, /proj-approved has no active standing approval/);
  // A Board read that fails, or an approval check that throws, refuses.
  assert.equal((await gateBoardWrite({ tool: 'update_ticket', args: { ticket_id: 'TA' }, read: async () => { throw new Error('down'); }, approved: approved('cchan') })).ok, false);
  assert.equal((await gateBoardWrite({ tool: 'update_ticket', args: { ticket_id: 'TA' }, read, approved: async () => { throw new Error('down'); } })).ok, false);
});

test('Board writes on an own wake: the exact schemas pass with every field, nested ids in the same approved project pass (#94)', async () => {
  const { approved } = app();
  const ok = [
    ['release_managed_agent_claim', { ticket_id: 'TA', expected_version: 3, idempotency_key: 'k-1', reason: 'stale claim',
      recovery_evidence: { run: 'r-1', notes: ['agent exited'], ticket_id: 'TA' } }],
    ['update_ticket', { ticket_id: 'TA', expected_version: 4, changes: { status: 'review', title: 'x', project_id: APPROVED, depends_on: ['TA'] } }],
    ['update_ticket', { ticket_id: 'TA', expected_version: 4, changes: { links: [{ ticket_id: 'TA' }], dependsOn: 'TA', related: { tickets: ['TA'] } } }],
    ['post_message', { thread_id: 'THA', body: 'done', idempotency_key: 'k-2', reply_to: 'MA' }],
    ['create_ticket', { project_id: APPROVED, title: 'x', idempotency_key: 'k-3', depends_on: ['TA'] }],
    ['create_ticket', { project_id: APPROVED, title: 'x', idempotency_key: 'k-3', depends_on: [] }],
    ['resolve_human_request', { request_id: 'RQA', answer: 'yes' }]
  ];
  for (const [tool, args] of ok) {
    const verdict = await gateBoardWrite({ tool, args, read, approved: approved('cchan') });
    assert.equal(verdict.ok, true, `${tool} ${JSON.stringify(args)}: ${verdict.reason}`);
    assert.deepEqual(verdict.projects, [APPROVED]);
  }
});

test('Board writes on an own wake: ids nested anywhere in the arguments cannot reach another project (#94 nested-bypass probes)', async () => {
  const { approved, manager } = app();
  // Even a second approved project may not be mixed into one call.
  manager.approve({ projectId: OTHER, direction: 'Also approved.' });
  const both = approved('cchan');
  const probes = [
    // update_ticket.changes: moving the ticket, depending on / linking to another project's ticket, in any spelling.
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { project_id: OTHER } }, /changes\.project_id \(proj-other\) is not in the same project/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { projectId: OTHER } }, /changes\.projectId/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { depends_on: ['TA', 'TB'] } }, /changes\.depends_on\[1\] \(TB\)/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { dependsOn: 'TB' } }, /changes\.dependsOn/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { blocked_by: ['TB'] } }, /changes\.blocked_by\[0\]/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { parent_ticket_id: 'TB' } }, /changes\.parent_ticket_id/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { links: [{ ticket_id: 'TB' }] } }, /changes\.links\[0\]\.ticket_id/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { meta: { deep: [{ thread_id: 'THB' }] } } }, /changes\.meta\.deep\[0\]\.thread_id/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { reply_to: 'MB' } }, /changes\.reply_to/],
    // Unknown id keys are looked up as tickets: another project's ticket or anything not on the Board is refused.
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { epic_id: 'TB' } }, /changes\.epic_id/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { assignee_id: 'profile-7' } }, /Ticket profile-7 could not be found/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { attachment_ids: ['att-1'] } }, /Ticket att-1 could not be found/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { owner: 'someone' } }, /Ticket someone could not be found/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { depends_on: [{ id: 'TB' }] } }, /changes\.depends_on\[0\]\.id \(TB\)/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { links: [{ ticket_id: 'TA', ref: 'TB' }] } }, /changes\.links\[0\]\.ref \(TB\)/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { links: [{ ticket_id: 'TA', kind: 'relates to' }] } }, /changes\.links\[0\]\.kind is not a valid id/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { depends_on: [true] } }, /changes\.depends_on\[0\] is not a valid id/],
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { project_id: 7 } }, /not a valid id/],
    // Fields outside the schema and free-form trees are walked too.
    ['update_ticket', { ticket_id: 'TA', expected_version: 1, project_id: OTHER, changes: {} }, /project_id \(proj-other\) is not in the same project/],
    ['release_managed_agent_claim', { ticket_id: 'TA', expected_version: 1, idempotency_key: 'k', reason: 'r', recovery_evidence: { ticket_id: 'TB' } }, /recovery_evidence\.ticket_id/],
    ['release_managed_agent_claim', { ticket_id: 'TA', expected_version: 1, idempotency_key: 'k', reason: 'r', recovery_evidence: [{ runs: [{ thread: 'THB' }] }] }, /recovery_evidence\[0\]\.runs\[0\]\.thread/],
    ['release_managed_agent_claim', { ticket_id: 'TA', expected_version: 1, idempotency_key: 'k', reason: { ticket_id: 'TB' } }, /reason must be a plain value/],
    ['post_message', { thread_id: 'THA', body: 'x', idempotency_key: 'k', reply_to: 'MB' }, /reply_to \(MB\)/],
    ['post_message', { thread_id: 'THA', body: { ticket_id: 'TB' }, idempotency_key: 'k' }, /body must be a plain value/],
    ['post_message', { thread_id: 'THA', body: 'x', idempotency_key: 'k', mentions: [{ ticket_id: 'TB' }] }, /mentions\[0\]\.ticket_id/],
    ['create_ticket', { project_id: APPROVED, title: 'x', idempotency_key: 'k', depends_on: ['TB'] }, /depends_on(\[0\])? \(TB\)/],
    ['create_ticket', { project_id: APPROVED, title: 'x', idempotency_key: 'k', depends_on: 'TB' }, /depends_on(\[0\])? \(TB\)/],
    ['create_ticket', { project_id: APPROVED, title: 'x', idempotency_key: 'k', parent: 'TB' }, /parent \(TB\)/],
    ['create_ticket', { project_id: APPROVED, title: 'x', idempotency_key: 'k', idempotency: { request_id: 'RQB' } }, /idempotency\.request_id/],
    ['resolve_human_request', { request_id: 'RQA', answer: 'yes', ticket_id: 'TB' }, /ticket_id \(TB\)/],
    ['resolve_human_request', { request_id: 'RQA', answer: { thread_id: 'THB' } }, /answer must be a plain value/],
    // Another write tool (no exact schema) gets the same walk.
    ['release_ticket', { ticket_id: 'TA', note: { ticketIds: ['TB'] } }, /note\.ticketIds\[0\]/]
  ];
  for (const [tool, args, reason] of probes) {
    const verdict = await gateBoardWrite({ tool, args, read, approved: both });
    assert.equal(verdict.ok, false, `${tool} ${JSON.stringify(args)} passed`);
    assert.match(verdict.reason, /^Refused on your own wake: /);
    assert.match(verdict.reason, reason, `${tool} ${JSON.stringify(args)}: ${verdict.reason}`);
  }
  // Too deep or too large to check is refused, not skipped.
  let deep = { ticket_id: 'TB' }; for (let i = 0; i < 20; i += 1) deep = { more: deep };
  assert.match((await gateBoardWrite({ tool: 'update_ticket', args: { ticket_id: 'TA', changes: deep }, read, approved: both })).reason, /too large or too deep/);
  const many = { ticket_id: 'TA', changes: { depends_on: Array.from({ length: 60 }, () => 'TA') } };
  assert.match((await gateBoardWrite({ tool: 'update_ticket', args: many, read, approved: both })).reason, /too many targets/);
  // session_id is the bridge's own field (always replaced), not a target.
  assert.equal((await gateBoardWrite({ tool: 'update_ticket', args: { ticket_id: 'TA', session_id: 'x', changes: {} }, read, approved: both })).ok, true);
});

test('the boardGate op answers from the runner\'s active approvals only (#94)', async () => {
  const { ask, manager } = app();
  assert.deepEqual((await ask('cchan', APPROVED)).body, { projectId: APPROVED, approved: true });
  assert.deepEqual((await ask('cchan', OTHER)).body, { projectId: OTHER, approved: false });
  manager.revoke({ projectId: APPROVED });
  assert.equal((await ask('cchan', APPROVED)).body.approved, false);
  assert.equal((await ask('someone-else', APPROVED)).status, 403);
  assert.equal((await ask('cchan', '../x')).status, 400);
});

test('askApproval needs the exact project back and a well-formed token', async () => {
  const token = 'a'.repeat(64);
  const reply = body => async () => ({ status: 200, json: async () => body });
  assert.equal(await askApproval({ url: 'http://x/', token, projectId: APPROVED, fetchImpl: reply({ projectId: APPROVED, approved: true }) }), true);
  assert.equal(await askApproval({ url: 'http://x/', token, projectId: APPROVED, fetchImpl: reply({ projectId: OTHER, approved: true }) }), false);
  assert.equal(await askApproval({ url: 'http://x/', token: 'short', projectId: APPROVED, fetchImpl: reply({ projectId: APPROVED, approved: true }) }), false);
  assert.equal(await askApproval({ url: null, token, projectId: APPROVED, fetchImpl: reply({ projectId: APPROVED, approved: true }) }), false);
  assert.equal(toolValue({ content: [{ type: 'text', text: '{"ticket":{"id":"TA"}}' }] }).ticket.id, 'TA');
  assert.equal(toolValue({ isError: true, content: [] }), null);
});

// End to end through the real bridge process: a fake connect.py and the app's scheduler endpoint (real token check).
function fakeBoard(dir) {
  const file = join(dir, 'fake-board.mjs');
  writeFileSync(file, `import readline from 'node:readline';
const board = ${JSON.stringify(BOARD)};
const reply = (id, value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), name = request.params?.name, args = request.params?.arguments ?? {};
  if (request.method !== 'tools/call') return reply(request.id, {});
  if (name === 'get_ticket') return board.tickets[args.ticket_id] ? reply(request.id, { ticket: board.tickets[args.ticket_id] })
    : process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'no ticket' }] } }) + '\\n');
  if (name === 'get_thread') return reply(request.id, { thread: board.threads[args.thread_id] ?? null });
  if (name === 'get_text') return reply(request.id, { token: process.env.${GATE_TOKEN_ENV} ?? null, url: process.env.${GATE_URL_ENV} ?? null });
  reply(request.id, { wrote: name, args });
});`);
  return file;
}

async function schedulerEndpoint(t, agents) {
  const tokens = new Map([[randomBytes(32).toString('hex'), 'cchan']]);
  const [token] = tokens.keys();
  const server = createServer(async (req, res) => {
    const companionId = tokens.get(String(req.headers.authorization ?? '').slice(7));
    if (!companionId) { res.writeHead(401).end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const result = await schedulerOperation(null, companionId, JSON.parse(body), { agents, unattended: true });
    res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/internal/scheduler`, token };
}

function bridge(t, dir, env, gated = true) {
  const session = 'companion-model-' + 'b'.repeat(40);
  const child = spawn(process.execPath, [BRIDGE, '--session-id', session, ...(gated ? ['--gate'] : []), '--', process.execPath, fakeBoard(dir)],
    { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  t.after(() => child.kill('SIGKILL'));
  let buffer = ''; const answers = new Map(), waiting = new Map();
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      answers.set(message.id, message); waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const call = (name, args) => new Promise(resolve => {
    const id = next++; waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  return { call, child, answers };
}
const text = message => JSON.parse(message.result.content[0].text);

test('the gated bridge forwards approved writes and refuses others before they reach the Board (#94)', async t => {
  const dir = tmp(t), { agents } = app(), gate = await schedulerEndpoint(t, agents);
  const b = bridge(t, dir, { [GATE_URL_ENV]: gate.url, [GATE_TOKEN_ENV]: gate.token });
  const ok = await b.call('update_ticket', { ticket_id: 'TA', status: 'done' });
  assert.equal(ok.result.isError, undefined, JSON.stringify(ok));
  assert.equal(text(ok).wrote, 'update_ticket');
  const refused = await b.call('update_ticket', { ticket_id: 'TB', status: 'done' });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /Refused on your own wake: Project proj-other has no active standing approval/);
  const unknown = await b.call('post_message', { thread_id: 'TH-missing', body: 'x' });
  assert.equal(unknown.result.isError, true); assert.match(unknown.result.content[0].text, /could not be found/);
  const nested = await b.call('update_ticket', { ticket_id: 'TA', expected_version: 1, changes: { project_id: OTHER } });
  assert.equal(nested.result.isError, true); assert.match(nested.result.content[0].text, /changes\.project_id \(proj-other\) is not in the same project/);
  const created = await b.call('create_ticket', { project_id: APPROVED, title: 'x' });
  assert.equal(text(created).wrote, 'create_ticket');
  // Reads pass straight through; the Board process never sees the gate's token; the bridge's own reads stay internal.
  assert.deepEqual(text(await b.call('get_ticket', { ticket_id: 'TB' })).ticket.project_id, OTHER);
  assert.deepEqual(text(await b.call('get_text', {})), { token: null, url: null });
  assert.equal([...b.answers.keys()].some(id => typeof id === 'string'), false);
});

test('a gated bridge without the app\'s token refuses every Board write; an owner-chat bridge is not gated (#94)', async t => {
  const dir = tmp(t);
  const blind = bridge(t, dir, {});
  const refused = await blind.call('update_ticket', { ticket_id: 'TA' });
  assert.equal(refused.result.isError, true); assert.match(refused.result.content[0].text, /proj-approved has no active standing approval/);
  const open = bridge(t, dir, {}, false);
  assert.equal(text(await open.call('update_ticket', { ticket_id: 'TB' })).wrote, 'update_ticket');
});

test('bindBoardSession gates only when asked, and the runner asks for unattended turns with their scheduler token (#94)', async t => {
  const policy = { tools: [], board: { allowedTools: ['get_work'] }, mcpServers: [
    { name: 'board', command: '/usr/bin/python3', args: ['/private/connect.py', '--stdio'], env: {}, allowedTools: ['get_work'] }] };
  assert.equal(bindBoardSession(policy, 'alice', 'c').mcpServers[0].args.includes('--gate'), false);
  const gated = bindBoardSession(policy, 'alice', 'c', { gate: { url: 'http://127.0.0.1:1/internal/scheduler', token: 'f'.repeat(64) } }).mcpServers[0];
  assert.deepEqual(gated.args.slice(3, 5), ['--gate', '--']);
  assert.equal(gated.env[GATE_TOKEN_ENV], 'f'.repeat(64));
  const blind = bindBoardSession(policy, 'alice', 'c', { gate: { url: null, token: null } }).mcpServers[0];
  assert.equal(blind.args[3], '--gate'); assert.deepEqual(blind.env, {});

  const dir = tmp(t), store = new BootstrapStore(join(dir, 'data'), ROOT); t.after(() => store.close());
  const owners = [{ issuer: 'https://synthetic.invalid', subject: 'gate-94', label: 'blackout', provider: 'claude', tools: [],
    board: { configDir: '/cfg', pythonPath: '/usr/bin/python3', connectPath: '/connect.py', allowedTools: ['get_ticket', 'update_ticket'] } }];
  const configs = [];
  const runner = new CompanionRunner({ store, owners, runtimeDir: join(dir, 'rt'), binaries: { claude: join(dir, 'missing'), codex: join(dir, 'missing') },
    mcpServersFor: (owner, { unattended = false } = {}) => [{ name: 'scheduler', command: process.execPath, args: ['/s.mjs'],
      env: { COMPANION_SCHEDULER_URL: 'http://127.0.0.1:9/internal/scheduler', COMPANION_SCHEDULER_TOKEN: (unattended ? 'u' : 'o').repeat(64) }, allowedTools: ['list_schedules'] }],
    spawnImpl(command, args) { configs.push(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.board); throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  const id = store.getOrInsert('companion-identity-v1', principalKey({ issuer: owners[0].issuer, subject: owners[0].subject }), { companionId: randomUUID() }).companionId;
  await runner.turn(id, { prompt: 'chat' }).catch(() => {});
  await runner.turn(id, { prompt: 'wake', unattended: true }).catch(() => {});
  assert.equal(configs.length, 2);
  assert.equal(configs[0].args.includes('--gate'), false);
  assert.equal(configs[1].args[3], '--gate');
  assert.equal(configs[1].env[GATE_TOKEN_ENV], 'u'.repeat(64));
});
