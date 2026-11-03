import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runSchedulerMcp } from '../src/scheduler-mcp.mjs';

const TOKEN = 'a'.repeat(64), URL = 'http://127.0.0.1:49123/internal/scheduler';
const PRIVATE = 'PRIVATE-HTTP-DETAIL-CANARY';
const SCRIPT = fileURLToPath(new globalThis.URL('../src/scheduler-mcp.mjs', import.meta.url));
const FIXED_TOOL_ERROR = 'The reminder service could not complete this request. Retry with the same request key.';
const createInput = () => ({ requestId: 'stable-reminder-1', text: 'Review the release 🎯', dueAt: '2026-11-03T09:30:00+01:00' });
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const notification = (method, params) => ({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
const initialize = (version = '2025-11-25', id = 'initialize') => request(id, 'initialize', {
  protocolVersion: version, capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1.0.0' }
});
const handshake = () => [initialize(), notification('notifications/initialized')];
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
const frame = value => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value) + '\n');

async function exchange(chunks, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), writes = [], forwards = [];
  output.setEncoding('utf8'); output.on('data', value => writes.push(value));
  const fetchImpl = options.fetchImpl ?? (async (url, spec) => {
    forwards.push({ url, spec }); return new Response(JSON.stringify({ ok: true, timezone: 'Europe/Paris' }));
  });
  const running = runSchedulerMcp({ input, output, endpoint: URL, token: TOKEN, fetchImpl, ...options });
  for (const chunk of chunks) { input.write(frame(chunk)); await nextTurn(); }
  input.end();
  await running;
  const raw = writes.join('');
  const messages = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { messages, raw, forwards };
}

function resultFor(result, id) {
  const response = result.messages.find(message => message.id === id);
  assert.ok(response, `Missing response for ${id}`); assert.equal(response.jsonrpc, '2.0');
  return response;
}

test('initialize negotiates supported protocol versions and falls back explicitly for a future client', async () => {
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2099-01-01']) {
    const result = await exchange([initialize(version), notification('notifications/initialized'), request('ping', 'ping')]);
    assert.equal(result.messages.length, 2, 'The initialized notification has no response');
    const initialized = resultFor(result, 'initialize').result;
    assert.equal(initialized.protocolVersion, version === '2099-01-01' ? '2025-11-25' : version);
    assert.deepEqual(initialized.capabilities, { tools: {} });
    assert.deepEqual(initialized.serverInfo, { name: 'companion-scheduler', version: '1.0.0' });
    assert.deepEqual(resultFor(result, 'ping').result, {});
    assert.equal(result.forwards.length, 0);
  }
});

test('tool traffic requires initialization and the initialized notification; ping stays side-effect free', async () => {
  const result = await exchange([
    request('early-ping', 'ping'), request('early-tools', 'tools/list'),
    notification('notifications/initialized'), initialize(), request('before-ready', 'tools/list'),
    notification('notifications/initialized', { ownerId: PRIVATE }), request('invalid-ready', 'tools/list'),
    notification('notifications/initialized', {}), initialize('2025-11-25', 'duplicate'),
    notification('notifications/cancelled', { requestId: 'unknown', reason: PRIVATE }), request('tools', 'tools/list')
  ]);
  assert.deepEqual(resultFor(result, 'early-ping').result, {});
  for (const id of ['early-tools', 'before-ready', 'invalid-ready']) assert.equal(resultFor(result, id).error.code, -32002);
  assert.equal(resultFor(result, 'duplicate').error.code, -32602);
  assert.ok(resultFor(result, 'tools').result.tools);
  assert.equal(result.messages.length, 7);
  assert.equal(result.forwards.length, 0); assert.ok(!result.raw.includes(PRIVATE));
});

test('the tool catalogue keeps reminders and distinct release-watch tools in closed finite schemas', async () => {
  const result = await exchange([...handshake(), request('tools', 'tools/list', {})]);
  const tools = resultFor(result, 'tools').result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['cancel_schedule', 'create_event', 'create_release_watch', 'create_schedule', 'create_topic_watch',
    'delete_event', 'github_create_repo', 'github_list_repos', 'github_pull', 'github_pulls', 'github_repo', 'list_calendar', 'list_schedules', 'update_event', 'update_release_watch']);
  const expected = { create_schedule: ['requestId', 'text', 'dueAt'], list_schedules: [], cancel_schedule: ['id'],
    create_release_watch: ['requestId', 'condition'], create_topic_watch: ['requestId', 'topic', 'intervalHours'],
    update_release_watch: ['requestId', 'id', 'expectedVersion', 'operation', 'condition', 'intervalHours'] };
  // Calendar (#44) and GitHub (#45) tools are checked in their own tests.
  for (const tool of tools.filter(tool => expected[tool.name])) {
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [...expected[tool.name]].sort());
    assert.deepEqual([...tool.inputSchema.required].sort(), [...expected[tool.name]].filter(key => tool.name !== 'update_release_watch' || !['condition', 'intervalHours'].includes(key)).sort());
    for (const [name, property] of Object.entries(tool.inputSchema.properties)) assert.equal(property.type, ['expectedVersion', 'intervalHours'].includes(name) ? 'integer' : 'string');
  }
  const invalid = await exchange([...handshake(), request('cursor', 'tools/list', { cursor: 'arbitrary' })]);
  assert.equal(resultFor(invalid, 'cursor').error.code, -32602); assert.equal(invalid.forwards.length, 0);
});

test('release tools forward exact stable keys and CAS fields, refusing malformed or owner-selected requests', async () => {
  const id = randomUUID(), create = { requestId: 'release-1', condition: 'Qwen4 is officially released' };
  const edit = { requestId: 'edit-1', id, expectedVersion: 4, operation: 'edit', condition: 'Qwen4 stable release' };
  const pause = { requestId: 'pause-1', id, expectedVersion: 5, operation: 'pause' };
  const result = await exchange([...handshake(), call('create', 'create_release_watch', create),
    call('retry', 'create_release_watch', create), call('edit', 'update_release_watch', edit), call('pause', 'update_release_watch', pause)]);
  assert.deepEqual(result.forwards.map(value => JSON.parse(value.spec.body)), [
    { action: 'createWatch', input: create }, { action: 'createWatch', input: create },
    { action: 'updateWatch', input: edit }, { action: 'updateWatch', input: pause }]);
  assert.equal(result.forwards[0].spec.body, result.forwards[1].spec.body);
  const invalid = await exchange([...handshake(),
    call('owner', 'create_release_watch', { ...create, ownerId: PRIVATE }),
    call('lf', 'create_release_watch', { ...create, requestId: 'key\n' }),
    call('blank', 'create_release_watch', { ...create, condition: ' ' }),
    call('missing', 'update_release_watch', { ...pause, operation: 'edit' }),
    call('extra', 'update_release_watch', { ...pause, condition: 'Not an edit' }),
    call('version', 'update_release_watch', { ...pause, expectedVersion: 0 })]);
  assert.equal(invalid.forwards.length, 0);
  for (const response of invalid.messages.filter(value => value.id !== 'initialize')) assert.equal(response.error.code, -32602);
});

test('create retries preserve the exact idempotency payload and all actions use only the owner-bound broker', async () => {
  const input = createInput(), before = structuredClone(input), id = randomUUID();
  const result = await exchange([...handshake(), call('first', 'create_schedule', input),
    call('retry', 'create_schedule', input), call('list', 'list_schedules'), call('cancel', 'cancel_schedule', { id })]);
  assert.deepEqual(input, before); assert.equal(result.forwards.length, 4);
  const expected = [{ action: 'create', input }, { action: 'create', input }, { action: 'list' }, { action: 'cancel', input: { id } }];
  for (let index = 0; index < expected.length; index++) {
    const { url, spec } = result.forwards[index];
    assert.equal(url, URL); assert.equal(spec.method, 'POST'); assert.equal(spec.redirect, 'error');
    assert.deepEqual(spec.headers, { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + TOKEN });
    assert.ok(spec.signal instanceof AbortSignal); assert.equal(spec.signal.aborted, false);
    assert.equal(spec.body, JSON.stringify(expected[index]));
  }
  assert.equal(result.forwards[0].spec.body, result.forwards[1].spec.body);
  for (const id of ['first', 'retry', 'list', 'cancel']) {
    const response = resultFor(result, id).result;
    assert.equal(response.isError, false); assert.deepEqual(JSON.parse(response.content[0].text), { ok: true, timezone: 'Europe/Paris' });
  }
  assert.ok(!result.raw.includes(TOKEN));
});

test('unknown tools, methods, action fields and owner selectors are refused before HTTP forwarding', async () => {
  const invalid = [
    call('unknown-tool', 'run_command', { command: PRIVATE }),
    call('unknown-action', 'create_watch', createInput()),
    call('owner-create', 'create_schedule', { ...createInput(), ownerId: PRIVATE }),
    call('owner-list', 'list_schedules', { companionId: PRIVATE }),
    call('owner-cancel', 'cancel_schedule', { id: randomUUID(), owner: PRIVATE }),
    request('param-action', 'tools/call', { name: 'list_schedules', arguments: {}, action: 'delete' }),
    request('arbitrary-http', 'http/request', { endpoint: 'https://private.invalid', token: TOKEN }),
    { ...request('outer-owner', 'tools/list'), ownerId: PRIVATE }
  ];
  const result = await exchange([...handshake(), ...invalid]);
  assert.equal(result.forwards.length, 0);
  for (const message of result.messages.filter(message => message.id !== 'initialize')) assert.ok(message.error);
  assert.equal(resultFor(result, 'arbitrary-http').error.code, -32601);
  assert.ok(result.messages.some(message => message.id === null && message.error.code === -32600));
  assert.ok(!result.raw.includes(PRIVATE) && !result.raw.includes(TOKEN));
});

test('malformed schedule values cannot bypass the finite tool interface', async () => {
  const values = [
    call('empty-text', 'create_schedule', { ...createInput(), text: '   ' }),
    call('oversize-text', 'create_schedule', { ...createInput(), text: 'x'.repeat(1001) }),
    call('control-text', 'create_schedule', { ...createInput(), text: 'private\u0000text' }),
    call('lone-surrogate', 'create_schedule', { ...createInput(), text: '\ud800' }),
    call('offset-required', 'create_schedule', { ...createInput(), dueAt: '2026-11-03T09:30:00' }),
    call('bad-date', 'create_schedule', { ...createInput(), dueAt: 'not-a-dateZ' }),
    call('key-required', 'create_schedule', { ...createInput(), requestId: '' }),
    call('key-grammar', 'create_schedule', { ...createInput(), requestId: 'request with spaces' }),
    call('cancel-id', 'cancel_schedule', { id: 'not-a-uuid' }),
    call('missing-field', 'create_schedule', { requestId: 'missing', text: 'Missing time' })
  ];
  const result = await exchange([...handshake(), ...values]);
  for (const value of values) assert.equal(resultFor(result, value.id).error.code, -32602);
  assert.equal(result.forwards.length, 0);
});

test('HTTP failures, malformed responses and exceptions expose one fixed tool error without tokens', async () => {
  const responses = [
    async () => { throw new Error(PRIVATE + TOKEN); },
    async () => new Response(PRIVATE + TOKEN, { status: 403 }),
    async () => new Response(PRIVATE + TOKEN, { status: 500 }),
    async () => new Response('not JSON ' + PRIVATE),
    async () => new Response(Buffer.from([0xff, 0xfe])),
    async () => new Response(JSON.stringify(['not-an-object', PRIVATE])),
    async () => new Response(JSON.stringify({ detail: 'x'.repeat(512 * 1024), token: TOKEN })),
    async () => new Response(null)
  ];
  for (const fetchImpl of responses) {
    const result = await exchange([...handshake(), call('failed', 'list_schedules')], { fetchImpl });
    const value = resultFor(result, 'failed').result;
    assert.deepEqual(value, { content: [{ type: 'text', text: FIXED_TOOL_ERROR }], isError: true });
    assert.ok(!result.raw.includes(PRIVATE) && !result.raw.includes(TOKEN));
  }
});

test('a bounded aggregate reminder list larger than one request frame is returned successfully', async () => {
  const data = { now: '2026-11-02T15:00:00Z', timezone: 'Europe/Paris',
    items: Array.from({ length: 25 }, () => ({ id: randomUUID(), text: '日'.repeat(1000), dueAt: '2026-11-03T09:00:00Z' })) };
  assert.ok(Buffer.byteLength(JSON.stringify(data)) > 65536);
  const result = await exchange([...handshake(), call('large-list', 'list_schedules')], {
    fetchImpl: async () => new Response(JSON.stringify(data))
  });
  assert.equal(resultFor(result, 'large-list').result.isError, false);
  assert.deepEqual(JSON.parse(resultFor(result, 'large-list').result.content[0].text), data);
});

test('JSON syntax, batches, unknown envelope fields and invalid IDs produce fixed protocol errors', async () => {
  const result = await exchange(['{\n', '[]\n',
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: {}, method: 'ping' },
    { jsonrpc: '2.0', id: null, method: 'ping' },
    { ...request(2, 'ping'), credential: TOKEN },
    request('good', 'ping')]);
  assert.equal(result.messages[0].error.code, -32700);
  for (const message of result.messages.slice(1, -1)) assert.equal(message.error.code, -32600);
  assert.deepEqual(resultFor(result, 'good').result, {});
  assert.equal(result.forwards.length, 0); assert.ok(!result.raw.includes(TOKEN));
});

test('oversized records are rejected and parsing resumes after their newline boundary', async () => {
  for (const chunks of [[Buffer.from('x'.repeat(65537) + '\n'), request('ping', 'ping')],
    [Buffer.from('x'.repeat(40000)), Buffer.from('y'.repeat(30000)), Buffer.from('\n'), request('ping', 'ping')]]) {
    const result = await exchange(chunks);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].error.code, -32600); assert.equal(result.messages[0].error.message, 'Request too large.');
    assert.deepEqual(resultFor(result, 'ping').result, {}); assert.equal(result.forwards.length, 0);
  }
});

test('invalid UTF-8 records do not discard adjacent valid frames in the same chunk or following chunk', async () => {
  const first = frame(request('before', 'ping')), last = frame(request('after', 'ping'));
  for (const chunks of [[Buffer.concat([first, Buffer.from([0xff, 0x0a]), last])],
    [first, Buffer.from([0xff, 0x0a]), last]]) {
    const result = await exchange(chunks);
    assert.deepEqual(resultFor(result, 'before').result, {});
    assert.deepEqual(resultFor(result, 'after').result, {});
    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages.find(message => message.id === null).error, { code: -32700, message: 'Invalid UTF-8.' });
    assert.equal(result.forwards.length, 0);
  }
});

test('UTF-8 code points may span chunks, while EOF never accepts an unterminated record', async () => {
  const bytes = frame(call('unicode', 'create_schedule', createInput())), emoji = bytes.indexOf(Buffer.from('🎯'));
  assert.ok(emoji > 0);
  const result = await exchange([...handshake(), bytes.subarray(0, emoji + 1), bytes.subarray(emoji + 1)]);
  assert.equal(resultFor(result, 'unicode').result.isError, false); assert.equal(result.forwards.length, 1);
  assert.equal(JSON.parse(result.forwards[0].spec.body).input.text, createInput().text);
  const incomplete = await exchange([Buffer.from(JSON.stringify(request('partial', 'ping')))]);
  assert.deepEqual(incomplete.messages, [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Incomplete request.' } }]);
  const empty = await exchange([]); assert.equal(empty.raw, ''); assert.equal(empty.forwards.length, 0);
});

test('configuration permits only the loopback broker endpoint and a lowercase 64-hex owner token', async () => {
  const endpoints = ['', PRIVATE, 'https://127.0.0.1:49123/internal/scheduler', 'http://localhost:49123/internal/scheduler',
    'http://0.0.0.0:49123/internal/scheduler', 'http://[::1]:49123/internal/scheduler',
    'http://user:secret@127.0.0.1:49123/internal/scheduler', URL + '?owner=' + PRIVATE,
    URL + '#' + PRIVATE, 'http://127.0.0.1:49123/private'];
  const options = [...endpoints.map(endpoint => ({ endpoint, token: TOKEN })),
    ...['', 'F'.repeat(64), 'a'.repeat(63), 'Bearer ' + TOKEN, PRIVATE].map(token => ({ endpoint: URL, token }))];
  for (const option of options) {
    let calls = 0;
    await assert.rejects(() => exchange([], { ...option, fetchImpl: async () => { calls++; throw new Error(PRIVATE); } }),
      error => error.message === 'Scheduler tools are unavailable.' && !String(error).includes(PRIVATE) && !String(error).includes(TOKEN));
    assert.equal(calls, 0);
  }
});

test('real child stdio uses environment-bound loopback HTTP, emits JSON-RPC only and exits after EOF', { timeout: 10000 }, async t => {
  const requests = [], server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ timezone: 'Europe/Paris', items: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}/internal/scheduler`;
  const child = spawn(process.execPath, [SCRIPT, '--endpoint=' + PRIVATE, '--token=' + PRIVATE], {
    env: { SystemRoot: process.env.SystemRoot, COMPANION_SCHEDULER_URL: endpoint, COMPANION_SCHEDULER_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  const closed = once(child, 'close');
  child.stdin.end(Buffer.concat([...handshake(), request('tools', 'tools/list'),
    call('create', 'create_schedule', createInput()), call('retry', 'create_schedule', createInput())].map(frame)));
  const [code, signal] = await closed;
  assert.equal(code, 0); assert.equal(signal, null); assert.equal(Buffer.concat(stderr).toString(), '');
  const raw = Buffer.concat(stdout).toString('utf8'), messages = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(messages.length, 4); assert.ok(messages.every(message => message.jsonrpc === '2.0' && message.result));
  assert.deepEqual(messages.map(message => message.id), ['initialize', 'tools', 'create', 'retry']);
  for (const message of messages.filter(value => ['create', 'retry'].includes(value.id))) assert.equal(message.result.isError, false);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0], { method: 'POST', url: '/internal/scheduler', authorization: 'Bearer ' + TOKEN,
    body: { action: 'create', input: createInput() } });
  assert.ok(!raw.includes(TOKEN) && !raw.includes(PRIVATE));
});

test('CLI arguments cannot replace invalid environment configuration or expose its details on stdout', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [SCRIPT, '--endpoint=' + URL, '--token=' + TOKEN], {
    env: { SystemRoot: process.env.SystemRoot,
      COMPANION_SCHEDULER_URL: 'http://user:' + TOKEN + '@127.0.0.1:49123/internal/scheduler',
      COMPANION_SCHEDULER_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  const closed = once(child, 'close'); child.stdin.end();
  const [code, signal] = await closed;
  assert.equal(code, 1); assert.equal(signal, null);
  assert.equal(Buffer.concat(stdout).toString(), '');
  assert.equal(Buffer.concat(stderr).toString(), 'Scheduler tools are unavailable.\n');
});

test('tool calls accept the _meta field real clients attach (Claude Code sends a progress token and tool-use id)', async () => {
  const meta = { 'claudecode/toolUseId': 'toolu_synthetic', progressToken: 2 };
  const result = await exchange([...handshake(),
    request('listed', 'tools/list', { _meta: { progressToken: 1 } }),
    request('called', 'tools/call', { name: 'list_schedules', arguments: {}, _meta: meta }),
    request('bad-meta', 'tools/call', { name: 'list_schedules', arguments: {}, _meta: 'nope' })]);
  assert.equal(resultFor(result, 'listed').result.tools.length, 15);
  assert.equal(resultFor(result, 'called').result.isError, false);
  assert.equal(resultFor(result, 'bad-meta').error.code, -32602);
  assert.equal(result.forwards.length, 1);
  assert.deepEqual(JSON.parse(result.forwards[0].spec.body), { action: 'list' });
});

test('topic watch tools forward a recurring watch with its interval and refuse out-of-range or mixed edits', async () => {
  const id = randomUUID(), create = { requestId: 'topic-1', topic: 'NVIDIA stock news', intervalHours: 24 };
  const interval = { requestId: 'every-12', id, expectedVersion: 2, operation: 'edit', intervalHours: 12 };
  const result = await exchange([...handshake(), call('create', 'create_topic_watch', create), call('interval', 'update_release_watch', interval),
    call('too-often', 'create_topic_watch', { ...create, requestId: 'topic-2', intervalHours: 1 }),
    call('no-interval', 'create_topic_watch', { requestId: 'topic-3', topic: 'NVIDIA' }),
    call('empty-edit', 'update_release_watch', { requestId: 'e', id, expectedVersion: 2, operation: 'edit' }),
    call('pause-with-interval', 'update_release_watch', { requestId: 'p', id, expectedVersion: 2, operation: 'pause', intervalHours: 12 })]);
  assert.deepEqual(result.forwards.map(value => JSON.parse(value.spec.body)), [
    { action: 'createWatch', input: { requestId: 'topic-1', condition: 'NVIDIA stock news', mode: 'topic', intervalHours: 24 } },
    { action: 'updateWatch', input: interval }]);
  for (const key of ['too-often', 'no-interval', 'empty-edit', 'pause-with-interval']) assert.ok(resultFor(result, key).error || resultFor(result, key).result.isError, key);
});
