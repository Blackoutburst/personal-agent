import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Connectors, ConnectorError } from '../src/connectors.mjs';
import { Conversations } from '../src/conversations.mjs';
import { narrowToolPolicy } from '../src/tool-policy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const A = randomUUID(), B = randomUUID();

function fixture(t, discord = null) {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-')), store = new BootstrapStore(dir, ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, connectors: new Connectors({ store, discord: () => discord, boardConfigured: id => id === A }) };
}

test('connectors list Discord and the Board with their state, and only the owner\'s own Board switch changes', t => {
  const statuses = { [A]: { linked: true, state: 'online', bot: { name: 'Nova' }, user: { name: 'blackout' } }, [B]: { linked: false } };
  const { connectors } = fixture(t, { status: id => statuses[id] });
  const a = connectors.list(A).connectors;
  assert.deepEqual(a.map(item => [item.id, item.state]), [['discord', 'connected'], ['board', 'connected']]);
  assert.match(a[0].detail, /DM with blackout through Nova/); assert.ok(a.every(item => item.purpose));
  assert.deepEqual(connectors.list(B).connectors.map(item => [item.id, item.state, item.actions]), [['discord', 'not_connected', ['connect']], ['board', 'unavailable', []]]);
  assert.equal(connectors.toolFilter(A), null, 'Nothing is removed while every connector is on');

  assert.equal(connectors.set(A, 'board', false).connectors[1].state, 'paused');
  assert.equal(connectors.boardOn(A), false);
  const keep = connectors.toolFilter(A);
  assert.equal(keep('mcp__board__create_ticket'), false); assert.equal(keep('mcp__files__send_file'), true); assert.equal(keep('WebSearch'), true);
  assert.throws(() => connectors.set(B, 'board', false), error => error instanceof ConnectorError && error.code === 'CONNECTOR_UNAVAILABLE');
  for (const bad of [['discord', false], ['board', 'no'], ['github', true]]) assert.throws(() => connectors.set(A, ...bad), ConnectorError);
  assert.equal(connectors.set(A, 'board', true).connectors[1].state, 'connected'); assert.equal(connectors.toolFilter(A), null);
});

test('a switched-off Board drops Board tools from owner turns and wakes, alongside the other filters', async t => {
  const { store, connectors } = fixture(t); const calls = [];
  const conv = new Conversations({ store, flushMs: 1, systemPrompt: () => 'persona', toolFilterFor: id => connectors.toolFilter(id),
    runner: { turn: async (_id, turn) => {
      const policy = narrowToolPolicy({ tools: ['WebSearch', 'WebFetch', 'Read'], board: { configDir: '/synthetic/board',
        pythonPath: '/synthetic/python3', connectPath: '/synthetic/connect.py', allowedTools: ['create_ticket', 'get_work'] } }, undefined, [], turn.toolFilter);
      calls.push([...policy.tools, ...policy.mcpServers.flatMap(server => server.allowedTools.map(name => `mcp__${server.name}__${name}`))]);
      return { text: JSON.stringify({ action: 'message', text: 'ok' }), sessionId: 's' };
    } } });
  t.after(() => conv.shutdown());
  const thread = conv.ongoingThread(A);
  await conv.handle(A, { action: 'submit', requestId: 'one', threadId: thread, text: 'hi' }); await conv.idle();
  assert.ok(calls[0].includes('mcp__board__create_ticket'));
  connectors.set(A, 'board', false);
  await conv.handle(A, { action: 'submit', requestId: 'two', threadId: thread, text: 'hi again' }); await conv.idle();
  assert.deepEqual(calls[1], ['WebSearch', 'WebFetch', 'Read']);
  conv.enqueueProactive(A, { id: randomUUID(), kind: 'board', prompt: 'A Board event' }); await conv.idle();
  assert.deepEqual(calls[2], ['Read'], 'Wakes lose web tools (wake filter) and Board tools (switched off)');
});
