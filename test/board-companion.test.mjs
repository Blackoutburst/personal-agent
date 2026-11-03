import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { BootstrapStore } from '../src/store.mjs';
import { BoardCompanion, boardPresentation, needsYouPrompt } from '../src/board-companion.mjs';
import { runFileMcp } from '../src/file-mcp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ID = '6f1c1b2e-1d2a-4c3b-9a8b-7c6d5e4f3a2b';
const board = { configDir: '/tmp/board', pythonPath: '/usr/bin/python3', connectPath: '/tmp/connect.py', allowedTools: [] };
const owner = { label: 'blackout', name: 'Blackout', board };

function fakeClient(requests) {
  const calls = [];
  return { calls, close() {}, async call(name, args) {
    calls.push([name, args]);
    if (name === 'read_inbox') return { session: { owner_id: 'blackoutburst' } };
    if (name === 'list_human_requests') return { items: requests() };
    if (name === 'update_companion_profile') return { id: 'p1', ...args };
    if (name === 'upload_attachment') return { id: 'att1', filename: args.filename, size: Buffer.from(args.content_base64, 'base64').length };
    throw new Error('unexpected ' + name);
  } };
}

function fixture(t, { requests = () => [], profile = { name: 'Claude', character: 'claude' }, owners = [owner] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-companion-')), store = new BootstrapStore(dir, ROOT);
  const events = [], client = fakeClient(requests);
  const companion = new BoardCompanion({ store, owners, profiles: { get: id => id === ID ? profile : null },
    scheduler: { enqueueEvent: (id, input) => events.push([id, input]) }, companionIdFor: () => ID, clientFor: () => client });
  t.after(() => { companion.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { companion, events, client, profile };
}

const open = (id, extra = {}) => ({ id, ticket_id: 't' + id, owner_id: 'blackoutburst', status: 'open', question: 'Deploy now?', ...extra });

test('each new open request for the owner becomes exactly one private board wake', async t => {
  let list = [open('r1'), open('r2', { owner_id: 'thescreamer' }), open('r3', { status: 'resolved' })];
  const { companion, events } = fixture(t, { requests: () => list });
  await companion.tick();
  assert.equal(events.length, 1);
  const [companionId, wake] = events[0];
  assert.equal(companionId, ID);
  assert.equal(wake.kind, 'board');
  assert.match(wake.requestId, /^board-needs-you-[a-f0-9]{32}$/);
  assert.match(wake.prompt, /request r1 on ticket tr1/);
  assert.doesNotMatch(wake.prompt, /Deploy now\?/, 'Board text is read with tools, never pasted into the prompt');
  await companion.tick();
  assert.equal(events.length, 1, 'A request is announced once');
  list = [...list, open('r4')];
  await companion.tick();
  assert.equal(events.length, 2);
});

test('two configured owners keep Needs-you wakes, public profile updates and requested attachments on their own bridge', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-companion-two-owner-')), store = new BootstrapStore(dir, ROOT), events = [];
  const entries = [
    { label: 'alice', id: '9d23bd88-cc69-4067-b375-e32bf5d7b338', boardOwner: 'board-alice', name: 'Aria', character: 'claude' },
    { label: 'bob', id: '4d317b44-1f1a-46f1-b515-822d93c8246c', boardOwner: 'board-bob', name: 'Bram', character: 'pip' }
  ];
  const requests = entries.map(entry => open('request-' + entry.label, { owner_id: entry.boardOwner,
    ticket_id: 'ticket-' + entry.label, question: 'UNSHARED_QUESTION_' + entry.label }));
  const clients = new Map(), profiles = new Map(), ids = new Map();
  const owners = entries.map(entry => {
    const selected = { ...board, configDir: '/tmp/board-' + entry.label }, calls = [];
    clients.set(selected, { calls, close() {}, async call(name, args) {
      calls.push([name, args]);
      if (name === 'read_inbox') return { session: { owner_id: entry.boardOwner } };
      if (name === 'list_human_requests') return { items: requests };
      if (name === 'update_companion_profile') return { id: 'profile-' + entry.label, ...args };
      if (name === 'upload_attachment') return { id: 'attachment-' + entry.label };
      assert.fail('Unexpected synthetic Board call: ' + name);
    } });
    profiles.set(entry.id, { name: entry.name, character: entry.character }); ids.set(entry.label, entry.id);
    return { label: entry.label, name: entry.label, board: selected };
  });
  const companion = new BoardCompanion({ store, owners, profiles: { get: id => profiles.get(id) },
    scheduler: { enqueueEvent: (id, input) => events.push([id, input]) }, companionIdFor: owner => ids.get(owner.label),
    clientFor: configured => { assert.ok(clients.has(configured)); return clients.get(configured); } });
  t.after(() => { companion.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await companion.tick(); await companion.tick();
  assert.equal(events.length, 2, 'Both request lists contain both owners, but each request queues only for its own companion once');
  for (const [index, entry] of entries.entries()) {
    const foreign = entries[1 - index], own = events.filter(([id]) => id === entry.id);
    assert.equal(own.length, 1); assert.equal(own[0][1].kind, 'board');
    assert.ok(own[0][1].prompt.includes('request request-' + entry.label));
    assert.ok(!own[0][1].prompt.includes('request-' + foreign.label));
    assert.ok(!JSON.stringify(own).includes('UNSHARED_QUESTION_'));
    const client = clients.get(owners[index].board), updates = client.calls.filter(([name]) => name === 'update_companion_profile');
    assert.deepEqual(updates, [['update_companion_profile', { name: entry.name, avatar: entry.character === 'claude' ? '✳️' : '💬',
      description: `${entry.name}, ${entry.label}'s personal companion. Acts on the Board for ${entry.label}.` }]]);
    const bytes = Buffer.from('Explicitly requested attachment for ' + entry.label);
    const result = await companion.attach(entry.id, { threadId: 'thread-' + entry.label, filename: entry.label + '.txt', contentType: 'text/plain', bytes });
    assert.equal(result.id, 'attachment-' + entry.label);
    const uploads = client.calls.filter(([name]) => name === 'upload_attachment'); assert.equal(uploads.length, 1);
    const args = uploads[0][1]; assert.deepEqual(Object.keys(args).sort(), ['content_base64', 'content_type', 'filename', 'idempotency_key', 'thread_id']);
    assert.equal(args.thread_id, 'thread-' + entry.label); assert.equal(args.filename, entry.label + '.txt'); assert.equal(args.content_type, 'text/plain');
    assert.deepEqual(Buffer.from(args.content_base64, 'base64'), bytes);
    assert.ok(!JSON.stringify(updates).includes(foreign.name));
  }
  for (const [index, selected] of owners.entries()) {
    const uploads = clients.get(selected.board).calls.filter(([name]) => name === 'upload_attachment');
    assert.equal(uploads.length, 1); assert.equal(uploads[0][1].thread_id, 'thread-' + entries[index].label);
  }
});

test('the Board profile follows the companion look and skips unchanged values', async t => {
  const { companion, client, profile } = fixture(t);
  await companion.tick();
  const updates = () => client.calls.filter(([name]) => name === 'update_companion_profile');
  assert.equal(updates().length, 1);
  assert.deepEqual(updates()[0][1], { name: 'Claude', avatar: '✳️', description: "Claude, Blackout's personal companion. Acts on the Board for Blackout." });
  await companion.syncProfile(ID);
  assert.equal(updates().length, 1);
  profile.name = 'Clau';
  await companion.syncProfile(ID);
  assert.equal(updates().length, 2);
  assert.equal(updates()[1][1].name, 'Clau');
});

test('owners without a Board are ignored and attach refuses them', async t => {
  const { companion, client } = fixture(t, { owners: [{ label: 'screamer', name: 'S' }] });
  assert.equal(companion.enabled, false);
  assert.equal(companion.configuredFor(ID), false);
  await companion.tick();
  assert.equal(client.calls.length, 0);
  await assert.rejects(companion.attach(ID, { threadId: 'th', filename: 'a.png', contentType: 'image/png', bytes: Buffer.from('x') }), { code: 'BOARD_UNCONFIGURED' });
});

test('attachments upload through the owner bridge with a stable retry key', async t => {
  const { companion, client } = fixture(t);
  const input = { threadId: 'th1', filename: 'shot.png', contentType: 'image/png', bytes: Buffer.from('png-bytes') };
  const result = await companion.attach(ID, input);
  assert.equal(result.id, 'att1');
  await companion.attach(ID, input);
  const uploads = client.calls.filter(([name]) => name === 'upload_attachment').map(([, args]) => args);
  assert.equal(uploads[0].idempotency_key, uploads[1].idempotency_key);
  assert.equal(Buffer.from(uploads[0].content_base64, 'base64').toString(), 'png-bytes');
  assert.equal(uploads[0].thread_id, 'th1');
});

test('presentation and prompt helpers keep Board text bounded', () => {
  assert.equal(boardPresentation({ name: 'x'.repeat(100), character: 'other' }, { label: 'a' }).name.length, 60);
  assert.equal(boardPresentation({ name: '', character: 'other' }, null).avatar, '💬');
  assert.match(needsYouPrompt({ id: 'r9', ticket_number: 12 }), /request r9 on #12/);
});

async function mcp(board, messages, fetchImpl = async () => Response.json({ attachment: { id: 'att1' } })) {
  const input = new PassThrough(), output = new PassThrough(), lines = [];
  output.on('data', chunk => lines.push(...chunk.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))));
  const done = runFileMcp({ input, output, endpoint: 'http://127.0.0.1:9/internal/files', token: 'a'.repeat(64), fetchImpl, board });
  for (const message of [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }, ...messages]) input.write(JSON.stringify(message) + '\n');
  input.end(); await done;
  return lines;
}

test('attach_to_board is listed only for Board owners and sends only path and thread', async () => {
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const without = await mcp(false, [list]);
  assert.deepEqual(without[1].result.tools.map(tool => tool.name), ['send_file']);
  const sent = [];
  const withBoard = await mcp(true, [list, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'attach_to_board', arguments: { path: 'inbox/shot.png', threadId: 'abc123' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'attach_to_board', arguments: { path: 'inbox/shot.png', threadId: '../x' } } }],
    async (url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ attachment: { id: 'att1' } }); });
  assert.deepEqual(withBoard[1].result.tools.map(tool => tool.name), ['send_file', 'attach_to_board']);
  assert.deepEqual(sent, [{ action: 'board', path: 'inbox/shot.png', threadId: 'abc123' }]);
  assert.match(withBoard[2].result.content[0].text, /att1/);
  assert.equal(withBoard[3].error.code, -32602);
  const refused = await mcp(false, [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'attach_to_board', arguments: { path: 'a', threadId: 'b' } } }]);
  assert.equal(refused[1].error.code, -32602);
});

test('the Board client unwraps FastMCP list results and passes objects through', async () => {
  const { BoardClient } = await import('../src/board-client.mjs');
  const { EventEmitter } = await import('node:events');
  const replies = { list_human_requests: { structuredContent: { result: [{ id: 'r1' }] } }, read_inbox: { structuredContent: { session: { owner_id: 'o' } } } };
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', chunk => { for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const message = JSON.parse(line); if (message.id === undefined) continue;
      const result = message.method === 'tools/call' ? replies[message.params.name] ?? { structuredContent: {} } : {};
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    } });
    return child;
  };
  const client = new BoardClient({ board, spawnImpl });
  try {
    assert.deepEqual(await client.call('list_human_requests', { view: 'full' }), [{ id: 'r1' }]);
    assert.deepEqual(await client.call('read_inbox', {}), { session: { owner_id: 'o' } });
  } finally { client.close(); }
});
