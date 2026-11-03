import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { BootstrapStore } from '../src/store.mjs';
import { BoardCompanion, boardPresentation, needsYouPrompt, mentionPrompt } from '../src/board-companion.mjs';
import { runFileMcp } from '../src/file-mcp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ID = '6f1c1b2e-1d2a-4c3b-9a8b-7c6d5e4f3a2b';
const board = { configDir: '/tmp/board', pythonPath: '/usr/bin/python3', connectPath: '/tmp/connect.py', allowedTools: [] };
const owner = { label: 'blackout', name: 'Blackout', board };

function fakeClient(requests, inbox) {
  const calls = []; let issued = 0;
  return { calls, close() {}, async call(name, args) {
    calls.push([name, args]);
    if (name === 'read_inbox') {
      if (args.cursor === 'revoked') throw Object.assign(new Error('Cursor was not issued for this session'), { code: 'BOARD_ERROR' });
      return { session: { owner_id: 'blackoutburst', agent_id: 'me' }, messages: inbox(args), cursor: 'c' + ++issued };
    }
    if (name === 'list_human_requests') return { items: requests() };
    if (name === 'update_companion_profile') return { id: 'p1', ...args };
    if (name === 'upload_attachment') return { id: 'att1', filename: args.filename, size: Buffer.from(args.content_base64, 'base64').length };
    throw new Error('unexpected ' + name);
  } };
}

function fixture(t, { requests = () => [], inbox = () => [], profile = { name: 'Claude', character: 'claude' }, owners = [owner] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-companion-')), store = new BootstrapStore(dir, ROOT);
  const events = [], client = fakeClient(requests, inbox);
  const companion = new BoardCompanion({ store, owners, profiles: { get: id => id === ID ? profile : null },
    scheduler: { enqueueEvent: (id, input) => events.push([id, input]) }, companionIdFor: () => ID, clientFor: () => client });
  t.after(() => { companion.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { companion, events, client, profile, store };
}

const ping = (id, thread = 'th1', agent = 'codex') => ({ id, thread_id: thread, author: { agent_id: agent }, mentions: ['agent:me'] });

test('mentions and replies wake the companion once per thread; older ones and its own are skipped', async t => {
  let pending = [ping('old1')];
  const { companion, events, client } = fixture(t, { inbox: () => { const page = pending; pending = []; return page; } });
  await companion.tick();
  assert.equal(events.length, 0, 'Mentions from before the first check are a baseline, not wakes');
  pending = [ping('m1'), ping('m2'), ping('m3', 'th2'), ping('mine', 'th3', 'me'), ping('old1')];
  await companion.tick();
  assert.equal(events.length, 2);
  const [first, second] = events.map(([, wake]) => wake);
  assert.equal(first.kind, 'board');
  assert.match(first.requestId, /^board-mention-[a-f0-9]{32}$/);
  assert.match(first.prompt, /messages m1, m2 in Board thread th1/);
  assert.match(second.prompt, /message m3 in Board thread th2/);
  const reads = client.calls.filter(([name]) => name === 'read_inbox').map(([, args]) => args.cursor);
  assert.deepEqual(reads, [undefined, 'c1'], 'Each check resumes from the cursor the last one received');
  pending = [ping('m1')];
  await companion.tick();
  assert.equal(events.length, 2, 'A replayed mention never wakes twice');
});

test('a cursor the Board refuses is dropped and the next check reads without one', async t => {
  const { companion, client, store } = fixture(t);
  await companion.tick();
  store.db.prepare("UPDATE board_inbox_state SET cursor='revoked'").run();
  await companion.tick();
  assert.equal(store.db.prepare('SELECT cursor FROM board_inbox_state').get().cursor, null);
  await companion.tick();
  const reads = client.calls.filter(([name]) => name === 'read_inbox').map(([, args]) => args.cursor);
  assert.deepEqual(reads, [undefined, 'revoked', undefined]);
});

test('mention prompts carry ids only and keep the owner in charge of decisions', () => {
  const prompt = mentionPrompt('th1', ['m1']);
  assert.match(prompt, /message m1 in Board thread th1/);
  assert.match(prompt, /untrusted context/);
  assert.match(prompt, /post_message/);
  assert.match(prompt, /Never approve deployments/);
});

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
