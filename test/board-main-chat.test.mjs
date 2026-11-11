// #75 criterion 4: with the Board tab gone, the companion's owner-facing Board wakes (Needs-you, mentions, owner pings,
// batched requests from #74) are delivered in the owner's main chat, wired the way server.mjs wires it (no BoardInbox).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { Conversations } from '../src/conversations.mjs';
import { SchedulerStore, SchedulerService } from '../src/scheduler.mjs';
import { BoardCompanion } from '../src/board-companion.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const owner = { label: 'blackout', name: 'Blackout', board: { configDir: '/tmp/board', pythonPath: '/usr/bin/python3', connectPath: '/tmp/connect.py', allowedTools: [] } };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-main-')), store = new BootstrapStore(dir, ROOT);
  const f = { clock: Date.UTC(2026, 10, 11, 12), prompts: [], inbox: [], requests: [] };
  f.now = () => f.clock;
  f.A = store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'board-main' }), { companionId: randomUUID() }).companionId;
  const client = { close() {}, async call(name) {
    if (name === 'read_inbox') { const page = f.inbox; f.inbox = []; return { session: { owner_id: 'blackoutburst', agent_id: 'me' }, messages: page, cursor: 'c' + Math.random() }; }
    if (name === 'list_human_requests') return f.requests;
    if (name === 'update_companion_profile') return {};
    throw Object.assign(new Error('unavailable'), { code: 'BOARD_ERROR' });
  } };
  const scheduler = new SchedulerStore({ store, now: f.now, minSpacingMs: 0, boardSpacingMs: 0, proactiveByDefault: false });
  f.conv = new Conversations({ store, now: f.now, flushMs: 1, systemPrompt: () => 'persona',
    runner: { turn: async (companionId, turn) => { f.prompts.push(turn.prompt); return { text: JSON.stringify({ action: 'message', text: 'Board news for you.' }), sessionId: 'native' }; } },
    wakePolicy: { beforeStart: (companionId, id) => scheduler.startInTransaction(companionId, id), canDeliver: (companionId, id) => scheduler.canDeliver(companionId, id) } });
  f.service = new SchedulerService({ scheduler, conversations: f.conv, companions: () => [f.A], ready: () => true, pollMs: 60000 });
  f.companion = new BoardCompanion({ store, owners: [owner], profiles: { get: id => id === f.A ? { name: 'Claude', character: 'claude' } : null },
    scheduler: f.service, companionIdFor: () => f.A, clientFor: () => client });
  f.drain = async () => { for (let i = 0; i < 4; i++) { await f.service.tick(); await f.conv.idle(); f.clock += 1000; } };
  f.main = async () => (await f.conv.handle(f.A, { action: 'snapshot' })).messages;
  t.after(async () => { f.companion.stop(); await f.service.stop(); await f.conv.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const open = (id, extra = {}) => ({ id, status: 'open', owner_id: 'blackoutburst', ticket_id: 'tk' + id, number: 10, title: 'T', ...extra });

test('a Needs-you request, a mention and an owner ping each reach the main chat', async t => {
  const f = fixture(t);
  await f.companion.tick(); // baseline
  f.inbox = [{ id: 'm1', thread_id: 'th1', author: { agent_id: 'codex' }, mentions: ['agent:me'] },
    { id: 'o1', thread_id: 'th2', author: { agent_id: 'codex' }, mentions: ['blackoutburst'] }];
  f.requests = [open('r1', { question: 'Which colour?' })];
  await f.companion.tick();
  await f.drain();
  assert.equal(f.prompts.length, 3, 'one wake each');
  assert.match(f.prompts.join('\n'), /Needs you/);
  assert.match(f.prompts.join('\n'), /mentioned on the Board/);
  assert.match(f.prompts.join('\n'), /pinged your owner/);
  const messages = await f.main();
  assert.equal(messages.filter(message => message.role === 'assistant' && message.text === 'Board news for you.').length, 3, 'all three are in the main chat');
});

test('several Needs-you requests are ONE batched wake and one message in the main chat (#74)', async t => {
  const f = fixture(t);
  f.requests = [open('r1', { question: 'Deploy now?' }), open('r2', { question: 'Colour?' }), open('r3', { question: 'Name?' })];
  await f.companion.tick();
  await f.drain();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /3 Board "Needs you" requests/);
  assert.match(f.prompts[0], /HARD LIMIT: deployment/);
  assert.equal((await f.main()).filter(message => message.role === 'assistant').length, 1, 'one message to the owner');
});

test('server.mjs wires no Board inbox, so nothing is routed to a Board sub-conversation', () => {
  const source = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  assert.doesNotMatch(source, /new BoardInbox\(/);
  assert.doesNotMatch(source, /boardInbox/);
});
