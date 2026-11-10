import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindBoardSession, bindBoardRequest, hideBoardSessionSchema } from '../src/board-session-bridge.mjs';

const bridge = fileURLToPath(new URL('../src/board-session-bridge.mjs', import.meta.url));
const session = 'companion-model-' + 'a'.repeat(40);
const policy = { tools: [], board: { allowedTools: ['get_work'] }, mcpServers: [
  { name: 'board', command: '/usr/bin/python3', args: ['/private/connect.py', '--stdio'], env: {}, allowedTools: ['get_work'] },
  { name: 'scheduler', command: '/usr/bin/node', args: ['scheduler.mjs'], env: { TOKEN: 'fixture' }, allowedTools: ['list_schedules'] }
] };

test('trusted session is stable across resumed operations and distinct per owner/conversation', () => {
  const first = bindBoardSession(policy, 'alice', 'conversation-1');
  assert.equal(first.mcpServers[0].args[2], bindBoardSession(policy, 'alice', 'conversation-1').mcpServers[0].args[2]);
  assert.notEqual(first.mcpServers[0].args[2], bindBoardSession(policy, 'alice', 'conversation-2').mcpServers[0].args[2]);
  assert.notEqual(first.mcpServers[0].args[2], bindBoardSession(policy, 'bob', 'conversation-1').mcpServers[0].args[2]);
  assert.equal(first.mcpServers[1], policy.mcpServers[1]);
  assert.equal(first.mcpServers[0].allowedTools, policy.mcpServers[0].allowedTools);
  assert.equal(first.mcpServers[0].env, policy.mcpServers[0].env);
  assert.equal(policy.mcpServers[0].command, '/usr/bin/python3');
  assert.deepEqual(first.mcpServers[0].args.slice(4), ['/usr/bin/python3', '/private/connect.py', '--stdio']);
  assert.notEqual(bindBoardSession(policy, 'alice').mcpServers[0].args[2], bindBoardSession(policy, 'alice').mcpServers[0].args[2]);
});

for (const value of [undefined, '', ' ', 'another-owner-session', 'companion-app-68885fec0c7db0ea']) {
  test('model session argument is never authoritative: ' + String(value), () => {
    const args = { limit: 2, ...(value === undefined ? {} : { session_id: value }) };
    const request = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_work', arguments: args } };
    const bound = bindBoardRequest(request, session);
    assert.equal(bound.params.arguments.session_id, session);
    assert.equal(bound.params.arguments.limit, 2);
    assert.equal(request.params.arguments, args);
    assert.equal(bound.id, 9);
  });
}

test('missing argument object is supplied, malformed argument shapes are refused', () => {
  assert.deepEqual(bindBoardRequest({ method: 'tools/call', params: { name: 'get_work' } }, session).params.arguments, { session_id: session });
  for (const value of [null, [], 'bad', 5]) assert.throws(() => bindBoardRequest({ method: 'tools/call', params: { arguments: value } }, session));
  for (const key of ['', 'foreign', '../escape']) assert.throws(() => bindBoardRequest({}, key));
  assert.equal(bindBoardSession({ tools: [], mcpServers: [] }, 'alice', null).mcpServers.length, 0);
  for (const key of ['', 'x'.repeat(161), 'line\nline', null]) assert.throws(() => bindBoardSession(policy, 'alice', key));
});

test('model schema removes only app-owned session property and requirement', () => {
  const response = { id: 'schema', result: { nextCursor: 'cursor', tools: [{ name: 'get_work', inputSchema: {
    type: 'object', properties: { session_id: { type: 'string' }, limit: { type: 'integer' } }, required: ['session_id', 'limit'], additionalProperties: false
  } }] } };
  const hidden = hideBoardSessionSchema(response);
  assert.deepEqual(hidden.result.tools[0].inputSchema.properties, { limit: { type: 'integer' } });
  assert.deepEqual(hidden.result.tools[0].inputSchema.required, ['limit']);
  assert.equal(hidden.result.tools[0].inputSchema.additionalProperties, false);
  assert.equal(hidden.result.nextCursor, 'cursor');
  assert.equal(response.result.tools[0].inputSchema.required[0], 'session_id');
  assert.deepEqual(hideBoardSessionSchema({ id: 4, error: { code: -1, message: 'fixture' } }), { id: 4, error: { code: -1, message: 'fixture' } });
});

function launch(t, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'pa-board-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake.mjs');
  writeFileSync(fake, `import readline from 'node:readline';
${extra}
const input = readline.createInterface({input:process.stdin});
input.on('line', line => { const request=JSON.parse(line);
 if(request.method==='tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'get_work',inputSchema:{type:'object',properties:{session_id:{type:'string'}},required:['session_id']}}]}})+'\\n');
 else if(request.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request})+'\\n');
});`);
  const child = spawn(process.execPath, [bridge, '--session-id', session, '--', process.execPath, fake], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  t.after(() => child.kill('SIGKILL'));
  return { child, closed };
}

test('real stdio proxy preserves framing, UTF8, IDs and normal responses while binding empty/missing/foreign sessions', async t => {
  const { child, closed } = launch(t);
  const requests = [
    { jsonrpc: '2.0', id: 'schema', method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_work', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_work', arguments: { session_id: '', note: 'é❄️' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_work', arguments: { session_id: 'foreign' } } }
  ];
  const bytes = Buffer.from(requests.map(JSON.stringify).join('\n') + '\n');
  for (let i = 0; i < bytes.length; i += 7) child.stdin.write(bytes.subarray(i, i + 7));
  child.stdin.end();
  const output = await closed;
  assert.equal(output.code, 0, output.stderr);
  const replies = output.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies.map(value => value.id), ['schema', 1, 2, 3]);
  assert.deepEqual(replies[0].result.tools[0].inputSchema.required, []);
  assert.equal('session_id' in replies[0].result.tools[0].inputSchema.properties, false);
  for (const reply of replies.slice(1)) assert.equal(reply.result.params.arguments.session_id, session);
  assert.equal(replies[2].result.params.arguments.note, 'é❄️');
});

test('invalid model arguments return matching JSONRPC error and do not reach child; later valid request still works', async t => {
  const { child, closed } = launch(t);
  child.stdin.end(JSON.stringify({ id: 1, method: 'tools/call', params: { arguments: [] } }) + '\n' + JSON.stringify({ id: 2, method: 'tools/call', params: {} }) + '\n');
  const output = await closed;
  assert.equal(output.code, 0);
  const replies = output.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].id, 1); assert.equal(replies[0].error.code, -32602);
  assert.equal(replies[1].id, 2); assert.equal(replies[1].result.params.arguments.session_id, session);
});

test('stdin EOF bounds lifetime even if downstream ignores termination', { timeout: 8000 }, async t => {
  const { child, closed } = launch(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  child.stdin.end();
  const output = await closed;
  assert.equal(output.code, 2);
});

test('SIGTERM bounds lifetime of a downstream ignoring SIGTERM', { timeout: 8000 }, async t => {
  const { child, closed } = launch(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  child.stdin.write(JSON.stringify({ id: 1, method: 'initialize' }) + '\n');
  await new Promise(resolve => child.stdout.once('data', resolve));
  child.kill('SIGTERM');
  const output = await closed;
  assert.equal(output.code, 2);
});
